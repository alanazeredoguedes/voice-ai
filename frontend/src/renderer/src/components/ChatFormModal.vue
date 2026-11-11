<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { Chat } from '../types'
import { generateSystemPrompt } from '../api'
import VoiceNoteModal from './VoiceNoteModal.vue'

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
// system prompt criado ou ajustado pela IA (o texto de antes fica guardado para "Desfazer")
// altura do campo do prompt: começa pela metade e dobra quando a IA escreve (ou se o prompt já era grande)
const promptRows = ref(7)
const aiOpen = ref(false)
const aiAdjust = ref(false)
const beforeAi = ref<string | null>(null)
const aiNote = ref(false)
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
    aiOpen.value = false
    beforeAi.value = null
    aiNote.value = false
    if (props.mode === 'edit' && props.chat) {
      name.value = props.chat.name
      prompt.value = props.chat.system_prompt || ''
      showPrompt.value = true
      promptRows.value = prompt.value.length > 500 ? 14 : 7
    } else {
      name.value = props.defaultName ?? 'Novo chat'
      prompt.value = ''
      showPrompt.value = true // o novo chat já abre com o system prompt visível (é opcional)
      promptRows.value = 7
    }
    await nextTick()
    nameEl.value?.focus()
    nameEl.value?.select()
  }
)

/** abre o modal de voz: `adjust` = pedir ajustes no prompt que já está no campo; senão, criar um novo */
function openAi(adjust: boolean): void {
  aiAdjust.value = adjust && !!prompt.value.trim()
  showPrompt.value = true
  aiOpen.value = true
}

async function runGenerate(description: string, signal: AbortSignal): Promise<void> {
  const before = prompt.value
  const result = await generateSystemPrompt(description, aiAdjust.value ? before : '', signal)
  beforeAi.value = before.trim() ? before : null
  prompt.value = result
  promptRows.value = 14
  aiNote.value = true
}

async function onAiDone(): Promise<void> {
  aiOpen.value = false
  await nextTick()
  promptEl.value?.focus()
  promptEl.value?.setSelectionRange(0, 0)
  if (promptEl.value) promptEl.value.scrollTop = 0
}

