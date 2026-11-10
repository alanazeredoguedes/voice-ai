import json
import os
import queue
import threading
import time
from pathlib import Path
from collections.abc import Callable
from datetime import datetime

import numpy as np
import sounddevice as sd

SAMPLE_RATE = 16000
CHUNK_SAMPLES = 512

# Modo em lote: só vale a pena acima de uma janela do Whisper (30 s)
BATCH_MIN_S = 30.0
BATCH_SIZE = 8
# Transcrever enquanto fala: a cada ~25 s gravados, transcreve o trecho (cortando numa pausa entre 18 e 27 s)
STREAM_TRIGGER_S = 25.0
# prévia do texto enquanto grava: só os últimos ~25 s são refeitos a cada vez (o começo fica fixado)
PREVIEW_WINDOW_S = 25.0
STREAM_CUT_MIN_S = 18.0
STREAM_CUT_MAX_S = 27.0


# Tempo típico de carregamento (s) quando ainda não há medição neste computador
_DEFAULT_LOAD_S = {"tiny": 3, "base": 4, "small": 6, "medium": 12, "large-v3-turbo": 12, "large-v3": 22}


def _load_times_path() -> Path:
    base = Path(os.environ.get("VOICE_AI_DATA_DIR") or (Path.home() / ".local" / "share" / "voice-ai"))
    return base / "model_load_times.json"


def _load_history(model: str, device: str) -> list[float]:
    try:
        v = json.loads(_load_times_path().read_text(encoding="utf-8")).get(f"{model}|{device}")
    except Exception:
        return []
    if isinstance(v, (int, float)):  # formato antigo (um número só)
        return [float(v)]
    return [float(x) for x in v] if isinstance(v, list) else []


def _expected_load_s(model: str, device: str) -> float:
    """Tempo esperado: mediana das últimas cargas (uma demora fora do normal não distorce)."""
    hist = sorted(_load_history(model, device))
    if hist:
        return hist[(len(hist) - 1) // 2]  # com 2 medições, a menor
    base = _DEFAULT_LOAD_S.get(model, 12)
    return base if device == "cuda" else base * 0.7


def _remember_load_s(model: str, device: str, seconds: float) -> None:
    """Guarda quanto o modelo levou para carregar (as últimas 5 vezes)."""
    p = _load_times_path()
    try:
        data = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
    except Exception:
        data = {}
    key = f"{model}|{device}"
    hist = _load_history(model, device) + [round(seconds, 2)]
    data[key] = hist[-5:]
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(data), encoding="utf-8")
    except OSError:
        pass


def _log_load(line: str) -> None:
    """Registro de cada carregamento, com o tempo de cada etapa (para investigar demoras)."""
    p = _load_times_path().with_name("engine_load.log")
    try:
        old = p.read_text(encoding="utf-8").splitlines()[-199:] if p.exists() else []
        p.write_text("\n".join(old + [line]) + "\n", encoding="utf-8")
    except OSError:
        pass


def _quietest_point(audio: np.ndarray, lo: int, hi: int, win: int = int(SAMPLE_RATE * 0.25)) -> int:
    """Índice (entre lo e hi) do trecho mais silencioso: é onde o áudio é cortado, para não partir uma palavra."""
    hi = min(hi, len(audio))
    if hi - lo <= win:
        return hi
    seg = audio[lo:hi] ** 2
    energy = np.convolve(seg, np.ones(win, dtype=np.float32) / win, mode="valid")
    return lo + int(np.argmin(energy)) + win // 2


