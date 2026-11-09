import asyncio
import json
import os
import queue
import random
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import aiosqlite

from .config import DB_PATH
from .services.audio_feedback import sound_copied, sound_start, sound_stop
from .services import chats as chat_db
from .services.brain import ClaudeBrain
from .services.chats import ChatManager
from .services.hotkey_manager import HotkeyManager
from .services.media_search import MediaDispatcher
from .services.speech_engine import SpeechEngine
from .services.tts import TextToSpeech
from .settings_store import get_all as get_settings_all
from .state import StateManager

MIN_AI_WORDS = 3
_CANCEL_WINDOW = 0.8
_CANCEL_COUNT = 2


class Orchestrator:
    """Amarra speech_engine + brain + tts + hotkeys, com broadcast via StateManager.

    Equivalente ao main() do voice_ai_cmd.py, mas sem Qt.
    """

    def __init__(self, state: StateManager) -> None:
        self.state = state
        self.settings: dict[str, Any] = {}
        self.engine: SpeechEngine | None = None
        # Vários chats: cada um com o seu ClaudeBrain; a voz pergunta sempre no chat ativo
        self.chats: ChatManager | None = None
        self._voice_chat_id: int | None = None
        self.tts: TextToSpeech | None = None
        self.hotkey: HotkeyManager | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

        self._mode: str = "transcription"
        self._ai_lock = threading.Lock()
        self._ai_busy = False
        self._cancel_evt = threading.Event()
        self._ai_press_times: list[float] = []
        self._tr_press_times: list[float] = []
        self._tts_muted: bool = False
        # "Parar fala" (ícone da resposta no Chat IA): interrompe só o áudio da resposta atual,
        # o texto continua chegando normalmente
        self._speech_stop = threading.Event()
        # Cada "ouvir de novo" (e cada "parar") cria uma geração nova: áudio de uma geração antiga
        # que termina de ser gerado depois nunca toca (antes isso fazia falas se sobreporem)
        self._speech_gen = 0
        self._speech_gen_lock = threading.Lock()

        self._engine_thread: threading.Thread | None = None

    async def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        self.state.bind_loop(self._loop)
        self.settings = await get_settings_all()

        self.chats = ChatManager(self.settings)
        from .services import speech_cache

        speech_cache.set_notifier(self._on_speech_cache_change)
        self.tts = TextToSpeech(self.settings)

        self.engine = SpeechEngine(
            model_size=self.settings.get("model", "medium"),
            device=self.settings.get("device", "auto"),
            on_transcription=self._on_transcription_received,
            on_audio_level=self.state.set_audio_level,
            on_state_change=self._on_state_change,
            on_transcription_progress=lambda pct: self.state.emit({"type": "transcription_progress", "progress": pct}),
            options=self._engine_options(),
            on_loading=self._on_engine_loading,
        )

        self.hotkey = HotkeyManager(
            transcription_key=self._hotkeys("transcription", "mouse:button8"),
            ai_key=self._hotkeys("ai", "<ctrl>+mouse:button8"),
            on_transcription_press=self._on_transcription_press,
            on_transcription_release=self._on_transcription_release,
            on_ai_press=self._on_ai_press,
            on_ai_release=self._on_ai_release,
        )

        self.hotkey.start()
        self._engine_thread = threading.Thread(target=self.engine.start, daemon=True)
        self._engine_thread.start()
        print("[orchestrator] iniciado", flush=True)

    async def stop(self) -> None:
        self._cancel_evt.set()
        if self.hotkey:
            self.hotkey.stop()
        if self.chats:
            self.chats.cancel_all()
        if self.tts:
            self.tts.stop()
        if self.engine:
            self.engine.stop()
        print("[orchestrator] parado", flush=True)

    async def apply_settings(self, new_settings: dict[str, Any]) -> None:
        """Chamado pelo router de settings quando o usuário muda algo."""
        # Trocar modelo/dispositivo do Whisper reinicia a engine sozinho (antes era um botão manual)
        engine_changed = any(
            k in new_settings and new_settings[k] != self.settings.get(k) for k in ("model", "device")
        )
        self.settings.update(new_settings)
        if self.engine and any(k in new_settings for k in ("whisper_batched", "whisper_vad", "whisper_stream")):
            self.engine.set_options(self._engine_options())  # vale na próxima gravação, sem reiniciar
        if engine_changed and self.engine:
            print(f"[orchestrator] modelo/dispositivo mudou → reiniciando engine "
                  f"({self.settings.get('model')} / {self.settings.get('device')})", flush=True)
            await self.restart_engine()
        if self.chats:
            self.chats.update_settings(self.settings)
        if self.tts:
            self.tts.reload(self.settings)
        if self.hotkey:
            if "transcription_key" in new_settings or "transcription_keys_extra" in new_settings:
                keys = self._hotkeys("transcription", None)
                if keys:
                    self.hotkey.update_transcription_key(keys)
            if "ai_key" in new_settings or "ai_keys_extra" in new_settings:
                keys = self._hotkeys("ai", None)
                if keys:
                    self.hotkey.update_ai_key(keys)

    def _hotkeys(self, kind: str, default: str | None) -> list[str]:
        """Atalho principal (`<kind>_key`) + adicionais (`<kind>_keys_extra`)."""
        primary = self.settings.get(f"{kind}_key") or default
        extra = self.settings.get(f"{kind}_keys_extra") or []
        keys = ([primary] if primary else []) + [k for k in extra if isinstance(k, str) and k]
        return list(dict.fromkeys(keys))

    async def restart_engine(self) -> None:
        """Reinicia o SpeechEngine (necessário após mudar model/device)."""
        if self.engine:
            self.engine.stop()
        self.engine = SpeechEngine(
            model_size=self.settings.get("model", "medium"),
            device=self.settings.get("device", "auto"),
            on_transcription=self._on_transcription_received,
            on_audio_level=self.state.set_audio_level,
            on_state_change=self._on_state_change,
            on_transcription_progress=lambda pct: self.state.emit({"type": "transcription_progress", "progress": pct}),
            options=self._engine_options(),
            on_loading=self._on_engine_loading,
        )
        self._engine_thread = threading.Thread(target=self.engine.start, daemon=True)
        self._engine_thread.start()
        print("[orchestrator] engine reiniciado", flush=True)

    def _on_engine_loading(self, info: dict) -> None:
        """Andamento do carregamento do modelo do Whisper (janelinha, tela do microfone, Configurações)."""
        self.state.emit({"type": "engine_loading", **info})

    def _engine_options(self) -> dict:
        return {
            "batched": self.settings.get("whisper_batched", True),
            "vad": self.settings.get("whisper_vad", False),
            "stream": self.settings.get("whisper_stream", False),
        }

    def emit_speaking(self, ref: str, playing: bool, chat_id: int | None = None) -> None:
        """Avisa a UI que a voz começou/parou. ref="live" = resposta atual; senão, o id da mensagem repetida."""
        self.state.emit({"type": "tts_playing", "ref": ref, "playing": playing, "chat_id": chat_id})

    def stop_speech(self) -> None:
        self._speech_stop.set()
        with self._speech_gen_lock:
            self._speech_gen += 1
        if self.tts:
            self.tts.stop()

    def _words_emitter(self, ref: str, sentence: str, chat_id: int | None = None):
        """Quando a frase começa a tocar, manda para a tela o tempo de cada palavra
        (para destacar o trecho que está sendo falado). Sem tempos (falha do serviço), não manda nada."""
        def _on_start(words, speed, lead) -> None:
            if words:
                self.state.emit({"type": "tts_words", "ref": ref, "chat_id": chat_id, "text": sentence,
                                 "words": words, "speed": speed, "lead": lead})
        return _on_start

    def replay(self, text: str, ref: str, message_id: int | None = None, start: int = 0,
               end: int | None = None) -> None:
        """Fala de novo (o trecho [start, end) de) uma resposta do chat, frase a frase.
        Usa os áudios já salvos no disco (instantâneo, sem internet) e só gera o que faltar, guardando
        o que foi gerado para a próxima vez. Volume/velocidade mudam durante a fala; um "parar" ou um
        novo replay cancela o anterior por completo (inclusive o que ainda era gerado)."""
        from .services import speech_cache

        self.stop_speech()
        with self._speech_gen_lock:
            gen = self._speech_gen
        tts = self.tts
        if not tts:
            return
        chat_id = None
        content = text
        if message_id is not None:
            m = chat_db.get_message(message_id)
            if m and m["role"] == "assistant" and m["content"]:
                content, chat_id = m["content"], m["chat_id"]
            else:
                message_id = None
        if message_id is None:  # sem mensagem: o texto recebido já é o trecho a falar
            start, end = 0, None
        segs = speech_cache.plan(chat_id, message_id, tts.voice_key(), content, start, end)
        if not segs:
            return
        limit = self.settings.get("speech_cache_limit_mb", speech_cache.DEFAULT_LIMIT_MB)
        n_cached = sum(1 for x in segs if x["file"])
        print(f"[replay] {len(segs)} trechos, {n_cached} já salvos no disco", flush=True)

        def current() -> bool:
            return self._speech_gen == gen and not self._tts_muted

        def _run() -> None:
            # "preparando": o ícone mostra que o áudio está sendo gerado (ainda não está falando)
            self.state.emit({"type": "tts_preparing", "ref": ref, "preparing": True})
            started = False
            pool = ThreadPoolExecutor(max_workers=3, thread_name_prefix="tts-replay")
            futures: dict = {}
            used: set[str] = set()

            saver = speech_cache.LiveSaver(chat_id, limit, message_id) if message_id is not None else None

            def _prepare_and_keep(seg: dict) -> str | None:
                path = tts.prepare(seg["text"])
                if path and saver:
                    words, voice = tts.peek_meta(path)
                    saver.add(seg["text"], seg["start"], path, words, voice)
                return path

            def ensure(k: int) -> None:
                if k < len(segs) and segs[k]["file"] is None and k not in futures:
                    futures[k] = pool.submit(_prepare_and_keep, segs[k])

            try:
                for i, seg in enumerate(segs):
                    if not current():
                        break
                    for k in range(i, i + 4):  # até 3 trechos sem áudio salvo sendo gerados à frente
                        ensure(k)
                    if seg["file"]:
                        path, cached = seg["file"], True
                        # tempos relativos ao ponto onde o áudio salvo começa a tocar
                        words = [{**w, "t": w["t"] - seg["seek_s"]} for w in seg["words"]]
                        voice = None
                    else:
                        path, cached = futures[i].result(), False
                        if not path:
                            continue
                        words, voice = tts.take_meta(path)
                    if not current():
                        break
                    if not started:
                        started = True
                        self.state.emit({"type": "tts_preparing", "ref": ref, "preparing": False})
                        self.emit_speaking(ref, True)
                    try:
                        tts.play_file(path, words, on_start=self._words_emitter(ref, seg["text"]),
                                      seek_s=seg["seek_s"], stop_s=seg["stop_s"])
                    finally:
                        if not cached:  # a cópia já foi guardada quando o áudio chegou
                            used.add(path)
                            if os.path.exists(path):
                                os.unlink(path)
            except Exception as e:
                print(f"[replay] erro: {e}", flush=True)
            finally:
                pool.shutdown(wait=False, cancel_futures=True)
                # apaga áudios gerados que não chegaram a tocar
                for f in futures.values():
                    if f.done() and not f.cancelled():
                        try:
                            p = f.result()
                            if p and p not in used and os.path.exists(p):
                                tts.take_meta(p)
                                os.unlink(p)
                        except Exception:
                            pass
                if not started:
                    self.state.emit({"type": "tts_preparing", "ref": ref, "preparing": False})
                else:
                    self.emit_speaking(ref, False)

        threading.Thread(target=_run, daemon=True).start()

    def set_tts_muted(self, muted: bool) -> None:
        self._tts_muted = muted
        if muted and self.tts:
            self.tts.stop()  # interrompe o áudio atual imediatamente

    def pause_hotkeys(self) -> None:
        if self.hotkey:
            self.hotkey.pause()

    def resume_hotkeys(self) -> None:
        if self.hotkey:
            self.hotkey.resume()

    def _on_state_change(self, state: str) -> None:
        self.state.set_state(state)
        if state == "recording" and self.settings.get("sound_recording", True):
            sound_start()
        elif state == "processing" and self.settings.get("sound_processing", True):
            sound_stop()

    def _try_cancel_ai(self) -> bool:
        with self._ai_lock:
            if not self._ai_busy:
                return False
        self._cancel_evt.set()
        if self.chats and self._voice_chat_id is not None:
            try:
                self.chats.get_brain(self._voice_chat_id).cancel()
            except KeyError:
                pass
        if self.tts:
            self.tts.stop()
        self.state.set_state("idle")
        print("[orchestrator] IA cancelada pelo usuário.", flush=True)
        return True

    def _on_transcription_press(self) -> None:
        now = time.monotonic()
        self._tr_press_times.append(now)
        self._tr_press_times = [t for t in self._tr_press_times if now - t < _CANCEL_WINDOW]
        if len(self._tr_press_times) >= _CANCEL_COUNT:
            self._tr_press_times.clear()
            if self.engine:
                self.engine.cancel_ptt()
            print("[orchestrator] Transcrição cancelada pelo usuário.", flush=True)
            return
        with self._ai_lock:
            if self._ai_busy:
                return
        self._mode = "transcription"
        self._tr_press_times.clear()  # reset para o double-click de cancel ser sempre fresco
        if self.engine:
            self.engine.start_ptt()

    def _on_transcription_release(self) -> None:
        if self._mode == "transcription" and self.engine:
            self.engine.stop_ptt()

    def _on_ai_press(self) -> None:
        now = time.monotonic()
        self._ai_press_times.append(now)
        self._ai_press_times = [t for t in self._ai_press_times if now - t < _CANCEL_WINDOW]
        if len(self._ai_press_times) >= _CANCEL_COUNT:
            self._ai_press_times.clear()
            if self._try_cancel_ai():
                return
        with self._ai_lock:
            if self._ai_busy:
                return
        self._mode = "ai"
        self._ai_press_times.clear()  # reset para o double-click de cancel ser sempre fresco
        if self.engine:
            self.engine.start_ptt()

    def _on_ai_release(self) -> None:
        if self._mode == "ai" and self.engine:
            self.engine.stop_ptt()

    def _on_transcription_received(self, text: str, meta: dict) -> None:
        if self._mode == "transcription":
            self._handle_transcription_mode(text, meta)
        else:
            if len(text.split()) < MIN_AI_WORDS:
                self.state.emit({"type": "ai_rejected_short", "text": text})
                return
            threading.Thread(target=self._ai_pipeline, args=(text, meta), daemon=True).start()

    def _handle_transcription_mode(self, text: str, meta: dict) -> None:
        try:
            import pyperclip
            pyperclip.copy(text)
        except Exception as e:
            print(f"[orchestrator] erro ao copiar: {e}", flush=True)

        self.state.emit({"type": "transcription_ready", "text": text})
        if self.settings.get("sound_copied", True):
            sound_copied()
        if self._loop:
            asyncio.run_coroutine_threadsafe(
                self._persist_log("transcription", text, None, meta), self._loop
            )

    def _ai_pipeline(self, text: str, meta: dict) -> None:
        # A pergunta vai para o chat ativo no momento em que ela começa (trocar de chat no meio
        # não muda o destino da resposta)
        chat_id = self.chats.active_id
        if not self.chats.try_begin(chat_id):
            print("[orchestrator] já existe uma resposta em andamento; pergunta por voz ignorada", flush=True)
            self.state.emit({"type": "ai_rejected_busy", "text": text})
            return
        brain = self.chats.get_brain(chat_id)
        self._voice_chat_id = chat_id
        self._cancel_evt.clear()
        with self._ai_lock:
            self._ai_busy = True

        def emit(event: dict) -> None:
            self.state.emit({**event, "chat_id": chat_id})

        # salva a pergunta antes de chamar o Claude (o histórico de reserva da sessão depende disso)
        user_msg_id = chat_db.save_message(chat_id, "user", text)

        t0 = time.perf_counter()
        full_response: list[str] = []
        sentence_q: queue.Queue = queue.Queue()
        audio_q: queue.Queue = queue.Queue(maxsize=3)
        media = MediaDispatcher(emit, self.settings)
        self._speech_stop.clear()  # nova resposta: "parar fala" anterior não vale mais
        tools: list[dict] = []
        stream_end: list[float] = []
        streamed: list[str] = []
        finalized = threading.Event()
        from .services import speech_cache

        # cada frase vai para o disco assim que o áudio chega (a % de áudio salvo sobe durante a geração)
        saver = speech_cache.LiveSaver(
            chat_id, self.settings.get("speech_cache_limit_mb", speech_cache.DEFAULT_LIMIT_MB)
        )

        def _prepare_and_keep(sentence: str, offset: int) -> str | None:
            path = self.tts.prepare(sentence)
            if path:
                words, voice = self.tts.peek_meta(path)
                saver.add(sentence, offset, path, words, voice)
            return path

        def on_tool(name: str, detail: str) -> None:
            tools.append({"name": name, "detail": detail})
            emit({"type": "chat_activity", "tool": name, "detail": detail})

        def _stream_claude() -> None:
            try:
                for sentence in brain.ask_stream(text, on_media=media.request, on_tool=on_tool):
                    if self._cancel_evt.is_set():
                        break
                    sentence_q.put((sentence, sum(len(x) + 1 for x in streamed)))
                    streamed.append(sentence)
                    emit({"type": "chat_chunk", "text": sentence, "done": False})
            except Exception as e:
                print(f"[orchestrator] stream error: {e}", flush=True)
            finally:
                stream_end.append(time.perf_counter())
                sentence_q.put(None)
            _finalize_when_text_done()

        def _finalize_when_text_done() -> None:
            """Texto completo: salva a resposta e mostra hora/tempo/botões sem esperar a fala terminar."""
            if self._cancel_evt.is_set():
                return
            response = " ".join(streamed)
            attachments = media.wait_all() if media.has_requests and not self._cancel_evt.is_set() else []
            if not (response or attachments) or self._cancel_evt.is_set():
                return
            duration = stream_end[0] - t0
            print(f"[orchestrator] ⏱ resposta completa: {duration:.2f}s", flush=True)
            self.state.emit({"type": "ai_response_ready", "text": response})
            if self._loop:
                asyncio.run_coroutine_threadsafe(
                    self._persist_log("ai", text, response, meta, attachments), self._loop
                )
            saver.set_message(self._finalize_voice_chat(chat_id, user_msg_id, response, attachments, duration, tools))
            finalized.set()

        stream_thread: threading.Thread | None = None

        # áudio de até 3 frases gerado ao mesmo tempo (a fala acompanha o texto)
        pool = ThreadPoolExecutor(max_workers=3, thread_name_prefix="tts")

        def _prepare_audio() -> None:
            try:
                while not self._cancel_evt.is_set():
                    sentence = sentence_q.get()
                    if sentence is None:
                        break
                    if self._cancel_evt.is_set():
                        break
                    sentence, offset = sentence
                    audio_q.put((sentence, offset, pool.submit(_prepare_and_keep, sentence, offset)))
            except Exception as e:
                print(f"[orchestrator] prepare error: {e}", flush=True)
            finally:
                audio_q.put(None)

        try:
            print(f"[orchestrator] 📝 Você: {text}", flush=True)
            self.state.set_state("thinking")
            emit({"type": "voice_user_message", "text": text, "user_message_id": user_msg_id})

            stream_thread = threading.Thread(target=_stream_claude, daemon=True)
            stream_thread.start()
            threading.Thread(target=_prepare_audio, daemon=True).start()

            if not self._cancel_evt.is_set() and not self._tts_muted:
                self.tts.speak(random.choice(ClaudeBrain.THINKING_PHRASES))

            first = True
            while True:
                item = audio_q.get()
                if item is None:
                    break
                sentence, offset, fut = item
                path = fut.result() if fut else None
                full_response.append(sentence)
                if self._cancel_evt.is_set() or self._speech_stop.is_set():
                    if path:
                        try:
                            os.unlink(path)
                        except OSError:
                            pass
                    continue
                if self._tts_muted:
                    # mute ativo: descarta o arquivo mas mantém o pipeline rodando
                    if path:
                        try:
                            os.unlink(path)
                        except OSError:
                            pass
                    continue
                if first:
                    self.state.set_state("speaking")
                    self.emit_speaking("live", True, chat_id)
                    first = False
                if path:
                    # a 1ª vez toca o MP3 que chegou do serviço (a cópia guardada vira Opus depois)
                    words, _ = self.tts.take_meta(path)
                    try:
                        self.tts.play_file(path, words, on_start=self._words_emitter("live", sentence, chat_id))
                    finally:
                        try:
                            os.unlink(path)
                        except OSError:
                            pass
                else:
                    self.tts.speak(sentence)
            if not first:
                self.emit_speaking("live", False, chat_id)

            pool.shutdown(wait=False)
            # a fala acabou; espera o salvamento (normalmente já feito quando o texto terminou)
            stream_thread.join(timeout=30)
            if finalized.is_set():
                print(f"[orchestrator] ⏱ total pipeline (com fala): {time.perf_counter() - t0:.2f}s", flush=True)
                return  # sinaliza conclusão normal ao finally
            # chegou aqui: cancelado ou resposta vazia (a pergunta não fica no histórico)
            saver.set_message(None)  # cancelada: descarta o áudio guardado
            chat_db.delete_message(user_msg_id)
            emit({"type": "voice_chat_cancelled"})
        finally:
            self.chats.end(chat_id)
            self.state.emit({"type": "chats_changed"})
            self._voice_chat_id = None
            self._cancel_evt.clear()
            with self._ai_lock:
                self._ai_busy = False
            self.state.set_state("idle")

    async def _persist_log(
        self, mode: str, text: str, ai_response: str | None, meta: dict,
        media: list[dict] | None = None,
    ) -> None:
        try:
            async with aiosqlite.connect(DB_PATH) as db:
                cur = await db.execute(
                    """
                    INSERT INTO transcription_logs
                        (ts, mode, model, device, compute_type, audio_s, proc_s, rtf, text, ai_response, media, method)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        meta["ts"],
                        mode,
                        meta["model"],
                        meta["device"],
                        meta["compute_type"],
                        meta["audio_s"],
                        meta["proc_s"],
                        meta["rtf"],
                        text,
                        ai_response,
                        json.dumps(media, ensure_ascii=False) if media else None,
                        meta.get("method") or None,
                    ),
                )
                log_id = cur.lastrowid
                await db.commit()
            self.state.emit({
                "type": "log_added",
                "entry": {
                    "id": log_id,
                    "ts": meta["ts"],
                    "mode": mode,
                    "model": meta["model"],
                    "device": meta["device"],
                    "compute_type": meta["compute_type"],
                    "audio_s": meta["audio_s"],
                    "proc_s": meta["proc_s"],
                    "rtf": meta["rtf"],
                    "text": text,
                    "ai_response": ai_response,
                    "media": media or [],
                    "method": meta.get("method") or None,
                },
            })
        except Exception as e:
            print(f"[orchestrator] erro ao persistir log: {e}", flush=True)

    def _finalize_voice_chat(
        self,
        chat_id: int,
        user_msg_id: int,
        assistant_text: str,
        attachments: list[dict] | None = None,
        duration: float | None = None,
        tools: list[dict] | None = None,
    ) -> int | None:
        try:
            asst_msg_id = chat_db.save_message(chat_id, "assistant", assistant_text, attachments, duration, tools)
            self.state.emit({
                "type": "chat_chunk",
                "text": "",
                "done": True,
                "still_busy": True,  # ainda pode estar falando; o fim vem no "chats_changed"
                "chat_id": chat_id,
                "message_id": asst_msg_id,
                "user_message_id": user_msg_id,
                "duration_s": round(duration, 2) if duration is not None else None,
                "tools": tools or [],
            })
            self.state.emit({"type": "chats_changed"})
            return asst_msg_id
        except Exception as e:
            print(f"[orchestrator] erro ao persistir chat de voz: {e}", flush=True)
            return None

    def _on_speech_cache_change(self, chat_id: int, message_id: int) -> None:
        """O áudio salvo de uma resposta mudou: manda para a tela a % do texto que já tem áudio."""
        from .services import speech_cache

        if not self.tts:
            return
        m = chat_db.get_message(message_id)
        if not m or m["role"] != "assistant":
            return
        pct = speech_cache.coverage(chat_id, message_id, self.tts.voice_key(), m["content"])
        self.state.emit({"type": "speech_cache_progress", "chat_id": chat_id, "message_id": message_id,
                         "audio_pct": pct, "audio_bytes": speech_cache.message_bytes(chat_id, message_id)})
