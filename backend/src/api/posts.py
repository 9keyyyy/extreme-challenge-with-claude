import uuid

from fastapi import APIRouter, Depends, Query

from src.schemas.post import PostCreate, PostListResponse, PostResponse, PostUpdate
from src.services.post_service import PostService

router = APIRouter(prefix="/posts", tags=["posts"])


@router.post("", response_model=PostResponse, status_code=201)
async def create_post(data: PostCreate, service: PostService = Depends()):
    """게시글 생성."""
    return await service.create_post(data)


@router.get("", response_model=PostListResponse)
async def list_posts(
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=100),
    service: PostService = Depends(),
):
    """게시글 목록. OFFSET 페이지네이션."""
    posts, total = await service.list_posts(page, size)
    return PostListResponse(items=posts, total=total, page=page, size=size)


@router.get("/{post_id}", response_model=PostResponse)
async def get_post(post_id: uuid.UUID, service: PostService = Depends()):
    """게시글 조회 + view_count 증가."""
    return await service.get_post(post_id)


@router.put("/{post_id}", response_model=PostResponse)
async def update_post(
    post_id: uuid.UUID, data: PostUpdate, service: PostService = Depends()
):
    """게시글 수정. optimistic lock — version 불일치 시 409."""
    return await service.update_post(post_id, data)


@router.delete("/{post_id}", status_code=204)
async def delete_post(post_id: uuid.UUID, service: PostService = Depends()):
    """게시글 삭제."""
    await service.delete_post(post_id)
