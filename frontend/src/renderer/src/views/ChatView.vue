<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import axios from 'axios'
import { useChatStore } from '../stores/chat'
import { clearChatSpeechCache, getAudioRanges, getTtsMuted, getTtsSpeed, getTtsVolume, replaySpeech, setTtsMuted, setTtsSpeed, setTtsVolume, stopSpeech } from '../api'
import { useSettingsStore } from '../stores/settings'
import type { Chat, ChatMessage } from '../types'
import CopyButton from '../components/CopyButton.vue'
import MediaGrid from '../components/MediaGrid.vue'
import ChatSwitcher from '../components/ChatSwitcher.vue'
import ChatFormModal from '../components/ChatFormModal.vue'
import ConfirmModal from '../components/ConfirmModal.vue'

const store = useChatStore()
const input = ref('')
const messagesEl = ref<HTMLElement | null>(null)
const textareaEl = ref<HTMLTextAreaElement | null>(null)
const ttsMuted = ref(false)
const ttsVolume = ref(1.0)
const confirmDeleteId = ref<number | null>(null)

// ---------- vários chats ----------
const formOpen = ref(false)
const formMode = ref<'new' | 'edit'>('new')
const formChat = ref<Chat | null>(null)
const chatToDelete = ref<Chat | null>(null)
const chatToClear = ref<Chat | null>(null)
const chatAudioToClear = ref<Chat | null>(null)
const settingsStore = useSettingsStore()

async function confirmClearAudio(): Promise<void> {
  const chat = chatAudioToClear.value
  if (!chat) return
  chatActionLoading.value = true
  try {
    await clearChatSpeechCache(chat.id)
    store.resetAudioPct(chat.id)
    await store.loadChats()
    // atualiza o tamanho mostrado na configuração do chat aberta
    if (formChat.value?.id === chat.id) formChat.value = store.chats.find((c) => c.id === chat.id) ?? formChat.value
  } catch (e) {
    store.error = apiError(e, 'Não foi possível apagar os áudios')
  } finally {
    chatActionLoading.value = false
    chatAudioToClear.value = null
  }
}
const chatActionLoading = ref(false)

const nextChatName = computed(() => {
  const names = new Set(store.chats.map((c) => c.name))
  let n = store.chats.length + 1
  while (names.has(`Novo chat ${n}`)) n++
  return `Novo chat ${n}`
})

/** Outra conversa está respondendo: este chat espera para enviar */
const busyElsewhere = computed(
  () => store.busyChatId !== null && store.busyChatId !== store.activeChatId ? store.busyChat : null
)

function apiError(e: unknown, fallback: string): string {
  if (axios.isAxiosError(e) && e.response?.data?.detail) return String(e.response.data.detail)
  return fallback
}

function openNewChat(): void {
  formMode.value = 'new'
  formChat.value = null
  formOpen.value = true
}

function openEditChat(chat: Chat | null = store.activeChat): void {
  if (!chat) return
  formMode.value = 'edit'
  formChat.value = chat
  formOpen.value = true
  // atualiza o espaço usado pelos áudios salvos (eles são gravados em segundo plano)
  void store.loadChats().then(() => {
    if (formOpen.value && formChat.value?.id === chat.id) formChat.value = store.chats.find((c) => c.id === chat.id) ?? formChat.value
  })
  if (!settingsStore.settings) void settingsStore.fetchSettings()
}

async function saveChatForm(data: { name: string; system_prompt: string }): Promise<void> {
  try {
    if (formMode.value === 'new') {
      await store.createChat(data.name, data.system_prompt)
      input.value = ''
      nextTick(() => textareaEl.value?.focus())
    } else if (formChat.value) {
      await store.updateChat(formChat.value.id, data)
    }
    formOpen.value = false
  } catch (e) {
    formOpen.value = false
    store.error = apiError(e, 'Não foi possível salvar o chat')
  }
}

async function selectChat(id: number): Promise<void> {
  confirmDeleteId.value = null
  await store.selectChat(id)
  scrollToBottom()
}

function askDeleteChat(chat: Chat): void {
  formOpen.value = false
  chatToDelete.value = chat
}

function askClearChat(chat: Chat): void {
  formOpen.value = false
  chatToClear.value = chat
}

async function confirmDeleteChat(): Promise<void> {
  const chat = chatToDelete.value
  if (!chat) return
  chatActionLoading.value = true
  try {
    await store.deleteChat(chat.id)
    scrollToBottom()
  } catch (e) {
    store.error = apiError(e, 'Não foi possível excluir o chat')
  } finally {
    chatActionLoading.value = false
    chatToDelete.value = null
  }
}

async function confirmClearChat(): Promise<void> {
  const chat = chatToClear.value
  if (!chat) return
  chatActionLoading.value = true
  try {
    await store.clearChat(chat.id)
  } catch (e) {
    store.error = apiError(e, 'Não foi possível limpar as mensagens')
  } finally {
    chatActionLoading.value = false
    chatToClear.value = null
  }
}

// ---------- data/hora, tempo de resposta e ferramentas abaixo de cada mensagem ----------
function parseTs(ts?: string): Date | null {
  if (!ts) return null
  // o SQLite grava "AAAA-MM-DD HH:MM:SS" em UTC; as mensagens ao vivo já vêm em ISO
  const d = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z')
  return isNaN(d.getTime()) ? null : d
}

function fmtTime(ts?: string): string {
  const d = parseTs(ts)
  if (!d) return ''
  const hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  const today = new Date()
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return hm
  if (d.toDateString() === yesterday.toDateString()) return `ontem ${hm}`
  return `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: d.getFullYear() === today.getFullYear() ? undefined : '2-digit' })} ${hm}`
}

function fullTime(ts?: string): string {
  const d = parseTs(ts)
  return d ? d.toLocaleString('pt-BR', { dateStyle: 'full', timeStyle: 'medium' }) : ''
}

function fmtSeconds(s?: number | null): string {
  if (s === undefined || s === null) return ''
  if (s < 10) return `${s.toFixed(1).replace('.', ',')} s`
  if (s < 60) return `${Math.round(s)} s`
  const m = Math.floor(s / 60)
  return `${m} min ${String(Math.round(s % 60)).padStart(2, '0')} s`
}

const WEB_TOOLS = ['WebSearch', 'WebFetch']

function webTools(msg: ChatMessage): { name: string; detail: string }[] {
  return (msg.tools ?? []).filter((t) => WEB_TOOLS.includes(t.name))
}

function webTitle(msg: ChatMessage): string {
  const lines = webTools(msg).map((t) =>
    t.name === 'WebFetch' ? `Abriu: ${t.detail}` : `Pesquisou: "${t.detail}"`
  )
  return ['A IA usou a internet nesta resposta', ...lines].join('\n')
}

function activityText(t: { name: string; detail: string }): string {
  if (t.name === 'WebFetch') {
    let host = t.detail
    try {
      host = new URL(t.detail).host.replace(/^www\./, '')
    } catch {
      // mantém o texto
    }
    return `Lendo ${host}`
  }
  if (t.name === 'WebSearch') return t.detail ? `Pesquisando na internet: "${t.detail}"` : 'Pesquisando na internet'
  return 'Trabalhando na resposta'
}

