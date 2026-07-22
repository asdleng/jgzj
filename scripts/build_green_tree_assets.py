#!/usr/bin/env python3
import argparse
import base64
import fcntl
import hashlib
import io
import json
import math
import os
import re
import tempfile
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np
from PIL import Image


SCHEMA = "park_green_tree_assets.v1"
WORKER_SCHEMA = "park_green_tree_asset_worker.v1"
SOURCE = "auto_ad_patrol_flow_upload"
PROMPT = """你是园区树木资产建档员。下面按日期给出同一车辆机位、同一路段、同一相机的多天鱼眼画面。
只识别可以跨天确认是同一实体的独立单干乔木。灌木、绿篱、竹丛、丛生棕榈、多株相连树群、盆栽和远处无法分开的林冠不要建立单树资产。
必须综合树干位置、主枝形状、树冠轮廓以及相对固定建筑和道路的位置。不能仅因都是绿色植物就匹配。
每棵树分配 track_id T001、T002...；坐标采用原图归一化 0-1000，bbox=[x1,y1,x2,y2]，root=[树干接地点x,y]。
某天看不清就不要编造该日 observation。至少三天均能确认才输出。框必须随实际画面调整，不要机械复制首日坐标。
只输出紧凑 JSON，不要 Markdown：
{"tracks":[{"track_id":"T001","asset_kind":"individual_tree|tree_cluster|uncertain","confidence":"high|medium|low","signature":"稳定特征中文描述","observations":[{"date":"YYYY-MM-DD","bbox":[0,0,0,0],"root":[0,0],"visibility":"full|partial","evidence":"该日匹配证据"}]}],"unmatched_notes":["不建档原因"]}
"""


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def date_key(value):
    return str(value or "")[:10]


def read_json(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return default


def write_json_atomic(path, payload):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=target.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, target)
    finally:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)


def angle_difference(left, right):
    difference = abs(float(left or 0) - float(right or 0))
    while difference > math.pi:
        difference = abs(difference - 2 * math.pi)
    return difference


def distance_m(left, right):
    radius = 6371000.0
    radians = math.pi / 180
    lat1 = float(left["gaode_latitude"]) * radians
    lat2 = float(right["gaode_latitude"]) * radians
    delta_lat = lat2 - lat1
    delta_lon = (float(right["gaode_longitude"]) - float(left["gaode_longitude"])) * radians
    value = math.sin(delta_lat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(value))


def scene_grid(position, cell_size_m=25.0):
    radius = 6378137.0
    latitude = max(-85.0, min(85.0, float(position["gaode_latitude"])))
    longitude = float(position["gaode_longitude"])
    x = radius * math.radians(longitude)
    y = radius * math.log(math.tan(math.pi / 4 + math.radians(latitude) / 2))
    grid_x = math.floor(x / cell_size_m)
    grid_y = math.floor(y / cell_size_m)
    center_x = (grid_x + 0.5) * cell_size_m
    center_y = (grid_y + 0.5) * cell_size_m
    center_longitude = math.degrees(center_x / radius)
    center_latitude = math.degrees(2 * math.atan(math.exp(center_y / radius)) - math.pi / 2)
    return {
        "grid_x": grid_x,
        "grid_y": grid_y,
        "cell_size_m": float(cell_size_m),
        "center": {
            "gaode_latitude": center_latitude,
            "gaode_longitude": center_longitude,
        },
    }


def scene_metadata(vehicle_id, position, cell_size_m=25.0):
    grid = scene_grid(position, cell_size_m)
    return {
        **grid,
        "scene_id": f"{vehicle_id}-G{grid['grid_x']}-{grid['grid_y']}",
        "scene_label": f"巡逻场景 {grid['grid_x'] % 1000:03d}-{grid['grid_y'] % 1000:03d}",
    }


def valid_position(sample):
    position = sample.get("position") or {}
    try:
        latitude = float(position.get("gaode_latitude"))
        longitude = float(position.get("gaode_longitude"))
    except (TypeError, ValueError):
        return False
    if abs(latitude) < 1e-6 and abs(longitude) < 1e-6:
        return False
    return -85 <= latitude <= 85 and -180 <= longitude <= 180


def load_vehicle_samples(path, vehicle_id):
    rows = []
    with Path(path).open("r", encoding="utf-8") as handle:
        for line in handle:
            try:
                item = json.loads(line)
            except Exception:
                continue
            if item.get("source") != SOURCE or item.get("skipped") or str(item.get("vehicle_id") or "") != vehicle_id:
                continue
            if not item.get("sample_id") or not valid_position(item) or not item.get("frames"):
                continue
            rows.append(item)
    rows.sort(key=lambda item: str(item.get("collected_at") or ""))
    return rows


