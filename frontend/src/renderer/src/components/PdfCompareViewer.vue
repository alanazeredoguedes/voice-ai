<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import type { FileTranslation } from '../types'
import { fileTranslationPreviewUrl, getFileTranslationPageSizes, type PdfTheme } from '../api'

/**
 * Compara as páginas do PDF original e do traduzido: lado a lado ou uma só. Abre com a página inteira na
 * tela (100% = página inteira); zoom pelos botões, Ctrl+roda do mouse ou teclas + e -; giro de 90°; arrastar
 * para mover; tema claro/escuro; e ir direto para uma página (lista com busca).
 */
const props = defineProps<{
  job: FileTranslation
  langName: (code: string) => string
  theme: PdfTheme
  /** gerando a versão escura para salvar */
  saving?: boolean
  /** onde acabou de salvar (aviso por alguns segundos) */
  savedPath?: string
}>()
const emit = defineEmits<{ close: []; save: []; 'update:theme': [PdfTheme] }>()

type Which = 'original' | 'translated'
type Mode = 'both' | Which
const mode = ref<Mode>('both')
const page = ref(0)
const zoom = ref(1)
const rotate = ref(0)
const viewer = ref<HTMLElement | null>(null)
const box = ref({ w: 1200, h: 800 })

const ZOOM_MIN = 0.25
const ZOOM_MAX = 6
const PAD = 20 // p-5
const GAP = 20 // gap-5
const LABEL = 28 // título acima da página + espaço

const total = computed(() => props.job.pages ?? 1)
const shown = computed<Which[]>(() => (mode.value === 'both' ? ['original', 'translated'] : [mode.value]))

// tamanho de cada página (pontos), pedido ao abrir: a tela já nasce no tamanho certo, sem desenhar duas vezes
const sizes = ref<number[][]>([])
const pageSize = computed(() => {
  const [w, h] = sizes.value[page.value] ?? [595, 842] // até chegar, A4
  return rotate.value % 180 ? [h, w] : [w, h]
})
const aspect = computed(() => pageSize.value[1] / pageSize.value[0])
const pagePt = computed(() => pageSize.value[0])

// tamanho da página "inteira na tela" e o tamanho com o zoom
const fitWidth = computed(() => {
  const n = shown.value.length
  const byWidth = (box.value.w - PAD * 2 - GAP * (n - 1)) / n
  const byHeight = (box.value.h - PAD * 2 - LABEL) / aspect.value
  return Math.max(120, Math.min(byWidth, byHeight))
})
const pageWidth = computed(() => fitWidth.value * zoom.value)
const contentWidth = computed(() => pageWidth.value * shown.value.length + GAP * (shown.value.length - 1))

// resolução pedida ao backend conforme o tamanho na tela (nítida com zoom, leve sem zoom)
const renderScale = computed(() => {
  const wanted = (pageWidth.value * (window.devicePixelRatio || 1)) / pagePt.value
  return Math.min(4, Math.max(0.5, Math.ceil(wanted * 2) / 2))
})

function urlFor(which: Which, pageIndex: number, scale: number): string {
  return fileTranslationPreviewUrl(props.job.id, pageIndex, which, scale, rotate.value, props.theme)
}

// O que está na tela. As duas metades trocam JUNTAS (nunca uma antes da outra): primeiro uma versão leve
// (rápida de desenhar), logo depois a nítida. Enquanto isso, a imagem anterior continua visível.
const displayed = ref<Partial<Record<Which, string>>>({})
const waiting = ref(false)
let loadToken = 0

function preload(url: string): Promise<void> {
  const img = new Image()
  img.src = url
  return img.decode().catch(() => undefined)
}

async function refresh(withPreview: boolean): Promise<void> {
  const token = ++loadToken
  const sides = shown.value
  const slow = setTimeout(() => token === loadToken && (waiting.value = true), 250)
  try {
    const hi = renderScale.value
    const lo = Math.min(1, hi)
    if (withPreview && lo < hi) {
      const urls = sides.map((w) => urlFor(w, page.value, lo))
      await Promise.all(urls.map(preload))
      if (token !== loadToken) return
      displayed.value = Object.fromEntries(sides.map((w, i) => [w, urls[i]]))
      waiting.value = false
    }
    const urls = sides.map((w) => urlFor(w, page.value, hi))
    await Promise.all(urls.map(preload))
    if (token !== loadToken) return
    displayed.value = Object.fromEntries(sides.map((w, i) => [w, urls[i]]))
    nextTick(updatePan)
    // próxima página (e a anterior) já preparadas: o servidor e a tela guardam a imagem
    for (const n of [page.value + 1, page.value - 1]) {
      if (n < 0 || n >= total.value) continue
      for (const w of sides) {
        if (token !== loadToken) return
        await preload(urlFor(w, n, hi))
      }
    }
  } finally {
    clearTimeout(slow)
    if (token === loadToken) waiting.value = false
  }
}

