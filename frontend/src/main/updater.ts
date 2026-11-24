/**
 * Atualização automática (electron-updater + GitHub Releases).
 *
 * Fluxo: o app consulta a última release → avisa "nova versão" → o usuário confirma → baixa (com progresso) →
 * reinicia e instala por cima (Windows: instalador NSIS em modo silencioso; Linux: troca o próprio AppImage).
 * As bibliotecas Python novas NÃO são tratadas aqui: ao abrir a versão nova, o setup do app (modo "update") já
 * compara os requirements e baixa só o que falta (ver getSetupMode em index.ts).
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import { sysLog } from './sysLog'

export type UpdateState =
  | { status: 'unsupported'; version: string }
  | { status: 'idle'; version: string }
  | { status: 'checking'; version: string }
  | { status: 'available'; version: string; newVersion: string; notes: string; error?: string }
  | { status: 'downloading'; version: string; newVersion: string; percent: number }
  | { status: 'ready'; version: string; newVersion: string }
  | { status: 'error'; version: string; message: string }

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000 // de 4 em 4 horas, enquanto o app ficar aberto
const FIRST_CHECK_DELAY_MS = 15 * 1000 // não disputa CPU/rede com a abertura do app

let state: UpdateState = { status: 'idle', version: app.getVersion() }
let getWindow: () => BrowserWindow | null = () => null
let newVersion = ''
// Linux: caminho do AppImage que será aberto de novo (muda de nome quando a versão faz parte dele)
let appImagePath = process.env['APPIMAGE'] ?? ''
let notes = ''
let started = false

/** Só o app instalado atualiza: em desenvolvimento não há o que trocar, e no Linux só o AppImage consegue. */
function supported(): boolean {
  if (!app.isPackaged) return false
  if (process.platform === 'linux') return !!process.env['APPIMAGE']
  return process.platform === 'win32'
}

function setState(next: UpdateState): void {
  state = next
  const win = getWindow()
  if (win && !win.isDestroyed()) win.webContents.send('update:state', state)
}

function releaseNotesText(raw: unknown): string {
  if (typeof raw === 'string') return raw.replace(/<[^>]+>/g, '').trim().slice(0, 2000)
  if (Array.isArray(raw)) {
    return raw
      .map((n) => (n && typeof n === 'object' && 'note' in n ? String((n as { note?: unknown }).note ?? '') : ''))
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .trim()
      .slice(0, 2000)
  }
  return ''
}

async function check(manual: boolean): Promise<void> {
  if (!supported()) return
  // não interrompe um download em andamento nem uma atualização já baixada
  if (state.status === 'checking' || state.status === 'downloading' || state.status === 'ready') return
  setState({ status: 'checking', version: app.getVersion() })
  try {
    const result = await autoUpdater.checkForUpdates()
    // sem versão nova: o evento 'update-not-available' devolve o estado para 'idle'
    if (!result) setState({ status: 'idle', version: app.getVersion() })
  } catch (e) {
    const message = e instanceof Error ? e.message.split('\n')[0].slice(0, 200) : String(e)
    sysLog('warn', 'atualização', `falha ao verificar: ${message}`)
    // a verificação automática falha em silêncio (sem internet é normal); a manual mostra o motivo
    setState(manual ? { status: 'error', version: app.getVersion(), message } : { status: 'idle', version: app.getVersion() })
  }
}

/**
 * Reinicia e instala. Windows: o instalador silencioso espera o app fechar e abre a versão nova ao terminar.
 * Linux: o electron-updater troca o AppImage e abriria a versão nova NA HORA, com a antiga ainda aberta (segurando
 * a trava de instância única e a porta do backend): a nova fecharia sozinha. Por isso ele só troca o arquivo
 * e é o app.relaunch() que abre a nova depois que esta sair.
 */
function installNow(): void {
  sysLog('info', 'atualização', `reiniciando para instalar a versão ${newVersion}`)
  if (process.platform === 'linux') {
    app.relaunch({ execPath: appImagePath, args: [] })
    autoUpdater.quitAndInstall(true, false)
  } else {
    autoUpdater.quitAndInstall(true, true)
  }
}

export function initUpdater(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter
  if (started) return
  started = true

  ipcMain.handle('update:state', () => state)
  ipcMain.handle('update:check', () => check(true))
  ipcMain.handle('update:download', async () => {
    if (state.status !== 'available') return
    setState({ status: 'downloading', version: app.getVersion(), newVersion, percent: 0 })
    try {
      await autoUpdater.downloadUpdate()
    } catch (e) {
      const message = e instanceof Error ? e.message.split('\n')[0].slice(0, 200) : String(e)
      sysLog('error', 'atualização', `falha ao baixar: ${message}`)
      // volta ao aviso (com o motivo) para o usuário poder tentar de novo
      setState({ status: 'available', version: app.getVersion(), newVersion, notes, error: message })
    }
  })

  if (!supported()) {
    state = { status: 'unsupported', version: app.getVersion() }
    return
  }

  autoUpdater.autoDownload = false // só baixa depois que o usuário confirma
  autoUpdater.autoInstallOnAppQuit = false // não instala por conta própria ao fechar: quem decide é o usuário
  autoUpdater.allowPrerelease = false
  autoUpdater.logger = {
    info: (m) => sysLog('info', 'atualização', String(m)),
    warn: (m) => sysLog('warn', 'atualização', String(m)),
    error: (m) => sysLog('error', 'atualização', String(m)),
    debug: () => {}
  }

  autoUpdater.on('update-available', (info) => {
    newVersion = info.version
    notes = releaseNotesText(info.releaseNotes)
    sysLog('info', 'atualização', `nova versão disponível: ${newVersion} (atual ${app.getVersion()})`)
    setState({ status: 'available', version: app.getVersion(), newVersion, notes })
  })
  autoUpdater.on('update-not-available', () => setState({ status: 'idle', version: app.getVersion() }))
  autoUpdater.on('download-progress', (p) =>
    setState({ status: 'downloading', version: app.getVersion(), newVersion, percent: Math.round(p.percent) })
  )
  // sem um listener de 'error' o EventEmitter lança exceção; a falha em si já é tratada nos catch acima
  autoUpdater.on('error', (e) => sysLog('error', 'atualização', `erro do updater: ${e?.message ?? e}`))
  autoUpdater.on('appimage-filename-updated', (path: string) => {
    appImagePath = path
  })
  autoUpdater.on('update-downloaded', () => {
    sysLog('info', 'atualização', `versão ${newVersion} baixada, pronta para instalar`)
    setState({ status: 'ready', version: app.getVersion(), newVersion })
    // o usuário já confirmou ao clicar em atualizar: segue direto para a instalação
    installNow()
  })

  setTimeout(() => void check(false), FIRST_CHECK_DELAY_MS)
  setInterval(() => void check(false), CHECK_EVERY_MS)
}
