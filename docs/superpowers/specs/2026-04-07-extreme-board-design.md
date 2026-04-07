# Extreme Board — 극한 트래픽 게시판 설계 문서

## 1. 개요

### 목적
100만 CCU / 100만 RPS / 100만 누적 게시글을 모두 고려한 극한 트래픽 게시판 백엔드 설계 및 구현. 단순히 동작하는 CRUD가 아니라, 각 아키텍처 결정의 근거를 명확히 하고 병목을 점진적으로 테스트하며 학습하는 것이 목표.

### 기능 범위
- 게시글 CRUD (생성/조회/수정/삭제 + 목록/페이지네이션)
- 댓글 CRUD
- 좋아요 / 조회수 (동시성 처리)
- 이미지 업로드 (게시글당 1-5장)
- 프론트엔드는 이번 설계에서 제외

### 핵심 제약
- **예산: $100 이하** (전체 클라우드 비용 포함)
- **로컬 중심 개발/테스트** — Docker Compose로 전체 아키텍처 구동
- **모든 설계 결정에 "왜?"를 포함** — 대안 비교, 장단점, 학습 포인트
- **점진적 병목 테스트** — 컴포넌트 구현 후 바로 테스트, "다 만들고 나서 테스트" 금지
- **DB 간 비교 학습** — PostgreSQL/MySQL/MongoDB 비교를 통한 깊은 이해

---

## 2. 전체 아키텍처

### 패턴: Monolith + CQRS

단일 코드베이스에서 Command(쓰기)와 Query(읽기)를 분리하는 구조.

**왜 이 패턴인가?**
- 마이크로서비스 대비: 코드베이스 하나로 학습/디버깅 용이. 로컬에서 전체 시스템 테스트 가능
- Modular Monolith 대비: 이 규모에서는 모듈 경계를 엄격히 나누는 것보다 CQRS로 읽기/쓰기 독립 스케일링하는 게 더 실질적인 가치
- 나중에 마이크로서비스로 전환 가능한 구조 유지

### 데이터 흐름

```
Write 경로: Client → ALB → Command Service → 멱등성 검증 → PostgreSQL → Event 발행 → Consumer가 캐시 갱신
Read 경로:  Client → ALB → Query Service → Redis 캐시 → 히트면 반환 / 미스면 Read Replica → 캐시 적재
카운터 경로: 조회수/좋아요 → Redis INCR (원자적) → 주기적 DB 벌크 동기화
이벤트 경로: Command → Redis Streams → Consumer → 캐시 무효화, 카운터 동기화, 비동기 작업
```

### 핵심 설계 원칙
1. **CQRS** — 읽기(99%)와 쓰기(1%)의 스케일링 요구가 다르므로 분리
2. **멱등성** — 모든 쓰기 요청에 멱등성 키. 네트워크 재시도/중복 요청에도 정합성 유지
3. **Eventual Consistency** — 카운터는 즉시 정합 대신 최종 정합성으로 성능 확보
4. **비동기 이벤트** — 쓰기 후 캐시 갱신/알림을 동기 처리하면 응답 지연. 이벤트로 분리

---

## 3. 컴포넌트 상세 설계

### 3.1 데이터베이스 — PostgreSQL

**왜 PostgreSQL인가? (vs MySQL, MongoDB)**

| 기준 | PostgreSQL | MySQL | MongoDB |
|------|-----------|-------|---------|
| 동시성 제어 | MVCC — 읽기가 쓰기를 안 막음 | Row Lock 기반, 갭 락 이슈 | Document-level lock |
| 정합성 | FK, CHECK, UNIQUE 완벽 | FK 지원 (InnoDB) | 스키마리스 — 앱 레벨 검증 |
| 멱등성 구현 | ON CONFLICT (upsert) 네이티브 | INSERT ON DUPLICATE KEY | upsert 지원 |
| 파티셔닝 | 네이티브 파티셔닝 | 파티셔닝 지원 | 샤딩 (운영 복잡) |

**선택 이유:** MVCC 기반이라 읽기가 쓰기를 차단하지 않음. 100만 CCU에서 락 경합 최소화. MySQL은 갭 락으로 고동시성에서 데드락 빈발, MongoDB는 정합성을 앱에서 직접 처리해야 함.

**병목 지점 (구현 직후 테스트):**

