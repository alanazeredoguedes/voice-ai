<script setup lang="ts">
import { inject, onMounted, onUnmounted } from 'vue'
import { useStatusStore } from '../stores/status'
import { onWsMessage } from '../api/ws'
import StatusBadge from '../components/StatusBadge.vue'
import AudioLevelBar from '../components/AudioLevelBar.vue'
import CopyButton from '../components/CopyButton.vue'

const statusStore = useStatusStore()

const MODEL_NAMES: Record<string, string> = {
  tiny: 'Tiny',
  base: 'Base',
  small: 'Small',
  medium: 'Medium',
  'large-v3-turbo': 'Large v3 Turbo',
  'large-v3': 'Large v3'
}
const modelLabel = (id?: string | null): string => (id ? (MODEL_NAMES[id] ?? id) : '')
const navigate = inject<(v: string) => void>('navigate')

// confirma o modelo em uso ao abrir a tela (as mudanças depois chegam pelo WebSocket)
onMounted(() => void statusStore.syncEngineLoading())

const unsub = onWsMessage((event) => {
  if (event.type === 'state_changed' && event.state) {
    statusStore.setState(event.state)
  } else if (event.type === 'audio_level' && event.level !== undefined) {
    statusStore.setAudioLevel(event.level)
  } else if (event.type === 'transcription_ready' && event.text) {
    statusStore.setLastTranscription(event.text)
  } else if (event.type === 'transcription_progress' && event.progress !== undefined) {
    statusStore.setTranscriptionProgress(event.progress)
  }
})

onUnmounted(() => unsub())
</script>

<template>
  <div class="flex flex-col gap-6">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold text-slate-100">Transcrição de Microfone</h1>
        <p class="text-sm text-slate-500 mt-1">Estado do assistente em tempo real</p>
      </div>
      <!-- modelo que está na memória e transcrevendo agora -->
      <button
        v-if="statusStore.engineInfo"
        title="Modelo do Whisper carregado agora. Clique para trocar nas Configurações"
        class="flex items-center gap-2.5 rounded-xl border border-slate-700/60 bg-slate-800/60 hover:border-indigo-500/60 hover:bg-indigo-600/10 px-3.5 py-2 text-left transition-colors"
        @click="navigate?.('settings')"
      >
        <span
          :class="[
            'w-2 h-2 rounded-full flex-shrink-0',
            statusStore.engineLoading ? 'bg-indigo-400 animate-pulse' : statusStore.engineInfo.ready ? 'bg-emerald-400' : 'bg-amber-400'
          ]"
        />
        <span class="flex flex-col">
          <span class="text-[11px] text-slate-500 leading-tight">
            {{ statusStore.engineLoading ? 'Carregando modelo' : 'Modelo em uso' }}
          </span>
          <span class="text-sm text-slate-100 font-medium leading-tight">
            {{ modelLabel(statusStore.engineLoading?.model ?? statusStore.engineInfo.model) || 'Nenhum' }}
            <span class="text-slate-400 font-normal">
              · {{ (statusStore.engineLoading?.device ?? statusStore.engineInfo.device) === 'cuda' ? 'Placa de vídeo (GPU)' : (statusStore.engineLoading?.device ?? statusStore.engineInfo.device) === 'cpu' ? 'Processador (CPU)' : '...' }}
            </span>
          </span>
        </span>
      </button>
    </div>

    <!-- modelo carregando (ao abrir o app ou trocar de modelo) -->
    <div
      v-if="statusStore.engineLoading"
      class="rounded-2xl p-4 border border-indigo-500/40 bg-indigo-600/10 flex flex-col gap-2.5"
    >
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2.5 min-w-0">
          <span class="w-4 h-4 rounded-full border-2 border-indigo-300/30 border-t-indigo-300 animate-spin flex-shrink-0" />
          <div class="min-w-0">
            <p class="text-sm text-slate-100 font-medium">
              Carregando o modelo {{ modelLabel(statusStore.engineLoading.model) }}{{ statusStore.engineLoading.device === 'cuda' ? ' na placa de vídeo' : '' }}
            </p>
            <p class="text-xs text-slate-400 mt-0.5">
              {{ statusStore.engineLoading.phase }}...
              <span v-if="statusStore.engineLoading.slow" class="text-amber-300">demorando mais que o normal</span>
            </p>
          </div>
        </div>
        <!-- passou bastante do normal: mostra o tempo correndo em vez de uma % parada -->
        <span v-if="statusStore.engineLoading.slow" class="text-lg font-semibold tabular-nums text-amber-300">
          {{ Math.floor(statusStore.engineLoading.elapsed ?? 0) }} s
        </span>
        <span v-else class="text-lg font-semibold tabular-nums text-indigo-200">{{ Math.floor(statusStore.engineLoading.progress) }}%</span>
      </div>
      <div class="h-1.5 rounded-full bg-slate-800 overflow-hidden">
        <div v-if="statusStore.engineLoading.slow" class="h-full w-1/3 bg-amber-400/80 loading-sweep" />
        <div v-else class="h-full bg-indigo-500 transition-all duration-500" :style="{ width: `${statusStore.engineLoading.progress}%` }" />
      </div>
      <p class="text-[11px] text-slate-500">
        Acontece ao abrir o app (mais demorado logo depois de ligar o computador) ou ao trocar de modelo.
        Pode usar o atalho normalmente: o que você falar fica guardado e é transcrito assim que o modelo terminar.
      </p>
    </div>

    <div class="bg-slate-800/60 rounded-2xl p-6 flex flex-col items-center gap-4 border border-slate-700/40">
      <div class="flex items-center gap-3">
        <StatusBadge :state="statusStore.state" size="lg" />
        <transition name="fade-pct">
          <span
            v-if="statusStore.state === 'processing' && statusStore.transcriptionProgress > 0"
            class="text-2xl font-semibold tabular-nums text-amber-400"
          >
            {{ Math.floor(statusStore.transcriptionProgress) }}%
          </span>
        </transition>
      </div>
      <div class="w-full max-w-xs flex flex-col gap-1">
        <p class="text-xs text-slate-500 text-center">Nível de áudio</p>
        <AudioLevelBar :level="statusStore.audioLevel" />
      </div>
    </div>

    <div v-if="statusStore.lastTranscription" class="bg-slate-800/60 rounded-2xl p-4 border border-slate-700/40">
      <div class="flex items-center justify-between mb-2">
        <p class="text-xs text-slate-500 uppercase tracking-wide">Última transcrição</p>
        <CopyButton :text="statusStore.lastTranscription" />
      </div>
      <p class="text-slate-200 text-sm leading-relaxed">{{ statusStore.lastTranscription }}</p>
    </div>

  </div>
</template>

<style scoped>
/* carregamento demorando: barra que vai e volta (sem % definida) */
.loading-sweep {
  animation: sweep 1.4s ease-in-out infinite;
}
@keyframes sweep {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(300%); }
}
</style>
