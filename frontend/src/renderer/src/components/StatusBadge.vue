<script setup lang="ts">
import type { AppState } from '../types'

defineProps<{ state: AppState; size?: 'sm' | 'md' | 'lg' }>()

const labels: Record<AppState, string> = {
  idle: 'Pronto',
  recording: 'Gravando',
  processing: 'Processando',
  thinking: 'Pensando',
  speaking: 'Falando'
}

const colors: Record<AppState, string> = {
  idle: 'bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/40',
  recording: 'bg-orange-500/20 text-orange-400 ring-1 ring-orange-500/40 animate-pulse',
  processing: 'bg-yellow-500/20 text-yellow-400 ring-1 ring-yellow-500/40',
  thinking: 'bg-purple-500/20 text-purple-400 ring-1 ring-purple-500/40 animate-pulse',
  speaking: 'bg-cyan-500/20 text-cyan-400 ring-1 ring-cyan-500/40'
}

const dots: Record<AppState, string> = {
  idle: 'bg-emerald-400',
  recording: 'bg-orange-400',
  processing: 'bg-yellow-400',
  thinking: 'bg-purple-400',
  speaking: 'bg-cyan-400'
}
</script>

<template>
  <span
    :class="[
      'inline-flex items-center gap-2 rounded-full font-medium',
      colors[state],
      size === 'lg' ? 'px-5 py-2 text-base' : size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm'
    ]"
  >
    <span :class="['rounded-full', dots[state], size === 'lg' ? 'w-3 h-3' : 'w-2 h-2']" />
    {{ labels[state] }}
  </span>
</template>
