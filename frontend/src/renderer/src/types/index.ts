export interface Settings {
  transcription_key: string
  ai_key: string
  transcription_keys_extra?: string[]
  ai_keys_extra?: string[]
  /** mostrar/esconder o Voice AI por cima de qualquer janela */
  window_key?: string
  window_keys_extra?: string[]
  model: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3-turbo' | 'large-v3'
  device: 'auto' | 'cuda' | 'cpu'
  compute_type: string
  tts_backend: 'edge' | 'elevenlabs'
  edge_voice: string
  elevenlabs_api_key: string
  elevenlabs_voice_id: string
  elevenlabs_voice_name: string
  /** chat que recebe as perguntas por voz (o selecionado no Chat IA) */
  active_chat_id?: number
  sound_recording: boolean
  sound_processing: boolean
  sound_copied: boolean
  media_enabled?: boolean
  media_max_images?: number
  media_proactive?: boolean
  whisper_batched?: boolean
  whisper_vad?: boolean
  whisper_stream?: boolean
  /** limite dos áudios salvos por chat (MB) */
  speech_cache_limit_mb?: number
  /** tamanho máximo de cada anexo do chat (MB) */
  upload_limit_mb?: number
  web_search?: boolean
  /** modelo do Claude no Chat IA (todos os chats) */
  claude_model?: 'haiku' | 'sonnet' | 'opus'
  serper_api_key?: string
  image_provider?: 'duckduckgo' | 'serper' | null
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
  /** como foi transcrito: "lote", "sem silêncios", "durante a fala" */
  method?: string | null
  text: string
  ai_response: string | null
  media?: MediaGroup[]
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
  type: 'state_changed' | 'audio_level' | 'log_added' | 'transcription_ready' | 'transcription_progress' | 'translate_download_progress' | 'chat_chunk' | 'chat_delta' | 'claude_usage' | 'ptt_partial' | 'toggle_window' | 'ai_rejected_short' | 'chat_error' | 'voice_user_message' | 'voice_chat_cancelled' | 'chat_media' | 'chat_media_preview' | 'tts_playing' | 'chats_changed' | 'ai_rejected_busy' | 'chat_activity' | 'tts_preparing' | 'tts_words' | 'speech_cache_progress' | 'engine_loading' | 'benchmark_started' | 'benchmark_progress' | 'benchmark_result' | 'benchmark_done' | 'model_download_progress' | 'model_download_complete' | 'model_download_error' | 'pong'
  model?: string
  state?: AppState
  /** ptt_partial: de qual atalho é a gravação ("ai" = falar com a IA) */
  mode?: string
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
  /** chat a que o evento pertence (vários chats no Chat IA) */
  chat_id?: number
  // chat_activity (ferramenta em uso, ex.: pesquisa na internet) e fim da resposta
  tool?: string
  detail?: string
  duration_s?: number | null
  tools?: ChatTool[]
  /** resposta completa, mas o app ainda está falando (o envio fica bloqueado até o fim) */
  still_busy?: boolean
  // chat_media
  group_id?: string
  kind?: MediaKind
  query?: string
  status?: MediaGroup['status']
  items?: MediaItem[]
  provider?: string
  picked?: boolean
  more?: MediaItem[]
  took_s?: number
  timing?: MediaGroup['timing']
  preview?: boolean
  // tts_playing: ref = "live" (resposta atual) ou "msg:<id>" (repetição)
  ref?: string
  playing?: boolean
  /** tts_preparing: o áudio de "ouvir de novo" está sendo gerado (ainda não está falando) */
  preparing?: boolean
  /** engine_loading: carregamento do modelo do Whisper (loading, progress, phase, model, device) */
  loading?: boolean
  phase?: string
  elapsed?: number
  slow?: boolean
  device?: string
  /** speech_cache_progress: % do texto da resposta que já tem áudio salvo no disco */
  audio_pct?: number
  audio_bytes?: number
  /** tts_words: frase que começou a tocar, com o tempo de cada palavra no áudio original */
  words?: { t: number; d: number; w: string }[]
  speed?: number
  lead?: number
  // benchmark ("Testar desempenho")
  job?: BenchmarkJob
  job_id?: string
  test_id?: string
  result?: BenchmarkResult
}

export type MediaKind = 'image' | 'video'

export interface MediaItem {
  kind: MediaKind
  url: string
  thumb: string
  title: string
  source: string
  page_url: string
  width?: number | null
  height?: number | null
  /** frase curta do que aparece na imagem (escrita pela IA que escolheu) */
  caption?: string
  // vídeo (YouTube)
  video_id?: string
  duration?: number | null
}

