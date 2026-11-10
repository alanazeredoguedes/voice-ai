import asyncio
import queue
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from pydantic import BaseModel, Field

from ..services import chats as chat_db
from ..services import rich_text, speech_cache
from ..services.reply_stream import ReplyComposer
from ..services.media_search import MediaDispatcher

router = APIRouter(prefix="/chat", tags=["chat"])


class MessageBody(BaseModel):
    text: str


class ChatCreate(BaseModel):
    name: str = Field(default="Novo chat", max_length=80)
    system_prompt: str = ""


class ChatPatch(BaseModel):
    name: str | None = Field(default=None, max_length=80)
    system_prompt: str | None = None


def _manager(request: Request):
    orchestrator = request.app.state.orchestrator
    if orchestrator is None or orchestrator.chats is None:
        raise HTTPException(503, "Chat não inicializado")
    return orchestrator, orchestrator.chats


def _require_chat(chat_id: int) -> dict:
    chat = chat_db.get_chat(chat_id)
    if chat is None:
        raise HTTPException(404, "Chat não encontrado")
    return chat


def _public(chat: dict) -> dict:
    return {k: v for k, v in chat.items() if k not in ("session_id", "session_key")}


# ---------- chats ----------

@router.get("/chats")
async def list_chats(request: Request) -> dict:
    _, manager = _manager(request)
    active = await asyncio.to_thread(lambda: manager.active_id)
    chats = await asyncio.to_thread(chat_db.list_chats)
    return {"chats": chats, "active_id": active, "busy_chat_id": manager.busy_chat_id}


@router.post("/chats", status_code=201)
async def create_chat(body: ChatCreate, request: Request) -> dict:
    orchestrator, manager = _manager(request)
    chat = await asyncio.to_thread(chat_db.create_chat, body.name, body.system_prompt)
    manager.set_active(chat["id"])
    orchestrator.state.emit({"type": "chats_changed"})
    return _public(chat)


@router.patch("/chats/{chat_id}")
async def update_chat(chat_id: int, body: ChatPatch, request: Request) -> dict:
    orchestrator, _ = _manager(request)
    _require_chat(chat_id)
    chat = await asyncio.to_thread(chat_db.update_chat, chat_id, body.name, body.system_prompt)
    orchestrator.state.emit({"type": "chats_changed"})
    return _public(chat)


@router.delete("/chats/{chat_id}")
async def delete_chat(chat_id: int, request: Request) -> dict:
    orchestrator, manager = _manager(request)
    _require_chat(chat_id)
    if manager.busy_chat_id == chat_id:
        raise HTTPException(409, "Esse chat está respondendo agora. Aguarde terminar para excluir.")
    manager.drop(chat_id)
    await asyncio.to_thread(chat_db.delete_chat, chat_id)
    # sempre existe pelo menos um chat; o ativo passa a ser o mais recente
    remaining = await asyncio.to_thread(chat_db.list_chats)
    if not remaining:
        remaining = [await asyncio.to_thread(chat_db.create_chat, "Novo chat")]
    if orchestrator.settings.get("active_chat_id") == chat_id:
        manager.set_active(remaining[0]["id"])
    orchestrator.state.emit({"type": "chats_changed"})
    return {"active_id": manager.active_id}


@router.post("/chats/{chat_id}/activate")
async def activate_chat(chat_id: int, request: Request) -> dict:
    orchestrator, manager = _manager(request)
    _require_chat(chat_id)
    manager.set_active(chat_id)
    orchestrator.state.emit({"type": "chats_changed"})
    return {"active_id": chat_id}


# ---------- mensagens ----------

@router.get("/usage")
async def plan_usage() -> dict:
    """Uso do plano do Claude: % da sessão (5 h) e do limite semanal, do último valor recebido."""
    from ..services import claude_usage

    return {"usage": claude_usage.get()}


@router.post("/usage/refresh")
async def plan_usage_refresh() -> dict:
    """Atualiza os números agora (chamada mínima ao Claude Code, com o Haiku)."""
    from ..services import brain, claude_usage

    usage = await asyncio.to_thread(claude_usage.refresh, brain._CLAUDE_BIN, brain._claude_cwd(), brain._claude_env())
    return {"usage": usage}


@router.get("/model")
async def claude_model(request: Request) -> dict:
    """Modelo do Claude escolhido no app e o nome real de cada um (de quando já respondeu)."""
    from ..services.brain import CLAUDE_MODELS, DEFAULT_CLAUDE_MODEL, resolved_models

    orchestrator = request.app.state.orchestrator
    selected = (orchestrator.settings.get("claude_model") if orchestrator else None) or DEFAULT_CLAUDE_MODEL
    return {"selected": selected, "options": list(CLAUDE_MODELS), "resolved": dict(resolved_models)}


