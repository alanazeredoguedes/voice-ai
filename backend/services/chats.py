"""Vários chats no Chat IA: cada um com nome, system prompt, histórico e sessão do Claude próprios.

Acesso ao banco é síncrono (sqlite3): é chamado tanto das rotas quanto das threads de resposta.
"""
import json
import sqlite3
import threading
from typing import Any

from ..config import DB_PATH
from . import rich_text
from .brain import ClaudeBrain

# Quantas mensagens anteriores vão junto quando uma conversa precisa recomeçar no Claude
HISTORY_SEED_MESSAGES = 20
HISTORY_SEED_CHARS = 600

_CHAT_COLS = "id, name, system_prompt, session_id, session_key, created_at, updated_at"


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _chat_row(r: sqlite3.Row) -> dict[str, Any]:
    return {k: r[k] for k in r.keys()}


def list_chats() -> list[dict[str, Any]]:
    with _conn() as conn:
        rows = conn.execute(
            f"""
            SELECT c.id, c.name, c.system_prompt, c.created_at, c.updated_at,
                   (SELECT COUNT(*) FROM chat_messages m WHERE m.chat_id = c.id) AS message_count,
                   (SELECT m.content FROM chat_messages m WHERE m.chat_id = c.id ORDER BY m.id DESC LIMIT 1)
                       AS last_message
            FROM chats c
            ORDER BY c.updated_at DESC, c.id DESC
            """
        ).fetchall()
    from . import speech_cache

    usage = speech_cache.usage()["chats"]
    out = []
    for r in rows:
        d = _chat_row(r)
        last = rich_text.to_plain(d.get("last_message") or "").strip().replace("\n", " ")
        d["last_message"] = last[:120]
        d["audio_bytes"] = usage.get(d["id"], {}).get("bytes", 0)  # áudios salvos das respostas
        out.append(d)
    return out


def get_chat(chat_id: int) -> dict[str, Any] | None:
    with _conn() as conn:
        r = conn.execute(f"SELECT {_CHAT_COLS} FROM chats WHERE id = ?", (chat_id,)).fetchone()
    return _chat_row(r) if r else None


def create_chat(name: str, system_prompt: str = "") -> dict[str, Any]:
    with _conn() as conn:
        cur = conn.execute(
            "INSERT INTO chats (name, system_prompt) VALUES (?, ?)",
            (name.strip() or "Novo chat", (system_prompt or "").strip()),
        )
        conn.commit()
        chat_id = cur.lastrowid
    return get_chat(chat_id)  # type: ignore[return-value]


def update_chat(chat_id: int, name: str | None = None, system_prompt: str | None = None) -> dict[str, Any] | None:
    sets, args = [], []
    if name is not None:
        sets.append("name = ?")
        args.append(name.strip() or "Sem nome")
    if system_prompt is not None:
        sets.append("system_prompt = ?")
        args.append(system_prompt.strip())
    if sets:
        with _conn() as conn:
            conn.execute(f"UPDATE chats SET {', '.join(sets)} WHERE id = ?", (*args, chat_id))
            conn.commit()
    return get_chat(chat_id)


def delete_chat(chat_id: int) -> None:
    from . import speech_cache

    with _conn() as conn:
        conn.execute("DELETE FROM chat_messages WHERE chat_id = ?", (chat_id,))
        conn.execute("DELETE FROM chats WHERE id = ?", (chat_id,))
        conn.commit()
    speech_cache.delete_chat(chat_id)


def clear_messages(chat_id: int) -> None:
    from . import speech_cache

    speech_cache.delete_chat(chat_id)
    with _conn() as conn:
        conn.execute("DELETE FROM chat_messages WHERE chat_id = ?", (chat_id,))
        conn.execute("UPDATE chats SET session_id = NULL, session_key = NULL WHERE id = ?", (chat_id,))
        conn.commit()


def save_session(chat_id: int, session_id: str | None, session_key: str | None) -> None:
    with _conn() as conn:
        conn.execute(
            "UPDATE chats SET session_id = ?, session_key = ? WHERE id = ?", (session_id, session_key, chat_id)
        )
        conn.commit()


def save_message(
    chat_id: int,
    role: str,
    content: str,
    attachments: list[dict] | None = None,
    duration_s: float | None = None,
    tools: list[dict] | None = None,
) -> int:
    with _conn() as conn:
        cur = conn.execute(
            "INSERT INTO chat_messages (chat_id, role, content, attachments, duration_s, tools) VALUES (?, ?, ?, ?, ?, ?)",
            (
                chat_id,
                role,
                content,
                json.dumps(attachments, ensure_ascii=False) if attachments else None,
                round(duration_s, 2) if duration_s is not None else None,
                json.dumps(tools, ensure_ascii=False) if tools else None,
            ),
        )
        conn.execute("UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", (chat_id,))
        conn.commit()
        return cur.lastrowid


def delete_message(message_id: int) -> None:
    from . import speech_cache

    with _conn() as conn:
        row = conn.execute("SELECT chat_id FROM chat_messages WHERE id = ?", (message_id,)).fetchone()
        conn.execute("DELETE FROM chat_messages WHERE id = ?", (message_id,))
        conn.commit()
    speech_cache.delete_message(row["chat_id"] if row else None, message_id)


def get_message(message_id: int) -> dict | None:
    with _conn() as conn:
        r = conn.execute("SELECT id, chat_id, role, content FROM chat_messages WHERE id = ?", (message_id,)).fetchone()
    return _chat_row(r) if r else None


