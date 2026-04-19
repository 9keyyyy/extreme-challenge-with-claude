# Phase 4.5: 멀티 인스턴스 인프라 — "진짜 분산 환경 만들기"

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans

**전제:** Phase 4 완료. CRUD + 캐시 + Stampede 방지가 동작하는 상태.

**학습 키워드**
`Load Balancer (L7)` `Nginx upstream` `Round-Robin` `Health Check` `Redis Sentinel` `Quorum` `Failover` `Docker Compose Profile` `Horizontal Scaling` `Single Point of Failure (SPOF)` `High Availability (HA)`

---

## 학습: 왜 멀티 인스턴스가 필요한가

### 핵심 질문 — "서버 한 대로 충분하지 않나요?"

> "지금까지 API 서버 1대, DB 1대, Redis 1대로 동작함. 근데 이 중 하나라도 죽으면 서비스 전체가 날아감. 이걸 SPOF(Single Point of Failure)라 하고, 프로덕션에서 SPOF를 허용하는 서비스는 없음."

**SPOF 제거가 수평 확장의 전제 조건임:**

```
SPOF 있는 아키텍처:
  Client → API (1대) → DB (1대) → Redis (1대)
  API 죽으면: 서비스 전체 중단
  DB 죽으면: 서비스 전체 중단
  Redis 죽으면: 캐시 계층 사라짐 (DB 과부하 → 서비스 저하)

SPOF 제거한 아키텍처:
  Client → Nginx LB → API (3대) → DB (1대) → Redis Sentinel (primary + replica)
  API 1대 죽으면: 나머지 2대가 처리. Nginx가 health check로 자동 제외
  Redis primary 죽으면: Sentinel이 replica를 primary로 승격. 앱은 새 primary에 연결
```

DB도 이상적으로는 replica를 두어야 하지만, Phase 7(CQRS)에서 읽기/쓰기 분리할 때 도입함. 지금은 API + Redis의 HA부터 확보.

---

### Nginx L7 Load Balancer — 왜 Nginx인가

**선택지 비교:**

| 선택지 | 장점 | 단점 | 판정 |
|--------|------|------|------|
| Nginx (L7) | 설정 단순, passive health check 내장, 로컬에서 가벼움 | TCP 레벨(L4) 제어 안 됨, active health check는 Plus(유료)만 | **선택** — 로컬 개발에서 가장 현실적 |
| HAProxy | L4/L7 둘 다 가능, 성능 우수 | 설정이 Nginx보다 복잡, 러닝 커브 | 이 프로젝트 목적(학습)에 오버스펙 |
| Traefik | Docker 네이티브, 자동 서비스 디스커버리 | 학습 곡선, 컨테이너 레이블 기반 설정 | LB 자체가 학습 목적이 아님 |

**Nginx upstream의 핵심 동작:**

```nginx
upstream app_cluster {
    server app-1:8000;
    server app-2:8000;
    server app-3:8000;
}
```

- **Round-Robin (기본):** 요청을 순서대로 1→2→3→1→... 분배. 가장 단순하고 충분히 공정
- **Least Connections:** 현재 연결 수가 가장 적은 서버로. 요청 처리 시간이 불균일할 때 유리
- **IP Hash:** 같은 IP → 항상 같은 서버. Sticky Session이 필요한 경우

이 프로젝트는 Round-Robin으로 충분. 앱이 stateless이고 세션은 Redis에 있으니까.

---

### Redis Sentinel — 왜 Cluster가 아닌 Sentinel인가

**선택지 비교:**

| 선택지 | 장점 | 단점 | 판정 |
|--------|------|------|------|
| Redis Sentinel | 자동 failover, 모니터링 내장, 설정 간단 | 샤딩 없음(단일 마스터), failover 중 write 유실 가능 | **선택** — 데이터 크기에 샤딩 불필요. failover 유실 자체가 학습 대상 |
| Redis Cluster | 샤딩 내장, 수평 확장 | 최소 6노드(master 3 + replica 3), cross-slot 연산 제한, 로컬에서 무거움 | 데이터 크기 대비 오버스펙, 리소스 부담 |
| Redis 단일 + AOF | 가장 단순, 리소스 최소 | SPOF, failover 없음 | 장애 시나리오 테스트 불가 |

**Sentinel의 동작 원리:**

