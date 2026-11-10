/** Modelos do Claude que dá para escolher no Chat IA (vale para todos os chats, só neste app). */
export type ClaudeModelChoice = 'haiku' | 'sonnet' | 'opus'

/** o app vem com o Haiku (mais rápido e econômico) */
export const DEFAULT_CLAUDE_MODEL: ClaudeModelChoice = 'haiku'

export const CLAUDE_MODEL_OPTIONS: { value: ClaudeModelChoice; label: string; description: string }[] = [
  { value: 'haiku', label: 'Haiku', description: 'Mais rápido e econômico: bom para perguntas simples' },
  { value: 'sonnet', label: 'Sonnet', description: 'Equilíbrio entre rapidez e qualidade' },
  { value: 'opus', label: 'Opus', description: 'O mais capaz: respostas mais elaboradas, gasta mais do limite' }
]

/** "claude-haiku-5-5" → "Haiku 5.5" */
export function prettyModel(id?: string | null): string {
  if (!id) return ''
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/i.exec(id)
  if (!m) return id
  const fam = m[1].charAt(0).toUpperCase() + m[1].slice(1)
  return m[3] ? `${fam} ${m[2]}.${m[3]}` : `${fam} ${m[2]}`
}
