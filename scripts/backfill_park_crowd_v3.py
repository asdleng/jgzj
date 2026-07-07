#!/usr/bin/env python3
import argparse
import base64
import contextlib
import datetime as dt
import io
import json
import os
import re
import time
import urllib.request
from pathlib import Path

from PIL import Image


SCHEMA = "park_crowd_anonymous_people_features.v3"
MODEL = "Qwen3.6-27B-Labeler"
DEFAULT_SERVICE_URL = "http://127.0.0.1:18016"
FEATURE_KEYS = {
    "age_groups": ["child", "teenager", "adult", "elderly", "unknown"],
    "age_stage_groups": ["junior", "youth", "middle", "senior", "unknown"],
    "gender_groups": ["male", "female", "unknown"],
    "person_attributes": [
        "visitor",
        "business",
        "couple",
        "family",
        "staff",
        "security",
        "cleaner",
        "delivery",
        "maintenance",
        "vendor",
        "student",
        "unknown",
    ],
    "mobility_types": [
        "wheelchair",
        "cane_or_walker",
        "stroller",
        "assisted_walking",
        "slow_moving",
        "large_baggage",
        "unknown",
    ],
    "role_types": ["visitor", "staff", "security", "cleaner", "delivery", "maintenance", "vendor", "student", "volunteer", "unknown"],
    "activity_types": [
        "walking",
        "standing",
        "sitting_or_resting",
        "queueing",
        "gathering",
        "running",
        "cycling",
        "scooter_or_ebike",
        "taking_photo",
        "shopping_or_pickup",
        "crossing_road",
        "near_water",
        "unknown",
    ],
    "group_types": ["single", "pair", "family_parent_child", "elderly_group", "student_group", "tour_group", "work_crew", "queue", "gathering"],
}


def now_iso():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def log(message):
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}", flush=True)


