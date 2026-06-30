#!/usr/bin/env python3
import argparse
import base64
import json
import math
import os
import pathlib
import time
import zlib

import numpy as np


def read_capture(path):
    payload = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    result = payload.get("result") if isinstance(payload.get("result"), dict) else payload
    pointcloud = result.get("pointcloud") or result.get("points") or {}
    if pointcloud.get("encoding") != "float32_xyz_zlib_base64":
        raise RuntimeError("capture does not contain float32_xyz_zlib_base64 pointcloud")
    raw = zlib.decompress(base64.b64decode(pointcloud["points_base64"]))
    points = np.frombuffer(raw, dtype="<f4").reshape((-1, 3)).astype(np.float32, copy=False)
    pose = result.get("pose") if isinstance(result.get("pose"), dict) else None
    return payload, result, points, pose


def parse_pcd_header(fp):
    header = {}
    while True:
        line = fp.readline()
        if not line:
            raise RuntimeError("PCD header ended before DATA")
        text = line.decode("utf-8", errors="replace").strip()
        if not text or text.startswith("#"):
            continue
        parts = text.split()
        key = parts[0].upper()
        header[key] = parts[1:]
        if key == "DATA":
            if len(parts) < 2 or parts[1].lower() != "binary":
                raise RuntimeError("only binary PCD is supported")
            return header, fp.tell()


def pcd_dtype(header):
    fields = header.get("FIELDS") or []
    sizes = [int(v) for v in (header.get("SIZE") or [])]
    types = header.get("TYPE") or []
    counts = [int(v) for v in (header.get("COUNT") or ["1"] * len(fields))]
    if not (len(fields) == len(sizes) == len(types) == len(counts)):
        raise RuntimeError("invalid PCD field metadata")
    dtype_fields = []
    for field, size, type_code, count in zip(fields, sizes, types, counts):
        if type_code == "F" and size == 4:
            dt = "<f4"
        elif type_code == "F" and size == 8:
            dt = "<f8"
        elif type_code == "I" and size == 4:
            dt = "<i4"
        elif type_code == "U" and size == 4:
            dt = "<u4"
        elif type_code == "I" and size == 2:
            dt = "<i2"
        elif type_code == "U" and size == 2:
            dt = "<u2"
        elif type_code == "I" and size == 1:
            dt = "i1"
        elif type_code == "U" and size == 1:
            dt = "u1"
        else:
            raise RuntimeError(f"unsupported PCD field {field} type={type_code} size={size}")
        dtype_fields.append((field, dt) if count == 1 else (field, dt, (count,)))
    dtype = np.dtype(dtype_fields)
    for name in ("x", "y", "z"):
        if name not in dtype.names:
            raise RuntimeError(f"PCD missing {name} field")
    return dtype


def load_map_xyz(map_pcd):
    with open(map_pcd, "rb") as fp:
        header, offset = parse_pcd_header(fp)
    points = int((header.get("POINTS") or ["0"])[0])
    dtype = pcd_dtype(header)
    arr = np.memmap(map_pcd, dtype=dtype, mode="r", offset=offset, shape=(points,))
    return arr["x"], arr["y"], arr["z"], header


def cache_path_for(map_pcd, voxel):
    path = pathlib.Path(map_pcd)
    cache_dir = path.parent / ".lidar_relocalization_cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    key = f"{path.name}.voxel{voxel:.2f}.occupancy.npz"
    return cache_dir / key


