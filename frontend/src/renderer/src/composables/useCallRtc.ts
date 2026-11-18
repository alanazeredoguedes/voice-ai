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
  /** quem hospeda o servidor da sala agora (vazio = servidor antigo, sem essa informação) */
  hostPeerId: string
}

/** Alguém pedindo para entrar na sala (aguardando alguém de dentro aceitar). */
export interface CallKnock {
  id: string
  name: string
}

/** Opções da conexão com o servidor da sala. */
export interface SignalOptions {
  /** só quem hospeda: prova para o servidor que é o anfitrião */
  hostToken?: string
  /** etiqueta da sala → prova de que já estive nela (entra sem precisar ser aceito) */
  getProof: (tag: string) => Promise<string | null>
}

/** A entrada foi recusada por alguém de dentro da sala. */
export class JoinDeniedError extends Error {
  constructor(by: string) {
    super(`${by || 'Alguém da sala'} recusou sua entrada.`)
    this.name = 'JoinDeniedError'
  }
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

export type CallLogLevel = 'info' | 'warn' | 'error'
/** Registra um evento no log da sala (tela de Chamada → Logs). */
export type CallLogFn = (level: CallLogLevel, msg: string) => void

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
  /** entrei na fila: alguém de dentro precisa aceitar */
  onWaiting: () => void
  /** pedidos de entrada pendentes (para quem está dentro aceitar ou recusar) */
  onKnocks: (knocks: CallKnock[]) => void
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
  /** medidor do som da tela recebido (antes do volume escolhido aqui) */
  screenAnalyser: AnalyserNode
  /** ligar/desligar o envio da tela em fila (duas mudanças ao mesmo tempo dão erro no WebRTC) */
  gating: Promise<void>
  output: HTMLAudioElement
  /** limitador final: deixa passar volumes acima de 100% sem estourar (distorcer) */
  limiter: DynamicsCompressorNode
  /** ids das faixas de áudio recebidas que são som da tela (as outras são microfone) */
  screenAudioTracks: Set<string>
  /** ids dos fluxos do outro lado (vêm na mensagem "state"): identificam voz × som da tela sem adivinhar */
  remoteStreams: { mic?: string; screen?: string }
  /** faixas de áudio que chegaram antes de dar para saber se são voz ou som da tela */
  pendingAudio: { track: MediaStreamTrack; stream: MediaStream | undefined; resolve: (screen: boolean) => void }[]
  /** já registrou no log por onde a conexão passou */
  routeLogged: boolean
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
/** volume inicial da voz de quem entra (a pessoa ajusta depois, pelo botão direito ou pela barra) */
export const DEFAULT_PEER_VOLUME = 0.3
/** som da tela é música/vídeo: o padrão do WebRTC (~32 kbps, pensado para voz) fica abafado */
const SCREEN_AUDIO_BITRATE = 128_000

type SinkAudio = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }

export function useCallRtc(log: CallLogFn = () => {}) {
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
  /** limites do vídeo da tela (taxa e quadros por segundo), escolhidos na qualidade da transmissão */
  let screenVideoLimits: { maxBitrate: number; maxFramerate: number } | null = null
  let localState = { sharing: false, muted: false }
  let watchingPeerId: string | null = null
  let screenVolume = 1
  let outputDeviceId = localStorage.getItem(OUTPUT_KEY) || ''

  // ---------------------------------------------------------------- sinalização

  function signal(msg: Record<string, unknown>): void {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  let myName = 'Convidado'
  let signalOpts: SignalOptions = { getProof: async () => null }
  /** a entrada atual (resolve quando o servidor me aceita na sala) */
  let pendingJoin: { resolve: () => void; reject: (e: Error) => void } | null = null

  /** Primeira conexão com o servidor da sala. Resolve quando eu estiver dentro (aceito). */
  function connect(wsUrl: string, name: string, h: Handlers, opts: SignalOptions): Promise<void> {
    handlers = h
    myName = name
    signalOpts = opts
    return openSignaling(wsUrl)
  }

  /**
   * Troca de servidor da sala sem derrubar ninguém: quem hospedava saiu (ou o túnel caiu) e outra
   * pessoa abriu um servidor novo. As conexões P2P continuam; o servidor só serve para negociar.
   */
  function reconnect(wsUrl: string, opts: Partial<SignalOptions> = {}): Promise<void> {
    signalOpts = { ...signalOpts, ...opts }
    return openSignaling(wsUrl)
  }

  function openSignaling(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const old = ws
      ws = null
      if (old) {
        old.onclose = null
        old.close()
      }
      if (keepAlive) clearInterval(keepAlive)
      keepAlive = null
      const socket = new WebSocket(wsUrl)
      let opened = false
      let joined = false
      let settled = false
      const finish = (err?: Error): void => {
        if (settled) return
        settled = true
        pendingJoin = null
        if (err) reject(err)
        else resolve()
      }
      pendingJoin = { resolve: () => finish(), reject: (e) => finish(e) }
      log('info', `conectando ao servidor da sala (${wsUrl.startsWith('ws://127.0.0.1') ? 'local, sou quem hospeda' : wsUrl})`)

      const sendJoin = async (tag: string): Promise<void> => {
        if (joined || socket.readyState !== WebSocket.OPEN) return
        joined = true
        const proof = tag ? await signalOpts.getProof(tag).catch(() => null) : null
        if (proof) log('info', 'já estive nesta sala: entrando sem precisar ser aceito')
        socket.send(JSON.stringify({ type: 'join', peerId: localPeerId, name: myName, proof, hostToken: signalOpts.hostToken }))
      }

      socket.onopen = () => {
        opened = true
        ws = socket
        log('info', 'conectado ao servidor da sala')
        // keepalive: o Cloudflare fecha WebSocket parado
        keepAlive = setInterval(() => signal({ type: 'ping' }), 25000)
        // servidor de versão antiga não manda "welcome": entra assim mesmo
        setTimeout(() => void sendJoin(''), 1500)
      }
      socket.onmessage = (e) => {
        let msg: Record<string, any>
        try {
          msg = JSON.parse(e.data)
        } catch {
          return
        }
        if (msg.type === 'welcome') return void sendJoin(typeof msg.tag === 'string' ? msg.tag : '')
        if (msg.type === 'waiting') {
          log('info', 'aguardando alguém da sala aceitar a minha entrada')
          handlers?.onWaiting()
          return
        }
        if (msg.type === 'denied') {
          log('warn', `entrada recusada por ${msg.by || 'alguém da sala'}`)
          return finish(new JoinDeniedError(String(msg.by ?? '')))
        }
        void onSignal(msg).catch((err) => log('error', `mensagem do servidor da sala falhou: ${errText(err)}`))
        if (msg.type === 'peers') finish()
      }
      socket.onclose = (e) => {
        if (ws === socket || !opened) {
          if (keepAlive) clearInterval(keepAlive)
          keepAlive = null
        }
        if (!settled) {
          log('warn', `não entrou pelo servidor da sala (conexão fechada, código ${e.code})`)
          return finish(new Error('Não foi possível conectar à sala. Confira o código.'))
        }
        if (ws === socket) {
          ws = null
          log('warn', `conexão com o servidor da sala caiu (código ${e.code}): quem já está na chamada continua`)
          handlers?.onSignalingClosed()
        }
      }
    })
  }

  /** Aceita ou recusa o pedido de entrada de alguém. */
  function answerKnock(peerId: string, accept: boolean): void {
    signal({ type: 'admit', peerId, accept })
  }

  const signalingOpen = (): boolean => ws?.readyState === WebSocket.OPEN

  async function onSignal(msg: Record<string, any>): Promise<void> {
    switch (msg.type) {
      case 'peers':
        if (msg.room && typeof msg.room.id === 'string') {
          handlers?.onRoom({ id: msg.room.id, name: String(msg.room.name ?? ''), hostPeerId: String(msg.hostPeerId ?? '') })
        }
        log('info', `no servidor da sala estavam: ${(msg.peers as { name: string }[]).map((p) => p.name).join(', ') || 'ninguém'}`)
        // quem entra é quem chama: abre uma conexão com cada um que já estava na sala
        // (com quem eu já tenho conexão, ela continua: aconteceu só uma troca de servidor)
        for (const p of msg.peers as { id: string; name: string }[]) {
          if (links.has(p.id)) continue
          addPeer(p.id, p.name)
          const link = createLink(p.id)
          attachDataChannel(p.id, link, link.pc.createDataChannel('call', { ordered: true }))
        }
        break
      case 'peer-joined':
        log('info', `${msg.peer?.name} entrou na sala`)
        addPeer(msg.peer.id, msg.peer.name)
        break
      case 'peer-left': {
        // saiu do servidor, mas a conexão direta ainda está de pé (ex.: o túnel caiu): continua na chamada
        const link = links.get(msg.peerId)
        if (link && link.pc.connectionState === 'connected' && link.dc?.readyState === 'open') {
          log('info', `${nameOf(msg.peerId)} desconectou do servidor da sala, mas segue na chamada (conexão direta ativa)`)
          break
        }
        log('info', `${nameOf(msg.peerId)} saiu da sala`)
        dropPeer(msg.peerId)
        break
      }
      case 'knocks':
        handlers?.onKnocks(Array.isArray(msg.knocks) ? msg.knocks.map((k: CallKnock) => ({ id: String(k.id), name: String(k.name).slice(0, 40) })) : [])
        break
      case 'sdp': {
        const link = links.get(msg.from) ?? createLink(msg.from)
        const desc = msg.sdp as RTCSessionDescriptionInit
        const readyForOffer = !link.makingOffer && (link.pc.signalingState === 'stable' || link.settingRemoteAnswer)
        link.ignoreOffer = !link.polite && desc.type === 'offer' && !readyForOffer
        if (link.ignoreOffer) {
          log('info', `negociação com ${nameOf(msg.from)}: oferta ignorada (colisão; a minha vale)`)
          return
        }
        link.settingRemoteAnswer = desc.type === 'answer'
        try {
          await link.pc.setRemoteDescription(desc)
        } catch (e) {
          log('error', `negociação com ${nameOf(msg.from)}: falha ao aplicar ${desc.type}: ${errText(e)}`)
          throw e
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
          if (!link.ignoreOffer) log('warn', `candidato de rede de ${nameOf(msg.from)} recusado: ${errText(e)}`)
        }
        break
      }
    }
  }

  // ---------------------------------------------------------------- participantes

  function nameOf(id: string): string {
    return peers.find((p) => p.id === id)?.name ?? 'participante'
  }

  function errText(e: unknown): string {
    return e instanceof Error ? e.message : String(e)
  }

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
    gain.gain.value = DEFAULT_PEER_VOLUME
    const screenGain = ctx.createGain()
    screenGain.gain.value = 0 // só toca quando a tela desse participante está aberta
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 64
    analyser.smoothingTimeConstant = 0.7
    const screenAnalyser = ctx.createAnalyser()
    screenAnalyser.fftSize = 2048
    screenAnalyser.connect(screenGain)
    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -3
    limiter.knee.value = 0
    limiter.ratio.value = 20
    limiter.attack.value = 0.002
    limiter.release.value = 0.2
    const destination = ctx.createMediaStreamDestination()
    analyser.connect(gain)
    gain.connect(limiter)
    screenGain.connect(limiter)
    limiter.connect(destination)
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
      screenAnalyser,
      gating: Promise.resolve(),
      limiter,
      screenAudioTracks: new Set(),
      remoteStreams: {},
      pendingAudio: [],
      routeLogged: false,
      output,
      primers: [],
      volume: DEFAULT_PEER_VOLUME,
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
        log('error', `negociação com ${nameOf(peerId)}: falha ao criar oferta: ${errText(e)}`)
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
    pc.oniceconnectionstatechange = () => {
      log(pc.iceConnectionState === 'failed' ? 'error' : 'info', `rede com ${nameOf(peerId)}: ICE ${pc.iceConnectionState}`)
    }
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState
      log(state === 'failed' ? 'error' : state === 'disconnected' ? 'warn' : 'info', `conexão com ${nameOf(peerId)}: ${state}`)
      if (state === 'failed') {
        log('error', `não deu para ligar direto com ${nameOf(peerId)} (sem servidor TURN, algumas redes bloqueiam a conexão P2P)`)
      }
      if (state === 'connected' && !link.routeLogged) {
        link.routeLogged = true
        void logRoute(peerId, link)
      }
      if (state === 'failed' || state === 'closed') dropPeer(peerId)
    }
    pc.ontrack = (e) => {
      if (e.track.kind === 'video') {
        log('info', `recebendo faixa de vídeo da tela de ${nameOf(peerId)}`)
        link.screenStream = new MediaStream([e.track])
        emitPeers()
        return
      }
      const single = new MediaStream([e.track])
      link.primers.push(hiddenAudio(single, true))
      // Voz ou som da tela? Até saber, a faixa não toca em lugar nenhum (antes, um som da tela que chegava
      // antes do vídeo era tratado como voz e tocava sem a pessoa ter aberto a transmissão).
      classifyAudio(peerId, link, e.track, e.streams[0], (isScreenAudio) => {
        if (isScreenAudio) link.screenAudioTracks.add(e.track.id)
        log('info', `recebendo faixa de áudio ${isScreenAudio ? 'da tela' : 'do microfone'} de ${nameOf(peerId)}`)
        ctx.createMediaStreamSource(single).connect(isScreenAudio ? screenAnalyser : analyser)
      })
    }
    return link
  }

  /**
   * Decide se uma faixa de áudio recebida é a voz ou o som da tela:
   *  1. pelo id do fluxo, que o outro lado informa na mensagem "state" (certeiro);
   *  2. se o fluxo já tem vídeo, é da tela;
   *  3. senão espera: o id chegar, o vídeo entrar no mesmo fluxo ou, em 3 s, trata como voz
   *     (participante com versão antiga, que não informa os ids).
   */
  function classifyAudio(
    peerId: string,
    link: Link,
    track: MediaStreamTrack,
    stream: MediaStream | undefined,
    done: (screen: boolean) => void
  ): void {
    const known = decide(link, stream)
    if (known !== null) return done(known)
    let settled = false
    const resolve = (screen: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stream?.removeEventListener('addtrack', onAdd)
      link.pendingAudio = link.pendingAudio.filter((p) => p.track !== track)
      done(screen)
    }
    const onAdd = (ev: MediaStreamTrackEvent): void => {
      if (ev.track.kind === 'video') resolve(true)
    }
    stream?.addEventListener('addtrack', onAdd)
    const timer = setTimeout(() => {
      log('warn', `não deu para saber se o áudio de ${nameOf(peerId)} é voz ou tela: tratando como voz`)
      resolve(false)
    }, 3000)
    link.pendingAudio.push({ track, stream, resolve })
  }

  function decide(link: Link, stream: MediaStream | undefined): boolean | null {
    const id = stream?.id
    if (id && link.remoteStreams.screen === id) return true
    if (id && link.remoteStreams.mic === id) return false
    if (id && link.remoteStreams.screen && link.remoteStreams.mic) return false
    if ((stream?.getVideoTracks().length ?? 0) > 0) return true
    return null
  }

  /** Mensagem "state": o que eu informo aos outros (mudo, transmitindo e os ids dos meus fluxos). */
  const stateMessage = (): AppMessage => ({ kind: 'state', ...localState, micStream: micLabel.id, screenStream: screenLabel.id })

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
      log('info', `canal de mensagens com ${nameOf(peerId)} aberto`)
      sendData(dc, stateMessage())
      // estava assistindo esta pessoa antes de a conexão abrir (ex.: reconexão): avisa de novo
      if (watchingPeerId === peerId) sendData(dc, { kind: 'watch', on: true })
      handlers?.onPeerReady(peerId)
    }
    dc.onclose = () => {
      if (links.get(peerId) === link) log('warn', `canal de mensagens com ${nameOf(peerId)} fechou`)
      dropPeer(peerId)
    }
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
        if (typeof msg.micStream === 'string' && typeof msg.screenStream === 'string') {
          link.remoteStreams = { mic: msg.micStream, screen: msg.screenStream }
          for (const p of [...link.pendingAudio]) {
            const known = decide(link, p.stream)
            if (known !== null) p.resolve(known)
          }
        }
        if (peer.sharing !== !!msg.sharing) log('info', `${peer.name} ${msg.sharing ? 'começou' : 'parou'} a transmitir a tela`)
        if (peer.muted !== !!msg.muted) log('info', `${peer.name} ${msg.muted ? 'mutou' : 'desmutou'} o microfone`)
        peer.sharing = !!msg.sharing
        peer.muted = !!msg.muted
        if (!peer.sharing && watchingPeerId === peerId) setWatching(null)
        emitPeers()
      } else if (msg.kind === 'watch') {
        if (link.watchingMe !== !!msg.on) log('info', `${nameOf(peerId)} ${msg.on ? 'abriu' : 'fechou'} a minha transmissão`)
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
  function gateScreen(link: Link): Promise<void> {
    link.gating = link.gating.then(() => applyGate(link)).catch(() => {})
    return link.gating
  }

  async function applyGate(link: Link, retry = true): Promise<void> {
    for (const sender of [link.screenVideoSender, link.screenAudioSender]) {
      if (!sender) continue
      const params = sender.getParameters()
      if (!params.encodings?.length) continue // ainda não negociado: aplica quando ficar "stable"
      const active = link.watchingMe
      const isVideo = sender === link.screenVideoSender
      const bitrate = isVideo ? screenVideoLimits?.maxBitrate : SCREEN_AUDIO_BITRATE
      const framerate = isVideo ? screenVideoLimits?.maxFramerate : undefined
      if (
        params.encodings.every(
          (enc) => enc.active === active && (!bitrate || enc.maxBitrate === bitrate) && (!framerate || enc.maxFramerate === framerate)
        )
      )
        continue
      params.encodings.forEach((enc) => {
        enc.active = active
        if (bitrate) enc.maxBitrate = bitrate
        if (framerate) enc.maxFramerate = framerate
      })
      if (isVideo && framerate && framerate > 30) params.degradationPreference = 'maintain-framerate'
      try {
        await sender.setParameters(params)
      } catch (e) {
        // os parâmetros mudaram no meio (renegociação): lê de novo e tenta uma vez mais
        if (retry && e instanceof DOMException && e.name === 'InvalidModificationError') {
          await new Promise((r) => setTimeout(r, 200))
          return applyGate(link, false)
        }
        log('error', `falha ao ${active ? 'ligar' : 'desligar'} o envio da tela: ${errText(e)}`)
      }
    }
  }

  /** Tela compartilhada com todos (null = parar). Trocar de tela só substitui as faixas, sem renegociar. */
  async function setScreenStream(stream: MediaStream | null, limits: { maxBitrate: number; maxFramerate: number } | null = null): Promise<void> {
    screenStream = stream
    screenVideoLimits = stream ? limits : null
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
    broadcast(stateMessage())
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
      const to = [...links].find(([, l]) => l === link)?.[0] ?? ''
      dc.onclose = () => {
        if (dc.bufferedAmount > 0) log('warn', `envio de "${meta.name}" para ${nameOf(to)} interrompido`)
      }
      dc.onopen = async () => {
        log('info', `enviando "${meta.name}" (${fmtBytes(blob.size)}) para ${nameOf(to)}`)
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
        } catch (e) {
          log('error', `falha ao enviar "${meta.name}" para ${nameOf(to)}: ${errText(e)}`)
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
        log('info', `recebendo "${meta.name}" (${fmtBytes(meta.size)}) de ${nameOf(peerId)}`)
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
      if (meta && done < meta.size) {
        log('error', `recebimento de "${meta.name}" de ${nameOf(peerId)} interrompido em ${fmtBytes(done)} de ${fmtBytes(meta.size)}`)
        report({ failed: true })
      }
    }
    function finish(): void {
      if (!meta) return
      log('info', `"${meta.name}" recebido de ${nameOf(peerId)}`)
      report({ blob: new Blob(chunks, { type: meta.type || 'application/octet-stream' }) })
      chunks.length = 0
      dc.close()
    }
  }

  // ---------------------------------------------------------------- diagnóstico (log)

  function fmtBytes(n: number): string {
    return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
  }

  type Report = Record<string, any>

  /** Por onde a conexão passou: direto na rede local, direto pela internet (STUN) ou por relay. */
  async function logRoute(peerId: string, link: Link): Promise<void> {
    try {
      const stats = await link.pc.getStats()
      const all = new Map<string, Report>()
      stats.forEach((r: Report) => all.set(r.id, r))
      let pair: Report | undefined
      for (const r of all.values()) {
        if (r.type === 'transport' && r.selectedCandidatePairId) pair = all.get(r.selectedCandidatePairId)
      }
      pair ??= [...all.values()].find((r) => r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded')
      if (!pair) return
      const local = all.get(pair.localCandidateId)
      const remote = all.get(pair.remoteCandidateId)
      const kind = (c?: Report): string =>
        ({ host: 'rede local', srflx: 'internet (STUN)', prflx: 'internet', relay: 'relay' })[c?.candidateType as string] ?? '?'
      log(
        'info',
        `rota com ${nameOf(peerId)}: eu ${kind(local)} ↔ ${kind(remote)}, ${local?.protocol ?? '?'}` +
          (pair.currentRoundTripTime ? `, latência ${Math.round(pair.currentRoundTripTime * 1000)} ms` : '')
      )
    } catch {
      // sem estatísticas: segue sem esse detalhe
    }
  }

  const lastBytes = new Map<string, { t: number; bytes: number }>()

  function kbps(key: string, t: number, bytes: number): number | null {
    const prev = lastBytes.get(key)
    lastBytes.set(key, { t, bytes })
    if (!prev || t <= prev.t) return null
    return Math.round(((bytes - prev.bytes) * 8) / (t - prev.t)) // t em ms → kbit/s
  }

  const dbfs = (level?: number): string => (level && level > 0 ? `${Math.round(20 * Math.log10(level))} dBFS` : 'silêncio')

  /** Nível médio (dBFS) do que está chegando agora, medido no próprio áudio (a estatística do navegador fica em zero). */
  function measured(an: AnalyserNode): string {
    const buf = new Float32Array(an.fftSize)
    an.getFloatTimeDomainData(buf)
    let sum = 0
    for (const v of buf) sum += v * v
    const db = 10 * Math.log10(sum / buf.length + 1e-12)
    return db < -90 ? 'silêncio' : `${Math.round(db)} dBFS`
  }

  /**
   * Resumo de cada conexão para o log: o que chega e o que sai (taxa, perda, nível do som). O nível
   * mostra se um áudio chega baixo porque já saiu baixo de quem envia ou se é coisa de quem ouve.
   */
  async function statsSummary(): Promise<string[]> {
    const lines: string[] = []
    for (const [peerId, link] of links) {
      try {
        const stats = await link.pc.getStats()
        const parts: string[] = []
        let rtt: number | undefined
        stats.forEach((r: Report) => {
          if (r.type === 'candidate-pair' && r.nominated && r.currentRoundTripTime) rtt = r.currentRoundTripTime
          if (r.type === 'inbound-rtp') {
            const what =
              r.kind === 'video' ? 'vídeo da tela' : link.screenAudioTracks.has(r.trackIdentifier) ? 'som da tela' : 'voz'
            const rate = kbps(`${peerId}:in:${r.id}`, r.timestamp, r.bytesReceived ?? 0)
            if (!rate && r.kind === 'video') return
            let line = `recebe ${what}: ${rate ?? '?'} kbps`
            if (r.packetsLost) line += `, ${r.packetsLost} pacotes perdidos`
            if (r.kind === 'audio') line += `, nível ${measured(what === 'som da tela' ? link.screenAnalyser : link.analyser)}`
            if (r.kind === 'video' && r.frameWidth) line += `, ${r.frameWidth}x${r.frameHeight} ${Math.round(r.framesPerSecond ?? 0)} fps`
            parts.push(line)
          }
          if (r.type === 'outbound-rtp') {
            const rate = kbps(`${peerId}:out:${r.id}`, r.timestamp, r.bytesSent ?? 0)
            if (!rate) return
            const what =
              r.kind === 'video'
                ? 'vídeo da tela'
                : link.screenAudioSender && r.mediaSourceId && isScreenSource(stats, r.mediaSourceId)
                  ? 'som da tela'
                  : 'voz'
            parts.push(`envia ${what}: ${rate} kbps`)
          }
          if (r.type === 'media-source' && r.kind === 'audio' && r.audioLevel !== undefined) {
            const screen = screenStream?.getAudioTracks()[0]?.id === r.trackIdentifier
            parts.push(`${screen ? 'som da tela' : 'meu microfone'} na saída daqui: nível ${dbfs(r.audioLevel)}`)
          }
        })
        lines.push(
          `${nameOf(peerId)} (${link.pc.connectionState}${rtt ? `, latência ${Math.round(rtt * 1000)} ms` : ''}): ${parts.join(' | ') || 'sem mídia'}`
        )
      } catch (e) {
        lines.push(`${nameOf(peerId)}: sem estatísticas (${errText(e)})`)
      }
    }
    return lines
  }

  function isScreenSource(stats: RTCStatsReport, id: string): boolean {
    const src = stats.get(id) as Report | undefined
    return !!src && screenStream?.getAudioTracks()[0]?.id === src.trackIdentifier
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
    if (socket) socket.onclose = null
    socket?.close()
    pendingJoin?.reject(new Error('cancelado'))
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
    reconnect,
    answerKnock,
    signalingOpen,
    connectedPeerIds: () => [...links].filter(([, l]) => l.pc.connectionState === 'connected').map(([id]) => id),
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
    getOutputDevice,
    statsSummary
  }
}
