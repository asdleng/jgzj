#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
LOG_DIR="$ROOT_DIR/.logs"
RUN_DIR="$ROOT_DIR/.run"
TMUX_SESSION_NAME="${TMUX_SESSION_NAME:-jgzj-site}"

NODE_VERSION="${NODE_VERSION:-v20.20.1}"
NODE_DIST="node-${NODE_VERSION}-linux-x64"
NODE_HOME="$RUNTIME_DIR/$NODE_DIST"
NODE_BIN="$NODE_HOME/bin/node"
NPM_BIN="$NODE_HOME/bin/npm"

PORT="${PORT:-8888}"
UPSTREAM_CHAT_BASE_URL="${UPSTREAM_CHAT_BASE_URL:-http://127.0.0.1:8050}"
CHAT_PROXY_TIMEOUT_MS="${CHAT_PROXY_TIMEOUT_MS:-120000}"
UPSTREAM_CHAT_STREAM_PATH="${UPSTREAM_CHAT_STREAM_PATH:-/chat/stream}"
UPSTREAM_CHAT_HEALTH_PATH="${UPSTREAM_CHAT_HEALTH_PATH:-/healthz}"

LOG_FILE="$LOG_DIR/web-backend.log"
ARCHIVE_FILE="$RUNTIME_DIR/${NODE_DIST}.tar.xz"
NODE_DOWNLOAD_URL="https://nodejs.org/dist/${NODE_VERSION}/${NODE_DIST}.tar.xz"

mkdir -p "$RUNTIME_DIR" "$LOG_DIR" "$RUN_DIR"

if tmux has-session -t "$TMUX_SESSION_NAME" 2>/dev/null; then
  echo "existing web backend session found, restarting: $TMUX_SESSION_NAME"
  tmux kill-session -t "$TMUX_SESSION_NAME" 2>/dev/null || true
  sleep 1
fi

if [[ ! -x "$NODE_BIN" ]]; then
  echo "downloading Node ${NODE_VERSION} runtime..."
  curl -fsSL "$NODE_DOWNLOAD_URL" -o "$ARCHIVE_FILE"
  tar -xJf "$ARCHIVE_FILE" -C "$RUNTIME_DIR"
fi

export PATH="$NODE_HOME/bin:$PATH"

echo "installing frontend dependencies..."
"$NPM_BIN" ci

echo "installing backend dependencies..."
"$NPM_BIN" ci --prefix backend

echo "building frontend..."
"$NPM_BIN" run build

echo "starting backend on port $PORT..."
START_CMD=$(cat <<EOF
cd "$ROOT_DIR" && env \
PATH="$NODE_HOME/bin:$PATH" \
PORT="$PORT" \
UPSTREAM_CHAT_BASE_URL="$UPSTREAM_CHAT_BASE_URL" \
UPSTREAM_CHAT_STREAM_PATH="$UPSTREAM_CHAT_STREAM_PATH" \
UPSTREAM_CHAT_HEALTH_PATH="$UPSTREAM_CHAT_HEALTH_PATH" \
CHAT_PROXY_TIMEOUT_MS="$CHAT_PROXY_TIMEOUT_MS" \
"$NODE_BIN" "$ROOT_DIR/backend/server.js" >>"$LOG_FILE" 2>&1
EOF
)

tmux new-session -d -s "$TMUX_SESSION_NAME" "$START_CMD"

sleep 2

if ! curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  echo "backend failed to start; recent logs:"
  tail -n 80 "$LOG_FILE" || true
  tmux kill-session -t "$TMUX_SESSION_NAME" 2>/dev/null || true
  exit 1
fi

echo "backend started in tmux session: $TMUX_SESSION_NAME"
echo "log file: $LOG_FILE"
echo "health: http://127.0.0.1:$PORT/healthz"
