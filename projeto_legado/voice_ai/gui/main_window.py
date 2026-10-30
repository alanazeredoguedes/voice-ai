import json
import threading
import urllib.request
from pathlib import Path

from PyQt6.QtCore import Qt, QTimer, QUrl, pyqtSignal
from PyQt6.QtGui import QDesktopServices, QFont
from PyQt6.QtWidgets import (
    QApplication, QCheckBox, QComboBox, QDialog, QDialogButtonBox,
    QGroupBox, QHBoxLayout, QLabel, QLineEdit, QMainWindow, QProgressBar,
    QPushButton, QVBoxLayout, QWidget,
)

SETTINGS_PATH = Path("~/.local/share/voice-ai/settings.json").expanduser()

EDGE_VOICES = [
    ("Antonio (masculino)",          "pt-BR-AntonioNeural"),
    ("Francisca (feminino)",         "pt-BR-FranciscaNeural"),
    ("Thalita multilingual (fem.)",  "pt-BR-ThalitaMultilingualNeural"),
]
TTS_BACKENDS = [
    ("Edge TTS (grátis, neural)",    "edge"),
    ("ElevenLabs (ultra-realista)",  "elevenlabs"),
]
DEVICE_OPTIONS = [
    ("Auto (detectar GPU)", "auto"),
    ("GPU — CUDA",          "cuda"),
    ("CPU",                 "cpu"),
]
MODELS = ["tiny", "base", "small", "medium", "large-v3"]

DEFAULT_SETTINGS = {
    "transcription_key": "mouse:button8",
    "ai_key": "<ctrl>+mouse:button8",
    "model": "medium",
    "device": "auto",
    "tts_backend": "edge",
    "edge_voice": "pt-BR-AntonioNeural",
    "elevenlabs_api_key": "",
    "elevenlabs_voice_id": "",
    "elevenlabs_voice_name": "",
    "claude_continue": True,
    "sound_recording": True,
    "sound_processing": True,
    "sound_copied": True,
}

_PYNPUT_LABELS: dict[str, str] = {
    "<ctrl>": "Ctrl", "<alt>": "Alt", "<shift>": "Shift", "<super>": "Super",
    "<caps_lock>": "Caps Lock", "<tab>": "Tab", "<space>": "Space",
    "<backspace>": "Backspace", "<esc>": "Esc", "<enter>": "Enter",
    "mouse:right":  "Mouse Direito",
    "mouse:middle": "Mouse do Meio",
    **{f"mouse:button{i}": f"Mouse Botão {i}" for i in range(1, 20)},
    **{f"<f{i}>": f"F{i}" for i in range(1, 13)},
}
_QT_TO_PYNPUT = {
    Qt.Key.Key_Control: "<ctrl>", Qt.Key.Key_Alt: "<alt>",
    Qt.Key.Key_Shift: "<shift>", Qt.Key.Key_Meta: "<super>",
    Qt.Key.Key_CapsLock: "<caps_lock>", Qt.Key.Key_Tab: "<tab>",
    Qt.Key.Key_Space: "<space>", Qt.Key.Key_Backspace: "<backspace>",
    Qt.Key.Key_Escape: "<esc>", Qt.Key.Key_Return: "<enter>",
    Qt.Key.Key_Enter: "<enter>",
    **{getattr(Qt.Key, f"Key_F{i}"): f"<f{i}>" for i in range(1, 13)},
}
_MODIFIERS = {"<ctrl>", "<alt>", "<shift>", "<super>"}


def _part_label(part: str) -> str:
    if part in _PYNPUT_LABELS:
        return _PYNPUT_LABELS[part]
    if len(part) == 1:
        return part.upper()
    return part


def _combo_label(combo: str) -> str:
    return " + ".join(_part_label(p) for p in combo.split("+"))


# ── ElevenLabs config dialog ──────────────────────────────────────────────────

