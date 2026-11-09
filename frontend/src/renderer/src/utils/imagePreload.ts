import { reactive } from 'vue'

/**
 * Pré-carrega as imagens em tamanho original assim que as miniaturas aparecem no chat,
 * para o modal abrir a imagem na hora (sem o "carregando" de 3-4 s).
 *
 * As imagens ficam guardadas aqui (e no cache do navegador) já decodificadas; o modal
 * consulta o status para saber se pode mostrar a original direto ou se ela falhou
 * (site que bloqueia acesso direto), caso em que fica com a miniatura sem esperar.
 */
export type PreloadStatus = 'loading' | 'done' | 'error'

const MAX_PARALLEL = 4
const MAX_KEPT = 120 // limite de imagens mantidas na memória

const status = reactive(new Map<string, PreloadStatus>())
const kept = new Map<string, HTMLImageElement>()
const queue: string[] = []
let running = 0

export function preloadStatus(url: string): PreloadStatus | undefined {
  return status.get(url)
}

function pump(): void {
  while (running < MAX_PARALLEL && queue.length) {
    const url = queue.shift()!
    running++
    const img = new Image()
    img.referrerPolicy = 'no-referrer' // igual ao <img> do modal (alguns sites bloqueiam com referer)
    img.decoding = 'async'
    const finish = (ok: boolean): void => {
      status.set(url, ok ? 'done' : 'error')
      if (ok) {
        kept.set(url, img)
        if (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value as string)
      }
      running--
      pump()
    }
    img.onload = () => {
      // decodifica já, para a troca no modal ser instantânea
      img.decode().then(
        () => finish(true),
        () => finish(true)
      )
    }
    img.onerror = () => finish(false)
    img.src = url
  }
}

/** Coloca as URLs na fila (ignora as que já foram ou estão sendo carregadas). */
export function preloadImages(urls: string[], priority = false): void {
  for (const url of urls) {
    if (!url || status.has(url)) {
      // já na fila sem ter começado: sobe para a frente se for prioridade
      if (priority && status.get(url) === 'loading') {
        const i = queue.indexOf(url)
        if (i > 0) queue.unshift(...queue.splice(i, 1))
      }
      continue
    }
    status.set(url, 'loading')
    if (priority) queue.unshift(url)
    else queue.push(url)
  }
  pump()
}
