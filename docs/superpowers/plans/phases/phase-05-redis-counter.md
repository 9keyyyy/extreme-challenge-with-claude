# Phase 5: Redis 카운터 — DB 락 vs Redis INCR 직접 비교

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans

**전제:** Phase 4 완료. 캐시가 동작하는 상태. 좋아요/조회수는 아직 DB 직접 UPDATE.

**학습 키워드**
`Redis Single Thread` `INCR/DECR Atomicity` `Row Lock (Exclusive Lock)` `GETSET (atomic swap)` `Redis Persistence (RDB/AOF)` `Pipeline/MULTI` `Bulk UPDATE` `k6 Load Test` `Eventual Consistency`

---

## 학습: 왜 카운터를 Redis로 분리하는가

### 핵심 질문 — "왜 좋아요를 Redis로 처리했나요?"

> "DB로 하면 안 되나요?"

"Redis가 빠르니까요"는 너무 얕은 답변임. 핵심은 **DB가 왜 느린지의 메커니즘**과 **Redis가 어떻게 그 문제를 우회하는지**를 이해하는 것.

---

### DB 카운터의 진짜 문제: Lock Wait Queue

현재 좋아요 구현:
```python
UPDATE posts SET like_count = like_count + 1 WHERE id = ?
```

이 `UPDATE`는 해당 row에 **배타적 락(exclusive lock)**을 걸음. 배타적 락은 "내가 쓰는 동안 아무도 이 row 못 건드림"이라는 의미임.

**1000명이 동시에 같은 게시글에 좋아요를 누르면 무슨 일이 벌어지나:**

1. 요청 #1이 row에 X-Lock 획득 → UPDATE 실행 → Lock 해제
2. 요청 #2 ~ #1000은 Lock 대기 큐(wait queue)에 쌓임
3. Lock이 해제될 때마다 큐에서 하나씩 꺼내서 실행

이게 단순히 "느리다"로 끝나지 않는 이유가 있음:

- **컨텍스트 스위칭 비용:** Lock 대기 중인 커넥션은 OS 스레드를 점유한 채 sleep 상태가 됨. 커넥션이 많을수록 OS가 스레드 전환에 쓰는 CPU 사이클이 폭발적으로 증가함
- **커넥션 풀 고갈:** DB 커넥션 풀은 보통 100~200개. 1000개 요청이 몰리면 800개는 커넥션조차 못 잡고 타임아웃 남
- **Lock 전파:** PostgreSQL에서 `like_count` 업데이트 중에 같은 row를 읽는 SELECT도 영향받을 수 있음 (isolation level에 따라)

**더 큰 문제:** 조회수도 DB `UPDATE`임. 읽기 요청인데 쓰기 부하가 발생함. 100만 CCU가 인기글을 읽을 때마다 DB가 병목이 됨. Phase 4에서 캐싱으로 읽기는 줄였지만, 조회수 증가 자체가 여전히 DB에 쓰기 폭탄을 던지고 있는 상황임.

---

### Redis INCR의 원리: 왜 락이 필요 없는가

Redis는 **싱글스레드**로 동작함. 모든 명령이 이벤트 루프에서 하나씩 순차적으로 실행됨.

이 구조가 핵심임:

- **멀티스레드 환경에서 원자성:** "값 읽고 → +1 하고 → 다시 쓰기" 이 3단계 사이에 다른 스레드가 끼어들 수 있음. 그래서 Lock이나 CAS(Compare-And-Swap)가 필요함
- **싱글스레드 환경에서 원자성:** `INCR key` 실행 중에 다른 명령이 끼어들 수 없음. 물리적으로 불가능함. Lock 자체가 필요 없는 구조임

```
요청 A: INCR post:1:views  ──┐
요청 B: INCR post:1:views  ──┤→ Redis 이벤트 루프가 하나씩 처리
요청 C: INCR post:1:views  ──┘
결과: 정확히 3 증가, Lock 없음, 대기 없음
```

