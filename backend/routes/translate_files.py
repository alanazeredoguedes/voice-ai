"""Tradução de arquivos (PDF, Word, PowerPoint, Excel, texto e legendas) com os modelos locais do Argos.

Cada tradução é uma tarefa com pasta própria em DATA_DIR/translated-files/<id>/ (original, traduzido e meta.json).
Roda uma por vez, em segundo plano; o progresso chega pela WebSocket (evento "translate_file").
"""
import asyncio
import importlib.util
import json
import re
import shutil
import threading
import time
import uuid
from collections import OrderedDict
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response

from ..config import DATA_DIR
from ..services.file_translate import SUPPORTED_EXTS, Canceled, Translator, darken_pdf, render_pdf_page, translate_file


def _require_libs() -> None:
    """argostranslate, PyMuPDF (PDF) e lxml (Office) são baixados na instalação do app. Numa instalação anterior
    a esta função, o app passa pela tela de atualização na próxima abertura."""
    missing = [m for m in ("argostranslate", "pymupdf", "lxml") if importlib.util.find_spec(m) is None]
    if missing:
        raise HTTPException(
            503, "Os componentes da tradução de arquivos ainda não foram instalados. Feche e abra o app para atualizar."
        )


router = APIRouter(prefix="/translate/files", tags=["translate"], dependencies=[Depends(_require_libs)])

JOBS_DIR = DATA_DIR / "translated-files"
MAX_UPLOAD = 200 * 1024 * 1024

_lock = threading.Lock()  # uma tradução por vez (o modelo de tradução é pesado)
_jobs: dict[str, dict] = {}
_cancel: set[str] = set()


