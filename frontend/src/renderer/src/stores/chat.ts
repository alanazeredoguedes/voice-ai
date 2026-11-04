import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ChatMessage } from '../types'
import { clearChatHistory, deleteChatMessage, getChatHistory, sendChatMessage } from '../api'

export const useChatStore = defineStore('chat', () => {
  const messages = ref<ChatMessage[]>([])
  const streaming = ref(false)
  const error = ref<string | null>(null)

  async function loadHistory(): Promise<void> {
    try {
      const history = await getChatHistory()
      messages.value = history.map(m => ({ ...m, streaming: false }))
    } catch (e) {
      console.error('[chat] erro ao carregar histórico:', e)
    }
  }

  async function sendMessage(text: string): Promise<void> {
    if (!text.trim() || streaming.value) return
    error.value = null

    messages.value.push({ role: 'user', content: text })
    messages.value.push({ role: 'assistant', content: '', streaming: true })
    streaming.value = true

    try {
      await sendChatMessage(text)
    } catch (e) {
      streaming.value = false
      messages.value.pop()
      error.value = e instanceof Error ? e.message : 'Erro ao enviar mensagem'
    }
  }

  function onChunk(text: string, done: boolean, messageId?: number, userMessageId?: number): void {
    const last = messages.value[messages.value.length - 1]
    if (!last || last.role !== 'assistant') return

    if (!done) {
      last.content += (last.content && text ? ' ' : '') + text
    } else {
      last.streaming = false
      if (messageId !== undefined) last.id = messageId
      streaming.value = false

      // Atribui ID à mensagem do usuário que precedeu esta resposta
      if (userMessageId !== undefined) {
        for (let i = messages.value.length - 2; i >= 0; i--) {
          if (messages.value[i].role === 'user' && messages.value[i].id === undefined) {
            messages.value[i].id = userMessageId
            break
          }
        }
      }
    }
  }

  function onError(msg: string): void {
    const last = messages.value[messages.value.length - 1]
    if (last?.streaming) {
      last.streaming = false
      last.content = last.content || '⚠ Erro ao obter resposta.'
    }
    streaming.value = false
    error.value = msg
  }

  function onVoiceUserMessage(text: string): void {
    messages.value.push({ role: 'user', content: text })
    messages.value.push({ role: 'assistant', content: '', streaming: true })
    streaming.value = true
  }

  function onVoiceCancelled(): void {
    const last = messages.value[messages.value.length - 1]
    if (last?.role === 'assistant' && last.streaming) {
      last.streaming = false
      last.content = last.content.trim() || '_(cancelado)_'
    }
    streaming.value = false
  }

  async function deleteMessage(id: number): Promise<void> {
    try {
      await deleteChatMessage(id)
      const idx = messages.value.findIndex(m => m.id === id)
      if (idx !== -1) messages.value.splice(idx, 1)
    } catch (e) {
      console.error('[chat] erro ao apagar mensagem:', e)
    }
  }

  async function clearHistory(): Promise<void> {
    await clearChatHistory()
    messages.value = []
    error.value = null
    streaming.value = false
  }

  return {
    messages,
    streaming,
    error,
    loadHistory,
    sendMessage,
    onChunk,
    onError,
    onVoiceUserMessage,
    onVoiceCancelled,
    deleteMessage,
    clearHistory,
  }
})
