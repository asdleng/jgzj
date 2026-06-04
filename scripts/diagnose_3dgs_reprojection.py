#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import math
import struct
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


def camera_name_from_image(name: str, camera_id: int) -> str:
    stem = Path(name).name.lower()
    for camera_name in CAMERA_ORDER:
        if camera_name in stem:
            return camera_name
    return f"camera{camera_id}"


def capture_key_from_image(name: str, image_id: int) -> str:
    stem = Path(name).stem
    parts = stem.split("_")
    for part in parts:
        if part.startswith("g") and len(part) > 1:
            return part[1:]
    return str(image_id)


def read_cameras(path: Path) -> dict[int, dict]:
    cameras: dict[int, dict] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        text = line.strip()
        if not text or text.startswith("#"):
            continue
        parts = text.split()
        if len(parts) < 8:
            continue
        camera_id = int(parts[0])
        model = parts[1]
        width = int(parts[2])
        height = int(parts[3])
        params = [float(value) for value in parts[4:]]
        if model != "PINHOLE" or len(params) < 4:
            raise ValueError(f"unsupported camera model in {path}: {text}")
        cameras[camera_id] = {
            "camera_id": camera_id,
            "model": model,
            "width": width,
            "height": height,
            "fx": params[0],
            "fy": params[1],
            "cx": params[2],
            "cy": params[3],
        }
    return cameras


def read_images(path: Path, cameras: dict[int, dict]) -> list[dict]:
    frames: list[dict] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        text = line.strip()
        if not text or text.startswith("#"):
            continue
        parts = text.split()
        if len(parts) < 10:
            continue
        image_id = int(parts[0])
        qvec = np.asarray([float(value) for value in parts[1:5]], dtype=np.float64)
        tvec = np.asarray([float(value) for value in parts[5:8]], dtype=np.float64)
        camera_id = int(parts[8])
        name = " ".join(parts[9:])
        frame = {
            "image_id": image_id,
            "qvec": qvec,
            "tvec": tvec,
            "rotation": qvec_to_rotmat(qvec),
            "position": camera_center(qvec, tvec),
            "camera_id": camera_id,
            "camera_name": camera_name_from_image(name, camera_id),
            "capture_key": capture_key_from_image(name, image_id),
            "name": name,
            "camera": cameras[camera_id],
        }
        frames.append(frame)
    frames.sort(key=lambda item: item["image_id"])
    return frames


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


def read_pcd(path: Path) -> np.ndarray:
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
    if not {"x", "y", "z"}.issubset(fields):
        raise ValueError(f"PCD must contain x/y/z fields: {path}")

    if data_type == "ascii":
        rows = []
        for line in data[header_end + 1 :].decode("utf-8", errors="replace").splitlines():
            values = line.strip().split()
            if len(values) >= len(fields):
                rows.append([float(values[fields.index(axis)]) for axis in ("x", "y", "z")])
        return np.asarray(rows, dtype=np.float64)

    if data_type != "binary":
        raise ValueError(f"unsupported PCD DATA type: {data_type}")

    dtype_fields = []
    for field, size, type_name, count in zip(fields, sizes, types, counts):
        dtype = pcd_dtype(size, type_name)
        dtype_fields.append((field, dtype) if count == 1 else (field, dtype, (count,)))
    array = np.frombuffer(data[header_end + 1 :], dtype=np.dtype(dtype_fields), count=point_count)
    return np.column_stack([array["x"], array["y"], array["z"]]).astype(np.float64)