def tree_camera_ids(inspection):
    rows = []
    for view in inspection.get("view_assessments") or []:
        if view.get("vegetation_types", {}).get("trees") is True and view.get("vegetation_visible") is True:
            camera_id = str(view.get("camera_id") or "").strip()
            if camera_id and camera_id not in rows:
                rows.append(camera_id)
    return rows


def round_robin_jobs_by_scene(jobs):
    by_scene = {}
    scene_order = []
    for job in jobs:
        scene_id = job["scene"]["scene_id"]
        if scene_id not in by_scene:
            by_scene[scene_id] = []
            scene_order.append(scene_id)
        by_scene[scene_id].append(job)
    ordered = []
    while True:
        added = False
        for scene_id in scene_order:
            if by_scene[scene_id]:
                ordered.append(by_scene[scene_id].pop(0))
                added = True
        if not added:
            return ordered


def select_jobs(samples, inspections, max_anchors, separation_m, position_gate_m, heading_gate_deg, history_days=8, scene_cell_size_m=25.0, frames_root=None):
    by_id = {str(item.get("sample_id")): item for item in samples}
    tree_inspections = [
        item for item in inspections
        if item.get("vegetation_types", {}).get("trees") is True and str(item.get("sample_id")) in by_id
    ]
    if not tree_inspections:
        return [], None
    latest_date = max(date_key(item.get("collected_at")) for item in tree_inspections)
    latest = [item for item in tree_inspections if date_key(item.get("collected_at")) == latest_date]
    available_dates = sorted({date_key(item.get("collected_at")) for item in samples if date_key(item.get("collected_at")) <= latest_date}, reverse=True)
    prior_dates = available_dates[1:max(1, int(history_days))]
    samples_by_date = {date: [item for item in samples if date_key(item.get("collected_at")) == date] for date in prior_dates}
    heading_gate = math.radians(heading_gate_deg)
    candidates = []
    for inspection in latest:
        anchor = by_id[str(inspection["sample_id"])]
        matches = []
        current_sample = anchor
        current_date = latest_date
        for date in prior_dates:
            ranked = []
            for candidate in samples_by_date.get(date, []):
                step_distance = distance_m(current_sample["position"], candidate["position"])
                step_heading_delta = angle_difference(current_sample["position"].get("heading"), candidate["position"].get("heading"))
                if step_distance <= position_gate_m and step_heading_delta <= heading_gate:
                    ranked.append((step_distance, step_heading_delta, candidate))
            if ranked:
                step_distance, step_heading_delta, candidate = min(ranked, key=lambda row: (row[0], row[1]))
                anchor_distance = distance_m(anchor["position"], candidate["position"])
                anchor_heading_delta = angle_difference(anchor["position"].get("heading"), candidate["position"].get("heading"))
                matches.append({
                    "date": date,
                    "sample": candidate,
                    "reference_date": current_date,
                    "step_distance_m": step_distance,
                    "step_heading_delta_rad": step_heading_delta,
                    "anchor_distance_m": anchor_distance,
                    "anchor_heading_delta_rad": anchor_heading_delta,
                })
                current_sample = candidate
                current_date = date
        if len(matches) < 2:
            continue
        candidates.append({
            "anchor": anchor,
            "inspection": inspection,
            "scene": scene_metadata(anchor.get("vehicle_id"), anchor["position"], scene_cell_size_m),
            "dates": [{
                "date": latest_date,
                "sample": anchor,
                "reference_date": None,
                "step_distance_m": 0.0,
                "step_heading_delta_rad": 0.0,
                "anchor_distance_m": 0.0,
                "anchor_heading_delta_rad": 0.0,
            }, *matches],
            "cameras": tree_camera_ids(inspection),
            "max_step_distance_m": max(item["step_distance_m"] for item in matches),
        })
    candidate_key = lambda item: (item["max_step_distance_m"], str(item["anchor"].get("collected_at") or ""))
    candidates.sort(key=candidate_key)
    candidates_by_scene = {}
    for candidate in candidates:
        candidates_by_scene.setdefault(candidate["scene"]["scene_id"], []).append(candidate)
    scene_order = sorted(candidates_by_scene, key=lambda scene_id: candidate_key(candidates_by_scene[scene_id][0]))
    selected = []
    while len(selected) < max_anchors:
        added = False
        for scene_id in scene_order:
            scene_candidates = candidates_by_scene[scene_id]
            while scene_candidates:
                candidate = scene_candidates.pop(0)
                if not candidate["cameras"]:
                    continue
                if all(distance_m(candidate["anchor"]["position"], existing["anchor"]["position"]) >= separation_m for existing in selected):
                    selected.append(candidate)
                    added = True
                    break
            if len(selected) >= max_anchors:
                break
        if not added:
            break
    jobs = []
    for anchor_index, candidate in enumerate(selected, 1):
        for camera_id in candidate["cameras"]:
            dated_frames = []
            for row in candidate["dates"]:
                frame = next((frame for frame in row["sample"].get("frames") or [] if str(frame.get("camera_id")) == camera_id), None)
                if frame and (frames_root is None or frame_available(frames_root, frame)):
                    dated_frames.append({**row, "frame": frame})
            if len(dated_frames) >= 3:
                jobs.append({
                    "anchor_index": anchor_index,
                    "anchor": candidate["anchor"],
                    "inspection": candidate["inspection"],
                    "scene": candidate["scene"],
                    "camera_id": camera_id,
                    "dates": dated_frames,
                })
    return round_robin_jobs_by_scene(jobs), latest_date


