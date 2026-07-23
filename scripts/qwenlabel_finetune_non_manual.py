#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import sys
import tempfile
import threading
import time
from collections import Counter
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from label_fire_smoke_candidates_qwen import (  # noqa: E402
    AUDIT_PROMPT,
    DETECT_PROMPT,
    chat,
    encode_image,
    normalize_boxes,
    retry_session,
    yolo_text,
)


CLASSES = ("fire", "smoke")
POSITIVE_CATEGORIES = {"normal_positive", "hard_positive"}
NEGATIVE_CATEGORIES = {"normal_negative", "hard_negative"}
DEFAULT_MANUAL_ROOT = Path(".runtime/yolo_label_review/manual_annotations_v1")
DEFAULT_DATASET_ID = "loop:fire_smoke_finetune_20260721_170647"
THREAD_LOCAL = threading.local()


def now_id() -> str:
    return time.strftime("%Y%m%d_%H%M%S")


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def read_jsonl(path: Path) -> list[dict]:
    rows = []
    with path.open("r", encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, 1):
            text = line.strip()
            if not text:
                continue
            row = json.loads(text)
            row["_line_no"] = line_no
            rows.append(row)
    return rows


def write_jsonl_atomic(path: Path, rows: list[dict]) -> None:
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            for row in rows:
                public = {key: value for key, value in row.items() if not key.startswith("_")}
                handle.write(json.dumps(public, ensure_ascii=False, separators=(",", ":")) + "\n")
        os.replace(tmp_name, path)
    finally:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass


