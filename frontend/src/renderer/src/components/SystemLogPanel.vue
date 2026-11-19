<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { clearSystemLogs, getSystemLogFile, getSystemLogs } from '../api'
import { onWsMessage } from '../api/ws'
import type { SystemLogEntry } from '../types'

/**
 * Log do sistema: tudo o que o app faz e todos os erros (atalhos, microfone, gravações, modelos,
 * configurações, chamada, janelas, backend). Nunca tem o texto do que a pessoa falou. Serve para alguém
 * mandar o que aconteceu: Copiar (as linhas mostradas) ou Baixar (o arquivo inteiro, com as sessões
 * anteriores).
 */
const MAX_KEEP = 5000
const MAX_SHOWN = 2000

const items = ref<SystemLogEntry[]>([])
const file = ref('')
const loading = ref(true)
const loadError = ref('')

const levelFilter = ref<'all' | 'normal' | 'problems'>('normal')
const source = ref('all')
const category = ref('all')
const query = ref('')
const follow = ref(true)
const list = ref<HTMLElement | null>(null)
const copied = ref(false)
const savedTo = ref('')
const confirmClear = ref(false)

function add(entries: SystemLogEntry[]): void {
  if (!entries.length) return
  const lastId = items.value.length ? items.value[items.value.length - 1].id : 0
  const fresh = entries.filter((e) => e.id > lastId)
  if (!fresh.length) return
  const next = [...items.value, ...fresh]
  items.value = next.length > MAX_KEEP ? next.slice(-MAX_KEEP) : next
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const r = await getSystemLogs(0)
    items.value = []
    add(r.items)
    file.value = r.file
    loadError.value = ''
  } catch (e) {
    loadError.value = `Não deu para ler o log do backend (${e instanceof Error ? e.message : String(e)}). O arquivo fica em <dados do app>/logs/sistema.log.`
  } finally {
    loading.value = false
  }
}

const unsub = onWsMessage((e) => {
  if (e.type === 'system_log' && e.log) add([e.log])
})
onMounted(load)
onUnmounted(unsub)

const sources = computed(() => [...new Set(items.value.map((e) => e.src))].sort())
const categories = computed(() => [...new Set(items.value.map((e) => e.cat))].sort((a, b) => a.localeCompare(b, 'pt-BR')))
const problems = computed(() => items.value.filter((e) => e.level === 'warn' || e.level === 'error').length)

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return items.value.filter(
    (e) =>
      (levelFilter.value === 'all' || (levelFilter.value === 'normal' ? e.level !== 'debug' : e.level === 'warn' || e.level === 'error')) &&
      (source.value === 'all' || e.src === source.value) &&
      (category.value === 'all' || e.cat === category.value) &&
      (!q || e.msg.toLowerCase().includes(q) || e.cat.toLowerCase().includes(q))
  )
})
const shown = computed(() => filtered.value.slice(-MAX_SHOWN))

function stamp(t: number, withDate = false): string {
  const d = new Date(t * 1000)
  const time = `${d.toLocaleTimeString('pt-BR', { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`
  return withDate ? `${d.toLocaleDateString('pt-BR')} ${time}` : time
}

function lineText(e: SystemLogEntry): string {
  return `${stamp(e.t, true)} ${e.level.toUpperCase().padEnd(5)} [${e.src}/${e.cat}] ${e.msg}`
}

const LEVEL_CLASS: Record<SystemLogEntry['level'], string> = {
  debug: 'text-slate-600',
  info: 'text-slate-300',
  warn: 'text-amber-300',
  error: 'text-red-400'
}
const LEVEL_TAG: Record<SystemLogEntry['level'], string> = {
  debug: 'bg-slate-800 text-slate-500',
  info: 'bg-slate-800 text-slate-400',
  warn: 'bg-amber-500/15 text-amber-300',
  error: 'bg-red-500/15 text-red-300'
}
const LEVEL_LABEL: Record<SystemLogEntry['level'], string> = { debug: 'detalhe', info: 'info', warn: 'aviso', error: 'erro' }
const SRC_CLASS: Record<string, string> = {
  backend: 'text-emerald-300',
  tela: 'text-sky-300',
  overlay: 'text-fuchsia-300',
  electron: 'text-orange-300'
}

async function copy(): Promise<void> {
  // sempre tudo (os filtros servem só para ler aqui): quem recebe precisa do registro completo
  await navigator.clipboard.writeText(items.value.map(lineText).join('\n'))
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}

/** Salva o arquivo inteiro (sessões anteriores também); se o backend não responder, salva o que está na tela. */
async function download(): Promise<void> {
  let text: string
  try {
    text = await getSystemLogFile()
  } catch {
    text = items.value.map(lineText).join('\n')
  }
  const t = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const name = `log-sistema-${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}.txt`
  const path = (await window.electron?.ipcRenderer?.invoke('call:save-log', text, name)) as string | null | undefined
  if (path) {
    savedTo.value = path
    setTimeout(() => (savedTo.value = ''), 4000)
  }
}

