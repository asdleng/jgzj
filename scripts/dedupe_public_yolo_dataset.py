#!/usr/bin/env python3
from __future__ import annotations

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
from typing import Dict, Iterable, Iterator, List, Optional, Sequence, Tuple

import numpy as np
from PIL import Image, ImageOps

try:
    import cv2
except Exception:
    cv2 = None


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
DEFAULT_BANDS = (
    (0, 16),
    (8, 16),
    (16, 16),
    (24, 16),
    (32, 16),
    (40, 16),
    (48, 16),
)


def now_id() -> str:
    return time.strftime("%Y%m%d_%H%M%S")


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Deduplicate a public YOLO label-review dataset by rewriting its manifest."
    )
    parser.add_argument("--dataset-dir", required=True)
    parser.add_argument("--manifest", default="")
    parser.add_argument("--summary", default="")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--phash-threshold", type=int, default=8)
    parser.add_argument("--dhash-threshold", type=int, default=12)
    parser.add_argument("--max-bucket-scan", type=int, default=4000)
    parser.add_argument("--report-dir", default="")
    parser.add_argument("--backup-dir", default="")
    parser.add_argument("--hash-cache", default="")
    parser.add_argument("--progress-every", type=int, default=1000)
    return parser.parse_args()


def require_mode(args: argparse.Namespace) -> None:
    if args.dry_run == args.apply:
        raise SystemExit("Choose exactly one of --dry-run or --apply.")
    if args.phash_threshold < 0 or args.dhash_threshold < 0:
        raise SystemExit("Hash thresholds must be >= 0.")
    if args.max_bucket_scan <= 0:
        raise SystemExit("--max-bucket-scan must be positive.")


def read_json(path: Path, fallback: Optional[dict] = None) -> dict:
    try:
        with path.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
    except FileNotFoundError:
        return {} if fallback is None else fallback
    if isinstance(value, dict):
        return value
    return {} if fallback is None else fallback


