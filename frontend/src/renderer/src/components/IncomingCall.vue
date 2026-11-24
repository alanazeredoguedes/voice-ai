<script setup lang="ts">
/**
 * Chamada recebida (amigos beta): um amigo me chamou para a chamada. Aparece por cima de qualquer aba (mesmo
 * dentro de outra chamada), toca como telefone por até 10 s e oferece Entrar / Recusar. Enquanto eu dito ou falo
 * com a IA (o backend está gravando), aparece sem som, para não atrapalhar. Sem resposta em 30 s, fecha como
 * "não atendida". Quem chamou fica sabendo da resposta (aceitou, recusou, não atendeu).
 */
import { computed, onUnmounted, ref } from 'vue'
import { useFriendsStore, type IncomingRing } from '../stores/friends'
import { useCallStore } from '../stores/call'
import { onWsMessage } from '../api/ws'
import { avatarColor, flog, initials } from '../utils/friendsUi'

const emit = defineEmits<{ 'open-call': [] }>()

const friends = useFriendsStore()
const call = useCallStore()

/** quanto tempo o telefone toca, e quanto tempo a chamada fica na tela esperando resposta */
const RING_MS = 10_000
const SHOW_MS = 30_000

const ring = ref<IncomingRing | null>(null)
const busy = ref(false)
const answering = ref(false)
let shownAt = 0
let sound: { stop: () => void } | null = null
let ringTimer: ReturnType<typeof setTimeout> | null = null
let missTimer: ReturnType<typeof setTimeout> | null = null

/** estou ditando ou falando com a IA (o backend está gravando): a chamada aparece, mas não toca */
const dictating = ref(false)
const unsubWs = onWsMessage((e) => {
  if (e.type !== 'state_changed' || !e.state) return
  const now = e.state === 'recording'
  if (now === dictating.value) return
  dictating.value = now
  if (now && ring.value) {
    busy.value = true
    if (sound) {
      stopSound()
      flog('info', 'comecei a ditar ou falar com a IA durante a chamada recebida: toque silenciado')
    }
  }
})

/** O amigo que está ligando está em outra sala que a minha (entrar = sair desta). */
const leavesCurrent = computed(() => !!ring.value && call.status !== 'idle' && call.code !== ring.value.code)
const alreadyThere = computed(() => !!ring.value && call.inCall && call.code === ring.value.code)

/** Toque de telefone: dois toques curtos a cada 2 s, até `RING_MS`. */
function startSound(): void {
  stopSound()
  try {
    const ctx = new AudioContext()
    void ctx.resume().catch(() => {})
    const out = ctx.createGain()
    out.gain.value = 0.18
    out.connect(ctx.destination)
    const t0 = ctx.currentTime + 0.05
    for (let cycle = 0; cycle * 2 < RING_MS / 1000; cycle++) {
      for (const [i, freq] of [
        [0, 880],
        [1, 740]
      ] as const) {
        const start = t0 + cycle * 2 + i * 0.32
        const osc = ctx.createOscillator()
        const g = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.value = freq
        g.gain.setValueAtTime(0, start)
        g.gain.linearRampToValueAtTime(1, start + 0.02)
        g.gain.setValueAtTime(1, start + 0.24)
        g.gain.linearRampToValueAtTime(0, start + 0.28)
        osc.connect(g)
        g.connect(out)
        osc.start(start)
        osc.stop(start + 0.3)
      }
    }
    sound = { stop: () => void ctx.close().catch(() => {}) }
  } catch (e) {
    flog('warn', `não deu para tocar o som da chamada recebida: ${e instanceof Error ? e.message : e}`)
  }
}

function stopSound(): void {
  sound?.stop()
  sound = null
  if (ringTimer) clearTimeout(ringTimer)
  ringTimer = null
}

function clear(): void {
  stopSound()
  if (missTimer) clearTimeout(missTimer)
  missTimer = null
  ring.value = null
  answering.value = false
}

async function reply(r: IncomingRing, status: 'accepted' | 'declined' | 'missed'): Promise<void> {
  if (!r.inviteId) return
  const err = await friends.send(r.friendId, { kind: 'reply', inviteId: r.inviteId, status })
  if (err) flog('warn', `não deu para avisar ${r.name} da resposta (${status}): ${err}`)
}

function onRing(_e: unknown, r: IncomingRing): void {
  if (!r || typeof r.code !== 'string') return
  if (ring.value && ring.value.inviteId !== r.inviteId) {
    flog('info', `chamada de ${ring.value.name} substituída pela de ${r.name} (nova chamada recebida)`)
    void reply(ring.value, 'missed')
  }
  clear()
  ring.value = r
  shownAt = Date.now()
  const where = call.status === 'idle' ? 'fora de chamada' : call.code === r.code ? 'já nesta mesma sala' : `em outra chamada ("${call.room?.name ?? '?'}")`
  busy.value = dictating.value
  if (busy.value) {
    flog('info', `chamada recebida de ${r.name} (sala "${r.roomName}", código ${r.code}) mostrada SEM som: estou ditando ou falando com a IA; eu: ${where}`)
  } else {
    flog('info', `chamada recebida de ${r.name} (sala "${r.roomName}", código ${r.code}): tocando por ${RING_MS / 1000} s; eu: ${where}`)
    startSound()
    ringTimer = setTimeout(stopSound, RING_MS)
  }
  missTimer = setTimeout(() => {
    const cur = ring.value
    if (!cur) return
    flog('info', `chamada de ${cur.name} não atendida em ${SHOW_MS / 1000} s: fechando e avisando quem chamou`)
    clear()
    void reply(cur, 'missed')
  }, SHOW_MS)
}
/** Quem me chamou cancelou: para de tocar e some da tela (sem resposta: a pessoa já desistiu). */
function onRingCancel(_e: unknown, c: { friendId: string; inviteId: string }): void {
  const cur = ring.value
  if (!cur || !c || cur.inviteId !== c.inviteId) return
  flog('info', `${cur.name} cancelou a chamada ${((Date.now() - shownAt) / 1000).toFixed(1)} s depois de começar a tocar: fechando a chamada recebida`)
  clear()
}

