<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref } from 'vue'
import { useSettingsStore } from '../stores/settings'
import { useStatusStore } from '../stores/status'
import { getEdgeVoices, getEngineStatus, getWhisperModels, downloadWhisperModel, deleteWhisperModel, type EngineStatus } from '../api'
import { onWsMessage } from '../api/ws'
import type { EdgeVoice, WhisperModel } from '../types'
import HotkeyList from '../components/HotkeyList.vue'
import SettingToggle from '../components/SettingToggle.vue'
import StorageSettings from '../components/StorageSettings.vue'
import ElevenLabsConfig from '../components/ElevenLabsConfig.vue'
import MediaProviderSettings from '../components/MediaProviderSettings.vue'
import WhisperModelPicker from '../components/WhisperModelPicker.vue'
import HoldToReveal from '../components/HoldToReveal.vue'
import CustomSelect from '../components/CustomSelect.vue'
import ClaudeMonitoringStatus from '../components/ClaudeMonitoringStatus.vue'
import { CLAUDE_MODEL_OPTIONS, DEFAULT_CLAUDE_MODEL } from '../utils/claudeModels'

const UPLOAD_LIMITS = [1, 2, 3, 5, 10, 15, 20].map((v) => ({
  value: String(v),
  label: `${v} MB por anexo`,
  description: v === 2 ? 'Padrão' : undefined
}))
import ClaudeUsageCard from '../components/ClaudeUsageCard.vue'

const store = useSettingsStore()
const statusStore = useStatusStore()
const navigate = inject<(v: string) => void>('navigate')
const edgeVoices = ref<EdgeVoice[]>([])

// Modelos Whisper
const whisperModels = ref<WhisperModel[]>([])
const modelProgress = ref<Record<string, number>>({})
const modelError = ref<Record<string, string>>({})

const unsub = onWsMessage((event) => {
  if (event.type === 'model_download_progress' && event.model) {
    modelProgress.value[event.model] = event.progress ?? 0
    const m = whisperModels.value.find(x => x.id === event.model)
    if (m) m.downloading = true
  } else if (event.type === 'model_download_complete' && event.model) {
    const m = whisperModels.value.find(x => x.id === event.model)
    if (m) { m.downloaded = true; m.downloading = false }
    delete modelProgress.value[event.model!]
  } else if (event.type === 'model_download_error' && event.model) {
    const m = whisperModels.value.find(x => x.id === event.model)
    if (m) m.downloading = false
    modelError.value[event.model] = event.error ?? 'Erro desconhecido'
    delete modelProgress.value[event.model!]
  }
})

onUnmounted(() => unsub())

onMounted(async () => {
  if (!store.settings) await store.fetchSettings()
  edgeVoices.value = await getEdgeVoices()
  whisperModels.value = await getWhisperModels()
})

async function startDownload(id: string): Promise<void> {
  delete modelError.value[id]
  const m = whisperModels.value.find(x => x.id === id)
  if (m) m.downloading = true
  modelProgress.value[id] = 0
  try {
    await downloadWhisperModel(id)
  } catch {
    if (m) m.downloading = false
    delete modelProgress.value[id]
  }
}

async function removeModel(id: string): Promise<void> {
  await deleteWhisperModel(id)
  const m = whisperModels.value.find(x => x.id === id)
  if (m) m.downloaded = false
}

// Whisper: trocar modelo/dispositivo reinicia a engine sozinho no backend; aqui só acompanha
const engine = ref<EngineStatus | null>(null)
const engineLoading = ref(false)
let enginePoll: ReturnType<typeof setInterval> | null = null

async function refreshEngine(): Promise<void> {
  try {
    engine.value = await getEngineStatus()
  } catch {
    engine.value = null
  }
}

async function applyEngine(patch: { model?: string; device?: string }): Promise<void> {
  await set(patch)
  engineLoading.value = true
  if (enginePoll) clearInterval(enginePoll)
  const t0 = Date.now()
  // espera o backend começar a recarregar e depois ficar pronto
  await new Promise((r) => setTimeout(r, 600))
  enginePoll = setInterval(async () => {
    await refreshEngine()
    if (engine.value?.ready || Date.now() - t0 > 180_000) {
      engineLoading.value = false
      if (enginePoll) clearInterval(enginePoll)
      enginePoll = null
    }
  }, 1000)
}

