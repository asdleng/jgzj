#!/usr/bin/env python3
import argparse
import csv
import hashlib
import json
import math
import os
import shutil
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

try:
    import cv2
except Exception:
    cv2 = None


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
POSITIVE_CATEGORIES = {"normal_positive", "hard_positive"}
NEGATIVE_CATEGORIES = {"normal_negative", "hard_negative"}
CATEGORY_PRIORITY = {
    "hard_positive": 400,
    "hard_negative": 300,
    "normal_positive": 200,
    "normal_negative": 100,
}


def parse_args():
    parser = argparse.ArgumentParser(
        description="Deduplicate a YOLO finetune dataset by perceptual hash."
    )
    parser.add_argument("--dataset-dir", required=True, help="YOLO dataset dir containing images/, labels/, samples_manifest.jsonl.")
    parser.add_argument("--summary", default="", help="Optional dataset_summary.json to update when --apply is used.")
    parser.add_argument("--manifest", default="", help="Manifest jsonl path. Defaults to <dataset-dir>/samples_manifest.jsonl.")
    parser.add_argument("--phash-threshold", type=int, default=8, help="Max pHash Hamming distance for near duplicates.")
    parser.add_argument("--dhash-threshold", type=int, default=12, help="Max dHash Hamming distance for near duplicates.")
    parser.add_argument("--dry-run", action="store_true", help="Only report duplicates.")
    parser.add_argument("--apply", action="store_true", help="Move duplicate images/labels and rewrite manifest/summary.")
    parser.add_argument("--report-dir", default="", help="Report directory. Defaults to <dataset-dir>/dedupe_reports.")
    parser.add_argument("--quarantine-dir", default="", help="Quarantine directory. Defaults to <dataset-dir>/.dedupe_quarantine/<run-id>.")
    return parser.parse_args()


def require_mode(args):
    if args.dry_run == args.apply:
        raise SystemExit("Choose exactly one of --dry-run or --apply.")
    if args.phash_threshold < 0 or args.dhash_threshold < 0:
        raise SystemExit("Hash thresholds must be >= 0.")


def now_id():
    return time.strftime("%Y%m%d_%H%M%S")


def read_jsonl(path):
    rows = []
    with open(path, "r", encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, 1):
            text = line.strip()
            if not text:
                continue
            try:
                item = json.loads(text)
            except Exception as exc:
                raise RuntimeError(f"Invalid JSONL at {path}:{line_no}: {exc}") from exc
            item["_manifest_line"] = line_no
            rows.append(item)
    return rows


def write_jsonl_atomic(path, rows):
    tmp = Path(f"{path}.{os.getpid()}.{int(time.time())}.tmp")
    with open(tmp, "w", encoding="utf-8") as handle:
        for row in rows:
            public = {k: v for k, v in row.items() if not k.startswith("_")}
            handle.write(json.dumps(public, ensure_ascii=False, sort_keys=False) + "\n")
    os.replace(tmp, path)


def read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return {}


def write_json_atomic(path, payload):
    tmp = Path(f"{path}.{os.getpid()}.{int(time.time())}.tmp")
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.replace(tmp, path)


def resolve_path(dataset_dir, value):
    if not value:
        return None
    path = Path(str(value))
    if path.is_absolute():
        return path
    return (dataset_dir / path).resolve()


def rel_to_dataset(dataset_dir, path):
    try:
        return path.resolve().relative_to(dataset_dir.resolve()).as_posix()
    except Exception:
        return ""


def image_path_for_row(dataset_dir, row):
    for key in ("dataset_image", "image"):
        path = resolve_path(dataset_dir, row.get(key))
        if path and path.suffix.lower() in IMAGE_EXTENSIONS and path.exists():
            return path
    return None


