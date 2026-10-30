<script setup lang="ts">
defineProps<{ level: number }>()
</script>

<template>
  <div class="w-full bg-slate-800 rounded-full h-2 overflow-hidden">
    <div
      class="h-full rounded-full transition-all duration-75"
      :class="level > 0.7 ? 'bg-orange-500' : level > 0.4 ? 'bg-yellow-500' : 'bg-emerald-500'"
      :style="{ width: `${Math.min(level * 100, 100)}%` }"
    />
  </div>
</template>
