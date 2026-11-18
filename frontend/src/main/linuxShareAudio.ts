/**
 * Som da transmissão no Linux (PipeWire).
 *
 * O Chromium não captura o som do sistema no Linux. Então, ao transmitir com som, o app cria um
 * "microfone virtual" no PipeWire (VoiceAI-Transmissao) e liga a ele as saídas de áudio certas:
 *   - tela inteira: o som de todos os programas, menos o do próprio Voice AI (para quem fala na
 *     chamada não ouvir a própria voz de volta) e menos o backend (voz da IA);
 *   - uma janela: só o som do programa dono daquela janela (X11; no Wayland não dá para saber qual
 *     programa é o dono, então cai no caso da tela inteira).
 * A tela então grava esse microfone virtual como se fosse um microfone comum.
 * Programas que começam a tocar depois são ligados automaticamente (a lista é revista a cada segundo).
 */
import { execFile } from 'child_process'
import { readdirSync, readFileSync } from 'fs'

export const SHARE_SOURCE_LABEL = 'VoiceAI-Transmissao'
const NODE_NAME = 'voiceai_share'

let nodeId: number | null = null
let timer: ReturnType<typeof setInterval> | null = null
let targetPid: number | null = null
let syncing = false
/** portas já ligadas nesta transmissão (para registrar no log só as novas) */
const reported = new Set<string>()

type LogFn = (level: 'info' | 'warn' | 'error', msg: string) => void
let log: LogFn = (level, msg) => (level === 'info' ? console.log : console.warn)('[share-audio]', msg)
/** Para onde vão as mensagens (o log da sala, na tela de Chamada). */
export function setShareAudioLogger(fn: LogFn): void {
  log = fn
}

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 5000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  })
}

// ---------------------------------------------------------------- processos

/** pid → pid do pai, lido de /proc */
function processParents(): Map<number, number> {
  const parents = new Map<number, number>()
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
      // o nome do processo vem entre parênteses e pode ter espaços: o pai é o 2º campo depois do ")"
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
      parents.set(Number(entry), ppid)
    } catch {
      // processo já terminou
    }
  }
  return parents
}

function isInTree(pid: number, root: number, parents: Map<number, number>): boolean {
  for (let p: number | undefined = pid, guard = 0; p && p > 1 && guard < 64; p = parents.get(p), guard++) {
    if (p === root) return true
  }
  return false
}

function isBackend(pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('backend.main')
  } catch {
    return false
  }
}

/** Som que vem do próprio Voice AI (janela, overlay, voz da IA): nunca vai para a transmissão. */
function isOwn(pid: number, parents: Map<number, number>): boolean {
  if (isInTree(pid, process.pid, parents)) return true
  for (let p: number | undefined = pid, guard = 0; p && p > 1 && guard < 64; p = parents.get(p), guard++) {
    if (isBackend(p)) return true
  }
  return false
}

