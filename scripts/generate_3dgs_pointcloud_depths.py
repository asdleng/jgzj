#!/usr/bin/env python3
"""Project a COLMAP initialization point cloud into sparse inverse-depth maps."""

from __future__ import annotations

import argparse
import json
import math
import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np


@dataclass
class Camera:
    camera_id: int
    model: str
    width: int
    height: int
    params: tuple[float, ...]


@dataclass
class ImageFrame:
    image_id: int
    qvec: np.ndarray
    tvec: np.ndarray
    camera_id: int
    name: str


def qvec2rotmat(qvec: np.ndarray) -> np.ndarray:
    return np.array(
        [
            [
                1 - 2 * qvec[2] ** 2 - 2 * qvec[3] ** 2,
                2 * qvec[1] * qvec[2] - 2 * qvec[0] * qvec[3],
                2 * qvec[3] * qvec[1] + 2 * qvec[0] * qvec[2],
            ],
            [
                2 * qvec[1] * qvec[2] + 2 * qvec[0] * qvec[3],
                1 - 2 * qvec[1] ** 2 - 2 * qvec[3] ** 2,
                2 * qvec[2] * qvec[3] - 2 * qvec[0] * qvec[1],
            ],
            [
                2 * qvec[3] * qvec[1] - 2 * qvec[0] * qvec[2],
                2 * qvec[2] * qvec[3] + 2 * qvec[0] * qvec[1],
                1 - 2 * qvec[1] ** 2 - 2 * qvec[2] ** 2,
            ],
        ],
        dtype=np.float64,
    )


