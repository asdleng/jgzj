#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import math
import re
from pathlib import Path

import cv2
import numpy as np

from diagnose_3dgs_reprojection import CAMERA_ORDER, read_cameras, read_images


def numeric_key(value: str) -> tuple[int, str]:
    match = re.search(r"(\d+)", value)
    if match:
        return (int(match.group(1)), value)
    return (10**12, value)


def intrinsics(camera: dict, scale_x: float = 1.0, scale_y: float = 1.0) -> np.ndarray:
    return np.asarray(
        [
            [camera["fx"] * scale_x, 0.0, camera["cx"] * scale_x],
            [0.0, camera["fy"] * scale_y, camera["cy"] * scale_y],
            [0.0, 0.0, 1.0],
        ],
        dtype=np.float64,
    )


def skew(vector: np.ndarray) -> np.ndarray:
    x, y, z = [float(value) for value in vector]
    return np.asarray([[0.0, -z, y], [z, 0.0, -x], [-y, x, 0.0]], dtype=np.float64)


def relative_pose(frame_a: dict, frame_b: dict) -> tuple[np.ndarray, np.ndarray]:
    rotation_a = frame_a["rotation"]
    rotation_b = frame_b["rotation"]
    translation_a = frame_a["tvec"]
    translation_b = frame_b["tvec"]
    rotation_ba = rotation_b @ rotation_a.T
    translation_ba = translation_b - rotation_ba @ translation_a
    return rotation_ba, translation_ba


def essential_from_pose(frame_a: dict, frame_b: dict) -> np.ndarray:
    rotation_ba, translation_ba = relative_pose(frame_a, frame_b)
    essential = skew(translation_ba) @ rotation_ba
    norm = np.linalg.norm(essential)
    if norm > 0:
        essential /= norm
    return essential


def fundamental_from_pose(frame_a: dict, frame_b: dict, scale_a: tuple[float, float], scale_b: tuple[float, float]) -> np.ndarray:
    rotation_ba, translation_ba = relative_pose(frame_a, frame_b)
    essential = skew(translation_ba) @ rotation_ba
    k_a = intrinsics(frame_a["camera"], scale_a[0], scale_a[1])
    k_b = intrinsics(frame_b["camera"], scale_b[0], scale_b[1])
    fundamental = np.linalg.inv(k_b).T @ essential @ np.linalg.inv(k_a)
    norm = np.linalg.norm(fundamental)
    if norm > 0:
        fundamental /= norm
    return fundamental


def normalize_image_points(points: np.ndarray, k_matrix: np.ndarray) -> np.ndarray:
    if points.size == 0:
        return points.astype(np.float64)
    ones = np.ones((points.shape[0], 1), dtype=np.float64)
    homogeneous = np.hstack([points.astype(np.float64), ones])
    normalized = (np.linalg.inv(k_matrix) @ homogeneous.T).T
    return normalized[:, :2] / normalized[:, 2:3]


def rotation_angle_deg(rotation: np.ndarray) -> float:
    trace = float(np.trace(rotation))
    cosine = np.clip((trace - 1.0) * 0.5, -1.0, 1.0)
    return float(math.degrees(math.acos(cosine)))


def sampson_errors(fundamental: np.ndarray, points_a: np.ndarray, points_b: np.ndarray) -> np.ndarray:
    ones = np.ones((points_a.shape[0], 1), dtype=np.float64)
    x_a = np.hstack([points_a.astype(np.float64), ones])
    x_b = np.hstack([points_b.astype(np.float64), ones])
    fxa = (fundamental @ x_a.T).T
    ftxb = (fundamental.T @ x_b.T).T
    numerator = np.sum(x_b * fxa, axis=1) ** 2
    denominator = fxa[:, 0] ** 2 + fxa[:, 1] ** 2 + ftxb[:, 0] ** 2 + ftxb[:, 1] ** 2
    return numerator / np.maximum(denominator, 1e-12)


