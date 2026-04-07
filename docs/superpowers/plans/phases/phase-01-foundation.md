# Phase 1: Foundation — 프로젝트 셋업 + 순수 CRUD

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans

**학습 키워드**
`ASGI vs WSGI` `async/await` `이벤트 루프` `Connection Pool` `ORM vs Raw SQL` `Pydantic Validation` `Optimistic Locking` `UNIQUE Constraint` `UUID vs Auto-increment` `Docker Compose` `Alembic Migration`

---

## 학습: 왜 이 기술 스택인가?

### FastAPI — 왜 FastAPI인가?

**핵심 질문: "왜 Django가 아니라 FastAPI를 썼나요?"**

극한 트래픽 처리에서 가장 중요한 건 **I/O 대기 시간을 낭비하지 않는 것**. 웹 서버가 하는 일의 대부분은 DB 응답 기다리기, Redis 응답 기다리기, 외부 API 응답 기다리기임. 이 "기다리는 시간"에 다른 요청을 처리할 수 있느냐가 성능을 결정함.

| 기준 | FastAPI | Django REST | Flask | Express (Node) |
|------|---------|-------------|-------|----------------|
| 비동기 지원 | 네이티브 async/await | 3.1+ 부분 지원 | 별도 확장 필요 | 네이티브 |
| 성능 (RPS) | ~15,000 (uvicorn) | ~3,000 | ~5,000 | ~20,000 |
| 타입 검증 | Pydantic 자동 | Serializer 수동 | 수동 | 없음 (TS 별도) |
| API 문서 | Swagger/ReDoc 자동 | DRF browsable API | 수동 | 수동 |
| 학습 곡선 | 낮음 | 높음 (ORM, admin 등) | 낮음 | 낮음 |

Django는 admin, auth, ORM 등 풀스택 기능이 강점이지만, 이 프로젝트는 API 서버만 필요하고 비동기가 핵심이라 오히려 오버헤드가 됨. Flask는 가볍지만 비동기가 네이티브가 아니라 gevent/eventlet 같은 monkey-patching이 필요하고, 이건 디버깅이 악몽임.

**핵심 개념 — ASGI와 async/await가 성능에 미치는 영향:**

```python
# WSGI (동기): 한 번에 하나씩 처리
def get_post(id):
    post = db.query(id)      # DB 응답 기다리는 동안 이 스레드는 아무것도 못 함
    return post

# ASGI (비동기): 기다리는 동안 다른 요청 처리
async def get_post(id):
    post = await db.query(id)  # DB 기다리는 동안 다른 요청 처리 가능
    return post
```

동기 서버가 1000명을 동시에 처리하려면 1000개의 스레드가 필요함. 스레드 1개당 ~1MB 메모리니까 1000개 = 1GB. 이게 10만이 되면? 불가능함.

비동기 서버는 이벤트 루프 1개로 수천 개의 동시 요청을 처리함. DB 응답을 기다리는 동안 다른 요청의 코드를 실행하는 구조. 스레드 전환 오버헤드도 없음.

**프로덕션에서의 차이:**
- WSGI(gunicorn) 워커 4개 = 동시 4개 요청 처리 (나머지는 큐에서 대기)
- ASGI(uvicorn) 워커 4개 = 동시 수천 개 요청 처리 (I/O 대기 시간 활용)

### SQLAlchemy 2.0 (async) — 왜 SQLAlchemy인가?

**핵심 질문: "ORM을 쓰면 성능이 떨어지지 않나요?"**

맞는 말이긴 한데, 정확히는 "ORM의 추상화 레벨이 높을수록 생성되는 SQL을 제어하기 어려워진다"가 정확한 표현임. SQLAlchemy 2.0은 이 문제를 해결하는 독특한 위치에 있음.

| 기준 | SQLAlchemy 2.0 | Django ORM | Tortoise ORM | 직접 SQL (asyncpg) |
|------|---------------|------------|--------------|-------------------|
| 비동기 | 네이티브 async | 불완전 | 네이티브 | 네이티브 |
| 기능 완성도 | 최고 (20년+ 역사) | 높음 (Django 내장) | 중간 | 최소 (직접 작성) |
| 마이그레이션 | Alembic | Django migrations | Aerich | 직접 관리 |
| 성능 제어 | 세밀한 쿼리 제어 | 추상화 높음 | 중간 | 최고 (raw SQL) |

