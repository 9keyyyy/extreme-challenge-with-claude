import uuid

from fastapi import Depends
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.models.like import Like
from src.models.post import Post


class LikeRepository:
    """의도적으로 DB 직접 UPDATE — Phase 5에서 Redis INCR로 교체."""

    def __init__(self, db: AsyncSession = Depends(get_db)):
        self.db = db

    async def get_by_post_and_user(
        self, post_id: uuid.UUID, user_id: str
    ) -> Like | None:
        result = await self.db.execute(
            select(Like).where(Like.post_id == post_id, Like.user_id == user_id)
        )
        return result.scalar_one_or_none()

    async def create(self, like: Like) -> int:
        self.db.add(like)
        result = await self.db.execute(
            update(Post)
            .where(Post.id == like.post_id)
            .values(like_count=Post.like_count + 1)
            .returning(Post.like_count)
        )
        await self.db.commit()
        return result.scalar_one()

    async def delete_by_id(self, like_id: uuid.UUID, post_id: uuid.UUID) -> int:
        await self.db.execute(delete(Like).where(Like.id == like_id))
        result = await self.db.execute(
            update(Post)
            .where(Post.id == post_id)
            .values(like_count=func.greatest(Post.like_count - 1, 0))
            .returning(Post.like_count)
        )
        await self.db.commit()
        return result.scalar_one()
