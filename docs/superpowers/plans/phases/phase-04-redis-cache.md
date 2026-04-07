# Phase 4: Redis 캐시 — "캐시가 왜 필요한지" 직접 체감

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans

**전제:** Phase 3 완료. 인덱스 + 커서 페이지네이션이 적용된 상태.

**학습 키워드**
`Cache-Aside` `Write-Through` `Write-Behind` `Cache Stampede` `Thundering Herd` `Distributed Lock` `TTL` `LRU vs LFU` `Cache Invalidation` `Serialization (JSON vs MessagePack)` `Redis Data Types` `Cache Key Design`

---

## 학습: 캐시란 무엇이고 왜 필요한가

### 캐시의 핵심 원리

DB 조회: 디스크 접근 + 쿼리 파싱 + 실행 = ~5-50ms
Redis 조회: 메모리 접근 = ~0.1ms

같은 게시글을 1000명이 읽으면?
- 캐시 없음: DB 쿼리 1000번 = 5000-50000ms의 DB 부하
- 캐시 있음: DB 쿼리 1번 + Redis 조회 999번 = ~100ms

숫자만 보면 단순해 보이지만 진짜 포인트는 **DB 커넥션 풀**임. RDS 같은 관리형 DB는 보통 커넥션을 수백 개로 제한함. 1M RPS에서 캐시 없으면 커넥션 풀이 먼저 터짐 — 쿼리가 느린 게 아니라 커넥션을 못 얻어서 타임아웃이 남. 캐시는 단순히 "빠르게" 하려는 게 아니라 DB 자체를 보호하는 방패임.

---

### 왜 Redis인가 — Memcached, 로컬 캐시와의 비교

> **핵심 질문:** "Redis 말고 다른 캐시 옵션도 있는데, 왜 Redis를 선택했나요?"

**로컬 인메모리 캐시 (e.g. Python dict, Guava Cache)** 는 왜 안 되냐면 — 서버가 여러 대면 캐시가 서버마다 따로 있음. 서버 A에서 업데이트해도 서버 B의 캐시는 모름. 1M RPS 규모면 당연히 수십~수백 대 서버를 씀. 로컬 캐시는 애초에 불가능한 선택지임.

**Memcached vs Redis 비교:**

| 항목 | Memcached | Redis |
|------|-----------|-------|
| 데이터 타입 | String만 | String, List, Set, ZSet, Hash 등 |
| 영속성 | 없음 (재시작하면 전부 날아감) | RDB / AOF 스냅샷 지원 |
| 클러스터링 | 클라이언트 사이드 샤딩만 | Redis Cluster 기본 내장 |
| Lua 스크립트 | 없음 | 있음 (원자적 복합 연산 가능) |
| 분산 락 | 직접 구현 어려움 | SET NX EX 로 간단히 구현 |
| 메모리 효율 | Redis보다 약간 효율적 | 조금 더 씀 |

Memcached가 더 빠른 경우도 있긴 함 (멀티스레드라서). 하지만 이 프로젝트에서 Redis를 쓰는 결정적 이유는 **Phase 10 (분산 락), Phase 5 (카운터), Phase 7 (랭킹)** 에서 Redis의 자료구조와 원자적 연산이 필수임. Memcached로는 구현 자체가 힘들거나 훨씬 복잡해짐.

**한 줄 정리:** Memcached는 단순 KV 캐시에서 약간 빠름. Redis는 범용 분산 데이터 구조 서버. 복잡한 시스템엔 Redis가 맞음.

---

### Cache-Aside 패턴 — 왜 이걸 선택했나

```
읽기:  캐시 확인 → 히트면 반환 / 미스면 DB 조회 → 캐시 저장 → 반환
쓰기:  DB 저장 → 캐시 무효화 (삭제)
```

> **핵심 질문:** "캐시 패턴에는 여러 가지가 있는데, 어떤 걸 선택했고 왜인가요?"

**다른 캐시 패턴과 비교:**

| 패턴 | 동작 | 장점 | 단점 |
|------|------|------|------|
| **Cache-Aside** ✅ | 앱이 캐시를 직접 관리 | 단순, 제어 가능 | 첫 요청은 느림 (cold start) |
| Write-Through | 쓰기 시 캐시도 동시 갱신 | 캐시 항상 최신 | 안 읽는 데이터도 캐시에 적재 |
| Write-Behind | 캐시에 먼저 쓰고 나중에 DB | 쓰기가 빠름 | 캐시 장애 시 데이터 유실 위험 |
| Read-Through | 캐시가 알아서 DB에서 가져옴 | 앱 코드 단순 | 캐시 설정이 복잡 |

