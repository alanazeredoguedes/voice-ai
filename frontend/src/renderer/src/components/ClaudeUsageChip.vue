<script setup lang="ts">
/** Indicador compacto do uso do plano (sessão atual) na caixa de mensagem; clique abre os detalhes. */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { resetText, startUsage, usage } from '../utils/claudeUsage'
import ClaudeUsageCard from './ClaudeUsageCard.vue'

const open = ref(false)
const root = ref<HTMLElement | null>(null)
const session = computed(() => usage.value?.windows?.five_hour ?? null)
const week = computed(() => usage.value?.windows?.seven_day ?? null)
// só a porcentagem; se o Claude Code não informar a da sessão (acontece), mostra a semanal, com "sem."
const shown = computed(() => {
  if (session.value?.pct != null) return { pct: session.value.pct, label: `${session.value.pct}%` }
  if (week.value?.pct != null) return { pct: week.value.pct, label: `${week.value.pct}% sem.` }
  return null
})
// muda de cor quando o limite aperta (60% amarelo, 85% vermelho)
const pctColor = computed(() => {
  const p = shown.value?.pct ?? 0
  return p >= 85 ? "text-red-300" : p >= 60 ? "text-amber-300" : ""
})

const title = computed(() => {
  if (!shown.value) return 'Uso do plano do Claude: clique para ver'
  const lines = [
    session.value?.pct != null
      ? `Sessão atual: ${session.value.pct}% usado. ${resetText(session.value.resets_at)}`
      : 'Sessão atual: o Claude Code não informa esta porcentagem (veja em claude.ai, Configurações, Uso)'
  ]
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
      <span :class="pctColor">{{ shown?.label ?? 'Uso' }}</span>
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
