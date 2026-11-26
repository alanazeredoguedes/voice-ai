<script setup lang="ts">
/**
 * Amigos (beta) no lobby da Chamada (fora de uma chamada), à esquerda: quem está online, quem está em chamada
 * (com "Entrar"), e a conversa com cada amigo. Recolhido, vira uma faixa estreita só com os avatares e o status.
 * Dentro da chamada a lista fica num card da coluna da direita (FriendsCallCard).
 *
 * Abre sozinho com o mouse em cima e recolhe quando o mouse sai, flutuando por cima do lobby (o lobby não pula
 * de lugar). O botão de alfinete fixa o painel aberto (aí ele ocupa espaço ao lado do lobby); de novo, desafixa.
 * Com uma conversa aberta o painel também fica aberto, para não fechar no meio de uma mensagem.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { STATE_DOT, useFriendsStore, type Friend } from '../stores/friends'
import FriendConversation from './FriendConversation.vue'
import { avatarColor, canJoinFriend, flog, initials, joinFriendCall, statusText, who } from '../utils/friendsUi'

const friends = useFriendsStore()
const joinError = ref('')
const joiningId = ref('')

/** fixado aberto (lembrado entre aberturas do app) */
const pinned = computed(() => friends.panelOpen)
watch(
  () => friends.panelOpen,
  (v) => flog('info', v ? 'fixou o painel de amigos aberto (lobby)' : 'desafixou o painel de amigos (lobby)')
)
function togglePin(): void {
  friends.panelOpen = !friends.panelOpen
}

// mouse em cima: abre com um atraso curto (passar o mouse de raspão não abre) e fecha com outro (sair um pixel
// da borda não fecha na hora)
const OPEN_DELAY_MS = 120
const CLOSE_DELAY_MS = 300
const hovering = ref(false)
let hoverTimer: ReturnType<typeof setTimeout> | undefined
function onEnter(): void {
  clearTimeout(hoverTimer)
  if (!hovering.value) hoverTimer = setTimeout(() => (hovering.value = true), OPEN_DELAY_MS)
}
function onLeave(): void {
  clearTimeout(hoverTimer)
  if (hovering.value) hoverTimer = setTimeout(() => (hovering.value = false), CLOSE_DELAY_MS)
}
onBeforeUnmount(() => clearTimeout(hoverTimer))

const expanded = computed(() => pinned.value || hovering.value || !!friends.selected)
/** aberto sem estar fixado: flutua por cima do lobby */
const floating = computed(() => expanded.value && !pinned.value)

function open(id: string): void {
  const f = friends.friends.find((x) => x.id === id)
  flog('info', `abriu a conversa com ${who(f)} no lobby (status: ${f?.state ?? '?'}, ${f?.unread ?? 0} não lida(s))`)
  void friends.select(id)
}

async function join(f: Friend): Promise<void> {
  if (joiningId.value) return
  joiningId.value = f.id
  joinError.value = await joinFriendCall(f, 'lista do lobby')
  joiningId.value = ''
}

const ADD_ICON =
  'M19 7.5v3m0 0v3m0-3h3m-3 0h-3m-2.25-4.125a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zM4 19.235v-.11a6.375 6.375 0 0112.75 0v.109A12.318 12.318 0 0110.374 21c-2.331 0-4.512-.645-6.374-1.766z'
</script>

<template>
  <!-- o espaço que o painel ocupa ao lado do lobby: estreito, ou largo quando fixado -->
  <div :class="['relative flex-shrink-0 h-full min-h-0 transition-[width] duration-150', pinned ? 'w-72' : 'w-14']" @mouseenter="onEnter" @mouseleave="onLeave">
  <!-- Recolhido: faixa estreita com os avatares -->
  <aside
    v-if="!expanded"
    class="absolute inset-0 flex flex-col items-center gap-2 py-3 bg-slate-800/60 rounded-2xl border border-slate-700/40 min-h-0"
  >
    <button
      class="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-700/60 transition-colors"
      title="Amigos (beta): clique para fixar aberto"
      @click="togglePin"
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

  <!-- Aberto (fixado, ou flutuando por cima do lobby enquanto o mouse está em cima) -->
  <aside
    v-else
    :class="[
      'absolute inset-y-0 left-0 w-72 z-30 flex flex-col rounded-2xl border border-slate-700/40 min-h-0 overflow-hidden',
      floating ? 'bg-slate-800 shadow-2xl shadow-black/50' : 'bg-slate-800/60'
    ]"
  >
    <!-- Lista -->
    <template v-if="!friends.selected">
      <div class="px-4 py-3 border-b border-slate-700/40 flex items-center gap-2 flex-shrink-0">
        <h2 class="text-sm font-semibold text-slate-100">Amigos</h2>
        <span class="text-[9px] uppercase tracking-wide text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded px-1">beta</span>
        <span class="ml-auto text-[11px] text-slate-500">{{ friends.onlineCount }} online</span>
        <!-- alfinete: fixa aberto / desafixa (desafixado, fecha quando o mouse sai) -->
        <button
          :class="[
            'p-1 rounded-md transition-colors',
            pinned ? 'text-indigo-300 bg-indigo-500/15 hover:bg-indigo-500/25' : 'text-slate-500 hover:text-slate-100 hover:bg-slate-700/60'
          ]"
          :title="pinned ? 'Desafixar (o painel fecha ao tirar o mouse)' : 'Fixar aberto'"
          :aria-pressed="pinned"
          @click="togglePin"
        >
          <svg :class="['w-4 h-4 transition-transform', pinned ? '' : 'rotate-45']" :fill="pinned ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6zM12 14v7" />
          </svg>
        </button>
      </div>
      <ul v-if="friends.friends.length" class="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
        <li v-for="f in friends.friends" :key="f.id" class="rounded-xl hover:bg-slate-700/30 transition-colors">
          <button class="w-full flex items-center gap-3 px-2 py-2 text-left" @click="open(f.id)">
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
          <!-- em chamada: entrar direto na sala dele -->
          <div v-if="canJoinFriend(f)" class="px-2 pb-2 -mt-1 pl-14">
            <button
              class="w-full px-2.5 py-1 rounded-lg text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 transition-colors"
              :disabled="!!joiningId"
              :title="`Entra na sala em que ${f.name} está agora (alguém de dentro pode precisar aceitar)`"
              @click="join(f)"
            >
              {{ joiningId === f.id ? 'Entrando…' : 'Entrar na chamada' }}
            </button>
          </div>
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
          Com o Voice AI aberto (pode estar só na bandeja), vocês veem quando o outro está online ou em chamada, trocam mensagens e entram na
          chamada um do outro. Vai tudo cifrado pelo ntfy.sh, sem servidor próprio.
        </p>
      </div>
      <p v-if="joinError" class="px-3 pb-2 text-xs text-red-400">{{ joinError }}</p>
    </template>

    <!-- Conversa -->
    <FriendConversation v-else close-kind="back" @close="friends.select(null)" />
  </aside>
  </div>
</template>
