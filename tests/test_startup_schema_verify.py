"""Issue #613：启动时必须校验最新迁移的 schema。

背景：校验代码原先只写在 ``run_migration_up()`` 末尾，而 API 启动路径只在
``needs_migration()`` 为真时才调用该函数 ⇒「账本已最新但 schema 缺失」
（字段被手工删除、或迁移被回滚后账本行残留）会被静默跳过：应用照常启动，
``SCHEMAFULL`` 再次静默丢弃身份字段写入（issue #66 的「写-丢闭环」）。
"""

from unittest.mock import AsyncMock

import pytest

from open_notebook.database.async_migrate import (
    AsyncMigrationManager,
    MigrationSchemaError,
)


class _FakeMigration:
    def __init__(self, version: int = 24):
        self.version = version
        self.run = AsyncMock()


def _manager_with_fake_latest(verify):
    manager = AsyncMigrationManager(verify_schema=verify)
    fake = _FakeMigration()
    manager.up_migrations = [*manager.up_migrations[:-1], fake]
    return manager, fake


@pytest.mark.asyncio
async def test_heals_missing_schema_by_replaying_latest_migration():
    """缺定义 ⇒ 幂等重放最新迁移的 up-SQL，然后复验通过（不抛错）。"""
    calls = []

    async def verify(version: int) -> None:
        calls.append(version)
        if len(calls) == 1:
            raise MigrationSchemaError("rdlens_content_hash missing")

    manager, fake = _manager_with_fake_latest(verify)

    await manager.verify_latest_schema()

    fake.run.assert_awaited_once_with(bump=True)
    assert calls == [24, 24]


@pytest.mark.asyncio
async def test_persistent_mismatch_fails_loudly():
    """自愈后仍不匹配 ⇒ 抛 MigrationSchemaError（启动失败，而非静默运行）。"""

    async def verify(version: int) -> None:
        raise MigrationSchemaError("incompatible rdlens_* definition")

    manager, fake = _manager_with_fake_latest(verify)

    with pytest.raises(MigrationSchemaError):
        await manager.verify_latest_schema()

    fake.run.assert_awaited_once_with(bump=True)


@pytest.mark.asyncio
async def test_no_verify_callable_is_a_noop():
    manager, fake = _manager_with_fake_latest(None)
    manager.verify_schema = None

    await manager.verify_latest_schema()

    fake.run.assert_not_awaited()
