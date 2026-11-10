import axios from 'axios'
import type { Settings, LogsPage, EdgeVoice, ElevenLabsVoice } from '../types'

const BASE_URL = 'http://127.0.0.1:18450'

const http = axios.create({ baseURL: BASE_URL, timeout: 15000 })

export async function getSettings(): Promise<Settings> {
  const { data } = await http.get('/settings')
  return data
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const { data } = await http.put('/settings', patch)
  return data
}

export async function getLogs(limit = 100, offset = 0): Promise<LogsPage> {
  const { data } = await http.get('/logs', { params: { limit, offset } })
  return data
}

export async function clearLogs(): Promise<void> {
  await http.delete('/logs')
}

export async function getEdgeVoices(): Promise<EdgeVoice[]> {
  const { data } = await http.get('/voices/edge')
  return data
}

export async function fetchElevenLabsVoices(apiKey: string): Promise<ElevenLabsVoice[]> {
  const { data } = await http.post('/voices/elevenlabs/fetch', { api_key: apiKey })
  return data
}

export async function restartEngine(): Promise<void> {
  await http.post('/engine/restart')
}

export async function captureHotkey(): Promise<string> {
  const { data } = await http.post('/hotkeys/capture', null, { timeout: 12000 })
  return data.hotkey
}

export interface TranscribeResult {
  text: string
  duration_s: number
  proc_s: number
  model: string
  device: string
}

export async function getTranslatePackages(): Promise<import('../types').TranslatePackage[]> {
  const { data } = await http.get('/translate/packages')
  return data
}

export async function installTranslatePackage(from_code: string, to_code: string): Promise<void> {
  await http.post('/translate/packages/install', { from_code, to_code })
}

export async function removeTranslatePackage(from_code: string, to_code: string): Promise<void> {
  await http.delete(`/translate/packages/${from_code}/${to_code}`)
}

export async function translateText(
  text: string,
  from_code: string,
  to_code: string
): Promise<{ translated: string; from_code: string; to_code: string }> {
  const { data } = await http.post('/translate/text', { text, from_code, to_code })
  return data
}

export async function listChats(): Promise<import('../types').ChatList> {
  const { data } = await http.get('/chat/chats')
  return data
}

export async function createChat(name: string, systemPrompt = ''): Promise<import('../types').Chat> {
  const { data } = await http.post('/chat/chats', { name, system_prompt: systemPrompt })
  return data
}

export async function updateChat(
  id: number,
  patch: { name?: string; system_prompt?: string }
): Promise<import('../types').Chat> {
  const { data } = await http.patch(`/chat/chats/${id}`, patch)
  return data
}

export async function deleteChat(id: number): Promise<{ active_id: number }> {
  const { data } = await http.delete(`/chat/chats/${id}`)
  return data
}

export async function activateChat(id: number): Promise<void> {
  await http.post(`/chat/chats/${id}/activate`)
}

export async function getChatMessages(chatId: number): Promise<import('../types').ChatMessage[]> {
  const { data } = await http.get(`/chat/chats/${chatId}/messages`)
  return data
}

export async function sendChatMessage(chatId: number, text: string): Promise<{ user_message_id: number }> {
  const { data } = await http.post(`/chat/chats/${chatId}/message`, { text })
  return data
}

export async function clearChatMessages(chatId: number): Promise<void> {
  await http.delete(`/chat/chats/${chatId}/messages`)
}

export async function deleteChatMessage(id: number): Promise<void> {
  await http.delete(`/chat/messages/${id}`)
}

export interface MediaTestResult {
  ok: boolean
  count?: number
  ms?: number
  sample?: string
  error?: string
}

/** Busca de teste num provedor de mídia (sem fallback). `serperKey` testa uma chave antes de salvar. */
export async function testMediaProvider(
  provider: 'duckduckgo' | 'serper' | 'youtube',
  serperKey?: string
): Promise<MediaTestResult> {
  const { data } = await http.post(
    '/media/test',
    { provider, serper_api_key: serperKey },
    { timeout: 30000 }
  )
  return data
}

/** Fala o texto de novo. `ref` identifica a mensagem (o ícone dela pisca enquanto fala). */
/** Fala de novo uma resposta. Com `message_id` (e trecho start/end no texto), usa os áudios salvos no disco. */
export async function replaySpeech(
  text: string,
  ref?: string,
  range?: { message_id?: number; start?: number; end?: number | null }
): Promise<{ ok: boolean; reason?: string }> {
  const { data } = await http.post('/engine/tts/speak', { text, ref, ...range })
  return data
}

// ---------- Armazenamento ----------
export async function getStorage(): Promise<import('../types').StorageInfo> {
  const { data } = await http.get('/storage', { timeout: 60000 })
  return data
}

