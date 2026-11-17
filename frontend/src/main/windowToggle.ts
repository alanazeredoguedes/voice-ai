import type { BrowserWindow } from 'electron'

/**
 * Atalho "mostrar/esconder": traz a janela do app para a frente de tudo (inclusive de jogos em tela cheia
 * sem bordas) ou a esconde, devolvendo o foco para a janela que estava antes.
 * Com "manter na frente" desligado, ela vem para a frente mas outra janela clicada passa por cima.
 *
 * - Mostrar: prioridade máxima de "sempre por cima" ('screen-saver' é o nível mais alto do Windows).
 * - Esconder: tira o "sempre por cima" e esconde. Se a janela estiver aberta mas atrás de outras (aberta
 *   pela bandeja, por exemplo), o atalho a traz para a frente em vez de escondê-la.
 */
let releaseOnBlur: (() => void) | null = null

export function toggleWindowOnTop(win: BrowserWindow, keepOnTop: boolean): 'shown' | 'hidden' {
  if (releaseOnBlur) win.off('blur', releaseOnBlur)
  releaseOnBlur = null
  if (win.isVisible() && !win.isMinimized() && (win.isAlwaysOnTop() || win.isFocused())) {
    win.setAlwaysOnTop(false)
    win.hide()
    return 'hidden'
  }
  if (win.isMinimized()) win.restore()
  // por cima de tudo para aparecer até sobre jogos em tela cheia
  win.setAlwaysOnTop(true, 'screen-saver')
  win.show()
  win.moveTop()
  win.focus()
  if (!keepOnTop) {
    // sem "manter na frente": ao clicar em outra janela, ela pode passar por cima
    releaseOnBlur = () => {
      releaseOnBlur = null
      if (!win.isDestroyed()) win.setAlwaysOnTop(false)
    }
    win.once('blur', releaseOnBlur)
  }
  return 'shown'
}

/** A opção mudou com a janela aberta: aplica na hora. */
export function setKeepOnTop(win: BrowserWindow, keepOnTop: boolean): void {
  if (releaseOnBlur) win.off('blur', releaseOnBlur)
  releaseOnBlur = null
  if (keepOnTop || !win.isAlwaysOnTop()) return
  if (!win.isFocused()) {
    win.setAlwaysOnTop(false)
    return
  }
  releaseOnBlur = () => {
    releaseOnBlur = null
    if (!win.isDestroyed()) win.setAlwaysOnTop(false)
  }
  win.once('blur', releaseOnBlur)
}