SQLAlchemy는 "Core"와 "ORM" 두 레이어로 나뉨. Core는 SQL 빌더에 가까워서 생성되는 SQL을 정확히 제어 가능하고, ORM은 편의 기능을 제공함. 극한 상황에서 ORM이 생성하는 쿼리가 비효율적이면 Core 레벨로 내려가서 직접 최적화할 수 있음. Django ORM은 이런 유연성이 부족함.

asyncpg를 직접 쓰면 성능은 최고지만, 마이그레이션 관리, 모델 정의, 쿼리 빌딩을 전부 수동으로 해야 함. 생산성과 성능 사이의 최적 지점이 SQLAlchemy 2.0임.

### Connection Pool — 왜 커넥션을 미리 만들어두는가?

**핵심 질문: "Connection Pool이 뭐고 왜 필요한가요?"**

DB 연결 1번 = TCP handshake + TLS 협상 + 인증 = ~50ms. 매 요청마다 연결/해제하면 API 응답 시간에 50ms가 추가됨. 1000 RPS면 초당 1000번 연결/해제 = DB 서버에 연결 관리 부하만으로 과부하.

Connection Pool은 연결을 미리 만들어두고 재사용하는 것. `pool_size=5`면 항상 5개 연결을 유지하고, 요청이 오면 풀에서 꺼내 쓰고 반환함.

```
pool_size=5     → 항상 5개 연결 유지
max_overflow=10 → 부하 시 최대 15개까지 확장
→ 16번째 동시 요청은 대기 (이게 나중에 병목이 됨!)
```

**안 쓰면 뭐가 터지나:** RDS의 max_connections 기본값은 ~100. 서버 3대 × 요청당 연결 = 순식간에 "too many connections" 에러. Pool이 이걸 방지함.

### Docker Compose — 왜 Docker인가?

로컬에서 PostgreSQL + Redis + MinIO + 모니터링을 `docker compose up` 한 줄로 띄울 수 있음. "내 컴퓨터에서는 되는데..." 문제를 원천 차단하고, 개발 환경과 프로덕션 환경의 차이를 최소화함. 클라우드 배포 시에도 같은 컨테이너 이미지를 그대로 사용.

### 심화 학습

| 키워드 | 왜 알아야 하는지 |
|--------|----------------|
| **ASGI vs WSGI** | WSGI는 요청-응답 사이클이 동기적. ASGI는 비동기 + WebSocket 지원. FastAPI가 빠른 근본적 이유 |
| **uvicorn vs gunicorn** | 프로덕션에서는 gunicorn이 uvicorn 워커를 관리하는 구조 (`gunicorn -k uvicorn.workers.UvicornWorker`). 이유: gunicorn이 프로세스 관리(재시작, 헬스체크)에 강함 |
| **UUID vs Auto-increment PK** | Auto-increment는 DB 1대에서만 유일성 보장. 서버 여러 대에서 동시 INSERT하면 충돌 위험. UUID는 어디서든 생성해도 충돌 확률이 사실상 0이지만, 랜덤 UUID는 B-tree 인덱스에서 페이지 분할을 유발해서 INSERT 성능이 떨어짐. UUIDv7(시간 순서)이 대안 |
| **Pydantic v2** | Rust 기반 검증 엔진으로 v1 대비 5-50배 빠름. 극한 트래픽에서 요청 파싱/검증 비용이 무시 못 할 수준이 되면 이 차이가 체감됨 |
| **SQLAlchemy 2.0 스타일** | 1.x의 `session.query(Model).filter()` → 2.0의 `select(Model).where()`. 2.0 스타일이 async와 호환되고, 타입 힌트 지원이 나음 |

---

## 구현

### Task 1: 프로젝트 초기화 + Docker Compose

**Files:**
- Create: `pyproject.toml`
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `src/main.py`
- Create: `src/config.py`

- [ ] **Step 1: pyproject.toml 작성**

```toml
[project]
name = "extreme-board"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
    "fastapi>=0.115.0",
    "uvicorn[standard]>=0.30.0",
    "sqlalchemy[asyncio]>=2.0.0",
    "asyncpg>=0.30.0",
    "alembic>=1.14.0",
    "redis>=5.0.0",
    "pydantic-settings>=2.0.0",
    "boto3>=1.35.0",
    "httpx>=0.27.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0.0",
    "pytest-asyncio>=0.24.0",
    "pytest-httpx>=0.30.0",
]
```

