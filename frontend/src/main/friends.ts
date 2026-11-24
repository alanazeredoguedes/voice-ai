/**
 * Amigos (beta): presença (online / ausente / em chamada) e mensagens entre amigos, sem servidor próprio.
 *
 * Mesmo esquema do ponto de encontro das salas (callRendezvous.ts): tudo passa pelo ntfy.sh, em tópicos com
 * nome derivado de um segredo e conteúdo cifrado (AES-256-GCM). O ntfy.sh só vê bytes.
 *
 *  - Cada instalação tem um "segredo de presença". Ao virar amigo (dentro de uma chamada, pelo canal P2P),
 *    cada um entrega o seu ao outro. Eu publico meu status no meu tópico de presença; meus amigos ouvem.
 *  - Cada par de amigos tem um "segredo do par" (sorteado por quem pediu a amizade): tópico privado do par,
 *    por onde vão as mensagens e os convites para a chamada.
 *  - O ntfy.sh guarda as publicações por 12 h: quem abre o app recebe o que chegou enquanto estava fora.
 *
 * Para não estourar os limites do ntfy.sh gratuito: presença só é publicada quando muda e, parada, a cada 15 min.
 */
import { app, BrowserWindow, Notification, net, powerMonitor, ipcMain } from 'electron'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { sysLog, type SysLevel } from './sysLog'

const NTFY = 'https://ntfy.sh'
const SAFE_ID = /^[a-zA-Z0-9-]{8,64}$/
const SECRET = /^[0-9a-f]{64}$/
/** sem sinal há mais que isso = offline (heartbeat a cada 15 min, com folga para atraso/suspensão) */
const HEARTBEAT_MS = 15 * 60_000
const ONLINE_WINDOW_S = 35 * 60
/** parado no computador há mais que isso = ausente */
const AWAY_IDLE_S = 10 * 60
const CHAT_LIMIT = 300
const TEXT_LIMIT = 1000

export type PresenceState = 'online' | 'away' | 'in-call' | 'offline'

interface Friend {
  id: string
  name: string
  /** segredo do par (tópico das mensagens) */
  pair: string
  /** segredo de presença do amigo (tópico onde ele publica o status) */
  presence: string
  addedAt: number
  unread: number
}

interface State {
  /** meu segredo de presença */
  presence: string
  friends: Friend[]
}

export interface FriendMessage {
  id: string
  /** userId de quem mandou */
  from: string
  kind: 'msg' | 'invite'
  text: string
  ts: number
  /** convite: código da sala e nome */
  code?: string
  roomName?: string
}

interface Presence {
  state: PresenceState
  name: string
  /** horário do ntfy.sh (s) */
  sTime: number
}

let getDataDir: () => string = () => ''
let state: State = { presence: '', friends: [] }
const presence = new Map<string, Presence>()
let me = { userId: '', name: '', inCall: false }
/** amigo com a conversa aberta na tela (não notifica nem conta como não lida) */
let viewing = ''
let getWindow: () => BrowserWindow | null = () => null

/** log do sistema (aba Logs → Sistema e sistema.log), categoria "amigos". Nunca o texto das mensagens. */
const flog = (level: SysLevel, msg: string): void => sysLog(level, 'amigos', msg)
/** "Fulano (1a2b3c4d)": nome e o começo do id, para seguir a mesma pessoa no log dos dois lados */
function who(friendId: string): string {
  const f = state.friends.find((x) => x.id === friendId)
  return `${f?.name ?? '?'} (${friendId.slice(0, 8)})`
}

const sha = (s: string): Buffer => createHash('sha256').update(s).digest()
const presenceTopic = (secret: string): string => `vap${sha(`voiceai-presence-topic:${secret}`).toString('hex').slice(0, 40)}`
const presenceKey = (secret: string): Buffer => sha(`voiceai-presence-key:${secret}`)
const pairTopic = (secret: string): string => `vam${sha(`voiceai-pair-topic:${secret}`).toString('hex').slice(0, 40)}`
const pairKey = (secret: string): Buffer => sha(`voiceai-pair-key:${secret}`)

