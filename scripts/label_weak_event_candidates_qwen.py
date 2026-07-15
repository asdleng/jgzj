#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional

from label_fire_smoke_candidates_qwen import (
    append_jsonl,
    cache_path,
    chat,
    encode_image,
    iter_jsonl,
    retry_session,
    write_json_atomic,
    write_text_atomic,
)


SCHEMA = "jgzj_weak_event_web_qwen_label.v1"
CLASSES = ("fishing_rod", "pet", "stall", "bottle", "box", "paper", "bag")
CLASS_IDS = {name: index for index, name in enumerate(CLASSES)}

TARGETS = {
    "fishing_rod": {
        "classes": ("fishing_rod",),
        "definition": "a real fishing rod visibly held, carried, mounted, or used by an angler",
        "threshold": 0.82,
        "accept": re.compile(r"fishing|angler|rod|reel|fishing_line", re.I),
        "reject": re.compile(r"walking|trekking|umbrella|railing|branch|mast|antenna|paddle", re.I),
        "example_evidence": "visible_fishing_rod_with_reel",
    },
    "pet": {
        "classes": ("pet",),
        "definition": "a live domestic dog or cat, preferably small or distant in a street, park, or patrol view",
        "threshold": 0.90,
        "accept": re.compile(r"live|dog|cat|canine|feline", re.I),
        "reject": re.compile(r"statue|sculpture|plush|toy|poster|reflection|painting", re.I),
        "example_evidence": "live_dog_body_legs_and_tail",
    },
    "stall": {
        "classes": ("stall",),
        "definition": "a temporary mobile vendor setup with a cart, table, canopy, mat, or displayed goods",
        "threshold": 0.90,
        "accept": re.compile(r"vendor|market|goods|cart|table|canopy|temporary|street_stall", re.I),
        "reject": re.compile(r"fixed|kiosk|vending|checkpoint|shelter|booth_building", re.I),
        "example_evidence": "temporary_vendor_table_with_goods",
    },
    "trash": {
        "classes": ("bottle", "box", "paper", "bag"),
        "definition": "discarded bottle, cardboard box, loose paper, or plastic bag lying as litter on the ground or curb",
        "threshold": 0.88,
        "accept": re.compile(r"discarded|litter|ground|curb|loose|waste|bottle|cardboard|paper|plastic_bag", re.I),
        "reject": re.compile(r"storage|stacked|trash_bin|waste_bin|container|utility|road_marking|arrow|traffic_sign|in_use", re.I),
        "example_evidence": "discarded_bottle_on_ground",
    },
}

GLOBAL_REJECT = re.compile(
    r"illustration|drawing|painting|poster|screenshot|collage|diagram|logo|blur_only|reflection_only",
    re.I,
)


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def enforce_media_scene(photo: object, domain: object, scene: object) -> str:
    normalized = str(scene or "unusable").strip().lower()
    if str(photo or "unknown").strip().lower() != "real_photo":
        return "unusable"
    if str(domain or "off_domain").strip().lower() != "target":
        return "unusable"
    return normalized


def select_shard(rows: Iterable[dict], shard_index: int, shard_count: int) -> List[dict]:
    return [row for index, row in enumerate(rows) if index % shard_count == shard_index]


def target_from_bucket(bucket: object) -> Optional[str]:
    value = str(bucket or "").strip().lower()
    if "fishing_rod" in value:
        return "fishing_rod"
    if "stall" in value:
        return "stall"
    if "pet" in value:
        return "pet"
    if "trash" in value:
        return "trash"
    return None


def task_rules(target: str) -> str:
    spec = TARGETS[target]
    classes = ", ".join(spec["classes"])
    extra = {
        "fishing_rod": (
            "A clearly visible fishing rod mounted or propped for fishing counts even when the angler is outside the frame. "
            "Do not label walking sticks, trekking poles, umbrellas, railings, branches, masts, antennas, or paddles."
        ),
        "pet": "Only live dogs and cats count. Statues, sculptures, plush toys, posters, reflections, and other animals do not count.",
        "stall": "Fixed kiosks, vending machines, permanent booths, security checkpoints, and bus shelters are not stalls.",
        "trash": "Only use bottle, box, paper, or bag. The object must visibly be discarded litter; bins, stored/stacked boxes, road paint, signs, and utility boxes are negatives.",
    }[target]
    return f"Allowed classes: {classes}. Positive definition: {spec['definition']}. {extra}"


