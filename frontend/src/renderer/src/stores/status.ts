import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { AppState } from '../types'

export const useStatusStore = defineStore('status', () => {
  const state = ref<AppState>('idle')
  const audioLevel = ref(0)
  const lastTranscription = ref('')
  const transcriptionProgress = ref(0)

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
    if (s !== 'processing') transcriptionProgress.value = 0
  }

  function setAudioLevel(v: number): void {
    audioLevel.value = v
  }

  function setLastTranscription(text: string): void {
    lastTranscription.value = text
  }

  function setTranscriptionProgress(pct: number): void {
    transcriptionProgress.value = pct
  }

  return { state, audioLevel, lastTranscription, transcriptionProgress, setState, setAudioLevel, setLastTranscription, setTranscriptionProgress }
})
