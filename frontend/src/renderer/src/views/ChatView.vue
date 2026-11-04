<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useChatStore } from '../stores/chat'
import { onWsMessage } from '../api/ws'
import { getTtsMuted, getTtsVolume, replaySpeech, setTtsMuted, setTtsVolume } from '../api'
import CopyButton from '../components/CopyButton.vue'

const store = useChatStore()
const input = ref('')
const messagesEl = ref<HTMLElement | null>(null)
const textareaEl = ref<HTMLTextAreaElement | null>(null)
const ttsMuted = ref(false)
const ttsVolume = ref(1.0)
const confirmClear = ref(false)
const confirmDeleteId = ref<number | null>(null)

const unsub = onWsMessage((event) => {
  if (event.type === 'chat_chunk') {
    store.onChunk(event.text ?? '', event.done ?? false, event.message_id, event.user_message_id)
    scrollToBottom()
  } else if (event.type === 'chat_error') {
    store.onError(event.error ?? 'Erro desconhecido')
  } else if (event.type === 'voice_user_message' && event.text) {
    store.onVoiceUserMessage(event.text)
    scrollToBottom()
  } else if (event.type === 'voice_chat_cancelled') {
    store.onVoiceCancelled()
  }
})

onMounted(async () => {
  await store.loadHistory()
  scrollToBottom()
  try {
    ttsMuted.value = await getTtsMuted()
    ttsVolume.value = await getTtsVolume()
  } catch {
    // backend pode não estar disponível ainda
  }
})

onUnmounted(() => unsub())

async function toggleMute(): Promise<void> {
  const next = !ttsMuted.value
  ttsMuted.value = next
  try {
    await setTtsMuted(next)
  } catch {
    ttsMuted.value = !next
  }
}

async function onVolumeChange(e: Event): Promise<void> {
  const v = Number((e.target as HTMLInputElement).value) / 100
  ttsVolume.value = v
  try {
    await setTtsVolume(v)
  } catch {
    // silencioso
  }
}

watch(() => store.messages.length, () => {
  nextTick(scrollToBottom)
})

function scrollToBottom(): void {
  nextTick(() => {
    if (messagesEl.value) {
      messagesEl.value.scrollTop = messagesEl.value.scrollHeight
    }
  })
}

async function send(): Promise<void> {
  const text = input.value.trim()
  if (!text || store.streaming) return
  input.value = ''
  autoResize()
  await store.sendMessage(text)
  scrollToBottom()
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
}

function autoResize(): void {
  if (!textareaEl.value) return
  textareaEl.value.style.height = 'auto'
  textareaEl.value.style.height = Math.min(textareaEl.value.scrollHeight, 160) + 'px'
}

async function replay(text: string): Promise<void> {
  try {
    await replaySpeech(text)
  } catch {
    // silencioso - TTS pode estar mudo ou ocupado
  }
}

async function confirmDelete(id: number): Promise<void> {
  await store.deleteMessage(id)
  confirmDeleteId.value = null
}
</script>

