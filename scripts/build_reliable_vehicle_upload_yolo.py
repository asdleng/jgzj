#!/usr/bin/env python3
from __future__ import annotations
import argparse
import collections
import hashlib
import json
import os
import shutil
from pathlib import Path

from yolo_closed_loop_policy import (
    EXPECTED_AUDIT_PROMPT_VERSION,
    PATROL_DATASET_ID,
    effective_labels,
    load_manual_annotations,
    training_row_decision,
)


IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
DEFAULT_QUALITIES = {"good", "blur"}


TASKS = {
    "person": {
        "names": ["person"],
        "class_map": {"person": 0},
        "min_conf": 0.55,
        "min_w": 0.003,
        "min_h": 0.010,
        "max_w": 0.70,
        "max_h": 0.98,
        "max_area": 0.45,
    },
    "vehicle": {
        "names": ["car", "truck", "non_motor_vehicle"],
        "class_map": {"vehicle": 0, "nonmotor": 2},
        "min_conf": 0.55,
        "min_w": 0.006,
        "min_h": 0.006,
        "max_w": 0.90,
        "max_h": 0.90,
        "max_area": 0.70,
    },
    "pet": {
        "names": ["pet"],
        "class_map": {"pet": 0},
        "min_conf": 0.55,
        "min_w": 0.004,
        "min_h": 0.004,
        "max_w": 0.80,
        "max_h": 0.80,
        "max_area": 0.50,
    },
    "phone": {
        "names": ["phone"],
        "class_map": {"phone": 0},
        "min_conf": 0.55,
        "min_w": 0.003,
        "min_h": 0.003,
        "max_w": 0.60,
        "max_h": 0.60,
        "max_area": 0.30,
    },
    "trash": {
        "names": ["trash"],
        "class_map": {"trash": 0},
        "min_conf": 0.50,
        "min_w": 0.003,
        "min_h": 0.003,
        "max_w": 0.75,
        "max_h": 0.75,
        "max_area": 0.45,
    },
    "stall": {
        "names": ["stall"],
        "class_map": {"stall": 0},
        "min_conf": 0.50,
        "min_w": 0.010,
        "min_h": 0.010,
        "max_w": 0.98,
        "max_h": 0.98,
        "max_area": 0.80,
    },
    "fire_smoke": {
        "names": ["fire", "smoke"],
        "class_map": {"fire": 0, "smoke": 1},
        "min_conf": 0.50,
        "min_w": 0.003,
        "min_h": 0.003,
        "max_w": 0.85,
        "max_h": 0.85,
        "max_area": 0.60,
    },
}


def load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def split_for_key(key: str, val_ratio: float, test_ratio: float) -> str:
    value = int(hashlib.sha1(key.encode("utf-8")).hexdigest()[:8], 16) / 0xFFFFFFFF
    if value < test_ratio:
        return "test"
    if value < test_ratio + val_ratio:
        return "val"
    return "train"


def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def link_or_copy(src: Path, dst: Path, mode: str) -> str:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists() or dst.is_symlink():
        return "exists"
    if mode == "copy":
        shutil.copy2(src, dst)
        return "copy"
    try:
        os.symlink(src, dst)
        return "symlink"
    except OSError:
        try:
            os.link(src, dst)
            return "hardlink"
        except OSError:
            shutil.copy2(src, dst)
            return "copy"


def normalize_label(label: dict, task_cfg: dict):
    class_name = str(label.get("class_name") or label.get("class") or label.get("label") or "").strip().lower()
    if class_name not in task_cfg["class_map"]:
        return None
    try:
        raw_conf = label.get("confidence", 1.0)
        conf = 1.0 if raw_conf is None or str(raw_conf).strip().lower() in {"", "none", "null"} else float(raw_conf)
        x = float(label.get("x"))
        y = float(label.get("y"))
        w = float(label.get("w"))
        h = float(label.get("h"))
    except Exception:
        return None
    if conf < task_cfg["min_conf"]:
        return None
    if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0):
        return None
    if w < task_cfg["min_w"] or h < task_cfg["min_h"]:
        return None
    if w > task_cfg["max_w"] or h > task_cfg["max_h"] or w * h > task_cfg["max_area"]:
        return None
    x1 = clamp(x - w / 2.0)
    y1 = clamp(y - h / 2.0)
    x2 = clamp(x + w / 2.0)
    y2 = clamp(y + h / 2.0)
    w2 = x2 - x1
    h2 = y2 - y1
    if w2 < task_cfg["min_w"] or h2 < task_cfg["min_h"]:
        return None
    cls = task_cfg["class_map"][class_name]
    return cls, (x1 + x2) / 2.0, (y1 + y2) / 2.0, w2, h2, conf, class_name


