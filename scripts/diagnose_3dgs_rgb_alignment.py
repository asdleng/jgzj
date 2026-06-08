#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import math
from pathlib import Path

import cv2
import numpy as np

from diagnose_3dgs_reprojection import (
    CAMERA_ORDER,
    depth_stats,
    group_frames,
    project_frame,
    read_cameras,
    read_images,
    resize_panel,
    selected_groups,
)


def pcd_dtype(size: int, type_name: str) -> str:
    key = (int(size), type_name.upper())
    mapping = {
        (4, "F"): "<f4",
        (8, "F"): "<f8",
        (1, "U"): "u1",
        (2, "U"): "<u2",
        (4, "U"): "<u4",
        (1, "I"): "i1",
        (2, "I"): "<i2",
        (4, "I"): "<i4",
    }
    if key not in mapping:
        raise ValueError(f"unsupported PCD field type: size={size} type={type_name}")
    return mapping[key]


def read_pcd_xyz_rgb(path: Path) -> tuple[np.ndarray, np.ndarray, dict]:
    data = path.read_bytes()
    marker = b"DATA "
    marker_index = data.find(marker)
    if marker_index < 0:
        raise ValueError(f"PCD missing DATA line: {path}")
    header_end = data.find(b"\n", marker_index)
    if header_end < 0:
        raise ValueError(f"PCD malformed DATA line: {path}")
    header_text = data[: header_end + 1].decode("utf-8", errors="replace")
    header: dict[str, list[str]] = {}
    for line in header_text.splitlines():
        parts = line.strip().split()
        if parts:
            header[parts[0].upper()] = parts[1:]
    fields = header.get("FIELDS", [])
    sizes = [int(value) for value in header.get("SIZE", [])]
    types = header.get("TYPE", [])
    counts = [int(value) for value in header.get("COUNT", ["1"] * len(fields))]
    data_type = header.get("DATA", [""])[0].lower()
    point_count = int(header.get("POINTS", header.get("WIDTH", ["0"]))[0])
    if data_type != "binary":
        raise ValueError(f"this diagnostic expects binary PCD, got DATA {data_type}")
    if not {"x", "y", "z"}.issubset(fields):
        raise ValueError(f"PCD must contain x/y/z fields: {path}")

    dtype_fields = []
    for field, size, type_name, count in zip(fields, sizes, types, counts):
        dtype = pcd_dtype(size, type_name)
        dtype_fields.append((field, dtype) if count == 1 else (field, dtype, (count,)))
    array = np.frombuffer(data[header_end + 1 :], dtype=np.dtype(dtype_fields), count=point_count)
    points = np.column_stack([array["x"], array["y"], array["z"]]).astype(np.float64)

    if {"red", "green", "blue"}.issubset(fields):
        colors = np.column_stack([array["red"], array["green"], array["blue"]]).astype(np.uint8)
        color_source = "red_green_blue_fields"
    elif "rgb" in fields:
        rgb_values = array["rgb"]
        if rgb_values.dtype.kind == "f" and rgb_values.dtype.itemsize == 4:
            packed = rgb_values.view("<u4")
        else:
            packed = rgb_values.astype(np.uint32, copy=False)
        colors = np.column_stack(
            [
                (packed >> 16) & 255,
                (packed >> 8) & 255,
                packed & 255,
            ]
        ).astype(np.uint8)
        color_source = "packed_rgb_field"
    else:
        colors = np.full((points.shape[0], 3), 180, dtype=np.uint8)
        color_source = "missing_rgb_default_gray"

    mask = np.isfinite(points).all(axis=1)
    points = points[mask]
    colors = colors[mask]
    return points, colors, {
        "header": header_text,
        "fields": fields,
        "point_count_header": point_count,
        "point_count_valid": int(points.shape[0]),
        "color_source": color_source,
    }


def point_color_stats(colors: np.ndarray) -> dict:
    colors_f = colors.astype(np.float64)
    maxc = colors_f.max(axis=1)
    minc = colors_f.min(axis=1)
    saturation = np.divide(maxc - minc, np.maximum(maxc, 1.0))
    luma = colors_f @ np.array([0.299, 0.587, 0.114])
    return {
        "rgb_mean": [round(float(v), 3) for v in colors_f.mean(axis=0)],
        "rgb_std": [round(float(v), 3) for v in colors_f.std(axis=0)],
        "luma_mean": round(float(luma.mean()), 3),
        "luma_std": round(float(luma.std()), 3),
        "saturation_mean": round(float(saturation.mean()), 4),
        "saturation_p50": round(float(np.percentile(saturation, 50)), 4),
        "saturation_p90": round(float(np.percentile(saturation, 90)), 4),
        "near_gray_ratio_sat_lt_0_05": round(float(np.mean(saturation < 0.05)), 4),
        "dark_ratio_luma_lt_25": round(float(np.mean(luma < 25)), 4),
        "bright_ratio_luma_gt_230": round(float(np.mean(luma > 230)), 4),
    }


