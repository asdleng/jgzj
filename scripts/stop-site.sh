#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="${SERVICE_NAME:-jgzj-site.service}"
TMUX_SESSION_NAME="${TMUX_SESSION_NAME:-jgzj-site}"
STOPPED=0

if systemctl list-unit-files "$SERVICE_NAME" --no-legend 2>/dev/null | grep -q "^$SERVICE_NAME\\b"; then
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    sudo systemctl stop "$SERVICE_NAME"
    echo "stopped systemd service=$SERVICE_NAME"
    STOPPED=1
  fi
fi

if tmux has-session -t "$TMUX_SESSION_NAME" 2>/dev/null; then
  tmux kill-session -t "$TMUX_SESSION_NAME"
  echo "stopped legacy web backend tmux session=$TMUX_SESSION_NAME"
  STOPPED=1
fi

if [[ "$STOPPED" -eq 0 ]]; then
  echo "web backend is not running"
fi
