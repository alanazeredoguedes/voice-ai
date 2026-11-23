#!/usr/bin/env bash
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

# mantém as bibliotecas da venv em dia (só roda quando o requirements mudou)
REQ_HASH="$(cat "$ROOT/backend/requirements.txt" "$ROOT/backend/requirements-core.txt" | sha256sum | cut -c1-16)"
if [ "$(cat "$ROOT/backend/venv/.voice-ai-req-hash" 2>/dev/null)" != "$REQ_HASH" ]; then
  echo "[dev] requirements mudaram: atualizando as bibliotecas da venv..."
  (cd "$ROOT/backend" && ./venv/bin/python -m pip install -q --disable-pip-version-check -r requirements.txt) \
    && echo "$REQ_HASH" > "$ROOT/backend/venv/.voice-ai-req-hash" \
    || echo "[dev] AVISO: nao deu para atualizar as bibliotecas (busca de video/imagem pode falhar)"
fi

echo "[dev] iniciando backend..."
cd "$ROOT"
# porta própria do dev (o app instalado usa a 18450)
export VOICE_AI_PORT=18451
backend/venv/bin/python -m backend.main &
BACKEND_PID=$!

echo "[dev] aguardando backend em :18451..."
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:18451/health >/dev/null 2>&1; then
    echo "[dev] backend pronto"
    break
  fi
  sleep 0.5
done

echo "[dev] iniciando frontend..."
cd "$ROOT/frontend"
npm run dev &
FRONTEND_PID=$!

cleanup() {
  echo "[dev] encerrando..."
  kill $FRONTEND_PID 2>/dev/null || true
  kill $BACKEND_PID 2>/dev/null || true
}
trap cleanup EXIT INT TERM

wait $FRONTEND_PID
