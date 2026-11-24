/**
 * Amigos (beta): pedaços comuns da interface (lobby e dentro da chamada) e as ações que mexem na chamada
 * (entrar na chamada de um amigo). Tudo registra no log do sistema, categoria "amigos".
 */
import { syslog } from './syslog'
import { STATE_LABEL, useFriendsStore, type Friend, type PresenceState } from '../stores/friends'
import { useCallStore } from '../stores/call'

/** log do sistema, categoria "amigos" (aba Logs → Sistema). Nunca o texto das mensagens. */
export const flog = (level: 'info' | 'warn', msg: string): void => syslog(level, 'amigos', msg)
export const who = (f: { id: string; name: string } | null | undefined): string => (f ? `${f.name} (${f.id.slice(0, 8)})` : '?')

const AVATAR_COLORS = ['bg-indigo-500', 'bg-emerald-600', 'bg-sky-600', 'bg-fuchsia-600', 'bg-amber-600', 'bg-rose-600', 'bg-teal-600', 'bg-violet-600']
export function avatarColor(name: string): string {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}

export const initials = (name: string): string =>
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

export function statusText(f: { state: PresenceState; lastSeen: number; roomName?: string; code?: string }): string {
  if (f.state === 'offline') return ago(f.lastSeen)
  if (f.state === 'in-call' && f.code) return f.roomName ? `em chamada · ${f.roomName}` : 'em chamada'
  return STATE_LABEL[f.state]
}

/** O amigo está numa chamada em que dá para entrar (informou o código) e eu estou fora de qualquer chamada. */
export function canJoinFriend(f: Friend | null | undefined): boolean {
  const call = useCallStore()
  return !!f && f.state === 'in-call' && !!f.code && call.status === 'idle' && !call.reopening
}

/**
 * O amigo está na mesma chamada que eu: pela lista de participantes (cada um se apresenta com o id ao conectar;
 * funciona com qualquer versão) ou pelo código da sala que ele publica no status.
 */
export function inMyCall(f: Friend | null | undefined): boolean {
  const call = useCallStore()
  if (!f || !call.inCall) return false
  if (Object.values(call.peerUserIds).includes(f.id)) return true
  return !!f.code && call.code === f.code
}

/** Entra na chamada em que o amigo está (pelo código que ele publica no status). Devolve o erro ('' = deu certo). */
export async function joinFriendCall(f: Friend, from: string): Promise<string> {
  const call = useCallStore()
  if (!f.code) return 'Este amigo não informou a sala (versão antiga ou a sala ainda abrindo)'
  if (call.status !== 'idle') {
    flog('warn', `clicou em entrar na chamada de ${who(f)} (${from}), mas já está em outra chamada`)
    return 'Saia da chamada atual antes de entrar em outra.'
  }
  flog('info', `clicou em entrar na chamada de ${who(f)} (${from}): sala "${f.roomName}", código ${f.code}`)
  await call.join(f.code)
  if (call.error) {
    flog('warn', `entrar na chamada de ${who(f)} falhou: ${call.error}`)
    return call.error
  }
  flog('info', `entrada na chamada de ${who(f)} iniciada (${(call.status as string) === 'in-call' ? 'já dentro' : 'esperando ser aceito'})`)
  return ''
}

// ------------------------------------------------------------------ chamar um amigo (o computador dele toca)

/** o amigo tem 30 s para atender; depois disso paro de mostrar "chamando…" */
const CALL_TIMEOUT_MS = 35_000
let callTimer: ReturnType<typeof setTimeout> | null = null
/** marca da chamada em andamento: cancelar liga `cancelled` e a chamada (ainda abrindo a sala) desiste de enviar */
let callToken: { cancelled: boolean } | null = null

/** espera a condição (ou a falha), com tempo máximo */
function waitFor(ok: () => boolean, failed: () => boolean, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = (): void => {
      if (ok()) return resolve(true)
      if (failed() || Date.now() - started > ms) return resolve(ok())
      setTimeout(tick, 150)
    }
    tick()
  })
}

/**
 * Chama o amigo para a chamada: a que estou agora ou, fora de uma, abre uma sala nova (e a conversa com ele abre no
 * lugar do chat da sala). O computador dele toca; ele entra ou recusa. Devolve o erro ('' = chamando).
 */