def read_ply(path: Path) -> np.ndarray:
    data = path.read_bytes()
    header_end = data.find(b"end_header\n")
    if header_end < 0:
        raise ValueError(f"PLY missing end_header: {path}")
    header_size = header_end + len(b"end_header\n")
    header = data[:header_size].decode("utf-8", errors="replace")
    lines = header.splitlines()
    format_line = next(line for line in lines if line.startswith("format "))
    fmt = format_line.split()[1]
    vertex_count = int(next(line for line in lines if line.startswith("element vertex ")).split()[2])
    props: list[tuple[str, str]] = []
    in_vertex = False
    for line in lines:
        if line.startswith("element vertex "):
            in_vertex = True
            continue
        if line.startswith("element ") and not line.startswith("element vertex "):
            in_vertex = False
        if in_vertex and line.startswith("property "):
            _, type_name, name = line.split()[:3]
            props.append((name, type_name))
    prop_names = [name for name, _type_name in props]
    indexes = [prop_names.index(axis) for axis in ("x", "y", "z")]

    if fmt == "ascii":
        rows = []
        body = data[header_size:].decode("utf-8", errors="replace").splitlines()
        for line in body[:vertex_count]:
            values = line.strip().split()
            if len(values) >= len(props):
                rows.append([float(values[index]) for index in indexes])
        return np.asarray(rows, dtype=np.float64)

    if fmt != "binary_little_endian":
        raise ValueError(f"unsupported PLY format: {fmt}")

    ply_type = {
        "float": ("<f4", 4),
        "float32": ("<f4", 4),
        "double": ("<f8", 8),
        "uchar": ("u1", 1),
        "uint8": ("u1", 1),
        "char": ("i1", 1),
        "int8": ("i1", 1),
        "short": ("<i2", 2),
        "ushort": ("<u2", 2),
        "int": ("<i4", 4),
        "uint": ("<u4", 4),
    }
    dtype_fields = []
    for name, type_name in props:
        if type_name not in ply_type:
            raise ValueError(f"unsupported PLY property type: {type_name}")
        dtype_fields.append((name, ply_type[type_name][0]))
    array = np.frombuffer(data[header_size:], dtype=np.dtype(dtype_fields), count=vertex_count)
    return np.column_stack([array["x"], array["y"], array["z"]]).astype(np.float64)


def read_points(path: Path) -> np.ndarray:
    if path.suffix.lower() == ".pcd":
        points = read_pcd(path)
    elif path.suffix.lower() == ".ply":
        points = read_ply(path)
    else:
        raise ValueError(f"unsupported point cloud file: {path}")
    mask = np.isfinite(points).all(axis=1)
    return points[mask]


def group_frames(frames: list[dict]) -> list[dict]:
    groups: dict[str, list[dict]] = {}
    for frame in frames:
        groups.setdefault(frame["capture_key"], []).append(frame)
    result = []
    for key, items in groups.items():
        items.sort(key=lambda item: (CAMERA_ORDER.index(item["camera_name"]) if item["camera_name"] in CAMERA_ORDER else 99, item["image_id"]))
        result.append({"key": key, "image_id": min(item["image_id"] for item in items), "frames": items})
    result.sort(key=lambda item: item["image_id"])
    return result


def selected_groups(groups: list[dict], stride: int, max_sheets: int) -> list[dict]:
    if not groups:
        return []
    stride = max(1, stride)
    indexes = list(range(0, len(groups), stride))
    if indexes[-1] != len(groups) - 1:
        indexes.append(len(groups) - 1)
    if max_sheets > 0 and len(indexes) > max_sheets:
        indexes = np.linspace(0, len(groups) - 1, max_sheets, dtype=int).tolist()
    seen = set()
    unique = []
    for index in indexes:
        if index not in seen:
            unique.append(groups[index])
            seen.add(index)
    return unique


