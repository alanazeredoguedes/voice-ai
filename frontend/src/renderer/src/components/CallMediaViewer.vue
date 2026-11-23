<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

/**
 * Imagens e vídeos do chat da chamada em tamanho grande, como no Chat IA: zoom (roda do mouse, + e -),
 * arrastar, girar, duplo clique, setas para passar de uma para a outra e contador. Passa por todas as
 * imagens e vídeos da conversa que já estão neste computador.
 */
export interface ViewerItem {
  url: string
  name: string
  video: boolean
}

const props = defineProps<{ items: ViewerItem[]; index: number }>()
const emit = defineEmits<{ close: []; 'update:index': [value: number]; download: [index: number]; copy: [index: number] }>()

const current = computed(() => props.items[props.index])
const hasMany = computed(() => props.items.length > 1)
const isImage = computed(() => !!current.value && !current.value.video)

function go(delta: number): void {
  if (!hasMany.value) return
  const n = props.items.length
  emit('update:index', (props.index + delta + n) % n)
}

// ---------- zoom, arrastar e girar ----------
const MIN_ZOOM = 1
const MAX_ZOOM = 8
const zoom = ref(1)
const tx = ref(0)
const ty = ref(0)
const rotation = ref(0)
const dragging = ref(false)
let dragStart = { x: 0, y: 0, tx: 0, ty: 0 }
let moved = false
const stage = ref<HTMLElement | null>(null)

const transform = computed(() => `translate(${tx.value}px, ${ty.value}px) scale(${zoom.value}) rotate(${rotation.value}deg)`)
const zoomLabel = computed(() => `${Math.round(zoom.value * 100)}%`)

function resetView(): void {
  zoom.value = 1
  tx.value = 0
  ty.value = 0
  rotation.value = 0
}
// trocou de imagem: zoom e rotação voltam ao normal
watch(() => props.index, resetView)

/** Zoom mantendo parado o ponto sob o cursor (ou o centro, pelos botões) */
function setZoom(next: number, cx?: number, cy?: number): void {
  const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next))
  const rect = stage.value?.getBoundingClientRect()
  if (rect) {
    const px = (cx ?? rect.left + rect.width / 2) - (rect.left + rect.width / 2)
    const py = (cy ?? rect.top + rect.height / 2) - (rect.top + rect.height / 2)
    const k = z / zoom.value
    tx.value = px - (px - tx.value) * k
    ty.value = py - (py - ty.value) * k
  }
  zoom.value = z
  if (z === 1) {
    tx.value = 0
    ty.value = 0
  }
}
const zoomStep = (dir: 1 | -1): void => setZoom(zoom.value * (dir > 0 ? 1.4 : 1 / 1.4))

function onWheel(e: WheelEvent): void {
  if (!isImage.value) return
  e.preventDefault()
  setZoom(zoom.value * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY)
}
function onDblClick(e: MouseEvent): void {
  if (zoom.value > 1) resetView()
  else setZoom(2.5, e.clientX, e.clientY)
}
function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0 || zoom.value <= 1) return
  dragging.value = true
  moved = false
  dragStart = { x: e.clientX, y: e.clientY, tx: tx.value, ty: ty.value }
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}
function onPointerMove(e: PointerEvent): void {
  if (!dragging.value) return
  const dx = e.clientX - dragStart.x
  const dy = e.clientY - dragStart.y
  if (Math.abs(dx) + Math.abs(dy) > 3) moved = true
  tx.value = dragStart.tx + dx
  ty.value = dragStart.ty + dy
}
const onPointerUp = (): void => {
  dragging.value = false
}
const rotate = (): void => {
  rotation.value = (rotation.value + 90) % 360
}
/** clique no fundo fecha, mas não depois de arrastar a imagem */
function onBackdropClick(): void {
  if (moved) {
    moved = false
    return
  }
  emit('close')
}

// ---------- tela cheia (o ESC sai dela; só um segundo ESC fecha o visualizador) ----------
const root = ref<HTMLElement | null>(null)
const isFullscreen = ref(false)
const onFullscreenChange = (): void => {
  isFullscreen.value = !!root.value && document.fullscreenElement === root.value
}
async function toggleFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement === root.value) await document.exitFullscreen()
    else await root.value?.requestFullscreen()
  } catch {
    // o sistema recusou a tela cheia: segue no visualizador normal
  }
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    if (isFullscreen.value) void document.exitFullscreen().catch(() => {})
    else emit('close')
  } else if (e.key.toLowerCase() === 'f' && !e.ctrlKey && !e.metaKey) void toggleFullscreen()
  else if (e.key === 'ArrowRight') go(1)
  else if (e.key === 'ArrowLeft') go(-1)
  else if (!isImage.value) return
  else if (e.key === '+' || e.key === '=') zoomStep(1)
  else if (e.key === '-') zoomStep(-1)
  else if (e.key === '0') resetView()
  else if (e.key.toLowerCase() === 'r') rotate()
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  document.addEventListener('fullscreenchange', onFullscreenChange)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKey)
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  // fechou o visualizador em tela cheia: sai dela também
  if (root.value && document.fullscreenElement === root.value) void document.exitFullscreen().catch(() => {})
})
</script>

