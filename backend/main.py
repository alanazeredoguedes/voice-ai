import sys
from contextlib import asynccontextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import time

import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from backend.config import PORT
from backend.database import init_db
from backend.orchestrator import Orchestrator
from backend import system_log
from backend.routes import system_logs
from backend.routes import benchmark, chat, engine, hotkeys, logs, media, models, settings, storage, transcribe, translate, translate_files, voices, websocket
from backend.state import StateManager
from backend.ws import ConnectionManager


@asynccontextmanager
async def lifespan(app: FastAPI):
    system_log.install()
    system_log.log("info", "app", "backend iniciando | " + system_log.environment_summary())
    await init_db()

    state_manager = StateManager()
    ws_manager = ConnectionManager()

    async def broadcast_to_ws(event: dict) -> None:
        await ws_manager.broadcast(event)

    state_manager.add_listener(broadcast_to_ws)
    system_log.set_emitter(state_manager.emit)
    _log_audio_devices()

    orchestrator = Orchestrator(state_manager)
    await orchestrator.start()

    app.state.state_manager = state_manager
    app.state.ws_manager = ws_manager
    app.state.orchestrator = orchestrator

    system_log.log("info", "app", "backend pronto")
    try:
        yield
    finally:
        system_log.log("info", "app", "backend encerrando")
        system_log.set_emitter(None)
        await orchestrator.stop()


def _log_audio_devices() -> None:
    """Microfones que o backend enxerga (e qual é o padrão): a transcrição grava do padrão do sistema."""
    try:
        import sounddevice as sd

        inputs = [f"{i}: {d['name']} ({d['max_input_channels']} canais, {int(d['default_samplerate'])} Hz)"
                  for i, d in enumerate(sd.query_devices()) if d["max_input_channels"] > 0]
        try:
            name = sd.query_devices(kind="input")["name"]
        except Exception:  # noqa: BLE001
            name = "nenhum"
        system_log.log("info", "microfone", f"padrão do sistema: {name} | entradas: " + "; ".join(inputs)[:3000])
    except Exception as e:  # noqa: BLE001
        system_log.log("error", "microfone", f"não deu para listar os microfones: {system_log.exc_text(e)}")


app = FastAPI(title="Voice AI Backend", lifespan=lifespan)

# pedidos à API no log do sistema: os que alteram algo (ações da pessoa) e os que falham
_QUIET = ("/logs/system", "/health")


@app.middleware("http")
async def log_requests(request: Request, call_next):
    t0 = time.perf_counter()
    path = request.url.path
    try:
        response = await call_next(request)
    except Exception as e:  # noqa: BLE001
        system_log.log("error", "api", f"{request.method} {path} falhou: {system_log.exc_text(e)}")
        raise
    ms = (time.perf_counter() - t0) * 1000
    status = response.status_code
    if not path.startswith(_QUIET) and request.method != "OPTIONS" and (request.method != "GET" or status >= 400):
        level = "error" if status >= 500 else "warn" if status >= 400 else "info"
        system_log.log(level, "api", f"{request.method} {path} → {status} ({ms:.0f} ms)")
    return response


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(system_logs.router)
app.include_router(settings.router)
app.include_router(models.router)
app.include_router(logs.router)
app.include_router(voices.router)
app.include_router(engine.router)
app.include_router(hotkeys.router)
app.include_router(transcribe.router)
app.include_router(translate.router)
app.include_router(translate_files.router)
app.include_router(chat.router)
app.include_router(media.router)
app.include_router(benchmark.router)
app.include_router(storage.router)
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
