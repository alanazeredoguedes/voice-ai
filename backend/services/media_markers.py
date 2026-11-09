"""Marcadores de mídia que o Claude insere na resposta.

O Claude escreve, por exemplo, ``[[IMAGENS: Zelda Tears of the Kingdom Zonai Wing | 4]]``.
O ``MediaMarkerFilter`` remove esses marcadores do texto (que vai para o chat e o TTS)
e repassa cada pedido para um callback, que dispara a busca de verdade.
"""

import re
from collections.abc import Callable

MediaCallback = Callable[[str, str, int], None]  # (kind, query, n)

# Tamanho máximo de um marcador; acima disso o "[[" é tratado como texto comum.
_MAX_MARKER_LEN = 300

_MARKER_RE = re.compile(
    r"^\s*(?P<kind>imagens?|images?|v[ií]deos?)\s*:\s*(?P<query>.+?)\s*(?:\|\s*(?P<n>\d+)\s*)?$",
    re.IGNORECASE | re.DOTALL,
)

_PREFIX_RE = re.compile(r"^\s*(imagens?|images?|v[ií]deos?)\s*:", re.IGNORECASE)

DEFAULT_COUNT ={"image": 4, "video": 3}
MAX_COUNT = {"image": 8, "video": 5}


def parse_marker(body: str) -> tuple[str, str, int] | None:
    """Interpreta o conteúdo entre ``[[`` e ``]]``. Retorna (kind, query, n) ou None."""
    m = _MARKER_RE.match(body)
    if not m:
        return None
    kind = "video" if m.group("kind").lower().startswith("v") else "image"
    query = " ".join(m.group("query").split())
    if not query:
        return None
    n = int(m.group("n")) if m.group("n") else DEFAULT_COUNT[kind]
    n = max(1, min(n, MAX_COUNT[kind]))
    return kind, query, n


class MediaMarkerFilter:
    """Filtro incremental: recebe pedaços do stream e devolve só o texto falado/exibido."""

    def __init__(self, on_media: MediaCallback | None = None) -> None:
        self._on_media = on_media
        self._buf = ""

    def _emit(self, body: str) -> bool:
        parsed = parse_marker(body)
        if parsed is None:
            return False
        print(f"[media] pedido: {parsed[0]} x{parsed[2]} | {parsed[1]!r}", flush=True)
        if self._on_media:
            try:
                self._on_media(*parsed)
            except Exception as e:
                print(f"[media] erro no callback: {e}", flush=True)
        return True

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
            if not self._emit(rest[2:j]):
                out.append(rest[: j + 2])  # marcador desconhecido: mantém como texto
        return "".join(out)

    def flush(self) -> str:
        """Fim do stream: devolve o que sobrou. Marcador sem fechar é descartado se for de mídia."""
        rest, self._buf = self._buf, ""
        if rest.startswith("[["):
            body = rest[2:].rstrip("]")
            if self._emit(body) or _PREFIX_RE.match(body):
                return ""
        return rest
