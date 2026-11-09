import asyncio
import threading
from collections.abc import Awaitable, Callable


Listener = Callable[[dict], Awaitable[None]]


class StateManager:
    """Broadcast de eventos para listeners async (WebSocket) a partir de threads sync.

    Substitui o AudioBridge do PyQt6 - mesmo papel, mas sem dependência de Qt.
    Threads sync (speech_engine, hotkey callbacks) chamam set_state/emit;
    o StateManager agenda a entrega de cada evento no event loop do asyncio.
    """

    def __init__(self) -> None:
        self._state: str = "idle"
        self._audio_level: float = 0.0
        self._loop: asyncio.AbstractEventLoop | None = None
        self._listeners: list[Listener] = []
        self._lock = threading.Lock()

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def add_listener(self, listener: Listener) -> None:
        self._listeners.append(listener)

    def remove_listener(self, listener: Listener) -> None:
        try:
            self._listeners.remove(listener)
        except ValueError:
            pass

    @property
    def state(self) -> str:
        return self._state

    @property
    def audio_level(self) -> float:
        return self._audio_level

    def _dispatch(self, event: dict) -> None:
        if not self._loop or self._loop.is_closed():
            return
        for listener in list(self._listeners):
            asyncio.run_coroutine_threadsafe(listener(event), self._loop)

    def set_state(self, new: str) -> None:
        with self._lock:
            if self._state == new:
                return
            self._state = new
        self._dispatch({"type": "state_changed", "state": new})

    def set_audio_level(self, level: float) -> None:
        self._audio_level = level
        self._dispatch({"type": "audio_level", "level": level})

    def emit(self, event: dict) -> None:
        self._dispatch(event)