class ElevenLabsConfigDialog(QDialog):
    _voices_fetched  = pyqtSignal(list)
    _credits_fetched = pyqtSignal(dict)

    def __init__(self, settings: dict, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Configurar ElevenLabs")
        self.setFixedWidth(440)
        self._settings = settings.copy()
        self._build_ui()
        self._voices_fetched.connect(self._on_voices_fetched)
        self._credits_fetched.connect(self._on_credits_fetched)
        if self._settings.get("elevenlabs_api_key", "").strip():
            self._fetch_credits()

    def _build_ui(self) -> None:
        layout = QVBoxLayout(self)
        layout.setSpacing(12)
        layout.setContentsMargins(16, 16, 16, 16)

        desc = QLabel(
            "<b>ElevenLabs</b> oferece vozes neurais ultra-realistas em português.<br>"
            "O plano gratuito inclui 10.000 caracteres por mês sem custo."
        )
        desc.setWordWrap(True)
        desc.setStyleSheet("color: #cccccc; padding: 4px 0;")
        layout.addWidget(desc)

        link_btn = QPushButton("🌐  Criar conta gratuita em elevenlabs.io")
        link_btn.setStyleSheet(
            "QPushButton { background: #1e3a5f; border: 1px solid #2563eb; "
            "color: #93c5fd; border-radius: 4px; padding: 7px; font-weight: bold; }"
            "QPushButton:hover { background: #1d4ed8; color: #ffffff; }"
        )
        link_btn.clicked.connect(
            lambda: QDesktopServices.openUrl(QUrl("https://elevenlabs.io"))
        )
        layout.addWidget(link_btn)

        # Créditos
        credits_row = QHBoxLayout()
        self._credits_lbl = QLabel("Créditos: —")
        self._credits_lbl.setStyleSheet("color: #aaaaaa; font-size: 11px;")
        credits_row.addWidget(self._credits_lbl)
        credits_row.addStretch()
        self._refresh_btn = QPushButton("↻")
        self._refresh_btn.setFixedSize(26, 26)
        self._refresh_btn.setToolTip("Atualizar créditos")
        self._refresh_btn.setStyleSheet("QPushButton { border-radius: 4px; font-size: 14px; }")
        self._refresh_btn.clicked.connect(self._fetch_credits)
        credits_row.addWidget(self._refresh_btn)
        layout.addLayout(credits_row)

        sep = QWidget()
        sep.setFixedHeight(1)
        sep.setStyleSheet("background: #444;")
        layout.addWidget(sep)

        # API Key
        key_lbl = QLabel("Cole aqui sua chave de API\n(Profile → API Keys no site):")
        key_lbl.setStyleSheet("color: #aaaaaa; font-size: 11px;")
        layout.addWidget(key_lbl)

        key_row = QHBoxLayout()
        self._key_input = QLineEdit(self._settings.get("elevenlabs_api_key", ""))
        self._key_input.setPlaceholderText("sk_...")
        self._key_input.setEchoMode(QLineEdit.EchoMode.Password)
        self._key_input.setFixedHeight(32)
        key_row.addWidget(self._key_input)
        show_btn = QPushButton("👁")
        show_btn.setFixedSize(32, 32)
        show_btn.setCheckable(True)
        show_btn.setStyleSheet("QPushButton { border-radius: 4px; }")
        show_btn.toggled.connect(
            lambda on: self._key_input.setEchoMode(
                QLineEdit.EchoMode.Normal if on else QLineEdit.EchoMode.Password
            )
        )
        key_row.addWidget(show_btn)
        layout.addLayout(key_row)

        # Voice
        voice_lbl = QLabel("Escolha a voz (clique em Buscar após inserir a chave):")
        voice_lbl.setStyleSheet("color: #aaaaaa; font-size: 11px;")
        layout.addWidget(voice_lbl)

        voice_row = QHBoxLayout()
        self._voice_combo = QComboBox()
        self._voice_combo.setFixedHeight(32)
        self._voice_combo.addItem("— clique em Buscar vozes —", "")
        saved_vid  = self._settings.get("elevenlabs_voice_id", "")
        saved_name = self._settings.get("elevenlabs_voice_name", "")
        if saved_vid:
            self._voice_combo.addItem(saved_name or saved_vid, saved_vid)
            self._voice_combo.setCurrentIndex(1)
        voice_row.addWidget(self._voice_combo)
        self._fetch_btn = QPushButton("Buscar vozes")
        self._fetch_btn.setFixedHeight(32)
        self._fetch_btn.clicked.connect(self._fetch_voices)
        voice_row.addWidget(self._fetch_btn)
        layout.addLayout(voice_row)

        # Buttons
        btns = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Save |
            QDialogButtonBox.StandardButton.Cancel
        )
        btns.button(QDialogButtonBox.StandardButton.Save).setText("Salvar")
        btns.button(QDialogButtonBox.StandardButton.Cancel).setText("Cancelar")
        btns.accepted.connect(self._on_save)
        btns.rejected.connect(self.reject)
        layout.addWidget(btns)

    def _fetch_credits(self) -> None:
        api_key = self._key_input.text().strip()
        if not api_key:
            return
        self._credits_lbl.setText("Créditos: buscando...")
        self._refresh_btn.setEnabled(False)

        def fetch():
            try:
                req = urllib.request.Request(
                    "https://api.elevenlabs.io/v1/user/subscription",
                    headers={"xi-api-key": api_key},
                )
                with urllib.request.urlopen(req, timeout=10) as resp:
                    data = json.loads(resp.read())
            except Exception as e:
                print(f"[tts] ElevenLabs credits falhou: {e}", flush=True)
                data = {}
            self._credits_fetched.emit(data)

        threading.Thread(target=fetch, daemon=True).start()

    def _on_credits_fetched(self, data: dict) -> None:
        self._refresh_btn.setEnabled(True)
        used  = data.get("character_count", 0)
        limit = data.get("character_limit", 0)
        if not limit:
            self._credits_lbl.setText("Créditos: erro ao buscar")
            return
        remaining = limit - used
        pct = int(remaining / limit * 100)
        color = "#22c55e" if pct > 30 else "#f97316" if pct > 10 else "#ef4444"
        self._credits_lbl.setText(
            f"<span style='color:{color}'>"
            f"{remaining:,} caracteres restantes de {limit:,}"
            f"</span>"
        )
        self._credits_lbl.setTextFormat(Qt.TextFormat.RichText)

    def _fetch_voices(self) -> None:
        api_key = self._key_input.text().strip()
        if not api_key:
            return
        self._fetch_btn.setText("Buscando...")
        self._fetch_btn.setEnabled(False)

        def fetch():
            try:
                req = urllib.request.Request(
                    "https://api.elevenlabs.io/v1/voices",
                    headers={"xi-api-key": api_key},
                )
                with urllib.request.urlopen(req, timeout=10) as resp:
                    data = json.loads(resp.read())
                voices = [(v["name"], v["voice_id"]) for v in data.get("voices", [])]
            except Exception as e:
                print(f"[tts] ElevenLabs fetch falhou: {e}", flush=True)
                voices = []
            self._voices_fetched.emit(voices)

        threading.Thread(target=fetch, daemon=True).start()

    def _on_voices_fetched(self, voices: list) -> None:
        self._fetch_btn.setText("Buscar vozes")
        self._fetch_btn.setEnabled(True)
        if not voices:
            return
        saved_vid = self._settings.get("elevenlabs_voice_id", "")
        self._voice_combo.blockSignals(True)
        self._voice_combo.clear()
        sel = 0
        for i, (name, vid) in enumerate(voices):
            self._voice_combo.addItem(name, vid)
            if vid == saved_vid:
                sel = i
        self._voice_combo.setCurrentIndex(sel)
        self._voice_combo.blockSignals(False)

    def _on_save(self) -> None:
        self._settings["elevenlabs_api_key"]   = self._key_input.text().strip()
        self._settings["elevenlabs_voice_id"]   = self._voice_combo.currentData() or ""
        self._settings["elevenlabs_voice_name"] = self._voice_combo.currentText()
        self.accept()

    def get_settings(self) -> dict:
        return self._settings


