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
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


SHANGHAI_TZ = timezone(timedelta(hours=8))
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
SCHEMA = "jgzj_finetune_fire_smoke_hard_example_mining.v1"
DEFAULT_CLASSES = ["fire", "smoke"]


def now_id() -> str:
    return datetime.now(SHANGHAI_TZ).strftime("%Y%m%d_%H%M%S")


def now_iso() -> str:
    return datetime.now(SHANGHAI_TZ).isoformat(timespec="seconds")


def normalize_rel(value: object) -> str:
    return str(value or "").replace("\\", "/").lstrip("/")


def normalize_name(value: object) -> str:
    return str(value or "").strip().lower().replace("-", "_").replace(" ", "_")


def read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def write_json_atomic(path: Path, payload: Any) -> None:
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


def class_id_from_label(label: dict[str, Any], class_to_id: dict[str, int]) -> int | None:
    raw = str(label.get("raw") or "").strip()
    raw_name = normalize_name(raw.split()[0]) if raw else ""
    class_name = normalize_name(label.get("class_name") or label.get("label") or raw_name)
    if class_name in class_to_id:
        return class_to_id[class_name]
    try:
        class_id = int(float(label.get("class_id")))
    except Exception:
        return None
    return class_id if class_id in set(class_to_id.values()) else None


def truth_boxes_from_annotation(
    annotation: dict[str, Any] | None,
    class_to_id: dict[str, int],
    id_to_class: dict[int, str],
) -> tuple[str, list[dict[str, Any]]]:
    if not annotation or annotation.get("deleted"):
        return "missing", []
    verdict = normalize_name(annotation.get("review_verdict") or "")
    answer = str(annotation.get("answer") or "").strip().upper()
    if verdict in {"negative", "unusable"} or answer == "NO":
        return "negative", []
    boxes = []
    for label in annotation.get("labels") or []:
        class_id = class_id_from_label(label, class_to_id)
        if class_id is None:
            continue
        try:
            x = float(label.get("x") if label.get("x") is not None else label.get("x_center"))
            y = float(label.get("y") if label.get("y") is not None else label.get("y_center"))
            w = float(label.get("w") if label.get("w") is not None else label.get("width"))
            h = float(label.get("h") if label.get("h") is not None else label.get("height"))
        except Exception:
            continue
        if w > 0 and h > 0:
            boxes.append({"cls": class_id, "class_name": id_to_class[class_id], "x": x, "y": y, "w": w, "h": h})
    return ("positive" if boxes else "negative"), boxes


def xywh_to_xyxy(box: dict[str, Any]) -> tuple[float, float, float, float]:
    x = float(box["x"])
    y = float(box["y"])
    w = float(box["w"])
    h = float(box["h"])
    return (x - w / 2.0, y - h / 2.0, x + w / 2.0, y + h / 2.0)


def box_iou(left: dict[str, Any], right: dict[str, Any]) -> float:
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


def prediction_boxes(
    result: dict[str, Any],
    class_to_id: dict[str, int],
    id_to_class: dict[int, str],
    conf_threshold: float,
) -> list[dict[str, Any]]:
    target_ids = set(id_to_class)
    boxes = []
    for det in result.get("detections") or []:
        confidence = float(det.get("confidence") or 0.0)
        if confidence < conf_threshold:
            continue
        class_name = normalize_name(det.get("class_name") or "")
        class_id = class_to_id.get(class_name)
        if class_id is None:
            try:
                candidate_id = int(float(det.get("class_id")))
            except Exception:
                candidate_id = None
            if candidate_id in target_ids:
                class_id = candidate_id
        if class_id is None:
            continue
        raw_box = det.get("box") or {}
        try:
            boxes.append({
                "cls": class_id,
                "class_name": id_to_class[class_id],
                "x": float(raw_box.get("x_center")),
                "y": float(raw_box.get("y_center")),
                "w": float(raw_box.get("width")),
                "h": float(raw_box.get("height")),
                "confidence": confidence,
            })
        except Exception:
            continue
    return boxes


