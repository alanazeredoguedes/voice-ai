from typing import Any

from fastapi import APIRouter, Request

from ..models import SettingsPatch
from ..settings_store import get_all, update

router = APIRouter(prefix="/settings", tags=["settings"])


@router.get("")
async def read_settings() -> dict[str, Any]:
    return await get_all()


@router.put("")
async def update_settings(patch: SettingsPatch, request: Request) -> dict[str, Any]:
    data = patch.model_dump(exclude_unset=True)
    merged = await update(data)
    orchestrator = request.app.state.orchestrator
    if orchestrator:
        await orchestrator.apply_settings(data)
    return merged