def frame_path(frames_root, frame):
    root = Path(frames_root).resolve()
    target = (root / str(frame.get("image_path") or "").lstrip("/")).resolve()
    if target != root and root not in target.parents:
        raise RuntimeError("tree_asset_frame_path_outside_root")
    if not target.is_file():
        raise RuntimeError(f"tree_asset_frame_missing:{target}")
    return target


def frame_available(frames_root, frame):
    try:
        frame_path(frames_root, frame)
        return True
    except RuntimeError:
        return False


def encode_image(path, max_side, quality):
    image = Image.open(path).convert("RGB")
    scale = min(1.0, max_side / max(image.size))
    if scale < 1:
        image = image.resize((round(image.width * scale), round(image.height * scale)), Image.Resampling.LANCZOS)
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=quality, optimize=True)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def call_model(job, args):
    content = [{"type": "text", "text": PROMPT}]
    for row in job["dates"]:
        image_path = frame_path(args.frames_root, row["frame"])
        content.append({"type": "text", "text": f"日期 {row['date']}，相机 {job['camera_id']}"})
        content.append({
            "type": "image_url",
            "image_url": {"url": f"data:image/jpeg;base64,{encode_image(image_path, args.image_max_side, args.image_quality)}"},
        })
    payload = {
        "model": args.model,
        "messages": [{"role": "user", "content": content}],
        "temperature": 0,
        "max_tokens": args.max_tokens,
        "stream": False,
        "response_format": {"type": "json_object"},
        "chat_template_kwargs": {"enable_thinking": False},
    }
    request = urllib.request.Request(
        args.service_url,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={"content-type": "application/json", "accept": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=args.timeout_s) as response:
        result = json.loads(response.read().decode("utf-8"))
    message = (result.get("choices") or [{}])[0].get("message") or {}
    raw = str(message.get("content") or message.get("reasoning") or "").strip()
    match = re.search(r"\{.*\}", raw, re.S)
    if not match:
        raise RuntimeError("tree_asset_model_json_missing")
    return json.loads(match.group(0)), raw


def normalize_point(value):
    if not isinstance(value, list) or len(value) != 2:
        return None
    try:
        point = [float(value[0]), float(value[1])]
    except (TypeError, ValueError):
        return None
    if not all(0 <= coordinate <= 1000 for coordinate in point):
        return None
    return [round(coordinate, 2) for coordinate in point]


def normalize_box(value):
    if not isinstance(value, list) or len(value) != 4:
        return None
    try:
        box = [float(item) for item in value]
    except (TypeError, ValueError):
        return None
    if not all(0 <= coordinate <= 1000 for coordinate in box) or box[2] <= box[0] or box[3] <= box[1]:
        return None
    return [round(coordinate, 2) for coordinate in box]


def normalize_tracks(payload, allowed_dates):
    tracks = []
    for index, raw in enumerate(payload.get("tracks") or []):
        if not isinstance(raw, dict):
            continue
        observations = []
        seen_dates = set()
        for item in raw.get("observations") or []:
            date = str(item.get("date") or "")
            box = normalize_box(item.get("bbox"))
            root = normalize_point(item.get("root"))
            if date not in allowed_dates or date in seen_dates or box is None or root is None:
                continue
            seen_dates.add(date)
            observations.append({
                "date": date,
                "bbox_1000": box,
                "root_1000": root,
                "visibility": str(item.get("visibility") or "partial")[:16],
                "evidence": str(item.get("evidence") or "")[:300],
            })
        observations.sort(key=lambda item: item["date"], reverse=True)
        tracks.append({
            "track_id": str(raw.get("track_id") or f"T{index + 1:03d}")[:32],
            "asset_kind": str(raw.get("asset_kind") or "uncertain")[:32],
            "confidence": str(raw.get("confidence") or "low")[:16],
            "signature": str(raw.get("signature") or "")[:500],
            "observations": observations,
        })
    return tracks


def has_visible_tree_roots(observations):
    if not observations:
        return False
    for observation in observations:
        box = observation.get("bbox_1000") or []
        root = observation.get("root_1000") or []
        if observation.get("visibility") != "full" or len(box) != 4 or len(root) != 2:
            return False
        if not (box[0] <= root[0] <= box[2] and box[1] <= root[1] <= box[3]):
            return False
    return True


def prune_invalid_unreviewed_assets(state):
    removed = []
    for identifier, asset in list((state.get("assets") or {}).items()):
        if asset.get("review_status") == "confirmed":
            continue
        if has_visible_tree_roots(asset.get("observations") or []):
            continue
        removed.append(identifier)
        state["assets"].pop(identifier, None)
        state.setdefault("rejected_tracks", []).append({
            "job_key": asset.get("build_key"),
            "track_id": identifier,
            "asset_kind": asset.get("asset_kind"),
            "confidence": asset.get("confidence"),
            "signature": asset.get("signature"),
            "geometry": {"passed": False, "reason": "tree_root_not_visible_inside_bbox"},
            "rejected_at": now_iso(),
        })
    state["rejected_tracks"] = (state.get("rejected_tracks") or [])[-500:]
    return removed


def resize_for_features(image, max_side=1280):
    height, width = image.shape[:2]
    scale = min(1.0, max_side / max(height, width))
    if scale >= 1:
        return image
    return cv2.resize(image, (round(width * scale), round(height * scale)), interpolation=cv2.INTER_AREA)


def homography_metrics(reference, candidate):
    left = resize_for_features(reference)
    right = resize_for_features(candidate)
    sift = cv2.SIFT_create(nfeatures=3500, contrastThreshold=0.02)
    left_keys, left_desc = sift.detectAndCompute(cv2.cvtColor(left, cv2.COLOR_BGR2GRAY), None)
    right_keys, right_desc = sift.detectAndCompute(cv2.cvtColor(right, cv2.COLOR_BGR2GRAY), None)
    if left_desc is None or right_desc is None:
        return None
    pairs = cv2.BFMatcher(cv2.NORM_L2).knnMatch(left_desc, right_desc, k=2)
    good = [first for first, second in pairs if first.distance < 0.72 * second.distance]
    if len(good) < 8:
        return None
    source = np.float32([left_keys[item.queryIdx].pt for item in good]).reshape(-1, 1, 2)
    target = np.float32([right_keys[item.trainIdx].pt for item in good]).reshape(-1, 1, 2)
    matrix, mask = cv2.findHomography(source, target, cv2.RANSAC, 4.0)
    if matrix is None or mask is None:
        return None
    return {
        "matrix": matrix,
        "reference_shape": left.shape,
        "candidate_shape": right.shape,
        "good_matches": len(good),
        "inliers": int(mask.sum()),
        "inlier_ratio": float(mask.sum()) / max(1, len(good)),
    }


def pixel_point(normalized, shape):
    height, width = shape[:2]
    return np.array([normalized[0] * width / 1000, normalized[1] * height / 1000], dtype=np.float32)


def validate_track_geometry(track, job, args):
    rows_by_date = {row["date"]: row for row in job["dates"]}
    observations = sorted(
        (item for item in track["observations"] if item["date"] in rows_by_date),
        key=lambda item: item["date"],
        reverse=True,
    )
    if len(observations) < args.min_days:
        return {"passed": False, "reason": "insufficient_days", "dates": len(observations)}
    images = {}

    def image_for(observation):
        date = observation["date"]
        if date not in images:
            images[date] = cv2.imread(
                str(frame_path(args.frames_root, rows_by_date[date]["frame"])),
                cv2.IMREAD_COLOR,
            )
        return images[date]

    pairs = []
    for reference, observation in zip(observations, observations[1:]):
        reference_image = image_for(reference)
        candidate_image = image_for(observation)
        if reference_image is None:
            pairs.append({
                "reference_date": reference["date"],
                "date": observation["date"],
                "passed": False,
                "reason": "reference_image_unreadable",
            })
            continue
        if candidate_image is None:
            pairs.append({
                "reference_date": reference["date"],
                "date": observation["date"],
                "passed": False,
                "reason": "candidate_image_unreadable",
            })
            continue
        metrics = homography_metrics(reference_image, candidate_image)
        if metrics is None:
            pairs.append({
                "reference_date": reference["date"],
                "date": observation["date"],
                "passed": False,
                "reason": "homography_unavailable",
            })
            continue
        source = pixel_point(reference["root_1000"], metrics["reference_shape"]).reshape(1, 1, 2)
        projected = cv2.perspectiveTransform(source, metrics["matrix"]).reshape(2)
        target = pixel_point(observation["root_1000"], metrics["candidate_shape"])
        error_pixels = float(np.linalg.norm(projected - target))
        diagonal = float(np.linalg.norm([metrics["candidate_shape"][1], metrics["candidate_shape"][0]]))
        error_normalized = error_pixels / max(1, diagonal) * 1000
        passed = (
            metrics["inliers"] >= args.min_inliers and
            metrics["inlier_ratio"] >= args.min_inlier_ratio and
            error_normalized <= args.max_root_error
        )
        pairs.append({
            "reference_date": reference["date"],
            "date": observation["date"],
            "passed": passed,
            "good_matches": metrics["good_matches"],
            "inliers": metrics["inliers"],
            "inlier_ratio": round(metrics["inlier_ratio"], 4),
            "root_error_normalized": round(error_normalized, 2),
        })
    return {
        "passed": len(pairs) >= args.min_days - 1 and all(item.get("passed") for item in pairs),
        "reason": "geometry_passed" if pairs and all(item.get("passed") for item in pairs) else "geometry_failed",
        "dates": len(observations),
        "pairs": pairs,
    }


def job_key(job):
    value = "|".join([str(job["anchor"].get("vehicle_id") or ""), job["camera_id"], *[str(row["sample"].get("sample_id") or "") for row in job["dates"]]])
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def public_image_url(frame):
    value = str(frame.get("image_url") or "")
    return value.replace("/api/park-pcm/crowd/files/", "/api/park-pcm/crowd/redacted-files/")


def find_existing_asset(state, job, reference_root):
    anchor = job["anchor"]
    for asset in state.get("assets", {}).values():
        if asset.get("vehicle_id") != anchor.get("vehicle_id") or asset.get("camera_id") != job["camera_id"]:
            continue
        if distance_m(anchor["position"], asset.get("observation_station") or {}) > 3:
            continue
        if angle_difference(anchor["position"].get("heading"), asset.get("observation_heading")) > math.radians(10):
            continue
        existing_root = asset.get("canonical_root_1000") or []
        if len(existing_root) == 2 and math.dist(reference_root, existing_root) <= 50:
            return asset
    return None


def asset_id(job, root):
    anchor = job["anchor"]
    position = anchor["position"]
    raw = "|".join([
        str(anchor.get("vehicle_id") or ""),
        job["camera_id"],
        f"{float(position['gaode_latitude']):.5f}",
        f"{float(position['gaode_longitude']):.5f}",
        str(round(float(position.get("heading") or 0) / math.radians(5))),
        str(round(root[0] / 20)),
        str(round(root[1] / 20)),
    ])
    digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:10].upper()
    vehicle = re.sub(r"[^A-Za-z0-9]", "", str(anchor.get("vehicle_id") or "TREE"))[-4:]
    return f"TREE-{vehicle}-{digest}"


