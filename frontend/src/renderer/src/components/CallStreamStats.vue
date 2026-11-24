<script setup lang="ts">
import { computed } from 'vue'
import { SELF, useCallStore } from '../stores/call'

/**
 * Estatísticas da transmissão aberta, por cima da imagem: diagnóstico em destaque, números grandes por etapa
 * (captura → envio → chegada), rede e gráficos dos últimos 60 s. Na prévia da minha tela: o que sai para cada
 * pessoa que assiste.
 */
const props = defineProps<{ peerId: string }>()
const store = useCallStore()

const isSelf = computed(() => props.peerId === SELF)
const recv = computed(() => (isSelf.value ? null : store.netStats[props.peerId]))
const video = computed(() => recv.value?.video ?? null)
const send = computed(() => (isSelf.value ? null : store.senderStats[props.peerId]))
const diagnosis = computed(() => store.diagnoseStream(props.peerId))
const peer = computed(() => store.peers.find((p) => p.id === props.peerId))
const chosen = computed(() => peer.value?.quality || '—')
const chosenFps = computed(() => Number(chosen.value.match(/(\d+)\s*fps/)?.[1] ?? 0))

const mySends = computed(() =>
  Object.entries(store.netStats)
    .filter(([, n]) => n.sending)
    .map(([id, n]) => ({ id, name: store.peers.find((p) => p.id === id)?.name ?? 'participante', ...n.sending!, rtt: n.rtt }))
)

const LIMIT_LABEL: Record<string, string> = { none: 'nada', bandwidth: 'internet de envio', cpu: 'processador', other: 'outro motivo' }
const limitLabel = (l: string): string => LIMIT_LABEL[l] ?? l
const mbps = (kbps: number): string => (kbps / 1000).toFixed(1).replace('.', ',')
const resLabel = (w?: number, h?: number): string => (w && h ? `${w}×${h}` : '—')

/** cor do número de fps: verde perto do escolhido, âmbar no meio, vermelho muito abaixo */
function fpsTone(fps: number | undefined): string {
  if (!fps || !chosenFps.value) return 'text-slate-100'
  const r = fps / chosenFps.value
  return r >= 0.8 ? 'text-emerald-300' : r >= 0.5 ? 'text-amber-300' : 'text-red-300'
}

/** gráfico (SVG 240x64) de uma série; teto mínimo para não exagerar variações pequenas */
function sparkline(values: number[], floor: number): { line: string; area: string; max: number } {
  const max = Math.max(floor, ...values)
  if (values.length < 2) return { line: '', area: '', max }
  const step = 240 / 59
  const start = 60 - values.length
  const pts = values.map((v, i) => [(start + i) * step, 62 - (v / max) * 58] as const)
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = `${pts[0][0].toFixed(1)},64 ${line} ${pts[pts.length - 1][0].toFixed(1)},64`
  return { line, area, max }
}
const fpsChart = computed(() => sparkline(store.viewHistory.fps, Math.max(30, chosenFps.value)))
const kbpsChart = computed(() => sparkline(store.viewHistory.kbps, 2000))
const lastFps = computed(() => store.viewHistory.fps[store.viewHistory.fps.length - 1] ?? 0)
const lastKbps = computed(() => store.viewHistory.kbps[store.viewHistory.kbps.length - 1] ?? 0)