def build_or_load_occupancy(map_pcd, voxel):
    cache_path = cache_path_for(map_pcd, voxel)
    map_stat = pathlib.Path(map_pcd).stat()
    if cache_path.exists():
        try:
            cached = np.load(cache_path)
            if int(cached["map_size_bytes"]) == map_stat.st_size and float(cached["voxel"]) == float(voxel):
                return {
                    "occupancy": cached["occupancy"].astype(bool, copy=False),
                    "min_x": float(cached["min_x"]),
                    "min_y": float(cached["min_y"]),
                    "nx": int(cached["nx"]),
                    "ny": int(cached["ny"]),
                    "voxel": float(cached["voxel"]),
                    "map_point_count": int(cached["map_point_count"]),
                    "occupied_cell_count": int(cached["occupied_cell_count"]),
                    "cache_path": str(cache_path),
                    "cache_hit": True,
                }
        except Exception:
            pass

    x, y, z, _header = load_map_xyz(map_pcd)
    x = np.asarray(x, dtype=np.float32)
    y = np.asarray(y, dtype=np.float32)
    finite = np.isfinite(x) & np.isfinite(y) & np.isfinite(z)
    x = x[finite]
    y = y[finite]
    min_x = math.floor(float(np.min(x)) / voxel - 2.0) * voxel
    min_y = math.floor(float(np.min(y)) / voxel - 2.0) * voxel
    max_x = math.ceil(float(np.max(x)) / voxel + 2.0) * voxel
    max_y = math.ceil(float(np.max(y)) / voxel + 2.0) * voxel
    nx = int(math.ceil((max_x - min_x) / voxel)) + 1
    ny = int(math.ceil((max_y - min_y) / voxel)) + 1
    if nx <= 0 or ny <= 0 or nx * ny > 80_000_000:
        raise RuntimeError(f"occupancy grid too large: {nx}x{ny}")
    ix = np.floor((x - min_x) / voxel).astype(np.int64)
    iy = np.floor((y - min_y) / voxel).astype(np.int64)
    valid = (ix >= 0) & (ix < nx) & (iy >= 0) & (iy < ny)
    keys = ix[valid] * ny + iy[valid]
    occupancy = np.zeros(nx * ny, dtype=np.bool_)
    occupancy[keys] = True
    occupied_cell_count = int(np.count_nonzero(occupancy))
    np.savez(
        cache_path,
        occupancy=occupancy,
        min_x=np.array(min_x),
        min_y=np.array(min_y),
        nx=np.array(nx),
        ny=np.array(ny),
        voxel=np.array(float(voxel)),
        map_size_bytes=np.array(map_stat.st_size),
        map_point_count=np.array(int(finite.sum())),
        occupied_cell_count=np.array(occupied_cell_count),
    )
    return {
        "occupancy": occupancy,
        "min_x": min_x,
        "min_y": min_y,
        "nx": nx,
        "ny": ny,
        "voxel": float(voxel),
        "map_point_count": int(finite.sum()),
        "occupied_cell_count": occupied_cell_count,
        "cache_path": str(cache_path),
        "cache_hit": False,
    }


def normalize_angle(angle):
    while angle > math.pi:
        angle -= 2.0 * math.pi
    while angle < -math.pi:
        angle += 2.0 * math.pi
    return angle


def score_candidate(occ, local_xy, x, y, yaw):
    c = math.cos(yaw)
    s = math.sin(yaw)
    gx = x + local_xy[:, 0] * c - local_xy[:, 1] * s
    gy = y + local_xy[:, 0] * s + local_xy[:, 1] * c
    ix = np.floor((gx - occ["min_x"]) / occ["voxel"]).astype(np.int64)
    iy = np.floor((gy - occ["min_y"]) / occ["voxel"]).astype(np.int64)
    valid = (ix >= 0) & (ix < occ["nx"]) & (iy >= 0) & (iy < occ["ny"])
    valid_count = int(np.count_nonzero(valid))
    if valid_count <= 0:
        return 0.0, 0, 0.0
    keys = ix[valid] * occ["ny"] + iy[valid]
    hits = int(np.count_nonzero(occ["occupancy"][keys]))
    coverage = valid_count / float(local_xy.shape[0])
    return (hits / float(valid_count)) * coverage, hits, coverage


