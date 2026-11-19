/**
 * Diagnóstico da janela: grava num arquivo tudo o que acontece com as janelas do app (foco, mostrar e
 * esconder, "sempre por cima", tela cheia, a tecla ESC apertada dentro do app, travamentos da tela).
 *
 * Existe para investigar o relato do Windows de "o computador parece preso em tela cheia até apertar ESC":
 * depois que acontecer, o arquivo mostra se alguma janela do Voice AI estava por cima, em tela cheia ou
 * travada naquele momento. Arquivo: <dados do app>/logs/janela.log (até ~1 MB, com uma cópia anterior).
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'fs'
import { join } from 'path'
import type { BrowserWindow } from 'electron'
import { sysLog } from './sysLog'

const MAX_BYTES = 1024 * 1024
let file = ''

export function initWindowDiag(dataDir: string): string {
  const dir = join(dataDir, 'logs')
  mkdirSync(dir, { recursive: true })
  file = join(dir, 'janela.log')
  diag('app', `iniciado (${process.platform} ${process.arch}, Electron ${process.versions.electron})`)
  return file
}

export function diag(who: string, msg: string): void {
  // foco/perda de foco acontece o tempo todo: entra como detalhe (escondido por padrão na tela de logs)
  sysLog(/foco/.test(msg) ? 'debug' : /trav|erro|crash|não responde|inesperad/i.test(msg) ? 'warn' : 'info', 'janelas', `${who}: ${msg}`)
  if (!file) return
  try {
    if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`)
    const t = new Date()
    const stamp = `${t.toLocaleDateString('pt-BR')} ${t.toLocaleTimeString('pt-BR', { hour12: false })}.${String(t.getMilliseconds()).padStart(3, '0')}`
    appendFileSync(file, `${stamp} [${who}] ${msg}\n`)
  } catch {
    // diagnóstico nunca pode atrapalhar o app
  }
}

/** Registra os eventos de uma janela. */
export function watchWindow(win: BrowserWindow, who: string): void {
  const bounds = (): string => {
    const b = win.getBounds()
    return `${b.width}x${b.height} em ${b.x},${b.y}`
  }
  const state = (): string =>
    [
      win.isVisible() ? 'visível' : 'escondida',
      win.isFocused() ? 'com foco' : 'sem foco',
      win.isAlwaysOnTop() ? 'SEMPRE POR CIMA' : '',
      win.isFullScreen() ? 'TELA CHEIA' : '',
      win.isMinimized() ? 'minimizada' : ''
    ]
      .filter(Boolean)
      .join(', ')

  win.on('show', () => diag(who, `mostrada (${bounds()}; ${state()})`))
  win.on('hide', () => diag(who, 'escondida'))
  win.on('focus', () => diag(who, 'ganhou o foco'))
  win.on('blur', () => diag(who, `perdeu o foco (${state()})`))
  win.on('minimize', () => diag(who, 'minimizada'))
  win.on('restore', () => diag(who, 'restaurada'))
  win.on('always-on-top-changed', (_e, onTop) => diag(who, `sempre por cima: ${onTop ? 'LIGADO' : 'desligado'}`))
  win.on('enter-full-screen', () => diag(who, `entrou em TELA CHEIA (${bounds()})`))
  win.on('leave-full-screen', () => diag(who, 'saiu da tela cheia'))
  win.on('enter-html-full-screen', () => diag(who, 'conteúdo entrou em tela cheia (ex.: transmissão da chamada)'))
  win.on('leave-html-full-screen', () => diag(who, 'conteúdo saiu da tela cheia'))
  win.on('unresponsive', () => diag(who, 'TELA TRAVADA (não responde)'))
  win.on('responsive', () => diag(who, 'tela voltou a responder'))
  win.webContents.on('render-process-gone', (_e, d) => diag(who, `tela fechou inesperadamente: ${d.reason}`))
  // a tecla ESC que "destravou" chegou a uma janela do app?
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') diag(who, `ESC apertado dentro do app (${state()})`)
  })
}