export async function clearAllSpeechCache(): Promise<void> {
  await http.delete('/storage/speech-cache')
}

export async function clearChatSpeechCache(chatId: number): Promise<void> {
  await http.delete(`/chat/chats/${chatId}/speech-cache`)
}

export interface EngineLoading {
  loading: boolean
  progress: number
  phase: string
  model?: string
  device?: string
  /** segundos desde o início do carregamento */
  elapsed?: number
  /** passou bastante do tempo normal: a tela mostra o tempo em vez da % */
  slow?: boolean
}

export interface EngineStatus {
  ready: boolean
  model: string | null
  device: string | null
  /** andamento do carregamento do modelo */
  loading?: EngineLoading | null
}

/** Estado do Whisper (a engine reinicia sozinha ao trocar modelo/dispositivo). */
export async function getEngineStatus(): Promise<EngineStatus> {
  const { data } = await http.get('/engine/status')
  return data
}

/** Créditos restantes no Serper. Sem `key`, usa a chave salva. */
export async function getSerperBalance(key?: string): Promise<{ ok: boolean; balance?: number; error?: string }> {
  const { data } = await http.post('/media/serper/balance', { serper_api_key: key ?? null })
  return data
}

export interface ElevenLabsUsage {
  ok: boolean
  used?: number
  limit?: number
  remaining?: number
  tier?: string
  reset_unix?: number
  error?: string
}

/** Créditos do mês na conta ElevenLabs. */
export async function getElevenLabsUsage(apiKey: string): Promise<ElevenLabsUsage> {
  const { data } = await http.post('/voices/elevenlabs/usage', { api_key: apiKey })
  return data
}

/** Para a fala atual (resposta ao vivo ou repetição), sem cancelar o texto. */
export async function stopSpeech(): Promise<void> {
  await http.post('/engine/tts/stop')
}

export async function getTtsMuted(): Promise<boolean> {
  const { data } = await http.get<{ muted: boolean }>('/engine/tts/muted')
  return data.muted
}

export async function setTtsMuted(muted: boolean): Promise<void> {
  await http.put('/engine/tts/muted', { muted })
}

export async function getTtsVolume(): Promise<number> {
  const { data } = await http.get<{ volume: number }>('/engine/tts/volume')
  return data.volume
}

export async function setTtsVolume(volume: number): Promise<void> {
  await http.put('/engine/tts/volume', { volume })
}

export async function getTtsSpeed(): Promise<number> {
  const { data } = await http.get<{ speed: number }>('/engine/tts/speed')
  return data.speed
}

/** Velocidade da fala (0.5 a 3.0); devolve o valor aplicado */
export async function setTtsSpeed(speed: number): Promise<number> {
  const { data } = await http.put<{ speed: number }>('/engine/tts/speed', { speed })
  return data.speed
}

export async function getWhisperModels(): Promise<import('../types').WhisperModel[]> {
  const { data } = await http.get('/models')
  return data
}

export async function downloadWhisperModel(id: string): Promise<void> {
  await http.post(`/models/${id}/download`)
}

export async function deleteWhisperModel(id: string): Promise<void> {
  await http.delete(`/models/${id}`)
}

export async function cancelTranscription(): Promise<void> {
  await http.post('/transcribe/cancel')
}

export async function transcribeFile(file: File): Promise<TranscribeResult> {
  const form = new FormData()
  form.append('file', file)
  const { data } = await http.post('/transcribe/file', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 600_000, // 10 min para arquivos longos
  })
  return data
}

// ---------- Testar desempenho ----------
export async function getBenchmarkInfo(): Promise<import('../types').BenchmarkInfo> {
  const { data } = await http.get('/benchmark/info')
  return data
}

export async function runBenchmark(body: {
  models: string[]
  devices: string[]
  audios: { id: string; minutes: number }[]
  modes: string[]
}): Promise<import('../types').BenchmarkJob> {
  const { data } = await http.post('/benchmark/run', body)
  return data
}

export async function cancelBenchmark(): Promise<void> {
  await http.post('/benchmark/cancel')
}

export function benchmarkAudioUrl(id: string): string {
  return `${BASE_URL}/benchmark/audio/${encodeURIComponent(id)}`
}

/** Trechos [início, fim) do texto de uma resposta que já têm áudio salvo no computador */
/** Modelo do Claude escolhido no app e o nome real de cada escolha (de quando já respondeu). */
export async function getClaudeModel(): Promise<{ selected: string; options: string[]; resolved: Record<string, string> }> {
  const { data } = await http.get('/chat/model')
  return data
}

export async function getAudioRanges(messageId: number): Promise<{ ranges: [number, number][]; audio_pct: number }> {
  const { data } = await http.get(`/chat/messages/${messageId}/audio-ranges`)
  return data
}
