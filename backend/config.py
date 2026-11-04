import os
from pathlib import Path


def get_data_dir() -> Path:
    """Diretório de dados do app (usa env var em prod, ~/.local/share/voice-ai em dev)."""
    env = os.environ.get("VOICE_AI_DATA_DIR")
    if env:
        return Path(env)
    return Path.home() / ".local" / "share" / "voice-ai"


DATA_DIR = get_data_dir()
DB_PATH = DATA_DIR / "voice-ai.db"
PORT = int(os.environ.get("VOICE_AI_PORT", "18450"))

DEFAULT_SETTINGS: dict = {
    "transcription_key": "<ctrl>+t",
    "ai_key": "<ctrl>+i",
    "model": "tiny",
    "device": "auto",
    "tts_backend": "edge",
    "edge_voice": "pt-BR-AntonioNeural",
    "elevenlabs_api_key": "",
    "elevenlabs_voice_id": "",
    "elevenlabs_voice_name": "",
    "elevenlabs_model": "eleven_multilingual_v2",
    "claude_continue": True,
    "sound_recording": True,
    "sound_processing": True,
    "sound_copied": True,
    "system_prompt": "",
    "effort": "low",
}