def load_json(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return default


def save_json_atomic(path, payload):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


@contextlib.contextmanager
def directory_lock(lock_path, timeout_s=120, stale_s=1800):
    lock_path = Path(lock_path)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    start = time.monotonic()
    acquired = False
    while not acquired:
        try:
            os.mkdir(lock_path)
            acquired = True
        except FileExistsError:
            try:
                age_s = time.time() - lock_path.stat().st_mtime
                if age_s > stale_s:
                    lock_path.rmdir()
                    continue
            except FileNotFoundError:
                continue
            except OSError:
                pass
            if time.monotonic() - start > timeout_s:
                raise TimeoutError(f"timeout waiting for lock: {lock_path}")
            time.sleep(0.1)
    try:
        yield
    finally:
        if acquired:
            try:
                lock_path.rmdir()
            except OSError:
                pass


def iter_jsonl(path):
    with Path(path).open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                yield json.loads(line)
            except Exception:
                continue


def normalize_feature_key(value):
    return re.sub(r"(^_+|_+$)", "", re.sub(r"[^\w]+", "_", str(value or "").strip().lower()))


def normalize_people_count(value):
    try:
        num = float(value)
    except Exception:
        return None
    return int(round(num)) if num >= 0 else None


def normalize_count_map(value, allowed_keys):
    allowed = set(allowed_keys)
    result = {}
    if isinstance(value, list):
        for item in value:
            key = normalize_feature_key(item)
            if key in allowed:
                result[key] = result.get(key, 0) + 1
        return result
    if not isinstance(value, dict):
        return result
    for raw_key, raw_count in value.items():
        key = normalize_feature_key(raw_key)
        count = normalize_people_count(raw_count)
        if key in allowed and count and count > 0:
            result[key] = count
    return result


def cap_count_map(mapping, max_total, allowed_keys, fill_unknown=False):
    if not isinstance(mapping, dict):
        mapping = {}
    if max_total is None:
        return mapping
    max_total = max(0, int(max_total))
    if max_total == 0:
        return {}
    cleaned = {}
    for key in allowed_keys:
        count = normalize_people_count(mapping.get(key))
        if count and count > 0:
            cleaned[key] = count
    total = sum(cleaned.values())
    if total == 0:
        return {"unknown": max_total} if fill_unknown and "unknown" in allowed_keys else {}
    if total <= max_total:
        if fill_unknown and "unknown" in allowed_keys and total < max_total:
            cleaned["unknown"] = cleaned.get("unknown", 0) + (max_total - total)
        return cleaned
    scaled = []
    allocated = 0
    for key in allowed_keys:
        count = cleaned.get(key, 0)
        if count <= 0:
            continue
        value = count * max_total / total
        floor_value = int(value)
        scaled.append([key, floor_value, value - floor_value, count])
        allocated += floor_value
    remaining = max_total - allocated
    scaled.sort(key=lambda row: (-row[2], -row[3], allowed_keys.index(row[0])))
    for index in range(max(0, remaining)):
        if index < len(scaled):
            scaled[index][1] += 1
    return {key: value for key, value, _frac, _count in sorted(scaled, key=lambda row: allowed_keys.index(row[0])) if value > 0}


def normalize_confidence(value):
    value = str(value or "").strip().lower()
    return value if value in {"low", "medium", "high"} else "low"


def normalize_string_list(value, limit):
    if isinstance(value, str):
        raw = re.split(r"[,，、]", value)
    elif isinstance(value, list):
        raw = value
    else:
        raw = []
    rows = []
    seen = set()
    for item in raw:
        text = str(item or "").strip()[:48]
        if text and text not in seen:
            seen.add(text)
            rows.append(text)
        if len(rows) >= limit:
            break
    return rows


def normalize_risk_hints(value):
    rows = value if isinstance(value, list) else []
    result = []
    for item in rows:
        if isinstance(item, str):
            risk_type = normalize_feature_key(item)[:48]
            confidence = "low"
            note = ""
            count = 1
        elif isinstance(item, dict):
            risk_type = normalize_feature_key(item.get("type") or item.get("risk") or item.get("name"))[:48]
            confidence = normalize_confidence(item.get("confidence"))
            note = str(item.get("note") or "")[:120]
            count = normalize_people_count(item.get("count")) or 1
        else:
            continue
        if risk_type:
            result.append({"type": risk_type, "count": count, "confidence": confidence, "note": note})
        if len(result) >= 8:
            break
    return result


def normalize_frame_analysis(raw, fallback_people=None, model=MODEL):
    raw = raw if isinstance(raw, dict) else {}
    people_count = normalize_people_count(raw.get("people_count"))
    if people_count is None:
        people_count = fallback_people
    result = {
        "status": "done" if people_count is not None else "needs_review",
        "feature_schema": SCHEMA,
        "people_count": people_count,
        "confidence": normalize_confidence(raw.get("confidence")),
    }
    for key, allowed in FEATURE_KEYS.items():
        result[key] = cap_count_map(
            normalize_count_map(raw.get(key), allowed),
            people_count,
            allowed,
            fill_unknown=key in {"age_groups", "age_stage_groups", "gender_groups", "person_attributes", "role_types"},
        )
    result["risk_hints"] = normalize_risk_hints(raw.get("risk_hints"))
    result["scene_tags"] = normalize_string_list(raw.get("scene_tags"), 8)
    result["note"] = str(raw.get("note") or raw.get("raw_reply") or "")[:300]
    result["model"] = model
    result["analyzed_at"] = now_iso()
    return result


def sum_feature_maps(frames, key):
    result = {}
    for frame in frames:
        mapping = frame.get(key) if isinstance(frame, dict) else {}
        if not isinstance(mapping, dict):
            continue
        for raw_key, raw_count in mapping.items():
            count = normalize_people_count(raw_count)
            if count and count > 0:
                result[raw_key] = result.get(raw_key, 0) + count
    return result


def aggregate_risks(frames):
    scores = {"low": 1, "medium": 2, "high": 3}
    merged = {}
    for frame in frames:
        for risk in frame.get("risk_hints") or []:
            risk_type = normalize_feature_key(risk.get("type"))
            if not risk_type:
                continue
            current = merged.get(risk_type) or {"type": risk_type, "count": 0, "confidence": "low", "notes": []}
            current["count"] += normalize_people_count(risk.get("count")) or 1
            if scores.get(risk.get("confidence"), 0) > scores.get(current["confidence"], 0):
                current["confidence"] = risk.get("confidence")
            if risk.get("note") and len(current["notes"]) < 2:
                current["notes"].append(risk["note"])
            merged[risk_type] = current
    return [
        {"type": item["type"], "count": item["count"], "confidence": item["confidence"], "note": "；".join(item["notes"])}
        for item in sorted(merged.values(), key=lambda x: (-x["count"], -scores.get(x["confidence"], 0)))[:10]
    ]


def aggregate_frames(frames, model=MODEL):
    counts = [normalize_people_count(frame.get("people_count")) for frame in frames]
    valid_counts = [count for count in counts if count is not None]
    aggregate = {
        "status": "done" if frames and len(valid_counts) == len(frames) else ("partial" if valid_counts else "needs_review"),
        "feature_schema": SCHEMA,
        "people_count": sum(valid_counts) if valid_counts else None,
        "max_single_camera_people": max(valid_counts) if valid_counts else None,
        "frame_count_analyzed": len(frames),
    }
    for key in FEATURE_KEYS:
        aggregate[key] = sum_feature_maps(frames, key)
    aggregate["risk_hints"] = aggregate_risks(frames)
    aggregate["scene_tags"] = normalize_string_list(sum((frame.get("scene_tags") or [] for frame in frames), []), 12)
    aggregate["model"] = model
    aggregate["analyzed_at"] = now_iso()
    aggregate["note"] = "匿名聚合分析：people_count 与各类人群特征为四路相机可见结果合计；max_single_camera_people 为单路最大值，供重叠视角保守参考。"
    return aggregate


def vehicle_estimate_snapshot(analysis):
    if not isinstance(analysis, dict):
        return None
    if isinstance(analysis.get("vehicle_estimate"), dict):
        return analysis["vehicle_estimate"]
    if analysis.get("status") not in {"vehicle_estimate", "vehicle_estimate_server_reviewed"}:
        return None
    return {
        "people_count": analysis.get("people_count"),
        "max_single_camera_people": analysis.get("max_single_camera_people"),
        "frame_count_analyzed": analysis.get("frame_count_analyzed"),
        "confidence": analysis.get("confidence"),
        "model": analysis.get("model") or "vehicle_perception_upload",
        "analyzed_at": analysis.get("analyzed_at"),
        "note": analysis.get("note"),
    }


def merge_vehicle_estimate(sample_analysis, server_aggregate):
    estimate = vehicle_estimate_snapshot(sample_analysis)
    if not estimate:
        return server_aggregate
    note = " ".join(filter(None, [server_aggregate.get("note"), f"车端初始统计 {estimate.get('people_count')} 人。"]))
    return {
        **server_aggregate,
        "status": "vehicle_estimate_server_reviewed" if server_aggregate.get("status") == "done" else server_aggregate.get("status"),
        "vehicle_estimate": estimate,
        "server_vlm": server_aggregate,
        "note": note[:500],
    }


def effective_aggregate(sample, state_samples):
    state_entry = state_samples.get(sample.get("sample_id")) if isinstance(state_samples, dict) else None
    if isinstance(state_entry, dict) and isinstance(state_entry.get("aggregate"), dict):
        return state_entry["aggregate"]
    return sample.get("analysis") if isinstance(sample.get("analysis"), dict) else {}


def has_v3(sample, state_samples):
    aggregate = effective_aggregate(sample, state_samples)
    return (
        aggregate.get("feature_schema") == SCHEMA
        and isinstance(aggregate.get("age_stage_groups"), dict)
        and isinstance(aggregate.get("gender_groups"), dict)
        and isinstance(aggregate.get("person_attributes"), dict)
    )


def image_mime(path):
    ext = Path(path).suffix.lower()
    if ext == ".png":
        return "image/png"
    if ext == ".webp":
        return "image/webp"
    return "image/jpeg"


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
    }


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
        return {"raw_reply": clean[:500]}
    try:
        return json.loads(match.group(0))
    except Exception:
        return {"raw_reply": clean[:500]}


