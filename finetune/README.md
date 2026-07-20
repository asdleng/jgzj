# YOLO target-class finetune helper

Build a target-class finetune dataset from the current model registry, then
optionally submit <=10 epoch finetuning to the A100 training host.

Example:

```bash
cd /home/admin1/jgzj
python3 finetune/finetune_yolo.py --model trash_yolo --class-id 2
```

Useful checks:

```bash
python3 finetune/finetune_yolo.py --model trash_yolo --class-id 2 --resolve-only
python3 finetune/finetune_yolo.py --model trash_yolo --class-id 2 --dry-run
```

Outputs:

- Run logs: `/home/admin1/jgzj/finetune/runs/<run_tag>/`
- Built datasets: `/home/admin1/jgzj/.runtime/finetune/datasets/<run_tag>/`
- Main log: `selection_log.json`
- Dataset manifest: `samples_manifest.jsonl`

Notes:

- The script supports detection datasets. Classification models are rejected
  because hard-sample selection relies on detection boxes, confidence, and IoU.
- Epochs are capped at 10. Defaults are 8 epochs, patience 3, batch 32.
- External low-confidence samples are pulled through
  `/home/admin1/pull_remote_dateconf_filter.py` and labeled through
  `scripts/patrol_qwen_label_vehicle_uploads.py`.
