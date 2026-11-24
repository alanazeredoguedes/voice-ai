<script setup lang="ts">
/**
 * Conversa com o amigo selecionado (amigos beta): mensagens, convite para a chamada e entrar na chamada dele.
 * Usada no card de amigos do lobby (com "voltar") e, dentro da chamada, no lugar do chat da sala (com "fechar").
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { STATE_DOT, useFriendsStore, type FriendMessage } from '../stores/friends'
import { useCallStore } from '../stores/call'
import ConfirmModal from './ConfirmModal.vue'
import ChatText from './ChatText.vue'
import { callFriend, cancelCall, canJoinFriend, flog, inMyCall, joinFriendCall, statusText, who } from '../utils/friendsUi'

const props = withDefaults(defineProps<{ closeKind?: 'back' | 'close' }>(), { closeKind: 'back' })
const emit = defineEmits<{ close: [] }>()

const friends = useFriendsStore()
const call = useCallStore()

const draft = ref('')
const sending = ref(false)
const error = ref('')
const joining = ref(false)
const removing = ref(false)
const list = ref<HTMLElement | null>(null)

const f = computed(() => friends.selected)
/** estou chamando este amigo agora (o computador dele está tocando, ou a sala ainda abrindo) */
const calling = computed(() => (friends.outgoingCall?.friendId === f.value?.id ? friends.outgoingCall : null))

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

// conversa na tela = lida (o processo principal não notifica nem conta como não lida); conta de novo ao voltar o foco
const markVisible = (): void => friends.setVisible(true)

/** dentro da chamada, ESC fecha a conversa e volta para o chat da sala (se nenhum menu ou janela estiver aberto) */
function onKeydown(e: KeyboardEvent): void {
  if (props.closeKind !== 'close' || e.key !== 'Escape' || e.defaultPrevented || removing.value) return
  if (document.fullscreenElement || document.querySelector('.fixed.inset-0')) return
  flog('info', `apertou ESC: fechando a conversa com ${who(f.value)}`)
  emit('close')
}

onMounted(() => {
  markVisible()
  window.addEventListener('focus', markVisible)
  window.addEventListener('keydown', onKeydown)
  void scrollDown()
})
onUnmounted(() => {
  window.removeEventListener('focus', markVisible)
  window.removeEventListener('keydown', onKeydown)
  friends.setVisible(false)
})

/** Linha do sistema da resposta a um convite. */
function replyText(m: FriendMessage): string {
  const name = f.value?.name ?? 'O amigo'
  const verb = { accepted: 'aceitou', declined: 'recusou', missed: 'não atendeu', cancelled: 'cancelou' }[m.status ?? 'missed']
  if (m.status === 'cancelled') return mine(m) ? `Você cancelou a chamada para ${name}` : `${name} cancelou a chamada`
  return mine(m) ? `Você ${verb} a chamada de ${name}` : `${name} ${verb} a sua chamada`
}

async function deleteMsg(m: FriendMessage): Promise<void> {
  const friend = f.value
  if (!friend) return
  await friends.deleteMessage(friend.id, m.id)
}

function close(): void {
  flog('info', `${props.closeKind === 'close' ? 'fechou' : 'saiu da'} conversa com ${who(f.value)}${props.closeKind === 'close' ? ' (voltou ao chat da sala)' : ''}`)
  emit('close')
}

async function send(): Promise<void> {
  const friend = f.value
  const text = draft.value.trim()
  if (!friend || !text || sending.value) return
  sending.value = true
  error.value = await friends.send(friend.id, { kind: 'msg', text })
  if (error.value) flog('warn', `envio de mensagem para ${who(friend)} falhou: ${error.value}`)
  else draft.value = ''
  sending.value = false
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    void send()
  }
}

const inviteTitle = computed(() =>
  call.inCall
    ? `Chama ${f.value?.name ?? 'o amigo'} para esta chamada: o computador dele toca e ele escolhe entrar ou recusar`
    : `Abre uma sala para vocês dois e liga para ${f.value?.name ?? 'o amigo'}: o computador dele toca e, se atender, ele entra direto`
)

