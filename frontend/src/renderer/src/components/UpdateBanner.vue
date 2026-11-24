<script setup lang="ts">
/**
 * Aviso de nova versão (faixa no topo do app) + modal de confirmação.
 * Ao confirmar, o app baixa a atualização (com progresso), reinicia e instala sozinho.
 */
import { computed, ref } from 'vue'
import { useUpdateStore } from '../stores/update'
import { useCallStore } from '../stores/call'
import ConfirmModal from './ConfirmModal.vue'

const update = useUpdateStore()
const call = useCallStore()
const confirming = ref(false)
// "Depois": esconde o aviso até a próxima versão (ou até reabrir o app)
const dismissedFor = ref('')

const s = computed(() => update.state)
const newVersion = computed(() => ('newVersion' in s.value ? s.value.newVersion : ''))
const visible = computed(
  () =>
    (s.value.status === 'available' && dismissedFor.value !== newVersion.value) ||
    s.value.status === 'downloading' ||
    s.value.status === 'ready'
)
const percent = computed(() => (s.value.status === 'downloading' ? s.value.percent : 0))
const notes = computed(() => (s.value.status === 'available' ? s.value.notes : ''))

function confirm(): void {
  confirming.value = false
  update.install()
}
</script>

<template>
  <div
    v-if="visible"
    class="flex items-center gap-3 px-4 py-2 bg-indigo-600/15 border-b border-indigo-500/30 text-sm text-slate-200"
  >
    <svg class="w-4 h-4 text-indigo-300 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
    </svg>

    <template v-if="s.status === 'available'">
      <span class="flex-1 min-w-0 truncate">
        Nova versão <strong class="text-slate-100">{{ newVersion }}</strong> disponível
        <span class="text-slate-500">(você está na {{ s.version }})</span>
        <span v-if="s.error" class="text-amber-300" :title="s.error"> · o download falhou, tente de novo</span>
      </span>
      <button class="px-2.5 py-1 rounded-md text-xs text-slate-400 hover:text-slate-200" @click="dismissedFor = newVersion">Depois</button>
      <button class="px-3 py-1 rounded-md text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white" @click="confirming = true">
        Instalar atualização
      </button>
    </template>

    <template v-else-if="s.status === 'downloading'">
      <span class="flex-1 min-w-0 truncate">Baixando a versão {{ newVersion }}... {{ percent }}%</span>
      <div class="w-40 h-1.5 rounded-full bg-slate-700 overflow-hidden flex-shrink-0">
        <div class="h-full bg-indigo-500 transition-all" :style="{ width: `${percent}%` }" />
      </div>
    </template>

    <template v-else>
      <span class="flex-1">Reiniciando para instalar a versão {{ newVersion }}...</span>
    </template>
  </div>

  <ConfirmModal
    :open="confirming"
    title="Instalar a atualização?"
    confirm-label="Atualizar e reiniciar"
    tone="warning"
    @confirm="confirm"
    @cancel="confirming = false"
  >
    <p>
      O Voice AI vai baixar a versão <strong>{{ newVersion }}</strong>, <strong>reiniciar</strong> e instalar a atualização
      em segundo plano. Seus dados e configurações são mantidos. Se a nova versão precisar de componentes extras, eles são
      baixados na abertura, com uma tela de progresso.
    </p>
    <p v-if="call.inCall" class="mt-2 text-amber-300">Você está em uma chamada: ela será encerrada ao reiniciar.</p>
    <p v-if="notes" class="mt-2 text-xs text-slate-400 whitespace-pre-line max-h-32 overflow-auto">{{ notes }}</p>
  </ConfirmModal>
</template>