function messagesLabel(n?: number): string {
  if (!n) return 'Ele ainda não tem mensagens.'
  return n === 1 ? 'Ele tem 1 mensagem.' : `Ele tem ${n} mensagens.`
}

// Os eventos do WebSocket são tratados na store (stores/chat.ts → init). Aqui só acompanha a rolagem.
watch(
  () => {
    const last = store.messages[store.messages.length - 1]
    return [
      store.messages.length,
      last?.content.length ?? 0,
      last?.media?.map((g) => g.status).join() ?? '',
      // a linha de baixo (hora, tempo, botões) aparece quando a resposta termina: rola até ela também
      last?.streaming ? 1 : 0,
      last?.id ?? '',
      last?.duration_s ?? '',
      last?.activity?.detail ?? ''
    ].join(':')
  },
  () => {
    // enquanto a voz fala esta resposta, quem conduz a rolagem é o destaque (ele acompanha a fala)
    const h = store.speechHighlight
    if (h && h.msg === store.messages[store.messages.length - 1]) return
    scrollToBottom()
  }
)

// ---------- destaque do trecho falado: a tela acompanha a fala ----------
// Se você mexer no scroll (roda do mouse, barra, teclado), a tela para de acompanhar por alguns segundos.
const USER_SCROLL_PAUSE_MS = 4000
let lastUserScroll = 0

function markUserScroll(): void {
  lastUserScroll = Date.now()
}

function onMessagesMouseDown(e: MouseEvent): void {
  const el = messagesEl.value
  // clique na barra de rolagem (fica à direita da área de conteúdo)
  if (el && e.target === el && e.offsetX >= el.clientWidth) markUserScroll()
}

function onMessagesKey(e: KeyboardEvent): void {
  if (['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '].includes(e.key)) markUserScroll()
}

// O destaque é desenhado por cima do texto (CSS Custom Highlight API), sem recortar o texto em pedaços:
// assim dá para selecionar/copiar o texto mesmo enquanto a voz fala.
const contentEls = new WeakMap<ChatMessage, HTMLElement>()
function setContentEl(msg: ChatMessage, el: unknown): void {
  if (el instanceof HTMLElement) contentEls.set(msg, el)
}

