# Phase 3: DB 최적화 — 인덱스 + 커서 페이지네이션

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans

**전제:** Phase 2 완료. 100만 데이터가 있고, OFFSET의 느림을 체감한 상태.

**학습 키워드**
`B-tree Index` `Clustered vs Heap Table` `Index Scan vs Seq Scan` `Covering Index` `Partial Index` `Expression Index` `Cursor Pagination` `Keyset Pagination` `EXPLAIN ANALYZE` `Index Selectivity`

---

## 학습: 인덱스와 커서 페이지네이션

Phase 2에서 확인한 병목: OFFSET 느림, COUNT(*) 비쌈, 조회수 UPDATE 경합. 이 Phase에서는 앞의 두 가지를 해결함. (조회수는 Phase 5에서 Redis로 해결.)

### 인덱스 — "DB 성능 튜닝의 80%는 인덱스"

**핵심 질문: "인덱스가 어떻게 동작하는지 설명해주세요. 아무 컬럼에나 다 걸면 좋나요?"**

인덱스 없이 "created_at으로 정렬된 최신 20개"를 찾으려면 100만 개를 전부 읽고 정렬해서 20개를 반환해야 함. 이게 Seq Scan. 인덱스는 "이미 정렬된 별도 자료구조(B-tree)"를 만들어두는 것. 목차에서 바로 원하는 위치로 점프할 수 있음.

```
Seq Scan:   [1] [2] [3] ... [999,999] [1,000,000] → 전부 읽음
Index Scan: B-tree 목차 → [1,000,000] → [999,999] → ... → [999,981] → 20개만 읽음
```

**인덱스를 아무 데나 걸면 안 되는 이유:**
- 인덱스 = 별도 자료구조 = **디스크 공간 추가 사용**. 100만 row 테이블에 인덱스 5개면 테이블보다 인덱스가 더 클 수 있음
- INSERT/UPDATE/DELETE마다 **인덱스도 같이 갱신**해야 함. 인덱스가 많을수록 쓰기가 느려짐
- 읽기 99% / 쓰기 1% 게시판에서는 인덱스가 유리하지만, 쓰기 비율이 높은 시스템(채팅, 로그)에서는 오히려 해가 될 수 있음

**어떤 컬럼에 인덱스를 거는가:**
- WHERE 절에 자주 쓰이는 컬럼 (`created_at`, `author`)
- ORDER BY에 쓰이는 컬럼 (`created_at DESC`)
- JOIN 조건 컬럼 (`post_id`)
- Selectivity가 높은 컬럼 (고유한 값이 많은 컬럼). `gender` (2종류)에 인덱스 거는 건 낭비, `email` (유일)은 효과적

**DB별 인덱스 구조 차이 — 이 차이를 알면 DB 선택 근거가 명확해짐:**

| 기준 | PostgreSQL | MySQL (InnoDB) | MongoDB |
|------|-----------|----------------|---------|
| 기본 인덱스 구조 | B-tree | B+tree (클러스터드) | B-tree |
| 데이터 저장 방식 | Heap table (데이터와 인덱스 분리) | PK가 클러스터드 인덱스 (데이터가 PK 순서로 정렬) | _id가 클러스터드 |
| 커버링 인덱스 | Index-Only Scan | Using index | Covered query |
| 부분 인덱스 | `WHERE active = true` 지원 | 미지원 | Partial index 지원 |
| 표현식 인덱스 | `lower(email)` 가능 | Generated column 필요 | 미지원 |

**PostgreSQL vs MySQL의 핵심 차이:**
- MySQL InnoDB는 PK가 클러스터드 인덱스. 데이터가 PK 순서로 물리적으로 정렬되어 있음. PK 범위 조회(`WHERE id BETWEEN 100 AND 200`)가 디스크에서 연속 읽기라 매우 빠름
- PostgreSQL은 Heap table. 데이터가 삽입 순서로 쌓이고, 인덱스는 행의 물리적 위치(ctid)를 가리킴. 인덱스를 통한 접근에서 "random I/O"가 발생할 수 있어서 대량 조회에서 MySQL보다 불리할 수 있음
- 대신 PG는 부분 인덱스(`WHERE is_deleted = false`만 인덱싱)나 표현식 인덱스(`lower(email)`)를 지원해서 더 정밀한 최적화가 가능함

### 커서 페이지네이션 — OFFSET의 근본적 해결

**핵심 질문: "커서 기반 페이지네이션이 OFFSET보다 왜 좋은가요? 단점은 없나요?"**

