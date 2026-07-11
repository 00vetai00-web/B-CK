#!/usr/bin/env bash
# BÄCK launcher — run with:  bash start.sh
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node.js is not installed."
  echo "  On Android (Termux):   pkg update && pkg install nodejs -y"
  echo "  On desktop:            install Node.js from https://nodejs.org"
  echo ""
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "  First run — installing dependencies (needs internet)…"
  npm install || { echo "  npm install failed."; exit 1; }
fi

# Keep the phone awake while streaming (Termux only; harmless elsewhere)
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock

exec node server.js
