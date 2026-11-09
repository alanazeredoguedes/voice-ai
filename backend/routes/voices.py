import httpx
from fastapi import APIRouter, HTTPException

from ..models import ElevenLabsFetchIn, ElevenLabsVoice, EdgeVoice

router = APIRouter(prefix="/voices", tags=["voices"])


EDGE_VOICES_PT_BR = [
    EdgeVoice(id="pt-BR-AntonioNeural", name="Antonio", gender="Masculino"),
    EdgeVoice(id="pt-BR-FranciscaNeural", name="Francisca", gender="Feminino"),
    EdgeVoice(id="pt-BR-ThalitaMultilingualNeural", name="Thalita Multilingual", gender="Feminino"),
]


@router.get("/edge", response_model=list[EdgeVoice])
async def edge_voices() -> list[EdgeVoice]:
    return EDGE_VOICES_PT_BR


@router.post("/elevenlabs/usage")
async def elevenlabs_usage(body: ElevenLabsFetchIn) -> dict:
    """Créditos usados/limite do mês e plano da conta ElevenLabs (GET /v1/user/subscription)."""
    api_key = body.api_key.strip()
    if not api_key:
        return {"ok": False, "error": "sem chave"}
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                "https://api.elevenlabs.io/v1/user/subscription",
                headers={"xi-api-key": api_key},
            )
        if resp.status_code == 401:
            detail = resp.text.lower()
            if "permission" in detail or "missing" in detail:
                return {"ok": False, "error": "A chave não tem permissão para ler a conta (ative \"User → Read\" na chave)"}
            return {"ok": False, "error": "Chave inválida"}
        if resp.status_code != 200:
            return {"ok": False, "error": f"ElevenLabs retornou {resp.status_code}"}
        d = resp.json()
        used, limit = d.get("character_count"), d.get("character_limit")
        return {
            "ok": True,
            "used": used,
            "limit": limit,
            "remaining": (limit - used) if isinstance(used, int) and isinstance(limit, int) else None,
            "tier": d.get("tier"),
            "reset_unix": d.get("next_character_count_reset_unix"),
        }
    except httpx.HTTPError as e:
        return {"ok": False, "error": f"Erro de rede: {e}"}


@router.post("/elevenlabs/fetch", response_model=list[ElevenLabsVoice])
async def fetch_elevenlabs(body: ElevenLabsFetchIn) -> list[ElevenLabsVoice]:
    api_key = body.api_key.strip()
    if not api_key:
        raise HTTPException(400, "api_key vazio")
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                "https://api.elevenlabs.io/v1/voices",
                headers={"xi-api-key": api_key},
            )
            if resp.status_code != 200:
                raise HTTPException(resp.status_code, f"ElevenLabs retornou {resp.status_code}")
            data = resp.json()
            return [
                ElevenLabsVoice(
                    voice_id=v["voice_id"],
                    name=v["name"],
                    description=v.get("description"),
                )
                for v in data.get("voices", [])
            ]
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Erro HTTP: {e}")
