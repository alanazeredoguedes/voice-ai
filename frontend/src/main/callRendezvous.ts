/**
 * Ponto de encontro das salas (ntfy.sh): guarda só "a sala X está aberta agora no código Y".
 *
 * O código de uma sala muda toda vez que alguém a abre (é o nome aleatório do túnel). Para "Reabrir"
 * entrar na sala que já está aberta (em vez de cada um abrir a sua), quem abre a sala publica o código
 * num tópico do ntfy.sh, e quem tem a sala no histórico consulta esse tópico.
 *
 * Privacidade:
 *  - o nome do tópico é um hash do id da sala, que só quem já esteve na sala conhece;
 *  - o conteúdo vai criptografado (AES-256-GCM, chave derivada do id da sala): o ntfy.sh só vê bytes;
 *  - nada da chamada passa por lá: voz, tela, chat e arquivos continuam direto entre as pessoas (P2P).
 *    O ntfy.sh guarda as publicações por 12 h.
 *
 * Quem está na sala (visto de fora) vem do próprio servidor da sala (GET /presence), não do ntfy.sh.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'
import { net } from 'electron'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'

const NTFY = 'https://ntfy.sh'

export interface Announcement {
  /** código da sala (vazio quando é só uma reserva: "estou abrindo") */
  code: string
  hostName: string
  /** quando foi publicado (relógio de quem publicou) */
  ts: number
  /** a sala foi fechada (quem estava hospedando saiu sozinho) */
  closed?: boolean
  /** reserva: alguém está abrindo a sala agora (o código vem em alguns segundos) */
  opening?: boolean
  /** id da reserva (quem reservou primeiro abre; os outros esperam e entram) */
  claim?: string
  /** horário do ntfy.sh (segundos): a ordem vale para todos, sem depender do relógio de cada máquina */
  sTime?: number
  /** id da publicação no ntfy.sh (desempata publicações no mesmo segundo) */
  mid?: string
}

export interface RoomLive {
  code: string
  hostName: string
  ts: number
  names: string[]
  waiting: number
  /** reserva com que a cópia foi aberta: no desempate vence a menor (igual para todo mundo) */
  claim?: string
}

export interface RoomOpening {
  claim: string
  hostName: string
  /** há quantos segundos foi reservada */
  age: number
}

export interface RoomState {
  live: RoomLive | null
  /** todas as cópias no ar agora (mais de uma = duas pessoas abriram juntas), com a vencedora em `live` */
  copies: RoomLive[]
  /** reservas recentes ainda sem sala no ar, da primeira para a última */
  claims: RoomOpening[]
}

const sha = (s: string): Buffer => createHash('sha256').update(s).digest()

export const topicFor = (roomId: string): string => `vai${sha(`voiceai-topic:${roomId}`).toString('hex').slice(0, 40)}`
const keyFor = (roomId: string): Buffer => sha(`voiceai-key:${roomId}`)
/** quem sabe o id da sala (já esteve nela) prova isso com este valor e entra sem precisar ser aceito */
export const proofFor = (roomId: string): string => sha(`voiceai-member:${roomId}`).toString('hex')
/** identifica a sala sem revelar o id (quem entra pelo código descobre se já esteve nela) */
export const tagFor = (roomId: string): string => sha(`voiceai-tag:${roomId}`).toString('hex').slice(0, 24)
/** ver quem está na sala de fora exige saber o id da sala */
export const presenceKeyFor = (roomId: string): string => sha(`voiceai-presence:${roomId}`).toString('hex')

function encrypt(roomId: string, data: unknown): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyFor(roomId), iv)
  const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
}

function decrypt(roomId: string, text: string): unknown {
  const raw = Buffer.from(text, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', keyFor(roomId), raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(12, 28))
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'))
}

function validAnnouncement(a: unknown): a is Announcement {
  const x = a as Announcement
  if (!x || typeof x.code !== 'string' || typeof x.ts !== 'number') return false
  return x.opening ? typeof x.claim === 'string' && x.claim.length <= 64 : /^[a-z0-9]+(-[a-z0-9]+)+$/.test(x.code)
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 6000): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await net.fetch(url, { ...init, signal: ctrl.signal, cache: 'no-store' })
  } finally {
    clearTimeout(timer)
  }
}

/** diferença entre o relógio do ntfy.sh e o desta máquina (segundos) */
let serverSkew = 0
function noteServerDate(res: Response): void {
  const date = Date.parse(res.headers.get('date') ?? '')
  if (date) serverSkew = (date - Date.now()) / 1000
}
const serverNow = (): number => Date.now() / 1000 + serverSkew

