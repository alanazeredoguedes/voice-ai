"""Escolha das imagens/vídeos em segundo plano, sem travar a resposta.

O Claude da resposta escreve ``[[IMAGENS: termo | o que precisa aparecer]]`` e CONTINUA escrevendo.
Enquanto isso, o app busca, baixa as miniaturas e pergunta a uma segunda chamada rápida (Haiku), que VÊ
as miniaturas, quais mostram exatamente o que foi pedido (e escreve uma legenda curta de cada uma).
A tela mostra o espaço "carregando" no lugar do marcador e as imagens entram quando a escolha termina.
"""

import base64
import concurrent.futures
import io
import json
import re
import subprocess
import threading
import time

import httpx

from . import claude_usage

try:
    from PIL import Image
except ImportError:  # sem o Pillow: usa as miniaturas como vêm (menores)
    Image = None

JUDGE_MODEL = "haiku"
_TIMEOUT_S = 60   # 16 imagens maiores + legenda de todas: a chamada leva ~20 s, com folga para picos
_MAX_CANDIDATES = {"image": 12, "video": 8}   # quantas miniaturas a IA olha de uma vez
MAX_PICK = {"image": 12, "video": 8}          # quantas ela pode escolher
MIN_SHOW = {"image": 8, "video": 4}           # a tela sempre mostra pelo menos isso (8 quadradinhos / 4 vídeos)

_BASE = (
    "Você escolhe {what} para ilustrar uma resposta de chat. Olhe cada uma. Responda com UMA linha por item "
    "escolhido, do melhor para o pior, no formato 'codigo: legenda' (ex.: 'img3: Link segurando o graveto aceso, "
    "captura de tela do jogo'). "
)
_CAPTION_IMAGE = (
    "A legenda tem no máximo 12 palavras, em português, e descreve só o que você VÊ, dizendo também o tipo da "
    "imagem (captura de tela do jogo, arte oficial, desenho, foto, render 3D, diagrama). "
)
_CAPTION_VIDEO = (
    "A legenda é o TÍTULO do vídeo traduzido para o português (curto, no máximo 12 palavras; se já estiver em "
    "português, só limpe), sem descrever a miniatura. "
)
_RULES = (
    "Se o pedido ou o contexto citam uma versão ou edição específica (original, remaster, remake, console, "
    "temporada), aceite SÓ imagens dessa versão, conferindo pelo visual (jogo antigo tem gráficos de baixa "
    "resolução e formas quadradas; remake e remaster têm visual moderno e nítido), pelo título e pela fonte. "
    "Foto de aparelho, banner, matéria e propaganda não servem como referência do jogo. "
    "Respeite o tipo de imagem pedido: se pediram captura de tela do jogo, arte, desenho e render não servem; se "
    "pediram foto, desenho não serve. Descarte as de outro assunto ou outro jogo, as repetidas, as que são só "
    "texto, logo ou capa genérica e as de qualidade ruim. Imagens pequenas ou borradas que não dão para analisar "
    "também saem. "
)
_STRICT = "Se NENHUMA for sequer parecida com o pedido, responda apenas: nenhuma."
_LENIENT = (
    "Esta é uma segunda busca: as melhores opções já foram mostradas, então escolha as que MAIS SE APROXIMAM do "
    "pedido, mesmo que não sejam perfeitas (pelo menos as 4 mais próximas), descartando só as claramente de "
    "outro assunto. Só responda 'nenhuma' se todas forem de outro assunto."
)

_REWRITE_SYSTEM = (
    "Você escreve termos de busca de imagens ou vídeos. Receba o contexto da conversa, o termo original, o que a "
    "imagem precisa mostrar e o pedido novo do usuário. Responda SÓ com o novo termo de busca (de 3 a 12 palavras), "
    "incorporando o pedido do usuário e mantendo o assunto original (jogo, item, personagem) como no contexto. Use "
    "inglês se o assunto for de jogo, filme, série ou produto internacional; senão, o idioma natural do assunto. "
    "Sem aspas, sem explicações."
)

_THUMB_TIMEOUT = 5          # segundos por miniatura
_THUMB_MAX_BYTES = 400_000  # miniatura maior que isso não vai para a IA (gasta muito)
THUMB_SIDE = 640            # lado maior da imagem enviada para a IA que escolhe (antes 384)
_BIG_TIMEOUT = 3            # segundos para baixar a original quando a miniatura é pequena demais (passou disso, usa a miniatura)
_FETCH_BUDGET_S = 6         # tempo máximo esperando as miniaturas; as que não chegaram ficam de fora
_ORIGINAL_BELOW = 450       # miniatura com menos que isso (lado maior) pede a original; a do Bing (474 px) já serve
_BIG_MAX_BYTES = 3_000_000
_MIMES = {"image/jpeg", "image/png", "image/gif", "image/webp"}
_POOL = concurrent.futures.ThreadPoolExecutor(max_workers=16, thread_name_prefix="media-judge")

