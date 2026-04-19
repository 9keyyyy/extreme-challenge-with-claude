# Distributed Consistency Design — 기존 Phase에 분산 정합성 추가

**Goal:** 단일 인스턴스 기준으로 설계된 Phase 4~11에 멀티 인스턴스 분산 정합성 시나리오를 추가하여, 대규모 분산 환경에서 발생하는 문제를 직접 체감하고 해결하는 학습 경험 제공

**동기:** 현재 계획은 API 1대 + PG 1대 + Redis 1대 기준. 실제 프로덕션은 멀티 인스턴스이고, 단일에서 동작하는 코드가 멀티에서 깨지는 케이스가 핵심 학습 포인트. 특히 커머스 환경(재고, 결제, 주문)에서 정합성 문제는 돈과 직결됨.

**원칙:**
- 기존 Phase 학습 흐름을 유지하되, 각 Phase에서 만든 기능을 멀티 인스턴스에서 검증하는 Task를 추가
- 모든 선택지에 대해 "왜 이걸 골랐는지, 다른 건 왜 안 되는지" 트레이드오프를 명시
- 커머스 도메인에서 동일한 메커니즘이 어떻게 쓰이는지 매핑

---

## 우선순위 (대규모 환경 백엔드 역량 기준)

### Tier 1 — 모르면 프로덕션에서 사고

1. **동시 쓰기 경합** — 카운터 부정확, 재고 마이너스, 중복 주문
2. **캐시-DB 불일치** — "데이터가 이상해요" 신고의 절반
3. **Consumer 중복 처리** — at-least-once에서 중복은 반드시 발생

### Tier 2 — 시니어 필수

4. **Replication Lag** — DB 스케일아웃하면 즉시 발생
5. **분산 락 한계** — 실패 모드를 아는 것이 핵심
6. **Distributed Transaction (Outbox)** — 이 문제를 인식하는 것 자체가 시니어 경계선

### Tier 3 — 인프라 깊이

7. **Redis Failover 중 데이터 유실** — write 유실 메커니즘 이해

---

## Phase별 추가 내용

### Phase 4: Redis 캐시 — 변경 없음

기존 내용 그대로. 캐시 구현에 집중.

---

### Phase 4.5 (신규): 멀티 인스턴스 인프라 확장

**위치:** Phase 4와 Phase 5 사이

**학습 섹션:**
- 왜 멀티 인스턴스가 필요한가 — SPOF(Single Point of Failure) 제거, 수평 확장의 전제 조건
- Nginx L7 LB 원리 — round-robin, health check, upstream 설정
- Redis Sentinel 원리 — 모니터링 + 자동 failover, quorum 투표 방식, failover 중 write 유실 가능성
- PG replica는 여기서 안 만듦 — Phase 7(CQRS, 읽기/쓰기 분리)에서 도입이 자연스러움

**LB 선택지 비교:**

| 선택지 | 장점 | 단점 | 판정 |
|--------|------|------|------|
| Nginx (L7) | 설정 단순, health check 내장, 로컬에서 가벼움 | L7이라 TCP 레벨 제어 안 됨 | **선택** — 로컬 개발에서 가장 현실적 |
| HAProxy | L4/L7 둘 다 가능, 성능 우수 | 설정이 Nginx보다 복잡 | 이 프로젝트 목적(학습)에 오버스펙 |
| Traefik | Docker 네이티브, 자동 서비스 디스커버리 | 학습 곡선, 컨테이너 레이블 기반 설정 | LB 자체 학습이 목적이 아님 |

**Redis HA 선택지 비교:**

| 선택지 | 장점 | 단점 | 판정 |
|--------|------|------|------|
| Redis Sentinel | 자동 failover, 모니터링 내장, 설정 간단 | 샤딩 없음(단일 마스터), failover 중 write 유실 가능 | **선택** — 데이터 크기에 샤딩 불필요. failover 유실 자체가 학습 대상 |
| Redis Cluster | 샤딩 내장, 수평 확장 | 최소 6노드, cross-slot 연산 제한, 로컬에서 무거움 | 오버스펙, 로컬 리소스 부담 |
| Redis 단일 + AOF | 가장 단순, 리소스 최소 | SPOF, failover 없음 | 장애 시나리오 테스트 불가 |

