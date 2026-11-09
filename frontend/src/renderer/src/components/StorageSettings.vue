<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { clearAllSpeechCache, clearChatSpeechCache, deleteWhisperModel, getStorage } from '../api'
import { useSettingsStore } from '../stores/settings'
import { useChatStore } from '../stores/chat'
import type { StorageInfo } from '../types'
import ConfirmModal from './ConfirmModal.vue'
import CustomSelect from './CustomSelect.vue'

/** Quanto o app ocupa no disco e o que dá para apagar. */
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
    { key: 'audio', label: 'Áudios salvos', bytes: i.speech_cache.bytes, color: 'bg-purple-500' },
    { key: 'db', label: 'Conversas e logs', bytes: i.database.bytes, color: 'bg-emerald-500' }
  ]
})
const total = computed(() => parts.value.reduce((a, p) => a + p.bytes, 0))

async function setLimit(v: string): Promise<void> {
  await settings.update({ speech_cache_limit_mb: Number(v) })
  if (info.value) info.value.speech_cache.limit_mb = Number(v)
}

// ---------- apagar (sempre com confirmação) ----------
type Pending = { kind: 'audio-all' } | { kind: 'audio-chat'; id: number; name: string } | { kind: 'model'; id: string; name: string; bytes: number }
const pending = ref<Pending | null>(null)

const confirmTitle = computed(() => {
  const p = pending.value
  if (!p) return ''
  if (p.kind === 'audio-all') return 'Apagar todos os áudios salvos?'
  if (p.kind === 'audio-chat') return `Apagar os áudios salvos de "${p.name}"?`
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

    <div v-if="info" class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <!-- áudios salvos -->
      <div class="rounded-xl border border-slate-700/50 bg-slate-900/40 p-4 flex flex-col gap-3">
        <div class="flex items-start justify-between gap-3">
          <div>
            <p class="text-sm text-slate-100 font-medium">Áudios salvos do Chat IA</p>
            <p class="text-xs text-slate-500 mt-0.5">
              As respostas faladas ficam guardadas para o "ouvir de novo" ser instantâneo. Passando do limite, as mais
              antigas saem para dar lugar às novas.
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
        <div v-if="info.speech_cache.chats.length" class="flex flex-col gap-1">
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
          class="self-start px-3 py-1.5 rounded-lg text-xs border border-slate-700 hover:border-red-700/60 hover:text-red-300 text-slate-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          @click="pending = { kind: 'audio-all' }"
        >Apagar todos os áudios</button>
      </div>

      <!-- modelos de voz -->
      <div class="rounded-xl border border-slate-700/50 bg-slate-900/40 p-4 flex flex-col gap-3">
        <div class="flex items-start justify-between gap-3">
          <div>
            <p class="text-sm text-slate-100 font-medium">Modelos de reconhecimento de voz</p>
            <p class="text-xs text-slate-500 mt-0.5">
              Modelos baixados do Whisper. Apague os que não usa (ex.: os baixados só para testar); dá para baixar de novo depois.
            </p>
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

      <!-- outros -->
      <div class="lg:col-span-2 rounded-xl border border-slate-700/50 bg-slate-900/40 p-4 grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <p class="text-xs text-slate-400">Pacotes de tradução</p>
          <p class="text-sm font-semibold text-slate-100 tabular-nums">{{ fmt(info.translation.bytes) }}</p>
          <p class="text-[11px] text-slate-500 mt-0.5">{{ info.translation.count }} pacote{{ info.translation.count === 1 ? '' : 's' }} instalado{{ info.translation.count === 1 ? '' : 's' }} · gerencie na aba Tradutor</p>
        </div>
        <div>
          <p class="text-xs text-slate-400">Conversas e logs</p>
          <p class="text-sm font-semibold text-slate-100 tabular-nums">{{ fmt(info.database.bytes) }}</p>
          <p class="text-[11px] text-slate-500 mt-0.5">Mensagens dos chats, histórico de transcrições e configurações</p>
        </div>
        <div>
          <p class="text-xs text-slate-400">Bibliotecas do app</p>
          <p class="text-sm font-semibold text-slate-100 tabular-nums">{{ fmt(info.libraries.bytes) }}</p>
          <p class="text-[11px] text-slate-500 mt-0.5">Python e componentes (incluindo os de placa de vídeo). Necessárias para o app funcionar</p>
        </div>
      </div>
    </div>

    <ConfirmModal
      :open="pending !== null"
      :title="confirmTitle"
      :confirm-label="pending?.kind === 'model' ? 'Apagar modelo' : 'Apagar áudios'"
      :tone="pending?.kind === 'model' ? 'danger' : 'warning'"
      :loading="busy"
      @confirm="confirm"
      @cancel="pending = null"
    >
      <template v-if="pending?.kind === 'model'">
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