// página, tema, giro ou modo novos: versão leve primeiro. Só o zoom: troca pela nova resolução quando pronta.
watch([page, () => props.theme, rotate, mode], () => refresh(true))
watch(renderScale, () => Object.keys(displayed.value).length && refresh(false)) // na abertura, o refresh inicial já usa a escala certa

function setZoom(z: number, anchor?: { x: number; y: number }): void {
  const el = viewer.value
  const old = zoom.value
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100))
  if (!el || next === old) {
    zoom.value = next
    return
  }
  // mantém o ponto sob o mouse (ou o centro) no mesmo lugar depois do zoom
  const ax = anchor?.x ?? el.clientWidth / 2
  const ay = anchor?.y ?? el.clientHeight / 2
  const fx = (el.scrollLeft + ax) / el.scrollWidth
  const fy = (el.scrollTop + ay) / el.scrollHeight
  zoom.value = next
  nextTick(() => {
    el.scrollLeft = fx * el.scrollWidth - ax
    el.scrollTop = fy * el.scrollHeight - ay
    updatePan()
  })
}

const zoomIn = (): void => setZoom(zoom.value * 1.25)
const zoomOut = (): void => setZoom(zoom.value / 1.25)
function fit(): void {
  zoom.value = 1
  nextTick(() => {
    viewer.value?.scrollTo({ left: 0, top: 0 })
    updatePan()
  })
}
function turn(): void {
  rotate.value = (rotate.value + 90) % 360
  fit()
}

function onWheel(e: WheelEvent): void {
  if (!e.ctrlKey && !e.metaKey) return // rolagem normal: só move
  e.preventDefault()
  const rect = viewer.value!.getBoundingClientRect()
  setZoom(zoom.value * (e.deltaY < 0 ? 1.15 : 1 / 1.15), { x: e.clientX - rect.left, y: e.clientY - rect.top })
}

// arrastar para mover (quando a página é maior que a tela)
const drag = ref<{ x: number; y: number; left: number; top: number } | null>(null)
const canPan = ref(false)
function updatePan(): void {
  const el = viewer.value
  canPan.value = !!el && (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2)
}
function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0 || !canPan.value || !viewer.value) return
  drag.value = { x: e.clientX, y: e.clientY, left: viewer.value.scrollLeft, top: viewer.value.scrollTop }
  viewer.value.setPointerCapture(e.pointerId)
}
function onPointerMove(e: PointerEvent): void {
  if (!drag.value || !viewer.value) return
  viewer.value.scrollLeft = drag.value.left - (e.clientX - drag.value.x)
  viewer.value.scrollTop = drag.value.top - (e.clientY - drag.value.y)
}
function onPointerUp(): void {
  drag.value = null
}

// ── páginas ──────────────────────────────────────────────────────────────────
function goTo(index: number): void {
  const next = Math.min(Math.max(index, 0), total.value - 1)
  if (next === page.value) return
  page.value = next
  viewer.value?.scrollTo({ top: 0 })
}
const goPage = (delta: number): void => goTo(page.value + delta)

const pickerOpen = ref(false)
const pageQuery = ref('')
const pageInput = ref<HTMLInputElement | null>(null)
const pageList = ref<HTMLElement | null>(null)
const pageOptions = computed(() => {
  const q = pageQuery.value.trim()
  const all = Array.from({ length: total.value }, (_, i) => i + 1)
  return q ? all.filter((n) => String(n).includes(q)) : all
})
function openPicker(): void {
  pickerOpen.value = !pickerOpen.value
  pageQuery.value = ''
  if (pickerOpen.value) {
    nextTick(() => {
      pageInput.value?.focus()
      pageList.value?.querySelector('[data-current="true"]')?.scrollIntoView({ block: 'center' })
    })
  }
}
function pick(n: number): void {
  goTo(n - 1)
  pickerOpen.value = false
}
function onPageEnter(): void {
  const n = parseInt(pageQuery.value, 10)
  if (n >= 1 && n <= total.value) pick(n)
  else if (pageOptions.value.length) pick(pageOptions.value[0])
}

