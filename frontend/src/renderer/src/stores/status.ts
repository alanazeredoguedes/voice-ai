import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { AppState, StateEvent } from '../types'
import { getEngineStatus, getLogs, type EngineLoading } from '../api'

export const useStatusStore = defineStore('status', () => {
  const state = ref<AppState>('idle')
  const audioLevel = ref(0)
  /** as 3 últimas transcrições de microfone, a mais recente primeiro */
  const recentTranscriptions = ref<{ text: string; ts: string }[]>([])
  const lastTranscription = computed(() => recentTranscriptions.value[0]?.text ?? '')
  const transcriptionProgress = ref(0)
  /** modelo do Whisper carregando (ao abrir o app ou trocar de modelo) */
  const engineLoading = ref<EngineLoading | null>(null)
  /** modelo que está na memória e sendo usado agora (null = ainda não carregou nenhum) */
  const engineInfo = ref<{ ready: boolean; model: string | null; device: string | null } | null>(null)

  function onEngineLoading(e: StateEvent): void {
    engineLoading.value = e.loading
      ? { loading: true, progress: e.progress ?? 0, phase: e.phase ?? '', model: e.model, device: e.device, elapsed: e.elapsed, slow: e.slow }
      : null
    engineInfo.value = { ready: !e.loading, model: e.model ?? null, device: e.device ?? null }
    if (e.loading) scheduleResync()
  }

  let resyncTimer: ReturnType<typeof setTimeout> | null = null
  function scheduleResync(): void {
    if (resyncTimer) return
    resyncTimer = setTimeout(() => {
      resyncTimer = null
      void syncEngineLoading()
    }, 2000)
  }

  /** estado atual ao abrir a tela (o carregamento pode ter começado antes) */
  async function syncEngineLoading(): Promise<void> {
    try {
      const s = await getEngineStatus()
      engineLoading.value = s.loading?.loading ? s.loading : null
      engineInfo.value = { ready: s.ready, model: s.model, device: s.device ?? s.loading?.device ?? null }
      // carregando: confere de novo daqui a pouco (se o aviso de "terminou" se perder, não fica preso)
      if (engineLoading.value) scheduleResync()
    } catch {
      // backend ainda subindo
    }
  }

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
    if (!text) return
    recentTranscriptions.value = [{ text, ts: new Date().toISOString() }, ...recentTranscriptions.value].slice(0, 3)
  }

  /** traz as últimas do histórico (o banco é a verdade): ao abrir o app e ao abrir a tela do microfone */
  async function loadRecentTranscriptions(): Promise<void> {
    try {
      const page = await getLogs(3, 0, 'transcription')
      const fromDb = page.items.filter((i) => i.text).map((i) => ({ text: i.text, ts: i.ts }))
      // uma que chegou ao vivo agora e ainda não apareceu no histórico fica na frente
      const justNow = recentTranscriptions.value.filter((l) => !fromDb.some((d) => d.text === l.text) && Date.now() - new Date(l.ts).getTime() < 15000)
      recentTranscriptions.value = [...justNow, ...fromDb].slice(0, 3)
    } catch {
      // backend ainda subindo
    }
  }

  function setTranscriptionProgress(pct: number): void {
    transcriptionProgress.value = pct
  }

  return {
    state,
    audioLevel,
    lastTranscription,
    recentTranscriptions,
    loadRecentTranscriptions,
    transcriptionProgress,
    engineLoading,
    engineInfo,
    onEngineLoading,
    syncEngineLoading,
    setState,
    setAudioLevel,
    setLastTranscription,
    setTranscriptionProgress
  }
})