/** Dono de uma janela do X11 (o id da fonte do Electron é "window:<xid>:0"). */
async function windowPid(sourceId: string): Promise<number | null> {
  if (!sourceId.startsWith('window:') || process.env['XDG_SESSION_TYPE'] === 'wayland') return null
  const xid = Number(sourceId.split(':')[1])
  if (!xid) return null
  try {
    const out = await run('xprop', ['-id', String(xid), '_NET_WM_PID'])
    const m = out.match(/=\s*(\d+)/)
    return m ? Number(m[1]) : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- ligações no PipeWire

interface PwObject {
  id: number
  type: string
  info?: { props?: Record<string, unknown>; 'output-port-id'?: number; 'input-port-id'?: number }
}

const CHANNEL_TARGETS: Record<string, string[]> = { FL: ['FL'], FR: ['FR'] }

/** Liga ao microfone virtual as saídas de áudio que devem ir para a transmissão. */
async function syncLinks(): Promise<void> {
  if (syncing) return
  syncing = true
  try {
    const objects = JSON.parse(await run('pw-dump', [])) as PwObject[]
    const props = (o: PwObject | undefined): Record<string, unknown> => o?.info?.props ?? {}
    const virtual = objects.find((o) => o.type === 'PipeWire:Interface:Node' && props(o)['node.name'] === NODE_NAME)
    if (!virtual) {
      log('warn', 'microfone virtual sumiu do PipeWire')
      return
    }
    const ports = objects.filter((o) => o.type === 'PipeWire:Interface:Port')
    const inputs = ports.filter((p) => props(p)['node.id'] === virtual.id && props(p)['port.direction'] === 'in')
    const inputByChannel = new Map(inputs.map((p) => [String(props(p)['audio.channel']), p.id]))
    const linked = new Set(
      objects.filter((o) => o.type === 'PipeWire:Interface:Link').map((l) => `${l.info?.['output-port-id']}>${l.info?.['input-port-id']}`)
    )
    const clients = new Map(objects.filter((o) => o.type === 'PipeWire:Interface:Client').map((c) => [c.id, c]))
    const parents = processParents()

    for (const node of objects) {
      const p = props(node)
      if (node.type !== 'PipeWire:Interface:Node' || p['media.class'] !== 'Stream/Output/Audio') continue
      // alguns programas (ex.: os que usam ALSA) só informam o pid no "cliente" do PipeWire
      const pid = Number(p['application.process.id'] ?? props(clients.get(Number(p['client.id'])))['application.process.id'] ?? 0)
      if (!pid || isOwn(pid, parents)) continue
      if (targetPid && !isInTree(pid, targetPid, parents)) continue
      for (const out of ports) {
        const op = props(out)
        if (op['node.id'] !== node.id || op['port.direction'] !== 'out') continue
        const channels = CHANNEL_TARGETS[String(op['audio.channel'])] ?? ['FL', 'FR'] // mono e outros: nos dois lados
        for (const ch of channels) {
          const input = inputByChannel.get(ch)
          if (input === undefined || linked.has(`${out.id}>${input}`)) continue
          linked.add(`${out.id}>${input}`)
          const app = String(p['application.name'] ?? p['node.name'] ?? 'programa')
          try {
            await run('pw-link', [String(out.id), String(input)])
            const key = `${app}:${pid}`
            if (!reported.has(key)) {
              reported.add(key)
              log('info', `som de "${app}" (pid ${pid}) ligado à transmissão`)
            }
          } catch (e) {
            log('warn', `falha ao ligar o som de "${app}" (pid ${pid}): ${e instanceof Error ? e.message : e}`)
          }
        }
      }
    }
  } catch (e) {
    log('warn', `falha ao ligar as saídas de áudio: ${e instanceof Error ? e.message : e}`)
  } finally {
    syncing = false
  }
}

// ---------------------------------------------------------------- ciclo de vida

/** Nós do microfone virtual que existem agora no PipeWire (pelo nome). */
async function virtualNodes(): Promise<number[]> {
  const objects = JSON.parse(await run('pw-dump', [])) as PwObject[]
  return objects
    .filter((o) => o.type === 'PipeWire:Interface:Node' && o.info?.props?.['node.name'] === NODE_NAME)
    .map((o) => o.id)
}

/** Remove microfones virtuais que tenham sobrado (ex.: o app fechou no meio de uma transmissão). */
async function removeStale(): Promise<void> {
  try {
    for (const id of await virtualNodes()) await run('pw-cli', ['destroy', String(id)]).catch(() => {})
  } catch {
    // nada a limpar
  }
  // instalações antigas criavam pelo pactl (módulo do PulseAudio)
  try {
    const out = await run('pactl', ['list', 'short', 'modules'])
    for (const line of out.split('\n')) {
      if (line.includes(`sink_name=${NODE_NAME}`)) await run('pactl', ['unload-module', line.split('\t')[0]]).catch(() => {})
    }
  } catch {
    // sem pactl
  }
}

/**
 * Cria o microfone virtual só com as ferramentas do próprio PipeWire (pw-cli), sem depender do
 * pactl (pacote pulseaudio-utils, que não vem instalado em todo Ubuntu). Prioridade zero: nunca vira
 * o microfone padrão do computador.
 */
async function createVirtualSource(): Promise<number> {
  const props = [
    'factory.name=support.null-audio-sink',
    `node.name=${NODE_NAME}`,
    `node.description=${SHARE_SOURCE_LABEL}`,
    'media.class=Audio/Source/Virtual',
    'audio.position=[ FL FR ]',
    'object.linger=true',
    'priority.session=0',
    'priority.driver=0',
    'monitor.channel-volumes=false'
  ].join(' ')
  await run('pw-cli', ['create-node', 'adapter', `{ ${props} }`])
  for (let i = 0; i < 20; i++) {
    const [id] = await virtualNodes()
    if (id !== undefined) return id
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('o PipeWire não criou o nó')
}

export async function startLinuxShareAudio(sourceId: string): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  await stopLinuxShareAudio()
  try {
    await run('pw-dump', ['--version'])
    await run('pw-link', ['--version'])
    await run('pw-cli', ['--version'])
  } catch {
    const error = 'O som da transmissão no Linux precisa do PipeWire (pw-dump, pw-link e pw-cli, pacote pipewire-bin).'
    log('error', error)
    return { ok: false, error }
  }
  await removeStale()
  try {
    nodeId = await createVirtualSource()
  } catch (e) {
    const error = `Não foi possível criar o microfone virtual: ${e instanceof Error ? e.message : e}`
    log('error', error)
    return { ok: false, error }
  }
  targetPid = await windowPid(sourceId)
  log(
    'info',
    `microfone virtual criado (nó ${nodeId}); som de ${targetPid ? `só do programa da janela (pid ${targetPid})` : 'todos os programas, menos o Voice AI'}`
  )
  reported.clear()
  await syncLinks()
  timer = setInterval(() => void syncLinks(), 1000)
  return { ok: true, label: SHARE_SOURCE_LABEL }
}

export async function stopLinuxShareAudio(): Promise<void> {
  if (timer) clearInterval(timer)
  timer = null
  targetPid = null
  const id = nodeId
  nodeId = null
  if (id !== null) {
    await run('pw-cli', ['destroy', String(id)]).catch(() => {})
    log('info', 'microfone virtual removido')
  }
}
