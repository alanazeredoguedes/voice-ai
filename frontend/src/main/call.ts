/**
 * Chamada (voz + compartilhamento de tela): parte que roda no processo principal.
 *
 * - Servidor de sinalização: um WebSocket mínimo, só na máquina de quem cria a sala. Ele NÃO
 *   transporta áudio, vídeo nem chat - só repassa o handshake do WebRTC entre os participantes.
 * - Túnel Cloudflare (quick tunnel): dá a esse servidor um endereço público sem abrir porta.
 *   O nome aleatório do túnel (ex.: "calm-river-paper-moon") é o código da sala.
 * - cloudflared: baixado no setup (ou na primeira sala, se ainda não existir).
 */
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, net, screen, session, shell, type WebContents } from 'electron'
import { execFile, spawn, type ChildProcess } from 'child_process'
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { promises as dns } from 'dns'
import { join } from 'path'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { randomBytes } from 'crypto'
import { WebSocketServer, WebSocket } from 'ws'
import {
  announce,
  callsDirOf,
  roomState,
  watchRooms,
  presenceKeyFor,
  proofFor,
  roomByTag,
  tagFor,
  type Announcement
} from './callRendezvous'
import { setShareAudioLogger, startLinuxShareAudio, stopLinuxShareAudio } from './linuxShareAudio'
import { startEchoCancel, stopEchoCancel } from './linuxEchoCancel'
import { startX11Capture, stopX11Capture } from './linuxX11Capture'

// ---------------------------------------------------------------------------
// Log da sala: o que acontece aqui (túnel, sinalização, som do Linux) aparece no log da tela de Chamada
// ---------------------------------------------------------------------------

type LogLevel = 'info' | 'warn' | 'error'
let logTarget: WebContents | null = null

function mainLog(level: LogLevel, msg: string): void {
  ;(level === 'info' ? console.log : console.warn)('[call]', msg)
  if (logTarget && !logTarget.isDestroyed()) logTarget.send('call:log', { level, msg })
}
setShareAudioLogger((level, msg) => mainLog(level, `[som da transmissão] ${msg}`))

// ---------------------------------------------------------------------------
// cloudflared
// ---------------------------------------------------------------------------

const CLOUDFLARED_EXE = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'

/** Arquivo do release oficial para esta plataforma (null = sem binário avulso, ex.: macOS). */
function cloudflaredAsset(): string | null {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'amd64' : null
  if (!arch) return null
  if (process.platform === 'linux') return `cloudflared-linux-${arch}`
  if (process.platform === 'win32' && arch === 'amd64') return 'cloudflared-windows-amd64.exe'
  return null
}

function downloadedCloudflared(dataDir: string): string {
  return join(dataDir, 'bin', CLOUDFLARED_EXE)
}

/** O baixado pelo app ou, na falta dele, um já instalado no sistema (PATH). */
/** Sempre o cloudflared do próprio app (baixado na instalação), nunca um do sistema: cada instalação isolada. */
export function findCloudflared(dataDir: string): string | null {
  const own = downloadedCloudflared(dataDir)
  return existsSync(own) ? own : null
}

let downloading: Promise<string> | null = null