1. **Connection Pool 고갈** — 동시 요청이 커넥션 수 초과
   - 측정: k6 VU 100→1000, `pg_stat_activity` 모니터링
   - 해결: pool_size 튜닝 + PgBouncer

2. **대용량 테이블 풀스캔** — 100만 row에서 인덱스 없는 쿼리
   - 측정: `EXPLAIN ANALYZE`로 Seq Scan vs Index Scan 비교
   - 해결: 복합 인덱스 + 커서 기반 페이지네이션 + 파티셔닝

3. **Write 경합 (Hot Row)** — 카운터 직접 UPDATE
   - 측정: 동일 게시글 1000명 동시 좋아요 + `pg_stat_user_tables` lock 확인
   - 해결: Redis INCR로 카운터 분리

4. **트랜잭션 길어짐** — 하나의 TX에서 너무 많은 작업
   - 측정: `pg_stat_activity` long-running TX 모니터링
   - 해결: TX 범위 최소화 + 비동기 이벤트 분리

**학습 포인트 (DB 비교 포함):**
- MVCC: PG(스냅샷 격리) vs MySQL(락 기반) vs MongoDB(WiredTiger) 동시성 처리 차이
- Connection Pooling: pool_size 5→50 변경하며 처리량 변화 측정
- EXPLAIN ANALYZE: 인덱스 추가 전후 쿼리 플랜 비교
- 커서 페이지네이션: OFFSET vs WHERE id > last_id 100만 row 속도 비교
- 파티셔닝: 날짜별 파티셔닝 전후 범위 쿼리 성능 비교
- 격리 수준: PG(Read Committed 기본) vs MySQL(Repeatable Read 기본) — 같은 쿼리, 다른 결과

---

### 3.2 캐시 & 카운터 — Redis

**왜 Redis인가? (vs Memcached, KeyDB)**

| 기준 | Redis | Memcached | KeyDB |
|------|-------|-----------|-------|
| 자료구조 | String, Hash, List, Set, Sorted Set, Stream | String만 | Redis 호환 |
| 원자적 카운터 | INCR — 싱글스레드라 락 불필요 | incr 지원하지만 자료구조 제한 | 멀티스레드 INCR |
| Pub/Sub & Stream | Redis Streams — 이벤트 버스 역할 | 없음 | 지원 |
| AWS 매니지드 | ElastiCache for Redis | ElastiCache for Memcached | 직접 운영 |

**선택 이유:** 캐시 + 카운터 + 이벤트 버스 + 멱등성 키 저장을 하나로 해결. Memcached는 순수 캐시만 가능해서 별도 시스템 필요. KeyDB는 AWS 매니지드 없음.

**Redis의 3가지 역할:**

1. **읽기 캐시** (Cache-Aside 패턴)
   - 캐시 확인 → 히트면 0.1ms 반환 / 미스면 DB 조회 → 캐시 저장
   - 쓰기 시 이벤트로 캐시 무효화

2. **원자적 카운터** (조회수/좋아요)
   - Redis INCR는 싱글스레드 → 락 불필요, 원자적
   - DB UPDATE는 row lock 발생 → 1000명 동시 좋아요 시 병목
   - Redis 카운터(성능)와 DB 제약조건(정합성)은 별개 — 보완 관계
   - 주기적으로 GETSET으로 값 읽고 초기화 → DB에 벌크 동기화

3. **멱등성 키 저장**
   - SET NX EX (없을 때만 저장 + TTL) → 중복 요청 차단
   - Redis(1차 빠른 체크) + DB(2차 안전장치) 이중 검증

**병목 지점:**

1. **Cache Stampede** — 인기 게시글 캐시 만료 시 수천 요청이 동시 DB 접근
   - 해결: 분산 락(SETNX) 또는 Stale-While-Revalidate

2. **메모리 부족** — 100만 게시글 전부 캐시 불가
   - 해결: LRU eviction + TTL + 핫 데이터만 캐시

3. **카운터-DB 동기화 유실** — Redis 장애 시 미동기화 카운터 유실
   - 해결: AOF 영속성 + 동기화 주기 조절

4. **Hot Key 집중** — 인기 게시글 싱글스레드 한계
   - 해결: L1(로컬 인메모리) + L2(Redis) 2단 캐시

