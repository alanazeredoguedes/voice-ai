/**
 * Verifica se a organização (ou você mesmo) ligou a telemetria do Claude Code que manda
 * dados para um servidor externo (OpenTelemetry) e, principalmente, se o TEXTO dos prompts
 * está incluído.
 *
 * Fontes lidas (documentação: code.claude.com/docs/en/managed-settings e /monitoring-usage):
 *  1. Configurações do painel do claude.ai (server-managed), em cache em ~/.claude/remote-settings.json
 *  2. Política do Windows: HKLM\SOFTWARE\Policies\ClaudeCode, valor "Settings" (JSON)
 *  3. Arquivos: managed-settings.json + managed-settings.d/*.json no diretório do sistema
 *  4. HKCU\SOFTWARE\Policies\ClaudeCode (fallback gravável pelo usuário)
 *  5. Suas configurações (~/.claude/settings.json → env) e variáveis de ambiente
 *  + o aviso de monitoramento em ~/.claude/policy-limits.json
 *
 * Só LÊ arquivos; nada é alterado nem enviado para lugar nenhum.
 */
import { execFile } from 'child_process'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export type MonitoringLevel = 'none' | 'metrics' | 'content'

export interface MonitoringReport {
  checkedAt: string
  level: MonitoringLevel
  telemetryEnabled: boolean
  /** O que vai junto, além das métricas */
  collects: { prompts: boolean; responses: boolean; toolDetails: boolean; fullConversation: boolean }
  /** Para onde vai (só o endereço do servidor) */
  destinations: string[]
  /** Origem da configuração: painel da organização, política do computador ou suas configurações */
  configuredBy: string[]
  /** Há scripts automáticos (hooks) gerenciados, que também podem enviar dados */
  managedHooks: boolean
  /** Aviso de monitoramento publicado na conta, se houver */
  notice: string | null
  /** Fontes de configuração gerenciada encontradas (mesmo sem telemetria) */
  managedSources: string[]
  /** O que foi verificado (para a lista de detalhes na tela) */
  checked: string[]
}

type Json = Record<string, unknown>
interface Source {
  label: string
  by: 'painel da organização no claude.ai' | 'política instalada neste computador' | 'suas configurações'
  managed: boolean
  data: Json
}

const claudeDir = (): string => process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude')

function readJson(path: string): Json | null {
  try {
    if (!existsSync(path)) return null
    const d = JSON.parse(readFileSync(path, 'utf8'))
    return d && typeof d === 'object' && !Array.isArray(d) ? (d as Json) : null
  } catch {
    return null
  }
}

function systemDir(): string {
  if (process.platform === 'win32') return join(process.env['ProgramFiles'] || 'C:\\Program Files', 'ClaudeCode')
  if (process.platform === 'darwin') return '/Library/Application Support/ClaudeCode'
  return '/etc/claude-code'
}

/** Lê o valor "Settings" (JSON) de uma chave de política do Windows. */
function readRegistryPolicy(hive: 'HKLM' | 'HKCU'): Promise<Json | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile(
      'reg',
      ['query', `${hive}\\SOFTWARE\\Policies\\ClaudeCode`, '/v', 'Settings'],
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        if (err) return resolve(null) // chave não existe
        const m = stdout.match(/Settings\s+REG_(?:EXPAND_)?SZ\s+(.+)/)
        if (!m) return resolve(null)
        try {
          const d = JSON.parse(m[1].trim())
          resolve(d && typeof d === 'object' ? (d as Json) : null)
        } catch {
          resolve(null)
        }
      }
    )
  })
}

const truthy = (v: unknown): boolean => typeof v === 'string' && /^(1|true|yes|on)$/i.test(v.trim())

function envOf(src: Json): Record<string, string> {
  const env = src['env']
  if (!env || typeof env !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env as Json)) if (v !== undefined && v !== null) out[k] = String(v)
  return out
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url.replace(/^\w+:\/\//, '').split('/')[0]
  }
}

