"""Áudios das respostas do Chat IA guardados no disco, para o "ouvir de novo" não precisar gerar tudo outra vez.

- Um arquivo por frase: speech_cache/chat_<id>/msg_<id>/<voz>_<texto>.ogg (Opus) + .json (tempo de cada palavra)
- A primeira vez sempre toca o MP3 que chega do serviço de voz; a conversão para Opus (metade do tamanho)
  roda depois, em segundo plano, sem atrasar a fala.
- Limite por chat (padrão 20 MB): passando dele, as respostas mais antigas saem para dar lugar às novas.
- A mensagem continua no chat; sem o áudio salvo, ele é gerado de novo pelo serviço de voz (usa internet).
"""
import hashlib
import json
import os
import re
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction
from pathlib import Path

from ..config import DATA_DIR

ROOT = DATA_DIR / "speech_cache"
DEFAULT_LIMIT_MB = 20
_SAFE = re.compile(r"[^a-z0-9]+")

# uma conversão por vez, em segundo plano
_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="speech-cache")
_lock = threading.Lock()

# avisado quando o áudio salvo de uma mensagem muda (a tela mostra a % da resposta que já tem áudio)
_notifier = None


def set_notifier(fn) -> None:
    global _notifier
    _notifier = fn


def _notify(chat_id: int, message_id: int) -> None:
    if _notifier:
        try:
            _notifier(chat_id, message_id)
        except Exception as e:
            print(f"[speech-cache] aviso falhou: {e}", flush=True)


def _h(s: str, n: int = 16) -> str:
    return hashlib.sha1(s.encode("utf-8")).hexdigest()[:n]


def _voice_tag(voice_key: str) -> str:
    return _SAFE.sub("-", voice_key.lower()).strip("-")[:40] + "-" + _h(voice_key, 6)


def chat_dir(chat_id: int) -> Path:
    return ROOT / f"chat_{int(chat_id)}"


def message_dir(chat_id: int, message_id: int) -> Path:
    return chat_dir(chat_id) / f"msg_{int(message_id)}"


def _base(chat_id: int, message_id: int, voice_key: str, text: str, start: int) -> Path:
    return message_dir(chat_id, message_id) / f"{_voice_tag(voice_key)}_{start}_{_h(text.strip())}"


def _index_path(chat_id: int, message_id: int) -> Path:
    return message_dir(chat_id, message_id) / "index.json"