# ── HotkeyCaptureButton ───────────────────────────────────────────────────────

class HotkeyCaptureButton(QPushButton):
    hotkey_changed  = pyqtSignal(str)
    capture_started = pyqtSignal()
    capture_ended   = pyqtSignal()
    _mouse_signal   = pyqtSignal(str)

    def __init__(self, pynput_key: str = "mouse:button8", parent=None):
        super().__init__(parent)
        self._pynput_key = pynput_key
        self._capturing = False
        self._held_mods: list[str] = []
        self._peak_mods: list[str] = []
        self._mouse_listener = None
        self.setFixedHeight(34)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self._update_display()
        self.clicked.connect(self._start_capture)
        self._mouse_signal.connect(self._stop_capture)

    def set_key(self, key: str) -> None:
        self._pynput_key = key
        self._update_display()

    def current_key(self) -> str:
        return self._pynput_key

    def _start_capture(self) -> None:
        self._capturing = True
        self._held_mods = []
        self._peak_mods = []
        self.capture_started.emit()
        self.setText("⏺ Aguardando...")
        self.setStyleSheet(
            "QPushButton { background: #2d2d2d; border: 2px solid #888888; "
            "color: #e0e0e0; border-radius: 4px; font-family: monospace; font-weight: bold; }"
        )
        self.setFocus()
        self._start_mouse_capture()

    def _stop_capture(self, key: str) -> None:
        self._stop_mouse_capture()
        self._capturing = False
        self._held_mods = []
        self._peak_mods = []
        self._pynput_key = key
        self._update_display()
        self.capture_ended.emit()
        self.hotkey_changed.emit(key)

    def _cancel_capture(self) -> None:
        self._stop_mouse_capture()
        self._capturing = False
        self._held_mods = []
        self._peak_mods = []
        self._update_display()
        self.capture_ended.emit()

    def _start_mouse_capture(self) -> None:
        try:
            from pynput import mouse as pm
            def on_click(x, y, button, pressed):
                if not self._capturing or not pressed:
                    return
                if button == pm.Button.left:
                    return
                mods = list(self._held_mods)
                btn_str = f"mouse:{button.name}"
                combo = "+".join(mods + [btn_str]) if mods else btn_str
                self._mouse_signal.emit(combo)
                return False
            self._mouse_listener = pm.Listener(on_click=on_click)
            self._mouse_listener.daemon = True
            self._mouse_listener.start()
        except Exception:
            pass

    def _stop_mouse_capture(self) -> None:
        if self._mouse_listener:
            self._mouse_listener.stop()
            self._mouse_listener = None

    def keyPressEvent(self, event) -> None:
        if not self._capturing:
            super().keyPressEvent(event)
            return
        if event.isAutoRepeat():
            return
        qt_key = Qt.Key(event.key())
        pkey = _QT_TO_PYNPUT.get(qt_key)
        if pkey is None:
            text = event.text()
            pkey = text.lower() if text and text.isprintable() else None
        if pkey is None:
            return
        if pkey in _MODIFIERS:
            if pkey not in self._held_mods:
                self._held_mods.append(pkey)
            if pkey not in self._peak_mods:
                self._peak_mods.append(pkey)
            self.setText(" + ".join(_part_label(k) for k in self._held_mods) + " + ...")
        else:
            self._stop_capture("+".join(self._held_mods + [pkey]))

    def keyReleaseEvent(self, event) -> None:
        if not self._capturing or event.isAutoRepeat():
            super().keyReleaseEvent(event)
            return
        qt_key = Qt.Key(event.key())
        pkey = _QT_TO_PYNPUT.get(qt_key)
        if pkey and pkey in _MODIFIERS:
            self._held_mods = [m for m in self._held_mods if m != pkey]
            if not self._held_mods:
                combo = "+".join(self._peak_mods) if self._peak_mods else pkey
                self._stop_capture(combo)

    def focusOutEvent(self, event) -> None:
        if self._capturing:
            self._cancel_capture()
        super().focusOutEvent(event)

    def _update_display(self) -> None:
        self.setText(_combo_label(self._pynput_key))
        self.setStyleSheet(
            "QPushButton { background: #2d2d2d; border: 1px solid #555555; "
            "color: #e0e0e0; border-radius: 4px; font-family: monospace; font-weight: bold; }"
            "QPushButton:hover { background: #3a3a3a; border-color: #888888; }"
        )


