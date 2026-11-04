#!/usr/bin/env bash
set -e

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

cd "$(dirname "$0")/frontend"
npm run build:linux

rm -rf dist/linux-unpacked

echo ""
echo "Build concluido:"
ls -lh dist/*.AppImage
