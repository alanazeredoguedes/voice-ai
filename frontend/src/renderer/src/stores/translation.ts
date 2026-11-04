import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { TranslatePackage } from '../types'
import { getTranslatePackages } from '../api'

export const useTranslationStore = defineStore('translation', () => {
  const packages = ref<TranslatePackage[]>([])
  const fromCode = ref('en')
  const toCode = ref('pt')
  const lastInput = ref('')
  const lastOutput = ref('')
  const loading = ref(false)

  const installedPairs = computed(() => packages.value.filter(p => p.installed))
  const hasAnyInstalled = computed(() => installedPairs.value.length > 0)

  const canTranslate = computed(() =>
    installedPairs.value.some(p => p.from_code === fromCode.value && p.to_code === toCode.value)
  )

  async function fetchPackages(): Promise<void> {
    loading.value = true
    try {
      packages.value = await getTranslatePackages()
    } finally {
      loading.value = false
    }
  }

  function markInstalled(from: string, to: string): void {
    const pkg = packages.value.find(p => p.from_code === from && p.to_code === to)
    if (pkg) pkg.installed = true
  }

  function markRemoved(from: string, to: string): void {
    const pkg = packages.value.find(p => p.from_code === from && p.to_code === to)
    if (pkg) pkg.installed = false
  }

  return {
    packages,
    fromCode,
    toCode,
    lastInput,
    lastOutput,
    loading,
    installedPairs,
    hasAnyInstalled,
    canTranslate,
    fetchPackages,
    markInstalled,
    markRemoved,
  }
})
