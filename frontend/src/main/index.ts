import { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, session, screen, Notification, clipboard, ClipboardItem, net, dialog } from 'electron'

// Must be called before app is ready - fixes SUID sandbox error on Linux AppImage
if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox')
// Chamada: o áudio dos outros participantes toca sem exigir um clique antes
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
// Transmissão com a janela minimizada ou atrás de outras: o Chromium marca a tela do app como "em segundo
// plano" e baixa a prioridade dela; no Windows 11 ainda liga o modo de eficiência (EcoQoS), que em
// processadores Intel com núcleos de economia joga a captura e a compressão do vídeo para os núcleos lentos.
// Medido (Windows, 1080p60): janela minimizada ~30 fps, aberta ~56 fps. O app quase não trabalha quando está
// parado, então manter a prioridade normal não pesa.
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
if (process.platform === 'win32') {
  // a janela coberta por outras (não só minimizada) também conta como "escondida" no Windows
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,UseEcoQoSForBackgroundProcess')
}
import { join, delimiter, dirname } from 'path'
import { homedir, cpus } from 'os'
import { existsSync, writeFileSync, mkdirSync, readFileSync, readdirSync, rmSync, copyFileSync } from 'fs'
import { createHash } from 'crypto'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { spawn, ChildProcess, SpawnOptions } from 'child_process'
import { checkClaudeMonitoring, type MonitoringLevel, type MonitoringReport } from './claudeMonitoring'
import { setKeepOnTop, toggleWindowOnTop } from './windowToggle'
import { diag, initWindowDiag, watchWindow } from './windowDiag'
import { backendTail, initSysLog, sysLog } from './sysLog'
import { downloadCloudflared, findCloudflared, registerCallIpc } from './call'
import { friendsGoOffline, registerFriendsIpc } from './friends'
import { OVERLAY_PROC_ENV, OverlayProcessHost, overlayNeedsSeparateProcess, runOverlayProcess } from './overlayProcess'

