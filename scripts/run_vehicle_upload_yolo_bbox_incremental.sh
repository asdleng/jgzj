#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK_FILE="${ROOT_DIR}/.runtime/yolo_label_review/vehicle_upload_yolo_bbox.lock"
LOG_FILE="${ROOT_DIR}/.runtime/yolo_label_review/vehicle_upload_yolo_bbox.incremental.log"
MAX_NEW="${MAX_NEW:-0}"
MODEL_WORKERS="${MODEL_WORKERS:-3}"
TASKS="${TASKS:-}"

mkdir -p "$(dirname "${LOCK_FILE}")"

{
  flock -n 9 || {
    echo "[$(date '+%F %T')] skip: lock busy"
    exit 0
  }

  echo "[$(date '+%F %T')] start vehicle_upload_yolo_bbox max_new=${MAX_NEW} workers=${MODEL_WORKERS} tasks=${TASKS:-all}"
  if ! curl -fsS --max-time 5 http://127.0.0.1:18087/health >/dev/null; then
    echo "[$(date '+%F %T')] skip: yolo inference service unavailable"
    exit 0
  fi

  args=(
    python3 scripts/patrol_yolo_auto_label.py
    --source auto_ad_patrol_flow_upload
    --model-workers "${MODEL_WORKERS}"
    --timeout-s 120
  )
  if [[ "${MAX_NEW}" != "0" ]]; then
    args+=(--limit "${MAX_NEW}")
  fi
  if [[ -n "${TASKS}" ]]; then
    args+=(--tasks "${TASKS}")
  fi

  cd "${ROOT_DIR}"
  nice -n 10 ionice -c2 -n7 "${args[@]}"
  echo "[$(date '+%F %T')] done vehicle_upload_yolo_bbox"
} 9>"${LOCK_FILE}" >>"${LOG_FILE}" 2>&1
