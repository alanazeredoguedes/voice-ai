#!/usr/bin/env bash
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "[dev] iniciando backend..."
cd "$ROOT"
backend/venv/bin/python -m backend.main &
BACKEND_PID=$!

echo "[dev] aguardando backend em :18450..."
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:18450/health >/dev/null 2>&1; then
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
