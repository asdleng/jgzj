#!/usr/bin/env bash
set -euo pipefail

ROOT="${JGZJ_ROOT:-/home/admin1/jgzj}"
cd "$ROOT"

PROFILE="${FINETUNE_PROFILE:-${1:-}}"
if [ -z "$PROFILE" ]; then
  echo "FINETUNE_PROFILE is required" >&2
  exit 2
fi

RUNTIME="$ROOT/.runtime/yolo_event_feedback_finetune_daily"
mkdir -p "$RUNTIME/logs"

LOCK="$RUNTIME/${PROFILE}.lock"
LOG="$RUNTIME/logs/${PROFILE}.log"
DAY="${FINETUNE_DAY:-}"
DRY_RUN="${FINETUNE_DRY_RUN:-0}"
SOURCE="${YOLO_EVENT_FEEDBACK_OUTPUT_ROOT:-$ROOT/.runtime/yolo_loop/datasets/yolo_event_feedback_v1}"
DATASETS_ROOT="${YOLO_LOOP_DATASETS_ROOT:-$ROOT/.runtime/yolo_loop/datasets}"

timestamp() {
  date '+%Y-%m-%d %H:%M:%S'
}

ARGS=(--dataset "$PROFILE" --source "$SOURCE" --datasets-root "$DATASETS_ROOT")
if [ -n "$DAY" ]; then
  ARGS+=(--day "$DAY")
fi
if [ "$DRY_RUN" = "1" ]; then
  ARGS+=(--dry-run)
fi

{
  flock -n 9 || {
    echo "[$(timestamp)] skip:lock_busy profile=$PROFILE"
    exit 0
  }
  echo "[$(timestamp)] start yolo_event_feedback_finetune_daily profile=$PROFILE day=${DAY:-yesterday} dry_run=$DRY_RUN"
  ionice -c2 -n7 nice -n 10 python3 scripts/append_finetune_from_yolo_event_feedback_daily.py "${ARGS[@]}"
  echo "[$(timestamp)] done yolo_event_feedback_finetune_daily profile=$PROFILE"
} 9>"$LOCK" >>"$LOG" 2>&1
