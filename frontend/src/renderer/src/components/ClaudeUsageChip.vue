<script setup lang="ts">
/** Indicador compacto do uso do plano (sessão atual) na caixa de mensagem; clique abre os detalhes. */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { barColor, resetText, startUsage, usage } from '../utils/claudeUsage'
import ClaudeUsageCard from './ClaudeUsageCard.vue'

const open = ref(false)
const root = ref<HTMLElement | null>(null)
const session = computed(() => usage.value?.windows?.five_hour ?? null)
const week = computed(() => usage.value?.windows?.seven_day ?? null)

const title = computed(() => {
  if (!session.value) return 'Uso do plano do Claude: clique para ver'
  const lines = [`Sessão atual: ${session.value.pct ?? '?'}% usado. ${resetText(session.value.resets_at)}`]
  if (week.value) lines.push(`Limite semanal: ${week.value.pct ?? '?'}% usado. ${resetText(week.value.resets_at)}`)
  return lines.join('\n')
})

function onDocDown(e: MouseEvent): void {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false
}
onMounted(() => {
  startUsage()
  document.addEventListener('mousedown', onDocDown, true)
})
onUnmounted(() => document.removeEventListener('mousedown', onDocDown, true))
</script>

<template>
  <div ref="root" class="relative flex-shrink-0 self-end">
    <button
      type="button"
      :title="title"
      :class="[
        'flex items-center gap-1.5 h-7 px-2 rounded-lg border text-[11px] tabular-nums transition-colors',
        open ? 'border-indigo-500/70 bg-indigo-600/20 text-slate-100' : 'border-slate-700 hover:border-indigo-500/60 text-slate-400 hover:text-slate-200'
      ]"
      @click="open = !open"
    >
      <span class="w-8 h-1.5 rounded-full bg-slate-700 overflow-hidden">
        <span :class="['block h-full rounded-full', barColor(session?.pct)]" :style="{ width: `${session?.pct ?? 0}%` }" />
      </span>
      {{ session?.pct != null ? `${session.pct}%` : 'Uso' }}
    </button>
    <div
      v-if="open"
      class="absolute bottom-full right-0 mb-2 z-30 w-80 p-3.5 rounded-xl border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl shadow-black/50"
    >
      <p class="text-[10.5px] uppercase tracking-wide text-slate-500 mb-2.5">Uso do plano do Claude</p>
      <ClaudeUsageCard />
    </div>
  </div>
</template>
