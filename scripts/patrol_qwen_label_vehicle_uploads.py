#!/usr/bin/env python3
import argparse
import base64
import concurrent.futures
import hashlib
import io
import json
import os
import re
import time
import urllib.request
from pathlib import Path

from PIL import Image


SCHEMA = "jgzj_vehicle_upload_qwen_label.v2"
MODEL = "Qwen3.6-27B-Labeler"

CLASSES = (
    "person",
    "fire",
    "smoke",
    "trash",
    "pet",
    "stall",
    "phone",
    "smoking",
    "vehicle",
    "nonmotor",
)

ALLOWED_TAGS = {
    "road",
    "sidewalk",
    "park",
    "water",
    "building",
    "gate",
    "parking",
    "night",
    "rain",
    "crowded",
    "empty",
    "indoor",
}

ALLOWED_FLAGS = {
    "person_positive",
    "empty_scene",
    "hard_negative",
    "fire_smoke_candidate",
    "trash_candidate",
    "small_object_candidate",
}

ALLOWED_RISK = {
    "blur",
    "dark",
    "blocked",
    "occluded",
    "tiny_objects",
    "reflection",
    "weather",
}

LABEL_PROMPT = """Label this autonomous patrol vehicle image for dataset mining.
Return one compact JSON object only. No markdown. No explanation. No boxes.

Schema:
{"q":"good|blur|dark|blocked|bad","tags":["road"],"c":{"person":0,"fire":0,"smoke":0,"trash":0,"pet":0,"stall":0,"phone":0,"smoking":0,"vehicle":0,"nonmotor":0},"flags":[],"risk":[]}

Rules:
- Count only visible evidence. Use integer counts 0-9, and 9 for 9+.
- phone means a visible person using/holding a phone.
- smoking means visible cigarette/smoking action.
- fire and smoke must be real flame/smoke, not sunlight, cloud, fog, dust, reflection, or lamp glare.
- trash means visible litter/garbage on ground or around bins.
- pet means visible dog/cat/animal.
- stall means visible street vendor/stall/temporary booth.
- nonmotor means bicycle, e-bike, scooter, wheelchair, or cart.
- tags allowed: road, sidewalk, park, water, building, gate, parking, night, rain, crowded, empty, indoor.
- flags allowed: person_positive, empty_scene, hard_negative, fire_smoke_candidate, trash_candidate, small_object_candidate.
- risk allowed: blur, dark, blocked, occluded, tiny_objects, reflection, weather.
"""


def log(message):
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}", flush=True)


