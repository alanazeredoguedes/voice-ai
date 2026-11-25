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
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { flushSysLogToFile, sysLog } from './sysLog'
import { importUpdateWindowLog, launchUpdateWindow } from './updateWindow'

/** Categoria de todos os logs desta parte: na aba Logs, filtre por "atualização". */
const CAT = 'atualização'

export type UpdateState =
  | { status: 'unsupported'; version: string }
  | { status: 'idle'; version: string }
  | { status: 'checking'; version: string }
  | { status: 'available'; version: string; newVersion: string; notes: string; error?: string }
  | { status: 'downloading'; version: string; newVersion: string; percent: number }
  | { status: 'ready'; version: string; newVersion: string }
  | { status: 'error'; version: string; message: string }

const CHECK_EVERY_MS = 60 * 60 * 1000 // de hora em hora, enquanto o app ficar aberto
const FIRST_CHECK_DELAY_MS = 15 * 1000 // não disputa CPU/rede com a abertura do app

let state: UpdateState = { status: 'idle', version: app.getVersion() }
let getWindow: () => BrowserWindow | null = () => null
let newVersion = ''
// Linux: caminho do AppImage que será aberto de novo (muda de nome quando a versão faz parte dele)
let appImagePath = process.env['APPIMAGE'] ?? ''
let notes = ''
let started = false
// último % já escrito no log do download (de 10 em 10); volta a -1 a cada novo download
let lastLoggedPercent = -1

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

/** Anotação feita antes de reiniciar para instalar: na abertura seguinte, mostra se a atualização foi aplicada. */
function pendingFile(): string {
  return join(app.getPath('userData'), 'update-pending.json')
}

/** Abertura seguinte a uma atualização: registra no log se a versão realmente mudou (o instalador roda fora do app). */
function reportPreviousUpdate(): void {
  // o que a janela de progresso registrou durante a instalação (etapas e tempos)
  importUpdateWindowLog()
  const file = pendingFile()
  if (!existsSync(file)) return
  try {
    const p = JSON.parse(readFileSync(file, 'utf8')) as { from?: string; to?: string; at?: string }
    const now = app.getVersion()
    if (p.to && now === p.to) {
      sysLog('info', CAT, `atualização concluída: ${p.from} -> ${now} (instalação pedida em ${p.at})`)
    } else {
      sysLog(
        'error',
        CAT,
        `a atualização ${p.from} -> ${p.to} (pedida em ${p.at}) NÃO foi aplicada: o app abriu na versão ${now}. ` +
          'O instalador pode ter falhado (arquivo em uso, falta de permissão ou instalação interrompida).'
      )
    }
  } catch (e) {
    sysLog('warn', CAT, `não consegui ler o registro da atualização anterior: ${e instanceof Error ? e.message : e}`)
  }
  rmSync(file, { force: true })
}

