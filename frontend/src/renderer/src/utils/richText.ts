/**
 * Texto das respostas do chat: markdown simples + marcadores de mídia.
 *
 * MESMA lógica de backend/services/rich_text.py (os casos de
 * backend/tests/fixtures/rich_text_cases.json rodam nos dois: richText.test.mjs).
 *
 * O `plain` é o texto falado: sem formatação e sem marcadores de mídia. Todas as posições da fala
 * (destaque, "parou em", "ouvir daqui", cache de áudio) apontam para ele. Para a tela, cada trecho
 * de texto sabe onde começa no `plain` (`o`), e assim o destaque acha o lugar certo.
 */

export interface Run {
  text: string
  bold: boolean
  italic: boolean
  code: boolean
  /** posição no plain (undefined = texto que ainda está chegando e não é falado ainda) */
  o?: number
}

export type Line =
  | { type: 'blank' }
  | { type: 'media'; id: string }
  | { type: 'h'; level: number; text: string }
  | { type: 'li'; ordered: boolean; n?: number; indent: number; text: string }
  | { type: 'tsep' }
  | { type: 'tr'; cells: string[] }
  | { type: 'p'; text: string }

/** o que a voz fala no lugar de uma tabela (igual ao backend) */
export const TABLE_SPOKEN = 'Deixei uma tabela aqui no chat pra você dar uma olhada.'

const MEDIA_LINE_RE =/^\[\[media:([A-Za-z0-9_-]+)\]\]$/
const HEADING_RE = /^(#{1,6})\s+(.*)$/
const BULLET_RE = /^[-*•]\s+(.*)$/
const ORDERED_RE = /^(\d{1,3})[.)]\s+(.*)$/
const TABLE_SEP_RE = /^\|?[\s:|-]+$/
const UNSETTLED_RE = /^(#{1,6}|[-*•]|\d{1,3}[.)]?)$/
const LINK_RE = /\[([^\]\n]*)\]\((https?:\/\/[^)\s]*)\)/y
const MAYBE_LINK_RE = /\[[^\]\n]*(\](\([^)\s]*)?)?$/y
const URL_START_RE = /(^|[\s(])(h|ht|htt|https?|https?:|https?:\/)$/
const isSpace = (c: string): boolean => /\s/.test(c)

/** Mesmos ajustes do backend no texto que chega (só hífen simples, quebras de linha \n). */
export function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[–—]/g, '-')
}

function rstripChars(s: string, chars: string): string {
  let e = s.length
  while (e > 0 && chars.includes(s[e - 1])) e--
  return s.slice(0, e)
}

/**
 * Trechos de uma linha, sem os símbolos de formatação.
 * `partial`: a linha ainda está chegando; devolve também `rest`, o fim que ainda pode mudar de sentido
 * (fica fora do plain, mas a tela mostra).
 */