def build_asset(track, geometry, job, state, inspections_by_sample, model, build_key):
    rows_by_date = {row["date"]: row for row in job["dates"]}
    reference = track["observations"][0]
    existing = find_existing_asset(state, job, reference["root_1000"])
    identifier = existing.get("asset_id") if existing else asset_id(job, reference["root_1000"])
    observations = []
    geometry_by_date = {item["date"]: item for item in geometry.get("pairs") or []}
    for observation in track["observations"]:
        row = rows_by_date.get(observation["date"])
        if not row:
            continue
        sample = row["sample"]
        inspection = inspections_by_sample.get(str(sample.get("sample_id"))) or {}
        observation_geometry = geometry_by_date.get(observation["date"])
        step_reference_date = observation_geometry.get("reference_date") if observation_geometry else None
        step_reference = rows_by_date.get(step_reference_date, {}).get("sample") if step_reference_date else None
        step_distance = distance_m(step_reference["position"], sample["position"]) if step_reference else 0.0
        step_heading_delta = angle_difference(
            step_reference["position"].get("heading"),
            sample["position"].get("heading"),
        ) if step_reference else 0.0
        observations.append({
            "observation_id": hashlib.sha1(f"{identifier}|{sample.get('sample_id')}|{job['camera_id']}".encode("utf-8")).hexdigest()[:16],
            "sample_id": sample.get("sample_id"),
            "date": observation["date"],
            "collected_at": sample.get("collected_at"),
            "camera_id": job["camera_id"],
            "image_url": public_image_url(row["frame"]),
            "observation_station": {
                "gaode_latitude": sample["position"].get("gaode_latitude"),
                "gaode_longitude": sample["position"].get("gaode_longitude"),
            },
            "observation_heading": sample["position"].get("heading"),
            "step_reference_date": step_reference_date,
            "step_distance_m": round(step_distance, 3),
            "step_heading_delta_rad": round(step_heading_delta, 6),
            "anchor_distance_m": round(float(row.get("anchor_distance_m") or 0), 3),
            "bbox_1000": observation["bbox_1000"],
            "root_1000": observation["root_1000"],
            "visibility": observation["visibility"],
            "evidence": observation["evidence"],
            "geometry": observation_geometry or {"reference": True},
            "context_health_score": inspection.get("health_score"),
            "context_health_grade": inspection.get("health_grade"),
            "context_health_scope": "capture_node",
        })
    if existing:
        by_observation = {item["observation_id"]: item for item in existing.get("observations") or []}
        by_observation.update({item["observation_id"]: item for item in observations})
        observations = list(by_observation.values())
    observations.sort(key=lambda item: str(item.get("collected_at") or ""), reverse=True)
    dates = sorted({item["date"] for item in observations})
    position = job["anchor"]["position"]
    return {
        "schema": SCHEMA,
        "asset_id": identifier,
        "vehicle_id": job["anchor"].get("vehicle_id"),
        "asset_kind": "individual_tree",
        "identity_scope": "same_camera_view_track_v1",
        "global_identity_confirmed": False,
        "status": "auto_matched",
        "review_status": existing.get("review_status", "unreviewed") if existing else "unreviewed",
        "confidence": track["confidence"],
        "signature": track["signature"],
        "camera_id": job["camera_id"],
        "observation_station": {
            "gaode_latitude": position.get("gaode_latitude"),
            "gaode_longitude": position.get("gaode_longitude"),
        },
        "observation_heading": position.get("heading"),
        "position_source": "vehicle_observation_station",
        "scene_id": job["scene"]["scene_id"],
        "scene_label": job["scene"]["scene_label"],
        "scene_grid": job["scene"],
        "position_chain": [{
            "date": row["date"],
            "sample_id": row["sample"].get("sample_id"),
            "reference_date": row.get("reference_date"),
            "observation_station": {
                "gaode_latitude": row["sample"]["position"].get("gaode_latitude"),
                "gaode_longitude": row["sample"]["position"].get("gaode_longitude"),
            },
            "observation_heading": row["sample"]["position"].get("heading"),
            "step_distance_m": round(float(row.get("step_distance_m") or 0), 3),
            "step_heading_delta_rad": round(float(row.get("step_heading_delta_rad") or 0), 6),
            "anchor_distance_m": round(float(row.get("anchor_distance_m") or 0), 3),
        } for row in job["dates"]],
        "canonical_root_1000": reference["root_1000"],
        "first_seen": min((item["collected_at"] for item in observations if item.get("collected_at")), default=None),
        "last_seen": max((item["collected_at"] for item in observations if item.get("collected_at")), default=None),
        "observation_count": len(observations),
        "day_count": len(dates),
        "dates": dates,
        "observations": observations,
        "geometry_validation": geometry,
        "model": model,
        "build_key": build_key,
        "updated_at": now_iso(),
        "created_at": existing.get("created_at", now_iso()) if existing else now_iso(),
    }


