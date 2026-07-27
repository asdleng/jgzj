# Fire/Smoke Full Review Full20 Snapshot

Saved at: 2026-07-27T16:17:36.495800+08:00

Run command:

```bash
cd /home/admin1/jgzj && python3 finetune/finetune_yolo_nohard.py --model fire_smoke_yolo --run-tag 20260727_155000_fire_smoke_full_review_full20 --epochs 20 --disable-early-stop --save-period 1 --train-backend local
```

Base weight:
/home/admin1/jgzj/.runtime/yolo_model_service/weights/fire_smoke_yolo_nohard_round2_20260727_130839.pt

Run dir:
/home/admin1/jgzj/.runtime/finetune/local_runs/fire_smoke_yolo/fire_smoke_yolo_fire_smoke_full_review_finetune_20260727_155000_fire_smoke_full_review_full20_fire_smoke_yolo_fire_smoke_full_review_20260727_155000_fire_smoke_full_review_full20_20260727_154734

Selected model:
/home/admin1/jgzj/.runtime/finetune/local_runs/fire_smoke_yolo/fire_smoke_yolo_fire_smoke_full_review_finetune_20260727_155000_fire_smoke_full_review_full20_fire_smoke_yolo_fire_smoke_full_review_20260727_155000_fire_smoke_full_review_full20_20260727_154734/weights/last.pt

Epoch-20 checkpoint:
/home/admin1/jgzj/.runtime/finetune/local_runs/fire_smoke_yolo/fire_smoke_yolo_fire_smoke_full_review_finetune_20260727_155000_fire_smoke_full_review_full20_fire_smoke_yolo_fire_smoke_full_review_20260727_155000_fire_smoke_full_review_full20_20260727_154734/weights/epoch19.pt

Notes:
- 20 epochs completed with early stopping disabled.
- `save_period=1`; checkpoints were saved for every epoch.
- Dataset uses manually reviewed `loop:finetune_v2` and `loop:fire_smoke_web_candidates_v3` samples.