function encrypt(key: Buffer, data: unknown): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
}

function decrypt(key: Buffer, text: string): unknown {
  const raw = Buffer.from(text, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(12, 28))
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'))
}

// ------------------------------------------------------------------ disco

const dir = (): string => join(getDataDir(), 'friends')
const stateFile = (): string => join(dir(), 'state.json')
const chatFile = (id: string): string => join(dir(), `chat-${id}.json`)

function writeJson(file: string, data: unknown): void {
  mkdirSync(dir(), { recursive: true })
  writeFileSync(`${file}.tmp`, JSON.stringify(data))
  renameSync(`${file}.tmp`, file)
}

function loadState(): void {
  try {
    const s = JSON.parse(readFileSync(stateFile(), 'utf8')) as State
    if (SECRET.test(s.presence)) state = { presence: s.presence, friends: Array.isArray(s.friends) ? s.friends : [] }
  } catch {
    // primeira vez
  }
  if (!SECRET.test(state.presence)) {
    state.presence = randomBytes(32).toString('hex')
    saveState()
  }
}

const saveState = (): void => writeJson(stateFile(), state)

function loadChat(id: string): FriendMessage[] {
  try {
    const list = JSON.parse(readFileSync(chatFile(id), 'utf8'))
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

// ------------------------------------------------------------------ ntfy.sh

/** diferença entre o relógio do ntfy.sh e o desta máquina (s) */
let serverSkew = 0
const serverNow = (): number => Date.now() / 1000 + serverSkew

async function publish(topic: string, body: string, ms = 6000): Promise<void> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    const res = await net.fetch(`${NTFY}/${topic}`, { method: 'POST', body, signal: ctrl.signal, cache: 'no-store' })
    const date = Date.parse(res.headers.get('date') ?? '')
    if (date) serverSkew = (date - Date.now()) / 1000
    if (!res.ok) throw new Error(`ntfy.sh respondeu HTTP ${res.status}`)
  } finally {
    clearTimeout(timer)
  }
}

/** tópico → o que ele é (presença de um amigo ou conversa com um amigo) */
type Route = { kind: 'presence' | 'pair'; friendId: string; key: Buffer }

function routes(): Map<string, Route> {
  const m = new Map<string, Route>()
  for (const f of state.friends) {
    m.set(presenceTopic(f.presence), { kind: 'presence', friendId: f.id, key: presenceKey(f.presence) })
    m.set(pairTopic(f.pair), { kind: 'pair', friendId: f.id, key: pairKey(f.pair) })
  }
  return m
}

/** ids das publicações já tratadas (a consulta inicial e a assinatura podem trazer a mesma) */
const seen = new Set<string>()

/** Uma linha do ntfy.sh. `live` = chegou agora pela assinatura (e não na consulta das últimas 12 h). */
function handleLine(byTopic: Map<string, Route>, line: string, live: boolean): void {
  let ev: { event?: string; id?: string; topic?: string; time?: number; message?: string }
  try {
    ev = JSON.parse(line)
  } catch {
    return
  }
  if (ev.event !== 'message' || !ev.topic || typeof ev.message !== 'string' || !ev.id) return
  const route = byTopic.get(ev.topic)
  if (!route || seen.has(ev.id)) return
  seen.add(ev.id)
  if (seen.size > 5000) seen.delete(seen.values().next().value!)
  let data: Record<string, unknown>
  try {
    data = decrypt(route.key, ev.message) as Record<string, unknown>
  } catch {
    flog('warn', `publicação no tópico de ${route.kind === 'presence' ? 'presença' : 'conversa'} de ${who(route.friendId)} não pôde ser lida (segredo diferente ou conteúdo adulterado)`)
    return
  }
  const sTime = Number(ev.time) || 0
  if (route.kind === 'presence') onPresence(route.friendId, data, sTime, live)
  else onPairMessage(route.friendId, data, live)
}

