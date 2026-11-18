<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { clearAllSpeechCache, clearChatSpeechCache, deleteWhisperModel, getStorage, getStorageLibraries, removeTranslatePackage, deleteAllFileTranslations } from '../api'
import { useSettingsStore } from '../stores/settings'
import { useChatStore } from '../stores/chat'
import type { LibraryUsage, StorageInfo } from '../types'
import ConfirmModal from './ConfirmModal.vue'
import CustomSelect from './CustomSelect.vue'

/** Quanto o app ocupa no disco e o que dá para apagar (o detalhe aparece só com `detailed`). */
defineProps<{ detailed?: boolean }>()
const settings = useSettingsStore()
const chatStore = useChatStore()
const info = ref<StorageInfo | null>(null)
const loading = ref(false)
const busy = ref(false)

const LIMITS = [20, 50, 100, 200, 500].map((v) => ({
  value: String(v),
  label: `${v} MB por chat`,
  description: v === 20 ? 'Padrão' : undefined
}))

async function load(): Promise<void> {
  loading.value = true
  try {
    info.value = await getStorage()
  } finally {
    loading.value = false
  }
}
onMounted(load)

function fmt(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2).replace('.', ',')} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1).replace('.', ',')} MB`
  if (bytes > 0) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return '0 MB'
}

const modelsBytes = computed(() => info.value?.models.reduce((a, m) => a + m.bytes, 0) ?? 0)
const parts = computed(() => {
  const i = info.value
  if (!i) return []
  return [
    { key: 'libs', label: 'Bibliotecas do app', bytes: i.libraries.bytes, color: 'bg-slate-500' },
    { key: 'models', label: 'Modelos de voz', bytes: modelsBytes.value, color: 'bg-indigo-500' },
    { key: 'translation', label: 'Pacotes de tradução', bytes: i.translation.bytes, color: 'bg-sky-500' },
    { key: 'files', label: 'Arquivos traduzidos', bytes: i.translated_files?.bytes ?? 0, color: 'bg-cyan-300' },
    { key: 'audio', label: 'Áudios salvos', bytes: i.speech_cache.bytes, color: 'bg-purple-500' },
    { key: 'db', label: 'Conversas e logs', bytes: i.database.bytes, color: 'bg-emerald-500' }
  ]
})
const total = computed(() => parts.value.reduce((a, p) => a + p.bytes, 0))

// nomes dos idiomas em português ("pb" é o código do tradutor para português do Brasil)
const langNames = new Intl.DisplayNames(['pt-BR'], { type: 'language' })
function lang(code: string, fallback: string): string {
  try {
    const name = langNames.of(code === 'pb' ? 'pt-BR' : code === 'zt' ? 'zh-Hant' : code)
    return name && name !== code ? name.charAt(0).toUpperCase() + name.slice(1) : fallback || code
  } catch {
    return fallback || code
  }
}
const translationPackages = computed(() =>
  (info.value?.translation.packages ?? []).map((p) => ({
    ...p,
    label: `${lang(p.from_code, p.from_name)} → ${lang(p.to_code, p.to_name)}`
  }))
)

// ---------- bibliotecas: o que ocupa o espaço ----------
const libsOpen = ref(false)
const libs = ref<LibraryUsage[] | null>(null)
const libsError = ref('')
async function openLibraries(): Promise<void> {
  libsOpen.value = true
  if (libs.value) return
  libsError.value = ''
  try {
    libs.value = await getStorageLibraries()
  } catch {
    libsError.value = 'Não foi possível ler as bibliotecas. Feche e abra o app de novo e tente outra vez.'
  }
}
const libsMax = computed(() => libs.value?.[0]?.bytes || 1)

async function setLimit(v: string): Promise<void> {
  await settings.update({ speech_cache_limit_mb: Number(v) })
  if (info.value) info.value.speech_cache.limit_mb = Number(v)
}

// ---------- apagar (sempre com confirmação) ----------
type Pending =
  | { kind: 'audio-all' }
  | { kind: 'audio-chat'; id: number; name: string }
  | { kind: 'model'; id: string; name: string; bytes: number }
  | { kind: 'translation'; from: string; to: string; name: string; bytes: number }
  | { kind: 'translated-files'; bytes: number }
const pending = ref<Pending | null>(null)

const confirmTitle = computed(() => {
  const p = pending.value
  if (!p) return ''
  if (p.kind === 'audio-all') return 'Apagar todos os áudios salvos?'
  if (p.kind === 'audio-chat') return `Apagar os áudios salvos de "${p.name}"?`
  if (p.kind === 'translation') return `Apagar o pacote ${p.name}?`
  if (p.kind === 'translated-files') return 'Apagar os arquivos traduzidos?'
  return `Apagar o modelo ${p.name}?`
})

async function confirm(): Promise<void> {
  const p = pending.value
  if (!p) return
  busy.value = true
  try {
    if (p.kind === 'audio-all') {
      await clearAllSpeechCache()
      chatStore.resetAudioPct(null)
    } else if (p.kind === 'audio-chat') {
      await clearChatSpeechCache(p.id)
      chatStore.resetAudioPct(p.id)
    }
    else if (p.kind === 'translation') await removeTranslatePackage(p.from, p.to)
    else if (p.kind === 'translated-files') await deleteAllFileTranslations()
    else await deleteWhisperModel(p.id)
    await load()
  } finally {
    busy.value = false
    pending.value = null
  }
}
</script>

<template>
  <div class="flex flex-col gap-5">
    <!-- total + barra por tipo -->
    <div class="flex flex-col gap-2">
      <div class="flex items-end justify-between gap-3">
        <div>
          <p class="text-xs text-slate-500">Espaço usado pelo app neste computador</p>
          <p class="text-2xl font-semibold text-slate-100 tabular-nums">{{ info ? fmt(total) : '...' }}</p>
        </div>
        <button
          :disabled="loading"
          class="text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-50"
          @click="load"
        >{{ loading ? 'calculando...' : 'atualizar' }}</button>
      </div>
      <div v-if="info && total" class="h-2.5 rounded-full bg-slate-800 overflow-hidden flex">
        <div
          v-for="p in parts.filter((x) => x.bytes > 0)"
          :key="p.key"
          :class="p.color"
          :style="{ width: `${(p.bytes / total) * 100}%` }"
          :title="`${p.label}: ${fmt(p.bytes)}`"
        />
      </div>
      <div v-if="info" class="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
        <span v-for="p in parts" :key="p.key" class="flex items-center gap-1.5">
          <span :class="['w-2 h-2 rounded-full', p.color]" />{{ p.label }} <span class="text-slate-500 tabular-nums">{{ fmt(p.bytes) }}</span>
        </span>
      </div>
    </div>

    <div v-if="info && detailed" class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <!-- áudios salvos -->
      <div class="rounded-xl border border-slate-700/50 bg-slate-900/40 p-4 flex flex-col gap-3">
        <div class="flex items-start justify-between gap-3">
          <div>
            <p class="text-sm text-slate-100 font-medium">Áudios salvos do Chat IA</p>
            <p class="text-xs text-slate-500 mt-0.5">
              Guardados para o "ouvir de novo" ser instantâneo. Passando do limite, os mais antigos saem.
            </p>
          </div>
          <span class="text-sm font-semibold text-slate-100 tabular-nums whitespace-nowrap">{{ fmt(info.speech_cache.bytes) }}</span>
        </div>
        <div class="flex items-center gap-3">
          <span class="text-xs text-slate-500">Limite</span>
          <CustomSelect
            class="w-48"
            size="sm"
            :model-value="String(settings.settings?.speech_cache_limit_mb ?? info.speech_cache.limit_mb)"
            :options="LIMITS"
            @update:model-value="setLimit"
          />
        </div>
        <div v-if="info.speech_cache.chats.length" class="flex flex-col gap-1 max-h-48 overflow-y-auto">
          <div
            v-for="c in info.speech_cache.chats"
            :key="c.chat_id"
            class="flex items-center gap-3 text-xs px-2 py-1.5 rounded-lg hover:bg-slate-800/50"
          >
            <span class="flex-1 truncate text-slate-300">{{ c.name }}</span>
            <span class="text-slate-500 tabular-nums">{{ c.messages }} resposta{{ c.messages === 1 ? '' : 's' }}</span>
            <span class="text-slate-300 tabular-nums w-16 text-right">{{ fmt(c.bytes) }}</span>
            <button
              title="Apagar os áudios salvos deste chat"
              class="text-slate-500 hover:text-red-400 transition-colors"
              @click="pending = { kind: 'audio-chat', id: c.chat_id, name: c.name }"
            >Apagar</button>
          </div>
        </div>
        <p v-else class="text-xs text-slate-600">Nenhum áudio salvo ainda.</p>
        <button
          :disabled="!info.speech_cache.bytes"
          class="self-center mt-auto px-4 py-1.5 rounded-lg text-xs border border-slate-700 hover:border-red-700/60 hover:text-red-300 text-slate-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          @click="pending = { kind: 'audio-all' }"
        >Apagar todos os áudios</button>
      </div>

      <!-- modelos de voz -->
      <div class="rounded-xl border border-slate-700/50 bg-slate-900/40 p-4 flex flex-col gap-3">
        <div class="flex items-start justify-between gap-3">
          <div>
            <p class="text-sm text-slate-100 font-medium">Modelos de reconhecimento de voz</p>
            <p class="text-xs text-slate-500 mt-0.5">Apague os que não usa; dá para baixar de novo depois.</p>
          </div>
          <span class="text-sm font-semibold text-slate-100 tabular-nums whitespace-nowrap">{{ fmt(modelsBytes) }}</span>
        </div>
        <div class="flex flex-col gap-1">
          <div v-for="m in info.models" :key="m.id" class="flex items-center gap-3 text-xs px-2 py-1.5 rounded-lg hover:bg-slate-800/50">
            <span class="flex-1 truncate text-slate-300">
              {{ m.name }}
              <span v-if="m.active" class="ml-1.5 text-[10px] px-1.5 py-px rounded bg-emerald-500/15 text-emerald-300">em uso</span>
            </span>
            <span class="text-slate-300 tabular-nums w-16 text-right">{{ fmt(m.bytes) }}</span>
            <button
              :disabled="m.active"
              :title="m.active ? 'Este é o modelo em uso: troque de modelo antes de apagar' : 'Apagar este modelo do computador'"
              class="text-slate-500 hover:text-red-400 transition-colors disabled:opacity-30 disabled:hover:text-slate-500"
              @click="pending = { kind: 'model', id: m.id, name: m.name, bytes: m.bytes }"
            >Apagar</button>
          </div>
          <p v-if="!info.models.length" class="text-xs text-slate-600">Nenhum modelo baixado.</p>
        </div>
      </div>

      <!-- pacotes de tradução -->
      <div class="rounded-xl border border-slate-700/50 bg-slate-900/40 p-4 flex flex-col gap-3">
        <div class="flex items-start justify-between gap-3">
          <div>
            <p class="text-sm text-slate-100 font-medium">Pacotes de tradução</p>
            <p class="text-xs text-slate-500 mt-0.5">Cada pacote traduz de um idioma para outro. Instale de novo na aba Tradutor.</p>
          </div>
          <span class="text-sm font-semibold text-slate-100 tabular-nums whitespace-nowrap">{{ fmt(info.translation.bytes) }}</span>
        </div>
        <div class="flex flex-col gap-1">
          <div v-for="p in translationPackages" :key="p.name" class="flex items-center gap-3 text-xs px-2 py-1.5 rounded-lg hover:bg-slate-800/50">
            <span class="flex-1 truncate text-slate-300">{{ p.label }}</span>
            <span class="text-slate-300 tabular-nums w-16 text-right">{{ fmt(p.bytes) }}</span>
            <button
              title="Apagar este pacote do computador"
              class="text-slate-500 hover:text-red-400 transition-colors"
              @click="pending = { kind: 'translation', from: p.from_code, to: p.to_code, name: p.label, bytes: p.bytes }"
            >Apagar</button>
          </div>
          <p v-if="!translationPackages.length" class="text-xs text-slate-600">Nenhum pacote instalado.</p>
        </div>
        <div
          v-if="info.translated_files?.count"
          class="flex items-center gap-3 text-xs px-2 pt-2.5 border-t border-slate-700/40"
        >
          <span class="flex-1 truncate text-slate-300">
            Arquivos traduzidos
            <span class="text-slate-500">· {{ info.translated_files.count }} {{ info.translated_files.count === 1 ? 'arquivo' : 'arquivos' }}</span>
          </span>
          <span class="text-slate-300 tabular-nums w-16 text-right">{{ fmt(info.translated_files.bytes) }}</span>
          <button
            title="Apagar as cópias traduzidas guardadas pelo app"
            class="text-slate-500 hover:text-red-400 transition-colors"
            @click="pending = { kind: 'translated-files', bytes: info.translated_files.bytes }"
          >Apagar</button>
        </div>
      </div>

      <!-- bibliotecas e conversas -->
      <div class="rounded-xl border border-slate-700/50 bg-slate-900/40 p-4 flex flex-col gap-4">
        <div class="flex items-start justify-between gap-3">
          <div>
            <p class="text-sm text-slate-100 font-medium">Bibliotecas do app</p>
            <p class="text-xs text-slate-500 mt-0.5">
              Python e os componentes do Whisper, do tradutor e da placa de vídeo. Necessárias para o app funcionar.
            </p>
          </div>
          <span class="text-sm font-semibold text-slate-100 tabular-nums whitespace-nowrap">{{ fmt(info.libraries.bytes) }}</span>
        </div>
        <button
          class="self-start px-3 py-1.5 rounded-lg text-xs border border-slate-700 hover:border-indigo-500/60 text-slate-300 hover:text-white transition-colors"
          @click="openLibraries"
        >Ver o que ocupa esse espaço</button>
        <div class="flex items-start justify-between gap-3 pt-3 border-t border-slate-700/40">
          <div>
            <p class="text-sm text-slate-100 font-medium">Conversas e logs</p>
            <p class="text-xs text-slate-500 mt-0.5">Mensagens dos chats, histórico de transcrições e configurações</p>
          </div>
          <span class="text-sm font-semibold text-slate-100 tabular-nums whitespace-nowrap">{{ fmt(info.database.bytes) }}</span>
        </div>
      </div>
    </div>

    <!-- o que ocupa as bibliotecas -->
    <Teleport to="body">
      <div
        v-if="libsOpen"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-6"
        @click.self="libsOpen = false"
      >
        <div class="w-full max-w-2xl max-h-full bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl flex flex-col">
          <div class="flex items-start justify-between gap-4 p-5 pb-3">
            <div>
              <h3 class="text-base font-semibold text-slate-100">Bibliotecas do app</h3>
              <p class="text-xs text-slate-500 mt-1">
                Da maior para a menor. A maior parte é da NVIDIA e do PyTorch: é o que faz o Whisper e o tradutor rodarem
                rápido na placa de vídeo.
              </p>
            </div>
            <button class="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors" title="Fechar" @click="libsOpen = false">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div class="flex-1 min-h-0 overflow-y-auto px-5 pb-5">
            <p v-if="libsError" class="text-sm text-red-400 py-6 text-center">{{ libsError }}</p>
            <div v-else-if="!libs" class="flex items-center justify-center gap-2.5 py-8 text-sm text-slate-400">
              <span class="w-4 h-4 rounded-full border-2 border-slate-600 border-t-indigo-400 animate-spin" />
              Lendo as bibliotecas…
            </div>
            <div v-else class="flex flex-col">
              <div v-for="l in libs" :key="l.name" class="flex items-center gap-4 py-2 border-b border-slate-800 last:border-0">
                <div class="flex-1 min-w-0">
                  <p class="text-sm text-slate-200 font-mono truncate">{{ l.name }}</p>
                  <p v-if="l.description" class="text-xs text-slate-500 truncate">{{ l.description }}</p>
                </div>
                <div class="w-24 h-1.5 rounded-full bg-slate-800 overflow-hidden flex-shrink-0">
                  <div class="h-full bg-indigo-500/80 rounded-full" :style="{ width: `${Math.max(2, (l.bytes / libsMax) * 100)}%` }" />
                </div>
                <span class="w-20 text-right text-xs text-slate-300 tabular-nums flex-shrink-0">{{ fmt(l.bytes) }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <ConfirmModal
      :open="pending !== null"
      :title="confirmTitle"
      :confirm-label="pending?.kind === 'model' ? 'Apagar modelo' : pending?.kind === 'translation' ? 'Apagar pacote' : pending?.kind === 'translated-files' ? 'Apagar arquivos' : 'Apagar áudios'"
      :tone="pending?.kind === 'model' || pending?.kind === 'translation' ? 'danger' : 'warning'"
      :loading="busy"
      @confirm="confirm"
      @cancel="pending = null"
    >
      <template v-if="pending?.kind === 'translated-files'">
        <p>Libera {{ fmt(pending.bytes) }} no disco. Apaga as cópias guardadas pelo app (original e traduzido); os arquivos que você salvou em outra pasta continuam lá.</p>
      </template>
      <template v-else-if="pending?.kind === 'translation'">
        <p>Libera {{ fmt(pending.bytes) }} no disco. O Tradutor deixa de traduzir nessa direção até você instalar o pacote de novo.</p>
      </template>
      <template v-else-if="pending?.kind === 'model'">
        <p>Libera {{ fmt(pending.bytes) }} no disco. Se quiser usar este modelo de novo, é só baixar outra vez em Reconhecimento de voz.</p>
      </template>
      <template v-else>
        <p>Só os <span class="text-slate-100">arquivos de áudio</span> das respostas são apagados. As mensagens continuam nos chats.</p>
        <p class="text-xs text-slate-400 mt-1.5">
          Se você der play de novo numa resposta, o áudio é gerado outra vez pelo serviço de voz: funciona normalmente,
          só usa a internet e leva alguns segundos para começar.
        </p>
      </template>
    </ConfirmModal>
  </div>
</template>
