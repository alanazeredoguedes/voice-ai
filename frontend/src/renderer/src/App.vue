<script setup lang="ts">
import { ref, onMounted, provide } from 'vue'
import Sidebar from './components/Sidebar.vue'
import StatusView from './views/StatusView.vue'
import SettingsView from './views/SettingsView.vue'
import TranscribeView from './views/TranscribeView.vue'
import LogsView from './views/LogsView.vue'
import TranslateView from './views/TranslateView.vue'
import ChatView from './views/ChatView.vue'
import SetupView from './views/SetupView.vue'
import AppTooltip from './components/AppTooltip.vue'
import BenchmarkView from './views/BenchmarkView.vue'
import ImageToast from './components/ImageToast.vue'

type View = 'status' | 'settings' | 'transcribe' | 'logs' | 'translate' | 'chat'
// páginas que não aparecem na barra lateral (abertas por um botão de outra tela)
type Page = View | 'benchmark'

const currentView = ref<Page>('status')
// as telas podem abrir outra página (ex.: Configurações → Testar desempenho)
provide('navigate', (v: Page) => {
  currentView.value = v
})
const setupRequired = ref(false)
const setupChecked = ref(false)
const setupMode = ref<'install' | 'update'>('install')

onMounted(async () => {
  try {
    const result = await window.electron.ipcRenderer.invoke('setup:check') as { required: boolean; mode?: string }
    setupRequired.value = result.required
    setupMode.value = result.mode === 'update' ? 'update' : 'install'
  } catch {
    setupRequired.value = false
  }
  setupChecked.value = true
})

function onSetupDone() {
  setupRequired.value = false
}
</script>

<template>
  <!-- Aguarda a verificacao de setup antes de renderizar -->
  <div v-if="!setupChecked" class="flex h-screen bg-slate-950" />

  <!-- Tela de setup na primeira execucao -->
  <SetupView v-else-if="setupRequired" :mode="setupMode" @done="onSetupDone" />

  <!-- App normal -->
  <div v-else class="flex h-screen bg-slate-950 text-slate-100 overflow-hidden">
    <!-- na página de teste, a barra mostra "Configurações" selecionada (é de lá que ela é aberta) -->
    <Sidebar :model-value="currentView === 'benchmark' ? 'settings' : currentView" @update:model-value="(v) => (currentView = v)" />
    <main class="flex-1 overflow-auto p-6">
      <StatusView v-if="currentView === 'status'" />
      <SettingsView v-else-if="currentView === 'settings'" />
      <TranscribeView v-else-if="currentView === 'transcribe'" />
      <LogsView v-else-if="currentView === 'logs'" />
      <TranslateView v-else-if="currentView === 'translate'" />
      <ChatView v-else-if="currentView === 'chat'" />
      <BenchmarkView v-else-if="currentView === 'benchmark'" @back="currentView = 'settings'" />
    </main>
  </div>
  <!-- tooltip do sistema (substitui o balão nativo dos atributos title em todo o app) -->
  <AppTooltip />
  <!-- aviso das ações nas imagens (copiar, baixar) -->
  <ImageToast />
</template>
