"""
Async migration system for SurrealDB using the official Python client.
Based on patterns from sblpy migration system.
"""

import re
from typing import Any, Dict, List, Optional

from loguru import logger

from .repository import db_connection, repo_query

# Statement statuses SurrealDB reports per statement in a query_raw response.
_OK_STATUSES = {"OK"}


class MigrationLedgerError(RuntimeError):
    """The migration ledger is not in a state the requested operation allows."""


class MigrationSchemaError(RuntimeError):
    """Schema state after a migration does not match the expected contract."""


# Used by verify_migration_schema to reject pre-existing field definitions the
# UP path must not silently coexist with: a VALUE clause would overwrite every
# write of an identity field back to NONE, a DEFAULT would mask absent values,
# and extra ASSERT/READONLY/PERMISSIONS-NONE constraints can reject the
# adapter's writes. SurrealDB keeps IF NOT EXISTS on a conflicting definition,
# so these must be detected before the ledger records the migration as done.
_FORBIDDEN_DEFINITION_CLAUSES = re.compile(
    r"\b(VALUE|DEFAULT|ASSERT|READONLY)\b", re.IGNORECASE
)
# INFO def-strings are SurrealDB-generated single lines; quoted literals
# (e.g. COMMENT values) are blanked out before clause scanning so a comment
# mentioning "default" is not mistaken for a DEFAULT clause (Round 2 #3).
# The literal pattern is escape-aware (backslash-escaped quotes and
# backslashes are consumed as part of the literal) so a COMMENT such as
# 'it\'s a default' is fully blanked instead of leaving "default" exposed
# after the naive first-quote match (Round 3 #2).
_QUOTED_LITERAL_RE = re.compile(r"'(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\"")
# The actual TYPE expression: everything between TYPE and the next top-level
# clause keyword (or end of string). An exact-match against the expected
# type rejects both a wrong type whose def-string merely CONTAINS the
# expected substring (e.g. `TYPE int` plus a comment reading 'expected TYPE
# option<string>') and a union type (`option<string> | int`) that only
# shares a prefix with it (Round 3 #1).
_TYPE_CLAUSE_RE = re.compile(
    r"\bTYPE\s+(.*?)(?=\s+(?:VALUE|DEFAULT|ASSERT|READONLY|COMMENT|PERMISSIONS)\b|$)",
    re.DOTALL,
)


def _definition_clauses(definition: str) -> str:
    """A definition string with quoted literals blanked out."""
    return _QUOTED_LITERAL_RE.sub("''", definition)


def _definition_type(definition: str) -> Optional[str]:
    """The definition's full TYPE expression (quote-stripped), or None."""
    match = _TYPE_CLAUSE_RE.search(_definition_clauses(definition))
    return match.group(1).strip() if match else None


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
            if self.version == 24 and bump:
                # UP pre-check: an incompatible pre-existing definition (wrong
                # type, VALUE/DEFAULT overwriting writes, extra ASSERT/
                # READONLY) must stop the migration BEFORE any DDL and before
                # the ledger records it as done - IF NOT EXISTS would silently
                # keep such a definition and SurrealDB would then drop every
                # identity value written through it.
                await _assert_identity_definitions_compatible(require_present=False)
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
                    # UP post-check: the full schema contract must hold before
                    # the ledger records success.
                    await verify_migration_schema(self.version)
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
            if target_version == 24:
                # Completion contract for migration 24's DOWN: all three
                # identity definitions gone, the target ledger record gone,
                # and the ledger back at N-1. A ledger record for N-1 that is
                # itself missing (e.g. record 23 deleted out-of-band) makes
                # "latest is N-1" unfalsifiable here - get_latest_version
                # would read the remaining rows; an EMPTY ledger while N-1
                # was expected is reported by _validate_down_completion.
                await _validate_down_completion(target_version)
            return

        current_version = await get_latest_version()

        if current_version > 0:
            logger.info(f"Rolling back migration {current_version}")
            await self.down_migrations[current_version - 1].run(bump=False)
            if current_version == 24:
                # Legacy no-target DOWN of migration 24 runs the same
                # completion contract as the explicit-target path - there is
                # only one DOWN 24 entry path (Round 2 #4).
                await _validate_down_completion(current_version)


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
        # schema must actually exist — see ``verify_latest_schema``.
        await self.verify_latest_schema()

    async def verify_latest_schema(self) -> None:
        """Verify (and, if needed, idempotently heal) the newest migration's schema.

        The ledger can say "latest" while the schema is missing: a definition
        was removed out-of-band, or a migration was rolled back (e.g.
        ``24_down``) while its ledger row survived. Without this check the app
        starts silently and the adapter's identity writes are dropped again by
        ``SCHEMAFULL`` — the original write-drop closure (issue #66).

        Healing is idempotent: the newest migration re-runs its own up-SQL
        (``DEFINE FIELD IF NOT EXISTS``) and its ledger row is re-recorded
        (so a manual rollback of that migration is undone — logged loudly);
        only a persistent mismatch raises ``MigrationSchemaError`` and fails
        startup.

        Callers: ``run_migration_up`` (after applying pending migrations) and
        the API startup path even when no migration is pending.
        """
        newest = self.up_migrations[-1]
        if newest.version is None or self.verify_schema is None:
            return
        try:
            await self.verify_schema(newest.version)
        except MigrationSchemaError:
            logger.warning(
                f"Migration {newest.version} schema incomplete at startup; "
                f"re-applying its up-SQL idempotently. NOTE: this records "
                f"version {newest.version} in the ledger again, so an "
                f"intentional manual rollback of that migration (e.g. running "
                f"24_down) is undone by this self-heal."
            )
            await newest.run(bump=True)
            await self.verify_schema(newest.version)
            logger.warning(
                f"Migration {newest.version} schema healed and ledger "
                f"re-recorded"
            )


