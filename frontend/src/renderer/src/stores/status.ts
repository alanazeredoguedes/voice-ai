import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { AppState } from '../types'

export const useStatusStore = defineStore('status', () => {
  const state = ref<AppState>('idle')
  const audioLevel = ref(0)
  const lastTranscription = ref('')
  const lastAiResponse = ref('')

  function notifyMain(s: AppState): void {
    try {
      window.electron?.ipcRenderer.send('overlay:state', s)
    } catch {
      // não está no contexto Electron (dev browser)
    }
  }

  function setState(s: AppState): void {
    state.value = s
    notifyMain(s)
  }

  function setAudioLevel(v: number): void {
    audioLevel.value = v
  }

  function setLastTranscription(text: string): void {
    lastTranscription.value = text
  }

  function setLastAiResponse(text: string): void {
    lastAiResponse.value = text
  }

  return { state, audioLevel, lastTranscription, lastAiResponse, setState, setAudioLevel, setLastTranscription, setLastAiResponse }
})
