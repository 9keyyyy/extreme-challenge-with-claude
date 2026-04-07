# Phase 3: DB 최적화 — 인덱스 + 커서 페이지네이션

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans

**전제:** Phase 2 완료. 100만 데이터가 있고, OFFSET의 느림을 체감한 상태.

**학습 키워드**
`B-tree Index` `Clustered vs Heap Table` `Index Scan vs Seq Scan` `Covering Index` `Partial Index` `Expression Index` `Cursor Pagination` `Keyset Pagination` `EXPLAIN ANALYZE` `Index Selectivity`

---

## 학습: 인덱스와 커서 페이지네이션

### 인덱스란?

인덱스 없이 "created_at으로 정렬된 최신 20개"를 찾으려면?
→ 100만 개를 전부 읽고 정렬해서 20개 반환. 이게 **Seq Scan(순차 스캔)**.

인덱스는 "이미 정렬된 목차"를 별도로 만들어두는 것.
→ 목차에서 바로 최신 20개 위치를 찾아서 반환. 이게 **Index Scan**.

```
Seq Scan:   [1] [2] [3] ... [999,999] [1,000,000] → 전부 읽음
Index Scan: 목차 → [1,000,000] [999,999] ... [999,981] → 20개만 읽음
```

**DB별 인덱스 비교:**

| 기준 | PostgreSQL | MySQL (InnoDB) | MongoDB |
|------|-----------|----------------|---------|
| 기본 인덱스 구조 | B-tree | B+tree (클러스터드) | B-tree |
| 클러스터드 인덱스 | 없음 (heap table) | PK가 클러스터드 인덱스 | _id가 클러스터드 |
| 커버링 인덱스 | Index-Only Scan | Using index | Covered query |
| 부분 인덱스 | `WHERE active = true` 지원 | 미지원 | Partial index 지원 |
| 표현식 인덱스 | `lower(email)` 가능 | Generated column 필요 | 미지원 |

**PostgreSQL의 특징:**
- Heap table (데이터와 인덱스가 별도) → 인덱스가 행 위치(ctid)를 가리킴
- MySQL은 PK 순서로 데이터가 물리적으로 정렬됨 (클러스터드) → PK 범위 조회가 빠름
- PostgreSQL은 물리적 정렬이 없음 → 대신 BRIN 인덱스로 범위 조회 최적화 가능

### 커서 페이지네이션 vs OFFSET

```sql
-- OFFSET: N개를 건너뛰어야 해서 느림
SELECT * FROM posts ORDER BY created_at DESC LIMIT 20 OFFSET 999980;

-- 커서: "이 시점 이전" 조건으로 인덱스를 타서 빠름
SELECT * FROM posts WHERE created_at < '2025-01-01' ORDER BY created_at DESC LIMIT 20;
```

| 기준 | OFFSET | 커서 |
|------|--------|------|
| 뒤쪽 페이지 성능 | O(N) — 느려짐 | O(1) — 일정 |
| "N페이지로 점프" | 가능 | 불가능 |
| 실시간 데이터 추가 | 중복/누락 발생 | 안정적 |
| 구현 난이도 | 쉬움 | 약간 복잡 |

**결론:** 커뮤니티 게시판에서 "50000페이지로 점프"하는 유저는 없음. 무한 스크롤/더보기가 자연스러움 → 커서가 적합함.

### EXPLAIN ANALYZE 읽는 법

```
Limit  (cost=0.42..1.23 rows=20 width=200) (actual time=0.05..0.12 rows=20 loops=1)
  ->  Index Scan Backward using ix_posts_created_at on posts  ← 인덱스 사용!
        (actual time=0.04..0.10 rows=20 loops=1)
Planning Time: 0.15 ms
Execution Time: 0.18 ms  ← 실제 소요 시간
```

핵심 확인 포인트:
- `Seq Scan` → 인덱스 안 탐. 풀스캔.
- `Index Scan` → 인덱스 사용. 빠름.
- `actual time` → 실제 소요 시간 (ms)
- `rows` → 실제 처리한 행 수