```
정상 상태:
  Sentinel 1 ─── 감시 ──→ Redis Primary (read/write)
  Sentinel 2 ─── 감시 ──→ Redis Primary
  Sentinel 3 ─── 감시 ──→ Redis Primary
                           ↓ 복제
                          Redis Replica (read only)

Primary 장애 시:
  1. Sentinel들이 Primary에 PING → 응답 없음
  2. Sentinel 1이 Primary를 "주관적 다운(SDOWN)" 판정
  3. 다른 Sentinel도 확인 → "객관적 다운(ODOWN)" (quorum 도달)
  4. Sentinel 리더가 Replica를 Primary로 승격
  5. 앱이 Sentinel에게 새 Primary 주소를 물어봄 → 자동 전환
```

**Quorum:** Sentinel 3대 중 2대 이상이 "다운"에 동의해야 failover 실행. 네트워크 일시 장애로 오판하는 것 방지. Sentinel이 1대면 quorum 불가 → 최소 3대 필요.

---

### Docker Compose Profile — 왜 파일을 나누지 않고 Profile인가

모든 컨테이너를 항상 띄우면 로컬 리소스가 부족함. 필요한 Phase에서 필요한 것만 올려야 함.

```bash
# Phase 4.5~6: API 3대 + Nginx + Redis Sentinel
docker compose -f docker-compose.distributed.yml --profile core up -d

# Phase 7~: + PG primary/replica 추가
docker compose -f docker-compose.distributed.yml --profile core --profile replica up -d

# Phase 9~: + 모니터링 스택 추가
docker compose -f docker-compose.distributed.yml --profile core --profile replica --profile monitoring up -d
```

| Profile | 컨테이너 | 예상 리소스 |
|---------|---------|-----------|
| core | API 3 + Nginx + Redis primary/replica + Sentinel 3 + PG + MinIO | 11개, 약 3GB RAM |
| + replica | + PG replica | 12개, 약 3.5GB RAM |
| + monitoring | + Prometheus + Grafana + Jaeger | 15개, 약 5GB RAM |

M1/M2 16GB 맥에서 core + replica까지는 여유 있음. monitoring까지 올리면 빡빡하지만 가능.

---

### 심화 학습 — 더 깊이 파볼 키워드

| 키워드 | 왜 알아야 하는지 |
|--------|----------------|
| **Service Discovery** | 서버가 동적으로 추가/제거될 때 LB가 어떻게 알아내는지. Nginx는 정적 설정, Consul/etcd는 동적. K8s Service는 자동 |
| **Sticky Session (Session Affinity)** | 같은 클라이언트 → 항상 같은 서버. WebSocket이나 파일 업로드 chunking에 필요. 하지만 stateless 설계가 되어있으면 불필요 |
| **Connection Draining** | 서버를 내릴 때 진행 중인 요청은 완료시키고 새 요청만 안 받는 것. 무중단 배포 핵심 |
| **Redis Sentinel vs Cluster** | Sentinel은 HA(가용성), Cluster는 HA + 샤딩(확장성). 데이터가 메모리 한 대에 들어가면 Sentinel, 안 들어가면 Cluster |
| **Split Brain** | 네트워크 파티션으로 Sentinel들이 쪼개져서 Primary가 2개 되는 상황. `min-slaves-to-write`로 완화 가능 |

---

## 구현

> **TDD 참고:** 이 Phase는 Docker Compose 인프라 구성이라 TDD 대상 아님. Health check + 연결 확인으로 검증.

### Task 10A: 멀티 인스턴스 Docker Compose 구성

**Files:**
- Create: `docker-compose.distributed.yml`
- Create: `nginx/nginx.conf`
- Create: `redis/sentinel.conf.template`
- Create: `postgres/primary-init.sh`
- Modify: `src/redis_client.py`
- Modify: `src/main.py`

- [ ] **Step 1: Nginx 설정**

```nginx
# nginx/nginx.conf
upstream app_cluster {
    # max_fails=3: 3번 연속 실패하면 서버를 일시 제외
    # fail_timeout=30s: 30초 후 다시 시도
    # Nginx OSS는 이 passive health check만 지원. Active health check는 Plus(유료) 전용.
    server app-1:8000 max_fails=3 fail_timeout=30s;
    server app-2:8000 max_fails=3 fail_timeout=30s;
    server app-3:8000 max_fails=3 fail_timeout=30s;
}

server {
    listen 80;

    location / {
        proxy_pass http://app_cluster;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 5s;
        proxy_read_timeout 30s;
        proxy_next_upstream error timeout http_502 http_503;
    }

    location /health {
        proxy_pass http://app_cluster;
        proxy_connect_timeout 2s;
        proxy_read_timeout 2s;
    }
}
```