**구현:**
- `docker-compose.distributed.yml` 생성 (compose profile 활용)
  - `--profile core`: API 3대 + Nginx LB + Redis primary + Redis replica + Sentinel 3대
  - `--profile replica`: + PG primary + PG replica (Phase 7에서 활성화)
  - `--profile monitoring`: + Prometheus + Grafana + Jaeger (Phase 9에서 활성화)
- 기존 `docker-compose.yml` 유지 (단일 환경 빠른 개발용)
- 검증: Nginx 통해 요청이 3대 서버에 분산되는지, Sentinel이 Redis 상태 모니터링하는지 확인

---

### Phase 5 추가: 멀티 인스턴스 카운터 정합성

**학습 섹션 추가:**
- Lost Update 문제 — 앱 레벨 read-modify-write 패턴이 멀티 인스턴스에서 깨지는 메커니즘. DB 레벨 `count = count + 1`은 row lock이 직렬화해주니까 정확하지만, 앱에서 read→+1→write 하면 깨짐
- Redis INCR의 멀티 인스턴스 안전성 — 싱글스레드라 서버 몇 대든 원자적. 하지만 Redis→DB 동기화 과정에서 숫자가 어긋날 수 있음
- 커머스 매핑: 좋아요 카운터 = 재고 차감과 동일한 동시성 문제. 재고 100개인데 200명이 동시에 사면 오버셀링

**카운터/동시 차감 방법 비교:**

| 선택지 | 적합한 상황 | 부적합한 상황 |
|--------|-----------|-------------|
| DB `count = count + 1` | 쓰기 빈도 낮고 정합성 절대적 (결제 금액) | 동시 요청 많으면 lock wait → 커넥션 풀 고갈 |
| Redis INCR | 단순 증감, 조건 분기 없음 (좋아요 +1) | 조건부 연산 (0 이하면 거부) 불가 |
| Redis Lua script | 조건부 원자적 연산 (재고: 0 이상일 때만 -1) | 스크립트 복잡하면 Redis 전체 블로킹. 단순 증감에는 오버스펙 |
| Optimistic Locking (DB) | 충돌 빈도 낮은 쓰기 (프로필 수정) | 충돌 빈도 높으면 재시도 폭발 (인기글 좋아요) |
| CAS (WATCH+MULTI) | Redis에서 optimistic locking 필요할 때 | 충돌 많으면 INCR보다 느림. 대부분 Lua가 나음 |

**추가 Task: 멀티 인스턴스 카운터 정합성 검증**
- Step 1: k6로 Nginx 통해 동시 좋아요 1000건 → Redis INCR 기반 → 최종값 정확히 1000 확인
- Step 2: non-atomic GET→+1→SET anti-pattern → 1000보다 적은 값 나옴 확인
- Step 3: Lua script로 조건부 차감 — "재고 시뮬레이션: 100개 한정, 200명 동시 요청 → 정확히 100명만 성공"
- Step 4: Redis→DB 동기화 중 Redis pause → 카운터 유실 → DB를 source of truth로 복구

---

### Phase 6 추가: 분산 락 한계 + 멀티 인스턴스 멱등성

**학습 섹션 추가:**
- 분산 락의 실패 모드 — TTL 만료, 네트워크 파티션, clock drift
- "언제 Fencing Token이 필요하고 언제 불필요한지" 판단법 — downstream이 DB(unique constraint 가능)면 불필요, 외부 API면 필요. 이 판단이 진짜 학습 포인트
- Redlock 논쟁 요약 — Kleppmann: "비동기 시스템에서 clock 가정은 위험, fencing token이 답", Antirez: "현실 시스템에서 clock drift는 충분히 작음". 핵심: 은탄환은 없고 트레이드오프를 이해하는 게 중요

