"""RDLens-only text Source upsert/delete/readback service.

This path writes only Open Notebook's Source cache and notebook relation.  It
does not invoke source processing, transformations, providers, native AI, or
embedding commands.
"""

from __future__ import annotations

import asyncio
import hashlib
from typing import Any, Dict, List, cast

from surrealdb import RecordID

from api.models import (
    RDLensSourceDelete,
    RDLensSourceRead,
    RDLensSourceUpsert,
)
from open_notebook.database.repository import repo_query, repo_upsert
from open_notebook.domain.notebook import Notebook
from open_notebook.exceptions import InvalidInputError


def stable_rdlens_source_id(
    notebook_id: str, document_id: str, document_version: str,
) -> str:
    digest = hashlib.sha256(
        f"{notebook_id}\0{document_id}\0{document_version}".encode("utf-8")
    ).hexdigest()[:32]
    return f"source:rdlens_{digest}"


def _stable_reference_id(source_id: str) -> str:
    digest = hashlib.sha256(source_id.encode("utf-8")).hexdigest()[:32]
    return f"reference:rdlens_{digest}"


async def upsert_rdlens_source(request: RDLensSourceUpsert) -> dict:
    """Upsert one deterministic text Source and its exact notebook binding."""

    await Notebook.get(request.notebook_id)
    source_id = stable_rdlens_source_id(
        request.notebook_id, request.document_id, request.document_version,
    )
    await repo_upsert(
        "source",
        source_id,
        {
            "title": (request.title or request.document_id).strip(),
            "topics": [],
            "full_text": request.markdown,
            "rdlens_document_id": request.document_id,
            "rdlens_document_version": request.document_version,
            "rdlens_content_hash": request.content_hash,
        },
        add_timestamp=True,
    )
    # 关系表必须用 RELATE 语法（SurrealDB 拒绝 UPSERT CONTENT 对
    # 关系表的 in/out 赋值）；固定 id 保证幂等（重跑不产生重复关系）。
    await repo_query(
        f"RELATE $source_id -> {_stable_reference_id(source_id)} -> $notebook_id;",
        {
            "source_id": RecordID.parse(source_id),
            "notebook_id": RecordID.parse(request.notebook_id),
        },
    )
    return {
        "source_id": source_id,
        "notebook_id": request.notebook_id,
        "document_id": request.document_id,
        "document_version": request.document_version,
        "content_hash": request.content_hash,
        "source_type": "text",
        "embed": False,
    }


async def delete_rdlens_source(request: RDLensSourceDelete) -> dict:
    """Delete the deterministic Source and relation; missing records succeed."""

    expected_id = stable_rdlens_source_id(
        request.notebook_id, request.document_id, request.document_version,
    )
    if request.source_id is not None and request.source_id != expected_id:
        raise InvalidInputError("source_id does not match notebook document binding")
    await repo_query(
        "DELETE $relation_id; DELETE $source_id;",
        {
            "relation_id": RecordID.parse(_stable_reference_id(expected_id)),
            "source_id": RecordID.parse(expected_id),
        },
    )
    return {"source_id": expected_id, "deleted": True}


class RDLensSourceNotFoundError(Exception):
    """GET-specific: the Source, the notebook, or their binding does not exist.

    Mapped to 404 with detail.code=source_not_found by the router. Distinct
    from domain NotFoundError so a database failure can never be reported as
    "not found" (base.py get() converts every exception to NotFoundError -
    the reason this service uses raw queries instead).
    """


class RDLensSourceReadError(Exception):
    """GET-specific: database failure, invalid result shape, or timeout.

    Mapped to 500 by the router.
    """


_READBACK_QUERY = (
    "RETURN {"
    "source: (SELECT * FROM ONLY source WHERE id = $source_id),"
    "notebook: (SELECT * FROM ONLY notebook WHERE id = $notebook_id),"
    "references: (SELECT id, in, out FROM reference WHERE in = $source_id ORDER BY id)"
    "};"
)


