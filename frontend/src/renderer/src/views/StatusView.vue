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
  } else if (event.type === 'log_added' && event.entry?.ai_response) {
    statusStore.setLastAiResponse(event.entry.ai_response)
  }
})

onUnmounted(() => unsub())
</script>

<template>
  <div class="flex flex-col gap-6">
    <div>
      <h1 class="text-xl font-semibold text-slate-100">Ao Vivo</h1>
      <p class="text-sm text-slate-500 mt-1">Estado do assistente em tempo real</p>
    </div>

    <div class="bg-slate-800/60 rounded-2xl p-6 flex flex-col items-center gap-4 border border-slate-700/40">
      <StatusBadge :state="statusStore.state" size="lg" />
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

    <div v-if="statusStore.lastAiResponse" class="bg-slate-800/60 rounded-2xl p-4 border border-slate-700/40">
      <div class="flex items-center justify-between mb-2">
        <p class="text-xs text-slate-500 uppercase tracking-wide">Última resposta IA</p>
        <CopyButton :text="statusStore.lastAiResponse" />
      </div>
      <p class="text-slate-200 text-sm leading-relaxed">{{ statusStore.lastAiResponse }}</p>
    </div>
  </div>
</template>
