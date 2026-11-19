import { syslog } from '../utils/syslog'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef, watch as vueWatch } from 'vue'
import {
  DEFAULT_PEER_VOLUME,
  MAX_FILE_BYTES,
  useCallRtc,
  JoinDeniedError,
  type AppMessage,
  type CallKnock,
  type CallLogLevel,
  type CallPeer,
  type CallRoomInfo,
  type FileMeta,
  type IncomingFile,
  type NetSample,
  type SignalOptions
} from '../composables/useCallRtc'
import { onWsMessage } from '../api/ws'

export interface ShareQuality {
  label: string
  width: number
  height: number
  fps: number
}

export interface ShareSource {
  id: string
  name: string
  isScreen: boolean
  thumbnail: string | null
}

export interface CallFile extends FileMeta {
  /** bytes já transferidos */
  done: number
  failed: boolean
  /** guardado neste computador (dá para baixar e reabrir depois) */
  stored: boolean
  /** prévia (imagem/vídeo) carregada na memória */
  url: string | null
  /** pedido a quem tem o arquivo */
  requested: boolean
}

export interface CallMessage {
  id: string
  /** identidade fixa de quem escreveu (não muda entre chamadas, diferente do id da conexão) */
  authorId: string
  authorName: string
  text: string
  timestamp: number
  /** quando foi editada pela última vez (0 = nunca) */
  editedAt: number
  files: CallFile[]
}

type StoredMessage = Omit<CallMessage, 'files'> & { files: FileMeta[] }

/** Sala guardada neste computador (o histórico do chat continua entre uma chamada e outra). */
export interface StoredRoom {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  participants: string[]
  messages: StoredMessage[]
  /** mensagens excluídas (para não voltarem quando alguém mandar um histórico antigo) */
  deleted: string[]
}

export interface RoomSummary {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  participants: string[]
  messageCount: number
}

/** O que quem transmite está enviando (vem dele pelo canal direto, a cada segundo). */
export interface ShareSendStats {
  fps: number
  width: number
  height: number
  kbps: number
  limit: string
  availKbps: number | null
  /** quantas pessoas estão assistindo (cada uma recebe uma cópia) */
  viewers: number
  /** quadros por segundo que a captura da tela entrega (antes de comprimir) */
  captureFps: number
  captureWidth: number
  captureHeight: number
  encoder: string
  limitBandwidthPct: number
  limitCpuPct: number
}

/** Diagnóstico da transmissão aberta: o que está limitando a imagem agora. */
export interface StreamDiagnosis {
  level: 'ok' | 'warn' | 'bad'
  text: string
}

/** Uma linha do log da sala (minha ou de outro participante, recebida pelo canal de mensagens). */
export interface CallLogEntry {
  id: string
  /** horário no relógio de quem registrou */
  t: number
  userId: string
  author: string
  level: CallLogLevel
  msg: string
  /** veio de outro participante */
  remote: boolean
}

type HostStart = { ok: true; port: number; code: string; hostToken: string } | { ok: false; error: string }

/** Sala do histórico que está aberta agora (visto pelo ponto de encontro). */
export interface RoomLive {
  code: string
  hostName: string
  ts: number
  /** quem está dentro agora */
  names: string[]
  /** quantos estão esperando alguém aceitar */
  waiting: number
}

const NAME_KEY = 'call.name'
const MIC_GAIN_KEY = 'call.micGain'
const GATE_KEY = 'call.voiceGate'
const GATE_DB_KEY = 'call.voiceGateDb'
const PTT_KEY = 'call.pushToTalk'
const AEC_KEY = 'call.echoCancel'
/** com alguém da chamada falando, quanto mais forte o meu som precisa ser para o microfone abrir */
const ECHO_GUARD_DB = 10

function readSetting(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function saveSetting(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // sem armazenamento: vale só nesta sessão
  }
}
const INPUT_KEY = 'call.audioInput'
const SCREEN_VOLUME_KEY = 'call.screenVolume'
const USER_KEY = 'call.userId'
/** histórico enviado a quem entra: as últimas N mensagens */
const HISTORY_SYNC_LIMIT = 500
/** prévias de imagem/vídeo carregadas na memória até este tamanho */
const PREVIEW_MAX_BYTES = 50 * 1024 * 1024
const SAFE_ID = /^[a-zA-Z0-9-]{8,64}$/
const LOG_MAX = 20000 // ~6 h de chamada com duas pessoas (as medições a cada 10 s são a maior parte)
/** a cada quanto tempo o log ganha o resumo das conexões (taxas, perdas, nível do som) */
const STATS_EVERY_MS = 30_000

export { DEFAULT_PEER_VOLUME }
/** volume do som de uma transmissão ao abrir (a pessoa aumenta se quiser) */
const SCREEN_START_VOLUME = 0.5

/** transmissão aberta = a minha própria (prévia do que estou transmitindo) */
export const SELF = 'self'

const ipc = () => window.electron.ipcRenderer
const IS_LINUX = navigator.userAgent.includes('Linux')

function getUserId(): string {
  let id = localStorage.getItem(USER_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(USER_KEY, id)
  }
  return id
}

