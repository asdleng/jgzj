#!/usr/bin/env python3
import csv
import json
import os
import sys
import time
import traceback
from datetime import datetime
from pathlib import Path


OVERLAY = Path(os.environ.get("RELIABLE_YOLO_OVERLAY", "/home/sari/yolo_new_arch_experiments_20260626/ultralytics_overlay"))
DOWNLOADS = Path(os.environ.get("RELIABLE_YOLO_DOWNLOADS", "/home/sari/yolo_new_arch_experiments_20260626/downloads"))
DATA = Path(os.environ["RELIABLE_YOLO_DATA"])
PROJECT = Path(os.environ.get("RELIABLE_YOLO_PROJECT", "/home/sari/jgzj_yolo_runs_reliable_vehicle_20260704"))
OUT = Path(os.environ.get("RELIABLE_YOLO_OUT", "/home/sari/reliable_vehicle_yolo_20260704/results"))
TASK = os.environ.get("RELIABLE_YOLO_TASK", "unknown")
RUN_TAG = os.environ.get("RELIABLE_YOLO_RUN_TAG", "default")
EPOCHS = int(os.environ.get("RELIABLE_YOLO_EPOCHS", "60"))
PATIENCE = int(os.environ.get("RELIABLE_YOLO_PATIENCE", "15"))
BATCH = int(os.environ.get("RELIABLE_YOLO_BATCH", "64"))
IMGSZ = int(os.environ.get("RELIABLE_YOLO_IMGSZ", "640"))
WORKERS = int(os.environ.get("RELIABLE_YOLO_WORKERS", "8"))
SAVE_PERIOD = int(os.environ.get("RELIABLE_YOLO_SAVE_PERIOD", "-1"))
MODELS = [x.strip() for x in os.environ.get("RELIABLE_YOLO_MODELS", "").split(",") if x.strip()]
BASE_WEIGHTS = [x.strip() for x in os.environ.get("RELIABLE_YOLO_BASE_WEIGHTS", "").split(",") if x.strip()]


def ensure_overlay() -> None:
    overlay = str(OVERLAY)
    if overlay not in sys.path:
        sys.path.insert(0, overlay)


def model_weight(name: str) -> Path:
    path = Path(name)
    if path.exists():
        return path
    candidates = [
        DOWNLOADS / f"{name}.pt",
        Path("/home/sari/jgzj_yolo_weights") / f"{name}.pt",
    ]
    if name in {"yolov8n", "yolo8n"}:
        candidates.extend([DOWNLOADS / "yolov8n.pt", Path("/home/sari/jgzj_yolo_weights/yolov8n.pt")])
    if name in {"yolov8s", "yolo8s"}:
        candidates.extend([DOWNLOADS / "yolov8s.pt", Path("/home/sari/jgzj_yolo_weights/yolov8s.pt")])
    for candidate in candidates:
        if candidate.exists():
            return candidate
    raise FileNotFoundError(f"missing_weight:{name}")


def scalar(value):
    if value is None:
        return None
    try:
        return float(value)
    except Exception:
        try:
            return float(value.item())
        except Exception:
            return str(value)


def load_names():
    import yaml

    data = yaml.safe_load(DATA.read_text(encoding="utf-8"))
    names = data.get("names", {})
    if isinstance(names, dict):
        keys = sorted(int(k) for k in names.keys())
        return [names.get(i, names.get(str(i), str(i))) for i in keys]
    return list(names)


def result_dict(metrics, names):
    box = metrics.box
    out = {
        "precision": scalar(box.mp),
        "recall": scalar(box.mr),
        "map50": scalar(box.map50),
        "map50_95": scalar(box.map),
    }
    for idx, name in enumerate(names):
        try:
            p, r, map50, map95 = box.class_result(idx)
            out[f"{name}_precision"] = scalar(p)
            out[f"{name}_recall"] = scalar(r)
            out[f"{name}_map50"] = scalar(map50)
            out[f"{name}_map50_95"] = scalar(map95)
        except Exception as exc:
            out[f"{name}_error"] = repr(exc)
    return out


