/**
 * Barras de volume da Chamada: a posição da barra não é linear com o volume.
 *
 * O ouvido percebe volume em escala logarítmica: numa barra linear de 0 a 200%, o trecho de 0 a 5%
 * (onde a diferença é bem audível) ocupava só um pedacinho no começo. Aqui o volume é o quadrado da
 * posição: 100% fica no meio, a primeira metade vai de 0 a 25% e a segunda de 25% a 400%.
 */
export const MAX_CALL_VOLUME = 4

/** posição da barra (0 a 1) → volume (0 a 4) */
export function sliderToVolume(pos: number): number {
  const v = MAX_CALL_VOLUME * pos * pos
  return Math.abs(v - 1) < 0.03 ? 1 : v // "gruda" nos 100%
}

/** volume (0 a 4) → posição da barra (0 a 1) */
export function volumeToSlider(volume: number): number {
  return Math.sqrt(Math.min(Math.max(volume, 0), MAX_CALL_VOLUME) / MAX_CALL_VOLUME)
}

/** "0,4%", "7%", "100%", "350%" */
export function formatVolume(volume: number): string {
  const pct = volume * 100
  if (pct > 0 && pct < 1) return `${pct.toFixed(1).replace('.', ',')}%`
  return `${Math.round(pct)}%`
}