def _read_index(chat_id: int, message_id: int) -> list[dict]:
    try:
        return json.loads(_index_path(chat_id, message_id).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []


def _audio_file(base: Path) -> Path | None:
    for ext in (".ogg", ".mp3"):  # Opus quando a conversão já terminou; MP3 enquanto isso
        f = base.with_suffix(ext)
        if f.is_file():
            return f
    return None


def store(chat_id: int, message_id: int, voice_key: str, text: str, start: int, mp3_path: str,
          words: list[dict] | None, limit_mb: float | None = None) -> None:
    """Guarda o MP3 que acabou de tocar (trecho `text`, que começa na posição `start` da mensagem)
    e agenda a conversão para Opus. Não bloqueia quem chamou."""
    if not mp3_path or not os.path.isfile(mp3_path):
        return
    base = _base(chat_id, message_id, voice_key, text, start)
    try:
        base.parent.mkdir(parents=True, exist_ok=True)
        if _audio_file(base):  # já existe: só descarta o temporário
            os.unlink(mp3_path)
            return
        target = base.with_suffix(".mp3")
        shutil.move(mp3_path, target)
        with _lock:
            idx = [e for e in _read_index(chat_id, message_id) if e.get("file") != base.name]
            idx.append({"start": start, "end": start + len(text), "text": text, "voice": voice_key,
                        "file": base.name, "words": words or [], "saved_at": time.time()})
            _index_path(chat_id, message_id).write_text(json.dumps(idx, ensure_ascii=False), encoding="utf-8")
        _notify(chat_id, message_id)
    except OSError as e:
        print(f"[speech-cache] não foi possível guardar: {e}", flush=True)
        try:
            os.unlink(mp3_path)
        except OSError:
            pass
        return
    _pool.submit(_convert, target, chat_id, message_id, limit_mb)


def plan(chat_id: int | None, message_id: int | None, voice_key: str, content: str,
         start: int = 0, end: int | None = None) -> list[dict]:
    """Como falar o trecho [start, end) da mensagem: usa os pedaços já salvos (com esta voz) e só
    divide em frases novas o que faltar. Cada item: {start, end, text, file|None, words, seek_s, stop_s}.
    Pedaço salvo que começa antes do ponto pedido é tocado a partir da palavra certa (seek_s)."""
    end = len(content) if end is None else min(end, len(content))
    entries = []
    if chat_id is not None and message_id is not None:
        for e in _read_index(chat_id, message_id):
            if e.get("voice") != voice_key:
                continue
            f = _audio_file(message_dir(chat_id, message_id) / e["file"])
            # o texto salvo ainda é o desta posição da mensagem?
            if f and content[e["start"]:e["end"]].split() == e["text"].split():
                entries.append({**e, "path": str(f)})
        if entries:
            try:
                os.utime(message_dir(chat_id, message_id), None)  # usada agora (a limpeza apaga as antigas)
            except OSError:
                pass
    out: list[dict] = []
    cur = start
    while cur < end:
        # pula espaços
        while cur < end and content[cur].isspace():
            cur += 1
        if cur >= end:
            break
        covering = [e for e in entries if e["start"] <= cur < e["end"]]
        if covering:
            e = max(covering, key=lambda x: x["end"])
            words = word_offsets(e["text"], e["start"], e.get("words") or [])
            seek = 0.0
            if cur > e["start"]:
                # começa no meio do pedaço: pula até a palavra que contém/segue a posição pedida
                w = next((w for w in words if w["end"] > cur), None)
                if w is None:
                    cur = e["end"]
                    continue
                seek = max(0.0, w["t"] - 0.05)
            stop = None
            if e["end"] > end:
                last = [w for w in words if w["start"] < end]
                stop = (last[-1]["t"] + last[-1]["d"] + 0.12) if last else None
            if (cur > e["start"] and not words) or (e["end"] > end and stop is None):
                entries.remove(e)  # sem o tempo das palavras não dá para cortar: gera de novo esse trecho
                continue
            kept = [w for w in words if w["end"] > cur and (stop is None or w["start"] < end)]
            out.append({"start": max(cur, e["start"]), "end": min(e["end"], end), "text": e["text"],
                        "file": e["path"], "words": kept, "seek_s": seek, "stop_s": stop})
            cur = min(e["end"], end)
            continue
        # sem áudio salvo: gera as frases deste vão (até o próximo pedaço salvo ou o fim)
        nxt = min([e["start"] for e in entries if e["start"] > cur] + [end])
        gap = content[cur:nxt]
        for sent in sentence_plan(gap):
            out.append({"start": cur + sent["start"], "end": cur + sent["end"], "text": sent["text"],
                        "file": None, "words": [], "seek_s": 0.0, "stop_s": None})
        cur = nxt
    return out


def _convert(mp3: Path, chat_id: int, message_id: int, limit_mb: float | None) -> None:
    """MP3 → Opus 24 kbps (metade do tamanho, mesma qualidade de voz)."""
    import av
    import numpy as np

    from .audio_decode import decode_audio

    ogg = mp3.with_suffix(".ogg")
    tmp = mp3.with_suffix(".tmp.ogg")
    try:
        sr = 24000
        audio = decode_audio(str(mp3), sr)
        pcm = (np.clip(audio, -1, 1) * 32767).astype(np.int16)
        with av.open(str(tmp), "w", format="ogg") as c:
            st = c.add_stream("libopus", rate=48000)
            st.bit_rate = 24000
            st.layout = "mono"
            rs = av.AudioResampler(format="s16", layout="mono", rate=48000)
            pts = 0
            for i in range(0, len(pcm), sr):
                fr = av.AudioFrame.from_ndarray(pcm[i:i + sr].reshape(1, -1), format="s16", layout="mono")
                fr.sample_rate = sr
                fr.pts = pts
                fr.time_base = Fraction(1, sr)
                pts += fr.samples
                for f2 in rs.resample(fr):
                    for p in st.encode(f2):
                        c.mux(p)
            for f2 in rs.resample(None):
                for p in st.encode(f2):
                    c.mux(p)
            for p in st.encode(None):
                c.mux(p)
        os.replace(tmp, ogg)
        try:
            os.unlink(mp3)
        except OSError:
            pass  # ainda aberto em outra leitura: fica até a próxima limpeza
    except Exception as e:
        print(f"[speech-cache] conversão falhou ({mp3.name}): {e}", flush=True)
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
    _notify(chat_id, message_id)  # o tamanho caiu (Opus ocupa ~metade do MP3)
    enforce_limit(chat_id, limit_mb, keep_message=message_id)


# ---------- tamanho e limpeza ----------
def _dir_bytes(d: Path) -> int:
    total = 0
    for root, _, files in os.walk(d):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def message_bytes(chat_id: int, message_id: int) -> int:
    """Espaço que o áudio salvo desta resposta ocupa no disco."""
    d = message_dir(chat_id, message_id)
    return _dir_bytes(d) if d.is_dir() else 0


def chat_bytes(chat_id: int) -> int:
    d = chat_dir(chat_id)
    return _dir_bytes(d) if d.is_dir() else 0


def usage() -> dict:
    """Uso por chat: {chat_id: {"bytes", "messages"}} e o total."""
    out: dict[int, dict] = {}
    total = 0
    if ROOT.is_dir():
        for d in ROOT.iterdir():
            m = re.fullmatch(r"chat_(\d+)", d.name)
            if not m or not d.is_dir():
                continue
            b = _dir_bytes(d)
            out[int(m.group(1))] = {"bytes": b, "messages": sum(1 for x in d.iterdir() if x.is_dir())}
            total += b
    return {"total": total, "chats": out}


def enforce_limit(chat_id: int, limit_mb: float | None, keep_message: int | None = None) -> None:
    """Passou do limite do chat: apaga as respostas usadas há mais tempo (nunca a atual)."""
    limit = int((limit_mb if limit_mb is not None else DEFAULT_LIMIT_MB) * 1024 * 1024)
    d = chat_dir(chat_id)
    if limit <= 0 or not d.is_dir():
        return
    with _lock:
        msgs = []
        for m in d.iterdir():
            if m.is_dir():
                try:
                    msgs.append((m.stat().st_mtime, m, _dir_bytes(m)))
                except OSError:
                    pass
        total = sum(b for _, _, b in msgs)
        for _, m, b in sorted(msgs):  # mais antigas primeiro
            if total <= limit:
                break
            if keep_message is not None and m.name == f"msg_{keep_message}":
                continue
            shutil.rmtree(m, ignore_errors=True)
            total -= b
            print(f"[speech-cache] limite do chat {chat_id}: apagado {m.name} ({b // 1024} KB)", flush=True)
            try:
                _notify(chat_id, int(m.name.split("_", 1)[1]))
            except ValueError:
                pass


def delete_message(chat_id: int | None, message_id: int) -> None:
    if chat_id is not None:
        shutil.rmtree(message_dir(chat_id, message_id), ignore_errors=True)
        return
    if ROOT.is_dir():  # chat desconhecido: procura em todos
        for d in ROOT.glob(f"chat_*/msg_{int(message_id)}"):
            shutil.rmtree(d, ignore_errors=True)


def delete_chat(chat_id: int) -> None:
    shutil.rmtree(chat_dir(chat_id), ignore_errors=True)


def delete_all() -> None:
    shutil.rmtree(ROOT, ignore_errors=True)


# ---------- frases do texto com a posição de cada uma (para começar no meio, "ouvir daqui") ----------
def sentence_plan(text: str) -> list[dict]:
    """Divide o texto nas frases da fala (mesmas regras do "ouvir de novo"), com a posição de cada uma."""
    from .tts import split_for_speech

    out = []
    cur = 0
    for sent in split_for_speech(text):
        ws = sent.split()
        if not ws:
            continue
        i = text.find(ws[0], cur)
        if i < 0:
            continue
        j = i
        for w in ws:
            k = text.find(w, j)
            if k < 0:
                break
            j = k + len(w)
        cur = j
        out.append({"start": i, "end": j, "text": text[i:j]})
    return out


def word_offsets(sentence_text: str, sentence_start: int, words: list[dict]) -> list[dict]:
    """Posição de cada palavra do áudio no texto (para saber em que ponto do áudio cortar)."""
    out = []
    cur = 0
    for w in words:
        word = (w.get("w") or "").strip()
        if not word:
            continue
        i = sentence_text.find(word, cur)
        if i < 0:
            continue
        out.append({**w, "start": sentence_start + i, "end": sentence_start + i + len(word)})
        cur = i + len(word)
    return out


# ---------- quanto da resposta já tem áudio salvo ----------
def covered_ranges(chat_id: int, message_id: int, voice_key: str, content: str) -> list[list[int]]:
    """Trechos [início, fim) do texto da resposta que já têm áudio salvo com esta voz (unidos)."""
    spans = []
    for e in _read_index(chat_id, message_id):
        if e.get("voice") != voice_key or not _audio_file(message_dir(chat_id, message_id) / e["file"]):
            continue
        a, b = max(0, e["start"]), min(len(content), e["end"])
        if a < b and content[a:b].split() == e["text"].split():
            spans.append([a, b])
    spans.sort()
    merged: list[list[int]] = []
    for a, b in spans:
        # junta trechos colados (só espaço entre eles) para a marcação ficar contínua
        if merged and (a <= merged[-1][1] or not content[merged[-1][1]:a].strip()):
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    return merged


def coverage(chat_id: int, message_id: int, voice_key: str, content: str) -> int:
    """% do texto da resposta (sem contar espaços) que já tem áudio salvo com esta voz."""
    if not content:
        return 0
    covered = [False] * len(content)
    for e in _read_index(chat_id, message_id):
        if e.get("voice") != voice_key or not _audio_file(message_dir(chat_id, message_id) / e["file"]):
            continue
        a, b = max(0, e["start"]), min(len(content), e["end"])
        if content[a:b].split() != e["text"].split():
            continue
        for i in range(a, b):
            covered[i] = True
    total = sum(1 for ch in content if not ch.isspace())
    done = sum(1 for i, ch in enumerate(content) if covered[i] and not ch.isspace())
    return int(round(done / total * 100)) if total else 0


class LiveSaver:
    """Guarda no disco cada frase assim que o áudio dela chega do serviço de voz (antes mesmo de tocar),
    para a % de áudio salvo subir durante a geração. A resposta ao vivo só ganha id quando o texto
    termina: até lá as frases ficam numa cópia temporária e são gravadas quando o id chega."""

    def __init__(self, chat_id: int, limit_mb: float | None, message_id: int | None = None) -> None:
        self.chat_id = chat_id
        self.limit_mb = limit_mb
        self.message_id = message_id
        self._pending: list[tuple] = []
        self._lock = threading.Lock()

    def add(self, text: str, start: int, path: str, words: list[dict] | None, voice: str) -> None:
        """Faz uma cópia do áudio (o original continua para tocar) e guarda."""
        import tempfile

        try:
            fd, staged = tempfile.mkstemp(suffix=".mp3", prefix="vai-cache-")
            os.close(fd)
            shutil.copyfile(path, staged)
        except OSError:
            return
        with self._lock:
            if self.message_id is None:
                self._pending.append((text, start, staged, words, voice))
                return
            mid = self.message_id
        store(self.chat_id, mid, voice, text, start, staged, words, self.limit_mb)

    def set_message(self, message_id: int | None) -> None:
        """O texto terminou e a resposta foi salva: grava o que estava esperando (ou descarta, sem id)."""
        with self._lock:
            self.message_id = message_id
            pending, self._pending = self._pending, []
        for text, start, staged, words, voice in pending:
            if message_id is None:
                try:
                    os.unlink(staged)
                except OSError:
                    pass
            else:
                store(self.chat_id, message_id, voice, text, start, staged, words, self.limit_mb)