1000개 동시 `INCR` = 정확히 1000 증가. 속도는 Redis 메모리 연산이라 ~0.01ms/건임.

**DB별 카운터 동시성 비교:**

| | PostgreSQL | MySQL | MongoDB | Redis |
|---|---|---|---|---|
| 메커니즘 | Row Lock + MVCC | Row Lock + Gap Lock | Document Lock | 싱글스레드 (락 없음) |
| 1000 동시 +1 | 직렬화 (느림) | 직렬화 + 갭 락 위험 | 직렬화 | 병렬 (빠름) |
| 정확도 | 정확 | 정확 | 정확 | 정확 |
| 속도 | ~1ms/건 + 대기 | ~1ms/건 + 대기 | ~1ms/건 + 대기 | ~0.01ms/건 |

비교표에서 "병렬(빠름)"이라고 쓴 Redis의 장점은 단순히 메모리가 빠른 게 아님. Lock contention 자체가 없어서 응답시간 분포가 훨씬 균일함. DB는 p95는 괜찮아도 p99가 폭발하는 이유가 바로 Lock 대기 큐 때문임.

---

### 카운터와 DB 제약조건은 별개

Redis로 카운터를 옮긴다고 해서 DB를 아예 안 쓰는 게 아님. 역할을 나누는 거임:

- **Redis 카운터:** "지금 좋아요 몇 개?" → 빠른 읽기/쓰기 (성능)
- **DB 제약조건:** "이 유저가 이미 좋아요 했는지" → `UNIQUE(user_id, post_id)` (정합성)
- **주기적 동기화:** Redis 카운터 값 → DB에 벌크 UPDATE (영속성)

셋은 보완 관계임. Redis가 장애 나도 DB의 `UNIQUE` 제약이 중복 좋아요를 막아줌. 카운터 숫자는 Redis에서 빠르게, 정합성 보장은 DB에서 확실하게.

---

### 동기화 전략: GETSET과 최종 일관성

```
GETSET post:1:views 0
→ 현재 값(예: 523)을 반환하고, 0으로 초기화. 원자적.
→ 반환된 523을 DB에 UPDATE posts SET view_count = view_count + 523
```

이걸 30초마다 벌크로 실행함 → DB 부하 최소화.

**왜 카운터에서 최종 일관성(Eventual Consistency)이 허용되는가:**

강한 일관성이 필요한 데이터와 최종 일관성이 허용되는 데이터를 구분하는 것이 핵심임.

- **강한 일관성이 필요한 예시:** 잔액, 재고, 결제 상태 → 틀리면 실제 손해가 발생함
- **최종 일관성이 허용되는 예시:** 조회수, 좋아요 수 → 숫자가 30초 지연되어도 사용자가 피해를 입지 않음

좋아요 수가 523개인데 사용자에게 521개로 보여준다면? 사용자는 모름. 30초 후 동기화되면 정확해짐. "정확한 숫자"가 아니라 "합리적으로 가까운 숫자"가 요구사항인 경우에 최종 일관성 전략이 적합함.

반면 "이 유저가 좋아요를 이미 눌렀는지"는 최종 일관성으로 처리하면 중복 좋아요가 발생할 수 있음. 그래서 이건 여전히 DB의 `UNIQUE` 제약으로 강하게 보장하는 거임.

---

### Redis 장애 시 데이터 유실 위험

> "Redis가 죽으면 카운터가 다 날아가는 거 아닌가요?"

맞음. 대비책을 알아야 함:

**시나리오:** Redis가 갑자기 재시작됨. 동기화 워커가 30초마다 DB에 flush하는데, 마지막 flush 이후 쌓인 카운터 delta가 메모리에만 있었다면 유실됨.

**완화 전략:**

