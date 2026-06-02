#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="jgzj-site.service"
PORT="${PORT:-8888}"
TMUX_SESSION_NAME="${TMUX_SESSION_NAME:-jgzj-site}"

"$ROOT_DIR/scripts/build-site.sh"
"$ROOT_DIR/scripts/install-site-systemd.sh"

if tmux has-session -t "$TMUX_SESSION_NAME" 2>/dev/null; then
  echo "stopping legacy tmux session: $TMUX_SESSION_NAME"
  tmux kill-session -t "$TMUX_SESSION_NAME" 2>/dev/null || true
  sleep 1
fi

echo "restarting $SERVICE_NAME..."
sudo systemctl restart "$SERVICE_NAME"

sleep 2

if ! curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  echo "backend failed to start; recent journal:"
  sudo journalctl -u "$SERVICE_NAME" -n 120 --no-pager || true
  exit 1
fi

echo "backend managed by systemd service: $SERVICE_NAME"
echo "logs: journalctl -u $SERVICE_NAME -f"
echo "health: http://127.0.0.1:$PORT/healthz"
