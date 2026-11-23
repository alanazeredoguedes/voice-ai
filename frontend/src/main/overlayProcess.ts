/**
 * Indicador (overlay) em processo separado, para o Linux com Wayland.
 *
 * Por quê: no Wayland nativo nenhuma janela escolhe a própria posição nem fica "sempre por cima" (quem decide é
 * o compositor), então o indicador aparecia fora do canto e atrás das outras janelas. Já uma janela em XWayland
 * (cliente X11 dentro da sessão Wayland) respeita as duas coisas. Forçar o app inteiro em X11 estragaria a
 * transmissão de tela (que depende do Wayland nativo), então só o indicador roda em X11: o app abre uma segunda
 * cópia do Electron com `--ozone-platform=x11`, só com essa janela.
 *
 * Custo de memória: o processo só existe depois que o indicador é preciso pela primeira vez e é encerrado depois
 * de alguns minutos sem uso (volta a abrir quando for preciso de novo).
 *
 * Dois lados neste arquivo:
 *  - OverlayProcessHost (processo principal): abre, conversa e encerra o processo do indicador.
 *  - runOverlayProcess (processo do indicador): cria a janela e obedece aos comandos recebidos pela entrada padrão.
 */
import { app, BrowserWindow, screen } from 'electron'
import { is } from '@electron-toolkit/utils'
import { spawn, type ChildProcess } from 'child_process'
import { join } from 'path'
import { createInterface } from 'readline'

export const OVERLAY_PROC_ENV = 'VOICE_AI_OVERLAY_PROC'
const OVERLAY_W = 220
const OVERLAY_H = 36
const MARGIN = 16
/** sem uso por este tempo: o processo do indicador é encerrado */
const IDLE_QUIT_MS = 3 * 60_000

/** Só vale a pena (e só é preciso) no Linux com Wayland e o XWayland disponível. */
export function overlayNeedsSeparateProcess(): boolean {
  return process.platform === 'linux' && process.env['XDG_SESSION_TYPE'] === 'wayland' && !!process.env['DISPLAY']
}

// ---------------------------------------------------------------------------
// Lado do processo principal
// ---------------------------------------------------------------------------

type Log = (level: 'info' | 'warn' | 'error', msg: string) => void

export class OverlayProcessHost {
  private child: ChildProcess | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private lastState = 'idle'
  private failures = 0
  /** chamado quando o processo separado não funciona (o app usa a janela comum no lugar) */
  constructor(
    private readonly log: Log,
    private readonly onUnavailable: () => void
  ) {}

  /** Mostra o indicador com o estado atual (abre o processo se preciso). */
  show(state: string): void {
    this.lastState = state
    this.clearIdle()
    this.ensure()
    this.send(`state ${state}`)
    this.send('show')
  }

  /** Esconde o indicador e agenda o encerramento do processo caso fique parado. */
  hide(): void {
    this.lastState = 'idle'
    this.send('state idle')
    this.send('hide')
    this.clearIdle()
    this.idleTimer = setTimeout(() => this.stop('sem uso'), IDLE_QUIT_MS)
  }

