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
    # Mostrar/esconder o Voice AI por cima de qualquer janela (até jogos em tela cheia sem bordas)
    "window_key": "<ctrl>+<alt>+<f12>",
    "window_keys_extra": [],
    "model": "tiny",
    "device": "auto",
    # Gravação pelo atalho: modo em lote (áudios > 30 s) e transcrever enquanto fala (os dois ligados por
    # padrão); pular silêncios fica desligado
    "whisper_batched": True,
    "whisper_vad": False,
    "whisper_stream": True,
    "tts_backend": "edge",
    "edge_voice": "pt-BR-AntonioNeural",
    # velocidade da fala (1.0 = normal, até 2.0)
    "tts_speed": 1.0,
    "tts_volume": 1.0,
    # áudios das respostas do Chat IA guardados no disco: limite por chat (as mais antigas saem primeiro)
    "speech_cache_limit_mb": 20,
    # anexos do Chat IA (imagem ou arquivo de texto): tamanho máximo de cada um
    "upload_limit_mb": 2,
    "elevenlabs_api_key": "",
    "elevenlabs_voice_id": "",
    "elevenlabs_voice_name": "",
    "elevenlabs_model": "eleven_multilingual_v2",
    "sound_recording": True,
    "sound_processing": True,
    "sound_copied": True,
    "system_prompt": "",
    "effort": "low",
    # Modelo do Claude no Chat IA (vale para todos os chats; só para o app, não muda o Claude Code da máquina):
    # "haiku" | "sonnet" | "opus"
    "claude_model": "haiku",
    # Imagens/vídeos no Chat IA
    "media_enabled": True,
    "media_max_images": 8,
    # A IA pode mandar imagens/vídeos por conta própria quando ajudar a explicar
    "media_proactive": True,
    "serper_api_key": "",
    # A IA pode pesquisar na internet (notícias, coisas recentes) - WebSearch/WebFetch do Claude Code
    "web_search": True,
}
