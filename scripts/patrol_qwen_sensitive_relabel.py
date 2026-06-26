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


SCHEMA = "jgzj_vehicle_upload_qwen_sensitive_bbox.v3"
MODEL = "Qwen3.6-27B-Labeler"
MODEL_BUNDLE = "qwen_bbox_sensitive_v3"
TARGET_CLASSES = ("smoke", "trash", "stall", "phone", "smoking")

CLASS_RULES = {
    "smoke": {
        "threshold": 0.95,
        "positive": (
            "Only label real smoke from combustion/fire/cigarette: gray/black/brown airborne plume, "
            "semi-transparent drifting region, or smoke clearly emitted from a burning source."
        ),
        "negative": (
            "Do NOT label fog, mist, water spray, fountain spray, steam from water/landscape, cloud, haze, "
            "lens glare, dust, reflection, overexposed sky, water surface, or bright background."
        ),
        "reject_re": r"fog|mist|water|spray|steam|fountain|cloud|haze|glare|reflection|dust|sky|lens|uncertain|not_smoke",
    },
    "trash": {
        "threshold": 0.90,
        "positive": (
            "Only label loose discarded litter/waste on the ground: plastic bottle, plastic bag, paper, cardboard, "
            "food container, cup, or obvious rubbish not attached to a fixture."
        ),
        "negative": (
            "Do NOT label trash bins/cans, waste bins, fixed boxes, signs, posters, benches, flower pots, leaves, "
            "branches, drain covers, manhole covers, shadows, road markings, bags carried by people, or normal facilities."
        ),
        "reject_re": r"bin|trash_can|waste_bin|garbage_can|dustbin|sign|poster|bench|flower|pot|leaf|leaves|branch|drain|manhole|shadow|fixture|carried|uncertain|not_trash",
    },
    "stall": {
        "threshold": 0.90,
        "positive": (
            "Only label temporary vending or illegal stall setups: movable cart, temporary table, umbrella/tent with goods, "
            "vendor goods laid out for sale, or person operating a temporary selling setup."
        ),
        "negative": (
            "Do NOT label permanent kiosks, fixed booths, information/security booths, storefronts, buildings, scenic facilities, "
            "signboards, trash bins, normal parked carts, benches, flower stands, or fixed decorations."
        ),
        "reject_re": r"permanent|fixed|kiosk|security|information|storefront|building|scenic|facility|sign|signboard|trash|bin|bench|decoration|parked|uncertain|not_stall",
    },
    "phone": {
        "threshold": 0.88,
        "positive": (
            "Only label a clearly visible mobile phone device in a person's hand or near the ear. "
            "The rectangular device must be visible, not just a hand gesture."
        ),
        "negative": (
            "Do NOT label hand only, fingers, sleeve, clothes, wallet, card, badge, cup, bottle, food, microphone, mask, "
            "or any unclear tiny object."
        ),
        "reject_re": r"hand_only|finger|sleeve|clothes|wallet|card|badge|cup|bottle|food|microphone|mask|unclear|uncertain|not_phone",
    },
    "smoking": {
        "threshold": 0.92,
        "positive": (
            "Only label visible smoking evidence: cigarette/cigar/vape at mouth or in fingers, or smoke clearly coming from mouth/hand. "
            "Use a tight box around the cigarette/vape/smoking evidence, not the whole person."
        ),
        "negative": (
            "Do NOT label eating, drinking, hand near mouth without visible cigarette/vape, phone near mouth, mask, toothpick, "
            "or unclear hand/object near face."
        ),
        "reject_re": r"eat|eating|drink|drinking|hand_only|hand_to_mouth|phone|mask|toothpick|unclear|uncertain|no_cigarette|not_smoking",
    },
}


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


def encode_image(path, max_side, jpeg_quality):
    with Image.open(path) as image:
        image = image.convert("RGB")
        width, height = image.size
        scale = min(1.0, float(max_side) / max(width, height))
        if scale < 1.0:
            image = image.resize((max(1, int(width * scale)), max(1, int(height * scale))), Image.Resampling.LANCZOS)
        encoded_width, encoded_height = image.size
        buf = io.BytesIO()
        image.save(buf, format="JPEG", quality=jpeg_quality, optimize=True)
    return base64.b64encode(buf.getvalue()).decode("ascii"), {
        "original_width": width,
        "original_height": height,
        "encoded_width": encoded_width,
        "encoded_height": encoded_height,
        "encoded_bytes": len(buf.getvalue()),
        "max_side": max_side,
        "jpeg_quality": jpeg_quality,
    }