def compare_positive(gt_boxes: list[dict[str, Any]], pred_boxes: list[dict[str, Any]], args: argparse.Namespace) -> dict[str, Any]:
    matched_pred: set[int] = set()
    gt_results = []
    hard_gt_count = 0
    best_iou = 0.0
    best_matched_conf = 0.0
    for gi, gt in enumerate(gt_boxes):
        same_class = [(pi, pred) for pi, pred in enumerate(pred_boxes) if pred["cls"] == gt["cls"]]
        gt_best_iou = 0.0
        gt_best_conf = 0.0
        gt_best_pred = None
        for pi, pred in same_class:
            iou = box_iou(gt, pred)
            if iou > gt_best_iou:
                gt_best_iou = iou
                gt_best_pred = pi
            best_iou = max(best_iou, iou)
            if iou >= args.pos_iou_threshold:
                gt_best_conf = max(gt_best_conf, float(pred.get("confidence") or 0.0))
        if gt_best_iou >= args.pos_iou_threshold and gt_best_pred is not None:
            matched_pred.add(gt_best_pred)
        best_matched_conf = max(best_matched_conf, gt_best_conf)
        is_hard_gt = gt_best_iou < args.pos_iou_threshold or gt_best_conf < args.normal_pos_min_conf
        if is_hard_gt:
            hard_gt_count += 1
        gt_results.append({
            "gt_index": gi,
            "class_id": gt["cls"],
            "class_name": gt["class_name"],
            "best_iou": gt_best_iou,
            "best_matched_conf": gt_best_conf,
            "hard": is_hard_gt,
        })
    unmatched_pred_highconf = sum(
        1 for pi, pred in enumerate(pred_boxes)
        if pi not in matched_pred and float(pred.get("confidence") or 0.0) >= args.hard_neg_min_conf
    )
    if hard_gt_count == len(gt_boxes):
        reason = "missed_or_low_conf_all_gt"
    elif hard_gt_count:
        reason = "low_conf_or_low_iou"
    elif args.positive_extra_is_hard and unmatched_pred_highconf:
        reason = "extra_target_predictions"
    else:
        reason = "conf_iou_ok"
    hard = hard_gt_count > 0 or (args.positive_extra_is_hard and unmatched_pred_highconf > 0)
    return {
        "hard": hard,
        "hard_label": "hard_positive" if hard else "normal_positive",
        "reason": reason,
        "gt_count": len(gt_boxes),
        "pred_count": len(pred_boxes),
        "matched": len(matched_pred),
        "hard_gt_count": hard_gt_count,
        "unmatched_gt": hard_gt_count,
        "unmatched_pred": unmatched_pred_highconf,
        "max_iou": best_iou,
        "matched_conf": best_matched_conf,
        "target_conf": max((float(pred.get("confidence") or 0.0) for pred in pred_boxes), default=0.0),
        "gt_results": gt_results,
    }


