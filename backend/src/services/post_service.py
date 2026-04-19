import uuid

from fastapi import Depends

from src.exceptions import BaseAppException
from src.models.post import Post
from src.repositories.post_repository import PostRepository
from src.schemas.post import PostCreate, PostUpdate


class PostNotFoundError(BaseAppException):
    status_code = 404
    default_msg = "Post not found"


class VersionConflictError(BaseAppException):
    status_code = 409
    default_msg = "Version conflict"


class PostService:

    def __init__(self, post_repo: PostRepository = Depends()):
        self.post_repo = post_repo

    async def create_post(self, data: PostCreate) -> Post:
        post = Post(**data.model_dump())
        return await self.post_repo.create(post)

    async def get_post(self, post_id: uuid.UUID) -> Post:
        """의도적으로 DB 직접 UPDATE — Phase 5에서 Redis INCR로 교체."""
        post = await self.post_repo.get_and_increment_view(post_id)
        if not post:
            raise PostNotFoundError()
        return post

    async def list_posts(self, page: int, size: int) -> tuple[list[Post], int]:
        return await self.post_repo.get_list(page, size)

    async def update_post(self, post_id: uuid.UUID, data: PostUpdate) -> Post:
        """update가 None이면 두 가지 경우:
        1. 게시글 없음 → 404
        2. version 불일치 → 409
        exists()로 구분함.
        """
        update_data = data.model_dump(exclude_unset=True, exclude={"version"})
        post = await self.post_repo.update(post_id, data.version, update_data)

        if not post:
            if not await self.post_repo.exists(post_id):
                raise PostNotFoundError()
            raise VersionConflictError()

        return post

    async def delete_post(self, post_id: uuid.UUID) -> None:
        deleted = await self.post_repo.delete(post_id)
        if not deleted:
            raise PostNotFoundError()
