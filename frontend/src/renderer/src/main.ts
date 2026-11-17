import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './style.css'
import { connect } from './api/ws'
import { useChatStore } from './stores/chat'
import { useStatusStore } from './stores/status'
import { useSettingsStore } from './stores/settings'
import { onWsMessage } from './api/ws'

const pinia = createPinia()
const app = createApp(App)
app.use(pinia)

/** Liga as partes que conversam com o backend. Só depois que ele estiver no ar. */
function startBackendFeatures(): void {
  // Chat escuta o WebSocket desde já (respostas por voz chegam mesmo com outra aba aberta)
  useChatStore(pinia).init()
  // carregamento do modelo do Whisper: acompanhado em qualquer tela (microfone, Configurações)
  const statusStore = useStatusStore(pinia)
  onWsMessage((e) => {
    if (e.type === 'engine_loading') statusStore.onEngineLoading(e)
    // últimas transcrições do microfone: acompanhadas em qualquer tela (a lista da aba do microfone não fica parada)
    if (e.type === 'transcription_ready' && e.text) statusStore.setLastTranscription(e.text)
    // atalho "mostrar/esconder o Voice AI" (teclado, mouse ou controle): o Electron traz a janela para a frente
    if (e.type === 'toggle_window') {
      const keepOnTop = !!useSettingsStore(pinia).settings?.window_keep_on_top
      void window.electron?.ipcRenderer?.invoke('window:toggle', { keepOnTop })
    }
  })
  void statusStore.syncEngineLoading()
  void statusStore.loadRecentTranscriptions()
  connect()
}

// A janela abre na hora com "Iniciando…" (index.html); o app aparece quando o backend responde.
// Na configuração inicial o backend ainda não existe: o backend:wait responde na hora.
void (async () => {
  const r = (await window.electron?.ipcRenderer?.invoke('backend:wait').catch(() => null)) as { ok: boolean; error?: string } | null
  if (r && !r.ok) {
    const el = document.getElementById('boot-status')
    if (el) el.textContent = 'O serviço do Voice AI não iniciou. Feche e abra o app de novo; se continuar, veja os logs.'
    return
  }
  startBackendFeatures()
  app.mount('#app')
})()
