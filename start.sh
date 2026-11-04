#!/usr/bin/env bash
# Inicializa o Voice AI (Electron + backend Python)
# O Electron já sobe o backend automaticamente via main/index.ts

LOG="$HOME/.local/share/voice-ai/startup.log"
mkdir -p "$(dirname "$LOG")"

export NVM_DIR="$HOME/.nvm"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

cd "$(dirname "$0")/frontend"
exec npm run dev >> "$LOG" 2>&1
