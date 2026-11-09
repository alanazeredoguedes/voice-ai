<script setup lang="ts">
import { imageToast, showInFolder } from '../utils/imageActions'

/** Aviso das ações nas imagens (copiada, salva em Downloads...), por cima de tudo, inclusive do visualizador. */
</script>

<template>
  <Teleport to="body">
    <Transition name="toast">
      <div
        v-if="imageToast"
        :class="[
          'fixed bottom-6 left-1/2 -translate-x-1/2 z-[120] flex items-center gap-3 rounded-xl border px-3.5 py-2 text-xs shadow-xl shadow-black/40',
          imageToast.error ? 'border-red-700/60 bg-red-950/95 text-red-200' : 'border-slate-600 bg-slate-900/95 text-slate-100'
        ]"
      >
        {{ imageToast.text }}
        <button
          v-if="imageToast.path"
          class="text-indigo-300 hover:text-indigo-200 font-medium"
          @click="showInFolder(imageToast.path)"
        >Mostrar na pasta</button>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.15s, transform 0.15s;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translate(-50%, 6px);
}
</style>
