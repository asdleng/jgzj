#!/usr/bin/env bash

set -euo pipefail

TMUX_SESSION_NAME="${TMUX_SESSION_NAME:-jgzj-port-monitor}"

if ! tmux has-session -t "$TMUX_SESSION_NAME" 2>/dev/null; then
  echo "port pressure monitor is not running"
  exit 0
fi

tmux kill-session -t "$TMUX_SESSION_NAME"
echo "stopped port pressure monitor tmux session=$TMUX_SESSION_NAME"
