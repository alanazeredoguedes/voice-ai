<script setup lang="ts">
import { onUnmounted } from 'vue'
import { useStatusStore } from '../stores/status'
import { onWsMessage } from '../api/ws'
import StatusBadge from '../components/StatusBadge.vue'
import AudioLevelBar from '../components/AudioLevelBar.vue'
import CopyButton from '../components/CopyButton.vue'

const statusStore = useStatusStore()

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
    <div>
      <h1 class="text-xl font-semibold text-slate-100">Transcrição de Microfone</h1>
      <p class="text-sm text-slate-500 mt-1">Estado do assistente em tempo real</p>
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
