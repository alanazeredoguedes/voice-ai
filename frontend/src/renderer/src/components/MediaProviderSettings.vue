<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { getSerperBalance, testMediaProvider, type MediaTestResult } from '../api'

type Provider = 'duckduckgo' | 'serper'

const props = defineProps<{ provider?: string | null; serperKey?: string }>()
const emit = defineEmits<{ save: [patch: Record<string, unknown>] }>()

// Mesmo critério do backend (media_search.image_provider): sem escolha salva, Serper se houver chave
const selected = computed<Provider>(() => {
  if (props.provider === 'duckduckgo' || props.provider === 'serper') return props.provider
  return (props.serperKey ?? '').trim() ? 'serper' : 'duckduckgo'
})
const hasKey = computed(() => !!(props.serperKey ?? '').trim())

// O que de fato será usado na próxima busca
const active = computed(() =>
  selected.value === 'serper' && hasKey.value ? 'Google (via Serper)' : 'DuckDuckGo'
)

const keyDraft = ref(props.serperKey ?? '')
watch(
  () => props.serperKey,
  (v) => {
    keyDraft.value = v ?? ''
    refreshBalance(v ?? '')
  }
)
const showKey = ref(false)
const showGuide = ref(false)

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && showGuide.value) showGuide.value = false
}
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))

function openSerper(): void {
  window.open('https://serper.dev', '_blank') // abre no navegador padrão
}

type TestState = { status: 'idle' | 'testing' | 'ok' | 'error'; result?: MediaTestResult }
const tests = ref<Record<string, TestState>>({
  duckduckgo: { status: 'idle' },
  serper: { status: 'idle' },
  youtube: { status: 'idle' }
})

// Créditos restantes no Serper (consulta não gasta crédito)
const balance = ref<{ loading: boolean; value?: number; error?: string }>({ loading: false })

async function refreshBalance(key?: string): Promise<void> {
  const k = (key ?? props.serperKey ?? '').trim()
  if (!k) {
    balance.value = { loading: false }
    return
  }
  balance.value = { ...balance.value, loading: true }
  try {
    const r = await getSerperBalance(k)
    balance.value = r.ok ? { loading: false, value: r.balance } : { loading: false, error: r.error }
  } catch {
    balance.value = { loading: false, error: 'Não foi possível consultar' }
  }
}

onMounted(() => refreshBalance())

async function runTest(p: Provider | 'youtube'): Promise<void> {
  tests.value[p] = { status: 'testing' }
  try {
    const result = await testMediaProvider(p, p === 'serper' ? keyDraft.value.trim() : undefined)
    tests.value[p] = { status: result.ok ? 'ok' : 'error', result }
    if (p === 'serper') refreshBalance(keyDraft.value) // o teste gasta 1 crédito: atualiza o saldo
  } catch (e) {
    tests.value[p] = { status: 'error', result: { ok: false, error: 'Backend não respondeu' } }
  }
}

function choose(p: Provider): void {
  emit('save', { image_provider: p })
}

function saveKey(): void {
  const k = keyDraft.value.trim()
  if (k === (props.serperKey ?? '')) return
  tests.value.serper = { status: 'idle' }
  emit('save', { serper_api_key: k })
}

async function saveAndTest(): Promise<void> {
  saveKey()
  await runTest('serper')
}

function dotClass(s: TestState['status']): string {
  return {
    idle: 'bg-slate-600',
    testing: 'bg-amber-400 animate-pulse',
    ok: 'bg-emerald-400',
    error: 'bg-red-500'
  }[s]
}

function statusText(t: TestState): string {
  if (t.status === 'idle') return 'Não testado'
  if (t.status === 'testing') return 'Testando…'
  if (t.status === 'ok') return `Funcionando - ${t.result?.count} resultado(s) em ${((t.result?.ms ?? 0) / 1000).toFixed(1)}s`
  return t.result?.error || 'Falhou'
}

