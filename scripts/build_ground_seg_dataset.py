#!/usr/bin/env python3
import argparse
import json
import os
import random
import shutil
from pathlib import Path
from PIL import Image

GROUND_PSELECTS = {
    "平面/道路",
    "平面/人行道",
    "平面/路基",
    "平面/停车场",
    "场景其它/地面",
}


def polygon_area(points):
    area = 0.0
    for a, b in zip(points, points[1:] + points[:1]):
        area += float(a[0]) * float(b[1]) - float(b[0]) * float(a[1])
    return abs(area) / 2.0


def clean_polygon(raw_points, width, height, min_points=3, min_area=64):
    points = []
    last = None
    for item in raw_points or []:
        try:
            x = max(0.0, min(float(width), float(item.get("x"))))
            y = max(0.0, min(float(height), float(item.get("y"))))
        except Exception:
            continue
        point = (x, y)
        if last is None or abs(last[0] - x) > 0.5 or abs(last[1] - y) > 0.5:
            points.append(point)
            last = point
    if len(points) >= 2 and abs(points[0][0] - points[-1][0]) <= 0.5 and abs(points[0][1] - points[-1][1]) <= 0.5:
        points.pop()
    if len(points) < min_points:
        return None
    if polygon_area(points) < min_area:
        return None
    return points


def yolo_line(points, width, height):
    values = ["0"]
    for x, y in points:
        values.append(f"{x / max(width, 1):.6f}")
        values.append(f"{y / max(height, 1):.6f}")
    return " ".join(values)


def image_for_json(json_path):
    base = json_path.with_suffix("")
    for ext in (".jpg", ".jpeg", ".png", ".bmp"):
        candidate = base.with_suffix(ext)
        if candidate.exists():
            return candidate
    return None


def convert_one(json_path):
    try:
        data = json.loads(json_path.read_text(encoding="utf-8"))
    except Exception:
        return None
    image_path = image_for_json(json_path)
    if not image_path:
        return None
    width = int(data.get("width") or 0)
    height = int(data.get("height") or 0)
    if width <= 0 or height <= 0:
        try:
            with Image.open(image_path) as img:
                width, height = img.size
        except Exception:
            return None
    lines = []
    ground_area = 0.0
    for mark in data.get("marks") or []:
        if mark.get("type") != "polygon":
            continue
        if str(mark.get("pselect") or "") not in GROUND_PSELECTS:
            continue
        points = clean_polygon(mark.get("point"), width, height)
        if not points:
            continue
        ground_area += polygon_area(points)
        lines.append(yolo_line(points, width, height))
    if not lines:
        return None
    image_area = max(width * height, 1)
    if ground_area / image_area < 0.015:
        return None
    return image_path, lines, width, height, ground_area / image_area


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--src", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--max-images", type=int, default=6000)
    parser.add_argument("--seed", type=int, default=20260630)
    parser.add_argument("--copy", action="store_true")
    args = parser.parse_args()

    src = Path(args.src)
    out = Path(args.out)
    random.seed(args.seed)
    jsons = list(src.rglob("*.json"))
    random.shuffle(jsons)
    converted = []
    for idx, json_path in enumerate(jsons, start=1):
        item = convert_one(json_path)
        if item:
            converted.append((json_path, *item))
            if len(converted) >= args.max_images:
                break
        if idx % 1000 == 0:
            print(f"scanned={idx} converted={len(converted)}", flush=True)
    if len(converted) < 100:
        raise SystemExit(f"too_few_converted:{len(converted)}")

    splits = [("train", 0.82), ("val", 0.10), ("test", 0.08)]
    for split, _ in splits:
        (out / "images" / split).mkdir(parents=True, exist_ok=True)
        (out / "labels" / split).mkdir(parents=True, exist_ok=True)

    manifest = []
    counts = {"train": 0, "val": 0, "test": 0}
    for i, (json_path, image_path, lines, width, height, area_ratio) in enumerate(converted):
        frac = i / max(len(converted), 1)
        split = "train" if frac < splits[0][1] else "val" if frac < splits[0][1] + splits[1][1] else "test"
        stem = f"ground_{i:06d}_{image_path.stem}"
        out_img = out / "images" / split / f"{stem}{image_path.suffix.lower()}"
        out_lbl = out / "labels" / split / f"{stem}.txt"
        if args.copy:
            shutil.copy2(image_path, out_img)
        else:
            if out_img.exists() or out_img.is_symlink():
                out_img.unlink()
            os.symlink(image_path, out_img)
        out_lbl.write_text("\n".join(lines) + "\n", encoding="utf-8")
        counts[split] += 1
        manifest.append({
            "split": split,
            "image": str(image_path),
            "json": str(json_path),
            "label": str(out_lbl),
            "width": width,
            "height": height,
            "polygons": len(lines),
            "ground_area_ratio": area_ratio,
        })

    (out / "data.yaml").write_text(
        "path: " + str(out) + "\n"
        "train: images/train\n"
        "val: images/val\n"
        "test: images/test\n"
        "names:\n"
        "  0: ground\n",
        encoding="utf-8",
    )
    (out / "classes.txt").write_text("ground\n", encoding="utf-8")
    summary = {
        "source": str(src),
        "dataset": str(out),
        "ground_pselects": sorted(GROUND_PSELECTS),
        "max_images": args.max_images,
        "total_images": len(converted),
        "split_counts": counts,
        "copy_images": bool(args.copy),
        "manifest": "manifest.jsonl",
    }
    (out / "dataset_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    with (out / "manifest.jsonl").open("w", encoding="utf-8") as fh:
        for row in manifest:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