export async function announce(roomId: string, a: Announcement): Promise<void> {
  const res = await fetchWithTimeout(`${NTFY}/${topicFor(roomId)}`, { method: 'POST', body: encrypt(roomId, a) })
  if (!res.ok) throw new Error(`ntfy.sh respondeu HTTP ${res.status}`)
  noteServerDate(res)
  // a própria publicação entra no cache na hora (sem esperar a assinatura trazer)
  try {
    const ev = (await res.json()) as { id?: string; time?: number }
    remember(roomId, { ...a, sTime: ev.time, mid: ev.id })
  } catch {
    // sem o corpo: a assinatura traz
  }
}

// ------------------------------------------------------------------ cache + assinatura em tempo real

/** publicações conhecidas de cada sala (id da publicação → publicação) */
const cache = new Map<string, Map<string, Announcement>>()

function remember(roomId: string, a: Announcement): boolean {
  if (!a.mid) return false
  let m = cache.get(roomId)
  if (!m) cache.set(roomId, (m = new Map()))
  if (m.has(a.mid)) return false
  m.set(a.mid, a)
  return true
}

/** ordem do ntfy.sh: horário do servidor e, no mesmo segundo, o id da publicação (igual para todo mundo) */
const byServerOrder = (a: Announcement, b: Announcement): number =>
  (a.sTime ?? 0) - (b.sTime ?? 0) || String(a.mid).localeCompare(String(b.mid))

function parseEvent(byTopic: Map<string, string>, line: string): { roomId: string; a: Announcement } | null {
  try {
    const ev = JSON.parse(line)
    const roomId = byTopic.get(ev.topic)
    if (ev.event !== 'message' || !roomId || typeof ev.message !== 'string') return null
    const a = decrypt(roomId, ev.message)
    if (!validAnnouncement(a)) return null
    return { roomId, a: { ...a, hostName: String(a.hostName ?? '').slice(0, 40), sTime: Number(ev.time) || 0, mid: String(ev.id) } }
  } catch {
    return null // linha vazia, evento "open"/"keepalive" ou publicação de outra sala
  }
}

/** Uma consulta (sem ficar ouvindo) às publicações das últimas 12 h das salas. */
async function poll(roomIds: string[]): Promise<void> {
  if (!roomIds.length) return
  const byTopic = new Map(roomIds.map((id) => [topicFor(id), id]))
  const res = await fetchWithTimeout(`${NTFY}/${[...byTopic.keys()].join(',')}/json?poll=1&since=12h`)
  if (!res.ok) throw new Error(`ntfy.sh respondeu HTTP ${res.status}`)
  noteServerDate(res)
  for (const line of (await res.text()).split('\n')) {
    const ev = parseEvent(byTopic, line)
    if (ev) remember(ev.roomId, ev.a)
  }
  for (const id of roomIds) primed.add(id)
}

let watched: string[] = []
const primed = new Set<string>()
let stream: AbortController | null = null
let onChange: (() => void) | null = null

/**
 * Fica ouvindo (uma conexão só, aberta) as salas do histórico e a sala atual: uma publicação nova
 * chega aqui na hora, sem gastar consultas (o ntfy.sh limita quantas dá para fazer por minuto).
 */
export function watchRooms(roomIds: string[], changed: () => void): void {
  onChange = changed
  const ids = [...new Set(roomIds)].sort().slice(0, 30)
  if (ids.join() === watched.join()) return
  watched = ids
  stream?.abort()
  stream = null
  if (!ids.length) return
  const ctrl = new AbortController()
  stream = ctrl
  void listen(ids, ctrl)
}

async function listen(ids: string[], ctrl: AbortController): Promise<void> {
  const byTopic = new Map(ids.map((id) => [topicFor(id), id]))
  for (let attempt = 0; !ctrl.signal.aborted; attempt++) {
    try {
      // a consulta enche o cache com as últimas 12 h; a assinatura traz o que for publicado daqui para a frente
      await poll(ids.filter((id) => !primed.has(id))).catch(() => {})
      const res = await net.fetch(`${NTFY}/${[...byTopic.keys()].join(',')}/json`, { signal: ctrl.signal, cache: 'no-store' })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      attempt = 0
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const ev = parseEvent(byTopic, buf.slice(0, nl))
          buf = buf.slice(nl + 1)
          if (ev && remember(ev.roomId, ev.a)) onChange?.()
        }
      }
    } catch {
      // caiu (ou foi trocada): tenta de novo, esperando um pouco mais a cada falha
    }
    if (ctrl.signal.aborted) return
    await new Promise((r) => setTimeout(r, Math.min(30000, 2000 * 2 ** Math.min(attempt, 4))))
  }
}

