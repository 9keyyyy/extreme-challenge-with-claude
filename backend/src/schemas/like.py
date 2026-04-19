from pydantic import BaseModel, Field


class LikeRequest(BaseModel):
    user_id: str = Field(min_length=1, max_length=100)


class LikeResponse(BaseModel):
    liked: bool
    like_count: int
