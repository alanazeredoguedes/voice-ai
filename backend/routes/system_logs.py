"""Log do sistema (ver backend/system_log.py): ler, receber linhas da tela/Electron e limpar."""
from fastapi import APIRouter, Query
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

from .. import system_log

router = APIRouter(prefix="/logs/system", tags=["logs"])


class ClientEntry(BaseModel):
    level: str = "info"
    cat: str = Field("geral", max_length=40)
    msg: str = Field(..., max_length=4000)
    src: str = Field("tela", max_length=20)
    t: float | None = None


@router.get("")
async def list_entries(since: int = Query(0, ge=0), limit: int = Query(5000, ge=1, le=5000)) -> dict:
    return {"items": system_log.entries(since, limit), "file": str(system_log.LOG_FILE)}


@router.get("/file", response_class=PlainTextResponse)
async def read_file() -> str:
    """O arquivo inteiro (a cópia anterior e o atual): mais completo que a lista, que só tem esta sessão."""
    parts = []
    for p in (system_log.LOG_FILE.with_suffix(".log.1"), system_log.LOG_FILE):
        try:
            parts.append(p.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            pass
    return "".join(parts)


@router.post("", status_code=204)
async def add_entries(entries: list[ClientEntry]) -> None:
    for e in entries[:500]:
        system_log.log(e.level, e.cat, e.msg, source=e.src, t=e.t)


@router.delete("", status_code=204)
async def clear_entries() -> None:
    system_log.clear()
    system_log.log("info", "logs", "log do sistema limpo pela tela")
