/**
 * Janela de progresso da atualização no Linux (AppImage), equivalente à do Windows (updateWindow.ts).
 *
 * Por que não o quitAndInstall do electron-updater: ele troca o arquivo e só então pede para o app fechar, sem tela
 * nenhuma; e na atualização 1.3.5 -> 1.3.6 o app antigo não fechou (ficou vivo e invisível, sem janela nem bandeja).
 * Aqui o fechamento tem duas garantias: o app sai à força em 8 s (updater.ts) e a janela encerra o processo antigo
 * se ele continuar de pé (etapa 1).
 *
 * Como funciona agora: depois do download, o app antigo abre o AppImage NOVO (o arquivo baixado, ainda na pasta de
 * cache) em "modo janela de atualização" (variável VOICE_AI_UPDATE_HELPER) e fecha. Essa janela roda fora do arquivo
 * antigo, então pode trocá-lo, e acompanha cada etapa pelo que acontece de verdade:
 *
 *   etapa                        sinal real usado
 *   Fechando o Voice AI          o processo do app antigo e a porta do backend dele
 *   Instalando a nova versão     bytes copiados do AppImage novo para a pasta do app (barra real)
 *   Removendo a versão antiga    o arquivo antigo apagado; atalhos do menu e do login apontados para o novo
 *   Abrindo o Voice AI           o app novo apaga o update-pending.json logo ao abrir (reportPreviousUpdate)
 *
 * Se a janela não abrir em 20 s, o app antigo troca o arquivo sozinho (sem tela) e reabre na versão nova.
 */
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { spawn } from 'child_process'
import { appendFileSync, chmodSync, copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { connect } from 'net'
import { homedir, tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { syncLinuxDesktopEntries } from './linuxDesktop'

export const UPDATE_HELPER_ENV = 'VOICE_AI_UPDATE_HELPER'
/** Este processo é a janela de atualização (o valor da variável é o caminho do config.json). */
export const IS_UPDATE_HELPER = process.platform === 'linux' && !!process.env[UPDATE_HELPER_ENV]

const READY_TIMEOUT_MS = 20000 // o AppImage descomprime o app ao abrir: pode levar alguns segundos

type HelperConfig = {
  pid: number
  /** pasta montada do AppImage antigo: todos os processos dele (Chromium, backend) rodam de lá */
  oldAppDir: string
  backendPort: number
  oldPath: string
  newFile: string
  dest: string
  fromVersion: string
  toVersion: string
  logFile: string
  pendingFile: string
  readyFile: string
  cancelFile: string
}

function workDir(): string {
  return join(tmpdir(), 'voice-ai-update-linux')
}

/** Pasta do Chromium da janela de atualização (separada da do app, que abre ao mesmo tempo). */
export function updateHelperUserData(): string {
  return join(tmpdir(), 'voice-ai-update-helper-profile')
}

/** Onde o AppImage novo fica: no mesmo nome se o antigo não tinha versão no nome (o usuário escolheu um nome fixo). */
export function appImageDestination(oldPath: string, newFile: string): string {
  const oldBase = basename(oldPath)
  if (basename(newFile) === oldBase || !/\d+\.\d+\.\d+/.test(oldBase)) return oldPath
  return join(dirname(oldPath), basename(newFile))
}

/**
 * Ambiente limpo para abrir outro AppImage: sem as variáveis do AppImage atual. O AppRun também põe a pasta montada
 * dele (que some quando ele fecha) no começo de PATH, LD_LIBRARY_PATH, XDG_DATA_DIRS e GSETTINGS_SCHEMA_DIR: tira de lá.
 */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env }
  const appDir = env['APPDIR']
  if (appDir) {
    for (const k of ['PATH', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR']) {
      const v = env[k]
      if (v === undefined) continue
      const kept = v.split(':').filter((p) => p !== '' && p !== appDir && !p.startsWith(`${appDir}/`))
      if (kept.length) env[k] = kept.join(':')
      else delete env[k]
    }
  }
  for (const k of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD', 'APPIMAGE_EXIT_AFTER_INSTALL', 'APPIMAGE_SILENT_INSTALL', UPDATE_HELPER_ENV]) delete env[k]
  return { ...env, ...extra }
}

/**
 * Descritores que este processo herdou e passaria adiante: os sem O_CLOEXEC (o que o próprio Electron/Node abre já
 * vem com O_CLOEXEC). O principal é o "pipe de vida" do runtime do AppImage: a montagem do AppImage só é desfeita
 * quando todos os processos com esse pipe fecham. Herdado, ele deixava a montagem do app antigo (e a da janela) presa
 * enquanto o app novo estivesse aberto, com o arquivo já apagado.
 */
function inheritedFds(): number[] {
  try {
    return readdirSync('/proc/self/fd')
      .map(Number)
      .filter((fd) => Number.isInteger(fd) && fd > 2)
      .filter((fd) => {
        try {
          const flags = /flags:\s*([0-7]+)/.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))?.[1]
          return flags !== undefined && (parseInt(flags, 8) & 0o2000000) === 0
        } catch {
          return false // era o descritor da própria listagem, já fechado
        }
      })
  } catch {
    return []
  }
}

