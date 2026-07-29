#!/usr/bin/env bash
set -euo pipefail
cd "/home/sari/jgzj_yolo_finetune"
mkdir -p logs results runs scripts
python3 - <<PY
from pathlib import Path
p = Path("/home/sari/jgzj_yolo_finetune/datasets/20260729_102722_pet_yolo_reviewed_finetune/pet_yolo_reviewed_stratified/data.yaml")
lines = p.read_text(encoding="utf-8").splitlines()
out = []
for line in lines:
    if line.startswith("path:"):
        out.append("path: /home/sari/jgzj_yolo_finetune/datasets/20260729_102722_pet_yolo_reviewed_finetune/pet_yolo_reviewed_stratified")
    else:
        out.append(line)
p.write_text("\n".join(out) + "\n", encoding="utf-8")
PY
echo "$(date -Is) finetune_start task=pet_yolo class=pet data=/home/sari/jgzj_yolo_finetune/datasets/20260729_102722_pet_yolo_reviewed_finetune/pet_yolo_reviewed_stratified/data.yaml" | tee -a "/home/sari/jgzj_yolo_finetune/logs/pet_yolo_reviewed_20260729_102722_pet_yolo_reviewed_finetune.log"
export TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD=1
export WANDB_DISABLED=true
CUDA_VISIBLE_DEVICES=3 \
RELIABLE_YOLO_TASK="pet_yolo_reviewed_finetune" \
RELIABLE_YOLO_RUN_TAG="20260729_102722_pet_yolo_reviewed_finetune" \
RELIABLE_YOLO_DATA="/home/sari/jgzj_yolo_finetune/datasets/20260729_102722_pet_yolo_reviewed_finetune/pet_yolo_reviewed_stratified/data.yaml" \
RELIABLE_YOLO_OUT="/home/sari/jgzj_yolo_finetune/results/pet_yolo_reviewed_20260729_102722_pet_yolo_reviewed_finetune" \
RELIABLE_YOLO_PROJECT="/home/sari/jgzj_yolo_finetune/runs/pet_yolo" \
RELIABLE_YOLO_BASE_WEIGHTS="20260729_102722_pet_yolo_reviewed_finetune_pet_yolo_best=/home/sari/jgzj_yolo_finetune/weights/20260729_102722_pet_yolo_reviewed_finetune_pet_yolo_best.pt" \
RELIABLE_YOLO_EPOCHS=20 \
RELIABLE_YOLO_PATIENCE=6 \
RELIABLE_YOLO_BATCH=32 \
RELIABLE_YOLO_IMGSZ=640 \
RELIABLE_YOLO_WORKERS=8 \
RELIABLE_YOLO_SAVE_PERIOD=-1 \
/home/sari/autodistill/bin/python scripts/train_reliable_yolo_finetune.py 2>&1 | tee -a "/home/sari/jgzj_yolo_finetune/logs/pet_yolo_reviewed_20260729_102722_pet_yolo_reviewed_finetune.log"
echo "$(date -Is) finetune_done task=pet_yolo class=pet" | tee -a "/home/sari/jgzj_yolo_finetune/logs/pet_yolo_reviewed_20260729_102722_pet_yolo_reviewed_finetune.log"