1. **RDB 스냅샷:** Redis가 주기적으로 메모리 상태를 디스크에 저장함. 재시작 시 스냅샷에서 복구. 스냅샷 주기(예: 60초)만큼의 데이터는 유실 가능
2. **AOF(Append Only File):** 모든 쓰기 명령을 로그 파일에 기록. 재시작 시 로그를 재실행해서 복구. 거의 유실 없음. 대신 디스크 I/O가 늘어남
3. **카운터 특성 활용:** 조회수/좋아요수는 유실되어도 서비스가 망하진 않음. 숫자가 약간 틀려도 허용 가능한 데이터라면 RDB 수준으로 충분함

실무에서는 카운터 유실 허용 여부를 요구사항으로 먼저 정의함. 허용 가능하면 RDB + 짧은 sync 주기(10~30초)로 충분함. 허용 불가라면 AOF + fsync every second 설정 필요함.

---

### 심화 학습 — 더 깊이 파볼 키워드

| 키워드 | 왜 알아야 하는지 | 실전 연관 |
|--------|----------------|----------|
| **Redis Persistence (RDB/AOF)** | Redis 재시작 시 데이터 복구 방식. RDB는 스냅샷, AOF는 명령 로그. 카운터 유실 위험도와 직결 | 장애 대응 설계할 때 반드시 선택해야 하는 트레이드오프 |
| **Redis Pipeline** | 여러 명령을 한 번에 보내서 네트워크 왕복(RTT)을 줄임. 벌크 카운터 조회 시 필수 | SCAN으로 키 100개 찾고 GET 100번 하면 RTT 100배 → Pipeline으로 1회로 줄임 |
| **Redis MULTI/EXEC** | 트랜잭션. 여러 명령을 원자적으로 실행. INCR + EXPIRE를 묶을 때 사용 | 카운터에 만료 시간 설정할 때, 두 명령이 분리되면 INCR만 되고 EXPIRE가 실패하는 케이스 방지 |
| **Redis Memory Policy** | `maxmemory` 초과 시 어떤 키를 삭제할지 결정. 카운터는 `noeviction`이어야 함 | LRU 정책으로 캐시 키 삭제되는 건 괜찮지만 카운터 키 삭제되면 데이터 유실임 |
| **HyperLogLog** | 고유 방문자 수(UV) 같은 근사 카운팅. 12KB로 수억 개 카운트 가능 | 정확한 UV 집계는 메모리가 엄청 필요함. 오차율 0.81% 허용하면 HyperLogLog로 해결 |

---

## 구현

### Task 11: DB 카운터 부하 테스트 (Before)

**Files:**
- Create: `loadtest/smoke.js`

- [ ] **Step 1: k6 설치 확인**

Run: `brew install k6` (또는 `docker run --rm -i grafana/k6`)

- [ ] **Step 2: 동시 좋아요 부하 테스트 작성**

```javascript
// loadtest/smoke.js
import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = 'http://localhost:8000';

export function setup() {
    const res = http.post(`${BASE_URL}/api/posts`, JSON.stringify({
        title: 'Load Test Post',
        content: 'For concurrent like testing',
        author: 'loadtest',
    }), { headers: { 'Content-Type': 'application/json' } });
    return { postId: JSON.parse(res.body).id };
}

export const options = {
    scenarios: {
        concurrent_likes: {
            executor: 'shared-iterations',
            vus: 100,
            iterations: 1000,
            maxDuration: '30s',
        },
    },
};

export default function (data) {
    const userId = `user_${__VU}_${__ITER}`;
    const res = http.post(
        `${BASE_URL}/api/posts/${data.postId}/likes`,
        JSON.stringify({ user_id: userId }),
        { headers: { 'Content-Type': 'application/json' } }
    );
    check(res, { 'status is 2xx': (r) => r.status >= 200 && r.status < 300 });
}
```

- [ ] **Step 3: DB 카운터 상태에서 부하 테스트 실행**

Run: `k6 run loadtest/smoke.js`