def label_path_for_row(dataset_dir, row, image_path):
    for key in ("dataset_label", "label"):
        path = resolve_path(dataset_dir, row.get(key))
        if path and path.exists():
            return path
    rel = rel_to_dataset(dataset_dir, image_path)
    if rel.startswith("images/"):
        candidate = dataset_dir / rel.replace("images/", "labels/", 1)
        candidate = candidate.with_suffix(".txt")
        return candidate if candidate.exists() else None
    return None


def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def dct2_ortho(matrix):
    size = matrix.shape[0]
    xs = np.arange(size, dtype=np.float32)
    basis = np.empty((size, size), dtype=np.float32)
    scale0 = math.sqrt(1.0 / size)
    scale = math.sqrt(2.0 / size)
    for k in range(size):
        basis[k, :] = (scale0 if k == 0 else scale) * np.cos((math.pi * (2 * xs + 1) * k) / (2 * size))
    return basis @ matrix @ basis.T


def phash(image_path):
    with Image.open(image_path) as img:
        img = ImageOps.exif_transpose(img).convert("L").resize((32, 32), Image.Resampling.LANCZOS)
        matrix = np.asarray(img, dtype=np.float32)
    coeff = cv2.dct(matrix) if cv2 is not None else dct2_ortho(matrix)
    block = coeff[:8, :8].flatten()
    useful = block[1:]
    median = float(np.median(useful))
    bits = block > median
    value = 0
    for bit in bits:
        value = (value << 1) | int(bool(bit))
    return value


def dhash(image_path):
    with Image.open(image_path) as img:
        img = ImageOps.exif_transpose(img).convert("L").resize((9, 8), Image.Resampling.LANCZOS)
        matrix = np.asarray(img, dtype=np.int16)
    diff = matrix[:, 1:] > matrix[:, :-1]
    value = 0
    for bit in diff.flatten():
        value = (value << 1) | int(bool(bit))
    return value


def hamming(left, right):
    return bin(int(left ^ right)).count("1")


class UnionFind:
    def __init__(self, size):
        self.parent = list(range(size))
        self.rank = [0] * size

    def find(self, value):
        while self.parent[value] != value:
            self.parent[value] = self.parent[self.parent[value]]
            value = self.parent[value]
        return value

    def union(self, left, right):
        root_left = self.find(left)
        root_right = self.find(right)
        if root_left == root_right:
            return
        if self.rank[root_left] < self.rank[root_right]:
            root_left, root_right = root_right, root_left
        self.parent[root_right] = root_left
        if self.rank[root_left] == self.rank[root_right]:
            self.rank[root_left] += 1


def label_box_count(path):
    if not path or not path.exists():
        return 0
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return sum(1 for line in handle if line.strip())
    except Exception:
        return 0


def keep_score(row):
    return CATEGORY_PRIORITY.get(str(row.get("category") or ""), 0)


def build_records(dataset_dir, rows):
    records = []
    errors = []
    for idx, row in enumerate(rows):
        image_path = image_path_for_row(dataset_dir, row)
        if not image_path:
            errors.append({"index": idx, "line": row.get("_manifest_line"), "error": "image_missing"})
            continue
        label_path = label_path_for_row(dataset_dir, row, image_path)
        try:
            records.append({
                "index": idx,
                "row": row,
                "image_path": image_path,
                "image_rel": rel_to_dataset(dataset_dir, image_path),
                "label_path": label_path,
                "label_rel": rel_to_dataset(dataset_dir, label_path) if label_path else "",
                "label_boxes": label_box_count(label_path),
                "sha256": file_sha256(image_path),
                "phash": phash(image_path),
                "dhash": dhash(image_path),
            })
        except Exception as exc:
            errors.append({
                "index": idx,
                "line": row.get("_manifest_line"),
                "image": str(image_path),
                "error": f"{type(exc).__name__}: {exc}",
            })
    return records, errors


def choose_keeper(group):
    return sorted(
        group,
        key=lambda item: (
            -keep_score(item["row"]),
            -int(item["label_boxes"] > 0),
            item["index"],
        ),
    )[0]


