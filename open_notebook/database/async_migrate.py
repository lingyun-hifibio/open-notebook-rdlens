"""
Async migration system for SurrealDB using the official Python client.
Based on patterns from sblpy migration system.
"""

from typing import Any, Dict, List, Optional

from loguru import logger

from .repository import db_connection, repo_query

# Statement statuses SurrealDB reports per statement in a query_raw response.
_OK_STATUSES = {"OK"}


class MigrationLedgerError(RuntimeError):
    """The migration ledger is not in a state the requested operation allows."""


class MigrationSchemaError(RuntimeError):
    """Schema state after a migration does not match the expected contract."""


class AsyncMigration:
    """
    Handles individual migration operations with async support.
    """

    def __init__(self, sql: str, version: Optional[int] = None) -> None:
        """Initialize migration with SQL content and optional fixed version."""
        self.sql = sql
        self.version = version

    @classmethod
    def from_file(cls, file_path: str, version: Optional[int] = None) -> "AsyncMigration":
        """Create migration from SQL file."""
        with open(file_path, "r", encoding="utf-8") as file:
            raw_content = file.read()
            # Clean up SQL content
            lines = []
            for line in raw_content.split("\n"):
                line = line.strip()
                if line and not line.startswith("--"):
                    lines.append(line)
            sql = " ".join(lines)
            return cls(sql, version=version)

    async def run(self, bump: bool = True) -> None:
        """Run the migration."""
        try:
            async with db_connection() as connection:
                if self.version is not None:
                    # Explicitly registered (new) migration: check EVERY
                    # statement's status. The SDK's query() returns only the
                    # first statement's result and silently ignores per-
                    # statement ERR envelopes, which would let a half-applied
                    # DDL be recorded as complete.
                    raw = await connection.query_raw(self.sql)
                    _raise_on_statement_errors(raw, "migration")
                else:
                    # Historical migrations (1-23) predate this contract and
                    # keep the legacy behavior: SurrealDB 2.6.5 reports
                    # benign per-statement ERRs inside them (e.g. bare
                    # `remove table` on a fresh database, seed re-insert on
                    # replay); fixing their SQL is out of scope for #66 and
                    # their files must not be modified.
                    await connection.query(self.sql)

            if self.version is not None:
                # Fixed target: the ledger record is exactly this migration's
                # number. Never derived from get_latest_version(), so two
                # concurrent executors cannot register different versions, and
                # a lost confirmation can be retried idempotently (UPSERT).
                if bump:
                    await record_migration_version(self.version)
                else:
                    await remove_migration_version(self.version)
            elif bump:
                await bump_version()
            else:
                await lower_version()

        except Exception as e:
            logger.error(f"Migration failed: {str(e)}")
            raise


class AsyncMigrationRunner:
    """
    Handles running multiple migrations in sequence.
    """

    def __init__(
        self,
        up_migrations: List[AsyncMigration],
        down_migrations: List[AsyncMigration],
    ) -> None:
        """Initialize runner with migration lists."""
        self.up_migrations = up_migrations
        self.down_migrations = down_migrations

    async def run_all(self) -> None:
        """Run all pending up migrations."""
        current_version = await get_latest_version()

        for i in range(current_version, len(self.up_migrations)):
            logger.info(f"Running migration {i + 1}")
            await self.up_migrations[i].run(bump=True)

    async def run_one_up(self) -> None:
        """Run one up migration."""
        current_version = await get_latest_version()

        if current_version < len(self.up_migrations):
            logger.info(f"Running migration {current_version + 1}")
            await self.up_migrations[current_version].run(bump=True)

    async def run_one_down(self, target_version: Optional[int] = None) -> None:
        """Roll back one migration.

        Without target_version: rolls back the current top of the ledger
        (legacy single-step behavior).

        With explicit target_version N: rolls back migration N only, never
        N-1. The ledger's latest version must be N (normal case) or N-1
        (a retry after the DDL landed but the confirmation/ledger deletion
        was lost, or the ledger record was already removed). Any other
        ledger state means rolling back N would strand higher applied
        versions and is refused. The caller must re-run with the same
        target on retry - the operation is idempotent for both accepted
        states.
        """
        if target_version is not None:
            down_migrations = {
                m.version: m for m in self.down_migrations if m.version is not None
            }
            migration = down_migrations.get(target_version)
            if migration is None:
                raise MigrationLedgerError(
                    f"No down migration registered for version {target_version}"
                )

            latest = await get_latest_version()
            if latest == target_version - 1:
                logger.info(
                    f"Ledger already at {latest}; completing leftover cleanup "
                    f"of migration {target_version}"
                )
            elif latest != target_version:
                raise MigrationLedgerError(
                    f"Cannot roll back migration {target_version}: ledger "
                    f"latest version is {latest}. Only the top migration "
                    f"(N) or N-1 (retry of an interrupted rollback) is "
                    f"allowed. Re-run with the same explicit target after "
                    f"verifying the ledger."
                )

            logger.info(f"Rolling back migration {target_version}")
            # bump=False + fixed version deletes exactly the target's ledger
            # record - never a re-read "latest" that another writer could
            # have moved.
            await migration.run(bump=False)
            return

        current_version = await get_latest_version()

        if current_version > 0:
            logger.info(f"Rolling back migration {current_version}")
            await self.down_migrations[current_version - 1].run(bump=False)