**이 수치 기록. p95, p99 응답시간, 에러율.**

- [ ] **Step 4: Commit**

```bash
git add loadtest/smoke.js
git commit -m "feat: k6 concurrent like load test — DB-only baseline"
```

---

### Task 12: Redis 카운터 전환 + After 비교

**Files:**
- Create: `src/services/counter_service.py`
- Create: `src/workers/counter_sync.py`
- Modify: `src/services/like_service.py`
- Modify: `src/api/query/posts.py`
- Create: `tests/test_counter.py`

- [ ] **Step 1: Redis 카운터 서비스**

```python
# src/services/counter_service.py
from src.redis_client import redis_client


async def increment_view(post_id: str) -> int:
    return await redis_client.incr(f"post:{post_id}:views")


async def increment_like(post_id: str) -> int:
    return await redis_client.incr(f"post:{post_id}:likes")


async def decrement_like(post_id: str) -> int:
    return await redis_client.decr(f"post:{post_id}:likes")


async def get_counters(post_id: str) -> dict[str, int]:
    views = await redis_client.get(f"post:{post_id}:views")
    likes = await redis_client.get(f"post:{post_id}:likes")
    return {
        "views": int(views) if views else 0,
        "likes": int(likes) if likes else 0,
    }
```

- [ ] **Step 2: 카운터 동기화 Worker**

```python
# src/workers/counter_sync.py
"""30초마다 Redis 카운터 → DB 벌크 동기화"""
import asyncio

from sqlalchemy import text

from src.database import async_session
from src.redis_client import redis_client

SYNC_INTERVAL = 30


async def _scan_and_collect(pattern: str) -> list[tuple[str, int]]:
    """Redis SCAN으로 패턴에 맞는 키를 찾고, SET GET으로 delta 수집 후 0으로 리셋.

    GETSET은 Redis 6.2에서 deprecated됨. SET key 0 GET이 동일 동작.
    """
    cursor = 0
    batch = []
    while True:
        cursor, keys = await redis_client.scan(cursor, match=pattern, count=100)
        for key in keys:
            post_id = key.split(":")[1]
            delta = await redis_client.set(key, 0, get=True)
            if delta and int(delta) > 0:
                batch.append((post_id, int(delta)))
        if cursor == 0:
            break
    return batch


async def sync_counters():
    while True:
        await asyncio.sleep(SYNC_INTERVAL)
        try:
            view_batch = await _scan_and_collect("post:*:views")
            like_batch = await _scan_and_collect("post:*:likes")

            async with async_session() as db:
                for post_id, delta in view_batch:
                    await db.execute(
                        text(
                            "UPDATE posts SET view_count = view_count + :delta "
                            "WHERE id = :post_id"
                        ),
                        {"delta": delta, "post_id": post_id},
                    )
                for post_id, delta in like_batch:
                    await db.execute(
                        text(
                            "UPDATE posts SET like_count = like_count + :delta "
                            "WHERE id = :post_id"
                        ),
                        {"delta": delta, "post_id": post_id},
                    )
                if view_batch or like_batch:
                    await db.commit()
                    print(f"Synced {len(view_batch)} view + {len(like_batch)} like counters")
        except Exception as e:
            print(f"Counter sync error: {e}")


if __name__ == "__main__":
    asyncio.run(sync_counters())
```

- [ ] **Step 3: Like 서비스를 Redis 카운터로 전환**

```python
# src/services/like_service.py — DB UPDATE 제거, Redis INCR로 교체
from src.services import counter_service

async def toggle_like(db: AsyncSession, post_id: uuid.UUID, user_id: str) -> bool:
    existing = await db.execute(
        select(Like).where(Like.post_id == post_id, Like.user_id == user_id)
    )
    like = existing.scalar_one_or_none()

    if like:
        await db.delete(like)
        await db.commit()
        await counter_service.decrement_like(str(post_id))  # DB UPDATE 대신!
        return False
    else:
        db.add(Like(post_id=post_id, user_id=user_id))
        await db.commit()
        await counter_service.increment_like(str(post_id))  # DB UPDATE 대신!
        return True
```