**학습 포인트:**
- 싱글스레드 모델: Redis INCR vs PG UPDATE count=count+1 동시 1000회 정확도 비교
- 캐시 전략: Cache-Aside vs Write-Through vs Write-Behind 각각의 히트율/정합성 차이
- Eviction 정책: LRU vs LFU, PG(Clock-sweep) vs MySQL(LRU 변형) 비교
- 분산 락: Redis SETNX vs PG Advisory Lock 성능/안정성 비교

---

### 3.3 이벤트 버스 — Redis Streams + CQRS

**왜 CQRS인가?**

읽기 99% / 쓰기 1%인데 같이 스케일링하면 비효율. 분리하면:
- 읽기: 캐시 최적화, 20대 스케일
- 쓰기: 정합성 최적화, 2대면 충분
- 쓰기 장애 시에도 읽기는 정상

**왜 Redis Streams인가? (vs Kafka, SQS, RabbitMQ)**

| 기준 | Redis Streams | Kafka | SQS | RabbitMQ |
|------|-------------|-------|-----|----------|
| 처리량 | ~100만 msg/s | ~수백만 msg/s | ~3000 msg/s (FIFO) | ~50,000 msg/s |
| 추가 인프라 | 불필요 (Redis 재활용) | Kafka + ZooKeeper | 없음 (AWS) | 별도 서버 |
| 비용 (AWS) | $0 추가 | MSK 최소 $200+/월 | 요청당 과금 | EC2 비용 |
| 로컬 개발 | Docker Redis 하나 | Docker 3개+ (무거움) | LocalStack | Docker 1개 |

**선택 이유:** 이미 Redis를 쓰므로 추가 비용 $0. Consumer Group 지원. Kafka는 처리량이 더 높지만 클러스터 운영 비용이 큼. $100 예산에서는 Redis Streams가 최적.

**FastAPI async와 이벤트 버스의 차이:**
- FastAPI async: 한 서버 안에서 I/O 대기 시간을 효율적으로 쓰는 것. 모든 작업이 끝나야 응답
- 이벤트 버스: 시스템 간에 작업을 분리. DB 저장만 동기, 나머지(캐시 갱신, 알림)는 비동기
- 둘 다 사용: async로 서버 효율, 이벤트 버스로 작업 분리

**이벤트 흐름 상세:**

게시글 작성:
```
1. Command: DB INSERT (동기) → 200 OK 응답
2. Command: XADD events post.created {id, title, author}
3. Consumer A: 게시글 캐시 저장
4. Consumer B: 목록 캐시 무효화
5. Consumer C: 조회수 카운터 초기화
```

좋아요:
```
1. Command: DB INSERT likes (UNIQUE 제약) → 200 OK
2. Command: Redis INCR post:{id}:likes
3. Command: XADD events post.liked {post_id, user_id}
4. Consumer: 게시글 캐시 좋아요 수 갱신
```

카운터 동기화 (30초마다):
```
1. Redis GETSET post:{id}:views 0 (값 읽고 초기화, 원자적)
2. DB UPDATE posts SET view_count = view_count + {delta} (벌크)
```

**병목 지점:**
1. Consumer 처리 지연 — XLEN으로 스트림 길이 모니터링
2. 이벤트 유실 — XPENDING/XCLAIM으로 미처리 이벤트 재할당
3. 캐시 정합성 지연 — Write-후-Read 보장 패턴 (작성자는 즉시 최신)
4. 이벤트 순서 — 같은 게시글 이벤트는 같은 Consumer로 라우팅

**학습 포인트:**
- CQRS: 동일 API를 일반 CRUD vs CQRS로 구현, p99 응답시간 비교
- Eventual Consistency: PG(Strong) vs CQRS+캐시(Eventual) vs MongoDB replica 비교
- Consumer Group: Redis Streams vs Kafka vs SQS의 이벤트 분배 방식 차이
- 멱등한 Consumer: at-least-once(Redis Streams) vs exactly-once(Kafka) 트레이드오프

---

### 3.4 멱등성 + 동시성 제어

**멱등성 — 같은 요청을 N번 보내도 결과는 1번과 동일**

