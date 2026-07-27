#!/usr/bin/env bash
set -euo pipefail
cd /home/admin1/jgzj && python3 finetune/finetune_yolo_nohard.py --model fire_smoke_yolo --run-tag 20260727_155000_fire_smoke_full_review_full20 --epochs 20 --disable-early-stop --save-period 1 --train-backend local
