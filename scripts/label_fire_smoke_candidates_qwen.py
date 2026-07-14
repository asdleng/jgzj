#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import re
import tempfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterator, List, Optional, Tuple

import requests
from PIL import Image, ImageOps
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


SCHEMA = "jgzj_fire_smoke_web_qwen_label.v1"
CLASSES = ("fire", "smoke")
THRESHOLDS = {"fire": 0.85, "smoke": 0.90}
ACCEPT_EVIDENCE = {
    "fire": re.compile(r"flame|burning|luminous_core|yellow_core|orange_flame", re.I),
    "smoke": re.compile(r"smoke|plume|burning_emission|rising_column|drifting_column", re.I),
}
REJECT_EVIDENCE = re.compile(
    r"fog|mist|steam|cloud|dust|haze|glare|reflection|sunset|red_sign|hydrant|extinguisher|lamp|tail_?light|traffic_?light",
    re.I,
)
LANCZOS = getattr(Image, "Resampling", Image).LANCZOS

DETECT_PROMPT = """You are creating high-precision fire/smoke object-detection pre-labels for patrol-vehicle and fixed outdoor cameras.
Return one compact JSON object only, with no markdown or explanation:
{"q":"good","photo":"real_photo","domain":"target","scene":"positive","b":[["fire",x1,y1,x2,y2,0.93,"actual_orange_flame_with_luminous_core"]],"r":"short_reason"}

Rules:
- q: good, blur, dark, blocked, or bad.
- photo: real_photo, illustration, screenshot, collage, or unknown.
- domain: target or off_domain. Target means a ground-level road, park, campus, residential, commercial, industrial, vehicle, or building scene that resembles patrol/fixed-camera deployment.
- scene: positive, hard_negative, or unusable.
- b: at most 12 tight boxes. Coordinates are integers 0-1000 xyxy on the full image.
- class is only fire or smoke. Score is 0.0-1.0. Evidence is a snake_case visible proof.
- fire requires an actual flame shape with an orange/yellow luminous core.
- smoke requires a coherent semi-transparent plume rising or drifting from a plausible source.
- Never label fog, mist, steam, clouds, dust, haze, glare, sunset, red signs, hydrants, extinguishers, lamps, reflections, taillights, traffic lights, or image blur.
- Drawings, paintings, posters, maps, diagrams, screenshots, collages, staged light art, aerial/satellite wildfire views, and distant landscape-only wildfire views are unusable: set photo/domain accordingly and return b=[].
- Close-up museum objects or unrelated indoor scenes are off_domain. Real ground-level buildings, streets, vehicles, parks and industrial scenes are target.
- A web search query is not evidence. Judge only pixels.
- Precision is more important than recall. If uncertain, return no boxes and scene=hard_negative.
"""

