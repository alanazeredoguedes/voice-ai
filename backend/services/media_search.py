"""Busca de imagens (Google via Serper.dev ou DuckDuckGo) e vídeos (YouTube via yt-dlp).

As libs ``ddgs`` e ``yt_dlp`` são importadas sob demanda: uma instalação antiga sem elas
continua funcionando, só a busca falha com uma mensagem clara.
"""

import concurrent.futures
import threading
import time
import uuid
from collections.abc import Callable
from typing import Any

import httpx

_SEARCH_TIMEOUT = 12  # segundos por busca
_POOL = concurrent.futures.ThreadPoolExecutor(max_workers=4, thread_name_prefix="media")

Emit = Callable[[dict], None]


# ---------------------------------------------------------------------------
# Imagens
# ---------------------------------------------------------------------------

def _dedupe(items: list[dict], n: int) -> list[dict]:
    seen: set[str] = set()
    out: list[dict] = []
    for it in items:
        if not it.get("url") or it["url"] in seen:
            continue
        seen.add(it["url"])
        out.append(it)
        if len(out) >= n:
            break
    return out


def _images_serper(query: str, n: int, api_key: str) -> list[dict]:
    r = httpx.post(
        "https://google.serper.dev/images",
        headers={"X-API-KEY": api_key, "Content-Type": "application/json"},
        json={"q": query},
        timeout=_SEARCH_TIMEOUT,
    )
    r.raise_for_status()
    items = [
        {
            "kind": "image",
            "url": x.get("imageUrl"),
            "thumb": x.get("thumbnailUrl") or x.get("imageUrl"),
            "title": x.get("title") or "",
            "source": x.get("domain") or x.get("source") or "",
            "page_url": x.get("link") or "",
            "width": x.get("imageWidth"),
            "height": x.get("imageHeight"),
        }
        for x in r.json().get("images", [])
    ]
    return _dedupe(items, n)


def _images_ddg(query: str, n: int) -> list[dict]:
    try:
        from ddgs import DDGS
    except ImportError as e:
        raise RuntimeError("biblioteca 'ddgs' não instalada") from e
    results = DDGS(timeout=_SEARCH_TIMEOUT).images(query, max_results=n + 4, safesearch="moderate")
    items = [
        {
            "kind": "image",
            "url": x.get("image"),
            # thumbnail do DDG passa pelo proxy do Bing e carrega mesmo quando o site bloqueia hotlink
            "thumb": x.get("thumbnail") or x.get("image"),
            "title": x.get("title") or "",
            "source": x.get("source") or "",
            "page_url": x.get("url") or "",
            "width": _to_int(x.get("width")),
            "height": _to_int(x.get("height")),
        }
        for x in results or []
    ]
    return _dedupe(items, n)


PROVIDER_NAMES = {"duckduckgo": "DuckDuckGo", "serper": "Google (Serper)"}


def image_provider(settings: dict | None) -> str:
    """Provedor escolhido nas Configurações. Sem escolha salva: Serper se houver chave, senão DuckDuckGo."""
    s = settings or {}
    p = s.get("image_provider")
    if p in PROVIDER_NAMES:
        return p
    return "serper" if (s.get("serper_api_key") or "").strip() else "duckduckgo"


def search_images_with_provider(query: str, n: int, settings: dict | None = None) -> tuple[list[dict], str]:
    """Busca imagens no provedor escolhido. Retorna (itens, provedor que respondeu).
    Se o Serper falhar (chave inválida, sem créditos, rede), cai para o DuckDuckGo."""
    s = settings or {}
    if image_provider(s) == "serper":
        api_key = (s.get("serper_api_key") or "").strip()
        if not api_key:
            print("[media] Serper selecionado mas sem chave - usando DuckDuckGo", flush=True)
        else:
            try:
                items = _images_serper(query, n, api_key)
                if items:
                    return items, "serper"
            except Exception as e:
                print(f"[media] Serper falhou, usando DuckDuckGo: {e}", flush=True)
    return _images_ddg(query, n), "duckduckgo"


def serper_balance(api_key: str) -> dict:
    """Créditos restantes da chave do Serper (GET /account - não gasta crédito)."""
    key = (api_key or "").strip()
    if not key:
        return {"ok": False, "error": "sem chave"}
    try:
        r = httpx.get("https://google.serper.dev/account", headers={"X-API-KEY": key}, timeout=10)
        if r.status_code in (401, 403):
            return {"ok": False, "error": "Chave inválida"}
        r.raise_for_status()
        data = r.json()
        return {"ok": True, "balance": data.get("balance"), "rate_limit": data.get("rateLimit")}
    except Exception as e:
        return {"ok": False, "error": f"Não foi possível consultar: {e}"}


