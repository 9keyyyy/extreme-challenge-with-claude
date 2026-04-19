import uuid

from fastapi import APIRouter, Depends, Query

from src.schemas.comment import CommentCreate, CommentListResponse, CommentResponse
from src.services.comment_service import CommentService

router = APIRouter(tags=["comments"])


@router.post(
    "/posts/{post_id}/comments",
    response_model=CommentResponse,
    status_code=201,
)
async def create_comment(
    post_id: uuid.UUID,
    data: CommentCreate,
    service: CommentService = Depends(),
):
    """댓글 생성."""
    return await service.create_comment(post_id, data)


@router.get(
    "/posts/{post_id}/comments",
    response_model=CommentListResponse,
)
async def list_comments(
    post_id: uuid.UUID,
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=100),
    service: CommentService = Depends(),
):
    """댓글 목록. OFFSET 페이지네이션."""
    comments, total = await service.list_comments(post_id, page, size)
    return CommentListResponse(items=comments, total=total, page=page, size=size)


@router.delete("/comments/{comment_id}", status_code=204)
async def delete_comment(
    comment_id: uuid.UUID,
    service: CommentService = Depends(),
):
    """댓글 삭제."""
    await service.delete_comment(comment_id)
