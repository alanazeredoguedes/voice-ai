<script setup lang="ts">
import { ref } from 'vue'
import { captureHotkey } from '../api'

const props = defineProps<{ modelValue: string; label: string }>()
const emit = defineEmits<{ 'update:modelValue': [v: string] }>()

const capturing = ref(false)
const error = ref<string | null>(null)

async function startCapture(): Promise<void> {
  capturing.value = true
  error.value = null
  try {
    const hotkey = await captureHotkey()
    emit('update:modelValue', hotkey)
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Timeout'
  } finally {
    capturing.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-1">
    <label class="text-sm text-slate-400">{{ props.label }}</label>
    <div class="flex items-center gap-2">
      <div class="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-200 min-h-[36px]">
        {{ props.modelValue || '-' }}
      </div>
      <button
        :disabled="capturing"
        :class="[
          'px-3 py-2 rounded-lg text-sm font-medium transition-colors',
          capturing
            ? 'bg-orange-600 text-white animate-pulse cursor-not-allowed'
            : 'bg-slate-700 hover:bg-slate-600 text-slate-200'
        ]"
        @click="startCapture"
      >
        {{ capturing ? '⏺ Pressione...' : 'Capturar' }}
      </button>
    </div>
    <p v-if="error" class="text-xs text-red-400">{{ error }}</p>
  </div>
</template>
