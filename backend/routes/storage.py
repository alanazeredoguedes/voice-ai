"""Armazenamento: quanto o app ocupa no disco e o que dá para apagar (Configurações → Armazenamento)."""
import asyncio
import json
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

_libs_cache: dict = {"at": 0.0, "bytes": 0, "detail": []}


def _dir_bytes(d: Path) -> int:
    total = 0
    for root, _, files in os.walk(d):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def _libraries() -> dict:
    """Python e as bibliotecas do app (Whisper, PyTorch/CUDA, tradutor...): total e detalhe. Calculado a cada
    10 min (as bibliotecas só mudam quando o app instala ou atualiza algo)."""
    if time.time() - _libs_cache["at"] > 600:
        detail = _libraries_detail()
        _libs_cache.update(at=time.time(), bytes=sum(x["bytes"] for x in detail), detail=detail)
    return _libs_cache


def _translation() -> dict:
    """Pacotes de idioma do tradutor instalados (cada um traduz de um idioma para outro)."""
    try:
        import argostranslate.settings as s

        d = Path(s.package_data_dir)
    except Exception:
        d = Path.home() / ".local" / "share" / "argos-translate" / "packages"
    if not d.is_dir():
        return {"bytes": 0, "count": 0, "packages": []}
    packages = []
    for x in d.iterdir():
        if not x.is_dir():
            continue
        try:
            meta = json.loads((x / "metadata.json").read_text(encoding="utf-8"))
        except Exception:
            meta = {}
        packages.append({
            "from_code": meta.get("from_code", ""), "to_code": meta.get("to_code", ""),
            "from_name": meta.get("from_name", ""), "to_name": meta.get("to_name", ""),
            "name": x.name, "bytes": _dir_bytes(x),
        })
    packages.sort(key=lambda p: -p["bytes"])
    return {"bytes": sum(p["bytes"] for p in packages), "count": len(packages), "packages": packages}


# O que cada biblioteca grande faz no app (Configurações → Armazenamento → Bibliotecas do app)
_LIB_INFO: dict[str, str] = {
    "nvidia/cu13": "CUDA da NVIDIA: o Whisper e o tradutor rodarem na placa de vídeo",
    "nvidia/cu12": "CUDA da NVIDIA: o Whisper e o tradutor rodarem na placa de vídeo",
    "nvidia/cudnn": "cuDNN da NVIDIA: redes neurais na placa de vídeo (Whisper rápido)",
    "nvidia/cublas": "cuBLAS da NVIDIA: cálculos na placa de vídeo (Whisper rápido)",
    "nvidia/nccl": "NCCL da NVIDIA: comunicação entre placas de vídeo (exigido pelo PyTorch)",
    "nvidia/cusparselt": "cuSPARSELt da NVIDIA: cálculos na placa de vídeo (exigido pelo PyTorch)",
    "nvidia/nvshmem": "NVSHMEM da NVIDIA: memória da placa de vídeo (exigido pelo PyTorch)",
    "torch": "PyTorch: motor de IA do tradutor",
    "triton": "Triton: acelera o PyTorch na placa de vídeo",
    "torchgen": "Parte do PyTorch",
    "cuda": "Ligação do Python com o CUDA da NVIDIA",
    "ctranslate2": "Motor que roda o Whisper (reconhecimento de voz)",
    "ctranslate2.libs": "Bibliotecas nativas do motor do Whisper",
    "faster_whisper": "Reconhecimento de voz (Whisper)",
    "av": "Leitura de áudio e vídeo (FFmpeg)",
    "av.libs": "FFmpeg: leitura de áudio e vídeo",
    "onnxruntime": "Detecção de fala (pular silêncios)",
    "spacy": "Processamento de texto do tradutor",
    "thinc": "Processamento de texto do tradutor",
    "blis": "Cálculos do processamento de texto do tradutor",
    "stanza": "Divisão de frases do tradutor",
    "argostranslate": "Tradutor offline",
    "sentencepiece": "Divide o texto em partes para o tradutor",
    "sacremoses": "Prepara o texto para o tradutor",
    "sympy": "Matemática simbólica (exigido pelo PyTorch)",
    "mpmath": "Matemática de precisão (exigido pelo PyTorch)",
    "networkx": "Grafos (exigido pelo PyTorch)",
    "numpy": "Cálculos numéricos (áudio)",
    "numpy.libs": "Bibliotecas nativas de cálculo",
    "tokenizers": "Leitura do texto dos modelos de IA",
    "huggingface_hub": "Download dos modelos de voz",
    "hf_xet": "Download rápido dos modelos de voz",
    "uvloop": "Servidor interno do app (rede rápida)",
    "aiohttp": "Conexões com a internet",
    "pip": "Instalador de bibliotecas (atualizações do app)",
    "setuptools": "Instalador de bibliotecas (atualizações do app)",
    "pydantic": "Validação de dados do servidor interno",
    "pydantic_core": "Validação de dados do servidor interno",
    "fastapi": "Servidor interno do app",
    "uvicorn": "Servidor interno do app",
    "edge_tts": "Voz da IA (Edge TTS)",
    "elevenlabs": "Voz da IA (ElevenLabs)",
    "pynput": "Atalhos de teclado e mouse",
    "Xlib": "Atalhos de teclado e mouse (Linux)",
    "sounddevice": "Gravação do microfone",
    "emoji": "Emojis no texto falado",
    "regex": "Busca em texto",
    "pygments": "Destaque de código",
    "rich": "Textos formatados nos logs",
    "yaml": "Leitura de configurações",
}


