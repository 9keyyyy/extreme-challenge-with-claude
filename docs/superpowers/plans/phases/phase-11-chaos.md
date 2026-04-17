# Phase 11: 장애 시뮬레이션 — Docker로 카오스 엔지니어링

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans

**전제:** Phase 10 완료. 부하 테스트 결과가 있는 상태.

**학습 키워드**
`Chaos Engineering` `Chaos Monkey (Netflix)` `Circuit Breaker` `Retry with Backoff` `Bulkhead Pattern` `Graceful Degradation` `Fallback` `SIGSTOP vs SIGTERM` `tc (traffic control)` `Mean Time To Recovery (MTTR)` `Blast Radius`

---

## 학습: 카오스 엔지니어링이란

### 핵심 질문 — "장애 대응 경험이 있나요?"

> "카오스 엔지니어링을 직접 구현해봤음. Redis를 강제로 죽이고, DB를 pause 상태로 만들고, 네트워크에 200ms 지연을 줬음. Redis가 죽어도 서비스는 DB 폴백으로 동작함을 확인했고, DB가 pause 되면 캐시된 읽기는 되지만 쓰기는 실패함을 검증했음. 장애 복구 후 자동으로 정상화되는지도 확인함."

> **"시스템 회복력을 어떻게 검증하나요?"**

> "Steady State Hypothesis 방식 — 먼저 정상 상태를 정의하고 (에러율 < 1%, p95 < 200ms), 장애를 주입하고, 장애 중/후에 이 상태가 유지/복구되는지 확인. 복구 시간(MTTR)을 측정해서 아키텍처 개선 지표로 씀."

---

### 카오스 엔지니어링이 필요한 이유 — "테스트 안 한 건 반드시 실패함"

소프트웨어의 머피의 법칙: **검증하지 않은 장애 시나리오는 반드시 최악의 타이밍에 발생함.**

일반적인 개발 프로세스: "Redis 연결 실패 시 예외처리 있으니까 괜찮겠지" → 론칭 첫날 Redis 메모리 부족으로 다운 → 예외처리 코드에 버그 있어서 앱 전체 크래시.

Netflix가 Chaos Monkey를 만든 이유가 이거임. 프로덕션에서 직접 서버를 랜덤으로 죽여봄으로써:
1. 알고 있던 취약점을 조기에 발견
2. 팀이 장애에 익숙해져서 실제 장애 시 패닉 없음
3. "우리는 이 장애를 이미 테스트했음"이라는 자신감

---

### Docker stop vs pause — 어느 쪽이 더 위험한가

| | docker stop | docker pause |
|---|---|---|
| 효과 | 프로세스 완전 종료 | 프로세스 일시정지 (SIGSTOP) |
| 시뮬레이션 | 서버 다운 | 네트워크 행 (응답 없음) |
| 차이 | 커넥션이 즉시 끊김 | 커넥션이 열려있는데 응답 안 옴 |
| 실제 상황 | EC2 인스턴스 종료 | 디스크 I/O 포화, GC 폭발, 네트워크 파티션 |
| 감지 속도 | 즉시 (TCP RST) | 타임아웃까지 기다려야 함 |

**`pause`가 훨씬 위험하고, 더 자주 일어나는 장애 패턴임.**

`stop`은 즉시 감지됨. 커넥션이 끊기고 TCP RST가 날아가니까 앱이 바로 "연결 실패"를 인식하고 폴백 처리를 시작함.

`pause`는 연결이 살아있음. 앱은 "좀 느리네, 기다려볼게" 상태가 됨. 기본 타임아웃이 30초면 30초 동안 요청이 쌓임. 커넥션 풀 고갈 → 다른 요청도 대기 → 연쇄 장애 시작. 실제로는 디스크 I/O 포화, 풀 GC, 네트워크 파티션이 이 패턴을 만듦.

**이 프로젝트에서 redis_down.sh가 `pause`를 쓰는 이유**: Redis가 순간 `stop` 되면 즉시 감지되고 폴백함. 하지만 `pause`는 앱이 응답을 기다리는 동안 커넥션 풀이 소진되는 더 현실적인 시나리오를 만들어냄.

---

### Circuit Breaker — 이 프로젝트의 Redis 예시로 이해하기

```
정상 상태 (Closed):
  앱 → Redis 요청 → 응답 옴 → 계속 씀

Redis 장애 발생:
  앱 → Redis 요청 → 타임아웃 → 에러 카운트 +1
  앱 → Redis 요청 → 타임아웃 → 에러 카운트 +1
  앱 → Redis 요청 → 타임아웃 → 에러 카운트 +1
  에러 카운트 5회 도달 → Circuit Open!

Open 상태:
  앱 → Redis 요청 시도 → 바로 에러 반환 (기다리지 않음!) → DB 폴백
  (30초 후 Half-Open 시도)

Half-Open 상태:
  앱 → Redis 요청 1개 → 성공 → Closed로 복구
  앱 → Redis 요청 1개 → 실패 → Open 유지
```

