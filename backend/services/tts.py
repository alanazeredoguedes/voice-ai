import asyncio
import base64
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import urllib.request


# fim de frase, ou fim de linha (título, item de lista, linha de tabela)
_SENTENCE_END = re.compile(r"(?<=[.!?…])\s+|\s*\n\s*")


def split_for_speech(text: str, max_words: int = 40) -> list[str]:
    """Divide um texto longo em frases para falar aos poucos (como na resposta ao vivo):
    o primeiro áudio fica pronto rápido e volume/velocidade novos valem a partir da próxima frase."""
    parts: list[str] = []
    for sent in _SENTENCE_END.split(text.strip()):
        words = sent.split()
        while len(words) > max_words:  # frase enorme: corta em vírgula perto do limite, ou no limite
            cut = max((i for i, w in enumerate(words[:max_words]) if w.endswith(",")), default=max_words - 1)
            parts.append(" ".join(words[: cut + 1]))
            words = words[cut + 1:]
        if words:
            parts.append(" ".join(words))
    # junta pedaços muito curtos ("Sim.", "Ok.") com o seguinte
    out: list[str] = []
    for p in parts:
        if out and len(out[-1].split()) < 4:
            out[-1] = f"{out[-1]} {p}"
        else:
            out.append(p)
    return out


