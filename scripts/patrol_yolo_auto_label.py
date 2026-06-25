#!/usr/bin/env python3
import argparse
import base64
import concurrent.futures
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


SCHEMA = "jgzj_patrol_yolo_auto_label.v1"


DEFAULT_TASKS = [
    {
        "task_id": "person_yolo",
        "kind": "detect",
        "model": "/home/admin1/jgzj/.runtime/yolo_model_service/weights/person_yolo_best.pt",
        "names": ["person"],
        "imgsz": 640,
        "conf": 0.18,
    },
    {
        "task_id": "general_yolo",
        "kind": "detect",
        "model": "/home/admin1/jgzj/.runtime/yolo_model_service/weights/general_yolo_best.pt",
        "names": ["car", "truck", "non_motor_vehicle", "pet", "stall"],
        "imgsz": 640,
        "conf": 0.25,
    },
    {
        "task_id": "trash_yolo",
        "kind": "detect",
        "model": "/home/admin1/jgzj/.runtime/yolo_model_service/weights/trash_yolo_best.pt",
        "names": ["bottle", "box", "paper", "bag"],
        "imgsz": 960,
        "conf": 0.15,
    },
    {
        "task_id": "fire_smoke_yolo",
        "kind": "detect",
        "model": "/home/admin1/jgzj/.runtime/yolo_model_service/weights/fire_smoke_yolo_best.pt",
        "names": ["fire", "smoke"],
        "imgsz": 768,
        "conf": 0.2,
    },
    {
        "task_id": "phone_yolo",
        "kind": "detect",
        "model": "/home/admin1/jgzj/.runtime/yolo_model_service/weights/phone_yolo_best.pt",
        "names": ["phone"],
        "imgsz": 640,
        "conf": 0.2,
    },
    {
        "task_id": "stall_yolo",
        "kind": "detect",
        "model": "/home/admin1/jgzj/.runtime/yolo_model_service/weights/stall_yolo_best.pt",
        "names": ["stall"],
        "imgsz": 640,
        "conf": 0.2,
    },
    {
        "task_id": "smoking_two_stage",
        "kind": "smoking_two_stage",
        "model": "/home/admin1/jgzj/.runtime/yolo_model_service/weights/smoking_candidate_best.pt",
        "classifierModel": "/home/admin1/jgzj/.runtime/yolo_model_service/weights/smoking_cls_best.pt",
        "names": ["smoking"],
        "classifierNames": ["not_smoking", "smoking"],
        "imgsz": 640,
        "conf": 0.18,
        "classifierImgsz": 224,
        "classifierThreshold": 0.55,
    },
]


def log(message):
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{stamp}] {message}", flush=True)


