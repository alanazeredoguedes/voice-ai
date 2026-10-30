import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { TranscribeResult } from '../api'

export const useTranscribeStore = defineStore('transcribe', () => {
  const result = ref<TranscribeResult | null>(null)
  const fileNames = ref<string[]>([])

  function setResult(r: TranscribeResult, names: string[]): void {
    result.value = r
    fileNames.value = names
  }

  function clear(): void {
    result.value = null
    fileNames.value = []
  }

  return { result, fileNames, setResult, clear }
})