def xywh_to_xyxy(box):
    _, x, y, w, h, conf, _ = box
    return x - w / 2, y - h / 2, x + w / 2, y + h / 2, conf


def iou(a, b) -> float:
    ax1, ay1, ax2, ay2, _ = xywh_to_xyxy(a)
    bx1, by1, bx2, by2, _ = xywh_to_xyxy(b)
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    denom = area_a + area_b - inter
    return inter / denom if denom > 0 else 0.0


def nms_boxes(boxes, threshold: float):
    by_class = collections.defaultdict(list)
    for box in boxes:
        by_class[box[0]].append(box)
    kept = []
    for cls_boxes in by_class.values():
        for box in sorted(cls_boxes, key=lambda item: item[5], reverse=True):
            if all(iou(box, old) < threshold for old in kept if old[0] == box[0]):
                kept.append(box)
    return kept


def stable_sample_key(seed: str, value: str) -> str:
    return hashlib.sha1(f"{seed}\0{value}".encode("utf-8")).hexdigest()


def image_date(row: dict) -> str:
    rel = str(row.get("image_rel_path") or "")
    return rel.split("/", 1)[0] if "/" in rel else ""


def include_row(row: dict, args, qualities: set[str], manual_annotations: dict[str, dict]) -> tuple[bool, str, dict | None]:
    if args.dates:
        day = image_date(row)
        if day not in args.dates:
            return False, "date", None
    return training_row_decision(row, manual_annotations, source=args.source, qualities=qualities)