def resize_for_features(image: np.ndarray, max_width: int) -> tuple[np.ndarray, tuple[float, float]]:
    height, width = image.shape[:2]
    if max_width <= 0 or width <= max_width:
        return image, (1.0, 1.0)
    scale = max_width / width
    resized = cv2.resize(image, (int(round(width * scale)), int(round(height * scale))), interpolation=cv2.INTER_AREA)
    return resized, (scale, scale)


def make_detector(args: argparse.Namespace):
    if hasattr(cv2, "SIFT_create") and args.detector == "sift":
        return "sift", cv2.SIFT_create(nfeatures=args.max_features, contrastThreshold=args.sift_contrast)
    return "orb", cv2.ORB_create(nfeatures=args.max_features, fastThreshold=args.orb_fast_threshold)


def load_features(frame: dict, image_path: Path, args: argparse.Namespace, detector_name: str, detector) -> dict | None:
    image = cv2.imread(str(image_path), cv2.IMREAD_GRAYSCALE)
    if image is None:
        return None
    resized, scale = resize_for_features(image, args.feature_max_width)
    if args.equalize_hist:
        resized = cv2.equalizeHist(resized)
    keypoints, descriptors = detector.detectAndCompute(resized, None)
    points = np.asarray([kp.pt for kp in keypoints], dtype=np.float32) if keypoints else np.empty((0, 2), dtype=np.float32)
    return {
        "frame": frame,
        "image": resized,
        "scale": scale,
        "keypoints": keypoints,
        "points": points,
        "descriptors": descriptors,
        "detector": detector_name,
    }


def match_features(features_a: dict, features_b: dict, detector_name: str, args: argparse.Namespace) -> tuple[np.ndarray, np.ndarray, list[cv2.DMatch]]:
    desc_a = features_a["descriptors"]
    desc_b = features_b["descriptors"]
    if desc_a is None or desc_b is None or len(desc_a) < 2 or len(desc_b) < 2:
        return np.empty((0, 2), dtype=np.float32), np.empty((0, 2), dtype=np.float32), []

    if detector_name == "sift":
        matcher = cv2.BFMatcher(cv2.NORM_L2)
        pairs = matcher.knnMatch(desc_a, desc_b, k=2)
        matches = [first for first, second in pairs if first.distance < args.ratio_test * second.distance]
    else:
        matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
        pairs = matcher.knnMatch(desc_a, desc_b, k=2)
        matches = [first for first, second in pairs if first.distance < args.ratio_test * second.distance]

    matches = sorted(matches, key=lambda item: item.distance)
    if args.max_matches > 0:
        matches = matches[: args.max_matches]
    points_a = np.asarray([features_a["keypoints"][match.queryIdx].pt for match in matches], dtype=np.float32)
    points_b = np.asarray([features_b["keypoints"][match.trainIdx].pt for match in matches], dtype=np.float32)
    return points_a, points_b, matches


def percentile(values: np.ndarray, q: float) -> float | None:
    if values.size == 0:
        return None
    return round(float(np.percentile(values, q)), 4)


def pair_status(row: dict, args: argparse.Namespace) -> str:
    if row["matches"] < args.min_matches:
        return "weak_features"
    if row["ransac_inlier_ratio"] is not None and row["ransac_inlier_ratio"] < args.min_ransac_inlier_ratio:
        return "weak_visual_match"
    pose_inlier_ratio = row["ransac_pose_inlier_ratio_5px"]
    pose_median = row["ransac_pose_sampson_sqrt_median_px"]
    if pose_inlier_ratio is None:
        pose_inlier_ratio = row["pose_inlier_ratio_5px"]
    if pose_median is None:
        pose_median = row["sampson_sqrt_median_px"]
    if pose_inlier_ratio is not None and pose_inlier_ratio < args.min_pose_inlier_ratio:
        return "pose_inconsistent"
    if pose_median is not None and pose_median > args.max_good_median_px:
        return "pose_noisy"
    return "ok"