**왜 이게 중요한가:** Circuit Breaker 없이 Redis가 `pause` 상태면 앱은 매 요청마다 30초씩 기다림. 100명이 동시에 요청하면 100개의 스레드가 각각 30초씩 Redis 응답을 기다림 → 커넥션 풀 고갈 → 서비스 전체 다운.

Circuit Breaker가 있으면: 5번 실패 후 바로 DB 폴백. Redis 대기 없이 즉시 처리. 서비스는 느려지지만 죽지 않음.

이 프로젝트의 `chaos/redis_down.sh`에서 HTTP 응답이 오는지, 타임아웃이 얼마나 걸리는지 관찰하면 Circuit Breaker 유무의 차이를 직접 체험할 수 있음.

---

### Graceful Degradation — "시스템은 부러지는 게 아니라 구부러져야 함"

좋은 시스템은 장애 시 **전부 아니면 전무(all-or-nothing)** 가 아니라 **기능 축소(degraded mode)** 로 동작함.

| 장애 | 나쁜 시스템 | 좋은 시스템 |
|------|-----------|-----------|
| Redis 다운 | 503 Service Unavailable | DB 직접 조회로 서비스 (느리지만 동작) |
| DB 다운 | 전체 서비스 중단 | 캐시된 목록 읽기는 됨, 쓰기만 에러 |
| MinIO 다운 | 게시글 작성 자체 불가 | 이미지 없이 텍스트 게시글은 가능 |
| 이미지 CDN 다운 | 페이지 로딩 블록 | 이미지 없이 페이지 로딩 |

철학: **가장 덜 중요한 기능부터 희생하고 핵심 기능을 지킨다.** 이미지보다 게시글이 중요하고, 좋아요보다 읽기가 중요함. 이 우선순위를 코드에 반영하는 게 설계의 핵심.

---

### 카오스 엔지니어링 도구 비교

| 도구 | 대상 | 복잡도 | 비용 |
|------|------|--------|------|
| Docker stop/pause | 컨테이너 | 매우 낮음 | $0 |
| Chaos Monkey | EC2 인스턴스 | 중간 | $0 |
| Gremlin | 모든 인프라 | 높음 | 유료 |
| LitmusChaos | Kubernetes | 높음 | $0 |
| tc (traffic control) | 네트워크 | 낮음 | $0 |

우리는 Docker Compose 환경이니까 `docker stop/pause`로 충분. 실제 프로덕션에서는 Gremlin이나 LitmusChaos 사용.

---

### 장애 시나리오별 예상 동작

| 장애 | 영향 | 기대 동작 |
|------|------|----------|
| Redis 다운 | 캐시 미스, 카운터 불가 | DB 직접 조회로 폴백. 느리지만 동작 |
| DB 다운 | 모든 쓰기 불가 | 읽기는 캐시에서 가능. 쓰기는 에러 반환 |
| App 1대 다운 | 트래픽 분산 불가 | 다른 인스턴스로 라우팅 (LB 있을 때) |
| MinIO 다운 | 이미지 업로드 불가 | Presigned URL 발급 실패. 게시글은 이미지 없이 작성 가능 |

### 심화 학습 — 더 깊이 파볼 키워드

| 키워드 | 왜 알아야 하는지 |
|--------|----------------|
| **Circuit Breaker Pattern** | 장애 서비스 호출을 차단. Open → Half-Open → Closed 상태 전이. Netflix Hystrix가 유명 |
| **Retry with Exponential Backoff** | 재시도 간격을 1s → 2s → 4s로 늘림. 장애 서비스에 부하를 가중시키지 않기 위함 |
| **Bulkhead Pattern** | 리소스를 격리. DB 커넥션 풀을 서비스별로 분리해서 한 서비스 장애가 전체에 전파 안 되게 |
| **Graceful Degradation** | 전체 중단 대신 기능 축소. "이미지 업로드 안 되지만 글은 쓸 수 있음" |
| **MTTR (Mean Time To Recovery)** | 장애 복구 평균 시간. MTTR이 짧을수록 가용성이 높음 |
| **Cascading Failure** | 한 컴포넌트 장애가 연쇄적으로 전체 시스템을 쓰러뜨리는 현상. 가장 위험한 장애 패턴 |
| **Steady State Hypothesis** | 카오스 실험 전에 "정상 상태"를 정의. 실험 후 이 상태로 돌아오는지 확인 |

