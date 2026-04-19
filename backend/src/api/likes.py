import uuid

from fastapi import APIRouter, Depends

from src.schemas.like import LikeRequest, LikeResponse
from src.services.like_service import LikeService

router = APIRouter(tags=["likes"])


@router.post(
    "/posts/{post_id}/likes",
    response_model=LikeResponse,
)
async def toggle_like(
    post_id: uuid.UUID,
    data: LikeRequest,
    service: LikeService = Depends(),
):
    """좋아요 토글. 같은 유저가 다시 누르면 취소."""
    liked, like_count = await service.toggle_like(post_id, data.user_id)
    return LikeResponse(liked=liked, like_count=like_count)
