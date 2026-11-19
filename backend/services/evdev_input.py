"""Teclado e mouse lidos direto do sistema (/dev/input), para os atalhos globais no Linux com Wayland.

Por quê: no Wayland, por segurança, um programa não recebe as teclas e cliques feitos em outros programas.
O pynput (usado no X11 e no Windows) só enxerga o que vai para janelas X11, então os atalhos não disparam
com outro programa na frente. Lendo os dispositivos de entrada direto, os atalhos funcionam em qualquer
lugar, como no X11. Não "prende" nada: as teclas continuam indo normalmente para os outros programas.

Permissão: os arquivos /dev/input/event* são só do root e do grupo "input". O app oferece liberar uma vez
(pede a senha pelo próprio Ubuntu): uma regra do udev dá à pessoa que está usando o computador (a sessão
ativa) acesso de leitura a teclados e mouses, na hora, sem precisar sair e entrar de novo.

Os nomes das teclas seguem o formato que o app já guarda (o do pynput): "t", "<f9>", "<ctrl>", "mouse:button8".
"""
from __future__ import annotations

import os
import re
import select
import struct
import subprocess
import sys
import threading
import time
from collections.abc import Callable

from .. import system_log

EV_KEY = 1
_EVENT = struct.Struct("llHHi")  # struct input_event: tempo (timeval), tipo, código, valor
RULE_FILE = "/etc/udev/rules.d/72-voice-ai-input.rules"
RULE = 'SUBSYSTEM=="input", KERNEL=="event*", TAG+="uaccess"'

# --------------------------------------------------------------------------- nomes das teclas (linux/input-event-codes.h)

_KEYS: dict[int, str] = {
    1: "<esc>", 14: "<backspace>", 15: "<tab>", 28: "<enter>", 57: "<space>", 58: "<caps_lock>",
    29: "<ctrl>", 97: "<ctrl>", 42: "<shift>", 54: "<shift>", 56: "<alt>", 100: "<alt>",
    125: "<cmd>", 126: "<cmd_r>", 127: "<menu>",
    12: "-", 13: "=", 26: "[", 27: "]", 39: ";", 40: "'", 41: "`", 43: "\\", 51: ",", 52: ".", 53: "/",
    86: "\\", 89: "/",
    69: "<num_lock>", 70: "<scroll_lock>", 99: "<print_screen>", 119: "<pause>",
    102: "<home>", 103: "<up>", 104: "<page_up>", 105: "<left>", 106: "<right>", 107: "<end>",
    108: "<down>", 109: "<page_down>", 110: "<insert>", 111: "<delete>",
    113: "<media_volume_mute>", 114: "<media_volume_down>", 115: "<media_volume_up>",
    163: "<media_next>", 164: "<media_play_pause>", 165: "<media_previous>",
    55: "<kp_*>", 74: "<kp_->", 78: "<kp_+>", 83: "<kp_.>", 96: "<kp_enter>", 98: "<kp_/>",
}
for _code, _ch in zip(range(2, 12), "1234567890"):
    _KEYS[_code] = _ch
for _start, _row in ((16, "qwertyuiop"), (30, "asdfghjkl"), (44, "zxcvbnm")):
    for _i, _ch in enumerate(_row):
        _KEYS[_start + _i] = _ch
for _i in range(10):
    _KEYS[59 + _i] = f"<f{_i + 1}>"  # F1-F10
_KEYS[87], _KEYS[88] = "<f11>", "<f12>"
for _i in range(12):
    _KEYS[183 + _i] = f"<f{_i + 13}>"  # F13-F24
for _code, _n in {71: 7, 72: 8, 73: 9, 75: 4, 76: 5, 77: 6, 79: 1, 80: 2, 81: 3, 82: 0}.items():
    _KEYS[_code] = f"<kp_{_n}>"

# botões do mouse: mesmos números do X11 (o lateral de trás é o 8, o da frente o 9)
_BUTTONS: dict[int, str] = {
    0x110: "left", 0x111: "right", 0x112: "middle", 0x113: "button8", 0x114: "button9",
    0x115: "button10", 0x116: "button11", 0x117: "button12",
}


def key_name(code: int) -> str:
    return _KEYS.get(code, f"<key_{code}>")


# --------------------------------------------------------------------------- dispositivos e permissão

def wayland_session() -> bool:
    return sys.platform.startswith("linux") and (
        os.environ.get("XDG_SESSION_TYPE") == "wayland" or bool(os.environ.get("WAYLAND_DISPLAY"))
    )


def list_devices() -> list[tuple[str, str]]:
    """(caminho, nome) de cada dispositivo com teclas ou botões (teclados, mouses, controles de mídia)."""
    try:
        text = open("/proc/bus/input/devices", encoding="utf-8", errors="replace").read()
    except OSError:
        return []
    out: list[tuple[str, str]] = []
    for block in text.split("\n\n"):
        name = re.search(r'^N: Name="(.*)"$', block, re.M)
        handlers = re.search(r"^H: Handlers=(.*)$", block, re.M)
        ev = re.search(r"^B: EV=([0-9a-f]+)$", block, re.M)
        if not handlers or not ev:
            continue
        event = re.search(r"\bevent(\d+)\b", handlers.group(1))
        if event and int(ev.group(1), 16) & (1 << EV_KEY):
            out.append((f"/dev/input/event{event.group(1)}", name.group(1).strip() if name else "?"))
    return out


