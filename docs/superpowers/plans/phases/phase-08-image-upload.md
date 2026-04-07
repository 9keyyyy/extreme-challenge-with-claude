# Phase 8: 이미지 업로드 — Presigned URL 직접 업로드

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans

**전제:** Phase 7 완료.

---

## 학습: 왜 서버를 거치면 안 되는가

### 서버 경유 vs Presigned URL

서버 경유: Client → API Server(메모리에 파일 적재) → S3
- 1000명 × 2MB 동시 업로드 = 2GB 메모리 점유 → 서버 폭발
- 업로드 시간만큼 커넥션 물고 있음 → 다른 API 요청도 블록

Presigned URL: Client → API Server(URL만 발급, 1ms) → Client → S3 직접 업로드
- 서버 메모리 사용 0. 커넥션 즉시 해제.
- S3가 알아서 무한 스케일

### Presigned URL의 원리

서버가 "이 URL로 5분 안에 이 크기의 이 타입 파일을 올려라"는 서명된 URL을 발급. 서명에 조건(크기, 타입, 만료시간)이 포함 → 변조 불가.

**클라우드별 비교:**
- AWS S3: Presigned URL
- GCP Cloud Storage: Signed URL
- Azure Blob: SAS Token
→ 개념 동일, API가 다름

### 로컬: MinIO

S3 API 100% 호환 오픈소스. Docker 한 줄로 구동. 코드 변경 없이 MinIO ↔ S3 전환 가능.

### 실패 시나리오

| 상황 | 이미지 위치 | 처리 |
|------|-----------|------|
| 업로드만 하고 게시글 안 씀 | tmp/ | Lifecycle Rule 24시간 자동 삭제 |
| 게시글 작성 성공 | images/ (tmp→images 이동) | 영구 보관 |
| 업로드 중 네트워크 끊김 | tmp/ (불완전) 또는 없음 | Presigned URL 만료 전 재시도 가능 |

---

## 구현

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