function onPresence(friendId: string, data: Record<string, unknown>, sTime: number, live: boolean): void {
  const st = data.state
  if (st !== 'online' && st !== 'away' && st !== 'in-call' && st !== 'offline') return
  const old = presence.get(friendId)
  if (old && old.sTime > sTime) return // mais antiga que a que já tenho
  presence.set(friendId, { state: st, name: String(data.name ?? '').slice(0, 40), sTime })
  const age = Math.round(serverNow() - sTime)
  if (!old || old.state !== st)
    flog('info', `status de ${who(friendId)}: ${st}${live ? '' : ` (último sinal há ${Math.max(0, Math.round(age / 60))} min)`}`)
  else flog('debug', `sinal de ${who(friendId)}: continua ${st}`)
  const f = state.friends.find((x) => x.id === friendId)
  const name = String(data.name ?? '').trim().slice(0, 40)
  if (f && name && f.name !== name) {
    f.name = name
    saveState()
  }
  changed()
}

function onPairMessage(friendId: string, data: Record<string, unknown>, live: boolean): void {
  const kind = data.kind
  if ((kind !== 'msg' && kind !== 'invite') || typeof data.id !== 'string' || !SAFE_ID.test(data.id)) return
  const msg: FriendMessage = {
    id: data.id,
    from: String(data.from ?? '').slice(0, 64),
    kind,
    text: String(data.text ?? '').slice(0, TEXT_LIMIT),
    ts: Number(data.ts) || Date.now()
  }
  if (kind === 'invite') {
    if (typeof data.code !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)+$/.test(data.code)) return
    msg.code = data.code
    msg.roomName = String(data.roomName ?? '').slice(0, 80)
  }
  const chat = loadChat(friendId)
  if (chat.some((m) => m.id === msg.id)) return
  if (msg.from !== me.userId)
    flog(
      'info',
      `${msg.kind === 'invite' ? `convite para a chamada recebido de ${who(friendId)} (sala "${msg.roomName}", código ${msg.code})` : `mensagem recebida de ${who(friendId)} (${msg.text.length} caracteres)`}${live ? '' : ' - chegou enquanto o app estava fechado'}`
    )
  chat.push(msg)
  chat.sort((a, b) => a.ts - b.ts)
  writeJson(chatFile(friendId), chat.slice(-CHAT_LIMIT))
  const f = state.friends.find((x) => x.id === friendId)
  if (!f || msg.from === me.userId) return changed(friendId)
  const win = getWindow()
  const looking = viewing === friendId && !!win && win.isVisible() && win.isFocused()
  if (!looking) {
    f.unread = (f.unread || 0) + 1
    saveState()
    // na consulta inicial chega o que veio enquanto eu estava fora: notifica só o que tem menos de 12 h (o resto do ntfy já sumiu)
    notify(f, msg, live)
  }
  changed(friendId)
}

function notify(f: Friend, msg: FriendMessage, live: boolean): void {
  if (!Notification.isSupported()) {
    flog('warn', 'notificações do sistema não suportadas aqui: a mensagem só aparece no app')
    return
  }
  const win = getWindow()
  if (win && !win.isFocused()) win.flashFrame(true)
  const title = msg.kind === 'invite' ? `${f.name} está te chamando para a chamada` : live ? f.name : `${f.name} (enquanto você estava fora)`
  const body = msg.kind === 'invite' ? (msg.text || 'Clique para abrir e entrar na chamada') : msg.text
  const n = new Notification({ title: title.slice(0, 100), body: body.slice(0, 300), urgency: msg.kind === 'invite' ? 'critical' : 'normal' })
  flog('info', `notificação mostrada: ${msg.kind === 'invite' ? 'convite' : 'mensagem'} de ${who(f.id)}`)
  n.on('click', () => {
    flog('info', `clicou na notificação de ${msg.kind === 'invite' ? 'convite' : 'mensagem'} de ${who(f.id)}: abrindo a conversa`)
    const w = getWindow()
    if (!w || w.isDestroyed()) return
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
    w.webContents.send('friends:open', f.id)
  })
  n.show()
}

