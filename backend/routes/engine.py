import asyncio
import threading

from fastapi import APIRouter, Request
from pydantic import BaseModel

router = APIRouter(prefix="/engine", tags=["engine"])


class MuteBody(BaseModel):
    muted: bool


class VolumeBody(BaseModel):
    volume: float


class SpeedBody(BaseModel):
    speed: float


class SpeakBody(BaseModel):
    text: str
    ref: str | None = None  # id da mensagem do chat (para o ícone de fala piscar na mensagem certa)
    # mensagem do chat e trecho dela (posições no texto): usa os áudios salvos no disco
    message_id: int | None = None
    start: int = 0
    end: int | None = None


@router.post("/restart")
async def restart_engine(request: Request) -> dict:
    orchestrator = request.app.state.orchestrator
    if not orchestrator:
        return {"status": "orchestrator_not_ready"}
    await orchestrator.restart_engine()
    return {"status": "restarted"}


@router.get("/tts/muted")
async def get_tts_muted(request: Request) -> dict:
    orchestrator = request.app.state.orchestrator
    return {"muted": orchestrator._tts_muted if orchestrator else False}


@router.put("/tts/muted")
async def set_tts_muted(body: MuteBody, request: Request) -> dict:
    orchestrator = request.app.state.orchestrator
    if orchestrator:
        orchestrator.set_tts_muted(body.muted)
    return {"muted": body.muted}


@router.get("/tts/volume")
async def get_tts_volume(request: Request) -> dict:
    orchestrator = request.app.state.orchestrator
    volume = orchestrator.tts._volume if orchestrator and orchestrator.tts else 1.0
    return {"volume": volume}


@router.put("/tts/volume")
async def set_tts_volume(body: VolumeBody, request: Request) -> dict:
    """Volume da voz: aplica na hora e fica salvo (antes voltava a 100% quando o app reiniciava)."""
    from ..settings_store import update

    orchestrator = request.app.state.orchestrator
    volume = round(max(0.0, min(2.0, body.volume)), 2)
    if orchestrator:
        orchestrator.settings["tts_volume"] = volume
        if orchestrator.tts:
            orchestrator.tts.set_volume(volume)
    await update({"tts_volume": volume})
    return {"volume": volume}


@router.get("/tts/speed")
async def get_tts_speed(request: Request) -> dict:
    orchestrator = request.app.state.orchestrator
    speed = orchestrator.tts.speed if orchestrator and orchestrator.tts else 1.0
    return {"speed": speed}


@router.put("/tts/speed")
async def set_tts_speed(body: SpeedBody, request: Request) -> dict:
    """Velocidade da fala (0.5 a 3.0): vale a partir da próxima frase e fica salva."""
    from ..settings_store import update

    orchestrator = request.app.state.orchestrator
    speed = round(max(0.5, min(3.0, body.speed)), 1)
    if orchestrator:
        orchestrator.settings["tts_speed"] = speed
        if orchestrator.tts:
            orchestrator.tts.set_speed(speed)
    await update({"tts_speed": speed})
    return {"speed": speed}


@router.get("/status")
async def engine_status(request: Request) -> dict:
    """Estado do Whisper: a UI consulta depois de trocar o modelo, até ficar pronto."""
    orchestrator = request.app.state.orchestrator
    engine = orchestrator.engine if orchestrator else None
    ready = bool(engine and engine.ready)
    return {
        "ready": ready,
        "model": orchestrator.settings.get("model") if orchestrator else None,
        "device": engine._loaded_device if ready else None,
        # andamento do carregamento (para a tela já abrir mostrando a %)
        "loading": dict(engine.loading) if engine else None,
    }


@router.post("/tts/speak")
async def speak_text(body: SpeakBody, request: Request) -> dict:
    orchestrator = request.app.state.orchestrator
    if not orchestrator or not orchestrator.tts:
        return {"ok": False}
    if orchestrator._tts_muted:
        return {"ok": False, "reason": "muted"}
    if orchestrator._ai_busy or (orchestrator.chats and orchestrator.chats.busy_chat_id is not None):
        return {"ok": False, "reason": "busy"}
    orchestrator.replay(body.text, body.ref or "replay", body.message_id, body.start, body.end)
    return {"ok": True}


@router.post("/tts/stop")
async def stop_speaking(request: Request) -> dict:
    """Para a fala atual (resposta ao vivo ou replay) sem cancelar a resposta em texto."""
    orchestrator = request.app.state.orchestrator
    if orchestrator:
        orchestrator.stop_speech()
    return {"ok": True}
