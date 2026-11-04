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
  mode: 'transcription' | 'ai' | 'file'
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

export interface WhisperModel {
  id: string
  name: string
  size_mb: number
  speed: string
  quality: string
  downloaded: boolean
  downloading: boolean
}

export interface StateEvent {
  type: 'state_changed' | 'audio_level' | 'log_added' | 'transcription_ready' | 'transcription_progress' | 'translate_download_progress' | 'chat_chunk' | 'chat_error' | 'voice_user_message' | 'voice_chat_cancelled' | 'model_download_progress' | 'model_download_complete' | 'model_download_error' | 'pong'
  model?: string
  state?: AppState
  level?: number
  entry?: LogEntry
  text?: string
  progress?: number
  from_code?: string
  to_code?: string
  done?: boolean
  message_id?: number
  user_message_id?: number
  error?: string
}

export interface ChatMessage {
  id?: number
  ts?: string
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
}

export interface TranslatePackage {
  from_code: string
  from_name: string
  to_code: string
  to_name: string
  size_mb: number
  installed: boolean
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
