import asyncio
import os
import re
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Dict, List, Optional, TypeVar, Union

from loguru import logger
from surrealdb import AsyncSurreal, RecordID  # type: ignore
from surrealdb.data.types.table import Table  # type: ignore

from open_notebook.utils.proxy import ensure_internal_no_proxy

# Keep the internal SurrealDB websocket out of any configured HTTP proxy
# (issue #1160). Runs at import time - i.e. before any db_connection() can be
# opened - so it protects every entrypoint (API + worker) that touches the DB.
ensure_internal_no_proxy()

T = TypeVar("T", Dict[str, Any], List[Dict[str, Any]])

# Wall-clock budget for the internal RDLens source-readback GET: signin +
# use + all queries of one db_connection() call. Cleanup (close) runs after
# the budget context exits; it may extend total wall time, so callers keep
# their own HTTP timeout on top of this.
INTERNAL_GET_OPERATION_BUDGET_SECONDS = 5.0

# Bare SurrealDB table/relation identifier: no ':', whitespace, or query
# syntax. Used to validate the parts of RELATE/UPSERT/UPDATE that name a
# table or edge-relation and therefore can't be bound as a query parameter
# (SurrealQL only allows binding record/table *values*, not identifiers in
# that position).
_IDENTIFIER_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")


def _ensure_safe_identifier(value: str, kind: str) -> str:
    """Validate a table/relationship name before it is interpolated into a query."""
    if not isinstance(value, str) or not _IDENTIFIER_RE.match(value):
        raise ValueError(f"Invalid {kind} name: {value!r}")
    return value


def _get_env_or_default(name: str, default: str) -> str:
    value = os.getenv(name)
    return value if value else default


def get_database_url() -> str:
    """Get database URL with backward compatibility"""
    surreal_url = os.getenv("SURREAL_URL")
    if surreal_url:
        return surreal_url

    # Fallback to old format - WebSocket URL format
    address = os.getenv("SURREAL_ADDRESS", "localhost")
    port = os.getenv("SURREAL_PORT", "8000")
    return f"ws://{address}/rpc:{port}"


def get_database_password() -> str:
    """Get password with backward compatibility"""
    return os.getenv("SURREAL_PASSWORD") or os.getenv("SURREAL_PASS") or "root"


def get_database_namespace() -> str:
    """Get configured SurrealDB namespace."""
    return _get_env_or_default("SURREAL_NAMESPACE", "open_notebook")


def get_database_name() -> str:
    """Get configured SurrealDB database name."""
    return _get_env_or_default("SURREAL_DATABASE", "open_notebook")