/** avisa a tela (lista de amigos mudou; ou chegou mensagem de um amigo) */
function changed(friendId?: string): void {
  const w = getWindow()
  if (w && !w.isDestroyed()) w.webContents.send('friends:changed', friendId ?? null)
}

// ------------------------------------------------------------------ assinatura (uma conexão para tudo)

let stream: AbortController | null = null
let watchedKey = ''

function resubscribe(): void {
  const byTopic = routes()
  const key = [...byTopic.keys()].sort().join(',')
  if (key === watchedKey) return
  watchedKey = key
  stream?.abort()
  stream = null
  if (!byTopic.size) {
    flog('info', 'nenhum amigo: sem assinatura no ntfy.sh')
    return
  }
  const ctrl = new AbortController()
  stream = ctrl
  void listen(byTopic, ctrl)
}

async function listen(byTopic: Map<string, Route>, ctrl: AbortController): Promise<void> {
  const topics = [...byTopic.keys()].join(',')
  let since = '12h'
  for (let attempt = 0; !ctrl.signal.aborted; attempt++) {
    try {
      // consulta (o que chegou desde `since`) e depois fica ouvindo
      const poll = await net.fetch(`${NTFY}/${topics}/json?poll=1&since=${since}`, { signal: ctrl.signal, cache: 'no-store' })
      if (poll.ok) {
        const lines = (await poll.text()).split('\n').filter(Boolean)
        flog('info', `consulta ao ntfy.sh (últimos ${since}): ${lines.length} publicações de ${byTopic.size / 2} amigo(s)`)
        for (const line of lines) handleLine(byTopic, line, false)
      } else flog('warn', `consulta ao ntfy.sh falhou: HTTP ${poll.status}`)
      since = '5m' // reconexões depois: só o que pode ter passado no intervalo
      const res = await net.fetch(`${NTFY}/${topics}/json`, { signal: ctrl.signal, cache: 'no-store' })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      flog('info', `ouvindo amigos no ntfy.sh em tempo real (${byTopic.size / 2} amigo(s))`)
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
          handleLine(byTopic, buf.slice(0, nl), true)
          buf = buf.slice(nl + 1)
        }
      }
      if (!ctrl.signal.aborted) flog('warn', 'conexão com o ntfy.sh terminou: reconectando')
    } catch (e) {
      // caiu: tenta de novo, esperando mais a cada falha
      if (!ctrl.signal.aborted) flog('warn', `conexão com o ntfy.sh caiu (${e instanceof Error ? e.message : e}): tentando de novo`)
    }
    if (ctrl.signal.aborted) return
    await new Promise((r) => setTimeout(r, Math.min(60_000, 2000 * 2 ** Math.min(attempt, 5))))
  }
}

// ------------------------------------------------------------------ minha presença

let profileTimer: ReturnType<typeof setTimeout> | null = null
let published: { state: PresenceState; name: string; at: number } | null = null
let suspended = false
let offlineSent = false

function currentState(): PresenceState {
  if (suspended) return 'offline'
  if (me.inCall) return 'in-call'
  try {
    if (powerMonitor.getSystemIdleTime() >= AWAY_IDLE_S) return 'away'
  } catch {
    // sem medição de ociosidade
  }
  return 'online'
}

