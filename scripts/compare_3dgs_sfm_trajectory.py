#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

import cv2
import numpy as np


CAMERA_ORDER = ["camera1", "camera2", "camera3", "camera4"]


def qvec_to_rotmat(qvec: np.ndarray) -> np.ndarray:
    qw, qx, qy, qz = [float(value) for value in qvec]
    return np.array(
        [
            [1 - 2 * qy * qy - 2 * qz * qz, 2 * qx * qy - 2 * qz * qw, 2 * qx * qz + 2 * qy * qw],
            [2 * qx * qy + 2 * qz * qw, 1 - 2 * qx * qx - 2 * qz * qz, 2 * qy * qz - 2 * qx * qw],
            [2 * qx * qz - 2 * qy * qw, 2 * qy * qz + 2 * qx * qw, 1 - 2 * qx * qx - 2 * qy * qy],
        ],
        dtype=np.float64,
    )


def camera_center(qvec: np.ndarray, tvec: np.ndarray) -> np.ndarray:
    rotation = qvec_to_rotmat(qvec)
    return -(rotation.T @ tvec)


def camera_name_from_image(name: str) -> str:
    stem = Path(name).name.lower()
    for camera_name in CAMERA_ORDER:
        if camera_name in stem:
            return camera_name
    return "unknown"


def is_image_record(parts: list[str]) -> bool:
    if len(parts) < 10:
        return False
    try:
        int(parts[0])
        [float(value) for value in parts[1:8]]
        int(parts[8])
    except ValueError:
        return False
    name = " ".join(parts[9:]).lower()
    return name.endswith((".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff"))


def read_colmap_images(path: Path) -> dict[str, dict]:
    frames: dict[str, dict] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        text = raw_line.strip()
        if not text or text.startswith("#"):
            continue
        parts = text.split()
        if not is_image_record(parts):
            continue
        image_id = int(parts[0])
        qvec = np.asarray([float(value) for value in parts[1:5]], dtype=np.float64)
        tvec = np.asarray([float(value) for value in parts[5:8]], dtype=np.float64)
        camera_id = int(parts[8])
        name = " ".join(parts[9:])
        key = Path(name).name
        frames[key] = {
            "image_id": image_id,
            "camera_id": camera_id,
            "camera_name": camera_name_from_image(name),
            "image_name": key,
            "position": camera_center(qvec, tvec),
        }
    return frames


def umeyama_similarity(source: np.ndarray, target: np.ndarray) -> tuple[float, np.ndarray, np.ndarray]:
    """Return scale, rotation, translation mapping source -> target."""
    if source.shape != target.shape or source.ndim != 2 or source.shape[0] < 3:
        raise ValueError("source and target must be Nx3 arrays with at least 3 points")
    source_mean = source.mean(axis=0)
    target_mean = target.mean(axis=0)
    source_centered = source - source_mean
    target_centered = target - target_mean
    covariance = (target_centered.T @ source_centered) / source.shape[0]
    u, singular_values, vt = np.linalg.svd(covariance)
    correction = np.eye(3)
    if np.linalg.det(u @ vt) < 0:
        correction[-1, -1] = -1
    rotation = u @ correction @ vt
    variance = np.mean(np.sum(source_centered * source_centered, axis=1))
    if variance <= 0:
        raise ValueError("source trajectory has zero variance")
    scale = float(np.sum(singular_values * np.diag(correction)) / variance)
    translation = target_mean - scale * rotation @ source_mean
    return scale, rotation, translation


def stats(values: np.ndarray) -> dict:
    if values.size == 0:
        return {"count": 0, "mean_m": None, "rmse_m": None, "median_m": None, "p90_m": None, "max_m": None}
    return {
        "count": int(values.size),
        "mean_m": round(float(np.mean(values)), 4),
        "rmse_m": round(float(np.sqrt(np.mean(values * values))), 4),
        "median_m": round(float(np.median(values)), 4),
        "p90_m": round(float(np.percentile(values, 90)), 4),
        "max_m": round(float(np.max(values)), 4),
    }