def select_frames_by_camera(frames: list[dict], frames_per_camera: int) -> list[dict]:
    selected = []
    for camera_name in CAMERA_ORDER:
        items = [frame for frame in frames if frame["camera_name"] == camera_name]
        if not items:
            continue
        if frames_per_camera > 0 and len(items) > frames_per_camera:
            indexes = np.linspace(0, len(items) - 1, frames_per_camera, dtype=int)
            items = [items[int(index)] for index in indexes]
        selected.extend(items)
    selected.sort(key=lambda item: item["image_id"])
    return selected


def sample_indexes(count: int, max_count: int) -> np.ndarray:
    if count <= max_count or max_count <= 0:
        return np.arange(count, dtype=np.int64)
    return np.linspace(0, count - 1, max_count, dtype=np.int64)


def luma_corr(a_rgb: np.ndarray, b_rgb: np.ndarray) -> float | None:
    if a_rgb.shape[0] < 10:
        return None
    weights = np.array([0.299, 0.587, 0.114])
    a = a_rgb.astype(np.float64) @ weights
    b = b_rgb.astype(np.float64) @ weights
    if float(np.std(a)) < 1e-6 or float(np.std(b)) < 1e-6:
        return None
    return round(float(np.corrcoef(a, b)[0, 1]), 4)


def color_error_for_offset(
    image_rgb: np.ndarray,
    x: np.ndarray,
    y: np.ndarray,
    colors_rgb: np.ndarray,
    dx: int,
    dy: int,
) -> dict | None:
    height, width = image_rgb.shape[:2]
    xx = x + dx
    yy = y + dy
    valid = (xx >= 0) & (xx < width) & (yy >= 0) & (yy < height)
    if int(valid.sum()) < 50:
        return None
    pixel = image_rgb[yy[valid], xx[valid]].astype(np.float64)
    point = colors_rgb[valid].astype(np.float64)
    abs_err = np.abs(pixel - point)
    mean_per_point = abs_err.mean(axis=1)
    return {
        "count": int(valid.sum()),
        "mae_rgb": round(float(abs_err.mean()), 3),
        "median_rgb": round(float(np.median(mean_per_point)), 3),
        "p90_rgb": round(float(np.percentile(mean_per_point, 90)), 3),
        "under_30_ratio": round(float(np.mean(mean_per_point < 30.0)), 4),
        "under_50_ratio": round(float(np.mean(mean_per_point < 50.0)), 4),
        "luma_corr": luma_corr(pixel, point),
    }


def evaluate_projection_colors(
    image_bgr: np.ndarray,
    projection: dict,
    colors: np.ndarray,
    args: argparse.Namespace,
) -> dict:
    x_all = projection["x"]
    y_all = projection["y"]
    indexes_all = projection["indexes"]
    if indexes_all.size == 0:
        return {
            "compare_count": 0,
            "mae_rgb": None,
            "mae_bgr_swapped": None,
            "best_shift_dx": None,
            "best_shift_dy": None,
            "best_shift_mae_rgb": None,
            "best_shift_improvement": None,
        }
    take = sample_indexes(indexes_all.size, args.max_compare_points)
    x = x_all[take].astype(np.int32)
    y = y_all[take].astype(np.int32)
    point_rgb = colors[indexes_all[take]]
    image_rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)

    zero = color_error_for_offset(image_rgb, x, y, point_rgb, 0, 0)
    zero_bgr = color_error_for_offset(image_rgb, x, y, point_rgb[:, ::-1], 0, 0)
    offsets = list(range(-args.shift_max_px, args.shift_max_px + 1, max(1, args.shift_step_px)))
    if 0 not in offsets:
        offsets.append(0)
        offsets.sort()
    best = None
    best_dx = 0
    best_dy = 0
    for dy in offsets:
        for dx in offsets:
            metric = color_error_for_offset(image_rgb, x, y, point_rgb, dx, dy)
            if metric is None:
                continue
            if best is None or metric["mae_rgb"] < best["mae_rgb"]:
                best = metric
                best_dx = dx
                best_dy = dy
    return {
        "compare_count": zero["count"] if zero else 0,
        "mae_rgb": zero["mae_rgb"] if zero else None,
        "median_rgb": zero["median_rgb"] if zero else None,
        "p90_rgb": zero["p90_rgb"] if zero else None,
        "under_30_ratio": zero["under_30_ratio"] if zero else None,
        "under_50_ratio": zero["under_50_ratio"] if zero else None,
        "luma_corr": zero["luma_corr"] if zero else None,
        "mae_bgr_swapped": zero_bgr["mae_rgb"] if zero_bgr else None,
        "best_shift_dx": best_dx if best else None,
        "best_shift_dy": best_dy if best else None,
        "best_shift_mae_rgb": best["mae_rgb"] if best else None,
        "best_shift_improvement": round(float((zero["mae_rgb"] if zero else 0.0) - best["mae_rgb"]), 3) if best and zero else None,
    }


