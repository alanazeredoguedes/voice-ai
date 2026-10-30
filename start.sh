#!/usr/bin/env bash
# Inicializa o Voice AI (Electron + backend Python)
# O Electron já sobe o backend automaticamente via main/index.ts

LOG="$HOME/.local/share/voice-ai/startup.log"
mkdir -p "$(dirname "$LOG")"

cd "$(dirname "$0")/frontend"
exec npm run dev >> "$LOG" 2>&1
