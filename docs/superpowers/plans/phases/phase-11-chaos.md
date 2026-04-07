# Phase 11: 장애 시뮬레이션 — Docker로 카오스 엔지니어링

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans

**전제:** Phase 10 완료. 부하 테스트 결과가 있는 상태.

**학습 키워드**
`Chaos Engineering` `Chaos Monkey (Netflix)` `Circuit Breaker` `Retry with Backoff` `Bulkhead Pattern` `Graceful Degradation` `Fallback` `SIGSTOP vs SIGTERM` `tc (traffic control)` `Mean Time To Recovery (MTTR)` `Blast Radius`

---

## 학습: 카오스 엔지니어링이란

### "장애는 반드시 발생함. 대비했느냐가 차이"

Netflix가 2011년 만든 Chaos Monkey — 프로덕션 서버를 랜덤으로 종료. 이걸 통해 발견한 것: "우리 시스템은 우리가 생각한 것보다 훨씬 취약함."

### 카오스 엔지니어링 도구 비교

| 도구 | 대상 | 복잡도 | 비용 |
|------|------|--------|------|
| Docker stop/pause | 컨테이너 | 매우 낮음 | $0 |
| Chaos Monkey | EC2 인스턴스 | 중간 | $0 |
| Gremlin | 모든 인프라 | 높음 | 유료 |
| LitmusChaos | Kubernetes | 높음 | $0 |
| tc (traffic control) | 네트워크 | 낮음 | $0 |

우리는 Docker Compose 환경이니까 `docker stop/pause`로 충분. 실제 프로덕션에서는 Gremlin이나 LitmusChaos 사용.

### Docker stop vs pause

| | docker stop | docker pause |
|---|---|---|
| 효과 | 프로세스 완전 종료 | 프로세스 일시정지 (SIGSTOP) |
| 시뮬레이션 | 서버 다운 | 네트워크 행 (응답 없음) |
| 차이 | 커넥션이 즉시 끊김 | 커넥션이 열려있는데 응답 안 옴 |
| 실제 상황 | EC2 인스턴스 종료 | 디스크 I/O 포화, GC 폭발 |

`pause`가 더 위험한 장애. `stop`은 즉시 감지 가능하지만, `pause`는 타임아웃까지 기다려야 함.

### 장애 시나리오별 예상 동작

| 장애 | 영향 | 기대 동작 |
|------|------|----------|
| Redis 다운 | 캐시 미스, 카운터 불가 | DB 직접 조회로 폴백. 느리지만 동작 |
| DB 다운 | 모든 쓰기 불가 | 읽기는 캐시에서 가능. 쓰기는 에러 반환 |
| App 1대 다운 | 트래픽 분산 불가 | 다른 인스턴스로 라우팅 (LB 있을 때) |
| MinIO 다운 | 이미지 업로드 불가 | Presigned URL 발급 실패. 게시글은 이미지 없이 작성 가능 |

### 심화 학습 — 더 깊이 파볼 키워드

| 키워드 | 왜 알아야 하는지 |
|--------|----------------|
| **Circuit Breaker Pattern** | 장애 서비스 호출을 차단. Open → Half-Open → Closed 상태 전이. Netflix Hystrix가 유명 |
| **Retry with Exponential Backoff** | 재시도 간격을 1s → 2s → 4s로 늘림. 장애 서비스에 부하를 가중시키지 않기 위함 |
| **Bulkhead Pattern** | 리소스를 격리. DB 커넥션 풀을 서비스별로 분리해서 한 서비스 장애가 전체에 전파 안 되게 |
| **Graceful Degradation** | 전체 중단 대신 기능 축소. "이미지 업로드 안 되지만 글은 쓸 수 있음" |
| **MTTR (Mean Time To Recovery)** | 장애 복구 평균 시간. MTTR이 짧을수록 가용성이 높음 |
| **Cascading Failure** | 한 컴포넌트 장애가 연쇄적으로 전체 시스템을 쓰러뜨리는 현상. 가장 위험한 장애 패턴 |
| **Steady State Hypothesis** | 카오스 실험 전에 "정상 상태"를 정의. 실험 후 이 상태로 돌아오는지 확인 |

