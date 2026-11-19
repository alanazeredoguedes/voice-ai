<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { getHotkeyStatus, grantHotkeyAccess, type HotkeyStatus } from '../api'

/**
 * Linux com Wayland: o sistema não entrega a outros programas as teclas e cliques feitos fora deles, então os
 * atalhos só funcionariam com o Voice AI em foco. Aqui a pessoa libera (uma vez, com a senha) a leitura direta
 * do teclado e do mouse. Fora do Wayland, não aparece nada.
 */
defineProps<{ compact?: boolean }>()

const status = ref<HotkeyStatus | null>(null)
const busy = ref(false)
const result = ref<{ ok: boolean; message: string } | null>(null)

onMounted(async () => {
  try {
    status.value = await getHotkeyStatus()
  } catch {
    status.value = null
  }
})

async function grant(): Promise<void> {
  busy.value = true
  result.value = null
  try {
    const r = await grantHotkeyAccess()
    status.value = r
    result.value = { ok: r.ok, message: r.message }
  } catch (e) {
    result.value = { ok: false, message: e instanceof Error ? e.message : String(e) }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="status?.wayland && status.needs_permission" class="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 flex flex-wrap items-center gap-3">
    <div class="flex-1 min-w-60">
      <p class="text-sm font-medium text-amber-200">Os atalhos precisam de uma permissão no Wayland</p>
      <p v-if="!compact" class="text-xs text-amber-100/70 mt-1 leading-relaxed">
        Neste Linux (Wayland), o sistema não deixa um programa ver as teclas e cliques feitos em outros programas:
        sem a permissão, os atalhos só funcionam com o Voice AI na frente. Liberando, o Voice AI passa a ler o teclado
        e o mouse direto e os atalhos funcionam em qualquer lugar. O sistema pede a sua senha uma vez; vale para
        quem estiver usando o computador e continua valendo depois de reiniciar.
      </p>
      <p v-else class="text-xs text-amber-100/70 mt-1">Sem ela, os atalhos só funcionam com o Voice AI na frente.</p>
      <p v-if="result && !result.ok" class="text-xs text-red-300 mt-1.5">Não deu certo: {{ result.message }}</p>
    </div>
    <button
      :disabled="busy"
      class="px-3.5 py-2 rounded-lg text-sm font-medium bg-amber-500 hover:bg-amber-400 text-slate-950 transition-colors disabled:opacity-60"
      @click="grant"
    >{{ busy ? 'Esperando a senha…' : 'Liberar atalhos' }}</button>
  </div>
  <p v-else-if="status?.wayland && status.method === 'evdev' && !compact" class="text-xs text-emerald-300/80">
    <template v-if="result?.ok">Pronto! </template>Wayland: atalhos globais ligados pela leitura direta do teclado e do mouse.
  </p>
</template>
