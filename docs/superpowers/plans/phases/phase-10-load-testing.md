# Phase 10: 부하 테스트 — k6로 한계점 찾기

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans

**전제:** Phase 9 완료. 모니터링 스택이 동작하는 상태.

**학습 키워드**
`Smoke/Load/Stress/Spike/Soak Test` `k6 (Go-based)` `Virtual Users (VU)` `RPS vs Latency` `Little's Law` `Coordinated Omission` `Amdahl's Law` `Think Time` `Ramp-up/Ramp-down` `Threshold` `Saturation Point`

---

## 학습: 부하 테스트의 종류와 목적

### 핵심 질문 — "부하 테스트를 어떻게 했나요?"

> "k6로 네 가지 시나리오를 돌렸음. Smoke로 기능 정상 확인 → Load로 예상 트래픽 처리 검증 → Stress로 한계점 찾기 → Spike로 순간 폭증 대응 확인. 단순히 VU 숫자 올리는 게 아니라 각 테스트가 다른 질문에 답하는 거임."

> **"어떤 지표를 봤나요?"**

> "p95/p99 응답시간이랑 에러율 중심으로 봤음. 평균(avg)은 outlier 때문에 속는 경우가 많아서 신뢰 안 함. p99가 급등하는 VU 수가 실질적인 한계점이고, 거기서 병목이 DB인지 Redis인지 Grafana로 확인했음."

---

### 테스트 유형별 비교 — 각각이 다른 질문에 답함

| 유형 | 핵심 질문 | VU 패턴 | 기간 | 실패 기준 |
|------|----------|---------|------|----------|
| Smoke | "배포 직후 뭔가 부러졌나?" | 1-5명 | 1분 | 에러 하나라도 있으면 실패 |
| Load | "예상 트래픽을 처리할 수 있나?" | 예상 트래픽 | 10-30분 | p95 > 500ms |
| Stress | "어디서 무너지나?" | 점진적 증가 | 10-20분 | 에러율 50% 초과 지점 관찰 |
| Spike | "갑자기 20배 터지면?" | 갑자기 폭증 | 5-10분 | 복구 시간 > 2분 |
| Soak | "메모리 누수 없나?" | 일정 수준 유지 | 1-4시간 | 시간 지날수록 응답 느려짐 |
| Breakpoint | "진짜 한계가 어딘가?" | 끝없이 증가 | 붕괴 시까지 | 붕괴 직전 VU 수가 답 |

**왜 이게 중요하냐면**: Smoke 없이 배포하면 "분명히 됐는데 왜 안 되지?" 상황이 발생함. Load 없이 론칭하면 예상 트래픽에서 터짐. Stress 없으면 한계가 어딘지 몰라서 스케일링 시점을 모름. Spike 없으면 인기글 하나 터졌을 때 전체 서비스가 날아감.

---

### k6 — 왜 k6인가

| | k6 | JMeter | Locust | Artillery |
|---|---|---|---|---|
| 언어 | Go (바이너리) | Java | Python | Node.js |
| 스크립트 | JavaScript | XML/GUI | Python | YAML/JS |
| 리소스 사용 | 매우 낮음 | 높음 (JVM) | 보통 | 보통 |
| 최대 RPS (단일 머신) | ~30,000 | ~5,000 | ~5,000 | ~10,000 |
| 설치 | `brew install k6` | JRE + 다운로드 | pip install | npm install |

k6가 Go로 빌드되어 있어서 리소스 대비 성능이 압도적. 로컬에서 테스트할 때 이게 중요함. JMeter는 JVM 오버헤드가 큼. 내 맥북에서 30,000 RPS 보내는 동안 k6 자체는 CPU 5% 미만 — 테스트 도구가 테스트 결과를 오염시키지 않음.

---

### k6 결과 읽는 법 — 각 숫자가 무엇을 뜻하는지

```
http_req_duration.............: avg=12ms  min=1ms  med=8ms  max=2.1s  p(90)=25ms  p(95)=45ms  p(99)=180ms
http_req_failed...............: 2.3%
http_reqs.....................: 15000  750/s
vus...........................: 200
```

