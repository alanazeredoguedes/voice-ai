<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, nextTick } from 'vue'

const props = withDefaults(defineProps<{ mode?: 'install' | 'update' }>(), { mode: 'install' })
const emit = defineEmits<{ done: [] }>()
const isUpdate = props.mode === 'update'

type Status = 'pending' | 'running' | 'done' | 'skipped' | 'error'
interface Item { key: string; label: string; notable: boolean; size: string; status: Status }
interface Task { id: string; label: string; status: Status; detail: string; items: Item[] }

const installing = ref(false)
const hasStarted = ref(false)
const done = ref(false)
const error = ref('')
const currentMessage = ref('')
const percent = ref(0)
const logs = ref<string[]>([])
const logContainer = ref<HTMLElement | null>(null)
const showLogs = ref(false)
const copied = ref(false)

// GPU NVIDIA: a pessoa escolhe se quer baixar a aceleração (~2 GB)
const gpu = ref(false)
const systemCuda = ref(false)
const useGpu = ref(true)

function makeTasks(): Task[] {
  const t = (id: string, label: string): Task => ({ id, label, status: 'pending', detail: '', items: [] })
  if (isUpdate) {
    return [t('deps', 'Componentes novos desta versão'), t('claude', 'Claude Code (assistente do Chat IA)')]
  }
  return [
    t('python', 'Python'),
    t('deps', 'Voz, transcrição e tradução (inclui FFmpeg)'),
    t('cuda', 'Aceleração da placa NVIDIA (CUDA)'),
    t('model', 'Modelo de transcrição Whisper tiny'),
    t('claude', 'Claude Code (assistente do Chat IA)')
  ]
}
const tasks = ref<Task[]>(makeTasks())

function scrollLogs(): void {
  nextTick(() => {
    if (logContainer.value) logContainer.value.scrollTop = logContainer.value.scrollHeight
  })
}

function addLog(line: string): void {
  if (!line) return
  for (const l of line.split('\n')) {
    const trimmed = l.trim()
    if (trimmed) {
      logs.value.push(trimmed)
      if (logs.value.length > 500) logs.value.shift()
    }
  }
  if (showLogs.value) scrollLogs()
}

interface Progress {
  step: string
  message: string
  percent: number
  log?: string
  task?: string
  status?: Status
  detail?: string
  item?: string
  label?: string
  notable?: boolean
  size?: string
}

function onProgressEvent(p: Progress): void {
  if (p.log) addLog(p.log)
  if (p.percent >= 0) percent.value = p.percent
  if (p.message) currentMessage.value = p.message
  const task = p.task ? tasks.value.find((t) => t.id === p.task) : undefined
  if (!task) return
  if (p.step === 'task' && p.status) {
    task.status = p.status
    if (p.detail !== undefined) task.detail = p.detail
  } else if (p.step === 'item' && p.item && p.status) {
    const it = task.items.find((i) => i.key === p.item)
    if (it) {
      it.status = p.status
      if (p.size) it.size = p.size
    } else {
      task.items.push({ key: p.item, label: p.label ?? p.item, notable: !!p.notable, size: p.size ?? '', status: p.status })
    }
  }
}

// Conta Claude (Chat IA): o login é feito pelo fluxo oficial da Anthropic, numa janela de terminal
type ClaudeStatus = { installed: boolean; loggedIn: boolean }
const claude = ref<ClaudeStatus | null>(null)
const claudeWaiting = ref(false)
let claudePoll: ReturnType<typeof setInterval> | null = null

async function refreshClaude(): Promise<void> {
  try {
    claude.value = (await window.electron.ipcRenderer.invoke('claude:status')) as ClaudeStatus
  } catch {
    claude.value = { installed: false, loggedIn: false }
  }
}

async function loginClaude(): Promise<void> {
  const r = (await window.electron.ipcRenderer.invoke('claude:login')) as { started: boolean }
  if (!r.started) return
  claudeWaiting.value = true
  const t0 = Date.now()
  if (claudePoll) clearInterval(claudePoll)
  claudePoll = setInterval(async () => {
    await refreshClaude()
    if (claude.value?.loggedIn || Date.now() - t0 > 5 * 60_000) {
      claudeWaiting.value = false
      if (claudePoll) clearInterval(claudePoll)
      claudePoll = null
    }
  }, 3000)
}

