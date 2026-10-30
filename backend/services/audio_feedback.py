import threading

import numpy as np


def _play_async(freqs: list[float], duration: float, volume: float = 0.22) -> None:
    def _play():
        try:
            import sounddevice as sd
            sr = 44100
            n = int(sr * duration)
            t = np.linspace(0, duration, n, False)
            wave = sum(np.sin(2 * np.pi * f * t) for f in freqs) / len(freqs)
            wave = (wave * volume).astype(np.float32)
            fade = min(int(sr * 0.015), n // 4)
            wave[:fade] *= np.linspace(0, 1, fade)
            wave[-fade:] *= np.linspace(1, 0, fade)
            sd.play(wave, sr)
        except Exception:
            pass
    threading.Thread(target=_play, daemon=True).start()


def sound_start() -> None:
    _play_async([523, 659], 0.12)


def sound_stop() -> None:
    _play_async([440], 0.08)


def sound_copied() -> None:
    _play_async([659, 880], 0.18)