def empty_state():
    return {
        "schema": SCHEMA,
        "updated_at": None,
        "assets": {},
        "processed_jobs": {},
        "rejected_tracks": [],
        "builds": [],
    }


def backfill_scene_metadata(state, cell_size_m=25.0):
    updated = []
    for asset in (state.get("assets") or {}).values():
        if asset.get("scene_id"):
            continue
        position = asset.get("observation_station") or {}
        if not asset.get("vehicle_id") or not position.get("gaode_latitude") or not position.get("gaode_longitude"):
            continue
        scene = scene_metadata(asset["vehicle_id"], position, cell_size_m)
        asset["scene_id"] = scene["scene_id"]
        asset["scene_label"] = scene["scene_label"]
        asset["scene_grid"] = scene
        updated.append(asset.get("asset_id"))
    return updated


def summarize(state):
    assets = list(state.get("assets", {}).values())
    return {
        "asset_count": len(assets),
        "auto_matched_count": sum(item.get("status") in {"auto_matched", "auto_confirmed"} for item in assets),
        "human_confirmed_count": sum(item.get("review_status") == "confirmed" for item in assets),
        "needs_review_count": sum(item.get("review_status") == "unreviewed" for item in assets),
        "observation_count": sum(int(item.get("observation_count") or 0) for item in assets),
        "multi_day_count": sum(int(item.get("day_count") or 0) >= 2 for item in assets),
        "vehicle_count": len({item.get("vehicle_id") for item in assets if item.get("vehicle_id")}),
        "scene_count": len({item.get("scene_id") for item in assets if item.get("scene_id")}),
    }


