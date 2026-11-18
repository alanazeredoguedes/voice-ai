"""Tradução de arquivos com os modelos locais do Argos, mantendo o layout do original.

- DOCX, PPTX, XLSX: o texto é trocado direto no XML do arquivo (estilos, tabelas, imagens e layout ficam intactos).
- PDF: o texto original é apagado da página (imagens, linhas e fundos ficam) e a tradução é escrita na mesma
  caixa, com o mesmo tamanho, cor e estilo; se o texto traduzido não couber, a fonte diminui até caber.
- TXT, MD, SRT: traduz linha a linha / parágrafo a parágrafo, mantendo marcadores e tempos.
"""
from __future__ import annotations

import html
import re
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

SUPPORTED_EXTS = {".pdf", ".docx", ".pptx", ".xlsx", ".txt", ".md", ".srt"}

Progress = Callable[[float, str], None]  # (0..1, mensagem)

_HAS_LETTER = re.compile(r"[^\W\d_]")
# marcador no começo (numeração "1.", "2.3", "a)", bolinhas de lista): fica fora da tradução, senão o modelo some com ele
_MARKER = re.compile(r"^\s*(?:\d+(?:\.\d+)*[.)]|\d+\.\d+|[A-Za-z][.)]|[•·▪●○■◦‣►✓\-–—*])(?:\s+|$)")
_ONLY_LINK = re.compile(r"(https?://|www\.)\S+|\S+@\S+\.\S+")


class Canceled(Exception):
    pass


class Translator:
    """Traduz trechos com o Argos. Guarda o que já traduziu (cabeçalhos e rodapés se repetem em toda página)
    e não manda para o modelo o que não tem letras (números, datas, símbolos) nem links soltos."""

    def __init__(self, from_code: str, to_code: str):
        import argostranslate.translate as at

        langs = {lang.code: lang for lang in at.get_installed_languages()}
        src, dst = langs.get(from_code), langs.get(to_code)
        translation = src.get_translation(dst) if src and dst else None
        if translation is None:
            raise ValueError(f"Modelo {from_code}→{to_code} não está instalado")
        self._translation = translation
        self._cache: dict[str, str] = {}

    @staticmethod
    def wants(text: str) -> bool:
        core = text.strip()
        return bool(core) and bool(_HAS_LETTER.search(core)) and not _ONLY_LINK.fullmatch(core)

    def __call__(self, text: str) -> str:
        if not self.wants(text):
            return text
        m = _MARKER.match(text)
        if m and self.wants(text[m.end():]):
            return text[: m.end()] + self(text[m.end():])
        core = text.strip()
        if core not in self._cache:
            self._cache[core] = self._translation.translate(core).strip() or core
        lead = text[: len(text) - len(text.lstrip())]
        trail = text[len(text.rstrip()):]
        return lead + self._cache[core] + trail


def translate_file(src: Path, dst: Path, tr: Translator, progress: Progress) -> dict:
    """Traduz `src` em `dst` (mesmo formato). Devolve informações extras (ex.: número de páginas do PDF)."""
    ext = src.suffix.lower()
    if ext == ".pdf":
        return _pdf(src, dst, tr, progress)
    if ext in (".docx", ".pptx", ".xlsx"):
        _ooxml(src, dst, tr, progress, ext)
    elif ext == ".srt":
        _srt(src, dst, tr, progress)
    elif ext in (".txt", ".md"):
        _plain(src, dst, tr, progress, markdown=ext == ".md")
    else:
        raise ValueError(f"Formato não suportado: {ext}")
    return {}


def _run_all(items: list, fn: Callable, progress: Progress, label: str) -> None:
    """Chama fn(item) para cada item, avisando o progresso (o cancelamento sai por exceção do progress)."""
    total = max(len(items), 1)
    for i, item in enumerate(items):
        progress(i / total, label)
        fn(item)
    progress(1.0, label)


# ---------------------------------------------------------------------------
# Word, PowerPoint, Excel (Office Open XML)
# ---------------------------------------------------------------------------

_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
_S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"

