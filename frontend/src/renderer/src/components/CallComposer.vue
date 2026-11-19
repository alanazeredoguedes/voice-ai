<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useCallStore } from '../stores/call'

/**
 * Caixa de mensagem do chat da chamada (no estilo do Discord): cresce conforme o texto, aceita
 * arquivos colados (ex.: print da tela), arrastados ou escolhidos, e mostra as prévias antes de enviar.
 */
const props = defineProps<{ editing: { id: string; text: string } | null }>()
const emit = defineEmits<{ send: [text: string, files: File[]]; save: [id: string, text: string]; cancel: [] }>()

interface Attachment {
  key: string
  file: File
  url: string | null
}

const store = useCallStore()
const text = ref('')
const attachments = ref<Attachment[]>([])
const box = ref<HTMLTextAreaElement | null>(null)
const picker = ref<HTMLInputElement | null>(null)

const canSend = computed(() => !!text.value.trim() || (!props.editing && attachments.value.length > 0))

watch(
  () => props.editing,
  async (e) => {
    text.value = e ? e.text : ''
    await nextTick()
    autosize()
    if (e) {
      box.value?.focus()
      box.value?.setSelectionRange(text.value.length, text.value.length)
    }
  }
)

function autosize(): void {
  const el = box.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 240)}px`
}

/**
 * Adiciona arquivos (do clipe, de um arrastar ou colados). O conteúdo é lido na hora: o navegador guarda só
 * uma "referência" ao arquivo do disco e se recusa a lê-lo se ele mudar depois de escolhido (ex.: um log que
 * continua sendo escrito), o que fazia o envio falhar com "could not be read".
 */
async function addFiles(files: File[]): Promise<void> {
  if (props.editing) return
  for (const original of files) {
    let file: File
    try {
      file = new File([await original.arrayBuffer()], original.name, { type: original.type, lastModified: original.lastModified })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      store.log('error', `não deu para ler "${original.name}" (${Math.round(original.size / 1024)} KB) ao anexar: ${msg}`)
      store.error = `Não deu para ler "${original.name}". Se ele ainda está sendo gravado ou foi alterado, tente anexar de novo.`
      continue
    }
    store.log('info', `anexado "${file.name}" (${Math.max(1, Math.round(file.size / 1024))} KB, ${file.type || 'tipo desconhecido'})`)
    const previewable = file.type.startsWith('image/') || file.type.startsWith('video/')
    attachments.value.push({ key: crypto.randomUUID(), file, url: previewable ? URL.createObjectURL(file) : null })
  }
  box.value?.focus()
}

function remove(key: string): void {
  const a = attachments.value.find((x) => x.key === key)
  if (a?.url) URL.revokeObjectURL(a.url)
  attachments.value = attachments.value.filter((x) => x.key !== key)
}

function onPaste(e: ClipboardEvent): void {
  const files = Array.from(e.clipboardData?.files ?? [])
  if (!files.length) return
  e.preventDefault()
  // print colado vem sem nome útil ("image.png"): dá um nome com a hora
  void addFiles(
    files.map((f) =>
      f.name && f.name !== 'image.png'
        ? f
        : new File([f], `captura-${new Date().toLocaleTimeString('pt-BR').replace(/:/g, '-')}.png`, { type: f.type })
    )
  )
}

function onPick(e: Event): void {
  const input = e.target as HTMLInputElement
  void addFiles(Array.from(input.files ?? []))
  input.value = ''
}

function submit(): void {
  if (!canSend.value) return
  if (props.editing) {
    emit('save', props.editing.id, text.value.trim())
  } else {
    emit('send', text.value.trim(), attachments.value.map((a) => a.file))
    for (const a of attachments.value) if (a.url) URL.revokeObjectURL(a.url)
    attachments.value = []
  }
  text.value = ''
  void nextTick(autosize)
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    submit()
  } else if (e.key === 'Escape' && props.editing) {
    emit('cancel')
  }
}

function fmtSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

onUnmounted(() => {
  for (const a of attachments.value) if (a.url) URL.revokeObjectURL(a.url)
})

defineExpose({ addFiles })
</script>

<template>
  <div class="rounded-xl bg-slate-900/60 border border-slate-700/60 focus-within:border-indigo-500/60 transition-colors">
    <div v-if="editing" class="flex items-center gap-2 px-3.5 pt-2.5 text-xs text-indigo-300">
      <span class="flex-1">Editando mensagem</span>
      <button class="text-slate-400 hover:text-slate-200 transition-colors" @click="emit('cancel')">Cancelar (Esc)</button>
    </div>

    <!-- anexos ainda não enviados -->
    <div v-if="attachments.length" class="flex gap-3 px-3 pt-3 overflow-x-auto">
      <div
        v-for="a in attachments"
        :key="a.key"
        class="relative flex-shrink-0 w-40 rounded-lg bg-slate-800 border border-slate-700/60 p-2 flex flex-col gap-1.5"
      >
        <div class="w-full h-24 rounded-md bg-slate-950 overflow-hidden flex items-center justify-center">
          <img v-if="a.url && a.file.type.startsWith('image/')" :src="a.url" class="w-full h-full object-cover" />
          <video v-else-if="a.url" :src="a.url" muted class="w-full h-full object-cover" />
          <svg v-else class="w-8 h-8 text-slate-500" fill="none" stroke="currentColor" stroke-width="1.3" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
          </svg>
        </div>
        <p class="text-[11px] text-slate-300 truncate" :title="a.file.name">{{ a.file.name }}</p>
        <p class="text-[10px] text-slate-500 -mt-1">{{ fmtSize(a.file.size) }}</p>
        <button
          class="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-slate-700 hover:bg-red-600 text-slate-200 flex items-center justify-center shadow transition-colors"
          title="Remover"
          @click="remove(a.key)"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>

    <div class="flex items-end gap-1 p-1.5">
      <input ref="picker" type="file" multiple class="hidden" @change="onPick" />
      <button
        v-if="!editing"
        class="p-2 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-700/60 transition-colors"
        title="Anexar arquivos (também dá para colar ou arrastar)"
        @click="picker?.click()"
      >
        <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
        </svg>
      </button>
      <textarea
        ref="box"
        v-model="text"
        rows="1"
        :placeholder="editing ? 'Edite a mensagem…' : 'Escreva uma mensagem…'"
        class="flex-1 min-w-0 bg-transparent px-2 py-2 text-sm text-slate-100 placeholder-slate-600 leading-relaxed resize-none focus:outline-none max-h-60"
        @input="autosize"
        @keydown="onKeydown"
        @paste="onPaste"
      />
      <button
        :disabled="!canSend"
        class="p-2 rounded-lg text-white bg-indigo-600 hover:bg-indigo-500 transition-colors disabled:opacity-30 disabled:bg-transparent disabled:text-slate-500"
        :title="editing ? 'Salvar (Enter)' : 'Enviar (Enter) · Shift+Enter quebra a linha'"
        @click="submit"
      >
        <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
          <path v-if="editing" stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />
          <path v-else stroke-linecap="round" stroke-linejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
        </svg>
      </button>
    </div>
  </div>
</template>
