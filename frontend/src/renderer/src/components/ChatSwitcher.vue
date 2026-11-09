<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import type { Chat } from '../types'

/** Seletor de chats do topo do Chat IA (mesmo visual do CustomSelect), com busca. */
const props = defineProps<{ chats: Chat[]; activeId: number | null; busyId: number | null }>()
const emit = defineEmits<{ select: [id: number]; edit: [chat: Chat]; delete: [chat: Chat] }>()

const open = ref(false)
const query = ref('')
const highlighted = ref(0)
const root = ref<HTMLElement | null>(null)
const listEl = ref<HTMLElement | null>(null)
const searchEl = ref<HTMLInputElement | null>(null)

const current = computed(() => props.chats.find((c) => c.id === props.activeId) ?? null)

const norm = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

const filtered = computed(() => {
  const q = norm(query.value.trim())
  if (!q) return props.chats
  return props.chats.filter((c) => norm(`${c.name} ${c.system_prompt}`).includes(q))
})

function promptPreview(c: Chat): string {
  const t = (c.system_prompt || '').trim().replace(/\s+/g, ' ')
  return t ? t : 'Sem system prompt (padrão do app)'
}

/** "agora", "há 5 min", "ontem", "12/10" (o SQLite grava em UTC) */
function when(ts?: string): string {
  if (!ts) return ''
  const d = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z')
  const diff = (Date.now() - d.getTime()) / 1000
  if (diff < 60) return 'agora'
  if (diff < 3600) return `há ${Math.floor(diff / 60)} min`
  if (diff < 86400) return `há ${Math.floor(diff / 3600)} h`
  if (diff < 172800) return 'ontem'
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
}

async function toggle(): Promise<void> {
  open.value = !open.value
  if (!open.value) return
  query.value = ''
  highlighted.value = Math.max(0, props.chats.findIndex((c) => c.id === props.activeId))
  await nextTick()
  searchEl.value?.focus()
  scrollToHighlighted()
}

function scrollToHighlighted(): void {
  nextTick(() => listEl.value?.querySelector('[data-hl="true"]')?.scrollIntoView({ block: 'nearest' }))
}

function choose(c: Chat): void {
  open.value = false
  if (c.id !== props.activeId) emit('select', c.id)
}

function onSearchKey(e: KeyboardEvent): void {
  const n = filtered.value.length
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (n) highlighted.value = (highlighted.value + 1) % n
    scrollToHighlighted()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (n) highlighted.value = (highlighted.value - 1 + n) % n
    scrollToHighlighted()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const c = filtered.value[highlighted.value]
    if (c) choose(c)
  }
}

function onQuery(): void {
  highlighted.value = 0
}

function action(kind: 'edit' | 'delete', c: Chat): void {
  open.value = false
  if (kind === 'edit') emit('edit', c)
  else emit('delete', c)
}

function onDocClick(e: MouseEvent): void {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') open.value = false
}
onMounted(() => {
  document.addEventListener('mousedown', onDocClick)
  window.addEventListener('keydown', onKey)
})
onUnmounted(() => {
  document.removeEventListener('mousedown', onDocClick)
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div ref="root" class="relative w-56 lg:w-72">
    <button
      type="button"
      :title="current ? `Chat atual: ${current.name}` : 'Escolher chat'"
      :class="[
        'w-full flex items-center gap-2.5 border text-left transition-colors px-3 py-1.5 rounded-xl',
        open ? 'border-indigo-500/60 bg-indigo-600/10' : 'border-slate-700/60 bg-slate-900/40 hover:border-indigo-500/60 hover:bg-indigo-600/10'
      ]"
      @click="toggle"
    >
      <span
        v-if="busyId !== null && busyId === activeId"
        class="w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse flex-shrink-0"
        title="Respondendo"
      />
      <div class="flex-1 min-w-0">
        <p class="text-sm font-medium text-slate-100 truncate">{{ current?.name ?? 'Carregando…' }}</p>
        <p class="text-[11px] text-slate-500 truncate leading-tight">{{ current ? promptPreview(current) : '' }}</p>
      </div>
      <svg :class="['w-4 h-4 text-slate-400 flex-shrink-0 transition-transform', open ? 'rotate-180' : '']" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
      </svg>
    </button>

    <div
      v-if="open"
      class="absolute top-full mt-1.5 left-1/2 -translate-x-1/2 z-30 w-[22rem] max-w-[calc(100vw-2rem)] rounded-xl border border-slate-700 bg-slate-900 shadow-2xl flex flex-col"
    >
      <!-- Busca -->
      <div class="p-1.5 border-b border-slate-800">
        <div class="flex items-center gap-2 rounded-lg bg-slate-800/70 px-2.5 py-1.5">
          <svg class="w-3.5 h-3.5 text-slate-500 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
          <input
            ref="searchEl"
            v-model="query"
            placeholder="Buscar chat..."
            class="flex-1 bg-transparent text-sm text-slate-200 placeholder-slate-500 focus:outline-none"
            @input="onQuery"
            @keydown="onSearchKey"
          />
        </div>
      </div>

      <div ref="listEl" class="p-1.5 flex flex-col gap-0.5 max-h-80 overflow-y-auto">
        <div
          v-for="(c, i) in filtered"
          :key="c.id"
          :data-hl="i === highlighted"
          :class="[
            'group flex items-center gap-2.5 rounded-lg px-2.5 py-2 cursor-pointer transition-colors',
            c.id === activeId ? 'bg-indigo-600/15' : i === highlighted ? 'bg-indigo-600/10' : 'hover:bg-indigo-600/10'
          ]"
          @click="choose(c)"
          @mouseenter="highlighted = i"
        >
          <span
            :class="[
              'w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center flex-shrink-0',
              c.id === activeId ? 'border-indigo-400' : 'border-slate-500'
            ]"
          >
            <span v-if="c.id === activeId" class="w-1.5 h-1.5 rounded-full bg-indigo-400" />
          </span>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-1.5">
              <span class="text-sm text-slate-200 truncate">{{ c.name }}</span>
              <span v-if="c.id === busyId" class="w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse flex-shrink-0" title="Respondendo" />
            </div>
            <p class="text-xs text-slate-500 truncate">{{ promptPreview(c) }}</p>
          </div>
          <!-- data (some no hover, dando lugar às ações) -->
          <span class="text-[11px] text-slate-600 flex-shrink-0 group-hover:hidden">{{ when(c.updated_at) }}</span>
          <div class="hidden group-hover:flex items-center gap-0.5 flex-shrink-0">
            <button
              type="button"
              title="Renomear e editar o prompt"
              class="p-1 rounded-md text-slate-400 hover:text-slate-100 hover:bg-slate-700"
              @click.stop="action('edit', c)"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
              </svg>
            </button>
            <button
              type="button"
              title="Excluir chat"
              class="p-1 rounded-md text-slate-400 hover:text-red-400 hover:bg-slate-700"
              @click.stop="action('delete', c)"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
              </svg>
            </button>
          </div>
        </div>
        <p v-if="!filtered.length" class="px-3 py-3 text-xs text-slate-500 text-center">Nenhum chat encontrado</p>
      </div>
    </div>
  </div>
</template>
