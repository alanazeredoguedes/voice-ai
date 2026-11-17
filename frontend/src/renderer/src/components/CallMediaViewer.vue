<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'

/** Imagem ou vídeo do chat da chamada em tamanho grande. */
defineProps<{ url: string; name: string; video: boolean }>()
const emit = defineEmits<{ close: []; download: [] }>()

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-[70] bg-black/85 backdrop-blur-sm flex flex-col" @click.self="emit('close')">
      <div class="flex items-center gap-2 px-4 py-3 flex-shrink-0">
        <p class="flex-1 text-sm text-slate-200 truncate">{{ name }}</p>
        <button class="p-2 rounded-lg text-slate-300 hover:text-white hover:bg-white/10 transition-colors" title="Baixar" @click="emit('download')">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
          </svg>
        </button>
        <button class="p-2 rounded-lg text-slate-300 hover:text-white hover:bg-white/10 transition-colors" title="Fechar (Esc)" @click="emit('close')">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div class="flex-1 min-h-0 flex items-center justify-center p-6 pt-0" @click.self="emit('close')">
        <video v-if="video" :src="url" controls autoplay class="max-w-full max-h-full rounded-lg" />
        <img v-else :src="url" :alt="name" class="max-w-full max-h-full object-contain rounded-lg" />
      </div>
    </div>
  </Teleport>
</template>