export interface MediaGroup {
  group_id: string
  kind: MediaKind
  query: string
  /** o que a imagem precisa mostrar (pedido da IA, mais o que o usuário refinou) */
  desc?: string
  /** buscando de novo (as imagens antigas continuam na tela, esmaecidas, até a nova busca terminar ou ser cancelada) */
  refreshing?: boolean
  /** aviso do último "repesquisar/refinar" que não achou nada (o bloco antigo continua) */
  notice?: string
  status: 'loading' | 'done' | 'error'
  items: MediaItem[]
  error?: string
  /** quem respondeu a busca: duckduckgo | serper | youtube */
  provider?: string
  /** escolhidas pela IA depois de ver a busca (layout de destaque no meio do texto) */
  picked?: boolean
  /** o resto da busca: só aparece no visualizador ("+N") */
  more?: MediaItem[]
  /** quanto tempo levou para gerar este bloco (segundos) e em que etapas */
  took_s?: number
  timing?: { rewrite?: number; search?: number; search_calls?: number; preview?: number; thumbs?: number; judge?: number; cost_usd?: number; tokens?: number; calls?: number }
  /** true: são as primeiras da busca, ainda sem a conferência da IA (a tela mostra "conferindo..." e depois troca) */
  preview?: boolean
  /** repesquisar/refinar: as primeiras da nova busca, mostradas enquanto a IA confere (as antigas só voltam se der erro ou cancelar) */
  refreshPreview?: MediaItem[]
  /** sobe a cada repesquisa/refinar que terminou bem (a tela mostra "Conferido pela IA") */
  verifiedTick?: number
}

export interface Chat {
  id: number
  name: string
  system_prompt: string
  created_at?: string
  updated_at: string
  message_count?: number
  last_message?: string
  /** áudios salvos das respostas deste chat (bytes) */
  audio_bytes?: number
}

export interface StorageInfo {
  data_dir: string
  speech_cache: {
    bytes: number
    limit_mb: number
    chats: { chat_id: number; name: string; bytes: number; messages: number }[]
  }
  models: { id: string; name: string; bytes: number; active: boolean }[]
  translation: { bytes: number; count: number }
  database: { bytes: number }
  libraries: { bytes: number }
}

export interface ChatList {
  chats: Chat[]
  active_id: number
  busy_chat_id: number | null
}

/** Ferramenta usada pela IA numa resposta (WebSearch = pesquisa, WebFetch = abriu uma página) */
export interface ChatTool {
  name: string
  detail: string
}

// ---------- Testar desempenho (benchmark do Whisper) ----------
export interface BenchmarkAudio {
  id: string
  title: string
  description: string
  source: string
  credit: string
  license: string
  url: string
  duration_s: number
  cuts: { minutes: number; end_s: number }[]
}

export interface BenchmarkTest {
  test_id: string
  model: string
  device: 'cuda' | 'cpu'
  audio_id: string
  audio_title: string
  minutes: number
  duration_s: number
  mode: string
  mode_label: string
  status: 'queued' | 'loading' | 'running' | 'done' | 'error' | 'cancelled'
  progress: number
}

export interface BenchmarkDiffOp {
  op: 'equal' | 'missing' | 'extra' | 'replace'
  text: string
  ref?: string
}

export interface BenchmarkResult {
  error?: string
  proc_s?: number
  total_s?: number
  speed?: number | null
  text?: string
  wer?: number
  substituted?: number
  missing?: number
  inserted?: number
  ref_words?: number
  hyp_words?: number
  diff?: BenchmarkDiffOp[]
}

export interface BenchmarkJob {
  job_id: string
  status: 'running' | 'done' | 'cancelled'
  started_at: number
  finished_at?: number | null
  tests: BenchmarkTest[]
  results: Record<string, BenchmarkResult>
}

export interface BenchmarkInfo {
  library: BenchmarkAudio[]
  models: { id: string; name: string; size_mb: number }[]
  modes: { id: string; label: string }[]
  has_gpu: boolean
  speeds: Record<string, number>
  speeds_from_history: string[]
  load_s: Record<string, number>
  job: BenchmarkJob | null
  last_report: BenchmarkJob | null
}

/** arquivo anexado a uma mensagem do usuário (imagem ou arquivo de texto) */
export interface ChatFile {
  id: string
  name: string
  mime: string
  kind: 'image' | 'text'
  size: number
  /** endereço local da imagem enquanto a mensagem ainda não foi recarregada do servidor */
  url?: string
}

export interface ChatMessage {
  id?: number
  ts?: string
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
  media?: MediaGroup[]
  /** mensagem do usuário: arquivos anexados */
  files?: ChatFile[]
  /** tempo até a resposta ficar completa (segundos) */
  duration_s?: number | null
  tools?: ChatTool[]
  /** % do texto desta resposta que já tem áudio salvo no disco (toca na hora, sem internet) */
  audio_pct?: number
  /** espaço que esse áudio salvo ocupa (bytes) */
  audio_bytes?: number
  /** o que a IA está fazendo agora, enquanto ainda não chegou texto */
  activity?: ChatTool | null
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
  locale?: string
  gender?: string
}

export interface ElevenLabsVoice {
  voice_id: string
  name: string
  description?: string | null
}
