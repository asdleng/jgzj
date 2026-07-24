#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import time
from collections import Counter
from pathlib import Path
from typing import Iterator, Sequence


SOURCE_CLASSES = [
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
SOURCE_PET_CLASS_ID = 6
TARGET_CLASSES = ["pet"]
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}


def now_id() -> str:
    return time.strftime("%Y%m%d_%H%M%S")


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build finetune_pet from YOLO event feedback samples with actual pet boxes."
    )
    parser.add_argument(
        "--source",
        type=Path,
        default=Path("/home/admin1/jgzj/.runtime/yolo_loop/datasets/yolo_event_feedback_v1"),
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("/home/admin1/jgzj/.runtime/yolo_loop/datasets/finetune_pet"),
    )
    parser.add_argument("--progress-every", type=int, default=1000)
    parser.add_argument("--link-mode", choices=["hardlink", "copy"], default="hardlink")
    parser.add_argument("--replace", action="store_true")
    return parser.parse_args()


def iter_jsonl(path: Path) -> Iterator[dict]:
    with path.open("r", encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, 1):
            text = line.strip()
            if not text:
                continue
            try:
                row = json.loads(text)
            except Exception as exc:
                raise RuntimeError(f"invalid_jsonl:{path}:{line_no}:{exc}") from exc
            if not isinstance(row, dict):
                raise RuntimeError(f"json_object_required:{path}:{line_no}")
            row["_line_no"] = line_no
            yield row


