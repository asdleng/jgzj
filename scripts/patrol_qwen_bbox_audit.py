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


SCHEMA = "jgzj_vehicle_upload_qwen_bbox_audit.v1"
LABEL_SCHEMA = "jgzj_vehicle_upload_qwen_bbox_label.v1"
MODEL = "Qwen3.6-27B-Labeler"
MODEL_BUNDLE = "qwen_bbox_audit_v1_human_review_queue"
PROMPT_VERSION = "qwen_bbox_audit_prompt_v1"
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
HIGH_RISK_CLASSES = {"fire", "smoke", "pet", "trash", "stall", "phone", "smoking"}

AUDIT_PROMPT = """You are auditing existing Qwen YOLO pre-labels for an autonomous patrol vehicle image.
You must judge the provided labels, not create a new label set from scratch.
Return exactly one compact JSON object only. No markdown. No explanation.

Schema:
{"verdict":"pass","severity":"low","bad":[],"miss":[],"quality":"good","confidence":0.9,"notes":[]}

Fields:
- verdict: pass, suspect, or needs_human.
- severity: low, medium, or high.
- bad: list of wrong existing labels. Each item:
  {"i":0,"issue":"wrong_class","should":"none","reason":"red_fire_box_not_flame"}
- miss: list of clearly missed important targets. Each item:
  ["class",x1,y1,x2,y2,score,"reason"]
- quality: good, blur, dark, blocked, or bad.
- confidence: numeric 0.0-1.0 for your audit judgment.
- notes: optional short snake_case strings.

Existing label fields:
- i is the label index.
- class is the current class.
- bbox_1000 is [x1,y1,x2,y2] on the full image, integer 0-1000.
- note/evidence comes from the previous Qwen labeler and may be wrong.

Audit rules:
- Mark pass only when all existing boxes are real, visible, class-correct, and reasonably tight.
- Mark suspect for uncertainty that should be reviewed by a human.
- Mark needs_human for likely false positives, wrong class, missing high-risk target, or unusable image.
- A bad label should be added when it is false positive, wrong class, not visible, duplicate, very loose, or box covers the wrong object.
- For miss, only report clear high-risk missed objects: fire, smoke, pet, trash, stall, phone, smoking. Do not report weak/ambiguous misses.

Hard class definitions:
- fire: actual visible flame with flame shape and orange/yellow luminous core. Red fire boxes, extinguishers, hydrants,消防箱, red signs, warning boards, lamps, reflections, taillights, cones, and red/orange equipment are NOT fire.
- smoke: real smoke plume/cloud from burning or exhaust. Fog, mist, steam, haze, glare, clouds, dust, blur, water spray, and overexposure are NOT smoke.
- pet: LIVE dog/cat only. Statues, sculptures, toys, mascots, animal pictures, signs, decorations, white stone/resin animals, birds, ducks, geese, chickens, and livestock sculptures are NOT pet.
- smoking: visible cigarette/cigar/vape OR clear smoke from a person's mouth/hand. A whole person with hand near mouth is NOT enough.
- phone: visible handheld mobile phone or clear hand-phone interaction. Wall screens, signs, dashboards, mirrors, bags, and black rectangles are NOT phone.
- trash: loose discarded waste on ground/road/path. Trash bins, recycling boxes, planters, cones, leaves, stones, fixed facilities, storage boxes, and construction materials are NOT trash.
- stall: temporary vendor selling setup with table/canopy/goods/operator. Fixed kiosks, guard booths, bus shelters, building entrances, pavilions, fences, ordinary tents, umbrellas, and storage piles are NOT stall.

Be strict. When evidence is weak, flag suspect instead of passing. Use short snake_case reasons.
"""

