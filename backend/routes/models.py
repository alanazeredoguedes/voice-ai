import shutil
import threading
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request

router = APIRouter(prefix="/models", tags=["models"])

WHISPER_MODELS = [
    {"id": "tiny",     "name": "Tiny",     "size_mb": 75,   "speed": "Muito rápido", "quality": "Básica"},
    {"id": "base",     "name": "Base",     "size_mb": 145,  "speed": "Rápido",       "quality": "Boa"},
    {"id": "small",    "name": "Small",    "size_mb": 460,  "speed": "Moderado",     "quality": "Muito boa"},
    {"id": "medium",   "name": "Medium",   "size_mb": 1500, "speed": "Lento",        "quality": "Alta"},
    {"id": "large-v3", "name": "Large v3", "size_mb": 3000, "speed": "Muito lento",  "quality": "Máxima"},
]

_HF_CACHE = Path.home() / ".cache" / "huggingface" / "hub"
_VALID_IDS = {m["id"] for m in WHISPER_MODELS}
_downloading: set[str] = set()


def _model_dir(model_id: str) -> Path:
    return _HF_CACHE / f"models--Systran--faster-whisper-{model_id}"


def _is_downloaded(model_id: str) -> bool:
    blobs = _model_dir(model_id) / "blobs"
    if not blobs.exists():
        return False
    # Considera baixado se houver algum blob > 50 MB (o menor modelo tem ~75 MB)
    return any(f.stat().st_size > 50 * 1024 * 1024 for f in blobs.iterdir() if f.is_file())


def _blobs_size_mb(model_id: str) -> float:
    blobs = _model_dir(model_id) / "blobs"
    if not blobs.exists():
        return 0.0
    total = sum(f.stat().st_size for f in blobs.iterdir() if f.is_file())
    return round(total / (1024 * 1024), 1)


@router.get("")
async def list_models() -> list[dict]:
    return [
        {
            **m,
            "downloaded": _is_downloaded(m["id"]),
            "downloading": m["id"] in _downloading,
        }
        for m in WHISPER_MODELS
    ]


@router.post("/{model_id}/download")
async def download_model(model_id: str, request: Request) -> dict:
    if model_id not in _VALID_IDS:
        raise HTTPException(400, "Modelo inválido")
    if model_id in _downloading:
        return {"queued": False, "reason": "already_downloading"}

    state = request.app.state.state_manager
    expected_mb = next(m["size_mb"] for m in WHISPER_MODELS if m["id"] == model_id)

    _downloading.add(model_id)

    def do_download() -> None:
        blobs_dir = _model_dir(model_id) / "blobs"
        stop_evt = threading.Event()

        def monitor() -> None:
            while not stop_evt.is_set():
                try:
                    if blobs_dir.exists():
                        total = sum(
                            f.stat().st_size for f in blobs_dir.iterdir() if f.is_file()
                        )
                        pct = min(99.0, (total / (expected_mb * 1024 * 1024)) * 100)
                        state.emit({
                            "type": "model_download_progress",
                            "model": model_id,
                            "progress": round(pct, 1),
                        })
                except Exception:
                    pass
                stop_evt.wait(1.0)

        threading.Thread(target=monitor, daemon=True).start()
        try:
            from huggingface_hub import snapshot_download
            snapshot_download(repo_id=f"Systran/faster-whisper-{model_id}")
            state.emit({"type": "model_download_progress", "model": model_id, "progress": 100.0})
            state.emit({"type": "model_download_complete", "model": model_id})
        except Exception as e:
            state.emit({"type": "model_download_error", "model": model_id, "error": str(e)})
        finally:
            stop_evt.set()
            _downloading.discard(model_id)

    threading.Thread(target=do_download, daemon=True).start()
    return {"queued": True}


@router.delete("/{model_id}", status_code=204)
async def delete_model(model_id: str) -> None:
    if model_id not in _VALID_IDS:
        raise HTTPException(400, "Modelo inválido")
    model_dir = _model_dir(model_id)
    if model_dir.exists():
        shutil.rmtree(model_dir)
