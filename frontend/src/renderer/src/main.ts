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
})
void statusStore.syncEngineLoading()
app.mount('#app')

connect()
