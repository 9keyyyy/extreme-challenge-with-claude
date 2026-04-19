import uuid

from fastapi import Depends
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.models.comment import Comment


class CommentRepository:

    def __init__(self, db: AsyncSession = Depends(get_db)):
        self.db = db

    async def create(self, comment: Comment) -> Comment:
        self.db.add(comment)
        await self.db.commit()
        await self.db.refresh(comment)
        return comment

    async def get_by_id(self, comment_id: uuid.UUID) -> Comment | None:
        result = await self.db.execute(
            select(Comment).where(Comment.id == comment_id)
        )
        return result.scalar_one_or_none()

    async def get_list_by_post(
        self, post_id: uuid.UUID, page: int, size: int
    ) -> tuple[list[Comment], int]:
        offset = (page - 1) * size

        count_result = await self.db.execute(
            select(func.count(Comment.id)).where(Comment.post_id == post_id)
        )
        total = count_result.scalar_one()

        result = await self.db.execute(
            select(Comment)
            .where(Comment.post_id == post_id)
            .order_by(Comment.created_at.asc())
            .offset(offset)
            .limit(size)
        )
        return list(result.scalars().all()), total

    async def delete(self, comment_id: uuid.UUID) -> bool:
        result = await self.db.execute(
            delete(Comment).where(Comment.id == comment_id)
        )
        if result.rowcount > 0:
            await self.db.commit()
            return True
        return False
