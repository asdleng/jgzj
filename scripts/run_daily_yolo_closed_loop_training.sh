#!/usr/bin/env bash
set -euo pipefail

ROOT="${JGZJ_ROOT:-/home/admin1/jgzj}"
cd "$ROOT"

RUNTIME=".runtime/yolo_daily_closed_loop"
mkdir -p "$RUNTIME"

LOCK="$RUNTIME/daily_yolo_closed_loop.lock"
LOG="$RUNTIME/daily_yolo_closed_loop.log"

# Cron can narrow this with YOLO_DAILY_TASKS. Default manual runs may cover
# person_yolo, vehicle_yolo, and pet_yolo.
export YOLO_DAILY_MAX_TASKS="${YOLO_DAILY_MAX_TASKS:-3}"

timestamp() {
  date '+%Y-%m-%d %H:%M:%S'
}

{
  flock -n 9 || {
    echo "[$(timestamp)] skip:lock_busy"
    exit 0
  }
  echo "[$(timestamp)] start daily_yolo_closed_loop args=$*"
  /usr/bin/python3 scripts/daily_yolo_closed_loop_training.py "$@"
  echo "[$(timestamp)] done daily_yolo_closed_loop"
} 9>"$LOCK" >>"$LOG" 2>&1
