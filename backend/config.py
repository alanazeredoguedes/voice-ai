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
    # Gravação pelo atalho: modo em lote (áudios > 30 s, ligado), pular silêncios e transcrever
    # enquanto fala (desligados)
    "whisper_batched": True,
    "whisper_vad": False,
    "whisper_stream": False,
    "tts_backend": "edge",
    "edge_voice": "pt-BR-AntonioNeural",
    # velocidade da fala (1.0 = normal, até 2.0)
    "tts_speed": 1.0,
    "tts_volume": 1.0,
    # áudios das respostas do Chat IA guardados no disco: limite por chat (as mais antigas saem primeiro)
    "speech_cache_limit_mb": 20,
    "elevenlabs_api_key": "",
    "elevenlabs_voice_id": "",
    "elevenlabs_voice_name": "",
    "elevenlabs_model": "eleven_multilingual_v2",
    "sound_recording": True,
    "sound_processing": True,
    "sound_copied": True,
    "system_prompt": "",
    "effort": "low",
    # Imagens/vídeos no Chat IA
    "media_enabled": True,
    "media_max_images": 4,
    # A IA pode mandar imagens/vídeos por conta própria quando ajudar a explicar
    "media_proactive": True,
    "serper_api_key": "",
    # A IA pode pesquisar na internet (notícias, coisas recentes) - WebSearch/WebFetch do Claude Code
    "web_search": True,
}