### 심화 학습 — 더 깊이 파볼 키워드

| 키워드 | 왜 알아야 하는지 |
|--------|----------------|
| **Index Selectivity** | 인덱스가 얼마나 효과적인지의 지표. `gender` (2종류)보다 `email` (고유)이 selectivity 높음 |
| **Covering Index (Index-Only Scan)** | 인덱스만으로 쿼리 결과를 반환. 테이블 접근 0. PG에서는 INCLUDE 절로 구현 |
| **Partial Index** | `WHERE is_deleted = false` 조건부 인덱스. 활성 데이터만 인덱싱해서 크기 줄임. PG 전용 기능 |
| **BRIN Index** | 시계열 데이터에 특화. B-tree보다 100배 작은 크기. created_at 같은 순차 데이터에 적합 |
| **pg_stat_statements** | 실행된 쿼리별 통계 (평균 시간, 호출 횟수). 느린 쿼리 Top 10 찾는 도구 |
| **Deferred Constraints** | 트랜잭션 끝에서 제약조건 검사. 순환 참조나 벌크 INSERT에서 유용 |

---

## 구현

### Task 7: 인덱스 추가

**Files:**
- Create: `alembic/versions/xxx_add_indexes.py` (자동 생성)

- [ ] **Step 1: 인덱스 Before — 현재 쿼리 플랜 기록**

```bash
docker compose exec db psql -U postgres -d extreme_board -c \
  "EXPLAIN ANALYZE SELECT * FROM posts ORDER BY created_at DESC LIMIT 20;"
```

Expected: Seq Scan 또는 Sort 노드 확인. 시간 기록.

- [ ] **Step 2: Alembic 마이그레이션으로 인덱스 추가**

Run: `docker compose exec app alembic revision -m "add performance indexes"`

마이그레이션 파일에 추가:
```python
def upgrade():
    op.create_index("ix_posts_created_at", "posts", ["created_at"], postgresql_using="btree")
    op.create_index("ix_posts_author", "posts", ["author"], postgresql_using="btree")
    op.create_index(
        "ix_comments_post_created", "comments", ["post_id", "created_at"], postgresql_using="btree"
    )


def downgrade():
    op.drop_index("ix_comments_post_created")
    op.drop_index("ix_posts_author")
    op.drop_index("ix_posts_created_at")
```

Run: `docker compose exec app alembic upgrade head`

- [ ] **Step 3: 인덱스 After — 쿼리 플랜 재확인**

```bash
docker compose exec db psql -U postgres -d extreme_board -c \
  "EXPLAIN ANALYZE SELECT * FROM posts ORDER BY created_at DESC LIMIT 20;"
```

Expected: `Index Scan Backward using ix_posts_created_at` — Seq Scan이 Index Scan으로 변경!

- [ ] **Step 4: OFFSET은 인덱스가 있어도 여전히 느린지 확인**

```bash
docker compose exec db psql -U postgres -d extreme_board -c \
  "EXPLAIN ANALYZE SELECT * FROM posts ORDER BY created_at DESC LIMIT 20 OFFSET 999980;"
```

Expected: Index Scan이지만 여전히 수백ms. **인덱스만으로는 OFFSET 문제가 해결되지 않음.**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add performance indexes — Seq Scan → Index Scan"
```

---

### Task 8: 커서 기반 페이지네이션

**Files:**
- Modify: `src/schemas/post.py`
- Modify: `src/services/post_service.py`
- Modify: `src/api/query/posts.py`
- Modify: `tests/test_posts.py`
- Modify: `scripts/benchmark_compare.py`

- [ ] **Step 1: 커서 스키마 추가**

```python
# src/schemas/post.py에 추가
class PostCursorListResponse(BaseModel):
    items: list[PostResponse]
    next_cursor: str | None
    has_more: bool
