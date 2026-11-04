import queue
import threading
import time
from collections.abc import Callable
from datetime import datetime

import numpy as np
import sounddevice as sd

SAMPLE_RATE = 16000
CHUNK_SAMPLES = 512

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
        device: str = "auto",
        on_transcription: Callable[[str, dict], None] | None = None,
        on_audio_level: Callable[[float], None] | None = None,
        on_state_change: Callable[[str], None] | None = None,
        on_transcription_progress: Callable[[float], None] | None = None,
    ) -> None:
        self._model_size = model_size
        self._language = language
        self._device = device
        self._on_transcription = on_transcription
        self._on_audio_level = on_audio_level
        self._on_state_change = on_state_change
        self._on_transcription_progress = on_transcription_progress

        self._whisper = None
        self._loaded_device: str = "cpu"
        self._loaded_compute_type: str = "int8"
        self._segment_queue: queue.Queue = queue.Queue(maxsize=10)
        self._running = False
        self._recording = False
        self._ptt_buffer: list[np.ndarray] = []
        self._stream = None
        self._stt_thread = None
        self._cancel_file_event = threading.Event()

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
            try:
                self._stream.stop()
                self._stream.close()
            except Exception:
                pass
        self._segment_queue.put(None)
        if self._stt_thread:
            self._stt_thread.join(timeout=3)

    def start_ptt(self) -> None:
        self._ptt_buffer = []
        self._recording = True
        self._emit_state("recording")

    def cancel_file_transcription(self) -> None:
        self._cancel_file_event.set()

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

    def _emit_state(self, state: str) -> None:
        if self._on_state_change:
            self._on_state_change(state)

    def _resolve_device(self) -> tuple[str, str]:
        if self._device == "cpu":
            return "cpu", "int8"
        if self._device == "cuda":
            return "cuda", "float16"
        try:
            import ctranslate2
            if ctranslate2.get_cuda_device_count() > 0:
                return "cuda", "float16"
        except Exception:
            pass
        return "cpu", "int8"

    @staticmethod
    def _preload_nvidia_libs() -> None:
        import ctypes
        import sys
        from pathlib import Path

        libs: list[Path] = []
        for sp in sys.path:
            libs.extend(Path(sp).glob("nvidia/*/lib/*.so.*"))

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
                text = self._transcribe(segment, on_progress=self._on_transcription_progress)
                proc_s = time.perf_counter() - t0
                if text:
                    if self._is_hallucination(text):
                        print(f"[voice] alucinação descartada: {text!r}", flush=True)
                    else:
                        self._dispatch(text, audio_s, proc_s)
            except RuntimeError as e:
                msg = str(e).lower()
                if self._loaded_device == "cuda" and any(k in msg for k in ("cublas", "cuda", "cudnn")):
                    print(f"[voice] CUDA erro — fallback CPU: {e}", flush=True)
                    self._fallback_to_cpu()
                    try:
                        t0 = time.perf_counter()
                        text = self._transcribe(segment)
                        proc_s = time.perf_counter() - t0
                        if text and not self._is_hallucination(text):
                            self._dispatch(text, audio_s, proc_s)
                    except Exception:
                        pass
            except Exception:
                pass
            finally:
                self._emit_state("idle")

    def _dispatch(self, text: str, audio_s: float, proc_s: float) -> None:
        rtf = round(audio_s / proc_s, 1) if proc_s > 0 else None
        meta = {
            "ts": datetime.now().isoformat(timespec="milliseconds"),
            "model": self._model_size,
            "device": self._loaded_device,
            "compute_type": self._loaded_compute_type,
            "audio_s": round(audio_s, 3),
            "proc_s": round(proc_s, 3),
            "rtf": rtf,
        }
        print(
            f"[voice] {self._loaded_device.upper()} | {self._model_size} | "
            f"áudio {audio_s:.1f}s | proc {proc_s:.2f}s | RTF {rtf}x | {text[:70]}",
            flush=True,
        )
        if self._on_transcription:
            self._on_transcription(text, meta)

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

    def transcribe_file(
        self,
        file_path: str,
        on_progress: "Callable[[float], None] | None" = None,
    ) -> dict:
        """Transcribe an audio file from disk.

        Uses ffmpeg to convert to 16 kHz mono WAV, then reads it with the stdlib
        `wave` module into a numpy array. This bypasses av.open() entirely,
        which has a version incompatibility (PyAV 19 vs faster-whisper 1.2).
        """
        import subprocess
        import tempfile
        import time
        import wave
        from pathlib import Path

        wav_tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        wav_path = wav_tmp.name
        wav_tmp.close()

        try:
            subprocess.run(
                ["ffmpeg", "-y", "-i", file_path,
                 "-ar", "16000", "-ac", "1",
                 "-sample_fmt", "s16", "-f", "wav", wav_path],
                check=True,
                capture_output=True,
            )

            with wave.open(wav_path, "rb") as wf:
                raw = wf.readframes(wf.getnframes())
                n_frames = wf.getnframes()

            audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
            duration_s = n_frames / SAMPLE_RATE

            self._cancel_file_event.clear()
            t0 = time.perf_counter()
            segments, _ = self._whisper.transcribe(
                audio,
                language=self._language,
                beam_size=5,
                vad_filter=True,
                temperature=0,
                condition_on_previous_text=True,
                no_speech_threshold=0.6,
            )

            parts: list[str] = []
            for seg in segments:
                if self._cancel_file_event.is_set():
                    raise InterruptedError("cancelled")
                parts.append(seg.text.strip())
                if on_progress and duration_s > 0:
                    pct = min(seg.end / duration_s * 100, 99.0)
                    on_progress(round(pct, 1))

            text = " ".join(parts).strip()
            proc_s = time.perf_counter() - t0
            if on_progress:
                on_progress(100.0)

        finally:
            Path(wav_path).unlink(missing_ok=True)

        return {
            "text": text,
            "duration_s": round(duration_s, 2),
            "proc_s": round(proc_s, 2),
            "model": self._model_size,
            "device": self._loaded_device,
        }

    def _transcribe(self, audio: np.ndarray, on_progress: "Callable[[float], None] | None" = None) -> str:
        padding = np.zeros(int(SAMPLE_RATE * 0.2), dtype=np.float32)
        audio = np.concatenate([padding, audio])
        duration_s = len(audio) / SAMPLE_RATE
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
        parts: list[str] = []
        for seg in segments:
            parts.append(seg.text)
            if on_progress and duration_s > 0:
                pct = min(seg.end / duration_s * 100, 99.0)
                on_progress(round(pct, 1))
        if on_progress:
            on_progress(100.0)
        return " ".join(parts).strip()
