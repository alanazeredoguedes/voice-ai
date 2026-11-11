"""Cria o system prompt de um chat a partir de uma descrição curta (falada ou digitada).

Uma chamada única ao Claude (Sonnet), sem sessão e sem ferramentas. O app já acrescenta sozinho, depois do prompt
do chat, as regras de formato, a data e hora, a pesquisa na internet e as imagens/vídeos: aqui só se escreve
quem a IA é e como ela deve ajudar naquele chat.
"""

import re
import threading

from .media_judge import ask_claude

MODEL = "sonnet"
_TIMEOUT_S = 120

_SYSTEM = (
    "Você escreve system prompts para um app de chat por voz com IA. O app já acrescenta sozinho, depois do seu "
    "prompt, as regras de formatação das respostas, a data e hora, a pesquisa na internet e a exibição de imagens e "
    "vídeos. Por isso o seu prompt trata SÓ de quem a IA é e de como ela deve ajudar neste chat. "
    "Escreva em português, em segunda pessoa ('Você é...'), de forma detalhada e prática, entre 150 e 400 palavras, "
    "em parágrafos curtos ou listas simples, sem títulos em markdown, sem emojis e sem travessões (use vírgula, "
    "ponto ou hífen simples). Cubra: "
    "(1) o papel e a especialidade exata; se o assunto tem versões, edições, plataformas ou temporadas, deixe "
    "EXPLÍCITA a versão certa, cite o nome oficial e avise para não confundir com as outras; "
    "(2) o contexto de uso que o usuário descreveu; "
    "(3) o tom: informal e direto, respostas curtas, porque são lidas em voz alta; "
    "(4) como tratar dúvidas (perguntar só quando for indispensável) e o que não sabe (dizer que não tem certeza em "
    "vez de inventar); "
    "(5) quando fizer sentido, o hábito de ilustrar a resposta com imagens e vídeos relevantes da versão certa, sem "
    "falar de buscas nem de links. "
    "Descreva o comportamento da IA, não invente fatos sobre o assunto. "
    "Responda SÓ com o texto do system prompt, sem introdução, sem explicações e sem aspas."
)


def _clean(text: str) -> str:
    t = (text or "").strip()
    t = re.sub(r"^```[a-zA-Z]*\n?|\n?```$", "", t).strip()
    t = t.strip("\"'").strip()
    return t.replace("—", "-").replace("–", "-")[:8000]


def generate(description: str, current: str = "", cancel: threading.Event | None = None) -> str | None:
    """Prompt novo (sem ``current``) ou o ``current`` ajustado conforme ``description``. None se falhar/cancelar."""
    description = (description or "").strip()[:2000]
    current = (current or "").strip()[:8000]
    if current:
        ask = (f"Prompt atual:\n{current}\n\nAjustes pedidos pelo usuário:\n{description}\n\n"
               "Escreva o prompt COMPLETO já com os ajustes, mantendo o que não foi pedido para mudar.")
    else:
        ask = f"O que o usuário quer para este chat:\n{description}"
    out = ask_claude(_SYSTEM, [{"type": "text", "text": ask}], cancel, model=MODEL, timeout=_TIMEOUT_S)
    return _clean(out) if out else None
