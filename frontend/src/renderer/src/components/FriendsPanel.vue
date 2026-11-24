<script setup lang="ts">
/**
 * Amigos (beta), à esquerda da tela de Chamada: quem está online, conversa com cada amigo e convite para a chamada.
 * Fechado, vira uma faixa estreita só com os avatares e o status. Ver stores/friends.ts.
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { STATE_DOT, STATE_LABEL, useFriendsStore, type FriendMessage, type PresenceState } from '../stores/friends'
import { useCallStore } from '../stores/call'
import ConfirmModal from './ConfirmModal.vue'
import ChatText from './ChatText.vue'
import { syslog } from '../utils/syslog'

const friends = useFriendsStore()
const call = useCallStore()

/** log do sistema, categoria "amigos" (aba Logs → Sistema). Nunca o texto das mensagens. */
const flog = (level: 'info' | 'warn', msg: string): void => syslog(level, 'amigos', msg)
const who = (f: { id: string; name: string } | null | undefined): string => (f ? `${f.name} (${f.id.slice(0, 8)})` : '?')

const draft = ref('')
const sending = ref(false)
const error = ref('')
const inviting = ref('')
const removing = ref(false)
const list = ref<HTMLElement | null>(null)

const AVATAR_COLORS = ['bg-indigo-500', 'bg-emerald-600', 'bg-sky-600', 'bg-fuchsia-600', 'bg-amber-600', 'bg-rose-600', 'bg-teal-600', 'bg-violet-600']
function avatarColor(name: string): string {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}
const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?'

function ago(ms: number): string {
  if (!ms) return 'offline'
  const min = Math.round((Date.now() - ms) / 60_000)
  if (min < 1) return 'visto agora há pouco'
  if (min < 60) return `visto há ${min} min`
  const h = Math.round(min / 60)
  if (h < 24) return `visto há ${h} h`
  return `visto em ${new Date(ms).toLocaleDateString()}`
}
const statusText = (f: { state: PresenceState; lastSeen: number }): string => (f.state === 'offline' ? ago(f.lastSeen) : STATE_LABEL[f.state])

const time = (ts: number): string => {
  const d = new Date(ts)
  const today = new Date().toDateString() === d.toDateString()
  return today
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

const mine = (m: FriendMessage): boolean => m.from === call.userId

async function scrollDown(): Promise<void> {
  await nextTick()
  if (list.value) list.value.scrollTop = list.value.scrollHeight
}
watch(() => friends.messages.length, scrollDown)
watch(
  () => friends.selectedId,
  () => {
    error.value = ''
    draft.value = ''
    void scrollDown()
  }
)

/** a conversa aberta só conta como lida com o painel aberto e a janela em foco */
const syncVisible = (): void => friends.setVisible(friends.panelOpen)
watch(
  () => friends.panelOpen,
  (v) => {
    flog('info', v ? 'abriu o painel de amigos' : 'recolheu o painel de amigos')
    syncVisible()
  }
)
onMounted(() => {
  syncVisible()
  window.addEventListener('focus', syncVisible)
  void scrollDown()
})
onUnmounted(() => {
  window.removeEventListener('focus', syncVisible)
  friends.setVisible(false)
})

function open(id: string): void {
  const f = friends.friends.find((x) => x.id === id)
  flog('info', `abriu a conversa com ${who(f)} (status: ${f?.state ?? '?'}, ${f?.unread ?? 0} não lida(s))`)
  friends.panelOpen = true
  void friends.select(id)
}

async function send(): Promise<void> {
  const f = friends.selected
  const text = draft.value.trim()
  if (!f || !text || sending.value) return
  sending.value = true
  error.value = await friends.send(f.id, { kind: 'msg', text })
  if (error.value) flog('warn', `envio de mensagem para ${who(f)} falhou: ${error.value}`)
  else draft.value = ''
  sending.value = false
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    void send()
  }
}

