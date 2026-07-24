#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shutil
import time
from collections import Counter
from pathlib import Path
from typing import Iterator, Sequence


CLASSES = ["fire", "smoke"]


def now_id() -> str:
    return time.strftime("%Y%m%d_%H%M%S")


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Remove empty-label samples from finetune_v2.")
    parser.add_argument(
        "--dataset",
        type=Path,
        default=Path("/home/admin1/jgzj/.runtime/yolo_loop/datasets/finetune_v2"),
    )
    return parser.parse_args()


def iter_jsonl(path: Path) -> Iterator[dict]:
    with path.open("r", encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, 1):
            text = line.strip()
            if not text:
                continue
            row = json.loads(text)
            row["_line_no"] = line_no
            yield row


def write_json_atomic(path: Path, payload: dict) -> None:
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{int(time.time())}.tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.replace(tmp, path)


def write_jsonl_atomic(path: Path, rows: Sequence[dict]) -> None:
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{int(time.time())}.tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        for row in rows:
            public = {key: value for key, value in row.items() if not key.startswith("_")}
            handle.write(json.dumps(public, ensure_ascii=False, separators=(",", ":")) + "\n")
    os.replace(tmp, path)


def resolve_dataset_path(dataset: Path, value: object) -> Path:
    path = Path(str(value or ""))
    return path if path.is_absolute() else dataset / path


def non_empty_label_lines(path: Path) -> list[str]:
    if not path.exists():
        return []
    return [line.strip() for line in path.read_text(encoding="utf-8", errors="ignore").splitlines() if line.strip()]


def move_to_quarantine(dataset: Path, quarantine: Path, path: Path) -> str:
    if not path.exists():
        return ""
    try:
        rel = path.resolve().relative_to(dataset.resolve())
    except ValueError:
        rel = Path(path.name)
    dest = quarantine / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        dest = dest.with_name(f"{dest.stem}.{int(time.time())}{dest.suffix}")
    shutil.move(path.as_posix(), dest.as_posix())
    return dest.as_posix()


def recalculate_summary(dataset: Path, old_summary: dict, kept_rows: Sequence[dict]) -> dict:
    split_images = Counter()
    positive_images = Counter()
    negative_images = Counter()
    boxes_by_split = Counter()
    boxes_by_class = Counter()
    images_by_class = Counter()

    for row in kept_rows:
        split = str(row.get("split") or "train")
        label_path = resolve_dataset_path(dataset, row.get("label"))
        lines = non_empty_label_lines(label_path)
        split_images[split] += 1
        if lines:
            positive_images[split] += 1
        else:
            negative_images[split] += 1
        classes_in_image = set()
        for line in lines:
            parts = line.split()
            if len(parts) < 5:
                continue
            try:
                cls_id = int(float(parts[0]))
            except ValueError:
                continue
            if 0 <= cls_id < len(CLASSES):
                class_name = CLASSES[cls_id]
            else:
                class_name = str(cls_id)
            boxes_by_split[split] += 1
            boxes_by_class[class_name] += 1
            classes_in_image.add(class_name)
        for class_name in classes_in_image:
            images_by_class[class_name] += 1

    summary = dict(old_summary)
    summary["updated_at"] = now_iso()
    summary["images"] = {split: split_images.get(split, 0) for split in ("train", "val", "test") if split_images.get(split, 0)}
    summary["positive_images"] = {split: positive_images.get(split, 0) for split in ("train", "val", "test") if positive_images.get(split, 0)}
    summary["negative_images"] = {split: negative_images.get(split, 0) for split in ("train", "val", "test") if negative_images.get(split, 0)}
    summary["boxes"] = {split: boxes_by_split.get(split, 0) for split in ("train", "val", "test") if boxes_by_split.get(split, 0)}
    summary["boxes_by_class"] = dict(boxes_by_class)
    summary["answers"] = {"YES": sum(positive_images.values()), "NO": sum(negative_images.values()), "NULL": 0}
    summary["by_class_yes"] = dict(images_by_class)
    summary["total_images"] = len(kept_rows)
    stats = dict(summary.get("stats") or {})
    stats.update({
        "fire_images": images_by_class.get("fire", 0),
        "smoke_images": images_by_class.get("smoke", 0),
        "both_fire_smoke_images": count_both_fire_smoke_images(dataset, kept_rows),
        "no_label_images": sum(negative_images.values()),
        "fire_boxes": boxes_by_class.get("fire", 0),
        "smoke_boxes": boxes_by_class.get("smoke", 0),
    })
    summary["stats"] = stats
    return summary


