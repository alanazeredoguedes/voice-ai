<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { SELF, useCallStore, type CallFile, type ShareQuality } from '../stores/call'
import CopyButton from '../components/CopyButton.vue'
import ConfirmModal from '../components/ConfirmModal.vue'
import CallShareModal from '../components/CallShareModal.vue'
import CallAudioPopover from '../components/CallAudioPopover.vue'
import CallComposer from '../components/CallComposer.vue'
import CallMediaViewer from '../components/CallMediaViewer.vue'
import CallVolumeMenu from '../components/CallVolumeMenu.vue'
import CallLogPanel from '../components/CallLogPanel.vue'
import { formatVolume, sliderToVolume, volumeToSlider } from '../utils/callVolume'

const store = useCallStore()

// ---------------------------------------------------------------- tela inicial (fora de uma chamada)
const mode = ref<'create' | 'join'>('create')
const joinCode = ref('')
const roomName = ref('')
const busy = computed(() => store.status === 'connecting')
const deletingRoom = ref<{ id: string; name: string } | null>(null)
const showLogs = ref(false)
const logProblems = computed(() => store.logs.filter((e) => e.level !== 'info').length)

function submit(): void {
  if (mode.value === 'create') void store.create({ roomName: roomName.value })
  else void store.join(joinCode.value)
}

function reopen(id: string): void {
  void store.create({ reopenId: id })
}

async function confirmDeleteRoom(): Promise<void> {
  if (deletingRoom.value) await store.deleteRoom(deletingRoom.value.id)
  deletingRoom.value = null
}

function fmtDay(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const yesterday = new Date(Date.now() - 86400000)
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === today.toDateString()) return `hoje, ${time}`
  if (d.toDateString() === yesterday.toDateString()) return `ontem, ${time}`
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }) + `, ${time}`
}

// salas do histórico abertas agora (e quem está nelas), consultado de tempos em tempos fora da chamada
let liveTimer: ReturnType<typeof setInterval> | null = null
async function pollLive(): Promise<void> {
  if (store.inCall || store.status === 'connecting' || document.hidden) return
  await store.refreshLive()
}
onMounted(async () => {
  store.setViewOpen(true)
  await store.refreshRooms()
  void pollLive()
  liveTimer = setInterval(() => void pollLive(), 20000)
})
onUnmounted(() => {
  store.setViewOpen(false)
  if (liveTimer) clearInterval(liveTimer)
})

// ---------------------------------------------------------------- transmissões
const showShare = ref(false)
const showLeave = ref(false)
const screenVideo = ref<HTMLVideoElement | null>(null)
const stage = ref<HTMLDivElement | null>(null)

/** cards da lateral: uma por transmissão (a minha e as dos outros) */
const shares = computed(() => [
  ...(store.sharing ? [{ id: SELF, label: 'Sua tela' }] : []),
  ...store.sharingPeers.map((p) => ({ id: p.id, label: p.name }))
])
const watchingLabel = computed(() => shares.value.find((x) => x.id === store.watching)?.label ?? '')
const expanded = computed(() => !!store.watching && store.viewMode === 'expanded')
const mini = computed(() => !!store.watching && store.viewMode === 'mini')

watch(
  [screenVideo, () => store.viewStream],
  ([el, stream]) => {
    if (el && el.srcObject !== stream) el.srcObject = stream
    if (!stream) resetZoom()
  },
  { flush: 'post' }
)
watch(
  () => store.viewMode,
  () => resetZoom()
)

async function onShareStart(sourceId: string, quality: ShareQuality, withAudio: boolean): Promise<void> {
  showShare.value = false
  await store.startShare(sourceId, quality, withAudio)
}

function openShare(id: string): void {
  if (store.watching === id) store.setViewMode('expanded')
  else store.watch(id)
}

// zoom (roda do mouse) e arrastar, só com a transmissão aberta em tamanho grande
const scale = ref(1)
const pan = reactive({ x: 0, y: 0 })
const panning = ref(false)

