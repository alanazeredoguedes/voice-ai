<script setup lang="ts">
/**
 * Imagens/vídeos escolhidos pela IA (depois de ver a busca), no meio da resposta.
 * Imagens: sempre 8 quadradinhos por página (4 colunas x 2 linhas); se houver mais, rolam para o lado.
 * Vídeos: uma linha de 4; se houver mais, rolam para o lado.
 * Parar o mouse meio segundo em cima de uma imagem mostra uma prévia ampliada; clicar abre o visualizador.
 * Abaixo do bloco: Repesquisar (mesmo pedido, outras imagens) e Refinar (com o que o usuário quer).
 */
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type { MediaGroup, MediaItem } from '../types'
import { useChatStore } from '../stores/chat'
import { preloadImages, preloadStatus } from '../utils/imagePreload'
import MediaLightbox from './MediaLightbox.vue'
import ImageMenu from './ImageMenu.vue'
import VoiceNoteModal from './VoiceNoteModal.vue'

const props = defineProps<{ group: MediaGroup; messageId?: number }>()
const chat = useChatStore()

/** tempo com o mouse parado em cima da imagem até abrir a prévia */
const PREVIEW_DELAY_MS = 500
const PREVIEW_W = 572

const broken = reactive(new Set<string>())
const ok = (it: MediaItem): boolean => !broken.has(it.thumb)

const isVideo = computed(() => props.group.kind === 'video')
/** quantas cabem numa página: 8 imagens (4 x 2) ou 4 vídeos (uma linha) */
const perPage = computed(() => (isVideo.value ? 4 : 8))
// repesquisar/refinar: enquanto a IA confere, mostra as primeiras da nova busca (as antigas só voltam se der erro ou cancelar)
const refreshItems = computed(() => (props.group.refreshing && props.group.refreshPreview?.length ? props.group.refreshPreview : null))
const checking = computed(() => !!props.group.preview || !!refreshItems.value)
const chosen = computed(() => (refreshItems.value ?? props.group.items).filter(ok))
const extra = computed(() => (refreshItems.value ? [] : (props.group.more ?? [])).filter(ok))
/** o que aparece: as escolhidas e, se forem poucas (respostas antigas), completa com o resto da busca */
const shown = computed(() =>
  chosen.value.length >= perPage.value
    ? chosen.value
    : [...chosen.value, ...extra.value.slice(0, perPage.value - chosen.value.length)]
)
const pages = computed(() => {
  const out: MediaItem[][] = []
  for (let i = 0; i < shown.value.length; i += perPage.value) out.push(shown.value.slice(i, i + perPage.value))
  return out
})
/** muda quando as imagens mudam (repesquisa): refaz a grade com a animação de entrada */
const sig = computed(() => shown.value.map((it) => it.url).join('|'))

// a original (mais nítida) entra no lugar da miniatura assim que termina de carregar
const src = (it: MediaItem): string => (preloadStatus(it.url) === 'done' ? it.url : it.thumb)

// ---------- páginas (rolagem para o lado) ----------
// ref do TransitionGroup: o elemento fica em $el
const scroller = ref<{ $el?: HTMLElement } | HTMLElement | null>(null)
const scrollEl = (): HTMLElement | null => {
  const s = scroller.value
  return s ? ((s as { $el?: HTMLElement }).$el ?? (s as HTMLElement)) : null
}
const page = ref(0)

function onScroll(): void {
  hoverEnd()
  const el = scrollEl()
  if (el) page.value = Math.round(el.scrollLeft / Math.max(1, el.clientWidth))
}
function goPage(i: number): void {
  const el = scrollEl()
  if (!el) return
  const t = Math.max(0, Math.min(pages.value.length - 1, i))
  el.scrollTo({ left: t * el.clientWidth, behavior: 'smooth' })
}
watch(sig, () => {
  page.value = 0
})

