#!/usr/bin/env python3
import argparse
import concurrent.futures
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from patrol_qwen_label_vehicle_uploads import (
    MODEL,
    MODEL_BUNDLE,
    SCHEMA,
    cache_has_qwen_bbox,
    cache_path,
    call_qwen,
    encode_image,
    extract_json,
    load_image_list,
    load_json,
    log,
    normalize_annotation,
    normalize_rel,
    save_json_atomic,
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
    if rel:
        image_path = permanent_root / rel
    else:
        image_path = meta_path.with_suffix("")
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
        collected_at = meta.get("collected_at") or ms_to_iso(received_at_ms)
        normalized_meta = {
            **meta,
            "source": row_source,
            "image_sha256": image_sha,
            "image_path": image_rel,
            "source_image_path": meta.get("image_path"),
            "image_url": "",
            "vehicle_id": meta.get("vehicle_id") or meta.get("device_id"),
            "device_id": meta.get("device_id"),
            "camera_id": meta.get("camera_id"),
            "collected_at": collected_at,
            "collected_at_ms": received_at_ms,
            "capture_id": meta.get("request_id"),
            "sample_id": meta.get("request_id"),
            "qwen_yes_tasks": meta.get("yes_tasks") or [],
            "qwen_archived_at": meta.get("archived_at"),
        }
        yield {
            "meta_path": meta_path,
            "image_path": image_path,
            "image_rel": image_rel,
            "meta": normalized_meta,
        }


def annotate_one(row, args):
    meta = row["meta"]
    out_path = cache_path(args.output_root, meta.get("image_sha256"))
    if out_path is None:
        return "skip:no_sha"
    if out_path.exists() and not args.refresh and cache_has_qwen_bbox(out_path):
        return "skip:cached"

    started = time.time()
    image_b64, image_request = encode_image(row["image_path"], args.max_side, args.jpeg_quality)
    response = call_qwen(args.service_url, image_b64, args.timeout_s, args.max_tokens)
    choice = (response.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    raw_text = message.get("content") or message.get("reasoning") or ""
    parsed = extract_json(raw_text)
    quality, labels = normalize_annotation(parsed)
    parse_ok = quality is not None
    if not parse_ok:
        quality = "bad"
        labels = []

    payload = {
        "schema": SCHEMA,
        "image_sha256": meta.get("image_sha256"),
        "image_path": row["image_rel"],
        "source": meta.get("source") or SOURCE,
        "vehicle_id": meta.get("vehicle_id"),
        "device_id": meta.get("device_id"),
        "camera_id": meta.get("camera_id"),
        "collected_at": meta.get("collected_at"),
        "meta_path": normalize_rel(row["meta_path"].relative_to(args.permanent_root)),
        "annotated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "model": MODEL,
        "model_bundle": MODEL_BUNDLE,
        "service_url": args.service_url,
        "image_request": image_request,
        "ok": True,
        "quality": quality,
        "labels": labels,
        "parse_ok": parse_ok,
        "terminal_empty": not parse_ok,
        "raw_json": parsed if args.store_raw else None,
        "raw_text": raw_text if (args.store_raw or not parse_ok or choice.get("finish_reason") == "length") else "",
        "finish_reason": choice.get("finish_reason"),
        "duration_ms": int((time.time() - started) * 1000),
        "qwen_permanent": {
            "request_id": meta.get("request_id"),
            "archived_at": meta.get("qwen_archived_at"),
            "yes_tasks": meta.get("qwen_yes_tasks") or [],
            "source_image_path": meta.get("source_image_path"),
        },
    }
    save_json_atomic(out_path, payload)
    return f"ok:{len(labels)}" if parse_ok else "ok:terminal_empty_parse"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--permanent-root",
        type=Path,
        default=Path("/home/admin1/qwen-vl-infer/data/qwen_ws_checker_archive/permanent_yes_frames"),
    )
    parser.add_argument(
        "--output-root",
        type=Path,
        default=Path("/home/admin1/jgzj/.runtime/yolo_label_review/qwen_permanent_yes_bbox_labels_v1"),
    )
    parser.add_argument("--service-url", default="http://127.0.0.1:18016")
    parser.add_argument("--source", default=SOURCE)
    parser.add_argument("--day", default="", help="Optional permanent image day directory, e.g. 20260709.")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--store-raw", action="store_true")
    parser.add_argument("--max-side", type=int, default=960)
    parser.add_argument("--jpeg-quality", type=int, default=82)
    parser.add_argument("--timeout-s", type=int, default=120)
    parser.add_argument("--max-tokens", type=int, default=768)
    parser.add_argument("--only-missing", action="store_true")
    parser.add_argument("--image-list", type=Path, default=None, help="Optional image_path list relative to permanent root.")
    args = parser.parse_args()

    if not args.permanent_root.exists():
        log(f"permanent_root_missing={args.permanent_root}")
        return 0

    rows = list(iter_rows(args.permanent_root, args.source, args.day))
    image_filter = load_image_list(args.image_list)
    if image_filter is not None:
        rows = [row for row in rows if row["image_rel"] in image_filter]
    rows.sort(key=lambda row: str(row["meta"].get("collected_at") or ""), reverse=True)
    source_rows = len(rows)
    if args.only_missing and not args.refresh:
        rows = [
            row for row in rows
            if (
                cache_path(args.output_root, row["meta"].get("image_sha256")) is not None
                and not cache_has_qwen_bbox(cache_path(args.output_root, row["meta"].get("image_sha256")))
            )
        ]
    if args.limit > 0:
        rows = rows[:args.limit]

    log(
        f"source_rows={source_rows} rows={len(rows)} only_missing={args.only_missing} "
        f"source={args.source or 'all'} day={args.day or 'all'} workers={args.workers} output={args.output_root}"
    )

    counts = {}
    started = time.time()
    if args.workers <= 1:
        for idx, row in enumerate(rows, 1):
            try:
                status = annotate_one(row, args)
            except KeyboardInterrupt:
                raise
            except Exception as exc:
                status = f"error:{type(exc).__name__}:{exc}"
            key = status.split(":", 1)[0]
            counts[key] = counts.get(key, 0) + 1
            if idx == 1 or idx % 10 == 0 or idx == len(rows):
                elapsed = max(0.001, time.time() - started)
                log(f"{idx}/{len(rows)} {status} rate={idx/elapsed:.2f}/s counts={counts}")
        return 0

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(annotate_one, row, args): idx for idx, row in enumerate(rows, 1)}
        done = 0
        for future in concurrent.futures.as_completed(futures):
            done += 1
            try:
                status = future.result()
            except KeyboardInterrupt:
                raise
            except Exception as exc:
                status = f"error:{type(exc).__name__}:{exc}"
            key = status.split(":", 1)[0]
            counts[key] = counts.get(key, 0) + 1
            if done == 1 or done % 10 == 0 or done == len(rows):
                elapsed = max(0.001, time.time() - started)
                log(f"{done}/{len(rows)} {status} rate={done/elapsed:.2f}/s counts={counts}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
