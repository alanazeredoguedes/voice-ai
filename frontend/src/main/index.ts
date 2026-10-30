import { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { spawn, ChildProcess } from 'child_process'

const BACKEND_PORT = 18450
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`

let mainWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let tray: Tray | null = null
let backendProcess: ChildProcess | null = null
let quitting = false
let overlayHideTimer: ReturnType<typeof setTimeout> | null = null

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

function spawnBackend(): void {
  // __dirname in dev = <repo>/frontend/out/main — 3 levels up reaches repo root
  const root = join(__dirname, '..', '..', '..')
  const python = join(root, 'backend', 'venv', 'bin', 'python')
  const args = ['-m', 'backend.main']

  backendProcess = spawn(python, args, {
    cwd: root,
    env: { ...process.env, VOICE_AI_PORT: String(BACKEND_PORT) },
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

async function waitForBackend(maxMs = 15000): Promise<void> {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BACKEND_URL}/health`)
      if (res.ok) return
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('Backend did not start in time')
}

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
    // hide to tray instead of closing; app.quit() is the only real exit path
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

  // Janela pequena, apenas do tamanho da pill de status
  const win = new BrowserWindow({
    width: 180,
    height: 36,
    x: width - 196,
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
      contextIsolation: true
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

// 16x16 indigo PNG icon generated from solid #6366f1
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
    console.error('[tray] failed to create tray:', e)
    return
  }

  tray.setToolTip('Voice AI')

  const menu = Menu.buildFromTemplate([
    {
      label: 'Abrir',
      click: () => {
        mainWindow?.show()
        mainWindow?.focus()
      }
    },
    { type: 'separator' },
    {
      label: 'Sair',
      click: () => {
        tray = null
        app.quit()
      }
    }
  ])

  tray.setContextMenu(menu)
  tray.on('click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
  tray.on('double-click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.voiceai')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  if (!(await isBackendUp())) {
    spawnBackend()
  }
  await waitForBackend()

  mainWindow = createMainWindow()
  overlayWindow = createOverlayWindow()
  createTray()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow()
    } else {
      mainWindow?.show()
    }
  })
})

app.on('window-all-closed', () => {
  // keep running in tray — don't quit
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
