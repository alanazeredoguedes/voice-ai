<script setup lang="ts">
/** Modal de confirmação (mesmo visual do "Trocar conta" das Configurações). */
withDefaults(
  defineProps<{
    open: boolean
    title: string
    confirmLabel: string
    tone?: 'danger' | 'warning'
    loading?: boolean
  }>(),
  { tone: 'danger', loading: false }
)
const emit = defineEmits<{ confirm: []; cancel: [] }>()
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm p-6"
      @click.self="emit('cancel')"
      @keydown.esc="emit('cancel')"
    >
      <div class="w-full max-w-md bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl p-5 flex flex-col gap-4">
        <div class="flex items-start gap-3">
          <div
            :class="[
              'w-9 h-9 rounded-full border flex items-center justify-center flex-shrink-0',
              tone === 'danger' ? 'bg-red-500/15 border-red-500/30' : 'bg-amber-500/15 border-amber-500/30'
            ]"
          >
            <svg
              :class="['w-5 h-5', tone === 'danger' ? 'text-red-400' : 'text-amber-400']"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              viewBox="0 0 24 24"
            >
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
          </div>
          <div class="flex flex-col gap-1.5 min-w-0">
            <h3 class="text-base font-semibold text-slate-100 break-words">{{ title }}</h3>
            <div class="text-sm text-slate-300 leading-relaxed"><slot /></div>
          </div>
        </div>
        <div class="flex justify-end gap-2">
          <button
            class="px-3.5 py-2 rounded-lg text-xs border border-slate-700 hover:border-slate-500 text-slate-300 transition-colors"
            @click="emit('cancel')"
          >Cancelar</button>
          <button
            :disabled="loading"
            :class="[
              'px-3.5 py-2 rounded-lg text-xs font-medium text-white transition-colors disabled:opacity-60',
              tone === 'danger' ? 'bg-red-600 hover:bg-red-500' : 'bg-amber-600 hover:bg-amber-500'
            ]"
            @click="emit('confirm')"
          >{{ confirmLabel }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
