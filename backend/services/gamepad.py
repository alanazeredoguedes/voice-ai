"""Leitura de controles (DualSense, DualShock, Xbox...) via SDL2 para usar como atalho.

Formato do atalho: "gamepad:<botao>+<botao>..." ex.: "gamepad:lb+rb" (L1 + R1).
Nomes de botões seguem o layout padrão da SDL (posição física, independente da marca):
  a b x y        -> PS: ✕ ○ □ △
  lb rb lt rt    -> PS: L1 R1 L2 R2
  ls rs          -> PS: L3 R3
  back start guide touchpad misc
  up down left right   (direcional)

Opcional: se `pysdl2` não estiver instalado (ex.: Linux), `available()` retorna False e nada roda.
"""

import ctypes
import threading
from collections.abc import Callable

PREFIX = "gamepad:"

# Ordem canônica (usada para montar o atalho capturado de forma estável)
BUTTON_ORDER = [
    "lb", "rb", "lt", "rt", "ls", "rs",
    "a", "b", "x", "y",
    "up", "down", "left", "right",
    "back", "start", "guide", "touchpad", "misc",
    "p1", "p2", "p3", "p4",
]

_TRIGGER_ON = 16000   # eixo dos gatilhos (0..32767) considerado "pressionado"
_TRIGGER_OFF = 8000   # histerese para soltar


def is_gamepad_hotkey(hotkey: str) -> bool:
    return hotkey.startswith(PREFIX)


def parse_gamepad_hotkey(hotkey: str) -> frozenset[str]:
    return frozenset(b.strip() for b in hotkey[len(PREFIX):].split("+") if b.strip())


def format_gamepad_hotkey(buttons: set[str] | frozenset[str]) -> str:
    ordered = sorted(buttons, key=lambda b: BUTTON_ORDER.index(b) if b in BUTTON_ORDER else 99)
    return PREFIX + "+".join(ordered)


def available() -> bool:
    try:
        import sdl2  # noqa: F401
        return True
    except Exception:
        return False


Listener = Callable[[frozenset[str]], None]


