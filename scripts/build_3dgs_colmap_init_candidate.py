#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
import time
from pathlib import Path

import numpy as np

import compare_3dgs_sfm_trajectory as compare
import run_3dgs_visual_sfm as visual_sfm


def read_points_ply(path: Path) -> tuple[np.ndarray, np.ndarray]:
    lines = path.read_text(encoding="utf-8").splitlines()
    try:
        end_header = lines.index("end_header")
    except ValueError as exc:
        raise ValueError(f"PLY header not found: {path}") from exc
    header = lines[: end_header + 1]
    properties: list[str] = []
    in_vertex = False
    vertex_count = 0
    for line in header:
        parts = line.strip().split()
        if not parts:
            continue
        if parts[0] == "element":
            in_vertex = parts[1] == "vertex"
            if in_vertex:
                vertex_count = int(parts[2])
        elif in_vertex and parts[0] == "property" and len(parts) >= 3:
            properties.append(parts[2])
    prop_index = {name: index for index, name in enumerate(properties)}
    if not {"x", "y", "z"}.issubset(prop_index):
        raise ValueError(f"PLY missing xyz: {path}")
    has_color = {"red", "green", "blue"}.issubset(prop_index)
    points: list[list[float]] = []
    colors: list[list[int]] = []
    for raw in lines[end_header + 1 : end_header + 1 + vertex_count]:
        if not raw.strip():
            continue
        values = raw.split()
        points.append([
            float(values[prop_index["x"]]),
            float(values[prop_index["y"]]),
            float(values[prop_index["z"]]),
        ])
        if has_color:
            colors.append([
                int(float(values[prop_index["red"]])),
                int(float(values[prop_index["green"]])),
                int(float(values[prop_index["blue"]])),
            ])
        else:
            colors.append([180, 180, 180])
    return np.asarray(points, dtype=np.float64), np.asarray(colors, dtype=np.uint8)


def write_points_ply(path: Path, points: np.ndarray, colors: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        handle.write("ply\n")
        handle.write("format ascii 1.0\n")
        handle.write(f"element vertex {points.shape[0]}\n")
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
        for point, color in zip(points, colors):
            handle.write(
                f"{point[0]:.8f} {point[1]:.8f} {point[2]:.8f} 0 0 0 "
                f"{int(color[0])} {int(color[1])} {int(color[2])}\n"
            )


def align_sfm_points_to_dataset(dataset: Path, sfm_dataset: Path, output_ply: Path) -> dict:
    ndt_images = dataset / "sparse" / "0" / "images.txt"
    sfm_images = sfm_dataset / "sparse" / "0" / "images.txt"
    ndt_frames = compare.read_colmap_images(ndt_images)
    sfm_frames = compare.read_colmap_images(sfm_images)
    common_names = sorted(set(ndt_frames).intersection(sfm_frames))
    if len(common_names) < 3:
        raise ValueError(f"not enough common images to align SfM to map coordinates: {len(common_names)}")

    ndt_positions = np.asarray([ndt_frames[name]["position"] for name in common_names], dtype=np.float64)
    sfm_positions = np.asarray([sfm_frames[name]["position"] for name in common_names], dtype=np.float64)
    scale, rotation, translation = compare.umeyama_similarity(sfm_positions, ndt_positions)
    aligned_centers = (scale * (rotation @ sfm_positions.T)).T + translation
    residuals = np.linalg.norm(aligned_centers - ndt_positions, axis=1)

    sfm_points, colors = read_points_ply(sfm_dataset / "sparse" / "0" / "points3D.ply")
    aligned_points = (scale * (rotation @ sfm_points.T)).T + translation
    write_points_ply(output_ply, aligned_points, colors)

    return {
        "common_image_count": len(common_names),
        "source_sfm_point_count": int(sfm_points.shape[0]),
        "aligned_point_count": int(aligned_points.shape[0]),
        "similarity_sfm_to_map": {
            "scale": scale,
            "rotation": rotation.tolist(),
            "translation": translation.tolist(),
        },
        "alignment_residual": compare.stats(residuals),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Build a map-aligned COLMAP/SfM pointcloud candidate for 3DGS initialization.")
    parser.add_argument("--dataset", required=True, type=Path)
    parser.add_argument("--workspace", required=True, type=Path)
    parser.add_argument("--output-ply", required=True, type=Path)
    parser.add_argument("--summary", required=True, type=Path)
    parser.add_argument("--pycolmap-path", default=".runtime/pycolmap-py313")
    parser.add_argument("--max-frames-per-camera", type=int, default=240)
    parser.add_argument("--max-image-size", type=int, default=1100)
    parser.add_argument("--max-num-features", type=int, default=10000)
    parser.add_argument("--sequential-overlap", type=int, default=10)
    parser.add_argument("--cross-nearest", type=int, default=3)
    parser.add_argument("--num-threads", type=int, default=-1)
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()

    dataset = args.dataset.resolve()
    workspace = args.workspace.resolve()
    sfm_dataset = workspace / "sfm_dataset"
    if args.overwrite and workspace.exists():
        shutil.rmtree(workspace)
    workspace.mkdir(parents=True, exist_ok=True)

    sfm_args = argparse.Namespace(
        dataset=dataset,
        workspace=workspace / "sfm_workspace",
        output_dataset=sfm_dataset,
        pycolmap_path=str(Path(args.pycolmap_path).resolve()),
        max_frames_per_camera=int(args.max_frames_per_camera),
        max_image_size=int(args.max_image_size),
        max_num_features=int(args.max_num_features),
        sequential_overlap=int(args.sequential_overlap),
        cross_nearest=int(args.cross_nearest),
        max_cross_delta_s=1.5,
        match_ratio=0.8,
        max_num_models=8,
        min_model_size=20,
        min_num_matches=25,
        num_threads=int(args.num_threads),
        copy_images=True,
        overwrite=True,
    )
    sfm_summary = visual_sfm.run_sfm(sfm_args)
    alignment = align_sfm_points_to_dataset(dataset, sfm_dataset, args.output_ply.resolve())
    summary = {
        "source": "colmap_sfm_aligned",
        "note": "pycolmap visual SfM triangulated point cloud aligned to current map/NDT COLMAP camera centers. This is a visual SfM candidate, not CUDA PatchMatch MVS dense stereo.",
        "dataset": str(dataset),
        "workspace": str(workspace),
        "sfm_dataset": str(sfm_dataset.resolve()),
        "output_ply": str(args.output_ply.resolve()),
        "created_at_unix": time.time(),
        "sfm": sfm_summary,
        "alignment": alignment,
    }
    args.summary.parent.mkdir(parents=True, exist_ok=True)
    args.summary.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
