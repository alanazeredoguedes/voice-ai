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

export async function getChatHistory(): Promise<import('../types').ChatMessage[]> {
  const { data } = await http.get('/chat/history')
  return data
}

export async function sendChatMessage(text: string): Promise<void> {
  await http.post('/chat/message', { text })
}

export async function clearChatHistory(): Promise<void> {
  await http.delete('/chat/history')
}

export async function deleteChatMessage(id: number): Promise<void> {
  await http.delete(`/chat/messages/${id}`)
}

export async function replaySpeech(text: string): Promise<void> {
  await http.post('/engine/tts/speak', { text })
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
