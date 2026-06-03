#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import struct
import subprocess
import tarfile
import tempfile
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image

try:
    import cv2
except Exception:  # pragma: no cover
    cv2 = None


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
    frames_path = find_first(root, ("frames.jsonl",))
    manifest: dict = {}
    records: list[dict] = []

    if manifest_path:
        manifest = load_json(manifest_path)
        for key in ("records", "frames", "frame_records"):
            value = manifest.get(key)
            if isinstance(value, list):
                records = [item for item in value if isinstance(item, dict)]
                break

    if not records and frames_path:
        records = load_jsonl(frames_path)

    if not records:
        jsonl_files = sorted(root.rglob("*.jsonl"))
        for item in jsonl_files:
            records = load_jsonl(item)
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
    images_dir = find_images_dir(root)

    for raw in candidates:
        if not raw:
            continue
        value = str(raw)
        direct = Path(value)
        if direct.exists():
            return direct
        rel = root / value
        if rel.exists():
            return rel
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


def undistort_or_copy(src: Path, dst: Path, params: tuple[int, int, float, float, float, float, list[float]], undistort: bool) -> tuple[int, int, float, float, float, float]:
    width, height, fx, fy, cx, cy, distortion = params
    if not undistort or cv2 is None or not distortion or max(abs(item) for item in distortion) <= 1e-12:
        shutil.copy2(src, dst)
        return width, height, fx, fy, cx, cy

    image = cv2.imread(str(src), cv2.IMREAD_COLOR)
    if image is None:
        shutil.copy2(src, dst)
        return width, height, fx, fy, cx, cy

    actual_height, actual_width = image.shape[:2]
    width, height = actual_width, actual_height
    camera_matrix = np.array([[fx, 0.0, cx], [0.0, fy, cy], [0.0, 0.0, 1.0]], dtype=np.float64)
    dist = np.array(distortion, dtype=np.float64).reshape(-1, 1)
    new_matrix, _roi = cv2.getOptimalNewCameraMatrix(camera_matrix, dist, (width, height), 0, (width, height))
    output = cv2.undistort(image, camera_matrix, dist, None, new_matrix)
    cv2.imwrite(str(dst), output)
    return width, height, float(new_matrix[0, 0]), float(new_matrix[1, 1]), float(new_matrix[0, 2]), float(new_matrix[1, 2])


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


def prepare_scene(args: argparse.Namespace) -> dict:
    output = Path(args.output).resolve()
    images_out = output / "images"
    sparse_out = output / "sparse" / "0"
    images_out.mkdir(parents=True, exist_ok=True)
    sparse_out.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="three_dgs_prepare_") as tmp:
        work_dir = Path(tmp)
        image_root = extract_archive(Path(args.image_pose).resolve(), work_dir)
        manifest, records = load_records(image_root)

        camera_models: dict[tuple[str, int, int, float, float, float, float], int] = {}
        camera_lines: list[str] = []
        image_lines: list[str] = []
        copied_count = 0

        for image_id, record in enumerate(records, start=1):
            source_image = image_path_from_record(record, image_root)
            params = camera_params(record, manifest, source_image)
            out_name = f"frame_{image_id:06d}{source_image.suffix.lower() or '.jpg'}"
            output_image = images_out / out_name
            width, height, fx, fy, cx, cy = undistort_or_copy(
                source_image,
                output_image,
                params,
                args.undistort.lower() != "false",
            )
            camera_key = (
                record_camera_id(record, manifest),
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

            world_to_camera = matrix_from_record(record)
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
            copied_count += 1

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

        ascii_ply = pcd_or_ply_to_ascii_ply(Path(args.pointcloud).resolve(), work_dir)
        points, colors = parse_ascii_ply(ascii_ply, int(args.max_points))
        write_points_ply(sparse_out / "points3D.ply", points, colors)

        summary = {
            "scene_name": args.scene_name,
            "output": str(output),
            "image_count": copied_count,
            "point_count": len(points),
            "camera_count": len(camera_models),
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
                }
                for key, camera_id in camera_models.items()
            ],
        }

        with (output / "three_dgs_dataset_summary.json").open("w", encoding="utf-8") as handle:
            json.dump(summary, handle, ensure_ascii=False, indent=2)
        return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare vehicle 3DGS capture data as a COLMAP scene.")
    parser.add_argument("--image-pose", required=True)
    parser.add_argument("--pointcloud", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--scene-name", default="scene")
    parser.add_argument("--max-points", type=int, default=500000)
    parser.add_argument("--undistort", default="true")
    args = parser.parse_args()

    summary = prepare_scene(args)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