def _contiguous_clips(audio: np.ndarray, max_s: float = 28.0) -> list[dict]:
    """Pedaços contíguos (sem descartar nada, nem os silêncios) de até ~28 s, cortados nas pausas.
    Usado no modo em lote quando "pular silêncios" está desligado."""
    clips: list[dict] = []
    n = len(audio)
    start = 0
    max_n = int(max_s * SAMPLE_RATE)
    while n - start > max_n:
        cut = _quietest_point(audio, start + int(max_n * 0.6), start + max_n)
        clips.append({"start": start / SAMPLE_RATE, "end": cut / SAMPLE_RATE})
        start = cut
    clips.append({"start": start / SAMPLE_RATE, "end": n / SAMPLE_RATE})
    return clips

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
        options: dict | None = None,
        on_loading: Callable[[dict], None] | None = None,
        on_partial: Callable[[str], None] | None = None,
    ) -> None:
        self._on_partial = on_partial
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
        # Carregamento do modelo: o microfone já funciona antes de terminar (o que for gravado
        # espera o modelo ficar pronto); a tela mostra o andamento
        self._on_loading = on_loading
        self._ready = threading.Event()
        self.loading: dict = {"loading": True, "progress": 0.0, "phase": "Iniciando", "model": model_size}
        # Opções da gravação pelo atalho (Configurações): mudam sem reiniciar a engine
        self._opts = {"batched": True, "vad": False, "stream": False}
        self.set_options(options or {})
        self._batched_pipeline = None
        # O mesmo modelo é usado pela transcrição normal e pela "enquanto fala": uma por vez
        self._infer_lock = threading.Lock()
        # Transcrever enquanto fala: cada gravação tem um número; cancelar/soltar invalida o trabalho antigo
        self._ptt_gen = 0
        self._stream_job: dict | None = None
        # como a última transcrição foi feita (aparece nos Logs): "lote", "durante a fala", "sem silêncios"
        self._last_method: list[str] = []

    def set_options(self, opts: dict) -> None:
        """batched: modo em lote (áudios > 30 s) | vad: pular silêncios | stream: transcrever enquanto fala"""
        for k in ("batched", "vad", "stream"):
            if k in opts and opts[k] is not None:
                self._opts[k] = bool(opts[k])

    def start(self) -> None:
        # microfone e fila de transcrição já ligados: dá para gravar enquanto o modelo carrega
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
        self._load_models()

    @property
    def ready(self) -> bool:
        return self._ready.is_set()

    def _report_loading(self, **kw) -> None:
        self.loading.update(kw)
        if self._on_loading:
            try:
                self._on_loading(dict(self.loading))
            except Exception:
                pass

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

    def start_ptt(self, preview: bool = False) -> None:
        """preview: enquanto grava, manda para a tela o texto parcial (``on_partial``), como uma prévia."""
        self._ptt_buffer = []
        self._ptt_gen += 1
        self._stream_job = None
        self._recording = True
        self._emit_state("recording")
        if preview and self._on_partial:
            threading.Thread(target=self._preview_worker, args=(self._ptt_gen,), daemon=True).start()
        if self._opts["stream"]:
            job = {"gen": self._ptt_gen, "consumed": 0, "parts": [], "proc_s": 0.0, "thread": None}
            job["thread"] = threading.Thread(target=self._stream_worker, args=(job,), daemon=True)
            self._stream_job = job
            job["thread"].start()

    def cancel_file_transcription(self) -> None:
        self._cancel_file_event.set()

    def cancel_ptt(self) -> None:
        self._recording = False
        self._ptt_gen += 1  # descarta o que já foi transcrito durante a fala
        self._stream_job = None
        self._ptt_buffer = []
        self._emit_state("idle")

    def stop_ptt(self) -> None:
        self._recording = False
        job = self._stream_job
        self._stream_job = None
        if self._ptt_buffer:
            full_audio = np.concatenate(self._ptt_buffer)
            self._ptt_buffer = []
            rms = float(np.sqrt(np.mean(full_audio ** 2)))
            if rms < 0.003:
                self._ptt_gen += 1
                self._emit_state("idle")
                return
            try:
                # com "transcrever enquanto fala", vai junto o que já foi transcrito durante a gravação
                self._segment_queue.put_nowait({"audio": full_audio, "job": job} if job else full_audio)
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

        if sys.platform == "win32":
            SpeechEngine._register_nvidia_dll_dirs_windows()
            return

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

    @staticmethod
    def _register_nvidia_dll_dirs_windows() -> None:
        """Windows: adiciona as pastas bin/ dos pacotes pip nvidia-* (cuBLAS, cuDNN)
        ao caminho de busca de DLLs, para o ctranslate2 achar cublas64_12.dll etc."""
        import os
        import sys
        from pathlib import Path

        seen: set[str] = set()

        # CUDA Toolkit / cuDNN já instalados no sistema (o setup não baixa os pacotes pip nesse caso).
        # Desde o Python 3.8 o PATH não entra na busca de DLLs de extensões, então registra explicitamente.
        candidates: list[Path] = [Path(p) for p in os.environ.get("PATH", "").split(os.pathsep) if p]
        if os.environ.get("CUDA_PATH"):
            candidates.append(Path(os.environ["CUDA_PATH"]) / "bin")
        cudnn_root = Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "NVIDIA" / "CUDNN"
        if cudnn_root.is_dir():
            candidates += list(cudnn_root.glob("v*/bin")) + list(cudnn_root.glob("v*/bin/*"))
        for d in candidates:
            try:
                if (d / "cublas64_12.dll").is_file() or (d / "cudnn64_9.dll").is_file():
                    key = str(d.resolve())
                    if key not in seen:
                        seen.add(key)
                        os.add_dll_directory(key)
            except OSError:
                pass

        for sp in sys.path:
            for bin_dir in Path(sp).glob("nvidia/*/bin"):
                d = str(bin_dir.resolve())
                if d in seen or not bin_dir.is_dir():
                    continue
                seen.add(d)
                try:
                    os.add_dll_directory(d)
                except OSError:
                    pass
                os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")

    def _load_models(self) -> None:
        """Carrega o modelo (do disco para a memória da placa de vídeo) avisando o andamento.
        O carregamento não informa progresso, então a % é estimada pelo tempo que ele levou nas
        vezes anteriores neste computador."""
        device, compute_type = self._resolve_device()
        self._loaded_device = device
        self._loaded_compute_type = compute_type
        expected = _expected_load_s(self._model_size, device)
        t0 = time.perf_counter()
        self._report_loading(loading=True, progress=0.0, phase="Iniciando", model=self._model_size, device=device)
        stop = threading.Event()

        def ticker() -> None:
            while not stop.wait(0.4):
                el = time.perf_counter() - t0
                pct = min(95.0, el / max(expected, 0.5) * 95.0)
                # passou bastante do normal: a tela troca a % por "demorando mais que o normal" + tempo
                slow = el > max(expected * 1.5, expected + 5)
                if el > expected:
                    pct = min(99.0, 95.0 + (el - expected) / max(expected, 1.0) * 4.0)
                self._report_loading(progress=round(pct, 1), elapsed=round(el, 1), expected=round(expected, 1), slow=slow)

        threading.Thread(target=ticker, daemon=True).start()
        steps: list[str] = []
        mark = [time.perf_counter()]

        def step(name: str) -> None:
            now = time.perf_counter()
            steps.append(f"{name}={now - mark[0]:.1f}s")
            mark[0] = now

        try:
            if device == "cuda":
                self._report_loading(phase="Preparando a placa de vídeo")
                self._preload_nvidia_libs()
                step("preparar_placa")
            self._report_loading(phase="Carregando o modelo na memória" + (" da placa de vídeo" if device == "cuda" else ""))
            from faster_whisper import WhisperModel
            self._whisper = WhisperModel(self._model_size, device=device, compute_type=compute_type)
            step("carregar_modelo")
            # aquecimento: a 1ª transcrição real não paga a inicialização da placa
            self._report_loading(phase="Aquecendo")
            try:
                list(self._whisper.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32), language="pt", beam_size=1)[0])
            except Exception:
                pass
            step("aquecer")
        finally:
            stop.set()
        took = time.perf_counter() - t0
        _remember_load_s(self._model_size, device, took)
        line = (f"{time.strftime('%Y-%m-%d %H:%M:%S')} {self._model_size} {device} total={took:.1f}s "
                f"(esperado {expected:.1f}s) " + " ".join(steps))
        _log_load(line)
        print(f"[voice] modelo pronto: {line}", flush=True)
        self._ready.set()
        self._report_loading(loading=False, progress=100.0, phase="Pronto", elapsed=round(took, 1))

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
            job = None
            if isinstance(segment, dict):
                job, segment = segment["job"], segment["audio"]
            # gravou enquanto o modelo carregava: espera ele ficar pronto (a tela mostra o andamento)
            while not self._ready.wait(0.5):
                if not self._running:
                    return
            audio_s = len(segment) / SAMPLE_RATE
            try:
                t0 = time.perf_counter()
                if job is not None:
                    text = self._finish_stream(job, segment)
                else:
                    text = self._transcribe(segment, on_progress=self._on_transcription_progress)
                # tempo de espera depois de soltar a tecla (o que você sente)
                proc_s = time.perf_counter() - t0
                if text:
                    if self._is_hallucination(text):
                        print(f"[voice] alucinação descartada: {text!r}", flush=True)
                    else:
                        self._dispatch(text, audio_s, proc_s)
            except RuntimeError as e:
                msg = str(e).lower()
                if self._loaded_device == "cuda" and any(k in msg for k in ("cublas", "cuda", "cudnn")):
                    print(f"[voice] CUDA erro - fallback CPU: {e}", flush=True)
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
            "method": ", ".join(self._last_method),
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
        self._batched_pipeline = None  # recriado com o modelo novo
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
        """Transcribe an audio/video file from disk.

        Decodifica com PyAV (services/audio_decode.py) para 16 kHz mono float32 -
        não depende de um ffmpeg.exe instalado na máquina.
        """
        import time

        from .audio_decode import NoAudioStreamError, decode_audio

        try:
            audio = decode_audio(file_path, SAMPLE_RATE)
        except NoAudioStreamError:
            raise ValueError("o arquivo não tem áudio para transcrever")
        duration_s = len(audio) / SAMPLE_RATE

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

        return {
            "text": text,
            "duration_s": round(duration_s, 2),
            "proc_s": round(proc_s, 2),
            "model": self._model_size,
            "device": self._loaded_device,
        }

    def _transcribe(
        self,
        audio: np.ndarray,
        on_progress: "Callable[[float], None] | None" = None,
        allow_batch: bool = True,
        track: bool = True,
    ) -> str:
        """Transcrição da gravação pelo atalho, seguindo as opções das Configurações:
        - pular silêncios (vad): o Whisper ignora os trechos sem fala;
        - modo em lote: áudios com mais de 30 s são cortados nas pausas e os pedaços vão juntos
          para a placa de vídeo (vários de uma vez, em vez de um depois do outro)."""
        padding = np.zeros(int(SAMPLE_RATE * 0.2), dtype=np.float32)
        audio = np.concatenate([padding, audio])
        duration_s = len(audio) / SAMPLE_RATE
        vad = self._opts["vad"]
        batched = allow_batch and self._opts["batched"] and duration_s > BATCH_MIN_S
        if track:
            self._last_method = (["lote"] if batched else []) + (["sem silêncios"] if vad else [])
        common = dict(
            language=self._language,
            beam_size=5,
            temperature=0,
            condition_on_previous_text=False,
            no_speech_threshold=0.35,
            log_prob_threshold=-1.5,
        )
        with self._infer_lock:
            if batched:
                if self._batched_pipeline is None:
                    from faster_whisper import BatchedInferencePipeline
                    self._batched_pipeline = BatchedInferencePipeline(model=self._whisper)
                kwargs = dict(common, batch_size=BATCH_SIZE, vad_filter=vad)
                if not vad:
                    # sem pular silêncios: corta nas pausas, mas mantém todo o áudio
                    kwargs["clip_timestamps"] = _contiguous_clips(audio)
                segments, _ = self._batched_pipeline.transcribe(audio, **kwargs)
            else:
                segments, _ = self._whisper.transcribe(audio, vad_filter=vad, **common)
            parts: list[str] = []
            for seg in segments:
                parts.append(seg.text)
                if on_progress and duration_s > 0:
                    pct = min(seg.end / duration_s * 100, 99.0)
                    on_progress(round(pct, 1))
        if on_progress:
            on_progress(100.0)
        return " ".join(parts).strip()

    # ---------- prévia do texto enquanto grava (aparece na caixa de mensagem do Chat IA) ----------
    def _preview_worker(self, gen: int) -> None:
        """A cada ~0,7 s transcreve (modo rápido) o que já foi falado e manda o texto parcial.
        Trechos longos: o começo é fixado numa pausa e só o final é refeito. Só usa o modelo quando ele
        está livre e para na hora em que a tecla é solta (a transcrição final não espera)."""
        window = int(PREVIEW_WINDOW_S * SAMPLE_RATE)
        base = 0           # até onde o texto já está fixado
        committed = ""     # texto fixado
        last_len = 0
        while self._recording and self._ptt_gen == gen:
            time.sleep(0.7)
            if not self._ready.is_set() or not self._recording or self._ptt_gen != gen:
                continue
            chunks = list(self._ptt_buffer)
            if not chunks:
                continue
            audio = np.concatenate(chunks)
            if len(audio) - last_len < int(SAMPLE_RATE * 0.5):
                continue  # quase nada novo
            if not self._infer_lock.acquire(blocking=False):
                continue  # o modelo está ocupado (ex.: transcrever enquanto fala): tenta na próxima
            try:
                if len(audio) - base > window:
                    cut = base + _quietest_point(audio[base:], int(window * 0.6), window)
                    committed = (committed + " " + self._quick_text(audio[base:cut])).strip()
                    base = cut
                tail = self._quick_text(audio[base:])
            except Exception as e:
                print(f"[voice] prévia falhou: {e}", flush=True)
                return
            finally:
                self._infer_lock.release()
            last_len = len(audio)
            if self._recording and self._ptt_gen == gen:
                try:
                    self._on_partial((committed + " " + tail).strip())
                except Exception:
                    pass

    def _quick_text(self, audio: np.ndarray) -> str:
        """Transcrição rápida da prévia (chamar com o _infer_lock já pego)."""
        if len(audio) < int(SAMPLE_RATE * 0.3):
            return ""
        segments, _ = self._whisper.transcribe(
            audio, language=self._language, beam_size=1, temperature=0, condition_on_previous_text=False,
            no_speech_threshold=0.5, vad_filter=False, without_timestamps=True,
        )
        text = " ".join(s.text for s in segments).strip()
        return "" if self._is_hallucination(text) else text

    # ---------- transcrever enquanto fala ----------
    def _stream_worker(self, job: dict) -> None:
        """Enquanto a tecla está pressionada: a cada ~25 s gravados, transcreve o trecho já falado
        (cortando numa pausa). Ao soltar, só falta o último pedaço."""
        trigger = int(STREAM_TRIGGER_S * SAMPLE_RATE)
        while self._recording and self._ptt_gen == job["gen"]:
            time.sleep(0.5)
            if not self._ready.is_set():
                continue  # modelo ainda carregando: guarda o áudio e transcreve depois
            chunks = list(self._ptt_buffer)
            if not chunks:
                continue
            audio = np.concatenate(chunks)
            pending = audio[job["consumed"]:]
            if len(pending) < trigger:
                continue
            cut = _quietest_point(pending, int(STREAM_CUT_MIN_S * SAMPLE_RATE), int(STREAM_CUT_MAX_S * SAMPLE_RATE))
            piece = pending[:cut]
            t0 = time.perf_counter()
            try:
                text = self._transcribe(piece, allow_batch=False, track=False)
            except Exception as e:
                print(f"[voice] transcrição durante a fala falhou: {e}", flush=True)
                return
            if self._ptt_gen != job["gen"]:
                return  # cancelada: descarta
            job["proc_s"] += time.perf_counter() - t0
            if text and not self._is_hallucination(text):
                job["parts"].append(text)
            job["consumed"] += cut
            print(f"[voice] durante a fala: +{cut / SAMPLE_RATE:.1f}s transcritos em segundo plano", flush=True)

    def _finish_stream(self, job: dict, full_audio: np.ndarray) -> str:
        """Soltou a tecla: espera o pedaço em andamento (se houver) e transcreve só o que falta."""
        th = job.get("thread")
        if th is not None:
            th.join(timeout=60)
        tail = full_audio[job["consumed"]:]
        parts = list(job["parts"])
        if len(tail) > int(SAMPLE_RATE * 0.3):
            text = self._transcribe(tail, on_progress=self._on_transcription_progress)
            if text and not self._is_hallucination(text):
                parts.append(text)
        method = ["durante a fala"] if job["consumed"] else []
        self._last_method = method + [m for m in self._last_method if m not in method]
        return " ".join(parts).strip()
