<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { transcribeFile } from '../api'
import CopyButton from '../components/CopyButton.vue'
import { useTranscribeStore } from '../stores/transcribe'

const SUPPORTED = ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.webm', '.aac', '.mp4', '.opus', '.wma', '.oga']
const ACCEPT = SUPPORTED.join(',')

const store = useTranscribeStore()

const fileInput = ref<HTMLInputElement | null>(null)
const dragging = ref(false)
const selectedFiles = ref<File[]>([])
const loadingIndex = ref(-1)
const error = ref<string | null>(null)
const resultText = ref<string | null>(store.result?.text ?? null)
const resultStats = ref<{ duration_s: number; proc_s: number; model: string; device: string } | null>(
  store.result ? { duration_s: store.result.duration_s, proc_s: store.result.proc_s, model: store.result.model, device: store.result.device } : null
)

const isLoading = computed(() => loadingIndex.value >= 0)

onMounted(() => {
  if (store.result) {
    resultText.value = store.result.text
    resultStats.value = { duration_s: store.result.duration_s, proc_s: store.result.proc_s, model: store.result.model, device: store.result.device }
  }
})

function validateFile(file: File): string | null {
  const ext = '.' + file.name.split('.').pop()?.toLowerCase()
  if (!SUPPORTED.includes(ext)) return `Formato não suportado: ${file.name}`
  return null
}

function addFiles(files: FileList | File[]): void {
  error.value = null
  for (const file of Array.from(files)) {
    const err = validateFile(file)
    if (err) { error.value = err; return }
    if (!selectedFiles.value.find(f => f.name === file.name && f.size === file.size)) {
      selectedFiles.value.push(file)
    }
  }
}

function removeFile(index: number): void {
  selectedFiles.value.splice(index, 1)
}

function onDragOver(e: DragEvent): void {
  e.preventDefault()
  dragging.value = true
}

function onDragLeave(): void {
  dragging.value = false
}

function onDrop(e: DragEvent): void {
  e.preventDefault()
  dragging.value = false
  if (e.dataTransfer?.files) addFiles(e.dataTransfer.files)
}

function onFileChange(e: Event): void {
  const files = (e.target as HTMLInputElement).files
  if (files) addFiles(files)
  if (fileInput.value) fileInput.value.value = ''
}

async function doTranscribe(): Promise<void> {
  if (!selectedFiles.value.length) return
  error.value = null
  resultText.value = null
  resultStats.value = null

  const parts: string[] = []
  let totalDuration = 0
  let totalProc = 0
  let lastModel = ''
  let lastDevice = ''
  const names = selectedFiles.value.map(f => f.name)
  const multi = selectedFiles.value.length > 1

  for (let i = 0; i < selectedFiles.value.length; i++) {
    loadingIndex.value = i
    const file = selectedFiles.value[i]
    try {
      const r = await transcribeFile(file)
      totalDuration += r.duration_s
      totalProc += r.proc_s
      lastModel = r.model
      lastDevice = r.device
      parts.push(multi ? `[${file.name}]\n${r.text}` : r.text)
    } catch (e: unknown) {
      error.value = `Erro em "${file.name}": ${e instanceof Error ? e.message : 'erro desconhecido'}`
      loadingIndex.value = -1
      return
    }
  }

  loadingIndex.value = -1
  const combined = parts.join('\n\n---\n\n')
  resultText.value = combined
  resultStats.value = { duration_s: totalDuration, proc_s: totalProc, model: lastModel, device: lastDevice }

  const storeResult = { text: combined, duration_s: totalDuration, proc_s: totalProc, model: lastModel, device: lastDevice }
  store.setResult(storeResult, names)
}

function reset(): void {
  selectedFiles.value = []
  resultText.value = null
  resultStats.value = null
  error.value = null
  store.clear()
}

function fmtTime(s: number): string {
  if (s < 60) return `${s.toFixed(0)}s`
  const m = Math.floor(s / 60)
  const sec = Math.round(s % 60)
  return `${m}m ${sec}s`
}

function fmtSize(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}
</script>