# imagens pequenas não servem de referência (jogo, pessoa, item), menos quando o pedido é logo/ícone/símbolo
_SMALL_OK = re.compile(r"\b(logos?|logotipos?|[ií]cones?|icons?|s[ií]mbolos?|emblemas?|bras[aã]o|sprites?|favicons?|selos?)\b", re.I)
MIN_W, MIN_H = 800, 400   # menos que isso (largura x altura) não serve de referência


def is_big(it: dict) -> bool:
    """Resolução boa (800 x 400 ou mais). Sem tamanho informado, não descarta."""
    w, h = it.get("width"), it.get("height")
    return not (isinstance(w, (int, float)) and isinstance(h, (int, float))) or (w >= MIN_W and h >= MIN_H)


def count_big(items: list[dict], text: str) -> int:
    """Quantas imagens boas há (para logo/ícone/símbolo, todas servem)."""
    return len(items) if _SMALL_OK.search(text or "") else sum(1 for it in items if is_big(it))


def prefer_large(found: list[dict], text: str) -> list[dict]:
    """Põe as imagens em resolução boa na frente. As pequenas vão para o fim da fila, da maior para a menor
    (só chegam à IA se faltarem boas). Para logo/ícone/símbolo não mexe. Sem tamanho informado, não descarta."""
    if _SMALL_OK.search(text or ""):
        return found
    large = [it for it in found if is_big(it)]
    small = sorted((it for it in found if not is_big(it)),
                   key=lambda it: -((it.get("width") or 0) * (it.get("height") or 0)))
    return large + small


def _small_thumb(url: str) -> str:
    """Miniatura menor quando o servidor deixa escolher o tamanho (menos dados e menos tokens)."""
    if "mm.bing.net/th" in url and "&w=" not in url:
        return url + ("&" if "?" in url else "?") + f"w={THUMB_SIDE}"
    if "i.ytimg.com/vi/" in url:
        return url.replace("/mqdefault.", "/hqdefault.").replace("/maxresdefault.", "/hqdefault.")
    return url


def _get(url: str, timeout: float, cap: int) -> tuple[str, bytes] | None:
    """Baixa uma imagem (até ``cap`` bytes). None se falhar, não for imagem ou for grande demais."""
    try:
        deadline = time.monotonic() + timeout * 1.5
        with httpx.stream("GET", url, timeout=timeout, follow_redirects=True,
                          headers={"User-Agent": "Mozilla/5.0"}) as r:
            r.raise_for_status()
            mime = r.headers.get("content-type", "").split(";")[0].strip().lower()
            if mime == "image/jpg":
                mime = "image/jpeg"
            if mime not in _MIMES:
                return None
            buf = bytearray()
            for chunk in r.iter_bytes():
                buf += chunk
                if len(buf) > cap or time.monotonic() > deadline:
                    return None
        return (mime, bytes(buf)) if buf else None
    except Exception:
        return None


def _dims(data: bytes) -> tuple[int, int] | None:
    try:
        return Image.open(io.BytesIO(data)).size
    except Exception:
        return None


def _to_jpeg(data: bytes, side: int) -> bytes | None:
    """Reduz para no máximo ``side`` pixels no lado maior (JPEG)."""
    try:
        im = Image.open(io.BytesIO(data))
        im.load()
        if max(im.size) > side:
            im.thumbnail((side, side))
        if im.mode != "RGB":
            im = im.convert("RGB")
        out = io.BytesIO()
        im.save(out, "JPEG", quality=82)
        return out.getvalue()
    except Exception:
        return None


