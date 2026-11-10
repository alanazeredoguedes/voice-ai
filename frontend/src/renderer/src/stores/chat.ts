import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import axios from 'axios'
import type { Chat, ChatMessage, MediaGroup, StateEvent } from '../types'
import {
  activateChat,
  clearChatMessages,
  createChat as apiCreateChat,
  deleteChat as apiDeleteChat,
  deleteChatMessage,
  getChatMessages,
  listChats,
  sendChatMessage,
  updateChat as apiUpdateChat
} from '../api'
import { onWsMessage } from '../api/ws'
import { toPlain } from '../utils/richText'

/** Respostas antigas podem ter travessão (o backend já troca nas novas): exibe com hífen simples */
const noLongDash = (s: string): string => s.replace(/[–—]/g, '-')

/**
 * Vários chats no Chat IA: cada um com nome, system prompt, histórico e contexto próprios.
 * O chat ativo (selecionado no topo) é o que recebe as mensagens digitadas e as perguntas por voz.
 */
export const useChatStore = defineStore('chat', () => {
  const chats = ref<Chat[]>([])
  const activeChatId = ref<number | null>(null)
  /** chat que está respondendo agora (uma resposta por vez no app inteiro) */
  const busyChatId = ref<number | null>(null)
  const messagesByChat = ref<Record<number, ChatMessage[]>>({})
  const loadedChats = new Set<number>()
  const error = ref<string | null>(null)
  let listening = false
  let activating: number | null = null // evita que um "chats_changed" antigo desfaça a troca local

  // Qual resposta está sendo falada agora: "live" (a resposta atual) ou "msg:<id>" (repetição)
  const speakingRef = ref<string | null>(null)
  /** "ouvir de novo" clicado: o áudio está sendo gerado, ainda não começou a falar */
  const preparingRef = ref<string | null>(null)

  // ---------- destaque do trecho que está sendo falado (3 palavras que andam com a voz) ----------
  interface SpokenWord {
    start: number // posição no texto da mensagem
    end: number
    at: number // ms desde o início do som da frase
  }
  /** trecho destacado agora: mensagem + posição no texto */
  const speechHighlight = ref<{ msg: ChatMessage; start: number; end: number; live: boolean } | null>(null)
  const HIGHLIGHT_WORDS = 3
  let hlTrack: { msg: ChatMessage; words: SpokenWord[]; t0: number; ref: string } | null = null
  /** última palavra falada de cada fala (para o "parou em...") */
  const lastSpoken = new Map<string, { msg: ChatMessage; start: number; end: number }>()
  /** de onde a fala começou e até onde vai ("ouvir daqui" / "ouvir este trecho") */
  const speechRange = new Map<string, { start: number; end: number | null }>() // da fala tocando agora
  const pendingRange = new Map<string, { start: number; end: number | null }>() // pedido, ainda não começou
  let hlFrame = 0
  /** até onde do texto já foi falado, por fala (para achar a próxima frase no lugar certo) */
  const hlCursor = new Map<string, number>()

  function speechKey(ref: string, chatId?: number | null): string {
    return ref === 'live' ? `live:${chatId ?? ''}` : ref
  }

  /** mensagem que está sendo falada: "msg:<id>" (ouvir de novo) ou "live" (última resposta do chat) */
  function speechMessage(ref: string, chatId?: number | null): ChatMessage | null {
    if (ref === 'live') {
      const cid = chatId ?? activeChatId.value
      const msgs = cid !== null ? (messagesByChat.value[cid] ?? []) : []
      for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'assistant') return msgs[i]
      return null
    }
    const id = Number(ref.replace('msg:', ''))
    for (const msgs of Object.values(messagesByChat.value)) {
      const m = msgs.find((x) => x.id === id)
      if (m) return m
    }
    return null
  }

  /**
   * Texto falado da resposta (sem a formatação nem os marcadores de imagem). Todas as posições da fala
   * (destaque, "parou em", trecho escolhido, cache de áudio) são nele, igual ao backend.
   */
  const plainCache = new WeakMap<ChatMessage, { content: string; streaming: boolean; plain: string }>()
  function plainOf(msg: ChatMessage): string {
    const streaming = !!msg.streaming
    const c = plainCache.get(msg)
    if (c && c.content === msg.content && c.streaming === streaming) return c.plain
    const plain = toPlain(msg.content, streaming)
    plainCache.set(msg, { content: msg.content, streaming, plain })
    return plain
  }

  function onSpeechWords(event: StateEvent): void {
    if (!event.ref || !event.words?.length) return
    const msg = speechMessage(event.ref, event.chat_id)
    if (!msg?.content) return
    const text = plainOf(msg)
    const key = speechKey(event.ref, event.chat_id)
    let cur = hlCursor.get(key) ?? 0
    const speed = event.speed || 1
    const lead = (event.lead ?? 0) * 1000
    const words: SpokenWord[] = []
    // acha cada palavra do áudio no texto, sempre para a frente (o texto é o mesmo que foi falado)
    for (const w of event.words) {
      const word = w.w.trim()
      if (!word) continue
      const idx = text.indexOf(word, cur)
      if (idx < 0 || idx - cur > 400) continue
      words.push({ start: idx, end: idx + word.length, at: lead + (w.t * 1000) / speed })
      cur = idx + word.length
    }
    hlCursor.set(key, cur)
    if (!words.length) return
    hlTrack = { msg, words, t0: performance.now(), ref: key }
    if (!hlFrame) hlFrame = requestAnimationFrame(tickHighlight)
  }

  function tickHighlight(): void {
    hlFrame = 0
    if (!hlTrack) return
    const now = performance.now() - hlTrack.t0
    const ws = hlTrack.words
    let k = -1
    for (let i = 0; i < ws.length && ws[i].at <= now; i++) k = i
    if (k >= 0) {
      lastSpoken.set(hlTrack.ref, { msg: hlTrack.msg, start: ws[k].start, end: ws[k].end })
      const last = Math.min(k + HIGHLIGHT_WORDS - 1, ws.length - 1)
      const h = speechHighlight.value
      if (!h || h.msg !== hlTrack.msg || h.start !== ws[k].start || h.end !== ws[last].end) {
        speechHighlight.value = {
          msg: hlTrack.msg,
          start: ws[k].start,
          end: ws[last].end,
          live: hlTrack.ref.startsWith('live:')
        }
      }
    }
    // continua até a próxima frase chegar (o destaque fica na última palavra até lá) ou a fala parar
    hlFrame = requestAnimationFrame(tickHighlight)
  }

  function clearSpeechHighlight(ref?: string, chatId?: number | null): void {
    if (hlFrame) cancelAnimationFrame(hlFrame)
    hlFrame = 0
    hlTrack = null
    speechHighlight.value = null
    if (ref) hlCursor.delete(speechKey(ref, chatId))
  }

  // ---------- "parou em..." (salvo mesmo fechando o app) ----------
  const RESUME_KEY = 'voiceai.speechResume'
  function loadResume(): Record<number, number> {
    try {
      const v = JSON.parse(localStorage.getItem(RESUME_KEY) || '{}')
      return v && typeof v === 'object' ? v : {}
    } catch {
      return {}
    }
  }
  /** id da mensagem → posição no texto (início da palavra onde a fala parou) */
  const resumeAt = ref<Record<number, number>>(loadResume())
  function saveResume(): void {
    try {
      localStorage.setItem(RESUME_KEY, JSON.stringify(resumeAt.value))
    } catch {
      // sem armazenamento: o "parou em" vale só nesta sessão
    }
  }
  function setResume(msgId: number, pos: number | null): void {
    const next = { ...resumeAt.value }
    if (pos === null) delete next[msgId]
    else next[msgId] = pos
    resumeAt.value = next
    saveResume()
  }

  /** posição onde a fala desta mensagem parou (ou null) */
  function resumeFor(msg: ChatMessage): number | null {
    if (msg.id === undefined) return null
    const pos = resumeAt.value[msg.id]
    return typeof pos === 'number' && pos > 0 && pos < plainOf(msg).length ? pos : null
  }

  function clearResume(msg: ChatMessage): void {
    if (msg.id !== undefined && msg.id in resumeAt.value) setResume(msg.id, null)
  }

  /** chamado antes de "ouvir de novo": a fala começa em `start` (e vai até `end`, ou o fim) */
  function setSpeechStart(ref: string, start: number, end: number | null = null): void {
    pendingRange.set(ref, { start, end })
  }

  /** a fala terminou ou foi parada: guarda onde parou (ou limpa, se chegou ao fim) */
  function onSpeechEnded(ref: string, chatId?: number | null): void {
    const key = speechKey(ref, chatId)
    const spoken = lastSpoken.get(key)
    const range = speechRange.get(ref)
    lastSpoken.delete(key)
    speechRange.delete(ref)
    const msg = spoken?.msg
    if (!spoken || !msg || msg.id === undefined) return
    const plain = plainOf(msg)
    const limit = range?.end ?? plain.length
    // ainda havia palavras depois da última falada? então foi parada no meio
    const stoppedEarly = /[\p{L}\p{N}]/u.test(plain.slice(spoken.end, limit))
    let pos: number | null = null
    if (stoppedEarly) pos = spoken.start // parada no meio: exatamente a palavra onde parou
    else if (range?.end != null) {
      // "ouvir este trecho" chegou ao fim do trecho: continua da próxima palavra depois dele
      const m = /[\p{L}\p{N}]/u.exec(plain.slice(range.end))
      pos = m ? range.end + m.index : null
      while (pos !== null && pos > range.end && /\S/.test(plain[pos - 1])) pos-- // início da palavra
    }
    setResume(msg.id, pos) // null = ouviu até o fim da resposta
    // Se ela parou porque você já pediu outra fala (seleção, continuar), não redesenha o sublinhado:
    // quem decide a marcação é o pedido novo
    if (pendingRange.size > 0) return
    resumeMark.value = pos !== null ? { msg, start: pos, end: resumeSnippetEnd(plain, pos) } : null
  }

  // ---------- % do texto de cada resposta que já tem áudio salvo ----------
  /** atualizações ao vivo (chegam pelo id; a resposta ao vivo pode receber antes de a tela saber o id) */
  const audioPctById = ref<Record<number, number>>({})
  const audioBytesById = ref<Record<number, number>>({})

  /** espaço que o áudio salvo desta resposta ocupa (bytes) */
  function audioBytes(msg: ChatMessage): number {
    if (msg.id === undefined) return 0
    return audioBytesById.value[msg.id] ?? msg.audio_bytes ?? 0
  }

  function audioPct(msg: ChatMessage): number | null {
    if (msg.role !== 'assistant' || msg.id === undefined) return null
    return audioPctById.value[msg.id] ?? msg.audio_pct ?? 0
  }

  /** áudios apagados (de um chat ou de todos): zera a % na tela */
  function resetAudioPct(chatId: number | null): void {
    const next = { ...audioPctById.value }
    const nextBytes = { ...audioBytesById.value }
    for (const [cid, msgs] of Object.entries(messagesByChat.value)) {
      if (chatId !== null && Number(cid) !== chatId) continue
      for (const m of msgs) {
        if (m.id !== undefined) {
          next[m.id] = 0
          nextBytes[m.id] = 0
        }
        m.audio_pct = 0
        m.audio_bytes = 0
      }
    }
    audioPctById.value = next
    audioBytesById.value = nextBytes
  }

  /** conta cada fala que começa (para saber se a fala NOVA já começou, e não a que estava tocando) */
  const speechStartSeq = ref(0)

  /** trecho do "parou em" (as palavras de onde a fala continua): fica sublinhado até a próxima fala */
  const resumeMark = ref<{ msg: ChatMessage; start: number; end: number } | null>(null)
  const RESUME_SNIPPET_WORDS = 4
  function resumeSnippetEnd(content: string, pos: number): number {
    const re = /\S+/g
    re.lastIndex = pos
    let end = pos
    for (let i = 0; i < RESUME_SNIPPET_WORDS; i++) {
      const m = re.exec(content)
      if (!m) break
      end = m.index + m[0].length
    }
    return end
  }

  /** trecho destacado nesta mensagem (início/fim no texto), ou null */
  function highlightFor(msg: ChatMessage): { start: number; end: number } | null {
    const h = speechHighlight.value
    return h && h.msg === msg ? { start: h.start, end: h.end } : null
  }

  function isPreparing(msg: ChatMessage): boolean {
    return preparingRef.value !== null && preparingRef.value === speechRef(msg)
  }
  const speakingChatId = ref<number | null>(null)

  const activeChat = computed(() => chats.value.find((c) => c.id === activeChatId.value) ?? null)
  const busyChat = computed(() => chats.value.find((c) => c.id === busyChatId.value) ?? null)
  const messages = computed<ChatMessage[]>(() =>
    activeChatId.value !== null ? (messagesByChat.value[activeChatId.value] ?? []) : []
  )
  /** Há uma resposta em andamento (em qualquer chat): o envio fica bloqueado até terminar */
  const streaming = computed(() => busyChatId.value !== null)

  function list(chatId: number): ChatMessage[] {
    if (!messagesByChat.value[chatId]) messagesByChat.value[chatId] = []
    return messagesByChat.value[chatId]
  }

  /** chat do evento; eventos antigos sem chat_id vão para o ativo */
  function eventChat(event: StateEvent): number | null {
    return event.chat_id ?? activeChatId.value
  }

  function speechRef(msg: ChatMessage): string | null {
    return msg.id !== undefined ? `msg:${msg.id}` : null
  }

  /** A voz está saindo para esta mensagem? ("live" = última resposta do assistente do chat que fala) */
  function isSpeaking(msg: ChatMessage): boolean {
    const r = speakingRef.value
    if (!r) return false
    if (r === 'live') {
      const cid = speakingChatId.value ?? activeChatId.value
      if (cid === null) return false
      const msgs = messagesByChat.value[cid] ?? []
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'assistant') return msgs[i] === msg
      }
      return false
    }
    return r === speechRef(msg)
  }

  /**
   * Escuta os eventos do chat desde a abertura do app, mesmo com outra aba visível
   * (respostas por voz chegam com o Chat IA fechado).
   */
  function init(): void {
    if (listening) return
    listening = true
    onWsMessage((event) => {
      const cid = eventChat(event)
      if (event.type === 'chats_changed') {
        void loadChats()
        return
      }
      if (event.type === 'tts_preparing' && event.ref) {
        if (event.preparing) preparingRef.value = event.ref
        else if (preparingRef.value === event.ref) preparingRef.value = null
        return
      }
      if (event.type === 'speech_cache_progress' && event.message_id !== undefined) {
        audioPctById.value = { ...audioPctById.value, [event.message_id]: event.audio_pct ?? 0 }
        audioBytesById.value = { ...audioBytesById.value, [event.message_id]: event.audio_bytes ?? 0 }
        return
      }
      if (event.type === 'tts_words') {
        onSpeechWords(event)
        return
      }
      if (event.type === 'tts_playing' && event.ref) {
        // começo ou fim de uma fala: o destaque recomeça do ponto de início / some
        if (!event.playing) onSpeechEnded(event.ref, event.chat_id)
        clearSpeechHighlight(event.ref, event.chat_id)
        if (event.playing) {
          speechStartSeq.value++
          resumeMark.value = null // a próxima fala começou: o sublinhado do "parou em" sai
          // a fala nova assume o ponto de início pedido ("ouvir daqui", "continuar")
          const range = pendingRange.get(event.ref)
          pendingRange.delete(event.ref)
          if (range) speechRange.set(event.ref, range)
          const start = range?.start ?? 0
          if (start > 0) hlCursor.set(speechKey(event.ref, event.chat_id), start)
          speakingRef.value = event.ref
          speakingChatId.value = event.chat_id ?? null
        } else if (speakingRef.value === event.ref) {
          speakingRef.value = null
          speakingChatId.value = null
        }
        return
      }
      if (event.type === 'ai_rejected_busy') {
        error.value = 'Já existe uma resposta em andamento. Espere terminar para perguntar de novo.'
        return
      }
      if (cid === null) return
      if (event.type === 'chat_delta') {
        // pedaço do texto (markdown) da resposta: entra exatamente como chegou
        const last = currentAssistant(cid, !!event.text)
        if (last && event.text) {
          last.content += event.text
          last.activity = null
        }
      } else if (event.type === 'chat_chunk') {
        onChunk(cid, event.text ?? '', event.done ?? false, event.message_id, event.user_message_id, event.still_busy)
        if (event.done) {
          const msgs = list(cid)
          const last = msgs[msgs.length - 1]
          if (last?.role === 'assistant') {
            if (event.duration_s !== undefined) last.duration_s = event.duration_s
            if (event.tools) last.tools = event.tools
          }
        }
      } else if (event.type === 'chat_media') {
        onMedia(cid, event)
      } else if (event.type === 'chat_activity' && event.tool) {
        const last = currentAssistant(cid, true)
        if (last) {
          const t = { name: event.tool, detail: event.detail ?? '' }
          last.activity = t
          last.tools = [...(last.tools ?? []), t]
        }
      } else if (event.type === 'chat_error') {
        onError(cid, event.error ?? 'Erro desconhecido')
      } else if (event.type === 'voice_user_message' && event.text) {
        onVoiceUserMessage(cid, event.text, event.user_message_id)
      } else if (event.type === 'voice_chat_cancelled') {
        onVoiceCancelled(cid)
      }
    })
  }

  // ---------- chats ----------

  async function loadChats(): Promise<void> {
    try {
      const data = await listChats()
      chats.value = data.chats
      busyChatId.value = data.busy_chat_id
      if (activating === null && activeChatId.value !== data.active_id) {
        activeChatId.value = data.active_id
        await loadMessages(data.active_id)
      }
    } catch (e) {
      console.error('[chat] erro ao carregar chats:', e)
    }
  }

  /** Carrega o histórico de um chat uma vez; mensagens que chegaram ao vivo antes disso são mantidas. */
  async function loadMessages(chatId: number, force = false): Promise<void> {
    if (loadedChats.has(chatId) && !force) return
    try {
      const history = await getChatMessages(chatId)
      const ids = new Set(history.map((m) => m.id))
      const live = (messagesByChat.value[chatId] ?? []).filter((m) => m.id === undefined || !ids.has(m.id))
      messagesByChat.value[chatId] = [
        ...history.map((m) => ({ ...m, content: noLongDash(m.content), streaming: false })),
        ...live
      ]
      loadedChats.add(chatId)
    } catch (e) {
      console.error('[chat] erro ao carregar mensagens:', e)
    }
  }

  /** Abertura do Chat IA: lista de chats + histórico do ativo */
  async function loadHistory(): Promise<void> {
    await loadChats()
    if (activeChatId.value !== null) await loadMessages(activeChatId.value)
  }

  async function selectChat(chatId: number): Promise<void> {
    if (chatId === activeChatId.value) return
    activeChatId.value = chatId
    error.value = null
    activating = chatId
    try {
      await Promise.all([activateChat(chatId), loadMessages(chatId)])
    } catch (e) {
      console.error('[chat] erro ao trocar de chat:', e)
    } finally {
      if (activating === chatId) activating = null
    }
  }

  async function createChat(name: string, systemPrompt: string): Promise<void> {
    const chat = await apiCreateChat(name, systemPrompt)
    messagesByChat.value[chat.id] = []
    loadedChats.add(chat.id)
    chats.value = [{ ...chat, message_count: 0, last_message: '' }, ...chats.value]
    activeChatId.value = chat.id
    error.value = null
  }

  async function updateChat(chatId: number, patch: { name?: string; system_prompt?: string }): Promise<void> {
    const chat = await apiUpdateChat(chatId, patch)
    const c = chats.value.find((x) => x.id === chatId)
    if (c) Object.assign(c, { name: chat.name, system_prompt: chat.system_prompt })
  }

  async function deleteChat(chatId: number): Promise<void> {
    const { active_id } = await apiDeleteChat(chatId)
    delete messagesByChat.value[chatId]
    loadedChats.delete(chatId)
    chats.value = chats.value.filter((c) => c.id !== chatId)
    if (activeChatId.value === chatId) activeChatId.value = active_id
    await loadChats()
    if (activeChatId.value !== null) await loadMessages(activeChatId.value)
  }

  async function clearChat(chatId: number): Promise<void> {
    await clearChatMessages(chatId)
    messagesByChat.value[chatId] = []
    error.value = null
  }

  // ---------- mensagens ----------

  async function sendMessage(text: string): Promise<void> {
    const cid = activeChatId.value
    if (!text.trim() || streaming.value || cid === null) return
    error.value = null

    const msgs = list(cid)
    msgs.push({ role: 'user', content: text, ts: new Date().toISOString() })
    msgs.push({ role: 'assistant', content: '', streaming: true })
    busyChatId.value = cid

    try {
      const { user_message_id } = await sendChatMessage(cid, text)
      const u = [...msgs].reverse().find((m) => m.role === 'user' && m.id === undefined)
      if (u) u.id = user_message_id
    } catch (e) {
      busyChatId.value = null
      msgs.pop()
      error.value =
        axios.isAxiosError(e) && e.response?.data?.detail
          ? String(e.response.data.detail)
          : e instanceof Error
            ? e.message
            : 'Erro ao enviar mensagem'
    }
  }

  /** Resposta do assistente em andamento; cria uma se o evento de início não chegou (ou chegou antes do app abrir). */
  function currentAssistant(chatId: number, create: boolean): ChatMessage | null {
    const msgs = list(chatId)
    const last = msgs[msgs.length - 1]
    if (last?.role === 'assistant' && last.streaming) return last
    if (!create) return null
    msgs.push({ role: 'assistant', content: '', streaming: true })
    busyChatId.value = chatId
    return msgs[msgs.length - 1]
  }

  function onChunk(
    chatId: number,
    text: string,
    done: boolean,
    messageId?: number,
    userMessageId?: number,
    stillBusy = false
  ): void {
    const last = currentAssistant(chatId, !done && !!text)
    if (!last) {
      if (done && busyChatId.value === chatId) busyChatId.value = null
      return
    }

    if (!done) {
      last.content += text
      last.activity = null
      return
    }
    last.streaming = false
    last.activity = null
    if (!last.ts) last.ts = new Date().toISOString()
    if (messageId !== undefined) last.id = messageId
    // ainda falando: o backend libera o chat no fim (evento chats_changed → loadChats)
    if (!stillBusy && busyChatId.value === chatId) busyChatId.value = null

    // Atribui ID à mensagem do usuário que precedeu esta resposta
    if (userMessageId !== undefined) {
      const msgs = list(chatId)
      for (let i = msgs.length - 2; i >= 0; i--) {
        if (msgs[i].role === 'user') {
          if (msgs[i].id === undefined) msgs[i].id = userMessageId
          break
        }
      }
    }
  }

  /** Evento chat_media: cria/atualiza um grupo de mídia na resposta atual do assistente. */
  function onMedia(chatId: number, event: StateEvent): void {
    if (!event.group_id) return
    const msgs = list(chatId)
    // O grupo pode já existir (a busca costuma terminar depois do "loading")
    for (let i = msgs.length - 1; i >= 0; i--) {
      const g = msgs[i].media?.find((m) => m.group_id === event.group_id)
      if (g) {
        g.status = event.status ?? g.status
        g.items = event.items ?? g.items
        g.error = event.error
        g.provider = event.provider ?? g.provider
        if (event.more) g.more = event.more
        return
      }
    }
    const last = currentAssistant(chatId, true)
    if (!last) return
    const group: MediaGroup = {
      group_id: event.group_id,
      kind: event.kind ?? 'image',
      query: event.query ?? '',
      status: event.status ?? 'loading',
      items: event.items ?? [],
      error: event.error,
      provider: event.provider,
      picked: event.picked,
      more: event.more
    }
    last.media = [...(last.media ?? []), group]
  }

  function onError(chatId: number, msg: string): void {
    const msgs = list(chatId)
    const last = msgs[msgs.length - 1]
    if (last?.streaming) {
      last.streaming = false
      last.content = last.content || '⚠ Erro ao obter resposta.'
    }
    if (busyChatId.value === chatId) busyChatId.value = null
    error.value = msg
  }

  function onVoiceUserMessage(chatId: number, text: string, userMessageId?: number): void {
    const msgs = list(chatId)
    msgs.push({ role: 'user', content: text, id: userMessageId, ts: new Date().toISOString() })
    msgs.push({ role: 'assistant', content: '', streaming: true })
    busyChatId.value = chatId
  }

  function onVoiceCancelled(chatId: number): void {
    const msgs = list(chatId)
    const last = msgs[msgs.length - 1]
    if (last?.role === 'assistant' && last.streaming) {
      last.streaming = false
      last.content = last.content.trim() || '_(cancelado)_'
    }
    if (busyChatId.value === chatId) busyChatId.value = null
  }

  /**
   * Apaga uma mensagem. Sem id ela nunca foi salva (ex.: resposta cancelada no meio, que o backend
   * descarta): só sai da tela.
   */
  async function deleteMessage(msg: ChatMessage): Promise<void> {
    try {
      const id = msg.id
      if (id !== undefined) {
        await deleteChatMessage(id)
        if (id in resumeAt.value) setResume(id, null)
      }
      for (const msgs of Object.values(messagesByChat.value)) {
        const idx = msgs.findIndex((m) => m === msg || (id !== undefined && m.id === id))
        if (idx !== -1) {
          msgs.splice(idx, 1)
          break
        }
      }
    } catch (e) {
      console.error('[chat] erro ao apagar mensagem:', e)
    }
  }

  return {
    chats,
    activeChatId,
    activeChat,
    busyChatId,
    busyChat,
    messages,
    streaming,
    error,
    speakingRef,
    preparingRef,
    isPreparing,
    speechHighlight,
    highlightFor,
    resumeAt,
    resumeFor,
    plainOf,
    resumeMark,
    speechStartSeq,
    audioPct,
    audioBytes,
    resetAudioPct,
    resumeSnippetEnd,
    clearResume,
    setSpeechStart,
    speechRef,
    isSpeaking,
    init,
    loadChats,
    loadHistory,
    selectChat,
    createChat,
    updateChat,
    deleteChat,
    clearChat,
    sendMessage,
    deleteMessage
  }
})
