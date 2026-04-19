from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}

    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/extreme_board"
    db_pool_size: int = 5
    db_max_overflow: int = 10


settings = Settings()
