#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import math
import tempfile
import time
from pathlib import Path

import cv2
import numpy as np

import prepare_3dgs_colmap as prep


CAMERA_ORDER = ["camera1", "camera2", "camera3", "camera4"]


def skew(vector: np.ndarray) -> np.ndarray:
    x, y, z = [float(value) for value in vector]
    return np.asarray([[0.0, -z, y], [z, 0.0, -x], [-y, x, 0.0]], dtype=np.float64)


def sampson_errors(matrix: np.ndarray, points_a: np.ndarray, points_b: np.ndarray) -> np.ndarray:
    ones = np.ones((points_a.shape[0], 1), dtype=np.float64)
    x_a = np.hstack([points_a.astype(np.float64), ones])
    x_b = np.hstack([points_b.astype(np.float64), ones])
    fxa = (matrix @ x_a.T).T
    ftxb = (matrix.T @ x_b.T).T
    numerator = np.sum(x_b * fxa, axis=1) ** 2
    denominator = fxa[:, 0] ** 2 + fxa[:, 1] ** 2 + ftxb[:, 0] ** 2 + ftxb[:, 1] ** 2
    return numerator / np.maximum(denominator, 1e-12)


def essential_from_world_to_camera(world_to_camera_a: np.ndarray, world_to_camera_b: np.ndarray) -> np.ndarray:
    rotation_a = world_to_camera_a[:3, :3]
    rotation_b = world_to_camera_b[:3, :3]
    translation_a = world_to_camera_a[:3, 3]
    translation_b = world_to_camera_b[:3, 3]
    rotation_ba = rotation_b @ rotation_a.T
    translation_ba = translation_b - rotation_ba @ translation_a
    essential = skew(translation_ba) @ rotation_ba
    norm = float(np.linalg.norm(essential))
    if norm > 0:
        essential /= norm
    return essential


def percentile(values: list[float] | np.ndarray, q: float) -> float | None:
    array = np.asarray(values, dtype=np.float64)
    if array.size == 0:
        return None
    return round(float(np.percentile(array, q)), 6)


def resize_for_features(image: np.ndarray, max_width: int) -> tuple[np.ndarray, tuple[float, float]]:
    height, width = image.shape[:2]
    if max_width <= 0 or width <= max_width:
        return image, (1.0, 1.0)
    scale = max_width / width
    resized = cv2.resize(image, (int(round(width * scale)), int(round(height * scale))), interpolation=cv2.INTER_AREA)
    return resized, (scale, scale)


def make_detector(args: argparse.Namespace):
    if args.detector == "sift" and hasattr(cv2, "SIFT_create"):
        return "sift", cv2.SIFT_create(nfeatures=args.max_features, contrastThreshold=args.sift_contrast)
    return "orb", cv2.ORB_create(nfeatures=args.max_features, fastThreshold=args.orb_fast_threshold)


def scaled_k(params: tuple[int, int, float, float, float, float, list[float]], scale: tuple[float, float]) -> np.ndarray:
    _width, _height, fx, fy, cx, cy, _distortion = params
    scale_x, scale_y = scale
    return np.asarray(
        [[fx * scale_x, 0.0, cx * scale_x], [0.0, fy * scale_y, cy * scale_y], [0.0, 0.0, 1.0]],
        dtype=np.float64,
    )


def normalize_points(points: np.ndarray, params: tuple[int, int, float, float, float, float, list[float]], scale: tuple[float, float]) -> np.ndarray:
    if points.size == 0:
        return points.astype(np.float64)
    k_matrix = scaled_k(params, scale)
    distortion = np.asarray(params[6], dtype=np.float64)
    if distortion.size and np.max(np.abs(distortion)) > 1e-12:
        normalized = cv2.undistortPoints(points.reshape(-1, 1, 2).astype(np.float64), k_matrix, distortion)
        return normalized.reshape(-1, 2)
    ones = np.ones((points.shape[0], 1), dtype=np.float64)
    homogeneous = np.hstack([points.astype(np.float64), ones])
    normalized = (np.linalg.inv(k_matrix) @ homogeneous.T).T
    return normalized[:, :2] / normalized[:, 2:3]


