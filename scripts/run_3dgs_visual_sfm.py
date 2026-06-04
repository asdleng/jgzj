#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import sys
import time
from pathlib import Path

import numpy as np


CAMERA_ORDER = ["camera1", "camera2", "camera3", "camera4"]


def import_pycolmap(extra_path: str | None):
    if extra_path:
        sys.path.insert(0, extra_path)
    import pycolmap  # type: ignore

    return pycolmap


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def read_colmap_image_names(path: Path) -> dict[int, str]:
    names: dict[int, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        text = line.strip()
        if not text or text.startswith("#"):
            continue
        parts = text.split()
        if len(parts) >= 10:
            names[int(parts[0])] = " ".join(parts[9:])
    return names


def write_3dgs_points_ply(points_txt: Path, ply_path: Path) -> int:
    """Write COLMAP points as a gaussian-splatting compatible PLY.

    The common gaussian-splatting loader expects x/y/z, nx/ny/nz and RGB
    fields. pycolmap's export_PLY omits normals, which makes that loader
    return None and fail during point-cloud initialization.
    """
    rows: list[tuple[float, float, float, int, int, int]] = []
    for line in points_txt.read_text(encoding="utf-8").splitlines():
        text = line.strip()
        if not text or text.startswith("#"):
            continue
        parts = text.split()
        if len(parts) < 8:
            continue
        rows.append(
            (
                float(parts[1]),
                float(parts[2]),
                float(parts[3]),
                int(parts[4]),
                int(parts[5]),
                int(parts[6]),
            )
        )

    ply_path.parent.mkdir(parents=True, exist_ok=True)
    with ply_path.open("w", encoding="ascii") as handle:
        handle.write("ply\n")
        handle.write("format ascii 1.0\n")
        handle.write(f"element vertex {len(rows)}\n")
        handle.write("property float x\n")
        handle.write("property float y\n")
        handle.write("property float z\n")
        handle.write("property float nx\n")
        handle.write("property float ny\n")
        handle.write("property float nz\n")
        handle.write("property uchar red\n")
        handle.write("property uchar green\n")
        handle.write("property uchar blue\n")
        handle.write("end_header\n")
        for x, y, z, red, green, blue in rows:
            handle.write(f"{x:.9g} {y:.9g} {z:.9g} 0 0 0 {red} {green} {blue}\n")
    return len(rows)


def ensure_link_or_copy(source: Path, target: Path, copy: bool) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() or target.is_symlink():
        target.unlink()
    if copy:
        shutil.copy2(source, target)
    else:
        os.symlink(source, target)


def selected_frames(dataset: Path, max_frames_per_camera: int) -> list[dict]:
    metadata_path = dataset / "frame_metadata.json"
    if not metadata_path.exists():
        raise ValueError(f"frame_metadata.json missing: {metadata_path}")
    payload = load_json(metadata_path)
    image_names = read_colmap_image_names(dataset / "sparse" / "0" / "images.txt")
    by_camera: dict[str, list[dict]] = {}
    for item in payload.get("frames", []):
        camera_name = str(item.get("camera_name") or "")
        image_id = int(item.get("image_id") or 0)
        image_name = image_names.get(image_id) or item.get("image_name")
        timestamp = item.get("image_ts_unix")
        if not camera_name or not image_name or timestamp is None:
            continue
        next_item = dict(item)
        next_item["image_name"] = image_name
        next_item["relative_name"] = f"{camera_name}/{Path(image_name).name}"
        by_camera.setdefault(camera_name, []).append(next_item)

    selected: list[dict] = []
    for camera_name in CAMERA_ORDER:
        items = sorted(by_camera.get(camera_name, []), key=lambda row: float(row["image_ts_unix"]))
        if max_frames_per_camera > 0:
            if len(items) > max_frames_per_camera:
                indices = np.linspace(0, len(items) - 1, max_frames_per_camera)
                items = [items[int(round(index))] for index in indices]
        selected.extend(items)
    return selected


def camera_params_by_name(dataset: Path) -> dict[str, dict]:
    summary = load_json(dataset / "three_dgs_dataset_summary.json")
    result: dict[str, dict] = {}
    for item in summary.get("cameras", []):
        name = str(item.get("name") or "")
        if not name:
            continue
        result[name] = item
    return result


def write_pairs(frames: list[dict], pairs_path: Path, sequential_overlap: int, cross_nearest: int, max_cross_delta_s: float) -> dict:
    by_camera: dict[str, list[dict]] = {}
    for frame in frames:
        by_camera.setdefault(frame["camera_name"], []).append(frame)
    for camera_name in by_camera:
        by_camera[camera_name].sort(key=lambda row: float(row["image_ts_unix"]))

    pairs: set[tuple[str, str]] = set()

    def add_pair(left: dict, right: dict) -> None:
        a = left["relative_name"]
        b = right["relative_name"]
        if a == b:
            return
        pairs.add((a, b) if a < b else (b, a))

    for items in by_camera.values():
        for index, frame in enumerate(items):
            for offset in range(1, sequential_overlap + 1):
                if index + offset < len(items):
                    add_pair(frame, items[index + offset])

    if cross_nearest > 0:
        for camera_name, items in by_camera.items():
            other_cameras = [name for name in by_camera.keys() if name != camera_name]
            for frame in items:
                timestamp = float(frame["image_ts_unix"])
                for other_name in other_cameras:
                    others = by_camera[other_name]
                    ranked = sorted(
                        others,
                        key=lambda row: abs(float(row["image_ts_unix"]) - timestamp),
                    )[:cross_nearest]
                    for other in ranked:
                        if abs(float(other["image_ts_unix"]) - timestamp) <= max_cross_delta_s:
                            add_pair(frame, other)

    pairs_path.parent.mkdir(parents=True, exist_ok=True)
    with pairs_path.open("w", encoding="utf-8") as handle:
        for left, right in sorted(pairs):
            handle.write(f"{left} {right}\n")
    return {"pair_count": len(pairs), "cameras": {key: len(value) for key, value in by_camera.items()}}


def run_sfm(args: argparse.Namespace) -> dict:
    pycolmap = import_pycolmap(args.pycolmap_path)
    dataset = args.dataset.resolve()
    workspace = args.workspace.resolve()
    images_root = workspace / "images"
    database_path = workspace / "database.db"
    sparse_root = workspace / "sparse"
    text_root = workspace / "sparse_text"
    output_dataset = args.output_dataset.resolve() if args.output_dataset else workspace / "dataset"
    for path in (workspace, output_dataset):
        if args.overwrite and path.exists():
            shutil.rmtree(path)
        path.mkdir(parents=True, exist_ok=True)

    frames = selected_frames(dataset, args.max_frames_per_camera)
    if not frames:
        raise ValueError("no frames selected")
    camera_params = camera_params_by_name(dataset)
    source_images = dataset / "images"
    for frame in frames:
        ensure_link_or_copy(source_images / frame["image_name"], images_root / frame["relative_name"], args.copy_images)
    (workspace / "selected_frames.json").write_text(json.dumps(frames, ensure_ascii=False, indent=2), encoding="utf-8")

    if database_path.exists():
        database_path.unlink()

    extraction_options = pycolmap.FeatureExtractionOptions()
    extraction_options.use_gpu = False
    extraction_options.max_image_size = int(args.max_image_size)
    extraction_options.num_threads = int(args.num_threads)
    extraction_options.sift.max_num_features = int(args.max_num_features)

    for camera_name in CAMERA_ORDER:
        camera_frames = [frame for frame in frames if frame["camera_name"] == camera_name]
        if not camera_frames:
            continue
        params = camera_params.get(camera_name)
        if not params:
            raise ValueError(f"camera params missing for {camera_name}")
        reader_options = pycolmap.ImageReaderOptions()
        reader_options.camera_model = "PINHOLE"
        reader_options.camera_params = f"{params['fx']},{params['fy']},{params['cx']},{params['cy']}"
        image_names = [frame["relative_name"] for frame in camera_frames]
        pycolmap.extract_features(
            database_path,
            images_root,
            image_names=image_names,
            camera_mode=pycolmap.CameraMode.SINGLE,
            reader_options=reader_options,
            extraction_options=extraction_options,
        )

    pairs_path = workspace / "pairs.txt"
    pair_summary = write_pairs(
        frames,
        pairs_path,
        sequential_overlap=int(args.sequential_overlap),
        cross_nearest=int(args.cross_nearest),
        max_cross_delta_s=float(args.max_cross_delta_s),
    )

    matching_options = pycolmap.FeatureMatchingOptions()
    matching_options.use_gpu = False
    matching_options.num_threads = int(args.num_threads)
    matching_options.sift.max_ratio = float(args.match_ratio)
    matching_options.sift.cross_check = True
    pairing_options = pycolmap.ImportedPairingOptions()
    pairing_options.match_list_path = str(pairs_path)
    pycolmap.match_image_pairs(database_path, matching_options=matching_options, pairing_options=pairing_options)

    mapper_options = pycolmap.IncrementalPipelineOptions()
    mapper_options.multiple_models = True
    mapper_options.max_num_models = int(args.max_num_models)
    mapper_options.min_model_size = int(args.min_model_size)
    mapper_options.min_num_matches = int(args.min_num_matches)
    mapper_options.ba_refine_focal_length = False
    mapper_options.ba_refine_principal_point = False
    mapper_options.ba_refine_extra_params = False
    mapper_options.ba_use_gpu = False
    mapper_options.num_threads = int(args.num_threads)
    mapper_options.extract_colors = True
    sparse_root.mkdir(parents=True, exist_ok=True)
    reconstructions = pycolmap.incremental_mapping(database_path, images_root, sparse_root, options=mapper_options)
    if not reconstructions:
        raise ValueError("pycolmap produced no reconstruction")

    best_id, best = max(reconstructions.items(), key=lambda item: item[1].num_reg_images())
    text_root.mkdir(parents=True, exist_ok=True)
    best.write_text(text_root)

    output_sparse = output_dataset / "sparse" / "0"
    output_images = output_dataset / "images"
    output_sparse.mkdir(parents=True, exist_ok=True)
    output_images.mkdir(parents=True, exist_ok=True)
    for file_name in ("cameras.txt", "images.txt", "points3D.txt"):
        shutil.copy2(text_root / file_name, output_sparse / file_name)
    ply_point_count = write_3dgs_points_ply(output_sparse / "points3D.txt", output_sparse / "points3D.ply")

    registered_names = {best.image(image_id).name for image_id in best.reg_image_ids()}
    for name in registered_names:
        src = images_root / name
        dst = output_images / Path(name).name
        # The output dataset is later rsynced to A100. Keep real files here so
        # local workspace symlinks never become broken remote links.
        ensure_link_or_copy(src.resolve(), dst, True)

    # COLMAP text keeps subdirectory image names; 3DGS training expects flat images.
    images_txt = (output_sparse / "images.txt").read_text(encoding="utf-8")
    for name in sorted(registered_names, key=len, reverse=True):
        images_txt = images_txt.replace(name, Path(name).name)
    (output_sparse / "images.txt").write_text(images_txt, encoding="utf-8")

    summary = {
        "source_dataset": str(dataset),
        "workspace": str(workspace),
        "output_dataset": str(output_dataset),
        "selected_frame_count": len(frames),
        "registered_image_count": int(best.num_reg_images()),
        "sfm_point_count": int(best.num_points3D()),
        "ply_point_count": int(ply_point_count),
        "best_reconstruction_id": int(best_id),
        "pair_summary": pair_summary,
        "created_at_unix": time.time(),
        "note": "Pure visual SfM reconstruction. Coordinates are arbitrary SfM coordinates, not GlobalMap/NDT map coordinates.",
    }
    (output_dataset / "three_dgs_dataset_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="Estimate 3DGS camera poses with visual SfM and build a COLMAP dataset.")
    parser.add_argument("--dataset", required=True, type=Path)
    parser.add_argument("--workspace", required=True, type=Path)
    parser.add_argument("--output-dataset", type=Path)
    parser.add_argument("--pycolmap-path", default=".runtime/pycolmap-py313")
    parser.add_argument("--max-frames-per-camera", type=int, default=0)
    parser.add_argument("--max-image-size", type=int, default=960)
    parser.add_argument("--max-num-features", type=int, default=8192)
    parser.add_argument("--sequential-overlap", type=int, default=8)
    parser.add_argument("--cross-nearest", type=int, default=2)
    parser.add_argument("--max-cross-delta-s", type=float, default=1.5)
    parser.add_argument("--match-ratio", type=float, default=0.8)
    parser.add_argument("--max-num-models", type=int, default=8)
    parser.add_argument("--min-model-size", type=int, default=20)
    parser.add_argument("--min-num-matches", type=int, default=25)
    parser.add_argument("--num-threads", type=int, default=-1)
    parser.add_argument("--copy-images", action="store_true")
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()
    run_sfm(args)


if __name__ == "__main__":
    main()
