"""Texto das respostas do chat: markdown simples + marcadores de mídia.

A resposta é guardada como markdown (``content``). O que a voz fala é o ``plain``: o mesmo texto sem
os símbolos de formatação e sem os marcadores de mídia. Todas as posições usadas na fala (cache de
áudio, destaque das palavras, "parou em", "ouvir daqui") apontam para o ``plain``.

A MESMA lógica existe no frontend (``frontend/src/renderer/src/utils/richText.ts``); os casos de
``backend/tests/fixtures/rich_text_cases.json`` garantem que os dois dão o mesmo resultado.

Regras do ``plain``:
- cada bloco (parágrafo, título, item, linha de tabela) vira uma linha; blocos unidos por ``\\n``;
- item numerado entra como ``"1. texto"``;
- tabela não é lida: no lugar dela entra o aviso ``TABLE_SPOKEN`` (uma vez por tabela);
- ``**``, ``*``, `````` ` `````` e ``#`` não entram; ``[texto](url)`` vira ``texto``; URL solta sai;
- resposta antiga (texto corrido sem formatação) tem ``plain == content``.

Durante a geração (``partial=True``) o ``plain`` só cresce no fim: o que ainda pode mudar de
sentido (um ``**`` no fim, a última linha que ainda não definiu se é lista, uma linha de tabela)
fica de fora até chegar o resto.
"""

import re

MEDIA_LINE_RE = re.compile(r"^\[\[media:([A-Za-z0-9_-]+)\]\]$")
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")
_BULLET_RE = re.compile(r"^[-*•]\s+(.*)$")
_ORDERED_RE = re.compile(r"^(\d{1,3})[.)]\s+(.*)$")
_TABLE_SEP_RE = re.compile(r"^\|?[\s:|-]+$")
# começo de linha que ainda pode virar título/lista quando chegar o resto
_UNSETTLED_RE = re.compile(r"^(#{1,6}|[-*•]|\d{1,3}[.)]?)$")
_LINK_RE = re.compile(r"\[([^\]\n]*)\]\((https?://[^)\s]*)\)")
_MAYBE_LINK_RE = re.compile(r"\[[^\]\n]*(\](\([^)\s]*)?)?$")
_LONG_DASH_RE = re.compile("[–—]")
# o que a voz fala no lugar de uma tabela (ler linha por linha não ajuda)
TABLE_SPOKEN = "Deixei uma tabela aqui no chat pra você dar uma olhada."
_URL_START_RE =re.compile(r"(^|[\s(])(h|ht|htt|https?|https?:|https?:/)$")


def normalize(text: str) -> str:
    """Ajustes aplicados ao texto que chega do Claude antes de guardar (o app só usa hífen simples)."""
    return _LONG_DASH_RE.sub("-", text.replace("\r\n", "\n").replace("\r", "\n"))


# ---------------------------------------------------------------------------
# Inline
# ---------------------------------------------------------------------------

def parse_inline(s: str, partial: bool = False) -> list[dict]:
    """Trechos ``{text, bold, italic, code}``. Os símbolos de formatação não aparecem no ``text``.
    ``partial``: a linha ainda está chegando; o que pode mudar de sentido no fim fica de fora."""
    if partial:
        # fim que ainda pode mudar: espaços/parênteses (podem anteceder uma URL, que some) e o começo
        # de uma URL ("h", "ht", ... "https:/")
        s = s.rstrip(" \t(")
        m = _URL_START_RE.search(s)
        if m:
            s = s[: m.start(2)].rstrip(" \t(")
    runs: list[dict] = []
    bold = italic = code = False
    buf: list[str] = []

    def flush() -> None:
        if buf:
            runs.append({"text": "".join(buf), "bold": bold, "italic": italic, "code": code})
            buf.clear()

    i, n = 0, len(s)
    while i < n:
        ch = s[i]
        if code:
            if ch == "`":
                flush()
                code = False
            else:
                buf.append(ch)
            i += 1
            continue
        if ch == "`":
            if partial and i == n - 1:
                break  # pode ser o começo de um código
            flush()
            code = True
            i += 1
            continue
        if ch == "*":
            k = i
            while k < n and s[k] == "*":
                k += 1
            if partial and k == n:
                break  # "**" no fim: só dá para saber se abre/fecha quando chegar o resto
            prev = s[i - 1] if i > 0 else " "
            nxt = s[k] if k < n else " "
            run = k - i
            while run > 0:
                size = 2 if run >= 2 else 1
                is_bold = size == 2
                opened = bold if is_bold else italic
                if opened and not prev.isspace():
                    flush()
                    if is_bold:
                        bold = False
                    else:
                        italic = False
                elif not opened and not nxt.isspace():
                    flush()
                    if is_bold:
                        bold = True
                    else:
                        italic = True
                else:
                    buf.append("*" * size)
                run -= size
            i = k
            continue
        if ch == "[":
            m = _LINK_RE.match(s, i)
            if m:
                buf.append(m.group(1))
                i = m.end()
                continue
            if partial and _MAYBE_LINK_RE.match(s, i):
                break  # pode virar um link quando chegar o resto
            buf.append(ch)
            i += 1
            continue
        if ch == "h" and (s.startswith("http://", i) or s.startswith("https://", i)) and (i == 0 or s[i - 1] in " (\t"):
            k = i
            while k < n and not s[k].isspace() and s[k] != ")":
                k += 1
            # URL solta: não aparece nem é falada (tira também o espaço/parêntese antes)
            while buf and buf[-1] in " (":
                buf.pop()
            if partial and k == n:
                break
            if k < n and s[k] == ")":
                k += 1
            i = k
            continue
        buf.append(ch)
        i += 1
    flush()
    return runs