def write_summary(rows):
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "summary.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    keys = []
    for row in rows:
        for key in row.keys():
            if key not in keys:
                keys.append(key)
    with (OUT / "summary.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=keys)
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    if "CUDA_VISIBLE_DEVICES" not in os.environ:
        raise SystemExit("CUDA_VISIBLE_DEVICES must be set explicitly; never train on server-proxy 4090.")
    if not MODELS and not BASE_WEIGHTS:
        raise SystemExit("Set RELIABLE_YOLO_MODELS or RELIABLE_YOLO_BASE_WEIGHTS.")
    ensure_overlay()
    import torch
    import ultralytics
    from ultralytics import YOLO

    names = load_names()
    PROJECT.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    print("started_at", datetime.now().isoformat(), flush=True)
    print("task", TASK, "run_tag", RUN_TAG, flush=True)
    print("data", DATA, flush=True)
    print("classes", names, flush=True)
    print("ultralytics", ultralytics.__version__, ultralytics.__file__, flush=True)
    print("torch", torch.__version__, "cuda", torch.cuda.is_available(), "visible", os.environ.get("CUDA_VISIBLE_DEVICES"), flush=True)
    print("models", MODELS, "base_weights", BASE_WEIGHTS, flush=True)
    rows = []
    summary_json = OUT / "summary.json"
    if summary_json.exists():
        try:
            rows = json.loads(summary_json.read_text(encoding="utf-8"))
        except Exception:
            rows = []
    run_specs = [(name, model_weight(name)) for name in MODELS]
    for base in BASE_WEIGHTS:
        if "=" in base:
            alias, raw_path = base.split("=", 1)
        elif ":" in base and not base.startswith("/"):
            alias, raw_path = base.split(":", 1)
        else:
            raw_path = base
            p0 = Path(raw_path)
            alias = p0.parent.parent.name if p0.name == "best.pt" and p0.parent.name == "weights" else p0.stem
        p = Path(raw_path)
        run_specs.append((alias.strip(), p))
    done = {(row.get("model"), row.get("base_weight")) for row in rows if row.get("status") == "ok"}

    for model_name, weight in run_specs:
        base_weight = str(weight)
        if (model_name, base_weight) in done:
            print("skip_completed", model_name, base_weight, flush=True)
            continue
        start = time.time()
        row = {
            "task": TASK,
            "model": model_name,
            "base_weight": base_weight,
            "status": "running",
            "run_tag": RUN_TAG,
            "started_at": datetime.now().isoformat(),
            "epochs": EPOCHS,
            "patience": PATIENCE,
            "batch": BATCH,
            "imgsz": IMGSZ,
            "save_period": SAVE_PERIOD,
            "data": str(DATA),
            "cuda_visible_devices": os.environ.get("CUDA_VISIBLE_DEVICES"),
        }
        rows = [r for r in rows if not (r.get("model") == model_name and r.get("base_weight") == base_weight)] + [row]
        write_summary(rows)
        try:
            run_name = f"{TASK}_{model_name}_{RUN_TAG}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
            print("TRAIN_START", model_name, "weight", weight, "run", run_name, flush=True)
            model = YOLO(str(weight))
            train_metrics = model.train(
                data=str(DATA),
                epochs=EPOCHS,
                patience=PATIENCE,
                imgsz=IMGSZ,
                batch=BATCH,
                device="cuda:0",
                workers=WORKERS,
                project=str(PROJECT),
                name=run_name,
                exist_ok=False,
                save_period=SAVE_PERIOD,
                optimizer="SGD",
                lr0=0.0008,
                warmup_epochs=1.0,
                amp=False,
                cache=False,
                plots=True,
                val=True,
                close_mosaic=10,
                seed=0,
                deterministic=True,
            )
            run_dir = Path(getattr(train_metrics, "save_dir", PROJECT / run_name))
            best = run_dir / "weights" / "best.pt"
            best_model = YOLO(str(best))
            val = result_dict(best_model.val(data=str(DATA), split="val", imgsz=IMGSZ, batch=BATCH, device="cuda:0", workers=WORKERS), names)
            test = result_dict(best_model.val(data=str(DATA), split="test", imgsz=IMGSZ, batch=BATCH, device="cuda:0", workers=WORKERS), names)
            row.update({
                "status": "ok",
                "finished_at": datetime.now().isoformat(),
                "train_seconds": round(time.time() - start, 3),
                "run_dir": str(run_dir),
                "best_weight": str(best),
            })
            for key, value in val.items():
                row[f"val_{key}"] = value
            for key, value in test.items():
                row[f"test_{key}"] = value
            print("MODEL_DONE", model_name, "test_map50_95", test.get("map50_95"), "test_recall", test.get("recall"), flush=True)
        except Exception as exc:
            traceback.print_exc()
            row.update({
                "status": "error",
                "finished_at": datetime.now().isoformat(),
                "train_seconds": round(time.time() - start, 3),
                "error": repr(exc),
                "traceback": traceback.format_exc(),
            })
        rows = [r for r in rows if not (r.get("model") == model_name and r.get("base_weight") == base_weight)] + [row]
        write_summary(rows)


if __name__ == "__main__":
    main()
