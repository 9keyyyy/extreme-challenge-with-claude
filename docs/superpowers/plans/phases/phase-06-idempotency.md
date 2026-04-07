# Phase 6: 멱등성 — 중복 요청에도 데이터가 꼬이지 않게

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans

**전제:** Phase 5 완료. CRUD + 캐시 + Redis 카운터가 동작하는 상태.

**학습 키워드**
`Idempotency` `Idempotency-Key Header` `SET NX (distributed lock)` `Exactly-once Delivery` `At-least-once vs At-most-once` `Retry with Exponential Backoff` `409 Conflict` `Starlette Middleware` `Network Partition`

---

## 학습: 멱등성이란

### 핵심 질문 — "멱등성이 뭔가요? 왜 필요한가요?"

> "같은 연산을 N번 실행해도 결과가 1번 실행한 것과 동일한 성질임. 분산 시스템에서 네트워크 실패 시 재시도가 불가피한데, 재시도가 중복 처리로 이어지지 않도록 보장하는 핵심 메커니즘임."

한 문장으로 끝나는 개념이 아님. 진짜 중요한 건 "그래서 없으면 어떻게 되는데?"에 답할 수 있는 것.

---

### 같은 요청을 N번 보내도 결과가 1번과 동일

```
멱등성 없음:
  POST /posts {title: "Hello"} × 3번 → 게시글 3개 생김

멱등성 있음:
  POST /posts {title: "Hello"} + Idempotency-Key: abc-123
  → 1번째: 게시글 생성 + 응답 저장
  → 2번째: 키 확인 → 저장된 응답 반환 (게시글 안 만듦)
  → 3번째: 동일
```

---

### 멱등성이 없으면 실제로 어떤 일이 생기나

이게 단순히 게시글 중복 생성으로 끝나는 게 아님. 서비스 유형에 따라 진짜 사고가 남.

**결제 서비스 — 이중 결제**
사용자가 "결제" 버튼을 눌렀는데 응답이 안 옴 (5G → Wi-Fi 전환 순간 유실). 앱이 자동 재시도. 서버는 이미 첫 번째 요청을 처리해서 돈을 빠져나갔는데, 두 번째 요청도 새 결제로 처리함. 사용자 카드에서 5만원이 두 번 빠짐. 고객센터 폭주, 환불 처리 비용, 신뢰도 하락.

**이커머스 — 주문 중복**
"주문하기" 버튼 두 번 클릭 (UX가 버튼을 바로 비활성화 안 했거나, 더블탭). 재고가 2개씩 빠지고 배송이 2건 나감. 재고 관리 시스템이 꼬임.

**게시판 서비스 — 게시글 도배**
네트워크 불안정 구간에서 글쓰기 요청이 타임아웃. 앱이 재시도. 같은 글이 3개 올라옴. 사용자는 자기가 도배한 것처럼 보임.

멱등성은 "데이터 정합성"의 문제이기 전에 **사용자 경험과 비즈니스 신뢰도**의 문제임.

---

### 왜 1M CCU에서는 이 문제가 훨씬 심각한가

소규모 서비스에서는 네트워크 실패가 하루 몇 건. 수동으로 DB 정리해도 됨.

1M CCU에서는 다름:
- 네트워크 실패율이 0.1%라고 가정해도 초당 1,000건
- 모바일 사용자가 50%라면 그중 LTE/5G 전환, 지하철 터널 구간 등으로 실패율이 훨씬 높음
- ALB, API Gateway 같은 인프라 레이어도 실패 시 자동 재시도를 내장하고 있음
- 초당 수백~수천 건의 중복 요청이 시스템으로 들어옴

이걸 수동으로 정리한다는 건 불가능임. **멱등성은 선택이 아니라 기본 설계 요소**가 되는 거임.

---

### HTTP 메서드별 멱등성 — 자연 멱등 vs 인공 멱등

| 메서드 | 자연 멱등? | 이유 |
|--------|-----------|------|
| GET | O | 읽기만. 부작용 없음 |
| PUT | O | "이 값으로 덮어써라". 2번 해도 결과 동일 |
| DELETE | O | "삭제해라". 이미 없으면 404. 결과 동일 |
| POST | X | "생성해라". 2번 하면 2개 생김 → **멱등성 키 필요** |

**자연 멱등(natural idempotency)** 이란 메서드의 의미 자체가 멱등성을 보장하는 경우임.

