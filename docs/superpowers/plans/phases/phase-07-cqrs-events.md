# Phase 7: CQRS + Event Bus — 읽기/쓰기 분리 + 비동기 처리

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans

**전제:** Phase 6 완료. CRUD + 캐시 + 카운터 + 멱등성이 모두 동작하는 상태.

**학습 키워드**
`CQRS` `Event-Driven Architecture` `Event Sourcing vs Event-Driven` `Redis Streams` `XADD/XREADGROUP` `Consumer Group` `Eventual Consistency` `Strong Consistency` `Back Pressure` `Dead Letter Queue` `Replication Lag` `At-Least-Once Delivery` `Idempotent Consumer` `PG Streaming Replication` `Read-Your-Write Consistency` `WAL` `hot_standby`

---

## 학습: CQRS와 이벤트 버스

### 핵심 질문 — "CQRS를 왜 적용했나요?"

> "읽기/쓰기 트래픽 비율이 99:1인데 분리 안 하면 읽기용으로 늘린 서버 20대가 모두 쓰기 코드도 들고 다님. 규모 확장 비용이 20배가 되는 거임. 분리하면 Query 20대, Command 2대로 서로 다른 병목을 독립적으로 해결할 수 있음."

> **"이벤트 기반 아키텍처의 장단점은?"**

> "장점: 응답 지연을 핵심 작업(DB 저장) 시간으로만 잘라낼 수 있음. 서비스 간 결합도 낮아짐. 단점: Eventual Consistency — 이벤트 처리 전에 조회하면 구버전이 보임. 이걸 허용할지 말지는 비즈니스 요구사항에 따라 결정해야 함."

---

### CQRS — 왜 분리하는가 (스케일링 수학)

커뮤니티 게시판 트래픽: 읽기 99% / 쓰기 1%.

**분리 안 하면 — 낭비의 구체적 수치:**

서버 1대가 읽기 5만 RPS + 쓰기 500 RPS를 처리할 수 있다고 가정. 목표가 읽기 100만 RPS라면:
- 읽기 기준으로 서버 20대 필요
- 그런데 쓰기 코드도 같이 올라가서 쓰기도 서버 20대 분량
- 실제 쓰기 수요: 1만 RPS → 서버 2대면 충분
- **낭비: 서버 18대, 월 수천 달러**

쓰기 부하 급증 시나리오도 문제임. 이벤트가 터져서 쓰기가 폭증하면 읽기 서버 전체가 같이 느려짐. 서로 다른 병목이 같은 프로세스 안에 있어서.

**분리하면:**
- Query 서비스 20대 (읽기 최적화: 캐시 중심, DB connection 최소화)
- Command 서비스 2대 (쓰기 최적화: 트랜잭션 정합성 중심)
- 쓰기가 폭증해도 읽기는 영향 없음. 스케일링도 각자 독립.

**이건 코드 레벨 분리지, 서비스 분리가 아님.** 같은 앱 안에서 `api/command/`와 `api/query/` 디렉토리로 나눔. 나중에 필요하면 별도 서비스로 추출 가능. 처음부터 마이크로서비스로 쪼개는 건 오버엔지니어링임.

---

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

알림 서버가 장애 나면? 게시글 작성 자체가 실패함. 관심사가 완전히 다른 두 시스템이 강결합된 거임.

이벤트로 분리하면:
```python
async def create_post(data):
    await db.insert(data)                    # 5ms
    await redis.xadd("events", {...})        # 0.1ms
    return result                            # 총 5.1ms ← 유저는 여기서 응답
    # 나머지는 Worker가 비동기로 처리
```

알림 서버가 죽어도 게시글 작성은 성공함. 이벤트는 Redis Streams에 쌓여 있다가 알림 서버 복구되면 처리됨. **장애 격리**가 핵심.

---

### Event Sourcing vs Event-Driven — 가장 자주 헷갈리는 구분

이 두 개는 이름이 비슷하지만 전혀 다른 패턴임. 같이 쓸 수도 있지만 독립적임.

**Event-Driven Architecture (EDA) — 이 프로젝트에서 쓰는 것**

이벤트를 **통신 수단**으로 씀. 서비스 간 결합을 끊기 위해.

```
게시글 작성 → DB 저장 → "post.created" 이벤트 발행
                              ↓
                    [알림 Worker] 이벤트 소비 → 알림 전송
                    [캐시 Worker] 이벤트 소비 → 캐시 무효화
```

DB에는 현재 상태만 저장함 (`posts` 테이블에 최신 게시글 데이터). 이벤트는 "이런 일이 있었다"는 신호일 뿐, 나중에 버려도 됨.

**Event Sourcing — 전혀 다른 패턴**

이벤트를 **저장소**로 씀. 현재 상태 대신 "상태를 바꾼 이벤트들의 시퀀스"를 저장.

```
posts 테이블 없음. 대신:
event_store:
  - {id: 1, type: "PostCreated", data: {title: "첫 글"}, at: t1}
  - {id: 2, type: "PostUpdated", data: {title: "수정 글"}, at: t2}
  - {id: 3, type: "PostLiked",   data: {user: "kim"},    at: t3}

"현재 상태" = 이벤트들을 처음부터 재생(replay)해서 만들어냄
```

장점: 완전한 변경 이력, 특정 시점으로 롤백 가능, 감사(audit) 로그 자동 생성.
단점: 구현 복잡도 엄청남. 이벤트 수백만 개 쌓이면 replay가 느려서 Snapshot 필요.

**이 프로젝트에서 Event Sourcing 안 쓰는 이유:** $100 예산에 1M RPS 구현이 목표임. Event Sourcing은 도메인 복잡도가 높은 금융/결제 시스템에 적합. 게시판에 쓰면 오버엔지니어링 + 성능 문제.