class AsyncMigrationManager:
    """
    Main migration manager with async support.
    """

    def __init__(self, verify_schema=None):
        """Initialize migration manager.

        verify_schema: async callable (version) -> None, invoked after the
        up path to assert the newest migration's schema contract actually
        holds. Defaults to verify_migration_schema.
        """
        self.verify_schema = (
            verify_migration_schema if verify_schema is None else verify_schema
        )
        self.up_migrations = [
            AsyncMigration.from_file("open_notebook/database/migrations/1.surrealql"),
            AsyncMigration.from_file("open_notebook/database/migrations/2.surrealql"),
            AsyncMigration.from_file("open_notebook/database/migrations/3.surrealql"),
            AsyncMigration.from_file("open_notebook/database/migrations/4.surrealql"),
            AsyncMigration.from_file("open_notebook/database/migrations/5.surrealql"),
            AsyncMigration.from_file("open_notebook/database/migrations/6.surrealql"),
            AsyncMigration.from_file("open_notebook/database/migrations/7.surrealql"),
            AsyncMigration.from_file("open_notebook/database/migrations/8.surrealql"),
            AsyncMigration.from_file("open_notebook/database/migrations/9.surrealql"),
            AsyncMigration.from_file("open_notebook/database/migrations/10.surrealql"),
            AsyncMigration.from_file(
                "open_notebook/database/migrations/11.surrealql"
            ),
            AsyncMigration.from_file(
                "open_notebook/database/migrations/12.surrealql"
            ),
            AsyncMigration.from_file(
                "open_notebook/database/migrations/13.surrealql"
            ),
            AsyncMigration.from_file(
                "open_notebook/database/migrations/14.surrealql"
            ),
            AsyncMigration.from_file(
                "open_notebook/database/migrations/15.surrealql"
            ),
            AsyncMigration.from_file(
                "open_notebook/database/migrations/16.surrealql"
            ),
            AsyncMigration.from_file(
                "open_notebook/database/migrations/17.surrealql"
            ),
            AsyncMigration.from_file(
                "open_notebook/database/migrations/18.surrealql"
            ),
            AsyncMigration.from_file(
                "open_notebook/database/migrations/19.surrealql"
            ),
            AsyncMigration.from_file(
                "open_notebook/database/migrations/20.surrealql"
            ),
            AsyncMigration.from_file(
                "open_notebook/database/migrations/21.surrealql"
            ),
            AsyncMigration.from_file(
                "open_notebook/database/migrations/22.surrealql"
            ),
            AsyncMigration.from_file(
                "open_notebook/database/migrations/23.surrealql", version=23
            ),
            AsyncMigration.from_file(
                "open_notebook/database/migrations/24.surrealql", version=24
            ),
        ]
        self.down_migrations = [
            AsyncMigration.from_file(
                "open_notebook/database/migrations/1_down.surrealql"
            ),
            AsyncMigration.from_file(
                "open_notebook/database/migrations/2_down.surrealql"
            ),
            AsyncMigration.from_file(
                "open_notebook/database/migrations/3_down.surrealql"
            ),
            AsyncMigration.from_file(
                "open_notebook/database/migrations/4_down.surrealql"
            ),
            AsyncMigration.from_file(
                "open_notebook/database/migrations/5_down.surrealql"
            ),
            AsyncMigration.from_file(
                "open_notebook/database/migrations/6_down.surrealql"
            ),
            AsyncMigration.from_file(
                "open_notebook/database/migrations/7_down.surrealql"
            ),
            AsyncMigration.from_file(
                "open_notebook/database/migrations/8_down.surrealql"
            ),
            AsyncMigration.from_file(
                "open_notebook/database/migrations/9_down.surrealql"
            ),
            AsyncMigration.from_file(
                "open_notebook/database/migrations/10_down.surrealql"
            ),
            AsyncMigration.from_file(
                "open_notebook/database/migrations/11_down.surrealql"
            ),
            AsyncMigration.from_file(
                "open_notebook/database/migrations/12_down.surrealql"
            ),
            AsyncMigration.from_file(
                "open_notebook/database/migrations/13_down.surrealql"
            ),
            AsyncMigration.from_file(
                "open_notebook/database/migrations/14_down.surrealql"
            ),
            AsyncMigration.from_file(
                "open_notebook/database/migrations/15_down.surrealql"
            ),
            AsyncMigration.from_file(
                "open_notebook/database/migrations/16_down.surrealql"
            ),
            AsyncMigration.from_file(
                "open_notebook/database/migrations/17_down.surrealql"
            ),
            AsyncMigration.from_file(
                "open_notebook/database/migrations/18_down.surrealql"
            ),
            AsyncMigration.from_file(
                "open_notebook/database/migrations/19_down.surrealql"
            ),
            AsyncMigration.from_file(
                "open_notebook/database/migrations/20_down.surrealql"
            ),
            AsyncMigration.from_file(
                "open_notebook/database/migrations/21_down.surrealql"
            ),
            AsyncMigration.from_file(
                "open_notebook/database/migrations/22_down.surrealql"
            ),
            AsyncMigration.from_file(
                "open_notebook/database/migrations/23_down.surrealql", version=23
            ),
            AsyncMigration.from_file(
                "open_notebook/database/migrations/24_down.surrealql", version=24
            ),
        ]
        self.runner = AsyncMigrationRunner(
            up_migrations=self.up_migrations,
            down_migrations=self.down_migrations,
        )

    async def get_current_version(self) -> int:
        """Get current database version."""
        return await get_latest_version()

    async def ping(self) -> None:
        """Check whether SurrealDB is reachable for migration startup."""
        async with db_connection() as connection:
            await connection.query("RETURN true;")

        # Also exercise the migration version path. get_current_version() already
        # treats a missing migrations table as version 0 for fresh databases.
        await self.get_current_version()

    async def needs_migration(self) -> bool:
        """Check if migration is needed."""
        current_version = await self.get_current_version()
        return current_version < len(self.up_migrations)

    async def run_migration_up(self):
        """Run all pending migrations."""
        current_version = await self.get_current_version()
        logger.info(f"Current version before migration: {current_version}")

        if await self.needs_migration():
            try:
                await self.runner.run_all()
                new_version = await self.get_current_version()
                logger.info(f"Migration successful. New version: {new_version}")
            except Exception as e:
                logger.error(f"Migration failed: {str(e)}")
                raise
        else:
            logger.info("Database is already at the latest version")

        # Even when the ledger says the latest migration is applied, its
        # schema must actually exist (e.g. the ledger survived while a
        # definition was removed out-of-band). The newest migration
        # re-verifies its own contract; a missing/incompatible definition is
        # first healed by idempotently re-running that migration's up-SQL
        # (DEFINE FIELD IF NOT EXISTS), and only a persistent mismatch
        # fails startup.
        newest = self.up_migrations[-1]
        if newest.version is not None and self.verify_schema is not None:
            try:
                await self.verify_schema(newest.version)
            except MigrationSchemaError:
                logger.warning(
                    f"Migration {newest.version} schema incomplete at startup; "
                    f"re-running its up-SQL idempotently"
                )
                await newest.run(bump=True)
                await self.verify_schema(newest.version)