def run(args):
    samples = load_vehicle_samples(args.sample_log, args.vehicle)
    inspection_state = read_json(args.inspection_state, {"samples": {}})
    inspections = [item for item in (inspection_state.get("samples") or {}).values() if str(item.get("vehicle_id") or "") == args.vehicle]
    inspections_by_sample = {str(item.get("sample_id")): item for item in inspections}
    jobs, latest_date = select_jobs(
        samples,
        inspections,
        args.max_anchors,
        args.anchor_separation_m,
        args.position_gate_m,
        args.heading_gate_deg,
        args.history_days,
        args.scene_cell_size_m,
        args.frames_root,
    )
    state = read_json(args.state_path, empty_state())
    if state.get("schema") != SCHEMA:
        state = empty_state()
    backfilled_scene_ids = backfill_scene_metadata(state, args.scene_cell_size_m)
    pruned_asset_ids = prune_invalid_unreviewed_assets(state)
    pending_jobs = [job for job in jobs if args.force or job_key(job) not in state.get("processed_jobs", {})]
    pending = pending_jobs[:args.max_jobs]
    build = {
        "build_id": f"tree-assets-{int(time.time())}",
        "vehicle_id": args.vehicle,
        "latest_date": latest_date,
        "started_at": now_iso(),
        "candidate_job_count": len(jobs),
        "pending_job_count": len(pending_jobs),
        "selected_job_count": len(pending),
        "pruned_asset_count": len(pruned_asset_ids),
        "pruned_asset_ids": pruned_asset_ids,
        "backfilled_scene_count": len(backfilled_scene_ids),
        "jobs": [],
    }
    for index, job in enumerate(pending, 1):
        key = job_key(job)
        started = time.time()
        record = {"job_key": key, "camera_id": job["camera_id"], "sample_id": job["anchor"].get("sample_id"), "status": "running"}
        try:
            parsed, _ = call_model(job, args)
            tracks = normalize_tracks(parsed, {row["date"] for row in job["dates"]})
            accepted = 0
            rejected = 0
            for track in tracks:
                geometry = validate_track_geometry(track, job, args)
                eligible = (
                    track["asset_kind"] == "individual_tree" and
                    track["confidence"] == "high" and
                    len(track["observations"]) >= args.min_days and
                    has_visible_tree_roots(track["observations"]) and
                    geometry.get("passed") is True
                )
                if eligible:
                    asset = build_asset(track, geometry, job, state, inspections_by_sample, args.model, key)
                    state["assets"][asset["asset_id"]] = asset
                    accepted += 1
                else:
                    state["rejected_tracks"].append({
                        "job_key": key,
                        "track_id": track["track_id"],
                        "asset_kind": track["asset_kind"],
                        "confidence": track["confidence"],
                        "signature": track["signature"],
                        "geometry": geometry,
                        "rejected_at": now_iso(),
                    })
                    rejected += 1
            state["rejected_tracks"] = state["rejected_tracks"][-500:]
            record.update({"status": "done", "model_tracks": len(tracks), "accepted_assets": accepted, "rejected_tracks": rejected})
        except Exception as error:
            record.update({"status": "error", "error": f"{type(error).__name__}:{error}"[:500]})
        record["duration_ms"] = int((time.time() - started) * 1000)
        record["completed_at"] = now_iso()
        if record["status"] == "done":
            state["processed_jobs"][key] = record
        build["jobs"].append(record)
        print(f"[{index}/{len(pending)}] {record['camera_id']} {record['status']} accepted={record.get('accepted_assets', 0)}", flush=True)
    build["completed_at"] = now_iso()
    build["summary"] = summarize(state)
    state["updated_at"] = now_iso()
    state["last_build"] = build
    state["builds"] = [*(state.get("builds") or []), build][-50:]
    state["summary"] = summarize(state)
    write_json_atomic(args.state_path, state)
    return build


