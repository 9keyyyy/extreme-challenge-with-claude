# Phase 7: CQRS + Event Bus — 읽기/쓰기 분리 + 비동기 처리

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans

**전제:** Phase 6 완료. CRUD + 캐시 + 카운터 + 멱등성이 모두 동작하는 상태.

**학습 키워드**
`CQRS` `Event-Driven Architecture` `Event Sourcing vs Event-Driven` `Redis Streams` `XADD/XREADGROUP` `Consumer Group` `Eventual Consistency` `Strong Consistency` `Back Pressure` `Dead Letter Queue` `Replication Lag`

---

## 학습: CQRS와 이벤트 버스

### CQRS — 왜 분리하는가

커뮤니티 게시판 트래픽: 읽기 99% / 쓰기 1%. 분리 안 하면?
- 읽기를 위해 서버 20대 필요 → 쓰기도 20대가 됨 (19대는 낭비)
- 쓰기 부하가 올라가면 읽기도 같이 느려짐

분리하면:
- Query 서비스 20대 (읽기 최적화: 캐시 중심)
- Command 서비스 2대 (쓰기 최적화: 정합성 중심)
- 쓰기가 폭증해도 읽기는 영향 없음

**이건 코드 레벨 분리지, 서비스 분리가 아님.** 같은 앱 안에서 `api/command/`와 `api/query/` 디렉토리로 나눔. 나중에 필요하면 별도 서비스로 추출 가능.

### 이벤트 버스 — 왜 필요한가

게시글 작성 시 할 일: DB 저장 + 캐시 갱신 + 카운터 초기화 + 검색 인덱스 + 알림...

이걸 전부 동기로 하면:
```python
async def create_post(data):
    await db.insert(data)           # 5ms
    await update_cache(data)         # 3ms
    await init_counter(data)         # 1ms
    await send_notification(data)    # 200ms ← 알림 서버가 느리면 전체가 느려짐
    return result                    # 총 209ms
```

이벤트로 분리하면:
```python
async def create_post(data):
    await db.insert(data)                    # 5ms
    await redis.xadd("events", {...})        # 0.1ms
    return result                            # 총 5.1ms ← 유저는 여기서 응답
    # 나머지는 Worker가 비동기로 처리
```

### Redis Streams — 왜 Kafka가 아닌 Redis인가

| 기준 | Redis Streams | Kafka | SQS |
|------|-------------|-------|-----|
| 추가 인프라 | 없음 (이미 Redis 사용중) | Kafka 클러스터 + ZooKeeper | AWS 종속 |
| 처리량 | ~100만 msg/s | ~수백만 msg/s | ~3000 msg/s (FIFO) |
| 비용 | $0 추가 | MSK $200+/월 | 요청당 과금 |
| 로컬 개발 | Docker Redis 하나 | Docker 3개+ | LocalStack |
| Consumer Group | XREADGROUP | 핵심 기능 | Visibility Timeout |

**선택 이유:** 이미 Redis를 캐시/카운터로 쓰고 있음 → 추가 비용 $0. $100 예산에서 Kafka는 불가능. 처리량도 이 규모에서 충분.

### Eventual Consistency (최종 정합성)

CQRS + 이벤트로 분리하면 "글 수정 → 즉시 조회 → 구버전이 보일 수 있음". 이벤트가 처리되기 전까지 캐시에 구버전이 남아있기 때문.

- **Strong Consistency:** 항상 최신. PostgreSQL 단독 읽기 시
- **Eventual Consistency:** "결국" 최신. CQRS + 캐시 구조에서

해결: **Write-후-Read 보장** — 글을 쓴 사람은 캐시 무효화 후 DB에서 직접 읽기. 다른 사람은 캐시에서 읽기 (약간의 지연 허용).

**DB별 비교:**
- **PostgreSQL:** 단일 서버에서 Strong. Read Replica에서 읽으면 Eventual (replication lag)
- **MySQL:** 동일. Semi-sync replication으로 lag 줄일 수 있지만 완전 제거는 불가
- **MongoDB:** readConcern "majority" = Strong, "local" = Eventual. 유연하게 선택 가능

### 심화 학습 — 더 깊이 파볼 키워드

| 키워드 | 왜 알아야 하는지 |
|--------|----------------|
| **Event Sourcing vs Event-Driven** | Event Sourcing = 상태를 이벤트 시퀀스로 저장. Event-Driven = 이벤트로 통신만. 전혀 다른 패턴 |
| **Dead Letter Queue (DLQ)** | 처리 실패한 이벤트를 별도 저장. 재처리나 디버깅에 필수 |
| **Back Pressure** | Consumer가 처리 못하는 속도로 이벤트가 쌓일 때 대응. Streams의 XLEN으로 모니터링 |
| **Saga Pattern** | 여러 서비스 걸쳐 트랜잭션 관리. CQRS + Event와 자주 함께 사용 |
| **Replication Lag** | Read Replica에서 읽을 때 발생하는 지연. Eventual Consistency의 실체 |
| **XPENDING / XCLAIM** | 처리 안 된 메시지 확인 + 다른 Consumer에게 재할당. Consumer 장애 대응 |

