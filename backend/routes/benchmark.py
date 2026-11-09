"""Testar desempenho (página aberta pelo card do Whisper nas Configurações)."""
import asyncio
import re

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel

from ..config import DB_PATH
from ..services import benchmark as bm
from .models import WHISPER_MODELS, _is_downloaded

router = APIRouter(prefix="/benchmark", tags=["benchmark"])


class AudioSel(BaseModel):
    id: str
    minutes: int


class RunBody(BaseModel):
    models: list[str]
    devices: list[str]
    audios: list[AudioSel]
    modes: list[str]


def _runner(request: Request) -> bm.BenchmarkRunner:
    app = request.app
    if getattr(app.state, "benchmark_runner", None) is None:
        orch = app.state.orchestrator
        app.state.benchmark_runner = bm.BenchmarkRunner(orch.state.emit)
    return app.state.benchmark_runner


def _has_gpu() -> bool:
    try:
        import ctranslate2

        return ctranslate2.get_cuda_device_count() > 0
    except Exception:
        return False


@router.get("/info")
async def info(request: Request) -> dict:
    runner = _runner(request)
    models = [
        {"id": m["id"], "name": m["name"], "size_mb": m["size_mb"]}
        for m in WHISPER_MODELS
        if _is_downloaded(m["id"])
    ]
    history = await asyncio.to_thread(bm.history_speeds, DB_PATH)
    return {
        "library": await asyncio.to_thread(bm.library_public),
        "models": models,
        "modes": [{"id": k, "label": v["label"]} for k, v in bm.MODES.items()],
        "has_gpu": await asyncio.to_thread(_has_gpu),
        # velocidade (x o tempo do áudio) de cada "modelo|dispositivo", para estimar o tempo do teste
        "speeds": bm.default_speeds() | history,
        "speeds_from_history": sorted(history.keys()),
        "load_s": bm.LOAD_S,
        "job": runner._public(runner.job) if runner.job else None,
        "last_report": None if runner.job else await asyncio.to_thread(bm.last_report),
    }


@router.get("/audio/{audio_id}")
async def audio(audio_id: str, request: Request) -> Response:
    """Serve o áudio de teste aceitando "Range" (o player precisa para avançar e voltar)."""
    if not re.fullmatch(r"[a-z0-9_-]+", audio_id):
        raise HTTPException(404)
    path = bm.ASSETS / f"{audio_id}.ogg"
    if not path.is_file():
        raise HTTPException(404)
    data = await asyncio.to_thread(path.read_bytes)
    size = len(data)
    headers = {"Accept-Ranges": "bytes", "Cache-Control": "max-age=3600"}
    rng = request.headers.get("range")
    m = re.match(r"bytes=(\d*)-(\d*)", rng or "")
    if m and (m.group(1) or m.group(2)):
        if m.group(1):
            start = int(m.group(1))
            end = int(m.group(2)) if m.group(2) else size - 1
        else:  # "bytes=-N": os últimos N bytes
            start = max(0, size - int(m.group(2)))
            end = size - 1
        end = min(end, size - 1)
        if start > end:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
        return Response(data[start:end + 1], status_code=206, media_type="audio/ogg", headers=headers)
    return Response(data, media_type="audio/ogg", headers=headers)


@router.post("/run")
async def run(body: RunBody, request: Request) -> dict:
    runner = _runner(request)
    try:
        return runner.start(body.models, body.devices, [a.model_dump() for a in body.audios], body.modes)
    except RuntimeError as e:
        raise HTTPException(409, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/cancel")
async def cancel(request: Request) -> dict:
    _runner(request).cancel()
    return {"ok": True}