Write-Through는 쓸 때마다 캐시도 갱신하니까 "항상 최신"처럼 보임. 근데 문제는 **쓰기가 많은 데이터**임. 게시판에서 조회수나 좋아요 수는 수초마다 바뀜. Write-Through로 그걸 매번 캐시에도 동기화하면 캐시의 이점이 사라짐. 또 아무도 안 읽는 게시글도 쓸 때마다 캐시에 올라감 — 메모리 낭비임.

Write-Behind는 캐시에 먼저 쓰고 나중에 DB에 반영함. 쓰기 속도는 빠르지만 캐시가 죽으면 그 사이 데이터가 다 날아감. 게시판에서 글이 사라지면 치명적임.

**Cache-Aside를 선택한 이유는 세 가지:**
1. 캐시 장애가 서비스 중단으로 이어지지 않음 — 미스 나면 그냥 DB로 감
2. 읽기 많고 쓰기 적은 게시판 특성에 정확히 맞음
3. 앱이 캐시를 직접 제어하니까 어떤 데이터를 얼마나 캐시할지 결정권이 있음

---

### Cache Stampede — 처리 안 하면 실제로 어떻게 되나

> **핵심 질문:** "Cache Stampede가 뭔지, 실제로 어떤 피해가 발생하는지 설명해보세요."

인기 게시글 캐시가 만료되는 순간:
```
요청 1: 캐시 미스 → DB 조회 시작
요청 2: 캐시 미스 → DB 조회 시작    ← 아직 요청 1이 안 끝남
요청 3: 캐시 미스 → DB 조회 시작
...
요청 1000: 캐시 미스 → DB 조회 시작  ← 1000개가 동시에 DB로!
```

**처리 안 하면 실제로 벌어지는 일:**

1. 인기 게시글 캐시 TTL이 만료되는 순간, 대기 중이던 수백 개 요청이 동시에 캐시 미스를 확인함
2. 전부 DB로 쿼리를 날림. DB 커넥션 풀이 순식간에 포화됨
3. 커넥션 못 얻은 요청들은 타임아웃으로 5xx 에러를 뱉음
4. 에러 모니터링 알람이 쏟아지고, 이미 DB CPU는 100%임
5. DB가 과부하로 슬로우 쿼리 → 락 경쟁 → 연쇄 타임아웃
6. 캐시가 다시 채워지기 전에 DB 자체가 다운될 수 있음

1M CCU 환경에서 TTL 만료 하나로 캐스케이딩 장애가 시작되는 시나리오임. 사소해 보이지만 실제 서비스에서 자주 발생하는 장애 패턴임.

**해결 방법들:**

| 방법 | 원리 | 적합한 상황 |
|------|------|------------|
| **분산 락** | 1명만 DB 조회, 나머지는 대기 | 강한 일관성이 필요할 때 |
| **Probabilistic Early Expiration** | 만료 전에 확률적으로 미리 갱신 | TTL이 예측 가능할 때 |
| **Background Refresh** | 별도 프로세스가 주기적으로 갱신 | 인기 데이터가 명확할 때 |

우리 구현에서는 **분산 락** 씀. `SET NX EX` 로 1명만 락을 잡아서 DB 조회, 나머지는 잠깐 대기 후 캐시에서 읽음. Thundering Herd 문제도 같은 개념임 — 이름만 다를 뿐 현상은 동일함.

---

### Cache Invalidation — CS에서 가장 어려운 문제

> **핵심 질문:** "캐시 무효화를 어떻게 했나요? 어떤 일관성 문제가 생길 수 있나요?"

컴퓨터 과학에서 유명한 말이 있음:

> "There are only two hard things in Computer Science: cache invalidation and naming things." — Phil Karlton

왜 어렵냐면 — **캐시와 DB가 동시에 일치하는 걸 보장하기가 원래 불가능**하기 때문임. 분산 시스템에서 두 저장소 간에 "정확히 같은 순간"은 존재하지 않음.

**우리가 쓰는 전략: Invalidate-on-Write (무효화 전략)**

```
글 수정 → DB 업데이트 → 캐시 삭제
다음 읽기 → 캐시 미스 → DB에서 최신 데이터 → 캐시 재적재
```

Update 대신 Delete를 쓰는 이유가 있음. DB 업데이트 직후 캐시도 업데이트하면 Race Condition이 생길 수 있음:

```
Thread A: DB 업데이트 (title = "New") → 캐시 업데이트 시작
Thread B: DB 업데이트 (title = "Newer") → 캐시 업데이트 완료 (Newer)
Thread A: 캐시 업데이트 완료 (New)  ← 구버전이 덮어씀!
결과: DB는 "Newer", 캐시는 "New" → 데이터 불일치
```

