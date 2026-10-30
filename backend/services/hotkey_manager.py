from collections.abc import Callable

_MODIFIER_ALIASES = {
    "<ctrl_l>": "<ctrl>",  "<ctrl_r>": "<ctrl>",
    "<alt_l>":  "<alt>",   "<alt_r>":  "<alt>",  "<alt_gr>": "<alt>",
    "<shift_l>":"<shift>", "<shift_r>":"<shift>",
    "<super_l>":"<super>", "<super_r>":"<super>",
}
_MODIFIERS = {"<ctrl>", "<alt>", "<shift>", "<super>"}


def _key_to_str(key) -> str:
    try:
        if hasattr(key, "char") and key.char:
            return key.char
        result = f"<{key.name}>"
        return _MODIFIER_ALIASES.get(result, result)
    except AttributeError:
        return str(key)


def _parse_hotkey(hotkey: str) -> tuple[frozenset[str], str]:
    parts = [p.strip() for p in hotkey.split("+")]
    return frozenset(parts[:-1]), parts[-1]


def _is_mouse(hotkey: str) -> bool:
    return "mouse:" in hotkey.split("+")[-1]


class HotkeyManager:
    """Gerencia dois atalhos push-to-talk independentes (transcrição + IA)."""

    def __init__(
        self,
        transcription_key: str = "mouse:button8",
        ai_key: str = "<ctrl>+mouse:button8",
        on_transcription_press: Callable | None = None,
        on_transcription_release: Callable | None = None,
        on_ai_press: Callable | None = None,
        on_ai_release: Callable | None = None,
    ) -> None:
        self._transcription_key = transcription_key
        self._ai_key = ai_key
        self._on_transcription_press = on_transcription_press
        self._on_transcription_release = on_transcription_release
        self._on_ai_press = on_ai_press
        self._on_ai_release = on_ai_release

        self._held_mods: set[str] = set()
        self._transcription_pressed = False
        self._ai_pressed = False
        self._paused = False
        self._kb_listener = None
        self._mouse_listener = None

    def start(self) -> None:
        self._start_keyboard()
        if _is_mouse(self._transcription_key) or _is_mouse(self._ai_key):
            self._start_mouse()

    def stop(self) -> None:
        for listener in (self._kb_listener, self._mouse_listener):
            if listener:
                listener.stop()
        self._kb_listener = None
        self._mouse_listener = None

    def update_transcription_key(self, key: str) -> None:
        self._transcription_key = key
        self._transcription_pressed = False
        self._restart_mouse_if_needed()

    def update_ai_key(self, key: str) -> None:
        self._ai_key = key
        self._ai_pressed = False
        self._restart_mouse_if_needed()

    def pause(self) -> None:
        self._paused = True
        self._held_mods.clear()

    def resume(self) -> None:
        self._paused = False
        self._transcription_pressed = False
        self._ai_pressed = False
        self._held_mods.clear()

    def _restart_mouse_if_needed(self) -> None:
        if self._mouse_listener:
            self._mouse_listener.stop()
            self._mouse_listener = None
        if _is_mouse(self._transcription_key) or _is_mouse(self._ai_key):
            self._start_mouse()

    def _start_keyboard(self) -> None:
        from pynput import keyboard

        def on_press(key):
            if self._paused:
                return
            key_str = _key_to_str(key)
            if key_str in _MODIFIERS:
                self._held_mods.add(key_str)
            if not _is_mouse(self._transcription_key):
                mods, trigger = _parse_hotkey(self._transcription_key)
                if key_str == trigger and self._held_mods >= mods and not self._transcription_pressed:
                    self._transcription_pressed = True
                    if self._on_transcription_press:
                        self._on_transcription_press()
            if not _is_mouse(self._ai_key):
                mods, trigger = _parse_hotkey(self._ai_key)
                if key_str == trigger and self._held_mods >= mods and not self._ai_pressed:
                    self._ai_pressed = True
                    if self._on_ai_press:
                        self._on_ai_press()

        def on_release(key):
            if self._paused:
                return
            key_str = _key_to_str(key)
            self._held_mods.discard(key_str)
            if not _is_mouse(self._transcription_key):
                _, trigger = _parse_hotkey(self._transcription_key)
                if key_str == trigger and self._transcription_pressed:
                    self._transcription_pressed = False
                    if self._on_transcription_release:
                        self._on_transcription_release()
            if not _is_mouse(self._ai_key):
                _, trigger = _parse_hotkey(self._ai_key)
                if key_str == trigger and self._ai_pressed:
                    self._ai_pressed = False
                    if self._on_ai_release:
                        self._on_ai_release()

        self._kb_listener = keyboard.Listener(on_press=on_press, on_release=on_release)
        self._kb_listener.daemon = True
        self._kb_listener.start()

    def _start_mouse(self) -> None:
        from pynput import mouse

        def on_click(x, y, button, pressed):
            if self._paused:
                return
            btn_str = f"mouse:{button.name}"
            if _is_mouse(self._transcription_key):
                mods, trigger = _parse_hotkey(self._transcription_key)
                if btn_str == trigger and self._held_mods >= mods:
                    if pressed and not self._transcription_pressed:
                        self._transcription_pressed = True
                        if self._on_transcription_press:
                            self._on_transcription_press()
                    elif not pressed and self._transcription_pressed:
                        self._transcription_pressed = False
                        if self._on_transcription_release:
                            self._on_transcription_release()
            if _is_mouse(self._ai_key):
                mods, trigger = _parse_hotkey(self._ai_key)
                if btn_str == trigger and self._held_mods >= mods:
                    if pressed and not self._ai_pressed:
                        self._ai_pressed = True
                        if self._on_ai_press:
                            self._on_ai_press()
                    elif not pressed and self._ai_pressed:
                        self._ai_pressed = False
                        if self._on_ai_release:
                            self._on_ai_release()

        self._mouse_listener = mouse.Listener(on_click=on_click)
        self._mouse_listener.daemon = True
        self._mouse_listener.start()
