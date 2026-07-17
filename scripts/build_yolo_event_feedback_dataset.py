#!/usr/bin/env python3
from __future__ import annotations

import argparse
import collections
import errno
import json
import os
import re
import shutil
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path


SCHEMA = "jgzj_yolo_event_feedback_dataset.v1"
SOURCE = "qwen_permanent_yes_frame"
NO_LABELER_SOURCE = "qwen_no_labeler_positive_frame"
ALLOWED_SOURCES = {SOURCE, NO_LABELER_SOURCE}
CLASSES = (
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
)
CLASS_IDS = {name: idx for idx, name in enumerate(CLASSES)}
BLOCKED_QUALITIES = {"bad", "blocked"}
BAD_AUDIT_VERDICTS = {"suspect", "needs_human", "error"}

EVENT_CLASS_MAP = {
    "person": "person",
    "crowdincidents": "person",
    "falldown": "person",
    "fighting": "person",
    "lying": "person",
    "lawn": "person",
    "linger": "person",
    "car": "vehicle",
    "truck": "vehicle",
    "vehicle": "vehicle",
    "bicycle": "nonmotor",
    "motorcycle": "nonmotor",
    "nonmotorvehicle": "nonmotor",
    "illegalparkingcycle": "nonmotor",
    "fire": "fire",
    "smoke": "smoke",
    "wastepaper": "trash",
    "paper": "trash",
    "plasticbag": "trash",
    "bag": "trash",
    "box": "trash",
    "bottle": "trash",
    "pet": "pet",
    "cat": "pet",
    "dog": "pet",
    "offleashdog": "pet",
    "stall": "stall",
    "phone": "phone",
    "smoking": "smoking",
    "cigarette": "smoking",
}


def load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None


