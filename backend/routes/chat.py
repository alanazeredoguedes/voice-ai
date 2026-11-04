import asyncio
import queue
import sqlite3
import threading

import aiosqlite
from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from pydantic import BaseModel

from ..config import DB_PATH
from ..services.brain import ClaudeBrain

router = APIRouter(prefix="/chat", tags=["chat"])


class MessageBody(BaseModel):
    text: str


def _save_sync(role: str, content: str) -> int:
    with sqlite3.connect(DB_PATH) as conn:
        cur = conn.execute(
            "INSERT INTO chat_messages (role, content) VALUES (?, ?)",
            (role, content),
        )
        conn.commit()
        return cur.lastrowid


@router.get("/history")
async def get_history(limit: int = 200) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT id, ts, role, content FROM chat_messages ORDER BY id ASC LIMIT ?",
            (limit,),
        )
        rows = await cur.fetchall()
        return [dict(r) for r in rows]


@router.post("/message", status_code=202)
async def send_message(
    body: MessageBody,
    background_tasks: BackgroundTasks,
    request: Request,
) -> dict:
    if not body.text.strip():
        raise HTTPException(400, "Mensagem vazia")

    orchestrator = request.app.state.orchestrator
    state = orchestrator.state
    chat_brain: ClaudeBrain | None = orchestrator.chat_brain

    if chat_brain is None:
        raise HTTPException(503, "Chat brain não inicializado")

    user_msg_id = _save_sync("user", body.text)

    def do_chat() -> None:
        tts = orchestrator.tts
        chunks: list[str] = []
        sentence_q: queue.Queue = queue.Queue()
        audio_q: queue.Queue = queue.Queue(maxsize=3)

        def _prepare_audio() -> None:
            try:
                while True:
                    sentence = sentence_q.get()
                    if sentence is None:
                        break
                    if tts and not orchestrator._tts_muted:
                        path = tts.prepare(sentence)
                        audio_q.put((sentence, path))
                    else:
                        audio_q.put((sentence, None))
            except Exception as e:
                print(f"[chat] prepare error: {e}", flush=True)
            finally:
                audio_q.put(None)

        threading.Thread(target=_prepare_audio, daemon=True).start()

        try:
            for sentence in chat_brain.ask_stream(body.text):
                chunks.append(sentence)
                state.emit({"type": "chat_chunk", "text": sentence, "done": False})
                sentence_q.put(sentence)
        except Exception as e:
            print(f"[chat] erro no stream: {e}", flush=True)
            state.emit({"type": "chat_error", "error": str(e)})
            sentence_q.put(None)
            return

        sentence_q.put(None)

        while True:
            item = audio_q.get()
            if item is None:
                break
            _, path = item
            if path and tts and not orchestrator._tts_muted:
                tts.play_prepared(path)

        full = " ".join(chunks)
        if full:
            msg_id = _save_sync("assistant", full)
            state.emit({
                "type": "chat_chunk",
                "text": "",
                "message_id": msg_id,
                "user_message_id": user_msg_id,
                "done": True,
            })
        else:
            state.emit({"type": "chat_chunk", "text": "", "done": True})

    background_tasks.add_task(asyncio.to_thread, do_chat)
    return {"queued": True}


@router.delete("/messages/{message_id}", status_code=204)
async def delete_message(message_id: int) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM chat_messages WHERE id = ?", (message_id,))
        await db.commit()


@router.delete("/history", status_code=204)
async def clear_history(request: Request) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM chat_messages")
        await db.commit()

    orchestrator = request.app.state.orchestrator
    orchestrator.chat_brain = ClaudeBrain({**orchestrator.settings, "claude_continue": True})
