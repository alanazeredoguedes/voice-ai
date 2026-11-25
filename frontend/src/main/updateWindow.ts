/**
 * Janela de progresso da atualização (Windows).
 *
 * Ao atualizar, o app fecha e o instalador silencioso roda por cerca de 1 minuto. Sem isto o usuário ficava sem
 * nenhum sinal do que acontece. O app não pode ficar aberto (o instalador precisa trocar os arquivos dele), então
 * uma janela separada, um script PowerShell + WPF (resources/updater-ui/update-window.ps1), é copiada para uma
 * pasta temporária, FORA da pasta de instalação, e aberta antes de o app fechar. Ela acompanha a instalação por sinais
 * reais (processos e bytes da pasta de instalação) e se fecha quando o app novo abre. Detalhes no próprio script.
 *
 * Se a janela não abrir (PowerShell bloqueado, etc.), a atualização segue em silêncio, como antes.
 */
import { app, BrowserWindow } from 'electron'
import { spawn } from 'child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { sysLog } from './sysLog'

const CAT = 'atualização'
const READY_TIMEOUT_MS = 6000

/** Pasta temporária de onde a janela roda (não pode ficar dentro da pasta de instalação, que é apagada). */
function tempDir(): string {
  return join(tmpdir(), 'voice-ai-update-ui')
}

/** Log que a janela escreve (o instalador roda fora do app); a abertura seguinte o junta ao log do sistema. */
export function updateWindowLogFile(): string {
  return join(app.getPath('userData'), 'logs', 'atualizacao-janela.log')
}

function resourceDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'updater-ui') : join(__dirname, '..', '..', 'resources', 'updater-ui')
}

/** Soma dos bytes da pasta: é o "tamanho anterior" que a janela usa como régua da barra de progresso. */
function dirBytes(root: string): number {
  let total = 0
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop() as string
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      try {
        if (e.isDirectory()) stack.push(p)
        else if (e.isFile()) total += statSync(p).size
      } catch {
        // arquivo sumiu no meio da contagem
      }
    }
  }
  return total
}

/**
 * Abre a janela e espera ela aparecer (até 6 s). Devolve true se abriu: aí o app pode fechar e a janela assume.
 * Devolve false em qualquer problema, e a atualização segue em silêncio.
 */
export async function launchUpdateWindow(fromVersion: string, toVersion: string): Promise<boolean> {
  if (process.platform !== 'win32' || !app.isPackaged) return false
  try {
    const src = join(resourceDir(), 'update-window.ps1')
    if (!existsSync(src)) {
      sysLog('warn', CAT, `janela de progresso não encontrada (${src}): atualizando em silêncio`)
      return false
    }
    const dir = tempDir()
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const script = join(dir, 'update-window.ps1')
    copyFileSync(src, script)
    const logo = join(dir, 'icon.png')
    try {
      copyFileSync(join(__dirname, '..', '..', 'resources', 'icon.png'), logo)
    } catch {
      // sem logo a janela abre do mesmo jeito
    }
    const ready = join(dir, 'ready.flag')
    const exe = app.getPath('exe')
    const installDir = dirname(exe)
    const t0 = Date.now()
    const oldBytes = dirBytes(installDir)
    sysLog('info', CAT, `abrindo a janela de progresso (pasta ${installDir}, ${(oldBytes / 1048576).toFixed(0)} MB, medido em ${Date.now() - t0} ms)`)

    // os valores vão num JSON (e não na linha de comando, que passa pelo cmd.exe e se confundiria com & ou % no caminho)
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        InstallDir: installDir,
        FromVersion: fromVersion,
        ToVersion: toVersion,
        AppExeName: basename(exe),
        OldBytes: oldBytes,
        LogFile: updateWindowLogFile(),
        ReadyFile: ready,
        Logo: logo
      }),
      'utf8'
    )

    // Por que "cmd /c start" e não um spawn direto do PowerShell: o Node prende os filhos a um job do Windows que os encerra
    // quando o app fecha (a janela morria junto), e com detached:true o PowerShell sai na hora sem executar o script
    // (sem console). O "start" cria o PowerShell como neto, que escapa do job e sobrevive ao app. A linha de comando
    // é toda fixa (a pasta atual é a temporária), sem nenhum caminho do usuário.
    const child = spawn(
      'cmd.exe',
      ['/d', '/c', 'start', '""', '/b', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', 'update-window.ps1', '-ConfigFile', 'config.json'],
      { cwd: dir, stdio: 'ignore', windowsHide: true }
    )
    child.on('error', (e) => sysLog('error', CAT, `não deu para abrir a janela de progresso: ${e.message}`))
    child.unref()

    const t1 = Date.now()
    while (!existsSync(ready) && Date.now() - t1 < READY_TIMEOUT_MS) await new Promise((r) => setTimeout(r, 100))
    if (!existsSync(ready)) {
      sysLog('warn', CAT, `a janela de progresso não abriu em ${READY_TIMEOUT_MS / 1000} s: atualizando em silêncio`)
      return false
    }
    sysLog('info', CAT, `janela de progresso aberta em ${Date.now() - t1} ms`)
    // a janela assumiu: esconde as do app para não ficarem duas coisas na tela até o app fechar
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.hide()
    return true
  } catch (e) {
    sysLog('error', CAT, `falha ao abrir a janela de progresso: ${e instanceof Error ? e.message : e}`)
    return false
  }
}

/**
 * Abertura seguinte: junta ao log do sistema o que a janela registrou (o app estava fechado nessa hora) e limpa a
 * pasta temporária. É assim que ficamos sabendo quanto tempo cada etapa da instalação levou.
 */
export function importUpdateWindowLog(): void {
  const file = updateWindowLogFile()
  try {
    if (existsSync(file)) {
      // o PowerShell grava um BOM no começo do arquivo: sem tirá-lo, a primeira linha não casaria com o padrão
      for (const line of readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
        const m = /^\d{4}-\d\d-\d\d (\d\d:\d\d:\d\d)\.\d+ (\w+)\s+\[janela\/atualização\] (.*)$/.exec(line)
        if (!m) continue
        const level = m[2] === 'ERROR' ? 'error' : m[2] === 'WARN' ? 'warn' : 'info'
        sysLog(level, CAT, `[janela ${m[1]}] ${m[3]}`)
      }
      rmSync(file, { force: true })
    }
  } catch (e) {
    sysLog('warn', CAT, `não consegui ler o log da janela de progresso: ${e instanceof Error ? e.message : e}`)
  }
  try {
    rmSync(tempDir(), { recursive: true, force: true })
  } catch {
    // pasta temporária em uso: o próximo ciclo limpa
  }
}