| 구분 | Event-Driven | Event Sourcing |
|------|-------------|----------------|
| 목적 | 서비스 간 통신 분리 | 상태를 이벤트로 저장 |
| DB 구조 | 현재 상태 저장 (posts 테이블) | 이벤트 로그가 유일한 진실 |
| 이벤트 보존 | 처리 후 버려도 됨 | 영구 보존 필수 |
| 복잡도 | 보통 | 높음 (Snapshot, Projection 필요) |
| 적합한 도메인 | 대부분 서비스 | 금융, 감사가 중요한 도메인 |

---

### Redis Streams — 왜 Kafka가 아닌 Redis인가 (그리고 Kafka가 맞는 때)

| 기준 | Redis Streams | Kafka | SQS |
|------|-------------|-------|-----|
| 추가 인프라 | 없음 (이미 Redis 사용중) | Kafka 클러스터 + ZooKeeper | AWS 종속 |
| 처리량 | ~100만 msg/s | ~수백만 msg/s | ~3000 msg/s (FIFO) |
| 비용 | $0 추가 | MSK $200+/월 | 요청당 과금 |
| 로컬 개발 | Docker Redis 하나 | Docker 3개+ | LocalStack |
| Consumer Group | XREADGROUP | 핵심 기능 | Visibility Timeout |
| 메시지 보존 | 설정 가능 (MAXLEN) | 디스크 기반 장기 보존 | 최대 14일 |
| 재처리/replay | 제한적 | 강력 (offset 기반) | 없음 |

**이 프로젝트에서 Redis 선택한 이유:**

1. **인프라 이미 있음.** Phase 3부터 Redis를 캐시로, Phase 5에서 카운터로 쓰고 있음. Kafka 추가하면 Docker Compose에 ZooKeeper + Kafka + Schema Registry 3개 더 뜨고, 월 $200 이상 추가.
2. **처리량 충분.** 이 서비스의 이벤트는 게시글 쓰기/수정/삭제/좋아요. 1M RPS에서 쓰기 비율 1%면 초당 1만 이벤트. Redis Streams는 이걸 가볍게 처리함.
3. **$100 예산.** Kafka MSK 최소 구성이 월 $150+임.

**Kafka가 맞는 상황:**
- 이벤트를 수일~수주 보존해서 새 Consumer가 처음부터 replay해야 할 때
- 여러 독립 팀의 서비스들이 같은 이벤트를 각자 소비해야 할 때 (Consumer Group 복잡성)
- 초당 수백만 이벤트 규모로 Redis가 병목이 될 때
- 이벤트 순서 보장이 파티션 레벨에서 엄격하게 필요할 때

**한 줄 기준:** "같은 Redis 서버에 캐시도 있고 이벤트도 처리량이 감당 가능한 수준이면 Redis Streams. 그 이상이거나 장기 보존/replay가 필요하면 Kafka."

---

### Eventual Consistency (최종 정합성) — 유저가 실제로 겪는 문제

**문제의 실체:**

CQRS + 이벤트 구조에서 글을 수정하면 이런 흐름임:

```
유저: 글 수정 요청
  → Command 서비스: DB 업데이트 (5ms)
  → 이벤트 발행: "post.updated" (0.1ms)
  → 응답 반환 ← 유저는 여기서 수정 완료로 인식

  (이벤트 처리 중...)
  → Consumer: 이벤트 소비 + 캐시 무효화 (수십ms 후)

만약 유저가 응답 받자마자 바로 조회하면?
  → Query 서비스: 캐시 HIT → 구버전 데이터 반환
  → 유저: "방금 수정했는데 왜 안 바뀌어??"
```

이게 Eventual Consistency의 실체임. 이벤트가 처리되기 전 짧은 시간 동안 캐시가 구버전임.

**Strong Consistency vs Eventual Consistency:**

- **Strong Consistency:** 쓰기 완료 후 어떤 읽기도 항상 최신 데이터 반환. PostgreSQL 단일 서버에서 쓰고 바로 읽으면 이게 보장됨.
- **Eventual Consistency:** 쓰기 후 "결국은" 최신 데이터가 됨. 언제? 이벤트 처리 + 캐시 갱신 완료되면. 그 사이엔 구버전이 보일 수 있음.

**해결책 — Write-후-Read 보장 (Read-Your-Writes):**

핵심 인사이트: 글을 수정한 **본인**한테 구버전이 보이면 버그처럼 느껴짐. **다른 사람**한테 잠깐 구버전이 보이는 건 허용 가능한 수준임.

```python
# Command 서비스: 글 수정 후
async def update_post(post_id, data, current_user_id):
    await db.update(post_id, data)
    await event_service.publish("post.updated", {"id": post_id})

    # 쓴 사람한테는 즉시 캐시 무효화 (이벤트 처리 기다리지 않음)
    await cache_service.invalidate_post(post_id)

    return await db.get_post(post_id)  # DB에서 직접 읽어서 반환

# Query 서비스: 다른 사람이 조회할 때
async def get_post(post_id):
    cached = await cache.get(post_id)
    if cached:
        return cached  # 잠깐 구버전이어도 허용
    return await db.get_post(post_id)
```

이렇게 하면 글 수정한 본인은 항상 최신 데이터를 받고, 다른 사람은 캐시가 무효화될 때까지 (이벤트 처리 완료 시) 구버전이 보일 수 있음. 실제로 수십ms 수준이라 대부분 허용 가능.

**DB별 Eventual Consistency 발생 지점:**

- **PostgreSQL:** 단일 서버에서 Strong. Read Replica에서 읽으면 Eventual (replication lag). 트래픽 분산 위해 Replica 쓰는 순간부터 이 문제 생김.
- **MySQL:** 동일. Semi-sync replication으로 lag 줄일 수 있지만 완전 제거는 불가.
- **MongoDB:** readConcern "majority" = Strong (Primary에서 확인 후 반환), "local" = Eventual (Replica에서 바로 반환). 유연하게 선택 가능.