def test_provider(provider: str, settings: dict) -> dict:
    """Faz uma busca real de teste SEM fallback, para validar o provedor/chave nas Configurações."""
    t0 = time.perf_counter()
    try:
        if provider == "serper":
            key = (settings.get("serper_api_key") or "").strip()
            if not key:
                return {"ok": False, "error": "Cole a chave do Serper antes de testar."}
            items = _images_serper("Rio de Janeiro Cristo Redentor", 3, key)
        elif provider == "duckduckgo":
            items = _images_ddg("Rio de Janeiro Cristo Redentor", 3)
        elif provider == "youtube":
            items = search_videos("Rio de Janeiro", 1)
        else:
            return {"ok": False, "error": f"Provedor desconhecido: {provider}"}
    except httpx.HTTPStatusError as e:
        code = e.response.status_code
        if code in (401, 403):
            msg = "Chave inválida ou sem permissão."
        elif code == 429:
            msg = "Limite de buscas da chave atingido (sem créditos)."
        else:
            msg = f"O serviço respondeu com erro {code}."
        return {"ok": False, "error": msg}
    except Exception as e:
        return {"ok": False, "error": f"Falha na busca: {e}"}
    ms = int((time.perf_counter() - t0) * 1000)
    if not items:
        return {"ok": False, "error": "A busca funcionou mas não trouxe resultados."}
    return {"ok": True, "count": len(items), "ms": ms, "sample": items[0].get("thumb")}


# ---------------------------------------------------------------------------
# Vídeos
# ---------------------------------------------------------------------------

def search_videos(query: str, n: int) -> list[dict]:
    try:
        import yt_dlp
    except ImportError as e:
        raise RuntimeError("biblioteca 'yt-dlp' não instalada") from e
    opts = {
        "extract_flat": True,
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "socket_timeout": _SEARCH_TIMEOUT,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"ytsearch{n}:{query}", download=False)
    items = []
    for e in (info or {}).get("entries") or []:
        vid = e.get("id")
        if not vid:
            continue
        items.append({
            "kind": "video",
            "video_id": vid,
            "url": f"https://www.youtube.com/watch?v={vid}",
            "thumb": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
            "title": e.get("title") or "",
            "source": e.get("channel") or e.get("uploader") or "YouTube",
            "page_url": f"https://www.youtube.com/watch?v={vid}",
            "duration": _to_int(e.get("duration")),
        })
    return items[:n]


def _to_int(v: Any) -> int | None:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Dispatcher por resposta
# ---------------------------------------------------------------------------

class MediaDispatcher:
    """Recebe os pedidos de mídia de UMA resposta, busca em paralelo e avisa a UI via ``emit``.

    Eventos ``chat_media``: primeiro ``status="loading"`` (placeholder na UI), depois
    ``status="done"`` com ``items`` ou ``status="error"`` com ``error``.
    """

    def __init__(self, emit: Emit, settings: dict) -> None:
        self._emit = emit
        self._settings = settings
        self._groups: list[dict] = []
        self._futures: list[concurrent.futures.Future] = []
        self._lock = threading.Lock()

    @property
    def enabled(self) -> bool:
        return bool(self._settings.get("media_enabled", True))

    def request(self, kind: str, query: str, n: int, desc: str = "") -> str | None:
        """Começa a busca e devolve o id do grupo (a resposta guarda onde ele aparece no texto).
        A resposta continua chegando enquanto isso: a tela mostra o espaço "carregando" no lugar."""
        if not self.enabled:
            return None
        if kind == "image":
            n = 5  # a tela mostra até 5 (uma grande + 4 à direita); a IA que olha escolhe de 1 a 5
        group = {
            "group_id": uuid.uuid4().hex[:12],
            "kind": kind,
            "query": query,
            "desc": desc,
            "status": "loading",
            "items": [],
            "more": [],
            "picked": True,  # escolhidas olhando as imagens (layout de destaque no meio do texto)
            "provider": "youtube" if kind == "video" else image_provider(self._settings),
        }
        with self._lock:
            self._groups.append(group)
        self._emit({"type": "chat_media", **group})
        self._futures.append(_POOL.submit(self._run, group, n))
        return group["group_id"]

    def _run(self, group: dict, n: int) -> None:
        from .media_judge import choose

        t0 = time.perf_counter()
        try:
            # busca mais do que vai mostrar: uma segunda IA olha as miniaturas e escolhe as certas
            if group["kind"] == "video":
                found = search_videos(group["query"], 6)
            else:
                found, group["provider"] = search_images_with_provider(group["query"], 12, self._settings)
            picked = choose(group["kind"], group["query"], group.get("desc") or "", found, n) if found else ([], [])
            if picked is None:  # não deu para escolher (falha da IA): mostra as primeiras, como antes
                picked = (found[: min(n, 3)], found[min(n, 3):8])
            items, more = picked
            if items:
                group.update(status="done", items=items, more=more)
            else:
                group.update(status="error", error="Nada que mostre exatamente isso")
        except Exception as e:
            print(f"[media] erro na busca {group['kind']} {group['query']!r}: {e}", flush=True)
            group.update(status="error", error="Não foi possível buscar agora")
        print(
            f"[media] {group['kind']} {group['status']} ({len(group['items'])}) via {group['provider']} "
            f"em {time.perf_counter() - t0:.1f}s | {group['query']!r}",
            flush=True,
        )
        self._emit({"type": "chat_media", **group})

    @property
    def has_requests(self) -> bool:
        return bool(self._groups)

    def wait_all(self, timeout: float = _SEARCH_TIMEOUT + 35) -> list[dict]:
        """Espera as buscas terminarem e devolve os grupos com resultado (para salvar no banco)."""
        if self._futures:
            concurrent.futures.wait(self._futures, timeout=timeout)
        with self._lock:
            return [dict(g) for g in self._groups if g["status"] == "done" and g["items"]]
