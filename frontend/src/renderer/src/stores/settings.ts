import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Settings } from '../types'
import * as api from '../api'

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<Settings | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function fetchSettings(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      settings.value = await api.getSettings()
    } catch (e) {
      error.value = String(e)
    } finally {
      loading.value = false
    }
  }

  async function update(patch: Partial<Settings>): Promise<void> {
    if (!settings.value) return
    const prev = { ...settings.value }
    settings.value = { ...settings.value, ...patch }
    try {
      settings.value = await api.updateSettings(patch)
    } catch (e) {
      settings.value = prev
      error.value = String(e)
      throw e
    }
  }

  return { settings, loading, error, fetchSettings, update }
})
