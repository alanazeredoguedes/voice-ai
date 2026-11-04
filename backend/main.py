import sys
from contextlib import asynccontextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.config import PORT
from backend.database import init_db
from backend.orchestrator import Orchestrator
from backend.routes import chat, engine, hotkeys, logs, models, settings, transcribe, translate, voices, websocket
from backend.state import StateManager
from backend.ws import ConnectionManager


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()

    state_manager = StateManager()
    ws_manager = ConnectionManager()

    async def broadcast_to_ws(event: dict) -> None:
        await ws_manager.broadcast(event)

    state_manager.add_listener(broadcast_to_ws)

    orchestrator = Orchestrator(state_manager)
    await orchestrator.start()

    app.state.state_manager = state_manager
    app.state.ws_manager = ws_manager
    app.state.orchestrator = orchestrator

    try:
        yield
    finally:
        await orchestrator.stop()


app = FastAPI(title="Voice AI Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(settings.router)
app.include_router(models.router)
app.include_router(logs.router)
app.include_router(voices.router)
app.include_router(engine.router)
app.include_router(hotkeys.router)
app.include_router(transcribe.router)
app.include_router(translate.router)
app.include_router(chat.router)
app.include_router(websocket.router)


@app.get("/health")
async def health() -> dict:
    state_manager = getattr(app.state, "state_manager", None)
    return {
        "status": "ok",
        "state": state_manager.state if state_manager else "unknown",
    }


def main() -> None:
    uvicorn.run(
        "backend.main:app",
        host="127.0.0.1",
        port=PORT,
        log_level="info",
    )


if __name__ == "__main__":
    main()