**핵심 트레이드오프:** "Eventual Consistency를 허용하는 대신 뭘 얻나?" → 읽기 서버를 DB와 분리해서 캐시 계층을 둘 수 있음. 캐시 히트율 99%면 DB 부하가 1/100으로 줄고, 이게 1M RPS를 감당하는 핵심.

---

### 심화 학습 — 더 깊이 파볼 키워드

| 키워드 | 왜 알아야 하는지 | 실무 관련성 |
|--------|----------------|------------|
| **Event Sourcing vs Event-Driven** | 혼용하면 개념을 정확히 모르는 거임. 위 섹션에서 차이점 정리해둠 | 아키텍처 설계 논의 시 |
| **Dead Letter Queue (DLQ)** | Consumer가 이벤트 처리 3번 실패하면 DLQ로 이동. 재처리나 수동 디버깅에 필수. 없으면 실패 이벤트가 영원히 재시도되거나 조용히 사라짐 | 프로덕션 운영 필수 |
| **Back Pressure** | Consumer가 초당 100개 처리 가능한데 Producer가 초당 1000개 발행하면? XLEN으로 큐 길이 모니터링하고 Producer 속도 제한 or Consumer 수평 확장 | 트래픽 폭증 시 대응 |
| **Saga Pattern** | 여러 서비스 걸쳐 트랜잭션 관리. 예: 주문(상품서비스 재고 차감 + 결제서비스 결제 + 배송서비스 배송 생성). CQRS + Event와 자주 함께 사용. 보상 트랜잭션 개념 필수 | 마이크로서비스 전환 시 |
| **Replication Lag** | Read Replica에서 읽을 때 발생하는 지연. Eventual Consistency의 실제 원인. `SHOW SLAVE STATUS`로 확인 가능. 수ms~수초까지 발생 | DB 스케일아웃 시 |
| **XPENDING / XCLAIM** | 처리 안 된 메시지 확인 + 다른 Consumer에게 재할당. Consumer 장애로 ACK 못 한 메시지 복구에 필수 | Consumer 장애 대응 |

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
import os

from src.redis_client import init_redis, redis_client
from src.services import cache_service

STREAM_KEY = "events"
GROUP_NAME = "board-consumers"
# 멀티 Consumer 지원 — 각 인스턴스가 고유 이름을 가져야 Consumer Group 내에서 메시지 분배됨
CONSUMER_NAME = os.getenv("CONSUMER_NAME", "consumer-1")


async def consume():
    await init_redis()  # Sentinel 대응 — Phase 4.5에서 설정한 redis_client 사용

    try:
        await redis_client.xgroup_create(STREAM_KEY, GROUP_NAME, id="0", mkstream=True)
    except Exception:
        pass  # 이미 존재

    print(f"Event consumer started: {CONSUMER_NAME}")

    while True:
        try:
            messages = await redis_client.xreadgroup(
                GROUP_NAME, CONSUMER_NAME,
                {STREAM_KEY: ">"}, count=10, block=5000,
            )
            for stream, entries in messages:
                for msg_id, fields in entries:
                    event_type = fields["type"]
                    data = json.loads(fields["data"])
                    await handle_event(event_type, data)
                    await redis_client.xack(STREAM_KEY, GROUP_NAME, msg_id)
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

### Task 15A: Consumer 중복 처리 체험

> **전제:** Task 15 완료 + Phase 4.5 분산 환경 동작.

**학습 키워드 추가**
`At-Least-Once Delivery` `Idempotent Consumer` `XPENDING` `XCLAIM` `Message Redelivery`

**Files:**
- Modify: `docker-compose.distributed.yml` (Consumer 2대 구성)
- Create: `tests/test_distributed_events.py`

#### 학습: Consumer 중복 처리가 불가피한 이유

**At-Least-Once Delivery의 본질:**

Redis Streams Consumer Group의 동작 순서:
```
1. XREADGROUP → 메시지 수신 (Consumer에 할당됨)
2. 비즈니스 로직 처리
3. XACK → "처리 완료" 확인
```

**문제: 2번과 3번 사이에 Consumer가 죽으면?**
```
Consumer A: XREADGROUP → msg-123 수신
Consumer A: handle_event() 실행 (캐시 무효화 완료)
Consumer A: ☠️ 프로세스 크래시 (XACK 전에 죽음)

→ msg-123는 "Pending" 상태로 남음 (처리됐지만 ACK 안 됨)
→ Consumer A 재시작 or Consumer B가 XCLAIM으로 가져감
→ msg-123 재처리 → 같은 이벤트가 2번 처리됨
```

이건 Redis Streams만의 문제가 아님. **모든 메시지 시스템이 동일:**
- Kafka: offset commit 전 crash → 재처리
- SQS: visibility timeout 후 재전송 → 재처리
- RabbitMQ: ACK 전 crash → 재큐잉 → 재처리

**"그러면 처리 전에 ACK하면?"** → 처리 실패해도 ACK됨 → 메시지 유실. At-Most-Once. 대부분의 시스템에서 유실보다 중복이 낫기 때문에 At-Least-Once를 선택함.

**커머스 매핑:**
- 주문 이벤트 Consumer가 "재고 차감" 처리 후 ACK 전에 죽음
- 재시작 → 같은 주문 이벤트 재처리 → 재고 한 번 더 차감 → 재고 마이너스
- 해결: Consumer의 handler가 멱등해야 함 (이미 차감했으면 무시)

**Consumer 중복 방지 전략 비교:**

| 선택지 | 적합한 상황 | 부적합한 상황 |
|--------|-----------|-------------|
| 멱등한 핸들러 설계 | 연산 자체가 멱등 가능 (캐시 삭제, UPSERT) | 자연적 멱등성이 없는 연산 (외부 API, 이메일) |
| 처리 이력 테이블 | 멱등 설계가 어렵고 exactly-once 필요 | 모든 이벤트마다 DB 조회 — 처리량 병목 |
| Redis SET NX 체크 | 빠른 중복 필터. 이력 테이블 대신 | Redis 장애 시 중복 통과. 단독 의존 X |

