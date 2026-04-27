#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMUX_SESSION_NAME="${TMUX_SESSION_NAME:-jgzj-site}"

if ! tmux has-session -t "$TMUX_SESSION_NAME" 2>/dev/null; then
  echo "web backend is not running"
  exit 0
fi

tmux kill-session -t "$TMUX_SESSION_NAME"
echo "stopped web backend tmux session=$TMUX_SESSION_NAME"