def _elevenlabs_words(alignment: dict) -> list[dict]:
    """Junta o tempo de cada letra (ElevenLabs) em palavras."""
    chars = alignment.get("characters") or []
    starts = alignment.get("character_start_times_seconds") or []
    ends = alignment.get("character_end_times_seconds") or []
    words: list[dict] = []
    cur, t0, t1 = "", 0.0, 0.0
    for c, s, e in zip(chars, starts, ends):
        if c.isspace():
            if cur:
                words.append({"t": t0, "d": max(0.0, t1 - t0), "w": cur})
            cur = ""
            continue
        if not cur:
            t0 = s
        cur += c
        t1 = e
    if cur:
        words.append({"t": t0, "d": max(0.0, t1 - t0), "w": cur})
    return words


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
        self._aplay: subprocess.Popen | None = None
        self._win_play: object | None = None  # token da reprodução atual no Windows
        # Tempo de cada palavra no áudio gerado (por arquivo): usado para destacar no chat o trecho
        # que está sendo falado. [{"t": início (s), "d": duração (s), "w": palavra}]
        self._words: dict[str, list[dict]] = {}
        self._words_lock = threading.Lock()
        # voz que gerou cada arquivo (o ElevenLabs pode cair para o Edge numa frase): o áudio salvo
        # só serve para a mesma voz
        self._voice_of: dict[str, str] = {}
        try:
            self._volume: float = max(0.0, min(2.0, float(settings.get("tts_volume", 1.0))))
        except (TypeError, ValueError):
            self._volume = 1.0
        # Velocidade da fala (0.5 a 3.0), aplicada na hora de tocar: vale para Edge e ElevenLabs
        # e muda já na próxima frase
        self._speed: float = self._clamp_speed(settings.get("tts_speed", 1.0))
        # Voz do Edge sempre definida: também é o fallback quando o ElevenLabs falha
        self.voice = settings.get("edge_voice", "pt-BR-AntonioNeural")

        if self.backend == "edge":
            self.voice = settings.get("edge_voice", "pt-BR-AntonioNeural")
            print(f"[tts] Backend: edge-tts ({self.voice})", flush=True)
        elif self.backend == "elevenlabs":
            self.el_key = settings.get("elevenlabs_api_key", "").strip()
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
        self.__init__(settings)  # volume e velocidade vêm das settings (tts_volume / tts_speed)

    @staticmethod
    def _clamp_speed(v) -> float:
        try:
            return max(0.5, min(3.0, float(v)))
        except (TypeError, ValueError):
            return 1.0

    def set_speed(self, speed: float) -> None:
        self._speed = self._clamp_speed(speed)

    @property
    def speed(self) -> float:
        return self._speed

    def speak(self, text: str) -> None:
        if self.backend == "edge":
            self._speak_edge(text)
        elif self.backend == "elevenlabs":
            self._speak_elevenlabs(text)

    def voice_key(self) -> str:
        """Identifica a voz atual (o áudio salvo de uma voz não serve para outra)."""
        if self.backend == "elevenlabs":
            return f"elevenlabs:{self.el_voice}:{self.el_model}"
        return f"edge:{self.voice}"

    def prepare(self, text: str) -> str | None:
        try:
            if self.backend == "edge":
                path = asyncio.run(self._prepare_edge(text))
                self._voice_of[path] = f"edge:{self.voice}"
                return path
            elif self.backend == "elevenlabs":
                path = self._prepare_elevenlabs(text)
                if path:
                    self._voice_of[path] = self.voice_key()
                    return path
                # chave inválida / créditos do mês esgotados: usa a voz do Edge (grátis)
                print("[tts] ElevenLabs indisponível - usando Edge nesta frase", flush=True)
                path = asyncio.run(self._prepare_edge(text))
                self._voice_of[path] = f"edge:{self.voice}"
                return path
        except Exception as e:
            print(f"[tts] prepare falhou: {e}", flush=True)
        return None

    def peek_meta(self, path: str) -> tuple[list[dict] | None, str]:
        """Como take_meta, mas sem tirar da memória (o áudio ainda vai tocar depois)."""
        with self._words_lock:
            return self._words.get(path), self._voice_of.get(path, self.voice_key())

    def take_meta(self, path: str) -> tuple[list[dict] | None, str]:
        """Tempo de cada palavra e voz do áudio preparado (tira da memória; chame uma vez por arquivo)."""
        with self._words_lock:
            words = self._words.pop(path, None)
            voice = self._voice_of.pop(path, self.voice_key())
        return words, voice

    def play_file(self, path: str, words: list[dict] | None = None, on_start=None,
                  seek_s: float = 0.0, stop_s: float | None = None) -> None:
        """Toca um arquivo de áudio (não apaga). seek_s/stop_s tocam só um pedaço (começar numa palavra
        do meio, parar no fim de um trecho). on_start(words, speed, lead) no instante em que o som começa."""
        self._play_mp3(path, (lambda speed, lead: on_start(words, speed, lead)) if on_start else None,
                       seek_s=seek_s, stop_s=stop_s)

    def _set_words(self, path: str, words: list[dict]) -> None:
        if words:
            with self._words_lock:
                self._words[path] = words
                # áudios descartados sem tocar (cancelados) não deixam lixo acumulando
                while len(self._words) > 30:
                    old = next(iter(self._words))
                    self._words.pop(old)
                    self._voice_of.pop(old, None)

    def set_volume(self, volume: float) -> None:
        self._volume = max(0.0, min(2.0, volume))

    def stop(self) -> None:
        with self._lock:
            for proc in (self._aplay, self._ffmpeg):
                if proc and proc.poll() is None:
                    try:
                        proc.kill()
                    except OSError:
                        pass
            self._ffmpeg = None
            self._aplay = None
            self._win_play = None

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
        # stream() devolve o áudio e, junto, o momento exato de cada palavra (WordBoundary)
        words: list[dict] = []
        with open(path, "wb") as out:
            async for chunk in edge_tts.Communicate(text, self.voice, boundary="WordBoundary").stream():
                if chunk["type"] == "audio":
                    out.write(chunk["data"])
                elif chunk["type"] == "WordBoundary":
                    words.append({"t": chunk["offset"] / 1e7, "d": chunk["duration"] / 1e7, "w": chunk["text"]})
        self._set_words(path, words)
        return path

    def _speak_elevenlabs(self, text: str) -> None:
        mp3 = tempfile.NamedTemporaryFile(suffix=".mp3", delete=False)
        mp3.close()
        try:
            path = self._prepare_elevenlabs(text, mp3.name)
            if path:
                self._play_mp3(path)
            else:
                self._speak_edge(text)  # chave inválida / sem créditos: cai para o Edge
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
        body = json.dumps({"text": text, "model_id": self.el_model}).encode()
        headers = {"xi-api-key": self.el_key, "content-type": "application/json"}
        base = f"https://api.elevenlabs.io/v1/text-to-speech/{self.el_voice}"
        # 1º: versão "with-timestamps" (mesmo custo): áudio + tempo de cada letra
        try:
            req = urllib.request.Request(base + "/with-timestamps", data=body, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read())
            with open(path, "wb") as f:
                f.write(base64.b64decode(data["audio_base64"]))
            self._set_words(path, _elevenlabs_words(data.get("alignment") or {}))
            return path
        except Exception as e:
            print(f"[tts] ElevenLabs com tempos falhou ({e}); tentando sem", flush=True)
        try:
            req = urllib.request.Request(base, data=body, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=30) as resp:
                with open(path, "wb") as f:
                    f.write(resp.read())
            return path
        except Exception as e:
            print(f"[tts] ElevenLabs prepare falhou: {e}", flush=True)
            return None

    def _play_mp3(self, path: str, on_start=None, seek_s: float = 0.0, stop_s: float | None = None) -> None:
        if sys.platform == "win32":
            self._play_mp3_windows(path, on_start, seek_s=seek_s, stop_s=stop_s)
            return
        af = f"adelay=150|150,volume={self._volume:.3f}"
        if abs(self._speed - 1.0) >= 0.01:
            from .audio_decode import atempo_chain
            af += "," + atempo_chain(self._speed)
        cut = (["-ss", f"{seek_s:.3f}"] if seek_s > 0 else []) + (["-to", f"{stop_s:.3f}"] if stop_s else [])
        ffmpeg = subprocess.Popen(
            ["ffmpeg", *cut, "-i", path, "-af", af,
             "-f", "wav", "-loglevel", "quiet", "-"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        )
        aplay = subprocess.Popen(["aplay", "-q"], stdin=ffmpeg.stdout)
        if on_start:
            try:
                on_start(self._speed, 0.15)
            except Exception as e:
                print(f"[tts] on_start error: {e}", flush=True)
        ffmpeg.stdout.close()
        with self._lock:
            self._ffmpeg = ffmpeg
            self._aplay = aplay
        aplay.wait()
        ffmpeg.wait()
        with self._lock:
            self._ffmpeg = None
            self._aplay = None

    def _play_mp3_windows(self, path: str, on_start=None, seek_s: float = 0.0, stop_s: float | None = None) -> None:
        """Windows não tem `aplay`: decodifica com PyAV (sem precisar de ffmpeg.exe instalado)
        e toca via sounddevice. stop() troca o token de reprodução e interrompe o laço."""
        import numpy as np
        import sounddevice as sd

        from .audio_decode import decode_audio, time_stretch

        sr = 24000
        speed = self._speed
        try:
            audio = decode_audio(path, sr)
            if seek_s > 0 or stop_s:
                # só um pedaço: começa numa palavra do meio e/ou para no fim do trecho pedido
                audio = audio[int(max(0.0, seek_s) * sr): int(stop_s * sr) if stop_s else None]
            audio = time_stretch(audio, sr, speed)
        except Exception as e:
            print(f"[tts] falha ao decodificar áudio: {e}", flush=True)
            return
        # 150 ms de silêncio no início (evita cortar a 1ª sílaba). O volume é aplicado bloco a bloco
        # na hora de tocar: mudar o volume vale na hora, até no meio da frase.
        audio = np.concatenate([np.zeros(int(sr * 0.15), dtype=np.float32), audio])

        token = object()
        with self._lock:
            self._win_play = token
        block = 2048
        try:
            with sd.OutputStream(samplerate=sr, channels=1, dtype="float32") as out:
                if on_start:
                    try:
                        on_start(speed, 0.15)  # o som começa agora (após 150 ms de silêncio)
                    except Exception as e:
                        print(f"[tts] on_start error: {e}", flush=True)
                for i in range(0, len(audio), block):
                    with self._lock:
                        if self._win_play is not token:  # stop() foi chamado
                            break
                    chunk = np.clip(audio[i:i + block] * self._volume, -1.0, 1.0)
                    out.write(chunk.reshape(-1, 1))
        finally:
            with self._lock:
                if self._win_play is token:
                    self._win_play = None