/** Baixa o cloudflared do release oficial (GitHub da Cloudflare) para a pasta de dados do app. */
export function downloadCloudflared(
  dataDir: string,
  onProgress?: (doneBytes: number, totalBytes: number) => void
): Promise<string> {
  if (downloading) return downloading
  downloading = (async () => {
    const asset = cloudflaredAsset()
    if (!asset) throw new Error('Não há cloudflared para este sistema - instale-o manualmente')
    const target = downloadedCloudflared(dataDir)
    const part = `${target}.part`
    mkdirSync(join(dataDir, 'bin'), { recursive: true })
    const res = await net.fetch(`https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`)
    if (!res.ok || !res.body) throw new Error(`Falha ao baixar o cloudflared (HTTP ${res.status})`)
    const total = Number(res.headers.get('content-length') || 0)
    const out = createWriteStream(part)
    try {
      let done = 0
      const reader = res.body.getReader()
      for (;;) {
        const { done: end, value } = await reader.read()
        if (end) break
        done += value.length
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
        onProgress?.(done, total)
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
      if (total && done !== total) throw new Error('Download do cloudflared veio incompleto')
    } catch (e) {
      out.destroy()
      rmSync(part, { force: true })
      throw e
    }
    renameSync(part, target)
    if (process.platform !== 'win32') chmodSync(target, 0o755)
    return target
  })()
  downloading.finally(() => (downloading = null)).catch(() => {})
  return downloading
}

// ---------------------------------------------------------------------------
// Servidor de sinalização (uma sala por servidor)
// ---------------------------------------------------------------------------

interface SignalPeer {
  ws: WebSocket
  name: string
  /** já foi aceito na sala (quem está esperando só recebe "waiting") */
  admitted: boolean
}

let wss: WebSocketServer | null = null
let httpServer: Server | null = null
let signalPort = 0
/** só quem criou o servidor (este processo) sabe: identifica o anfitrião na hora de entrar */
let hostToken = ''
let hostPeerId = ''
const peers = new Map<string, SignalPeer>()
/** sala servida: quem entra recebe o id (para guardar o histórico no lugar certo) e o nome */
let room = { id: '', name: '' }

function sendTo(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

const admittedPeers = (): [string, SignalPeer][] => [...peers].filter(([, p]) => p.admitted)

/** Avisa quem está dentro de quem está pedindo para entrar (a lista inteira, a cada mudança). */
function broadcastKnocks(): void {
  const knocks = [...peers].filter(([, p]) => !p.admitted).map(([id, p]) => ({ id, name: p.name }))
  for (const [, p] of admittedPeers()) sendTo(p.ws, { type: 'knocks', knocks })
}

function admit(id: string): void {
  const peer = peers.get(id)
  if (!peer || peer.admitted) return
  sendTo(peer.ws, {
    type: 'peers',
    room,
    hostPeerId,
    peers: admittedPeers().map(([pid, p]) => ({ id: pid, name: p.name }))
  })
  for (const [, p] of admittedPeers()) sendTo(p.ws, { type: 'peer-joined', peer: { id, name: peer.name } })
  peer.admitted = true
  mainLog('info', `[servidor da sala] "${peer.name}" entrou (${admittedPeers().length} conectados)`)
  sendTo(peer.ws, { type: 'knocks', knocks: [...peers].filter(([, p]) => !p.admitted).map(([pid, p]) => ({ id: pid, name: p.name })) })
}

/** Resposta HTTP do servidor da sala: /presence (quem está dentro, para quem já esteve na sala) e 426 no resto. */
function onHttp(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname === '/presence' && room.id && url.searchParams.get('k') === presenceKeyFor(room.id)) {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(
      JSON.stringify({ names: admittedPeers().map(([, p]) => p.name), waiting: peers.size - admittedPeers().length })
    )
    return
  }
  // um pedido HTTP comum responde 426 (é o que o teste de "túnel no ar" espera)
  res.writeHead(426, { 'content-type': 'text/plain' })
  res.end('Upgrade Required')
}

/** Sobe o servidor só em 127.0.0.1 (quem chega de fora vem pelo túnel) numa porta livre qualquer. */
function startSignaling(roomInfo: { id: string; name: string }): Promise<number> {
  room = roomInfo
  hostToken = randomBytes(16).toString('hex')
  hostPeerId = ''
  return new Promise((resolve, reject) => {
    const server = createServer(onHttp)
    const ws = new WebSocketServer({ server, maxPayload: 256 * 1024 })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      httpServer = server
      wss = ws
      signalPort = (server.address() as { port: number }).port
      resolve(signalPort)
    })
    ws.on('connection', (socket) => {
      let myId: string | null = null
      // primeiro a etiqueta da sala: quem já esteve nela responde com a prova e entra direto
      sendTo(socket, { type: 'welcome', tag: room.id ? tagFor(room.id) : '' })
      socket.on('message', (data) => {
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(data.toString())
        } catch {
          return
        }
        if (msg.type === 'ping') return sendTo(socket, { type: 'pong' })
        if (msg.type === 'join' && !myId && typeof msg.peerId === 'string' && !peers.has(msg.peerId)) {
          myId = msg.peerId
          const name = String(msg.name ?? 'Convidado').slice(0, 40)
          const isHost = typeof msg.hostToken === 'string' && msg.hostToken === hostToken
          const member = !!room.id && msg.proof === proofFor(room.id)
          peers.set(myId, { ws: socket, name, admitted: false })
          if (isHost) hostPeerId = myId
          // ninguém dentro para aceitar (não deveria acontecer: o anfitrião entra primeiro): entra direto
          if (isHost || member || !admittedPeers().length) {
            mainLog('info', `[servidor da sala] "${name}" ${isHost ? 'é quem hospeda' : member ? 'já esteve na sala: entrada liberada' : 'entrou'}`)
            admit(myId)
          } else {
            mainLog('info', `[servidor da sala] "${name}" pediu para entrar: aguardando alguém aceitar`)
            sendTo(socket, { type: 'waiting' })
          }
          broadcastKnocks()
          return
        }
        const me = myId ? peers.get(myId) : undefined
        if (!myId || !me?.admitted) return
        // alguém de dentro aceitou ou recusou um pedido de entrada
        if (msg.type === 'admit' && typeof msg.peerId === 'string') {
          const target = peers.get(msg.peerId)
          if (!target || target.admitted) return
          if (msg.accept) {
            mainLog('info', `[servidor da sala] "${me.name}" aceitou "${target.name}"`)
            admit(msg.peerId)
          } else {
            mainLog('info', `[servidor da sala] "${me.name}" recusou "${target.name}"`)
            sendTo(target.ws, { type: 'denied', by: me.name })
            peers.delete(msg.peerId)
            setTimeout(() => target.ws.close(), 200)
          }
          broadcastKnocks()
          return
        }
        // handshake do WebRTC (sdp / ice): repassa ao destinatário, carimbando o remetente
        if (typeof msg.to === 'string') {
          const target = peers.get(msg.to)
          if (target?.admitted) sendTo(target.ws, { ...msg, from: myId })
        }
      })
      socket.on('close', () => {
        const me = myId ? peers.get(myId) : undefined
        if (!myId || me?.ws !== socket) return
        peers.delete(myId)
        if (me.admitted) {
          mainLog('info', `[servidor da sala] "${me.name}" desconectou do servidor (${admittedPeers().length} conectados)`)
          for (const [, p] of admittedPeers()) sendTo(p.ws, { type: 'peer-left', peerId: myId })
        } else {
          mainLog('info', `[servidor da sala] "${me.name}" desistiu de entrar`)
        }
        broadcastKnocks()
      })
    })
  })
}

