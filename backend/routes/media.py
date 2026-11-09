import asyncio

from fastapi import APIRouter, Request
from pydantic import BaseModel

from ..services.media_search import serper_balance, test_provider

router = APIRouter(prefix="/media", tags=["media"])


class TestBody(BaseModel):
    provider: str  # duckduckgo | serper | youtube
    serper_api_key: str | None = None  # opcional: testa uma chave antes de salvar


@router.post("/test")
async def test_media_provider(body: TestBody, request: Request) -> dict:
    """Busca de teste no provedor (sem fallback), para o botão "Testar" das Configurações."""
    settings = dict(request.app.state.orchestrator.settings)
    if body.serper_api_key is not None:
        settings["serper_api_key"] = body.serper_api_key
    return await asyncio.to_thread(test_provider, body.provider, settings)


class BalanceBody(BaseModel):
    serper_api_key: str | None = None


@router.post("/serper/balance")
async def get_serper_balance(body: BalanceBody, request: Request) -> dict:
    """Créditos restantes no Serper (a chave do corpo, ou a salva nas configurações)."""
    key = body.serper_api_key
    if key is None:
        key = request.app.state.orchestrator.settings.get("serper_api_key") or ""
    return await asyncio.to_thread(serper_balance, key)