def eligible_vehicle_ids(inspection_state):
    return sorted({
        str(item.get("vehicle_id") or "").strip()
        for item in (inspection_state.get("samples") or {}).values()
        if item.get("vegetation_types", {}).get("trees") is True and str(item.get("vehicle_id") or "").strip()
    })


def run_requested(args):
    if str(args.vehicle).lower() != "all":
        return run(args)
    inspection_state = read_json(args.inspection_state, {"samples": {}})
    vehicles = eligible_vehicle_ids(inspection_state)
    started_at = now_iso()
    builds = []
    for index, vehicle_id in enumerate(vehicles, 1):
        print(f"[fleet {index}/{len(vehicles)}] {vehicle_id}", flush=True)
        vehicle_args = argparse.Namespace(**{**vars(args), "vehicle": vehicle_id})
        builds.append(run(vehicle_args))
    state = read_json(args.state_path, empty_state())
    return {
        "build_id": f"tree-assets-fleet-{int(time.time())}",
        "vehicle_id": "all",
        "started_at": started_at,
        "completed_at": now_iso(),
        "vehicle_count": len(vehicles),
        "vehicles": vehicles,
        "candidate_job_count": sum(int(item.get("candidate_job_count") or 0) for item in builds),
        "pending_job_count": sum(int(item.get("pending_job_count") or 0) for item in builds),
        "selected_job_count": sum(int(item.get("selected_job_count") or 0) for item in builds),
        "processed_job_count": sum(len(item.get("jobs") or []) for item in builds),
        "vehicle_builds": builds,
        "summary": summarize(state),
    }


