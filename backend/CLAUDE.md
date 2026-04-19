# Backend CLAUDE.md

## 프로젝트 개요

극한 트래픽 게시판 백엔드. FastAPI + SQLAlchemy async + PostgreSQL.
Phase별로 점진적 최적화하며 차이를 체감하는 학습 프로젝트.

## 명령어

```bash
# 의존성 (uv 사용, pip 아님)
uv sync
uv add <package>

# 서버 실행
docker compose up -d
uv run uvicorn src.main:app --reload

# 테스트
uv run pytest tests/ -v

# 마이그레이션
uv run alembic revision --autogenerate -m "설명"
uv run alembic upgrade head
```

## 아키텍처

```
Router (api/) → Service (services/) → Repository (repositories/) → DB
```

- **Router**: HTTP 요청/응답 변환, 상태코드. Service만 호출
- **Service**: 비즈니스 로직. Repository만 호출. **SQLAlchemy import 금지**
- **Repository**: DB 쿼리. AsyncSession을 DI로 주입받음

DI 체인: `get_db() → Repository(db) → Service(repo) → Router(service)`

## 코드 컨벤션

### 주석
- 주석은 적극적으로 작성 — 학습 프로젝트이므로 코드 이해를 돕는 주석 환영
- 단, 코드를 그대로 반복하는 WHAT 주석은 피할 것 (예: `# 댓글 삭제` on `delete()`)
- 설계 결정 이유, 대안과의 비교, 의도적 트레이드오프, 비자명한 동작 설명 등이 좋은 주석

### 네이밍
- Repository 변수명은 도메인 명시: `post_repo`, `comment_repo`, `like_repo` (단순 `repo` 금지)

## DB 규칙

### FK 제약
- 모델 코드에서 `ForeignKey`는 ORM 관계 표현용으로 유지
- **실제 DB에는 FK 제약 안 걸음** — 대규모 트래픽에서 락/데드락/샤딩 제약 원인
- Alembic `env.py`의 `include_object` + `process_revision_directives` 훅으로 자동 제외
- 참조 무결성은 Service 레벨에서 `exists()` 체크로 처리

### 마이그레이션
- 모델 수정 후 반드시 `alembic revision --autogenerate` 실행
- 생성된 파일에서 FK 제약이 빠졌는지 확인 (`grep ForeignKey`)
- 테스트는 `create_all` 사용 (Alembic 안 거침) — 모델 코드 기준으로 즉시 반영

## 테스트

- 전체 통합 테스트 (실제 DB 사용, mock 없음)
- SAVEPOINT rollback으로 테스트 간 데이터 격리
- `extreme_board_test` DB 사용 (docker/init-test-db.sql이 생성)
- 테스트 docstring/주석 불필요 — 함수명이 의도를 설명

## 예외 처리

- `BaseAppException` 상속 → `status_code` + `default_msg` 클래스 변수
- 글로벌 핸들러가 자동으로 HTTP 응답 변환 — Router에서 try/except 불필요
- 도메인별 예외는 각 Service 파일에 정의