export async function callFriend(f: Friend): Promise<string> {
  const call = useCallStore()
  const friends = useFriendsStore()
  if (friends.outgoingCall) return `Já está chamando ${friends.outgoingCall.name}`
  flog('info', `clicou em chamar ${who(f)} (status dele: ${f.state}; eu: ${call.inCall ? `na sala "${call.room?.name ?? '?'}"` : call.status})`)
  const openedRoom = call.status === 'idle'
  const token = { cancelled: false }
  callToken = token
  friends.outgoingCall = { friendId: f.id, name: f.name, inviteId: '', since: Date.now(), phase: 'opening', openedRoom }
  try {
    if (openedRoom) {
      flog('info', `chamada para ${who(f)}: não estou numa chamada, abrindo uma sala nova`)
      void call.create({ roomName: `${call.name || 'Sala'} e ${f.name}`.slice(0, 80) })
      // dentro da sala, a conversa com o amigo fica aberta no lugar do chat (com o Cancelar à mão)
      friends.callChatOpen = true
    }
    const ready = await waitFor(
      () => call.inCall && !!call.code && call.codeReady,
      () => (call.status === 'idle' && !call.reopening) || token.cancelled,
      120_000
    )
    if (token.cancelled) return ''
    if (!ready) throw new Error(call.error || 'A sala não ficou pronta a tempo')
    // chave de uso único: quem atender entra direto, sem eu precisar aceitar o pedido de entrada
    const inviteToken = call.createInviteToken()
    const res = await friends.sendWithId(f.id, { kind: 'invite', code: call.code, roomName: call.room?.name ?? '', token: inviteToken })
    if (res.error) throw new Error(res.error)
    const oc = friends.outgoingCall
    if (!oc || token.cancelled) {
      // cancelou enquanto o convite saía: avisa o amigo para parar de tocar
      flog('info', `chamada para ${who(f)}: cancelada enquanto o convite saía; avisando para parar de tocar`)
      void friends.send(f.id, { kind: 'reply', inviteId: res.id, status: 'cancelled' })
      return ''
    }
    friends.outgoingCall = { ...oc, inviteId: res.id, phase: 'ringing', since: Date.now() }
    flog(
      'info',
      `chamando ${who(f)} (sala "${call.room?.name ?? '?'}", código ${call.code}): o computador dele deve tocar agora; ` +
        (inviteToken ? 'se atender, entra direto' : 'sem chave de convite: se atender, vai pedir para entrar')
    )
    if (callTimer) clearTimeout(callTimer)
    callTimer = setTimeout(() => {
      const cur = friends.outgoingCall
      if (cur?.inviteId !== res.id) return
      flog('info', `chamada para ${cur.name}: sem resposta em ${CALL_TIMEOUT_MS / 1000} s`)
      friends.outgoingCall = null
    }, CALL_TIMEOUT_MS)
    return ''
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (token.cancelled) return ''
    flog('warn', `chamada para ${who(f)} falhou: ${msg}`)
    friends.outgoingCall = null
    // a sala não chegou a abrir: a conversa não pode ficar marcada para abrir na próxima chamada
    if (openedRoom && !call.inCall) friends.callChatOpen = false
    return msg
  }
}

/** Cancela a chamada que estou fazendo: o computador do amigo para de tocar; a sala aberta só para ela fecha se ninguém entrou. */
export function cancelCall(from: string): void {
  const call = useCallStore()
  const friends = useFriendsStore()
  const oc = friends.outgoingCall
  if (!oc) return
  const secs = ((Date.now() - oc.since) / 1000).toFixed(1)
  if (callTimer) clearTimeout(callTimer)
  callTimer = null
  // a chamada ainda abrindo a sala vê isto e não envia o convite (ou avisa para parar, se ele já tiver saído)
  if (callToken) callToken.cancelled = true
  callToken = null
  friends.outgoingCall = null
  if (oc.inviteId) {
    flog('info', `cancelou a chamada para ${oc.name} (${from}) depois de ${secs} s tocando: avisando para parar de tocar`)
    void friends.send(oc.friendId, { kind: 'reply', inviteId: oc.inviteId, status: 'cancelled' })
  } else {
    flog('info', `cancelou a chamada para ${oc.name} (${from}) enquanto a sala ainda abria: o convite não sai`)
  }
  if (oc.openedRoom && call.status !== 'idle' && !call.peers.length) {
    flog('info', 'a sala tinha sido aberta só para essa chamada e ninguém entrou: saindo dela')
    call.leave()
  }
  // cancelou antes de a sala abrir: a conversa não pode ficar marcada para abrir na próxima chamada
  if (oc.openedRoom && !call.inCall) friends.callChatOpen = false
}
