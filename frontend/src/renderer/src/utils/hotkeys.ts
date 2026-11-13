/** Atalhos (como o backend guarda) em texto para a pessoa ler: "<ctrl>+<alt>+<f12>" vira "Ctrl + Alt + F12". */
const GAMEPAD_LABELS: Record<string, string> = {
  a: '✕', b: '○', x: '□', y: '△',
  lb: 'L1', rb: 'R1', lt: 'L2', rt: 'R2', ls: 'L3', rs: 'R3',
  up: '↑', down: '↓', left: '←', right: '→',
  back: 'Create', start: 'Options', guide: 'PS', touchpad: 'Touchpad', misc: 'Mic',
  p1: 'P1', p2: 'P2', p3: 'P3', p4: 'P4'
}

const KEY_NAMES: Record<string, string> = {
  ctrl: 'Ctrl', ctrl_l: 'Ctrl', ctrl_r: 'Ctrl', alt: 'Alt', alt_l: 'Alt', alt_r: 'Alt', alt_gr: 'Alt Gr',
  shift: 'Shift', shift_l: 'Shift', shift_r: 'Shift', cmd: 'Win', cmd_l: 'Win', cmd_r: 'Win',
  space: 'Espaço', enter: 'Enter', esc: 'Esc', tab: 'Tab', backspace: 'Backspace', delete: 'Delete',
  caps_lock: 'Caps Lock', up: '↑', down: '↓', left: '←', right: '→',
  page_up: 'Page Up', page_down: 'Page Down', home: 'Home', end: 'End', insert: 'Insert'
}

const MOUSE_NAMES: Record<string, string> = { middle: 'Mouse (botão do meio)', right: 'Mouse (botão direito)', x1: 'Mouse (botão lateral 1)', x2: 'Mouse (botão lateral 2)' }

export function prettyHotkey(hotkey: string): string {
  if (!hotkey) return ''
  if (hotkey.startsWith('gamepad:')) {
    return '🎮 ' + hotkey.slice('gamepad:'.length).split('+').map((b) => GAMEPAD_LABELS[b] ?? b).join(' + ')
  }
  if (hotkey.startsWith('mouse:')) {
    const b = hotkey.slice('mouse:'.length)
    return MOUSE_NAMES[b] ?? `Mouse (${b})`
  }
  return hotkey
    .split('+')
    .map((part) => {
      const k = part.replace(/^<|>$/g, '')
      return KEY_NAMES[k] ?? (k.length === 1 ? k.toUpperCase() : k.toUpperCase())
    })
    .join(' + ')
}
