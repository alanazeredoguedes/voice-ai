"""Monta os áudios do "Testar desempenho" (página de benchmark do Whisper).

Gera, a partir de uma base pública de fala em português com o texto exato (CC BY 4.0):
  - FLEURS, pt_br, split "validation": frases lidas por várias pessoas brasileiras
    (vozes e microfones diferentes)

um áudio de ~30 min (Ogg Opus, mono, 16 kHz, ~24 kbps) e um JSON com o texto de cada trecho e o
tempo dele no áudio. Os testes de 1, 5, 8, 20 e 30 min são cortes desse áudio, sempre na emenda
entre dois trechos, então o texto correto de cada corte é exato.

Uso (precisa de pyarrow, av e numpy; não faz parte do app):
    python tools/build_benchmark_audio.py <fleurs_validation.parquet>

O parquet vem de:
    https://huggingface.co/api/datasets/google/fleurs/parquet/pt_br/validation/0.parquet
"""
import io
import json
import sys
from fractions import Fraction
from pathlib import Path

import av
import numpy as np
import pyarrow.parquet as pq

SR = 16000
TARGET_S = 30 * 60 + 15  # um pouco mais de 30 min, para o corte de 30 min existir
GAP_S = 0.5  # pausa entre trechos
CUTS_MIN = [1, 5, 8, 20, 30]
OUT = Path(__file__).resolve().parent.parent / "backend" / "assets" / "benchmark"


def decode(data: bytes) -> np.ndarray:
    """Qualquer formato (opus, wav...) → float32 mono 16 kHz."""
    out = []
    with av.open(io.BytesIO(data)) as c:
        rs = av.AudioResampler(format="flt", layout="mono", rate=SR)
        for frame in c.decode(c.streams.audio[0]):
            for f in rs.resample(frame):
                out.append(f.to_ndarray().reshape(-1))
        for f in rs.resample(None):
            out.append(f.to_ndarray().reshape(-1))
    return np.concatenate(out).astype(np.float32) if out else np.zeros(0, np.float32)


def write_opus(audio: np.ndarray, path: Path) -> None:
    with av.open(str(path), "w", format="ogg") as c:
        st = c.add_stream("libopus", rate=48000)
        st.bit_rate = 24000
        st.layout = "mono"
        rs = av.AudioResampler(format="s16", layout="mono", rate=48000)
        pcm = (np.clip(audio, -1, 1) * 32767).astype(np.int16)
        step = SR  # 1 s por vez
        pts = 0
        for i in range(0, len(pcm), step):
            fr = av.AudioFrame.from_ndarray(pcm[i:i + step].reshape(1, -1), format="s16", layout="mono")
            fr.sample_rate = SR
            fr.pts = pts
            fr.time_base = Fraction(1, SR)
            pts += fr.samples
            for f2 in rs.resample(fr):
                for p in st.encode(f2):
                    c.mux(p)
        for f2 in rs.resample(None):
            for p in st.encode(f2):
                c.mux(p)
        for p in st.encode(None):
            c.mux(p)


def build(items: list[tuple[np.ndarray, str]]) -> tuple[np.ndarray, list[dict], list[dict]]:
    parts, segs, t = [], [], 0.0
    gap = np.zeros(int(GAP_S * SR), np.float32)
    for audio, text in items:
        if t >= TARGET_S:
            break
        start = t
        parts += [audio, gap]
        t += len(audio) / SR + GAP_S
        segs.append({"start": round(start, 3), "end": round(start + len(audio) / SR, 3), "text": text.strip()})
    full = np.concatenate(parts)
    cuts = []
    for m in CUTS_MIN:
        mark = m * 60
        # emenda (fim de trecho) mais perto da marca
        best = min(range(len(segs)), key=lambda i: abs(segs[i]["end"] - mark))
        cut_s = round(segs[best]["end"] + GAP_S / 2, 3)
        cuts.append({"minutes": m, "end_s": cut_s, "segments": best + 1})
    return full, segs, cuts


def main(fleurs_path: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    # --- FLEURS: frases de várias pessoas, alternando vozes masculinas e femininas
    t = pq.read_table(fleurs_path)
    rows = t.select(["id", "raw_transcription", "gender"]).to_pylist()
    audio_col = t.column("audio")
    by_gender = {"0": [], "1": []}
    seen = set()
    for i, r in enumerate(rows):
        if r["id"] in seen:  # a mesma frase aparece lida por pessoas diferentes: usa uma vez só
            continue
        seen.add(r["id"])
        by_gender.setdefault(str(r["gender"]), []).append(i)
    order = []
    a, b = by_gender.get("0", []), by_gender.get("1", [])
    for k in range(max(len(a), len(b))):
        order += ([a[k]] if k < len(a) else []) + ([b[k]] if k < len(b) else [])
    fl_items = []
    total = 0.0
    for i in order:
        au = decode(audio_col[i].as_py()["bytes"])
        fl_items.append((au, rows[i]["raw_transcription"]))
        total += len(au) / SR + GAP_S
        if total >= TARGET_S:
            break
    full, segs, cuts = build(fl_items)
    write_opus(full, OUT / "fleurs.ogg")
    meta = {
        "id": "fleurs",
        "title": "Frases de várias pessoas",
        "description": "Frases da Wikipédia lidas por pessoas brasileiras diferentes, homens e mulheres.",
        "source": "FLEURS (pt_br), split validation",
        "credit": "FLEURS (Conneau et al., 2022), Google, CC BY 4.0",
        "license": "CC BY 4.0",
        "url": "https://huggingface.co/datasets/google/fleurs",
        "sample_rate": SR,
        "duration_s": round(len(full) / SR, 2),
        "cuts": cuts,
        "segments": segs,
    }
    (OUT / "fleurs.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"FLEURS: {meta['duration_s'] / 60:.1f} min, {len(segs)} trechos, cortes {cuts}")


if __name__ == "__main__":
    main(sys.argv[1])
