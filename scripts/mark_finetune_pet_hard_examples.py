#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import json
import os
import tempfile
import time
import urllib.request
from collections import Counter
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any


SHANGHAI_TZ = timezone(timedelta(hours=8))
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
SCHEMA = "jgzj_finetune_pet_hard_example_mining.v1"


def now_id() -> str:
    return datetime.now(SHANGHAI_TZ).strftime("%Y%m%d_%H%M%S")


def now_iso() -> str:
    return datetime.now(SHANGHAI_TZ).isoformat(timespec="seconds")


def normalize_rel(value: object) -> str:
    return str(value or "").replace("\\", "/").lstrip("/")


def read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
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


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows = []
    with path.open("r", encoding="utf-8") as handle:
        for line_no, raw in enumerate(handle, 1):
            text = raw.strip()
            if not text:
                continue
            row = json.loads(text)
            row["_line_no"] = line_no
            rows.append(row)
    return rows


def write_jsonl_atomic(path: Path, rows: list[dict[str, Any]]) -> None:
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


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def resolve_dataset_path(dataset_dir: Path, value: object) -> Path:
    path = Path(str(value or ""))
    if path.is_absolute():
        return path
    return (dataset_dir / path).resolve()


def rel_to_dataset(dataset_dir: Path, path: Path) -> str:
    try:
        return path.resolve().relative_to(dataset_dir.resolve()).as_posix()
    except Exception:
        return path.as_posix()


def image_path_for_row(dataset_dir: Path, row: dict[str, Any]) -> Path:
    for key in ("image", "dataset_image"):
        value = row.get(key)
        if not value:
            continue
        path = resolve_dataset_path(dataset_dir, value)
        if path.exists() and path.suffix.lower() in IMAGE_EXTENSIONS:
            return path
    raise FileNotFoundError(f"image_missing:line={row.get('_line_no')}")


def label_path_for_row(dataset_dir: Path, row: dict[str, Any], image_path: Path) -> Path | None:
    for key in ("label", "dataset_label"):
        value = row.get(key)
        if not value:
            continue
        path = resolve_dataset_path(dataset_dir, value)
        if path.exists():
            return path
    rel = rel_to_dataset(dataset_dir, image_path)
    if rel.startswith("images/"):
        candidate = dataset_dir / rel.replace("images/", "labels/", 1)
        return candidate.with_suffix(".txt")
    return None


def annotation_key(dataset_id: str, item_key: str) -> str:
    return hashlib.sha256(f"{dataset_id.strip()}\n{normalize_rel(item_key)}".encode("utf-8")).hexdigest()


def annotation_path(manual_root: Path, dataset_id: str, item_key: str) -> Path:
    key = annotation_key(dataset_id, item_key)
    return manual_root / key[:2] / f"{key}.json"


def truth_boxes_from_annotation(annotation: dict[str, Any] | None) -> tuple[str, list[dict[str, float]]]:
    if not annotation or annotation.get("deleted"):
        return "missing", []
    verdict = str(annotation.get("review_verdict") or "").strip().lower()
    answer = str(annotation.get("answer") or "").strip().upper()
    if verdict in {"negative", "unusable"} or answer == "NO":
        return "negative", []
    labels = []
    for label in annotation.get("labels") or []:
        class_name = str(label.get("class_name") or label.get("label") or "").strip().lower()
        class_id = label.get("class_id")
        if class_name and class_name != "pet":
            continue
        if class_id is not None and str(class_id) not in {"0", "0.0"} and class_name != "pet":
            continue
        try:
            x = float(label.get("x") if label.get("x") is not None else label.get("x_center"))
            y = float(label.get("y") if label.get("y") is not None else label.get("y_center"))
            w = float(label.get("w") if label.get("w") is not None else label.get("width"))
            h = float(label.get("h") if label.get("h") is not None else label.get("height"))
        except Exception:
            continue
        if w > 0 and h > 0:
            labels.append({"x": x, "y": y, "w": w, "h": h})
    return ("positive" if labels else "negative"), labels


def xywh_to_xyxy(box: dict[str, float]) -> tuple[float, float, float, float]:
    x = float(box["x"])
    y = float(box["y"])
    w = float(box["w"])
    h = float(box["h"])
    return (x - w / 2.0, y - h / 2.0, x + w / 2.0, y + h / 2.0)