| 지표 | 의미 | "나쁜" 기준 | 왜 중요한가 |
|------|------|-----------|-----------|
| `avg` | 전체 평균 응답시간 | 단독으로 보면 의미 없음 | outlier 하나에 왜곡됨. 참고만 함 |
| `med` (p50) | 절반의 사람이 경험하는 응답시간 | > 200ms | 일반 사용자 경험 대표값 |
| `p(95)` | 상위 5%가 경험하는 최악 응답시간 | > 500ms | SLO 기준으로 많이 씀 |
| `p(99)` | 상위 1%가 경험하는 최악 응답시간 | > 2000ms | 이게 나쁘면 "느리다"는 민원이 옴 |
| `max` | 가장 느린 응답 하나 | 참고만 함 | 이상치가 섞여 있어서 무시하는 경우도 많음 |
| `http_req_failed` | 실패율 | > 5% | 5% 넘으면 시스템이 한계에 달한 것 |
| `http_reqs` (RPS) | 초당 처리 요청 수 | VU 늘려도 RPS 안 올라가면 병목 | 수평 확장 효과 확인 |

**핵심 패턴 — 이걸 보면 어디가 문제인지 알 수 있음:**
- VU 올렸는데 RPS 그대로 → 앱 자체가 CPU 병목
- RPS 올랐는데 p99만 급등 → DB 커넥션 풀 고갈
- 에러율 갑자기 증가 → Redis/DB 한계 도달
- p95는 괜찮은데 p99가 10x → 가끔 GC나 네트워크 패킷 드롭

---

### Little's Law — VU, RPS, Latency의 수학적 관계

```
L = λ × W

L = 동시 사용자 수 (VU)
λ = 도착률 (RPS, 초당 요청)
W = 평균 체류시간 (응답시간 + think time, 초 단위)
```

**실제로 어떻게 쓰는가:**

"평균 응답시간 50ms, think time 100ms인 시스템에서 1000 RPS를 내려면 VU가 몇 명 필요한가?"
```
W = 0.05 + 0.1 = 0.15초
L = 1000 × 0.15 = 150 VU
```

즉 k6에서 VU를 150으로 설정하면 이론상 1000 RPS가 나와야 함. 실제로 이보다 낮으면 그게 병목임.

**역으로 활용:** k6에서 200 VU로 돌렸더니 RPS가 800밖에 안 나온다. 이론값은 1333 RPS인데. 그러면 어딘가 대기 시간이 생기고 있다는 뜻 — 커넥션 풀이나 DB 락을 의심하면 됨.

---

### 부하 테스트 시 흔한 실수 — 결과를 무효로 만드는 것들

**1. 워밍업 없이 바로 풀 트래픽**

커넥션 풀이 아직 안 채워진 상태, JIT 컴파일 전, Redis/DB 캐시 콜드 상태에서 테스트하면 실제보다 3-5배 느리게 나옴. 그래서 항상 ramp-up 구간을 둠. 이 프로젝트 시나리오도 1분 워밍업부터 시작하는 이유가 이거임.

**2. 테스트 데이터 부족**

게시글 10개로 테스트 → DB 버퍼 캐시에 다 올라감 → 캐시 히트율 100% → 실제 환경과 전혀 다른 결과. 실제 DB에는 수백만 건이 있고 캐시 미스가 발생함. 테스트 데이터는 최소 10,000건 이상이어야 의미 있는 결과가 나옴.

**3. 단일 엔드포인트만 테스트**

`/api/posts/:id` 하나만 두드리면 이 엔드포인트는 Redis에 캐시되어 있어서 엄청 빠르게 나옴. 실제는 목록 조회 70% + 상세 조회 25% + 쓰기 5% 혼합 트래픽. mixed_load.js가 이걸 시뮬레이션하는 이유임.

**4. 테스트 도구가 테스트 결과를 오염**

JMeter를 테스트 대상 서버와 같은 머신에서 돌리면 JVM 힙이 앱 메모리를 잡아먹음. k6는 이 문제가 훨씬 적지만, 그래도 별도 머신이나 Docker 컨테이너에서 돌리는 게 이상적.

---

### 심화 학습 — 더 깊이 파볼 키워드

| 키워드 | 왜 알아야 하는지 |
|--------|----------------|
| **Little's Law** | L = λW (동시 사용자 = 도착률 × 체류시간). VU와 RPS 관계를 수학적으로 이해 |
| **Coordinated Omission** | 부하 도구가 느린 응답을 기다리면서 실제보다 좋은 결과를 보여주는 현상. k6는 이 문제가 적음 |
| **Amdahl's Law** | 병렬화 한계. 10%가 직렬이면 아무리 스케일아웃해도 10배가 최대 |
| **Throughput vs Latency** | RPS를 높이면 latency도 올라감. 둘의 트레이드오프를 이해해야 SLO 설정 가능 |
| **Connection Pool Saturation** | DB/Redis 커넥션 풀이 고갈되면 대기 큐가 쌓이면서 latency가 급증하는 현상 |
| **Tail Latency Amplification** | 마이크로서비스에서 fan-out 요청 시 하나라도 느리면 전체가 느려지는 현상 |

