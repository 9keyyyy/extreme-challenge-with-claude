import asyncio
from logging.config import fileConfig

import sqlalchemy as sa
from sqlalchemy import pool
from sqlalchemy.ext.asyncio import async_engine_from_config

from alembic import context
from alembic.operations import ops
from src.config import settings
from src.models import Base

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

config.set_main_option("sqlalchemy.url", settings.database_url)

target_metadata = Base.metadata


def include_object(object, name, type_, reflected, compare_to):
    """기존 테이블 변경 감지 시 FK 제약 무시.
    새 테이블 생성 시에는 호출되지 않아서 process_revision_directives가 보완함.
    """
    if type_ == "foreign_key_constraint":
        return False
    return True


def process_revision_directives(context, revision, directives):
    """autogenerate 결과에서 FK 제약 제거.
    include_object는 기존 테이블 비교에만 적용됨.
    새 테이블은 CreateTableOp.from_table()이 constraint를 통째로 복사해서
    include_object가 호출되지 않음 — 이 훅에서 후처리로 제거.
    """
    if not directives:
        return
    script = directives[0]
    if not script.upgrade_ops:
        return
    for op in script.upgrade_ops.ops:
        if isinstance(op, ops.CreateTableOp):
            op.columns = [
                c for c in op.columns
                if not isinstance(c, (sa.ForeignKeyConstraint,))
            ]


def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        include_object=include_object,
        process_revision_directives=process_revision_directives,
    )

    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection):
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        include_object=include_object,
        process_revision_directives=process_revision_directives,
    )

    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)

    await connectable.dispose()


def run_migrations_online() -> None:
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
