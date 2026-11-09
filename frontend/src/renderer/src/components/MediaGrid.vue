<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type { MediaGroup, MediaItem } from '../types'
import { preloadImages } from '../utils/imagePreload'
import MediaLightbox from './MediaLightbox.vue'
import ImageMenu from './ImageMenu.vue'

const props = defineProps<{ groups: MediaGroup[] }>()

// Pré-carrega as imagens originais quando as miniaturas ficam visíveis (ou quase) na tela,
// assim o modal abre a imagem na hora. Mensagens antigas fora da tela não baixam nada.
const root = ref<HTMLElement | null>(null)
const onScreen = ref(false)
let observer: IntersectionObserver | null = null

function preloadVisibleGroups(): void {
  if (!onScreen.value) return
  const urls = props.groups
    .filter((g) => g.kind === 'image' && g.status === 'done')
    .flatMap((g) => g.items.map((it) => it.url))
  preloadImages(urls)
}

onMounted(() => {
  observer = new IntersectionObserver(
    (entries) => {
      onScreen.value = entries.some((e) => e.isIntersecting)
      if (onScreen.value) {
        preloadVisibleGroups()
        observer?.disconnect() // uma vez na tela já basta: a fila cuida do resto
      }
    },
    { rootMargin: '600px 0px' }
  )
  if (root.value) observer.observe(root.value)
})
onUnmounted(() => observer?.disconnect())

// a busca termina depois que a mensagem já está na tela ("buscando..." → miniaturas)
watch(() => props.groups.map((g) => `${g.group_id}:${g.status}:${g.items.length}`).join(), preloadVisibleGroups)

const PROVIDER_LABEL: Record<string, string> = {
  duckduckgo: 'DuckDuckGo',
  serper: 'Google',
  youtube: 'YouTube'
}

// Miniaturas que falharam ao carregar (some da grade)
const broken = reactive(new Set<string>())

const viewer = ref<{ items: MediaItem[]; index: number } | null>(null)

function visible(group: MediaGroup): MediaItem[] {
  return group.items.filter((it) => !broken.has(it.thumb))
}

// botão direito numa miniatura: copiar, baixar, copiar link, abrir fonte
const menu = ref<{ item: MediaItem; x: number; y: number } | null>(null)
function onThumbMenu(e: MouseEvent, item: MediaItem): void {
  e.preventDefault()
  menu.value = { item, x: e.clientX, y: e.clientY }
}

function open(group: MediaGroup, item: MediaItem): void {
  const items = visible(group)
  if (item.kind === 'image') preloadImages([item.url], true)
  viewer.value = { items, index: Math.max(0, items.indexOf(item)) }
}

function skeletonCount(group: MediaGroup): number {
  return group.kind === 'video' ? 3 : 4
}

function fmtDuration(s?: number | null): string {
  if (!s) return ''
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}
</script>

<template>
  <div ref="root" class="flex flex-col gap-3">
    <div v-for="group in groups" :key="group.group_id" class="flex flex-col gap-1.5">
      <!-- Rótulo da busca -->
      <div class="flex items-center gap-1.5 text-[11px] text-slate-500 min-w-0">
        <svg v-if="group.kind === 'image'" class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A1.5 1.5 0 0021.75 19.5V4.5A1.5 1.5 0 0020.25 3H3.75A1.5 1.5 0 002.25 4.5v15A1.5 1.5 0 003.75 21zM15.75 8.25h.008v.008h-.008V8.25z" />
        </svg>
        <svg v-else class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
        </svg>
        <span class="truncate" :title="group.query">{{ group.query }}</span>
        <span v-if="group.status === 'loading'" class="flex-shrink-0 text-slate-600">· buscando…</span>
        <span v-else-if="group.status === 'done' && group.provider" class="flex-shrink-0 text-slate-600">
          · via {{ PROVIDER_LABEL[group.provider] ?? group.provider }}
        </span>
      </div>

      <!-- Carregando -->
      <div v-if="group.status === 'loading'" :class="['grid gap-1.5', group.kind === 'video' ? 'grid-cols-3' : 'grid-cols-4']">
        <div
          v-for="n in skeletonCount(group)"
          :key="n"
          :class="['rounded-lg bg-slate-700/40 animate-pulse', group.kind === 'video' ? 'aspect-video' : 'aspect-square']"
        />
      </div>

      <!-- Erro / vazio -->
      <p
        v-else-if="group.status === 'error' || visible(group).length === 0"
        class="text-xs text-slate-500 italic"
      >
        {{ group.error || 'Nada encontrado' }} para "{{ group.query }}".
      </p>

      <!-- Imagens -->
      <div v-else-if="group.kind === 'image'" class="grid grid-cols-4 gap-1.5">
        <button
          v-for="item in visible(group)"
          :key="item.url"
          :title="`${item.title}
Clique para ampliar · botão direito para copiar ou baixar`"
          class="relative aspect-square overflow-hidden rounded-lg border border-slate-700/50 bg-slate-800 hover:border-indigo-500/70 focus:outline-none focus:ring-2 focus:ring-indigo-500/60 transition-colors group/thumb"
          @click="open(group, item)"
          @mouseenter="preloadImages([item.url], true)"
          @contextmenu="onThumbMenu($event, item)"
        >
          <img
            :src="item.thumb"
            :alt="item.title"
            loading="lazy"
            referrerpolicy="no-referrer"
            class="w-full h-full object-cover transition-transform duration-200 group-hover/thumb:scale-105"
            @error="broken.add(item.thumb)"
          />
        </button>
      </div>

      <!-- Vídeos -->
      <div v-else class="grid grid-cols-3 gap-1.5">
        <button
          v-for="item in visible(group)"
          :key="item.url"
          :title="item.title"
          class="flex flex-col text-left rounded-lg overflow-hidden border border-slate-700/50 bg-slate-800 hover:border-indigo-500/70 focus:outline-none focus:ring-2 focus:ring-indigo-500/60 transition-colors group/thumb"
          @click="open(group, item)"
        >
          <div class="relative aspect-video w-full overflow-hidden">
            <img
              :src="item.thumb"
              :alt="item.title"
              loading="lazy"
              class="w-full h-full object-cover"
              @error="broken.add(item.thumb)"
            />
            <div class="absolute inset-0 flex items-center justify-center bg-black/20 group-hover/thumb:bg-black/40 transition-colors">
              <div class="w-9 h-9 rounded-full bg-red-600/90 flex items-center justify-center shadow-lg">
                <svg class="w-4 h-4 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
              </div>
            </div>
            <span
              v-if="item.duration"
              class="absolute bottom-1 right-1 text-[10px] font-medium tabular-nums bg-black/75 text-white rounded px-1"
            >{{ fmtDuration(item.duration) }}</span>
          </div>
          <div class="px-2 py-1.5 min-w-0">
            <p class="text-[11px] text-slate-200 leading-snug line-clamp-2">{{ item.title }}</p>
            <p class="text-[10px] text-slate-500 truncate mt-0.5">{{ item.source }}</p>
          </div>
        </button>
      </div>
    </div>

    <ImageMenu v-if="menu" :item="menu.item" :x="menu.x" :y="menu.y" @close="menu = null" />

    <MediaLightbox
      v-if="viewer"
      v-model:index="viewer.index"
      :items="viewer.items"
      @close="viewer = null"
    />
  </div>
</template>
