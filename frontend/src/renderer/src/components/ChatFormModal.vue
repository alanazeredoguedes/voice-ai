<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { Chat } from '../types'

/**
 * Criar chat (mode "new") ou configurar um existente (mode "edit"): nome + system prompt próprio.
 * No modo edição também tem "Limpar mensagens" e "Excluir chat" (a confirmação fica com quem abriu).
 */
const props = defineProps<{
  open: boolean
  mode: 'new' | 'edit'
  chat?: Chat | null
  defaultName?: string
  busy?: boolean
  /** limite dos áudios salvos por chat (MB), das Configurações */
  audioLimitMb?: number
}>()
const emit = defineEmits<{
  close: []
  save: [data: { name: string; system_prompt: string }]
  clear: [chat: Chat]
  delete: [chat: Chat]
  clearAudio: [chat: Chat]
}>()

function fmtMb(bytes?: number): string {
  const mb = (bytes ?? 0) / 1024 / 1024
  return mb < 0.1 && bytes ? '< 0,1 MB' : `${mb.toFixed(1).replace('.', ',')} MB`
}

const name = ref('')
const prompt = ref('')
const showPrompt = ref(false)
const saving = ref(false)
const nameEl = ref<HTMLInputElement | null>(null)
const promptEl = ref<HTMLTextAreaElement | null>(null)

const promptChanged = computed(
  () => props.mode === 'edit' && !!props.chat && prompt.value.trim() !== (props.chat.system_prompt || '').trim()
)

watch(
  () => props.open,
  async (v) => {
    if (!v) return
    saving.value = false
    if (props.mode === 'edit' && props.chat) {
      name.value = props.chat.name
      prompt.value = props.chat.system_prompt || ''
      showPrompt.value = true
    } else {
      name.value = props.defaultName ?? 'Novo chat'
      prompt.value = ''
      showPrompt.value = false
    }
    await nextTick()
    nameEl.value?.focus()
    nameEl.value?.select()
  }
)

async function addPrompt(): Promise<void> {
  showPrompt.value = true
  await nextTick()
  promptEl.value?.focus()
}

function save(): void {
  if (saving.value) return
  saving.value = true
  emit('save', { name: name.value.trim() || (props.mode === 'new' ? 'Novo chat' : 'Sem nome'), system_prompt: prompt.value.trim() })
}

function onNameKey(e: KeyboardEvent): void {
  if (e.key === 'Enter') {
    e.preventDefault()
    save()
  }
}

function onPromptKey(e: KeyboardEvent): void {
  // Ctrl+Enter salva (Enter sozinho quebra linha no prompt)
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    save()
  }
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close')
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-6"
      @click.self="emit('close')"
      @keydown="onKey"
    >
      <div class="w-full max-w-lg bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl p-5 flex flex-col gap-4">
        <div class="flex items-center justify-between">
          <h3 class="text-base font-semibold text-slate-100">{{ mode === 'new' ? 'Novo chat' : 'Configurar chat' }}</h3>
          <button class="p-1 rounded-md text-slate-500 hover:text-slate-200 hover:bg-slate-800" title="Fechar" @click="emit('close')">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <label class="flex flex-col gap-1.5">
          <span class="text-xs text-slate-400">Nome do chat</span>
          <input
            ref="nameEl"
            v-model="name"
            maxlength="80"
            placeholder="Ex.: Zelda TOTK, Estudos, Trabalho"
            class="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            @keydown="onNameKey"
          />
        </label>

        <div v-if="showPrompt" class="flex flex-col gap-1.5">
          <div class="flex items-center justify-between">
            <span class="text-xs text-slate-400">System prompt deste chat</span>
            <span class="text-[11px] text-slate-600">opcional</span>
          </div>
          <textarea
            ref="promptEl"
            v-model="prompt"
            rows="7"
            placeholder="Ex.: Você é um especialista no jogo Zelda Tears of the Kingdom. Responda em português, de forma curta..."
            class="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-y"
            @keydown="onPromptKey"
          />
          <p class="text-xs text-slate-500">
            Deixe vazio para usar o padrão do app (respostas curtas, em português, próprias para voz).
            A data e a hora atuais são adicionadas automaticamente.
          </p>
          <p v-if="promptChanged && (chat?.message_count ?? 0) > 0" class="text-xs text-amber-300/90">
            Ao mudar o prompt, a IA recomeça a conversa com o prompt novo, levando as últimas mensagens deste chat
            para não perder o contexto.
          </p>
        </div>
        <button
          v-else
          class="self-start text-xs font-medium text-indigo-400 hover:text-indigo-300 transition-colors"
          @click="addPrompt"
        >
          + Adicionar system prompt
        </button>

        <!-- Áudios salvos das respostas deste chat (só na edição) -->
        <div v-if="mode === 'edit' && chat" class="flex flex-col gap-2 pt-3 border-t border-slate-800">
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              <p class="text-xs text-slate-300">Áudios salvos das respostas</p>
              <p class="text-[11px] text-slate-500 mt-0.5">
                As falas ficam guardadas para o "ouvir de novo" ser instantâneo. Limite deste chat:
                {{ audioLimitMb ?? 20 }} MB (as mais antigas saem primeiro).
              </p>
            </div>
            <span class="text-sm font-semibold text-slate-100 tabular-nums whitespace-nowrap">{{ fmtMb(chat.audio_bytes) }}</span>
          </div>
          <div class="h-1.5 rounded-full bg-slate-800 overflow-hidden">
            <div
              class="h-full bg-indigo-500"
              :style="{ width: `${Math.min(100, ((chat.audio_bytes ?? 0) / ((audioLimitMb ?? 20) * 1024 * 1024)) * 100)}%` }"
            />
          </div>
          <button
            :disabled="!chat.audio_bytes"
            class="self-start px-3 py-1.5 rounded-lg text-xs border border-slate-700 hover:border-slate-500 text-slate-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            @click="emit('clearAudio', chat)"
          >Apagar áudios salvos</button>
        </div>

        <!-- Ações do chat (só na edição) -->
        <div v-if="mode === 'edit' && chat" class="flex flex-wrap gap-2 pt-3 border-t border-slate-800">
          <button
            :disabled="busy || !(chat.message_count ?? 0)"
            title="Apaga as mensagens e começa a conversa do zero, mantendo nome e prompt"
            class="px-3 py-1.5 rounded-lg text-xs border border-slate-700 hover:border-slate-500 text-slate-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            @click="emit('clear', chat)"
          >Limpar mensagens</button>
          <button
            :disabled="busy"
            class="px-3 py-1.5 rounded-lg text-xs border border-red-800/60 hover:border-red-600 text-red-400 hover:text-red-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            @click="emit('delete', chat)"
          >Excluir chat</button>
          <span v-if="busy" class="text-[11px] text-slate-500 self-center">Aguarde a resposta terminar</span>
        </div>

        <div class="flex justify-end gap-2">
          <button
            class="px-3.5 py-2 rounded-lg text-xs border border-slate-700 hover:border-slate-500 text-slate-300 transition-colors"
            @click="emit('close')"
          >Cancelar</button>
          <button
            :disabled="saving"
            class="px-3.5 py-2 rounded-lg text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-60"
            @click="save"
          >{{ mode === 'new' ? 'Criar chat' : 'Salvar' }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
