# Phase 4: Redis 캐시 — "캐시가 왜 필요한지" 직접 체감

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans

**전제:** Phase 3 완료. 인덱스 + 커서 페이지네이션이 적용된 상태.

---

## 학습: 캐시란 무엇이고 왜 필요한가

### 캐시의 핵심 원리

DB 조회: 디스크 접근 + 쿼리 파싱 + 실행 = ~5-50ms
Redis 조회: 메모리 접근 = ~0.1ms

같은 게시글을 1000명이 읽으면?
- 캐시 없음: DB 쿼리 1000번 = 5000-50000ms의 DB 부하
- 캐시 있음: DB 쿼리 1번 + Redis 조회 999번 = ~100ms

### Cache-Aside 패턴 (우리가 사용할 패턴)

```
읽기:  캐시 확인 → 히트면 반환 / 미스면 DB 조회 → 캐시 저장 → 반환
쓰기:  DB 저장 → 캐시 무효화 (삭제)
```

**다른 캐시 패턴과 비교:**

| 패턴 | 동작 | 장점 | 단점 |
|------|------|------|------|
| **Cache-Aside** ✅ | 앱이 캐시를 직접 관리 | 단순, 제어 가능 | 첫 요청은 느림 (cold start) |
| Write-Through | 쓰기 시 캐시도 동시 갱신 | 캐시 항상 최신 | 안 읽는 데이터도 캐시에 적재 |
| Write-Behind | 캐시에 먼저 쓰고 나중에 DB | 쓰기가 빠름 | 캐시 장애 시 데이터 유실 위험 |
| Read-Through | 캐시가 알아서 DB에서 가져옴 | 앱 코드 단순 | 캐시 설정이 복잡 |

**Cache-Aside를 선택한 이유:** 가장 단순하고 제어 가능. 캐시 장애 시 DB 폴백이 자연스러움. 극한 상황에서 "캐시가 죽어도 서비스는 살아있어야" 하므로 앱이 직접 제어하는 게 안전함.

### Cache Stampede (캐시 폭풍)

인기 게시글 캐시가 만료되는 순간:
```
요청 1: 캐시 미스 → DB 조회 시작
요청 2: 캐시 미스 → DB 조회 시작    ← 아직 요청 1이 안 끝남
요청 3: 캐시 미스 → DB 조회 시작
...
요청 1000: 캐시 미스 → DB 조회 시작  ← 1000개가 동시에 DB로!
```

해결: **분산 락** — 1명만 DB 조회, 나머지는 대기 후 캐시에서 읽기.

**DB별 내부 캐시 비교:**
- **PostgreSQL:** shared_buffers (기본 128MB) — 자주 접근하는 페이지를 메모리에 캐시. Clock-sweep 알고리즘으로 교체
- **MySQL InnoDB:** Buffer Pool (기본 128MB) — LRU 변형. young/old 리스트로 풀스캔이 캐시를 오염시키는 걸 방지
- **MongoDB:** WiredTiger Cache (기본 RAM의 50%) — 내부 캐시가 커서 외부 캐시 없이도 어느 정도 버팀

하지만 이건 "DB 서버 내부" 캐시. 앱-DB 간 네트워크 비용은 줄일 수 없음 → Redis(앱 레벨 캐시)가 필요한 이유.

### TTL과 Eviction 정책

- **TTL (Time To Live):** 캐시 만료 시간. 5분 = 최대 5분간 구버전 데이터 노출 가능
- **Eviction:** 메모리 가득 차면 뭘 지울지
  - **LRU (Least Recently Used):** 가장 오래 안 쓴 것 제거. 범용적
  - **LFU (Least Frequently Used):** 가장 적게 쓴 것 제거. 인기 콘텐츠에 유리
  - **Random:** 무작위. 단순하지만 비효율적

---

## 구현

### Task 9: Redis 연결 + Cache-Aside 서비스

**Files:**
- Create: `src/redis_client.py`
- Create: `src/services/cache_service.py`
- Modify: `src/api/query/posts.py`
- Modify: `src/api/command/posts.py`
- Create: `tests/test_cache.py`

- [ ] **Step 1: Redis 연결 설정**

```python
# src/redis_client.py
import redis.asyncio as redis

from src.config import settings

redis_client = redis.from_url(settings.redis_url, decode_responses=True)
```

- [ ] **Step 2: Cache-Aside 서비스 구현**

```python
# src/services/cache_service.py
import json
from datetime import datetime

from src.redis_client import redis_client

DEFAULT_TTL = 300  # 5분


def _serialize_post(post_dict: dict) -> str:
    for key in ("created_at", "updated_at"):
        if key in post_dict and isinstance(post_dict[key], datetime):
            post_dict[key] = post_dict[key].isoformat()
    return json.dumps(post_dict)


def _deserialize_post(data: str) -> dict:
    return json.loads(data)


async def get_cached_post(post_id: str) -> dict | None:
    data = await redis_client.get(f"post:{post_id}")
    if data:
        return _deserialize_post(data)
    return None


async def set_cached_post(post_id: str, post_dict: dict, ttl: int = DEFAULT_TTL):
    await redis_client.set(f"post:{post_id}", _serialize_post(post_dict), ex=ttl)


async def invalidate_post(post_id: str):
    await redis_client.delete(f"post:{post_id}")
```

- [ ] **Step 3: Query API에 캐시 적용**