# Database version management functions
async def get_latest_version() -> int:
    """Get the latest version from the migrations table."""
    try:
        versions = await get_all_versions()
        if not versions:
            return 0
        return max(version["version"] for version in versions)
    except Exception:
        # If migrations table doesn't exist, we're at version 0
        return 0


async def get_all_versions() -> List[dict]:
    """Get all versions from the migrations table."""
    try:
        result = await repo_query("SELECT * FROM _sbl_migrations ORDER BY version;")
        return result
    except Exception:
        # If table doesn't exist, return empty list
        return []


async def bump_version() -> None:
    """Bump the version by adding a new entry to migrations table."""
    current_version = await get_latest_version()
    new_version = current_version + 1

    await repo_query(
        "CREATE type::thing('_sbl_migrations', $version) SET version = $version, applied_at = time::now();",
        {"version": new_version},
    )


async def lower_version() -> None:
    """Lower the version by removing the latest entry from migrations table."""
    current_version = await get_latest_version()
    if current_version > 0:
        await repo_query(
            "DELETE type::thing('_sbl_migrations', $version);",
            {"version": current_version},
        )


async def record_migration_version(version: int) -> None:
    """Register an explicit migration version in the ledger.

    Uses UPSERT on the fixed record id so the write is idempotent: a retry
    after a lost confirmation converges on the same record. An existing
    record's applied_at timestamp is preserved (the UPDATE only fills a
    missing timestamp, e.g. when the DDL landed but the process died before
    the follow-up write completed).
    """
    await repo_query(
        "BEGIN TRANSACTION;"
        " UPSERT type::thing('_sbl_migrations', $version)"
        " SET version = $version;"
        " UPDATE type::thing('_sbl_migrations', $version)"
        " SET applied_at = time::now() WHERE applied_at IS NONE;"
        " COMMIT TRANSACTION;",
        {"version": version},
    )