---

## 구현

### Task 19: 장애 시뮬레이션 스크립트

**Files:**
- Create: `chaos/redis_down.sh`
- Create: `chaos/db_down.sh`
- Create: `chaos/network_delay.sh`
- Create: `chaos/run_all.sh`

- [ ] **Step 1: Redis 장애 시뮬레이션**

```bash
#!/bin/bash
# chaos/redis_down.sh
# Redis가 죽었을 때 앱이 어떻게 동작하는지 확인

echo "=== Redis 장애 시뮬레이션 ==="
echo ""

COMPOSE_PROJECT=$(basename "$(pwd)")

echo "[1/4] 현재 상태 확인..."
curl -s http://localhost:8000/api/posts?limit=1 | python3 -m json.tool
echo ""

echo "[2/4] Redis 정지 (docker pause)..."
docker compose pause redis
echo "Redis paused. 앱이 타임아웃까지 대기할 것."
echo ""

echo "[3/4] Redis 없이 요청 테스트 (10초 동안)..."
for i in $(seq 1 10); do
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:8000/api/posts?limit=1)
    echo "  요청 $i: HTTP $STATUS"
    sleep 1
done
echo ""

echo "[4/4] Redis 복구..."
docker compose unpause redis
echo "Redis 재개. 정상 동작 확인:"
sleep 2
curl -s http://localhost:8000/api/posts?limit=1 | python3 -m json.tool

echo ""
echo "=== 확인 사항 ==="
echo "- Redis 없이도 API가 응답했는가? (DB 폴백)"
echo "- 응답 시간이 얼마나 늘었는가?"
echo "- Redis 복구 후 정상 동작하는가?"
echo "- 카운터 데이터 유실이 있는가?"
```

- [ ] **Step 2: DB 장애 시뮬레이션**

```bash
#!/bin/bash
# chaos/db_down.sh
# DB가 죽었을 때 캐시된 데이터로 읽기가 가능한지 확인

echo "=== DB 장애 시뮬레이션 ==="
echo ""

echo "[1/5] 캐시 워밍업 (게시글 목록 조회)..."
curl -s http://localhost:8000/api/posts?limit=5 > /dev/null
echo "캐시 워밍업 완료."
echo ""

echo "[2/5] DB 정지..."
docker compose pause db
echo "DB paused."
echo ""

echo "[3/5] 읽기 테스트 (캐시에서 응답 기대)..."
for i in $(seq 1 5); do
    START=$(date +%s%N)
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:8000/api/posts?limit=5)
    END=$(date +%s%N)
    DURATION=$(( (END - START) / 1000000 ))
    echo "  읽기 $i: HTTP $STATUS (${DURATION}ms)"
    sleep 1
done
echo ""

echo "[4/5] 쓰기 테스트 (실패 기대)..."
STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 \
    -X POST http://localhost:8000/api/posts \
    -H "Content-Type: application/json" \
    -d '{"title":"Chaos Test","content":"Should fail","author":"chaos"}')
echo "  쓰기 시도: HTTP $STATUS (500 기대)"
echo ""

echo "[5/5] DB 복구..."
docker compose unpause db
echo "DB 재개."
sleep 3
STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/api/posts?limit=1)
echo "복구 후 읽기: HTTP $STATUS"

echo ""
echo "=== 확인 사항 ==="
echo "- DB 없이 캐시된 데이터 읽기가 가능했는가?"
echo "- 쓰기가 적절한 에러를 반환했는가? (500, 503)"
echo "- DB 복구 후 정상 동작하는가?"
```

- [ ] **Step 3: 네트워크 지연 시뮬레이션**