/** Abre um AppImage solto deste processo (sobrevive a ele) e sem levar junto os descritores herdados. */
function spawnDetached(file: string, env: NodeJS.ProcessEnv): ReturnType<typeof spawn> {
  const opts = { detached: true, stdio: 'ignore' as const, cwd: homedir(), env }
  const fds = inheritedFds()
  // o bash fecha os descritores e vira o AppImage (exec): o pid é o mesmo, então o 'exit' continua valendo
  if (fds.length && existsSync('/bin/bash')) return spawn('/bin/bash', ['-c', `exec ${fds.map((fd) => `${fd}>&-`).join(' ')}; exec "$0"`, file], opts)
  return spawn(file, [], opts)
}

/**
 * Plano B, sem janela: troca o arquivo agora, com o app antigo ainda aberto (no Linux dá para apagar/substituir um
 * arquivo em uso: o app antigo segue rodando a partir da cópia já montada).
 */
export function installAppImageSync(newFile: string, oldPath: string, dest: string): void {
  const part = `${dest}.part`
  copyFileSync(newFile, part)
  chmodSync(part, 0o755)
  renameSync(part, dest)
  if (dest !== oldPath) rmSync(oldPath, { force: true })
  rmSync(newFile, { force: true })
  syncLinuxDesktopEntries(dest)
}

// ---------------------------------------------------------------------------
// Lado do app antigo: abre a janela e espera ela aparecer
// ---------------------------------------------------------------------------

export async function launchLinuxUpdateHelper(opts: {
  fromVersion: string
  toVersion: string
  newFile: string
  oldPath: string
  dest: string
  backendPort: number
  logFile: string
  pendingFile: string
  log: (level: 'info' | 'warn' | 'error', msg: string) => void
}): Promise<boolean> {
  const dir = workDir()
  const readyFile = join(dir, 'ready.flag')
  const cancelFile = join(dir, 'cancel.flag')
  try {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    chmodSync(opts.newFile, 0o755)
    const cfg: HelperConfig = {
      pid: process.pid,
      oldAppDir: process.env['APPDIR'] ?? '',
      backendPort: opts.backendPort,
      oldPath: opts.oldPath,
      newFile: opts.newFile,
      dest: opts.dest,
      fromVersion: opts.fromVersion,
      toVersion: opts.toVersion,
      logFile: opts.logFile,
      pendingFile: opts.pendingFile,
      readyFile,
      cancelFile
    }
    const cfgFile = join(dir, 'config.json')
    writeFileSync(cfgFile, JSON.stringify(cfg), 'utf8')
    opts.log('info', `abrindo a janela de atualização (${opts.newFile} -> ${opts.dest})`)
    // detached: a janela fica num grupo de processos próprio e sobrevive ao app fechar
    const child = spawnDetached(opts.newFile, cleanEnv({ [UPDATE_HELPER_ENV]: cfgFile }))
    child.on('error', (e) => opts.log('error', `não deu para abrir a janela de atualização: ${e.message}`))
    child.unref()

    const t0 = Date.now()
    while (!existsSync(readyFile) && Date.now() - t0 < READY_TIMEOUT_MS) await new Promise((r) => setTimeout(r, 150))
    if (!existsSync(readyFile)) {
      // avisa a janela (se ela abrir atrasada) para não fazer nada: o app vai trocar o arquivo sozinho
      writeFileSync(cancelFile, new Date().toISOString())
      opts.log('warn', `a janela de atualização não abriu em ${READY_TIMEOUT_MS / 1000} s: atualizando sem a janela`)
      return false
    }
    opts.log('info', `janela de atualização aberta em ${Date.now() - t0} ms`)
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.hide()
    return true
  } catch (e) {
    try {
      writeFileSync(cancelFile, new Date().toISOString())
    } catch {
      // sem a pasta temporária a janela também não teria como abrir
    }
    opts.log('error', `falha ao abrir a janela de atualização: ${e instanceof Error ? e.message : e}`)
    return false
  }
}