이 프로젝트의 이벤트 핸들러(캐시 무효화)는 **자연적으로 멱등**임 — 같은 캐시를 2번 삭제해도 결과 동일. 하지만 카운터 증감처럼 비멱등 연산이 핸들러에 있으면 문제가 됨. Task 15A에서 둘 다 체험.

---

- [ ] **Step 1: Distributed Compose에 Consumer 2대 구성**

```yaml
# docker-compose.distributed.yml — 기존 event-consumer 서비스 삭제 후 아래 2개로 교체
  event-consumer-1:
    build: .
    command: python -m src.workers.event_consumer
    environment:
      <<: *app-env
      CONSUMER_NAME: consumer-1
    depends_on: [db, redis-primary]
    profiles: ["core"]

  event-consumer-2:
    build: .
    command: python -m src.workers.event_consumer
    environment:
      <<: *app-env
      CONSUMER_NAME: consumer-2
    depends_on: [db, redis-primary]
    profiles: ["core"]
```

**Phase 4.5에서 만든 기존 `event-consumer` 서비스를 삭제**하고 위 2개로 교체. `CONSUMER_NAME` 환경변수로 각 인스턴스가 Consumer Group 내에서 고유 식별됨.

- [ ] **Step 2: Consumer Group 분배 + 재처리 테스트**

```python
# tests/test_distributed_events.py
"""Consumer 중복 처리 체험 — At-Least-Once에서 중복은 불가피.

conftest.py에서 init_redis() 호출 필요.
"""
import asyncio
import json
import pytest

from src.redis_client import redis_client

STREAM_KEY = "events"
GROUP_NAME = "test-consumers"


@pytest.fixture(autouse=True)
async def clean_stream():
    """테스트 전 스트림/그룹 초기화"""
    try:
        await redis_client.delete(STREAM_KEY)
    except Exception:
        pass
    yield
    try:
        await redis_client.delete(STREAM_KEY)
    except Exception:
        pass


@pytest.mark.asyncio
async def test_consumer_group_distributes_messages():
    """Consumer Group — 2명이 메시지를 나눠 가짐"""
    # 그룹 생성
    await redis_client.xgroup_create(STREAM_KEY, GROUP_NAME, id="0", mkstream=True)

    # 이벤트 10개 발행
    for i in range(10):
        await redis_client.xadd(
            STREAM_KEY,
            {"type": "post.created", "data": json.dumps({"id": str(i)})},
        )

    # Consumer A가 읽기
    msgs_a = await redis_client.xreadgroup(
        GROUP_NAME, "consumer-a", {STREAM_KEY: ">"}, count=10, block=1000,
    )
    # Consumer B가 읽기
    msgs_b = await redis_client.xreadgroup(
        GROUP_NAME, "consumer-b", {STREAM_KEY: ">"}, count=10, block=1000,
    )

    count_a = sum(len(entries) for _, entries in msgs_a) if msgs_a else 0
    count_b = sum(len(entries) for _, entries in msgs_b) if msgs_b else 0

    assert count_a + count_b == 10, f"Total should be 10, got {count_a} + {count_b}"
    print(f"Consumer A: {count_a} messages, Consumer B: {count_b} messages")


@pytest.mark.asyncio
async def test_unacked_message_redelivery():
    """ACK 안 한 메시지는 Pending 상태로 남아서 재처리 대상이 됨."""
    await redis_client.xgroup_create(STREAM_KEY, GROUP_NAME, id="0", mkstream=True)

    # 이벤트 발행
    msg_id = await redis_client.xadd(
        STREAM_KEY,
        {"type": "post.updated", "data": json.dumps({"id": "123"})},
    )

    # Consumer A가 읽음 — ACK 안 함 (crash 시뮬레이션)
    msgs = await redis_client.xreadgroup(
        GROUP_NAME, "consumer-a", {STREAM_KEY: ">"}, count=1, block=1000,
    )
    assert len(msgs) > 0, "Consumer A should have received the message"

    # Pending 목록 확인 — msg_id가 consumer-a에 할당된 상태
    pending = await redis_client.xpending_range(
        STREAM_KEY, GROUP_NAME, min="-", max="+", count=10,
    )
    assert len(pending) == 1
    assert pending[0]["consumer"] == b"consumer-a" or pending[0]["consumer"] == "consumer-a"
    print(f"Pending: {pending[0]}")

    # Consumer B가 XCLAIM으로 메시지 가져감 (consumer-a가 죽었다고 판단)
    claimed = await redis_client.xclaim(
        STREAM_KEY, GROUP_NAME, "consumer-b",
        min_idle_time=0,  # 테스트에서는 즉시 claim
        message_ids=[pending[0]["message_id"]],
    )
    assert len(claimed) == 1
    print(f"Consumer B claimed: {claimed[0]}")

    # Consumer B가 처리 후 ACK
    await redis_client.xack(STREAM_KEY, GROUP_NAME, claimed[0][0])
    pending_after = await redis_client.xpending_range(
        STREAM_KEY, GROUP_NAME, min="-", max="+", count=10,
    )
    assert len(pending_after) == 0, "ACK 후 pending 비어야 함"
```

Run: `pytest tests/test_distributed_events.py -v`

- [ ] **Step 3: 비멱등 핸들러 → 이중 처리 문제 확인**

```python
# tests/test_distributed_events.py에 추가

# 비멱등 카운터 — 호출될 때마다 증가
non_idempotent_counter: dict[str, int] = {}


async def handle_non_idempotent(event_type: str, data: dict):
    """멱등하지 않은 핸들러 — 호출될 때마다 카운터 증가"""
    post_id = data.get("id") or data.get("post_id")
    non_idempotent_counter[post_id] = non_idempotent_counter.get(post_id, 0) + 1


@pytest.mark.asyncio
async def test_non_idempotent_handler_double_processing():
    """비멱등 핸들러 — 같은 이벤트 2번 처리하면 카운터 2번 증가"""
    non_idempotent_counter.clear()
    event_data = {"id": "post-789"}

    # 같은 이벤트를 2번 처리 (ACK 전 crash → 재처리 시뮬레이션)
    await handle_non_idempotent("post.liked", event_data)
    await handle_non_idempotent("post.liked", event_data)

    assert non_idempotent_counter["post-789"] == 2, "비멱등 핸들러: 2번 호출 = 카운터 2"
    print(f"Non-idempotent: counter = {non_idempotent_counter['post-789']} (should be 1)")
```

