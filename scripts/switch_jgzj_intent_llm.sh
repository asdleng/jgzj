#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-status}"

FAILOVER_SERVICE="jgzj-intent-v2-8022-failover.service"
ROLLBACK_SERVICE="jgzj-intent-v2-8022-qwen35.service"
LEGACY_PATTERN="python .*intent_v2_server.py --host 0.0.0.0 --port 8022 "

stop_legacy_8022() {
  local pids
  pids="$(pgrep -f "$LEGACY_PATTERN" || true)"
  if [[ -z "$pids" ]]; then
    return 0
  fi
  echo "[switch] stopping legacy 8022 intent: $pids"
  # shellcheck disable=SC2086
  kill $pids || true
  sleep 1
  pids="$(pgrep -f "$LEGACY_PATTERN" || true)"
  if [[ -n "$pids" ]]; then
    # shellcheck disable=SC2086
    kill -9 $pids || true
  fi
}

stop_systemd_8022() {
  sudo systemctl stop "$FAILOVER_SERVICE" "$ROLLBACK_SERVICE" >/dev/null 2>&1 || true
}

enable_target() {
  local target="$1"
  if [[ "$target" == "qwen35" ]]; then
    sudo systemctl disable "$FAILOVER_SERVICE" >/dev/null 2>&1 || true
    sudo systemctl enable "$ROLLBACK_SERVICE" >/dev/null
  else
    sudo systemctl disable "$ROLLBACK_SERVICE" >/dev/null 2>&1 || true
    sudo systemctl enable "$FAILOVER_SERVICE" >/dev/null
  fi
}

show_status() {
  echo "[systemd]"
  systemctl --no-pager --full status "$FAILOVER_SERVICE" "$ROLLBACK_SERVICE" 2>/dev/null || true
  echo
  echo "[listeners]"
  ss -ltnp | rg ':8022\\b|:8043\\b' || true
  echo
  echo "[health]"
  curl -fsS --max-time 5 http://127.0.0.1:8022/healthz || true
  echo
  curl -fsS --max-time 5 http://127.0.0.1:8043/health/detail || true
  echo
}

case "$TARGET" in
  failover)
    curl -fsS --max-time 5 http://127.0.0.1:8043/healthz >/dev/null
    stop_legacy_8022
    stop_systemd_8022
    enable_target failover
    sudo systemctl start "$FAILOVER_SERVICE"
    show_status
    ;;
  qwen35)
    curl -fsS --max-time 5 http://127.0.0.1:8041/healthz >/dev/null
    stop_legacy_8022
    stop_systemd_8022
    enable_target qwen35
    sudo systemctl start "$ROLLBACK_SERVICE"
    show_status
    ;;
  status)
    show_status
    ;;
  *)
    echo "Usage: $0 {failover|qwen35|status}" >&2
    exit 2
    ;;
esac
