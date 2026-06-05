#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tarfile
import time
from pathlib import Path

import numpy as np

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import compare_3dgs_sfm_trajectory as compare  # noqa: E402
import prepare_3dgs_colmap as prep  # noqa: E402


def import_pycolmap(extra_path: str | None):
    if extra_path:
        sys.path.insert(0, extra_path)
    import pycolmap  # type: ignore

    return pycolmap


def load_json(path: Path) -> dict:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def load_camera_records(root: Path, camera: str) -> tuple[dict, list[dict]]:
    global_manifest = load_json(root / "manifest.json")
    camera_root = root / camera
    local_manifest = load_json(camera_root / "manifest.json") or global_manifest
    frames_path = camera_root / "frames.jsonl"
    if not frames_path.exists():
        raise ValueError(f"frames.jsonl missing: {frames_path}")
    records: list[dict] = []
    for record in prep.load_jsonl(frames_path):
        next_record = dict(record)
        next_record["__manifest"] = local_manifest
        next_record["__record_root"] = str(camera_root)
        records.append(next_record)
    if not records:
        raise ValueError(f"no frames in {frames_path}")
    return global_manifest, records


def extract_needed_archive(archive: Path, root: Path, camera: str) -> Path:
    extract_root = root / "extracted"
    if extract_root.exists():
        shutil.rmtree(extract_root)
    extract_root.mkdir(parents=True, exist_ok=True)
    prefixes = (
        f"{camera}/",
        "shared_context/",
        "manifest.json",
        "local_capture_summary.json",
    )
    with tarfile.open(archive) as handle:
        members = [member for member in handle.getmembers() if any(member.name == prefix or member.name.startswith(prefix) for prefix in prefixes)]
        handle.extractall(extract_root, members=members)
    return extract_root


def ensure_link_or_copy(source: Path, target: Path, copy: bool) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() or target.is_symlink():
        target.unlink()
    if copy:
        shutil.copy2(source, target)
    else:
        os.symlink(source, target)


def opencv_params(params: tuple[int, int, float, float, float, float, list[float]]) -> tuple[int, int, list[float]]:
    width, height, fx, fy, cx, cy, distortion = params
    d = list(distortion) + [0.0] * 4
    return width, height, [float(fx), float(fy), float(cx), float(cy), float(d[0]), float(d[1]), float(d[2]), float(d[3])]


def parse_camera_params_override(raw: str | None) -> list[float] | None:
    if not raw:
        return None
    values = [float(item.strip()) for item in raw.split(",") if item.strip()]
    if len(values) != 8:
        raise ValueError("--camera-params must contain fx,fy,cx,cy,k1,k2,p1,p2")
    return values


def write_pairs(frames: list[dict], pairs_path: Path, sequential_overlap: int) -> int:
    pairs_path.parent.mkdir(parents=True, exist_ok=True)
    pair_count = 0
    with pairs_path.open("w", encoding="utf-8") as handle:
        for index, frame in enumerate(frames):
            for offset in range(1, sequential_overlap + 1):
                if index + offset >= len(frames):
                    break
                handle.write(f"{frame['relative_name']} {frames[index + offset]['relative_name']}\n")
                pair_count += 1
    return pair_count


def write_ndt_reference(root: Path, frames: list[dict], camera_params: tuple[int, int, list[float]], pose_history: list[dict]) -> dict:
    sparse = root / "ndt_reference" / "sparse" / "0"
    sparse.mkdir(parents=True, exist_ok=True)
    width, height, params = camera_params
    (sparse / "cameras.txt").write_text(
        "# Camera list with one line of data per camera:\n"
        "# CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]\n"
        f"1 OPENCV {width} {height} {' '.join(f'{item:.12g}' for item in params)}\n",
        encoding="utf-8",
    )
    image_lines = [
        "# Image list with two lines of data per image:\n",
        "# IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME\n",
    ]
    used = 0
    gaps: list[float] = []
    manifest = frames[0].get("__manifest") if isinstance(frames[0].get("__manifest"), dict) else {}
    for image_id, frame in enumerate(frames, start=1):
        world_to_camera, mode, gap_ms = prep.matrix_from_record(frame, pose_history, manifest)
        if mode != "cloud_pose_history_interpolated":
            raise ValueError(f"unexpected pose mode for {frame['relative_name']}: {mode}")
        qvec = prep.rotmat_to_qvec(world_to_camera[:3, :3])
        tvec = world_to_camera[:3, 3]
        image_lines.append(
            f"{image_id} "
            f"{qvec[0]:.17g} {qvec[1]:.17g} {qvec[2]:.17g} {qvec[3]:.17g} "
            f"{tvec[0]:.17g} {tvec[1]:.17g} {tvec[2]:.17g} "
            f"1 {frame['relative_name']}\n\n"
        )
        used += 1
        if gap_ms is not None:
            gaps.append(float(gap_ms))
    (sparse / "images.txt").write_text("".join(image_lines), encoding="utf-8")
    return {
        "images_txt": str(sparse / "images.txt"),
        "used_frame_count": used,
        "pose_gap_ms": {
            "max": max(gaps) if gaps else None,
            "median": float(np.median(gaps)) if gaps else None,
        },
    }