```sql
-- OFFSET: "999,980개 건너뛰고 20개 줘" → DB가 999,980개를 세면서 이동
SELECT * FROM posts ORDER BY created_at DESC LIMIT 20 OFFSET 999980;

-- 커서: "이 시점 이전 20개 줘" → 인덱스에서 해당 시점으로 바로 점프
SELECT * FROM posts WHERE created_at < '2025-01-01' ORDER BY created_at DESC LIMIT 20;
```

커서가 빠른 이유: B-tree 인덱스에서 `'2025-01-01'`을 찾는 건 O(log N)이고, 거기서 20개를 읽는 건 O(20). 데이터가 100만이든 1억이든 **항상 일정한 시간**.

| 기준 | OFFSET | 커서 |
|------|--------|------|
| 뒤쪽 페이지 성능 | O(N) — 데이터 많을수록 느림 | O(log N + K) — 항상 일정 |
| "N페이지로 점프" | 가능 | 불가능 (순차만) |
| 실시간 데이터 추가 | 중복/누락 발생 가능 | 안정적 |
| COUNT(*) 필요 여부 | 총 페이지 수 계산에 필요 | 불필요 (`has_more` 플래그) |

**커서의 단점:** "37페이지로 바로 이동" 같은 기능이 불가능함. 대신 현대 UI에서 게시판은 무한스크롤/더보기 방식이 대세라서, 이 제약이 실제로 문제가 되는 경우는 거의 없음. Google, Twitter, Instagram 전부 커서 기반임.

**OFFSET을 쓰면서도 성능을 개선하는 방법:** 없는 건 아님. "Deferred JOIN" 패턴(`SELECT * FROM posts WHERE id IN (SELECT id FROM posts ORDER BY created_at LIMIT 20 OFFSET 999980)`)으로 서브쿼리에서 PK만 먼저 찾고 본 데이터를 조회하면 약간 나아지지만, 근본적 해결은 아님.

### EXPLAIN ANALYZE — 쿼리가 느린 이유를 찾는 도구

**핵심 질문: "슬로우 쿼리 발견했을 때 어떻게 대응하셨나요?"**

```
Limit  (cost=0.42..1.23 rows=20 width=200) (actual time=0.05..0.12 rows=20 loops=1)
  ->  Index Scan Backward using ix_posts_created_at on posts
        (actual time=0.04..0.10 rows=20 loops=1)
Planning Time: 0.15 ms
Execution Time: 0.18 ms
```

읽는 법:
- `Seq Scan` → 인덱스 안 타고 풀스캔. 대부분 느림의 원인
- `Index Scan` → 인덱스 사용. 좋은 신호
- `Index Scan Backward` → 인덱스를 역순으로 탐색. `ORDER BY DESC`에 대응
- `actual time=0.04..0.10` → 첫 행까지 0.04ms, 마지막 행까지 0.10ms
- `rows=20` → 실제 처리한 행 수. 예상(rows 앞 숫자)과 실제가 크게 다르면 통계가 부정확하다는 신호 → `ANALYZE` 실행 필요

**cost vs actual time:** cost는 PG의 예상 비용(상대값), actual time은 실제 소요 시간(ms). 최적화할 때는 actual time을 봐야 함.

### 심화 학습

| 키워드 | 왜 알아야 하는지 |
|--------|----------------|
| **Covering Index (Index-Only Scan)** | 테이블에 접근하지 않고 인덱스만으로 결과 반환. `SELECT id, created_at`만 필요하면 해당 컬럼만 있는 인덱스로 I/O를 대폭 줄일 수 있음 |
| **Partial Index** | `CREATE INDEX ON posts(created_at) WHERE is_deleted = false` — 활성 데이터만 인덱싱. 인덱스 크기 줄이고 쓰기 오버헤드 줄임. PG의 강력한 기능 |
| **BRIN Index** | Block Range INdex. 시계열 데이터(로그, 게시글)에서 B-tree 대비 100배 작은 크기. 단점: 정확도가 낮아서 많은 row를 재검사해야 할 수 있음 |
| **pg_stat_statements** | 실행된 모든 쿼리의 통계(총 시간, 평균 시간, 호출 횟수). `ORDER BY total_time DESC`로 가장 비싼 쿼리 Top 10을 찾는 게 성능 튜닝의 출발점 |
| **Query Planner와 Statistics** | PG가 쿼리 플랜을 선택하는 기준. `pg_stats`의 통계가 부정확하면 잘못된 플랜을 선택함. `ANALYZE` 명령으로 통계 갱신 |

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
