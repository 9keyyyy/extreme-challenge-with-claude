# Phase 6: 멱등성 — 중복 요청에도 데이터가 꼬이지 않게

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans

**전제:** Phase 5 완료. CRUD + 캐시 + Redis 카운터가 동작하는 상태.

**학습 키워드**
`Idempotency` `Idempotency-Key Header` `SET NX (distributed lock)` `Exactly-once Delivery` `At-least-once vs At-most-once` `Retry with Exponential Backoff` `409 Conflict` `Starlette Middleware` `Network Partition`

---

## 학습: 멱등성이란

### 같은 요청을 N번 보내도 결과가 1번과 동일

```
멱등성 없음:
  POST /posts {title: "Hello"} × 3번 → 게시글 3개 생김 💀

멱등성 있음:
  POST /posts {title: "Hello"} + Idempotency-Key: abc-123
  → 1번째: 게시글 생성 + 응답 저장
  → 2번째: 키 확인 → 저장된 응답 반환 (게시글 안 만듦)
  → 3번째: 동일
```

### 왜 필요한가 — 실제 장애 시나리오

1. **네트워크 타임아웃:** 서버가 처리 완료했는데 응답이 클라이언트에 안 도착 → 클라이언트 재시도 → 중복
2. **로드밸런서 재시도:** ALB가 503 받으면 자동으로 다른 인스턴스에 재시도
3. **모바일 네트워크:** 3G/LTE 전환 중 요청 유실 → 앱이 재전송

이런 상황이 100만 CCU에서는 초당 수십~수백 번 발생함.

### HTTP 메서드별 멱등성

| 메서드 | 자연 멱등? | 이유 |
|--------|-----------|------|
| GET | ✅ | 읽기만. 부작용 없음 |
| PUT | ✅ | "이 값으로 덮어써라". 2번 해도 결과 동일 |
| DELETE | ✅ | "삭제해라". 이미 없으면 404. 결과 동일 |
| POST | ❌ | "생성해라". 2번 하면 2개 생김 → **멱등성 키 필요** |

### 업계 표준: Stripe API 방식

Stripe는 결제 API에서 `Idempotency-Key` 헤더를 사용. 우리도 이 패턴을 차용.

```
POST /api/posts
Headers: { Idempotency-Key: "client-generated-uuid" }
```

### 구현 전략: Redis(1차) + DB(2차) 이중 검증

```
1. Redis GET idempotency:{key}
   → 있으면: 저장된 응답 반환 (0.1ms)
2. Redis SET idempotency:{key} "processing" NX EX 30
   → 못 잡으면: 409 Conflict (동시에 같은 키로 요청 중)
3. 비즈니스 로직 실행 (DB INSERT 등)
4. Redis SET idempotency:{key} {response} EX 86400 (24시간 TTL)
5. DB INSERT idempotency_keys ON CONFLICT DO NOTHING (2차 안전장치)
```

**왜 이중인가:** Redis가 장애 나도 DB에서 방어. DB만 쓰면 매 요청마다 DB 조회 → 느림.

### 심화 학습 — 더 깊이 파볼 키워드

| 키워드 | 왜 알아야 하는지 |
|--------|----------------|
| **Exactly-once vs At-least-once** | 분산 시스템에서 메시지 전달 보장 수준. 멱등성은 at-least-once를 exactly-once처럼 만드는 기법 |
| **Redlock (분산 락 알고리즘)** | Redis 단일 인스턴스 락의 한계. Redis 클러스터에서 안전한 락을 위한 알고리즘 |
| **Exponential Backoff + Jitter** | 재시도 간격을 지수적으로 늘리되 랜덤 편차 추가. 동시 재시도 폭풍 방지 |
| **Two-Phase Commit (2PC)** | 분산 트랜잭션의 고전적 해법. 왜 실무에서는 잘 안 쓰고 멱등성으로 대체하는지 |
| **Outbox Pattern** | DB 트랜잭션 + 이벤트 발행을 원자적으로. 멱등성과 결합하면 강력한 패턴 |

---

## 구현

### Task 13: 멱등성 없이 중복 발생 확인

**Files:**
- Create: `tests/test_idempotency.py`

- [ ] **Step 1: 중복 생성 테스트 — 문제 확인**

```python
# tests/test_idempotency.py
import asyncio
import pytest


@pytest.mark.asyncio
async def test_duplicate_without_idempotency(client):
    """같은 요청 5번 → 게시글 5개 (멱등성 없는 상태)"""
    payload = {"title": "Duplicate?", "content": "Test", "author": "tester"}
    tasks = [client.post("/api/posts", json=payload) for _ in range(5)]
    results = await asyncio.gather(*tasks)
    created = [r for r in results if r.status_code == 201]
    assert len(created) == 5  # 5개 다 생김 — 이게 문제!
```

