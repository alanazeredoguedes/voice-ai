"""Marcadores de mídia que o Claude insere na resposta.

O Claude escreve, por exemplo, ``[[IMAGENS: Zelda Tears of the Kingdom Zonai Wing | 4]]``.
O ``MediaMarkerFilter`` remove esses marcadores do texto (que vai para o chat e o TTS)
e repassa cada pedido para um callback, que dispara a busca de verdade.
"""

import re
from collections.abc import Callable

# (kind, query, n, descrição) -> id do grupo criado (o marcador vira a linha "[[media:id]]" no lugar onde estava)
MediaCallback = Callable[[str, str, int, str], "str | None"]

# Tamanho máximo de um marcador; acima disso o "[[" é tratado como texto comum.
_MAX_MARKER_LEN = 400

# [[IMAGENS: termo de busca | o que precisa aparecer]] (a descrição e/ou a quantidade são opcionais)
_MARKER_RE = re.compile(
    r"^\s*(?P<kind>imagens?|images?|v[ií]deos?)\s*:\s*(?P<rest>.+?)\s*$",
    re.IGNORECASE | re.DOTALL,
)

_PREFIX_RE = re.compile(r"^\s*(imagens?|images?|v[ií]deos?)\s*:", re.IGNORECASE)

DEFAULT_COUNT = {"image": 5, "video": 3}
MAX_COUNT = {"image": 8, "video": 5}


def parse_marker(body: str) -> tuple[str, str, int, str] | None:
    """Interpreta o conteúdo entre ``[[`` e ``]]``. Retorna (kind, query, n, descrição) ou None."""
    m = _MARKER_RE.match(body)
    if not m:
        return None
    kind = "video" if m.group("kind").lower().startswith("v") else "image"
    parts = [" ".join(p.split()) for p in m.group("rest").split("|")]
    query = parts[0]
    if not query:
        return None
    n = DEFAULT_COUNT[kind]
    desc = ""
    for p in parts[1:]:
        if p.isdigit():
            n = int(p)
        elif p:
            desc = p
    n = max(1, min(n, MAX_COUNT[kind]))
    return kind, query, n, desc


class MediaMarkerFilter:
    """Filtro incremental: recebe pedaços do stream e devolve só o texto falado/exibido."""

    def __init__(self, on_media: MediaCallback | None = None) -> None:
        self._on_media = on_media
        self._buf = ""

    def _emit(self, body: str) -> str | None:
        """Marcador de mídia: dispara a busca e devolve o que fica no texto no lugar dele
        (a linha ``[[media:id]]``, para as imagens aparecerem ali). None = não é marcador de mídia."""
        parsed = parse_marker(body)
        if parsed is None:
            return None
        print(f"[media] pedido: {parsed[0]} x{parsed[2]} | {parsed[1]!r}", flush=True)
        gid = None
        if self._on_media:
            try:
                gid = self._on_media(*parsed)
            except Exception as e:
                print(f"[media] erro no callback: {e}", flush=True)
        return f"\n[[media:{gid}]]\n" if gid else ""

    def feed(self, delta: str) -> str:
        self._buf += delta
        out: list[str] = []
        while True:
            i = self._buf.find("[[")
            if i == -1:
                # Um "[" no fim pode ser o começo de um marcador que chega no próximo pedaço
                if self._buf.endswith("["):
                    out.append(self._buf[:-1])
                    self._buf = "["
                else:
                    out.append(self._buf)
                    self._buf = ""
                break
            out.append(self._buf[:i])
            rest = self._buf[i:]
            j = rest.find("]]")
            if j == -1:
                if len(rest) > _MAX_MARKER_LEN:
                    # Não é marcador: libera o "[[" como texto e continua
                    out.append(rest[:2])
                    self._buf = rest[2:]
                    continue
                self._buf = rest  # aguarda o resto do marcador
                break
            self._buf = rest[j + 2:]
            repl = self._emit(rest[2:j])
            if repl is None:
                out.append(rest[: j + 2])  # marcador desconhecido: mantém como texto
            else:
                out.append(repl)
        return "".join(out)

    def flush(self) -> str:
        """Fim do stream: devolve o que sobrou. Marcador sem fechar é descartado se for de mídia."""
        rest, self._buf = self._buf, ""
        if rest.startswith("[["):
            body = rest[2:].rstrip("]")
            repl = self._emit(body)
            if repl is not None:
                return repl
            if _PREFIX_RE.match(body):
                return ""
        return rest
