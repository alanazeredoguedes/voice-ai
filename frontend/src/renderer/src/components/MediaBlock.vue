<script setup lang="ts">
/**
 * Imagens/vídeos escolhidos pela IA (depois de ver a busca), no meio da resposta.
 * 1 imagem: grande · 2: lado a lado · 3: uma grande + duas empilhadas · 4 ou mais: três e um "+N".
 * Clicar abre o visualizador com todas (as escolhidas primeiro e o resto da busca depois).
 */
import { computed, reactive, ref, watch } from 'vue'
import type { MediaGroup, MediaItem } from '../types'
import { preloadImages, preloadStatus } from '../utils/imagePreload'
import MediaLightbox from './MediaLightbox.vue'
import ImageMenu from './ImageMenu.vue'

const props = defineProps<{ group: MediaGroup }>()

const broken = reactive(new Set<string>())
const ok = (it: MediaItem): boolean => !broken.has(it.thumb)

const chosen = computed(() => props.group.items.filter(ok))
const extra = computed(() => (props.group.more ?? []).filter(ok))
const all = computed(() => [...chosen.value, ...extra.value])

const isVideo = computed(() => props.group.kind === 'video')
/** layout das imagens: quantas aparecem e como */
/** até 5 na tela (uma grande + 4 à direita); o resto fica no "+N" do visualizador */
const shown = computed(() => chosen.value.slice(0, 5))
const hiddenCount = computed(() => all.value.length - shown.value.length)

// a original (mais nítida) entra no lugar da miniatura assim que termina de carregar
const src = (it: MediaItem): string => (preloadStatus(it.url) === 'done' ? it.url : it.thumb)

// originais das escolhidas (as imagens podem chegar depois, quando a escolha termina)
watch(
  () => chosen.value.map((it) => it.url).join(),
  () => {
    if (!isVideo.value) preloadImages(chosen.value.map((it) => it.url), true)
  },
  { immediate: true }
)

const viewer = ref<{ items: MediaItem[]; index: number } | null>(null)
function open(item: MediaItem): void {
  const items = all.value
  if (item.kind === 'image') preloadImages([item.url], true)
  viewer.value = { items, index: Math.max(0, items.indexOf(item)) }
}

const menu = ref<{ item: MediaItem; x: number; y: number } | null>(null)
function onMenu(e: MouseEvent, item: MediaItem): void {
  e.preventDefault()
  menu.value = { item, x: e.clientX, y: e.clientY }
}

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

const tileTitle = (it: MediaItem): string => `${it.title}\nClique para ampliar · botão direito para copiar ou baixar`
</script>

<template>
  <!-- espaço reservado enquanto a busca e a escolha acontecem (o texto continua chegando embaixo) -->
  <div v-if="group.status === 'loading'" class="media-block" :title="`Procurando: ${group.query}`">
    <div v-if="isVideo" class="relative aspect-video w-1/3 min-w-[220px] rounded-xl overflow-hidden skeleton">
      <span class="loading-label">Procurando o vídeo…</span>
    </div>
    <div v-else class="img-grid n5 relative">
      <div v-for="k in 5" :key="k" :class="['tile skeleton', `t${k - 1}`]" />
      <span class="loading-label">Procurando imagens…</span>
    </div>
  </div>
  <div v-else-if="chosen.length" class="media-block appear">
    <!-- Vídeos -->
    <!-- 3 por linha, cards compactos -->
    <div v-if="isVideo" class="grid grid-cols-3 gap-2">
      <button
        v-for="it in chosen"
        :key="it.url"
        :title="it.title"
        class="flex flex-col text-left rounded-xl overflow-hidden border border-slate-700/50 bg-slate-800/80 hover:border-indigo-500/70 transition-colors group/v"
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
          <p class="text-[12px] text-slate-200 leading-snug line-clamp-2">{{ it.title }}</p>
          <p class="text-[11px] text-slate-500 truncate mt-0.5">{{ it.source }}</p>
        </div>
      </button>
    </div>

    <!-- Imagens -->
    <div v-else :class="['img-grid', `n${shown.length}`]">
      <button
        v-for="(it, k) in shown"
        :key="it.url"
        :title="tileTitle(it)"
        :class="['tile group/t', `t${k}`]"
        @click="open(it)"
        @mouseenter="preloadImages([it.url], true)"
        @contextmenu="onMenu($event, it)"
      >
        <img
          :src="src(it)"
          :alt="it.title"
          referrerpolicy="no-referrer"
          class="w-full h-full object-cover transition-transform duration-300 group-hover/t:scale-[1.03]"
          @error="broken.add(it.thumb)"
        />
        <span v-if="host(it)" class="badge left-2">{{ host(it) }}</span>
        <span v-if="k === shown.length - 1 && hiddenCount > 0" class="badge right-2 font-semibold" title="Ver todas">
          <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A1.5 1.5 0 0021.75 19.5V4.5A1.5 1.5 0 0020.25 3H3.75A1.5 1.5 0 002.25 4.5v15A1.5 1.5 0 003.75 21z" />
          </svg>
          +{{ hiddenCount }}
        </span>
      </button>
    </div>

    <ImageMenu v-if="menu" :item="menu.item" :x="menu.x" :y="menu.y" @close="menu = null" />
    <MediaLightbox v-if="viewer" v-model:index="viewer.index" :items="viewer.items" @close="viewer = null" />
  </div>
</template>

<style scoped>
.img-grid {
  display: grid;
  gap: 6px;
  border-radius: 1rem;
  overflow: hidden;
  height: 300px;
}
.img-grid.n1 {
  grid-template-columns: 1fr;
  height: auto;
}
.img-grid.n1 .tile,
.img-grid.n1 .tile img {
  height: auto;
  max-height: 300px;
}
.img-grid.n2 {
  grid-template-columns: 1fr 1fr;
}
/* 3 a 5: uma grande à esquerda e as outras à direita (até 4, em 2 x 2), ocupando a largura toda */
.img-grid.n3,
.img-grid.n4,
.img-grid.n5 {
  grid-template-columns: 2fr 1fr 1fr;
  grid-template-rows: 1fr 1fr;
}
.img-grid.n3 .t0,
.img-grid.n4 .t0,
.img-grid.n5 .t0 {
  grid-row: span 2;
}
.img-grid.n3 .t1,
.img-grid.n3 .t2,
.img-grid.n4 .t1 {
  grid-column: span 2;
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
/* as imagens entram suaves quando a escolha termina */
.appear {
  animation: appear 0.45s ease-out;
}
@keyframes appear {
  from { opacity: 0; filter: blur(8px); transform: scale(0.99); }
  to { opacity: 1; filter: blur(0); transform: none; }
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
  max-width: 60%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
