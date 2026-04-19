# Phase 8: 이미지 업로드 — Presigned URL 직접 업로드

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans

**전제:** Phase 7 완료.

**학습 키워드**
`Presigned URL` `S3 Signature v4` `Multipart Upload` `Content-Type Validation` `Object Storage vs Block Storage` `Lifecycle Rule` `CDN (CloudFront)` `MinIO` `boto3` `CORS Preflight`

---

## 학습: 왜 서버를 거치면 안 되는가

### 핵심 질문 — "파일 업로드를 어떻게 처리하셨나요?"

서버를 경유하는 방식은 대규모 트래픽에서 치명적임. Presigned URL로 클라이언트가 S3에 직접 올리는 게 맞고, 그 이유를 메모리 수치로 설명할 수 있어야 함.

> "서버를 경유하면 1000명이 2MB씩 동시 업로드할 때 2GB 메모리가 업로드 완료까지 물려있게 됨. Presigned URL을 쓰면 서버는 서명된 URL만 1ms에 발급하고 끝 — 실제 바이트는 클라이언트가 S3로 직접 보냄."

### 왜 서버 경유가 재앙인가 — 메모리 수학

```
[서버 경유 방식]
Client → API Server (파일 전체를 메모리에 올림) → S3

동시 업로드 1000명, 평균 파일 크기 2MB:
1,000 × 2MB = 2GB 메모리가 "업로드 완료될 때까지" 묶임

업로드 시간이 10초라면:
→ 그 10초 동안 커넥션도 점유 (다른 API 요청 처리 불가)
→ 서버 인스턴스 하나가 파일 업로드만 하다 OOM 사망
```

```
[Presigned URL 방식]
Client → API Server (URL 발급, ~1ms) → Client → S3 직접
                  ↑
          서버는 여기서 끝. 메모리 점유 0.
```

이게 단순히 "서버 부하 줄이기"가 아님. 1M CCU 환경에서 파일 업로드가 서버를 통한다면 그것 하나로 시스템이 다운됨. 업로드 트래픽과 API 트래픽을 분리하는 게 아키텍처의 핵심임.

### Presigned URL의 원리 — 왜 위조가 불가능한가

서명 과정:
1. 서버가 S3 Secret Key로 다음 정보를 HMAC-SHA256으로 서명함:
   - 버킷 이름, 객체 키(파일 경로)
   - Content-Type (어떤 타입의 파일만 허용)
   - 만료 시간 (ExpiresIn=300 → 5분)
   - 최대 파일 크기 (Content-Length-Range)
2. 서명값이 URL 쿼리 파라미터로 포함됨 (`X-Amz-Signature=...`)
3. S3는 요청이 올 때 같은 방식으로 서명을 재계산해서 비교함

위조가 불가능한 이유: Secret Key 없이는 올바른 서명값을 만들 수 없음. URL의 어떤 부분을 바꿔도 (만료 시간 연장, 다른 파일 경로 등) 서명 검증에서 걸림. 클라이언트는 서명 검증 없이 그냥 URL에 PUT 요청만 보내면 됨 — Secret Key는 서버만 알고 있음.

**클라우드별 같은 개념, 다른 이름:**
- AWS S3: Presigned URL (Signature v4)
- GCP Cloud Storage: Signed URL
- Azure Blob: SAS (Shared Access Signature) Token

### 로컬: MinIO — 언제까지 쓰고, 언제 실제 S3로 바꾸는가

MinIO가 뭔지: AWS S3 API를 100% 구현한 오픈소스 Object Storage. Docker로 로컬에서 돌림.

왜 쓰냐: 개발/테스트 환경에서 실제 S3를 쓰면 비용이 발생하고, 인터넷이 없으면 안 되고, 테스트 데이터가 실제 버킷에 올라감. MinIO는 이 세 문제를 전부 해결함.

코드가 바뀌는가: **안 바뀜.** boto3 클라이언트 생성 시 `endpoint_url`만 바꾸면 됨.
```python
# 로컬 (MinIO)
endpoint_url="http://localhost:9000"

# 프로덕션 (실제 AWS S3)
endpoint_url=None  # 기본값이 AWS임
```

언제 실제 S3로 바꾸는가: 프로덕션 배포 직전. 환경변수로 `USE_MINIO=true/false` 분기하면 됨. 코드 로직은 동일하게 유지됨.