def project_frame(points: np.ndarray, frame: dict, args: argparse.Namespace) -> dict:
    camera = frame["camera"]
    rotation = frame["rotation"]
    translation = frame["tvec"]
    points_camera = points @ rotation.T + translation
    z = points_camera[:, 2]
    valid_depth = z > args.min_depth
    with np.errstate(divide="ignore", invalid="ignore"):
        x = camera["fx"] * points_camera[:, 0] / z + camera["cx"]
        y = camera["fy"] * points_camera[:, 1] / z + camera["cy"]
    in_image = (
        valid_depth
        & np.isfinite(x)
        & np.isfinite(y)
        & (x >= 0)
        & (x < camera["width"])
        & (y >= 0)
        & (y < camera["height"])
    )
    candidate = np.flatnonzero(in_image)
    if not candidate.size:
        return {
            "indexes": candidate,
            "x": np.empty(0, dtype=np.int32),
            "y": np.empty(0, dtype=np.int32),
            "depth": np.empty(0, dtype=np.float64),
            "in_image_count": 0,
            "visible_count": 0,
        }

    pixel_x = np.rint(x[candidate]).astype(np.int32)
    pixel_y = np.rint(y[candidate]).astype(np.int32)
    depth = z[candidate]

    if args.occlusion_cell_px > 1:
        cell_px = int(args.occlusion_cell_px)
        grid_width = int(math.ceil(camera["width"] / cell_px))
        grid_height = int(math.ceil(camera["height"] / cell_px))
        cell_x = np.clip(pixel_x // cell_px, 0, grid_width - 1)
        cell_y = np.clip(pixel_y // cell_px, 0, grid_height - 1)
        cell_ids = cell_y * grid_width + cell_x
        nearest = np.full(grid_width * grid_height, np.inf, dtype=np.float64)
        np.minimum.at(nearest, cell_ids, depth)
        visible = depth <= nearest[cell_ids] + args.depth_tolerance
        candidate = candidate[visible]
        pixel_x = pixel_x[visible]
        pixel_y = pixel_y[visible]
        depth = depth[visible]

    return {
        "indexes": candidate,
        "x": pixel_x,
        "y": pixel_y,
        "depth": depth,
        "in_image_count": int(in_image.sum()),
        "visible_count": int(candidate.size),
    }


def edge_distance_stats(image: np.ndarray, x: np.ndarray, y: np.ndarray) -> dict:
    if x.size == 0:
        return {"edge_median_px": None, "edge_p75_px": None, "edge_p90_px": None}
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 80, 160)
    distance = cv2.distanceTransform(255 - edges, cv2.DIST_L2, 3)
    values = distance[np.clip(y, 0, image.shape[0] - 1), np.clip(x, 0, image.shape[1] - 1)]
    if values.size > 20000:
        values = values[np.linspace(0, values.size - 1, 20000, dtype=int)]
    return {
        "edge_median_px": round(float(np.median(values)), 3),
        "edge_p75_px": round(float(np.percentile(values, 75)), 3),
        "edge_p90_px": round(float(np.percentile(values, 90)), 3),
    }


def draw_overlay(image_path: Path, projection: dict, frame: dict, metrics: dict, args: argparse.Namespace) -> np.ndarray:
    image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"failed to read image: {image_path}")
    output = image.copy()
    x = projection["x"]
    y = projection["y"]
    depth = projection["depth"]
    if x.size:
        if x.size > args.max_draw_points:
            order = np.linspace(0, x.size - 1, args.max_draw_points, dtype=int)
            x = x[order]
            y = y[order]
            depth = depth[order]
        lo = float(np.percentile(depth, 5))
        hi = float(np.percentile(depth, 95))
        if hi <= lo:
            hi = lo + 1.0
        normalized = np.clip((depth - lo) / (hi - lo), 0, 1)
        # Near points red/yellow, far points cyan/blue.
        colors = cv2.applyColorMap((255 - normalized * 255).astype(np.uint8), cv2.COLORMAP_TURBO).reshape(-1, 3)
        overlay = output.copy()
        radius = max(1, int(args.point_radius))
        for px, py, color in zip(x, y, colors):
            cv2.circle(overlay, (int(px), int(py)), radius, tuple(int(c) for c in color), -1, lineType=cv2.LINE_AA)
        cv2.addWeighted(overlay, args.alpha, output, 1.0 - args.alpha, 0, output)

    label_lines = [
        f"{frame['camera_name']} key={frame['capture_key']} image={frame['image_id']}",
        f"in={metrics['in_image_count']} visible={metrics['visible_count']} depth_med={metrics.get('depth_median_m', '-')}",
        f"edge_med={metrics.get('edge_median_px', '-')}px edge_p90={metrics.get('edge_p90_px', '-')}px",
    ]
    y0 = 24
    for line in label_lines:
        cv2.putText(output, line, (18, y0), cv2.FONT_HERSHEY_SIMPLEX, 0.72, (0, 0, 0), 4, cv2.LINE_AA)
        cv2.putText(output, line, (18, y0), cv2.FONT_HERSHEY_SIMPLEX, 0.72, (255, 255, 255), 1, cv2.LINE_AA)
        y0 += 30
    return output


def resize_panel(image: np.ndarray, width: int, height: int) -> np.ndarray:
    return cv2.resize(image, (width, height), interpolation=cv2.INTER_AREA)


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