def load_feature(frame: dict, args: argparse.Namespace, detector_name: str, detector) -> dict | None:
    image = cv2.imread(str(frame["image_path"]), cv2.IMREAD_GRAYSCALE)
    if image is None:
        return None
    resized, scale = resize_for_features(image, args.feature_max_width)
    if args.equalize_hist:
        resized = cv2.equalizeHist(resized)
    keypoints, descriptors = detector.detectAndCompute(resized, None)
    return {
        "frame": frame,
        "scale": scale,
        "keypoints": keypoints or [],
        "descriptors": descriptors,
    }


def match_features(features_a: dict, features_b: dict, detector_name: str, args: argparse.Namespace) -> tuple[np.ndarray, np.ndarray]:
    desc_a = features_a["descriptors"]
    desc_b = features_b["descriptors"]
    if desc_a is None or desc_b is None or len(desc_a) < 2 or len(desc_b) < 2:
        return np.empty((0, 2), dtype=np.float32), np.empty((0, 2), dtype=np.float32)
    matcher = cv2.BFMatcher(cv2.NORM_L2 if detector_name == "sift" else cv2.NORM_HAMMING)
    pairs = matcher.knnMatch(desc_a, desc_b, k=2)
    matches = [first for first, second in pairs if first.distance < args.ratio_test * second.distance]
    matches = sorted(matches, key=lambda item: item.distance)
    if args.max_matches > 0:
        matches = matches[: args.max_matches]
    points_a = np.asarray([features_a["keypoints"][match.queryIdx].pt for match in matches], dtype=np.float32)
    points_b = np.asarray([features_b["keypoints"][match.trainIdx].pt for match in matches], dtype=np.float32)
    return points_a, points_b


def selected_pairs(frames: list[dict], args: argparse.Namespace) -> list[tuple[dict, dict]]:
    pairs = list(zip(frames[:-1], frames[1:]))
    if args.pair_stride > 1:
        pairs = pairs[:: args.pair_stride]
    if args.max_pairs_per_camera > 0 and len(pairs) > args.max_pairs_per_camera:
        indexes = np.linspace(0, len(pairs) - 1, args.max_pairs_per_camera, dtype=int).tolist()
        seen: set[int] = set()
        pairs = [pairs[index] for index in indexes if not (index in seen or seen.add(index))]
    return pairs


def world_to_camera_for(frame: dict, pose_history: list[dict], offset_s: float) -> np.ndarray | None:
    try:
        world_to_camera, _pose_mode, _gap_ms = prep.matrix_from_record(
            frame["record"],
            pose_history,
            frame["manifest"],
            timestamp_offset_s=offset_s,
        )
        return world_to_camera
    except Exception:
        return None


def score_pair(pair: dict, pose_history: list[dict], offset_s: float) -> dict | None:
    world_to_camera_a = world_to_camera_for(pair["frame_a"], pose_history, offset_s)
    world_to_camera_b = world_to_camera_for(pair["frame_b"], pose_history, offset_s)
    if world_to_camera_a is None or world_to_camera_b is None:
        return None
    essential = essential_from_world_to_camera(world_to_camera_a, world_to_camera_b)
    errors = np.sqrt(sampson_errors(essential, pair["normalized_a"], pair["normalized_b"])) * 1000.0
    if errors.size == 0:
        return None
    return {
        "median_mrad": float(np.median(errors)),
        "p75_mrad": float(np.percentile(errors, 75)),
        "p90_mrad": float(np.percentile(errors, 90)),
        "inlier_ratio_2mrad": float(np.mean(errors < 2.0)),
        "inlier_ratio_5mrad": float(np.mean(errors < 5.0)),
    }


def make_offsets(args: argparse.Namespace) -> list[float]:
    start = -abs(args.offset_range_ms)
    stop = abs(args.offset_range_ms)
    step = max(1.0, abs(args.offset_step_ms))
    values = [start + index * step for index in range(int(math.floor((stop - start) / step)) + 1)]
    values.append(0.0)
    return [value / 1000.0 for value in sorted({round(value, 6) for value in values})]