def add_existing_dataset(output: Path, dataset_yaml: Path, stats: dict, mode: str, existing_mode: str, image_lists: dict) -> None:
    import yaml

    data = yaml.safe_load(dataset_yaml.read_text(encoding="utf-8"))
    root = Path(data.get("path") or dataset_yaml.parent).expanduser()
    if not root.is_absolute():
        root = (dataset_yaml.parent / root).resolve()
    for split in ("train", "val", "test"):
        spec = data.get(split)
        if not spec:
            continue
        paths = []
        spec_path = Path(str(spec))
        if spec_path.suffix == ".txt":
            list_path = spec_path if spec_path.is_absolute() else root / spec_path
            paths = [Path(x.strip()) for x in list_path.read_text(encoding="utf-8").splitlines() if x.strip()]
        else:
            img_dir = spec_path if spec_path.is_absolute() else root / spec_path
            for suffix in IMAGE_SUFFIXES:
                paths.extend(img_dir.glob(f"*{suffix}"))
        for image_path in paths:
            if not image_path.exists() or image_path.suffix.lower() not in IMAGE_SUFFIXES:
                stats["skipped_existing_missing_image"] += 1
                continue
            src_text = str(image_path)
            label_path = Path(src_text.replace("/images/", "/labels/")).with_suffix(".txt")
            if not label_path.exists():
                stats["skipped_existing_missing_label"] += 1
                continue
            if existing_mode == "list":
                action = "list"
                dst_label = label_path
                image_lists[split].append(str(image_path.resolve()))
            else:
                name_key = hashlib.sha1(src_text.encode("utf-8")).hexdigest()[:14]
                dst_image = output / "images" / split / f"base_{name_key}{image_path.suffix.lower()}"
                dst_label = output / "labels" / split / f"base_{name_key}.txt"
                action = link_or_copy(image_path, dst_image, mode)
                dst_label.parent.mkdir(parents=True, exist_ok=True)
                if not dst_label.exists():
                    shutil.copy2(label_path, dst_label)
                image_lists[split].append(str(dst_image))
            n = sum(1 for line in dst_label.read_text(encoding="utf-8").splitlines() if line.strip())
            stats["splits"][split]["images"] += 1
            stats["splits"][split]["labels"] += 1
            stats["splits"][split]["boxes"] += n
            stats["splits"][split]["positive_images" if n else "empty_images"] += 1
            stats["link_counts"][action] += 1
            stats["existing_images"] += 1


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--task", choices=sorted(TASKS), required=True)
    parser.add_argument("--index", type=Path, required=True)
    parser.add_argument("--frames-root", type=Path, required=True)
    parser.add_argument("--label-root", type=Path, required=True)
    parser.add_argument("--manual-root", type=Path)
    parser.add_argument("--patrol-dataset-id", default=PATROL_DATASET_ID)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source", default="auto_ad_patrol_flow_upload")
    parser.add_argument("--dates", nargs="*", default=[])
    parser.add_argument("--qualities", default="good,blur")
    parser.add_argument("--existing-data", type=Path)
    parser.add_argument("--existing-mode", choices=["materialize", "list"], default="materialize")
    parser.add_argument("--data-yaml-mode", choices=["dirs", "list"], default="dirs")
    parser.add_argument("--link-mode", choices=["symlink", "hardlink", "copy"], default="symlink")
    parser.add_argument("--val-ratio", type=float, default=0.10)
    parser.add_argument("--test-ratio", type=float, default=0.10)
    parser.add_argument("--nms-iou", type=float, default=0.72)
    parser.add_argument("--include-empty", action="store_true")
    parser.add_argument("--empty-to-positive-ratio", type=float, default=-1.0)
    parser.add_argument("--max-empty-images", type=int, default=-1)
    parser.add_argument("--empty-sample-seed", default="")
    args = parser.parse_args()

    task_cfg = TASKS[args.task]
    qualities = {x.strip() for x in args.qualities.split(",") if x.strip()}
    manual_root = args.manual_root or args.label_root / "manual_annotations_v1"
    manual_annotations = load_manual_annotations(manual_root, args.patrol_dataset_id)
    output = args.output.resolve()
    for split in ("train", "val", "test"):
        (output / "images" / split).mkdir(parents=True, exist_ok=True)
        (output / "labels" / split).mkdir(parents=True, exist_ok=True)

    image_lists = {split: [] for split in ("train", "val", "test")}
    stats = {
        "schema": "jgzj_reliable_vehicle_upload_yolo.v1",
        "task": args.task,
        "names": task_cfg["names"],
        "class_map": task_cfg["class_map"],
        "index": str(args.index.resolve()),
        "frames_root": str(args.frames_root.resolve()),
        "label_root": str(args.label_root.resolve()),
        "manual_root": str(manual_root.resolve()),
        "output": str(output),
        "filters": {
            "source": args.source,
            "dates": args.dates,
            "qualities": sorted(qualities),
            "manual_annotations": "preferred",
            "qwen_audit": "review_queue_only",
            "training_release": "manual_annotation_required",
            "qwen_audit_prompt_version": EXPECTED_AUDIT_PROMPT_VERSION,
            "include_empty": args.include_empty,
            "empty_to_positive_ratio": args.empty_to_positive_ratio,
            "max_empty_images": args.max_empty_images,
            "empty_sample_seed": args.empty_sample_seed,
            "min_conf": task_cfg["min_conf"],
            "nms_iou": args.nms_iou,
        },
        "splits": {
            split: collections.Counter({"images": 0, "labels": 0, "positive_images": 0, "empty_images": 0, "boxes": 0})
            for split in ("train", "val", "test")
        },
        "link_counts": collections.Counter(),
        "review_sources": collections.Counter(),
        "boxes_by_class": collections.Counter(),
        "rows_seen": 0,
        "rows_included": 0,
        "rows_candidate_positive": 0,
        "rows_candidate_empty": 0,
        "rows_sampled_empty": 0,
        "rows_skipped": collections.Counter(),
        "existing_images": 0,
    }

    if args.existing_data:
        add_existing_dataset(output, args.existing_data, stats, args.link_mode, args.existing_mode, image_lists)

    index = load_json(args.index)
    if not isinstance(index, dict):
        raise SystemExit(f"bad_index:{args.index}")
    rows = index.get("rows") or []
    candidates = []
    manifest = []
    for row_idx, row in enumerate(rows):
        stats["rows_seen"] += 1
        ok, reason, manual = include_row(row, args, qualities, manual_annotations)
        if not ok:
            stats["rows_skipped"][reason] += 1
            continue
        stats["review_sources"][reason] += 1
        label_path = Path(str(manual.get("_annotation_path"))) if manual else args.label_root / str(row.get("qwen_bbox_rel_path"))
        image_path = args.frames_root / str(row.get("image_rel_path"))
        if not label_path.exists():
            stats["rows_skipped"]["label_missing"] += 1
            continue
        if not image_path.exists() or image_path.suffix.lower() not in IMAGE_SUFFIXES:
            stats["rows_skipped"]["image_missing"] += 1
            continue
        boxes = []
        for label in effective_labels(row, manual):
            box = normalize_label(label, task_cfg)
            if box is not None:
                boxes.append(box)
        kept = nms_boxes(boxes, args.nms_iou)
        if not kept and not args.include_empty:
            stats["rows_skipped"]["empty_for_task"] += 1
            continue
        meta = row.get("meta") if isinstance(row.get("meta"), dict) else {}
        image_sha = str(meta.get("image_sha256") or (manual or {}).get("image_sha256") or label_path.stem)
        split = split_for_key(image_sha, args.val_ratio, args.test_ratio)
        dst_stem = f"vehqwen_{image_sha[:16]}"
        candidates.append({
            "row_idx": row_idx,
            "row": row,
            "image_path": image_path,
            "label_path": label_path,
            "image_sha": image_sha,
            "split": split,
            "dst_stem": dst_stem,
            "kept": kept,
            "review_source": reason,
        })

    positives = [item for item in candidates if item["kept"]]
    empties = [item for item in candidates if not item["kept"]]
    stats["rows_candidate_positive"] = len(positives)
    stats["rows_candidate_empty"] = len(empties)
    sampled_empties = empties
    if args.include_empty and empties:
        limits = []
        if args.empty_to_positive_ratio >= 0:
            limits.append(int(len(positives) * args.empty_to_positive_ratio))
        if args.max_empty_images >= 0:
            limits.append(args.max_empty_images)
        if limits:
            empty_limit = max(0, min(len(empties), *limits))
            if empty_limit < len(empties):
                seed = args.empty_sample_seed or f"{args.task}:{','.join(args.dates)}"
                sampled_empties = sorted(
                    empties,
                    key=lambda item: stable_sample_key(seed, item["image_sha"]),
                )[:empty_limit]
                stats["rows_skipped"]["empty_sample_cap"] = len(empties) - len(sampled_empties)
    selected = sorted(positives + sampled_empties, key=lambda item: item["row_idx"])
    stats["rows_sampled_empty"] = len(sampled_empties)

    for item in selected:
        row = item["row"]
        image_path = item["image_path"]
        label_path = item["label_path"]
        image_sha = item["image_sha"]
        split = item["split"]
        dst_stem = item["dst_stem"]
        kept = item["kept"]
        review_source = item["review_source"]
        dst_image = output / "images" / split / f"{dst_stem}{image_path.suffix.lower()}"
        dst_label = output / "labels" / split / f"{dst_stem}.txt"
        action = link_or_copy(image_path, dst_image, args.link_mode)
        lines = [f"{cls} {x:.8f} {y:.8f} {w:.8f} {h:.8f}" for cls, x, y, w, h, _, _ in kept]
        dst_label.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
        image_lists[split].append(str(dst_image))
        stats["rows_included"] += 1
        stats["splits"][split]["images"] += 1
        stats["splits"][split]["labels"] += 1
        stats["splits"][split]["boxes"] += len(kept)
        stats["splits"][split]["positive_images" if kept else "empty_images"] += 1
        stats["link_counts"][action] += 1
        for box in kept:
            stats["boxes_by_class"][task_cfg["names"][box[0]]] += 1
        manifest.append({
            "split": split,
            "image": str(dst_image),
            "label": str(dst_label),
            "source_image": str(image_path),
            "source_label": str(label_path),
            "image_sha256": image_sha,
            "classes": [box[-1] for box in kept],
            "boxes": len(kept),
            "date": image_date(row),
            "quality": row.get("qwen_bbox_quality"),
            "audit_verdict": row.get("qwen_bbox_audit_verdict") or "",
            "review_source": review_source,
        })

    names_yaml = "\n".join(f"  {i}: {name}" for i, name in enumerate(task_cfg["names"]))
    if args.data_yaml_mode == "list":
        for split, paths in image_lists.items():
            (output / f"{split}.txt").write_text("\n".join(paths) + ("\n" if paths else ""), encoding="utf-8")
        train_spec, val_spec, test_spec = "train.txt", "val.txt", "test.txt"
    else:
        train_spec, val_spec, test_spec = "images/train", "images/val", "images/test"
    (output / "data.yaml").write_text(
        "\n".join([
            f"path: {output}",
            f"train: {train_spec}",
            f"val: {val_spec}",
            f"test: {test_spec}",
            f"nc: {len(task_cfg['names'])}",
            "names:",
            names_yaml,
            "",
        ]),
        encoding="utf-8",
    )
    serializable = dict(stats)
    serializable["splits"] = {k: dict(v) for k, v in stats["splits"].items()}
    serializable["link_counts"] = dict(stats["link_counts"])
    serializable["review_sources"] = dict(stats["review_sources"])
    serializable["boxes_by_class"] = dict(stats["boxes_by_class"])
    serializable["rows_skipped"] = dict(stats["rows_skipped"])
    (output / "dataset_summary.json").write_text(json.dumps(serializable, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (output / "manifest.jsonl").write_text("".join(json.dumps(x, ensure_ascii=False) + "\n" for x in manifest), encoding="utf-8")
    print(json.dumps(serializable, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
