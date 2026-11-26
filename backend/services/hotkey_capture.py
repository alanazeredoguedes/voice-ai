import threading

from . import evdev_input
from .gamepad import GamepadMonitor, format_gamepad_hotkey
from .hotkey_manager import _MODIFIERS, _key_to_str, normalize_mouse_button


def capture_hotkey(timeout: float = 10.0) -> str | None:
    """Captura o próximo atalho pressionado (teclado ou mouse) e retorna no formato pynput.

    Formato de retorno:
      - "a", "<f9>", "<ctrl>+<f9>"
      - "mouse:button8", "<ctrl>+mouse:button8"
      - "gamepad:lb+rb" (combinação de botões do controle; captura ao soltar)

    Retorna None se o timeout expirar sem capturar nada.
    """
    done = threading.Event()
    captured: dict = {"hotkey": None}
    held_mods: set[str] = set()
    lock = threading.Lock()

    def _finish(hotkey: str) -> None:
        with lock:
            if captured["hotkey"] is None:
                captured["hotkey"] = hotkey
                done.set()

    def key_event(key_str: str, pressed: bool) -> None:
        if not pressed:
            held_mods.discard(key_str)
            return
        if key_str in _MODIFIERS:
            held_mods.add(key_str)
            return
        # trigger não-modificador
        _finish("+".join(sorted(held_mods) + [key_str]))

    def button_event(btn_str: str, pressed: bool) -> None:
        if not pressed or btn_str == "mouse:left":
            return  # o clique esquerdo não pode ser atalho: ignora e continua esperando outro
        _finish("+".join(sorted(held_mods) + [btn_str]))

    # Controle: acumula os botões segurados juntos; ao soltar qualquer um, captura a combinação
    monitor = GamepadMonitor.get()
    pre_held: set[str] = set(monitor.pressed)  # já pressionados antes da captura: ignorar
    pad_peak: set[str] = set()
    pad_prev: set[str] = set(pre_held)

    def on_gamepad(pressed: frozenset[str]) -> None:
        nonlocal pad_prev
        released = pad_prev - pressed
        pre_held.difference_update(released)
        pad_peak.update(pressed - pre_held)
        pad_prev = set(pressed)
        if released and pad_peak:
            _finish(format_gamepad_hotkey(pad_peak))

    pad_ok = monitor.subscribe(on_gamepad)

    # Linux com Wayland e leitura liberada: lê o teclado/mouse direto (o pynput não vê teclas fora do app)
    if evdev_input.wayland_session() and evdev_input.access_status()["ok"]:
        ev = evdev_input.EvdevListener(key_event, button_event, quiet=True)
        ev.start()
        stoppers = [ev.stop]
    else:
        from pynput import keyboard, mouse

        def on_key_press(key):
            key_event(_key_to_str(key), True)
            return False if captured["hotkey"] else None

        def on_key_release(key):
            key_event(_key_to_str(key), False)

        def on_click(x, y, button, pressed):
            button_event(normalize_mouse_button(f"mouse:{button.name}"), pressed)
            return False if captured["hotkey"] else None

        kb = keyboard.Listener(on_press=on_key_press, on_release=on_key_release)
        ms = mouse.Listener(on_click=on_click)
        kb.daemon = True
        ms.daemon = True
        kb.start()
        ms.start()
        stoppers = [kb.stop, ms.stop]

    done.wait(timeout=timeout)
    for stop in stoppers:
        stop()
    if pad_ok:
        monitor.unsubscribe(on_gamepad)
    return captured["hotkey"]
