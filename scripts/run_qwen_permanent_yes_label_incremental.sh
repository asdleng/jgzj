#!/usr/bin/env bash
set -euo pipefail

ROOT="${JZGJ_ROOT:-/home/admin1/jgzj}"
cd "$ROOT"

RUNTIME=".runtime/yolo_label_review"
mkdir -p "$RUNTIME"

LOCK="$RUNTIME/qwen_permanent_yes_bbox_labels_v1.lock"
LOG="$RUNTIME/qwen_permanent_yes_bbox_labels_v1.incremental.log"
SERVICE_URL="${QWEN_LABEL_SERVICE_URL:-http://127.0.0.1:18016}"
PERMANENT_ROOT="${QWEN_PERMANENT_YES_ROOT:-/home/admin1/qwen-vl-infer/data/qwen_ws_checker_archive/permanent_yes_frames}"
OUTPUT_ROOT="${QWEN_PERMANENT_YES_LABEL_OUTPUT_ROOT:-/home/admin1/jgzj/.runtime/yolo_label_review/qwen_permanent_yes_bbox_labels_v1}"
MAX_NEW="${QWEN_PERMANENT_YES_LABEL_MAX_NEW:-120}"
WORKERS="${QWEN_PERMANENT_YES_LABEL_WORKERS:-2}"
TIMEOUT_S="${QWEN_PERMANENT_YES_LABEL_TIMEOUT_S:-120}"
MAX_TOKENS="${QWEN_PERMANENT_YES_LABEL_MAX_TOKENS:-768}"
DAY_FILTER="${QWEN_PERMANENT_YES_DAY:-}"

timestamp() {
  date '+%Y-%m-%d %H:%M:%S'
}

{
  flock -n 9 || {
    echo "[$(timestamp)] skip:lock_busy"
    exit 0
  }

  if [ ! -d "$PERMANENT_ROOT" ]; then
    echo "[$(timestamp)] skip:permanent_root_missing root=$PERMANENT_ROOT"
    exit 0
  fi

  if ! curl -fsS --max-time 3 "$SERVICE_URL/health" >/dev/null; then
    echo "[$(timestamp)] skip:label_service_unhealthy service=$SERVICE_URL"
    exit 0
  fi

  DAY_ARGS=()
  if [ -n "$DAY_FILTER" ]; then
    DAY_ARGS=(--day "$DAY_FILTER")
  fi

  echo "[$(timestamp)] start qwen_permanent_yes_bbox_incremental max_new=$MAX_NEW workers=$WORKERS root=$PERMANENT_ROOT"
  if command -v ionice >/dev/null 2>&1; then
    ionice -c2 -n7 nice -n 10 python3 scripts/patrol_qwen_label_permanent_yes_frames.py \
      --permanent-root "$PERMANENT_ROOT" \
      --output-root "$OUTPUT_ROOT" \
      --service-url "$SERVICE_URL" \
      --only-missing \
      --limit "$MAX_NEW" \
      --workers "$WORKERS" \
      --timeout-s "$TIMEOUT_S" \
      --max-tokens "$MAX_TOKENS" \
      "${DAY_ARGS[@]}"
  else
    nice -n 10 python3 scripts/patrol_qwen_label_permanent_yes_frames.py \
      --permanent-root "$PERMANENT_ROOT" \
      --output-root "$OUTPUT_ROOT" \
      --service-url "$SERVICE_URL" \
      --only-missing \
      --limit "$MAX_NEW" \
      --workers "$WORKERS" \
      --timeout-s "$TIMEOUT_S" \
      --max-tokens "$MAX_TOKENS" \
      "${DAY_ARGS[@]}"
  fi
  echo "[$(timestamp)] done qwen_permanent_yes_bbox_incremental"
} 9>"$LOCK" >>"$LOG" 2>&1