# Database version management functions
async def get_latest_version() -> int:
    """Get the latest version from the migrations table.

    Only a SUCCESSFUL read of an empty (or missing) ledger yields 0 - a fresh
    database. Read failures, malformed rows, and malformed result shapes
    propagate: swallowing them into a version-0 answer made a transient
    network/permission failure look like an un-migrated database, and a
    recovered connection would replay migration 1 on top of an
    already-migrated schema.
    """
    versions = await get_all_versions()
    if versions == []:
        return 0
    return max(_validated_ledger_version(row) for row in versions)


async def get_all_versions() -> List[dict]:
    """Get all versions from the migrations table.

    A missing table reads back as [] (SurrealDB 2.6.5 returns no error for a
    SELECT on a nonexistent table), which get_latest_version legitimately
    treats as version 0 on a fresh database. Any query failure raises; a
    non-list result (None/dict/str - an invalid shape, NOT an empty ledger)
    raises instead of masquerading as version 0 (Round 2 #2).
    """
    result = await repo_query("SELECT * FROM _sbl_migrations ORDER BY version;")
    if not isinstance(result, list):
        raise MigrationLedgerError(
            f"Malformed migration ledger read (expected a list, got "
            f"{type(result).__name__}): {result!r}"
        )
    return result


def _validated_ledger_version(row: dict) -> int:
    """Extract and type-check one ledger row's version field."""
    version = row.get("version") if isinstance(row, dict) else None
    if not isinstance(version, int) or isinstance(version, bool):
        raise MigrationLedgerError(
            f"Malformed migration ledger row (version must be int): {row!r}"
        )
    return version


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


async def _source_field_definitions() -> Dict[str, str]:
    """Read the current field definition strings of table `source`."""
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
    return info_rows.get("fields") or {}


