import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './style.css'
import { connect } from './api/ws'
import { useChatStore } from './stores/chat'
import { useStatusStore } from './stores/status'
import { onWsMessage } from './api/ws'

const pinia = createPinia()
const app = createApp(App)
app.use(pinia)
// Chat escuta o WebSocket desde já (respostas por voz chegam mesmo com outra aba aberta)
useChatStore(pinia).init()
// carregamento do modelo do Whisper: acompanhado em qualquer tela (microfone, Configurações)
const statusStore = useStatusStore(pinia)
onWsMessage((e) => {
  if (e.type === 'engine_loading') statusStore.onEngineLoading(e)
  // últimas transcrições do microfone: acompanhadas em qualquer tela (a lista da aba do microfone não fica parada)
  if (e.type === 'transcription_ready' && e.text) statusStore.setLastTranscription(e.text)
  // atalho "mostrar/esconder o Voice AI" (teclado, mouse ou controle): o Electron traz a janela para a frente
  if (e.type === 'toggle_window') void window.electron?.ipcRenderer?.invoke('window:toggle')
})
void statusStore.syncEngineLoading()
void statusStore.loadRecentTranscriptions()
app.mount('#app')

connect()