- [ ] **Step 2: Redis Sentinel 설정**

```conf
# redis/sentinel.conf.template
# 주의: 이건 템플릿임. Sentinel은 실행 중에 conf 파일을 직접 수정함 (failover 이력, 현재 master 정보 기록).
# 그래서 각 Sentinel이 자기만의 복사본을 가져야 함. docker entrypoint에서 복사 후 실행.
port 26379
sentinel monitor mymaster redis-primary 6379 2
sentinel down-after-milliseconds mymaster 5000
sentinel failover-timeout mymaster 10000
sentinel parallel-syncs mymaster 1
```

- `sentinel monitor mymaster redis-primary 6379 2` — "redis-primary"를 감시하고, quorum은 2 (3대 중 2대 동의)
- `down-after-milliseconds 5000` — 5초 응답 없으면 다운 판정
- `failover-timeout 10000` — failover 전체 과정 최대 10초

**왜 conf 파일을 공유하면 안 되는지:** Sentinel은 실행 중에 자기 conf에 `sentinel known-replica`, `sentinel known-sentinel`, `sentinel current-epoch` 등을 직접 써넣음. 3대가 같은 파일을 read-only로 마운트하면 쓰기 실패로 에러남. 각자 복사본을 갖도록 entrypoint에서 `cp` 후 실행함.

- [ ] **Step 3: PG Replication 초기화 스크립트**

```bash
#!/bin/bash
# postgres/primary-init.sh
# PG primary에서 replication 허용 설정 (docker-entrypoint-initdb.d에서 최초 1회 실행)

set -e

# replication 전용 유저 생성
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'postgres';
EOSQL

# pg_hba.conf에 replication 허용 추가
echo "host replication replicator 0.0.0.0/0 md5" >> "$PGDATA/pg_hba.conf"

echo "Replication user and pg_hba.conf configured."
```

- [ ] **Step 4: docker-compose.distributed.yml 작성**