// ---------------------------------------------------------------------------
// Lado da janela (roda no AppImage novo)
// ---------------------------------------------------------------------------

const STEPS = ['Download concluído', 'Fechando o Voice AI', 'Instalando a nova versão', 'Removendo a versão antiga', 'Abrindo o Voice AI']

type ViewState = {
  phase: number // 1..4 etapa em andamento, 5 concluído, -1 erro
  failedAt: number
  pct: number[]
  title: string
  subtitle: string
  message: string
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Encerra o app antigo inteiro: o processo principal e todos os que rodam da pasta montada dele (processos do
 * Chromium, backend). Só o principal deixaria os filhos órfãos, segurando a montagem antiga.
 */
function killOldApp(pid: number, appDir: string, signal: NodeJS.Signals): void {
  const pids = new Set([pid])
  if (appDir) {
    for (const d of readdirSync('/proc')) {
      if (!/^\d+$/.test(d) || Number(d) === process.pid) continue
      try {
        const exe = readlinkSync(`/proc/${d}/exe`)
        if (exe.startsWith(`${appDir}/`)) pids.add(Number(d))
      } catch {
        // processo de outro usuário ou que já saiu
      }
    }
  }
  for (const p of pids) {
    try {
      process.kill(p, signal)
    } catch {
      // já saiu
    }
  }
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port })
    const done = (v: boolean): void => {
      s.destroy()
      resolve(v)
    }
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
    s.setTimeout(800, () => done(false))
  })
}