def write_json_atomic(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{int(time.time())}.tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.replace(tmp, path)


def iter_jsonl(path: Path) -> Iterator[dict]:
    with path.open("r", encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, 1):
            text = line.strip()
            if not text:
                continue
            try:
                row = json.loads(text)
            except Exception as exc:
                raise RuntimeError(f"Invalid JSONL at {path}:{line_no}: {exc}") from exc
            if not isinstance(row, dict):
                raise RuntimeError(f"JSONL row must be object at {path}:{line_no}")
            row["_line_no"] = line_no
            yield row


def write_jsonl_atomic(path: Path, rows: Sequence[dict]) -> None:
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{int(time.time())}.tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        for row in rows:
            public = {key: value for key, value in row.items() if not key.startswith("_")}
            handle.write(json.dumps(public, ensure_ascii=False, separators=(",", ":")) + "\n")
    os.replace(tmp, path)


def resolve_dataset_path(dataset_dir: Path, value: object) -> Optional[Path]:
    text = str(value or "").strip()
    if not text:
        return None
    path = Path(text)
    if path.is_absolute():
        return path
    return (dataset_dir / text).resolve()


def image_path_for_row(dataset_dir: Path, row: dict) -> Optional[Path]:
    path = resolve_dataset_path(dataset_dir, row.get("image") or row.get("dataset_image"))
    if path and path.suffix.lower() in IMAGE_EXTENSIONS and path.exists():
        return path
    return None


def label_path_for_row(dataset_dir: Path, row: dict, image_path: Path) -> Optional[Path]:
    path = resolve_dataset_path(dataset_dir, row.get("label") or row.get("dataset_label"))
    if path and path.exists():
        return path
    try:
        rel = image_path.resolve().relative_to((dataset_dir / "images").resolve())
        candidate = (dataset_dir / "labels" / rel).with_suffix(".txt")
        return candidate if candidate.exists() else None
    except Exception:
        return None


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def dct2_ortho(matrix: np.ndarray) -> np.ndarray:
    size = matrix.shape[0]
    xs = np.arange(size, dtype=np.float32)
    basis = np.empty((size, size), dtype=np.float32)
    scale0 = math.sqrt(1.0 / size)
    scale = math.sqrt(2.0 / size)
    for k in range(size):
        basis[k, :] = (scale0 if k == 0 else scale) * np.cos((math.pi * (2 * xs + 1) * k) / (2 * size))
    return basis @ matrix @ basis.T


def phash(image_path: Path) -> int:
    with Image.open(image_path) as img:
        img = ImageOps.exif_transpose(img).convert("L").resize((32, 32), Image.Resampling.LANCZOS)
        matrix = np.asarray(img, dtype=np.float32)
    coeff = cv2.dct(matrix) if cv2 is not None else dct2_ortho(matrix)
    block = coeff[:8, :8].flatten()
    median = float(np.median(block[1:]))
    value = 0
    for bit in block > median:
        value = (value << 1) | int(bool(bit))
    return value


def dhash(image_path: Path) -> int:
    with Image.open(image_path) as img:
        img = ImageOps.exif_transpose(img).convert("L").resize((9, 8), Image.Resampling.LANCZOS)
        matrix = np.asarray(img, dtype=np.int16)
    diff = matrix[:, 1:] > matrix[:, :-1]
    value = 0
    for bit in diff.flatten():
        value = (value << 1) | int(bool(bit))
    return value


def image_size(image_path: Path) -> Tuple[int, int]:
    with Image.open(image_path) as img:
        img = ImageOps.exif_transpose(img)
        return int(img.width), int(img.height)


def hamming(left: int, right: int) -> int:
    return int(left ^ right).bit_count()


class UnionFind:
    def __init__(self, size: int):
        self.parent = list(range(size))
        self.rank = [0] * size

    def find(self, value: int) -> int:
        while self.parent[value] != value:
            self.parent[value] = self.parent[self.parent[value]]
            value = self.parent[value]
        return value

    def union(self, left: int, right: int) -> bool:
        root_left = self.find(left)
        root_right = self.find(right)
        if root_left == root_right:
            return False
        if self.rank[root_left] < self.rank[root_right]:
            root_left, root_right = root_right, root_left
        self.parent[root_right] = root_left
        if self.rank[root_left] == self.rank[root_right]:
            self.rank[root_left] += 1
        return True


def cache_key(path: Path) -> str:
    stat = path.stat()
    return f"{path.as_posix()}|{stat.st_size}|{stat.st_mtime_ns}"


def load_hash_cache(path: Path) -> Dict[str, dict]:
    cache: Dict[str, dict] = {}
    if not path.exists():
        return cache
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except Exception:
                continue
            key = str(row.get("key") or "")
            if key:
                cache[key] = row
    return cache


def append_hash_cache(path: Path, rows: Sequence[dict]) -> None:
    if not rows:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")


def hash_image(path: Path, cache: Dict[str, dict]) -> Tuple[dict, Optional[dict]]:
    key = cache_key(path)
    cached = cache.get(key)
    if cached:
        return cached, None
    width, height = image_size(path)
    row = {
        "key": key,
        "sha256": file_sha256(path),
        "phash": phash(path),
        "dhash": dhash(path),
        "width": width,
        "height": height,
    }
    cache[key] = row
    return row, row


def parse_label_counts(label_path: Optional[Path], classes: Sequence[str]) -> Tuple[int, List[str], Counter]:
    if not label_path or not label_path.exists():
        return 0, [], Counter()
    box_count = 0
    class_counts: Counter = Counter()
    image_classes = set()
    with label_path.open("r", encoding="utf-8", errors="ignore") as handle:
        for line in handle:
            parts = line.strip().split()
            if len(parts) < 5:
                continue
            try:
                class_id = int(float(parts[0]))
            except Exception:
                continue
            class_name = classes[class_id] if 0 <= class_id < len(classes) else str(class_id)
            box_count += 1
            class_counts[class_name] += 1
            image_classes.add(class_name)
    return box_count, sorted(image_classes), class_counts


def build_records(
    dataset_dir: Path,
    rows: Sequence[dict],
    classes: Sequence[str],
    hash_cache_path: Path,
    progress_every: int,
) -> Tuple[List[dict], List[dict]]:
    cache = load_hash_cache(hash_cache_path)
    pending_cache_rows = []
    records = []
    errors = []
    started = time.monotonic()
    for index, row in enumerate(rows):
        image_path = image_path_for_row(dataset_dir, row)
        if not image_path:
            errors.append({"index": index, "line": row.get("_line_no"), "error": "image_missing", "image": row.get("image", "")})
            continue
        label_path = label_path_for_row(dataset_dir, row, image_path)
        try:
            hashes, new_cache_row = hash_image(image_path, cache)
            if new_cache_row:
                pending_cache_rows.append(new_cache_row)
                if len(pending_cache_rows) >= 500:
                    append_hash_cache(hash_cache_path, pending_cache_rows)
                    pending_cache_rows = []
            label_box_count, label_classes, label_class_counts = parse_label_counts(label_path, classes)
            records.append({
                "index": index,
                "row": row,
                "image_path": image_path.as_posix(),
                "label_path": label_path.as_posix() if label_path else "",
                "sha256": str(hashes["sha256"]),
                "phash": int(hashes["phash"]),
                "dhash": int(hashes["dhash"]),
                "width": int(hashes.get("width") or 0),
                "height": int(hashes.get("height") or 0),
                "box_count": label_box_count,
                "label_classes": label_classes,
                "label_class_counts": dict(label_class_counts),
            })
        except Exception as exc:
            errors.append({
                "index": index,
                "line": row.get("_line_no"),
                "image": row.get("image", ""),
                "error": f"{type(exc).__name__}: {exc}",
            })
        if progress_every > 0 and (index + 1) % progress_every == 0:
            elapsed = max(0.001, time.monotonic() - started)
            print(json.dumps({
                "event": "hash_progress",
                "processed": index + 1,
                "total": len(rows),
                "records": len(records),
                "errors": len(errors),
                "rate_per_sec": round((index + 1) / elapsed, 2),
            }, ensure_ascii=False), flush=True)
    append_hash_cache(hash_cache_path, pending_cache_rows)
    return records, errors


def visual_keys(record: dict) -> Iterable[Tuple[str, int, int, int]]:
    for hash_name in ("phash", "dhash"):
        value = int(record[hash_name])
        for offset, width in DEFAULT_BANDS:
            mask = (1 << width) - 1
            yield hash_name, offset, width, (value >> offset) & mask


def union_exact_groups(records: Sequence[dict], uf: UnionFind) -> int:
    unions = 0
    for key_name in ("sha256", "phash_dhash"):
        grouped: Dict[object, List[int]] = defaultdict(list)
        for pos, record in enumerate(records):
            key = record["sha256"] if key_name == "sha256" else (record["phash"], record["dhash"])
            grouped[key].append(pos)
        for positions in grouped.values():
            if len(positions) <= 1:
                continue
            first = positions[0]
            for pos in positions[1:]:
                unions += int(uf.union(first, pos))
    return unions


def union_near_duplicates(records: Sequence[dict], uf: UnionFind, args: argparse.Namespace) -> dict:
    index: Dict[Tuple[str, int, int, int], List[int]] = defaultdict(list)
    checked_pairs = 0
    unions = 0
    skipped_bucket_items = 0
    started = time.monotonic()
    for pos, record in enumerate(records):
        checked_for_record = set()
        for key in visual_keys(record):
            bucket = index[key]
            scan_items = bucket[-args.max_bucket_scan:]
            skipped_bucket_items += max(0, len(bucket) - len(scan_items))
            for other_pos in scan_items:
                if other_pos in checked_for_record:
                    continue
                checked_for_record.add(other_pos)
                other = records[other_pos]
                checked_pairs += 1
                if hamming(record["phash"], other["phash"]) <= args.phash_threshold and hamming(record["dhash"], other["dhash"]) <= args.dhash_threshold:
                    unions += int(uf.union(pos, other_pos))
        for key in visual_keys(record):
            index[key].append(pos)
        if args.progress_every > 0 and (pos + 1) % args.progress_every == 0:
            elapsed = max(0.001, time.monotonic() - started)
            print(json.dumps({
                "event": "match_progress",
                "processed": pos + 1,
                "total": len(records),
                "checked_pairs": checked_pairs,
                "unions": unions,
                "rate_per_sec": round((pos + 1) / elapsed, 2),
            }, ensure_ascii=False), flush=True)
    return {
        "checked_pairs": checked_pairs,
        "near_duplicate_unions": unions,
        "skipped_bucket_items": skipped_bucket_items,
    }


def split_priority(split: str) -> int:
    return {"train": 0, "val": 1, "test": 2}.get(split, 3)


def choose_keeper(group: Sequence[dict]) -> dict:
    def score(item: dict) -> Tuple[int, int, int, int, int]:
        row = item["row"]
        return (
            -int(item.get("box_count") or row.get("box_count") or 0),
            -int(bool(row.get("is_positive"))),
            -len(item.get("label_classes") or []),
            split_priority(str(row.get("split") or row.get("dataset_split") or "")),
            int(item["index"]),
        )
    return sorted(group, key=score)[0]


def duplicate_groups_from_uf(records: Sequence[dict], uf: UnionFind) -> List[dict]:
    grouped: Dict[int, List[dict]] = defaultdict(list)
    for pos, record in enumerate(records):
        grouped[uf.find(pos)].append(record)
    groups = []
    for group in grouped.values():
        if len(group) <= 1:
            continue
        keeper = choose_keeper(group)
        duplicates = [item for item in group if item is not keeper]
        groups.append({"keeper": keeper, "duplicates": sorted(duplicates, key=lambda item: item["index"])})
    groups.sort(key=lambda item: item["keeper"]["index"])
    return groups


def read_classes(dataset_dir: Path, summary: dict) -> List[str]:
    classes_path = dataset_dir / "classes.txt"
    if classes_path.exists():
        return [line.strip() for line in classes_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    classes = summary.get("classes")
    if isinstance(classes, list):
        return [str(item) for item in classes]
    return []


def recalculate_summary(base_summary: dict, kept_records: Sequence[dict], classes: Sequence[str], report_rel: str, args: argparse.Namespace) -> dict:
    split_counts: Counter = Counter()
    positive_counts: Counter = Counter()
    boxes_by_class: Counter = Counter()
    images_by_class: Counter = Counter()
    answers: Counter = Counter()
    splits_detail: Dict[str, dict] = {}

    for record in kept_records:
        row = record["row"]
        split = str(row.get("split") or row.get("dataset_split") or "train")
        box_count = int(record.get("box_count") or 0)
        label_classes = list(record.get("label_classes") or [])
        split_counts[split] += 1
        if box_count > 0:
            positive_counts[split] += 1
            answers["YES"] += 1
        else:
            answers["NO"] += 1
        for class_name, count in (record.get("label_class_counts") or {}).items():
            boxes_by_class[class_name] += int(count)
        for class_name in label_classes:
            images_by_class[class_name] += 1

    for split in ("train", "val", "test"):
        if split_counts.get(split) or positive_counts.get(split):
            splits_detail[split] = {
                "images": split_counts.get(split, 0),
                "positive_images": positive_counts.get(split, 0),
            }

    summary = dict(base_summary)
    summary["updated_at"] = now_iso()
    summary["classes"] = list(classes)
    summary["images"] = {split: split_counts.get(split, 0) for split in ("train", "val", "test") if split_counts.get(split, 0)}
    summary["positive_images"] = {split: positive_counts.get(split, 0) for split in ("train", "val", "test") if positive_counts.get(split, 0)}
    summary["boxes"] = dict(boxes_by_class)
    summary["answers"] = {"YES": answers.get("YES", 0), "NO": answers.get("NO", 0), "NULL": 0}
    summary["by_class_yes"] = dict(images_by_class)
    summary["total_images"] = len(kept_records)
    summary["splits"] = splits_detail
    summary["training_eligible"] = False
    summary["dedupe"] = {
        "schema": "jgzj_public_yolo_manifest_dedupe.v1",
        "method": "sha256+phash+dhash_lsh",
        "phash_threshold": args.phash_threshold,
        "dhash_threshold": args.dhash_threshold,
        "max_bucket_scan": args.max_bucket_scan,
        "updated_at": summary["updated_at"],
        "report": report_rel,
    }
    ingest = dict(summary.get("ingest") or {})
    ingest["manifest_rows"] = len(kept_records)
    summary["ingest"] = ingest
    return summary


def write_reports(report_dir: Path, run_id: str, payload: dict, duplicate_groups: Sequence[dict]) -> Tuple[Path, Path]:
    report_dir.mkdir(parents=True, exist_ok=True)
    json_path = report_dir / f"public_dedupe_report_{run_id}.json"
    csv_path = report_dir / f"public_dedupe_duplicates_{run_id}.csv"
    write_json_atomic(json_path, payload)
    with csv_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=[
            "group_id",
            "action",
            "split",
            "is_positive",
            "box_count",
            "label_classes",
            "image",
            "label",
            "keeper_image",
            "keeper_box_count",
        ])
        writer.writeheader()
        for group_id, group in enumerate(duplicate_groups, 1):
            keeper = group["keeper"]
            keeper_row = keeper["row"]
            writer.writerow({
                "group_id": group_id,
                "action": "keep",
                "split": keeper_row.get("split", ""),
                "is_positive": keeper_row.get("is_positive", ""),
                "box_count": keeper.get("box_count", ""),
                "label_classes": ",".join(keeper.get("label_classes") or []),
                "image": keeper_row.get("image", ""),
                "label": keeper_row.get("label", ""),
                "keeper_image": keeper_row.get("image", ""),
                "keeper_box_count": keeper.get("box_count", ""),
            })
            for duplicate in group["duplicates"]:
                duplicate_row = duplicate["row"]
                writer.writerow({
                    "group_id": group_id,
                    "action": "remove_from_manifest",
                    "split": duplicate_row.get("split", ""),
                    "is_positive": duplicate_row.get("is_positive", ""),
                    "box_count": duplicate.get("box_count", ""),
                    "label_classes": ",".join(duplicate.get("label_classes") or []),
                    "image": duplicate_row.get("image", ""),
                    "label": duplicate_row.get("label", ""),
                    "keeper_image": keeper_row.get("image", ""),
                    "keeper_box_count": keeper.get("box_count", ""),
                })
    return json_path, csv_path


def backup_inputs(manifest_path: Path, summary_path: Path, backup_dir: Path) -> dict:
    backup_dir.mkdir(parents=True, exist_ok=True)
    manifest_backup = backup_dir / manifest_path.name
    summary_backup = backup_dir / summary_path.name
    shutil.copy2(manifest_path, manifest_backup)
    if summary_path.exists():
        shutil.copy2(summary_path, summary_backup)
    return {
        "backup_dir": backup_dir.as_posix(),
        "manifest": manifest_backup.as_posix(),
        "summary": summary_backup.as_posix() if summary_path.exists() else "",
    }


def main() -> int:
    args = parse_args()
    require_mode(args)
    dataset_dir = Path(args.dataset_dir).resolve()
    manifest_path = Path(args.manifest).resolve() if args.manifest else dataset_dir / "manifest_selected_images.jsonl"
    summary_path = Path(args.summary).resolve() if args.summary else dataset_dir / "dataset_summary.json"
    report_dir = Path(args.report_dir).resolve() if args.report_dir else dataset_dir / "dedupe_reports"
    backup_root = Path(args.backup_dir).resolve() if args.backup_dir else dataset_dir / ".dedupe_backups"
    hash_cache_path = Path(args.hash_cache).resolve() if args.hash_cache else report_dir / "public_dedupe_hash_cache.jsonl"
    run_id = now_id()
    run_backup_dir = backup_root / run_id

    if not dataset_dir.exists():
        raise SystemExit(f"Dataset dir not found: {dataset_dir}")
    if not manifest_path.exists():
        raise SystemExit(f"Manifest not found: {manifest_path}")

    started = time.monotonic()
    summary = read_json(summary_path, {})
    classes = read_classes(dataset_dir, summary)
    rows = list(iter_jsonl(manifest_path))
    print(json.dumps({
        "event": "start",
        "mode": "apply" if args.apply else "dry_run",
        "dataset_dir": dataset_dir.as_posix(),
        "manifest": manifest_path.as_posix(),
        "rows": len(rows),
        "classes": classes,
        "phash_threshold": args.phash_threshold,
        "dhash_threshold": args.dhash_threshold,
    }, ensure_ascii=False), flush=True)

    records, errors = build_records(dataset_dir, rows, classes, hash_cache_path, args.progress_every)
    uf = UnionFind(len(records))
    exact_unions = union_exact_groups(records, uf)
    near_stats = union_near_duplicates(records, uf, args)
    duplicate_groups = duplicate_groups_from_uf(records, uf)
    duplicate_indices = {item["index"] for group in duplicate_groups for item in group["duplicates"]}
    record_by_index = {item["index"]: item for item in records}
    kept_rows = [row for idx, row in enumerate(rows) if idx not in duplicate_indices]
    kept_records = [record_by_index[idx] for idx in range(len(rows)) if idx not in duplicate_indices and idx in record_by_index]
    removed_rows = [row for idx, row in enumerate(rows) if idx in duplicate_indices]
    missing_or_error_kept = len(kept_rows) - len(kept_records)

    payload = {
        "schema": "jgzj_public_yolo_manifest_dedupe_report.v1",
        "run_id": run_id,
        "mode": "apply" if args.apply else "dry_run",
        "dataset_dir": dataset_dir.as_posix(),
        "manifest": manifest_path.as_posix(),
        "summary": summary_path.as_posix(),
        "classes": classes,
        "method": "sha256+phash+dhash_lsh",
        "phash_threshold": args.phash_threshold,
        "dhash_threshold": args.dhash_threshold,
        "max_bucket_scan": args.max_bucket_scan,
        "original_rows": len(rows),
        "hashed_records": len(records),
        "kept_rows": len(kept_rows),
        "removed_rows": len(removed_rows),
        "missing_or_error_kept": missing_or_error_kept,
        "duplicate_group_count": len(duplicate_groups),
        "duplicate_image_count": len(removed_rows),
        "exact_unions": exact_unions,
        "near_stats": near_stats,
        "error_count": len(errors),
        "errors": errors[:200],
        "started_at": now_iso(),
        "duration_seconds_before_apply": round(time.monotonic() - started, 3),
    }
    report_json, report_csv = write_reports(report_dir, run_id, payload, duplicate_groups)
    payload["report_json"] = report_json.as_posix()
    payload["report_csv"] = report_csv.as_posix()

    if args.apply:
        if errors:
            payload["apply_skipped_reason"] = "errors_present"
            payload["duration_seconds_total"] = round(time.monotonic() - started, 3)
            write_json_atomic(report_json, payload)
            raise RuntimeError(f"Refusing to apply with {len(errors)} manifest/image errors; see {report_json}")
        payload["backup"] = backup_inputs(manifest_path, summary_path, run_backup_dir)
        write_jsonl_atomic(manifest_path, kept_rows)
        report_rel = os.path.relpath(report_json, summary_path.parent)
        new_summary = recalculate_summary(summary, kept_records, classes, report_rel, args)
        write_json_atomic(summary_path, new_summary)
        payload["applied_at"] = now_iso()
        payload["duration_seconds_total"] = round(time.monotonic() - started, 3)
        write_json_atomic(report_json, payload)
    else:
        payload["duration_seconds_total"] = round(time.monotonic() - started, 3)
        write_json_atomic(report_json, payload)

    print(json.dumps({
        "ok": True,
        "mode": payload["mode"],
        "original_rows": payload["original_rows"],
        "kept_rows": payload["kept_rows"],
        "removed_rows": payload["removed_rows"],
        "duplicate_group_count": payload["duplicate_group_count"],
        "error_count": payload["error_count"],
        "report_json": payload["report_json"],
        "report_csv": payload["report_csv"],
        "backup": payload.get("backup", {}),
        "duration_seconds_total": payload["duration_seconds_total"],
    }, ensure_ascii=False, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise
    except Exception as exc:
        print(json.dumps({"ok": False, "error": type(exc).__name__, "detail": str(exc)}, ensure_ascii=False), file=sys.stderr, flush=True)
        raise SystemExit(1)
