#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import struct
import subprocess
import tarfile
import tempfile
import time
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image

try:
    import cv2
except Exception:  # pragma: no cover
    cv2 = None


PREPARE_STEPS = [
    ("extract", "解包图像-位姿包"),
    ("images", "去畸变并写入图像/位姿"),
    ("pointcloud", "转换点云地图"),
    ("colorize", "点云投影上色与可见性过滤"),
    ("write", "写入 COLMAP sparse 数据"),
]


def parse_bool(value: object, default: bool = True) -> bool:
    if value is None:
        return default
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    return default


def progress_path(output: Path) -> Path:
    return output / "three_dgs_prepare_progress.json"


def write_progress(output: Path, stage: str, progress_pct: float, detail: str = "") -> None:
    step_keys = [key for key, _label in PREPARE_STEPS]
    clamped_pct = max(0.0, min(100.0, float(progress_pct)))
    try:
        current_index = step_keys.index(stage)
    except ValueError:
        current_index = len(PREPARE_STEPS) - 1
    payload = {
        "stage": stage,
        "stage_label": dict(PREPARE_STEPS).get(stage, stage),
        "progress_pct": round(clamped_pct, 2),
        "detail": detail,
        "updated_at_ms": int(time.time() * 1000),
        "steps": [
            {
                "key": key,
                "label": label,
                "status": "done"
                if clamped_pct >= 100 or index < current_index
                else "active"
                if index == current_index
                else "pending",
            }
            for index, (key, label) in enumerate(PREPARE_STEPS)
        ],
    }
    output.mkdir(parents=True, exist_ok=True)
    target = progress_path(output)
    temp = target.with_suffix(".json.tmp")
    with temp.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    temp.replace(target)
    print(f"[prepare] {payload['progress_pct']:.1f}% {payload['stage_label']} {detail}".rstrip(), flush=True)


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def load_jsonl(path: Path) -> list[dict]:
    records: list[dict] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            records.append(json.loads(line))
    return records


def find_map_visual_root(root: Path) -> Path | None:
    candidates: list[Path] = []
    direct = root / "trajectories" / "camera_poses.jsonl"
    if direct.is_file() and (root / "image_capture" / "image_keyframes.jsonl").is_file():
        candidates.append(root)
    for pose_path in root.rglob("camera_poses.jsonl"):
        if pose_path.parent.name != "trajectories":
            continue
        candidate = pose_path.parent.parent
        if (candidate / "image_capture" / "image_keyframes.jsonl").is_file():
            candidates.append(candidate)
    if not candidates:
        return None
    return min(set(candidates), key=lambda item: (len(item.relative_to(root).parts), str(item)))