def _fetch_thumb(it: dict) -> tuple[str, bytes] | None:
    """Imagem que a IA vai ver. A miniatura da busca costuma ser pequena (Google: ~250 px): se for, tenta a
    original e reduz para 640 px, para dar para ver o que há na imagem (versão do jogo, item, texto)."""
    thumb_url = it.get("thumb") or it.get("url") or ""
    got = _get(_small_thumb(thumb_url), _THUMB_TIMEOUT, _THUMB_MAX_BYTES)
    if Image is None:
        return got
    dims = _dims(got[1]) if got else None
    orig = it.get("url") or ""
    if it.get("kind", "image") == "image" and (dims is None or max(dims) < _ORIGINAL_BELOW) and orig and orig != thumb_url:
        big = _get(orig, _BIG_TIMEOUT, _BIG_MAX_BYTES)
        jpg = _to_jpeg(big[1], THUMB_SIDE) if big else None
        if jpg:
            return "image/jpeg", jpg
    if got and dims and max(dims) > THUMB_SIDE + 60:
        jpg = _to_jpeg(got[1], THUMB_SIDE)
        if jpg:
            return "image/jpeg", jpg
    return got


_STATS_LOCK = threading.Lock()


def ask_claude(system: str, content: list[dict], cancel: threading.Event | None = None, *,
               model: str = JUDGE_MODEL, timeout: float = _TIMEOUT_S, stats: dict | None = None) -> str | None:
    """Uma chamada única ao Claude (padrão: Haiku; sem ferramentas, sem sessão). None se falhar ou se for cancelada:
    ao cancelar, o processo do Claude é encerrado na hora (para de gastar)."""
    from . import brain

    msg = json.dumps({"type": "user", "message": {"role": "user", "content": content}})
    cmd = [brain._CLAUDE_BIN, "-p", "--model", model, "--input-format", "stream-json",
           "--output-format", "stream-json", "--verbose", "--tools", "", "--strict-mcp-config",
           "--no-session-persistence", "--system-prompt", system]
    try:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                encoding="utf-8", errors="replace", cwd=brain._claude_cwd(), env=brain._claude_env())
    except Exception as e:
        print(f"[judge] erro: {e}", flush=True)
        return None
    deadline = time.monotonic() + timeout
    stdout = ""
    first = True
    while True:
        try:
            stdout, _ = proc.communicate(input=(msg + "\n") if first else None, timeout=0.3)
            break
        except subprocess.TimeoutExpired:
            first = False
            if (cancel is not None and cancel.is_set()) or time.monotonic() > deadline:
                proc.kill()
                proc.communicate()
                if cancel is not None and cancel.is_set():
                    print("[judge] cancelado: chamada ao Claude encerrada", flush=True)
                return None
        except Exception as e:
            print(f"[judge] erro: {e}", flush=True)
            proc.kill()
            return None
    answer = ""
    for line in (stdout or "").splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if ev.get("type") == "rate_limit_event":
            # o uso do plano (sessão e semana) que o Claude Code informa: a tela atualiza sozinha depois de cada chamada
            claude_usage.record(ev.get("rate_limit_info") or {})
        if ev.get("type") == "result" and not ev.get("is_error"):
            answer = str(ev.get("result") or "")
            if stats is not None:  # custo (US$ de tabela) e tokens desta chamada, somados em ``stats``
                u = ev.get("usage") or {}
                tokens = sum(int(u.get(k) or 0) for k in ("input_tokens", "cache_creation_input_tokens",
                                                          "cache_read_input_tokens", "output_tokens"))
                with _STATS_LOCK:
                    stats["cost"] = stats.get("cost", 0.0) + float(ev.get("total_cost_usd") or 0.0)
                    stats["tokens"] = stats.get("tokens", 0) + tokens
                    stats["calls"] = stats.get("calls", 0) + 1
    return answer or None


def rewrite_query(query: str, desc: str, note: str, context: str = "", cancel: threading.Event | None = None) -> str:
    """Novo termo de busca com o pedido do usuário ("dentro do jogo", "mais detalhado"...), usando o contexto
    guardado do que se buscava. Se a IA não responder, junta os textos."""
    ask = (f"Contexto da conversa: {context or '(não guardado)'}\nTermo original: {query}\n"
           f"O que precisa mostrar: {desc or '(não informado)'}\nPedido novo do usuário: {note}")
    out = ask_claude(_REWRITE_SYSTEM, [{"type": "text", "text": ask}], cancel)
    new = (out or "").strip().strip("\"'`").splitlines()[0].strip() if out else ""
    return new[:160] or f"{query} {note}".strip()[:160]