// prévia (primeiras da busca) -> conferidas pela IA: o aviso "conferindo" vira "conferido" por um instante
const justVerified = ref(false)
function showVerified(): void {
  justVerified.value = true
  setTimeout(() => (justVerified.value = false), 1800)
}
watch(
  () => props.group.preview,
  (now, was) => {
    if (was && !now) showVerified()
  }
)
watch(() => props.group.verifiedTick, (now, was) => {
  if (now !== was) showVerified()
})

// originais da página atual e da próxima (as imagens podem chegar depois, quando a escolha termina)
watch(
  [sig, page],
  () => {
    if (isVideo.value) return
    const urls = [...(pages.value[page.value] ?? []), ...(pages.value[page.value + 1] ?? [])].map((it) => it.url)
    preloadImages(urls, true)
  },
  { immediate: true }
)

// ---------- visualizador ----------
const viewer = ref<{ items: MediaItem[]; index: number } | null>(null)
function open(item: MediaItem): void {
  hoverEnd()
  const items = shown.value
  if (item.kind === 'image') preloadImages([item.url], true)
  viewer.value = { items, index: Math.max(0, items.indexOf(item)) }
}

const menu = ref<{ item: MediaItem; x: number; y: number } | null>(null)
function onMenu(e: MouseEvent, item: MediaItem): void {
  e.preventDefault()
  hoverEnd()
  menu.value = { item, x: e.clientX, y: e.clientY }
}

// ---------- prévia ao parar o mouse ----------
const preview = ref<{ item: MediaItem; left: number; top?: number; bottom?: number } | null>(null)
let hoverTimer: ReturnType<typeof setTimeout> | null = null

function hoverEnd(): void {
  if (hoverTimer) {
    clearTimeout(hoverTimer)
    hoverTimer = null
  }
  preview.value = null
}

function hoverStart(e: MouseEvent, it: MediaItem): void {
  hoverEnd()
  const el = e.currentTarget as HTMLElement
  hoverTimer = setTimeout(() => {
    hoverTimer = null
    const r = el.getBoundingClientRect()
    const left = Math.max(8, Math.min(window.innerWidth - PREVIEW_W - 8, r.left + r.width / 2 - PREVIEW_W / 2))
    // em cima da imagem; se não couber, embaixo
    preview.value =
      r.top > 500
        ? { item: it, left, bottom: window.innerHeight - r.top + 8 }
        : { item: it, left, top: Math.min(r.bottom + 8, Math.max(8, window.innerHeight - 510)) }
    preloadImages([it.url], true)
  }, PREVIEW_DELAY_MS)
}

// rolar a conversa (ou clicar em qualquer lugar) fecha a prévia
onMounted(() => {
  window.addEventListener('scroll', hoverEnd, true)
  window.addEventListener('mousedown', hoverEnd, true)
})
onUnmounted(() => {
  hoverEnd()
  window.removeEventListener('scroll', hoverEnd, true)
  window.removeEventListener('mousedown', hoverEnd, true)
})

function host(it: MediaItem): string {
  const s = it.source || it.page_url || ''
  try {
    return new URL(s.includes('://') ? s : `https://${s}`).host.replace(/^www\./, '')
  } catch {
    return s
  }
}

