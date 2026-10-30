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
