# Phase 9: 모니터링 — 실시간으로 병목 보기

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans

**전제:** Phase 8 완료. 전체 기능이 동작하는 상태.

**학습 키워드**
`Observability (Metrics/Traces/Logs)` `Prometheus (Pull 모델)` `Grafana Dashboard` `OpenTelemetry` `Jaeger (분산 추적)` `SLI/SLO/SLA` `RED Method` `USE Method` `Percentile (p50/p95/p99)` `PromQL` `Span/Trace`

---

## 학습: 왜 모니터링이 필요한가

### 핵심 질문 — "모니터링을 어떻게 구성하셨나요?"

"Grafana 깔고 대시보드 만들었음" 수준이 아니라, 구조적으로 이해하고 있어야 함:

> "Metrics/Traces/Logs 세 축으로 구성함. 메트릭으로 이상 징후를 감지하고, 트레이스로 어느 레이어에서 느린지 찾고, 로그로 정확히 왜 실패했는지 확인하는 흐름."

### "느려졌다" vs "p99가 200ms → 2s" — 측정 가능성의 차이

**모니터링 없는 팀의 장애 대응:**
```
유저 신고: "게시판이 느려요"
개발자: "지금은 괜찮은데요?"
유저: "아까부터 느렸어요"
개발자: "재현이 안 되는데... 서버 재시작해볼게요"
결과: 원인 불명, 재발 가능
```

**모니터링 있는 팀의 장애 대응:**
```
알림: p99 latency 200ms → 2s (임계값 초과)
Grafana: DB 커넥션 풀 사용률 95% 동시 급증 확인
Jaeger: /api/posts GET 요청에서 DB 쿼리 1.8s 차지
로그: "connection pool timeout" 에러 다수 발생
결론: DB 커넥션 풀 크기 조정 + 슬로우 쿼리 최적화
결과: 5분 안에 원인 파악, 재발 방지 가능
```

측정 가능한 시스템은 개선 가능함. 느낌이 아니라 숫자로 말할 수 있어야 엔지니어임.

### Observability 3축 — 언제 뭘 쓰는가

| 축 | 도구 | 역할 | 답하는 질문 | 비유 |
|---|---|---|---|---|
| 메트릭 | Prometheus + Grafana | 숫자 시계열 데이터 | "지금 뭐가 어떤 상태지?" | 자동차 계기판 |
| 트레이스 | Jaeger (OpenTelemetry) | 요청의 전체 경로 | "이 요청이 어디서 느린 거지?" | GPS 경로 기록 |
| 로그 | Loki + Grafana | 상세 이벤트 기록 | "왜 에러가 났지?" | 블랙박스 영상 |

**실전 흐름:**
1. Grafana 대시보드에서 p99 스파이크 감지 (메트릭)
2. "저 스파이크 일어난 시점"의 요청을 Jaeger에서 탐색 → API Handler는 10ms인데 DB 레이어가 1.8s (트레이스)
3. 해당 요청의 trace ID로 Loki에서 로그 검색 → "Index scan on posts table, 50M rows" (로그)
4. 해결책: 인덱스 추가

세 축이 연결될 때 진짜 힘이 나옴. 각자 따로 보면 한계가 있음.

### Prometheus Pull 모델 — 왜 죽은 서비스를 감지할 수 있는가

**Push 방식 (Datadog, CloudWatch):**
```
앱 → (메트릭 밀어넣기) → 수집 서버
```
앱이 죽으면? 메트릭도 안 옴. 수집 서버 입장에서는 "그냥 조용해진 것"인지 "죽은 것"인지 구분하기 어려움.

**Pull 방식 (Prometheus):**
```
Prometheus → (주기적으로 /metrics 엔드포인트 호출) → 앱
```
앱이 죽으면? Prometheus가 "응답 없음"을 명확히 감지함. `up == 0` 알림이 즉시 발동됨.

이것이 Pull 방식의 핵심 장점: **서비스 생사를 모니터링이 능동적으로 확인함.** Push 방식은 앱이 자발적으로 보고해야 하는데, 죽은 앱은 보고를 못 함.

부가 장점: scrape_interval(수집 주기)을 중앙에서 통제 가능. 앱은 그냥 `/metrics` 엔드포인트만 열면 됨.

### 백분위수 (Percentile) — 평균이 거짓말하는 방법

**예시:**
```
1000번의 요청 중:
- 990번: 10ms
- 10번: 10,000ms (10초)

평균: (990 × 10 + 10 × 10,000) / 1000 = 109ms → "빠름!"
p99: 10,000ms → "최악"
```

평균 109ms면 SLO 통과처럼 보임. 근데 실제로 1%의 유저는 10초 기다리고 있음.

**1M RPS에서의 1%:**
```
1,000,000 RPS × 1% = 10,000 요청/초가 느린 것
초당 1만 명이 10초 대기 = 심각한 문제
```

이래서 평균이 아닌 백분위수로 SLO를 정의함:
- **p50 (중앙값):** 절반의 요청이 이보다 빠름. "전형적인 경험"
- **p95:** 95% 요청이 이보다 빠름. "대부분의 유저 경험"
- **p99:** 99% 요청이 이보다 빠름. "꼬리 레이턴시". 극한 트래픽에서 핵심.

넷플릭스, 구글, 아마존이 p99를 SLO로 쓰는 이유가 바로 이거임.

### SLI / SLO / SLA — 이 프로젝트를 예시로

