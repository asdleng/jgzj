#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import shlex
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

try:
    import yaml
except Exception as exc:  # pragma: no cover
    raise SystemExit(f"missing PyYAML: {exc}")


CN_TZ = timezone(timedelta(hours=8))
PROJECT_ROOT = Path(os.environ.get("JGZJ_PROJECT_ROOT", "/home/admin1/jgzj"))
RUNTIME_ROOT = PROJECT_ROOT / ".runtime"
MODEL_SERVICE_ROOT = RUNTIME_ROOT / "yolo_model_service"
MODEL_REGISTRY = MODEL_SERVICE_ROOT / "model_registry.json"
WEIGHTS_DIR = MODEL_SERVICE_ROOT / "weights"
DEFAULT_PULL_SCRIPT_PY36 = Path("/home/admin1/pull_remote_dateconf_filter_py36.py")
DEFAULT_PULL_SCRIPT = Path("/home/admin1/pull_remote_dateconf_filter.py")
PULL_SCRIPT = Path(os.environ.get(
    "JGZJ_PULL_SCRIPT",
    str(DEFAULT_PULL_SCRIPT_PY36 if DEFAULT_PULL_SCRIPT_PY36.exists() else DEFAULT_PULL_SCRIPT),
))
PULL_SSH_KEY = Path(os.environ.get("JGZJ_PULL_SSH_KEY", "/home/admin1/.ssh/id_ed25519_data_ps_pull"))
PULL_DEFAULT_SSH_OPTIONS = shlex.split(os.environ.get(
    "JGZJ_PULL_SSH_OPTIONS",
    "-o BatchMode=yes -o ConnectTimeout=20 -o StrictHostKeyChecking=no",
))
QWEN_LABEL_SCRIPT = PROJECT_ROOT / "scripts" / "patrol_qwen_label_vehicle_uploads.py"
TRAIN_SCRIPT = RUNTIME_ROOT / "reliable_vehicle_yolo_20260704" / "train_reliable_yolo_finetune.py"
POLICY_SCRIPT = PROJECT_ROOT / "scripts" / "yolo_closed_loop_policy.py"
FINETUNE_ROOT = PROJECT_ROOT / "finetune"
FINETUNE_RUNTIME = RUNTIME_ROOT / "finetune"
EVENT_FEEDBACK_ROOT = RUNTIME_ROOT / "yolo_loop" / "datasets" / "yolo_event_feedback_v1"
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}

A100_HOST = os.environ.get("YOLO_A100_HOST", "192.168.80.49")
A100_USER = os.environ.get("YOLO_A100_USER", "sari")
A100_KEY = os.environ.get("YOLO_A100_KEY", "/home/admin1/a100_tunnel/jgzj_qwen36_proxy_ed25519")
A100_ROOT = os.environ.get("YOLO_FINETUNE_A100_ROOT", "/home/sari/jgzj_yolo_finetune")
A100_PY = os.environ.get("YOLO_DAILY_A100_PY", "/home/sari/autodistill/bin/python")

FEEDBACK_CLASSES = [
    "person",
    "vehicle",
    "nonmotor",
    "fire",
    "smoke",
    "trash",
    "pet",
    "stall",
    "phone",
    "smoking",
]
FEEDBACK_CLASS_ID = {name: idx for idx, name in enumerate(FEEDBACK_CLASSES)}

KNOWN_DATASET_BY_TASK = {
    "person_yolo": RUNTIME_ROOT / "yolo_daily_closed_loop" / "runs" / "20260714_232301" / "datasets" / "person_yolo_closed_loop_20260713" / "data.yaml",
    "vehicle_yolo": RUNTIME_ROOT / "yolo_daily_closed_loop" / "runs" / "20260719_150443" / "datasets" / "vehicle_yolo_closed_loop_20260718" / "data.yaml",
    "pet_yolo": RUNTIME_ROOT / "yolo_loop" / "datasets" / "pet_yolo_public_merged_20260627" / "pet_yolo" / "data.yaml",
    "phone_yolo": RUNTIME_ROOT / "external_yolo" / "phone_yolo_coco2017_v1" / "data.yaml",
    "trash_yolo": RUNTIME_ROOT / "yolo_loop" / "datasets" / "trash_yolo_20260623_000839" / "trash_yolo" / "data.yaml",
    "stall_yolo": RUNTIME_ROOT / "yolo_loop_manual" / "stall_yolo" / "datasets" / "stall_yolo_20260623_214302" / "stall_yolo" / "data.yaml",
    "fire_smoke_yolo": Path("/home/admin1/datasets/fire_other_edge/data_fire_other_edge.yaml"),
    "license_plate_yolo": RUNTIME_ROOT / "license_plate_yolo_20260629" / "datasets" / "ccpd2020_lp_yolo_30k" / "data.yaml",
    "fishing_rod_yolo": RUNTIME_ROOT / "yolo_loop" / "datasets" / "fishing_rod_yolo_public_plus_local_neg_20260629" / "fishing_rod_yolo" / "data.yaml",
}

QWEN_COARSE_CLASS = {
    "car": "vehicle",
    "truck": "vehicle",
    "bus": "vehicle",
    "van": "vehicle",
    "non_motor_vehicle": "nonmotor",
    "non-motorvehicle": "nonmotor",
    "bicycle": "nonmotor",
    "bike": "nonmotor",
    "ebike": "nonmotor",
    "e_bike": "nonmotor",
    "scooter": "nonmotor",
    "bottle": "trash",
    "box": "trash",
    "paper": "trash",
    "bag": "trash",
}

PULL_CLASS_ALIASES = {
    "vehicle": ["vehicle", "car", "truck", "bus", "van"],
    "car": ["car"],
    "truck": ["truck"],
    "nonmotor": ["nonmotor", "non_motor_vehicle", "non-motorVehicle", "bicycle", "bike", "ebike", "e_bike", "scooter", "motorcycle"],
    "non_motor_vehicle": ["non_motor_vehicle", "non-motorVehicle", "bicycle", "bike", "ebike", "e_bike", "scooter", "motorcycle"],
    "trash": ["trash", "bottle", "box", "paper", "bag"],
    "bottle": ["bottle"],
    "box": ["box"],
    "paper": ["paper"],
    "bag": ["bag"],
    "pet": ["pet", "dog", "cat", "off_leash_dog"],
    "fire": ["fire"],
    "smoke": ["smoke"],
    "stall": ["stall"],
    "phone": ["phone"],
    "smoking": ["smoking"],
    "person": ["person"],
}


@dataclass
class ModelInfo:
    task_id: str
    title: str
    task: str
    weight: Path
    data: Path
    registry_entry: dict[str, Any]
    data_source: str


def log(message: str) -> None:
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}", flush=True)


def cn_now() -> datetime:
    return datetime.now(CN_TZ)


def normalize_name(value: str) -> str:
    return str(value or "").strip().lower().replace("-", "_").replace(" ", "_")


def qwen_class_for(name: str) -> str:
    normalized = normalize_name(name)
    return QWEN_COARSE_CLASS.get(normalized, normalized)


def pull_aliases_for(name: str) -> list[str]:
    normalized = normalize_name(name)
    aliases = PULL_CLASS_ALIASES.get(normalized, [normalized])
    seen = set()
    out = []
    for item in aliases:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


