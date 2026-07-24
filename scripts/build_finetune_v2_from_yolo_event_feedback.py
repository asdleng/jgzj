#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Dict, Iterable, Iterator, List, Sequence, Tuple


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
TARGET_CLASSES = ["fire", "smoke"]
SOURCE_TO_TARGET_CLASS_ID = {3: 0, 4: 1}
FIRE_SMOKE_TOKENS = {"fire", "smoke", "火", "火源", "烟", "烟雾"}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}


def now_id() -> str:
    return time.strftime("%Y%m%d_%H%M%S")


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build finetune_v2 from YOLO event feedback samples involving fire/smoke."
    )
    parser.add_argument(
        "--source",
        type=Path,
        default=Path("/home/admin1/jgzj/.runtime/yolo_loop/datasets/yolo_event_feedback_v1"),
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("/home/admin1/jgzj/.runtime/yolo_loop/datasets/finetune_v2"),
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


def fire_smoke_related_tokens(row: dict) -> List[str]:
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
    stem_tokens = image.replace("-", "_").split("_")
    tokens.extend(stem_tokens)
    normalized = []
    for token in tokens:
        item = normalize_token(token)
        if item in {"fire", "smoke", "火", "火源", "烟", "烟雾"}:
            normalized.append("fire" if item in {"fire", "火", "火源"} else "smoke")
    return sorted(set(normalized))


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


def parse_and_filter_label(label_path: Path) -> Tuple[List[str], Counter, int]:
    kept = []
    target_counts: Counter = Counter()
    source_box_count = 0
    if not label_path.exists():
        return kept, target_counts, source_box_count
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
            if source_id not in SOURCE_TO_TARGET_CLASS_ID:
                continue
            target_id = SOURCE_TO_TARGET_CLASS_ID[source_id]
            coords = parts[1:5]
            target_name = TARGET_CLASSES[target_id]
            kept.append(" ".join([str(target_id), *coords]))
            target_counts[target_name] += 1
    return kept, target_counts, source_box_count


def deterministic_split(row: dict, kept_counts: Counter) -> str:
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
    event = ""
    for task in row.get("tasks") or []:
        if isinstance(task, dict) and normalize_token(task.get("event_name")) in {"fire", "smoke"}:
            event = normalize_token(task.get("event_name"))
            break
    if not event:
        related = fire_smoke_related_tokens(row)
        event = related[0] if related else "fire_smoke"
    return f"event_feedback_{index:06d}_{event}_{sha[:16]}"


def load_rows(source_dir: Path, progress_every: int) -> Tuple[List[dict], dict]:
    manifest = source_dir / "manifest_selected_images.jsonl"
    rows = []
    stats = {
        "manifest_rows": 0,
        "related_by_manifest": 0,
        "related_by_label": 0,
        "skipped_unrelated": 0,
        "errors": [],
    }
    for idx, row in enumerate(iter_jsonl(manifest), 1):
        stats["manifest_rows"] += 1
        try:
            image_path = resolve_source_image(source_dir, row)
            label_path = source_label_for_image(source_dir, image_path)
            kept_lines, target_counts, source_box_count = parse_and_filter_label(label_path)
            manifest_tokens = fire_smoke_related_tokens(row)
            related_by_manifest = bool(manifest_tokens)
            related_by_label = bool(sum(target_counts.values()))
            if not related_by_manifest and not related_by_label:
                stats["skipped_unrelated"] += 1
                continue
            if related_by_manifest:
                stats["related_by_manifest"] += 1
            if related_by_label:
                stats["related_by_label"] += 1
            row["_source_index"] = idx
            row["_source_image_path"] = image_path
            row["_source_label_path"] = label_path
            row["_kept_label_lines"] = kept_lines
            row["_target_counts"] = dict(target_counts)
            row["_source_box_count"] = source_box_count
            row["_manifest_fire_smoke_tokens"] = manifest_tokens
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


def count_manifest_classes(rows: Sequence[dict]) -> Counter:
    counts: Counter = Counter()
    for row in rows:
        for token in fire_smoke_related_tokens(row):
            counts[token] += 1
    return counts


def build_dataset(source_dir: Path, output_dir: Path, rows: Sequence[dict], scan_stats: dict, link_mode: str) -> dict:
    for split in ("train", "val", "test"):
        (output_dir / "images" / split).mkdir(parents=True, exist_ok=True)
        (output_dir / "labels" / split).mkdir(parents=True, exist_ok=True)

    manifest_rows = []
    split_images: Counter = Counter()
    positive_images: Counter = Counter()
    negative_images: Counter = Counter()
    boxes_by_split: Counter = Counter()
    boxes_by_class: Counter = Counter()
    image_by_class: Counter = Counter()
    link_counts: Counter = Counter()
    no_label_images = 0
    fire_images = 0
    smoke_images = 0
    both_images = 0

    for out_index, row in enumerate(rows):
        image_path: Path = row["_source_image_path"]
        kept_lines = list(row["_kept_label_lines"])
        target_counts = Counter(row["_target_counts"])
        split = deterministic_split(row, target_counts)
        stem = unique_output_stem(row, out_index, image_path)
        image_rel = f"images/{split}/{stem}{image_path.suffix.lower()}"
        label_rel = f"labels/{split}/{stem}.txt"
        image_dst = output_dir / image_rel
        label_dst = output_dir / label_rel
        link_counts[link_or_copy(image_path, image_dst, link_mode)] += 1
        label_dst.write_text(("\n".join(kept_lines) + "\n") if kept_lines else "", encoding="utf-8")

        split_images[split] += 1
        box_count = sum(target_counts.values())
        boxes_by_split[split] += box_count
        for cls, count in target_counts.items():
            boxes_by_class[cls] += count
        classes = sorted(target_counts.keys(), key=lambda name: TARGET_CLASSES.index(name))
        if box_count:
            positive_images[split] += 1
        else:
            negative_images[split] += 1
            no_label_images += 1
        has_fire = target_counts.get("fire", 0) > 0
        has_smoke = target_counts.get("smoke", 0) > 0
        if has_fire:
            fire_images += 1
            image_by_class["fire"] += 1
        if has_smoke:
            smoke_images += 1
            image_by_class["smoke"] += 1
        if has_fire and has_smoke:
            both_images += 1

        manifest_rows.append({
            "schema": "jgzj_finetune_v2_manifest.v1",
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
            "classes": classes,
            "is_positive": box_count > 0,
            "training_eligible": True,
        })

    write_jsonl(output_dir / "manifest_selected_images.jsonl", manifest_rows)
    (output_dir / "classes.txt").write_text("fire\nsmoke\n", encoding="utf-8")
    (output_dir / "data.yaml").write_text(
        "\n".join([
            f"path: {output_dir.as_posix()}",
            "train: images/train",
            "val: images/val",
            "test: images/test",
            "names:",
            "  0: fire",
            "  1: smoke",
            "",
        ]),
        encoding="utf-8",
    )
    for split in ("train", "val", "test"):
        list_path = output_dir / f"{split}.txt"
        values = [row["image"] for row in manifest_rows if row["split"] == split]
        list_path.write_text("\n".join(values) + ("\n" if values else ""), encoding="utf-8")

    summary = {
        "schema": "jgzj_yolo_finetune_review_dataset.v1",
        "profile": "finetune_v2",
        "kind": "detect",
        "created_at": now_iso(),
        "updated_at": now_iso(),
        "dataset_dir": output_dir.as_posix(),
        "classes": TARGET_CLASSES,
        "images": {split: split_images.get(split, 0) for split in ("train", "val", "test") if split_images.get(split, 0)},
        "positive_images": {split: positive_images.get(split, 0) for split in ("train", "val", "test") if positive_images.get(split, 0)},
        "negative_images": {split: negative_images.get(split, 0) for split in ("train", "val", "test") if negative_images.get(split, 0)},
        "boxes": {split: boxes_by_split.get(split, 0) for split in ("train", "val", "test") if boxes_by_split.get(split, 0)},
        "boxes_by_class": dict(boxes_by_class),
        "answers": {"YES": sum(positive_images.values()), "NO": no_label_images, "NULL": 0},
        "by_class_yes": dict(image_by_class),
        "total_images": len(manifest_rows),
        "training_eligible": True,
        "finetune": {
            "name": "finetune_v2",
            "source_dataset": source_dir.as_posix(),
            "source_profile": "YOLO事件原图反馈候选集",
            "label_policy": "keep only source classes fire/smoke; remap fire 3->0 and smoke 4->1",
        },
        "source_images": {"yolo_event_feedback_v1": dict(split_images)},
        "source_positive_images": {"yolo_event_feedback_v1": dict(positive_images)},
        "link_counts": dict(link_counts),
        "selected_images": len(manifest_rows),
        "stats": {
            "fire_images": fire_images,
            "smoke_images": smoke_images,
            "both_fire_smoke_images": both_images,
            "no_label_images": no_label_images,
            "fire_boxes": boxes_by_class.get("fire", 0),
            "smoke_boxes": boxes_by_class.get("smoke", 0),
            "manifest_related_class_images": dict(count_manifest_classes(rows)),
        },
        "scan": scan_stats,
        "notes": [
            "Built from current yolo_event_feedback_v1 manifest.",
            "Samples are selected when fire/smoke appears in manifest task/class metadata or in source YOLO labels.",
            "All non-fire/non-smoke source boxes are removed.",
            "Images are hardlinked by default and labels are newly written.",
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
    rows, scan_stats = load_rows(source_dir, args.progress_every)
    summary = build_dataset(source_dir, staging_dir, rows, scan_stats, args.link_mode)

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
            "  0: fire",
            "  1: smoke",
            "",
        ]),
        encoding="utf-8",
    )

    result = {
        "ok": True,
        "dataset": output_dir.as_posix(),
        "backup_replaced_dataset": final_summary["backup_replaced_dataset"],
        "total_images": final_summary["total_images"],
        "fire_images": final_summary["stats"]["fire_images"],
        "smoke_images": final_summary["stats"]["smoke_images"],
        "both_fire_smoke_images": final_summary["stats"]["both_fire_smoke_images"],
        "no_label_images": final_summary["stats"]["no_label_images"],
        "fire_boxes": final_summary["stats"]["fire_boxes"],
        "smoke_boxes": final_summary["stats"]["smoke_boxes"],
        "images": final_summary["images"],
        "positive_images": final_summary["positive_images"],
        "negative_images": final_summary["negative_images"],
        "scan_errors": len(scan_stats.get("errors") or []),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