def build_prompt(class_name):
    rule = CLASS_RULES[class_name]
    return f"""You are creating high-precision YOLO candidate boxes for ONE class only: {class_name}.
Return exactly one compact JSON object only. No markdown. No explanation.

Schema:
{{"q":"good","b":[["{class_name}",12,34,56,78,0.95,"clear_evidence"]]}}

Fields:
- q is one of: good, blur, dark, blocked, bad.
- b has at most 8 boxes.
- each box is ["{class_name}",x1,y1,x2,y2,score,evidence].
- coordinates are integer 0-1000 xyxy on the full image. Clamp to bounds.
- x2>x1 and y2>y1. Use tight visible-object boxes.
- evidence must be short snake_case and must describe visible positive evidence.

Positive rule:
{rule["positive"]}

Reject rule:
{rule["negative"]}

Decision policy:
- If uncertain, return no boxes. Prefer false negatives over false positives.
- Do not infer from context; box only what is visually clear.
- If no valid {class_name} target is visible, return {{"q":"good","b":[]}}.
"""


def extract_json(text):
    clean = str(text or "").strip()
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


def clamp(value, low, high):
    return max(low, min(high, value))


def normalize_box(class_name, item, index):
    if not isinstance(item, (list, tuple)) or len(item) < 5:
        return None
    if str(item[0]).strip().lower().replace("-", "_") != class_name:
        return None
    try:
        x1, y1, x2, y2 = [float(v) for v in item[1:5]]
    except Exception:
        return None
    score = None
    note = ""
    if len(item) >= 6:
        try:
            score = float(item[5])
        except Exception:
            note = str(item[5] or "").strip()[:160]
    if len(item) >= 7:
        note = str(item[6] or "").strip()[:160]
    if score is None:
        return None
    score = clamp(score, 0.0, 1.0)
    rule = CLASS_RULES[class_name]
    if score < float(rule["threshold"]):
        return None
    if re.search(rule["reject_re"], note, re.I):
        return None
    if max(abs(x1), abs(y1), abs(x2), abs(y2)) <= 1.5:
        x1, y1, x2, y2 = x1 * 1000.0, y1 * 1000.0, x2 * 1000.0, y2 * 1000.0
    x1 = clamp(x1, 0.0, 1000.0)
    y1 = clamp(y1, 0.0, 1000.0)
    x2 = clamp(x2, 0.0, 1000.0)
    y2 = clamp(y2, 0.0, 1000.0)
    if x2 <= x1 or y2 <= y1:
        return None
    x = ((x1 + x2) / 2.0) / 1000.0
    y = ((y1 + y2) / 2.0) / 1000.0
    w = (x2 - x1) / 1000.0
    h = (y2 - y1) / 1000.0
    return {
        "model_task": "qwen_sensitive_bbox",
        "class_name": class_name,
        "confidence": score,
        "x": x,
        "y": y,
        "w": w,
        "h": h,
        "raw": f"{class_name} {x:.6f} {y:.6f} {w:.6f} {h:.6f}",
        "box": {
            "x_center": x,
            "y_center": y,
            "width": w,
            "height": h,
            "bbox_1000": [round(x1), round(y1), round(x2), round(y2)],
        },
        "note": note,
        "index": index,
    }