def read_cameras(path: Path) -> dict[int, Camera]:
    cameras: dict[int, Camera] = {}
    with path.open("r", encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            camera_id = int(parts[0])
            model = parts[1]
            if model != "PINHOLE":
                raise ValueError(f"unsupported camera model {model!r}; expected PINHOLE")
            cameras[camera_id] = Camera(
                camera_id=camera_id,
                model=model,
                width=int(parts[2]),
                height=int(parts[3]),
                params=tuple(float(value) for value in parts[4:]),
            )
    return cameras


def read_images(path: Path) -> list[ImageFrame]:
    frames: list[ImageFrame] = []
    with path.open("r", encoding="utf-8") as handle:
        while True:
            line = handle.readline()
            if not line:
                break
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            frames.append(
                ImageFrame(
                    image_id=int(parts[0]),
                    qvec=np.asarray([float(value) for value in parts[1:5]], dtype=np.float64),
                    tvec=np.asarray([float(value) for value in parts[5:8]], dtype=np.float64),
                    camera_id=int(parts[8]),
                    name=" ".join(parts[9:]),
                )
            )
            handle.readline()
    return frames


def read_ascii_ply_points(path: Path) -> np.ndarray:
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        header: list[str] = []
        for raw_line in handle:
            line = raw_line.rstrip("\n")
            header.append(line)
            if line == "end_header":
                break
        else:
            raise ValueError(f"PLY end_header not found: {path}")

        if not any(line == "format ascii 1.0" for line in header):
            raise ValueError(f"only ascii PLY is supported: {path}")

        vertex_count = 0
        properties: list[str] = []
        in_vertex = False
        for line in header:
            parts = line.split()
            if len(parts) >= 3 and parts[0] == "element":
                in_vertex = parts[1] == "vertex"
                if in_vertex:
                    vertex_count = int(parts[2])
                continue
            if in_vertex and len(parts) >= 3 and parts[0] == "property":
                properties.append(parts[-1])

        try:
            x_idx = properties.index("x")
            y_idx = properties.index("y")
            z_idx = properties.index("z")
        except ValueError as error:
            raise ValueError(f"PLY is missing x/y/z properties: {path}") from error

        points = np.empty((vertex_count, 3), dtype=np.float32)
        kept = 0
        for raw_line in handle:
            if kept >= vertex_count:
                break
            parts = raw_line.strip().split()
            if len(parts) <= max(x_idx, y_idx, z_idx):
                continue
            try:
                points[kept] = (float(parts[x_idx]), float(parts[y_idx]), float(parts[z_idx]))
                kept += 1
            except ValueError:
                continue

    return points[:kept]


def image_stem(name: str) -> str:
    return Path(name).stem


def scaled_intrinsics(camera: Camera, width: int, height: int) -> tuple[float, float, float, float]:
    fx, fy, cx, cy = camera.params
    sx = width / float(camera.width)
    sy = height / float(camera.height)
    return fx * sx, fy * sy, cx * sx, cy * sy


def depth_output_resolution(camera: Camera, downscale: int) -> tuple[int, int]:
    width = max(1, int(round(camera.width / downscale)))
    height = max(1, int(round(camera.height / downscale)))
    return width, height


def project_depth(
    points: np.ndarray,
    frame: ImageFrame,
    camera: Camera,
    width: int,
    height: int,
    min_depth: float,
    max_depth: float,
    splat_radius: int,
) -> tuple[np.ndarray, dict]:
    rotation = qvec2rotmat(frame.qvec).astype(np.float32)
    translation = frame.tvec.astype(np.float32)
    points_camera = points @ rotation.T + translation
    z = points_camera[:, 2]
    valid = (z > min_depth) & (z < max_depth)
    valid_count = int(valid.sum())
    if valid_count == 0:
        return np.zeros((height, width), dtype=np.float32), {
            "projected_points": 0,
            "unique_pixels": 0,
            "valid_pixels": 0,
            "coverage": 0.0,
        }

    projected = points_camera[valid]
    depths = z[valid]
    fx, fy, cx, cy = scaled_intrinsics(camera, width, height)
    u = np.rint(fx * projected[:, 0] / depths + cx).astype(np.int32)
    v = np.rint(fy * projected[:, 1] / depths + cy).astype(np.int32)
    in_image = (u >= 0) & (u < width) & (v >= 0) & (v < height)
    if not np.any(in_image):
        return np.zeros((height, width), dtype=np.float32), {
            "projected_points": 0,
            "unique_pixels": 0,
            "valid_pixels": 0,
            "coverage": 0.0,
        }

    u = u[in_image]
    v = v[in_image]
    depths = depths[in_image]
    projected_count = int(depths.size)

    flat_count = width * height
    depth_flat = np.full(flat_count, np.inf, dtype=np.float32)
    base_index = v * width + u
    np.minimum.at(depth_flat, base_index, depths.astype(np.float32))
    unique_pixels = int(np.isfinite(depth_flat).sum())

    if splat_radius > 0:
        splat_flat = np.full(flat_count, np.inf, dtype=np.float32)
        for dy in range(-splat_radius, splat_radius + 1):
            vv = v + dy
            y_ok = (vv >= 0) & (vv < height)
            if not np.any(y_ok):
                continue
            max_dx = int(math.floor((splat_radius * splat_radius - dy * dy) ** 0.5))
            for dx in range(-max_dx, max_dx + 1):
                uu = u + dx
                ok = y_ok & (uu >= 0) & (uu < width)
                if np.any(ok):
                    np.minimum.at(splat_flat, vv[ok] * width + uu[ok], depths[ok].astype(np.float32))
        depth_flat = splat_flat

    depth = depth_flat.reshape((height, width))
    valid_pixels = int(np.isfinite(depth).sum())
    depth[~np.isfinite(depth)] = 0.0
    return depth, {
        "projected_points": projected_count,
        "unique_pixels": unique_pixels,
        "valid_pixels": valid_pixels,
        "coverage": valid_pixels / float(flat_count),
    }


def percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    return float(np.percentile(np.asarray(values, dtype=np.float64), pct))


def write_depth_png(depth_m: np.ndarray, output_path: Path, inv_depth_scale: float) -> tuple[int, float, float]:
    valid = depth_m > 0
    inv_depth = np.zeros_like(depth_m, dtype=np.float32)
    inv_depth[valid] = 1.0 / np.maximum(depth_m[valid], 1.0e-6)
    clipped = np.clip(inv_depth / inv_depth_scale, 0.0, 1.0)
    encoded = np.rint(clipped * 65535.0).astype(np.uint16)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(output_path), encoded):
        raise OSError(f"failed to write depth PNG: {output_path}")
    if valid.any():
        return int(valid.sum()), float(depth_m[valid].min()), float(depth_m[valid].max())
    return 0, 0.0, 0.0


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate sparse masked inverse-depth maps from a COLMAP point cloud.")
    parser.add_argument("--dataset", required=True, type=Path)
    parser.add_argument("--pointcloud", default=None, type=Path)
    parser.add_argument("--depths-dir", default="depths_pointcloud")
    parser.add_argument("--summary", default="depths_pointcloud_summary.json")
    parser.add_argument("--downscale", type=int, default=2)
    parser.add_argument("--splat-radius", type=int, default=1)
    parser.add_argument("--min-depth-m", type=float, default=0.2)
    parser.add_argument("--max-depth-m", type=float, default=200.0)
    parser.add_argument("--inv-depth-scale", type=float, default=5.0)
    parser.add_argument("--max-frames", type=int, default=0)
    parser.add_argument("--stride", type=int, default=1)
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()

    start = time.time()
    dataset = args.dataset.resolve()
    sparse_dir = dataset / "sparse" / "0"
    pointcloud_path = args.pointcloud.resolve() if args.pointcloud else sparse_dir / "points3D.ply"
    depths_dir = dataset / args.depths_dir
    summary_path = dataset / args.summary

    cameras = read_cameras(sparse_dir / "cameras.txt")
    frames = read_images(sparse_dir / "images.txt")
    if args.stride > 1:
        frames = frames[:: args.stride]
    if args.max_frames > 0:
        frames = frames[: args.max_frames]
    if not frames:
        raise ValueError("no COLMAP frames found")

    points = read_ascii_ply_points(pointcloud_path)
    if points.size == 0:
        raise ValueError(f"no points found in {pointcloud_path}")

    depths_dir.mkdir(parents=True, exist_ok=True)
    params: dict[str, dict] = {}
    stats: list[dict] = []
    per_camera: dict[str, dict[str, float]] = {}
    skipped_existing = 0

    for index, frame in enumerate(frames, start=1):
        camera = cameras[frame.camera_id]
        width, height = depth_output_resolution(camera, max(1, args.downscale))
        stem = image_stem(frame.name)
        output_path = depths_dir / f"{stem}.png"

        if output_path.exists() and not args.overwrite:
            encoded = cv2.imread(str(output_path), cv2.IMREAD_UNCHANGED)
            valid_pixels = int((encoded > 0).sum()) if encoded is not None else 0
            frame_stats = {
                "image_id": frame.image_id,
                "image_name": frame.name,
                "camera_id": frame.camera_id,
                "width": width,
                "height": height,
                "projected_points": 0,
                "unique_pixels": 0,
                "valid_pixels": valid_pixels,
                "coverage": valid_pixels / float(width * height),
                "skipped_existing": True,
            }
            skipped_existing += 1
        else:
            depth, projection_stats = project_depth(
                points=points,
                frame=frame,
                camera=camera,
                width=width,
                height=height,
                min_depth=max(0.001, args.min_depth_m),
                max_depth=max(args.max_depth_m, args.min_depth_m),
                splat_radius=max(0, args.splat_radius),
            )
            valid_pixels, min_depth, max_depth = write_depth_png(depth, output_path, args.inv_depth_scale)
            frame_stats = {
                "image_id": frame.image_id,
                "image_name": frame.name,
                "camera_id": frame.camera_id,
                "width": width,
                "height": height,
                **projection_stats,
                "valid_pixels": valid_pixels,
                "coverage": valid_pixels / float(width * height),
                "min_depth_m": min_depth,
                "max_depth_m": max_depth,
                "skipped_existing": False,
            }

        stats.append(frame_stats)
        camera_key = str(frame.camera_id)
        bucket = per_camera.setdefault(
            camera_key,
            {"frame_count": 0, "valid_pixels": 0, "projected_points": 0, "coverage_sum": 0.0},
        )
        bucket["frame_count"] += 1
        bucket["valid_pixels"] += frame_stats["valid_pixels"]
        bucket["projected_points"] += frame_stats["projected_points"]
        bucket["coverage_sum"] += frame_stats["coverage"]

        params[stem] = {
            "scale": args.inv_depth_scale,
            "offset": 0.0,
            "sparse_masked": True,
            "source": "cloud_control_projected_pointcloud",
            "depth_unit": "inverse_meter",
            "invalid_value": 0,
            "width": width,
            "height": height,
            "splat_radius_px": max(0, args.splat_radius),
            "min_depth_m": max(0.001, args.min_depth_m),
            "max_depth_m": max(args.max_depth_m, args.min_depth_m),
        }

        if index == len(frames) or index % 100 == 0:
            elapsed = max(1.0e-6, time.time() - start)
            print(
                f"[depth] {index}/{len(frames)} frames, "
                f"last coverage={frame_stats['coverage'] * 100:.3f}%, "
                f"{index / elapsed:.2f} fps",
                flush=True,
            )

    coverage_values = [item["coverage"] for item in stats]
    valid_values = [item["valid_pixels"] for item in stats]
    for bucket in per_camera.values():
        count = max(1, int(bucket["frame_count"]))
        bucket["mean_coverage"] = bucket["coverage_sum"] / count
        bucket["mean_valid_pixels"] = bucket["valid_pixels"] / count
        bucket["mean_projected_points"] = bucket["projected_points"] / count

    summary = {
        "schema": "jgzj.three_dgs.pointcloud_depths.v1",
        "dataset": str(dataset),
        "pointcloud": str(pointcloud_path),
        "depths_dir": str(depths_dir),
        "depth_params_path": str(sparse_dir / "depth_params.json"),
        "frame_count": len(stats),
        "point_count": int(points.shape[0]),
        "downscale": max(1, args.downscale),
        "splat_radius_px": max(0, args.splat_radius),
        "min_depth_m": max(0.001, args.min_depth_m),
        "max_depth_m": max(args.max_depth_m, args.min_depth_m),
        "inv_depth_scale": args.inv_depth_scale,
        "skipped_existing": skipped_existing,
        "coverage": {
            "mean": float(np.mean(coverage_values)) if coverage_values else 0.0,
            "p10": percentile(coverage_values, 10),
            "p25": percentile(coverage_values, 25),
            "p50": percentile(coverage_values, 50),
            "p75": percentile(coverage_values, 75),
            "p90": percentile(coverage_values, 90),
            "min": float(np.min(coverage_values)) if coverage_values else 0.0,
            "max": float(np.max(coverage_values)) if coverage_values else 0.0,
        },
        "valid_pixels": {
            "mean": float(np.mean(valid_values)) if valid_values else 0.0,
            "p10": percentile(valid_values, 10),
            "p50": percentile(valid_values, 50),
            "p90": percentile(valid_values, 90),
            "min": int(np.min(valid_values)) if valid_values else 0,
            "max": int(np.max(valid_values)) if valid_values else 0,
        },
        "per_camera": per_camera,
        "frames": stats,
        "elapsed_s": round(time.time() - start, 3),
    }

    with (sparse_dir / "depth_params.json").open("w", encoding="utf-8") as handle:
        json.dump(params, handle, indent=2)
    with summary_path.open("w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2)

    print(json.dumps({key: summary[key] for key in ("frame_count", "point_count", "coverage", "valid_pixels", "elapsed_s")}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
