import json
import queue
import threading
import time
from collections.abc import Callable
from datetime import datetime
from pathlib import Path

import numpy as np
import sounddevice as sd

SAMPLE_RATE = 16000
CHUNK_SAMPLES = 512  # ~32ms at 16kHz

LOG_PATH = Path.home() / ".local/share/voice-ai/logs" / "transcriptions.log"

# Frases que o Whisper alucina em silêncio/ruído de fundo (treinado em vídeos do YouTube)
_WHISPER_HALLUCINATIONS: frozenset[str] = frozenset({
    "thanks for watching", "thank you for watching", "thank you",
    "thanks", "please subscribe", "like and subscribe", "subscribe",
    "don't forget to subscribe", "see you next time", "see you in the next video",
    "bye", "goodbye", "the", "you", "a", "an", "i", "and",
    "[music]", "[applause]", "[laughter]", "(upbeat music)", "(music)",
    "transcribed by", "subtitles by", "captions by",
    "obrigado por assistir", "obrigado", "até a próxima",
})


class SpeechEngine:
    def __init__(
        self,
        model_size: str = "medium",
        language: str | None = None,
        device: str = "auto",  # "auto" | "cpu" | "cuda"
        on_transcription: Callable[[str], None] | None = None,
        on_audio_level: Callable[[float], None] | None = None,
        on_state_change: Callable[[str], None] | None = None,
    ) -> None:
        self._model_size = model_size
        self._language = language
        self._device = device
        self._on_transcription = on_transcription
        self._on_audio_level = on_audio_level
        self._on_state_change = on_state_change

        self._whisper = None
        self._loaded_device: str = "cpu"
        self._loaded_compute_type: str = "int8"
        self._segment_queue: queue.Queue = queue.Queue(maxsize=10)
        self._running = False
        self._recording = False
        self._ptt_buffer: list[np.ndarray] = []
        self._stream = None
        self._stt_thread = None

    def start(self) -> None:
        self._load_models()
        self._running = True
        self._stt_thread = threading.Thread(target=self._stt_loop, daemon=True)
        self._stt_thread.start()
        self._stream = sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="float32",
            blocksize=CHUNK_SAMPLES,
            callback=self._audio_callback,
        )
        self._stream.start()

    def stop(self) -> None:
        self._running = False
        if self._stream:
            self._stream.stop()
            self._stream.close()
        self._segment_queue.put(None)
        if self._stt_thread:
            self._stt_thread.join(timeout=3)

    def start_ptt(self) -> None:
        self._ptt_buffer = []
        self._recording = True
        self._emit_state("recording")

    def cancel_ptt(self) -> None:
        self._recording = False
        self._ptt_buffer = []
        self._emit_state("idle")

    def stop_ptt(self) -> None:
        self._recording = False
        if self._ptt_buffer:
            full_audio = np.concatenate(self._ptt_buffer)
            self._ptt_buffer = []
            rms = float(np.sqrt(np.mean(full_audio ** 2)))
            if rms < 0.003:
                self._emit_state("idle")
                return
            try:
                self._segment_queue.put_nowait(full_audio)
            except queue.Full:
                self._emit_state("idle")
                return
            self._emit_state("processing")
        else:
            self._emit_state("idle")

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _emit_state(self, state: str) -> None:
        if self._on_state_change:
            self._on_state_change(state)

    def _resolve_device(self) -> tuple[str, str]:
        if self._device == "cpu":
            return "cpu", "int8"
        if self._device == "cuda":
            return "cuda", "float16"
        # auto: prefer CUDA if available
        try:
            import ctranslate2
            if ctranslate2.get_cuda_device_count() > 0:
                return "cuda", "float16"
        except Exception:
            pass
        return "cpu", "int8"

    @staticmethod
    def _preload_nvidia_libs() -> None:
        """Pre-load NVIDIA .so files so ctranslate2's dlopen can find them."""
        import ctypes
        import sys
        from pathlib import Path

        libs: list[Path] = []
        for sp in sys.path:
            libs.extend(Path(sp).glob("nvidia/*/lib/*.so.*"))

        # Also search well-known system CUDA paths (e.g. Ollama's bundled libs)
        system_cuda_dirs = [
            Path("/usr/local/lib/ollama/cuda_v12"),
            Path("/usr/local/cuda/lib64"),
            Path("/usr/lib/x86_64-linux-gnu"),
        ]
        for cuda_dir in system_cuda_dirs:
            if cuda_dir.is_dir():
                libs.extend(cuda_dir.glob("libcublas*.so.*"))
                libs.extend(cuda_dir.glob("libcudnn*.so.*"))
                libs.extend(cuda_dir.glob("libcudart*.so.*"))

        # Retry up to 3 passes to handle dependency ordering
        pending = libs
        for _ in range(3):
            if not pending:
                break
            failed = []
            for lib in pending:
                try:
                    ctypes.CDLL(str(lib))
                except OSError:
                    failed.append(lib)
            pending = failed

    def _load_models(self) -> None:
        self._emit_state("idle")
        device, compute_type = self._resolve_device()
        self._loaded_device = device
        self._loaded_compute_type = compute_type
        if device == "cuda":
            self._preload_nvidia_libs()
        from faster_whisper import WhisperModel
        self._whisper = WhisperModel(self._model_size, device=device, compute_type=compute_type)
        self._emit_state("idle")

    def _audio_callback(self, indata, frames, time_info, status) -> None:
        chunk = indata[:, 0].copy()
        if self._on_audio_level:
            rms = float(np.sqrt(np.mean(chunk ** 2)))
            self._on_audio_level(min(rms * 10, 1.0))
        if self._recording:
            self._ptt_buffer.append(chunk)

    def _stt_loop(self) -> None:
        while self._running:
            segment = self._segment_queue.get()
            if segment is None:
                break
            audio_s = len(segment) / SAMPLE_RATE
            try:
                t0 = time.perf_counter()
                text = self._transcribe(segment)
                proc_s = time.perf_counter() - t0
                if text:
                    if self._is_hallucination(text):
                        print(f"[voice] alucinação descartada: {text!r}", flush=True)
                    else:
                        self._write_log(text, audio_s, proc_s)
                        if self._on_transcription:
                            self._on_transcription(text)
            except RuntimeError as e:
                msg = str(e).lower()
                if self._loaded_device == "cuda" and any(k in msg for k in ("cublas", "cuda", "cudnn")):
                    self._write_log(f"[CUDA erro — fallback CPU] {e}", audio_s, 0)
                    self._fallback_to_cpu()
                    try:
                        t0 = time.perf_counter()
                        text = self._transcribe(segment)
                        proc_s = time.perf_counter() - t0
                        if text:
                            if self._is_hallucination(text):
                                print(f"[voice] alucinação descartada: {text!r}", flush=True)
                            else:
                                self._write_log(text, audio_s, proc_s)
                                if self._on_transcription:
                                    self._on_transcription(text)
                    except Exception:
                        pass
            except Exception:
                pass
            finally:
                self._emit_state("idle")

    def _fallback_to_cpu(self) -> None:
        self._loaded_device = "cpu"
        self._loaded_compute_type = "int8"
        from faster_whisper import WhisperModel
        self._whisper = WhisperModel(self._model_size, device="cpu", compute_type="int8")
        print("[voice] modelo recarregado em CPU.", flush=True)

    @staticmethod
    def _is_hallucination(text: str) -> bool:
        import re
        normalized = re.sub(r"[^\w\s]", "", text.lower()).strip()
        return normalized in _WHISPER_HALLUCINATIONS

    def _transcribe(self, audio: np.ndarray) -> str:
        padding = np.zeros(int(SAMPLE_RATE * 0.2), dtype=np.float32)
        audio = np.concatenate([padding, audio])
        segments, _ = self._whisper.transcribe(
            audio,
            language=self._language,
            beam_size=5,
            vad_filter=False,
            temperature=0,
            condition_on_previous_text=False,
            no_speech_threshold=0.35,
            log_prob_threshold=-1.5,
        )
        return " ".join(seg.text for seg in segments).strip()

    def _write_log(self, text: str, audio_s: float, proc_s: float) -> None:
        rtf = round(audio_s / proc_s, 1) if proc_s > 0 else None
        entry = {
            "ts":           datetime.now().isoformat(timespec="milliseconds"),
            "model":        self._model_size,
            "device":       self._loaded_device,
            "compute_type": self._loaded_compute_type,
            "audio_s":      round(audio_s, 3),
            "proc_s":       round(proc_s, 3),
            "rtf":          rtf,  # audio_s / proc_s — >1 significa mais rápido que tempo real
            "text":         text,
        }
        LOG_PATH.parent.mkdir(exist_ok=True)
        with LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        print(
            f"[voice] {self._loaded_device.upper()} | {self._model_size} | "
            f"áudio {audio_s:.1f}s | proc {proc_s:.2f}s | RTF {rtf}x | {text[:70]}",
            flush=True,
        )