def run(args: argparse.Namespace) -> dict:
    pycolmap = import_pycolmap(args.pycolmap_path)
    archive = args.image_pose.resolve()
    output = args.output.resolve()
    workspace = output / "workspace"
    if args.overwrite and output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True, exist_ok=True)
    workspace.mkdir(parents=True, exist_ok=True)

    extracted = extract_needed_archive(archive, workspace, args.camera)
    manifest, raw_records = load_camera_records(extracted, args.camera)
    pose_history = prep.load_pose_history(extracted)
    if not pose_history:
        raise ValueError("pose_history.jsonl missing or empty")
    camera_params_override = parse_camera_params_override(args.camera_params)

    frames: list[dict] = []
    images_root = workspace / "images"
    for index, record in enumerate(raw_records):
        local_manifest = prep.record_manifest(record, manifest)
        source_image = prep.image_path_from_record(record, extracted)
        params = prep.camera_params(record, local_manifest, source_image)
        width, height, opencv_camera_params = opencv_params(params)
        if camera_params_override is not None:
            opencv_camera_params = list(camera_params_override)
        if index == 0:
            camera_params = (width, height, opencv_camera_params)
        relative_name = f"{args.camera}/{source_image.name}"
        target_image = images_root / relative_name
        ensure_link_or_copy(source_image, target_image, args.copy_images)
        next_record = dict(record)
        next_record["relative_name"] = relative_name
        frames.append(next_record)
    frames.sort(key=lambda item: float(prep.record_image_timestamp_s(item) or 0.0))

    pairs_path = workspace / "pairs.txt"
    pair_count = write_pairs(frames, pairs_path, int(args.sequential_overlap))
    (workspace / "selected_frames.json").write_text(json.dumps(frames, ensure_ascii=False, indent=2), encoding="utf-8")
    ndt_reference = write_ndt_reference(workspace, frames, camera_params, pose_history)

    database_path = workspace / "database.db"
    if database_path.exists():
        database_path.unlink()
    extraction_options = pycolmap.FeatureExtractionOptions()
    extraction_options.use_gpu = False
    extraction_options.max_image_size = int(args.max_image_size)
    extraction_options.num_threads = int(args.num_threads)
    extraction_options.sift.max_num_features = int(args.max_num_features)

    reader_options = pycolmap.ImageReaderOptions()
    reader_options.camera_model = "OPENCV"
    reader_options.camera_params = ",".join(f"{item:.12g}" for item in camera_params[2])
    image_names = [frame["relative_name"] for frame in frames]
    pycolmap.extract_features(
        database_path,
        images_root,
        image_names=image_names,
        camera_mode=pycolmap.CameraMode.SINGLE,
        reader_options=reader_options,
        extraction_options=extraction_options,
    )

    matching_options = pycolmap.FeatureMatchingOptions()
    matching_options.use_gpu = False
    matching_options.num_threads = int(args.num_threads)
    matching_options.sift.max_ratio = float(args.match_ratio)
    matching_options.sift.cross_check = True
    pairing_options = pycolmap.ImportedPairingOptions()
    pairing_options.match_list_path = str(pairs_path)
    pycolmap.match_image_pairs(database_path, matching_options=matching_options, pairing_options=pairing_options)

    sparse_root = workspace / "sparse"
    sparse_text = workspace / "sparse_text"
    mapper_options = pycolmap.IncrementalPipelineOptions()
    mapper_options.multiple_models = True
    mapper_options.max_num_models = int(args.max_num_models)
    mapper_options.min_model_size = int(args.min_model_size)
    mapper_options.min_num_matches = int(args.min_num_matches)
    mapper_options.ba_refine_focal_length = bool(args.refine_intrinsics)
    mapper_options.ba_refine_principal_point = bool(args.refine_intrinsics)
    mapper_options.ba_refine_extra_params = bool(args.refine_intrinsics)
    mapper_options.ba_use_gpu = False
    mapper_options.num_threads = int(args.num_threads)
    mapper_options.extract_colors = True
    sparse_root.mkdir(parents=True, exist_ok=True)
    reconstructions = pycolmap.incremental_mapping(database_path, images_root, sparse_root, options=mapper_options)
    if not reconstructions:
        raise ValueError("pycolmap produced no reconstruction")
    best_id, best = max(reconstructions.items(), key=lambda item: item[1].num_reg_images())
    sparse_text.mkdir(parents=True, exist_ok=True)
    best.write_text(sparse_text)

    compare_output = output / "trajectory_compare"
    ndt_images = workspace / "ndt_reference" / "sparse" / "0" / "images.txt"
    sfm_images = sparse_text / "images.txt"
    ndt_frames = compare.read_colmap_images(ndt_images)
    sfm_frames = compare.read_colmap_images(sfm_images)
    common_names = sorted(set(ndt_frames).intersection(sfm_frames))
    if len(common_names) < 3:
        raise ValueError(f"not enough common registered images: {len(common_names)}")
    ndt_positions = np.asarray([ndt_frames[name]["position"] for name in common_names], dtype=np.float64)
    sfm_positions = np.asarray([sfm_frames[name]["position"] for name in common_names], dtype=np.float64)
    scale, rotation, translation = compare.umeyama_similarity(sfm_positions, ndt_positions)
    sfm_aligned = (scale * (rotation @ sfm_positions.T)).T + translation
    residuals = np.linalg.norm(sfm_aligned - ndt_positions, axis=1)
    rows = []
    for idx, name in enumerate(common_names):
        rows.append(
            {
                "image_name": name,
                "camera_name": ndt_frames[name]["camera_name"],
                "ndt_position": ndt_positions[idx],
                "sfm_position": sfm_positions[idx],
                "sfm_aligned_position": sfm_aligned[idx],
                "residual_m": float(residuals[idx]),
            }
        )
    compare_output.mkdir(parents=True, exist_ok=True)
    csv_path = compare_output / "trajectory_compare.csv"
    import csv

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
            writer.writerow(
                {
                    "image_name": row["image_name"],
                    "camera_name": row["camera_name"],
                    "ndt_x": f"{row['ndt_position'][0]:.9g}",
                    "ndt_y": f"{row['ndt_position'][1]:.9g}",
                    "ndt_z": f"{row['ndt_position'][2]:.9g}",
                    "sfm_x": f"{row['sfm_position'][0]:.9g}",
                    "sfm_y": f"{row['sfm_position'][1]:.9g}",
                    "sfm_z": f"{row['sfm_position'][2]:.9g}",
                    "sfm_aligned_x": f"{row['sfm_aligned_position'][0]:.9g}",
                    "sfm_aligned_y": f"{row['sfm_aligned_position'][1]:.9g}",
                    "sfm_aligned_z": f"{row['sfm_aligned_position'][2]:.9g}",
                    "residual_m": f"{row['residual_m']:.9g}",
                }
            )
    compare.draw_trajectory(rows, compare_output / "trajectory_xy_compare.jpg")

    summary = {
        "image_pose": str(archive),
        "camera": args.camera,
        "model": "OPENCV",
        "refine_intrinsics": bool(args.refine_intrinsics),
        "workspace": str(workspace),
        "raw_frame_count": len(frames),
        "registered_image_count": int(best.num_reg_images()),
        "sfm_point_count": int(best.num_points3D()),
        "best_reconstruction_id": int(best_id),
        "pair_count": pair_count,
        "camera_params_initial": camera_params[2],
        "camera_params_override": camera_params_override,
        "ndt_reference": ndt_reference,
        "similarity_sfm_to_ndt": {
            "scale": scale,
            "rotation": rotation.tolist(),
            "translation": translation.tolist(),
        },
        "overall": compare.stats(residuals),
        "per_camera_independent_alignment": compare.independent_alignment_stats(rows),
        "csv": str(csv_path),
        "trajectory_plot": str(compare_output / "trajectory_xy_compare.jpg"),
        "created_at_unix": time.time(),
    }
    (output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="Run raw-image OPENCV visual SfM for one 3DGS camera and compare it with NDT pose-history interpolation.")
    parser.add_argument("--image-pose", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--camera", default="camera1")
    parser.add_argument(
        "--camera-params",
        default="",
        help="Optional OPENCV params override: fx,fy,cx,cy,k1,k2,p1,p2. Useful for testing newly reported calibration against old image data.",
    )
    parser.add_argument("--pycolmap-path", default="/home/admin1/jgzj/.runtime/pycolmap-py313")
    parser.add_argument("--max-image-size", type=int, default=1920)
    parser.add_argument("--max-num-features", type=int, default=8192)
    parser.add_argument("--sequential-overlap", type=int, default=20)
    parser.add_argument("--match-ratio", type=float, default=0.8)
    parser.add_argument("--max-num-models", type=int, default=8)
    parser.add_argument("--min-model-size", type=int, default=20)
    parser.add_argument("--min-num-matches", type=int, default=25)
    parser.add_argument("--num-threads", type=int, default=-1)
    parser.add_argument("--refine-intrinsics", action="store_true")
    parser.add_argument("--copy-images", action="store_true")
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()
    run(args)


if __name__ == "__main__":
    main()
