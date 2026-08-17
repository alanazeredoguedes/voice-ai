import threading

import numpy as np
from PyQt6.QtCore import Qt, QTimer, QRectF, pyqtSignal
from PyQt6.QtGui import QColor, QPainter, QPainterPath
from PyQt6.QtWidgets import QApplication, QHBoxLayout, QLabel, QWidget


def _play_async(freqs: list[float], duration: float, volume: float = 0.22) -> None:
    def _play():
        try:
            import sounddevice as sd
            sr = 44100
            n  = int(sr * duration)
            t  = np.linspace(0, duration, n, False)
            wave = sum(np.sin(2 * np.pi * f * t) for f in freqs) / len(freqs)
            wave = (wave * volume).astype(np.float32)
            fade = min(int(sr * 0.015), n // 4)
            wave[:fade]  *= np.linspace(0, 1, fade)
            wave[-fade:] *= np.linspace(1, 0, fade)
            sd.play(wave, sr)
        except Exception:
            pass
    threading.Thread(target=_play, daemon=True).start()


def sound_start()  -> None: _play_async([523, 659], 0.12)
def sound_stop()   -> None: _play_async([440],       0.08)
def sound_copied() -> None: _play_async([659, 880],  0.18)


_STYLES = {
    "recording":   ("#16a34a", "● Gravando"),
    "processing":  ("#ea580c", "  Transcrevendo..."),
    "thinking":    ("#7c3aed", "  Pensando..."),
    "speaking":    ("#0891b2", "🔊 Falando..."),
    "copied":      ("#2563eb", "✓ Copiado!"),
}


class StatusOverlay(QWidget):
    _show_signal = pyqtSignal(str, str)

    def __init__(self):
        super().__init__()
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
            | Qt.WindowType.X11BypassWindowManagerHint
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating)
        self.setFixedHeight(54)

        layout = QHBoxLayout(self)
        layout.setContentsMargins(22, 0, 22, 0)
        self._label = QLabel()
        self._label.setStyleSheet(
            "color: white; font-size: 15px; font-weight: bold; background: transparent;"
        )
        layout.addWidget(self._label)

        self._color = QColor(30, 30, 30, 220)
        self._hide_timer = QTimer(self)
        self._hide_timer.setSingleShot(True)
        self._hide_timer.timeout.connect(self.hide)
        self._show_signal.connect(self._apply)
        self._reposition()

    def _reposition(self) -> None:
        screen = QApplication.primaryScreen().geometry()
        self.adjustSize()
        self.move(screen.width() - self.width() - 20, 30)

    def on_state_change(self, state: str) -> None:
        if state == "idle":
            self._hide_timer.start(400)
            return
        self._hide_timer.stop()
        if state in _STYLES:
            color, text = _STYLES[state]
            self._show_signal.emit(text, color)

    def on_copied(self, text: str) -> None:
        preview = text[:40] + ("…" if len(text) > 40 else "")
        color, label = _STYLES["copied"]
        self._show_signal.emit(f"{label}  {preview}", color)
        self._hide_timer.start(2000)

    def _apply(self, text: str, hex_color: str) -> None:
        self._label.setText(text)
        r, g, b = int(hex_color[1:3], 16), int(hex_color[3:5], 16), int(hex_color[5:7], 16)
        self._color = QColor(r, g, b, 220)
        self.update()
        self.adjustSize()
        self._reposition()
        self.show()

    def paintEvent(self, event) -> None:
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        path = QPainterPath()
        path.addRoundedRect(QRectF(self.rect().adjusted(2, 2, -2, -2)), 14, 14)
        p.fillPath(path, self._color)
