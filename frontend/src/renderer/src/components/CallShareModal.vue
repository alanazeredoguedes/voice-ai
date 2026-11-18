<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import CustomSelect from './CustomSelect.vue'
import { useCallStore, type ShareQuality, type ShareSource } from '../stores/call'

/** Escolha do que compartilhar na chamada: uma tela inteira ou uma janela, e a qualidade. */
const emit = defineEmits<{ close: []; start: [sourceId: string, quality: ShareQuality, withAudio: boolean] }>()

const RESOLUTIONS = [
  { id: '480', label: '480p', width: 854, height: 480 },
  { id: '720', label: '720p', width: 1280, height: 720 },
  { id: '1080', label: '1080p', width: 1920, height: 1080 },
  { id: '1440', label: '2K', width: 2560, height: 1440 },
  { id: '2160', label: '4K', width: 3840, height: 2160 }
]
const RES_KEY = 'call.shareResolution'
const FPS_KEY = 'call.shareFps'
const AUDIO_KEY = 'call.shareAudio'

const store = useCallStore()
const sources = ref<ShareSource[]>([])
const loading = ref(true)
const selected = ref<ShareSource | null>(null)
const resolution = ref(localStorage.getItem(RES_KEY) || '1080')
const fps = ref(localStorage.getItem(FPS_KEY) || '30')
const withAudio = ref(localStorage.getItem(AUDIO_KEY) !== '0')

const screens = computed(() => sources.value.filter((s) => s.isScreen))
const windows = computed(() => sources.value.filter((s) => !s.isScreen))

onMounted(async () => {
  // Wayland: listar as telas abre o seletor do sistema; ele só abre ao clicar em Compartilhar
  if (store.isWayland) {
    loading.value = false
    return
  }
  try {
    sources.value = await store.listSources()
    if (screens.value.length === 1 && windows.value.length === 0) selected.value = screens.value[0]
  } finally {
    loading.value = false
  }
})

const picking = ref(false)
const pickError = ref('')

/** Wayland: abre o seletor do sistema (a pessoa escolhe lá) e já começa com o que ela escolheu. */
async function pickWithSystem(): Promise<void> {
  picking.value = true
  pickError.value = ''
  try {
    const picked = await store.listSources()
    if (!picked.length) {
      pickError.value = 'Nada foi escolhido no seletor do sistema.'
      return
    }
    selected.value = picked[0]
    start()
  } catch (e) {
    pickError.value = `Não foi possível abrir o seletor do sistema: ${e instanceof Error ? e.message : e}`
  } finally {
    picking.value = false
  }
}

