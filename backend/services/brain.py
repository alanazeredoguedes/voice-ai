import json as _json
import os
import shutil
import subprocess
import hashlib
import time
import uuid
from collections.abc import Callable, Generator
from datetime import datetime
from pathlib import Path

from . import claude_usage
from .media_markers import MediaCallback, MediaMarkerFilter

# Versão das instruções do app: entra na chave da sessão, então mudar as instruções começa uma
# sessão nova do Claude (o --resume ignoraria o system prompt novo)
PROMPT_VERSION = "5"

# Modelos que dá para escolher no app (apelidos do Claude Code: sempre a versão mais nova de cada um)
CLAUDE_MODELS = ("haiku", "sonnet", "opus")
DEFAULT_CLAUDE_MODEL = "haiku"
# modelo que respondeu de verdade, por escolha - a tela mostra o nome/versão
resolved_models: dict[str, str] = {}


def _friendly_error(detail: str) -> str:
    """Mensagem curta (vai para o chat e para o TTS) quando o Claude responde com erro."""
    low = detail.lower()
    if any(k in low for k in ("login", "log in", "logged", "authenticat", "api key", "credential", "oauth")):
        return (
            "Você ainda não entrou na sua conta Claude. "
            "Vá em Configurações, na seção Claude, e clique em Entrar na conta."
        )
    if any(k in low for k in ("rate limit", "usage limit", "limit reached", "quota")):
        return "O limite de uso da sua conta Claude foi atingido. Tente de novo mais tarde."
    return "Desculpe, o Claude retornou um erro. Tente novamente em instantes."


def _session_exists(session_id: str) -> bool:
    """O Claude Code guarda cada sessão em ~/.claude/projects/<pasta>/<id>.jsonl."""
    base = Path(os.environ.get("CLAUDE_CONFIG_DIR") or (Path.home() / ".claude")) / "projects"
    return any(base.glob(f"*/{session_id}.jsonl"))


def _find_claude() -> str:
    extra = []
    nvm_root = Path.home() / ".nvm" / "versions" / "node"
    if nvm_root.exists():
        for v in sorted(nvm_root.iterdir(), reverse=True):
            extra.append(str(v / "bin"))
    extra += [str(Path.home() / ".local" / "bin"), str(Path.home() / "bin")]
    search = os.pathsep.join(extra + os.environ.get("PATH", "").split(os.pathsep))
    return shutil.which("claude", path=search) or "claude"


_CLAUDE_BIN = _find_claude()


def _claude_cwd() -> str:
    """Diretório de trabalho do `claude` (sessões do -c ficam associadas a ele).
    Garante que exista - numa instalação nova a pasta pode ainda não ter sido criada."""
    d = Path.home() / ".local/share/voice-ai"
    d.mkdir(parents=True, exist_ok=True)
    return str(d)


def _claude_env() -> dict[str, str]:
    """Sem o ToolSearch, a pesquisa na internet já vem disponível: economiza uma rodada (~1,5 a 3 s)
    em que o Claude só "descobria" a ferramenta antes de usar."""
    env = dict(os.environ)
    env["ENABLE_TOOL_SEARCH"] = "false"
    return env


