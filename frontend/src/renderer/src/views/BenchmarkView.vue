<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import axios from 'axios'
import { benchmarkAudioUrl, cancelBenchmark, getBenchmarkInfo, runBenchmark } from '../api'
import { onWsMessage } from '../api/ws'
import { useSettingsStore } from '../stores/settings'
import type { BenchmarkInfo, BenchmarkJob, BenchmarkResult, BenchmarkTest, Settings } from '../types'
import AudioPlayer from '../components/AudioPlayer.vue'

const emit = defineEmits<{ back: [] }>()
const settings = useSettingsStore()

const info = ref<BenchmarkInfo | null>(null)
const loadError = ref<string | null>(null)
const job = ref<BenchmarkJob | null>(null)
const runError = ref<string | null>(null)
const starting = ref(false)
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | null = null

// ---------- seleção (padrão: todos os modelos baixados, GPU, áudios de 1/5/8 min das duas bases, todos os modos) ----------
const selModels = reactive(new Set<string>())
const selDevices = reactive(new Set<string>())
const selAudios = reactive(new Set<string>()) // "id:minutos"
const selModes = reactive(new Set<string>())
const DEFAULT_MINUTES = [1, 5, 8]

const MODE_HELP: Record<string, string> = {
  normal: 'Como era antes: grava tudo e transcreve de uma vez, sem lote e sem pular silêncios',
  batched: 'Corta o áudio nas pausas e manda os pedaços juntos para a placa de vídeo (só faz diferença acima de 30 s)',
  vad: 'Ignora os trechos sem fala antes de transcrever',
  batched_vad: 'Lote e pular silêncios ao mesmo tempo',
  stream: 'Simula transcrever enquanto você fala: o tempo mostrado é só a espera depois de soltar a tecla'
}

const MODE_SETTINGS: Record<string, { whisper_batched: boolean; whisper_vad: boolean; whisper_stream: boolean }> = {
  normal: { whisper_batched: false, whisper_vad: false, whisper_stream: false },
  batched: { whisper_batched: true, whisper_vad: false, whisper_stream: false },
  vad: { whisper_batched: false, whisper_vad: true, whisper_stream: false },
  batched_vad: { whisper_batched: true, whisper_vad: true, whisper_stream: false },
  stream: { whisper_batched: true, whisper_vad: false, whisper_stream: true }
}

function toggle(set: Set<string>, key: string): void {
  if (set.has(key)) set.delete(key)
  else set.add(key)
}

const modelName = (id: string): string => info.value?.models.find((m) => m.id === id)?.name ?? id
const deviceName = (d: string): string => (d === 'cuda' ? 'Placa de vídeo' : 'Processador')

async function load(): Promise<void> {
  try {
    const data = await getBenchmarkInfo()
    info.value = data
    if (!selModels.size) data.models.forEach((m) => selModels.add(m.id))
    if (!selDevices.size) selDevices.add(data.has_gpu ? 'cuda' : 'cpu')
    if (!selAudios.size)
      data.library.forEach((a) =>
        a.cuts.forEach((c) => DEFAULT_MINUTES.includes(c.minutes) && selAudios.add(`${a.id}:${c.minutes}`))
      )
    if (!selModes.size) data.modes.forEach((m) => selModes.add(m.id))
    job.value = data.job ?? data.last_report
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : 'Não foi possível carregar o teste'
  }
}

// ---------- estimativa de tempo ----------
const selectedAudioList = computed(() => {
  const out: { id: string; minutes: number; seconds: number }[] = []
  for (const a of info.value?.library ?? []) {
    for (const c of a.cuts) if (selAudios.has(`${a.id}:${c.minutes}`)) out.push({ id: a.id, minutes: c.minutes, seconds: c.end_s })
  }
  return out
})

const testCount = computed(() => selModels.size * selDevices.size * selectedAudioList.value.length * selModes.size)

const estimateS = computed(() => {
  const i = info.value
  if (!i) return 0
  let total = 0
  for (const m of selModels) {
    for (const d of selDevices) {
      const speed = i.speeds[`${m}|${d}`] ?? (d === 'cuda' ? 15 : 1.5)
      total += i.load_s[d] ?? 10
      for (const a of selectedAudioList.value) {
        for (const mode of selModes) {
          const factor = (mode === 'batched' || mode === 'batched_vad') && a.seconds > 30 ? 2 : 1
          total += a.seconds / (speed * factor)
        }
      }
    }
  }
  return total
})

