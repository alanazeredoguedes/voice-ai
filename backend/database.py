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
    ai_response TEXT,
    media TEXT
);

CREATE INDEX IF NOT EXISTS idx_logs_ts ON transcription_logs(ts DESC);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    role    TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    attachments TEXT
);

CREATE TABLE IF NOT EXISTS chats (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    system_prompt TEXT NOT NULL DEFAULT '',
    session_id    TEXT,
    session_key   TEXT,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
"""


async def init_db() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript(SCHEMA)
        # Migração: mídia (imagens/vídeos) anexada às respostas do chat, em JSON
        cur = await db.execute("PRAGMA table_info(chat_messages)")
        cols = {row[1] for row in await cur.fetchall()}
        if "attachments" not in cols:
            await db.execute("ALTER TABLE chat_messages ADD COLUMN attachments TEXT")
        # Migração: links das imagens/vídeos que a IA buscou, exibidos na tela de Logs
        cur = await db.execute("PRAGMA table_info(transcription_logs)")
        if "media" not in {row[1] for row in await cur.fetchall()}:
            await db.execute("ALTER TABLE transcription_logs ADD COLUMN media TEXT")
        cur = await db.execute("SELECT COUNT(*) FROM settings")
        row = await cur.fetchone()
        if row and row[0] == 0:
            for key, value in DEFAULT_SETTINGS.items():
                await db.execute(
                    "INSERT INTO settings (key, value) VALUES (?, ?)",
                    (key, json.dumps(value)),
                )
        # Migração: vários chats, cada um com histórico, system prompt e sessão do Claude próprios
        cur = await db.execute("PRAGMA table_info(chat_messages)")
        if "chat_id" not in {row[1] for row in await cur.fetchall()}:
            await db.execute("ALTER TABLE chat_messages ADD COLUMN chat_id INTEGER")
        await db.execute("CREATE INDEX IF NOT EXISTS idx_chat_messages_chat ON chat_messages(chat_id, id)")
        # Migração: tempo de resposta e ferramentas usadas (ex.: pesquisa na internet), exibidos abaixo da mensagem
        cur = await db.execute("PRAGMA table_info(chat_messages)")
        cols = {row[1] for row in await cur.fetchall()}
        if "duration_s" not in cols:
            await db.execute("ALTER TABLE chat_messages ADD COLUMN duration_s REAL")
        if "tools" not in cols:
            await db.execute("ALTER TABLE chat_messages ADD COLUMN tools TEXT")
        # Migração: como a transcrição foi feita (lote, sem silêncios, durante a fala), exibido nos Logs
        cur = await db.execute("PRAGMA table_info(transcription_logs)")
        if "method" not in {row[1] for row in await cur.fetchall()}:
            await db.execute("ALTER TABLE transcription_logs ADD COLUMN method TEXT")
        await _migrate_first_chat(db)
        await db.commit()


async def _settings_value(db: aiosqlite.Connection, key: str, default=None):
    cur = await db.execute("SELECT value FROM settings WHERE key = ?", (key,))
    row = await cur.fetchone()
    if not row:
        return default
    try:
        return json.loads(row[0])
    except ValueError:
        return default


async def _migrate_first_chat(db: aiosqlite.Connection) -> None:
    """Primeira execução com vários chats: o histórico atual vira a "Conversa principal",
    levando o system prompt que estava ativo nas Configurações."""
    cur = await db.execute("SELECT COUNT(*) FROM chats")
    if (await cur.fetchone())[0]:
        # mensagens órfãs (não deveria acontecer): vão para o chat ativo
        cur = await db.execute("SELECT COUNT(*) FROM chat_messages WHERE chat_id IS NULL")
        if (await cur.fetchone())[0]:
            active = await _settings_value(db, "active_chat_id")
            cur = await db.execute("SELECT id FROM chats ORDER BY updated_at DESC, id DESC LIMIT 1")
            fallback = (await cur.fetchone())[0]
            await db.execute(
                "UPDATE chat_messages SET chat_id = ? WHERE chat_id IS NULL",
                (active if isinstance(active, int) else fallback,),
            )
        return

    prompt = ""
    active_id = await _settings_value(db, "active_system_prompt_id")
    saved = [p for p in (await _settings_value(db, "system_prompts", []) or []) if isinstance(p, dict)]
    for p in saved:
        if active_id and p.get("id") == active_id:
            prompt = (p.get("text") or "").strip()
    # os outros prompts salvos (a lista sai das Configurações) viram chats próprios, para não se perderem
    for p in saved:
        text = (p.get("text") or "").strip()
        if text and p.get("id") != active_id:
            await db.execute(
                "INSERT INTO chats (name, system_prompt, updated_at) VALUES (?, ?, datetime('now', '-1 second'))",
                ((p.get("name") or "Chat").strip()[:80], text),
            )
    if not prompt:
        prompt = (await _settings_value(db, "system_prompt", "") or "").strip()

    cur = await db.execute(
        "INSERT INTO chats (name, system_prompt) VALUES (?, ?)", ("Conversa principal", prompt)
    )
    chat_id = cur.lastrowid
    await db.execute("UPDATE chat_messages SET chat_id = ? WHERE chat_id IS NULL", (chat_id,))
    await db.execute(
        """INSERT INTO settings (key, value, updated_at) VALUES ('active_chat_id', ?, CURRENT_TIMESTAMP)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP""",
        (json.dumps(chat_id),),
    )
    print(f"[db] chats: histórico atual migrado para 'Conversa principal' (id={chat_id})", flush=True)

