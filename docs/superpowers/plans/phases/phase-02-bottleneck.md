# Phase 2: 병목 체감 — 100만 데이터에서 "왜 느린지" 직접 경험

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans

**전제:** Phase 1이 완료되어 순수 CRUD가 동작하는 상태

**학습 키워드**
`OFFSET vs Keyset Pagination` `Sequential Scan` `EXPLAIN ANALYZE` `MVCC` `COUNT(*) 비용` `Row Lock` `Write Amplification` `HOT Update` `Bulk INSERT`

---

## 학습: 왜 느려지는가?

이 Phase의 핵심은 **"데이터가 적을 때는 멀쩡하던 코드가 100만 건에서 왜 터지는지"를 직접 체감**하는 것. Phase 1에서 만든 코드는 의도적으로 느린 방식으로 작성했음. 여기서 병목을 눈으로 확인하고, Phase 3부터 하나씩 개선하면서 차이를 측정함.

### OFFSET 페이지네이션의 문제

**핵심 질문: "페이지네이션을 어떻게 구현하셨나요? OFFSET의 문제점은요?"**

OFFSET은 "N개를 건너뛰어라"는 의미인데, DB는 건너뛸 행들을 **실제로 읽고 버려야** 함. 인덱스가 있어도 마찬가지임. 왜냐하면 DB는 "999,980번째 행"이 물리적으로 어디에 있는지 모르기 때문. 하나씩 세면서 가는 수밖에 없음.

```sql
SELECT * FROM posts ORDER BY created_at DESC LIMIT 20 OFFSET 0;
-- → 20개만 읽으면 됨. ~1ms

SELECT * FROM posts ORDER BY created_at DESC LIMIT 20 OFFSET 999980;
-- → 999,980개를 읽고 버린 후 20개를 반환. ~500ms+
```

**이게 왜 심각한가:** 페이지 번호가 커질수록 선형으로 느려짐. 사용자가 뒤쪽 페이지를 볼 때마다 DB 부하가 올라감. 100만 CCU 환경에서 이런 쿼리가 초당 수천 번 실행되면 DB CPU가 포화됨.

**DB별로 이 문제가 다른가?**
- **PostgreSQL:** Heap table 구조라서 OFFSET이 커질수록 정직하게 느려짐
- **MySQL InnoDB:** 클러스터드 인덱스(PK 순서로 데이터 물리 정렬)라 PK 기반 범위 조회는 PG보다 유리할 수 있지만, OFFSET 자체의 문제는 동일함
- **MongoDB:** `skip()`이 정확히 같은 문제. cursor를 직접 관리하는 API가 있어서 대안 접근이 약간 다름

### COUNT(*) 의 비용

**핵심 질문: "전체 게시글 수를 어떻게 효율적으로 조회하나요?"**

```sql
SELECT count(*) FROM posts;  -- 100만 row에서 ~200-500ms
```

PostgreSQL의 MVCC 때문에 "지금 이 트랜잭션에서 보이는 row"를 매번 세야 함. 트랜잭션 A에서 삭제한 row가 트랜잭션 B에서는 아직 보이니까, "전체 몇 건"이라는 정답이 트랜잭션마다 다름. 그래서 메타데이터에 count를 저장해둘 수 없고, 매번 풀 테이블 스캔이 필요함.

**이게 왜 심각한가:** 게시판 목록 API가 `{ items: [...], total: 1000000 }` 형태로 total을 반환하려면, 매 요청마다 COUNT(*)가 실행됨. 목록 조회 1번 = SELECT(데이터) + COUNT(전체 수) = 쿼리 2번. 100만 row에서 COUNT 한 번이 500ms면, 목록 API의 최소 응답시간이 500ms부터 시작함.

**DB별 비교:**
- **PostgreSQL:** MVCC 때문에 정확한 count = 풀스캔 필수
- **MySQL InnoDB:** 동일한 MVCC 문제. 단, MyISAM 엔진은 메타데이터에 count를 저장해서 O(1)이지만, 트랜잭션을 지원 안 하니 실용적이지 않음
- **MongoDB:** `countDocuments()`는 풀스캔, `estimatedDocumentCount()`는 메타데이터 기반으로 빠르지만 근사값

**실무 해결법:** total 대신 `has_more` 플래그를 쓰는 커서 페이지네이션으로 전환하면 COUNT 자체가 불필요해짐 (Phase 3에서 구현).

### 조회수 UPDATE의 문제

**핵심 질문: "조회수를 어떻게 처리하셨나요? 동시성 문제는요?"**

매 조회마다 `UPDATE posts SET view_count = view_count + 1` 실행하면 세 가지 문제가 동시에 터짐:

1. **읽기인데 쓰기 부하:** 게시글 조회는 읽기 작업인데, DB에 쓰기(UPDATE)가 발생함. 읽기 99%, 쓰기 1%인 게시판에서 읽기마다 쓰기가 발생하면 실질적 쓰기 비율이 폭증함
2. **Row Lock 경합:** 인기글에 1000명이 동시 접속하면, 같은 row에 1000개 UPDATE가 순차 대기. 999명은 앞사람이 끝날 때까지 기다림
3. **Write Amplification:** PG에서 UPDATE 1건 = old tuple을 dead로 마킹 + new tuple 생성 + 인덱스 포인터 갱신. 단순 숫자 +1인데 실제 I/O는 훨씬 큼

이게 Phase 5에서 Redis INCR로 교체했을 때 극적인 차이가 나는 이유임.

### 심화 학습

| 키워드 | 왜 알아야 하는지 |
|--------|----------------|
| **MVCC (Multi-Version Concurrency Control)** | PG가 읽기와 쓰기를 동시에 허용하는 핵심 메커니즘. "읽기가 쓰기를 블록하지 않는다"의 원리. COUNT(*)가 느린 근본 원인이기도 함 |
| **Write Amplification** | UPDATE 1건의 실제 비용. PG는 in-place update가 아니라 새 tuple을 만듦. view_count +1이 생각보다 비싼 이유 |
| **HOT Update (Heap Only Tuple)** | PG가 인덱스 갱신 없이 UPDATE하는 최적화. 인덱스된 컬럼이 안 바뀌고 같은 페이지에 공간이 있을 때만 작동. FILLFACTOR 설정과 연관 |
| **VACUUM과 Dead Tuple** | UPDATE/DELETE로 생긴 죽은 행을 정리하는 프로세스. 안 돌리면 테이블 크기가 끝없이 증가(bloat)하고 성능 저하 |
| **pg_stat_user_tables** | seq_scan, idx_scan 횟수를 보여주는 시스템 뷰. "이 테이블에 인덱스가 효과적으로 쓰이고 있나?"를 판단하는 첫 번째 도구 |
| **Bulk INSERT 전략** | executemany vs COPY vs multi-row VALUES. COPY가 가장 빠르지만 asyncpg에서는 제약 있음 |

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
