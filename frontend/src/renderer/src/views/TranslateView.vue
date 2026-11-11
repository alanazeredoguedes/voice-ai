<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useTranslationStore } from '../stores/translation'
import { translateText, installTranslatePackage, removeTranslatePackage } from '../api'
import { onWsMessage } from '../api/ws'
import CopyButton from '../components/CopyButton.vue'
import CustomSelect from '../components/CustomSelect.vue'

const store = useTranslationStore()

const translating = ref(false)
// Gerenciar Modelos: ao entrar na tela, abre fechado se já existe algum modelo baixado (senão abre, para baixar)
const modelsOpen = ref(!store.hasAnyInstalled)
const downloadProgress = ref<Record<string, number>>({})  // "en>pt" → 0-100
const error = ref<string | null>(null)
let debounceTimer: ReturnType<typeof setTimeout> | null = null

// Escuta progresso de download via WS
const unsub = onWsMessage((event) => {
  if (event.type === 'translate_download_progress' && event.from_code && event.to_code) {
    const key = `${event.from_code}>${event.to_code}`
    if (event.done) {
      delete downloadProgress.value[key]
      store.markInstalled(event.from_code, event.to_code)
      // Se o par baixado é o atual, fechar gerenciador
      if (event.from_code === store.fromCode && event.to_code === store.toCode) {
        modelsOpen.value = false
      }
    } else {
      downloadProgress.value[key] = event.progress ?? 0
    }
  }
})

onMounted(async () => {
  await store.fetchPackages()
  if (store.hasAnyInstalled) modelsOpen.value = false
})
onUnmounted(() => unsub())

// Pares disponíveis para o seletor de origem
const availableFrom = computed(() =>
  [...new Map(store.installedPairs.map(p => [p.from_code, p])).values()]
)

// Pares disponíveis para o seletor de destino dado o from atual
const availableTo = computed(() =>
  store.installedPairs.filter(p => p.from_code === store.fromCode)
)

// Garantir que toCode seja válido quando fromCode muda
watch(() => store.fromCode, () => {
  const valid = availableTo.value.find(p => p.to_code === store.toCode)
  if (!valid && availableTo.value.length > 0) {
    store.toCode = availableTo.value[0].to_code
  }
})

function swap(): void {
  const tmp = store.fromCode
  store.fromCode = store.toCode
  store.toCode = tmp
  const tmpText = store.lastInput
  store.lastInput = store.lastOutput
  store.lastOutput = tmpText
  if (store.lastInput) doTranslate()
}

async function doTranslate(): Promise<void> {
  if (!store.lastInput.trim() || !store.canTranslate) return
  translating.value = true
  error.value = null
  try {
    const r = await translateText(store.lastInput, store.fromCode, store.toCode)
    store.lastOutput = r.translated
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Erro ao traduzir'
  } finally {
    translating.value = false
  }
}

function onInputChange(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  if (!store.lastInput.trim()) { store.lastOutput = ''; return }
  debounceTimer = setTimeout(doTranslate, 800)
}

function pairKey(from: string, to: string): string {
  return `${from}>${to}`
}

async function doInstall(from_code: string, to_code: string): Promise<void> {
  const key = pairKey(from_code, to_code)
  downloadProgress.value[key] = 0
  try {
    await installTranslatePackage(from_code, to_code)
  } catch (e: unknown) {
    delete downloadProgress.value[key]
    error.value = `Erro ao baixar modelo: ${e instanceof Error ? e.message : 'desconhecido'}`
  }
}

async function doRemove(from_code: string, to_code: string): Promise<void> {
  try {
    await removeTranslatePackage(from_code, to_code)
    store.markRemoved(from_code, to_code)
  } catch (e: unknown) {
    error.value = `Erro ao remover modelo: ${e instanceof Error ? e.message : 'desconhecido'}`
  }
}

const search = ref('')

const notInstalled = computed(() => {
  const q = search.value.trim().toLowerCase()
  return store.packages.filter(p => {
    if (p.installed) return false
    if (!q) return true
    return p.from_name.toLowerCase().includes(q) || p.to_name.toLowerCase().includes(q)
  })
})

const filteredInstalled = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return store.installedPairs
  return store.installedPairs.filter(p =>
    p.from_name.toLowerCase().includes(q) || p.to_name.toLowerCase().includes(q)
  )
})
</script>