def run(cmd: list[str], *, timeout: int = 600, check: bool = True) -> subprocess.CompletedProcess:
    log(f"run: {shlex.join(cmd)}")
    result = subprocess.run(cmd, text=True, capture_output=True, timeout=timeout)
    if check and result.returncode != 0:
        raise RuntimeError(
            "command_failed "
            f"rc={result.returncode} cmd={shlex.join(cmd)}\n"
            f"stdout={result.stdout[-4000:]}\n"
            f"stderr={result.stderr[-4000:]}"
        )
    return result


def pull_ssh_args(args: argparse.Namespace) -> list[str]:
    options = list(PULL_DEFAULT_SSH_OPTIONS)
    options.extend(getattr(args, "pull_ssh_option", []) or [])
    key_value = str(getattr(args, "pull_ssh_key", "") or "").strip()
    key = Path(key_value) if key_value else None
    if key and key.exists() and "-i" not in options and "IdentityFile" not in " ".join(options):
        options.extend(["-i", str(key)])
    out: list[str] = []
    for option in options:
        out.append(f"--ssh-option={option}")
    return out


def a100(command: str, *, timeout: int = 120, check: bool = True) -> subprocess.CompletedProcess:
    return run(
        [
            "ssh",
            "-i",
            A100_KEY,
            "-o",
            "ClearAllForwardings=yes",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=12",
            "-o",
            "StrictHostKeyChecking=no",
            f"{A100_USER}@{A100_HOST}",
            command,
        ],
        timeout=timeout,
        check=check,
    )


def rsync_to_a100(local_path: Path, remote_path: str, *, timeout: int = 1800) -> None:
    local = str(local_path)
    if local_path.is_dir():
        local = local.rstrip("/") + "/"
        remote_path = remote_path.rstrip("/") + "/"
    run(
        [
            "rsync",
            "-a",
            "-e",
            f"ssh -i {shlex.quote(A100_KEY)} -o ClearAllForwardings=yes -o BatchMode=yes -o ConnectTimeout=12 -o StrictHostKeyChecking=no",
            local,
            f"{A100_USER}@{A100_HOST}:{remote_path}",
        ],
        timeout=timeout,
        check=True,
    )


def load_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def read_yaml(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}
    if not isinstance(data, dict):
        raise ValueError(f"invalid_yaml:{path}")
    return data