---

## 구현

### Task 19: 장애 시뮬레이션 스크립트

**Files:**
- Create: `chaos/redis_down.sh`
- Create: `chaos/db_down.sh`
- Create: `chaos/network_delay.sh`
- Create: `chaos/run_all.sh`

- [ ] **Step 1: Redis 장애 시뮬레이션**

```bash
#!/bin/bash
# chaos/redis_down.sh
# Redis가 죽었을 때 앱이 어떻게 동작하는지 확인

echo "=== Redis 장애 시뮬레이션 ==="
echo ""

COMPOSE_PROJECT=$(basename "$(pwd)")

echo "[1/4] 현재 상태 확인..."
curl -s http://localhost:8000/api/posts?limit=1 | python3 -m json.tool
echo ""

echo "[2/4] Redis 정지 (docker pause)..."
docker compose pause redis
echo "Redis paused. 앱이 타임아웃까지 대기할 것."
echo ""

echo "[3/4] Redis 없이 요청 테스트 (10초 동안)..."
for i in $(seq 1 10); do
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:8000/api/posts?limit=1)
    echo "  요청 $i: HTTP $STATUS"
    sleep 1
done
echo ""

echo "[4/4] Redis 복구..."
docker compose unpause redis
echo "Redis 재개. 정상 동작 확인:"
sleep 2
curl -s http://localhost:8000/api/posts?limit=1 | python3 -m json.tool

echo ""
echo "=== 확인 사항 ==="
echo "- Redis 없이도 API가 응답했는가? (DB 폴백)"
echo "- 응답 시간이 얼마나 늘었는가?"
echo "- Redis 복구 후 정상 동작하는가?"
echo "- 카운터 데이터 유실이 있는가?"
```

- [ ] **Step 2: DB 장애 시뮬레이션**

```bash
#!/bin/bash
# chaos/db_down.sh
# DB가 죽었을 때 캐시된 데이터로 읽기가 가능한지 확인

echo "=== DB 장애 시뮬레이션 ==="
echo ""

echo "[1/5] 캐시 워밍업 (게시글 목록 조회)..."
curl -s http://localhost:8000/api/posts?limit=5 > /dev/null
echo "캐시 워밍업 완료."
echo ""

echo "[2/5] DB 정지..."
docker compose pause db
echo "DB paused."
echo ""

echo "[3/5] 읽기 테스트 (캐시에서 응답 기대)..."
for i in $(seq 1 5); do
    START=$(date +%s%N)
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:8000/api/posts?limit=5)
    END=$(date +%s%N)
    DURATION=$(( (END - START) / 1000000 ))
    echo "  읽기 $i: HTTP $STATUS (${DURATION}ms)"
    sleep 1
done
echo ""

echo "[4/5] 쓰기 테스트 (실패 기대)..."
STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 \
    -X POST http://localhost:8000/api/posts \
    -H "Content-Type: application/json" \
    -d '{"title":"Chaos Test","content":"Should fail","author":"chaos"}')
echo "  쓰기 시도: HTTP $STATUS (500 기대)"
echo ""

echo "[5/5] DB 복구..."
docker compose unpause db
echo "DB 재개."
sleep 3
STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/api/posts?limit=1)
echo "복구 후 읽기: HTTP $STATUS"

echo ""
echo "=== 확인 사항 ==="
echo "- DB 없이 캐시된 데이터 읽기가 가능했는가?"
echo "- 쓰기가 적절한 에러를 반환했는가? (500, 503)"
echo "- DB 복구 후 정상 동작하는가?"
```

- [ ] **Step 3: 네트워크 지연 시뮬레이션**

```bash
#!/bin/bash
# chaos/network_delay.sh
# DB 응답이 느려졌을 때 (디스크 I/O 포화 시뮬레이션)

echo "=== 네트워크 지연 시뮬레이션 ==="
echo ""

DB_CONTAINER=$(docker compose ps -q db)

echo "[1/4] 현재 응답 시간 측정..."
for i in $(seq 1 3); do
    TIME=$(curl -s -o /dev/null -w "%{time_total}" http://localhost:8000/api/posts?limit=5)
    echo "  요청 $i: ${TIME}s"
done
echo ""

echo "[2/4] DB 컨테이너에 200ms 네트워크 지연 추가..."
docker exec $DB_CONTAINER sh -c "apk add --no-cache iproute2 2>/dev/null; tc qdisc add dev eth0 root netem delay 200ms" 2>/dev/null || \
echo "  (tc 설정 실패 시: DB 이미지에 iproute2가 없을 수 있음. 수동으로 docker exec 필요)"
echo ""

echo "[3/4] 지연 상태에서 응답 시간 측정..."
for i in $(seq 1 5); do
    TIME=$(curl -s -o /dev/null -w "%{time_total}" http://localhost:8000/api/posts?limit=5)
    echo "  요청 $i: ${TIME}s"
    sleep 1
done
echo ""

echo "[4/4] 지연 제거..."
docker exec $DB_CONTAINER sh -c "tc qdisc del dev eth0 root" 2>/dev/null
echo "지연 제거 완료."

echo ""
echo "=== 확인 사항 ==="
echo "- 캐시 히트 시에는 영향 없었는가?"
echo "- 캐시 미스 시 응답 시간이 200ms+ 증가했는가?"
echo "- 커넥션 풀이 고갈되지 않았는가?"
```