type HighlightRegistry = { set: (name: string, h: unknown) => void; delete: (name: string) => void }
const highlights = (globalThis as unknown as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights
const HighlightCtor = (globalThis as unknown as { Highlight?: new (...r: AbstractRange[]) => { priority: number } })
  .Highlight

/** Faixa [start, end) do texto de uma mensagem, ou null se o texto ainda não está na tela */
function textRange(msg: ChatMessage, start: number, end: number): StaticRange | null {
  const node = contentEls.get(msg)?.firstChild
  if (!node || node.nodeType !== Node.TEXT_NODE || (node as Text).length < end || start >= end) return null
  return new StaticRange({ startContainer: node, startOffset: start, endContainer: node, endOffset: end })
}

/** Pinta (ou apaga) uma marcação; quanto maior a prioridade, mais por cima ela fica */
function paint(name: string, range: StaticRange | null, priority: number): void {
  if (!highlights || !HighlightCtor) return
  if (!range) {
    highlights.delete(name)
    return
  }
  const h = new HighlightCtor(range)
  h.priority = priority
  highlights.set(name, h)
}

// Trecho escolhido no menu da seleção (azul clarinho):
// "Ouvir daqui": até a voz começar · "Ouvir este trecho": durante toda a fala do trecho
const pendingSel = ref<{
  msg: ChatMessage
  start: number
  end: number
  kind: 'from' | 'only'
  ref: string
  seq: number // número da última fala que tinha começado quando você clicou
} | null>(null)

/** Desenha as 3 marcações do texto: trecho escolhido (azul), "parou em" (sublinhado), fala atual (roxo) */
function paintAll(): StaticRange | null {
  const sel = pendingSel.value
  paint('sel-hl', sel ? textRange(sel.msg, sel.start, sel.end) : null, 0)
  const rm = store.resumeMark
  paint('resume-hl', rm && !store.isSpeaking(rm.msg) ? textRange(rm.msg, rm.start, rm.end) : null, 1)
  const h = store.speechHighlight
  const range = h ? textRange(h.msg, h.start, h.end) : null
  paint('speech-hl', range, 2)
  return range
}

onUnmounted(() => ['sel-hl', 'resume-hl', 'speech-hl'].forEach((n) => highlights?.delete(n)))

// o trecho escolhido some na hora certa (ou se a fala for cancelada antes de começar)
watch(
  () => [store.preparingRef, store.speakingRef, store.speechStartSeq],
  () => {
    const p = pendingSel.value
    if (!p) return
    // a fala NOVA (a do trecho) já começou? (a que estava tocando quando você clicou não conta)
    const started = store.speechStartSeq > p.seq
    if (started && store.speakingRef === p.ref) {
      if (p.kind === 'from') pendingSel.value = null
      return
    }
    if (store.preparingRef === p.ref) return
    // nem preparando nem falando: terminou ou foi cancelada (espera um instante: os dois avisos
    // "parou de preparar" e "começou a falar" chegam um logo depois do outro)
    setTimeout(() => {
      if (pendingSel.value === p && store.preparingRef !== p.ref && store.speakingRef !== p.ref) pendingSel.value = null
    }, 500)
  }
)

/** depois de um clique seu (Continuar, Do início, menu da seleção), a tela vai até a fala mesmo que você tenha mexido no scroll */
let forceFollow = false

function rangeRect(range: StaticRange): DOMRect {
  const tmp = document.createRange()
  tmp.setStart(range.startContainer, range.startOffset)
  tmp.setEnd(range.endContainer, range.endOffset)
  return tmp.getBoundingClientRect()
}

watch(
  () => [
    store.speechHighlight ? `${store.speechHighlight.start}:${store.speechHighlight.end}:${store.speechHighlight.msg.content.length}` : '',
    store.resumeMark ? `${store.resumeMark.start}` : '',
    pendingSel.value ? `${pendingSel.value.start}:${pendingSel.value.end}` : '',
    store.speakingRef ?? '',
    store.preparingRef ?? ''
  ],
  (now, before) => {
    const wasSpeaking = before?.[0] !== '' && before?.[0] !== undefined
    const endedHl = wasSpeaking ? lastHl : null
    lastHl = store.speechHighlight
    nextTick(() => {
      const range = paintAll()
      const box = messagesEl.value
      if (!box) return
      const paused = Date.now() - lastUserScroll < USER_SCROLL_PAUSE_MS
      if (!store.speechHighlight) {
        // a fala acabou: a tela fica onde está; só a resposta ao vivo desce até o fim DELA (hora, botões)
        if (now[0] === '' && endedHl?.live && !paused) {
          const el = contentEls.get(endedHl.msg)?.closest('.group') as HTMLElement | null
          el?.scrollIntoView({ block: 'end', behavior: 'smooth' })
        }
        return
      }
      if (!range || (paused && !forceFollow)) return
      const b = box.getBoundingClientRect()
      const m = rangeRect(range)
      // só rola se o trecho falado não estiver visível na tela
      const visible = m.top >= b.top + 8 && m.bottom <= b.bottom - 8
      if (!visible) box.scrollTo({ top: box.scrollTop + (m.top - b.top) - b.height * 0.33, behavior: 'smooth' })
      forceFollow = false
    })
  }
)
let lastHl: typeof store.speechHighlight = null

onMounted(async () => {
  await store.loadHistory()
  scrollToBottom()
  try {
    ttsMuted.value = await getTtsMuted()
    ttsVolume.value = await getTtsVolume()
    ttsSpeed.value = await getTtsSpeed()
  } catch {
    // backend pode não estar disponível ainda
  }
})


async function toggleMute(): Promise<void> {
  const next = !ttsMuted.value
  ttsMuted.value = next
  try {
    await setTtsMuted(next)
  } catch {
    ttsMuted.value = !next
  }
}

// Velocidade da fala (1,0x a 3,0x): vale a partir da próxima frase e fica salva
// Tamanho do texto do chat: 100% = 14px; de 80% a 200%, de 10 em 10. Fica salvo e vale para todos os chats.
const TEXT_MIN = 80
const TEXT_MAX = 200
const TEXT_STEP = 10
const TEXT_BASE_PX = 14
const TEXT_KEY = 'voiceai.chatTextScale'
function loadTextScale(): number {
  try {
    const v = Number(localStorage.getItem(TEXT_KEY))
    return v >= TEXT_MIN && v <= TEXT_MAX ? v : 100
  } catch {
    return 100
  }
}
const textScale = ref(loadTextScale())
const chatFontPx = computed(() => `${(TEXT_BASE_PX * textScale.value) / 100}px`)

function setTextScale(v: number): void {
  textScale.value = Math.min(TEXT_MAX, Math.max(TEXT_MIN, Math.round(v / TEXT_STEP) * TEXT_STEP))
  try {
    localStorage.setItem(TEXT_KEY, String(textScale.value))
  } catch {
    // sem armazenamento: vale só nesta sessão
  }
}

function stepTextScale(dir: 1 | -1): void {
  setTextScale(textScale.value + dir * TEXT_STEP)
}

function onTextScaleInput(e: Event): void {
  setTextScale(Number((e.target as HTMLInputElement).value))
}

// 1,0x é o normal; a barra vai de 0,5x a 3,0x, de 0,1 em 0,1
const SPEED_MIN = 0.5
const SPEED_MAX = 3.0
const SPEED_STEP = 0.1
const ttsSpeed = ref(1.0)
/** valor enquanto arrasta a barra (o rótulo acompanha; aplica ao soltar) */
const speedDraft = ref<number | null>(null)

function fmtSpeed(v: number): string {
  // sempre uma casa (0,2x / 1,0x / 2,5x): o texto não muda de largura enquanto arrasta
  return `${(Math.round(v * 10) / 10).toFixed(1).replace('.', ',')}x`
}
const speedLabel = computed(() => fmtSpeed(speedDraft.value ?? ttsSpeed.value))

function onSpeedInput(e: Event): void {
  speedDraft.value = Number((e.target as HTMLInputElement).value)
}

function onSpeedChange(e: Event): void {
  speedDraft.value = null
  void applySpeed(Number((e.target as HTMLInputElement).value))
}

async function applySpeed(value: number): Promise<void> {
  const v = Math.round(Math.min(SPEED_MAX, Math.max(SPEED_MIN, value)) * 10) / 10
  const prev = ttsSpeed.value
  ttsSpeed.value = v
  try {
    ttsSpeed.value = await setTtsSpeed(v)
  } catch {
    ttsSpeed.value = prev
  }
}

function stepSpeed(dir: 1 | -1): void {
  void applySpeed(ttsSpeed.value + dir * SPEED_STEP)
}

const VOLUME_MAX = 150 // %
const VOLUME_STEP = 5 // %

async function applyVolume(percent: number): Promise<void> {
  const p = Math.min(VOLUME_MAX, Math.max(0, Math.round(percent)))
  const v = p / 100
  ttsVolume.value = v
  try {
    await setTtsVolume(v)
  } catch {
    // silencioso
  }
}

function onVolumeChange(e: Event): void {
  void applyVolume(Number((e.target as HTMLInputElement).value))
}

/** Botões - e +: de 5 em 5 (encaixa no múltiplo de 5 mais próximo se o valor estiver "quebrado") */
function stepVolume(dir: 1 | -1): void {
  const cur = Math.round(ttsVolume.value * 100)
  const next = dir > 0 ? Math.floor(cur / VOLUME_STEP) * VOLUME_STEP + VOLUME_STEP : Math.ceil(cur / VOLUME_STEP) * VOLUME_STEP - VOLUME_STEP
  void applyVolume(next)
}


function scrollToBottom(): void {
  nextTick(() => {
    if (messagesEl.value) {
      messagesEl.value.scrollTop = messagesEl.value.scrollHeight
    }
  })
}

async function send(): Promise<void> {
  const text = input.value.trim()
  if (!text || store.streaming) return
  input.value = ''
  autoResize()
  await store.sendMessage(text)
  scrollToBottom()
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
}

function autoResize(): void {
  if (!textareaEl.value) return
  textareaEl.value.style.height = 'auto'
  textareaEl.value.style.height = Math.min(textareaEl.value.scrollHeight, 160) + 'px'
}

// Ícone da resposta (avatar): pisca enquanto a voz sai; clique para parar ou para ouvir de novo
const speechNotice = ref<{ msg: ChatMessage; text: string } | null>(null)
let noticeTimer: ReturnType<typeof setTimeout> | null = null

function notice(msg: ChatMessage, text: string): void {
  speechNotice.value = { msg, text }
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => (speechNotice.value = null), 2500)
}

function speechTitle(msg: ChatMessage): string {
  if (store.isPreparing(msg)) return 'Preparando o áudio para falar... Clique para cancelar'
  if (store.isSpeaking(msg)) return 'Parar de falar'
  if (ttsMuted.value) return 'Voz mutada - ative o alto-falante no topo'
  if (!msg.content || msg.streaming) return 'Resposta da IA'
  if (store.resumeFor(msg) !== null) return 'Continuar de onde parou'
  return 'Ouvir a resposta de novo'
}

/** Fala a resposta a partir de `start` (até `end`, ou até o fim). O destaque começa no mesmo ponto. */
async function speakFrom(msg: ChatMessage, start: number, end: number | null = null): Promise<void> {
  const ref = store.speechRef(msg)
  if (!ref || !msg.content || msg.streaming || msg.content === '_(cancelado)_') return
  if (ttsMuted.value) {
    notice(msg, 'A voz está mutada')
    return
  }
  const text = msg.content.slice(start, end ?? undefined)
  if (!text.trim()) return
  // "Continuar" (de onde parou): o sublinhado do "parou em" fica até a voz começar.
  // Qualquer outro começo (seleção, do início): o sublinhado antigo sai na hora.
  const resume = store.resumeFor(msg)
  store.resumeMark = end === null && resume !== null && start === resume
    ? { msg, start, end: store.resumeSnippetEnd(msg.content, start) }
    : null
  store.setSpeechStart(ref, start, end)
  forceFollow = true // clique seu: a tela vai até onde a fala começar
  // mostra "preparando" já no clique (o áudio leva alguns segundos para ser gerado)
  store.preparingRef = ref
  try {
    // com o id da mensagem, o backend usa os áudios já salvos no disco (sem gerar de novo)
    const r = await replaySpeech(text, ref, msg.id !== undefined ? { message_id: msg.id, start, end } : undefined)
    if (!r.ok) {
      store.preparingRef = null
      notice(msg, r.reason === 'busy' ? 'A IA está ocupada respondendo' : 'Não foi possível falar agora')
    }
  } catch {
    store.preparingRef = null
    notice(msg, 'Não foi possível falar agora')
  }
}