def prepare_frames(image_root: Path, manifest: dict, records: list[dict]) -> dict[str, list[dict]]:
    frames_by_camera: dict[str, list[dict]] = {}
    for index, record in enumerate(records):
        local_manifest = prep.record_manifest(record, manifest)
        camera_name = prep.record_camera_id(record, local_manifest)
        timestamp_s = prep.record_image_timestamp_s(record)
        if timestamp_s is None:
            continue
        image_path = prep.image_path_from_record(record, image_root)
        params = prep.camera_params(record, local_manifest, image_path)
        frames_by_camera.setdefault(camera_name, []).append(
            {
                "index": index,
                "record": record,
                "manifest": local_manifest,
                "camera_name": camera_name,
                "timestamp_s": timestamp_s,
                "image_path": image_path,
                "params": params,
            }
        )
    for frames in frames_by_camera.values():
        frames.sort(key=lambda item: item["timestamp_s"])
    return frames_by_camera


def build_pair_observations(frames_by_camera: dict[str, list[dict]], args: argparse.Namespace) -> tuple[dict[str, list[dict]], dict]:
    detector_name, detector = make_detector(args)
    feature_cache: dict[int, dict | None] = {}
    pairs_by_camera: dict[str, list[dict]] = {}
    stats = {"detector": detector_name, "candidate_pairs": {}, "usable_pairs": {}}

    def features_for(frame: dict) -> dict | None:
        key = frame["index"]
        if key not in feature_cache:
            feature_cache[key] = load_feature(frame, args, detector_name, detector)
        return feature_cache[key]

    for camera_name in CAMERA_ORDER:
        frames = frames_by_camera.get(camera_name, [])
        candidate_pairs = selected_pairs(frames, args)
        stats["candidate_pairs"][camera_name] = len(candidate_pairs)
        usable_pairs: list[dict] = []
        for frame_a, frame_b in candidate_pairs:
            features_a = features_for(frame_a)
            features_b = features_for(frame_b)
            if features_a is None or features_b is None:
                continue
            points_a, points_b = match_features(features_a, features_b, detector_name, args)
            if points_a.shape[0] < args.min_matches:
                continue
            _fundamental, mask = cv2.findFundamentalMat(
                points_a,
                points_b,
                cv2.FM_RANSAC,
                ransacReprojThreshold=args.ransac_threshold_px,
                confidence=0.999,
            )
            if mask is None:
                continue
            inlier_mask = mask.ravel().astype(bool)
            if int(inlier_mask.sum()) < args.min_ransac_inliers:
                continue
            inlier_a = points_a[inlier_mask]
            inlier_b = points_b[inlier_mask]
            usable_pairs.append(
                {
                    "frame_a": frame_a,
                    "frame_b": frame_b,
                    "match_count": int(points_a.shape[0]),
                    "ransac_inliers": int(inlier_mask.sum()),
                    "normalized_a": normalize_points(inlier_a, frame_a["params"], features_a["scale"]),
                    "normalized_b": normalize_points(inlier_b, frame_b["params"], features_b["scale"]),
                }
            )
        pairs_by_camera[camera_name] = usable_pairs
        stats["usable_pairs"][camera_name] = len(usable_pairs)
    return pairs_by_camera, stats


def optimize_offsets(pairs_by_camera: dict[str, list[dict]], pose_history: list[dict], offsets_s: list[float]) -> tuple[list[dict], dict]:
    rows: list[dict] = []
    best_offsets_ms: dict[str, float] = {}
    per_camera: dict[str, dict] = {}
    for camera_name in CAMERA_ORDER:
        pairs = pairs_by_camera.get(camera_name, [])
        camera_rows: list[dict] = []
        for offset_s in offsets_s:
            pair_scores = []
            for pair in pairs:
                score = score_pair(pair, pose_history, offset_s)
                if score is not None:
                    pair_scores.append(score)
            medians = [item["median_mrad"] for item in pair_scores]
            row = {
                "camera_name": camera_name,
                "offset_ms": round(offset_s * 1000.0, 6),
                "scored_pairs": len(pair_scores),
                "score_median_mrad": percentile(medians, 50),
                "score_p75_mrad": percentile(medians, 75),
                "score_p90_mrad": percentile(medians, 90),
                "inlier_ratio_2mrad_median": percentile([item["inlier_ratio_2mrad"] for item in pair_scores], 50),
                "inlier_ratio_5mrad_median": percentile([item["inlier_ratio_5mrad"] for item in pair_scores], 50),
            }
            rows.append(row)
            camera_rows.append(row)
        valid_rows = [row for row in camera_rows if row["score_median_mrad"] is not None and row["scored_pairs"] > 0]
        if not valid_rows:
            per_camera[camera_name] = {"status": "no_usable_pairs", "best_offset_ms": 0.0}
            best_offsets_ms[camera_name] = 0.0
            continue
        best = min(valid_rows, key=lambda item: (item["score_median_mrad"], -item["scored_pairs"]))
        zero = min(valid_rows, key=lambda item: abs(item["offset_ms"]))
        best_offsets_ms[camera_name] = float(best["offset_ms"])
        improvement = None
        if zero["score_median_mrad"] and best["score_median_mrad"] is not None:
            improvement = float(zero["score_median_mrad"]) - float(best["score_median_mrad"])
        per_camera[camera_name] = {
            "status": "ok",
            "best_offset_ms": best["offset_ms"],
            "best_score_median_mrad": best["score_median_mrad"],
            "zero_score_median_mrad": zero["score_median_mrad"],
            "improvement_mrad": round(improvement, 6) if improvement is not None else None,
            "scored_pairs_at_best": best["scored_pairs"],
        }
    return rows, {"camera_offsets_ms": best_offsets_ms, "per_camera": per_camera}