- [ ] **Step 4: 전체 시나리오 실행 스크립트**

```bash
#!/bin/bash
# chaos/run_all.sh
# 모든 장애 시나리오를 순차 실행

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "================================================"
echo "  카오스 엔지니어링 — 전체 시나리오 실행"
echo "================================================"
echo ""

echo ">>> 시나리오 1: Redis 장애"
echo "================================================"
bash "$SCRIPT_DIR/redis_down.sh"
echo ""
sleep 5

echo ">>> 시나리오 2: DB 장애"
echo "================================================"
bash "$SCRIPT_DIR/db_down.sh"
echo ""
sleep 5

echo ">>> 시나리오 3: 네트워크 지연"
echo "================================================"
bash "$SCRIPT_DIR/network_delay.sh"
echo ""

echo "================================================"
echo "  전체 시나리오 완료"
echo "================================================"
```

- [ ] **Step 5: 실행 권한 부여 + 실행**

```bash
chmod +x chaos/*.sh
bash chaos/run_all.sh
```

- [ ] **Step 6: 부하 + 장애 동시 테스트**

가장 현실적인 시나리오: 트래픽이 있는 상태에서 장애 발생.

```bash
# 터미널 1: 부하 테스트 실행
k6 run loadtest/scenarios/mixed_load.js

# 터미널 2: 부하 중 Redis 정지 (2분쯤에 실행)
sleep 120 && docker compose pause redis && sleep 30 && docker compose unpause redis
```

k6 결과에서 Redis 정지 구간의 응답 시간 변화 확인. Grafana에서 시각적으로도 관찰.

- [ ] **Step 7: Commit**

```bash
git add chaos/
git commit -m "feat: chaos engineering scripts — Redis/DB/network failure simulation"
```

---

### Task 19A: Outbox Pattern — DB + 이벤트 원자성 보장

> **전제:** Task 19 완료.

**학습 키워드 추가**
`Outbox Pattern` `Transactional Outbox` `Relay Worker` `At-Least-Once Publishing` `CDC (Debezium)`

**Files:**
- Create: `src/models/outbox.py`
- Create: `src/workers/outbox_relay.py`
- Modify: `src/api/command/posts.py`
- Create: `tests/test_outbox.py`

#### 학습: DB + 이벤트 발행의 원자성 문제

**현재 코드의 문제:**

```python
async def create_post(data):
    post = await db.insert(data)      # 1. DB 커밋 성공
    await redis.xadd("events", ...)   # 2. 이벤트 발행
    return post
```

1번은 성공했는데 2번 전에 프로세스가 죽으면? → DB에는 게시글이 있는데 이벤트는 발행 안 됨 → Consumer가 캐시 무효화 안 함 → 캐시에 구버전 영구 잔류.

**역순도 문제:**

```python
await redis.xadd("events", ...)   # 1. 이벤트 발행 성공
await db.insert(data)              # 2. DB 커밋 — 실패하면?
```

이벤트는 발행됐는데 DB에 데이터가 없음 → Consumer가 "게시글 생성됨" 이벤트를 받고 캐시를 갱신하려는데 게시글이 없음.

**Outbox Pattern으로 해결:**

```python
async with db.begin():
    post = await db.insert(data)
    await db.insert(outbox_events, {type: "post.created", payload: {...}})
    # 같은 DB 트랜잭션 → 둘 다 성공하거나 둘 다 실패

# 별도 Relay Worker가 outbox_events를 polling → Redis Streams에 발행 → 발행 완료 row 업데이트
```

**이벤트 발행 실패 보호 전략 비교:**

| 선택지 | 적합한 상황 | 부적합한 상황 |
|--------|-----------|-------------|
| Outbox Pattern | DB + 이벤트 원자성 필요, 추가 인프라 최소 | 발행 지연(polling 간격) 허용 안 되는 실시간 시스템 |
| CDC (Debezium) | 앱 코드 변경 없이 DB WAL에서 이벤트 추출 | Kafka Connect + Debezium 인프라 필요, 로컬에서 무거움 |
| try/except + 로그 | 이벤트 유실이 비즈니스에 치명적이지 않은 경우 | 결제/주문처럼 유실 시 돈이 꼬이는 경우 |

