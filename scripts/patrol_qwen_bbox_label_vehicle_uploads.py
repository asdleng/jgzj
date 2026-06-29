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


SCHEMA = "jgzj_vehicle_upload_qwen_bbox_label.v1"
MODEL = "Qwen3.6-27B-Labeler"
MODEL_BUNDLE = "qwen_bbox_v5_precision_pet_parse"
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

LABEL_PROMPT = """Detect high-precision YOLO pre-label boxes in this autonomous patrol vehicle image.
Return exactly one compact JSON object only. No markdown. No explanation.

Precision is more important than recall. When evidence is weak, return fewer boxes.

Schema:
{"q":"good","b":[["person",12,34,56,78,0.9,"live_person"]]}

Fields:
- q is one of: good, blur, dark, blocked, bad.
- b has at most 20 boxes.
- each box is [class,x1,y1,x2,y2,score,evidence]. score must be a numeric value from 0.0 to 1.0. evidence must be a double-quoted JSON string.
- coordinates are integer 0-1000 xyxy on the full image. Clamp to bounds.
- x2>x1 and y2>y1. Use tight visible-object boxes.
- evidence is a short snake_case phrase proving the object is real and visible.

Classes:
person, vehicle, nonmotor, fire, smoke, trash, pet, stall, phone, smoking.

Positive class rules:
- person: visible real human body/head/torso/limbs. Do not label posters, mannequins, statues, reflections, or screen images.
- vehicle: real car/truck/bus/van/parked vehicle. Do not label signs, toy models, vehicle pictures, or reflections.
- nonmotor: real bicycle/e-bike/scooter/wheelchair/hand cart/stroller. Do not label road markings, sign icons, or distant ambiguous rails.
- phone: visible handheld mobile phone or clear hand-phone interaction. Do not label black rectangles, dashboards, bags, screens on walls, traffic signs, or car mirrors.
- smoking: visible cigarette/cigar/vape OR clear smoke from a person's mouth/hand. Box the cigarette/hand-mouth evidence tightly. Do not label a whole person only because a hand is near the mouth.

High-risk classes, use only when visual evidence is very strong:
- fire: actual visible flame with flame shape and orange/yellow luminous core. Do NOT label red fire extinguisher boxes, hydrants,消防箱, red signs, warning boards, lamps, reflections, taillights, traffic lights, red clothes, cones, or red/orange equipment as fire.
- smoke: real smoke plume/cloud from burning or exhaust, with semi-transparent rising/flowing shape. Do NOT label fog, mist, steam, water spray, lens haze, glare, clouds, dust, shadows, blur, low-light noise, or bright overexposure as smoke.
- trash: loose discarded waste lying on the ground/road/path, such as bottle, paper, plastic bag, cardboard, food wrapper. Do NOT label trash bins, garbage cans, recycling boxes, storage boxes, planters, cones, leaves, stones, signs, fixed facilities, parked objects, or construction materials as trash.
- pet: LIVE pet animal only, mainly dog/cat. Must show live-animal evidence such as head/body/legs/fur/tail/posture/leash/person interaction. Require separately visible animal body parts, e.g. head plus legs/tail/body contour. Do NOT label statues, sculptures, toys, dolls, mascots, mannequins, animal pictures, signs, decorations, white stone/resin animals, repeated fixed animal-shaped objects, low white blurry blobs, birds, ducks, geese, chickens, wild animals, or livestock sculptures. In dark/night frames, omit pet unless the dog/cat is close, large, and unmistakable.
- stall: temporary vendor stall/booth with selling setup, canopy/table/goods/person operating it. Do NOT label fixed kiosks, guard booths, bus shelters, building entrances, permanent pavilions, ordinary tents, umbrellas, fences, or storage piles as stall.

Rules:
- Do not invent boxes. If uncertain, omit. Prefer false negatives over false positives.
- For fire/smoke/pet/trash/stall/phone/smoking, always include numeric score and a double-quoted evidence string that names the visible proof, e.g. "actual_flame", "rising_smoke_plume", "live_dog_leash", "loose_plastic_bottle_on_ground", "vendor_table_goods", "handheld_phone", "visible_cigarette". Boxes without numeric score are invalid.
- For dark/blurred/blocked frames, do not label pet/trash/stall/phone/smoking unless the object is large and unmistakable.
- Never use evidence phrases like red_box, red_sign, fire_box, extinguisher, trash_bin, fog, mist, haze, statue, sculpture, fixed_kiosk, or unknown_object as a positive target.
- Ignore sky, trees, buildings, road, shadows, reflections, traffic lights, and text unless part of a target.
- Prefer fewer precise boxes. In crowded scenes keep the 20 largest/clearest targets.
- For small/distant ambiguous objects, omit unless the target class is visually clear.
- If no allowed targets are visible, return {"q":"good","b":[]}.
"""