onMounted(async () => {
  window.electron.ipcRenderer.on('setup:progress', (_, p: Progress) => onProgressEvent(p))

  window.electron.ipcRenderer.on('setup:done', (_, result: { success: boolean; error?: string }) => {
    installing.value = false
    if (result.success) {
      percent.value = 100
      currentMessage.value = 'Tudo pronto!'
      done.value = true
      refreshClaude()
    } else {
      error.value = result.error ?? 'Erro desconhecido'
      showLogs.value = true // em caso de erro, já mostra os detalhes
      scrollLogs()
    }
  })

  try {
    const info = (await window.electron.ipcRenderer.invoke('setup:check')) as { gpu?: boolean; systemCuda?: boolean }
    gpu.value = !!info.gpu
    systemCuda.value = !!info.systemCuda
  } catch {
    // sem info de GPU: segue com o padrão
  }

  // Atualização de versão: começa sozinho, sem pedir clique
  if (isUpdate) install()
})

onUnmounted(() => {
  if (claudePoll) clearInterval(claudePoll)
})

async function install(): Promise<void> {
  installing.value = true
  hasStarted.value = true
  error.value = ''
  logs.value = []
  tasks.value = makeTasks()
  currentMessage.value = 'Iniciando...'
  percent.value = 0
  await window.electron.ipcRenderer.invoke('setup:start', { useGpu: useGpu.value })
}

function startApp(): void {
  emit('done')
}

function toggleLogs(): void {
  showLogs.value = !showLogs.value
  if (showLogs.value) scrollLogs()
}

async function copyLogs(): Promise<void> {
  await navigator.clipboard.writeText(logs.value.join('\n'))
  copied.value = true
  setTimeout(() => (copied.value = false), 2000)
}

const notableItems = (t: Task): Item[] => t.items.filter((i) => i.notable)
const otherCount = (t: Task): { done: number; total: number } => {
  const others = t.items.filter((i) => !i.notable)
  return { done: others.filter((i) => i.status === 'done').length, total: others.length }
}
const cudaSize = computed(() => (systemCuda.value ? 'já instalado no computador' : '+ ~2 GB de download'))
</script>

