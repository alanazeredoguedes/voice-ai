<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useCallStore, type CallLogEntry } from '../stores/call'

/**
 * Log da sala: o que aconteceu aqui e nos outros participantes (as linhas deles chegam pelo canal de
 * mensagens da chamada). Serve para depurar testes: filtra, copia e cola.
 */
const emit = defineEmits<{ close: [] }>()
const store = useCallStore()

const who = ref<string>('all') // 'all' | userId
const onlyProblems = ref(false)
const query = ref('')
const follow = ref(true)
const list = ref<HTMLElement | null>(null)
const copied = ref(false)

const authors = computed(() => {
  const seen = new Map<string, string>()
  for (const e of store.logs) seen.set(e.userId, e.remote ? e.author : `${e.author} (eu)`)
  return [...seen].map(([id, label]) => ({ id, label }))
})

const shown = computed<CallLogEntry[]>(() => {
  const q = query.value.trim().toLowerCase()
  return store.logs.filter(
    (e) =>
      (who.value === 'all' || e.userId === who.value) &&
      (!onlyProblems.value || e.level !== 'info') &&
      (!q || e.msg.toLowerCase().includes(q) || e.author.toLowerCase().includes(q))
  )
})

const problems = computed(() => store.logs.filter((e) => e.level !== 'info').length)

function time(t: number): string {
  const d = new Date(t)
  return `${d.toLocaleTimeString('pt-BR', { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

const COLORS = ['text-sky-300', 'text-amber-300', 'text-fuchsia-300', 'text-lime-300', 'text-orange-300', 'text-cyan-300']
function authorColor(e: CallLogEntry): string {
  if (!e.remote) return 'text-indigo-300'
  let h = 0
  for (const c of e.userId) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return COLORS[h % COLORS.length]
}

const savedTo = ref('')
/** Salva o log (com os filtros aplicados) num arquivo .txt, para mandar por onde quiser. */
async function download(): Promise<void> {
  const t = new Date()
  const name = `log-chamada-${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}-${String(t.getHours()).padStart(2, '0')}${String(t.getMinutes()).padStart(2, '0')}.txt`
  const path = (await window.electron.ipcRenderer.invoke('call:save-log', store.logText(store.logs), name)) as string | null
  if (path) {
    savedTo.value = path
    setTimeout(() => (savedTo.value = ''), 4000)
  }
}

async function copy(): Promise<void> {
  // sempre tudo (os filtros servem só para ler aqui): quem recebe precisa do registro completo
  await navigator.clipboard.writeText(store.logText(store.logs))
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}

function onScroll(): void {
  const el = list.value
  if (el) follow.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40
}

watch(
  () => shown.value.length,
  async () => {
    if (!follow.value) return
    await nextTick()
    list.value?.scrollTo({ top: list.value.scrollHeight })
  },
  { immediate: true }
)

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-[70] bg-black/60 flex items-center justify-center p-6" @mousedown.self="emit('close')">
      <div class="w-full max-w-5xl h-full max-h-[85vh] bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        <div class="flex items-center gap-3 px-4 py-3 border-b border-slate-800 flex-shrink-0">
          <h2 class="text-sm font-semibold text-slate-100">Logs da sala</h2>
          <span class="text-xs text-slate-500">
            {{ shown.length }} de {{ store.logs.length }} linhas<template v-if="problems"> · <span class="text-amber-400">{{ problems }} avisos/erros</span></template>
          </span>
          <div class="flex-1" />
          <button
            :class="['px-3 py-1.5 rounded-lg text-xs font-medium transition-colors', copied ? 'bg-emerald-600 text-white' : 'bg-indigo-600 hover:bg-indigo-500 text-white']"
            title="Copia todos os registros (de todos os participantes, sem os filtros)"
            @click="copy"
          >{{ copied ? 'Copiado!' : 'Copiar' }}</button>
          <button
            class="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-100 bg-slate-700 hover:bg-slate-600 transition-colors"
            :title="savedTo ? `Salvo em ${savedTo}` : 'Salva todos os registros num arquivo .txt (para mandar por e-mail, chat...)'"
            @click="download"
          >{{ savedTo ? 'Salvo!' : 'Baixar' }}</button>
          <button
            class="px-3 py-1.5 rounded-lg text-xs text-slate-300 bg-slate-800 hover:bg-slate-700 transition-colors"
            title="Limpa só aqui (não apaga o log dos outros participantes)"
            @click="store.clearLogs()"
          >Limpar</button>
          <button class="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800" title="Fechar (Esc)" @click="emit('close')">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div class="flex items-center gap-2 px-4 py-2 border-b border-slate-800 flex-shrink-0">
          <select v-model="who" class="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-200 outline-none">
            <option value="all">Todos os participantes</option>
            <option v-for="a in authors" :key="a.id" :value="a.id">{{ a.label }}</option>
          </select>
          <label class="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer select-none">
            <input v-model="onlyProblems" type="checkbox" class="accent-indigo-500" />
            Só avisos e erros
          </label>
          <input
            v-model="query"
            placeholder="Buscar…"
            class="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1 text-xs text-slate-200 outline-none focus:border-indigo-500"
          />
        </div>

        <div ref="list" class="flex-1 overflow-y-auto px-4 py-2 font-mono text-[11.5px] leading-relaxed min-h-0 select-text" @scroll="onScroll">
          <p v-if="!shown.length" class="text-slate-600 text-center py-10 font-sans text-sm">Nada registrado ainda.</p>
          <div v-for="e in shown" :key="e.id" class="flex gap-2 whitespace-pre-wrap break-words">
            <span class="text-slate-600 flex-shrink-0">{{ time(e.t) }}</span>
            <span :class="['flex-shrink-0 w-28 truncate', authorColor(e)]" :title="e.author">{{ e.remote ? e.author : `${e.author} (eu)` }}</span>
            <span
              :class="[
                'min-w-0',
                e.level === 'error' ? 'text-red-400' : e.level === 'warn' ? 'text-amber-300' : 'text-slate-300'
              ]"
            >{{ e.msg }}</span>
          </div>
        </div>

        <p class="px-4 py-2 border-t border-slate-800 text-[11px] text-slate-500 flex-shrink-0">
          Aparecem aqui as suas linhas e as dos outros participantes desta chamada. O horário é o do relógio de quem registrou.
          A cada 30 s entra um resumo das conexões (taxa, perda de pacotes e nível do som).
        </p>
      </div>
    </div>
  </Teleport>
</template>
