import type { BrowserWindow } from 'electron'

/**
 * Atalho "mostrar/esconder": traz a janela do app para a frente de tudo (inclusive de jogos em tela cheia
 * sem bordas) ou a esconde, devolvendo o foco para a janela que estava antes.
 *
 * - Mostrar: prioridade máxima de "sempre por cima" ('screen-saver' é o nível mais alto do Windows).
 * - Esconder: tira o "sempre por cima" e esconde. Se a janela estiver aberta mas atrás de outras (aberta
 *   pela bandeja, por exemplo), o atalho a traz para a frente em vez de escondê-la.
 */
export function toggleWindowOnTop(win: BrowserWindow): 'shown' | 'hidden' {
  if (win.isVisible() && !win.isMinimized() && win.isAlwaysOnTop()) {
    win.setAlwaysOnTop(false)
    win.hide()
    return 'hidden'
  }
  if (win.isMinimized()) win.restore()
  win.setAlwaysOnTop(true, 'screen-saver')
  win.show()
  win.moveTop()
  win.focus()
  return 'shown'
}