function stopSignaling(): void {
  for (const p of peers.values()) p.ws.terminate()
  peers.clear()
  wss?.close()
  wss = null
  httpServer?.close()
  httpServer = null
  signalPort = 0
}

// ---------------------------------------------------------------------------
// Túnel
// ---------------------------------------------------------------------------

let tunnel: ChildProcess | null = null

/** Abre o quick tunnel e devolve o código da sala (o subdomínio de trycloudflare.com). */
function startTunnel(bin: string, port: number, onExit: () => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    tunnel = proc
    let settled = false
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (tunnel === proc) tunnel = null
      proc.kill()
      reject(err)
    }
    const timer = setTimeout(() => fail(new Error('O túnel demorou demais para responder (30 s)')), 30000)
    const onData = (data: Buffer): void => {
      const m = data.toString().match(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com/)
      if (!m || m[1] === 'api' || settled) return
      settled = true
      clearTimeout(timer)
      resolve(m[1])
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    proc.on('error', (err) => fail(new Error(`Não foi possível iniciar o cloudflared: ${err.message}`)))
    proc.on('exit', () => {
      if (!settled) return fail(new Error('O cloudflared encerrou antes de abrir o túnel'))
      // caiu no meio da chamada: quem já está conectado continua (P2P), mas ninguém novo entra
      if (tunnel === proc) {
        tunnel = null
        mainLog('error', '[túnel] o cloudflared encerrou: a chamada continua, mas ninguém novo consegue entrar')
        onExit()
      }
    })
  })
}