---

## 구현

### Task 18: 6단계 부하 테스트

**Files:**
- Create: `loadtest/scenarios/mixed_load.js`
- Create: `loadtest/scenarios/spike.js`
- Create: `loadtest/scenarios/stress.js`
- Modify: `loadtest/smoke.js`

- [ ] **Step 1: Mixed Load 테스트 (읽기 99% + 쓰기 1%)**

```javascript
// loadtest/scenarios/mixed_load.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8000';

export const options = {
    stages: [
        { duration: '1m', target: 50 },   // 워밍업
        { duration: '3m', target: 200 },   // 일반 트래픽
        { duration: '2m', target: 500 },   // 피크
        { duration: '2m', target: 200 },   // 피크 후 안정화
        { duration: '1m', target: 50 },    // 쿨다운
        { duration: '1m', target: 0 },     // 종료
    ],
    thresholds: {
        http_req_duration: ['p(95)<500', 'p(99)<2000'],
        http_req_failed: ['rate<0.05'],
    },
};

export function setup() {
    // 테스트용 게시글 10개 생성
    const posts = [];
    for (let i = 0; i < 10; i++) {
        const res = http.post(`${BASE_URL}/api/posts`, JSON.stringify({
            title: `Load Test Post ${i}`,
            content: `Content for load testing ${i}`,
            author: `loadtest-${i}`,
        }), { headers: { 'Content-Type': 'application/json' } });
        if (res.status === 201) {
            posts.push(JSON.parse(res.body).id);
        }
    }
    return { postIds: posts };
}

export default function (data) {
    const rand = Math.random();

    if (rand < 0.70) {
        // 70%: 게시글 목록 조회
        const res = http.get(`${BASE_URL}/api/posts?limit=20`);
        check(res, { 'list 200': (r) => r.status === 200 });
    } else if (rand < 0.95) {
        // 25%: 게시글 상세 조회
        const postId = data.postIds[randomIntBetween(0, data.postIds.length - 1)];
        const res = http.get(`${BASE_URL}/api/posts/${postId}`);
        check(res, { 'detail 200': (r) => r.status === 200 });
    } else if (rand < 0.98) {
        // 3%: 좋아요
        const postId = data.postIds[randomIntBetween(0, data.postIds.length - 1)];
        const res = http.post(
            `${BASE_URL}/api/posts/${postId}/likes`,
            JSON.stringify({ user_id: `user_${__VU}_${__ITER}` }),
            { headers: { 'Content-Type': 'application/json' } }
        );
        check(res, { 'like 2xx': (r) => r.status >= 200 && r.status < 300 });
    } else {
        // 2%: 게시글 작성
        const res = http.post(`${BASE_URL}/api/posts`, JSON.stringify({
            title: `New Post ${__VU}-${__ITER}`,
            content: 'Load test content',
            author: `user_${__VU}`,
        }), {
            headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': `load-${__VU}-${__ITER}`,
            },
        });
        check(res, { 'create 201': (r) => r.status === 201 });
    }

    sleep(randomIntBetween(1, 3) / 10);  // 0.1~0.3초 think time
}
```

- [ ] **Step 2: Spike 테스트 (갑작스러운 트래픽 폭증)**

```javascript
// loadtest/scenarios/spike.js
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8000';

export const options = {
    stages: [
        { duration: '30s', target: 50 },    // 평상시
        { duration: '10s', target: 1000 },   // 갑자기 20배 폭증 (실시간 검색어 1위 시나리오)
        { duration: '1m', target: 1000 },    // 폭증 유지
        { duration: '10s', target: 50 },     // 정상 복귀
        { duration: '1m', target: 50 },      // 복귀 후 안정화 확인
    ],
    thresholds: {
        http_req_duration: ['p(95)<3000'],   // spike 시 3초까지 허용
        http_req_failed: ['rate<0.10'],      // spike 시 10% 에러까지 허용
    },
};

export function setup() {
    const res = http.post(`${BASE_URL}/api/posts`, JSON.stringify({
        title: 'Spike Test Post',
        content: 'For spike testing',
        author: 'spike-test',
    }), { headers: { 'Content-Type': 'application/json' } });
    return { postId: JSON.parse(res.body).id };
}

export default function (data) {
    const res = http.get(`${BASE_URL}/api/posts/${data.postId}`);
    check(res, {
        'status 200': (r) => r.status === 200,
        'duration < 5s': (r) => r.timings.duration < 5000,
    });
    sleep(0.1);
}
```