export function parseInline(src: string, partial = false): { runs: Run[]; rest: string } {
  let s = src
  if (partial) {
    s = rstripChars(s, ' \t(')
    const m = URL_START_RE.exec(s)
    if (m) s = rstripChars(s.slice(0, m.index + m[1].length), ' \t(')
  }
  const runs: Run[] = []
  let bold = false
  let italic = false
  let code = false
  let buf = ''
  const flush = (): void => {
    if (buf) {
      runs.push({ text: buf, bold, italic, code })
      buf = ''
    }
  }
  const n = s.length
  let i = 0
  let stop = -1
  while (i < n) {
    const ch = s[i]
    if (code) {
      if (ch === '`') {
        flush()
        code = false
      } else buf += ch
      i++
      continue
    }
    if (ch === '`') {
      if (partial && i === n - 1) {
        stop = i
        break
      }
      flush()
      code = true
      i++
      continue
    }
    if (ch === '*') {
      let k = i
      while (k < n && s[k] === '*') k++
      if (partial && k === n) {
        stop = i
        break
      }
      const prev = i > 0 ? s[i - 1] : ' '
      const nxt = k < n ? s[k] : ' '
      let run = k - i
      while (run > 0) {
        const size = run >= 2 ? 2 : 1
        const isBold = size === 2
        const opened = isBold ? bold : italic
        if (opened && !isSpace(prev)) {
          flush()
          if (isBold) bold = false
          else italic = false
        } else if (!opened && !isSpace(nxt)) {
          flush()
          if (isBold) bold = true
          else italic = true
        } else buf += '*'.repeat(size)
        run -= size
      }
      i = k
      continue
    }
    if (ch === '[') {
      LINK_RE.lastIndex = i
      const m = LINK_RE.exec(s)
      if (m) {
        buf += m[1]
        i = LINK_RE.lastIndex
        continue
      }
      MAYBE_LINK_RE.lastIndex = i
      if (partial && MAYBE_LINK_RE.test(s)) {
        stop = i
        break
      }
      buf += ch
      i++
      continue
    }
    if (ch === 'h' && (s.startsWith('http://', i) || s.startsWith('https://', i)) && (i === 0 || ' (\t'.includes(s[i - 1]))) {
      let k = i
      while (k < n && !isSpace(s[k]) && s[k] !== ')') k++
      // URL solta: não aparece nem é falada (tira também o espaço/parêntese antes)
      while (buf && ' ('.includes(buf[buf.length - 1])) buf = buf.slice(0, -1)
      if (partial && k === n) {
        stop = i
        break
      }
      if (k < n && s[k] === ')') k++
      i = k
      continue
    }
    buf += ch
    i++
  }
  flush()
  let rest = ''
  if (partial) {
    // o que ficou de fora do plain (a tela mostra, sem os símbolos de formatação do fim)
    rest = stop >= 0 ? s.slice(stop) + src.slice(s.length) : src.slice(s.length)
    rest = rstripChars(rest, '*`')
  }
  return { runs, rest }
}

export function inlinePlain(s: string, partial = false): string {
  return parseInline(s, partial).runs.map((r) => r.text).join('')
}

function splitCells(s: string): string[] {
  let t = s.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|')) t = t.slice(0, -1)
  return t.split('|').map((c) => c.trim())
}