def independent_alignment_stats(rows: list[dict]) -> dict[str, dict]:
    result: dict[str, dict] = {}
    for camera_name in CAMERA_ORDER:
        items = [row for row in rows if row["camera_name"] == camera_name]
        if len(items) < 3:
            result[camera_name] = {"count": len(items), "error": "not enough frames"}
            continue
        ndt = np.asarray([row["ndt_position"] for row in items], dtype=np.float64)
        sfm = np.asarray([row["sfm_position"] for row in items], dtype=np.float64)
        scale, rotation, translation = umeyama_similarity(sfm, ndt)
        aligned = (scale * (rotation @ sfm.T)).T + translation
        residuals = np.linalg.norm(aligned - ndt, axis=1)
        result[camera_name] = {
            **stats(residuals),
            "scale": scale,
            "translation": translation.tolist(),
        }
    return result


def draw_trajectory(rows: list[dict], output_path: Path, width: int = 1400, height: int = 1000) -> None:
    if not rows:
        return
    ndt = np.asarray([row["ndt_position"] for row in rows], dtype=np.float64)
    sfm = np.asarray([row["sfm_aligned_position"] for row in rows], dtype=np.float64)
    xy = np.vstack([ndt[:, :2], sfm[:, :2]])
    lo = xy.min(axis=0)
    hi = xy.max(axis=0)
    span = np.maximum(hi - lo, 1e-6)
    margin = 80
    scale = min((width - 2 * margin) / span[0], (height - 2 * margin) / span[1])

    def to_px(points: np.ndarray) -> np.ndarray:
        x = margin + (points[:, 0] - lo[0]) * scale
        y = height - margin - (points[:, 1] - lo[1]) * scale
        return np.column_stack([x, y]).astype(np.int32)

    image = np.full((height, width, 3), (250, 250, 250), dtype=np.uint8)
    colors = {
        "camera1": (42, 42, 220),
        "camera2": (42, 150, 42),
        "camera3": (220, 120, 42),
        "camera4": (180, 42, 180),
        "unknown": (90, 90, 90),
    }

    for camera_name in CAMERA_ORDER + ["unknown"]:
        indexes = [index for index, row in enumerate(rows) if row["camera_name"] == camera_name]
        if not indexes:
            continue
        ndt_points = to_px(ndt[indexes])
        sfm_points = to_px(sfm[indexes])
        color = colors.get(camera_name, colors["unknown"])
        if len(ndt_points) > 1:
            cv2.polylines(image, [ndt_points], False, color, 2, cv2.LINE_AA)
        if len(sfm_points) > 1:
            cv2.polylines(image, [sfm_points], False, color, 1, cv2.LINE_AA)
        for point in sfm_points[:: max(1, len(sfm_points) // 80)]:
            cv2.circle(image, tuple(point), 3, color, -1, cv2.LINE_AA)

    for row in rows[:: max(1, len(rows) // 180)]:
        a = to_px(np.asarray([row["ndt_position"]], dtype=np.float64))[0]
        b = to_px(np.asarray([row["sfm_aligned_position"]], dtype=np.float64))[0]
        cv2.line(image, tuple(a), tuple(b), (120, 120, 120), 1, cv2.LINE_AA)

    cv2.putText(image, "thick line: NDT/interpolated pose    thin+dots: visual SfM aligned pose", (30, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (20, 20, 20), 2, cv2.LINE_AA)
    y0 = 82
    for camera_name in CAMERA_ORDER:
        color = colors[camera_name]
        cv2.line(image, (34, y0 - 8), (82, y0 - 8), color, 4, cv2.LINE_AA)
        cv2.putText(image, camera_name, (96, y0), cv2.FONT_HERSHEY_SIMPLEX, 0.68, (20, 20, 20), 2, cv2.LINE_AA)
        y0 += 34
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(output_path), image, [cv2.IMWRITE_JPEG_QUALITY, 94])


def main() -> int:
    parser = argparse.ArgumentParser(description="Compare visual-SfM COLMAP camera centers against the NDT/interpolated COLMAP dataset.")
    parser.add_argument("--ndt-images", required=True, type=Path)
    parser.add_argument("--sfm-images", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    ndt_frames = read_colmap_images(args.ndt_images.resolve())
    sfm_frames = read_colmap_images(args.sfm_images.resolve())
    common_names = sorted(set(ndt_frames).intersection(sfm_frames))
    if len(common_names) < 3:
        raise ValueError(f"not enough common registered images: {len(common_names)}")

    ndt_positions = np.asarray([ndt_frames[name]["position"] for name in common_names], dtype=np.float64)
    sfm_positions = np.asarray([sfm_frames[name]["position"] for name in common_names], dtype=np.float64)
    scale, rotation, translation = umeyama_similarity(sfm_positions, ndt_positions)
    sfm_aligned = (scale * (rotation @ sfm_positions.T)).T + translation
    residuals = np.linalg.norm(sfm_aligned - ndt_positions, axis=1)

    rows: list[dict] = []
    for index, name in enumerate(common_names):
        camera_name = ndt_frames[name]["camera_name"]
        rows.append(
            {
                "image_name": name,
                "camera_name": camera_name,
                "ndt_position": ndt_positions[index],
                "sfm_position": sfm_positions[index],
                "sfm_aligned_position": sfm_aligned[index],
                "residual_m": float(residuals[index]),
            }
        )

    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    csv_path = output / "trajectory_compare.csv"
    with csv_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "image_name",
                "camera_name",
                "ndt_x",
                "ndt_y",
                "ndt_z",
                "sfm_x",
                "sfm_y",
                "sfm_z",
                "sfm_aligned_x",
                "sfm_aligned_y",
                "sfm_aligned_z",
                "residual_m",
            ],
        )
        writer.writeheader()
        for row in rows:
            ndt_position = row["ndt_position"]
            sfm_position = row["sfm_position"]
            sfm_aligned_position = row["sfm_aligned_position"]
            writer.writerow(
                {
                    "image_name": row["image_name"],
                    "camera_name": row["camera_name"],
                    "ndt_x": f"{ndt_position[0]:.9g}",
                    "ndt_y": f"{ndt_position[1]:.9g}",
                    "ndt_z": f"{ndt_position[2]:.9g}",
                    "sfm_x": f"{sfm_position[0]:.9g}",
                    "sfm_y": f"{sfm_position[1]:.9g}",
                    "sfm_z": f"{sfm_position[2]:.9g}",
                    "sfm_aligned_x": f"{sfm_aligned_position[0]:.9g}",
                    "sfm_aligned_y": f"{sfm_aligned_position[1]:.9g}",
                    "sfm_aligned_z": f"{sfm_aligned_position[2]:.9g}",
                    "residual_m": f"{row['residual_m']:.9g}",
                }
            )

    per_camera = {}
    for camera_name in CAMERA_ORDER:
        values = np.asarray([row["residual_m"] for row in rows if row["camera_name"] == camera_name], dtype=np.float64)
        per_camera[camera_name] = stats(values)

    summary = {
        "ndt_images": str(args.ndt_images.resolve()),
        "sfm_images": str(args.sfm_images.resolve()),
        "ndt_image_count": len(ndt_frames),
        "sfm_image_count": len(sfm_frames),
        "common_image_count": len(common_names),
        "similarity_sfm_to_ndt": {
            "scale": scale,
            "rotation": rotation.tolist(),
            "translation": translation.tolist(),
        },
        "overall": stats(residuals),
        "per_camera": per_camera,
        "per_camera_independent_alignment": independent_alignment_stats(rows),
        "csv": str(csv_path),
        "trajectory_plot": str(output / "trajectory_xy_compare.jpg"),
    }
    (output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    draw_trajectory(rows, output / "trajectory_xy_compare.jpg")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
