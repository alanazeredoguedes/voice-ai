from PyQt6.QtCore import QObject, pyqtSignal


class AudioBridge(QObject):
    """
    Ponte thread-safe entre as threads de áudio/IA e a thread do Qt.
    Estados possíveis: idle | recording | processing | thinking | speaking
    """

    transcription_ready = pyqtSignal(str)   # modo transcrição: texto pronto
    ai_response_ready   = pyqtSignal(str)   # modo IA: resposta pronta
    audio_level         = pyqtSignal(float) # nível do microfone (0–1)
    state_changed       = pyqtSignal(str)   # mudança de estado

    def on_transcription(self, text: str)  -> None: self.transcription_ready.emit(text)
    def on_ai_response(self, text: str)    -> None: self.ai_response_ready.emit(text)
    def on_audio_level(self, level: float) -> None: self.audio_level.emit(level)
    def on_state_change(self, state: str)  -> None: self.state_changed.emit(state)