<template>
  <div class="flex flex-col gap-6 h-full">
    <div>
      <h1 class="text-xl font-semibold text-slate-100">Traduzir</h1>
      <p class="text-sm text-slate-500 mt-1">Tradução offline usando modelos locais - sem internet em runtime</p>
    </div>

    <!-- Bloco de tradução (só aparece se há modelos instalados) -->
    <div v-if="store.hasAnyInstalled" class="flex flex-col gap-4">
      <!-- Seletores de idioma -->
      <div class="flex items-center gap-3">
        <CustomSelect
          v-model="store.fromCode"
          class="flex-1"
          size="sm"
          :options="availableFrom.map((p) => ({ value: p.from_code, label: p.from_name }))"
        />

        <button
          class="p-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 hover:text-slate-100 hover:bg-slate-700 transition-colors"
          title="Inverter idiomas"
          @click="swap"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
          </svg>
        </button>

        <CustomSelect
          v-model="store.toCode"
          class="flex-1"
          size="sm"
          align="right"
          :options="availableTo.map((p) => ({ value: p.to_code, label: p.to_name }))"
        />
      </div>

      <!-- Textareas -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <!-- Entrada -->
        <div class="bg-slate-800/60 rounded-2xl border border-slate-700/40 flex flex-col min-h-0">
          <div class="flex items-center justify-between px-4 py-2.5 border-b border-slate-700/40">
            <p class="text-xs text-slate-500 uppercase tracking-wide">{{ availableFrom.find(p => p.from_code === store.fromCode)?.from_name ?? store.fromCode }}</p>
          </div>
          <textarea
            v-model="store.lastInput"
            placeholder="Digite o texto para traduzir…"
            class="flex-1 bg-transparent px-4 py-3 text-slate-200 text-sm leading-relaxed resize-none focus:outline-none min-h-[180px]"
            @input="onInputChange"
          />
        </div>

        <!-- Saída -->
        <div class="bg-slate-800/60 rounded-2xl border border-slate-700/40 flex flex-col min-h-0">
          <div class="flex items-center justify-between px-4 py-2.5 border-b border-slate-700/40">
            <p class="text-xs text-slate-500 uppercase tracking-wide">{{ availableTo.find(p => p.to_code === store.toCode)?.to_name ?? store.toCode }}</p>
            <CopyButton v-if="store.lastOutput" :text="store.lastOutput" />
          </div>
          <div class="relative flex-1">
            <textarea
              :value="store.lastOutput"
              readonly
              placeholder="Tradução aparece aqui…"
              class="w-full h-full bg-transparent px-4 py-3 text-slate-200 text-sm leading-relaxed resize-none focus:outline-none min-h-[180px]"
            />
            <div v-if="translating" class="absolute inset-0 flex items-center justify-center bg-slate-900/40 rounded-b-2xl">
              <div class="flex gap-1.5">
                <span v-for="i in 3" :key="i" class="w-2 h-2 rounded-full bg-indigo-500 animate-bounce" :style="`animation-delay: ${(i-1)*0.15}s`" />
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Botão traduzir manual -->
      <div class="flex justify-end gap-2">
        <button
          :disabled="translating || !store.lastInput.trim() || !store.canTranslate"
          class="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
          @click="doTranslate"
        >
          {{ translating ? 'Traduzindo…' : 'Traduzir' }}
        </button>
      </div>

      <!-- Erro -->
      <div v-if="error" class="bg-red-500/10 border border-red-500/30 rounded-xl p-3 flex items-center gap-2">
        <svg class="w-4 h-4 text-red-400 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
        </svg>
        <p class="text-red-400 text-sm">{{ error }}</p>
      </div>
    </div>

    <!-- Aviso quando não há modelos instalados -->
    <div v-else class="bg-amber-500/10 border border-amber-500/30 rounded-2xl p-5 flex items-start gap-3">
      <svg class="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
      </svg>
      <div>
        <p class="text-amber-300 text-sm font-medium">Nenhum modelo instalado</p>
        <p class="text-amber-500/80 text-xs mt-0.5">Baixe um modelo abaixo para começar a traduzir.</p>
      </div>
    </div>

    <!-- Gerenciar Modelos -->
    <div class="bg-slate-800/40 rounded-2xl border border-slate-700/40 overflow-hidden">
      <!-- Header colapsável -->
      <button
        class="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-800/60 transition-colors"
        @click="modelsOpen = !modelsOpen"
      >
        <span class="text-sm font-medium text-slate-300">Gerenciar Modelos</span>
        <svg
          class="w-4 h-4 text-slate-500 transition-transform"
          :class="modelsOpen ? 'rotate-180' : ''"
          fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"
        >
          <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      <div v-if="modelsOpen" class="px-4 pb-4 flex flex-col gap-2">
        <!-- Barra de pesquisa -->
        <div class="relative mt-1">
          <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500 pointer-events-none" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
          <input
            v-model="search"
            type="text"
            placeholder="Pesquisar idioma…"
            class="w-full bg-slate-900/60 border border-slate-700/60 rounded-lg pl-8 pr-3 py-1.5 text-slate-200 text-sm placeholder-slate-600 focus:outline-none focus:border-indigo-500"
          />
        </div>

        <!-- Lista com scroll -->
        <div class="flex flex-col gap-2 overflow-y-auto max-h-72 pr-0.5">
        <!-- Instalados -->
        <template v-if="filteredInstalled.length > 0">
          <p class="text-xs text-slate-500 uppercase tracking-wide mt-1 mb-1">Instalados</p>
          <div
            v-for="p in filteredInstalled"
            :key="`${p.from_code}>${p.to_code}`"
            class="flex items-center justify-between py-2 px-3 bg-slate-800/60 rounded-xl border border-emerald-500/20"
          >
            <div class="flex items-center gap-2">
              <span class="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0" />
              <span class="text-slate-200 text-sm">{{ p.from_name }} → {{ p.to_name }}</span>
            </div>
            <button
              class="text-xs text-red-400 hover:text-red-300 border border-red-700/40 hover:border-red-600/60 rounded-lg px-2.5 py-1 transition-colors"
              @click="doRemove(p.from_code, p.to_code)"
            >
              Remover
            </button>
          </div>
        </template>

        <!-- Disponíveis para download -->
        <template v-if="notInstalled.length > 0">
          <p class="text-xs text-slate-500 uppercase tracking-wide mt-2 mb-1">Disponíveis para download</p>
          <div
            v-for="p in notInstalled"
            :key="`${p.from_code}>${p.to_code}`"
            class="flex flex-col gap-1.5 py-2 px-3 bg-slate-800/40 rounded-xl border border-slate-700/40"
          >
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <svg class="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12M12 16.5V3" />
                </svg>
                <span class="text-slate-300 text-sm">{{ p.from_name }} → {{ p.to_name }}</span>
                <span class="text-slate-600 text-xs">{{ p.size_mb > 0 ? `~${p.size_mb} MB` : '~300 MB' }}</span>
              </div>
              <button
                v-if="downloadProgress[pairKey(p.from_code, p.to_code)] === undefined"
                class="text-xs text-indigo-400 hover:text-indigo-300 border border-indigo-700/40 hover:border-indigo-600/60 rounded-lg px-2.5 py-1 transition-colors"
                @click="doInstall(p.from_code, p.to_code)"
              >
                Baixar
              </button>
              <span v-else class="text-xs text-slate-500">
                {{ Math.floor(downloadProgress[pairKey(p.from_code, p.to_code)]) }}%
              </span>
            </div>

            <!-- Barra de progresso durante download -->
            <div
              v-if="downloadProgress[pairKey(p.from_code, p.to_code)] !== undefined"
              class="w-full bg-slate-700/60 rounded-full h-1.5 overflow-hidden"
            >
              <div
                class="h-1.5 rounded-full bg-indigo-500 transition-all duration-300 ease-out"
                :style="`width: ${downloadProgress[pairKey(p.from_code, p.to_code)]}%`"
              />
            </div>
          </div>
        </template>

        <!-- Loading inicial -->
        <div v-if="store.loading && store.packages.length === 0" class="py-4 text-center text-slate-500 text-sm">
          Carregando lista de modelos…
        </div>
        </div><!-- /scroll container -->
      </div>
    </div>
  </div>
</template>
