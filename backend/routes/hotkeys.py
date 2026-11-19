import asyncio

from fastapi import APIRouter, HTTPException, Request

from .. import system_log
from ..models import HotkeyCaptureOut
from ..services import evdev_input
from ..services.hotkey_capture import capture_hotkey

router = APIRouter(prefix="/hotkeys", tags=["hotkeys"])


@router.post("/capture", response_model=HotkeyCaptureOut)
async def capture(request: Request) -> HotkeyCaptureOut:
    orchestrator = request.app.state.orchestrator
    if orchestrator:
        orchestrator.pause_hotkeys()
    system_log.log("info", "atalhos", "capturar atalho: esperando uma tecla ou clique…")
    try:
        hotkey = await asyncio.to_thread(capture_hotkey, 10.0)
    finally:
        if orchestrator:
            orchestrator.resume_hotkeys()
    if not hotkey:
        system_log.log("warn", "atalhos", "capturar atalho: nenhuma tecla/clique recebido em 10 s (o sistema não entregou o evento ao app?)")
        raise HTTPException(408, "Timeout - nenhum atalho capturado")
    system_log.log("info", "atalhos", f"capturar atalho: recebido {hotkey}")
    return HotkeyCaptureOut(hotkey=hotkey)


def _status(request: Request) -> dict:
    orchestrator = request.app.state.orchestrator
    manager = orchestrator.hotkey if orchestrator else None
    wayland = evdev_input.wayland_session()
    access = evdev_input.access_status() if wayland else {"devices": 0, "readable": 0, "ok": False}
    return {
        "wayland": wayland,
        "method": manager.method if manager else "none",
        # no Wayland sem a leitura direta, os atalhos só funcionam com o app em foco
        "needs_permission": wayland and not access["ok"],
        "devices": access["devices"],
        "readable": access["readable"],
    }


@router.get("/status")
async def status(request: Request) -> dict:
    return _status(request)


@router.post("/grant-access")
async def grant_access(request: Request) -> dict:
    """Linux com Wayland: libera a leitura do teclado/mouse (pede a senha) e religa os atalhos."""
    if not evdev_input.wayland_session():
        raise HTTPException(400, "Só é necessário no Linux com Wayland.")
    ok, message = await asyncio.to_thread(evdev_input.grant_access)
    system_log.log("info" if ok else "warn", "atalhos", f"liberar leitura do teclado/mouse: {message}")
    orchestrator = request.app.state.orchestrator
    if ok and orchestrator and orchestrator.hotkey:
        await asyncio.to_thread(orchestrator.hotkey.restart)
    return {"ok": ok, "message": message, **_status(request)}