구현 흐름 (2단계 검증):
```
1. Redis GET idempotency:{key} → 있으면 캐시된 응답 반환 (0.1ms)
2. Redis SET idempotency:{key} "processing" NX EX 30 → 못 잡으면 409 Conflict
3. 실제 비즈니스 로직 수행 (DB INSERT 등)
4. Redis SET idempotency:{key} {response} EX 86400 (24시간 TTL)
5. DB INSERT idempotency_keys ON CONFLICT DO NOTHING (2차 안전장치)
```

Redis 실패 대비: DB INSERT 성공 후에만 Redis에 최종 결과 저장. 실패 시 Redis 키 삭제.

**동시성 제어 — 기능별 전략**

| 기능 | 동시성 전략 | 멱등성 | 이유 |
|------|-----------|--------|------|
| 게시글 작성 | 불필요 | 멱등성 키 | 각자 다른 글을 씀 |
| 게시글 수정 | 낙관적 락 (version) | 멱등성 키 | 동시 수정 드묾, 충돌 시 재시도 |
| 게시글 삭제 | 비관적 락 (FOR UPDATE) | 자연 멱등 | 되돌리기 어려움, 안전 우선 |
| 좋아요 | 원자적 + UNIQUE | DB UNIQUE | Redis INCR + DB UNIQUE(user,post) |
| 조회수 | 원자적 | 불필요 | Redis INCR, 중복 허용 |
| 댓글 작성 | 불필요 | 멱등성 키 | 게시글 작성과 동일 패턴 |

**병목 지점:**
1. 낙관적 락 재시도 폭풍 — 지수 백오프 + 최대 재시도 제한
2. 멱등성 키 저장소 비대 — 적절한 TTL + 쓰기만 멱등성 키
3. 비관적 락 데드락 — 항상 같은 순서로 락 획득 + 타임아웃
4. Redis-DB 멱등성 불일치 — DB 성공 후에만 Redis 최종 저장

**학습 포인트:**
- 낙관적/비관적 락: PG vs MySQL(갭 락 확대) vs MongoDB(findOneAndUpdate) 비교
- 격리 수준: PG(Read Committed 기본) vs MySQL(Repeatable Read 기본) 차이로 인한 결과 차이
- 멱등성 패턴: Stripe API Idempotency-Key 방식 차용. 네트워크 장애 시뮬레이션으로 중복 발생 확인

---

### 3.5 이미지 업로드 — S3 + CloudFront (로컬: MinIO)

**왜 Presigned URL 직접 업로드인가?**

서버 경유: 1000명 × 2MB = 2GB 메모리 점유 → 서버 폭발
Presigned URL: 서버는 URL 발급만 (1ms), 클라이언트 → S3 직접 업로드 → 서버 부하 0

**전체 흐름:**
```
1. Client → API: POST /uploads/presign {filename, size}
2. API: 파일 크기/타입 검증 → Presigned PUT URL 생성 (5분 유효)
3. Client → S3 직접 PUT
4. Client → API: POST /posts {title, content, image_ids}
5. API: S3 파일 존재 확인 → tmp/ → images/ 이동
6. 서빙: Client → CloudFront → S3 (캐시 히트면 S3 안 감)
```

**실패 시나리오 대응:**
- 업로드 실패 → Presigned URL 만료 전까지 재시도 가능. 만료 후 새 URL 발급
- 업로드 성공 + 게시글 작성 실패 → tmp/ 경로 Lifecycle Rule 24시간 자동 삭제
- 중복 업로드 → 같은 URL은 덮어쓰기, 다른 URL은 고아 이미지 → 자동 삭제

**로컬: MinIO** — S3 API 100% 호환, Docker 한 줄, 코드 변경 없이 로컬/클라우드 전환

**병목 지점:**
1. 고아 이미지 누적 — S3 Lifecycle Rule
2. 대용량 타임아웃 — Multipart Upload
3. CDN 캐시 무효화 지연 — URL에 버전 해시 포함
4. 악성 파일 — Presigned URL에 Content-Length/Type 조건 + MIME 검증

**학습 포인트:**
- Presigned URL: AWS(Presigned) vs GCP(Signed URL) vs Azure(SAS Token) 비교
- CDN: CloudFront vs Cloudflare vs Fastly 비교
- 스토리지 타입: Object(S3) vs Block(EBS) vs File(EFS) 용도별 차이

---

### 3.6 컨테이너 & 배포 — ECS Fargate

**왜 ECS Fargate인가? (vs EKS, Lambda, EC2)**