def _job_dir(job_id: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{12}", job_id):
        raise HTTPException(404, "Tradução não encontrada")
    return JOBS_DIR / job_id


def _save(job: dict) -> None:
    (JOBS_DIR / job["id"] / "meta.json").write_text(json.dumps(job, ensure_ascii=False), encoding="utf-8")


def _public(job: dict) -> dict:
    out = dict(job)
    d = JOBS_DIR / job["id"]
    out["output_path"] = str(d / job["output_name"]) if job["status"] == "done" else None
    return out


def _load_jobs() -> None:
    """Traduções feitas antes (sobrevivem ao reinício do app). As que estavam no meio ficam como interrompidas."""
    if _jobs or not JOBS_DIR.is_dir():
        return
    for d in JOBS_DIR.iterdir():
        try:
            job = json.loads((d / "meta.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if job.get("status") in ("queued", "running"):
            job.update(status="error", error="Interrompida (o app foi fechado durante a tradução)")
            _save(job)
        _jobs[job["id"]] = job


def _output_name(name: str, to_code: str) -> str:
    stem, ext = Path(name).stem, Path(name).suffix.lower()
    lang = {"pb": "pt-BR", "zt": "zh-Hant"}.get(to_code, to_code)  # códigos próprios do Argos → nome usual
    return f"{stem}.{lang}{ext}"


_dark_locks: dict[str, threading.Lock] = {}


def _variant(job: dict, which: str, theme: str) -> Path:
    """Arquivo do original ou da tradução no tema pedido. O tema escuro (só PDF) é gerado na primeira vez que
    alguém pede (para ver, abrir ou salvar) e fica guardado ao lado: "<nome>.escuro.pdf"."""
    d = JOBS_DIR / job["id"]
    base = d / (job["output_name"] if which == "translated" else f"original{job['ext']}")
    if theme != "dark" or job["ext"] != ".pdf" or not base.is_file():
        return base
    dark = base.with_name(f"{base.stem}.escuro{base.suffix}")
    lock = _dark_locks.setdefault(str(dark), threading.Lock())
    with lock:  # as duas metades da comparação podem pedir ao mesmo tempo
        if not dark.is_file() or dark.stat().st_mtime < base.stat().st_mtime:
            tmp = dark.with_name(f"{dark.stem}.tmp.pdf")
            shutil.copyfile(base, tmp)
            darken_pdf(tmp)
            tmp.replace(dark)
    return dark


@router.get("")
async def list_jobs() -> list[dict]:
    _load_jobs()
    return [_public(j) for j in sorted(_jobs.values(), key=lambda j: j["created_at"], reverse=True)]


@router.post("")
async def create_job(
    request: Request,
    file: UploadFile = File(...),
    from_code: str = Form(...),
    to_code: str = Form(...),

) -> dict:
    _load_jobs()
    name = Path(file.filename or "arquivo").name
    ext = Path(name).suffix.lower()
    if ext not in SUPPORTED_EXTS:
        raise HTTPException(400, f"Formato não suportado ({ext or 'sem extensão'}). Use: "
                                 + ", ".join(sorted(e[1:].upper() for e in SUPPORTED_EXTS)))
    if from_code == to_code:
        raise HTTPException(400, "Escolha idiomas diferentes")

    job_id = uuid.uuid4().hex[:12]
    d = JOBS_DIR / job_id
    d.mkdir(parents=True, exist_ok=True)
    src = d / f"original{ext}"
    size = 0
    with src.open("wb") as f:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_UPLOAD:
                f.close()
                shutil.rmtree(d, ignore_errors=True)
                raise HTTPException(413, "Arquivo grande demais (máximo de 200 MB)")
            f.write(chunk)

    job = {
        "id": job_id,
        "name": name,
        "ext": ext,
        "from_code": from_code,
        "to_code": to_code,
        "status": "queued",
        "progress": 0.0,
        "message": "Na fila",
        "error": None,
        "pages": None,
        "output_name": _output_name(name, to_code),
        "size": size,
        "created_at": time.time(),
        "finished_at": None,
    }
    _jobs[job_id] = job
    _save(job)

    orch = request.app.state.orchestrator
    asyncio.create_task(asyncio.to_thread(_run, job_id, orch))
    return _public(job)


def _run(job_id: str, orch) -> None:
    state = orch.state
    job = _jobs[job_id]
    last_emit = [0.0]

    def emit(force: bool = False) -> None:
        now = time.monotonic()
        if force or now - last_emit[0] > 0.3:
            last_emit[0] = now
            state.emit({"type": "translate_file", "file_job": _public(job)})

    with _lock:
        if job_id in _cancel or job_id not in _jobs:
            return
        job.update(status="running", message="Preparando o modelo de tradução")
        emit(True)
        d = JOBS_DIR / job_id
        try:
            # mesmo dispositivo do Whisper (GPU, se houver)
            if orch.engine:
                import argostranslate.settings as argos_settings

                argos_settings.device = orch.engine._loaded_device
            tr = Translator(job["from_code"], job["to_code"])

            def progress(frac: float, msg: str) -> None:
                if job_id in _cancel:
                    raise Canceled()
                job["progress"] = round(min(max(frac, 0.0), 1.0) * 100, 1)
                job["message"] = msg
                emit()

            info = translate_file(d / f"original{job['ext']}", d / job["output_name"], tr, progress)
            job.update(status="done", progress=100.0, message="Pronto", pages=info.get("pages"))
        except Canceled:
            return
        except Exception as e:  # noqa: BLE001 — o erro aparece para o usuário na lista
            job.update(status="error", error=str(e) or e.__class__.__name__, message="Erro")
        finally:
            if job_id not in _cancel:
                job["finished_at"] = time.time()
                _save(job)
                emit(True)


@router.delete("", status_code=204)
async def delete_all() -> None:
    """Apaga todas as traduções de arquivos terminadas (as que estão em andamento continuam)."""
    _load_jobs()
    for job in list(_jobs.values()):
        if job["status"] in ("done", "error"):
            _jobs.pop(job["id"], None)
            await asyncio.to_thread(shutil.rmtree, JOBS_DIR / job["id"], True)


@router.delete("/{job_id}", status_code=204)
async def delete_job(job_id: str) -> None:
    d = _job_dir(job_id)
    _cancel.add(job_id)
    _jobs.pop(job_id, None)
    # se estiver traduzindo, a tarefa para no próximo trecho; a pasta sai quando ela soltar os arquivos
    for _ in range(50):
        try:
            shutil.rmtree(d)
            break
        except FileNotFoundError:
            break
        except OSError:
            await asyncio.sleep(0.1)


@router.get("/{job_id}/file")
async def file_path(job_id: str, theme: str = "original") -> dict:
    """Caminho do arquivo traduzido no tema escolhido (para abrir, salvar uma cópia ou mostrar na pasta)."""
    job = _jobs.get(job_id)
    _job_dir(job_id)
    if not job or job["status"] != "done":
        raise HTTPException(404, "Tradução não encontrada")
    path = await asyncio.to_thread(_variant, job, "translated", theme)
    if not path.is_file():
        raise HTTPException(404, "Arquivo não encontrado")
    return {"path": str(path), "name": path.name}


@router.get("/{job_id}/download")
async def download(job_id: str) -> FileResponse:
    job = _jobs.get(job_id)
    path = _job_dir(job_id) / (job or {}).get("output_name", "")
    if not job or job["status"] != "done" or not path.is_file():
        raise HTTPException(404, "Tradução não encontrada")
    return FileResponse(path, filename=job["output_name"])


# Imagens de páginas já desenhadas (voltar a uma página ou trocar de lado é instantâneo). Desenhar uma página em
# alta resolução leva ~0,3 s e as páginas são desenhadas uma de cada vez, então guardar faz muita diferença.
_IMG_CACHE_MAX = 160 * 1024 * 1024
_img_cache: "OrderedDict[tuple, bytes]" = OrderedDict()
_img_cache_bytes = 0
_render_lock = threading.Lock()


def _render_cached(path: Path, page: int, scale: float, rotate: int) -> bytes:
    global _img_cache_bytes
    key = (str(path), path.stat().st_mtime, page, scale, rotate)
    with _render_lock:
        png = _img_cache.get(key)
        if png is not None:
            _img_cache.move_to_end(key)
            return png
        png, _ = render_pdf_page(path, page, scale, rotate)
        _img_cache[key] = png
        _img_cache_bytes += len(png)
        while _img_cache_bytes > _IMG_CACHE_MAX and _img_cache:
            _, old = _img_cache.popitem(last=False)
            _img_cache_bytes -= len(old)
        return png


@router.get("/{job_id}/pages")
async def page_sizes(job_id: str) -> dict:
    """Tamanho de cada página (em pontos), para a tela de comparação já abrir no tamanho certo."""
    job = _jobs.get(job_id)
    path = _job_dir(job_id) / (job or {}).get("output_name", "")
    if not job or job["ext"] != ".pdf" or not path.is_file():
        raise HTTPException(404, "Tradução não encontrada")

    def sizes() -> list[list[float]]:
        import pymupdf

        with pymupdf.open(path) as doc:
            return [[round(p.rect.width, 1), round(p.rect.height, 1)] for p in doc]

    return {"sizes": await asyncio.to_thread(sizes)}


@router.get("/{job_id}/preview")
async def preview(
    job_id: str, page: int = 0, which: str = "translated", scale: float = 1.4, rotate: int = 0, theme: str = "original"
) -> Response:
    """Imagem de uma página do PDF (original ou traduzido), para comparar lado a lado."""
    job = _jobs.get(job_id)
    d = _job_dir(job_id)
    if not job or job["ext"] != ".pdf":
        raise HTTPException(404, "Prévia disponível só para PDF")
    if not d.is_dir():
        raise HTTPException(404, "Arquivo não encontrado")
    path = await asyncio.to_thread(_variant, job, "translated" if which == "translated" else "original", theme)
    if not path.is_file():
        raise HTTPException(404, "Arquivo não encontrado")
    scale = min(max(scale, 0.5), 4.0)  # mais resolução quando a tela de comparação está com zoom
    png = await asyncio.to_thread(_render_cached, path, page, scale, rotate if rotate in (0, 90, 180, 270) else 0)
    # o endereço muda com página, tema, zoom e giro: a tela pode guardar a imagem (páginas já vistas abrem na hora)
    return Response(png, media_type="image/png", headers={"Cache-Control": "private, max-age=86400"})
