<script setup lang="ts">
type View = 'status' | 'settings' | 'transcribe' | 'logs'

const props = defineProps<{ modelValue: View }>()
const emit = defineEmits<{ 'update:modelValue': [v: View] }>()

const topNav: { id: View; label: string; icon: string }[] = [
  {
    id: 'status',
    label: 'Ao Vivo',
    icon: 'M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z'
  },
  {
    id: 'transcribe',
    label: 'Transcrever Arquivo',
    icon: 'M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z'
  },
]

const bottomNav: { id: View; label: string; icon: string }[] = [
  {
    id: 'logs',
    label: 'Logs',
    icon: 'M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z'
  },
  {
    id: 'settings',
    label: 'Configurações',
    icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z'
  },
]
</script>

<template>
  <aside class="w-16 flex flex-col bg-slate-900 border-r border-slate-700/50 py-4">
    <div class="flex-1 flex flex-col gap-1 px-2">
      <button
        v-for="item in topNav"
        :key="item.id"
        :title="item.label"
        :class="[
          'flex flex-col items-center gap-1 p-2 rounded-lg transition-colors text-xs',
          props.modelValue === item.id
            ? 'bg-indigo-600 text-white'
            : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100'
        ]"
        @click="emit('update:modelValue', item.id)"
      >
        <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" :d="item.icon" />
        </svg>
      </button>
    </div>

    <div class="flex flex-col gap-1 px-2">
      <button
        v-for="item in bottomNav"
        :key="item.id"
        :title="item.label"
        :class="[
          'flex flex-col items-center gap-1 p-2 rounded-lg transition-colors text-xs',
          props.modelValue === item.id
            ? 'bg-indigo-600 text-white'
            : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100'
        ]"
        @click="emit('update:modelValue', item.id)"
      >
        <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" :d="item.icon" />
        </svg>
      </button>
    </div>
  </aside>
</template>