function stopTunnel(): void {
  const proc = tunnel
  tunnel = null
  proc?.kill()
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Só entrega o código da sala quando ele já funciona para quem está de fora.
 *
 * O nome do túnel leva alguns segundos para existir no DNS depois que o cloudflared o anuncia, e
 * quem perguntar por ele antes disso recebe "não existe" - resposta que os servidores de DNS guardam
 * por 60 s (a sala pareceria fora do ar durante esse tempo). Por isso a espera pergunta direto aos
 * servidores de DNS autoritativos da Cloudflare, que não guardam nada, e só depois testa o endereço.
 */
async function waitTunnelReachable(code: string): Promise<void> {
  const started = Date.now()
  await waitTunnelReachableInner(code)
  mainLog('info', `[túnel] código liberado para quem está de fora após ${((Date.now() - started) / 1000).toFixed(1)} s`)
}

async function waitTunnelReachableInner(code: string): Promise<void> {
  const host = `${code}.trycloudflare.com`
  try {
    const servers: string[] = []
    for (const ns of (await dns.resolveNs('trycloudflare.com')).slice(0, 2)) servers.push(...(await dns.resolve4(ns)))
    const authoritative = new dns.Resolver({ timeout: 2000, tries: 1 })
    authoritative.setServers(servers)
    const deadline = Date.now() + 20000
    for (;;) {
      if (!tunnel) return
      if (await authoritative.resolve4(host).then((a) => a.length > 0, () => false)) break
      if (Date.now() > deadline) {
        mainLog('warn', '[túnel] o nome ainda não aparece no DNS da Cloudflare após 20 s')
        return
      }
      await sleep(500)
    }
  } catch {
    // sem acesso aos servidores autoritativos: espera fixa, sem perguntar pelo nome
    mainLog('warn', '[túnel] sem acesso ao DNS da Cloudflare: esperando 6 s')
    await sleep(6000)
    return
  }
  // o nome já existe; agora espera a rede da Cloudflare atender de forma estável
  // (o servidor de sinalização responde 426 a um pedido HTTP comum)
  const deadline = Date.now() + 12000
  for (let streak = 0; streak < 2 && Date.now() < deadline && tunnel; ) {
    const ok = await net.fetch(`https://${host}/`, { cache: 'no-store' }).then((r) => r.status === 426, () => false)
    streak = ok ? streak + 1 : 0
    if (streak < 2) await sleep(500)
  }
}

/** Derruba sinalização e túnel (ao sair da sala e ao fechar o app). */
export function stopCallHost(): void {
  stopTunnel()
  stopSignaling()
}

app.on('before-quit', () => {
  void stopLinuxShareAudio()
})

// ---------------------------------------------------------------------------
// Histórico das salas: <dados do app>/calls/<id>.json + arquivos em <dados do app>/calls/<id>/
// ---------------------------------------------------------------------------

const SAFE_ID = /^[a-zA-Z0-9-]{8,64}$/

function callsDir(dataDir: string): string {
  return join(dataDir, 'calls')
}

function roomFile(dataDir: string, id: string): string {
  if (!SAFE_ID.test(id)) throw new Error('id de sala inválido')
  return join(callsDir(dataDir), `${id}.json`)
}

function roomFilePath(dataDir: string, roomId: string, fileId: string): string {
  if (!SAFE_ID.test(roomId) || !SAFE_ID.test(fileId)) throw new Error('id inválido')
  return join(callsDir(dataDir), roomId, fileId)
}

function uniqueDownloadPath(name: string): string {
  const clean = name.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').trim().slice(0, 150) || 'arquivo'
  const dot = clean.lastIndexOf('.')
  const base = dot > 0 ? clean.slice(0, dot) : clean
  const ext = dot > 0 ? clean.slice(dot) : ''
  const dir = app.getPath('downloads')
  let path = join(dir, clean)
  for (let i = 2; existsSync(path); i++) path = join(dir, `${base} (${i})${ext}`)
  return path
}

function registerHistoryIpc(getDataDir: () => string): void {
  ipcMain.handle('call:rooms-list', () => {
    const dir = callsDir(getDataDir())
    if (!existsSync(dir)) return []
    const rooms: unknown[] = []
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      try {
        const r = JSON.parse(readFileSync(join(dir, f), 'utf8'))
        rooms.push({
          id: r.id,
          name: r.name,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          participants: r.participants ?? [],
          messageCount: (r.messages ?? []).length
        })
      } catch {
        // arquivo corrompido: ignora
      }
    }
    return rooms
  })

  ipcMain.handle('call:room-load', (_e, id: string) => {
    try {
      return JSON.parse(readFileSync(roomFile(getDataDir(), id), 'utf8'))
    } catch {
      return null
    }
  })

  ipcMain.handle('call:room-save', (_e, data: { id: string }) => {
    const file = roomFile(getDataDir(), data.id)
    mkdirSync(callsDir(getDataDir()), { recursive: true })
    writeFileSync(`${file}.tmp`, JSON.stringify(data))
    renameSync(`${file}.tmp`, file)
  })

  ipcMain.handle('call:room-delete', (_e, id: string) => {
    rmSync(roomFile(getDataDir(), id), { force: true })
    rmSync(join(callsDir(getDataDir()), id), { recursive: true, force: true })
  })

  ipcMain.handle('call:file-store', (_e, roomId: string, fileId: string, data: ArrayBuffer) => {
    const path = roomFilePath(getDataDir(), roomId, fileId)
    mkdirSync(join(callsDir(getDataDir()), roomId), { recursive: true })
    writeFileSync(path, Buffer.from(data))
  })

  ipcMain.handle('call:file-read', (_e, roomId: string, fileId: string) => {
    const path = roomFilePath(getDataDir(), roomId, fileId)
    return existsSync(path) ? readFileSync(path) : null
  })

  ipcMain.handle('call:file-has', (_e, roomId: string, fileIds: string[]) =>
    fileIds.filter((id) => SAFE_ID.test(id) && existsSync(roomFilePath(getDataDir(), roomId, id)))
  )

  /** "Baixar": copia o arquivo da sala para a pasta Downloads e mostra no gerenciador de arquivos. */
  ipcMain.handle('call:file-download', (_e, roomId: string, fileId: string, name: string) => {
    const src = roomFilePath(getDataDir(), roomId, fileId)
    if (!existsSync(src)) return { ok: false }
    const dest = uniqueDownloadPath(name)
    copyFileSync(src, dest)
    shell.showItemInFolder(dest)
    return { ok: true, path: dest }
  })
}

