# Phase 2: 병목 체감 — 100만 데이터에서 "왜 느린지" 직접 경험

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans

**전제:** Phase 1이 완료되어 순수 CRUD가 동작하는 상태

---

## 학습: 왜 느려지는가?

### OFFSET 페이지네이션의 문제

OFFSET은 "N개를 건너뛰어라"는 의미. DB는 건너뛰더라도 그 행들을 읽어야 함:

```sql
SELECT * FROM posts ORDER BY created_at DESC LIMIT 20 OFFSET 0;
-- → 20개만 읽으면 됨. 빠름.

SELECT * FROM posts ORDER BY created_at DESC LIMIT 20 OFFSET 999980;
-- → 999,980개를 읽고 버린 후 20개를 반환. 느림!
```

**비유:** 책에서 50쪽을 찾으려면 50번째 페이지를 직접 펼치면 됨(커서). OFFSET은 1쪽부터 49쪽까지 한 장씩 넘기면서 50쪽까지 가는 것.

**DB별 비교:**
- **PostgreSQL:** OFFSET이 커질수록 선형으로 느려짐. 100만 row에서 마지막 페이지는 수백ms
- **MySQL:** 동일한 문제. InnoDB의 클러스터드 인덱스 특성상 PG보다 조금 나을 수 있지만 근본적으로 같은 문제
- **MongoDB:** `skip()`이 OFFSET과 동일한 문제. 내부적으로 커서를 사용하므로 대안이 비슷

### COUNT(*) 의 비용

```sql
SELECT count(*) FROM posts;
```

PostgreSQL은 MVCC 때문에 "지금 보이는 row가 몇 개인지" 매번 세야 함. 각 트랜잭션마다 보이는 row가 다를 수 있기 때문.

**DB별 비교:**
- **PostgreSQL:** 정확한 count = 풀 테이블 스캔 필수. 100만 row에서 ~200-500ms
- **MySQL InnoDB:** 동일한 문제 (MVCC). MyISAM은 메타데이터에 count를 저장하므로 O(1)이지만 트랜잭션 미지원
- **MongoDB:** `countDocuments()`는 정확하지만 풀스캔, `estimatedDocumentCount()`는 빠르지만 근사값

### 조회수 UPDATE의 문제

매 조회마다 `UPDATE posts SET view_count = view_count + 1`:
- 읽기 요청인데 쓰기 부하 발생
- 같은 row에 동시 UPDATE → row lock 경합
- 100만 CCU가 인기 게시글을 볼 때마다 DB가 병목

---

## 구현

### Task 5: 100만 게시글 시드

**Files:**
- Create: `scripts/seed_data.py`

- [ ] **Step 1: 시드 스크립트 작성**

```python
# scripts/seed_data.py
"""100만 게시글 시드 — 벌크 INSERT로 빠르게 적재"""
import asyncio
import random
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

DATABASE_URL = "postgresql+asyncpg://postgres:postgres@localhost:5432/extreme_board"
BATCH_SIZE = 10_000
TOTAL_POSTS = 1_000_000


async def seed():
    engine = create_async_engine(DATABASE_URL)

    print(f"Seeding {TOTAL_POSTS:,} posts...")
    start = datetime.now()
    base_time = datetime.now(timezone.utc) - timedelta(days=365)

    async with engine.begin() as conn:
        for batch_start in range(0, TOTAL_POSTS, BATCH_SIZE):
            values = []
            for i in range(batch_start, min(batch_start + BATCH_SIZE, TOTAL_POSTS)):
                created = base_time + timedelta(minutes=i)
                values.append(
                    f"('{uuid.uuid4()}', 'Post {i}', 'Content for post {i}. "
                    f"This is a sample post with some text.', "
                    f"'user{random.randint(1, 10000)}', "
                    f"{random.randint(0, 10000)}, {random.randint(0, 5000)}, "
                    f"1, '{created.isoformat()}', '{created.isoformat()}')"
                )
            await conn.execute(
                text(
                    "INSERT INTO posts (id, title, content, author, view_count, "
                    "like_count, version, created_at, updated_at) VALUES "
                    + ",".join(values)
                )
            )

            elapsed = (datetime.now() - start).total_seconds()
            done = min(batch_start + BATCH_SIZE, TOTAL_POSTS)
            rate = done / elapsed if elapsed > 0 else 0
            print(f"  {done:>10,} / {TOTAL_POSTS:,}  ({rate:,.0f} rows/sec)")

    elapsed = (datetime.now() - start).total_seconds()
    print(f"Done in {elapsed:.1f}s ({TOTAL_POSTS / elapsed:,.0f} rows/sec)")
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(seed())
```

