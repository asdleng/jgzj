#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
LOG_DIR="$ROOT_DIR/.logs"

NODE_VERSION="${NODE_VERSION:-v20.20.1}"
NODE_DIST="node-${NODE_VERSION}-linux-x64"
NODE_HOME="$RUNTIME_DIR/$NODE_DIST"
NODE_BIN="$NODE_HOME/bin/node"
NPM_BIN="$NODE_HOME/bin/npm"
ARCHIVE_FILE="$RUNTIME_DIR/${NODE_DIST}.tar.xz"
NODE_DOWNLOAD_URL="https://nodejs.org/dist/${NODE_VERSION}/${NODE_DIST}.tar.xz"

mkdir -p "$RUNTIME_DIR" "$LOG_DIR"

if [[ ! -x "$NODE_BIN" ]]; then
  echo "downloading Node ${NODE_VERSION} runtime..."
  curl -fsSL "$NODE_DOWNLOAD_URL" -o "$ARCHIVE_FILE"
  tar -xJf "$ARCHIVE_FILE" -C "$RUNTIME_DIR"
fi

export PATH="$NODE_HOME/bin:$PATH"

echo "installing frontend dependencies..."
"$NPM_BIN" ci

echo "installing backend dependencies..."
"$NPM_BIN" ci --prefix "$ROOT_DIR/backend"

echo "building frontend..."
"$NPM_BIN" run build

echo "site build complete."
