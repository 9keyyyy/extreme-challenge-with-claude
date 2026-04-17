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

        # 1차: Redis에서 이전 응답 확인 (빠름, 0.1ms)
        existing = await idempotency_service.check_idempotency(idempotency_key)
        if existing:
            return JSONResponse(
                status_code=existing["status"], content=existing["body"]
            )

        # 2차: DB에서 이전 응답 확인 (Redis TTL 만료 or Redis 장애 대비)
        from src.database import async_session
        from src.models.idempotency import IdempotencyKey
        from sqlalchemy import select

        async with async_session() as db:
            result = await db.execute(
                select(IdempotencyKey).where(IdempotencyKey.key == idempotency_key)
            )
            db_entry = result.scalar_one_or_none()
            if db_entry:
                body = json.loads(db_entry.response_body)
                # Redis에 다시 캐싱 (복구)
                await idempotency_service.save_response(
                    idempotency_key, db_entry.response_status, body
                )
                return JSONResponse(
                    status_code=db_entry.response_status, content=body
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

            # Redis에 응답 저장 (1차)
            await idempotency_service.save_response(
                idempotency_key, response.status_code, body_dict
            )
            # DB에 응답 저장 (2차 안전망 — Redis TTL 만료/장애 대비)
            async with async_session() as db:
                db.add(IdempotencyKey(
                    key=idempotency_key,
                    response_status=response.status_code,
                    response_body=json.dumps(body_dict),
                ))
                try:
                    await db.commit()
                except Exception:
                    await db.rollback()  # ON CONFLICT — 이미 있으면 무시

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

### Task 14A: 분산 락 한계 체험 + Fencing Token

> **전제:** Task 14 완료 + Phase 4.5의 분산 환경이 동작하는 상태.

**학습 키워드 추가**
`Fencing Token` `Distributed Lock Failure Modes` `TTL Expiry Race` `Redlock Controversy` `Kleppmann vs Antirez` `Mock External API`

**Files:**
- Create: `tests/test_distributed_idempotency.py`
- Create: `src/services/mock_notification.py`
- Modify: `src/services/idempotency_service.py`
- Modify: `src/models/idempotency.py`

#### 학습: 분산 락의 실패 모드 — "언제 Fencing Token이 필요한가"

Task 14에서 Redis SET NX로 멱등성 락을 구현함. 단일 인스턴스에서는 잘 동작하지만, 멀티 인스턴스에서 생각해야 할 실패 모드가 있음.

**TTL 만료 시나리오:**

```
1. 서버 A가 멱등성 키 "abc"로 Redis 락 획득 (TTL 30초)
2. 서버 A가 비즈니스 로직 실행... 근데 DB가 느림 (GC 폭발, 디스크 I/O)
3. 35초 경과 → TTL 만료 → 락 자동 해제
4. 서버 B가 같은 키 "abc"로 락 획득 → 비즈니스 로직 시작
5. 서버 A 완료 → 서버 B 완료
6. 결과: ???
```

여기서 핵심 질문: **결과가 뭐냐?**

**downstream이 DB(unique constraint)라면:**
- 서버 A의 INSERT 성공 → 서버 B의 INSERT는 `ON CONFLICT DO NOTHING`으로 무시됨
- 결과: 게시글 1개만 생성. **문제없음.**
- DB unique constraint가 2차 안전망으로 동작.

**downstream이 외부 API(알림, 결제)라면:**
- 서버 A의 알림 API 호출 성공 → 서버 B의 알림 API 호출도 성공
- 결과: 알림 2번 발송. **문제 있음.**
- 외부 API에는 unique constraint 같은 보호 장치가 없음.

**핵심 판단: "downstream이 자연적 멱등성을 가지는가?"**

| downstream | 자연적 멱등성 | Fencing Token 필요? |
|-----------|------------|-------------------|
| DB INSERT + unique constraint | 있음 (ON CONFLICT) | 불필요 — 오버엔지니어링 |
| DB UPSERT | 있음 (덮어쓰기) | 불필요 |
| 외부 결제 API | 없음 (PG사가 멱등성 키 안 받으면) | **필요** |
| 알림 발송 API | 없음 | **필요** |
| 이메일 발송 | 없음 | **필요** |

**Fencing Token 원리:**

```
1. 서버 A가 락 획득 → fencing token #1 발급 (단조증가)
2. TTL 만료
3. 서버 B가 락 획득 → fencing token #2 발급
4. 서버 A가 token #1로 외부 API 호출 → API가 "token #2를 이미 봤으므로 #1은 거부"
결과: 서버 B의 호출만 유효.
```

**Redlock 논쟁 — 요약:**
- **Antirez (Redis 저자):** Redis N대(5대) 중 과반수에 락 걸면 충분히 안전함
- **Kleppmann:** 비동기 시스템에서 clock 가정은 위험. GC pause, 네트워크 지연으로 락이 만료된 줄 모르고 동작할 수 있음. Fencing Token이 근본적 해결책
- **결론:** 은탄환은 없음. Redlock은 복잡도 대비 안전성이 불확실. 대부분의 경우 "단순 TTL 락 + downstream 보호(fencing token or DB constraint)"가 실용적

---

- [ ] **Step 1: 멀티 인스턴스 멱등성 기본 동작 확인**

```python
# tests/test_distributed_idempotency.py
import asyncio
import httpx
import pytest

NGINX_URL = "http://localhost"  # Nginx LB


@pytest.mark.asyncio
async def test_distributed_idempotency_basic():
    """Nginx 통해 같은 멱등성 키 100건 동시 전송 → 정확히 1건만 생성"""
    key = f"dist-test-{asyncio.get_event_loop().time()}"
    payload = {"title": "Distributed Idempotency", "content": "Test", "author": "tester"}

    async with httpx.AsyncClient() as client:
        tasks = [
            client.post(
                f"{NGINX_URL}/api/posts",
                json=payload,
                headers={"Idempotency-Key": key},
                timeout=10,
            )
            for _ in range(100)
        ]
        responses = await asyncio.gather(*tasks, return_exceptions=True)

    successful = [r for r in responses if not isinstance(r, Exception)]
    # 캐시된 응답도 원래 status(201)를 그대로 반환함.
    # 구분 불가 — 대신 "201 응답의 게시글 ID가 전부 동일한지"로 검증.
    ok_responses = [r for r in successful if r.status_code == 201]
    conflicts = [r for r in successful if r.status_code == 409]

    assert len(ok_responses) >= 1, "At least 1 successful response expected"
    print(f"201 responses: {len(ok_responses)}, Conflicts: {len(conflicts)}")
    print(f"Total: {len(ok_responses) + len(conflicts)} / {len(successful)} successful")

    # 핵심 검증: 모든 201 응답이 같은 게시글 ID를 반환해야 함
    ids = {r.json()["id"] for r in ok_responses}
    assert len(ids) == 1, f"Expected 1 unique post ID but got {len(ids)}: {ids}"
    print(f"All {len(ok_responses)} responses returned same post ID: {ids.pop()}")
```

Run: `pytest tests/test_distributed_idempotency.py::test_distributed_idempotency_basic -v`

Expected: Created 1건, 나머지는 Cached(200) 또는 Conflict(409).

- [ ] **Step 2: TTL 만료 시나리오 — DB constraint가 막아주는 것 확인**

```python
# tests/test_distributed_idempotency.py에 추가


@pytest.mark.asyncio
async def test_ttl_expiry_db_constraint_saves():
    """TTL 만료 시 DB unique constraint가 2차 안전망으로 동작하는지 확인.

    이 테스트는 개념 검증임. 실제 TTL 만료는 sleep(35)로 재현하면
    테스트가 35초 걸리므로, 대신 Redis 락을 수동으로 삭제해서 시뮬레이션.
    """
    key = f"ttl-test-{asyncio.get_event_loop().time()}"
    payload = {"title": "TTL Expiry Test", "content": "Test", "author": "tester"}

    async with httpx.AsyncClient() as client:
        # 1. 첫 번째 요청 — 정상 생성
        r1 = await client.post(
            f"{NGINX_URL}/api/posts",
            json=payload,
            headers={"Idempotency-Key": key},
            timeout=10,
        )
        assert r1.status_code == 201
        first_id = r1.json()["id"]

        # 2. Redis에서 멱등성 키 삭제 (TTL 만료 시뮬레이션)
        # Sentinel을 통해 master에 접근 — compose에서 redis-primary에 포트 매핑 없음
        import redis.asyncio as redis_lib
        from redis.asyncio.sentinel import Sentinel
        sentinel = Sentinel(
            [("localhost", 26379)],  # sentinel-1이 26379 포트를 노출해야 함
            socket_timeout=3,
        )
        r = sentinel.master_for("mymaster", decode_responses=True)
        await r.delete(f"idempotency:{key}")
        await r.aclose()

        # 3. 같은 키로 다시 요청 — Redis에는 키가 없지만 DB에 키가 있음
        r2 = await client.post(
            f"{NGINX_URL}/api/posts",
            json=payload,
            headers={"Idempotency-Key": key},
            timeout=10,
        )

        # 미들웨어가 DB를 2차 체크하므로, DB에서 이전 응답을 찾아 반환함
        assert r2.status_code == 201, f"Expected 201 but got {r2.status_code}"
        assert r2.json()["id"] == first_id, "DB 2차 안전망 실패 — 새 게시글 생성됨!"
        print(f"After TTL expiry simulation: DB에서 이전 응답 반환 확인. status={r2.status_code}")
```

Run: `pytest tests/test_distributed_idempotency.py::test_ttl_expiry_db_constraint_saves -v`

- [ ] **Step 3: 외부 API 호출 시 Fencing Token 없으면 이중 호출 발생 (단일 프로세스 개념 증명)**

아래 테스트는 HTTP/Nginx를 거치지 않고 직접 함수를 호출하는 단일 프로세스 테스트임. "서버 A가 호출, 서버 B가 호출"을 코드 레벨에서 시뮬레이션하는 개념 증명. 실제 멀티 인스턴스 시나리오는 Step 4의 통합 테스트에서 `acquire_lock_with_fencing`과 함께 검증.

```python
# src/services/mock_notification.py
"""외부 알림 API Mock — Fencing Token 학습용.

실제 외부 API를 시뮬레이션. call_log에 호출 이력이 쌓임.
멱등성이 없어서 같은 요청이 2번 오면 2번 다 실행됨.
"""

call_log: list[dict] = []


async def send_notification(post_id: str, title: str, fencing_token: int | None = None):
    """알림 발송. fencing_token이 있으면 검증."""
    if fencing_token is not None:
        # Fencing Token 검증: 이미 더 높은 토큰을 본 적 있으면 거부
        for entry in call_log:
            if entry["post_id"] == post_id and entry.get("fencing_token", 0) > fencing_token:
                return {"status": "rejected", "reason": "stale fencing token"}

    entry = {"post_id": post_id, "title": title, "fencing_token": fencing_token}
    call_log.append(entry)
    return {"status": "sent"}


def get_call_count(post_id: str) -> int:
    return sum(1 for e in call_log if e["post_id"] == post_id)


def clear_log():
    call_log.clear()
```

```python
# tests/test_distributed_idempotency.py에 추가
from src.services.mock_notification import (
    clear_log,
    get_call_count,
    send_notification,
)


@pytest.mark.asyncio
async def test_no_fencing_token_double_notification():
    """Fencing Token 없이 TTL 만료 → 알림 2번 발송"""
    clear_log()
    post_id = "post-123"

    # 서버 A의 호출 (TTL 만료 후에도 완료됨)
    await send_notification(post_id, "New Post")
    # 서버 B의 호출 (새 락으로 진입)
    await send_notification(post_id, "New Post")

    assert get_call_count(post_id) == 2, "알림이 2번 발송됨 — Fencing Token 없으면 막을 수 없음"


@pytest.mark.asyncio
async def test_fencing_token_prevents_double_notification():
    """Fencing Token으로 구 토큰 요청 거부"""
    clear_log()
    post_id = "post-456"

    # 서버 B가 먼저 완료 (token=2)
    r2 = await send_notification(post_id, "New Post", fencing_token=2)
    assert r2["status"] == "sent"

    # 서버 A가 뒤늦게 완료 (token=1, 구 토큰)
    r1 = await send_notification(post_id, "New Post", fencing_token=1)
    assert r1["status"] == "rejected"

    assert get_call_count(post_id) == 1, "Fencing Token 덕분에 1번만 발송됨"
```

Run: `pytest tests/test_distributed_idempotency.py -k "fencing" -v`

- [ ] **Step 4: Fencing Token 발급을 멱등성 서비스에 추가 + 통합 흐름 테스트**

```python
# src/services/idempotency_service.py에 추가

FENCING_COUNTER_KEY = "idempotency:fencing_counter"


async def acquire_lock_with_fencing(key: str) -> int | None:
    """락 획득 + fencing token 발급.

    Returns: fencing token (int) if lock acquired, None if lock already held.
    """
    locked = await redis_client.set(
        f"idempotency:{key}", '"processing"', nx=True, ex=30
    )
    if not locked:
        return None
    # 단조증가 fencing token 발급
    token = await redis_client.incr(FENCING_COUNTER_KEY)
    return token
```

```python
# src/models/idempotency.py — fencing_token 컬럼 추가

class IdempotencyKey(Base):
    __tablename__ = "idempotency_keys"

    key: Mapped[str] = mapped_column(String(255), primary_key=True)
    response_status: Mapped[int] = mapped_column()
    response_body: Mapped[str] = mapped_column(Text)
    fencing_token: Mapped[int] = mapped_column(default=0)  # 추가
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
```

```python
# tests/test_distributed_idempotency.py에 추가 — fencing token 통합 흐름

from src.services.idempotency_service import acquire_lock_with_fencing


@pytest.mark.asyncio
async def test_fencing_token_integrated_flow():
    """acquire_lock_with_fencing → send_notification 전체 흐름.

    실제 멀티 인스턴스 시나리오 시뮬레이션:
    1. 서버 A가 락 + fencing token 획득
    2. TTL 만료 (수동 삭제로 시뮬레이션)
    3. 서버 B가 새 락 + 더 높은 fencing token 획득
    4. 서버 B가 먼저 알림 발송 (token=2)
    5. 서버 A가 뒤늦게 알림 발송 시도 (token=1) → 거부됨
    """
    clear_log()
    post_id = "integrated-test"

    # conftest.py에서 init_redis() 호출 필요 (Phase 5 테스트와 동일)
    from src.redis_client import redis_client

    # 서버 A: 락 + token 획득
    token_a = await acquire_lock_with_fencing("integrated-key-1")
    assert token_a is not None

    # TTL 만료 시뮬레이션
    await redis_client.delete("idempotency:integrated-key-1")

    # 서버 B: 새 락 + 더 높은 token
    token_b = await acquire_lock_with_fencing("integrated-key-1")
    assert token_b is not None
    assert token_b > token_a, f"token_b({token_b}) should be > token_a({token_a})"

    # 서버 B가 먼저 완료 → 알림 발송
    r_b = await send_notification(post_id, "New Post", fencing_token=token_b)
    assert r_b["status"] == "sent"

    # 서버 A가 뒤늦게 완료 → 구 token으로 알림 시도 → 거부
    r_a = await send_notification(post_id, "New Post", fencing_token=token_a)
    assert r_a["status"] == "rejected"

    assert get_call_count(post_id) == 1, "Fencing token 통합 흐름: 1번만 발송"
```

- [ ] **Step 5: Alembic 마이그레이션 + Commit**

```bash
alembic revision --autogenerate -m "add fencing_token to idempotency_keys"
alembic upgrade head
git add -A
git commit -m "feat: distributed lock limits — fencing token for external API idempotency"
```

---

## Phase 6 완료 체크리스트

- [ ] 멱등성 없이 중복 생성되는 문제 확인
- [ ] 멱등성 미들웨어 구현 (Redis 1차 + DB 2차)
- [ ] 같은 키로 N번 요청해도 결과 1번과 동일 확인
- [ ] 동시 같은 키 요청 시 409 Conflict 확인
- [ ] 멀티 인스턴스에서 같은 멱등성 키 100건 → 1건만 생성 확인
- [ ] TTL 만료 시 DB constraint가 2차 안전망 역할 확인
- [ ] 외부 API 호출 시 Fencing Token 없으면 이중 호출 체험
- [ ] Fencing Token으로 구 토큰 거부 확인
- [ ] "Fencing Token이 필요한 경우 vs 불필요한 경우" 판단 학습

**핵심 체감:**
- 멱등성 없음: 같은 요청 5번 = 게시글 5개
- 멱등성 있음: 같은 요청 5번 = 게시글 1개 + 4번은 캐시된 응답
- DB downstream: TTL 만료돼도 unique constraint가 막음 → Fencing Token 불필요
- 외부 API downstream: TTL 만료 시 이중 호출 → Fencing Token 필요
- **"항상 최강 도구가 아니라, 상황에 맞는 도구를 고르는 게 시니어"**

**다음:** [Phase 7 — CQRS + Events](phase-07-cqrs-events.md)
