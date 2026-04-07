# Phase 10: 부하 테스트 — k6로 한계점 찾기

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans

**전제:** Phase 9 완료. 모니터링 스택이 동작하는 상태.

**학습 키워드**
`Smoke/Load/Stress/Spike/Soak Test` `k6 (Go-based)` `Virtual Users (VU)` `RPS vs Latency` `Little's Law` `Coordinated Omission` `Amdahl's Law` `Think Time` `Ramp-up/Ramp-down` `Threshold` `Saturation Point`

---

## 학습: 부하 테스트의 종류와 목적

### 테스트 유형별 비교

| 유형 | 목적 | VU 패턴 | 기간 |
|------|------|---------|------|
| Smoke | 기능 정상 확인 | 1-5명 | 1분 |
| Load | 일반 트래픽 처리 확인 | 예상 트래픽 | 10-30분 |
| Stress | 한계점 찾기 | 점진적 증가 | 10-20분 |
| Spike | 급격한 트래픽 대응 | 갑자기 폭증 | 5-10분 |
| Soak | 장시간 안정성 확인 | 일정 수준 유지 | 1-4시간 |
| Breakpoint | 시스템 붕괴 지점 찾기 | 끝없이 증가 | 붕괴 시까지 |

### k6 — 왜 k6인가

| | k6 | JMeter | Locust | Artillery |
|---|---|---|---|---|
| 언어 | Go (바이너리) | Java | Python | Node.js |
| 스크립트 | JavaScript | XML/GUI | Python | YAML/JS |
| 리소스 사용 | 매우 낮음 | 높음 (JVM) | 보통 | 보통 |
| 최대 RPS (단일 머신) | ~30,000 | ~5,000 | ~5,000 | ~10,000 |
| 설치 | `brew install k6` | JRE + 다운로드 | pip install | npm install |

k6가 Go로 빌드되어 있어서 리소스 대비 성능이 압도적. 로컬에서 테스트할 때 이게 중요함. JMeter는 JVM 오버헤드가 큼.

### 핵심 메트릭 읽는 법

```
http_req_duration.............: avg=12ms  min=1ms  med=8ms  max=2.1s  p(90)=25ms  p(95)=45ms  p(99)=180ms
http_req_failed...............: 2.3%
http_reqs.....................: 15000  750/s
```

- **p95 vs p99:** p95는 "대부분의 유저 경험", p99는 "최악의 1% 경험". p95가 좋아도 p99가 나쁘면 문제 있음
- **http_req_failed:** 5% 이상이면 시스템이 한계에 도달한 것
- **http_reqs (RPS):** 초당 처리량. VU를 늘렸는데 RPS가 안 올라가면 병목

### 부하 테스트 시 흔한 실수

1. **워밍업 없이 바로 풀 트래픽:** 커넥션 풀, JIT, 캐시가 안 채워진 상태에서 테스트하면 결과가 왜곡됨
2. **테스트 데이터 부족:** 게시글 10개로 테스트하면 DB 캐시에 다 올라가서 실제와 다름
3. **단일 엔드포인트만 테스트:** 실제로는 읽기 99% + 쓰기 1% 혼합 트래픽

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

## Phase 10 완료 체크리스트

- [ ] Mixed Load 테스트 실행 + 결과 기록
- [ ] Spike 테스트 실행 + 복구 시간 확인
- [ ] Stress 테스트 실행 + 한계점(breakpoint) 확인
- [ ] Grafana에서 부하 중 메트릭 관찰
- [ ] 병목 지점 식별 (DB? Redis? App? Network?)

**핵심 체감:**
- Mixed Load에서 p99가 급격히 올라가는 VU 수 = 현재 아키텍처의 실질적 한계
- Spike 후 복구 시간 = 시스템 회복력 (resilience)
- Stress에서 에러율 50% 넘는 지점 = 절대 한계

**다음:** [Phase 11 — 장애 시뮬레이션](phase-11-chaos.md)
