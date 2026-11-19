import type { StateEvent } from '../types'
import { BACKEND_PORT } from './port'
import { syslog } from '../utils/syslog'

type Handler = (event: StateEvent) => void

const WS_URL = `ws://127.0.0.1:${BACKEND_PORT}/ws`
const PING_INTERVAL_MS = 30_000
const MAX_BACKOFF_MS = 16_000

let socket: WebSocket | null = null
let pingTimer: ReturnType<typeof setInterval> | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let backoffMs = 500
let wasOpen = false
let downSince = 0
const handlers: Handler[] = []

export function onWsMessage(handler: Handler): () => void {
  handlers.push(handler)
  return () => {
    const i = handlers.indexOf(handler)
    if (i !== -1) handlers.splice(i, 1)
  }
}

function dispatch(event: StateEvent): void {
  handlers.forEach((h) => h(event))
}

function startPing(): void {
  pingTimer = setInterval(() => socket?.send('ping'), PING_INTERVAL_MS)
}

function stopPing(): void {
  if (pingTimer) {
    clearInterval(pingTimer)
    pingTimer = null
  }
}

function scheduleReconnect(): void {
  reconnectTimer = setTimeout(() => {
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
    connect()
  }, backoffMs)
}

export function connect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  socket = new WebSocket(WS_URL)

  socket.onopen = () => {
    if (downSince) syslog('info', 'conexão', `conexão em tempo real com o backend voltou (ficou ${Math.round((Date.now() - downSince) / 1000)} s fora)`)
    wasOpen = true
    downSince = 0
    backoffMs = 500
    startPing()
  }

  socket.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data) as StateEvent
      dispatch(event)
    } catch {
      // ignore malformed messages
    }
  }

  socket.onclose = (e) => {
    if (wasOpen) syslog('warn', 'conexão', `conexão em tempo real com o backend caiu (código ${e.code}); tentando de novo`)
    wasOpen = false
    if (!downSince) downSince = Date.now()
    stopPing()
    scheduleReconnect()
  }

  socket.onerror = () => {
    socket?.close()
  }
}

export function disconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  stopPing()
  socket?.close()
  socket = null
}