/** espera a condição (ou a falha), com tempo máximo */
function waitFor(ok: () => boolean, failed: () => boolean, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (ok()) return resolve(true)
    const stop = watch([ok, failed], ([a, b]) => {
      if (a || b) {
        stop()
        clearTimeout(timer)
        resolve(a)
      }
    })
    const timer = setTimeout(() => {
      stop()
      resolve(ok())
    }, ms)
  })
}

const inviteLabel = computed(() => (call.inCall ? 'Chamar para esta chamada' : 'Chamar para uma chamada'))

/** Convida para a chamada: a que estou agora ou, fora de uma, abre uma sala nova e manda o código. */
async function invite(): Promise<void> {
  const f = friends.selected
  if (!f || inviting.value) return
  error.value = ''
  flog('info', `clicou em chamar ${who(f)} para a chamada (status dele: ${f.state}; eu: ${call.inCall ? `na sala "${call.room?.name ?? '?'}"` : call.status})`)
  try {
    if (call.status === 'idle') {
      flog('info', 'convite: não estou numa chamada, abrindo uma sala nova')
      inviting.value = 'Abrindo a sala…'
      void call.create({ roomName: `${call.name || 'Sala'} e ${f.name}`.slice(0, 80) })
    } else {
      inviting.value = 'Esperando a sala ficar pronta…'
    }
    const ready = await waitFor(
      () => call.inCall && !!call.code && call.codeReady,
      () => call.status === 'idle' && !call.reopening,
      120_000
    )
    if (!ready) throw new Error(call.error || 'A sala não ficou pronta a tempo')
    inviting.value = 'Enviando o convite…'
    const err = await friends.send(f.id, { kind: 'invite', code: call.code, roomName: call.room?.name ?? '' })
    if (err) throw new Error(err)
    flog('info', `convite enviado para ${who(f)} (código ${call.code})`)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    flog('warn', `convite para ${who(f)} falhou: ${error.value}`)
  } finally {
    inviting.value = ''
  }
}

async function join(m: FriendMessage): Promise<void> {
  if (!m.code) return
  error.value = ''
  const f = friends.selected
  const age = Math.round((Date.now() - m.ts) / 60_000)
  if (call.status !== 'idle') {
    if (call.code !== m.code) {
      error.value = 'Saia da chamada atual antes de entrar em outra.'
      flog('warn', `clicou em entrar na chamada de ${who(f)} (código ${m.code}), mas já está em outra chamada`)
    }
    return
  }
  flog('info', `clicou em entrar na chamada pelo convite de ${who(f)} (código ${m.code}, convite de ${age} min atrás)`)
  await call.join(m.code)
  if (call.error) flog('warn', `entrar pelo convite de ${who(f)} falhou: ${call.error}`)
}

async function confirmRemove(): Promise<void> {
  const f = friends.selected
  removing.value = false
  if (f) {
    flog('info', `confirmou remover o amigo ${who(f)}`)
    await friends.remove(f.id)
  }
}

const ADD_ICON =
  'M19 7.5v3m0 0v3m0-3h3m-3 0h-3m-2.25-4.125a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zM4 19.235v-.11a6.375 6.375 0 0112.75 0v.109A12.318 12.318 0 0110.374 21c-2.331 0-4.512-.645-6.374-1.766z'
</script>

