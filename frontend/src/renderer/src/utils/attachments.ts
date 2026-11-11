/**
 * Anexos do chat: imagens e arquivos de texto. Prepara o arquivo para o envio (imagem grande é reduzida,
 * texto é conferido) e devolve o conteúdo em base64, que é como o backend recebe.
 */
export interface PendingFile {
  id: string
  name: string
  mime: string
  kind: 'image' | 'text'
  size: number
  /** conteúdo em base64 */
  data: string
  /** miniatura para mostrar (data URL) */
  previewUrl?: string
}

export const MAX_FILES = 6
const MAX_IMAGE_SIDE = 1568 // lado maior: acima disso a IA reduz sozinha e só gastaria dados à toa
const KEEP_ORIGINAL_BELOW = 1.5 * 1024 * 1024
/** tamanho máximo padrão de cada anexo (Configurações muda, de 1 a 20 MB) */
export const DEFAULT_UPLOAD_MB = 2
const fmtMb = (mb: number): string => `${mb} MB`.replace('.', ',')
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.log', '.xml', '.yml', '.yaml', '.ini', '.toml', '.cfg',
  '.html', '.htm', '.css', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.vue', '.py', '.java', '.c', '.h', '.cpp', '.cs',
  '.go', '.rs', '.php', '.rb', '.sql', '.sh', '.bat', '.ps1', '.env', '.gitignore', '.srt', '.vtt'
])

/** valor de `accept` do seletor de arquivos do Windows */
export const ACCEPT = ['image/*', ...[...TEXT_EXT]].join(',')

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i).toLowerCase() : ''
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = () => reject(new Error('Não consegui ler o arquivo.'))
    r.readAsDataURL(blob)
  })
}

async function prepareImage(file: File, limitMb: number): Promise<PendingFile> {
  const limit = limitMb * 1024 * 1024
  const bmp = await createImageBitmap(file)
  const big = Math.max(bmp.width, bmp.height) > MAX_IMAGE_SIDE
  let blob: Blob = file
  let mime = file.type
  if (!IMAGE_MIMES.includes(mime) || big || file.size > Math.min(KEEP_ORIGINAL_BELOW, limit)) {
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bmp.width, bmp.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bmp.width * scale))
    canvas.height = Math.max(1, Math.round(bmp.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Não consegui preparar a imagem.')
    ctx.fillStyle = '#ffffff' // fundo para imagens com transparência virarem JPEG
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    // reduz a qualidade aos poucos até caber no limite escolhido
    for (const quality of [0.88, 0.75, 0.6, 0.45]) {
      blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Não consegui preparar a imagem.'))), 'image/jpeg', quality)
      )
      if (blob.size <= limit) break
    }
    mime = 'image/jpeg'
  }
  bmp.close()
  if (blob.size > limit) {
    throw new Error(`A imagem ${file.name || ''} ficou com ${fmtFileSize(blob.size)}, acima do limite de ${fmtMb(limitMb)}. Dá para aumentar em Configurações.`.replace('  ', ' '))
  }
  const data = await blobToBase64(blob)
  const name = file.name && file.name !== 'image.png' ? file.name : `captura-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.${mime === 'image/png' ? 'png' : 'jpg'}`
  return {
    id: crypto.randomUUID(),
    name,
    mime,
    kind: 'image',
    size: blob.size,
    data,
    previewUrl: `data:${mime};base64,${data}`
  }
}

async function prepareText(file: File, limitMb: number): Promise<PendingFile> {
  if (file.size > limitMb * 1024 * 1024) {
    throw new Error(`${file.name} é grande demais (${fmtFileSize(file.size)}; o limite é ${fmtMb(limitMb)}). Dá para aumentar em Configurações.`)
  }
  const buf = new Uint8Array(await file.arrayBuffer())
  if (buf.slice(0, 4096).includes(0)) throw new Error(`${file.name} não parece um arquivo de texto.`)
  return {
    id: crypto.randomUUID(),
    name: file.name || 'arquivo.txt',
    mime: file.type || 'text/plain',
    kind: 'text',
    size: file.size,
    data: await blobToBase64(file)
  }
}

/** Prepara um arquivo escolhido, colado ou arrastado. Lança um Error com mensagem pronta se não for aceito. */
export async function prepareFile(file: File, limitMb: number = DEFAULT_UPLOAD_MB): Promise<PendingFile> {
  if (file.type.startsWith('image/')) return prepareImage(file, limitMb)
  if (file.type.startsWith('text/') || TEXT_EXT.has(extOf(file.name)) || file.type === 'application/json') {
    return prepareText(file, limitMb)
  }
  throw new Error(`O tipo de ${file.name || 'arquivo'} não é aceito (use imagens ou arquivos de texto).`)
}

export function fmtFileSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** data URL (ex.: imagem lida da área de transferência pelo Electron) → File */
export async function dataUrlToFile(dataUrl: string, name: string): Promise<File> {
  const blob = await (await fetch(dataUrl)).blob()
  return new File([blob], name, { type: blob.type })
}