def _library_roots() -> set[Path]:
    roots: set[Path] = set()
    for p in sys.path:
        if p and ("site-packages" in p or "packages" in Path(p).name.lower()) and Path(p).is_dir():
            roots.add(Path(p).resolve())
    return roots


def _libraries_detail() -> list[dict]:
    """Cada biblioteca com o tamanho e para que serve, da maior para a menor (a pasta nvidia é aberta por componente)."""
    sizes: dict[str, int] = {}
    for root in _library_roots():
        for entry in root.iterdir():
            if entry.name.endswith((".dist-info", ".egg-info", ".pth")) or entry.name == "__pycache__":
                key = "(metadados)"
                size = _dir_bytes(entry) if entry.is_dir() else entry.stat().st_size
            elif entry.name == "nvidia" and entry.is_dir():
                for sub in entry.iterdir():
                    if sub.is_dir():
                        sizes[f"nvidia/{sub.name}"] = sizes.get(f"nvidia/{sub.name}", 0) + _dir_bytes(sub)
                continue
            else:
                key = entry.name[:-3] if entry.name.endswith(".py") else entry.name
                size = _dir_bytes(entry) if entry.is_dir() else entry.stat().st_size
            sizes[key] = sizes.get(key, 0) + size
    out = []
    for name, size in sizes.items():
        info = _LIB_INFO.get(name)
        if not info and name.startswith("nvidia/"):
            info = "Componente da NVIDIA para a placa de vídeo"
        if name == "(metadados)":
            info = "Informações de versão das bibliotecas"
        out.append({"name": name, "bytes": size, "description": info or ""})
    out.sort(key=lambda x: -x["bytes"])
    return out


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
        "libraries": {"bytes": _libraries()["bytes"]},
    }


@router.get("")
async def storage(request: Request) -> dict:
    return await asyncio.to_thread(_summary, request.app.state.orchestrator)


@router.get("/libraries")
async def libraries() -> list[dict]:
    return (await asyncio.to_thread(_libraries))["detail"]


@router.delete("/speech-cache", status_code=204)
async def clear_all_speech_cache() -> None:
    """Apaga todos os áudios salvos das respostas (as mensagens continuam)."""
    await asyncio.to_thread(speech_cache.delete_all)