# ── MainWindow ────────────────────────────────────────────────────────────────

class MainWindow(QMainWindow):
    settings_changed = pyqtSignal(dict)

    def __init__(self, engine, hotkey_manager):
        super().__init__()
        self._engine = engine
        self._hotkey = hotkey_manager
        self._settings = self._load_settings()
        self._transcription_active = False
        self._ai_active = False

        self.setWindowTitle("Voice AI")
        self.setFixedSize(400, 560)
        self._restore_geometry()
        self._build_ui()

    # ── Slots públicos ────────────────────────────────────────────────────────

    def on_transcription_press(self) -> None:
        self._transcription_active = True
        self._engine.start_ptt()

    def on_transcription_release(self) -> None:
        if not self._transcription_active:
            return
        self._transcription_active = False
        self._engine.stop_ptt()

    def on_ai_press(self) -> None:
        self._ai_active = True
        self._engine.start_ptt()

    def on_ai_release(self) -> None:
        if not self._ai_active:
            return
        self._ai_active = False
        self._engine.stop_ptt()

    def on_audio_level(self, level: float) -> None:
        self._level_bar.setValue(int(level * 100))

    def on_state_change(self, state: str) -> None:
        labels = {
            "idle":       ("Idle",                    "#888888"),
            "recording":  ("Gravando...",              "#22c55e"),
            "processing": ("Transcrevendo...",         "#f97316"),
            "thinking":   ("Pensando (IA)...",         "#7c3aed"),
            "speaking":   ("Falando...",               "#0891b2"),
            "too_short":  ("Fale ao menos 3 palavras", "#888888"),
        }
        text, color = labels.get(state, (state, "#888888"))
        self._status_label.setText(text)
        self._status_label.setStyleSheet(f"color: {color}; font-weight: bold;")
        if state == "too_short":
            QTimer.singleShot(2000, lambda: self.on_state_change("idle"))

    def on_transcription_ready(self, text: str) -> None:
        QApplication.clipboard().setText(text)
        self._status_label.setText("Copiado!")
        self._status_label.setStyleSheet("color: #22c55e; font-weight: bold;")
        QTimer.singleShot(2000, lambda: self.on_state_change("idle"))

    # ── UI ────────────────────────────────────────────────────────────────────

    def _build_ui(self) -> None:
        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)
        root.setContentsMargins(14, 14, 14, 14)
        root.setSpacing(8)

        # Status
        status_box = QGroupBox("Status")
        sl = QVBoxLayout(status_box)
        self._status_label = QLabel("Idle")
        font = QFont(); font.setPointSize(12); font.setBold(True)
        self._status_label.setFont(font)
        self._status_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._status_label.setStyleSheet("color: #888888;")
        sl.addWidget(self._status_label)
        self._level_bar = QProgressBar()
        self._level_bar.setRange(0, 100)
        self._level_bar.setTextVisible(False)
        self._level_bar.setFixedHeight(8)
        self._level_bar.setStyleSheet("QProgressBar::chunk { background: #22c55e; border-radius: 3px; }")
        sl.addWidget(self._level_bar)
        root.addWidget(status_box)

        # Atalhos
        hotkey_box = QGroupBox("Atalhos de voz")
        hl = QVBoxLayout(hotkey_box)
        self._transcription_btn = self._make_hotkey_row(
            hl, "Transcrição → clipboard:",
            self._settings.get("transcription_key", "mouse:button8"),
            self._on_transcription_key_captured,
        )
        self._ai_btn = self._make_hotkey_row(
            hl, "Assistente IA → voz:",
            self._settings.get("ai_key", "<ctrl>+mouse:button8"),
            self._on_ai_key_captured,
        )
        root.addWidget(hotkey_box)

        # STT
        stt_box = QGroupBox("Transcrição de voz (STT)")
        sttl = QVBoxLayout(stt_box)
        model_row = QHBoxLayout()
        model_row.addWidget(QLabel("Modelo Whisper:"))
        self._model_combo = QComboBox()
        self._model_combo.addItems(MODELS)
        self._model_combo.setCurrentText(self._settings.get("model", "medium"))
        self._model_combo.currentTextChanged.connect(lambda v: self._save("model", v))
        model_row.addWidget(self._model_combo)
        sttl.addLayout(model_row)
        device_row = QHBoxLayout()
        device_row.addWidget(QLabel("Dispositivo:"))
        self._device_combo = QComboBox()
        for label, _ in DEVICE_OPTIONS:
            self._device_combo.addItem(label)
        cur_dev = self._settings.get("device", "auto")
        idx = next((i for i, (_, v) in enumerate(DEVICE_OPTIONS) if v == cur_dev), 0)
        self._device_combo.setCurrentIndex(idx)
        self._device_combo.currentIndexChanged.connect(
            lambda i: self._save("device", DEVICE_OPTIONS[i][1])
        )
        device_row.addWidget(self._device_combo)
        sttl.addLayout(device_row)
        note = QLabel("Modelo e dispositivo requerem reiniciar o app.")
        note.setStyleSheet("color: #888; font-size: 10px;")
        sttl.addWidget(note)
        root.addWidget(stt_box)

        # TTS
        tts_box = QGroupBox("Voz do assistente (TTS)")
        ttsl = QVBoxLayout(tts_box)

        backend_row = QHBoxLayout()
        backend_row.addWidget(QLabel("Backend:"))
        self._tts_combo = QComboBox()
        for label, _ in TTS_BACKENDS:
            self._tts_combo.addItem(label)
        cur_tts = self._settings.get("tts_backend", "edge")
        tidx = next((i for i, (_, v) in enumerate(TTS_BACKENDS) if v == cur_tts), 0)
        self._tts_combo.setCurrentIndex(tidx)
        self._tts_combo.currentIndexChanged.connect(self._on_tts_backend_changed)
        backend_row.addWidget(self._tts_combo)
        ttsl.addLayout(backend_row)

        # Edge: seletor de voz
        voice_row = QHBoxLayout()
        voice_row.addWidget(QLabel("Voz:"))
        self._voice_combo = QComboBox()
        for label, _ in EDGE_VOICES:
            self._voice_combo.addItem(label)
        cur_voice = self._settings.get("edge_voice", "pt-BR-AntonioNeural")
        vidx = next((i for i, (_, v) in enumerate(EDGE_VOICES) if v == cur_voice), 0)
        self._voice_combo.setCurrentIndex(vidx)
        self._voice_combo.currentIndexChanged.connect(
            lambda i: self._save("edge_voice", EDGE_VOICES[i][1])
        )
        voice_row.addWidget(self._voice_combo)
        ttsl.addLayout(voice_row)
        self._voice_row_widget = voice_row

        # ElevenLabs: botão de configurar
        el_row = QHBoxLayout()
        self._el_status_lbl = QLabel(self._el_status_text())
        self._el_status_lbl.setStyleSheet("color: #aaaaaa; font-size: 11px;")
        el_row.addWidget(self._el_status_lbl)
        el_row.addStretch()
        self._el_config_btn = QPushButton("⚙  Configurar")
        self._el_config_btn.setFixedHeight(30)
        self._el_config_btn.clicked.connect(self._open_el_config)
        el_row.addWidget(self._el_config_btn)
        ttsl.addLayout(el_row)
        self._el_row_widget = el_row

        root.addWidget(tts_box)
        self._update_tts_visibility()

        # Sons
        sound_box = QGroupBox("Sons de feedback")
        sndl = QVBoxLayout(sound_box)
        for label, key in [
            ("Som ao iniciar gravação", "sound_recording"),
            ("Som ao parar gravação",   "sound_processing"),
            ("Som ao copiar texto",     "sound_copied"),
        ]:
            chk = QCheckBox(label)
            chk.setChecked(self._settings.get(key, True))
            chk.toggled.connect(lambda checked, k=key: self._save(k, checked))
            sndl.addWidget(chk)
        root.addWidget(sound_box)

    def _el_status_text(self) -> str:
        name = self._settings.get("elevenlabs_voice_name", "")
        key  = self._settings.get("elevenlabs_api_key", "")
        if key and name:
            return f"Voz: {name}"
        if key:
            return "Chave configurada — escolha uma voz"
        return "Não configurado"

    def _make_hotkey_row(self, layout, label: str, key: str, callback) -> HotkeyCaptureButton:
        row = QHBoxLayout()
        lbl = QLabel(label)
        lbl.setMinimumWidth(160)
        btn = HotkeyCaptureButton(pynput_key=key)
        btn.capture_started.connect(self._hotkey.pause)
        btn.capture_ended.connect(self._hotkey.resume)
        btn.hotkey_changed.connect(callback)
        row.addWidget(lbl)
        row.addWidget(btn)
        layout.addLayout(row)
        return btn

    # ── Handlers ──────────────────────────────────────────────────────────────

    def _on_transcription_key_captured(self, key: str) -> None:
        self._settings["transcription_key"] = key
        self._hotkey.update_transcription_key(key)
        self._save_settings()
        self.settings_changed.emit(dict(self._settings))

    def _on_ai_key_captured(self, key: str) -> None:
        self._settings["ai_key"] = key
        self._hotkey.update_ai_key(key)
        self._save_settings()
        self.settings_changed.emit(dict(self._settings))

    def _on_tts_backend_changed(self, idx: int) -> None:
        self._settings["tts_backend"] = TTS_BACKENDS[idx][1]
        self._save_settings()
        self._update_tts_visibility()
        self.settings_changed.emit(dict(self._settings))

    def _update_tts_visibility(self) -> None:
        backend = self._settings.get("tts_backend", "edge")
        for i in range(self._voice_row_widget.count()):
            w = self._voice_row_widget.itemAt(i).widget()
            if w:
                w.setVisible(backend == "edge")
        for i in range(self._el_row_widget.count()):
            w = self._el_row_widget.itemAt(i).widget()
            if w:
                w.setVisible(backend == "elevenlabs")

    def _open_el_config(self) -> None:
        dlg = ElevenLabsConfigDialog(self._settings, parent=self)
        if dlg.exec() == QDialog.DialogCode.Accepted:
            new = dlg.get_settings()
            self._settings.update(new)
            self._el_status_lbl.setText(self._el_status_text())
            self._save_settings()
            self.settings_changed.emit(dict(self._settings))

    def _save(self, key: str, value) -> None:
        self._settings[key] = value
        self._save_settings()
        self.settings_changed.emit(dict(self._settings))

    # ── Persistência ──────────────────────────────────────────────────────────

    def _load_settings(self) -> dict:
        if SETTINGS_PATH.exists():
            try:
                return json.loads(SETTINGS_PATH.read_text())
            except Exception:
                pass
        return dict(DEFAULT_SETTINGS)

    def _save_settings(self) -> None:
        SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
        SETTINGS_PATH.write_text(json.dumps(self._settings, indent=2, ensure_ascii=False))

    def _restore_geometry(self) -> None:
        geo = self._settings.get("window_geometry")
        if geo and len(geo) == 4:
            self.setGeometry(*geo)

    # ── Janela ────────────────────────────────────────────────────────────────

    def show_panel(self) -> None:
        self.showNormal()
        self.raise_()
        self.activateWindow()

    def changeEvent(self, event) -> None:
        from PyQt6.QtCore import QEvent
        if event.type() == QEvent.Type.WindowStateChange and self.isMinimized():
            self.hide()
            event.ignore()
            return
        super().changeEvent(event)

    def closeEvent(self, event) -> None:
        geo = self.geometry()
        self._settings["window_geometry"] = [geo.x(), geo.y(), geo.width(), geo.height()]
        self._save_settings()
        self.hide()
        event.ignore()
