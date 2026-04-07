# Phase 5: Redis 카운터 — DB 락 vs Redis INCR 직접 비교

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans

**전제:** Phase 4 완료. 캐시가 동작하는 상태. 좋아요/조회수는 아직 DB 직접 UPDATE.

**학습 키워드**
`Redis Single Thread` `INCR/DECR Atomicity` `Row Lock (Exclusive Lock)` `GETSET (atomic swap)` `Redis Persistence (RDB/AOF)` `Pipeline/MULTI` `Bulk UPDATE` `k6 Load Test` `Eventual Consistency`

---

## 학습: 왜 카운터를 Redis로 분리하는가

### DB 카운터의 문제

현재 좋아요 구현:
```python
UPDATE posts SET like_count = like_count + 1 WHERE id = ?
```

이 UPDATE는 해당 row에 **배타적 락(exclusive lock)**을 건다. 1000명이 동시에 같은 게시글에 좋아요 → 999명이 줄 서서 대기.

**더 큰 문제:** 조회수도 DB UPDATE → 읽기 요청인데 쓰기 부하 발생. 100만 CCU가 인기글을 읽을 때마다 DB가 병목.

### Redis INCR의 원리

Redis는 **싱글스레드**. 모든 명령이 순차적으로 실행됨 → 락이 필요 없음.
`INCR key` = "값을 1 올려라"가 원자적으로 실행. 1000개 동시 INCR = 정확히 1000 증가.

**DB별 카운터 동시성 비교:**

| | PostgreSQL | MySQL | MongoDB | Redis |
|---|---|---|---|---|
| 메커니즘 | Row Lock + MVCC | Row Lock + Gap Lock | Document Lock | 싱글스레드 (락 없음) |
| 1000 동시 +1 | 직렬화 (느림) | 직렬화 + 갭 락 위험 | 직렬화 | 병렬 (빠름) |
| 정확도 | 정확 | 정확 | 정확 | 정확 |
| 속도 | ~1ms/건 + 대기 | ~1ms/건 + 대기 | ~1ms/건 + 대기 | ~0.01ms/건 |

### 카운터와 DB 제약조건은 별개

- **Redis 카운터:** "지금 좋아요 몇 개?" → 빠른 읽기/쓰기 (성능)
- **DB 제약조건:** "이 유저가 이미 좋아요 했는지" → UNIQUE(user_id, post_id) (정합성)
- **주기적 동기화:** Redis 카운터 값 → DB에 벌크 UPDATE (영속성)

셋은 보완 관계. Redis가 장애 나도 DB 제약조건이 정합성을 지킴.

### 동기화 전략: GETSET

```
GETSET post:1:views 0
→ 현재 값(예: 523)을 반환하고, 0으로 초기화. 원자적.
→ 반환된 523을 DB에 UPDATE posts SET view_count = view_count + 523
```

이걸 30초마다 벌크로 실행 → DB 부하 최소화.

### 심화 학습 — 더 깊이 파볼 키워드

| 키워드 | 왜 알아야 하는지 |
|--------|----------------|
| **Redis Persistence (RDB/AOF)** | Redis 재시작 시 데이터 복구. RDB는 스냅샷, AOF는 명령 로그. 카운터 유실 위험도와 직결 |
| **Redis Pipeline** | 여러 명령을 한 번에 보내서 네트워크 왕복 줄임. 벌크 카운터 조회 시 필수 |
| **Redis MULTI/EXEC** | 트랜잭션. 여러 명령을 원자적으로 실행. INCR + EXPIRE를 묶을 때 사용 |
| **Redis Memory Policy** | maxmemory 초과 시 어떤 키를 삭제할지. 카운터는 noeviction이어야 함 |
| **HyperLogLog** | 고유 방문자 수(UV) 같은 근사 카운팅. 12KB로 수억 개 카운트 가능 |

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


async def sync_counters():
    while True:
        await asyncio.sleep(SYNC_INTERVAL)
        try:
            cursor = 0
            batch = []
            while True:
                cursor, keys = await redis_client.scan(
                    cursor, match="post:*:views", count=100
                )
                for key in keys:
                    post_id = key.split(":")[1]
                    delta = await redis_client.getset(key, 0)
                    if delta and int(delta) > 0:
                        batch.append((post_id, int(delta)))
                if cursor == 0:
                    break

            if batch:
                async with async_session() as db:
                    for post_id, delta in batch:
                        await db.execute(
                            text(
                                "UPDATE posts SET view_count = view_count + :delta "
                                "WHERE id = :post_id"
                            ),
                            {"delta": delta, "post_id": post_id},
                        )
                    await db.commit()
                print(f"Synced {len(batch)} view counters")
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

from src.services.counter_service import get_counters, increment_view


@pytest.mark.asyncio
async def test_counter_accuracy():
    """1000번 동시 INCR → 정확히 1000"""
    test_id = "accuracy-test"
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

## Phase 5 완료 체크리스트

- [ ] DB 카운터 상태에서 k6 부하 결과 기록 (Before)
- [ ] Redis 카운터로 전환
- [ ] 같은 k6 테스트로 After 결과 기록
- [ ] 카운터 정확도 검증 (동시 1000 INCR = 정확히 1000)
- [ ] 카운터 동기화 Worker 구현

**핵심 체감:**
- DB 카운터: 100 동시 좋아요 → p99 ~Xms (lock 대기)
- Redis 카운터: 100 동시 좋아요 → p99 ~Xms (lock 없음)

**다음:** [Phase 6 — 멱등성](phase-06-idempotency.md)