def parse_fast_livo_calibration(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    values: dict[str, str] = {}
    for line in text.splitlines():
        match = re.match(r"^\s*([A-Za-z][A-Za-z0-9_]*):\s*([^#\s]+)", line)
        if match:
            values[match.group(1)] = match.group(2)

    required = ("cam_model", "cam_width", "cam_height", "cam_fx", "cam_fy", "cam_cx", "cam_cy")
    missing = [key for key in required if key not in values]
    if missing:
        raise ValueError(f"calibration {path} missing fields: {', '.join(missing)}")

    distortion = []
    for index in range(8):
        key = f"cam_d{index}"
        if key not in values:
            break
        distortion.append(float(values[key]))
    return {
        "camera_model": values["cam_model"],
        "distortion_model": values.get("distortion_model", "plumb_bob"),
        "width": int(values["cam_width"]),
        "height": int(values["cam_height"]),
        "fx": float(values["cam_fx"]),
        "fy": float(values["cam_fy"]),
        "cx": float(values["cam_cx"]),
        "cy": float(values["cam_cy"]),
        "D": distortion,
        "calibration_path": str(path),
    }


def load_map_visual_records(map_root: Path) -> tuple[dict, list[dict]]:
    image_root = map_root / "image_capture"
    pose_path = map_root / "trajectories" / "camera_poses.jsonl"
    capture_path = image_root / "image_keyframes.jsonl"
    calibration_dir = image_root / "calibration"
    trajectory_manifest_path = map_root / "trajectories" / "manifest.json"
    trajectory_manifest = (
        load_json(trajectory_manifest_path) if trajectory_manifest_path.is_file() else {}
    )

    calibration: dict[str, dict] = {}
    for path in sorted(calibration_dir.glob("camera*.txt")):
        calibration[path.stem] = parse_fast_livo_calibration(path)
    if not calibration:
        raise ValueError(f"map_visual package has no camera calibration under {calibration_dir}")
    required_cameras = {"camera1", "camera2", "camera3", "camera4"}
    if set(calibration) != required_cameras:
        raise ValueError(f"map_visual calibration must contain exactly {sorted(required_cameras)}")

    capture_groups = load_jsonl(capture_path)
    pose_groups = load_jsonl(pose_path)
    capture_by_id: dict[int, dict] = {}
    for group in capture_groups:
        group_id = int(group["image_keyframe_id"])
        if group_id in capture_by_id:
            raise ValueError(f"duplicate image_keyframe_id in capture metadata: {group_id}")
        capture_by_id[group_id] = group

    expected_cameras = set(calibration)
    flattened_by_camera: dict[str, list[dict]] = {name: [] for name in sorted(calibration)}
    seen_group_ids: set[int] = set()
    offset_values: set[int] = set()
    calibrated_values: set[bool] = set()
    for pose_group in pose_groups:
        if pose_group.get("schema") != "auto_ad_mapping_final_camera_poses.v1":
            raise ValueError(f"unsupported map_visual pose schema: {pose_group.get('schema')}")
        group_id = int(pose_group["image_keyframe_id"])
        if group_id in seen_group_ids:
            raise ValueError(f"duplicate image_keyframe_id in final camera poses: {group_id}")
        seen_group_ids.add(group_id)
        capture_group = capture_by_id.get(group_id)
        if capture_group is None:
            raise ValueError(f"final camera pose group {group_id} has no capture metadata")

        pose_cameras = pose_group.get("cameras")
        capture_cameras = capture_group.get("cameras")
        if not isinstance(pose_cameras, dict) or set(pose_cameras) != expected_cameras:
            raise ValueError(f"final camera pose group {group_id} does not contain exactly {sorted(expected_cameras)}")
        if not isinstance(capture_cameras, dict) or set(capture_cameras) != expected_cameras:
            raise ValueError(f"capture group {group_id} does not contain exactly {sorted(expected_cameras)}")

        group_timestamp_ns = int(pose_group["image_timestamp_ns"])
        if int(capture_group["image_timestamp_ns"]) != group_timestamp_ns:
            raise ValueError(f"timestamp mismatch for image group {group_id}")
        camera_time_offset_ns = int(
            pose_group.get(
                "camera_time_offset_ns",
                trajectory_manifest.get("camera_time_offset_ns", 0),
            )
        )
        camera_time_offset_calibrated = parse_bool(
            pose_group.get(
                "camera_time_offset_calibrated",
                trajectory_manifest.get("camera_time_offset_calibrated", False),
            ),
            False,
        )
        trajectory_query_timestamp_ns = int(
            pose_group.get("trajectory_query_timestamp_ns", group_timestamp_ns)
        )
        if trajectory_query_timestamp_ns != group_timestamp_ns + camera_time_offset_ns:
            raise ValueError(
                f"trajectory query timestamp does not equal image timestamp plus offset "
                f"for image group {group_id}"
            )
        offset_values.add(camera_time_offset_ns)
        calibrated_values.add(camera_time_offset_calibrated)

        for camera_name in sorted(expected_cameras):
            pose_camera = pose_cameras[camera_name]
            capture_camera = capture_cameras[camera_name]
            image_path = str(pose_camera.get("image_path") or capture_camera.get("relative_path") or "")
            capture_image_path = str(capture_camera.get("relative_path") or "")
            if not image_path or image_path != capture_image_path:
                raise ValueError(f"image path mismatch for group {group_id} {camera_name}")
            if int(capture_camera["timestamp_ns"]) != group_timestamp_ns:
                raise ValueError(f"camera timestamp mismatch for group {group_id} {camera_name}")
            if matrix_from_value(pose_camera.get("T_camera_map")) is None:
                raise ValueError(f"missing T_camera_map for group {group_id} {camera_name}")
            if matrix_from_value(pose_camera.get("T_map_camera")) is None:
                raise ValueError(f"missing T_map_camera for group {group_id} {camera_name}")

            calib = calibration[camera_name]
            flattened_by_camera[camera_name].append(
                {
                    "schema": pose_group["schema"],
                    "camera_id": camera_name,
                    "camera_name": camera_name,
                    "image_keyframe_id": group_id,
                    "image_path": image_path,
                    "image_timestamp_ns": group_timestamp_ns,
                    "pose_timestamp_ns": group_timestamp_ns,
                    "trajectory_query_timestamp_ns": trajectory_query_timestamp_ns,
                    "camera_time_offset_ns": camera_time_offset_ns,
                    "camera_time_offset_calibrated": camera_time_offset_calibrated,
                    "trajectory_method": pose_group.get("trajectory_method"),
                    "T_camera_map": pose_camera["T_camera_map"],
                    "T_map_camera": pose_camera["T_map_camera"],
                    "pose_source": "map_visual_final_pgo_continuous_spline",
                    "camera_model": calib["camera_model"],
                    "distortion_model": calib["distortion_model"],
                    "width": calib["width"],
                    "height": calib["height"],
                    "fx": calib["fx"],
                    "fy": calib["fy"],
                    "cx": calib["cx"],
                    "cy": calib["cy"],
                    "D": calib["D"],
                    "__map_visual_final_pose": True,
                    "__record_root": str(image_root),
                }
            )

    missing = sorted(set(capture_by_id) - seen_group_ids)
    unexpected = sorted(seen_group_ids - set(capture_by_id))
    if unexpected:
        raise ValueError(f"final camera poses contain unknown capture groups: {unexpected[:10]}")
    if missing:
        counts = trajectory_manifest.get("counts")
        rejected = (
            int(counts.get("rejected_outside_trajectory_groups", -1))
            if isinstance(counts, dict)
            else -1
        )
        valid = (
            int(counts.get("valid_camera_pose_groups", -1))
            if isinstance(counts, dict)
            else -1
        )
        if rejected != len(missing) or valid != len(pose_groups):
            raise ValueError(
                f"capture groups missing final camera poses without matching trajectory "
                f"rejection provenance: {missing[:10]}"
            )
    if len(offset_values) != 1 or len(calibrated_values) != 1:
        raise ValueError("map_visual final pose groups use inconsistent camera time offsets")
    camera_time_offset_ns = next(iter(offset_values))
    camera_time_offset_calibrated = next(iter(calibrated_values))
    if trajectory_manifest:
        if int(trajectory_manifest.get("camera_time_offset_ns", 0)) != camera_time_offset_ns:
            raise ValueError("trajectory manifest camera time offset does not match final poses")
        if parse_bool(
            trajectory_manifest.get("camera_time_offset_calibrated", False), False
        ) != camera_time_offset_calibrated:
            raise ValueError("trajectory manifest calibration flag does not match final poses")

    records = [record for camera_name in sorted(flattened_by_camera) for record in flattened_by_camera[camera_name]]
    manifest = {
        "schema": "jgzj.three_dgs.map_visual_adapter.v1",
        "source_schema": "auto_ad_mapping_final_camera_poses.v1",
        "map_visual_root": str(map_root),
        "image_keyframe_groups": len(pose_groups),
        "captured_image_keyframe_groups": len(capture_groups),
        "rejected_image_keyframe_groups": len(missing),
        "rejected_image_keyframe_group_ids": missing,
        "camera_pose_rows": len(records),
        "camera_time_offset_ns": camera_time_offset_ns,
        "camera_time_offset_calibrated": camera_time_offset_calibrated,
        "calibration": calibration,
    }
    for record in records:
        record["__manifest"] = manifest
    return manifest, records


def load_pose_time_offsets(path: str | None) -> dict[str, float]:
    if not path:
        return {}
    data = load_json(Path(path).resolve())
    raw = (
        data.get("camera_offsets_ms")
        or data.get("pose_time_offsets_ms")
        or data.get("camera_time_offsets_ms")
        or data
    )
    if not isinstance(raw, dict):
        raise ValueError("pose time offsets must be a JSON object")
    offsets: dict[str, float] = {}
    for camera_name, value in raw.items():
        if not str(camera_name).startswith("camera"):
            continue
        offsets[str(camera_name)] = float(value) / 1000.0
    return offsets


def validate_pose_time_offsets(records: list[dict], offsets_s: dict[str, float]) -> bool:
    is_map_visual = bool(records and all(record.get("__map_visual_final_pose") for record in records))
    nonzero_offsets = {key: value for key, value in offsets_s.items() if abs(value) > 1e-12}
    if is_map_visual and nonzero_offsets:
        raise ValueError(
            "map_visual records already contain final per-image spline poses; legacy pose time offsets must not be applied"
        )
    return is_map_visual


def extract_archive(source: Path, work_dir: Path) -> Path:
    if source.is_dir():
        return source

    suffixes = "".join(source.suffixes).lower()
    extract_dir = work_dir / "image_pose"
    extract_dir.mkdir(parents=True, exist_ok=True)

    if zipfile.is_zipfile(source):
        with zipfile.ZipFile(source) as archive:
            archive.extractall(extract_dir)
        return extract_dir

    if tarfile.is_tarfile(source):
        with tarfile.open(source, mode="r:*") as archive:
            archive.extractall(extract_dir)
        return extract_dir

    if source.suffix.lower() == ".zip":
        raise zipfile.BadZipFile(f"file has .zip suffix but is not a ZIP archive: {source}")

    if source.suffix.lower() == ".tar" or suffixes.endswith(".tar.gz") or suffixes.endswith(".tgz"):
        raise tarfile.TarError(f"file has tar suffix but is not a TAR archive: {source}")

    if source.suffix.lower() in {".json", ".jsonl"}:
        shutil.copy2(source, extract_dir / source.name)
        return extract_dir

    raise ValueError(f"unsupported image-pose package: {source}")


def find_first(root: Path, names: tuple[str, ...]) -> Path | None:
    for name in names:
        direct = root / name
        if direct.exists():
            return direct
    for item in root.rglob("*"):
        if item.name in names and item.is_file():
            return item
    return None


def find_dataset_root(root: Path) -> Path:
    for name in ("records.jsonl", "metadata.json", "summary.json", "manifest.json"):
        if (root / name).exists():
            return root
    candidates: list[Path] = []
    for item in root.rglob("records.jsonl"):
        parent = item.parent
        if parent.name.startswith("camera"):
            continue
        candidates.append(parent)
    if candidates:
        candidates.sort(key=lambda item: len(item.relative_to(root).parts))
        return candidates[0]
    return root


def load_records(root: Path) -> tuple[dict, list[dict]]:
    map_visual_root = find_map_visual_root(root)
    if map_visual_root is not None:
        return load_map_visual_records(map_visual_root)

    dataset_root = find_dataset_root(root)
    manifest_path = find_first(dataset_root, ("manifest.json", "metadata.json", "summary.json"))
    manifest: dict = {}
    records: list[dict] = []

    if manifest_path:
        manifest = load_json(manifest_path)
        for key in ("records", "frames", "frame_records"):
            value = manifest.get(key)
            if isinstance(value, list):
                records = []
                for item in value:
                    if isinstance(item, dict):
                        next_item = dict(item)
                        next_item["__manifest"] = manifest
                        next_item["__record_root"] = str(manifest_path.parent)
                        records.append(next_item)
                break

    if not records:
        global_records_path = dataset_root / "records.jsonl"
        if global_records_path.exists():
            local_manifest = manifest
            for record in load_jsonl(global_records_path):
                next_item = dict(record)
                next_item["__manifest"] = local_manifest
                next_item["__record_root"] = str(dataset_root)
                records.append(next_item)

    if not records:
        for item in sorted(dataset_root.rglob("frames.jsonl")):
            local_manifest_path = item.parent / "manifest.json"
            local_manifest = load_json(local_manifest_path) if local_manifest_path.exists() else manifest
            camera_hint = item.parent.name if item.parent.name.startswith("camera") else ""
            for record in load_jsonl(item):
                next_item = dict(record)
                next_item["__manifest"] = local_manifest
                next_item["__record_root"] = str(item.parent)
                if camera_hint and not any(next_item.get(key) for key in ("camera", "camera_id", "camera_name")):
                    next_item["camera_id"] = camera_hint
                records.append(next_item)

    if not records:
        for item in sorted(dataset_root.rglob("*.jsonl")):
            if item.name in {"frames.jsonl"}:
                continue
            local_manifest_path = item.parent / "manifest.json"
            local_manifest = load_json(local_manifest_path) if local_manifest_path.exists() else manifest
            for record in load_jsonl(item):
                next_item = dict(record)
                next_item["__manifest"] = local_manifest
                next_item["__record_root"] = str(item.parent)
                records.append(next_item)
            if records:
                break

    if not records:
        raise ValueError("no frame records found; expected manifest.json or frames.jsonl")

    return manifest, records


def load_pose_history(root: Path) -> list[dict]:
    path = find_first(root, ("pose_history.jsonl",))
    if not path:
        return []
    poses = []
    for record in load_jsonl(path):
        timestamp = pose_history_timestamp_s(record)
        matrix = matrix_from_pose_history_record(record)
        if timestamp is None or matrix is None:
            continue
        poses.append({"timestamp_s": timestamp, "T_map_lidar": matrix, "raw": record})
    poses.sort(key=lambda item: item["timestamp_s"])
    return poses


def nested_get(data: object, *keys: str) -> object | None:
    current = data
    for key in keys:
        if not isinstance(current, dict) or key not in current:
            return None
        current = current[key]
    return current


def first_key(sources: list[object], keys: tuple[str, ...]) -> object | None:
    for source in sources:
        if not isinstance(source, dict):
            continue
        for key in keys:
            if key in source and source[key] is not None:
                return source[key]
    return None


def record_manifest(record: dict, fallback: dict) -> dict:
    value = record.get("__manifest")
    return value if isinstance(value, dict) else fallback


def sanitize_component(value: object, fallback: str = "item") -> str:
    text = str(value or fallback).strip()
    cleaned = "".join(ch if ch.isalnum() or ch in ("-", "_") else "_" for ch in text)
    return cleaned.strip("_") or fallback


def scalar_timestamp(value: object) -> str | None:
    if isinstance(value, (int, float, str)):
        text = str(value).strip()
        return text or None
    if not isinstance(value, dict):
        return None
    sec = first_key([value], ("sec", "secs", "seconds", "stamp_sec"))
    nsec = first_key([value], ("nsec", "nsecs", "nanosec", "nanosecs", "nanoseconds", "stamp_nsec"))
    if sec is not None and nsec is not None:
        return f"{sec}_{nsec}"
    for key in ("timestamp", "time", "stamp", "value"):
        nested = value.get(key)
        nested_value = scalar_timestamp(nested)
        if nested_value:
            return nested_value
    return None


def scalar_timestamp_seconds(value: object) -> float | None:
    if isinstance(value, (int, float)):
        number = float(value)
        if math.isfinite(number):
            return number / 1e9 if number > 1e12 else number
        return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            number = float(text)
            if math.isfinite(number):
                return number / 1e9 if number > 1e12 else number
        except ValueError:
            return None
    if not isinstance(value, dict):
        return None
    sec = first_key([value], ("sec", "secs", "seconds", "stamp_sec"))
    nsec = first_key([value], ("nsec", "nsecs", "nanosec", "nanosecs", "nanoseconds", "stamp_nsec"))
    if sec is not None and nsec is not None:
        try:
            return float(sec) + float(nsec) / 1e9
        except (TypeError, ValueError):
            return None
    for key in ("timestamp", "time", "stamp", "value"):
        nested = value.get(key)
        nested_value = scalar_timestamp_seconds(nested)
        if nested_value is not None:
            return nested_value
    return None


def timestamp_ns(value: float | None) -> int | None:
    if value is None or not math.isfinite(float(value)):
        return None
    return int(round(float(value) * 1e9))


def pose_history_timestamp_s(record: dict) -> float | None:
    pose_obj = record.get("pose") if isinstance(record.get("pose"), dict) else {}
    header_obj = record.get("header") if isinstance(record.get("header"), dict) else {}
    raw = first_key(
        [record, pose_obj, header_obj, nested_get(record, "pose", "header"), nested_get(record, "msg", "header")],
        (
            "ts_unix",
            "timestamp_unix",
            "timestamp",
            "timestamp_ns",
            "pose_ts_unix",
            "pose_timestamp_unix",
            "pose_timestamp",
            "pose_timestamp_ns",
            "stamp",
            "time",
        ),
    )
    return scalar_timestamp_seconds(raw)


def record_image_timestamp_s(record: dict) -> float | None:
    image_obj = record.get("image") if isinstance(record.get("image"), dict) else {}
    sources = [
        record,
        image_obj,
        nested_get(record, "image", "header", "stamp"),
        nested_get(record, "image", "stamp"),
    ]
    raw = first_key(
        sources,
        (
            "image_ts_unix",
            "image_timestamp_unix",
            "image_timestamp",
            "image_timestamp_ns",
            "timestamp_ns",
            "ts_unix",
            "stamp",
            "time",
        ),
    )
    return scalar_timestamp_seconds(raw)


def record_pose_timestamp_s(record: dict) -> float | None:
    pose_obj = record.get("pose") if isinstance(record.get("pose"), dict) else {}
    ndt_pose_obj = record.get("ndt_pose") if isinstance(record.get("ndt_pose"), dict) else {}
    matched_pose_obj = record.get("matched_pose") if isinstance(record.get("matched_pose"), dict) else {}
    sources = [
        record,
        pose_obj,
        ndt_pose_obj,
        matched_pose_obj,
        nested_get(record, "pose", "stamp"),
        nested_get(record, "pose", "header", "stamp"),
        nested_get(record, "ndt_pose", "header", "stamp"),
        nested_get(record, "matched_pose", "header", "stamp"),
    ]
    raw = first_key(
        sources,
        (
            "pose_ts_unix",
            "pose_timestamp_unix",
            "pose_timestamp",
            "pose_timestamp_ns",
            "ndt_pose_timestamp",
            "matched_pose_timestamp",
            "ts_unix",
            "stamp",
            "time",
        ),
    )
    return scalar_timestamp_seconds(raw)


def record_pose_delta_ms(record: dict, image_ts_s: float | None, pose_ts_s: float | None) -> float | None:
    pose_obj = record.get("pose") if isinstance(record.get("pose"), dict) else {}
    raw = first_key([record, pose_obj], ("image_pose_delta_ms", "pose_delta_ms", "image_pose_gap_ms"))
    try:
        if raw is not None:
            return float(raw)
    except (TypeError, ValueError):
        pass
    if image_ts_s is not None and pose_ts_s is not None:
        return (image_ts_s - pose_ts_s) * 1000.0
    return None


def record_group_key(record: dict, image_id: int) -> str:
    image_ts_ns = timestamp_ns(record_image_timestamp_s(record))
    if image_ts_ns is not None:
        return f"t{image_ts_ns}"

    image_obj = record.get("image") if isinstance(record.get("image"), dict) else {}
    pose_obj = record.get("pose") if isinstance(record.get("pose"), dict) else {}
    ndt_pose_obj = record.get("ndt_pose") if isinstance(record.get("ndt_pose"), dict) else {}
    matched_pose_obj = record.get("matched_pose") if isinstance(record.get("matched_pose"), dict) else {}
    sources = [
        record,
        image_obj,
        pose_obj,
        ndt_pose_obj,
        matched_pose_obj,
        nested_get(record, "pose", "header", "stamp"),
        nested_get(record, "ndt_pose", "header", "stamp"),
        nested_get(record, "matched_pose", "header", "stamp"),
    ]
    raw = first_key(
        sources,
        (
            "capture_id",
            "capture_key",
            "index",
            "frame_index",
            "image_index",
            "keyframe_id",
            "keyframe_index",
            "group_id",
            "trigger_id",
            "pose_id",
            "pose_timestamp_ns",
            "pose_timestamp",
            "ndt_pose_timestamp",
            "matched_pose_timestamp",
            "pose_stamp",
            "pose_time",
        ),
    )
    timestamp = scalar_timestamp(raw)
    if timestamp:
        return f"k{timestamp}"

    lidar_pose = record.get("T_map_lidar")
    if lidar_pose is not None:
        try:
            flat = np.asarray(lidar_pose, dtype=float).reshape(-1)
            rounded = [round(float(item), 3) for item in flat]
            digest = hashlib.sha1(json.dumps(rounded, separators=(",", ":")).encode("utf-8")).hexdigest()[:12]
            return f"p{digest}"
        except Exception:
            pass

    return f"i{image_id:06d}"


def record_pose_mode(record: dict) -> str:
    if record.get("__map_visual_final_pose"):
        return "map_visual_final_pgo_spline_pose"
    if isinstance(record.get("pose_context"), dict):
        return "vehicle_timestamp_interpolated_pose"
    if any(key in record for key in ("pose_history", "pose_buffer", "ndt_pose_history")):
        return "pose_history_available_not_used"
    if record.get("pose") or record.get("matched_pose") or record.get("ndt_pose"):
        return "vehicle_matched_pose"
    return "vehicle_provided_transform"


def record_pointcloud_context_available(record: dict) -> bool:
    value = record.get("pointcloud_context")
    return isinstance(value, dict) and (value.get("previous") is not None or value.get("following") is not None)


def pose_interpolation_note_for_mode(mode: str) -> str:
    if mode == "map_visual_final_pgo_spline_pose":
        return "Used the final per-image T_camera_map from map_visual: dense frontend cubic/SO(3) motion plus the final-PGO correction spline. A calibrated offset may already be baked into trajectory_query_timestamp_ns; no cloud interpolation or additional legacy offset was applied."
    if mode == "cloud_pose_history_interpolated":
        return "Cloud interpolated shared_context/pose_history.jsonl to each image timestamp, then computed T_map_camera = T_map_lidar * inv(T_cam_lidar)."
    if mode == "vehicle_timestamp_interpolated_pose":
        return "Cloud used the per-frame T_map_camera/T_camera_map supplied by the vehicle. The vehicle interpolated /ndt_pose to each image timestamp using surrounding poses."
    if mode == "pose_history_available_not_used":
        return "Cloud used the per-frame transform supplied by the vehicle. Pose history is present for diagnostics and future cloud-side interpolation."
    if mode == "vehicle_matched_pose":
        return "Cloud used the per-frame pose/transform supplied by the vehicle package. This may be a matched pose if pose_context is absent."
    return "Cloud used the per-frame transform supplied by the vehicle package."


def matrix_from_value(value: object) -> np.ndarray | None:
    if value is None:
        return None
    try:
        matrix = np.asarray(value, dtype=float)
    except (TypeError, ValueError):
        return None
    if matrix.shape == (4, 4):
        return matrix
    flat = matrix.reshape(-1)
    if flat.size >= 16:
        return flat[:16].reshape(4, 4)
    return None


def quaternion_xyzw_to_rotmat(qx: float, qy: float, qz: float, qw: float) -> np.ndarray:
    quat = np.array([qx, qy, qz, qw], dtype=float)
    norm = np.linalg.norm(quat)
    if norm <= 1e-12:
        return np.eye(3, dtype=float)
    qx, qy, qz, qw = quat / norm
    return np.array(
        [
            [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
            [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
            [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)],
        ],
        dtype=float,
    )


def pose_dict_to_matrix(pose: dict) -> np.ndarray | None:
    for key in ("T_map_lidar", "matrix", "transform", "T"):
        matrix = matrix_from_value(pose.get(key))
        if matrix is not None:
            return matrix
    transforms = pose.get("transforms")
    if isinstance(transforms, dict):
        for key in ("T_map_lidar", "matrix", "transform", "T"):
            matrix = matrix_from_value(transforms.get(key))
            if matrix is not None:
                return matrix

    position = pose.get("position") or pose.get("translation") or nested_get(pose, "pose", "position") or nested_get(pose, "pose", "translation")
    orientation = pose.get("orientation") or pose.get("quaternion") or nested_get(pose, "pose", "orientation") or nested_get(pose, "pose", "quaternion")
    if not isinstance(position, dict) or not isinstance(orientation, dict):
        return None
    try:
        x = float(position.get("x", position.get("tx", 0.0)))
        y = float(position.get("y", position.get("ty", 0.0)))
        z = float(position.get("z", position.get("tz", 0.0)))
        qx = float(orientation.get("x", orientation.get("qx", 0.0)))
        qy = float(orientation.get("y", orientation.get("qy", 0.0)))
        qz = float(orientation.get("z", orientation.get("qz", 0.0)))
        qw = float(orientation.get("w", orientation.get("qw", 1.0)))
    except (TypeError, ValueError):
        return None
    matrix = np.eye(4, dtype=float)
    matrix[:3, :3] = quaternion_xyzw_to_rotmat(qx, qy, qz, qw)
    matrix[:3, 3] = [x, y, z]
    return matrix


def matrix_from_pose_history_record(record: dict) -> np.ndarray | None:
    candidates = [record, record.get("pose"), record.get("msg"), nested_get(record, "msg", "pose")]
    for item in candidates:
        if isinstance(item, dict):
            matrix = pose_dict_to_matrix(item)
            if matrix is not None:
                return matrix
    return None


def rotmat_to_quat_xyzw(rot: np.ndarray) -> np.ndarray:
    qvec = rotmat_to_qvec(rot)
    return np.array([qvec[1], qvec[2], qvec[3], qvec[0]], dtype=float)


def slerp_quat_xyzw(q0: np.ndarray, q1: np.ndarray, alpha: float) -> np.ndarray:
    q0 = q0.astype(float) / max(np.linalg.norm(q0), 1e-12)
    q1 = q1.astype(float) / max(np.linalg.norm(q1), 1e-12)
    dot = float(np.dot(q0, q1))
    if dot < 0.0:
        q1 = -q1
        dot = -dot
    if dot > 0.9995:
        out = q0 + alpha * (q1 - q0)
        return out / max(np.linalg.norm(out), 1e-12)
    theta_0 = math.acos(max(-1.0, min(1.0, dot)))
    theta = theta_0 * alpha
    sin_theta = math.sin(theta)
    sin_theta_0 = math.sin(theta_0)
    s0 = math.cos(theta) - dot * sin_theta / sin_theta_0
    s1 = sin_theta / sin_theta_0
    return s0 * q0 + s1 * q1


def interpolate_pose_history(pose_history: list[dict], timestamp_s: float) -> tuple[np.ndarray, float] | tuple[None, None]:
    if not pose_history or timestamp_s is None:
        return None, None
    if timestamp_s < pose_history[0]["timestamp_s"] or timestamp_s > pose_history[-1]["timestamp_s"]:
        return None, None
    lo = 0
    hi = len(pose_history) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if pose_history[mid]["timestamp_s"] < timestamp_s:
            lo = mid + 1
        else:
            hi = mid - 1
    next_idx = min(lo, len(pose_history) - 1)
    prev_idx = max(0, next_idx - 1)
    prev_pose = pose_history[prev_idx]
    next_pose = pose_history[next_idx]
    t0 = prev_pose["timestamp_s"]
    t1 = next_pose["timestamp_s"]
    if abs(t1 - t0) <= 1e-9:
        return prev_pose["T_map_lidar"], abs(timestamp_s - t0) * 1000.0
    alpha = max(0.0, min(1.0, (timestamp_s - t0) / (t1 - t0)))
    m0 = prev_pose["T_map_lidar"]
    m1 = next_pose["T_map_lidar"]
    out = np.eye(4, dtype=float)
    out[:3, 3] = (1.0 - alpha) * m0[:3, 3] + alpha * m1[:3, 3]
    quat = slerp_quat_xyzw(rotmat_to_quat_xyzw(m0[:3, :3]), rotmat_to_quat_xyzw(m1[:3, :3]), alpha)
    out[:3, :3] = quaternion_xyzw_to_rotmat(quat[0], quat[1], quat[2], quat[3])
    max_gap_ms = max(abs(timestamp_s - t0), abs(t1 - timestamp_s)) * 1000.0
    return out, max_gap_ms


def camera_lidar_extrinsic_from_record(record: dict, manifest: dict) -> np.ndarray | None:
    sources = [
        record,
        record.get("camera_calibration"),
        nested_get(record, "camera_calibration", "extrinsic"),
        manifest,
        manifest.get("camera_calibration"),
        nested_get(manifest, "camera_calibration", "extrinsic"),
    ]
    for source in sources:
        if not isinstance(source, dict):
            continue
        for key in ("T_cam_lidar", "T_camera_lidar", "T_lidar_to_camera"):
            matrix = matrix_from_value(source.get(key))
            if matrix is not None:
                return matrix
        for key in ("T_lidar_cam", "T_lidar_camera", "T_camera_to_lidar"):
            matrix = matrix_from_value(source.get(key))
            if matrix is not None:
                return np.linalg.inv(matrix)
    return None


def matrix_from_record(
    record: dict,
    pose_history: list[dict] | None = None,
    manifest: dict | None = None,
    timestamp_offset_s: float = 0.0,
) -> tuple[np.ndarray, str, float | None]:
    for key in ("T_camera_map", "T_world_camera_colmap", "T_wc_colmap"):
        value = record.get(key)
        matrix = matrix_from_value(value)
        if matrix is not None:
            return matrix, record_pose_mode(record), None

    for key in ("T_map_camera", "T_camera_world", "T_c2w"):
        value = record.get(key)
        matrix = matrix_from_value(value)
        if matrix is not None:
            return np.linalg.inv(matrix), record_pose_mode(record), None

    transforms = record.get("transforms")
    if isinstance(transforms, dict):
        nested = {**record, **transforms}
        return matrix_from_record(nested, pose_history, manifest, timestamp_offset_s)

    image_ts_s = record_image_timestamp_s(record)
    if image_ts_s is not None:
        image_ts_s += timestamp_offset_s
    if pose_history and image_ts_s is not None:
        T_map_lidar, pose_gap_ms = interpolate_pose_history(pose_history, image_ts_s)
        T_cam_lidar = camera_lidar_extrinsic_from_record(record, manifest or {})
        if T_map_lidar is not None and T_cam_lidar is not None:
            T_map_camera = T_map_lidar @ np.linalg.inv(T_cam_lidar)
            return np.linalg.inv(T_map_camera), "cloud_pose_history_interpolated", pose_gap_ms

    raise ValueError("record missing T_camera_map or T_map_camera")


def image_path_from_record(record: dict, root: Path) -> Path:
    image_obj = record.get("image") if isinstance(record.get("image"), dict) else {}
    candidates = [
        record.get("image_path"),
        record.get("path"),
        record.get("file_path"),
        record.get("filename"),
        image_obj.get("path"),
        image_obj.get("file_path"),
        image_obj.get("relative_path"),
        image_obj.get("name"),
    ]
    roots = [root]
    record_root = record.get("__record_root")
    if isinstance(record_root, str) and record_root:
        roots.insert(0, Path(record_root))

    for raw in candidates:
        if not raw:
            continue
        value = str(raw)
        direct = Path(value)
        if direct.exists():
            return direct
        for base in roots:
            rel = base / value
            if rel.exists():
                return rel
            images_dir = find_images_dir(base)
            by_name = images_dir / Path(value).name if images_dir else None
            if by_name and by_name.exists():
                return by_name

    raise ValueError("record missing image path")


def find_images_dir(root: Path) -> Path | None:
    direct = root / "images"
    if direct.exists() and direct.is_dir():
        return direct
    for item in root.rglob("images"):
        if item.is_dir():
            return item
    return None


def record_camera_id(record: dict, manifest: dict) -> str:
    image_obj = record.get("image") if isinstance(record.get("image"), dict) else {}
    calibration_obj = record.get("camera_calibration") if isinstance(record.get("camera_calibration"), dict) else {}
    raw = first_key(
        [record, image_obj, calibration_obj, manifest, manifest.get("camera_calibration")],
        ("camera", "camera_id", "camera_name", "sensor", "sensor_id"),
    )
    if isinstance(raw, dict):
        raw = raw.get("camera") or raw.get("camera_id") or raw.get("id") or raw.get("name")
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    topic = first_key([record, image_obj], ("topic", "image_topic", "camera_topic"))
    if isinstance(topic, str):
        for name in ("camera1", "camera2", "camera3", "camera4"):
            if name in topic:
                return name
    path_candidates = [
        record.get("image_path"),
        record.get("path"),
        record.get("file_path"),
        record.get("filename"),
        image_obj.get("path"),
        image_obj.get("file_path"),
        image_obj.get("relative_path"),
        image_obj.get("name"),
    ]
    for value in path_candidates:
        if not isinstance(value, str):
            continue
        for name in ("camera1", "camera2", "camera3", "camera4"):
            if name in value:
                return name
    return "unknown_camera"


def camera_sources(record: dict, manifest: dict) -> list[object]:
    camera_id = record_camera_id(record, manifest)
    sources: list[object] = [
        record,
        record.get("camera"),
        record.get("intrinsics"),
        record.get("camera_intrinsics"),
        record.get("camera_calibration"),
        nested_get(record, "camera_calibration", "intrinsic"),
        nested_get(record, "image", "camera"),
        manifest,
        manifest.get("camera"),
        manifest.get("intrinsics"),
        manifest.get("camera_intrinsics"),
        manifest.get("camera_calibration"),
        nested_get(manifest, "camera_calibration", "intrinsic"),
        nested_get(manifest, "calibration", camera_id),
        nested_get(manifest, "calibration", camera_id, "intrinsic"),
        nested_get(manifest, "calibration", "cameras", camera_id),
        nested_get(manifest, "calibration", "cameras", camera_id, "intrinsic"),
        nested_get(manifest, "cameras", camera_id),
        nested_get(manifest, "cameras", camera_id, "intrinsic"),
    ]
    return sources


def camera_distortion_model(record: dict, manifest: dict) -> str:
    raw = first_key(camera_sources(record, manifest), ("distortion_model", "camera_model", "model"))
    return str(raw or "plumb_bob").strip().lower()


def camera_params(record: dict, manifest: dict, image_path: Path) -> tuple[int, int, float, float, float, float, list[float]]:
    sources = camera_sources(record, manifest)
    k_value = first_key(sources, ("K", "camera_matrix"))
    if isinstance(k_value, list):
        flat = np.asarray(k_value, dtype=float).reshape(-1)
        if flat.size >= 9:
            fx, fy, cx, cy = flat[0], flat[4], flat[2], flat[5]
        else:
            fx = fy = cx = cy = None
    else:
        fx = first_key(sources, ("fx", "focal_x"))
        fy = first_key(sources, ("fy", "focal_y"))
        cx = first_key(sources, ("cx", "principal_x"))
        cy = first_key(sources, ("cy", "principal_y"))

    width = first_key(sources, ("width", "image_width", "w"))
    height = first_key(sources, ("height", "image_height", "h"))
    if width is None or height is None:
        with Image.open(image_path) as image:
            width, height = image.size

    if fx is None or fy is None or cx is None or cy is None:
        raise ValueError("camera intrinsics missing fx/fy/cx/cy")

    d_value = first_key(sources, ("D", "distortion", "distortion_coefficients"))
    distortion = [float(item) for item in d_value] if isinstance(d_value, list) else []
    return int(width), int(height), float(fx), float(fy), float(cx), float(cy), distortion


def rotmat_to_qvec(rot: np.ndarray) -> np.ndarray:
    qvec = np.empty(4, dtype=float)
    trace = np.trace(rot)
    if trace > 0:
        s = math.sqrt(trace + 1.0) * 2.0
        qvec[0] = 0.25 * s
        qvec[1] = (rot[2, 1] - rot[1, 2]) / s
        qvec[2] = (rot[0, 2] - rot[2, 0]) / s
        qvec[3] = (rot[1, 0] - rot[0, 1]) / s
    elif rot[0, 0] > rot[1, 1] and rot[0, 0] > rot[2, 2]:
        s = math.sqrt(1.0 + rot[0, 0] - rot[1, 1] - rot[2, 2]) * 2.0
        qvec[0] = (rot[2, 1] - rot[1, 2]) / s
        qvec[1] = 0.25 * s
        qvec[2] = (rot[0, 1] + rot[1, 0]) / s
        qvec[3] = (rot[0, 2] + rot[2, 0]) / s
    elif rot[1, 1] > rot[2, 2]:
        s = math.sqrt(1.0 + rot[1, 1] - rot[0, 0] - rot[2, 2]) * 2.0
        qvec[0] = (rot[0, 2] - rot[2, 0]) / s
        qvec[1] = (rot[0, 1] + rot[1, 0]) / s
        qvec[2] = 0.25 * s
        qvec[3] = (rot[1, 2] + rot[2, 1]) / s
    else:
        s = math.sqrt(1.0 + rot[2, 2] - rot[0, 0] - rot[1, 1]) * 2.0
        qvec[0] = (rot[1, 0] - rot[0, 1]) / s
        qvec[1] = (rot[0, 2] + rot[2, 0]) / s
        qvec[2] = (rot[1, 2] + rot[2, 1]) / s
        qvec[3] = 0.25 * s
    qvec /= np.linalg.norm(qvec)
    return qvec


def undistort_or_copy(
    src: Path,
    dst: Path,
    params: tuple[int, int, float, float, float, float, list[float]],
    undistort: bool,
    undistort_mode: str,
    distortion_model: str = "plumb_bob",
) -> tuple[int, int, float, float, float, float, str]:
    width, height, fx, fy, cx, cy, distortion = params
    if not undistort or cv2 is None or not distortion or max(abs(item) for item in distortion) <= 1e-12:
        shutil.copy2(src, dst)
        return width, height, fx, fy, cx, cy, "none"

    image = cv2.imread(str(src), cv2.IMREAD_COLOR)
    if image is None:
        shutil.copy2(src, dst)
        return width, height, fx, fy, cx, cy, "none"

    actual_height, actual_width = image.shape[:2]
    width, height = actual_width, actual_height
    camera_matrix = np.array([[fx, 0.0, cx], [0.0, fy, cy], [0.0, 0.0, 1.0]], dtype=np.float64)
    dist = np.array(distortion, dtype=np.float64).reshape(-1, 1)
    is_fisheye = distortion_model in {"equidistant", "fisheye"}
    if is_fisheye:
        if dist.size < 4:
            raise ValueError(f"fisheye calibration requires four coefficients, got {dist.size}")
        dist = dist[:4]
        if undistort_mode == "optimal":
            new_matrix = cv2.fisheye.estimateNewCameraMatrixForUndistortRectify(
                camera_matrix,
                dist,
                (width, height),
                np.eye(3),
                balance=0.0,
                new_size=(width, height),
            )
        else:
            new_matrix = camera_matrix
        map1, map2 = cv2.fisheye.initUndistortRectifyMap(
            camera_matrix,
            dist,
            np.eye(3),
            new_matrix,
            (width, height),
            cv2.CV_32FC1,
        )
        output = cv2.remap(image, map1, map2, interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
        applied_mode = f"fisheye-{undistort_mode}"
    elif undistort_mode == "optimal":
        new_matrix, _roi = cv2.getOptimalNewCameraMatrix(camera_matrix, dist, (width, height), 0, (width, height))
        output = cv2.undistort(image, camera_matrix, dist, None, new_matrix)
        applied_mode = undistort_mode
    else:
        new_matrix = camera_matrix
        output = cv2.undistort(image, camera_matrix, dist, None, camera_matrix)
        applied_mode = undistort_mode
    if not cv2.imwrite(str(dst), output):
        raise ValueError(f"failed to write undistorted image: {dst}")
    return (
        width,
        height,
        float(new_matrix[0, 0]),
        float(new_matrix[1, 1]),
        float(new_matrix[0, 2]),
        float(new_matrix[1, 2]),
        applied_mode,
    )


def unpack_rgb(value: str) -> tuple[int, int, int]:
    try:
        packed = int(float(value))
    except ValueError:
        packed = struct.unpack("I", struct.pack("f", float(value)))[0]
    red = (packed >> 16) & 255
    green = (packed >> 8) & 255
    blue = packed & 255
    return red, green, blue


def pcd_or_ply_to_ascii_ply(source: Path, work_dir: Path) -> Path:
    if source.suffix.lower() == ".pcd":
        output = work_dir / "pointcloud_from_pcd.ply"
        subprocess.run(["pcl_pcd2ply", "-format", "0", str(source), str(output)], check=True)
        return output
    return source


def parse_ascii_ply(source: Path, max_points: int) -> tuple[list[tuple[float, float, float]], list[tuple[int, int, int]]]:
    with source.open("rb") as handle:
        header_lines: list[str] = []
        while True:
            raw = handle.readline()
            if not raw:
                raise ValueError("invalid PLY header")
            line = raw.decode("utf-8", errors="replace").strip()
            header_lines.append(line)
            if line == "end_header":
                break

        if not any(line == "format ascii 1.0" for line in header_lines):
            raise ValueError("only ASCII PLY is supported after conversion")

        vertex_count = 0
        properties: list[str] = []
        in_vertex = False
        for line in header_lines:
            parts = line.split()
            if parts[:2] == ["element", "vertex"]:
                vertex_count = int(parts[2])
                in_vertex = True
                continue
            if parts and parts[0] == "element" and parts[1] != "vertex":
                in_vertex = False
            if in_vertex and parts[:1] == ["property"] and len(parts) >= 3:
                properties.append(parts[-1])

        if not vertex_count:
            raise ValueError("PLY has no vertices")
        prop_index = {name: idx for idx, name in enumerate(properties)}
        if not {"x", "y", "z"}.issubset(prop_index):
            raise ValueError("PLY missing x/y/z properties")

        stride = max(1, math.ceil(vertex_count / max(1, max_points)))
        points: list[tuple[float, float, float]] = []
        colors: list[tuple[int, int, int]] = []

        for idx in range(vertex_count):
            line = handle.readline().decode("utf-8", errors="replace").strip()
            if not line:
                continue
            if idx % stride != 0:
                continue
            values = line.split()
            x = float(values[prop_index["x"]])
            y = float(values[prop_index["y"]])
            z = float(values[prop_index["z"]])
            if {"red", "green", "blue"}.issubset(prop_index):
                rgb = (
                    int(float(values[prop_index["red"]])),
                    int(float(values[prop_index["green"]])),
                    int(float(values[prop_index["blue"]])),
                )
            elif "rgb" in prop_index:
                rgb = unpack_rgb(values[prop_index["rgb"]])
            else:
                rgb = (180, 180, 180)
            points.append((x, y, z))
            colors.append(tuple(max(0, min(255, int(item))) for item in rgb))

    return points, colors


def write_points_ply(target: Path, points: list[tuple[float, float, float]], colors: list[tuple[int, int, int]]) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8") as handle:
        handle.write("ply\n")
        handle.write("format ascii 1.0\n")
        handle.write(f"element vertex {len(points)}\n")
        handle.write("property float x\nproperty float y\nproperty float z\n")
        handle.write("property float nx\nproperty float ny\nproperty float nz\n")
        handle.write("property uchar red\nproperty uchar green\nproperty uchar blue\n")
        handle.write("end_header\n")
        for point, color in zip(points, colors):
            handle.write(
                f"{point[0]:.8f} {point[1]:.8f} {point[2]:.8f} 0 0 0 {color[0]} {color[1]} {color[2]}\n"
            )


def choose_colorization_frames(frames: list[dict], max_frames: int) -> list[dict]:
    if max_frames <= 0 or len(frames) <= max_frames:
        return frames
    by_camera: dict[str, list[dict]] = {}
    for frame in frames:
        by_camera.setdefault(str(frame.get("camera_name") or "unknown"), []).append(frame)
    per_camera = max(1, math.ceil(max_frames / max(1, len(by_camera))))
    selected: list[dict] = []
    for camera_name in sorted(by_camera):
        items = by_camera[camera_name]
        if len(items) <= per_camera:
            selected.extend(items)
            continue
        indexes = np.linspace(0, len(items) - 1, per_camera, dtype=int)
        selected.extend(items[int(index)] for index in indexes)
    if len(selected) <= max_frames:
        return selected
    indexes = np.linspace(0, len(selected) - 1, max_frames, dtype=int)
    return [selected[int(index)] for index in indexes]


def colorize_and_filter_points(
    points: list[tuple[float, float, float]],
    colors: list[tuple[int, int, int]],
    frames: list[dict],
    args: argparse.Namespace,
    output: Path,
) -> tuple[list[tuple[float, float, float]], list[tuple[int, int, int]], dict]:
    start_time = time.time()
    enabled = parse_bool(args.colorize_points, True)
    visibility_filter = parse_bool(args.filter_visible_points, True)
    original_count = len(points)
    if not enabled or cv2 is None or not points or not frames:
        return points, colors, {
            "enabled": enabled,
            "visibility_filter_enabled": visibility_filter,
            "skipped_reason": "cv2_unavailable_or_empty_input" if enabled else "disabled",
            "source_point_count": original_count,
            "point_count": original_count,
            "colored_points": 0,
            "kept_points": original_count,
            "filtered_points": 0,
            "elapsed_s": round(time.time() - start_time, 3),
        }

    max_frames = int(args.colorize_max_frames)
    selected_frames = choose_colorization_frames(frames, max_frames)
    if not selected_frames:
        return points, colors, {
            "enabled": True,
            "visibility_filter_enabled": visibility_filter,
            "skipped_reason": "no_colorization_frames",
            "source_point_count": original_count,
            "point_count": original_count,
            "colored_points": 0,
            "kept_points": original_count,
            "filtered_points": 0,
            "elapsed_s": round(time.time() - start_time, 3),
        }

    points_array = np.asarray(points, dtype=np.float64)
    color_sum = np.zeros((points_array.shape[0], 3), dtype=np.float64)
    observation_count = np.zeros(points_array.shape[0], dtype=np.int32)
    cell_px = max(1, int(args.colorize_occlusion_cell_px))
    depth_tolerance = max(0.0, float(args.colorize_depth_tolerance_m))
    min_depth = max(0.05, float(args.colorize_min_depth_m))
    processed_frames = 0
    usable_projection_count = 0
    per_camera_frames: dict[str, int] = {}

    for frame_index, frame in enumerate(selected_frames, start=1):
        image = cv2.imread(str(frame["image_path"]), cv2.IMREAD_COLOR)
        if image is None:
            continue
        height, width = image.shape[:2]
        camera_matrix = frame["camera_matrix"]
        transform = frame["world_to_camera"]
        camera_name = str(frame.get("camera_name") or "unknown")
        per_camera_frames[camera_name] = per_camera_frames.get(camera_name, 0) + 1

        rotation = transform[:3, :3]
        translation = transform[:3, 3]
        points_camera = points_array @ rotation.T + translation
        z = points_camera[:, 2]
        valid_depth = z > min_depth
        projected_x = camera_matrix[0, 0] * points_camera[:, 0] / z + camera_matrix[0, 2]
        projected_y = camera_matrix[1, 1] * points_camera[:, 1] / z + camera_matrix[1, 2]
        in_image = (
            valid_depth
            & (projected_x >= 1)
            & (projected_x < width - 1)
            & (projected_y >= 1)
            & (projected_y < height - 1)
        )
        candidate_indexes = np.flatnonzero(in_image)
        if candidate_indexes.size:
            x_pixels = np.rint(projected_x[candidate_indexes]).astype(np.int32)
            y_pixels = np.rint(projected_y[candidate_indexes]).astype(np.int32)
            depths = z[candidate_indexes]

            if cell_px > 1:
                grid_width = int(math.ceil(width / cell_px))
                grid_height = int(math.ceil(height / cell_px))
                cell_x = np.clip(x_pixels // cell_px, 0, grid_width - 1)
                cell_y = np.clip(y_pixels // cell_px, 0, grid_height - 1)
                cell_ids = cell_y * grid_width + cell_x
                nearest_depth = np.full(grid_width * grid_height, np.inf, dtype=np.float64)
                np.minimum.at(nearest_depth, cell_ids, depths)
                visible = depths <= nearest_depth[cell_ids] + depth_tolerance
                candidate_indexes = candidate_indexes[visible]
                x_pixels = x_pixels[visible]
                y_pixels = y_pixels[visible]

            if candidate_indexes.size:
                rgb = image[y_pixels, x_pixels, ::-1].astype(np.float64)
                color_sum[candidate_indexes] += rgb
                observation_count[candidate_indexes] += 1
                usable_projection_count += int(candidate_indexes.size)

        processed_frames += 1
        if frame_index == len(selected_frames) or frame_index % 10 == 0:
            progress = 58.0 + (frame_index / max(1, len(selected_frames))) * 30.0
            write_progress(
                output,
                "colorize",
                progress,
                f"投影采样 {frame_index}/{len(selected_frames)} 张，已累计 {int((observation_count > 0).sum())} 个可见点",
            )

    colored_mask = observation_count > 0
    colored_count = int(colored_mask.sum())
    colors_array = np.asarray(colors, dtype=np.int32)
    if colors_array.shape[0] != points_array.shape[0]:
        colors_array = np.full((points_array.shape[0], 3), 180, dtype=np.int32)
    if colored_count:
        averaged = np.rint(color_sum[colored_mask] / observation_count[colored_mask, None]).astype(np.int32)
        colors_array[colored_mask] = np.clip(averaged, 0, 255)

    requested_min_observations = max(0, int(args.colorize_min_observations))
    applied_min_observations = requested_min_observations if visibility_filter else 0
    keep_mask = np.ones(points_array.shape[0], dtype=bool)
    filter_reason = "disabled"
    min_kept_points = max(0, int(args.colorize_min_kept_points))
    if visibility_filter and requested_min_observations > 0:
        keep_mask = observation_count >= requested_min_observations
        filter_reason = "requested_threshold"
        if int(keep_mask.sum()) < min_kept_points and requested_min_observations > 1:
            relaxed = observation_count >= 1
            if int(relaxed.sum()) >= min_kept_points:
                keep_mask = relaxed
                applied_min_observations = 1
                filter_reason = "relaxed_to_one_observation"
        if int(keep_mask.sum()) < min_kept_points:
            keep_mask = np.ones(points_array.shape[0], dtype=bool)
            applied_min_observations = 0
            filter_reason = "insufficient_visible_points_kept_all"

    filtered_points = points_array[keep_mask]
    filtered_colors = colors_array[keep_mask]
    kept_count = int(filtered_points.shape[0])
    elapsed_s = time.time() - start_time
    observation_percentiles = {}
    if colored_count:
        observed_values = observation_count[colored_mask]
        observation_percentiles = {
            "p10": float(np.percentile(observed_values, 10)),
            "p25": float(np.percentile(observed_values, 25)),
            "p50": float(np.percentile(observed_values, 50)),
            "p75": float(np.percentile(observed_values, 75)),
            "p90": float(np.percentile(observed_values, 90)),
        }
    return (
        [tuple(float(value) for value in point) for point in filtered_points.tolist()],
        [tuple(int(value) for value in color) for color in filtered_colors.tolist()],
        {
            "enabled": True,
            "visibility_filter_enabled": visibility_filter,
            "source_point_count": original_count,
            "point_count": kept_count,
            "colored_points": colored_count,
            "default_color_points": int((observation_count == 0).sum()),
            "kept_points": kept_count,
            "filtered_points": original_count - kept_count,
            "usable_projection_count": usable_projection_count,
            "sampled_frames": processed_frames,
            "requested_max_frames": max_frames,
            "per_camera_sampled_frames": per_camera_frames,
            "requested_min_observations": requested_min_observations,
            "applied_min_observations": applied_min_observations,
            "filter_reason": filter_reason,
            "occlusion_cell_px": cell_px,
            "depth_tolerance_m": depth_tolerance,
            "min_depth_m": min_depth,
            "mean_observations_for_colored_points": float(observation_count[colored_mask].mean()) if colored_count else 0.0,
            "observation_percentiles": observation_percentiles,
            "max_observations": int(observation_count.max()) if observation_count.size else 0,
            "elapsed_s": round(elapsed_s, 3),
        },
    )


def prepare_scene(args: argparse.Namespace) -> dict:
    output = Path(args.output).resolve()
    images_out = output / "images"
    sparse_out = output / "sparse" / "0"
    images_out.mkdir(parents=True, exist_ok=True)
    sparse_out.mkdir(parents=True, exist_ok=True)
    write_progress(output, "extract", 1.0, "开始读取上传数据")

    with tempfile.TemporaryDirectory(prefix="three_dgs_prepare_") as tmp:
        work_dir = Path(tmp)
        image_root = extract_archive(Path(args.image_pose).resolve(), work_dir)
        write_progress(output, "extract", 8.0, "图像-位姿包已解包")
        manifest, records = load_records(image_root)
        pose_history = load_pose_history(image_root)
        pose_time_offsets_s = load_pose_time_offsets(args.pose_time_offsets_json)
        is_map_visual = validate_pose_time_offsets(records, pose_time_offsets_s)
        write_progress(output, "images", 10.0, f"读取到 {len(records)} 条图像-位姿记录")

        camera_models: dict[tuple[str, int, int, float, float, float, float], int] = {}
        camera_undistort_modes: dict[int, str] = {}
        colorization_frames: list[dict] = []
        camera_lines: list[str] = []
        image_lines: list[str] = []
        frame_metadata: list[dict] = []
        pose_mode_counts: dict[str, int] = {}
        pointcloud_context_frame_count = 0
        copied_count = 0

        for image_id, record in enumerate(records, start=1):
            local_manifest = record_manifest(record, manifest)
            source_image = image_path_from_record(record, image_root)
            camera_name = record_camera_id(record, local_manifest)
            pose_time_offset_s = pose_time_offsets_s.get(camera_name, 0.0)
            raw_group_key = record_group_key(record, image_id)
            group_name = sanitize_component(raw_group_key, "group").replace("_", "-")
            image_ts_s = record_image_timestamp_s(record)
            if record.get("__map_visual_final_pose") and record.get("trajectory_query_timestamp_ns") is not None:
                pose_interpolation_ts_s = float(record["trajectory_query_timestamp_ns"]) / 1e9
                effective_pose_time_offset_ms = (
                    (pose_interpolation_ts_s - image_ts_s) * 1000.0
                    if image_ts_s is not None
                    else None
                )
            else:
                pose_interpolation_ts_s = image_ts_s + pose_time_offset_s if image_ts_s is not None else None
                effective_pose_time_offset_ms = pose_time_offset_s * 1000.0
            pose_ts_s = record_pose_timestamp_s(record)
            pose_delta_ms = record_pose_delta_ms(record, image_ts_s, pose_ts_s)
            params = camera_params(record, local_manifest, source_image)
            distortion_model = camera_distortion_model(record, local_manifest)
            out_name = (
                f"frame_{image_id:06d}_"
                f"{sanitize_component(camera_name, 'camera')}_"
                f"g{group_name}_"
                f"{sanitize_component(source_image.stem, 'image')}"
                f"{source_image.suffix.lower() or '.jpg'}"
            )
            output_image = images_out / out_name
            width, height, fx, fy, cx, cy, applied_undistort_mode = undistort_or_copy(
                source_image,
                output_image,
                params,
                args.undistort.lower() != "false",
                args.undistort_mode,
                distortion_model,
            )
            camera_key = (
                camera_name,
                width,
                height,
                round(fx, 8),
                round(fy, 8),
                round(cx, 8),
                round(cy, 8),
            )
            camera_id = camera_models.get(camera_key)
            if camera_id is None:
                camera_id = len(camera_models) + 1
                camera_models[camera_key] = camera_id
                camera_lines.append(
                    f"{camera_id} PINHOLE {width} {height} {fx:.12g} {fy:.12g} {cx:.12g} {cy:.12g}\n"
            )
            camera_undistort_modes[camera_id] = applied_undistort_mode

            world_to_camera, pose_mode, interpolation_gap_ms = matrix_from_record(
                record,
                pose_history,
                local_manifest,
                pose_time_offset_s,
            )
            if pose_delta_ms is None and interpolation_gap_ms is not None:
                pose_delta_ms = interpolation_gap_ms
            camera_matrix = np.array([[fx, 0.0, cx], [0.0, fy, cy], [0.0, 0.0, 1.0]], dtype=np.float64)
            colorization_frames.append(
                {
                    "camera_name": camera_name,
                    "image_path": output_image,
                    "world_to_camera": world_to_camera,
                    "camera_matrix": camera_matrix,
                    "width": width,
                    "height": height,
                }
            )
            rot = world_to_camera[:3, :3]
            tvec = world_to_camera[:3, 3]
            qvec = rotmat_to_qvec(rot)
            image_lines.append(
                "{} {:.12g} {:.12g} {:.12g} {:.12g} {:.12g} {:.12g} {:.12g} {} {}\n\n".format(
                    image_id,
                    qvec[0],
                    qvec[1],
                    qvec[2],
                    qvec[3],
                    tvec[0],
                    tvec[1],
                    tvec[2],
                    camera_id,
                    out_name,
                )
            )
            pose_obj = record.get("pose") if isinstance(record.get("pose"), dict) else {}
            image_obj = record.get("image") if isinstance(record.get("image"), dict) else {}
            pose_mode_counts[pose_mode] = pose_mode_counts.get(pose_mode, 0) + 1
            has_pointcloud_context = record_pointcloud_context_available(record)
            if has_pointcloud_context:
                pointcloud_context_frame_count += 1
            frame_metadata.append(
                {
                    "image_id": image_id,
                    "camera_id": camera_id,
                    "camera_name": camera_name,
                    "image_name": out_name,
                    "capture_key": group_name,
                    "source_index": record.get("index"),
                    "source_image_name": source_image.name,
                    "source_image_path": str(source_image),
                    "source_image_relative_path": image_obj.get("relative_path")
                    or image_obj.get("path")
                    or record.get("image_path"),
                    "image_ts_unix": image_ts_s,
                    "image_ts_ns": timestamp_ns(image_ts_s),
                    "pose_interpolation_ts_unix": pose_interpolation_ts_s,
                    "pose_interpolation_ts_ns": timestamp_ns(pose_interpolation_ts_s),
                    "pose_time_offset_ms": round(effective_pose_time_offset_ms, 6)
                    if effective_pose_time_offset_ms is not None
                    else None,
                    "camera_time_offset_calibrated": bool(
                        record.get("camera_time_offset_calibrated", False)
                    ),
                    "pose_ts_unix": pose_ts_s,
                    "pose_ts_ns": timestamp_ns(pose_ts_s),
                    "image_pose_delta_ms": pose_delta_ms,
                    "pose_source": pose_obj.get("source") or record.get("pose_source"),
                    "pose_topic": pose_obj.get("topic"),
                    "pose_mode": pose_mode,
                    "distortion_model": distortion_model,
                    "pose_interpolation": pose_mode,
                    "pose_interpolation_note": pose_interpolation_note_for_mode(pose_mode),
                    "pointcloud_context_available": has_pointcloud_context,
                }
            )
            copied_count += 1
            if image_id == len(records) or image_id % 50 == 0:
                pct = 10.0 + (image_id / max(1, len(records))) * 35.0
                write_progress(output, "images", pct, f"已处理 {image_id}/{len(records)} 张图像")

        if not camera_models:
            raise ValueError("no usable camera frames")

        with (sparse_out / "cameras.txt").open("w", encoding="utf-8") as handle:
            handle.write("# Camera list with one line of data per camera:\n")
            handle.write("# CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]\n")
            handle.writelines(camera_lines)

        with (sparse_out / "images.txt").open("w", encoding="utf-8") as handle:
            handle.write("# Image list with two lines of data per image:\n")
            handle.write("# IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME\n")
            handle.writelines(image_lines)

        frame_metadata.sort(key=lambda item: item["image_id"])
        with (output / "frame_metadata.json").open("w", encoding="utf-8") as handle:
            json.dump(
                {
                    "schema": "jgzj.three_dgs.frame_metadata.v1",
                    "scene_name": args.scene_name,
                    "generated_at_unix": time.time(),
                    "pose_interpolation": {
                        "mode": "map_visual_final_pgo_spline_pose"
                        if pose_mode_counts.get("map_visual_final_pgo_spline_pose")
                        else "cloud_pose_history_interpolated"
                        if pose_mode_counts.get("cloud_pose_history_interpolated")
                        else "vehicle_timestamp_interpolated_pose"
                        if pose_mode_counts.get("vehicle_timestamp_interpolated_pose")
                        else "vehicle_matched_pose",
                        "cloud_interpolation_available": bool(pose_mode_counts.get("cloud_pose_history_interpolated")),
                        "vehicle_interpolation_available": bool(pose_mode_counts.get("vehicle_timestamp_interpolated_pose")),
                        "pose_mode_counts": pose_mode_counts,
                        "pose_time_offsets_ms": {key: value * 1000.0 for key, value in sorted(pose_time_offsets_s.items())},
                        "embedded_camera_time_offset_ms": float(
                            manifest.get("camera_time_offset_ns", 0)
                        )
                        / 1e6
                        if is_map_visual
                        else None,
                        "embedded_camera_time_offset_calibrated": bool(
                            manifest.get("camera_time_offset_calibrated", False)
                        )
                        if is_map_visual
                        else False,
                        "note": "map_visual final poses are used verbatim, may already include a calibrated offset, and reject additional legacy offsets; generic packages may optionally use cloud pose-history interpolation.",
                    },
                    "pointcloud_context": {
                        "available_frame_count": pointcloud_context_frame_count,
                        "available": pointcloud_context_frame_count > 0,
                    },
                    "frames": frame_metadata,
                },
                handle,
                ensure_ascii=False,
                indent=2,
            )

        write_progress(output, "pointcloud", 48.0, "正在转换 GlobalMap.pcd")
        ascii_ply = pcd_or_ply_to_ascii_ply(Path(args.pointcloud).resolve(), work_dir)
        write_progress(output, "pointcloud", 54.0, "正在读取初始化点云")
        points, colors = parse_ascii_ply(ascii_ply, int(args.max_points))
        write_progress(output, "colorize", 58.0, f"开始点云投影上色，输入 {len(points)} 个点")
        points, colors, colorization_summary = colorize_and_filter_points(points, colors, colorization_frames, args, output)
        write_progress(output, "write", 92.0, f"正在写入 {len(points)} 个初始化点")
        write_points_ply(sparse_out / "points3D.ply", points, colors)

        summary = {
            "scene_name": args.scene_name,
            "output": str(output),
            "image_count": copied_count,
            "point_count": len(points),
            "camera_count": len(camera_models),
            "colorization": colorization_summary,
            "frame_metadata_path": str(output / "frame_metadata.json"),
            "source_format": "map_visual" if is_map_visual else "generic_records",
        "pose_interpolation": {
            "mode": "map_visual_final_pgo_spline_pose"
            if pose_mode_counts.get("map_visual_final_pgo_spline_pose")
            else "cloud_pose_history_interpolated"
            if pose_mode_counts.get("cloud_pose_history_interpolated")
            else "vehicle_timestamp_interpolated_pose"
            if pose_mode_counts.get("vehicle_timestamp_interpolated_pose")
            else "vehicle_matched_pose",
            "cloud_interpolation_available": bool(pose_mode_counts.get("cloud_pose_history_interpolated")),
            "vehicle_interpolation_available": bool(pose_mode_counts.get("vehicle_timestamp_interpolated_pose")),
            "pose_mode_counts": pose_mode_counts,
            "pose_time_offsets_ms": {key: value * 1000.0 for key, value in sorted(pose_time_offsets_s.items())},
            "embedded_camera_time_offset_ms": float(
                manifest.get("camera_time_offset_ns", 0)
            )
            / 1e6
            if is_map_visual
            else None,
            "embedded_camera_time_offset_calibrated": bool(
                manifest.get("camera_time_offset_calibrated", False)
            )
            if is_map_visual
            else False,
            "note": "map_visual final poses are used verbatim, may already include a calibrated offset, and reject additional legacy offsets; generic records keep the existing optional interpolation behavior.",
            },
            "pointcloud_context": {
                "available": pointcloud_context_frame_count > 0,
                "available_frame_count": pointcloud_context_frame_count,
            },
            "cameras": [
                {
                    "camera_id": camera_id,
                    "name": key[0],
                    "model": "PINHOLE",
                    "width": key[1],
                    "height": key[2],
                    "fx": key[3],
                    "fy": key[4],
                    "cx": key[5],
                    "cy": key[6],
                    "undistorted": args.undistort.lower() != "false" and cv2 is not None,
                    "undistort_mode": camera_undistort_modes.get(camera_id, "none"),
                }
                for key, camera_id in camera_models.items()
            ],
        }

        with (output / "three_dgs_dataset_summary.json").open("w", encoding="utf-8") as handle:
            json.dump(summary, handle, ensure_ascii=False, indent=2)
        write_progress(output, "write", 100.0, f"完成：{copied_count} 张图像，{len(points)} 个初始化点")
        return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare vehicle 3DGS capture data as a COLMAP scene.")
    parser.add_argument("--image-pose", required=True)
    parser.add_argument("--pointcloud", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--scene-name", default="scene")
    parser.add_argument("--max-points", type=int, default=500000)
    parser.add_argument("--undistort", default="true")
    parser.add_argument(
        "--undistort-mode",
        choices=("keep-k", "optimal"),
        default="keep-k",
        help="keep-k matches FAST-Calib's cv::undistort(image, K, D) projection convention; optimal keeps the previous getOptimalNewCameraMatrix(alpha=0) behavior.",
    )
    parser.add_argument(
        "--pose-time-offsets-json",
        default="",
        help="Optional JSON with per-camera pose interpolation offsets in milliseconds, e.g. {\"camera_offsets_ms\":{\"camera1\":-40}}.",
    )
    parser.add_argument("--colorize-points", default="true")
    parser.add_argument("--filter-visible-points", default="true")
    parser.add_argument("--colorize-max-frames", type=int, default=640)
    parser.add_argument("--colorize-min-observations", type=int, default=2)
    parser.add_argument("--colorize-min-kept-points", type=int, default=20000)
    parser.add_argument("--colorize-occlusion-cell-px", type=int, default=8)
    parser.add_argument("--colorize-depth-tolerance-m", type=float, default=1.0)
    parser.add_argument("--colorize-min-depth-m", type=float, default=0.1)
    args = parser.parse_args()

    summary = prepare_scene(args)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
