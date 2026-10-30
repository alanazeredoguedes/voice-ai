import type { StateEvent } from '../types'

type Handler = (event: StateEvent) => void

const WS_URL = 'ws://127.0.0.1:18450/ws'
const PING_INTERVAL_MS = 30_000
const MAX_BACKOFF_MS = 16_000

let socket: WebSocket | null = null
let pingTimer: ReturnType<typeof setInterval> | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let backoffMs = 500
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

  socket.onclose = () => {
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
