#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import prepare_3dgs_colmap as prep  # noqa: E402


PHYSICAL_CAMERA_DIRECTIONS = {
    "camera1": "front",
    "camera2": "back",
    "camera3": "left",
    "camera4": "right",
}

EXPECTED_OPTICAL_AXES_LIDAR = {
    "camera1": np.array([1.0, 0.0, 0.0]),
    "camera2": np.array([-1.0, 0.0, 0.0]),
    "camera3": np.array([0.0, 1.0, 0.0]),
    "camera4": np.array([0.0, -1.0, 0.0]),
}


def transform_points(matrix: np.ndarray, points: np.ndarray) -> np.ndarray:
    rot = matrix[:3, :3]
    trans = matrix[:3, 3]
    return points @ rot.T + trans


def project_camera_points(points_camera: np.ndarray, camera_matrix: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    z = points_camera[:, 2]
    valid = z > 0.1
    u = camera_matrix[0, 0] * points_camera[:, 0] / z + camera_matrix[0, 2]
    v = camera_matrix[1, 1] * points_camera[:, 1] / z + camera_matrix[1, 2]
    return np.stack([u, v], axis=1), valid


def project_map_points_raw(points_map: np.ndarray, world_to_camera: np.ndarray, camera_matrix: np.ndarray, distortion: list[float]) -> tuple[np.ndarray, np.ndarray]:
    rot = world_to_camera[:3, :3]
    trans = world_to_camera[:3, 3]
    rvec, _ = cv2.Rodrigues(rot)
    tvec = trans.reshape(3, 1)
    dist = np.asarray(distortion, dtype=np.float64).reshape(-1, 1)
    image_points, _ = cv2.projectPoints(points_map.astype(np.float64), rvec, tvec, camera_matrix, dist)
    points_camera = transform_points(world_to_camera, points_map)
    return image_points.reshape(-1, 2), points_camera[:, 2] > 0.1


def in_image_mask(projected: np.ndarray, valid_depth: np.ndarray, width: int, height: int) -> np.ndarray:
    return (
        valid_depth
        & (projected[:, 0] >= 0)
        & (projected[:, 0] < width)
        & (projected[:, 1] >= 0)
        & (projected[:, 1] < height)
    )


def draw_overlay(image: np.ndarray, projected: np.ndarray, mask: np.ndarray, output: Path, max_draw: int) -> int:
    overlay = image.copy()
    indices = np.flatnonzero(mask)
    if indices.size > max_draw:
        rng = np.random.default_rng(7)
        indices = rng.choice(indices, size=max_draw, replace=False)
    for idx in indices:
        x, y = projected[idx]
        cv2.circle(overlay, (int(round(x)), int(round(y))), 2, (0, 0, 255), -1, lineType=cv2.LINE_AA)
    output.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(output), overlay)
    return int(indices.size)


def unit_vector(value: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(value))
    if norm <= 1e-12:
        return value
    return value / norm


def extrinsic_direction_summary(camera_id: str, record: dict) -> dict:
    calibration = record.get("camera_calibration") if isinstance(record.get("camera_calibration"), dict) else {}
    raw = calibration.get("T_cam_lidar") or record.get("T_cam_lidar")
    if raw is None:
        return {
            "physical_direction": PHYSICAL_CAMERA_DIRECTIONS.get(camera_id),
            "error": "T_cam_lidar_missing",
        }
    matrix = np.asarray(raw, dtype=float)
    if matrix.shape != (4, 4):
        return {
            "physical_direction": PHYSICAL_CAMERA_DIRECTIONS.get(camera_id),
            "error": "T_cam_lidar_invalid_shape",
        }
    rotation = matrix[:3, :3]
    optical_axis_lidar = unit_vector(rotation.T @ np.array([0.0, 0.0, 1.0]))
    right_axis_lidar = unit_vector(rotation.T @ np.array([1.0, 0.0, 0.0]))
    down_axis_lidar = unit_vector(rotation.T @ np.array([0.0, 1.0, 0.0]))
    expected = EXPECTED_OPTICAL_AXES_LIDAR.get(camera_id)
    alignment = float(np.dot(optical_axis_lidar, expected)) if expected is not None else None
    return {
        "physical_direction": PHYSICAL_CAMERA_DIRECTIONS.get(camera_id),
        "optical_axis_lidar": [float(item) for item in optical_axis_lidar],
        "right_axis_lidar": [float(item) for item in right_axis_lidar],
        "down_axis_lidar": [float(item) for item in down_axis_lidar],
        "expected_optical_axis_lidar": [float(item) for item in expected] if expected is not None else None,
        "expected_alignment_cos": alignment,
        "matches_expected_direction": alignment is None or alignment > 0.85,
    }


def pick_records(records: list[dict], manifest: dict, cameras: list[str], frame_index: int) -> dict[str, dict]:
    by_camera: dict[str, list[dict]] = {}
    for record in records:
        camera_id = prep.record_camera_id(record, prep.record_manifest(record, manifest))
        if cameras and camera_id not in cameras:
            continue
        by_camera.setdefault(camera_id, []).append(record)
    result = {}
    for camera_id, items in sorted(by_camera.items()):
        if not items:
            continue
        result[camera_id] = items[min(frame_index, len(items) - 1)]
    return result


