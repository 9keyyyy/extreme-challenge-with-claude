# Phase 7: CQRS + Event Bus — 읽기/쓰기 분리 + 비동기 처리

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans

**전제:** Phase 6 완료. CRUD + 캐시 + 카운터 + 멱등성이 모두 동작하는 상태.

**학습 키워드**
`CQRS` `Event-Driven Architecture` `Event Sourcing vs Event-Driven` `Redis Streams` `XADD/XREADGROUP` `Consumer Group` `Eventual Consistency` `Strong Consistency` `Back Pressure` `Dead Letter Queue` `Replication Lag`

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