커머스 매핑: 주문 생성(DB) + 재고 차감 이벤트가 원자적이지 않으면 재고 불일치. Outbox가 업계 표준.

---

- [ ] **Step 1: 문제 재현 — DB 커밋 성공 + 이벤트 유실**

```python
# tests/test_outbox.py
"""Outbox Pattern 테스트 — DB+이벤트 원자성."""
import asyncio
import pytest
import httpx

NGINX_URL = "http://localhost"


@pytest.mark.asyncio
async def test_event_lost_without_outbox():
    """현재 구조에서 이벤트 유실 가능성 확인.

    이 테스트는 실제 크래시를 시뮬레이션하기 어려우므로,
    Redis Streams에 이벤트가 있는지 DB에 게시글이 있는지 비교하는 개념 검증.
    """
    from src.redis_client import redis_client

    # 현재 이벤트 수 기록
    stream_info = await redis_client.xlen("events")
    print(f"Before: {stream_info} events in stream")

    # 게시글 생성 (정상)
    async with httpx.AsyncClient() as client:
        r = await client.post(
            f"{NGINX_URL}/api/posts",
            json={"title": "Outbox Test", "content": "test", "author": "tester"},
            headers={"Idempotency-Key": f"outbox-test-{asyncio.get_event_loop().time()}"},
        )
        assert r.status_code == 201

    after_count = await redis_client.xlen("events")
    print(f"After: {after_count} events in stream")
    print("현재 구조: DB INSERT + XADD가 별도 → 중간에 crash 시 이벤트 유실 가능")
```

- [ ] **Step 2: Outbox 테이블 + 트랜잭션 내 이벤트 기록**

```python
# src/models/outbox.py
import uuid
from datetime import datetime

from sqlalchemy import DateTime, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from src.models.post import Base


class OutboxEvent(Base):
    __tablename__ = "outbox_events"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    event_type: Mapped[str] = mapped_column(String(100))
    payload: Mapped[str] = mapped_column(Text)
    published: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
```

```python
# src/api/command/posts.py — create_post를 Outbox 패턴으로 수정
import json
from src.models.outbox import OutboxEvent

@router.post("", response_model=PostResponse, status_code=201)
async def create_post(data: PostCreate, db: AsyncSession = Depends(get_write_db)):
    post = Post(**data.model_dump())
    db.add(post)

    # 같은 트랜잭션에서 outbox에 이벤트 기록
    outbox = OutboxEvent(
        event_type="post.created",
        payload=json.dumps({"id": str(post.id), "title": post.title}, default=str),
    )
    db.add(outbox)

    await db.commit()
    # 이 시점에서 DB에 게시글 + outbox 이벤트가 원자적으로 존재
    # Redis XADD는 여기서 안 함 — Relay Worker가 처리
    #
    # 중요: Task 15 Step 3에서 추가한 event_service.publish() 호출을 제거할 것.
    # Outbox 패턴으로 전환하면 직접 XADD하면 안 됨 — Relay Worker가 유일한 발행 경로.
    # 직접 XADD + Outbox Relay가 동시에 돌면 이벤트가 이중 발행됨.
    return post
```

- [ ] **Step 3: Outbox Relay Worker**

```python
# src/workers/outbox_relay.py
"""Outbox 이벤트를 Redis Streams로 발행하는 Relay Worker.

polling 방식 — 5초마다 미발행 이벤트를 조회해서 Redis에 발행.
"""
import asyncio
import json

from sqlalchemy import select, update

from src.database import async_session
from src.models.outbox import OutboxEvent
from src.redis_client import init_redis, redis_client

POLL_INTERVAL = 5  # 초
STREAM_KEY = "events"


async def relay():
    await init_redis()
    print("Outbox relay worker started.")

    while True:
        try:
            async with async_session() as db:
                # 미발행 이벤트 조회 (오래된 것부터)
                result = await db.execute(
                    select(OutboxEvent)
                    .where(OutboxEvent.published == False)
                    .order_by(OutboxEvent.created_at)
                    .limit(100)
                )
                events = result.scalars().all()

                for event in events:
                    # Redis Streams에 발행
                    await redis_client.xadd(
                        STREAM_KEY,
                        {"type": event.event_type, "data": event.payload},
                    )
                    # 발행 완료 표시
                    await db.execute(
                        update(OutboxEvent)
                        .where(OutboxEvent.id == event.id)
                        .values(published=True)
                    )

                if events:
                    await db.commit()
                    print(f"Relayed {len(events)} outbox events")

        except Exception as e:
            print(f"Outbox relay error: {e}")

        await asyncio.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    asyncio.run(relay())
```