def detect_prompt(target: str) -> str:
    return f"""You are creating high-precision object-detection pre-labels for patrol-vehicle and fixed outdoor cameras.
Target task: {target}.
{task_rules(target)}

Return one compact JSON object only, with no markdown:
{{"q":"good","photo":"real_photo","domain":"target","scene":"positive","b":[["{TARGETS[target]['classes'][0]}",x1,y1,x2,y2,0.94,"{TARGETS[target]['example_evidence']}"]],"r":"short_reason"}}

Rules:
- q: good, blur, dark, blocked, or bad.
- photo: real_photo, illustration, screenshot, collage, or unknown.
- domain: target or off_domain. Target resembles a ground-level road, park, campus, waterfront, residential, commercial, or patrol/fixed-camera scene.
- scene: positive, hard_negative, or unusable.
- b: at most 12 tight boxes, integer coordinates 0-1000 xyxy on the full image.
- Evidence must be short English snake_case visible proof. A search title is never evidence.
- Product-only closeups, studio portraits, drawings, screenshots, collages, and unrelated indoor scenes are off_domain or unusable.
- Precision is more important than recall. If uncertain, return b=[] and scene=hard_negative.
"""


def audit_prompt(target: str, proposal: dict) -> str:
    example_class = TARGETS[target]["classes"][0]
    return f"""Act as a strict independent reviewer of proposed {target} boxes in the attached image.
{task_rules(target)}
Proposed JSON:
{json.dumps(proposal, ensure_ascii=False, separators=(',', ':'))}

Return one compact JSON object only:
{{"v":"pass","photo":"real_photo","domain":"target","scene":"positive","b":[["{example_class}",x1,y1,x2,y2,0.95,"{TARGETS[target]['example_evidence']}"]],"r":"short_reason"}}

Every retained b item must contain exactly class, x1, y1, x2, y2, score, and evidence. Never return coordinate-only arrays. Use v=pass only when every retained box has strong pixel evidence and there is no important missed target. Correct or drop boxes in b. Use v=needs_human for ambiguity, false positives, or important misses. Non-real or off-domain media must use scene=unusable and b=[].
"""


def box_iou(left: dict, right: dict) -> float:
    ax1, ay1, ax2, ay2 = left["bbox_1000"]
    bx1, by1, bx2, by2 = right["bbox_1000"]
    ix1, iy1, ix2, iy2 = max(ax1, bx1), max(ay1, by1), min(ax2, bx2), min(ay2, by2)
    intersection = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    if intersection <= 0:
        return 0.0
    area_left = (ax2 - ax1) * (ay2 - ay1)
    area_right = (bx2 - bx1) * (by2 - by1)
    return intersection / float(area_left + area_right - intersection)


def normalize_boxes(raw_boxes: object, target: str) -> List[dict]:
    spec = TARGETS[target]
    allowed = set(spec["classes"])
    labels = []
    for raw in raw_boxes if isinstance(raw_boxes, list) else []:
        if not isinstance(raw, (list, tuple)) or len(raw) < 7:
            continue
        class_name = str(raw[0] or "").strip().lower()
        if class_name not in allowed:
            continue
        try:
            x1, y1, x2, y2 = [max(0.0, min(1000.0, float(value))) for value in raw[1:5]]
            score = max(0.0, min(1.0, float(raw[5])))
        except (TypeError, ValueError):
            continue
        evidence = str(raw[6] or "").strip()[:160]
        if x2 <= x1 or y2 <= y1 or score < float(spec["threshold"]):
            continue
        if GLOBAL_REJECT.search(evidence) or spec["reject"].search(evidence) or not spec["accept"].search(evidence):
            continue
        labels.append({
            "class_name": class_name,
            "class_id": CLASS_IDS[class_name],
            "confidence": score,
            "evidence": evidence,
            "x": ((x1 + x2) / 2.0) / 1000.0,
            "y": ((y1 + y2) / 2.0) / 1000.0,
            "w": (x2 - x1) / 1000.0,
            "h": (y2 - y1) / 1000.0,
            "bbox_1000": [round(x1), round(y1), round(x2), round(y2)],
        })
    labels.sort(key=lambda item: item["confidence"], reverse=True)
    kept: List[dict] = []
    for label in labels:
        if any(old["class_name"] == label["class_name"] and box_iou(old, label) >= 0.55 for old in kept):
            continue
        kept.append(label)
    return kept[:12]


