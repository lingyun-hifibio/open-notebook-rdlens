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
        with (
            patch.object(
                async_migrate, "get_latest_version", new=AsyncMock(return_value=23)
            ),
            patch.object(async_migrate.AsyncMigration, "run", new=AsyncMock()) as run,
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
        with (
            patch.object(
                async_migrate, "get_latest_version", new=AsyncMock(return_value=23)
            ),
            patch.object(async_migrate.AsyncMigration, "run", new=AsyncMock()) as run,
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