- [ ] **Step 2: 시드 실행**

Run: `docker compose exec app python scripts/seed_data.py`
Expected: ~1-3분, 100만 row 적재

- [ ] **Step 3: 적재 확인**

Run: `docker compose exec db psql -U postgres -d extreme_board -c "SELECT count(*) FROM posts;"`
Expected: `1000000`

- [ ] **Step 4: Commit**

```bash
git add scripts/seed_data.py
git commit -m "feat: seed script for 1M posts"
```

---

### Task 6: 병목 측정 — Before 기준선

**Files:**
- Create: `scripts/benchmark_compare.py`

- [ ] **Step 1: EXPLAIN ANALYZE로 쿼리 플랜 확인**

```bash
# 첫 페이지 (빠름)
docker compose exec db psql -U postgres -d extreme_board -c \
  "EXPLAIN ANALYZE SELECT * FROM posts ORDER BY created_at DESC LIMIT 20 OFFSET 0;"

# 마지막 페이지 (느림!)
docker compose exec db psql -U postgres -d extreme_board -c \
  "EXPLAIN ANALYZE SELECT * FROM posts ORDER BY created_at DESC LIMIT 20 OFFSET 999980;"
```

Expected:
- OFFSET 0: ~1-5ms (Index/Seq Scan + Limit)
- OFFSET 999980: ~500ms-1s+ (999,980개 스캔 후 20개 반환)

**이 숫자를 기록. Phase 3에서 다시 비교함.**

- [ ] **Step 2: COUNT 비용 확인**

```bash
docker compose exec db psql -U postgres -d extreme_board -c \
  "EXPLAIN ANALYZE SELECT count(*) FROM posts;"
```

Expected: Seq Scan, ~200-500ms. 이게 매 목록 요청마다 실행됨.

- [ ] **Step 3: 벤치마크 스크립트 작성**

```python
# scripts/benchmark_compare.py
"""Before/After 벤치마크 비교"""
import asyncio
import time

from httpx import AsyncClient

BASE_URL = "http://localhost:8000"


async def benchmark():
    async with AsyncClient(base_url=BASE_URL, timeout=30.0) as client:
        results = {}

        # 목록 1페이지
        start = time.perf_counter()
        await client.get("/api/posts?page=1&size=20")
        results["list_page_1"] = time.perf_counter() - start

        # 목록 마지막 페이지 (OFFSET 병목)
        start = time.perf_counter()
        await client.get("/api/posts?page=50000&size=20")
        results["list_page_50000"] = time.perf_counter() - start

        # 단일 조회 (+ 조회수 UPDATE)
        first_page = await client.get("/api/posts?page=1&size=1")
        post_id = first_page.json()["items"][0]["id"]
        start = time.perf_counter()
        await client.get(f"/api/posts/{post_id}")
        results["get_single"] = time.perf_counter() - start

        print("=== Benchmark Results (Before Optimization) ===")
        for key, value in results.items():
            print(f"  {key}: {value * 1000:.1f}ms")


if __name__ == "__main__":
    asyncio.run(benchmark())
```

- [ ] **Step 4: 벤치마크 실행**

Run: `docker compose exec app python scripts/benchmark_compare.py`
Expected: page_50000이 page_1보다 수십~수백 배 느림

- [ ] **Step 5: Commit**

```bash
git add scripts/benchmark_compare.py
git commit -m "feat: benchmark script — baseline before optimization"
```

---

## Phase 2 완료 체크리스트

- [ ] 100만 게시글 시드 완료
- [ ] OFFSET 페이지네이션의 선형 성능 저하 직접 확인 (EXPLAIN ANALYZE)
- [ ] COUNT(*)의 풀스캔 비용 확인
- [ ] Before 벤치마크 수치 기록

**핵심 체감:**
- 1페이지: ~Xms / 50000페이지: ~Xms → **OFFSET은 뒤로 갈수록 선형으로 느려진다**
- COUNT: ~Xms → **매 요청마다 이 비용이 발생한다**

**다음:** [Phase 3 — 인덱스 + 커서 페이지네이션](phase-03-db-optimization.md)