def find_duplicate_groups(records, phash_threshold, dhash_threshold):
    uf = UnionFind(len(records))
    by_sha = defaultdict(list)
    for pos, record in enumerate(records):
        by_sha[record["sha256"]].append(pos)
    for positions in by_sha.values():
        if len(positions) > 1:
            first = positions[0]
            for pos in positions[1:]:
                uf.union(first, pos)

    for left in range(len(records)):
        left_record = records[left]
        for right in range(left + 1, len(records)):
            right_record = records[right]
            phash_distance = hamming(left_record["phash"], right_record["phash"])
            if phash_distance > phash_threshold:
                continue
            dhash_distance = hamming(left_record["dhash"], right_record["dhash"])
            if dhash_distance <= dhash_threshold:
                uf.union(left, right)

    grouped = defaultdict(list)
    for pos, record in enumerate(records):
        grouped[uf.find(pos)].append(record)

    duplicate_groups = []
    for group in grouped.values():
        if len(group) <= 1:
            continue
        keeper = choose_keeper(group)
        duplicates = [item for item in group if item is not keeper]
        duplicate_groups.append({
            "keeper": keeper,
            "duplicates": sorted(duplicates, key=lambda item: item["index"]),
        })
    duplicate_groups.sort(key=lambda group: group["keeper"]["index"])
    return duplicate_groups


def count_categories(rows):
    counts = Counter(str(row.get("category") or "unknown") for row in rows)
    return {
        "normal_positive": counts.get("normal_positive", 0),
        "hard_positive": counts.get("hard_positive", 0),
        "normal_negative": counts.get("normal_negative", 0),
        "hard_negative": counts.get("hard_negative", 0),
        "other": sum(value for key, value in counts.items() if key not in {
            "normal_positive", "hard_positive", "normal_negative", "hard_negative"
        }),
        "total": len(rows),
    }


def count_boxes_by_split_and_class(rows, dataset_dir, classes):
    split_counts = Counter()
    positive_split_counts = Counter()
    negative_split_counts = Counter()
    boxes_by_split = Counter()
    boxes_by_class = Counter()
    boxes_by_class_split = {name: Counter() for name in classes}

    for row in rows:
        split = str(row.get("dataset_split") or row.get("split") or "train")
        category = str(row.get("category") or "")
        split_counts[split] += 1
        if category in POSITIVE_CATEGORIES:
            positive_split_counts[split] += 1
        elif category in NEGATIVE_CATEGORIES:
            negative_split_counts[split] += 1

        image_path = image_path_for_row(dataset_dir, row)
        label_path = label_path_for_row(dataset_dir, row, image_path) if image_path else None
        if not label_path or not label_path.exists():
            continue
        with open(label_path, "r", encoding="utf-8") as handle:
            for line in handle:
                parts = line.strip().split()
                if len(parts) < 5:
                    continue
                try:
                    cls_id = int(float(parts[0]))
                except Exception:
                    continue
                class_name = classes[cls_id] if 0 <= cls_id < len(classes) else str(cls_id)
                boxes_by_split[split] += 1
                boxes_by_class[class_name] += 1
                boxes_by_class_split.setdefault(class_name, Counter())[split] += 1

    splits = ["train", "val", "test"]
    return {
        "images": {split: split_counts.get(split, 0) for split in splits if split_counts.get(split, 0)},
        "positive_images": {split: positive_split_counts.get(split, 0) for split in splits if positive_split_counts.get(split, 0)},
        "empty_images": {split: negative_split_counts.get(split, 0) for split in splits if negative_split_counts.get(split, 0)},
        "boxes": {split: boxes_by_split.get(split, 0) for split in splits if boxes_by_split.get(split, 0)},
        "boxes_by_class_split": {
            name: {split: counter.get(split, 0) for split in splits if counter.get(split, 0)}
            for name, counter in boxes_by_class_split.items()
            if sum(counter.values()) > 0
        },
        "by_class_yes": dict(boxes_by_class),
    }