// ── teclado ──────────────────────────────────────────────────────────────────
function onKey(e: KeyboardEvent): void {
  if (pickerOpen.value) {
    if (e.key === 'Escape') {
      pickerOpen.value = false
      e.preventDefault()
    }
    return // digitando o número da página
  }
  if (e.key === 'Escape') emit('close')
  else if (e.key === 'ArrowRight' || e.key === 'PageDown') goPage(1)
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') goPage(-1)
  else if (e.key === 'Home') goTo(0)
  else if (e.key === 'End') goTo(total.value - 1)
  else if (e.key === '+' || e.key === '=') zoomIn()
  else if (e.key === '-') zoomOut()
  else if (e.key === '0') fit()
  else if (e.key.toLowerCase() === 'r') turn()
  else if (e.key.toLowerCase() === 't') emit('update:theme', props.theme === 'dark' ? 'original' : 'dark')
  else return
  e.preventDefault()
}

let observer: ResizeObserver | null = null
onMounted(async () => {
  window.addEventListener('keydown', onKey)
  getFileTranslationPageSizes(props.job.id)
    .then((list) => (sizes.value = list))
    .catch(() => undefined)
    .finally(() => refresh(true))
  if (viewer.value) {
    observer = new ResizeObserver(() => {
      if (!viewer.value) return
      box.value = { w: viewer.value.clientWidth, h: viewer.value.clientHeight }
      updatePan()
    })
    observer.observe(viewer.value)
  }
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKey)
  observer?.disconnect()
})
watch(mode, fit)

const TOOL =
  'p-1.5 rounded-lg text-slate-300 hover:bg-slate-800 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent transition-colors'
const SEG = 'flex gap-0.5 p-0.5 bg-slate-800/70 rounded-lg'
const segBtn = (on: boolean): string =>
  `flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs transition-colors ${on ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-slate-200'}`

