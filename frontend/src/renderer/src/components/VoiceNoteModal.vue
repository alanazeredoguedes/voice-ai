<script setup lang="ts">
/**
 * Descrição por voz: abre já gravando. A pessoa fala, clica no ícone para parar, o texto aparece para conferir
 * (dá para editar, gravar de novo ou preferir digitar) e um botão grande executa a ação.
 * O áudio vai para o Whisper do app (/transcribe/voice-note); não fica salvo em lugar nenhum.
 *
 * Duas formas de usar:
 * - sem `run`: ao confirmar, emite `submit` com o texto e quem abriu decide o resto (ex.: refinar imagens);
 * - com `run`: o modal executa a ação (ex.: gerar o system prompt), mostra "aguarde" com opção de cancelar
 *   e emite `done` quando termina. Cancelar aborta a requisição (o backend encerra a chamada ao Claude).
 */
import { nextTick, onMounted, onUnmounted, ref, computed } from 'vue'
import { transcribeVoiceNote } from '../api'

const props = defineProps<{
  /** pergunta que aparece enquanto grava */
  title: string
  /** título do campo de texto depois de gravar */
  textLabel: string
  placeholder: string
  /** texto do botão grande */
  actionLabel: string
  /** texto enquanto `run` executa */
  busyLabel?: string
  run?: (text: string, signal: AbortSignal) => Promise<void>
}>()
const emit = defineEmits<{ submit: [text: string]; done: []; close: [] }>()

type Step = 'recording' | 'transcribing' | 'text' | 'running'
const MAX_SECONDS = 90 // a gravação para sozinha depois disso (o usuário também pode parar antes)

const step = ref<Step>('recording')
const text = ref('')
const error = ref('')
const seconds = ref(0)
const textEl = ref<HTMLTextAreaElement | null>(null)
const clock = computed(() => `${Math.floor(seconds.value / 60)}:${String(seconds.value % 60).padStart(2, '0')}`)
const secondsLeft = computed(() => MAX_SECONDS - seconds.value)
const pulsing = ref(false)

/** clicar fora só fecha se não há nada em andamento (gravando, transcrevendo, executando ou com texto); senão pisca */
function onBackdrop(): void {
  if (step.value === 'text' && !text.value.trim()) {
    cancel()
    return
  }
  pulsing.value = false
  void nextTick(() => {
    pulsing.value = true
  })
  setTimeout(() => (pulsing.value = false), 800)
}

let stream: MediaStream | null = null
let rec: MediaRecorder | null = null
let chunks: Blob[] = []
let timer: ReturnType<typeof setInterval> | null = null
let discarded = false
let ctrl: AbortController | null = null

const focusText = async (): Promise<void> => {
  await nextTick()
  textEl.value?.focus()
}

function release(): void {
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
}

function stopClock(): void {
  if (timer) clearInterval(timer)
  timer = null
}

async function start(): Promise<void> {
  error.value = ''
  discarded = false
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch {
    error.value = 'Não consegui usar o microfone. Digite o que você precisa.'
    step.value = 'text'
    await focusText()
    return
  }
  chunks = []
  rec = new MediaRecorder(stream)
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data)
  }
  rec.onstop = () => void onStopped()
  rec.start()
  seconds.value = 0
  stopClock()
  timer = setInterval(() => {
    seconds.value++
    if (seconds.value >= MAX_SECONDS) stopRecording()
  }, 1000)
  step.value = 'recording'
}

function stopRecording(): void {
  stopClock()
  if (rec && rec.state === 'recording') rec.stop()
}

async function onStopped(): Promise<void> {
  release()
  if (discarded) return
  const blob = new Blob(chunks, { type: rec?.mimeType || 'audio/webm' })
  if (blob.size < 1500) {
    error.value = 'Não ouvi nada. Grave de novo ou digite.'
    step.value = 'text'
    await focusText()
    return
  }
  step.value = 'transcribing'
  try {
    text.value = await transcribeVoiceNote(blob)
    if (!text.value) error.value = 'Não entendi o que foi dito. Grave de novo ou digite.'
  } catch {
    error.value = 'Não consegui transcrever agora. Digite o que você precisa.'
  }
  step.value = 'text'
  await focusText()
}

/** "Prefiro digitar": descarta a gravação em andamento */
async function typeInstead(): Promise<void> {
  discarded = true
  stopRecording()
  release()
  step.value = 'text'
  await focusText()
}

function again(): void {
  text.value = ''
  void start()
}

async function submit(): Promise<void> {
  const t = text.value.trim()
  if (!t || step.value === 'running') return
  if (!props.run) {
    emit('submit', t)
    return
  }
  error.value = ''
  ctrl = new AbortController()
  const mine = ctrl
  step.value = 'running'
  try {
    await props.run(t, mine.signal)
    if (!mine.signal.aborted) emit('done')
  } catch (e) {
    if (mine.signal.aborted) {
      step.value = 'text'
      await focusText()
      return
    }
    error.value = e instanceof Error && e.message ? e.message : 'Não consegui agora. Tente de novo.'
    step.value = 'text'
    await focusText()
  } finally {
    if (ctrl === mine) ctrl = null
  }
}

/** cancela só a ação em andamento (volta para o texto) */
function cancelRun(): void {
  ctrl?.abort()
}

function cancel(): void {
  discarded = true
  ctrl?.abort()
  stopRecording()
  release()
  emit('close')
}

