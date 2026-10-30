<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{ text: string; size?: 'sm' | 'md' }>()

const copied = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null

async function copy(): Promise<void> {
  await navigator.clipboard.writeText(props.text)
  copied.value = true
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => { copied.value = false }, 1500)
}
</script>

<template>
  <button
    :title="copied ? 'Copiado!' : 'Copiar'"
    :class="[
      'transition-colors rounded flex-shrink-0',
      size === 'sm' ? 'p-1' : 'p-1.5',
      copied ? 'text-emerald-400' : 'text-slate-500 hover:text-slate-300'
    ]"
    @click.stop="copy"
  >
    <!-- check icon when copied -->
    <svg v-if="copied" :class="size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4'" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />
    </svg>
    <!-- clipboard icon -->
    <svg v-else :class="size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4'" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
    </svg>
  </button>
</template>
