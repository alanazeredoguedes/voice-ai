# Voice AI

Assistente de voz para Linux com dois modos de operação: **transcrição para clipboard** e **assistente IA com resposta falada**. Interface gráfica na bandeja do sistema, atalhos configuráveis via push-to-talk, transcrição local com Whisper (GPU/CPU) e voz neural gratuita via Edge TTS.

> **Plataforma:** Linux (Ubuntu 22.04+ testado) — requer X11 ou XWayland para os atalhos globais funcionarem.

---

## O que faz

| Modo | Como usar | Resultado |
|------|-----------|-----------|
| **Transcrição** | Segura o atalho, fala, solta | Texto copiado para o clipboard — cola em qualquer lugar |
| **Assistente IA** | Segura o outro atalho, pergunta, solta | Claude responde em voz alta, sem abrir terminal |

- Transcrição **100% local** com [faster-whisper](https://github.com/SYSTRAN/faster-whisper) — áudio nunca sai do computador
- Suporte a GPU NVIDIA (CUDA) e CPU — detecção automática
- Voz neural gratuita via [Edge TTS](https://github.com/rany2/edge-tts) (Microsoft) ou [ElevenLabs](https://elevenlabs.io) (opcional, pago)
- Hotkeys globais: qualquer tecla, combinação com Ctrl/Alt/Shift ou botões extras do mouse
- Histórico de conversa com o Claude (modo IA continua o contexto entre perguntas)
- Som de feedback em cada etapa (gravando, processando, copiado)
- Overlay flutuante de status no canto da tela

---

## Requisitos

| Dependência | Obrigatório | Observação |
|-------------|-------------|------------|
| **Linux** | Sim | Testado Ubuntu 22.04+, Debian, derivados |
| **X11 ou XWayland** | Sim | Atalhos globais via pynput não funcionam em Wayland puro |
| **Python 3.10+** | Sim | |
| **ffmpeg** | Sim | Conversão de áudio para TTS |
| **aplay (alsa-utils)** | Sim | Reprodução de áudio |
| **claude CLI** | Só modo IA | Assinatura Claude Pro (grátis via CLI) |
| **GPU NVIDIA** | Não | Acelera muito a transcrição; CPU funciona bem |

### Nota sobre Wayland

Ubuntu 22.04+ e outras distros modernas usam Wayland por padrão. Se os atalhos não funcionarem, verifique:

```bash
echo $XDG_SESSION_TYPE   # deve retornar "x11"
```

Para forçar X11 no Ubuntu: faça logout → na tela de login, clique na engrenagem → selecione **"Ubuntu on Xorg"**.

---

## Instalação

### 1. Dependências do sistema

```bash
sudo apt install ffmpeg alsa-utils python3-venv
```

### 2. Claude CLI (apenas para o modo IA)

O assistente usa o `claude` CLI oficial da Anthropic — **gratuito para assinantes do plano Pro**, sem custo adicional de API.

```bash
npm install -g @anthropic-ai/claude-code
claude  # faz login interativo na primeira execução
```

> Sem o `claude` instalado, o modo transcrição funciona normalmente. Apenas o modo IA ficará desabilitado.

### 3. Voice AI

```bash
git clone https://github.com/alanguedes/voice-ai
cd voice-ai
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
```

### 4. GPU NVIDIA (opcional, recomendado)

Se você tiver uma GPU NVIDIA com CUDA:

```bash
pip install nvidia-cublas-cu12 nvidia-cudnn-cu12
```

O app detecta a GPU automaticamente na inicialização. Sem GPU, roda em CPU sem configuração extra — apenas um pouco mais lento na transcrição.

---

## Uso

```bash
.venv/bin/voice-ai
```

Na primeira execução, o modelo Whisper é baixado automaticamente (~500 MB para o `medium`). O app aparece na **bandeja do sistema** (system tray). Clique no ícone para abrir o painel de configurações.

### Argumentos de linha de comando

```bash
voice-ai [--model MODEL] [--device DEVICE] [--hidden]
```

| Argumento | Padrão | Descrição |
|-----------|--------|-----------|
| `--model` | `medium` | Modelo Whisper: `tiny`, `base`, `small`, `medium`, `large-v3` |
| `--device` | `auto` | Dispositivo: `auto`, `cuda`, `cpu` |
| `--hidden` | — | Inicia sem abrir a janela de configurações |

**Exemplos:**

```bash
# Iniciar na bandeja, sem abrir janela
.venv/bin/voice-ai --hidden

# Forçar modelo maior com GPU
.venv/bin/voice-ai --model large-v3 --device cuda

# Forçar CPU (mesmo tendo GPU)
.venv/bin/voice-ai --device cpu
```

### Autostart com o sistema

Para iniciar automaticamente ao fazer login, crie um arquivo `.desktop` de autostart:

```bash
mkdir -p ~/.config/autostart
cat > ~/.config/autostart/voice-ai.desktop << EOF
[Desktop Entry]
Type=Application
Name=Voice AI
Exec=/caminho/para/voice-ai/.venv/bin/voice-ai --hidden
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
EOF
```

Substitua `/caminho/para/voice-ai/` pelo caminho real onde você clonou o repositório.

---

## Atalhos padrão

| Atalho | Ação |
|--------|------|
| **Mouse Botão 8** | Gravar → transcrever → copiar para clipboard |
| **Ctrl + Mouse Botão 8** | Gravar → enviar ao Claude → resposta em voz |

Os atalhos são **totalmente configuráveis** no painel de configurações. Suportam qualquer tecla, combinações com Ctrl/Alt/Shift, e botões extras do mouse.

### Como usar no dia a dia

1. Inicie o app (ou configure o autostart)
2. Em qualquer aplicativo (editor, chat, browser), **segure o atalho de transcrição**
3. Fale normalmente
4. **Solte o atalho** — o texto aparece no clipboard em ~1–2 segundos
5. **Ctrl+V** para colar onde quiser

Para fazer uma pergunta ao Claude:
1. **Segure o atalho de IA**, faça a pergunta em voz, **solte**
2. O app processa, pensa (aguarda o Claude) e **responde em voz alta**
3. Pode continuar a conversa — o contexto é mantido entre perguntas

**Cancelar gravação:** clique duplo no atalho enquanto segura.

---

## Configuração

Clique no **ícone na bandeja** para abrir o painel de configurações.

### Atalhos de voz

Clique no botão do atalho e pressione a combinação desejada. O botão entra em modo de captura automaticamente. Suporte a:
- Teclas simples: `a`, `F9`, `espaço`
- Combinações: `Ctrl+F9`, `Alt+Z`
- Botões do mouse: `Botão direito`, `Botão do meio`, botões extras (4–9)
- Misto: `Ctrl+Botão 8`

### Modelo Whisper (transcrição)

| Modelo | Velocidade | Precisão | VRAM aprox. |
|--------|-----------|----------|-------------|
| tiny | Muito rápido | Básica | ~1 GB |
| base | Rápido | Boa | ~1 GB |
| small | Médio | Boa | ~2 GB |
| **medium** *(padrão)* | Médio | Muito boa | ~5 GB |
| large-v3 | Lento | Máxima | ~10 GB |

> Mudanças de modelo ou dispositivo requerem reiniciar o app.

### Voz do assistente (TTS)

**Edge TTS** (padrão) — vozes neurais da Microsoft, gratuito, sem conta necessária:

| Voz | Gênero |
|-----|--------|
| Antonio | Masculino |
| Francisca | Feminino |
| Thalita Multilingual | Feminino (multilíngue) |

**ElevenLabs** — vozes ultra-realistas, plano gratuito com 10.000 caracteres/mês:

1. Crie uma conta em [elevenlabs.io](https://elevenlabs.io)
2. Vá em **Profile → API Keys** e gere uma chave
3. No app: selecione **ElevenLabs** como backend → **⚙ Configurar**
4. Cole a chave, clique em **Buscar vozes**, escolha e salve

### Prompt do sistema (modo IA)

O prompt padrão instrui o Claude a responder de forma direta e conversacional, adequado para respostas em voz. Você pode customizar pelo painel de configurações — o campo suporta qualquer instrução de sistema.

### Sons de feedback

Três sons sintetizados indicam cada etapa:
- **Início da gravação**: dois tons ascendentes
- **Início do processamento**: tom de confirmação
- **Texto copiado**: dois tons de sucesso

Cada som pode ser desativado individualmente nas configurações.

---

## Arquitetura

```
voice_ai/
├── cli/
│   └── voice_ai_cmd.py    # Entry point: inicialização, wiring, loop principal Qt
├── gui/
│   ├── main_window.py     # Janela principal e painel de configurações (PyQt6)
│   ├── bridge.py          # Bridge thread-safe via pyqtSignal (áudio → Qt)
│   ├── hotkey_manager.py  # Atalhos globais via pynput (teclado + mouse)
│   ├── overlay.py         # Overlay flutuante + sons de feedback via sounddevice
│   └── tray.py            # Ícone e menu da bandeja do sistema
├── speech_engine.py       # STT: faster-whisper, captura via sounddevice, VAD simples
├── brain.py               # IA: Claude via subprocess CLI, streaming JSON, histórico
└── tts.py                 # TTS: Edge TTS e ElevenLabs, reprodução via ffmpeg + aplay
```

### Fluxo de dados

```
Microfone (sounddevice)
    ↓ chunks de 512 amostras a 16 kHz
SpeechEngine (thread separada)
    ↓ array numpy
faster-whisper (GPU/CPU)
    ↓ texto transcrito
    ├── Modo Transcrição → clipboard (pyperclip) → done
    └── Modo IA → ClaudeBrain
                    ↓ subprocess: claude -p --system-prompt "..."
                    ↓ streaming JSON line by line
                    ↓ detecção de fronteira de frase
                  TextToSpeech
                    ↓ edge-tts async ou ElevenLabs HTTP
                    ↓ ffmpeg → aplay
                  Resposta em voz
```

### Componentes principais

**`SpeechEngine`** — Captura áudio em thread dedicada com `sounddevice`. Usa VAD por energia RMS (threshold 0.003) para detectar início e fim da fala. Carrega o modelo Whisper uma vez na inicialização. Filtra alucinações comuns do Whisper (lista de falsos positivos).

**`ClaudeBrain`** — Invoca `claude -p` via subprocess com streaming ativado. Parseia as linhas JSON de resposta em tempo real, detecta fronteiras de frase por pontuação para iniciar TTS antes de o Claude terminar de responder. Suporta modo de conversa contínua com `-c` (mantém contexto entre invocações).

**`TextToSpeech`** — Opera com uma fila de frases: assim que `ClaudeBrain` emite a primeira frase, o TTS já começa a sintetizar enquanto o Claude ainda está respondendo. Usa `asyncio` para Edge TTS e HTTP direto para ElevenLabs. Reprodução via `ffmpeg | aplay`.

**`HotkeyManager`** — Listeners separados para teclado e mouse via `pynput`. Unifica modificadores dos dois lados (Ctrl_L = Ctrl_R = Ctrl). Suporta qualquer combinação de modificadores + tecla/botão como trigger. Pausável durante a captura de novo atalho na UI.

**`Bridge`** — Objeto Qt com sinais (`pyqtSignal`) que serve de canal thread-safe entre threads de áudio/IA e a thread principal Qt. Evita race conditions sem precisar de locks explícitos.

---

## Desenvolvimento

### Configurar ambiente

```bash
git clone https://github.com/alanguedes/voice-ai
cd voice-ai
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
```

### Estrutura de logs

Cada transcrição gera uma entrada JSON em `~/.local/share/voice-ai/logs/transcriptions.log`:

```json
{
  "timestamp": "2025-08-17T14:32:10",
  "text": "texto transcrito",
  "model": "medium",
  "device": "cuda",
  "rtf": 0.12,
  "duration_s": 3.4
}
```

`rtf` (Real-Time Factor) < 1.0 significa mais rápido que tempo real.

### Adicionar um novo backend de TTS

1. Edite `voice_ai/tts.py` — implemente um método `async def _synthesize_novo(self, text, path)` que salve o áudio em `path`
2. Adicione a opção no `self.backend` em `__init__`
3. Exponha a opção na UI em `voice_ai/gui/main_window.py` no `TTSConfigWidget`

### Adicionar um novo motor de IA

1. Implemente uma classe com interface similar a `ClaudeBrain` em `voice_ai/brain.py`:
   - `start(prompt, on_sentence, on_done)` — on_sentence é chamado para cada frase gerada
   - `stop()` — cancela a geração em andamento
2. Instancie no `voice_ai/cli/voice_ai_cmd.py` baseado em argumento CLI ou configuração

---

## Dependências

| Pacote | Uso |
|--------|-----|
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | Transcrição de voz local (GPU/CPU) |
| [PyQt6](https://pypi.org/project/PyQt6/) | Interface gráfica e bandeja do sistema |
| [edge-tts](https://github.com/rany2/edge-tts) | Voz neural da Microsoft (gratuito, sem conta) |
| [pynput](https://github.com/moses-palmer/pynput) | Captura global de teclado e mouse |
| [sounddevice](https://python-sounddevice.readthedocs.io/) | Captura de áudio do microfone |
| [numpy](https://numpy.org/) | Processamento de sinal de áudio |
| [Claude Code CLI](https://github.com/anthropics/claude-code) | Motor de IA (gratuito com plano Pro) |

**Ferramentas do sistema:**

| Ferramenta | Pacote apt | Uso |
|------------|-----------|-----|
| ffmpeg | `ffmpeg` | Conversão de áudio (MP3 → WAV) para TTS |
| aplay | `alsa-utils` | Reprodução de áudio |

---

## Dados e privacidade

- A transcrição é feita **100% localmente** — o áudio nunca sai do seu computador
- No modo IA, o texto da pergunta é enviado ao Claude (Anthropic) via CLI local
- Logs de transcrição: `~/.local/share/voice-ai/logs/transcriptions.log`
- Configurações: `~/.local/share/voice-ai/settings.json`
- Chave ElevenLabs (se usada): armazenada em plaintext no `settings.json` local

---

## Solução de problemas

**Atalhos não funcionam**
→ Verifique se está em X11: `echo $XDG_SESSION_TYPE`. Em Wayland, use `pynput` requer XWayland ou sessão X11.

**Erro ao carregar o modelo Whisper**
→ Verifique espaço em disco (~500 MB para `medium`). O modelo é baixado em `~/.cache/huggingface/`.

**Áudio não reproduz (TTS)**
→ Verifique se `aplay` está instalado: `which aplay`. Instale com `sudo apt install alsa-utils`.

**GPU não detectada**
→ Instale `nvidia-cublas-cu12 nvidia-cudnn-cu12` no `.venv`. Verifique com `nvidia-smi`.

**`claude` não encontrado**
→ O app busca o `claude` CLI em `~/.nvm/`, `~/.local/bin/`, `~/bin/` e `$PATH`. Instale com `npm install -g @anthropic-ai/claude-code` ou verifique se o binário está acessível.

**Microfone não captura**
→ Verifique permissões: `arecord -l` para listar dispositivos. O `sounddevice` usa o dispositivo padrão do sistema.

---

## Licença

[MIT](LICENSE) — Alan Guedes, 2025