def apply_review_guards(labels: Iterable[dict], scene: str, bucket: str) -> tuple[List[dict], str, str]:
    kept = list(labels)
    normalized_scene = str(scene or "needs_human").strip().lower()
    if normalized_scene == "unusable":
        return [], "unusable", "off_domain_or_non_photo"
    if kept and str(bucket).startswith("hard_negative"):
        return [], "needs_human", "positive_in_hard_negative_bucket"
    if normalized_scene == "positive" and not kept:
        return [], "needs_human", "positive_without_accepted_box"
    return kept, normalized_scene, ""


def yolo_text(labels: Iterable[dict]) -> str:
    lines = [
        f"{item['class_id']} {item['x']:.6f} {item['y']:.6f} {item['w']:.6f} {item['h']:.6f}"
        for item in labels
    ]
    return "\n".join(lines) + ("\n" if lines else "")


def label_candidates(args: argparse.Namespace) -> dict:
    dataset = args.dataset.resolve()
    rows = list(iter_jsonl(dataset / "manifest_selected_images.jsonl"))
    process_rows = select_shard(rows, args.shard_index, args.shard_count)
    cache_root = dataset / "qwen_labels"
    label_root = dataset / "labels" / "review"
    session = retry_session(args.api_key)
    session.trust_env = False
    processed = 0
    run_counts: Counter = Counter()

    for row in process_rows:
        if processed >= args.max_images:
            break
        sha256 = str(row.get("sha256") or "")
        image_path = dataset / str(row.get("image") or "")
        target = target_from_bucket(row.get("collection_bucket"))
        if not re.fullmatch(r"[0-9a-f]{64}", sha256) or not image_path.is_file() or target is None:
            run_counts["invalid_manifest_row"] += 1
            continue
        cache = cache_path(cache_root, sha256)
        if cache.is_file() and not args.force:
            try:
                existing = json.loads(cache.read_text(encoding="utf-8"))
            except ValueError:
                existing = {}
            if existing.get("ok") or (existing.get("error") and not args.retry_errors):
                run_counts["cached"] += 1
                continue
        processed += 1
        try:
            image_b64, image_meta = encode_image(image_path, args.max_side, args.jpeg_quality)
            prompt = detect_prompt(target)
            parsed, raw_text = chat(
                session, args.endpoint, args.model, prompt, image_b64,
                (args.connect_timeout, args.read_timeout), args.max_tokens,
            )
            if parsed is None:
                raise ValueError(f"detect_json_parse_failed:{raw_text[:800]}")
            photo = str(parsed.get("photo") or "unknown").strip().lower()
            domain = str(parsed.get("domain") or "off_domain").strip().lower()
            candidate_scene = enforce_media_scene(photo, domain, parsed.get("scene"))
            usable = candidate_scene != "unusable"
            detected = normalize_boxes(parsed.get("b") or parsed.get("boxes"), target) if usable else []
            proposal = {
                "q": parsed.get("q"), "photo": photo, "domain": domain,
                "scene": candidate_scene, "b": parsed.get("b") or parsed.get("boxes") or [],
            }
            audit_parsed = None
            audit_raw = ""
            audit_verdict = "not_run"
            final_labels = detected
            if not args.no_audit and usable:
                audit_parsed, audit_raw = chat(
                    session, args.endpoint, args.model, audit_prompt(target, proposal), image_b64,
                    (args.connect_timeout, args.read_timeout), args.max_tokens,
                )
                if audit_parsed is None:
                    audit_verdict = "error"
                    final_labels = []
                else:
                    audit_verdict = str(audit_parsed.get("v") or "needs_human").strip().lower()
                    if audit_verdict not in {"pass", "needs_human"}:
                        audit_verdict = "needs_human"
                    audit_photo = str(audit_parsed.get("photo") or "unknown").strip().lower()
                    audit_domain = str(audit_parsed.get("domain") or "off_domain").strip().lower()
                    audit_scene = enforce_media_scene(
                        audit_photo, audit_domain, audit_parsed.get("scene") or candidate_scene,
                    )
                    audit_usable = audit_scene != "unusable"
                    photo, domain, candidate_scene = audit_photo, audit_domain, audit_scene
                    final_labels = normalize_boxes(audit_parsed.get("b") or audit_parsed.get("boxes"), target) if audit_verdict == "pass" and audit_usable else []
            if candidate_scene not in {"positive", "hard_negative", "unusable"}:
                candidate_scene = "positive" if detected else "hard_negative"
            scene = "positive" if final_labels else ("needs_human" if audit_verdict == "needs_human" and detected else candidate_scene)
            model_labels = list(final_labels)
            final_labels, scene, quarantine_reason = apply_review_guards(
                final_labels, scene, str(row.get("collection_bucket") or ""),
            )
            payload = {
                "schema": SCHEMA,
                "ok": True,
                "image_sha256": sha256,
                "image": row.get("image"),
                "target": target,
                "model": args.model,
                "model_endpoint": args.endpoint,
                "prompt_sha256": hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
                "image_request": image_meta,
                "detect": {"parsed": parsed, "raw": raw_text[:8000], "accepted_labels": detected},
                "audit": {"verdict": audit_verdict, "parsed": audit_parsed, "raw": audit_raw[:8000]},
                "candidate_scene": candidate_scene,
                "photo_type": photo,
                "domain": domain,
                "scene": scene,
                "model_labels": model_labels,
                "labels": final_labels,
                "quarantine_reason": quarantine_reason,
                "review_status": "needs_human",
                "training_eligible": False,
                "created_at": now_iso(),
            }
            write_json_atomic(cache, payload)
            write_text_atomic(label_root / f"{sha256[:24]}.txt", yolo_text(final_labels))
            run_counts["processed_ok"] += 1
        except Exception as exc:
            write_json_atomic(cache, {
                "schema": SCHEMA,
                "ok": False,
                "image_sha256": sha256,
                "image": row.get("image"),
                "target": target,
                "error": str(exc)[:2400],
                "review_status": "error",
                "training_eligible": False,
                "created_at": now_iso(),
            })
            run_counts["processed_error"] += 1

    if args.skip_summary:
        return {
            "schema": "jgzj_weak_event_web_qwen_shard.v1",
            "shard_index": args.shard_index,
            "shard_count": args.shard_count,
            "shard_images": len(process_rows),
            "run_counts": dict(run_counts),
            "training_eligible": False,
        }

    manifest_path = dataset / "qwen_review_manifest.jsonl"
    manifest_path.unlink(missing_ok=True)
    summary_counts: Counter = Counter()
    class_boxes: Counter = Counter()
    target_counts: Counter = Counter()
    audit_counts: Counter = Counter()
    quarantine_counts: Counter = Counter()
    proposed_boxes = 0
    model_accepted_boxes = 0
    for row in rows:
        sha256 = str(row.get("sha256") or "")
        if not re.fullmatch(r"[0-9a-f]{64}", sha256):
            continue
        cache = cache_path(cache_root, sha256)
        if not cache.is_file():
            summary_counts["pending"] += 1
            continue
        try:
            payload = json.loads(cache.read_text(encoding="utf-8"))
        except ValueError:
            summary_counts["invalid_cache"] += 1
            continue
        labels = payload.get("labels") if isinstance(payload.get("labels"), list) else []
        model_labels = payload.get("model_labels") if isinstance(payload.get("model_labels"), list) else []
        detect = payload.get("detect") if isinstance(payload.get("detect"), dict) else {}
        proposed_labels = detect.get("accepted_labels") if isinstance(detect.get("accepted_labels"), list) else []
        audit = payload.get("audit") if isinstance(payload.get("audit"), dict) else {}
        audit_verdict = str(audit.get("verdict") or ("error" if not payload.get("ok") else "not_run"))
        scene = str(payload.get("scene") or ("needs_human" if not payload.get("ok") else "hard_negative"))
        quarantine_reason = str(payload.get("quarantine_reason") or "")
        review_row = {
            "schema": SCHEMA,
            "image_sha256": sha256,
            "image": row.get("image"),
            "label": f"labels/review/{sha256[:24]}.txt",
            "cache": cache.relative_to(dataset).as_posix(),
            "target": payload.get("target") or target_from_bucket(row.get("collection_bucket")),
            "scene": scene,
            "model_scene": payload.get("candidate_scene") or "",
            "photo_type": payload.get("photo_type") or "",
            "domain": payload.get("domain") or "",
            "collection_bucket": row.get("collection_bucket") or "",
            "quarantine_reason": quarantine_reason,
            "proposed_classes": [str(item.get("class_name") or "") for item in proposed_labels],
            "model_classes": [str(item.get("class_name") or "") for item in model_labels],
            "classes": [str(item.get("class_name") or "") for item in labels],
            "box_count": len(labels),
            "audit_verdict": audit_verdict,
            "review_status": payload.get("review_status") or ("error" if not payload.get("ok") else "needs_human"),
            "training_eligible": False,
        }
        append_jsonl(manifest_path, review_row)
        if not payload.get("ok"):
            summary_counts["error"] += 1
            audit_counts[audit_verdict] += 1
            continue
        target_counts[f"{payload.get('target')}:{scene}"] += 1
        summary_counts[scene] += 1
        audit_counts[audit_verdict] += 1
        if quarantine_reason:
            quarantine_counts[quarantine_reason] += 1
        proposed_boxes += len(proposed_labels)
        model_accepted_boxes += len(model_labels)
        for label in labels:
            class_boxes[str(label.get("class_name") or "unknown")] += 1

    accepted_boxes = sum(class_boxes.values())
    summary = {
        "schema": "jgzj_weak_event_web_qwen_summary.v1",
        "profile": "弱事件网络候选集",
        "kind": "detect",
        "updated_at": now_iso(),
        "classes": list(CLASSES),
        "images": {"review": len(rows)},
        "run_counts": dict(run_counts),
        "scene_counts": dict(summary_counts),
        "target_scene_counts": dict(target_counts),
        "boxes_by_class": dict(class_boxes),
        "audit_counts": dict(audit_counts),
        "quarantine_counts": dict(quarantine_counts),
        "qwen_model": args.model,
        "qwen_label_summary": {
            "labeled_images": sum(summary_counts[scene] for scene in ("positive", "hard_negative", "needs_human", "unusable")),
            "scene_positive": summary_counts["positive"],
            "scene_hard_negative": summary_counts["hard_negative"],
            "scene_needs_human": summary_counts["needs_human"],
            "scene_unusable": summary_counts["unusable"],
            "accepted_boxes": accepted_boxes,
            "model_accepted_boxes": model_accepted_boxes,
            "proposed_boxes": proposed_boxes,
            "audit_pass": audit_counts["pass"],
            "audit_needs_human": audit_counts["needs_human"],
            "audit_not_run": audit_counts["not_run"],
            "quarantine_positive_in_hard_negative_bucket": quarantine_counts["positive_in_hard_negative_bucket"],
        },
        "training_eligible": False,
        "training_policy": "two_pass_qwen_then_human_review",
        "source_policy": "license_metadata_required",
    }
    write_json_atomic(dataset / "dataset_summary.json", summary)
    write_json_atomic(dataset / "training_guard.json", {
        "schema": "jgzj_yolo_training_guard.v1",
        "training_eligible": False,
        "reason": "Weak-event web candidates require human review before any training split is built.",
        "updated_at": now_iso(),
    })
    return summary


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Two-pass Qwen review for fishing-rod, pet, stall, and ground-litter web candidates.")
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--endpoint", default=os.environ.get("QWEN_LABEL_ENDPOINT", "http://127.0.0.1:18016"))
    parser.add_argument("--model", default=os.environ.get("QWEN_LABEL_MODEL", "Qwen3.6-27B-Labeler"))
    parser.add_argument("--api-key", default=os.environ.get("QWEN_LABEL_API_KEY", ""))
    parser.add_argument("--max-images", type=int, default=100000)
    parser.add_argument("--max-side", type=int, default=1280)
    parser.add_argument("--jpeg-quality", type=int, default=85)
    parser.add_argument("--max-tokens", type=int, default=1000)
    parser.add_argument("--connect-timeout", type=float, default=10.0)
    parser.add_argument("--read-timeout", type=float, default=120.0)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--retry-errors", action="store_true")
    parser.add_argument("--no-audit", action="store_true")
    parser.add_argument("--shard-count", type=int, default=1)
    parser.add_argument("--shard-index", type=int, default=0)
    parser.add_argument("--skip-summary", action="store_true")
    args = parser.parse_args()
    if args.shard_count < 1:
        parser.error("--shard-count must be at least 1")
    if args.shard_index < 0 or args.shard_index >= args.shard_count:
        parser.error("--shard-index must be in [0, shard-count)")
    return args


if __name__ == "__main__":
    print(json.dumps(label_candidates(parse_args()), ensure_ascii=False, indent=2))