window.electron.ipcRenderer.on('friends:ring', onRing)
window.electron.ipcRenderer.on('friends:ring-cancel', onRingCancel)
onUnmounted(() => {
  window.electron.ipcRenderer.removeListener('friends:ring', onRing)
  window.electron.ipcRenderer.removeListener('friends:ring-cancel', onRingCancel)
  unsubWs()
  clear()
})

/** espera a chamada atual terminar de fechar (status volta a "idle") */
function waitIdle(ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = (): void => {
      if (call.status === 'idle' && !call.reopening) return resolve(true)
      if (Date.now() - started > ms) return resolve(false)
      setTimeout(tick, 100)
    }
    tick()
  })
}

async function accept(): Promise<void> {
  const r = ring.value
  if (!r || answering.value) return
  answering.value = true
  const secs = ((Date.now() - shownAt) / 1000).toFixed(1)
  const there = alreadyThere.value
  const leaving = leavesCurrent.value
  // a chamada recebida some na hora e quem chamou já sabe que atendi (entrar pode demorar: alguém de dentro aceitar);
  // assim o tempo de "não atendida" não corre mais
  clear()
  void reply(r, 'accepted')
  emit('open-call')
  if (there) {
    flog('info', `atendeu a chamada de ${r.name} depois de ${secs} s: já estava nesta sala`)
  } else {
    if (leaving) {
      flog('info', `atendeu a chamada de ${r.name} depois de ${secs} s: saindo da chamada "${call.room?.name ?? '?'}" para entrar na sala "${r.roomName}"`)
      call.leave()
      if (!(await waitIdle(5000))) flog('warn', 'a chamada anterior demorou para fechar; tentando entrar mesmo assim')
    } else {
      flog('info', `atendeu a chamada de ${r.name} depois de ${secs} s: entrando na sala "${r.roomName}" (código ${r.code})`)
    }
    if (!r.token) flog('info', `a chamada de ${r.name} veio sem chave de convite (versão antiga): vou pedir para entrar`)
    await call.join(r.code, { inviteToken: r.token })
    if (call.error) flog('warn', `entrar na chamada de ${r.name} falhou: ${call.error}`)
  }
}

function decline(): void {
  const r = ring.value
  if (!r) return
  flog('info', `recusou a chamada de ${r.name} depois de ${((Date.now() - shownAt) / 1000).toFixed(1)} s`)
  clear()
  void reply(r, 'declined')
}
</script>

<template>
  <Teleport to="body">
    <div v-if="ring" class="fixed top-6 left-1/2 -translate-x-1/2 z-[70] w-[22rem] max-w-[calc(100vw-2rem)]">
      <div class="rounded-2xl border border-emerald-500/40 bg-slate-900/95 backdrop-blur shadow-2xl p-4 flex flex-col gap-3">
        <div class="flex items-center gap-3">
          <span class="relative flex-shrink-0">
            <span class="absolute inset-0 rounded-full bg-emerald-500/40 animate-ping" />
            <span :class="['relative w-12 h-12 rounded-full flex items-center justify-center text-sm font-semibold text-white', avatarColor(ring.name)]">{{
              initials(ring.name)
            }}</span>
          </span>
          <div class="flex flex-col min-w-0">
            <span class="text-sm font-semibold text-slate-100 truncate">{{ ring.name }} está te chamando</span>
            <span class="text-xs text-slate-400 truncate">{{ ring.roomName ? `para a chamada "${ring.roomName}"` : 'para uma chamada' }}</span>
          </div>
        </div>
        <p v-if="busy" class="text-[11px] text-amber-300">Sem som porque você estava ditando ou falando com a IA.</p>
        <p v-if="leavesCurrent" class="text-[11px] text-amber-300">Você está em outra chamada: ao entrar, sai dela.</p>
        <p v-else-if="alreadyThere" class="text-[11px] text-emerald-300">Você já está nesta chamada.</p>
        <div class="flex gap-2">
          <button
            class="flex-1 px-3 py-2 rounded-lg text-sm font-medium text-white bg-red-600 hover:bg-red-500 disabled:opacity-60 transition-colors"
            :disabled="answering"
            @click="decline"
          >
            Recusar
          </button>
          <button
            class="flex-1 px-3 py-2 rounded-lg text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 transition-colors"
            :disabled="answering"
            @click="accept"
          >
            {{ answering ? 'Entrando…' : alreadyThere ? 'Abrir a chamada' : 'Entrar na chamada' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