const videoStyle = computed(() => ({
  transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale.value})`,
  cursor: scale.value > 1 ? (panning.value ? 'grabbing' : 'grab') : 'default'
}))

function onWheel(e: WheelEvent): void {
  if (!expanded.value || !stage.value) return
  e.preventDefault()
  const next = Math.max(1, Math.min(8, scale.value * (e.deltaY < 0 ? 1.12 : 0.89)))
  // mantém sob o cursor o ponto que já estava sob ele
  const rect = stage.value.getBoundingClientRect()
  const mx = e.clientX - rect.left - rect.width / 2
  const my = e.clientY - rect.top - rect.height / 2
  const ratio = next / scale.value
  pan.x = mx + (pan.x - mx) * ratio
  pan.y = my + (pan.y - my) * ratio
  scale.value = next
  if (next === 1) resetZoom()
}

function onPanStart(e: MouseEvent): void {
  if (!expanded.value || scale.value <= 1 || (e.target as HTMLElement).closest('button, input')) return
  panning.value = true
  const startX = e.clientX - pan.x
  const startY = e.clientY - pan.y
  const onMove = (ev: MouseEvent): void => {
    pan.x = ev.clientX - startX
    pan.y = ev.clientY - startY
  }
  const onUp = (): void => {
    panning.value = false
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

function resetZoom(): void {
  scale.value = 1
  pan.x = 0
  pan.y = 0
}

const fullscreen = ref(false)
const onFullscreenChange = (): void => {
  fullscreen.value = !!document.fullscreenElement
}
onMounted(() => document.addEventListener('fullscreenchange', onFullscreenChange))
onUnmounted(() => document.removeEventListener('fullscreenchange', onFullscreenChange))

async function toggleFullscreen(): Promise<void> {
  if (document.fullscreenElement) await document.exitFullscreen()
  else {
    store.setViewMode('expanded')
    await stage.value?.requestFullscreen()
  }
}

async function minimize(): Promise<void> {
  if (document.fullscreenElement) await document.exitFullscreen()
  store.setViewMode('mini')
}

async function closeView(): Promise<void> {
  if (document.fullscreenElement) await document.exitFullscreen()
  store.watch(null)
}

// ---------------------------------------------------------------- medidores de voz
const IDLE_BARS = [0.15, 0.15, 0.15]
const micBars = ref(IDLE_BARS)
const peerBars = reactive<Record<string, number[]>>({})
let micCtx: AudioContext | null = null
let micAnalyser: AnalyserNode | null = null
let frame: number | null = null
const buffer = new Uint8Array(32)

watch(
  () => store.micStream,
  (stream) => {
    void micCtx?.close()
    micCtx = null
    micAnalyser = null
    if (!stream) return
    micCtx = new AudioContext()
    micAnalyser = micCtx.createAnalyser()
    micAnalyser.fftSize = 64
    micAnalyser.smoothingTimeConstant = 0.7
    micCtx.createMediaStreamSource(stream).connect(micAnalyser)
  },
  { immediate: true }
)

function readBars(analyser: AnalyserNode | null): number[] {
  if (!analyser) return IDLE_BARS
  analyser.getByteFrequencyData(buffer)
  return [2, 5, 8].map((b) => Math.max(0.15, buffer[b] / 255))
}

function tick(): void {
  if (store.inCall) {
    micBars.value = store.muted ? IDLE_BARS : readBars(micAnalyser)
    for (const peer of store.peers) peerBars[peer.id] = readBars(store.getPeerAnalyser(peer.id))
  }
  frame = requestAnimationFrame(tick)
}
onMounted(tick)
onUnmounted(() => {
  if (frame !== null) cancelAnimationFrame(frame)
  void micCtx?.close()
})

// ---------------------------------------------------------------- volume (inclusive pelo botão direito)
function onVolume(peerId: string, e: Event): void {
  store.setVolume(peerId, sliderToVolume(parseFloat((e.target as HTMLInputElement).value)))
}

/** menu do botão direito: 'screen' = som da transmissão aberta; senão, o id do participante */
const menu = ref<{ x: number; y: number; target: string } | null>(null)
const menuPeer = computed(() => store.peers.find((p) => p.id === menu.value?.target) ?? null)

function openMenu(e: MouseEvent, target: string): void {
  if (target === 'screen' && store.watching === SELF) return // a minha própria transmissão não toca som aqui
  menu.value = { x: e.clientX, y: e.clientY, target }
}

function onMenuVolume(value: number): void {
  if (!menu.value) return
  if (menu.value.target === 'screen') store.setScreenVolume(value)
  else {
    store.setVolume(menu.value.target, value)
    if (store.mutedPeers.has(menu.value.target)) store.togglePeerMute(menu.value.target)
  }
}

function onMenuMute(): void {
  if (!menu.value) return
  if (menu.value.target === 'screen') store.toggleScreenMute()
  else store.togglePeerMute(menu.value.target)
}

// ---------------------------------------------------------------- chat
const chatEl = ref<HTMLElement | null>(null)
const composer = ref<InstanceType<typeof CallComposer> | null>(null)
const editing = ref<{ id: string; text: string } | null>(null)
const deletingId = ref<string | null>(null)
const viewer = ref<CallFile | null>(null)
const dragging = ref(false)

const CHAT_COLORS = ['text-emerald-400', 'text-amber-400', 'text-fuchsia-400', 'text-sky-400', 'text-rose-400', 'text-teal-400']

function chatColor(authorId: string): string {
  if (authorId === store.userId) return 'text-indigo-400'
  let hash = 0
  for (const ch of authorId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return CHAT_COLORS[hash % CHAT_COLORS.length]
}

function onSend(text: string, files: File[]): void {
  store.sendMessage(text, files)
}

function onSave(id: string, text: string): void {
  store.editMessage(id, text)
  editing.value = null
}

function confirmDelete(): void {
  if (deletingId.value) store.deleteMessage(deletingId.value)
  if (deletingId.value === editing.value?.id) editing.value = null
  deletingId.value = null
}

function onDrop(e: DragEvent): void {
  dragging.value = false
  composer.value?.addFiles(Array.from(e.dataTransfer?.files ?? []))
}

function onDragOver(e: DragEvent): void {
  if (e.dataTransfer?.types.includes('Files')) dragging.value = true
}

function fmtSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} ${time}`
}

