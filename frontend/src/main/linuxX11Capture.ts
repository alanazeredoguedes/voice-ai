/**
 * Captura de tela própria no Linux com Xorg (via ffmpeg), no lugar do capturador do Chromium.
 *
 * Por quê: no Xorg, o capturador do Chromium copia, compara e reduz a tela inteira num núcleo só e se limita
 * a 50% dele. Numa tela grande (ex.: TV 4K com escala de 160% = 6144x3456 desenhados) isso dá ~10 fps,
 * seja qual for a qualidade escolhida. O ffmpeg copia a mesma tela a 60 fps e reduz em vários núcleos
 * (medido: 1080p chega a 58 fps no app e sai a 55 fps pelo WebRTC; antes, 5 a 11).
 *
 * Como: o ffmpeg grava a tela (ou uma janela) já na resolução escolhida, em quadros I420 crus; um WebSocket
 * só em 127.0.0.1 (com uma senha de uso único) entrega cada quadro à tela da Chamada, que monta uma faixa de
 * vídeo com eles (MediaStreamTrackGenerator) e transmite como qualquer outra.
 */
import { execFile, spawn, type ChildProcess } from 'child_process'
import { randomBytes } from 'crypto'
import { screen } from 'electron'
import { WebSocketServer, WebSocket } from 'ws'

type LogFn = (level: 'info' | 'warn' | 'error', msg: string) => void

interface Session {
  ff: ChildProcess
  wss: WebSocketServer
}
let current: Session | null = null

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(bin, args, { timeout: 4000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  )
}