### 보안 고려사항 — Content-Type 스푸핑 공격

**문제:** 클라이언트가 Content-Type을 `image/jpeg`라고 선언했는데 실제로 `.exe` 파일을 올리면?

Presigned URL의 Content-Type 제한만으로는 완벽하지 않음. 이유: Content-Type은 클라이언트가 직접 HTTP 헤더에 넣는 값이라 조작 가능함. S3는 파일 내용을 보지 않고 헤더값만 봄.

**방어 레이어 3단계:**
1. **서버 사이드 Content-Type 허용 목록** (현재 구현): `ALLOWED_TYPES`로 일단 필터
2. **파일 크기 제한**: `MAX_SIZE = 10MB` — 작게 제한할수록 공격 비용 증가
3. **Magic Byte 검증**: 파일의 첫 몇 바이트를 읽어서 실제 파일 타입을 확인

```python
# Magic Byte 예시
MAGIC_BYTES = {
    b"\xff\xd8\xff": "image/jpeg",   # JPEG
    b"\x89PNG\r\n": "image/png",     # PNG
    b"GIF87a": "image/gif",          # GIF
    b"GIF89a": "image/gif",
    b"RIFF": "image/webp",           # WebP (RIFF....WEBP)
}

def validate_magic_bytes(file_bytes: bytes, declared_type: str) -> bool:
    for magic, actual_type in MAGIC_BYTES.items():
        if file_bytes.startswith(magic):
            return actual_type == declared_type
    return False
```

이 Phase에서는 Magic Byte 검증을 구현하지 않지만, 보안 관점에서 이 레이어 구조를 이해하고 설명할 수 있어야 함.

### 실패 시나리오 — tmp/ 라이프사이클이 해결하는 문제

왜 `tmp/`와 `images/`를 분리하는가: 업로드 성공과 게시글 작성 성공은 별개 이벤트임. 사용자가 이미지를 올리고 게시글을 안 쓸 수 있고, 쓰다가 브라우저를 닫을 수도 있음. 이 "고아 파일"들이 쌓이면 스토리지 비용이 무한 증가함.

| 상황 | 이미지 위치 | 처리 |
|------|-----------|------|
| 업로드만 하고 게시글 안 씀 | tmp/ | Lifecycle Rule 24시간 자동 삭제 |
| 게시글 작성 성공 | images/ (tmp→images 이동) | 영구 보관 |
| 업로드 중 네트워크 끊김 | tmp/ (불완전) 또는 없음 | Presigned URL 만료 전 재시도 가능 |
| 게시글 삭제 | images/ → 삭제 이벤트 | S3 객체도 같이 삭제 (CASCADE) |

**Lifecycle Rule의 의미:** S3/MinIO에 "tmp/ 경로의 파일은 24시간 후 자동 삭제" 규칙을 설정함. 별도 크론잡이나 배치 프로세스 불필요. 스토리지가 알아서 정리함.

이 설계 패턴의 핵심: **성공 경로에서만 `tmp/ → images/` 이동이 발생함.** 뭔가 잘못되면 자동으로 사라짐. 명시적 롤백 로직이 필요없음.

### 심화 학습 — 더 깊이 파볼 키워드

| 키워드 | 왜 알아야 하는지 |
|--------|----------------|
| **S3 Signature v4** | Presigned URL의 서명 방식. 만료시간, 허용 크기, Content-Type이 서명에 포함되는 원리 |
| **Multipart Upload** | 큰 파일(100MB+)을 조각내서 병렬 업로드. 네트워크 실패 시 해당 조각만 재전송 |
| **Content-Type Spoofing** | 클라이언트가 image/jpeg라고 보내놓고 실행파일을 업로드하는 공격. 서버에서 매직바이트 검증 필요 |
| **CDN (CloudFront)** | S3 앞에 CDN을 두면 이미지 요청이 엣지 서버에서 처리됨. 원본 S3 부하 제거 |
| **Object Storage vs Block Storage** | S3(Object)는 HTTP API로 접근, EBS(Block)는 파일시스템으로 마운트. 용도가 다름 |
| **CORS (Cross-Origin Resource Sharing)** | 브라우저에서 S3로 직접 업로드할 때 CORS 설정 필수. Preflight 요청 이해 필요 |