- [ ] **Step 4: 멱등 핸들러로 수정 → 재처리해도 결과 동일**

```python
# tests/test_distributed_events.py에 추가

# 멱등 카운터 — 처리 이력을 기억해서 중복 무시
idempotent_counter: dict[str, int] = {}
processed_events: set[str] = set()


async def handle_idempotent(event_type: str, data: dict, event_id: str):
    """멱등한 핸들러 — event_id로 중복 체크. 이미 처리했으면 무시."""
    if event_id in processed_events:
        return  # 이미 처리됨 — 스킵
    post_id = data.get("id") or data.get("post_id")
    idempotent_counter[post_id] = idempotent_counter.get(post_id, 0) + 1
    processed_events.add(event_id)


@pytest.mark.asyncio
async def test_idempotent_handler_safe_from_redelivery():
    """멱등 핸들러 — 같은 이벤트 2번 처리해도 카운터 1번만 증가"""
    idempotent_counter.clear()
    processed_events.clear()
    event_data = {"id": "post-789"}
    event_id = "msg-001"  # Redis Streams의 메시지 ID

    # 같은 이벤트를 2번 처리
    await handle_idempotent("post.liked", event_data, event_id)
    await handle_idempotent("post.liked", event_data, event_id)

    assert idempotent_counter["post-789"] == 1, "멱등 핸들러: 2번 호출해도 카운터 1"
    print(f"Idempotent: counter = {idempotent_counter['post-789']} (correctly 1)")
```

Run: `pytest tests/test_distributed_events.py -v`

- [ ] **Step 5: Commit**

```bash
git add tests/test_distributed_events.py docker-compose.distributed.yml src/workers/event_consumer.py
git commit -m "test: consumer duplicate processing — at-least-once redelivery + idempotent handler"
```

---

### Task 15B: PG Replica + Read-Your-Write 라우팅

> **전제:** Task 15A 완료. Phase 4.5의 `--profile replica` 사용.

**학습 키워드 추가**
`PG Streaming Replication` `WAL (Write-Ahead Log)` `Read-Your-Write Consistency` `Session Routing` `Replication Lag`

**Files:**
- Modify: `docker-compose.distributed.yml` (REPLICA_DATABASE_URL 추가)
- Modify: `src/database.py` (replica 세션 팩토리 추가)
- Create: `src/middleware/read_your_write.py`
- Create: `src/dependencies/db.py` (읽기용 DB 의존성)
- Modify: `src/api/query/posts.py` (replica 세션 사용)
- Modify: `src/main.py` (미들웨어 등록)
- Create: `tests/test_replication.py`

#### 학습: PG Streaming Replication + Read-Your-Write

**PG Replication 원리:**

```
Client → Primary (read/write)
            │
            │ WAL Stream (Write-Ahead Log)
            ↓
         Replica (read only)
```

Primary에서 일어나는 모든 변경은 WAL에 기록됨. WAL은 변경 사항의 바이트 레벨 로그임. Replica는 이 WAL을 실시간으로 수신해서 자기 데이터에 적용(replay)함.

**Replication Lag — 왜 발생하는가:**
1. 네트워크 지연: Primary → Replica 전송에 시간이 걸림 (보통 수ms)
2. Replica 부하: Replica에서 읽기 쿼리가 많으면 WAL 적용이 밀림
3. 디스크 I/O: WAL 적용은 디스크 쓰기를 수반함

결과: Primary에서 write 직후 Replica에서 read하면 아직 반영 안 된 구버전이 보임.

**PG Replication 선택지 비교:**

| 선택지 | 장점 | 단점 | 판정 |
|--------|------|------|------|
| Streaming Replication | PG 내장, 추가 도구 불필요, 바이트 레벨 복제 | replica는 읽기 전용, failover 수동 | **선택** — 개념 학습에 적합 |
| Logical Replication | 테이블 단위 선택적 복제, 버전 달라도 됨 | 설정 복잡, DDL 안 따라감 | 전체 DB 복제라 불필요 |
| Patroni + etcd | 자동 failover, HA 클러스터 | 컨테이너 3개 추가, 복잡도 높음 | 리소스 과다 |

**Read-Your-Write Consistency:**

"내가 쓴 건 내가 바로 볼 수 있어야 한다."

| 선택지 | 적합한 상황 | 부적합한 상황 |
|--------|-----------|-------------|
| 쓴 사람은 primary 읽기 (쿠키 `last_write_at`) | 가장 실용적, 구현 간단 | write 빈도 극단적이면 primary 부하 집중 |
| Synchronous Replication | lag 0 보장 절대적 필요 (결제) | write 성능 저하 심각, replica 다운 시 primary 멈춤 |
| 캐시로 우회 | 이미 캐시 계층 있는 경우 보조 수단 | 캐시 무효화 타이밍 문제가 또 생김 |

커머스 매핑: 주문 후 "내 주문 내역"에 안 보이면 고객 패닉 → read-your-write 필수.

---

- [ ] **Step 1: Compose에 REPLICA_DATABASE_URL 추가 + Replica 실행**

