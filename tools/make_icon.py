"""Gera o ícone do Voice AI (onda de voz + dois raios, em degradê azul escuro→preto).

Uso (precisa de Pillow e numpy, que já estão na venv do backend):
    backend/venv/bin/python tools/make_icon.py

Cria:
    frontend/build/icon.png    1024x1024  (electron-builder: AppImage e instalador do Windows)
    frontend/build/icon.ico    16 a 256   (instalador e atalhos do Windows)
    frontend/resources/icon.png 256x256   (janela e bandeja do app, via electron-vite ?asset)

Para mudar cores ou formas, ajuste as constantes abaixo e rode de novo.
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SIZE = 1024
SS = 4  # desenha 4x maior e reduz (bordas suaves)

COLOR_A = (37, 78, 190)    # azul escuro (topo esquerdo)
COLOR_B = (4, 7, 20)       # quase preto (base direita)
BOLT_COLOR = (255, 255, 255)  # raios brancos

# alturas das barras da onda (0 a 1 da altura útil), da esquerda para a direita
BARS = [0.30, 0.55, 0.88, 0.55, 0.30]


def gradient(size: int) -> Image.Image:
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    t = np.clip((x + y) / (2 * (size - 1)), 0, 1)[..., None]
    a = np.array(COLOR_A, np.float32)
    b = np.array(COLOR_B, np.float32)
    rgb = (a + (b - a) * t).astype(np.uint8)
    return Image.fromarray(rgb, 'RGB').convert('RGBA')


def rounded_mask(size: int, radius: int) -> Image.Image:
    m = Image.new('L', (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return m


# raio (contorno numa caixa de 0 a 1): ponta de cima, desce para a esquerda, degrau, ponta de baixo e volta
BOLT = [(0.60, 0.00), (0.10, 0.56), (0.42, 0.56), (0.28, 1.00), (0.90, 0.38), (0.56, 0.38), (0.78, 0.00)]


def bolt(cx: float, cy: float, h: float) -> list[tuple[float, float]]:
    """Raio de altura `h` com o centro em (cx, cy)."""
    w = h * 0.78
    return [(cx + (x - 0.5) * w, cy + (y - 0.5) * h) for x, y in BOLT]


def draw_icon() -> Image.Image:
    n = SIZE * SS
    img = gradient(n)

    # brilho suave no alto (dá volume sem pesar)
    glow = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse((-n * 0.2, -n * 0.65, n * 1.2, n * 0.45), fill=(255, 255, 255, 30))
    img = Image.alpha_composite(img, glow.filter(ImageFilter.GaussianBlur(n * 0.11)))

    d = ImageDraw.Draw(img)
    # onda de voz: barras arredondadas brancas, centradas um pouco abaixo do meio
    bar_w = n * 0.108
    gap = n * 0.052
    total = len(BARS) * bar_w + (len(BARS) - 1) * gap
    x0 = (n - total) / 2
    cy = n * 0.60
    max_h = n * 0.46
    for i, h in enumerate(BARS):
        bh = max_h * h
        x = x0 + i * (bar_w + gap)
        d.rounded_rectangle((x, cy - bh / 2, x + bar_w, cy + bh / 2), radius=bar_w / 2, fill=(255, 255, 255, 255))

    # dois raios (um maior e um menor) no canto superior direito
    d.polygon(bolt(n * 0.745, n * 0.225, n * 0.25), fill=BOLT_COLOR + (255,))
    d.polygon(bolt(n * 0.885, n * 0.385, n * 0.115), fill=BOLT_COLOR + (255,))

    img = img.resize((SIZE, SIZE), Image.LANCZOS)
    out = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    radius = int(SIZE * 0.225)
    out.paste(img, (0, 0), rounded_mask(SIZE, radius))
    # contorno claro e fino: o canto quase preto não some em painéis escuros do sistema
    rim = Image.new('RGBA', (SIZE * 2, SIZE * 2), (0, 0, 0, 0))
    ImageDraw.Draw(rim).rounded_rectangle((3, 3, SIZE * 2 - 4, SIZE * 2 - 4), radius=radius * 2, outline=(255, 255, 255, 70), width=7)
    out = Image.alpha_composite(out, rim.resize((SIZE, SIZE), Image.LANCZOS))
    return out


def main() -> None:
    icon = draw_icon()
    build = ROOT / 'frontend' / 'build'
    res = ROOT / 'frontend' / 'resources'
    build.mkdir(parents=True, exist_ok=True)
    res.mkdir(parents=True, exist_ok=True)
    icon.save(build / 'icon.png', optimize=True)
    icon.save(build / 'icon.ico', sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])
    icon.resize((256, 256), Image.LANCZOS).save(res / 'icon.png', optimize=True)
    print('ícones gerados em', build, 'e', res)


if __name__ == '__main__':
    main()