function fmtDur(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || isNaN(sec)) return '-'
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0).replace('.', ',')} s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  if (m >= 60) return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`
  return `${m} min ${String(s).padStart(2, '0')} s`
}

// ---------- execução ----------
const running = computed(() => job.value?.status === 'running')

async function start(): Promise<void> {
  runError.value = null
  starting.value = true
  try {
    job.value = await runBenchmark({
      models: [...selModels],
      devices: [...selDevices],
      audios: selectedAudioList.value.map((a) => ({ id: a.id, minutes: a.minutes })),
      modes: [...selModes]
    })
    selectedTest.value = null
  } catch (e) {
    runError.value =
      axios.isAxiosError(e) && e.response?.data?.detail ? String(e.response.data.detail) : 'Não foi possível iniciar o teste'
  } finally {
    starting.value = false
  }
}

async function cancel(): Promise<void> {
  try {
    await cancelBenchmark()
  } catch {
    // silencioso
  }
}

let unsub: (() => void) | null = null
onMounted(() => {
  void load()
  clock = setInterval(() => (now.value = Date.now()), 1000)
  unsub = onWsMessage((e) => {
    if ((e.type === 'benchmark_started' || e.type === 'benchmark_done') && e.job) {
      job.value = e.job
      return
    }
    const j = job.value
    if (!j || e.job_id !== j.job_id) return
    if (e.type === 'benchmark_progress' && e.test_id) {
      const t = j.tests.find((x) => x.test_id === e.test_id)
      if (t) {
        // o campo "status" do evento é compartilhado com outros eventos; aqui é o estado do teste
        const st = (e as unknown as { status?: BenchmarkTest['status'] }).status
        t.status = st ?? t.status
        t.progress = e.progress ?? t.progress
      }
    } else if (e.type === 'benchmark_result' && e.test_id && e.result) {
      j.results[e.test_id] = e.result
    }
  })
})
onUnmounted(() => {
  unsub?.()
  if (clock) clearInterval(clock)
})

const doneCount = computed(() => job.value?.tests.filter((t) => ['done', 'error', 'cancelled'].includes(t.status)).length ?? 0)
const elapsedS = computed(() => {
  const j = job.value
  if (!j) return 0
  const end = j.finished_at ? j.finished_at * 1000 : now.value
  return Math.max(0, (end - j.started_at * 1000) / 1000)
})

// ---------- relatório: cada combinação (modelo · dispositivo · modo) somando os áudios testados ----------
interface Combo {
  key: string
  model: string
  device: string
  mode: string
  modeLabel: string
  tests: BenchmarkTest[]
  done: number
  audioS: number
  waitS: number
  totalS: number
  errors: number
  refWords: number
  missing: number
  substituted: number
  inserted: number
  wer: number | null
  speed: number | null
}

const combos = computed<Combo[]>(() => {
  const j = job.value
  if (!j) return []
  const map = new Map<string, Combo>()
  for (const t of j.tests) {
    const key = `${t.model}|${t.device}|${t.mode}`
    let c = map.get(key)
    if (!c) {
      c = { key, model: t.model, device: t.device, mode: t.mode, modeLabel: t.mode_label, tests: [], done: 0, audioS: 0, waitS: 0, totalS: 0, errors: 0, refWords: 0, missing: 0, substituted: 0, inserted: 0, wer: null, speed: null }
      map.set(key, c)
    }
    c.tests.push(t)
    const r: BenchmarkResult | undefined = j.results[t.test_id]
    if (r && !r.error && r.proc_s !== undefined) {
      c.done++
      c.audioS += t.duration_s
      c.waitS += r.proc_s ?? 0
      c.totalS += r.total_s ?? 0
      c.errors += (r.substituted ?? 0) + (r.missing ?? 0) + (r.inserted ?? 0)
      c.refWords += r.ref_words ?? 0
      c.missing += r.missing ?? 0
      c.substituted += r.substituted ?? 0
      c.inserted += r.inserted ?? 0
    }
  }
  for (const c of map.values()) {
    if (c.done) {
      c.wer = c.refWords ? (c.errors / c.refWords) * 100 : 0
      c.speed = c.waitS > 0 ? c.audioS / c.waitS : null
    }
  }
  return [...map.values()]
})

const finished = computed(() => combos.value.filter((c) => c.done > 0))
const fastest = computed(() => [...finished.value].sort((a, b) => (b.speed ?? 0) - (a.speed ?? 0))[0] ?? null)
const accurate = computed(() => [...finished.value].sort((a, b) => (a.wer ?? 999) - (b.wer ?? 999))[0] ?? null)
const balanced = computed(() => {
  const best = accurate.value?.wer
  if (best === null || best === undefined) return null
  return [...finished.value].filter((c) => (c.wer ?? 999) <= best + 1).sort((a, b) => (b.speed ?? 0) - (a.speed ?? 0))[0] ?? null
})

// ordem natural: modelo do menor para o maior, placa antes do processador, modos na ordem da tela
const MODEL_ORDER = ['tiny', 'base', 'small', 'medium', 'large-v3-turbo', 'large-v3']
const MODE_ORDER = ['normal', 'batched', 'vad', 'batched_vad', 'stream']
function naturalRank(c: { model: string; device: string; mode: string }): number {
  const m = MODEL_ORDER.indexOf(c.model)
  return (m < 0 ? 99 : m) * 100 + (c.device === 'cuda' ? 0 : 10) + Math.max(0, MODE_ORDER.indexOf(c.mode))
}

type SortKey = 'name' | 'speed' | 'wait' | 'wer' | 'missing' | 'substituted' | 'inserted'
const sortKey = ref<SortKey>('wer')
const sortAsc = ref(true)
function sortBy(k: SortKey): void {
  if (sortKey.value === k) sortAsc.value = !sortAsc.value
  else {
    sortKey.value = k
    sortAsc.value = k !== 'speed'
  }
}
const sortedCombos = computed(() => {
  const val = (c: Combo): number | string => {
    switch (sortKey.value) {
      case 'name':
        return naturalRank(c)
      case 'speed':
        return c.speed ?? -1
      case 'wait':
        return c.done ? c.waitS / c.done : 1e9
      case 'missing':
        return c.done ? c.missing : 1e9
      case 'substituted':
        return c.done ? c.substituted : 1e9
      case 'inserted':
        return c.done ? c.inserted : 1e9
      default:
        return c.wer ?? 1e9
    }
  }
  return [...combos.value].sort((a, b) => {
    const x = val(a)
    const y = val(b)
    const r = x < y ? -1 : x > y ? 1 : 0
    return sortAsc.value ? r : -r
  })
})

// ---------- destaques: clicar abre a explicação ----------
type HighlightKind = 'fastest' | 'recommended' | 'accurate'
const openHighlight = ref<HighlightKind | null>(null)
const highlightCombo = computed(() =>
  openHighlight.value === 'fastest' ? fastest.value : openHighlight.value === 'accurate' ? accurate.value : balanced.value
)

// ---------- cores dos destaques também nas linhas da tabela (bem clarinhas) ----------
type Role = 'recommended' | 'accurate' | 'fastest'
const ROLE_STYLE: Record<Role, { row: string; chip: string; label: string }> = {
  recommended: {
    row: 'bg-indigo-500/[0.09] hover:bg-indigo-500/[0.14] shadow-[inset_3px_0_0_rgba(129,140,248,0.7)]',
    chip: 'bg-indigo-500/20 text-indigo-200',
    label: 'recomendado'
  },
  accurate: {
    row: 'bg-emerald-500/[0.07] hover:bg-emerald-500/[0.12] shadow-[inset_3px_0_0_rgba(52,211,153,0.6)]',
    chip: 'bg-emerald-500/15 text-emerald-300',
    label: 'mais preciso'
  },
  fastest: {
    row: 'bg-sky-500/[0.07] hover:bg-sky-500/[0.12] shadow-[inset_3px_0_0_rgba(56,189,248,0.6)]',
    chip: 'bg-sky-500/15 text-sky-300',
    label: 'mais rápido'
  }
}

/** destaques que esta combinação ocupa agora (pode ser mais de um, ex.: recomendado e mais preciso) */
function rolesOf(c: Combo): Role[] {
  const out: Role[] = []
  if (balanced.value?.key === c.key) out.push('recommended')
  if (accurate.value?.key === c.key) out.push('accurate')
  if (fastest.value?.key === c.key) out.push('fastest')
  return out
}

/** fundo da linha: a cor do destaque principal (recomendado > mais preciso > mais rápido) */
function rowClass(c: Combo): string {
  const r = rolesOf(c)[0]
  return r ? ROLE_STYLE[r].row : 'hover:bg-slate-800/40'
}

// ordem dos cards: mais rápido | recomendado (centro) | mais preciso
const highlightCards = computed<{ kind: HighlightKind; title: string; c: Combo | null; color: string }[]>(() => [
  { kind: 'fastest', title: 'Mais rápido', c: fastest.value, color: 'text-sky-300' },
  { kind: 'recommended', title: 'Melhor equilíbrio', c: balanced.value, color: 'text-indigo-200' },
  { kind: 'accurate', title: 'Mais preciso', c: accurate.value, color: 'text-emerald-300' }
])

const pct = (v: number): string => `${v.toFixed(1).replace('.', ',')}%`
const pts = (v: number): string => `${Math.abs(v).toFixed(1).replace('.', ',')} ponto${Math.abs(v) >= 0.95 && Math.abs(v) < 1.05 ? '' : 's'}`
const times = (a: number, b: number): string => {
  const r = a / b
  return `${r >= 10 ? Math.round(r) : r.toFixed(1).replace('.', ',')}x`
}

/** Explicação em linguagem simples, com os números do teste */
const highlightText = computed<string[]>(() => {
  const c = highlightCombo.value
  const f = fastest.value
  const a = accurate.value
  const b = balanced.value
  if (!c || c.wer === null || !c.speed) return []
  const out: string[] = []
  const avgWait = c.done ? c.waitS / c.done : 0
  if (openHighlight.value === 'recommended') {
    if (a && a.key !== c.key && a.wer !== null && a.speed) {
      out.push(
        `É ${times(c.speed, a.speed)} mais rápido que o mais preciso (${comboLabel(a)}) e erra só ${pts(c.wer - a.wer)} a mais (${pct(c.wer)} contra ${pct(a.wer)}).`
      )
      out.push(
        `Na prática: você espera em média ${fmtDur(avgWait)} por áudio, contra ${fmtDur(a.waitS / a.done)} do mais preciso, com praticamente a mesma qualidade.`
      )
    } else {
      out.push(`É ao mesmo tempo o mais preciso do teste (${pct(c.wer)} de erro) e o mais rápido entre os que erram pouco.`)
    }
    if (f && f.key !== c.key && f.wer !== null && f.speed) {
      out.push(
        `O mais rápido (${comboLabel(f)}) é ${times(f.speed, c.speed)} mais rápido ainda, mas erra ${pct(f.wer)}: ${pts(f.wer - c.wer)} a mais, o que costuma aparecer como palavras trocadas no texto.`
      )
    }
    out.push('Por isso é a recomendação: o melhor equilíbrio entre esperar pouco e errar pouco.')
  } else if (openHighlight.value === 'fastest') {
    out.push(`É a combinação que te faz esperar menos: ${fmtDur(avgWait)} em média por áudio, ${fmtSpeed(c.speed)} o tempo falado.`)
    if (b && b.key !== c.key && b.wer !== null && b.speed) {
      out.push(
        `Comparado ao recomendado (${comboLabel(b)}), é ${times(c.speed, b.speed)} mais rápido, mas erra ${pts(c.wer - b.wer)} a mais (${pct(c.wer)} contra ${pct(b.wer)}).`
      )
    }
    out.push(
      c.wer < 10
        ? 'Como o erro é baixo, também é uma ótima escolha.'
        : 'Vale para quem prioriza velocidade e não se importa em corrigir algumas palavras.'
    )
  } else {
    out.push(`É a que menos erra: ${pct(c.wer)} das palavras (${c.missing} faltando, ${c.substituted} trocadas e ${c.inserted} sobrando).`)
    if (b && b.key !== c.key && b.wer !== null && b.speed) {
      out.push(
        `O recomendado (${comboLabel(b)}) é ${times(b.speed, c.speed)} mais rápido e erra só ${pts(b.wer - c.wer)} a mais. Esta só compensa se cada palavra certa importa muito mais que o tempo de espera.`
      )
    }
  }
  if (c.done < c.tests.length) out.push(`Resultado parcial: ${c.done} de ${c.tests.length} áudios testados até agora.`)
  return out
})

const expanded = ref<string | null>(null)
const selectedTest = ref<BenchmarkTest | null>(null)
const selectedResult = computed(() => (selectedTest.value ? job.value?.results[selectedTest.value.test_id] : null))

function comboLabel(c: Combo): string {
  return `${modelName(c.model)} · ${deviceName(c.device)} · ${c.modeLabel}`
}

function fmtWer(w: number | null | undefined): string {
  return w === null || w === undefined ? '-' : `${w.toFixed(1).replace('.', ',')}%`
}
function fmtSpeed(s: number | null | undefined): string {
  return s ? `${s >= 10 ? Math.round(s) : s.toFixed(1).replace('.', ',')}x` : '-'
}

// ---------- aplicar ----------
const applied = ref<string | null>(null)
async function apply(c: Combo): Promise<void> {
  await settings.update({ model: c.model, device: c.device, ...MODE_SETTINGS[c.mode] } as Partial<Settings>)
  applied.value = c.key
  setTimeout(() => (applied.value === c.key ? (applied.value = null) : null), 4000)
}

function isCurrent(c: Combo): boolean {
  const s = settings.settings
  if (!s) return false
  const m = MODE_SETTINGS[c.mode]
  const dev = s.device === 'auto' ? (info.value?.has_gpu ? 'cuda' : 'cpu') : s.device
  return (
    s.model === c.model &&
    dev === c.device &&
    (s.whisper_batched ?? true) === m.whisper_batched &&
    (s.whisper_vad ?? false) === m.whisper_vad &&
    (s.whisper_stream ?? false) === m.whisper_stream
  )
}

const DIFF_CLASS: Record<string, string> = { equal: '', missing: 'bench-missing', replace: 'bench-replace', extra: 'bench-extra' }
function diffTitle(d: { op: string; text: string; ref?: string }): string {
  if (d.op === 'missing') return `Faltou: ${d.text}`
  if (d.op === 'replace') return `Correto: ${d.ref}`
  if (d.op === 'extra') return `Sobrou: ${d.text}`
  return ''
}

const STATUS_LABEL: Record<string, string> = {
  queued: 'Na fila',
  loading: 'Carregando modelo',
  running: 'Transcrevendo',
  done: 'Pronto',
  error: 'Erro',
  cancelled: 'Cancelado'
}
</script>

<template>
  <div class="flex flex-col gap-5 pb-10">
    <!-- Cabeçalho -->
    <div class="flex items-start gap-3">
      <button
        title="Voltar para as Configurações"
        class="mt-1 p-2 rounded-xl border border-indigo-600/50 bg-indigo-600/15 text-indigo-300 hover:bg-indigo-600/30 hover:text-indigo-100 transition-colors"
        @click="emit('back')"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" /></svg>
      </button>
      <div class="flex-1">
        <h1 class="text-xl font-semibold text-slate-100">Testar desempenho</h1>
        <p class="text-sm text-slate-400 mt-1 max-w-3xl">
          Teste o reconhecimento de voz no seu computador e descubra a melhor combinação de modelo e opções:
          a mais rápida, a que erra menos e a de melhor equilíbrio.
        </p>
      </div>
    </div>

    <!-- Como funciona -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
      <div v-for="(s, i) in [
        ['Áudios com o texto correto', 'Usamos gravações públicas que já vêm transcritas palavra por palavra. Assim dá para medir exatamente quanto cada combinação erra.'],
        ['Todas as combinações', 'Cada áudio passa por cada modelo e modo selecionado. Os resultados aparecem conforme ficam prontos.'],
        ['Escolha e aplique', 'Compare tempo e erros, veja o texto de cada teste e aplique a combinação que preferir com um clique.']
      ]" :key="i" class="rounded-2xl border border-slate-700/40 bg-slate-800/50 p-4 flex gap-3">
        <span class="w-6 h-6 flex-shrink-0 rounded-full bg-indigo-600/25 text-indigo-200 text-xs font-semibold flex items-center justify-center">{{ i + 1 }}</span>
        <div>
          <p class="text-sm text-slate-200 font-medium">{{ s[0] }}</p>
          <p class="text-xs text-slate-500 mt-1 leading-relaxed">{{ s[1] }}</p>
        </div>
      </div>
    </div>

    <p v-if="loadError" class="text-sm text-red-400">{{ loadError }}</p>

    <template v-if="info">
      <!-- Áudios -->
      <section class="bg-slate-800/60 rounded-2xl p-5 border border-slate-700/40 flex flex-col gap-4">
        <h2 class="text-xs font-semibold text-slate-400 uppercase tracking-widest">Áudios de teste</h2>
        <div class="grid grid-cols-1 gap-4">
          <div v-for="a in info.library" :key="a.id" class="rounded-xl border border-slate-700/50 bg-slate-900/40 p-4 flex flex-col gap-3">
            <div>
              <p class="text-sm text-slate-100 font-medium">{{ a.title }}</p>
              <p class="text-xs text-slate-500 mt-0.5">{{ a.description }}</p>
            </div>
            <AudioPlayer
              :src="benchmarkAudioUrl(a.id)"
              :marks="a.cuts.map((c) => ({ at: c.end_s, label: `${c.minutes}m` }))"
            />
            <div class="flex flex-wrap items-center gap-1.5 pt-2">
              <span class="text-[11px] text-slate-500 mr-1">Testar com:</span>
              <button
                v-for="c in a.cuts"
                :key="c.minutes"
                :disabled="running"
                :title="`Primeiros ${fmtDur(c.end_s)} deste áudio`"
                :class="[
                  'px-2.5 py-1 rounded-lg border text-xs font-medium transition-colors disabled:opacity-50',
                  selAudios.has(`${a.id}:${c.minutes}`)
                    ? 'border-indigo-500/70 bg-indigo-600/25 text-indigo-100'
                    : 'border-slate-700 text-slate-400 hover:border-indigo-500/50 hover:text-slate-200'
                ]"
                @click="toggle(selAudios, `${a.id}:${c.minutes}`)"
              >{{ c.minutes }} min</button>
            </div>
          </div>
        </div>
      </section>

      <!-- O que testar -->
      <section class="bg-slate-800/60 rounded-2xl p-5 border border-slate-700/40 flex flex-col gap-4">
        <h2 class="text-xs font-semibold text-slate-400 uppercase tracking-widest">O que testar</h2>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-5">
          <div class="flex flex-col gap-2">
            <p class="text-xs text-slate-500">Modelos <span class="text-slate-600">(só os baixados)</span></p>
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="m in info.models"
                :key="m.id"
                :disabled="running"
                :title="selModels.has(m.id) ? 'Clique para não testar este modelo' : 'Clique para testar este modelo'"
                :class="[
                  'px-2.5 py-1 rounded-lg border text-xs font-medium transition-colors disabled:opacity-50',
                  selModels.has(m.id)
                    ? 'border-indigo-500/70 bg-indigo-600/25 text-indigo-100'
                    : 'border-slate-700 text-slate-500 hover:border-indigo-500/50 hover:text-slate-200 line-through'
                ]"
                @click="toggle(selModels, m.id)"
              >{{ m.name }}</button>
              <p v-if="!info.models.length" class="text-xs text-amber-300">Nenhum modelo baixado.</p>
            </div>
          </div>
          <div class="flex flex-col gap-2">
            <p class="text-xs text-slate-500">Processar em</p>
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="d in (info.has_gpu ? ['cuda', 'cpu'] : ['cpu'])"
                :key="d"
                :disabled="running"
                :title="d === 'cpu' ? 'O processador é bem mais lento: o teste demora muito mais' : 'Placa de vídeo NVIDIA'"
                :class="[
                  'px-2.5 py-1 rounded-lg border text-xs font-medium transition-colors disabled:opacity-50',
                  selDevices.has(d)
                    ? 'border-indigo-500/70 bg-indigo-600/25 text-indigo-100'
                    : 'border-slate-700 text-slate-500 hover:border-indigo-500/50 hover:text-slate-200'
                ]"
                @click="toggle(selDevices, d)"
              >{{ deviceName(d) }}</button>
            </div>
          </div>
          <div class="flex flex-col gap-2">
            <p class="text-xs text-slate-500">Modos</p>
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="m in info.modes"
                :key="m.id"
                :disabled="running"
                :title="MODE_HELP[m.id]"
                :class="[
                  'px-2.5 py-1 rounded-lg border text-xs font-medium transition-colors disabled:opacity-50',
                  selModes.has(m.id)
                    ? 'border-indigo-500/70 bg-indigo-600/25 text-indigo-100'
                    : 'border-slate-700 text-slate-500 hover:border-indigo-500/50 hover:text-slate-200'
                ]"
                @click="toggle(selModes, m.id)"
              >{{ m.label }}</button>
            </div>
          </div>
        </div>

        <!-- resumo + rodar -->
        <div class="flex flex-wrap items-center gap-3 pt-3 border-t border-slate-700/40">
          <p class="text-sm text-slate-300">
            <span class="font-semibold text-slate-100">{{ testCount }}</span> testes ·
            <span
              title="Calculado pela velocidade das suas gravações (Logs) ou por uma média, quando ainda não há gravações com aquele modelo"
              class="cursor-help"
            >~<span class="font-semibold text-slate-100">{{ fmtDur(estimateS) }}</span> estimados</span>
          </p>
          <div class="flex-1" />
          <p v-if="runError" class="text-xs text-red-400">{{ runError }}</p>
          <button
            v-if="!running"
            :disabled="!testCount || starting"
            class="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            @click="start"
          >{{ starting ? 'Iniciando...' : 'Rodar teste' }}</button>
          <button
            v-else
            class="px-4 py-2 rounded-lg text-sm font-medium border border-red-700/60 text-red-300 hover:bg-red-600/15 transition-colors"
            @click="cancel"
          >Cancelar teste</button>
        </div>
      </section>

      <!-- Andamento + relatório -->
      <section v-if="job" class="bg-slate-800/60 rounded-2xl p-5 border border-slate-700/40 flex flex-col gap-4">
        <div class="flex items-center justify-between gap-3">
          <h2 class="text-xs font-semibold text-slate-400 uppercase tracking-widest">
            {{ running ? 'Testando...' : job.status === 'cancelled' ? 'Teste cancelado' : 'Resultado' }}
          </h2>
          <span class="text-xs text-slate-500 tabular-nums">
            {{ doneCount }} de {{ job.tests.length }} testes · {{ fmtDur(elapsedS) }}
            <template v-if="!running && job.finished_at"> · {{ new Date(job.finished_at * 1000).toLocaleString('pt-BR') }}</template>
          </span>
        </div>
        <div class="h-1.5 rounded-full bg-slate-700/60 overflow-hidden">
          <div class="h-full bg-indigo-500 transition-all duration-500" :style="{ width: `${(doneCount / Math.max(1, job.tests.length)) * 100}%` }" />
        </div>

        <!-- destaques: mais rápido | recomendado | mais preciso (clique para ver a explicação) -->
        <div v-if="finished.length" class="grid grid-cols-1 md:grid-cols-3 gap-3 items-stretch">
          <button
            v-for="h in highlightCards"
            :key="h.kind"
            :disabled="!h.c"
            :title="h.c ? 'Clique para ver por que e usar esta configuração' : ''"
            :class="[
              'relative text-left rounded-xl border p-4 flex flex-col gap-2 transition-colors',
              h.kind === 'recommended'
                ? 'border-indigo-500/70 bg-indigo-600/15 hover:bg-indigo-600/25 hover:border-indigo-400 md:-my-1 shadow-lg shadow-indigo-900/30'
                : 'border-slate-700/50 bg-slate-900/40 hover:border-indigo-500/60 hover:bg-indigo-600/10'
            ]"
            @click="openHighlight = h.kind"
          >
            <span v-if="h.kind === 'recommended'" class="absolute -top-2.5 left-4 px-2 py-0.5 rounded-full bg-indigo-500 text-white text-[10px] font-semibold uppercase tracking-wide">Recomendado</span>
            <p :class="['text-xs font-semibold uppercase tracking-wide', h.color]">{{ h.title }}</p>
            <template v-if="h.c">
              <p class="text-sm text-slate-100 font-medium">{{ comboLabel(h.c) }}</p>
              <p class="text-xs text-slate-400 tabular-nums">
                {{ fmtSpeed(h.c.speed) }} · erro {{ fmtWer(h.c.wer) }}
                <span v-if="h.c.done < h.c.tests.length" class="text-slate-600">· parcial ({{ h.c.done }}/{{ h.c.tests.length }})</span>
              </p>
              <p class="text-[11px] text-indigo-300/80 mt-auto">
                <template v-if="isCurrent(h.c)">Em uso · </template>Ver detalhes →
              </p>
            </template>
            <p v-else class="text-xs text-slate-600">Aguardando resultados...</p>
          </button>
        </div>

        <!-- tabela por combinação -->
        <table class="w-full text-sm border-collapse mt-3">
          <thead>
            <tr class="text-left text-slate-500 text-xs uppercase tracking-wide">
              <th class="pb-2 pr-3 pl-3 font-medium cursor-pointer select-none" title="Modelo, onde rodou e modo. Clique para ordenar" @click="sortBy('name')">Combinação</th>
              <th class="pb-2 pr-3 font-medium cursor-pointer select-none" title="Quantas vezes mais rápido que o tempo do áudio (considerando a espera depois de soltar a tecla). Clique para ordenar" @click="sortBy('speed')">Velocidade</th>
              <th class="pb-2 pr-3 font-medium cursor-pointer select-none" title="Espera média depois de soltar a tecla, por áudio testado. Clique para ordenar" @click="sortBy('wait')">Espera média</th>
              <th class="pb-2 pr-3 font-medium cursor-pointer select-none" title="Taxa de erro: % de palavras erradas, faltando ou sobrando em relação ao texto correto. Clique para ordenar" @click="sortBy('wer')">Erro</th>
              <th class="pb-2 pr-3 font-medium cursor-pointer select-none" title="Palavras do texto correto que não apareceram na transcrição. Clique para ordenar" @click="sortBy('missing')">Faltando</th>
              <th class="pb-2 pr-3 font-medium cursor-pointer select-none" title="Palavras que saíram diferentes do texto correto. Clique para ordenar" @click="sortBy('substituted')">Trocadas</th>
              <th class="pb-2 pr-3 font-medium cursor-pointer select-none" title="Palavras a mais, que não estavam no texto correto. Clique para ordenar" @click="sortBy('inserted')">Sobrando</th>
              <th class="pb-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            <template v-for="c in sortedCombos" :key="c.key">
              <tr
                :class="['border-t border-slate-800 cursor-pointer transition-colors', rowClass(c)]"
                @click="expanded = expanded === c.key ? null : c.key"
              >
                <td class="py-2 pr-3 pl-3">
                  <span class="text-slate-200">{{ modelName(c.model) }}</span>
                  <span class="text-slate-500"> · {{ deviceName(c.device) }} · </span>
                  <span class="text-slate-300">{{ c.modeLabel }}</span>
                  <!-- qual destaque esta combinação é agora (muda durante o teste) -->
                  <span
                    v-for="r in rolesOf(c)"
                    :key="r"
                    :class="['ml-1.5 text-[10px] px-1.5 py-px rounded whitespace-nowrap', ROLE_STYLE[r].chip]"
                  >{{ ROLE_STYLE[r].label }}</span>
                  <span v-if="isCurrent(c)" class="ml-1.5 text-[10px] px-1.5 py-px rounded bg-slate-600/40 text-slate-200">em uso</span>
                  <span v-if="c.done < c.tests.length" class="ml-1.5 text-[10px] text-slate-500">{{ c.done }}/{{ c.tests.length }}</span>
                </td>
                <td class="py-2 pr-3 tabular-nums text-slate-300">{{ fmtSpeed(c.speed) }}</td>
                <td class="py-2 pr-3 tabular-nums text-slate-300">{{ c.done ? fmtDur(c.waitS / c.done) : '-' }}</td>
                <td class="py-2 pr-3 tabular-nums" :class="c.wer === null ? 'text-slate-500' : c.wer < 10 ? 'text-emerald-300' : c.wer < 25 ? 'text-amber-300' : 'text-red-300'">{{ fmtWer(c.wer) }}</td>
                <td class="py-2 pr-3 tabular-nums text-slate-400">{{ c.done ? c.missing : '-' }}</td>
                <td class="py-2 pr-3 tabular-nums text-slate-400">{{ c.done ? c.substituted : '-' }}</td>
                <td class="py-2 pr-3 tabular-nums text-slate-400">{{ c.done ? c.inserted : '-' }}</td>
                <td class="py-2 text-right">
                  <button
                    v-if="c.done"
                    :disabled="isCurrent(c)"
                    class="px-2 py-1 rounded-md text-[11px] border border-indigo-600/50 bg-indigo-600/15 text-indigo-200 hover:bg-indigo-600/30 disabled:opacity-50"
                    @click.stop="apply(c)"
                  >{{ applied === c.key ? 'Aplicado ✓' : 'Usar' }}</button>
                </td>
              </tr>
              <!-- cada áudio desta combinação, nas mesmas colunas (clique para ver o texto) -->
              <template v-if="expanded === c.key">
                <tr
                  v-for="t in c.tests"
                  :key="t.test_id"
                  :class="[
                    'bg-slate-900/40 text-xs',
                    job.results[t.test_id] && !job.results[t.test_id].error ? 'hover:bg-indigo-600/10 cursor-pointer' : ''
                  ]"
                  :title="job.results[t.test_id]?.text ? 'Clique para ver o texto e as diferenças' : ''"
                  @click="job.results[t.test_id] && !job.results[t.test_id].error && (selectedTest = t)"
                >
                  <td class="py-1.5 pr-3 pl-7 text-slate-400">↳ {{ t.audio_title }} · {{ t.minutes }} min</td>
                  <template v-if="job.results[t.test_id] && !job.results[t.test_id].error">
                    <td class="py-1.5 pr-3 tabular-nums text-slate-400">{{ fmtSpeed(t.duration_s / (job.results[t.test_id].proc_s || 1)) }}</td>
                    <td class="py-1.5 pr-3 tabular-nums text-slate-400">{{ fmtDur(job.results[t.test_id].proc_s) }}</td>
                    <td class="py-1.5 pr-3 tabular-nums" :class="(job.results[t.test_id].wer ?? 0) < 10 ? 'text-emerald-300' : (job.results[t.test_id].wer ?? 0) < 25 ? 'text-amber-300' : 'text-red-300'">{{ fmtWer(job.results[t.test_id].wer) }}</td>
                    <td class="py-1.5 pr-3 tabular-nums text-slate-500">{{ job.results[t.test_id].missing }}</td>
                    <td class="py-1.5 pr-3 tabular-nums text-slate-500">{{ job.results[t.test_id].substituted }}</td>
                    <td class="py-1.5 pr-3 tabular-nums text-slate-500">{{ job.results[t.test_id].inserted }}</td>
                    <td class="py-1.5 text-right text-indigo-300/70">ver texto</td>
                  </template>
                  <td v-else colspan="7" class="py-1.5 text-slate-500">
                    <template v-if="job.results[t.test_id]?.error"><span class="text-red-400">Erro: {{ job.results[t.test_id].error }}</span></template>
                    <template v-else>{{ STATUS_LABEL[t.status] }}<template v-if="t.status === 'running'"> {{ Math.round(t.progress) }}%</template></template>
                  </td>
                </tr>
              </template>
            </template>
          </tbody>
        </table>

        <!-- teste em andamento -->
        <div v-if="running" class="flex flex-col gap-1.5">
          <div v-for="t in job.tests.filter((x) => x.status === 'running' || x.status === 'loading')" :key="t.test_id" class="flex items-center gap-3 text-xs">
            <span class="w-2 h-2 rounded-full bg-indigo-400 animate-pulse flex-shrink-0" />
            <span class="text-slate-300 truncate">{{ modelName(t.model) }} · {{ deviceName(t.device) }} · {{ t.mode_label }} · {{ t.audio_title }} {{ t.minutes }} min</span>
            <span class="text-slate-500 whitespace-nowrap">{{ STATUS_LABEL[t.status] }}</span>
            <div v-if="t.status === 'running'" class="w-32 h-1 rounded-full bg-slate-700 overflow-hidden flex-shrink-0">
              <div class="h-full bg-indigo-400 transition-all" :style="{ width: `${t.progress}%` }" />
            </div>
          </div>
        </div>
      </section>

      <p class="text-[11px] text-slate-600">
        Áudio: FLEURS (Conneau et al., 2022, Google), licença CC BY 4.0. Frases unidas e recodificadas para o teste.
      </p>
    </template>

    <!-- explicação de um destaque (mais rápido / recomendado / mais preciso) -->
    <Teleport to="body">
      <div
        v-if="openHighlight && highlightCombo"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-6"
        @click.self="openHighlight = null"
      >
        <div class="w-full max-w-xl bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl p-5 flex flex-col gap-4 text-slate-300">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p
                :class="[
                  'text-xs font-semibold uppercase tracking-wide',
                  openHighlight === 'fastest' ? 'text-sky-300' : openHighlight === 'accurate' ? 'text-emerald-300' : 'text-indigo-200'
                ]"
              >
                {{ openHighlight === 'fastest' ? 'Mais rápido' : openHighlight === 'accurate' ? 'Mais preciso' : 'Recomendado · melhor equilíbrio' }}
              </p>
              <h3 class="text-base font-semibold text-slate-100 mt-1">{{ comboLabel(highlightCombo) }}</h3>
            </div>
            <button class="p-1 rounded-md text-slate-500 hover:text-slate-200 hover:bg-slate-800" title="Fechar" @click="openHighlight = null">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
          <div class="grid grid-cols-3 gap-2">
            <div class="rounded-lg bg-slate-800/70 px-3 py-2">
              <p class="text-[11px] text-slate-500">Velocidade</p>
              <p class="text-sm font-semibold text-slate-100 tabular-nums">{{ fmtSpeed(highlightCombo.speed) }}</p>
            </div>
            <div class="rounded-lg bg-slate-800/70 px-3 py-2">
              <p class="text-[11px] text-slate-500">Espera média</p>
              <p class="text-sm font-semibold text-slate-100 tabular-nums">{{ fmtDur(highlightCombo.done ? highlightCombo.waitS / highlightCombo.done : null) }}</p>
            </div>
            <div class="rounded-lg bg-slate-800/70 px-3 py-2">
              <p class="text-[11px] text-slate-500">Erro</p>
              <p class="text-sm font-semibold text-slate-100 tabular-nums">{{ fmtWer(highlightCombo.wer) }}</p>
            </div>
          </div>
          <ul class="flex flex-col gap-2 text-sm leading-relaxed">
            <li v-for="(line, i) in highlightText" :key="i" class="flex gap-2">
              <span class="text-indigo-400 mt-0.5">•</span><span>{{ line }}</span>
            </li>
          </ul>
          <p class="text-[11px] text-slate-500">
            Erro = % de palavras faltando, trocadas ou sobrando em relação ao texto correto. Espera = tempo depois de soltar a tecla.
          </p>
          <div class="flex justify-end gap-2">
            <button
              class="px-3.5 py-2 rounded-lg text-xs border border-slate-700 hover:border-slate-500 text-slate-300 transition-colors"
              @click="openHighlight = null"
            >Fechar</button>
            <button
              :disabled="isCurrent(highlightCombo)"
              class="px-3.5 py-2 rounded-lg text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-60 disabled:cursor-default"
              @click="apply(highlightCombo)"
            >{{ applied === highlightCombo.key ? 'Aplicado ✓' : isCurrent(highlightCombo) ? 'Já está em uso' : 'Usar esta configuração' }}</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- texto de um teste com as diferenças -->
    <Teleport to="body">
      <div
        v-if="selectedTest && selectedResult && !selectedResult.error"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-6"
        @click.self="selectedTest = null"
      >
        <div class="w-full max-w-3xl max-h-[85vh] bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl p-5 flex flex-col gap-3">
          <div class="flex items-start justify-between gap-3">
            <div>
              <h3 class="text-base font-semibold text-slate-100">{{ modelName(selectedTest.model) }} · {{ selectedTest.mode_label }}</h3>
              <p class="text-xs text-slate-500 mt-0.5">
                {{ selectedTest.audio_title }} · {{ selectedTest.minutes }} min · espera {{ fmtDur(selectedResult.proc_s) }} ·
                erro {{ fmtWer(selectedResult.wer) }} ({{ selectedResult.missing }} faltando, {{ selectedResult.substituted }} trocadas, {{ selectedResult.inserted }} sobrando)
              </p>
            </div>
            <button class="p-1 rounded-md text-slate-500 hover:text-slate-200 hover:bg-slate-800" title="Fechar" @click="selectedTest = null">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
          <div class="flex flex-wrap gap-3 text-[11px] text-slate-300">
            <span><span class="bench-missing px-1">vermelho</span> faltou (estava no texto correto)</span>
            <span><span class="bench-replace px-1">amarelo</span> trocada (passe o mouse para ver a certa)</span>
            <span><span class="bench-extra px-1">riscada</span> sobrou</span>
          </div>
          <p class="text-[11px] text-slate-600">Para comparar, os dois textos são escritos sem pontuação, em minúsculas e com números por extenso.</p>
          <div class="overflow-y-auto text-sm leading-relaxed text-slate-300 rounded-xl bg-slate-950/60 border border-slate-800 p-4">
            <template v-for="(d, i) in selectedResult.diff" :key="i"><span :class="DIFF_CLASS[d.op]" :title="diffTitle(d)">{{ d.text }}</span>{{ ' ' }}</template>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.bench-missing {
  background: rgba(239, 68, 68, 0.22);
  color: #fecaca;
  border-radius: 3px;
}
.bench-replace {
  background: rgba(245, 158, 11, 0.22);
  color: #fde68a;
  border-radius: 3px;
}
.bench-extra {
  color: #94a3b8;
  text-decoration: line-through;
}
</style>
