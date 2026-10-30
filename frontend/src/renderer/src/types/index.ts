export interface Settings {
  transcription_key: string
  ai_key: string
  model: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3'
  device: 'auto' | 'cuda' | 'cpu'
  compute_type: string
  tts_backend: 'edge' | 'elevenlabs'
  edge_voice: string
  elevenlabs_api_key: string
  elevenlabs_voice_id: string
  elevenlabs_voice_name: string
  claude_continue: boolean
  claude_system_prompt: string
  sound_recording: boolean
  sound_processing: boolean
  sound_copied: boolean
  [key: string]: unknown
}

export interface LogEntry {
  id: number
  ts: string
  mode: 'transcription' | 'ai'
  model: string
  device: string
  compute_type: string
  audio_s: number
  proc_s: number
  rtf: number
  text: string
  ai_response: string | null
}

export interface LogsPage {
  items: LogEntry[]
  total: number
  limit: number
  offset: number
}

export type AppState = 'idle' | 'recording' | 'processing' | 'thinking' | 'speaking'

export interface StateEvent {
  type: 'state_changed' | 'audio_level' | 'log_added' | 'transcription_ready' | 'pong'
  state?: AppState
  level?: number
  entry?: LogEntry
  text?: string
}

export interface EdgeVoice {
  id: string
  name: string
  locale: string
}

export interface ElevenLabsVoice {
  voice_id: string
  name: string
}
