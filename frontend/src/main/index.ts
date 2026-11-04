import { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain } from 'electron'

// Must be called before app is ready — fixes SUID sandbox error on Linux AppImage
app.commandLine.appendSwitch('no-sandbox')
import { join } from 'path'
import { homedir } from 'os'
import { existsSync, writeFileSync, mkdirSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { spawn, ChildProcess, SpawnOptions } from 'child_process'

const BACKEND_PORT = 18450
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`

let mainWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let tray: Tray | null = null
let backendProcess: ChildProcess | null = null
let quitting = false
let overlayHideTimer: ReturnType<typeof setTimeout> | null = null

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function getDataDir(): string {
  if (app.isPackaged) return app.getPath('userData')
  return join(homedir(), '.local', 'share', 'voice-ai')
}

function getPackagesDir(): string {
  return join(getDataDir(), 'packages')
}

function getBundledPython(): string {
  if (!app.isPackaged) {
    return join(__dirname, '..', '..', '..', 'backend', 'venv', 'bin', 'python')
  }
  // Resolved fresh every run — no symlinks, always correct mount path
  return join(process.resourcesPath, 'python-dist', 'bin', 'python3')
}

function getBackendCwd(): string {
  if (!app.isPackaged) return join(__dirname, '..', '..', '..')
  return process.resourcesPath
}

// ---------------------------------------------------------------------------
// Setup state
// ---------------------------------------------------------------------------

function isSetupComplete(): boolean {
  if (!app.isPackaged) return true
  return existsSync(join(getPackagesDir(), '.voice-ai-ready'))
}

function markSetupComplete(): void {
  const dir = getPackagesDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.voice-ai-ready'), new Date().toISOString())
}

// ---------------------------------------------------------------------------
// Setup runner
// ---------------------------------------------------------------------------

interface SetupProgress {
  step: string
  message: string
  percent: number
  log?: string
}

function runCmd(
  bin: string,
  args: string[],
  opts: SpawnOptions,
  onLog: (line: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    onLog(`$ ${bin} ${args.join(' ')}`)
    const errorLines: string[] = []
    const proc = spawn(bin, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] })
    proc.stdout?.on('data', (d: Buffer) => {
      for (const line of d.toString().split('\n')) {
        const t = line.trim()
        if (t) onLog(t)
      }
    })
    proc.stderr?.on('data', (d: Buffer) => {
      for (const line of d.toString().split('\n')) {
        const t = line.trim()
        if (t) { onLog(t); errorLines.push(t) }
      }
    })
    proc.on('error', (err) => reject(new Error(`Failed to start ${bin}: ${err.message}`)))
    proc.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        const detail = errorLines.slice(-5).join(' | ')
        reject(new Error(`exit ${code}${detail ? ': ' + detail : ''}`))
      }
    })
  })
}

async function runSetup(onProgress: (p: SetupProgress) => void): Promise<void> {
  const bundledPython = getBundledPython()
  const packagesDir = getPackagesDir()
  const requirementsPath = app.isPackaged
    ? join(process.resourcesPath, 'backend', 'requirements.txt')
    : join(__dirname, '..', '..', '..', 'backend', 'requirements.txt')
  const log = (line: string) => line && onProgress({ step: 'log', message: '', percent: -1, log: line })

  log(`[setup] bundled python: ${bundledPython}`)
  log(`[setup] packages dir: ${packagesDir}`)
  log(`[setup] requirements: ${requirementsPath}`)

  if (!existsSync(bundledPython)) {
    throw new Error(`Python nao encontrado em: ${bundledPython}`)
  }

  mkdirSync(packagesDir, { recursive: true })

  // Use gcc as fallback compiler — python-build-standalone was compiled with clang
  // which may not be installed on the user's system, but gcc usually is
  const pipEnv = { ...process.env, CC: 'gcc', CXX: 'g++' }

  onProgress({ step: 'pip', message: 'Atualizando pip...', percent: 5 })
  await runCmd(
    bundledPython,
    ['-m', 'pip', 'install', '--upgrade', 'pip', '--quiet', '--target', packagesDir],
    { env: pipEnv },
    log
  )

  onProgress({ step: 'pip', message: 'Instalando dependencias (pode demorar alguns minutos)...', percent: 10 })
  await runCmd(
    bundledPython,
    ['-m', 'pip', 'install', '-r', requirementsPath, '--target', packagesDir, '--no-cache-dir', '--progress-bar', 'off'],
    { env: pipEnv },
    (line) => {
      log(line)
      if (line.startsWith('Collecting') || line.startsWith('Installing')) {
        const pkg = line.replace(/^(Collecting|Installing collected packages:)\s*/, '').split(/[\s,]/)[0]
        if (pkg) onProgress({ step: 'pip', message: `Baixando ${pkg}...`, percent: -1 })
      }
    }
  )

  onProgress({ step: 'model', message: 'Baixando modelo Whisper tiny (~75 MB)...', percent: 82 })
  await runCmd(
    bundledPython,
    [
      '-c',
      [
        'import os, sys',
        `sys.path.insert(0, ${JSON.stringify(packagesDir)})`,
        "os.environ['HF_HUB_DISABLE_PROGRESS_BARS'] = '0'",
        'from huggingface_hub import snapshot_download',
        "snapshot_download('Systran/faster-whisper-tiny')",
        "print('Modelo baixado com sucesso')"
      ].join('; ')
    ],
    {},
    log
  )

  markSetupComplete()
  onProgress({ step: 'done', message: 'Instalacao concluida!', percent: 100 })
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

function spawnBackend(): void {
  const python = getBundledPython()
  const cwd = getBackendCwd()
  const packagesDir = getPackagesDir()
  const existingPythonPath = process.env['PYTHONPATH'] || ''
  const env = {
    ...process.env,
    VOICE_AI_PORT: String(BACKEND_PORT),
    VOICE_AI_DATA_DIR: getDataDir(),
    PYTHONPATH: existingPythonPath ? `${packagesDir}:${existingPythonPath}` : packagesDir
  }
  console.log(`[backend] python: ${python}  cwd: ${cwd}  data: ${getDataDir()}  packages: ${packagesDir}`)

  backendProcess = spawn(python, ['-m', 'backend.main'], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  backendProcess.stdout?.on('data', (d) => process.stdout.write(`[backend] ${d}`))
  backendProcess.stderr?.on('data', (d) => process.stderr.write(`[backend] ${d}`))
  backendProcess.on('exit', (code) => {
    console.log(`[backend] exited with code ${code}`)
    backendProcess = null
  })
}

async function isBackendUp(): Promise<boolean> {
  try {
    const res = await fetch(`${BACKEND_URL}/health`)
    return res.ok
  } catch {
    return false
  }
}

async function waitForBackend(maxMs = 30000): Promise<void> {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BACKEND_URL}/health`)
      if (res.ok) return
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error('Backend did not start in time')
}

