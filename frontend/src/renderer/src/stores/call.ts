import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import {
  MAX_FILE_BYTES,
  useCallRtc,
  type AppMessage,
  type CallPeer,
  type CallRoomInfo,
  type FileMeta,
  type IncomingFile
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

type HostStart = { ok: true; port: number; code: string } | { ok: false; error: string }

const NAME_KEY = 'call.name'
const INPUT_KEY = 'call.audioInput'
const SCREEN_VOLUME_KEY = 'call.screenVolume'
const USER_KEY = 'call.userId'
/** histórico enviado a quem entra: as últimas N mensagens */
const HISTORY_SYNC_LIMIT = 500
/** prévias de imagem/vídeo carregadas na memória até este tamanho */
const PREVIEW_MAX_BYTES = 50 * 1024 * 1024
const SAFE_ID = /^[a-zA-Z0-9-]{8,64}$/

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
  const micStream = shallowRef<MediaStream | null>(null)
  const mutedPeers = ref<Set<string>>(new Set())
  /** mensagens recebidas com a aba de Chamada fechada */
  const unread = ref(0)
  const viewOpen = ref(false)
  /** volume do áudio da transmissão aberta (0 a 2) */
  const screenVolume = ref(Number(localStorage.getItem(SCREEN_VOLUME_KEY) ?? 1) || 0)
  const screenMuted = ref(false)
  /** volume da voz de cada participante para mim (0 a 2; sem valor = 100%) */
  const peerVolumes = ref<Record<string, number>>({})

  // sala e histórico
  const room = ref<{ id: string; name: string; createdAt: number; participants: string[] } | null>(null)
  const messages = ref<CallMessage[]>([])
  let deleted = new Set<string>()
  const recentRooms = ref<RoomSummary[]>([])

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

  let rtc = useCallRtc()
  const localPeerId = ref(rtc.localPeerId)
  let localScreen: MediaStream | null = null
  /** o microfone foi mutado pelo ditado (e não pela pessoa): volta sozinho ao terminar */
  let mutedByDictation = false
  /** id fixo de cada participante conectado (peerId → userId) */
  const peerUsers = new Map<string, string>()
  /** arquivos que começaram a chegar antes da mensagem que os cita */
  const pendingFiles = new Map<string, { peerId: string; file: IncomingFile }>()

  // ------------------------------------------------------------------ entrar / sair

  /** Cria uma sala nova ou reabre uma do histórico (`reopenId`). */
  async function create(opts: { roomName?: string; reopenId?: string } = {}): Promise<void> {
    if (status.value !== 'idle') return
    begin()
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
      void ipc()
        .invoke('call:host-ready', res.code)
        .then(() => (codeReady.value = code.value === res.code))
      await enter(`ws://127.0.0.1:${res.port}`)
      noteParticipants()
      scheduleSave()
    } catch (e) {
      fail(e)
    }
  }

  async function join(raw: string): Promise<void> {
    if (status.value !== 'idle') return
    const parsed = parseCode(raw)
    if (!parsed) {
      error.value = 'Código inválido. Ele tem este formato: calm-river-paper-moon'
      return
    }
    begin()
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

  function begin(): void {
    error.value = ''
    status.value = 'connecting'
    name.value = name.value.trim().slice(0, 40)
    localStorage.setItem(NAME_KEY, name.value)
  }

  function fail(e: unknown): void {
    const message = e instanceof Error ? e.message : String(e)
    leave()
    error.value = message
  }

  async function enter(wsUrl: string, attempts = 1): Promise<void> {
    await openMic(localStorage.getItem(INPUT_KEY) || '')
    for (let i = 1; ; i++) {
      try {
        await rtc.connect(wsUrl, name.value || 'Convidado', {
          onPeers: (list) => {
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
          onSignalingClosed: () => (closedToNewcomers.value = true)
        })
        break
      } catch (e) {
        if (i >= attempts) throw e
        await new Promise((r) => setTimeout(r, 2500))
      }
    }
    rtc.setScreenVolume(screenMuted.value ? 0 : screenVolume.value)
    status.value = 'in-call'
  }

  function leave(): void {
    flushSave()
    rtc.disconnect()
    if (isHost.value) void ipc().invoke('call:host-stop')
    localScreen?.getTracks().forEach((t) => t.stop())
    localScreen = null
    micStream.value?.getTracks().forEach((t) => t.stop())
    micStream.value = null
    // nova identidade de conexão a cada sala
    rtc = useCallRtc()
    localPeerId.value = rtc.localPeerId
    status.value = 'idle'
    error.value = ''
    code.value = ''
    isHost.value = false
    codeReady.value = false
    closedToNewcomers.value = false
    peers.value = []
    clearMessages()
    room.value = null
    muted.value = false
    hasMic.value = false
    sharing.value = false
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
    } catch {
      recentRooms.value = []
    }
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
    if (!SAFE_ID.test(info.id) || room.value?.id === info.id) return
    await loadRoom(info.id, info.name)
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
    } catch {
      f.failed = true
    }
  }

  function sendMessage(text: string, files: File[] = []): void {
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

  async function openMic(deviceId: string): Promise<void> {
    micStream.value?.getTracks().forEach((t) => t.stop())
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        video: false
      })
      stream.getAudioTracks().forEach((t) => (t.enabled = !muted.value))
      micStream.value = stream
      hasMic.value = true
      await rtc.setMicTrack(stream.getAudioTracks()[0] ?? null)
    } catch {
      // sem microfone ou permissão negada: entra só ouvindo
      micStream.value = null
      hasMic.value = false
      await rtc.setMicTrack(null)
    }
  }

  function applyMuted(value: boolean): void {
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
      mutedByDictation = true
      applyMuted(true)
    } else if (!recording && mutedByDictation) {
      mutedByDictation = false
      applyMuted(false)
    }
  }
  onWsMessage((e) => {
    if (e.type === 'state_changed' && e.state) onDictation(e.state === 'recording')
  })

  // ------------------------------------------------------------------ compartilhamento de tela

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
    let stream: MediaStream
    // no Linux o som não vem da captura da tela (ver linuxShareAudio abaixo)
    const systemAudio = withAudio && !IS_LINUX
    try {
      stream = await captureDisplay(sourceId, quality, systemAudio)
    } catch {
      try {
        stream = await captureLegacy(sourceId, quality, systemAudio)
      } catch {
        error.value = 'Não foi possível capturar essa tela.'
        return
      }
    }
    // Linux: o Chromium não captura o som do sistema; ele vem de um microfone virtual do PipeWire
    if (withAudio && IS_LINUX && !stream.getAudioTracks().length) {
      const audio = await linuxShareAudio(sourceId)
      if (audio) stream.addTrack(audio)
    }
    const track = stream.getVideoTracks()[0]
    track.contentHint = 'detail' // prioriza nitidez do texto em vez de fluidez
    track.onended = () => void stopShare()

    localScreen?.getTracks().forEach((t) => t.stop())
    localScreen = stream
    sharing.value = true
    await rtc.setScreenStream(stream)
    if (watching.value === SELF) watch(SELF) // trocou de tela com a prévia aberta
    void snapshot(stream)
  }

  /** Som da transmissão no Linux: o app monta o microfone virtual e grava dele. */
  async function linuxShareAudio(sourceId: string): Promise<MediaStreamTrack | null> {
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
          return audio.getAudioTracks()[0] ?? null
        } catch {
          break
        }
      }
      await new Promise((r) => setTimeout(r, 150))
    }
    void ipc().invoke('call:linux-audio-stop')
    error.value = 'Transmitindo sem som: o microfone virtual não apareceu.'
    return null
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
    localScreen.getTracks().forEach((t) => {
      t.onended = null
      t.stop()
    })
    localScreen = null
    sharing.value = false
    if (IS_LINUX) void ipc().invoke('call:linux-audio-stop')
    const rest = { ...thumbs.value }
    delete rest[SELF]
    thumbs.value = rest
    await rtc.setScreenStream(null)
    if (watching.value === SELF) watch(null)
  }

  /** Abre uma transmissão (SELF = a minha) por cima do chat; null fecha (para de receber). */
  function watch(target: string | null): void {
    if (target !== watching.value) viewMode.value = 'expanded'
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

  function setVolume(peerId: string, volume: number): void {
    peerVolumes.value = { ...peerVolumes.value, [peerId]: volume }
    rtc.setPeerVolume(peerId, volume)
  }

  function togglePeerMute(peerId: string): void {
    const next = new Set(mutedPeers.value)
    if (!next.delete(peerId)) next.add(peerId)
    mutedPeers.value = next
    rtc.setPeerMuted(peerId, next.has(peerId))
  }

  function getPeerAnalyser(peerId: string): AnalyserNode | null {
    return rtc.getPeerAnalyser(peerId)
  }

  function setScreenVolume(volume: number): void {
    screenVolume.value = volume
    screenMuted.value = false
    localStorage.setItem(SCREEN_VOLUME_KEY, String(volume))
    rtc.setScreenVolume(volume)
  }

  /** Muta só para mim o som da transmissão aberta (sem perder o volume escolhido). */
  function toggleScreenMute(): void {
    screenMuted.value = !screenMuted.value
    rtc.setScreenVolume(screenMuted.value ? 0 : screenVolume.value)
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
        (d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications' && !d.label.includes('VoiceAI-Transmissao')
      ),
      outputs: devices.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
    }
  }

  async function setInputDevice(deviceId: string): Promise<void> {
    localStorage.setItem(INPUT_KEY, deviceId)
    await openMic(deviceId)
  }

  async function setOutputDevice(deviceId: string): Promise<void> {
    await rtc.setOutputDevice(deviceId)
  }

  const getInputDevice = (): string => localStorage.getItem(INPUT_KEY) || ''
  const getOutputDevice = (): string => rtc.getOutputDevice()

  // o túnel de quem criou a sala caiu: a chamada segue, mas ninguém novo entra
  ipc().on('call:tunnel-down', () => {
    if (inCall.value) closedToNewcomers.value = true
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
    getOutputDevice
  }
})
