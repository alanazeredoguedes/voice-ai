<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { DEFAULT_PEER_VOLUME, SELF, useCallStore } from '../stores/call'
import { formatVolume, sliderToVolume, volumeToSlider } from '../utils/callVolume'

/**
 * Menu do botão direito sobre a transmissão aberta: volume e mudo da transmissão e, abaixo, de cada
 * participante. Em tela cheia ele precisa ser desenhado dentro do elemento em tela cheia (`container`),
 * senão o navegador não mostra.
 */
const props = defineProps<{ x: number; y: number; title: string; container: HTMLElement | string }>()
const emit = defineEmits<{ close: [] }>()
const store = useCallStore()

const el = ref<HTMLElement | null>(null)
const WIDTH = 288
const pos = ref({ left: props.x, top: props.y })

// não deixa o menu sair da tela (mede depois de desenhar)
async function place(): Promise<void> {
  await nextTick()
  const h = el.value?.offsetHeight ?? 300
  pos.value = {
    left: Math.max(8, Math.min(props.x, window.innerWidth - WIDTH - 8)),
    top: Math.max(8, Math.min(props.y, window.innerHeight - h - 8))
  }
}

const style = computed(() => ({ left: `${pos.value.left}px`, top: `${pos.value.top}px`, width: `${WIDTH}px` }))
const watchingOther = computed(() => !!store.watching && store.watching !== SELF)

function onDown(e: MouseEvent): void {
  if (el.value && !el.value.contains(e.target as Node)) emit('close')
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopPropagation()
    emit('close')
  }
}
function onBlur(): void {
  emit('close')
}
onMounted(() => {
  void place()
  document.addEventListener('mousedown', onDown, true)
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('blur', onBlur)
})
onUnmounted(() => {
  document.removeEventListener('mousedown', onDown, true)
  window.removeEventListener('keydown', onKey, true)
  window.removeEventListener('blur', onBlur)
})

function setPeerVolume(peerId: string, e: Event): void {
  store.setVolume(peerId, sliderToVolume(parseFloat((e.target as HTMLInputElement).value)))
  if (store.mutedPeers.has(peerId)) store.togglePeerMute(peerId)
}
function setScreenVolume(e: Event): void {
  store.setScreenVolume(sliderToVolume(parseFloat((e.target as HTMLInputElement).value)))
}
</script>

<template>
  <Teleport :to="container">
    <div
      ref="el"
      :style="style"
      class="fixed z-[90] bg-slate-900/95 backdrop-blur border border-slate-700 rounded-xl shadow-2xl p-3 flex flex-col gap-3 max-h-[80vh] overflow-y-auto cursor-default"
      @contextmenu.prevent.stop
      @mousedown.stop
      @dblclick.stop
      @wheel.stop
      @click.stop
    >
      <!-- a transmissão aberta -->
      <div v-if="watchingOther" class="flex flex-col gap-1.5">
        <p class="text-xs text-slate-400 truncate">Som da transmissão de {{ title }}</p>
        <div class="flex items-center gap-2">
          <button
            :class="['p-1 rounded transition-colors', store.screenMuted ? 'text-red-400 hover:text-red-300' : 'text-slate-300 hover:text-white']"
            :title="store.screenMuted ? 'Ativar o som da transmissão' : 'Mutar a transmissão'"
            @click="store.toggleScreenMute()"
          >
            <svg v-if="store.screenMuted" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M17.25 9.75L19.5 12m0 0l2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-10.5-6l4.72-4.72a.75.75 0 011.28.531V19.94a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.506-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.395C2.806 8.757 3.63 8.25 4.51 8.25H6.75z" />
            </svg>
            <svg v-else class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
            </svg>
          </button>
          <input
            type="range"
            min="0"
            max="1"
            step="0.005"
            :value="volumeToSlider(store.screenVolume)"
            :class="['flex-1 h-1 accent-indigo-500 cursor-pointer', store.screenMuted ? 'opacity-40' : '']"
            @input="setScreenVolume"
          />
          <span class="text-xs text-slate-300 w-11 text-right">{{ formatVolume(store.screenVolume) }}</span>
        </div>
      </div>

      <!-- participantes -->
      <div class="flex flex-col gap-2" :class="watchingOther ? 'pt-2 border-t border-slate-800' : ''">
        <p class="text-xs text-slate-400">Voz dos participantes</p>
        <p v-if="!store.peers.length" class="text-xs text-slate-600">Ninguém mais na sala.</p>
        <div v-for="peer in store.peers" :key="peer.id" class="flex flex-col gap-1">
          <div class="flex items-center gap-2">
            <span class="text-sm text-slate-200 truncate flex-1">{{ peer.name }}</span>
            <span v-if="peer.muted" class="text-[11px] text-red-400">mudo</span>
          </div>
          <div class="flex items-center gap-2">
            <button
              :class="['p-1 rounded transition-colors', store.mutedPeers.has(peer.id) ? 'text-red-400 hover:text-red-300' : 'text-slate-300 hover:text-white']"
              :title="store.mutedPeers.has(peer.id) ? `Voltar a ouvir ${peer.name}` : `Silenciar ${peer.name} para mim`"
              @click="store.togglePeerMute(peer.id)"
            >
              <svg v-if="store.mutedPeers.has(peer.id)" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M17.25 9.75L19.5 12m0 0l2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-10.5-6l4.72-4.72a.75.75 0 011.28.531V19.94a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.506-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.395C2.806 8.757 3.63 8.25 4.51 8.25H6.75z" />
              </svg>
              <svg v-else class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
              </svg>
            </button>
            <input
              type="range"
              min="0"
              max="1"
              step="0.005"
              :value="volumeToSlider(store.peerVolumes[peer.id] ?? DEFAULT_PEER_VOLUME)"
              :class="['flex-1 h-1 accent-indigo-500 cursor-pointer', store.mutedPeers.has(peer.id) ? 'opacity-40' : '']"
              @input="setPeerVolume(peer.id, $event)"
            />
            <span class="text-xs text-slate-300 w-11 text-right">{{ formatVolume(store.peerVolumes[peer.id] ?? DEFAULT_PEER_VOLUME) }}</span>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
