/**
 * Linux (AppImage): atalho do app no menu de aplicativos (a busca do GNOME/KDE acha "Voice AI" por ele) e no login.
 *
 * O AppImage não instala nada: é só um arquivo. E a cada atualização ele muda de nome (Voice-AI-1.3.5.AppImage →
 * Voice-AI-1.3.6.AppImage), o que deixava o atalho do menu apontando para um arquivo que não existe mais. O GNOME
 * esconde da busca um .desktop cujo programa não existe, e o app "sumia". Por isso o app regrava o atalho a cada
 * abertura (só quando algo mudou), e a janela de atualização regrava logo depois de trocar o arquivo.
 *
 * Ícone: o atalho aponta para o arquivo do ícone pelo caminho completo, e não pelo nome no tema. Pelo nome, o GNOME
 * procura no cache de ícones do usuário (~/.local/share/icons/hicolor/icon-theme.cache), que outros programas criam
 * e que não é refeito quando um ícone novo chega. Com um cache velho, sem o nosso ícone, a barra lateral mostrava o
 * ícone genérico no lugar do Voice AI (e só às vezes: depende de quando o GNOME decide que o cache ainda vale).
 * Por garantia, esse cache também é refeito quando não tem o nosso ícone.
 */
import { app } from 'electron'
import { spawn } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, statSync, rmSync } from 'fs'
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

const USER_HICOLOR = join(homedir(), '.local', 'share', 'icons', 'hicolor')
const ICON_FILE = join(USER_HICOLOR, '256x256', 'apps', `${ICON_NAME}.png`)

/**
 * Ícone do app (256x256, o mesmo da janela) no tema de ícones do usuário. Devolve o valor da linha Icon= do atalho:
 * o caminho completo do arquivo (ou o nome no tema, se não deu para copiar).
 */
function installIcon(): string {
  const src = join(__dirname, '..', '..', 'resources', 'icon.png')
  try {
    if (!existsSync(ICON_FILE) || statSync(ICON_FILE).size !== statSync(src).size) {
      mkdirSync(join(ICON_FILE, '..'), { recursive: true })
      copyFileSync(src, ICON_FILE)
    }
  } catch {
    // sem ícone o atalho funciona do mesmo jeito (fica com o ícone genérico)
  }
  refreshIconCache()
  return existsSync(ICON_FILE) ? ICON_FILE : ICON_NAME
}

/** Refaz o cache de ícones do usuário se ele existe e não conhece o nosso ícone (ver o comentário do topo). */
function refreshIconCache(): void {
  const cache = join(USER_HICOLOR, 'icon-theme.cache')
  try {
    if (!existsSync(cache) || readFileSync(cache).includes(ICON_NAME)) return
  } catch {
    return
  }
  // -t: a pasta do usuário não tem index.theme; -f: refaz mesmo que pareça em dia
  const dropCache = (): void => {
    // sem o comando (ou se ele falhou), apaga o cache velho: sem cache o GNOME lê as pastas, e acha o ícone
    try {
      rmSync(cache, { force: true })
    } catch {
      // tudo bem: o atalho usa o caminho completo do ícone de qualquer jeito
    }
  }
  try {
    const p = spawn('gtk-update-icon-cache', ['-f', '-t', '-q', USER_HICOLOR], { stdio: 'ignore' })
    p.on('error', dropCache)
    p.on('exit', (code) => {
      if (code !== 0) dropCache()
    })
  } catch {
    dropCache()
  }
}

function menuEntry(appImage: string, icon: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Voice AI',
    'Comment=Voice AI Desktop App',
    `Exec=${execQuote(appImage)}`,
    `Icon=${icon}`,
    'Terminal=false',
    'Categories=Utility;',
    'Keywords=voice;ai;voz;transcrição;transcricao;ditado;',
    'StartupWMClass=voice-ai',
    `X-AppImage-Version=${app.getVersion()}`,
    ''
  ].join('\n')
}

export function autostartEntry(appImage: string, icon: string = existsSync(ICON_FILE) ? ICON_FILE : ICON_NAME): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Voice AI',
    `Exec=${execQuote(appImage)} ${HIDDEN_ARG}`,
    `Icon=${icon}`,
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
  const icon = installIcon()
  if (writeIfChanged(LINUX_MENU_FILE, menuEntry(appImage, icon))) {
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
  if (existsSync(LINUX_AUTOSTART_FILE) && writeIfChanged(LINUX_AUTOSTART_FILE, autostartEntry(appImage, icon))) {
    changed.push('inicialização com o sistema')
  }
  return changed
}