const DIAG = {
  ok: { box: 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200', dot: 'bg-emerald-400', label: 'Tudo certo' },
  warn: { box: 'bg-amber-500/15 border-amber-500/40 text-amber-100', dot: 'bg-amber-400', label: 'Atenção' },
  bad: { box: 'bg-red-500/15 border-red-500/40 text-red-100', dot: 'bg-red-400', label: 'Problema' }
}
</script>

<template>
  <div
    class="w-[24rem] max-h-[calc(100%-1rem)] overflow-y-auto rounded-2xl bg-slate-900/95 backdrop-blur border border-slate-700 shadow-2xl p-4 flex flex-col gap-3 text-slate-200 cursor-default"
    @mousedown.stop
    @dblclick.stop
    @wheel.stop
    @click.stop
    @contextmenu.stop
  >
    <!-- ===== prévia da minha tela: o que sai para cada pessoa ===== -->
    <template v-if="isSelf">
      <div class="flex items-center justify-between gap-2">
        <p class="text-base font-semibold text-white">Sua transmissão</p>
        <span class="px-2 py-0.5 rounded-md bg-slate-800 text-xs text-slate-300">{{ store.shareQuality || '—' }}</span>
      </div>
      <p v-if="!mySends.length" class="text-sm text-slate-400">Ninguém está assistindo agora, então nada está sendo enviado.</p>
      <div v-for="s in mySends" :key="s.id" class="rounded-xl bg-slate-800/70 border border-slate-700/60 p-3 flex flex-col gap-2">
        <div class="flex items-center justify-between">
          <p class="text-sm font-medium text-slate-100">Para {{ s.name }}</p>
          <span :class="['text-xs px-2 py-0.5 rounded-md', s.limit === 'none' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300']">
            limitado por: {{ limitLabel(s.limit) }}
          </span>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div class="rounded-lg bg-slate-900/70 px-3 py-2">
            <p class="text-[11px] uppercase tracking-wide text-slate-400">Captura</p>
            <p :class="['text-xl font-semibold tabular-nums', fpsTone(s.captureFps)]">{{ s.captureFps }} <span class="text-sm font-normal text-slate-400">fps</span></p>
            <p class="text-xs text-slate-400 tabular-nums">{{ resLabel(s.captureWidth, s.captureHeight) }}</p>
          </div>
          <div class="rounded-lg bg-slate-900/70 px-3 py-2">
            <p class="text-[11px] uppercase tracking-wide text-slate-400">Enviando</p>
            <p :class="['text-xl font-semibold tabular-nums', fpsTone(s.fps)]">{{ s.fps }} <span class="text-sm font-normal text-slate-400">fps</span></p>
            <p class="text-xs text-slate-400 tabular-nums">{{ resLabel(s.width, s.height) }} · {{ mbps(s.kbps) }} Mbps</p>
          </div>
        </div>
        <p class="text-xs text-slate-400">
          Banda estimada <span class="text-slate-200 tabular-nums">{{ s.availKbps ? `${mbps(s.availKbps)} Mbps` : '—' }}</span>
          · compressor <span class="text-slate-200">{{ s.encoder }}</span>
        </p>
      </div>
      <p v-if="mySends.length > 1" class="text-xs text-slate-500">Cada pessoa recebe uma cópia: o envio total é a soma.</p>
    </template>

    <!-- ===== transmissão de outra pessoa ===== -->
    <template v-else>
      <div class="flex items-center justify-between gap-2">
        <p class="text-base font-semibold text-white truncate">Transmissão de {{ peer?.name ?? 'participante' }}</p>
        <span class="px-2 py-0.5 rounded-md bg-slate-800 text-xs text-slate-300 flex-shrink-0">escolhida {{ chosen }}</span>
      </div>

      <!-- diagnóstico em destaque -->
      <div :class="['rounded-xl border px-3 py-2.5 flex gap-2.5 items-start', DIAG[diagnosis.level].box]">
        <span :class="['mt-1.5 w-2 h-2 rounded-full flex-shrink-0', DIAG[diagnosis.level].dot]" />
        <div class="min-w-0">
          <p class="text-xs font-semibold uppercase tracking-wide opacity-80">{{ DIAG[diagnosis.level].label }}</p>
          <p class="text-sm leading-snug">{{ diagnosis.text }}</p>
        </div>
      </div>

      <!-- etapas: captura → envio → chegada -->
      <div class="grid grid-cols-3 gap-2">
        <div class="rounded-xl bg-slate-800/70 border border-slate-700/60 px-3 py-2">
          <p class="text-[11px] uppercase tracking-wide text-slate-400">Captura</p>
          <p :class="['text-2xl font-semibold tabular-nums leading-tight', send?.still ? 'text-slate-300' : fpsTone(send?.captureFps)]">{{ send?.captureFps ?? '—' }}</p>
          <p class="text-xs text-slate-400 tabular-nums">fps · {{ resLabel(send?.captureWidth, send?.captureHeight) }}</p>
          <p v-if="send?.still" class="text-[11px] text-emerald-300" title="Nada mudou na tela de quem transmite: poucos quadros por segundo é normal">tela parada</p>
        </div>
        <div class="rounded-xl bg-slate-800/70 border border-slate-700/60 px-3 py-2">
          <p class="text-[11px] uppercase tracking-wide text-slate-400">Enviando</p>
          <p :class="['text-2xl font-semibold tabular-nums leading-tight', fpsTone(send?.fps)]">{{ send?.fps ?? '—' }}</p>
          <p class="text-xs text-slate-400 tabular-nums">fps · {{ resLabel(send?.width, send?.height) }}</p>
        </div>
        <div class="rounded-xl bg-slate-800/70 border border-slate-700/60 px-3 py-2">
          <p class="text-[11px] uppercase tracking-wide text-slate-400">Chegando</p>
          <p :class="['text-2xl font-semibold tabular-nums leading-tight', fpsTone(video?.fps)]">{{ video?.fps ?? '—' }}</p>
          <p class="text-xs text-slate-400 tabular-nums">fps · {{ resLabel(video?.width, video?.height) }}</p>
        </div>
      </div>

      <!-- rede -->
      <div class="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-xl bg-slate-800/40 border border-slate-700/40 px-3 py-2.5 text-sm">
        <span class="text-slate-400">Taxa</span>
        <span class="text-right tabular-nums text-slate-100">{{ video ? `${mbps(video.kbps)} Mbps` : '—' }}</span>
        <span class="text-slate-400">Banda de envio</span>
        <span class="text-right tabular-nums text-slate-100">{{ send?.availKbps ? `${mbps(send.availKbps)} Mbps` : '—' }}</span>
        <span class="text-slate-400">Latência</span>
        <span class="text-right tabular-nums text-slate-100">{{ recv?.rtt ?? '—' }} ms</span>
        <span class="text-slate-400">Atraso da imagem</span>
        <span class="text-right tabular-nums text-slate-100">{{ video ? `~${video.delay} ms` : '—' }}</span>
        <span class="text-slate-400">Perda de pacotes</span>
        <span :class="['text-right tabular-nums', (video?.loss ?? 0) >= 1 ? 'text-amber-300' : 'text-slate-100']">{{ video?.loss ?? 0 }}%</span>
        <span class="text-slate-400">Limitado por</span>
        <span :class="['text-right', !send || send.limit === 'none' ? 'text-emerald-300' : 'text-amber-300']">
          {{ send ? limitLabel(send.limit) : '—' }}<template v-if="send && send.viewers > 1"> · {{ send.viewers }} assistindo</template>
        </span>
      </div>

      <!-- últimos 60 s -->
      <div class="grid grid-cols-2 gap-2">
        <div class="rounded-xl bg-slate-800/40 border border-slate-700/40 p-2.5">
          <div class="flex items-baseline justify-between">
            <span class="text-xs text-slate-400">fps · 60 s</span>
            <span class="text-sm font-semibold tabular-nums text-indigo-300">{{ lastFps }}</span>
          </div>
          <svg viewBox="0 0 240 64" class="w-full h-16 mt-1" preserveAspectRatio="none">
            <line x1="0" x2="240" y1="33" y2="33" stroke="#334155" stroke-dasharray="3 4" stroke-width="1" />
            <polygon v-if="fpsChart.area" :points="fpsChart.area" fill="#818cf8" fill-opacity="0.15" />
            <polyline v-if="fpsChart.line" :points="fpsChart.line" fill="none" stroke="#818cf8" stroke-width="2" stroke-linejoin="round" />
          </svg>
          <p class="text-[10px] text-slate-500 tabular-nums">máx. {{ fpsChart.max }} fps</p>
        </div>
        <div class="rounded-xl bg-slate-800/40 border border-slate-700/40 p-2.5">
          <div class="flex items-baseline justify-between">
            <span class="text-xs text-slate-400">taxa · 60 s</span>
            <span class="text-sm font-semibold tabular-nums text-emerald-300">{{ mbps(lastKbps) }} Mbps</span>
          </div>
          <svg viewBox="0 0 240 64" class="w-full h-16 mt-1" preserveAspectRatio="none">
            <line x1="0" x2="240" y1="33" y2="33" stroke="#334155" stroke-dasharray="3 4" stroke-width="1" />
            <polygon v-if="kbpsChart.area" :points="kbpsChart.area" fill="#34d399" fill-opacity="0.15" />
            <polyline v-if="kbpsChart.line" :points="kbpsChart.line" fill="none" stroke="#34d399" stroke-width="2" stroke-linejoin="round" />
          </svg>
          <p class="text-[10px] text-slate-500 tabular-nums">máx. {{ mbps(kbpsChart.max) }} Mbps</p>
        </div>
      </div>

      <p class="text-xs text-slate-500">
        <template v-if="send">Compressor de {{ peer?.name }}: {{ send.encoder }}</template>
        <template v-else-if="store.viewHistory.fps.length > 5">{{ peer?.name }} está numa versão antiga: os números do lado dela não aparecem.</template>
        <template v-if="video"> · descompressor aqui: {{ video.decoder }}</template>
      </p>
    </template>
  </div>
</template>
