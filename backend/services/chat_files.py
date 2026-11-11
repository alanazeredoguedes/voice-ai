"""Anexos das mensagens do chat: imagens e arquivos de texto, guardados em disco (DATA_DIR/chat_files).

A tela manda cada anexo em base64. Aqui eles são validados, guardados (para aparecer no histórico) e
preparados para o Claude: imagens viram blocos de imagem; arquivos de texto entram no corpo da mensagem.
"""

import base64
import binascii
import mimetypes
import re
import shutil
import uuid
from pathlib import Path

from ..config import DATA_DIR

ROOT = DATA_DIR / "chat_files"

MAX_FILES = 6
DEFAULT_UPLOAD_MB = 2           # tamanho máximo de cada anexo (muda em Configurações, de 1 a 20 MB)
MAX_TEXT_CHARS = 200_000        # o que vai para a IA (o resto é cortado, com aviso)
IMAGE_MIMES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
TEXT_EXT = {
    ".txt", ".md", ".markdown", ".json", ".csv", ".tsv", ".log", ".xml", ".yml", ".yaml", ".ini", ".toml", ".cfg",
    ".html", ".htm", ".css", ".js", ".mjs", ".ts", ".tsx", ".jsx", ".vue", ".py", ".java", ".c", ".h", ".cpp",
    ".cs", ".go", ".rs", ".php", ".rb", ".sql", ".sh", ".bat", ".ps1", ".env", ".gitignore", ".srt", ".vtt",
}
_ID_RE = re.compile(r"^[a-f0-9]{32}\.[a-z0-9]{1,8}$")


class AttachmentError(ValueError):
    """Erro com mensagem pronta para mostrar ao usuário."""


def _clean_name(name: str) -> str:
    name = (name or "arquivo").replace("\\", "/").split("/")[-1].strip() or "arquivo"
    return name[:120]


def _fmt_mb(mb: float) -> str:
    return f"{mb:g}".replace(".", ",") + " MB"


def prepare(raw: list[dict], limit_mb: float = DEFAULT_UPLOAD_MB) -> list[dict]:
    """Valida e decodifica os anexos recebidos. Devolve, por anexo: kind ("image" | "text"), name, mime, ext,
    data (bytes), e b64 (imagem) ou text (arquivo de texto, já cortado se for enorme).
    ``limit_mb``: tamanho máximo de cada anexo (a escolha do usuário em Configurações)."""
    try:
        limit_mb = min(20.0, max(1.0, float(limit_mb)))
    except (TypeError, ValueError):
        limit_mb = float(DEFAULT_UPLOAD_MB)
    limit_bytes = int(limit_mb * 1024 * 1024)
    hint = " Dá para aumentar o limite em Configurações."
    if len(raw) > MAX_FILES:
        raise AttachmentError(f"No máximo {MAX_FILES} anexos por mensagem.")
    out: list[dict] = []
    for a in raw:
        name = _clean_name(a.get("name", ""))
        mime = (a.get("mime") or "").lower()
        try:
            data = base64.b64decode(a.get("data") or "", validate=True)
        except (binascii.Error, ValueError):
            raise AttachmentError(f"Não consegui ler o anexo {name}.")
        ext = Path(name).suffix.lower()
        if mime in IMAGE_MIMES:
            if len(data) > limit_bytes:
                raise AttachmentError(f"A imagem {name} é grande demais (máximo {_fmt_mb(limit_mb)}).{hint}")
            ext = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}[mime]
            out.append({"kind": "image", "name": name, "mime": mime, "ext": ext, "data": data,
                        "b64": base64.b64encode(data).decode()})
        elif mime.startswith("text/") or ext in TEXT_EXT or mime in ("application/json", "application/xml"):
            if len(data) > limit_bytes:
                raise AttachmentError(f"O arquivo {name} é grande demais (máximo {_fmt_mb(limit_mb)}).{hint}")
            if b"\x00" in data[:4096]:
                raise AttachmentError(f"{name} não parece um arquivo de texto.")
            text = data.decode("utf-8", errors="replace")
            if len(text) > MAX_TEXT_CHARS:
                text = text[:MAX_TEXT_CHARS] + "\n[... arquivo cortado: era maior do que cabe na conversa]"
            out.append({"kind": "text", "name": name, "mime": mime or "text/plain", "ext": ext or ".txt",
                        "data": data, "text": text})
        else:
            raise AttachmentError(f"O tipo de {name} não é aceito (use imagens ou arquivos de texto).")
    return out


def save(chat_id: int, items: list[dict]) -> list[dict]:
    """Guarda os anexos no disco e devolve os dados que ficam na mensagem (sem o conteúdo)."""
    folder = ROOT / f"chat_{chat_id}"
    folder.mkdir(parents=True, exist_ok=True)
    metas = []
    for it in items:
        fid = uuid.uuid4().hex + it["ext"][:9]
        (folder / fid).write_bytes(it["data"])
        metas.append({"id": fid, "name": it["name"], "mime": it["mime"], "kind": it["kind"], "size": len(it["data"])})
    return metas


def path_of(chat_id: int, file_id: str) -> Path | None:
    if not _ID_RE.match(file_id or ""):
        return None
    p = ROOT / f"chat_{chat_id}" / file_id
    return p if p.is_file() else None


def media_type(path: Path) -> str:
    guess, _ = mimetypes.guess_type(path.name)
    if guess and guess.startswith("image/"):
        return guess
    return "text/plain; charset=utf-8"


def delete_files(chat_id: int, metas: list[dict] | None) -> None:
    for m in metas or []:
        p = path_of(chat_id, str(m.get("id") or ""))
        if p:
            p.unlink(missing_ok=True)


def delete_chat(chat_id: int) -> None:
    shutil.rmtree(ROOT / f"chat_{chat_id}", ignore_errors=True)
