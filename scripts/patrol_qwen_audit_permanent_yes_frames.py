#!/usr/bin/env python3
import argparse
import concurrent.futures
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from patrol_qwen_bbox_audit import (
    AUDIT_PROMPT,
    MODEL,
    MODEL_BUNDLE,
    PROMPT_VERSION,
    SCHEMA,
    audit_one,
    cache_has_valid_audit,
    cache_path,
    load_image_list,
    load_json,
    load_label_cache,
    log,
    normalize_class_name,
    normalize_rel,
    row_priority,
    sha256_file,
)


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
SOURCE = "qwen_permanent_yes_frame"


def ms_to_iso(value):
    try:
        ms = int(value)
    except Exception:
        return None
    return datetime.fromtimestamp(ms / 1000.0, timezone.utc).isoformat().replace("+00:00", "Z")


def permanent_image_for_meta(meta_path, meta, permanent_root):
    rel = normalize_rel(meta.get("permanent_image_path"))
    image_path = permanent_root / rel if rel else meta_path.with_suffix("")
    if not image_path.exists() or image_path.suffix.lower() not in IMAGE_EXTENSIONS:
        return None
    return image_path


def iter_rows(permanent_root, source, day):
    for meta_path in sorted(permanent_root.glob("**/*.json")):
        meta = load_json(meta_path)
        if not isinstance(meta, dict):
            continue
        image_path = permanent_image_for_meta(meta_path, meta, permanent_root)
        if image_path is None:
            continue
        day_name = image_path.parent.name
        if day and day_name != day:
            continue

        row_source = meta.get("source") or SOURCE
        if source and row_source != source:
            continue

        image_rel = normalize_rel(image_path.relative_to(permanent_root))
        image_sha = meta.get("image_sha256") or sha256_file(image_path)
        received_at_ms = meta.get("received_at_ms") or meta.get("edge_ts")
        normalized_meta = {
            **meta,
            "source": row_source,
            "image_sha256": image_sha,
            "image_path": image_rel,
            "source_image_path": meta.get("image_path"),
            "vehicle_id": meta.get("vehicle_id") or meta.get("device_id"),
            "device_id": meta.get("device_id"),
            "camera_id": meta.get("camera_id"),
            "collected_at": meta.get("collected_at") or ms_to_iso(received_at_ms),
            "collected_at_ms": received_at_ms,
            "qwen_yes_tasks": meta.get("yes_tasks") or [],
            "qwen_archived_at": meta.get("archived_at"),
        }
        yield {
            "meta_path": meta_path,
            "image_path": image_path,
            "image_rel": image_rel,
            "meta": normalized_meta,
        }


def build_rows(args):
    image_filter = load_image_list(args.image_list)
    class_filter = {
        normalize_class_name(item)
        for value in args.class_filter
        for item in str(value or "").split(",")
        if normalize_class_name(item)
    }
    rows = []
    scanned = 0
    for row in iter_rows(args.permanent_root, args.source, args.day):
        if image_filter is not None and row["image_rel"] not in image_filter:
            continue
        scanned += 1
        label_payload, labels = load_label_cache(row, args.label_root)
        if label_payload is None:
            continue
        if not labels and not args.include_empty:
            continue
        if class_filter and not any(label["class"] in class_filter for label in labels):
            continue
        out_path = cache_path(args.output_root, row["meta"].get("image_sha256"))
        if args.only_missing and not args.refresh and out_path and cache_has_valid_audit(out_path):
            continue
        label_path = cache_path(args.label_root, row["meta"].get("image_sha256"))
        rows.append({
            **row,
            "label_payload": label_payload,
            "label_path": label_path,
            "labels": labels,
        })
    rows.sort(key=lambda item: (row_priority(item), str(item["meta"].get("collected_at") or "")), reverse=True)
    return scanned, rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--permanent-root",
        type=Path,
        default=Path("/home/admin1/qwen-vl-infer/data/qwen_ws_checker_archive/permanent_yes_frames"),
    )
    parser.add_argument(
        "--label-root",
        type=Path,
        default=Path("/home/admin1/jgzj/.runtime/yolo_label_review/qwen_permanent_yes_bbox_labels_v1"),
    )
    parser.add_argument(
        "--output-root",
        type=Path,
        default=Path("/home/admin1/jgzj/.runtime/yolo_label_review/qwen_permanent_yes_bbox_audits_v1"),
    )
    parser.add_argument("--service-url", default="http://127.0.0.1:18016")
    parser.add_argument("--source", default=SOURCE)
    parser.add_argument("--day", default="", help="Optional permanent image day directory, e.g. 20260709.")
    parser.add_argument("--class-filter", action="append", default=[])
    parser.add_argument("--include-empty", action="store_true")
    parser.add_argument("--only-missing", action="store_true")
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--heuristic-only", action="store_true")
    parser.add_argument("--store-raw", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--max-side", type=int, default=960)
    parser.add_argument("--jpeg-quality", type=int, default=82)
    parser.add_argument("--timeout-s", type=int, default=120)
    parser.add_argument("--max-tokens", type=int, default=768)
    parser.add_argument("--prompt-version", default=PROMPT_VERSION)
    parser.add_argument("--prompt-file", type=Path, default=None)
    parser.add_argument("--prompt-extra", default="")
    parser.add_argument("--image-list", type=Path, default=None)
    args = parser.parse_args()

    if not args.permanent_root.exists():
        log(f"permanent_root_missing={args.permanent_root}")
        return 0

    args.frames_root = args.permanent_root

    prompt = AUDIT_PROMPT
    if args.prompt_file:
        prompt = args.prompt_file.read_text(encoding="utf-8")
    if args.prompt_extra:
        prompt = f"{prompt}\n\nExtra audit instruction:\n{args.prompt_extra.strip()}"

    scanned, rows = build_rows(args)
    source_rows = len(rows)
    if args.limit > 0:
        rows = rows[:args.limit]
    log(
        f"scanned={scanned} candidate_rows={source_rows} rows={len(rows)} only_missing={args.only_missing} "
        f"class_filter={','.join(args.class_filter) or 'all'} day={args.day or 'all'} "
        f"workers={args.workers} output={args.output_root}"
    )

    counts = {}
    started = time.time()
    if args.workers <= 1:
        for idx, row in enumerate(rows, 1):
            try:
                status = audit_one(row, args, prompt)
            except KeyboardInterrupt:
                raise
            except Exception as exc:
                status = f"error:{type(exc).__name__}:{exc}"
            key = ":".join(status.split(":", 3)[:3])
            counts[key] = counts.get(key, 0) + 1
            if idx == 1 or idx % 10 == 0 or idx == len(rows):
                elapsed = max(0.001, time.time() - started)
                log(f"{idx}/{len(rows)} {status} rate={idx/elapsed:.2f}/s counts={counts}")
        return 0

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(audit_one, row, args, prompt): idx for idx, row in enumerate(rows, 1)}
        done = 0
        for future in concurrent.futures.as_completed(futures):
            done += 1
            try:
                status = future.result()
            except KeyboardInterrupt:
                raise
            except Exception as exc:
                status = f"error:{type(exc).__name__}:{exc}"
            key = ":".join(status.split(":", 3)[:3])
            counts[key] = counts.get(key, 0) + 1
            if done == 1 or done % 10 == 0 or done == len(rows):
                elapsed = max(0.001, time.time() - started)
                log(f"{done}/{len(rows)} {status} rate={done/elapsed:.2f}/s counts={counts}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
