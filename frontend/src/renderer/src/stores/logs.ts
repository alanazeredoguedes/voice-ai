import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LogEntry } from '../types'
import * as api from '../api'

export const useLogsStore = defineStore('logs', () => {
  const items = ref<LogEntry[]>([])
  const total = ref(0)
  const loading = ref(false)
  const limit = 50

  async function fetchPage(offset = 0): Promise<void> {
    loading.value = true
    try {
      const page = await api.getLogs(limit, offset)
      items.value = page.items
      total.value = page.total
    } finally {
      loading.value = false
    }
  }

  function prependEntry(entry: LogEntry): void {
    items.value.unshift(entry)
    total.value++
  }

  async function clear(): Promise<void> {
    await api.clearLogs()
    items.value = []
    total.value = 0
  }

  return { items, total, loading, limit, fetchPage, prependEntry, clear }
})
