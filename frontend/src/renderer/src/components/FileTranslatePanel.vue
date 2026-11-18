<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import type { FileTranslation } from '../types'
import { listFileTranslations, startFileTranslation, deleteFileTranslation, getFileTranslationPath, type PdfTheme } from '../api'
import { onWsMessage } from '../api/ws'
import PdfCompareViewer from './PdfCompareViewer.vue'

const props = defineProps<{
  fromCode: string
  toCode: string
  canTranslate: boolean
  /** código do idioma → nome ("en" → "Inglês") */
  langName: (code: string) => string
}>()

const ACCEPT = '.pdf,.docx,.pptx,.xlsx,.txt,.md,.srt'
const EXTS = ACCEPT.split(',')

const jobs = ref<FileTranslation[]>([])
const dragging = ref(false)
const uploading = ref(0)
const error = ref<string | null>(null)
const input = ref<HTMLInputElement | null>(null)

// Tema do PDF traduzido (claro = igual ao original; escuro = fundo escuro e texto claro), escolhido DEPOIS da
// tradução, por arquivo: vale para abrir, salvar, mostrar na pasta e comparar. Novos arquivos começam com a
// última escolha.
function loadTheme(): PdfTheme {
  try {
    return localStorage.getItem('translate.pdfTheme') === 'dark' ? 'dark' : 'original'
  } catch {
    return 'original'
  }
}
const lastTheme = ref<PdfTheme>(loadTheme())
const jobTheme = ref<Record<string, PdfTheme>>({})
const themeOf = (job: FileTranslation): PdfTheme => (job.ext === '.pdf' ? jobTheme.value[job.id] ?? lastTheme.value : 'original')
function setJobTheme(job: FileTranslation, t: PdfTheme): void {
  jobTheme.value[job.id] = t
  lastTheme.value = t
  try {
    localStorage.setItem('translate.pdfTheme', t)
  } catch {
    /* sem armazenamento: só não lembra */
  }
}

// arquivo no tema escolhido (o escuro é gerado na primeira vez que é pedido)
const preparing = ref<Record<string, boolean>>({})
async function fileFor(job: FileTranslation): Promise<{ path: string; name: string } | null> {
  if (themeOf(job) === 'original' && job.output_path) return { path: job.output_path, name: job.output_name }
  preparing.value[job.id] = true
  try {
    return await getFileTranslationPath(job.id, themeOf(job))
  } catch (e) {
    error.value = errMsg(e)
    return null
  } finally {
    delete preparing.value[job.id]
  }
}

const unsub = onWsMessage((event) => {
  if (event.type !== 'translate_file' || !event.file_job) return
  const job = event.file_job
  const i = jobs.value.findIndex((j) => j.id === job.id)
  if (i === -1) jobs.value.unshift(job)
  else jobs.value[i] = job
})

onMounted(async () => {
  try {
    jobs.value = await listFileTranslations()
  } catch (e) {
    error.value = errMsg(e)
  }
})
onUnmounted(() => unsub())

function errMsg(e: unknown): string {
  const detail = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail
  if (typeof detail === 'string') return detail
  return e instanceof Error ? e.message : 'Erro desconhecido'
}

async function addFiles(files: FileList | File[] | null | undefined): Promise<void> {
  if (!files) return
  error.value = null
  if (!props.canTranslate) {
    error.value = 'Escolha um par de idiomas instalado antes de traduzir.'
    return
  }
  for (const file of Array.from(files)) {
    const ext = '.' + (file.name.split('.').pop() ?? '').toLowerCase()
    if (!EXTS.includes(ext)) {
      error.value = `"${file.name}": formato não suportado. Use PDF, DOCX, PPTX, XLSX, TXT, MD ou SRT.`
      continue
    }
    uploading.value++
    try {
      const job = await startFileTranslation(file, props.fromCode, props.toCode)
      if (!jobs.value.some((j) => j.id === job.id)) jobs.value.unshift(job)
    } catch (e) {
      error.value = `"${file.name}": ${errMsg(e)}`
    } finally {
      uploading.value--
    }
  }
}

function onDrop(e: DragEvent): void {
  dragging.value = false
  addFiles(e.dataTransfer?.files)
}

function onPick(e: Event): void {
  const el = e.target as HTMLInputElement
  addFiles(el.files)
  el.value = ''
}

const ipc = (): { invoke: (ch: string, ...args: unknown[]) => Promise<unknown> } | undefined =>
  (window as unknown as { electron?: { ipcRenderer?: { invoke: (ch: string, ...args: unknown[]) => Promise<unknown> } } })
    .electron?.ipcRenderer

