<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref } from 'vue'
import { useStatusStore } from '../stores/status'
import { useSettingsStore } from '../stores/settings'
import { prettyHotkey } from '../utils/hotkeys'
import { onWsMessage } from '../api/ws'
import StatusBadge from '../components/StatusBadge.vue'
import AudioLevelBar from '../components/AudioLevelBar.vue'
import CopyButton from '../components/CopyButton.vue'

const statusStore = useStatusStore()
const settingsStore = useSettingsStore()

/** atalho(s) que ligam a transcrição (o principal e os extras), para mostrar ao lado do modelo */
const transcriptionKeys = computed(() => {
  const s = settingsStore.settings
  if (!s) return []
  return [s.transcription_key, ...(s.transcription_keys_extra ?? [])].filter(Boolean).map(prettyHotkey)
})

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
onMounted(() => {
  void statusStore.syncEngineLoading()
  void statusStore.loadRecentTranscriptions()
  if (!settingsStore.settings) void settingsStore.fetchSettings()
})

// transcrições anteriores (a mais recente fica em destaque; as outras ficam discretas no rodapé)
const previous = computed(() => statusStore.recentTranscriptions.slice(1))
const openPrevious = ref<number | null>(null)
/** hora (HH:MM); se não for de hoje, mostra o dia junto (dd/mm HH:MM) */
const fmtTime = (ts: string): string => {
  const d = new Date(ts)
  if (d.toDateString() === new Date().toDateString()) {
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}
const fullTime = (ts: string): string => new Date(ts).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' })

const unsub = onWsMessage((event) => {
  if (event.type === 'state_changed' && event.state) {
    statusStore.setState(event.state)
  } else if (event.type === 'audio_level' && event.level !== undefined) {
    statusStore.setAudioLevel(event.level)
  } else if (event.type === 'transcription_progress' && event.progress !== undefined) {
    statusStore.setTranscriptionProgress(event.progress)
  }
})

onUnmounted(() => unsub())
</script>

<template>
  <div class="flex flex-col gap-6 min-h-full">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold text-slate-100">Transcrição de Microfone</h1>
        <p class="text-sm text-slate-500 mt-1">Estado do assistente em tempo real</p>
        <button
          type="button"
          class="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-700 hover:border-indigo-500/60 hover:bg-indigo-600/10 text-xs text-slate-300 hover:text-slate-100 transition-colors"
          @click="navigate?.('transcribe')"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
          </svg>
          Quer transcrever um arquivo de áudio ou vídeo?
          <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
          </svg>
        </button>
      </div>
      <div class="flex flex-wrap items-stretch gap-2">
      <!-- atalho que liga a transcrição -->
      <button
        v-if="transcriptionKeys.length"
        title="Atalho que liga a transcrição pelo microfone. Clique para mudar nas Configurações"
        class="flex items-center gap-2.5 rounded-xl border border-slate-700/60 bg-slate-800/60 hover:border-indigo-500/60 hover:bg-indigo-600/10 px-3.5 py-2 text-left transition-colors"
        @click="navigate?.('settings')"
      >
        <svg class="w-4 h-4 text-slate-400 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
        </svg>
        <span class="flex flex-col">
          <span class="text-[11px] text-slate-500 leading-tight">Atalho para transcrever</span>
          <span class="text-sm text-slate-100 font-medium leading-tight">{{ transcriptionKeys.join('  ou  ') }}</span>
        </span>
      </button>
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
        <div class="flex items-baseline gap-2">
          <p class="text-xs text-slate-500 uppercase tracking-wide">Última transcrição</p>
          <span
            v-if="statusStore.recentTranscriptions[0]"
            class="text-[11px] text-slate-500 tabular-nums"
            :title="fullTime(statusStore.recentTranscriptions[0].ts)"
          >{{ fmtTime(statusStore.recentTranscriptions[0].ts) }}</span>
        </div>
        <CopyButton :text="statusStore.lastTranscription" />
      </div>
      <p class="text-slate-200 text-sm leading-relaxed">{{ statusStore.lastTranscription }}</p>
    </div>

    <!-- anteriores: discretas, no rodapé; clique abre o texto inteiro -->
    <div v-if="previous.length" class="mt-auto flex flex-col gap-1.5 pt-2">
      <p class="px-1 text-[11px] uppercase tracking-wide text-slate-600">Anteriores</p>
      <div
        v-for="(t, i) in previous"
        :key="t.ts + i"
        class="rounded-lg border border-slate-800 hover:border-slate-700 transition-colors"
      >
        <div class="flex items-center gap-2 px-3 py-2 cursor-pointer select-none" @click="openPrevious = openPrevious === i ? null : i">
          <svg
            :class="['w-3 h-3 flex-shrink-0 text-slate-600 transition-transform', openPrevious === i ? 'rotate-90' : '']"
            fill="none"
            stroke="currentColor"
            stroke-width="2.2"
            viewBox="0 0 24 24"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
          </svg>
          <span class="text-[11px] text-slate-600 tabular-nums flex-shrink-0" :title="fullTime(t.ts)">{{ fmtTime(t.ts) }}</span>
          <span v-if="openPrevious !== i" class="text-xs text-slate-500 truncate flex-1 min-w-0">{{ t.text }}</span>
          <span v-else class="flex-1" />
          <CopyButton :text="t.text" size="sm" />
        </div>
        <p v-if="openPrevious === i" class="px-3 pb-3 text-xs text-slate-400 leading-relaxed whitespace-pre-wrap select-text">{{ t.text }}</p>
      </div>
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
