/**
 * Chamada (voz + compartilhamento de tela): parte que roda no processo principal.
 *
 * - Servidor de sinalização: um WebSocket mínimo, só na máquina de quem cria a sala. Ele NÃO
 *   transporta áudio, vídeo nem chat - só repassa o handshake do WebRTC entre os participantes.
 * - Túnel Cloudflare (quick tunnel): dá a esse servidor um endereço público sem abrir porta.
 *   O nome aleatório do túnel (ex.: "calm-river-paper-moon") é o código da sala.
 * - cloudflared: baixado no setup (ou na primeira sala, se ainda não existir).
 */
import { app, desktopCapturer, ipcMain, net, session, shell, type WebContents } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
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
import { delimiter, join } from 'path'
import { WebSocketServer, WebSocket } from 'ws'
import { startLinuxShareAudio, stopLinuxShareAudio } from './linuxShareAudio'

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
export function findCloudflared(dataDir: string): string | null {
  const own = downloadedCloudflared(dataDir)
  if (existsSync(own)) return own
  for (const dir of (process.env['PATH'] || '').split(delimiter)) {
    if (dir && existsSync(join(dir, CLOUDFLARED_EXE))) return join(dir, CLOUDFLARED_EXE)
  }
  return null
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
}

let wss: WebSocketServer | null = null
const peers = new Map<string, SignalPeer>()
/** sala servida: quem entra recebe o id (para guardar o histórico no lugar certo) e o nome */
let room = { id: '', name: '' }

function sendTo(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

/** Sobe o servidor só em 127.0.0.1 (quem chega de fora vem pelo túnel) numa porta livre qualquer. */
function startSignaling(roomInfo: { id: string; name: string }): Promise<number> {
  room = roomInfo
  return new Promise((resolve, reject) => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 256 * 1024 })
    server.once('error', reject)
    server.once('listening', () => {
      wss = server
      resolve((server.address() as { port: number }).port)
    })
    server.on('connection', (ws) => {
      let myId: string | null = null
      ws.on('message', (data) => {
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(data.toString())
        } catch {
          return
        }
        if (msg.type === 'ping') return sendTo(ws, { type: 'pong' })
        if (msg.type === 'join' && !myId && typeof msg.peerId === 'string') {
          myId = msg.peerId
          const name = String(msg.name ?? 'Convidado').slice(0, 40)
          sendTo(ws, { type: 'peers', room, peers: [...peers].map(([id, p]) => ({ id, name: p.name })) })
          for (const p of peers.values()) sendTo(p.ws, { type: 'peer-joined', peer: { id: myId, name } })
          peers.set(myId, { ws, name })
          return
        }
        // handshake do WebRTC (sdp / ice): repassa ao destinatário, carimbando o remetente
        if (myId && typeof msg.to === 'string') {
          const target = peers.get(msg.to)
          if (target) sendTo(target.ws, { ...msg, from: myId })
        }
      })
      ws.on('close', () => {
        if (!myId || peers.get(myId)?.ws !== ws) return
        peers.delete(myId)
        for (const p of peers.values()) sendTo(p.ws, { type: 'peer-left', peerId: myId })
      })
    })
  })
}

function stopSignaling(): void {
  for (const p of peers.values()) p.ws.terminate()
  peers.clear()
  wss?.close()
  wss = null
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
      if (Date.now() > deadline) return
      await sleep(500)
    }
  } catch {
    // sem acesso aos servidores autoritativos: espera fixa, sem perguntar pelo nome
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

app.on('before-quit', () => void stopLinuxShareAudio())

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
  ipcMain.handle('call:linux-audio-start', (_e, sourceId: string) =>
    process.platform === 'linux' ? startLinuxShareAudio(String(sourceId)) : { ok: false, error: 'só no Linux' }
  )
  ipcMain.handle('call:linux-audio-stop', () => stopLinuxShareAudio())

  ipcMain.handle('call:capture-pick', (_e, pick: { sourceId: string; audio: boolean }) => {
    pendingCapture = pick
  })

  ipcMain.handle('call:host-start', async (event, roomInfo: { id: string; name: string }): Promise<{ ok: true; port: number; code: string } | { ok: false; error: string }> => {
    const sender: WebContents = event.sender
    try {
      stopCallHost()
      const bin = findCloudflared(getDataDir()) ?? (await downloadCloudflared(getDataDir()))
      const port = await startSignaling({ id: String(roomInfo?.id ?? ''), name: String(roomInfo?.name ?? '').slice(0, 80) })
      const code = await startTunnel(bin, port, () => {
        if (!sender.isDestroyed()) sender.send('call:tunnel-down')
      })
      return { ok: true, port, code }
    } catch (e) {
      stopCallHost()
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // quem cria já entra na sala; o código só é mostrado quando funciona para quem está de fora
  ipcMain.handle('call:host-ready', (_e, code: string) => waitTunnelReachable(code))

  ipcMain.handle('call:host-stop', () => stopCallHost())

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