def call_qwen(service_url, image_b64, class_name, timeout_s, max_tokens):
    payload = {
        "model": MODEL,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": build_prompt(class_name)},
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


def collect_candidates(cache_root, classes):
    candidates = {}
    for path in cache_root.rglob("*.json"):
        payload = load_json(path)
        if not isinstance(payload, dict):
            continue
        image_rel = normalize_rel(payload.get("image_path"))
        image_sha = payload.get("image_sha256")
        old_classes = set()
        for label in payload.get("labels") or []:
            class_name = label.get("class_name")
            if class_name in classes:
                old_classes.add(class_name)
        if not image_rel or not image_sha or not old_classes:
            continue
        item = candidates.setdefault(image_rel, {"image_sha256": image_sha, "old_classes": set(), "source": payload})
        item["old_classes"].update(old_classes)
    return candidates


def annotate_task(args_tuple):
    image_rel, image_sha, class_name, args = args_tuple
    image_path = args.frames_root / image_rel
    if not image_path.exists():
        return image_rel, class_name, {"ok": False, "error": "missing_image", "labels": []}
    started = time.time()
    image_b64, image_request = encode_image(image_path, args.max_side, args.jpeg_quality)
    response = call_qwen(args.service_url, image_b64, class_name, args.timeout_s, args.max_tokens)
    choice = (response.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    raw_text = message.get("content") or message.get("reasoning") or ""
    parsed = extract_json(raw_text)
    labels = []
    quality = "bad"
    if isinstance(parsed, dict):
        quality = str(parsed.get("q") or parsed.get("quality") or "bad").lower()
        boxes = parsed.get("b") if isinstance(parsed.get("b"), list) else parsed.get("boxes")
        if not isinstance(boxes, list):
            boxes = []
        for index, item in enumerate(boxes):
            label = normalize_box(class_name, item, index)
            if label:
                labels.append(label)
    return image_rel, class_name, {
        "ok": isinstance(parsed, dict),
        "quality": quality,
        "labels": labels,
        "raw_json": parsed if args.store_raw else None,
        "raw_text": raw_text if args.store_raw else "",
        "finish_reason": choice.get("finish_reason"),
        "duration_ms": int((time.time() - started) * 1000),
        "image_request": image_request,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--frames-root", type=Path, default=Path("/home/admin1/jgzj/.runtime/park-pcm/crowd-frames"))
    parser.add_argument("--source-cache-root", type=Path, default=Path("/home/admin1/jgzj/.runtime/yolo_label_review/vehicle_upload_qwen_bbox_labels_v1"))
    parser.add_argument("--output-root", type=Path, default=Path("/home/admin1/jgzj/.runtime/yolo_label_review/vehicle_upload_qwen_sensitive_bbox_v3"))
    parser.add_argument("--service-url", default="http://127.0.0.1:18016")
    parser.add_argument("--classes", default=",".join(TARGET_CLASSES))
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--max-side", type=int, default=960)
    parser.add_argument("--jpeg-quality", type=int, default=82)
    parser.add_argument("--timeout-s", type=int, default=120)
    parser.add_argument("--max-tokens", type=int, default=768)
    parser.add_argument("--store-raw", action="store_true")
    args = parser.parse_args()

    classes = [c.strip() for c in args.classes.split(",") if c.strip()]
    for class_name in classes:
        if class_name not in TARGET_CLASSES:
            raise SystemExit(f"unsupported class: {class_name}")
    candidates = collect_candidates(args.source_cache_root, set(classes))
    image_items = sorted(candidates.items())
    if args.limit > 0:
        image_items = image_items[:args.limit]
    tasks = []
    for image_rel, item in image_items:
        for class_name in sorted(item["old_classes"] & set(classes)):
            tasks.append((image_rel, item["image_sha256"], class_name, args))
    log(f"images={len(image_items)} tasks={len(tasks)} classes={classes} output={args.output_root}")

    results = {}
    started = time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        future_map = {pool.submit(annotate_task, task): task for task in tasks}
        for done, future in enumerate(concurrent.futures.as_completed(future_map), 1):
            image_rel, image_sha, class_name, _ = future_map[future]
            try:
                rel, cls, result = future.result()
            except Exception as exc:
                rel, cls, result = image_rel, class_name, {"ok": False, "error": f"{type(exc).__name__}:{exc}", "labels": []}
            image_result = results.setdefault(rel, {"image_sha256": image_sha, "per_class": {}, "labels": []})
            image_result["per_class"][cls] = result
            image_result["labels"].extend(result.get("labels") or [])
            if done == 1 or done % 10 == 0 or done == len(tasks):
                elapsed = max(0.001, time.time() - started)
                log(f"{done}/{len(tasks)} {rel} {cls} labels={len(result.get('labels') or [])} rate={done/elapsed:.2f}/s")

    for image_rel, item in results.items():
        source = candidates[image_rel]["source"]
        image_sha = item["image_sha256"]
        out_path = cache_path(args.output_root, image_sha)
        payload = {
            "schema": SCHEMA,
            "image_sha256": image_sha,
            "image_path": image_rel,
            "source": source.get("source"),
            "vehicle_id": source.get("vehicle_id"),
            "camera_id": source.get("camera_id"),
            "collected_at": source.get("collected_at"),
            "annotated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "model": MODEL,
            "model_bundle": MODEL_BUNDLE,
            "service_url": args.service_url,
            "ok": all(v.get("ok") for v in item["per_class"].values()),
            "old_classes": sorted(candidates[image_rel]["old_classes"] & set(classes)),
            "labels": item["labels"],
            "per_class": item["per_class"],
        }
        save_json_atomic(out_path, payload)
    log(f"wrote_images={len(results)}")


if __name__ == "__main__":
    main()