function fmtDuration(s?: number | null): string {
  if (!s) return ''
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

// ---------- repesquisar / refinar por voz / cancelar (só este bloco; o resto da resposta não muda) ----------
const canRefresh = computed(() => props.messageId !== undefined)
const refining = ref(false)

function searchAgain(): void {
  refining.value = false
  if (props.messageId !== undefined) void chat.refreshMedia(props.messageId, props.group.group_id)
}

/** o modal de voz devolveu o que a pessoa quer: refaz a busca só deste bloco */
function onRefine(text: string): void {
  refining.value = false
  if (props.messageId !== undefined) void chat.refreshMedia(props.messageId, props.group.group_id, text)
}

const cancelSearch = (): void => chat.cancelRefreshMedia(props.group.group_id)

// tempo que levou para gerar este bloco (embaixo das imagens); o detalhe por etapa fica na dica
const fmtSec = (s: number): string => `${s.toFixed(s < 10 ? 1 : 0).replace('.', ',')} s`
const tookText = computed(() => (props.group.took_s ? `${isVideo.value ? 'Vídeos' : 'Imagens'} em ${fmtSec(props.group.took_s)}` : ''))
const tookTitle = computed(() => {
  const t = props.group.timing
  if (!t) return 'Tempo para gerar este bloco'
  const parts: string[] = []
  if (t.rewrite) parts.push(`reescrever a busca ${fmtSec(t.rewrite)}`)
  if (t.search !== undefined) parts.push(`buscar ${fmtSec(t.search)}${t.search_calls ? ` (${t.search_calls} ${t.search_calls > 1 ? 'chamadas' : 'chamada'} ao buscador)` : ''}`)
  if (t.preview !== undefined) parts.push(`prévia na tela em ${fmtSec(t.preview)}`)
  if (t.thumbs !== undefined) parts.push(`baixar as miniaturas ${fmtSec(t.thumbs)}`)
  if (t.judge !== undefined) parts.push(`a IA escolher e legendar ${fmtSec(t.judge)}`)
  const cost = t.tokens ? `. Gasto: ${(t.tokens / 1000).toFixed(1).replace('.', ',')} mil tokens, cerca de US$ ${(t.cost_usd ?? 0).toFixed(4)}` : ''
  return `Tempo para gerar este bloco: ${parts.join(', ')}${cost}`
})
</script>

<template>
  <!-- espaço reservado enquanto a busca e a escolha acontecem (o texto continua chegando embaixo) -->
  <div v-if="group.status === 'loading' && !shown.length" class="media-block" :title="`Procurando: ${group.query}`">
    <div v-if="isVideo" class="page vpage relative">
      <div v-for="k in 4" :key="k" class="aspect-video rounded-xl skeleton" />
      <span class="loading-label">Procurando os vídeos…</span>
    </div>
    <div v-else class="page ipage relative rounded-2xl overflow-hidden">
      <div v-for="k in 8" :key="k" class="tile skeleton" />
      <span class="loading-label">Procurando imagens…</span>
    </div>
  </div>

  <div v-else-if="shown.length" class="media-block group/mb">
    <div class="relative">
      <TransitionGroup
        ref="scroller"
        name="swap"
        tag="div"
        :class="['pages', group.refreshing && !refreshItems ? 'dimmed' : '', checking ? 'previewing' : '']"
        @scroll="onScroll"
      >
        <div
          v-for="(pg, pi) in pages"
          :key="`${sig}:${pi}`"
          :class="['page', isVideo ? 'vpage' : 'ipage']"
        >
          <!-- Vídeos: uma linha de 4 -->
          <template v-if="isVideo">
            <button
              v-for="(it, k) in pg"
              :key="it.url"
              :style="{ '--i': k }"
              :title="it.caption || it.title"
              class="tile-in flex flex-col text-left rounded-xl overflow-hidden border border-slate-700/50 bg-slate-800/80 hover:border-indigo-500/70 transition-colors group/v"
              @click="open(it)"
            >
              <div class="relative aspect-video w-full overflow-hidden bg-slate-900">
                <img :src="it.thumb" :alt="it.title" class="w-full h-full object-cover" @error="broken.add(it.thumb)" />
                <div class="absolute inset-0 flex items-center justify-center bg-black/15 group-hover/v:bg-black/35 transition-colors">
                  <div class="w-9 h-9 rounded-full bg-red-600/90 flex items-center justify-center shadow-lg">
                    <svg class="w-4 h-4 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                  </div>
                </div>
                <span v-if="it.duration" class="absolute bottom-2 right-2 text-[11px] font-medium tabular-nums bg-black/75 text-white rounded px-1.5">
                  {{ fmtDuration(it.duration) }}
                </span>
              </div>
              <div class="px-2.5 py-1.5 min-w-0">
                <p class="text-[12px] text-slate-200 leading-snug line-clamp-2">{{ it.caption || it.title }}</p>
                <p class="text-[11px] text-slate-500 truncate mt-0.5">{{ it.source }}</p>
              </div>
            </button>
          </template>

          <!-- Imagens: 8 quadradinhos (4 x 2) -->
          <template v-else>
            <button
              v-for="(it, k) in pg"
              :key="it.url"
              :style="{ '--i': k }"
              :aria-label="it.caption || it.title"
              class="tile tile-in group/t"
              @click="open(it)"
              @mouseenter="hoverStart($event, it)"
              @mouseleave="hoverEnd"
              @contextmenu="onMenu($event, it)"
            >
              <img
                :src="src(it)"
                :alt="it.title"
                referrerpolicy="no-referrer"
                class="w-full h-full object-cover transition-transform duration-300 group-hover/t:scale-[1.04]"
                @error="broken.add(it.thumb)"
              />
              <span v-if="host(it)" class="badge left-2">{{ host(it) }}</span>
            </button>
          </template>
        </div>
      </TransitionGroup>

      <!-- as primeiras da busca aparecem na hora; a IA confere (luz passando) e depois a seleção definitiva entra -->
      <div v-if="checking" class="scan" />
      <Transition name="pill" mode="out-in">
        <div v-if="checking" key="checking" class="verify-pill">
          <svg class="w-3.5 h-3.5 text-indigo-300 sparkle" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z" /></svg>
          {{ isVideo ? 'A IA está conferindo os vídeos…' : 'A IA está conferindo as imagens…' }}
          <button
            v-if="group.refreshing"
            class="ml-1 rounded-full border border-slate-600 hover:border-amber-400/70 hover:text-amber-200 px-2.5 py-0.5 transition-colors pointer-events-auto"
            title="Cancela a nova busca e volta para as imagens de antes"
            @click="cancelSearch"
          >Cancelar</button>
        </div>
        <div v-else-if="justVerified" key="verified" class="verify-pill ok">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.4" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
          Conferido pela IA
        </div>
      </Transition>

      <!-- setas (aparecem ao passar o mouse no bloco) -->
      <template v-if="pages.length > 1 && !group.refreshing && !checking">
        <button
          v-if="page > 0"
          title="Anteriores"
          class="arrow left-2"
          @click="goPage(page - 1)"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" /></svg>
        </button>
        <button
          v-if="page < pages.length - 1"
          title="Mais"
          class="arrow right-2"
          @click="goPage(page + 1)"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
        </button>
      </template>

      <!-- buscando de novo: as de antes ficam esmaecidas e dá para cancelar -->
      <div v-if="group.refreshing && !refreshItems" class="absolute inset-0 flex items-center justify-center">
        <div class="flex items-center gap-2 rounded-full bg-slate-900/85 backdrop-blur px-3.5 py-2 text-xs text-slate-200 shadow-xl border border-slate-700/70">
          <span class="w-3 h-3 rounded-full border-2 border-indigo-300/30 border-t-indigo-300 animate-spin" />
          {{ isVideo ? 'Procurando novos vídeos…' : 'Procurando novas imagens…' }}
          <button
            class="ml-1 rounded-full border border-slate-600 hover:border-amber-400/70 hover:text-amber-200 px-2.5 py-0.5 transition-colors"
            title="Cancela a nova busca e mantém estas imagens"
            @click="cancelSearch"
          >Cancelar</button>
        </div>
      </div>
    </div>

    <!-- botões deste bloco: o resto da resposta não muda -->
    <div v-if="(canRefresh || tookText) && !group.preview" class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
      <template v-if="!canRefresh" />
      <template v-else-if="group.refreshing">
        <button class="act text-amber-300/90 hover:text-amber-200" title="Cancela a nova busca e mantém o que já estava aqui" @click="cancelSearch">
          <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          Cancelar nova busca
        </button>
      </template>
      <template v-else>
        <button class="act" title="Busca de novo, sem repetir o que já está aqui" @click="searchAgain">
          <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" /></svg>
          Repesquisar
        </button>
        <button class="act" title="Fale como você quer isto (ex.: dentro do jogo, mais detalhado)" @click="refining = true">
          <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" /></svg>
          Refinar
        </button>
      </template>
      <span v-if="group.notice" class="text-amber-400/90">{{ group.notice }}. O que estava aqui continua.</span>
      <span v-if="tookText && !group.refreshing" class="text-slate-600 tabular-nums" :title="tookTitle">{{ tookText }}</span>
      <!-- bolinhas das páginas -->
      <span v-if="pages.length > 1" class="ml-auto flex items-center gap-1.5">
        <button
          v-for="(_, i) in pages"
          :key="i"
          :title="`Página ${i + 1} de ${pages.length}`"
          :class="['dot', i === page ? 'dot-on' : '']"
          @click="goPage(i)"
        />
      </span>
    </div>
    <VoiceNoteModal
      v-if="refining"
      :title="isVideo ? 'Fale a descrição do vídeo que você precisa' : 'Fale a descrição da imagem que você precisa'"
      text-label="O que vou buscar"
      :placeholder="isVideo ? 'Ex.: o vídeo do jogo completo, em português' : 'Ex.: dentro do jogo, com o jogo renderizado, como uma captura de tela'"
      action-label="Refinar"
      @submit="onRefine"
      @close="refining = false"
    />

    <ImageMenu v-if="menu" :item="menu.item" :x="menu.x" :y="menu.y" @close="menu = null" />
    <MediaLightbox v-if="viewer" v-model:index="viewer.index" :items="viewer.items" @close="viewer = null" />

    <!-- prévia ampliada (meio segundo com o mouse parado em cima da imagem) -->
    <Teleport to="body">
      <div
        v-if="preview"
        class="preview fixed z-40 pointer-events-none rounded-xl border border-slate-600/70 bg-slate-900/95 shadow-2xl shadow-black/60 p-2 flex flex-col gap-1.5"
        :style="{
          width: `${PREVIEW_W}px`,
          left: `${preview.left}px`,
          top: preview.top !== undefined ? `${preview.top}px` : undefined,
          bottom: preview.bottom !== undefined ? `${preview.bottom}px` : undefined
        }"
      >
        <img :src="src(preview.item)" :alt="preview.item.title" referrerpolicy="no-referrer" class="w-full max-h-[390px] object-contain rounded-lg bg-black/30" />
        <p class="px-1 text-[15px] leading-snug text-slate-100">{{ preview.item.caption || preview.item.title }}</p>
        <p class="px-1 text-[10.5px] text-indigo-300/80">Clique para ampliar</p>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* páginas lado a lado: rolam para o lado, uma de cada vez */