def build_prompt(frames):
    frame_lines = []
    for index, frame in enumerate(frames, 1):
        frame_lines.append(f'image_{index}: camera_id={frame.get("camera_id") or "-"}, capture_id={frame.get("capture_id") or "-"}')
    return (
        "你在做园区巡逻车的人流画像历史回填。下面是一条巡逻采样的最多四路相机图片，请分别分析每张图中可见的真实人体。"
        "只做匿名聚合，不做人脸识别，不识别具体身份，不推断民族、宗教、疾病、收入、政治观点等敏感身份。"
        "性别只做画面中可见外观的粗略聚合估计，不代表真实性别身份；不清楚就 unknown。"
        "客群阶段只做运营分组估计，不输出具体年龄，不判断单个人精确年龄；远处、遮挡、模糊或不确定时计入 unknown。"
        "age_stage_groups 四档含义仅供内部判断：junior=7-17，youth=18-44，middle=45-59，senior=60+。"
        "person_attributes 按画面上下文和同行关系判断：visitor普通游客、business商务人士、couple情侣、family家庭、staff园区工作人员、security安保、cleaner保洁、delivery配送、maintenance维修施工、vendor商户摊位、student学生；不确定 unknown。"
        "不要数雕塑、海报、倒影、屏幕画面。每个分类字段内部的合计都不得超过 people_count。"
        "只输出紧凑 JSON，不要 Markdown，不要解释。"
        f"图片列表：{'; '.join(frame_lines)}。"
        '输出格式：{"frames":[{"image_index":1,"camera_id":"camera1","people_count":0,"confidence":"low|medium|high",'
        '"age_groups":{"child":0,"teenager":0,"adult":0,"elderly":0,"unknown":0},'
        '"age_stage_groups":{"junior":0,"youth":0,"middle":0,"senior":0,"unknown":0},'
        '"gender_groups":{"male":0,"female":0,"unknown":0},'
        '"person_attributes":{"visitor":0,"business":0,"couple":0,"family":0,"staff":0,"security":0,"cleaner":0,"delivery":0,"maintenance":0,"vendor":0,"student":0,"unknown":0},'
        '"mobility_types":{"wheelchair":0,"cane_or_walker":0,"stroller":0,"assisted_walking":0,"slow_moving":0,"large_baggage":0,"unknown":0},'
        '"role_types":{},'
        '"activity_types":{"walking":0,"standing":0,"sitting_or_resting":0,"queueing":0,"gathering":0,"running":0,"cycling":0,"scooter_or_ebike":0,"taking_photo":0,"shopping_or_pickup":0,"crossing_road":0,"near_water":0,"unknown":0},'
        '"group_types":{"single":0,"pair":0,"family_parent_child":0,"elderly_group":0,"student_group":0,"tour_group":0,"work_crew":0,"queue":0,"gathering":0},'
        '"risk_hints":[{"type":"child_near_road|child_near_water|elderly_needs_care|mobility_barrier|crowd_gathering|queue_congestion|mixed_traffic|night_stay|construction_near_people","confidence":"low|medium|high","note":"中文短句"}],'
        '"scene_tags":["中文短标签"],"note":"中文简短说明"}]}'
    )


