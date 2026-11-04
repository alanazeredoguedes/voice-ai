<script setup lang="ts">
import { ref, onMounted, nextTick } from 'vue'

const emit = defineEmits<{ done: [] }>()

const installing = ref(false)
const hasStarted = ref(false)
const done = ref(false)
const error = ref('')
const currentMessage = ref('')
const percent = ref(0)
const logs = ref<string[]>([])
const logContainer = ref<HTMLElement | null>(null)
const copied = ref(false)

function scrollLogs() {
  nextTick(() => {
    if (logContainer.value) logContainer.value.scrollTop = logContainer.value.scrollHeight
  })
}

function addLog(line: string) {
  if (!line) return
  for (const l of line.split('\n')) {
    const trimmed = l.trim()
    if (trimmed) {
      logs.value.push(trimmed)
      if (logs.value.length > 300) logs.value.shift()
    }
  }
  scrollLogs()
}

onMounted(() => {
  window.electron.ipcRenderer.on(
    'setup:progress',
    (_, p: { step: string; message: string; percent: number; log?: string }) => {
      if (p.log) addLog(p.log)
      if (p.percent >= 0) percent.value = p.percent
      if (p.message) currentMessage.value = p.message
    }
  )

  window.electron.ipcRenderer.on(
    'setup:done',
    (_, result: { success: boolean; error?: string }) => {
      installing.value = false
      if (result.success) {
        percent.value = 100
        currentMessage.value = 'Tudo pronto!'
        done.value = true
      } else {
        error.value = result.error ?? 'Erro desconhecido'
      }
    }
  )
})

async function install() {
  installing.value = true
  hasStarted.value = true
  error.value = ''
  logs.value = []
  currentMessage.value = 'Iniciando...'
  percent.value = 0
  await window.electron.ipcRenderer.invoke('setup:start')
}

function startApp() {
  emit('done')
}

async function copyLogs() {
  await navigator.clipboard.writeText(logs.value.join('\n'))
  copied.value = true
  setTimeout(() => (copied.value = false), 2000)
}
</script>

<template>
  <div class="flex flex-col items-center justify-center h-screen bg-slate-950 px-8">
    <div class="w-full max-w-lg">

      <!-- Logo / titulo -->
      <div class="text-center mb-8">
        <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-indigo-600/20 border border-indigo-500/30 mb-4">
          <svg class="w-8 h-8 text-indigo-400" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
          </svg>
        </div>
        <h1 class="text-2xl font-bold text-slate-100">Voice AI</h1>
        <p class="text-sm text-slate-500 mt-1">Configuracao inicial</p>
      </div>

      <!-- Card -->
      <div class="bg-slate-900 border border-slate-800 rounded-2xl p-6 flex flex-col gap-4">

        <!-- Descricao inicial (antes de comecar) -->
        <div v-if="!hasStarted">
          <p class="text-slate-300 text-sm leading-relaxed">
            Na primeira execucao, o app instala as dependencias Python e baixa
            o modelo de transcricao <span class="text-indigo-400 font-medium">Whisper tiny</span> (~75 MB).
          </p>
          <p class="text-slate-500 text-xs mt-2">
            Requer conexao com a internet. Leva 5-10 minutos dependendo da conexao.
          </p>
        </div>

        <!-- Progresso + log (apos clicar em instalar) -->
        <div v-if="hasStarted" class="flex flex-col gap-3">

          <!-- Status atual -->
          <div class="flex items-center justify-between text-xs">
            <span :class="error ? 'text-red-400' : done ? 'text-emerald-400' : 'text-slate-400'">
              {{ error ? 'Falhou — veja o log abaixo' : currentMessage }}
            </span>
            <span v-if="percent > 0 && !error" class="text-indigo-400 font-medium tabular-nums">
              {{ percent }}%
            </span>
          </div>

          <!-- Barra de progresso -->
          <div class="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
            <div
              class="h-1.5 rounded-full transition-all duration-700"
              :class="{
                'bg-emerald-500': done,
                'bg-red-500': error,
                'bg-indigo-500': installing && !done && !error
              }"
              :style="{ width: Math.max(percent, 2) + '%' }"
            />
          </div>
          <div v-if="installing && !done && !error" class="w-full bg-slate-800 rounded-full h-1 overflow-hidden -mt-2">
            <div class="h-1 bg-indigo-500/40 animate-pulse w-full rounded-full" />
          </div>

          <!-- Terminal de log — sempre visivel apos iniciar -->
          <div class="relative">
            <button
              v-if="logs.length > 0"
              class="absolute top-2 right-2 z-10 flex items-center gap-1 px-2 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 text-xs transition-colors"
              @click="copyLogs"
            >
              <svg v-if="!copied" class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
              </svg>
              <svg v-else class="w-3 h-3 text-emerald-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
              </svg>
              {{ copied ? 'Copiado!' : 'Copiar' }}
            </button>
          <div
            ref="logContainer"
            class="bg-slate-950 rounded-xl border border-slate-800 p-3 h-52 overflow-y-auto font-mono text-xs leading-relaxed"
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
            <div v-if="logs.length === 0" class="text-slate-700 italic">Aguardando saida...</div>
          </div>
          </div>
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
        Dependencias em <code class="text-slate-600">~/.config/voice-ai/venv/</code>
      </p>
    </div>
  </div>
</template>
