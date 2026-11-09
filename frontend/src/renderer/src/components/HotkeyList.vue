<script setup lang="ts">
import { ref } from 'vue'
import { captureHotkey } from '../api'
import HotkeyCapture from './HotkeyCapture.vue'

// Uma função (transcrição / IA) com um atalho principal + atalhos adicionais.
// Todos ficam ativos ao mesmo tempo no backend.
const props = defineProps<{ label: string; primary: string; extra: string[] }>()
const emit = defineEmits<{ 'update:primary': [v: string]; 'update:extra': [v: string[]] }>()

const adding = ref(false)
const error = ref<string | null>(null)

function isDuplicate(hotkey: string, ignoreIndex = -1): boolean {
  return hotkey === props.primary || props.extra.some((k, i) => i !== ignoreIndex && k === hotkey)
}

function setExtra(index: number, hotkey: string): void {
  if (isDuplicate(hotkey, index)) {
    error.value = 'Esse atalho já está configurado nesta função'
    return
  }
  error.value = null
  const next = [...props.extra]
  next[index] = hotkey
  emit('update:extra', next)
}

function removeExtra(index: number): void {
  error.value = null
  emit('update:extra', props.extra.filter((_, i) => i !== index))
}

function setPrimary(hotkey: string): void {
  if (props.extra.includes(hotkey)) {
    error.value = 'Esse atalho já está configurado nesta função'
    return
  }
  error.value = null
  emit('update:primary', hotkey)
}

async function addHotkey(): Promise<void> {
  adding.value = true
  error.value = null
  try {
    const hotkey = await captureHotkey()
    if (isDuplicate(hotkey)) {
      error.value = 'Esse atalho já está configurado nesta função'
      return
    }
    emit('update:extra', [...props.extra, hotkey])
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Timeout'
  } finally {
    adding.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <HotkeyCapture :model-value="props.primary" :label="props.label" @update:model-value="setPrimary" />
    <HotkeyCapture
      v-for="(hotkey, i) in props.extra"
      :key="hotkey + i"
      :model-value="hotkey"
      removable
      @update:model-value="(v) => setExtra(i, v)"
      @remove="removeExtra(i)"
    />
    <button
      :disabled="adding"
      :class="[
        'self-start px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
        adding
          ? 'bg-orange-600 text-white animate-pulse cursor-not-allowed'
          : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/60 border border-dashed border-slate-600'
      ]"
      @click="addHotkey"
    >
      {{ adding ? '⏺ Pressione o novo atalho (teclado, mouse ou controle)...' : '+ Adicionar atalho' }}
    </button>
    <p v-if="error" class="text-xs text-red-400">{{ error }}</p>
  </div>
</template>