- [ ] **Step 2: Dockerfile 작성**

```dockerfile
FROM python:3.12-slim

WORKDIR /app

COPY pyproject.toml .
RUN pip install -e ".[dev]"

COPY . .

CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
```

- [ ] **Step 3: docker-compose.yml 작성**

```yaml
services:
  app:
    build: .
    ports:
      - "8000:8000"
    volumes:
      - .:/app
    environment:
      - DATABASE_URL=postgresql+asyncpg://postgres:postgres@db:5432/extreme_board
      - REDIS_URL=redis://redis:6379/0
      - MINIO_ENDPOINT=minio:9000
      - MINIO_ACCESS_KEY=minioadmin
      - MINIO_SECRET_KEY=minioadmin
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy

  db:
    image: postgres:16
    environment:
      POSTGRES_DB: extreme_board
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5

  minio:
    image: minio/minio
    ports:
      - "9000:9000"
      - "9001:9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    command: server /data --console-address ":9001"
    volumes:
      - miniodata:/data

volumes:
  pgdata:
  miniodata:
```

- [ ] **Step 4: src/config.py 작성**

```python
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/extreme_board"
    redis_url: str = "redis://localhost:6379/0"
    minio_endpoint: str = "localhost:9000"
    minio_access_key: str = "minioadmin"
    minio_secret_key: str = "minioadmin"
    minio_bucket: str = "uploads"
    db_pool_size: int = 5
    db_max_overflow: int = 10


settings = Settings()
```

- [ ] **Step 5: src/main.py 작성**

```python
from fastapi import FastAPI

app = FastAPI(title="Extreme Board")


@app.get("/health")
async def health():
    return {"status": "ok"}
```

- [ ] **Step 6: 구동 확인**

Run: `docker compose up --build -d`
Run: `curl http://localhost:8000/health`
Expected: `{"status":"ok"}`

- [ ] **Step 7: Commit**

```bash
git add pyproject.toml Dockerfile docker-compose.yml src/main.py src/config.py
git commit -m "feat: project init with Docker Compose (PG, Redis, MinIO, FastAPI)"
```

---

### Task 2: Database 연결 + Post 모델 + Alembic

**Files:**
- Create: `src/database.py`
- Create: `src/models/post.py`
- Create: `alembic.ini`, `alembic/env.py`

**학습 — Connection Pool이란?**

DB 연결은 비쌈 (TCP handshake + TLS + 인증 = ~50ms). 매 요청마다 연결/해제하면 성능 낭비.
Pool: 미리 연결을 만들어두고 재사용하는 것.

```
pool_size=5    → 항상 5개 연결 유지
max_overflow=10 → 부하 시 최대 15개까지 확장
→ 16번째 요청은 대기 (이게 나중에 병목이 됨!)
```

- [ ] **Step 1: src/database.py 작성**

```python
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from src.config import settings

engine = create_async_engine(
    settings.database_url,
    pool_size=settings.db_pool_size,
    max_overflow=settings.db_max_overflow,
)

async_session = async_sessionmaker(engine, expire_on_commit=False)


async def get_db():
    async with async_session() as session:
        yield session
```

- [ ] **Step 2: Post 모델 작성**

```python
# src/models/post.py
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Post(Base):
    __tablename__ = "posts"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    author: Mapped[str] = mapped_column(String(100), nullable=False)
    view_count: Mapped[int] = mapped_column(Integer, default=0)
    like_count: Mapped[int] = mapped_column(Integer, default=0)
    version: Mapped[int] = mapped_column(Integer, default=1)  # 낙관적 락용
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
```

**학습 — version 컬럼의 역할:**
낙관적 락(Optimistic Locking)용. 수정 시 `WHERE version = 현재값`으로 확인. 다른 사람이 먼저 수정했으면 version이 달라져서 UPDATE 0 rows affected → 충돌 감지됨.

- [ ] **Step 3: Alembic 초기화 + 마이그레이션**

Run: `docker compose exec app alembic init alembic`

alembic/env.py에서 async 모드 + target_metadata 설정 후:

Run: `docker compose exec app alembic revision --autogenerate -m "create posts table"`
Run: `docker compose exec app alembic upgrade head`

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: database setup with Post model and Alembic migration"
```

---

### Task 3: Post CRUD API (최적화 없는 순수 버전)

**Files:**
- Create: `src/schemas/post.py`
- Create: `src/services/post_service.py`
- Create: `src/api/command/posts.py`
- Create: `src/api/query/posts.py`
- Create: `tests/conftest.py`
- Create: `tests/test_posts.py`
- Modify: `src/main.py`

**학습 — 의도적으로 "느린 방식"으로 만드는 이유:**

이 Phase에서는 일부러 최적화 안 함:
- **OFFSET 페이지네이션** 사용 (나중에 커서로 교체하며 차이 체감)
- **조회수를 DB 직접 UPDATE** (나중에 Redis INCR로 교체하며 차이 체감)
- **캐시 없음** (나중에 Redis 캐시 추가하며 차이 체감)

Phase 2에서 100만 데이터를 넣으면 이 "느린 방식"이 얼마나 문제인지 직접 보게 됨.

- [ ] **Step 1: Pydantic 스키마 작성**

```python
# src/schemas/post.py
import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class PostCreate(BaseModel):
    title: str = Field(max_length=200)
    content: str
    author: str = Field(max_length=100)


class PostUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    content: str | None = None
    version: int  # 낙관적 락 — 현재 버전 번호 필수


class PostResponse(BaseModel):
    id: uuid.UUID
    title: str
    content: str
    author: str
    view_count: int
    like_count: int
    version: int
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class PostListResponse(BaseModel):
    items: list[PostResponse]
    total: int
    page: int
    size: int
```

- [ ] **Step 2: Post 서비스 작성 (순수 DB, 최적화 없음)**

```python
# src/services/post_service.py
import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.post import Post
from src.schemas.post import PostCreate, PostUpdate


async def create_post(db: AsyncSession, data: PostCreate) -> Post:
    post = Post(**data.model_dump())
    db.add(post)
    await db.commit()
    await db.refresh(post)
    return post


async def get_post(db: AsyncSession, post_id: uuid.UUID) -> Post | None:
    result = await db.execute(select(Post).where(Post.id == post_id))
    return result.scalar_one_or_none()


async def list_posts(
    db: AsyncSession, page: int = 1, size: int = 20
) -> tuple[list[Post], int]:
    # ⚠️ 의도적으로 OFFSET 사용 — Phase 3에서 커서로 교체
    offset = (page - 1) * size
    count_result = await db.execute(select(func.count(Post.id)))
    total = count_result.scalar_one()
    result = await db.execute(
        select(Post).order_by(Post.created_at.desc()).offset(offset).limit(size)
    )
    return list(result.scalars().all()), total


async def update_post(
    db: AsyncSession, post_id: uuid.UUID, data: PostUpdate
) -> Post | None:
    result = await db.execute(select(Post).where(Post.id == post_id))
    post = result.scalar_one_or_none()
    if not post:
        return None
    if post.version != data.version:
        return None  # 낙관적 락 충돌
    update_data = data.model_dump(exclude_unset=True, exclude={"version"})
    for key, value in update_data.items():
        setattr(post, key, value)
    post.version += 1
    await db.commit()
    await db.refresh(post)
    return post


async def delete_post(db: AsyncSession, post_id: uuid.UUID) -> bool:
    result = await db.execute(select(Post).where(Post.id == post_id))
    post = result.scalar_one_or_none()
    if not post:
        return False
    await db.delete(post)
    await db.commit()
    return True
```

- [ ] **Step 3: Command API (쓰기) 작성**

```python
# src/api/command/posts.py
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.schemas.post import PostCreate, PostResponse, PostUpdate
from src.services import post_service

router = APIRouter(prefix="/api/posts", tags=["posts-command"])


@router.post("", response_model=PostResponse, status_code=201)
async def create_post(data: PostCreate, db: AsyncSession = Depends(get_db)):
    post = await post_service.create_post(db, data)
    return post


@router.put("/{post_id}", response_model=PostResponse)
async def update_post(
    post_id: uuid.UUID, data: PostUpdate, db: AsyncSession = Depends(get_db)
):
    post = await post_service.update_post(db, post_id, data)
    if not post:
        raise HTTPException(status_code=409, detail="Post not found or version conflict")
    return post


