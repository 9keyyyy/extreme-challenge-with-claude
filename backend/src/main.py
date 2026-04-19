from fastapi import APIRouter, FastAPI

from src.api.comments import router as comments_router
from src.api.likes import router as likes_router
from src.api.posts import router as posts_router
from src.exceptions import add_exception_handlers

app = FastAPI(title="Extreme Board")
add_exception_handlers(app)

api_router = APIRouter(prefix="/api/v1")
api_router.include_router(posts_router)
api_router.include_router(comments_router)
api_router.include_router(likes_router)
app.include_router(api_router)


@app.get("/health")
async def health():
    return {"status": "ok"}
