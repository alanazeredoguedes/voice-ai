# Transmissão de tela pela placa de vídeo (etapa 2)

Plano para a próxima etapa da transmissão de tela da Chamada no Linux: comprimir o vídeo na placa de vídeo
(NVENC, NVIDIA) para chegar a 2K/4K com 60–90 fps. A etapa 1 (captura própria pelo ffmpeg) já está no app.

## Situação atual (depois da etapa 1)

Uma transmissão tem quatro etapas:

| Etapa | Linux com Xorg, hoje | Limite |
|---|---|---|
| 1. Copiar a tela | ffmpeg (`x11grab`) | ~60 fps mesmo numa tela de 6144×3456 |
| 2. Reduzir para a resolução escolhida | ffmpeg, vários núcleos | ~60 fps |
| 3. Comprimir | WebRTC do Chromium (OpenH264 / VP8, no **processador**) | 1080p ~58 fps, 2K ~35 fps, 4K ~28 fps |
| 4. Enviar | WebRTC (P2P) | a banda de upload |

Medido numa máquina com Ryzen 9 5900XT, RTX 5070 Ti, TV 4K com escala de 160% no Xorg (área desenhada de
6144×3456). Antes da etapa 1, o capturador do Chromium entregava ~10 fps em qualquer resolução: ele se limita
a 50% de um núcleo para copiar, comparar e reduzir a tela.

O gargalo que sobra em 2K e 4K é a **etapa 3**: o Chromium no Linux não comprime vídeo pela placa NVIDIA (só
usa VA-API, que a NVIDIA não oferece para compressão), então tudo é feito no processador.

## Proposta

Tirar a compressão do Chromium:

1. **Quem transmite:** o ffmpeg copia a tela e comprime com o **NVENC** (`h264_nvenc` ou `hevc_nvenc`), já na
   resolução escolhida.
2. **Envio:** o vídeo comprimido vai pelo canal de dados P2P que a chamada já tem (o mesmo do chat e dos
   arquivos), sem passar pelo compressor do WebRTC.
3. **Quem assiste:** descomprime com o **WebCodecs** (`VideoDecoder`, pela placa de vídeo de quem assiste) e
   desenha num `<canvas>`.

É o modelo de programas como Parsec e Moonlight.

## O que passa a ser nosso (o WebRTC fazia sozinho)

- **Controle de taxa:** medir a banda (tempo de entrega e fila do canal de dados) e ajustar a taxa do NVENC.
  O ffmpeg não muda a taxa no meio; provavelmente precisa de um processo próprio com a NVENC API, ou reiniciar
  o ffmpeg em degraus.
- **Perda e recuperação:** canal de dados não confiável (sem reenvio, para não acumular atraso) e pedido de
  quadro completo (IDR) quando quem assiste perder um pedaço.
- **Sincronia com o som:** o som continua pelo WebRTC; marcar o tempo de cada quadro para alinhar.
- **Uma cópia por pessoa assistindo:** cada uma recebe o vídeo inteiro, então o upload necessário se
  multiplica.

## Limites

- Só para quem transmite do **Linux com NVIDIA e ffmpeg**. No Windows o WebRTC já comprime pela placa de vídeo
  (H.264 pelo Media Foundation).
- A internet vira o limite: 1080p a 90 fps ≈ 8–12 Mbps, 2K a 60 fps ≈ 10–15 Mbps, 4K a 90 fps ≈ 30–50 Mbps
  **por pessoa assistindo**.
- Opção separada na tela de compartilhar ("Alta qualidade (placa de vídeo)"), com volta automática para a
  transmissão normal se algo falhar.

## Testes necessários

- 1080p90, 2K60, 4K60 entre duas máquinas em redes diferentes: fps, atraso, perda, travadas (os logs da
  transmissão já registram tudo a cada 10 s).
- Rede ruim simulada (perda de 1–5%): recuperação sem travar a imagem.
- Uso de processador e placa de vídeo dos dois lados.