@router.delete("/{post_id}", status_code=204)
async def delete_post(post_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    deleted = await post_service.delete_post(db, post_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Post not found")
```

- [ ] **Step 4: Query API (읽기) 작성**

```python
# src/api/query/posts.py
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.schemas.post import PostListResponse, PostResponse
from src.services import post_service

router = APIRouter(prefix="/api/posts", tags=["posts-query"])


@router.get("", response_model=PostListResponse)
async def list_posts(
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    posts, total = await post_service.list_posts(db, page, size)
    return PostListResponse(items=posts, total=total, page=page, size=size)


@router.get("/{post_id}", response_model=PostResponse)
async def get_post(post_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    post = await post_service.get_post(db, post_id)
    if not post:
        raise HTTPException(status_code=404, detail="Post not found")
    # ⚠️ 의도적으로 DB 직접 UPDATE — Phase 5에서 Redis로 교체
    post.view_count += 1
    await db.commit()
    await db.refresh(post)
    return post
```

- [ ] **Step 5: main.py에 라우터 등록**

```python
# src/main.py
from fastapi import FastAPI

from src.api.command.posts import router as posts_command_router
from src.api.query.posts import router as posts_query_router

app = FastAPI(title="Extreme Board")

app.include_router(posts_command_router)
app.include_router(posts_query_router)


@app.get("/health")
async def health():
    return {"status": "ok"}
```

- [ ] **Step 6: 테스트 fixtures 작성**

```python
# tests/conftest.py
import asyncio
from collections.abc import AsyncGenerator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from src.config import settings
from src.database import get_db
from src.main import app
from src.models.post import Base

engine = create_async_engine(settings.database_url)
test_session = async_sessionmaker(engine, expire_on_commit=False)


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest_asyncio.fixture
async def db() -> AsyncGenerator[AsyncSession, None]:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with test_session() as session:
        yield session
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


@pytest_asyncio.fixture
async def client(db: AsyncSession) -> AsyncGenerator[AsyncClient, None]:
    async def override_get_db():
        yield db

    app.dependency_overrides[get_db] = override_get_db
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        yield client
    app.dependency_overrides.clear()
```

- [ ] **Step 7: Post CRUD 테스트 작성**

```python
# tests/test_posts.py
import pytest


@pytest.mark.asyncio
async def test_create_post(client):
    response = await client.post(
        "/api/posts",
        json={"title": "Hello", "content": "World", "author": "tester"},
    )
    assert response.status_code == 201
    data = response.json()
    assert data["title"] == "Hello"
    assert data["version"] == 1


@pytest.mark.asyncio
async def test_get_post(client):
    create = await client.post(
        "/api/posts",
        json={"title": "Test", "content": "Content", "author": "tester"},
    )
    post_id = create.json()["id"]
    response = await client.get(f"/api/posts/{post_id}")
    assert response.status_code == 200
    assert response.json()["view_count"] == 1


@pytest.mark.asyncio
async def test_list_posts(client):
    for i in range(3):
        await client.post(
            "/api/posts",
            json={"title": f"Post {i}", "content": "Content", "author": "tester"},
        )
    response = await client.get("/api/posts?page=1&size=2")
    assert response.status_code == 200
    data = response.json()
    assert len(data["items"]) == 2
    assert data["total"] == 3


@pytest.mark.asyncio
async def test_update_post_optimistic_lock(client):
    create = await client.post(
        "/api/posts",
        json={"title": "Original", "content": "Content", "author": "tester"},
    )
    post_id = create.json()["id"]

    # 정상 업데이트 (version=1)
    response = await client.put(
        f"/api/posts/{post_id}",
        json={"title": "Updated", "version": 1},
    )
    assert response.status_code == 200
    assert response.json()["version"] == 2

    # version 충돌 (이미 2인데 1로 시도)
    response = await client.put(
        f"/api/posts/{post_id}",
        json={"title": "Conflict", "version": 1},
    )
    assert response.status_code == 409


@pytest.mark.asyncio
async def test_delete_post(client):
    create = await client.post(
        "/api/posts",
        json={"title": "ToDelete", "content": "Content", "author": "tester"},
    )
    post_id = create.json()["id"]
    response = await client.delete(f"/api/posts/{post_id}")
    assert response.status_code == 204
    response = await client.get(f"/api/posts/{post_id}")
    assert response.status_code == 404
```

- [ ] **Step 8: 테스트 실행**

Run: `docker compose exec app pytest tests/test_posts.py -v`
Expected: 5 tests PASSED

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: Post CRUD API with optimistic locking (naive, no optimization)"
```

---

### Task 4: Comment + Like API

**Files:**
- Create: `src/models/comment.py`, `src/models/like.py`
- Create: `src/schemas/comment.py`, `src/schemas/like.py`
- Create: `src/services/comment_service.py`, `src/services/like_service.py`
- Create: `src/api/command/comments.py`, `src/api/command/likes.py`
- Create: `src/api/query/comments.py`
- Create: `tests/test_comments.py`, `tests/test_likes.py`

**학습 — DB UNIQUE 제약조건:**

좋아요는 "유저당 게시글당 1회"를 보장해야 함. 앱 코드에서 `if exists` 체크하면?
→ 동시에 2개 요청이 오면 둘 다 "없음" → 둘 다 INSERT → 중복 발생!
→ DB UNIQUE 제약이 최종 안전장치임. 앱 코드는 1차 방어선.

```sql
UNIQUE(post_id, user_id)  -- DB가 절대 중복을 허용하지 않음
```

- [ ] **Step 1: Comment 모델 작성**

```python
# src/models/comment.py
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from src.models.post import Base


class Comment(Base):
    __tablename__ = "comments"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    post_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("posts.id", ondelete="CASCADE"), nullable=False
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    author: Mapped[str] = mapped_column(String(100), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
```

- [ ] **Step 2: Like 모델 작성 (UNIQUE 제약)**

```python
# src/models/like.py
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from src.models.post import Base


class Like(Base):
    __tablename__ = "likes"
    __table_args__ = (
        UniqueConstraint("post_id", "user_id", name="uq_like_post_user"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    post_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("posts.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[str] = mapped_column(String(100), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
```

- [ ] **Step 3: Like 서비스 (의도적으로 DB만 사용)**

```python
# src/services/like_service.py
import uuid

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.like import Like
from src.models.post import Post


async def toggle_like(db: AsyncSession, post_id: uuid.UUID, user_id: str) -> bool:
    """좋아요 토글. True=추가, False=취소."""
    existing = await db.execute(
        select(Like).where(Like.post_id == post_id, Like.user_id == user_id)
    )
    like = existing.scalar_one_or_none()

    if like:
        await db.delete(like)
        # ⚠️ DB 직접 UPDATE — Phase 5에서 Redis INCR로 교체
        await db.execute(
            update(Post).where(Post.id == post_id).values(like_count=Post.like_count - 1)
        )
        await db.commit()
        return False
    else:
        db.add(Like(post_id=post_id, user_id=user_id))
        # ⚠️ DB 직접 UPDATE
        await db.execute(
            update(Post).where(Post.id == post_id).values(like_count=Post.like_count + 1)
        )
        await db.commit()
        return True
```

- [ ] **Step 4: Comment 서비스, API 라우터 작성 + main.py 등록**

- [ ] **Step 5: Alembic 마이그레이션**

Run: `docker compose exec app alembic revision --autogenerate -m "add comments and likes"`
Run: `docker compose exec app alembic upgrade head`

- [ ] **Step 6: 테스트 작성**

```python
# tests/test_likes.py
import pytest


@pytest.mark.asyncio
async def test_like_toggle(client):
    post = await client.post(
        "/api/posts", json={"title": "T", "content": "C", "author": "a"}
    )
    post_id = post.json()["id"]

    # 좋아요 추가
    r = await client.post(f"/api/posts/{post_id}/likes", json={"user_id": "user1"})
    assert r.status_code == 201

    # 같은 유저 → 취소
    r = await client.post(f"/api/posts/{post_id}/likes", json={"user_id": "user1"})
    assert r.status_code == 200

    # 좋아요 수 확인
    post_data = await client.get(f"/api/posts/{post_id}")
    assert post_data.json()["like_count"] == 0
```

- [ ] **Step 7: 전체 테스트 실행**

Run: `docker compose exec app pytest tests/ -v`
Expected: All PASSED

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: Comment + Like with DB constraints (naive counter)"
```

---

## Phase 1 완료 체크리스트

- [ ] Docker Compose로 PG + Redis + MinIO + App 구동
- [ ] Post CRUD API 동작 (생성, 조회, 목록, 수정, 삭제)
- [ ] 낙관적 락으로 동시 수정 감지
- [ ] Comment CRUD 동작
- [ ] Like 토글 + UNIQUE 제약 + DB 카운터
- [ ] 전체 테스트 통과

**다음:** [Phase 2 — 100만 데이터 병목 체감](phase-02-bottleneck.md)