```bash
#!/bin/bash
# chaos/network_delay.sh
# DB 응답이 느려졌을 때 (디스크 I/O 포화 시뮬레이션)

echo "=== 네트워크 지연 시뮬레이션 ==="
echo ""

DB_CONTAINER=$(docker compose ps -q db)

echo "[1/4] 현재 응답 시간 측정..."
for i in $(seq 1 3); do
    TIME=$(curl -s -o /dev/null -w "%{time_total}" http://localhost:8000/api/posts?limit=5)
    echo "  요청 $i: ${TIME}s"
done
echo ""

echo "[2/4] DB 컨테이너에 200ms 네트워크 지연 추가..."
docker exec $DB_CONTAINER sh -c "apk add --no-cache iproute2 2>/dev/null; tc qdisc add dev eth0 root netem delay 200ms" 2>/dev/null || \
echo "  (tc 설정 실패 시: DB 이미지에 iproute2가 없을 수 있음. 수동으로 docker exec 필요)"
echo ""

echo "[3/4] 지연 상태에서 응답 시간 측정..."
for i in $(seq 1 5); do
    TIME=$(curl -s -o /dev/null -w "%{time_total}" http://localhost:8000/api/posts?limit=5)
    echo "  요청 $i: ${TIME}s"
    sleep 1
done
echo ""

echo "[4/4] 지연 제거..."
docker exec $DB_CONTAINER sh -c "tc qdisc del dev eth0 root" 2>/dev/null
echo "지연 제거 완료."

echo ""
echo "=== 확인 사항 ==="
echo "- 캐시 히트 시에는 영향 없었는가?"
echo "- 캐시 미스 시 응답 시간이 200ms+ 증가했는가?"
echo "- 커넥션 풀이 고갈되지 않았는가?"
```

- [ ] **Step 4: 전체 시나리오 실행 스크립트**

```bash
#!/bin/bash
# chaos/run_all.sh
# 모든 장애 시나리오를 순차 실행

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "================================================"
echo "  카오스 엔지니어링 — 전체 시나리오 실행"
echo "================================================"
echo ""

echo ">>> 시나리오 1: Redis 장애"
echo "================================================"
bash "$SCRIPT_DIR/redis_down.sh"
echo ""
sleep 5

echo ">>> 시나리오 2: DB 장애"
echo "================================================"
bash "$SCRIPT_DIR/db_down.sh"
echo ""
sleep 5

echo ">>> 시나리오 3: 네트워크 지연"
echo "================================================"
bash "$SCRIPT_DIR/network_delay.sh"
echo ""

echo "================================================"
echo "  전체 시나리오 완료"
echo "================================================"
```

- [ ] **Step 5: 실행 권한 부여 + 실행**

```bash
chmod +x chaos/*.sh
bash chaos/run_all.sh
```

- [ ] **Step 6: 부하 + 장애 동시 테스트**

가장 현실적인 시나리오: 트래픽이 있는 상태에서 장애 발생.

```bash
# 터미널 1: 부하 테스트 실행
k6 run loadtest/scenarios/mixed_load.js

# 터미널 2: 부하 중 Redis 정지 (2분쯤에 실행)
sleep 120 && docker compose pause redis && sleep 30 && docker compose unpause redis
```

k6 결과에서 Redis 정지 구간의 응답 시간 변화 확인. Grafana에서 시각적으로도 관찰.

- [ ] **Step 7: Commit**

```bash
git add chaos/
git commit -m "feat: chaos engineering scripts — Redis/DB/network failure simulation"
```

---

## Phase 11 완료 체크리스트

- [ ] Redis 장애 시 DB 폴백 동작 확인
- [ ] DB 장애 시 캐시 읽기 동작 확인 + 쓰기 에러 확인
- [ ] 네트워크 지연 시 캐시 효과 확인
- [ ] 부하 + 장애 동시 시나리오 실행
- [ ] 장애 복구 후 데이터 정합성 확인

**핵심 체감:**
- Redis 죽어도 서비스는 돌아감 (느리지만 동작) = 캐시는 보조 계층
- DB 죽으면 쓰기 불가, 읽기는 캐시로 버팀 = DB는 핵심 계층
- 장애 복구 후 자동 정상화 = 좋은 아키텍처의 징표

**다음:** [Phase 12 — 클라우드 배포](phase-12-cloud.md)