// ---------------------------------------------------------------------------
// IPC — overlay state
// ---------------------------------------------------------------------------

ipcMain.on('overlay:state', (_, state: string) => {
  if (!overlayWindow) return
  if (overlayHideTimer) {
    clearTimeout(overlayHideTimer)
    overlayHideTimer = null
  }
  if (state === 'idle') {
    overlayHideTimer = setTimeout(() => {
      overlayWindow?.hide()
      overlayHideTimer = null
    }, 2000)
  } else {
    overlayWindow.show()
  }
})

// ---------------------------------------------------------------------------
// IPC — setup
// ---------------------------------------------------------------------------

ipcMain.handle('setup:check', () => ({ required: !isSetupComplete() }))

ipcMain.handle('setup:start', async (event) => {
  try {
    await runSetup((progress) => event.sender.send('setup:progress', progress))
    spawnBackend()
    await waitForBackend()
    overlayWindow = createOverlayWindow()
    createTray()
    event.sender.send('setup:done', { success: true })
    return { success: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    event.sender.send('setup:done', { success: false, error: message })
    return { success: false, error: message }
  }
})

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 720,
    minHeight: 500,
    show: false,
    backgroundColor: '#0f172a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  win.on('ready-to-show', () => win.show())
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      win.hide()
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

function createOverlayWindow(): BrowserWindow {
  const { screen } = require('electron')
  const { width } = screen.getPrimaryDisplay().workAreaSize

  const win = new BrowserWindow({
    width: 220,
    height: 36,
    x: width - 236,
    y: 16,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
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

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/overlay.html')
  } else {
    win.loadFile(join(__dirname, '../renderer/overlay.html'))
  }
  return win
}

const TRAY_ICON_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGNITvtIEmIY1TCqYfhqAABsrLoQoM6bagAAAABJRU5ErkJggg=='

function createTray(): void {
  let icon: Electron.NativeImage
  try {
    icon = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_B64, 'base64'))
  } catch {
    icon = nativeImage.createEmpty()
  }
  try {
    tray = new Tray(icon)
  } catch (e) {
    console.error('[tray] failed:', e)
    return
  }
  tray.setToolTip('Voice AI')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir', click: () => { mainWindow?.show(); mainWindow?.focus() } },
      { type: 'separator' },
      { label: 'Sair', click: () => { tray = null; app.quit() } }
    ])
  )
  tray.on('click', () => { mainWindow?.show(); mainWindow?.focus() })
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus() })
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.voiceai')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  const setupNeeded = !isSetupComplete()

  if (!setupNeeded) {
    if (!(await isBackendUp())) spawnBackend()
    await waitForBackend()
    overlayWindow = createOverlayWindow()
    createTray()
  }

  mainWindow = createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow()
    else mainWindow?.show()
  })
})

app.on('window-all-closed', () => {
  // keep running in tray - don't quit
})

app.on('before-quit', () => {
  quitting = true
  tray?.destroy()
  tray = null
  if (backendProcess) {
    backendProcess.kill('SIGTERM')
    backendProcess = null
  }
})

export { mainWindow, overlayWindow, BACKEND_URL }