def box_iou(left: dict[str, float], right: dict[str, float]) -> float:
    lx1, ly1, lx2, ly2 = xywh_to_xyxy(left)
    rx1, ry1, rx2, ry2 = xywh_to_xyxy(right)
    ix1 = max(lx1, rx1)
    iy1 = max(ly1, ry1)
    ix2 = min(lx2, rx2)
    iy2 = min(ly2, ry2)
    iw = max(0.0, ix2 - ix1)
    ih = max(0.0, iy2 - iy1)
    inter = iw * ih
    left_area = max(0.0, lx2 - lx1) * max(0.0, ly2 - ly1)
    right_area = max(0.0, rx2 - rx1) * max(0.0, ry2 - ry1)
    denom = left_area + right_area - inter
    return inter / denom if denom > 0 else 0.0


def infer_image(service_url: str, model_path: str, image_path: Path, imgsz: int, conf: float, timeout_s: float) -> dict[str, Any]:
    payload = {
        "task": {
            "kind": "detect",
            "model": model_path,
            "imgsz": int(imgsz),
            "conf": float(conf),
        },
        "image": {
            "data_base64": base64.b64encode(image_path.read_bytes()).decode("ascii"),
        },
        "no_annotated": True,
    }
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        service_url.rstrip("/") + "/predict",
        data=body,
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout_s) as response:
        data = json.loads(response.read().decode("utf-8"))
    if not data.get("ok"):
        raise RuntimeError(f"inference_failed:{data}")
    return data


def prediction_boxes(result: dict[str, Any], conf_threshold: float) -> list[dict[str, float]]:
    boxes = []
    for det in result.get("detections") or []:
        class_name = str(det.get("class_name") or "").strip().lower()
        class_id = det.get("class_id")
        confidence = float(det.get("confidence") or 0.0)
        if confidence < conf_threshold:
            continue
        if class_name and class_name != "pet":
            continue
        if class_id is not None and str(class_id) not in {"0", "0.0"} and class_name != "pet":
            continue
        raw_box = det.get("box") or {}
        try:
            boxes.append({
                "x": float(raw_box.get("x_center")),
                "y": float(raw_box.get("y_center")),
                "w": float(raw_box.get("width")),
                "h": float(raw_box.get("height")),
                "confidence": confidence,
            })
        except Exception:
            continue
    return boxes


def compare_boxes(gt_boxes: list[dict[str, float]], pred_boxes: list[dict[str, float]], iou_threshold: float) -> dict[str, Any]:
    pairs = []
    for gi, gt in enumerate(gt_boxes):
        for pi, pred in enumerate(pred_boxes):
            pairs.append((box_iou(gt, pred), gi, pi))
    pairs.sort(reverse=True)
    matched_gt = set()
    matched_pred = set()
    matched_ious = []
    for iou, gi, pi in pairs:
        if iou < iou_threshold:
            break
        if gi in matched_gt or pi in matched_pred:
            continue
        matched_gt.add(gi)
        matched_pred.add(pi)
        matched_ious.append(iou)
    unmatched_gt = len(gt_boxes) - len(matched_gt)
    unmatched_pred = len(pred_boxes) - len(matched_pred)
    if not gt_boxes and pred_boxes:
        hard = True
        reason = "false_positive_on_negative"
    elif gt_boxes and not pred_boxes:
        hard = True
        reason = "missed_all_gt"
    elif unmatched_gt and unmatched_pred:
        hard = True
        reason = "missing_gt_and_extra_predictions"
    elif unmatched_gt:
        hard = True
        reason = "missing_gt"
    elif unmatched_pred:
        hard = True
        reason = "extra_predictions"
    else:
        hard = False
        reason = "matched"
    return {
        "hard": hard,
        "reason": reason,
        "matched": len(matched_gt),
        "unmatched_gt": unmatched_gt,
        "unmatched_pred": unmatched_pred,
        "min_matched_iou": min(matched_ious) if matched_ious else None,
        "max_iou": pairs[0][0] if pairs else None,
    }


