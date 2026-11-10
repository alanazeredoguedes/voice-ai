/**
 * Ponte entre o texto falado (plain) e a tela de uma resposta do chat.
 * Cada trecho de texto desenhado é um <span data-o="posição no plain"> com um único nó de texto
 * (ver RichMessage.vue). Os símbolos de formatação, as vírgulas entre células de tabela e as quebras
 * entre blocos existem só no plain: caem "entre" spans e são pulados.
 */

interface Span {
  node: Text
  o: number
  len: number
}

function spans(root: HTMLElement): Span[] {
  const out: Span[] = []
  root.querySelectorAll<HTMLElement>('[data-o]').forEach((el) => {
    const node = el.firstChild
    if (node && node.nodeType === Node.TEXT_NODE) {
      out.push({ node: node as Text, o: Number(el.dataset.o), len: (node as Text).length })
    }
  })
  return out
}

/** Trecho [start, end) do plain → StaticRange na tela (pode atravessar vários spans). */
export function rangeFor(root: HTMLElement | undefined | null, start: number, end: number): StaticRange | null {
  if (!root || end <= start) return null
  const list = spans(root)
  let a: Span | undefined
  let aOff = 0
  for (const s of list) {
    if (s.o + s.len > start) {
      a = s
      aOff = Math.max(0, start - s.o)
      break
    }
  }
  let b: Span | undefined
  let bOff = 0
  for (let k = list.length - 1; k >= 0; k--) {
    const s = list[k]
    if (s.o < end) {
      b = s
      bOff = Math.min(s.len, end - s.o)
      break
    }
  }
  if (!a || !b) return null
  if (a.node === b.node ? aOff >= bOff : a.o > b.o) return null
  return new StaticRange({ startContainer: a.node, startOffset: aOff, endContainer: b.node, endOffset: bOff })
}

/**
 * Ponto da tela (de uma seleção) → posição no plain.
 * `isEnd`: fim da seleção (se cair fora de um trecho falado, vai para o fim do trecho anterior;
 * o começo vai para o início do trecho seguinte).
 */
export function plainOffset(root: HTMLElement, node: Node, offset: number, isEnd: boolean): number | null {
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : null
  if (el?.dataset.o !== undefined && el.firstChild === node) return Number(el.dataset.o) + offset
  const list = spans(root)
  if (!list.length) return null
  const point = document.createRange()
  point.setStart(node, offset)
  if (isEnd) {
    for (let k = list.length - 1; k >= 0; k--) {
      const s = list[k]
      // fim do trecho antes (ou no) ponto
      if (point.comparePoint(s.node, s.len) <= 0) return s.o + s.len
    }
    return list[0].o
  }
  for (const s of list) {
    if (point.comparePoint(s.node, 0) >= 0) return s.o
  }
  const last = list[list.length - 1]
  return last.o + last.len
}