```yaml
# docker-compose.distributed.yml — x-app-env에 추가
x-app-env: &app-env
  DATABASE_URL: postgresql+asyncpg://postgres:postgres@db:5432/extreme_board
  # db-replica는 --profile replica 활성화 시에만 실행.
  # replica 없이 실행하면 앱이 fallback으로 primary만 사용.
  REPLICA_DATABASE_URL: postgresql+asyncpg://postgres:postgres@db-replica:5432/extreme_board
  REDIS_SENTINEL_HOSTS: sentinel-1:26379,sentinel-2:26379,sentinel-3:26379
  REDIS_SENTINEL_MASTER: mymaster
  MINIO_ENDPOINT: minio:9000
  MINIO_ACCESS_KEY: minioadmin
  MINIO_SECRET_KEY: minioadmin
```

```bash
# Replica 포함 실행
docker compose -f docker-compose.distributed.yml --profile core --profile replica up -d

# Replica 상태 확인
docker compose -f docker-compose.distributed.yml exec db-replica \
  psql -U postgres -c "SELECT pg_is_in_recovery();"
# 예상: t (true = replica 모드)
```

- [ ] **Step 2: database.py에 replica 세션 팩토리 추가**

```python
# src/database.py — 기존 코드 하단에 추가
import os

REPLICA_DATABASE_URL = os.getenv("REPLICA_DATABASE_URL", "")

# Replica 세션 — REPLICA_DATABASE_URL이 설정되어 있으면 별도 엔진 생성
# 설정 안 되어 있거나 replica가 안 떠 있으면 primary로 fallback
async_session_replica = None

if REPLICA_DATABASE_URL:
    from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

    replica_engine = create_async_engine(
        REPLICA_DATABASE_URL,
        pool_pre_ping=True,  # 연결 끊김 자동 감지
    )
    async_session_replica = async_sessionmaker(
        replica_engine, expire_on_commit=False
    )
```

- [ ] **Step 3: Read-Your-Write 미들웨어**

```python
# src/middleware/read_your_write.py
"""Read-Your-Write Consistency 미들웨어.

write 요청 시 쿠키에 timestamp 기록.
read 요청 시 쿠키 확인 → 최근 write했으면 primary에서 읽도록 플래그 설정.
실제 DB 세션 선택은 dependency에서 이 플래그를 보고 결정함.
"""
import time

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

WRITE_METHODS = {"POST", "PUT", "DELETE", "PATCH"}
LAG_WINDOW = 5  # 초 — replication이 따라잡을 시간. 보수적으로 5초.


class ReadYourWriteMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        # 최근 write 여부를 request.state에 기록 (dependency에서 참조)
        last_write = request.cookies.get("last_write_at")
        request.state.use_primary = False
        if last_write:
            try:
                if time.time() - float(last_write) < LAG_WINDOW:
                    request.state.use_primary = True
            except ValueError:
                pass

        response = await call_next(request)

        # write 요청 성공 시 쿠키 설정
        if request.method in WRITE_METHODS and response.status_code < 400:
            response.set_cookie(
                "last_write_at",
                str(time.time()),
                max_age=LAG_WINDOW,
                httponly=True,
            )

        return response
```

- [ ] **Step 4: 읽기용 DB 의존성**

```python
# src/dependencies/db.py
"""읽기/쓰기 DB 세션 분리 의존성.

write 의존성: 항상 primary
read 의존성: use_primary 플래그에 따라 primary or replica
"""
from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import async_session, async_session_replica


async def get_write_db():
    """쓰기 전용 — 항상 primary."""
    async with async_session() as session:
        yield session


async def get_read_db(request: Request):
    """읽기 전용 — 최근 write한 유저는 primary, 아니면 replica.

    replica가 설정 안 되어 있으면 항상 primary 사용.
    """
    use_primary = getattr(request.state, "use_primary", True)
    factory = async_session if (use_primary or not async_session_replica) else async_session_replica

    async with factory() as session:
        yield session
```

- [ ] **Step 5: Query API를 replica 세션으로 수정**

```python
# src/api/query/posts.py — Depends(get_db) → Depends(get_read_db)로 변경
from src.dependencies.db import get_read_db

@router.get("/{post_id}", response_model=PostResponse)
async def get_post(post_id: uuid.UUID, db: AsyncSession = Depends(get_read_db)):
    # 기존 로직 동일 — 세션만 replica에서 올 수 있음
    ...
```

Command API는 기존 `Depends(get_db)`를 `Depends(get_write_db)`로 교체. 기존 `get_db`가 `src/database.py`에 정의되어 있었다면, `src/dependencies/db.py`의 `get_write_db`가 동일 역할을 하므로 기존 것은 deprecated 처리하거나 import 경로만 변경.

- [ ] **Step 6: main.py에 미들웨어 등록**

```python
# src/main.py
from src.middleware.read_your_write import ReadYourWriteMiddleware

app.add_middleware(ReadYourWriteMiddleware)
```

- [ ] **Step 7: Replication lag 체감 테스트**