<template>
  <div class="flex flex-col h-full gap-0">
    <!-- Cabeçalho -->
    <div class="flex items-center justify-between mb-4 flex-shrink-0">
      <div>
        <h1 class="text-xl font-semibold text-slate-100">Chat IA</h1>
        <p class="text-sm text-slate-500 mt-0.5">Conversa com Claude via texto ou voz</p>
      </div>
      <div class="flex items-center gap-2">
        <!-- Volume slider + Mute TTS -->
        <div class="flex items-center gap-1.5">
          <button
            :title="ttsMuted ? 'IA muda (clique para ativar voz)' : 'IA falando (clique para mutar)'"
            :class="[
              'p-1.5 rounded-lg border transition-colors flex-shrink-0',
              ttsMuted
                ? 'text-slate-500 border-slate-700 hover:text-slate-300 hover:border-slate-500'
                : 'text-indigo-400 border-indigo-700/50 hover:text-indigo-300 hover:border-indigo-500'
            ]"
            @click="toggleMute"
          >
            <svg v-if="!ttsMuted" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
            </svg>
            <svg v-else class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M17.25 9.75L19.5 12m0 0l2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-10.5-6l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
            </svg>
          </button>
          <input
            v-if="!ttsMuted"
            type="range"
            min="0"
            max="150"
            :value="Math.round(ttsVolume * 100)"
            title="Volume da voz"
            class="w-20 h-1 accent-indigo-500 cursor-pointer"
            @change="onVolumeChange"
          />
          <span v-if="!ttsMuted" class="text-xs text-slate-500 w-7 text-right tabular-nums">{{ Math.round(ttsVolume * 100) }}%</span>
        </div>

        <!-- Limpar histórico com confirmação -->
        <template v-if="store.messages.length > 0">
          <template v-if="!confirmClear">
            <button
              class="text-xs text-slate-400 hover:text-red-400 border border-slate-700 hover:border-red-700/60 rounded-lg px-3 py-1.5 transition-colors"
              @click="confirmClear = true"
            >
              Limpar
            </button>
          </template>
          <template v-else>
            <button
              class="text-xs text-red-400 border border-red-700/60 rounded-lg px-3 py-1.5 transition-colors"
              @click="store.clearHistory(); confirmClear = false"
            >
              Confirmar
            </button>
            <button
              class="text-xs text-slate-400 border border-slate-700 rounded-lg px-3 py-1.5 transition-colors"
              @click="confirmClear = false"
            >
              Cancelar
            </button>
          </template>
        </template>
      </div>
    </div>

    <!-- Área de mensagens -->
    <div ref="messagesEl" class="flex-1 overflow-y-auto flex flex-col gap-3 min-h-0 pr-1">
      <!-- Estado vazio -->
      <div v-if="store.messages.length === 0" class="flex flex-col items-center justify-center h-full gap-3 text-center">
        <div class="w-12 h-12 rounded-2xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center">
          <svg class="w-6 h-6 text-purple-400" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
          </svg>
        </div>
        <div>
          <p class="text-slate-400 text-sm font-medium">Nenhuma conversa ainda</p>
          <p class="text-slate-600 text-xs mt-0.5">Digite uma mensagem abaixo para começar</p>
        </div>
      </div>

      <!-- Mensagens -->
      <template v-for="(msg, i) in store.messages" :key="i">

        <!-- Mensagem do usuário -->
        <div v-if="msg.role === 'user'" class="flex justify-end group">
          <div class="max-w-[80%]">
            <div class="bg-indigo-600/80 border border-indigo-500/30 rounded-2xl rounded-tr-sm px-4 py-2.5">
              <p class="text-slate-100 text-sm leading-relaxed whitespace-pre-wrap">{{ msg.content }}</p>
            </div>
            <!-- Ações abaixo do card -->
            <div class="flex justify-end items-center gap-1 mt-1 h-5 opacity-0 group-hover:opacity-100 transition-opacity">
              <template v-if="msg.id !== undefined && confirmDeleteId === msg.id">
                <span class="text-xs text-slate-500 mr-1">Apagar?</span>
                <button
                  class="text-xs text-red-400 hover:text-red-300 transition-colors"
                  @click="confirmDelete(msg.id!)"
                >Sim</button>
                <span class="text-slate-600 text-xs">/</span>
                <button
                  class="text-xs text-slate-400 hover:text-slate-200 transition-colors"
                  @click="confirmDeleteId = null"
                >Não</button>
              </template>
              <template v-else>
                <CopyButton :text="msg.content" />
                <button
                  v-if="msg.id !== undefined"
                  title="Apagar mensagem"
                  class="p-1 rounded text-slate-500 hover:text-red-400 transition-colors"
                  @click="confirmDeleteId = msg.id!"
                >
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </template>
            </div>
          </div>
        </div>

        <!-- Mensagem do assistente -->
        <div v-else class="flex justify-start gap-2.5 group">
          <div class="w-7 h-7 rounded-full bg-purple-500/20 border border-purple-500/30 flex-shrink-0 flex items-center justify-center mt-0.5">
            <svg class="w-3.5 h-3.5 text-purple-400" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/>
            </svg>
          </div>
          <div class="max-w-[80%] flex flex-col">
            <div class="bg-slate-800/60 border border-slate-700/40 rounded-2xl rounded-tl-sm px-4 py-2.5">
              <!-- Texto cancelado -->
              <p v-if="msg.content === '_(cancelado)_'" class="text-slate-500 text-sm italic">cancelado</p>
              <!-- Conteúdo normal -->
              <p v-else-if="msg.content" class="text-slate-200 text-sm leading-relaxed whitespace-pre-wrap">{{ msg.content }}<span v-if="msg.streaming" class="inline-block w-1.5 h-3.5 bg-purple-400 ml-0.5 animate-pulse rounded-sm" /></p>
              <!-- Loading inicial -->
              <div v-else class="flex gap-1 py-0.5">
                <span v-for="n in 3" :key="n" class="w-1.5 h-1.5 rounded-full bg-slate-500 animate-bounce" :style="`animation-delay:${(n-1)*0.15}s`" />
              </div>
            </div>
            <!-- Ações abaixo do card (apenas após concluir e não cancelado) -->
            <div
              v-if="msg.content && !msg.streaming && msg.content !== '_(cancelado)_'"
              class="flex items-center gap-1 mt-1 h-5 opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <template v-if="msg.id !== undefined && confirmDeleteId === msg.id">
                <span class="text-xs text-slate-500 mr-1">Apagar?</span>
                <button
                  class="text-xs text-red-400 hover:text-red-300 transition-colors"
                  @click="confirmDelete(msg.id!)"
                >Sim</button>
                <span class="text-slate-600 text-xs">/</span>
                <button
                  class="text-xs text-slate-400 hover:text-slate-200 transition-colors"
                  @click="confirmDeleteId = null"
                >Não</button>
              </template>
              <template v-else>
                <CopyButton :text="msg.content" />
                <button
                  title="Falar novamente"
                  class="p-1 rounded text-slate-500 hover:text-indigo-400 transition-colors"
                  @click="replay(msg.content)"
                >
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
                  </svg>
                </button>
                <button
                  v-if="msg.id !== undefined"
                  title="Apagar mensagem"
                  class="p-1 rounded text-slate-500 hover:text-red-400 transition-colors"
                  @click="confirmDeleteId = msg.id!"
                >
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </template>
            </div>
          </div>
        </div>

      </template>
    </div>

    <!-- Erro -->
    <div v-if="store.error" class="flex-shrink-0 mt-2 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2 flex items-center gap-2">
      <svg class="w-4 h-4 text-red-400 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
      </svg>
      <p class="text-red-400 text-xs flex-1">{{ store.error }}</p>
      <button class="text-red-500 hover:text-red-400 text-xs" @click="store.error = null">✕</button>
    </div>

    <!-- Input -->
    <div class="flex-shrink-0 mt-3 flex gap-2 items-end bg-slate-800/60 border border-slate-700/40 rounded-2xl px-3 py-2.5">
      <textarea
        ref="textareaEl"
        v-model="input"
        placeholder="Digite sua mensagem… (Enter para enviar, Shift+Enter para nova linha)"
        rows="1"
        class="flex-1 bg-transparent text-slate-200 text-sm leading-relaxed resize-none focus:outline-none placeholder-slate-600 min-h-[24px] max-h-40"
        @input="autoResize"
        @keydown="onKeydown"
      />
      <button
        :disabled="!input.trim() || store.streaming"
        class="flex-shrink-0 p-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
        @click="send"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
        </svg>
      </button>
    </div>
  </div>
</template>
