/**
 * Atualização do app: espelha o estado do updater do processo principal (main/updater.ts).
 * O estado é um só para o app todo: o aviso no topo e a linha nas Configurações leem daqui.
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { syslog } from '../utils/syslog'

export type UpdateState =
  | { status: 'unsupported'; version: string }
  | { status: 'idle'; version: string }
  | { status: 'checking'; version: string }
  | { status: 'available'; version: string; newVersion: string; notes: string; error?: string }
  | { status: 'downloading'; version: string; newVersion: string; percent: number }
  | { status: 'ready'; version: string; newVersion: string }
  | { status: 'error'; version: string; message: string }

export const useUpdateStore = defineStore('update', () => {
  const state = ref<UpdateState>({ status: 'idle', version: '' })
  const ipc = window.electron.ipcRenderer
  let started = false

  async function init(): Promise<void> {
    if (started) return
    started = true
    ipc.on('update:state', (_e, s: UpdateState) => {
      state.value = s
    })
    try {
      state.value = (await ipc.invoke('update:state')) as UpdateState
    } catch {
      // processo principal antigo/sem updater: fica sem o recurso
    }
  }

  /** Verificação manual (botão das Configurações). */
  function check(): void {
    syslog('info', 'atualização', 'verificação manual')
    void ipc.invoke('update:check')
  }

  /** Baixa e, ao terminar, reinicia e instala (o usuário já confirmou no modal). */
  function install(): void {
    syslog('info', 'atualização', 'usuário confirmou a atualização')
    void ipc.invoke('update:download')
  }

  return { state, init, check, install }
})