async def _assert_identity_definitions_compatible(require_present: bool) -> None:
    """Fail when an existing rdlens_* definition conflicts with the UP contract.

    Runs BEFORE migration 24's DDL: IF NOT EXISTS keeps a pre-existing
    definition, so an incompatible one (wrong type, or a VALUE/DEFAULT clause
    that would overwrite or mask identity writes, or an extra ASSERT/READONLY
    constraint) must abort the migration before the ledger records it. A
    missing definition is fine here (the UP creates it); when
    `require_present` is set the fields must already exist.
    """
    fields = await _source_field_definitions()
    for name, field_type in _EXPECTED_IDENTITY_FIELDS.items():
        definition = fields.get(name)
        if definition is None:
            if require_present:
                raise MigrationSchemaError(
                    f"Migration 24 schema incomplete: field {name} is not defined "
                    f"on table source. Re-run the up migration."
                )
            continue
        # Exact TYPE-expression match on the quote-stripped definition: a
        # substring check would accept e.g. TYPE int with a comment reading
        # 'expected TYPE option<string>' (Round 2 #1), and a first-token
        # check would accept a union type sharing the prefix, e.g.
        # `option<string> | int` (Round 3 #1).
        actual_type = _definition_type(definition)
        if actual_type != field_type:
            raise MigrationSchemaError(
                f"Migration 24 schema incompatible: field {name} is defined "
                f"as {definition!r}, expected TYPE {field_type} "
                f"(found {actual_type!r})."
            )
        # Forbidden-clause scan runs on the quote-stripped text (escape-aware
        # literal blanking, Round 3 #2), so a COMMENT mentioning "default"
        # does not read as a DEFAULT clause.
        clause = _FORBIDDEN_DEFINITION_CLAUSES.search(_definition_clauses(definition))
        if clause:
            raise MigrationSchemaError(
                f"Migration 24 schema incompatible: field {name} definition "
                f"contains a conflicting {clause.group(0)} clause: {definition!r}. "
                f"Remove or fix the existing definition before re-running."
            )


async def _validate_down_completion(target_version: int) -> None:
    """Triple-verify migration 24's DOWN actually completed (M5).

    Checks all three completion conditions - the three identity definitions
    absent, the target ledger record absent, and the ledger's latest version
    at N-1 - because the DDL and the ledger delete are two separate commits:
    a partially-applied DOWN must fail loudly, not report success while a
    definition (or the record) survived.

    The record-absence check queries the FIXED record id
    `_sbl_migrations:N` directly (a version-only scan would miss a surviving
    record whose version field was tampered); malformed ledger rows raise
    instead of being silently filtered (Round 2 #4).
    """
    fields = await _source_field_definitions()
    surviving = [name for name in _EXPECTED_IDENTITY_FIELDS if name in fields]
    if surviving:
        raise MigrationSchemaError(
            f"Migration {target_version} rollback incomplete: field(s) "
            f"{', '.join(surviving)} still defined on table source."
        )
    record_rows = await repo_query(
        "SELECT * FROM ONLY _sbl_migrations WHERE id = "
        "type::thing('_sbl_migrations', $version);",
        {"version": target_version},
    )
    if record_rows is not None:
        raise MigrationLedgerError(
            f"Migration {target_version} rollback incomplete: ledger record "
            f"_sbl_migrations:{target_version} still present."
        )
    versions = await get_all_versions()
    versions_list = [_validated_ledger_version(row) for row in versions]
    expected_latest = target_version - 1
    latest = max(versions_list) if versions_list else 0
    if latest != expected_latest:
        raise MigrationLedgerError(
            f"Migration {target_version} rollback incomplete: ledger latest "
            f"version is {latest}, expected {expected_latest}."
        )


_EXPECTED_IDENTITY_FIELDS = {
    "rdlens_document_id": "option<string>",
    "rdlens_document_version": "option<string>",
    "rdlens_content_hash": "option<string>",
}


async def verify_migration_schema(version: int) -> None:
    """Verify the schema contract a migration version is responsible for.

    Called after the ledger records `version` (and on every startup at the
    latest version): the migration's own SQL must have taken effect, not just
    the bookkeeping. Currently covers migration 24's three RDLens identity
    fields on `source`; a missing definition here means the write path would
    silently drop values again (issue #66), so startup must fail loudly.
    A pre-existing definition with conflicting VALUE/DEFAULT/ASSERT/READONLY
    clauses also fails: SurrealDB would keep it under IF NOT EXISTS and drop
    or reject the adapter's identity writes.
    """
    if version != 24:
        if version > 24:
            # 新增迁移时必须扩展本函数：否则「账本最新」校验对本函数而言变成
            # no-op，schema 漂移会**静默**不再被发现（RDLens#613 复审 LOW）。
            logger.warning(
                f"verify_migration_schema has no schema contract for migration "
                f"{version}; schema drift for it will not be detected. "
                f"Extend verify_migration_schema when adding a migration."
            )
        return
    await _assert_identity_definitions_compatible(require_present=True)
    logger.debug("Migration 24 schema verified: rdlens_* identity fields present")