def parse_args(argv=None):
    root = Path("/home/admin1/jgzj")
    runtime = root / ".runtime/park-pcm"
    parser = argparse.ArgumentParser()
    parser.add_argument("--vehicle", default="BIT-0042")
    parser.add_argument("--sample-log", type=Path, default=runtime / "crowd-samples.jsonl")
    parser.add_argument("--inspection-state", type=Path, default=runtime / "green-inspection-state.json")
    parser.add_argument("--frames-root", type=Path, default=runtime / "crowd-frames")
    parser.add_argument("--state-path", type=Path, default=runtime / "green-tree-assets-state.json")
    parser.add_argument("--worker-state-path", type=Path, default=runtime / "green-tree-asset-worker-state.json")
    parser.add_argument("--lock-path", type=Path, default=runtime / "green-tree-assets.lock")
    parser.add_argument("--service-url", default="http://127.0.0.1:18001/v1/chat/completions")
    parser.add_argument("--model", default="Qwen3.6-27B-MM")
    parser.add_argument("--max-anchors", type=int, default=32)
    parser.add_argument("--max-jobs", type=int, default=40)
    parser.add_argument("--anchor-separation-m", type=float, default=2.0)
    parser.add_argument("--scene-cell-size-m", type=float, default=25.0)
    parser.add_argument("--position-gate-m", type=float, default=5.0)
    parser.add_argument("--heading-gate-deg", type=float, default=10.0)
    parser.add_argument("--history-days", type=int, default=8)
    parser.add_argument("--min-days", type=int, default=3)
    parser.add_argument("--min-inliers", type=int, default=50)
    parser.add_argument("--min-inlier-ratio", type=float, default=0.15)
    parser.add_argument("--max-root-error", type=float, default=20.0)
    parser.add_argument("--image-max-side", type=int, default=960)
    parser.add_argument("--image-quality", type=int, default=84)
    parser.add_argument("--max-tokens", type=int, default=1800)
    parser.add_argument("--timeout-s", type=int, default=240)
    parser.add_argument("--force", action="store_true")
    return parser.parse_args(argv)


def main():
    args = parse_args()
    args.lock_path.parent.mkdir(parents=True, exist_ok=True)
    with args.lock_path.open("a+", encoding="utf-8") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({"ok": False, "error": "tree_asset_worker_already_running"}, ensure_ascii=False))
            return 2
        write_json_atomic(args.worker_state_path, {
            "schema": WORKER_SCHEMA,
            "running": True,
            "vehicle_id": args.vehicle,
            "started_at": now_iso(),
            "pid": os.getpid(),
        })
        try:
            build = run_requested(args)
            write_json_atomic(args.worker_state_path, {
                "schema": WORKER_SCHEMA,
                "running": False,
                "vehicle_id": args.vehicle,
                "completed_at": now_iso(),
                "last_result": build,
            })
            print(json.dumps({"ok": True, "build": build}, ensure_ascii=False, indent=2))
            return 0
        except BaseException as error:
            write_json_atomic(args.worker_state_path, {
                "schema": WORKER_SCHEMA,
                "running": False,
                "vehicle_id": args.vehicle,
                "aborted_at" if isinstance(error, KeyboardInterrupt) else "failed_at": now_iso(),
                "error": f"{type(error).__name__}:{error}"[:500],
            })
            if isinstance(error, KeyboardInterrupt):
                return 130
            raise


if __name__ == "__main__":
    raise SystemExit(main())