def read_classes(dataset_dir, summary):
    classes_path = dataset_dir / "classes.txt"
    if classes_path.exists():
        return [line.strip() for line in classes_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    classes = summary.get("classes") if isinstance(summary, dict) else None
    if isinstance(classes, list):
        return [str(item) for item in classes]
    return []


def counter_from_rows(rows, key):
    return dict(Counter(str(row.get(key) or "unknown") for row in rows))


def update_summary(summary_path, dataset_dir, kept_rows, args, report_rel):
    summary_path = Path(summary_path)
    summary = read_json(summary_path)
    classes = read_classes(dataset_dir, summary)
    stats = count_boxes_by_split_and_class(kept_rows, dataset_dir, classes)
    category_counts = counter_from_rows(kept_rows, "category")
    positive_total = sum(category_counts.get(item, 0) for item in POSITIVE_CATEGORIES)
    negative_total = sum(category_counts.get(item, 0) for item in NEGATIVE_CATEGORIES)

    summary["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    summary["images"] = stats["images"]
    summary["positive_images"] = stats["positive_images"]
    summary["empty_images"] = stats["empty_images"]
    summary["boxes"] = stats["boxes"]
    summary["boxes_by_class_split"] = stats["boxes_by_class_split"]
    summary["by_class_yes"] = stats["by_class_yes"]
    summary["answers"] = {"YES": positive_total, "NO": negative_total, "NULL": 0}
    summary["total_images"] = len(kept_rows)
    summary["source_counts"] = counter_from_rows(kept_rows, "source")
    summary["category_counts"] = category_counts
    summary["source_bucket_counts"] = counter_from_rows(kept_rows, "source_bucket")
    summary["manifest_split_counts"] = counter_from_rows(kept_rows, "dataset_split")
    summary["reason_counts"] = counter_from_rows(kept_rows, "reason")
    summary["label_mode_counts"] = counter_from_rows(kept_rows, "label_mode")
    summary["dedupe"] = {
        "method": "sha256+phash+dhash",
        "phash_threshold": args.phash_threshold,
        "dhash_threshold": args.dhash_threshold,
        "updated_at": summary["updated_at"],
        "report": report_rel,
    }
    write_json_atomic(summary_path, summary)


def move_into_quarantine(dataset_dir, quarantine_dir, path):
    if not path or not path.exists():
        return ""
    rel = rel_to_dataset(dataset_dir, path)
    if not rel:
        rel = path.name
    dest = quarantine_dir / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        dest = dest.with_name(f"{dest.stem}.{int(time.time())}{dest.suffix}")
    shutil.move(str(path), str(dest))
    return dest.as_posix()


def write_reports(report_dir, run_id, payload, duplicate_groups):
    report_dir.mkdir(parents=True, exist_ok=True)
    json_path = report_dir / f"dedupe_report_{run_id}.json"
    csv_path = report_dir / f"dedupe_duplicates_{run_id}.csv"
    write_json_atomic(json_path, payload)
    with open(csv_path, "w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=[
            "group_id", "action", "category", "source_bucket", "image_rel", "label_rel", "keeper_image_rel"
        ])
        writer.writeheader()
        for group_id, group in enumerate(duplicate_groups, 1):
            keeper = group["keeper"]
            writer.writerow({
                "group_id": group_id,
                "action": "keep",
                "category": keeper["row"].get("category", ""),
                "source_bucket": keeper["row"].get("source_bucket", ""),
                "image_rel": keeper["image_rel"],
                "label_rel": keeper["label_rel"],
                "keeper_image_rel": keeper["image_rel"],
            })
            for item in group["duplicates"]:
                writer.writerow({
                    "group_id": group_id,
                    "action": "remove",
                    "category": item["row"].get("category", ""),
                    "source_bucket": item["row"].get("source_bucket", ""),
                    "image_rel": item["image_rel"],
                    "label_rel": item["label_rel"],
                    "keeper_image_rel": keeper["image_rel"],
                })
    return json_path, csv_path


def main():
    args = parse_args()
    require_mode(args)
    dataset_dir = Path(args.dataset_dir).resolve()
    manifest_path = Path(args.manifest).resolve() if args.manifest else dataset_dir / "samples_manifest.jsonl"
    report_dir = Path(args.report_dir).resolve() if args.report_dir else dataset_dir / "dedupe_reports"
    run_id = now_id()
    quarantine_dir = Path(args.quarantine_dir).resolve() if args.quarantine_dir else dataset_dir / ".dedupe_quarantine" / run_id

    if not dataset_dir.exists():
        raise SystemExit(f"Dataset dir not found: {dataset_dir}")
    if not manifest_path.exists():
        raise SystemExit(f"Manifest not found: {manifest_path}")

    rows = read_jsonl(manifest_path)
    records, errors = build_records(dataset_dir, rows)
    duplicate_groups = find_duplicate_groups(records, args.phash_threshold, args.dhash_threshold)
    duplicate_indices = {item["index"] for group in duplicate_groups for item in group["duplicates"]}
    kept_rows = [row for idx, row in enumerate(rows) if idx not in duplicate_indices]
    removed_rows = [row for idx, row in enumerate(rows) if idx in duplicate_indices]

    payload = {
        "schema": "jgzj_yolo_finetune_dedupe_report.v1",
        "run_id": run_id,
        "mode": "apply" if args.apply else "dry_run",
        "dataset_dir": dataset_dir.as_posix(),
        "manifest": manifest_path.as_posix(),
        "summary": str(Path(args.summary).resolve()) if args.summary else "",
        "method": "sha256+phash+dhash",
        "phash_threshold": args.phash_threshold,
        "dhash_threshold": args.dhash_threshold,
        "original": count_categories(rows),
        "remaining": count_categories(kept_rows),
        "removed": count_categories(removed_rows),
        "duplicate_group_count": len(duplicate_groups),
        "duplicate_image_count": len(removed_rows),
        "error_count": len(errors),
        "errors": errors[:100],
    }

    json_report, csv_report = write_reports(report_dir, run_id, payload, duplicate_groups)
    payload["report_json"] = json_report.as_posix()
    payload["report_csv"] = csv_report.as_posix()
    write_json_atomic(json_report, payload)

    if args.apply:
        quarantine_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(manifest_path, quarantine_dir / "samples_manifest.before_dedupe.jsonl")
        moved = []
        for group in duplicate_groups:
            for item in group["duplicates"]:
                image_dest = move_into_quarantine(dataset_dir, quarantine_dir, item["image_path"])
                label_dest = move_into_quarantine(dataset_dir, quarantine_dir, item["label_path"])
                moved.append({
                    "image": item["image_rel"],
                    "image_quarantine": image_dest,
                    "label": item["label_rel"],
                    "label_quarantine": label_dest,
                })
        payload["quarantine_dir"] = quarantine_dir.as_posix()
        payload["moved"] = moved
        write_jsonl_atomic(manifest_path, kept_rows)
        if args.summary:
            try:
                report_rel = rel_to_dataset(Path(args.summary).resolve().parent, json_report)
            except Exception:
                report_rel = json_report.as_posix()
            update_summary(Path(args.summary).resolve(), dataset_dir, kept_rows, args, report_rel or json_report.as_posix())
        write_json_atomic(json_report, payload)

    print(json.dumps({
        "ok": True,
        "mode": payload["mode"],
        "dataset_dir": payload["dataset_dir"],
        "original": payload["original"],
        "remaining": payload["remaining"],
        "removed": payload["removed"],
        "duplicate_group_count": payload["duplicate_group_count"],
        "duplicate_image_count": payload["duplicate_image_count"],
        "error_count": payload["error_count"],
        "report_json": payload["report_json"],
        "report_csv": payload["report_csv"],
        "quarantine_dir": payload.get("quarantine_dir", ""),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        raise
    except Exception as exc:
        print(json.dumps({"ok": False, "error": type(exc).__name__, "detail": str(exc)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