def call_qwen(service_url, frames, max_side, jpeg_quality, timeout_s, max_tokens):
    content = [{"type": "text", "text": build_prompt(frames)}]
    for index, frame in enumerate(frames, 1):
        image_b64, meta = encode_image(frame["abs_path"], max_side, jpeg_quality)
        frame["encode_meta"] = meta
        content.append({"type": "text", "text": f"image_{index}: camera_id={frame.get('camera_id') or '-'}"})
        content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}})
    payload = {
        "model": MODEL,
        "messages": [{"role": "user", "content": content}],
        "temperature": 0,
        "max_tokens": max_tokens,
        "stream": False,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    req = urllib.request.Request(
        service_url.rstrip("/") + "/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout_s) as response:
        raw = response.read().decode("utf-8", errors="replace")
    data = json.loads(raw)
    reply = (data.get("choices") or [{}])[0].get("message", {}).get("content") or ""
    return extract_json(reply)


def prepare_frames(sample, frames_root, require_existing_files=True):
    frames = []
    for frame in (sample.get("frames") or [])[:4]:
        image_rel = str(frame.get("image_path") or "").replace("\\", "/").lstrip("/")
        if require_existing_files and not image_rel:
            continue
        abs_path = frames_root / image_rel
        if require_existing_files and not abs_path.exists():
            continue
        frames.append({
            "capture_id": frame.get("capture_id") or frame.get("camera_id") or f"frame_{len(frames)+1}",
            "camera_id": frame.get("camera_id") or f"camera{len(frames)+1}",
            "image_path": image_rel,
            "abs_path": abs_path,
            "existing_analysis": frame.get("analysis") if isinstance(frame.get("analysis"), dict) else {},
        })
    return frames


def zero_fill_result(sample, frames):
    frame_results = {}
    normalized = []
    for frame in frames:
        existing = frame.get("existing_analysis") or {}
        result = normalize_frame_analysis({
            **existing,
            "people_count": 0,
            "confidence": existing.get("confidence") or "high",
            "note": existing.get("note") or "历史样本无可见人员，按空场景补齐 v3 画像字段。",
        }, fallback_people=0, model=existing.get("model") or "historical_v3_zero_fill")
        result["model"] = existing.get("model") or "historical_v3_zero_fill"
        frame_results[frame["capture_id"]] = result
        normalized.append(result)
    aggregate = aggregate_frames(normalized, model="historical_v3_zero_fill")
    aggregate["people_count"] = 0
    aggregate["max_single_camera_people"] = 0
    aggregate["status"] = "done"
    aggregate["note"] = "历史样本无可见人员，按已有空场景结果补齐 v3 画像字段。"
    return frame_results, aggregate


def missing_image_fallback_result(sample, frames, existing_aggregate):
    people_count = normalize_people_count(existing_aggregate.get("people_count")) or 0
    frame_results = {}
    for frame in frames:
        existing = frame.get("existing_analysis") or {}
        frame_people = normalize_people_count(existing.get("people_count"))
        result = normalize_frame_analysis({
            **existing,
            "people_count": frame_people if frame_people is not None else 0,
            "confidence": existing.get("confidence") or "low",
            "note": existing.get("note") or "历史样本图片已不在本地缓存，按既有人数统计补齐 v3 画像字段。",
        }, fallback_people=frame_people if frame_people is not None else 0, model="historical_v3_missing_image_fallback")
        result["model"] = "historical_v3_missing_image_fallback"
        frame_results[frame["capture_id"]] = result

    aggregate = {
        "status": existing_aggregate.get("status") if existing_aggregate.get("status") in {"done", "vehicle_estimate_server_reviewed", "partial"} else "done",
        "feature_schema": SCHEMA,
        "people_count": people_count,
        "max_single_camera_people": normalize_people_count(existing_aggregate.get("max_single_camera_people")),
        "frame_count_analyzed": normalize_people_count(existing_aggregate.get("frame_count_analyzed")) or len(frames),
        "confidence": normalize_confidence(existing_aggregate.get("confidence")),
    }
    for key, allowed in FEATURE_KEYS.items():
        source_map = normalize_count_map(existing_aggregate.get(key), allowed)
        if key == "person_attributes" and not source_map:
            role_map = normalize_count_map(existing_aggregate.get("role_types"), FEATURE_KEYS["role_types"])
            source_map = {role: count for role, count in role_map.items() if role in allowed}
        aggregate[key] = cap_count_map(
            source_map,
            people_count,
            allowed,
            fill_unknown=key in {"age_groups", "age_stage_groups", "gender_groups", "person_attributes", "role_types"},
        )
    aggregate["risk_hints"] = normalize_risk_hints(existing_aggregate.get("risk_hints"))
    aggregate["scene_tags"] = normalize_string_list(existing_aggregate.get("scene_tags"), 12)
    aggregate["model"] = "historical_v3_missing_image_fallback"
    aggregate["analyzed_at"] = now_iso()
    aggregate["note"] = "历史样本图片已不在本地缓存，按既有人数统计补齐 v3 匿名画像字段；不可见维度计入 unknown。"
    return frame_results, aggregate


def qwen_result(parsed, frames):
    rows = parsed.get("frames") if isinstance(parsed, dict) else None
    if not isinstance(rows, list):
        rows = []
    by_index = {}
    by_camera = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        idx = normalize_people_count(row.get("image_index"))
        if idx:
            by_index[idx] = row
        camera_id = str(row.get("camera_id") or "").strip()
        if camera_id:
            by_camera[camera_id] = row
    frame_results = {}
    normalized = []
    for index, frame in enumerate(frames, 1):
        raw = by_index.get(index) or by_camera.get(frame["camera_id"]) or {}
        result = normalize_frame_analysis(raw, model=MODEL)
        if result["people_count"] is None:
            result["status"] = "needs_review"
            result["note"] = (result.get("note") or "Qwen3.6-27B 历史回填未返回有效人数。")[:300]
        frame_results[frame["capture_id"]] = result
        normalized.append(result)
    return frame_results, aggregate_frames(normalized, model=MODEL)


def build_state_entry(sample, frame_results, aggregate):
    original = sample.get("analysis") if isinstance(sample.get("analysis"), dict) else {}
    original_frames = sample.get("frames") if isinstance(sample.get("frames"), list) else []
    frames = {}
    metadata_keys = [
        "capture_id",
        "camera_id",
        "image_size_bytes",
        "image_width",
        "image_height",
        "image_mime_type",
        "image_path",
        "image_url",
        "source_image_path",
        "frame_index",
        "row_index",
        "collected_at",
        "collected_at_ms",
    ]
    for frame in original_frames:
        if not isinstance(frame, dict):
            continue
        frame_key = frame.get("capture_id") or frame.get("camera_id") or f"frame_{len(frames) + 1}"
        metadata = {key: frame.get(key) for key in metadata_keys if frame.get(key) is not None}
        analysis = frame_results.get(frame_key) or frame_results.get(frame.get("camera_id")) or frame.get("analysis") or {}
        frames[frame_key] = {**metadata, **analysis}
    for frame_key, analysis in frame_results.items():
        if frame_key not in frames:
            frames[frame_key] = {"capture_id": frame_key, "analysis": analysis}
    return {
        "sample_id": sample.get("sample_id"),
        "vehicle_id": sample.get("vehicle_id"),
        "collected_at": sample.get("collected_at"),
        "position": sample.get("position"),
        "source": sample.get("source"),
        "upload_session_id": sample.get("upload_session_id"),
        "frames": frames,
        "aggregate": merge_vehicle_estimate(original, aggregate),
    }


def flush_updates(state_path, progress_path, lock_path, updates, progress, force=False):
    written_count = 0
    skipped_current_count = 0
    with directory_lock(lock_path):
        current = load_json(state_path, {"version": 1, "samples": {}})
        if not isinstance(current, dict):
            current = {"version": 1, "samples": {}}
        samples = current.get("samples")
        if not isinstance(samples, dict):
            samples = {}
        for sample_id, entry in updates.items():
            if not force:
                aggregate = samples.get(sample_id, {}).get("aggregate", {}) if isinstance(samples.get(sample_id), dict) else {}
                if (
                    isinstance(aggregate, dict)
                    and aggregate.get("feature_schema") == SCHEMA
                    and isinstance(aggregate.get("age_stage_groups"), dict)
                    and isinstance(aggregate.get("gender_groups"), dict)
                    and isinstance(aggregate.get("person_attributes"), dict)
                ):
                    skipped_current_count += 1
                    continue
            samples[sample_id] = entry
            written_count += 1
        current["samples"] = samples
        current["version"] = current.get("version") or 1
        current["updated_at"] = now_iso()
        current["last_trigger"] = "historical_v3_backfill"
        current["last_attempt_at"] = now_iso()
        current["last_result"] = {
            "ok": True,
            "run_id": progress.get("run_id"),
            "analyzed_count": progress.get("qwen_count", 0),
            "zero_fill_count": progress.get("zero_fill_count", 0),
            "error_count": progress.get("error_count", 0),
            "skipped_count": progress.get("skipped_count", 0),
            "skipped_current_count": progress.get("skipped_current_count", 0) + skipped_current_count,
            "elapsed_ms": int((time.time() - progress["started_time"]) * 1000),
        }
        current["config"] = {
            **(current.get("config") if isinstance(current.get("config"), dict) else {}),
            "historical_v3_backfill": {
                "schema": SCHEMA,
                "model": MODEL,
                "base_url": DEFAULT_SERVICE_URL,
                "updated_at": now_iso(),
            },
        }
        save_json_atomic(state_path, current)
    progress["skipped_current_count"] = progress.get("skipped_current_count", 0) + skipped_current_count
    progress["written_count"] = progress.get("written_count", 0) + written_count
    save_json_atomic(progress_path, progress)
    return written_count, skipped_current_count


def main():
    parser = argparse.ArgumentParser(description="Backfill JGZJ park crowd v3 multi-category portraits.")
    parser.add_argument("--root", default="/home/admin1/jgzj")
    parser.add_argument("--service-url", default=DEFAULT_SERVICE_URL)
    parser.add_argument("--limit", type=int, default=0, help="Max samples to process this run. 0 means no limit.")
    parser.add_argument("--qwen-limit", type=int, default=0, help="Max Qwen-analyzed samples. 0 means no limit.")
    parser.add_argument("--order", choices=["newest", "oldest"], default="newest")
    parser.add_argument("--flush-every", type=int, default=20)
    parser.add_argument("--sleep-s", type=float, default=0.2)
    parser.add_argument("--timeout-s", type=int, default=180)
    parser.add_argument("--max-side", type=int, default=720)
    parser.add_argument("--jpeg-quality", type=int, default=76)
    parser.add_argument("--max-tokens", type=int, default=2200)
    parser.add_argument("--no-zero-fill", action="store_true")
    parser.add_argument("--zero-fill-only", action="store_true", help="Only backfill samples whose effective people_count is 0.")
    parser.add_argument("--nonzero-only", action="store_true", help="Only backfill samples whose effective people_count is positive or unknown.")
    parser.add_argument("--fallback-missing-images", action="store_true", help="For nonzero samples with missing local images, fill v3 fields from existing counts and unknown buckets.")
    parser.add_argument("--fallback-missing-images-only", action="store_true")
    parser.add_argument("--progress-path", default="")
    parser.add_argument("--run-id", default="")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    root = Path(args.root)
    runtime = root / ".runtime/park-pcm"
    samples_path = runtime / "crowd-samples.jsonl"
    state_path = runtime / "crowd-analysis-state.json"
    run_id = args.run_id or f"{time.strftime('%Y%m%d_%H%M%S')}_{os.getpid()}"
    progress_path = Path(args.progress_path) if args.progress_path else runtime / f"crowd-v3-backfill-state-{run_id}.json"
    lock_path = Path(str(state_path) + ".lock")
    frames_root = runtime / "crowd-frames"

    rows = list(iter_jsonl(samples_path))
    state = load_json(state_path, {"samples": {}})
    state_samples = state.get("samples") if isinstance(state.get("samples"), dict) else {}
    rows = [row for row in rows if row.get("sample_id") and isinstance(row.get("frames"), list) and row.get("frames")]
    rows.sort(key=lambda item: item.get("collected_at") or "", reverse=args.order == "newest")

    candidates = [row for row in rows if args.force or not has_v3(row, state_samples)]
    log(f"loaded samples={len(rows)} candidates={len(candidates)} order={args.order} dry_run={args.dry_run}")
    progress = load_json(progress_path, {})
    if not isinstance(progress, dict) or args.force:
        progress = {}
    progress.setdefault("run_id", run_id)
    progress.setdefault("schema", SCHEMA)
    progress.setdefault("model", MODEL)
    progress.setdefault("started_at", now_iso())
    progress["started_time"] = time.time()
    progress.setdefault("processed_sample_ids", [])
    progress.setdefault("errors", [])
    processed_ids = set(progress.get("processed_sample_ids") or [])
    updates = {}
    processed_this_run = 0
    qwen_count = 0
    zero_fill_count = 0
    missing_image_fallback_count = 0
    skipped_count = 0
    error_count = 0

    for sample in candidates:
        sample_id = sample.get("sample_id")
        if sample_id in processed_ids and not args.force:
            skipped_count += 1
            continue
        if args.limit and processed_this_run >= args.limit:
            break
        aggregate = effective_aggregate(sample, state_samples)
        people_count = normalize_people_count(aggregate.get("people_count"))
        if args.zero_fill_only and people_count != 0:
            skipped_count += 1
            continue
        if args.nonzero_only and people_count == 0:
            skipped_count += 1
            continue
        needs_images = people_count != 0 or args.no_zero_fill
        metadata_frames = prepare_frames(sample, frames_root, require_existing_files=False)
        frames = prepare_frames(sample, frames_root, require_existing_files=needs_images)
        missing_images = bool(metadata_frames) and needs_images and not frames
        if args.fallback_missing_images_only and not (people_count and people_count > 0 and missing_images):
            skipped_count += 1
            continue
        if not frames and not (args.fallback_missing_images and people_count and people_count > 0 and missing_images):
            skipped_count += 1
            continue
        if not args.force and people_count != 0 and not args.dry_run:
            latest_state = load_json(state_path, {"samples": {}})
            latest_samples = latest_state.get("samples") if isinstance(latest_state.get("samples"), dict) else {}
            if has_v3(sample, latest_samples):
                skipped_count += 1
                continue
        try:
            if people_count == 0 and not args.no_zero_fill:
                frame_results, aggregate_result = zero_fill_result(sample, metadata_frames or frames)
                action = "zero_fill"
                zero_fill_count += 1
            elif missing_images and args.fallback_missing_images:
                frame_results, aggregate_result = missing_image_fallback_result(sample, metadata_frames, aggregate)
                action = "missing_image_fallback"
                missing_image_fallback_count += 1
            else:
                if args.qwen_limit and qwen_count >= args.qwen_limit:
                    break
                if args.dry_run:
                    log(f"dry_run would_qwen sample_id={sample_id} vehicle={sample.get('vehicle_id')} people={people_count}")
                    processed_this_run += 1
                    continue
                parsed = call_qwen(args.service_url, frames, args.max_side, args.jpeg_quality, args.timeout_s, args.max_tokens)
                frame_results, aggregate_result = qwen_result(parsed, frames)
                action = "qwen"
                qwen_count += 1
            if not args.dry_run:
                updates[sample_id] = build_state_entry(sample, frame_results, aggregate_result)
                processed_ids.add(sample_id)
                progress["processed_sample_ids"] = sorted(processed_ids)
                progress["last_sample_id"] = sample_id
                progress["updated_at"] = now_iso()
                progress["qwen_count"] = progress.get("qwen_count", 0) + (1 if action == "qwen" else 0)
                progress["zero_fill_count"] = progress.get("zero_fill_count", 0) + (1 if action == "zero_fill" else 0)
                progress["missing_image_fallback_count"] = progress.get("missing_image_fallback_count", 0) + (1 if action == "missing_image_fallback" else 0)
                progress["skipped_count"] = skipped_count
                progress["error_count"] = progress.get("error_count", 0)
            processed_this_run += 1
            log(f"{action} sample={sample_id} vehicle={sample.get('vehicle_id')} people={aggregate_result.get('people_count')} processed={processed_this_run} qwen={qwen_count} zero={zero_fill_count} missing_fallback={missing_image_fallback_count}")
            if not args.dry_run and len(updates) >= max(1, args.flush_every):
                written_count, skipped_current_count = flush_updates(state_path, progress_path, lock_path, updates, progress, force=args.force)
                log(f"flushed updates={len(updates)} written={written_count} skipped_current={skipped_current_count}")
                updates = {}
            if args.sleep_s > 0:
                time.sleep(args.sleep_s)
        except Exception as exc:
            error_count += 1
            progress["error_count"] = progress.get("error_count", 0) + 1
            progress.setdefault("errors", []).append({
                "sample_id": sample_id,
                "vehicle_id": sample.get("vehicle_id"),
                "collected_at": sample.get("collected_at"),
                "error": str(exc)[:500],
                "at": now_iso(),
            })
            progress["errors"] = progress["errors"][-100:]
            log(f"error sample={sample_id} error={exc}")
            if not args.dry_run:
                save_json_atomic(progress_path, progress)
            time.sleep(max(1.0, args.sleep_s))

    if not args.dry_run and updates:
        written_count, skipped_current_count = flush_updates(state_path, progress_path, lock_path, updates, progress, force=args.force)
        log(f"flushed final updates={len(updates)} written={written_count} skipped_current={skipped_current_count}")
    log(f"done processed={processed_this_run} qwen={qwen_count} zero_fill={zero_fill_count} missing_fallback={missing_image_fallback_count} skipped={skipped_count} errors={error_count}")


if __name__ == "__main__":
    main()
