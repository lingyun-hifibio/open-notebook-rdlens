"""Migration 24 + runner target semantics tests (fork issue #66).

Component-level coverage. Real-database acceptance (idempotent apply on
fresh and existing databases, write-then-readback through a second
connection, DOWN→UP round trip, concurrency) runs against an isolated
SurrealDB 2.6.5 instance and is documented in the PR.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from open_notebook.database import async_migrate

MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / (
    "open_notebook/database/migrations"
)

EXPECTED_FIELDS = (
    "rdlens_document_id",
    "rdlens_document_version",
    "rdlens_content_hash",
)


def _up_sql() -> str:
    return (MIGRATIONS_DIR / "24.surrealql").read_text(encoding="utf-8")


def _down_sql() -> str:
    return (MIGRATIONS_DIR / "24_down.surrealql").read_text(encoding="utf-8")


class TestMigration24Files:
    """Migration files exist, are registered, and keep the add-only contract."""

    def test_up_file_defines_three_identity_fields(self):
        sql = _up_sql()
        for field in EXPECTED_FIELDS:
            assert f"DEFINE FIELD IF NOT EXISTS {field} ON TABLE source" in sql
        assert sql.count("TYPE option<string>") >= 3

    def test_up_file_is_add_only(self):
        """No REMOVE/UPDATE/DROP on existing data or fields."""
        sql = _up_sql().lower()
        assert "remove " not in sql
        assert "update " not in sql

    def test_up_wraps_definitions_in_transaction(self):
        sql = _up_sql()
        assert "BEGIN TRANSACTION" in sql
        assert "COMMIT TRANSACTION" in sql

    def test_down_file_removes_exactly_three_fields(self):
        sql = _down_sql()
        for field in EXPECTED_FIELDS:
            assert f"REMOVE FIELD IF EXISTS {field} ON TABLE source" in sql
        # Down must not touch pre-existing source fields.
        for preexisting in (
            "title", "topics", "full_text", "asset", "created", "updated",
        ):
            assert f"REMOVE FIELD IF EXISTS {preexisting}" not in sql

    def test_registered_in_manager(self):
        manager = async_migrate.AsyncMigrationManager()
        assert len(manager.up_migrations) == 24
        assert len(manager.down_migrations) == 24
        assert manager.up_migrations[23].version == 24
        assert manager.down_migrations[23].version == 24
        for field in EXPECTED_FIELDS:
            assert field in manager.up_migrations[23].sql
            assert field in manager.down_migrations[23].sql


class TestRunnerFixedTarget:
    """run_one_down(target_version=N) is explicit-target and ledger-bounded."""

    @pytest.mark.asyncio
    async def test_down_rejects_when_latest_is_not_n_or_n_minus_1(self):
        runner = async_migrate.AsyncMigrationRunner(
            up_migrations=[], down_migrations=async_migrate.AsyncMigrationManager().down_migrations,
        )
        with patch.object(
            async_migrate, "get_latest_version", new=AsyncMock(return_value=20)
        ):
            with pytest.raises(async_migrate.MigrationLedgerError, match="Cannot roll back"):
                await runner.run_one_down(target_version=24)

    @pytest.mark.asyncio
    async def test_down_refuses_unregistered_target(self):
        runner = async_migrate.AsyncMigrationRunner(
            up_migrations=[], down_migrations=[],
        )
        with pytest.raises(async_migrate.MigrationLedgerError, match="No down migration"):
            await runner.run_one_down(target_version=99)

    @pytest.mark.asyncio
    async def test_down_at_n_minus_1_completes_leftover_cleanup_not_n_minus_1(self):
        """Latest=N-1: run N's down-SQL with bump=False (fixed-target path)."""
        migration = async_migrate.AsyncMigration(_down_sql(), version=24)
        runner = async_migrate.AsyncMigrationRunner(
            up_migrations=[], down_migrations=[migration],
        )
        # Post-DOWN triple-verify reads: INFO (no rdlens fields), ledger (23).
        with (
            patch.object(
                async_migrate, "get_latest_version", new=AsyncMock(return_value=23)
            ),
            patch.object(async_migrate.AsyncMigration, "run", new=AsyncMock()) as run,
            patch.object(
                async_migrate,
                "repo_query",
                new=AsyncMock(
                    side_effect=[
                        {"fields": {}},
                        [{"id": "_sbl_migrations:23", "version": 23}],
                    ]
                ),
            ),
        ):
            await runner.run_one_down(target_version=24)
        run.assert_awaited_once_with(bump=False)

    @pytest.mark.asyncio
    async def test_down_at_n_uses_fixed_target_ledger_delete(self):
        """At latest=N: migration.run(bump=False) → remove_migration_version(N)."""
        migration = async_migrate.AsyncMigration(_down_sql(), version=24)
        conn = AsyncMock(
            query_raw=AsyncMock(
                return_value={"result": [{"status": "OK", "result": None}]}
            )
        )
        with (
            patch.object(
                async_migrate, "get_latest_version", new=AsyncMock(return_value=24)
            ),
            patch.object(async_migrate, "db_connection") as conn_cm,
            patch.object(
                async_migrate, "remove_migration_version", new=AsyncMock()
            ) as remove_v,
            patch.object(
                async_migrate,
                "repo_query",
                new=AsyncMock(
                    side_effect=[
                        {"fields": {}},
                        [{"id": "_sbl_migrations:23", "version": 23}],
                    ]
                ),
            ),
        ):
            conn_cm.return_value.__aenter__ = AsyncMock(return_value=conn)
            conn_cm.return_value.__aexit__ = AsyncMock(return_value=False)
            runner = async_migrate.AsyncMigrationRunner(
                up_migrations=[], down_migrations=[migration],
            )
            await runner.run_one_down(target_version=24)
        remove_v.assert_awaited_once_with(24)

    @pytest.mark.asyncio
    async def test_down_retries_idempotently_after_lost_confirmation(self):
        """Latest=N-1 twice in a row: both calls converge, neither runs N-1."""
        migration = async_migrate.AsyncMigration(_down_sql(), version=24)
        runner = async_migrate.AsyncMigrationRunner(
            up_migrations=[], down_migrations=[migration],
        )
        # Each of the two DOWNs triple-verifies: INFO + ledger read, twice.
        post_verify_reads = [
            {"fields": {}},
            [{"id": "_sbl_migrations:23", "version": 23}],
            {"fields": {}},
            [{"id": "_sbl_migrations:23", "version": 23}],
        ]
        with (
            patch.object(
                async_migrate, "get_latest_version", new=AsyncMock(return_value=23)
            ),
            patch.object(async_migrate.AsyncMigration, "run", new=AsyncMock()) as run,
            patch.object(
                async_migrate, "repo_query", new=AsyncMock(side_effect=post_verify_reads)
            ),
        ):
            await runner.run_one_down(target_version=24)
            await runner.run_one_down(target_version=24)
        assert run.await_count == 2
        for call in run.await_args_list:
            assert call.kwargs.get("bump") is False

    @pytest.mark.asyncio
    async def test_migration_run_uses_fixed_version_for_ledger(self):
        """A version-tagged migration writes/removes its own number only."""
        migration = async_migrate.AsyncMigration("RETURN 1;", version=24)
        with (
            patch.object(
                async_migrate, "db_connection"
            ) as conn_cm,
            # UP pre-check reads INFO; the post-check is verified separately.
            patch.object(
                async_migrate, "repo_query", new=AsyncMock(return_value={"fields": {}})
            ),
            patch.object(
                async_migrate, "verify_migration_schema", new=AsyncMock()
            ),
            patch.object(
                async_migrate, "record_migration_version", new=AsyncMock()
            ) as record_v,
            patch.object(
                async_migrate, "remove_migration_version", new=AsyncMock()
            ) as remove_v,
        ):
            conn_cm.return_value.__aenter__ = AsyncMock(
                return_value=AsyncMock(query_raw=AsyncMock(
                    return_value={"result": [{"status": "OK", "result": None}]}
                ))
            )
            conn_cm.return_value.__aexit__ = AsyncMock(return_value=False)
            await migration.run(bump=True)
            record_v.assert_awaited_once_with(24)
            await migration.run(bump=False)
            remove_v.assert_awaited_once_with(24)

    @pytest.mark.asyncio
    async def test_migration_run_propagates_statement_errors(self):
        """A per-statement ERR in query_raw fails the migration."""
        migration = async_migrate.AsyncMigration("THROW 'x';", version=24)
        conn = AsyncMock(
            query_raw=AsyncMock(
                return_value={
                    "result": [
                        {"status": "ERR", "result": "An error occurred: x"}
                    ]
                }
            )
        )
        with (
            patch.object(async_migrate, "db_connection") as conn_cm,
            # UP pre-check passes (no pre-existing definitions), then the
            # statement error itself must fail the migration.
            patch.object(
                async_migrate, "repo_query", new=AsyncMock(return_value={"fields": {}})
            ),
            patch.object(
                async_migrate, "record_migration_version", new=AsyncMock()
            ) as record_v,
        ):
            conn_cm.return_value.__aenter__ = AsyncMock(return_value=conn)
            conn_cm.return_value.__aexit__ = AsyncMock(return_value=False)
            with pytest.raises(async_migrate.MigrationLedgerError, match="statement failed"):
                await migration.run(bump=True)
        record_v.assert_not_awaited()