def analyze_pair(features_a: dict, features_b: dict, detector_name: str, args: argparse.Namespace) -> tuple[dict, np.ndarray, np.ndarray, np.ndarray, list[cv2.DMatch]]:
    frame_a = features_a["frame"]
    frame_b = features_b["frame"]
    points_a, points_b, matches = match_features(features_a, features_b, detector_name, args)
    rotation_ba, translation_ba = relative_pose(frame_a, frame_b)
    delta_translation = float(np.linalg.norm(translation_ba))
    delta_rotation = rotation_angle_deg(rotation_ba)

    row = {
        "camera_name": frame_a["camera_name"],
        "image_id_a": frame_a["image_id"],
        "image_id_b": frame_b["image_id"],
        "capture_key_a": frame_a["capture_key"],
        "capture_key_b": frame_b["capture_key"],
        "image_name_a": frame_a["name"],
        "image_name_b": frame_b["name"],
        "features_a": int(len(features_a["keypoints"])),
        "features_b": int(len(features_b["keypoints"])),
        "matches": int(len(matches)),
        "delta_translation_m": round(delta_translation, 6),
        "delta_rotation_deg": round(delta_rotation, 6),
        "sampson_sqrt_median_px": None,
        "sampson_sqrt_p75_px": None,
        "sampson_sqrt_p90_px": None,
        "sampson_sqrt_p95_px": None,
        "pose_inlier_ratio_2px": None,
        "pose_inlier_ratio_5px": None,
        "pose_inlier_ratio_10px": None,
        "norm_sampson_sqrt_median_mrad": None,
        "norm_sampson_sqrt_p90_mrad": None,
        "ransac_inliers": None,
        "ransac_inlier_ratio": None,
        "ransac_pose_sampson_sqrt_median_px": None,
        "ransac_pose_sampson_sqrt_p90_px": None,
        "ransac_pose_inlier_ratio_2px": None,
        "ransac_pose_inlier_ratio_5px": None,
        "ransac_pose_inlier_ratio_10px": None,
        "ransac_norm_sampson_sqrt_median_mrad": None,
        "ransac_norm_sampson_sqrt_p90_mrad": None,
    }

    errors = np.empty(0, dtype=np.float64)
    normalized_errors = np.empty(0, dtype=np.float64)
    if len(matches) >= 8:
        fundamental = fundamental_from_pose(frame_a, frame_b, features_a["scale"], features_b["scale"])
        errors = np.sqrt(sampson_errors(fundamental, points_a, points_b))
        essential = essential_from_pose(frame_a, frame_b)
        k_a = intrinsics(frame_a["camera"], features_a["scale"][0], features_a["scale"][1])
        k_b = intrinsics(frame_b["camera"], features_b["scale"][0], features_b["scale"][1])
        normalized_a = normalize_image_points(points_a, k_a)
        normalized_b = normalize_image_points(points_b, k_b)
        normalized_errors = np.sqrt(sampson_errors(essential, normalized_a, normalized_b)) * 1000.0
        row.update(
            {
                "sampson_sqrt_median_px": percentile(errors, 50),
                "sampson_sqrt_p75_px": percentile(errors, 75),
                "sampson_sqrt_p90_px": percentile(errors, 90),
                "sampson_sqrt_p95_px": percentile(errors, 95),
                "pose_inlier_ratio_2px": round(float(np.mean(errors < 2.0)), 4),
                "pose_inlier_ratio_5px": round(float(np.mean(errors < 5.0)), 4),
                "pose_inlier_ratio_10px": round(float(np.mean(errors < 10.0)), 4),
                "norm_sampson_sqrt_median_mrad": percentile(normalized_errors, 50),
                "norm_sampson_sqrt_p90_mrad": percentile(normalized_errors, 90),
            }
        )
        if len(matches) >= args.min_matches_for_ransac:
            _fundamental_ransac, mask = cv2.findFundamentalMat(
                points_a,
                points_b,
                cv2.FM_RANSAC,
                ransacReprojThreshold=args.ransac_threshold_px,
                confidence=0.999,
            )
            if mask is not None:
                inlier_mask = mask.ravel().astype(bool)
                inliers = int(inlier_mask.sum())
                row["ransac_inliers"] = inliers
                row["ransac_inlier_ratio"] = round(inliers / max(1, len(matches)), 4)
                if inliers >= 8:
                    inlier_errors = errors[inlier_mask]
                    inlier_normalized_errors = normalized_errors[inlier_mask]
                    row.update(
                        {
                            "ransac_pose_sampson_sqrt_median_px": percentile(inlier_errors, 50),
                            "ransac_pose_sampson_sqrt_p90_px": percentile(inlier_errors, 90),
                            "ransac_pose_inlier_ratio_2px": round(float(np.mean(inlier_errors < 2.0)), 4),
                            "ransac_pose_inlier_ratio_5px": round(float(np.mean(inlier_errors < 5.0)), 4),
                            "ransac_pose_inlier_ratio_10px": round(float(np.mean(inlier_errors < 10.0)), 4),
                            "ransac_norm_sampson_sqrt_median_mrad": percentile(inlier_normalized_errors, 50),
                            "ransac_norm_sampson_sqrt_p90_mrad": percentile(inlier_normalized_errors, 90),
                        }
                    )

    row["status"] = pair_status(row, args)
    return row, points_a, points_b, errors, matches


