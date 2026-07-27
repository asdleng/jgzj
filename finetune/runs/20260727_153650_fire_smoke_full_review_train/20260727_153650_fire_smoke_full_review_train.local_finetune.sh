#!/usr/bin/env bash
set -euo pipefail
cd /home/admin1/jgzj
mkdir -p /home/admin1/jgzj/finetune/logs /home/admin1/jgzj/.runtime/finetune/local_runs/fire_smoke_yolo /home/admin1/jgzj/.runtime/finetune/local_results/fire_smoke_yolo_fire_smoke_full_review_20260727_153650_fire_smoke_full_review_train
echo "$(date -Is) finetune_start backend=local task=fire_smoke_yolo class=fire_smoke_full_review gpu=2 data=/home/admin1/jgzj/.runtime/finetune/datasets/20260727_153650_fire_smoke_full_review_train/fire_smoke_yolo_c0_1_fire_smoke_full_review_finetune/data.yaml" | tee -a /home/admin1/jgzj/finetune/logs/20260727_153650_fire_smoke_full_review_train_local_train.log
CUDA_VISIBLE_DEVICES=2 \
RELIABLE_YOLO_TASK=fire_smoke_yolo_fire_smoke_full_review_finetune \
RELIABLE_YOLO_RUN_TAG=20260727_153650_fire_smoke_full_review_train \
RELIABLE_YOLO_DATA=/home/admin1/jgzj/.runtime/finetune/datasets/20260727_153650_fire_smoke_full_review_train/fire_smoke_yolo_c0_1_fire_smoke_full_review_finetune/data.yaml \
RELIABLE_YOLO_OUT=/home/admin1/jgzj/.runtime/finetune/local_results/fire_smoke_yolo_fire_smoke_full_review_20260727_153650_fire_smoke_full_review_train \
RELIABLE_YOLO_PROJECT=/home/admin1/jgzj/.runtime/finetune/local_runs/fire_smoke_yolo \
RELIABLE_YOLO_DOWNLOADS=/home/admin1/jgzj/.runtime/yolo_model_service/downloads \
RELIABLE_YOLO_BASE_WEIGHTS=20260727_153650_fire_smoke_full_review_train_fire_smoke_yolo_fire_smoke_full_review=/home/admin1/jgzj/.runtime/yolo_model_service/weights/fire_smoke_yolo_nohard_round2_20260727_130839.pt \
RELIABLE_YOLO_EPOCHS=20 \
RELIABLE_YOLO_PATIENCE=6 \
RELIABLE_YOLO_BATCH=32 \
RELIABLE_YOLO_IMGSZ=640 \
RELIABLE_YOLO_WORKERS=8 \
/usr/bin/python3 /home/admin1/jgzj/.runtime/reliable_vehicle_yolo_20260704/train_reliable_yolo_finetune.py 2>&1 | tee -a /home/admin1/jgzj/finetune/logs/20260727_153650_fire_smoke_full_review_train_local_train.log
echo "$(date -Is) finetune_done backend=local task=fire_smoke_yolo class=fire_smoke_full_review" | tee -a /home/admin1/jgzj/finetune/logs/20260727_153650_fire_smoke_full_review_train_local_train.log