- [ ] **Step 4: Outbox 검증 — 프로세스 크래시 시뮬레이션**

```python
# tests/test_outbox.py에 추가


@pytest.mark.asyncio
async def test_outbox_survives_crash():
    """DB 트랜잭션 내 outbox 기록 → 프로세스 죽어도 이벤트 남아있음.

    실제 프로세스 crash는 시뮬레이션 어려우므로,
    outbox에 미발행 이벤트가 있는지 확인하는 방식으로 검증.
    """
    import asyncpg

    db = await asyncpg.connect(
        "postgresql://postgres:postgres@localhost:5432/extreme_board"
    )

    # outbox에 미발행 이벤트가 있는지 확인
    unpublished = await db.fetchval(
        "SELECT COUNT(*) FROM outbox_events WHERE published = false"
    )
    total = await db.fetchval("SELECT COUNT(*) FROM outbox_events")
    print(f"Outbox: total={total}, unpublished={unpublished}")
    print("unpublished > 0이면 Relay Worker가 아직 처리 안 한 것 (정상)")
    print("핵심: DB에 이벤트가 있으므로 프로세스가 죽어도 유실 없음")
    await db.close()
```

- [ ] **Step 5: Alembic 마이그레이션 + Compose에 Relay Worker 추가 + Commit**

```yaml
# docker-compose.distributed.yml에 추가
  outbox-relay:
    build: .
    command: python -m src.workers.outbox_relay
    environment: *app-env
    depends_on: [db, redis-primary]
    profiles: ["core"]
```

```bash
alembic revision --autogenerate -m "add outbox_events table"
alembic upgrade head
git add -A
git commit -m "feat: outbox pattern — DB+event atomicity with relay worker"
```

---

### Task 19B: Redis Failover Write 유실 확인

> **전제:** Task 19A 완료. Redis Sentinel 환경.

**학습 키워드 추가**
`Failover Write Loss` `WAIT command` `Asynchronous Replication` `Split Brain`

**Files:**
- Create: `tests/test_redis_failover.py`

#### 학습: Redis Failover 중 Write 유실 메커니즘

Redis Sentinel은 자동 failover를 제공하지만, **비동기 복제** 특성상 write 유실이 발생할 수 있음:

```
1. Client → Primary에 SET key value → "OK" 응답
2. Primary → Replica로 복제 시작 (비동기)
3. Primary 죽음 ☠️ (복제 완료 전)
4. Sentinel이 Replica를 새 Primary로 승격
5. 새 Primary에는 2번의 SET이 없음 → write 유실
```

Client는 "OK"를 받았으니 성공이라 생각하지만, 실제로는 유실됨.

**Redis failover 유실 대응 비교:**

| 선택지 | 적합한 상황 | 부적합한 상황 |
|--------|-----------|-------------|
| 유실 허용 + DB 기준 복구 배치 | 캐시/카운터처럼 DB에서 재구축 가능한 데이터 | DB에 원본 없는 데이터 (세션) |
| WAIT 명령 | 핵심 데이터 write에 선택적 적용 | 모든 write에 적용하면 지연 과다 |
| AOF everysec | 최대 1초분 유실로 제한 | 완전 방지는 아님 |

---

- [ ] **Step 1: k6 지속 write + Redis primary docker stop**

```python
# tests/test_redis_failover.py
"""Redis Failover Write 유실 측정.

Sentinel 환경에서 primary를 죽이고 유실 규모를 측정.
"""
import asyncio
import pytest

from redis.asyncio.sentinel import Sentinel


@pytest.mark.asyncio
async def test_redis_failover_write_loss():
    """write 지속 → primary stop → 유실 확인.

    주의: 이 테스트는 docker stop을 직접 실행하므로
    분산 환경이 완전히 떠 있는 상태에서 수동 실행 권장.
    """
    sentinel = Sentinel([("localhost", 26379)], socket_timeout=3)
    r = sentinel.master_for("mymaster", decode_responses=True)

    # 1. 연속 write — 각 write의 성공/실패 기록
    success_keys = []
    fail_count = 0
    test_prefix = "failover-test"

    print("Phase 1: Writing 1000 keys...")
    for i in range(1000):
        try:
            key = f"{test_prefix}:{i}"
            await r.set(key, f"value-{i}")
            success_keys.append(key)
        except Exception as e:
            fail_count += 1
            if fail_count == 1:
                print(f"  First failure at key {i}: {e}")
        await asyncio.sleep(0.001)  # 1ms 간격

    print(f"  Written: {len(success_keys)}, Failed: {fail_count}")

    # 2. 이 시점에서 수동으로 primary를 죽임:
    #    docker compose -f docker-compose.distributed.yml stop redis-primary
    #    → Sentinel이 redis-replica를 승격
    #    → 수초 후 새 master에 연결
    print("\n>>> 지금 다른 터미널에서 실행:")
    print(">>> docker compose -f docker-compose.distributed.yml stop redis-primary")
    print(">>> 10초 기다린 후 Enter...")
    # 실제 테스트에서는 subprocess로 docker stop 실행하거나, 수동 실행

    # 3. 새 master에서 실제로 남아있는 key 확인
    await asyncio.sleep(15)  # failover 대기
    r_new = sentinel.master_for("mymaster", decode_responses=True)
    survived = 0
    lost = 0
    for key in success_keys:
        val = await r_new.get(key)
        if val:
            survived += 1
        else:
            lost += 1

    print(f"\nPhase 2: After failover")
    print(f"  Survived: {survived}/{len(success_keys)}")
    print(f"  Lost: {lost}/{len(success_keys)}")
    print(f"  Loss rate: {lost/len(success_keys)*100:.2f}%")

    # cleanup
    for key in success_keys:
        await r_new.delete(key)
```