const isImage = (f: CallFile): boolean => f.type.startsWith('image/')
const isVideo = (f: CallFile): boolean => f.type.startsWith('video/')
const inProgress = (f: CallFile): boolean => !f.failed && !f.stored && f.done > 0 && f.done < f.size

async function scrollChat(): Promise<void> {
  await nextTick()
  if (chatEl.value) chatEl.value.scrollTop = chatEl.value.scrollHeight
}
watch(() => store.messages.length, scrollChat)
watch(chatEl, scrollChat)

function confirmLeave(): void {
  showLeave.value = false
  editing.value = null
  store.leave()
}
</script>

<template>
  <!-- ============================== Fora de uma chamada ============================== -->
  <div v-if="!store.inCall" class="h-full overflow-y-auto">
    <div class="min-h-full flex flex-col items-center justify-center gap-8 py-6">
      <div class="w-full max-w-sm flex flex-col items-center gap-6">
        <div class="flex flex-col items-center gap-3 text-center">
          <div class="w-14 h-14 rounded-2xl bg-indigo-600/15 border border-indigo-500/30 flex items-center justify-center">
            <svg class="w-7 h-7 text-indigo-400" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z" />
            </svg>
          </div>
          <div>
            <h1 class="text-xl font-semibold text-slate-100">{{ mode === 'create' ? 'Criar uma sala' : 'Entrar em uma sala' }}</h1>
            <p class="text-sm text-slate-500 mt-1">Voz, tela e arquivos direto entre os participantes</p>
          </div>
        </div>

        <form class="w-full bg-slate-800/60 rounded-2xl border border-slate-700/40 p-5 flex flex-col gap-3" @submit.prevent="submit">
          <input
            v-model="store.name"
            maxlength="40"
            placeholder="Seu nome"
            :disabled="busy"
            class="bg-slate-900/40 border border-slate-700/60 rounded-lg px-3 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-indigo-500/60 disabled:opacity-60"
          />
          <input
            v-if="mode === 'create'"
            v-model="roomName"
            maxlength="80"
            placeholder="Nome da sala (opcional)"
            :disabled="busy"
            class="bg-slate-900/40 border border-slate-700/60 rounded-lg px-3 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-indigo-500/60 disabled:opacity-60"
          />
          <input
            v-else
            v-model="joinCode"
            placeholder="Código da sala"
            spellcheck="false"
            :disabled="busy"
            class="bg-slate-900/40 border border-slate-700/60 rounded-lg px-3 py-2.5 text-sm font-mono text-slate-100 placeholder-slate-600 placeholder:font-sans focus:outline-none focus:border-indigo-500/60 disabled:opacity-60"
          />
          <button
            type="submit"
            :disabled="busy || (mode === 'join' && !joinCode.trim())"
            class="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 transition-colors disabled:opacity-60"
          >
            <span v-if="busy" class="w-3.5 h-3.5 rounded-full border-2 border-white/40 border-t-white animate-spin" />
            {{ busy ? (mode === 'create' ? 'Abrindo…' : 'Entrando…') : mode === 'create' ? 'Criar sala' : 'Entrar' }}
          </button>
          <p v-if="store.error && !busy" class="text-xs text-red-400 text-center">{{ store.error }}</p>
          <div v-if="busy && store.waitingApproval" class="flex flex-col items-center gap-2 text-center">
            <p class="text-xs text-amber-300">Aguardando alguém da sala aceitar a sua entrada…</p>
            <button type="button" class="text-xs text-slate-400 hover:text-slate-200 underline underline-offset-2" @click="store.leave()">Cancelar</button>
          </div>
        </form>
        <button
          v-if="store.logs.length"
          class="-mt-3 text-xs text-slate-500 hover:text-slate-300 underline underline-offset-2"
          title="O log da última chamada fica disponível até você entrar em outra"
          @click="showLogs = true"
        >Ver logs da última chamada ({{ store.logs.length }} linhas)</button>

        <button
          :disabled="busy"
          class="text-sm text-slate-400 hover:text-indigo-400 transition-colors disabled:opacity-50"
          @click="mode = mode === 'create' ? 'join' : 'create'"
        >{{ mode === 'create' ? 'Tenho um código, quero entrar em uma sala' : 'Quero criar uma sala nova' }}</button>
      </div>

      <!-- salas anteriores: o histórico do chat fica guardado neste computador -->
      <div v-if="store.recentRooms.length" class="w-full max-w-md flex flex-col gap-2">
        <p class="text-xs text-slate-500 uppercase tracking-wide px-1">Salas anteriores</p>
        <div class="bg-slate-800/60 rounded-2xl border border-slate-700/40 divide-y divide-slate-700/40 max-h-72 overflow-y-auto">
          <div v-for="r in store.recentRooms" :key="r.id" class="group flex items-center gap-3 px-4 py-3">
            <div class="flex-1 min-w-0">
              <p class="text-sm text-slate-100 truncate flex items-center gap-2">
                <span class="truncate">{{ r.name }}</span>
                <span
                  v-if="store.roomsLive[r.id]"
                  class="flex-shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/15 text-[10px] font-medium text-emerald-300"
                  title="A sala está aberta agora"
                ><span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />ao vivo</span>
              </p>
              <p v-if="store.roomsLive[r.id]" class="text-xs text-emerald-300/90 truncate" :title="store.roomsLive[r.id]!.names.join(', ')">
                Na sala agora: {{ store.roomsLive[r.id]!.names.join(', ') || 'ninguém' }}
              </p>
              <p class="text-xs text-slate-500 truncate">
                {{ fmtDay(r.updatedAt) }} · {{ r.messageCount }} {{ r.messageCount === 1 ? 'mensagem' : 'mensagens' }}
                <template v-if="r.participants.length"> · {{ r.participants.join(', ') }}</template>
              </p>
            </div>
            <button
              :disabled="busy"
              class="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-100 bg-slate-700 hover:bg-indigo-600 transition-colors disabled:opacity-50"
              :title="store.roomsLive[r.id] ? 'Entra na sala que já está aberta (você já participou dela, então entra direto)' : 'Abre a sala de novo com o mesmo chat. Se alguém já estiver com ela aberta, você entra nela'"
              @click="reopen(r.id)"
            >{{ store.roomsLive[r.id] ? 'Entrar' : 'Reabrir' }}</button>
            <button
              :disabled="busy"
              class="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-slate-700/60 transition-colors opacity-0 group-hover:opacity-100 disabled:opacity-0"
              title="Excluir a sala e o histórico"
              @click="deletingRoom = { id: r.id, name: r.name }"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>

    <CallLogPanel v-if="showLogs" @close="showLogs = false" />
    <ConfirmModal :open="!!deletingRoom" title="Excluir a sala?" confirm-label="Excluir" @confirm="confirmDeleteRoom" @cancel="deletingRoom = null">
      O histórico do chat e os arquivos de "{{ deletingRoom?.name }}" serão apagados deste computador. Quem participou continua com a cópia
      dele.
    </ConfirmModal>
  </div>

  <!-- ============================== Em chamada ============================== -->
  <div v-else class="flex flex-col h-full gap-4">
    <div class="flex items-center gap-3 flex-shrink-0">
      <h1 class="text-xl font-semibold text-slate-100 truncate max-w-[16rem]" :title="store.room?.name">{{ store.room?.name || 'Chamada' }}</h1>
      <div class="flex items-center gap-1.5 pl-3 pr-1.5 py-1 rounded-lg bg-slate-800/60 border border-slate-700/40 min-w-0">
        <template v-if="store.codeReady">
          <span class="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0" />
          <span class="text-xs font-mono text-slate-300 truncate" title="Código da sala: envie para quem vai participar">{{ store.code }}</span>
          <CopyButton :text="store.code" size="sm" />
        </template>
        <template v-else>
          <span class="w-3 h-3 rounded-full border-2 border-slate-600 border-t-indigo-400 animate-spin flex-shrink-0" />
          <span class="text-xs text-slate-400 pr-2 py-1" title="O código aparece em alguns segundos, quando já funcionar para os convidados">Liberando o código…</span>
        </template>
      </div>
      <div class="flex-1" />
      <button
        :disabled="!store.hasMic"
        :class="[
          'flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium border transition-colors disabled:opacity-50',
          store.muted ? 'bg-red-600 border-red-500 hover:bg-red-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-100 hover:bg-slate-700'
        ]"
        @click="store.toggleMute()"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
          <path v-if="store.muted" stroke-linecap="round" d="M4 4l16 16" />
        </svg>
        {{ !store.hasMic ? 'Sem microfone' : store.muted ? 'Mudo' : 'Microfone' }}
      </button>
