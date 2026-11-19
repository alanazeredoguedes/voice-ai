"""Log do sistema: tudo o que acontece no app, para depurar problemas que só aparecem na máquina de alguém.

Junta numa lista só (memória + arquivo + tela de Logs → Sistema, ao vivo):
  - o que o backend registra com `log(...)` e tudo o que ele já escrevia com `print` (capturado);
  - erros não tratados (de qualquer thread) e pedidos à API que falham ou alteram algo;
  - o que a tela e o processo principal do Electron mandam (POST /logs/system).

Nunca guarda o conteúdo do que a pessoa disse ou escreveu (transcrições, mensagens): só que aconteceu.
Arquivo: <dados do app>/logs/sistema.log (até ~5 MB, com uma cópia anterior em sistema.log.1).
"""
from __future__ import annotations

import collections
import io
import os
import platform
import re
import sys
import threading
import time
import traceback
from collections.abc import Callable

from .config import DATA_DIR

MAX_ENTRIES = 5000
MAX_FILE_BYTES = 5 * 1024 * 1024
LOG_FILE = DATA_DIR / "logs" / "sistema.log"
LEVELS = ("debug", "info", "warn", "error")

_buf: collections.deque[dict] = collections.deque(maxlen=MAX_ENTRIES)
_lock = threading.Lock()
_seq = 0
_emit: Callable[[dict], None] | None = None
_orig_stdout = sys.stdout
_orig_stderr = sys.stderr


def set_emitter(fn: Callable[[dict], None] | None) -> None:
    """Para onde mandar cada linha nova (o WebSocket da tela de Logs)."""
    global _emit
    _emit = fn


def _write_file(line: str) -> None:
    try:
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        if LOG_FILE.exists() and LOG_FILE.stat().st_size > MAX_FILE_BYTES:
            os.replace(LOG_FILE, LOG_FILE.with_suffix(".log.1"))
        with LOG_FILE.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass  # o log nunca pode derrubar o app


def log(level: str, category: str, msg: str, source: str = "backend", t: float | None = None) -> dict:
    """Registra uma linha. level: debug | info | warn | error. category: área do app (atalhos, microfone, chamada...)."""
    global _seq
    level = level if level in LEVELS else "info"
    entry_t = t or time.time()
    with _lock:
        _seq += 1
        entry = {
            "id": _seq,
            "t": entry_t,
            "level": level,
            "cat": str(category)[:40] or "geral",
            "src": str(source)[:20],
            "msg": str(msg)[:4000],
        }
        _buf.append(entry)
    stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(entry_t)) + f".{int((entry_t % 1) * 1000):03d}"
    _write_file(f"{stamp} {level.upper():5} [{entry['src']}/{entry['cat']}] {entry['msg']}")
    if _emit:
        try:
            _emit({"type": "system_log", "log": entry})
        except Exception:
            pass
    return entry


def entries(since_id: int = 0, limit: int = MAX_ENTRIES) -> list[dict]:
    with _lock:
        items = [e for e in _buf if e["id"] > since_id]
    return items[-limit:]


def clear() -> None:
    with _lock:
        _buf.clear()


def exc_text(e: BaseException) -> str:
    """Erro com o local onde aconteceu (as últimas linhas do traceback)."""
    tb = traceback.format_exception(type(e), e, e.__traceback__)
    return "".join(tb[-3:]).strip()[-1500:]


# ---------------------------------------------------------------- o que já era escrito com print

# o texto do que a pessoa disse nunca vai para o log
_REDACT = [
    (re.compile(r"(📝 Você:)\s*(.*)$"), lambda m: f"{m.group(1)} (texto omitido, {len(m.group(2))} caracteres)"),
    (re.compile(r"(alucinação descartada:)\s*(.*)$"), lambda m: f"{m.group(1)} (texto omitido)"),
]
# linhas de acesso do uvicorn: só os pedidos com erro interessam (as outras ficam no middleware)
_ACCESS = re.compile(r'^INFO:\s+[\d.]+:\d+ - "(\w+) ([^"]*?) HTTP/[\d.]+" (\d{3})')
_PREFIX = re.compile(r"^\[([\w\- ]{1,30})\]\s*(.*)$")


class _Tee(io.TextIOBase):
    """Continua escrevendo no terminal e também manda cada linha completa para o log do sistema."""

    def __init__(self, stream, level: str) -> None:
        self._stream = stream
        self._level = level
        self._pending = ""
        self._local = threading.local()

    def write(self, s: str) -> int:
        try:
            self._stream.write(s)
        except Exception:
            pass
        if getattr(self._local, "busy", False):
            return len(s)
        self._local.busy = True
        try:
            self._pending += s
            while "\n" in self._pending:
                line, self._pending = self._pending.split("\n", 1)
                self._handle(line.rstrip())
        finally:
            self._local.busy = False
        return len(s)

    def flush(self) -> None:
        try:
            self._stream.flush()
        except Exception:
            pass

    def isatty(self) -> bool:
        return False

    def _handle(self, line: str) -> None:
        if not line.strip():
            return
        m = _ACCESS.match(line)
        if m:
            return  # pedidos à API: registrados pelo middleware (com duração e só os relevantes)
        for rx, fn in _REDACT:
            line = rx.sub(fn, line)
        level = self._level
        low = line.lower()
        if "traceback" in low or "error" in low or "erro" in low or "exception" in low:
            level = "error" if self._level == "warn" or "traceback" in low else "warn"
        p = _PREFIX.match(line)
        if p:
            log(level, p.group(1).strip().lower(), p.group(2))
        else:
            log(level, "geral", line)


def install() -> None:
    """Liga a captura de print/erros. Chamado uma vez, na partida do backend."""
    if not isinstance(sys.stdout, _Tee):
        sys.stdout = _Tee(_orig_stdout, "info")
    if not isinstance(sys.stderr, _Tee):
        sys.stderr = _Tee(_orig_stderr, "warn")

    def on_exception(exc_type, exc, tb) -> None:
        log("error", "erro", "erro não tratado: " + "".join(traceback.format_exception(exc_type, exc, tb))[-2000:])

    def on_thread_exception(args: threading.ExceptHookArgs) -> None:
        if args.exc_type is SystemExit:
            return
        name = args.thread.name if args.thread else "?"
        log("error", "erro", f"erro não tratado na thread {name}: " +
            "".join(traceback.format_exception(args.exc_type, args.exc_value, args.exc_traceback))[-2000:])

    sys.excepthook = on_exception
    threading.excepthook = on_thread_exception


def environment_summary() -> str:
    """Sistema em que o backend está rodando (primeira linha útil para depurar)."""
    env = os.environ
    parts = [
        f"{platform.system()} {platform.release()} ({platform.machine()})",
        f"Python {platform.python_version()}",
    ]
    if sys.platform.startswith("linux"):
        try:
            for line in open("/etc/os-release", encoding="utf-8"):
                if line.startswith("PRETTY_NAME="):
                    parts.append(line.split("=", 1)[1].strip().strip('"'))
        except OSError:
            pass
        parts.append(f"sessão {env.get('XDG_SESSION_TYPE') or '?'} ({env.get('XDG_CURRENT_DESKTOP') or '?'})")
        parts.append(f"DISPLAY={env.get('DISPLAY') or '-'} WAYLAND_DISPLAY={env.get('WAYLAND_DISPLAY') or '-'}")
    parts.append(f"dados em {DATA_DIR}")
    return " | ".join(parts)