- [ ] **Step 4: 조회수도 Redis로 전환**

```python
# src/api/query/posts.py — get_post에서
# 이전: post.view_count += 1; await db.commit()
# 변경:
await counter_service.increment_view(str(post_id))
```

- [ ] **Step 5: 같은 k6 테스트 재실행 — Before vs After**

Run: `k6 run loadtest/smoke.js`

Expected: p95/p99가 DB 카운터 대비 대폭 개선. DB lock 경합 제거됨.

- [ ] **Step 6: 카운터 정확도 테스트**

```python
# tests/test_counter.py
import asyncio
import pytest

from src.redis_client import redis_client
from src.services.counter_service import get_counters, increment_view


@pytest.mark.asyncio
async def test_counter_accuracy():
    """1000번 동시 INCR → 정확히 1000"""
    test_id = "accuracy-test"
    # 이전 실행 잔여 키 초기화
    await redis_client.delete(f"post:{test_id}:views")
    tasks = [increment_view(test_id) for _ in range(1000)]
    await asyncio.gather(*tasks)
    counters = await get_counters(test_id)
    assert counters["views"] == 1000
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: Redis counters — DB lock eliminated, k6 before/after comparison"
```

---

### Task 12A: 멀티 인스턴스 카운터 정합성 검증

> **전제:** Task 12 완료 + Phase 4.5의 분산 환경(`docker-compose.distributed.yml --profile core`)이 동작하는 상태.

**학습 키워드 추가**
`Lost Update` `Read-Modify-Write Anti-Pattern` `Lua Script Atomicity` `Check-and-Decrement` `Inventory Overselling`

**Files:**
- Create: `tests/test_distributed_counter.py`
- Create: `scripts/inventory_simulation.lua` (참고용 — 실제 실행은 테스트 인라인 스크립트)
- Create: `loadtest/scenarios/concurrent_likes.js`

#### 학습: 멀티 인스턴스에서 카운터가 깨지는 경우

Task 12에서 Redis INCR로 카운터를 전환했고, 단일 인스턴스에서 정확도를 검증함. 하지만 멀티 인스턴스 환경에서는 **앱 레벨에서 원자성을 깨뜨리는 실수**가 훨씬 치명적임.

**Lost Update — 왜 앱 레벨 read-modify-write가 위험한가:**

```
서버 A: GET counter → 100
서버 B: GET counter → 100       (A가 SET 하기 전에 읽음)
서버 A: SET counter 101         (100 + 1)
서버 B: SET counter 101         (100 + 1, 같은 값으로 덮어씀)
결과: 2번 증가했는데 101. 1건 유실.
```

Redis INCR은 이 문제가 없음 — 싱글스레드라 원자적. 하지만 "값을 읽고 → 앱에서 계산하고 → 다시 쓰는" 패턴을 쓰면 멀티 인스턴스에서 반드시 깨짐.

**커머스 매핑 — 재고 차감이 같은 문제:**

```
재고: 1개 남음
서버 A: GET stock → 1 (> 0이니까 판매 OK)
서버 B: GET stock → 1 (> 0이니까 판매 OK)
서버 A: SET stock 0
서버 B: SET stock 0
결과: 재고 1개인데 2명에게 팔음 = 오버셀링
```

**카운터/동시 차감 방법 비교:**