def update_summary(summary_path: Path, run_summary: dict[str, Any]) -> None:
    summary = read_json(summary_path, {})
    if not isinstance(summary, dict):
        summary = {}
    summary["updated_at"] = now_iso()
    history = summary.get("hard_example_mining_history")
    if not isinstance(history, list):
        history = []
    history.append(run_summary)
    summary["hard_example_mining_history"] = history[-10:]
    summary["hard_example_mining"] = run_summary
    write_json_atomic(summary_path, summary)


def backup_file(path: Path, backup_dir: Path) -> str:
    backup_dir.mkdir(parents=True, exist_ok=True)
    dest = backup_dir / path.name
    if path.exists():
        dest.write_bytes(path.read_bytes())
    return dest.as_posix()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run latest pet YOLO over finetune_pet and tag inconsistent samples as hard examples.")
    parser.add_argument("--dataset-dir", type=Path, default=Path("/home/admin1/jgzj/.runtime/yolo_loop/datasets/finetune_pet"))
    parser.add_argument("--dataset-id", default="loop:finetune_pet")
    parser.add_argument("--manual-root", type=Path, default=Path("/home/admin1/jgzj/.runtime/yolo_label_review/manual_annotations_v1"))
    parser.add_argument("--model", default="/home/admin1/jgzj/.runtime/finetune/results/20260729_102722_pet_yolo_reviewed_finetune/pet_yolo_reviewed_finetune_20260729_102722_pet_yolo_reviewed_finetune_best.pt")
    parser.add_argument("--service-url", default="http://127.0.0.1:18087")
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--conf", type=float, default=0.25)
    parser.add_argument("--iou-threshold", type=float, default=0.50)
    parser.add_argument("--timeout-s", type=float, default=180.0)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--apply", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.dry_run == args.apply:
        raise SystemExit("Choose exactly one of --dry-run or --apply.")

    dataset_dir = args.dataset_dir.resolve()
    manifest_path = dataset_dir / "manifest_selected_images.jsonl"
    summary_path = dataset_dir / "dataset_summary.json"
    run_id = now_id()
    checked_at = now_iso()
    report_dir = dataset_dir / "hard_example_reports" / run_id
    report_json = report_dir / "report.json"
    report_csv = report_dir / "hard_examples.csv"
    backup_dir = report_dir / "backup"

    rows = read_jsonl(manifest_path)
    if args.limit > 0:
        work_indices = set(range(args.limit))
    else:
        work_indices = set(range(len(rows)))

    model_sha256 = file_sha256(Path(args.model))
    results = []
    hard_rows = []
    label_hash_before = {}

    started = time.time()
    for index, row in enumerate(rows):
        if index not in work_indices:
            continue
        image_path = image_path_for_row(dataset_dir, row)
        image_rel = rel_to_dataset(dataset_dir, image_path)
        item_key = normalize_rel(row.get("image") or image_rel)
        ann_path = annotation_path(args.manual_root.resolve(), args.dataset_id, item_key)
        annotation = read_json(ann_path, None)
        truth_type, gt_boxes = truth_boxes_from_annotation(annotation)
        if truth_type == "missing":
            result_row = {
                "line": row.get("_line_no"),
                "item_key": item_key,
                "image": image_path.as_posix(),
                "annotation": ann_path.as_posix(),
                "error": "manual_annotation_missing",
            }
            results.append(result_row)
            continue

        label_path = label_path_for_row(dataset_dir, row, image_path)
        if label_path and label_path.exists():
            label_hash_before[label_path.as_posix()] = file_sha256(label_path)

        inference = infer_image(args.service_url, args.model, image_path, args.imgsz, args.conf, args.timeout_s)
        pred_boxes = prediction_boxes(inference, args.conf)
        comparison = compare_boxes(gt_boxes, pred_boxes, args.iou_threshold)
        hard_label = ""
        if comparison["hard"]:
            hard_label = "hard_positive" if gt_boxes else "hard_negative"

        result_row = {
            "line": row.get("_line_no"),
            "item_key": item_key,
            "image": image_path.as_posix(),
            "annotation": ann_path.as_posix(),
            "truth_type": truth_type,
            "gt_count": len(gt_boxes),
            "pred_count": len(pred_boxes),
            "hard": comparison["hard"],
            "hard_label": hard_label,
            "reason": comparison["reason"],
            "matched": comparison["matched"],
            "unmatched_gt": comparison["unmatched_gt"],
            "unmatched_pred": comparison["unmatched_pred"],
            "min_matched_iou": comparison["min_matched_iou"],
            "max_iou": comparison["max_iou"],
            "pred_conf_max": max((box.get("confidence", 0.0) for box in pred_boxes), default=None),
            "duration_ms": inference.get("duration_ms"),
        }
        results.append(result_row)
        if hard_label:
            hard_rows.append(result_row)
            row.setdefault("hard_example_original_category", row.get("category", ""))
            row["category"] = hard_label
            row["hard_example"] = True
            row["hard_example_label"] = hard_label
            row["hard_example_source"] = "pet_yolo_latest_vs_manual"
            row["hard_example_model"] = args.model
            row["hard_example_model_sha256"] = model_sha256
            row["hard_example_checked_at"] = checked_at
            row["hard_example_conf_threshold"] = args.conf
            row["hard_example_iou_threshold"] = args.iou_threshold
            row["hard_example_reason"] = comparison["reason"]
            row["hard_example_gt_boxes"] = len(gt_boxes)
            row["hard_example_pred_boxes"] = len(pred_boxes)
            row["hard_example_matched_boxes"] = comparison["matched"]
            row["hard_example_min_matched_iou"] = comparison["min_matched_iou"]
            row["hard_example_report"] = report_json.relative_to(dataset_dir).as_posix()

        if (len(results) % 50) == 0:
            print(json.dumps({
                "progress": len(results),
                "total": len(work_indices),
                "hard": len(hard_rows),
                "elapsed_s": round(time.time() - started, 1),
            }, ensure_ascii=False), flush=True)

    counts = Counter(row["hard_label"] for row in hard_rows)
    truth_counts = Counter(str(row.get("truth_type") or "unknown") for row in results)
    reason_counts = Counter(str(row.get("reason") or "unknown") for row in hard_rows)
    run_summary = {
        "schema": SCHEMA,
        "run_id": run_id,
        "mode": "apply" if args.apply else "dry_run",
        "dataset_id": args.dataset_id,
        "dataset_dir": dataset_dir.as_posix(),
        "manifest": manifest_path.as_posix(),
        "model": args.model,
        "model_sha256": model_sha256,
        "service_url": args.service_url,
        "imgsz": args.imgsz,
        "conf_threshold": args.conf,
        "iou_threshold": args.iou_threshold,
        "checked_at": checked_at,
        "total_rows": len(rows),
        "evaluated_rows": len(results),
        "hard_examples": len(hard_rows),
        "hard_positive": counts.get("hard_positive", 0),
        "hard_negative": counts.get("hard_negative", 0),
        "truth_counts": dict(truth_counts),
        "hard_reason_counts": dict(reason_counts),
        "report_json": report_json.as_posix(),
        "report_csv": report_csv.as_posix(),
        "elapsed_s": round(time.time() - started, 3),
    }

    report_payload = {
        **run_summary,
        "hard_examples_detail": hard_rows,
        "all_results": results,
    }

    report_dir.mkdir(parents=True, exist_ok=True)
    write_json_atomic(report_json, report_payload)
    with report_csv.open("w", encoding="utf-8", newline="") as handle:
        fieldnames = [
            "line", "item_key", "hard_label", "reason", "truth_type", "gt_count", "pred_count",
            "matched", "unmatched_gt", "unmatched_pred", "min_matched_iou", "max_iou",
            "pred_conf_max", "image", "annotation",
        ]
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in hard_rows:
            writer.writerow({name: row.get(name) for name in fieldnames})

    if args.apply:
        backup_file(manifest_path, backup_dir)
        backup_file(summary_path, backup_dir)
        write_jsonl_atomic(manifest_path, rows)
        update_summary(summary_path, run_summary)
        changed_hashes = []
        for label_path_text, before in label_hash_before.items():
            path = Path(label_path_text)
            if path.exists() and file_sha256(path) != before:
                changed_hashes.append(label_path_text)
        if changed_hashes:
            raise RuntimeError(f"label_files_changed_unexpectedly:{changed_hashes[:5]}")

    print(json.dumps({
        "ok": True,
        **run_summary,
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
