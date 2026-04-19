import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class CommentCreate(BaseModel):
    content: str = Field(min_length=1)
    author: str = Field(min_length=1, max_length=100)


class CommentResponse(BaseModel):
    id: uuid.UUID
    post_id: uuid.UUID
    content: str
    author: str
    created_at: datetime

    model_config = {"from_attributes": True}


class CommentListResponse(BaseModel):
    items: list[CommentResponse]
    total: int
    page: int
    size: int
