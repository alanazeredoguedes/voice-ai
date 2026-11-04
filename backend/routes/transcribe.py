import asyncio
import tempfile
from datetime import datetime
from pathlib import Path

import aiosqlite
from fastapi import APIRouter, File, HTTPException, Request, UploadFile

from ..config import DB_PATH

router = APIRouter(prefix="/transcribe", tags=["transcribe"])

ALLOWED = {".mp3", ".wav", ".ogg", ".m4a", ".flac", ".webm", ".aac", ".mp4", ".opus", ".wma", ".oga"}


@router.post("/file")
async def transcribe_audio_file(request: Request, file: UploadFile = File(...)) -> dict:
    suffix = Path(file.filename or "audio").suffix.lower() or ".audio"
    if suffix not in ALLOWED:
        raise HTTPException(400, f"Formato não suportado: {suffix}")

    content = await file.read()

    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(content)
        tmp_path = tmp.name

    orchestrator = request.app.state.orchestrator
    engine = orchestrator.engine
    if engine is None or engine._whisper is None:
        Path(tmp_path).unlink(missing_ok=True)
        raise HTTPException(503, "Engine ainda não carregado — aguarde e tente novamente")

    state = orchestrator.state

    def on_progress(pct: float) -> None:
        state.emit({"type": "transcription_progress", "progress": pct})

    try:
        result = await asyncio.to_thread(engine.transcribe_file, tmp_path, on_progress)
    except InterruptedError:
        raise HTTPException(400, "cancelled")
    except Exception as e:
        raise HTTPException(500, f"Erro na transcrição: {e}")
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    duration_s = result.get("duration_s", 0.0)
    proc_s = result.get("proc_s", 0.0)
    rtf = round(duration_s / proc_s, 1) if proc_s > 0 else None
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO transcription_logs
               (ts, mode, model, device, compute_type, audio_s, proc_s, rtf, text, ai_response)
               VALUES (?, 'file', ?, ?, ?, ?, ?, ?, ?, NULL)""",
            (
                datetime.now().isoformat(timespec="milliseconds"),
                result.get("model", ""),
                result.get("device", ""),
                engine._loaded_compute_type,
                duration_s,
                proc_s,
                rtf,
                result.get("text", ""),
            ),
        )
        await db.commit()

    return result


@router.post("/cancel", status_code=204)
async def cancel_transcription(request: Request) -> None:
    engine = request.app.state.orchestrator.engine
    if engine:
        engine.cancel_file_transcription()