const DEVICE_LABEL: Record<string, string> = { cuda: 'na placa NVIDIA (GPU)', cpu: 'no processador (CPU)' }
// texto com o espaço já incluso (o Vue remove o espaço entre um </span> e um <template>)
const engineDeviceText = computed(() => {
  const d = engine.value?.device
  return d ? ` ${DEVICE_LABEL[d] ?? d}` : ''
})

// Vozes do Edge no select padrão do app (com o gênero como descrição)
const edgeVoiceOptions = computed(() =>
  edgeVoices.value.map((v) => ({
    value: v.id,
    label: v.name,
    description: /^f/i.test(v.gender ?? '') ? 'Voz feminina' : /^m/i.test(v.gender ?? '') ? 'Voz masculina' : v.gender
  }))
)

const DEVICE_OPTIONS = [
  { value: 'auto', label: 'Automático', description: 'Usa a placa NVIDIA se houver' },
  { value: 'cuda', label: 'Placa NVIDIA (GPU)', description: 'Mais rápido' },
  { value: 'cpu', label: 'Processador (CPU)', description: 'Funciona em qualquer PC, mais lento' }
]
const activeModelName = computed(
  () => whisperModels.value.find((m) => m.id === store.settings?.model)?.name ?? store.settings?.model ?? ''
)

onMounted(refreshEngine)
onUnmounted(() => {
  if (enginePoll) clearInterval(enginePoll)
})

async function set(patch: Record<string, unknown>): Promise<void> {
  await store.update(patch)
}

// Conta Claude (login pelo fluxo oficial da Anthropic; ver main/index.ts → claude:login)
const claudeAccount = ref<{
  installed: boolean
  loggedIn: boolean
  email?: string
  orgName?: string
  plan?: string
} | null>(null)