REJECT_PATTERNS = {
    "fire": re.compile(
        r"fire[_ -]?box|extinguisher|hydrant|red[_ -]?(?:box|sign|board|panel|cabinet|equipment|object)|"
        r"warning|notice|poster|banner|traffic[_ -]?light|taillight|lamp|reflection|clothes|cone|orange[_ -]?equipment|"
        r"消防|灭火器|消防箱|消火栓|警示|告示|标牌",
        re.I,
    ),
    "smoke": re.compile(
        r"fog|mist|steam|water[_ -]?spray|spray|haze|lens|glare|cloud|dust|shadow|blur|noise|overexposure|"
        r"雾|水汽|蒸汽|水雾|镜头|眩光|云|灰尘|模糊",
        re.I,
    ),
    "pet": re.compile(
        r"statue|sculpture|toy|doll|mascot|mannequin|picture|poster|sign|decoration|stone|resin|fake|"
        r"white_goat|white_sheep|goat_statue|sheep_statue|dog_statue|fixed|ornament|bird|goose|duck|chicken|livestock|"
        r"雕塑|雕像|玩具|装饰|石头|树脂|假|鸟|鸭|鹅|鸡",
        re.I,
    ),
    "trash": re.compile(
        r"bin|trash_can|garbage_can|waste_bin|dustbin|recycling|box_fixture|storage|container|cabinet|"
        r"sign|poster|leaf|leaves|stone|rock|cone|planter|fixed|facility|construction|bucket|"
        r"垃圾桶|果皮箱|回收箱|箱体|标识|树叶|石头|路锥|花箱|固定设施|施工",
        re.I,
    ),
    "stall": re.compile(
        r"fixed|permanent|kiosk|guard[_ -]?booth|bus[_ -]?shelter|building|entrance|pavilion|fence|storage|pile|"
        r"固定|永久|岗亭|保安亭|公交亭|建筑入口|亭子|围栏|堆放",
        re.I,
    ),
    "phone": re.compile(r"sign|screen_on_wall|dashboard|mirror|black_rectangle|bag|reflection|traffic", re.I),
    "smoking": re.compile(r"hand_near_mouth_only|unclear|food|drink|microphone|mask|shadow", re.I),
}

