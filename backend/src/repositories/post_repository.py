import uuid

from fastapi import Depends
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.models.post import Post


class PostRepository:

    def __init__(self, db: AsyncSession = Depends(get_db)):
        self.db = db

    async def create(self, post: Post) -> Post:
        self.db.add(post)
        await self.db.commit()
        await self.db.refresh(post)
        return post

    async def get_by_id(self, post_id: uuid.UUID) -> Post | None:
        result = await self.db.execute(select(Post).where(Post.id == post_id))
        return result.scalar_one_or_none()

    async def get_list(
        self, page: int, size: int
    ) -> tuple[list[Post], int]:
        """의도적으로 OFFSET 사용 — Phase 3에서 커서 기반으로 교체하며 차이 체감.
        OFFSET은 페이지가 깊어질수록 느려짐 (100만 번째부터 20개 = 100만 row 스캔).
        """
        offset = (page - 1) * size

        count_result = await self.db.execute(select(func.count(Post.id)))
        total = count_result.scalar_one()

        result = await self.db.execute(
            select(Post).order_by(Post.created_at.desc()).offset(offset).limit(size)
        )
        return list(result.scalars().all()), total

    async def update(
        self, post_id: uuid.UUID, version: int, update_data: dict
    ) -> Post | None:
        """SELECT → check → UPDATE 패턴의 race condition을 원천 차단.
        두 요청이 동시에 SELECT하면 둘 다 같은 version을 보지만,
        atomic UPDATE는 DB 락이 하나만 성공시키고 나머지는 0 rows affected.
        """
        stmt = (
            update(Post)
            .where(Post.id == post_id, Post.version == version)
            .values(**update_data, version=Post.version + 1, updated_at=func.now())
            .returning(Post)
        )
        result = await self.db.execute(stmt)
        post = result.scalar_one_or_none()

        if post:
            await self.db.commit()

        return post

    async def get_and_increment_view(self, post_id: uuid.UUID) -> Post | None:
        """의도적으로 느린 방식 — Phase 5에서 Redis INCR로 교체하며 차이 체감."""
        stmt = (
            update(Post)
            .where(Post.id == post_id)
            .values(view_count=Post.view_count + 1)
            .returning(Post)
        )
        result = await self.db.execute(stmt)
        post = result.scalar_one_or_none()
        if post:
            await self.db.commit()
        return post

    async def exists(self, post_id: uuid.UUID) -> bool:
        """SELECT EXISTS — 첫 row 발견 즉시 True. COUNT(id)는 전체 row를 세므로 틀린 관용구."""
        result = await self.db.execute(
            select(select(Post.id).where(Post.id == post_id).exists())
        )
        return result.scalar_one()

    async def delete(self, post_id: uuid.UUID) -> bool:
        result = await self.db.execute(
            delete(Post).where(Post.id == post_id)
        )
        if result.rowcount > 0:
            await self.db.commit()
            return True
        return False
