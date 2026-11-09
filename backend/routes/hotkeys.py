import asyncio

from fastapi import APIRouter, HTTPException, Request

from ..models import HotkeyCaptureOut
from ..services.hotkey_capture import capture_hotkey

router = APIRouter(prefix="/hotkeys", tags=["hotkeys"])


@router.post("/capture", response_model=HotkeyCaptureOut)
async def capture(request: Request) -> HotkeyCaptureOut:
    orchestrator = request.app.state.orchestrator
    if orchestrator:
        orchestrator.pause_hotkeys()
    try:
        hotkey = await asyncio.to_thread(capture_hotkey, 10.0)
    finally:
        if orchestrator:
            orchestrator.resume_hotkeys()
    if not hotkey:
        raise HTTPException(408, "Timeout - nenhum atalho capturado")
    return HotkeyCaptureOut(hotkey=hotkey)