const saved = ref<Record<string, string>>({})
async function saveCopy(job: FileTranslation): Promise<void> {
  const f = await fileFor(job)
  if (!f) return
  const res = (await ipc()?.invoke('file:save-copy', { path: f.path, name: f.name })) as
    | { ok: boolean; path?: string }
    | undefined
  if (res?.ok && res.path) {
    saved.value[job.id] = res.path
    setTimeout(() => delete saved.value[job.id], 4000)
  }
}

async function remove(job: FileTranslation): Promise<void> {
  jobs.value = jobs.value.filter((j) => j.id !== job.id)
  if (compare.value?.id === job.id) compare.value = null
  try {
    await deleteFileTranslation(job.id)
  } catch (e) {
    error.value = errMsg(e)
  }
}

const KIND: Record<string, string> = {
  '.pdf': 'PDF',
  '.docx': 'Word',
  '.pptx': 'PowerPoint',
  '.xlsx': 'Excel',
  '.txt': 'Texto',
  '.md': 'Markdown',
  '.srt': 'Legenda'
}
const BADGE: Record<string, string> = {
  '.pdf': 'bg-red-500/15 text-red-300 border-red-500/30',
  '.docx': 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  '.pptx': 'bg-orange-500/15 text-orange-300 border-orange-500/30',
  '.xlsx': 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
}

