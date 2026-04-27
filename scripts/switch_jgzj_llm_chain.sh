#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-status}"

QWEN35_SERVICE="jgzj-chat-bridge-8050-qwen35.service"
QWEN36_SERVICE="jgzj-chat-bridge-8050-qwen36.service"
LEGACY_PATTERN="python3.10 .*intent_chat_tts_bridge.py --host 0.0.0.0 --port 8050 "

stop_legacy_8050() {
  local pids
  pids="$(pgrep -f "$LEGACY_PATTERN" || true)"
  if [[ -z "$pids" ]]; then
    return 0
  fi
  echo "[switch] stopping legacy 8050 bridge: $pids"
  # shellcheck disable=SC2086
  kill $pids || true
  sleep 1
  pids="$(pgrep -f "$LEGACY_PATTERN" || true)"
  if [[ -n "$pids" ]]; then
    # shellcheck disable=SC2086
    kill -9 $pids || true
  fi
}

stop_systemd_8050() {
  sudo systemctl stop "$QWEN35_SERVICE" "$QWEN36_SERVICE" >/dev/null 2>&1 || true
}

enable_target() {
  local target="$1"
  if [[ "$target" == "qwen35" ]]; then
    sudo systemctl disable "$QWEN36_SERVICE" >/dev/null 2>&1 || true
    sudo systemctl enable "$QWEN35_SERVICE" >/dev/null
  else
    sudo systemctl disable "$QWEN35_SERVICE" >/dev/null 2>&1 || true
    sudo systemctl enable "$QWEN36_SERVICE" >/dev/null
  fi
}

show_status() {
  echo "[systemd]"
  systemctl --no-pager --full status "$QWEN35_SERVICE" "$QWEN36_SERVICE" 2>/dev/null || true
  echo
  echo "[listeners]"
  ss -ltnp | rg ':8050\\b' || true
  echo
  echo "[health]"
  curl -fsS --max-time 5 http://127.0.0.1:8050/healthz || true
  echo
}

case "$TARGET" in
  qwen35)
    stop_legacy_8050
    stop_systemd_8050
    enable_target qwen35
    sudo systemctl start "$QWEN35_SERVICE"
    show_status
    ;;
  qwen36)
    curl -fsS --max-time 5 http://127.0.0.1:8024/healthz >/dev/null
    stop_legacy_8050
    stop_systemd_8050
    enable_target qwen36
    sudo systemctl start "$QWEN36_SERVICE"
    show_status
    ;;
  status)
    show_status
    ;;
  *)
    echo "Usage: $0 {qwen35|qwen36|status}" >&2
    exit 2
    ;;
esac
