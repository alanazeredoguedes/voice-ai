/**
 * Linux (AppImage): atalho do app no menu de aplicativos (a busca do GNOME/KDE acha "Voice AI" por ele) e no login.
 *
 * O AppImage não instala nada: é só um arquivo. E a cada atualização ele muda de nome (Voice-AI-1.3.5.AppImage →
 * Voice-AI-1.3.6.AppImage), o que deixava o atalho do menu apontando para um arquivo que não existe mais. O GNOME
 * esconde da busca um .desktop cujo programa não existe, e o app "sumia". Por isso o app regrava o atalho a cada
 * abertura (só quando algo mudou), e a janela de atualização regrava logo depois de trocar o arquivo.
 */
import { app } from 'electron'
import { spawn } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/** Nome do .desktop: o mesmo de app.setDesktopName (é por ele que o GNOME liga a janela ao ícone). */
const DESKTOP_ID = 'voice-ai.desktop'
const ICON_NAME = 'voice-ai'

export const LINUX_MENU_FILE = join(homedir(), '.local', 'share', 'applications', DESKTOP_ID)
export const LINUX_AUTOSTART_FILE = join(homedir(), '.config', 'autostart', DESKTOP_ID)
export const HIDDEN_ARG = '--hidden'

/** Caminho entre aspas para a linha Exec (regras da especificação de .desktop: \ " ` $ escapados e % dobrado). */
function execQuote(path: string): string {
  return `"${path.replace(/[\\"`$]/g, (c) => `\\${c}`).replace(/%/g, '%%')}"`
}

/** Grava só se o conteúdo mudou (não mexe no arquivo à toa a cada abertura). Devolve true se gravou. */
function writeIfChanged(file: string, content: string): boolean {
  try {
    if (existsSync(file) && readFileSync(file, 'utf8') === content) return false
  } catch {
    // não deu para ler: grava por cima
  }
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content, { mode: 0o644 })
  return true
}

/** Ícone do app (256x256, o mesmo da janela) no tema de ícones do usuário. */
function installIcon(): void {
  const src = join(__dirname, '..', '..', 'resources', 'icon.png')
  const dest = join(homedir(), '.local', 'share', 'icons', 'hicolor', '256x256', 'apps', `${ICON_NAME}.png`)
  try {
    if (existsSync(dest) && statSync(dest).size === statSync(src).size) return
    mkdirSync(join(dest, '..'), { recursive: true })
    copyFileSync(src, dest)
  } catch {
    // sem ícone o atalho funciona do mesmo jeito (fica com o ícone genérico)
  }
}

function menuEntry(appImage: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Voice AI',
    'Comment=Voice AI Desktop App',
    `Exec=${execQuote(appImage)}`,
    `Icon=${ICON_NAME}`,
    'Terminal=false',
    'Categories=Utility;',
    'Keywords=voice;ai;voz;transcrição;transcricao;ditado;',
    'StartupWMClass=voice-ai',
    `X-AppImage-Version=${app.getVersion()}`,
    ''
  ].join('\n')
}

export function autostartEntry(appImage: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Voice AI',
    `Exec=${execQuote(appImage)} ${HIDDEN_ARG}`,
    `Icon=${ICON_NAME}`,
    'X-GNOME-Autostart-enabled=true',
    'Terminal=false',
    ''
  ].join('\n')
}

/**
 * Deixa o menu (e o login, se estiver ligado) apontando para `appImage`. Devolve o que mudou, para o log.
 * Só no Linux; quem chama garante que é o app empacotado.
 */
export function syncLinuxDesktopEntries(appImage: string): string[] {
  if (process.platform !== 'linux' || !appImage) return []
  const changed: string[] = []
  installIcon()
  if (writeIfChanged(LINUX_MENU_FILE, menuEntry(appImage))) {
    changed.push('menu de aplicativos')
    // atualiza o cache do menu (o GNOME percebe a mudança sozinho; outros ambientes podem precisar disto)
    try {
      const p = spawn('update-desktop-database', [join(homedir(), '.local', 'share', 'applications')], { stdio: 'ignore' })
      p.on('error', () => {})
      p.unref()
    } catch {
      // comando ausente: tudo bem
    }
  }
  if (existsSync(LINUX_AUTOSTART_FILE) && writeIfChanged(LINUX_AUTOSTART_FILE, autostartEntry(appImage))) {
    changed.push('inicialização com o sistema')
  }
  return changed
}