def run(args: argparse.Namespace) -> dict:
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    cameras = [item.strip() for item in args.cameras.split(",") if item.strip()]

    with tempfile.TemporaryDirectory(prefix="three_dgs_projection_") as tmp:
        work_dir = Path(tmp)
        image_root = prep.extract_archive(Path(args.image_pose).resolve(), work_dir)
        manifest, records = prep.load_records(image_root)
        selected = pick_records(records, manifest, cameras, max(0, int(args.frame_index)))

        ascii_ply = prep.pcd_or_ply_to_ascii_ply(Path(args.pointcloud).resolve(), work_dir)
        points, _colors = prep.parse_ascii_ply(ascii_ply, int(args.max_points))
        points_map = np.asarray(points, dtype=np.float64)

        summary = {
            "image_pose": str(Path(args.image_pose).resolve()),
            "pointcloud": str(Path(args.pointcloud).resolve()),
            "output": str(output),
            "sampled_point_count": int(points_map.shape[0]),
            "frame_index": int(args.frame_index),
            "cameras": {},
        }

        for camera_id, record in selected.items():
            local_manifest = prep.record_manifest(record, manifest)
            image_path = prep.image_path_from_record(record, image_root)
            width, height, fx, fy, cx, cy, distortion = prep.camera_params(record, local_manifest, image_path)
            camera_matrix = np.array([[fx, 0.0, cx], [0.0, fy, cy], [0.0, 0.0, 1.0]], dtype=np.float64)
            dist = np.asarray(distortion, dtype=np.float64).reshape(-1, 1)
            raw = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
            if raw is None:
                raise ValueError(f"failed to read image: {image_path}")
            height, width = raw.shape[:2]
            world_to_camera = prep.matrix_from_record(record)
            points_camera = transform_points(world_to_camera, points_map)

            raw_projected, raw_depth = project_map_points_raw(points_map, world_to_camera, camera_matrix, distortion)
            raw_mask = in_image_mask(raw_projected, raw_depth, width, height)
            raw_path = output / f"{camera_id}_raw_kd.jpg"
            raw_drawn = draw_overlay(raw, raw_projected, raw_mask, raw_path, int(args.max_draw))

            keep_image = cv2.undistort(raw, camera_matrix, dist, None, camera_matrix)
            keep_projected, keep_depth = project_camera_points(points_camera, camera_matrix)
            keep_mask = in_image_mask(keep_projected, keep_depth, width, height)
            keep_path = output / f"{camera_id}_undistort_keep_k.jpg"
            keep_drawn = draw_overlay(keep_image, keep_projected, keep_mask, keep_path, int(args.max_draw))

            optimal_matrix, _roi = cv2.getOptimalNewCameraMatrix(camera_matrix, dist, (width, height), 0, (width, height))
            optimal_image = cv2.undistort(raw, camera_matrix, dist, None, optimal_matrix)
            optimal_projected, optimal_depth = project_camera_points(points_camera, optimal_matrix)
            optimal_mask = in_image_mask(optimal_projected, optimal_depth, width, height)
            optimal_path = output / f"{camera_id}_undistort_optimal.jpg"
            optimal_drawn = draw_overlay(optimal_image, optimal_projected, optimal_mask, optimal_path, int(args.max_draw))

            pose = record.get("pose") if isinstance(record.get("pose"), dict) else {}
            calibration = record.get("camera_calibration") if isinstance(record.get("camera_calibration"), dict) else {}
            summary["cameras"][camera_id] = {
                "physical_direction": PHYSICAL_CAMERA_DIRECTIONS.get(camera_id),
                "extrinsic_direction": extrinsic_direction_summary(camera_id, record),
                "image": str(image_path),
                "image_topic": record.get("image", {}).get("topic") if isinstance(record.get("image"), dict) else None,
                "pose_topic": pose.get("topic"),
                "image_pose_delta_ms": pose.get("image_pose_delta_ms"),
                "calibration_source_path": calibration.get("source_path") or calibration.get("calibration_source_path"),
                "calibration_source_mtime_iso": calibration.get("source_mtime_iso") or calibration.get("calibration_source_mtime_iso"),
                "raw_k": [float(fx), float(fy), float(cx), float(cy)],
                "distortion": [float(item) for item in distortion],
                "optimal_k": [
                    float(optimal_matrix[0, 0]),
                    float(optimal_matrix[1, 1]),
                    float(optimal_matrix[0, 2]),
                    float(optimal_matrix[1, 2]),
                ],
                "counts": {
                    "raw_kd_in_image": int(raw_mask.sum()),
                    "keep_k_in_image": int(keep_mask.sum()),
                    "optimal_in_image": int(optimal_mask.sum()),
                    "valid_depth": int((points_camera[:, 2] > 0.1).sum()),
                },
                "overlays": {
                    "raw_kd": str(raw_path),
                    "undistort_keep_k": str(keep_path),
                    "undistort_optimal": str(optimal_path),
                },
                "drawn_points": {
                    "raw_kd": raw_drawn,
                    "undistort_keep_k": keep_drawn,
                    "undistort_optimal": optimal_drawn,
                },
            }

        with (output / "projection_summary.json").open("w", encoding="utf-8") as handle:
            json.dump(summary, handle, ensure_ascii=False, indent=2)
        return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate 3DGS map-to-camera projection diagnostics.")
    parser.add_argument("--image-pose", required=True)
    parser.add_argument("--pointcloud", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--cameras", default="camera1,camera2,camera3,camera4")
    parser.add_argument("--frame-index", type=int, default=0)
    parser.add_argument("--max-points", type=int, default=80000)
    parser.add_argument("--max-draw", type=int, default=5000)
    args = parser.parse_args()
    print(json.dumps(run(args), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
