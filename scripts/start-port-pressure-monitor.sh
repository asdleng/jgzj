#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/port_pressure_monitor.py"
LOG_DIR="$ROOT_DIR/.logs"
MONITOR_DIR="${MONITOR_DIR:-$ROOT_DIR/.monitor/port-pressure}"
LOG_FILE="$LOG_DIR/port-pressure-monitor.log"
TMUX_SESSION_NAME="${TMUX_SESSION_NAME:-jgzj-port-monitor}"
PYTHON_BIN="${PYTHON_BIN:-/home/admin1/miniconda3/bin/python3}"
INTERVAL="${INTERVAL:-5}"
PLOT_EVERY="${PLOT_EVERY:-6}"
TIMEOUT="${TIMEOUT:-3}"

mkdir -p "$LOG_DIR" "$MONITOR_DIR"

if tmux has-session -t "$TMUX_SESSION_NAME" 2>/dev/null; then
  echo "existing port pressure monitor session found, restarting: $TMUX_SESSION_NAME"
  tmux kill-session -t "$TMUX_SESSION_NAME" 2>/dev/null || true
  sleep 1
fi

START_CMD=$(cat <<EOF
cd "$ROOT_DIR" && "$PYTHON_BIN" "$SCRIPT_PATH" \
  --output-dir "$MONITOR_DIR" \
  --interval "$INTERVAL" \
  --plot-every "$PLOT_EVERY" \
  --timeout "$TIMEOUT" >>"$LOG_FILE" 2>&1
EOF
)

tmux new-session -d -s "$TMUX_SESSION_NAME" "$START_CMD"
sleep 2

if ! tmux has-session -t "$TMUX_SESSION_NAME" 2>/dev/null; then
  echo "failed to start port pressure monitor"
  exit 1
fi

echo "port pressure monitor started in tmux session: $TMUX_SESSION_NAME"
echo "log file: $LOG_FILE"
echo "output dir: $MONITOR_DIR"
