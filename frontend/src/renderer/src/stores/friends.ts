/**
 * Amigos (beta): lista com status, conversa com cada amigo e convites para a chamada.
 * O trabalho de verdade (ntfy.sh, criptografia, notificações) fica no processo principal: ver main/friends.ts.
 */
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { syslog } from '../utils/syslog'

export type PresenceState = 'online' | 'away' | 'in-call' | 'offline'

export interface Friend {
  id: string
  name: string
  state: PresenceState
  /** último sinal recebido (ms); 0 = nunca */
  lastSeen: number
  unread: number
  addedAt: number
  /** em chamada: código e nome da sala dele ('' = fora de chamada ou versão antiga) */
  code: string
  roomName: string
}

export interface FriendMessage {
  id: string
  from: string
  /** reply = resposta a um convite (aceitou, recusou, não atendeu): aparece como linha do sistema */
  kind: 'msg' | 'invite' | 'reply'
  text: string
  ts: number
  code?: string
  roomName?: string
  inviteId?: string
  status?: 'accepted' | 'declined' | 'missed' | 'cancelled'
  /** convite: chave de uso único para entrar direto (vale 3 min) */
  token?: string
}

/** chamada recebida (convite de um amigo que acabou de chegar): a tela toca e mostra Entrar / Recusar */
export interface IncomingRing {
  friendId: string
  name: string
  inviteId: string
  code: string
  roomName: string
  /** chave de convite: atendendo, entro direto (sem alguém de dentro precisar aceitar) */
  token: string
}

/** pedido de amizade recebido dentro da chamada */
export interface FriendRequest {
  peerId: string
  userId: string
  name: string
  pair: string
  presence: string
}

const ipc = () => window.electron.ipcRenderer
const PANEL_KEY = 'friends.panelOpen'

function readPanelOpen(): boolean {
  try {
    return localStorage.getItem(PANEL_KEY) !== '0'
  } catch {
    return true
  }
}

export const STATE_LABEL: Record<PresenceState, string> = {
  online: 'online',
  away: 'ausente',
  'in-call': 'em chamada',
  offline: 'offline'
}

export const STATE_DOT: Record<PresenceState, string> = {
  online: 'bg-emerald-500',
  away: 'bg-amber-400',
  'in-call': 'bg-indigo-400',
  offline: 'bg-slate-600'
}