| 기준 | ECS Fargate | EKS | Lambda | EC2 |
|------|------------|-----|--------|-----|
| 관리 복잡도 | 낮음 | 높음 | 없음 | 높음 |
| 비용 ($100 예산) | ~$15 | $73/월 (컨트롤 플레인만) | Free Tier | Spot ~$10 |
| CQRS 독립 스케일링 | 서비스별 태스크 수 조절 | Deployment별 HPA | 함수별 독립 | ASG 분리 |

**선택 이유:** EKS는 컨트롤 플레인만 $73/월로 예산 초과. Lambda는 Cold Start + CQRS 구조 부적합. Fargate는 서버 관리 없이 Command/Query 독립 스케일링 가능 + 비용 효율적.

**개발/배포 경로:**
1. **로컬 ($0)** — Docker Compose: FastAPI(Command+Query) + PostgreSQL + Redis + MinIO + Prometheus + Grafana
2. **클라우드 단일 (~$20)** — ECS Fargate 1태스크 + RDS Free Tier + ElastiCache + S3
3. **클라우드 스케일 (~$30)** — Command 2태스크 + Query 5태스크 + ALB + 오토스케일링 + k6 분산 부하

**병목 지점:**
1. 스케일아웃 속도 (30-60초) — 최소 태스크 수 여유 + 예측 스케일링
2. 세션/상태 의존성 — Stateless 설계, 모든 상태는 Redis/DB에
3. Health Check 악순환 — 전용 경량 엔드포인트 + 타임아웃 설정
4. 배포 중 다운타임 — Rolling Update + Graceful Shutdown

**학습 포인트:**
- ECS vs EKS: Task Definition vs K8s Deployment YAML 비교
- 배포 전략: Rolling vs Blue/Green vs Canary 트레이드오프
- Stateless 원칙: 로컬 변수 상태 → 태스크 2개에서 불일치 → Redis 이전 후 일관성 확인

---

### 3.7 모니터링 + 부하테스트

**Observability 4축:**

1. **메트릭 (Prometheus + Grafana)** — RPS, p50/p95/p99, 에러율, 캐시 히트율, DB 커넥션, Redis 메모리
   - Pull 방식: 대상이 죽어도 "응답 없음" 감지 가능 (Push는 못 감지할 수 있음)

2. **분산 추적 (Jaeger / OpenTelemetry)** — 요청의 전체 경로 시각화, 구간별 소요시간
   - CQRS는 경로가 복잡 → 메트릭만으로는 병목 위치 특정 어려움

3. **로그 (로컬: Loki + Grafana, 클라우드: ELK)** — 구조화 JSON 로그, 에러 스택트레이스, 멱등성 중복 로그
   - 로컬에서 ELK는 무거움 → Loki가 경량 대안

4. **알림 (Grafana Alerting)** — 에러율 >1%, p99 >1초, DB 커넥션 >80%, Redis 메모리 >90%

**부하테스트 도구 — k6 (주) + Locust (보조)**

k6 선택 이유: Go 기반 ~30,000 RPS (Locust의 6배) + Prometheus/Grafana 네이티브 연동 + 복잡한 시나리오 가능. Locust는 Python 모델 재사용하는 통합 테스트에 보조로 사용.

**6단계 테스트 시나리오:**

| 단계 | 시나리오 | 목표 RPS | 측정 포인트 |
|------|---------|---------|-----------|
| Smoke | 1-5 VU, 1분 | ~10 | 에러 0%, 기준선 설정 |
| Load | 50→200 VU, 10분 | ~1,000 | p95 < 200ms 유지, 캐시 히트율 |
| Stress | 200→1000 VU | ~5,000 | 어디서 먼저 터지는가? |
| Spike | 10→1000 VU 갑자기 | ~10,000 | 복구 시간, 에러율 스파이크 |
| Soak | 200 VU, 30분 | ~1,000 | 메모리/커넥션 누수, 성능 저하 |
| Chaos | Load + 장애 주입 | ~1,000 | 복구 시간, Graceful Degradation |

**카오스 엔지니어링 (로컬, $0):**

