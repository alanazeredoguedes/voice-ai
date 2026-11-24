<script setup lang="ts">
/**
 * Amigos (beta) dentro da chamada: card na base da coluna da direita, embaixo de "Transmissões".
 * Minimizado (padrão): só o cabeçalho e os avatares de quem está online. Clicando no cabeçalho, expande com a lista
 * inteira (com rolagem). Clicar num amigo abre a conversa no lugar do chat da sala (X ou ESC voltam).
 */
import { computed, ref, watch } from 'vue'
import { STATE_DOT, useFriendsStore } from '../stores/friends'
import { avatarColor, cancelCall, flog, initials, inMyCall, statusText, who } from '../utils/friendsUi'

const friends = useFriendsStore()
const OPEN_KEY = 'friends.callCardOpen'

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === '1'
  } catch {
    return false
  }
}
const open = ref(readOpen())
watch(open, (v) => {
  try {
    localStorage.setItem(OPEN_KEY, v ? '1' : '0')
  } catch {
    // sem armazenamento: vale só agora
  }
  flog('info', v ? 'expandiu o card de amigos na chamada' : 'minimizou o card de amigos na chamada')
})

/** minimizado: avatares só de quem está online (no máximo 6) */
const onlineFriends = computed(() => friends.friends.filter((f) => f.state !== 'offline'))
const MAX_AVATARS = 6

function openChat(id: string, from: string): void {
  const f = friends.friends.find((x) => x.id === id)
  flog('info', `abriu a conversa com ${who(f)} dentro da chamada, pelo ${from} (status: ${f?.state ?? '?'}, ${f?.unread ?? 0} não lida(s))`)
  friends.callChatOpen = true
  void friends.select(id)
}
</script>

<template>
  <div class="bg-slate-800/60 rounded-2xl border border-slate-700/40 flex flex-col flex-shrink-0 min-h-0" :class="open ? 'max-h-[15rem]' : ''">
    <!-- cabeçalho: clica para expandir / minimizar -->
    <button
      :class="['w-full px-4 py-2.5 flex items-center gap-2 text-left flex-shrink-0', open ? 'border-b border-slate-700/40' : '']"
      :title="open ? 'Minimizar amigos' : 'Mostrar todos os amigos'"
      @click="open = !open"
    >
      <span class="text-xs text-slate-500 uppercase tracking-wide">Amigos</span>
      <span class="text-[11px] text-slate-500">{{ friends.onlineCount }}/{{ friends.friends.length }} online</span>
      <span class="text-[9px] tracking-wide text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded px-1 uppercase">beta</span>
      <span
        v-if="friends.unreadTotal"
        class="min-w-4 h-4 px-1 rounded-full bg-amber-500 text-[10px] font-semibold text-slate-900 flex items-center justify-center"
      >{{ friends.unreadTotal }}</span>
      <svg :class="['ml-auto w-4 h-4 text-slate-500 transition-transform', open ? '' : 'rotate-180']" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
      </svg>
    </button>

    <!-- chamando um amigo agora: dá para cancelar daqui mesmo com a conversa fechada -->
    <div v-if="friends.outgoingCall" class="mx-3 mb-2 px-2.5 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center gap-2">
      <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse flex-shrink-0" />
      <span class="flex-1 min-w-0 truncate text-[11px] text-emerald-200">
        {{ friends.outgoingCall.phase === 'opening' ? `Abrindo uma sala para você e ${friends.outgoingCall.name}…` : `Chamando ${friends.outgoingCall.name}…` }}
      </span>
      <button class="px-2 py-0.5 rounded-md text-[11px] font-medium text-white bg-red-600 hover:bg-red-500 transition-colors" @click="cancelCall('card de amigos da chamada')">
        Cancelar
      </button>
    </div>

    <!-- minimizado: avatares de quem está online (clicar abre a conversa) -->
    <div v-if="!open && onlineFriends.length" class="px-3 pb-2.5 -mt-1 flex items-center gap-1.5">
      <button
        v-for="f in onlineFriends.slice(0, MAX_AVATARS)"
        :key="f.id"
        class="relative flex-shrink-0"
        :title="`${f.name}: ${inMyCall(f) ? 'nesta chamada' : statusText(f)} (clique para conversar)`"
        @click="openChat(f.id, 'avatar do card minimizado')"
      >
        <span :class="['w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-semibold text-white', avatarColor(f.name)]">{{ initials(f.name) }}</span>
        <span :class="['absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-slate-800', STATE_DOT[f.state]]" />
        <span
          v-if="f.unread"
          class="absolute -top-1 -right-1 min-w-3.5 h-3.5 px-0.5 rounded-full bg-amber-500 text-[9px] font-semibold text-slate-900 flex items-center justify-center"
        >{{ f.unread }}</span>
      </button>
      <button
        v-if="onlineFriends.length > MAX_AVATARS"
        class="text-[11px] text-slate-400 hover:text-slate-200 px-1"
        title="Mostrar todos"
        @click="open = true"
      >+{{ onlineFriends.length - MAX_AVATARS }}</button>
    </div>
    <p v-else-if="!open" class="px-4 pb-2.5 -mt-1 text-[11px] text-slate-600">
      {{ friends.friends.length ? 'Nenhum amigo online agora' : 'Adicione amigos pelo ícone ao lado do nome de um participante' }}
    </p>

    <!-- expandido: lista inteira, com rolagem -->
    <ul v-if="open && friends.friends.length" class="flex-1 overflow-y-auto p-2 flex flex-col gap-1 min-h-0">
      <li v-for="f in friends.friends" :key="f.id">
        <button
          :class="[
            'w-full flex items-center gap-3 px-2 py-1.5 rounded-xl text-left transition-colors',
            friends.callChatOpen && friends.selectedId === f.id ? 'bg-indigo-600/20 ring-1 ring-indigo-500/40' : 'hover:bg-slate-700/30'
          ]"
          :title="`Conversar com ${f.name}`"
          @click="openChat(f.id, 'card expandido')"
        >
          <span class="relative flex-shrink-0">
            <span :class="['w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-semibold text-white', avatarColor(f.name), f.state === 'offline' ? 'opacity-50' : '']">{{
              initials(f.name)
            }}</span>
            <span :class="['absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full ring-2 ring-slate-800', STATE_DOT[f.state]]" />
          </span>
          <span class="flex flex-col min-w-0 flex-1">
            <span class="text-sm text-slate-100 truncate">{{ f.name }}</span>
            <span class="text-[11px] text-slate-500 truncate">{{ inMyCall(f) ? 'nesta chamada' : statusText(f) }}</span>
          </span>
          <span
            v-if="f.unread"
            class="flex-shrink-0 min-w-5 h-5 px-1.5 rounded-full bg-amber-500 text-[11px] font-semibold text-slate-900 flex items-center justify-center"
          >{{ f.unread }}</span>
        </button>
      </li>
    </ul>
    <p v-else-if="open" class="text-xs text-slate-600 text-center px-4 py-3">
      Nenhum amigo ainda: clique no ícone ao lado do nome de um participante para adicionar
    </p>
  </div>
</template>