FIRE_REJECT_NOTE_RE = re.compile(
    r"fire[_ -]?box|extinguisher|hydrant|red[_ -]?(?:box|sign|board|panel|cabinet|equipment|object)|"
    r"warning|notice|poster|banner|traffic[_ -]?light|taillight|lamp|reflection|clothes|cone|orange[_ -]?equipment|"
    r"消防|灭火器|消防箱|消火栓|警示|告示|标牌",
    re.I,
)
FIRE_ACCEPT_NOTE_RE = re.compile(r"flame|fire_flame|actual_flame|burning|orange_flame|yellow_flame|visible_flame", re.I)

SMOKE_REJECT_NOTE_RE = re.compile(
    r"fog|mist|steam|water[_ -]?spray|spray|haze|lens|glare|cloud|dust|shadow|blur|noise|overexposure|"
    r"雾|水汽|蒸汽|水雾|镜头|眩光|云|灰尘|模糊",
    re.I,
)
SMOKE_ACCEPT_NOTE_RE = re.compile(r"smoke|smoke_plume|rising_smoke|exhaust_smoke|burning_smoke", re.I)

PET_REJECT_NOTE_RE = re.compile(
    r"statue|sculpture|toy|doll|mascot|mannequin|picture|poster|sign|decoration|"
    r"stone|resin|fake|white_goat|white_sheep|goat_statue|sheep_statue|dog_statue|"
    r"fixed|ornament|bird|goose|duck|chicken|livestock|雕塑|雕像|玩具|装饰|石头|树脂|假|鸟|鸭|鹅|鸡",
    re.I,
)
PET_ACCEPT_NOTE_RE = re.compile(
    r"live_(?:dog|cat)|dog_(?:with_)?(?:leash|head|legs|tail|body|fur)|cat_(?:head|legs|tail|body|fur)|"
    r"pet_(?:dog|cat)|leashed_dog|clear_dog|clear_cat",
    re.I,
)

TRASH_REJECT_NOTE_RE = re.compile(
    r"bin|trash_can|garbage_can|waste_bin|dustbin|recycling|box_fixture|storage|container|cabinet|"
    r"sign|poster|leaf|leaves|stone|rock|cone|planter|fixed|facility|construction|bucket|"
    r"垃圾桶|果皮箱|回收箱|箱体|标识|树叶|石头|路锥|花箱|固定设施|施工",
    re.I,
)
TRASH_ACCEPT_NOTE_RE = re.compile(r"loose|discarded|ground|road|bottle|paper|plastic|bag|cardboard|wrapper|litter|waste", re.I)

STALL_REJECT_NOTE_RE = re.compile(
    r"fixed|permanent|kiosk|guard[_ -]?booth|bus[_ -]?shelter|building|entrance|pavilion|fence|storage|pile|"
    r"固定|永久|岗亭|保安亭|公交亭|建筑入口|亭子|围栏|堆放",
    re.I,
)
STALL_ACCEPT_NOTE_RE = re.compile(r"vendor|stall|booth|selling|goods|table|canopy|market|cart", re.I)

PHONE_REJECT_NOTE_RE = re.compile(r"sign|screen_on_wall|dashboard|mirror|black_rectangle|bag|reflection|traffic", re.I)
PHONE_ACCEPT_NOTE_RE = re.compile(r"handheld|phone|mobile|smartphone|hand_phone|screen_in_hand", re.I)