/** Publicações da sala na ordem do ntfy.sh (consulta na hora se a sala ainda não estiver no cache). */
async function announcementsOf(roomId: string): Promise<Announcement[]> {
  if (!primed.has(roomId)) await poll([roomId])
  return [...(cache.get(roomId)?.values() ?? [])].filter((a) => serverNow() - (a.sTime ?? 0) < 12 * 3600).sort(byServerOrder)
}

// ------------------------------------------------------------------ presença (quem está na sala)

const probeCache = new Map<string, { at: number; result: { names: string[]; waiting: number } | null }>()

/** Pergunta ao servidor da sala quem está nela (null = a sala não está no ar nesse código). */
export async function probe(roomId: string, code: string): Promise<{ names: string[]; waiting: number } | null> {
  const hit = probeCache.get(code)
  if (hit && Date.now() - hit.at < 1500) return hit.result
  let result: { names: string[]; waiting: number } | null = null
  try {
    const res = await fetchWithTimeout(`https://${code}.trycloudflare.com/presence?k=${presenceKeyFor(roomId)}`, {}, 4000)
    if (res.ok) {
      const data = (await res.json()) as { names?: unknown; waiting?: unknown }
      if (Array.isArray(data.names)) {
        result = { names: data.names.map((n) => String(n).slice(0, 40)).slice(0, 50), waiting: Number(data.waiting) || 0 }
      }
    }
  } catch {
    // fora do ar
  }
  probeCache.set(code, { at: Date.now(), result })
  if (probeCache.size > 200) probeCache.delete(probeCache.keys().next().value!)
  return result
}

/** Reservas valem por 45 s: depois disso, quem reservou desistiu ou travou. */
const CLAIM_TTL = 45

/**
 * Situação da sala agora:
 *  - `live`: a cópia no ar (se duas pessoas abriram juntas, vale a publicada primeiro no ntfy.sh);
 *  - `claims`: quem está abrindo agora (reservas recentes), na ordem do ntfy.sh.
 */
export async function roomState(roomId: string): Promise<RoomState> {
  const list = await announcementsOf(roomId)
  const isClosed = (a: Announcement): boolean => list.some((b) => b.closed && b.code === a.code && byServerOrder(b, a) > 0)
  const seen = new Set<string>()
  const open = list.filter((a) => !a.opening && !a.closed && !isClosed(a) && !seen.has(a.code) && !!seen.add(a.code)).slice(-5)
  const probed = await Promise.all(
    open.map(async (a) => {
      const p = await probe(roomId, a.code)
      return p ? { code: a.code, hostName: a.hostName, ts: a.ts, claim: a.claim, ...p } : null
    })
  )
  // desempate igual para todos: a menor reserva vence (quem não tem reserva fica por último e, entre eles,
  // vale a publicada primeiro no ntfy.sh). Assim duas pessoas que abriram juntas concordam sobre qual sala fica.
  const alive: RoomLive[] = []
  for (const x of probed) if (x) alive.push(x)
  const copies = alive
    .map((x, order) => ({ x, order }))
    .sort((a, b) => (a.x.claim ?? '\uffff').localeCompare(b.x.claim ?? '\uffff') || a.order - b.order)
    .map((e) => e.x)
  const live = copies[0] ?? null
  const now = serverNow()
  const claims = live
    ? []
    : list
        .filter((a) => a.opening && a.claim && now - (a.sTime ?? 0) < CLAIM_TTL)
        // reserva que já virou sala (no ar ou fechada depois) não conta mais
        .filter((a) => !list.some((b) => !b.opening && b.claim === a.claim))
        .map((a) => ({ claim: a.claim!, hostName: a.hostName, age: Math.max(0, Math.round(now - (a.sTime ?? 0))) }))
  return { live, copies, claims }
}

/** Qual sala do histórico tem esta etiqueta (para provar que já esteve nela). */
export function roomByTag(callsDir: string, tag: string): string | null {
  if (!/^[0-9a-f]{24}$/.test(tag) || !existsSync(callsDir)) return null
  for (const f of readdirSync(callsDir)) {
    if (!f.endsWith('.json')) continue
    const id = f.slice(0, -5)
    if (tagFor(id) === tag) return id
  }
  return null
}

export function callsDirOf(dataDir: string): string {
  return join(dataDir, 'calls')
}
