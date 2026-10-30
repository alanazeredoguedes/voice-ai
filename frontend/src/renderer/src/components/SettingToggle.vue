<script setup lang="ts">
defineProps<{ modelValue: boolean; label: string; description?: string }>()
defineEmits<{ 'update:modelValue': [v: boolean] }>()
</script>

<template>
  <label class="flex items-center justify-between gap-4 cursor-pointer group">
    <div>
      <p class="text-sm text-slate-200 group-hover:text-white transition-colors">{{ label }}</p>
      <p v-if="description" class="text-xs text-slate-500 mt-0.5">{{ description }}</p>
    </div>
    <!-- w-11=44px h-6=24px  thumb w-5=20px h-5=20px → margem 2px em cada lado -->
    <button
      type="button"
      role="switch"
      :aria-checked="modelValue"
      :class="[
        'relative inline-flex items-center w-11 h-6 rounded-full transition-colors duration-200 flex-shrink-0 focus:outline-none',
        modelValue ? 'bg-indigo-600' : 'bg-slate-700'
      ]"
      @click="$emit('update:modelValue', !modelValue)"
    >
      <span
        :class="[
          'inline-block w-5 h-5 rounded-full bg-white shadow-sm transition-transform duration-200',
          modelValue ? 'translate-x-5' : 'translate-x-0.5'
        ]"
      />
    </button>
  </label>
</template>
