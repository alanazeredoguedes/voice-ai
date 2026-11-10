<script setup lang="ts">
/**
 * Seletor do modelo do Claude, no começo da caixa de mensagem do Chat IA.
 * A escolha vale para todos os chats (configuração global, a mesma das Configurações) e só para este app:
 * o Claude Code usado fora daqui continua com o modelo dele.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useSettingsStore } from '../stores/settings'
import { getClaudeModel } from '../api'
import { onWsMessage } from '../api/ws'
import { CLAUDE_MODEL_OPTIONS, DEFAULT_CLAUDE_MODEL, prettyModel, type ClaudeModelChoice } from '../utils/claudeModels'

const settings = useSettingsStore()
const open = ref(false)
const root = ref<HTMLElement | null>(null)
/** nome real de cada escolha (ex.: haiku → claude-haiku-5-5), conhecido depois que ela respondeu uma vez */
const resolved = ref<Record<string, string>>({})

const selected = computed<ClaudeModelChoice>(() => settings.settings?.claude_model || DEFAULT_CLAUDE_MODEL)

function nameOf(v: ClaudeModelChoice): string {
  return prettyModel(resolved.value[v]) || CLAUDE_MODEL_OPTIONS.find((o) => o.value === v)!.label
}

const label = computed(() => nameOf(selected.value))

async function refresh(): Promise<void> {
  try {
    resolved.value = (await getClaudeModel()).resolved
  } catch {
    // sem a informação: mostra só o apelido
  }
}

async function choose(v: ClaudeModelChoice): Promise<void> {
  open.value = false
  if (v !== selected.value) await settings.update({ claude_model: v })
}

function onDocDown(e: MouseEvent): void {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false
}

// depois de cada resposta, o backend sabe qual modelo respondeu de verdade
const unsub = onWsMessage((e) => {
  if (e.type === 'chat_chunk' && e.done) void refresh()
})

onMounted(() => {
  if (!settings.settings) void settings.fetchSettings()
  void refresh()
  document.addEventListener('mousedown', onDocDown, true)
})
onUnmounted(() => {
  unsub()
  document.removeEventListener('mousedown', onDocDown, true)
})
</script>

<template>
  <div ref="root" class="relative flex-shrink-0 self-end">
    <button
      type="button"
      :title="`Modelo do Claude usado no Chat IA: ${label}. Vale para todos os chats, só neste app. Clique para trocar`"
      :class="[
        'flex items-center gap-1 h-7 pl-2 pr-1.5 rounded-lg border text-[11.5px] font-medium transition-colors whitespace-nowrap',
        open
          ? 'border-indigo-500/70 bg-indigo-600/25 text-indigo-100'
          : 'border-indigo-600/40 bg-indigo-600/10 text-indigo-200 hover:border-indigo-500/70 hover:bg-indigo-600/20'
      ]"
      @click="open = !open"
    >
      <svg class="w-3.5 h-3.5 opacity-80" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
      </svg>
      {{ label }}
      <svg :class="['w-3 h-3 opacity-70 transition-transform', open ? 'rotate-180' : '']" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
      </svg>
    </button>

    <!-- lista abre para cima (a caixa de mensagem fica no rodapé) -->
    <div
      v-if="open"
      class="absolute bottom-full left-0 mb-2 z-30 w-72 p-1 rounded-xl border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl shadow-black/50"
    >
      <p class="px-2.5 pt-1.5 pb-1 text-[10.5px] uppercase tracking-wide text-slate-500">Modelo do Claude (todos os chats)</p>
      <button
        v-for="o in CLAUDE_MODEL_OPTIONS"
        :key="o.value"
        type="button"
        :class="[
          'w-full flex items-start gap-2 text-left px-2.5 py-2 rounded-lg transition-colors',
          o.value === selected ? 'bg-indigo-600/20' : 'hover:bg-slate-800'
        ]"
        @click="choose(o.value)"
      >
        <span class="mt-1 w-3.5 flex-shrink-0">
          <svg v-if="o.value === selected" class="w-3.5 h-3.5 text-indigo-300" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />
          </svg>
        </span>
        <span class="min-w-0">
          <span class="block text-sm text-slate-100">{{ nameOf(o.value) }}</span>
          <span class="block text-[11px] text-slate-400 leading-snug mt-0.5">{{ o.description }}</span>
        </span>
      </button>
      <p class="px-2.5 pt-1.5 pb-1 text-[10.5px] text-slate-500 leading-snug border-t border-slate-800 mt-1">
        Só neste app: o Claude Code usado fora daqui não muda.
      </p>
    </div>
  </div>
</template>