**분산 락 보호 방법 비교:**

| 선택지 | 적합한 상황 | 부적합한 상황 |
|--------|-----------|-------------|
| TTL 락 + DB unique constraint | downstream이 DB이고 자연적 멱등성 보장 가능 (UPSERT, ON CONFLICT) | 외부 API 호출처럼 멱등성 보장 수단이 없는 경우 |
| TTL 락 + Fencing Token | downstream이 외부 시스템 (결제 PG, 알림 API)이라 DB constraint로 못 막는 경우 | DB constraint로 충분한 경우 — 오버엔지니어링 |
| Redlock | Redis 단일 장애점이 허용 안 되는 극한 경우 | 노드 5대 필요 + clock drift 문제. 대부분 불필요 |
| DB Advisory Lock | Redis 없이 DB만으로 락 필요한 경우 | Redis가 이미 있으면 느린 DB 락을 쓸 이유 없음 |

**추가 Task: 분산 락 한계 체험 + 판단 학습**
- Step 1: 현재 구현(TTL + DB unique constraint)이 멀티 인스턴스에서 동작 확인 — Nginx 통해 같은 멱등성 키 100건 동시 전송 → 정확히 1건만 생성
- Step 2: TTL 만료 시나리오 재현 — `sleep(35)` 삽입 → TTL 만료 → 서버 B 진입 → BUT DB ON CONFLICT DO NOTHING이 막음 → "DB constraint가 2차 안전망" 체감
- Step 3: DB constraint가 없는 상황 시뮬레이션 — 외부 HTTP 호출(mock 알림 API)에 대해 TTL 만료 시 이중 호출 발생 확인
- Step 4: Fencing Token 구현 — 락 획득 시 단조증가 토큰 발급 → 외부 API 호출 시 토큰 포함 → mock API가 구 토큰 요청 거부

**핵심 체감:**
- DB downstream: Fencing Token 없이도 unique constraint가 막음 → 오버엔지니어링 하지 말 것
- 외부 API downstream: Fencing Token 없으면 이중 호출 → 필요한 곳에만 쓸 것
- "항상 최강 도구를 쓰는 게 아니라, 상황에 맞는 도구를 고르는 게 시니어"

---

### Phase 7 추가: Consumer 멱등성 + PG Replica + Read-Your-Write

**학습 섹션 추가:**
- Consumer 중복 처리가 불가피한 이유 — ACK 전에 죽으면 재처리. at-least-once의 본질
- PG Streaming Replication 원리 — WAL 전송, primary/replica 구조, replication lag이 생기는 이유
- Read-Your-Write Consistency — 쓴 사람만 primary에서 읽고, 나머지는 replica. "내가 수정한 건 바로 보여야 하지만, 남이 수정한 건 잠깐 구버전이어도 괜찮다"
- 커머스 매핑: 주문 후 "내 주문 내역"에 안 보이면 고객 패닉 → read-your-write 필수

**PG Replication 선택지 비교:**

| 선택지 | 장점 | 단점 | 판정 |
|--------|------|------|------|
| Streaming Replication | PG 내장, 추가 도구 불필요, 바이트 레벨 복제 | replica는 읽기 전용, failover 수동 | **선택** — 가장 기본적, 개념 학습에 적합 |
| Logical Replication | 테이블 단위 선택적 복제, 버전 달라도 됨 | 설정 복잡, DDL 안 따라감 | 전체 DB 복제라 불필요 |
| Patroni + etcd | 자동 failover, HA 클러스터 | 컨테이너 3개 추가, 복잡도 높음 | 학습 가치 있지만 리소스 과함 |

**Consumer 중복 방지 비교:**