class TestSchemaVerification:
    """The ledger saying 24 is not enough: startup verifies the schema."""

    @pytest.mark.asyncio
    async def test_run_migration_up_verifies_schema_at_latest_version(self):
        with (
            patch.object(
                async_migrate,
                "get_latest_version",
                new=AsyncMock(return_value=24),
            ),
            patch.object(
                async_migrate, "verify_migration_schema", new=AsyncMock()
            ) as verify,
        ):
            manager = async_migrate.AsyncMigrationManager(verify_schema=verify)
            await manager.run_migration_up()
        verify.assert_awaited_once_with(24)

    @pytest.mark.asyncio
    async def test_run_migration_up_verifies_after_running_pending(self):
        with (
            patch.object(
                async_migrate,
                "get_latest_version",
                new=AsyncMock(return_value=23),
            ),
            patch.object(async_migrate, "verify_migration_schema", new=AsyncMock()) as verify,
            patch.object(async_migrate.AsyncMigration, "run", new=AsyncMock()) as run,
        ):
            manager = async_migrate.AsyncMigrationManager(verify_schema=verify)
            await manager.run_migration_up()
        verify.assert_awaited_once_with(24)
        assert run.await_count >= 1

    @pytest.mark.asyncio
    async def test_run_migration_up_heals_missing_schema_then_verifies(self):
        """Verify failure → idempotent up-SQL re-run → verify again."""
        verify = AsyncMock(
            side_effect=[
                async_migrate.MigrationSchemaError("field not defined"),
                None,  # healed
            ]
        )
        with (
            patch.object(
                async_migrate,
                "get_latest_version",
                new=AsyncMock(return_value=24),
            ),
            patch.object(async_migrate, "verify_migration_schema", verify),
            patch.object(
                async_migrate.AsyncMigration, "run", new=AsyncMock()
            ) as run,
        ):
            manager = async_migrate.AsyncMigrationManager(verify_schema=verify)
            await manager.run_migration_up()
        assert run.await_count == 1  # the heal re-run of migration 24
        assert verify.await_count == 2

    @pytest.mark.asyncio
    async def test_run_migration_up_fails_when_heal_does_not_converge(self):
        """Persistent mismatch after heal re-run must fail startup."""
        verify = AsyncMock(
            side_effect=async_migrate.MigrationSchemaError("incompatible")
        )
        with (
            patch.object(
                async_migrate,
                "get_latest_version",
                new=AsyncMock(return_value=24),
            ),
            patch.object(async_migrate, "verify_migration_schema", verify),
            patch.object(
                async_migrate.AsyncMigration, "run", new=AsyncMock()
            ) as run,
        ):
            manager = async_migrate.AsyncMigrationManager(verify_schema=verify)
            with pytest.raises(async_migrate.MigrationSchemaError, match="incompatible"):
                await manager.run_migration_up()
        assert run.await_count == 1

    @pytest.mark.asyncio
    async def test_verify_accepts_matching_definitions(self):
        info = {
            "fields": {
                "rdlens_document_id": (
                    "DEFINE FIELD rdlens_document_id ON source "
                    "TYPE option<string> PERMISSIONS FULL"
                ),
                "rdlens_document_version": (
                    "DEFINE FIELD rdlens_document_version ON source "
                    "TYPE option<string> PERMISSIONS FULL"
                ),
                "rdlens_content_hash": (
                    "DEFINE FIELD rdlens_content_hash ON source "
                    "TYPE option<string> PERMISSIONS FULL"
                ),
            }
        }
        with patch.object(async_migrate, "repo_query", new=AsyncMock(return_value=info)):
            await async_migrate.verify_migration_schema(24)

    @pytest.mark.asyncio
    async def test_verify_fails_on_missing_definition(self):
        info: dict = {"fields": {}}
        with patch.object(async_migrate, "repo_query", new=AsyncMock(return_value=info)):
            with pytest.raises(async_migrate.MigrationSchemaError, match="not defined"):
                await async_migrate.verify_migration_schema(24)

    @pytest.mark.asyncio
    async def test_verify_fails_on_incompatible_type(self):
        info = {
            "fields": {
                "rdlens_document_id": (
                    "DEFINE FIELD rdlens_document_id ON source "
                    "TYPE option<int> PERMISSIONS FULL"
                ),
            }
        }
        with patch.object(async_migrate, "repo_query", new=AsyncMock(return_value=info)):
            with pytest.raises(async_migrate.MigrationSchemaError, match="incompatible"):
                await async_migrate.verify_migration_schema(24)

    @pytest.mark.asyncio
    async def test_verify_wraps_query_failure(self):
        with patch.object(
            async_migrate,
            "repo_query",
            new=AsyncMock(side_effect=RuntimeError("connection refused")),
        ):
            with pytest.raises(async_migrate.MigrationSchemaError, match="INFO FOR TABLE"):
                await async_migrate.verify_migration_schema(24)

    def _info_with_clause(self, clause: str) -> dict:
        """Full three-field INFO shape with `clause` injected on one field."""
        defs = {
            name: (
                f"DEFINE FIELD {name} ON source TYPE option<string> "
                "PERMISSIONS FULL"
            )
            for name in EXPECTED_FIELDS
        }
        target = EXPECTED_FIELDS[0]
        # Insert the clause right after the type, keeping the def-string valid.
        defs[target] = (
            f"DEFINE FIELD {target} ON source TYPE option<string> {clause} "
            "PERMISSIONS FULL"
        )
        return {"fields": defs}

    @pytest.mark.asyncio
    async def test_verify_rejects_value_clause(self):
        """A pre-existing VALUE NONE definition would overwrite every identity
        write back to NONE even after a successful IF NOT EXISTS (H3)."""
        with patch.object(
            async_migrate, "repo_query", new=AsyncMock(return_value=self._info_with_clause("VALUE NONE"))
        ):
            with pytest.raises(async_migrate.MigrationSchemaError, match="VALUE"):
                await async_migrate.verify_migration_schema(24)

    @pytest.mark.asyncio
    async def test_verify_rejects_default_clause(self):
        with patch.object(
            async_migrate, "repo_query", new=AsyncMock(return_value=self._info_with_clause("DEFAULT ''"))
        ):
            with pytest.raises(async_migrate.MigrationSchemaError, match="DEFAULT"):
                await async_migrate.verify_migration_schema(24)

    @pytest.mark.asyncio
    async def test_verify_rejects_extra_assert_clause(self):
        with patch.object(
            async_migrate, "repo_query", new=AsyncMock(return_value=self._info_with_clause("ASSERT $value != NONE"))
        ):
            with pytest.raises(async_migrate.MigrationSchemaError, match="ASSERT"):
                await async_migrate.verify_migration_schema(24)

    @pytest.mark.asyncio
    async def test_verify_rejects_readonly_clause(self):
        with patch.object(
            async_migrate, "repo_query", new=AsyncMock(return_value=self._info_with_clause("READONLY"))
        ):
            with pytest.raises(async_migrate.MigrationSchemaError, match="READONLY"):
                await async_migrate.verify_migration_schema(24)

    @pytest.mark.asyncio
    async def test_up_precheck_stops_before_ddl_and_ledger(self):
        """An incompatible pre-existing definition aborts migration.run BEFORE
        any DDL and before the ledger records the version (H3)."""
        incompatible_info = {
            "fields": {
                "rdlens_document_id": (
                    "DEFINE FIELD rdlens_document_id ON source "
                    "TYPE option<string> VALUE NONE"
                ),
            }
        }
        migration = async_migrate.AsyncMigration(_up_sql(), version=24)
        with (
            patch.object(
                async_migrate, "repo_query", new=AsyncMock(return_value=incompatible_info)
            ),
            patch.object(async_migrate, "db_connection") as conn_cm,
            patch.object(
                async_migrate, "record_migration_version", new=AsyncMock()
            ) as record_v,
        ):
            with pytest.raises(async_migrate.MigrationSchemaError, match="VALUE"):
                await migration.run(bump=True)
        conn_cm.assert_not_called()  # no DDL executed
        record_v.assert_not_awaited()  # ledger untouched

    @pytest.mark.asyncio
    async def test_up_precheck_allows_missing_definitions(self):
        """Fresh database: no pre-existing definitions -> UP proceeds."""
        migration = async_migrate.AsyncMigration(_up_sql(), version=24)
        conn = AsyncMock(
            query_raw=AsyncMock(
                return_value={"result": [{"status": "OK", "result": None}]}
            )
        )
        with (
            patch.object(
                async_migrate,
                "repo_query",
                new=AsyncMock(return_value={"fields": {}}),
            ),
            patch.object(async_migrate, "db_connection") as conn_cm,
            patch.object(
                async_migrate, "verify_migration_schema", new=AsyncMock()
            ) as verify,
            patch.object(
                async_migrate, "record_migration_version", new=AsyncMock()
            ),
        ):
            conn_cm.return_value.__aenter__ = AsyncMock(return_value=conn)
            conn_cm.return_value.__aexit__ = AsyncMock(return_value=False)
            await migration.run(bump=True)
        conn.query_raw.assert_awaited_once()  # DDL ran
        verify.assert_awaited_once_with(24)  # post-check before ledger

    @pytest.mark.asyncio
    async def test_up_records_ledger_only_after_schema_verify(self):
        """verify_migration_schema runs BEFORE record_migration_version: a
        failing post-check keeps the ledger clean (H3)."""
        migration = async_migrate.AsyncMigration(_up_sql(), version=24)
        conn = AsyncMock(
            query_raw=AsyncMock(
                return_value={"result": [{"status": "OK", "result": None}]}
            )
        )
        with (
            patch.object(
                async_migrate,
                "repo_query",
                new=AsyncMock(return_value={"fields": {}}),
            ),
            patch.object(async_migrate, "db_connection") as conn_cm,
            patch.object(
                async_migrate,
                "verify_migration_schema",
                new=AsyncMock(
                    side_effect=async_migrate.MigrationSchemaError("missing")
                ),
            ),
            patch.object(
                async_migrate, "record_migration_version", new=AsyncMock()
            ) as record_v,
        ):
            conn_cm.return_value.__aenter__ = AsyncMock(return_value=conn)
            conn_cm.return_value.__aexit__ = AsyncMock(return_value=False)
            with pytest.raises(async_migrate.MigrationSchemaError):
                await migration.run(bump=True)
        record_v.assert_not_awaited()


