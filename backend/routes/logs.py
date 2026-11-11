from fastapi import APIRouter, Query

import aiosqlite

from ..config import DB_PATH
from ..models import LogOut, LogsPage

router = APIRouter(prefix="/logs", tags=["logs"])


@router.get("", response_model=LogsPage)
async def list_logs(
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    mode: str | None = Query(None, pattern="^(transcription|ai|file)$"),
) -> LogsPage:
    """`mode`: só um tipo (transcription = microfone, ai = pergunta por voz, file = arquivo)."""
    where, args = ("WHERE mode = ?", [mode]) if mode else ("", [])
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(f"SELECT COUNT(*) AS c FROM transcription_logs {where}", args)
        total_row = await cur.fetchone()
        total = total_row["c"] if total_row else 0
        cur = await db.execute(
            f"SELECT * FROM transcription_logs {where} ORDER BY ts DESC LIMIT ? OFFSET ?",
            [*args, limit, offset],
        )
        rows = await cur.fetchall()
    items = [LogOut(**dict(row)) for row in rows]
    return LogsPage(items=items, total=total)


@router.delete("", status_code=204)
async def clear_logs() -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM transcription_logs")
        await db.commit()