class ClaudeBrain:
    """Envia perguntas ao Claude via CLI (claude -p). Grátis no plano Pro."""

    THINKING_PHRASES = [
        "Me dá um segundo, vou pensar.",
        "Deixa eu ver isso.",
        "Um momento, processando.",
        "Hmm, vou pensar nessa.",
        "Aguenta, estou calculando.",
        "Boa pergunta, deixa eu ver.",
        "Processando, já já respondo.",
        "Só um instante.",
        "Deixa eu consultar aqui.",
        "Estou pesquisando isso pra você.",
        "Já vou te falar.",
        "Interessante, deixa eu pensar.",
        "Um segundo, vou buscar essa informação.",
        "Calma, tô raciocinando.",
        "Deixa eu verificar isso rapidinho.",
        "Analisando a sua pergunta.",
        "Vou checar isso pra você.",
        "Espera aí, já respondo.",
        "Pesquisando, um momento.",
        "Deixa eu pensar um pouquinho.",
        "Tô consultando aqui, já já.",
        "Boa, deixa eu investigar isso.",
    ]

    DEFAULT_SYSTEM_PROMPT = (
        "Você é um assistente de voz rodando no computador do usuário. "
        "Responda sempre em português do Brasil, adequado para ser lido em voz alta. "
        "Para perguntas simples e diretas: responda em no máximo 80 palavras. "
        "Para pedidos de resumo, análise, história ou explicação detalhada: responda de forma completa e sem limite de palavras. "
        "Não use emojis. "
        "Tom informal e direto, como um amigo brasileiro conversando."
    )

    # Sempre anexado ao system prompt (mesmo customizado) quando "media_enabled" está ligado.
    MEDIA_INSTRUCTIONS = (
        "\n\nIMAGENS E VÍDEOS NO CHAT: a tela do chat mostra imagens e vídeos no meio da sua resposta. Para colocar, "
        "escreva numa linha sozinha, entre parágrafos, logo depois do trecho que elas ilustram:\n"
        "[[IMAGENS: termo de busca | o que as imagens precisam mostrar]]\n"
        "[[VIDEOS: termo de busca | o que o vídeo precisa mostrar]]\n"
        "O app busca na internet, confere as imagens e coloca só as que mostram exatamente o que você descreveu, "
        "enquanto você continua escrevendo: não espere, siga com o resto da resposta normalmente. "
        "Termo de busca: específico; para jogos e temas internacionais em inglês, com o nome completo do jogo e o "
        "nome exato do item, local, chefe ou personagem (ex.: 'Zelda Tears of the Kingdom Princess Zelda'); use o "
        "contexto da conversa para saber de qual jogo ou assunto se trata; temas brasileiros em português (ex.: "
        "'Praia de Copacabana Rio de Janeiro'); para vídeos de jogo acrescente guide, walkthrough, location ou boss "
        "fight quando fizer sentido. Descrição: curta, em português, do que precisa aparecer (ex.: 'a Princesa Zelda "
        "com a roupa de exploradora'). Seja EXATO: o termo e a descrição são tudo o que o app sabe do pedido. "
        "Diga a versão e a edição precisas (original, remaster, remake, console, temporada, DLC), use o nome oficial "
        "do jogo ou da versão em vez de apelidos que sirvam para outra versão, e diga em uma frase o que NÃO deve "
        "aparecer (ex.: 'do remake de Switch 2, não do jogo original de N64; sem foto do aparelho nem banner'). "
        "Pode haver mais de um marcador, cada um perto do assunto dele. "
        "Nunca fale das imagens nem da busca: nada de 'aqui estão algumas imagens', 'vou buscar', 'deixei umas "
        "imagens no chat' ou 'veja abaixo'. A resposta é lida em voz alta e as imagens simplesmente aparecem. "
        "Nunca escreva links ou URLs."
    )

    # Mídia por iniciativa própria (setting "media_proactive"): a IA complementa a resposta sozinha
    MEDIA_PROACTIVE = (
        " Use imagens por conta própria sempre que uma referência visual ajudar a entender, mesmo sem o usuário "
        "pedir: como é um item, arma, armadura, personagem, inimigo, chefe, lugar, mapa, objeto, produto, tela de "
        "um programa ou uma pessoa conhecida; onde fica algo; um passo a passo que fica mais claro vendo. Vídeo "
        "quando a resposta envolver um caminho, um puzzle, uma luta de chefe ou uma técnica difícil de explicar só "
        "com palavras. Não use em conversa casual, contas, opiniões ou respostas que já ficam claras só com texto, "
        "e não repita imagens de um assunto que já foi mostrado nesta conversa."
    )
    # Pesquisa na internet (setting "web_search"): libera as ferramentas WebSearch/WebFetch do Claude Code
    WEB_TOOLS = "WebSearch WebFetch"
    WEB_INSTRUCTIONS = (
        "\n\nPESQUISA NA INTERNET: você tem as ferramentas WebSearch e WebFetch. Use quando a pergunta depender de "
        "informação atual ou que você pode não saber: notícias, acontecimentos recentes, preços, cotações, resultados "
        "de jogos, clima, lançamentos, versões de software, horários. Para notícias do dia, pesquise com a data de hoje "
        "e, se a busca não trouxer o dia certo, abra com WebFetch a página inicial de um site de notícias (ex.: g1.globo.com). "
        "Para tempo/clima, não pesquise: abra direto com WebFetch https://wttr.in/NOME+DA+CIDADE?format=j1&lang=pt "
        "(dados atuais e previsão de hoje e dos próximos dias; ex.: https://wttr.in/Niteroi?format=j1&lang=pt). "
        "Não pesquise para conversa casual ou o que você já sabe bem. Responda direto com o que encontrou "
        "e NUNCA liste fontes, links ou URLs no fim (a resposta é lida em voz alta); se for útil, cite só o "
        "nome do site no meio da frase, como 'segundo o g1'."
    )

    WEB_OFF = (
        " Você não tem acesso à internet nesta conversa. Se pedirem algo atual (notícias, preços, resultados), "
        "diga que a pesquisa na internet está desligada e que dá para ligar em Configurações, na seção Claude."
    )

    MEDIA_ON_REQUEST_ONLY = (
        " Só use o marcador quando o usuário quiser ver ou achar mídia; perguntas normais não levam marcador."
    )

    # Formatação (sempre anexada, mesmo com system prompt do chat): a tela desenha markdown simples e a voz
    # lê só o texto (sem os símbolos; tabelas não são lidas, ver services/rich_text.py)
    FORMAT_INSTRUCTIONS = (
        "\n\nFORMATAÇÃO: a tela do chat mostra markdown simples e a voz lê só o texto (os símbolos não são falados). "
        "Use formatação quando ela deixar a resposta mais fácil de entender:\n"
        "- '## ' para um subtítulo curto separando as partes de uma explicação maior ('### ' dentro de uma parte);\n"
        "- **negrito** para nomes e termos importantes; em listas de características use '- **Termo:** explicação';\n"
        "- '- ' para listas de itens, opções, dicas ou recompensas;\n"
        "- '1. ', '2. '... para passo a passo, um passo por item, em frases completas;\n"
        "- tabela (| coluna | coluna | com a linha |---|---| embaixo do cabeçalho) para comparar valores ou opções. "
        "A voz não lê a tabela e avisa sozinha que ela está no chat, então não escreva 'segue a tabela' nem algo "
        "parecido; depois dela, escreva em texto a conclusão principal;\n"
        "- `código` só para comandos ou nomes técnicos.\n"
        "Para conversa casual, respostas curtas, perguntas simples ou opiniões, responda em texto corrido, sem "
        "títulos nem listas. Comece sempre com uma ou duas frases respondendo direto, antes de qualquer título ou "
        "lista. Separe parágrafos, títulos, listas e tabelas com uma linha em branco. Não use emojis, citações (>), "
        "linhas horizontais, links ou listas dentro de listas."
    )

    def __init__(
        self,
        settings: dict,
        chat_prompt: str = "",
        session_id: str | None = None,
        session_key: str | None = None,
        on_session: Callable[[str | None, str | None], None] | None = None,
        history_seed: Callable[[str], str] | None = None,
    ):
        self._settings = settings
        # System prompt do chat (cada chat tem o seu; vazio = padrão do app)
        self._chat_prompt = (chat_prompt or "").strip()
        # Sessão do Claude Code deste chat (fica salva no banco, sobrevive a reinícios do app).
        # Ao continuar uma sessão (--resume), o Claude Code IGNORA um --system-prompt novo e mantém
        # o da sessão original; por isso a sessão é trocada quando o prompt muda (ver _session_args).
        self._session_id: str | None = session_id
        self._session_key: str | None = session_key
        self._on_session = on_session
        # Quando a sessão precisa recomeçar, as últimas mensagens do chat vão junto da pergunta
        self._history_seed = history_seed
        self._proc: subprocess.Popen | None = None

    def update_settings(self, settings: dict) -> None:
        self._settings = settings

    def set_chat_prompt(self, prompt: str) -> None:
        self._chat_prompt = (prompt or "").strip()

    @property
    def chat_prompt(self) -> str:
        """Instruções próprias do chat (ex.: "especialista no remake"): vão também para a busca de imagens."""
        return self._chat_prompt

    def _base_prompt(self) -> str:
        return self._chat_prompt or self.DEFAULT_SYSTEM_PROMPT

    def _session_args(self) -> tuple[list[str], bool]:
        """(args, nova) - --resume na sessão do chat, ou --session-id de uma nova quando:
        - é a primeira pergunta do chat;
        - o system prompt (ou a busca de mídia) mudou desde que a sessão começou;
        - o arquivo da sessão sumiu (limpeza automática do Claude Code)."""
        key = hashlib.sha256(
            f"v{PROMPT_VERSION}|{self._base_prompt()}|{self._settings.get('media_enabled', True)}|"
            f"{self._settings.get('media_proactive', True)}|{self._web_enabled()}|False".encode("utf-8")
        ).hexdigest()
        if self._session_id is not None and self._session_key == key and _session_exists(self._session_id):
            return ["--resume", self._session_id], False
        if self._session_id is not None and self._session_key != key:
            print("[brain] system prompt mudou → nova sessão com o histórico recente do chat", flush=True)
        self._session_id = str(uuid.uuid4())
        self._session_key = key
        if self._on_session:
            self._on_session(self._session_id, self._session_key)
        return ["--session-id", self._session_id], True

    def reset_session(self) -> None:
        """Próxima pergunta começa uma conversa nova."""
        self._session_id = None
        self._session_key = None
        if self._on_session:
            self._on_session(None, None)

    def _system_prompt(self) -> str:
        now = datetime.now().strftime("%A, %d de %B de %Y, %H:%M")
        base = self._base_prompt()
        media = ""
        if self._settings.get("media_enabled", True):
            proactive = self._settings.get("media_proactive", True)
            media = self.MEDIA_INSTRUCTIONS + (self.MEDIA_PROACTIVE if proactive else self.MEDIA_ON_REQUEST_ONLY)
        style = (
            " Nunca use travessão (o traço longo); quando precisar separar ideias, "
            "use vírgula, ponto ou o hífen simples (-)."
        )
        web = self.WEB_INSTRUCTIONS if self._web_enabled() else self.WEB_OFF
        return f"{base} Data e hora atuais: {now}.{style}{self.FORMAT_INSTRUCTIONS}{web}{media}"

    def _web_enabled(self) -> bool:
        return bool(self._settings.get("web_search", True))

    def _tool_args(self) -> list[str]:
        """Sem isto o `claude -p` recusa a pesquisa (não há ninguém para aprovar a permissão).
        Vale só para as chamadas do app: não mexe nas configurações do Claude Code da máquina."""
        # --tools limita as ferramentas que o Claude enxerga: sem isso ele também tentava usar terminal,
        # arquivos etc. (bloqueados), perdendo vários segundos antes de responder
        web = self._web_enabled()
        args = ["--tools", self.WEB_TOOLS if web else ""]
        if web:
            args += ["--allowedTools", self.WEB_TOOLS]
        # sem servidores MCP da máquina: mais rápido
        return args + ["--strict-mcp-config"]

    def _model_choice(self) -> str:
        m = str(self._settings.get("claude_model") or "")
        return m if m in CLAUDE_MODELS else DEFAULT_CLAUDE_MODEL

    def _model_args(self) -> list[str]:
        """Modelo escolhido no app: vale só para esta chamada (não mexe nas configurações do Claude Code)."""
        return ["--model", self._model_choice()]

    def _with_history(self, question: str, new_session: bool) -> str:
        if not new_session or not self._history_seed:
            return question
        try:
            seed = self._history_seed(question)
        except Exception as e:
            print(f"[brain] erro ao montar histórico: {e}", flush=True)
            seed = ""
        return seed + question if seed else question

    def ask(self, question: str) -> str:
        args, new_session = self._session_args()
        question = self._with_history(question, new_session)
        cmd = [_CLAUDE_BIN, "-p", *self._model_args(), "--system-prompt", self._system_prompt(), *self._tool_args(), *args]
        print(f"[brain] CMD: {cmd[0]} -p --system-prompt ... {' '.join(cmd[-2:])}", flush=True)
        try:
            self._proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                cwd=_claude_cwd(),
                env=_claude_env(),
            )
            print(f"[brain] PID={self._proc.pid} iniciado", flush=True)
            stdout, stderr = self._proc.communicate(input=question, timeout=60)
            rc = self._proc.returncode
            self._proc = None
            print(f"[brain] RC={rc} stderr={stderr.strip()[:200]!r}", flush=True)
            if rc not in (0, -9):
                return "Desculpe, ocorreu um erro ao consultar o Claude."
            return stdout.strip() or ""
        except subprocess.TimeoutExpired:
            self.cancel()
            return "A consulta demorou demais. Tente novamente."
        except FileNotFoundError:
            return "Erro: comando 'claude' não encontrado."
        except Exception as e:
            return f"Erro inesperado: {e}"

    def ask_stream(
        self,
        question: str,
        on_media: MediaCallback | None = None,
        on_tool: Callable[[str, str], None] | None = None,
        attachments: list[dict] | None = None,
    ) -> Generator[str, None, None]:
        """Yield o texto (markdown) conforme o Claude vai gerando, pedaço a pedaço.
        O corte em frases para a voz fica com ``ReplyComposer`` (services/reply_stream.py).

        Marcadores de mídia ([[IMAGENS: ...]] / [[VIDEOS: ...]]) disparam a busca via
        ``on_media(kind, query, n)`` e viram a linha ``[[media:id]]`` no lugar onde estavam.
        """
        media_filter = MediaMarkerFilter(on_media)
        effort = self._settings.get("effort", "low")
        session_args, new_session = self._session_args()
        question = self._with_history(question, new_session)
        stdin_text = question
        input_args: list[str] = []
        if attachments:
            # com anexos a pergunta vai como mensagem estruturada: imagens em blocos próprios e arquivos de
            # texto dentro do texto (a sessão e o histórico da conversa continuam os mesmos)
            body = question
            blocks: list[dict] = []
            for a in attachments:
                if a["kind"] == "image":
                    blocks.append({"type": "image", "source": {"type": "base64", "media_type": a["mime"], "data": a["b64"]}})
                else:
                    body += f"\n\n[Arquivo anexado: {a['name']}]\n```\n{a['text']}\n```"
            stdin_text = _json.dumps({"type": "user", "message": {"role": "user", "content": [
                {"type": "text", "text": body}, *blocks]}}) + "\n"
            input_args = ["--input-format", "stream-json"]
        cmd = [
            _CLAUDE_BIN, "-p", "--verbose",
            *input_args,
            "--output-format", "stream-json",
            "--include-partial-messages",
            "--effort", effort,
            *self._model_args(),
            *self._tool_args(),
            "--system-prompt", self._system_prompt(),
            *session_args,
        ]
        print(f"[brain] STREAM(json+partial) effort={effort} {' '.join(cmd[-2:])}", flush=True)
        t0 = time.perf_counter()
        try:
            self._proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                errors="replace",
                cwd=_claude_cwd(),
                env=_claude_env(),
            )
            print(f"[brain] PID={self._proc.pid} | iniciado em {time.perf_counter()-t0:.2f}s", flush=True)
            self._proc.stdin.write(stdin_text)
            self._proc.stdin.close()

            first_content = True
            new_block = False
            got_streaming = False
            got_text = False
            n = 0

            for line in self._proc.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = _json.loads(line)
                except _json.JSONDecodeError:
                    continue

                text = ""
                t = obj.get("type", "")
                if t == "rate_limit_event":
                    # % usada da sessão (5 h) e do limite semanal do plano: a tela mostra
                    claude_usage.record(obj.get("rate_limit_info") or {})
                    continue
                if t == "system" and obj.get("subtype") == "init" and obj.get("model"):
                    resolved_models[self._model_choice()] = str(obj["model"])
                if t == "stream_event":
                    # --include-partial-messages embrulha os eventos da API em {"type":"stream_event","event":{...}}
                    obj = obj.get("event") or {}
                    t = obj.get("type", "")
                if t == "assistant" and on_tool:
                    # ferramenta usada (ex.: pesquisa na internet): avisa a UI na hora, com o termo pesquisado
                    for block in obj.get("message", {}).get("content", []):
                        if block.get("type") == "tool_use":
                            inp = block.get("input") or {}
                            detail = str(inp.get("query") or inp.get("url") or "")
                            print(f"[brain] ⏱ ferramenta {block.get('name')}: {detail[:80]!r} "
                                  f"({time.perf_counter()-t0:.2f}s)", flush=True)
                            try:
                                on_tool(str(block.get("name") or ""), detail)
                            except Exception as e:
                                print(f"[brain] on_tool error: {e}", flush=True)
                if t == "content_block_start" and (obj.get("content_block") or {}).get("type") == "text" \
                        and got_streaming:
                    # texto novo depois de uma ferramenta (ex.: busca de imagens): é outro parágrafo
                    new_block = True
                if t == "content_block_delta":
                    d = obj.get("delta", {})
                    if d.get("type") == "text_delta":
                        text = d.get("text", "")
                        if text:
                            got_streaming = True
                            if new_block:
                                text = "\n\n" + text
                                new_block = False
                elif t == "assistant" and not got_streaming:
                    for block in obj.get("message", {}).get("content", []):
                        if block.get("type") == "text":
                            text += block.get("text", "")
                elif t == "result" and not got_text:
                    if not obj.get("is_error"):
                        text = obj.get("result", "")
                    else:
                        detail = str(obj.get("result") or "")
                        print(f"[brain] erro do Claude: {detail[:300]!r}", flush=True)
                        text = _friendly_error(detail)

                if not text:
                    continue
                got_text = True

                text = media_filter.feed(text)
                if not text:
                    continue

                if first_content:
                    print(f"[brain] ⏱ primeiro token: {time.perf_counter()-t0:.2f}s", flush=True)
                    first_content = False
                n += len(text)
                yield text

            rest = media_filter.flush()
            if rest:
                yield rest

            if self._proc:
                self._proc.wait(timeout=10)
            print(f"[brain] ⏱ Claude finalizado: {time.perf_counter()-t0:.2f}s | {n} caracteres", flush=True)
        except FileNotFoundError:
            print(f"[brain] claude não encontrado: {_CLAUDE_BIN}", flush=True)
            yield (
                "Não encontrei o Claude Code neste computador. "
                "Reinstale o Voice AI ou instale o Claude Code para usar o chat."
            )
        except Exception as e:
            print(f"[brain] stream error: {e}", flush=True)
        finally:
            self._proc = None

    def cancel(self) -> None:
        if self._proc and self._proc.poll() is None:
            try:
                self._proc.kill()
            except OSError:
                pass
        self._proc = None