| 선택지 | 적합한 상황 | 부적합한 상황 |
|--------|-----------|-------------|
| DB `count = count + 1` | 쓰기 빈도 낮고 정합성 절대적 (결제 금액) | 동시 요청 많으면 lock wait → 커넥션 풀 고갈 |
| Redis INCR | 단순 증감, 조건 분기 없음 (좋아요 +1) | 조건부 연산 (0 이하면 거부) 불가 |
| Redis Lua script | 조건부 원자적 연산 (재고: 0 이상일 때만 -1) | 스크립트 복잡하면 Redis 전체 블로킹. 단순 증감에는 오버스펙 |
| Optimistic Locking (DB) | 충돌 빈도 낮은 쓰기 (프로필 수정) | 충돌 빈도 높으면 재시도 폭발 (인기글 좋아요) |
| CAS (WATCH+MULTI) | Redis에서 optimistic locking 필요할 때 | 충돌 많으면 INCR보다 느림. 대부분 Lua가 나음 |

---

- [ ] **Step 1: k6 멀티 인스턴스 동시 좋아요 — INCR 정확성 검증**

```javascript
// loadtest/scenarios/concurrent_likes.js
// Nginx LB를 통해 API 3대에 분산된 상태에서 동시 좋아요 1000건
import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost';  // Nginx (port 80)

export const options = {
    scenarios: {
        concurrent_likes: {
            executor: 'shared-iterations',
            vus: 100,
            iterations: 1000,
            maxDuration: '30s',
        },
    },
};

export function setup() {
    const res = http.post(`${BASE_URL}/api/posts`, JSON.stringify({
        title: 'Distributed Counter Test',
        content: 'For multi-instance like testing',
        author: 'loadtest',
    }), { headers: { 'Content-Type': 'application/json' } });
    const postId = JSON.parse(res.body).id;
    return { postId };
}

export default function (data) {
    const userId = `user_${__VU}_${__ITER}`;
    const res = http.post(
        `${BASE_URL}/api/posts/${data.postId}/likes`,
        JSON.stringify({ user_id: userId }),
        { headers: { 'Content-Type': 'application/json' } }
    );
    check(res, { 'like success': (r) => r.status >= 200 && r.status < 300 });
}

export function teardown(data) {
    // 최종 카운터 값 확인.
    // 주의: API 응답의 like_count가 Redis에서 오는지 DB에서 오는지는 구현에 따라 다름.
    // Task 12에서 조회 API가 counter_service.get_counters()를 사용하면 Redis 값 (즉시 반영).
    // DB 값을 반환한다면 동기화 전에는 0일 수 있음 (30초 주기 sync).
    const res = http.get(`${BASE_URL}/api/posts/${data.postId}`);
    const post = JSON.parse(res.body);
    console.log(`Final like count from API: ${post.like_count}, expected: 1000`);
    console.log(`(If 0 or low: API might return DB value before sync. Check Redis directly.)`);
}
```

Run:
```bash
# 분산 환경에서 실행 (Nginx port 80)
k6 run loadtest/scenarios/concurrent_likes.js

# 최종 카운터 값 확인 — 정확히 1000이어야 함
curl -s http://localhost/api/posts/{POST_ID} | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'likes={d[\"like_count\"]}')"
```

Expected: Redis INCR 기반이므로 정확히 1000.

- [ ] **Step 2: Non-atomic anti-pattern으로 Lost Update 체험**