- [ ] **Step 3: Stress 테스트 (한계점 찾기)**

```javascript
// loadtest/scenarios/stress.js
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8000';

export const options = {
    stages: [
        { duration: '1m', target: 100 },
        { duration: '1m', target: 300 },
        { duration: '1m', target: 500 },
        { duration: '1m', target: 800 },
        { duration: '1m', target: 1000 },
        { duration: '1m', target: 1500 },   // 여기서 터지면 한계점
        { duration: '1m', target: 2000 },
        { duration: '2m', target: 0 },       // 복구 확인
    ],
    thresholds: {
        http_req_failed: ['rate<0.50'],  // 언제 50% 넘는지 관찰
    },
};

export function setup() {
    const res = http.post(`${BASE_URL}/api/posts`, JSON.stringify({
        title: 'Stress Test Post',
        content: 'For stress testing',
        author: 'stress-test',
    }), { headers: { 'Content-Type': 'application/json' } });
    return { postId: JSON.parse(res.body).id };
}

export default function (data) {
    const res = http.get(`${BASE_URL}/api/posts/${data.postId}`);
    check(res, { 'status 200': (r) => r.status === 200 });
    sleep(0.05);
}
```

- [ ] **Step 4: 각 테스트 실행 + 결과 기록**

```bash
# 1. Mixed Load (가장 현실적인 시나리오)
k6 run loadtest/scenarios/mixed_load.js

# 2. Spike (인기글 시나리오)
k6 run loadtest/scenarios/spike.js

# 3. Stress (한계점 찾기)
k6 run loadtest/scenarios/stress.js
```

각 테스트 후 기록할 것:
- p50, p95, p99 응답시간
- 최대 RPS
- 에러율
- Grafana에서 리소스 사용량 (CPU, 메모리, DB 커넥션)

- [ ] **Step 5: Grafana에서 부하 테스트 중 메트릭 관찰**

