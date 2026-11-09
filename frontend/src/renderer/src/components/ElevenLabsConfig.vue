<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { fetchElevenLabsVoices, getElevenLabsUsage, type ElevenLabsUsage } from '../api'
import type { ElevenLabsVoice } from '../types'
import CustomSelect from './CustomSelect.vue'
import { useSettingsStore } from '../stores/settings'

const store = useSettingsStore()

const voices = ref<ElevenLabsVoice[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const apiKeyInput = ref(store.settings?.elevenlabs_api_key ?? '')
const showKey = ref(false)
const showGuide = ref(false)

// Créditos do mês (1 crédito ≈ 1 caractere falado)
const usage = ref<ElevenLabsUsage | null>(null)
const usageLoading = ref(false)

async function refreshUsage(): Promise<void> {
  const k = apiKeyInput.value.trim()
  if (!k) return
  usageLoading.value = true
  try {
    usage.value = await getElevenLabsUsage(k)
  } catch {
    usage.value = { ok: false, error: 'Não foi possível consultar' }
  } finally {
    usageLoading.value = false
  }
}

async function fetchVoices(): Promise<void> {
  const k = apiKeyInput.value.trim()
  if (!k) return
  loading.value = true
  error.value = null
  try {
    voices.value = await fetchElevenLabsVoices(k)
    if (k !== store.settings?.elevenlabs_api_key) await store.update({ elevenlabs_api_key: k })
    refreshUsage()
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : ''
    error.value = /401/.test(msg) ? 'Chave inválida - confira se copiou a chave inteira.' : msg || 'Erro ao buscar vozes'
  } finally {
    loading.value = false
  }
}

async function selectVoice(v: ElevenLabsVoice): Promise<void> {
  await store.update({ elevenlabs_voice_id: v.voice_id, elevenlabs_voice_name: v.name })
}

const voiceOptions = computed(() =>
  voices.value.map((v) => ({ value: v.voice_id, label: v.name, description: v.description ?? undefined }))
)

function onVoice(id: string): void {
  const v = voices.value.find((x) => x.voice_id === id)
  if (v) selectVoice(v)
}

const usagePct = computed(() => {
  const u = usage.value
  if (!u?.ok || !u.limit) return 0
  return Math.min(100, Math.round(((u.used ?? 0) / u.limit) * 100))
})

const resetDate = computed(() => {
  const t = usage.value?.reset_unix
  return t ? new Date(t * 1000).toLocaleDateString('pt-BR') : ''
})

function openSite(): void {
  window.open('https://elevenlabs.io', '_blank') // abre no navegador padrão
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && showGuide.value) showGuide.value = false
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
  if (apiKeyInput.value) fetchVoices()
})
onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="space-y-3 mt-2 p-4 bg-slate-800/50 rounded-xl border border-slate-700">
    <div class="flex items-center justify-between gap-2">
      <p class="text-sm font-medium text-slate-300">ElevenLabs</p>
      <button
        type="button"
        class="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
        @click="showGuide = true"
      >
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
        </svg>
        Como conseguir a chave?
      </button>
    </div>

    <div class="flex gap-2">
      <div class="relative flex-1">
        <input
          v-model="apiKeyInput"
          :type="showKey ? 'text' : 'password'"
          placeholder="Cole a sua API Key do ElevenLabs"
          autocomplete="off"
          spellcheck="false"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg pl-3 pr-16 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          @keydown.enter="fetchVoices"
        />
        <button
          type="button"
          class="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-slate-500 hover:text-slate-300"
          @click="showKey = !showKey"
        >{{ showKey ? 'ocultar' : 'mostrar' }}</button>
      </div>
      <button
        :disabled="loading || !apiKeyInput.trim()"
        class="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-sm transition-colors"
        @click="fetchVoices"
      >
        {{ loading ? '...' : 'Salvar e buscar vozes' }}
      </button>
    </div>
    <p v-if="error" class="text-xs text-red-400">{{ error }}</p>

    <!-- Créditos do mês -->
    <div v-if="usage" class="rounded-lg bg-slate-900/60 border border-slate-800 px-3 py-2.5 flex flex-col gap-1.5">
      <template v-if="usage.ok">
        <div class="flex items-center gap-2 text-xs">
          <span class="text-slate-400">Créditos restantes este mês:</span>
          <span :class="['font-semibold tabular-nums', usagePct >= 90 ? 'text-amber-400' : 'text-slate-100']">
            {{ (usage.remaining ?? 0).toLocaleString('pt-BR') }}
          </span>
          <span class="text-slate-600">de {{ (usage.limit ?? 0).toLocaleString('pt-BR') }}</span>
          <span v-if="usage.tier" class="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 uppercase">{{ usage.tier }}</span>
          <button
            type="button"
            title="Atualizar"
            :disabled="usageLoading"
            class="ml-auto p-1 rounded-md text-slate-500 hover:text-slate-200 disabled:opacity-40"
            @click="refreshUsage"
          >
            <svg :class="['w-3.5 h-3.5', usageLoading ? 'animate-spin' : '']" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
            </svg>
          </button>
        </div>
        <div class="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
          <div
            :class="['h-1.5 rounded-full', usagePct >= 90 ? 'bg-amber-400' : 'bg-indigo-500']"
            :style="{ width: usagePct + '%' }"
          />
        </div>
        <p class="text-[11px] text-slate-600">
          1 crédito ≈ 1 letra falada. <template v-if="resetDate">Renova em {{ resetDate }}.</template>
        </p>
      </template>
      <p v-else class="text-xs text-slate-500">
        Créditos: <span class="text-amber-400">{{ usage.error }}</span>
      </p>
    </div>

    <div v-if="voices.length" class="flex flex-col gap-1.5">
      <label class="text-xs text-slate-500">Voz</label>
      <CustomSelect
        :model-value="store.settings?.elevenlabs_voice_id"
        :options="voiceOptions"
        placeholder="Escolha uma voz"
        @update:model-value="onVoice"
      />
    </div>

    <!-- Guia: como criar a chave do ElevenLabs -->
    <Teleport to="body">
      <div
        v-if="showGuide"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-6"
        @click.self="showGuide = false"
      >
        <div class="w-full max-w-lg bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl flex flex-col max-h-full">
          <div class="flex items-center justify-between px-5 pt-5 pb-3">
            <div>
              <h3 class="text-base font-semibold text-slate-100">Como usar as vozes do ElevenLabs</h3>
              <p class="text-xs text-slate-500 mt-0.5">Vozes mais naturais que a do Edge. Dá para começar de graça.</p>
            </div>
            <button class="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10" title="Fechar" @click="showGuide = false">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div class="px-5 pb-2 overflow-y-auto flex flex-col gap-4 text-sm text-slate-300">
            <ol class="flex flex-col gap-3">
              <li class="flex gap-3">
                <span class="step">1</span>
                <div>
                  <p class="text-slate-200">Acesse <button class="text-indigo-400 hover:text-indigo-300 underline underline-offset-2" @click="openSite">elevenlabs.io</button> e crie uma conta grátis</p>
                  <p class="text-xs text-slate-500 mt-0.5">Clique em <span class="text-slate-300">Sign up</span> e entre com o Google ou com e-mail. Não pede cartão no plano grátis.</p>
                </div>
              </li>
              <li class="flex gap-3">
                <span class="step">2</span>
                <div>
                  <p class="text-slate-200">Crie uma chave de API</p>
                  <p class="text-xs text-slate-500 mt-0.5">
                    No painel, abra a área de <span class="text-slate-300">Developers</span> →
                    <span class="text-slate-300">API Keys</span> e clique em <span class="text-slate-300">Create API Key</span>.
                    Se aparecerem permissões, deixe ativas <span class="text-slate-300">Text to Speech</span>,
                    <span class="text-slate-300">Voices (Read)</span> e <span class="text-slate-300">User (Read)</span> -
                    a última é a que deixa o app mostrar quantos créditos sobram.
                  </p>
                </div>
              </li>
              <li class="flex gap-3">
                <span class="step">3</span>
                <div>
                  <p class="text-slate-200">Copie a chave e cole aqui</p>
                  <p class="text-xs text-slate-500 mt-0.5">
                    A chave aparece só uma vez no site - copie inteira. Depois clique em
                    <span class="text-slate-300">“Salvar e buscar vozes”</span>.
                  </p>
                </div>
              </li>
              <li class="flex gap-3">
                <span class="step">4</span>
                <div>
                  <p class="text-slate-200">Escolha uma voz</p>
                  <p class="text-xs text-slate-500 mt-0.5">
                    Clique numa das vozes da lista e selecione <span class="text-slate-300">ElevenLabs</span> como síntese de voz.
                    As vozes "multilingual" falam bem em português.
                  </p>
                </div>
              </li>
            </ol>

            <div class="rounded-xl bg-slate-950/70 border border-slate-800 px-3.5 py-3 text-xs text-slate-400 leading-relaxed flex flex-col gap-1">
              <p>
                <span class="text-slate-200">Quanto vem de graça?</span> O plano grátis dá cerca de
                <span class="text-emerald-400">10.000 créditos por mês</span> (1 crédito ≈ 1 letra, uns 10 minutos de fala).
                Os créditos renovam todo mês e não acumulam.
              </p>
              <p><span class="text-slate-200">E se acabar?</span> A voz volta sozinha para o Edge (grátis) até renovar - ou você assina um plano no site.</p>
              <p><span class="text-slate-200">Uso comercial</span> não está incluso no plano grátis.</p>
              <p class="text-slate-600">Valores do site do ElevenLabs em novembro/2026; confira lá se mudaram.</p>
            </div>
          </div>

          <div class="flex justify-end gap-2 px-5 py-4">
            <button
              class="px-3.5 py-2 rounded-lg text-xs border border-slate-700 hover:border-slate-500 text-slate-300 transition-colors"
              @click="openSite"
            >Abrir elevenlabs.io</button>
            <button
              class="px-3.5 py-2 rounded-lg text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
              @click="showGuide = false"
            >Entendi</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.step {
  flex-shrink: 0;
  width: 1.5rem;
  height: 1.5rem;
  border-radius: 9999px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.75rem;
  font-weight: 600;
  color: rgb(165 180 252);
  background: rgb(99 102 241 / 0.15);
  border: 1px solid rgb(99 102 241 / 0.4);
}
</style>
