/**
 * Cancelamento de eco do sistema inteiro no Linux (PipeWire).
 *
 * O cancelamento de eco do navegador só tira do microfone o som que o próprio app toca. Quem usa
 * caixa de som (ex.: a TV) e assiste a um vídeo em outro programa manda esse som de volta pelo
 * microfone, e quem está na chamada ouve em dobro (a transmissão + o vazamento, atrasado: eco).
 *
 * Aqui o app roda um processo do PipeWire só dele (`pipewire -c <config>`) com o módulo de
 * cancelamento de eco (o mesmo algoritmo do WebRTC/Google Meet) em "modo monitor": a referência do
 * que deve ser tirado é tudo o que sai na saída de som do computador. O resultado é um microfone
 * "VoiceAI-Microfone-Sem-Eco", que a chamada usa no lugar do microfone escolhido.
 *
 * Não instala nada: o módulo vem no pacote básico do PipeWire (o servidor de som padrão do Ubuntu
 * desde a 22.10). Sem PipeWire, a chamada segue com o microfone comum. Fechar o processo desfaz tudo.
 */
import { spawn, type ChildProcess } from 'child_process'
import { app } from 'electron'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { parsePwDump, run } from './linuxShareAudio'

export const AEC_SOURCE_LABEL = 'VoiceAI-Microfone-Sem-Eco'
const SOURCE_NODE = 'voiceai_aec_source'

type LogFn = (level: 'info' | 'warn' | 'error', msg: string) => void

let proc: ChildProcess | null = null
let current = ''

/** Texto de configuração do processo do PipeWire (o formato é o dos arquivos .conf do PipeWire). */
function config(targetNode: string): string {
  const q = (v: string): string => `"${v.replace(/["\\]/g, '')}"`
  return `
context.properties = { log.level = 1 }
context.spa-libs = {
  audio.convert.* = audioconvert/libspa-audioconvert
  support.*       = support/libspa-support
}
context.modules = [
  { name = libpipewire-module-rt flags = [ ifexists nofail ] }
  { name = libpipewire-module-protocol-native }
  { name = libpipewire-module-client-node }
  { name = libpipewire-module-adapter }
  { name = libpipewire-module-echo-cancel
    args = {
      library.name = aec/libspa-aec-webrtc
      monitor.mode = true
      audio.channels = 1
      aec.args = {
        webrtc.gain_control = false
        webrtc.extended_filter = true
        webrtc.delay_agnostic = true
        webrtc.high_pass_filter = true
        webrtc.noise_suppression = true
      }
      capture.props = {
        node.name = "voiceai_aec_capture"
        node.passive = true
        ${targetNode ? `target.object = ${q(targetNode)}` : ''}
      }
      source.props = {
        node.name = "${SOURCE_NODE}"
        node.description = "${AEC_SOURCE_LABEL}"
        media.class = "Audio/Source"
        priority.session = 0
        priority.driver = 0
      }
      playback.props = { node.name = "voiceai_aec_playback" node.passive = true }
    }
  }
]
`
}

/** Nó do PipeWire do microfone com este nome na tela (o rótulo que o Chromium mostra). */
async function sourceNodeName(label: string): Promise<string> {
  if (!label || /^(default|padrão)/i.test(label)) return ''
  const objects = parsePwDump(await run('pw-dump', []))
  const node = objects.find((o) => {
    const p = o.info?.props ?? {}
    return o.type === 'PipeWire:Interface:Node' && p['media.class'] === 'Audio/Source' && (p['node.description'] === label || p['node.nick'] === label)
  })
  return String(node?.info?.props?.['node.name'] ?? '')
}

async function sourceExists(): Promise<boolean> {
  try {
    return parsePwDump(await run('pw-dump', [])).some(
      (o) => o.type === 'PipeWire:Interface:Node' && o.info?.props?.['node.name'] === SOURCE_NODE
    )
  } catch {
    return false
  }
}

/**
 * Liga o microfone sem eco para o microfone `micLabel` (rótulo do dispositivo; vazio = padrão do
 * sistema). Devolve o rótulo do microfone novo, que a chamada procura na lista de dispositivos.
 */
export async function startEchoCancel(micLabel: string, log: LogFn): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  try {
    await run('pipewire', ['--version'])
    await run('pw-dump', ['--version'])
  } catch {
    return { ok: false, error: 'precisa do PipeWire (servidor de som padrão do Ubuntu 22.10 em diante)' }
  }
  let target = ''
  try {
    target = await sourceNodeName(micLabel)
  } catch {
    // sem a lista: usa o microfone padrão
  }
  // já está ligado para esse microfone
  if (proc && current === target && (await sourceExists())) return { ok: true, label: AEC_SOURCE_LABEL }
  if (proc) {
    stopEchoCancel()
    // espera o anterior sumir (senão o teste abaixo acharia o microfone velho)
    for (let i = 0; i < 20 && (await sourceExists()); i++) await new Promise((r) => setTimeout(r, 50))
  }

  const dir = join(app.getPath('userData'), 'pipewire')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'voiceai-echo-cancel.conf')
  writeFileSync(file, config(target))

  const child = spawn('pipewire', ['-c', file], { stdio: ['ignore', 'ignore', 'pipe'] })
  proc = child
  current = target
  let stderr = ''
  child.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)))
  child.on('exit', (code) => {
    if (proc !== child) return
    proc = null
    log('warn', `o cancelamento de eco parou (código ${code})${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`)
  })

  for (let i = 0; i < 40; i++) {
    if (proc !== child) return { ok: false, error: `o processo do PipeWire encerrou${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}` }
    if (await sourceExists()) {
      log('info', `cancelamento de eco ligado (microfone: ${target || 'padrão do sistema'}; referência: tudo o que sai na saída de som)`)
      return { ok: true, label: AEC_SOURCE_LABEL }
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  stopEchoCancel()
  return { ok: false, error: 'o microfone sem eco não apareceu no PipeWire' }
}

export function stopEchoCancel(): void {
  const child = proc
  proc = null
  current = ''
  child?.kill()
}

app.on('before-quit', stopEchoCancel)