부하 테스트 중 Grafana (http://localhost:3000)에서 확인:
- RPS 추이 (Prometheus: `rate(http_requests_total[1m])`)
- 응답시간 p95/p99 (`histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[1m]))`)
- DB 커넥션 수
- Redis 메모리 사용량

스크린샷 저장 권장. Before/After 비교 자료로 활용.

- [ ] **Step 6: Commit**

```bash
git add loadtest/scenarios/
git commit -m "feat: k6 load test scenarios — mixed, spike, stress"
```

---

### Task 18A: 부하 중 분산 정합성 검증

> **전제:** Task 18 완료 + Phase 4.5 분산 환경 + Phase 7의 PG Replica + Read-Your-Write 동작 상태.

**학습 키워드 추가**
`Consistency Audit` `Data Reconciliation` `pg_wal_lsn_diff` `Redis-DB Drift`

**Files:**
- Create: `scripts/consistency_audit.py`
- Create: `loadtest/scenarios/mixed_load_distributed.js`
- Create: `tests/test_load_consistency.py`

Phase 5~7에서 만든 기능들을 **부하 아래에서** 검증함. 정상 상태에서 동작하는 코드가 부하에서도 동작하는지가 핵심.

#### 학습: 왜 부하 중 정합성 검증이 필요한가

단일 테스트에서 정합성이 맞아도, 부하 중에는 깨질 수 있음:
- Redis INCR은 원자적 → 하지만 Redis→DB 동기화 워커가 밀려서 DB 값이 실제보다 적을 수 있음
- 멱등성 키 체크가 정상 → 하지만 Redis 응답이 느려지면 락 획득 전 타임아웃 → 같은 키로 두 건 생성
- Read-Your-Write 라우팅이 정상 → 하지만 부하 중 primary DB가 느려지면 쿠키 TTL 내 응답 못 줌

이런 건 부하 테스트 + 정합성 감사를 함께 돌려야만 발견됨.

---

- [ ] **Step 1: 분산 환경용 Mixed Load (Nginx 경유)**

```javascript
// loadtest/scenarios/mixed_load_distributed.js
// Phase 10의 mixed_load.js와 동일하되, Nginx LB(port 80) 경유
import http from 'k6/http';
import { check, sleep } from 'k6';
import { randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js';

const BASE_URL = __ENV.BASE_URL || 'http://localhost';  // Nginx

export const options = {
    stages: [
        { duration: '1m', target: 50 },
        { duration: '3m', target: 200 },
        { duration: '2m', target: 500 },
        { duration: '2m', target: 200 },
        { duration: '1m', target: 0 },
    ],
    thresholds: {
        http_req_duration: ['p(95)<500', 'p(99)<2000'],
        http_req_failed: ['rate<0.05'],
    },
};

export function setup() {
    const posts = [];
    for (let i = 0; i < 10; i++) {
        const res = http.post(`${BASE_URL}/api/posts`, JSON.stringify({
            title: `Distributed Load Test ${i}`,
            content: `Content ${i}`,
            author: `loadtest-${i}`,
        }), {
            headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': `setup-${i}-${Date.now()}`,
            },
        });
        if (res.status === 201) posts.push(JSON.parse(res.body).id);
    }
    return { postIds: posts };
}

export default function (data) {
    const rand = Math.random();
    if (rand < 0.70) {
        const res = http.get(`${BASE_URL}/api/posts?limit=20`);
        check(res, { 'list 200': (r) => r.status === 200 });
    } else if (rand < 0.95) {
        const postId = data.postIds[randomIntBetween(0, data.postIds.length - 1)];
        http.get(`${BASE_URL}/api/posts/${postId}`);
    } else if (rand < 0.98) {
        const postId = data.postIds[randomIntBetween(0, data.postIds.length - 1)];
        http.post(`${BASE_URL}/api/posts/${postId}/likes`,
            JSON.stringify({ user_id: `user_${__VU}_${__ITER}` }),
            { headers: { 'Content-Type': 'application/json' } }
        );
    } else {
        http.post(`${BASE_URL}/api/posts`, JSON.stringify({
            title: `New ${__VU}-${__ITER}`,
            content: 'Load content',
            author: `user_${__VU}`,
        }), {
            headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': `load-${__VU}-${__ITER}-${Date.now()}`,
            },
        });
    }
    sleep(randomIntBetween(1, 3) / 10);
}
```

Run:
```bash
docker compose -f docker-compose.distributed.yml --profile core --profile replica up -d
k6 run loadtest/scenarios/mixed_load_distributed.js
```

- [ ] **Step 2: 정합성 감사 스크립트**

```python
# scripts/consistency_audit.py
"""부하 테스트 후 데이터 정합성 감사.

Redis 카운터 ↔ DB 카운터, 멱등성 키 중복, 이벤트 미처리 건 확인.
"""
import asyncio
import json

import asyncpg
from redis.asyncio.sentinel import Sentinel


async def audit():
    # 연결
    sentinel = Sentinel([("localhost", 26379)], socket_timeout=3)
    redis = sentinel.master_for("mymaster", decode_responses=True)
    db = await asyncpg.connect("postgresql://postgres:postgres@localhost:5432/extreme_board")

    print("=== Consistency Audit ===\n")

    # 1. Redis 카운터 vs DB 카운터
    print("[1] Redis ↔ DB 카운터 비교")
    posts = await db.fetch("SELECT id, like_count, view_count FROM posts LIMIT 50")
    drift_count = 0
    for post in posts:
        pid = str(post["id"])
        redis_likes = int(await redis.get(f"post:{pid}:likes") or 0)
        redis_views = int(await redis.get(f"post:{pid}:views") or 0)
        db_likes = post["like_count"]
        db_views = post["view_count"]

        # Redis 값은 동기화 전이라 DB보다 클 수 있음 (정상)
        # DB 값이 Redis보다 크면 비정상 (동기화 중 유실)
        if db_likes > redis_likes + 10 or db_views > redis_views + 10:
            print(f"  ⚠ Post {pid}: DB likes={db_likes} > Redis={redis_likes}")
            drift_count += 1

    total = len(posts)
    print(f"  검사: {total}건, 비정상 drift: {drift_count}건\n")

    # 2. 멱등성 키 중복 확인
    print("[2] 멱등성 키 중복 확인")
    dup = await db.fetchval("""
        SELECT COUNT(*) FROM (
            SELECT key, COUNT(*) as cnt FROM idempotency_keys
            GROUP BY key HAVING COUNT(*) > 1
        ) dupes
    """)
    print(f"  중복 멱등성 키: {dup}건 (0이어야 정상)\n")

    # 3. 이벤트 미처리 건 (Pending)
    print("[3] Redis Streams 미처리 이벤트")
    try:
        pending = await redis.xpending("events", "board-consumers")
        print(f"  Pending 메시지: {pending.get('pending', 0) if isinstance(pending, dict) else pending[0]}건")
    except Exception as e:
        print(f"  (Consumer Group 없음 or 에러: {e})")

    # 4. Replication Lag
    print("\n[4] PG Replication Lag")
    try:
        replica = await asyncpg.connect(
            "postgresql://postgres:postgres@localhost:5433/extreme_board"
        )
        primary_lsn = await db.fetchval("SELECT pg_current_wal_lsn()")
        replica_lsn = await replica.fetchval("SELECT pg_last_wal_receive_lsn()")
        if primary_lsn and replica_lsn:
            lag = await db.fetchval(
                "SELECT pg_wal_lsn_diff($1, $2)", primary_lsn, replica_lsn
            )
            print(f"  Primary LSN: {primary_lsn}")
            print(f"  Replica LSN: {replica_lsn}")
            print(f"  Lag: {lag} bytes")
        await replica.close()
    except Exception as e:
        print(f"  (Replica 미실행 or 에러: {e})")

    print("\n=== Audit Complete ===")
    await db.close()
    await redis.aclose()


if __name__ == "__main__":
    asyncio.run(audit())
```

Run: `python scripts/consistency_audit.py`

- [ ] **Step 3: 부하 중 Replication Lag 추이 측정**

```python
# tests/test_load_consistency.py
"""부하 중 Replication Lag + Read-Your-Write 검증.

k6를 백그라운드로 실행하면서 이 테스트를 돌리면 부하 중 동작 확인.
"""
import asyncio
import time
import httpx
import pytest

NGINX_URL = "http://localhost"


@pytest.mark.asyncio
async def test_read_your_write_under_load():
    """부하 중 Read-Your-Write가 동작하는지 — 100회 반복."""
    failures = 0
    total = 100

    async with httpx.AsyncClient(base_url=NGINX_URL) as client:
        for i in range(total):
            # write
            r = await client.post(
                "/api/posts",
                json={"title": f"RYW Load {i}", "content": "test", "author": "ryw"},
                headers={"Idempotency-Key": f"ryw-load-{i}-{time.time()}"},
            )
            if r.status_code != 201:
                continue
            post_id = r.json()["id"]

            # 즉시 read (같은 클라이언트 → 쿠키 포함 → primary 라우팅)
            r_read = await client.get(f"/api/posts/{post_id}")
            if r_read.status_code != 200 or r_read.json()["title"] != f"RYW Load {i}":
                failures += 1

    failure_rate = failures / total * 100
    print(f"Read-Your-Write under load: {failures}/{total} failures ({failure_rate:.1f}%)")
    assert failure_rate < 5, f"Read-Your-Write failure rate too high: {failure_rate}%"
```

Run: `pytest tests/test_load_consistency.py -v -s`

- [ ] **Step 4: Commit**

```bash
git add scripts/consistency_audit.py loadtest/scenarios/mixed_load_distributed.js \
  tests/test_load_consistency.py
git commit -m "test: distributed consistency audit — Redis/DB drift, replication lag, RYW under load"
```

---

## Phase 10 완료 체크리스트

- [ ] Mixed Load 테스트 실행 + 결과 기록
- [ ] Spike 테스트 실행 + 복구 시간 확인
- [ ] Stress 테스트 실행 + 한계점(breakpoint) 확인
- [ ] Grafana에서 부하 중 메트릭 관찰
- [ ] 병목 지점 식별 (DB? Redis? App? Network?)
- [ ] 분산 환경(Nginx LB)에서 Mixed Load 실행
- [ ] 정합성 감사 스크립트 실행 — Redis↔DB drift, 멱등성 중복, Pending 이벤트
- [ ] 부하 중 Read-Your-Write 동작 검증 (100회 반복)
- [ ] Replication Lag 부하 중 추이 관찰

**핵심 체감:**
- Mixed Load에서 p99가 급격히 올라가는 VU 수 = 현재 아키텍처의 실질적 한계
- Spike 후 복구 시간 = 시스템 회복력 (resilience)
- Stress에서 에러율 50% 넘는 지점 = 절대 한계
- 부하 중 Redis↔DB drift = 동기화 워커의 한계 (30초 주기보다 빠르면 밀림)
- 부하 중 Read-Your-Write 실패율 < 5% = 미들웨어가 부하에서도 동작함

**다음:** [Phase 11 — 장애 시뮬레이션](phase-11-chaos.md)