def read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def write_json_atomic(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(tmp_name, path)
    finally:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass


def jsonable_payload(payload: dict, *, compact: bool = False) -> dict:
    skipped = {"new_label_text"}
    if compact:
        skipped.update({"qwen", "old_text"})
    out = {}
    for key, value in payload.items():
        if key in skipped:
            continue
        if isinstance(value, Path):
            out[key] = value.as_posix()
        else:
            out[key] = value
    return out


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def resolve_path(dataset_dir: Path, value: object) -> Path | None:
    if not value:
        return None
    path = Path(str(value))
    if not path.is_absolute():
        path = dataset_dir / path
    return path


def rel_to_dataset(dataset_dir: Path, path: Path | None) -> str:
    if not path:
        return ""
    try:
        return path.resolve().relative_to(dataset_dir.resolve()).as_posix()
    except Exception:
        return path.name


def item_key_for_row(dataset_dir: Path, row: dict) -> str:
    image_path = resolve_path(dataset_dir, row.get("dataset_image") or row.get("image"))
    return rel_to_dataset(dataset_dir, image_path)


def load_manual_review_statuses(manual_root: Path, dataset_id: str) -> dict[str, dict]:
    statuses = {}
    if not manual_root.exists():
        return statuses
    for path in manual_root.glob("*/*.json"):
        payload = read_json(path)
        if not payload or str(payload.get("dataset_id") or "") != str(dataset_id or ""):
            continue
        item_key = str(payload.get("item_key") or "").replace("\\", "/").lstrip("/")
        if not item_key:
            continue
        verdict = str(payload.get("review_verdict") or "missing").strip().lower()
        if payload.get("deleted"):
            verdict = "deleted"
        statuses[item_key] = {
            "verdict": verdict or "missing",
            "path": path.as_posix(),
            "annotation": payload,
        }
    return statuses


def selected_for_relabel(row: dict, selector: str) -> bool:
    source = str(row.get("source") or "")
    label_mode = str(row.get("label_mode") or "")
    review_verdict = str(row.get("_review_verdict") or "missing").strip().lower()
    if selector == "empty":
        return label_mode == "empty"
    if selector == "non-copy":
        return label_mode != "copy"
    if selector == "non-original":
        return source != "original_dataset"
    if selector == "review-not-pass":
        return review_verdict != "pass"
    raise ValueError(f"unknown selector: {selector}")


def qwen_session(args: argparse.Namespace):
    session = getattr(THREAD_LOCAL, "session", None)
    if session is None:
        session = retry_session(args.api_key)
        THREAD_LOCAL.session = session
    return session


def qwenlabel_one(session, image_path: Path, args: argparse.Namespace) -> dict:
    image_b64, image_meta = encode_image(image_path, args.max_side, args.jpeg_quality)
    parsed, raw_text = chat(
        session,
        args.endpoint,
        args.model,
        DETECT_PROMPT,
        image_b64,
        (args.connect_timeout, args.read_timeout),
        args.max_tokens,
    )
    if parsed is None:
        raise ValueError(f"detect_json_parse_failed:{raw_text[:500]}")
    photo_type = str(parsed.get("photo") or "unknown").strip().lower()
    domain = str(parsed.get("domain") or "off_domain").strip().lower()
    scene = str(parsed.get("scene") or "unusable").strip().lower()
    domain_usable = photo_type == "real_photo" and domain == "target"
    if not domain_usable:
        scene = "unusable"
    detected_labels = normalize_boxes(parsed.get("b") or parsed.get("boxes")) if domain_usable else []

    audit_parsed = None
    audit_raw = ""
    audit_verdict = "not_run"
    labels = detected_labels
    if not args.no_audit and scene != "unusable":
        proposal = json.dumps(
            {
                "q": parsed.get("q"),
                "photo": photo_type,
                "domain": domain,
                "scene": scene,
                "b": parsed.get("b") or parsed.get("boxes") or [],
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
        audit_prompt = AUDIT_PROMPT.replace("{proposal}", proposal)
        audit_parsed, audit_raw = chat(
            session,
            args.endpoint,
            args.model,
            audit_prompt,
            image_b64,
            (args.connect_timeout, args.read_timeout),
            args.max_tokens,
        )
        if audit_parsed is None:
            audit_verdict = "error"
            labels = []
        else:
            audit_verdict = str(audit_parsed.get("v") or "needs_human").strip().lower()
            audit_photo = str(audit_parsed.get("photo") or "unknown").strip().lower()
            audit_domain = str(audit_parsed.get("domain") or "off_domain").strip().lower()
            audit_scene = str(audit_parsed.get("scene") or scene).strip().lower()
            usable = audit_verdict == "pass" and audit_photo == "real_photo" and audit_domain == "target" and audit_scene != "unusable"
            labels = normalize_boxes(audit_parsed.get("b") or audit_parsed.get("boxes")) if usable else []
            photo_type = audit_photo
            domain = audit_domain
            scene = "positive" if labels else ("unusable" if audit_scene == "unusable" else "hard_negative")

    if labels:
        scene = "positive"
    elif scene not in {"hard_negative", "unusable"}:
        scene = "hard_negative"

    return {
        "ok": True,
        "image_request": image_meta,
        "detect": {"parsed": parsed, "raw": raw_text[:8000], "accepted_labels": detected_labels},
        "audit": {"verdict": audit_verdict, "parsed": audit_parsed, "raw": audit_raw[:8000]},
        "photo_type": photo_type,
        "domain": domain,
        "scene": scene,
        "labels": labels,
    }


def backup_file(dataset_dir: Path, backup_root: Path, path: Path) -> str:
    rel = rel_to_dataset(dataset_dir, path)
    dest = backup_root / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        dest.write_bytes(path.read_bytes())
    else:
        dest.write_text("", encoding="utf-8")
    return dest.as_posix()


def label_box_count(path: Path | None) -> int:
    if not path or not path.exists():
        return 0
    return sum(1 for line in path.read_text(encoding="utf-8").splitlines() if line.strip())


def read_classes(dataset_dir: Path, summary: dict) -> list[str]:
    classes_path = dataset_dir / "classes.txt"
    if classes_path.exists():
        return [line.strip() for line in classes_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    classes = summary.get("classes")
    if isinstance(classes, list):
        return [str(item) for item in classes]
    return list(CLASSES)


def update_summary(summary_path: Path, dataset_dir: Path, rows: list[dict], run_summary: dict) -> None:
    summary = read_json(summary_path)
    classes = read_classes(dataset_dir, summary)
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
        label_path = resolve_path(dataset_dir, row.get("dataset_label") or row.get("label"))
        if not label_path or not label_path.exists():
            continue
        for line in label_path.read_text(encoding="utf-8").splitlines():
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

    splits = ("train", "val", "test")
    category_counts = Counter(str(row.get("category") or "unknown") for row in rows)
    source_counts = Counter(str(row.get("source") or "unknown") for row in rows)
    positive_total = sum(category_counts.get(item, 0) for item in POSITIVE_CATEGORIES)
    negative_total = sum(category_counts.get(item, 0) for item in NEGATIVE_CATEGORIES)

    summary["updated_at"] = now_iso()
    summary["images"] = {split: split_counts.get(split, 0) for split in splits if split_counts.get(split, 0)}
    summary["positive_images"] = {split: positive_split_counts.get(split, 0) for split in splits if positive_split_counts.get(split, 0)}
    summary["empty_images"] = {split: negative_split_counts.get(split, 0) for split in splits if negative_split_counts.get(split, 0)}
    summary["boxes"] = {split: boxes_by_split.get(split, 0) for split in splits if boxes_by_split.get(split, 0)}
    summary["boxes_by_class_split"] = {
        name: {split: counter.get(split, 0) for split in splits if counter.get(split, 0)}
        for name, counter in boxes_by_class_split.items()
        if sum(counter.values()) > 0
    }
    summary["by_class_yes"] = dict(boxes_by_class)
    summary["answers"] = {"YES": positive_total, "NO": negative_total, "NULL": 0}
    summary["total_images"] = len(rows)
    summary["source_counts"] = dict(source_counts)
    summary["category_counts"] = dict(category_counts)
    summary["source_bucket_counts"] = dict(Counter(str(row.get("source_bucket") or "unknown") for row in rows))
    summary["manifest_split_counts"] = dict(Counter(str(row.get("dataset_split") or "unknown") for row in rows))
    summary["reason_counts"] = dict(Counter(str(row.get("reason") or "unknown") for row in rows))
    summary["label_mode_counts"] = dict(Counter(str(row.get("label_mode") or "unknown") for row in rows))
    summary["qwenlabel_relabel"] = run_summary
    write_json_atomic(summary_path, summary)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Relabel non-manual finetune samples with Qwen Labeler and overwrite YOLO labels.")
    parser.add_argument("--dataset-dir", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, default=None)
    parser.add_argument("--summary", type=Path, default=None)
    parser.add_argument("--manual-root", type=Path, default=DEFAULT_MANUAL_ROOT)
    parser.add_argument("--dataset-id", default=DEFAULT_DATASET_ID)
    parser.add_argument("--endpoint", default="http://127.0.0.1:18016")
    parser.add_argument("--model", default="Qwen3.6-27B-Labeler")
    parser.add_argument("--api-key", default=os.environ.get("QWEN_LABELER_API_KEY", ""))
    parser.add_argument("--selector", choices=("non-original", "non-copy", "empty", "review-not-pass"), default="non-original")
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--max-side", type=int, default=1600)
    parser.add_argument("--jpeg-quality", type=int, default=90)
    parser.add_argument("--max-tokens", type=int, default=900)
    parser.add_argument("--connect-timeout", type=float, default=10.0)
    parser.add_argument("--read-timeout", type=float, default=180.0)
    parser.add_argument("--no-audit", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--apply", action="store_true")
    return parser.parse_args()


def prepare_selected_row(dataset_dir: Path, row: dict) -> dict:
    image_path = resolve_path(dataset_dir, row.get("dataset_image") or row.get("image"))
    label_path = resolve_path(dataset_dir, row.get("dataset_label") or row.get("label"))
    if not image_path or not label_path:
        raise ValueError("missing_image_or_label_path")
    return {
        "line": row.get("_line_no"),
        "item_key": row.get("_item_key") or item_key_for_row(dataset_dir, row),
        "image_path": image_path,
        "label_path": label_path,
        "image_sha256": sha256_file(image_path),
        "old_text": label_path.read_text(encoding="utf-8") if label_path.exists() else "",
        "old_box_count": label_box_count(label_path),
        "previous_category": row.get("category"),
        "previous_label_mode": row.get("label_mode"),
        "previous_reason": row.get("reason"),
        "review_verdict": row.get("_review_verdict"),
        "review_annotation_path": row.get("_review_annotation_path"),
    }


def process_one(prepared: dict, args: argparse.Namespace) -> dict:
    result = qwenlabel_one(qwen_session(args), prepared["image_path"], args)
    labels = result["labels"]
    return {
        "ok": True,
        **prepared,
        "new_category": "hard_positive" if labels else "hard_negative",
        "new_label_mode": "override" if labels else "empty",
        "new_reason": "qwenlabel_relabel_positive" if labels else "qwenlabel_relabel_empty",
        "new_label_text": yolo_text(labels),
        "new_box_count": len(labels),
        "scene": result.get("scene"),
        "audit_verdict": (result.get("audit") or {}).get("verdict"),
        "qwen": result,
    }


def main() -> None:
    args = parse_args()
    if args.dry_run == args.apply:
        raise SystemExit("Choose exactly one of --dry-run or --apply.")
    dataset_dir = args.dataset_dir.resolve()
    manifest_path = (args.manifest or dataset_dir / "samples_manifest.jsonl").resolve()
    rows = read_jsonl(manifest_path)
    manual_statuses = load_manual_review_statuses(args.manual_root.resolve(), args.dataset_id)
    for row in rows:
        item_key = item_key_for_row(dataset_dir, row)
        manual = manual_statuses.get(item_key)
        row["_item_key"] = item_key
        row["_review_verdict"] = manual["verdict"] if manual else "missing"
        row["_review_annotation_path"] = manual["path"] if manual else ""

    selected = [row for row in rows if selected_for_relabel(row, args.selector)]
    if args.limit > 0:
        selected = selected[:args.limit]
    missing = []
    for row in selected:
        image_path = resolve_path(dataset_dir, row.get("dataset_image") or row.get("image"))
        label_path = resolve_path(dataset_dir, row.get("dataset_label") or row.get("label"))
        if not image_path or not image_path.exists() or not label_path:
            missing.append({"line": row.get("_line_no"), "image": str(image_path), "label": str(label_path)})

    if args.dry_run:
        print(json.dumps({
            "ok": True,
            "mode": "dry_run",
            "selector": args.selector,
            "total_rows": len(rows),
            "selected_rows": len(selected),
            "missing": missing[:20],
            "review_verdict_counts": dict(Counter(str(row.get("_review_verdict") or "missing") for row in rows)),
            "selected_review_verdict_counts": dict(Counter(str(row.get("_review_verdict") or "missing") for row in selected)),
            "category_counts": dict(Counter(str(row.get("category") or "unknown") for row in selected)),
            "source_counts": dict(Counter(str(row.get("source") or "unknown") for row in selected)),
            "label_mode_counts": dict(Counter(str(row.get("label_mode") or "unknown") for row in selected)),
            "split_counts": dict(Counter(str(row.get("dataset_split") or "unknown") for row in selected)),
        }, ensure_ascii=False, indent=2))
        return

    if missing:
        raise SystemExit(json.dumps({"ok": False, "error": "missing_selected_paths", "missing": missing[:20]}, ensure_ascii=False))

    run_id = now_id()
    report_root = dataset_dir / "qwenlabel_relabel_reports" / run_id
    backup_root = report_root / "label_backup"
    cache_root = report_root / "qwen_cache"
    progress_path = report_root / "progress.jsonl"
    report_root.mkdir(parents=True, exist_ok=True)
    backup_file(dataset_dir, report_root / "manifest_backup", manifest_path)
    if args.summary:
        backup_file(args.summary.resolve().parent, report_root / "summary_backup", args.summary.resolve())

    results = []
    counts = Counter()
    started = time.time()
    prepared_by_line = {row.get("_line_no"): prepare_selected_row(dataset_dir, row) for row in selected}
    row_by_line = {row.get("_line_no"): row for row in selected}

    def handle_payload(payload: dict, idx: int) -> None:
        line = payload.get("line")
        row = row_by_line.get(line)
        prepared = prepared_by_line.get(line) or payload
        label_path = prepared.get("label_path")
        image_sha = prepared.get("image_sha256") or ""
        cache_path = cache_root / image_sha[:2] / f"{image_sha}.json"
        if payload.get("ok") and row is not None and isinstance(label_path, Path):
            backup_dest = backup_file(dataset_dir, backup_root, label_path)
            label_path.parent.mkdir(parents=True, exist_ok=True)
            label_path.write_text(str(payload.get("new_label_text") or ""), encoding="utf-8")
            row["category"] = payload["new_category"]
            row["label_mode"] = payload["new_label_mode"]
            row["reason"] = payload["new_reason"]
            meta = row.get("meta") if isinstance(row.get("meta"), dict) else {}
            meta["qwenlabel_relabel"] = {
                "run_id": run_id,
                "model": args.model,
                "endpoint": args.endpoint,
                "selector": args.selector,
                "updated_at": now_iso(),
                "previous_category": payload.get("previous_category"),
                "previous_label_mode": payload.get("previous_label_mode"),
                "previous_reason": payload.get("previous_reason"),
                "old_box_count": payload.get("old_box_count"),
                "new_box_count": payload.get("new_box_count"),
                "scene": payload.get("scene"),
                "audit_verdict": payload.get("audit_verdict"),
                "review_verdict_before": payload.get("review_verdict"),
                "review_annotation_path": payload.get("review_annotation_path"),
                "cache": rel_to_dataset(dataset_dir, cache_path),
                "label_backup": backup_dest,
            }
            row["meta"] = meta
            counts["ok"] += 1
            counts["boxes"] += int(payload.get("new_box_count") or 0)
            counts["positive_images" if int(payload.get("new_box_count") or 0) else "empty_images"] += 1
        else:
            counts["error"] += 1
        cache_payload = jsonable_payload(payload)
        if image_sha:
            write_json_atomic(cache_path, cache_payload)
        results.append(payload)
        with progress_path.open("a", encoding="utf-8") as handle:
            progress_payload = jsonable_payload(payload, compact=True)
            handle.write(json.dumps(progress_payload, ensure_ascii=False, separators=(",", ":")) + "\n")
        elapsed = max(0.001, time.time() - started)
        print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {idx}/{len(selected)} ok={counts['ok']} error={counts['error']} boxes={counts['boxes']} rate={idx/elapsed:.2f}/s", flush=True)

    prepared_items = list(prepared_by_line.values())
    if args.workers <= 1:
        for idx, prepared in enumerate(prepared_items, 1):
            try:
                payload = process_one(prepared, args)
            except Exception as exc:
                payload = {
                    "ok": False,
                    **prepared,
                    "error": f"{type(exc).__name__}:{str(exc)[:500]}",
                }
            handle_payload(payload, idx)
    else:
        workers = max(1, args.workers)
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(process_one, prepared, args): prepared for prepared in prepared_items}
            done = 0
            for future in concurrent.futures.as_completed(futures):
                done += 1
                prepared = futures[future]
                try:
                    payload = future.result()
                except Exception as exc:
                    payload = {
                        "ok": False,
                        **prepared,
                        "error": f"{type(exc).__name__}:{str(exc)[:500]}",
                    }
                handle_payload(payload, done)

    write_jsonl_atomic(manifest_path, rows)
    run_summary = {
        "run_id": run_id,
        "selector": args.selector,
        "model": args.model,
        "endpoint": args.endpoint,
        "updated_at": now_iso(),
        "selected_rows": len(selected),
        "review_verdict_counts": dict(Counter(str(row.get("_review_verdict") or "missing") for row in selected)),
        "ok": counts.get("ok", 0),
        "error": counts.get("error", 0),
        "positive_images": counts.get("positive_images", 0),
        "empty_images": counts.get("empty_images", 0),
        "boxes": counts.get("boxes", 0),
        "report_root": report_root.as_posix(),
        "progress": progress_path.as_posix(),
    }
    if args.summary:
        update_summary(args.summary.resolve(), dataset_dir, rows, run_summary)
    write_json_atomic(report_root / "summary.json", {**run_summary, "results": [jsonable_payload(item, compact=True) for item in results]})
    print(json.dumps({"ok": True, **run_summary}, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