Run: `pytest tests/test_redis_failover.py -v -s` (수동 docker stop 필요)

- [ ] **Step 2: WAIT 명령으로 유실 감소 확인**

```python
# tests/test_redis_failover.py에 추가


@pytest.mark.asyncio
async def test_redis_wait_reduces_loss():
    """WAIT 명령 — write가 replica에 복제될 때까지 대기.

    WAIT numreplicas timeout:
    - numreplicas: 최소 N대의 replica에 복제 확인
    - timeout: 최대 대기 시간 (ms). 0이면 무한 대기
    - 반환값: 실제로 복제 확인된 replica 수

    WAIT은 모든 write에 쓰면 지연이 과다 → 핵심 데이터에만 선택적 적용.
    """
    sentinel = Sentinel([("localhost", 26379)], socket_timeout=3)
    r = sentinel.master_for("mymaster", decode_responses=True)

    # WAIT 적용한 write
    key = "wait-test:critical"
    await r.set(key, "important-value")
    replicas_acked = await r.execute_command("WAIT", 1, 5000)
    # replicas_acked >= 1 이면 최소 1대의 replica에 복제 완료
    print(f"WAIT result: {replicas_acked} replica(s) acknowledged")

    if replicas_acked >= 1:
        print("✓ Replica에 복제 확인 → primary 죽어도 이 write는 안전")
    else:
        print("⚠ Replica 복제 타임아웃 → 유실 가능성 있음")

    await r.delete(key)
```

Run: `pytest tests/test_redis_failover.py::test_redis_wait_reduces_loss -v -s`

- [ ] **Step 3: Commit**

```bash
git add tests/test_redis_failover.py
git commit -m "test: Redis failover write loss measurement + WAIT command"
```

---

### Task 19C: 장애 복구 후 정합성 감사/복구

> **전제:** Task 19B 완료.

**Files:**
- Create: `scripts/consistency_recovery.py`
- Create: `tests/test_disaster_recovery.py`

#### 학습: 장애 후 대사(Reconciliation)

장애가 발생하면 데이터 불일치가 생김. 복구 후에는 **어디가 어긋났는지 파악(감사)** → **DB를 기준으로 Redis를 재동기화(복구)** 가 필요함.

커머스 매핑: 장애 후 재고 대사 — 실제 재고 DB와 캐시/이벤트 기반 재고를 비교해서 맞추는 작업.

---

- [ ] **Step 1: 자동 복구 스크립트 — DB 기준 Redis 재동기화**

