"""Tests for API startup migration retry behavior."""

from unittest.mock import AsyncMock

import pytest

from api import main as api_main


class FakeMigrationManager:
    def __init__(
        self,
        ping_side_effect=None,
        current_versions=None,
        needs_migration=True,
        migration_side_effect=None,
    ):
        self.ping = AsyncMock(side_effect=ping_side_effect)
        self.get_current_version = AsyncMock(side_effect=current_versions or [14])
        self.needs_migration = AsyncMock(return_value=needs_migration)
        self.run_migration_up = AsyncMock(side_effect=migration_side_effect)
        #: #613：账本已是最新时也必须校验最新迁移的 schema（死代码修正后新增）
        self.verify_latest_schema = AsyncMock()


@pytest.fixture
def no_retry_delay(monkeypatch):
    sleep = AsyncMock()
    monkeypatch.setattr(api_main, "DATABASE_STARTUP_RETRY_ATTEMPTS", 3)
    monkeypatch.setattr(api_main, "DATABASE_STARTUP_RETRY_INITIAL_DELAY_SECONDS", 0)
    monkeypatch.setattr(api_main, "DATABASE_STARTUP_RETRY_MAX_DELAY_SECONDS", 0)
    monkeypatch.setattr(api_main.asyncio, "sleep", sleep)
    return sleep


@pytest.mark.asyncio
async def test_database_reachable_on_first_probe_runs_migrations_once(
    monkeypatch, no_retry_delay
):
    manager = FakeMigrationManager(
        ping_side_effect=[None],
        current_versions=[13, 14],
        needs_migration=True,
    )
    monkeypatch.setattr(api_main, "AsyncMigrationManager", lambda: manager)

    await api_main._run_database_migrations()

    manager.ping.assert_awaited_once()
    manager.run_migration_up.assert_awaited_once()
    assert manager.get_current_version.await_count == 2
    no_retry_delay.assert_not_awaited()


@pytest.mark.asyncio
async def test_startup_verifies_schema_when_ledger_already_latest(
    monkeypatch, no_retry_delay
):
    """#613：账本已是最新时也必须校验 schema（此前校验被 needs_migration 门控跳过）。"""
    manager = FakeMigrationManager(
        ping_side_effect=[None],
        current_versions=[24],
        needs_migration=False,
    )
    monkeypatch.setattr(api_main, "AsyncMigrationManager", lambda: manager)

    await api_main._run_database_migrations()

    manager.run_migration_up.assert_not_awaited()
    manager.verify_latest_schema.assert_awaited_once()


@pytest.mark.asyncio
async def test_schema_verification_fails_fast_without_retry(
    monkeypatch, no_retry_delay
):
    """#613 复审 MED-1/LOW-1：自愈后仍不匹配 ⇒ 立刻失败，**不**重试。

    （此前把 else 分支的调用包进 try/except 吞掉异常，全部用例仍绿——
    本用例让该契约可证伪。）
    """
    from open_notebook.database.async_migrate import MigrationSchemaError

    manager = FakeMigrationManager(
        ping_side_effect=[None], current_versions=[24], needs_migration=False,
    )
    manager.verify_latest_schema = AsyncMock(
        side_effect=MigrationSchemaError("rdlens_content_hash missing"),
    )
    monkeypatch.setattr(api_main, "AsyncMigrationManager", lambda: manager)

    with pytest.raises(MigrationSchemaError):
        await api_main._run_database_migrations()

    assert manager.verify_latest_schema.await_count == 1, "持久性错误不得重试"
    no_retry_delay.assert_not_awaited()


@pytest.mark.asyncio
async def test_schema_verification_retries_transient_errors(
    monkeypatch, no_retry_delay
):
    """#613 复审 MED-1：瞬时读故障走启动重试预算，不直接杀启动。"""
    manager = FakeMigrationManager(
        ping_side_effect=[None], current_versions=[24], needs_migration=False,
    )
    manager.verify_latest_schema = AsyncMock(
        side_effect=[OSError("connection reset"), None],
    )
    monkeypatch.setattr(api_main, "AsyncMigrationManager", lambda: manager)

    await api_main._run_database_migrations()

    assert manager.verify_latest_schema.await_count == 2
    no_retry_delay.assert_awaited_once()


@pytest.mark.asyncio
async def test_database_retry_succeeds_after_initial_probe_failures(
    monkeypatch, no_retry_delay
):
    temporary_error = OSError("Temporary failure in name resolution")
    manager = FakeMigrationManager(
        ping_side_effect=[temporary_error, temporary_error, None],
        current_versions=[13, 14],
        needs_migration=True,
    )
    monkeypatch.setattr(api_main, "AsyncMigrationManager", lambda: manager)

    await api_main._run_database_migrations()

    assert manager.ping.await_count == 3
    assert no_retry_delay.await_count == 2
    manager.run_migration_up.assert_awaited_once()


@pytest.mark.asyncio
async def test_lifespan_raises_after_database_retry_budget_exhausted(
    monkeypatch, no_retry_delay
):
    manager = FakeMigrationManager(
        ping_side_effect=OSError(-3, "Temporary failure in name resolution"),
    )
    monkeypatch.setattr(api_main, "AsyncMigrationManager", lambda: manager)

    with pytest.raises(RuntimeError, match="Failed to run database migrations"):
        # lifespan never touches its app argument, so None keeps the test
        # isolated from the real FastAPI app.
        async with api_main.lifespan(None):  # type: ignore[arg-type]
            pass

    assert manager.ping.await_count == 3
    assert no_retry_delay.await_count == 2
    manager.run_migration_up.assert_not_awaited()


@pytest.mark.asyncio
async def test_lifespan_does_not_retry_real_migration_errors(
    monkeypatch, no_retry_delay
):
    manager = FakeMigrationManager(
        ping_side_effect=[None],
        current_versions=[13],
        needs_migration=True,
        migration_side_effect=ValueError("bad migration"),
    )
    monkeypatch.setattr(api_main, "AsyncMigrationManager", lambda: manager)

    with pytest.raises(RuntimeError, match="Failed to run database migrations"):
        # lifespan never touches its app argument, so None keeps the test
        # isolated from the real FastAPI app.
        async with api_main.lifespan(None):  # type: ignore[arg-type]
            pass

    manager.ping.assert_awaited_once()
    no_retry_delay.assert_not_awaited()
    manager.run_migration_up.assert_awaited_once()
