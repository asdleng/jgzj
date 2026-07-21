#!/usr/bin/env bash
set -euo pipefail
ROOT=/home/sari/jgzj_yolo_finetune
cd "$ROOT"
mkdir -p logs results runs scripts
python3 - <<'PY'
from pathlib import Path
p = Path('/home/sari/jgzj_yolo_finetune/datasets/20260721_170647_fire_smoke_yolo_c0_1_fire_smoke_joint_balanced_gpu3_retry/fire_smoke_yolo_c0_1_fire_smoke_finetune/data.yaml')
remote_dataset = '/home/sari/jgzj_yolo_finetune/datasets/20260721_170647_fire_smoke_yolo_c0_1_fire_smoke_joint_balanced_gpu3_retry/fire_smoke_yolo_c0_1_fire_smoke_finetune'
lines = p.read_text(encoding='utf-8').splitlines()
out = []
for line in lines:
    if line.startswith('path:'):
        out.append('path: ' + remote_dataset)
    else:
        out.append(line)
p.write_text('\n'.join(out) + '\n', encoding='utf-8')
PY
echo "$(date -Is) finetune_start task=fire_smoke_yolo class=fire_smoke data=/home/sari/jgzj_yolo_finetune/datasets/20260721_170647_fire_smoke_yolo_c0_1_fire_smoke_joint_balanced_gpu3_retry/fire_smoke_yolo_c0_1_fire_smoke_finetune/data.yaml" | tee -a /home/sari/jgzj_yolo_finetune/logs/fire_smoke_yolo_fire_smoke_20260721_170647_fire_smoke_yolo_c0_1_fire_smoke_joint_balanced_gpu3_retry.log
CUDA_VISIBLE_DEVICES=3 \
RELIABLE_YOLO_TASK=fire_smoke_yolo_fire_smoke_finetune \
RELIABLE_YOLO_RUN_TAG=20260721_170647_fire_smoke_yolo_c0_1_fire_smoke_joint_balanced_gpu3_retry \
RELIABLE_YOLO_DATA=/home/sari/jgzj_yolo_finetune/datasets/20260721_170647_fire_smoke_yolo_c0_1_fire_smoke_joint_balanced_gpu3_retry/fire_smoke_yolo_c0_1_fire_smoke_finetune/data.yaml \
RELIABLE_YOLO_OUT=/home/sari/jgzj_yolo_finetune/results/fire_smoke_yolo_fire_smoke_20260721_170647_fire_smoke_yolo_c0_1_fire_smoke_joint_balanced_gpu3_retry \
RELIABLE_YOLO_PROJECT=/home/sari/jgzj_yolo_finetune/runs/fire_smoke_yolo \
RELIABLE_YOLO_BASE_WEIGHTS=20260721_170647_fire_smoke_yolo_c0_1_fire_smoke_joint_balanced_gpu3_retry_fire_smoke_yolo_fire_smoke=/home/sari/jgzj_yolo_finetune/weights/20260721_170647_fire_smoke_yolo_c0_1_fire_smoke_joint_balanced_gpu3_retry_fire_smoke_yolo_fire_other_edge_full_continue3_gpu2_20260713.pt \
RELIABLE_YOLO_EPOCHS=8 \
RELIABLE_YOLO_PATIENCE=3 \
RELIABLE_YOLO_BATCH=32 \
RELIABLE_YOLO_IMGSZ=640 \
RELIABLE_YOLO_WORKERS=8 \
/home/sari/autodistill/bin/python scripts/train_reliable_yolo_finetune.py 2>&1 | tee -a /home/sari/jgzj_yolo_finetune/logs/fire_smoke_yolo_fire_smoke_20260721_170647_fire_smoke_yolo_c0_1_fire_smoke_joint_balanced_gpu3_retry.log
echo "$(date -Is) finetune_done task=fire_smoke_yolo class=fire_smoke" | tee -a /home/sari/jgzj_yolo_finetune/logs/fire_smoke_yolo_fire_smoke_20260721_170647_fire_smoke_yolo_c0_1_fire_smoke_joint_balanced_gpu3_retry.log