```python
# tests/test_replication.py
"""PG Replication Lag + Read-Your-Write 체감 테스트.

--profile replica 활성화 상태에서 실행.
"""
import asyncio
import httpx
import pytest

NGINX_URL = "http://localhost"


@pytest.mark.asyncio
async def test_replication_lag_visible():
    """write 직후 replica에서 read → 구버전 보일 수 있음 확인.

    이 테스트는 replication lag의 존재를 보여주는 것이 목적.
    lag은 환경에 따라 수ms~수백ms이므로, 실패 가능성이 있음 (lag이 매우 짧으면).
    """
    async with httpx.AsyncClient() as client:
        # 1. 게시글 생성
        r = await client.post(
            f"{NGINX_URL}/api/posts",
            json={"title": "Lag Test", "content": "Original", "author": "tester"},
            headers={"Idempotency-Key": f"lag-test-{asyncio.get_event_loop().time()}"},
        )
        assert r.status_code == 201
        post_id = r.json()["id"]

        # 2. 즉시 수정
        await client.put(
            f"{NGINX_URL}/api/posts/{post_id}",
            json={"title": "Lag Test Updated", "content": "Modified"},
        )

        # 3. 쿠키 없이 즉시 읽기 → replica로 라우팅 → 구버전 가능
        # (쿠키를 일부러 보내지 않음)
        r_read = await client.get(f"{NGINX_URL}/api/posts/{post_id}")
        title = r_read.json()["title"]
        print(f"Read without cookie: title='{title}'")
        # lag이 있으면 "Lag Test" (구버전), 없으면 "Lag Test Updated" (최신)
        # 어느 쪽이든 PASS — lag의 존재를 관찰하는 것이 목적


@pytest.mark.asyncio
async def test_read_your_write_consistency():
    """last_write_at 쿠키가 있으면 primary에서 읽어서 항상 최신 데이터."""
    async with httpx.AsyncClient() as client:
        # 1. 게시글 생성 (응답에서 last_write_at 쿠키 받음)
        r = await client.post(
            f"{NGINX_URL}/api/posts",
            json={"title": "RYW Test", "content": "Original", "author": "tester"},
            headers={"Idempotency-Key": f"ryw-test-{asyncio.get_event_loop().time()}"},
        )
        assert r.status_code == 201
        post_id = r.json()["id"]
        # 쿠키 자동 저장됨 (httpx client가 쿠키 관리)

        # 2. 수정 (쿠키 갱신)
        await client.put(
            f"{NGINX_URL}/api/posts/{post_id}",
            json={"title": "RYW Updated", "content": "Modified"},
        )

        # 3. 쿠키 포함하여 읽기 → primary로 라우팅 → 항상 최신
        r_read = await client.get(f"{NGINX_URL}/api/posts/{post_id}")
        assert r_read.json()["title"] == "RYW Updated", \
            "Read-Your-Write 실패: 본인이 수정했는데 구버전이 보임"
        print("Read-Your-Write: 수정 직후 최신 데이터 확인 ✓")
```

Run: `pytest tests/test_replication.py -v`

- [ ] **Step 8: Commit**

```bash
git add src/database.py src/middleware/read_your_write.py src/dependencies/db.py \
  src/api/query/posts.py src/main.py tests/test_replication.py \
  docker-compose.distributed.yml
git commit -m "feat: PG replica + read-your-write routing — session split by last_write_at cookie"
```

---

### Task 15C: Eventual Consistency Lag 측정

> **전제:** Task 15B 완료. PG Replica + Read-Your-Write가 동작하는 상태.

**Files:**
- Create: `tests/test_consistency_lag.py`

#### 학습: Eventual Consistency의 "Eventual"은 얼마나 되는가

"최종 정합성"이라고 하는데, "최종"이 1ms인지 10초인지에 따라 완전히 다른 이야기임. 이걸 실제로 측정해서 감을 잡는 것이 목적.

**Lag에 영향을 주는 요인:**
1. **네트워크 지연:** Docker 내부 네트워크 = 거의 0. 실제 프로덕션 AZ간 = 수ms
2. **Replica 부하:** 읽기 쿼리가 많으면 WAL 적용이 밀림
3. **WAL 크기:** 대량 write가 한꺼번에 들어오면 replica가 따라잡는 데 시간 걸림
4. **Consumer 처리 지연:** 이벤트 기반 캐시 무효화의 경우, Consumer가 밀리면 캐시 lag도 늘어남

---

- [ ] **Step 1: Replication Lag 정밀 측정**

```python
# tests/test_consistency_lag.py
"""Eventual Consistency 측정 — Replication Lag + Consumer Lag.

--profile replica 활성화 + Consumer 2대 실행 상태에서 실행.
"""
import asyncio
import time
import httpx
import pytest

NGINX_URL = "http://localhost"


@pytest.mark.asyncio
async def test_replication_lag_measurement():
    """write 후 interval별 replica read → 최신 데이터 보이는 비율 측정.

    PG WAL replication lag을 직접 체감하는 테스트.
    """
    intervals_ms = [0, 10, 50, 100, 200, 500]
    results: dict[int, dict] = {}

    async with httpx.AsyncClient() as client:
        for interval in intervals_ms:
            visible_count = 0
            total = 10  # 각 interval에서 10회 반복

            for i in range(total):
                # 게시글 생성
                r = await client.post(
                    f"{NGINX_URL}/api/posts",
                    json={
                        "title": f"Lag {interval}ms #{i}",
                        "content": "test",
                        "author": "lag-tester",
                    },
                    headers={
                        "Idempotency-Key": f"lag-{interval}-{i}-{time.time()}"
                    },
                )
                assert r.status_code == 201
                post_id = r.json()["id"]

                # interval만큼 대기
                if interval > 0:
                    await asyncio.sleep(interval / 1000)

                # 쿠키 없이 읽기 (replica 라우팅)
                # 새 client로 읽어야 last_write_at 쿠키 안 붙음
                async with httpx.AsyncClient() as reader:
                    r_read = await reader.get(f"{NGINX_URL}/api/posts/{post_id}")
                    if r_read.status_code == 200:
                        visible_count += 1

            results[interval] = {
                "visible": visible_count,
                "total": total,
                "pct": visible_count / total * 100,
            }

    print("\n=== Replication Lag Measurement ===")
    print(f"{'Interval':>10} | {'Visible':>7} | {'Total':>5} | {'Rate':>6}")
    print("-" * 40)
    for interval, data in sorted(results.items()):
        print(f"{interval:>8}ms | {data['visible']:>7} | {data['total']:>5} | {data['pct']:>5.1f}%")
    print()
    print("Visible < 100% at low intervals = replication lag 존재 확인")
    print("100% at higher intervals = lag이 해당 interval 이내에 수렴")


@pytest.mark.asyncio
async def test_pg_wal_lsn_diff():
    """pg_wal_lsn_diff()로 Primary-Replica 간 WAL 차이 직접 측정.

    이 값이 0이면 완전 동기, >0이면 replica가 뒤처진 바이트 수.
    """
    import asyncpg

    primary = await asyncpg.connect(
        "postgresql://postgres:postgres@localhost:5432/extreme_board"
    )
    # db-replica는 호스트에서 직접 접근하려면 포트 매핑 필요
    # docker-compose.distributed.yml에 db-replica ports: "5433:5432" 추가 필요
    replica = await asyncpg.connect(
        "postgresql://postgres:postgres@localhost:5433/extreme_board"
    )

    # Primary의 현재 WAL 위치
    primary_lsn = await primary.fetchval("SELECT pg_current_wal_lsn()")
    # Replica의 마지막 수신 WAL 위치
    replica_lsn = await replica.fetchval("SELECT pg_last_wal_receive_lsn()")

    if primary_lsn and replica_lsn:
        lag_bytes = await primary.fetchval(
            "SELECT pg_wal_lsn_diff($1, $2)", primary_lsn, replica_lsn
        )
        print(f"Primary LSN: {primary_lsn}")
        print(f"Replica LSN: {replica_lsn}")
        print(f"Lag: {lag_bytes} bytes")
    else:
        print(f"LSN values: primary={primary_lsn}, replica={replica_lsn}")

    await primary.close()
    await replica.close()
```

