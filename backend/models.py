from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel

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
    text: str
    ai_response: Optional[str] = None


class LogsPage(BaseModel):
    items: list[LogOut]
    total: int


class SettingsPatch(BaseModel):
    """Patch parcial — qualquer campo pode ser omitido."""
    transcription_key: Optional[str] = None
    ai_key: Optional[str] = None
    model: Optional[str] = None
    device: Optional[str] = None
    tts_backend: Optional[str] = None
    edge_voice: Optional[str] = None
    elevenlabs_api_key: Optional[str] = None
    elevenlabs_voice_id: Optional[str] = None
    elevenlabs_voice_name: Optional[str] = None
    elevenlabs_model: Optional[str] = None
    claude_continue: Optional[bool] = None
    sound_recording: Optional[bool] = None
    sound_processing: Optional[bool] = None
    sound_copied: Optional[bool] = None
    system_prompt: Optional[str] = None
    effort: Optional[str] = None


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
