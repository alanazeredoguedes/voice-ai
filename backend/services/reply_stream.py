"""Monta a resposta do Claude conforme ela chega: guarda o markdown e corta as frases para a voz.

Usado pelo chat digitado (``routes/chat.py``) e pela pergunta por voz (``orchestrator``).
As frases saem com a posição no ``plain`` (texto falado, ver ``rich_text``), que é a referência de
todas as posições da fala: cache de áudio, destaque das palavras, "parou em", "ouvir daqui".
"""

from . import rich_text

_ENDS = ".!?…"


class ReplyComposer:
    def __init__(self) -> None:
        self.md = ""
        self._spoken = 0  # posição no plain até onde as frases já saíram
        self._n = 0       # frases soltas (a 1ª corta mais cedo, para a voz começar logo)

    @property
    def plain(self) -> str:
        return rich_text.to_plain(self.md)

    def feed(self, delta: str) -> tuple[str, list[tuple[str, int]]]:
        """Recebe um pedaço do texto. Devolve (pedaço normalizado para a tela, frases prontas)."""
        delta = rich_text.normalize(delta)
        self.md += delta
        plain = rich_text.to_plain(self.md, partial=True)
        # a última linha terminou: o fim do plain é fim de bloco (título, item...) e pode ser falado
        line_done = self.md.endswith("\n")
        return delta, self._cut(plain, final=line_done)

    def finish(self) -> list[tuple[str, int]]:
        """Fim da resposta: solta o que sobrou."""
        return self._cut(rich_text.to_plain(self.md), final=True)

    def _cut(self, plain: str, final: bool) -> list[tuple[str, int]]:
        out: list[tuple[str, int]] = []
        start = self._spoken
        i = start
        n = len(plain)
        while i < n:
            ch = plain[i]
            boundary = -1
            hard = False  # fim de bloco: sai mesmo sendo curta
            if ch == "\n":
                boundary, hard = i, True
            elif ch in _ENDS and i + 1 < n and plain[i + 1] in " \n":
                boundary = i + 1
            elif ch == "," and i + 1 < n and plain[i + 1] == " " and \
                    len(plain[start:i + 1].split()) >= (5 if self._n == 0 else 20):
                boundary = i + 1
            if boundary != -1:
                piece = plain[start:boundary]
                text = piece.strip()
                # frase curta ("Sim.", "1.") junta com a seguinte, a não ser no fim de um bloco
                if text and (hard or len(text.split()) >= 3):
                    out.append((text, start + (len(piece) - len(piece.lstrip()))))
                    self._n += 1
                    start = boundary
                elif not text:
                    start = boundary
            i += 1
        if final and start < n:
            piece = plain[start:]
            text = piece.strip()
            if text:
                out.append((text, start + (len(piece) - len(piece.lstrip()))))
                self._n += 1
            start = n
        self._spoken = start
        return out