| 선택지 | 적합한 상황 | 부적합한 상황 |
|--------|-----------|-------------|
| 멱등한 핸들러 설계 | 연산 자체가 멱등 가능 (캐시 삭제, UPSERT) | 자연적 멱등성이 없는 연산 (외부 API, 이메일) |
| 처리 이력 테이블 | 멱등 설계가 어렵고 exactly-once 필요 | 모든 이벤트마다 DB 조회 — 처리량 병목 |

**Read-Your-Write 구현 비교:**

| 선택지 | 적합한 상황 | 부적합한 상황 |
|--------|-----------|-------------|
| 쓴 사람은 primary 읽기 (쿠키 `last_write_at`) | 가장 실용적, 구현 간단 | write 빈도 극단적이면 primary 부하 집중 |
| Synchronous Replication | lag 0 보장 절대적 필요 (결제) | write 성능 저하 심각, replica 다운 시 primary 멈춤 |
| 캐시로 우회 | 이미 캐시 계층 있는 경우 보조 수단 | 캐시 무효화 타이밍 문제가 또 생김 |

**추가 Task들:**

**Task A: Consumer 중복 처리 체험**
- Step 1: Consumer 2대 실행 → Consumer Group에서 메시지 분배 확인
- Step 2: Consumer A가 처리 후 ACK 전 강제 종료 → 재시작 후 재처리 확인
- Step 3: 멱등하지 않은 핸들러 → 카운터 이중 증가 확인
- Step 4: 멱등한 핸들러로 수정 → 재처리해도 결과 동일

**Task B: PG Replica + Read-Your-Write 라우팅**
- Step 1: `--profile replica` 활성화 → PG replica 동작 확인
- Step 2: Query API를 replica에서 읽도록 수정 (SQLAlchemy read/write 세션 분리)
- Step 3: write 직후 replica에서 read → 안 보이는 것 확인 (lag 체감)
- Step 4: read-your-write 미들웨어 구현 — 최근 write한 유저는 primary에서 read

**Task C: Eventual Consistency Lag 측정**
- Step 1: write 후 0ms/10ms/50ms/100ms 간격으로 replica read → 최신 데이터 보이는 비율 측정
- Step 2: 이벤트 Consumer 처리 지연 시 캐시 lag 변화 관찰

---

### Phase 10 추가: 부하 중 정합성 검증

구현은 없음. Phase 5~7에서 만든 것들을 부하 아래에서 검증만.

**추가 Task: 정합성 감사**
- Step 1: k6 mixed load를 Nginx 통해 실행 (멀티 인스턴스)
- Step 2: 테스트 후 정합성 감사 스크립트 구현 + 실행
  - Redis 카운터 == DB 카운터인지
  - 멱등성 키 기준 중복 없는지
  - 이벤트 미처리 건 없는지
- Step 3: Replication lag 추이 측정 — 부하 중 `pg_wal_lsn_diff()` 1초 간격 기록 → Grafana 시각화
- Step 4: read-your-write 라우팅이 부하 중에도 동작하는지 검증

---

### Phase 11 추가: Outbox Pattern + Redis Failover + 정합성 감사/복구

**학습 섹션 추가:**
- Outbox Pattern — DB 트랜잭션과 이벤트 발행의 원자성 보장. "DB에 커밋은 됐는데 이벤트 발행이 실패하면?" 에 대한 업계 표준 해법
- Redis failover 중 write 유실 메커니즘 — primary에 write → 죽음 → replica 승격 → 복제 안 된 write 유실
- 커머스 매핑: 주문 생성(DB) + 재고 차감 이벤트가 원자적이지 않으면 재고 불일치. 장애 후 재고 대사(reconciliation) 필수

**이벤트 발행 실패 보호 비교:**