def search_pose(occ, query_points, prior_pose, args):
    local = query_points[:, :2]
    ranges = np.linalg.norm(local, axis=1)
    keep = np.isfinite(local).all(axis=1) & (ranges >= args.min_query_range_m) & (ranges <= args.max_query_range_m)
    local = local[keep]
    if local.shape[0] > args.max_query_points:
        stride = int(math.ceil(local.shape[0] / float(args.max_query_points)))
        local = local[::stride]
    if local.shape[0] < 50:
        raise RuntimeError(f"too few query points after filtering: {local.shape[0]}")

    center_x = float(prior_pose["x"])
    center_y = float(prior_pose["y"])
    center_yaw = float(prior_pose.get("yaw", prior_pose.get("heading")))
    stages = [
        (args.coarse_radius_m, args.coarse_xy_step_m, args.coarse_yaw_range_deg, args.coarse_yaw_step_deg),
        (args.fine_radius_m, args.fine_xy_step_m, args.fine_yaw_range_deg, args.fine_yaw_step_deg),
    ]
    best = None
    all_candidates = []
    for stage_index, (radius, xy_step, yaw_range_deg, yaw_step_deg) in enumerate(stages):
        xs = np.arange(center_x - radius, center_x + radius + 1e-6, xy_step)
        ys = np.arange(center_y - radius, center_y + radius + 1e-6, xy_step)
        yaw_offsets = np.deg2rad(np.arange(-yaw_range_deg, yaw_range_deg + 1e-6, yaw_step_deg))
        stage_best = []
        for yaw_offset in yaw_offsets:
            yaw = normalize_angle(center_yaw + float(yaw_offset))
            for x in xs:
                for y in ys:
                    score, hits, coverage = score_candidate(occ, local, float(x), float(y), yaw)
                    item = {
                        "x": float(x),
                        "y": float(y),
                        "z": float(prior_pose.get("z") or 0.0),
                        "yaw": yaw,
                        "heading": yaw,
                        "score": float(score),
                        "hits": hits,
                        "coverage": float(coverage),
                        "stage": stage_index,
                    }
                    stage_best.append(item)
        stage_best.sort(key=lambda item: item["score"], reverse=True)
        all_candidates.extend(stage_best[: args.return_topk])
        best = stage_best[0]
        center_x, center_y, center_yaw = best["x"], best["y"], best["yaw"]
    all_candidates.sort(key=lambda item: item["score"], reverse=True)
    return best, all_candidates[: args.return_topk], int(local.shape[0])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--vehicle-id", required=True)
    parser.add_argument("--map-pcd", required=True)
    parser.add_argument("--capture-json", required=True)
    parser.add_argument("--checkpoint", default="")
    parser.add_argument("--voxel-m", type=float, default=0.5)
    parser.add_argument("--max-query-points", type=int, default=4000)
    parser.add_argument("--min-query-range-m", type=float, default=1.0)
    parser.add_argument("--max-query-range-m", type=float, default=90.0)
    parser.add_argument("--coarse-radius-m", type=float, default=15.0)
    parser.add_argument("--coarse-xy-step-m", type=float, default=2.0)
    parser.add_argument("--coarse-yaw-range-deg", type=float, default=25.0)
    parser.add_argument("--coarse-yaw-step-deg", type=float, default=5.0)
    parser.add_argument("--fine-radius-m", type=float, default=2.0)
    parser.add_argument("--fine-xy-step-m", type=float, default=0.5)
    parser.add_argument("--fine-yaw-range-deg", type=float, default=4.0)
    parser.add_argument("--fine-yaw-step-deg", type=float, default=1.0)
    parser.add_argument("--return-topk", type=int, default=5)
    args = parser.parse_args()

    started = time.time()
    capture_payload, capture_result, query_points, pose = read_capture(args.capture_json)
    if not pose or pose.get("x") is None or pose.get("y") is None or (pose.get("yaw") is None and pose.get("heading") is None):
        print(json.dumps({
            "ok": False,
            "phase": "global_search_requires_index",
            "detail": "当前 capture 没有可用先验位姿；全局 BEVPlace++ descriptor 服务接入前不伪造粗位姿。",
        }, ensure_ascii=False))
        return

    occ = build_or_load_occupancy(args.map_pcd, args.voxel_m)
    best, candidates, used_query_points = search_pose(occ, query_points, pose, args)
    elapsed_ms = round((time.time() - started) * 1000.0, 1)
    output = {
        "ok": True,
        "phase": "coarse_pose_ready",
        "method": "server_bev_prior_refine",
        "vehicle_id": args.vehicle_id,
        "coarse_pose": {
            "x": best["x"],
            "y": best["y"],
            "z": best["z"],
            "yaw": best["yaw"],
            "heading": best["heading"],
        },
        "confidence": best["score"],
        "score": best["score"],
        "candidates": candidates,
        "prior_pose": pose,
        "capture_id": capture_result.get("capture_id"),
        "query_point_count": int(query_points.shape[0]),
        "used_query_point_count": used_query_points,
        "map": {
            "path": args.map_pcd,
            "voxel_m": args.voxel_m,
            "map_point_count": occ["map_point_count"],
            "occupied_cell_count": occ["occupied_cell_count"],
            "cache_path": occ["cache_path"],
            "cache_hit": occ["cache_hit"],
        },
        "model": {
            "checkpoint": args.checkpoint,
            "note": "BEVPlace++ checkpoint is tracked by the service contract; this fallback uses BEV occupancy correlation until descriptor inference is deployed.",
        },
        "elapsed_ms": elapsed_ms,
    }
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
