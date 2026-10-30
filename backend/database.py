import json

import aiosqlite

from .config import DATA_DIR, DB_PATH, DEFAULT_SETTINGS


SCHEMA = """
CREATE TABLE IF NOT EXISTS transcription_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    mode TEXT NOT NULL,
    model TEXT NOT NULL,
    device TEXT NOT NULL,
    compute_type TEXT NOT NULL,
    audio_s REAL NOT NULL,
    proc_s REAL NOT NULL,
    rtf REAL,
    text TEXT NOT NULL,
    ai_response TEXT
);

CREATE INDEX IF NOT EXISTS idx_logs_ts ON transcription_logs(ts DESC);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
"""


async def init_db() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript(SCHEMA)
        cur = await db.execute("SELECT COUNT(*) FROM settings")
        row = await cur.fetchone()
        if row and row[0] == 0:
            for key, value in DEFAULT_SETTINGS.items():
                await db.execute(
                    "INSERT INTO settings (key, value) VALUES (?, ?)",
                    (key, json.dumps(value)),
                )
        await db.commit()


async def get_db() -> aiosqlite.Connection:
    db = await aiosqlite.connect(DB_PATH)
    db.row_factory = aiosqlite.Row
    return db