- `PUT /posts/123 {title: "수정"}` 은 100번 보내도 123번 게시글의 제목이 "수정"으로 남음. 상태를 "덮어쓰는" 연산이기 때문임.
- `DELETE /posts/123` 은 2번 호출하면 두 번째는 404를 받지만, "123번 게시글이 없는 상태"라는 결과는 동일함.

**인공 멱등(artificial idempotency)** 이란 원래 멱등하지 않은 연산에 외부 키를 붙여서 멱등성을 만드는 방법임.

- `POST /posts` 는 원래 "새 리소스를 생성해"라는 의미라 본질적으로 멱등하지 않음.
- 여기에 `Idempotency-Key: uuid-1234` 를 붙이면, 서버가 이 키를 기억하고 같은 키로 온 요청은 기존 결과를 그대로 돌려줌.
- 클라이언트가 UUID를 생성해서 헤더에 실어 보내는 게 핵심. 서버가 키를 만드는 게 아님.

---

### 업계 표준: Stripe API 방식

Stripe는 결제 API에서 `Idempotency-Key` 헤더를 도입한 걸로 유명함. 결제는 멱등성이 없으면 이중 청구가 발생하니까 이걸 API 설계 레벨에서 강제함. 우리도 이 패턴을 차용함.

```
POST /api/posts
Headers: { Idempotency-Key: "client-generated-uuid" }
```

클라이언트가 UUID를 직접 생성해서 보내는 이유: 서버가 생성하면 요청이 한 번은 서버에 도달해야 하는데, 그 요청 자체가 실패할 수 있음. 클라이언트가 미리 만들어두면 재시도할 때 그 키 그대로 다시 보낼 수 있음.

---

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

**Redis만 쓰면 왜 부족한가**

Redis는 인메모리임. 장애가 나거나 재시작되면 데이터가 날아감. Redis가 다운된 순간 멱등성 키가 모두 사라지면, 재시도 요청들이 전부 새 요청으로 처리됨. 결국 중복 처리가 대량 발생.

**DB만 쓰면 왜 부족한가**

DB 조회는 Redis보다 10~100배 느림. 멱등성 체크가 모든 POST 요청에 들어가니까, 1M RPS 환경에서 매 요청마다 DB 쿼리를 하나씩 추가하면 DB가 먼저 죽음.

**그래서 이중 구조임**

- Redis: 빠른 1차 방어 (0.1ms, 대부분 여기서 걸림)
- DB: Redis가 죽었을 때 2차 안전망 (`ON CONFLICT DO NOTHING` 이 중복 삽입을 막음)

Redis NX(SET if Not eXists) 는 원자적 연산임. "없으면 SET하고 성공 반환, 있으면 실패 반환"을 단일 명령으로 처리함. 이게 분산 락의 핵심임. NX 없이 GET → 없으면 SET 하면 두 요청이 동시에 GET 하고 둘 다 없다고 판단해서 둘 다 SET해버림 (race condition).

---

### 심화 학습 — 더 깊이 파볼 키워드

| 키워드 | 왜 알아야 하는지 |
|--------|----------------|
| **Exactly-once vs At-least-once** | 분산 시스템에서 메시지 전달 보장 수준. 멱등성은 at-least-once(재시도 허용)를 exactly-once처럼 만드는 기법. 카프카 컨슈머 설계할 때도 나오는 개념 |
| **Redlock (분산 락 알고리즘)** | Redis 단일 인스턴스 락은 Redis가 죽으면 락이 사라짐. Redis 클러스터(N대) 중 과반수에 락을 걸어서 단일 장애점을 없애는 알고리즘. 단, 복잡도가 높아서 꼭 필요한지 먼저 판단해야 함 |
| **Exponential Backoff + Jitter** | 재시도 간격을 지수적으로 늘리되 랜덤 편차 추가. 서버가 과부하 상태일 때 클라이언트들이 동시에 재시도하면 더 과부하가 됨(thundering herd). Jitter로 재시도 시점을 분산시킴 |
| **Two-Phase Commit (2PC)** | 분산 트랜잭션의 고전적 해법. DB 2개에 걸친 트랜잭션을 원자적으로 처리함. 하지만 코디네이터 장애 시 블로킹, 성능 저하로 실무에서는 잘 안 씀. 멱등성 + 보상 트랜잭션으로 대체하는 게 일반적 |
| **Outbox Pattern** | DB 트랜잭션 + 이벤트 발행을 원자적으로 처리하는 패턴. DB에 커밋은 됐는데 카프카 발행이 실패하는 문제를 해결함. 멱등성과 결합하면 분산 시스템에서의 강력한 패턴이 됨 |

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
