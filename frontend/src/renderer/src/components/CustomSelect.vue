<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'

/** Select padrão do app (mesmo visual do seletor de modelos do Whisper). */
interface SelectOption {
  value: string
  label: string
  description?: string
}

const props = withDefaults(
  defineProps<{
    modelValue?: string | null
    options: SelectOption[]
    placeholder?: string
    /** md: alto, com descrição (cards de configuração) | sm: compacto, uma linha */
    size?: 'md' | 'sm'
    /** lado em que a lista abre (útil quando o select fica encostado à direita) */
    align?: 'left' | 'right'
  }>(),
  { size: 'md', align: 'left' }
)
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const open = ref(false)
const root = ref<HTMLElement | null>(null)
const list = ref<HTMLElement | null>(null)
const current = computed(() => props.options.find((o) => o.value === props.modelValue))

async function toggle(): Promise<void> {
  open.value = !open.value
  if (open.value) {
    // listas longas (ex.: idiomas): já abre rolada na opção escolhida
    await nextTick()
    list.value?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }
}

function choose(o: SelectOption): void {
  open.value = false
  if (o.value !== props.modelValue) emit('update:modelValue', o.value)
}

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
  <div ref="root" class="relative flex flex-col">
    <button
      type="button"
      :class="[
        'w-full flex items-center border text-left transition-colors',
        size === 'md' ? 'flex-1 gap-3 px-4 py-3 rounded-xl' : 'gap-2 px-3 py-2 rounded-lg',
        open ? 'border-indigo-500/60 bg-indigo-600/10' : 'border-slate-700/60 bg-slate-900/40 hover:border-indigo-500/60 hover:bg-indigo-600/10'
      ]"
      @click="toggle"
    >
      <div class="flex-1 min-w-0">
        <p :class="['text-slate-100 truncate', size === 'md' ? 'text-sm font-medium' : 'text-sm']">
          {{ current?.label ?? placeholder ?? 'Selecione' }}
        </p>
        <p v-if="size === 'md' && current?.description" class="text-xs text-slate-500 mt-0.5 truncate">{{ current.description }}</p>
      </div>
      <svg :class="['w-4 h-4 text-slate-400 flex-shrink-0 transition-transform', open ? 'rotate-180' : '']" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
      </svg>
    </button>

    <div
      v-if="open"
      ref="list"
      :class="[
        'absolute top-full mt-1.5 z-30 rounded-xl border border-slate-700 bg-slate-900 shadow-2xl p-1.5 flex flex-col gap-1 max-h-72 overflow-y-auto',
        align === 'right' ? 'right-0' : 'left-0',
        size === 'md' ? 'left-0 right-0' : 'min-w-full w-max max-w-xs'
      ]"
    >
      <button
        v-for="o in options"
        :key="o.value"
        type="button"
        :data-selected="o.value === modelValue"
        :class="[
          'flex items-center gap-3 rounded-lg text-left transition-colors',
          size === 'md' || o.description ? 'px-3 py-2.5' : 'px-3 py-2',
          o.value === modelValue ? 'bg-indigo-600/15' : 'hover:bg-indigo-600/10'
        ]"
        @click="choose(o)"
      >
        <span
          :class="[
            'w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center flex-shrink-0',
            o.value === modelValue ? 'border-indigo-400' : 'border-slate-500'
          ]"
        >
          <span v-if="o.value === modelValue" class="w-1.5 h-1.5 rounded-full bg-indigo-400" />
        </span>
        <span class="flex-1 min-w-0">
          <span class="block text-sm text-slate-200">{{ o.label }}</span>
          <span v-if="o.description" class="block text-xs text-slate-500 mt-0.5">{{ o.description }}</span>
        </span>
      </button>
      <p v-if="!options.length" class="px-3 py-2 text-xs text-slate-500">Nenhuma opção</p>
    </div>
  </div>
</template>
