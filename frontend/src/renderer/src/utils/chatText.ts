/**
 * Texto de uma mensagem do chat da chamada: links clicáveis e um pouco de formatação (**negrito**, *itálico*,
 * `código`). Não usa o formatador do Chat IA (utils/richText.ts): aquele é feito para respostas lidas em voz alta
 * e REMOVE os links do texto.
 */
export interface ChatRun {
  text: string
  /** só nos links (http/https) */
  href?: string
  bold?: boolean
  italic?: boolean
  code?: boolean
}

// http(s)://… até um espaço; o que sobra de pontuação no fim não faz parte do link
const URL_RE = /https?:\/\/[^\s<>"']+/gi
const TRAILING_CHARS = '.,;:!?)]}»”’'

/** Links no texto (o fim com pontuação é devolvido ao texto). */
function splitLinks(text: string): ChatRun[] {
  const out: ChatRun[] = []
  let last = 0
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0]
    // a pontuação do fim não é do link; ")" só sai se não houver "(" para ela fechar (links da Wikipédia têm parênteses)
    let tail = ''
    for (;;) {
      const ch = url.slice(-1)
      const open = url.match(/\(/g)?.length ?? 0
      const close = url.match(/\)/g)?.length ?? 0
      if (!ch || !TRAILING_CHARS.includes(ch) || (ch === ')' && close <= open)) break
      tail = ch + tail
      url = url.slice(0, -1)
    }
    if (m.index! > last) out.push({ text: text.slice(last, m.index) })
    out.push({ text: url, href: url })
    if (tail) out.push({ text: tail })
    last = m.index! + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

/** **negrito**, *itálico* e `código` dentro de um trecho que não é link. */
function splitStyles(text: string): ChatRun[] {
  const out: ChatRun[] = []
  const re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|(?<![\w*])\*([^*\n]+)\*(?![\w*])/g
  let last = 0
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index) })
    if (m[1] !== undefined) out.push({ text: m[1], code: true })
    else if (m[2] !== undefined) out.push({ text: m[2], bold: true })
    else out.push({ text: m[3], italic: true })
    last = m.index! + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

export function parseChatText(text: string): ChatRun[] {
  return splitLinks(text).flatMap((r) => (r.href ? [r] : splitStyles(r.text)))
}