// ---------- hover na %: marca no texto o que já tem áudio salvo (pronto para tocar sem internet) ----------
const cachedHover = ref<{ msg: ChatMessage; ranges: [number, number][] } | null>(null)
let cachedHoverSeq = 0

async function showCachedText(msg: ChatMessage): Promise<void> {
  if (msg.id === undefined) return
  const seq = ++cachedHoverSeq
  cachedHover.value = { msg, ranges: [] }
  try {
    const r = await getAudioRanges(msg.id)
    if (seq === cachedHoverSeq && cachedHover.value?.msg === msg) cachedHover.value = { msg, ranges: r.ranges }
  } catch {
    // sem os trechos: não marca nada
  }
}

function hideCachedText(msg: ChatMessage): void {
  cachedHoverSeq++
  if (cachedHover.value?.msg === msg) cachedHover.value = null
}

function paintCached(): void {
  const h = cachedHover.value
  if (!highlights || !HighlightCtor) return
  if (!h || !h.ranges.length) {
    highlights.delete('cached-hl')
    return
  }
  const node = contentEls.get(h.msg)?.firstChild
  if (!node || node.nodeType !== Node.TEXT_NODE) return
  const len = (node as Text).length
  const ranges = h.ranges
    .filter(([a, b]) => a < b && b <= len)
    .map(([a, b]) => new StaticRange({ startContainer: node, startOffset: a, endContainer: node, endOffset: b }))
  const hl = new HighlightCtor(...ranges)
  hl.priority = -1 // por baixo das outras marcações (fala, seleção, "parou em")
  highlights.set('cached-hl', hl)
}

watch(cachedHover, () => nextTick(paintCached))
onUnmounted(() => highlights?.delete('cached-hl'))

function fmtAudioSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function audioPctTitle(pct: number, bytes: number): string {
  const size = bytes > 0 ? `\nOcupa ${fmtAudioSize(bytes)} no disco.` : ''
  if (pct >= 100) return `Áudio desta resposta 100% salvo no computador: toca na hora, sem internet. O texto marcado é o que já está pronto.${size}`
  if (pct <= 0) return 'Áudio desta resposta ainda não salvo: ao dar play, é gerado pelo serviço de voz e guardado.'
  return `${pct}% do texto desta resposta já tem áudio salvo (marcado no texto). O resto é gerado ao dar play e guardado também.${size}`
}

/** "Parou em ...": trecho curto a partir de onde a fala parou */
function resumeSnippet(msg: ChatMessage): string {
  const pos = store.resumeFor(msg)
  if (pos === null) return ''
  const words = msg.content.slice(pos).trim().split(/\s+/).slice(0, 4).join(' ')
  return `...${words}...`
}

function restartSpeech(msg: ChatMessage): void {
  store.clearResume(msg)
  void speakFrom(msg, 0)
}

async function toggleSpeech(msg: ChatMessage): Promise<void> {
  if (store.isSpeaking(msg) || store.isPreparing(msg)) {
    store.speakingRef = null // resposta imediata no ícone; o backend confirma em seguida
    store.preparingRef = null
    try {
      await stopSpeech()
    } catch {
      // silencioso
    }
    return
  }
  // parou no meio antes? continua exatamente da palavra onde parou
  await speakFrom(msg, store.resumeFor(msg) ?? 0)
}

// ---------- menu da seleção: "Ouvir daqui" / "Ouvir este trecho" ----------
const selMenu = ref<{ msg: ChatMessage; start: number; end: number; x: number; y: number } | null>(null)

function messageOfEl(el: Element | null): ChatMessage | null {
  const p = el?.closest('[data-speak-msg]')
  if (!p) return null
  return store.messages.find((m) => m.role === 'assistant' && contentEls.get(m) === p) ?? null
}

function onSelectionDone(): void {
  // espera o navegador terminar a seleção (mouseup)
  setTimeout(() => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      selMenu.value = null
      return
    }
    const range = sel.getRangeAt(0)
    const a = range.startContainer
    const b = range.endContainer
    const msg = messageOfEl(a.parentElement)
    const el = msg ? contentEls.get(msg) : null
    // só dentro do texto de uma única resposta da IA (que tenha id, ou seja, já salva)
    if (!msg || !el || msg.id === undefined || messageOfEl(b.parentElement) !== msg || a !== el.firstChild || b !== el.firstChild) {
      selMenu.value = null
      return
    }
    const content = msg.content
    let start = range.startOffset
    let end = range.endOffset
    // ajusta para palavras inteiras (seleção começou/terminou no meio de uma palavra)
    while (start > 0 && /\S/.test(content[start - 1])) start--
    while (end < content.length && /\S/.test(content[end])) end++
    while (start < end && /\s/.test(content[start])) start++
    if (!content.slice(start, end).trim()) {
      selMenu.value = null
      return
    }
    const rect = range.getBoundingClientRect()
    selMenu.value = { msg, start, end, x: rect.left + rect.width / 2, y: rect.top }
  }, 0)
}

function hideSelMenu(): void {
  selMenu.value = null
}

function selMenuAction(kind: 'from' | 'only'): void {
  const m = selMenu.value
  if (!m) return
  selMenu.value = null
  window.getSelection()?.removeAllRanges()
  // marca de azul clarinho o que vai ser lido (a seleção nativa some ao clicar)
  const ref = store.speechRef(m.msg)
  if (ref) pendingSel.value = { msg: m.msg, start: m.start, end: m.end, kind, ref, seq: store.speechStartSeq }
  store.resumeMark = null // escolheu um trecho novo: o sublinhado antigo sai na hora
  void speakFrom(m.msg, m.start, kind === 'only' ? m.end : null)
}

function onDocMouseDown(e: MouseEvent): void {
  if (selMenu.value && !(e.target as Element)?.closest?.('[data-sel-menu]')) selMenu.value = null
}
onMounted(() => document.addEventListener('mousedown', onDocMouseDown, true))
onUnmounted(() => document.removeEventListener('mousedown', onDocMouseDown, true))

async function confirmDelete(id: number): Promise<void> {
  await store.deleteMessage(id)
  confirmDeleteId.value = null
}
</script>

