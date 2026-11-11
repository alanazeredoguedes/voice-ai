"""Busca de imagens (Google via Serper.dev ou DuckDuckGo) e vídeos (YouTube via yt-dlp).

As libs ``ddgs`` e ``yt_dlp`` são importadas sob demanda: uma instalação antiga sem elas
continua funcionando, só a busca falha com uma mensagem clara.
"""

import concurrent.futures
import re
import threading
import time
import uuid
from collections.abc import Callable
from typing import Any

import httpx

from .media_judge import _MAX_CANDIDATES, MAX_PICK, MIN_SHOW, count_big, prefer_large

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


# pedidos de coisa nova ("remake", "mais atual", "2026"...): a busca de imagens olha primeiro o último ano
_RECENT = re.compile(r"\b(remake|remaster\w*|atuais|atual|atualizad\w*|recentes?|lan[cç]amento|latest|newest|20(?:2[4-9]|3\d))\b", re.I)


def wants_recent(text: str) -> bool:
    return bool(_RECENT.search(text or ""))


def _images_serper(query: str, n: int, api_key: str, recent: bool = False, page: int = 1) -> list[dict]:
    r = httpx.post(
        "https://google.serper.dev/images",
        headers={"X-API-KEY": api_key, "Content-Type": "application/json"},
        json={"q": query, **({"tbs": "qdr:y"} if recent else {}), **({"page": page} if page > 1 else {})},
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


def _images_ddg(query: str, n: int, recent: bool = False) -> list[dict]:
    try:
        from ddgs import DDGS
    except ImportError as e:
        raise RuntimeError("biblioteca 'ddgs' não instalada") from e
    results = DDGS(timeout=_SEARCH_TIMEOUT).images(query, max_results=n + 4, safesearch="moderate",
                                                   **({"timelimit": "y"} if recent else {}))
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


def search_images_with_provider(query: str, n: int, settings: dict | None = None, recent: bool = False,
                                text: str = "", info: dict | None = None) -> tuple[list[dict], str]:
    """Busca imagens no provedor escolhido. Retorna (itens, provedor que respondeu).

    Busca adaptativa (cada chamada ao Serper custa 1 crédito): faz UMA chamada (10 imagens). Se dela saírem pelo
    menos 8 imagens boas (resolução HD), para aí. Só se faltarem boas faz a segunda chamada: a página 2 do mesmo
    pedido ou, quando o pedido era de coisa recente, a mesma busca sem o filtro de tempo (as recentes ficam na frente).
    ``info`` recebe {"calls", "good", "provider"} para a tela mostrar quantas chamadas foram.
    """
    need = MIN_SHOW["image"]
    try:
        items, provider = _search_provider(query, n, settings, recent)
    except Exception:
        if not recent:
            raise
        items, provider = [], image_provider(settings)
    calls = 1
    good = count_big(items, text or query)
    if good < need and (recent or provider == "serper"):
        if recent:
            more, provider2 = _search_provider(query, n, settings, False)
        else:
            more, provider2 = _search_provider(query, n, settings, False, page=2)
        calls += 1
        items, provider = _dedupe(items + more, n + 20), (provider if items else provider2)
        good = count_big(items, text or query)
    if info is not None:
        info.update(calls=calls, good=good, provider=provider)
    print(f"[media] busca de imagens via {provider}: {calls} chamada(s), {good} boas de {len(items)}", flush=True)
    return items, provider


def _search_provider(query: str, n: int, settings: dict | None, recent: bool, page: int = 1) -> tuple[list[dict], str]:
    """Uma busca no provedor escolhido. Se o Serper falhar (chave inválida, sem créditos, rede), cai para o DuckDuckGo."""
    s = settings or {}
    if image_provider(s) == "serper":
        api_key = (s.get("serper_api_key") or "").strip()
        if not api_key:
            print("[media] Serper selecionado mas sem chave - usando DuckDuckGo", flush=True)
        else:
            try:
                items = _images_serper(query, n, api_key, recent, page)
                if items:
                    return items, "serper"
            except Exception as e:
                print(f"[media] Serper falhou, usando DuckDuckGo: {e}", flush=True)
    return _images_ddg(query, n, recent), "duckduckgo"


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

    def __init__(self, emit: Emit, settings: dict, question: str = "", chat_prompt: str = "") -> None:
        self._emit = emit
        # a pergunta e as instruções do chat (ex.: "especialista no remake") ajudam a IA que escolhe a entender o assunto
        self._context = _context_text(question, chat_prompt)
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
        n = MAX_PICK[kind]  # a tela mostra no mínimo 8 imagens (4 vídeos), rolando para o lado se houver mais
        group = {
            "group_id": uuid.uuid4().hex[:12],
            "kind": kind,
            "query": query,
            "desc": desc,
            "status": "loading",
            "items": [],
            "more": [],
            "picked": True,  # escolhidas olhando as imagens (layout de destaque no meio do texto)
            "preview": False,  # true: são as primeiras da busca, ainda sem a conferência da IA
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
        timing: dict = {}
        stats: dict = {}
        try:
            # busca mais do que vai mostrar: uma segunda IA olha as miniaturas e escolhe as certas
            if group["kind"] == "video":
                found = search_videos(group["query"], _MAX_CANDIDATES["video"] + 2)
            else:
                text = f'{group["query"]} {group.get("desc") or ""}'
                info: dict = {}
                found, group["provider"] = search_images_with_provider(
                    group["query"], _MAX_CANDIDATES["image"] + 4, self._settings,
                    recent=wants_recent(text), text=text, info=info)
                timing["search_calls"] = info.get("calls")
            if group["kind"] == "image":
                found = prefer_large(found, f'{group["query"]} {group.get("desc") or ""}')
            timing["search"] = round(time.perf_counter() - t0, 1)
            if found:
                # item 1: as primeiras da busca já aparecem na tela como prévia, enquanto a IA confere
                timing["preview"] = timing["search"]
                group.update(status="loading", items=found[:MIN_SHOW[group["kind"]]], preview=True)
                self._emit({"type": "chat_media", **group})
            picked = (choose(group["kind"], group["query"], group.get("desc") or "", found, n, context=self._context,
                             timing=timing, stats=stats)
                      if found else ([], []))
            if picked is None:  # não deu para escolher (falha da IA): mostra as primeiras, como antes
                keep = MIN_SHOW[group["kind"]]
                picked = (found[:keep], found[keep:keep + 8])
            items, more = picked
            if items:
                # quanto tempo levou para gerar este bloco (e onde): a tela mostra embaixo das imagens
                timing.update(cost_usd=round(stats.get("cost", 0.0), 4), tokens=stats.get("tokens", 0), calls=stats.get("calls", 0))
                group.update(status="done", items=items, more=more, preview=False,
                             took_s=round(time.perf_counter() - t0, 1), timing=timing)
            else:
                group.update(status="error", error="Nada que mostre exatamente isso", items=[], preview=False)
        except Exception as e:
            print(f"[media] erro na busca {group['kind']} {group['query']!r}: {e}", flush=True)
            group.update(status="error", error="Não foi possível buscar agora", items=[], preview=False)
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


# ---------------------------------------------------------------------------
# Repesquisar / refinar um bloco de imagens (botões do bloco, na tela)
# ---------------------------------------------------------------------------

def rerun_group(group: dict, note: str, settings: dict, cancel: threading.Event | None = None,
                on_preview: Callable[[list[dict]], None] | None = None) -> dict:
    """Busca de novo as imagens/vídeos de UM bloco. Devolve o bloco novo (mesmo group_id) ou {"error": "..."}.

    Sem ``note`` ("repesquisar"): mesmo termo e mesma descrição, pulando o que já estava no bloco.
    Com ``note`` ("refinar"): o pedido do usuário entra no termo de busca e vira a regra principal da escolha.
    O ``context`` guardado na resposta (a pergunta e o trecho em volta) acompanha a busca e a escolha.
    ``cancel``: se for acionado, a chamada ao Claude é encerrada e nada mais é feito (economiza uso).
    ``on_preview``: recebe as primeiras da busca assim que ela termina (a tela mostra como prévia, enquanto a IA confere).
    """
    from .media_judge import choose, rewrite_query

    def cancelled() -> bool:
        return cancel is not None and cancel.is_set()

    kind = group.get("kind")
    if kind not in ("image", "video"):
        return {"error": "Tipo de mídia desconhecido"}
    note = (note or "").strip()[:400]
    query = group.get("query") or ""
    desc = group.get("desc") or ""
    context = group.get("context") or ""
    what = "vídeo" if kind == "video" else "imagem"
    t0 = time.perf_counter()
    timing: dict = {}
    stats: dict = {}
    try:
        if note:
            query = rewrite_query(query, desc, note, context, cancel)
            timing["rewrite"] = round(time.perf_counter() - t0, 1)
            desc = f"{desc}. PEDIDO DO USUÁRIO (é a regra principal): {note}".strip(". ")
        if cancelled():
            return {"error": "Cancelado"}
        if kind == "video":
            found, provider = search_videos(query, _MAX_CANDIDATES["video"] + 4), "youtube"
        else:
            info: dict = {}
            found, provider = search_images_with_provider(
                query, _MAX_CANDIDATES["image"] + 4, settings, recent=wants_recent(f"{query} {desc}"),
                text=f"{query} {desc}", info=info)
            timing["search_calls"] = info.get("calls")
            found = prefer_large(found, f"{query} {desc}")
        if cancelled():
            return {"error": "Cancelado"}
        timing["search"] = round(time.perf_counter() - t0 - timing.get("rewrite", 0), 1)
        if not note:
            # repesquisar: o que já estava no bloco não volta (se sobrar pouco, vale tudo)
            seen = {it.get("url") for it in (group.get("items") or [])}
            fresh = [it for it in found if it.get("url") not in seen]
            found = fresh if len(fresh) >= MIN_SHOW[kind] else found
        if not found:
            return {"error": f"A busca não achou nenhum {what}" if kind == "video" else "A busca não achou nenhuma imagem"}
        if on_preview is not None and not cancelled():
            on_preview(found[:MIN_SHOW[kind]])
        picked = choose(kind, query, desc, found, MAX_PICK[kind], context=context, lenient=True, cancel=cancel,
                        timing=timing, stats=stats)
        if cancelled():
            return {"error": "Cancelado"}
        if picked is None:  # a IA que escolhe falhou: mostra as primeiras
            keep = MIN_SHOW[kind]
            picked = (found[:keep], found[keep:keep + 8])
        items, more = picked
        if not items:
            return {"error": f"Nenhum {what} se aproximou do pedido" if kind == "video" else "Nenhuma imagem se aproximou do pedido"}
    except Exception as e:
        print(f"[media] erro ao repesquisar {group.get('query')!r}: {e}", flush=True)
        return {"error": "Não foi possível buscar agora"}
    timing.update(cost_usd=round(stats.get("cost", 0.0), 4), tokens=stats.get("tokens", 0), calls=stats.get("calls", 0))
    return {**group, "query": query, "desc": desc, "provider": provider, "status": "done",
            "items": items, "more": more, "picked": True,
            "took_s": round(time.perf_counter() - t0, 1), "timing": timing}


_MARK = re.compile(r"\[\[media:[0-9a-f]+\]\]")


def _context_text(question: str, chat_prompt: str, before: str = "") -> str:
    q = " ".join((question or "").split())[:300]
    p = " ".join((chat_prompt or "").split())[:400]
    out = (f"Instruções do chat: {p}. " if p else "") + (f"Pergunta do usuário: {q}. " if q else "")
    return (out + (f"Trecho da resposta sobre isso: {before}" if before else "")).strip()


def attach_context(groups: list[dict], question: str, answer: str, chat_prompt: str = "") -> None:
    """Guarda em cada bloco o contexto do que se buscava (a pergunta do usuário e o trecho da resposta logo antes
    do bloco). Assim "refinar" depois ainda sabe de qual jogo, item ou assunto se trata."""
    for g in groups:
        pos = answer.find(f"[[media:{g.get('group_id')}]]")
        before = _MARK.sub("", answer[:pos] if pos >= 0 else answer)
        before = " ".join(re.sub(r"[#*_`>|]", " ", before).split())[-600:]
        g["context"] = _context_text(question, chat_prompt, before)