/** Aceita o código puro, com espaços, ou o endereço inteiro do túnel colado. */
function parseCode(raw: string): string | null {
  const code = raw
    .trim()
    .toLowerCase()
    .replace(/^(wss|https?):\/\//, '')
    .replace(/\.trycloudflare\.com.*$/, '')
    .replace(/\s+/g, '-')
  return /^[a-z0-9]+(-[a-z0-9]+)+$/.test(code) ? code : null
}

const isPreviewable = (f: FileMeta): boolean =>
  (f.type.startsWith('image/') || f.type.startsWith('video/')) && f.size <= PREVIEW_MAX_BYTES

function validMeta(f: unknown): f is FileMeta {
  const m = f as FileMeta
  return !!m && typeof m.id === 'string' && SAFE_ID.test(m.id) && typeof m.name === 'string' && m.size >= 0 && m.size <= MAX_FILE_BYTES
}

function cleanMeta(f: FileMeta): FileMeta {
  return { id: f.id, name: String(f.name).slice(0, 200), size: Number(f.size), type: String(f.type || '').slice(0, 100) }
}

const newFile = (f: FileMeta): CallFile => ({ ...cleanMeta(f), done: 0, failed: false, stored: false, url: null, requested: false })

export const useCallStore = defineStore('call', () => {
  const userId = getUserId()

  const status = ref<'idle' | 'connecting' | 'in-call'>('idle')
  const error = ref('')
  const code = ref('')
  const isHost = ref(false)
  /** o código já funciona para quem está de fora (leva alguns segundos depois de criar a sala) */
  const codeReady = ref(false)
  /** a sala não aceita mais gente nova (quem criou saiu, ou o túnel caiu) */
  const closedToNewcomers = ref(false)
  const name = ref(localStorage.getItem(NAME_KEY) || '')
  const peers = ref<CallPeer[]>([])
  const muted = ref(false)
  const hasMic = ref(false)
  const sharing = ref(false)
  /** qualidade da minha transmissão (ex.: "1080p · 60 fps") */
  const shareQuality = ref('')
  const micStream = shallowRef<MediaStream | null>(null)
  const mutedPeers = ref<Set<string>>(new Set())
  /** mensagens recebidas com a aba de Chamada fechada */
  const unread = ref(0)
  const viewOpen = ref(false)
  /** volume do áudio da transmissão aberta (0 a 2) */
  const screenVolume = ref(Number(localStorage.getItem(SCREEN_VOLUME_KEY) ?? 1) || 0)
  const screenMuted = ref(false)
  /** volume (sensibilidade) do meu microfone, 0 a 2 */
  const micGain = ref(Number(readSetting(MIC_GAIN_KEY)) || 1)
  /** só envia o microfone quando eu falo (acima do limite) */
  const gateOn = ref(readSetting(GATE_KEY) !== '0')
  const gateDb = ref(Number(readSetting(GATE_DB_KEY)) || -45)
  /** Linux: usar o microfone sem eco (tira o som da caixa de som do microfone) */
  const echoCancel = ref(IS_LINUX && readSetting(AEC_KEY) !== '0')
  const echoCancelActive = ref(false)
  /** nível do microfone agora (dBFS, depois do volume): para ajustar o limite olhando */
  const micLevelDb = ref(-100)
  const gateOpen = ref(false)
  /** "Apertar para falar": o microfone só transmite enquanto o atalho está apertado (vale mais que o portão de voz) */
  const pttOn = ref(readSetting(PTT_KEY) === '1')
  const pttHeld = ref(false)
  let pttReleasedAt = 0
  /** volume da voz de cada participante para mim (0 a 2; sem valor = 100%) */
  const peerVolumes = ref<Record<string, number>>({})

  // sala e histórico
  const room = ref<{ id: string; name: string; createdAt: number; participants: string[] } | null>(null)
  const messages = ref<CallMessage[]>([])
  let deleted = new Set<string>()
  const recentRooms = ref<RoomSummary[]>([])
  /** salas do histórico abertas agora (id → quem está dentro); consultado com a tela de Chamada aberta */
  const roomsLive = ref<Record<string, RoomLive | null>>({})
  /** salas do histórico que alguém está abrindo agora (id → nome de quem) */
  const roomsOpening = ref<Record<string, string>>({})
  /** pedi para entrar e estou esperando alguém de dentro aceitar */
  const waitingApproval = ref(false)
  /** pedidos de entrada para eu (de dentro) aceitar ou recusar */
  const knocks = ref<CallKnock[]>([])
  /** quem hospeda o servidor da sala agora */
  const hostPeerId = ref('')

  // transmissões
  /** transmissão aberta: id do participante, SELF ou null */
  const watching = ref<string | null>(null)
  /** aberta por cima do chat ou minimizada no canto */
  const viewMode = ref<'expanded' | 'mini'>('expanded')
  const viewStream = shallowRef<MediaStream | null>(null)
  /** imagem parada de cada transmissão (enviada por quem transmite ao começar) */
  const thumbs = ref<Record<string, string>>({})

  const inCall = computed(() => status.value === 'in-call')
  const sharingPeers = computed(() => peers.value.filter((p) => p.sharing))

  // ------------------------------------------------------------------ log da sala
  const logs = shallowRef<CallLogEntry[]>([])
  const logIds = new Set<string>()
  /** minhas linhas ainda não enviadas aos outros (vão juntas, a cada segundo) */
  let logOutbox: CallLogEntry[] = []
  let logFlushTimer: ReturnType<typeof setTimeout> | null = null

  function pushLogs(entries: CallLogEntry[]): void {
    const fresh = entries.filter((e) => !logIds.has(e.id))
    if (!fresh.length) return
    for (const e of fresh) logIds.add(e.id)
    let next = [...logs.value, ...fresh]
    if (fresh.some((e) => e.remote)) next.sort((a, b) => a.t - b.t)
    if (next.length > LOG_MAX) {
      for (const e of next.slice(0, next.length - LOG_MAX)) logIds.delete(e.id)
      next = next.slice(-LOG_MAX)
    }
    logs.value = next
  }

  function log(level: CallLogLevel, msg: string): void {
    const entry: CallLogEntry = {
      id: crypto.randomUUID(),
      t: Date.now(),
      userId,
      author: name.value || 'Você',
      level,
      msg: msg.slice(0, 2000),
      remote: false
    }
    ;(level === 'info' ? console.log : console.warn)('[call]', msg)
    // no log do sistema também, menos as medições periódicas (já estão na aba de logs da chamada)
    if (level !== 'info' || !/^\[(estatísticas|qualidade|transmissão)\]/.test(msg)) syslog(level, 'chamada', entry.msg)
    pushLogs([entry])
    logOutbox.push(entry)
    if (!logFlushTimer) logFlushTimer = setTimeout(flushLogs, 1000)
  }

  function flushLogs(): void {
    logFlushTimer = null
    if (!logOutbox.length) return
    const entries = logOutbox.map(toWireLog)
    logOutbox = []
    rtc.broadcast({ kind: 'log', entries })
  }

  const toWireLog = (e: CallLogEntry): Omit<CallLogEntry, 'remote'> => ({
    id: e.id,
    t: e.t,
    userId: e.userId,
    author: e.author,
    level: e.level,
    msg: e.msg
  })

  function receiveLogs(raw: unknown): void {
    if (!Array.isArray(raw)) return
    const entries: CallLogEntry[] = []
    for (const e of raw.slice(0, 1000)) {
      if (!e || typeof e.id !== 'string' || typeof e.msg !== 'string' || e.userId === userId) continue
      entries.push({
        id: e.id.slice(0, 64),
        t: Number(e.t) || Date.now(),
        userId: String(e.userId).slice(0, 64),
        author: String(e.author ?? 'Participante').slice(0, 40),
        level: e.level === 'error' || e.level === 'warn' ? e.level : 'info',
        msg: e.msg.slice(0, 2000),
        remote: true
      })
    }
    pushLogs(entries)
  }

  function clearLogs(): void {
    logs.value = []
    logIds.clear()
  }

  /** Texto do log para copiar e colar (horário, quem, nível, mensagem). */
  function logText(entries: CallLogEntry[] = logs.value): string {
    const time = (t: number): string => {
      const d = new Date(t)
      return `${d.toLocaleTimeString('pt-BR', { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`
    }
    return entries
      .map((e) => `${time(e.t)} [${e.author}${e.remote ? '' : ' (eu)'}] ${e.level.toUpperCase().padEnd(5)} ${e.msg}`)
      .join('\n')
  }

  // erros que aparecem na tela também vão para o log
  vueWatch(error, (msg) => {
    if (msg) log('error', `erro na tela: ${msg}`)
  })

  // erros de programa enquanto há uma chamada (ajuda a achar o que quebrou)
  window.addEventListener('error', (e) => {
    if (status.value !== 'idle') log('error', `erro no app: ${e.message} (${e.filename?.split('/').pop()}:${e.lineno})`)
  })
  window.addEventListener('unhandledrejection', (e) => {
    if (status.value !== 'idle') log('error', `erro no app: ${e.reason instanceof Error ? e.reason.message : String(e.reason)}`)
  })

  // o processo principal (túnel, servidor da sala, som da transmissão no Linux) também registra aqui
  ipc().on('call:log', (_e: unknown, entry: { level: CallLogLevel; msg: string }) => log(entry.level, entry.msg))
  void ipc().invoke('call:log-target')

  // ------------------------------------------------------------------ qualidade da conexão (uma amostra por segundo)
  /** medidas de cada participante (latência, perda, transmissão recebida ou enviada) */
  const netStats = shallowRef<Record<string, NetSample>>({})
  /** o que cada pessoa que transmite está enviando (para saber se o gargalo é dela) */
  const senderStats = shallowRef<Record<string, ShareSendStats>>({})
  /** últimos 60 s da transmissão aberta: quadros por segundo e taxa (kbps) */
  const viewHistory = shallowRef<{ fps: number[]; kbps: number[] }>({ fps: [], kbps: [] })
  /** travadas acumuladas desde o último resumo no log */
  const freezeAcc = new Map<string, { count: number; ms: number }>()
  let sampleTimer: ReturnType<typeof setInterval> | null = null
  let sampling = false

  async function sampleQuality(): Promise<void> {
    if (!inCall.value || sampling) return
    sampling = true
    try {
      const s = await rtc.sampleNet()
      netStats.value = s
      const w = watching.value
      if (w && w !== SELF && s[w]?.video) {
        const v = s[w].video!
        const h = viewHistory.value
        viewHistory.value = { fps: [...h.fps, v.fps].slice(-60), kbps: [...h.kbps, v.kbps].slice(-60) }
      }
      for (const [peerId, sample] of Object.entries(s)) {
        if (sample.video?.freezes) {
          const acc = freezeAcc.get(peerId) ?? { count: 0, ms: 0 }
          freezeAcc.set(peerId, { count: acc.count + sample.video.freezes, ms: acc.ms + sample.video.freezeMs })
        }
      }
      accumulateShareLog(s)
      // quem transmite conta a cada pessoa que assiste o que está saindo para ela
      const viewers = Object.values(s).filter((x) => x.sending).length
      for (const [peerId, sample] of Object.entries(s)) {
        if (sample.sending) rtc.send(peerId, { kind: 'share-stats', ...sample.sending, viewers })
      }
    } catch {
      // amostra perdida: a próxima vem em 1 s
    } finally {
      sampling = false
    }
  }

  // ------------------------------------------------------------------ log da transmissão a cada 10 s
  // Junta as amostras de 1 s e, a cada 10, escreve no log da sala uma linha por transmissão: o que a captura
  // entrega, o que é enviado e o que chega, com mínimos e médias. É o que permite saber onde está o gargalo.
  const SHARE_LOG_EVERY = 10
  type Acc = { n: number; v: Record<string, number[]>; last: Record<string, string> }
  const shareAcc = new Map<string, Acc>()
  const push = (acc: Acc, key: string, value: number): void => {
    ;(acc.v[key] ??= []).push(value)
  }
  const avg = (xs: number[] = []): number => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0)
  const min = (xs: number[] = []): number => (xs.length ? Math.min(...xs) : 0)
  const sum = (xs: number[] = []): number => xs.reduce((a, b) => a + b, 0)

  function accumulateShareLog(sample: Record<string, NetSample>): void {
    const w = watching.value
    for (const [peerId, n] of Object.entries(sample)) {
      // envio da minha tela para esta pessoa
      if (n.sending) {
        const acc = shareAcc.get(`send:${peerId}`) ?? { n: 0, v: {}, last: {} }
        acc.n++
        push(acc, 'cap', n.sending.captureFps)
        push(acc, 'fps', n.sending.fps)
        push(acc, 'kbps', n.sending.kbps)
        push(acc, 'avail', n.sending.availKbps ?? 0)
        push(acc, 'rtt', n.rtt ?? 0)
        push(acc, 'pli', n.sending.pli)
        push(acc, 'nack', n.sending.nack)
        acc.last = {
          res: `${n.sending.width}x${n.sending.height}`,
          capRes: `${n.sending.captureWidth}x${n.sending.captureHeight}`,
          limit: n.sending.limit,
          encoder: n.sending.encoder,
          limitPct: `banda ${n.sending.limitBandwidthPct}% do tempo, processador ${n.sending.limitCpuPct}%`
        }
        shareAcc.set(`send:${peerId}`, acc)
        if (acc.n >= SHARE_LOG_EVERY) {
          const who = peers.value.find((p) => p.id === peerId)?.name ?? 'participante'
          const cap = avg(acc.v.cap)
          const chosen = shareQualityFps()
          log(
            'info',
            `[transmissão] minha tela → ${who}: captura ${acc.last.capRes} ${cap} fps (mín ${min(acc.v.cap)}) | enviado ${acc.last.res} ${avg(acc.v.fps)} fps (mín ${min(acc.v.fps)}), ${avg(acc.v.kbps)} kbps | ` +
              `banda estimada ${avg(acc.v.avail)} kbps | limitado agora por: ${acc.last.limit} (${acc.last.limitPct}) | codificador ${acc.last.encoder} | ` +
              `latência ${avg(acc.v.rtt)} ms | pedidos de reenvio ${sum(acc.v.nack)}, de quadro-chave ${sum(acc.v.pli)} | escolhida ${shareQuality.value}`
          )
          if (chosen && cap < chosen * 0.6) {
            log(
              'warn',
              `[transmissão] a captura da tela está entregando só ${cap} fps (escolhido ${chosen}): o gargalo é a captura neste computador, antes da internet`
            )
          } else if (acc.last.limit === 'bandwidth') {
            log('warn', `[transmissão] o envio para ${who} está limitado pela internet (banda estimada ${avg(acc.v.avail)} kbps)`)
          } else if (acc.last.limit === 'cpu') {
            log('warn', `[transmissão] o envio para ${who} está limitado pelo processador (compressão do vídeo)`)
          }
          shareAcc.delete(`send:${peerId}`)
        }
      }
      // transmissão desta pessoa que estou assistindo
      if (w === peerId && n.video) {
        const acc = shareAcc.get(`recv:${peerId}`) ?? { n: 0, v: {}, last: {} }
        acc.n++
        push(acc, 'fps', n.video.fps)
        push(acc, 'kbps', n.video.kbps)
        push(acc, 'loss', n.video.loss)
        push(acc, 'delay', n.video.delay)
        push(acc, 'fz', n.video.freezes)
        push(acc, 'fzms', n.video.freezeMs)
        push(acc, 'drop', n.video.dropped)
        push(acc, 'rtt', n.rtt ?? 0)
        acc.last = { res: `${n.video.width}x${n.video.height}`, decoder: n.video.decoder }
        shareAcc.set(`recv:${peerId}`, acc)
        if (acc.n >= SHARE_LOG_EVERY) {
          const who = peers.value.find((p) => p.id === peerId)?.name ?? 'participante'
          const snd = senderStats.value[peerId]
          log(
            'info',
            `[transmissão] ${who} → eu: chegando ${acc.last.res} ${avg(acc.v.fps)} fps (mín ${min(acc.v.fps)}), ${avg(acc.v.kbps)} kbps | perda ${avg(acc.v.loss)}% | ` +
              `atraso ~${avg(acc.v.delay)} ms | travadas ${sum(acc.v.fz)} (${sum(acc.v.fzms)} ms) | quadros descartados ${sum(acc.v.drop)} | decodificador ${acc.last.decoder} | latência ${avg(acc.v.rtt)} ms` +
              (snd
                ? ` || do lado de ${who}: captura ${snd.captureWidth}x${snd.captureHeight} ${snd.captureFps} fps, enviando ${snd.width}x${snd.height} ${snd.fps} fps ${snd.kbps} kbps, limitado por: ${snd.limit}, banda ${snd.availKbps ?? '?'} kbps, codificador ${snd.encoder}, ${snd.viewers} assistindo`
                : ` || ${who} não enviou estatísticas (versão antiga)`) +
              ` | escolhida ${peers.value.find((p) => p.id === peerId)?.quality || '?'}`
          )
          shareAcc.delete(`recv:${peerId}`)
        }
      }
    }
  }

  /** fps escolhido na minha transmissão atual (0 = não estou transmitindo) */
  function shareQualityFps(): number {
    return Number(shareQuality.value.match(/(\d+)\s*fps/)?.[1] ?? 0)
  }

  function receiveShareStats(peerId: string, msg: AppMessage): void {
    const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) ? v : 0)
    senderStats.value = {
      ...senderStats.value,
      [peerId]: {
        fps: num(msg.fps),
        width: num(msg.width),
        height: num(msg.height),
        kbps: num(msg.kbps),
        limit: typeof msg.limit === 'string' ? msg.limit.slice(0, 20) : 'none',
        availKbps: typeof msg.availKbps === 'number' ? msg.availKbps : null,
        viewers: num(msg.viewers) || 1,
        captureFps: num(msg.captureFps),
        captureWidth: num(msg.captureWidth),
        captureHeight: num(msg.captureHeight),
        encoder: typeof msg.encoder === 'string' ? msg.encoder.slice(0, 40) : '?',
        limitBandwidthPct: num(msg.limitBandwidthPct),
        limitCpuPct: num(msg.limitCpuPct)
      }
    }
  }

  /** Nível do sinal de um participante (para as barrinhas): 3 bom, 2 médio, 1 ruim, 0 sem medida. */
  function signalLevel(peerId: string): number {
    const n = netStats.value[peerId]
    if (!n || n.rtt === null) return 0
    const loss = n.voiceLoss ?? 0
    if (n.rtt < 120 && loss < 1) return 3
    if (n.rtt < 300 && loss < 5) return 2
    return 1
  }

  /** O que está limitando a transmissão aberta agora (texto curto para a tela). */
  function diagnoseStream(peerId: string): StreamDiagnosis {
    const who = peers.value.find((p) => p.id === peerId)?.name ?? 'quem transmite'
    const recv = netStats.value[peerId]
    const send = senderStats.value[peerId]
    const v = recv?.video
    if (!v) return { level: 'warn', text: 'Aguardando a imagem chegar…' }
    const chosenFps = Number(peers.value.find((p) => p.id === peerId)?.quality.match(/(\d+)\s*fps/)?.[1] ?? 0)
    if (send && chosenFps && send.captureFps > 0 && send.captureFps < chosenFps * 0.6) {
      return {
        level: 'bad',
        text: `A captura da tela de ${who} entrega só ${send.captureFps} fps (escolhido ${chosenFps}): o computador de ${who} não consegue copiar a tela mais rápido. Não é a internet.`
      }
    }
    if (send?.limit === 'bandwidth') {
      const avail = send.availKbps ? ` (~${(send.availKbps / 1000).toFixed(1)} Mbps disponíveis` : ''
      const viewers = send.viewers > 1 ? `${avail ? ', ' : ' ('}para ${send.viewers} pessoas)` : avail ? ')' : ''
      return { level: 'bad', text: `A internet de envio de ${who} está no limite${avail}${viewers}: o WebRTC reduziu a qualidade.` }
    }
    if (send?.limit === 'cpu') return { level: 'bad', text: `O processador de ${who} está no limite: a qualidade foi reduzida para não travar.` }
    if (v.loss >= 3 || v.freezes > 0) return { level: 'bad', text: `A conexão até você está perdendo pacotes (${v.loss}%): a imagem pode travar ou borrar.` }
    if ((recv?.rtt ?? 0) > 300) return { level: 'warn', text: `Latência alta (${recv?.rtt} ms): a imagem chega com atraso.` }
    if (v.loss >= 1) return { level: 'warn', text: `Pequena perda de pacotes (${v.loss}%).` }
    return { level: 'ok', text: 'Sem gargalo: a transmissão está chegando como foi enviada.' }
  }

  /** Resumo de qualidade para o log (a cada 30 s): latência, perda, imagem recebida/enviada e o motivo da limitação. */
  function qualityLines(): string[] {
    const lines: string[] = []
    for (const [peerId, n] of Object.entries(netStats.value)) {
      const who = peers.value.find((p) => p.id === peerId)?.name ?? 'participante'
      const parts = [`latência ${n.rtt ?? '?'} ms`, `rota ${n.route || '?'}`, `perda da voz ${n.voiceLoss ?? '?'}%`, `jitter ${n.jitter ?? '?'} ms`]
      if (n.video) {
        const fz = freezeAcc.get(peerId) ?? { count: 0, ms: 0 }
        parts.push(
          `tela recebida ${n.video.width}x${n.video.height} ${n.video.fps} fps ${n.video.kbps} kbps, perda ${n.video.loss}%, atraso ~${n.video.delay} ms, ${fz.count} travada(s) em 30 s (${fz.ms} ms)`
        )
        const send = senderStats.value[peerId]
        if (send) parts.push(`${who} diz que envia ${send.width}x${send.height} ${send.fps} fps ${send.kbps} kbps, limitado por: ${send.limit}, banda estimada ${send.availKbps ?? '?'} kbps, ${send.viewers} assistindo`)
      }
      if (n.sending) {
        parts.push(`envio da minha tela ${n.sending.width}x${n.sending.height} ${n.sending.fps} fps ${n.sending.kbps} kbps, limitado por: ${n.sending.limit}, banda estimada ${n.sending.availKbps ?? '?'} kbps`)
      }
      lines.push(`${who}: ${parts.join(' | ')}`)
    }
    freezeAcc.clear()
    return lines
  }

  let statsTimer: ReturnType<typeof setInterval> | null = null
  async function logStats(): Promise<void> {
    if (!inCall.value) return
    for (const line of await rtc.statsSummary()) log('info', `[estatísticas] ${line}`)
    for (const line of qualityLines()) log('info', `[qualidade] ${line}`)
    if (screenLeveler) log('info', `[estatísticas] ganho automático do som da minha tela: ${screenLeveler.describe()}`)
  }

  let rtc = useCallRtc(log)
  const localPeerId = ref(rtc.localPeerId)
  let localScreen: MediaStream | null = null
  /** ganho automático do som da minha tela (ver levelScreenAudio) */
  let screenLeveler: ReturnType<typeof levelScreenAudio> | null = null
  /** o microfone foi mutado pelo ditado (e não pela pessoa): volta sozinho ao terminar */
  let mutedByDictation = false
  /** id fixo de cada participante conectado (peerId → userId) */
  const peerUsers = new Map<string, string>()
  /** arquivos que começaram a chegar antes da mensagem que os cita */
  const pendingFiles = new Map<string, { peerId: string; file: IncomingFile }>()

  // ------------------------------------------------------------------ entrar / sair

  /**
   * Cria uma sala nova ou reabre uma do histórico (`reopenId`). Reabrir primeiro procura no ponto de
   * encontro (ntfy.sh) se alguém já está com a sala aberta: se estiver, entra nela em vez de abrir outra.
   */
  async function create(opts: { roomName?: string; reopenId?: string } = {}): Promise<void> {
    if (status.value !== 'idle' || reopening.value) return
    let claim: string | undefined
    if (opts.reopenId) {
      clearLogs()
      const decision = await decideReopen(opts.reopenId)
      if (decision.kind === 'cancel') return
      if (decision.kind === 'join') return join(decision.code, { keepLogs: true })
      claim = decision.claim
    }
    myClaim = claim
    begin(!!opts.reopenId)
    log('info', opts.reopenId ? `reabrindo a sala ${opts.reopenId}: ninguém está com ela aberta, vou hospedar` : 'criando sala nova (vou hospedar)')
    try {
      if (opts.reopenId) await loadRoom(opts.reopenId)
      else
        room.value = {
          id: crypto.randomUUID(),
          name: opts.roomName?.trim().slice(0, 80) || `Sala de ${name.value || 'você'}`,
          createdAt: Date.now(),
          participants: []
        }
      const r = room.value!
      const res = (await ipc().invoke('call:host-start', { id: r.id, name: r.name })) as HostStart
      if (!res.ok) throw new Error(res.error)
      isHost.value = true
      code.value = res.code
      watchRooms()
      log('info', `sala "${r.name}" no ar com o código ${res.code}`)
      void whenCodeReady(res.code)
      await enter(`ws://127.0.0.1:${res.port}`, 1, res.hostToken)
      noteParticipants()
      scheduleSave()
    } catch (e) {
      fail(e)
    }
  }

  /** O código passou a funcionar de fora: mostra, publica no ponto de encontro e confere se não há outra cópia. */
  async function whenCodeReady(c: string): Promise<void> {
    await ipc().invoke('call:host-ready', c)
    if (code.value !== c || !isHost.value) return
    codeReady.value = true
    await announceRoom()
    // rede de segurança: se mesmo assim duas cópias ficaram no ar, fica a publicada primeiro e a outra se junta a ela
    setTimeout(() => void mergeDuplicate(c), 3000)
    setTimeout(() => void mergeDuplicate(c), 15000)
  }

  async function announceRoom(closed = false): Promise<void> {
    const r = room.value
    if (!r || !code.value) return
    await ipc().invoke('call:rv-announce', r.id, { code: code.value, hostName: name.value || 'Alguém', closed, claim: myClaim })
  }

  // ------------------------------------------------------------------ reabrir sem duas pessoas abrirem cópias da mesma sala
  //
  // Quem vai abrir uma sala primeiro "reserva" no ponto de encontro. A ordem das reservas é a do
  // ntfy.sh (igual para todo mundo): quem reservou primeiro abre; quem chegou depois espera o código
  // dessa pessoa ficar no ar e entra nela. Uma reserva vale 45 s (se quem reservou travar, outro abre).

  /** reserva com que abri a sala atual (vai junto na publicação do código) */
  let myClaim: string | undefined
  /** reabrindo: esperando a vez (ou o código de quem está abrindo) */
  const reopening = ref<{ roomId: string; hint: string } | null>(null)

  type RoomStateRes = { live: RoomLive | null; claims: { claim: string; hostName: string; age: number }[] }

  async function stateOf(roomId: string): Promise<RoomStateRes> {
    const res = (await ipc().invoke('call:rv-state', [roomId]).catch(() => null)) as Record<string, RoomStateRes> | null
    return res?.[roomId] ?? { live: null, claims: [] }
  }

  async function decideReopen(roomId: string): Promise<{ kind: 'join'; code: string } | { kind: 'host'; claim: string } | { kind: 'cancel' }> {
    reopening.value = { roomId, hint: 'Verificando se a sala já está aberta…' }
    error.value = ''
    void ipc().invoke('call:log-target')
    let claim: string | null = null
    const deadline = Date.now() + 90_000
    try {
      while (reopening.value?.roomId === roomId && Date.now() < deadline) {
        const st = await stateOf(roomId)
        if (reopening.value?.roomId !== roomId) break
        if (st.live) {
          log('info', `a sala já está aberta (código ${st.live.code}, com ${st.live.names.join(', ') || 'ninguém'}): entrando nela`)
          return { kind: 'join', code: st.live.code }
        }
        const first = st.claims[0]
        if (first && first.claim === claim) {
          log('info', 'minha reserva é a primeira: vou abrir a sala')
          return { kind: 'host', claim }
        }
        if (first) {
          if (reopening.value.hint.indexOf(first.hostName) < 0) log('info', `${first.hostName} está abrindo a sala agora: aguardando para entrar junto`)
          reopening.value = { roomId, hint: `Aguarde: ${first.hostName || 'outra pessoa'} está abrindo a sala. Você entra assim que ela estiver no ar…` }
        } else if (!claim) {
          claim = crypto.randomUUID()
          log('info', 'ninguém está com a sala aberta: reservando a abertura')
          reopening.value = { roomId, hint: 'Abrindo a sala…' }
          await ipc().invoke('call:rv-announce', roomId, { code: '', hostName: name.value || 'Alguém', opening: true, claim })
          // dá tempo de uma reserva de outra pessoa, feita no mesmo instante, aparecer
          await new Promise((r) => setTimeout(r, 1500))
          continue
        } else {
          // a minha reserva não apareceu (ntfy.sh fora do ar?): abre assim mesmo
          log('warn', 'a reserva não apareceu no ponto de encontro: abrindo a sala assim mesmo')
          return { kind: 'host', claim }
        }
        await new Promise((r) => setTimeout(r, 1200))
      }
      if (reopening.value?.roomId !== roomId) return { kind: 'cancel' }
      log('warn', 'esperei demais: abrindo a sala eu mesmo')
      return { kind: 'host', claim: claim ?? crypto.randomUUID() }
    } finally {
      reopening.value = null
    }
  }

  function cancelReopen(): void {
    if (reopening.value) log('info', 'cancelei a entrada na sala')
    reopening.value = null
  }

  async function mergeDuplicate(myCode: string): Promise<void> {
    const r = room.value
    if (!r || !isHost.value || code.value !== myCode || peers.value.length) return
    const winner = (await stateOf(r.id)).live
    if (!winner || winner.code === myCode || code.value !== myCode || peers.value.length) return
    log('info', `outra pessoa abriu esta mesma sala antes (código ${winner.code}): fechando a minha e entrando na dela`)
    await announceRoom(true)
    leave()
    await join(winner.code, { keepLogs: true })
  }

  async function join(raw: string, opts: { keepLogs?: boolean } = {}): Promise<void> {
    if (status.value !== 'idle') return
    const parsed = parseCode(raw)
    if (!parsed) {
      error.value = 'Código inválido. Ele tem este formato: calm-river-paper-moon'
      return
    }
    begin(opts.keepLogs)
    log('info', `entrando na sala ${parsed}`)
    try {
      isHost.value = false
      code.value = parsed
      codeReady.value = true
      // sala recém-criada pode levar alguns segundos para ficar acessível de fora
      await enter(`wss://${parsed}.trycloudflare.com`, 3)
    } catch (e) {
      fail(e)
    }
  }

  function begin(keepLogs = false): void {
    // log novo a cada chamada (o da anterior fica até aqui, para dar tempo de copiar)
    if (!keepLogs) clearLogs()
    void ipc().invoke('call:log-target')
    error.value = ''
    status.value = 'connecting'
    waitingApproval.value = false
    name.value = name.value.trim().slice(0, 40)
    localStorage.setItem(NAME_KEY, name.value)
  }

  function fail(e: unknown): void {
    const message = e instanceof Error ? e.message : String(e)
    if (status.value === 'idle') return // cancelou enquanto entrava
    log('error', `não foi possível entrar na chamada: ${message}`)
    leave()
    error.value = message
  }

  const signalOptions = (hostToken?: string): SignalOptions => ({
    hostToken,
    getProof: async (tag) => (await ipc().invoke('call:room-proof', tag)) as string | null
  })

  async function enter(wsUrl: string, attempts = 1, hostToken?: string): Promise<void> {
    await openMic(localStorage.getItem(INPUT_KEY) || '')
    for (let i = 1; ; i++) {
      try {
        await rtc.connect(
          wsUrl,
          name.value || 'Convidado',
          {
            onPeers: (list) => {
              for (const p of list)
                if (!peers.value.some((x) => x.id === p.id)) log('info', `voz de ${p.name} começa em ${Math.round(DEFAULT_PEER_VOLUME * 100)}% para mim`)
              peers.value = list
              for (const id of peerUsers.keys()) if (!list.some((p) => p.id === id)) peerUsers.delete(id)
              const keep: Record<string, string> = {}
              for (const [id, data] of Object.entries(thumbs.value))
                if (id === SELF || list.some((p) => p.id === id && p.sharing)) keep[id] = data
              thumbs.value = keep
              noteParticipants()
              syncView()
            },
            onRoom: (info) => void onRoomInfo(info),
            onPeerReady,
            onMessage,
            onFile,
            onSignalingClosed: () => {
              closedToNewcomers.value = true
              knocks.value = []
              void recoverSignaling()
            },
            onWaiting: () => (waitingApproval.value = true),
            onKnocks: (list) => {
              for (const k of list) if (!knocks.value.some((x) => x.id === k.id)) notifyKnock(k)
              knocks.value = list
            }
          },
          signalOptions(hostToken)
        )
        break
      } catch (e) {
        if (i >= attempts || e instanceof JoinDeniedError || status.value === 'idle') throw e
        log('warn', `tentativa ${i} de ${attempts} falhou; tentando de novo em 2,5 s`)
        await new Promise((r) => setTimeout(r, 2500))
      }
    }
    waitingApproval.value = false
    rtc.setScreenVolume(screenMuted.value ? 0 : screenVolume.value)
    status.value = 'in-call'
    const env = (await ipc().invoke('call:log-target').catch(() => null)) as Record<string, string> | null
    log(
      'info',
      `na chamada como "${name.value || 'Convidado'}"` +
        (env ? ` (Voice AI ${env.version}, ${env.platform}${env.session ? `, ${env.session}` : ''}, ${env.packaged})` : '')
    )
    if (statsTimer) clearInterval(statsTimer)
    statsTimer = setInterval(() => void logStats(), STATS_EVERY_MS)
    if (sampleTimer) clearInterval(sampleTimer)
    sampleTimer = setInterval(() => void sampleQuality(), 1000)
  }

  // ------------------------------------------------------------------ pedidos de entrada

  function notifyKnock(k: CallKnock): void {
    log('info', `${k.name} pediu para entrar na sala`)
    if (document.hidden || !document.hasFocus()) {
      try {
        new Notification('Voice AI: pedido para entrar na chamada', { body: `${k.name} quer entrar em "${room.value?.name ?? 'sala'}"` })
      } catch {
        // sem notificações do sistema
      }
    }
  }

  /** Aceita ou recusa quem está pedindo para entrar (qualquer pessoa de dentro pode responder). */
  function answerKnock(peerId: string, accept: boolean): void {
    const k = knocks.value.find((x) => x.id === peerId)
    log('info', `${accept ? 'aceitei' : 'recusei'} a entrada de ${k?.name ?? 'alguém'}`)
    knocks.value = knocks.value.filter((x) => x.id !== peerId)
    rtc.answerKnock(peerId, accept)
  }

  // ------------------------------------------------------------------ servidor da sala caiu: reabre sozinho

  let recovering = false

  /**
   * O servidor da sala (sinalização) caiu: quem hospedava saiu ou o túnel caiu. A chamada continua
   * (as conexões são diretas), mas sem servidor ninguém novo entra e nem dá para renegociar (ex.:
   * começar a transmitir). Então:
   *  - se quem hospeda ainda está na chamada (só o túnel caiu), ele abre outro túnel;
   *  - senão, quem tiver o menor id entre os que ficaram abre um servidor novo;
   *  - o novo código vai para os outros pelo canal direto e para o ponto de encontro (quem está de fora).
   */
  async function recoverSignaling(): Promise<void> {
    if (recovering || !inCall.value) return
    recovering = true
    const r = room.value
    const startedOn = rtc
    try {
      if (isHost.value) {
        log('warn', 'o túnel da sala caiu: abrindo outro')
        const res = (await ipc().invoke('call:tunnel-restart')) as { ok: true; code: string } | { ok: false; error: string }
        if (res.ok && rtc === startedOn) await moveTo(res.code, { hosting: true })
        return
      }
      for (let tick = 0; tick < 120 && inCall.value && rtc === startedOn && !rtc.signalingOpen(); tick++) {
        await new Promise((res) => setTimeout(res, 1000))
        if (rtc.signalingOpen() || !inCall.value || rtc !== startedOn) return
        if (tick < 3) continue // dá um tempo para quem hospeda (ou outra pessoa) se manifestar
        const connected = rtc.connectedPeerIds()
        if (hostPeerId.value && connected.includes(hostPeerId.value)) continue // o anfitrião segue aqui: ele reabre
        const elected = [rtc.localPeerId, ...connected].sort()[0]
        if (elected === rtc.localPeerId) {
          log('info', 'quem hospedava a sala saiu: vou hospedar daqui para a frente')
          await rehost()
          return
        }
        if (tick === 3) log('info', `quem hospedava a sala saiu: ${peers.value.find((p) => p.id === elected)?.name ?? 'outra pessoa'} vai hospedar`)
        // fallback: o código novo não chegou pelo canal direto; procura no ponto de encontro
        if (r && tick % 10 === 9) {
          const live = (await stateOf(r.id)).live
          if (live && live.code !== code.value && !rtc.signalingOpen()) await moveTo(live.code)
        }
      }
    } catch (e) {
      log('error', `não deu para recuperar o servidor da sala: ${e instanceof Error ? e.message : e}`)
    } finally {
      recovering = false
    }
  }

  /** Abro um servidor novo para a sala (o anterior saiu). */
  async function rehost(): Promise<void> {
    const r = room.value
    if (!r) return
    myClaim = undefined
    const res = (await ipc().invoke('call:host-start', { id: r.id, name: r.name })) as HostStart
    if (!res.ok) throw new Error(res.error)
    isHost.value = true
    await rtc.reconnect(`ws://127.0.0.1:${res.port}`, { hostToken: res.hostToken })
    await moveTo(res.code, { hosting: true })
  }

  /**
   * A sala passou a usar o código `c`. Quem hospeda espera o código funcionar de fora, publica e
   * avisa os outros pelo canal direto; os outros se conectam ao servidor novo.
   */
  async function moveTo(c: string, opts: { hosting?: boolean } = {}): Promise<void> {
    code.value = c
    codeReady.value = false
    if (opts.hosting) {
      await ipc().invoke('call:host-ready', c)
      if (code.value !== c) return
      codeReady.value = true
      closedToNewcomers.value = false
      rtc.broadcast({ kind: 'signaling-moved', code: c })
      await announceRoom()
      return
    }
    for (let i = 1; i <= 3; i++) {
      try {
        await rtc.reconnect(`wss://${c}.trycloudflare.com`, { hostToken: undefined })
        codeReady.value = true
        closedToNewcomers.value = false
        log('info', `conectado ao novo servidor da sala (${c})`)
        return
      } catch (e) {
        log('warn', `tentativa ${i} de conectar ao novo servidor da sala falhou: ${e instanceof Error ? e.message : e}`)
        await new Promise((res) => setTimeout(res, 2500))
      }
    }
  }

  function leave(): void {
    if (status.value !== 'idle') log('info', 'saí da chamada')
    // eu hospedava e saio sozinho: avisa no ponto de encontro que a sala fechou
    // (com gente dentro, alguém reabre e publica o código novo)
    if (isHost.value && codeReady.value && !peers.value.length) void announceRoom(true)
    if (statsTimer) clearInterval(statsTimer)
    statsTimer = null
    if (sampleTimer) clearInterval(sampleTimer)
    sampleTimer = null
    shareAcc.clear()
    netStats.value = {}
    senderStats.value = {}
    viewHistory.value = { fps: [], kbps: [] }
    freezeAcc.clear()
    flushLogs()
    flushSave()
    rtc.disconnect()
    if (isHost.value) void ipc().invoke('call:host-stop')
    localScreen?.getTracks().forEach((t) => t.stop())
    localScreen = null
    screenLeveler?.stop()
    screenLeveler = null
    stopOwnCapture()
    if (IS_LINUX) void ipc().invoke('call:linux-audio-stop')
    stopMic()
    void ipc().invoke('call:aec-stop')
    // nova identidade de conexão a cada sala
    rtc = useCallRtc(log)
    localPeerId.value = rtc.localPeerId
    status.value = 'idle'
    error.value = ''
    code.value = ''
    isHost.value = false
    codeReady.value = false
    closedToNewcomers.value = false
    waitingApproval.value = false
    knocks.value = []
    hostPeerId.value = ''
    myClaim = undefined
    peers.value = []
    clearMessages()
    room.value = null
    muted.value = false
    hasMic.value = false
    sharing.value = false
    shareQuality.value = ''
    watching.value = null
    viewStream.value = null
    thumbs.value = {}
    mutedPeers.value = new Set()
    peerVolumes.value = {}
    unread.value = 0
    mutedByDictation = false
    peerUsers.clear()
    pendingFiles.clear()
    void refreshRooms()
  }

  function clearMessages(): void {
    for (const m of messages.value) for (const f of m.files) if (f.url) URL.revokeObjectURL(f.url)
    messages.value = []
    deleted = new Set()
  }

  // ------------------------------------------------------------------ histórico (salvo neste computador)

  async function refreshRooms(): Promise<void> {
    try {
      const list = (await ipc().invoke('call:rooms-list')) as RoomSummary[]
      recentRooms.value = list.sort((a, b) => b.updatedAt - a.updatedAt)
      watchRooms()
    } catch {
      recentRooms.value = []
    }
  }

  /** Acompanha em tempo real (no ponto de encontro) as salas do histórico e a sala atual. */
  function watchRooms(): void {
    const ids = recentRooms.value.slice(0, 20).map((r) => r.id)
    if (room.value) ids.push(room.value.id)
    void ipc().invoke('call:rv-watch', ids)
  }

  /** Quais salas do histórico estão abertas agora (e quem está nelas) ou sendo abertas por alguém. */
  async function refreshLive(): Promise<void> {
    const ids = recentRooms.value.slice(0, 20).map((r) => r.id)
    if (!ids.length) return
    const res = (await ipc().invoke('call:rv-state', ids).catch(() => null)) as Record<string, RoomStateRes> | null
    if (!res) return
    const live: Record<string, RoomLive | null> = {}
    const opening: Record<string, string> = {}
    for (const [id, st] of Object.entries(res)) {
      live[id] = st.live
      if (!st.live && st.claims[0]) opening[id] = st.claims[0].hostName || 'Alguém'
    }
    roomsLive.value = live
    roomsOpening.value = opening
  }

  async function deleteRoom(id: string): Promise<void> {
    await ipc().invoke('call:room-delete', id)
    await refreshRooms()
  }

  /** Carrega o histórico guardado desta sala (se houver) e junta com o que já está na tela. */
  async function loadRoom(id: string, fallbackName = ''): Promise<void> {
    const stored = (await ipc().invoke('call:room-load', id)) as StoredRoom | null
    room.value = {
      id,
      name: stored?.name || fallbackName || 'Sala',
      createdAt: stored?.createdAt || Date.now(),
      participants: stored?.participants ?? []
    }
    if (stored) mergeHistory(stored.messages ?? [], stored.deleted ?? [], true)
  }

  async function onRoomInfo(info: CallRoomInfo): Promise<void> {
    hostPeerId.value = info.hostPeerId
    if (!SAFE_ID.test(info.id) || room.value?.id === info.id) return
    await loadRoom(info.id, info.name)
    watchRooms()
    noteParticipants()
    scheduleSave()
  }

  function noteParticipants(): void {
    if (!room.value) return
    const names = new Set(room.value.participants)
    for (const n of [name.value || 'Você', ...peers.value.map((p) => p.name)]) if (n) names.add(n)
    if (names.size !== room.value.participants.length) {
      room.value.participants = [...names].slice(0, 30)
      scheduleSave()
    }
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null
  function scheduleSave(): void {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(flushSave, 800)
  }

  function flushSave(): void {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    const r = room.value
    if (!r) return
    const data: StoredRoom = {
      id: r.id,
      name: r.name,
      createdAt: r.createdAt,
      updatedAt: Date.now(),
      participants: [...r.participants],
      messages: messages.value.map(toStored),
      deleted: [...deleted].slice(-2000)
    }
    void ipc().invoke('call:room-save', data)
  }

  function toStored(m: CallMessage): StoredMessage {
    return {
      id: m.id,
      authorId: m.authorId,
      authorName: m.authorName,
      text: m.text,
      timestamp: m.timestamp,
      editedAt: m.editedAt,
      files: m.files.map(cleanMeta)
    }
  }

  function fromStored(m: StoredMessage): CallMessage {
    return {
      id: m.id,
      authorId: String(m.authorId),
      authorName: String(m.authorName ?? 'Participante').slice(0, 40),
      text: String(m.text ?? '').slice(0, 4000),
      timestamp: Number(m.timestamp) || Date.now(),
      editedAt: Number(m.editedAt) || 0,
      files: (Array.isArray(m.files) ? m.files : []).filter(validMeta).slice(0, 20).map(newFile)
    }
  }

  /** Junta mensagens (do disco ou de outro participante) com as atuais, sem duplicar. */
  function mergeHistory(incoming: StoredMessage[], incomingDeleted: string[], fromDisk = false): void {
    let changed = false
    for (const id of incomingDeleted) {
      if (typeof id !== 'string' || deleted.has(id)) continue
      deleted.add(id)
      changed = removeMessage(id) || changed
    }
    const added: CallMessage[] = []
    for (const raw of incoming) {
      if (!raw || typeof raw.id !== 'string' || deleted.has(raw.id)) continue
      const current = messages.value.find((m) => m.id === raw.id)
      if (current) {
        if ((Number(raw.editedAt) || 0) > current.editedAt) {
          current.text = String(raw.text ?? '').slice(0, 4000)
          current.editedAt = Number(raw.editedAt)
          changed = true
        }
        continue
      }
      if (added.some((m) => m.id === raw.id)) continue
      added.push(fromStored(raw))
    }
    if (added.length) {
      messages.value = [...messages.value, ...added].sort((a, b) => a.timestamp - b.timestamp)
      changed = true
      void checkStoredFiles(added.map((m) => m.id))
    }
    if (changed && !fromDisk) scheduleSave()
  }

  /** Marca quais arquivos das mensagens já estão neste computador e carrega as prévias. */
  async function checkStoredFiles(messageIds: string[]): Promise<void> {
    const r = room.value
    const files = messages.value.filter((m) => messageIds.includes(m.id)).flatMap((m) => m.files)
    if (!r || !files.length) return
    const have = new Set((await ipc().invoke('call:file-has', r.id, files.map((f) => f.id))) as string[])
    for (const f of files) {
      if (!have.has(f.id)) continue
      f.stored = true
      f.done = f.size
      if (isPreviewable(f) && !f.url) {
        const data = (await ipc().invoke('call:file-read', r.id, f.id)) as Uint8Array<ArrayBuffer> | null
        if (data && !f.url) f.url = URL.createObjectURL(new Blob([data], { type: f.type }))
      }
    }
  }

  // ------------------------------------------------------------------ mensagens

  function findFile(id: string): CallFile | undefined {
    for (const m of messages.value) {
      const f = m.files.find((x) => x.id === id)
      if (f) return f
    }
    return undefined
  }

  function removeMessage(id: string): boolean {
    const index = messages.value.findIndex((m) => m.id === id)
    if (index < 0) return false
    for (const f of messages.value[index].files) if (f.url) URL.revokeObjectURL(f.url)
    messages.value.splice(index, 1)
    return true
  }

  function onPeerReady(peerId: string): void {
    rtc.send(peerId, { kind: 'hello', userId })
    // quem chega recebe o meu log desta chamada (o que aconteceu antes de a pessoa entrar)
    rtc.send(peerId, { kind: 'log', entries: logs.value.filter((e) => !e.remote).slice(-500).map(toWireLog) })
    if (room.value) {
      rtc.send(peerId, {
        kind: 'history',
        roomId: room.value.id,
        messages: messages.value.slice(-HISTORY_SYNC_LIMIT).map(toStored),
        deleted: [...deleted].slice(-2000)
      })
    }
    if (sharing.value && thumbs.value[SELF]) rtc.send(peerId, { kind: 'thumb', data: thumbs.value[SELF] })
  }

  function onMessage(peerId: string, msg: AppMessage): void {
    const author = peerUsers.get(peerId)
    switch (msg.kind) {
      case 'hello':
        if (typeof msg.userId === 'string') peerUsers.set(peerId, msg.userId.slice(0, 64))
        break
      case 'chat': {
        if (!author || typeof msg.id !== 'string' || deleted.has(msg.id)) return
        if (messages.value.some((m) => m.id === msg.id)) return
        const files = (Array.isArray(msg.files) ? msg.files : []).filter(validMeta).slice(0, 20)
        messages.value.push({
          id: msg.id,
          authorId: author,
          authorName: peers.value.find((p) => p.id === peerId)?.name ?? 'Participante',
          text: String(msg.text ?? '').slice(0, 4000),
          timestamp: Date.now(),
          editedAt: 0,
          files: files.map(newFile)
        })
        for (const f of files) {
          const early = pendingFiles.get(f.id)
          if (early) {
            pendingFiles.delete(f.id)
            onFile(early.peerId, early.file)
          }
        }
        if (!viewOpen.value) unread.value++
        log('info', `mensagem recebida de ${peers.value.find((p) => p.id === peerId)?.name ?? 'participante'} (${String(msg.text ?? '').length} caracteres, ${files.length} arquivo(s))`)
        scheduleSave()
        break
      }
      case 'edit': {
        const m = messages.value.find((x) => x.id === msg.id)
        if (!m || !author || m.authorId !== author || typeof msg.text !== 'string') return
        m.text = msg.text.slice(0, 4000)
        m.editedAt = Number(msg.editedAt) || Date.now()
        scheduleSave()
        break
      }
      case 'delete': {
        const m = messages.value.find((x) => x.id === msg.id)
        if (!m || !author || m.authorId !== author) return
        deleted.add(m.id)
        removeMessage(m.id)
        scheduleSave()
        break
      }
      case 'history':
        if (room.value && msg.roomId === room.value.id && Array.isArray(msg.messages)) {
          mergeHistory(msg.messages as StoredMessage[], Array.isArray(msg.deleted) ? (msg.deleted as string[]) : [])
        }
        break
      case 'file-request':
        if (typeof msg.id === 'string') void answerFileRequest(peerId, msg.id)
        break
      case 'log':
        receiveLogs(msg.entries)
        break
      case 'share-stats':
        receiveShareStats(peerId, msg)
        break
      case 'signaling-moved':
        // quem passou a hospedar avisa o código novo pelo canal direto
        if (typeof msg.code === 'string' && /^[a-z0-9]+(-[a-z0-9]+)+$/.test(msg.code) && msg.code !== code.value) {
          log('info', `${peers.value.find((p) => p.id === peerId)?.name ?? 'alguém'} abriu um novo servidor para a sala (${msg.code})`)
          void moveTo(msg.code)
        }
        break
      case 'thumb':
        if (typeof msg.data === 'string' && msg.data.startsWith('data:image/jpeg') && msg.data.length < 300_000) {
          thumbs.value = { ...thumbs.value, [peerId]: msg.data }
        }
        break
    }
  }

  async function answerFileRequest(peerId: string, fileId: string): Promise<void> {
    const r = room.value
    const f = findFile(fileId)
    if (!r || !f?.stored) return
    log('info', `${peers.value.find((p) => p.id === peerId)?.name ?? 'participante'} pediu "${f.name}": enviando`)
    const data = (await ipc().invoke('call:file-read', r.id, fileId)) as Uint8Array<ArrayBuffer> | null
    if (data) rtc.sendFile(new Blob([data], { type: f.type }), cleanMeta(f), { to: peerId })
  }

  function onFile(peerId: string, incoming: IncomingFile): void {
    const f = findFile(incoming.id)
    if (!f) {
      pendingFiles.set(incoming.id, { peerId, file: incoming })
      return
    }
    if (f.stored) return
    f.done = incoming.done
    f.failed = !!incoming.failed
    if (f.failed) f.requested = false
    if (incoming.blob) void storeFile(f, incoming.blob)
  }

  async function storeFile(f: CallFile, blob: Blob): Promise<void> {
    const r = room.value
    if (!r) return
    f.done = f.size
    f.requested = false
    if (isPreviewable(f) && !f.url) f.url = URL.createObjectURL(blob)
    try {
      await ipc().invoke('call:file-store', r.id, f.id, await blob.arrayBuffer())
      f.stored = true
    } catch (e) {
      log('error', `falha ao guardar "${f.name}" neste computador: ${e instanceof Error ? e.message : e}`)
      f.failed = true
    }
  }

  /** acima disso, o texto vai como arquivo .txt (ex.: um log colado), em vez de ser cortado */
  const LONG_TEXT = 4000

  function sendMessage(text: string, files: File[] = []): void {
    if (text.length > LONG_TEXT) {
      const t = new Date()
      const stamp = `${String(t.getHours()).padStart(2, '0')}-${String(t.getMinutes()).padStart(2, '0')}-${String(t.getSeconds()).padStart(2, '0')}`
      files = [new File([text], `texto-${stamp}.txt`, { type: 'text/plain' }), ...files]
      log('info', `texto longo (${text.length} caracteres) enviado como arquivo .txt`)
      text = ''
    }
    const tooBig = files.find((f) => f.size > MAX_FILE_BYTES)
    if (tooBig) {
      error.value = `"${tooBig.name}" é grande demais (máximo ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB).`
      return
    }
    error.value = ''
    const picked = files.slice(0, 20)
    const metas: FileMeta[] = picked.map((f) => ({
      id: crypto.randomUUID(),
      name: f.name.slice(0, 200) || 'arquivo',
      size: f.size,
      type: (f.type || '').slice(0, 100)
    }))
    messages.value.push({
      id: crypto.randomUUID(),
      authorId: userId,
      authorName: name.value || 'Você',
      text: text.slice(0, 4000),
      timestamp: Date.now(),
      editedAt: 0,
      files: metas.map((m) => ({ ...newFile(m), done: m.size }))
    })
    const live = messages.value[messages.value.length - 1]
    log('info', `mensagem enviada (${live.text.length} caracteres, ${metas.length} arquivo(s)) para ${peers.value.length} participante(s)`)
    rtc.broadcast({ kind: 'chat', id: live.id, text: live.text, files: metas })
    metas.forEach((meta, i) => {
      rtc.sendFile(picked[i], meta)
      void storeFile(live.files[i], picked[i])
    })
    scheduleSave()
  }

  function editMessage(id: string, text: string): void {
    const m = messages.value.find((x) => x.id === id && x.authorId === userId)
    if (!m) return
    m.text = text.slice(0, 4000)
    m.editedAt = Date.now()
    rtc.broadcast({ kind: 'edit', id, text: m.text, editedAt: m.editedAt })
    scheduleSave()
  }

  function deleteMessage(id: string): void {
    const m = messages.value.find((x) => x.id === id && x.authorId === userId)
    if (!m) return
    deleted.add(id)
    removeMessage(id)
    rtc.broadcast({ kind: 'delete', id })
    scheduleSave()
  }

  /** Arquivo de uma mensagem antiga que não está neste computador: pede a quem tiver. */
  function requestFile(f: CallFile): void {
    if (!peers.value.length) {
      error.value = 'Não há ninguém na sala para enviar esse arquivo agora.'
      return
    }
    f.requested = true
    f.failed = false
    f.done = 0
    log('info', `pedindo "${f.name}" a quem tiver o arquivo`)
    rtc.broadcast({ kind: 'file-request', id: f.id })
    // ninguém tinha o arquivo: libera o botão de novo
    setTimeout(() => {
      if (f.requested && f.done === 0) f.requested = false
    }, 15000)
  }

  async function downloadFile(f: CallFile): Promise<void> {
    if (!room.value || !f.stored) return
    const res = (await ipc().invoke('call:file-download', room.value.id, f.id, f.name)) as { ok: boolean }
    if (!res.ok) error.value = 'Não foi possível salvar o arquivo.'
  }

  // ------------------------------------------------------------------ microfone

  // Microfone: o que sai do dispositivo passa por um volume (sensibilidade) e por um "portão" que só
  // deixa passar quando a pessoa fala. No Linux, pode vir do microfone sem eco (ver linuxEchoCancel.ts).
  // O que é enviado aos outros (e o que os medidores mostram) é o resultado disso.
  let micRaw: MediaStream | null = null
  let micChain: { ctx: AudioContext; gain: GainNode; timer: ReturnType<typeof setInterval> } | null = null

  function stopMic(): void {
    micStream.value?.getTracks().forEach((t) => t.stop())
    micStream.value = null
    micRaw?.getTracks().forEach((t) => t.stop())
    micRaw = null
    if (micChain) {
      clearInterval(micChain.timer)
      void micChain.ctx.close()
      micChain = null
    }
    micLevelDb.value = -100
    gateOpen.value = false
  }

  /** Alguém da chamada está falando agora (voz recebida acima de -50 dBFS e não silenciada por mim)? */
  const voiceBuf = new Float32Array(64)
  function othersSpeaking(): boolean {
    for (const p of peers.value) {
      if (mutedPeers.value.has(p.id) || p.muted) continue
      const an = rtc.getPeerAnalyser(p.id)
      if (!an) continue
      an.getFloatTimeDomainData(voiceBuf)
      let peak = 0
      for (const v of voiceBuf) peak = Math.max(peak, Math.abs(v))
      if (peak > 0.006) return true // ≈ -44 dBFS de pico ≈ -50 dBFS de média
    }
    return false
  }

  /** Volume → (medidor) → portão de voz → enviado. Devolve a faixa já tratada. */
  function buildMicChain(input: MediaStream): MediaStream {
    const ctx = new AudioContext()
    const source = ctx.createMediaStreamSource(input)
    const gain = ctx.createGain()
    gain.gain.value = micGain.value
    const meter = ctx.createAnalyser()
    meter.fftSize = 1024
    const gate = ctx.createGain()
    const out = ctx.createMediaStreamDestination()
    source.connect(gain)
    gain.connect(meter)
    gain.connect(gate)
    gate.connect(out)
    void ctx.resume().catch(() => {})

    const buf = new Float32Array(meter.fftSize)
    let lastLoud = 0
    let open = false
    let othersUntil = 0
    let guardLogged = false
    gate.gain.value = gateOn.value || pttOn.value ? 0 : 1
    const timer = setInterval(() => {
      meter.getFloatTimeDomainData(buf)
      let sum = 0
      for (const v of buf) sum += v * v
      const db = 10 * Math.log10(sum / buf.length + 1e-12)
      micLevelDb.value = Math.round(db)
      const now = performance.now()
      // proteção contra retorno: enquanto alguém da chamada fala (e a voz dele sai na caixa de som), o
      // microfone precisa de um som 10 dB mais forte para abrir; o eco fraco da voz dele não volta
      if (gateOn.value && othersSpeaking()) othersUntil = now + 300
      const guard = now < othersUntil ? ECHO_GUARD_DB : 0
      if (guard && !guardLogged) {
        guardLogged = true
        log('info', `proteção contra retorno ativa: com alguém falando, o microfone só abre acima de ${gateDb.value + ECHO_GUARD_DB} dBFS`)
      }
      // abre acima do limite; fecha só depois de 400 ms abaixo dele, para não cortar o fim das palavras
      if (db > gateDb.value + guard) lastLoud = now
      // apertar para falar: aberto enquanto segura, e mais 250 ms depois de soltar (não corta a última palavra)
      const want = pttOn.value
        ? pttHeld.value || now - pttReleasedAt < 250
        : !gateOn.value || now - lastLoud < 400
      if (want !== open) {
        open = want
        gateOpen.value = want
        gate.gain.setTargetAtTime(want ? 1 : 0, ctx.currentTime, want ? 0.005 : 0.06)
      }
    }, 20)
    micChain = { ctx, gain, timer }
    return out.stream
  }

  async function openMic(deviceId: string): Promise<void> {
    stopMic()
    echoCancelActive.value = false
    try {
      let raw: MediaStream | null = null
      if (IS_LINUX && echoCancel.value) raw = await openEchoCancelledMic(deviceId)
      raw ??= await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        video: false
      })
      micRaw = raw
      const stream = buildMicChain(raw)
      stream.getAudioTracks().forEach((t) => (t.enabled = !muted.value))
      micStream.value = stream
      hasMic.value = true
      const track = raw.getAudioTracks()[0]
      const st = track?.getSettings() ?? {}
      log(
        'info',
        `microfone aberto: "${track?.label}" (${st.sampleRate ?? '?'} Hz, eco do navegador ${st.echoCancellation ? 'sim' : 'não'}, ruído ${st.noiseSuppression ? 'sim' : 'não'}, ganho automático ${st.autoGainControl ? 'sim' : 'não'}; ` +
          `cancelamento de eco do sistema ${echoCancelActive.value ? 'ligado' : 'desligado'}, volume ${Math.round(micGain.value * 100)}%, ` +
          `${pttOn.value ? 'apertar para falar' : gateOn.value ? `só quando falo (limite ${gateDb.value} dBFS)` : 'sempre aberto'})`
      )
      await rtc.setMicTrack(stream.getAudioTracks()[0] ?? null)
    } catch (e) {
      // sem microfone ou permissão negada: entra só ouvindo
      log('warn', `sem microfone (entrando só para ouvir): ${e instanceof Error ? `${e.name}: ${e.message}` : e}`)
      stopMic()
      hasMic.value = false
      await rtc.setMicTrack(null)
    }
  }

  /** Linux: microfone sem eco (o PipeWire tira dele o som que sai na caixa de som). null = não deu, usa o comum. */
  async function openEchoCancelledMic(deviceId: string): Promise<MediaStream | null> {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const label = deviceId ? (devices.find((d) => d.deviceId === deviceId)?.label ?? '') : ''
    const res = (await ipc().invoke('call:aec-start', label)) as { ok: true; label: string } | { ok: false; error: string }
    if (!res.ok) return null
    for (let i = 0; i < 20; i++) {
      const device = (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === 'audioinput' && d.label.includes(res.label))
      if (device) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              deviceId: { exact: device.deviceId },
              // os dois juntos: o do PipeWire tira o som do computador (vídeo, música); o do navegador tira o
              // que sobrar da voz dos participantes (ele tem a referência exata, porque é ele quem a toca)
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true
            },
            video: false
          })
          echoCancelActive.value = true
          return stream
        } catch (e) {
          log('warn', `não deu para abrir o microfone sem eco: ${e instanceof Error ? e.message : e}`)
          break
        }
      }
      await new Promise((r) => setTimeout(r, 150))
    }
    log('warn', 'o microfone sem eco não apareceu: usando o microfone comum')
    void ipc().invoke('call:aec-stop')
    return null
  }

  function setMicGain(value: number): void {
    micGain.value = Math.min(Math.max(value, 0), 2)
    if (micChain) micChain.gain.gain.setTargetAtTime(micGain.value, micChain.ctx.currentTime, 0.02)
    saveSetting(MIC_GAIN_KEY, String(micGain.value))
    logVolume('mic', () => `volume do meu microfone: ${Math.round(micGain.value * 100)}%`)
  }

  function setGate(on: boolean): void {
    gateOn.value = on
    saveSetting(GATE_KEY, on ? '1' : '0')
    log('info', on ? `"só transmitir quando eu falar" ligado (limite ${gateDb.value} dBFS)` : '"só transmitir quando eu falar" desligado')
  }

  function setPtt(on: boolean): void {
    pttOn.value = on
    pttHeld.value = false
    saveSetting(PTT_KEY, on ? '1' : '0')
    log('info', on ? '"apertar para falar" ligado: o microfone só transmite enquanto o atalho está apertado' : '"apertar para falar" desligado')
  }

  function setGateDb(db: number): void {
    gateDb.value = Math.round(Math.min(Math.max(db, -80), -10))
    saveSetting(GATE_DB_KEY, String(gateDb.value))
    logVolume('gate', () => `limite de "só quando eu falar": ${gateDb.value} dBFS`)
  }

  async function setEchoCancel(on: boolean): Promise<void> {
    echoCancel.value = on
    saveSetting(AEC_KEY, on ? '1' : '0')
    log('info', on ? 'cancelamento de eco do sistema ligado' : 'cancelamento de eco do sistema desligado')
    if (!on) void ipc().invoke('call:aec-stop')
    if (status.value !== 'idle') await openMic(localStorage.getItem(INPUT_KEY) || '')
  }

  function applyMuted(value: boolean): void {
    if (muted.value !== value) log('info', value ? 'mutei o microfone' : 'desmutei o microfone')
    muted.value = value
    micStream.value?.getAudioTracks().forEach((t) => (t.enabled = !value))
    rtc.setLocalState({ muted: value })
  }

  function toggleMute(): void {
    mutedByDictation = false
    applyMuted(!muted.value)
  }

  /** Ditado/transcrição do Voice AI gravando: os outros não ouvem o que está sendo ditado. */
  function onDictation(recording: boolean): void {
    if (!inCall.value) return
    if (recording && !muted.value) {
      log('info', 'ditado do Voice AI começou: microfone mutado automaticamente')
      mutedByDictation = true
      applyMuted(true)
    } else if (!recording && mutedByDictation) {
      mutedByDictation = false
      applyMuted(false)
    }
  }
  onWsMessage((e) => {
    if (e.type === 'state_changed' && e.state) onDictation(e.state === 'recording')
    if (e.type === 'call_ptt') {
      const held = !!e.pressed
      if (!held && pttHeld.value) pttReleasedAt = performance.now()
      pttHeld.value = held
    }
  })

  // ------------------------------------------------------------------ compartilhamento de tela

  /** Linux com Wayland: o seletor de tela é o do sistema (o app não consegue listar telas sem ele). */
  const isWayland = ref(false)
  void ipc()
    .invoke('call:session-type')
    .then((t: string) => (isWayland.value = t === 'wayland'))
    .catch(() => {})

  async function listSources(): Promise<ShareSource[]> {
    return (await ipc().invoke('call:sources')) as ShareSource[]
  }

  /** Captura pela API de compartilhamento do navegador: permite deixar o som do próprio app de fora. */
  async function captureDisplay(sourceId: string, quality: ShareQuality, withAudio: boolean): Promise<MediaStream> {
    await ipc().invoke('call:capture-pick', { sourceId, audio: withAudio })
    return navigator.mediaDevices.getDisplayMedia({
      video: { width: { max: quality.width }, height: { max: quality.height }, frameRate: { ideal: quality.fps, max: quality.fps } },
      audio: withAudio ? { restrictOwnAudio: true, suppressLocalAudioPlayback: false } : false
    } as DisplayMediaStreamOptions)
  }

  /** Captura antiga do Electron, usada se a outra falhar. */
  async function captureLegacy(sourceId: string, quality: ShareQuality, withAudio: boolean): Promise<MediaStream> {
    const video = {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxWidth: quality.width,
        maxHeight: quality.height,
        maxFrameRate: quality.fps
      }
    }
    const capture = (audio: unknown): Promise<MediaStream> =>
      navigator.mediaDevices.getUserMedia({ audio, video } as unknown as MediaStreamConstraints)
    if (withAudio) {
      try {
        return await capture({ mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } })
      } catch {
        // sem som do sistema (comum no Linux): segue só com o vídeo
      }
    }
    return capture(false)
  }

  async function startShare(sourceId: string, quality: ShareQuality, withAudio: boolean): Promise<void> {
    let stream: MediaStream | null = null
    log('info', `iniciando transmissão: ${sourceId}, ${quality.label} (${quality.width}x${quality.height} ${quality.fps} fps), ${withAudio ? 'com som' : 'sem som'}`)
    // no Linux o som não vem da captura da tela (ver linuxShareAudio abaixo)
    const systemAudio = withAudio && !IS_LINUX
    // trocando de tela no meio da transmissão: o fim da captura antiga não pode encerrar a nova
    localScreen?.getTracks().forEach((t) => (t.onended = null))
    stopOwnCapture()
    // Linux com Xorg: captura própria pelo ffmpeg (o capturador do Chromium não passa de ~10 fps em telas grandes)
    if (IS_LINUX && !isWayland.value) {
      stream = await startOwnCapture(sourceId, quality)
      // tela muito grande: a captura foi limitada (ver maxCaptureFps) e a transmissão segue o fps real
      if (stream && ownCaptureFps && ownCaptureFps < quality.fps) {
        log('warn', `transmissão em ${ownCaptureFps} fps em vez de ${quality.fps}: acima disso esta tela deixaria o computador lento`)
        quality = { ...quality, fps: ownCaptureFps, label: quality.label.replace(/\d+\s*fps/, `${ownCaptureFps} fps`) }
      }
    }
    if (!stream) try {
      // Wayland: a tela já foi escolhida no seletor do sistema; a captura pela API de tela abriria o seletor
      // de novo (e falha com "Invalid capture constraints"), então vai direto pela captura do Electron
      if (isWayland.value) throw new Error('Wayland: usando a captura do Electron')
      stream = await captureDisplay(sourceId, quality, systemAudio)
    } catch (e) {
      log('warn', `captura pela API de tela falhou (${e instanceof Error ? e.message : e}); tentando a captura antiga`)
      try {
        stream = await captureLegacy(sourceId, quality, systemAudio)
      } catch (e2) {
        log('error', `captura antiga também falhou: ${e2 instanceof Error ? e2.message : e2}`)
        error.value = 'Não foi possível capturar essa tela.'
        return
      }
    }
    if (!stream) return
    if (systemAudio && !stream.getAudioTracks().length) log('warn', 'a captura veio sem som do sistema')
    // Linux: o Chromium não captura o som do sistema; ele vem de um microfone virtual do PipeWire
    if (withAudio && IS_LINUX && !stream.getAudioTracks().length) {
      const audio = await linuxShareAudio(sourceId)
      if (audio) stream.addTrack(audio)
    }
    // som da tela sempre "cheio" para quem assiste, mesmo com o volume baixo aqui (quem assiste ajusta lá)
    const rawAudio = stream.getAudioTracks()[0]
    screenLeveler?.stop()
    screenLeveler = null
    if (rawAudio) {
      try {
        screenLeveler = levelScreenAudio(rawAudio)
        stream.removeTrack(rawAudio)
        stream.addTrack(screenLeveler.track)
        log('info', 'som da tela com ganho automático ligado')
      } catch (e) {
        log('warn', `ganho automático do som da tela indisponível (${e instanceof Error ? e.message : e}); enviando o som como está`)
      }
    }
    const track = stream.getVideoTracks()[0]
    // até 30 fps: prioriza nitidez (texto, código); 60/90 fps: prioriza fluidez (vídeo, jogo)
    track.contentHint = quality.fps > 30 ? 'motion' : 'detail'
    track.onended = () => {
      log('info', 'a captura da tela terminou (fechada pelo sistema ou pela janela)')
      void stopShare()
    }
    const vs = track.getSettings()
    void logShareStart(sourceId, quality, track, stream)
    log(
      'info',
      `transmitindo: vídeo ${vs.width}x${vs.height} ${Math.round(vs.frameRate ?? 0)} fps, ${stream.getAudioTracks().length ? `com som ("${rawAudio?.label}")` : 'sem som'}`
    )

    localScreen?.getTracks().forEach((t) => t.stop())
    localScreen = stream
    sharing.value = true
    // taxa máxima proporcional a pixels × quadros (1080p60 ≈ 4,4 Mbps, 2K60 ≈ 7,7 Mbps, 4K60 ≈ 17 Mbps; teto de 20 Mbps).
    // Um teto alto demais fazia o envio empurrar dados além do que a rede aguentava, e a estimativa de banda despencava.
    const vs0 = track.getSettings()
    const px = (vs0.width ?? quality.width) * (vs0.height ?? quality.height)
    const maxBitrate = Math.round(Math.min(20_000_000, Math.max(1_500_000, px * quality.fps * 0.035)))
    log('info', `vídeo da tela limitado a ${(maxBitrate / 1e6).toFixed(1)} Mbps e ${quality.fps} fps (${track.contentHint === 'motion' ? 'prioriza fluidez' : 'prioriza nitidez'})`)
    shareQuality.value = quality.label.replace(' - ', ' · ')
    await rtc.setScreenStream(stream, { maxBitrate, maxFramerate: quality.fps }, shareQuality.value)
    if (watching.value === SELF) watch(SELF) // trocou de tela com a prévia aberta
    void snapshot(stream)
  }

  // ------------------------------------------------------------------ captura própria (Linux com Xorg)
  /** captura própria em andamento: o que fecha a conexão com o ffmpeg */
  let ownCapture: { stop: () => void; info: string } | null = null

  function stopOwnCapture(): void {
    ownCapture?.stop()
    ownCapture = null
    ownCaptureFps = 0
  }
  /** fps que a captura própria realmente usa (pode ser menor que o escolhido em telas muito grandes) */
  let ownCaptureFps = 0

  /**
   * Captura pelo ffmpeg (ver main/linuxX11Capture.ts): os quadros chegam já na resolução escolhida, por um
   * WebSocket local, e viram uma faixa de vídeo comum (MediaStreamTrackGenerator). null = não deu (o motivo vai
   * para o log) e a transmissão usa a captura do Chromium.
   */
  async function startOwnCapture(sourceId: string, quality: ShareQuality): Promise<MediaStream | null> {
    const Generator = (window as unknown as { MediaStreamTrackGenerator?: new (o: { kind: 'video' }) => MediaStreamTrack & { writable: WritableStream<VideoFrame> } })
      .MediaStreamTrackGenerator
    if (!Generator) {
      log('warn', 'captura própria indisponível neste Electron (sem MediaStreamTrackGenerator): usando a do Chromium')
      return null
    }
    const res = (await ipc()
      .invoke('call:x11-capture-start', { sourceId, width: quality.width, height: quality.height, fps: quality.fps })
      .catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))) as
      | { ok: true; port: number; token: string; width: number; height: number; fps: number; region: string }
      | { ok: false; error: string }
    if (!res.ok) {
      log('warn', `captura própria (ffmpeg) indisponível: ${res.error}; usando a do Chromium`)
      return null
    }
    const gen = new Generator({ kind: 'video' })
    const writer = gen.writable.getWriter()
    const ws = new WebSocket(`ws://127.0.0.1:${res.port}/?t=${res.token}`)
    ws.binaryType = 'arraybuffer'
    let writing = false
    let frames = 0
    let skipped = 0
    let closed = false
    const close = (): void => {
      if (closed) return
      closed = true
      ws.close()
      void writer.close().catch(() => {})
      void ipc().invoke('call:x11-capture-stop')
    }
    const firstFrame = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 4000)
      ws.onmessage = (e) => {
        if (!frames) {
          clearTimeout(timer)
          resolve(true)
        }
        frames++
        // a faixa ainda está gravando o quadro anterior: descarta este (nunca acumula atraso)
        if (writing) {
          skipped++
          return
        }
        writing = true
        const frame = new VideoFrame(new Uint8Array(e.data as ArrayBuffer), {
          format: 'I420',
          codedWidth: res.width,
          codedHeight: res.height,
          timestamp: Math.round(performance.now() * 1000)
        })
        writer.write(frame).catch(() => frame.close()).finally(() => (writing = false))
      }
      ws.onerror = () => {
        clearTimeout(timer)
        resolve(false)
      }
    })
    ws.onclose = () => {
      if (!closed) log('warn', 'a captura própria (ffmpeg) foi encerrada')
      close()
    }
    if (!(await firstFrame)) {
      log('warn', 'a captura própria (ffmpeg) não entregou nenhum quadro em 4 s; usando a do Chromium')
      close()
      return null
    }
    const info = `ffmpeg x11grab, ${res.region} → ${res.width}x${res.height} a ${res.fps} fps`
    ownCapture = { stop: close, info }
    ownCaptureFps = res.fps
    const report = setInterval(() => {
      if (closed) return clearInterval(report)
      if (skipped > frames * 0.2) log('warn', `captura própria: ${skipped} de ${frames} quadros descartados nos últimos 10 s (o app não acompanhou)`)
      frames = 0
      skipped = 0
    }, 10000)
    log('info', `captura própria ligada: ${info}`)
    return new MediaStream([gen])
  }

  /** Tudo sobre a transmissão que começou: as telas do computador, o que foi pedido e o que a captura entregou. */
  async function logShareStart(sourceId: string, quality: ShareQuality, track: MediaStreamTrack, stream: MediaStream): Promise<void> {
    try {
      const info = (await ipc().invoke('call:display-info')) as {
        platform: string
        session: string
        desktop: string
        electron: string
        chrome: string
        displays: { id: string; label: string; size: string; scale: number; pixels: string; hz: number; primary: boolean }[]
        framebuffer: string
      }
      const st = track.getSettings() as MediaTrackSettings & { displaySurface?: string; cursor?: string }
      const caps = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities
      const telas = info.displays
        .map((d) => `${d.primary ? '[principal] ' : ''}${d.label || d.id}: ${d.size} lógico, escala ${d.scale}, ${d.pixels} pixels, ${d.hz} Hz`)
        .join('; ')
      log(
        'info',
        `[transmissão] início | sistema ${info.platform}, sessão ${info.session || '?'} (${info.desktop || '?'}), Electron ${info.electron} / Chromium ${info.chrome} | ` +
          `telas: ${telas}` +
          (info.framebuffer ? ` | área desenhada do Xorg: ${info.framebuffer}` : '') +
          ` | fonte: ${sourceId.startsWith('screen:') ? 'tela inteira' : 'janela'} (${sourceId}) | ` +
          `captura: ${ownCapture ? `própria (${ownCapture.info})` : isWayland.value ? 'seletor do sistema (PipeWire)' : IS_LINUX ? 'Xorg pelo Chromium (cópia da tela pela memória, ~10 fps em telas grandes)' : 'API do sistema'} | ` +
          `pedido ${quality.width}x${quality.height} ${quality.fps} fps | entregue ${st.width}x${st.height} ${st.frameRate ?? '?'} fps` +
          (caps.width ? ` | máximo da fonte ${(caps.width as ULongRange).max}x${(caps.height as ULongRange).max}` : '') +
          ` | som: ${stream.getAudioTracks().length ? 'sim' : 'não'} | prioridade: ${track.contentHint || 'padrão'}`
      )
    } catch (e) {
      log('warn', `[transmissão] não deu para ler as informações da tela: ${e instanceof Error ? e.message : e}`)
    }
  }

  /** Som da transmissão no Linux: o app monta o microfone virtual e grava dele. */
  async function linuxShareAudio(sourceId: string): Promise<MediaStreamTrack | null> {
    log('info', 'Linux: criando o microfone virtual para o som da transmissão')
    const res = (await ipc().invoke('call:linux-audio-start', sourceId)) as { ok: true; label: string } | { ok: false; error: string }
    if (!res.ok) {
      error.value = `Transmitindo sem som: ${res.error}`
      return null
    }
    // o microfone virtual leva um instante para aparecer na lista de dispositivos
    for (let i = 0; i < 20; i++) {
      const device = (await navigator.mediaDevices.enumerateDevices()).find(
        (d) => d.kind === 'audioinput' && d.label.includes(res.label)
      )
      if (device) {
        try {
          const audio = await navigator.mediaDevices.getUserMedia({
            audio: {
              deviceId: { exact: device.deviceId },
              // é som de programa, não voz: sem cancelamento de eco, redução de ruído nem ganho automático
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
              channelCount: 2
            }
          })
          log('info', `Linux: gravando do microfone virtual "${device.label}"`)
          return audio.getAudioTracks()[0] ?? null
        } catch (e) {
          log('error', `Linux: não deu para gravar do microfone virtual: ${e instanceof Error ? `${e.name}: ${e.message}` : e}`)
          break
        }
      }
      await new Promise((r) => setTimeout(r, 150))
    }
    void ipc().invoke('call:linux-audio-stop')
    error.value = 'Transmitindo sem som: o microfone virtual não apareceu.'
    return null
  }

  /**
   * Ganho automático do som da tela, antes de enviar: quem transmite costuma ouvir baixo (ex.: YouTube
   * em 20%) e o som saía baixo assim também para quem assiste, que nem em 200% ouvia direito. Aqui o
   * som sobe sozinho até um nível bom (nunca abaixa) e um limitador no fim evita distorção. Em silêncio
   * o ganho fica parado, para não "puxar" o chiado de fundo.
   */
  function levelScreenAudio(input: MediaStreamTrack): { track: MediaStreamTrack; stop: () => void; describe: () => string } {
    const ctx = new AudioContext()
    const source = ctx.createMediaStreamSource(new MediaStream([input]))
    const meter = ctx.createAnalyser()
    meter.fftSize = 2048
    const gain = ctx.createGain()
    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -6
    limiter.knee.value = 0
    limiter.ratio.value = 20
    limiter.attack.value = 0.002
    limiter.release.value = 0.25
    const out = ctx.createMediaStreamDestination()
    source.connect(meter)
    source.connect(gain)
    gain.connect(limiter)
    limiter.connect(out)
    void ctx.resume().catch(() => {})

    const TARGET_DB = -20 // nível médio de música/vídeo bem mixados
    const MAX_GAIN_DB = 24
    const SILENCE_DB = -60
    const buf = new Float32Array(meter.fftSize)
    let gainDb = 0
    let avgDb = -100
    const timer = setInterval(() => {
      meter.getFloatTimeDomainData(buf)
      let sum = 0
      for (const v of buf) sum += v * v
      const db = 10 * Math.log10(sum / buf.length + 1e-12)
      if (db < SILENCE_DB) return
      avgDb = avgDb < -90 ? db : avgDb * 0.9 + db * 0.1 // média de ~1 s
      const want = Math.min(MAX_GAIN_DB, Math.max(0, TARGET_DB - avgDb))
      // sobe devagar (0,5 dB a cada 100 ms) e desce rápido (3 dB), para não estourar num trecho alto
      gainDb = want > gainDb ? Math.min(want, gainDb + 0.5) : Math.max(want, gainDb - 3)
      gain.gain.setTargetAtTime(10 ** (gainDb / 20), ctx.currentTime, 0.05)
    }, 100)

    const track = out.stream.getAudioTracks()[0]
    return {
      track,
      stop: () => {
        clearInterval(timer)
        track.stop()
        input.stop()
        void ctx.close()
      },
      describe: () => `+${gainDb.toFixed(1)} dB (som original em ~${Math.round(avgDb)} dBFS)`
    }
  }

  /** Imagem parada da transmissão para o card da lateral (não fica atualizando). */
  async function snapshot(stream: MediaStream): Promise<void> {
    const video = document.createElement('video')
    video.muted = true
    video.srcObject = stream
    try {
      await video.play()
      await new Promise((r) => setTimeout(r, 400))
      if (localScreen !== stream || !video.videoWidth) return
      const canvas = document.createElement('canvas')
      const scale = Math.min(480 / video.videoWidth, 270 / video.videoHeight, 1)
      canvas.width = Math.round(video.videoWidth * scale)
      canvas.height = Math.round(video.videoHeight * scale)
      canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height)
      const data = canvas.toDataURL('image/jpeg', 0.7)
      thumbs.value = { ...thumbs.value, [SELF]: data }
      rtc.broadcast({ kind: 'thumb', data })
    } catch {
      // sem miniatura: o card mostra só o nome
    } finally {
      video.srcObject = null
    }
  }

  async function stopShare(): Promise<void> {
    if (!localScreen) return
    log('info', 'parei a transmissão')
    stopOwnCapture()
    screenLeveler?.stop()
    screenLeveler = null
    localScreen.getTracks().forEach((t) => {
      t.onended = null
      t.stop()
    })
    localScreen = null
    sharing.value = false
    shareQuality.value = ''
    if (IS_LINUX) void ipc().invoke('call:linux-audio-stop')
    const rest = { ...thumbs.value }
    delete rest[SELF]
    thumbs.value = rest
    await rtc.setScreenStream(null)
    if (watching.value === SELF) watch(null)
  }

  /** Abre uma transmissão (SELF = a minha) por cima do chat; null fecha (para de receber). */
  function watch(target: string | null): void {
    if (target !== watching.value) {
      viewMode.value = 'expanded'
      viewHistory.value = { fps: [], kbps: [] }
      // toda transmissão abre com o som em 50% (e sem mudo); a pessoa aumenta se quiser
      if (target !== null && target !== SELF) {
        screenVolume.value = SCREEN_START_VOLUME
        screenMuted.value = false
        rtc.setScreenVolume(SCREEN_START_VOLUME)
      }
      const who = target === SELF ? 'a minha' : peers.value.find((p) => p.id === target)?.name
      log('info', target === null ? 'fechei a transmissão que estava vendo' : `abri a transmissão ${target === SELF ? 'minha (prévia)' : `de ${who}`}`)
    }
    watching.value = target
    rtc.setWatching(target === SELF ? null : target)
    viewStream.value = target === null ? null : target === SELF ? localScreen : rtc.getPeerScreen(target)
  }

  function setViewMode(mode: 'expanded' | 'mini'): void {
    viewMode.value = mode
  }

  /** A lista de participantes mudou: fecha a transmissão de quem parou de compartilhar ou saiu. */
  function syncView(): void {
    const target = watching.value
    if (target === null || target === SELF) return
    if (!peers.value.some((p) => p.id === target && p.sharing)) watch(null)
    else if (viewStream.value !== rtc.getPeerScreen(target)) viewStream.value = rtc.getPeerScreen(target)
  }

  // ------------------------------------------------------------------ participantes e dispositivos

  /** Mudanças de volume vão para o log só quando a pessoa para de mexer na barra. */
  const volumeLogTimers = new Map<string, ReturnType<typeof setTimeout>>()
  function logVolume(key: string, msg: () => string): void {
    clearTimeout(volumeLogTimers.get(key))
    volumeLogTimers.set(
      key,
      setTimeout(() => {
        volumeLogTimers.delete(key)
        log('info', msg())
      }, 700)
    )
  }
  const pct = (v: number): string => `${Math.round(v * 1000) / 10}%`

  function setVolume(peerId: string, volume: number): void {
    peerVolumes.value = { ...peerVolumes.value, [peerId]: volume }
    rtc.setPeerVolume(peerId, volume)
    logVolume(`peer:${peerId}`, () => `volume da voz de ${peers.value.find((p) => p.id === peerId)?.name ?? 'participante'} para mim: ${pct(volume)}`)
  }

  function togglePeerMute(peerId: string): void {
    const next = new Set(mutedPeers.value)
    if (!next.delete(peerId)) next.add(peerId)
    mutedPeers.value = next
    rtc.setPeerMuted(peerId, next.has(peerId))
    log('info', `${next.has(peerId) ? 'silenciei' : 'voltei a ouvir'} ${peers.value.find((p) => p.id === peerId)?.name ?? 'participante'} (só para mim)`)
  }

  function getPeerAnalyser(peerId: string): AnalyserNode | null {
    return rtc.getPeerAnalyser(peerId)
  }

  function setScreenVolume(volume: number): void {
    screenVolume.value = volume
    screenMuted.value = false
    localStorage.setItem(SCREEN_VOLUME_KEY, String(volume))
    rtc.setScreenVolume(volume)
    logVolume('screen', () => `volume do som da transmissão para mim: ${pct(volume)}`)
  }

  /** Muta só para mim o som da transmissão aberta (sem perder o volume escolhido). */
  function toggleScreenMute(): void {
    screenMuted.value = !screenMuted.value
    rtc.setScreenVolume(screenMuted.value ? 0 : screenVolume.value)
    log('info', screenMuted.value ? 'mutei o som da transmissão (só para mim)' : 'voltei o som da transmissão')
  }

  function setViewOpen(open: boolean): void {
    viewOpen.value = open
    if (open) unread.value = 0
  }

  async function listAudioDevices(): Promise<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }> {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return {
      // o microfone virtual da transmissão (Linux) não é um microfone de verdade
      inputs: devices.filter(
        (d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications' && !d.label.includes('VoiceAI-Transmissao') && !d.label.includes('VoiceAI-Microfone-Sem-Eco')
      ),
      outputs: devices.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
    }
  }

  async function setInputDevice(deviceId: string): Promise<void> {
    log('info', `trocando o microfone para ${deviceId ? deviceId.slice(0, 12) : 'o padrão do sistema'}`)
    localStorage.setItem(INPUT_KEY, deviceId)
    await openMic(deviceId)
  }

  async function setOutputDevice(deviceId: string): Promise<void> {
    log('info', `trocando a saída de som para ${deviceId ? deviceId.slice(0, 12) : 'o padrão do sistema'}`)
    try {
      await rtc.setOutputDevice(deviceId)
    } catch (e) {
      log('error', `falha ao trocar a saída de som: ${e instanceof Error ? e.message : e}`)
      throw e
    }
  }

  const getInputDevice = (): string => localStorage.getItem(INPUT_KEY) || ''
  const getOutputDevice = (): string => rtc.getOutputDevice()

  // o túnel de quem criou a sala caiu: a chamada segue, mas ninguém novo entra
  // publicação nova no ponto de encontro (alguém abriu, fechou ou está abrindo uma sala): atualiza a lista na hora
  let rvTimer: ReturnType<typeof setTimeout> | null = null
  ipc().on('call:rv-changed', () => {
    if (rvTimer) clearTimeout(rvTimer)
    rvTimer = setTimeout(() => {
      rvTimer = null
      if (status.value === 'idle') void refreshLive()
    }, 300)
  })

  ipc().on('call:tunnel-down', () => {
    if (!inCall.value) return
    closedToNewcomers.value = true
    void recoverSignaling()
  })
  vueWatch(closedToNewcomers, (closed) => {
    if (closed) log('warn', 'a sala não aceita mais gente nova (quem criou saiu ou o túnel caiu)')
  })
  // o app vai fechar: grava o histórico antes
  window.addEventListener('beforeunload', flushSave)

  return {
    userId,
    status,
    inCall,
    error,
    code,
    isHost,
    codeReady,
    closedToNewcomers,
    name,
    localPeerId,
    peers,
    sharingPeers,
    room,
    messages,
    recentRooms,
    unread,
    muted,
    hasMic,
    sharing,
    shareQuality,
    watching,
    viewMode,
    viewStream,
    thumbs,
    micStream,
    mutedPeers,
    screenVolume,
    screenMuted,
    toggleScreenMute,
    peerVolumes,
    create,
    join,
    leave,
    refreshRooms,
    deleteRoom,
    toggleMute,
    listSources,
    startShare,
    stopShare,
    watch,
    setViewMode,
    setVolume,
    togglePeerMute,
    getPeerAnalyser,
    setScreenVolume,
    sendMessage,
    editMessage,
    deleteMessage,
    requestFile,
    downloadFile,
    setViewOpen,
    listAudioDevices,
    setInputDevice,
    setOutputDevice,
    getInputDevice,
    getOutputDevice,
    isWayland,
    netStats,
    senderStats,
    viewHistory,
    signalLevel,
    diagnoseStream,
    roomsLive,
    roomsOpening,
    refreshLive,
    reopening,
    cancelReopen,
    micGain,
    gateOn,
    gateDb,
    echoCancel,
    echoCancelActive,
    micLevelDb,
    gateOpen,
    setMicGain,
    setGate,
    setGateDb,
    pttOn,
    pttHeld,
    setPtt,
    setEchoCancel,
    isLinux: IS_LINUX,
    waitingApproval,
    knocks,
    answerKnock,
    logs,
    logText,
    clearLogs,
    log
  }
})
