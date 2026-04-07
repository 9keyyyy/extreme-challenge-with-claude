# Extreme Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 극한 트래픽 게시판 백엔드를 "문제 체감 → 개선 → 측정" 학습 루프로 구현

**Architecture:** Monolith + CQRS, PostgreSQL + Redis + MinIO(S3), Docker Compose 로컬 개발

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy 2.0 (async), asyncpg, redis.asyncio, k6, Prometheus, Grafana

---

## 학습 로드맵

| Phase | 파일 | 학습 내용 | 핵심 체감 |
|-------|------|---------|----------|
| 1 | [phase-01-foundation.md](phases/phase-01-foundation.md) | FastAPI + Docker + CRUD 기본 | 동작하는 API 기준선 |
| 2 | [phase-02-bottleneck.md](phases/phase-02-bottleneck.md) | 100만 데이터 병목 체감 | "OFFSET이 이렇게 느리구나" |
| 3 | [phase-03-db-optimization.md](phases/phase-03-db-optimization.md) | 인덱스 + 커서 페이지네이션 | "인덱스만으로 100배 차이" |
| 4 | [phase-04-redis-cache.md](phases/phase-04-redis-cache.md) | Redis Cache-Aside + Stampede | "캐시 히트 0.1ms vs 미스 50ms" |
| 5 | [phase-05-redis-counter.md](phases/phase-05-redis-counter.md) | DB 카운터 → Redis 카운터 | "DB 락 vs Redis INCR" |
| 6 | [phase-06-idempotency.md](phases/phase-06-idempotency.md) | 멱등성 키 + 중복 방지 | "재시도해도 데이터 안 꼬임" |
| 7 | [phase-07-cqrs-events.md](phases/phase-07-cqrs-events.md) | CQRS + Redis Streams | "비동기 분리로 응답 가속" |
| 8 | [phase-08-image-upload.md](phases/phase-08-image-upload.md) | Presigned URL 직접 업로드 | "서버 메모리 0" |
| 9 | [phase-09-monitoring.md](phases/phase-09-monitoring.md) | Prometheus + Grafana + Jaeger | "실시간 병목 시각화" |
| 10 | [phase-10-load-testing.md](phases/phase-10-load-testing.md) | k6 6단계 부하 테스트 | "어디서 먼저 터지는지" |
| 11 | [phase-11-chaos.md](phases/phase-11-chaos.md) | 카오스 엔지니어링 | "장애에도 서비스 유지" |
| 12 | [phase-12-cloud.md](phases/phase-12-cloud.md) | AWS ECS Fargate 배포 | "수평 확장 실제 동작" |

---

## 진행 방법

1. **Phase 순서대로 진행** — 각 Phase는 이전 Phase에 의존함
2. **각 Phase의 "학습" 섹션 먼저 읽기** — 왜 이걸 하는지 이해한 후 구현
3. **측정 → 개선 → 재측정** — 모든 개선은 Before/After 수치로 비교
4. **Phase 1-9는 비용 $0** (전부 로컬), Phase 10-12에서 선택적으로 AWS 사용

## 파일 구조

```
extreme-challenge-with-claude/
├── docker-compose.yml              # PG, Redis, MinIO, App
├── docker-compose.monitoring.yml   # Prometheus, Grafana, Jaeger, Loki
├── Dockerfile
├── pyproject.toml
├── alembic/                        # DB 마이그레이션
├── src/
│   ├── main.py                     # FastAPI 앱 진입점
│   ├── config.py                   # 환경 설정
│   ├── database.py                 # DB 엔진, 세션
│   ├── redis_client.py             # Redis 연결
│   ├── models/                     # SQLAlchemy 모델
│   ├── schemas/                    # Pydantic 스키마
│   ├── api/
│   │   ├── command/                # 쓰기 API (CQRS Command)
│   │   └── query/                  # 읽기 API (CQRS Query)
│   ├── services/                   # 비즈니스 로직
│   ├── workers/                    # 이벤트 Consumer, 카운터 동기화
│   └── middleware/                 # 멱등성, 트레이싱
├── tests/
├── loadtest/                       # k6 시나리오
├── monitoring/                     # Prometheus, Grafana 설정
├── scripts/                        # 시드, 벤치마크
└── infra/                          # AWS IaC (Terraform)
```
