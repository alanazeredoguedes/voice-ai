/**
 * Log do sistema, lado da tela: manda ações e erros para o backend (POST /logs/system), que junta tudo com o
 * que o backend e o processo principal registram (aba Logs → Sistema e o arquivo sistema.log).
 *
 * As entradas vão em lote a cada segundo. Se o backend não responder, ficam guardadas e vão depois (com a
 * hora em que aconteceram). Usa fetch direto, e não o cliente axios: uma falha ao mandar o log não pode virar
 * outro log de falha.
 */
import { BACKEND_URL } from '../api/port'

export type SysLevel = 'debug' | 'info' | 'warn' | 'error'

interface Pending {
  level: SysLevel
  cat: string
  msg: string
  src: string
  t: number
}

const MAX_PENDING = 500
let pending: Pending[] = []
let timer: ReturnType<typeof setTimeout> | null = null
let source = 'tela'
let failures = 0

/** Nome da origem nas entradas (ex.: "tela", "overlay"). */
export function setSyslogSource(name: string): void {
  source = name
}

export function syslog(level: SysLevel, cat: string, msg: string): void {
  pending.push({ level, cat: cat.slice(0, 40), msg: msg.slice(0, 4000), src: source, t: Date.now() / 1000 })
  if (pending.length > MAX_PENDING) pending = pending.slice(-MAX_PENDING)
  schedule(1000)
}

function schedule(ms: number): void {
  if (!timer) timer = setTimeout(flush, ms)
}

async function flush(): Promise<void> {
  timer = null
  if (!pending.length) return
  const batch = pending
  pending = []
  try {
    const r = await fetch(`${BACKEND_URL}/logs/system`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch)
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    failures = 0
  } catch {
    // backend fora do ar: guarda e tenta de novo, cada vez mais devagar (até 15 s)
    pending = [...batch, ...pending].slice(-MAX_PENDING)
    failures++
  }
  if (pending.length) schedule(Math.min(15000, 1000 * 2 ** Math.min(failures, 4)))
}

export function errText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}${e.stack ? `\n${e.stack.split('\n').slice(1, 6).join('\n')}` : ''}`
  try {
    return typeof e === 'string' ? e : JSON.stringify(e)
  } catch {
    return String(e)
  }
}

/** Erros não tratados da página (JavaScript e promessas rejeitadas). */
export function installErrorHandlers(): void {
  window.addEventListener('error', (e) => {
    syslog('error', 'erro', `${e.message} (${e.filename?.split('/').pop() ?? '?'}:${e.lineno})${e.error ? `\n${errText(e.error)}` : ''}`)
  })
  window.addEventListener('unhandledrejection', (e) => {
    syslog('error', 'erro', `promessa rejeitada sem tratamento: ${errText(e.reason)}`)
  })
}