def inline_plain(s: str, partial: bool = False) -> str:
    return "".join(r["text"] for r in parse_inline(s, partial))


# ---------------------------------------------------------------------------
# Blocos
# ---------------------------------------------------------------------------

def _split_cells(s: str) -> list[str]:
    s = s.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|"):
        s = s[:-1]
    return [c.strip() for c in s.split("|")]


def parse_line(line: str) -> dict:
    """Classifica uma linha completa."""
    s = line.rstrip()
    t = s.lstrip()
    indent = len(s) - len(t)
    if not t:
        return {"type": "blank"}
    m = MEDIA_LINE_RE.match(t)
    if m:
        return {"type": "media", "id": m.group(1)}
    m = _HEADING_RE.match(t)
    if m:
        return {"type": "h", "level": len(m.group(1)), "text": m.group(2).rstrip("# ").rstrip() or m.group(2)}
    m = _BULLET_RE.match(t)
    if m:
        return {"type": "li", "ordered": False, "indent": indent, "text": m.group(1)}
    m = _ORDERED_RE.match(t)
    if m:
        return {"type": "li", "ordered": True, "n": int(m.group(1)), "indent": indent, "text": m.group(2)}
    if t.startswith("|"):
        if _TABLE_SEP_RE.match(t) and "-" in t:
            return {"type": "tsep"}
        return {"type": "tr", "cells": _split_cells(t)}
    return {"type": "p", "text": t}


def block_plain(b: dict, partial: bool = False) -> str:
    kind = b["type"]
    if kind in ("p", "h"):
        return inline_plain(b["text"], partial)
    if kind == "li":
        body = inline_plain(b["text"], partial)
        return f"{b['n']}. {body}" if b["ordered"] else body
    if kind == "tr":
        return ", ".join(p for p in (inline_plain(c) for c in b["cells"]) if p)
    return ""


def _settled(line: str) -> bool:
    """A última linha (ainda chegando) já mostra o que ela é (parágrafo, título, item...)?"""
    t = line.strip()
    if not t or t.startswith("|") or t.startswith("[["):
        return False
    return not _UNSETTLED_RE.match(t)


def to_plain(md: str, partial: bool = False) -> str:
    """Texto falado. ``partial``: a resposta ainda está chegando (só devolve o que não muda mais)."""
    lines = md.split("\n")
    last = lines.pop() if partial else None
    parts: list[str] = []
    in_table = False
    for ln in lines:
        b = parse_line(ln)
        if b["type"] in ("tr", "tsep"):
            # tabela não é lida: no lugar dela a voz avisa que ela está no chat
            if b["type"] == "tr" and not in_table:
                parts.append(TABLE_SPOKEN)
                in_table = True
            continue
        in_table = False
        p = block_plain(b)
        if p:
            parts.append(p)
    if last is not None and _settled(last):
        p = block_plain(parse_line(last), partial=True)
        if p:
            parts.append(p)
    return "\n".join(parts)
