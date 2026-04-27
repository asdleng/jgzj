#!/usr/bin/env bash

set -euo pipefail

FRP_DIR="${FRP_DIR:-/home/admin1/frp/frp_0.65.0_linux_amd64}"
FRP_BIN="${FRP_BIN:-$FRP_DIR/frpc}"
FRP_CONFIG="${FRP_CONFIG:-$FRP_DIR/frpc.toml}"
FRP_LOG="${FRP_LOG:-$FRP_DIR/frpc.log}"

if [[ ! -x "$FRP_BIN" ]]; then
  echo "frpc binary not found: $FRP_BIN" >&2
  exit 1
fi

if [[ ! -f "$FRP_CONFIG" ]]; then
  echo "frpc config not found: $FRP_CONFIG" >&2
  exit 1
fi

existing_pids="$(pgrep -f "$FRP_CONFIG" || true)"
if [[ -n "$existing_pids" ]]; then
  echo "[frpc] stopping existing processes: $existing_pids"
  # shellcheck disable=SC2086
  kill $existing_pids || true
  sleep 1
  existing_pids="$(pgrep -f "$FRP_CONFIG" || true)"
  if [[ -n "$existing_pids" ]]; then
    # shellcheck disable=SC2086
    kill -9 $existing_pids || true
  fi
fi

mkdir -p "$(dirname "$FRP_LOG")"

nohup bash -lc "
  cd '$FRP_DIR' && env \
    -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY \
    -u ALL_PROXY -u all_proxy -u ftp_proxy -u FTP_PROXY \
    -u socks_proxy -u SOCKS_PROXY \
    NO_PROXY='localhost,127.0.0.1,idtrd.kmdns.net,.kmdns.net' \
    no_proxy='localhost,127.0.0.1,idtrd.kmdns.net,.kmdns.net' \
    '$FRP_BIN' -c '$FRP_CONFIG' >> '$FRP_LOG' 2>&1
" >/dev/null 2>&1 &

sleep 2

new_pids="$(pgrep -f "$FRP_CONFIG" || true)"
if [[ -z "$new_pids" ]]; then
  echo "frpc failed to start" >&2
  tail -n 80 "$FRP_LOG" || true
  exit 1
fi

echo "[frpc] started: $new_pids"
