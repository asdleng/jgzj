#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
START_SCRIPT="$ROOT_DIR/scripts/start-site.sh"
LOG_DIR="$ROOT_DIR/.logs"
QUEUE_LOG="$LOG_DIR/site-restart-launcher.log"

mkdir -p "$LOG_DIR"

if [[ ! -x "$START_SCRIPT" ]]; then
  echo "start script not executable: $START_SCRIPT" >&2
  exit 1
fi

nohup setsid bash -lc "
  sleep 1
  '$START_SCRIPT' >> '$QUEUE_LOG' 2>&1
" >/dev/null 2>&1 &

echo "site_restart_queued pid=$!"