<template>
  <!-- Fechado: faixa estreita com os avatares -->
  <aside
    v-if="!friends.panelOpen"
    class="w-14 flex-shrink-0 flex flex-col items-center gap-2 py-3 bg-slate-800/60 rounded-2xl border border-slate-700/40 min-h-0"
  >
    <button
      class="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-700/60 transition-colors"
      title="Abrir amigos (beta)"
      @click="friends.panelOpen = true"
    >
      <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" /></svg>
    </button>
    <div class="w-8 border-t border-slate-700/60" />
    <div class="flex-1 overflow-y-auto flex flex-col items-center gap-2 px-1">
      <button v-for="f in friends.friends" :key="f.id" class="relative flex-shrink-0" :title="`${f.name}: ${statusText(f)}`" @click="open(f.id)">
        <span :class="['w-9 h-9 rounded-full flex items-center justify-center text-xs font-semibold text-white', avatarColor(f.name), f.state === 'offline' ? 'opacity-50' : '']">{{
          initials(f.name)
        }}</span>
        <span :class="['absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full ring-2 ring-slate-800', STATE_DOT[f.state]]" />
        <span
          v-if="f.unread"
          class="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-amber-500 text-[10px] font-semibold text-slate-900 flex items-center justify-center"
        >{{ f.unread }}</span>
      </button>
    </div>
  </aside>

  <!-- Aberto -->
  <aside v-else class="w-72 flex-shrink-0 flex flex-col bg-slate-800/60 rounded-2xl border border-slate-700/40 min-h-0 overflow-hidden">
    <!-- Lista -->
    <template v-if="!friends.selected">
      <div class="px-4 py-3 border-b border-slate-700/40 flex items-center gap-2 flex-shrink-0">
        <h2 class="text-sm font-semibold text-slate-100">Amigos</h2>
        <span class="text-[9px] uppercase tracking-wide text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded px-1">beta</span>
        <span class="ml-auto text-[11px] text-slate-500">{{ friends.onlineCount }} online</span>
        <button
          class="p-1 rounded-md text-slate-500 hover:text-slate-100 hover:bg-slate-700/60 transition-colors"
          title="Recolher"
          @click="friends.panelOpen = false"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" /></svg>
        </button>
      </div>
      <ul v-if="friends.friends.length" class="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
        <li v-for="f in friends.friends" :key="f.id">
          <button class="w-full flex items-center gap-3 px-2 py-2 rounded-xl text-left hover:bg-slate-700/30 transition-colors" @click="open(f.id)">
            <span class="relative flex-shrink-0">
              <span :class="['w-9 h-9 rounded-full flex items-center justify-center text-xs font-semibold text-white', avatarColor(f.name), f.state === 'offline' ? 'opacity-50' : '']">{{
                initials(f.name)
              }}</span>
              <span :class="['absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full ring-2 ring-slate-800', STATE_DOT[f.state]]" />
            </span>
            <span class="flex flex-col min-w-0 flex-1">
              <span class="text-sm text-slate-100 truncate">{{ f.name }}</span>
              <span class="text-[11px] text-slate-500 truncate">{{ statusText(f) }}</span>
            </span>
            <span
              v-if="f.unread"
              class="flex-shrink-0 min-w-5 h-5 px-1.5 rounded-full bg-amber-500 text-[11px] font-semibold text-slate-900 flex items-center justify-center"
            >{{ f.unread }}</span>
          </button>
        </li>
      </ul>
      <div v-else class="flex-1 p-4 text-xs text-slate-400 leading-relaxed flex flex-col gap-2">
        <p>Você ainda não tem amigos aqui.</p>
        <p>
          Numa chamada, clique no
          <svg class="inline w-3.5 h-3.5 -mt-0.5" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" :d="ADD_ICON" /></svg>
          ao lado do nome da pessoa (lista de participantes). Ela aceita do lado dela.
        </p>
        <p class="text-slate-500">
          Com o Voice AI aberto (pode estar só na bandeja), vocês veem quando o outro está online e trocam mensagens e convites para a
          chamada. Vai tudo cifrado pelo ntfy.sh, sem servidor próprio.
        </p>
      </div>
    </template>

    <!-- Conversa -->
    <template v-else>
      <header class="px-3 py-2.5 border-b border-slate-700/40 flex items-center gap-2 flex-shrink-0">
        <button class="p-1 rounded-md text-slate-400 hover:text-slate-100 hover:bg-slate-700/60 transition-colors" title="Voltar para a lista" @click="friends.select(null)">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" /></svg>
        </button>
        <span :class="['w-2.5 h-2.5 rounded-full flex-shrink-0', STATE_DOT[friends.selected.state]]" />
        <div class="flex flex-col min-w-0 flex-1">
          <span class="text-sm font-semibold text-slate-100 truncate">{{ friends.selected.name }}</span>
          <span class="text-[11px] text-slate-500 truncate">{{ statusText(friends.selected) }}</span>
        </div>
        <button class="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-colors" title="Remover amigo" @click="removing = true">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M22 10.5h-6m-2.25-4.125a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zM4 19.235v-.11a6.375 6.375 0 0112.75 0v.109A12.318 12.318 0 0110.374 21c-2.331 0-4.512-.645-6.374-1.766z" /></svg>
        </button>
      </header>
      <div class="px-3 pt-2 flex-shrink-0">
        <button
          class="w-full px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 transition-colors"
          :disabled="!!inviting"
          :title="call.inCall ? 'Manda o código da sua chamada atual' : 'Abre uma sala nova e manda o código para a pessoa'"
          @click="invite"
        >
          {{ inviting || inviteLabel }}
        </button>
      </div>

      <div ref="list" class="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-2">
        <p v-if="!friends.messages.length" class="m-auto text-xs text-slate-500 text-center">
          Nenhuma mensagem ainda. Se {{ friends.selected.name }} estiver offline, a mensagem fica guardada por até 12 h e chega quando o app dela abrir.
        </p>
        <div v-for="m in friends.messages" :key="m.id" :class="['flex flex-col max-w-[85%]', mine(m) ? 'self-end items-end' : 'self-start items-start']">
          <div v-if="m.kind === 'invite'" class="rounded-xl px-3 py-2 text-sm border bg-emerald-500/10 border-emerald-500/40 text-slate-100 flex flex-col gap-2">
            <span>
              {{ mine(m) ? 'Você chamou para a chamada' : `${friends.selected.name} está te chamando para a chamada` }}
              <strong v-if="m.roomName">"{{ m.roomName }}"</strong>
            </span>
            <button
              v-if="!mine(m)"
              class="self-start px-3 py-1 rounded-lg text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 transition-colors"
              :disabled="call.code === m.code && call.status !== 'idle'"
              @click="join(m)"
            >
              {{ call.code === m.code && call.status !== 'idle' ? 'Você está nesta chamada' : 'Entrar na chamada' }}
            </button>
          </div>
          <div v-else :class="['rounded-xl px-3 py-2 text-sm', mine(m) ? 'bg-indigo-600 text-white' : 'bg-slate-700/70 text-slate-100']">
            <ChatText :text="m.text" />
          </div>
          <span class="text-[10px] text-slate-500 mt-0.5">{{ time(m.ts) }}</span>
        </div>
      </div>

      <p v-if="error" class="px-3 pb-1 text-xs text-red-400">{{ error }}</p>
      <div class="p-2.5 border-t border-slate-700/40 flex items-end gap-2 flex-shrink-0">
        <textarea
          v-model="draft"
          rows="1"
          maxlength="1000"
          :placeholder="`Mensagem para ${friends.selected.name}`"
          class="flex-1 min-w-0 resize-none max-h-32 bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
          @keydown="onKey"
        />
        <button
          class="p-2 rounded-lg text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 transition-colors"
          title="Enviar (Enter)"
          :disabled="!draft.trim() || sending"
          @click="send"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" /></svg>
        </button>
      </div>
    </template>

    <ConfirmModal :open="removing" title="Remover amigo?" confirm-label="Remover" @confirm="confirmRemove" @cancel="removing = false">
      {{ friends.selected?.name }} sai da sua lista e a conversa é apagada deste computador. Para voltar a ser amigos, é preciso adicionar de novo
      numa chamada.
    </ConfirmModal>
  </aside>
</template>