ACCEPT_PATTERNS = {
    "fire": re.compile(r"flame|actual_flame|burning|orange_flame|yellow_flame|visible_flame", re.I),
    "smoke": re.compile(r"smoke|smoke_plume|rising_smoke|exhaust_smoke|burning_smoke", re.I),
    "pet": re.compile(
        r"live_(?:dog|cat)|dog_(?:with_)?(?:leash|head|legs|tail|body|fur)|cat_(?:head|legs|tail|body|fur)|"
        r"pet_(?:dog|cat)|leashed_dog|clear_dog|clear_cat",
        re.I,
    ),
    "trash": re.compile(r"loose|discarded|ground|road|bottle|paper|plastic|bag|cardboard|wrapper|litter|waste", re.I),
    "stall": re.compile(r"vendor|stall|booth|selling|goods|table|canopy|market|cart", re.I),
    "phone": re.compile(r"handheld|phone|mobile|smartphone|hand_phone|screen_in_hand", re.I),
    "smoking": re.compile(r"cigarette|cigar|vape|smoke_from_mouth|smoking|lit_tip", re.I),
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


def load_image_list(path):
    if not path:
        return None
    values = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        line = normalize_rel(line.split("#", 1)[0].strip())
        if line:
            values.add(line)
    return values


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
        return None
    try:
        return json.loads(match.group(0))
    except Exception:
        return None


def clamp(value, low, high):
    return max(low, min(high, value))


def normalize_class_name(value):
    class_name = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    if class_name in {"car", "truck", "bus", "van"}:
        return "vehicle"
    if class_name in {"bike", "bicycle", "ebike", "e_bike", "scooter", "cart"}:
        return "nonmotor"
    return class_name


def label_bbox_1000(label):
    box = label.get("box") if isinstance(label, dict) else None
    if isinstance(box, dict) and isinstance(box.get("bbox_1000"), list) and len(box["bbox_1000"]) == 4:
        try:
            return [int(round(float(v))) for v in box["bbox_1000"]]
        except Exception:
            pass
    x = float(label.get("x", 0.0))
    y = float(label.get("y", 0.0))
    w = float(label.get("w", 0.0))
    h = float(label.get("h", 0.0))
    return [
        int(round(clamp((x - w / 2) * 1000.0, 0, 1000))),
        int(round(clamp((y - h / 2) * 1000.0, 0, 1000))),
        int(round(clamp((x + w / 2) * 1000.0, 0, 1000))),
        int(round(clamp((y + h / 2) * 1000.0, 0, 1000))),
    ]


def normalize_label_for_audit(raw, index):
    class_name = normalize_class_name(raw.get("class_name") or raw.get("label") or raw.get("name"))
    if class_name not in CLASSES:
        return None
    try:
        confidence = float(raw.get("confidence"))
    except Exception:
        confidence = None
    bbox = label_bbox_1000(raw)
    return {
        "i": int(raw.get("index", index) if str(raw.get("index", "")).strip() != "" else index),
        "class": class_name,
        "confidence": round(clamp(confidence, 0.0, 1.0), 4) if confidence is not None else None,
        "bbox_1000": bbox,
        "note": str(raw.get("note") or raw.get("evidence") or "").strip()[:160],
    }


def load_label_cache(row, label_root):
    label_path = cache_path(label_root, row["meta"].get("image_sha256"))
    if not label_path or not label_path.exists():
        return None, None
    payload = load_json(label_path)
    if not isinstance(payload, dict) or payload.get("schema") != LABEL_SCHEMA:
        return None, None
    labels = []
    for index, raw in enumerate(payload.get("labels") or []):
        if isinstance(raw, dict):
            label = normalize_label_for_audit(raw, index)
            if label:
                labels.append(label)
    return payload, labels


def cache_has_valid_audit(path):
    payload = load_json(path)
    return isinstance(payload, dict) and payload.get("schema") == SCHEMA and payload.get("verdict")


def heuristic_findings(labels):
    findings = []
    for label in labels:
        class_name = label["class"]
        note = label.get("note") or ""
        confidence = label.get("confidence")
        x1, y1, x2, y2 = label["bbox_1000"]
        w = max(0, x2 - x1) / 1000.0
        h = max(0, y2 - y1) / 1000.0
        if class_name in HIGH_RISK_CLASSES and confidence is None:
            findings.append({
                "index": label["i"],
                "class_name": class_name,
                "issue": "missing_confidence",
                "should": "review",
                "reason": f"{class_name}_missing_confidence",
                "severity": "medium",
                "source": "heuristic",
            })
        if class_name in REJECT_PATTERNS and note and REJECT_PATTERNS[class_name].search(note):
            findings.append({
                "index": label["i"],
                "class_name": class_name,
                "issue": "likely_false_positive",
                "should": "none",
                "reason": f"{class_name}_reject_note_{note[:48]}",
                "severity": "high" if class_name in {"fire", "pet", "smoke"} else "medium",
                "source": "heuristic",
            })
        if class_name in ACCEPT_PATTERNS and note and not ACCEPT_PATTERNS[class_name].search(note):
            findings.append({
                "index": label["i"],
                "class_name": class_name,
                "issue": "weak_evidence_note",
                "should": "review",
                "reason": f"{class_name}_weak_evidence",
                "severity": "medium",
                "source": "heuristic",
            })
        if class_name == "smoking" and (h > 0.28 or w > 0.18) and not ACCEPT_PATTERNS["smoking"].search(note):
            findings.append({
                "index": label["i"],
                "class_name": class_name,
                "issue": "box_too_large_for_smoking_evidence",
                "should": "review",
                "reason": "smoking_whole_person_or_unclear",
                "severity": "medium",
                "source": "heuristic",
            })
    return findings


def severity_rank(value):
    return {"low": 0, "medium": 1, "high": 2}.get(str(value or "").lower(), 0)


def normalize_severity(value):
    value = str(value or "").strip().lower()
    return value if value in {"low", "medium", "high"} else "low"


def normalize_verdict(value):
    value = str(value or "").strip().lower()
    return value if value in {"pass", "suspect", "needs_human", "error"} else "suspect"


def normalize_issue(value):
    issue = re.sub(r"[^a-z0-9_]+", "_", str(value or "uncertain").strip().lower()).strip("_")
    return issue or "uncertain"


def normalize_bad_item(item, labels, source):
    if not isinstance(item, dict):
        return None
    index = item.get("i", item.get("index", item.get("label_index")))
    try:
        index = int(index)
    except Exception:
        return None
    matched = next((label for label in labels if int(label["i"]) == index), None)
    class_name = normalize_class_name(item.get("class") or item.get("class_name") or (matched or {}).get("class"))
    if not class_name and matched:
        class_name = matched["class"]
    reason = normalize_issue(item.get("reason") or item.get("note") or item.get("why") or "audit_flagged")
    return {
        "index": index,
        "class_name": class_name or "unknown",
        "issue": normalize_issue(item.get("issue") or item.get("type") or "uncertain"),
        "should": normalize_class_name(item.get("should") or item.get("target") or "review"),
        "reason": reason[:120],
        "severity": normalize_severity(item.get("severity") or "medium"),
        "source": source,
    }


def normalize_miss_item(item):
    class_name = ""
    bbox = None
    confidence = None
    reason = ""
    if isinstance(item, (list, tuple)) and len(item) >= 5:
        class_name = normalize_class_name(item[0])
        bbox = list(item[1:5])
        if len(item) >= 6:
            try:
                confidence = float(item[5])
            except Exception:
                confidence = None
        if len(item) >= 7:
            reason = str(item[6] or "")
    elif isinstance(item, dict):
        class_name = normalize_class_name(item.get("class") or item.get("class_name") or item.get("label"))
        bbox = item.get("bbox") or item.get("box") or item.get("xyxy")
        try:
            confidence = float(item.get("score", item.get("confidence")))
        except Exception:
            confidence = None
        reason = str(item.get("reason") or item.get("note") or "")
    if class_name not in HIGH_RISK_CLASSES:
        return None
    if not isinstance(bbox, list) or len(bbox) != 4:
        return None
    try:
        x1, y1, x2, y2 = [float(v) for v in bbox]
    except Exception:
        return None
    if max(abs(x1), abs(y1), abs(x2), abs(y2)) <= 1.5:
        x1, y1, x2, y2 = x1 * 1000.0, y1 * 1000.0, x2 * 1000.0, y2 * 1000.0
    x1 = int(round(clamp(x1, 0, 1000)))
    y1 = int(round(clamp(y1, 0, 1000)))
    x2 = int(round(clamp(x2, 0, 1000)))
    y2 = int(round(clamp(y2, 0, 1000)))
    if x2 <= x1 or y2 <= y1:
        return None
    return {
        "class_name": class_name,
        "bbox_1000": [x1, y1, x2, y2],
        "confidence": round(clamp(confidence, 0.0, 1.0), 4) if confidence is not None else None,
        "reason": normalize_issue(reason or "clear_missed_target")[:120],
        "source": "qwen_audit",
    }


def dedupe_findings(findings):
    seen = set()
    out = []
    for item in findings:
        key = (item.get("index"), item.get("class_name"), item.get("issue"), item.get("reason"))
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out


def normalize_audit(parsed, labels, heuristic):
    if not isinstance(parsed, dict):
        parsed = {}
    qwen_bad = []
    for item in parsed.get("bad") or parsed.get("suspicious_labels") or []:
        bad = normalize_bad_item(item, labels, "qwen_audit")
        if bad:
            qwen_bad.append(bad)
    missing = []
    for item in parsed.get("miss") or parsed.get("missing_candidates") or []:
        miss = normalize_miss_item(item)
        if miss:
            missing.append(miss)
    suspicious = dedupe_findings([*heuristic, *qwen_bad])
    verdict = normalize_verdict(parsed.get("verdict") or ("needs_human" if suspicious or missing else "pass"))
    severity = normalize_severity(parsed.get("severity") or "low")
    if suspicious or missing:
        max_bad = max([severity_rank(item.get("severity")) for item in suspicious] + [2 if missing else 0])
        if max_bad >= 2:
            severity = "high"
            if verdict == "pass":
                verdict = "needs_human"
        elif max_bad == 1:
            severity = "medium" if severity_rank(severity) < 1 else severity
            if verdict == "pass":
                verdict = "suspect"
    if verdict in {"suspect", "needs_human"} and severity == "low":
        severity = "medium"
    if suspicious and any(severity_rank(item.get("severity")) >= 2 for item in suspicious):
        verdict = "needs_human"
    try:
        confidence = float(parsed.get("confidence"))
    except Exception:
        confidence = 0.75 if verdict == "pass" else 0.65
    quality = str(parsed.get("quality") or parsed.get("q") or "good").strip().lower()
    if quality not in {"good", "blur", "dark", "blocked", "bad"}:
        quality = "good"
    reasons = []
    for item in suspicious:
        reasons.append(item.get("reason") or item.get("issue") or "suspicious_label")
    for item in missing:
        reasons.append(f"missing_{item.get('class_name')}")
    for item in parsed.get("notes") or []:
        note = normalize_issue(item)
        if note:
            reasons.append(note)
    reasons = list(dict.fromkeys([reason for reason in reasons if reason]))[:12]
    return {
        "verdict": verdict,
        "severity": severity,
        "reasons": reasons,
        "suspicious_labels": suspicious,
        "missing_candidates": missing[:12],
        "quality": quality,
        "confidence": round(clamp(confidence, 0.0, 1.0), 4),
    }


def call_qwen(service_url, prompt, image_b64, labels, timeout_s, max_tokens):
    label_json = json.dumps(labels, ensure_ascii=False, separators=(",", ":"))
    payload = {
        "model": MODEL,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": f"{prompt}\n\nExisting labels JSON:\n{label_json}"},
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


def row_priority(row):
    labels = row.get("labels") or []
    score = 0
    risk_weights = {"fire": 100, "smoke": 95, "pet": 90, "smoking": 80, "trash": 70, "stall": 65, "phone": 55}
    for label in labels:
        class_name = label["class"]
        score += risk_weights.get(class_name, 5)
        note = label.get("note") or ""
        if class_name in REJECT_PATTERNS and note and REJECT_PATTERNS[class_name].search(note):
            score += 200
        if class_name in HIGH_RISK_CLASSES and label.get("confidence") is None:
            score += 35
    return score


def audit_one(row, args, prompt):
    meta = row["meta"]
    out_path = cache_path(args.output_root, meta.get("image_sha256"))
    if out_path is None:
        return "skip:no_sha"
    if out_path.exists() and not args.refresh and cache_has_valid_audit(out_path):
        return "skip:cached"
    started = time.time()
    labels = row["labels"]
    heuristic = heuristic_findings(labels)
    parsed = {}
    raw_text = ""
    finish_reason = None
    call_ok = True
    image_request = None
    if not args.heuristic_only:
        image_b64, image_request = encode_image(row["image_path"], args.max_side, args.jpeg_quality)
        response = call_qwen(args.service_url, prompt, image_b64, labels, args.timeout_s, args.max_tokens)
        choice = (response.get("choices") or [{}])[0]
        message = choice.get("message") or {}
        raw_text = message.get("content") or message.get("reasoning") or ""
        finish_reason = choice.get("finish_reason")
        parsed = extract_json(raw_text) or {}
        call_ok = bool(parsed)
    normalized = normalize_audit(parsed, labels, heuristic)
    if not call_ok and not heuristic:
        normalized = {
            "verdict": "error",
            "severity": "high",
            "reasons": ["audit_parse_failed"],
            "suspicious_labels": [],
            "missing_candidates": [],
            "quality": "bad",
            "confidence": 0.0,
        }
    payload = {
        "schema": SCHEMA,
        "image_sha256": meta.get("image_sha256"),
        "image_path": row["image_rel"],
        "source": meta.get("source") or "cloud_camera_capture",
        "vehicle_id": meta.get("vehicle_id"),
        "camera_id": meta.get("camera_id"),
        "collected_at": meta.get("collected_at"),
        "meta_path": normalize_rel(row["meta_path"].relative_to(args.frames_root)),
        "audited_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "model": MODEL,
        "model_bundle": MODEL_BUNDLE,
        "prompt_version": args.prompt_version,
        "service_url": args.service_url,
        "label_schema": LABEL_SCHEMA,
        "label_cache_rel_path": normalize_rel(row["label_path"].relative_to(args.label_root)) if row.get("label_path") else "",
        "label_count": len(labels),
        "label_classes": sorted({label["class"] for label in labels}),
        "labels": labels,
        "heuristic_findings": heuristic,
        "image_request": image_request,
        "ok": call_ok,
        "raw_json": parsed if args.store_raw else None,
        "raw_text": raw_text if (args.store_raw or not call_ok or finish_reason == "length") else "",
        "finish_reason": finish_reason,
        "duration_ms": int((time.time() - started) * 1000),
        **normalized,
    }
    save_json_atomic(out_path, payload)
    return f"ok:{payload['verdict']}:{payload['severity']}:{len(payload['suspicious_labels'])}"


def build_rows(args):
    image_filter = load_image_list(args.image_list)
    class_filter = {
        normalize_class_name(item)
        for value in args.class_filter
        for item in str(value or "").split(",")
        if normalize_class_name(item)
    }
    rows = []
    scanned = 0
    for row in iter_rows(args.frames_root, args.source, args.vehicle):
        if image_filter is not None and row["image_rel"] not in image_filter:
            continue
        scanned += 1
        label_payload, labels = load_label_cache(row, args.label_root)
        if label_payload is None:
            continue
        if not labels and not args.include_empty:
            continue
        if class_filter and not any(label["class"] in class_filter for label in labels):
            continue
        out_path = cache_path(args.output_root, row["meta"].get("image_sha256"))
        if args.only_missing and not args.refresh and out_path and cache_has_valid_audit(out_path):
            continue
        label_path = cache_path(args.label_root, row["meta"].get("image_sha256"))
        rows.append({
            **row,
            "label_payload": label_payload,
            "label_path": label_path,
            "labels": labels,
        })
    rows.sort(key=lambda item: (row_priority(item), str(item["meta"].get("collected_at") or "")), reverse=True)
    return scanned, rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--frames-root", type=Path, default=Path("/home/admin1/jgzj/.runtime/park-pcm/crowd-frames"))
    parser.add_argument("--label-root", type=Path, default=Path("/home/admin1/jgzj/.runtime/yolo_label_review/vehicle_upload_qwen_bbox_labels_v1"))
    parser.add_argument("--output-root", type=Path, default=Path("/home/admin1/jgzj/.runtime/yolo_label_review/vehicle_upload_qwen_bbox_audits_v1"))
    parser.add_argument("--service-url", default="http://127.0.0.1:18016")
    parser.add_argument("--source", default="auto_ad_patrol_flow_upload")
    parser.add_argument("--vehicle", default="")
    parser.add_argument("--class-filter", action="append", default=[])
    parser.add_argument("--include-empty", action="store_true")
    parser.add_argument("--only-missing", action="store_true")
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--heuristic-only", action="store_true")
    parser.add_argument("--store-raw", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--max-side", type=int, default=960)
    parser.add_argument("--jpeg-quality", type=int, default=82)
    parser.add_argument("--timeout-s", type=int, default=120)
    parser.add_argument("--max-tokens", type=int, default=768)
    parser.add_argument("--prompt-version", default=PROMPT_VERSION)
    parser.add_argument("--prompt-file", type=Path, default=None)
    parser.add_argument("--prompt-extra", default="")
    parser.add_argument("--image-list", type=Path, default=None)
    args = parser.parse_args()

    prompt = AUDIT_PROMPT
    if args.prompt_file:
        prompt = args.prompt_file.read_text(encoding="utf-8")
    if args.prompt_extra:
        prompt = f"{prompt}\n\nExtra audit instruction:\n{args.prompt_extra.strip()}"

    scanned, rows = build_rows(args)
    source_rows = len(rows)
    if args.limit > 0:
        rows = rows[:args.limit]
    log(
        f"scanned={scanned} candidate_rows={source_rows} rows={len(rows)} only_missing={args.only_missing} "
        f"class_filter={','.join(args.class_filter) or 'all'} workers={args.workers} output={args.output_root}"
    )

    counts = {}
    started = time.time()
    if args.workers <= 1:
        for idx, row in enumerate(rows, 1):
            try:
                status = audit_one(row, args, prompt)
            except KeyboardInterrupt:
                raise
            except Exception as exc:
                status = f"error:{type(exc).__name__}:{exc}"
            key = ":".join(status.split(":", 3)[:3])
            counts[key] = counts.get(key, 0) + 1
            if idx == 1 or idx % 10 == 0 or idx == len(rows):
                elapsed = max(0.001, time.time() - started)
                log(f"{idx}/{len(rows)} {status} rate={idx/elapsed:.2f}/s counts={counts}")
        return

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(audit_one, row, args, prompt): idx for idx, row in enumerate(rows, 1)}
        done = 0
        for future in concurrent.futures.as_completed(futures):
            done += 1
            try:
                status = future.result()
            except KeyboardInterrupt:
                raise
            except Exception as exc:
                status = f"error:{type(exc).__name__}:{exc}"
            key = ":".join(status.split(":", 3)[:3])
            counts[key] = counts.get(key, 0) + 1
            if done == 1 or done % 10 == 0 or done == len(rows):
                elapsed = max(0.001, time.time() - started)
                log(f"{done}/{len(rows)} {status} rate={done/elapsed:.2f}/s counts={counts}")


if __name__ == "__main__":
    main()