<template>
  <div class="flex flex-col h-full gap-0">
    <!-- Cabeçalho (fixo): título | chat atual | voz -->
    <div class="grid grid-cols-[1fr_auto_1fr] items-center gap-3 mb-4 flex-shrink-0">
      <div class="min-w-0">
        <h1 class="text-xl font-semibold text-slate-100">Chat IA</h1>
        <p class="text-sm text-slate-500 mt-0.5 truncate hidden lg:block">Conversa com Claude via texto ou voz</p>
      </div>

      <!-- Chat atual: trocar, configurar e criar -->
      <div class="flex items-center gap-1.5">
        <ChatSwitcher
          :chats="store.chats"
          :active-id="store.activeChatId"
          :busy-id="store.busyChatId"
          @select="selectChat"
          @edit="openEditChat"
          @delete="askDeleteChat"
        />
        <button
          title="Configurar este chat (nome, system prompt, limpar, excluir)"
          :disabled="!store.activeChat"
          class="p-2 rounded-xl border border-indigo-600/50 bg-indigo-600/15 text-indigo-300 hover:bg-indigo-600/30 hover:text-indigo-100 transition-colors disabled:opacity-40"
          @click="openEditChat()"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
        <button
          title="Novo chat"
          class="p-2 rounded-xl border border-indigo-600/50 bg-indigo-600/15 text-indigo-300 hover:bg-indigo-600/30 hover:text-indigo-100 transition-colors"
          @click="openNewChat"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        </button>
      </div>

      <!-- Voz: velocidade e volume ficam recolhidos; passando o mouse, abrem para a esquerda -->
      <div class="flex items-center justify-end gap-1.5">
        <!-- Tamanho do texto do chat (vale para todos os chats; fica salvo) -->
        <div class="group/text flex items-center rounded-xl border border-transparent hover:border-slate-700/70 hover:bg-slate-900/70 transition-colors p-0.5">
          <div class="flex items-center gap-1.5 overflow-hidden max-w-0 opacity-0 group-hover/text:max-w-[220px] group-hover/text:opacity-100 group-hover/text:pl-1 group-hover/text:pr-1.5 transition-all duration-200">
            <button
              title="Diminuir o texto (-10%)"
              :disabled="textScale <= TEXT_MIN"
              class="w-6 h-6 flex items-center justify-center rounded-md border border-indigo-600/50 bg-indigo-600/15 text-indigo-300 hover:bg-indigo-600/30 hover:text-indigo-100 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-indigo-600/15 disabled:hover:text-indigo-300"
              @click="stepTextScale(-1)"
            >
              <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
                <path stroke-linecap="round" d="M5 12h14" />
              </svg>
            </button>
            <input
              type="range"
              :min="TEXT_MIN"
              :max="TEXT_MAX"
              :step="TEXT_STEP"
              :value="textScale"
              title="Tamanho do texto do chat (80% a 200%)"
              class="w-24 h-1 accent-indigo-500 cursor-pointer"
              @input="onTextScaleInput"
            />
            <button
              title="Aumentar o texto (+10%)"
              :disabled="textScale >= TEXT_MAX"
              class="w-6 h-6 flex items-center justify-center rounded-md border border-indigo-600/50 bg-indigo-600/15 text-indigo-300 hover:bg-indigo-600/30 hover:text-indigo-100 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-indigo-600/15 disabled:hover:text-indigo-300"
              @click="stepTextScale(1)"
            >
              <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
                <path stroke-linecap="round" d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </div>
          <button
            :title="textScale === 100 ? 'Tamanho do texto: normal (100%)' : `Tamanho do texto: ${textScale}%. Clique para voltar ao normal (100%)`"
            :class="[
              'h-[30px] w-[62px] px-2 rounded-lg border flex items-center justify-center gap-1 text-xs font-medium tabular-nums transition-colors flex-shrink-0',
              textScale !== 100
                ? 'text-indigo-100 border-indigo-500/70 bg-indigo-600/30 hover:bg-indigo-600/40'
                : 'text-indigo-300 border-indigo-600/50 bg-indigo-600/15 hover:bg-indigo-600/30 hover:text-indigo-100'
            ]"
            @click="setTextScale(100)"
          >
            <span class="font-semibold leading-none"><span class="text-[13px]">A</span><span class="text-[10px]">a</span></span>
            {{ textScale }}%
          </button>
        </div>

        <!-- Velocidade da fala -->
        <div class="group/speed flex items-center rounded-xl border border-transparent hover:border-slate-700/70 hover:bg-slate-900/70 transition-colors p-0.5">
          <div class="flex items-center gap-1.5 overflow-hidden max-w-0 opacity-0 group-hover/speed:max-w-[220px] group-hover/speed:opacity-100 group-hover/speed:pl-1 group-hover/speed:pr-1.5 transition-all duration-200">
            <button
              title="Mais devagar (-0,1x)"
              :disabled="ttsSpeed <= SPEED_MIN + 0.001"
              class="w-6 h-6 flex items-center justify-center rounded-md border border-indigo-600/50 bg-indigo-600/15 text-indigo-300 hover:bg-indigo-600/30 hover:text-indigo-100 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-indigo-600/15 disabled:hover:text-indigo-300"
              @click="stepSpeed(-1)"
            >
              <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
                <path stroke-linecap="round" d="M5 12h14" />
              </svg>
            </button>
            <input
              type="range"
              :min="SPEED_MIN"
              :max="SPEED_MAX"
              :step="SPEED_STEP"
              :value="speedDraft ?? ttsSpeed"
              title="Velocidade da fala (0,5x a 3,0x; normal = 1,0x)"
              class="w-24 h-1 accent-indigo-500 cursor-pointer"
              @input="onSpeedInput"
              @change="onSpeedChange"
            />
            <button
              title="Mais rápido (+0,1x)"
              :disabled="ttsSpeed >= SPEED_MAX - 0.001"
              class="w-6 h-6 flex items-center justify-center rounded-md border border-indigo-600/50 bg-indigo-600/15 text-indigo-300 hover:bg-indigo-600/30 hover:text-indigo-100 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-indigo-600/15 disabled:hover:text-indigo-300"
              @click="stepSpeed(1)"
            >
              <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
                <path stroke-linecap="round" d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </div>
          <button
            :title="ttsSpeed === 1 ? 'Velocidade da fala: normal (1,0x)' : `Velocidade da fala: ${speedLabel}. Clique para voltar ao normal (1,0x)`"
            :class="[
              'h-[30px] w-[62px] px-2 rounded-lg border flex items-center justify-center gap-1 text-xs font-medium tabular-nums transition-colors flex-shrink-0',
              ttsSpeed !== 1
                ? 'text-indigo-100 border-indigo-500/70 bg-indigo-600/30 hover:bg-indigo-600/40'
                : 'text-indigo-300 border-indigo-600/50 bg-indigo-600/15 hover:bg-indigo-600/30 hover:text-indigo-100'
            ]"
            @click="applySpeed(1)"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 13.5a8.25 8.25 0 1116.5 0M12 13.5l3.75-3.75M12 13.5h.008" />
            </svg>
            {{ speedLabel }}
          </button>
        </div>

        <!-- Volume -->
        <div class="group/vol flex items-center rounded-xl border border-transparent hover:border-slate-700/70 hover:bg-slate-900/70 transition-colors p-0.5">
          <div class="flex items-center gap-1.5 overflow-hidden max-w-0 opacity-0 group-hover/vol:max-w-[240px] group-hover/vol:opacity-100 group-hover/vol:pl-1 group-hover/vol:pr-1.5 transition-all duration-200">
            <button
              title="Diminuir volume (-5%)"
              :disabled="Math.round(ttsVolume * 100) <= 0"
              class="w-6 h-6 flex items-center justify-center rounded-md border border-indigo-600/50 bg-indigo-600/15 text-indigo-300 hover:bg-indigo-600/30 hover:text-indigo-100 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-indigo-600/15 disabled:hover:text-indigo-300"
              @click="stepVolume(-1)"
            >
              <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
                <path stroke-linecap="round" d="M5 12h14" />
              </svg>
            </button>
            <input
              type="range"
              min="0"
              :max="VOLUME_MAX"
              :step="VOLUME_STEP"
              :value="Math.round(ttsVolume * 100)"
              title="Volume da voz"
              class="w-20 h-1 accent-indigo-500 cursor-pointer"
              @change="onVolumeChange"
            />
            <button
              title="Aumentar volume (+5%)"
              :disabled="Math.round(ttsVolume * 100) >= VOLUME_MAX"
              class="w-6 h-6 flex items-center justify-center rounded-md border border-indigo-600/50 bg-indigo-600/15 text-indigo-300 hover:bg-indigo-600/30 hover:text-indigo-100 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-indigo-600/15 disabled:hover:text-indigo-300"
              @click="stepVolume(1)"
            >
              <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
                <path stroke-linecap="round" d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </div>
            <button
              :title="ttsMuted ? 'Voz mutada. Clique para ativar' : `Volume da voz: ${Math.round(ttsVolume * 100)}%. Clique para mutar`"
              :class="[
                'h-[30px] w-[62px] px-2 rounded-lg border flex items-center justify-center gap-1 text-xs font-medium tabular-nums transition-colors flex-shrink-0',
                ttsMuted
                  ? 'text-slate-400 border-slate-700 bg-slate-800/60 hover:text-slate-200 hover:border-slate-500'
                  : 'text-indigo-300 border-indigo-600/50 bg-indigo-600/15 hover:bg-indigo-600/30 hover:text-indigo-100'
              ]"
              @click="toggleMute"
            >
              <svg v-if="!ttsMuted" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
              </svg>
              <svg v-else class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M17.25 9.75L19.5 12m0 0l2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-10.5-6l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
              </svg>
              <span>{{ ttsMuted ? 'Mudo' : `${Math.round(ttsVolume * 100)}%` }}</span>
            </button>
        </div>
      </div>
    </div>

    <!-- Área de mensagens -->
    <div
      ref="messagesEl"
      :style="{ '--chat-font': chatFontPx }"
      class="flex-1 overflow-y-auto flex flex-col gap-3 min-h-0 pr-1"
      @wheel.passive="markUserScroll"
      @touchmove.passive="markUserScroll"
      @mousedown="onMessagesMouseDown"
      @keydown="onMessagesKey"
      @mouseup="onSelectionDone"
      @scroll.passive="hideSelMenu"
    >
      <!-- Estado vazio -->
      <div v-if="store.messages.length === 0" class="flex flex-col items-center justify-center h-full gap-3 text-center">
        <div class="w-12 h-12 rounded-2xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center">
          <svg class="w-6 h-6 text-purple-400" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
          </svg>
        </div>
        <div>
          <p class="text-slate-400 text-sm font-medium">{{ store.activeChat ? `Nenhuma mensagem em "${store.activeChat.name}"` : 'Nenhuma conversa ainda' }}</p>
          <p class="text-slate-600 text-xs mt-0.5">Digite uma mensagem abaixo ou pergunte por voz para começar</p>
          <p v-if="store.activeChat?.system_prompt" class="text-slate-600 text-xs mt-2 max-w-md line-clamp-2">
            System prompt: {{ store.activeChat.system_prompt }}
          </p>
        </div>
      </div>

      <!-- Mensagens -->
      <template v-for="(msg, i) in store.messages" :key="i">

        <!-- Mensagem do usuário -->
        <div v-if="msg.role === 'user'" class="flex justify-end group">
          <div class="max-w-[80%]">
            <div class="bg-indigo-600/80 border border-indigo-500/30 rounded-2xl rounded-tr-sm px-4 py-2.5">
              <p class="chat-text text-slate-100 whitespace-pre-wrap">{{ msg.content }}</p>
            </div>
            <!-- Abaixo do card: ações (no hover) + hora -->
            <div class="flex justify-end items-center gap-1 mt-1 h-5">
              <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <template v-if="msg.id !== undefined && confirmDeleteId === msg.id">
                <span class="text-xs text-slate-500 mr-1">Apagar?</span>
                <button
                  class="text-xs text-red-400 hover:text-red-300 transition-colors"
                  @click="confirmDelete(msg.id!)"
                >Sim</button>
                <span class="text-slate-600 text-xs">/</span>
                <button
                  class="text-xs text-slate-400 hover:text-slate-200 transition-colors"
                  @click="confirmDeleteId = null"
                >Não</button>
              </template>
              <template v-else>
                <CopyButton :text="msg.content" />
                <button
                  v-if="msg.id !== undefined"
                  title="Apagar mensagem"
                  class="p-1 rounded text-slate-500 hover:text-red-400 transition-colors"
                  @click="confirmDeleteId = msg.id!"
                >
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </template>
              </div>
              <span v-if="msg.ts" class="text-[11px] text-slate-600 tabular-nums" :title="fullTime(msg.ts)">{{ fmtTime(msg.ts) }}</span>
            </div>
          </div>
        </div>

        <!-- Mensagem do assistente -->
        <div v-else class="flex justify-start gap-2.5 group">
          <!-- Ícone da resposta: pisca enquanto fala; clique = parar / ouvir de novo -->
          <div class="relative flex-shrink-0 mt-0.5">
            <button
              type="button"
              :title="speechTitle(msg)"
              :class="[
                'speech-avatar group/av w-7 h-7 rounded-full border flex items-center justify-center transition-colors',
                store.isPreparing(msg)
                  ? 'bg-sky-500/15 border-sky-400/60'
                  : store.isSpeaking(msg)
                    ? 'speaking bg-purple-500/30 border-purple-400/70'
                    : 'bg-purple-500/20 border-purple-500/30 hover:bg-purple-500/30 hover:border-purple-400/60'
              ]"
              @click="toggleSpeech(msg)"
            >
              <!-- preparando o áudio: anel girando (no hover → quadrado de cancelar) -->
              <template v-if="store.isPreparing(msg)">
                <span class="w-3.5 h-3.5 rounded-full border-2 border-sky-300/25 border-t-sky-300 animate-spin group-hover/av:hidden" />
                <svg class="w-3 h-3 text-sky-200 hidden group-hover/av:block" fill="currentColor" viewBox="0 0 24 24">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              </template>
              <!-- falando: ondas de voz (some no hover → quadrado de parar) -->
              <template v-else-if="store.isSpeaking(msg)">
                <span class="flex items-center gap-[2px] h-3.5 group-hover/av:hidden">
                  <span v-for="n in 3" :key="n" class="voice-bar w-[3px] rounded-full bg-purple-300" :style="`animation-delay:${(n - 1) * 0.18}s`" />
                </span>
                <svg class="w-3 h-3 text-purple-200 hidden group-hover/av:block" fill="currentColor" viewBox="0 0 24 24">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              </template>
              <!-- parado: ondas estáticas (no hover → play) -->
              <template v-else>
                <span class="flex items-center gap-[2px] h-3.5" :class="msg.content && !msg.streaming ? 'group-hover/av:hidden' : ''">
                  <span class="w-[3px] h-1.5 rounded-full bg-purple-400" />
                  <span class="w-[3px] h-3 rounded-full bg-purple-400" />
                  <span class="w-[3px] h-2 rounded-full bg-purple-400" />
                </span>
                <svg
                  v-if="msg.content && !msg.streaming"
                  class="w-3 h-3 text-purple-200 ml-0.5 hidden group-hover/av:block"
                  fill="currentColor"
                  viewBox="0 0 24 24"
                ><path d="M8 5v14l11-7z" /></svg>
              </template>
            </button>
            <!-- % do texto desta resposta que já tem áudio salvo (toca na hora, sem internet) -->
            <!-- passando o mouse: marca no texto o que já tem áudio salvo -->
            <span
              v-if="msg.content && !msg.streaming && store.audioPct(msg) !== null"
              :title="audioPctTitle(store.audioPct(msg)!, store.audioBytes(msg))"
              :class="[
                'block mt-1 text-[9.5px] leading-none text-center tabular-nums cursor-help transition-colors',
                cachedHover?.msg === msg ? 'text-teal-300' : store.audioPct(msg) === 100 ? 'text-purple-300/90' : 'text-slate-500'
              ]"
              @mouseenter="showCachedText(msg)"
              @mouseleave="hideCachedText(msg)"
            >{{ store.audioPct(msg) }}%</span>
            <span
              v-if="speechNotice?.msg === msg"
              class="absolute left-0 top-9 z-10 whitespace-nowrap text-[11px] bg-slate-800 border border-slate-700 text-slate-300 rounded-md px-2 py-1 shadow-lg"
            >{{ speechNotice.text }}</span>
          </div>
          <div :class="['max-w-[80%] flex flex-col', msg.media?.length ? 'w-[80%]' : '']">
            <div
              v-if="msg.content || !msg.media?.length"
              class="bg-slate-800/60 border border-slate-700/40 rounded-2xl rounded-tl-sm px-4 py-2.5"
            >
              <!-- Texto cancelado -->
              <p v-if="msg.content === '_(cancelado)_'" class="text-slate-500 text-sm italic">cancelado</p>
              <!-- Conteúdo normal -->
              <!-- texto (com o trecho que está sendo falado destacado) -->
              <p
                v-else-if="msg.content"
                :ref="(el) => setContentEl(msg, el)"
                :data-speak-msg="msg.id ?? ''"
                class="chat-text text-slate-200 whitespace-pre-wrap"
              >{{ msg.content }}</p>
              <!-- Pesquisando na internet (ou lendo uma página) antes de responder -->
              <div v-else-if="msg.activity" class="flex items-center gap-2 py-0.5 text-sm text-sky-300/90">
                <svg class="w-4 h-4 flex-shrink-0 animate-pulse" fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" />
                </svg>
                <span class="truncate">{{ activityText(msg.activity) }}…</span>
              </div>
              <!-- Loading inicial -->
              <div v-else class="flex gap-1 py-0.5">
                <span v-for="n in 3" :key="n" class="w-1.5 h-1.5 rounded-full bg-slate-500 animate-bounce" :style="`animation-delay:${(n-1)*0.15}s`" />
              </div>
            </div>
            <!-- Imagens / vídeos encontrados pela IA -->
            <MediaGrid
              v-if="msg.media?.length"
              :groups="msg.media"
              :class="msg.content ? 'mt-2' : ''"
            />
            <!-- Ações abaixo do card (apenas após concluir e não cancelado) -->
            <div
              v-if="(msg.content || msg.media?.length) && !msg.streaming && msg.content !== '_(cancelado)_'"
              class="flex items-center gap-1 mt-1 min-h-5 flex-wrap"
            >
              <!-- parou no meio: continuar exatamente da palavra onde parou, ou do início -->
              <span
                v-if="store.resumeFor(msg) !== null && !store.isSpeaking(msg) && !store.isPreparing(msg)"
                class="flex items-center gap-1.5 mr-2 text-[11px]"
              >
                <span class="text-slate-500">Parou em <span class="text-slate-300">"{{ resumeSnippet(msg) }}"</span></span>
                <button
                  title="Continuar exatamente de onde a fala parou"
                  class="flex items-center gap-1 px-1.5 py-px rounded-md border border-indigo-600/50 bg-indigo-600/15 text-indigo-300 hover:bg-indigo-600/30 hover:text-indigo-100 transition-colors"
                  @click="speakFrom(msg, store.resumeFor(msg) ?? 0)"
                >
                  <svg class="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                  Continuar
                </button>
                <button
                  title="Ouvir a resposta desde o começo"
                  class="flex items-center gap-1 px-1.5 py-px rounded-md border border-indigo-600/50 bg-indigo-600/15 text-indigo-300 hover:bg-indigo-600/30 hover:text-indigo-100 transition-colors"
                  @click="restartSpeech(msg)"
                >
                  <svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" />
                  </svg>
                  Do início
                </button>
              </span>
              <!-- preparando o áudio do "ouvir de novo" -->
              <span v-if="store.isPreparing(msg)" class="flex items-center gap-1 text-[11px] text-sky-300/90 mr-1">
                <span class="w-2.5 h-2.5 rounded-full border-[1.5px] border-sky-300/25 border-t-sky-300 animate-spin" />
                Preparando a fala...
              </span>
              <!-- hora, tempo de resposta e uso da internet -->
              <span v-if="msg.ts" class="text-[11px] text-slate-600 tabular-nums" :title="fullTime(msg.ts)">{{ fmtTime(msg.ts) }}</span>
              <template v-if="msg.duration_s !== undefined && msg.duration_s !== null">
                <span class="text-[11px] text-slate-700">·</span>
                <span class="flex items-center gap-1 text-[11px] text-slate-600 tabular-nums" title="Tempo até a resposta ficar completa">
                  <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  {{ fmtSeconds(msg.duration_s) }}
                </span>
              </template>
              <span
                v-if="webTools(msg).length"
                :title="webTitle(msg)"
                class="ml-1 flex items-center gap-1 text-[10.5px] font-medium text-sky-300/90 bg-sky-500/10 border border-sky-500/25 rounded-full px-2 py-px cursor-default"
              >
                <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" />
                </svg>
                Pesquisou na internet
              </span>
              <div class="flex items-center gap-1 ml-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <template v-if="msg.id !== undefined && confirmDeleteId === msg.id">
                <span class="text-xs text-slate-500 mr-1">Apagar?</span>
                <button
                  class="text-xs text-red-400 hover:text-red-300 transition-colors"
                  @click="confirmDelete(msg.id!)"
                >Sim</button>
                <span class="text-slate-600 text-xs">/</span>
                <button
                  class="text-xs text-slate-400 hover:text-slate-200 transition-colors"
                  @click="confirmDeleteId = null"
                >Não</button>
              </template>
              <template v-else>
                <CopyButton v-if="msg.content" :text="msg.content" />
                <button
                  v-if="msg.id !== undefined"
                  title="Apagar mensagem"
                  class="p-1 rounded text-slate-500 hover:text-red-400 transition-colors"
                  @click="confirmDeleteId = msg.id!"
                >
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </template>
              </div>
            </div>
          </div>
        </div>

      </template>
    </div>

    <!-- Erro -->
    <div v-if="store.error" class="flex-shrink-0 mt-2 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2 flex items-center gap-2">
      <svg class="w-4 h-4 text-red-400 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
      </svg>
      <p class="text-red-400 text-xs flex-1">{{ store.error }}</p>
      <button class="text-red-500 hover:text-red-400 text-xs" @click="store.error = null">✕</button>
    </div>

    <!-- Input -->
    <div class="flex-shrink-0 mt-3 flex gap-2 items-end bg-slate-800/60 border border-slate-700/40 rounded-2xl px-3 py-2.5">
      <textarea
        ref="textareaEl"
        v-model="input"
        :placeholder="busyElsewhere ? `Aguarde a resposta no chat &quot;${busyElsewhere.name}&quot; terminar...` : 'Digite sua mensagem… (Enter para enviar, Shift+Enter para nova linha)'"
        rows="1"
        class="flex-1 bg-transparent text-slate-200 text-sm leading-relaxed resize-none focus:outline-none placeholder-slate-600 min-h-[24px] max-h-40"
        @input="autoResize"
        @keydown="onKeydown"
      />
      <button
        :disabled="!input.trim() || store.streaming"
        class="flex-shrink-0 p-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
        @click="send"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
        </svg>
      </button>
    </div>

    <!-- Menu da seleção de texto numa resposta: ouvir a partir dali, ou só o trecho -->
    <Teleport to="body">
      <div
        v-if="selMenu"
        data-sel-menu
        class="fixed z-[90] -translate-x-1/2 -translate-y-full -mt-2 flex flex-col gap-0.5 p-1 rounded-xl border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl shadow-black/50"
        :style="{ left: `${selMenu.x}px`, top: `${selMenu.y - 8}px` }"
        @mousedown.prevent
      >
        <button
          class="flex items-start gap-2.5 px-2.5 py-1.5 rounded-lg text-left hover:bg-indigo-600/15 transition-colors"
          @click="selMenuAction('from')"
        >
          <svg class="w-3.5 h-3.5 mt-0.5 text-indigo-300 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
          <span>
            <span class="block text-xs font-medium text-slate-100">Ouvir daqui</span>
            <span class="block text-[11px] text-slate-500">Do início da seleção até o fim da resposta</span>
          </span>
        </button>
        <button
          class="flex items-start gap-2.5 px-2.5 py-1.5 rounded-lg text-left hover:bg-indigo-600/15 transition-colors"
          @click="selMenuAction('only')"
        >
          <svg class="w-3.5 h-3.5 mt-0.5 text-indigo-300 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
          </svg>
          <span>
            <span class="block text-xs font-medium text-slate-100">Ouvir este trecho</span>
            <span class="block text-[11px] text-slate-500">Só o que está selecionado</span>
          </span>
        </button>
      </div>
    </Teleport>

    <ChatFormModal
      :open="formOpen"
      :mode="formMode"
      :chat="formChat"
      :default-name="nextChatName"
      :busy="formChat !== null && store.busyChatId === formChat.id"
      @close="formOpen = false"
      @save="saveChatForm"
      :audio-limit-mb="settingsStore.settings?.speech_cache_limit_mb ?? 20"
      @clear="askClearChat"
      @delete="askDeleteChat"
      @clear-audio="(c) => (chatAudioToClear = c)"
    />

    <ConfirmModal
      :open="chatAudioToClear !== null"
      :title="`Apagar os áudios salvos de &quot;${chatAudioToClear?.name ?? ''}&quot;?`"
      confirm-label="Apagar áudios"
      tone="warning"
      :loading="chatActionLoading"
      @confirm="confirmClearAudio"
      @cancel="chatAudioToClear = null"
    >
      <p>Só os <span class="text-slate-100">arquivos de áudio</span> das respostas são apagados. As mensagens continuam no chat.</p>
      <p class="text-xs text-slate-400 mt-1.5">
        Se você der play de novo numa resposta, o áudio é gerado outra vez pelo serviço de voz: funciona normalmente,
        só usa a internet e leva alguns segundos para começar.
      </p>
    </ConfirmModal>

    <ConfirmModal
      :open="chatToDelete !== null"
      :title="`Excluir o chat &quot;${chatToDelete?.name ?? ''}&quot;?`"
      confirm-label="Excluir chat"
      :loading="chatActionLoading"
      @confirm="confirmDeleteChat"
      @cancel="chatToDelete = null"
    >
      <p>{{ messagesLabel(chatToDelete?.message_count) }} O histórico, o system prompt e o contexto da IA deste chat serão apagados.</p>
      <p class="text-xs text-red-300/90 mt-1.5">Isso não pode ser desfeito.</p>
    </ConfirmModal>

    <ConfirmModal
      :open="chatToClear !== null"
      :title="`Limpar as mensagens de &quot;${chatToClear?.name ?? ''}&quot;?`"
      confirm-label="Limpar mensagens"
      tone="warning"
      :loading="chatActionLoading"
      @confirm="confirmClearChat"
      @cancel="chatToClear = null"
    >
      <p>Todas as mensagens deste chat serão apagadas e a IA começa a conversa do zero. O nome e o system prompt continuam.</p>
      <p class="text-xs text-amber-300/90 mt-1.5">Isso não pode ser desfeito.</p>
    </ConfirmModal>
  </div>