# por formato: partes do pacote com texto e, para cada vocabulário XML, (parágrafo, texto, o que separa trechos)
_PARTS = {
    ".docx": re.compile(r"word/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml|word/charts/chart\d+\.xml"),
    ".pptx": re.compile(r"ppt/(slides/slide|notesSlides/notesSlide|diagrams/data|charts/chart)\d+\.xml"),
    ".xlsx": re.compile(r"xl/(sharedStrings|worksheets/sheet\d+|charts/chart\d+)\.xml"),
}
_VOCAB = [
    # Word: tabulação, quebra de linha, imagem e campos (nº de página...) separam trechos
    (_W + "p", _W + "t", {_W + n for n in ("tab", "br", "cr", "drawing", "pict", "object", "fldChar", "ptab", "sym")}),
    # DrawingML (PowerPoint, gráficos, caixas de texto)
    (_A + "p", _A + "t", {_A + "br", _A + "fld"}),
    # Excel: cada texto de célula (compartilhado ou na própria célula); rPh é a leitura fonética (japonês)
    (_S + "si", _S + "t", {_S + "rPh"}),
    (_S + "is", _S + "t", {_S + "rPh"}),
]


def _segments(para, para_tag: str, text_tag: str, breaks: set) -> list[list]:
    """Trechos de texto do parágrafo: grupos de elementos de texto seguidos, sem contar parágrafos aninhados
    (caixas de texto dentro do parágrafo são tratadas como parágrafos próprios)."""
    groups: list[list] = [[]]

    def walk(el) -> None:
        for ch in el:
            tag = ch.tag
            if tag == para_tag:
                continue
            if tag == text_tag:
                groups[-1].append(ch)
            elif tag in breaks:
                if groups[-1]:
                    groups.append([])
            elif isinstance(tag, str):
                walk(ch)

    walk(para)
    return [g for g in groups if g]


def _run_format(t) -> bytes:
    """Formatação do pedaço de texto (as propriedades do run: negrito, fonte, cor...)."""
    from lxml import etree

    run = t.getparent()
    if run is None:
        return b""
    for ch in run:
        if isinstance(ch.tag, str) and ch.tag.endswith("}rPr"):
            return etree.tostring(ch)
    return b""


def _ooxml(src: Path, dst: Path, tr: Translator, progress: Progress, ext: str) -> None:
    from lxml import etree

    pattern = _PARTS[ext]
    with zipfile.ZipFile(src) as zin:
        trees = {}
        for name in zin.namelist():
            if pattern.fullmatch(name):
                trees[name] = etree.fromstring(zin.read(name), etree.XMLParser(huge_tree=True, remove_blank_text=False))

        segs: list[list] = []
        for root in trees.values():
            for para_tag, text_tag, breaks in _VOCAB:
                for para in root.iter(para_tag):
                    for g in _segments(para, para_tag, text_tag, breaks):
                        if tr.wants("".join(t.text or "" for t in g)):
                            segs.append(g)

        def do(group: list) -> None:
            # rótulo no começo com outra formatação ("**Nota:** o texto..."): traduz separado para manter o destaque
            first = (group[0].text or "").strip()
            if len(group) > 1 and first.endswith(":") and len(first.split()) <= 4:
                rest = group[1:]
                if _run_format(group[0]) not in {_run_format(t) for t in rest} and tr.wants("".join(t.text or "" for t in rest)):
                    lead = group[0].text[: len(group[0].text) - len(group[0].text.lstrip())]
                    trail = group[0].text[len(group[0].text.rstrip()):] or " "
                    group[0].text = lead + tr(first) + trail
                    if group[0].tag in (_W + "t", _S + "t"):
                        group[0].set(_XML_SPACE, "preserve")
                    group = rest
            text = "".join(t.text or "" for t in group)
            # o texto traduzido fica com a formatação que cobre mais texto no trecho (ex.: "Este documento descreve
            # **o app** para..." continua normal, não todo em negrito); os outros pedaços ficam vazios
            by_fmt: dict[bytes, list] = {}
            for t in group:
                by_fmt.setdefault(_run_format(t), []).append(t)
            main = max(by_fmt.values(), key=lambda ts: sum(len(t.text or "") for t in ts))
            holder = max(main, key=lambda t: len(t.text or ""))
            for t in group:
                t.text = ""
            holder.text = tr(text)
            if holder.tag in (_W + "t", _S + "t"):
                holder.set(_XML_SPACE, "preserve")

        _run_all(segs, do, progress, "Traduzindo o texto")

        with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
            for info in zin.infolist():
                if info.filename in trees:
                    data = etree.tostring(trees[info.filename], xml_declaration=True, encoding="UTF-8", standalone=True)
                    zout.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED)
                else:
                    zout.writestr(info, zin.read(info.filename))


# ---------------------------------------------------------------------------
# Texto puro, Markdown, legendas
# ---------------------------------------------------------------------------

