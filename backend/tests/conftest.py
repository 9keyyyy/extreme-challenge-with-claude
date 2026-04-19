from collections.abc import AsyncGenerator

import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from src.config import settings
from src.database import get_db
from src.main import app
from src.models import Base

TEST_DATABASE_URL = settings.database_url.replace(
    "/extreme_board", "/extreme_board_test"
)

engine = create_async_engine(TEST_DATABASE_URL, pool_size=5, max_overflow=0)


@pytest_asyncio.fixture(scope="session", autouse=True)
async def setup_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


@pytest_asyncio.fixture
async def db() -> AsyncGenerator[AsyncSession, None]:
    """SAVEPOINT rollback으로 테스트 데이터 격리.
    API의 commit()이 SAVEPOINT release로 변환되고,
    이벤트 리스너가 새 SAVEPOINT를 자동 생성함.
    테스트 끝나면 바깥 트랜잭션 rollback으로 전부 취소.
    """
    async with engine.connect() as conn:
        tx = await conn.begin()
        await conn.begin_nested()

        session = AsyncSession(bind=conn, expire_on_commit=False)

        @event.listens_for(session.sync_session, "after_transaction_end")
        def restart_savepoint(sess, transaction):
            if conn.sync_connection.in_nested_transaction():
                conn.sync_connection.begin_nested()

        yield session

        await session.close()
        await tx.rollback()


@pytest_asyncio.fixture
async def client(db: AsyncSession) -> AsyncGenerator[AsyncClient, None]:
    async def override_get_db():
        yield db

    app.dependency_overrides[get_db] = override_get_db

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c

    app.dependency_overrides.pop(get_db, None)


@pytest_asyncio.fixture
async def post(client) -> dict:
    resp = await client.post(
        "/api/v1/posts",
        json={"title": "Test Post", "content": "Test Content", "author": "tester"},
    )
    return resp.json()