```python
# src/api/query/posts.py — get_post 수정
@router.get("/{post_id}", response_model=PostResponse)
async def get_post(post_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    # 1. 캐시 확인
    cached = await cache_service.get_cached_post(str(post_id))
    if cached:
        return cached

    # 2. DB 조회
    post = await post_service.get_post(db, post_id)
    if not post:
        raise HTTPException(status_code=404, detail="Post not found")

    # 3. 캐시 저장
    post_dict = PostResponse.model_validate(post).model_dump()
    await cache_service.set_cached_post(str(post_id), post_dict)
    return post
```

- [ ] **Step 4: Command API에서 캐시 무효화**

```python
# src/api/command/posts.py — update, delete 후 캐시 삭제
from src.services import cache_service

@router.put("/{post_id}", response_model=PostResponse)
async def update_post(...):
    post = await post_service.update_post(db, post_id, data)
    if post:
        await cache_service.invalidate_post(str(post_id))
    ...

@router.delete("/{post_id}", status_code=204)
async def delete_post(...):
    deleted = await post_service.delete_post(db, post_id)
    if deleted:
        await cache_service.invalidate_post(str(post_id))
    ...
```

- [ ] **Step 5: 캐시 히트/미스 테스트**

```python
# tests/test_cache.py
import pytest


@pytest.mark.asyncio
async def test_cache_hit(client):
    create = await client.post(
        "/api/posts", json={"title": "Cache", "content": "Test", "author": "a"}
    )
    post_id = create.json()["id"]

    # 첫 조회 — 캐시 미스
    r1 = await client.get(f"/api/posts/{post_id}")
    assert r1.status_code == 200

    # 두번째 조회 — 캐시 히트
    r2 = await client.get(f"/api/posts/{post_id}")
    assert r2.status_code == 200
    assert r1.json()["title"] == r2.json()["title"]


@pytest.mark.asyncio
async def test_cache_invalidation_on_update(client):
    create = await client.post(
        "/api/posts", json={"title": "Old", "content": "C", "author": "a"}
    )
    post_id = create.json()["id"]

    # 캐시 적재
    await client.get(f"/api/posts/{post_id}")

    # 수정 → 캐시 무효화
    await client.put(f"/api/posts/{post_id}", json={"title": "New", "version": 1})

    # 재조회 → DB에서 최신 데이터
    r = await client.get(f"/api/posts/{post_id}")
    assert r.json()["title"] == "New"
```

- [ ] **Step 6: 벤치마크 — 캐시 히트 vs 미스**

같은 게시글 1000번 연속 조회로 비교.
Expected: 캐시 히트 ~0.1ms vs 미스 ~5-50ms

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: Redis Cache-Aside — cache hit vs miss benchmark"
```

---

### Task 10: Cache Stampede 재현 + 해결

**Files:**
- Modify: `src/services/cache_service.py`

- [ ] **Step 1: Stampede 재현 테스트**

```python
# tests/test_cache.py에 추가
import asyncio


@pytest.mark.asyncio
async def test_cache_stampede(client):
    create = await client.post(
        "/api/posts", json={"title": "Hot", "content": "Post", "author": "a"}
    )
    post_id = create.json()["id"]

    # 캐시 적재 후 강제 만료
    await client.get(f"/api/posts/{post_id}")
    from src.redis_client import redis_client
    await redis_client.delete(f"post:{post_id}")

    # 동시 100 요청 — 전부 DB로 가면 stampede
    tasks = [client.get(f"/api/posts/{post_id}") for _ in range(100)]
    results = await asyncio.gather(*tasks)
    assert all(r.status_code == 200 for r in results)
```

- [ ] **Step 2: 분산 락으로 Stampede 방지**

```python
# src/services/cache_service.py에 추가
import asyncio


async def get_cached_post_safe(post_id: str, fetch_fn) -> dict:
    """분산 락으로 Cache Stampede 방지"""
    cached = await redis_client.get(f"post:{post_id}")
    if cached:
        return _deserialize_post(cached)

    # 락 획득 시도 (1명만 DB 조회)
    lock_key = f"lock:post:{post_id}"
    acquired = await redis_client.set(lock_key, "1", nx=True, ex=5)

    if acquired:
        result = await fetch_fn()
        if result:
            await set_cached_post(post_id, result)
        await redis_client.delete(lock_key)
        return result
    else:
        # 락 못 잡음 → 잠깐 대기 후 캐시 재확인
        await asyncio.sleep(0.05)
        cached = await redis_client.get(f"post:{post_id}")
        if cached:
            return _deserialize_post(cached)
        return await fetch_fn()  # 폴백
```

- [ ] **Step 3: Query API에서 safe 버전 적용**

- [ ] **Step 4: Stampede 테스트 재실행 — DB 쿼리 수 감소 확인**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: cache stampede prevention with distributed lock"
```

---

## Phase 4 완료 체크리스트

- [ ] Cache-Aside 패턴 구현 (get → set → invalidate)
- [ ] 캐시 히트/미스 응답시간 차이 측정
- [ ] 수정/삭제 시 캐시 무효화 동작 확인
- [ ] Cache Stampede 재현 + 분산 락으로 해결

**핵심 체감:**
- 캐시 히트: ~0.1ms / 미스: ~5-50ms → **50-500배 차이**
- Stampede: 분산 락 없이 100 동시 요청 → DB 100번 / 락 있으면 DB 1번

**다음:** [Phase 5 — Redis 카운터](phase-05-redis-counter.md)