// ---------------------------------------------------------------------------
// Captura de tela (getDisplayMedia): a tela/janela escolhida no modal do app
// ---------------------------------------------------------------------------

let pendingCapture: { sourceId: string; audio: boolean } | null = null

function registerDisplayMedia(): void {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const pick = pendingCapture
    pendingCapture = null
    if (!pick) return callback({})
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
    const video = sources.find((s) => s.id === pick.sourceId)
    if (!video) return callback({})
    // Windows: som do computador inteiro; o próprio Voice AI fica de fora pelo `restrictOwnAudio`
    // pedido pela tela (sem isso, quem fala na chamada ouviria a própria voz de volta)
    callback({ video, ...(pick.audio && process.platform === 'win32' ? { audio: 'loopback' as const } : {}) })
  })
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

export function registerCallIpc(getDataDir: () => string): void {
  registerHistoryIpc(getDataDir)
  void app.whenReady().then(registerDisplayMedia)

  // Linux: som da transmissão pelo PipeWire (ver linuxShareAudio.ts)
  // a tela de Chamada se registra para receber o log; de volta, dados do ambiente para o começo do log
  ipcMain.handle('call:log-target', (e) => {
    logTarget = e.sender
    return {
      version: app.getVersion(),
      platform: `${process.platform} ${process.arch}`,
      session: process.env['XDG_SESSION_TYPE'] ?? '',
      packaged: app.isPackaged ? (process.env['APPIMAGE'] ? 'AppImage' : 'instalado') : 'dev'
    }
  })
  ipcMain.handle('call:linux-audio-start', (_e, sourceId: string) =>
    process.platform === 'linux' ? startLinuxShareAudio(String(sourceId)) : { ok: false, error: 'só no Linux' }
  )
  ipcMain.handle('call:linux-audio-stop', () => stopLinuxShareAudio())

  // Linux: microfone sem eco (tira do microfone o som que sai na caixa de som); ver linuxEchoCancel.ts
  ipcMain.handle('call:aec-start', async (_e, micLabel: string) => {
    if (process.platform !== 'linux') return { ok: false, error: 'só no Linux' }
    const res = await startEchoCancel(String(micLabel ?? ''), (level, msg) => mainLog(level, `[cancelamento de eco] ${msg}`))
    if (!res.ok) mainLog('warn', `[cancelamento de eco] indisponível: ${res.error}`)
    return res
  })
  ipcMain.handle('call:aec-stop', () => stopEchoCancel())

  // Linux com Xorg: captura de tela própria (ffmpeg), bem mais rápida que a do Chromium; ver linuxX11Capture.ts
  ipcMain.handle('call:x11-capture-start', async (_e, opts: { sourceId: string; width: number; height: number; fps: number }) => {
    let displayId = ''
    if (String(opts?.sourceId).startsWith('screen:')) {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).catch(() => [])
      displayId = sources.find((s) => s.id === opts.sourceId)?.display_id ?? ''
    }
    return startX11Capture(
      {
        sourceId: String(opts?.sourceId ?? ''),
        displayId,
        width: Math.min(Math.max(Number(opts?.width) || 1920, 320), 7680),
        height: Math.min(Math.max(Number(opts?.height) || 1080, 240), 4320),
        fps: Math.min(Math.max(Number(opts?.fps) || 30, 5), 120)
      },
      (level, msg) => mainLog(level, `[captura] ${msg}`)
    )
  })
  ipcMain.handle('call:x11-capture-stop', () => stopX11Capture())

  ipcMain.handle('call:capture-pick', (_e, pick: { sourceId: string; audio: boolean }) => {
    pendingCapture = pick
  })

  ipcMain.handle('call:host-start', async (event, roomInfo: { id: string; name: string }): Promise<{ ok: true; port: number; code: string; hostToken: string } | { ok: false; error: string }> => {
    const sender: WebContents = event.sender
    logTarget = sender
    try {
      stopCallHost()
      let bin = findCloudflared(getDataDir())
      if (!bin) {
        mainLog('warn', '[túnel] cloudflared não encontrado: baixando')
        bin = await downloadCloudflared(getDataDir())
      }
      const port = await startSignaling({ id: String(roomInfo?.id ?? ''), name: String(roomInfo?.name ?? '').slice(0, 80) })
      mainLog('info', `[servidor da sala] ouvindo em 127.0.0.1:${port}`)
      const started = Date.now()
      const code = await startTunnel(bin, port, () => {
        if (!sender.isDestroyed()) sender.send('call:tunnel-down')
      })
      mainLog('info', `[túnel] aberto em ${((Date.now() - started) / 1000).toFixed(1)} s: ${code}`)
      return { ok: true, port, code, hostToken }
    } catch (e) {
      stopCallHost()
      mainLog('error', `[túnel] falha ao criar a sala: ${e instanceof Error ? e.message : e}`)
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // quem cria já entra na sala; o código só é mostrado quando funciona para quem está de fora
  ipcMain.handle('call:host-ready', (_e, code: string) => waitTunnelReachable(code))

  ipcMain.handle('call:host-stop', () => stopCallHost())

  /** O túnel caiu e quem hospeda continua na sala: abre outro túnel para o mesmo servidor (código novo). */
  ipcMain.handle('call:tunnel-restart', async (event): Promise<{ ok: true; code: string } | { ok: false; error: string }> => {
    const sender: WebContents = event.sender
    if (!wss || !signalPort) return { ok: false, error: 'a sala não está sendo hospedada aqui' }
    try {
      stopTunnel()
      const bin = findCloudflared(getDataDir()) ?? (await downloadCloudflared(getDataDir()))
      const code = await startTunnel(bin, signalPort, () => {
        if (!sender.isDestroyed()) sender.send('call:tunnel-down')
      })
      mainLog('info', `[túnel] reaberto: ${code}`)
      return { ok: true, code }
    } catch (e) {
      mainLog('error', `[túnel] não deu para reabrir: ${e instanceof Error ? e.message : e}`)
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ---- ponto de encontro (ntfy.sh): ver callRendezvous.ts
  ipcMain.handle('call:rv-announce', async (_e, roomId: string, a: Announcement) => {
    if (!SAFE_ID.test(roomId)) return false
    const claim = typeof a.claim === 'string' ? a.claim.slice(0, 64) : undefined
    try {
      await announce(roomId, {
        code: a.opening ? '' : String(a.code),
        hostName: String(a.hostName ?? '').slice(0, 40),
        ts: Date.now(),
        closed: !!a.closed,
        opening: !!a.opening,
        claim
      })
      mainLog(
        'info',
        `[ponto de encontro] ${a.opening ? 'reserva publicada (estou abrindo a sala)' : a.closed ? 'sala marcada como fechada' : `código ${a.code} publicado`}`
      )
      return true
    } catch (e) {
      mainLog('warn', `[ponto de encontro] não deu para publicar: ${e instanceof Error ? e.message : e}`)
      return false
    }
  })

  /** Salas que o app quer acompanhar em tempo real (histórico + sala atual). */
  ipcMain.handle('call:rv-watch', (e, roomIds: string[]) => {
    const sender = e.sender
    watchRooms(
      (Array.isArray(roomIds) ? roomIds : []).filter((id) => SAFE_ID.test(id)),
      () => !sender.isDestroyed() && sender.send('call:rv-changed')
    )
  })

  /** Situação de cada sala: no ar (e quem está nela) ou alguém abrindo agora. */
  ipcMain.handle('call:rv-state', async (_e, roomIds: string[]) => {
    const ids = (Array.isArray(roomIds) ? roomIds : []).filter((id) => SAFE_ID.test(id)).slice(0, 20)
    const out: Record<string, unknown> = {}
    try {
      await Promise.all(ids.map(async (id) => (out[id] = await roomState(id))))
      return out
    } catch (e) {
      mainLog('warn', `[ponto de encontro] consulta falhou: ${e instanceof Error ? e.message : e}`)
      return null
    }
  })

  /** Prova de que já estive na sala com esta etiqueta (null = nunca estive). */
  ipcMain.handle('call:room-proof', (_e, tag: string) => {
    const id = roomByTag(callsDirOf(getDataDir()), String(tag))
    return id ? proofFor(id) : null
  })

  /**
   * Telas do computador, para o log da transmissão: tamanho lógico, escala e pixels reais. No Linux com
   * Xorg também o tamanho da área desenhada (com escala fracionária ela é maior que a própria tela).
   */
  ipcMain.handle('call:display-info', async () => {
    const displays = screen.getAllDisplays().map((d) => ({
      id: String(d.id),
      label: d.label || '',
      size: `${d.size.width}x${d.size.height}`,
      scale: d.scaleFactor,
      pixels: `${Math.round(d.size.width * d.scaleFactor)}x${Math.round(d.size.height * d.scaleFactor)}`,
      hz: d.displayFrequency,
      primary: d.id === screen.getPrimaryDisplay().id
    }))
    let framebuffer = ''
    if (process.platform === 'linux' && process.env['XDG_SESSION_TYPE'] !== 'wayland') {
      try {
        const out = await new Promise<string>((resolve, reject) =>
          execFile('xrandr', ['--current'], { timeout: 3000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
        )
        framebuffer = out.match(/current (\d+) x (\d+)/)?.slice(1, 3).join('x') ?? ''
      } catch {
        // sem xrandr
      }
    }
    return {
      platform: `${process.platform} ${process.arch}`,
      session: process.env['XDG_SESSION_TYPE'] ?? '',
      desktop: process.env['XDG_CURRENT_DESKTOP'] ?? '',
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      displays,
      framebuffer
    }
  })

  /** "Baixar" o log da sala: escolhe onde salvar (começa em Downloads) e grava o texto. */
  ipcMain.handle('call:save-log', async (event, text: string, name: string) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const safe = String(name || 'log-da-chamada.txt').replace(/[\\/:*?"<>|]+/g, '_')
    const res = await dialog.showSaveDialog(win!, {
      title: 'Salvar o log da chamada',
      defaultPath: join(app.getPath('downloads'), safe),
      filters: [{ name: 'Texto', extensions: ['txt'] }]
    })
    if (res.canceled || !res.filePath) return null
    writeFileSync(res.filePath, String(text ?? ''), 'utf8')
    shell.showItemInFolder(res.filePath)
    return res.filePath
  })

  /** Linux com Wayland: o próprio sistema mostra o seletor de tela (exigência de segurança, não dá para pular). */
  ipcMain.handle('call:session-type', () => (process.platform === 'linux' ? (process.env['XDG_SESSION_TYPE'] ?? '') : ''))

  ipcMain.handle('call:sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 }
    })
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      isScreen: s.id.startsWith('screen:'),
      thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL()
    }))
  })

  app.on('before-quit', stopCallHost)
}
