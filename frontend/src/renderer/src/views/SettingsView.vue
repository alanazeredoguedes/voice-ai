<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useSettingsStore } from '../stores/settings'
import { restartEngine, getEdgeVoices, getWhisperModels, downloadWhisperModel, deleteWhisperModel } from '../api'
import { onWsMessage } from '../api/ws'
import type { EdgeVoice, WhisperModel } from '../types'
import HotkeyCapture from '../components/HotkeyCapture.vue'
import SettingToggle from '../components/SettingToggle.vue'
import ElevenLabsConfig from '../components/ElevenLabsConfig.vue'

const store = useSettingsStore()
const edgeVoices = ref<EdgeVoice[]>([])
const restarting = ref(false)
const restartMsg = ref('')

// Modelos Whisper
const whisperModels = ref<WhisperModel[]>([])
const modelProgress = ref<Record<string, number>>({})
const modelError = ref<Record<string, string>>({})

const unsub = onWsMessage((event) => {
  if (event.type === 'model_download_progress' && event.model) {
    modelProgress.value[event.model] = event.progress ?? 0
    const m = whisperModels.value.find(x => x.id === event.model)
    if (m) m.downloading = true
  } else if (event.type === 'model_download_complete' && event.model) {
    const m = whisperModels.value.find(x => x.id === event.model)
    if (m) { m.downloaded = true; m.downloading = false }
    delete modelProgress.value[event.model!]
  } else if (event.type === 'model_download_error' && event.model) {
    const m = whisperModels.value.find(x => x.id === event.model)
    if (m) m.downloading = false
    modelError.value[event.model] = event.error ?? 'Erro desconhecido'
    delete modelProgress.value[event.model!]
  }
})

onUnmounted(() => unsub())

onMounted(async () => {
  if (!store.settings) await store.fetchSettings()
  edgeVoices.value = await getEdgeVoices()
  whisperModels.value = await getWhisperModels()
})

async function startDownload(id: string): Promise<void> {
  delete modelError.value[id]
  const m = whisperModels.value.find(x => x.id === id)
  if (m) m.downloading = true
  modelProgress.value[id] = 0
  try {
    await downloadWhisperModel(id)
  } catch {
    if (m) m.downloading = false
    delete modelProgress.value[id]
  }
}

async function removeModel(id: string): Promise<void> {
  await deleteWhisperModel(id)
  const m = whisperModels.value.find(x => x.id === id)
  if (m) m.downloaded = false
}

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

      <!-- Atalhos - largura total -->
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
        <p class="text-xs text-slate-500 leading-relaxed">
          <span class="text-slate-400 font-medium">Dica:</span>
          dois cliques rápidos no botão de transcrição cancelam a transcrição em andamento.
          Dois cliques rápidos no botão de IA cancelam a resposta em andamento.
        </p>
      </section>

      <!-- STT - meia largura -->
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
              <option value="auto">Auto</option>
              <option value="cuda">NVIDIA (CUDA)</option>
              <option value="cpu">CPU</option>
            </select>
          </div>
        </div>
      </section>

      <!-- Modelos Whisper - largura total -->
      <section class="col-span-full bg-slate-800/60 rounded-2xl p-5 border border-slate-700/40 flex flex-col gap-4">
        <h2 class="text-xs font-semibold text-slate-400 uppercase tracking-widest">Modelos de Transcrição (Whisper)</h2>
        <p class="text-xs text-slate-500 -mt-2">Modelos maiores são mais precisos mas mais lentos. Baixados em <code class="text-slate-400">~/.cache/huggingface/hub/</code></p>

        <div class="flex flex-col gap-2">
          <div
            v-for="m in whisperModels"
            :key="m.id"
            :class="[
              'flex items-center gap-3 px-4 py-3 rounded-xl border transition-colors',
              store.settings?.model === m.id
                ? 'border-indigo-500/50 bg-indigo-600/10'
                : 'border-slate-700/40 bg-slate-900/40'
            ]"
          >
            <!-- Nome e metadados -->
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="text-sm font-medium text-slate-200">{{ m.name }}</span>
                <span
                  v-if="store.settings?.model === m.id"
                  class="text-xs px-1.5 py-0.5 rounded bg-indigo-600/40 text-indigo-300"
                >ativo</span>
                <span
                  v-if="m.downloaded"
                  class="text-xs px-1.5 py-0.5 rounded bg-emerald-600/30 text-emerald-400"
                >baixado</span>
              </div>
              <div class="flex items-center gap-3 mt-0.5">
                <span class="text-xs text-slate-500">{{ m.size_mb >= 1000 ? (m.size_mb/1000).toFixed(1)+'GB' : m.size_mb+'MB' }}</span>
                <span class="text-xs text-slate-600">·</span>
                <span class="text-xs text-slate-500">{{ m.speed }}</span>
                <span class="text-xs text-slate-600">·</span>
                <span class="text-xs text-slate-500">Qualidade: {{ m.quality }}</span>
              </div>
              <!-- Barra de progresso -->
              <div v-if="m.downloading" class="mt-2">
                <div class="flex items-center gap-2 mb-1">
                  <span class="text-xs text-indigo-400">Baixando... {{ Math.round(modelProgress[m.id] ?? 0) }}%</span>
                </div>
                <div class="w-full bg-slate-700 rounded-full h-1.5">
                  <div
                    class="bg-indigo-500 h-1.5 rounded-full transition-all duration-500"
                    :style="{ width: (modelProgress[m.id] ?? 0) + '%' }"
                  />
                </div>
              </div>
              <p v-if="modelError[m.id]" class="text-xs text-red-400 mt-1">{{ modelError[m.id] }}</p>
            </div>

            <!-- Ações -->
            <div class="flex items-center gap-2 flex-shrink-0">
              <button
                v-if="!m.downloaded && !m.downloading"
                class="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs rounded-lg transition-colors"
                @click="startDownload(m.id)"
              >
                Baixar
              </button>
              <button
                v-else-if="m.downloading"
                disabled
                class="px-3 py-1.5 bg-slate-700 text-slate-400 text-xs rounded-lg cursor-not-allowed"
              >
                Baixando...
              </button>
              <template v-else>
                <button
                  class="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs rounded-lg transition-colors"
                  @click="set({ model: m.id })"
                >
                  {{ store.settings?.model === m.id ? 'Selecionado' : 'Usar' }}
                </button>
                <button
                  v-if="store.settings?.model !== m.id"
                  class="p-1.5 text-slate-500 hover:text-red-400 transition-colors"
                  title="Remover modelo"
                  @click="removeModel(m.id)"
                >
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </template>
            </div>
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
          <p class="text-xs text-slate-600">Necessário após trocar o modelo ativo</p>
        </div>
      </section>

      <!-- TTS - meia largura -->
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

      <!-- Claude - largura total -->
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

      <!-- Sons - meia largura -->
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
