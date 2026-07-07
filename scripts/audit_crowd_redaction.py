#!/usr/bin/env python3
import argparse
import base64
import json
import math
import os
import sys
import time
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime

import cv2
import numpy as np


IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp")


def now_iso():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def rel_day(rel_path):
    parts = rel_path.replace("\\", "/").split("/")
    return parts[0] if parts else ""


def iter_images(frames_root):
    for dirpath, _dirs, names in os.walk(frames_root):
        for name in sorted(names):
            if not name.lower().endswith(IMAGE_EXTS):
                continue
            path = os.path.join(dirpath, name)
            yield os.path.relpath(path, frames_root), path


def load_cascade(name):
    cascade_dir = getattr(cv2.data, "haarcascades", "")
    path = os.path.join(cascade_dir, name)
    if not path or not os.path.exists(path):
        return None
    detector = cv2.CascadeClassifier(path)
    return None if detector.empty() else detector


FACE_DETECTORS = [
    load_cascade("haarcascade_frontalface_alt2.xml"),
    load_cascade("haarcascade_frontalface_default.xml"),
]
FACE_DETECTORS = [item for item in FACE_DETECTORS if item is not None]
EYE_DETECTORS = [
    load_cascade("haarcascade_eye_tree_eyeglasses.xml"),
    load_cascade("haarcascade_eye.xml"),
]
EYE_DETECTORS = [item for item in EYE_DETECTORS if item is not None]


def face_has_eye_evidence(gray, box):
    x, y, w, h = box
    if w < 34 or h < 34:
        return True
    roi_gray = gray[y:y + h, x:x + w]
    if roi_gray.size <= 0:
        return False
    upper = roi_gray[0:max(1, int(h * 0.62)), :]
    min_eye = max(5, int(min(w, h) * 0.10))
    for detector in EYE_DETECTORS:
        eyes = detector.detectMultiScale(
            upper,
            scaleFactor=1.08,
            minNeighbors=4,
            minSize=(min_eye, min_eye),
        )
        centers = []
        for (ex, ey, ew, eh) in eyes:
            ex, ey, ew, eh = int(ex), int(ey), int(ew), int(eh)
            if ew <= 0 or eh <= 0:
                continue
            aspect = ew / float(eh)
            if aspect < 0.45 or aspect > 2.4:
                continue
            cx = ex + ew / 2.0
            cy = ey + eh / 2.0
            if cy > h * 0.62:
                continue
            centers.append((cx, cy, ew, eh))
        if len(centers) >= 2:
            centers.sort(key=lambda item: item[0])
            for left_index in range(len(centers)):
                for right_index in range(left_index + 1, len(centers)):
                    left, right = centers[left_index], centers[right_index]
                    horizontal_gap = right[0] - left[0]
                    vertical_gap = abs(right[1] - left[1])
                    if (
                        horizontal_gap >= w * 0.18
                        and horizontal_gap <= w * 0.74
                        and vertical_gap <= h * 0.18
                    ):
                        return True
        elif len(centers) == 1:
            cx, cy, ew, eh = centers[0]
            if w <= 60 and h <= 60 and w * 0.22 <= cx <= w * 0.78 and h * 0.12 <= cy <= h * 0.55:
                return True
    return False


def detect_cascade_faces(img, strict=True):
    height, width = img.shape[:2]
    gray = cv2.equalizeHist(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY))
    faces = []
    for detector_index, detector in enumerate(FACE_DETECTORS):
        found = detector.detectMultiScale(
            gray,
            scaleFactor=1.08 if strict else 1.06,
            minNeighbors=(8 if detector_index == 0 else 9) if strict else 5,
            minSize=(28, 28) if strict else (22, 22),
        )
        for (x, y, w, h) in found:
            x, y, w, h = int(x), int(y), int(w), int(h)
            if w <= 0 or h <= 0:
                continue
            aspect = w / float(h)
            area_ratio = (w * h) / float(max(1, width * height))
            if strict:
                if aspect < 0.72 or aspect > 1.36:
                    continue
                if area_ratio < 0.0012 or area_ratio > 0.045:
                    continue
            else:
                if aspect < 0.65 or aspect > 1.50:
                    continue
                if area_ratio < 0.00045 or area_ratio > 0.08:
                    continue
            if not face_has_eye_evidence(gray, (x, y, w, h)):
                continue
            faces.append((x, y, w, h, "face"))
    return dedupe_boxes(faces)


