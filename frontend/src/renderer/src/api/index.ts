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

export async function fetchElevenLabsVoices(
  apiKey: string
): Promise<{ voices: ElevenLabsVoice[]; credits: number }> {
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

export async function transcribeFile(file: File): Promise<TranscribeResult> {
  const form = new FormData()
  form.append('file', file)
  const { data } = await http.post('/transcribe/file', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 600_000, // 10 min para arquivos longos
  })
  return data
}
