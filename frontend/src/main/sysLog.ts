/**
 * Log do sistema, lado do processo principal do Electron: tudo o que o app escreve no console (console.log,
 * warn, error), os eventos das janelas (windowDiag) e a saída do backend quando ele cai vão para o mesmo log
 * que o backend guarda (aba Logs → Sistema e <dados>/logs/sistema.log), com a origem "electron".
 *
 * As entradas vão em lote para o backend (POST /logs/system). Enquanto ele não responde, ficam numa fila; se
 * ele continuar fora do ar por mais de 20 s, são gravadas direto no arquivo, para nada se perder (ex.: o
 * backend nem chegou a iniciar).
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'fs'
import { join } from 'path'
import { format } from 'util'

export type SysLevel = 'debug' | 'info' | 'warn' | 'error'

interface Entry {
  level: SysLevel
  cat: string
  msg: string
  src: string
  t: number
}

const MAX_QUEUE = 1000
const FILE_MAX_BYTES = 5 * 1024 * 1024
let queue: Entry[] = []
let timer: ReturnType<typeof setTimeout> | null = null
let backendUrl = ''
let file = ''
let failingSince = 0

export function initSysLog(dataDir: string, url: string): void {
  backendUrl = url
  const dir = join(dataDir, 'logs')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // sem pasta de logs: as entradas ficam só na fila
  }
  file = join(dir, 'sistema.log')
  hookConsole()
}

export function sysLog(level: SysLevel, cat: string, msg: string): void {
  queue.push({ level, cat: cat.slice(0, 40), msg: msg.slice(0, 4000), src: 'electron', t: Date.now() / 1000 })
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE)
  if (!timer) timer = setTimeout(flush, 1000)
}

async function flush(): Promise<void> {
  timer = null
  if (!queue.length || !backendUrl) return
  const batch = queue.slice(0, 500)
  try {
    const r = await fetch(`${backendUrl}/logs/system`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch)
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    queue = queue.slice(batch.length)
    failingSince = 0
  } catch {
    if (!failingSince) failingSince = Date.now()
    if (Date.now() - failingSince > 20_000) {
      writeToFile(queue)
      queue = []
    }
  }
  if (queue.length && !timer) timer = setTimeout(flush, failingSince ? 3000 : 200)
}

/** Grava direto no arquivo, no mesmo formato do backend (usado quando o backend está fora do ar). */
function writeToFile(entries: Entry[]): void {
  if (!file || !entries.length) return
  try {
    if (existsSync(file) && statSync(file).size > FILE_MAX_BYTES) renameSync(file, `${file}.1`)
    const lines = entries.map((e) => {
      const d = new Date(e.t * 1000)
      const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
      const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
      return `${stamp} ${e.level.toUpperCase().padEnd(5)} [${e.src}/${e.cat}] ${e.msg}`
    })
    appendFileSync(file, lines.join('\n') + '\n')
  } catch {
    // log nunca pode atrapalhar o app
  }
}

const PREFIX = /^\[([\w\- ]{1,30})\]\s*([\s\S]*)$/

/** console.log/warn/error continuam no terminal e também vão para o log do sistema. */
function hookConsole(): void {
  const wrap = (name: 'log' | 'info' | 'warn' | 'error', level: SysLevel): void => {
    const original = console[name].bind(console)
    console[name] = (...args: unknown[]) => {
      original(...args)
      try {
        const text = format(...args).trim()
        if (!text) return
        const m = PREFIX.exec(text)
        sysLog(level, m ? m[1] : 'geral', m ? m[2] : text)
      } catch {
        // idem
      }
    }
  }
  wrap('log', 'info')
  wrap('info', 'info')
  wrap('warn', 'warn')
  wrap('error', 'error')
}

/**
 * Guarda as últimas linhas que o backend escreveu: se ele cair antes de ligar o próprio log (ex.: erro ao
 * importar uma biblioteca), essas linhas explicam o porquê.
 */
export function backendTail(max = 40): { push: (chunk: string) => void; lines: () => string[] } {
  let lines: string[] = []
  return {
    push(chunk) {
      lines = [...lines, ...chunk.split(/\r?\n/).filter((l) => l.trim())].slice(-max)
    },
    lines: () => lines
  }
}