def depth_stats(depth: np.ndarray) -> dict:
    if depth.size == 0:
        return {"depth_min_m": None, "depth_median_m": None, "depth_p90_m": None}
    return {
        "depth_min_m": round(float(np.min(depth)), 3),
        "depth_median_m": round(float(np.median(depth)), 3),
        "depth_p90_m": round(float(np.percentile(depth, 90)), 3),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Project 3DGS map points into COLMAP training images.")
    parser.add_argument("--dataset", required=True, type=Path)
    parser.add_argument("--pointcloud", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--source-name", default="pointcloud")
    parser.add_argument("--group-stride", type=int, default=40)
    parser.add_argument("--max-sheets", type=int, default=10)
    parser.add_argument("--max-points", type=int, default=0)
    parser.add_argument("--max-draw-points", type=int, default=16000)
    parser.add_argument("--min-depth", type=float, default=0.2)
    parser.add_argument("--occlusion-cell-px", type=int, default=8)
    parser.add_argument("--depth-tolerance", type=float, default=0.8)
    parser.add_argument("--point-radius", type=int, default=1)
    parser.add_argument("--alpha", type=float, default=0.88)
    parser.add_argument("--panel-width", type=int, default=960)
    parser.add_argument("--panel-height", type=int, default=540)
    args = parser.parse_args()

    dataset = args.dataset.resolve()
    sparse = dataset / "sparse" / "0"
    images_dir = dataset / "images"
    output = args.output.resolve()
    overlays_dir = output / "overlays"
    sheets_dir = output / "sheets"
    overlays_dir.mkdir(parents=True, exist_ok=True)
    sheets_dir.mkdir(parents=True, exist_ok=True)

    cameras = read_cameras(sparse / "cameras.txt")
    frames = read_images(sparse / "0" / "images.txt" if (sparse / "0" / "images.txt").exists() else sparse / "images.txt", cameras)
    groups = group_frames(frames)
    selected = selected_groups(groups, args.group_stride, args.max_sheets)
    points = read_points(args.pointcloud.resolve())
    source_point_count = int(points.shape[0])
    if args.max_points > 0 and points.shape[0] > args.max_points:
        rng = np.random.default_rng(42)
        points = points[rng.choice(points.shape[0], size=args.max_points, replace=False)]

    metrics: list[dict] = []
    sheet_paths: list[str] = []
    for group_index, group in enumerate(selected, start=1):
        panels: dict[str, np.ndarray] = {}
        for frame in group["frames"]:
            image_path = images_dir / frame["name"]
            if not image_path.exists():
                continue
            image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
            if image is None:
                continue
            projection = project_frame(points, frame, args)
            stats = {
                "source_name": args.source_name,
                "capture_key": group["key"],
                "group_image_id": group["image_id"],
                "image_id": frame["image_id"],
                "camera_name": frame["camera_name"],
                "image_name": frame["name"],
                "source_point_count": source_point_count,
                "sampled_point_count": int(points.shape[0]),
                "in_image_count": projection["in_image_count"],
                "visible_count": projection["visible_count"],
                "visible_ratio": round(projection["visible_count"] / max(1, points.shape[0]), 6),
                **depth_stats(projection["depth"]),
                **edge_distance_stats(image, projection["x"], projection["y"]),
            }
            metrics.append(stats)
            overlay = draw_overlay(image_path, projection, frame, stats, args)
            overlay_name = f"{group_index:03d}_{group['key']}_{frame['camera_name']}_{frame['image_id']:06d}.jpg"
            overlay_path = overlays_dir / overlay_name
            cv2.imwrite(str(overlay_path), overlay, [cv2.IMWRITE_JPEG_QUALITY, 92])
            panels[frame["camera_name"]] = overlay

        sheet = make_sheet(panels, args)
        sheet_name = f"{group_index:03d}_{group['key']}_quad.jpg"
        sheet_path = sheets_dir / sheet_name
        cv2.imwrite(str(sheet_path), sheet, [cv2.IMWRITE_JPEG_QUALITY, 92])
        sheet_paths.append(str(sheet_path))

    csv_path = output / "metrics.csv"
    with csv_path.open("w", encoding="utf-8", newline="") as handle:
        fieldnames = sorted({key for row in metrics for key in row.keys()})
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(metrics)

    per_camera: dict[str, dict] = {}
    for camera_name in CAMERA_ORDER:
        rows = [row for row in metrics if row["camera_name"] == camera_name]
        if not rows:
            continue
        per_camera[camera_name] = {
            "frames": len(rows),
            "visible_count_median": float(np.median([row["visible_count"] for row in rows])),
            "visible_count_min": int(min(row["visible_count"] for row in rows)),
            "edge_median_px_median": float(np.median([row["edge_median_px"] for row in rows if row["edge_median_px"] is not None] or [0])),
            "edge_p90_px_median": float(np.median([row["edge_p90_px"] for row in rows if row["edge_p90_px"] is not None] or [0])),
        }
    summary = {
        "dataset": str(dataset),
        "pointcloud": str(args.pointcloud.resolve()),
        "source_name": args.source_name,
        "source_point_count": source_point_count,
        "sampled_point_count": int(points.shape[0]),
        "frame_count": len(frames),
        "group_count": len(groups),
        "selected_group_count": len(selected),
        "per_camera": per_camera,
        "sheets": sheet_paths,
        "metrics_csv": str(csv_path),
    }
    (output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