def write_text_atomic(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        if path.read_text(encoding="utf-8") == content:
            return
    except OSError:
        pass
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
        os.replace(tmp_name, path)
    finally:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass


def write_json_atomic(path: Path, payload) -> None:
    write_text_atomic(path, json.dumps(payload, ensure_ascii=False, indent=2) + "\n")


def cache_path(root: Path, image_sha: str) -> Path | None:
    safe = re.sub(r"[^a-f0-9]", "", str(image_sha or "").lower())
    if len(safe) != 64:
        return None
    return root / safe[:2] / f"{safe}.json"


def normalized_event_key(event_name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(event_name or "").lower())


def expected_class(event_name: str) -> str | None:
    return EVENT_CLASS_MAP.get(normalized_event_key(event_name))


def valid_yes_tasks(meta: dict) -> list[dict]:
    tasks = meta.get("yes_tasks") or meta.get("qwen_yes_tasks") or []
    out = []
    for task in tasks if isinstance(tasks, list) else []:
        if not isinstance(task, dict):
            continue
        answer = str(task.get("answer") or "").upper()
        passed = task.get("pass") is True or task.get("pass") == 1
        if answer == "YES" and passed:
            out.append(task)
    return out


def valid_no_tasks(meta: dict) -> list[dict]:
    tasks = meta.get("no_tasks") or meta.get("qwen_no_tasks") or []
    out = []
    for task in tasks if isinstance(tasks, list) else []:
        if not isinstance(task, dict):
            continue
        answer = str(task.get("answer") or "").upper()
        failed = task.get("pass") is False or task.get("pass") == 0
        if answer == "NO" or failed:
            out.append(task)
    return out


def permanent_image_path(meta_path: Path, meta: dict, permanent_root: Path) -> Path | None:
    rel = str(meta.get("permanent_image_path") or "").strip().replace("\\", "/").lstrip("/")
    image_path = permanent_root / rel if rel else meta_path.with_suffix("")
    try:
        resolved = image_path.resolve()
        root = permanent_root.resolve()
        resolved.relative_to(root)
    except (OSError, ValueError):
        return None
    return resolved if resolved.is_file() else None


def normalize_box(label: dict) -> tuple[float, float, float, float] | None:
    box = label.get("box") if isinstance(label.get("box"), dict) else {}
    values = (
        label.get("x", label.get("x_center", box.get("x_center"))),
        label.get("y", label.get("y_center", box.get("y_center"))),
        label.get("w", label.get("width", box.get("width"))),
        label.get("h", label.get("height", box.get("height"))),
    )
    try:
        x, y, w, h = (float(value) for value in values)
    except (TypeError, ValueError):
        return None
    if not all(0.0 <= value <= 1.0 for value in (x, y, w, h)) or w <= 0.0 or h <= 0.0:
        return None
    return x, y, w, h


def normalize_labels(payload: dict | None) -> list[dict]:
    labels = payload.get("labels") if isinstance(payload, dict) else []
    out = []
    for raw in labels if isinstance(labels, list) else []:
        if not isinstance(raw, dict):
            continue
        class_name = str(raw.get("class_name") or raw.get("class") or "").strip().lower()
        if class_name not in CLASS_IDS:
            continue
        box = normalize_box(raw)
        if box is None:
            continue
        confidence = raw.get("confidence")
        try:
            confidence = float(confidence) if confidence is not None else None
        except (TypeError, ValueError):
            confidence = None
        out.append({
            "class_name": class_name,
            "class_id": CLASS_IDS[class_name],
            "x": box[0],
            "y": box[1],
            "w": box[2],
            "h": box[3],
            "confidence": confidence,
            "note": str(raw.get("note") or raw.get("evidence") or "").strip(),
        })
    return out


def label_text(labels: list[dict]) -> str:
    lines = [
        f"{label['class_id']} {label['x']:.6f} {label['y']:.6f} {label['w']:.6f} {label['h']:.6f}"
        for label in labels
    ]
    return "\n".join(lines) + ("\n" if lines else "")


def materialize_image(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        try:
            if os.path.samefile(source, destination):
                return
        except OSError:
            pass
    tmp = destination.with_name(f".{destination.name}.{os.getpid()}.tmp")
    try:
        try:
            os.link(source, tmp)
        except OSError as exc:
            if exc.errno != errno.EXDEV:
                raise
            shutil.copy2(source, tmp)
        os.replace(tmp, destination)
    finally:
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass


def prune_generated_files(directory: Path, keep: set[Path]) -> int:
    if not directory.is_dir():
        return 0
    removed = 0
    for path in directory.iterdir():
        if path.is_file() and path not in keep:
            path.unlink()
            removed += 1
    return removed


def safe_token(value: str, fallback: str = "unknown", max_len: int = 80) -> str:
    token = re.sub(r"[^A-Za-z0-9_-]+", "_", str(value or "")).strip("_")
    return (token or fallback)[:max_len]


def shanghai_day(meta: dict, image_path: Path) -> str:
    parent = image_path.parent.name
    if re.fullmatch(r"\d{8}", parent):
        return parent
    value = meta.get("collected_at") or meta.get("received_at_ms") or meta.get("edge_ts")
    try:
        if isinstance(value, (int, float)) or str(value).isdigit():
            parsed = datetime.fromtimestamp(int(value) / 1000.0, timezone.utc)
        else:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.astimezone(timezone(timedelta(hours=8))).strftime("%Y%m%d")
    except (TypeError, ValueError, OSError):
        return "unknown"


def feedback_status(
    label_payload: dict | None,
    labels: list[dict],
    expected_classes: set[str],
    audit_payload: dict | None,
) -> tuple[str, str, list[str]]:
    if not isinstance(label_payload, dict):
        return "pending_label", "independent_label_pending", sorted(expected_classes)
    if label_payload.get("ok") is False or label_payload.get("parse_ok") is False:
        return "pending_label", "independent_label_invalid", sorted(expected_classes)
    quality = str(label_payload.get("quality") or "").strip().lower()
    if quality in BLOCKED_QUALITIES:
        return "quality_blocked", f"image_quality_{quality}", sorted(expected_classes)
    if not expected_classes:
        return "review_only", "unsupported_event_only", []
    independent_classes = {label["class_name"] for label in labels}
    missing = sorted(expected_classes - independent_classes)
    audit_verdict = str((audit_payload or {}).get("verdict") or "").strip().lower()
    if missing:
        return "needs_human", "edge_cloud_disagreement", missing
    if audit_verdict in BAD_AUDIT_VERDICTS:
        return "needs_human", f"audit_{audit_verdict}", []
    return "agreement", "edge_cloud_agreement", []


def iter_candidate_rows(
    permanent_root: Path,
    label_root: Path,
    audit_root: Path,
    min_day: str,
):
    for meta_path in permanent_root.glob("**/*.json"):
        meta = load_json(meta_path)
        if not isinstance(meta, dict):
            continue
        source = str(meta.get("source") or SOURCE)
        if source not in ALLOWED_SOURCES:
            continue
        tasks = valid_yes_tasks(meta) if source == SOURCE else valid_no_tasks(meta)
        if source == SOURCE and not tasks:
            continue
        image_path = permanent_image_path(meta_path, meta, permanent_root)
        if image_path is None:
            continue
        day = shanghai_day(meta, image_path)
        if min_day and day != "unknown" and day < min_day:
            continue
        image_sha = str(meta.get("image_sha256") or "").strip().lower()
        label_path = cache_path(label_root, image_sha)
        audit_path = cache_path(audit_root, image_sha)
        label_payload = load_json(label_path) if label_path else None
        audit_payload = load_json(audit_path) if audit_path else None
        labels = normalize_labels(label_payload)
        if source == NO_LABELER_SOURCE and not labels:
            continue
        expected = {
            mapped
            for mapped in (expected_class(task.get("event_name")) for task in tasks)
            if mapped
        } if source == SOURCE else set()
        if source == NO_LABELER_SOURCE:
            status, reason, missing = "review_only", "binary_negative_cross_class_positive", []
        else:
            status, reason, missing = feedback_status(label_payload, labels, expected, audit_payload)
        yield {
            "meta": meta,
            "meta_path": meta_path,
            "image_path": image_path,
            "image_sha256": image_sha,
            "day": day,
            "source": source,
            "tasks": tasks,
            "labels": labels,
            "label_payload": label_payload,
            "label_path": label_path if label_path and label_path.exists() else None,
            "audit_payload": audit_payload,
            "audit_path": audit_path if audit_path and audit_path.exists() else None,
            "expected_classes": sorted(expected),
            "missing_expected_classes": missing,
            "feedback_status": status,
            "feedback_reason": reason,
        }


def build_dataset(args) -> dict:
    permanent_root = args.permanent_root.resolve()
    output_root = args.output_root.resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    min_day = ""
    if args.days > 0:
        min_day = (datetime.now(timezone(timedelta(hours=8))) - timedelta(days=args.days - 1)).strftime("%Y%m%d")

    rows = list(iter_candidate_rows(
        permanent_root,
        args.label_root.resolve(),
        args.audit_root.resolve(),
        min_day,
    ))
    rows.sort(
        key=lambda row: (
            str(row["meta"].get("collected_at") or row["meta"].get("received_at_ms") or ""),
            row["image_sha256"],
        ),
        reverse=True,
    )

    status_counts = collections.Counter()
    event_counts = collections.Counter()
    negative_event_counts = collections.Counter()
    review_event_counts = collections.Counter()
    expected_counts = collections.Counter()
    independent_counts = collections.Counter()
    quality_counts = collections.Counter()
    device_counts = collections.Counter()
    camera_counts = collections.Counter()
    day_counts = collections.Counter()
    box_counts = collections.Counter()
    manifest_rows = []

    for row in rows:
        meta = row["meta"]
        tasks = row["tasks"]
        primary_event = str(tasks[0].get("event_name") or "event")
        request_id = str(meta.get("request_id") or "request")
        extension = row["image_path"].suffix.lower() or ".jpg"
        file_name = "_".join((
            safe_token(row["day"]),
            safe_token(request_id),
            safe_token(primary_event),
            safe_token(row["image_sha256"][:16], "nohash"),
        )) + extension
        image_rel = Path("images") / "review" / file_name
        label_rel = Path("labels") / "review" / f"{Path(file_name).stem}.txt"
        materialize_image(row["image_path"], output_root / image_rel)
        write_text_atomic(output_root / label_rel, label_text(row["labels"]))

        task_rows = []
        for task in tasks:
            event_name = str(task.get("event_name") or "")
            target_counts = event_counts if row["source"] == SOURCE else negative_event_counts
            target_counts[event_name or "unknown"] += 1
            if row["source"] == SOURCE and row["feedback_status"] == "needs_human":
                review_event_counts[event_name or "unknown"] += 1
            task_rows.append({
                "request_id": request_id,
                "task_id": task.get("task_id"),
                "event_name": event_name,
                "answer": task.get("answer"),
                "pass": task.get("pass"),
                "expected_class": expected_class(event_name),
                "merged_box": task.get("merged_box"),
                "crop_box": task.get("crop_box"),
                "device_id": meta.get("device_id"),
                "camera_id": meta.get("camera_id"),
            })

        quality = str((row["label_payload"] or {}).get("quality") or "pending")
        device_id = str(meta.get("vehicle_id") or meta.get("device_id") or "unknown")
        camera_id = str(meta.get("camera_id") or "unknown")
        status_counts[row["feedback_status"]] += 1
        day_counts[row["day"]] += 1
        quality_counts[quality] += 1
        device_counts[device_id] += 1
        camera_counts[camera_id] += 1
        expected_counts.update(row["expected_classes"])
        independent_counts.update({label["class_name"] for label in row["labels"]})
        box_counts.update(label["class_name"] for label in row["labels"])

        manifest_rows.append({
            "schema": SCHEMA,
            "image": image_rel.as_posix(),
            "split": row["feedback_status"],
            "is_positive": bool(row["labels"]),
            "box_count": len(row["labels"]),
            "device_ids": [device_id],
            "camera_ids": [camera_id],
            "days": [row["day"]],
            "frame_width": (row["label_payload"] or {}).get("image_request", {}).get("original_width") or meta.get("frame_width"),
            "frame_height": (row["label_payload"] or {}).get("image_request", {}).get("original_height") or meta.get("frame_height"),
            "source_frame": str(row["image_path"]),
            "source_meta": str(row["meta_path"]),
            "source": row["source"],
            "image_sha256": row["image_sha256"],
            "collected_at": meta.get("collected_at"),
            "feedback_status": row["feedback_status"],
            "feedback_reason": row["feedback_reason"],
            "expected_classes": row["expected_classes"],
            "missing_expected_classes": row["missing_expected_classes"],
            "independent_classes": sorted({label["class_name"] for label in row["labels"]}),
            "independent_quality": quality,
            "independent_label_path": str(row["label_path"] or ""),
            "audit_path": str(row["audit_path"] or ""),
            "audit_verdict": str((row["audit_payload"] or {}).get("verdict") or ""),
            "training_eligible": False,
            "tasks": task_rows,
        })

    manifest_text = "".join(json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n" for item in manifest_rows)
    write_text_atomic(output_root / "manifest_selected_images.jsonl", manifest_text)
    expected_images = {output_root / item["image"] for item in manifest_rows}
    expected_labels = {
        output_root / (item["image"].replace("images/", "labels/").rsplit(".", 1)[0] + ".txt")
        for item in manifest_rows
    }
    pruned_files = (
        prune_generated_files(output_root / "images" / "review", expected_images)
        + prune_generated_files(output_root / "labels" / "review", expected_labels)
    )

    now = datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds")
    summary = {
        "schema": SCHEMA,
        "profile": "YOLO事件原图反馈候选集",
        "kind": "detect",
        "created_at": now,
        "updated_at": now,
        "classes": list(CLASSES),
        "images": dict(sorted(status_counts.items())),
        "positive_images": {"independent_label_positive": sum(1 for row in rows if row["labels"])},
        "boxes": dict(sorted(box_counts.items())),
        "answers": {
            "YES": sum(1 for row in rows if row["source"] == SOURCE),
            "NO_WITH_LABELS": sum(1 for row in rows if row["source"] == NO_LABELER_SOURCE and row["labels"]),
            "NO": sum(1 for row in rows if row["source"] == NO_LABELER_SOURCE),
            "NULL": sum(1 for row in rows if row["label_payload"] is None),
        },
        "source": SOURCE,
        "sources": sorted(ALLOWED_SOURCES),
        "source_root": str(permanent_root),
        "training_eligible": False,
        "training_policy": "manual_review_required",
        "feedback": {
            "total_images": len(rows),
            "status_counts": dict(status_counts.most_common()),
            "event_counts": dict(event_counts.most_common()),
            "negative_event_counts": dict(negative_event_counts.most_common()),
            "review_queue_images": int(status_counts.get("needs_human", 0)),
            "review_event_counts": dict(review_event_counts.most_common()),
            "expected_class_counts": dict(expected_counts.most_common()),
            "independent_class_images": dict(independent_counts.most_common()),
            "quality_counts": dict(quality_counts.most_common()),
            "device_counts": dict(device_counts.most_common()),
            "camera_counts": dict(camera_counts.most_common()),
            "day_counts": dict(sorted(day_counts.items(), reverse=True)),
            "training_eligible_images": 0,
            "pruned_files": pruned_files,
            "min_day": min_day or None,
        },
    }
    write_json_atomic(output_root / "dataset_summary.json", summary)
    write_json_atomic(output_root / "training_guard.json", {
        "schema": "jgzj_yolo_training_guard.v1",
        "training_eligible": False,
        "reason": "Event predictions are untrusted candidates until manual review resolves edge/cloud disagreements.",
        "updated_at": now,
    })
    return summary


def main() -> int:
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
        "--audit-root",
        type=Path,
        default=Path("/home/admin1/jgzj/.runtime/yolo_label_review/qwen_permanent_yes_bbox_audits_v1"),
    )
    parser.add_argument(
        "--output-root",
        type=Path,
        default=Path("/home/admin1/jgzj/.runtime/yolo_loop/datasets/yolo_event_feedback_v1"),
    )
    parser.add_argument("--days", type=int, default=30, help="Keep the latest N Shanghai calendar days; 0 keeps all history.")
    args = parser.parse_args()

    if not args.permanent_root.is_dir():
        raise SystemExit(f"permanent_root_missing:{args.permanent_root}")
    summary = build_dataset(args)
    feedback = summary["feedback"]
    print(json.dumps({
        "ok": True,
        "dataset": str(args.output_root),
        "total_images": feedback["total_images"],
        "status_counts": feedback["status_counts"],
        "event_counts": feedback["event_counts"],
        "training_eligible_images": feedback["training_eligible_images"],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
