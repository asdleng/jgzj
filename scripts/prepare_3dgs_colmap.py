#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
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


def load_records(root: Path) -> tuple[dict, list[dict]]:
    manifest_path = find_first(root, ("manifest.json",))
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
        for item in sorted(root.rglob("frames.jsonl")):
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
        for item in sorted(root.rglob("*.jsonl")):
            if item.name == "frames.jsonl":
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
    if mode == "vehicle_timestamp_interpolated_pose":
        return "Cloud used the per-frame T_map_camera/T_camera_map supplied by the vehicle. The vehicle interpolated /ndt_pose to each image timestamp using surrounding poses."
    if mode == "pose_history_available_not_used":
        return "Cloud used the per-frame transform supplied by the vehicle. Pose history is present for diagnostics and future cloud-side interpolation."
    if mode == "vehicle_matched_pose":
        return "Cloud used the per-frame pose/transform supplied by the vehicle package. This may be a matched pose if pose_context is absent."
    return "Cloud used the per-frame transform supplied by the vehicle package."


def matrix_from_record(record: dict) -> np.ndarray:
    for key in ("T_camera_map", "T_world_camera_colmap", "T_wc_colmap"):
        value = record.get(key)
        if value is not None:
            matrix = np.asarray(value, dtype=float)
            if matrix.shape == (4, 4):
                return matrix

    for key in ("T_map_camera", "T_camera_world", "T_c2w"):
        value = record.get(key)
        if value is not None:
            matrix = np.asarray(value, dtype=float)
            if matrix.shape == (4, 4):
                return np.linalg.inv(matrix)

    transforms = record.get("transforms")
    if isinstance(transforms, dict):
        nested = {**record, **transforms}
        return matrix_from_record(nested)

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
    if undistort_mode == "optimal":
        new_matrix, _roi = cv2.getOptimalNewCameraMatrix(camera_matrix, dist, (width, height), 0, (width, height))
        output = cv2.undistort(image, camera_matrix, dist, None, new_matrix)
    else:
        new_matrix = camera_matrix
        output = cv2.undistort(image, camera_matrix, dist, None, camera_matrix)
    cv2.imwrite(str(dst), output)
    return (
        width,
        height,
        float(new_matrix[0, 0]),
        float(new_matrix[1, 1]),
        float(new_matrix[0, 2]),
        float(new_matrix[1, 2]),
        undistort_mode,
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
            raw_group_key = record_group_key(record, image_id)
            group_name = sanitize_component(raw_group_key, "group").replace("_", "-")
            image_ts_s = record_image_timestamp_s(record)
            pose_ts_s = record_pose_timestamp_s(record)
            pose_delta_ms = record_pose_delta_ms(record, image_ts_s, pose_ts_s)
            params = camera_params(record, local_manifest, source_image)
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

            world_to_camera = matrix_from_record(record)
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
            pose_mode = record_pose_mode(record)
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
                    "source_image_relative_path": image_obj.get("relative_path") or image_obj.get("path"),
                    "image_ts_unix": image_ts_s,
                    "image_ts_ns": timestamp_ns(image_ts_s),
                    "pose_ts_unix": pose_ts_s,
                    "pose_ts_ns": timestamp_ns(pose_ts_s),
                    "image_pose_delta_ms": pose_delta_ms,
                    "pose_source": pose_obj.get("source") or record.get("pose_source"),
                    "pose_topic": pose_obj.get("topic"),
                    "pose_mode": pose_mode,
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
                        "mode": "vehicle_timestamp_interpolated_pose" if pose_mode_counts.get("vehicle_timestamp_interpolated_pose") else "vehicle_matched_pose",
                        "cloud_interpolation_available": False,
                        "vehicle_interpolation_available": bool(pose_mode_counts.get("vehicle_timestamp_interpolated_pose")),
                        "pose_mode_counts": pose_mode_counts,
                        "note": "Each image uses its own vehicle-supplied T_map_camera/T_camera_map. Camera streams are not assumed to be synchronized.",
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
            "pose_interpolation": {
                "mode": "vehicle_timestamp_interpolated_pose" if pose_mode_counts.get("vehicle_timestamp_interpolated_pose") else "vehicle_matched_pose",
                "cloud_interpolation_available": False,
                "vehicle_interpolation_available": bool(pose_mode_counts.get("vehicle_timestamp_interpolated_pose")),
                "pose_mode_counts": pose_mode_counts,
                "note": "Cloud uses the per-frame T_map_camera/T_camera_map supplied by the vehicle package.",
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
