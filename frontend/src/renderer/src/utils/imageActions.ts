import { ref } from 'vue'
import type { MediaItem } from '../types'

/**
 * Ações nas imagens do Chat IA (visualizador e botão direito): copiar a imagem, baixar e copiar o link.
 * A imagem é baixada pelo processo principal do Electron (a tela não pode ler imagens de outros sites)
 * e convertida para PNG antes de ir para a área de transferência: assim qualquer formato (WebP, AVIF...)
 * cola no WhatsApp, e-mail ou editores.
 */
type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>
const invoke: Invoke | undefined = (window as unknown as { electron?: { ipcRenderer?: { invoke: Invoke } } }).electron
  ?.ipcRenderer?.invoke

/** aviso curto mostrado na tela ("Imagem copiada", "Salva em Downloads"...) */
export const imageToast = ref<{ text: string; path?: string; error?: boolean } | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null

function toast(text: string, opts: { path?: string; error?: boolean } = {}): void {
  imageToast.value = { text, ...opts }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (imageToast.value = null), opts.path ? 5000 : 2500)
}

const urlsOf = (item: MediaItem): string[] => [item.url, item.thumb].filter(Boolean)

async function toPngBase64(dataUrl: string): Promise<string> {
  const img = new Image()
  img.src = dataUrl
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  canvas.getContext('2d')!.drawImage(img, 0, 0)
  return canvas.toDataURL('image/png').split(',')[1]
}

export async function copyImage(item: MediaItem): Promise<void> {
  if (!invoke) return toast('Copiar imagem só funciona no app', { error: true })
  toast('Copiando imagem...')
  try {
    const r = (await invoke('media:fetch-image', urlsOf(item))) as { ok: boolean; dataUrl?: string }
    if (!r.ok || !r.dataUrl) return toast('Não foi possível baixar a imagem (o site pode bloquear)', { error: true })
    const ok = ((await invoke('media:copy-png', await toPngBase64(r.dataUrl))) as { ok: boolean }).ok
    toast(ok ? 'Imagem copiada: é só colar (Ctrl+V)' : 'Não foi possível copiar a imagem', { error: !ok })
  } catch {
    toast('Não foi possível copiar a imagem', { error: true })
  }
}

export async function saveImage(item: MediaItem): Promise<void> {
  if (!invoke) return toast('Baixar só funciona no app', { error: true })
  toast('Baixando...')
  try {
    const r = (await invoke('media:save-image', { urls: urlsOf(item), name: item.title })) as { ok: boolean; path?: string }
    if (r.ok && r.path) toast('Salva na pasta Downloads', { path: r.path })
    else toast('Não foi possível baixar a imagem (o site pode bloquear)', { error: true })
  } catch {
    toast('Não foi possível baixar a imagem', { error: true })
  }
}

export async function copyLink(item: MediaItem): Promise<void> {
  try {
    await navigator.clipboard.writeText(item.url)
    toast('Link da imagem copiado')
  } catch {
    toast('Não foi possível copiar o link', { error: true })
  }
}

export function openSource(item: MediaItem): void {
  const url = item.page_url || item.url
  if (url) window.open(url, '_blank')
}

export function showInFolder(path: string): void {
  void invoke?.('shell:show-item', path)
}
