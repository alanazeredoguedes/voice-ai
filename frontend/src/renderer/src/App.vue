<script setup lang="ts">
import { ref, onMounted } from 'vue'
import Sidebar from './components/Sidebar.vue'
import StatusView from './views/StatusView.vue'
import SettingsView from './views/SettingsView.vue'
import TranscribeView from './views/TranscribeView.vue'
import LogsView from './views/LogsView.vue'
import TranslateView from './views/TranslateView.vue'
import ChatView from './views/ChatView.vue'
import SetupView from './views/SetupView.vue'

type View = 'status' | 'settings' | 'transcribe' | 'logs' | 'translate' | 'chat'

const currentView = ref<View>('status')
const setupRequired = ref(false)
const setupChecked = ref(false)

onMounted(async () => {
  try {
    const result = await window.electron.ipcRenderer.invoke('setup:check') as { required: boolean }
    setupRequired.value = result.required
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
  <SetupView v-else-if="setupRequired" @done="onSetupDone" />

  <!-- App normal -->
  <div v-else class="flex h-screen bg-slate-950 text-slate-100 overflow-hidden">
    <Sidebar v-model="currentView" />
    <main class="flex-1 overflow-auto p-6">
      <StatusView v-if="currentView === 'status'" />
      <SettingsView v-else-if="currentView === 'settings'" />
      <TranscribeView v-else-if="currentView === 'transcribe'" />
      <LogsView v-else-if="currentView === 'logs'" />
      <TranslateView v-else-if="currentView === 'translate'" />
      <ChatView v-else-if="currentView === 'chat'" />
    </main>
  </div>
</template>
