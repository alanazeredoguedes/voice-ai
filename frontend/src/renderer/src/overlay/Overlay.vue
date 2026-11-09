<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue'
import { useStatusStore } from '../stores/status'
import { onWsMessage } from '../api/ws'

const statusStore = useStatusStore()
const showDone = ref(false)
const overlayProgress = ref(0)
let doneTimer: ReturnType<typeof setTimeout> | null = null

const unsub = onWsMessage((event) => {
  if (event.type === 'state_changed' && event.state) {
    if (event.state === 'idle' && statusStore.state !== 'idle') {
      showDone.value = true
      if (doneTimer) clearTimeout(doneTimer)
      doneTimer = setTimeout(() => { showDone.value = false }, 1800)
    }
    if (event.state !== 'processing') overlayProgress.value = 0
    statusStore.setState(event.state)
  } else if (event.type === 'transcription_progress' && event.progress !== undefined) {
    overlayProgress.value = event.progress
  } else if (event.type === 'engine_loading') {
    statusStore.onEngineLoading(event)
  }
})
void statusStore.syncEngineLoading()

/** modelo ainda carregando: o que for gravado espera ele ficar pronto */
const loadingPct = computed(() => (statusStore.engineLoading ? Math.floor(statusStore.engineLoading.progress) : null))

onUnmounted(() => {
  unsub()
  if (doneTimer) clearTimeout(doneTimer)
})

const isDone = computed(() => showDone.value && statusStore.state === 'idle')
const isVisible = computed(() => statusStore.state !== 'idle' || isDone.value)

type StateKey = 'recording' | 'processing' | 'thinking' | 'speaking' | 'done' | 'loading'

const config: Record<StateKey, { bg: string; shadow: string; label: string; pulse: boolean }> = {
  recording:  { bg: 'rgba(234, 88,  12, 0.92)', shadow: 'rgba(234, 88,  12, 0.35)', label: 'Gravando',     pulse: true  },
  processing: { bg: 'rgba(202, 138,  4, 0.92)', shadow: 'rgba(202, 138,  4, 0.35)', label: 'Processando',  pulse: false },
  thinking:   { bg: 'rgba(147, 51, 234, 0.92)', shadow: 'rgba(147, 51, 234, 0.35)', label: 'Pensando',     pulse: true  },
  speaking:   { bg: 'rgba(8,  145, 178, 0.92)', shadow: 'rgba(8,  145, 178, 0.35)', label: 'Falando',      pulse: false },
  done:       { bg: 'rgba(16, 185, 129, 0.92)', shadow: 'rgba(16, 185, 129, 0.35)', label: 'Pronto',       pulse: false },
  loading:    { bg: 'rgba(79,  70, 229, 0.92)', shadow: 'rgba(79,  70, 229, 0.35)', label: 'Carregando modelo', pulse: true },
}

const current = computed<StateKey>(() => {
  if (isDone.value) return 'done'
  // soltou o atalho mas o modelo ainda está carregando: mostra o carregamento no lugar de "Processando"
  if (statusStore.state === 'processing' && loadingPct.value !== null) return 'loading'
  return statusStore.state as StateKey
})

const pillStyle = computed(() => {
  const c = config[current.value] ?? config.done
  return `background:${c.bg}; box-shadow: 0 2px 12px ${c.shadow};`
})
</script>

<template>
  <transition name="fade">
    <div
      v-if="isVisible"
      class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full select-none"
      :style="pillStyle"
      style="font-family: system-ui, -apple-system, sans-serif;"
    >
      <span
        class="w-2 h-2 rounded-full bg-white flex-shrink-0"
        :class="config[current]?.pulse ? 'animate-pulse' : ''"
        style="opacity: 0.9;"
      />
      <span style="font-size: 12px; font-weight: 600; color: white; letter-spacing: 0.01em; white-space: nowrap;">
        {{ config[current]?.label }}<span v-if="current === 'processing' && overlayProgress > 0"> {{ Math.floor(overlayProgress) }}%</span><span v-if="current === 'loading'"> {{ statusStore.engineLoading?.slow ? `${Math.floor(statusStore.engineLoading?.elapsed ?? 0)} s, aguarde` : `${loadingPct}%, aguarde` }}</span><span v-if="current === 'recording' && loadingPct !== null" style="opacity: 0.85; font-weight: 500;"> · modelo {{ loadingPct }}%</span>
      </span>
    </div>
  </transition>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
  transform: translateY(-3px);
}
</style>