@router.get("/chats/{chat_id}/messages")
async def get_messages(chat_id: int, request: Request, limit: int = 500) -> list[dict]:
    _require_chat(chat_id)
    msgs = await asyncio.to_thread(chat_db.get_messages, chat_id, limit)
    tts = request.app.state.orchestrator.tts if request.app.state.orchestrator else None
    if tts:
        voice = tts.voice_key()

        def _pct() -> None:
            for m in msgs:
                if m["role"] == "assistant":
                    m["audio_pct"] = speech_cache.coverage(chat_id, m["id"], voice, rich_text.to_plain(m["content"]))
                    m["audio_bytes"] = speech_cache.message_bytes(chat_id, m["id"])

        await asyncio.to_thread(_pct)
    return msgs


@router.delete("/chats/{chat_id}/messages", status_code=204)
async def clear_messages(chat_id: int, request: Request) -> None:
    orchestrator, manager = _manager(request)
    _require_chat(chat_id)
    if manager.busy_chat_id == chat_id:
        raise HTTPException(409, "Esse chat está respondendo agora. Aguarde terminar.")
    await asyncio.to_thread(chat_db.clear_messages, chat_id)
    manager.reset(chat_id)
    orchestrator.state.emit({"type": "chats_changed"})


@router.delete("/chats/{chat_id}/speech-cache", status_code=204)
async def clear_speech_cache(chat_id: int) -> None:
    """Apaga só os áudios salvos deste chat (as mensagens continuam; o áudio é gerado de novo se pedir)."""
    await asyncio.to_thread(speech_cache.delete_chat, chat_id)


@router.get("/messages/{message_id}/audio-ranges")
async def audio_ranges(message_id: int, request: Request) -> dict:
    """Trechos do texto da resposta que já têm áudio salvo (a tela marca ao passar o mouse na %)."""
    m = await asyncio.to_thread(chat_db.get_message, message_id)
    tts = request.app.state.orchestrator.tts if request.app.state.orchestrator else None
    if not m or m["role"] != "assistant" or not tts:
        return {"ranges": [], "audio_pct": 0}
    voice = tts.voice_key()
    plain = rich_text.to_plain(m["content"])  # posições da fala são no texto falado
    ranges = await asyncio.to_thread(speech_cache.covered_ranges, m["chat_id"], message_id, voice, plain)
    pct = await asyncio.to_thread(speech_cache.coverage, m["chat_id"], message_id, voice, plain)
    return {"ranges": ranges, "audio_pct": pct}


@router.delete("/messages/{message_id}", status_code=204)
async def delete_message(message_id: int) -> None:
    await asyncio.to_thread(chat_db.delete_message, message_id)


