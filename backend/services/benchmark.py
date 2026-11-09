"""Testar desempenho: roda os áudios de teste (com o texto correto) em várias combinações de
modelo, dispositivo e modo, e mede tempo e taxa de erro (WER) de cada uma.

Os áudios ficam em backend/assets/benchmark (montados por tools/build_benchmark_audio.py).
Cada teste usa uma instância própria do SpeechEngine, separada da usada no dia a dia.
"""
import difflib
import gc
import json
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable

import numpy as np

from ..config import DATA_DIR
from . import speech_engine as se

ASSETS = Path(__file__).resolve().parent.parent / "assets" / "benchmark"
REPORT_PATH = DATA_DIR / "benchmark_last.json"
SR = se.SAMPLE_RATE

# Modos testados: mesmas opções das Configurações (gravação pelo atalho)
MODES: dict[str, dict[str, Any]] = {
    "normal": {"label": "Normal", "batched": False, "vad": False, "stream": False},
    "batched": {"label": "Lote", "batched": True, "vad": False, "stream": False},
    "vad": {"label": "Pular silêncios", "batched": False, "vad": True, "stream": False},
    "batched_vad": {"label": "Lote + pular silêncios", "batched": True, "vad": True, "stream": False},
    "stream": {"label": "Transcrever enquanto fala", "batched": True, "vad": False, "stream": True},
}

# Velocidade padrão (x mais rápido que o tempo do áudio) quando não há histórico nos Logs
DEFAULT_SPEED_GPU = {"tiny": 60, "base": 45, "small": 30, "medium": 20, "large-v3-turbo": 25, "large-v3": 10}
CPU_FACTOR = 0.1
LOAD_S = {"cuda": 8.0, "cpu": 15.0}


