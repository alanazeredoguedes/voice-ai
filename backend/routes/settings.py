from typing import Any

from fastapi import APIRouter, HTTPException, Request

from .. import system_log
from ..models import SettingsPatch
from ..services.hotkey_manager import is_blocked_hotkey
from ..settings_store import get_all, update

router = APIRouter(prefix="/settings", tags=["settings"])


@router.get("")
async def read_settings() -> dict[str, Any]:
    return await get_all()


@router.put("")
async def update_settings(patch: SettingsPatch, request: Request) -> dict[str, Any]:
    data = patch.model_dump(exclude_unset=True)
    for name in ("transcription_key", "ai_key", "window_key", "transcription_keys_extra", "ai_keys_extra", "window_keys_extra",
                 "call_ptt_key", "call_ptt_keys_extra"):
        value = data.get(name)
        values = value if isinstance(value, list) else [value]
        if any(isinstance(v, str) and is_blocked_hotkey(v) for v in values):
            raise HTTPException(422, "O clique esquerdo do mouse não pode ser usado como atalho.")
    before = await get_all()
    merged = await update(data)
    changes = [f"{k}: {_show(k, before.get(k))} → {_show(k, v)}" for k, v in data.items() if before.get(k) != v]
    if changes:
        system_log.log("info", "configurações", "alterado " + " | ".join(changes))
    orchestrator = request.app.state.orchestrator
    if orchestrator:
        await orchestrator.apply_settings(data)
    return merged


_SECRET = ("api_key", "token", "secret", "password", "senha")


def _show(key: str, value: Any) -> str:
    """Valor para o log: segredos escondidos, textos longos cortados."""
    if value in (None, ""):
        return "(vazio)"
    if any(w in key.lower() for w in _SECRET):
        return "(definido)"
    text = str(value)
    return text if len(text) <= 80 else text[:77] + "…"