| 선택지 | 적합한 상황 | 부적합한 상황 |
|--------|-----------|-------------|
| Outbox Pattern | DB + 이벤트 원자성 필요, 추가 인프라 최소 | 발행 지연(polling 간격) 허용 안 되는 실시간 시스템 |
| CDC (Debezium) | 앱 코드 변경 없이 DB WAL에서 이벤트 추출 | Kafka Connect + Debezium 인프라 필요, 로컬에서 무거움 |
| try/except + 로그 | 이벤트 유실이 비즈니스에 치명적이지 않은 경우 | 결제/주문처럼 유실 시 돈이 꼬이는 경우 |

**Redis failover 유실 대응 비교:**

| 선택지 | 적합한 상황 | 부적합한 상황 |
|--------|-----------|-------------|
| 유실 허용 + DB 기준 복구 배치 | 캐시/카운터처럼 DB에서 재구축 가능한 데이터 | DB에 원본 없는 데이터 (세션 등) |
| WAIT 명령 | 핵심 데이터 write에 선택적 적용 | 모든 write에 적용하면 지연 과다 |
| AOF everysec | 최대 1초분 유실로 제한, 보조 수단 | 완전 방지는 아님 |

**추가 Task들:**

**Task A: Outbox Pattern 구현**
- Step 1: 문제 재현 — 게시글 INSERT 성공 후 XADD 전에 프로세스 강제 종료 → 이벤트 유실 확인
- Step 2: `outbox_events` 테이블 생성 → DB 트랜잭션에서 게시글 + outbox 같이 커밋
- Step 3: Outbox Relay Worker — polling → Redis Streams 발행 → 발행 완료 row 상태 변경
- Step 4: 같은 시나리오 → 프로세스 죽어도 outbox에 이벤트 남아있음 확인

**Task B: Redis Failover Write 유실 확인**
- Step 1: k6로 지속 write → Redis primary `docker stop` → Sentinel이 replica 승격
- Step 2: 성공 응답 받은 write 수 vs Redis에 실제 남은 데이터 비교 → 차이 = 유실
- Step 3: WAIT 명령 적용 후 같은 시나리오 → 유실 감소 확인

**Task C: 장애 복구 후 정합성 감사/복구**
- Step 1: Phase 10에서 만든 감사 스크립트 재사용
- Step 2: Redis 장애 → 복구 → 감사 → 불일치 목록 출력
- Step 3: 자동 복구 — DB 기준으로 Redis 재동기화
- Step 4: DB 장애 → 복구 → 장애 중 Redis에만 쌓인 카운터를 DB에 반영

---

## Phase별 Compose Profile

| Phase | Profile | 컨테이너 수 |
|-------|---------|-----------|
| 1~4 | 기존 docker-compose.yml | ~5개 |
| 4.5~6 | `--profile core` | ~10개 (API 3 + Nginx + Redis Sentinel 3 + Redis 2) |
| 7~8 | core + `--profile replica` | ~12개 (+ PG primary/replica) |
| 9 | core + replica + `--profile monitoring` | ~15개 (+ Prometheus/Grafana/Jaeger) |
| 10~11 | `--profile full` (전부) | ~17개 |

## 커머스 매핑 요약

| Phase | 게시판 시나리오 | 커머스 동일 메커니즘 |
|-------|--------------|------------------|
| 5 | 동시 좋아요 1000건 → 카운터 정확성 | 재고 100개 동시 구매 → 오버셀링 방지 |
| 6 | 멱등성 키로 중복 생성 방지 | 결제 API 이중 청구 방지 |
| 6 | Fencing Token (외부 API) | PG사 이중 결제 호출 방지 |
| 7 | Consumer 중복 처리 방지 | 주문 이벤트 중복 소비 → 이중 배송 방지 |
| 7 | Read-Your-Write | 주문 후 "내 주문 내역" 즉시 노출 |
| 10 | 부하 중 데이터 정합성 검증 | 타임딜 트래픽에서 재고 정확성 |
| 11 | Outbox Pattern | 주문(DB) + 재고 차감 이벤트 원자성 |
| 11 | 장애 후 감사/복구 | 장애 후 재고 대사(reconciliation) |