async def read_rdlens_source(request: RDLensSourceRead) -> dict:
    """Read back the actual persisted Source identity for RDLens verification.

    Opens one budgeted connection and issues three parameterized queries
    against it (the SDK returns only the first statement's result for a
    multi-statement query, so they must be separate calls). Returns the
    stored values as-is: missing identity fields read back as null - no
    inference from the request, deterministic ids, or body content.
    """
    from open_notebook.database.repository import (
        INTERNAL_GET_OPERATION_BUDGET_SECONDS,
        db_connection,
    )

    source_id = stable_rdlens_source_id(
        request.notebook_id, request.document_id, request.document_version,
    )
    # RecordID objects, not strings: string binding silently fails to match
    # against record ids in SurrealQL WHERE clauses. RecordID.parse raises
    # ValueError for ids without the table:id shape - the router maps that
    # to 400 before any query runs.
    params = {
        "source_id": RecordID.parse(source_id),
        "notebook_id": RecordID.parse(request.notebook_id),
    }
    if params["source_id"].table_name != "source" or params["notebook_id"].table_name != "notebook":
        raise ValueError(
            "notebook_id must be a record of table 'notebook' "
            f"(got {request.notebook_id!r})"
        )

    try:
        async with db_connection(
            operation_budget_seconds=INTERNAL_GET_OPERATION_BUDGET_SECONDS
        ) as connection:
            source_rows = await repo_query(
                "SELECT * FROM ONLY source WHERE id = $source_id;",
                {"source_id": params["source_id"]},
                connection=connection,
            )
            notebook_rows = await repo_query(
                "SELECT * FROM ONLY notebook WHERE id = $notebook_id;",
                {"notebook_id": params["notebook_id"]},
                connection=connection,
            )
            reference_rows = await repo_query(
                "SELECT id, in, out FROM reference WHERE in = $source_id ORDER BY id;",
                {"source_id": params["source_id"]},
                connection=connection,
            )
    except asyncio.TimeoutError as e:
        raise RDLensSourceReadError(
            f"source readback exceeded "
            f"{INTERNAL_GET_OPERATION_BUDGET_SECONDS}s operation budget"
        ) from e
    except asyncio.CancelledError:
        raise
    except Exception as e:
        raise RDLensSourceReadError(f"source readback query failed: {e}") from e

    # ONLY SELECT returns None for a missing record and a dict otherwise;
    # anything else is an invalid result shape, not an absence.
    for rows, kind in ((source_rows, "source"), (notebook_rows, "notebook")):
        if rows is not None and not isinstance(rows, dict):
            raise RDLensSourceReadError(
                f"source readback returned an unexpected {kind} result shape"
            )
    if not isinstance(reference_rows, list):
        raise RDLensSourceReadError(
            "source readback returned an unexpected reference shape"
        )

    if source_rows is None or notebook_rows is None:
        # Source or notebook missing (or both). No binding can exist in
        # either case; this is the GET's 404, not a 500.
        raise RDLensSourceNotFoundError(
            f"source {source_id} or notebook {request.notebook_id} not found"
        )

    references: List[dict] = []
    for row in reference_rows:
        if not isinstance(row, dict) or "id" not in row or "out" not in row:
            raise RDLensSourceReadError(
                "source readback returned an invalid reference row shape"
            )
        references.append(
            {"id": str(row["id"]), "in": str(row.get("in")), "out": str(row["out"])}
        )

    bound = any(ref["out"] == request.notebook_id for ref in references)
    if not bound:
        raise RDLensSourceNotFoundError(
            f"source {source_id} is not bound to notebook {request.notebook_id}"
        )

    # Narrowed to dict by the shape check above; ONLY SELECT unwraps to dict.
    source = cast(Dict[str, Any], source_rows)
    return {
        "source_id": source_id,
        "notebook_id": request.notebook_id,
        "rdlens_document_id": source.get("rdlens_document_id"),
        "rdlens_document_version": source.get("rdlens_document_version"),
        "rdlens_content_hash": source.get("rdlens_content_hash"),
        "references": references,
    }
