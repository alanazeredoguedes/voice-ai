/**
 * ESC fecha o modal aberto. Escuta a janela inteira (funciona sem precisar de foco dentro do modal) e, com um modal
 * por cima de outro, fecha só o de cima (o último aberto). O ESC usado pelo modal não chega a mais ninguém (ex.: não
 * fecha também a conversa com um amigo que está atrás).
 */
import { onUnmounted, watch } from 'vue'
import { syslog } from '../utils/syslog'

interface Entry {
  name: string
  close: () => void
}

/** modais abertos, do mais antigo para o mais novo (o de cima é o último) */
const stack: Entry[] = []

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || !stack.length) return
  const top = stack[stack.length - 1]
  e.preventDefault()
  e.stopImmediatePropagation()
  syslog('info', 'interface', `ESC fechou o modal "${top.name}"`)
  top.close()
}

let listening = false
function ensureListener(): void {
  if (listening) return
  listening = true
  // fase de captura: o modal responde antes de qualquer outro atalho de ESC da tela
  window.addEventListener('keydown', onKeydown, true)
}

/**
 * Enquanto `isOpen()` for verdadeiro, ESC chama `close`. `name` aparece no log do sistema.
 */
export function useEscClose(isOpen: () => boolean, close: () => void, name: string): void {
  ensureListener()
  const entry: Entry = { name, close }
  const remove = (): void => {
    const i = stack.indexOf(entry)
    if (i >= 0) stack.splice(i, 1)
  }
  watch(
    isOpen,
    (open) => {
      remove()
      if (open) stack.push(entry)
    },
    { immediate: true }
  )
  onUnmounted(remove)
}
