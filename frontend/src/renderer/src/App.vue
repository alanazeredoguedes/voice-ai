<script setup lang="ts">
import { ref } from 'vue'
import Sidebar from './components/Sidebar.vue'
import StatusView from './views/StatusView.vue'
import SettingsView from './views/SettingsView.vue'
import TranscribeView from './views/TranscribeView.vue'
import LogsView from './views/LogsView.vue'

type View = 'status' | 'settings' | 'transcribe' | 'logs'
const currentView = ref<View>('status')
</script>

<template>
  <div class="flex h-screen bg-slate-950 text-slate-100 overflow-hidden">
    <Sidebar v-model="currentView" />
    <main class="flex-1 overflow-auto p-6">
      <StatusView v-if="currentView === 'status'" />
      <SettingsView v-else-if="currentView === 'settings'" />
      <TranscribeView v-else-if="currentView === 'transcribe'" />
      <LogsView v-else-if="currentView === 'logs'" />
    </main>
  </div>
</template>