function start(): void {
  if (store.isWayland && !selected.value) {
    void pickWithSystem()
    return
  }
  if (!selected.value) return
  localStorage.setItem(RES_KEY, resolution.value)
  localStorage.setItem(FPS_KEY, fps.value)
  localStorage.setItem(AUDIO_KEY, withAudio.value ? '1' : '0')
  const res = RESOLUTIONS.find((r) => r.id === resolution.value) ?? RESOLUTIONS[2]
  const quality: ShareQuality = { label: `${res.label} - ${fps.value} fps`, width: res.width, height: res.height, fps: Number(fps.value) }
  emit('start', selected.value.id, quality, withAudio.value)
}
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm p-6"
      @click.self="emit('close')"
    >
      <div class="w-full max-w-2xl max-h-[85vh] bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl flex flex-col">
        <div class="flex items-center justify-between px-5 py-3.5 border-b border-slate-700/60 flex-shrink-0">
          <h3 class="text-base font-semibold text-slate-100">Compartilhar tela</h3>
          <button class="p-1.5 rounded text-slate-500 hover:text-slate-300 transition-colors" title="Fechar" @click="emit('close')">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <!-- a lista do seletor abre para baixo: fica aqui em cima para não sair da janela -->
        <div class="flex items-center gap-3 px-5 py-3 border-b border-slate-700/60 flex-shrink-0">
          <span class="text-xs text-slate-500">Qualidade</span>
          <CustomSelect v-model="resolution" class="w-28" size="sm" :options="RESOLUTIONS.map((r) => ({ value: r.id, label: r.label }))" />
          <span class="text-xs text-slate-500 ml-2">FPS</span>
          <CustomSelect
            v-model="fps"
            class="w-24"
            size="sm"
            :options="[
              { value: '30', label: '30' },
              { value: '60', label: '60' },
              { value: '90', label: '90' }
            ]"
          />
          <div class="flex-1" />
          <label class="flex items-center gap-2.5 cursor-pointer select-none" title="Transmitir o som do computador">
            <span class="text-xs text-slate-500">Som</span>
            <button
              type="button"
              role="switch"
              :aria-checked="withAudio"
              :class="['relative inline-flex items-center w-11 h-6 rounded-full transition-colors duration-200 flex-shrink-0', withAudio ? 'bg-indigo-600' : 'bg-slate-700']"
              @click="withAudio = !withAudio"
            >
              <span :class="['inline-block w-5 h-5 rounded-full bg-white shadow-sm transition-transform duration-200', withAudio ? 'translate-x-5' : 'translate-x-0.5']" />
            </button>
          </label>
        </div>

        <div class="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-5 min-h-0">
          <div v-if="store.isWayland" class="flex flex-col items-center gap-2 text-center py-8 px-6">
            <p class="text-sm text-slate-200">Escolha a qualidade e clique em <strong>Compartilhar</strong>.</p>
            <p class="text-xs text-slate-500 max-w-md">
              No Ubuntu com Wayland, o próprio sistema abre a janela para você escolher a tela ou a janela. É uma exigência de
              segurança do Wayland: nenhum aplicativo consegue ver as telas sem ela (o Chrome, o Discord e o Meet mostram a mesma).
            </p>
            <p v-if="picking" class="text-xs text-indigo-300">Aguardando você escolher no seletor do sistema…</p>
            <p v-if="pickError" class="text-xs text-red-400">{{ pickError }}</p>
          </div>
          <p v-else-if="loading" class="text-sm text-slate-500 text-center py-10">Procurando telas e janelas…</p>
          <p v-else-if="!sources.length && !store.isWayland" class="text-sm text-slate-500 text-center py-10">
            Nenhuma tela ou janela disponível para compartilhar.
          </p>
          <template v-for="group in [{ title: 'Telas', items: screens }, { title: 'Janelas', items: windows }]" :key="group.title">
            <div v-if="group.items.length" class="flex flex-col gap-2">
              <p class="text-xs text-slate-500 uppercase tracking-wide">{{ group.title }}</p>
              <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <button
                  v-for="src in group.items"
                  :key="src.id"
                  :class="[
                    'flex flex-col gap-2 p-2 rounded-xl border transition-colors text-left',
                    selected?.id === src.id
                      ? 'border-indigo-500 bg-indigo-500/10'
                      : 'border-slate-700/60 bg-slate-800/60 hover:border-slate-500'
                  ]"
                  @click="selected = src"
                  @dblclick="start"
                >
                  <div class="w-full aspect-video rounded-lg bg-slate-950 overflow-hidden flex items-center justify-center">
                    <img v-if="src.thumbnail" :src="src.thumbnail" class="w-full h-full object-contain" />
                  </div>
                  <span class="text-xs text-slate-300 truncate w-full">{{ src.name }}</span>
                </button>
              </div>
            </div>
          </template>
        </div>

        <div class="flex items-center gap-3 px-5 py-3.5 border-t border-slate-700/60 flex-shrink-0">
          <div class="flex-1" />
          <button
            class="px-3.5 py-2 rounded-lg text-xs border border-slate-700 hover:border-slate-500 text-slate-300 transition-colors"
            @click="emit('close')"
          >Cancelar</button>
          <button
            :disabled="store.isWayland ? picking : !selected"
            class="px-3.5 py-2 rounded-lg text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            @click="start"
          >Compartilhar</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