def count_both_fire_smoke_images(dataset: Path, rows: Sequence[dict]) -> int:
    total = 0
    for row in rows:
        label_path = resolve_dataset_path(dataset, row.get("label"))
        classes = set()
        for line in non_empty_label_lines(label_path):
            parts = line.split()
            if not parts:
                continue
            if parts[0] == "0":
                classes.add("fire")
            elif parts[0] == "1":
                classes.add("smoke")
        if {"fire", "smoke"}.issubset(classes):
            total += 1
    return total


def main() -> int:
    args = parse_args()
    dataset = args.dataset.resolve()
    manifest_path = dataset / "manifest_selected_images.jsonl"
    summary_path = dataset / "dataset_summary.json"
    run_id = now_id()
    backup_dir = dataset / ".empty_label_backups" / run_id
    quarantine_dir = dataset / ".empty_label_quarantine" / run_id
    backup_dir.mkdir(parents=True, exist_ok=True)
    quarantine_dir.mkdir(parents=True, exist_ok=True)

    if not manifest_path.exists():
        raise SystemExit(f"manifest_not_found:{manifest_path}")
    if not summary_path.exists():
        raise SystemExit(f"summary_not_found:{summary_path}")

    shutil.copy2(manifest_path, backup_dir / "manifest_selected_images.before_prune.jsonl")
    shutil.copy2(summary_path, backup_dir / "dataset_summary.before_prune.json")
    for split in ("train", "val", "test"):
        split_path = dataset / f"{split}.txt"
        if split_path.exists():
            shutil.copy2(split_path, backup_dir / f"{split}.before_prune.txt")

    rows = list(iter_jsonl(manifest_path))
    kept_rows = []
    removed_rows = []
    moved = []
    for row in rows:
        label_path = resolve_dataset_path(dataset, row.get("label"))
        image_path = resolve_dataset_path(dataset, row.get("image"))
        if non_empty_label_lines(label_path):
            kept_rows.append(row)
            continue
        removed_rows.append(row)
        moved.append({
            "image": row.get("image"),
            "image_quarantine": move_to_quarantine(dataset, quarantine_dir, image_path),
            "label": row.get("label"),
            "label_quarantine": move_to_quarantine(dataset, quarantine_dir, label_path),
        })

    write_jsonl_atomic(manifest_path, kept_rows)
    for split in ("train", "val", "test"):
        values = [str(row.get("image") or "") for row in kept_rows if str(row.get("split") or "train") == split]
        (dataset / f"{split}.txt").write_text("\n".join(values) + ("\n" if values else ""), encoding="utf-8")

    old_summary = json.loads(summary_path.read_text(encoding="utf-8"))
    summary = recalculate_summary(dataset, old_summary, kept_rows)
    prune_info = dict(summary.get("empty_label_prune") or {})
    prune_info.update({
        "run_id": run_id,
        "updated_at": summary["updated_at"],
        "removed_images": len(removed_rows),
        "kept_images": len(kept_rows),
        "backup_dir": backup_dir.as_posix(),
        "quarantine_dir": quarantine_dir.as_posix(),
    })
    summary["empty_label_prune"] = prune_info
    write_json_atomic(summary_path, summary)
    write_json_atomic(quarantine_dir / "removed_manifest_rows.json", {
        "schema": "jgzj_finetune_v2_empty_label_prune.v1",
        "run_id": run_id,
        "removed_count": len(removed_rows),
        "moved": moved,
        "rows": [{key: value for key, value in row.items() if not key.startswith("_")} for row in removed_rows],
    })

    print(json.dumps({
        "ok": True,
        "dataset": dataset.as_posix(),
        "original_images": len(rows),
        "removed_empty_label_images": len(removed_rows),
        "remaining_images": len(kept_rows),
        "backup_dir": backup_dir.as_posix(),
        "quarantine_dir": quarantine_dir.as_posix(),
        "summary_stats": summary.get("stats"),
        "images": summary.get("images"),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