**SLI (Service Level Indicator): 실제로 측정하는 값**
- 게시글 목록 API의 p99 응답시간
- HTTP 500 에러율
- 가용성 (정상 응답 수 / 전체 요청 수)

**SLO (Service Level Objective): 내부 목표**
- p99 latency < 500ms
- 에러율 < 0.1%
- 가용성 99.9% (한 달에 43분 이하 다운타임 허용)

**SLA (Service Level Agreement): 외부 계약**
- SLO 위반 시 고객에게 크레딧 지급 등 페널티
- SLO보다 완화된 값으로 설정하는 게 일반적 (버퍼)

이 프로젝트에서의 의미:
```
SLI: Prometheus로 측정하는 histogram_quantile(0.99, ...)
SLO: p99 < 200ms (평상시), p99 < 500ms (부하시)
SLA: 이 프로젝트는 개인 프로젝트라 SLA 없음. 하지만 SLO를 정의하는 것 자체가 "어느 정도 성능이 목표인가"를 명확히 하는 것임
```

"SLI/SLO가 뭐야?"라는 질문에 이 프로젝트를 예시로 들어 설명할 수 있으면 됨.

### 심화 학습 — 더 깊이 파볼 키워드

| 키워드 | 왜 알아야 하는지 |
|--------|----------------|
| **SLI / SLO / SLA** | SLI = 측정 지표 (p99 latency), SLO = 목표 (99.9%), SLA = 계약 (위반 시 보상). 모니터링의 목적 |
| **RED Method** | Rate, Errors, Duration. 서비스 모니터링의 골든 시그널 |
| **USE Method** | Utilization, Saturation, Errors. 인프라(CPU/메모리/디스크) 모니터링 |
| **PromQL** | Prometheus 쿼리 언어. `rate()`, `histogram_quantile()` 등 필수 함수 |
| **Span / Trace / Baggage** | 분산 추적의 기본 단위. Span = 하나의 작업, Trace = Span의 트리, Baggage = 전파되는 메타데이터 |
| **Exemplar** | 메트릭에 trace ID를 연결. "p99가 느린 그 요청"을 바로 추적 가능 |
| **Structured Logging** | JSON 형태 로그. `grep` 대신 쿼리로 검색. Loki/ELK에서 필수 |

---

## 구현

> **TDD 참고:** 이 Phase는 모니터링 인프라(Prometheus/Grafana/Jaeger) 구성이 중심. 메트릭 엔드포인트와 트레이싱 미들웨어에 대해서만 TDD 적용.

### Task 17: 모니터링 스택 구성

**Files:**
- Create: `docker-compose.monitoring.yml`
- Create: `monitoring/prometheus/prometheus.yml`
- Modify: `pyproject.toml` (의존성 추가)
- Modify: `src/main.py`

- [ ] **Step 1: docker-compose.monitoring.yml**

```yaml
services:
  prometheus:
    image: prom/prometheus
    ports:
      - "9090:9090"
    volumes:
      - ./monitoring/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml

  grafana:
    image: grafana/grafana
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin

  jaeger:
    image: jaegertracing/all-in-one:latest
    ports:
      - "16686:16686"
      - "4317:4317"

  loki:
    image: grafana/loki:latest
    ports:
      - "3100:3100"
```

- [ ] **Step 2: Prometheus 설정**

```yaml
# monitoring/prometheus/prometheus.yml
global:
  scrape_interval: 5s

scrape_configs:
  - job_name: "fastapi"
    static_configs:
      - targets: ["app:8000"]
```

- [ ] **Step 3: pyproject.toml에 의존성 추가**

```toml
"prometheus-fastapi-instrumentator>=7.0.0",
"opentelemetry-api>=1.20.0",
"opentelemetry-sdk>=1.20.0",
"opentelemetry-exporter-otlp>=1.20.0",
"opentelemetry-instrumentation-fastapi>=0.44b0",
```

- [ ] **Step 4: main.py에 Prometheus + OpenTelemetry 설정**

```python
# Prometheus 메트릭 자동 수집
from prometheus_fastapi_instrumentator import Instrumentator
Instrumentator().instrument(app).expose(app)

# OpenTelemetry 분산 추적
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

provider = TracerProvider()
provider.add_span_processor(
    BatchSpanProcessor(OTLPSpanExporter(endpoint="http://jaeger:4317", insecure=True))
)
trace.set_tracer_provider(provider)
FastAPIInstrumentor.instrument_app(app)
```

- [ ] **Step 5: 구동 + 확인**

Run: `docker compose -f docker-compose.yml -f docker-compose.monitoring.yml up --build -d`

확인:
- Grafana: http://localhost:3000 (admin/admin)
- Prometheus: http://localhost:9090 → `http_requests_total` 쿼리
- Jaeger: http://localhost:16686 → 요청 trace 확인

- [ ] **Step 6: Grafana 대시보드 구성**

Prometheus 데이터소스 추가 → 대시보드에 패널 추가:
- RPS (초당 요청 수)
- 응답시간 p50/p95/p99
- 에러율 (5xx)
- HTTP 상태 코드 분포

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: monitoring — Prometheus, Grafana, Jaeger, Loki"
```

---

## Phase 9 완료 체크리스트

- [ ] Prometheus에서 FastAPI 메트릭 수집 확인
- [ ] Grafana 대시보드에 RPS, p95/p99, 에러율 시각화
- [ ] Jaeger에서 요청 trace 확인 (API → DB → Redis 경로)
- [ ] 모든 도구가 Docker Compose로 한 번에 구동

**다음:** [Phase 10 — 부하 테스트](phase-10-load-testing.md)
