#!/usr/bin/env bash
# Gera o instalador do Linux: frontend/dist/Voice AI-<versao>.AppImage
set -e

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

ROOT="$(cd "$(dirname "$0")" && pwd)"
PY_DIST="$ROOT/backend/python-dist"

# Python portátil (python-build-standalone) embutido no app - mesma versão do build.ps1
PY_VERSION='3.12.16'
PY_RELEASE='20261026'
if [ ! -x "$PY_DIST/bin/python3" ]; then
  echo "[build] baixando Python $PY_VERSION portatil..."
  TMP="$(mktemp -d)"
  curl -fsSL -o "$TMP/python.tar.gz" \
    "https://github.com/astral-sh/python-build-standalone/releases/download/$PY_RELEASE/cpython-$PY_VERSION%2B$PY_RELEASE-x86_64-unknown-linux-gnu-install_only.tar.gz"
  tar -xzf "$TMP/python.tar.gz" -C "$TMP"
  rm -rf "$PY_DIST"
  mv "$TMP/python" "$PY_DIST"
  rm -rf "$TMP"
fi

cd "$ROOT/frontend"
npm run build:linux

rm -rf dist/linux-unpacked

echo ""
echo "Build concluido:"
ls -lh dist/*.AppImage