async function check(manual: boolean): Promise<void> {
  const origin = manual ? 'manual' : 'automática'
  if (!supported()) {
    if (manual) sysLog('info', CAT, 'verificação manual ignorada: atualização não se aplica a esta execução')
    return
  }
  // não interrompe um download em andamento nem uma atualização já baixada. Com uma versão já anunciada
  // ("available") também não: trocar o estado para "verificando" faria o aviso sumir por uns segundos, e um clique
  // em "Atualizar" nessa janela seria ignorado.
  if (state.status === 'checking' || state.status === 'downloading' || state.status === 'ready' || state.status === 'available') {
    sysLog('info', CAT, `verificação ${origin} ignorada: já está em "${state.status}"`)
    return
  }
  sysLog('info', CAT, `verificando atualização (${origin}); versão atual ${app.getVersion()}`)
  setState({ status: 'checking', version: app.getVersion() })
  try {
    const result = await autoUpdater.checkForUpdates()
    // sem versão nova: o evento 'update-not-available' devolve o estado para 'idle'
    if (!result) setState({ status: 'idle', version: app.getVersion() })
  } catch (e) {
    const message = e instanceof Error ? e.message.split('\n')[0].slice(0, 200) : String(e)
    sysLog('warn', CAT, `falha ao verificar (${origin}): ${message}`)
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
async function installNow(): Promise<void> {
  sysLog('info', CAT, `iniciando a instalação da versão ${newVersion} (${process.platform}${process.platform === 'linux' ? `, AppImage ${appImagePath}` : ''}): o app vai fechar e reabrir`)
  try {
    writeFileSync(pendingFile(), JSON.stringify({ from: app.getVersion(), to: newVersion, at: new Date().toISOString() }))
  } catch (e) {
    sysLog('warn', CAT, `não consegui gravar o registro da atualização: ${e instanceof Error ? e.message : e}`)
  }
  if (process.platform === 'win32') {
    // o instalador roda ~1 min com o app fechado: a janela de progresso assume antes de o app fechar
    await launchUpdateWindow(app.getVersion(), newVersion)
  } else if (process.platform === 'linux') {
    // no Linux a troca é quase instantânea: só dá tempo de a mensagem "vai reiniciar" aparecer
    await new Promise((r) => setTimeout(r, 1500))
  }
  // o backend fecha junto com o app: grava já o que ainda está na fila para não perder estas linhas
  flushSysLogToFile()
  try {
    if (process.platform === 'linux') {
      app.relaunch({ execPath: appImagePath, args: [] })
      autoUpdater.quitAndInstall(true, false)
    } else {
      autoUpdater.quitAndInstall(true, true)
    }
  } catch (e) {
    sysLog('error', CAT, `falha ao iniciar a instalação: ${e instanceof Error ? e.stack ?? e.message : e}`)
    flushSysLogToFile()
  }
}

export function initUpdater(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter
  if (started) return
  started = true

  ipcMain.handle('update:state', () => state)
  ipcMain.handle('update:check', () => check(true))
  ipcMain.handle('update:download', async () => {
    if (state.status !== 'available') {
      sysLog('warn', CAT, `download pedido, mas o estado é "${state.status}": ignorado`)
      return
    }
    sysLog('info', CAT, `iniciando o download da versão ${newVersion}`)
    lastLoggedPercent = -1
    setState({ status: 'downloading', version: app.getVersion(), newVersion, percent: 0 })
    try {
      await autoUpdater.downloadUpdate()
    } catch (e) {
      const message = e instanceof Error ? e.message.split('\n')[0].slice(0, 200) : String(e)
      sysLog('error', CAT, `falha ao baixar a versão ${newVersion}: ${e instanceof Error ? e.stack ?? message : message}`)
      // volta ao aviso (com o motivo) para o usuário poder tentar de novo
      setState({ status: 'available', version: app.getVersion(), newVersion, notes, error: message })
    }
  })

  reportPreviousUpdate()

  if (!supported()) {
    state = { status: 'unsupported', version: app.getVersion() }
    const why = !app.isPackaged ? 'modo de desenvolvimento' : process.platform === 'linux' ? 'não está rodando como AppImage' : `sistema ${process.platform} sem suporte`
    sysLog('info', CAT, `atualização automática desligada: ${why}`)
    return
  }
  sysLog('info', CAT, `atualização automática ativa: versão ${app.getVersion()}, verifica a cada ${CHECK_EVERY_MS / 60000} min (primeira em ${FIRST_CHECK_DELAY_MS / 1000} s)`)

  autoUpdater.autoDownload = false // só baixa depois que o usuário confirma
  autoUpdater.autoInstallOnAppQuit = false // não instala por conta própria ao fechar: quem decide é o usuário
  autoUpdater.allowPrerelease = false
  autoUpdater.logger = {
    info: (m) => sysLog('info', CAT, String(m)),
    warn: (m) => sysLog('warn', CAT, String(m)),
    error: (m) => sysLog('error', CAT, String(m)),
    debug: () => {}
  }

  autoUpdater.on('update-available', (info) => {
    newVersion = info.version
    notes = releaseNotesText(info.releaseNotes)
    sysLog('info', CAT, `nova versão disponível: ${newVersion} (atual ${app.getVersion()})`)
    setState({ status: 'available', version: app.getVersion(), newVersion, notes })
  })
  autoUpdater.on('update-not-available', (info) => {
    sysLog('info', CAT, `sem versão nova (a mais recente publicada é a ${info?.version ?? '?'})`)
    setState({ status: 'idle', version: app.getVersion() })
  })
  autoUpdater.on('download-progress', (p) => {
    const percent = Math.round(p.percent)
    // no log, de 10 em 10 % (a interface recebe todos)
    if (percent >= lastLoggedPercent + 10 || percent === 100) {
      lastLoggedPercent = percent
      sysLog('info', CAT, `baixando ${newVersion}: ${percent}% (${(p.transferred / 1048576).toFixed(1)} de ${(p.total / 1048576).toFixed(1)} MB, ${(p.bytesPerSecond / 1048576).toFixed(1)} MB/s)`)
    }
    setState({ status: 'downloading', version: app.getVersion(), newVersion, percent })
  })
  // sem um listener de 'error' o EventEmitter lança exceção; a falha em si já é tratada nos catch acima
  autoUpdater.on('error', (e) => sysLog('error', CAT, `erro do updater: ${e?.message ?? e}`))
  autoUpdater.on('appimage-filename-updated', (path: string) => {
    appImagePath = path
  })
  autoUpdater.on('update-downloaded', () => {
    sysLog('info', CAT, `versão ${newVersion} baixada, pronta para instalar`)
    setState({ status: 'ready', version: app.getVersion(), newVersion })
    // o usuário já confirmou ao clicar em atualizar: segue direto para a instalação
    void installNow()
  })

  setTimeout(() => void check(false), FIRST_CHECK_DELAY_MS)
  setInterval(() => void check(false), CHECK_EVERY_MS)
}
