<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from 'vue'

/**
 * Tooltip do app, montado uma vez no App.vue. Substitui o balão nativo do navegador
 * (o atributo `title`) em todo o app: ao passar o mouse, o `title` vira `data-tip`
 * (assim o navegador não mostra o dele) e este balão aparece no lugar, com o visual do sistema.
 * Também aceita `data-tip` direto. Quebras de linha (\n) no texto são respeitadas.
 */
const DELAY_MS = 350

const text = ref('')
const visible = ref(false)
const pos = ref({ x: 0, y: 0, below: false, arrowX: 0 })
const tipEl = ref<HTMLElement | null>(null)

let target: HTMLElement | null = null
let timer: ReturnType<typeof setTimeout> | null = null

function tipText(el: HTMLElement): string {
  const t = el.getAttribute('title')
  if (t !== null) {
    // tira o title (o navegador mostraria o balão dele); o Vue pode recolocar num re-render,
    // e aí ele é convertido de novo no próximo hover
    if (t.trim()) el.setAttribute('data-tip', t)
    el.removeAttribute('title')
  }
  return (el.getAttribute('data-tip') ?? '').trim()
}

function findTarget(node: EventTarget | null): HTMLElement | null {
  let el = node instanceof Element ? node : null
  while (el && el !== document.body) {
    if (el instanceof HTMLElement || el instanceof SVGElement) {
      if (el.hasAttribute('title') || el.hasAttribute('data-tip')) return el as HTMLElement
    }
    el = el.parentElement
  }
  return null
}

async function place(): Promise<void> {
  if (!target) return
  await nextTick()
  const r = target.getBoundingClientRect()
  const tip = tipEl.value
  if (!tip) return
  const w = tip.offsetWidth
  const h = tip.offsetHeight
  const margin = 8
  const cx = r.left + r.width / 2
  let x = Math.round(cx - w / 2)
  x = Math.max(margin, Math.min(window.innerWidth - w - margin, x))
  // em cima por padrão; embaixo se não couber
  const below = r.top - h - 10 < margin
  const y = below ? r.bottom + 8 : r.top - h - 8
  pos.value = { x, y: Math.round(y), below, arrowX: Math.round(Math.max(10, Math.min(w - 10, cx - x))) }
}

function show(el: HTMLElement): void {
  const t = tipText(el)
  if (!t) return
  target = el
  text.value = t
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    if (target !== el || !el.isConnected) return
    text.value = tipText(el) || t // pega o texto atual (ex.: "Parar de falar" ↔ "Ouvir de novo")
    visible.value = true
    void place()
  }, DELAY_MS)
}

function hide(): void {
  if (timer) clearTimeout(timer)
  timer = null
  visible.value = false
  target = null
}

function onOver(e: MouseEvent): void {
  const el = findTarget(e.target)
  if (el === target) return
  hide()
  if (el) show(el)
}

function onOut(e: MouseEvent): void {
  if (!target) return
  const to = e.relatedTarget as Node | null
  if (to && target.contains(to)) return
  hide()
}

onMounted(() => {
  document.addEventListener('mouseover', onOver, true)
  document.addEventListener('mouseout', onOut, true)
  document.addEventListener('mousedown', hide, true)
  document.addEventListener('keydown', hide, true)
  window.addEventListener('scroll', hide, true)
  window.addEventListener('blur', hide)
})
onUnmounted(() => {
  document.removeEventListener('mouseover', onOver, true)
  document.removeEventListener('mouseout', onOut, true)
  document.removeEventListener('mousedown', hide, true)
  document.removeEventListener('keydown', hide, true)
  window.removeEventListener('scroll', hide, true)
  window.removeEventListener('blur', hide)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="tip">
      <div
        v-if="visible"
        ref="tipEl"
        role="tooltip"
        class="app-tooltip fixed z-[100] pointer-events-none max-w-xs rounded-lg border border-slate-600/70 bg-slate-800/95 backdrop-blur px-2.5 py-1.5 text-xs leading-snug text-slate-100 shadow-xl shadow-black/40 whitespace-pre-line"
        :style="{ left: `${pos.x}px`, top: `${pos.y}px` }"
      >
        {{ text }}
        <span
          class="absolute w-2 h-2 rotate-45 bg-slate-800 border-slate-600/70"
          :class="pos.below ? '-top-[5px] border-l border-t' : '-bottom-[5px] border-r border-b'"
          :style="{ left: `${pos.arrowX - 4}px` }"
        />
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.tip-enter-active {
  transition: opacity 0.12s ease, transform 0.12s ease;
}
.tip-leave-active {
  transition: opacity 0.08s ease;
}
.tip-enter-from {
  opacity: 0;
  transform: translateY(2px);
}
.tip-leave-to {
  opacity: 0;
}
</style>
