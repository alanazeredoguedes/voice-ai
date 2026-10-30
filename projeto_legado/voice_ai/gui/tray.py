from PyQt6.QtWidgets import QSystemTrayIcon, QMenu
from PyQt6.QtGui import QIcon, QPixmap, QPainter, QColor
from PyQt6.QtCore import Qt, QSize

_ICON_COLORS = {
    "idle":        "#888888",
    "recording":   "#22c55e",
    "processing":  "#f97316",
    "thinking":    "#7c3aed",
    "speaking":    "#0891b2",
}
_ICONS: dict[str, QIcon] = {}


def _get_icon(state: str) -> QIcon:
    if state not in _ICONS:
        color = _ICON_COLORS.get(state, "#888888")
        size = 22
        px = QPixmap(QSize(size, size))
        px.fill(Qt.GlobalColor.transparent)
        painter = QPainter(px)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setBrush(QColor(color))
        painter.setPen(Qt.PenStyle.NoPen)
        margin = 2
        painter.drawEllipse(margin, margin, size - margin * 2, size - margin * 2)
        painter.end()
        _ICONS[state] = QIcon(px)
    return _ICONS[state]


class TrayIcon(QSystemTrayIcon):
    def __init__(self, on_open_window, on_quit, parent=None):
        super().__init__(_get_icon("idle"), parent)
        self._on_open_window = on_open_window
        self._on_quit = on_quit
        self.setToolTip("Voice AI · idle")
        self.activated.connect(self._on_activated)
        self._build_menu()

    def set_state(self, state: str) -> None:
        self.setIcon(_get_icon(state))
        labels = {
            "idle":       "idle",
            "recording":  "gravando...",
            "processing": "transcrevendo...",
            "thinking":   "pensando...",
            "speaking":   "falando...",
        }
        self.setToolTip(f"Voice AI · {labels.get(state, state)}")

    def _build_menu(self) -> None:
        menu = QMenu()
        menu.addAction("Abrir painel", self._on_open_window)
        menu.addSeparator()
        menu.addAction("Sair", self._on_quit)
        self.setContextMenu(menu)

    def _on_activated(self, reason: QSystemTrayIcon.ActivationReason) -> None:
        if reason == QSystemTrayIcon.ActivationReason.DoubleClick:
            self._on_open_window()