/** Chama o amigo (o computador dele toca). Fora de uma chamada, abre uma sala nova. */
async function invite(): Promise<void> {
  const friend = f.value
  if (!friend || calling.value) return
  error.value = await callFriend(friend)
}

/** Entra na chamada em que o amigo está agora (o código vem no status dele). */
async function joinTheirCall(): Promise<void> {
  const friend = f.value
  if (!friend || joining.value) return
  joining.value = true
  error.value = await joinFriendCall(friend, 'botão da conversa')
  joining.value = false
}

/** Entra pela mensagem de convite. */
async function joinInvite(m: FriendMessage): Promise<void> {
  if (!m.code) return
  error.value = ''
  const friend = f.value
  const age = Math.round((Date.now() - m.ts) / 60_000)
  if (call.status !== 'idle') {
    if (call.code !== m.code) {
      error.value = 'Saia da chamada atual antes de entrar em outra.'
      flog('warn', `clicou em entrar pelo convite de ${who(friend)} (código ${m.code}), mas já está em outra chamada`)
    }
    return
  }
  flog('info', `clicou em entrar na chamada pelo convite de ${who(friend)} (código ${m.code}, convite de ${age} min atrás)`)
  // a chave do convite vale 3 min: depois disso (ou já usada), a entrada vira um pedido para alguém de dentro aceitar
  await call.join(m.code, { inviteToken: m.token })
  if (call.error) flog('warn', `entrar pelo convite de ${who(friend)} falhou: ${call.error}`)
}

async function confirmRemove(): Promise<void> {
  const friend = f.value
  removing.value = false
  if (!friend) return
  flog('info', `confirmou remover o amigo ${who(friend)}`)
  await friends.remove(friend.id)
  emit('close')
}
</script>

