from fastapi import APIRouter, Query

import aiosqlite

from ..config import DB_PATH
from ..models import LogOut, LogsPage

router = APIRouter(prefix="/logs", tags=["logs"])


@router.get("", response_model=LogsPage)
async def list_logs(
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> LogsPage:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute("SELECT COUNT(*) AS c FROM transcription_logs")
        total_row = await cur.fetchone()
        total = total_row["c"] if total_row else 0
        cur = await db.execute(
            "SELECT * FROM transcription_logs ORDER BY ts DESC LIMIT ? OFFSET ?",
            (limit, offset),
        )
        rows = await cur.fetchall()
    items = [LogOut(**dict(row)) for row in rows]
    return LogsPage(items=items, total=total)


@router.delete("", status_code=204)
async def clear_logs() -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM transcription_logs")
        await db.commit()