const options: { id: Provider; title: string; desc: string }[] = [
  { id: 'duckduckgo', title: 'DuckDuckGo', desc: 'Grátis, sem chave. Bom para a maioria das buscas.' },
  { id: 'serper', title: 'Google (Serper)', desc: 'Resultados do Google Imagens. Precisa de chave (2.500 buscas grátis em serper.dev).' }
]
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex items-center justify-between gap-3">
      <p class="text-sm text-slate-200">Fonte das imagens</p>
      <span class="text-xs text-slate-400">
        Em uso agora: <span class="text-emerald-400 font-medium">{{ active }}</span>
      </span>
    </div>

    <!-- Escolha do provedor -->
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
      <button
        v-for="opt in options"
        :key="opt.id"
        type="button"
        :class="[
          'text-left rounded-xl border px-3.5 py-3 transition-colors flex flex-col gap-1',
          selected === opt.id
            ? 'border-indigo-500 bg-indigo-500/10'
            : 'border-slate-700 bg-slate-900/40 hover:border-indigo-500/60 hover:bg-indigo-600/10'
        ]"
        @click="choose(opt.id)"
      >
        <div class="flex items-center gap-2">
          <span
            :class="[
              'w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center flex-shrink-0',
              selected === opt.id ? 'border-indigo-400' : 'border-slate-500'
            ]"
          >
            <span v-if="selected === opt.id" class="w-1.5 h-1.5 rounded-full bg-indigo-400" />
          </span>
          <span class="text-sm text-slate-100 font-medium">{{ opt.title }}</span>
          <span class="ml-auto flex items-center gap-1.5" :title="statusText(tests[opt.id])">
            <span :class="['w-2 h-2 rounded-full', dotClass(tests[opt.id].status)]" />
          </span>
        </div>
        <p class="text-xs text-slate-500 pl-[22px]">{{ opt.desc }}</p>
      </button>
    </div>

    <!-- Aviso: Serper escolhido sem chave -->
    <p v-if="selected === 'serper' && !hasKey" class="text-xs text-amber-400">
      Google selecionado, mas sem chave salva - as buscas estão usando o DuckDuckGo.
    </p>

    <!-- Chave do Serper -->
    <div v-if="selected === 'serper'" class="flex flex-col gap-1.5">
      <div class="flex items-center justify-between gap-2">
        <p class="text-xs text-slate-400">Chave da API Serper</p>
        <button
          type="button"
          class="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
          @click="showGuide = true"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
          </svg>
          Como conseguir a chave?
        </button>
      </div>
      <div class="flex gap-2">
        <div class="relative flex-1">
          <input
            v-model="keyDraft"
            :type="showKey ? 'text' : 'password'"
            placeholder="Cole sua chave da serper.dev"
            autocomplete="off"
            spellcheck="false"
            class="w-full bg-slate-900 border border-slate-700 rounded-lg pl-3 pr-16 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-indigo-500"
            @change="saveKey"
            @keydown.enter="saveAndTest"
          />
          <button
            type="button"
            class="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-slate-500 hover:text-slate-300"
            @click="showKey = !showKey"
          >{{ showKey ? 'ocultar' : 'mostrar' }}</button>
        </div>
        <button
          type="button"
          :disabled="!keyDraft.trim() || tests.serper.status === 'testing'"
          class="flex-shrink-0 px-3 py-2 rounded-lg text-xs font-medium bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
          @click="saveAndTest"
        >Salvar e testar</button>
      </div>
    </div>

    <!-- Créditos do Serper -->
    <div
      v-if="selected === 'serper' && hasKey"
      class="flex items-center gap-2 text-xs rounded-xl bg-slate-900/50 border border-slate-800 px-3 py-2.5"
    >
      <svg class="w-4 h-4 text-indigo-400 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 5.625c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
      </svg>
      <span class="text-slate-400">Créditos restantes no Serper:</span>
      <span v-if="balance.loading && balance.value === undefined" class="text-slate-500">consultando…</span>
      <span v-else-if="balance.value !== undefined" :class="['font-semibold tabular-nums', balance.value < 100 ? 'text-amber-400' : 'text-slate-100']">
        {{ balance.value.toLocaleString('pt-BR') }}
      </span>
      <span v-else-if="balance.error" class="text-red-400">{{ balance.error }}</span>
      <span class="text-slate-600">· cada pedido de imagens gasta ~1</span>
      <button
        type="button"
        title="Atualizar saldo"
        :disabled="balance.loading"
        class="ml-auto p-1 rounded-md text-slate-500 hover:text-slate-200 disabled:opacity-40 transition-colors"
        @click="refreshBalance()"
      >
        <svg :class="['w-3.5 h-3.5', balance.loading ? 'animate-spin' : '']" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
        </svg>
      </button>
    </div>

    <!-- Status dos testes -->
    <div class="flex flex-col gap-1.5 rounded-xl bg-slate-900/50 border border-slate-800 px-3 py-2.5">
      <div
        v-for="row in [
          { id: selected, label: selected === 'serper' ? 'Google (Serper)' : 'DuckDuckGo' },
          { id: 'youtube', label: 'Vídeos (YouTube)' }
        ]"
        :key="row.id"
        class="flex items-center gap-2 text-xs"
      >
        <span :class="['w-2 h-2 rounded-full flex-shrink-0', dotClass(tests[row.id].status)]" />
        <span class="text-slate-300 w-32 flex-shrink-0">{{ row.label }}</span>
        <span
          :class="[
            'flex-1 truncate',
            tests[row.id].status === 'error' ? 'text-red-400' : tests[row.id].status === 'ok' ? 'text-emerald-400' : 'text-slate-500'
          ]"
          :title="statusText(tests[row.id])"
        >{{ statusText(tests[row.id]) }}</span>
        <button
          type="button"
          :disabled="tests[row.id].status === 'testing' || (row.id === 'serper' && !keyDraft.trim())"
          class="flex-shrink-0 px-2.5 py-1 rounded-md border border-slate-700 hover:border-slate-500 text-slate-300 disabled:opacity-40 transition-colors"
          @click="runTest(row.id as Provider | 'youtube')"
        >Testar</button>
      </div>
    </div>

    <!-- Guia: como criar a chave do Serper -->
    <Teleport to="body">
      <div
        v-if="showGuide"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-6"
        @click.self="showGuide = false"
      >
        <div class="w-full max-w-lg bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl flex flex-col max-h-full">
          <div class="flex items-center justify-between px-5 pt-5 pb-3">
            <div>
              <h3 class="text-base font-semibold text-slate-100">Como usar o Google Imagens (Serper)</h3>
              <p class="text-xs text-slate-500 mt-0.5">Leva uns 2 minutos e é grátis para começar.</p>
            </div>
            <button class="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10" title="Fechar" @click="showGuide = false">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div class="px-5 pb-2 overflow-y-auto flex flex-col gap-4 text-sm text-slate-300">
            <p class="text-xs text-slate-400 leading-relaxed">
              O <span class="text-slate-200">Serper</span> é um serviço que entrega os resultados do Google por uma
              chave de API. Com ele, as imagens do chat vêm do Google Imagens - costuma achar mais coisas
              específicas (itens de jogos, lugares, pessoas) do que o DuckDuckGo.
            </p>

            <ol class="flex flex-col gap-3">
              <li class="flex gap-3">
                <span class="step">1</span>
                <div>
                  <p class="text-slate-200">Acesse o site <button class="text-indigo-400 hover:text-indigo-300 underline underline-offset-2" @click="openSerper">serper.dev</button></p>
                  <p class="text-xs text-slate-500 mt-0.5">Abre no seu navegador.</p>
                </div>
              </li>
              <li class="flex gap-3">
                <span class="step">2</span>
                <div>
                  <p class="text-slate-200">Crie uma conta gratuita</p>
                  <p class="text-xs text-slate-500 mt-0.5">
                    Clique em <span class="text-slate-300">Sign up</span> e entre com o Google ou com e-mail.
                    Não precisa de cartão de crédito. A conta nova vem com
                    <span class="text-emerald-400">2.500 buscas grátis</span>.
                  </p>
                </div>
              </li>
              <li class="flex gap-3">
                <span class="step">3</span>
                <div>
                  <p class="text-slate-200">Copie a sua chave de API</p>
                  <p class="text-xs text-slate-500 mt-0.5">
                    No painel do site, abra a seção <span class="text-slate-300">API Key</span> e copie o código
                    (uma sequência longa de letras e números).
                  </p>
                </div>
              </li>
              <li class="flex gap-3">
                <span class="step">4</span>
                <div>
                  <p class="text-slate-200">Cole aqui e clique em “Salvar e testar”</p>
                  <p class="text-xs text-slate-500 mt-0.5">
                    Se a bolinha ficar <span class="text-emerald-400">verde</span>, está funcionando.
                    Se ficar <span class="text-red-400">vermelha</span>, aparece o motivo ao lado (chave errada,
                    créditos esgotados…).
                  </p>
                </div>
              </li>
            </ol>

            <div class="rounded-xl bg-slate-950/70 border border-slate-800 px-3.5 py-3 text-xs text-slate-400 leading-relaxed flex flex-col gap-1">
              <p><span class="text-slate-200">Quanto gasta?</span> Cada pedido de imagens no chat usa cerca de 1 crédito (o botão Testar também).</p>
              <p><span class="text-slate-200">E se acabar?</span> O app volta sozinho para o DuckDuckGo. Dá para comprar mais créditos no site do Serper ou simplesmente escolher DuckDuckGo aqui.</p>
              <p><span class="text-slate-200">Vídeos</span> sempre vêm do YouTube e não usam créditos.</p>
            </div>
          </div>

          <div class="flex justify-end gap-2 px-5 py-4">
            <button
              class="px-3.5 py-2 rounded-lg text-xs border border-slate-700 hover:border-slate-500 text-slate-300 transition-colors"
              @click="openSerper"
            >Abrir serper.dev</button>
            <button
              class="px-3.5 py-2 rounded-lg text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
              @click="showGuide = false"
            >Entendi</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.step {
  flex-shrink: 0;
  width: 1.5rem;
  height: 1.5rem;
  border-radius: 9999px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.75rem;
  font-weight: 600;
  color: rgb(165 180 252);
  background: rgb(99 102 241 / 0.15);
  border: 1px solid rgb(99 102 241 / 0.4);
}
</style>
