import json as _json
import os
import re
import shutil
import subprocess
import time
from collections.abc import Generator
from datetime import datetime
from pathlib import Path

_MD_RE = re.compile(r"\*{1,3}([^*]+)\*{1,3}|_{1,3}([^_]+)_{1,3}|#{1,6}\s?|`{1,3}")


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
        "Você é um assistente de voz rodando no Linux do usuário. "
        "Responda sempre em português do Brasil, adequado para ser lido em voz alta. "
        "Para perguntas simples e diretas: responda em no máximo 80 palavras. "
        "Para pedidos de resumo, análise, história ou explicação detalhada: responda de forma completa e sem limite de palavras. "
        "Nunca use markdown, listas com hífens ou asteriscos, símbolos especiais ou emojis — apenas texto corrido em parágrafos. "
        "Tom informal e direto, como um amigo brasileiro conversando."
    )

    def __init__(self, settings: dict):
        self._settings = settings
        self._first_call = True
        self._proc: subprocess.Popen | None = None

    def update_settings(self, settings: dict) -> None:
        self._settings = settings

    def _system_prompt(self) -> str:
        now = datetime.now().strftime("%A, %d de %B de %Y, %H:%M")
        base = self._settings.get("system_prompt") or self.DEFAULT_SYSTEM_PROMPT
        return f"{base} Data e hora atuais: {now}."

    def ask(self, question: str) -> str:
        cmd = [_CLAUDE_BIN, "-p", "--system-prompt", self._system_prompt()]
        if self._settings.get("claude_continue", True) and not self._first_call:
            cmd.append("-c")
        self._first_call = False
        print(f"[brain] CMD: {cmd[0]} -p --system-prompt ... {'-c' if '-c' in cmd else ''}", flush=True)
        try:
            self._proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                cwd=str(Path.home() / ".local/share/voice-ai"),
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

    def ask_stream(self, question: str) -> Generator[str, None, None]:
        """Yield frases completas conforme o Claude vai gerando a resposta."""
        effort = self._settings.get("effort", "low")
        cmd = [
            _CLAUDE_BIN, "-p", "--verbose",
            "--output-format", "stream-json",
            "--include-partial-messages",
            "--effort", effort,
            "--system-prompt", self._system_prompt(),
        ]
        if self._settings.get("claude_continue", True) and not self._first_call:
            cmd.append("-c")
        self._first_call = False
        print(f"[brain] STREAM(json+partial) effort={effort} {'-c' if '-c' in cmd else ''}", flush=True)
        t0 = time.perf_counter()
        try:
            self._proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                cwd=str(Path.home() / ".local/share/voice-ai"),
            )
            print(f"[brain] PID={self._proc.pid} | iniciado em {time.perf_counter()-t0:.2f}s", flush=True)
            self._proc.stdin.write(question)
            self._proc.stdin.close()

            buf = ""
            first_content = True
            got_streaming = False
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
                if t == "content_block_delta":
                    d = obj.get("delta", {})
                    if d.get("type") == "text_delta":
                        text = d.get("text", "")
                        if text:
                            got_streaming = True
                elif t == "assistant" and not got_streaming:
                    for block in obj.get("message", {}).get("content", []):
                        if block.get("type") == "text":
                            text += block.get("text", "")
                elif t == "result" and not got_streaming and not buf:
                    if not obj.get("is_error"):
                        text = obj.get("result", "")

                if not text:
                    continue

                text = _MD_RE.sub(lambda m: m.group(1) or m.group(2) or "", text)

                if first_content:
                    print(f"[brain] ⏱ primeiro token: {time.perf_counter()-t0:.2f}s", flush=True)
                    first_content = False

                buf += text
                while len(buf) >= 2:
                    boundary = -1
                    for i in range(len(buf) - 1):
                        if buf[i] in ".!?" and buf[i + 1] in " \n":
                            boundary = i + 2
                            break
                        if buf[i] == "," and len(buf[: i + 1].split()) >= 20:
                            boundary = i + 1
                            break
                    if boundary == -1:
                        break
                    sentence = buf[:boundary].strip()
                    buf = buf[boundary:]
                    if sentence and len(sentence.split()) >= 3:
                        n += 1
                        print(f"[brain] ⏱ frase#{n}: {time.perf_counter()-t0:.2f}s | {len(sentence.split())} palavras", flush=True)
                        yield sentence

            remaining = buf.strip()
            if remaining and len(remaining.split()) >= 2:
                n += 1
                print(f"[brain] ⏱ frase#{n} (fim): {time.perf_counter()-t0:.2f}s", flush=True)
                yield remaining

            if self._proc:
                self._proc.wait(timeout=10)
            print(f"[brain] ⏱ Claude finalizado: {time.perf_counter()-t0:.2f}s | {n} frases", flush=True)
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