SMOKING_REJECT_NOTE_RE = re.compile(r"hand_near_mouth_only|unclear|food|drink|microphone|mask|shadow", re.I)
SMOKING_ACCEPT_NOTE_RE = re.compile(r"cigarette|cigar|vape|smoke_from_mouth|smoking|lit_tip", re.I)


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


def load_image_list(path):
    if not path:
        return None
    values = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        line = normalize_rel(line.split("#", 1)[0].strip())
        if line:
            values.add(line)
    return values


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


def salvage_truncated_annotation(text):
    clean = str(text or "")
    quality = None
    quality_match = re.search(r'"(?:q|quality)"\s*:\s*"(good|blur|dark|blocked|bad)"', clean, re.I)
    if quality_match:
        quality = quality_match.group(1).lower()

    num = r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)"
    compact_re = re.compile(
        rf'\[\s*"([^"]+)"\s*,\s*({num})\s*,\s*({num})\s*,\s*({num})\s*,\s*({num})'
        rf'(?:\s*,\s*({num}))?(?:\s*,\s*(?:"([^"]*)"|([A-Za-z_][A-Za-z0-9_ -]*)))?\s*\]'
    )
    compact_boxes = []
    for match in compact_re.finditer(clean):
        class_name = match.group(1)
        coords = [float(match.group(i)) for i in range(2, 6)]
        score = match.group(6)
        evidence = match.group(7) or match.group(8)
        item = [class_name] + coords
        if score is not None:
            item.append(float(score))
        if evidence is not None:
            if score is None:
                item.append(None)
            item.append(evidence)
        compact_boxes.append(item)
        if len(compact_boxes) >= 20:
            break
    if compact_boxes:
        return {"q": quality or "bad", "b": compact_boxes}

    dict_re = re.compile(
        rf'\{{\s*"(?:class|class_name|label)"\s*:\s*"([^"]+)"\s*,\s*"(?:bbox|box|xyxy)"\s*:\s*'
        rf'\[\s*({num})\s*,\s*({num})\s*,\s*({num})\s*,\s*({num})\s*\]'
        rf'(?:\s*,\s*"(?:score|confidence)"\s*:\s*({num}))?',
        re.I,
    )
    boxes = []
    for match in dict_re.finditer(clean):
        class_name = match.group(1)
        coords = [float(match.group(i)) for i in range(2, 6)]
        score = match.group(6)
        item = {"class": class_name, "bbox": coords}
        if score is not None:
            item["score"] = float(score)
        boxes.append(item)
        if len(boxes) >= 20:
            break
    if boxes:
        return {"quality": quality or "bad", "boxes": boxes}
    if quality and re.search(r'"(?:b|boxes)"\s*:\s*\[\s*\]', clean):
        return {"q": quality, "b": []}
    return None


def extract_json(text):
    if not text:
        return None
    clean = str(text).strip()
    if clean.startswith("```"):
        clean = re.sub(r"^```(?:json)?\s*", "", clean)
        clean = re.sub(r"\s*```$", "", clean)
    try:
        return json.loads(clean)
    except Exception:
        pass
    match = re.search(r"\{.*\}", clean, re.S)
    if not match:
        return salvage_truncated_annotation(clean)
    try:
        return json.loads(match.group(0))
    except Exception:
        return salvage_truncated_annotation(clean)


def clamp(value, low, high):
    return max(low, min(high, value))