async function publishPresence(st: PresenceState, force = false): Promise<void> {
  if (!me.userId || !state.friends.length) return
  const fresh = published && Date.now() - published.at < HEARTBEAT_MS - 30_000
  if (!force && fresh && published!.state === st && published!.name === me.name) return
  const before = published?.state
  published = { state: st, name: me.name, at: Date.now() }
  try {
    await publish(presenceTopic(state.presence), encrypt(presenceKey(state.presence), { state: st, name: me.name, ts: Date.now() }))
    if (before !== st) flog('info', `meu status publicado para ${state.friends.length} amigo(s): ${st}`)
    else flog('debug', `meu status reenviado (sinal periódico): ${st}`)
  } catch (e) {
    published = null // tenta de novo no próximo ciclo
    flog('warn', `não deu para publicar meu status (${st}): ${e instanceof Error ? e.message : e}`)
  }
}

const tickPresence = (): void => void publishPresence(currentState())

/** Publica "offline" antes de fechar (no máximo ~1,5 s). */
export async function friendsGoOffline(): Promise<void> {
  if (offlineSent || !published) return
  offlineSent = true
  try {
    await publish(presenceTopic(state.presence), encrypt(presenceKey(state.presence), { state: 'offline', name: me.name, ts: Date.now() }), 1500)
    flog('info', 'app fechando: avisei os amigos que fiquei offline')
  } catch (e) {
    // sem rede: os amigos me verão offline quando o último sinal vencer
    flog('warn', `app fechando: não deu para avisar que fiquei offline (${e instanceof Error ? e.message : e})`)
  }
}

// ------------------------------------------------------------------ lista para a tela

function friendView(f: Friend): { id: string; name: string; state: PresenceState; lastSeen: number; unread: number; addedAt: number } {
  const p = presence.get(f.id)
  let st: PresenceState = 'offline'
  if (p && p.state !== 'offline' && serverNow() - p.sTime < ONLINE_WINDOW_S) st = p.state
  return { id: f.id, name: f.name, state: st, lastSeen: p ? p.sTime * 1000 : 0, unread: f.unread || 0, addedAt: f.addedAt }
}

// ------------------------------------------------------------------ IPC