```yaml
# docker-compose.distributed.yml
x-app-env: &app-env
  DATABASE_URL: postgresql+asyncpg://postgres:postgres@db:5432/extreme_board
  REDIS_SENTINEL_HOSTS: sentinel-1:26379,sentinel-2:26379,sentinel-3:26379
  REDIS_SENTINEL_MASTER: mymaster
  MINIO_ENDPOINT: minio:9000
  MINIO_ACCESS_KEY: minioadmin
  MINIO_SECRET_KEY: minioadmin

services:
  # === Core Profile: API + LB + Redis Sentinel ===

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/conf.d/default.conf:ro
    depends_on:
      - app-1
      - app-2
      - app-3
    profiles: ["core"]

  app-1:
    build: .
    environment:
      <<: *app-env
      INSTANCE_ID: app-1
    depends_on: [db, redis-primary]
    profiles: ["core"]

  app-2:
    build: .
    environment:
      <<: *app-env
      INSTANCE_ID: app-2
    depends_on: [db, redis-primary]
    profiles: ["core"]

  app-3:
    build: .
    environment:
      <<: *app-env
      INSTANCE_ID: app-3
    depends_on: [db, redis-primary]
    profiles: ["core"]

  db:
    image: postgres:16
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: extreme_board
    volumes:
      - pg_primary_data:/var/lib/postgresql/data
      - ./postgres/primary-init.sh:/docker-entrypoint-initdb.d/init-replication.sh:ro
    ports:
      - "5432:5432"
    command: >
      postgres
        -c wal_level=replica
        -c max_wal_senders=3
        -c max_replication_slots=3
        -c hot_standby=on
    profiles: ["core"]

  redis-primary:
    image: redis:7-alpine
    command: redis-server --appendonly yes
    volumes:
      - redis_primary_data:/data
    profiles: ["core"]

  redis-replica:
    image: redis:7-alpine
    command: redis-server --appendonly yes --replicaof redis-primary 6379
    depends_on: [redis-primary]
    profiles: ["core"]

  sentinel-1:
    image: redis:7-alpine
    command: >
      sh -c "cp /etc/redis/sentinel.conf.template /tmp/sentinel.conf
             && redis-sentinel /tmp/sentinel.conf"
    volumes:
      - ./redis/sentinel.conf.template:/etc/redis/sentinel.conf.template:ro
    ports:
      - "26379:26379"  # 호스트에서 Sentinel 접근 (테스트용 — master 주소 resolve)
    depends_on: [redis-primary, redis-replica]
    profiles: ["core"]

  sentinel-2:
    image: redis:7-alpine
    command: >
      sh -c "cp /etc/redis/sentinel.conf.template /tmp/sentinel.conf
             && redis-sentinel /tmp/sentinel.conf"
    volumes:
      - ./redis/sentinel.conf.template:/etc/redis/sentinel.conf.template:ro
    depends_on: [redis-primary, redis-replica]
    profiles: ["core"]

  sentinel-3:
    image: redis:7-alpine
    command: >
      sh -c "cp /etc/redis/sentinel.conf.template /tmp/sentinel.conf
             && redis-sentinel /tmp/sentinel.conf"
    volumes:
      - ./redis/sentinel.conf.template:/etc/redis/sentinel.conf.template:ro
    depends_on: [redis-primary, redis-replica]
    profiles: ["core"]

  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    ports:
      - "9000:9000"
      - "9001:9001"
    profiles: ["core"]

  # === Workers ===
  # 주의: counter-sync는 Phase 5, event-consumer는 Phase 7에서 코드를 생성함.
  # Phase 4.5 시점에서는 이 컨테이너들이 시작 실패함 (모듈 없음) — 정상.
  # 해당 Phase 구현 후부터 동작함.

  counter-sync:
    build: .
    command: python -m src.workers.counter_sync
    environment: *app-env
    depends_on: [db, redis-primary]
    profiles: ["workers"]

  event-consumer:
    build: .
    command: python -m src.workers.event_consumer
    environment: *app-env
    depends_on: [db, redis-primary]
    profiles: ["workers"]

  # === Replica Profile: PG Primary/Replica ===

  db-replica:
    image: postgres:16
    environment:
      PGPASSWORD: postgres
    ports:
      - "5433:5432"  # 호스트에서 replica 접근 (Phase 7 lag 측정 테스트용)
    volumes:
      - pg_replica_data:/var/lib/postgresql/data
    # 주의: pg_basebackup은 data 디렉토리가 비어있어야 함.
    # 볼륨에 이전 데이터가 남아있으면 실패 → docker volume rm 후 재시도.
    # -R 플래그가 standby.signal + primary_conninfo를 자동 생성함.
    command: >
      bash -c "
        if [ -f /var/lib/postgresql/data/standby.signal ]; then
          echo 'Replica already initialized, starting...';
          exec postgres -c hot_standby=on;
        fi;
        until pg_isready -h db -U postgres; do echo 'Waiting for primary...'; sleep 2; done;
        rm -rf /var/lib/postgresql/data/*;
        pg_basebackup -h db -U replicator -D /var/lib/postgresql/data -Fp -Xs -R -P;
        exec postgres -c hot_standby=on
      "
    depends_on: [db]
    profiles: ["replica"]

  # === Monitoring Profile ===

  prometheus:
    image: prom/prometheus
    volumes:
      - ./monitoring/prometheus.yml:/etc/prometheus/prometheus.yml:ro
    ports:
      - "9090:9090"
    profiles: ["monitoring"]

  grafana:
    image: grafana/grafana
    ports:
      - "3000:3000"
    environment:
      GF_SECURITY_ADMIN_PASSWORD: admin
    profiles: ["monitoring"]

  jaeger:
    image: jaegertracing/all-in-one
    ports:
      - "16686:16686"
      - "6831:6831/udp"
    profiles: ["monitoring"]

volumes:
  pg_primary_data:
  pg_replica_data:
  redis_primary_data:
```

- [ ] **Step 5: Redis 클라이언트를 Sentinel 대응으로 수정**