def get_messages(chat_id: int, limit: int = 500) -> list[dict[str, Any]]:
    with _conn() as conn:
        rows = conn.execute(
            """SELECT id, ts, role, content, attachments, duration_s, tools FROM (
                   SELECT id, ts, role, content, attachments, duration_s, tools FROM chat_messages
                   WHERE chat_id = ? ORDER BY id DESC LIMIT ?
               ) ORDER BY id ASC""",
            (chat_id, limit),
        ).fetchall()
    out = []
    for r in rows:
        d = _chat_row(r)
        raw = d.pop("attachments", None)
        try:
            d["media"] = json.loads(raw) if raw else []
        except ValueError:
            d["media"] = []
        raw_tools = d.pop("tools", None)
        try:
            d["tools"] = json.loads(raw_tools) if raw_tools else []
        except ValueError:
            d["tools"] = []
        out.append(d)
    return out


def history_seed(chat_id: int, question: str) -> str:
    """Resumo das últimas mensagens do chat, para quando a sessão do Claude precisa recomeçar
    (system prompt editado ou sessão apagada pela limpeza automática do Claude Code)."""
    with _conn() as conn:
        rows = conn.execute(
            "SELECT role, content FROM chat_messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?",
            (chat_id, HISTORY_SEED_MESSAGES + 1),
        ).fetchall()
    # respostas: só o texto (sem formatação nem marcadores de imagem)
    msgs = [(r["role"], (r["content"] or "").strip() if r["role"] == "user" else rich_text.to_plain(r["content"] or ""))
            for r in reversed(rows)]
    # a pergunta atual já foi salva antes de chamar o Claude: não repete
    if msgs and msgs[-1][0] == "user" and msgs[-1][1] == question.strip():
        msgs.pop()
    msgs = [m for m in msgs if m[1]][-HISTORY_SEED_MESSAGES:]
    if not msgs:
        return ""
    lines = []
    for role, content in msgs:
        if len(content) > HISTORY_SEED_CHARS:
            content = content[:HISTORY_SEED_CHARS] + "..."
        lines.append(f"{'Usuário' if role == 'user' else 'Você'}: {content}")
    return (
        "[Histórico desta conversa até aqui, para você manter o contexto. Não comente sobre ele.]\n"
        + "\n".join(lines)
        + "\n[Fim do histórico]\n\n"
    )


class ChatManager:
    """Um ClaudeBrain por chat (criado sob demanda) e o chat ativo, que recebe as perguntas por voz."""

    def __init__(self, settings: dict[str, Any]) -> None:
        self._settings = settings
        self._brains: dict[int, ClaudeBrain] = {}
        self._lock = threading.Lock()
        # Uma resposta por vez no app inteiro (TTS é um só)
        self.busy_chat_id: int | None = None
        self._busy_lock = threading.Lock()

    # ---- chat ativo ----
    @property
    def active_id(self) -> int:
        cid = self._settings.get("active_chat_id")
        if isinstance(cid, int) and get_chat(cid):
            return cid
        chats = list_chats()
        cid = chats[0]["id"] if chats else create_chat("Novo chat")["id"]
        self.set_active(cid)
        return cid

    def set_active(self, chat_id: int) -> None:
        self._settings["active_chat_id"] = chat_id
        with _conn() as conn:
            conn.execute(
                """INSERT INTO settings (key, value, updated_at) VALUES ('active_chat_id', ?, CURRENT_TIMESTAMP)
                   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP""",
                (json.dumps(chat_id),),
            )
            conn.commit()

    # ---- brains ----
    def get_brain(self, chat_id: int) -> ClaudeBrain:
        chat = get_chat(chat_id)
        if chat is None:
            raise KeyError(chat_id)
        with self._lock:
            brain = self._brains.get(chat_id)
            if brain is None:
                brain = ClaudeBrain(
                    self._settings,
                    chat_prompt=chat["system_prompt"],
                    session_id=chat["session_id"],
                    session_key=chat["session_key"],
                    on_session=lambda sid, key, cid=chat_id: save_session(cid, sid, key),
                    history_seed=lambda q, cid=chat_id: history_seed(cid, q),
                )
                self._brains[chat_id] = brain
            else:
                brain.set_chat_prompt(chat["system_prompt"])
        return brain

    def reset(self, chat_id: int) -> None:
        """Mensagens apagadas: a próxima pergunta começa uma conversa nova no Claude."""
        with self._lock:
            brain = self._brains.get(chat_id)
        if brain:
            brain.reset_session()

    def drop(self, chat_id: int) -> None:
        with self._lock:
            brain = self._brains.pop(chat_id, None)
        if brain:
            brain.cancel()

    def update_settings(self, settings: dict[str, Any]) -> None:
        self._settings = settings
        with self._lock:
            for b in self._brains.values():
                b.update_settings(settings)

    def cancel_all(self) -> None:
        with self._lock:
            brains = list(self._brains.values())
        for b in brains:
            b.cancel()

    # ---- uma resposta por vez ----
    def try_begin(self, chat_id: int) -> bool:
        with self._busy_lock:
            if self.busy_chat_id is not None:
                return False
            self.busy_chat_id = chat_id
            return True

    def end(self, chat_id: int) -> None:
        with self._busy_lock:
            if self.busy_chat_id == chat_id:
                self.busy_chat_id = None