async function doClear(): Promise<void> {
  confirmClear.value = false
  await clearSystemLogs()
  await load()
}

function onScroll(): void {
  const el = list.value
  if (el) follow.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40
}

watch(
  () => shown.value.length && shown.value[shown.value.length - 1].id,
  async () => {
    if (!follow.value) return
    await nextTick()
    list.value?.scrollTo({ top: list.value.scrollHeight })
  },
  { immediate: true }
)
</script>

<template>
  <div class="flex flex-col gap-3 h-full min-h-0">
    <div class="flex flex-wrap items-center gap-2">
      <select v-model="levelFilter" class="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200 outline-none">
        <option value="normal">Ações e erros</option>
        <option value="problems">Só avisos e erros</option>
        <option value="all">Tudo (com detalhes, ex.: foco das janelas)</option>
      </select>
      <select v-model="category" class="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200 outline-none">
        <option value="all">Todas as áreas</option>
        <option v-for="c in categories" :key="c" :value="c">{{ c }}</option>
      </select>
      <select v-model="source" class="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200 outline-none">
        <option value="all">Todas as origens</option>
        <option v-for="s in sources" :key="s" :value="s">{{ s }}</option>
      </select>
      <input
        v-model="query"
        placeholder="Buscar…"
        class="flex-1 min-w-40 bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 outline-none focus:border-indigo-500"
      />
      <button
        :class="['px-3 py-1.5 rounded-lg text-xs font-medium transition-colors', copied ? 'bg-emerald-600 text-white' : 'bg-indigo-600 hover:bg-indigo-500 text-white']"
        title="Copia todos os registros desta sessão, sem os filtros (para colar numa conversa)"
        @click="copy"
      >{{ copied ? 'Copiado!' : 'Copiar' }}</button>
      <button
        class="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-100 bg-slate-700 hover:bg-slate-600 transition-colors"
        :title="savedTo ? `Salvo em ${savedTo}` : 'Salva o log inteiro (também das vezes anteriores em que o app abriu) num arquivo .txt'"
        @click="download"
      >{{ savedTo ? 'Salvo!' : 'Baixar' }}</button>
      <button
        v-if="!confirmClear"
        class="px-3 py-1.5 rounded-lg text-xs text-slate-300 bg-slate-800 hover:bg-slate-700 transition-colors"
        title="Limpa a lista desta sessão (o arquivo continua guardado)"
        @click="confirmClear = true"
      >Limpar</button>
      <template v-else>
        <button class="px-3 py-1.5 rounded-lg text-xs text-red-300 border border-red-700/60" @click="doClear">Confirmar</button>
        <button class="px-3 py-1.5 rounded-lg text-xs text-slate-400 border border-slate-700" @click="confirmClear = false">Cancelar</button>
      </template>
    </div>

    <p class="text-xs text-slate-500 -mt-1">
      {{ filtered.length }} de {{ items.length }} linhas<template v-if="problems"> · <span class="text-amber-400">{{ problems }} avisos/erros</span></template>
      <template v-if="filtered.length > MAX_SHOWN"> · mostrando as últimas {{ MAX_SHOWN }} (Copiar e Baixar levam todas)</template>
      · o texto do que você fala nunca entra aqui
      <template v-if="file"> · arquivo: <span class="font-mono select-all text-slate-400">{{ file }}</span></template>
    </p>

    <p v-if="loadError" class="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{{ loadError }}</p>

    <div
      ref="list"
      class="flex-1 min-h-0 overflow-y-auto rounded-xl bg-slate-950/60 border border-slate-800 px-3 py-2 font-mono text-[11.5px] leading-relaxed select-text"
      @scroll="onScroll"
    >
      <p v-if="loading" class="text-slate-600 text-center py-10 font-sans text-sm">Carregando…</p>
      <p v-else-if="!shown.length" class="text-slate-600 text-center py-10 font-sans text-sm">Nada registrado com esses filtros.</p>
      <div v-for="e in shown" :key="e.id" class="flex gap-2 py-px whitespace-pre-wrap break-words hover:bg-slate-800/40">
        <span class="text-slate-500 flex-shrink-0 tabular-nums">{{ stamp(e.t) }}</span>
        <span :class="['flex-shrink-0 w-14 text-center rounded px-1 text-[10px] leading-[18px] font-sans font-medium', LEVEL_TAG[e.level]]">{{ LEVEL_LABEL[e.level] }}</span>
        <span :class="['flex-shrink-0 w-16 truncate', SRC_CLASS[e.src] ?? 'text-slate-400']" :title="`origem: ${e.src}`">{{ e.src }}</span>
        <span class="flex-shrink-0 w-24 truncate text-indigo-300" :title="e.cat">{{ e.cat }}</span>
        <span :class="['min-w-0 flex-1', LEVEL_CLASS[e.level]]">{{ e.msg }}</span>
      </div>
    </div>
  </div>
</template>
