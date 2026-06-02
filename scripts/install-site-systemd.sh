#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="jgzj-site.service"
SERVICE_SRC="$ROOT_DIR/deploy/systemd/$SERVICE_NAME"
SERVICE_DST="/etc/systemd/system/$SERVICE_NAME"
ENV_SRC="$ROOT_DIR/deploy/systemd/jgzj-site.env.example"
ENV_DST="$ROOT_DIR/.runtime/jgzj-site.env"

mkdir -p "$ROOT_DIR/.runtime" "$ROOT_DIR/.logs"

if [[ ! -f "$ENV_DST" ]]; then
  install -m 600 "$ENV_SRC" "$ENV_DST"
  echo "created env file: $ENV_DST"
else
  echo "env file exists: $ENV_DST"
fi

sudo install -m 0644 "$SERVICE_SRC" "$SERVICE_DST"
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME" >/dev/null

echo "installed systemd service: $SERVICE_NAME"