const PLAN_LABEL: Record<string, string> = { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise', free: 'Free' }

/** "email · Organização (plano Team)" - mostrado só enquanto segura o clique */
const claudeAccountText = computed(() => {
  const a = claudeAccount.value
  if (!a?.loggedIn) return ''
  const parts: string[] = []
  if (a.email) parts.push(a.email)
  const plan = a.plan ? `plano ${PLAN_LABEL[a.plan] ?? a.plan}` : ''
  if (a.orgName && plan) parts.push(`${a.orgName} (${plan})`)
  else if (a.orgName || plan) parts.push(a.orgName || plan)
  return parts.join(' · ')
})
const claudeWaiting = ref(false)
const confirmSwitch = ref(false)

function confirmSwitchAccount(): void {
  confirmSwitch.value = false
  loginClaude(true)
}
let claudePoll: ReturnType<typeof setInterval> | null = null

async function refreshClaude(): Promise<void> {
  try {
    claudeAccount.value = (await window.electron?.ipcRenderer.invoke('claude:status')) ?? null
  } catch {
    claudeAccount.value = null
  }
}

async function loginClaude(switchAccount = false): Promise<void> {
  const r = (await window.electron.ipcRenderer.invoke('claude:login', { switchAccount })) as { started: boolean }
  if (!r.started) return
  claudeWaiting.value = true
  const t0 = Date.now()
  // Ao trocar de conta, só considera concluído depois de ver o logout da conta antiga
  let sawLoggedOut = !switchAccount
  if (claudePoll) clearInterval(claudePoll)
  claudePoll = setInterval(async () => {
    await refreshClaude()
    if (!claudeAccount.value?.loggedIn) sawLoggedOut = true
    if ((sawLoggedOut && claudeAccount.value?.loggedIn) || Date.now() - t0 > 5 * 60_000) {
      claudeWaiting.value = false
      if (claudePoll) clearInterval(claudePoll)
      claudePoll = null
    }
  }, 3000)
}

onMounted(refreshClaude)
onUnmounted(() => {
  if (claudePoll) clearInterval(claudePoll)
})
</script>

<template>
  <div class="flex flex-col gap-5 h-full" v-if="store.settings">
    <div>
      <h1 class="text-xl font-semibold text-slate-100">Configurações</h1>
      <p class="text-sm text-slate-500 mt-1">Personalize o comportamento do assistente</p>
    </div>

    <!-- Grid responsivo: 1 coluna em janelas estreitas, 2 a partir de 768px (cabe no tamanho padrão da janela) -->
    <div class="grid grid-cols-1 md:grid-cols-2 gap-5 pb-6">

      <!-- Atalhos - largura total -->
      <section class="col-span-full bg-slate-800/60 rounded-2xl p-5 border border-slate-700/40 flex flex-col gap-4">
        <h2 class="text-xs font-semibold text-slate-400 uppercase tracking-widest">Atalhos</h2>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <HotkeyList
            label="Transcrição (push-to-talk)"
            :primary="store.settings.transcription_key"
            :extra="store.settings.transcription_keys_extra ?? []"
            @update:primary="(v) => set({ transcription_key: v })"
            @update:extra="(v) => set({ transcription_keys_extra: v })"
          />
          <HotkeyList
            label="IA (push-to-talk)"
            :primary="store.settings.ai_key"
            :extra="store.settings.ai_keys_extra ?? []"
            @update:primary="(v) => set({ ai_key: v })"
            @update:extra="(v) => set({ ai_keys_extra: v })"
          />
          <HotkeyList
            label="Mostrar/esconder o Voice AI (por cima do jogo)"
            :primary="store.settings.window_key ?? '<ctrl>+<alt>+<f12>'"
            :extra="store.settings.window_keys_extra ?? []"
            @update:primary="(v) => set({ window_key: v })"
            @update:extra="(v) => set({ window_keys_extra: v })"
          />
        </div>
        <p class="text-xs text-slate-500 leading-relaxed">
          <span class="text-slate-400 font-medium">Dica:</span>
          cada função aceita vários atalhos ao mesmo tempo (ex.: um no teclado/mouse e outro no controle).
          Dois cliques rápidos no botão de transcrição cancelam a transcrição em andamento.
          Dois cliques rápidos no botão de IA cancelam a resposta em andamento (ou param a fala, se ela já terminou de responder).
          O atalho de mostrar/esconder traz o Voice AI para a frente de qualquer janela, inclusive de jogos em tela cheia
          sem bordas; apertando de novo, ele volta para trás.
        </p>
      </section>

      <!-- Reconhecimento de voz (Whisper): modelo + dispositivo num card só -->
      <section class="col-span-full bg-slate-800/60 rounded-2xl p-5 border border-slate-700/40 flex flex-col gap-4">
        <div class="flex items-start justify-between gap-4">
          <div>
            <h2 class="text-xs font-semibold text-slate-400 uppercase tracking-widest">Reconhecimento de voz (Whisper)</h2>
            <p class="text-xs text-slate-500 mt-1">
              Modelos maiores são mais precisos, porém mais lentos e pesados. A troca é aplicada na hora.
            </p>
          </div>
          <!-- estado da engine -->
          <div class="flex items-center gap-1.5 text-xs flex-shrink-0 mt-0.5">
            <template v-if="engineLoading || (engine && !engine.ready)">
              <span class="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
              <span class="text-amber-300">
                Carregando {{ activeModelName }}…<template v-if="statusStore.engineLoading"> {{ statusStore.engineLoading.slow ? `${Math.floor(statusStore.engineLoading.elapsed ?? 0)} s (demorando mais que o normal)` : `${Math.floor(statusStore.engineLoading.progress)}%` }}</template>
              </span>
            </template>
            <template v-else-if="engine?.ready">
              <span class="w-2 h-2 rounded-full bg-emerald-400" />
              <span class="text-slate-400">
                Pronto: <span class="text-slate-200">{{ activeModelName }}</span>{{ engineDeviceText }}
              </span>
            </template>
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-[1fr_280px] gap-3 items-stretch">
          <div class="flex flex-col gap-1.5">
            <label class="text-xs text-slate-500">Modelo</label>
            <WhisperModelPicker
              class="flex-1"
              :models="whisperModels"
              :active-id="store.settings?.model"
              :progress="modelProgress"
              :errors="modelError"
              @select="(id) => applyEngine({ model: id })"
              @download="startDownload"
              @remove="removeModel"
            />
          </div>
          <div class="flex flex-col gap-1.5">
            <label class="text-xs text-slate-500">Processar em</label>
            <CustomSelect
              class="flex-1"
              :model-value="store.settings.device"
              :options="DEVICE_OPTIONS"
              @update:model-value="(v) => applyEngine({ device: v })"
            />
          </div>
        </div>

        <!-- Opções da gravação pelo atalho (a transcrição de arquivos não muda) -->
        <div class="flex flex-col gap-2 pt-3 border-t border-slate-700/40">
          <p class="text-xs text-slate-500">
            Gravação pelo atalho <span class="text-slate-600">· valem na próxima gravação, sem reiniciar</span>
          </p>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-3">
            <SettingToggle
              :model-value="store.settings.whisper_batched ?? true"
              label="Modo em lote"
              description="Áudios com mais de 30 s são cortados nas pausas e os pedaços vão juntos para a placa de vídeo. Cerca de 2x mais rápido em falas longas; abaixo de 30 s não muda nada."
              @update:model-value="(v) => set({ whisper_batched: v })"
            />
            <SettingToggle
              :model-value="store.settings.whisper_vad ?? false"
              label="Pular silêncios"
              description="Ignora os trechos sem fala antes de transcrever. Ajuda se você faz muitas pausas longas; em casos raros pode cortar o comecinho de uma frase falada bem baixo."
              @update:model-value="(v) => set({ whisper_vad: v })"
            />
            <SettingToggle
              :model-value="store.settings.whisper_stream ?? false"
              label="Transcrever enquanto fala"
              description="Desligado (padrão): grava enquanto você segura a tecla e só transcreve quando solta. Ligado: vai transcrevendo durante a fala, e ao soltar o texto sai quase na hora. Cancelar continua igual."
              @update:model-value="(v) => set({ whisper_stream: v })"
            />
          </div>
        </div>

        <!-- Testar desempenho: compara modelos e opções no computador do usuário -->
        <div class="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-700/40">
          <p class="text-xs text-slate-500">
            Na dúvida sobre qual modelo ou opção usar? Compare todos no seu computador, com áudios de teste que já têm o texto correto.
          </p>
          <button
            class="flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-medium border border-indigo-600/50 bg-indigo-600/15 text-indigo-200 hover:bg-indigo-600/30 hover:text-white transition-colors"
            @click="navigate?.('benchmark')"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
            </svg>
            Testar desempenho
          </button>
        </div>
      </section>

      <!-- TTS - meia largura -->
      <section class="bg-slate-800/60 rounded-2xl p-5 border border-slate-700/40 flex flex-col gap-4">
        <h2 class="text-xs font-semibold text-slate-400 uppercase tracking-widest">Síntese de Voz</h2>
        <div class="flex gap-5">
          <label v-for="b in ['edge','elevenlabs']" :key="b" class="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              :value="b"
              :checked="store.settings.tts_backend === b"
              class="accent-indigo-500"
              @change="set({ tts_backend: b })"
            />
            <span class="text-sm text-slate-300">{{ b === 'edge' ? 'Edge TTS' : 'ElevenLabs' }}</span>
          </label>
        </div>
        <div v-if="store.settings.tts_backend === 'edge'">
          <label class="text-xs text-slate-500 block mb-1.5">Voz</label>
          <CustomSelect
            :model-value="store.settings.edge_voice"
            :options="edgeVoiceOptions"
            @update:model-value="(v) => set({ edge_voice: v })"
          />
        </div>
        <ElevenLabsConfig v-if="store.settings.tts_backend === 'elevenlabs'" />
      </section>

      <!-- Sons - meia largura, ao lado da Síntese de voz -->
      <section class="bg-slate-800/60 rounded-2xl p-5 border border-slate-700/40 flex flex-col gap-4">
        <h2 class="text-xs font-semibold text-slate-400 uppercase tracking-widest">Sons</h2>
        <SettingToggle
          :model-value="store.settings.sound_recording"
          label="Som ao iniciar gravação"
          @update:model-value="(v) => set({ sound_recording: v })"
        />
        <SettingToggle
          :model-value="store.settings.sound_processing"
          label="Som ao processar"
          @update:model-value="(v) => set({ sound_processing: v })"
        />
        <SettingToggle
          :model-value="store.settings.sound_copied"
          label="Som ao copiar"
          @update:model-value="(v) => set({ sound_copied: v })"
        />
      </section>

      <!-- Claude - largura total -->
      <section class="col-span-full bg-slate-800/60 rounded-2xl p-5 border border-slate-700/40 flex flex-col gap-4">
        <h2 class="text-xs font-semibold text-slate-400 uppercase tracking-widest">Claude</h2>
        <div v-if="claudeAccount" class="flex items-center justify-between gap-4">
          <div>
            <p class="text-sm text-slate-200">Conta Claude</p>
            <div v-if="claudeAccount.loggedIn" class="flex items-center gap-1.5 mt-0.5 text-xs flex-wrap">
              <span class="text-emerald-400">Conectada</span>
              <template v-if="claudeAccountText">
                <span class="text-slate-600">·</span>
                <HoldToReveal :text="claudeAccountText" label="Segure o clique para ver em qual conta" />
              </template>
            </div>
            <p v-else-if="!claudeAccount.installed" class="text-xs text-red-400 mt-0.5">Claude Code não instalado - reinstale o app</p>
            <p v-else-if="claudeWaiting" class="text-xs text-slate-400 mt-0.5">Termine o login na janela do terminal/navegador que abriu…</p>
            <p v-else class="text-xs text-slate-500 mt-0.5">Necessária para o Chat IA (assinatura Pro ou Max)</p>
          </div>
          <div v-if="claudeAccount.installed" class="flex items-center gap-2 flex-shrink-0">
            <button
              title="Verificar a conexão de novo"
              class="p-1.5 rounded-lg border border-slate-700 hover:border-slate-500 text-slate-400 hover:text-slate-200 transition-colors"
              @click="refreshClaude"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
              </svg>
            </button>
            <button
              v-if="!claudeAccount.loggedIn"
              :disabled="claudeWaiting"
              title="Abre uma janela de terminal com o login oficial da Anthropic"
              class="px-3 py-1.5 bg-orange-600 hover:bg-orange-500 disabled:opacity-60 text-white text-xs font-medium rounded-lg transition-colors"
              @click="loginClaude(false)"
            >
              {{ claudeWaiting ? 'Aguardando login…' : 'Entrar na conta' }}
            </button>
            <button
              v-else
              :disabled="claudeWaiting"
              title="Sai da conta atual e abre o login de novo"
              class="px-3 py-1.5 border border-slate-700 hover:border-slate-500 text-slate-300 text-xs rounded-lg transition-colors"
              @click="confirmSwitch = true"
            >
              {{ claudeWaiting ? 'Aguardando login…' : 'Trocar conta' }}
            </button>
          </div>
        </div>
        <!-- Coleta de dados do Claude Code pela empresa (telemetria): verificado ao abrir o app e a cada 30 min -->
        <ClaudeMonitoringStatus v-if="claudeAccount?.installed" class="-mt-1 pb-3 border-b border-slate-700/40" />
        <div class="flex flex-col gap-1.5">
          <p class="text-sm text-slate-200">Modelo do Claude</p>
          <p class="text-xs text-slate-500 leading-relaxed">
            Usado em todos os chats do Chat IA (também dá para trocar na caixa de mensagem). Vale só neste app:
            o Claude Code usado fora daqui continua com o modelo dele.
          </p>
          <CustomSelect
            :model-value="store.settings.claude_model || DEFAULT_CLAUDE_MODEL"
            :options="CLAUDE_MODEL_OPTIONS"
            @update:model-value="(v) => set({ claude_model: v })"
          />
        </div>
        <div class="flex flex-col gap-2 rounded-xl border border-slate-700/50 bg-slate-900/40 p-3.5">
          <div>
            <p class="text-sm text-slate-200">Uso do plano</p>
            <p class="text-xs text-slate-500 leading-relaxed mt-0.5">
              Os mesmos números de claude.ai, em Configurações e Uso. Atualizam depois de cada uso da IA: respostas do chat,
              busca e conferência de imagens, system prompt (também aparecem ao lado do botão de enviar, no Chat IA).
            </p>
          </div>
          <ClaudeUsageCard />
        </div>
        <SettingToggle
          :model-value="store.settings.web_search ?? true"
          label="Pesquisar na internet"
          description="A IA pode buscar notícias e informações recentes (preços, resultados, lançamentos) quando a pergunta pedir. As respostas com pesquisa demoram alguns segundos a mais."
          @update:model-value="(v) => set({ web_search: v })"
        />
        <div class="flex flex-col gap-1.5">
          <p class="text-sm text-slate-200">Tamanho máximo dos anexos do chat</p>
          <p class="text-xs text-slate-500 leading-relaxed">
            Vale para cada imagem ou arquivo de texto anexado no Chat IA. Imagens grandes são reduzidas antes de enviar.
            Arquivo de texto muito grande gasta mais do seu plano: a IA lê no máximo uns 200 mil caracteres de cada um.
            Fica a seu critério, de acordo com o uso da sua conta.
          </p>
          <CustomSelect
            :model-value="String(store.settings.upload_limit_mb ?? 2)"
            :options="UPLOAD_LIMITS"
            @update:model-value="(v) => set({ upload_limit_mb: Number(v) })"
          />
        </div>
        <p class="text-xs text-slate-500 leading-relaxed">
          O system prompt e o contexto da conversa agora são de cada chat: no Chat IA, use o seletor no topo
          para trocar de chat, o <span class="text-slate-400">+</span> para criar um novo e a engrenagem para
          renomear ou mudar o prompt. As perguntas por voz vão para o chat que estiver selecionado.
        </p>
      </section>

      <!-- Mídia no chat - largura total -->
      <section class="col-span-full bg-slate-800/60 rounded-2xl p-5 border border-slate-700/40 flex flex-col gap-4">
        <h2 class="text-xs font-semibold text-slate-400 uppercase tracking-widest">Imagens e vídeos no chat</h2>
        <SettingToggle
          :model-value="store.settings.media_enabled ?? true"
          label="Buscar imagens e vídeos"
          description="Ao pedir para ver ou achar uma imagem/vídeo, a IA busca na internet e mostra as miniaturas no Chat IA"
          @update:model-value="(v) => set({ media_enabled: v })"
        />
        <template v-if="store.settings.media_enabled ?? true">
          <SettingToggle
            :model-value="store.settings.media_proactive ?? true"
            label="A IA pode mandar imagens e vídeos por conta própria"
            description="Quando ajudar a explicar (ex.: como é um item, onde fica um lugar, um vídeo da luta de um chefe), a IA já complementa a resposta sem você precisar pedir"
            @update:model-value="(v) => set({ media_proactive: v })"
          />
          <div class="flex items-center justify-between gap-4">
            <div>
              <p class="text-sm text-slate-200">Máximo de imagens por busca</p>
              <p class="text-xs text-slate-500 mt-0.5">A IA pode pedir menos, conforme o pedido</p>
            </div>
            <CustomSelect
              class="w-36 flex-shrink-0"
              size="sm"
              align="right"
              :model-value="String(store.settings.media_max_images ?? 4)"
              :options="[2, 3, 4, 6, 8].map((n) => ({ value: String(n), label: `${n} imagens` }))"
              @update:model-value="(v) => set({ media_max_images: Number(v) })"
            />
          </div>
          <MediaProviderSettings
            :provider="store.settings.image_provider"
            :serper-key="store.settings.serper_api_key"
            @save="(patch) => set(patch)"
          />
        </template>
      </section>

      <!-- Armazenamento: quanto o app ocupa e o que dá para apagar - largura total -->
      <section class="col-span-full bg-slate-800/60 rounded-2xl p-5 border border-slate-700/40 flex flex-col gap-4">
        <h2 class="text-xs font-semibold text-slate-400 uppercase tracking-widest">Armazenamento</h2>
        <StorageSettings />
      </section>

      <!-- Confirmação: trocar a conta Claude -->
      <Teleport to="body">
        <div
          v-if="confirmSwitch"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-6"
          @click.self="confirmSwitch = false"
        >
          <div class="w-full max-w-md bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl p-5 flex flex-col gap-4">
            <div class="flex items-start gap-3">
              <div class="w-9 h-9 rounded-full bg-amber-500/15 border border-amber-500/30 flex items-center justify-center flex-shrink-0">
                <svg class="w-5 h-5 text-amber-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                </svg>
              </div>
              <div class="flex flex-col gap-1.5">
                <h3 class="text-base font-semibold text-slate-100">Trocar a conta Claude?</h3>
                <p class="text-sm text-slate-300 leading-relaxed">
                  Você será <span class="text-amber-300">desconectado da conta atual</span> neste computador.
                </p>
                <p class="text-xs text-slate-500 leading-relaxed">
                  Isso vale para todo o Claude Code da máquina - inclusive se você usa o <code class="text-slate-400">claude</code>
                  no terminal ou no editor. Em seguida abrimos a janela de login para você entrar com a outra conta.
                  Até terminar o login, o Chat IA fica sem resposta.
                </p>
              </div>
            </div>
            <div class="flex justify-end gap-2">
              <button
                class="px-3.5 py-2 rounded-lg text-xs border border-slate-700 hover:border-slate-500 text-slate-300 transition-colors"
                @click="confirmSwitch = false"
              >Cancelar</button>
              <button
                class="px-3.5 py-2 rounded-lg text-xs font-medium bg-amber-600 hover:bg-amber-500 text-white transition-colors"
                @click="confirmSwitchAccount"
              >Desconectar e entrar com outra conta</button>
            </div>
          </div>
        </div>
      </Teleport>


    </div>
  </div>

  <div v-else-if="store.loading" class="flex items-center justify-center h-32">
    <p class="text-slate-500 text-sm">Carregando configurações...</p>
  </div>

  <div v-else-if="store.error" class="flex items-center justify-center h-32">
    <p class="text-red-400 text-sm">{{ store.error }}</p>
  </div>
</template>
