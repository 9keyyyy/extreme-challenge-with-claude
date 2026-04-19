import uuid

from fastapi import Depends

from src.exceptions import BaseAppException
from src.models.comment import Comment
from src.repositories.comment_repository import CommentRepository
from src.repositories.post_repository import PostRepository
from src.schemas.comment import CommentCreate


class CommentNotFoundError(BaseAppException):
    status_code = 404
    default_msg = "Comment not found"


class CommentPostNotFoundError(BaseAppException):
    status_code = 404
    default_msg = "Post not found"


class CommentService:

    def __init__(
        self,
        comment_repo: CommentRepository = Depends(),
        post_repo: PostRepository = Depends(),
    ):
        self.comment_repo = comment_repo
        self.post_repo = post_repo

    async def create_comment(
        self, post_id: uuid.UUID, data: CommentCreate
    ) -> Comment:
        if not await self.post_repo.exists(post_id):
            raise CommentPostNotFoundError()

        comment = Comment(post_id=post_id, **data.model_dump())
        return await self.comment_repo.create(comment)

    async def list_comments(
        self, post_id: uuid.UUID, page: int, size: int
    ) -> tuple[list[Comment], int]:
        return await self.comment_repo.get_list_by_post(post_id, page, size)

    async def delete_comment(self, comment_id: uuid.UUID) -> None:
        deleted = await self.comment_repo.delete(comment_id)
        if not deleted:
            raise CommentNotFoundError()
