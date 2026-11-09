"""Decodificação de áudio/vídeo com PyAV (já instalado como dependência do faster-whisper).

O PyAV traz as bibliotecas do ffmpeg embutidas no próprio wheel, então o app não precisa
de um ``ffmpeg.exe`` instalado na máquina. Usado pelo TTS (MP3 do edge-tts/ElevenLabs) e
pela transcrição de arquivos (mp3, wav, m4a, mp4, webm...).

Obs.: ``faster_whisper.decode_audio`` não funciona com o PyAV 19 (argumento ``metadata_errors``
removido), por isso a decodificação é feita aqui diretamente.
"""

import numpy as np


class NoAudioStreamError(ValueError):
    """O arquivo não tem nenhuma faixa de áudio (ex.: vídeo mudo)."""


def decode_audio(path: str, sample_rate: int) -> np.ndarray:
    """Decodifica qualquer formato suportado pelo ffmpeg para float32 mono em ``sample_rate`` Hz."""
    import av

    chunks: list[np.ndarray] = []
    with av.open(path) as container:
        if not container.streams.audio:
            raise NoAudioStreamError("o arquivo não tem faixa de áudio")
        stream = container.streams.audio[0]
        resampler = av.AudioResampler(format="flt", layout="mono", rate=sample_rate)
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray().reshape(-1))
        for out in resampler.resample(None):  # esvazia o buffer do resampler
            chunks.append(out.to_ndarray().reshape(-1))
    if not chunks:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(chunks).astype(np.float32, copy=False)


def _atempo_steps(tempo: float) -> list[float]:
    """Cada filtro atempo aceita no mínimo 0,5x: abaixo disso divide em vários iguais (ex.: 0,2 = 3 x 0,585)."""
    import math

    if tempo >= 0.5:
        return [tempo]
    n = math.ceil(math.log(tempo) / math.log(0.5))
    return [tempo ** (1 / n)] * n


def atempo_chain(tempo: float) -> str:
    return ",".join(f"atempo={t:.4f}" for t in _atempo_steps(tempo))


def time_stretch(audio: np.ndarray, sample_rate: int, tempo: float) -> np.ndarray:
    """Acelera/desacelera a fala sem mudar o tom (filtro atempo do ffmpeg, via PyAV). ~3 ms por frase."""
    if abs(tempo - 1.0) < 0.01 or audio.size == 0:
        return audio
    from fractions import Fraction

    import av

    tb = Fraction(1, sample_rate)
    graph = av.filter.Graph()
    src = graph.add_abuffer(format="flt", sample_rate=sample_rate, layout="mono", time_base=tb)
    # abaixo de 0,5x o atempo precisa de dois filtros em sequência
    steps = _atempo_steps(tempo)
    prev = src
    for t in steps:
        node = graph.add("atempo", f"{t:.4f}")
        prev.link_to(node)
        prev = node
    sink = graph.add("abuffersink")
    prev.link_to(sink)
    graph.configure()

    frame = av.AudioFrame.from_ndarray(audio.reshape(1, -1), format="flt", layout="mono")
    frame.sample_rate = sample_rate
    frame.pts = 0
    frame.time_base = tb
    graph.push(frame)
    graph.push(None)
    out: list[np.ndarray] = []
    while True:
        try:
            out.append(graph.pull().to_ndarray().reshape(-1))
        except (av.error.BlockingIOError, av.error.EOFError):
            break
    return np.concatenate(out).astype(np.float32, copy=False) if out else audio
