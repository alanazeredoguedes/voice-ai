<script setup lang="ts">
import { ref } from 'vue'
import { fetchElevenLabsVoices } from '../api'
import type { ElevenLabsVoice } from '../types'
import { useSettingsStore } from '../stores/settings'

const store = useSettingsStore()

const voices = ref<ElevenLabsVoice[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const apiKeyInput = ref(store.settings?.elevenlabs_api_key ?? '')

async function fetchVoices(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const result = await fetchElevenLabsVoices(apiKeyInput.value)
    voices.value = result.voices
    await store.update({ elevenlabs_api_key: apiKeyInput.value })
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Erro ao buscar vozes'
  } finally {
    loading.value = false
  }
}

async function selectVoice(v: ElevenLabsVoice): Promise<void> {
  await store.update({ elevenlabs_voice_id: v.voice_id, elevenlabs_voice_name: v.name })
}
</script>

<template>
  <div class="space-y-3 mt-2 p-4 bg-slate-800/50 rounded-xl border border-slate-700">
    <p class="text-sm font-medium text-slate-300">ElevenLabs</p>
    <div class="flex gap-2">
      <input
        v-model="apiKeyInput"
        type="password"
        placeholder="API Key"
        class="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
      />
      <button
        :disabled="loading || !apiKeyInput"
        class="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-sm transition-colors"
        @click="fetchVoices"
      >
        {{ loading ? '...' : 'Buscar' }}
      </button>
    </div>
    <p v-if="error" class="text-xs text-red-400">{{ error }}</p>
    <div v-if="voices.length" class="flex flex-col gap-1 max-h-40 overflow-y-auto">
      <button
        v-for="v in voices"
        :key="v.voice_id"
        :class="[
          'flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-left transition-colors',
          store.settings?.elevenlabs_voice_id === v.voice_id
            ? 'bg-indigo-600 text-white'
            : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
        ]"
        @click="selectVoice(v)"
      >
        {{ v.name }}
      </button>
    </div>
  </div>
</template>