def access_status() -> dict:
    devices = list_devices()
    readable = [p for p, _ in devices if os.access(p, os.R_OK)]
    return {"devices": len(devices), "readable": len(readable), "ok": bool(readable)}


def grant_access(timeout: float = 180.0) -> tuple[bool, str]:
    """Pede a senha (pkexec, janela do próprio sistema) e instala a regra que libera a leitura do teclado e do
    mouse para quem está usando o computador. Vale na hora e continua valendo depois de reiniciar."""
    script = (
        f"printf '%s\\n' '# Voice AI: atalhos globais no Wayland (leitura do teclado/mouse pela sessão ativa)' "
        f"'{RULE}' > {RULE_FILE} && udevadm control --reload-rules && "
        "udevadm trigger --subsystem-match=input --action=change && udevadm settle --timeout=5"
    )
    system_log.log("info", "atalhos", "pedindo permissão para ler o teclado e o mouse (pkexec)")
    try:
        r = subprocess.run(["pkexec", "/bin/sh", "-c", script], capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        return False, "pkexec não encontrado (instale o pacote policykit-1/pkexec)"
    except subprocess.TimeoutExpired:
        return False, "a janela de senha ficou aberta tempo demais"
    if r.returncode in (126, 127):
        return False, "permissão negada ou janela de senha cancelada"
    if r.returncode != 0:
        return False, (r.stderr or r.stdout or f"código {r.returncode}").strip()[-400:]
    # o udev aplica a permissão logo em seguida; espera um pouco por ela
    for _ in range(20):
        if access_status()["ok"]:
            return True, "liberado"
        time.sleep(0.25)
    return False, "a regra foi instalada, mas o acesso ainda não apareceu (sair e entrar na sessão deve resolver)"


# --------------------------------------------------------------------------- leitura

class EvdevListener:
    """Lê todos os teclados e mouses numa thread. on_key(nome, apertado) e on_button("mouse:x", apertado).
    Teclado/mouse conectados depois (ex.: Bluetooth) entram sozinhos em até 3 s."""

    def __init__(
        self, on_key: Callable[[str, bool], None], on_button: Callable[[str, bool], None] | None = None, quiet: bool = False
    ) -> None:
        self._quiet = quiet
        self._on_key = on_key
        self._on_button = on_button
        self._fds: dict[int, str] = {}  # fd → caminho
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True, name="evdev-input")
        self._denied_logged: set[str] = set()

    def start(self) -> None:
        self._scan(first=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    @property
    def device_count(self) -> int:
        return len(self._fds)

    def _scan(self, first: bool = False) -> None:
        wanted = dict(list_devices())
        open_paths = set(self._fds.values())
        for path, name in wanted.items():
            if path in open_paths:
                continue
            try:
                fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
            except OSError as e:
                if path not in self._denied_logged and not self._quiet:
                    self._denied_logged.add(path)
                    if not first:
                        system_log.log("warn", "atalhos", f"sem acesso a {name} ({path}): {e.strerror}")
                continue
            self._fds[fd] = path
            if not self._quiet:
                system_log.log("info", "atalhos", f"lendo {name} ({path})")
        for fd, path in list(self._fds.items()):
            if path not in wanted:
                self._close(fd)

    def _close(self, fd: int) -> None:
        self._fds.pop(fd, None)
        try:
            os.close(fd)
        except OSError:
            pass

    def _run(self) -> None:
        last_scan = time.monotonic()
        while not self._stop.is_set():
            if time.monotonic() - last_scan > 3:
                last_scan = time.monotonic()
                try:
                    self._scan()
                except Exception as e:  # noqa: BLE001
                    system_log.log("warn", "atalhos", f"falha ao procurar teclados/mouses: {e}")
            fds = list(self._fds)
            if not fds:
                self._stop.wait(0.5)
                continue
            try:
                ready, _, _ = select.select(fds, [], [], 0.5)
            except (OSError, ValueError):
                for fd in fds:  # um dispositivo sumiu no meio: refaz a lista
                    try:
                        os.fstat(fd)
                    except OSError:
                        self._close(fd)
                continue
            for fd in ready:
                try:
                    data = os.read(fd, _EVENT.size * 64)
                except BlockingIOError:
                    continue
                except OSError:  # desconectado
                    self._close(fd)
                    continue
                self.feed(data)
        for fd in list(self._fds):
            self._close(fd)

    def feed(self, data: bytes) -> None:
        """Interpreta eventos crus (separado da leitura para poder testar)."""
        for off in range(0, len(data) - _EVENT.size + 1, _EVENT.size):
            _, _, etype, code, value = _EVENT.unpack_from(data, off)
            if etype != EV_KEY or value == 2:  # 2 = tecla segurada repetindo
                continue
            pressed = value == 1
            try:
                if code in _BUTTONS:
                    if self._on_button:
                        self._on_button(f"mouse:{_BUTTONS[code]}", pressed)
                elif code < 0x100:
                    self._on_key(key_name(code), pressed)
            except Exception as e:  # noqa: BLE001
                system_log.log("error", "atalhos", f"erro ao tratar uma tecla: {system_log.exc_text(e)}")


def pack_event(code: int, value: int, etype: int = EV_KEY) -> bytes:
    """Monta um evento cru (para testes)."""
    return _EVENT.pack(0, 0, etype, code, value)
