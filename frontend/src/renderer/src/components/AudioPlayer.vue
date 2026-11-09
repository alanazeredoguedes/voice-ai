<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'

/** Player simples no estilo do app: tocar/pausar, posição (arrastável), tempo e velocidade. */
const props = defineProps<{
  src: string
  /** marcas na barra (ex.: os cortes de 1, 5, 8 e 20 min), em segundos */
  marks?: { at: number; label: string }[]
}>()

const audio = ref<HTMLAudioElement | null>(null)
const playing = ref(false)
const current = ref(0)
const duration = ref(0)
const dragging = ref<number | null>(null)
const rate = ref(1)
const RATE_MIN = 0.5
const RATE_MAX = 3
const RATE_STEP = 0.25

const position = computed(() => dragging.value ?? current.value)
const rateLabel = computed(() => `${rate.value.toFixed(2).replace(/0$/, '').replace('.', ',')}x`)

function fmt(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function toggle(): void {
  const a = audio.value
  if (!a) return
  if (a.paused) void a.play()
  else a.pause()
}

function onSeekInput(e: Event): void {
  dragging.value = Number((e.target as HTMLInputElement).value)
}

function onSeekChange(e: Event): void {
  const v = Number((e.target as HTMLInputElement).value)
  dragging.value = null
  if (audio.value) audio.value.currentTime = v
  current.value = v
}

function skip(delta: number): void {
  const a = audio.value
  if (!a) return
  a.currentTime = Math.min(Math.max(0, a.currentTime + delta), duration.value || a.currentTime + delta)
}

function setRate(v: number): void {
  rate.value = Math.min(RATE_MAX, Math.max(RATE_MIN, Math.round(v / RATE_STEP) * RATE_STEP))
  if (audio.value) audio.value.playbackRate = rate.value
}

function onLoaded(): void {
  if (audio.value) {
    duration.value = audio.value.duration || 0
    audio.value.playbackRate = rate.value
  }
}

onUnmounted(() => audio.value?.pause())
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <audio
      ref="audio"
      :src="props.src"
      preload="metadata"
      @loadedmetadata="onLoaded"
      @durationchange="onLoaded"
      @timeupdate="current = audio?.currentTime ?? 0"
      @play="playing = true"
      @pause="playing = false"
      @ended="playing = false"
    />
    <div class="flex items-center gap-2">
      <button
        :title="playing ? 'Pausar' : 'Tocar'"
        class="w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-full border border-indigo-600/50 bg-indigo-600/15 text-indigo-200 hover:bg-indigo-600/30 hover:text-white transition-colors"
        @click="toggle"
      >
        <svg v-if="!playing" class="w-3.5 h-3.5 ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
        <svg v-else class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
      </button>
      <button title="Voltar 10 segundos" class="text-[11px] text-slate-400 hover:text-slate-100 tabular-nums px-1" @click="skip(-10)">-10s</button>
      <div class="relative flex-1 min-w-0">
        <input
          type="range"
          min="0"
          :max="duration || 0"
          step="0.1"
          :value="position"
          title="Arraste para avançar ou voltar"
          class="w-full h-1 accent-indigo-500 cursor-pointer"
          @input="onSeekInput"
          @change="onSeekChange"
        />
        <!-- marcas dos cortes do teste -->
        <div v-if="duration && props.marks?.length" class="absolute left-0 right-0 top-full h-3 pointer-events-none">
          <span
            v-for="m in props.marks"
            :key="m.label"
            class="absolute -translate-x-1/2 text-[9px] text-slate-500 leading-none"
            :style="{ left: `${Math.min(100, (m.at / duration) * 100)}%` }"
          >▴{{ m.label }}</span>
        </div>
      </div>
      <button title="Avançar 10 segundos" class="text-[11px] text-slate-400 hover:text-slate-100 tabular-nums px-1" @click="skip(10)">+10s</button>
      <span class="text-[11px] text-slate-500 tabular-nums whitespace-nowrap w-[78px] text-right">{{ fmt(position) }} / {{ fmt(duration) }}</span>
      <!-- velocidade -->
      <div class="flex items-center gap-0.5 flex-shrink-0">
        <button
          title="Mais devagar"
          :disabled="rate <= RATE_MIN"
          class="w-5 h-5 flex items-center justify-center rounded border border-indigo-600/40 bg-indigo-600/10 text-indigo-300 hover:bg-indigo-600/30 disabled:opacity-30 text-xs leading-none"
          @click="setRate(rate - RATE_STEP)"
        >−</button>
        <button
          title="Velocidade do áudio. Clique para voltar ao normal"
          class="w-11 text-[11px] font-medium tabular-nums text-indigo-200 hover:text-white"
          @click="setRate(1)"
        >{{ rateLabel }}</button>
        <button
          title="Mais rápido"
          :disabled="rate >= RATE_MAX"
          class="w-5 h-5 flex items-center justify-center rounded border border-indigo-600/40 bg-indigo-600/10 text-indigo-300 hover:bg-indigo-600/30 disabled:opacity-30 text-xs leading-none"
          @click="setRate(rate + RATE_STEP)"
        >+</button>
      </div>
    </div>
  </div>
</template>
