<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { WhisperModel } from '../types'

const props = defineProps<{
  models: WhisperModel[]
  activeId?: string
  progress: Record<string, number>
  errors: Record<string, string>
}>()
const emit = defineEmits<{ select: [id: string]; download: [id: string]; remove: [id: string] }>()

const open = ref(false)
const root = ref<HTMLElement | null>(null)

const active = computed(() => props.models.find((m) => m.id === props.activeId))
const downloading = computed(() => props.models.filter((m) => m.downloading))

function fmtSize(mb: number): string {
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`
}

function choose(m: WhisperModel): void {
  if (!m.downloaded || m.downloading) return
  emit('select', m.id)
  open.value = false
}

// fecha ao clicar fora / Esc
function onDocClick(e: MouseEvent): void {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') open.value = false
}
onMounted(() => {
  document.addEventListener('mousedown', onDocClick)
  window.addEventListener('keydown', onKey)
})
onUnmounted(() => {
  document.removeEventListener('mousedown', onDocClick)
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div ref="root" class="relative h-full">
    <!-- Gatilho: mostra o modelo ativo -->
    <button
      type="button"
      :class="[
        'w-full h-full flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-colors',
        open ? 'border-indigo-500/60 bg-indigo-600/10' : 'border-slate-700/60 bg-slate-900/40 hover:border-indigo-500/60 hover:bg-indigo-600/10'
      ]"
      @click="open = !open"
    >
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <span class="text-xs text-slate-500">Modelo ativo:</span>
          <span class="text-sm font-medium text-slate-100">{{ active?.name ?? activeId ?? '-' }}</span>
          <span v-if="active" class="text-xs px-1.5 py-0.5 rounded bg-indigo-600/40 text-indigo-300">ativo</span>
        </div>
        <div v-if="active" class="flex items-center gap-2 mt-0.5 text-xs text-slate-500">
          <span>{{ fmtSize(active.size_mb) }}</span><span class="text-slate-700">·</span>
          <span>{{ active.speed }}</span><span class="text-slate-700">·</span>
          <span>Qualidade: {{ active.quality }}</span>
        </div>
        <p v-if="downloading.length && !open" class="text-xs text-indigo-400 mt-1">
          Baixando {{ downloading.map((m) => `${m.name} (${Math.round(progress[m.id] ?? 0)}%)`).join(', ') }}…
        </p>
      </div>
      <span class="text-xs text-slate-500 flex-shrink-0">{{ open ? 'Fechar' : 'Trocar modelo' }}</span>
      <svg :class="['w-4 h-4 text-slate-400 flex-shrink-0 transition-transform', open ? 'rotate-180' : '']" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
      </svg>
    </button>

    <!-- Lista de modelos -->
    <div
      v-if="open"
      class="absolute left-0 right-0 top-full mt-1.5 z-30 rounded-xl border border-slate-700 bg-slate-900 shadow-2xl p-1.5 flex flex-col gap-1 max-h-[420px] overflow-y-auto"
    >
      <div
        v-for="m in models"
        :key="m.id"
        :class="[
          'flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors',
          m.id === activeId ? 'bg-indigo-600/15' : m.downloaded && !m.downloading ? 'hover:bg-indigo-600/10 cursor-pointer' : ''
        ]"
        @click="choose(m)"
      >
        <!-- marcador de seleção -->
        <span
          :class="[
            'w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center flex-shrink-0',
            m.id === activeId ? 'border-indigo-400' : m.downloaded ? 'border-slate-500' : 'border-slate-700'
          ]"
        >
          <span v-if="m.id === activeId" class="w-1.5 h-1.5 rounded-full bg-indigo-400" />
        </span>

        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span :class="['text-sm', m.downloaded ? 'text-slate-200' : 'text-slate-400']">{{ m.name }}</span>
            <span v-if="m.downloaded" class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-600/25 text-emerald-400">baixado</span>
          </div>
          <div class="flex items-center gap-2 mt-0.5 text-xs text-slate-500">
            <span>{{ fmtSize(m.size_mb) }}</span><span class="text-slate-700">·</span>
            <span>{{ m.speed }}</span><span class="text-slate-700">·</span>
            <span>Qualidade: {{ m.quality }}</span>
          </div>
          <div v-if="m.downloading" class="mt-1.5">
            <div class="w-full bg-slate-700 rounded-full h-1">
              <div class="bg-indigo-500 h-1 rounded-full transition-all duration-500" :style="{ width: (progress[m.id] ?? 0) + '%' }" />
            </div>
            <span class="text-[11px] text-indigo-400">Baixando… {{ Math.round(progress[m.id] ?? 0) }}%</span>
          </div>
          <p v-if="errors[m.id]" class="text-xs text-red-400 mt-1">{{ errors[m.id] }}</p>
        </div>

        <!-- ações (não fecham a lista) -->
        <div class="flex items-center gap-1.5 flex-shrink-0" @click.stop>
          <button
            v-if="!m.downloaded && !m.downloading"
            class="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 text-white text-xs rounded-md transition-colors"
            @click="emit('download', m.id)"
          >Baixar</button>
          <span v-else-if="m.id === activeId" class="text-[11px] text-indigo-300 px-1">em uso</span>
          <button
            v-else-if="m.downloaded && !m.downloading"
            class="px-2.5 py-1 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs rounded-md transition-colors"
            @click="choose(m)"
          >Usar</button>
          <button
            v-if="m.downloaded && !m.downloading && m.id !== activeId"
            class="p-1 text-slate-500 hover:text-red-400 transition-colors"
            title="Remover modelo do computador"
            @click="emit('remove', m.id)"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
