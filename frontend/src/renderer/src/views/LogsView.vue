<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useLogsStore } from '../stores/logs'
import { onWsMessage } from '../api/ws'
import type { LogEntry } from '../types'
import CopyButton from '../components/CopyButton.vue'

const store = useLogsStore()

/** Links das imagens/vídeos da resposta, um por linha (para o botão de copiar). */
function mediaLinks(entry: LogEntry): string {
  return (entry.media ?? []).flatMap((g) => g.items.map((it) => it.url)).join('\n')
}

function copyText(entry: LogEntry): string {
  let t = entry.text
  if (entry.ai_response) t += `\n\nIA: ${entry.ai_response}`
  const links = mediaLinks(entry)
  if (links) t += `\n\n${links}`
  return t
}
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

/** 9,0 s · 56,4 s · 3min 37s */
function fmtDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || isNaN(sec)) return '-'
  if (sec < 60) return `${sec.toFixed(1).replace('.', ',')} s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return s === 60 ? `${m + 1}min 00s` : `${m}min ${String(s).padStart(2, '0')}s`
}

/** quantas vezes mais rápido que o tempo falado (rtf = duração do áudio / tempo de processamento) */
function fmtSpeed(rtf: number | null | undefined): string {
  if (!rtf) return '-'
  return `${rtf >= 10 ? Math.round(rtf) : rtf.toFixed(1).replace('.', ',')}x`
}

function deviceLabel(device: string): string {
  return device === 'cuda' ? 'Placa de vídeo' : device === 'cpu' ? 'Processador' : device
}

function deviceTitle(entry: LogEntry): string {
  const lines = [
    entry.device === 'cuda'
      ? 'Processado na placa de vídeo (GPU NVIDIA)'
      : 'Processado no processador (CPU), mais lento que a placa de vídeo',
    `Precisão: ${entry.compute_type}`
  ]
  if (entry.method) lines.push(`Modo: ${entry.method}`)
  return lines.join('\n')
}

// Explicação de cada coluna (aparece ao passar o mouse no cabeçalho)
const COLUMN_HELP: Record<string, string> = {
  hora: 'Data e hora em que a transcrição terminou',
  modo: 'De onde veio o áudio:\nMicrofone = gravação pelo atalho de transcrição\nIA = gravação pelo atalho de IA (pergunta para o Claude)\nArquivo = arquivo transcrito na aba Transcrever',
  modelo: 'Modelo do Whisper usado para transformar a fala em texto (maiores são mais precisos e mais pesados)',
  device: 'Onde a transcrição rodou: placa de vídeo (GPU, rápido) ou processador (CPU, lento).\nPasse o mouse no item da linha para ver o modo usado (lote, sem silêncios, durante a fala)',
  audio: 'Duração do áudio gravado',
  proc: 'Quanto tempo levou para transformar o áudio em texto, depois de soltar a tecla (no modo "durante a fala", só o que faltou depois de soltar)',
  speed: 'Quantas vezes mais rápido que o tempo falado. Ex.: 18x = 1 minuto de áudio transcrito em ~3 segundos',
  texto: 'Texto transcrito. Clique na linha para ver tudo e a resposta da IA'
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
            <th class="pb-2 pr-3 font-medium cursor-help" :title="COLUMN_HELP.hora">Hora</th>
            <th class="pb-2 pr-3 font-medium cursor-help" :title="COLUMN_HELP.modo">Modo</th>
            <th class="pb-2 pr-3 font-medium cursor-help" :title="COLUMN_HELP.modelo">Modelo</th>
            <th class="pb-2 pr-3 font-medium cursor-help whitespace-nowrap" :title="COLUMN_HELP.device">Processado em</th>
            <th class="pb-2 pr-3 font-medium cursor-help" :title="COLUMN_HELP.audio">Áudio</th>
            <th class="pb-2 pr-3 font-medium cursor-help whitespace-nowrap" :title="COLUMN_HELP.proc">Processamento</th>
            <th class="pb-2 pr-3 font-medium cursor-help" :title="COLUMN_HELP.speed">Velocidade</th>
            <th class="pb-2 font-medium cursor-help" :title="COLUMN_HELP.texto">Texto</th>
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
                  'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium',
                  entry.mode === 'ai'
                    ? 'bg-purple-500/20 text-purple-400'
                    : entry.mode === 'file'
                      ? 'bg-amber-500/20 text-amber-400'
                      : 'bg-emerald-500/20 text-emerald-400'
                ]">
                  <svg v-if="entry.mode === 'file'" class="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                  </svg>
                  {{ entry.mode === 'ai' ? 'IA' : entry.mode === 'file' ? 'Arquivo' : 'Microfone' }}
                </span>
              </td>
              <td class="py-2 pr-3 text-slate-400 text-xs">{{ entry.model }}</td>
              <td class="py-2 pr-3 text-xs" :title="deviceTitle(entry)">
                <span
                  :class="[
                    'inline-flex items-center px-2 py-0.5 rounded-full font-medium whitespace-nowrap',
                    entry.device === 'cuda' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'
                  ]"
                >{{ deviceLabel(entry.device) }}</span>
              </td>
              <td class="py-2 pr-3 text-slate-400 text-xs whitespace-nowrap tabular-nums">{{ fmtDuration(entry.audio_s) }}</td>
              <td class="py-2 pr-3 text-slate-400 text-xs whitespace-nowrap tabular-nums">{{ fmtDuration(entry.proc_s) }}</td>
              <td class="py-2 pr-3 text-slate-400 text-xs whitespace-nowrap tabular-nums">{{ fmtSpeed(entry.rtf) }}</td>
              <td class="py-2 text-slate-300 max-w-xs truncate">{{ entry.text }}</td>
              <td class="py-2">
                <CopyButton :text="copyText(entry)" size="sm" />
              </td>
            </tr>
            <tr v-if="expandedId === entry.id" class="bg-slate-800/30">
              <td colspan="9" class="px-4 py-3">
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
                <!-- Imagens / vídeos que a IA buscou: um link por linha -->
                <div v-if="entry.media?.length" class="border-t border-slate-700 pt-2 mt-2 flex flex-col gap-2">
                  <div v-for="g in entry.media" :key="g.group_id" class="flex flex-col gap-0.5">
                    <div class="flex items-center justify-between gap-2">
                      <p class="text-xs text-slate-500">
                        <span class="text-purple-400 font-medium">{{ g.kind === 'video' ? 'Vídeos' : 'Imagens' }}:</span>
                        {{ g.query }}
                      </p>
                      <CopyButton :text="g.items.map((it) => it.url).join('\n')" size="sm" />
                    </div>
                    <div v-for="(it, i) in g.items" :key="it.url" class="flex items-center gap-2 text-xs min-w-0 group/link">
                      <a
                        :href="it.url"
                        target="_blank"
                        rel="noopener noreferrer"
                        :title="it.url"
                        class="flex-shrink-0 text-indigo-400 hover:text-indigo-300 underline underline-offset-2"
                      >{{ g.kind === 'video' ? 'Vídeo' : 'Link' }} {{ i + 1 }}</a>
                      <span class="truncate text-slate-500" :title="it.title">{{ it.title }}<template v-if="it.source"> · {{ it.source }}</template></span>
                      <span class="opacity-0 group-hover/link:opacity-100 transition-opacity">
                        <CopyButton :text="it.url" size="sm" />
                      </span>
                    </div>
                  </div>
                </div>
              </td>
            </tr>
          </template>
          <tr v-if="!store.items.length && !store.loading">
            <td colspan="9" class="py-12 text-center text-slate-600">Nenhum log ainda</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="store.total > store.limit" class="flex items-center justify-between text-sm text-slate-500 border-t border-slate-800 pt-3">
      <span>{{ offset + 1 }}-{{ Math.min(offset + store.limit, store.total) }} de {{ store.total }}</span>
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