<template>
  <div v-if="f" class="flex flex-col h-full min-h-0">
    <header class="px-3 py-2.5 border-b border-slate-700/40 flex items-center gap-2 flex-shrink-0">
      <button
        v-if="closeKind === 'back'"
        class="p-1 rounded-md text-slate-400 hover:text-slate-100 hover:bg-slate-700/60 transition-colors"
        title="Voltar para a lista"
        @click="close"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" /></svg>
      </button>
      <span :class="['w-2.5 h-2.5 rounded-full flex-shrink-0', STATE_DOT[f.state]]" />
      <div class="flex flex-col min-w-0 flex-1">
        <span class="text-sm font-semibold text-slate-100 truncate">
          {{ f.name }}
          <span class="ml-1 text-[9px] align-middle uppercase tracking-wide text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded px-1">amigo</span>
        </span>
        <span class="text-[11px] text-slate-500 truncate">{{ inMyCall(f) ? 'nesta chamada com você' : statusText(f) }}</span>
      </div>
      <!-- chamar para a chamada: some quando o amigo já está nesta mesma chamada -->
      <button
        v-if="calling"
        class="flex-shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium text-white bg-red-600 hover:bg-red-500 transition-colors"
        :title="`Cancelar a chamada para ${f.name} (o computador dele para de tocar)`"
        @click="cancelCall('botão Cancelar da conversa')"
      >
        <svg class="w-3.5 h-3.5 rotate-[135deg]" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z" /></svg>
        Cancelar
      </button>
      <button
        v-else-if="!inMyCall(f)"
        class="flex-shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-70 transition-colors"
        :disabled="!!friends.outgoingCall"
        :title="friends.outgoingCall ? `Você já está chamando ${friends.outgoingCall.name}` : inviteTitle"
        @click="invite"
      >
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z" /></svg>
        {{ call.status === 'idle' ? 'Ligar' : 'Chamar' }}
      </button>
      <button class="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-colors" title="Remover amigo" @click="removing = true">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M22 10.5h-6m-2.25-4.125a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zM4 19.235v-.11a6.375 6.375 0 0112.75 0v.109A12.318 12.318 0 0110.374 21c-2.331 0-4.512-.645-6.374-1.766z" /></svg>
      </button>
      <button
        v-if="closeKind === 'close'"
        class="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-700/60 transition-colors"
        title="Fechar a conversa (volta para o chat da sala)"
        @click="close"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
      </button>
    </header>

    <!-- o amigo está numa chamada e eu estou fora: entro direto na dele -->
    <div v-if="canJoinFriend(f)" class="px-3 pt-2 flex-shrink-0">
      <button
        class="w-full px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 transition-colors"
        :disabled="joining"
        :title="`Entra na sala em que ${f.name} está agora (alguém de dentro pode precisar aceitar)`"
        @click="joinTheirCall"
      >
        {{ joining ? 'Entrando…' : `Entrar na chamada de ${f.name}` }}
      </button>
    </div>
    <!-- chamando: o computador do amigo está tocando (ou a sala ainda abrindo) -->
    <p v-if="calling" class="px-3 pt-2 flex items-center gap-1.5 text-[11px] text-emerald-300">
      <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
      {{ calling.phase === 'opening' ? `Abrindo uma sala para você e ${f.name}…` : `Chamando ${f.name}… o computador dele está tocando` }}
    </p>

    <div ref="list" class="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-2 min-h-0">
      <p v-if="!friends.messages.length" class="m-auto text-xs text-slate-500 text-center max-w-xs">
        Nenhuma mensagem ainda. Se {{ f.name }} estiver offline, a mensagem fica guardada por até 12 h e chega quando o app dela abrir.
      </p>
      <template v-for="m in friends.messages" :key="m.id">
      <!-- resposta a um convite: linha do sistema no meio -->
      <div v-if="m.kind === 'reply'" class="group/msg self-center flex items-center gap-1.5 text-[11px] text-slate-500 py-0.5">
        <span>{{ replyText(m) }} · {{ time(m.ts) }}</span>
        <button class="opacity-0 group-hover/msg:opacity-100 p-0.5 rounded text-slate-500 hover:text-red-400 transition" title="Apagar (só neste computador)" @click="deleteMsg(m)">
          <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
      </div>
      <div v-else :class="['group/msg flex flex-col max-w-[85%]', mine(m) ? 'self-end items-end' : 'self-start items-start']">
        <div v-if="m.kind === 'invite'" class="rounded-xl px-3 py-2 text-sm border bg-emerald-500/10 border-emerald-500/40 text-slate-100 flex flex-col gap-2">
          <span>
            {{ mine(m) ? 'Você chamou para a chamada' : `${f.name} está te chamando para a chamada` }}
            <strong v-if="m.roomName">"{{ m.roomName }}"</strong>
          </span>
          <button
            v-if="!mine(m)"
            class="self-start px-3 py-1 rounded-lg text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 transition-colors"
            :disabled="call.code === m.code && call.status !== 'idle'"
            @click="joinInvite(m)"
          >
            {{ call.code === m.code && call.status !== 'idle' ? 'Você está nesta chamada' : 'Entrar na chamada' }}
          </button>
        </div>
        <div v-else :class="['rounded-xl px-3 py-2 text-sm', mine(m) ? 'bg-indigo-600 text-white' : 'bg-slate-700/70 text-slate-100']">
          <ChatText :text="m.text" />
        </div>
        <span class="flex items-center gap-1 text-[10px] text-slate-500 mt-0.5">
          {{ time(m.ts) }}
          <button
            class="opacity-0 group-hover/msg:opacity-100 p-0.5 rounded text-slate-500 hover:text-red-400 transition"
            title="Apagar (só neste computador)"
            @click="deleteMsg(m)"
          >
            <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>
          </button>
        </span>
      </div>
      </template>
    </div>

    <p v-if="error" class="px-3 pb-1 text-xs text-red-400">{{ error }}</p>
    <div class="p-2.5 border-t border-slate-700/40 flex items-end gap-2 flex-shrink-0">
      <textarea
        v-model="draft"
        rows="1"
        maxlength="1000"
        :placeholder="`Mensagem para ${f.name}`"
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

    <ConfirmModal :open="removing" title="Remover amigo?" confirm-label="Remover" @confirm="confirmRemove" @cancel="removing = false">
      {{ f.name }} sai da sua lista e a conversa é apagada deste computador. Para voltar a ser amigos, é preciso adicionar de novo numa chamada.
    </ConfirmModal>
  </div>
</template>