# ---------- biblioteca de áudios ----------
def load_library() -> list[dict]:
    out = []
    for js in sorted(ASSETS.glob("*.json")):
        try:
            meta = json.loads(js.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not (ASSETS / f"{meta['id']}.ogg").is_file():
            continue
        out.append(meta)
    return out


def library_public() -> list[dict]:
    """Biblioteca sem os textos (para a tela)."""
    return [
        {k: m[k] for k in ("id", "title", "description", "source", "credit", "license", "url", "duration_s")}
        | {"cuts": [{"minutes": c["minutes"], "end_s": c["end_s"]} for c in m["cuts"]]}
        for m in load_library()
    ]


def reference_text(meta: dict, minutes: int) -> tuple[str, float]:
    cut = next(c for c in meta["cuts"] if c["minutes"] == minutes)
    text = " ".join(s["text"] for s in meta["segments"][: cut["segments"]])
    return text, float(cut["end_s"])


# ---------- comparação com o texto correto ----------
# grafias equivalentes que não devem contar como erro
_EQUIV = {"quatorze": "catorze", "cinqüenta": "cinquenta", "freqüente": "frequente", "à": "a", "às": "as"}


def _num_to_words(m: re.Match) -> str:
    from num2words import num2words

    raw = m.group(0)
    try:
        if "," in raw:
            return " " + num2words(float(raw.replace(".", "").replace(",", ".")), lang="pt_BR") + " "
        return " " + num2words(int(raw.replace(".", "")), lang="pt_BR") + " "
    except Exception:
        return raw


def normalize(text: str) -> list[str]:
    """Deixa os dois textos comparáveis: minúsculas, sem pontuação, números por extenso
    ("1822" e "mil oitocentos e vinte e dois" contam como a mesma coisa)."""
    t = text.lower()
    t = t.replace("%", " por cento ")
    t = re.sub(r"(\d+)\s*[ºª°]", lambda m: " " + m.group(1) + " ", t)
    t = re.sub(r"\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:,\d+)?", _num_to_words, t)
    t = re.sub(r"[^\w\s]|_", " ", t)
    return [_EQUIV.get(w, w) for w in t.split()]


def word_diff(ref: list[str], hyp: list[str]) -> dict:
    """Taxa de erro de palavras (WER) e o que mudou: palavras faltando, trocadas e sobrando."""
    sm = difflib.SequenceMatcher(None, ref, hyp, autojunk=False)
    sub = dele = ins = 0
    ops: list[dict] = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            ops.append({"op": "equal", "text": " ".join(hyp[j1:j2])})
        elif tag == "delete":
            dele += i2 - i1
            ops.append({"op": "missing", "text": " ".join(ref[i1:i2])})
        elif tag == "insert":
            ins += j2 - j1
            ops.append({"op": "extra", "text": " ".join(hyp[j1:j2])})
        else:  # replace
            n_ref, n_hyp = i2 - i1, j2 - j1
            sub += min(n_ref, n_hyp)
            dele += max(0, n_ref - n_hyp)
            ins += max(0, n_hyp - n_ref)
            ops.append({"op": "replace", "ref": " ".join(ref[i1:i2]), "text": " ".join(hyp[j1:j2])})
    n = max(1, len(ref))
    return {
        "wer": round((sub + dele + ins) / n * 100, 2),
        "substituted": sub,
        "missing": dele,
        "inserted": ins,
        "ref_words": len(ref),
        "hyp_words": len(hyp),
        "diff": ops,
    }


# ---------- velocidade conhecida (para a estimativa de tempo) ----------
def history_speeds(db_path: Path) -> dict[str, float]:
    """Velocidade mediana (rtf) de cada modelo/dispositivo nas gravações reais dos Logs."""
    import sqlite3

    speeds: dict[str, list[float]] = {}
    try:
        with sqlite3.connect(db_path) as conn:
            for model, device, rtf in conn.execute(
                "SELECT model, device, rtf FROM transcription_logs WHERE rtf IS NOT NULL AND audio_s > 5"
            ):
                speeds.setdefault(f"{model}|{device}", []).append(float(rtf))
    except Exception:
        return {}
    return {k: float(np.median(v)) for k, v in speeds.items() if v}


def default_speeds() -> dict[str, float]:
    out = {}
    for m, s in DEFAULT_SPEED_GPU.items():
        out[f"{m}|cuda"] = s
        out[f"{m}|cpu"] = s * CPU_FACTOR
    return out


# ---------- execução ----------
class BenchmarkRunner:
    """Um teste por vez; manda o andamento e cada resultado pela WebSocket assim que fica pronto."""

    def __init__(self, emit: Callable[[dict], None], language: str | None = None) -> None:
        self._emit = emit
        self._language = language
        self._lock = threading.Lock()
        self._cancel = threading.Event()
        self.job: dict | None = None

    @property
    def running(self) -> bool:
        return bool(self.job and self.job["status"] == "running")

    def start(self, models: list[str], devices: list[str], audios: list[dict], modes: list[str]) -> dict:
        with self._lock:
            if self.running:
                raise RuntimeError("Já existe um teste em andamento")
            lib = {m["id"]: m for m in load_library()}
            tests = []
            sel_audios = sorted(
                [a for a in audios if a["id"] in lib],
                key=lambda a: reference_text(lib[a["id"]], int(a["minutes"]))[1],
            )
            for model in models:
                for device in devices:
                    # do áudio mais curto para o mais longo: os primeiros resultados chegam rápido
                    for a in sel_audios:
                        _, end_s = reference_text(lib[a["id"]], int(a["minutes"]))
                        for mode in modes:
                            if mode not in MODES:
                                continue
                            tests.append({
                                "test_id": f"t{len(tests) + 1}",
                                "model": model,
                                "device": device,
                                "audio_id": a["id"],
                                "audio_title": lib[a["id"]]["title"],
                                "minutes": int(a["minutes"]),
                                "duration_s": round(end_s, 2),
                                "mode": mode,
                                "mode_label": MODES[mode]["label"],
                                "status": "queued",
                                "progress": 0.0,
                            })
            if not tests:
                raise ValueError("Nada para testar")
            self._cancel.clear()
            self.job = {
                "job_id": uuid.uuid4().hex[:8],
                "status": "running",
                "started_at": time.time(),
                "tests": tests,
                "results": {},
            }
            threading.Thread(target=self._run, args=(self.job,), daemon=True).start()
            self._emit({"type": "benchmark_started", "job": self._public(self.job)})
            return self._public(self.job)

    def cancel(self) -> None:
        self._cancel.set()

    @staticmethod
    def _public(job: dict) -> dict:
        return {k: job[k] for k in ("job_id", "status", "started_at", "tests", "results")} | {
            "finished_at": job.get("finished_at")
        }

    def _set(self, test: dict, **kw) -> None:
        test.update(kw)
        self._emit({"type": "benchmark_progress", "job_id": self.job["job_id"], "test_id": test["test_id"],
                    "status": test["status"], "progress": test.get("progress", 0.0)})

    def _run(self, job: dict) -> None:
        lib = {m["id"]: m for m in load_library()}
        audio_cache: dict[str, np.ndarray] = {}
        groups: dict[tuple, list[dict]] = {}
        for t in job["tests"]:
            groups.setdefault((t["model"], t["device"]), []).append(t)
        try:
            for (model, device), tests in groups.items():
                if self._cancel.is_set():
                    break
                for t in tests:
                    self._set(t, status="loading")
                engine = se.SpeechEngine(model_size=model, device=device, language=self._language)
                try:
                    engine._load_models()
                except Exception as e:
                    for t in tests:
                        self._fail(job, t, f"Não foi possível carregar {model} em {device}: {e}")
                    continue
                for t in tests:
                    self._set(t, status="queued")
                try:
                    for t in tests:
                        if self._cancel.is_set():
                            break
                        self._run_test(job, engine, t, lib, audio_cache)
                finally:
                    engine._whisper = None
                    engine._batched_pipeline = None
                    del engine
                    gc.collect()  # devolve a memória da placa de vídeo
        except Exception as e:
            print(f"[benchmark] erro: {e}", flush=True)
        finally:
            job["status"] = "cancelled" if self._cancel.is_set() else "done"
            job["finished_at"] = time.time()
            for t in job["tests"]:
                if t["status"] in ("queued", "loading", "running"):
                    t["status"] = "cancelled"
            try:
                REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
                REPORT_PATH.write_text(json.dumps(self._public(job), ensure_ascii=False), encoding="utf-8")
            except OSError:
                pass
            self._emit({"type": "benchmark_done", "job": self._public(job)})

    def _fail(self, job: dict, t: dict, msg: str) -> None:
        self._set(t, status="error")
        job["results"][t["test_id"]] = {"error": msg}
        self._emit({"type": "benchmark_result", "job_id": job["job_id"], "test_id": t["test_id"],
                    "result": job["results"][t["test_id"]]})

    def _run_test(self, job: dict, engine: se.SpeechEngine, t: dict, lib: dict, cache: dict) -> None:
        meta = lib[t["audio_id"]]
        if t["audio_id"] not in cache:
            from .audio_decode import decode_audio
            cache[t["audio_id"]] = decode_audio(str(ASSETS / f"{t['audio_id']}.ogg"), SR)
        ref_text, end_s = reference_text(meta, t["minutes"])
        audio = cache[t["audio_id"]][: int(end_s * SR)]
        mode = MODES[t["mode"]]
        engine.set_options({"batched": mode["batched"], "vad": mode["vad"], "stream": False})
        self._set(t, status="running", progress=0.0)
        last = [0.0]

        def on_progress(pct: float) -> None:
            if self._cancel.is_set():
                raise _Cancelled()
            now = time.monotonic()
            if now - last[0] > 0.3 or pct >= 100:
                last[0] = now
                self._set(t, progress=round(pct, 1))

        try:
            t0 = time.perf_counter()
            if mode["stream"]:
                text, wait_s = self._simulate_stream(engine, audio, on_progress)
            else:
                text = engine._transcribe(audio, on_progress=on_progress, track=False)
                wait_s = None
            total_s = time.perf_counter() - t0
        except _Cancelled:
            self._set(t, status="cancelled")
            return
        except Exception as e:
            self._fail(job, t, str(e))
            return
        d = word_diff(normalize(ref_text), normalize(text))
        proc_s = wait_s if wait_s is not None else total_s
        result = {
            "proc_s": round(proc_s, 3),  # o que você esperaria depois de soltar a tecla
            "total_s": round(total_s, 3),  # trabalho total da placa/processador
            "speed": round(t["duration_s"] / total_s, 1) if total_s > 0 else None,
            "text": text,
            **d,
        }
        job["results"][t["test_id"]] = result
        self._set(t, status="done", progress=100.0)
        self._emit({"type": "benchmark_result", "job_id": job["job_id"], "test_id": t["test_id"], "result": result})

    @staticmethod
    def _simulate_stream(engine: se.SpeechEngine, audio: np.ndarray, on_progress) -> tuple[str, float]:
        """Transcrever enquanto fala: os pedaços seriam transcritos durante a gravação; o que conta
        para quem usa é só o pedaço final, depois de soltar a tecla."""
        trigger = int(se.STREAM_TRIGGER_S * SR)
        consumed, parts = 0, []
        n = len(audio)
        while n - consumed >= trigger:
            pending = audio[consumed:]
            cut = se._quietest_point(pending, int(se.STREAM_CUT_MIN_S * SR), int(se.STREAM_CUT_MAX_S * SR))
            txt = engine._transcribe(pending[:cut], allow_batch=False, track=False)
            if txt and not engine._is_hallucination(txt):
                parts.append(txt)
            consumed += cut
            on_progress(min(99.0, consumed / n * 100))
        t0 = time.perf_counter()
        tail = audio[consumed:]
        if len(tail) > int(SR * 0.3):
            txt = engine._transcribe(tail, track=False)
            if txt and not engine._is_hallucination(txt):
                parts.append(txt)
        wait = time.perf_counter() - t0
        on_progress(100.0)
        return " ".join(parts).strip(), wait


class _Cancelled(Exception):
    pass


def last_report() -> dict | None:
    try:
        return json.loads(REPORT_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