  stop(reason: string): void {
    this.clearIdle()
    const c = this.child
    if (!c) return
    this.child = null
    this.log('info', `indicador: encerrando o processo separado (${reason})`)
    try {
      c.stdin?.write('quit\n')
      c.stdin?.end()
    } catch {
      // já fechou
    }
    // se não sair sozinho, força
    setTimeout(() => {
      try {
        c.kill('SIGTERM')
      } catch {
        // já saiu
      }
    }, 2000).unref()
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private send(line: string): void {
    try {
      this.child?.stdin?.write(line + '\n')
    } catch {
      // o processo caiu: o evento 'exit' cuida disso
    }
  }

  private ensure(): void {
    if (this.child) return
    const env = { ...process.env, [OVERLAY_PROC_ENV]: '1' }
    delete env['ELECTRON_RUN_AS_NODE']
    // X11 só neste processo; o app principal continua em Wayland nativo
    const args = ['--ozone-platform=x11', '--no-sandbox', app.getAppPath()]
    const started = Date.now()
    const c = spawn(process.execPath, args, { env, stdio: ['pipe', 'ignore', 'pipe'] })
    this.child = c
    this.log('info', `indicador: abrindo o processo separado em XWayland (pid ${c.pid})`)
    c.stderr?.on('data', (d: Buffer) => {
      const t = d.toString().trim()
      if (t && /error|fatal|cannot|failed/i.test(t)) this.log('warn', `indicador (processo): ${t.slice(0, 300)}`)
    })
    c.stdin?.on('error', () => {})
    c.on('error', (e) => {
      this.log('error', `indicador: não foi possível abrir o processo separado: ${e.message}`)
    })
    c.on('exit', (code, signal) => {
      if (this.child !== c) return // encerrado de propósito
      this.child = null
      this.clearIdle()
      const quick = Date.now() - started < 5000
      this.log(quick ? 'error' : 'warn', `indicador: processo separado saiu (código ${code ?? signal})`)
      if (quick && ++this.failures >= 2) {
        this.log('error', 'indicador: o processo separado não abre; usando a janela comum')
        this.onUnavailable()
        return
      }
      // caiu no meio do uso: reabre se o indicador ainda deveria estar visível
      if (this.lastState !== 'idle') this.show(this.lastState)
    })
  }
}

// ---------------------------------------------------------------------------
// Lado do processo do indicador
// ---------------------------------------------------------------------------

function placeOverlay(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const { x, y, width } = display.workArea
  win.setBounds({ x: x + width - OVERLAY_W - MARGIN, y: y + MARGIN, width: OVERLAY_W, height: OVERLAY_H })
}

export function runOverlayProcess(): void {
  // sem trava de instância única (o app principal já tem a dele) e com pasta de dados própria
  app.setPath('userData', `${app.getPath('userData')}-overlay`)
  if (app.dock) app.dock.hide()

  let win: BrowserWindow | null = null
  let wantVisible = false
  let pendingState = 'idle'
  let loaded = false

  const applyVisibility = (): void => {
    if (!win || win.isDestroyed()) return
    if (wantVisible) {
      placeOverlay(win)
      win.setAlwaysOnTop(true)
      win.showInactive()
      // o gerenciador só aceita "sempre por cima" com a janela já mapeada: reaplica depois de mostrar
      win.setAlwaysOnTop(true)
      placeOverlay(win)
      setTimeout(() => {
        if (!win || win.isDestroyed()) return
        win.setAlwaysOnTop(true)
        placeOverlay(win)
      }, 50)
    } else {
      win.hide()
    }
  }
  const pushState = (): void => {
    if (win && loaded && !win.isDestroyed()) win.webContents.send('overlay:set-state', pendingState)
  }

  const createWindow = (): void => {
    win = new BrowserWindow({
      width: OVERLAY_W,
      height: OVERLAY_H,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      type: 'notification',
      show: false,
      backgroundColor: '#00000000',
      hasShadow: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false,
        contextIsolation: true,
        backgroundThrottling: false
      }
    })
    win.setIgnoreMouseEvents(true)
    win.webContents.on('did-finish-load', () => {
      loaded = true
      pushState()
    })
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      void win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/overlay.html')
    } else {
      void win.loadFile(join(__dirname, '../renderer/overlay.html'))
    }
    applyVisibility()
  }

  app.on('window-all-closed', () => {})
  void app.whenReady().then(() => {
    createWindow()
    const rl = createInterface({ input: process.stdin })
    rl.on('line', (line) => {
      const [cmd, arg] = line.trim().split(' ')
      if (cmd === 'show') {
        wantVisible = true
        applyVisibility()
      } else if (cmd === 'hide') {
        wantVisible = false
        applyVisibility()
      } else if (cmd === 'state') {
        pendingState = arg || 'idle'
        pushState()
      } else if (cmd === 'quit') {
        app.quit()
      }
    })
    // o app principal fechou (ou caiu): este processo não fica órfão
    rl.on('close', () => app.quit())
  })
}
