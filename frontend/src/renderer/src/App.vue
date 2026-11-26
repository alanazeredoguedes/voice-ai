<script setup lang="ts">
import { ref, onMounted, onUnmounted, provide, watch } from 'vue'
import { onWsMessage } from './api/ws'
import { syslog } from './utils/syslog'
import Sidebar from './components/Sidebar.vue'
import StatusView from './views/StatusView.vue'
import SettingsView from './views/SettingsView.vue'
import TranscribeView from './views/TranscribeView.vue'
import LogsView from './views/LogsView.vue'
import TranslateView from './views/TranslateView.vue'
import ChatView from './views/ChatView.vue'
import CallView from './views/CallView.vue'
import { useCallStore } from './stores/call'
import { useFriendsStore } from './stores/friends'
import IncomingCall from './components/IncomingCall.vue'
import { cancelCall } from './utils/friendsUi'
import SetupView from './views/SetupView.vue'
import AppTooltip from './components/AppTooltip.vue'
import BenchmarkView from './views/BenchmarkView.vue'
import ImageToast from './components/ImageToast.vue'
import UpdateBanner from './components/UpdateBanner.vue'
import { useUpdateStore } from './stores/update'

type View = 'status' | 'settings' | 'transcribe' | 'logs' | 'translate' | 'chat' | 'call'
// páginas que não aparecem na barra lateral (abertas por um botão de outra tela)
type Page = View | 'benchmark'

const currentView = ref<Page>('status')
watch(currentView, (v, old) => syslog('info', 'navegação', `abriu a tela ${v} (vinha de ${old})`))
// as telas podem abrir outra página (ex.: Configurações → Testar desempenho)
provide('navigate', (v: Page) => {
  currentView.value = v
})

// Falou pelo atalho: ao concluir, a tela acompanha o atalho usado (transcrição do microfone ou conversa com a IA).
// Na chamada e nas Configurações não troca de tela (atrapalharia quem está na sala ou escolhendo um atalho).
function followShortcut(target: View): void {
  if (currentView.value === 'call' || currentView.value === 'settings' || currentView.value === target) return
  currentView.value = target
}
const unsubShortcut = onWsMessage((e) => {
  if (e.type === 'transcription_ready') followShortcut('status')
  else if (e.type === 'voice_user_message') followShortcut('chat')
})
onUnmounted(unsubShortcut)

// Amigos (beta): o processo principal publica meu status (nome e se estou em chamada) para os amigos
const call = useCallStore()
const friends = useFriendsStore()
void friends.init()
void useUpdateStore().init()
// em chamada, o código da sala vai junto (só quando já funciona para quem está de fora): o amigo pode entrar direto
watch(
  () => [call.userId, call.name, call.inCall, call.inCall && call.codeReady ? call.code : '', call.room?.name ?? ''] as const,
  ([userId, name, inCall, code, roomName]) => friends.setProfile({ userId, name, inCall, code, roomName }),
  { immediate: true }
)
// saiu da chamada: a conversa com o amigo que estava no lugar do chat da sala fecha (no lobby ela fica no card de amigos)
watch(
  () => call.inCall,
  (v) => {
    if (v) return
    // a conversa aberta dentro da chamada fecha junto (senão ela abriria sozinha no painel de amigos do lobby)
    if (friends.callChatOpen && friends.selected) void friends.select(null)
    friends.callChatOpen = false
    // saí da sala enquanto chamava um amigo: o computador dele para de tocar
    if (friends.outgoingCall?.phase === 'ringing') cancelCall('saí da chamada enquanto tocava')
  }
)
// clicou na notificação de mensagem de um amigo: abre a conversa (painel de amigos da tela de Chamada)
window.electron.ipcRenderer.on('friends:open', (_e, id: string) => {
  syslog('info', 'amigos', `abrindo a conversa com ${id.slice(0, 8)} pela notificação`)
  currentView.value = 'call'
  // fora da chamada, o painel de amigos do lobby fica aberto enquanto houver uma conversa aberta (sem precisar fixar)
  // na chamada, a conversa abre no lugar do chat da sala; fora dela, no card de amigos do lobby
  if (call.inCall) friends.callChatOpen = true
  void friends.select(id)
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
    <!-- páginas abertas por um botão de outra tela mostram selecionada a tela de origem na barra (teste de desempenho: Configurações; transcrever arquivo: microfone) -->
    <Sidebar :model-value="currentView === 'benchmark' ? 'settings' : currentView === 'transcribe' ? 'status' : currentView" @update:model-value="(v) => (currentView = v)" />
    <div class="flex-1 flex flex-col min-w-0">
    <!-- nova versão disponível: aviso com botão de instalar (atualização dentro do próprio app) -->
    <UpdateBanner />
    <main class="flex-1 overflow-auto p-6">
      <StatusView v-if="currentView === 'status'" />
      <SettingsView v-else-if="currentView === 'settings'" />
      <TranscribeView v-else-if="currentView === 'transcribe'" />
      <LogsView v-else-if="currentView === 'logs'" />
      <TranslateView v-else-if="currentView === 'translate'" />
      <ChatView v-else-if="currentView === 'chat'" />
      <CallView v-else-if="currentView === 'call'" />
      <BenchmarkView v-else-if="currentView === 'benchmark'" @back="currentView = 'settings'" />
    </main>
    </div>
  </div>
  <!-- tooltip do sistema (substitui o balão nativo dos atributos title em todo o app) -->
  <AppTooltip />
  <!-- amigos (beta): chamada recebida (toca e oferece Entrar / Recusar em qualquer aba) -->
  <IncomingCall v-if="setupChecked && !setupRequired" @open-call="currentView = 'call'" />
  <!-- aviso das ações nas imagens (copiar, baixar) -->
  <ImageToast />
</template>