function undoAi(): void {
  if (beforeAi.value !== null) prompt.value = beforeAi.value
  beforeAi.value = null
  aiNote.value = false
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

// Há algo digitado ou mudado? Então clicar fora (ou Esc) NÃO fecha: o modal pisca para avisar.
// Só Cancelar ou o X fecham. O nome que já vem preenchido por padrão não conta.
const dirty = computed(() => {
  if (props.mode === 'edit' && props.chat) {
    return name.value.trim() !== props.chat.name.trim() || prompt.value.trim() !== (props.chat.system_prompt || '').trim()
  }
  return name.value.trim() !== (props.defaultName ?? 'Novo chat').trim() || prompt.value.trim() !== ''
})
const pulsing = ref(false)
const warn = ref(false)
let pulseTimer: ReturnType<typeof setTimeout> | null = null
let warnTimer: ReturnType<typeof setTimeout> | null = null

function pulse(): void {
  pulsing.value = false
  void nextTick(() => {
    pulsing.value = true
  })
  warn.value = true
  if (pulseTimer) clearTimeout(pulseTimer)
  if (warnTimer) clearTimeout(warnTimer)
  pulseTimer = setTimeout(() => (pulsing.value = false), 800)
  warnTimer = setTimeout(() => (warn.value = false), 3500)
}

// o clique só fecha se o botão também foi apertado no fundo (arrastar para fora ao selecionar texto não conta)
let downOnBackdrop = false
function onBackdropDown(e: MouseEvent): void {
  downOnBackdrop = e.target === e.currentTarget
}
function onBackdropClick(): void {
  if (!downOnBackdrop) return
  downOnBackdrop = false
  if (dirty.value) pulse()
  else emit('close')
}

function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  if (dirty.value) pulse()
  else emit('close')
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-6"
      @mousedown="onBackdropDown"
      @click.self="onBackdropClick"
      @keydown="onKey"
    >
      <div
        :class="['w-full max-w-3xl max-h-[92vh] overflow-y-auto bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl p-6 flex flex-col gap-4', pulsing ? 'modal-pulse' : '']"
      >
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
            :rows="promptRows"
            placeholder="Ex.: Você é um especialista no jogo Zelda Tears of the Kingdom. Responda em português, de forma curta..."
            class="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-y max-h-[50vh]"
            @keydown="onPromptKey"
          />
          <!-- a IA escreve (ou ajusta) o prompt a partir do que você falar -->
          <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <button
              class="flex items-center gap-1.5 text-xs font-medium text-indigo-400 hover:text-indigo-300 transition-colors"
              title="Fale ou digite o que você precisa e a IA escreve o system prompt"
              @click="openAi(false)"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z" /></svg>
              {{ prompt.trim() ? 'Criar outro com a IA' : 'Pedir o system prompt para a IA' }}
            </button>
            <button
              v-if="prompt.trim()"
              class="text-xs font-medium text-indigo-400 hover:text-indigo-300 transition-colors"
              title="Diga o que mudar neste prompt (ex.: mais curto, focar em itens)"
              @click="openAi(true)"
            >Pedir ajustes à IA</button>
            <button v-if="beforeAi !== null" class="text-xs text-slate-500 hover:text-slate-300 underline underline-offset-2" @click="undoAi">Desfazer</button>
          </div>
          <p v-if="aiNote" class="text-xs text-emerald-400/90">Prompt escrito pela IA. Leia, edite se quiser e salve.</p>
          <p class="text-xs text-slate-500">
            Deixe vazio para usar o padrão do app (respostas curtas, em português, próprias para voz).
            A data e a hora atuais são adicionadas automaticamente.
          </p>
          <p v-if="promptChanged && (chat?.message_count ?? 0) > 0" class="text-xs text-amber-300/90">
            Ao mudar o prompt, a IA recomeça a conversa com o prompt novo, levando as últimas mensagens deste chat
            para não perder o contexto.
          </p>
        </div>

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

        <div class="flex items-center justify-end gap-2">
          <span v-if="warn" class="mr-auto text-xs text-amber-300">
            Você preencheu algo aqui. Salve, ou use Cancelar para sair sem salvar.
          </span>
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

  <!-- fala (ou digita) o que quer; a IA devolve o system prompt para o campo -->
  <VoiceNoteModal
    v-if="aiOpen"
    :title="aiAdjust ? 'Fale os ajustes que você quer neste prompt' : 'Fale como você quer o novo system prompt'"
    :text-label="aiAdjust ? 'Ajustes que vou pedir à IA' : 'O que o novo system prompt deve conter'"
    :placeholder="aiAdjust
      ? 'Ex.: mais curto; foque nos itens e nas mecânicas; peça para sempre dizer a versão do jogo'
      : 'Ex.: um especialista em Zelda Ocarina of Time Remake que me ajuda com mecânicas e itens enquanto eu jogo'"
    action-label="Gerar system prompt"
    busy-label="A IA está escrevendo o system prompt…"
    :run="runGenerate"
    @done="onAiDone"
    @close="aiOpen = false"
  />
</template>

<style scoped>
/* modal "travado": pisca e dá um leve zoom para mostrar que tem coisa preenchida e que não fecha clicando fora */
.modal-pulse {
  animation: modal-pulse 0.7s ease-out;
}
@keyframes modal-pulse {
  0% { transform: scale(1); box-shadow: 0 0 0 0 rgb(129 140 248 / 0.7); border-color: rgb(129 140 248); }
  35% { transform: scale(1.03); box-shadow: 0 0 0 8px rgb(129 140 248 / 0.35); border-color: rgb(129 140 248); }
  100% { transform: scale(1); box-shadow: 0 0 0 0 rgb(129 140 248 / 0); }
}
</style>