def _read_text(path: Path) -> str:
    raw = path.read_bytes()
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def _srt(src: Path, dst: Path, tr: Translator, progress: Progress) -> None:
    blocks = re.split(r"\r?\n\s*\r?\n", _read_text(src).strip())
    out: list[str] = []

    def do(block: str) -> None:
        lines = block.splitlines()
        # número e tempo ficam; as linhas da fala são traduzidas juntas (a frase costuma quebrar entre elas)
        head = [ln for ln in lines[:2] if ln.strip().isdigit() or "-->" in ln]
        body = " ".join(ln.strip() for ln in lines[len(head):] if ln.strip())
        out.append("\n".join(head + ([tr(body)] if body else [])))

    _run_all(blocks, do, progress, "Traduzindo as legendas")
    dst.write_text("\n\n".join(out) + "\n", encoding="utf-8")


_MD_PREFIX = re.compile(r"^(\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)*)(.*)$")


def _plain(src: Path, dst: Path, tr: Translator, progress: Progress, markdown: bool) -> None:
    """Junta as linhas de um mesmo parágrafo (frases quebradas no meio traduzem mal) e traduz cada parágrafo.
    No Markdown, títulos, listas, citações e tabelas são traduzidos linha a linha, mantendo os marcadores,
    e blocos de código ficam como estão."""
    lines = _read_text(src).splitlines()
    units: list[tuple[str, list[str]]] = []  # ("keep", linhas) | ("para", linhas) | ("line", [linha]) | ("table", [linha])
    in_code = False
    for ln in lines:
        stripped = ln.strip()
        if markdown and stripped.startswith(("```", "~~~")):
            in_code = not in_code
            units.append(("keep", [ln]))
        elif in_code or not stripped:
            units.append(("keep", [ln]))
        elif markdown and stripped.startswith("|"):
            units.append(("table", [ln]))
        elif markdown and (_MD_PREFIX.match(ln).group(1) or stripped.startswith(("<", "![", "---", "==="))):
            units.append(("line", [ln]))
        elif units and units[-1][0] == "para":
            units[-1][1].append(ln)
        else:
            units.append(("para", [ln]))

    out: list[str] = []

    def do(unit: tuple[str, list[str]]) -> None:
        kind, ls = unit
        if kind == "keep":
            out.extend(ls)
        elif kind == "table":
            cells = ls[0].split("|")
            out.append("|".join(c if re.fullmatch(r"\s*:?-+:?\s*", c) else tr(c) for c in cells))
        elif kind == "line":
            m = _MD_PREFIX.match(ls[0])
            out.append(m.group(1) + tr(m.group(2)))
        else:
            indent = ls[0][: len(ls[0]) - len(ls[0].lstrip())]
            out.append(indent + tr(" ".join(s.strip() for s in ls)))

    _run_all(units, do, progress, "Traduzindo o texto")
    dst.write_text("\n".join(out) + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# PDF
# ---------------------------------------------------------------------------

@dataclass
class _Para:
    rect: list[float]  # x0, y0, x1, y1
    lines: list[list[float]] = field(default_factory=list)  # bbox de cada linha (o que será apagado)
    texts: list[str] = field(default_factory=list)
    size: float = 10.0
    font: str = ""
    flags: int = 0
    color: int = 0
    bold: bool = False
    italic: bool = False
    label: tuple | None = None  # rótulo destacado no começo ("Nota:" em negrito/cor): (texto, fonte, negrito, cor)
    baseline: float = 0.0  # linha de base da 1ª linha (para a tradução ficar na mesma altura)
    line_gap: float = 0.0  # distância entre linhas (para manter o espaçamento)
    align: str = "left"
    out_rect: list[float] | None = None


def _style(span: dict) -> tuple:
    name = span["font"]
    low = name.lower()
    bold = bool(span["flags"] & 16) or any(k in low for k in ("bold", "black", "heavy", "semibold"))
    return round(span["size"], 1), bold, name, span["flags"], span["color"]


def _join(prev: str, nxt: str) -> str:
    if not prev:
        return nxt
    # palavra hifenizada no fim da linha: junta sem o hífen
    if prev.endswith("-") and nxt[:1].islower() and len(prev) > 1 and prev[-2].isalpha():
        return prev[:-1] + nxt
    return prev + ("" if prev.endswith(" ") else " ") + nxt


def _page_paragraphs(page) -> list[_Para]:
    import pymupdf

    paras: list[_Para] = []
    data = page.get_text("dict", flags=pymupdf.TEXT_PRESERVE_WHITESPACE | pymupdf.TEXT_MEDIABOX_CLIP)
    for block in data["blocks"]:
        if block.get("type") != 0:
            continue
        lines = [
            ln for ln in block["lines"]
            if abs(ln["dir"][0] - 1) <= 0.01 and abs(ln["dir"][1]) <= 0.01  # texto girado/vertical: fica como está
            and any(s["text"].strip() for s in ln["spans"])
        ]
        if not lines:
            continue
        block_right = max(ln["bbox"][2] for ln in lines)
        cur: _Para | None = None
        prev_line = None
        prev_text = ""
        for line in lines:
            spans = [s for s in line["spans"] if s["text"].strip()]
            text = "".join(s["text"] for s in line["spans"]).strip()
            main = max(spans, key=lambda s: len(s["text"].strip()))
            size, bold, font, flags, color = _style(main)
            bbox = list(line["bbox"])
            new = cur is None
            if cur is not None and prev_line is not None:
                height = prev_line[3] - prev_line[1]
                gap = bbox[1] - prev_line[3]
                same_row = bbox[1] < prev_line[3] - height * 0.5  # lado a lado (colunas/células no mesmo bloco)
                # a linha anterior só quebrou por falta de espaço se a 1ª palavra desta não caberia nela;
                # se cabia e esta começa com maiúscula, é outro parágrafo (ou outra célula da tabela)
                first_word = text.split()[0]
                had_room = prev_line[2] + len(first_word) * size * 0.5 < block_right - size * 0.3
                starts_new = first_word[:1].isupper() or first_word[:1].isdigit() or bool(_MARKER.match(text))
                new = (
                    same_row
                    or abs(size - cur.size) > 0.6
                    or bold != cur.bold
                    or gap > max(cur.size, size) * 0.9
                    or bool(_MARKER.match(text))
                    or prev_line[0] - bbox[0] > size * 4
                    or (had_room and starts_new and not prev_text.endswith((",", "-")))
                )
            if new:
                cur = _Para(rect=bbox[:], size=size, font=font, flags=flags, color=color, bold=bold,
                            italic=bool(flags & 2) or bool(re.search(r"italic|oblique", font, re.I)),
                            baseline=main["origin"][1])
                paras.append(cur)
                first = spans[0]
                f_text = first["text"].strip()
                if first is not main and f_text.endswith(":") and len(f_text.split()) <= 4:
                    f_size, f_bold, f_font, _f, f_color = _style(first)
                    if f_bold != bold or f_color != color:
                        cur.label = (f_text, f_font, f_bold, f_color)
            else:
                cur.rect = [min(cur.rect[0], bbox[0]), min(cur.rect[1], bbox[1]),
                            max(cur.rect[2], bbox[2]), max(cur.rect[3], bbox[3])]
            cur.lines.append(bbox)
            cur.texts.append(text)
            prev_line = bbox
            prev_text = text

    for p in paras:
        if len(p.lines) > 1:
            p.line_gap = (p.lines[-1][1] - p.lines[0][1]) / (len(p.lines) - 1)
            lefts = [ln[0] for ln in p.lines]
            rights = [ln[2] for ln in p.lines]
            centers = [(ln[0] + ln[2]) / 2 for ln in p.lines]
            tol = p.size * 0.6
            if max(lefts) - min(lefts) > tol and max(centers) - min(centers) <= tol:
                p.align = "center"
            elif max(lefts) - min(lefts) <= tol and len(p.lines) > 2 and max(rights[:-1]) - min(rights[:-1]) <= tol:
                p.align = "justify"
            elif max(rights) - min(rights) <= tol and max(lefts) - min(lefts) > tol:
                p.align = "right"
    return paras


def _layout(paras: list[_Para], page_rect) -> None:
    """Espaço para o texto traduzido crescer (traduções costumam ser maiores que o original): a caixa
    pode descer até o próximo texto abaixo e, se for uma linha só, alargar até o próximo texto à direita
    (ou até a margem do conteúdo da página)."""
    if not paras:
        return
    # margens do conteúdo: até onde o texto da página vai (numa página com pouco texto, a margem padrão)
    content_right = max(p.rect[2] for p in paras)
    content_left = min(p.rect[0] for p in paras)
    if content_right - content_left < page_rect.width * 0.5:
        content_right = max(content_right, page_rect.x1 - 36)
        content_left = min(content_left, page_rect.x0 + 36)
    bottom_limit = page_rect.y1 - 18
    for p in paras:
        x0, y0, x1, y1 = p.rect
        if len(p.lines) == 1:
            others = [o for o in paras if o is not p and o.rect[1] < y1 and o.rect[3] > y0]
            right = min([o.rect[0] for o in others if o.rect[0] >= x1 - 1] + [content_right])
            left = max([o.rect[2] for o in others if o.rect[2] <= x0 + 1] + [content_left])
            if p.align == "center":
                half = min(right - (x0 + x1) / 2, (x0 + x1) / 2 - left)
                x0, x1 = (x0 + x1) / 2 - half, (x0 + x1) / 2 + half
            elif p.align == "right":
                x0 = left
            else:
                x1 = max(x1, right - 1)
        # o que começa abaixo do meio desta caixa (as caixas de linhas seguidas se sobrepõem um pouco)
        below = [o.rect[1] for o in paras
                 if o is not p and o.rect[1] >= (y0 + y1) / 2 and o.rect[0] < x1 and o.rect[2] > x0]
        y_end = min(below + [max(bottom_limit, y1)]) - 1
        p.out_rect = [x0, y0, x1, max(y1, y_end)]


_SERIF = re.compile(r"times|serif|georgia|garamond|cambria|book|minion|palatino|roman", re.I)
_MONO = re.compile(r"courier|mono|consol|code", re.I)


_SANS = re.compile(r"sans|arial|helvetica|calibri|carlito|verdana|tahoma|segoe|roboto|inter|lato|montserrat|"
                   r"poppins|ubuntu|dejavusans|frutiger|futura|gill|myriad|source\s*sans|open\s*sans|aptos", re.I)


def _css_for(p: _Para, family: str | None) -> str:
    italic = p.italic
    if family:
        fam = f"'{family}'"
    elif p.flags & 8 or _MONO.search(p.font):
        fam = "monospace"
    elif _SANS.search(p.font):
        fam = "sans-serif"
    elif p.flags & 4 or _SERIF.search(p.font):
        fam = "serif"
    else:
        fam = "sans-serif"
    line_h = 1.2
    if p.line_gap:
        line_h = min(max(p.line_gap / p.size, 1.0), 2.0)
    css = [
        f"font-family:{fam}",
        f"font-size:{p.size:.2f}px",
        f"line-height:{line_h:.2f}",
        f"color:#{p.color:06x}",
        f"text-align:{p.align}",
    ]
    if not family:
        css.append(f"font-weight:{'bold' if p.bold else 'normal'}")
        css.append(f"font-style:{'italic' if italic else 'normal'}")
    return ";".join(css)


_STYLE_WORDS = re.compile(r"regular|book|normal|roman$|bold|black|heavy|semibold|demibold|italic|oblique|obli|ital", re.I)


def _font_key(name: str) -> tuple[str, bool, bool]:
    """Nome de fonte (do PDF ou do sistema) → (família normalizada, negrito, itálico).
    Ex.: "ABCDEF+Arial-BoldMT" → ("arial", True, False); "Liberation Serif Regular" → ("liberationserif", False, False)."""
    name = name.split("+", 1)[-1]
    fam, sep, style = re.split(r"([-,])", name, maxsplit=1) if re.search(r"[-,]", name) else (name, "", "")
    fam = re.sub(r"(PSMT|MT|PS)$", "", fam)
    style = re.sub(r"(PSMT|MT|PS)$", "", style)
    low = (fam + " " + style).lower()
    bold = bool(re.search(r"bold|black|heavy", low))
    italic = bool(re.search(r"italic|oblique|obli|ital\b", low))
    if not sep:  # "Liberation Serif Bold Italic": o estilo vem em palavras no fim
        words = fam.split()
        while len(words) > 1 and _STYLE_WORDS.fullmatch(words[-1]):
            words.pop()
        fam = " ".join(words)
    return re.sub(r"[^a-z0-9]", "", fam.lower()), bold, italic


# fontes com as mesmas medidas (o texto ocupa o mesmo espaço): se o PDF usa Arial e o computador tem a Liberation Sans...
_EQUIVALENT = [
    ["arial", "helvetica", "liberationsans", "arimo", "nimbussans", "nimbussansl", "helveticaneue"],
    ["timesnewroman", "times", "liberationserif", "tinos", "nimbusroman", "nimbusromanno9l"],
    ["couriernew", "courier", "liberationmono", "cousine", "nimbusmono", "nimbusmonops"],
    ["calibri", "carlito"],
    ["cambria", "caladea"],
]

_system_fonts: dict[str, dict[tuple[bool, bool], str]] | None = None


def _font_dirs() -> list[Path]:
    import os
    import sys

    home = Path.home()
    if sys.platform == "win32":
        windir = Path(os.environ.get("WINDIR", r"C:\Windows"))
        dirs = [windir / "Fonts", Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "Windows" / "Fonts"]
    elif sys.platform == "darwin":
        dirs = [Path("/System/Library/Fonts"), Path("/Library/Fonts"), home / "Library" / "Fonts"]
    else:
        dirs = [Path("/usr/share/fonts"), Path("/usr/local/share/fonts"), home / ".local" / "share" / "fonts", home / ".fonts"]
    return [d for d in dirs if d.is_dir()]


def _system_font_index() -> dict[str, dict[tuple[bool, bool], str]]:
    """Fontes instaladas no computador: família → {(negrito, itálico): arquivo}. Lido uma vez."""
    global _system_fonts
    if _system_fonts is None:
        import pymupdf

        index: dict[str, dict[tuple[bool, bool], str]] = {}
        for d in _font_dirs():
            for f in d.rglob("*"):
                if f.suffix.lower() not in (".ttf", ".otf"):
                    continue
                try:
                    fam, bold, italic = _font_key(pymupdf.Font(fontfile=str(f)).name)
                except Exception:
                    continue
                index.setdefault(fam, {}).setdefault((bold, italic), str(f))
        _system_fonts = index
    return _system_fonts


class _FontReuse:
    """Escolhe a fonte da tradução, nesta ordem:
    1) a própria fonte embutida no PDF, se tiver todas as letras da tradução (os PDFs costumam levar só as
       letras usadas no original: num texto em inglês, faltam ç, ã, é...);
    2) a mesma fonte instalada no computador (ou uma de mesmas medidas: Arial ↔ Liberation Sans, Calibri ↔ Carlito...);
    3) uma fonte parecida (serifada, sem serifa ou monoespaçada)."""

    def __init__(self, doc):
        import pymupdf

        self.doc = doc
        self.archive = pymupdf.Archive()
        self._faces: dict[str, str] = {}  # família no CSS → arquivo no archive
        self._loaded: dict[str, tuple[str, object] | None] = {}  # chave → (família no CSS, Font)
        self._page_fonts: dict[int, dict[str, int]] = {}

    def _register(self, key: str, data: bytes, ext: str) -> tuple[str, object] | None:
        import pymupdf

        try:
            font = pymupdf.Font(fontbuffer=data)
        except Exception:
            return None
        fam = f"F{len(self._faces)}"
        fname = f"{fam}.{ext}"
        self.archive.add(data, fname)
        self._faces[fam] = fname
        return fam, font

    def _embedded(self, page, name: str) -> tuple[str, object] | None:
        key = "pdf:" + name.split("+", 1)[-1]
        if key not in self._loaded:
            self._loaded[key] = None
            if page.number not in self._page_fonts:
                self._page_fonts[page.number] = {
                    basefont.split("+", 1)[-1]: xref
                    for xref, ext, _t, basefont, *_ in page.get_fonts(full=True)
                    if ext in ("ttf", "otf", "cff")
                }
            xref = self._page_fonts[page.number].get(name.split("+", 1)[-1])
            if xref:
                try:
                    _n, ext, _t, buf = self.doc.extract_font(xref)
                    if buf:
                        self._loaded[key] = self._register(key, buf, ext)
                except Exception:
                    pass
        return self._loaded[key]

    def _system(self, name: str, bold: bool, italic: bool) -> tuple[str, object] | None:
        fam, b2, i2 = _font_key(name)
        bold, italic = bold or b2, italic or i2
        index = _system_font_index()
        candidates = [fam] + next((g for g in _EQUIVALENT if fam in g), [])
        for c in candidates:
            styles = index.get(c)
            if not styles:
                continue
            path = styles.get((bold, italic)) or styles.get((bold, False))
            if not path:
                return None  # a família existe, mas sem esse estilo: melhor a fonte genérica com o estilo certo
            key = "sys:" + path
            if key not in self._loaded:
                try:
                    self._loaded[key] = self._register(key, Path(path).read_bytes(), Path(path).suffix[1:].lower())
                except OSError:
                    self._loaded[key] = None
            return self._loaded[key]
        return None

    def family_for(self, page, p: "_Para", text: str) -> str | None:
        def covers(info) -> bool:
            return bool(info) and all(ch.isspace() or info[1].has_glyph(ord(ch)) for ch in text)

        for info in (self._embedded(page, p.font), self._system(p.font, p.bold, p.italic)):
            if covers(info):
                return info[0]
        return None

    def css(self) -> str:
        return "".join(f"@font-face{{font-family:'{fam}';src:url({fname});}}" for fam, fname in self._faces.items())


class _Baseline:
    """Distância entre o topo da caixa e a linha de base da 1ª linha, para cada estilo (o motor de HTML posiciona
    o texto um pouco diferente do original). Medida uma vez por estilo numa página de rascunho."""

    def __init__(self, fonts: "_FontReuse"):
        import pymupdf

        self._fonts = fonts
        self._scratch = pymupdf.open()
        self._page = self._scratch.new_page(width=2000, height=400)
        self._cache: dict[str, float | None] = {}

    def offset(self, style: str) -> float | None:
        import pymupdf

        if style not in self._cache:
            self._cache[style] = None
            try:
                page = self._page
                page.clean_contents()
                page.insert_htmlbox(pymupdf.Rect(0, 0, 2000, 400), f'<div style="{style}">Hxg</div>',
                                    css="*{margin:0;padding:0}" + self._fonts.css(), archive=self._fonts.archive)
                spans = [s for b in page.get_text("dict")["blocks"] for ln in b.get("lines", []) for s in ln["spans"]]
                if spans:
                    self._cache[style] = spans[0]["origin"][1]
                # limpa o rascunho para a próxima medida
                self._scratch.delete_page(0)
                self._page = self._scratch.new_page(width=2000, height=400)
            except Exception:
                pass
        return self._cache[style]


def _pdf(src: Path, dst: Path, tr: Translator, progress: Progress) -> dict:
    import pymupdf

    doc = pymupdf.open(src)
    if doc.needs_pass and not doc.authenticate(""):
        raise ValueError("O PDF tem senha")

    # 1) lê os parágrafos de todas as páginas (para saber o total e mostrar o progresso)
    pages: list[list[_Para]] = []
    for page in doc:
        paras = [p for p in _page_paragraphs(page) if tr.wants(" ".join(p.texts))]
        _layout(paras, page.rect)
        pages.append(paras)
    total = sum(len(p) for p in pages)
    if total == 0:
        raise ValueError(
            "Não encontrei texto no PDF. Se ele for digitalizado (uma foto do documento), não dá para traduzir ainda."
        )

    fonts = _FontReuse(doc)
    baselines = _Baseline(fonts)
    done = 0
    for page, paras in zip(doc, pages):
        # 2) traduz
        results = []
        for p in paras:
            progress(done / total, f"Página {page.number + 1} de {len(doc)}")
            text = ""
            for t in p.texts:
                text = _join(text, t)
            label = None
            if p.label and text.startswith(p.label[0]):
                label = tr(p.label[0])
                text = text[len(p.label[0]):].strip()
            results.append((p, tr(text), label))
            done += 1
        if not results:
            continue

        # 3) apaga só o texto original (imagens, linhas e fundos continuam). A faixa apagada é o meio de cada
        #    linha, para não pegar letras das linhas vizinhas (as caixas das linhas se sobrepõem um pouco).
        for p, _, _ in results:
            for x0, y0, x1, y1 in p.lines:
                h = y1 - y0
                page.add_redact_annot(pymupdf.Rect(x0, y0 + h * 0.3, x1, y1 - h * 0.3), fill=False)
        page.apply_redactions(
            images=pymupdf.PDF_REDACT_IMAGE_NONE,
            graphics=pymupdf.PDF_REDACT_LINE_ART_NONE,
            text=pymupdf.PDF_REDACT_TEXT_REMOVE,
        )

        # 4) escreve a tradução na mesma caixa (a fonte diminui se precisar para caber)
        for p, translated, label in results:
            family = fonts.family_for(page, p, translated)
            label_html = ""
            if label:
                lp = _Para(rect=p.rect, size=p.size, font=p.label[1], flags=p.flags, color=p.label[3], bold=p.label[2])
                lfam = fonts.family_for(page, lp, label)
                font_family = _css_for(lp, lfam).split(";")[0]  # só a família; tamanho e altura vêm do parágrafo
                lcss = f"{font_family};color:#{p.label[3]:06x};font-weight:{'bold' if p.label[2] and not lfam else 'normal'}"
                label_html = f'<span style="{lcss}">{html.escape(label)}</span> '
            for fam in ([family, None] if family else [None]):
                style = _css_for(p, fam)
                rect = pymupdf.Rect(p.out_rect)
                off = baselines.offset(style)
                if off is not None:
                    shift = (p.baseline - off) - rect.y0  # mesma linha de base do original
                    rect.y0 += shift
                    rect.y1 = max(rect.y1, rect.y0 + 1)
                try:
                    page.insert_htmlbox(rect, f'<div style="{style}">{label_html}{html.escape(translated)}</div>',
                                        css="*{margin:0;padding:0}" + fonts.css(), archive=fonts.archive, scale_low=0)
                    break
                except Exception:
                    continue  # fonte embutida que o motor não conseguiu usar: tenta a fonte parecida

    progress(1.0, "Salvando o PDF")
    doc.subset_fonts()
    doc.save(dst, garbage=3, deflate=True)
    pages_count = len(doc)
    doc.close()
    return {"pages": pages_count}


def darken_pdf(path: Path, progress: Progress | None = None) -> None:
    """Tema escuro: fundo escuro e texto claro, mantendo as cores (um título azul continua azul, só que claro).

    Tudo continua vetor (o texto segue selecionável) e é feito com modos de mistura do PDF, por página:
    1) a página original sobre fundo branco;
    2) "Difference" com branco: inverte tudo (branco ↔ preto, mas os tons ficam trocados: azul vira laranja);
    3) a página original de novo com "Color": devolve o tom e a saturação originais, mantendo o claro/escuro
       invertido (é o "inverter inteligente" dos modos escuros);
    4) ajuste de tom: o fundo vira um grafite (não preto puro) e o texto um branco suave.
    As imagens (fotos, logos) ficam de fora da inversão e aparecem como no original."""
    import pymupdf

    src = pymupdf.open(path)
    out = pymupdf.open()
    states = {}
    for name, mode in (("VaiD", "Difference"), ("VaiC", "Color"), ("VaiM", "Multiply"), ("VaiS", "Screen")):
        xref = out.get_new_xref()
        out.update_object(xref, f"<</Type/ExtGState/BM/{mode}>>")
        states[name] = xref
    total = len(src)
    for page in src:
        if progress:
            progress(page.number / total, "Aplicando o tema escuro")
        w, h = page.rect.width, page.rect.height
        new = out.new_page(width=w, height=h)
        new.show_pdf_page(new.rect, src, page.number)
        content_xref = new.get_contents()[0]
        show = out.xref_stream(content_xref).decode("latin-1")
        kind, val = out.xref_get_key(new.xref, "Resources")
        if kind == "xref":
            out.xref_set_key(int(val.split()[0]), "ExtGState", "<<" + "".join(f"/{k} {v} 0 R" for k, v in states.items()) + ">>")
        else:
            out.xref_set_key(new.xref, "Resources/ExtGState", "<<" + "".join(f"/{k} {v} 0 R" for k, v in states.items()) + ">>")
        # recorte com "buracos" nas imagens: elas não são invertidas
        clip = f"0 0 {w:.2f} {h:.2f} re "
        for info in page.get_image_info():
            x0, y0, x1, y1 = info["bbox"]
            if x1 - x0 > 8 and y1 - y0 > 8:
                clip += f"{x0:.2f} {h - y1:.2f} {x1 - x0:.2f} {y1 - y0:.2f} re "
        full = f"0 0 {w:.2f} {h:.2f} re f"
        stream = (
            f"q 1 1 1 rg {full} Q\n{show}\n"
            f"q {clip}W* n\n"
            f"q /VaiD gs 1 1 1 rg {full} Q\n"
            f"q /VaiC gs\n{show}\nQ\n"
            f"q /VaiM gs 0.91 0.915 0.93 rg {full} Q\n"
            f"q /VaiS gs 0.075 0.085 0.105 rg {full} Q\n"
            "Q\n"
        )
        out.update_stream(content_xref, stream.encode("latin-1"))
        for link in page.get_links():  # links continuam funcionando
            link.pop("xref", None)
            try:
                new.insert_link(link)
            except Exception:
                pass
    out.set_metadata(src.metadata or {})
    tmp = path.with_suffix(".dark.tmp")
    out.save(tmp, garbage=3, deflate=True)
    out.close()
    src.close()
    tmp.replace(path)


def render_pdf_page(path: Path, page_no: int, zoom: float = 1.4, rotate: int = 0) -> tuple[bytes, int]:
    """PNG de uma página (para comparar o original com a tradução lado a lado) e o total de páginas."""
    import pymupdf

    with pymupdf.open(path) as doc:
        n = len(doc)
        page = doc[max(0, min(page_no, n - 1))]
        pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom).prerotate(rotate % 360), alpha=False)
        return pix.tobytes("png"), n