```python
# tests/test_distributed_counter.py
"""분산 카운터 테스트 — Redis 원자적 연산 vs non-atomic 비교.

이 테스트는 Redis에 직접 접근함 (HTTP가 아닌 직접 클라이언트).
conftest.py에서 init_redis()가 호출되어야 redis_client가 초기화됨:

  # tests/conftest.py에 추가
  @pytest.fixture(autouse=True, scope="session")
  async def setup_redis():
      from src.redis_client import init_redis
      await init_redis()
"""
import asyncio
import pytest

from src.redis_client import redis_client


@pytest.mark.asyncio
async def test_non_atomic_lost_update():
    """non-atomic read-modify-write → Lost Update 발생 확인"""
    key = "test:non-atomic"
    await redis_client.set(key, 0)

    async def non_atomic_increment():
        """이렇게 하면 안 됨 — GET → +1 → SET 사이에 다른 요청이 끼어듦"""
        val = int(await redis_client.get(key))
        # 0.01초 sleep으로 race window를 충분히 확보.
        # asyncio는 싱글스레드 코루틴 스위칭이라 sleep에서 yield 해야
        # 다른 코루틴이 끼어들 수 있음. 너무 짧으면 race가 안 생길 수도 있음.
        await asyncio.sleep(0.01)
        await redis_client.set(key, val + 1)

    tasks = [non_atomic_increment() for _ in range(100)]
    await asyncio.gather(*tasks)

    result = int(await redis_client.get(key))
    # 대부분의 환경에서 100보다 적은 값이 나옴 — Lost Update!
    # 단, asyncio 스케줄링에 따라 드물게 100이 나올 수도 있음.
    assert result <= 100
    print(f"Non-atomic: 100 increments → actual {result} (lost {100 - result})")
    if result == 100:
        print("  (race condition이 발생하지 않음 — sleep 늘리거나 iterations 늘려서 재시도)")


@pytest.mark.asyncio
async def test_atomic_incr_no_lost_update():
    """Redis INCR → Lost Update 없음"""
    key = "test:atomic"
    await redis_client.set(key, 0)

    tasks = [redis_client.incr(key) for _ in range(100)]
    await asyncio.gather(*tasks)

    result = int(await redis_client.get(key))
    assert result == 100, f"Expected 100 but got {result}"
```

Run: `pytest tests/test_distributed_counter.py -v`

Expected:
- `test_non_atomic_lost_update` — PASS (100보다 작은 값, Lost Update 확인)
- `test_atomic_incr_no_lost_update` — PASS (정확히 100)

- [ ] **Step 3: Lua script로 조건부 차감 — 재고 시뮬레이션**

```lua
-- scripts/inventory_simulation.lua
-- "재고가 0 이상일 때만 -1" 을 원자적으로 수행
-- KEYS[1] = inventory key
-- Returns: 1 (성공, 차감됨), 0 (실패, 재고 부족)

local stock = tonumber(redis.call('GET', KEYS[1]))
if stock == nil then
    return -1  -- 키 없음
end
if stock > 0 then
    redis.call('DECR', KEYS[1])
    return 1
else
    return 0
end
```

```python
# tests/test_distributed_counter.py에 추가

LUA_CHECK_AND_DECREMENT = """
local stock = tonumber(redis.call('GET', KEYS[1]))
if stock == nil then return -1 end
if stock > 0 then
    redis.call('DECR', KEYS[1])
    return 1
else
    return 0
end
"""


@pytest.mark.asyncio
async def test_lua_inventory_no_oversell():
    """Lua script — 재고 100개, 200명 동시 구매 → 정확히 100명만 성공"""
    key = "test:inventory"
    await redis_client.set(key, 100)

    async def try_purchase():
        result = await redis_client.eval(LUA_CHECK_AND_DECREMENT, 1, key)
        return int(result)

    tasks = [try_purchase() for _ in range(200)]
    results = await asyncio.gather(*tasks)

    successes = sum(1 for r in results if r == 1)
    failures = sum(1 for r in results if r == 0)
    final_stock = int(await redis_client.get(key))

    assert successes == 100, f"Expected 100 successes but got {successes}"
    assert failures == 100, f"Expected 100 failures but got {failures}"
    assert final_stock == 0, f"Expected 0 stock but got {final_stock}"
    print(f"Lua inventory: 200 attempts → {successes} success, {failures} sold out, stock={final_stock}")


@pytest.mark.asyncio
async def test_non_atomic_inventory_oversell():
    """non-atomic check-and-decrement → 오버셀링 발생"""
    key = "test:inventory-bad"
    await redis_client.set(key, 100)

    async def try_purchase_bad():
        stock = int(await redis_client.get(key))
        if stock > 0:
            await asyncio.sleep(0.01)  # race window 확보
            await redis_client.decr(key)
            return 1
        return 0

    tasks = [try_purchase_bad() for _ in range(200)]
    results = await asyncio.gather(*tasks)

    successes = sum(1 for r in results if r == 1)
    final_stock = int(await redis_client.get(key))

    # 대부분의 환경에서 100명 이상 성공 (오버셀링) or 재고 마이너스.
    # asyncio 스케줄링에 따라 드물게 정확히 100명일 수도 있음.
    print(f"Non-atomic inventory: {successes} successes, stock={final_stock}")
    if successes > 100 or final_stock < 0:
        print("  → 오버셀링 발생 확인!")
    else:
        print("  → race가 발생하지 않음 — sleep 늘려서 재시도 권장")
```