def draw_rgb_overlay(
    image_bgr: np.ndarray,
    projection: dict,
    colors_rgb: np.ndarray,
    frame: dict,
    metrics: dict,
    args: argparse.Namespace,
) -> np.ndarray:
    output = image_bgr.copy()
    x = projection["x"]
    y = projection["y"]
    indexes = projection["indexes"]
    if indexes.size:
        take = sample_indexes(indexes.size, args.max_draw_points)
        overlay = output.copy()
        draw_colors_bgr = colors_rgb[indexes[take]][:, ::-1]
        radius = max(1, int(args.point_radius))
        for px, py, color in zip(x[take], y[take], draw_colors_bgr):
            cv2.circle(overlay, (int(px), int(py)), radius, tuple(int(c) for c in color), -1, lineType=cv2.LINE_AA)
        cv2.addWeighted(overlay, args.alpha, output, 1.0 - args.alpha, 0, output)

    label_lines = [
        f"{frame['camera_name']} key={frame['capture_key']} id={frame['image_id']}",
        f"visible={metrics.get('visible_count')} cmp={metrics.get('compare_count')} mae={metrics.get('mae_rgb')}",
        f"best_shift=({metrics.get('best_shift_dx')},{metrics.get('best_shift_dy')}) gain={metrics.get('best_shift_improvement')}",
    ]
    y0 = 24
    for line in label_lines:
        cv2.putText(output, line, (18, y0), cv2.FONT_HERSHEY_SIMPLEX, 0.72, (0, 0, 0), 4, cv2.LINE_AA)
        cv2.putText(output, line, (18, y0), cv2.FONT_HERSHEY_SIMPLEX, 0.72, (255, 255, 255), 1, cv2.LINE_AA)
        y0 += 30
    return output


def make_sheet(panels: dict[str, np.ndarray], args: argparse.Namespace) -> np.ndarray:
    panel_width = args.panel_width
    panel_height = args.panel_height
    blank = np.zeros((panel_height, panel_width, 3), dtype=np.uint8)
    blank[:] = (20, 24, 34)
    ordered = []
    for camera_name in CAMERA_ORDER:
        image = panels.get(camera_name)
        if image is None:
            image = blank.copy()
            cv2.putText(image, f"{camera_name} missing", (26, 54), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (220, 220, 220), 2)
        else:
            image = resize_panel(image, panel_width, panel_height)
        ordered.append(image)
    return np.vstack([np.hstack(ordered[:2]), np.hstack(ordered[2:])])