export async function checkClaudeMonitoring(): Promise<MonitoringReport> {
  const dir = claudeDir()
  const sources: Source[] = []
  const checked: string[] = []

  // 1. painel do claude.ai (cache local das configurações do servidor)
  // o formato interno do cache não é documentado: aceita o objeto direto ou dentro de "settings"
  const remoteRaw = readJson(join(dir, 'remote-settings.json'))
  const inner = remoteRaw?.['settings']
  const remote = inner && typeof inner === 'object' && !Array.isArray(inner) ? (inner as Json) : remoteRaw
  checked.push('Configurações enviadas pelo painel da organização (remote-settings.json)')
  if (remote && Object.keys(remote).length) {
    sources.push({ label: 'Painel da organização no claude.ai', by: 'painel da organização no claude.ai', managed: true, data: remote })
  }

  // 2. política do Windows (HKLM)
  if (process.platform === 'win32') {
    checked.push('Política do Windows (registro HKLM e HKCU)')
    const hklm = await readRegistryPolicy('HKLM')
    if (hklm) sources.push({ label: 'Política do Windows (HKLM)', by: 'política instalada neste computador', managed: true, data: hklm })
  }

  // 3. arquivos no diretório do sistema
  const sys = systemDir()
  checked.push(`Arquivos de política em ${sys}`)
  const file = readJson(join(sys, 'managed-settings.json'))
  if (file) sources.push({ label: 'managed-settings.json', by: 'política instalada neste computador', managed: true, data: file })
  try {
    for (const f of readdirSync(join(sys, 'managed-settings.d')).filter((n) => n.endsWith('.json')).sort()) {
      const d = readJson(join(sys, 'managed-settings.d', f))
      if (d) sources.push({ label: `managed-settings.d/${f}`, by: 'política instalada neste computador', managed: true, data: d })
    }
  } catch {
    /* pasta não existe */
  }

  // 4. HKCU (fallback gravável pelo usuário)
  if (process.platform === 'win32') {
    const hkcu = await readRegistryPolicy('HKCU')
    if (hkcu) sources.push({ label: 'Política do Windows (HKCU)', by: 'política instalada neste computador', managed: true, data: hkcu })
  }

  // 5. configurações pessoais e variáveis de ambiente
  checked.push('Suas configurações do Claude Code e variáveis de ambiente')
  const user = readJson(join(dir, 'settings.json'))
  if (user) sources.push({ label: 'Suas configurações (settings.json)', by: 'suas configurações', managed: false, data: user })
  const procEnv: Json = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v && (k.startsWith('OTEL_') || k === 'CLAUDE_CODE_ENABLE_TELEMETRY')) procEnv[k] = v
  }
  if (Object.keys(procEnv).length) {
    sources.push({ label: 'Variáveis de ambiente', by: 'suas configurações', managed: false, data: { env: procEnv } })
  }

  // Ambiente efetivo: configuração gerenciada vence a pessoal (fontes já estão em ordem de prioridade)
  const env: Record<string, string> = {}
  const origin: Record<string, Source> = {}
  for (const s of sources) {
    for (const [k, v] of Object.entries(envOf(s.data))) {
      if (!(k in env)) {
        env[k] = v
        origin[k] = s
      }
    }
  }

  const telemetryEnabled = truthy(env['CLAUDE_CODE_ENABLE_TELEMETRY'])
  const prompts = telemetryEnabled && truthy(env['OTEL_LOG_USER_PROMPTS'])
  const responsesVar = env['OTEL_LOG_ASSISTANT_RESPONSES']
  const responses = telemetryEnabled && (responsesVar !== undefined ? truthy(responsesVar) : prompts)
  const toolDetails = telemetryEnabled && (truthy(env['OTEL_LOG_TOOL_DETAILS']) || truthy(env['OTEL_LOG_TOOL_CONTENT']))
  const raw = env['OTEL_LOG_RAW_API_BODIES']
  const fullConversation = telemetryEnabled && !!raw && raw.trim() !== '0' && raw.trim().toLowerCase() !== 'false'

  const destinations = telemetryEnabled
    ? [
        ...new Set(
          ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT', 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT']
            .map((k) => env[k])
            .filter((v): v is string => !!v)
            .map(hostOf)
        )
      ]
    : []

  const configuredBy = telemetryEnabled && origin['CLAUDE_CODE_ENABLE_TELEMETRY'] ? [origin['CLAUDE_CODE_ENABLE_TELEMETRY'].by] : []

  const managedHooks = sources.some((s) => {
    const h = s.data['hooks']
    return s.managed && !!h && typeof h === 'object' && Object.keys(h as Json).length > 0
  })

  // aviso de monitoramento publicado pela organização
  checked.push('Aviso de monitoramento da organização (policy-limits.json)')
  let notice: string | null = null
  const limits = readJson(join(dir, 'policy-limits.json'))
  const n = limits?.['monitoring_notice']
  if (typeof n === 'string' && n.trim()) notice = n.trim()
  else if (n && typeof n === 'object') {
    const t = (n as Json)['message'] ?? (n as Json)['text'] ?? (n as Json)['title']
    notice = typeof t === 'string' && t.trim() ? t.trim() : 'A organização publicou um aviso de monitoramento.'
  }

  const level: MonitoringLevel = !telemetryEnabled
    ? 'none'
    : prompts || responses || toolDetails || fullConversation
      ? 'content'
      : 'metrics'

  return {
    checkedAt: new Date().toISOString(),
    level,
    telemetryEnabled,
    collects: { prompts, responses, toolDetails, fullConversation },
    destinations,
    configuredBy,
    managedHooks,
    notice,
    managedSources: sources.filter((s) => s.managed).map((s) => s.label),
    checked
  }
}
