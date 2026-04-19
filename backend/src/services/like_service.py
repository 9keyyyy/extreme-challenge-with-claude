import uuid

from fastapi import Depends

from src.exceptions import BaseAppException
from src.models.like import Like
from src.repositories.like_repository import LikeRepository
from src.repositories.post_repository import PostRepository


class LikePostNotFoundError(BaseAppException):
    status_code = 404
    default_msg = "Post not found"


class LikeService:

    def __init__(
        self,
        like_repo: LikeRepository = Depends(),
        post_repo: PostRepository = Depends(),
    ):
        self.like_repo = like_repo
        self.post_repo = post_repo

    async def toggle_like(
        self, post_id: uuid.UUID, user_id: str
    ) -> tuple[bool, int]:
        if not await self.post_repo.exists(post_id):
            raise LikePostNotFoundError()

        existing = await self.like_repo.get_by_post_and_user(post_id, user_id)

        if existing:
            like_count = await self.like_repo.delete_by_id(existing.id, post_id)
            liked = False
        else:
            like = Like(post_id=post_id, user_id=user_id)
            like_count = await self.like_repo.create(like)
            liked = True

        return liked, like_count
