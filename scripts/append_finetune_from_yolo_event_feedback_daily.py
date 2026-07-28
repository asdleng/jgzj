#!/usr/bin/env python3
from __future__ import annotations

import argparse
import collections
import hashlib
import json
import os
import re
import shutil
import tempfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, Iterable, Iterator, List, Optional, Sequence, Tuple


SHANGHAI_TZ = timezone(timedelta(hours=8))
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
SPLITS = ("train", "val", "test")
SOURCE_CLASSES = (
    "person",
    "vehicle",
    "nonmotor",
    "fire",
    "smoke",
    "trash",
    "pet",
    "stall",
    "phone",
    "smoking",
    "license_plate",
    "lying",
    "fighting",
    "falldown",
)


@dataclass(frozen=True)
class Profile:
    name: str
    classes: Tuple[str, ...]
    event_map: Dict[str, str]
    source_map: Dict[str, str]
    source_group_class: str = ""


def nkey(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def profile_map(items: Dict[str, str]) -> Dict[str, str]:
    return {nkey(key): value for key, value in items.items()}


TRASH_EVENTS = profile_map({
    "bottle": "bottle",
    "box": "box",
    "paper": "paper",
    "waste_paper": "paper",
    "wastepaper": "paper",
    "bag": "bag",
    "plastic_bag": "bag",
    "plasticbag": "bag",
})

PROFILES: Dict[str, Profile] = {
    "finetune_lying": Profile(
        name="finetune_lying",
        classes=("lying",),
        event_map=profile_map({
            "lying": "lying",
            "person_lying": "lying",
            "lying_person": "lying",
            "reclining_person": "lying",
        }),
        source_map=profile_map({
            "lying": "lying",
            "person_lying": "lying",
            "lying_person": "lying",
            "reclining_person": "lying",
        }),
    ),
    "finetune_license_plate": Profile(
        name="finetune_license_plate",
        classes=("license_plate",),
        event_map=profile_map({
            "license_plate": "license_plate",
            "licence_plate": "license_plate",
            "licenseplate": "license_plate",
            "number_plate": "license_plate",
            "vehicle_plate": "license_plate",
            "car_plate": "license_plate",
            "plate": "license_plate",
        }),
        source_map=profile_map({
            "license_plate": "license_plate",
            "licence_plate": "license_plate",
            "licenseplate": "license_plate",
            "number_plate": "license_plate",
            "vehicle_plate": "license_plate",
            "car_plate": "license_plate",
            "plate": "license_plate",
        }),
    ),
    "finetune_trash": Profile(
        name="finetune_trash",
        classes=("bottle", "box", "paper", "bag"),
        event_map=TRASH_EVENTS,
        source_map=profile_map({
            "bottle": "bottle",
            "box": "box",
            "paper": "paper",
            "waste_paper": "paper",
            "wastepaper": "paper",
            "bag": "bag",
            "plastic_bag": "bag",
            "plasticbag": "bag",
        }),
        source_group_class="trash",
    ),
    "finetune_smoking": Profile(
        name="finetune_smoking",
        classes=("smoking",),
        event_map=profile_map({
            "smoking": "smoking",
            "cigarette": "smoking",
        }),
        source_map=profile_map({
            "smoking": "smoking",
            "cigarette": "smoking",
        }),
    ),
    "finetune_pet": Profile(
        name="finetune_pet",
        classes=("pet",),
        event_map=profile_map({
            "pet": "pet",
            "cat": "pet",
            "dog": "pet",
            "off_leash_dog": "pet",
            "offleashdog": "pet",
        }),
        source_map=profile_map({
            "pet": "pet",
            "cat": "pet",
            "dog": "pet",
            "off_leash_dog": "pet",
            "offleashdog": "pet",
        }),
    ),
    "finetune_v2": Profile(
        name="finetune_v2",
        classes=("fire", "smoke"),
        event_map=profile_map({
            "fire": "fire",
            "smoke": "smoke",
        }),
        source_map=profile_map({
            "fire": "fire",
            "smoke": "smoke",
        }),
    ),
}


def now_iso() -> str:
    return datetime.now(SHANGHAI_TZ).isoformat(timespec="seconds")


def default_day() -> str:
    return (datetime.now(SHANGHAI_TZ) - timedelta(days=1)).strftime("%Y%m%d")


def load_json(path: Path) -> Optional[dict]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None
    return data if isinstance(data, dict) else None


def write_text_atomic(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
        os.replace(tmp_name, path)
    finally:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass


def write_json_atomic(path: Path, payload: dict) -> None:
    write_text_atomic(path, json.dumps(payload, ensure_ascii=False, indent=2) + "\n")


def iter_jsonl(path: Path) -> Iterator[dict]:
    with path.open("r", encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, 1):
            text = line.strip()
            if not text:
                continue
            try:
                row = json.loads(text)
            except Exception as exc:
                raise RuntimeError(f"invalid_jsonl:{path}:{line_no}:{exc}") from exc
            if isinstance(row, dict):
                row["_line_no"] = line_no
                yield row


def row_days(row: dict) -> List[str]:
    days = row.get("days")
    out = [str(day) for day in days if re.fullmatch(r"\d{8}", str(day or ""))] if isinstance(days, list) else []
    if out:
        return out
    image = str(row.get("image") or "")
    match = re.search(r"(20\d{6})", image)
    return [match.group(1)] if match else []


def resolve_image(source_dir: Path, row: dict) -> Path:
    value = str(row.get("image") or "").strip()
    if value:
        path = Path(value)
        if not path.is_absolute():
            path = source_dir / value
        if path.is_file():
            return path.resolve()
    source_frame = str(row.get("source_frame") or "").strip()
    if source_frame and Path(source_frame).is_file():
        return Path(source_frame).resolve()
    raise RuntimeError(f"source_image_missing:{value or source_frame}")


def source_label_txt_path(source_dir: Path, row: dict) -> Path:
    value = str(row.get("image") or "").strip()
    path = Path(value)
    if not path.is_absolute():
        path = source_dir / value
    try:
        rel = path.resolve().relative_to(source_dir.resolve())
    except ValueError:
        rel = Path(path.name)
    if rel.parts and rel.parts[0] == "images":
        return (source_dir / "labels" / Path(*rel.parts[1:])).with_suffix(".txt")
    return (source_dir / "labels" / rel).with_suffix(".txt")


def event_targets(profile: Profile, row: dict) -> List[str]:
    targets: List[str] = []
    for task in row.get("tasks") or []:
        if not isinstance(task, dict):
            continue
        target = profile.event_map.get(nkey(task.get("event_name")))
        if target and target not in targets:
            targets.append(target)
    return targets


def class_id(profile: Profile, name: str) -> int:
    return profile.classes.index(name)


def clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


def valid_yolo_box(x: float, y: float, w: float, h: float) -> Optional[Tuple[float, float, float, float]]:
    x = clamp01(x)
    y = clamp01(y)
    w = clamp01(w)
    h = clamp01(h)
    if w <= 0.0 or h <= 0.0:
        return None
    return x, y, w, h


def xyxy_to_yolo(values: Sequence[object], width: float, height: float) -> Optional[Tuple[float, float, float, float]]:
    if len(values) != 4:
        return None
    try:
        x1, y1, x2, y2 = [float(value) for value in values]
    except (TypeError, ValueError):
        return None
    if width <= 0.0 or height <= 0.0:
        return None
    if all(0.0 <= value <= 1.0 for value in (x1, y1, x2, y2)):
        nx1, ny1, nx2, ny2 = x1, y1, x2, y2
    else:
        nx1, ny1, nx2, ny2 = x1 / width, y1 / height, x2 / width, y2 / height
    nx1, nx2 = sorted((clamp01(nx1), clamp01(nx2)))
    ny1, ny2 = sorted((clamp01(ny1), clamp01(ny2)))
    if nx2 <= nx1 or ny2 <= ny1:
        return None
    return valid_yolo_box((nx1 + nx2) / 2.0, (ny1 + ny2) / 2.0, nx2 - nx1, ny2 - ny1)


def bbox1000_to_yolo(values: Sequence[object]) -> Optional[Tuple[float, float, float, float]]:
    return xyxy_to_yolo(values, 1000.0, 1000.0)


def raw_label_class(raw: dict) -> str:
    value = raw.get("class_name", raw.get("class", raw.get("label", "")))
    if not value and isinstance(raw.get("box"), dict):
        value = raw["box"].get("class_name", raw["box"].get("class", ""))
    return str(value or "")


def raw_label_box(raw: dict) -> Optional[Tuple[float, float, float, float]]:
    box = raw.get("box") if isinstance(raw.get("box"), dict) else {}
    values = (
        raw.get("x", raw.get("x_center", box.get("x_center"))),
        raw.get("y", raw.get("y_center", box.get("y_center"))),
        raw.get("w", raw.get("width", box.get("width"))),
        raw.get("h", raw.get("height", box.get("height"))),
    )
    try:
        x, y, w, h = [float(value) for value in values]
        if all(0.0 <= value <= 1.0 for value in (x, y, w, h)):
            return valid_yolo_box(x, y, w, h)
    except (TypeError, ValueError):
        pass
    for key in ("bbox_1000", "bbox1000"):
        value = raw.get(key)
        if isinstance(value, list):
            return bbox1000_to_yolo(value)
    value = box.get("bbox_1000")
    if isinstance(value, list):
        return bbox1000_to_yolo(value)
    for key in ("bbox", "box", "xyxy"):
        value = raw.get(key)
        if isinstance(value, list):
            if all(isinstance(item, (int, float)) for item in value):
                scale = 1.0 if all(0.0 <= float(item) <= 1.0 for item in value) else 1000.0
                return xyxy_to_yolo(value, scale, scale)
    return None


def normalized_payload_labels(payload: Optional[dict], label_source: str) -> List[dict]:
    if not isinstance(payload, dict):
        return []
    labels = payload.get("labels") if isinstance(payload.get("labels"), list) else []
    out: List[dict] = []
    for position, raw in enumerate(labels):
        if not isinstance(raw, dict):
            continue
        box = raw_label_box(raw)
        if box is None:
            continue
        out.append({
            "source_class": raw_label_class(raw),
            "source_index": raw.get("index", raw.get("i", position)),
            "x": box[0],
            "y": box[1],
            "w": box[2],
            "h": box[3],
            "label_source": label_source,
        })
    if label_source == "audit_label":
        missing = payload.get("missing_candidates") if isinstance(payload.get("missing_candidates"), list) else []
        for position, raw in enumerate(missing):
            if not isinstance(raw, dict):
                continue
            box = raw_label_box(raw)
            if box is None:
                continue
            out.append({
                "source_class": raw_label_class(raw),
                "source_index": f"missing_{position}",
                "x": box[0],
                "y": box[1],
                "w": box[2],
                "h": box[3],
                "label_source": "audit_missing_candidate",
            })
    return out


def audit_suspicious_indexes(audit_payload: Optional[dict]) -> set:
    if not isinstance(audit_payload, dict):
        return set()
    suspicious = audit_payload.get("suspicious_labels")
    if not isinstance(suspicious, list):
        return set()
    out = set()
    for item in suspicious:
        if not isinstance(item, dict):
            continue
        should = nkey(item.get("should"))
        issue = nkey(item.get("issue"))
        if should in {"", "none", "background", "delete", "remove"} or issue in {"wrongclass", "falsepositive"}:
            out.add(str(item.get("index")))
    return out


def source_txt_labels(label_path: Path) -> List[dict]:
    if not label_path.is_file():
        return []
    out = []
    with label_path.open("r", encoding="utf-8", errors="ignore") as handle:
        for position, line in enumerate(handle):
            parts = line.strip().split()
            if len(parts) < 5:
                continue
            try:
                source_id = int(float(parts[0]))
                x, y, w, h = [float(value) for value in parts[1:5]]
            except (TypeError, ValueError):
                continue
            if source_id < 0 or source_id >= len(SOURCE_CLASSES):
                continue
            box = valid_yolo_box(x, y, w, h)
            if box is None:
                continue
            out.append({
                "source_class": SOURCE_CLASSES[source_id],
                "source_index": position,
                "x": box[0],
                "y": box[1],
                "w": box[2],
                "h": box[3],
                "label_source": "source_label_txt",
            })
    return out


def map_source_to_target(profile: Profile, source_class: str, row_event_targets: Sequence[str]) -> Optional[str]:
    target = profile.source_map.get(nkey(source_class))
    if target:
        return target
    if profile.source_group_class and nkey(source_class) == nkey(profile.source_group_class):
        unique_targets = sorted(set(row_event_targets), key=profile.classes.index)
        if len(unique_targets) == 1:
            return unique_targets[0]
    return None


def select_profile_labels(profile: Profile, labels: Iterable[dict], row_event_targets: Sequence[str]) -> List[dict]:
    selected = []
    for label in labels:
        target = map_source_to_target(profile, str(label.get("source_class") or ""), row_event_targets)
        if not target:
            continue
        selected.append({
            "class_name": target,
            "class_id": class_id(profile, target),
            "x": label["x"],
            "y": label["y"],
            "w": label["w"],
            "h": label["h"],
            "label_source": label.get("label_source") or "source_label",
            "source_class": label.get("source_class") or "",
        })
    return selected


def positive_task(task: dict) -> bool:
    answer = str(task.get("answer") or "").upper()
    passed = task.get("pass") is True or task.get("pass") == 1 or str(task.get("pass")).lower() == "true"
    return answer == "YES" and passed


def vehicle_task_labels(profile: Profile, row: dict) -> List[dict]:
    width = float(row.get("frame_width") or 0)
    height = float(row.get("frame_height") or 0)
    out = []
    for task in row.get("tasks") or []:
        if not isinstance(task, dict) or not positive_task(task):
            continue
        target = profile.event_map.get(nkey(task.get("event_name")))
        if not target:
            continue
        box_source = "merged_box" if isinstance(task.get("merged_box"), list) else "crop_box"
        raw_box = task.get(box_source)
        if not isinstance(raw_box, list):
            continue
        box = xyxy_to_yolo(raw_box, width, height)
        if box is None:
            continue
        out.append({
            "class_name": target,
            "class_id": class_id(profile, target),
            "x": box[0],
            "y": box[1],
            "w": box[2],
            "h": box[3],
            "label_source": f"vehicle_{box_source}",
            "source_class": target,
        })
    return out


def dedupe_labels(labels: Sequence[dict]) -> List[dict]:
    seen = set()
    out = []
    for label in labels:
        key = (
            int(label["class_id"]),
            round(float(label["x"]), 6),
            round(float(label["y"]), 6),
            round(float(label["w"]), 6),
            round(float(label["h"]), 6),
        )
        if key in seen:
            continue
        seen.add(key)
        out.append(label)
    return out


def extract_labels(profile: Profile, source_dir: Path, row: dict, stats: collections.Counter) -> List[dict]:
    row_targets = event_targets(profile, row)
    audit_payload = load_json(Path(str(row.get("audit_path") or ""))) if row.get("audit_path") else None
    audit_verdict = nkey((audit_payload or {}).get("verdict"))
    if audit_payload and audit_verdict != "error":
        suspicious_indexes = audit_suspicious_indexes(audit_payload)
        labels = [
            label for label in normalized_payload_labels(audit_payload, "audit_label")
            if str(label.get("source_index")) not in suspicious_indexes
        ]
        selected = select_profile_labels(profile, labels, row_targets)
        if selected:
            stats["selected_by_audit"] += 1
            return dedupe_labels(selected)
        stats["audit_without_target_box"] += 1

    label_payload = load_json(Path(str(row.get("independent_label_path") or ""))) if row.get("independent_label_path") else None
    selected = select_profile_labels(profile, normalized_payload_labels(label_payload, "qwen_label"), row_targets)
    if selected:
        stats["selected_by_qwen_label"] += 1
        return dedupe_labels(selected)

    selected = select_profile_labels(profile, source_txt_labels(source_label_txt_path(source_dir, row)), row_targets)
    if selected:
        stats["selected_by_source_label_txt"] += 1
        return dedupe_labels(selected)

    selected = vehicle_task_labels(profile, row)
    if selected:
        stats["selected_by_vehicle_box"] += 1
        return dedupe_labels(selected)

    stats["skipped_no_target_box"] += 1
    return []


def deterministic_split(key: str) -> str:
    value = int(hashlib.sha1(key.encode("utf-8", errors="ignore")).hexdigest()[:8], 16) % 100
    if value < 80:
        return "train"
    if value < 90:
        return "val"
    return "test"


def existing_sha_keys(dataset_dir: Path) -> Tuple[set, set]:
    full = set()
    prefixes = set()
    manifest = dataset_dir / "manifest_selected_images.jsonl"
    if manifest.is_file():
        for row in iter_jsonl(manifest):
            sha = str(row.get("source_image_sha256") or row.get("image_sha256") or "").strip().lower()
            if re.fullmatch(r"[0-9a-f]{64}", sha):
                full.add(sha)
                prefixes.add(sha[:16])
    for image_dir in (dataset_dir / "images" / split for split in SPLITS):
        if not image_dir.is_dir():
            continue
        for path in image_dir.iterdir():
            if path.suffix.lower() not in IMAGE_EXTENSIONS:
                continue
            match = re.search(r"_([0-9a-f]{16})(?:\.[^.]+)?$", path.name.lower())
            if match:
                prefixes.add(match.group(1))
    return full, prefixes


def next_output_index(dataset_dir: Path) -> int:
    max_index = -1
    for image_dir in (dataset_dir / "images" / split for split in SPLITS):
        if not image_dir.is_dir():
            continue
        for path in image_dir.iterdir():
            match = re.search(r"event_feedback_(\d+)_", path.name)
            if match:
                max_index = max(max_index, int(match.group(1)))
    return max_index + 1


def label_text(labels: Sequence[dict]) -> str:
    ordered = sorted(labels, key=lambda item: (int(item["class_id"]), float(item["x"]), float(item["y"])))
    return "".join(
        f"{int(item['class_id'])} {float(item['x']):.6f} {float(item['y']):.6f} {float(item['w']):.6f} {float(item['h']):.6f}\n"
        for item in ordered
    )


def class_part(profile: Profile, labels: Sequence[dict]) -> str:
    names = []
    for label in labels:
        name = str(label.get("class_name") or profile.classes[int(label["class_id"])])
        if name not in names:
            names.append(name)
    if not names:
        return profile.name.replace("finetune_", "")
    return "_".join(names[:3])


def append_manifest(dataset_dir: Path, rows: Sequence[dict]) -> None:
    if not rows:
        return
    manifest = dataset_dir / "manifest_selected_images.jsonl"
    existing = ""
    if manifest.is_file():
        existing = manifest.read_text(encoding="utf-8")
        if existing and not existing.endswith("\n"):
            existing += "\n"
    new_text = "".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in rows)
    write_text_atomic(manifest, existing + new_text)


def refresh_split_lists(dataset_dir: Path) -> Dict[str, int]:
    counts = {}
    for split in SPLITS:
        image_dir = dataset_dir / "images" / split
        values = []
        if image_dir.is_dir():
            for path in sorted(image_dir.iterdir()):
                if path.suffix.lower() in IMAGE_EXTENSIONS:
                    values.append(f"images/{split}/{path.name}")
        write_text_atomic(dataset_dir / f"{split}.txt", "\n".join(values) + ("\n" if values else ""))
        counts[split] = len(values)
    return counts


def write_class_files(profile: Profile, dataset_dir: Path) -> None:
    write_text_atomic(dataset_dir / "classes.txt", "\n".join(profile.classes) + "\n")
    lines = [
        f"path: {dataset_dir.as_posix()}",
        "train: images/train",
        "val: images/val",
        "test: images/test",
        "names:",
    ]
    for idx, name in enumerate(profile.classes):
        lines.append(f"  {idx}: {name}")
    write_text_atomic(dataset_dir / "data.yaml", "\n".join(lines) + "\n")


def scan_dataset_counts(profile: Profile, dataset_dir: Path) -> dict:
    image_counts = collections.Counter()
    positive_counts = collections.Counter()
    negative_counts = collections.Counter()
    box_counts = collections.Counter()
    boxes_by_class = collections.Counter()
    images_by_class = collections.Counter()
    for split in SPLITS:
        image_dir = dataset_dir / "images" / split
        label_dir = dataset_dir / "labels" / split
        if not image_dir.is_dir():
            continue
        for image_path in image_dir.iterdir():
            if image_path.suffix.lower() not in IMAGE_EXTENSIONS:
                continue
            image_counts[split] += 1
            label_path = label_dir / f"{image_path.stem}.txt"
            present_classes = set()
            box_count = 0
            if label_path.is_file():
                with label_path.open("r", encoding="utf-8", errors="ignore") as handle:
                    for line in handle:
                        parts = line.strip().split()
                        if len(parts) < 5:
                            continue
                        try:
                            cid = int(float(parts[0]))
                        except (TypeError, ValueError):
                            continue
                        if cid < 0 or cid >= len(profile.classes):
                            continue
                        class_name = profile.classes[cid]
                        boxes_by_class[class_name] += 1
                        present_classes.add(class_name)
                        box_count += 1
            if box_count:
                positive_counts[split] += 1
                box_counts[split] += box_count
                images_by_class.update(present_classes)
            else:
                negative_counts[split] += 1
    return {
        "images": {split: image_counts[split] for split in SPLITS if image_counts[split]},
        "positive_images": {split: positive_counts[split] for split in SPLITS if positive_counts[split]},
        "negative_images": {split: negative_counts[split] for split in SPLITS if negative_counts[split]},
        "boxes": {split: box_counts[split] for split in SPLITS if box_counts[split]},
        "boxes_by_class": dict(boxes_by_class),
        "by_class_yes": dict(images_by_class),
        "total_images": sum(image_counts.values()),
        "selected_images": sum(positive_counts.values()),
        "answers": {
            "YES": sum(positive_counts.values()),
            "NO": sum(negative_counts.values()),
            "NULL": 0,
        },
    }


def update_summary(profile: Profile, dataset_dir: Path, source_dir: Path, day: str, ingest: dict) -> dict:
    summary_path = dataset_dir / "dataset_summary.json"
    summary = load_json(summary_path) or {}
    created_at = summary.get("created_at") or now_iso()
    counts = scan_dataset_counts(profile, dataset_dir)
    link_counts = collections.Counter(summary.get("link_counts") if isinstance(summary.get("link_counts"), dict) else {})
    if ingest.get("added_images"):
        link_counts["copy"] += int(ingest["added_images"])
    label_source_counts = collections.Counter(summary.get("label_source_counts") if isinstance(summary.get("label_source_counts"), dict) else {})
    label_source_counts.update(ingest.get("label_source_counts") or {})
    payload = dict(summary)
    payload.update({
        "schema": "jgzj_yolo_finetune_review_dataset.v1",
        "profile": profile.name,
        "display_name": profile.name,
        "kind": "detect",
        "created_at": created_at,
        "updated_at": now_iso(),
        "dataset_dir": dataset_dir.as_posix(),
        "source_type": "finetune_dataset",
        "source_label": "Finetune dataset",
        "classes": list(profile.classes),
        "training_eligible": True,
        "finetune": {
            "name": profile.name,
            "source_dataset": source_dir.as_posix(),
            "source_profile": "YOLO event original feedback candidates",
            "label_policy": "daily append previous-day rows; prefer audited Qwen boxes, then Qwen boxes, then source YOLO label txt, then vehicle uploaded task boxes; copy images",
        },
        "review": {
            "source_group": "finetune_dataset",
            "source_group_label": "Finetune dataset",
            "visible_in_yolo_label_review": True,
        },
        "images": counts["images"],
        "positive_images": counts["positive_images"],
        "negative_images": counts["negative_images"],
        "boxes": counts["boxes"],
        "boxes_by_class": counts["boxes_by_class"],
        "answers": counts["answers"],
        "by_class_yes": counts["by_class_yes"],
        "total_images": counts["total_images"],
        "selected_images": counts["selected_images"],
        "link_counts": dict(link_counts),
        "label_source_counts": dict(label_source_counts),
        "daily_ingest_last": ingest,
    })
    history = payload.get("daily_ingest_history")
    if not isinstance(history, list):
        history = []
    history = [item for item in history if not (isinstance(item, dict) and item.get("day") == day)]
    history.append(ingest)
    payload["daily_ingest_history"] = history[-60:]
    write_json_atomic(summary_path, payload)
    return payload


def collect_candidates(profile: Profile, source_dir: Path, target_day: str, dataset_dir: Path, stats: collections.Counter) -> Dict[str, dict]:
    full_existing, prefix_existing = existing_sha_keys(dataset_dir)
    groups: Dict[str, dict] = {}
    manifest = source_dir / "manifest_selected_images.jsonl"
    for row in iter_jsonl(manifest):
        stats["manifest_rows"] += 1
        if target_day not in row_days(row):
            continue
        stats["day_rows"] += 1
        try:
            image_path = resolve_image(source_dir, row)
        except Exception:
            stats["skipped_missing_image"] += 1
            continue
        sha = str(row.get("image_sha256") or "").strip().lower()
        if not re.fullmatch(r"[0-9a-f]{64}", sha):
            sha = hashlib.sha256(image_path.read_bytes()).hexdigest()
        if sha in full_existing or sha[:16] in prefix_existing:
            stats["skipped_existing"] += 1
            continue
        labels = extract_labels(profile, source_dir, row, stats)
        if not labels:
            continue
        group = groups.setdefault(sha, {
            "sha": sha,
            "image_path": image_path,
            "rows": [],
            "labels": [],
            "label_sources": collections.Counter(),
        })
        group["rows"].append(row)
        group["labels"].extend(labels)
        group["label_sources"].update(label["label_source"] for label in labels)
    for group in groups.values():
        group["labels"] = dedupe_labels(group["labels"])
        group["label_sources"] = collections.Counter(label["label_source"] for label in group["labels"])
    return groups


def append_rows(profile: Profile, source_dir: Path, dataset_dir: Path, day: str, groups: Dict[str, dict], dry_run: bool) -> dict:
    if not dry_run:
        write_class_files(profile, dataset_dir)
    start_index = next_output_index(dataset_dir)
    manifest_rows = []
    split_counts = collections.Counter()
    box_counts = collections.Counter()
    label_source_counts = collections.Counter()
    added = 0
    for offset, group in enumerate(sorted(groups.values(), key=lambda item: item["sha"])):
        labels = group["labels"]
        if not labels:
            continue
        sha = group["sha"]
        split = deterministic_split(sha)
        image_path: Path = group["image_path"]
        stem = f"event_feedback_{start_index + offset:06d}_{class_part(profile, labels)}_{sha[:16]}"
        image_rel = f"images/{split}/{stem}{image_path.suffix.lower() or '.jpg'}"
        label_rel = f"labels/{split}/{stem}.txt"
        if not dry_run:
            image_dst = dataset_dir / image_rel
            label_dst = dataset_dir / label_rel
            image_dst.parent.mkdir(parents=True, exist_ok=True)
            label_dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(image_path, image_dst)
            write_text_atomic(label_dst, label_text(labels))
        rows = group["rows"]
        first = rows[0]
        row_label_sources = collections.Counter(label["label_source"] for label in labels)
        label_source_counts.update(row_label_sources)
        present_classes = sorted({label["class_name"] for label in labels}, key=profile.classes.index)
        manifest_rows.append({
            "schema": f"jgzj_{profile.name}_manifest.v2",
            "image": image_rel,
            "label": label_rel,
            "split": split,
            "source": "yolo_event_feedback_v1",
            "source_dataset": source_dir.as_posix(),
            "source_image": str(image_path),
            "source_label": str(source_label_txt_path(source_dir, first)),
            "source_manifest_lines": [row.get("_line_no") for row in rows],
            "source_image_sha256": sha,
            "source_feedback_statuses": sorted({str(row.get("feedback_status") or "") for row in rows}),
            "source_feedback_reasons": sorted({str(row.get("feedback_reason") or "") for row in rows}),
            "source_expected_classes": sorted({value for row in rows for value in (row.get("expected_classes") or [])}),
            "source_independent_classes": sorted({value for row in rows for value in (row.get("independent_classes") or [])}),
            "source_tasks": [task for row in rows for task in (row.get("tasks") or [])],
            "source_days": sorted({value for row in rows for value in row_days(row)}),
            "box_count": len(labels),
            "label_count": len(labels),
            "classes": present_classes,
            "label_classes": present_classes,
            "label_source": "+".join(sorted(row_label_sources)),
            "label_source_counts": dict(row_label_sources),
            "is_positive": True,
            "training_eligible": True,
        })
        split_counts[split] += 1
        box_counts[split] += len(labels)
        added += 1
    if not dry_run:
        append_manifest(dataset_dir, manifest_rows)
        refresh_split_lists(dataset_dir)
    return {
        "added_images": added,
        "added_boxes": sum(box_counts.values()),
        "images": dict(split_counts),
        "boxes": dict(box_counts),
        "label_source_counts": dict(label_source_counts),
        "manifest_rows": len(manifest_rows),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Append previous-day YOLO event feedback samples into a finetune dataset.")
    parser.add_argument("--dataset", choices=sorted(PROFILES), required=True)
    parser.add_argument("--source", type=Path, default=Path("/home/admin1/jgzj/.runtime/yolo_loop/datasets/yolo_event_feedback_v1"))
    parser.add_argument("--datasets-root", type=Path, default=Path("/home/admin1/jgzj/.runtime/yolo_loop/datasets"))
    parser.add_argument("--day", default=default_day(), help="Shanghai calendar day in YYYYMMDD; defaults to yesterday.")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    profile = PROFILES[args.dataset]
    source_dir = args.source.resolve()
    dataset_dir = (args.datasets_root / profile.name).resolve()
    if not (source_dir / "manifest_selected_images.jsonl").is_file():
        raise SystemExit(f"source_manifest_missing:{source_dir / 'manifest_selected_images.jsonl'}")
    if not re.fullmatch(r"\d{8}", args.day):
        raise SystemExit(f"invalid_day:{args.day}")
    dataset_dir.mkdir(parents=True, exist_ok=True)

    stats: collections.Counter = collections.Counter()
    groups = collect_candidates(profile, source_dir, args.day, dataset_dir, stats)
    append_result = append_rows(profile, source_dir, dataset_dir, args.day, groups, bool(args.dry_run))
    ingest = {
        "schema": "jgzj_yolo_event_feedback_finetune_daily_ingest.v1",
        "profile": profile.name,
        "day": args.day,
        "created_at": now_iso(),
        "source_dataset": source_dir.as_posix(),
        "dataset_dir": dataset_dir.as_posix(),
        "dry_run": bool(args.dry_run),
        **append_result,
        "scan": dict(stats),
    }
    report_dir = Path("/home/admin1/jgzj/.runtime/yolo_event_feedback_finetune_daily/reports")
    if not args.dry_run:
        update_summary(profile, dataset_dir, source_dir, args.day, ingest)
        write_json_atomic(report_dir / f"{profile.name}_{args.day}.json", ingest)
    print(json.dumps({"ok": True, **ingest}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
