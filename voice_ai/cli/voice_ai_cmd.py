import argparse
import os
import queue
import random
import sys
import threading
import time
from pathlib import Path

from PyQt6.QtWidgets import QApplication

from voice_ai.brain import ClaudeBrain
from voice_ai.gui.bridge import AudioBridge
from voice_ai.gui.hotkey_manager import HotkeyManager
from voice_ai.gui.main_window import MainWindow, DEFAULT_SETTINGS
from voice_ai.gui.overlay import StatusOverlay, sound_start, sound_stop, sound_copied
from voice_ai.gui.tray import TrayIcon
from voice_ai.speech_engine import SpeechEngine
from voice_ai.tts import TextToSpeech


def _load_settings() -> dict:
    from voice_ai.gui.main_window import SETTINGS_PATH
    if SETTINGS_PATH.exists():
        import json
        try:
            return json.loads(SETTINGS_PATH.read_text())
        except Exception:
            pass
    return dict(DEFAULT_SETTINGS)


def main() -> None:
    parser = argparse.ArgumentParser(description="Voice AI — transcrição e assistente de voz")
    parser.add_argument("--model",  choices=["tiny", "base", "small", "medium", "large-v3"])
    parser.add_argument("--device", choices=["auto", "cpu", "cuda"])
    parser.add_argument("--hidden", action="store_true", help="Iniciar oculto no tray")
    args = parser.parse_args()

    settings = _load_settings()
    model  = args.model  or settings.get("model",  "medium")
    device = args.device or settings.get("device", "auto")

    # Garante que o diretório de dados existe (logs, sessões do Claude)
    Path("~/.local/share/voice-ai").expanduser().mkdir(parents=True, exist_ok=True)

    app = QApplication(sys.argv)
    app.setApplicationName("Voice AI")
    app.setQuitOnLastWindowClosed(False)

    bridge  = AudioBridge()
    overlay = StatusOverlay()

    # ── STT Engine ────────────────────────────────────────────────────────────
    engine = SpeechEngine(
        model_size=model,
        device=device,
        on_transcription=bridge.on_transcription,
        on_audio_level=bridge.on_audio_level,
        on_state_change=bridge.on_state_change,
    )

    # ── IA e TTS ──────────────────────────────────────────────────────────────
    claude = ClaudeBrain(settings)
    tts    = TextToSpeech(settings)

    # Modo atual da gravação: "transcription" | "ai"
    _mode: list[str] = ["transcription"]
    _ai_lock    = threading.Lock()
    _ai_busy    = [False]
    _cancel_evt = threading.Event()

    # Detecção de duplo clique para cancelar
    _ai_press_times:  list[float] = []
    _tr_press_times:  list[float] = []
    _CANCEL_WINDOW = 0.8
    _CANCEL_COUNT  = 2

    def _try_cancel_ai() -> bool:
        with _ai_lock:
            if not _ai_busy[0]:
                return False
        _cancel_evt.set()
        claude.cancel()
        tts.stop()
        bridge.on_state_change("idle")
        print("[voice-ai] IA cancelada pelo usuário.", flush=True)
        return True

    # ── Hotkeys ───────────────────────────────────────────────────────────────
    hotkey = HotkeyManager(
        transcription_key=settings.get("transcription_key", "mouse:button8"),
        ai_key=settings.get("ai_key", "<ctrl>+mouse:button8"),
    )

    # ── Janela principal ──────────────────────────────────────────────────────
    window = MainWindow(engine, hotkey)

    # ── Roteamento de atalhos ─────────────────────────────────────────────────
    def on_transcription_press():
        now = time.monotonic()
        _tr_press_times.append(now)
        _tr_press_times[:] = [t for t in _tr_press_times if now - t < _CANCEL_WINDOW]
        if len(_tr_press_times) >= _CANCEL_COUNT:
            _tr_press_times.clear()
            engine.cancel_ptt()
            print("[voice-ai] Transcrição cancelada pelo usuário.", flush=True)
            return
        with _ai_lock:
            if _ai_busy[0]:
                return
        _mode[0] = "transcription"
        window.on_transcription_press()

    def on_transcription_release():
        if _mode[0] == "transcription":
            window.on_transcription_release()

    def on_ai_press():
        now = time.monotonic()
        _ai_press_times.append(now)
        _ai_press_times[:] = [t for t in _ai_press_times if now - t < _CANCEL_WINDOW]
        if len(_ai_press_times) >= _CANCEL_COUNT:
            _ai_press_times.clear()
            if _try_cancel_ai():
                return
        with _ai_lock:
            if _ai_busy[0]:
                return
        _mode[0] = "ai"
        window.on_ai_press()

    def on_ai_release():
        if _mode[0] == "ai":
            window.on_ai_release()

    hotkey._on_transcription_press   = on_transcription_press
    hotkey._on_transcription_release = on_transcription_release
    hotkey._on_ai_press   = on_ai_press
    hotkey._on_ai_release = on_ai_release

    # ── Roteamento de transcrições ────────────────────────────────────────────
    MIN_AI_WORDS = 3

    def on_transcription_received(text: str) -> None:
        if _mode[0] == "transcription":
            bridge.on_transcription(text)
        else:
            if len(text.split()) < MIN_AI_WORDS:
                bridge.on_state_change("too_short")
                return
            threading.Thread(target=_ai_pipeline, args=(text,), daemon=True).start()

    def _ai_pipeline(text: str) -> None:
        _cancel_evt.clear()
        with _ai_lock:
            _ai_busy[0] = True

        t0 = time.perf_counter()
        full_response: list[str] = []
        sentence_q: queue.Queue[str | None] = queue.Queue()
        audio_q: queue.Queue[tuple[str, str | None] | None] = queue.Queue(maxsize=3)

        def _stream_claude() -> None:
            try:
                for sentence in claude.ask_stream(text):
                    if _cancel_evt.is_set():
                        break
                    sentence_q.put(sentence)
            except Exception as e:
                print(f"[voice-ai] stream error: {e}", flush=True)
            finally:
                sentence_q.put(None)

        def _prepare_audio() -> None:
            n = 0
            try:
                while not _cancel_evt.is_set():
                    sentence = sentence_q.get()
                    if sentence is None:
                        break
                    if _cancel_evt.is_set():
                        break
                    n += 1
                    t_prep = time.perf_counter()
                    path = tts.prepare(sentence)
                    dt = time.perf_counter() - t_prep
                    print(f"[voice-ai] ⏱ TTS#{n} gerado em {dt:.2f}s (+{time.perf_counter()-t0:.2f}s total)", flush=True)
                    if not _cancel_evt.is_set():
                        audio_q.put((sentence, path))
                    elif path:
                        try:
                            os.unlink(path)
                        except OSError:
                            pass
            except Exception as e:
                print(f"[voice-ai] prepare error: {e}", flush=True)
            finally:
                audio_q.put(None)

        try:
            print(f"[voice-ai] 📝 Você: {text}", flush=True)
            bridge.on_state_change("thinking")

            threading.Thread(target=_stream_claude, daemon=True).start()
            threading.Thread(target=_prepare_audio, daemon=True).start()

            # Toca frase de espera enquanto Claude começa a gerar
            if not _cancel_evt.is_set():
                tts.speak(random.choice(ClaudeBrain.THINKING_PHRASES))

            t_after_thinking = time.perf_counter()
            print(f"[voice-ai] ⏱ frase de espera: {t_after_thinking - t0:.2f}s", flush=True)

            # Toca as frases conforme o áudio vai ficando pronto
            first = True
            n_played = 0
            while True:
                t_wait = time.perf_counter()
                item = audio_q.get()
                if item is None:
                    break
                sentence, path = item
                full_response.append(sentence)
                if _cancel_evt.is_set():
                    if path:
                        try:
                            os.unlink(path)
                        except OSError:
                            pass
                    continue
                if first:
                    bridge.on_state_change("speaking")
                    first = False
                    print(f"[voice-ai] ⏱ 1ª frase pronta: {time.perf_counter() - t0:.2f}s total | espera pós-thinking: {time.perf_counter() - t_after_thinking:.2f}s", flush=True)
                else:
                    gap = time.perf_counter() - t_wait
                    print(f"[voice-ai] ⏱ gap entre frases: {gap:.2f}s", flush=True)
                n_played += 1
                t_play = time.perf_counter()
                if path:
                    tts.play_prepared(path)
                else:
                    tts.speak(sentence)
                print(f"[voice-ai] ⏱ frase#{n_played} tocada em {time.perf_counter() - t_play:.2f}s", flush=True)

            response = " ".join(full_response)
            if response:
                print(f"[voice-ai] ⏱ total pipeline: {time.perf_counter() - t0:.2f}s", flush=True)
                print(f"[voice-ai] 💬 {response}", flush=True)
                bridge.on_ai_response(response)
        finally:
            _cancel_evt.clear()
            with _ai_lock:
                _ai_busy[0] = False
            bridge.on_state_change("idle")

    # Substitui o callback direto do engine para rotear por modo
    engine._on_transcription = on_transcription_received

    # ── Conexões de sinais Qt ─────────────────────────────────────────────────
    bridge.state_changed.connect(overlay.on_state_change)
    bridge.state_changed.connect(window.on_state_change)
    bridge.state_changed.connect(tray_state_relay := (lambda _: None))  # placeholder

    bridge.transcription_ready.connect(overlay.on_copied)
    bridge.transcription_ready.connect(window.on_transcription_ready)
    bridge.transcription_ready.connect(lambda _: sound_copied() if settings.get("sound_copied", True) else None)

    bridge.ai_response_ready.connect(lambda text: print(f"[voice-ai] IA: {text}", flush=True))
    bridge.audio_level.connect(window.on_audio_level)

    # Sons de gravação/processamento
    def on_state_for_sounds(state: str) -> None:
        if state == "recording" and settings.get("sound_recording", True):
            sound_start()
        elif state == "processing" and settings.get("sound_processing", True):
            sound_stop()
    bridge.state_changed.connect(on_state_for_sounds)

    # Atualiza TTS e Claude quando as settings mudam na UI
    def on_settings_changed(new_settings: dict) -> None:
        settings.update(new_settings)
        tts.reload(new_settings)
        claude._settings = new_settings
    window.settings_changed.connect(on_settings_changed)

    # ── Tray ─────────────────────────────────────────────────────────────────
    tray = TrayIcon(on_open_window=window.show_panel, on_quit=app.quit)
    bridge.state_changed.connect(tray.set_state)
    tray.show()

    # ── Inicialização ─────────────────────────────────────────────────────────
    hotkey.start()
    threading.Thread(target=engine.start, daemon=True).start()

    if not args.hidden:
        window.show()

    sys.exit(app.exec())
