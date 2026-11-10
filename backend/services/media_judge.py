"""Escolha das imagens/vídeos em segundo plano, sem travar a resposta.

O Claude da resposta escreve ``[[IMAGENS: termo | o que precisa aparecer]]`` e CONTINUA escrevendo.
Enquanto isso, o app busca, baixa as miniaturas e pergunta a uma segunda chamada rápida (Haiku), que VÊ
as miniaturas, quais mostram exatamente o que foi pedido. A tela mostra o espaço "carregando" no lugar
do marcador e as imagens entram quando a escolha termina.
"""

import base64
import concurrent.futures
import json
import re
import subprocess
import time

import httpx

JUDGE_MODEL = "haiku"
_TIMEOUT_S = 30
_MAX_CANDIDATES = {"image": 8, "video": 5}
MAX_PICK = {"image": 5, "video": 3}

_SYSTEM = (
    "Você escolhe imagens para ilustrar uma resposta de chat. Olhe cada imagem e responda SÓ com os códigos das "
    "que mostram exatamente o que foi pedido, da melhor para a pior, separados por vírgula (ex.: img3, img1). "
    "Descarte as de outro assunto ou outro jogo, as repetidas, as que são só texto, logo ou capa genérica, e as "
    "de qualidade ruim. Se nenhuma servir, responda: nenhuma."
)


_THUMB_TIMEOUT = 5          # segundos por miniatura
_THUMB_MAX_BYTES = 400_000  # miniatura maior que isso não vai para a IA (gasta muito)
_MIMES = {"image/jpeg", "image/png", "image/gif", "image/webp"}
_POOL = concurrent.futures.ThreadPoolExecutor(max_workers=8, thread_name_prefix="media-judge")


def _small_thumb(url: str) -> str:
    """Miniatura menor quando o servidor deixa escolher o tamanho (menos dados e menos tokens)."""
    if "mm.bing.net/th" in url and "&w=" not in url:
        return url + ("&" if "?" in url else "?") + "w=384&h=384"
    if "i.ytimg.com/vi/" in url:
        return url.replace("/hqdefault.", "/mqdefault.").replace("/maxresdefault.", "/mqdefault.")
    return url


def _fetch_thumb(url: str) -> tuple[str, bytes] | None:
    try:
        r = httpx.get(_small_thumb(url), timeout=_THUMB_TIMEOUT, follow_redirects=True,
                      headers={"User-Agent": "Mozilla/5.0"})
        r.raise_for_status()
        mime = r.headers.get("content-type", "").split(";")[0].strip().lower()
        if mime == "image/jpg":
            mime = "image/jpeg"
        if mime not in _MIMES or not r.content or len(r.content) > _THUMB_MAX_BYTES:
            return None
        return mime, r.content
    except Exception:
        return None


def choose(kind: str, query: str, desc: str, found: list[dict], limit: int | None = None) -> tuple[list[dict], list[dict]] | None:
    """(escolhidas, resto) ou None se não deu para escolher (aí quem chamou decide o que fazer)."""
    from . import brain

    if not found:
        return [], []
    t0 = time.perf_counter()
    cands = found[: _MAX_CANDIDATES[kind] + 4]
    thumbs = list(_POOL.map(lambda it: _fetch_thumb(it.get("thumb") or it.get("url") or ""), cands))
    prefix = "vid" if kind == "video" else "img"
    coded: dict[str, dict] = {}
    content: list[dict] = []
    for it, th in zip(cands, thumbs):
        if th is None or len(coded) >= _MAX_CANDIDATES[kind]:
            continue
        code = f"{prefix}{len(coded) + 1}"
        coded[code] = it
        title = (it.get("title") or "").strip()[:90]
        if kind == "video" and it.get("duration"):
            title += f" [{it['duration']}s]"
        content.append({"type": "text", "text": f"{code}: {title} ({it.get('source') or ''})"})
        content.append({"type": "image", "source": {"type": "base64", "media_type": th[0],
                                                     "data": base64.b64encode(th[1]).decode()}})
    if not coded:
        return None
    t1 = time.perf_counter()
    max_pick = limit or MAX_PICK[kind]
    what = "vídeos" if kind == "video" else "imagens"
    ask = (f"Busca: '{query}'." + (f" Precisa mostrar: {desc}." if desc else "")
           + f" Escolha de 1 a {max_pick} {what}.")
    msg = json.dumps({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": ask}, *content]}})
    cmd = [brain._CLAUDE_BIN, "-p", "--model", JUDGE_MODEL, "--input-format", "stream-json",
           "--output-format", "stream-json", "--verbose", "--tools", "", "--strict-mcp-config",
           "--no-session-persistence", "--system-prompt", _SYSTEM]
    try:
        p = subprocess.run(cmd, input=msg + "\n", capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=_TIMEOUT_S, cwd=brain._claude_cwd(), env=brain._claude_env())
    except Exception as e:
        print(f"[judge] erro: {e}", flush=True)
        return None
    answer = ""
    for line in p.stdout.splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if ev.get("type") == "result" and not ev.get("is_error"):
            answer = str(ev.get("result") or "")
    if not answer:
        return None
    codes = [c.lower() for c in re.findall(rf"{prefix}\d+", answer, re.IGNORECASE)]
    chosen = [coded[c] for c in dict.fromkeys(codes) if c in coded][:max_pick]
    more = [it for c, it in coded.items() if it not in chosen]
    print(f"[judge] {kind} {query!r}: miniaturas {t1 - t0:.1f}s, escolha {time.perf_counter() - t1:.1f}s "
          f"-> {[c for c in codes if c in coded][:max_pick] or 'nenhuma'}", flush=True)
    return chosen, more