const MODES: Array<[Mode, string]> = [
  ['both', 'Lado a lado'],
  ['original', 'Original'],
  ['translated', 'Tradução']
]
const THEMES: Array<[PdfTheme, string]> = [
  ['original', 'Claro'],
  ['dark', 'Escuro']
]
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-50 bg-slate-950/95 backdrop-blur-sm flex flex-col select-none">
      <!-- barra de ferramentas -->
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 border-b border-slate-800">
        <p class="text-sm text-slate-200 truncate min-w-0 flex-1" :title="job.output_name">{{ job.output_name }}</p>

        <div :class="SEG">
          <button v-for="m in MODES" :key="m[0]" :class="segBtn(mode === m[0])" @click="mode = m[0]">{{ m[1] }}</button>
        </div>

        <div :class="SEG" title="Tema (T): claro = como o original; escuro = fundo escuro e texto claro">
          <button v-for="t in THEMES" :key="t[0]" :class="segBtn(theme === t[0])" @click="emit('update:theme', t[0])">
            <span
              class="w-2.5 h-2.5 rounded-sm border"
              :class="t[0] === 'dark' ? 'bg-slate-900 border-slate-400' : 'bg-white border-slate-300'"
            />
            {{ t[1] }}
          </button>
        </div>

        <!-- páginas: setas + lista com busca -->
        <div class="relative flex items-center gap-1">
          <button :class="TOOL" :disabled="page === 0" title="Página anterior (←)" @click="goPage(-1)">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" /></svg>
          </button>
          <button
            class="flex items-center gap-1.5 text-xs text-slate-300 tabular-nums px-2.5 py-1 rounded-lg border border-slate-700/70 hover:border-slate-500 hover:text-white transition-colors"
            title="Ir para a página…"
            @click="openPicker"
          >
            Página {{ page + 1 }} de {{ total }}
            <svg class="w-3 h-3 text-slate-500" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" /></svg>
          </button>
          <button :class="TOOL" :disabled="page >= total - 1" title="Próxima página (→)" @click="goPage(1)">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" /></svg>
          </button>

          <template v-if="pickerOpen">
            <div class="fixed inset-0 z-10" @click="pickerOpen = false" />
            <div class="absolute top-full mt-2 left-1/2 -translate-x-1/2 z-20 w-56 rounded-xl border border-slate-700 bg-slate-900 shadow-2xl p-2 flex flex-col gap-2">
              <input
                ref="pageInput"
                v-model="pageQuery"
                inputmode="numeric"
                :placeholder="`Número da página (1 a ${total})`"
                class="w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                @keydown.enter.prevent="onPageEnter"
              />
              <div ref="pageList" class="max-h-72 overflow-y-auto flex flex-col">
                <button
                  v-for="n in pageOptions"
                  :key="n"
                  :data-current="n === page + 1"
                  class="text-left text-sm px-2.5 py-1.5 rounded-md tabular-nums transition-colors"
                  :class="n === page + 1 ? 'bg-indigo-600/30 text-white' : 'text-slate-300 hover:bg-slate-800'"
                  @click="pick(n)"
                >
                  Página {{ n }}
                </button>
                <p v-if="!pageOptions.length" class="text-xs text-slate-500 px-2.5 py-2">Nenhuma página com esse número.</p>
              </div>
            </div>
          </template>
        </div>

        <div class="flex items-center gap-1">
          <button :class="TOOL" :disabled="zoom <= ZOOM_MIN" title="Diminuir (−)" @click="zoomOut">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 12h14" /></svg>
          </button>
          <button class="text-xs text-slate-300 tabular-nums w-12 text-center hover:text-white" title="Página inteira (0)" @click="fit">
            {{ Math.round(zoom * 100) }}%
          </button>
          <button :class="TOOL" :disabled="zoom >= ZOOM_MAX" title="Aumentar (+)" @click="zoomIn">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 5v14m-7-7h14" /></svg>
          </button>
          <button :class="TOOL" title="Página inteira na tela (0)" @click="fit">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" /></svg>
          </button>
          <button :class="[TOOL, 'ml-1']" title="Girar 90° (R)" @click="turn">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" /></svg>
          </button>
        </div>

        <button
          class="flex items-center gap-1.5 text-xs text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 rounded-lg px-3 py-1.5 font-medium transition-colors"
          :disabled="saving"
          :title="`Escolher a pasta e salvar a tradução (tema ${theme === 'dark' ? 'escuro' : 'claro'})`"
          @click="emit('save')"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12M12 16.5V3" /></svg>
          {{ saving ? 'Preparando…' : 'Salvar' }}
        </button>

        <button :class="TOOL" title="Fechar (Esc)" @click="emit('close')">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
      </div>

      <!-- páginas -->
      <div
        ref="viewer"
        class="flex-1 overflow-auto"
        :class="canPan ? (drag ? 'cursor-grabbing' : 'cursor-grab') : ''"
        @wheel="onWheel"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
      >
        <!-- centralizado quando cabe; com zoom, rola a partir do canto -->
        <div class="min-w-full min-h-full w-max flex items-center justify-center" :style="{ padding: `${PAD}px` }">
          <div class="flex items-start" :style="{ width: `${contentWidth}px`, gap: `${GAP}px` }">
            <div v-for="which in shown" :key="which" class="flex flex-col gap-2" :style="{ width: `${pageWidth}px` }">
              <p class="text-xs text-slate-500 uppercase tracking-wide h-5 truncate">
                {{ which === 'original' ? `Original · ${langName(job.from_code)}` : `Tradução · ${langName(job.to_code)}` }}
              </p>
              <div class="relative rounded-lg shadow-2xl overflow-hidden bg-slate-800" :style="{ height: `${pageWidth * aspect}px` }">
                <img
                  v-if="displayed[which]"
                  :src="displayed[which]"
                  class="w-full h-full pointer-events-none"
                  draggable="false"
                  alt=""
                />
                <div v-if="waiting || !displayed[which]" class="absolute inset-0 flex items-center justify-center bg-slate-900/30">
                  <div class="w-7 h-7 rounded-full border-2 border-slate-500 border-t-indigo-400 animate-spin" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div
        v-if="savedPath"
        class="absolute top-16 right-4 z-30 max-w-md text-xs text-emerald-300 bg-emerald-950/90 border border-emerald-700/50 rounded-lg px-3 py-2 shadow-xl"
      >
        Salvo em {{ savedPath }}
      </div>

      <p class="px-4 py-1.5 text-[11px] text-slate-600 border-t border-slate-800/80">
        Ctrl + roda do mouse para zoom · arraste para mover · ← → muda de página · R gira · T troca o tema · 0 página inteira
      </p>
    </div>
  </Teleport>
</template>