def normalize_box(item, index):
    score = None
    note = ""
    if isinstance(item, (list, tuple)):
        if len(item) >= 5 and isinstance(item[0], str):
            class_name = str(item[0]).strip().lower()
            bbox = list(item[1:5])
            if len(item) >= 6:
                if isinstance(item[5], str) and not re.fullmatch(r"\s*[-+]?(?:\d+(?:\.\d*)?|\.\d+)\s*", item[5]):
                    note = str(item[5] or "").strip()[:160]
                else:
                    score = item[5]
            if len(item) >= 7:
                note = str(item[6] or "").strip()[:160]
        elif len(item) >= 2 and isinstance(item[0], str) and isinstance(item[1], (list, tuple)):
            class_name = str(item[0]).strip().lower()
            bbox = list(item[1])
            if len(item) >= 3:
                score = item[2]
        else:
            return None
    elif isinstance(item, dict):
        class_name = str(item.get("class") or item.get("class_name") or item.get("label") or "").strip().lower()
        bbox = item.get("bbox") or item.get("box") or item.get("xyxy")
        score = item.get("score", item.get("confidence", None))
        note = str(item.get("note") or "").strip()[:160]
    else:
        return None
    class_name = class_name.replace("-", "_").replace(" ", "_")
    if class_name in {"car", "truck", "bus", "van"}:
        class_name = "vehicle"
    if class_name in {"bike", "bicycle", "ebike", "e_bike", "scooter", "cart"}:
        class_name = "nonmotor"
    if class_name not in CLASSES:
        return None
    if not isinstance(bbox, list) or len(bbox) != 4:
        return None
    try:
        x1, y1, x2, y2 = [float(v) for v in bbox]
    except Exception:
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
    try:
        score = float(score)
    except Exception:
        score = None
    if score is not None:
        score = clamp(score, 0.0, 1.0)
    if class_name == "fire":
        if score is not None and score < 0.80:
            return None
        if FIRE_REJECT_NOTE_RE.search(note):
            return None
        if note and not FIRE_ACCEPT_NOTE_RE.search(note):
            return None
    if class_name == "smoke":
        if score is not None and score < 0.85:
            return None
        if SMOKE_REJECT_NOTE_RE.search(note):
            return None
        if note and not SMOKE_ACCEPT_NOTE_RE.search(note):
            return None
    if class_name == "pet":
        if score is None or score < 0.95:
            return None
        if PET_REJECT_NOTE_RE.search(note):
            return None
        if note and not PET_ACCEPT_NOTE_RE.search(note):
            return None
    if class_name == "trash":
        if score is not None and score < 0.80:
            return None
        if TRASH_REJECT_NOTE_RE.search(note):
            return None
        if note and not TRASH_ACCEPT_NOTE_RE.search(note):
            return None
    if class_name == "stall":
        if score is not None and score < 0.85:
            return None
        if STALL_REJECT_NOTE_RE.search(note):
            return None
        if note and not STALL_ACCEPT_NOTE_RE.search(note):
            return None
    if class_name == "phone":
        if score is not None and score < 0.75:
            return None
        if PHONE_REJECT_NOTE_RE.search(note):
            return None
        if note and not PHONE_ACCEPT_NOTE_RE.search(note):
            return None
    if class_name == "smoking":
        if score is not None and score < 0.80:
            return None
        if SMOKING_REJECT_NOTE_RE.search(note):
            return None
        if note and not SMOKING_ACCEPT_NOTE_RE.search(note):
            return None
    raw = f"{class_name} {x:.6f} {y:.6f} {w:.6f} {h:.6f}"
    return {
        "model_task": "qwen_bbox",
        "class_name": class_name,
        "class_id": CLASSES.index(class_name),
        "confidence": score,
        "x": x,
        "y": y,
        "w": w,
        "h": h,
        "raw": raw,
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


def box_iou(a, b):
    ax1, ay1, ax2, ay2 = a["box"]["bbox_1000"]
    bx1, by1, bx2, by2 = b["box"]["bbox_1000"]
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0, ix2 - ix1), max(0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    area_a = max(0, ax2 - ax1) * max(0, ay2 - ay1)
    area_b = max(0, bx2 - bx1) * max(0, by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def dedupe_labels(labels):
    kept = []
    ordered = sorted(labels, key=lambda item: item["confidence"] if item["confidence"] is not None else 0.0, reverse=True)
    for label in ordered:
        duplicate = False
        for old in kept:
            if old["class_name"] == label["class_name"] and box_iou(old, label) >= 0.55:
                duplicate = True
                break
        if duplicate:
            continue
        label["index"] = len(kept)
        kept.append(label)
    return kept


def normalize_annotation(parsed):
    if not isinstance(parsed, dict):
        return None, []
    quality = str(parsed.get("quality") or parsed.get("q") or "bad").strip().lower()
    if quality not in {"good", "blur", "dark", "blocked", "bad"}:
        quality = "bad"
    boxes = parsed.get("b")
    if not isinstance(boxes, list):
        boxes = parsed.get("boxes")
    if not isinstance(boxes, list):
        boxes = []
    labels = []
    for index, item in enumerate(boxes):
        label = normalize_box(item, index)
        if label:
            labels.append(label)
    labels = dedupe_labels(labels)
    high_risk = {"fire", "smoke", "pet", "trash", "stall", "phone", "smoking"}
    filtered = []
    for label in labels:
        cls = label["class_name"]
        if cls in high_risk and label.get("confidence") is None:
            continue
        if quality != "good" and cls in {"pet", "trash", "stall", "phone", "smoking"}:
            continue
        if cls == "trash" and label.get("w", 0) * label.get("h", 0) < 0.0015:
            continue
        filtered.append(label)
    labels = filtered
    labels.sort(key=lambda item: (item["class_name"], -(item["confidence"] if item["confidence"] is not None else 0.0)))
    return quality, labels


def cache_has_qwen_bbox(path):
    payload = load_json(path)
    if not isinstance(payload, dict):
        return False
    return payload.get("schema") == SCHEMA and isinstance(payload.get("labels"), list) and payload.get("ok") is not False


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
    ok = quality is not None
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
        "model_bundle": MODEL_BUNDLE,
        "service_url": args.service_url,
        "image_request": image_request,
        "ok": ok,
        "quality": quality or "bad",
        "labels": labels,
        "raw_json": parsed if args.store_raw else None,
        "raw_text": raw_text if (args.store_raw or not ok or choice.get("finish_reason") == "length") else "",
        "finish_reason": choice.get("finish_reason"),
        "duration_ms": int((time.time() - started) * 1000),
    }
    save_json_atomic(out_path, payload)
    return f"ok:{len(labels)}" if ok else "error:parse"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--frames-root", type=Path, default=Path("/home/admin1/jgzj/.runtime/park-pcm/crowd-frames"))
    parser.add_argument("--output-root", type=Path, default=Path("/home/admin1/jgzj/.runtime/yolo_label_review/vehicle_upload_qwen_bbox_labels_v1"))
    parser.add_argument("--service-url", default="http://127.0.0.1:18016")
    parser.add_argument("--source", default="auto_ad_patrol_flow_upload")
    parser.add_argument("--vehicle", default="")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--store-raw", action="store_true")
    parser.add_argument("--max-side", type=int, default=960)
    parser.add_argument("--jpeg-quality", type=int, default=82)
    parser.add_argument("--timeout-s", type=int, default=120)
    parser.add_argument("--max-tokens", type=int, default=768)
    parser.add_argument("--only-missing", action="store_true", help="Only submit images without an existing valid qwen bbox cache.")
    parser.add_argument("--image-list", type=Path, default=None, help="Optional newline-delimited image_path list relative to frames root.")
    args = parser.parse_args()

    rows = list(iter_rows(args.frames_root, args.source, args.vehicle))
    image_filter = load_image_list(args.image_list)
    if image_filter is not None:
        rows = [row for row in rows if row["image_rel"] in image_filter]
    rows.sort(key=lambda row: str(row["meta"].get("collected_at") or ""), reverse=True)
    source_rows = len(rows)
    if args.only_missing and not args.refresh:
        rows = [
            row for row in rows
            if (cache_path(args.output_root, row["meta"].get("image_sha256")) is not None
                and not cache_has_qwen_bbox(cache_path(args.output_root, row["meta"].get("image_sha256"))))
        ]
    if args.limit > 0:
        rows = rows[:args.limit]
    log(
        f"source_rows={source_rows} rows={len(rows)} only_missing={args.only_missing} "
        f"source={args.source or 'all'} workers={args.workers} output={args.output_root}"
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
            counts[status.split(":", 1)[0]] = counts.get(status.split(":", 1)[0]) or 0
            counts[status.split(":", 1)[0]] += 1
            if idx == 1 or idx % 10 == 0 or idx == len(rows):
                elapsed = max(0.001, time.time() - started)
                log(f"{idx}/{len(rows)} {status} rate={idx/elapsed:.2f}/s counts={counts}")
        return

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


if __name__ == "__main__":
    main()