<template>
  <div class="flex flex-col items-center justify-center min-h-screen bg-slate-950 px-8 py-8">
    <div class="w-full max-w-xl">

      <!-- Logo / titulo -->
      <div class="text-center mb-6">
        <div class="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-indigo-600/20 border border-indigo-500/30 mb-3">
          <svg class="w-7 h-7 text-indigo-400" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
          </svg>
        </div>
        <h1 class="text-2xl font-bold text-slate-100">Voice AI</h1>
        <p class="text-sm text-slate-500 mt-1">{{ isUpdate ? 'Atualizando componentes' : 'Configuração inicial' }}</p>
      </div>

      <!-- Card -->
      <div class="bg-slate-900 border border-slate-800 rounded-2xl p-6 flex flex-col gap-4">

        <!-- Descricao inicial (antes de comecar) -->
        <div v-if="!hasStarted" class="flex flex-col gap-3">
          <p class="text-slate-300 text-sm leading-relaxed">
            Na primeira execução, o app baixa tudo o que precisa: componentes de voz, transcrição e tradução
            (com o FFmpeg já incluso), o modelo <span class="text-indigo-400 font-medium">Whisper tiny</span> e o
            <span class="text-indigo-400 font-medium">Claude Code</span> (assistente do Chat IA).
            Não é preciso instalar mais nada no computador.
          </p>
          <p class="text-slate-500 text-xs">
            Requer internet. Cerca de 1 GB de download; leva de 5 a 15 minutos, dependendo da conexão.
          </p>

          <!-- Opção da GPU NVIDIA -->
          <label
            v-if="gpu"
            class="flex items-start gap-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3 cursor-pointer hover:border-slate-700 transition-colors"
          >
            <input v-model="useGpu" type="checkbox" class="mt-0.5 w-4 h-4 accent-indigo-500" :disabled="systemCuda" />
            <span class="flex flex-col gap-0.5">
              <span class="text-sm text-slate-200">
                Usar a placa de vídeo NVIDIA na transcrição
                <span class="text-xs text-slate-500">({{ cudaSize }})</span>
              </span>
              <span class="text-xs text-slate-500">
                Transcreve várias vezes mais rápido. Sem isso, o processador faz o trabalho (funciona, só é mais lento).
              </span>
            </span>
          </label>
        </div>

        <!-- Progresso (apos clicar em instalar) -->
        <div v-if="hasStarted" class="flex flex-col gap-4">

          <!-- Status atual + barra -->
          <div class="flex flex-col gap-2">
            <div class="flex items-center justify-between gap-3 text-xs">
              <span :class="['truncate', error ? 'text-red-400' : done ? 'text-emerald-400' : 'text-slate-300']">
                {{ error ? 'Falhou - veja os detalhes abaixo' : currentMessage }}
              </span>
              <span v-if="!error" class="text-indigo-400 font-medium tabular-nums flex-shrink-0">{{ Math.floor(percent) }}%</span>
            </div>
            <div class="w-full bg-slate-800 rounded-full h-2 overflow-hidden">
              <div
                class="h-2 rounded-full transition-all duration-500"
                :class="{
                  'bg-emerald-500': done,
                  'bg-red-500': error,
                  'bg-indigo-500 progress-stripes': installing && !done && !error
                }"
                :style="{ width: Math.max(percent, 2) + '%' }"
              />
            </div>
          </div>

          <!-- Checklist -->
          <ul class="flex flex-col gap-2.5">
            <li v-for="t in tasks" :key="t.id" class="flex flex-col gap-1">
              <div class="flex items-center gap-2.5 min-w-0">
                <!-- ícone de status -->
                <span class="w-5 h-5 flex items-center justify-center flex-shrink-0">
                  <svg v-if="t.status === 'done'" class="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  <span v-else-if="t.status === 'running'" class="w-4 h-4 rounded-full border-2 border-indigo-400/30 border-t-indigo-400 animate-spin" />
                  <svg v-else-if="t.status === 'error'" class="w-5 h-5 text-red-400" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                  <span v-else-if="t.status === 'skipped'" class="w-3 h-0.5 bg-slate-500 rounded" />
                  <span v-else class="w-3 h-3 rounded-full border-2 border-slate-700" />
                </span>
                <span
                  :class="[
                    'text-sm flex-shrink-0',
                    t.status === 'pending' || t.status === 'skipped' ? 'text-slate-500' : t.status === 'error' ? 'text-red-300' : 'text-slate-200'
                  ]"
                >{{ t.label }}</span>
                <span v-if="t.detail" class="text-xs text-slate-500 truncate" :title="t.detail">- {{ t.detail }}</span>
              </div>

              <!-- Pacotes baixados dentro da etapa -->
              <ul v-if="t.items.length" class="ml-7 flex flex-col gap-0.5">
                <li v-for="it in notableItems(t)" :key="it.key" class="flex items-center gap-2 text-xs">
                  <svg v-if="it.status === 'done'" class="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  <span v-else class="w-3.5 h-3.5 flex items-center justify-center flex-shrink-0">
                    <span class="w-2.5 h-2.5 rounded-full border-2 border-indigo-400/30 border-t-indigo-400 animate-spin" />
                  </span>
                  <span :class="it.status === 'done' ? 'text-slate-400' : 'text-slate-200'">{{ it.label }}</span>
                  <span v-if="it.size" class="text-slate-600 tabular-nums">{{ it.size }}</span>
                </li>
                <li v-if="otherCount(t).total" class="text-xs text-slate-600 pl-[22px]">
                  + {{ otherCount(t).done }}/{{ otherCount(t).total }} outros pacotes
                </li>
              </ul>
            </li>
          </ul>

          <!-- Terminal de log (recolhido por padrão) -->
          <div class="flex flex-col gap-2">
            <div class="flex items-center justify-between">
              <button
                class="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors"
                @click="toggleLogs"
              >
                <svg :class="['w-3.5 h-3.5 transition-transform', showLogs ? 'rotate-90' : '']" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                </svg>
                {{ showLogs ? 'Ocultar detalhes' : 'Ver detalhes' }}
                <span class="text-slate-600">({{ logs.length }} linhas)</span>
              </button>
              <button
                v-if="showLogs && logs.length > 0"
                class="flex items-center gap-1 px-2 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 text-xs transition-colors"
                @click="copyLogs"
              >{{ copied ? 'Copiado!' : 'Copiar log' }}</button>
            </div>
            <div
              v-show="showLogs"
              ref="logContainer"
              class="bg-slate-950 rounded-xl border border-slate-800 p-3 h-48 overflow-y-auto font-mono text-[11px] leading-relaxed"
            >
              <div
                v-for="(line, i) in logs"
                :key="i"
                :class="[
                  'whitespace-pre-wrap break-all',
                  line.toLowerCase().includes('error') || line.toLowerCase().includes('erro')
                    ? 'text-red-400'
                    : line.toLowerCase().includes('warning')
                      ? 'text-yellow-500'
                      : line.startsWith('Successfully')
                        ? 'text-emerald-500'
                        : 'text-slate-500'
                ]"
              >{{ line }}</div>
              <div v-if="logs.length === 0" class="text-slate-700 italic">Aguardando saída...</div>
            </div>
          </div>
        </div>

        <!-- Conta Claude (depois de instalar) -->
        <div v-if="done && claude" class="rounded-xl border border-slate-800 bg-slate-950/60 p-4 flex flex-col gap-2">
          <div class="flex items-center justify-between gap-3">
            <div>
              <p class="text-sm text-slate-200 font-medium">Conta Claude (Chat IA)</p>
              <p v-if="claude.loggedIn" class="text-xs text-emerald-400 mt-0.5">Conectada - o Chat IA está pronto.</p>
              <p v-else-if="!claude.installed" class="text-xs text-red-400 mt-0.5">
                O Claude Code não foi instalado. Veja os detalhes; o resto do app funciona normalmente.
              </p>
              <p v-else-if="claudeWaiting" class="text-xs text-slate-400 mt-0.5">
                Termine o login na janela do terminal/navegador que abriu. Esta tela atualiza sozinha.
              </p>
              <p v-else class="text-xs text-slate-500 mt-0.5">
                Entre com a sua conta Claude (assinatura Pro ou Max). Abre uma janela com o login oficial da Anthropic.
              </p>
            </div>
            <button
              v-if="claude.installed && !claude.loggedIn"
              :disabled="claudeWaiting"
              class="flex-shrink-0 px-3.5 py-2 bg-orange-600 hover:bg-orange-500 disabled:opacity-60 disabled:cursor-wait text-white text-xs font-medium rounded-lg transition-colors"
              @click="loginClaude"
            >
              {{ claudeWaiting ? 'Aguardando...' : 'Entrar na conta' }}
            </button>
            <svg v-else-if="claude.loggedIn" class="w-5 h-5 text-emerald-400 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <p v-if="claude.installed && !claude.loggedIn" class="text-[11px] text-slate-600">
            Pode fazer depois em Configurações → Claude: a transcrição e a tradução funcionam sem a conta.
          </p>
        </div>

        <!-- Botoes -->
        <div class="flex justify-end gap-3 mt-1">
          <button
            v-if="!hasStarted"
            class="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-xl transition-colors"
            @click="install"
          >
            Instalar e configurar
          </button>

          <button
            v-if="installing && !done"
            disabled
            class="px-5 py-2.5 bg-indigo-600/50 text-indigo-300 text-sm font-medium rounded-xl cursor-not-allowed flex items-center gap-2"
          >
            <svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
            </svg>
            Instalando...
          </button>

          <button
            v-if="error && !installing"
            class="px-5 py-2.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm font-medium rounded-xl transition-colors"
            @click="install"
          >
            Tentar novamente
          </button>

          <button
            v-if="done"
            class="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-xl transition-colors flex items-center gap-2"
            @click="startApp"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            Iniciar app
          </button>
        </div>

      </div>

      <p class="text-center text-slate-700 text-xs mt-4">
        Componentes em <code class="text-slate-600">%APPDATA%\voice-ai\packages</code>
      </p>
    </div>
  </div>
</template>

<style scoped>
/* Listras animadas na barra enquanto instala: deixa claro que não travou */
.progress-stripes {
  background-image: linear-gradient(
    45deg,
    rgba(255, 255, 255, 0.15) 25%,
    transparent 25%,
    transparent 50%,
    rgba(255, 255, 255, 0.15) 50%,
    rgba(255, 255, 255, 0.15) 75%,
    transparent 75%,
    transparent
  );
  background-size: 16px 16px;
  animation: stripes 0.8s linear infinite;
}
@keyframes stripes {
  from {
    background-position: 16px 0;
  }
  to {
    background-position: 0 0;
  }
}
</style>
