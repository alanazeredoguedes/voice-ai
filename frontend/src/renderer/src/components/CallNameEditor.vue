<script setup lang="ts">
/**
 * Meu nome nas chamadas (um só para todas as salas). Usado no lobby da Chamada (primeira vez e "alterar") e nas
 * Configurações. Salva com Enter ou no botão.
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useCallStore } from '../stores/call'

const props = withDefaults(
  defineProps<{
    autofocus?: boolean
    size?: 'md' | 'lg'
    buttonLabel?: string
    /** mostra o X para desistir de alterar (volta ao nome atual sem salvar) */
    cancelable?: boolean
  }>(),
  { autofocus: false, size: 'md', buttonLabel: 'Salvar', cancelable: false }
)
const emit = defineEmits<{ saved: [name: string]; cancel: [] }>()

const store = useCallStore()
const draft = ref(store.name)
const input = ref<HTMLInputElement | null>(null)
const savedFlash = ref(false)
watch(
  () => store.name,
  (v) => (draft.value = v)
)

const changed = computed(() => draft.value.trim() !== store.name)
const valid = computed(() => !!draft.value.trim())

function save(): void {
  if (!valid.value) return
  store.setName(draft.value)
  savedFlash.value = true
  setTimeout(() => (savedFlash.value = false), 1500)
  emit('saved', store.name)
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Enter') {
    e.preventDefault()
    save()
  } else if (e.key === 'Escape' && store.name) {
    cancel()
  }
}

/** desiste de alterar: volta ao nome atual, sem salvar */
function cancel(): void {
  draft.value = store.name
  emit('cancel')
}

onMounted(() => {
  if (props.autofocus) void nextTick(() => input.value?.focus())
})
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <div class="flex items-center gap-2">
      <input
        ref="input"
        v-model="draft"
        maxlength="40"
        placeholder="Seu nome"
        :class="[
          'flex-1 min-w-0 bg-slate-900/40 border border-slate-700/60 rounded-lg px-3 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-indigo-500/60',
          size === 'lg' ? 'py-2.5 text-sm' : 'py-1.5 text-sm'
        ]"
        @keydown="onKey"
      />
      <button
        :disabled="!valid || (!changed && !!store.name)"
        :class="[
          'flex-shrink-0 rounded-lg text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 transition-colors disabled:opacity-50',
          size === 'lg' ? 'px-4 py-2.5' : 'px-3 py-1.5'
        ]"
        @click="save"
      >
        {{ savedFlash ? 'Salvo' : buttonLabel }}
      </button>
      <button
        v-if="cancelable && store.name"
        type="button"
        :class="[
          'flex-shrink-0 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-700/60 transition-colors',
          size === 'lg' ? 'p-2.5' : 'p-1.5'
        ]"
        title="Cancelar (mantém o nome atual)"
        @click="cancel"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
      </button>
    </div>
    <p v-if="store.inCall && changed" class="text-[11px] text-amber-300">Na chamada atual, os outros veem o nome novo quando você entrar de novo.</p>
  </div>
</template>
