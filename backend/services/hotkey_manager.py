from collections.abc import Callable

from .. import system_log
from . import evdev_input
from .gamepad import GamepadMonitor, is_gamepad_hotkey, parse_gamepad_hotkey

_NAMES = {"transcription": "transcrição", "ai": "IA", "window": "mostrar/esconder", "call_ptt": "falar na chamada"}

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


def _is_keyboard(hotkey: str) -> bool:
    return not _is_mouse(hotkey) and not is_gamepad_hotkey(hotkey)


def is_blocked_hotkey(hotkey: str) -> bool:
    """O clique esquerdo do mouse não pode ser atalho (nem combinado com teclas): ele é usado o tempo todo,
    e um atalho nele dispararia a cada clique em qualquer lugar do computador."""
    return hotkey.split("+")[-1].strip() == "mouse:left"


def _normalize_keys(keys: "str | list[str] | None") -> list[str]:
    """Aceita um atalho (str) ou vários (lista); remove vazios, duplicados e os não permitidos, mantendo a ordem."""
    if keys is None:
        return []
    if isinstance(keys, str):
        keys = [keys]
    out: list[str] = []
    for k in keys:
        if isinstance(k, str) and k.strip() and k not in out and not is_blocked_hotkey(k):
            out.append(k)
    return out


class _Action:
    """Uma função (transcrição ou IA) com N atalhos. Fica "pressionada" enquanto
    qualquer um dos atalhos estiver ativo; press/release disparam só nas transições."""

    def __init__(self, name: str, keys: list[str], on_press: Callable | None, on_release: Callable | None):
        self.name = name
        self.keys = keys
        self.on_press = on_press
        self.on_release = on_release
        self.active: set[int] = set()  # índices dos atalhos atualmente ativos

    def set_keys(self, keys: list[str]) -> None:
        self.keys = keys
        self.active.clear()

    def activate(self, idx: int) -> None:
        was = bool(self.active)
        self.active.add(idx)
        if not was:
            system_log.log("info", "atalhos", f"atalho de {_NAMES.get(self.name, self.name)} apertado ({self.keys[idx] if idx < len(self.keys) else idx})")
        if not was and self.on_press:
            try:
                self.on_press()
            except Exception as e:  # noqa: BLE001
                system_log.log("error", "atalhos", f"erro ao iniciar {_NAMES.get(self.name, self.name)}: {system_log.exc_text(e)}")

    def deactivate(self, idx: int) -> None:
        if idx not in self.active:
            return
        self.active.discard(idx)
        if not self.active:
            system_log.log("info", "atalhos", f"atalho de {_NAMES.get(self.name, self.name)} solto")
        if not self.active and self.on_release:
            try:
                self.on_release()
            except Exception as e:  # noqa: BLE001
                system_log.log("error", "atalhos", f"erro ao terminar {_NAMES.get(self.name, self.name)}: {system_log.exc_text(e)}")