def main() -> int:
    parser = argparse.ArgumentParser(description="Estimate per-camera timestamp offsets for 3DGS pose-history interpolation.")
    parser.add_argument("--image-pose", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--detector", choices=["sift", "orb"], default="sift")
    parser.add_argument("--feature-max-width", type=int, default=960)
    parser.add_argument("--max-features", type=int, default=2000)
    parser.add_argument("--max-matches", type=int, default=600)
    parser.add_argument("--ratio-test", type=float, default=0.75)
    parser.add_argument("--pair-stride", type=int, default=8)
    parser.add_argument("--max-pairs-per-camera", type=int, default=80)
    parser.add_argument("--min-matches", type=int, default=40)
    parser.add_argument("--min-ransac-inliers", type=int, default=30)
    parser.add_argument("--ransac-threshold-px", type=float, default=2.5)
    parser.add_argument("--offset-range-ms", type=float, default=250.0)
    parser.add_argument("--offset-step-ms", type=float, default=25.0)
    parser.add_argument("--sift-contrast", type=float, default=0.012)
    parser.add_argument("--orb-fast-threshold", type=int, default=12)
    parser.add_argument("--equalize-hist", action="store_true")
    args = parser.parse_args()

    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="three_dgs_pose_time_offsets_") as tmp:
        image_root = prep.extract_archive(args.image_pose.resolve(), Path(tmp))
        manifest, records = prep.load_records(image_root)
        pose_history = prep.load_pose_history(image_root)
        if not pose_history:
            raise ValueError("image-pose package does not contain shared_context/pose_history.jsonl")
        frames_by_camera = prepare_frames(image_root, manifest, records)
        pairs_by_camera, pair_stats = build_pair_observations(frames_by_camera, args)
        rows, optimized = optimize_offsets(pairs_by_camera, pose_history, make_offsets(args))

    csv_path = output / "offset_metrics.csv"
    with csv_path.open("w", encoding="utf-8", newline="") as handle:
        fieldnames = sorted({key for row in rows for key in row.keys()})
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    offsets_path = output / "pose_time_offsets.json"
    offsets_payload = {
        "schema": "jgzj.three_dgs.pose_time_offsets.v1",
        "generated_at_unix": time.time(),
        "camera_offsets_ms": optimized["camera_offsets_ms"],
        "note": "Apply with prepare_3dgs_colmap.py --pose-time-offsets-json. Offsets are added to image timestamps before pose_history interpolation.",
    }
    offsets_path.write_text(json.dumps(offsets_payload, ensure_ascii=False, indent=2), encoding="utf-8")

    summary = {
        "image_pose": str(args.image_pose.resolve()),
        "offset_metrics_csv": str(csv_path),
        "pose_time_offsets_json": str(offsets_path),
        "pair_stats": pair_stats,
        "per_camera": optimized["per_camera"],
        "args": {key: str(value) if isinstance(value, Path) else value for key, value in vars(args).items()},
    }
    summary_path = output / "summary.json"
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