</template>

<style scoped>
/* Ondas de voz no ícone da resposta enquanto a IA fala (ritmo lento, como fala) */
.voice-bar {
  height: 14px;
  transform-origin: center;
  animation: voice-wave 1.1s ease-in-out infinite;
}
@keyframes voice-wave {
  0%, 100% { transform: scaleY(0.35); }
  50% { transform: scaleY(1); }
}
.speech-avatar.speaking {
  animation: speak-ring 1.8s ease-out infinite;
}
@keyframes speak-ring {
  0% { box-shadow: 0 0 0 0 rgba(192, 132, 252, 0.45); }
  100% { box-shadow: 0 0 0 7px rgba(192, 132, 252, 0); }
}
</style>

<style>
/* texto das mensagens do chat: tamanho escolhido no topo (Aa) */
.chat-text {
  font-size: var(--chat-font, 14px);
  line-height: 1.65;
}
/* trecho que está sendo falado (3 palavras que andam junto com a voz), desenhado por cima do texto */
::highlight(speech-hl) {
  background-color: rgba(129, 140, 248, 0.35);
  color: #f8fafc;
}
/* passando o mouse na %: o que já tem áudio salvo (pronto para tocar sem internet) */
::highlight(cached-hl) {
  background-color: rgba(45, 212, 191, 0.16);
  color: #ccfbf1;
}
/* trecho escolhido no menu da seleção (vai ser lido) */
::highlight(sel-hl) {
  background-color: rgba(56, 189, 248, 0.16);
}
/* "parou em": de onde a fala continua */
::highlight(resume-hl) {
  text-decoration: underline;
  text-decoration-color: rgba(167, 139, 250, 0.95);
  text-decoration-thickness: 2px;
  text-underline-offset: 3px;
}
</style>
