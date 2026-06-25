#!/usr/bin/env bash
set -euo pipefail

ROOT="${JZGJ_ROOT:-/home/admin1/jgzj}"
cd "$ROOT"

RUNTIME=".runtime/yolo_label_review"
mkdir -p "$RUNTIME"

LOCK="$RUNTIME/vehicle_upload_qwen_labels_v2.lock"
LOG="$RUNTIME/vehicle_upload_qwen_labels_v2.incremental.log"
SERVICE_URL="${QWEN_LABEL_SERVICE_URL:-http://127.0.0.1:18016}"
MAX_NEW="${VEHICLE_QWEN_LABEL_MAX_NEW:-300}"
WORKERS="${VEHICLE_QWEN_LABEL_WORKERS:-2}"
TIMEOUT_S="${VEHICLE_QWEN_LABEL_TIMEOUT_S:-120}"

timestamp() {
  date '+%Y-%m-%d %H:%M:%S'
}

{
  flock -n 9 || {
    echo "[$(timestamp)] skip:lock_busy"
    exit 0
  }

  if ! curl -fsS --max-time 3 "$SERVICE_URL/health" >/dev/null; then
    echo "[$(timestamp)] skip:label_service_unhealthy service=$SERVICE_URL"
    exit 0
  fi

  echo "[$(timestamp)] start vehicle_upload_qwen_incremental max_new=$MAX_NEW workers=$WORKERS"
  if command -v ionice >/dev/null 2>&1; then
    ionice -c2 -n7 nice -n 10 python3 scripts/patrol_qwen_label_vehicle_uploads.py \
      --service-url "$SERVICE_URL" \
      --only-missing \
      --limit "$MAX_NEW" \
      --workers "$WORKERS" \
      --timeout-s "$TIMEOUT_S"
  else
    nice -n 10 python3 scripts/patrol_qwen_label_vehicle_uploads.py \
      --service-url "$SERVICE_URL" \
      --only-missing \
      --limit "$MAX_NEW" \
      --workers "$WORKERS" \
      --timeout-s "$TIMEOUT_S"
  fi
  echo "[$(timestamp)] done vehicle_upload_qwen_incremental"
} 9>"$LOCK" >>"$LOG" 2>&1
