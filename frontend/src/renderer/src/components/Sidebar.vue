<script setup lang="ts">
type View = 'status' | 'settings' | 'transcribe' | 'logs' | 'translate' | 'chat'

const props = defineProps<{ modelValue: View }>()
const emit = defineEmits<{ 'update:modelValue': [v: View] }>()

const topNav: { id: View; label: string; icon: string }[] = [
  {
    id: 'status',
    label: 'Transcrição de Microfone',
    icon: 'M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z'
  },
  {
    id: 'transcribe',
    label: 'Transcrever Arquivo',
    icon: 'M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z'
  },
  {
    id: 'translate',
    label: 'Traduzir',
    icon: 'M10.5 21l5.25-11.25L21 21m-9-3h7.5M3 5.621a48.474 48.474 0 016-.371m0 0c1.12 0 2.233.038 3.334.114M9 5.25V3m3.334 2.364C11.176 10.658 7.69 15.08 3 17.502m9.334-12.138c.896.061 1.785.147 2.666.257m-4.589 8.495a18.023 18.023 0 01-3.827-5.802'
  },
  {
    id: 'chat',
    label: 'Chat IA',
    icon: 'M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z'
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
