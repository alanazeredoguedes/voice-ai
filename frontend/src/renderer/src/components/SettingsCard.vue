<script setup lang="ts">
import { computed, ref, useSlots, watch } from 'vue'

/**
 * Card da tela de Configurações: mostra o essencial e guarda o resto em "Mais opções".
 * O que fica aberto é lembrado neste computador.
 */
const props = defineProps<{ id: string; title: string; subtitle?: string; advanced?: boolean }>()
const slots = useSlots()

const KEY = `settings.open.${props.id}`
function load(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}
const open = ref(load())
watch(open, (v) => {
  try {
    localStorage.setItem(KEY, v ? '1' : '0')
  } catch {
    // sem armazenamento local: só não lembra
  }
})

const hasAdvanced = computed(() => props.advanced || !!slots.advanced)
</script>

<template>
  <section class="bg-slate-800/60 rounded-2xl border border-slate-700/40 flex flex-col">
    <div class="p-5 flex flex-col gap-4">
      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0">
          <h2 class="text-xs font-semibold text-slate-400 uppercase tracking-widest">{{ title }}</h2>
          <p v-if="subtitle" class="text-xs text-slate-500 mt-1">{{ subtitle }}</p>
        </div>
        <slot name="aside" />
      </div>
      <slot :expanded="open" />
      <div v-if="open && slots.advanced" class="flex flex-col gap-4 pt-4 border-t border-slate-700/40">
        <slot name="advanced" />
      </div>
    </div>
    <button
      v-if="hasAdvanced"
      class="flex items-center justify-center gap-1.5 py-2 text-xs text-slate-500 hover:text-slate-200 border-t border-slate-700/40 hover:bg-slate-700/20 rounded-b-2xl transition-colors"
      @click="open = !open"
    >
      {{ open ? 'Menos opções' : 'Mais opções' }}
      <svg :class="['w-3.5 h-3.5 transition-transform', open && 'rotate-180']" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
      </svg>
    </button>
  </section>
</template>
