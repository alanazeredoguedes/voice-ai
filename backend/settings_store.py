import json
from typing import Any

import aiosqlite

from .config import DB_PATH


async def get_all() -> dict[str, Any]:
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute("SELECT key, value FROM settings")
        rows = await cur.fetchall()
    return {key: json.loads(value) for key, value in rows}


async def get(key: str, default: Any = None) -> Any:
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute("SELECT value FROM settings WHERE key=?", (key,))
        row = await cur.fetchone()
    if row is None:
        return default
    return json.loads(row[0])


async def update(patch: dict[str, Any]) -> dict[str, Any]:
    """UPSERT atômico para cada chave do patch. Retorna o estado completo após o update."""
    async with aiosqlite.connect(DB_PATH) as db:
        for key, value in patch.items():
            await db.execute(
                """
                INSERT INTO settings (key, value, updated_at)
                VALUES (?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (key, json.dumps(value)),
            )
        await db.commit()
        cur = await db.execute("SELECT key, value FROM settings")
        rows = await cur.fetchall()
    return {key: json.loads(value) for key, value in rows}
