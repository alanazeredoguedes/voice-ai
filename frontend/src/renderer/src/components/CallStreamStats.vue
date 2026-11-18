<script setup lang="ts">
import { computed } from 'vue'
import { SELF, useCallStore } from '../stores/call'

/**
 * Estatísticas da transmissão aberta, por cima da imagem (como o "Stats for nerds"): como a imagem está
 * chegando, o que quem transmite está enviando, gráficos dos últimos 60 s e o que está limitando agora.
 * Na prévia da minha própria tela: o que estou enviando para cada pessoa que assiste.
 */
const props = defineProps<{ peerId: string }>()
const store = useCallStore()

const isSelf = computed(() => props.peerId === SELF)
const recv = computed(() => (isSelf.value ? null : store.netStats[props.peerId]))
const video = computed(() => recv.value?.video ?? null)
const send = computed(() => (isSelf.value ? null : store.senderStats[props.peerId]))
const diagnosis = computed(() => store.diagnoseStream(props.peerId))
const peerName = computed(() => store.peers.find((p) => p.id === props.peerId)?.name ?? 'quem transmite')

/** o que eu estou enviando, por pessoa que assiste (prévia da minha tela) */
const mySends = computed(() =>
  Object.entries(store.netStats)
    .filter(([, n]) => n.sending)
    .map(([id, n]) => ({ id, name: store.peers.find((p) => p.id === id)?.name ?? 'participante', ...n.sending!, rtt: n.rtt }))
)

const LIMIT_LABEL: Record<string, string> = {
  none: 'nada',
  bandwidth: 'internet de envio',
  cpu: 'processador',
  other: 'outro motivo'
}
const limitLabel = (l: string): string => LIMIT_LABEL[l] ?? l

const mbps = (kbps: number): string => `${(kbps / 1000).toFixed(1).replace('.', ',')} Mbps`

/** linha do gráfico (SVG 120x28) para uma série; teto mínimo para não exagerar variações pequenas */
function sparkline(values: number[], floor: number): string {
  if (values.length < 2) return ''
  const max = Math.max(floor, ...values)
  const step = 120 / 59
  const start = 60 - values.length
  return values.map((v, i) => `${((start + i) * step).toFixed(1)},${(27 - (v / max) * 25).toFixed(1)}`).join(' ')
}
const fpsLine = computed(() => sparkline(store.viewHistory.fps, 30))
const kbpsLine = computed(() => sparkline(store.viewHistory.kbps, 2000))
const DIAG_COLOR = { ok: 'text-emerald-300', warn: 'text-amber-300', bad: 'text-red-300' }
</script>

<template>
  <div
    class="w-72 rounded-xl bg-black/75 backdrop-blur border border-white/10 p-3 flex flex-col gap-2 text-[11px] text-slate-200 font-mono cursor-default"
    @mousedown.stop
    @dblclick.stop
    @wheel.stop
    @click.stop
    @contextmenu.stop
  >
    <!-- prévia da minha tela: o que sai para cada pessoa -->
    <template v-if="isSelf">
      <p class="font-sans text-xs font-medium text-white">Sua transmissão</p>
      <p class="text-slate-400">Escolhida: {{ store.shareQuality || '?' }}</p>
      <p v-if="!mySends.length" class="font-sans text-slate-400">Ninguém está assistindo agora (nada está sendo enviado).</p>
      <div v-for="s in mySends" :key="s.id" class="flex flex-col gap-0.5 pt-1.5 border-t border-white/10">
        <p class="font-sans text-slate-300">Para {{ s.name }}</p>
        <p>{{ s.width }}×{{ s.height }} · {{ s.fps }} fps · {{ mbps(s.kbps) }}</p>
        <p>
          limitado por: <span :class="s.limit === 'none' ? 'text-emerald-300' : 'text-amber-300'">{{ limitLabel(s.limit) }}</span>
          <template v-if="s.availKbps"> · banda ~{{ mbps(s.availKbps) }}</template>
        </p>
      </div>
      <p v-if="mySends.length > 1" class="font-sans text-slate-500">Cada pessoa recebe uma cópia: o envio total é a soma.</p>
    </template>

    <template v-else>
      <p class="font-sans text-xs font-medium text-white">Transmissão de {{ peerName }}</p>

      <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <span class="text-slate-400">Chegando</span>
        <span>
          <template v-if="video">{{ video.width }}×{{ video.height }} · {{ video.fps }} fps · {{ mbps(video.kbps) }}</template>
          <template v-else>—</template>
        </span>
        <span class="text-slate-400">Enviando</span>
        <span>
          <template v-if="send">{{ send.width }}×{{ send.height }} · {{ send.fps }} fps · {{ mbps(send.kbps) }}</template>
          <template v-else>—</template>
        </span>
        <span class="text-slate-400">Escolhida</span>
        <span>{{ store.peers.find((p) => p.id === peerId)?.quality || '—' }}</span>
        <span class="text-slate-400">Latência</span>
        <span>{{ recv?.rtt ?? '?' }} ms<template v-if="video"> · atraso da imagem ~{{ video.delay }} ms</template></span>
        <span class="text-slate-400">Perda</span>
        <span :class="(video?.loss ?? 0) >= 1 ? 'text-amber-300' : ''">{{ video?.loss ?? 0 }}%</span>
        <template v-if="send">
          <span class="text-slate-400">Limitado por</span>
          <span :class="send.limit === 'none' ? 'text-emerald-300' : 'text-amber-300'">
            {{ limitLabel(send.limit) }}<template v-if="send.viewers > 1"> · {{ send.viewers }} assistindo</template>
          </span>
          <template v-if="send.availKbps">
            <span class="text-slate-400">Banda envio</span>
            <span>~{{ mbps(send.availKbps) }}</span>
          </template>
        </template>
      </div>

      <!-- últimos 60 s -->
      <div class="grid grid-cols-2 gap-2 pt-1">
        <div class="flex flex-col gap-0.5">
          <span class="text-slate-400">fps (60 s)</span>
          <svg viewBox="0 0 120 28" class="w-full h-7 bg-white/5 rounded">
            <polyline v-if="fpsLine" :points="fpsLine" fill="none" stroke="#818cf8" stroke-width="1.5" stroke-linejoin="round" />
          </svg>
        </div>
        <div class="flex flex-col gap-0.5">
          <span class="text-slate-400">taxa (60 s)</span>
          <svg viewBox="0 0 120 28" class="w-full h-7 bg-white/5 rounded">
            <polyline v-if="kbpsLine" :points="kbpsLine" fill="none" stroke="#34d399" stroke-width="1.5" stroke-linejoin="round" />
          </svg>
        </div>
      </div>

      <p :class="['font-sans leading-snug pt-1 border-t border-white/10', DIAG_COLOR[diagnosis.level]]">{{ diagnosis.text }}</p>
      <p v-if="!send && store.viewHistory.fps.length > 5" class="font-sans text-slate-500">Quem transmite está numa versão antiga: o motivo da limitação do lado dela não aparece.</p>
    </template>
  </div>
</template>
