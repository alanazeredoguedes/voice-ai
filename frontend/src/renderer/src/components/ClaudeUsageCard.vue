<script setup lang="ts">
/** Barras do uso do plano do Claude: sessão atual (5 h) e limite semanal, com quando reiniciam. */
import { computed, onMounted } from 'vue'
import { WINDOW_LABEL, ago, barColor, refreshUsage, refreshing, resetText, startUsage, usage } from '../utils/claudeUsage'

onMounted(startUsage)

const ORDER = ['five_hour', 'seven_day', 'seven_day_sonnet', 'seven_day_opus']
const rows = computed(() => {
  const w = usage.value?.windows ?? {}
  return Object.keys(w)
    .sort((a, b) => (ORDER.indexOf(a) + 99) % 99 - (ORDER.indexOf(b) + 99) % 99)
    .map((k) => ({ key: k, label: WINDOW_LABEL[k] ?? k, ...w[k] }))
})
</script>

<template>
  <div class="flex flex-col gap-3">
    <template v-if="rows.length">
      <div v-for="r in rows" :key="r.key" class="flex flex-col gap-1">
        <div class="flex items-baseline justify-between gap-3">
          <span class="text-sm text-slate-200">{{ r.label }}</span>
          <span class="text-xs tabular-nums text-slate-300">{{ r.pct != null ? `${r.pct}% usado` : 'não informado' }}</span>
        </div>
        <div class="h-2 rounded-full bg-slate-800 overflow-hidden">
          <div :class="['h-full rounded-full transition-all duration-500', barColor(r.pct)]" :style="{ width: `${r.pct ?? 0}%` }" />
        </div>
        <span v-if="r.pct == null" class="text-[11px] text-slate-500">
          O Claude Code não informa esta porcentagem. Veja em claude.ai, Configurações, Uso.
        </span>
        <span v-else class="text-[11px] text-slate-500">{{ resetText(r.resets_at) }}</span>
      </div>
    </template>
    <p v-else class="text-xs text-slate-500">
      Ainda sem dados. Eles chegam junto com a próxima resposta da IA, ou clique em atualizar.
    </p>
    <div class="flex items-center gap-2 text-[11px] text-slate-500">
      <span v-if="usage">Atualizado {{ ago(usage.updated_at) }}</span>
      <button
        type="button"
        :disabled="refreshing"
        title="Atualizar agora (faz uma consulta mínima ao Claude, que gasta quase nada do limite)"
        class="flex items-center gap-1 px-1.5 py-0.5 rounded-md border border-slate-700 hover:border-indigo-500/60 hover:text-slate-200 disabled:opacity-60 transition-colors"
        @click="refreshUsage"
      >
        <svg :class="['w-3 h-3', refreshing ? 'animate-spin' : '']" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
        </svg>
        {{ refreshing ? 'Atualizando…' : 'Atualizar' }}
      </button>
    </div>
  </div>
</template>