function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  e.stopPropagation()
  if (step.value === 'running') cancelRun()
  else cancel()
}

onMounted(() => {
  window.addEventListener('keydown', onKey, true)
  void start()
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKey, true)
  discarded = true
  ctrl?.abort()
  stopClock()
  try {
    if (rec && rec.state === 'recording') rec.stop()
  } catch {
    // já parou
  }
  release()
})
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm" @mousedown.self="onBackdrop">
      <div
        :class="[
          'max-w-[94vw] max-h-[90vh] overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl shadow-black/60 px-6 py-6 flex flex-col items-center gap-4 transition-[width] duration-200',
          step === 'text' ? 'w-[700px]' : 'w-[440px]',
          pulsing ? 'modal-pulse' : ''
        ]"
      >
        <!-- gravando -->
        <template v-if="step === 'recording'">
          <p class="text-sm font-medium text-slate-100 text-center">{{ title }}</p>
          <button
            type="button"
            title="Parar de gravar"
            class="relative flex items-center justify-center w-20 h-20 rounded-full bg-red-600 hover:bg-red-500 transition-colors shadow-lg shadow-red-900/40"
            @click="stopRecording"
          >
            <span class="absolute inset-0 rounded-full bg-red-500/50 animate-ping" />
            <svg class="relative w-8 h-8 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 14a3 3 0 003-3V5a3 3 0 10-6 0v6a3 3 0 003 3z" />
              <path d="M19 11a1 1 0 10-2 0 5 5 0 01-10 0 1 1 0 10-2 0 7 7 0 006 6.92V21H9a1 1 0 100 2h6a1 1 0 100-2h-2v-3.08A7 7 0 0019 11z" />
            </svg>
          </button>
          <p class="text-xs tabular-nums text-red-300">Gravando {{ clock }}</p>
          <p v-if="secondsLeft > 15" class="text-[11px] text-slate-500 text-center">Clique no ícone para parar de gravar, a qualquer momento.</p>
          <p v-else class="text-[11px] text-amber-300 text-center">A gravação para sozinha em {{ secondsLeft }} s. Clique no ícone para parar agora.</p>
          <div class="flex items-center gap-4 text-xs">
            <button class="text-slate-400 hover:text-slate-200 underline underline-offset-2" @click="typeInstead">Prefiro digitar</button>
            <button class="text-slate-500 hover:text-slate-300" @click="cancel">Cancelar</button>
          </div>
        </template>

        <!-- transcrevendo -->
        <template v-else-if="step === 'transcribing'">
          <span class="w-8 h-8 rounded-full border-[3px] border-indigo-300/25 border-t-indigo-300 animate-spin" />
          <p class="text-sm text-slate-300">Transcrevendo o que você falou…</p>
        </template>

        <!-- executando a ação (ex.: criando o system prompt) -->
        <template v-else-if="step === 'running'">
          <span class="w-8 h-8 rounded-full border-[3px] border-indigo-300/25 border-t-indigo-300 animate-spin" />
          <p class="text-sm text-slate-300">{{ busyLabel || 'Trabalhando…' }}</p>
          <button class="text-xs text-slate-500 hover:text-amber-200 transition-colors" @click="cancelRun">Cancelar</button>
        </template>

        <!-- texto para conferir -->
        <template v-else>
          <p class="text-sm font-medium text-slate-100 self-start">{{ textLabel }}</p>
          <textarea
            ref="textEl"
            v-model="text"
            rows="10"
            maxlength="2000"
            :placeholder="placeholder"
            class="w-full min-h-[10rem] max-h-[50vh] resize-y rounded-lg bg-slate-950 border border-slate-700 focus:border-indigo-500 outline-none px-3 py-2 text-sm leading-relaxed text-slate-200 placeholder-slate-600"
            @keydown.enter.exact.prevent="submit"
          />
          <p v-if="error" class="self-start text-xs text-amber-400/90">{{ error }}</p>
          <button
            :disabled="!text.trim()"
            class="w-full rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:hover:bg-indigo-600 text-white text-sm font-medium py-2.5 transition-colors"
            @click="submit"
          >{{ actionLabel }}</button>
          <div class="flex items-center gap-4 text-xs">
            <button class="flex items-center gap-1.5 text-slate-400 hover:text-slate-200" @click="again">
              <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 14a3 3 0 003-3V5a3 3 0 10-6 0v6a3 3 0 003 3z" />
                <path d="M19 11a1 1 0 10-2 0 5 5 0 01-10 0 1 1 0 10-2 0 7 7 0 006 6.92V21H9a1 1 0 100 2h6a1 1 0 100-2h-2v-3.08A7 7 0 0019 11z" />
              </svg>
              Gravar de novo
            </button>
            <button class="text-slate-500 hover:text-slate-300" @click="cancel">Cancelar</button>
          </div>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* modal "travado": pisca e dá um leve zoom para mostrar que tem coisa preenchida e que não fecha clicando fora */
.modal-pulse {
  animation: modal-pulse 0.7s ease-out;
}
@keyframes modal-pulse {
  0% { transform: scale(1); box-shadow: 0 0 0 0 rgb(129 140 248 / 0.7); border-color: rgb(129 140 248); }
  35% { transform: scale(1.03); box-shadow: 0 0 0 8px rgb(129 140 248 / 0.35); border-color: rgb(129 140 248); }
  100% { transform: scale(1); box-shadow: 0 0 0 0 rgb(129 140 248 / 0); }
}
</style>