def write_json_atomic(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{int(time.time())}.tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.replace(tmp, path)


def write_jsonl(path: Path, rows: Sequence[dict]) -> None:
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")


def normalize_token(value: object) -> str:
    return str(value or "").strip().lower().replace("-", "_").replace(" ", "_")


def row_mentions_pet(row: dict) -> bool:
    tokens = []
    for key in ("expected_classes", "missing_expected_classes", "independent_classes", "label_classes", "classes"):
        value = row.get(key)
        if isinstance(value, list):
            tokens.extend(str(item) for item in value)
    for task in row.get("tasks") or []:
        if not isinstance(task, dict):
            continue
        tokens.append(str(task.get("event_name") or ""))
        tokens.append(str(task.get("expected_class") or ""))
    image = str(row.get("image") or "")
    tokens.extend(image.replace("-", "_").split("_"))
    return any(normalize_token(token) in {"pet", "dog", "cat", "off_leash_dog"} for token in tokens)


def resolve_source_image(source_dir: Path, row: dict) -> Path:
    value = str(row.get("image") or "").strip()
    if not value:
        raise RuntimeError("manifest_row_missing_image")
    path = Path(value)
    if not path.is_absolute():
        path = source_dir / value
    path = path.resolve()
    if path.suffix.lower() not in IMAGE_EXTENSIONS:
        raise RuntimeError(f"not_image:{path}")
    if not path.exists():
        raise RuntimeError(f"image_missing:{path}")
    return path


def source_label_for_image(source_dir: Path, image_path: Path) -> Path:
    rel = image_path.resolve().relative_to(source_dir.resolve())
    if rel.parts and rel.parts[0] == "images":
        return (source_dir / "labels" / Path(*rel.parts[1:])).with_suffix(".txt")
    return (source_dir / "labels" / rel).with_suffix(".txt")


def parse_and_filter_pet_label(label_path: Path) -> tuple[list[str], int]:
    kept = []
    source_box_count = 0
    if not label_path.exists():
        return kept, source_box_count
    with label_path.open("r", encoding="utf-8", errors="ignore") as handle:
        for line in handle:
            parts = line.strip().split()
            if len(parts) < 5:
                continue
            try:
                source_id = int(float(parts[0]))
            except Exception:
                continue
            source_box_count += 1
            if source_id != SOURCE_PET_CLASS_ID:
                continue
            kept.append(" ".join(["0", *parts[1:5]]))
    return kept, source_box_count


def deterministic_split(row: dict) -> str:
    key = (
        str(row.get("image_sha256") or "")
        or str(row.get("image") or "")
        or str(row.get("_line_no") or "")
    )
    value = int(hashlib.sha1(key.encode("utf-8", errors="ignore")).hexdigest()[:8], 16) % 100
    if value < 80:
        return "train"
    if value < 90:
        return "val"
    return "test"


def link_or_copy(src: Path, dst: Path, link_mode: str) -> str:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        dst.unlink()
    if link_mode == "hardlink":
        try:
            os.link(src, dst)
            return "hardlink"
        except OSError:
            pass
    shutil.copy2(src, dst)
    return "copy"


def unique_output_stem(row: dict, index: int, image_path: Path) -> str:
    sha = str(row.get("image_sha256") or "").strip().lower()
    if not sha:
        try:
            stat = image_path.stat()
            sha = hashlib.sha1(f"{image_path}:{stat.st_size}:{stat.st_mtime_ns}".encode()).hexdigest()
        except OSError:
            sha = hashlib.sha1(str(image_path).encode()).hexdigest()
    return f"event_feedback_{index:06d}_pet_{sha[:16]}"


def load_pet_rows(source_dir: Path, progress_every: int) -> tuple[list[dict], dict]:
    manifest = source_dir / "manifest_selected_images.jsonl"
    rows = []
    stats = {
        "manifest_rows": 0,
        "manifest_pet_related": 0,
        "label_pet_positive": 0,
        "skipped_no_pet_box": 0,
        "skipped_not_pet_manifest_but_pet_label": 0,
        "errors": [],
    }
    for idx, row in enumerate(iter_jsonl(manifest), 1):
        stats["manifest_rows"] += 1
        try:
            image_path = resolve_source_image(source_dir, row)
            label_path = source_label_for_image(source_dir, image_path)
            kept_lines, source_box_count = parse_and_filter_pet_label(label_path)
            manifest_related = row_mentions_pet(row)
            if manifest_related:
                stats["manifest_pet_related"] += 1
            if not kept_lines:
                stats["skipped_no_pet_box"] += 1
                continue
            if not manifest_related:
                stats["skipped_not_pet_manifest_but_pet_label"] += 1
            stats["label_pet_positive"] += 1
            row["_source_index"] = idx
            row["_source_image_path"] = image_path
            row["_source_label_path"] = label_path
            row["_kept_label_lines"] = kept_lines
            row["_source_box_count"] = source_box_count
            rows.append(row)
        except Exception as exc:
            stats["errors"].append({
                "line": row.get("_line_no"),
                "image": row.get("image", ""),
                "error": f"{type(exc).__name__}: {exc}",
            })
        if progress_every > 0 and idx % progress_every == 0:
            print(json.dumps({
                "event": "scan_progress",
                "processed": idx,
                "selected": len(rows),
                "errors": len(stats["errors"]),
            }, ensure_ascii=False), flush=True)
    return rows, stats


def build_dataset(source_dir: Path, output_dir: Path, rows: Sequence[dict], scan_stats: dict, link_mode: str) -> dict:
    for split in ("train", "val", "test"):
        (output_dir / "images" / split).mkdir(parents=True, exist_ok=True)
        (output_dir / "labels" / split).mkdir(parents=True, exist_ok=True)

    manifest_rows = []
    split_images: Counter = Counter()
    boxes_by_split: Counter = Counter()
    link_counts: Counter = Counter()
    pet_images = 0
    pet_boxes = 0

    for out_index, row in enumerate(rows):
        image_path: Path = row["_source_image_path"]
        kept_lines = list(row["_kept_label_lines"])
        if not kept_lines:
            continue
        split = deterministic_split(row)
        stem = unique_output_stem(row, out_index, image_path)
        image_rel = f"images/{split}/{stem}{image_path.suffix.lower()}"
        label_rel = f"labels/{split}/{stem}.txt"
        image_dst = output_dir / image_rel
        label_dst = output_dir / label_rel
        link_counts[link_or_copy(image_path, image_dst, link_mode)] += 1
        label_dst.write_text("\n".join(kept_lines).rstrip() + "\n", encoding="utf-8")

        split_images[split] += 1
        box_count = len(kept_lines)
        boxes_by_split[split] += box_count
        pet_images += 1
        pet_boxes += box_count
        manifest_rows.append({
            "schema": "jgzj_finetune_pet_manifest.v1",
            "image": image_rel,
            "label": label_rel,
            "split": split,
            "source": "yolo_event_feedback_v1",
            "source_dataset": source_dir.as_posix(),
            "source_image": image_path.as_posix(),
            "source_label": row["_source_label_path"].as_posix(),
            "source_manifest_line": row.get("_line_no"),
            "source_image_sha256": row.get("image_sha256", ""),
            "source_feedback_status": row.get("feedback_status", ""),
            "source_feedback_reason": row.get("feedback_reason", ""),
            "source_expected_classes": row.get("expected_classes") or [],
            "source_independent_classes": row.get("independent_classes") or [],
            "source_tasks": row.get("tasks") or [],
            "source_box_count": row.get("_source_box_count", 0),
            "box_count": box_count,
            "label_count": box_count,
            "classes": ["pet"],
            "label_classes": ["pet"],
            "is_positive": True,
            "training_eligible": True,
        })

    write_jsonl(output_dir / "manifest_selected_images.jsonl", manifest_rows)
    (output_dir / "classes.txt").write_text("pet\n", encoding="utf-8")
    (output_dir / "data.yaml").write_text(
        "\n".join([
            f"path: {output_dir.as_posix()}",
            "train: images/train",
            "val: images/val",
            "test: images/test",
            "names:",
            "  0: pet",
            "",
        ]),
        encoding="utf-8",
    )
    for split in ("train", "val", "test"):
        values = [row["image"] for row in manifest_rows if row["split"] == split]
        (output_dir / f"{split}.txt").write_text("\n".join(values) + ("\n" if values else ""), encoding="utf-8")

    summary = {
        "schema": "jgzj_yolo_finetune_review_dataset.v1",
        "profile": "finetune_pet",
        "display_name": "finetune_pet",
        "kind": "detect",
        "created_at": now_iso(),
        "updated_at": now_iso(),
        "dataset_dir": output_dir.as_posix(),
        "source_type": "finetune_dataset",
        "source_label": "Finetune训练集",
        "classes": TARGET_CLASSES,
        "images": {split: split_images.get(split, 0) for split in ("train", "val", "test") if split_images.get(split, 0)},
        "positive_images": {split: split_images.get(split, 0) for split in ("train", "val", "test") if split_images.get(split, 0)},
        "negative_images": {},
        "boxes": {split: boxes_by_split.get(split, 0) for split in ("train", "val", "test") if boxes_by_split.get(split, 0)},
        "boxes_by_class": {"pet": pet_boxes},
        "answers": {"YES": pet_images, "NO": 0, "NULL": 0},
        "by_class_yes": {"pet": pet_images},
        "total_images": len(manifest_rows),
        "selected_images": len(manifest_rows),
        "training_eligible": True,
        "finetune": {
            "name": "finetune_pet",
            "source_dataset": source_dir.as_posix(),
            "source_profile": "YOLO事件原图反馈候选集",
            "label_policy": "keep only source class pet; remap pet 6->0; drop all images with no remaining box",
        },
        "review": {
            "source_group": "finetune_dataset",
            "source_group_label": "Finetune训练集",
            "visible_in_yolo_label_review": True,
        },
        "source_images": {"yolo_event_feedback_v1": dict(split_images)},
        "source_positive_images": {"yolo_event_feedback_v1": dict(split_images)},
        "link_counts": dict(link_counts),
        "stats": {
            "pet_images": pet_images,
            "pet_boxes": pet_boxes,
            "no_label_images": 0,
            "removed_no_pet_box_images": scan_stats.get("skipped_no_pet_box", 0),
            "manifest_pet_related": scan_stats.get("manifest_pet_related", 0),
        },
        "scan": scan_stats,
        "notes": [
            "Built from current yolo_event_feedback_v1 manifest.",
            "Only samples with actual source pet boxes are included.",
            "All non-pet source boxes are removed.",
            "Images with no remaining pet box are excluded.",
        ],
    }
    write_json_atomic(output_dir / "dataset_summary.json", summary)
    return summary


def main() -> int:
    args = parse_args()
    source_dir = args.source.resolve()
    output_dir = args.output.resolve()
    if not source_dir.exists():
        raise SystemExit(f"source_not_found:{source_dir}")
    if output_dir.exists() and any(output_dir.iterdir()) and not args.replace:
        raise SystemExit(f"output_exists_use_replace:{output_dir}")

    run_id = now_id()
    staging_dir = output_dir.parent / f".{output_dir.name}.staging_{run_id}_{os.getpid()}"
    backup_dir = output_dir.parent / f"{output_dir.name}.backup_{run_id}"
    if staging_dir.exists():
        shutil.rmtree(staging_dir)

    print(json.dumps({
        "event": "start",
        "source": source_dir.as_posix(),
        "output": output_dir.as_posix(),
        "staging": staging_dir.as_posix(),
        "link_mode": args.link_mode,
        "replace": bool(args.replace),
    }, ensure_ascii=False), flush=True)
    rows, scan_stats = load_pet_rows(source_dir, args.progress_every)
    build_dataset(source_dir, staging_dir, rows, scan_stats, args.link_mode)

    if output_dir.exists():
        if backup_dir.exists():
            shutil.rmtree(backup_dir)
        output_dir.rename(backup_dir)
    staging_dir.rename(output_dir)

    final_summary_path = output_dir / "dataset_summary.json"
    final_summary = json.loads(final_summary_path.read_text(encoding="utf-8"))
    final_summary["dataset_dir"] = output_dir.as_posix()
    final_summary["backup_replaced_dataset"] = backup_dir.as_posix() if backup_dir.exists() else ""
    write_json_atomic(final_summary_path, final_summary)
    (output_dir / "data.yaml").write_text(
        "\n".join([
            f"path: {output_dir.as_posix()}",
            "train: images/train",
            "val: images/val",
            "test: images/test",
            "names:",
            "  0: pet",
            "",
        ]),
        encoding="utf-8",
    )

    result = {
        "ok": True,
        "dataset": output_dir.as_posix(),
        "backup_replaced_dataset": final_summary["backup_replaced_dataset"],
        "total_images": final_summary["total_images"],
        "pet_images": final_summary["stats"]["pet_images"],
        "pet_boxes": final_summary["stats"]["pet_boxes"],
        "no_label_images": final_summary["stats"]["no_label_images"],
        "images": final_summary["images"],
        "boxes": final_summary["boxes"],
        "scan_errors": len(scan_stats.get("errors") or []),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