@router.post("/chats/{chat_id}/message", status_code=202)
async def send_message(
    chat_id: int,
    body: MessageBody,
    background_tasks: BackgroundTasks,
    request: Request,
) -> dict:
    if not body.text.strip():
        raise HTTPException(400, "Mensagem vazia")
    t0 = time.perf_counter()
    orchestrator, manager = _manager(request)
    _require_chat(chat_id)
    state = orchestrator.state

    if not manager.try_begin(chat_id):
        raise HTTPException(409, "Aguarde a resposta atual terminar.")
    try:
        brain = manager.get_brain(chat_id)
        # salva antes de chamar o Claude (o histórico de reserva da sessão depende disso)
        user_msg_id = chat_db.save_message(chat_id, "user", body.text)
    except Exception:
        manager.end(chat_id)
        raise

    def emit(event: dict) -> None:
        state.emit({**event, "chat_id": chat_id})

    tools: list[dict] = []

    def on_tool(name: str, detail: str) -> None:
        tools.append({"name": name, "detail": detail})
        emit({"type": "chat_activity", "tool": name, "detail": detail})

    def do_chat() -> None:
        try:
            _run_chat()
        finally:
            manager.end(chat_id)
            state.emit({"type": "chats_changed"})

    def _run_chat() -> None:
        tts = orchestrator.tts
        sentence_q: queue.Queue = queue.Queue()
        audio_q: queue.Queue = queue.Queue(maxsize=3)
        media = MediaDispatcher(emit, orchestrator.settings)
        orchestrator._speech_stop.clear()  # nova resposta: "parar fala" anterior não vale mais

        # Gera o áudio de até 3 frases ao mesmo tempo (o serviço de voz leva 1 a 2,5 s por frase,
        # quase tudo latência): a fala acompanha o texto em vez de ir uma frase por vez.
        pool = ThreadPoolExecutor(max_workers=3, thread_name_prefix="tts")

        # cada frase vai para o disco assim que o áudio chega (a % de áudio salvo sobe durante a geração)
        saver = speech_cache.LiveSaver(
            chat_id, orchestrator.settings.get("speech_cache_limit_mb", speech_cache.DEFAULT_LIMIT_MB)
        )

        def _prepare_and_keep(sentence: str, offset: int) -> str | None:
            path = tts.prepare(sentence)
            if path:
                words, voice = tts.peek_meta(path)
                saver.add(sentence, offset, path, words, voice)
            return path

        def _prepare_audio() -> None:
            try:
                while True:
                    item = sentence_q.get()
                    if item is None:
                        break
                    sentence, offset = item
                    if tts and not orchestrator._tts_muted:
                        audio_q.put((sentence, offset, pool.submit(_prepare_and_keep, sentence, offset)))
                    else:
                        audio_q.put((sentence, offset, None))
            except Exception as e:
                print(f"[chat] prepare error: {e}", flush=True)
            finally:
                audio_q.put(None)

        def _words_emitter(ref: str, sentence: str):
            def _on_start(words, speed, lead) -> None:
                # tempo de cada palavra da frase que começou a tocar: a tela destaca o trecho falado
                if words:
                    emit({"type": "tts_words", "ref": ref, "text": sentence, "words": words,
                          "speed": speed, "lead": lead})
            return _on_start

        def _play_audio() -> None:
            """Fala cada frase assim que o áudio dela fica pronto, enquanto o resto do texto ainda chega."""
            speaking = False
            try:
                while True:
                    item = audio_q.get()
                    if item is None:
                        break
                    sentence, offset, fut = item
                    path = fut.result() if fut else None
                    if not path:
                        continue
                    if tts and not orchestrator._tts_muted and not orchestrator._speech_stop.is_set():
                        if not speaking:
                            orchestrator.emit_speaking("live", True, chat_id)
                            speaking = True
                        # a 1ª vez toca o MP3 que chegou do serviço (a cópia guardada vira Opus depois)
                        words, _ = tts.take_meta(path)
                        try:
                            tts.play_file(path, words, on_start=_words_emitter("live", sentence))
                        finally:
                            Path(path).unlink(missing_ok=True)
                    else:
                        # mudo ou "parar fala": descarta o áudio, o texto já foi para o chat
                        Path(path).unlink(missing_ok=True)
            except Exception as e:
                print(f"[chat] play error: {e}", flush=True)
            finally:
                pool.shutdown(wait=False)
                if speaking:
                    orchestrator.emit_speaking("live", False, chat_id)

        threading.Thread(target=_prepare_audio, daemon=True).start()
        player = threading.Thread(target=_play_audio, daemon=True)
        player.start()

        # markdown da resposta + frases para a voz (com a posição de cada uma no texto falado)
        composer = ReplyComposer()
        try:
            for delta in brain.ask_stream(body.text, on_media=media.request, on_tool=on_tool):
                delta, sentences = composer.feed(delta)
                if delta:
                    emit({"type": "chat_delta", "text": delta})
                for sentence, offset in sentences:
                    sentence_q.put((sentence, offset))
            for sentence, offset in composer.finish():
                sentence_q.put((sentence, offset))
        except Exception as e:
            print(f"[chat] erro no stream: {e}", flush=True)
            emit({"type": "chat_error", "error": str(e)})
            sentence_q.put(None)
            player.join()
            return

        sentence_q.put(None)
        duration = time.perf_counter() - t0  # tempo até a resposta (texto) ficar completa

        # Texto completo: salva e mostra hora/tempo/botões já, sem esperar a fala terminar.
        # "speaking" avisa a UI que o chat ainda está ocupado (falando) até o "chats_changed" do fim.
        full = composer.md.strip()
        attachments = media.wait_all() if media.has_requests else []
        msg_id = None
        if full or attachments:
            msg_id = chat_db.save_message(chat_id, "assistant", full, attachments, duration, tools)
            saver.set_message(msg_id)  # grava o áudio que já tinha chegado antes do id existir
            emit({
                "type": "chat_chunk",
                "text": "",
                "message_id": msg_id,
                "user_message_id": user_msg_id,
                "done": True,
                "duration_s": round(duration, 2),
                "tools": tools,
                "still_busy": True,
            })
        else:
            emit({"type": "chat_chunk", "text": "", "done": True, "still_busy": True})

        player.join()
        if msg_id is None:
            saver.set_message(None)  # sem resposta salva: descarta

    background_tasks.add_task(asyncio.to_thread, do_chat)
    return {"queued": True, "user_message_id": user_msg_id}
