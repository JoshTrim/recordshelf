#!/bin/sh
set -eu

cd "$(dirname "$0")"

if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

web_pid=""
if ! lsof -nP -iTCP:3002 -sTCP:LISTEN >/dev/null 2>&1; then
  python3 -m http.server 3002 --bind 0.0.0.0 &
  web_pid=$!
fi

cleanup() {
  if [ -n "$web_pid" ]; then
    kill "$web_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

.venv-vision/bin/python vision_service.py
