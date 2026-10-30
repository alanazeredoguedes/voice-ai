import threading
import time

from .hotkey_manager import _MODIFIER_ALIASES, _MODIFIERS, _key_to_str


def capture_hotkey(timeout: float = 10.0) -> str | None:
    """Captura o próximo atalho pressionado (teclado ou mouse) e retorna no formato pynput.

    Formato de retorno:
      - "a", "<f9>", "<ctrl>+<f9>"
      - "mouse:button8", "<ctrl>+mouse:button8"

    Retorna None se o timeout expirar sem capturar nada.
    """
    from pynput import keyboard, mouse

    done = threading.Event()
    captured: dict = {"hotkey": None}
    held_mods: set[str] = set()
    lock = threading.Lock()

    def _finish(hotkey: str) -> None:
        with lock:
            if captured["hotkey"] is None:
                captured["hotkey"] = hotkey
                done.set()

    def on_key_press(key):
        key_str = _key_to_str(key)
        if key_str in _MODIFIERS:
            held_mods.add(key_str)
            return
        # trigger não-modificador
        hotkey = "+".join(sorted(held_mods) + [key_str])
        _finish(hotkey)
        return False

    def on_key_release(key):
        key_str = _key_to_str(key)
        held_mods.discard(key_str)

    def on_click(x, y, button, pressed):
        if not pressed:
            return
        btn_str = f"mouse:{button.name}"
        hotkey = "+".join(sorted(held_mods) + [btn_str])
        _finish(hotkey)
        return False

    kb = keyboard.Listener(on_press=on_key_press, on_release=on_key_release)
    ms = mouse.Listener(on_click=on_click)
    kb.daemon = True
    ms.daemon = True
    kb.start()
    ms.start()

    done.wait(timeout=timeout)
    kb.stop()
    ms.stop()
    return captured["hotkey"]
