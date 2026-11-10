import json
from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, field_validator

State = Literal["idle", "recording", "processing", "thinking", "speaking"]
Mode = Literal["transcription", "ai", "file"]


class LogOut(BaseModel):
    id: int
    ts: datetime
    mode: Mode
    model: str
    device: str
    compute_type: str
    audio_s: float
    proc_s: float
    rtf: Optional[float] = None
    # como a transcrição foi feita: "lote", "sem silêncios", "durante a fala" (separados por vírgula)
    method: Optional[str] = None
    text: str
    ai_response: Optional[str] = None
    # grupos de mídia (imagens/vídeos) que a IA buscou nessa resposta
    media: list[dict[str, Any]] = []

    @field_validator("media", mode="before")
    @classmethod
    def _parse_media(cls, v: Any) -> Any:
        if v is None or v == "":
            return []
        if isinstance(v, str):
            try:
                return json.loads(v)
            except ValueError:
                return []
        return v


class LogsPage(BaseModel):
    items: list[LogOut]
    total: int


class SettingsPatch(BaseModel):
    """Patch parcial - qualquer campo pode ser omitido."""
    transcription_key: Optional[str] = None
    ai_key: Optional[str] = None
    # Atalhos adicionais por função (além do principal); todos ficam ativos ao mesmo tempo
    transcription_keys_extra: Optional[list[str]] = None
    ai_keys_extra: Optional[list[str]] = None
    window_key: Optional[str] = None
    window_keys_extra: Optional[list[str]] = None
    model: Optional[str] = None
    device: Optional[str] = None
    tts_backend: Optional[str] = None
    edge_voice: Optional[str] = None
    elevenlabs_api_key: Optional[str] = None
    elevenlabs_voice_id: Optional[str] = None
    elevenlabs_voice_name: Optional[str] = None
    elevenlabs_model: Optional[str] = None
    sound_recording: Optional[bool] = None
    sound_processing: Optional[bool] = None
    sound_copied: Optional[bool] = None
    system_prompt: Optional[str] = None
    effort: Optional[str] = None
    claude_model: Optional[Literal["haiku", "sonnet", "opus"]] = None
    media_enabled: Optional[bool] = None
    media_max_images: Optional[int] = None
    media_proactive: Optional[bool] = None
    # Gravação pelo atalho (Whisper)
    whisper_batched: Optional[bool] = None
    whisper_vad: Optional[bool] = None
    whisper_stream: Optional[bool] = None
    speech_cache_limit_mb: Optional[float] = None
    web_search: Optional[bool] = None
    serper_api_key: Optional[str] = None
    image_provider: Optional[Literal["duckduckgo", "serper"]] = None


class EdgeVoice(BaseModel):
    id: str
    name: str
    gender: str


class ElevenLabsFetchIn(BaseModel):
    api_key: str


class ElevenLabsVoice(BaseModel):
    voice_id: str
    name: str
    description: Optional[str] = None


class HotkeyCaptureOut(BaseModel):
    hotkey: str