| 장애 시나리오 | 주입 방법 | 확인 포인트 |
|-------------|---------|-----------|
| Redis 다운 | `docker stop redis` | 캐시 미스 → DB 폴백? 복구 후 재적재? |
| DB 연결 끊김 | `docker pause postgres` | 읽기는 캐시로 서빙? 재연결? |
| API 인스턴스 죽음 | `docker stop api-command-1` | 다른 인스턴스로 라우팅? 멱등성? |
| 네트워크 지연 | Toxiproxy | 타임아웃? Circuit Breaker? |
| 디스크 Full | MinIO 용량 제한 | 업로드 실패 에러 처리? |

**학습 포인트:**
- 메트릭 수집: Pull(Prometheus) vs Push(Datadog/CloudWatch) 트레이드오프
- 백분위수: 평균은 무의미. p50/p95/p99로 실제 사용자 경험 파악
- Circuit Breaker: 외부 서비스 장애 시 빠르게 실패 → 시스템 전체 보호

---

## 4. 비용 전략 ($100 이하)

### 핵심 전략
"100만 RPS용으로 설계하고, 패턴이 맞는지를 증명한다."
1,000 RPS에서 터지는 병목은 100만 RPS에서도 동일. 패턴이 맞는지를 소규모에서 검증.

### 4단계 실행

| Phase | 내용 | 비용 |
|-------|------|------|
| Phase 1 | 로컬 개발 + 단위/통합 테스트 (Docker Compose) | $0 |
| Phase 2 | 로컬 부하 테스트 (k6, 100만 시드 데이터) | $0 |
| Phase 3 | AWS 소규모 검증 (ECS + RDS + ElastiCache, 2-3일) | ~$30-50 |
| Phase 4 | 카오스 + 버스트 테스트 (Spot Instance, 30분-1시간) | ~$20-40 |

### 비용 상세

| 항목 | 예상 비용 | 비고 |
|------|---------|------|
| Phase 1-2 (로컬) | $0 | Docker 기반 |
| EC2 Spot (Phase 3-4) | ~$15 | t3.medium × 8대 × 수시간 |
| RDS PostgreSQL | $0 | Free Tier (신규 계정) |
| ElastiCache Redis | ~$5 | t3.micro, 2-3일 |
| ALB | ~$5 | 수일 |
| S3 + 데이터 전송 | ~$3 | 테스트 이미지 소량 |
| 예비 | ~$15 | 버퍼 |
| **합계** | **~$43 (최대 ~$70)** | |

---

## 5. 기술 스택 요약

| 역할 | 기술 | 로컬 대체 |
|------|------|----------|
| 프레임워크 | FastAPI (Python) | - |
| 데이터베이스 | PostgreSQL | Docker PostgreSQL |
| 캐시/카운터/멱등성 | Redis | Docker Redis |
| 이벤트 버스 | Redis Streams | Docker Redis |
| 이미지 저장 | S3 + CloudFront | MinIO |
| 컨테이너 | ECS Fargate | Docker Compose |
| 로드밸런서 | ALB | Nginx (Docker) |
| 모니터링 | Prometheus + Grafana | Docker |
| 분산 추적 | Jaeger (OpenTelemetry) | Docker |
| 로그 | Loki (로컬) / ELK (클라우드) | Docker Loki |
| 부하 테스트 | k6 (주) + Locust (보조) | 로컬 설치 |
| IaC | Terraform | - |

---

## 6. 점진적 병목 테스트 맵

모든 테스트는 "컴포넌트 구현 직후" 수행. "다 만들고 나서 테스트" 금지.

| 구현 단계 | 테스트 항목 | 도구 |
|----------|-----------|------|
| CRUD 구현 | 커넥션 풀, 쿼리 성능 | k6 + EXPLAIN ANALYZE |
| 캐시 적용 | Cache Stampede, 히트율, 메모리 | k6 + Redis INFO |
| 카운터 구현 | DB만 vs Redis 비교, Hot Row | k6 + pg_stat |
| 이벤트 시스템 | Consumer 지연, 이벤트 유실 | k6 + XLEN/XPENDING |
| 멱등성 | 중복 요청, 네트워크 장애 시뮬 | k6 + 응답 드롭 |
| 동시성 제어 | 낙관적/비관적 락 경합 | k6 + pg_locks |
| 이미지 업로드 | 고아 이미지, 대용량 타임아웃 | k6 + S3 모니터링 |
| 전체 통합 | Stress/Spike/Soak/Chaos | k6 + Grafana 풀 스택 |
