<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useSettingsStore } from '../stores/settings'
import { restartEngine, getEdgeVoices } from '../api'
import type { EdgeVoice } from '../types'
import HotkeyCapture from '../components/HotkeyCapture.vue'
import SettingToggle from '../components/SettingToggle.vue'
import ElevenLabsConfig from '../components/ElevenLabsConfig.vue'

const store = useSettingsStore()
const edgeVoices = ref<EdgeVoice[]>([])
const restarting = ref(false)
const restartMsg = ref('')

onMounted(async () => {
  if (!store.settings) await store.fetchSettings()
  edgeVoices.value = await getEdgeVoices()
})

async function doRestartEngine(): Promise<void> {
  restarting.value = true
  restartMsg.value = ''
  try {
    await restartEngine()
    restartMsg.value = 'Engine reiniciado!'
    setTimeout(() => (restartMsg.value = ''), 3000)
  } catch {
    restartMsg.value = 'Erro ao reiniciar engine'
  } finally {
    restarting.value = false
  }
}

async function set(patch: Record<string, unknown>): Promise<void> {
  await store.update(patch)
}
</script>

<template>
  <div class="flex flex-col gap-5 h-full" v-if="store.settings">
    <div>
      <h1 class="text-xl font-semibold text-slate-100">Configurações</h1>
      <p class="text-sm text-slate-500 mt-1">Personalize o comportamento do assistente</p>
    </div>

    <!-- Grid responsivo: 1 coluna em telas pequenas, 2 em telas largas -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-5 pb-6">

      <!-- Atalhos — largura total -->
      <section class="col-span-full bg-slate-800/60 rounded-2xl p-5 border border-slate-700/40 flex flex-col gap-4">
        <h2 class="text-xs font-semibold text-slate-400 uppercase tracking-widest">Atalhos</h2>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <HotkeyCapture
            :model-value="store.settings.transcription_key"
            label="Transcrição (push-to-talk)"
            @update:model-value="(v) => set({ transcription_key: v })"
          />
          <HotkeyCapture
            :model-value="store.settings.ai_key"
            label="IA (push-to-talk)"
            @update:model-value="(v) => set({ ai_key: v })"
          />
        </div>
      </section>

      <!-- STT — meia largura -->
      <section class="bg-slate-800/60 rounded-2xl p-5 border border-slate-700/40 flex flex-col gap-4">
        <h2 class="text-xs font-semibold text-slate-400 uppercase tracking-widest">Reconhecimento de Voz</h2>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="text-xs text-slate-500 block mb-1.5">Modelo Whisper</label>
            <select
              :value="store.settings.model"
              class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              @change="set({ model: ($event.target as HTMLSelectElement).value })"
            >
              <option v-for="m in ['tiny','base','small','medium','large-v3']" :key="m" :value="m">{{ m }}</option>
            </select>
          </div>
          <div>
            <label class="text-xs text-slate-500 block mb-1.5">Dispositivo</label>
            <select
              :value="store.settings.device"
              class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              @change="set({ device: ($event.target as HTMLSelectElement).value })"
            >
              <option v-for="d in ['auto','cuda','cpu']" :key="d" :value="d">{{ d }}</option>
            </select>
          </div>
        </div>
        <div class="flex items-center gap-3 pt-1">
          <button
            :disabled="restarting"
            class="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
            @click="doRestartEngine"
          >
            {{ restarting ? 'Reiniciando...' : 'Reiniciar engine' }}
          </button>
          <p v-if="restartMsg" class="text-xs text-emerald-400">{{ restartMsg }}</p>
        </div>
      </section>

      <!-- TTS — meia largura -->
      <section class="bg-slate-800/60 rounded-2xl p-5 border border-slate-700/40 flex flex-col gap-4">
        <h2 class="text-xs font-semibold text-slate-400 uppercase tracking-widest">Síntese de Voz</h2>
        <div class="flex gap-5">
          <label v-for="b in ['edge','elevenlabs']" :key="b" class="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              :value="b"
              :checked="store.settings.tts_backend === b"
              class="accent-indigo-500"
              @change="set({ tts_backend: b })"
            />
            <span class="text-sm text-slate-300">{{ b === 'edge' ? 'Edge TTS' : 'ElevenLabs' }}</span>
          </label>
        </div>
        <div v-if="store.settings.tts_backend === 'edge'">
          <label class="text-xs text-slate-500 block mb-1.5">Voz</label>
          <select
            :value="store.settings.edge_voice"
            class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            @change="set({ edge_voice: ($event.target as HTMLSelectElement).value })"
          >
            <option v-for="v in edgeVoices" :key="v.id" :value="v.id">{{ v.name }}</option>
          </select>
        </div>
        <ElevenLabsConfig v-if="store.settings.tts_backend === 'elevenlabs'" />
      </section>

      <!-- Claude — largura total -->
      <section class="col-span-full bg-slate-800/60 rounded-2xl p-5 border border-slate-700/40 flex flex-col gap-4">
        <h2 class="text-xs font-semibold text-slate-400 uppercase tracking-widest">Claude</h2>
        <SettingToggle
          :model-value="store.settings.claude_continue"
          label="Contexto contínuo"
          description="Mantém histórico de conversa entre interações"
          @update:model-value="(v) => set({ claude_continue: v })"
        />
        <div>
          <label class="text-xs text-slate-500 block mb-1.5">System prompt</label>
          <textarea
            :value="store.settings.claude_system_prompt"
            rows="3"
            class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-none"
            placeholder="Você é um assistente..."
            @blur="set({ claude_system_prompt: ($event.target as HTMLTextAreaElement).value })"
          />
        </div>
      </section>

      <!-- Sons — meia largura -->
      <section class="bg-slate-800/60 rounded-2xl p-5 border border-slate-700/40 flex flex-col gap-4">
        <h2 class="text-xs font-semibold text-slate-400 uppercase tracking-widest">Sons</h2>
        <SettingToggle
          :model-value="store.settings.sound_recording"
          label="Som ao iniciar gravação"
          @update:model-value="(v) => set({ sound_recording: v })"
        />
        <SettingToggle
          :model-value="store.settings.sound_processing"
          label="Som ao processar"
          @update:model-value="(v) => set({ sound_processing: v })"
        />
        <SettingToggle
          :model-value="store.settings.sound_copied"
          label="Som ao copiar"
          @update:model-value="(v) => set({ sound_copied: v })"
        />
      </section>

    </div>
  </div>

  <div v-else-if="store.loading" class="flex items-center justify-center h-32">
    <p class="text-slate-500 text-sm">Carregando configurações...</p>
  </div>

  <div v-else-if="store.error" class="flex items-center justify-center h-32">
    <p class="text-red-400 text-sm">{{ store.error }}</p>
  </div>
</template>
