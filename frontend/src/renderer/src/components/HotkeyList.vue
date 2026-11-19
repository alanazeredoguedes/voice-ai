<script setup lang="ts">
import { ref } from 'vue'
import { captureHotkey } from '../api'

/**
 * Uma função (transcrição, IA, mostrar/esconder) numa linha: nome à esquerda e os atalhos à direita,
 * como teclas. Clicar num atalho troca ele; o "+" adiciona outro. Todos ficam ativos ao mesmo tempo.
 */
const props = defineProps<{ label: string; hint?: string; primary: string; extra: string[] }>()
/** sempre os dois juntos (principal e adicionais): remover o principal promove o primeiro adicional */
const emit = defineEmits<{ 'update:all': [primary: string, extra: string[]] }>()

/** Atalhos configurados, na ordem (o principal vazio = nenhum). */
const all = (): string[] => [props.primary, ...props.extra].filter(Boolean)

function save(list: string[]): void {
  emit('update:all', list[0] ?? '', list.slice(1))
}

/** qual atalho está esperando a tecla: 0 = principal, 1.. = adicionais, 'new' = novo */
const capturing = ref<number | 'new' | null>(null)
const error = ref<string | null>(null)

// Nomes dos botões do controle (layout PlayStation; posição física padrão da SDL)
const GAMEPAD_LABELS: Record<string, string> = {
  a: '✕', b: '○', x: '□', y: '△',
  lb: 'L1', rb: 'R1', lt: 'L2', rt: 'R2', ls: 'L3', rs: 'R3',
  up: '↑', down: '↓', left: '←', right: '→',
  back: 'Create', start: 'Options', guide: 'PS', touchpad: 'Touchpad', misc: 'Mic',
  p1: 'P1', p2: 'P2', p3: 'P3', p4: 'P4'
}
const KEY_LABELS: Record<string, string> = {
  ctrl: 'Ctrl', ctrl_l: 'Ctrl', ctrl_r: 'Ctrl dir.', alt: 'Alt', alt_l: 'Alt', alt_r: 'Alt Gr', alt_gr: 'Alt Gr',
  shift: 'Shift', shift_l: 'Shift', shift_r: 'Shift dir.', cmd: 'Super', super: 'Super', space: 'Espaço',
  esc: 'Esc', enter: 'Enter', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', insert: 'Insert',
  home: 'Home', end: 'End', page_up: 'PgUp', page_down: 'PgDn', up: '↑', down: '↓', left: '←', right: '→',
  caps_lock: 'Caps Lock', print_screen: 'PrtSc', pause: 'Pause', menu: 'Menu'
}
const MOUSE_LABELS: Record<string, string> = { left: 'Botão esquerdo', right: 'Botão direito', middle: 'Botão do meio' }

/** "<ctrl>+<alt>+<f12>" → ["Ctrl", "Alt", "F12"]; "gamepad:lb+a" → ["🎮 L1", "✕"] */
function keys(hotkey: string): string[] {
  if (!hotkey) return ['-']
  if (hotkey.startsWith('gamepad:')) {
    return hotkey
      .slice('gamepad:'.length)
      .split('+')
      .map((b, i) => (i === 0 ? '🎮 ' : '') + (GAMEPAD_LABELS[b] ?? b))
  }
  return hotkey.split('+').map((part) => {
    if (part.startsWith('mouse:')) {
      const b = part.slice('mouse:'.length)
      const n = b.match(/^button(\d+)$/)
      return n ? `Mouse ${n[1]}` : (MOUSE_LABELS[b] ?? `Mouse ${b}`)
    }
    const k = part.replace(/^<|>$/g, '')
    if (KEY_LABELS[k]) return KEY_LABELS[k]
    if (/^f\d+$/.test(k)) return k.toUpperCase()
    return k.length === 1 ? k.toUpperCase() : k.charAt(0).toUpperCase() + k.slice(1)
  })
}

function isDuplicate(hotkey: string, ignore: number): boolean {
  return all().some((k, i) => i !== ignore && k === hotkey)
}

