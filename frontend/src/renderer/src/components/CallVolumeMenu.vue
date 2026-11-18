<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { formatVolume, sliderToVolume, volumeToSlider } from '../utils/callVolume'

/** Menu do botão direito: volume (0 a 400%, com mais precisão nos volumes baixos) e mudo, só para quem está ouvindo. */
const props = defineProps<{ x: number; y: number; title: string; volume: number; muted: boolean; muteLabel: string }>()
const emit = defineEmits<{ volume: [value: number]; mute: []; close: [] }>()

const el = ref<HTMLElement | null>(null)
const WIDTH = 256
const HEIGHT = 140
// não deixa o menu sair da janela
const style = computed(() => ({
  left: `${Math.min(props.x, window.innerWidth - WIDTH - 8)}px`,
  top: `${Math.min(props.y, window.innerHeight - HEIGHT - 8)}px`,
  width: `${WIDTH}px`
}))

function onDown(e: MouseEvent): void {
  if (el.value && !el.value.contains(e.target as Node)) emit('close')
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => {
  document.addEventListener('mousedown', onDown, true)
  window.addEventListener('keydown', onKey)
  window.addEventListener('blur', onBlur)
})
onUnmounted(() => {
  document.removeEventListener('mousedown', onDown, true)
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('blur', onBlur)
})
function onBlur(): void {
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <div
      ref="el"
      :style="style"
      class="fixed z-[80] bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-3 flex flex-col gap-3"
      @contextmenu.prevent
    >
      <p class="text-xs text-slate-400 truncate">{{ title }}</p>
      <div class="flex items-center gap-2">
        <svg class="w-4 h-4 text-slate-400 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
        </svg>
        <input
          type="range"
          min="0"
          max="1"
          step="0.005"
          :value="volumeToSlider(volume)"
          :class="['flex-1 h-1 accent-indigo-500 cursor-pointer', muted ? 'opacity-40' : '']"
          @input="emit('volume', sliderToVolume(parseFloat(($event.target as HTMLInputElement).value)))"
        />
        <span class="text-xs text-slate-300 w-11 text-right">{{ formatVolume(volume) }}</span>
      </div>
      <button
        :class="[
          'flex items-center justify-between px-2.5 py-2 rounded-lg text-xs transition-colors',
          muted ? 'bg-red-600/15 text-red-300 hover:bg-red-600/25' : 'text-slate-200 hover:bg-slate-800'
        ]"
        @click="emit('mute')"
      >
        {{ muteLabel }}
        <span
          :class="['relative inline-flex items-center w-8 h-[18px] rounded-full transition-colors', muted ? 'bg-red-600' : 'bg-slate-700']"
        >
          <span :class="['inline-block w-3.5 h-3.5 rounded-full bg-white transition-transform', muted ? 'translate-x-4' : 'translate-x-0.5']" />
        </span>
      </button>
    </div>
  </Teleport>
</template>