class TestLedgerVersionReading:
    """Ledger read failures and malformed rows propagate - never collapse to
    version 0 (H2)."""

    @pytest.mark.asyncio
    async def test_get_all_versions_propagates_query_failure(self):
        with patch.object(
            async_migrate,
            "repo_query",
            new=AsyncMock(side_effect=RuntimeError("connection refused")),
        ):
            with pytest.raises(RuntimeError, match="connection refused"):
                await async_migrate.get_all_versions()

    @pytest.mark.asyncio
    async def test_get_latest_version_propagates_query_failure(self):
        with patch.object(
            async_migrate,
            "repo_query",
            new=AsyncMock(side_effect=RuntimeError("permission denied")),
        ):
            with pytest.raises(RuntimeError, match="permission denied"):
                await async_migrate.get_latest_version()

    @pytest.mark.asyncio
    async def test_get_all_versions_empty_result_is_version_zero(self):
        """Fresh database: a SUCCESSFUL read of a missing/empty ledger is 0."""
        with patch.object(async_migrate, "repo_query", new=AsyncMock(return_value=[])):
            assert await async_migrate.get_latest_version() == 0

    @pytest.mark.asyncio
    async def test_get_latest_version_rejects_non_int_version(self):
        with patch.object(
            async_migrate,
            "repo_query",
            new=AsyncMock(return_value=[{"id": "_sbl_migrations:1", "version": "24"}]),
        ):
            with pytest.raises(async_migrate.MigrationLedgerError, match="Malformed"):
                await async_migrate.get_latest_version()

    @pytest.mark.asyncio
    async def test_get_latest_version_rejects_missing_version_field(self):
        with patch.object(
            async_migrate,
            "repo_query",
            new=AsyncMock(return_value=[{"id": "_sbl_migrations:1"}]),
        ):
            with pytest.raises(async_migrate.MigrationLedgerError, match="Malformed"):
                await async_migrate.get_latest_version()

    @pytest.mark.asyncio
    async def test_get_latest_version_rejects_bool_version(self):
        """bool is an int subclass but is never a legitimate version."""
        with patch.object(
            async_migrate,
            "repo_query",
            new=AsyncMock(return_value=[{"id": "_sbl_migrations:1", "version": True}]),
        ):
            with pytest.raises(async_migrate.MigrationLedgerError, match="Malformed"):
                await async_migrate.get_latest_version()

    @pytest.mark.asyncio
    async def test_get_latest_version_accepts_valid_rows(self):
        rows = [
            {"id": "_sbl_migrations:1", "version": 1},
            {"id": "_sbl_migrations:24", "version": 24},
        ]
        with patch.object(async_migrate, "repo_query", new=AsyncMock(return_value=rows)):
            assert await async_migrate.get_latest_version() == 24


