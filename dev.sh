#!/usr/bin/env bash
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

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
