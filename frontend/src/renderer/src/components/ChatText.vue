<script setup lang="ts">
import { computed } from 'vue'
import { parseChatText } from '../utils/chatText'

/** Texto de uma mensagem do chat da chamada: links clicáveis e formatação simples. Preserva as quebras de linha. */
const props = defineProps<{ text: string }>()
const runs = computed(() => parseChatText(props.text))

function openLink(url: string): void {
  // o processo principal abre no navegador padrão (setWindowOpenHandler)
  window.open(url, '_blank')
}
</script>

<template>
  <p class="chat-text whitespace-pre-wrap break-words">
    <template v-for="(r, i) in runs" :key="i">
      <a
        v-if="r.href"
        :href="r.href"
        class="text-indigo-400 underline underline-offset-2 decoration-indigo-400/40 hover:text-indigo-300 hover:decoration-indigo-300 cursor-pointer break-all"
        :title="`Abrir no navegador: ${r.href}`"
        rel="noopener noreferrer"
        @click.prevent="openLink(r.href)"
      >{{ r.text }}</a>
      <code v-else-if="r.code" class="chat-code">{{ r.text }}</code>
      <strong v-else-if="r.bold" class="font-semibold text-slate-50">{{ r.text }}</strong>
      <em v-else-if="r.italic">{{ r.text }}</em>
      <template v-else>{{ r.text }}</template>
    </template>
  </p>
</template>

<style scoped>
.chat-code {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.9em;
  padding: 0.1em 0.35em;
  border-radius: 0.35em;
  background: rgb(30 41 59);
  border: 1px solid rgb(51 65 85 / 0.6);
}
</style>
