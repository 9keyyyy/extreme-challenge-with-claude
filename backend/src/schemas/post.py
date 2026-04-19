import uuid
from datetime import datetime

from pydantic import BaseModel, Field, model_validator


class PostCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1)
    author: str = Field(min_length=1, max_length=100)


class PostUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    content: str | None = Field(default=None, min_length=1)
    version: int

    @model_validator(mode="after")
    def check_has_update_fields(self):
        if not (self.model_fields_set - {"version"}):
            raise ValueError("수정할 필드가 하나 이상 필요함")
        return self


class PostResponse(BaseModel):
    id: uuid.UUID
    title: str
    content: str
    author: str
    view_count: int
    like_count: int
    version: int
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class PostListResponse(BaseModel):
    items: list[PostResponse]
    total: int
    page: int
    size: int