이 테스트에서 db-replica에 호스트에서 접근하려면 포트 매핑 필요:
```yaml
# docker-compose.distributed.yml — db-replica에 추가
  db-replica:
    ...
    ports:
      - "5433:5432"  # 호스트에서 replica 접근 (테스트/측정용)
```

Run: `pytest tests/test_consistency_lag.py -v -s`

- [ ] **Step 2: Consumer 처리 지연 시 캐시 lag 관찰**

```python
# tests/test_consistency_lag.py에 추가


@pytest.mark.asyncio
async def test_consumer_delay_cache_lag():
    """Consumer가 느리면 캐시 무효화도 지연됨을 관찰.

    이벤트 발행 → Consumer 처리 → 캐시 무효화 → 다음 read에서 최신 데이터.
    Consumer가 밀리면 이 체인 전체가 지연됨.
    """
    async with httpx.AsyncClient() as client:
        # 1. 게시글 생성
        r = await client.post(
            f"{NGINX_URL}/api/posts",
            json={"title": "Cache Lag Test", "content": "v1", "author": "tester"},
            headers={"Idempotency-Key": f"cache-lag-{time.time()}"},
        )
        post_id = r.json()["id"]

        # 2. 캐시에 올리기 (첫 번째 read)
        await client.get(f"{NGINX_URL}/api/posts/{post_id}")

        # 3. 수정 (이벤트 발행됨 → Consumer가 캐시 무효화할 것)
        await client.put(
            f"{NGINX_URL}/api/posts/{post_id}",
            json={"title": "Cache Lag Updated", "content": "v2"},
        )

        # 4. 즉시 읽기 — 캐시에 구버전이 남아있을 수 있음
        # (Consumer가 아직 이벤트를 처리 안 했으면)
        async with httpx.AsyncClient() as reader:
            r_immediate = await reader.get(f"{NGINX_URL}/api/posts/{post_id}")
            title_immediate = r_immediate.json()["title"]

        # 5. 1초 후 읽기 — Consumer가 처리했을 가능성 높음
        await asyncio.sleep(1)
        async with httpx.AsyncClient() as reader:
            r_delayed = await reader.get(f"{NGINX_URL}/api/posts/{post_id}")
            title_delayed = r_delayed.json()["title"]

        print(f"Immediate read: '{title_immediate}'")
        print(f"After 1s read:  '{title_delayed}'")
        print(f"Expected: 'Cache Lag Updated'")
        # title_immediate이 구버전이면 → Consumer lag 체감
        # title_delayed가 최신이면 → 1초 이내에 Consumer가 처리
```

Run: `pytest tests/test_consistency_lag.py -v -s`

- [ ] **Step 3: Commit**

```bash
git add tests/test_consistency_lag.py docker-compose.distributed.yml
git commit -m "test: eventual consistency measurement — replication lag + consumer cache lag"
```

---

## Phase 7 완료 체크리스트

- [ ] 이벤트 발행 서비스 구현 (XADD)
- [ ] 이벤트 Consumer 구현 (XREADGROUP + ACK, Sentinel 대응)
- [ ] Command API에서 모든 쓰기 후 이벤트 발행
- [ ] Consumer가 이벤트 처리 (캐시 무효화 등)
- [ ] docker-compose에 Worker 추가
- [ ] Consumer 2대 → Consumer Group 메시지 분배 확인
- [ ] ACK 전 crash → XPENDING + XCLAIM 재처리 확인
- [ ] 비멱등 핸들러 → 이벤트 2번 처리 시 카운터 2 (문제 체감)
- [ ] 멱등 핸들러 → 이벤트 2번 처리해도 카운터 1 (해결 확인)
- [ ] PG Replica 동작 확인 (`--profile replica`)
- [ ] Read-Your-Write 미들웨어 — 최근 write한 유저는 primary에서 read
- [ ] write 직후 replica read → 구버전 보일 수 있음 확인 (lag 체감)
- [ ] Replication lag interval별 측정 (0/10/50/100/200/500ms)
- [ ] Consumer 처리 지연 → 캐시 lag 관찰

**핵심 체감:**
- 동기 처리: 모든 후속 작업 끝나야 응답 → 느림
- 이벤트 분리: DB 저장만 동기, 나머지 비동기 → 응답 빠름
- Consumer crash → ACK 안 된 메시지는 재처리됨 → 핸들러 멱등성 필수
- DB downstream: 재처리 → UPSERT/DELETE IF EXISTS → 자연 멱등, 문제없음
- 카운터 downstream: 재처리 → +1 두 번 → 비멱등, 이력 체크 필요
- Replica read: 수ms lag 존재 → 본인 write 직후 읽기는 primary 필요
- Read-Your-Write: 쓴 사람만 primary, 나머지는 replica → 부하 분산 + UX 보장

**다음:** [Phase 8 — 이미지 업로드](phase-08-image-upload.md)
