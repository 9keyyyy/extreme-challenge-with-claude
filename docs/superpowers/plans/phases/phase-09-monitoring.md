# Phase 9: 모니터링 — 실시간으로 병목 보기

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans

**전제:** Phase 8 완료. 전체 기능이 동작하는 상태.

---

## 학습: 왜 모니터링이 필요한가

### "느려졌다"가 아니라 "p99가 200ms→2s, DB 커넥션 95%"

모니터링 없으면: "게시판이 느린 것 같은데 왜인지 모르겠음"
모니터링 있으면: "p99가 2초로 악화, 원인은 DB 커넥션 풀 고갈"

### Observability 4축

| 축 | 도구 | 역할 | 질문 |
|---|---|---|---|
| 메트릭 | Prometheus + Grafana | 숫자 시계열 데이터 | "지금 RPS가 얼마지?" |
| 추적 | Jaeger | 요청의 전체 경로 | "이 요청이 어디서 느린 거지?" |
| 로그 | Loki + Grafana | 상세 이벤트 기록 | "왜 에러가 났지?" |
| 알림 | Grafana Alerting | 이상 징후 감지 | "뭔가 터졌을 때 알려줘" |

### 메트릭 수집: Pull vs Push

| | Prometheus (Pull) | Datadog/CloudWatch (Push) |
|---|---|---|
| 방식 | 서버가 앱에서 주기적으로 가져감 | 앱이 서버에 보냄 |
| 앱 장애 시 | "응답 없음" 감지 가능 | 메트릭도 안 오므로 감지 어려움 |
| 비용 | 무료 (셀프호스팅) | 유료 |

### 백분위수 (Percentile) — 평균은 무의미

99%가 10ms인데 1%가 10초면 → 평균 109ms로 "양호". 하지만 1%의 유저는 10초 대기.

- **p50 (중앙값):** 절반의 요청이 이보다 빠름
- **p95:** 95%의 요청이 이보다 빠름. "대부분의 유저 경험"
- **p99:** 99%의 요청이 이보다 빠름. "최악의 1% 유저 경험"

극한 트래픽에서는 p99가 핵심. 100만 RPS의 1% = 1만 요청/초가 느린 것.

---

## 구현

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
