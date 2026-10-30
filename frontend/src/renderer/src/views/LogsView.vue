<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useLogsStore } from '../stores/logs'
import { onWsMessage } from '../api/ws'
import type { LogEntry } from '../types'
import CopyButton from '../components/CopyButton.vue'

const store = useLogsStore()
const offset = ref(0)
const expandedId = ref<number | null>(null)
const confirmClear = ref(false)

onMounted(async () => {
  await store.fetchPage(0)
})

const unsub = onWsMessage((event) => {
  if (event.type === 'log_added' && event.entry) {
    store.prependEntry(event.entry)
  }
})

onUnmounted(() => unsub())

async function prevPage(): Promise<void> {
  offset.value = Math.max(0, offset.value - store.limit)
  await store.fetchPage(offset.value)
}

async function nextPage(): Promise<void> {
  offset.value += store.limit
  await store.fetchPage(offset.value)
}

async function doClear(): Promise<void> {
  await store.clear()
  confirmClear.value = false
  offset.value = 0
}

function fmtTime(ts: string): string {
  return new Date(ts).toLocaleString('pt-BR', { hour12: false, dateStyle: 'short', timeStyle: 'medium' })
}

function fmtNum(n: number, dec = 2): string {
  return n?.toFixed(dec) ?? '—'
}

function toggleExpand(entry: LogEntry): void {
  expandedId.value = expandedId.value === entry.id ? null : entry.id
}
</script>

<template>
  <div class="flex flex-col gap-4 h-full">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-xl font-semibold text-slate-100">Logs</h1>
        <p class="text-sm text-slate-500 mt-1">{{ store.total }} transcrições registradas</p>
      </div>
      <div class="flex gap-2">
        <button
          v-if="!confirmClear"
          class="px-3 py-1.5 text-sm text-slate-400 hover:text-red-400 border border-slate-700 hover:border-red-700/60 rounded-lg transition-colors"
          @click="confirmClear = true"
        >
          Limpar tudo
        </button>
        <template v-else>
          <button class="px-3 py-1.5 text-sm text-red-400 border border-red-700/60 rounded-lg" @click="doClear">Confirmar</button>
          <button class="px-3 py-1.5 text-sm text-slate-400 border border-slate-700 rounded-lg" @click="confirmClear = false">Cancelar</button>
        </template>
      </div>
    </div>

    <div class="flex-1 overflow-auto">
      <table class="w-full text-sm border-collapse">
        <thead>
          <tr class="text-left text-slate-500 text-xs uppercase tracking-wide">
            <th class="pb-2 pr-3 font-medium">Hora</th>
            <th class="pb-2 pr-3 font-medium">Modo</th>
            <th class="pb-2 pr-3 font-medium">Modelo</th>
            <th class="pb-2 pr-3 font-medium">Áudio</th>
            <th class="pb-2 pr-3 font-medium">RTF</th>
            <th class="pb-2 font-medium">Texto</th>
            <th class="pb-2 w-8"></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="entry in store.items" :key="entry.id">
            <tr
              class="border-t border-slate-800 hover:bg-slate-800/40 cursor-pointer transition-colors"
              @click="toggleExpand(entry)"
            >
              <td class="py-2 pr-3 text-slate-500 whitespace-nowrap text-xs">{{ fmtTime(entry.ts) }}</td>
              <td class="py-2 pr-3">
                <span :class="[
                  'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium',
                  entry.mode === 'ai'
                    ? 'bg-purple-500/20 text-purple-400'
                    : 'bg-emerald-500/20 text-emerald-400'
                ]">
                  {{ entry.mode === 'ai' ? 'IA' : 'Transcrição' }}
                </span>
              </td>
              <td class="py-2 pr-3 text-slate-400 text-xs">{{ entry.model }}</td>
              <td class="py-2 pr-3 text-slate-400 text-xs">{{ fmtNum(entry.audio_s, 1) }}s</td>
              <td class="py-2 pr-3 text-slate-400 text-xs">{{ fmtNum(entry.rtf, 3) }}</td>
              <td class="py-2 text-slate-300 max-w-xs truncate">{{ entry.text }}</td>
              <td class="py-2">
                <CopyButton :text="entry.ai_response ? `${entry.text}\n\nIA: ${entry.ai_response}` : entry.text" size="sm" />
              </td>
            </tr>
            <tr v-if="expandedId === entry.id" class="bg-slate-800/30">
              <td colspan="7" class="px-4 py-3">
                <div class="flex items-start justify-between gap-2 mb-1">
                  <p class="text-slate-300 text-sm whitespace-pre-wrap">{{ entry.text }}</p>
                  <CopyButton :text="entry.text" />
                </div>
                <div v-if="entry.ai_response" class="border-t border-slate-700 pt-2 mt-2">
                  <div class="flex items-start justify-between gap-2">
                    <p class="text-slate-400 text-xs whitespace-pre-wrap">
                      <span class="text-purple-400 font-medium">Resposta IA: </span>{{ entry.ai_response }}
                    </p>
                    <CopyButton :text="entry.ai_response" size="sm" />
                  </div>
                </div>
              </td>
            </tr>
          </template>
          <tr v-if="!store.items.length && !store.loading">
            <td colspan="6" class="py-12 text-center text-slate-600">Nenhum log ainda</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="store.total > store.limit" class="flex items-center justify-between text-sm text-slate-500 border-t border-slate-800 pt-3">
      <span>{{ offset + 1 }}–{{ Math.min(offset + store.limit, store.total) }} de {{ store.total }}</span>
      <div class="flex gap-2">
        <button
          :disabled="offset === 0"
          class="px-3 py-1 border border-slate-700 rounded-lg disabled:opacity-30 hover:bg-slate-800 transition-colors"
          @click="prevPage"
        >
          ←
        </button>
        <button
          :disabled="offset + store.limit >= store.total"
          class="px-3 py-1 border border-slate-700 rounded-lg disabled:opacity-30 hover:bg-slate-800 transition-colors"
          @click="nextPage"
        >
          →
        </button>
      </div>
    </div>
  </div>
</template>