def parse_record_ids(obj: Any) -> Any:
    """Recursively parse and convert RecordIDs into strings."""
    if isinstance(obj, dict):
        return {k: parse_record_ids(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [parse_record_ids(item) for item in obj]
    elif isinstance(obj, RecordID):
        return str(obj)
    return obj


def ensure_record_id(value: Union[str, RecordID]) -> RecordID:
    """Ensure a value is a RecordID."""
    if isinstance(value, RecordID):
        return value
    return RecordID.parse(value)


def _external_cancel_pending() -> bool:
    """Whether the running task has been asked to cancel from outside.

    The SDK's close() awaits its receive task and can absorb a cancellation
    delivered while the caller was inside the connection (a control probe
    showed query() completing normally with a pending cancel). Comparing
    task.cancel() counts before/after lets us re-raise externally-delivered
    cancels instead of reporting success, while a close() that finishes
    cleanly on its own is not misread as a cancellation.
    """
    task = asyncio.current_task()
    if task is None:
        return False
    return task.cancelling() > 0 and task.uncancel() == 0


async def _close_connection(
    db: Any, prior_error: Optional[BaseException]
) -> None:
    """Close the SDK connection without masking an operation error.

    Uses only the SDK's public close(). Normal cleanup failures are logged
    and dropped so they never overwrite an exception raised by the caller's
    queries; if the current task picked up a NEW external cancellation while
    closing (the SDK swallowing it), that cancellation is re-raised.
    """
    try:
        await db.close()
    except asyncio.CancelledError:
        raise
    except Exception as e:
        if prior_error is not None:
            logger.debug(
                f"Ignoring connection close error after operation error: {e}"
            )
        else:
            logger.warning(f"Connection close failed: {e}")
    if _external_cancel_pending():
        raise asyncio.CancelledError()


@asynccontextmanager
async def db_connection(
    operation_budget_seconds: Optional[float] = None,
) -> AsyncIterator[Any]:
    """Yield one connected AsyncSurreal client.

    signin, use, and the caller's queries all run inside try/finally so the
    connection is closed on every exit path. Pass operation_budget_seconds
    to bound signin + use + queries with an overall asyncio.timeout (cleanup
    runs after the budget expires); the default None keeps the historical
    unbounded behavior for every existing caller.
    """
    db = AsyncSurreal(get_database_url())
    signin_error: Optional[BaseException] = None
    try:
        if operation_budget_seconds is not None:
            async with asyncio.timeout(operation_budget_seconds):
                await db.signin(
                    {
                        "username": os.environ.get("SURREAL_USER"),
                        "password": get_database_password(),
                    }
                )
                await db.use(get_database_namespace(), get_database_name())
                signin_error = None
                yield db
        else:
            await db.signin(
                {
                    "username": os.environ.get("SURREAL_USER"),
                    "password": get_database_password(),
                }
            )
            await db.use(get_database_namespace(), get_database_name())
            yield db
    except BaseException as e:
        # Budget timeouts re-raise as TimeoutError; DB errors, caller
        # exceptions, and cancellations all propagate unchanged. Only the
        # cleanup below is exception-safe.
        signin_error = e
        raise
    finally:
        # Outside any budget context: cleanup is never cut short by the
        # operation timeout itself.
        await _close_connection(db, signin_error)


async def repo_query(
    query_str: str,
    vars: Optional[Dict[str, Any]] = None,
    connection: Optional[Any] = None,
) -> List[Dict[str, Any]]:
    """Execute a SurrealQL query and return the results.

    Pass connection (an AsyncSurreal yielded by db_connection) to run on an
    existing connection instead of opening a fresh one - used when several
    statements must execute against one consistent session.
    """

    async def _run(conn: Any) -> List[Dict[str, Any]]:
        try:
            result = parse_record_ids(await conn.query(query_str, vars))
            if isinstance(result, str):
                raise RuntimeError(result)
            return result
        except RuntimeError as e:
            # RuntimeError is raised for retriable transaction conflicts - log at debug to avoid noise
            logger.debug(str(e))
            raise
        except Exception as e:
            logger.exception(e)
            raise

    if connection is not None:
        return await _run(connection)
    async with db_connection() as conn:
        return await _run(conn)


async def repo_create(table: str, data: Dict[str, Any]) -> Dict[str, Any]:
    """Create a new record in the specified table"""
    # Remove 'id' attribute if it exists in data
    data.pop("id", None)
    data["created"] = datetime.now(timezone.utc)
    data["updated"] = datetime.now(timezone.utc)
    try:
        async with db_connection() as connection:
            result = parse_record_ids(await connection.insert(table, data))
            # SurrealDB may return a string error message instead of the expected record
            if isinstance(result, str):
                raise RuntimeError(result)
            return result
    except RuntimeError as e:
        logger.error(str(e))
        raise
    except Exception as e:
        logger.exception(e)
        raise RuntimeError("Failed to create record")


async def repo_relate(
    source: Union[str, RecordID],
    relationship: str,
    target: Union[str, RecordID],
    data: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    """Create a relationship between two records with optional data"""
    if data is None:
        data = {}
    # relationship is an edge-table name, not a record value, so it can't be
    # bound as a query parameter; validate it against an identifier allowlist
    # instead of trusting the caller. source/target are always bound.
    _ensure_safe_identifier(relationship, "relationship")
    query = f"RELATE $source->{relationship}->$target CONTENT $data;"
    # logger.debug(f"Relate query: {query}")

    return await repo_query(
        query,
        {
            "source": ensure_record_id(source),
            "target": ensure_record_id(target),
            "data": data,
        },
    )


async def repo_upsert(
    table: str, id: Optional[str], data: Dict[str, Any], add_timestamp: bool = False
) -> List[Dict[str, Any]]:
    """Create or update a record in the specified table"""
    data.pop("id", None)
    if add_timestamp:
        data["updated"] = datetime.now(timezone.utc)
    _ensure_safe_identifier(table, "table")
    target: Union[RecordID, Table] = ensure_record_id(id) if id else Table(table)
    query = "UPSERT $target MERGE $data;"
    return await repo_query(query, {"target": target, "data": data})


async def repo_update(
    table: str, id: Union[str, RecordID], data: Dict[str, Any]
) -> List[Dict[str, Any]]:
    """Update an existing record by table and id"""
    # If id already contains the table name, use it as is
    try:
        _ensure_safe_identifier(table, "table")
        if isinstance(id, RecordID):
            record_id: RecordID = id
        elif ":" in id and id.startswith(f"{table}:"):
            record_id = ensure_record_id(id)
        else:
            record_id = RecordID(table, id)
        data.pop("id", None)
        if "created" in data and isinstance(data["created"], str):
            data["created"] = datetime.fromisoformat(data["created"])
        data["updated"] = datetime.now(timezone.utc)
        query = "UPDATE $target MERGE $data;"
        # logger.debug(f"Update query: {query}")
        result = await repo_query(query, {"target": record_id, "data": data})
        # if isinstance(result, list):
        #     return [_return_data(item) for item in result]
        return parse_record_ids(result)
    except Exception as e:
        raise RuntimeError(f"Failed to update record: {str(e)}")


async def repo_delete(record_id: Union[str, RecordID]):
    """Delete a record by record id"""

    try:
        async with db_connection() as connection:
            return await connection.delete(ensure_record_id(record_id))
    except Exception as e:
        logger.exception(e)
        raise RuntimeError(f"Failed to delete record: {str(e)}")


async def repo_insert(
    table: str, data: List[Dict[str, Any]], ignore_duplicates: bool = False
) -> List[Dict[str, Any]]:
    """Create a new record in the specified table"""
    try:
        async with db_connection() as connection:
            result = parse_record_ids(await connection.insert(table, data))
            # SurrealDB may return a string error message instead of the expected records
            if isinstance(result, str):
                raise RuntimeError(result)
            return result
    except RuntimeError as e:
        if ignore_duplicates and "already contains" in str(e):
            return []
        # Log transaction conflicts at debug level (they are expected during concurrent operations)
        error_str = str(e).lower()
        if "transaction" in error_str or "conflict" in error_str:
            logger.debug(str(e))
        else:
            logger.error(str(e))
        raise
    except Exception as e:
        if ignore_duplicates and "already contains" in str(e):
            return []
        logger.exception(e)
        raise RuntimeError("Failed to create record")