export function x11CaptureAvailable(): boolean {
  return process.platform === 'linux' && process.env['XDG_SESSION_TYPE'] !== 'wayland' && !!process.env['DISPLAY']
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Área (em pixels do Xorg) da tela escolhida. Com uma tela só: a área desenhada inteira. */
async function screenRect(sourceId: string, displayId: string): Promise<Rect> {
  const out = await run('xrandr', ['--listmonitors'])
  // ex.: " 0: +*HDMI-0 6144/1600x3456/900+0+0  HDMI-0"
  const monitors = [...out.matchAll(/(\d+)\/\d+x(\d+)\/\d+\+(\d+)\+(\d+)/g)].map((m) => ({
    w: Number(m[1]),
    h: Number(m[2]),
    x: Number(m[3]),
    y: Number(m[4])
  }))
  if (monitors.length === 1) return monitors[0]
  if (!monitors.length) {
    const cur = (await run('xrandr', ['--current'])).match(/current (\d+) x (\d+)/)
    if (!cur) throw new Error('não deu para saber o tamanho da tela')
    return { x: 0, y: 0, w: Number(cur[1]), h: Number(cur[2]) }
  }
  // várias telas: a mesma posição (da esquerda para a direita, de cima para baixo) nas duas listas
  const displays = screen.getAllDisplays().sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
  const idx = Math.max(0, displays.findIndex((d) => String(d.id) === displayId || sourceId.includes(`:${d.id}:`)))
  return monitors.sort((a, b) => a.x - b.x || a.y - b.y)[Math.min(idx, monitors.length - 1)]
}

async function windowSize(xid: number): Promise<{ w: number; h: number }> {
  const out = await run('xwininfo', ['-id', String(xid)])
  const w = Number(out.match(/Width:\s*(\d+)/)?.[1])
  const h = Number(out.match(/Height:\s*(\d+)/)?.[1])
  if (!w || !h) throw new Error('não deu para saber o tamanho da janela')
  return { w, h }
}

/** Tamanho final: cabe em max (mantendo a proporção), nunca maior que a fonte, sempre par (exigência do I420). */
function fit(srcW: number, srcH: number, maxW: number, maxH: number): { w: number; h: number } {
  const r = Math.min(maxW / srcW, maxH / srcH, 1)
  return { w: Math.max(2, Math.floor((srcW * r) / 2) * 2), h: Math.max(2, Math.floor((srcH * r) / 2) * 2) }
}

export function stopX11Capture(): void {
  const s = current
  current = null
  if (!s) return
  s.ff.kill('SIGKILL')
  for (const c of s.wss.clients) c.terminate()
  s.wss.close()
}

export async function startX11Capture(
  opts: { sourceId: string; displayId: string; width: number; height: number; fps: number },
  log: LogFn
): Promise<{ ok: true; port: number; token: string; width: number; height: number; fps: number; region: string } | { ok: false; error: string }> {
  stopX11Capture()
  if (!x11CaptureAvailable()) return { ok: false, error: 'só no Linux com Xorg' }
  try {
    await run('ffmpeg', ['-hide_banner', '-version'])
  } catch {
    return { ok: false, error: 'ffmpeg não encontrado (instale o pacote ffmpeg)' }
  }

  const input: string[] = ['-f', 'x11grab', '-framerate', String(opts.fps), '-draw_mouse', '1']
  let src: { w: number; h: number }
  let region: string
  try {
    if (opts.sourceId.startsWith('window:')) {
      const xid = Number(opts.sourceId.split(':')[1])
      src = await windowSize(xid)
      input.push('-window_id', String(xid), '-i', process.env['DISPLAY']!)
      region = `janela ${xid} (${src.w}x${src.h})`
    } else {
      const r = await screenRect(opts.sourceId, opts.displayId)
      src = { w: r.w, h: r.h }
      input.push('-video_size', `${r.w}x${r.h}`, '-i', `${process.env['DISPLAY']}+${r.x},${r.y}`)
      region = `tela ${r.w}x${r.h} em ${r.x},${r.y}`
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }

  const out = fit(src.w, src.h, opts.width, opts.height)
  const frameSize = (out.w * out.h * 3) / 2
  const token = randomBytes(16).toString('hex')
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 1024 })
  await new Promise<void>((resolve, reject) => {
    wss.once('listening', () => resolve())
    wss.once('error', reject)
  })
  const port = (wss.address() as { port: number }).port

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    ...input,
    '-vf',
    `scale=${out.w}:${out.h}:flags=fast_bilinear,format=yuv420p`,
    '-threads',
    '8',
    '-f',
    'rawvideo',
    '-'
  ]
  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  const session: Session = { ff, wss }
  current = session
  let stderr = ''
  ff.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-1500)))
  ff.on('exit', (code, signal) => {
    if (current !== session) return
    log('error', `a captura (ffmpeg) parou (código ${code ?? signal})${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`)
    stopX11Capture()
  })

  // quadros: monta cada um num espaço fixo e entrega ao cliente; se ele estiver atrasado, descarta (nada acumula)
  let client: WebSocket | null = null
  let frame = Buffer.allocUnsafe(frameSize)
  let filled = 0
  let sent = 0
  let dropped = 0
  ff.stdout?.on('data', (chunk: Buffer) => {
    let off = 0
    while (off < chunk.length) {
      const n = Math.min(frameSize - filled, chunk.length - off)
      chunk.copy(frame, filled, off, off + n)
      filled += n
      off += n
      if (filled === frameSize) {
        if (client && client.readyState === WebSocket.OPEN && client.bufferedAmount < frameSize * 2) {
          client.send(frame)
          sent++
          frame = Buffer.allocUnsafe(frameSize)
        } else dropped++
        filled = 0
      }
    }
  })
  wss.on('connection', (sock, req) => {
    if (!req.url?.includes(token) || client) return sock.close()
    client = sock
    sock.on('close', () => {
      if (current === session) stopX11Capture()
    })
  })
  const report = setInterval(() => {
    if (current !== session) return clearInterval(report)
    if (dropped > sent * 0.2) log('warn', `captura própria: ${dropped} quadros descartados nos últimos 10 s (a tela não acompanhou), ${sent} entregues`)
    sent = 0
    dropped = 0
  }, 10000)

  log('info', `captura própria (ffmpeg x11grab) ligada: ${region} → ${out.w}x${out.h} a ${opts.fps} fps`)
  return { ok: true, port, token, width: out.w, height: out.h, fps: opts.fps, region }
}
