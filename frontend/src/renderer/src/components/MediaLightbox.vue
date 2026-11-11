<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { MediaItem } from '../types'
import { preloadImages, preloadStatus } from '../utils/imagePreload'
import { copyImage, saveImage } from '../utils/imageActions'
import { stopSpeech } from '../api'
import ImageMenu from './ImageMenu.vue'

const props = defineProps<{ items: MediaItem[]; index: number }>()

// abriu um vídeo (ele começa a tocar): para a voz da IA para dar para ouvir o vídeo
watch(
  () => props.items[props.index]?.kind,
  (kind) => {
    if (kind === 'video') void stopSpeech().catch(() => undefined)
  },
  { immediate: true }
)
const emit = defineEmits<{ close: []; 'update:index': [value: number] }>()

const current = computed(() => props.items[props.index])
const hasMany = computed(() => props.items.length > 1)
const isImage = computed(() => current.value?.kind === 'image')

// Imagem em tamanho original: normalmente já foi pré-carregada quando as miniaturas apareceram
// (utils/imagePreload) e abre na hora. Se ainda não, mostra a miniatura até carregar; se o site
// bloquear, fica com a miniatura.
const loadedHere = ref(false)
const failedHere = ref(false)
const fullLoaded = computed(() => loadedHere.value || (current.value ? preloadStatus(current.value.url) === 'done' : false))
const fullFailed = computed(() => failedHere.value || (current.value ? preloadStatus(current.value.url) === 'error' : false))

const embedUrl = computed(() =>
  current.value?.video_id
    ? `https://www.youtube-nocookie.com/embed/${current.value.video_id}?autoplay=1&rel=0&enablejsapi=1`
    : ''
)

// vídeos sempre abrem com 30% de volume (nunca no máximo): o player do YouTube aceita o comando por postMessage
const VIDEO_VOLUME = 30
const ytFrame = ref<HTMLIFrameElement | null>(null)
function applyVideoVolume(): void {
  const w = ytFrame.value?.contentWindow
  if (!w) return
  w.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), '*')
  w.postMessage(JSON.stringify({ event: 'command', func: 'setVolume', args: [VIDEO_VOLUME] }), '*')
}
function onVideoLoad(): void {
  // o player demora um pouco para aceitar comandos: tenta algumas vezes
  for (const ms of [0, 400, 1200, 2500]) setTimeout(applyVideoVolume, ms)
}

function go(delta: number): void {
  if (!hasMany.value) return
  const n = props.items.length
  emit('update:index', (props.index + delta + n) % n)
}

