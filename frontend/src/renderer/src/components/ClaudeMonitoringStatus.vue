<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

/** Espelha MonitoringReport (src/main/claudeMonitoring.ts) */
interface MonitoringReport {
  checkedAt: string
  level: 'none' | 'metrics' | 'content'
  telemetryEnabled: boolean
  collects: { prompts: boolean; responses: boolean; toolDetails: boolean; fullConversation: boolean }
  destinations: string[]
  configuredBy: string[]
  managedHooks: boolean
  notice: string | null
  managedSources: string[]
  checked: string[]
}

const report = ref<MonitoringReport | null>(null)
const loading = ref(false)
const showDetails = ref(false)

async function check(): Promise<void> {
  loading.value = true
  try {
    report.value = (await window.electron?.ipcRenderer.invoke('claude:monitoring')) ?? null
  } catch {
    report.value = null
  } finally {
    loading.value = false
  }
}

onMounted(check)

// configuração vinda de fora (painel ou política do computador): tem prioridade sobre as suas
const managed = computed(() => report.value?.configuredBy.some((b) => b !== 'suas configurações') ?? false)

const collected = computed(() => {
  const c = report.value?.collects
  if (!c) return []
  const out: string[] = []
  if (c.fullConversation) out.push('A conversa inteira (seus prompts e as respostas do Claude)')
  else {
    if (c.prompts) out.push('O texto dos seus prompts')
    if (c.responses) out.push('As respostas do Claude')
  }
  if (c.toolDetails) out.push('Os comandos e ferramentas usados (ex.: comandos de terminal)')
  out.push('Métricas de uso (quantidade, tokens, custo)')
  return out
})

const checkedTime = computed(() =>
  report.value ? new Date(report.value.checkedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : ''
)
</script>

<template>
  <div v-if="report" class="flex flex-col gap-1.5 text-xs">
    <!-- Resumo -->
    <div class="flex items-start gap-2">
      <!-- escudo -->
      <svg
        :class="[
          'w-4 h-4 flex-shrink-0 mt-px',
          report.level === 'none' ? 'text-emerald-400' : report.level === 'metrics' ? 'text-amber-400' : 'text-red-400'
        ]"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        viewBox="0 0 24 24"
      >
        <path v-if="report.level === 'none'" stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
        <path v-else stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m0-10.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.75c0 5.592 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.57-.598-3.75h-.152c-3.196 0-6.1-1.249-8.25-3.286zm0 13.036h.008v.008H12v-.008z" />
      </svg>

      <div class="flex-1 min-w-0 flex flex-col gap-0.5">
        <p v-if="report.level === 'none'" class="text-slate-300">
          Nenhuma coleta de dados: seus prompts no Claude Code não estão sendo enviados para nenhum servidor externo.
        </p>
        <p v-else-if="report.level === 'metrics'" class="text-amber-300">
          Há uma coleta de métricas de uso configurada no Claude Code
          (sem o texto dos prompts)<template v-if="report.destinations.length">, enviada para {{ report.destinations.join(', ') }}</template>.
        </p>
        <p v-else class="text-red-300 font-medium">
          Há uma coleta de dados dos seus prompts configurada no Claude Code<template v-if="report.destinations.length">,
          enviada para {{ report.destinations.join(', ') }}</template>. O que está sendo coletado:
        </p>

        <ul v-if="report.level === 'content'" class="list-disc pl-4 text-red-300/90 marker:text-red-400/60">
          <li v-for="c in collected" :key="c">{{ c }}</li>
        </ul>

        <p v-if="report.level !== 'none' && report.configuredBy.length" class="text-slate-500">
          Origem da configuração: {{ report.configuredBy.join(', ') }}.<template v-if="managed"> Ela tem prioridade sobre as suas configurações.</template>
        </p>
        <p v-if="report.managedHooks" class="text-amber-300">
          Também há scripts automáticos (hooks) configurados que rodam junto com o Claude Code e podem enviar dados.
        </p>
        <p v-if="report.notice" class="text-amber-300">Aviso de monitoramento na conta: “{{ report.notice }}”</p>
        <p v-if="report.level === 'none' && report.managedSources.length" class="text-slate-500">
          Há configurações gerenciadas aplicadas ao seu Claude Code, mas nenhuma delas coleta dados.
        </p>

        <div class="flex items-center gap-2 text-slate-600">
          <span>Verificado às {{ checkedTime }} · repete ao abrir o app e a cada 30 min</span>
          <button class="text-indigo-400 hover:text-indigo-300" @click="showDetails = !showDetails">
            {{ showDetails ? 'ocultar detalhes' : 'o que foi verificado?' }}
          </button>
          <button
            :disabled="loading"
            class="text-indigo-400 hover:text-indigo-300 disabled:opacity-50"
            @click="check"
          >{{ loading ? 'verificando…' : 'verificar agora' }}</button>
        </div>

        <ul v-if="showDetails" class="mt-1 flex flex-col gap-0.5 rounded-lg bg-slate-900/60 border border-slate-800 px-3 py-2">
          <li v-for="c in report.checked" :key="c" class="flex items-center gap-1.5 text-slate-400">
            <svg class="w-3 h-3 text-emerald-500 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            {{ c }}
          </li>
          <li class="text-slate-600 mt-1">
            A verificação só lê arquivos deste computador; nada é alterado nem enviado. Se alguma coleta for ativada,
            você recebe uma notificação do Windows.
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>