/** Espera o novo atalho e grava no lugar certo. */
async function capture(slot: number | 'new'): Promise<void> {
  if (capturing.value !== null) return
  capturing.value = slot
  error.value = null
  try {
    const hotkey = await captureHotkey()
    if (isDuplicate(hotkey, slot === 'new' ? -1 : slot)) {
      error.value = 'Esse atalho já está nesta função'
      return
    }
    save(slot === 'new' ? [...all(), hotkey] : all().map((k, i) => (i === slot ? hotkey : k)))
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Nenhuma tecla pressionada'
  } finally {
    capturing.value = null
  }
}

function remove(index: number): void {
  error.value = null
  save(all().filter((_, i) => i !== index))
}
</script>

<template>
  <div class="grid grid-cols-1 md:grid-cols-[minmax(0,15rem)_1fr] gap-x-6 gap-y-2 py-3.5 first:pt-0 last:pb-0">
    <div class="min-w-0">
      <p class="text-sm text-slate-200">{{ label }}</p>
      <p v-if="hint" class="text-xs text-slate-500 mt-0.5 leading-relaxed">{{ hint }}</p>
    </div>

    <div class="flex flex-col gap-1.5 min-w-0">
      <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
      <div class="flex flex-wrap items-center gap-2">
        <span v-if="!all().length && capturing === null" class="text-xs text-slate-500 italic">Nenhum atalho (função desligada)</span>
        <template v-for="(hotkey, i) in all()" :key="`${i}:${hotkey}`">
          <div class="relative group">
            <button
              :disabled="capturing !== null && capturing !== i"
              :class="[
                'flex items-center gap-1 h-9 px-2 rounded-lg border transition-colors',
                capturing === i
                  ? 'border-orange-500/70 bg-orange-500/10 animate-pulse'
                  : 'border-slate-700 bg-slate-900/50 hover:border-indigo-500/60 hover:bg-slate-900 disabled:opacity-50'
              ]"
              :title="capturing === i ? '' : 'Clique para trocar este atalho'"
              @click="capture(i)"
            >
              <span v-if="capturing === i" class="px-1 text-xs text-orange-300">Pressione o atalho…</span>
              <template v-else>
                <template v-for="(k, j) in keys(hotkey)" :key="j">
                  <span v-if="j" class="text-[10px] text-slate-600">+</span>
                  <kbd
                    class="min-w-[1.6rem] px-1.5 py-0.5 rounded-md bg-slate-700/70 border-b-2 border-slate-950/60 text-xs font-medium text-slate-100 text-center font-sans"
                  >{{ k }}</kbd>
                </template>
              </template>
            </button>
            <button
              v-if="capturing === null"
              class="absolute -top-1.5 -right-1.5 w-[18px] h-[18px] rounded-full bg-slate-600 hover:bg-red-600 text-white items-center justify-center hidden group-hover:flex shadow"
              :title="all().length === 1 ? 'Remover (a função fica sem atalho)' : 'Remover este atalho'"
              @click="remove(i)"
            >
              <svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </template>

        <button
          :disabled="capturing !== null && capturing !== 'new'"
          :class="[
            'flex items-center gap-1.5 h-9 px-3 rounded-lg border border-dashed text-xs transition-colors',
            capturing === 'new'
              ? 'border-orange-500/70 bg-orange-500/10 text-orange-300 animate-pulse'
              : 'border-slate-600 text-slate-500 hover:text-slate-200 hover:border-slate-400 disabled:opacity-50'
          ]"
          title="Adicionar outro atalho para esta função"
          @click="capture('new')"
        >
          <template v-if="capturing === 'new'">Pressione o atalho…</template>
          <template v-else>
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            {{ all().length ? 'Adicionar' : 'Escolher atalho' }}
          </template>
        </button>
      </div>
      <!-- opção da função, alinhada à direita dos atalhos (desce para baixo em janelas estreitas) -->
      <slot name="aside" />
      </div>
      <p v-if="capturing !== null" class="text-xs text-slate-500">Teclado, mouse ou controle (no controle, segure a combinação e solte).</p>
      <p v-if="error" class="text-xs text-red-400">{{ error }}</p>
    </div>
  </div>
</template>