function openExternal(url: string): void {
  // setWindowOpenHandler no processo main abre no navegador padrão
  if (url) window.open(url, '_blank')
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

// ao abrir e ao trocar de imagem: zoom/rotação voltam ao normal e as vizinhas são pré-carregadas.
// (fica depois do estado do zoom: com "immediate", roda já na criação do componente)
watch(
  () => props.index,
  () => {
    loadedHere.value = false
    failedHere.value = false
    resetView()
    // vizinhas primeiro, para as setas também serem instantâneas
    const n = props.items.length
    const near = [props.index, props.index + 1, props.index - 1]
      .map((i) => props.items[(i + n) % n])
      .filter((it) => it?.kind === 'image')
      .map((it) => it.url)
    preloadImages(near, true)
  },
  { immediate: true }
)

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

function zoomStep(dir: 1 | -1): void {
  setZoom(zoom.value * (dir > 0 ? 1.4 : 1 / 1.4))
}

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
function onPointerUp(): void {
  dragging.value = false
}

function rotate(): void {
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

// ---------- botão direito ----------
const menu = ref<{ x: number; y: number } | null>(null)
function onContextMenu(e: MouseEvent): void {
  if (!isImage.value) return
  e.preventDefault()
  menu.value = { x: e.clientX, y: e.clientY }
}

function onKey(e: KeyboardEvent): void {
  if (menu.value) return // o menu trata o Esc dele
  if (e.key === 'Escape') emit('close')
  else if (e.key === 'ArrowRight') go(1)
  else if (e.key === 'ArrowLeft') go(-1)
  else if (!isImage.value) return
  else if (e.key === '+' || e.key === '=') zoomStep(1)
  else if (e.key === '-') zoomStep(-1)
  else if (e.key === '0') resetView()
  else if (e.key.toLowerCase() === 'r') rotate()
}

onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-sm select-none"
      @click.self="emit('close')"
    >
      <!-- Topo: contador | ferramentas + fechar -->
      <div class="flex items-center justify-between gap-3 px-4 py-3 flex-shrink-0">
        <span class="text-xs text-slate-400 tabular-nums">
          <template v-if="hasMany">{{ index + 1 }} / {{ items.length }}</template>
        </span>
        <div class="flex items-center gap-1">
          <template v-if="current && isImage">
            <button title="Diminuir zoom (-)" :disabled="zoom <= MIN_ZOOM" class="tool" @click="zoomStep(-1)">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607zM13.5 10.5h-6" /></svg>
            </button>
            <button
              title="Ajustar à tela (0). Roda do mouse: zoom; arraste para mover; duplo clique alterna"
              class="tool w-14 text-[11px] font-medium tabular-nums"
              @click="resetView"
            >{{ zoomLabel }}</button>
            <button title="Aumentar zoom (+)" :disabled="zoom >= MAX_ZOOM" class="tool" @click="zoomStep(1)">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607zM10.5 7.5v6m3-3h-6" /></svg>
            </button>
            <button title="Girar 90° (R)" class="tool" @click="rotate">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" /></svg>
            </button>
            <span class="w-px h-5 bg-white/15 mx-1" />
            <button title="Copiar imagem (para colar no WhatsApp, e-mail...)" class="tool" @click="copyImage(current)">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 011.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 00-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 01-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 00-3.375-3.375h-1.5a1.125 1.125 0 01-1.125-1.125v-1.5a3.375 3.375 0 00-3.375-3.375H9.75" /></svg>
            </button>
            <button title="Baixar imagem (pasta Downloads)" class="tool" @click="saveImage(current)">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>
            </button>
            <span class="w-px h-5 bg-white/15 mx-1" />
          </template>
          <button title="Fechar (Esc)" class="tool" @click="emit('close')">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <!-- Conteúdo -->
      <div
        ref="stage"
        class="relative flex-1 min-h-0 flex items-center justify-center px-14 overflow-hidden"
        @click.self="onBackdropClick"
        @wheel="onWheel"
      >
        <button
          v-if="hasMany"
          title="Anterior (←)"
          class="absolute left-3 z-10 p-2.5 rounded-full bg-white/5 text-slate-200 hover:bg-white/15 transition-colors"
          @click="go(-1)"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
        </button>

        <template v-if="current">
          <!-- Vídeo do YouTube -->
          <div v-if="current.kind === 'video'" class="w-full max-w-4xl aspect-video rounded-xl overflow-hidden bg-black shadow-2xl">
            <iframe
              ref="ytFrame"
              :key="current.video_id"
              :src="embedUrl"
              @load="onVideoLoad"
              :title="current.title"
              class="w-full h-full"
              frameborder="0"
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              allowfullscreen
              referrerpolicy="strict-origin-when-cross-origin"
            />
          </div>

          <!-- Imagem (zoom/arrastar/girar) -->
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
            @contextmenu="onContextMenu"
            @dragstart.prevent
          >
            <img
              v-if="!fullLoaded || fullFailed"
              :src="current.thumb"
              :alt="current.title"
              referrerpolicy="no-referrer"
              class="max-w-full max-h-[calc(100vh-150px)] object-contain rounded-lg shadow-2xl"
              :class="{ 'blur-[1px] opacity-80': !fullFailed }"
            />
            <img
              v-if="!fullFailed"
              v-show="fullLoaded"
              :key="current.url"
              :src="current.url"
              :alt="current.title"
              referrerpolicy="no-referrer"
              class="max-w-full max-h-[calc(100vh-150px)] object-contain rounded-lg shadow-2xl"
              @load="loadedHere = true"
              @error="failedHere = true"
            />
            <div
              v-if="!fullLoaded && !fullFailed"
              class="absolute w-6 h-6 rounded-full border-2 border-white/30 border-t-white animate-spin"
            />
          </div>
        </template>

        <button
          v-if="hasMany"
          title="Próxima (→)"
          class="absolute right-3 z-10 p-2.5 rounded-full bg-white/5 text-slate-200 hover:bg-white/15 transition-colors"
          @click="go(1)"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
          </svg>
        </button>

      </div>

      <!-- Rodapé: título + abrir fora -->
      <div v-if="current" class="flex items-center justify-center gap-3 px-4 py-3 flex-shrink-0 min-w-0">
        <div class="min-w-0 text-center">
          <p v-if="current.caption" class="text-sm text-slate-100 max-w-[60vw]">{{ current.caption }}</p>
          <p :class="current.caption ? 'text-xs text-slate-400' : 'text-sm text-slate-200'" class="truncate max-w-[60vw]">{{ current.title }}</p>
          <p class="text-xs text-slate-500 truncate">{{ current.source }}</p>
        </div>
        <button
          class="flex-shrink-0 text-xs text-slate-300 hover:text-white border border-slate-600 hover:border-slate-400 rounded-lg px-3 py-1.5 transition-colors"
          @click="openExternal(current.page_url || current.url)"
        >
          {{ current.kind === 'video' ? 'Abrir no YouTube' : 'Abrir fonte' }}
        </button>
      </div>

      <ImageMenu v-if="menu && current" :item="current" :x="menu.x" :y="menu.y" @close="menu = null" />
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