.pages {
  position: relative;
  display: flex;
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  scrollbar-width: none;
  border-radius: 1rem;
  transition: opacity 0.25s, filter 0.25s;
}
.pages::-webkit-scrollbar {
  display: none;
}
.pages.dimmed {
  opacity: 0.4;
  filter: blur(1.5px);
  pointer-events: none;
}
.page {
  flex: 0 0 100%;
  scroll-snap-align: start;
  min-width: 0;
}
/* imagens: 8 quadradinhos, 4 colunas x 2 linhas */
.ipage {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  grid-template-rows: repeat(2, minmax(0, 1fr));
  gap: 6px;
  height: 300px;
}
/* vídeos: uma linha de 4 */
.vpage {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  align-items: start;
}
/* carregando: brilho passando por cima do cinza */
.skeleton {
  background: linear-gradient(100deg, rgb(30 41 59) 30%, rgb(51 65 85 / 0.9) 50%, rgb(30 41 59) 70%);
  background-size: 300% 100%;
  animation: shimmer 1.6s ease-in-out infinite;
}
@keyframes shimmer {
  0% { background-position: 100% 0; }
  100% { background-position: -100% 0; }
}
.loading-label {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 12px;
  color: rgb(203 213 225);
  padding: 0.35rem 0.75rem;
  border-radius: 9999px;
  background: rgb(15 23 42 / 0.7);
  backdrop-filter: blur(4px);
  white-space: nowrap;
}
/* cada quadradinho entra com um pequeno atraso em sequência (a variável --i é a posição dele) */
.tile-in {
  animation: tile-in 0.55s cubic-bezier(0.2, 0.8, 0.2, 1) both;
  animation-delay: calc(var(--i, 0) * 55ms);
}
@keyframes tile-in {
  from { opacity: 0; transform: scale(0.9); filter: blur(8px); }
  to { opacity: 1; transform: none; filter: blur(0); }
}
/* troca da prévia pela seleção da IA: a prévia some suave e a nova entra em sequência */
.swap-leave-active {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  transition: opacity 0.3s ease, filter 0.3s ease;
}
.swap-leave-to {
  opacity: 0;
  filter: blur(6px);
}
/* prévia: um pouco apagada, sem clique, com uma luz passando enquanto a IA confere */
.pages.previewing {
  filter: saturate(0.6) brightness(0.82);
  pointer-events: none;
}
.scan {
  position: absolute;
  inset: 0;
  border-radius: 1rem;
  overflow: hidden;
  pointer-events: none;
  z-index: 5;
}
.scan::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: -40%;
  width: 35%;
  background: linear-gradient(100deg, transparent, rgb(129 140 248 / 0.32), transparent);
  animation: scan 1.7s ease-in-out infinite;
}
@keyframes scan {
  to { left: 110%; }
}
.verify-pill {
  position: absolute;
  left: 0.6rem;
  top: 0.6rem;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 0.45rem;
  font-size: 12px;
  color: rgb(224 231 255);
  padding: 0.35rem 0.8rem;
  border-radius: 9999px;
  background: rgb(15 23 42 / 0.88);
  border: 1px solid rgb(129 140 248 / 0.35);
  backdrop-filter: blur(6px);
  box-shadow: 0 4px 18px rgb(0 0 0 / 0.35);
}
.verify-pill.ok {
  color: rgb(167 243 208);
  border-color: rgb(52 211 153 / 0.45);
}
.sparkle {
  animation: sparkle 1.4s ease-in-out infinite;
}
@keyframes sparkle {
  0%, 100% { opacity: 0.5; transform: scale(0.9) rotate(0deg); }
  50% { opacity: 1; transform: scale(1.15) rotate(12deg); }
}
.pill-enter-active,
.pill-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}
.pill-enter-from,
.pill-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
.preview {
  animation: pop 0.14s ease-out;
}
@keyframes pop {
  from { opacity: 0; transform: scale(0.97); }
  to { opacity: 1; transform: none; }
}
.tile {
  position: relative;
  overflow: hidden;
  background: rgb(30 41 59);
  min-height: 0;
}
.tile:focus-visible {
  outline: 2px solid rgb(99 102 241);
  outline-offset: -2px;
}
.arrow {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border-radius: 9999px;
  background: rgb(15 23 42 / 0.85);
  border: 1px solid rgb(71 85 105 / 0.7);
  color: rgb(226 232 240);
  opacity: 0;
  transition: opacity 0.15s, background-color 0.15s;
}
.group\/mb:hover .arrow {
  opacity: 1;
}
.arrow:hover {
  background: rgb(30 41 59);
}
.dot {
  width: 0.4rem;
  height: 0.4rem;
  border-radius: 9999px;
  background: rgb(71 85 105);
  transition: background-color 0.15s, transform 0.15s;
}
.dot:hover {
  background: rgb(148 163 184);
}
.dot-on {
  background: rgb(165 180 252);
  transform: scale(1.25);
}
.act {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  color: rgb(100 116 139);
  transition: color 0.15s;
}
.act:hover {
  color: rgb(226 232 240);
}
.badge {
  position: absolute;
  bottom: 0.5rem;
  display: flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 11px;
  line-height: 1;
  padding: 0.3rem 0.5rem;
  border-radius: 9999px;
  background: rgb(15 23 42 / 0.75);
  color: rgb(226 232 240);
  backdrop-filter: blur(4px);
  max-width: 80%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