class GamepadMonitor:
    """Thread única dona da SDL; notifica o conjunto de botões pressionados (união de todos
    os controles conectados) sempre que ele muda."""

    _instance: "GamepadMonitor | None" = None
    _instance_lock = threading.Lock()

    @classmethod
    def get(cls) -> "GamepadMonitor":
        with cls._instance_lock:
            if cls._instance is None:
                cls._instance = cls()
            return cls._instance

    def __init__(self) -> None:
        self._listeners: list[Listener] = []
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._pressed: frozenset[str] = frozenset()

    @property
    def pressed(self) -> frozenset[str]:
        return self._pressed

    def subscribe(self, listener: Listener) -> bool:
        """Registra o listener e garante que a thread da SDL esteja rodando.
        Retorna False se não há suporte a controle neste sistema."""
        if not available():
            return False
        with self._lock:
            if listener not in self._listeners:
                self._listeners.append(listener)
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._run, daemon=True, name="gamepad")
                self._thread.start()
        return True

    def unsubscribe(self, listener: Listener) -> None:
        with self._lock:
            if listener in self._listeners:
                self._listeners.remove(listener)

    # ------------------------------------------------------------------ SDL thread

    def _run(self) -> None:
        try:
            import sdl2
        except Exception as e:
            print(f"[gamepad] SDL2 indisponível: {e}", flush=True)
            return

        sdl2.SDL_SetHint(b"SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS", b"1")
        if sdl2.SDL_Init(sdl2.SDL_INIT_GAMECONTROLLER) != 0:
            print(f"[gamepad] falha ao iniciar SDL: {sdl2.SDL_GetError()!r}", flush=True)
            return

        button_names = {
            sdl2.SDL_CONTROLLER_BUTTON_A: "a",
            sdl2.SDL_CONTROLLER_BUTTON_B: "b",
            sdl2.SDL_CONTROLLER_BUTTON_X: "x",
            sdl2.SDL_CONTROLLER_BUTTON_Y: "y",
            sdl2.SDL_CONTROLLER_BUTTON_BACK: "back",
            sdl2.SDL_CONTROLLER_BUTTON_GUIDE: "guide",
            sdl2.SDL_CONTROLLER_BUTTON_START: "start",
            sdl2.SDL_CONTROLLER_BUTTON_LEFTSTICK: "ls",
            sdl2.SDL_CONTROLLER_BUTTON_RIGHTSTICK: "rs",
            sdl2.SDL_CONTROLLER_BUTTON_LEFTSHOULDER: "lb",
            sdl2.SDL_CONTROLLER_BUTTON_RIGHTSHOULDER: "rb",
            sdl2.SDL_CONTROLLER_BUTTON_DPAD_UP: "up",
            sdl2.SDL_CONTROLLER_BUTTON_DPAD_DOWN: "down",
            sdl2.SDL_CONTROLLER_BUTTON_DPAD_LEFT: "left",
            sdl2.SDL_CONTROLLER_BUTTON_DPAD_RIGHT: "right",
        }
        for attr, name in (
            ("SDL_CONTROLLER_BUTTON_MISC1", "misc"),
            ("SDL_CONTROLLER_BUTTON_PADDLE1", "p1"),
            ("SDL_CONTROLLER_BUTTON_PADDLE2", "p2"),
            ("SDL_CONTROLLER_BUTTON_PADDLE3", "p3"),
            ("SDL_CONTROLLER_BUTTON_PADDLE4", "p4"),
            ("SDL_CONTROLLER_BUTTON_TOUCHPAD", "touchpad"),
        ):
            if hasattr(sdl2, attr):
                button_names[getattr(sdl2, attr)] = name
        trigger_names = {
            sdl2.SDL_CONTROLLER_AXIS_TRIGGERLEFT: "lt",
            sdl2.SDL_CONTROLLER_AXIS_TRIGGERRIGHT: "rt",
        }

        controllers: dict[int, object] = {}         # instance id -> SDL_GameController*
        pressed_by_pad: dict[int, set[str]] = {}

        def open_index(index: int) -> None:
            if not sdl2.SDL_IsGameController(index):
                return
            pad = sdl2.SDL_GameControllerOpen(index)
            if not pad:
                return
            jid = sdl2.SDL_JoystickInstanceID(sdl2.SDL_GameControllerGetJoystick(pad))
            if jid in controllers:
                return
            controllers[jid] = pad
            pressed_by_pad[jid] = set()
            name = sdl2.SDL_GameControllerName(pad)
            print(f"[gamepad] conectado: {name.decode(errors='replace') if name else '?'}", flush=True)

        def publish() -> None:
            union: set[str] = set()
            for s in pressed_by_pad.values():
                union |= s
            new = frozenset(union)
            if new == self._pressed:
                return
            self._pressed = new
            with self._lock:
                listeners = list(self._listeners)
            for cb in listeners:
                try:
                    cb(new)
                except Exception as e:
                    print(f"[gamepad] listener erro: {e}", flush=True)

        event = sdl2.SDL_Event()
        # A thread fica viva depois de iniciada (custo desprezível: espera eventos com timeout).
        while True:
            if not sdl2.SDL_WaitEventTimeout(ctypes.byref(event), 100):
                continue
            t = event.type
            if t == sdl2.SDL_CONTROLLERDEVICEADDED:
                open_index(event.cdevice.which)
            elif t == sdl2.SDL_CONTROLLERDEVICEREMOVED:
                jid = event.cdevice.which
                pad = controllers.pop(jid, None)
                pressed_by_pad.pop(jid, None)
                if pad:
                    sdl2.SDL_GameControllerClose(pad)
                    print("[gamepad] desconectado", flush=True)
                publish()
            elif t in (sdl2.SDL_CONTROLLERBUTTONDOWN, sdl2.SDL_CONTROLLERBUTTONUP):
                name = button_names.get(event.cbutton.button)
                s = pressed_by_pad.get(event.cbutton.which)
                if name and s is not None:
                    if t == sdl2.SDL_CONTROLLERBUTTONDOWN:
                        s.add(name)
                    else:
                        s.discard(name)
                    publish()
            elif t == sdl2.SDL_CONTROLLERAXISMOTION:
                name = trigger_names.get(event.caxis.axis)
                s = pressed_by_pad.get(event.caxis.which)
                if name and s is not None:
                    v = event.caxis.value
                    if v >= _TRIGGER_ON and name not in s:
                        s.add(name)
                        publish()
                    elif v <= _TRIGGER_OFF and name in s:
                        s.discard(name)
                        publish()