<template>
  <div class="flex flex-col gap-6 h-full">
    <div>
      <h1 class="text-xl font-semibold text-slate-100">Transcrever Arquivo</h1>
      <p class="text-sm text-slate-500 mt-1">Transcreva MP3, OGG, WAV, M4A e outros formatos usando Whisper</p>
    </div>

    <!-- Drop zone (shown when no files selected and no result) -->
    <div
      v-if="!selectedFiles.length && !resultText"
      :class="[
        'border-2 border-dashed rounded-2xl p-12 flex flex-col items-center gap-4 transition-colors cursor-pointer',
        dragging
          ? 'border-indigo-500 bg-indigo-500/10'
          : 'border-slate-700 hover:border-slate-600 hover:bg-slate-800/30'
      ]"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
      @click="fileInput?.click()"
    >
      <div class="w-14 h-14 rounded-full bg-slate-800 flex items-center justify-center">
        <svg class="w-7 h-7 text-slate-400" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
        </svg>
      </div>
      <div class="text-center">
        <p class="text-slate-300 font-medium">Arraste arquivos de áudio ou clique para selecionar</p>
        <p class="text-slate-500 text-xs mt-0.5">Pode selecionar múltiplos arquivos — transcritos em sequência</p>
        <p class="text-slate-600 text-xs mt-1">{{ SUPPORTED.join(' · ') }}</p>
      </div>
      <input
        ref="fileInput"
        type="file"
        :accept="ACCEPT"
        multiple
        class="hidden"
        @change="onFileChange"
      />
    </div>

    <!-- File list (files selected, not loading, no result yet) -->
    <div v-if="selectedFiles.length && !isLoading && !resultText" class="flex flex-col gap-3">
      <div class="flex flex-col gap-2">
        <div
          v-for="(file, i) in selectedFiles"
          :key="i"
          class="bg-slate-800/60 rounded-xl p-3.5 border border-slate-700/40 flex items-center gap-3"
        >
          <div class="w-8 h-8 rounded-lg bg-indigo-600/20 flex items-center justify-center flex-shrink-0">
            <svg class="w-4 h-4 text-indigo-400" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2z" />
            </svg>
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-slate-200 text-sm font-medium truncate">{{ file.name }}</p>
            <p class="text-slate-500 text-xs">{{ fmtSize(file.size) }}</p>
          </div>
          <button
            class="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
            :title="`Remover ${file.name}`"
            @click="removeFile(i)"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <div class="flex gap-2 justify-end">
        <button
          class="px-3 py-2 border border-slate-700 hover:bg-slate-800 text-slate-400 rounded-lg text-sm transition-colors"
          @click="fileInput?.click()"
        >
          Adicionar mais
        </button>
        <button
          class="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-medium transition-colors"
          @click="doTranscribe"
        >
          {{ selectedFiles.length > 1 ? `Transcrever ${selectedFiles.length} arquivos` : 'Transcrever' }}
        </button>
      </div>

      <input
        ref="fileInput"
        type="file"
        :accept="ACCEPT"
        multiple
        class="hidden"
        @change="onFileChange"
      />
    </div>

    <!-- Loading -->
    <div v-if="isLoading" class="bg-slate-800/60 rounded-2xl p-8 border border-slate-700/40 flex flex-col items-center gap-4">
      <div class="flex gap-1.5">
        <span v-for="i in 3" :key="i" class="w-2 h-2 rounded-full bg-indigo-500 animate-bounce" :style="`animation-delay: ${(i-1) * 0.15}s`" />
      </div>
      <div class="text-center">
        <p class="text-slate-300 font-medium">
          Transcrevendo
          <span v-if="selectedFiles.length > 1"> {{ loadingIndex + 1 }} de {{ selectedFiles.length }}</span>…
        </p>
        <p class="text-slate-500 text-xs mt-1">{{ selectedFiles[loadingIndex]?.name }}</p>
        <p class="text-slate-600 text-xs mt-3">Arquivos longos podem demorar alguns minutos</p>
      </div>
      <!-- progress dots -->
      <div v-if="selectedFiles.length > 1" class="flex gap-2 mt-1">
        <span
          v-for="(_, i) in selectedFiles"
          :key="i"
          :class="[
            'w-2 h-2 rounded-full transition-colors',
            i < loadingIndex ? 'bg-emerald-500' : i === loadingIndex ? 'bg-indigo-400' : 'bg-slate-700'
          ]"
        />
      </div>
    </div>

    <!-- Erro -->
    <div v-if="error" class="bg-red-500/10 border border-red-500/30 rounded-2xl p-4 flex items-start gap-3">
      <svg class="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
      </svg>
      <p class="text-red-400 text-sm">{{ error }}</p>
    </div>

    <!-- Resultado -->
    <div v-if="resultText && resultStats" class="flex flex-col gap-4 flex-1">
      <!-- Stats -->
      <div class="flex gap-3 flex-wrap">
        <div class="bg-slate-800/60 rounded-xl px-4 py-2.5 border border-slate-700/40 text-center">
          <p class="text-xs text-slate-500">Duração total</p>
          <p class="text-slate-200 font-semibold text-sm mt-0.5">{{ fmtTime(resultStats.duration_s) }}</p>
        </div>
        <div class="bg-slate-800/60 rounded-xl px-4 py-2.5 border border-slate-700/40 text-center">
          <p class="text-xs text-slate-500">Tempo de processo</p>
          <p class="text-slate-200 font-semibold text-sm mt-0.5">{{ fmtTime(resultStats.proc_s) }}</p>
        </div>
        <div class="bg-slate-800/60 rounded-xl px-4 py-2.5 border border-slate-700/40 text-center">
          <p class="text-xs text-slate-500">Modelo</p>
          <p class="text-slate-200 font-semibold text-sm mt-0.5">{{ resultStats.model }} / {{ resultStats.device }}</p>
        </div>
        <div v-if="store.fileNames.length > 1" class="bg-slate-800/60 rounded-xl px-4 py-2.5 border border-slate-700/40 text-center">
          <p class="text-xs text-slate-500">Arquivos</p>
          <p class="text-slate-200 font-semibold text-sm mt-0.5">{{ store.fileNames.length }}</p>
        </div>
        <div class="flex-1" />
        <button
          class="px-3 py-2 border border-slate-700 hover:bg-slate-800 text-slate-400 rounded-lg text-sm transition-colors"
          @click="reset"
        >
          Novo arquivo
        </button>
      </div>

      <!-- Texto -->
      <div class="flex-1 bg-slate-800/60 rounded-2xl border border-slate-700/40 flex flex-col min-h-0">
        <div class="flex items-center justify-between px-4 py-3 border-b border-slate-700/40">
          <p class="text-xs text-slate-500 uppercase tracking-wide">Transcrição</p>
          <CopyButton :text="resultText" />
        </div>
        <textarea
          :value="resultText"
          readonly
          class="flex-1 bg-transparent px-4 py-3 text-slate-200 text-sm leading-relaxed resize-none focus:outline-none min-h-[200px]"
        />
      </div>
    </div>
  </div>
</template>
