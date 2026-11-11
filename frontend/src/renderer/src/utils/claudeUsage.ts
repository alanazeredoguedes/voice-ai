/**
 * Uso do plano do Claude (sessão de 5 horas e limite semanal), o mesmo de claude.ai > Configurações > Uso.
 * Chega do backend a cada resposta da IA (evento claude_usage) e pode ser atualizado na hora.
 */
import { ref } from 'vue'
import axios from 'axios'
import { onWsMessage } from '../api/ws'

export interface UsageWindow {
  pct: number | null
  resets_at: number | null
  status?: string
}
export interface ClaudeUsage {
  windows: Record<string, UsageWindow>
  status?: string
  updated_at: number
}

const BASE = 'http://127.0.0.1:18450'
export const usage = ref<ClaudeUsage | null>(null)
export const refreshing = ref(false)
let started = false

export function startUsage(): void {
  if (started) return
  started = true
  onWsMessage((e) => {
    const u = (e as unknown as { usage?: ClaudeUsage }).usage
    if (e.type === 'claude_usage' && u) usage.value = u
  })
  void axios
    .get(`${BASE}/chat/usage`)
    .then((r) => {
      if (r.data?.usage) usage.value = r.data.usage
    })
    .catch(() => undefined)
}

export async function refreshUsage(): Promise<void> {
  refreshing.value = true
  try {
    const r = await axios.post(`${BASE}/chat/usage/refresh`, null, { timeout: 70000 })
    if (r.data?.usage) usage.value = r.data.usage
  } catch {
    // mantém o último valor
  } finally {
    refreshing.value = false
  }
}

export const WINDOW_LABEL: Record<string, string> = {
  five_hour: 'Sessão atual',
  seven_day: 'Limite semanal',
  seven_day_opus: 'Limite semanal (Opus)',
  seven_day_sonnet: 'Limite semanal (Sonnet)'
}

const WEEKDAY = ['dom.', 'seg.', 'ter.', 'qua.', 'qui.', 'sex.', 'sáb.']

/** "Redefine às 15:00" (hoje) ou "Reinicia sáb., 08:00" */
export function resetText(epoch: number | null | undefined): string {
  if (!epoch || epoch * 1000 <= Date.now()) return ''
  const d = new Date(epoch * 1000)
  const hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return `Redefine às ${hm}`
  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)
  if (d.toDateString() === tomorrow.toDateString()) return `Reinicia amanhã, ${hm}`
  return `Reinicia ${WEEKDAY[d.getDay()]}, ${hm}`
}

/** cor da barra: perto do limite fica amarela, no limite vermelha */
export function barColor(pct: number | null | undefined): string {
  if (pct == null) return 'bg-slate-600'
  if (pct >= 85) return 'bg-red-500'
  if (pct >= 60) return 'bg-amber-400'
  return 'bg-indigo-500'
}

export function ago(epoch: number): string {
  const s = Math.max(0, Date.now() / 1000 - epoch)
  if (s < 60) return 'agora há pouco'
  if (s < 3600) return `há ${Math.floor(s / 60)} min`
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`
  return `há ${Math.floor(s / 86400)} dia(s)`
}