def parse_args_yaml(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for raw in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        match = re.match(r"^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$", raw)
        if match:
            out[match.group(1)] = match.group(2).strip().strip("\"'")
    return out


def map_external_dataset(path: Path) -> Path:
    text = str(path)
    prefix = "/home/sari/jgzj_yolo_datasets/"
    if not text.startswith(prefix):
        return path
    tail = text[len(prefix):]
    candidate = RUNTIME_ROOT / "external_yolo" / tail
    if candidate.exists():
        return candidate
    parts = Path(tail).parts
    if parts:
        candidate = RUNTIME_ROOT / "external_yolo" / parts[0] / Path(*parts[1:])
        if candidate.exists():
            return candidate
    return path


def find_dataset_by_weight_hash(weight: Path) -> tuple[Path | None, str]:
    if not weight.exists() or weight.suffix != ".pt":
        return None, "no_pt_weight"
    target_sha = sha256_file(weight)
    for best in RUNTIME_ROOT.rglob("weights/best.pt"):
        if "yolo_model_service" in best.parts:
            continue
        try:
            if sha256_file(best) != target_sha:
                continue
        except Exception:
            continue
        args = parse_args_yaml(best.parent.parent / "args.yaml")
        raw = args.get("data")
        if raw:
            candidate = map_external_dataset(Path(raw))
            if candidate.exists():
                return candidate, f"sha256_match:{best}"
            return Path(raw), f"sha256_match_missing_data:{best}"
    return None, "no_sha256_match"


def infer_closed_loop_dataset(entry: dict[str, Any], task_id: str) -> tuple[Path | None, str]:
    text = " ".join(str(entry.get(key) or "") for key in ("model_family", "source_run", "best_weight"))
    tags = re.findall(r"20\d{6}_\d{6}", text)
    for tag in tags:
        run_dir = RUNTIME_ROOT / "yolo_daily_closed_loop" / "runs" / tag
        if not run_dir.exists():
            continue
        dataset_root = run_dir / "datasets"
        for data_yaml in sorted(dataset_root.glob(f"{task_id}_*/data.yaml")):
            return data_yaml, f"closed_loop:{tag}"
        for data_yaml in sorted(dataset_root.glob("*/data.yaml")):
            if task_id.split("_", 1)[0] in data_yaml.as_posix():
                return data_yaml, f"closed_loop_fuzzy:{tag}"
    return None, "no_closed_loop_dataset"


def resolve_model(model_name: str) -> ModelInfo:
    registry = load_json(MODEL_REGISTRY, {})
    entries = registry.get("entries") if isinstance(registry, dict) else []
    if not isinstance(entries, list):
        raise SystemExit(f"invalid_registry:{MODEL_REGISTRY}")

    token = normalize_name(model_name)
    matched = None
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        aliases = {
            normalize_name(entry.get("task_id", "")),
            normalize_name(entry.get("title", "")),
            normalize_name(Path(str(entry.get("local_weight") or "")).stem),
            normalize_name(Path(str(entry.get("download_file") or "")).stem),
        }
        if token in aliases:
            matched = entry
            break
    if matched is None:
        known = ", ".join(str(e.get("task_id")) for e in entries if isinstance(e, dict))
        raise SystemExit(f"unknown_model:{model_name}; registry_tasks={known}")

    task_id = str(matched.get("task_id") or model_name)
    weight = Path(str(matched.get("local_weight") or ""))
    if not weight.exists():
        candidates = list(WEIGHTS_DIR.glob(f"{task_id}*.pt"))
        if candidates:
            weight = max(candidates, key=lambda p: p.stat().st_mtime)
    if not weight.exists():
        raise SystemExit(f"weight_not_found:{weight}")

    dataset = None
    source = ""
    registry_text = " ".join(str(matched.get(key) or "") for key in ("source_run", "model_family", "best_weight"))
    if "yolo_daily_closed_loop" in registry_text:
        dataset, source = infer_closed_loop_dataset(matched, task_id)
    if dataset is None or not dataset.exists():
        dataset, source = find_dataset_by_weight_hash(weight)
    if dataset is None or not dataset.exists():
        dataset, source2 = infer_closed_loop_dataset(matched, task_id)
        source = source2
    if (dataset is None or not dataset.exists()) and task_id in KNOWN_DATASET_BY_TASK:
        dataset = KNOWN_DATASET_BY_TASK[task_id]
        source = "known_current_table"
    if dataset is None or not dataset.exists():
        raise SystemExit(f"dataset_not_found_for:{task_id}; last_source={source}")

    task = "detect"
    if dataset.is_dir() and dataset.suffix not in {".yaml", ".yml"}:
        task = "classify"
    elif dataset.suffix in {".yaml", ".yml"}:
        data = read_yaml(dataset)
        if not data.get("train") or not data.get("names"):
            task = "classify"

    return ModelInfo(
        task_id=task_id,
        title=str(matched.get("title") or ""),
        task=task,
        weight=weight,
        data=dataset,
        registry_entry=matched,
        data_source=source,
    )


def names_from_data(data_yaml: Path) -> list[str]:
    data = read_yaml(data_yaml)
    names = data.get("names")
    if isinstance(names, dict):
        pairs = []
        for key, value in names.items():
            pairs.append((int(key), str(value)))
        return [value for _, value in sorted(pairs)]
    if isinstance(names, list):
        return [str(item) for item in names]
    raise SystemExit(f"missing_names:{data_yaml}")


def split_paths_from_data(data_yaml: Path) -> dict[str, list[Path]]:
    data = read_yaml(data_yaml)
    root = Path(str(data.get("path") or data_yaml.parent))
    if not root.is_absolute():
        root = data_yaml.parent / root
    out: dict[str, list[Path]] = {}
    for split in ("train", "val", "test"):
        raw = data.get(split)
        if not raw:
            continue
        values = raw if isinstance(raw, list) else [raw]
        images: list[Path] = []
        for value in values:
            p = Path(str(value))
            if not p.is_absolute():
                p = root / p
            if p.is_dir():
                images.extend(
                    path for path in p.rglob("*")
                    if path.is_file() and path.suffix.lower() in IMAGE_EXTS
                )
            elif p.is_file():
                for line in p.read_text(encoding="utf-8", errors="ignore").splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    item = Path(line)
                    if not item.is_absolute():
                        item = p.parent / item
                    if item.exists() and item.suffix.lower() in IMAGE_EXTS:
                        images.append(item)
        out[split] = sorted(set(path.resolve() for path in images))
    return out


def label_path_for_image(image_path: Path) -> Path:
    parts = list(image_path.parts)
    for idx in range(len(parts) - 1, -1, -1):
        if parts[idx] == "images":
            parts[idx] = "labels"
            return Path(*parts).with_suffix(".txt")
    return image_path.with_suffix(".txt")


def parse_label_file(label_path: Path) -> list[dict[str, Any]]:
    if not label_path.exists():
        return []
    labels = []
    for raw in label_path.read_text(encoding="utf-8", errors="ignore").splitlines():
        parts = raw.strip().split()
        if len(parts) < 5:
            continue
        try:
            cls = int(float(parts[0]))
            x, y, w, h = [float(v) for v in parts[1:5]]
        except Exception:
            continue
        labels.append({"cls": cls, "xywh": [x, y, w, h], "raw": raw.strip()})
    return labels


def xywh_to_xyxy(box: list[float]) -> list[float]:
    x, y, w, h = box
    return [x - w / 2.0, y - h / 2.0, x + w / 2.0, y + h / 2.0]


def iou_xyxy(a: list[float], b: list[float]) -> float:
    x1 = max(a[0], b[0])
    y1 = max(a[1], b[1])
    x2 = min(a[2], b[2])
    y2 = min(a[3], b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    denom = area_a + area_b - inter
    return inter / denom if denom > 0 else 0.0


def collect_dataset_records(data_yaml: Path, class_id: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    positives: list[dict[str, Any]] = []
    negatives: list[dict[str, Any]] = []
    for split, images in split_paths_from_data(data_yaml).items():
        for image_path in images:
            label_path = label_path_for_image(image_path)
            labels = parse_label_file(label_path)
            target_labels = [item for item in labels if item["cls"] == class_id]
            row = {
                "image": image_path,
                "label": label_path,
                "split": split,
                "labels": labels,
                "target_labels": target_labels,
                "source": "original_dataset",
            }
            if target_labels:
                positives.append(row)
            else:
                negatives.append(row)
    return positives, negatives


def load_yolo(weight: Path):
    from ultralytics import YOLO

    return YOLO(str(weight))


def predict_batch(model: Any, paths: list[Path], args: argparse.Namespace) -> dict[Path, list[dict[str, Any]]]:
    out: dict[Path, list[dict[str, Any]]] = {}
    if not paths:
        return out
    for start in range(0, len(paths), args.infer_chunk_size):
        chunk = paths[start:start + args.infer_chunk_size]
        results = model.predict(
            source=[str(p) for p in chunk],
            stream=True,
            conf=args.predict_conf_floor,
            iou=args.predict_nms_iou,
            imgsz=args.imgsz,
            device=args.infer_device,
            batch=args.infer_batch,
            verbose=False,
        )
        for result in results:
            path = Path(result.path).resolve()
            preds: list[dict[str, Any]] = []
            boxes = getattr(result, "boxes", None)
            if boxes is not None and len(boxes) > 0:
                cls_values = boxes.cls.detach().cpu().tolist()
                conf_values = boxes.conf.detach().cpu().tolist()
                xyxyn_values = boxes.xyxyn.detach().cpu().tolist()
                for cls, conf, xyxy in zip(cls_values, conf_values, xyxyn_values):
                    preds.append({"cls": int(cls), "conf": float(conf), "xyxy": [float(v) for v in xyxy]})
            out[path] = preds
    return out


def score_positive(row: dict[str, Any], preds: list[dict[str, Any]], class_id: int, args: argparse.Namespace) -> dict[str, Any]:
    target_preds = [p for p in preds if p["cls"] == class_id]
    gt_boxes = [xywh_to_xyxy(item["xywh"]) for item in row["target_labels"]]
    max_conf = max([p["conf"] for p in target_preds], default=0.0)
    best_iou = 0.0
    best_matched_conf = 0.0
    for gt in gt_boxes:
        for pred in target_preds:
            iou = iou_xyxy(gt, pred["xyxy"])
            best_iou = max(best_iou, iou)
            if iou >= args.pos_iou_threshold:
                best_matched_conf = max(best_matched_conf, pred["conf"])
    is_hard = best_iou < args.pos_iou_threshold or best_matched_conf < args.normal_pos_min_conf
    return {
        "bucket": "hard_positive" if is_hard else "normal_positive",
        "target_conf": max_conf,
        "matched_conf": best_matched_conf,
        "max_iou": best_iou,
        "reason": "low_conf_or_low_iou" if is_hard else "conf_iou_ok",
    }


def score_negative(preds: list[dict[str, Any]], class_id: int, args: argparse.Namespace) -> dict[str, Any]:
    target_preds = [p for p in preds if p["cls"] == class_id]
    max_conf = max([p["conf"] for p in target_preds], default=0.0)
    if max_conf >= args.hard_neg_min_conf:
        return {"bucket": "hard_negative", "target_conf": max_conf, "max_iou": 0.0, "reason": "false_positive_conf"}
    return {"bucket": "normal_negative", "target_conf": max_conf, "max_iou": 0.0, "reason": "no_target_prediction"}


def add_selected(
    selected: list[dict[str, Any]],
    used: set[str],
    row: dict[str, Any],
    category: str,
    source_bucket: str,
    score: dict[str, Any],
    *,
    label_mode: str = "copy",
    label_lines: list[str] | None = None,
) -> bool:
    image = Path(row["image"]).resolve()
    key = str(image)
    if key in used:
        return False
    used.add(key)
    selected.append(
        {
            "image": str(image),
            "label": str(row.get("label") or ""),
            "category": category,
            "source_bucket": source_bucket,
            "source": row.get("source") or "",
            "split": row.get("split") or "",
            "reason": score.get("reason"),
            "target_conf": score.get("target_conf"),
            "matched_conf": score.get("matched_conf"),
            "max_iou": score.get("max_iou"),
            "label_mode": label_mode,
            "label_lines": label_lines,
        }
    )
    return True


def select_original_samples(
    model: Any,
    positives: list[dict[str, Any]],
    negatives: list[dict[str, Any]],
    class_id: int,
    args: argparse.Namespace,
    rng: random.Random,
    selected: list[dict[str, Any]],
    used: set[str],
) -> dict[str, Any]:
    rng.shuffle(positives)
    rng.shuffle(negatives)
    need = {
        "original_normal_positive": args.original_normal_pos,
        "original_hard_positive": args.original_hard_pos,
        "original_normal_negative": args.original_normal_neg,
        "original_hard_negative": args.original_hard_neg,
    }
    counts = {key: 0 for key in need}

    pos_scan = min(len(positives), max(args.min_positive_scan, (args.original_normal_pos + args.original_hard_pos) * args.scan_multiplier))
    neg_scan = min(len(negatives), max(args.min_negative_scan, (args.original_normal_neg + args.original_hard_neg) * args.scan_multiplier))

    pos_rows = positives[:pos_scan]
    neg_rows = negatives[:neg_scan]
    log(f"original_scan positives={len(pos_rows)}/{len(positives)} negatives={len(neg_rows)}/{len(negatives)}")

    pos_preds = predict_batch(model, [row["image"] for row in pos_rows], args)
    for row in pos_rows:
        score = score_positive(row, pos_preds.get(Path(row["image"]).resolve(), []), class_id, args)
        if score["bucket"] == "normal_positive" and counts["original_normal_positive"] < need["original_normal_positive"]:
            if add_selected(selected, used, row, "normal_positive", "original_normal_positive", score):
                counts["original_normal_positive"] += 1
        elif score["bucket"] == "hard_positive" and counts["original_hard_positive"] < need["original_hard_positive"]:
            if add_selected(selected, used, row, "hard_positive", "original_hard_positive", score):
                counts["original_hard_positive"] += 1
        if all(counts[key] >= need[key] for key in ("original_normal_positive", "original_hard_positive")):
            break

    neg_preds = predict_batch(model, [row["image"] for row in neg_rows], args)
    for row in neg_rows:
        score = score_negative(neg_preds.get(Path(row["image"]).resolve(), []), class_id, args)
        if score["bucket"] == "normal_negative" and counts["original_normal_negative"] < need["original_normal_negative"]:
            if add_selected(selected, used, row, "normal_negative", "original_normal_negative", score):
                counts["original_normal_negative"] += 1
        elif score["bucket"] == "hard_negative" and counts["original_hard_negative"] < need["original_hard_negative"]:
            if add_selected(selected, used, row, "hard_negative", "original_hard_negative", score):
                counts["original_hard_negative"] += 1
        if all(counts[key] >= need[key] for key in ("original_normal_negative", "original_hard_negative")):
            break

    fallback_fill_from_original(
        selected=selected,
        used=used,
        positives=positives,
        negatives=negatives,
        counts=counts,
        needs=need,
        rng=rng,
    )
    return {"requested": need, "selected": counts, "scanned_positive": len(pos_rows), "scanned_negative": len(neg_rows)}


def fallback_fill_from_original(
    *,
    selected: list[dict[str, Any]],
    used: set[str],
    positives: list[dict[str, Any]],
    negatives: list[dict[str, Any]],
    counts: dict[str, int],
    needs: dict[str, int],
    rng: random.Random,
) -> None:
    for key in ("original_normal_positive", "original_hard_positive"):
        if counts.get(key, 0) >= needs.get(key, 0):
            continue
        category = "normal_positive" if key == "original_normal_positive" else "hard_positive"
        rows = positives[:]
        rng.shuffle(rows)
        for row in rows:
            if counts[key] >= needs[key]:
                break
            score = {"reason": "fallback_original", "target_conf": None, "max_iou": None}
            if add_selected(selected, used, row, category, key, score):
                counts[key] += 1
    for key in ("original_normal_negative", "original_hard_negative"):
        if counts.get(key, 0) >= needs.get(key, 0):
            continue
        category = "normal_negative" if key == "original_normal_negative" else "hard_negative"
        rows = negatives[:]
        rng.shuffle(rows)
        for row in rows:
            if counts[key] >= needs[key]:
                break
            score = {"reason": "fallback_original", "target_conf": None, "max_iou": None}
            if add_selected(selected, used, row, category, key, score):
                counts[key] += 1


def cache_path(root: Path, image_sha: str | None) -> Path | None:
    safe = "".join(ch for ch in str(image_sha or "").lower() if ch in "0123456789abcdef")
    if not safe:
        return None
    return root / safe[:2] / f"{safe}.json"


def hardlink_or_copy(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        dst.unlink()
    try:
        os.link(src, dst)
    except OSError:
        shutil.copy2(src, dst)


def pull_low_conf_images(class_name: str, run_dir: Path, args: argparse.Namespace) -> tuple[Path | None, dict[str, Any]]:
    if args.skip_pull:
        return None, {"skipped": True}
    aliases = pull_aliases_for(class_name)
    pull_script = Path(args.pull_script)
    if not pull_script.exists():
        return None, {
            "error": f"pull_script_missing:{pull_script}",
            "aliases": aliases,
            "pull_script": str(pull_script),
        }
    ssh_args = pull_ssh_args(args)
    today = cn_now().date()
    attempts = [args.pull_lookback_days]
    if args.pull_fallback_days > args.pull_lookback_days:
        attempts.append(args.pull_fallback_days)
    last_summary: dict[str, Any] = {}
    best_success: tuple[Path, dict[str, Any]] | None = None
    for days in attempts:
        start = today - timedelta(days=max(0, days - 1))
        out_dir = run_dir / "tmp" / f"pulled_low_conf_{days}d"
        for attempt in range(1, args.pull_retries + 1):
            if out_dir.exists():
                shutil.rmtree(out_dir)
            cmd = [
                sys.executable,
                str(pull_script),
                *ssh_args,
                "--output-dir",
                str(out_dir),
                "--classes",
                *aliases,
                "--min-conf",
                str(args.pull_min_conf),
                "--max-conf",
                str(args.pull_max_conf),
                "--strict-max-conf",
                "--max-images",
                str(args.pull_limit),
                "--time-from",
                start.isoformat(),
                "--time-to",
                today.isoformat(),
            ]
            try:
                result = run(cmd, timeout=args.pull_timeout, check=True)
            except Exception as exc:
                last_summary = {
                    "error": repr(exc),
                    "lookback_days": days,
                    "attempt": attempt,
                    "pull_retries": args.pull_retries,
                    "aliases": aliases,
                    "pull_script": str(pull_script),
                    "ssh_options": ssh_args,
                }
                if attempt < args.pull_retries:
                    time.sleep(max(0.0, args.pull_retry_sleep))
                continue
            summary = load_json(out_dir / "summary.json", {})
            summary["stdout_tail"] = result.stdout[-2000:]
            summary["lookback_days"] = days
            summary["attempt"] = attempt
            summary["pull_retries"] = args.pull_retries
            summary["aliases"] = aliases
            summary["pull_script"] = str(pull_script)
            summary["ssh_options"] = ssh_args
            last_summary = summary
            best_success = (out_dir, summary)
            if int(summary.get("matched_images") or 0) >= args.pull_limit or days == attempts[-1]:
                return out_dir, summary
            break
    if best_success is not None:
        out_dir, summary = best_success
        summary = dict(summary)
        summary["fallback_error"] = last_summary.get("error")
        return out_dir, summary
    return None, last_summary


def prepare_qwen_frames(pull_dir: Path, run_dir: Path) -> tuple[Path, Path, list[dict[str, Any]]]:
    frames_root = run_dir / "tmp" / "qwen_frames"
    images_dir = frames_root / "images"
    if frames_root.exists():
        shutil.rmtree(frames_root)
    images_dir.mkdir(parents=True, exist_ok=True)
    manifest = []
    manifest_path = pull_dir / "manifest.jsonl"
    if manifest_path.exists():
        for line in manifest_path.read_text(encoding="utf-8", errors="ignore").splitlines():
            if not line.strip():
                continue
            try:
                manifest.append(json.loads(line))
            except Exception:
                pass
    rows: list[dict[str, Any]] = []
    for idx, image in enumerate(sorted(p for p in pull_dir.iterdir() if p.suffix.lower() in IMAGE_EXTS), 1):
        rel = Path("images") / image.name
        dst = frames_root / rel
        hardlink_or_copy(image, dst)
        image_sha = sha256_file(dst)
        meta = manifest[idx - 1] if idx - 1 < len(manifest) else {}
        meta_payload = {
            "image_path": rel.as_posix(),
            "image_sha256": image_sha,
            "source": "finetune_pull_low_conf",
            "collected_at": meta.get("device_time") or "",
            "pull_manifest": meta,
        }
        meta_path = dst.with_suffix(dst.suffix + ".json")
        write_json(meta_path, meta_payload)
        rows.append({"image": dst, "image_rel": rel.as_posix(), "image_sha256": image_sha, "meta": meta_payload})
    image_list = run_dir / "tmp" / "qwen_image_list.txt"
    image_list.write_text("\n".join(row["image_rel"] for row in rows) + "\n", encoding="utf-8")
    return frames_root, image_list, rows


def run_qwen_label(frames_root: Path, image_list: Path, label_root: Path, args: argparse.Namespace) -> dict[str, Any]:
    if args.skip_qwen:
        return {"skipped": True}
    cmd = [
        sys.executable,
        str(QWEN_LABEL_SCRIPT),
        "--frames-root",
        str(frames_root),
        "--output-root",
        str(label_root),
        "--source",
        "",
        "--image-list",
        str(image_list),
        "--workers",
        str(args.qwen_workers),
        "--service-url",
        args.qwen_service_url,
        "--max-side",
        str(args.qwen_max_side),
        "--jpeg-quality",
        str(args.qwen_jpeg_quality),
        "--timeout-s",
        str(args.qwen_timeout_s),
        "--max-tokens",
        str(args.qwen_max_tokens),
    ]
    result = run(cmd, timeout=args.qwen_timeout_s * max(2, args.pull_limit // max(1, args.qwen_workers)) + 300, check=False)
    return {
        "returncode": result.returncode,
        "stdout_tail": result.stdout[-4000:],
        "stderr_tail": result.stderr[-4000:],
    }


def load_qwen_label_classes(label_root: Path, image_sha: str) -> tuple[list[str], list[dict[str, Any]], str]:
    path = cache_path(label_root, image_sha)
    if not path or not path.exists():
        return [], [], "missing"
    payload = load_json(path, {})
    labels = payload.get("labels") or []
    classes = [normalize_name(item.get("class_name") or item.get("class") or item.get("label")) for item in labels if isinstance(item, dict)]
    quality = str(payload.get("quality") or payload.get("q") or "")
    return classes, labels, quality


def select_pulled_hard_negatives(
    model: Any,
    class_id: int,
    qwen_target: str,
    pull_dir: Path | None,
    run_dir: Path,
    args: argparse.Namespace,
    rng: random.Random,
    selected: list[dict[str, Any]],
    used: set[str],
) -> dict[str, Any]:
    if pull_dir is None or not pull_dir.exists() or args.skip_pull:
        return {"requested": args.pulled_hard_neg, "selected": 0, "skipped": True}
    frames_root, image_list, rows = prepare_qwen_frames(pull_dir, run_dir)
    label_root = run_dir / "tmp" / "qwen_labels"
    qwen_summary = run_qwen_label(frames_root, image_list, label_root, args)
    if qwen_summary.get("returncode", 0) != 0 and not args.allow_qwen_failure:
        raise RuntimeError(f"qwen_label_failed:{qwen_summary}")

    rng.shuffle(rows)
    preds = predict_batch(model, [row["image"] for row in rows], args)
    count = 0
    rejected_qwen_positive = 0
    missing_qwen = 0
    for row in rows:
        if count >= args.pulled_hard_neg:
            break
        classes, _, quality = load_qwen_label_classes(label_root, row["image_sha256"])
        coarse_classes = {qwen_class_for(item) for item in classes}
        if not classes and quality == "missing":
            missing_qwen += 1
            continue
        if qwen_target in coarse_classes:
            rejected_qwen_positive += 1
            continue
        score = score_negative(preds.get(Path(row["image"]).resolve(), []), class_id, args)
        if score["bucket"] != "hard_negative":
            continue
        source_row = {
            "image": row["image"],
            "label": "",
            "source": "pulled_low_conf_qwen_negative",
            "split": "",
        }
        if add_selected(selected, used, source_row, "hard_negative", "pulled_hard_negative", score, label_mode="empty", label_lines=[]):
            count += 1
    return {
        "requested": args.pulled_hard_neg,
        "selected": count,
        "rows": len(rows),
        "qwen": qwen_summary,
        "rejected_qwen_positive": rejected_qwen_positive,
        "missing_qwen": missing_qwen,
    }


def feedback_aliases(target_name: str, qwen_target: str) -> list[str]:
    aliases = {normalize_name(target_name), qwen_target}
    if qwen_target == "trash":
        aliases.update(["bottle", "box", "paper", "bag"])
    if qwen_target == "vehicle":
        aliases.update(["car", "truck", "bus", "van"])
    if qwen_target == "nonmotor":
        aliases.update(["bicycle", "bike", "non_motor_vehicle", "non_motorvehicle", "motorcycle", "scooter"])
    if qwen_target == "pet":
        aliases.update(["pet", "dog", "cat", "off_leash_dog"])
    return sorted(aliases)


def remap_feedback_labels(label_path: Path, class_id: int, qwen_target: str, filename_match: bool) -> list[str]:
    labels = parse_label_file(label_path)
    if not labels:
        return []
    wanted_global_id = FEEDBACK_CLASS_ID.get(qwen_target)
    remapped = []
    for item in labels:
        if wanted_global_id is not None and item["cls"] == wanted_global_id:
            parts = item["raw"].split()
            remapped.append(" ".join([str(class_id), *parts[1:5]]))
    if not remapped and filename_match:
        for item in labels:
            parts = item["raw"].split()
            remapped.append(" ".join([str(class_id), *parts[1:5]]))
    return remapped


def select_feedback_hard_positives(
    model: Any,
    class_id: int,
    target_name: str,
    qwen_target: str,
    args: argparse.Namespace,
    rng: random.Random,
    selected: list[dict[str, Any]],
    used: set[str],
) -> dict[str, Any]:
    if args.skip_feedback:
        return {"requested": args.feedback_hard_pos, "selected": 0, "skipped": True}
    image_dir = EVENT_FEEDBACK_ROOT / "images" / "review"
    label_dir = EVENT_FEEDBACK_ROOT / "labels" / "review"
    if not image_dir.exists() or not label_dir.exists():
        return {"requested": args.feedback_hard_pos, "selected": 0, "missing_root": True}

    aliases = feedback_aliases(target_name, qwen_target)
    candidates = []
    for label_path in label_dir.glob("*.txt"):
        name_norm = normalize_name(label_path.stem)
        filename_match = any(f"_{alias}_" in f"_{name_norm}_" for alias in aliases)
        if not filename_match and qwen_target not in name_norm:
            continue
        image_path = image_dir / (label_path.stem + ".jpg")
        if not image_path.exists():
            continue
        label_lines = remap_feedback_labels(label_path, class_id, qwen_target, filename_match)
        if not label_lines:
            continue
        candidates.append({
            "image": image_path.resolve(),
            "label": label_path,
            "label_lines": label_lines,
            "source": "yolo_event_feedback_v1",
            "split": "review",
            "target_labels": [
                {"cls": class_id, "xywh": [float(x) for x in line.split()[1:5]], "raw": line}
                for line in label_lines
            ],
        })
    rng.shuffle(candidates)
    scan = candidates[: min(len(candidates), max(args.feedback_hard_pos * args.scan_multiplier, args.min_feedback_scan))]
    preds = predict_batch(model, [row["image"] for row in scan], args)
    count = 0
    for row in scan:
        if count >= args.feedback_hard_pos:
            break
        score = score_positive(row, preds.get(Path(row["image"]).resolve(), []), class_id, args)
        if score["bucket"] != "hard_positive":
            continue
        if add_selected(
            selected,
            used,
            row,
            "hard_positive",
            "feedback_hard_positive",
            score,
            label_mode="override",
            label_lines=row["label_lines"],
        ):
            count += 1
    return {
        "requested": args.feedback_hard_pos,
        "selected": count,
        "candidates": len(candidates),
        "scanned": len(scan),
        "aliases": aliases,
    }


def fill_external_shortfall_from_original(
    *,
    selected: list[dict[str, Any]],
    used: set[str],
    positives: list[dict[str, Any]],
    negatives: list[dict[str, Any]],
    feedback_summary: dict[str, Any],
    pulled_summary: dict[str, Any],
    rng: random.Random,
) -> dict[str, Any]:
    filled = {"feedback_hard_positive": 0, "pulled_hard_negative": 0}
    missing_feedback = max(0, int(feedback_summary.get("requested") or 0) - int(feedback_summary.get("selected") or 0))
    missing_pulled = max(0, int(pulled_summary.get("requested") or 0) - int(pulled_summary.get("selected") or 0))
    pos_rows = positives[:]
    neg_rows = negatives[:]
    rng.shuffle(pos_rows)
    rng.shuffle(neg_rows)
    for row in pos_rows:
        if filled["feedback_hard_positive"] >= missing_feedback:
            break
        score = {"reason": "fallback_original_for_feedback_hard_positive", "target_conf": None, "max_iou": None}
        if add_selected(selected, used, row, "hard_positive", "feedback_hard_positive_fallback", score):
            filled["feedback_hard_positive"] += 1
    for row in neg_rows:
        if filled["pulled_hard_negative"] >= missing_pulled:
            break
        score = {"reason": "fallback_original_for_pulled_hard_negative", "target_conf": None, "max_iou": None}
        if add_selected(selected, used, row, "hard_negative", "pulled_hard_negative_fallback", score):
            filled["pulled_hard_negative"] += 1
    return filled


def unique_output_name(sample: dict[str, Any], idx: int) -> str:
    image = Path(sample["image"])
    digest = hashlib.sha1(str(image).encode("utf-8")).hexdigest()[:12]
    stem = re.sub(r"[^A-Za-z0-9_.-]+", "_", image.stem)[:80]
    return f"{idx:06d}_{sample['source_bucket']}_{stem}_{digest}{image.suffix.lower() or '.jpg'}"


def write_dataset(
    selected: list[dict[str, Any]],
    data_yaml: Path,
    dataset_dir: Path,
    args: argparse.Namespace,
    rng: random.Random,
) -> dict[str, Any]:
    source_data = read_yaml(data_yaml)
    if dataset_dir.exists():
        shutil.rmtree(dataset_dir)
    for split in ("train", "val", "test"):
        (dataset_dir / "images" / split).mkdir(parents=True, exist_ok=True)
        (dataset_dir / "labels" / split).mkdir(parents=True, exist_ok=True)

    shuffled = selected[:]
    rng.shuffle(shuffled)
    manifest_rows = []
    split_counts = {"train": 0, "val": 0, "test": 0}
    category_counts: dict[str, int] = {}
    source_counts: dict[str, int] = {}
    for idx, sample in enumerate(shuffled, 1):
        ratio = idx / max(1, len(shuffled))
        split = "train"
        if ratio > 0.95:
            split = "test"
        elif ratio > 0.85:
            split = "val"
        out_name = unique_output_name(sample, idx)
        src_image = Path(sample["image"])
        dst_image = dataset_dir / "images" / split / out_name
        hardlink_or_copy(src_image, dst_image)
        dst_label = (dataset_dir / "labels" / split / out_name).with_suffix(".txt")
        mode = sample.get("label_mode")
        lines = sample.get("label_lines")
        if mode == "empty":
            dst_label.write_text("", encoding="utf-8")
        elif mode == "override" and lines is not None:
            dst_label.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
        else:
            src_label = Path(sample.get("label") or "")
            if src_label.exists():
                shutil.copy2(src_label, dst_label)
            else:
                dst_label.write_text("", encoding="utf-8")
        split_counts[split] += 1
        category_counts[sample["category"]] = category_counts.get(sample["category"], 0) + 1
        source_counts[sample["source_bucket"]] = source_counts.get(sample["source_bucket"], 0) + 1
        row = dict(sample)
        row.update({"dataset_image": str(dst_image), "dataset_label": str(dst_label), "dataset_split": split})
        row.pop("label_lines", None)
        manifest_rows.append(row)

    out_data = {
        "path": str(dataset_dir),
        "train": "images/train",
        "val": "images/val",
        "test": "images/test",
        "names": source_data.get("names"),
    }
    if "nc" in source_data:
        out_data["nc"] = source_data["nc"]
    data_out = dataset_dir / "data.yaml"
    data_out.write_text(yaml.safe_dump(out_data, sort_keys=False, allow_unicode=True), encoding="utf-8")
    manifest_path = dataset_dir / "samples_manifest.jsonl"
    with manifest_path.open("w", encoding="utf-8") as handle:
        for row in manifest_rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    return {
        "dataset_dir": str(dataset_dir),
        "data_yaml": str(data_out),
        "samples": len(selected),
        "split_counts": split_counts,
        "category_counts": category_counts,
        "source_counts": source_counts,
        "manifest": str(manifest_path),
    }


def make_a100_job(
    *,
    run_tag: str,
    task_id: str,
    target_name: str,
    local_dataset: Path,
    remote_dataset: str,
    remote_data_yaml: str,
    remote_weight: str,
    args: argparse.Namespace,
    run_dir: Path,
) -> Path:
    remote_log = f"{A100_ROOT}/logs/{task_id}_{target_name}_{run_tag}.log"
    project = f"{A100_ROOT}/runs/{task_id}"
    out = f"{A100_ROOT}/results/{task_id}_{target_name}_{run_tag}"
    alias = f"{run_tag}_{task_id}_{target_name}"
    lines = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        f"ROOT={shlex.quote(A100_ROOT)}",
        "cd \"$ROOT\"",
        "mkdir -p logs results runs scripts",
        f"python3 - <<'PY'",
        "from pathlib import Path",
        f"p = Path({remote_data_yaml!r})",
        f"remote_dataset = {remote_dataset!r}",
        "lines = p.read_text(encoding='utf-8').splitlines()",
        "out = []",
        "for line in lines:",
        "    if line.startswith('path:'):",
        "        out.append('path: ' + remote_dataset)",
        "    else:",
        "        out.append(line)",
        "p.write_text('\\n'.join(out) + '\\n', encoding='utf-8')",
        "PY",
        f"echo \"$(date -Is) finetune_start task={task_id} class={target_name} data={remote_data_yaml}\" | tee -a {shlex.quote(remote_log)}",
        f"CUDA_VISIBLE_DEVICES={args.a100_gpu} \\",
        f"RELIABLE_YOLO_TASK={shlex.quote(task_id + '_' + target_name + '_finetune')} \\",
        f"RELIABLE_YOLO_RUN_TAG={shlex.quote(run_tag)} \\",
        f"RELIABLE_YOLO_DATA={shlex.quote(remote_data_yaml)} \\",
        f"RELIABLE_YOLO_OUT={shlex.quote(out)} \\",
        f"RELIABLE_YOLO_PROJECT={shlex.quote(project)} \\",
        f"RELIABLE_YOLO_BASE_WEIGHTS={shlex.quote(alias + '=' + remote_weight)} \\",
        f"RELIABLE_YOLO_EPOCHS={args.epochs} \\",
        f"RELIABLE_YOLO_PATIENCE={args.patience} \\",
        f"RELIABLE_YOLO_BATCH={args.batch} \\",
        f"RELIABLE_YOLO_IMGSZ={args.imgsz} \\",
        f"RELIABLE_YOLO_WORKERS={args.workers} \\",
        f"{shlex.quote(A100_PY)} scripts/train_reliable_yolo_finetune.py 2>&1 | tee -a {shlex.quote(remote_log)}",
        f"echo \"$(date -Is) finetune_done task={task_id} class={target_name}\" | tee -a {shlex.quote(remote_log)}",
    ]
    job = run_dir / f"{run_tag}.a100_finetune.sh"
    job.write_text("\n".join(lines) + "\n", encoding="utf-8")
    job.chmod(0o755)
    return job


def schedule_training(
    *,
    model_info: ModelInfo,
    target_name: str,
    dataset_summary: dict[str, Any],
    run_tag: str,
    run_dir: Path,
    args: argparse.Namespace,
) -> dict[str, Any]:
    if args.skip_train or args.dry_run:
        return {"skipped": True}
    local_dataset = Path(dataset_summary["dataset_dir"])
    remote_dataset = f"{A100_ROOT}/datasets/{run_tag}/{local_dataset.name}"
    remote_data_yaml = f"{remote_dataset}/data.yaml"
    remote_weight = f"{A100_ROOT}/weights/{run_tag}_{model_info.weight.name}"
    a100(
        f"mkdir -p {shlex.quote(A100_ROOT)}/scripts {shlex.quote(A100_ROOT)}/weights "
        f"{shlex.quote(A100_ROOT)}/datasets/{shlex.quote(run_tag)} {shlex.quote(A100_ROOT)}/logs",
        check=True,
    )
    rsync_to_a100(TRAIN_SCRIPT, f"{A100_ROOT}/scripts/train_reliable_yolo_finetune.py")
    if POLICY_SCRIPT.exists():
        rsync_to_a100(POLICY_SCRIPT, f"{A100_ROOT}/scripts/yolo_closed_loop_policy.py")
    rsync_to_a100(model_info.weight, remote_weight, timeout=1800)
    rsync_to_a100(local_dataset, remote_dataset, timeout=3600)
    job = make_a100_job(
        run_tag=run_tag,
        task_id=model_info.task_id,
        target_name=target_name,
        local_dataset=local_dataset,
        remote_dataset=remote_dataset,
        remote_data_yaml=remote_data_yaml,
        remote_weight=remote_weight,
        args=args,
        run_dir=run_dir,
    )
    remote_job = f"{A100_ROOT}/logs/{job.name}"
    rsync_to_a100(job, remote_job)
    session = f"yolo-finetune-gpu{args.a100_gpu}-{run_tag}"
    a100(f"tmux new-session -d -s {shlex.quote(session)} 'bash {shlex.quote(remote_job)}'", check=True)
    return {
        "session": session,
        "remote_dataset": remote_dataset,
        "remote_weight": remote_weight,
        "remote_job": remote_job,
        "remote_log": f"{A100_ROOT}/logs/{model_info.task_id}_{target_name}_{run_tag}.log",
    }


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Build a target-class YOLO finetune dataset and schedule <=10 epoch finetuning.")
    parser.add_argument("--model", required=True, help="Current registry model name, e.g. trash_yolo.")
    parser.add_argument("--class-id", type=int, required=True, help="Target class id in the model training dataset.")
    parser.add_argument("--target-name", default="", help="Override class name resolved from data.yaml.")
    parser.add_argument("--qwen-class", default="", help="Override coarse class used for Qwen positive/negative judgement.")
    parser.add_argument("--run-tag", default="", help="Override run tag.")
    parser.add_argument("--seed", type=int, default=20260720)
    parser.add_argument("--resolve-only", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--skip-train", action="store_true")
    parser.add_argument("--skip-pull", action="store_true")
    parser.add_argument("--skip-qwen", action="store_true")
    parser.add_argument("--skip-feedback", action="store_true")
    parser.add_argument("--allow-qwen-failure", action="store_true")

    parser.add_argument("--original-normal-pos", type=int, default=1000)
    parser.add_argument("--original-hard-pos", type=int, default=150)
    parser.add_argument("--original-normal-neg", type=int, default=400)
    parser.add_argument("--original-hard-neg", type=int, default=100)
    parser.add_argument("--pulled-hard-neg", type=int, default=200)
    parser.add_argument("--feedback-hard-pos", type=int, default=150)

    parser.add_argument("--pull-limit", type=int, default=1000)
    parser.add_argument("--pull-lookback-days", type=int, default=7)
    parser.add_argument("--pull-fallback-days", type=int, default=30)
    parser.add_argument("--pull-min-conf", type=float, default=0.0)
    parser.add_argument("--pull-max-conf", type=float, default=0.5)
    parser.add_argument("--pull-timeout", type=int, default=3600)
    parser.add_argument("--pull-retries", type=int, default=3)
    parser.add_argument("--pull-retry-sleep", type=float, default=10.0)
    parser.add_argument(
        "--pull-script",
        type=Path,
        default=PULL_SCRIPT,
        help="Low-confidence image pull helper. Defaults to the Python 3.6 compatible script when present.",
    )
    parser.add_argument(
        "--pull-ssh-key",
        type=Path,
        default=PULL_SSH_KEY,
        help="SSH identity file for the remote data source pull helper. Use an empty path plus --pull-ssh-option to override.",
    )
    parser.add_argument(
        "--pull-ssh-option",
        action="append",
        default=[],
        help="Extra --ssh-option passed through to the pull helper. Repeat for multiple options.",
    )

    parser.add_argument("--predict-conf-floor", type=float, default=0.001)
    parser.add_argument("--predict-nms-iou", type=float, default=0.7)
    parser.add_argument("--pos-iou-threshold", type=float, default=0.5)
    parser.add_argument("--normal-pos-min-conf", type=float, default=0.5)
    parser.add_argument("--hard-neg-min-conf", type=float, default=0.25)
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--infer-device", default="0")
    parser.add_argument("--infer-batch", type=int, default=16)
    parser.add_argument("--infer-chunk-size", type=int, default=256)
    parser.add_argument("--scan-multiplier", type=int, default=8)
    parser.add_argument("--min-positive-scan", type=int, default=3000)
    parser.add_argument("--min-negative-scan", type=int, default=2000)
    parser.add_argument("--min-feedback-scan", type=int, default=800)

    parser.add_argument("--qwen-service-url", default="http://127.0.0.1:18016")
    parser.add_argument("--qwen-workers", type=int, default=2)
    parser.add_argument("--qwen-max-side", type=int, default=960)
    parser.add_argument("--qwen-jpeg-quality", type=int, default=82)
    parser.add_argument("--qwen-timeout-s", type=int, default=120)
    parser.add_argument("--qwen-max-tokens", type=int, default=768)

    parser.add_argument("--epochs", type=int, default=8)
    parser.add_argument("--patience", type=int, default=3)
    parser.add_argument("--batch", type=int, default=32)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--a100-gpu", type=int, default=int(os.environ.get("YOLO_FINETUNE_A100_GPU", "3")))
    return parser


def main() -> None:
    args = build_arg_parser().parse_args()
    if args.epochs < 1 or args.epochs > 10:
        raise SystemExit("--epochs must be in [1, 10].")
    if args.class_id < 0:
        raise SystemExit("--class-id must be >= 0.")
    if args.pull_retries < 1:
        raise SystemExit("--pull-retries must be >= 1.")

    model_info = resolve_model(args.model)
    if model_info.task != "detect":
        raise SystemExit(f"unsupported_task:{model_info.task}; this script handles detect datasets because hard samples need boxes and IoU.")

    names = names_from_data(model_info.data)
    if args.class_id >= len(names):
        raise SystemExit(f"class_id_out_of_range:{args.class_id}; names={names}")
    target_name = args.target_name or names[args.class_id]
    qwen_target = normalize_name(args.qwen_class or qwen_class_for(target_name))
    run_tag = args.run_tag or f"{cn_now().strftime('%Y%m%d_%H%M%S')}_{model_info.task_id}_c{args.class_id}_{normalize_name(target_name)}"
    run_dir = FINETUNE_ROOT / "runs" / run_tag
    run_dir.mkdir(parents=True, exist_ok=True)

    resolved = {
        "model": args.model,
        "task_id": model_info.task_id,
        "title": model_info.title,
        "task": model_info.task,
        "weight": str(model_info.weight),
        "data": str(model_info.data),
        "data_source": model_info.data_source,
        "class_id": args.class_id,
        "class_name": target_name,
        "qwen_class": qwen_target,
        "run_tag": run_tag,
        "run_dir": str(run_dir),
        "pull_script": str(args.pull_script),
        "pull_ssh_key": str(args.pull_ssh_key),
        "pull_ssh_options": pull_ssh_args(args),
        "pull_retries": args.pull_retries,
        "pull_retry_sleep": args.pull_retry_sleep,
    }
    write_json(run_dir / "resolved_model.json", resolved)
    print(json.dumps(resolved, ensure_ascii=False, indent=2), flush=True)
    if args.resolve_only:
        return

    positives, negatives = collect_dataset_records(model_info.data, args.class_id)
    availability = {
        "original_positive_images": len(positives),
        "original_negative_images": len(negatives),
    }
    write_json(run_dir / "availability.json", availability)
    if args.dry_run:
        print(json.dumps({"resolved": resolved, "availability": availability}, ensure_ascii=False, indent=2), flush=True)
        return

    rng = random.Random(args.seed)
    model = load_yolo(model_info.weight)
    selected: list[dict[str, Any]] = []
    used: set[str] = set()

    original_summary = select_original_samples(model, positives, negatives, args.class_id, args, rng, selected, used)
    feedback_summary = select_feedback_hard_positives(model, args.class_id, target_name, qwen_target, args, rng, selected, used)
    pull_dir, pull_summary = pull_low_conf_images(target_name, run_dir, args)
    pulled_summary = select_pulled_hard_negatives(model, args.class_id, qwen_target, pull_dir, run_dir, args, rng, selected, used)
    fallback_summary = fill_external_shortfall_from_original(
        selected=selected,
        used=used,
        positives=positives,
        negatives=negatives,
        feedback_summary=feedback_summary,
        pulled_summary=pulled_summary,
        rng=rng,
    )

    dataset_dir = FINETUNE_RUNTIME / "datasets" / run_tag / f"{model_info.task_id}_c{args.class_id}_{normalize_name(target_name)}_finetune"
    dataset_summary = write_dataset(selected, model_info.data, dataset_dir, args, rng)
    thresholds = {
        "predict_conf_floor": args.predict_conf_floor,
        "predict_nms_iou": args.predict_nms_iou,
        "pos_iou_threshold": args.pos_iou_threshold,
        "normal_pos_min_conf": args.normal_pos_min_conf,
        "hard_neg_min_conf": args.hard_neg_min_conf,
    }
    summary = {
        "schema": "jgzj_yolo_target_finetune.v1",
        "created_at": cn_now().isoformat(),
        "resolved": resolved,
        "availability": availability,
        "thresholds": thresholds,
        "requested": {
            "original_normal_positive": args.original_normal_pos,
            "original_hard_positive": args.original_hard_pos,
            "feedback_hard_positive": args.feedback_hard_pos,
            "original_normal_negative": args.original_normal_neg,
            "original_hard_negative": args.original_hard_neg,
            "pulled_hard_negative": args.pulled_hard_neg,
        },
        "selection": {
            "original": original_summary,
            "feedback_hard_positive": feedback_summary,
            "pull_low_conf": pull_summary,
            "pulled_hard_negative": pulled_summary,
            "external_shortfall_fallback": fallback_summary,
        },
        "dataset": dataset_summary,
    }
    training_summary = schedule_training(
        model_info=model_info,
        target_name=normalize_name(target_name),
        dataset_summary=dataset_summary,
        run_tag=run_tag,
        run_dir=run_dir,
        args=args,
    )
    summary["training"] = training_summary
    write_json(run_dir / "selection_log.json", summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
