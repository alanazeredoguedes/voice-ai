"""Uso do plano do Claude (os mesmos números de claude.ai > Configurações > Uso).

O próprio Claude Code manda, a cada resposta, um evento ``rate_limit_event`` com a % usada da sessão
(janela de 5 horas) e do limite semanal, e quando cada uma reinicia. O app guarda o último valor
(``claude_usage.json`` na pasta de dados) e mostra na tela; nada de login extra nem acessar o site.

Para atualizar sem fazer uma pergunta, ``refresh()`` roda uma chamada mínima (modelo Haiku, resposta de
uma palavra, sem guardar sessão): gasta uma fração ínfima do limite.
"""

import json
import subprocess
import threading
import time
from collections.abc import Callable

from ..config import DATA_DIR

_PATH = DATA_DIR / "claude_usage.json"
_lock = threading.Lock()
_listener: Callable[[dict], None] | None = None
_current: dict | None = None


def set_listener(fn: Callable[[dict], None] | None) -> None:
    """Avisado a cada número novo (o orchestrator manda para a tela pelo WebSocket)."""
    global _listener
    _listener = fn


def get() -> dict | None:
    global _current
    with _lock:
        if _current is None and _PATH.exists():
            try:
                _current = json.loads(_PATH.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                _current = None
        return dict(_current) if _current else None


def record(info: dict) -> None:
    """Guarda o ``rate_limit_info`` de um ``rate_limit_event`` do Claude Code."""
    global _current
    windows = {}
    for name, w in (info.get("unifiedWindows") or {}).items():
        if not isinstance(w, dict):
            continue
        util = w.get("utilization")
        windows[name] = {
            "pct": round(float(util) * 100) if isinstance(util, (int, float)) else None,
            "resets_at": w.get("resetsAt"),
            "status": w.get("status"),
        }
    kind = info.get("rateLimitType")
    if kind and kind not in windows:
        # o Claude Code cita a janela da vez (ex.: five_hour) fora de unifiedWindows, às vezes sem a porcentagem
        windows[kind] = {"pct": None, "resets_at": info.get("resetsAt"), "status": info.get("status")}
    if not windows:
        return
    now = time.time()
    for w in windows.values():
        # horário de reinício já vencido e sem número: não dá para saber o uso (o Claude Code não informa)
        r = w.get("resets_at")
        if w["pct"] is None and isinstance(r, (int, float)) and r <= now:
            w["resets_at"] = None
    # cada evento traz só algumas janelas: junta com as que já tinha (menos as que já reiniciaram)
    before = (get() or {}).get("windows") or {}
    merged = {k: v for k, v in before.items()
              if not (isinstance(v.get("resets_at"), (int, float)) and v["resets_at"] <= now)}
    merged.update(windows)
    data = {"windows": merged, "status": info.get("status"), "updated_at": now}
    with _lock:
        _current = data
        try:
            _PATH.parent.mkdir(parents=True, exist_ok=True)
            _PATH.write_text(json.dumps(data), encoding="utf-8")
        except OSError:
            pass
    if _listener:
        try:
            _listener(dict(data))
        except Exception:
            pass


def refresh(claude_bin: str, cwd: str, env: dict) -> dict | None:
    """Chamada mínima ao Claude Code só para receber os números atualizados."""
    cmd = [claude_bin, "-p", "--model", "haiku", "--output-format", "stream-json", "--verbose",
           "--tools", "", "--strict-mcp-config", "--no-session-persistence",
           "--system-prompt", "Responda apenas: ok"]
    try:
        p = subprocess.run(cmd, input="ok", capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=60, cwd=cwd, env=env)
    except Exception as e:
        print(f"[usage] erro ao atualizar: {e}", flush=True)
        return get()
    for line in p.stdout.splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if ev.get("type") == "rate_limit_event":
            record(ev.get("rate_limit_info") or {})
    return get()