def compare_negative(pred_boxes: list[dict[str, Any]], args: argparse.Namespace) -> dict[str, Any]:
    target_conf = max((float(pred.get("confidence") or 0.0) for pred in pred_boxes), default=0.0)
    top = max(pred_boxes, key=lambda item: float(item.get("confidence") or 0.0), default=None)
    hard = target_conf >= args.hard_neg_min_conf
    return {
        "hard": hard,
        "hard_label": "hard_negative" if hard else "normal_negative",
        "reason": "false_positive_conf" if hard else "no_target_prediction",
        "gt_count": 0,
        "pred_count": len(pred_boxes),
        "matched": 0,
        "hard_gt_count": 0,
        "unmatched_gt": 0,
        "unmatched_pred": sum(1 for pred in pred_boxes if float(pred.get("confidence") or 0.0) >= args.hard_neg_min_conf),
        "max_iou": 0.0,
        "matched_conf": 0.0,
        "target_conf": target_conf,
        "target_cls": None if top is None else top.get("cls"),
        "target_class_name": None if top is None else top.get("class_name"),
        "gt_results": [],
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
    parser = argparse.ArgumentParser(description="Run latest fire/smoke YOLO over manually reviewed finetune_v2 images and tag hard examples.")
    parser.add_argument("--dataset-dir", type=Path, default=Path("/home/admin1/jgzj/.runtime/yolo_loop/datasets/finetune_v2"))
    parser.add_argument("--dataset-id", default="loop:finetune_v2")
    parser.add_argument("--manual-root", type=Path, default=Path("/home/admin1/jgzj/.runtime/yolo_label_review/manual_annotations_v1"))
    parser.add_argument("--model", default="/home/admin1/jgzj/.runtime/yolo_model_service/weights/fire_smoke_yolo_full_review_full20_epoch20_20260727_155000.pt")
    parser.add_argument("--service-url", default="http://127.0.0.1:18087")
    parser.add_argument("--classes", default="fire,smoke")
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--predict-conf-floor", type=float, default=0.001)
    parser.add_argument("--pos-iou-threshold", type=float, default=0.50)
    parser.add_argument("--normal-pos-min-conf", type=float, default=0.50)
    parser.add_argument("--hard-neg-min-conf", type=float, default=0.25)
    parser.add_argument("--timeout-s", type=float, default=180.0)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--positive-extra-is-hard", action="store_true")
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
    all_csv = report_dir / "all_reviewed_results.csv"
    backup_dir = report_dir / "backup"

    classes = [normalize_name(item) for item in args.classes.split(",") if normalize_name(item)]
    if not classes:
        classes = DEFAULT_CLASSES
    class_to_id = {name: idx for idx, name in enumerate(classes)}
    id_to_class = {idx: name for name, idx in class_to_id.items()}

    rows = read_jsonl(manifest_path)
    if args.limit > 0:
        work_indices = set(range(min(args.limit, len(rows))))
    else:
        work_indices = set(range(len(rows)))

    model_path = Path(args.model)
    model_sha256 = file_sha256(model_path)
    results = []
    hard_rows = []
    label_hash_before = {}

    started = time.time()
    manual_missing = 0
    for index, row in enumerate(rows):
        if index not in work_indices:
            continue
        image_path = image_path_for_row(dataset_dir, row)
        image_rel = rel_to_dataset(dataset_dir, image_path)
        item_key = normalize_rel(row.get("image") or image_rel)
        ann_path = annotation_path(args.manual_root.resolve(), args.dataset_id, item_key)
        annotation = read_json(ann_path, None)
        truth_type, gt_boxes = truth_boxes_from_annotation(annotation, class_to_id, id_to_class)
        if truth_type == "missing":
            manual_missing += 1
            continue

        label_path = label_path_for_row(dataset_dir, row, image_path)
        if label_path and label_path.exists():
            label_hash_before[label_path.as_posix()] = file_sha256(label_path)

        inference = infer_image(args.service_url, args.model, image_path, args.imgsz, args.predict_conf_floor, args.timeout_s)
        pred_boxes = prediction_boxes(inference, class_to_id, id_to_class, args.predict_conf_floor)
        comparison = (
            compare_positive(gt_boxes, pred_boxes, args)
            if gt_boxes
            else compare_negative(pred_boxes, args)
        )
        hard_label = comparison["hard_label"]
        is_hard = bool(comparison["hard"])

        result_row = {
            "line": row.get("_line_no"),
            "item_key": item_key,
            "image": image_path.as_posix(),
            "annotation": ann_path.as_posix(),
            "truth_type": truth_type,
            "gt_count": len(gt_boxes),
            "pred_count": len(pred_boxes),
            "category": hard_label,
            "hard": is_hard,
            "hard_label": hard_label if is_hard else "",
            "reason": comparison["reason"],
            "matched": comparison["matched"],
            "hard_gt_count": comparison["hard_gt_count"],
            "unmatched_gt": comparison["unmatched_gt"],
            "unmatched_pred": comparison["unmatched_pred"],
            "matched_conf": comparison["matched_conf"],
            "target_conf": comparison["target_conf"],
            "max_iou": comparison["max_iou"],
            "pred_conf_max": comparison["target_conf"],
            "duration_ms": inference.get("duration_ms"),
        }
        results.append(result_row)
        if is_hard:
            hard_rows.append(result_row)

        row["manual_reviewed"] = True
        row["manual_review_dataset_id"] = args.dataset_id
        row["manual_annotation_path"] = ann_path.as_posix()
        row["manual_truth_type"] = truth_type
        row["manual_gt_boxes"] = len(gt_boxes)
        row["category"] = hard_label
        row["hard_example"] = is_hard
        row["hard_example_label"] = hard_label if is_hard else ""
        row["hard_example_source"] = "fire_smoke_yolo_latest_vs_manual"
        row["hard_example_model"] = args.model
        row["hard_example_model_sha256"] = model_sha256
        row["hard_example_checked_at"] = checked_at
        row["hard_example_predict_conf_floor"] = args.predict_conf_floor
        row["hard_example_pos_iou_threshold"] = args.pos_iou_threshold
        row["hard_example_normal_pos_min_conf"] = args.normal_pos_min_conf
        row["hard_example_hard_neg_min_conf"] = args.hard_neg_min_conf
        row["hard_example_reason"] = comparison["reason"]
        row["hard_example_gt_boxes"] = len(gt_boxes)
        row["hard_example_pred_boxes"] = len(pred_boxes)
        row["hard_example_matched_boxes"] = comparison["matched"]
        row["hard_example_hard_gt_count"] = comparison["hard_gt_count"]
        row["hard_example_target_conf"] = comparison["target_conf"]
        row["hard_example_matched_conf"] = comparison["matched_conf"]
        row["hard_example_max_iou"] = comparison["max_iou"]
        row["hard_example_report"] = report_json.relative_to(dataset_dir).as_posix()

        if (len(results) % 25) == 0:
            print(json.dumps({
                "progress": len(results),
                "hard": len(hard_rows),
                "elapsed_s": round(time.time() - started, 1),
            }, ensure_ascii=False), flush=True)

    counts = Counter(row["category"] for row in results)
    hard_counts = Counter(row["hard_label"] for row in hard_rows)
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
        "classes": classes,
        "imgsz": args.imgsz,
        "predict_conf_floor": args.predict_conf_floor,
        "pos_iou_threshold": args.pos_iou_threshold,
        "normal_pos_min_conf": args.normal_pos_min_conf,
        "hard_neg_min_conf": args.hard_neg_min_conf,
        "positive_extra_is_hard": bool(args.positive_extra_is_hard),
        "checked_at": checked_at,
        "total_manifest_rows": len(rows),
        "manual_missing_rows": manual_missing,
        "evaluated_manual_rows": len(results),
        "hard_examples": len(hard_rows),
        "hard_positive": hard_counts.get("hard_positive", 0),
        "hard_negative": hard_counts.get("hard_negative", 0),
        "category_counts": dict(counts),
        "truth_counts": dict(truth_counts),
        "hard_reason_counts": dict(reason_counts),
        "report_json": report_json.as_posix(),
        "report_csv": report_csv.as_posix(),
        "all_results_csv": all_csv.as_posix(),
        "elapsed_s": round(time.time() - started, 3),
    }

    report_payload = {
        **run_summary,
        "hard_examples_detail": hard_rows,
        "all_results": results,
    }

    report_dir.mkdir(parents=True, exist_ok=True)
    write_json_atomic(report_json, report_payload)
    fieldnames = [
        "line", "item_key", "category", "hard_label", "reason", "truth_type", "gt_count", "pred_count",
        "matched", "hard_gt_count", "unmatched_gt", "unmatched_pred", "matched_conf", "target_conf",
        "max_iou", "image", "annotation",
    ]
    with report_csv.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in hard_rows:
            writer.writerow({name: row.get(name) for name in fieldnames})
    with all_csv.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in results:
            writer.writerow({name: row.get(name) for name in fieldnames})
    for category in ("hard_positive", "hard_negative", "normal_positive", "normal_negative"):
        list_path = report_dir / f"{category}.txt"
        with list_path.open("w", encoding="utf-8") as handle:
            for row in results:
                if row.get("category") == category:
                    handle.write(str(row.get("image") or "") + "\n")

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

    print(json.dumps({"ok": True, **run_summary}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
