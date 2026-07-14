#!/usr/bin/env bash
set -euo pipefail

ROOT="${JGZJ_ROOT:-/home/admin1/jgzj}"
cd "$ROOT"

RUNTIME=".runtime/yolo_event_feedback"
mkdir -p "$RUNTIME"

LOCK="$RUNTIME/sync.lock"
LOG="$RUNTIME/sync.log"
DAYS="${YOLO_EVENT_FEEDBACK_DAYS:-30}"
PERMANENT_ROOT="${QWEN_PERMANENT_YES_ROOT:-/home/admin1/qwen-vl-infer/data/qwen_ws_checker_archive/permanent_yes_frames}"
LABEL_ROOT="${QWEN_PERMANENT_YES_LABEL_OUTPUT_ROOT:-$ROOT/.runtime/yolo_label_review/qwen_permanent_yes_bbox_labels_v1}"
AUDIT_ROOT="${QWEN_PERMANENT_YES_AUDIT_OUTPUT_ROOT:-$ROOT/.runtime/yolo_label_review/qwen_permanent_yes_bbox_audits_v1}"
OUTPUT_ROOT="${YOLO_EVENT_FEEDBACK_OUTPUT_ROOT:-$ROOT/.runtime/yolo_loop/datasets/yolo_event_feedback_v1}"
SITE_INTERNAL_URL="${SITE_INTERNAL_URL:-http://127.0.0.1:8888}"
TOKEN_FILE="$ROOT/.runtime/yolo_label_review/internal_rebuild_token"
REFRESH_PATROL_INDEX="${YOLO_EVENT_FEEDBACK_REFRESH_PATROL_INDEX:-0}"

timestamp() {
  date '+%Y-%m-%d %H:%M:%S'
}

{
  flock -n 9 || {
    echo "[$(timestamp)] skip:lock_busy"
    exit 0
  }

  echo "[$(timestamp)] start yolo_event_feedback_sync days=$DAYS"
  ionice -c2 -n7 nice -n 10 python3 scripts/build_yolo_event_feedback_dataset.py \
    --permanent-root "$PERMANENT_ROOT" \
    --label-root "$LABEL_ROOT" \
    --audit-root "$AUDIT_ROOT" \
    --output-root "$OUTPUT_ROOT" \
    --days "$DAYS"

  if [ "$REFRESH_PATROL_INDEX" = "1" ]; then
    TOKEN=""
    if [ -r "$TOKEN_FILE" ]; then
      TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"
    fi
    CURL_ARGS=(-fsS --max-time 180 -X POST)
    if [ -n "$TOKEN" ]; then
      CURL_ARGS+=(-H "x-internal-token: $TOKEN")
    fi
    if curl "${CURL_ARGS[@]}" "$SITE_INTERNAL_URL/api/internal/yolo-label-review/rebuild-patrol-index" >/dev/null; then
      echo "[$(timestamp)] done patrol_index_refresh"
    else
      echo "[$(timestamp)] warn:patrol_index_refresh_failed site=$SITE_INTERNAL_URL"
    fi
  fi
  echo "[$(timestamp)] done yolo_event_feedback_sync"
} 9>"$LOCK" >>"$LOG" 2>&1
