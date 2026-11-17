/**
 * Chamada: conexões WebRTC em malha (cada participante fala direto com cada um dos outros).
 *
 * O WebSocket de sinalização só serve para o handshake; voz, tela, chat e arquivos trafegam P2P.
 * Cada conexão carrega: microfone, vídeo da tela, áudio da tela, um DataChannel "call" (mensagens)
 * e um DataChannel "file" por arquivo enviado.
 *
 * A tela compartilhada só é enviada a quem está assistindo: as faixas ficam negociadas, mas com o
 * envio desligado até a pessoa abrir a transmissão (mensagem "watch").
 *
 * A negociação segue o padrão "perfect negotiation": os dois lados podem renegociar a qualquer
 * momento (ex.: ligar o compartilhamento ao mesmo tempo) sem travar.
 */

export interface CallPeer {
  id: string
  name: string
  /** está compartilhando a tela agora */
  sharing: boolean
  /** está com o microfone mutado */
  muted: boolean
}

export interface CallRoomInfo {
  id: string
  name: string
}

export interface FileMeta {
  id: string
  name: string
  size: number
  type: string
}

/** Andamento de um arquivo recebido (blob preenchido ao terminar). */
export interface IncomingFile extends FileMeta {
  done: number
  blob?: Blob
  failed?: boolean
}

/** Mensagens do canal "call" que a camada de cima (store) trata: chat, edição, histórico... */
export type AppMessage = { kind: string; [key: string]: unknown }

interface Handlers {
  onPeers: (peers: CallPeer[]) => void
  /** a sala (id e nome) informada pelo servidor de quem a criou */
  onRoom: (room: CallRoomInfo) => void
  /** o canal de mensagens com este participante abriu (hora de mandar histórico, miniatura...) */
  onPeerReady: (peerId: string) => void
  onMessage: (peerId: string, msg: AppMessage) => void
  onFile: (peerId: string, file: IncomingFile) => void
  /** o WebSocket de sinalização caiu (ex.: quem criou a sala saiu) */
  onSignalingClosed: () => void
}

interface Link {
  pc: RTCPeerConnection
  dc: RTCDataChannel | null
  polite: boolean
  makingOffer: boolean
  ignoreOffer: boolean
  /** a resposta do outro lado está sendo aplicada: uma nova oferta dele já pode chegar nesse meio-tempo */
  settingRemoteAnswer: boolean
  micSender: RTCRtpSender | null
  screenVideoSender: RTCRtpSender | null
  screenAudioSender: RTCRtpSender | null
  /** este participante está assistindo a minha tela (só então ela é enviada a ele) */
  watchingMe: boolean
  /** vídeo da tela deste participante */
  screenStream: MediaStream | null
  ctx: AudioContext
  gain: GainNode
  screenGain: GainNode
  analyser: AnalyserNode
  output: HTMLAudioElement
  /** <audio> mudos: no Chromium o áudio WebRTC só chega ao Web Audio se também estiver num elemento de mídia */
  primers: HTMLAudioElement[]
  volume: number
  muted: boolean
}

/** limite por arquivo: quem recebe guarda tudo na memória até terminar */
export const MAX_FILE_BYTES = 500 * 1024 * 1024
const FILE_CHUNK = 64 * 1024

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' }
]
const OUTPUT_KEY = 'call.audioOutput'

type SinkAudio = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }

export function useCallRtc() {
  const localPeerId = crypto.randomUUID()
  // rótulos fixos dos fluxos enviados: quem recebe distingue "áudio da tela" de "microfone"
  // por estar (ou não) no mesmo fluxo do vídeo, mesmo que a tela seja trocada depois
  const micLabel = new MediaStream()
  const screenLabel = new MediaStream()

  const links = new Map<string, Link>()
  let peers: CallPeer[] = []
  let ws: WebSocket | null = null
  let keepAlive: ReturnType<typeof setInterval> | null = null
  let handlers: Handlers | null = null
  let micTrack: MediaStreamTrack | null = null
  let screenStream: MediaStream | null = null
  let localState = { sharing: false, muted: false }
  let watchingPeerId: string | null = null
  let screenVolume = 1
  let outputDeviceId = localStorage.getItem(OUTPUT_KEY) || ''

  // ---------------------------------------------------------------- sinalização

  function signal(msg: Record<string, unknown>): void {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  function connect(wsUrl: string, name: string, h: Handlers): Promise<void> {
    handlers = h
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl)
      let opened = false
      socket.onopen = () => {
        opened = true
        ws = socket
        // keepalive: o Cloudflare fecha WebSocket parado
        keepAlive = setInterval(() => signal({ type: 'ping' }), 25000)
        signal({ type: 'join', peerId: localPeerId, name })
        resolve()
      }
      socket.onmessage = (e) => {
        try {
          void onSignal(JSON.parse(e.data))
        } catch {
          // mensagem inválida: ignora
        }
      }
      socket.onclose = () => {
        if (keepAlive) clearInterval(keepAlive)
        keepAlive = null
        if (!opened) return reject(new Error('Não foi possível conectar à sala. Confira o código.'))
        if (ws === socket) {
          ws = null
          handlers?.onSignalingClosed()
        }
      }
    })
  }

  async function onSignal(msg: Record<string, any>): Promise<void> {
    switch (msg.type) {
      case 'peers':
        if (msg.room && typeof msg.room.id === 'string') {
          handlers?.onRoom({ id: msg.room.id, name: String(msg.room.name ?? '') })
        }
        // quem entra é quem chama: abre uma conexão com cada um que já estava na sala
        for (const p of msg.peers as { id: string; name: string }[]) {
          addPeer(p.id, p.name)
          const link = createLink(p.id)
          attachDataChannel(p.id, link, link.pc.createDataChannel('call', { ordered: true }))
        }
        break
      case 'peer-joined':
        addPeer(msg.peer.id, msg.peer.name)
        break
      case 'peer-left':
        dropPeer(msg.peerId)
        break
      case 'sdp': {
        const link = links.get(msg.from) ?? createLink(msg.from)
        const desc = msg.sdp as RTCSessionDescriptionInit
        const readyForOffer = !link.makingOffer && (link.pc.signalingState === 'stable' || link.settingRemoteAnswer)
        link.ignoreOffer = !link.polite && desc.type === 'offer' && !readyForOffer
        if (link.ignoreOffer) return
        link.settingRemoteAnswer = desc.type === 'answer'
        try {
          await link.pc.setRemoteDescription(desc)
        } finally {
          link.settingRemoteAnswer = false
        }
        if (desc.type === 'offer') {
          await link.pc.setLocalDescription()
          signal({ type: 'sdp', to: msg.from, sdp: link.pc.localDescription })
        }
        break
      }
      case 'ice': {
        const link = links.get(msg.from)
        if (!link) return
        try {
          await link.pc.addIceCandidate(msg.candidate)
        } catch (e) {
          if (!link.ignoreOffer) console.warn('[call] candidato ICE recusado:', e)
        }
        break
      }
    }
  }

  // ---------------------------------------------------------------- participantes

  function emitPeers(): void {
    handlers?.onPeers(peers.map((p) => ({ ...p })))
  }

  function addPeer(id: string, name: string): void {
    if (peers.some((p) => p.id === id)) return
    peers.push({ id, name, sharing: false, muted: false })
    emitPeers()
  }

  function dropPeer(id: string): void {
    const link = links.get(id)
    if (link) {
      links.delete(id)
      link.pc.onconnectionstatechange = null
      if (link.dc) link.dc.onclose = null
      link.pc.close()
      void link.ctx.close()
      for (const el of [...link.primers, link.output]) {
        el.srcObject = null
        el.remove()
      }
    }
    if (watchingPeerId === id) watchingPeerId = null
    if (peers.some((p) => p.id === id)) {
      peers = peers.filter((p) => p.id !== id)
      emitPeers()
    }
  }

  // ---------------------------------------------------------------- conexão com um participante

  function createLink(peerId: string): Link {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })

    // grafo de áudio: voz → medidor → ganho da pessoa → saída ; áudio da tela → ganho da transmissão → saída
    const ctx = new AudioContext()
    const gain = ctx.createGain()
    const screenGain = ctx.createGain()
    screenGain.gain.value = 0 // só toca quando a tela desse participante está aberta
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 64
    analyser.smoothingTimeConstant = 0.7
    const destination = ctx.createMediaStreamDestination()
    analyser.connect(gain)
    gain.connect(destination)
    screenGain.connect(destination)
    // sai por um <audio> para permitir escolher o dispositivo de saída (setSinkId)
    const output = hiddenAudio(destination.stream, false)
    if (outputDeviceId) void (output as SinkAudio).setSinkId?.(outputDeviceId).catch(() => {})
    void ctx.resume().catch(() => {})

    const link: Link = {
      pc,
      dc: null,
      polite: localPeerId < peerId,
      makingOffer: false,
      ignoreOffer: false,
      settingRemoteAnswer: false,
      micSender: null,
      screenVideoSender: null,
      screenAudioSender: null,
      watchingMe: false,
      screenStream: null,
      ctx,
      gain,
      screenGain,
      analyser,
      output,
      primers: [],
      volume: 1,
      muted: false
    }
    links.set(peerId, link)

    if (micTrack) link.micSender = pc.addTrack(micTrack, micLabel)
    if (screenStream) addScreenTracks(link, screenStream)

    pc.onnegotiationneeded = async () => {
      try {
        link.makingOffer = true
        await pc.setLocalDescription()
        signal({ type: 'sdp', to: peerId, sdp: pc.localDescription })
      } catch (e) {
        console.warn('[call] falha ao negociar:', e)
      } finally {
        link.makingOffer = false
      }
    }
    // faixas recém-negociadas da tela: aplica "enviar só se estiver assistindo"
    pc.onsignalingstatechange = () => {
      if (pc.signalingState === 'stable') void gateScreen(link)
    }
    pc.onicecandidate = (e) => {
      if (e.candidate) signal({ type: 'ice', to: peerId, candidate: e.candidate.toJSON() })
    }
    pc.ondatachannel = (e) => {
      if (e.channel.label === 'file') receiveFile(peerId, e.channel)
      else attachDataChannel(peerId, link, e.channel)
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') dropPeer(peerId)
    }
    pc.ontrack = (e) => {
      if (e.track.kind === 'video') {
        link.screenStream = new MediaStream([e.track])
        emitPeers()
        return
      }
      const single = new MediaStream([e.track])
      link.primers.push(hiddenAudio(single, true))
      // mesmo fluxo do vídeo = áudio da tela; senão é o microfone
      const isScreenAudio = (e.streams[0]?.getVideoTracks().length ?? 0) > 0
      ctx.createMediaStreamSource(single).connect(isScreenAudio ? screenGain : analyser)
    }
    return link
  }

  function hiddenAudio(stream: MediaStream, muted: boolean): HTMLAudioElement {
    const el = document.createElement('audio')
    el.autoplay = true
    el.muted = muted
    el.srcObject = stream
    el.style.display = 'none'
    document.body.appendChild(el)
    void el.play().catch(() => {})
    return el
  }

  function attachDataChannel(peerId: string, link: Link, dc: RTCDataChannel): void {
    link.dc = dc
    dc.onopen = () => {
      sendData(dc, { kind: 'state', ...localState })
      // estava assistindo esta pessoa antes de a conexão abrir (ex.: reconexão): avisa de novo
      if (watchingPeerId === peerId) sendData(dc, { kind: 'watch', on: true })
      handlers?.onPeerReady(peerId)
    }
    dc.onclose = () => dropPeer(peerId)
    dc.onmessage = (e) => {
      let msg: AppMessage
      try {
        msg = JSON.parse(e.data)
      } catch {
        return
      }
      if (!msg || typeof msg.kind !== 'string') return
      if (msg.kind === 'state') {
        const peer = peers.find((p) => p.id === peerId)
        if (!peer) return
        peer.sharing = !!msg.sharing
        peer.muted = !!msg.muted
        if (!peer.sharing && watchingPeerId === peerId) setWatching(null)
        emitPeers()
      } else if (msg.kind === 'watch') {
        link.watchingMe = !!msg.on
        void gateScreen(link)
      } else {
        handlers?.onMessage(peerId, msg)
      }
    }
  }

  function sendData(dc: RTCDataChannel | null, msg: AppMessage): void {
    if (dc?.readyState === 'open') dc.send(JSON.stringify(msg))
  }

  function send(peerId: string, msg: AppMessage): void {
    sendData(links.get(peerId)?.dc ?? null, msg)
  }

  function broadcast(msg: AppMessage): void {
    for (const link of links.values()) sendData(link.dc, msg)
  }

  // ---------------------------------------------------------------- mídia local

  /** Microfone enviado a todos (null = sem microfone). Mutar é `track.enabled = false`, não passa por aqui. */
  async function setMicTrack(track: MediaStreamTrack | null): Promise<void> {
    micTrack = track
    for (const link of links.values()) {
      if (link.micSender) await link.micSender.replaceTrack(track)
      else if (track) link.micSender = link.pc.addTrack(track, micLabel)
    }
  }

  function addScreenTracks(link: Link, stream: MediaStream): void {
    const video = stream.getVideoTracks()[0]
    const audio = stream.getAudioTracks()[0]
    if (video) link.screenVideoSender = link.pc.addTrack(video, screenLabel)
    if (audio) link.screenAudioSender = link.pc.addTrack(audio, screenLabel)
  }

  /** Liga/desliga o envio da minha tela para este participante conforme ele esteja assistindo. */
  async function gateScreen(link: Link): Promise<void> {
    for (const sender of [link.screenVideoSender, link.screenAudioSender]) {
      if (!sender) continue
      const params = sender.getParameters()
      if (!params.encodings?.length) continue // ainda não negociado: aplica quando ficar "stable"
      const active = link.watchingMe
      if (params.encodings.every((enc) => enc.active === active)) continue
      params.encodings.forEach((enc) => (enc.active = active))
      try {
        await sender.setParameters(params)
      } catch (e) {
        console.warn('[call] falha ao ligar/desligar o envio da tela:', e)
      }
    }
  }

  /** Tela compartilhada com todos (null = parar). Trocar de tela só substitui as faixas, sem renegociar. */
  async function setScreenStream(stream: MediaStream | null): Promise<void> {
    screenStream = stream
    const video = stream?.getVideoTracks()[0] ?? null
    const audio = stream?.getAudioTracks()[0] ?? null
    for (const link of links.values()) {
      if (link.screenVideoSender) await link.screenVideoSender.replaceTrack(video)
      else if (video) link.screenVideoSender = link.pc.addTrack(video, screenLabel)
      if (link.screenAudioSender) await link.screenAudioSender.replaceTrack(audio)
      else if (audio) link.screenAudioSender = link.pc.addTrack(audio, screenLabel)
      if (!stream) link.watchingMe = false
      void gateScreen(link)
    }
    setLocalState({ sharing: !!stream })
  }

  function setLocalState(patch: Partial<typeof localState>): void {
    localState = { ...localState, ...patch }
    broadcast({ kind: 'state', ...localState })
  }

  // ---------------------------------------------------------------- arquivos (um canal por arquivo e por participante)

  /**
   * Envia um arquivo (a todos, ou só a `to`). `onProgress` recebe os bytes já enviados ao
   * participante mais adiantado; `onFail` é chamado se nenhum envio der certo.
   */
  function sendFile(blob: Blob, meta: FileMeta, opts: { to?: string; onProgress?: (done: number) => void } = {}): void {
    const targets = opts.to ? [links.get(opts.to)].filter((l): l is Link => !!l) : [...links.values()]
    let best = 0
    for (const link of targets) {
      const dc = link.pc.createDataChannel('file', { ordered: true })
      dc.binaryType = 'arraybuffer'
      dc.bufferedAmountLowThreshold = 1024 * 1024
      dc.onopen = async () => {
        try {
          dc.send(JSON.stringify(meta))
          for (let offset = 0; offset < blob.size; offset += FILE_CHUNK) {
            if (dc.readyState !== 'open') return
            if (dc.bufferedAmount > 8 * 1024 * 1024) {
              await new Promise<void>((r) => dc.addEventListener('bufferedamountlow', () => r(), { once: true }))
            }
            dc.send(await blob.slice(offset, offset + FILE_CHUNK).arrayBuffer())
            best = Math.max(best, Math.min(blob.size, offset + FILE_CHUNK))
            opts.onProgress?.(best)
          }
          // quem recebe fecha o canal ao terminar
        } catch {
          dc.close()
        }
      }
    }
  }

  function receiveFile(peerId: string, dc: RTCDataChannel): void {
    dc.binaryType = 'arraybuffer'
    let meta: FileMeta | null = null
    const chunks: ArrayBuffer[] = []
    let done = 0
    let lastReport = 0
    const report = (patch: Partial<IncomingFile> = {}): void => {
      if (meta) handlers?.onFile(peerId, { ...meta, done, ...patch })
    }
    dc.onmessage = (e) => {
      if (!meta) {
        try {
          const m = JSON.parse(e.data)
          if (typeof m.id !== 'string' || typeof m.name !== 'string' || !(m.size >= 0) || m.size > MAX_FILE_BYTES) throw new Error()
          meta = { id: m.id, name: m.name.slice(0, 200), size: m.size, type: String(m.type || '') }
        } catch {
          return dc.close()
        }
        report()
        if (meta.size === 0) finish()
        return
      }
      if (!(e.data instanceof ArrayBuffer)) return
      chunks.push(e.data)
      done += e.data.byteLength
      if (done > meta.size) return dc.close()
      if (done === meta.size) finish()
      else if (Date.now() - lastReport > 150) {
        lastReport = Date.now()
        report()
      }
    }
    dc.onclose = () => {
      if (meta && done < meta.size) report({ failed: true })
    }
    function finish(): void {
      if (!meta) return
      report({ blob: new Blob(chunks, { type: meta.type || 'application/octet-stream' }) })
      chunks.length = 0
      dc.close()
    }
  }

  // ---------------------------------------------------------------- áudio e vídeo recebidos

  function applyGain(link: Link): void {
    link.gain.gain.value = link.muted ? 0 : Math.max(0, link.volume)
    if (link.ctx.state === 'suspended') void link.ctx.resume().catch(() => {})
  }

  function setPeerVolume(peerId: string, volume: number): void {
    const link = links.get(peerId)
    if (!link) return
    link.volume = volume
    applyGain(link)
  }

  function setPeerMuted(peerId: string, muted: boolean): void {
    const link = links.get(peerId)
    if (!link) return
    link.muted = muted
    applyGain(link)
  }

  /**
   * Qual transmissão estou assistindo (null = nenhuma). Avisa quem transmite para ligar/desligar o
   * envio e só toca o áudio da transmissão aberta.
   */
  function setWatching(peerId: string | null): void {
    const previous = watchingPeerId
    watchingPeerId = peerId
    if (previous && previous !== peerId) send(previous, { kind: 'watch', on: false })
    if (peerId && peerId !== previous) send(peerId, { kind: 'watch', on: true })
    for (const [id, link] of links) link.screenGain.gain.value = id === peerId ? screenVolume : 0
  }

  /** Volume do áudio da transmissão aberta (0 a 2), separado do volume da voz de quem transmite. */
  function setScreenVolume(volume: number): void {
    screenVolume = Math.max(0, volume)
    for (const [id, link] of links) link.screenGain.gain.value = id === watchingPeerId ? screenVolume : 0
  }

  function getPeerScreen(peerId: string): MediaStream | null {
    return links.get(peerId)?.screenStream ?? null
  }

  function getPeerAnalyser(peerId: string): AnalyserNode | null {
    return links.get(peerId)?.analyser ?? null
  }

  async function setOutputDevice(deviceId: string): Promise<void> {
    outputDeviceId = deviceId
    localStorage.setItem(OUTPUT_KEY, deviceId)
    for (const link of links.values()) await (link.output as SinkAudio).setSinkId?.(deviceId || 'default')
  }

  function getOutputDevice(): string {
    return outputDeviceId
  }

  function disconnect(): void {
    handlers = null
    if (keepAlive) clearInterval(keepAlive)
    keepAlive = null
    const socket = ws
    ws = null
    socket?.close()
    for (const id of [...links.keys()]) dropPeer(id)
    peers = []
    micTrack = null
    screenStream = null
    localState = { sharing: false, muted: false }
    watchingPeerId = null
  }

  return {
    localPeerId,
    connect,
    disconnect,
    send,
    broadcast,
    setMicTrack,
    setScreenStream,
    setLocalState,
    sendFile,
    setScreenVolume,
    setPeerVolume,
    setPeerMuted,
    setWatching,
    getPeerScreen,
    getPeerAnalyser,
    setOutputDevice,
    getOutputDevice
  }
}