AUDIT_PROMPT = """Act as a strict independent reviewer of proposed fire/smoke boxes in the attached image.
Proposed JSON:
{proposal}

Return one compact JSON object only:
{"v":"pass","photo":"real_photo","domain":"target","scene":"positive","b":[["smoke",x1,y1,x2,y2,0.95,"coherent_rising_smoke_plume"]],"r":"short_reason"}

Use v=pass only when every retained box has strong pixel evidence and there is no obvious missed fire/smoke target. Use v=needs_human for ambiguity, false positives, or important misses. You may correct/drop boxes in b. Apply the same exclusions and domain rules. Non-real or off-domain media must use scene=unusable and b=[].
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def iter_jsonl(path: Path) -> Iterator[dict]:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            row = json.loads(line)
        except (TypeError, ValueError):
            continue
        if isinstance(row, dict):
            yield row


def write_json_atomic(path: Path, payload: dict) -> None:
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


def append_jsonl(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")


def write_text_atomic(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
        os.replace(tmp_name, path)
    finally:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass


def retry_session(api_key: str) -> requests.Session:
    retry = Retry(total=3, connect=2, read=2, backoff_factor=1.0, status_forcelist=(429, 500, 502, 503, 504), allowed_methods=frozenset({"POST", "GET"}))
    session = requests.Session()
    session.headers.update({"Content-Type": "application/json"})
    if api_key:
        session.headers["Authorization"] = f"Bearer {api_key}"
    session.mount("http://", HTTPAdapter(max_retries=retry))
    session.mount("https://", HTTPAdapter(max_retries=retry))
    return session


def encode_image(path: Path, max_side: int, jpeg_quality: int) -> Tuple[str, dict]:
    with Image.open(path) as opened:
        image = ImageOps.exif_transpose(opened).convert("RGB")
        original_width, original_height = image.size
        if max(image.size) > max_side:
            scale = max_side / float(max(image.size))
            image = image.resize((round(image.width * scale), round(image.height * scale)), LANCZOS)
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=jpeg_quality, optimize=True)
    payload = buffer.getvalue()
    return base64.b64encode(payload).decode("ascii"), {
        "original_width": original_width,
        "original_height": original_height,
        "encoded_width": image.width,
        "encoded_height": image.height,
        "encoded_bytes": len(payload),
    }


def extract_json(text: object) -> Optional[dict]:
    clean = str(text or "").strip()
    clean = re.sub(r"^```(?:json)?\s*", "", clean)
    clean = re.sub(r"\s*```$", "", clean)
    try:
        parsed = json.loads(clean)
        return parsed if isinstance(parsed, dict) else None
    except ValueError:
        pass
    decoder = json.JSONDecoder()
    candidates = []
    for match in re.finditer(r"\{", clean):
        try:
            parsed, _ = decoder.raw_decode(clean[match.start():])
        except ValueError:
            continue
        if isinstance(parsed, dict):
            candidates.append(parsed)
    return candidates[-1] if candidates else None


def normalize_boxes(raw_boxes: object) -> List[dict]:
    labels = []
    for raw in raw_boxes if isinstance(raw_boxes, list) else []:
        if not isinstance(raw, (list, tuple)) or len(raw) < 7:
            continue
        class_name = str(raw[0] or "").strip().lower()
        if class_name not in CLASSES:
            continue
        try:
            x1, y1, x2, y2 = [max(0.0, min(1000.0, float(value))) for value in raw[1:5]]
            score = max(0.0, min(1.0, float(raw[5])))
        except (TypeError, ValueError):
            continue
        evidence = str(raw[6] or "").strip()[:160]
        if x2 <= x1 or y2 <= y1 or score < THRESHOLDS[class_name]:
            continue
        if REJECT_EVIDENCE.search(evidence) or not ACCEPT_EVIDENCE[class_name].search(evidence):
            continue
        x = ((x1 + x2) / 2.0) / 1000.0
        y = ((y1 + y2) / 2.0) / 1000.0
        width = (x2 - x1) / 1000.0
        height = (y2 - y1) / 1000.0
        labels.append({
            "class_name": class_name,
            "class_id": CLASSES.index(class_name),
            "confidence": score,
            "evidence": evidence,
            "x": x,
            "y": y,
            "w": width,
            "h": height,
            "bbox_1000": [round(x1), round(y1), round(x2), round(y2)],
        })
    labels.sort(key=lambda item: item["confidence"], reverse=True)
    kept: List[dict] = []
    for label in labels:
        if any(old["class_name"] == label["class_name"] and box_iou(old, label) >= 0.55 for old in kept):
            continue
        kept.append(label)
    return kept[:12]


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


def chat(session: requests.Session, endpoint: str, model: str, prompt: str, image_b64: str, timeout: Tuple[float, float], max_tokens: int) -> Tuple[Optional[dict], str]:
    payload = {
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
            ],
        }],
        "temperature": 0.0,
        "max_tokens": max_tokens,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    response = session.post(endpoint.rstrip("/") + "/v1/chat/completions", json=payload, timeout=timeout)
    response.raise_for_status()
    body = response.json()
    message = ((body.get("choices") or [{}])[0].get("message") or {})
    text = message.get("content") or message.get("reasoning") or message.get("reasoning_content") or ""
    if isinstance(text, list):
        text = "\n".join(str(item.get("text") or "") if isinstance(item, dict) else str(item) for item in text)
    if not text:
        text = json.dumps(message, ensure_ascii=False)
    return extract_json(text), str(text)


def cache_path(root: Path, sha256: str) -> Path:
    return root / sha256[:2] / f"{sha256}.json"


def yolo_text(labels: List[dict]) -> str:
    lines = [f"{label['class_id']} {label['x']:.6f} {label['y']:.6f} {label['w']:.6f} {label['h']:.6f}" for label in labels]
    return "\n".join(lines) + ("\n" if lines else "")


def apply_review_guards(labels: List[dict], scene: str, collection_bucket: str) -> Tuple[List[dict], str, str]:
    guarded_labels = list(labels)
    guarded_scene = str(scene or "needs_human")
    bucket = str(collection_bucket or "")
    if guarded_scene == "unusable":
        return [], "unusable", "off_domain_or_non_photo"
    if guarded_labels and bucket.startswith("hard_negative"):
        return [], "needs_human", "positive_in_hard_negative_bucket"
    if guarded_scene == "positive" and not guarded_labels:
        return [], "needs_human", "positive_without_accepted_box"
    return guarded_labels, guarded_scene, ""


def label_candidates(args: argparse.Namespace) -> dict:
    dataset = args.dataset.resolve()
    manifest_path = dataset / "manifest_selected_images.jsonl"
    cache_root = dataset / "qwen_labels"
    label_root = dataset / "labels" / "review"
    result_manifest = dataset / "qwen_review_manifest.jsonl"
    session = retry_session(args.api_key)
    rows = list(iter_jsonl(manifest_path))
    source_by_sha = {str(row.get("sha256") or ""): row for row in rows}
    counts: Counter = Counter()
    processed = 0

    for row in rows:
        if processed >= args.max_images:
            break
        sha256 = str(row.get("sha256") or "")
        image_path = dataset / str(row.get("image") or "")
        if not re.fullmatch(r"[0-9a-f]{64}", sha256) or not image_path.is_file():
            counts["invalid_manifest_row"] += 1
            continue
        cache = cache_path(cache_root, sha256)
        if cache.is_file() and not args.force:
            try:
                existing = json.loads(cache.read_text(encoding="utf-8"))
            except ValueError:
                existing = {}
            if existing.get("ok") or (existing.get("error") and not args.retry_errors):
                counts["cached"] += 1
                continue
        processed += 1
        try:
            image_b64, image_meta = encode_image(image_path, args.max_side, args.jpeg_quality)
            parsed, raw_text = chat(session, args.endpoint, args.model, DETECT_PROMPT, image_b64, (args.connect_timeout, args.read_timeout), args.max_tokens)
            if parsed is None:
                raise ValueError(f"detect_json_parse_failed:{raw_text[:1200]}")
            photo_type = str(parsed.get("photo") or "unknown").strip().lower()
            domain = str(parsed.get("domain") or "off_domain").strip().lower()
            final_photo_type = photo_type
            final_domain = domain
            candidate_scene = str(parsed.get("scene") or "unusable").strip().lower()
            domain_usable = photo_type == "real_photo" and domain == "target"
            if not domain_usable:
                candidate_scene = "unusable"
            detected_labels = normalize_boxes(parsed.get("b") or parsed.get("boxes")) if domain_usable else []
            proposal = json.dumps({"q": parsed.get("q"), "photo": photo_type, "domain": domain, "scene": candidate_scene, "b": parsed.get("b") or parsed.get("boxes") or []}, ensure_ascii=False, separators=(",", ":"))
            audit_parsed = None
            audit_raw = ""
            final_labels = detected_labels
            audit_verdict = "not_run"
            if not args.no_audit and candidate_scene != "unusable":
                audit_prompt = AUDIT_PROMPT.replace("{proposal}", proposal)
                audit_parsed, audit_raw = chat(session, args.endpoint, args.model, audit_prompt, image_b64, (args.connect_timeout, args.read_timeout), args.max_tokens)
                if audit_parsed is None:
                    audit_verdict = "error"
                    final_labels = []
                else:
                    audit_verdict = str(audit_parsed.get("v") or "needs_human").strip().lower()
                    if audit_verdict not in {"pass", "needs_human"}:
                        audit_verdict = "needs_human"
                    audit_photo = str(audit_parsed.get("photo") or "unknown").strip().lower()
                    audit_domain = str(audit_parsed.get("domain") or "off_domain").strip().lower()
                    final_photo_type = audit_photo
                    final_domain = audit_domain
                    audit_scene = str(audit_parsed.get("scene") or candidate_scene).strip().lower()
                    audit_usable = audit_photo == "real_photo" and audit_domain == "target" and audit_scene != "unusable"
                    if not audit_usable:
                        candidate_scene = "unusable"
                        audited_labels = []
                    else:
                        audited_labels = normalize_boxes(audit_parsed.get("b") or audit_parsed.get("boxes"))
                    final_labels = audited_labels if audit_verdict == "pass" and audit_usable else []

            if candidate_scene not in {"positive", "hard_negative", "unusable"}:
                candidate_scene = "positive" if detected_labels else "hard_negative"
            if final_labels:
                scene = "positive"
            elif audit_verdict == "needs_human" and detected_labels:
                scene = "needs_human"
            else:
                scene = candidate_scene
            model_labels = list(final_labels)
            final_labels, scene, quarantine_reason = apply_review_guards(
                model_labels,
                scene,
                str(row.get("collection_bucket") or ""),
            )
            payload = {
                "schema": SCHEMA,
                "ok": True,
                "image_sha256": sha256,
                "image": row.get("image"),
                "model": args.model,
                "model_endpoint": args.endpoint,
                "prompt_sha256": hashlib.sha256(DETECT_PROMPT.encode("utf-8")).hexdigest(),
                "image_request": image_meta,
                "detect": {"parsed": parsed, "raw": raw_text[:8000], "accepted_labels": detected_labels},
                "audit": {"verdict": audit_verdict, "parsed": audit_parsed, "raw": audit_raw[:8000]},
                "candidate_scene": candidate_scene,
                "photo_type": final_photo_type,
                "domain": final_domain,
                "scene": scene,
                "model_labels": model_labels,
                "labels": final_labels,
                "quarantine_reason": quarantine_reason,
                "review_status": "needs_human",
                "training_eligible": False,
                "created_at": now_iso(),
            }
            write_json_atomic(cache, payload)
            label_root.mkdir(parents=True, exist_ok=True)
            label_path = label_root / f"{Path(str(row['image'])).stem}.txt"
            write_text_atomic(label_path, yolo_text(final_labels))
            counts[scene] += 1
            counts[f"audit_{audit_verdict}"] += 1
            counts["boxes"] += len(final_labels)
        except Exception as exc:
            write_json_atomic(cache, {
                "schema": SCHEMA,
                "ok": False,
                "image_sha256": sha256,
                "image": row.get("image"),
                "error": f"{type(exc).__name__}:{str(exc)[:400]}",
                "created_at": now_iso(),
                "training_eligible": False,
            })
            counts["error"] += 1

    corpus_counts: Counter = Counter()
    review_rows = []
    for cache in sorted(cache_root.glob("**/*.json")):
        try:
            payload = json.loads(cache.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            corpus_counts["invalid_cache"] += 1
            continue
        if not payload.get("ok"):
            corpus_counts["error_images"] += 1
            continue
        model_labels = payload.get("model_labels")
        if not isinstance(model_labels, list):
            model_labels = payload.get("labels") if isinstance(payload.get("labels"), list) else []
        proposed = ((payload.get("detect") or {}).get("accepted_labels") or [])
        source = source_by_sha.get(str(payload.get("image_sha256") or ""), {})
        labels, scene, quarantine_reason = apply_review_guards(
            model_labels,
            str(payload.get("scene") or "needs_human"),
            str(source.get("collection_bucket") or ""),
        )
        audit_verdict = str((payload.get("audit") or {}).get("verdict") or "not_run")
        image_rel = str(payload.get("image") or "")
        label_rel = f"labels/review/{Path(image_rel).stem}.txt"
        write_text_atomic(dataset / label_rel, yolo_text(labels))
        corpus_counts["labeled_images"] += 1
        corpus_counts[f"scene_{scene}"] += 1
        corpus_counts[f"audit_{audit_verdict}"] += 1
        corpus_counts["accepted_boxes"] += len(labels)
        corpus_counts["model_accepted_boxes"] += len(model_labels)
        corpus_counts["proposed_boxes"] += len(proposed)
        if quarantine_reason:
            corpus_counts[f"quarantine_{quarantine_reason}"] += 1
        review_rows.append({
            "schema": SCHEMA,
            "image_sha256": payload.get("image_sha256"),
            "image": image_rel,
            "label": label_rel,
            "cache": cache.relative_to(dataset).as_posix(),
            "scene": scene,
            "model_scene": payload.get("scene"),
            "photo_type": payload.get("photo_type"),
            "domain": payload.get("domain"),
            "collection_bucket": source.get("collection_bucket"),
            "quarantine_reason": quarantine_reason,
            "proposed_classes": sorted({str(label.get("class_name") or "") for label in proposed if isinstance(label, dict)}),
            "model_classes": sorted({str(label.get("class_name") or "") for label in model_labels if isinstance(label, dict)}),
            "classes": sorted({str(label.get("class_name") or "") for label in labels if isinstance(label, dict)}),
            "box_count": len(labels),
            "audit_verdict": audit_verdict,
            "review_status": "needs_human",
            "training_eligible": False,
        })
    write_text_atomic(
        result_manifest,
        "".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in review_rows),
    )

    summary_path = dataset / "dataset_summary.json"
    try:
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        summary = {}
    summary.update({
        "schema": summary.get("schema") or "jgzj_fire_smoke_web_candidate_summary.v1",
        "profile": "烟雾火焰网络候选集",
        "kind": "detect",
        "classes": ["fire", "smoke"],
        "qwen_label_summary": dict(corpus_counts),
        "qwen_last_run_summary": dict(counts),
        "qwen_model": args.model,
        "updated_at": now_iso(),
        "training_eligible": False,
        "training_policy": "human_review_required_after_qwen_audit",
    })
    write_json_atomic(summary_path, summary)
    return summary


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Pre-label web fire/smoke candidates with Qwen3.6-27B and a second visual audit.")
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--endpoint", default="http://127.0.0.1:18016")
    parser.add_argument("--model", default="Qwen3.6-27B-Labeler")
    parser.add_argument("--api-key", default=os.environ.get("QWEN_LABELER_API_KEY", ""))
    parser.add_argument("--max-images", type=int, default=200)
    parser.add_argument("--max-side", type=int, default=1600)
    parser.add_argument("--jpeg-quality", type=int, default=90)
    parser.add_argument("--max-tokens", type=int, default=900)
    parser.add_argument("--connect-timeout", type=float, default=10.0)
    parser.add_argument("--read-timeout", type=float, default=180.0)
    parser.add_argument("--no-audit", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--retry-errors", action="store_true")
    return parser.parse_args()


if __name__ == "__main__":
    print(json.dumps(label_candidates(parse_args()), ensure_ascii=False, indent=2))