```python
# src/redis_client.py — Sentinel 지원 추가
import os

import redis.asyncio as redis
from redis.asyncio.sentinel import Sentinel

SENTINEL_HOSTS = os.getenv("REDIS_SENTINEL_HOSTS", "")
SENTINEL_MASTER = os.getenv("REDIS_SENTINEL_MASTER", "mymaster")
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")


async def _create_client():
    """Sentinel 설정이 있으면 Sentinel 사용, 없으면 단일 Redis 사용.

    master_for()는 내부적으로 SentinelConnectionPool을 사용함.
    매 커맨드 실행 시 Sentinel에게 현재 master를 물어봄.
    → Failover가 발생하면 다음 커맨드부터 자동으로 새 master에 연결.
    → 단, failover 진행 중(수초)에는 ConnectionError가 발생할 수 있음.
       이건 앱 레벨에서 retry로 처리해야 함.
    """
    if SENTINEL_HOSTS:
        sentinels = [
            (h.split(":")[0], int(h.split(":")[1]))
            for h in SENTINEL_HOSTS.split(",")
        ]
        sentinel = Sentinel(sentinels, socket_timeout=3)
        return sentinel.master_for(SENTINEL_MASTER, decode_responses=True)
    return redis.from_url(REDIS_URL, decode_responses=True)


class _RedisProxy:
    """Lazy-initialized Redis 프록시.

    왜 프록시인가:
    - Phase 4에서는 redis_client = redis.from_url(...)로 모듈 레벨 즉시 초기화
    - Phase 4.5부터 Sentinel은 async 초기화 필요 (모듈 레벨에서 await 불가)
    - global 변수 재바인딩(redis_client = new_client)은
      기존 from src.redis_client import redis_client 참조를 끊음 (Python import 동작)
    - 프록시 객체는 import된 참조를 유지하면서 내부 클라이언트만 교체
    """
    _client = None

    def __getattr__(self, name):
        if self._client is None:
            raise RuntimeError("Redis not initialized. Call init_redis() first.")
        return getattr(self._client, name)


redis_client = _RedisProxy()


async def init_redis():
    redis_client._client = await _create_client()
```

- [ ] **Step 6: main.py에 Redis 초기화 + /health에 인스턴스 식별 추가**

```python
# src/main.py — lifespan에 init_redis 추가 + /health 수정
import os
from contextlib import asynccontextmanager

from src.redis_client import init_redis

INSTANCE_ID = os.getenv("INSTANCE_ID", "standalone")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_redis()
    yield


# /health 엔드포인트에 인스턴스 식별 추가
@app.get("/health")
async def health():
    return {"status": "ok", "instance": INSTANCE_ID}
```

`_RedisProxy` 덕분에 Phase 4에서 사용하던 `from src.redis_client import redis_client` import 패턴이 그대로 동작함. 프록시 객체의 참조는 유지되고, `init_redis()`가 내부 `_client`만 교체하기 때문. 만약 프록시 없이 `global redis_client` 재바인딩을 썼다면, 기존 import들이 `None`을 계속 참조하는 버그가 발생함 (Python `from ... import`는 import 시점의 값을 복사).

- [ ] **Step 7: 분산 환경 동작 확인**

```bash
# core profile로 멀티 인스턴스 실행
docker compose -f docker-compose.distributed.yml --profile core up -d

# Nginx를 통한 요청 분배 확인 — instance 필드로 어느 서버가 응답했는지 확인
for i in 1 2 3 4 5 6; do
  curl -s http://localhost/health
done
# 예상 출력: {"status":"ok","instance":"app-1"}, {"status":"ok","instance":"app-2"}, ...
# round-robin이므로 app-1 → app-2 → app-3 → app-1 → ... 순서로 분배

# Redis Sentinel 상태 확인
docker compose -f docker-compose.distributed.yml exec sentinel-1 \
  redis-cli -p 26379 sentinel master mymaster

# API 서버 1대 중지 → 나머지 2대로 서비스 지속 확인
docker compose -f docker-compose.distributed.yml stop app-2
curl -s http://localhost/health  # 여전히 응답 (app-1 또는 app-3)
docker compose -f docker-compose.distributed.yml start app-2
```

- [ ] **Step 8: Commit**

```bash
git add docker-compose.distributed.yml nginx/ redis/ postgres/ src/redis_client.py src/main.py
git commit -m "feat: multi-instance infra — Nginx LB + Redis Sentinel + compose profiles"
```

---

## Phase 4.5 완료 체크리스트

- [ ] docker-compose.distributed.yml 작성 (profile 기반)
- [ ] Nginx LB 통해 API 3대에 요청 분산 확인
- [ ] Redis Sentinel이 primary/replica 모니터링 확인
- [ ] API 1대 중지 → 서비스 지속 확인
- [ ] 기존 단일 docker-compose.yml과 공존 확인

**핵심 체감:**
- 서버 1대 죽어도 서비스가 살아있음 = HA의 기본
- Sentinel이 Redis 상태를 감시하고 있음 = 자동 failover 준비 완료
- Phase 5부터는 이 환경에서 "멀티 인스턴스에서도 동작하는가?"를 항상 검증

**다음:** [Phase 5 — Redis 카운터](phase-05-redis-counter.md)
