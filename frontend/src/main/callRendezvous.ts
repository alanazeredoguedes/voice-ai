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
  code: string
  hostName: string
  /** quando foi publicado (relógio de quem publicou) */
  ts: number
  /** a sala foi fechada (quem estava hospedando saiu sozinho) */
  closed?: boolean
}

export interface RoomLive {
  code: string
  hostName: string
  ts: number
  names: string[]
  waiting: number
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
  return !!x && typeof x.code === 'string' && /^[a-z0-9]+(-[a-z0-9]+)+$/.test(x.code) && typeof x.ts === 'number'
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

export async function announce(roomId: string, a: Announcement): Promise<void> {
  const res = await fetchWithTimeout(`${NTFY}/${topicFor(roomId)}`, { method: 'POST', body: encrypt(roomId, a) })
  if (!res.ok) throw new Error(`ntfy.sh respondeu HTTP ${res.status}`)
}

/** Publicações das últimas 12 h de cada sala (mais recente primeiro). Uma consulta só para todas. */
export async function lookup(roomIds: string[]): Promise<Map<string, Announcement[]>> {
  const out = new Map<string, Announcement[]>(roomIds.map((id) => [id, []]))
  if (!roomIds.length) return out
  const byTopic = new Map(roomIds.map((id) => [topicFor(id), id]))
  const res = await fetchWithTimeout(`${NTFY}/${[...byTopic.keys()].join(',')}/json?poll=1&since=12h`)
  if (!res.ok) throw new Error(`ntfy.sh respondeu HTTP ${res.status}`)
  for (const line of (await res.text()).split('\n')) {
    try {
      const ev = JSON.parse(line)
      const roomId = byTopic.get(ev.topic)
      if (ev.event !== 'message' || !roomId || typeof ev.message !== 'string') continue
      const a = decrypt(roomId, ev.message)
      if (validAnnouncement(a)) out.get(roomId)!.push({ ...a, hostName: String(a.hostName ?? '').slice(0, 40) })
    } catch {
      // linha vazia ou publicação que não é desta sala
    }
  }
  for (const list of out.values()) list.sort((a, b) => b.ts - a.ts)
  return out
}

/** Pergunta ao servidor da sala quem está nela (null = a sala não está no ar nesse código). */
export async function probe(roomId: string, code: string): Promise<{ names: string[]; waiting: number } | null> {
  try {
    const res = await fetchWithTimeout(`https://${code}.trycloudflare.com/presence?k=${presenceKeyFor(roomId)}`, {}, 4000)
    if (!res.ok) return null
    const data = (await res.json()) as { names?: unknown; waiting?: unknown }
    if (!Array.isArray(data.names)) return null
    return { names: data.names.map((n) => String(n).slice(0, 40)).slice(0, 50), waiting: Number(data.waiting) || 0 }
  } catch {
    return null
  }
}

/** A publicação mais recente da sala, se ela estiver no ar agora (e quem está nela). */
export async function liveOf(roomId: string, list: Announcement[]): Promise<RoomLive | null> {
  // se duas cópias estiverem no ar (reabriram juntas), vale a mais antiga: a outra se junta a ela
  return (await liveCopies(roomId, list))[0] ?? null
}

/** Todas as cópias da sala no ar agora (duas pessoas reabriram juntas), da mais antiga para a mais nova. */
export async function liveCopies(roomId: string, list: Announcement[]): Promise<RoomLive[]> {
  const open = list.filter((a) => !a.closed && !list.some((b) => b.closed && b.code === a.code && b.ts >= a.ts))
  const seen = new Set<string>()
  const unique = open.filter((a) => !seen.has(a.code) && seen.add(a.code))
  const probed = await Promise.all(
    unique.slice(0, 5).map(async (a) => {
      const p = await probe(roomId, a.code)
      return p ? { code: a.code, hostName: a.hostName, ts: a.ts, ...p } : null
    })
  )
  return probed.filter((x): x is RoomLive => !!x).sort((a, b) => a.ts - b.ts)
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