class TestDownCompletionVerification:
    """DOWN 24 must triple-verify completion: fields gone, record gone,
    latest == N-1 (M5)."""

    def _patch_runner_env(self, fields: dict, ledger_rows: list):
        return (
            patch.object(
                async_migrate, "repo_query", new=AsyncMock(return_value=ledger_rows)
            ),
        )  # fields override comes from the per-test patch below

    @pytest.mark.asyncio
    async def test_down_fails_when_field_definition_survives(self):
        """A surviving identity definition must fail the DOWN even though the
        ledger record was deleted."""
        migration = async_migrate.AsyncMigration(_down_sql(), version=24)
        runner = async_migrate.AsyncMigrationRunner(
            up_migrations=[], down_migrations=[migration],
        )
        info_with_field = {"fields": {"rdlens_document_id": "DEFINE FIELD ..."}}
        with (
            patch.object(
                async_migrate, "get_latest_version", new=AsyncMock(return_value=24)
            ),
            patch.object(async_migrate.AsyncMigration, "run", new=AsyncMock()),
            patch.object(
                async_migrate, "repo_query", new=AsyncMock(return_value=info_with_field)
            ),
        ):
            with pytest.raises(async_migrate.MigrationSchemaError, match="still defined"):
                await runner.run_one_down(target_version=24)

    @pytest.mark.asyncio
    async def test_down_fails_when_ledger_record_survives(self):
        migration = async_migrate.AsyncMigration(_down_sql(), version=24)
        runner = async_migrate.AsyncMigrationRunner(
            up_migrations=[], down_migrations=[migration],
        )
        # Post-verify reads: INFO (fields gone), ledger (record 24 still there).
        ledger_rows = [
            {"id": "_sbl_migrations:23", "version": 23},
            {"id": "_sbl_migrations:24", "version": 24},
        ]
        with (
            patch.object(
                async_migrate, "get_latest_version", new=AsyncMock(return_value=24)
            ),
            patch.object(async_migrate.AsyncMigration, "run", new=AsyncMock()),
            patch.object(
                async_migrate,
                "repo_query",
                new=AsyncMock(side_effect=[{"fields": {}}, ledger_rows]),
            ),
        ):
            with pytest.raises(async_migrate.MigrationLedgerError, match="still present"):
                await runner.run_one_down(target_version=24)

    @pytest.mark.asyncio
    async def test_down_fails_when_latest_is_not_n_minus_1(self):
        migration = async_migrate.AsyncMigration(_down_sql(), version=24)
        runner = async_migrate.AsyncMigrationRunner(
            up_migrations=[], down_migrations=[migration],
        )
        # Post-verify reads: INFO (fields gone), ledger (latest 22, not 23).
        ledger_rows = [{"id": "_sbl_migrations:22", "version": 22}]
        with (
            patch.object(
                async_migrate, "get_latest_version", new=AsyncMock(return_value=24)
            ),
            patch.object(async_migrate.AsyncMigration, "run", new=AsyncMock()),
            patch.object(
                async_migrate,
                "repo_query",
                new=AsyncMock(side_effect=[{"fields": {}}, ledger_rows]),
            ),
        ):
            with pytest.raises(async_migrate.MigrationLedgerError, match="expected 23"):
                await runner.run_one_down(target_version=24)

    @pytest.mark.asyncio
    async def test_down_succeeds_when_all_three_conditions_hold(self):
        migration = async_migrate.AsyncMigration(_down_sql(), version=24)
        runner = async_migrate.AsyncMigrationRunner(
            up_migrations=[], down_migrations=[migration],
        )
        # Post-verify sees: no fields, ledger only 23 (INFO fields absent and
        # ledger read both flow through repo_query - first call INFO, second
        # the ledger SELECT).
        info_rows = {"fields": {"title": "DEFINE FIELD title ON source TYPE string"}}
        ledger_rows = [{"id": "_sbl_migrations:23", "version": 23}]
        with (
            patch.object(
                async_migrate, "get_latest_version", new=AsyncMock(return_value=24)
            ),
            patch.object(async_migrate.AsyncMigration, "run", new=AsyncMock()) as run,
            patch.object(
                async_migrate,
                "repo_query",
                new=AsyncMock(side_effect=[info_rows, ledger_rows]),
            ),
        ):
            await runner.run_one_down(target_version=24)
        run.assert_awaited_once_with(bump=False)

    @pytest.mark.asyncio
    async def test_down_retry_idempotent_at_n_minus_1(self):
        """Second DOWN at ledger 23: same triple-verify, still succeeds."""
        migration = async_migrate.AsyncMigration(_down_sql(), version=24)
        runner = async_migrate.AsyncMigrationRunner(
            up_migrations=[], down_migrations=[migration],
        )
        info_rows = {"fields": {"title": "DEFINE FIELD title ON source TYPE string"}}
        ledger_rows = [{"id": "_sbl_migrations:23", "version": 23}]
        # Each DOWN triple-verifies: INFO + ledger read, twice.
        with (
            patch.object(
                async_migrate, "get_latest_version", new=AsyncMock(return_value=23)
            ),
            patch.object(async_migrate.AsyncMigration, "run", new=AsyncMock()),
            patch.object(
                async_migrate,
                "repo_query",
                new=AsyncMock(
                    side_effect=[info_rows, ledger_rows, info_rows, ledger_rows]
                ),
            ),
        ):
            await runner.run_one_down(target_version=24)
            await runner.run_one_down(target_version=24)

    @pytest.mark.asyncio
    async def test_down_triple_verify_scoped_to_migration_24(self):
        """Other fixed targets skip the migration-24-specific verification."""
        migration_23 = async_migrate.AsyncMigration("REMOVE FIELD x;", version=23)
        runner = async_migrate.AsyncMigrationRunner(
            up_migrations=[], down_migrations=[migration_23],
        )
        with (
            patch.object(
                async_migrate, "get_latest_version", new=AsyncMock(return_value=23)
            ),
            patch.object(async_migrate.AsyncMigration, "run", new=AsyncMock()) as run,
            patch.object(
                async_migrate, "repo_query", new=AsyncMock(return_value={"fields": {}})
            ) as repo_q,
        ):
            await runner.run_one_down(target_version=23)
        run.assert_awaited_once_with(bump=False)
        repo_q.assert_not_awaited()  # no post-verify query for non-24 targets


class TestRecordMigrationVersion:
    """Fixed-version ledger writes preserve timestamps and are idempotent."""

    @pytest.mark.asyncio
    async def test_record_migration_version_upserts_fixed_record(self):
        with patch.object(
            async_migrate, "repo_query", new=AsyncMock(return_value=[])
        ) as repo_q:
            await async_migrate.record_migration_version(24)
        assert repo_q.await_args is not None
        sql = repo_q.await_args.args[0]
        assert "UPSERT" in sql
        assert repo_q.await_args.args[1] == {"version": 24}
        # Timestamp fill only when missing: re-running keeps applied_at.
        assert "WHERE applied_at IS NONE" in sql

    @pytest.mark.asyncio
    async def test_remove_migration_version_deletes_exact_record(self):
        with patch.object(
            async_migrate, "repo_query", new=AsyncMock(return_value=[])
        ) as repo_q:
            await async_migrate.remove_migration_version(24)
        assert repo_q.await_args is not None
        assert repo_q.await_args.args[1] == {"version": 24}