// app instalado: 18450; dev: 18451 (os dois podem rodar juntos sem um usar o backend do outro)
const BACKEND_PORT = app.isPackaged ? 18450 : 18451
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`

let mainWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let tray: Tray | null = null
let backendProcess: ChildProcess | null = null
let quitting = false
let overlayHideTimer: ReturnType<typeof setTimeout> | null = null
// Esta mesma build também roda como o processo do indicador (ver overlayProcess.ts): nesse caso só ele sobe
const IS_OVERLAY_PROC = process.env[OVERLAY_PROC_ENV] === '1'
// Linux/Wayland: o indicador vive num processo próprio em XWayland (posição e "sempre por cima" funcionam lá)
let overlayHost: OverlayProcessHost | null = null

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

// O dev usa uma pasta própria do Electron (~/.config/voice-ai-dev, %APPDATA%\voice-ai-dev): apagar o app instalado
// para um teste limpo não mexe no dev, e os dois podem ficar abertos juntos (a trava de instância única também é por pasta).
// Precisa vir antes de qualquer uso de userData (inclusive requestSingleInstanceLock).
if (!app.isPackaged && !IS_OVERLAY_PROC) app.setPath('userData', join(app.getPath('appData'), 'voice-ai-dev'))

function getDataDir(): string {
  if (app.isPackaged) return app.getPath('userData')
  return join(homedir(), '.local', 'share', 'voice-ai')
}

/** Pastas de modelos (Whisper e tradução) desta instalação: dev e app instalado não compartilham downloads. */
function modelDirsEnv(): Record<string, string> {
  return {
    HF_HOME: join(getDataDir(), 'huggingface'),
    ARGOS_PACKAGES_DIR: join(getDataDir(), 'argos-translate', 'packages')
  }
}

/**
 * Pasta temporária da instalação DENTRO da pasta de dados: o pip monta uns 6 GB antes de copiar, e o /tmp
 * costuma ficar no disco do sistema (menor), enquanto a pasta de dados fica na home.
 */
function setupTmpDir(): string {
  return join(getDataDir(), 'tmp')
}

function setupTmpEnv(): Record<string, string> {
  mkdirSync(setupTmpDir(), { recursive: true })
  return { TMPDIR: setupTmpDir(), TEMP: setupTmpDir(), TMP: setupTmpDir() }
}

function getPackagesDir(): string {
  return join(getDataDir(), 'packages')
}

function getBundledPython(): string {
  const isWin = process.platform === 'win32'
  if (!app.isPackaged) {
    return isWin
      ? join(__dirname, '..', '..', '..', 'backend', 'venv', 'Scripts', 'python.exe')
      : join(__dirname, '..', '..', '..', 'backend', 'venv', 'bin', 'python')
  }
  // Resolved fresh every run - no symlinks, always correct mount path
  return isWin
    ? join(process.resourcesPath, 'python-dist', 'python.exe')
    : join(process.resourcesPath, 'python-dist', 'bin', 'python3')
}

/**
 * Bibliotecas Python que já vêm dentro do instalador (resources/python-packages): o build as instala lá,
 * então o app instalado abre sem baixar nada. Em desenvolvimento não existe (usa o venv).
 */
function getBundledPackagesDir(): string | null {
  if (!app.isPackaged) return null
  const dir = join(process.resourcesPath, 'python-packages')
  return existsSync(dir) ? dir : null
}

function getBackendCwd(): string {
  if (!app.isPackaged) return join(__dirname, '..', '..', '..')
  return process.resourcesPath
}

// ---------------------------------------------------------------------------
// Setup state
// ---------------------------------------------------------------------------

function getBackendFile(name: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'backend', name)
    : join(__dirname, '..', '..', '..', 'backend', name)
}

/** Ícone do Voice AI (janela e bandeja). Gerado por tools/make_icon.py; vazio se o arquivo não for achado. */
function appIcon(): Electron.NativeImage {
  try {
    return nativeImage.createFromPath(join(__dirname, '..', '..', 'resources', 'icon.png'))
  } catch {
    return nativeImage.createEmpty()
  }
}

/** Lista completa (núcleo + tradução). Sem bibliotecas embutidas (Linux), é ela que o setup instala. */
function getRequirementsPath(): string {
  return getBackendFile('requirements.txt')
}

/**
 * Pacotes que só a tradução precisa (argostranslate e o que ela puxa: torch, spacy...), gerados no build.
 * O instalador não os leva (pesam centenas de MB): o setup os baixa na primeira instalação.
 */
function getTranslateLockPath(): string | null {
  const p = getBackendFile('translate-lock.txt')
  return existsSync(p) ? p : null
}

/** Hash das listas de dependências: quando mudam (nova versão do app), o setup instala só o que falta. */
function requirementsHash(): string {
  try {
    const parts = ['requirements.txt', 'requirements-core.txt', 'translate-lock.txt'].map((f) => {
      try {
        return readFileSync(getBackendFile(f), 'utf8')
      } catch {
        return ''
      }
    })
    if (!parts[0]) return ''
    return createHash('sha256').update(parts.join('\n--\n')).digest('hex').slice(0, 16)
  } catch {
    return ''
  }
}

const SETUP_MARKER = '.voice-ai-ready'

type SetupMode = 'ok' | 'install' | 'update'

function getSetupMode(): SetupMode {
  if (!app.isPackaged) return 'ok'
  const marker = join(getPackagesDir(), SETUP_MARKER)
  if (!existsSync(marker)) return 'install'
  let hash = ''
  let cloudflaredDone = false
  try {
    const info = JSON.parse(readFileSync(marker, 'utf8'))
    hash = info.hash ?? ''
    cloudflaredDone = !!info.cloudflared
  } catch {
    // marcador antigo (só a data): instalação feita antes da checagem por hash
  }
  // instalação anterior à aba de Chamada: passa pelo setup uma vez para baixar o cloudflared
  if (!cloudflaredDone && !findCloudflared(getDataDir())) return 'update'
  return hash && hash === requirementsHash() ? 'ok' : 'update'
}

function isSetupComplete(): boolean {
  return getSetupMode() === 'ok'
}

function markSetupComplete(): void {
  const dir = getPackagesDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, SETUP_MARKER),
    // cloudflared: true = o download já foi tentado (se falhou, a aba de Chamada baixa na primeira sala)
    JSON.stringify({ hash: requirementsHash(), cloudflared: true, installedAt: new Date().toISOString() })
  )
}

// ---------------------------------------------------------------------------
// Setup runner
// ---------------------------------------------------------------------------

type ItemStatus = 'pending' | 'running' | 'done' | 'skipped' | 'error'

interface SetupProgress {
  step: string // log | pip | model | progress | task | item | done
  message: string
  percent: number
  log?: string
  // checklist: etapa (task) e pacotes baixados dentro dela (item)
  task?: string
  status?: ItemStatus
  detail?: string
  item?: string
  label?: string
  notable?: boolean
  size?: string
}

type ProgressFn = (p: SetupProgress) => void

/**
 * Roda um processo e entrega a saída LINHA A LINHA (stdout + stderr), já sem buffer:
 * - PYTHONUNBUFFERED: sem isso o Python acumula a saída do pip num pipe e as linhas
 *   chegavam todas de uma vez no final (a barra de progresso ficava parada);
 * - quebra também em "\r" (barras do tqdm/huggingface reescrevem a mesma linha);
 * - guarda o pedaço incompleto entre um chunk e outro.
 */
function runCmd(
  bin: string,
  args: string[],
  opts: SpawnOptions,
  onLine: (line: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    onLine(`$ ${bin} ${args.join(' ')}`)
    const errorLines: string[] = []
    const env = { ...(opts.env ?? process.env), ...modelDirsEnv(), ...setupTmpEnv(), PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }
    const proc = spawn(bin, args, { ...opts, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const attach = (stream: NodeJS.ReadableStream | null, isErr: boolean): void => {
      let pending = ''
      const emit = (raw: string): void => {
        const t = raw.trim()
        if (!t) return
        if (isErr) {
          errorLines.push(t)
          if (errorLines.length > 20) errorLines.shift()
        }
        onLine(t)
      }
      stream?.on('data', (d: Buffer) => {
        const parts = (pending + d.toString()).split(/\r\n|\r|\n/)
        pending = parts.pop() ?? ''
        parts.forEach(emit)
      })
      stream?.on('end', () => emit(pending))
    }
    attach(proc.stdout, false)
    attach(proc.stderr, true)
    proc.on('error', (err) => reject(new Error(`Failed to start ${bin}: ${err.message}`)))
    proc.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        const detail = errorLines.filter((l) => !/^Progress \d/.test(l)).slice(-5).join(' | ')
        reject(new Error(`exit ${code}${detail ? ': ' + detail : ''}`))
      }
    })
  })
}

/** Avança devagar em direção a `to` enquanto uma etapa sem progresso medível roda. */
function creep(from: number, to: number, message: string, onProgress: ProgressFn): () => void {
  let pct = from
  onProgress({ step: 'progress', message, percent: pct })
  const timer = setInterval(() => {
    pct += (to - pct) * 0.04
    onProgress({ step: 'progress', message, percent: pct })
  }, 1000)
  return () => clearInterval(timer)
}

function fmtMB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)
}

/** Nomes amigáveis dos pacotes que valem aparecer no checklist do setup. */
const NOTABLE_PACKAGES: Record<string, string> = {
  av: 'FFmpeg (decodificação de áudio/vídeo, via PyAV)',
  ctranslate2: 'Motor de transcrição (CTranslate2)',
  faster_whisper: 'Whisper (transcrição de voz)',
  torch: 'PyTorch (usado pela tradução offline)',
  argostranslate: 'Tradução offline (Argos Translate)',
  stanza: 'Stanza (processamento de idiomas)',
  spacy: 'spaCy (processamento de idiomas)',
  numpy: 'NumPy',
  onnxruntime: 'ONNX Runtime (detecção de voz)',
  edge_tts: 'Voz da IA (Edge TTS)',
  elevenlabs: 'Voz da IA (ElevenLabs)',
  sounddevice: 'Áudio do microfone/alto-falante',
  pysdl2_dll: 'Controles e gamepad (SDL2)',
  yt_dlp: 'Busca de vídeos (YouTube)',
  ddgs: 'Busca de imagens (DuckDuckGo)',
  fastapi: 'Servidor interno do app (FastAPI)',
  nvidia_cublas_cu12: 'NVIDIA cuBLAS (cálculo na GPU)',
  nvidia_cudnn_cu12: 'NVIDIA cuDNN (redes neurais na GPU)',
  nvidia_cuda_nvrtc_cu12: 'NVIDIA NVRTC',
  sympy: 'Matemática simbólica (usada pelo PyTorch)'
}

/**
 * `pip install` com progresso real entre `from` e `to` (%):
 * 10% resolvendo dependências → 75% baixando (pacote a pacote, por bytes) → 15% instalando.
 * Usa `--progress-bar raw`, que imprime "Progress <bytes> of <total>" por pedaço baixado.
 * Cada download também vira um item no checklist da etapa `task` (com nome amigável e tamanho).
 */
async function pipInstall(
  python: string,
  args: string[],
  from: number,
  to: number,
  label: string,
  task: string,
  onProgress: ProgressFn,
  log: (line: string) => void,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const span = to - from
  const collected = new Set<string>()
  let total = 0
  let index = 0
  let current = ''
  let currentKey = ''
  let stopCreep: (() => void) | null = null
  let lastSent = 0

  const send = (message: string, frac: number, force = false): void => {
    const now = Date.now()
    if (!force && now - lastSent < 150) return // no máximo ~7 atualizações/s
    lastSent = now
    onProgress({ step: 'pip', message, percent: from + span * Math.min(1, Math.max(0, frac)) })
  }
  const item = (key: string, size: string, status: ItemStatus): void => {
    onProgress({
      step: 'item', message: '', percent: -1, task,
      item: key, label: NOTABLE_PACKAGES[key] ?? key, notable: key in NOTABLE_PACKAGES, size, status
    })
  }
  const finishCurrent = (): void => {
    if (currentKey) item(currentKey, '', 'done')
    currentKey = ''
  }

  send(`${label}: verificando dependências...`, 0, true)
  try {
    await runCmd(
      python,
      ['-m', 'pip', ...args, '--no-cache-dir', '--progress-bar', 'raw', '--disable-pip-version-check'],
      { env },
      (line) => {
        let m: RegExpMatchArray | null
        if ((m = line.match(/^Progress (\d+) of (\d+)/))) {
          const done = Number(m[1])
          const size = Number(m[2])
          const fileFrac = size > 0 ? done / size : 0
          const overall = total > 0 ? (index - 1 + fileFrac) / total : fileFrac
          send(
            `Baixando ${current} - ${fmtMB(done)}/${fmtMB(size)} MB (${index}/${total})`,
            0.1 + 0.75 * overall,
            done === size
          )
          if (done === size) finishCurrent()
          return // não polui o log com milhares de linhas de progresso
        }
        log(line)
        if ((m = line.match(/^Collecting ([A-Za-z0-9_.\-]+)/))) {
          collected.add(m[1].toLowerCase())
          send(`${label}: verificando dependências (${collected.size})...`, 0.1 * (1 - Math.exp(-collected.size / 25)))
        } else if ((m = line.match(/^Downloading (\S+?) \(([\d.]+ ?[kMG]?B)\)/)) && !m[1].endsWith('.metadata')) {
          finishCurrent()
          index++
          total = Math.max(total, collected.size, index)
          current = m[1].split('-')[0]
          currentKey = current.toLowerCase().replace(/[-.]/g, '_')
          item(currentKey, m[2], 'running')
          send(`Baixando ${current} (${m[2]}) - ${index}/${total}`, 0.1 + 0.75 * ((index - 1) / total), true)
        } else if (line.startsWith('Installing collected packages')) {
          finishCurrent()
          stopCreep = creep(from + span * 0.85, to - 0.5, `${label}: instalando pacotes (pode levar alguns minutos)...`, onProgress)
        }
      }
    )
  } finally {
    if (stopCreep) (stopCreep as () => void)()
  }
  finishCurrent()
  onProgress({ step: 'pip', message: `${label}: concluído`, percent: to })
}

/** Lista (linhas do arquivo de dependências, seguindo "-r outro.txt") o que ainda não está instalado nas pastas dadas. */
async function missingRequirements(python: string, packagesDirs: string[], requirementsPath: string): Promise<string[]> {
  const script = [
    'import sys, json, os',
    ...packagesDirs.map((d) => `sys.path.insert(0, ${JSON.stringify(d)})`),
    'from importlib.metadata import distribution, PackageNotFoundError',
    'from pip._vendor.packaging.requirements import Requirement',
    'def lines(path):',
    '    base = os.path.dirname(path)',
    '    for raw in open(path, encoding="utf-8"):',
    '        line = raw.split("#")[0].strip()',
    '        if not line: continue',
    '        if line.startswith("-r "):',
    '            yield from lines(os.path.join(base, line[3:].strip()))',
    '            continue',
    '        if line.startswith("-"): continue',
    '        yield line',
    'missing = []',
    `for line in lines(${JSON.stringify(requirementsPath)}):`,
    '    r = Requirement(line)',
    '    if r.marker and not r.marker.evaluate(): continue',
    '    try: v = distribution(r.name).version',
    '    except PackageNotFoundError: missing.append(line); continue',
    '    if r.specifier and not r.specifier.contains(v, prereleases=True): missing.append(line)',
    'print("MISSING=" + json.dumps(missing))'
  ].join('\n')
  let out: string[] = []
  await runCmd(python, ['-c', script], {}, (line) => {
    if (line.startsWith('MISSING=')) out = JSON.parse(line.slice(8))
  })
  return out
}

/** GPU NVIDIA presente? O driver instala nvcuda.dll no System32. Sem ela, não baixa as libs CUDA (~2 GB). */
function hasNvidiaGpu(): boolean {
  if (process.platform !== 'win32') return false
  return existsSync(join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'nvcuda.dll'))
}

// ---------------------------------------------------------------------------
// Claude Code (CLI usado pelo Chat IA)
// ---------------------------------------------------------------------------

/** Mesmo lugar onde o backend procura (backend/services/brain.py → _find_claude). */
function findClaude(): string | null {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const candidates = [join(homedir(), '.local', 'bin', exe)]
  for (const dir of (process.env['PATH'] || '').split(delimiter)) {
    if (dir) candidates.push(join(dir, exe))
  }
  return candidates.find((p) => existsSync(p)) ?? null
}

/** Instala o Claude Code pelo instalador oficial da Anthropic (não precisa de admin, Node nem Git). */
async function installClaudeCode(log: (line: string) => void): Promise<void> {
  if (process.platform === 'win32') {
    await runCmd(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex'],
      {},
      log
    )
  } else {
    await runCmd('bash', ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'], {}, log)
  }
}

interface ClaudeAccount {
  loggedIn: boolean
  email?: string
  orgName?: string
  plan?: string // pro | max | team | enterprise...
  authMethod?: string
}

/**
 * `claude auth status` (JSON): sai com 0 quando há login e diz em qual conta.
 * Os dados ficam só neste computador - vão direto para a tela de Configurações.
 */
function claudeAccount(bin: string): Promise<ClaudeAccount> {
  return new Promise((resolve) => {
    const env = { ...process.env }
    delete env['ANTHROPIC_API_KEY'] // queremos saber do login da conta, não de uma chave de API
    const proc = spawn(bin, ['auth', 'status'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env })
    let out = ''
    proc.stdout?.on('data', (d: Buffer) => (out += d.toString()))
    const timer = setTimeout(() => {
      proc.kill()
      resolve({ loggedIn: false })
    }, 20000)
    proc.on('error', () => {
      clearTimeout(timer)
      resolve({ loggedIn: false })
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      let info: Record<string, unknown> = {}
      try {
        info = JSON.parse(out)
      } catch {
        // versão antiga do CLI sem JSON: vale só o código de saída
      }
      resolve({
        loggedIn: code === 0,
        email: typeof info['email'] === 'string' ? info['email'] : undefined,
        orgName: typeof info['orgName'] === 'string' ? info['orgName'] : undefined,
        plan: typeof info['subscriptionType'] === 'string' ? info['subscriptionType'] : undefined,
        authMethod: typeof info['authMethod'] === 'string' ? info['authMethod'] : undefined
      })
    })
  })
}

/**
 * cuBLAS 12 / cuDNN 9 já instalados no sistema (CUDA Toolkit + cuDNN da NVIDIA)?
 * O driver da placa NÃO traz essas bibliotecas - só quem instalou o Toolkit as tem.
 * Se existirem, o setup não baixa os ~2 GB do pip (o backend acha as mesmas pastas;
 * ver speech_engine._register_nvidia_dll_dirs_windows).
 */
function systemCudaLibs(): { cublas: string; cudnn: string } | null {
  if (process.platform !== 'win32') return null
  const dirs = new Set<string>()
  for (const d of (process.env['PATH'] || '').split(delimiter)) if (d) dirs.add(d)
  if (process.env['CUDA_PATH']) dirs.add(join(process.env['CUDA_PATH'], 'bin'))
  const cudnnRoot = join(process.env['ProgramFiles'] || 'C:\\Program Files', 'NVIDIA', 'CUDNN')
  try {
    for (const v of readdirSync(cudnnRoot)) {
      const bin = join(cudnnRoot, v, 'bin')
      dirs.add(bin)
      try {
        for (const sub of readdirSync(bin)) dirs.add(join(bin, sub))
      } catch {
        /* sem subpastas */
      }
    }
  } catch {
    /* cuDNN não instalado */
  }
  let cublas = ''
  let cudnn = ''
  for (const d of dirs) {
    if (!cublas && existsSync(join(d, 'cublas64_12.dll'))) cublas = d
    if (!cudnn && existsSync(join(d, 'cudnn64_9.dll'))) cudnn = d
  }
  return cublas && cudnn ? { cublas, cudnn } : null
}

interface SetupOptions {
  /** Baixar as bibliotecas CUDA (~2 GB) quando houver GPU NVIDIA. */
  useGpu: boolean
}

async function runSetup(onProgress: ProgressFn, mode: SetupMode, opts: SetupOptions): Promise<void> {
  try {
    await runSetupSteps(onProgress, mode, opts)
  } finally {
    // sobras do pip (instalação interrompida, por exemplo) não ficam ocupando espaço
    rmSync(setupTmpDir(), { recursive: true, force: true })
  }
}

async function runSetupSteps(onProgress: ProgressFn, mode: SetupMode, opts: SetupOptions): Promise<void> {
  const bundledPython = getBundledPython()
  const packagesDir = getPackagesDir()
  const requirementsPath = getRequirementsPath()
  const log = (line: string): void => {
    if (line) onProgress({ step: 'log', message: '', percent: -1, log: line })
  }
  const task = (id: string, status: ItemStatus, detail = ''): void =>
    onProgress({ step: 'task', message: '', percent: -1, task: id, status, detail })

  log(`[setup] modo: ${mode}`)
  log(`[setup] bundled python: ${bundledPython}`)
  log(`[setup] packages dir: ${packagesDir}`)
  log(`[setup] requirements: ${requirementsPath}`)

  if (!existsSync(bundledPython)) {
    task('python', 'error', 'não encontrado')
    throw new Error(`Python nao encontrado em: ${bundledPython}`)
  }
  task('python', 'done', 'embutido no app')

  mkdirSync(packagesDir, { recursive: true })

  // Use gcc as fallback compiler - python-build-standalone was compiled with clang
  // which may not be installed on the user's system, but gcc usually is
  const pipEnv = { ...process.env, CC: 'gcc', CXX: 'g++' }
  const target = ['--target', packagesDir]

  const step = async (id: string, fn: () => Promise<string | void>): Promise<void> => {
    task(id, 'running')
    try {
      task(id, 'done', (await fn()) || '')
    } catch (e) {
      task(id, 'error', e instanceof Error ? e.message.slice(0, 120) : String(e))
      throw e
    }
  }

  if (mode === 'update') {
    // Nova versão do app: instala só o que falta/mudou, sem baixar tudo de novo
    await step('deps', async () => {
      onProgress({ step: 'pip', message: 'Verificando componentes...', percent: 3 })
      const bundled = getBundledPackagesDir()
      const dirs = [packagesDir, ...(bundled ? [bundled] : [])]
      const lock = bundled ? getTranslateLockPath() : null
      // com bibliotecas embutidas, o núcleo vem no app e a tradução tem lista própria; senão, tudo vem do requirements.txt
      const missing = await missingRequirements(bundledPython, dirs, bundled ? getBackendFile('requirements-core.txt') : requirementsPath)
      const missingTranslate = lock ? await missingRequirements(bundledPython, dirs, lock) : []
      log(`[setup] pacotes faltando: ${[...missing, ...missingTranslate].join(', ') || 'nenhum'}`)
      if (!missing.length && !missingTranslate.length) return 'já estava tudo instalado'
      if (missing.length) {
        await pipInstall(bundledPython, ['install', ...missing, ...target, '--upgrade'], 5, missingTranslate.length ? 20 : 85, 'Atualizando', 'deps', onProgress, log, pipEnv)
      }
      if (missingTranslate.length) {
        await pipInstall(bundledPython, ['install', '--no-deps', ...missingTranslate, ...target, '--upgrade'], missing.length ? 20 : 5, 85, 'Motor de tradução', 'deps', onProgress, log, pipEnv)
      }
      return `${missing.length + missingTranslate.length} componente(s) novo(s)`
    })
  } else {
    const gpu = hasNvidiaGpu()
    const sysCuda = gpu ? systemCudaLibs() : null
    const wantCuda = gpu && opts.useGpu && !sysCuda

    await step('deps', async () => {
      if (getBundledPackagesDir()) {
        // o núcleo (voz, transcrição, FFmpeg...) já vem dentro do app, instalado no build: nada para baixar
        log(`[setup] bibliotecas embutidas no app: ${getBundledPackagesDir()}`)
        onProgress({ step: 'pip', message: 'Componentes de voz já vêm dentro do app', percent: 3 })
        return 'já vêm dentro do app, sem baixar'
      }
      onProgress({ step: 'pip', message: 'Atualizando pip...', percent: 1 })
      await runCmd(bundledPython, ['-m', 'pip', 'install', '--upgrade', 'pip', '--quiet', ...target], { env: pipEnv }, log)
      await pipInstall(
        bundledPython,
        ['install', '-r', requirementsPath, ...target],
        3,
        wantCuda ? 55 : 80,
        'Componentes',
        'deps',
        onProgress,
        log,
        pipEnv
      )
      return ''
    })

    // motor de tradução (argostranslate + torch, spacy...): fica fora do instalador e é baixado aqui. Os IDIOMAS não: o usuário baixa na aba Traduzir
    if (getBundledPackagesDir()) {
      await step('translate', async () => {
        const lock = getTranslateLockPath()
        if (!lock) throw new Error('lista de pacotes da tradução não encontrada no app')
        await pipInstall(
          bundledPython,
          ['install', '--no-deps', '-r', lock, ...target],
          3,
          wantCuda ? 50 : 78,
          'Motor de tradução',
          'translate',
          onProgress,
          log,
          pipEnv
        )
        return ''
      })
    } else {
      task('translate', 'skipped', 'já incluso nos componentes acima')
    }

    if (!gpu) {
      task('cuda', 'skipped', 'sem placa NVIDIA - a transcrição usa o processador')
      log('[setup] nenhuma GPU NVIDIA detectada - pulando bibliotecas CUDA (o Whisper roda na CPU)')
    } else if (sysCuda) {
      task('cuda', 'done', 'usando o CUDA já instalado no computador')
      log(`[setup] CUDA do sistema: cuBLAS em ${sysCuda.cublas}, cuDNN em ${sysCuda.cudnn}`)
    } else if (!opts.useGpu) {
      task('cuda', 'skipped', 'desativado por você - a transcrição usa o processador')
    } else {
      // Windows + GPU NVIDIA: cuBLAS/cuDNN via pip para o Whisper usar a GPU (no Linux usa as libs do sistema)
      await step('cuda', async () => {
        await pipInstall(
          bundledPython,
          ['install', 'nvidia-cublas-cu12', 'nvidia-cudnn-cu12>=9,<10', ...target],
          55,
          80,
          'Aceleração NVIDIA',
          'cuda',
          onProgress,
          log,
          pipEnv
        )
      })
    }

    await step('model', async () => {
      onProgress({ step: 'model', message: 'Baixando modelo Whisper tiny (~75 MB)...', percent: 80 })
      let lastModelPct = -1
      await runCmd(
        bundledPython,
        [
          '-c',
          [
            'import os, sys',
            ...[getBundledPackagesDir(), packagesDir].filter(Boolean).map((d) => `sys.path.insert(0, ${JSON.stringify(d)})`),
            "os.environ['HF_HUB_DISABLE_PROGRESS_BARS'] = '0'",
            // Windows sem Modo Desenvolvedor não cria symlinks: o cache funciona igual, só avisa (aviso inofensivo)
            "os.environ['HF_HUB_DISABLE_SYMLINKS_WARNING'] = '1'",
            'from huggingface_hub import snapshot_download',
            "snapshot_download('Systran/faster-whisper-tiny')",
            "print('Modelo baixado com sucesso')"
          ].join('; ')
        ],
        {},
        (line) => {
          // barras do tqdm: "model.bin:  45%|████▌     | 34.0M/75.5M"
          const m = line.match(/(\d{1,3})%\|/)
          if (m) {
            const pct = Number(m[1])
            if (pct !== lastModelPct) {
              lastModelPct = pct
              onProgress({ step: 'model', message: `Baixando modelo Whisper tiny - ${pct}%`, percent: 80 + pct * 0.1 })
            }
            return
          }
          log(line)
        }
      )
      return '~75 MB'
    })
  }

  // cloudflared: túnel usado pela aba de Chamada (voz e compartilhamento de tela)
  if (findCloudflared(getDataDir())) {
    task('cloudflared', 'done', 'já estava instalado')
  } else {
    task('cloudflared', 'running')
    try {
      let lastSent = 0
      await downloadCloudflared(getDataDir(), (done, total) => {
        if (Date.now() - lastSent < 200 && done !== total) return
        lastSent = Date.now()
        onProgress({
          step: 'progress',
          message: `Baixando o componente de chamadas - ${fmtMB(done)}${total ? '/' + fmtMB(total) : ''} MB`,
          percent: 90
        })
      })
      task('cloudflared', 'done', 'instalado')
    } catch (e) {
      // Não bloqueia o resto do app: a aba de Chamada tenta de novo ao criar a primeira sala
      const msg = e instanceof Error ? e.message : String(e)
      log(`[setup] ERRO ao baixar o cloudflared: ${msg}`)
      task('cloudflared', 'error', 'falhou - será baixado ao criar a primeira sala')
    }
  }

  // Claude Code: o "cérebro" do Chat IA. Instala pelo instalador oficial se ainda não existir.
  if (findClaude()) {
    task('claude', 'done', 'já estava instalado')
    log(`[setup] Claude Code já instalado: ${findClaude()}`)
  } else {
    task('claude', 'running')
    const stop = creep(90, 98, 'Instalando o Claude Code (assistente de IA)...', onProgress)
    try {
      await installClaudeCode(log)
    } catch (e) {
      // Não bloqueia o resto do app (transcrição/tradução funcionam sem ele)
      log(`[setup] ERRO ao instalar o Claude Code: ${e instanceof Error ? e.message : e}`)
    } finally {
      stop()
    }
    const bin = findClaude()
    task('claude', bin ? 'done' : 'error', bin ? 'instalado' : 'falhou - veja os detalhes; o resto do app funciona')
    log(bin ? `[setup] Claude Code instalado: ${bin}` : '[setup] Claude Code não encontrado após a instalação')
  }

  markSetupComplete()
  onProgress({ step: 'done', message: 'Instalacao concluida!', percent: 100 })
}

// ---------------------------------------------------------------------------
// Iniciar com o sistema (Windows e Linux)
// ---------------------------------------------------------------------------

const IS_WIN = process.platform === 'win32'
const HIDDEN_ARG = '--hidden'
const startedHidden = process.argv.includes(HIDDEN_ARG)
// Linux: o AppImage informa o próprio caminho em $APPIMAGE (é ele que precisa abrir no login)
const LINUX_AUTOSTART_FILE = join(homedir(), '.config', 'autostart', 'voice-ai.desktop')

function canUseAutostart(): boolean {
  // VOICE_AI_NO_AUTOSTART: só para testar o app empacotado sem registrar a inicialização com o sistema
  if (!app.isPackaged || process.env['VOICE_AI_NO_AUTOSTART']) return false
  if (IS_WIN) return true
  return process.platform === 'linux' && !!process.env['APPIMAGE']
}

function isAutostartEnabled(): boolean {
  if (!canUseAutostart()) return false
  if (IS_WIN) return app.getLoginItemSettings({ args: [HIDDEN_ARG] }).openAtLogin
  return existsSync(LINUX_AUTOSTART_FILE)
}

function setAutostart(enabled: boolean): void {
  if (!canUseAutostart()) return
  if (IS_WIN) {
    app.setLoginItemSettings({ openAtLogin: enabled, args: [HIDDEN_ARG] })
    return
  }
  if (!enabled) {
    rmSync(LINUX_AUTOSTART_FILE, { force: true })
    return
  }
  mkdirSync(join(homedir(), '.config', 'autostart'), { recursive: true })
  const exec = `"${process.env['APPIMAGE']}" ${HIDDEN_ARG}`
  writeFileSync(
    LINUX_AUTOSTART_FILE,
    ['[Desktop Entry]', 'Type=Application', 'Name=Voice AI', `Exec=${exec}`, 'X-GNOME-Autostart-enabled=true', 'Terminal=false', ''].join('\n')
  )
}

/** Linux: o AppImage pode ter sido movido/atualizado; mantém o atalho de login apontando para o arquivo atual. */
function refreshLinuxAutostart(): void {
  if (!IS_WIN && canUseAutostart() && existsSync(LINUX_AUTOSTART_FILE)) setAutostart(true)
}

/** Na primeira execução do app instalado no Windows, liga o autostart por padrão. */
function initAutostartDefault(): void {
  if (!IS_WIN || !canUseAutostart()) return
  const flag = join(getDataDir(), '.autostart-initialized')
  if (existsSync(flag)) return
  setAutostart(true)
  mkdirSync(getDataDir(), { recursive: true })
  writeFileSync(flag, new Date().toISOString())
}

ipcMain.handle('app:autostart', () => ({ available: canUseAutostart(), enabled: isAutostartEnabled() }))
ipcMain.handle('app:autostart-set', (_e, enabled: boolean) => {
  setAutostart(!!enabled)
  return { available: canUseAutostart(), enabled: isAutostartEnabled() }
})

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

/**
 * Modo dev: mantém as bibliotecas da venv em dia com o requirements. Antes, uma biblioteca nova no requirements
 * (ex.: yt-dlp, ddgs) só chegava ao dev se alguém lembrasse de rodar o pip, e a função (busca de vídeo e imagem)
 * falhava em silêncio. Só roda quando o conteúdo dos requirements mudou desde a última vez. O app instalado não
 * passa por aqui: ele tem o setup (Windows: bibliotecas embutidas no build; Linux: setup na primeira abertura e a
 * cada versão com requirements novos).
 */
async function syncDevRequirements(): Promise<void> {
  if (app.isPackaged) return
  const python = getBundledPython()
  try {
    const reqFiles = ['requirements.txt', 'requirements-core.txt']
    const hash = createHash('sha256')
      .update(reqFiles.map((f) => readFileSync(getBackendFile(f), 'utf8')).join('\n--\n'))
      .digest('hex')
      .slice(0, 16)
    const stamp = join(dirname(dirname(python)), '.voice-ai-req-hash')
    if (existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === hash) return
    sysLog('info', 'dev', 'requirements mudaram desde a última vez: conferindo as bibliotecas da venv (pip install -r requirements.txt)')
    const out = await new Promise<{ code: number | null; tail: string }>((resolve) => {
      const p = spawn(python, ['-m', 'pip', 'install', '-q', '--disable-pip-version-check', '-r', getBackendFile('requirements.txt')], { windowsHide: true })
      let tail = ''
      const keep = (d: Buffer): void => {
        tail = (tail + d.toString()).slice(-1500)
      }
      p.stdout?.on('data', keep)
      p.stderr?.on('data', keep)
      p.on('error', (e) => resolve({ code: -1, tail: e.message }))
      p.on('exit', (code) => resolve({ code, tail }))
    })
    if (out.code === 0) {
      writeFileSync(stamp, hash)
      sysLog('info', 'dev', 'bibliotecas da venv em dia')
    } else {
      sysLog('warn', 'dev', `não deu para atualizar as bibliotecas da venv (código ${out.code}); algumas funções podem falhar. ${out.tail.trim().slice(-400)}`)
    }
  } catch (e) {
    sysLog('warn', 'dev', `conferência das bibliotecas da venv falhou: ${e instanceof Error ? e.message : e}`)
  }
}

function spawnBackend(): void {
  const python = getBundledPython()
  const cwd = getBackendCwd()
  const packagesDir = getPackagesDir()
  const existingPythonPath = process.env['PYTHONPATH'] || ''
  // primeiro as bibliotecas que vêm dentro do app; depois as da pasta de dados (CUDA/atualizações)
  const pythonPath = [getBundledPackagesDir(), packagesDir, existingPythonPath].filter(Boolean).join(delimiter)
  const env = {
    ...process.env,
    VOICE_AI_PORT: String(BACKEND_PORT),
    VOICE_AI_DATA_DIR: getDataDir(),
    ...modelDirsEnv(),
    HF_HUB_DISABLE_SYMLINKS_WARNING: '1',
    PYTHONPATH: pythonPath,
    // Windows: força UTF-8 no stdout/stderr do Python (logs com acentos/emoji)
    ...(process.platform === 'win32' ? { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } : {})
  }
  console.log(`[backend] python: ${python}  cwd: ${cwd}  data: ${getDataDir()}  packages: ${packagesDir}`)

  backendProcess = spawn(python, ['-m', 'backend.main'], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  const tail = backendTail()
  const startedAt = Date.now()
  backendProcess.stdout?.on('data', (d) => {
    process.stdout.write(`[backend] ${d}`)
    tail.push(String(d))
  })
  backendProcess.stderr?.on('data', (d) => {
    process.stderr.write(`[backend] ${d}`)
    tail.push(String(d))
  })
  backendProcess.on('error', (e) => sysLog('error', 'backend', `não deu para iniciar o backend (${python}): ${e.message}`))
  backendProcess.on('exit', (code, signal) => {
    process.stdout.write(`[backend] exited with code ${code}\n`)
    const secs = Math.round((Date.now() - startedAt) / 1000)
    if (code === 0 || quitting) sysLog('info', 'backend', `backend encerrado (código ${code ?? signal}, ficou ${secs} s no ar)`)
    else
      sysLog(
        'error',
        'backend',
        `o backend parou sozinho (código ${code ?? signal}, depois de ${secs} s). Últimas linhas dele:\n${tail.lines().join('\n') || '(nenhuma)'}`
      )
    backendProcess = null
  })
}

/** Backend subindo na abertura do app (null durante o setup, que sobe o backend no fim). */
let backendReady: Promise<void> | null = null

ipcMain.handle('backend:wait', async () => {
  if (!backendReady) return { ok: true }
  try {
    await backendReady
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

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
// IPC - overlay state
// ---------------------------------------------------------------------------

/** Cria o indicador: processo próprio em XWayland no Linux/Wayland; janela comum nos demais casos. */
function initOverlay(): void {
  if (overlayWindow || overlayHost) return
  if (overlayNeedsSeparateProcess()) {
    overlayHost = new OverlayProcessHost(
      (level, msg) => sysLog(level, 'overlay', msg),
      () => {
        overlayHost = null
        overlayWindow = createOverlayWindow()
      }
    )
    sysLog('info', 'overlay', 'indicador: Wayland detectado, usará um processo separado em XWayland (abre só quando precisar)')
  } else {
    overlayWindow = createOverlayWindow()
  }
}

ipcMain.on('overlay:state', (_, state: string) => {
  if (!overlayWindow && !overlayHost) return
  if (overlayHideTimer) {
    clearTimeout(overlayHideTimer)
    overlayHideTimer = null
  }
  sysLog('info', 'overlay', state === 'idle' ? 'indicador: escondendo em 2 s' : `indicador: mostrando (${state})`)
  if (state === 'idle') {
    overlayHideTimer = setTimeout(() => {
      if (overlayHost) overlayHost.hide()
      else overlayWindow?.hide()
      overlayHideTimer = null
    }, 2000)
  } else if (overlayHost) {
    overlayHost.show(state)
  } else if (overlayWindow) {
    positionOverlay(overlayWindow)
    overlayWindow.showInactive()
    positionOverlay(overlayWindow)
  }
})

// ---------------------------------------------------------------------------
// IPC - setup
// ---------------------------------------------------------------------------

ipcMain.handle('setup:check', () => {
  const mode = getSetupMode()
  const gpu = hasNvidiaGpu()
  return { required: mode !== 'ok', mode, gpu, systemCuda: gpu && !!systemCudaLibs() }
})

ipcMain.handle('setup:start', async (event, opts?: Partial<SetupOptions>) => {
  try {
    const mode = getSetupMode()
    await runSetup(
      (progress) => event.sender.send('setup:progress', progress),
      mode === 'ok' ? 'update' : mode,
      { useGpu: opts?.useGpu ?? true }
    )
    spawnBackend()
    await waitForBackend()
    initOverlay()
    createTray()
    event.sender.send('setup:done', { success: true })
    return { success: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    event.sender.send('setup:done', { success: false, error: message })
    return { success: false, error: message }
  }
})

// IPC - conta Claude (login pelo fluxo oficial da Anthropic, no navegador)
// ---------------------------------------------------------------------------
// Coleta de dados do Claude Code pela organização (telemetria / OpenTelemetry)
// ---------------------------------------------------------------------------

const MONITORING_RANK: Record<MonitoringLevel, number> = { none: 0, metrics: 1, content: 2 }

/**
 * Verifica e, se a situação piorou desde a última verificação (ex.: passou a
 * coletar o texto dos prompts), mostra uma notificação do Windows. O último resultado fica
 * salvo em <dados do app>/claude-monitoring.json para comparar entre execuções.
 */
async function runMonitoringCheck(): Promise<MonitoringReport> {
  const report = await checkClaudeMonitoring()
  const stateFile = join(getDataDir(), 'claude-monitoring.json')
  let previous: MonitoringLevel | null = null
  try {
    previous = JSON.parse(readFileSync(stateFile, 'utf8')).level ?? null
  } catch {
    // primeira verificação
  }
  try {
    mkdirSync(getDataDir(), { recursive: true })
    writeFileSync(stateFile, JSON.stringify({ level: report.level, checkedAt: report.checkedAt }))
  } catch {
    // sem permissão de escrita: segue sem histórico
  }
  const worse = previous === null ? report.level !== 'none' : MONITORING_RANK[report.level] > MONITORING_RANK[previous]
  if (worse && Notification.isSupported()) {
    const body =
      report.level === 'content'
        ? 'Há uma coleta de dados dos seus prompts configurada no Claude Code. Veja em Configurações → Claude.'
        : 'Há uma coleta de métricas de uso configurada no Claude Code (sem o texto dos prompts).'
    new Notification({ title: 'Voice AI: coleta de dados do Claude Code', body }).show()
  }
  console.log(`[monitoring] nível: ${report.level} (antes: ${previous ?? '-'})`)
  return report
}

ipcMain.handle('claude:monitoring', () => runMonitoringCheck())

// Chamada: sinalização, túnel e lista de telas/janelas (ver call.ts)
registerCallIpc(getDataDir)

// ---------- Imagens do Chat IA: copiar e baixar ----------
const IMAGE_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg'
}
const MAX_IMAGE_BYTES = 30 * 1024 * 1024

/** Baixa a imagem (a original; se o site bloquear, a miniatura). Feito aqui porque a tela não pode
 *  ler imagens de outros sites (CORS). */
async function fetchImage(urls: string[]): Promise<{ data: Buffer; mime: string; url: string } | null> {
  for (const url of urls.filter(Boolean)) {
    try {
      const res = await net.fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36' }
      })
      if (!res.ok) continue
      const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
      const data = Buffer.from(await res.arrayBuffer())
      if (!data.length || data.length > MAX_IMAGE_BYTES) continue
      if (mime && !mime.startsWith('image/')) continue
      return { data, mime: mime || 'image/jpeg', url }
    } catch {
      // tenta a próxima (miniatura)
    }
  }
  return null
}

/** A imagem como data URL (a tela converte para PNG antes de copiar: qualquer formato vira colável) */
ipcMain.handle('media:fetch-image', async (_e, urls: string[]) => {
  const img = await fetchImage(urls)
  if (!img) return { ok: false }
  return { ok: true, dataUrl: `data:${img.mime};base64,${img.data.toString('base64')}`, mime: img.mime }
})

/** Coloca a imagem (PNG) na área de transferência: dá para colar no WhatsApp, e-mail, editores... */
ipcMain.handle('media:copy-png', async (_e, pngBase64: string) => {
  const png = Buffer.from(pngBase64, 'base64')
  if (nativeImage.createFromBuffer(png).isEmpty()) return { ok: false }
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })])
  return { ok: true }
})

/** Salva a imagem original na pasta Downloads (nome sem repetir) */
ipcMain.handle('media:save-image', async (_e, opts: { urls: string[]; name?: string }) => {
  const img = await fetchImage(opts.urls)
  if (!img) return { ok: false }
  const ext = IMAGE_EXT[img.mime] || 'jpg'
  const base =
    (opts.name || 'imagem')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9 _-]+/g, ' ')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 60) || 'imagem'
  const dir = app.getPath('downloads')
  let path = join(dir, `${base}.${ext}`)
  for (let i = 2; existsSync(path); i++) path = join(dir, `${base}-${i}.${ext}`)
  writeFileSync(path, img.data)
  return { ok: true, path }
})

// Atalho "mostrar/esconder": o backend avisa a tela, que pede isto aqui (ver windowToggle.ts)
// Alt+V no chat: imagem que está na área de transferência (ex.: um print da tela)
// Transcrição → área de transferência pelo próprio Electron: no Linux o pyperclip do backend depende do xclip/xsel,
// que nem toda máquina tem (sem eles a cópia falhava em silêncio)
/** Alerta de pedido para entrar na chamada: notificação do sistema (clicar traz o app para a frente) e ícone piscando. */
ipcMain.handle('call:notify', (_e, title: string, body: string) => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (!mainWindow.isFocused()) mainWindow.flashFrame(true)
  if (Notification.isSupported()) {
    const n = new Notification({ title: String(title).slice(0, 100), body: String(body).slice(0, 300), urgency: 'critical' })
    n.on('click', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    })
    n.show()
  }
})

/**
 * Desempenho agora (para o log da transmissão): uso do processador do computador e de cada parte do app, e o
 * estado da janela. 100% em uma parte do app = um núcleo inteiro ocupado.
 */
let lastCpuTimes = cpus().map((c) => c.times)
ipcMain.handle('app:perf', (e) => {
  const now = cpus().map((c) => c.times)
  let busy = 0
  let total = 0
  now.forEach((t, i) => {
    const p = lastCpuTimes[i] ?? t
    const all = t.user + t.nice + t.sys + t.idle + t.irq - (p.user + p.nice + p.sys + p.idle + p.irq)
    total += all
    busy += all - (t.idle - p.idle)
  })
  lastCpuTimes = now
  const parts: Record<string, number> = {}
  for (const m of app.getAppMetrics()) {
    const name =
      m.type === 'Tab' ? 'tela' : m.type === 'GPU' ? 'gráficos' : m.type === 'Browser' ? 'principal'
        : m.type === 'Utility' ? (/video_capture/i.test(m.serviceName ?? '') ? 'captura' : /audio/i.test(m.serviceName ?? '') ? 'som' : 'outros')
          : 'outros'
    parts[name] = (parts[name] ?? 0) + m.cpu.percentCPUUsage
  }
  const win = BrowserWindow.fromWebContents(e.sender)
  return {
    system: total > 0 ? Math.round((busy / total) * 100) : 0,
    cores: now.length,
    parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v)])),
    window: win
      ? { minimized: win.isMinimized(), visible: win.isVisible(), focused: win.isFocused() }
      : null
  }
})

ipcMain.handle('clipboard:write-text', (_e, text: string) => {
  if (typeof text === 'string' && text) clipboard.writeText(text)
})

ipcMain.handle('clipboard:read-image', async () => {
  // Electron 45: a área de transferência é assíncrona (modelo do navegador), com itens por tipo MIME
  for (const item of await clipboard.read()) {
    const type = item.types.find((t) => t.startsWith('image/'))
    if (!type) continue
    const blob = await item.getType(type)
    if (!(blob instanceof Blob)) continue
    const data = Buffer.from(await blob.arrayBuffer())
    const img = nativeImage.createFromBuffer(data)
    if (!img.isEmpty()) return { dataUrl: img.toDataURL() }
  }
  return null
})

ipcMain.handle('window:toggle', (_e, opts?: { keepOnTop?: boolean }) => {
  if (!mainWindow || mainWindow.isDestroyed()) return null
  const result = toggleWindowOnTop(mainWindow, !!opts?.keepOnTop)
  diag('atalho mostrar/esconder', `${result === 'shown' ? 'mostrou' : 'escondeu'} a janela (manter na frente: ${opts?.keepOnTop ? 'sim' : 'não'})`)
  return result
})

ipcMain.handle('window:keep-on-top', (_e, keepOnTop: boolean) => {
  if (mainWindow && !mainWindow.isDestroyed()) setKeepOnTop(mainWindow, !!keepOnTop)
})

ipcMain.handle('shell:show-item', (_e, path: string) => {
  if (path && existsSync(path)) shell.showItemInFolder(path)
})

// Tradução de arquivos: salva o arquivo traduzido onde o usuário escolher
ipcMain.handle('file:save-copy', async (_e, opts: { path: string; name: string }) => {
  if (!opts?.path || !existsSync(opts.path)) return { ok: false }
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow
  const res = await dialog.showSaveDialog(win!, { defaultPath: join(app.getPath('downloads'), opts.name) })
  if (res.canceled || !res.filePath) return { ok: false, canceled: true }
  copyFileSync(opts.path, res.filePath)
  return { ok: true, path: res.filePath }
})

ipcMain.handle('claude:status', async () => {
  const bin = findClaude()
  if (!bin) return { installed: false, loggedIn: false }
  return { installed: true, ...(await claudeAccount(bin)) }
})

ipcMain.handle('claude:login', (_e, opts?: { switchAccount?: boolean }) => {
  const bin = findClaude()
  if (!bin) return { started: false, error: 'Claude Code não está instalado' }
  const env = { ...process.env }
  delete env['ANTHROPIC_API_KEY']
  if (process.platform === 'win32') {
    // Abre uma janela de terminal visível com o login oficial (o navegador abre sozinho).
    // Script .cmd temporário: mensagens em português e a janela espera a pessoa ler antes de fechar.
    const script = join(app.getPath('temp'), 'voice-ai-claude-login.cmd')
    const lines = [
      '@echo off',
      'chcp 65001 >nul',
      'title Entrar na conta Claude',
      'echo.',
      'echo  Conectando o Voice AI a sua conta Claude...',
      'echo  O navegador vai abrir: entre com a sua conta e autorize o acesso.',
      'echo.',
      ...(opts?.switchAccount ? [`"${bin}" auth logout`] : []),
      `"${bin}" auth login`,
      'echo.',
      'echo  Pronto! Pode fechar esta janela e voltar ao Voice AI.',
      'pause >nul'
    ]
    writeFileSync(script, lines.join(String.fromCharCode(13, 10)), 'utf8')
    const proc = spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: false, env })
    proc.on('error', (e) => console.error('[claude] login falhou:', e))
    proc.unref()
  } else {
    const args = ['auth', 'login']
    const proc = spawn(bin, args, { detached: true, stdio: 'ignore', env })
    proc.on('error', (e) => console.error('[claude] login falhou:', e))
    proc.unref()
  }
  return { started: true }
})

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

// Tamanho com que a janela principal sempre abre: HD (1280x720)
const MAIN_WINDOW_SIZE = { width: 1280, height: 720 }

function createMainWindow(): BrowserWindow {
  // nunca maior que a área útil da tela (monitores pequenos / escala alta)
  const area = screen.getPrimaryDisplay().workAreaSize
  const win = new BrowserWindow({
    width: Math.min(MAIN_WINDOW_SIZE.width, area.width),
    height: Math.min(MAIN_WINDOW_SIZE.height, area.height),
    center: true,
    minWidth: 720,
    minHeight: 500,
    icon: appIcon(),
    show: false,
    backgroundColor: '#0f172a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      // com o app em segundo plano, o navegador atrasaria os timers (até 1 s): o "só transmitir quando eu falar"
      // e o ganho do som da transmissão dependem de medir o áudio a cada poucos milissegundos
      backgroundThrottling: false
    }
  })
  watchWindow(win, 'janela principal')
  // Transmissão em tela cheia + troca para outro programa (Alt+Tab): a tela cheia FICA como está e a pessoa
  // volta para ela depois; só o ESC sai. (Antes saía sozinha ao perder o foco, por um relato de "computador preso
  // em tela cheia"; isso atrapalhava quem assiste num monitor e usa outro. O que acontece fica no janela.log.)
  win.on('blur', () => {
    setTimeout(() => {
      if (win.isDestroyed() || win.isFocused() || !win.isFullScreen()) return
      diag('janela principal', 'perdeu o foco em tela cheia: a tela cheia continua (só o ESC sai)')
    }, 300)
  })

  win.on('ready-to-show', () => {
    // ao iniciar com o sistema (--hidden) fica só na bandeja, a menos que o setup seja necessário
    if (startedHidden && isSetupComplete()) return
    win.show()
  })
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

const OVERLAY_W = 220
const OVERLAY_H = 36

// Canto superior direito da área útil do monitor onde está o cursor (considera o deslocamento do monitor).
function positionOverlay(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return
  const { screen } = require('electron')
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const { x, y, width } = display.workArea
  win.setBounds({ x: x + width - OVERLAY_W - 16, y: y + 16, width: OVERLAY_W, height: OVERLAY_H })
}

function createOverlayWindow(): BrowserWindow {
  const { screen } = require('electron')
  const wa = screen.getPrimaryDisplay().workArea

  const win = new BrowserWindow({
    width: OVERLAY_W,
    height: OVERLAY_H,
    x: wa.x + wa.width - OVERLAY_W - 16,
    y: wa.y + 16,
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
  watchWindow(win, 'indicador (overlay)')

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/overlay.html')
  } else {
    win.loadFile(join(__dirname, '../renderer/overlay.html'))
  }
  return win
}

function createTray(): void {
  // o mesmo ícone do app (resources/icon.png), em 32 px para a bandeja
  let icon = appIcon()
  if (!icon.isEmpty()) icon = icon.resize({ width: 32, height: 32, quality: 'best' })
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
      ...(canUseAutostart()
        ? [
            {
              label: 'Iniciar com o sistema',
              type: 'checkbox' as const,
              checked: isAutostartEnabled(),
              click: (item: Electron.MenuItem) => setAutostart(item.checked)
            }
          ]
        : []),
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

function startMainApp(): void {
  // Evita duas instâncias (ex.: autostart + abrir pelo atalho, ou dois cliques enquanto abre): a segunda só mostra a janela
  if (!app.requestSingleInstanceLock()) {
    app.quit()
  } else {
    app.on('second-instance', () => {
      if (mainWindow?.isMinimized()) mainWindow.restore()
      mainWindow?.show()
      mainWindow?.focus()
    })
  }

  /**
   * Player do YouTube embutido (vídeos no Chat IA): em produção a página vem de file://, que não
   * manda Referer, e o YouTube recusa o player ("erro 153"). Injeta um Referer só nesses domínios.
   */
  function allowYouTubeEmbeds(): void {
    session.defaultSession.webRequest.onBeforeSendHeaders(
      { urls: ['*://*.youtube-nocookie.com/*', '*://*.youtube.com/*'] },
      (details, callback) => {
        const headers = details.requestHeaders
        if (!headers['Referer'] && !headers['referer']) headers['Referer'] = 'https://www.youtube-nocookie.com/'
        callback({ requestHeaders: headers })
      }
    )
  }

  app.whenReady().then(async () => {
    initSysLog(getDataDir(), BACKEND_URL)
    initWindowDiag(getDataDir())
    sysLog(
      'info',
      'app',
      `Voice AI ${app.getVersion()} aberto | ${process.platform} ${process.arch} | Electron ${process.versions.electron} (Chromium ${process.versions.chrome})` +
        (process.platform === 'linux'
          ? ` | sessão ${process.env['XDG_SESSION_TYPE'] || '?'} (${process.env['XDG_CURRENT_DESKTOP'] || '?'}) | DISPLAY=${process.env['DISPLAY'] || '-'} WAYLAND_DISPLAY=${process.env['WAYLAND_DISPLAY'] || '-'} | ozone=${app.commandLine.getSwitchValue('ozone-platform') || 'automático'}`
          : '')
    )
    electronApp.setAppUserModelId('com.voiceai')
    // Linux: o GNOME liga a janela ao atalho (e ao ícone) pelo nome do .desktop; sem isso o AppImage aparece como
    // "voice-ai.bin" e fica com o ícone genérico (três pontinhos)
    if (process.platform === 'linux') app.setDesktopName('voice-ai.desktop')
    initAutostartDefault()
    allowYouTubeEmbeds()
    // Verifica a coleta de dados do Claude Code a cada abertura do app e a cada 30 min
    // (o Claude Code busca as políticas da organização nesse mesmo intervalo)
    runMonitoringCheck().catch((e) => console.error('[monitoring] falhou:', e))
    setInterval(() => runMonitoringCheck().catch(() => {}), 30 * 60_000)
    app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

    refreshLinuxAutostart()
    const setupNeeded = !isSetupComplete()

    // a janela abre na hora (com "Iniciando…"); o backend sobe em paralelo e a tela espera por ele (backend:wait)
    mainWindow = createMainWindow()
    // Amigos (beta): presença e mensagens entre amigos pelo ntfy.sh (ver friends.ts)
    registerFriendsIpc(getDataDir, () => mainWindow)

    if (!setupNeeded) {
      backendReady = (async () => {
        if (!(await isBackendUp())) {
        await syncDevRequirements()
        spawnBackend()
      }
        await waitForBackend(60_000)
        initOverlay()
        createTray()
      })()
      backendReady.catch((e) => console.error('[backend] não iniciou:', e))
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow()
      else mainWindow?.show()
    })
  })

  app.on('window-all-closed', () => {
    // keep running in tray - don't quit
  })

  // antes de fechar, avisa os amigos que fiquei offline (no máximo ~1,5 s)
  let friendsOfflineDone = false
  app.on('will-quit', (e) => {
    if (friendsOfflineDone) return
    friendsOfflineDone = true
    e.preventDefault()
    void friendsGoOffline().finally(() => app.quit())
  })

  app.on('before-quit', () => {
    quitting = true
    overlayHost?.stop('app fechando')
    tray?.destroy()
    tray = null
    if (backendProcess) {
      backendProcess.kill('SIGTERM')
      backendProcess = null
    }
  })
}

if (IS_OVERLAY_PROC) runOverlayProcess()
else startMainApp()

export { mainWindow, overlayWindow, BACKEND_URL }