---

## 구현 (TDD)

개발 방식: **테스트 먼저 작성 (RED)** → **최소 구현 (GREEN)** → **리팩토링 (REFACTOR)**

> Presigned URL 발급/업로드/조회 테스트를 먼저 작성 후 구현. MinIO 연결 설정은 인프라라 TDD 대상 아님.

### Task 16: MinIO Presigned URL 업로드

**Files:**
- Create: `src/models/image.py`
- Create: `src/schemas/image.py`
- Create: `src/services/image_service.py`
- Create: `src/api/command/uploads.py`
- Modify: `src/main.py`
- Create: `tests/test_images.py`

- [ ] **Step 1: Image 모델**

```python
# src/models/image.py
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from src.models.post import Base


class PostImage(Base):
    __tablename__ = "post_images"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    post_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("posts.id", ondelete="CASCADE"), nullable=True
    )
    s3_key: Mapped[str] = mapped_column(String(500), nullable=False)
    original_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str] = mapped_column(String(100), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
```

- [ ] **Step 2: Image 서비스 (Presigned URL 생성)**

```python
# src/services/image_service.py
import uuid

import boto3
from botocore.config import Config

from src.config import settings

s3_client = boto3.client(
    "s3",
    endpoint_url=f"http://{settings.minio_endpoint}",
    aws_access_key_id=settings.minio_access_key,
    aws_secret_access_key=settings.minio_secret_key,
    config=Config(signature_version="s3v4"),
    region_name="us-east-1",
)

ALLOWED_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}
MAX_SIZE = 10 * 1024 * 1024  # 10MB


def generate_presigned_url(filename: str, content_type: str) -> dict:
    if content_type not in ALLOWED_TYPES:
        raise ValueError(f"Unsupported: {content_type}")

    image_id = str(uuid.uuid4())
    s3_key = f"tmp/{image_id}/{filename}"

    url = s3_client.generate_presigned_url(
        "put_object",
        Params={"Bucket": settings.minio_bucket, "Key": s3_key, "ContentType": content_type},
        ExpiresIn=300,
    )
    return {"upload_url": url, "image_id": image_id, "s3_key": s3_key}


def move_to_permanent(s3_key: str) -> str:
    new_key = s3_key.replace("tmp/", "images/", 1)
    s3_client.copy_object(
        Bucket=settings.minio_bucket,
        CopySource={"Bucket": settings.minio_bucket, "Key": s3_key},
        Key=new_key,
    )
    s3_client.delete_object(Bucket=settings.minio_bucket, Key=s3_key)
    return new_key
```

- [ ] **Step 3: Upload API**

```python
# src/api/command/uploads.py
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from src.services import image_service

router = APIRouter(prefix="/api/uploads", tags=["uploads"])


class PresignRequest(BaseModel):
    filename: str
    content_type: str


class PresignResponse(BaseModel):
    upload_url: str
    image_id: str


@router.post("/presign", response_model=PresignResponse)
async def get_presigned_url(data: PresignRequest):
    try:
        result = image_service.generate_presigned_url(data.filename, data.content_type)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return result
```

- [ ] **Step 4: main.py lifespan에 MinIO 버킷 초기화 + 라우터 등록**

- [ ] **Step 5: 테스트**

```python
# tests/test_images.py
import pytest


@pytest.mark.asyncio
async def test_presigned_url(client):
    r = await client.post("/api/uploads/presign", json={
        "filename": "cat.jpg", "content_type": "image/jpeg"
    })
    assert r.status_code == 200
    assert "upload_url" in r.json()


@pytest.mark.asyncio
async def test_reject_invalid_type(client):
    r = await client.post("/api/uploads/presign", json={
        "filename": "virus.exe", "content_type": "application/octet-stream"
    })
    assert r.status_code == 400
```

- [ ] **Step 6: Alembic 마이그레이션 + Commit**

```bash
git add -A
git commit -m "feat: image upload via MinIO presigned URL"
```

---

## Phase 8 완료 체크리스트

- [ ] Presigned URL 발급 API 동작
- [ ] 허용되지 않은 파일 타입 거부
- [ ] MinIO에 실제 업로드 테스트 (curl로 Presigned URL에 PUT)

**다음:** [Phase 9 — 모니터링](phase-09-monitoring.md)