def load_person_model(model_path, enabled, service_url=""):
    if not enabled or not model_path or not os.path.exists(model_path):
        return None
    service_url = str(service_url or "").rstrip("/")
    if service_url:
        return {"kind": "service", "url": service_url, "model_path": model_path}
    try:
        from ultralytics import YOLO
        return YOLO(model_path)
    except Exception as error:
        print(json.dumps({
            "event": "person_model_load_failed",
            "model_path": model_path,
            "error": str(error),
        }, ensure_ascii=False), flush=True)
        return None


def detect_person_heads(img_path, img, model):
    if model is None:
        return []
    height, width = img.shape[:2]
    faces = []
    if isinstance(model, dict) and model.get("kind") == "service":
        try:
            with open(img_path, "rb") as handle:
                image_b64 = base64.b64encode(handle.read()).decode("ascii")
            payload = {
                "task": {
                    "task_id": "person_yolo",
                    "kind": "detect",
                    "model": model["model_path"],
                    "imgsz": 640,
                    "conf": 0.38,
                },
                "image": {
                    "mime_type": "image/jpeg",
                    "data_base64": image_b64,
                },
                "no_annotated": True,
            }
            body = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(
                model["url"] + "/predict",
                data=body,
                method="POST",
                headers={"content-type": "application/json", "accept": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=30) as response:
                result = json.loads(response.read().decode("utf-8"))
            detections = result.get("detections") or []
            for detection in detections:
                label = str(detection.get("class_name") or "")
                conf = float(detection.get("confidence") or 0.0)
                if label != "person" or conf < 0.38:
                    continue
                box = detection.get("box") or {}
                xyxy = box.get("xyxy") or []
                if len(xyxy) != 4:
                    continue
                x1, y1, x2, y2 = [float(value) for value in xyxy]
                bw = x2 - x1
                bh = y2 - y1
                if bw < 18 or bh < 55:
                    continue
                if (bw * bh) / float(max(1, width * height)) > 0.35:
                    continue
                head_h = max(22, int(bh * 0.28))
                head_w = max(20, int(min(bw * 0.90, head_h * 1.05)))
                cx = (x1 + x2) / 2.0
                hx = int(round(cx - head_w / 2.0))
                hy = int(round(y1))
                faces.append((max(0, hx), max(0, hy), head_w, head_h, "person_head"))
        except Exception:
            return []
        return faces
    try:
        results = model.predict(
            source=img_path,
            imgsz=640,
            conf=0.38,
            iou=0.45,
            device="cpu",
            verbose=False,
        )
        for result in results:
            names = getattr(result, "names", {}) or {}
            boxes = getattr(result, "boxes", None)
            if boxes is None:
                continue
            for box in boxes:
                cls = int(box.cls[0])
                label = names.get(cls, str(cls))
                if label != "person":
                    continue
                conf = float(box.conf[0])
                if conf < 0.38:
                    continue
                x1, y1, x2, y2 = [float(value) for value in box.xyxy[0].tolist()]
                bw = x2 - x1
                bh = y2 - y1
                if bw < 18 or bh < 55:
                    continue
                if (bw * bh) / float(max(1, width * height)) > 0.35:
                    continue
                head_h = max(22, int(bh * 0.28))
                head_w = max(20, int(min(bw * 0.90, head_h * 1.05)))
                cx = (x1 + x2) / 2.0
                hx = int(round(cx - head_w / 2.0))
                hy = int(round(y1))
                faces.append((max(0, hx), max(0, hy), head_w, head_h, "person_head"))
    except Exception:
        return []
    return faces


def dedupe_boxes(boxes):
    if not boxes:
        return []
    ordered = sorted(boxes, key=lambda box: box[2] * box[3], reverse=True)
    kept = []
    for box in ordered:
        x, y, w, h = box[:4]
        cx, cy = x + w / 2.0, y + h / 2.0
        duplicate = False
        for kept_box in kept:
            kx, ky, kw, kh = kept_box[:4]
            kcx, kcy = kx + kw / 2.0, ky + kh / 2.0
            if abs(cx - kcx) < min(w, kw) * 0.45 and abs(cy - kcy) < min(h, kh) * 0.45:
                duplicate = True
                break
        if not duplicate:
            kept.append(box)
    return kept


def backend_candidates(img_path, img, person_model):
    faces = detect_cascade_faces(img, strict=True)
    faces.extend(detect_person_heads(img_path, img, person_model))
    return dedupe_boxes(faces)


def padded_box(img, box):
    x, y, w, h = [int(value) for value in box[:4]]
    pad_x = max(2, int(w * 0.08))
    pad_y = max(2, int(h * 0.10))
    x1 = max(0, x - pad_x)
    y1 = max(0, y - pad_y)
    x2 = min(img.shape[1], x + w + pad_x)
    y2 = min(img.shape[0], y + h + pad_y)
    return x1, y1, x2, y2


def write_redacted_image(img, dst_path, faces):
    out = img.copy()
    for box in faces:
        x1, y1, x2, y2 = padded_box(out, box)
        if x2 <= x1 or y2 <= y1:
            continue
        roi = out[y1:y2, x1:x2]
        block_w = max(1, min(18, roi.shape[1] // 6 or 1))
        block_h = max(1, min(18, roi.shape[0] // 6 or 1))
        small = cv2.resize(roi, (block_w, block_h), interpolation=cv2.INTER_LINEAR)
        mosaic = cv2.resize(small, (roi.shape[1], roi.shape[0]), interpolation=cv2.INTER_NEAREST)
        out[y1:y2, x1:x2] = mosaic
    os.makedirs(os.path.dirname(dst_path), exist_ok=True)
    tmp = "{}.{}.tmp{}".format(dst_path, os.getpid(), os.path.splitext(dst_path)[1] or ".jpg")
    ok = cv2.imwrite(tmp, out, [int(cv2.IMWRITE_JPEG_QUALITY), 86])
    if not ok:
        raise RuntimeError("image_write_failed")
    os.replace(tmp, dst_path)
    return len(faces)


def region_stats(src, dst, box):
    x1, y1, x2, y2 = box
    if x2 <= x1 or y2 <= y1:
        return 0.0, 0.0
    roi_src = src[y1:y2, x1:x2]
    roi_dst = dst[y1:y2, x1:x2]
    if roi_src.size <= 0 or roi_dst.size <= 0:
        return 0.0, 0.0
    diff = cv2.absdiff(roi_src, roi_dst)
    gray = cv2.cvtColor(diff, cv2.COLOR_BGR2GRAY)
    mean_abs = float(gray.mean())
    changed_ratio = float((gray > 22).mean())
    return mean_abs, changed_ratio


def overlap_ratio(a, b):
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0
    inter = (ix2 - ix1) * (iy2 - iy1)
    area = max(1, (ax2 - ax1) * (ay2 - ay1))
    return inter / float(area)


def changed_contours(src, dst):
    diff = cv2.absdiff(src, dst)
    gray = cv2.cvtColor(diff, cv2.COLOR_BGR2GRAY)
    _, mask = cv2.threshold(gray, 35, 255, cv2.THRESH_BINARY)
    kernel = np.ones((3, 3), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    contours, _hierarchy = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes = []
    img_area = max(1, src.shape[0] * src.shape[1])
    min_area = max(180, int(img_area * 0.00025))
    for contour in contours:
        area = int(cv2.contourArea(contour))
        if area < min_area:
            continue
        x, y, w, h = cv2.boundingRect(contour)
        boxes.append((x, y, x + w, y + h, area))
    return boxes


def audit_one(rel_path, src_path, dst_path, person_model, generate):
    result = {
        "rel_path": rel_path,
        "day": rel_day(rel_path),
        "status": "ok",
        "backend_candidate_count": 0,
        "loose_face_count": 0,
        "issues": [],
    }
    src = cv2.imread(src_path)
    if src is None:
        result["status"] = "error"
        result["issues"].append({"type": "source_read_failed"})
        return result
    src_stat = os.stat(src_path)
    backend_faces = None
    if generate and (not os.path.exists(dst_path) or os.stat(dst_path).st_mtime < src_stat.st_mtime):
        try:
            backend_faces = backend_candidates(src_path, src, person_model)
            write_redacted_image(src, dst_path, backend_faces)
        except Exception as error:
            result["status"] = "error"
            result["issues"].append({"type": "redaction_generate_failed", "error": str(error)})
            return result
    if not os.path.exists(dst_path):
        result["status"] = "error"
        result["issues"].append({"type": "redacted_missing"})
        return result
    dst = cv2.imread(dst_path)
    if dst is None:
        result["status"] = "error"
        result["issues"].append({"type": "redacted_read_failed"})
        return result
    if src.shape[:2] != dst.shape[:2]:
        result["status"] = "error"
        result["issues"].append({
            "type": "shape_mismatch",
            "source_shape": list(src.shape[:2]),
            "redacted_shape": list(dst.shape[:2]),
        })
        return result

    if backend_faces is None:
        backend_faces = backend_candidates(src_path, src, person_model)
    loose_faces = detect_cascade_faces(src, strict=False)
    result["backend_candidate_count"] = len(backend_faces)
    result["loose_face_count"] = len(loose_faces)
    backend_regions = [padded_box(src, box) for box in backend_faces]

    for index, box in enumerate(backend_faces):
        region = padded_box(src, box)
        mean_abs, changed_ratio = region_stats(src, dst, region)
        if mean_abs < 8.0 or changed_ratio < 0.10:
            result["issues"].append({
                "type": "unredacted_backend_candidate",
                "index": index,
                "source": box[4] if len(box) > 4 else "face",
                "box": list(map(int, box[:4])),
                "mean_abs_diff": round(mean_abs, 2),
                "changed_ratio": round(changed_ratio, 4),
            })

    for index, box in enumerate(loose_faces):
        region = padded_box(src, box)
        if any(overlap_ratio(region, backend_region) > 0.45 for backend_region in backend_regions):
            continue
        mean_abs, changed_ratio = region_stats(src, dst, region)
        if mean_abs < 8.0 or changed_ratio < 0.10:
            result["issues"].append({
                "type": "possible_unredacted_face",
                "index": index,
                "box": list(map(int, box[:4])),
                "mean_abs_diff": round(mean_abs, 2),
                "changed_ratio": round(changed_ratio, 4),
            })

    for box in changed_contours(src, dst):
        contour_region = box[:4]
        if any(overlap_ratio(contour_region, backend_region) > 0.18 for backend_region in backend_regions):
            continue
        x1, y1, x2, y2, area = box
        if area < max(400, int(src.shape[0] * src.shape[1] * 0.0008)):
            continue
        result["issues"].append({
            "type": "unexpected_changed_region",
            "box": [int(x1), int(y1), int(x2 - x1), int(y2 - y1)],
            "area": int(area),
        })
        if len([issue for issue in result["issues"] if issue["type"] == "unexpected_changed_region"]) >= 3:
            break

    if result["issues"]:
        result["status"] = "warn"
    return result


def write_json(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = "{}.{}.tmp".format(path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.replace(tmp, path)


def run_once(args, person_model):
    started = time.time()
    frames_root = os.path.abspath(args.frames_root)
    redacted_root = os.path.abspath(args.redacted_root)
    if args.rel_list:
        all_images = []
        with open(args.rel_list, "r", encoding="utf-8") as handle:
            for line in handle:
                rel_path = line.strip().lstrip("/")
                if not rel_path or rel_path.startswith("#"):
                    continue
                src_path = os.path.join(frames_root, rel_path)
                if os.path.exists(src_path):
                    all_images.append((rel_path, src_path))
                else:
                    all_images.append((rel_path, src_path))
    else:
        all_images = list(iter_images(frames_root))
    if args.day:
        wanted_days = set(args.day)
        all_images = [(rel, path) for rel, path in all_images if rel_day(rel) in wanted_days]
    if args.limit > 0:
        all_images = all_images[:args.limit]
    summary = {
        "ok": True,
        "started_at": now_iso(),
        "frames_root": frames_root,
        "redacted_root": redacted_root,
        "person_model_enabled": person_model is not None,
        "image_count": len(all_images),
        "checked": 0,
        "ok_count": 0,
        "warn_count": 0,
        "error_count": 0,
        "backend_candidate_count": 0,
        "loose_face_count": 0,
        "issue_counts": {},
        "by_day": {},
        "findings": [],
    }
    issue_counts = Counter()
    by_day = defaultdict(lambda: {
        "checked": 0,
        "ok": 0,
        "warn": 0,
        "error": 0,
        "backend_candidate_count": 0,
        "loose_face_count": 0,
    })
    findings_file = None
    if args.findings_jsonl:
        os.makedirs(os.path.dirname(args.findings_jsonl), exist_ok=True)
        findings_file = open(args.findings_jsonl, "a", encoding="utf-8")
    try:
        for index, (rel_path, src_path) in enumerate(all_images, 1):
            dst_path = os.path.join(redacted_root, rel_path)
            result = audit_one(rel_path, src_path, dst_path, person_model, args.generate)
            day = result["day"] or "unknown"
            day_row = by_day[day]
            day_row["checked"] += 1
            day_row[result["status"]] += 1
            day_row["backend_candidate_count"] += result.get("backend_candidate_count", 0)
            day_row["loose_face_count"] += result.get("loose_face_count", 0)
            summary["checked"] += 1
            summary["backend_candidate_count"] += result.get("backend_candidate_count", 0)
            summary["loose_face_count"] += result.get("loose_face_count", 0)
            if result["status"] == "ok":
                summary["ok_count"] += 1
            elif result["status"] == "warn":
                summary["warn_count"] += 1
            else:
                summary["error_count"] += 1
            if result["issues"]:
                for issue in result["issues"]:
                    issue_counts[issue["type"]] += 1
                if len(summary["findings"]) < args.max_findings:
                    summary["findings"].append(result)
                if findings_file:
                    findings_file.write(json.dumps({"checked_at": now_iso(), **result}, ensure_ascii=False) + "\n")
                    findings_file.flush()
            if args.progress_every > 0 and (index % args.progress_every == 0 or index == len(all_images)):
                elapsed = max(0.001, time.time() - started)
                print(json.dumps({
                    "event": "progress",
                    "checked": index,
                    "total": len(all_images),
                    "rate_per_s": round(index / elapsed, 3),
                    "warn": summary["warn_count"],
                    "error": summary["error_count"],
                    "issues": dict(issue_counts),
                }, ensure_ascii=False), flush=True)
                if args.summary_json:
                    partial = dict(summary)
                    partial["issue_counts"] = dict(issue_counts)
                    partial["by_day"] = dict(sorted(by_day.items()))
                    partial["elapsed_s"] = round(elapsed, 1)
                    partial["updated_at"] = now_iso()
                    write_json(args.summary_json, partial)
    finally:
        if findings_file:
            findings_file.close()

    elapsed = time.time() - started
    summary["finished_at"] = now_iso()
    summary["elapsed_s"] = round(elapsed, 1)
    summary["rate_per_s"] = round(summary["checked"] / max(0.001, elapsed), 3)
    summary["issue_counts"] = dict(issue_counts)
    summary["by_day"] = dict(sorted(by_day.items()))
    summary["ok"] = summary["error_count"] == 0 and summary["warn_count"] == 0
    if args.summary_json:
        write_json(args.summary_json, summary)
    print(json.dumps({"event": "finished", **summary}, ensure_ascii=False), flush=True)
    return summary


def parse_args():
    parser = argparse.ArgumentParser(description="Audit park crowd face redaction/mosaic results.")
    parser.add_argument("--root", default="/home/admin1/jgzj")
    parser.add_argument("--frames-root", default="")
    parser.add_argument("--redacted-root", default="")
    parser.add_argument("--person-model", default="")
    parser.add_argument("--person-service-url", default=os.environ.get("PARK_CROWD_REDACTION_PERSON_SERVICE_URL", ""))
    parser.add_argument("--no-person-model", action="store_true")
    parser.add_argument("--no-generate", dest="generate", action="store_false")
    parser.set_defaults(generate=True)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--day", action="append", default=[])
    parser.add_argument("--rel-list", default="")
    parser.add_argument("--progress-every", type=int, default=200)
    parser.add_argument("--max-findings", type=int, default=200)
    parser.add_argument("--summary-json", default="")
    parser.add_argument("--findings-jsonl", default="")
    parser.add_argument("--continuous", action="store_true")
    parser.add_argument("--interval-seconds", type=int, default=1800)
    return parser.parse_args()


def main():
    args = parse_args()
    root = os.path.abspath(args.root)
    if not args.frames_root:
        args.frames_root = os.path.join(root, ".runtime/park-pcm/crowd-frames")
    if not args.redacted_root:
        args.redacted_root = os.path.join(root, ".runtime/park-pcm/crowd-frames-redacted")
    if not args.person_model:
        args.person_model = os.path.join(root, ".runtime/yolo_model_service/weights/person_yolo_best.pt")
    if not args.summary_json:
        args.summary_json = os.path.join(root, ".runtime/park-pcm/crowd-redaction-audit-summary.json")
    if not args.findings_jsonl:
        args.findings_jsonl = os.path.join(root, ".runtime/park-pcm/crowd-redaction-audit-findings.jsonl")

    person_model = load_person_model(args.person_model, not args.no_person_model, args.person_service_url)
    while True:
        run_once(args, person_model)
        if not args.continuous:
            break
        time.sleep(max(30, args.interval_seconds))


if __name__ == "__main__":
    main()