<button
        class="relative flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border bg-slate-800 border-slate-700 text-slate-100 hover:bg-slate-700 transition-colors"
        title="Logs da sala (seus e dos outros participantes), para copiar e depurar"
        @click="showLogs = true"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25H12" />
        </svg>
        Logs
        <span v-if="logProblems" class="min-w-[1.1rem] px-1 rounded-full bg-amber-500 text-[10px] leading-4 text-slate-900 font-semibold">{{ logProblems }}</span>
      </button>
      <CallAudioPopover />
      <button class="px-3.5 py-2 rounded-lg text-xs font-medium text-white bg-red-600 hover:bg-red-500 transition-colors" @click="showLeave = true">Sair</button>
    </div>

    <div
      v-for="k in store.knocks"
      :key="k.id"
      class="flex-shrink-0 flex items-center gap-3 text-sm text-slate-100 bg-indigo-500/10 border border-indigo-500/40 rounded-lg px-3 py-2"
    >
      <span class="w-2 h-2 rounded-full bg-indigo-400 animate-pulse flex-shrink-0" />
      <span class="flex-1 min-w-0 truncate"><strong>{{ k.name }}</strong> quer entrar na sala</span>
      <button class="px-3 py-1 rounded-lg text-xs text-slate-200 bg-slate-700 hover:bg-red-600 transition-colors" @click="store.answerKnock(k.id, false)">Recusar</button>
      <button class="px-3 py-1 rounded-lg text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 transition-colors" @click="store.answerKnock(k.id, true)">Aceitar</button>
    </div>
    <p v-if="store.closedToNewcomers" class="flex-shrink-0 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
      O servidor da sala caiu (quem hospedava saiu ou a conexão caiu). A chamada continua entre quem já está aqui; reabrindo a sala automaticamente para quem for entrar…
    </p>
    <p v-if="store.error" class="flex-shrink-0 text-xs text-red-400">{{ store.error }}</p>

    <div class="flex flex-1 gap-4 min-h-0">
      <!-- Esquerda: chat da sala (a transmissão aberta se expande por cima dele) -->
      <div
        class="relative flex-1 min-w-0 flex flex-col bg-slate-800/60 rounded-2xl border border-slate-700/40 overflow-hidden"
        @dragover.prevent="onDragOver"
        @dragleave.self="dragging = false"
        @drop.prevent="onDrop"
      >
        <div ref="chatEl" class="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4 min-h-0">
          <p v-if="!store.messages.length" class="text-sm text-slate-600 text-center m-auto">
            Sem mensagens ainda. Escreva abaixo, cole um print ou arraste arquivos para cá.
          </p>
          <div v-for="msg in store.messages" :key="msg.id" class="group/msg flex flex-col gap-1">
            <div class="flex items-center gap-2 min-h-[1.5rem]">
              <span :class="['text-sm font-medium', chatColor(msg.authorId)]">{{ msg.authorName }}</span>
              <span class="text-[11px] text-slate-600">{{ fmtTime(msg.timestamp) }}<template v-if="msg.editedAt"> · editada</template></span>
              <span v-if="msg.authorId === store.userId" class="flex gap-0.5 opacity-0 group-hover/msg:opacity-100 transition-opacity">
                <button
                  v-if="msg.text"
                  class="p-1 rounded text-slate-500 hover:text-slate-200 transition-colors"
                  title="Editar"
                  @click="editing = { id: msg.id, text: msg.text }"
                >
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487zm0 0L19.5 7.125" />
                  </svg>
                </button>
                <button class="p-1 rounded text-slate-500 hover:text-red-400 transition-colors" title="Excluir para todos" @click="deletingId = msg.id">
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                  </svg>
                </button>
              </span>
            </div>
            <p v-if="msg.text" class="text-sm text-slate-200 leading-relaxed whitespace-pre-wrap break-words select-text">{{ msg.text }}</p>

            <div v-if="msg.files.length" class="flex flex-wrap gap-2 mt-0.5">
              <template v-for="f in msg.files" :key="f.id">
                <!-- imagem / vídeo com prévia: clica para ampliar -->
                <button
                  v-if="f.url && (isImage(f) || isVideo(f))"
                  class="relative rounded-xl overflow-hidden border border-slate-700/60 bg-slate-950 max-w-xs hover:border-indigo-500/60 transition-colors"
                  :title="`${f.name} - clique para ampliar`"
                  @click="viewer = f"
                >
                  <img v-if="isImage(f)" :src="f.url" class="max-h-64 max-w-xs object-contain" />
                  <template v-else>
                    <video :src="f.url" muted class="max-h-64 max-w-xs object-contain" />
                    <span class="absolute inset-0 flex items-center justify-center">
                      <span class="w-11 h-11 rounded-full bg-black/60 flex items-center justify-center">
                        <svg class="w-5 h-5 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5.14v14l11-7-11-7z" /></svg>
                      </span>
                    </span>
                  </template>
                </button>

                <!-- outros arquivos (ou ainda chegando) -->
                <div v-else class="w-72 flex flex-col gap-1.5 rounded-xl border border-slate-700/60 bg-slate-900/40 p-2.5">
                  <div class="flex items-center gap-2.5 min-w-0">
                    <svg class="w-8 h-8 text-slate-500 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="1.2" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                    </svg>
                    <div class="flex-1 min-w-0">
                      <p class="text-xs text-slate-200 truncate" :title="f.name">{{ f.name }}</p>
                      <p :class="['text-[11px]', f.failed ? 'text-red-400' : 'text-slate-500']">
                        <template v-if="f.failed">Falhou</template>
                        <template v-else-if="inProgress(f)">{{ Math.floor((f.done / f.size) * 100) }}% de {{ fmtSize(f.size) }}</template>
                        <template v-else-if="f.requested">Pedindo a quem tem o arquivo…</template>
                        <template v-else-if="!f.stored">{{ fmtSize(f.size) }} · não está neste computador</template>
                        <template v-else>{{ fmtSize(f.size) }}</template>
                      </p>
                    </div>
                    <button
                      v-if="f.stored"
                      class="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 transition-colors flex-shrink-0"
                      title="Baixar"
                      @click="store.downloadFile(f)"
                    >
                      <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.7" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                      </svg>
                    </button>
                    <button
                      v-else-if="!inProgress(f) && !f.requested && msg.authorId !== store.userId"
                      class="px-2 py-1 rounded-md text-[11px] font-medium text-slate-100 bg-slate-700 hover:bg-indigo-600 transition-colors flex-shrink-0"
                      title="Pede o arquivo a quem está na sala e tem uma cópia"
                      @click="store.requestFile(f)"
                    >Pedir</button>
                  </div>
                  <div v-if="inProgress(f)" class="h-1 rounded-full bg-slate-700 overflow-hidden">
                    <div class="h-full bg-indigo-500 transition-[width]" :style="{ width: `${(f.done / f.size) * 100}%` }" />
                  </div>
                </div>
              </template>
            </div>
          </div>
        </div>

        <div class="flex-shrink-0 p-3 pt-0">
          <CallComposer ref="composer" :editing="editing" @send="onSend" @save="onSave" @cancel="editing = null" />
        </div>

        <div
          v-if="dragging"
          class="absolute inset-2 z-20 rounded-xl border-2 border-dashed border-indigo-500/70 bg-slate-900/80 flex items-center justify-center pointer-events-none"
        >
          <p class="text-sm text-indigo-300">Solte para anexar</p>
        </div>

        <!-- Transmissão aberta: grande por cima do chat ou minimizada no canto -->
        <div
          v-show="store.watching"
          ref="stage"
          :class="[
            'group absolute z-10 bg-slate-950 flex items-center justify-center overflow-hidden',
            expanded || fullscreen ? 'inset-0' : 'right-4 bottom-24 w-80 aspect-video rounded-xl border border-slate-600 shadow-2xl cursor-pointer'
          ]"
          @wheel="onWheel"
          @contextmenu.prevent="openMenu($event, 'screen')"
          @mousedown="onPanStart"
          @dblclick="expanded ? resetZoom() : undefined"
          @click="mini ? store.setViewMode('expanded') : undefined"
        >
          <video ref="screenVideo" autoplay muted playsinline :style="expanded ? videoStyle : undefined" class="w-full h-full object-contain select-none" />

          <!-- topo: nome + minimizar, tela cheia, fechar -->
          <div class="absolute top-0 inset-x-0 flex items-center gap-2 p-2 bg-gradient-to-b from-black/70 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
            <span class="flex items-center gap-1.5 px-1.5 text-xs text-white truncate">
              <span class="w-1.5 h-1.5 rounded-full bg-red-500 flex-shrink-0" />
              {{ watchingLabel }}
            </span>
            <span v-if="expanded && scale !== 1" class="px-1.5 py-0.5 rounded bg-black/50 text-[11px] text-white font-mono">{{ scale.toFixed(1) }}×</span>
            <div class="flex-1" />
            <button
              v-if="expanded && !fullscreen"
              class="p-1.5 rounded-md text-white/90 hover:text-white hover:bg-white/15 transition-colors"
              title="Minimizar"
              @click.stop="minimize"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 12h-15" />
              </svg>
            </button>
            <button
              v-else-if="mini"
              class="p-1.5 rounded-md text-white/90 hover:text-white hover:bg-white/15 transition-colors"
              title="Ampliar"
              @click.stop="store.setViewMode('expanded')"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
              </svg>
            </button>
            <button
              class="p-1.5 rounded-md text-white/90 hover:text-white hover:bg-white/15 transition-colors"
              :title="fullscreen ? 'Sair da tela cheia' : 'Tela cheia'"
              @click.stop="toggleFullscreen"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path
                  v-if="!fullscreen"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15"
                />
                <path
                  v-else
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25"
                />
              </svg>
            </button>
            <button
              class="p-1.5 rounded-md text-white/90 hover:text-white hover:bg-red-600/80 transition-colors"
              title="Fechar (para de assistir)"
              @click.stop="closeView"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <!-- base: volume do som da transmissão + 1:1 -->
          <div
            v-if="expanded || fullscreen"
            class="absolute bottom-3 left-3 right-3 flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity"
            @mousedown.stop
            @dblclick.stop
          >
            <div v-if="store.watching !== SELF" class="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-black/60" title="Volume do som da transmissão">
              <button class="text-white" :title="store.screenMuted ? 'Ativar o som da transmissão' : 'Mutar o som da transmissão'" @click.stop="store.toggleScreenMute()">
                <svg v-if="store.screenMuted" class="w-4 h-4 text-red-400" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M17.25 9.75L19.5 12m0 0l2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-10.5-6l4.72-4.72a.75.75 0 011.28.531V19.94a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.506-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.395C2.806 8.757 3.63 8.25 4.51 8.25H6.75z" />
                </svg>
                <svg v-else class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
                </svg>
              </button>
              <input
                type="range"
                min="0"
                max="1"
                step="0.005"
                :value="volumeToSlider(store.screenVolume)"
                :class="['w-28 h-1 accent-indigo-500 cursor-pointer', store.screenMuted ? 'opacity-40' : '']"
                @input="store.setScreenVolume(sliderToVolume(parseFloat(($event.target as HTMLInputElement).value)))"
              />
              <span class="text-xs text-white w-11 text-right">{{ formatVolume(store.screenVolume) }}</span>
            </div>
            <div class="flex-1" />
            <button
              v-if="scale !== 1"
              class="px-2.5 py-1.5 rounded-lg bg-black/60 hover:bg-black/80 text-white text-xs"
              title="Voltar ao tamanho normal (duplo clique)"
              @click.stop="resetZoom"
            >1:1</button>
          </div>
        </div>
      </div>

      <!-- Direita: participantes + transmissões -->
      <aside class="w-72 flex-shrink-0 flex flex-col gap-4 min-h-0">
        <div class="bg-slate-800/60 rounded-2xl border border-slate-700/40 flex flex-col max-h-[45%] min-h-0">
          <p class="px-4 py-2.5 border-b border-slate-700/40 text-xs text-slate-500 uppercase tracking-wide flex-shrink-0">
            Participantes ({{ store.peers.length + 1 }})
          </p>
          <ul class="overflow-y-auto p-2 flex flex-col gap-0.5">
            <li class="flex items-center gap-2.5 px-2 py-1.5 rounded-lg">
              <div class="flex items-end gap-[2px] h-3.5 w-4 flex-shrink-0">
                <span
                  v-for="(lvl, i) in micBars"
                  :key="i"
                  :class="['flex-1 rounded-full', store.muted || !store.hasMic ? 'bg-slate-600' : 'bg-emerald-500']"
                  :style="{ height: `${lvl * 100}%` }"
                />
              </div>
              <span class="text-sm text-slate-100 truncate flex-1">{{ store.name || 'Você' }} <span class="text-slate-500">(você)</span></span>
              <span v-if="!store.hasMic" class="text-[11px] text-amber-400 flex-shrink-0">sem microfone</span>
              <span v-else-if="store.muted" class="text-[11px] text-red-400 flex-shrink-0">mudo</span>
            </li>

            <li
              v-for="peer in store.peers"
              :key="peer.id"
              class="flex flex-col rounded-lg hover:bg-slate-700/30 transition-colors"
              title="Botão direito: volume e mudo"
              @contextmenu.prevent="openMenu($event, peer.id)"
            >
              <div class="flex items-center gap-2.5 px-2 py-1.5">
                <div class="flex items-end gap-[2px] h-3.5 w-4 flex-shrink-0">
                  <span
                    v-for="(lvl, i) in peerBars[peer.id] ?? IDLE_BARS"
                    :key="i"
                    :class="['flex-1 rounded-full', peer.muted || store.mutedPeers.has(peer.id) ? 'bg-slate-600' : 'bg-emerald-500']"
                    :style="{ height: `${lvl * 100}%` }"
                  />
                </div>
                <span class="text-sm text-slate-300 truncate flex-1">{{ peer.name }}</span>
                <span v-if="peer.muted" class="text-[11px] text-red-400 flex-shrink-0">mudo</span>
                <button
                  :class="['px-1.5 py-0.5 rounded text-[11px] transition-colors flex-shrink-0', store.mutedPeers.has(peer.id) ? 'text-red-400 hover:text-red-300' : 'text-slate-500 hover:text-slate-300']"
                  :title="store.mutedPeers.has(peer.id) ? 'Voltar a ouvir' : 'Silenciar para mim'"
                  @click="store.togglePeerMute(peer.id)"
                >{{ store.mutedPeers.has(peer.id) ? 'silenciado' : 'silenciar' }}</button>
              </div>
              <div class="flex items-center gap-2 pl-9 pr-2 pb-1.5" title="Volume da voz deste participante para você">
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.005"
                  :value="volumeToSlider(store.peerVolumes[peer.id] ?? 1)"
                  class="flex-1 h-1 accent-indigo-500 cursor-pointer"
                  @input="onVolume(peer.id, $event)"
                />
                <span class="text-xs text-slate-500 w-11 text-right">{{ formatVolume(store.peerVolumes[peer.id] ?? 1) }}</span>
              </div>
            </li>
          </ul>
        </div>

        <div class="bg-slate-800/60 rounded-2xl border border-slate-700/40 flex-1 flex flex-col min-h-0">
          <p class="px-4 py-2.5 border-b border-slate-700/40 text-xs text-slate-500 uppercase tracking-wide flex-shrink-0">
            Transmissões ({{ shares.length }})
          </p>
          <div class="flex-1 overflow-y-auto p-2 flex flex-col gap-2 min-h-0">
            <p v-if="!shares.length" class="text-xs text-slate-600 text-center m-auto px-4">Ninguém está transmitindo a tela</p>
            <button
              v-for="s in shares"
              :key="s.id"
              :class="[
                'group/card flex flex-col gap-1.5 p-1.5 rounded-xl border text-left transition-colors flex-shrink-0',
                store.watching === s.id ? 'border-indigo-500 bg-indigo-500/10' : 'border-slate-700/60 bg-slate-900/40 hover:border-slate-500'
              ]"
              :title="store.watching === s.id ? 'Você está assistindo' : 'Assistir esta transmissão'"
              @click="openShare(s.id)"
            >
              <div class="relative w-full aspect-video rounded-lg bg-slate-950 overflow-hidden">
                <img v-if="store.thumbs[s.id]" :src="store.thumbs[s.id]" class="w-full h-full object-cover" />
                <svg v-else class="absolute inset-0 m-auto w-8 h-8 text-slate-700" fill="none" stroke="currentColor" stroke-width="1.3" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 12V5.25" />
                </svg>
                <span
                  v-if="store.watching !== s.id"
                  class="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover/card:opacity-100 transition-opacity"
                >
                  <span class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 text-xs font-medium text-white">
                    <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5.14v14l11-7-11-7z" /></svg>
                    Assistir
                  </span>
                </span>
                <span v-else class="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-indigo-600 text-[10px] font-medium text-white">Assistindo</span>
              </div>
              <span class="flex items-center gap-1.5 px-1 text-xs text-slate-300 min-w-0">
                <span class="w-1.5 h-1.5 rounded-full bg-red-500 flex-shrink-0" />
                <span class="truncate">{{ s.label }}</span>
              </span>
            </button>
          </div>
          <div class="p-2 border-t border-slate-700/40 flex-shrink-0">
            <button
              v-if="!store.sharing"
              class="w-full px-3 py-2.5 rounded-lg text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 transition-colors"
              @click="showShare = true"
            >Iniciar transmissão</button>
            <button
              v-else
              class="w-full px-3 py-2.5 rounded-lg text-sm font-medium text-white bg-red-600 hover:bg-red-500 transition-colors"
              @click="store.stopShare()"
            >Parar minha transmissão</button>
          </div>
        </div>
      </aside>
    </div>

 <CallLogPanel v-if="showLogs" @close="showLogs = false" />
    <CallShareModal v-if="showShare" @close="showShare = false" @start="onShareStart" />
    <CallVolumeMenu
      v-if="menu && (menu.target === 'screen' ? store.watching && store.watching !== SELF : menuPeer)"
      :x="menu.x"
      :y="menu.y"
      :title="menu.target === 'screen' ? `Som da transmissão de ${watchingLabel}` : `Voz de ${menuPeer?.name}`"
      :volume="menu.target === 'screen' ? store.screenVolume : (store.peerVolumes[menu.target] ?? 1)"
      :muted="menu.target === 'screen' ? store.screenMuted : store.mutedPeers.has(menu.target)"
      :mute-label="menu.target === 'screen' ? 'Mutar a transmissão' : 'Mutar para mim'"
      @volume="onMenuVolume"
      @mute="onMenuMute"
      @close="menu = null"
    />
    <CallMediaViewer
      v-if="viewer?.url"
      :url="viewer.url"
      :name="viewer.name"
      :video="isVideo(viewer)"
      @close="viewer = null"
      @download="viewer && store.downloadFile(viewer)"
    />
    <ConfirmModal :open="showLeave" title="Sair da chamada?" confirm-label="Sair" @confirm="confirmLeave" @cancel="showLeave = false">
      {{
        store.isHost
          ? 'Você está hospedando a sala: ao sair, quem ficar reabre o servidor automaticamente (com um código novo). O chat fica guardado em "Salas anteriores".'
          : 'Sua conexão com os outros participantes será encerrada. O chat fica guardado em "Salas anteriores".'
      }}
    </ConfirmModal>
    <ConfirmModal :open="!!deletingId" title="Excluir a mensagem?" confirm-label="Excluir" @confirm="confirmDelete" @cancel="deletingId = null">
      Ela será removida para todos os participantes.
    </ConfirmModal>
  </div>
</template>