def load_json(path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def save_json_atomic(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def normalize_rel(path):
    return str(path or "").replace("\\", "/").lstrip("/")


def cache_path(root, image_sha):
    safe = "".join(ch for ch in str(image_sha or "").lower() if ch in "0123456789abcdef")
    if not safe:
        return None
    return root / safe[:2] / f"{safe}.json"


def sha256_file(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def iter_meta_rows(frames_root):
    for meta_path in sorted(frames_root.glob("**/*.json")):
        meta = load_json(meta_path)
        if not isinstance(meta, dict):
            continue
        image_rel = normalize_rel(meta.get("image_path"))
        if image_rel:
            image_path = frames_root / image_rel
        else:
            image_path = meta_path.with_suffix(".jpg")
            image_rel = normalize_rel(image_path.relative_to(frames_root))
        if not image_path.exists():
            continue
        if image_path.suffix.lower() not in {".jpg", ".jpeg", ".png", ".webp", ".bmp"}:
            continue
        if not meta.get("image_sha256"):
            meta["image_sha256"] = sha256_file(image_path)
        yield {
            "meta_path": meta_path,
            "image_path": image_path,
            "image_rel": image_rel,
            "meta": meta,
        }


def call_predict(base_url, task, image_b64, timeout):
    payload = {
        "task": task,
        "image": {
            "mime_type": "image/jpeg",
            "data_base64": image_b64,
        },
        "no_annotated": True,
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        base_url.rstrip("/") + "/predict",
        data=body,
        method="POST",
        headers={"content-type": "application/json", "accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def task_predictions(base_url, task, image_b64, timeout):
    started = time.time()
    try:
        result = call_predict(base_url, task, image_b64, timeout)
    except Exception as exc:
        return {
            "task_id": task["task_id"],
            "ok": False,
            "error": str(exc),
            "duration_ms": int((time.time() - started) * 1000),
            "labels": [],
        }
    labels = []
    for det in result.get("detections") or []:
        if task["task_id"] == "smoking_two_stage" and not det.get("accepted"):
            continue
        box = det.get("box") or {}
        class_name = det.get("class_name") or ("smoking" if task["task_id"] == "smoking_two_stage" else "")
        confidence = det.get("confidence")
        if task["task_id"] == "smoking_two_stage":
            top = (det.get("stage2") or {}).get("top") or {}
            confidence = top.get("confidence", confidence)
            class_name = top.get("class_name") or class_name
        labels.append({
            "model_task": task["task_id"],
            "class_name": class_name,
            "class_id": det.get("class_id"),
            "confidence": confidence,
            "x": box.get("x_center"),
            "y": box.get("y_center"),
            "w": box.get("width"),
            "h": box.get("height"),
            "box": box,
        })
    return {
        "task_id": task["task_id"],
        "ok": bool(result.get("ok")),
        "backend": result.get("backend"),
        "gpu": result.get("gpu"),
        "duration_ms": result.get("duration_ms", int((time.time() - started) * 1000)),
        "labels": labels,
    }


def annotate_one(row, args, tasks):
    meta = row["meta"]
    out_path = cache_path(args.output_root, meta.get("image_sha256"))
    if out_path is None:
        return "skip:no_sha"
    if out_path.exists() and not args.refresh:
        return "skip:cached"
    raw = row["image_path"].read_bytes()
    image_b64 = base64.b64encode(raw).decode("ascii")
    labels = []
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.model_workers) as pool:
        futures = [pool.submit(task_predictions, args.service_url, task, image_b64, args.timeout_s) for task in tasks]
        for future in concurrent.futures.as_completed(futures):
            result = future.result()
            results.append(result)
            labels.extend(result.get("labels") or [])
    labels.sort(key=lambda item: (str(item.get("class_name") or ""), -float(item.get("confidence") or 0)))
    payload = {
        "schema": SCHEMA,
        "image_sha256": meta.get("image_sha256"),
        "image_path": row["image_rel"],
        "source": meta.get("source") or "cloud_camera_capture",
        "vehicle_id": meta.get("vehicle_id"),
        "camera_id": meta.get("camera_id"),
        "collected_at": meta.get("collected_at"),
        "annotated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "model_bundle": "person_and_current_yolo_v1",
        "labels": labels,
        "results": sorted(results, key=lambda item: item.get("task_id") or ""),
    }
    save_json_atomic(out_path, payload)
    return f"ok:{len(labels)}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--frames-root", type=Path, default=Path("/home/admin1/jgzj/.runtime/park-pcm/crowd-frames"))
    parser.add_argument("--output-root", type=Path, default=Path("/home/admin1/jgzj/.runtime/yolo_label_review/patrol_auto_labels"))
    parser.add_argument("--service-url", default="http://127.0.0.1:18087")
    parser.add_argument("--limit", type=int, default=0, help="0 means no limit")
    parser.add_argument("--source", choices=["all", "auto_ad_patrol_flow_upload", "cloud_camera_capture"], default="all")
    parser.add_argument("--vehicle", default="")
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--model-workers", type=int, default=7)
    parser.add_argument("--timeout-s", type=int, default=90)
    parser.add_argument("--tasks", default="", help="Comma-separated task ids; empty means all")
    args = parser.parse_args()

    selected = {item.strip() for item in args.tasks.split(",") if item.strip()}
    tasks = [task for task in DEFAULT_TASKS if not selected or task["task_id"] in selected]
    missing_models = [task["model"] for task in tasks if task.get("model") and not Path(task["model"]).exists()]
    missing_models.extend(task["classifierModel"] for task in tasks if task.get("classifierModel") and not Path(task["classifierModel"]).exists())
    if missing_models:
        raise SystemExit("missing model files: " + ", ".join(missing_models))

    rows = []
    for row in iter_meta_rows(args.frames_root):
        meta = row["meta"]
        if args.source != "all" and (meta.get("source") or "cloud_camera_capture") != args.source:
            continue
        if args.vehicle and str(meta.get("vehicle_id") or "") != args.vehicle:
            continue
        rows.append(row)
    rows.sort(key=lambda row: str(row["meta"].get("collected_at") or ""), reverse=True)
    if args.limit > 0:
        rows = rows[:args.limit]
    log(f"rows={len(rows)} tasks={','.join(task['task_id'] for task in tasks)} output={args.output_root}")

    counts = {}
    started = time.time()
    for idx, row in enumerate(rows, 1):
        try:
            status = annotate_one(row, args, tasks)
        except KeyboardInterrupt:
            raise
        except Exception as exc:
            status = f"error:{type(exc).__name__}:{exc}"
        counts[status.split(":", 1)[0]] = counts.get(status.split(":", 1)[0], 0) + 1
        if idx == 1 or idx % 20 == 0 or idx == len(rows):
            elapsed = max(0.001, time.time() - started)
            log(f"{idx}/{len(rows)} {status} rate={idx/elapsed:.2f}/s counts={counts}")


if __name__ == "__main__":
    main()