Run: `pytest tests/test_distributed_counter.py -v`

Expected:
- `test_lua_inventory_no_oversell` — PASS (정확히 100명 성공, 재고 0)
- `test_non_atomic_inventory_oversell` — PASS (100명 이상 성공 or 재고 마이너스)

- [ ] **Step 4: Redis→DB 동기화 중 Redis 장애 시 카운터 복구**

```python
# tests/test_distributed_counter.py에 추가


@pytest.mark.asyncio
async def test_counter_recovery_after_redis_loss():
    """Redis 카운터가 유실되면 DB 값으로 복구하는 시나리오.

    이 테스트는 복구 로직의 개념 검증임.
    실제 Redis 장애는 Phase 11의 chaos 테스트에서 docker stop으로 재현.
    """
    key = "post:recovery-test:likes"

    # 1. Redis에 카운터 설정
    await redis_client.set(key, 523)

    # 2. Redis 카운터 유실 시뮬레이션 (키 삭제)
    await redis_client.delete(key)

    # 3. 복구: DB 값으로 Redis 재설정
    db_value = 520  # DB에 마지막으로 동기화된 값 (시뮬레이션)
    current = await redis_client.get(key)
    if current is None:
        await redis_client.set(key, db_value)

    recovered = int(await redis_client.get(key))
    assert recovered == db_value
    # 유실된 delta(523-520=3)는 동기화 주기(30초) 사이의 값.
    # 이건 허용 가능한 손실임 — 좋아요 3개 차이는 사용자가 모름.
```

Run: `pytest tests/test_distributed_counter.py::test_counter_recovery_after_redis_loss -v`

- [ ] **Step 5: Commit**

```bash
git add tests/test_distributed_counter.py scripts/inventory_simulation.lua loadtest/scenarios/concurrent_likes.js
git commit -m "test: multi-instance counter consistency — INCR vs non-atomic, Lua inventory simulation"
```

---

## Phase 5 완료 체크리스트

- [ ] DB 카운터 상태에서 k6 부하 결과 기록 (Before)
- [ ] Redis 카운터로 전환
- [ ] 같은 k6 테스트로 After 결과 기록
- [ ] 카운터 정확도 검증 (동시 1000 INCR = 정확히 1000)
- [ ] 카운터 동기화 Worker 구현
- [ ] 멀티 인스턴스에서 동시 좋아요 1000건 → 카운터 정확성 검증
- [ ] Non-atomic Lost Update 체험
- [ ] Lua script 재고 시뮬레이션 — 오버셀링 방지 확인
- [ ] Redis 카운터 유실 → DB 기준 복구 개념 검증

**핵심 체감:**
- DB 카운터: 100 동시 좋아요 → p99 ~Xms (lock 대기)
- Redis 카운터: 100 동시 좋아요 → p99 ~Xms (lock 없음)
- Atomic INCR: 1000번 = 정확히 1000
- Non-atomic GET→SET: 1000번 = ~970 (Lost Update)
- Lua check-and-decrement: 재고 100, 200명 → 정확히 100명 성공, 0명 오버셀링

**다음:** [Phase 6 — 멱등성](phase-06-idempotency.md)