<template>
  <Teleport to="body">
    <div ref="root" class="fixed inset-0 z-[70] bg-black/85 backdrop-blur-sm flex flex-col select-none" @click.self="emit('close')">
      <!-- Topo: contador e nome | ferramentas + fechar -->
      <div class="flex items-center justify-between gap-3 px-4 py-3 flex-shrink-0">
        <div class="flex items-center gap-3 min-w-0">
          <span v-if="hasMany" class="text-xs text-slate-400 tabular-nums flex-shrink-0">{{ index + 1 }} / {{ items.length }}</span>
          <p v-if="current" class="text-sm text-slate-200 truncate">{{ current.name }}</p>
        </div>
        <div class="flex items-center gap-1 flex-shrink-0">
          <template v-if="current && isImage">
            <button title="Diminuir zoom (-)" :disabled="zoom <= MIN_ZOOM" class="tool" @click="zoomStep(-1)">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607zM13.5 10.5h-6" /></svg>
            </button>
            <button title="Ajustar à tela (0). Roda do mouse: zoom; arraste para mover; duplo clique alterna" class="tool w-14 text-[11px] font-medium tabular-nums" @click="resetView">{{ zoomLabel }}</button>
            <button title="Aumentar zoom (+)" :disabled="zoom >= MAX_ZOOM" class="tool" @click="zoomStep(1)">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607zM10.5 7.5v6m3-3h-6" /></svg>
            </button>
            <button title="Girar 90° (R)" class="tool" @click="rotate">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" /></svg>
            </button>
            <span class="w-px h-5 bg-white/15 mx-1" />
            <button title="Copiar a imagem (para colar em outro lugar com Ctrl+V)" class="tool" @click="emit('copy', index)">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 011.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 00-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 01-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 00-3.375-3.375h-1.5a1.125 1.125 0 01-1.125-1.125v-1.5a3.375 3.375 0 00-3.375-3.375H9.75" /></svg>
            </button>
          </template>
          <button :title="isFullscreen ? 'Sair da tela cheia (Esc)' : 'Tela cheia (F)'" class="tool" @click="toggleFullscreen">
            <svg v-if="!isFullscreen" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" /></svg>
            <svg v-else class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" /></svg>
          </button>
          <button title="Baixar" class="tool" @click="emit('download', index)">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>
          </button>
          <span class="w-px h-5 bg-white/15 mx-1" />
          <button title="Fechar (Esc)" class="tool" @click="emit('close')">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
      </div>

      <!-- Conteúdo -->
      <div ref="stage" class="relative flex-1 min-h-0 flex items-center justify-center px-14 pb-6 overflow-hidden" @click.self="onBackdropClick" @wheel="onWheel">
        <button v-if="hasMany" title="Anterior (←)" class="absolute left-3 z-10 p-2.5 rounded-full bg-white/5 text-slate-200 hover:bg-white/15 transition-colors" @click="go(-1)">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" /></svg>
        </button>

        <template v-if="current">
          <video v-if="current.video" :key="current.url" :src="current.url" controls autoplay class="max-w-full max-h-full rounded-lg" />
          <div
            v-else
            :class="[
              'relative max-w-full max-h-full flex items-center justify-center',
              zoom > 1 ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-zoom-in',
              dragging ? '' : 'transition-transform duration-150 ease-out'
            ]"
            :style="{ transform }"
            @dblclick="onDblClick"
            @pointerdown="onPointerDown"
            @pointermove="onPointerMove"
            @pointerup="onPointerUp"
            @pointercancel="onPointerUp"
            @dragstart.prevent
          >
            <img :key="current.url" :src="current.url" :alt="current.name" class="max-w-full max-h-[calc(100vh-110px)] object-contain rounded-lg shadow-2xl" />
          </div>
        </template>

        <button v-if="hasMany" title="Próxima (→)" class="absolute right-3 z-10 p-2.5 rounded-full bg-white/5 text-slate-200 hover:bg-white/15 transition-colors" @click="go(1)">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
        </button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.tool {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 2.25rem;
  height: 2.25rem;
  padding: 0 0.4rem;
  border-radius: 0.6rem;
  color: #cbd5e1;
  transition: background-color 0.15s, color 0.15s;
}
.tool:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}
.tool:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
</style>