```

- [ ] **Step 2: 커서 서비스 구현**

```python
# src/services/post_service.py에 추가
from datetime import datetime

async def list_posts_cursor(
    db: AsyncSession, cursor: datetime | None = None, size: int = 20
) -> tuple[list[Post], bool]:
    query = select(Post).order_by(Post.created_at.desc()).limit(size + 1)
    if cursor:
        query = query.where(Post.created_at < cursor)
    result = await db.execute(query)
    posts = list(result.scalars().all())
    has_more = len(posts) > size
    return posts[:size], has_more
```

**왜 `size + 1`을 조회?**
→ 21개를 요청해서 실제로 21개가 오면 "다음 페이지 있음", 20개 이하면 "마지막 페이지". has_more 판단을 추가 쿼리 없이 해결하는 트릭.

- [ ] **Step 3: Query API 엔드포인트 추가**

```python
# src/api/query/posts.py에 추가
from datetime import datetime

@router.get("/cursor", response_model=PostCursorListResponse)
async def list_posts_cursor(
    cursor: datetime | None = Query(default=None),
    size: int = Query(default=20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    posts, has_more = await post_service.list_posts_cursor(db, cursor, size)
    next_cursor = posts[-1].created_at.isoformat() if posts and has_more else None
    return PostCursorListResponse(
        items=posts, next_cursor=next_cursor, has_more=has_more
    )
```

- [ ] **Step 4: 벤치마크 비교 — OFFSET vs 커서**

scripts/benchmark_compare.py에 커서 측정 추가:

```python
# 커서로 "마지막 근처" 조회
start = time.perf_counter()
await client.get("/api/posts/cursor?cursor=2025-04-08T00:00:00Z&size=20")
results["cursor_deep"] = time.perf_counter() - start
```

Run: `docker compose exec app python scripts/benchmark_compare.py`

Expected:
```
list_page_1:       ~Xms
list_page_50000:   ~XXXms   ← OFFSET 병목
cursor_deep:       ~Xms     ← 커서는 위치 무관하게 빠름!
```

- [ ] **Step 5: 테스트 추가**

```python
# tests/test_posts.py에 추가
@pytest.mark.asyncio
async def test_cursor_pagination(client):
    for i in range(5):
        await client.post(
            "/api/posts",
            json={"title": f"Post {i}", "content": "C", "author": "a"},
        )

    # 첫 페이지
    r1 = await client.get("/api/posts/cursor?size=2")
    assert r1.status_code == 200
    data1 = r1.json()
    assert len(data1["items"]) == 2
    assert data1["has_more"] is True

    # 다음 페이지 (커서 사용)
    r2 = await client.get(f"/api/posts/cursor?size=2&cursor={data1['next_cursor']}")
    data2 = r2.json()
    assert len(data2["items"]) == 2
    # 중복 없음
    ids1 = {item["id"] for item in data1["items"]}
    ids2 = {item["id"] for item in data2["items"]}
    assert ids1.isdisjoint(ids2)
```

- [ ] **Step 6: 테스트 실행**

Run: `docker compose exec app pytest tests/test_posts.py -v`
Expected: All PASSED

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: cursor pagination — constant time regardless of position"
```

---

## Phase 3 완료 체크리스트

- [ ] 인덱스 추가 후 EXPLAIN ANALYZE에서 Seq Scan → Index Scan 확인
- [ ] "인덱스가 있어도 OFFSET은 느리다" 확인
- [ ] 커서 페이지네이션 구현 + 위치 무관한 일정 성능 확인
- [ ] Before/After 벤치마크 수치 비교 기록

**핵심 체감:**
- 인덱스: Seq Scan ~Xms → Index Scan ~Xms (정렬 비용 제거)
- OFFSET 999980: 인덱스 있어도 ~XXXms (여전히 느림)
- 커서: 어느 위치든 ~Xms (일정!)

**다음:** [Phase 4 — Redis 캐시 도입](phase-04-redis-cache.md)