---

## 구현

### Task 15: Redis Streams 이벤트 발행/소비

**Files:**
- Create: `src/services/event_service.py`
- Create: `src/workers/event_consumer.py`
- Modify: `src/api/command/posts.py`
- Modify: `docker-compose.yml`
- Create: `tests/test_events.py`

- [ ] **Step 1: 이벤트 발행 서비스**

```python
# src/services/event_service.py
import json

from src.redis_client import redis_client

STREAM_KEY = "events"


async def publish(event_type: str, data: dict):
    await redis_client.xadd(
        STREAM_KEY,
        {"type": event_type, "data": json.dumps(data, default=str)},
    )
```

- [ ] **Step 2: 이벤트 Consumer**

```python
# src/workers/event_consumer.py
import asyncio
import json

import redis.asyncio as redis

from src.config import settings
from src.services import cache_service

STREAM_KEY = "events"
GROUP_NAME = "board-consumers"
CONSUMER_NAME = "consumer-1"


async def consume():
    r = redis.from_url(settings.redis_url, decode_responses=True)

    try:
        await r.xgroup_create(STREAM_KEY, GROUP_NAME, id="0", mkstream=True)
    except redis.ResponseError:
        pass  # 이미 존재

    print(f"Event consumer started: {CONSUMER_NAME}")

    while True:
        try:
            messages = await r.xreadgroup(
                GROUP_NAME, CONSUMER_NAME,
                {STREAM_KEY: ">"}, count=10, block=5000,
            )
            for stream, entries in messages:
                for msg_id, fields in entries:
                    event_type = fields["type"]
                    data = json.loads(fields["data"])
                    await handle_event(event_type, data)
                    await r.xack(STREAM_KEY, GROUP_NAME, msg_id)
        except Exception as e:
            print(f"Consumer error: {e}")
            await asyncio.sleep(1)


async def handle_event(event_type: str, data: dict):
    if event_type in ("post.updated", "post.deleted"):
        await cache_service.invalidate_post(data["id"])
    elif event_type == "post.liked":
        await cache_service.invalidate_post(data["post_id"])


if __name__ == "__main__":
    asyncio.run(consume())
```

- [ ] **Step 3: Command API에서 이벤트 발행**

```python
# src/api/command/posts.py — 각 엔드포인트에 추가
from src.services import event_service

@router.post("", response_model=PostResponse, status_code=201)
async def create_post(data: PostCreate, db: AsyncSession = Depends(get_db)):
    post = await post_service.create_post(db, data)
    await event_service.publish("post.created", {"id": str(post.id), "title": post.title})
    return post
```

update, delete, like에도 동일하게 이벤트 발행 추가.

- [ ] **Step 4: docker-compose.yml에 Worker 추가**

```yaml
  event-consumer:
    build: .
    command: python -m src.workers.event_consumer
    environment: *app-env  # app과 동일한 환경변수
    depends_on: [db, redis]

  counter-sync:
    build: .
    command: python -m src.workers.counter_sync
    environment: *app-env
    depends_on: [db, redis]
```

- [ ] **Step 5: 이벤트 흐름 테스트**

```python
# tests/test_events.py
import pytest
from src.redis_client import redis_client


@pytest.mark.asyncio
async def test_event_published_on_create(client):
    await client.post(
        "/api/posts", json={"title": "Event", "content": "Test", "author": "a"}
    )
    messages = await redis_client.xrange("events", count=10)
    assert len(messages) > 0
    assert messages[-1][1]["type"] == "post.created"
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: Redis Streams event bus + consumer — async cache invalidation"
```

---

## Phase 7 완료 체크리스트

- [ ] 이벤트 발행 서비스 구현 (XADD)
- [ ] 이벤트 Consumer 구현 (XREADGROUP + ACK)
- [ ] Command API에서 모든 쓰기 후 이벤트 발행
- [ ] Consumer가 이벤트 처리 (캐시 무효화 등)
- [ ] docker-compose에 Worker 추가

**핵심 체감:**
- 동기 처리: 모든 후속 작업 끝나야 응답 → 느림
- 이벤트 분리: DB 저장만 동기, 나머지 비동기 → 응답 빠름

**다음:** [Phase 8 — 이미지 업로드](phase-08-image-upload.md)
