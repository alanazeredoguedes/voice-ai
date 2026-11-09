<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import type { MediaItem } from '../types'
import { copyImage, copyLink, openSource, saveImage } from '../utils/imageActions'

/** Menu do botão direito numa imagem: copiar, baixar, copiar link, abrir fonte. */
const props = defineProps<{ item: MediaItem; x: number; y: number }>()
const emit = defineEmits<{ close: [] }>()
const el = ref<HTMLElement | null>(null)
const pos = ref({ x: props.x, y: props.y })

onMounted(() => {
  // não deixa o menu sair da tela
  const r = el.value?.getBoundingClientRect()
  if (r) {
    pos.value = {
      x: Math.min(props.x, window.innerWidth - r.width - 8),
      y: Math.min(props.y, window.innerHeight - r.height - 8)
    }
  }
  setTimeout(() => {
    document.addEventListener('mousedown', onOutside, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', close)
  })
})
onUnmounted(() => {
  document.removeEventListener('mousedown', onOutside, true)
  window.removeEventListener('keydown', onKey, true)
  window.removeEventListener('blur', close)
})

function close(): void {
  emit('close')
}
function onOutside(e: MouseEvent): void {
  if (!el.value?.contains(e.target as Node)) close()
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopPropagation()
    close()
  }
}
function run(fn: (i: MediaItem) => unknown): void {
  close()
  void fn(props.item)
}
</script>

<template>
  <Teleport to="body">
    <div
      ref="el"
      class="fixed z-[110] min-w-[190px] rounded-xl border border-slate-700 bg-slate-900/95 backdrop-blur p-1 shadow-2xl shadow-black/50"
      :style="{ left: `${pos.x}px`, top: `${pos.y}px` }"
      @contextmenu.prevent
    >
      <button class="menu-item" @click="run(copyImage)">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 011.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 00-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 01-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 00-3.375-3.375h-1.5a1.125 1.125 0 01-1.125-1.125v-1.5a3.375 3.375 0 00-3.375-3.375H9.75" /></svg>
        Copiar imagem
      </button>
      <button class="menu-item" @click="run(saveImage)">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>
        Baixar imagem
      </button>
      <button class="menu-item" @click="run(copyLink)">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" /></svg>
        Copiar link da imagem
      </button>
      <div class="h-px bg-slate-700/70 my-1" />
      <button class="menu-item" @click="run(openSource)">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" /></svg>
        Abrir a página de origem
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.menu-item {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 0.6rem;
  padding: 0.45rem 0.7rem;
  border-radius: 0.5rem;
  font-size: 0.8rem;
  color: #e2e8f0;
  text-align: left;
}
.menu-item:hover {
  background: rgba(79, 70, 229, 0.18);
  color: #fff;
}
.menu-item svg {
  color: #a5b4fc;
  flex-shrink: 0;
}
</style>
