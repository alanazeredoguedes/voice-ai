import asyncio
import os
import subprocess
import tempfile
import threading
import urllib.request
import json


class TextToSpeech:
    """
    Backends: edge (grátis, neural) | elevenlabs (pago)
    Vozes pt-BR no edge: AntonioNeural | FranciscaNeural | ThalitaMultilingualNeural
    """

    def __init__(self, settings: dict):
        self.backend = settings.get("tts_backend", "edge")
        self._settings = settings
        self._lock = threading.Lock()
        self._ffmpeg: subprocess.Popen | None = None
        self._aplay:  subprocess.Popen | None = None

        if self.backend == "edge":
            self.voice = settings.get("edge_voice", "pt-BR-AntonioNeural")
            print(f"[tts] Backend: edge-tts ({self.voice})", flush=True)

        elif self.backend == "elevenlabs":
            self.el_key   = settings.get("elevenlabs_api_key", "").strip()
            self.el_voice = settings.get("elevenlabs_voice_id", "")
            self.el_model = settings.get("elevenlabs_model", "eleven_multilingual_v2")
            if not self.el_key:
                print("[tts] ElevenLabs sem chave, caindo para edge.", flush=True)
                self.backend = "edge"
                self.voice = settings.get("edge_voice", "pt-BR-AntonioNeural")
            else:
                print(f"[tts] Backend: ElevenLabs ({self.el_voice})", flush=True)
        else:
            self.backend = "edge"
            self.voice = settings.get("edge_voice", "pt-BR-AntonioNeural")

    def reload(self, settings: dict) -> None:
        self.stop()
        self.__init__(settings)

    def speak(self, text: str) -> None:
        if self.backend == "edge":
            self._speak_edge(text)
        elif self.backend == "elevenlabs":
            self._speak_elevenlabs(text)

    def prepare(self, text: str) -> str | None:
        """Pré-gera o áudio em arquivo temporário, retorna o caminho ou None."""
        try:
            if self.backend == "edge":
                return asyncio.run(self._prepare_edge(text))
            elif self.backend == "elevenlabs":
                return self._prepare_elevenlabs(text)
        except Exception as e:
            print(f"[tts] prepare falhou: {e}", flush=True)
        return None

    def play_prepared(self, path: str) -> None:
        """Toca um MP3 pré-gerado e apaga o arquivo."""
        try:
            self._play_mp3(path)
        finally:
            if os.path.exists(path):
                os.unlink(path)

    def stop(self) -> None:
        with self._lock:
            for proc in (self._aplay, self._ffmpeg):
                if proc and proc.poll() is None:
                    try:
                        proc.kill()
                    except OSError:
                        pass
            self._ffmpeg = None
            self._aplay  = None

    # ── edge-tts ──────────────────────────────────────────────────────────────

    def _speak_edge(self, text: str) -> None:
        try:
            asyncio.run(self._speak_edge_async(text))
        except Exception as e:
            print(f"[tts] edge-tts falhou: {e}", flush=True)

    async def _speak_edge_async(self, text: str) -> None:
        mp3 = tempfile.NamedTemporaryFile(suffix=".mp3", delete=False)
        mp3.close()
        try:
            await self._prepare_edge(text, mp3.name)
            self._play_mp3(mp3.name)
        finally:
            if os.path.exists(mp3.name):
                os.unlink(mp3.name)

    async def _prepare_edge(self, text: str, path: str | None = None) -> str:
        import edge_tts
        if path is None:
            f = tempfile.NamedTemporaryFile(suffix=".mp3", delete=False)
            f.close()
            path = f.name
        await edge_tts.Communicate(text, self.voice).save(path)
        return path

    # ── ElevenLabs ────────────────────────────────────────────────────────────

    def _speak_elevenlabs(self, text: str) -> None:
        mp3 = tempfile.NamedTemporaryFile(suffix=".mp3", delete=False)
        mp3.close()
        try:
            path = self._prepare_elevenlabs(text, mp3.name)
            if path:
                self._play_mp3(path)
        except Exception as e:
            print(f"[tts] ElevenLabs falhou: {e}", flush=True)
            self._speak_edge(text)
        finally:
            if os.path.exists(mp3.name):
                os.unlink(mp3.name)

    def _prepare_elevenlabs(self, text: str, path: str | None = None) -> str | None:
        if path is None:
            f = tempfile.NamedTemporaryFile(suffix=".mp3", delete=False)
            f.close()
            path = f.name
        url  = f"https://api.elevenlabs.io/v1/text-to-speech/{self.el_voice}"
        body = json.dumps({"text": text, "model_id": self.el_model}).encode()
        req  = urllib.request.Request(
            url, data=body,
            headers={"xi-api-key": self.el_key, "content-type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                with open(path, "wb") as f:
                    f.write(resp.read())
            return path
        except Exception as e:
            print(f"[tts] ElevenLabs prepare falhou: {e}", flush=True)
            return None

    # ── playback comum ────────────────────────────────────────────────────────

    def _play_mp3(self, path: str) -> None:
        ffmpeg = subprocess.Popen(
            ["ffmpeg", "-i", path, "-af", "adelay=150|150",
             "-f", "wav", "-loglevel", "quiet", "-"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        )
        aplay = subprocess.Popen(["aplay", "-q"], stdin=ffmpeg.stdout)
        ffmpeg.stdout.close()
        with self._lock:
            self._ffmpeg = ffmpeg
            self._aplay  = aplay
        aplay.wait()
        ffmpeg.wait()
        with self._lock:
            self._ffmpeg = None
            self._aplay  = None