export const useFriendsStore = defineStore('friends', () => {
  const friends = ref<Friend[]>([])
  const selectedId = ref<string | null>(null)
  const messages = ref<FriendMessage[]>([])
  /** meu segredo de presença (entregue a quem vira meu amigo) */
  const myPresence = ref('')
  /** pedidos de amizade recebidos na chamada, esperando resposta */
  const requests = ref<FriendRequest[]>([])
  /** pedidos que eu fiz (peerId → segredo do par que mandei) */
  const outgoing = ref<Record<string, string>>({})
  let started = false
  /** painel de amigos (à esquerda na tela de Chamada) aberto ou recolhido; lembrado entre aberturas do app */
  const panelOpen = ref(readPanelOpen())
  /**
   * Chamada que estou fazendo para um amigo (o computador dele está tocando). Fica aqui, e não na tela da conversa,
   * para o "Cancelar" funcionar de qualquer lugar (ex.: chamei do lobby e o app entrou na sala nova).
   */
  const outgoingCall = ref<{
    friendId: string
    name: string
    /** id do convite ('' enquanto a sala ainda está abrindo) */
    inviteId: string
    since: number
    phase: 'opening' | 'ringing'
    /** a sala foi aberta só para esta chamada (cancelar sem ninguém dentro fecha a sala) */
    openedRoom: boolean
  } | null>(null)
  /** dentro da chamada: a conversa com o amigo selecionado está aberta no lugar do chat da sala */
  const callChatOpen = ref(false)
  watch(panelOpen, (v) => {
    try {
      localStorage.setItem(PANEL_KEY, v ? '1' : '0')
    } catch {
      // sem armazenamento: vale só nesta sessão
    }
  })

  const unreadTotal = computed(() => friends.value.reduce((n, f) => n + (f.unread || 0), 0))
  const onlineCount = computed(() => friends.value.filter((f) => f.state !== 'offline').length)
  const selected = computed(() => friends.value.find((f) => f.id === selectedId.value) ?? null)
  const isFriend = (userId: string | undefined): boolean => !!userId && friends.value.some((f) => f.id === userId)

  async function refresh(): Promise<void> {
    const list = (await ipc().invoke('friends:list')) as Friend[]
    const order: Record<PresenceState, number> = { 'in-call': 0, online: 1, away: 2, offline: 3 }
    friends.value = list.sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name))
  }

  async function loadMessages(): Promise<void> {
    messages.value = selectedId.value ? ((await ipc().invoke('friends:chat', selectedId.value)) as FriendMessage[]) : []
  }

  async function init(): Promise<void> {
    if (started) return
    started = true
    // o amigo respondeu ao meu convite: para o "chamando…"
    ipc().on('friends:reply', (_e, r: { friendId: string; inviteId: string; status: string }) => {
      const oc = outgoingCall.value
      if (!oc || oc.inviteId !== r?.inviteId) return
      syslog('info', 'amigos', `chamada para ${oc.name} terminou: ${r.status === 'accepted' ? 'aceitou' : r.status === 'declined' ? 'recusou' : 'não atendeu'} depois de ${((Date.now() - oc.since) / 1000).toFixed(1)} s`)
      outgoingCall.value = null
    })
    ipc().on('friends:changed', (_e, friendId: string | null) => {
      void refresh()
      if (!friendId || friendId === selectedId.value) void loadMessages()
    })
    const me = (await ipc().invoke('friends:me')) as { presence: string }
    myPresence.value = me.presence
    await refresh()
  }

  function setProfile(p: { userId: string; name: string; inCall: boolean; code: string; roomName: string }): void {
    void ipc().invoke('friends:profile', { ...p })
  }

  /** abre (ou fecha, com null) a conversa com um amigo; `visible` = a tela de Amigos está aberta */
  async function select(id: string | null, visible = true): Promise<void> {
    selectedId.value = id
    void ipc().invoke('friends:viewing', visible ? id : null)
    await loadMessages()
  }

  function setVisible(visible: boolean): void {
    void ipc().invoke('friends:viewing', visible ? selectedId.value : null)
  }

  async function add(f: { id: string; name: string; pair: string; presence: string }): Promise<boolean> {
    const ok = (await ipc().invoke('friends:add', { ...f })) as boolean
    await refresh()
    return ok
  }

  async function remove(id: string): Promise<void> {
    await ipc().invoke('friends:remove', id)
    if (selectedId.value === id) await select(null)
    await refresh()
  }

  async function send(
    id: string,
    m: {
      kind: 'msg' | 'invite' | 'reply'
      text?: string
      code?: string
      roomName?: string
      inviteId?: string
      status?: 'accepted' | 'declined' | 'missed' | 'cancelled'
    }
  ): Promise<string> {
    return (await sendWithId(id, m)).error
  }

  /** Envia e devolve também o id da mensagem (o convite precisa dele para poder ser cancelado). */
  async function sendWithId(
    id: string,
    m: { kind: 'msg' | 'invite' | 'reply'; text?: string; code?: string; roomName?: string; inviteId?: string; status?: string; token?: string }
  ): Promise<{ error: string; id: string }> {
    const res = (await ipc().invoke('friends:send', id, { ...m })) as { ok: true; id: string } | { ok: false; error: string }
    return res.ok ? { error: '', id: res.id } : { error: res.error, id: '' }
  }

  /** apaga uma mensagem da conversa (só neste computador) */
  async function deleteMessage(id: string, msgId: string): Promise<void> {
    await ipc().invoke('friends:delete-msg', id, msgId)
  }

  /** segredo novo (64 hex) para o tópico de um par de amigos */
  function newPairSecret(): string {
    const b = crypto.getRandomValues(new Uint8Array(32))
    return [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  }

  return {
    friends,
    selectedId,
    selected,
    messages,
    myPresence,
    requests,
    outgoing,
    panelOpen,
    outgoingCall,
    callChatOpen,
    unreadTotal,
    onlineCount,
    isFriend,
    init,
    refresh,
    setProfile,
    select,
    setVisible,
    add,
    remove,
    send,
    sendWithId,
    deleteMessage,
    newPairSecret
  }
})
