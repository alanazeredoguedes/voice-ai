import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { TranslatePackage } from '../types'
import { getTranslatePackages } from '../api'

export const useTranslationStore = defineStore('translation', () => {
  const packages = ref<TranslatePackage[]>([])
  // última escolha fica salva (vale entre aberturas do app)
  const saved = (key: string, fallback: string): string => {
    try {
      return localStorage.getItem(key) || fallback
    } catch {
      return fallback
    }
  }
  const fromCode = ref(saved('translate.from', 'en'))
  const toCode = ref(saved('translate.to', 'pb'))
  watch([fromCode, toCode], ([f, t]) => {
    try {
      localStorage.setItem('translate.from', f)
      localStorage.setItem('translate.to', t)
    } catch {
      /* sem armazenamento: só não lembra */
    }
  })
  const lastInput = ref('')
  const lastOutput = ref('')
  const loading = ref(false)

  const installedPairs = computed(() => packages.value.filter(p => p.installed))
  const hasAnyInstalled = computed(() => installedPairs.value.length > 0)

  const canTranslate = computed(() =>
    installedPairs.value.some(p => p.from_code === fromCode.value && p.to_code === toCode.value)
  )

  /**
   * Com algum modelo instalado, os dois seletores sempre ficam preenchidos com um par que existe: mantém a
   * escolha atual se ela vale; senão prefere inglês → português do Brasil, depois português, depois o primeiro.
   */
  function ensureSelection(): void {
    const pairs = installedPairs.value
    if (!pairs.length) return
    const valid = (f: string, t: string): boolean => pairs.some((p) => p.from_code === f && p.to_code === t)
    if (valid(fromCode.value, toCode.value)) return
    // mesmo idioma de origem, outro destino
    const sameFrom = pairs.filter((p) => p.from_code === fromCode.value)
    const prefer = ['pb', 'pt']
    const pickTo = (list: typeof pairs) => prefer.map((c) => list.find((p) => p.to_code === c)).find(Boolean) ?? list[0]
    if (sameFrom.length) {
      toCode.value = pickTo(sameFrom)!.to_code
      return
    }
    const fromEn = pairs.filter((p) => p.from_code === 'en')
    const pair = fromEn.length ? pickTo(fromEn)! : pickTo(pairs)!
    fromCode.value = pair.from_code
    toCode.value = pair.to_code
  }

  async function fetchPackages(): Promise<void> {
    loading.value = true
    try {
      packages.value = await getTranslatePackages()
      ensureSelection()
    } finally {
      loading.value = false
    }
  }

  function markInstalled(from: string, to: string): void {
    const pkg = packages.value.find(p => p.from_code === from && p.to_code === to)
    if (pkg) pkg.installed = true
    ensureSelection()
  }

  function markRemoved(from: string, to: string): void {
    const pkg = packages.value.find(p => p.from_code === from && p.to_code === to)
    if (pkg) pkg.installed = false
    ensureSelection()
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
    ensureSelection,
  }
})
