#!/usr/bin/env bash
set -euo pipefail

ROOT="${JZGJ_ROOT:-/home/admin1/jgzj}"
cd "$ROOT"

RUNTIME=".runtime/yolo_label_review"
mkdir -p "$RUNTIME"

LOCK="$RUNTIME/vehicle_upload_qwen_bbox_labels_v1.lock"
LOG="$RUNTIME/vehicle_upload_qwen_bbox_labels_v1.incremental.log"
SERVICE_URL="${QWEN_LABEL_SERVICE_URL:-http://127.0.0.1:18016}"
SITE_INTERNAL_URL="${JZGJ_SITE_INTERNAL_URL:-http://127.0.0.1:8888}"
INTERNAL_TOKEN_FILE="$RUNTIME/internal_rebuild_token"
MAX_NEW="${VEHICLE_QWEN_LABEL_MAX_NEW:-120}"
WORKERS="${VEHICLE_QWEN_LABEL_WORKERS:-2}"
TIMEOUT_S="${VEHICLE_QWEN_LABEL_TIMEOUT_S:-120}"
MAX_TOKENS="${VEHICLE_QWEN_LABEL_MAX_TOKENS:-768}"

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

  echo "[$(timestamp)] start vehicle_upload_qwen_bbox_incremental max_new=$MAX_NEW workers=$WORKERS"
  if command -v ionice >/dev/null 2>&1; then
    ionice -c2 -n7 nice -n 10 python3 scripts/patrol_qwen_label_vehicle_uploads.py \
      --service-url "$SERVICE_URL" \
      --only-missing \
      --limit "$MAX_NEW" \
      --workers "$WORKERS" \
      --timeout-s "$TIMEOUT_S" \
      --max-tokens "$MAX_TOKENS"
  else
    nice -n 10 python3 scripts/patrol_qwen_label_vehicle_uploads.py \
      --service-url "$SERVICE_URL" \
      --only-missing \
      --limit "$MAX_NEW" \
      --workers "$WORKERS" \
      --timeout-s "$TIMEOUT_S" \
      --max-tokens "$MAX_TOKENS"
  fi
  echo "[$(timestamp)] done vehicle_upload_qwen_bbox_incremental"

  INTERNAL_TOKEN="${YOLO_LABEL_REVIEW_INTERNAL_TOKEN:-}"
  if [ -z "$INTERNAL_TOKEN" ] && [ -r "$INTERNAL_TOKEN_FILE" ]; then
    INTERNAL_TOKEN="$(tr -d '\r\n' < "$INTERNAL_TOKEN_FILE")"
  fi
  if curl -fsS --max-time 120 -X POST \
    ${INTERNAL_TOKEN:+-H "X-Internal-Token: $INTERNAL_TOKEN"} \
    "$SITE_INTERNAL_URL/api/internal/yolo-label-review/rebuild-patrol-index" >/dev/null; then
    echo "[$(timestamp)] done patrol_dataset_index_refresh site=$SITE_INTERNAL_URL"
  else
    echo "[$(timestamp)] warn:patrol_dataset_index_refresh_failed site=$SITE_INTERNAL_URL"
  fi
} 9>"$LOCK" >>"$LOG" 2>&1