class HotkeyManager:
    """Gerencia duas funções push-to-talk independentes (transcrição + IA),
    cada uma com um ou mais atalhos (teclado, mouse ou controle)."""

    def __init__(
        self,
        transcription_key: "str | list[str]" = "mouse:button8",
        ai_key: "str | list[str]" = "<ctrl>+mouse:button8",
        on_transcription_press: Callable | None = None,
        on_transcription_release: Callable | None = None,
        on_ai_press: Callable | None = None,
        on_ai_release: Callable | None = None,
        window_key: "str | list[str]" = "<ctrl>+<alt>+<f12>",
        on_window_press: Callable | None = None,
        call_ptt_key: "str | list[str] | None" = None,
        on_call_ptt_press: Callable | None = None,
        on_call_ptt_release: Callable | None = None,
    ) -> None:
        self._tr = _Action("transcription", _normalize_keys(transcription_key),
                           on_transcription_press, on_transcription_release)
        self._ai = _Action("ai", _normalize_keys(ai_key), on_ai_press, on_ai_release)
        # mostrar/esconder a janela: só age ao apertar (não tem "soltar")
        self._win = _Action("window", _normalize_keys(window_key), on_window_press, None)
        # chamada: "apertar para falar" (o microfone da chamada só transmite enquanto segura)
        self._ptt = _Action("call_ptt", _normalize_keys(call_ptt_key), on_call_ptt_press, on_call_ptt_release)

        self._held_mods: set[str] = set()
        self._paused = False
        self._kb_listener = None
        self._mouse_listener = None
        self._evdev: evdev_input.EvdevListener | None = None
        self._gamepad_subscribed = False
        # como as teclas chegam: "pynput" (X11/Windows/Mac) ou "evdev" (Linux com Wayland, leitura direta)
        self.method = "none"

    @property
    def _actions(self) -> tuple[_Action, ...]:
        return (self._tr, self._ai, self._win, self._ptt)

    def _all_keys(self) -> list[str]:
        return self._tr.keys + self._ai.keys + self._win.keys + self._ptt.keys

    def start(self) -> None:
        system_log.log(
            "info", "atalhos",
            f"ligando os atalhos | transcrição: {', '.join(self._tr.keys) or 'nenhum'} | IA: {', '.join(self._ai.keys) or 'nenhum'} | "
            f"mostrar/esconder: {', '.join(self._win.keys) or 'nenhum'} | falar na chamada: {', '.join(self._ptt.keys) or 'nenhum'}",
        )
        if evdev_input.wayland_session():
            access = evdev_input.access_status()
            if access["ok"]:
                self._start_evdev()
                self._update_gamepad_subscription()
                return
            system_log.log(
                "warn", "atalhos",
                f"sessão Wayland sem permissão para ler o teclado/mouse ({access['readable']} de {access['devices']} "
                "dispositivos): os atalhos só funcionam com o Voice AI em foco. Libere em Configurações → Atalhos.",
            )
        try:
            self._start_keyboard()
        except Exception as e:  # noqa: BLE001
            system_log.log("error", "atalhos", f"não deu para ouvir o teclado: {system_log.exc_text(e)}")
        if any(_is_mouse(k) for k in self._all_keys()):
            try:
                self._start_mouse()
            except Exception as e:  # noqa: BLE001
                system_log.log("error", "atalhos", f"não deu para ouvir o mouse: {system_log.exc_text(e)}")
        self._update_gamepad_subscription()

    def stop(self) -> None:
        for listener in (self._kb_listener, self._mouse_listener):
            if listener:
                listener.stop()
        self._kb_listener = None
        self._mouse_listener = None
        if self._evdev:
            self._evdev.stop()
            self._evdev = None
        self.method = "none"
        if self._gamepad_subscribed:
            GamepadMonitor.get().unsubscribe(self._on_gamepad)
            self._gamepad_subscribed = False

    def update_transcription_key(self, key: "str | list[str]") -> None:
        self._tr.set_keys(_normalize_keys(key))
        self._restart_mouse_if_needed()
        self._update_gamepad_subscription()

    def update_ai_key(self, key: "str | list[str]") -> None:
        self._ai.set_keys(_normalize_keys(key))
        self._restart_mouse_if_needed()
        self._update_gamepad_subscription()

    def update_window_key(self, key: "str | list[str]") -> None:
        self._win.set_keys(_normalize_keys(key))
        self._restart_mouse_if_needed()
        self._update_gamepad_subscription()

    def update_call_ptt_key(self, key: "str | list[str]") -> None:
        self._ptt.set_keys(_normalize_keys(key))
        self._restart_mouse_if_needed()
        self._update_gamepad_subscription()

    def _note_event(self, kind: str) -> None:
        """Registra o primeiro evento de cada tipo: se nunca aparecer, o sistema não está entregando as teclas/cliques."""
        seen = self.__dict__.setdefault("_seen", set())
        if kind not in seen:
            seen.add(kind)
            system_log.log("info", "atalhos", f"primeiro evento de {kind} recebido: o {kind} está chegando ao app")

    def pause(self) -> None:
        self._paused = True
        self._held_mods.clear()

    def resume(self) -> None:
        self._paused = False
        for action in self._actions:
            action.active.clear()
        self._held_mods.clear()

    def restart(self) -> None:
        """Liga de novo (ex.: depois de liberar a leitura do teclado no Wayland)."""
        self.stop()
        for action in self._actions:
            action.active.clear()
        self._held_mods.clear()
        self.start()

    def _restart_mouse_if_needed(self) -> None:
        if self._evdev:  # a leitura direta já inclui o mouse
            return
        if self._mouse_listener:
            self._mouse_listener.stop()
            self._mouse_listener = None
        if any(_is_mouse(k) for k in self._all_keys()):
            self._start_mouse()

    # ------------------------------------------------------------------ teclado

    def _start_keyboard(self) -> None:
        from pynput import keyboard

        def on_press(key):
            self._handle_key(_key_to_str(key), True)

        def on_release(key):
            self._handle_key(_key_to_str(key), False)

        self._kb_listener = keyboard.Listener(on_press=on_press, on_release=on_release)
        self._kb_listener.daemon = True
        self._kb_listener.start()
        self.method = "pynput"
        system_log.log("info", "atalhos", f"ouvindo o teclado (pynput, backend {type(self._kb_listener).__module__})")

    def _handle_key(self, key_str: str, pressed: bool) -> None:
        if pressed:
            self._note_event("teclado")
        if self._paused:
            return
        if pressed:
            if key_str in _MODIFIERS:
                self._held_mods.add(key_str)
            for action in self._actions:
                for idx, hotkey in enumerate(action.keys):
                    if not _is_keyboard(hotkey):
                        continue
                    mods, trigger = _parse_hotkey(hotkey)
                    if key_str == trigger and self._held_mods >= mods and idx not in action.active:
                        action.activate(idx)
        else:
            self._held_mods.discard(key_str)
            for action in self._actions:
                for idx, hotkey in enumerate(action.keys):
                    if not _is_keyboard(hotkey):
                        continue
                    _, trigger = _parse_hotkey(hotkey)
                    if key_str == trigger and idx in action.active:
                        action.deactivate(idx)

    def _handle_button(self, btn_str: str, pressed: bool) -> None:
        self._note_event("mouse")
        if self._paused:
            return
        for action in self._actions:
            for idx, hotkey in enumerate(action.keys):
                if not _is_mouse(hotkey):
                    continue
                mods, trigger = _parse_hotkey(hotkey)
                if btn_str == trigger and self._held_mods >= mods:
                    if pressed and idx not in action.active:
                        action.activate(idx)
                    elif not pressed and idx in action.active:
                        action.deactivate(idx)

    # ------------------------------------------------------------------ Linux com Wayland: leitura direta

    def _start_evdev(self) -> None:
        self._evdev = evdev_input.EvdevListener(self._handle_key, self._handle_button)
        self._evdev.start()
        self.method = "evdev"
        system_log.log(
            "info", "atalhos",
            f"Wayland: atalhos globais pela leitura direta do teclado e do mouse ({self._evdev.device_count} dispositivos)",
        )

    # ------------------------------------------------------------------ mouse

    def _start_mouse(self) -> None:
        from pynput import mouse

        def on_click(x, y, button, pressed):
            self._handle_button(f"mouse:{button.name}", pressed)

        self._mouse_listener = mouse.Listener(on_click=on_click)
        self._mouse_listener.daemon = True
        self._mouse_listener.start()
        system_log.log("info", "atalhos", f"ouvindo o mouse (pynput, backend {type(self._mouse_listener).__module__})")

    # ------------------------------------------------------------------ controle (gamepad)

    def _update_gamepad_subscription(self) -> None:
        want = any(is_gamepad_hotkey(k) for k in self._all_keys())
        monitor = GamepadMonitor.get()
        if want and not self._gamepad_subscribed:
            self._gamepad_subscribed = monitor.subscribe(self._on_gamepad)
            if not self._gamepad_subscribed:
                print("[hotkey] atalho de controle configurado, mas sem suporte a controle (pysdl2)", flush=True)
        elif not want and self._gamepad_subscribed:
            monitor.unsubscribe(self._on_gamepad)
            self._gamepad_subscribed = False

    def _on_gamepad(self, pressed: frozenset[str]) -> None:
        """Um atalho de controle fica ativo enquanto TODOS os botões dele estão pressionados."""
        if self._paused:
            return
        # (ação, índice, combinação) de todos os atalhos de controle satisfeitos agora
        satisfied: list[tuple[_Action, int, frozenset[str]]] = []
        for action in self._actions:
            for idx, hotkey in enumerate(action.keys):
                if is_gamepad_hotkey(hotkey):
                    combo = parse_gamepad_hotkey(hotkey)
                    if combo and combo <= pressed:
                        satisfied.append((action, idx, combo))
        # Se um atalho de uma função contém o de outra (ex.: L1+R1 e L1+R1+△), o maior vence
        winners = {
            (a.name, i)
            for a, i, c in satisfied
            if not any(o is not a and oc > c for o, _, oc in satisfied)
        }
        for action in self._actions:
            for idx, hotkey in enumerate(action.keys):
                if not is_gamepad_hotkey(hotkey):
                    continue
                should = (action.name, idx) in winners
                if should and idx not in action.active:
                    action.activate(idx)
                elif not should and idx in action.active:
                    action.deactivate(idx)