캐시를 업데이트하는 대신 그냥 삭제하면 이 문제가 없음. 다음 읽기 때 DB에서 정확한 최신 데이터를 가져옴.

**불가피한 일관성 창 (Consistency Window):** DB 업데이트와 캐시 삭제 사이에 짧은 시간 동안 구버전 데이터가 서빙될 수 있음. TTL이 5분이면 최대 5분간 구버전 노출 가능. 이건 "Eventually Consistent" 설계를 의식적으로 선택한 것임 — 게시판에서 5분 오래된 글은 괜찮지만 5분 다운은 안 됨. 가용성 vs 일관성 트레이드오프임.

---

### DB 내부 캐시와 Redis의 차이

**DB별 내부 캐시:**
- **PostgreSQL:** shared_buffers (기본 128MB) — 자주 접근하는 페이지를 메모리에 캐시. Clock-sweep 알고리즘으로 교체
- **MySQL InnoDB:** Buffer Pool (기본 128MB) — LRU 변형. young/old 리스트로 풀스캔이 캐시를 오염시키는 걸 방지
- **MongoDB:** WiredTiger Cache (기본 RAM의 50%) — 내부 캐시가 커서 외부 캐시 없이도 어느 정도 버팀

하지만 이건 "DB 서버 내부" 캐시. 핵심 한계가 있음:
- 앱 서버와 DB 서버 간 **네트워크 레이턴시 (1-5ms)** 는 DB 캐시로 줄일 수 없음
- DB 커넥션 획득 오버헤드도 여전히 있음
- 여러 앱 서버가 공유하는 Redis와 달리, DB 내부 캐시는 해당 DB 인스턴스에만 적용됨

→ Redis(앱 레벨 캐시)가 필요한 이유가 바로 이거임. DB가 아무리 내부적으로 캐시를 잘 해도, 앱-DB 간 왕복을 없애지 않으면 한계가 있음.

---

### TTL과 Eviction 정책

- **TTL (Time To Live):** 캐시 만료 시간. 5분 = 최대 5분간 구버전 데이터 노출 가능
- **Eviction:** 메모리 가득 차면 뭘 지울지
  - **LRU (Least Recently Used):** 가장 오래 안 쓴 것 제거. 범용적
  - **LFU (Least Frequently Used):** 가장 적게 쓴 것 제거. 인기 콘텐츠에 유리
  - **Random:** 무작위. 단순하지만 비효율적

게시판 같은 인기 콘텐츠 편중 서비스에서는 LFU가 이론적으론 좋음. 상위 10% 게시글이 트래픽의 90%를 차지하는 구조라면 자주 쓰는 걸 캐시에 남기는 LFU가 히트율이 높음. 다만 Redis 기본값은 LRU(근사)이고, LFU는 Redis 4.0부터 지원함. 실제 튜닝은 캐시 히트율 모니터링 후 결정하는 거임.

---

### 심화 학습 — 더 깊이 파볼 키워드

| 키워드 | 왜 알아야 하는지 |
|--------|----------------|
| **Thundering Herd** | Cache Stampede의 또 다른 이름. 캐시 만료 순간 대량 요청이 DB로 몰리는 현상. 둘 다 같은 현상을 가리키는 용어라는 걸 알아두면 좋음 |
| **Cache Key Design** | `post:{id}:v{version}` 같은 키 설계. 키 충돌, 네임스페이스 분리, 버전 관리 전략. 키 설계 실수가 운영에서 캐시 오염으로 이어짐 |
| **Serialization (JSON vs MessagePack vs Protobuf)** | 캐시 직렬화 포맷. JSON은 읽기 쉽지만 느림, MessagePack은 빠르고 작음. 고트래픽에서 직렬화 비용이 유의미하게 측정됨 |
| **Redis Cluster vs Sentinel** | 고가용성 전략. Sentinel = 장애 감지 + 자동 페일오버(단일 마스터), Cluster = 데이터 샤딩(다중 마스터). 1M RPS면 Cluster 고려해야 함 |
| **Cache Warming** | 서비스 시작/재배포 시 주요 데이터를 미리 캐시에 로드. Cold start 방치하면 재시작 직후 DB가 폭발함 |
| **Negative Caching** | 존재하지 않는 데이터도 캐싱. 없는 post_id로 반복 요청이 들어오면 매번 DB 조회하게 됨 — "없음"도 TTL 짧게 캐시하면 DB 보호 가능 |

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
