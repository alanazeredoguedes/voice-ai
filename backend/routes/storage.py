"""Armazenamento: quanto o app ocupa no disco e o que dá para apagar (Configurações → Armazenamento)."""
import asyncio
import os
import sys
import time
from pathlib import Path

from fastapi import APIRouter, Request

from ..config import DATA_DIR, DB_PATH
from ..services import chats as chat_db
from ..services import speech_cache
from .models import WHISPER_MODELS, _blobs_size_mb, _is_downloaded

router = APIRouter(prefix="/storage", tags=["storage"])

_libs_cache: dict = {"at": 0.0, "bytes": 0}


def _dir_bytes(d: Path) -> int:
    total = 0
    for root, _, files in os.walk(d):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def _libraries_bytes() -> int:
    """Python e as bibliotecas do app (Whisper, PyTorch/CUDA, tradutor...). Calculado a cada 10 min."""
    if time.time() - _libs_cache["at"] < 600:
        return _libs_cache["bytes"]
    roots: set[Path] = set()
    for p in sys.path:
        if p and ("site-packages" in p or "packages" in Path(p).name.lower()) and Path(p).is_dir():
            roots.add(Path(p).resolve())
    total = sum(_dir_bytes(r) for r in roots)
    _libs_cache.update(at=time.time(), bytes=total)
    return total


def _translation() -> dict:
    try:
        import argostranslate.settings as s

        d = Path(s.package_data_dir)
    except Exception:
        d = Path.home() / ".local" / "share" / "argos-translate" / "packages"
    if not d.is_dir():
        return {"bytes": 0, "count": 0}
    return {"bytes": _dir_bytes(d), "count": sum(1 for x in d.iterdir() if x.is_dir())}


def _summary(orchestrator) -> dict:
    usage = speech_cache.usage()
    names = {c["id"]: c["name"] for c in chat_db.list_chats()}
    active_model = orchestrator.settings.get("model") if orchestrator else None
    db = sum(os.path.getsize(p) for p in (str(DB_PATH), str(DB_PATH) + "-wal") if os.path.exists(p))
    return {
        "data_dir": str(DATA_DIR),
        "speech_cache": {
            "bytes": usage["total"],
            "limit_mb": orchestrator.settings.get("speech_cache_limit_mb", speech_cache.DEFAULT_LIMIT_MB)
            if orchestrator else speech_cache.DEFAULT_LIMIT_MB,
            "chats": sorted(
                [{"chat_id": cid, "name": names.get(cid, f"Chat {cid}"), **u} for cid, u in usage["chats"].items()],
                key=lambda c: -c["bytes"],
            ),
        },
        "models": [
            {"id": m["id"], "name": m["name"], "bytes": int(_blobs_size_mb(m["id"]) * 1024 * 1024),
             "active": m["id"] == active_model}
            for m in WHISPER_MODELS
            if _is_downloaded(m["id"])
        ],
        "translation": _translation(),
        "database": {"bytes": db},
        "libraries": {"bytes": _libraries_bytes()},
    }


@router.get("")
async def storage(request: Request) -> dict:
    return await asyncio.to_thread(_summary, request.app.state.orchestrator)


@router.delete("/speech-cache", status_code=204)
async def clear_all_speech_cache() -> None:
    """Apaga todos os áudios salvos das respostas (as mensagens continuam)."""
    await asyncio.to_thread(speech_cache.delete_all)
