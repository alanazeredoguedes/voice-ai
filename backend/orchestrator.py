import asyncio
import os
import queue
import random
import threading
import time
from typing import Any

import aiosqlite

from .config import DB_PATH
from .services.audio_feedback import sound_copied, sound_start, sound_stop
from .services.brain import ClaudeBrain
from .services.hotkey_manager import HotkeyManager
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
        self.brain: ClaudeBrain | None = None
        self.chat_brain: ClaudeBrain | None = None
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

        self._engine_thread: threading.Thread | None = None

    async def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        self.state.bind_loop(self._loop)
        self.settings = await get_settings_all()

        self.brain = ClaudeBrain(self.settings)
        # Chat brain mantém contexto separado do modo voz; claude_continue sempre ativo
        self.chat_brain = ClaudeBrain({**self.settings, "claude_continue": True})
        self.tts = TextToSpeech(self.settings)

        self.engine = SpeechEngine(
            model_size=self.settings.get("model", "medium"),
            device=self.settings.get("device", "auto"),
            on_transcription=self._on_transcription_received,
            on_audio_level=self.state.set_audio_level,
            on_state_change=self._on_state_change,
            on_transcription_progress=lambda pct: self.state.emit({"type": "transcription_progress", "progress": pct}),
        )

        self.hotkey = HotkeyManager(
            transcription_key=self.settings.get("transcription_key", "mouse:button8"),
            ai_key=self.settings.get("ai_key", "<ctrl>+mouse:button8"),
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
        if self.brain:
            self.brain.cancel()
        if self.chat_brain:
            self.chat_brain.cancel()
        if self.tts:
            self.tts.stop()
        if self.engine:
            self.engine.stop()
        print("[orchestrator] parado", flush=True)

    async def apply_settings(self, new_settings: dict[str, Any]) -> None:
        """Chamado pelo router de settings quando o usuário muda algo."""
        self.settings.update(new_settings)
        if self.brain:
            self.brain.update_settings(self.settings)
        if self.tts:
            self.tts.reload(self.settings)
        if self.hotkey:
            new_tr = self.settings.get("transcription_key")
            new_ai = self.settings.get("ai_key")
            if new_tr:
                self.hotkey.update_transcription_key(new_tr)
            if new_ai:
                self.hotkey.update_ai_key(new_ai)

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
        )
        self._engine_thread = threading.Thread(target=self.engine.start, daemon=True)
        self._engine_thread.start()
        print("[orchestrator] engine reiniciado", flush=True)

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
        if self.brain:
            self.brain.cancel()
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
        self._cancel_evt.clear()
        with self._ai_lock:
            self._ai_busy = True

        t0 = time.perf_counter()
        full_response: list[str] = []
        sentence_q: queue.Queue = queue.Queue()
        audio_q: queue.Queue = queue.Queue(maxsize=3)

        def _stream_claude() -> None:
            try:
                for sentence in self.brain.ask_stream(text):
                    if self._cancel_evt.is_set():
                        break
                    sentence_q.put(sentence)
                    self.state.emit({"type": "chat_chunk", "text": sentence, "done": False})
            except Exception as e:
                print(f"[orchestrator] stream error: {e}", flush=True)
            finally:
                sentence_q.put(None)

        def _prepare_audio() -> None:
            n = 0
            try:
                while not self._cancel_evt.is_set():
                    sentence = sentence_q.get()
                    if sentence is None:
                        break
                    if self._cancel_evt.is_set():
                        break
                    n += 1
                    path = self.tts.prepare(sentence)
                    if not self._cancel_evt.is_set():
                        audio_q.put((sentence, path))
                    elif path:
                        try:
                            os.unlink(path)
                        except OSError:
                            pass
            except Exception as e:
                print(f"[orchestrator] prepare error: {e}", flush=True)
            finally:
                audio_q.put(None)

        try:
            print(f"[orchestrator] 📝 Você: {text}", flush=True)
            self.state.set_state("thinking")
            self.state.emit({"type": "voice_user_message", "text": text})

            threading.Thread(target=_stream_claude, daemon=True).start()
            threading.Thread(target=_prepare_audio, daemon=True).start()

            if not self._cancel_evt.is_set() and not self._tts_muted:
                self.tts.speak(random.choice(ClaudeBrain.THINKING_PHRASES))

            first = True
            while True:
                item = audio_q.get()
                if item is None:
                    break
                sentence, path = item
                full_response.append(sentence)
                if self._cancel_evt.is_set():
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
                    first = False
                if path:
                    self.tts.play_prepared(path)
                else:
                    self.tts.speak(sentence)

            response = " ".join(full_response)
            if response and not self._cancel_evt.is_set():
                print(f"[orchestrator] ⏱ total pipeline: {time.perf_counter() - t0:.2f}s", flush=True)
                self.state.emit({"type": "ai_response_ready", "text": response})
                if self._loop:
                    asyncio.run_coroutine_threadsafe(
                        self._persist_log("ai", text, response, meta), self._loop
                    )
                    asyncio.run_coroutine_threadsafe(
                        self._persist_and_finalize_voice_chat(text, response), self._loop
                    )
                return  # sinaliza conclusão normal ao finally
            # chegou aqui: cancelado ou resposta vazia
            self.state.emit({"type": "voice_chat_cancelled"})
        finally:
            self._cancel_evt.clear()
            with self._ai_lock:
                self._ai_busy = False
            self.state.set_state("idle")

    async def _persist_log(
        self, mode: str, text: str, ai_response: str | None, meta: dict
    ) -> None:
        try:
            async with aiosqlite.connect(DB_PATH) as db:
                cur = await db.execute(
                    """
                    INSERT INTO transcription_logs
                        (ts, mode, model, device, compute_type, audio_s, proc_s, rtf, text, ai_response)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                },
            })
        except Exception as e:
            print(f"[orchestrator] erro ao persistir log: {e}", flush=True)

    async def _persist_and_finalize_voice_chat(self, user_text: str, assistant_text: str) -> None:
        try:
            async with aiosqlite.connect(DB_PATH) as db:
                cur_user = await db.execute(
                    "INSERT INTO chat_messages (role, content) VALUES (?, ?)",
                    ("user", user_text),
                )
                user_msg_id = cur_user.lastrowid
                cur_asst = await db.execute(
                    "INSERT INTO chat_messages (role, content) VALUES (?, ?)",
                    ("assistant", assistant_text),
                )
                asst_msg_id = cur_asst.lastrowid
                await db.commit()
            self.state.emit({
                "type": "chat_chunk",
                "text": "",
                "done": True,
                "message_id": asst_msg_id,
                "user_message_id": user_msg_id,
            })
        except Exception as e:
            print(f"[orchestrator] erro ao persistir chat de voz: {e}", flush=True)