```python
# scripts/consistency_recovery.py
"""장애 후 DB 기준으로 Redis 카운터 재동기화.

감사 → 불일치 발견 → DB를 source of truth로 Redis 덮어씀.
"""
import asyncio

import asyncpg
from redis.asyncio.sentinel import Sentinel


async def recover():
    sentinel = Sentinel([("localhost", 26379)], socket_timeout=3)
    redis = sentinel.master_for("mymaster", decode_responses=True)
    db = await asyncpg.connect(
        "postgresql://postgres:postgres@localhost:5432/extreme_board"
    )

    print("=== Consistency Recovery ===\n")

    # 1. DB의 모든 카운터를 Redis에 동기화
    posts = await db.fetch("SELECT id, like_count, view_count FROM posts")
    synced = 0

    for post in posts:
        pid = str(post["id"])
        redis_likes = int(await redis.get(f"post:{pid}:likes") or 0)
        redis_views = int(await redis.get(f"post:{pid}:views") or 0)
        db_likes = post["like_count"]
        db_views = post["view_count"]

        # Redis 값이 DB보다 작으면 (유실된 경우) DB 값으로 복구
        # Redis 값이 DB보다 크면 (동기화 전 delta) 그대로 둠 — 다음 sync에서 반영
        if redis_likes < db_likes:
            await redis.set(f"post:{pid}:likes", db_likes)
            print(f"  Recovered post {pid}: likes {redis_likes} → {db_likes}")
            synced += 1
        if redis_views < db_views:
            await redis.set(f"post:{pid}:views", db_views)
            print(f"  Recovered post {pid}: views {redis_views} → {db_views}")
            synced += 1

    # 2. 미발행 Outbox 이벤트 재발행
    unpublished = await db.fetchval(
        "SELECT COUNT(*) FROM outbox_events WHERE published = false"
    )
    print(f"\n  Unpublished outbox events: {unpublished}")
    print("  (Outbox Relay Worker가 재시작되면 자동 발행됨)")

    print(f"\n  Total recoveries: {synced}")
    print("\n=== Recovery Complete ===")

    await db.close()
    await redis.aclose()


if __name__ == "__main__":
    asyncio.run(recover())
```

- [ ] **Step 2: 장애 → 복구 → 감사 → 복구 통합 테스트**

```python
# tests/test_disaster_recovery.py
"""장애 후 감사 + 복구 통합 테스트.

시나리오:
1. Redis에 카운터 설정
2. Redis 장애 시뮬레이션 (키 삭제)
3. 감사 스크립트로 불일치 확인
4. 복구 스크립트로 DB 기준 재동기화
"""
import asyncio
import subprocess
import pytest


@pytest.mark.asyncio
async def test_audit_then_recover():
    """감사 → 불일치 발견 → 복구 → 재감사 흐름."""
    from redis.asyncio.sentinel import Sentinel

    sentinel = Sentinel([("localhost", 26379)], socket_timeout=3)
    redis = sentinel.master_for("mymaster", decode_responses=True)

    # 1. 테스트용 카운터 설정 (DB 값과 불일치)
    await redis.set("post:test-recovery:likes", 0)  # Redis: 0
    # DB에는 like_count가 있다고 가정 (audit 스크립트가 비교)

    # 2. 감사 실행
    result = subprocess.run(
        ["python", "scripts/consistency_audit.py"],
        capture_output=True, text=True,
    )
    print("=== Audit Output ===")
    print(result.stdout)

    # 3. 복구 실행
    result = subprocess.run(
        ["python", "scripts/consistency_recovery.py"],
        capture_output=True, text=True,
    )
    print("=== Recovery Output ===")
    print(result.stdout)

    # 4. cleanup
    await redis.delete("post:test-recovery:likes")
```

Run: `pytest tests/test_disaster_recovery.py -v -s`

- [ ] **Step 3: Commit**

```bash
git add scripts/consistency_recovery.py tests/test_disaster_recovery.py
git commit -m "feat: disaster recovery — DB-based Redis resync + audit/recovery pipeline"
```

---

## Phase 11 완료 체크리스트

- [ ] Redis 장애 시 DB 폴백 동작 확인
- [ ] DB 장애 시 캐시 읽기 동작 확인 + 쓰기 에러 확인
- [ ] 네트워크 지연 시 캐시 효과 확인
- [ ] 부하 + 장애 동시 시나리오 실행
- [ ] Outbox Pattern — DB 트랜잭션 + outbox 같이 커밋
- [ ] Outbox Relay Worker — polling → Redis Streams 발행
- [ ] DB 커밋 후 프로세스 crash → outbox에 이벤트 남아있음 확인
- [ ] Redis Failover — primary stop → write 유실 확인
- [ ] WAIT 명령으로 유실 감소 확인
- [ ] 장애 후 감사 스크립트 실행 — 불일치 목록 출력
- [ ] DB 기준 Redis 재동기화 복구

**핵심 체감:**
- Redis 죽어도 서비스는 돌아감 (느리지만 동작) = 캐시는 보조 계층
- DB 죽으면 쓰기 불가, 읽기는 캐시로 버팀 = DB는 핵심 계층
- Outbox: DB에 커밋 + 이벤트가 같은 트랜잭션 → 프로세스 죽어도 이벤트 안 유실
- Redis Failover: 비동기 복제 → "OK" 받은 write도 유실 가능 → WAIT으로 완화 가능
- 장애 복구 후: DB를 source of truth로 Redis 재동기화 → 자동화 필수
- **"장애가 일어나면 어떡하지?"가 아니라 "장애는 반드시 일어난다"를 전제로 설계**

**다음:** [Phase 12 — 클라우드 배포](phase-12-cloud.md)