/** Classifica uma linha completa. */
export function parseLine(line: string): Line {
  const s = line.replace(/\s+$/, '')
  const t = s.replace(/^\s+/, '')
  const indent = s.length - t.length
  if (!t) return { type: 'blank' }
  let m = MEDIA_LINE_RE.exec(t)
  if (m) return { type: 'media', id: m[1] }
  m = HEADING_RE.exec(t)
  if (m) return { type: 'h', level: m[1].length, text: m[2].replace(/[#\s]+$/, '') || m[2] }
  m = BULLET_RE.exec(t)
  if (m) return { type: 'li', ordered: false, indent, text: m[1] }
  m = ORDERED_RE.exec(t)
  if (m) return { type: 'li', ordered: true, n: Number(m[1]), indent, text: m[2] }
  if (t.startsWith('|')) {
    if (TABLE_SEP_RE.test(t) && t.includes('-')) return { type: 'tsep' }
    return { type: 'tr', cells: splitCells(t) }
  }
  return { type: 'p', text: t }
}

function settled(line: string): boolean {
  const t = line.trim()
  if (!t || t.startsWith('|') || t.startsWith('[[')) return false
  return !UNSETTLED_RE.test(t)
}

// ---------------------------------------------------------------------------
// Documento para a tela (blocos com as posições no plain)
// ---------------------------------------------------------------------------

export type Block =
  | { type: 'p'; runs: Run[] }
  | { type: 'h'; level: number; runs: Run[] }
  | { type: 'list'; ordered: boolean; items: { marker?: Run; runs: Run[]; indent: number }[] }
  | { type: 'table'; header: Run[][] | null; rows: Run[][][] }
  | { type: 'media'; id: string }
  /** última linha ainda chegando, que ainda não diz o que é: mostrada como veio, sem fala */
  | { type: 'raw'; text: string }

export interface Doc {
  blocks: Block[]
  plain: string
}

/** Monta os blocos da tela e o plain. `partial`: a resposta ainda está chegando. */
export function buildDoc(md: string, partial = false): Doc {
  const lines = md.split('\n')
  const last = partial ? lines.pop()! : null
  const blocks: Block[] = []
  let plain = ''

  /** Junta um bloco falado ao plain e marca a posição de cada trecho. */
  const place = (pieces: Run[][], sep: string): void => {
    const nonEmpty = pieces.filter((rs) => rs.some((r) => r.text))
    if (!nonEmpty.length) return
    if (plain) plain += '\n'
    nonEmpty.forEach((rs, k) => {
      if (k > 0) plain += sep
      for (const r of rs) {
        r.o = plain.length
        plain += r.text
      }
    })
  }

  let tableRows: { cells: Run[][]; header: boolean }[] | null = null
  const flushTable = (): void => {
    if (!tableRows) return
    const header = tableRows[0]?.header ? tableRows[0].cells : null
    blocks.push({ type: 'table', header, rows: tableRows.slice(header ? 1 : 0).map((r) => r.cells) })
    tableRows = null
  }

  const addLine = (ln: Line, isPartial: boolean, rest: string): void => {
    if (ln.type !== 'tr' && ln.type !== 'tsep') flushTable()
    const tail = rest ? [{ text: rest, bold: false, italic: false, code: false } as Run] : []
    switch (ln.type) {
      case 'blank':
        return
      case 'media':
        blocks.push({ type: 'media', id: ln.id })
        return
      case 'tsep':
        if (tableRows?.length === 1) tableRows[0].header = true
        return
      case 'tr': {
        // tabela não é lida: no lugar dela a voz avisa que ela está no chat (o aviso não aparece na tela)
        const cells = ln.cells.map((c) => parseInline(c).runs)
        if (!tableRows) {
          place([[{ text: TABLE_SPOKEN, bold: false, italic: false, code: false }]], '')
          tableRows = []
        }
        tableRows.push({ cells, header: false })
        return
      }
      case 'h': {
        const { runs } = parseInline(ln.text, isPartial)
        place([runs], '')
        blocks.push({ type: 'h', level: ln.level, runs: [...runs, ...tail] })
        return
      }
      case 'li': {
        const { runs } = parseInline(ln.text, isPartial)
        const marker: Run | undefined = ln.ordered ? { text: `${ln.n}. `, bold: false, italic: false, code: false } : undefined
        place([marker ? [marker, ...runs] : runs], '')
        const item = { marker, runs: [...runs, ...tail], indent: ln.indent }
        const prev = blocks[blocks.length - 1]
        if (prev?.type === 'list' && prev.ordered === ln.ordered) prev.items.push(item)
        else blocks.push({ type: 'list', ordered: ln.ordered, items: [item] })
        return
      }
      case 'p': {
        const { runs } = parseInline(ln.text, isPartial)
        place([runs], '')
        blocks.push({ type: 'p', runs: [...runs, ...tail] })
      }
    }
  }

  for (const line of lines) addLine(parseLine(line), false, '')
  if (last !== null && last.trim()) {
    if (settled(last)) {
      const ln = parseLine(last)
      const rest = ln.type === 'p' || ln.type === 'h' || ln.type === 'li' ? parseInline(ln.text, true).rest : ''
      addLine(ln, true, rest)
    } else {
      flushTable()
      blocks.push({ type: 'raw', text: last.trim() })
    }
  }
  flushTable()
  return { blocks, plain }
}

/** Texto falado (o mesmo do backend). */
export function toPlain(md: string, partial = false): string {
  return buildDoc(md, partial).plain
}

/** Markdown sem as linhas de marcador de mídia (copiar). */
export function stripMedia(md: string): string {
  return md
    .split('\n')
    .filter((ln) => !MEDIA_LINE_RE.test(ln.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Ids dos grupos de mídia que aparecem no meio do texto. */
export function mediaIds(md: string): string[] {
  const out: string[] = []
  for (const ln of md.split('\n')) {
    const m = MEDIA_LINE_RE.exec(ln.trim())
    if (m) out.push(m[1])
  }
  return out
}
