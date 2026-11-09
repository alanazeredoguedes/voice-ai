import { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, session, screen, Notification, clipboard, net } from 'electron'

// Must be called before app is ready - fixes SUID sandbox error on Linux AppImage
if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox')
import { join, delimiter } from 'path'
import { homedir } from 'os'
import { existsSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'fs'
import { createHash } from 'crypto'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { spawn, ChildProcess, SpawnOptions } from 'child_process'
import { checkClaudeMonitoring, type MonitoringLevel, type MonitoringReport } from './claudeMonitoring'

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

function getBackendCwd(): string {
  if (!app.isPackaged) return join(__dirname, '..', '..', '..')
  return process.resourcesPath
}

// ---------------------------------------------------------------------------
// Setup state
// ---------------------------------------------------------------------------

function getRequirementsPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'backend', 'requirements.txt')
    : join(__dirname, '..', '..', '..', 'backend', 'requirements.txt')
}

/** Hash do requirements.txt: quando muda (nova versão do app), o setup instala só o que falta. */
function requirementsHash(): string {
  try {
    return createHash('sha256').update(readFileSync(getRequirementsPath())).digest('hex').slice(0, 16)
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
  try {
    hash = JSON.parse(readFileSync(marker, 'utf8')).hash ?? ''
  } catch {
    // marcador antigo (só a data): instalação feita antes da checagem por hash
  }
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
    JSON.stringify({ hash: requirementsHash(), installedAt: new Date().toISOString() })
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
    const env = { ...(opts.env ?? process.env), PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }
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
  nvidia_cuda_nvrtc_cu12: 'NVIDIA NVRTC'
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

/** Lista (linhas do requirements.txt) os pacotes que ainda não estão instalados em `packagesDir`. */
async function missingRequirements(python: string, packagesDir: string, requirementsPath: string): Promise<string[]> {
  const script = [
    'import sys, json',
    `sys.path.insert(0, ${JSON.stringify(packagesDir)})`,
    'from importlib.metadata import distribution, PackageNotFoundError',
    'from pip._vendor.packaging.requirements import Requirement',
    'missing = []',
    `for raw in open(${JSON.stringify(requirementsPath)}, encoding="utf-8"):`,
    '    line = raw.split("#")[0].strip()',
    '    if not line: continue',
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
      const missing = await missingRequirements(bundledPython, packagesDir, requirementsPath)
      log(`[setup] pacotes faltando: ${missing.length ? missing.join(', ') : 'nenhum'}`)
      if (!missing.length) return 'já estava tudo instalado'
      await pipInstall(bundledPython, ['install', ...missing, ...target, '--upgrade'], 5, 85, 'Atualizando', 'deps', onProgress, log, pipEnv)
      return `${missing.length} componente(s) novo(s)`
    })
  } else {
    const gpu = hasNvidiaGpu()
    const sysCuda = gpu ? systemCudaLibs() : null
    const wantCuda = gpu && opts.useGpu && !sysCuda

    await step('deps', async () => {
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
    })

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
            `sys.path.insert(0, ${JSON.stringify(packagesDir)})`,
            "os.environ['HF_HUB_DISABLE_PROGRESS_BARS'] = '0'",
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
// Windows: iniciar com o sistema
// ---------------------------------------------------------------------------

const IS_WIN = process.platform === 'win32'
const HIDDEN_ARG = '--hidden'
const startedHidden = process.argv.includes(HIDDEN_ARG)

function canUseAutostart(): boolean {
  return IS_WIN && app.isPackaged
}

function isAutostartEnabled(): boolean {
  if (!canUseAutostart()) return false
  return app.getLoginItemSettings({ args: [HIDDEN_ARG] }).openAtLogin
}

function setAutostart(enabled: boolean): void {
  if (!canUseAutostart()) return
  app.setLoginItemSettings({ openAtLogin: enabled, args: [HIDDEN_ARG] })
}

/** Na primeira execução do app instalado no Windows, liga o autostart por padrão. */
function initAutostartDefault(): void {
  if (!canUseAutostart()) return
  const flag = join(getDataDir(), '.autostart-initialized')
  if (existsSync(flag)) return
  setAutostart(true)
  mkdirSync(getDataDir(), { recursive: true })
  writeFileSync(flag, new Date().toISOString())
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
    PYTHONPATH: existingPythonPath ? `${packagesDir}${delimiter}${existingPythonPath}` : packagesDir,
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
// IPC - overlay state
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
ipcMain.handle('media:copy-png', (_e, pngBase64: string) => {
  const image = nativeImage.createFromBuffer(Buffer.from(pngBase64, 'base64'))
  if (image.isEmpty()) return { ok: false }
  clipboard.writeImage(image)
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

ipcMain.handle('shell:show-item', (_e, path: string) => {
  if (path && existsSync(path)) shell.showItemInFolder(path)
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
    show: false,
    backgroundColor: '#0f172a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  win.on('ready-to-show', () => {
    // Windows: ao iniciar com o sistema (--hidden) fica só na bandeja, a menos que o setup seja necessário
    if (IS_WIN && startedHidden && isSetupComplete()) return
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
      ...(canUseAutostart()
        ? [
            {
              label: 'Iniciar com o Windows',
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

// Windows: evita duas instâncias (ex.: autostart + abrir pelo atalho) - a segunda só mostra a janela
if (IS_WIN && !app.requestSingleInstanceLock()) {
  app.quit()
} else if (IS_WIN) {
  app.on('second-instance', () => {
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
  electronApp.setAppUserModelId('com.voiceai')
  initAutostartDefault()
  allowYouTubeEmbeds()
  // Verifica a coleta de dados do Claude Code a cada abertura do app e a cada 30 min
  // (o Claude Code busca as políticas da organização nesse mesmo intervalo)
  runMonitoringCheck().catch((e) => console.error('[monitoring] falhou:', e))
  setInterval(() => runMonitoringCheck().catch(() => {}), 30 * 60_000)
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
