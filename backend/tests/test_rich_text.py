"""Testes do texto das respostas (markdown → texto falado) e do corte de frases.

Rodar: ``backend\\venv\\Scripts\\python.exe -m backend.tests.test_rich_text`` (na raiz do projeto).
Os mesmos casos de ``fixtures/rich_text_cases.json`` rodam no frontend (richText.test.mjs).
"""

import json
from pathlib import Path

from backend.services import rich_text
from backend.services.reply_stream import ReplyComposer

CASES = json.loads((Path(__file__).parent / "fixtures" / "rich_text_cases.json").read_text(encoding="utf-8"))

# textos longos para testar a geração aos poucos
STREAM_SAMPLES = [c["md"] for c in CASES] + [
    "Aaah, agora entendi! Você está falando dos **amiibo** em *Tears of the Kingdom*.\n\n"
    "Os amiibo são figuras NFC da Nintendo.\n[[media:g1]]\n"
    "## Para que servem os amiibo?\nQuando você utiliza um amiibo compatível, pode receber:\n"
    "- **Baús:** com armas, materiais e outros itens.\n- **Comidas:** cogumelos e peixes.\n\n"
    "### Como usar no jogo?\n1. Abra o menu de habilidades.\n2. Selecione a habilidade **amiibo**.\n"
    "3. Aproxime o amiibo do controle.\n\n| Amiibo | Recompensa |\n|---|---|\n| Link | Tecido |\n"
    "**Importante:** veja (https://nintendo.com) e o [guia](https://x.com/a) também. Fim.",
    "Texto com 5 * 3 e `código *não* itálico` e mais. Outra frase aqui, com vírgula, e fim.",
]


def check_cases() -> int:
    fails = 0
    for c in CASES:
        got = rich_text.to_plain(rich_text.normalize(c["md"]))
        if got != c["plain"]:
            fails += 1
            print(f"FALHOU {c['name']!r}\n  esperado: {c['plain']!r}\n  veio:     {got!r}")
    return fails


def check_prefix_stability() -> int:
    """Durante a geração o plain só cresce no fim (nunca muda o que já pode ter sido falado)."""
    fails = 0
    for md in STREAM_SAMPLES:
        final = rich_text.to_plain(md)
        for k in range(len(md) + 1):
            p = rich_text.to_plain(md[:k], partial=True)
            if not final.startswith(p):
                fails += 1
                print(f"INSTÁVEL em {k}: {md[:k]!r}\n  parcial: {p!r}\n  final:   {final[:len(p) + 10]!r}")
                break
    return fails


def check_composer() -> int:
    """Frases do ReplyComposer: cobrem o plain inteiro, na ordem, e cada posição bate com o texto."""
    fails = 0
    for md in STREAM_SAMPLES:
        for step in (1, 3, 7, 40):
            comp = ReplyComposer()
            sentences = []
            for k in range(0, len(md), step):
                sentences += comp.feed(md[k:k + step])[1]
            sentences += comp.finish()
            plain = comp.plain
            joined = " ".join(t for t, _ in sentences)
            if joined.split() != plain.split():
                fails += 1
                print(f"COMPOSER (passo {step}) não cobre o texto:\n  {joined!r}\n  {plain!r}")
                continue
            last = -1
            for t, off in sentences:
                if plain[off:off + len(t)] != t or off <= last:
                    fails += 1
                    print(f"COMPOSER (passo {step}) posição errada: {t!r} em {off}")
                    break
                last = off
    return fails


def main() -> None:
    total = check_cases() + check_prefix_stability() + check_composer()
    print("OK" if total == 0 else f"{total} falha(s)")
    raise SystemExit(1 if total else 0)


if __name__ == "__main__":
    main()