- [ ] **Step 2: Commit**

```bash
git add tests/test_idempotency.py
git commit -m "test: demonstrate duplicate creation without idempotency"
```

---

### Task 14: 멱등성 미들웨어 구현

**Files:**
- Create: `src/models/idempotency.py`
- Create: `src/services/idempotency_service.py`
- Create: `src/middleware/idempotency.py`
- Modify: `src/main.py`
- Modify: `tests/test_idempotency.py`

- [ ] **Step 1: 멱등성 키 모델 (DB 2차 저장소)**

```python
# src/models/idempotency.py
from datetime import datetime

from sqlalchemy import DateTime, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from src.models.post import Base


class IdempotencyKey(Base):
    __tablename__ = "idempotency_keys"

    key: Mapped[str] = mapped_column(String(255), primary_key=True)
    response_status: Mapped[int] = mapped_column()
    response_body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
```

- [ ] **Step 2: 멱등성 서비스**

```python
# src/services/idempotency_service.py
import json

from src.redis_client import redis_client

TTL = 86400  # 24시간


async def check_idempotency(key: str) -> dict | None:
    data = await redis_client.get(f"idempotency:{key}")
    if data:
        parsed = json.loads(data)
        if parsed != "processing":
            return parsed
    return None


async def acquire_lock(key: str) -> bool:
    return await redis_client.set(
        f"idempotency:{key}", '"processing"', nx=True, ex=30
    )


async def save_response(key: str, status: int, body: dict):
    data = json.dumps({"status": status, "body": body})
    await redis_client.set(f"idempotency:{key}", data, ex=TTL)


async def release_lock(key: str):
    await redis_client.delete(f"idempotency:{key}")
```

- [ ] **Step 3: FastAPI 미들웨어**

```python
# src/middleware/idempotency.py
import json

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from src.services import idempotency_service

IDEMPOTENT_METHODS = {"POST", "PUT"}


class IdempotencyMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        if request.method not in IDEMPOTENT_METHODS:
            return await call_next(request)

        idempotency_key = request.headers.get("Idempotency-Key")
        if not idempotency_key:
            return await call_next(request)

        # 이전 응답 확인
        existing = await idempotency_service.check_idempotency(idempotency_key)
        if existing:
            return JSONResponse(
                status_code=existing["status"], content=existing["body"]
            )

        # 락 획득
        if not await idempotency_service.acquire_lock(idempotency_key):
            return JSONResponse(
                status_code=409, content={"detail": "Request in progress"}
            )

        # 요청 처리
        try:
            response = await call_next(request)
            body = b""
            async for chunk in response.body_iterator:
                body += chunk
            body_dict = json.loads(body)

            await idempotency_service.save_response(
                idempotency_key, response.status_code, body_dict
            )
            return JSONResponse(
                status_code=response.status_code, content=body_dict
            )
        except Exception:
            await idempotency_service.release_lock(idempotency_key)
            raise
```

- [ ] **Step 4: main.py에 미들웨어 등록**

```python
from src.middleware.idempotency import IdempotencyMiddleware
app.add_middleware(IdempotencyMiddleware)
```

- [ ] **Step 5: 멱등성 동작 테스트**

```python
# tests/test_idempotency.py에 추가
@pytest.mark.asyncio
async def test_idempotent_creation(client):
    """같은 키로 5번 보내면 게시글 1개만"""
    payload = {"title": "Unique", "content": "Test", "author": "tester"}
    headers = {"Idempotency-Key": "test-key-123"}

    results = []
    for _ in range(5):
        r = await client.post("/api/posts", json=payload, headers=headers)
        results.append(r)

    first_id = results[0].json()["id"]
    for r in results[1:]:
        assert r.json()["id"] == first_id  # 전부 같은 게시글!
```

- [ ] **Step 6: Alembic 마이그레이션 + 테스트 실행**

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: idempotency middleware — Redis lock + response caching"
```

---

## Phase 6 완료 체크리스트

- [ ] 멱등성 없이 중복 생성되는 문제 확인
- [ ] 멱등성 미들웨어 구현 (Redis 1차 + DB 2차)
- [ ] 같은 키로 N번 요청해도 결과 1번과 동일 확인
- [ ] 동시 같은 키 요청 시 409 Conflict 확인

**핵심 체감:**
- 멱등성 없음: 같은 요청 5번 = 게시글 5개
- 멱등성 있음: 같은 요청 5번 = 게시글 1개 + 4번은 캐시된 응답

**다음:** [Phase 7 — CQRS + Events](phase-07-cqrs-events.md)