async def remove_migration_version(version: int) -> None:
    """Delete exactly the given migration version's ledger record."""
    await repo_query(
        "DELETE type::thing('_sbl_migrations', $version);",
        {"version": version},
    )


def _raise_on_statement_errors(raw_response: Dict[str, Any], process: str) -> None:
    """Fail when any statement inside a query_raw response reports ERR.

    The SDK's query() checks only the transport-level error envelope and
    returns the FIRST statement's result; per-statement ERR statuses (e.g. a
    THROW or a failed DDL inside a multi-statement migration) would otherwise
    pass silently.
    """
    result = raw_response.get("result")
    if not isinstance(result, list):
        raise MigrationLedgerError(
            f"{process}: unexpected query response shape: {raw_response!r}"
        )
    for statement in result:
        if statement.get("status") not in _OK_STATUSES:
            raise MigrationLedgerError(
                f"{process} statement failed: {statement.get('result')!r}"
            )


async def verify_migration_schema(version: int) -> None:
    """Verify the schema contract a migration version is responsible for.

    Called after the ledger records `version` (and on every startup at the
    latest version): the migration's own SQL must have taken effect, not just
    the bookkeeping. Currently covers migration 24's three RDLens identity
    fields on `source`; a missing definition here means the write path would
    silently drop values again (issue #66), so startup must fail loudly.
    """
    if version != 24:
        return
    expected = {
        "rdlens_document_id": "option<string>",
        "rdlens_document_version": "option<string>",
        "rdlens_content_hash": "option<string>",
    }
    try:
        info_rows = await repo_query("INFO FOR TABLE source;")
    except Exception as e:
        raise MigrationSchemaError(
            f"Cannot verify migration 24 schema (INFO FOR TABLE source failed): {e}"
        ) from e
    # repo_query returns the unwrapped first-statement result: a dict for
    # INFO queries.
    if not isinstance(info_rows, dict):
        raise MigrationSchemaError(
            "Cannot verify migration 24 schema: unexpected INFO result shape"
        )
    fields: Dict[str, str] = info_rows.get("fields") or {}
    for name, field_type in expected.items():
        definition = fields.get(name)
        if definition is None:
            raise MigrationSchemaError(
                f"Migration 24 schema incomplete: field {name} is not defined "
                f"on table source. Re-run the up migration."
            )
        if f"TYPE {field_type}" not in definition:
            raise MigrationSchemaError(
                f"Migration 24 schema incompatible: field {name} is defined "
                f"as {definition!r}, expected TYPE {field_type}."
            )
    logger.debug("Migration 24 schema verified: rdlens_* identity fields present")
