"""Gera backend/translate-lock.txt: os pacotes que SÓ a tradução precisa (argostranslate e tudo que ela puxa:
torch, spacy, stanza...), ou seja, o que o requirements.txt completo instala e o requirements-core.txt não.
O instalador não leva esses pacotes (pesam centenas de MB); o app os baixa na primeira instalação.
Uso (com o Python embutido, no build): python tools/make_translate_lock.py
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent / "backend"


def resolve(req: Path) -> dict[str, str]:
    """Pacotes (nome -> versão) que o pip instalaria a partir do zero, sem instalar nada."""
    with tempfile.TemporaryDirectory() as tmp:
        report = Path(tmp) / "report.json"
        subprocess.run([sys.executable, "-m", "pip", "install", "--dry-run", "--ignore-installed", "--quiet",
                        "--disable-pip-version-check", "--report", str(report), "-r", str(req)], check=True)
        data = json.loads(report.read_text(encoding="utf-8"))
    return {i["metadata"]["name"].lower().replace("_", "-"): i["metadata"]["version"] for i in data["install"]}


core = resolve(BACKEND / "requirements-core.txt")
full = resolve(BACKEND / "requirements.txt")
only = {n: v for n, v in full.items() if n not in core}
conflicts = {n: (core[n], full[n]) for n in core if n in full and core[n] != full[n]}
(BACKEND / "translate-lock.txt").write_text("".join(f"{n}=={v}\n" for n, v in sorted(only.items())), encoding="utf-8")
print(f"translate-lock.txt: {len(only)} pacotes ({', '.join(sorted(only)[:8])}...)")
if conflicts:
    print("AVISO: versões diferentes entre o núcleo e a lista completa:", conflicts)
