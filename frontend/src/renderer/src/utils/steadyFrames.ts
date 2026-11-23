/**
 * Fps fixo para a transmissão da tela.
 *
 * O capturador do sistema só entrega um quadro quando a tela muda (ou quando o jogo/GPU consegue). Numa tela
 * parada (tela de carregamento, texto) isso cai para 1 fps, e com o computador ocupado fica em 15–25 fps: a
 * transmissão acompanhava a captura. Aqui a transmissão passa a sair num relógio fixo (30 ou 60 fps): a cada
 * tique vai o quadro mais novo da captura e, se não chegou nenhum novo, o último é repetido. O codificador
 * gasta quase nada nos quadros repetidos, e quem assiste recebe sempre o fps escolhido, sem travadas por
 * "falta de quadro".
 *
 * Isso NÃO inventa movimento: se a captura só entrega 22 quadros reais por segundo, quem assiste vê 22
 * movimentos por segundo (repetidos até 60). Por isso `captureFps()` informa quantos quadros reais chegaram,
 * para o log e os avisos continuarem apontando o gargalo certo (a captura), e não o fps de saída.
 */

type Level = 'info' | 'warn' | 'error'

export interface SteadyFrames {
  /** faixa de vídeo para enviar (sai sempre no fps escolhido) */
  track: MediaStreamTrack
  /** quadros REAIS por segundo que a captura entregou (última medição) */
  captureFps: () => number
  /** para tudo e encerra também a faixa de captura original */
  stop: () => void
}

interface TrackProcessorCtor {
  new (init: { track: MediaStreamTrack }): { readable: ReadableStream<VideoFrame> }
}
interface TrackGeneratorCtor {
  new (init: { kind: 'video' }): MediaStreamTrack & { writable: WritableStream<VideoFrame> }
}

export function startSteadyFrames(source: MediaStreamTrack, fps: number, log: (level: Level, msg: string) => void): SteadyFrames | null {
  const w = window as unknown as { MediaStreamTrackProcessor?: TrackProcessorCtor; MediaStreamTrackGenerator?: TrackGeneratorCtor }
  if (!w.MediaStreamTrackProcessor || !w.MediaStreamTrackGenerator || typeof VideoFrame === 'undefined') {
    log('warn', 'fps fixo indisponível neste sistema: a transmissão acompanha a captura')
    return null
  }
  try {
    const processor = new w.MediaStreamTrackProcessor({ track: source })
    const generator = new w.MediaStreamTrackGenerator({ kind: 'video' })
    const reader = processor.readable.getReader()
    const writer = generator.writable.getWriter()

    let last: VideoFrame | null = null
    let fresh = false
    let stopped = false
    let writing = false
    let realCount = 0
    let realFps = 0
    let sampleAt = performance.now()
    let sent = 0
    let repeated = 0
    let reportAt = performance.now()

    const finish = (why: string): void => {
      if (stopped) return
      log('info', `captura encerrada (${why}); parando o fps fixo`)
      stop(false)
      // a faixa de saída avisa que acabou (quem a escuta encerra a transmissão, como faria com a captura)
      generator.dispatchEvent(new Event('ended'))
    }

    // lê os quadros reais o mais rápido que chegam; guarda só o mais novo
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done || stopped) {
            value?.close()
            break
          }
          last?.close()
          last = value
          fresh = true
          realCount++
          const now = performance.now()
          if (now - sampleAt >= 1000) {
            realFps = Math.round((realCount * 1000) / (now - sampleAt))
            realCount = 0
            sampleAt = now
          }
        }
        if (!stopped) finish('a captura acabou')
      } catch (e) {
        if (!stopped) finish(`erro ao ler a captura: ${e instanceof Error ? e.message : e}`)
      }
    })()

    const tick = (): void => {
      if (stopped || !last || writing) return
      writing = true
      let out: VideoFrame
      try {
        out = new VideoFrame(last, { timestamp: Math.round(performance.now() * 1000) })
      } catch {
        writing = false
        return
      }
      if (fresh) fresh = false
      else repeated++
      sent++
      writer
        .write(out)
        .catch(() => out.close())
        .finally(() => {
          writing = false
        })
      const now = performance.now()
      if (now - reportAt >= 30_000) {
        log('info', `fps fixo: ${Math.round((sent * 1000) / (now - reportAt))} quadros/s enviados, ${Math.round((repeated * 1000) / (now - reportAt))}/s deles repetidos (a captura entregou ${realFps}/s reais)`)
        sent = 0
        repeated = 0
        reportAt = now
      }
    }

    // O relógio roda num Worker: timers de janela minimizada ou coberta podem ser atrasados pelo navegador,
    // os do Worker não.
    let worker: Worker | null = null
    let timer: ReturnType<typeof setInterval> | null = null
    const period = 1000 / fps
    try {
      const code = `let id=setInterval(()=>postMessage(0),${period});onmessage=()=>{clearInterval(id);close()}`
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
      worker = new Worker(url)
      URL.revokeObjectURL(url)
      worker.onmessage = tick
      worker.onerror = () => {
        worker?.terminate()
        worker = null
        if (!timer && !stopped) timer = setInterval(tick, period)
      }
    } catch {
      timer = setInterval(tick, period)
    }

    const stop = (stopSource = true): void => {
      if (stopped) return
      stopped = true
      worker?.postMessage('stop')
      worker?.terminate()
      worker = null
      if (timer) clearInterval(timer)
      void reader.cancel().catch(() => {})
      last?.close()
      last = null
      if (stopSource) source.stop()
      generator.stop()
    }

    log('info', `fps fixo ligado: a transmissão sai sempre em ${fps} quadros/s (repete o último quando a captura não entrega um novo)`)
    return { track: generator, captureFps: () => realFps, stop }
  } catch (e) {
    log('warn', `não foi possível ligar o fps fixo (${e instanceof Error ? e.message : e}); a transmissão acompanha a captura`)
    return null
  }
}