function details(job: FileTranslation): string {
  const parts = [`${props.langName(job.from_code)} → ${props.langName(job.to_code)}`, KIND[job.ext] ?? job.ext]
  if (job.pages) parts.push(`${job.pages} ${job.pages === 1 ? 'página' : 'páginas'}`)
  parts.push(formatSize(job.size))
  return parts.join(' · ')
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`
}

const busy = computed(() => jobs.value.some((j) => j.status === 'running' || j.status === 'queued'))

// ── comparar original × tradução (PDF) ───────────────────────────────────────
const compare = ref<FileTranslation | null>(null)

function openCompare(job: FileTranslation): void {
  compare.value = job
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- Área para soltar / escolher arquivos -->
    <div
      class="relative rounded-2xl border-2 border-dashed px-6 py-8 flex flex-col items-center justify-center gap-2 text-center cursor-pointer transition-colors"
      :class="dragging ? 'border-indigo-400 bg-indigo-500/10' : 'border-slate-700 bg-slate-800/30 hover:border-slate-500 hover:bg-slate-800/50'"
      @click="input?.click()"
      @dragenter.prevent="dragging = true"
      @dragover.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
    >
      <input ref="input" type="file" class="hidden" multiple :accept="ACCEPT" @change="onPick" />
      <svg class="w-9 h-9" :class="dragging ? 'text-indigo-300' : 'text-slate-500'" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m6.75 12l-3-3m0 0l-3 3m3-3v6m-1.5-15H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
      </svg>
      <p class="text-sm text-slate-200">
        <span v-if="uploading">Enviando…</span>
        <template v-else>Arraste um arquivo aqui ou <span class="text-indigo-400">clique para escolher</span></template>
      </p>
      <p class="text-xs text-slate-500">PDF, Word, PowerPoint, Excel, TXT, Markdown e legendas (SRT)</p>
      <p v-if="canTranslate" class="text-xs text-slate-400 mt-1">
        De <span class="text-slate-200">{{ langName(fromCode) }}</span> para
        <span class="text-slate-200">{{ langName(toCode) }}</span>, no seu computador, sem internet
      </p>
    </div>

    <p class="text-xs text-slate-500 leading-relaxed">
      O layout é mantido: fontes, cores, tabelas e imagens ficam no lugar. No PDF, se o texto traduzido for maior, a
      fonte diminui um pouco para caber. PDFs digitalizados (fotos de páginas) e texto dentro de imagens não são traduzidos.
    </p>

    <!-- Erro -->
    <div v-if="error" class="bg-red-500/10 border border-red-500/30 rounded-xl p-3 flex items-start gap-2">
      <svg class="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
      </svg>
      <p class="text-red-400 text-sm flex-1">{{ error }}</p>
      <button class="text-red-400/70 hover:text-red-300 text-xs" @click="error = null">fechar</button>
    </div>

    <!-- Traduções -->
    <div v-if="jobs.length" class="flex flex-col gap-2">
      <p class="text-xs text-slate-500 uppercase tracking-wide">
        Traduções <span v-if="busy" class="normal-case tracking-normal text-slate-600">· uma por vez</span>
      </p>
      <div
        v-for="job in jobs"
        :key="job.id"
        class="bg-slate-800/60 rounded-xl border px-3.5 py-3 flex flex-col gap-2"
        :class="job.status === 'error' ? 'border-red-500/30' : job.status === 'done' ? 'border-slate-700/50' : 'border-indigo-500/30'"
      >
        <div class="flex items-center gap-3">
          <span
            class="flex-shrink-0 w-11 text-center text-[10px] font-semibold uppercase rounded-md border py-1"
            :class="BADGE[job.ext] ?? 'bg-slate-700/40 text-slate-300 border-slate-600/50'"
          >{{ job.ext.slice(1) }}</span>
          <div class="min-w-0 flex-1">
            <p class="text-sm text-slate-200 truncate" :title="job.name">{{ job.status === 'done' ? job.output_name : job.name }}</p>
            <p class="text-xs text-slate-500 truncate">{{ details(job) }}</p>
          </div>
          <button
            class="flex-shrink-0 p-1.5 rounded-lg text-slate-500 hover:text-red-300 hover:bg-red-500/10 transition-colors"
            :title="job.status === 'running' || job.status === 'queued' ? 'Cancelar' : 'Remover da lista (apaga os arquivos temporários; o que você salvou continua)'"
            @click="remove(job)"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <!-- andamento -->
        <div v-if="job.status === 'running' || job.status === 'queued'" class="flex flex-col gap-1.5">
          <div class="w-full bg-slate-700/60 rounded-full h-1.5 overflow-hidden">
            <div
              class="h-1.5 rounded-full bg-indigo-500 transition-all duration-300 ease-out"
              :class="job.status === 'queued' || job.progress === 0 ? 'animate-pulse w-full opacity-30' : ''"
              :style="job.status === 'running' && job.progress > 0 ? `width: ${job.progress}%` : ''"
            />
          </div>
          <div class="flex justify-between text-xs text-slate-500">
            <span>{{ job.message }}</span>
            <span v-if="job.status === 'running' && job.progress > 0">{{ Math.floor(job.progress) }}%</span>
          </div>
        </div>

        <p v-else-if="job.status === 'error'" class="text-xs text-red-400">{{ job.error }}</p>

        <!-- pronto -->
        <div v-else class="flex flex-wrap items-center gap-2">
          <div
            v-if="job.ext === '.pdf'"
            class="flex gap-0.5 p-0.5 bg-slate-900/60 border border-slate-700/50 rounded-lg"
            title="Tema do PDF traduzido: claro (igual ao original) ou escuro (fundo escuro, texto claro, mesmas cores)"
          >
            <button
              v-for="t in ([['original', 'Claro'], ['dark', 'Escuro']] as const)"
              :key="t[0]"
              class="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors"
              :class="themeOf(job) === t[0] ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-slate-200'"
              @click="setJobTheme(job, t[0])"
            >
              <span
                class="w-2.5 h-2.5 rounded-sm border"
                :class="t[0] === 'dark' ? 'bg-slate-900 border-slate-400' : 'bg-white border-slate-300'"
              />
              {{ t[1] }}
            </button>
          </div>
          <!-- principal: ver o resultado (página a página, com o original ao lado) -->
          <button
            v-if="job.ext === '.pdf' && job.pages"
            class="flex items-center gap-1.5 text-xs text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg px-3 py-1.5 font-medium transition-colors"
            title="Pré-visualizar a tradução página a página, com o original ao lado"
            @click="openCompare(job)"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" /><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
            Pré-visualizar
          </button>
          <!-- salvar onde o usuário quiser (no tema escolhido); a cópia do app some ao remover da lista -->
          <button
            class="flex items-center gap-1.5 text-xs rounded-lg px-3 py-1.5 transition-colors"
            :class="job.ext === '.pdf' && job.pages ? 'text-slate-200 bg-slate-700/70 hover:bg-slate-700' : 'text-white bg-indigo-600 hover:bg-indigo-500 font-medium'"
            title="Escolher a pasta e salvar o arquivo traduzido"
            @click="saveCopy(job)"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12M12 16.5V3" /></svg>
            Salvar
          </button>
          <span v-if="preparing[job.id]" class="text-xs text-slate-500">Gerando a versão escura…</span>
          <span v-if="saved[job.id]" class="text-xs text-emerald-400 truncate">Salvo em {{ saved[job.id] }}</span>
        </div>
      </div>
    </div>

    <PdfCompareViewer
      v-if="compare"
      :job="compare"
      :lang-name="langName"
      :theme="themeOf(compare)"
      :saving="!!preparing[compare.id]"
      :saved-path="saved[compare.id]"
      @update:theme="(t) => compare && setJobTheme(compare, t)"
      @save="compare && saveCopy(compare)"
      @close="compare = null"
    />
  </div>
</template>
