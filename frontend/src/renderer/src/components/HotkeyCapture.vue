<script setup lang="ts">
import { ref } from 'vue'
import { captureHotkey } from '../api'

const props = defineProps<{ modelValue: string; label?: string; removable?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [v: string]; remove: [] }>()

const capturing = ref(false)
const error = ref<string | null>(null)

// Nomes dos botões do controle (layout PlayStation; posição física padrão da SDL)
const GAMEPAD_LABELS: Record<string, string> = {
  a: '✕', b: '○', x: '□', y: '△',
  lb: 'L1', rb: 'R1', lt: 'L2', rt: 'R2', ls: 'L3', rs: 'R3',
  up: '↑', down: '↓', left: '←', right: '→',
  back: 'Create', start: 'Options', guide: 'PS', touchpad: 'Touchpad', misc: 'Mic',
  p1: 'P1', p2: 'P2', p3: 'P3', p4: 'P4'
}

function formatHotkey(hotkey: string): string {
  if (!hotkey) return '-'
  if (hotkey.startsWith('gamepad:')) {
    const buttons = hotkey.slice('gamepad:'.length).split('+')
    return '🎮 ' + buttons.map((b) => GAMEPAD_LABELS[b] ?? b).join(' + ')
  }
  return hotkey
}

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
    <label v-if="props.label" class="text-sm text-slate-400">{{ props.label }}</label>
    <div class="flex items-center gap-2">
      <div class="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-200 min-h-[36px]">
        {{ formatHotkey(props.modelValue) }}
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
      <button
        v-if="props.removable"
        :disabled="capturing"
        title="Remover este atalho"
        class="px-2.5 py-2 rounded-lg text-sm text-slate-400 hover:text-red-400 hover:bg-slate-700 transition-colors"
        @click="emit('remove')"
      >
        ✕
      </button>
    </div>
    <p v-if="capturing" class="text-xs text-slate-500">
      Teclado, mouse ou controle - no controle, segure a combinação e solte
    </p>
    <p v-if="error" class="text-xs text-red-400">{{ error }}</p>
  </div>
</template>
