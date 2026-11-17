<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import CustomSelect from './CustomSelect.vue'
import { useCallStore } from '../stores/call'

/** Microfone e saída de som usados na chamada (trocáveis sem sair da sala). */
const store = useCallStore()

const open = ref(false)
const root = ref<HTMLElement | null>(null)
const inputs = ref<{ value: string; label: string }[]>([])
const outputs = ref<{ value: string; label: string }[]>([])
const input = ref('')
const output = ref('')
const errorMsg = ref('')

const SYSTEM = { value: '', label: 'Padrão do sistema' }

async function refresh(): Promise<void> {
  const devices = await store.listAudioDevices()
  inputs.value = [SYSTEM, ...devices.inputs.map((d) => ({ value: d.deviceId, label: d.label || 'Microfone sem nome' }))]
  outputs.value = [SYSTEM, ...devices.outputs.map((d) => ({ value: d.deviceId, label: d.label || 'Saída sem nome' }))]
  input.value = store.getInputDevice()
  output.value = store.getOutputDevice()
}

async function toggle(): Promise<void> {
  open.value = !open.value
  errorMsg.value = ''
  if (open.value) await refresh()
}

async function onInput(value: string): Promise<void> {
  input.value = value
  await store.setInputDevice(value)
  errorMsg.value = store.hasMic ? '' : 'Não foi possível abrir esse microfone.'
}

async function onOutput(value: string): Promise<void> {
  output.value = value
  try {
    await store.setOutputDevice(value)
    errorMsg.value = ''
  } catch {
    errorMsg.value = 'Não foi possível usar essa saída de som.'
  }
}

function onDocClick(e: MouseEvent): void {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false
}
function onDeviceChange(): void {
  if (open.value) void refresh()
}

onMounted(() => {
  document.addEventListener('click', onDocClick)
  navigator.mediaDevices.addEventListener('devicechange', onDeviceChange)
})
onUnmounted(() => {
  document.removeEventListener('click', onDocClick)
  navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange)
})
</script>

<template>
  <div ref="root" class="relative">
    <button
      :class="[
        'p-2 rounded-lg border transition-colors',
        open ? 'bg-slate-700 border-slate-600 text-slate-100' : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-100 hover:bg-slate-700'
      ]"
      title="Microfone e saída de som"
      @click="toggle"
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75" />
      </svg>
    </button>

    <div
      v-if="open"
      class="absolute right-0 top-full mt-2 w-72 z-40 bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl p-4 flex flex-col gap-3"
    >
      <div class="flex flex-col gap-1.5">
        <p class="text-xs text-slate-500 uppercase tracking-wide">Microfone</p>
        <CustomSelect :model-value="input" size="sm" :options="inputs" @update:model-value="onInput" />
      </div>
      <div class="flex flex-col gap-1.5">
        <p class="text-xs text-slate-500 uppercase tracking-wide">Saída de som</p>
        <CustomSelect :model-value="output" size="sm" :options="outputs" @update:model-value="onOutput" />
      </div>
      <p v-if="errorMsg" class="text-xs text-red-400">{{ errorMsg }}</p>
    </div>
  </div>
</template>
