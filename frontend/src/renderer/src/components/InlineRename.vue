<script setup lang="ts">
/** Edita um nome em linha (ex.: renomear a sala): Enter ou ✓ salva; ESC ou X desiste sem mudar nada. */
import { nextTick, onMounted, ref } from 'vue'

const props = withDefaults(defineProps<{ value: string; maxlength?: number; placeholder?: string; size?: 'sm' | 'lg' }>(), {
  maxlength: 80,
  placeholder: 'Nome da sala',
  size: 'sm'
})
const emit = defineEmits<{ save: [name: string]; cancel: [] }>()

const draft = ref(props.value)
const input = ref<HTMLInputElement | null>(null)

function save(): void {
  const clean = draft.value.trim()
  if (!clean) return
  if (clean === props.value) emit('cancel')
  else emit('save', clean)
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Enter') {
    e.preventDefault()
    save()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    emit('cancel')
  }
}

onMounted(() =>
  nextTick(() => {
    input.value?.focus()
    input.value?.select()
  })
)
</script>

<template>
  <div class="flex items-center gap-1.5 min-w-0" @click.stop>
    <input
      ref="input"
      v-model="draft"
      :maxlength="maxlength"
      :placeholder="placeholder"
      :class="[
        'flex-1 min-w-0 bg-slate-900/60 border border-slate-600 rounded-lg px-2.5 text-slate-100 focus:outline-none focus:border-indigo-500',
        size === 'lg' ? 'py-1.5 text-lg font-semibold' : 'py-1 text-sm'
      ]"
      @keydown="onKey"
    />
    <button
      class="flex-shrink-0 p-1.5 rounded-lg text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 transition-colors"
      title="Salvar (Enter)"
      :disabled="!draft.trim()"
      @click="save"
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
    </button>
    <button class="flex-shrink-0 p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-700/60 transition-colors" title="Cancelar (ESC)" @click="emit('cancel')">
      <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
    </button>
  </div>
</template>