def load_json(path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def save_json_atomic(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def normalize_rel(path):
    return str(path or "").replace("\\", "/").lstrip("/")


def sha256_file(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def cache_path(root, image_sha):
    safe = "".join(ch for ch in str(image_sha or "").lower() if ch in "0123456789abcdef")
    if not safe:
        return None
    return root / safe[:2] / f"{safe}.json"


def iter_rows(frames_root, source, vehicle):
    for meta_path in sorted(frames_root.glob("**/*.json")):
        meta = load_json(meta_path)
        if not isinstance(meta, dict):
            continue
        meta_source = meta.get("source") or "cloud_camera_capture"
        if source and meta_source != source:
            continue
        if vehicle and str(meta.get("vehicle_id") or "") != vehicle:
            continue
        image_rel = normalize_rel(meta.get("image_path"))
        if image_rel:
            image_path = frames_root / image_rel
        else:
            image_path = meta_path.with_suffix(".jpg")
            image_rel = normalize_rel(image_path.relative_to(frames_root))
        if not image_path.exists() or image_path.suffix.lower() not in {".jpg", ".jpeg", ".png", ".webp", ".bmp"}:
            continue
        if not meta.get("image_sha256"):
            meta["image_sha256"] = sha256_file(image_path)
        yield {
            "meta_path": meta_path,
            "image_path": image_path,
            "image_rel": image_rel,
            "meta": meta,
        }


def encode_image(path, max_side, jpeg_quality):
    with Image.open(path) as image:
        image = image.convert("RGB")
        width, height = image.size
        scale = min(1.0, float(max_side) / max(width, height))
        if scale < 1.0:
            image = image.resize((max(1, int(width * scale)), max(1, int(height * scale))), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        image.save(buf, format="JPEG", quality=jpeg_quality, optimize=True)
    return base64.b64encode(buf.getvalue()).decode("ascii"), len(buf.getvalue())


def extract_json(text):
    if not text:
        return None
    clean = text.strip()
    if clean.startswith("```"):
        clean = re.sub(r"^```(?:json)?\s*", "", clean)
        clean = re.sub(r"\s*```$", "", clean)
    try:
        return json.loads(clean)
    except Exception:
        pass
    match = re.search(r"\{.*\}", clean, re.S)
    if not match:
        return None
    try:
        return json.loads(match.group(0))
    except Exception:
        return None


def normalize_annotation(annotation):
    if not isinstance(annotation, dict):
        return None
    quality = str(annotation.get("q") or "bad").strip().lower()
    if quality not in {"good", "blur", "dark", "blocked", "bad"}:
        quality = "bad"

    tags = annotation.get("tags")
    if not isinstance(tags, list):
        tags = []
    tags = [str(tag).strip().lower() for tag in tags]
    tags = [tag for tag in tags if tag in ALLOWED_TAGS][:6]

    counts = {}
    src_counts = annotation.get("c")
    if not isinstance(src_counts, dict):
        src_counts = {}
    for name in CLASSES:
        value = src_counts.get(name, 0)
        try:
            value = int(round(float(value)))
        except Exception:
            value = 0
        counts[name] = max(0, min(9, value))

    flags = annotation.get("flags")
    if not isinstance(flags, list):
        flags = []
    flags = [str(flag).strip().lower() for flag in flags if str(flag).strip().lower() in ALLOWED_FLAGS]

    risk = annotation.get("risk")
    if not isinstance(risk, list):
        risk = []
    risk = [str(item).strip().lower() for item in risk if str(item).strip().lower() in ALLOWED_RISK]

    total_count = sum(counts.values())
    if total_count > 0:
        tags = [tag for tag in tags if tag != "empty"]
        flags = [flag for flag in flags if flag != "empty_scene"]
        if counts["person"] == 0:
            flags = [flag for flag in flags if flag != "person_positive"]
        if counts["fire"] == 0 and counts["smoke"] == 0:
            flags = [flag for flag in flags if flag != "fire_smoke_candidate"]
        if counts["trash"] == 0:
            flags = [flag for flag in flags if flag != "trash_candidate"]
        if counts["phone"] == 0 and counts["smoking"] == 0:
            flags = [flag for flag in flags if flag != "small_object_candidate"]

    if counts["person"] > 0 and "person_positive" not in flags:
        flags.append("person_positive")
    if total_count == 0:
        if "empty" not in tags:
            tags.append("empty")
        if "empty_scene" not in flags:
            flags.append("empty_scene")
    if counts["fire"] > 0 or counts["smoke"] > 0:
        if "fire_smoke_candidate" not in flags:
            flags.append("fire_smoke_candidate")
    if counts["trash"] > 0 and "trash_candidate" not in flags:
        flags.append("trash_candidate")
    if counts["phone"] > 0 or counts["smoking"] > 0:
        if "small_object_candidate" not in flags:
            flags.append("small_object_candidate")

    return {
        "q": quality,
        "tags": list(dict.fromkeys(tags))[:6],
        "c": counts,
        "flags": list(dict.fromkeys(flags))[:8],
        "risk": list(dict.fromkeys(risk))[:8],
    }


def call_qwen(service_url, image_b64, timeout_s, max_tokens):
    payload = {
        "model": MODEL,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": LABEL_PROMPT},
                    {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + image_b64}},
                ],
            }
        ],
        "temperature": 0,
        "max_tokens": max_tokens,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        service_url.rstrip("/") + "/v1/chat/completions",
        data=body,
        method="POST",
        headers={"content-type": "application/json", "accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        return json.loads(resp.read().decode("utf-8"))


def annotate_one(row, args):
    meta = row["meta"]
    out_path = cache_path(args.output_root, meta.get("image_sha256"))
    if out_path is None:
        return "skip:no_sha"
    if out_path.exists() and not args.refresh:
        return "skip:cached"
    started = time.time()
    image_b64, encoded_bytes = encode_image(row["image_path"], args.max_side, args.jpeg_quality)
    response = call_qwen(args.service_url, image_b64, args.timeout_s, args.max_tokens)
    choice = (response.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    raw_text = message.get("content") or message.get("reasoning") or ""
    parsed = extract_json(raw_text)
    annotation = normalize_annotation(parsed)
    ok = isinstance(annotation, dict)
    payload = {
        "schema": SCHEMA,
        "image_sha256": meta.get("image_sha256"),
        "image_path": row["image_rel"],
        "source": meta.get("source") or "cloud_camera_capture",
        "vehicle_id": meta.get("vehicle_id"),
        "camera_id": meta.get("camera_id"),
        "collected_at": meta.get("collected_at"),
        "meta_path": normalize_rel(row["meta_path"].relative_to(args.frames_root)),
        "annotated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "model": MODEL,
        "service_url": args.service_url,
        "image_request": {
            "max_side": args.max_side,
            "jpeg_quality": args.jpeg_quality,
            "encoded_bytes": encoded_bytes,
        },
        "ok": ok,
        "annotation": annotation,
        "raw_text": raw_text if (args.store_raw or not ok) else "",
        "finish_reason": choice.get("finish_reason"),
        "usage": response.get("usage"),
        "duration_ms": int((time.time() - started) * 1000),
    }
    save_json_atomic(out_path, payload)
    if not ok:
        return "error:parse"
    counts = annotation.get("c") if isinstance(annotation.get("c"), dict) else {}
    flags = annotation.get("flags") if isinstance(annotation.get("flags"), list) else []
    if "fire_smoke_candidate" in flags:
        return "ok:fire_smoke"
    if counts.get("person", 0) > 0:
        return "ok:person"
    if "empty_scene" in flags:
        return "ok:empty"
    return "ok:other"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--frames-root", type=Path, default=Path("/home/admin1/jgzj/.runtime/park-pcm/crowd-frames"))
    parser.add_argument("--output-root", type=Path, default=Path("/home/admin1/jgzj/.runtime/yolo_label_review/vehicle_upload_qwen_labels_v2"))
    parser.add_argument("--service-url", default="http://127.0.0.1:18016")
    parser.add_argument("--source", default="auto_ad_patrol_flow_upload")
    parser.add_argument("--vehicle", default="")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--timeout-s", type=int, default=120)
    parser.add_argument("--max-side", type=int, default=640)
    parser.add_argument("--jpeg-quality", type=int, default=70)
    parser.add_argument("--max-tokens", type=int, default=192)
    parser.add_argument("--store-raw", action="store_true")
    args = parser.parse_args()

    rows = list(iter_rows(args.frames_root, args.source, args.vehicle))
    rows.sort(key=lambda row: str(row["meta"].get("collected_at") or ""), reverse=True)
    if args.limit > 0:
        rows = rows[:args.limit]
    log(f"rows={len(rows)} source={args.source or 'all'} vehicle={args.vehicle or 'all'} workers={args.workers} output={args.output_root}")

    counts = {}
    started = time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futures = {pool.submit(annotate_one, row, args): row for row in rows}
        for idx, future in enumerate(concurrent.futures.as_completed(futures), 1):
            try:
                status = future.result()
            except KeyboardInterrupt:
                raise
            except Exception as exc:
                status = f"error:{type(exc).__name__}:{exc}"
            key = status.split(":", 1)[0]
            counts[key] = counts.get(key, 0) + 1
            if idx == 1 or idx % 20 == 0 or idx == len(rows):
                elapsed = max(0.001, time.time() - started)
                log(f"{idx}/{len(rows)} {status} rate={idx/elapsed:.2f}/s counts={counts}")


if __name__ == "__main__":
    main()