function pageHtml(logo: string): string {
  const rows = STEPS.map(
    (name, i) =>
      `<div class="row" id="row${i}"><span class="ic" id="ic${i}">○</span><span class="lb">${name}</span><span class="pc" id="pc${i}"></span></div>`
  ).join('')
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Atualizando o Voice AI</title><style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%;background:#0F172A;color:#F1F5F9;font-family:"Segoe UI",Ubuntu,Cantarell,system-ui,sans-serif;overflow:hidden;user-select:none}
  body{border:1px solid #334155;padding:28px 30px 22px;-webkit-app-region:drag;display:flex;flex-direction:column}
  .head{display:flex;align-items:center;gap:16px}
  .head img{width:52px;height:52px}
  h1{font-size:20px;font-weight:600}
  .sub{font-size:13px;color:#94A3B8;margin-top:3px}
  .steps{margin-top:22px}
  .row{display:flex;align-items:center;padding:5px 0;font-size:14px;color:#64748B}
  .ic{width:28px;font-size:15px;color:#475569}
  .lb{flex:1}
  .pc{font-size:13px;color:#A5B4FC}
  .row.done{color:#CBD5E1}.row.done .ic{color:#22C55E}
  .row.cur{color:#F1F5F9}.row.cur .ic{color:#818CF8}
  .row.fail{color:#FCA5A5}.row.fail .ic{color:#EF4444}
  .track{height:8px;border-radius:4px;background:#1E293B;margin-top:20px;overflow:hidden;position:relative}
  .fill{height:100%;width:0;background:#6366F1;border-radius:4px;transition:width .25s}
  .marquee{position:absolute;top:0;height:100%;width:130px;border-radius:4px;background:linear-gradient(90deg,#6366F100,#6366F1,#6366F100);animation:slide 1.3s linear infinite;display:none}
  @keyframes slide{from{left:-130px}to{left:100%}}
  .msg{font-size:12.5px;color:#94A3B8;margin-top:16px;line-height:1.45}
  .msg.err{color:#FCA5A5}
  .btns{display:flex;justify-content:flex-end;gap:6px;margin-top:auto;padding-top:14px;visibility:hidden;-webkit-app-region:no-drag}
  button{background:#1E293B;color:#E2E8F0;border:1px solid #334155;border-radius:8px;padding:8px 14px;font:inherit;font-size:13px;cursor:pointer}
  button:hover{background:#334155}
  </style></head><body>
  <div class="head"><img src="${logo}" alt=""><div><h1 id="title">Atualizando o Voice AI</h1><div class="sub" id="sub"></div></div></div>
  <div class="steps">${rows}</div>
  <div class="track"><div class="fill" id="fill"></div><div class="marquee" id="marquee"></div></div>
  <div class="msg" id="msg"></div>
  <div class="btns" id="btns"><button data-a="open">Abrir o app</button><button data-a="logs">Ver logs</button><button data-a="close">Fechar</button></div>
  <script>
  const { ipcRenderer } = require('electron')
  const $ = (id) => document.getElementById(id)
  for (const b of document.querySelectorAll('button')) b.onclick = () => ipcRenderer.send('update-helper:action', b.dataset.a)
  ipcRenderer.on('update-helper:state', (_e, s) => {
    $('title').textContent = s.title; $('sub').textContent = s.subtitle
    $('msg').textContent = s.message; $('msg').className = s.phase === -1 ? 'msg err' : 'msg'
    for (let i = 0; i < ${STEPS.length}; i++) {
      const done = s.phase === 5 || (s.phase >= 1 && i < s.phase) || (s.phase === -1 && i < s.failedAt)
      const cur = s.phase >= 1 && s.phase <= 4 && i === s.phase
      const fail = s.phase === -1 && i === s.failedAt
      $('row' + i).className = 'row' + (done ? ' done' : cur ? ' cur' : fail ? ' fail' : '')
      $('ic' + i).textContent = done ? '✔' : cur ? '●' : fail ? '✖' : '○'
      $('pc' + i).textContent = cur && (i === 2 || i === 3) ? Math.round(s.pct[i] * 100) + '%' : ''
    }
    const measured = s.phase === 2 || s.phase === 3
    $('marquee').style.display = s.phase === 1 || s.phase === 4 ? 'block' : 'none'
    $('fill').style.display = s.phase === 1 || s.phase === 4 ? 'none' : 'block'
    $('fill').style.background = s.phase === 5 ? '#22C55E' : s.phase === -1 ? '#EF4444' : '#6366F1'
    $('fill').style.width = s.phase === 5 || s.phase === -1 ? '100%' : measured ? Math.min(100, s.pct[s.phase] * 100) + '%' : '0'
    $('btns').style.visibility = s.phase === -1 ? 'visible' : 'hidden'
  })
  ipcRenderer.send('update-helper:loaded')
  </script></body></html>`
}

export function runLinuxUpdateHelper(): void {
  const cfgPath = process.env[UPDATE_HELPER_ENV] as string
  let cfg: HelperConfig
  try {
    cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as HelperConfig
  } catch {
    app.exit(1)
    return
  }
  // o app antigo desistiu de esperar (a janela demorou): ele mesmo troca o arquivo
  if (existsSync(cfg.cancelFile)) {
    app.exit(0)
    return
  }

  const t0 = Date.now()
  const log = (msg: string, level: 'INFO' | 'WARN' | 'ERROR' = 'INFO'): void => {
    try {
      const d = new Date()
      const p = (n: number, w = 2): string => String(n).padStart(w, '0')
      const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
      mkdirSync(dirname(cfg.logFile), { recursive: true })
      appendFileSync(cfg.logFile, `${stamp} ${level.padEnd(5)} [janela/atualização] ${msg}\n`, 'utf8')
    } catch {
      // sem log a atualização segue
    }
  }

  const view: ViewState = {
    phase: 1,
    failedAt: 1,
    pct: [0, 0, 0, 0, 0],
    title: 'Atualizando o Voice AI',
    subtitle: cfg.fromVersion && cfg.toVersion ? `Versão ${cfg.fromVersion}  →  ${cfg.toVersion}` : '',
    message: 'Isso leva só alguns segundos. O Voice AI abre sozinho quando terminar.'
  }
  let win: BrowserWindow | null = null
  const render = (): void => {
    if (win && !win.isDestroyed()) win.webContents.send('update-helper:state', view)
  }
  let phaseStart = Date.now()
  const enter = (n: number): void => {
    log(`etapa ${view.phase} (${STEPS[view.phase]}) levou ${((Date.now() - phaseStart) / 1000).toFixed(1)} s`)
    view.phase = n
    phaseStart = Date.now()
    if (n <= 4) log(`etapa ${n}: ${STEPS[n]}`)
    render()
  }
  const fail = (title: string, message: string): void => {
    log(`${title} - ${message}`, 'ERROR')
    if (view.phase >= 1) view.failedAt = view.phase
    view.phase = -1
    view.title = title
    view.message = message
    render()
  }
  /** Abre o app (o novo; se não existir, o que sobrar), fora deste processo e sem as variáveis desta janela. */
  const openApp = (): ReturnType<typeof spawn> | null => {
    const target = [cfg.dest, cfg.oldPath, cfg.newFile].find((p) => existsSync(p))
    if (!target) return null
    const child = spawnDetached(target, cleanEnv())
    child.on('error', (e) => log(`não deu para abrir ${target}: ${e.message}`, 'ERROR'))
    return child
  }

  ipcMain.on('update-helper:action', (_e, action: string) => {
    if (action === 'open') {
      const c = openApp()
      c?.unref()
      if (c) app.quit()
      else view.message = 'O arquivo do Voice AI não foi encontrado. Baixe o AppImage na página de releases.'
      render()
    } else if (action === 'logs') {
      void shell.openPath(dirname(cfg.logFile))
    } else if (action === 'close') {
      app.quit()
    }
  })

  async function run(): Promise<void> {
    // 1. Fechando o Voice AI: espera o processo antigo sair e o backend dele soltar a porta (o app novo usaria um
    //    backend antigo ainda de pé). Se ele travar, encerra à força: os dados já foram salvos antes do pedido.
    log(`etapa 1: ${STEPS[1]}`)
    let termSent = false
    let killSent = false
    while (isAlive(cfg.pid) || (await portInUse(cfg.backendPort))) {
      const s = (Date.now() - phaseStart) / 1000
      if (s > 20 && !termSent) {
        termSent = true
        log('o app antigo não fechou em 20 s: pedindo para encerrar (SIGTERM)', 'WARN')
        killOldApp(cfg.pid, cfg.oldAppDir, 'SIGTERM')
      }
      if (s > 30 && !killSent) {
        killSent = true
        log('o app antigo continua aberto: encerrando à força (SIGKILL)', 'WARN')
        killOldApp(cfg.pid, cfg.oldAppDir, 'SIGKILL')
      }
      if (s > 40) {
        fail('O Voice AI não fechou', 'A versão antiga continua aberta, então não dá para trocar o arquivo. Feche o Voice AI (inclusive pela bandeja) e rode a atualização de novo.')
        return
      }
      await sleep(250)
    }
    enter(2)

    // 2. Instalando a nova versão: copia para "<destino>.part" medindo os bytes, e só no fim troca pelo nome final
    //    (a troca é atômica: nunca fica um AppImage pela metade no lugar do app)
    const part = `${cfg.dest}.part`
    try {
      const total = Math.max(1, statSync(cfg.newFile).size)
      let copied = 0
      await new Promise<void>((resolve, reject) => {
        const rs = createReadStream(cfg.newFile)
        const ws = createWriteStream(part, { mode: 0o755 })
        rs.on('data', (chunk) => {
          copied += chunk.length
          const pct = Math.min(0.99, copied / total)
          if (pct - view.pct[2] >= 0.02) {
            view.pct[2] = pct
            render()
          }
        })
        rs.on('error', reject)
        ws.on('error', reject)
        ws.on('finish', () => resolve())
        rs.pipe(ws)
      })
      chmodSync(part, 0o755)
      renameSync(part, cfg.dest)
      view.pct[2] = 1
      log(`AppImage novo gravado em ${cfg.dest} (${(total / 1048576).toFixed(0)} MB)`)
    } catch (e) {
      rmSync(part, { force: true })
      fail('A instalação não foi concluída', `Não consegui gravar a versão nova em ${dirname(cfg.dest)} (${e instanceof Error ? e.message : e}). A versão antiga continua no lugar: clique em "Abrir o app".`)
      return
    }
    enter(3)

    // 3. Removendo a versão antiga (se o nome mudou) e o arquivo baixado; atalhos passam a apontar para o novo
    try {
      if (cfg.dest !== cfg.oldPath && existsSync(cfg.oldPath)) {
        unlinkSync(cfg.oldPath)
        log(`versão antiga apagada: ${cfg.oldPath}`)
      }
    } catch (e) {
      log(`não consegui apagar a versão antiga ${cfg.oldPath}: ${e instanceof Error ? e.message : e}`, 'WARN')
    }
    view.pct[3] = 0.5
    render()
    try {
      unlinkSync(cfg.newFile)
    } catch {
      // fica na pasta de cache; o electron-updater limpa no próximo download
    }
    try {
      const changed = syncLinuxDesktopEntries(cfg.dest)
      log(`atalhos apontando para ${cfg.dest}${changed.length ? ` (atualizados: ${changed.join(', ')})` : ''}`)
    } catch (e) {
      log(`não consegui atualizar os atalhos: ${e instanceof Error ? e.message : e}`, 'WARN')
    }
    view.pct[3] = 1
    enter(4)

    // 4. Abrindo o Voice AI: o app novo apaga o update-pending.json assim que abre (reportPreviousUpdate)
    const hadPending = existsSync(cfg.pendingFile)
    const child = openApp()
    let exitedWith: number | null = null
    child?.on('exit', (code) => {
      exitedWith = code ?? -1
    })
    const t4 = Date.now()
    while (true) {
      const opened = hadPending ? !existsSync(cfg.pendingFile) : Date.now() - t4 > 4000
      if (opened) break
      if (exitedWith !== null && exitedWith !== 0) {
        fail('O Voice AI não abriu', `A versão nova foi instalada, mas fechou ao abrir (código ${exitedWith}). Clique em "Abrir o app" ou veja os logs.`)
        return
      }
      if (Date.now() - t4 > 90000) {
        fail('O Voice AI não abriu sozinho', 'A versão nova foi instalada, mas não abriu em 90 s. Clique em "Abrir o app" ou procure "Voice AI" no menu de aplicativos.')
        return
      }
      await sleep(300)
    }
    child?.unref()
    enter(5)
    view.title = 'Atualização concluída'
    view.message = 'Tudo certo! O Voice AI já está aberto.'
    log(`atualização concluída em ${((Date.now() - t0) / 1000).toFixed(1)} s: o app novo abriu`)
    render()
    await sleep(1600)
    app.quit()
  }

  app.whenReady().then(() => {
    let logo = ''
    try {
      logo = `data:image/png;base64,${readFileSync(join(__dirname, '..', '..', 'resources', 'icon.png')).toString('base64')}`
    } catch {
      // sem logo a janela abre do mesmo jeito
    }
    win = new BrowserWindow({
      width: 500,
      height: 410,
      useContentSize: true,
      frame: false,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      center: true,
      title: 'Atualizando o Voice AI',
      backgroundColor: '#0F172A',
      // conteúdo local e fixo (nenhuma página de fora): pode usar o ipcRenderer direto, sem preload
      webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false }
    })
    win.on('closed', () => {
      log('janela fechada')
      win = null
    })
    ipcMain.once('update-helper:loaded', () => {
      if (existsSync(cfg.cancelFile)) {
        app.exit(0)
        return
      }
      win?.show()
      render()
      log(`janela aberta: ${cfg.fromVersion} -> ${cfg.toVersion}, ${cfg.oldPath} -> ${cfg.dest}`)
      try {
        writeFileSync(cfg.readyFile, new Date().toISOString())
      } catch {
        // o app antigo vai desistir de esperar e atualizar sem a janela
      }
      void run().catch((e) => fail('Erro na atualização', e instanceof Error ? e.message : String(e)))
    })
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(pageHtml(logo))}`)
  })
}