def draw_match_sheet(features_a: dict, features_b: dict, points_a: np.ndarray, points_b: np.ndarray, errors: np.ndarray, row: dict, args: argparse.Namespace) -> np.ndarray:
    image_a = cv2.cvtColor(features_a["image"], cv2.COLOR_GRAY2BGR)
    image_b = cv2.cvtColor(features_b["image"], cv2.COLOR_GRAY2BGR)
    height = max(image_a.shape[0], image_b.shape[0])
    width = image_a.shape[1] + image_b.shape[1]
    output = np.zeros((height, width, 3), dtype=np.uint8)
    output[: image_a.shape[0], : image_a.shape[1]] = image_a
    output[: image_b.shape[0], image_a.shape[1] :] = image_b

    if points_a.size and points_b.size:
        if errors.size == points_a.shape[0]:
            order = np.argsort(errors)[-args.draw_matches :]
        else:
            order = np.arange(min(args.draw_matches, points_a.shape[0]))
        for index in order:
            pa = tuple(np.round(points_a[index]).astype(int))
            pb_raw = np.round(points_b[index]).astype(int)
            pb = (int(pb_raw[0] + image_a.shape[1]), int(pb_raw[1]))
            error = float(errors[index]) if errors.size == points_a.shape[0] else 999.0
            color = (60, 220, 80) if error < 5.0 else (40, 160, 255) if error < 15.0 else (40, 40, 255)
            cv2.circle(output, pa, 3, color, -1, lineType=cv2.LINE_AA)
            cv2.circle(output, pb, 3, color, -1, lineType=cv2.LINE_AA)
            cv2.line(output, pa, pb, color, 1, lineType=cv2.LINE_AA)

    label = (
        f"{row['camera_name']} {row['capture_key_a']}->{row['capture_key_b']} "
        f"matches={row['matches']} rmed={row['ransac_pose_sampson_sqrt_median_px']}px "
        f"rp5={row['ransac_pose_inlier_ratio_5px']} allmed={row['sampson_sqrt_median_px']}px "
        f"ransac={row['ransac_inlier_ratio']} status={row['status']}"
    )
    cv2.rectangle(output, (0, 0), (output.shape[1], 36), (0, 0, 0), -1)
    cv2.putText(output, label, (12, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.62, (255, 255, 255), 1, cv2.LINE_AA)
    return output


def draw_xy_trajectory(frames_by_camera: dict[str, list[dict]], rows: list[dict], output_path: Path) -> None:
    positions = []
    for frames in frames_by_camera.values():
        positions.extend([frame["position"][:2] for frame in frames])
    if not positions:
        return
    xy = np.vstack(positions)
    min_xy = xy.min(axis=0)
    max_xy = xy.max(axis=0)
    span = np.maximum(max_xy - min_xy, 1.0)
    width, height = 1400, 900
    pad = 70

    def to_px(point: np.ndarray) -> tuple[int, int]:
        norm = (point[:2] - min_xy) / span
        x = int(pad + norm[0] * (width - 2 * pad))
        y = int(height - pad - norm[1] * (height - 2 * pad))
        return x, y

    canvas = np.zeros((height, width, 3), dtype=np.uint8)
    canvas[:] = (18, 24, 34)
    colors = {
        "camera1": (80, 220, 255),
        "camera2": (255, 120, 120),
        "camera3": (150, 255, 120),
        "camera4": (220, 140, 255),
    }
    row_lookup = {(row["camera_name"], row["capture_key_a"], row["capture_key_b"]): row for row in rows}
    for camera_name, frames in frames_by_camera.items():
        color = colors.get(camera_name, (220, 220, 220))
        for frame_a, frame_b in zip(frames[:-1], frames[1:]):
            pa = to_px(frame_a["position"])
            pb = to_px(frame_b["position"])
            row = row_lookup.get((camera_name, frame_a["capture_key"], frame_b["capture_key"]))
            segment_color = color
            if row and row.get("status") in {"pose_inconsistent", "pose_noisy"}:
                segment_color = (40, 40, 255)
            elif row and row.get("status") == "weak_visual_match":
                segment_color = (40, 180, 255)
            cv2.line(canvas, pa, pb, segment_color, 2, lineType=cv2.LINE_AA)
        for index, frame in enumerate(frames):
            if index % max(1, len(frames) // 30) == 0:
                cv2.circle(canvas, to_px(frame["position"]), 3, color, -1, lineType=cv2.LINE_AA)
        if frames:
            cv2.putText(canvas, camera_name, to_px(frames[0]["position"] + np.asarray([0.05, 0.05, 0.0])), cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2)

    legend_y = 36
    cv2.putText(canvas, "XY camera trajectories; red/orange segments are visually inconsistent diagnostics", (24, legend_y), cv2.FONT_HERSHEY_SIMPLEX, 0.75, (255, 255, 255), 2)
    legend_y += 34
    for camera_name in CAMERA_ORDER:
        cv2.putText(canvas, camera_name, (24, legend_y), cv2.FONT_HERSHEY_SIMPLEX, 0.7, colors[camera_name], 2)
        legend_y += 28
    cv2.imwrite(str(output_path), canvas, [cv2.IMWRITE_JPEG_QUALITY, 94])


def selected_pairs(frames: list[dict], args: argparse.Namespace) -> list[tuple[dict, dict]]:
    pairs = list(zip(frames[:-1], frames[1:]))
    if args.pair_stride > 1:
        pairs = pairs[:: args.pair_stride]
    if args.max_pairs_per_camera > 0 and len(pairs) > args.max_pairs_per_camera:
        indexes = np.linspace(0, len(pairs) - 1, args.max_pairs_per_camera, dtype=int).tolist()
        seen = set()
        pairs = [pairs[index] for index in indexes if not (index in seen or seen.add(index))]
    return pairs


def summarize(rows: list[dict], frames_by_camera: dict[str, list[dict]]) -> dict:
    per_camera = {}
    for camera_name in CAMERA_ORDER:
        camera_rows = [row for row in rows if row["camera_name"] == camera_name]
        frames = frames_by_camera.get(camera_name, [])
        if not frames:
            continue
        positions = np.vstack([frame["position"] for frame in frames])
        steps = np.linalg.norm(np.diff(positions, axis=0), axis=1) if len(frames) > 1 else np.empty(0)
        valid_pose_rows = [row for row in camera_rows if row["sampson_sqrt_median_px"] is not None]
        per_camera[camera_name] = {
            "frames": len(frames),
            "analyzed_pairs": len(camera_rows),
            "path_length_m": round(float(steps.sum()), 4) if steps.size else 0.0,
            "step_median_m": percentile(steps, 50),
            "step_p90_m": percentile(steps, 90),
            "features_median": percentile(np.asarray([row["features_a"] for row in camera_rows], dtype=np.float64), 50),
            "matches_median": percentile(np.asarray([row["matches"] for row in camera_rows], dtype=np.float64), 50),
            "pose_error_median_px": percentile(np.asarray([row["sampson_sqrt_median_px"] for row in valid_pose_rows], dtype=np.float64), 50),
            "pose_error_p90_px": percentile(np.asarray([row["sampson_sqrt_p90_px"] for row in valid_pose_rows], dtype=np.float64), 50),
            "pose_5px_inlier_ratio_median": percentile(np.asarray([row["pose_inlier_ratio_5px"] for row in valid_pose_rows], dtype=np.float64), 50),
            "ransac_pose_error_median_px": percentile(
                np.asarray([row["ransac_pose_sampson_sqrt_median_px"] for row in valid_pose_rows if row["ransac_pose_sampson_sqrt_median_px"] is not None], dtype=np.float64),
                50,
            ),
            "ransac_normalized_pose_error_median_mrad": percentile(
                np.asarray([row["ransac_norm_sampson_sqrt_median_mrad"] for row in valid_pose_rows if row["ransac_norm_sampson_sqrt_median_mrad"] is not None], dtype=np.float64),
                50,
            ),
            "ransac_pose_5px_inlier_ratio_median": percentile(
                np.asarray([row["ransac_pose_inlier_ratio_5px"] for row in valid_pose_rows if row["ransac_pose_inlier_ratio_5px"] is not None], dtype=np.float64),
                50,
            ),
            "ransac_inlier_ratio_median": percentile(
                np.asarray([row["ransac_inlier_ratio"] for row in camera_rows if row["ransac_inlier_ratio"] is not None], dtype=np.float64),
                50,
            ),
            "status_counts": {status: sum(1 for row in camera_rows if row["status"] == status) for status in sorted({row["status"] for row in camera_rows})},
        }
    return per_camera


def main() -> int:
    parser = argparse.ArgumentParser(description="Diagnose 3DGS camera poses with same-camera feature matches.")
    parser.add_argument("--dataset", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--detector", choices=["sift", "orb"], default="sift")
    parser.add_argument("--feature-max-width", type=int, default=960)
    parser.add_argument("--max-features", type=int, default=2500)
    parser.add_argument("--max-matches", type=int, default=700)
    parser.add_argument("--ratio-test", type=float, default=0.75)
    parser.add_argument("--pair-stride", type=int, default=2)
    parser.add_argument("--max-pairs-per-camera", type=int, default=120)
    parser.add_argument("--min-matches", type=int, default=30)
    parser.add_argument("--min-matches-for-ransac", type=int, default=24)
    parser.add_argument("--ransac-threshold-px", type=float, default=2.5)
    parser.add_argument("--min-ransac-inlier-ratio", type=float, default=0.22)
    parser.add_argument("--min-pose-inlier-ratio", type=float, default=0.35)
    parser.add_argument("--max-good-median-px", type=float, default=8.0)
    parser.add_argument("--sift-contrast", type=float, default=0.012)
    parser.add_argument("--orb-fast-threshold", type=int, default=12)
    parser.add_argument("--equalize-hist", action="store_true")
    parser.add_argument("--save-worst-per-camera", type=int, default=8)
    parser.add_argument("--draw-matches", type=int, default=80)
    args = parser.parse_args()

    dataset = args.dataset.resolve()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    matches_dir = output / "matches"
    matches_dir.mkdir(parents=True, exist_ok=True)
    sparse = dataset / "sparse" / "0"
    images_dir = dataset / "images"

    cameras = read_cameras(sparse / "cameras.txt")
    frames = read_images(sparse / "images.txt", cameras)
    frames_by_camera: dict[str, list[dict]] = {}
    for frame in frames:
        frames_by_camera.setdefault(frame["camera_name"], []).append(frame)
    for camera_name in list(frames_by_camera):
        frames_by_camera[camera_name].sort(key=lambda frame: (numeric_key(frame["capture_key"]), frame["image_id"]))

    detector_name, detector = make_detector(args)
    feature_cache: dict[int, dict | None] = {}

    def features_for(frame: dict) -> dict | None:
        if frame["image_id"] not in feature_cache:
            feature_cache[frame["image_id"]] = load_features(frame, images_dir / frame["name"], args, detector_name, detector)
        return feature_cache[frame["image_id"]]

    rows: list[dict] = []
    visualization_rows: list[tuple[dict, dict, dict, np.ndarray, np.ndarray, np.ndarray, list[cv2.DMatch]]] = []
    for camera_name in CAMERA_ORDER:
        frames_for_camera = frames_by_camera.get(camera_name, [])
        for frame_a, frame_b in selected_pairs(frames_for_camera, args):
            features_a = features_for(frame_a)
            features_b = features_for(frame_b)
            if features_a is None or features_b is None:
                continue
            row, points_a, points_b, errors, matches = analyze_pair(features_a, features_b, detector_name, args)
            rows.append(row)
            visualization_rows.append((row, features_a, features_b, points_a, points_b, errors, matches))

    csv_path = output / "pair_metrics.csv"
    with csv_path.open("w", encoding="utf-8", newline="") as handle:
        fieldnames = sorted({key for row in rows for key in row.keys()})
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    for camera_name in CAMERA_ORDER:
        candidates = [item for item in visualization_rows if item[0]["camera_name"] == camera_name and item[0]["sampson_sqrt_median_px"] is not None]
        candidates.sort(key=lambda item: (item[0]["status"] == "ok", -(item[0]["sampson_sqrt_median_px"] or 0), -(item[0]["matches"] or 0)))
        for index, (row, features_a, features_b, points_a, points_b, errors, _matches) in enumerate(candidates[: args.save_worst_per_camera], start=1):
            sheet = draw_match_sheet(features_a, features_b, points_a, points_b, errors, row, args)
            name = f"{camera_name}_{index:02d}_{row['capture_key_a']}_to_{row['capture_key_b']}_{row['status']}.jpg"
            cv2.imwrite(str(matches_dir / name), sheet, [cv2.IMWRITE_JPEG_QUALITY, 92])

    trajectory_path = output / "camera_trajectory_xy.jpg"
    draw_xy_trajectory(frames_by_camera, rows, trajectory_path)

    summary = {
        "dataset": str(dataset),
        "detector": detector_name,
        "feature_max_width": args.feature_max_width,
        "frame_count": len(frames),
        "analyzed_pair_count": len(rows),
        "per_camera": summarize(rows, frames_by_camera),
        "pair_metrics_csv": str(csv_path),
        "matches_dir": str(matches_dir),
        "trajectory_image": str(trajectory_path),
        "interpretation": {
            "ok": "Feature matches agree with the provided camera poses.",
            "pose_noisy": "Matches mostly connect visually, but epipolar error from provided poses is high.",
            "pose_inconsistent": "RANSAC can likely find visual geometry, but provided poses explain too few matches.",
            "weak_visual_match": "The image pair itself is weak or repetitive; do not treat it as pose proof.",
            "weak_features": "Too few matches for a reliable pose check.",
        },
    }
    summary_path = output / "summary.json"
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