def _parse_answer(answer: str, prefix: str) -> tuple[list[str], dict[str, str], list[str]]:
    """Códigos escolhidos (na ordem), a legenda de cada um e a ordem das demais (melhor primeiro).
    Aceita também só os códigos separados por vírgula."""
    codes: list[str] = []
    rest: list[str] = []
    caps: dict[str, str] = {}
    # antes da linha '---': as escolhidas, na ordem; depois: as demais (só entram as legendas)
    head, _, tail = re.split(r"(?m)^(\s*-{3,}\s*)$", answer, maxsplit=1) if re.search(r"(?m)^\s*-{3,}\s*$", answer) else (answer, "", "")
    for part, is_head in ((head, True), (tail, False)):
        for line in part.splitlines():
            m = re.match(rf"^\W*({prefix}\d+)\b\W*(.*)$", line.strip(), re.IGNORECASE)
            if not m:
                continue
            code = m.group(1).lower()
            if is_head and code not in codes:
                codes.append(code)
            elif not is_head and code not in rest:
                rest.append(code)
            cap = m.group(2).strip().strip("*_ ").strip()
            if cap and code not in caps and not re.fullmatch(rf"(?:{prefix}\d+[\s,;]*)+", cap, re.IGNORECASE):
                caps[code] = cap[:140]
    for c in re.findall(rf"{prefix}\d+", head, re.IGNORECASE):
        if c.lower() not in codes:
            codes.append(c.lower())
    return codes, caps, rest


def choose(kind: str, query: str, desc: str, found: list[dict], limit: int | None = None, *,
           context: str = "", lenient: bool = False, cancel: threading.Event | None = None,
           timing: dict | None = None, stats: dict | None = None) -> tuple[list[dict], list[dict]] | None:
    """(escolhidas com legenda, resto) ou None se não deu para escolher (aí quem chamou decide o que fazer).
    Uma chamada ao Haiku com todas as candidatas; só as escolhidas ganham legenda em português.
    ``lenient``: segunda busca (repesquisar/refinar), escolhe as mais próximas em vez de exigir perfeição."""
    if not found:
        return [], []
    t0 = time.perf_counter()
    cands = found[: _MAX_CANDIDATES[kind] + 2]  # +2 de reserva para downloads que falharem
    # item 2: não espera os downloads lentos; o que não chegou a tempo fica de fora desta escolha
    futs = [_POOL.submit(_fetch_thumb, it) for it in cands]
    done, _ = concurrent.futures.wait(futs, timeout=_FETCH_BUDGET_S)
    thumbs = [f.result() if f in done and f.exception() is None else None for f in futs]
    if cancel is not None and cancel.is_set():
        return None
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
        size = f" {it['width']}x{it['height']}" if kind == "image" and it.get("width") and it.get("height") else ""
        content.append({"type": "text", "text": f"{code}: {title} ({it.get('source') or ''}){size}"})
        content.append({"type": "image", "source": {"type": "base64", "media_type": th[0],
                                                     "data": base64.b64encode(th[1]).decode()}})
    if not coded:
        return None
    t1 = time.perf_counter()
    max_pick = limit or MAX_PICK[kind]
    what = "vídeos" if kind == "video" else "imagens"
    system = (_BASE.format(what=what) + (_CAPTION_VIDEO if kind == "video" else _CAPTION_IMAGE) + _RULES
              + (_LENIENT if lenient else _STRICT))
    ask = ((f"Contexto da conversa: {context}\n" if context else "")
           + f"Busca: '{query}'." + (f" Precisa mostrar: {desc}." if desc else "")
           + f" Escolha até {max_pick} {what} (as melhores primeiro; menos se poucas servirem).")
    answer = ask_claude(system, [{"type": "text", "text": ask}, *content], cancel, stats=stats)
    if timing is not None:
        timing["thumbs"], timing["judge"] = round(t1 - t0, 1), round(time.perf_counter() - t1, 1)
    if not answer:
        return None
    codes, caps, _ = _parse_answer(answer, prefix)
    if not any(c in coded for c in codes):
        print(f"[judge] {kind} {query!r}: a IA não aprovou nenhuma. Resposta: {answer[:300]!r}", flush=True)
    picked = [c for c in dict.fromkeys(codes) if c in coded][:max_pick]
    chosen = [{**coded[c], **({"caption": caps[c]} if c in caps else {})} for c in picked]
    more = [it for c, it in coded.items() if c not in picked]
    if chosen and len(chosen) < MIN_SHOW[kind]:
        # a tela tem sempre 8 imagens (4 vídeos): completa com as do resto (sem legenda)
        need = MIN_SHOW[kind] - len(chosen)
        chosen, more = chosen + more[:need], more[need:]
    print(f"[judge] {kind} {query!r}: miniaturas {t1 - t0:.1f}s, escolha {time.perf_counter() - t1:.1f}s "
          f"-> {picked or 'nenhuma'}", flush=True)
    return chosen, more