def aggregate(rows: list[dict]) -> dict:
    if not rows:
        return {}

    def values(key: str) -> list[float]:
        return [float(row[key]) for row in rows if row.get(key) is not None]

    result = {"frames": len(rows)}
    for key in [
        "visible_count",
        "compare_count",
        "mae_rgb",
        "median_rgb",
        "p90_rgb",
        "under_30_ratio",
        "under_50_ratio",
        "luma_corr",
        "mae_bgr_swapped",
        "best_shift_improvement",
    ]:
        vals = values(key)
        if vals:
            result[f"{key}_median"] = round(float(np.median(vals)), 4)
            result[f"{key}_mean"] = round(float(np.mean(vals)), 4)
    shifts = [(int(row["best_shift_dx"]), int(row["best_shift_dy"])) for row in rows if row.get("best_shift_dx") is not None]
    if shifts:
        unique, counts = np.unique(np.asarray(shifts, dtype=np.int32), axis=0, return_counts=True)
        index = int(np.argmax(counts))
        result["most_common_best_shift"] = [int(unique[index, 0]), int(unique[index, 1])]
        result["most_common_best_shift_count"] = int(counts[index])
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Compare RGB pointcloud colors with projected 3DGS training images.")
    parser.add_argument("--dataset", required=True, type=Path)
    parser.add_argument("--pointcloud", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--frames-per-camera", type=int, default=32)
    parser.add_argument("--max-sheets", type=int, default=8)
    parser.add_argument("--max-points", type=int, default=0)
    parser.add_argument("--max-compare-points", type=int, default=20000)
    parser.add_argument("--max-draw-points", type=int, default=18000)
    parser.add_argument("--min-depth", type=float, default=0.2)
    parser.add_argument("--occlusion-cell-px", type=int, default=8)
    parser.add_argument("--depth-tolerance", type=float, default=0.8)
    parser.add_argument("--shift-max-px", type=int, default=24)
    parser.add_argument("--shift-step-px", type=int, default=8)
    parser.add_argument("--point-radius", type=int, default=1)
    parser.add_argument("--alpha", type=float, default=0.88)
    parser.add_argument("--panel-width", type=int, default=960)
    parser.add_argument("--panel-height", type=int, default=540)
    args = parser.parse_args()

    dataset = args.dataset.resolve()
    sparse = dataset / "sparse" / "0"
    images_dir = dataset / "images"
    output = args.output.resolve()
    sheets_dir = output / "sheets"
    sheets_dir.mkdir(parents=True, exist_ok=True)

    cameras = read_cameras(sparse / "cameras.txt")
    frames = read_images(sparse / "images.txt", cameras)
    points, colors, pcd_info = read_pcd_xyz_rgb(args.pointcloud.resolve())
    source_point_count = int(points.shape[0])
    if args.max_points > 0 and points.shape[0] > args.max_points:
        rng = np.random.default_rng(42)
        choice = rng.choice(points.shape[0], size=args.max_points, replace=False)
        points = points[choice]
        colors = colors[choice]

    metric_frames = select_frames_by_camera(frames, args.frames_per_camera)
    rows = []
    projection_cache: dict[int, tuple[dict, dict, np.ndarray]] = {}
    for frame in metric_frames:
        image_path = images_dir / frame["name"]
        image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
        if image is None:
            continue
        projection = project_frame(points, frame, args)
        color_metrics = evaluate_projection_colors(image, projection, colors, args)
        row = {
            "image_id": frame["image_id"],
            "camera_name": frame["camera_name"],
            "capture_key": frame["capture_key"],
            "image_name": frame["name"],
            "source_point_count": source_point_count,
            "sampled_point_count": int(points.shape[0]),
            "in_image_count": projection["in_image_count"],
            "visible_count": projection["visible_count"],
            "visible_ratio": round(projection["visible_count"] / max(1, points.shape[0]), 6),
            **depth_stats(projection["depth"]),
            **color_metrics,
        }
        rows.append(row)
        projection_cache[frame["image_id"]] = (projection, row, image)

    groups = group_frames(frames)
    selected_sheet_groups = selected_groups(groups, max(1, math.ceil(len(groups) / max(1, args.max_sheets))), args.max_sheets)
    sheet_paths = []
    for sheet_index, group in enumerate(selected_sheet_groups, start=1):
        panels = {}
        for frame in group["frames"]:
            image_path = images_dir / frame["name"]
            cached = projection_cache.get(frame["image_id"])
            if cached:
                projection, metrics, image = cached
            else:
                image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
                if image is None:
                    continue
                projection = project_frame(points, frame, args)
                metrics = {
                    "visible_count": projection["visible_count"],
                    **evaluate_projection_colors(image, projection, colors, args),
                }
            panels[frame["camera_name"]] = draw_rgb_overlay(image, projection, colors, frame, metrics, args)
        sheet = make_sheet(panels, args)
        sheet_path = sheets_dir / f"{sheet_index:03d}_{group['key']}_rgb_alignment.jpg"
        cv2.imwrite(str(sheet_path), sheet, [cv2.IMWRITE_JPEG_QUALITY, 92])
        sheet_paths.append(str(sheet_path))

    csv_path = output / "metrics.csv"
    with csv_path.open("w", encoding="utf-8", newline="") as handle:
        fieldnames = sorted({key for row in rows for key in row.keys()})
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    per_camera = {camera: aggregate([row for row in rows if row["camera_name"] == camera]) for camera in CAMERA_ORDER}
    summary = {
        "dataset": str(dataset),
        "pointcloud": str(args.pointcloud.resolve()),
        "pcd_info": pcd_info,
        "point_color_stats": point_color_stats(colors),
        "source_point_count": source_point_count,
        "sampled_point_count": int(points.shape[0]),
        "frame_count": len(frames),
        "metric_frame_count": len(rows),
        "per_camera": per_camera,
        "all": aggregate(rows),
        "metrics_csv": str(csv_path),
        "sheets": sheet_paths,
        "notes": [
            "mae_rgb compares projected PCD RGB against undistorted image pixels at the projected locations.",
            "mae_bgr_swapped is the same comparison with point colors channel-swapped; if much lower, RGB packing is suspect.",
            "best_shift_* searches small 2D pixel offsets. Large repeated nonzero shifts with strong improvement indicate residual pose/extrinsic/timing error.",
        ],
    }
    (output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
