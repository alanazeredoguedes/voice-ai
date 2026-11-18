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

// medidor do microfone: -80 dBFS (vazio) a 0 dBFS (cheio)
const pctOf = (db: number): number => Math.min(100, Math.max(0, ((db + 80) / 80) * 100))
const busyEcho = ref(false)

async function toggleEcho(): Promise<void> {
  busyEcho.value = true
  try {
    await store.setEchoCancel(!store.echoCancel)
  } finally {
    busyEcho.value = false
  }
}

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
      class="absolute right-0 top-full mt-2 w-80 z-40 bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl p-4 flex flex-col gap-3"
    >
      <div class="flex flex-col gap-1.5">
        <p class="text-xs text-slate-500 uppercase tracking-wide">Microfone</p>
        <CustomSelect :model-value="input" size="sm" :options="inputs" @update:model-value="onInput" />
      </div>
      <div class="flex flex-col gap-1.5">
        <p class="text-xs text-slate-500 uppercase tracking-wide">Saída de som</p>
        <CustomSelect :model-value="output" size="sm" :options="outputs" @update:model-value="onOutput" />
      </div>
      <div class="flex flex-col gap-1.5 pt-1 border-t border-slate-800">
        <div class="flex items-center justify-between pt-2">
          <p class="text-xs text-slate-500 uppercase tracking-wide">Volume do meu microfone</p>
          <span class="text-xs text-slate-300">{{ Math.round(store.micGain * 100) }}%</span>
        </div>
        <input
          type="range"
          min="0"
          max="2"
          step="0.05"
          :value="store.micGain"
          class="h-1 accent-indigo-500 cursor-pointer"
          title="Quanto o seu microfone capta (abaixe se ele pega muito barulho; os outros ouvem nesse volume)"
          @input="store.setMicGain(parseFloat(($event.target as HTMLInputElement).value))"
        />
      </div>

      <div class="flex flex-col gap-2">
        <button class="flex items-center justify-between gap-3 text-left" @click="store.setGate(!store.gateOn)">
          <span class="flex flex-col">
            <span class="text-sm text-slate-200">Só transmitir quando eu falar</span>
            <span class="text-[11px] text-slate-500">Fora isso, o microfone fica fechado (sem barulho de fundo)</span>
          </span>
          <span :class="['relative inline-flex items-center w-8 h-[18px] rounded-full transition-colors flex-shrink-0', store.gateOn ? 'bg-indigo-600' : 'bg-slate-700']">
            <span :class="['inline-block w-3.5 h-3.5 rounded-full bg-white transition-transform', store.gateOn ? 'translate-x-4' : 'translate-x-0.5']" />
          </span>
        </button>
        <div v-if="store.gateOn" class="flex flex-col gap-1">
          <!-- nível ao vivo + limite: a voz precisa passar da marca -->
          <div class="relative h-2 rounded-full bg-slate-800 overflow-hidden">
            <div
              :class="['absolute inset-y-0 left-0 transition-[width] duration-75', store.gateOpen ? 'bg-emerald-500' : 'bg-slate-500']"
              :style="{ width: `${pctOf(store.micLevelDb)}%` }"
            />
            <div class="absolute inset-y-0 w-0.5 bg-amber-400" :style="{ left: `${pctOf(store.gateDb)}%` }" />
          </div>
          <input
            type="range"
            min="-80"
            max="-10"
            step="1"
            :value="store.gateDb"
            class="h-1 accent-amber-400 cursor-pointer"
            title="Sensibilidade: mais à esquerda abre com voz baixa; mais à direita só com voz alta"
            @input="store.setGateDb(parseFloat(($event.target as HTMLInputElement).value))"
          />
          <p class="text-[11px] text-slate-500">
            Fale normalmente: a barra fica verde quando o microfone abre. Ajuste a marca amarela para ficar acima do barulho de fundo
            e abaixo da sua voz ({{ store.gateDb }} dBFS). Enquanto alguém da chamada fala, o limite sobe 10 dB sozinho, para o eco da
            voz da pessoa na sua caixa de som não voltar para ela.
          </p>
        </div>
      </div>

      <div v-if="store.isLinux" class="flex flex-col gap-1">
        <button class="flex items-center justify-between gap-3 text-left disabled:opacity-60" :disabled="busyEcho" @click="toggleEcho">
          <span class="flex flex-col">
            <span class="text-sm text-slate-200">Tirar do microfone o som do computador</span>
            <span class="text-[11px] text-slate-500">Cancelamento de eco: o que sai na caixa de som (vídeo, música, a voz dos outros) não volta pelo microfone</span>
          </span>
          <span :class="['relative inline-flex items-center w-8 h-[18px] rounded-full transition-colors flex-shrink-0', store.echoCancel ? 'bg-indigo-600' : 'bg-slate-700']">
            <span :class="['inline-block w-3.5 h-3.5 rounded-full bg-white transition-transform', store.echoCancel ? 'translate-x-4' : 'translate-x-0.5']" />
          </span>
        </button>
        <p v-if="store.echoCancel && store.inCall" :class="['text-[11px]', store.echoCancelActive ? 'text-emerald-400' : 'text-amber-400']">
          {{ store.echoCancelActive ? 'Ligado' : 'Indisponível neste computador (o motivo está em Logs); usando o microfone comum' }}
        </p>
      </div>

      <p v-if="errorMsg" class="text-xs text-red-400">{{ errorMsg }}</p>
    </div>
  </div>
</template>
