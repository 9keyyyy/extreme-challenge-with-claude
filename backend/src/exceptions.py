from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse


class BaseAppException(Exception):
    status_code: int = 400
    default_msg: str = "Bad request"

    def __init__(self, msg: str | None = None):
        self.msg = msg or self.default_msg
        super().__init__(self.msg)


def add_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(BaseAppException)
    async def handle_app_exception(request: Request, exc: BaseAppException):
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.msg},
        )
