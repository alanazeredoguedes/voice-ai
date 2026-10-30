# Feature: Tradução Offline de Texto

## Resumo

Adicionar uma aba "Traduzir" no app que aceita texto como entrada e retorna
a tradução offline, sem internet, usando modelos open source.

---

## Stack recomendada

### Biblioteca: Argos Translate

- **Repo:** https://github.com/argosopentech/argos-translate
- **Instalação:** `pip install argostranslate`
- **Modelos:** baixados uma vez via `argostranslate.package` (~300 MB por par de idiomas)
- **Runtime:** 100% offline após o download inicial dos pacotes

**Por que Argos e não outra opção?**

- CTranslate2 já está instalado (dependência do faster-whisper) — o Argos o usa internamente
- API de 3 linhas de Python, sem configuração extra
- Suporte a ~30 pares de idiomas com qualidade razoável
- Alternativa ao MarianMT/Helsinki via HuggingFace (mais complexo de configurar)

---

## Dependências Python a instalar

```bash
pip install argostranslate
```

Pacotes de idioma baixados em runtime na primeira execução:

```python
import argostranslate.package as pkg

pkg.update_package_index()
available = pkg.get_available_packages()

# Instalar EN → PT
for p in available:
    if p.from_code == "en" and p.to_code == "pt":
        pkg.install_from_path(p.download())

# Instalar PT → EN
for p in available:
    if p.from_code == "pt" and p.to_code == "en":
        pkg.install_from_path(p.download())
```

Pacotes ficam em `~/.local/share/argos-translate/packages/`.

---

## Backend — nova rota

Arquivo: `backend/routes/translate.py`

```python
from fastapi import APIRouter
from pydantic import BaseModel

import argostranslate.translate as at

router = APIRouter(prefix="/translate", tags=["translate"])

SUPPORTED_PAIRS = [
    ("en", "pt"), ("pt", "en"),
    ("en", "es"), ("es", "en"),
    ("en", "fr"), ("fr", "en"),
    # adicionar conforme os pacotes instalados
]

class TranslateIn(BaseModel):
    text: str
    source: str  # código ISO 639-1, ex: "en"
    target: str  # código ISO 639-1, ex: "pt"

class TranslateOut(BaseModel):
    translated: str
    source: str
    target: str

@router.post("/text", response_model=TranslateOut)
async def translate_text(body: TranslateIn) -> TranslateOut:
    import asyncio
    translated = await asyncio.to_thread(
        at.translate, body.text, body.source, body.target
    )
    return TranslateOut(translated=translated, source=body.source, target=body.target)

@router.get("/pairs")
async def list_pairs() -> list[dict]:
    installed = at.get_installed_languages()
    pairs = []
    for lang in installed:
        for t in lang.translations_to:
            pairs.append({"from": lang.code, "to": t.to_lang.code})
    return pairs
```

Registrar em `backend/main.py`:
```python
from backend.routes import translate
app.include_router(translate.router)
```

---

## Frontend — nova view

Arquivo: `frontend/src/renderer/src/views/TranslateView.vue`

Interface sugerida:
- Dois `<select>` para idioma de origem e destino (com botão ↔ para inverter)
- Textarea de entrada (texto livre)
- Botão "Traduzir" — chama `POST /translate/text`
- Textarea de saída (readonly) + CopyButton
- Debounce opcional (traduzir automaticamente após 600ms sem digitar)

Adicionar ao `Sidebar.vue` como quarta opção no grupo superior, com ícone de globo:
```
icon: 'M10.5 21l5.25-11.25L21 21m-9-3h7.5M3 5.621a48.474 48.474 0 016-.371m0 0c1.12 0 2.233.038 3.334.114M9 5.25V3m3.334 2.364C11.176 10.658 7.69 15.08 3 17.502m9.334-12.138c.896.061 1.785.147 2.666.257m-4.589 8.495a18.023 18.023 0 01-3.827-5.802'
```

---

## Qualidade esperada

| Tipo de texto | Qualidade |
|---------------|-----------|
| Mensagens de WhatsApp / chat | Boa |
| E-mails e textos corridos | Boa |
| Texto técnico / jargão | Regular |
| Literatura / nuances | Regular a fraca |

Para textos simples do dia a dia (que é o caso de áudios de WhatsApp transcritos),
a qualidade é suficiente.

---

## Estimativa de implementação

| Etapa | Tempo estimado |
|-------|---------------|
| Instalar pacote + baixar modelos EN↔PT | 10 min |
| Rota backend (`/translate/text`) | 20-30 min |
| View frontend com UI completa | 45-60 min |
| Sidebar + integração | 15 min |
| **Total** | **~2 horas** |

---

## Bônus: Whisper já traduz áudio → inglês

O modelo Whisper tem suporte nativo a tradução de áudio diretamente para inglês
sem nenhuma biblioteca extra:

```python
segments, _ = whisper.transcribe(audio, task="translate", language="pt")
```

Isso permitiria adicionar uma opção na tela de "Transcrever Arquivo":
checkbox "Traduzir para inglês" — custo zero de implementação adicional.

---

## Decisão pendente

- [ ] Definir quais pares de idiomas instalar além de EN↔PT
- [ ] Decidir se a tradução é automática (debounce) ou manual (botão)
- [ ] Decidir se a aba fica no grupo superior ou inferior da sidebar