export function registerFriendsIpc(dataDirGetter: () => string, windowGetter: () => BrowserWindow | null): void {
  getDataDir = dataDirGetter
  getWindow = windowGetter
  loadState()
  flog('info', `amigos (beta) iniciado: ${state.friends.length} amigo(s) salvos`)
  // chamado já com o app pronto (net e powerMonitor exigem)
  void app.whenReady().then(() => resubscribe())
  setInterval(tickPresence, 60_000)
  // de tempos em tempos a lista é recalculada (amigo cujo último sinal venceu vira offline)
  setInterval(() => changed(), 60_000)
  powerMonitor.on('suspend', () => {
    suspended = true
    flog('info', 'computador suspenso: publicando offline')
    void publishPresence('offline', true)
  })
  powerMonitor.on('resume', () => {
    suspended = false
    published = null
    flog('info', 'computador voltou da suspensão: vou publicar meu status')
    setTimeout(tickPresence, 5000) // a rede costuma demorar um pouco para voltar
  })

  ipcMain.handle('friends:me', () => ({ presence: state.presence }))

  ipcMain.handle('friends:profile', (_e, p: { userId: string; name: string; inCall: boolean }) => {
    if (!p || !SAFE_ID.test(String(p.userId))) return
    const next = { userId: String(p.userId), name: String(p.name ?? '').trim().slice(0, 40), inCall: !!p.inCall }
    const onlyName = next.userId === me.userId && next.inCall === me.inCall
    me = next
    // mudou só o nome (talvez ainda digitando): espera parar antes de publicar
    if (profileTimer) clearTimeout(profileTimer)
    profileTimer = setTimeout(tickPresence, onlyName ? 5000 : 0)
  })

  ipcMain.handle('friends:list', () => state.friends.map(friendView))

  ipcMain.handle('friends:add', (_e, f: { id: string; name: string; pair: string; presence: string }) => {
    if (!f || !SAFE_ID.test(String(f.id)) || !SECRET.test(String(f.pair)) || !SECRET.test(String(f.presence))) return false
    if (f.id === me.userId) return false
    const existing = state.friends.find((x) => x.id === f.id)
    const name = String(f.name ?? '').trim().slice(0, 40) || 'Amigo'
    flog('info', existing ? `amizade com ${name} (${f.id.slice(0, 8)}) refeita (segredos novos)` : `amigo adicionado: ${name} (${f.id.slice(0, 8)})`)
    if (existing) Object.assign(existing, { name, pair: f.pair, presence: f.presence })
    else state.friends.push({ id: f.id, name, pair: f.pair, presence: f.presence, addedAt: Date.now(), unread: 0 })
    saveState()
    resubscribe()
    published = null // o novo amigo precisa ver meu status agora
    tickPresence()
    changed()
    return true
  })

  ipcMain.handle('friends:remove', (_e, id: string) => {
    flog('info', `amigo removido: ${who(String(id))}`)
    state.friends = state.friends.filter((x) => x.id !== id)
    presence.delete(id)
    if (SAFE_ID.test(String(id))) rmSync(chatFile(id), { force: true })
    saveState()
    resubscribe()
    changed()
  })

  ipcMain.handle('friends:chat', (_e, id: string) => (SAFE_ID.test(String(id)) ? loadChat(id) : []))

  ipcMain.handle('friends:viewing', (_e, id: string | null) => {
    viewing = typeof id === 'string' ? id : ''
    const f = state.friends.find((x) => x.id === viewing)
    if (f && f.unread) {
      f.unread = 0
      saveState()
      changed()
    }
  })

  ipcMain.handle(
    'friends:send',
    async (_e, id: string, m: { kind: 'msg' | 'invite'; text?: string; code?: string; roomName?: string }): Promise<{ ok: true } | { ok: false; error: string }> => {
      const f = state.friends.find((x) => x.id === id)
      if (!f) return { ok: false, error: 'Amigo não encontrado' }
      if (!me.userId) return { ok: false, error: 'App ainda iniciando' }
      const text = String(m?.text ?? '').trim()
      if (m?.kind === 'msg' && !text) return { ok: false, error: 'Mensagem vazia' }
      if (text.length > TEXT_LIMIT) return { ok: false, error: `Mensagem longa demais (máximo ${TEXT_LIMIT} caracteres)` }
      const msg: FriendMessage = { id: randomUUID(), from: me.userId, kind: m?.kind === 'invite' ? 'invite' : 'msg', text, ts: Date.now() }
      if (msg.kind === 'invite') {
        if (!m.code || !/^[a-z0-9]+(-[a-z0-9]+)+$/.test(m.code)) return { ok: false, error: 'Sala sem código' }
        msg.code = m.code
        msg.roomName = String(m.roomName ?? '').slice(0, 80)
      }
      const body = encrypt(pairKey(f.pair), msg)
      if (body.length > 3900) return { ok: false, error: 'Mensagem longa demais (muitos emojis ou acentos): divida em partes' }
      const what = msg.kind === 'invite' ? `convite para a chamada (sala "${msg.roomName}", código ${msg.code})` : `mensagem (${text.length} caracteres)`
      try {
        await publish(pairTopic(f.pair), body)
      } catch (e) {
        flog('warn', `${what} para ${who(f.id)} NÃO enviado: ${e instanceof Error ? e.message : e}`)
        return { ok: false, error: `Não deu para enviar: ${e instanceof Error ? e.message : e}` }
      }
      flog('info', `${what} enviado para ${who(f.id)} (status dele agora: ${friendView(f).state})`)
      const chat = loadChat(f.id)
      if (!chat.some((x) => x.id === msg.id)) {
        chat.push(msg)
        writeJson(chatFile(f.id), chat.slice(-CHAT_LIMIT))
      }
      changed(f.id)
      return { ok: true }
    }
  )
}
