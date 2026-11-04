import asyncio
import threading

from fastapi import APIRouter, Request
from pydantic import BaseModel

router = APIRouter(prefix="/engine", tags=["engine"])


class MuteBody(BaseModel):
    muted: bool


class VolumeBody(BaseModel):
    volume: float


class SpeakBody(BaseModel):
    text: str


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
    orchestrator = request.app.state.orchestrator
    if orchestrator and orchestrator.tts:
        orchestrator.tts.set_volume(body.volume)
    return {"volume": body.volume}


@router.post("/tts/speak")
async def speak_text(body: SpeakBody, request: Request) -> dict:
    orchestrator = request.app.state.orchestrator
    if not orchestrator or not orchestrator.tts:
        return {"ok": False}
    if orchestrator._tts_muted:
        return {"ok": False, "reason": "muted"}
    if orchestrator._ai_busy:
        return {"ok": False, "reason": "busy"}
    orchestrator.tts.stop()  # interrompe replay anterior se houver
    threading.Thread(target=orchestrator.tts.speak, args=(body.text,), daemon=True).start()
    return {"ok": True}
