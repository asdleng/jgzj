#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import shutil
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageOps

IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp', '.bmp'}
SPLITS = ('train', 'val', 'test')


def now_id() -> str:
    return time.strftime('%Y%m%d_%H%M%S')


def now_iso() -> str:
    return time.strftime('%Y-%m-%dT%H:%M:%S%z')


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Deduplicate finetune_pet and keep review summary consistent.')
    parser.add_argument('--dataset-dir', type=Path, default=Path('/home/admin1/jgzj/.runtime/yolo_loop/datasets/finetune_pet'))
    parser.add_argument('--phash-threshold', type=int, default=8)
    parser.add_argument('--dhash-threshold', type=int, default=12)
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--apply', action='store_true')
    return parser.parse_args()


def require_mode(args: argparse.Namespace) -> None:
    if args.dry_run == args.apply:
        raise SystemExit('Choose exactly one of --dry-run or --apply.')


def read_json(path: Path) -> dict[str, Any]:
    with path.open('r', encoding='utf-8') as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise RuntimeError(f'json_object_required:{path}')
    return value


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f'.{path.name}.{os.getpid()}.{int(time.time())}.tmp')
    with tmp.open('w', encoding='utf-8') as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
    os.replace(tmp, path)


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows = []
    with path.open('r', encoding='utf-8') as handle:
        for line_no, raw in enumerate(handle, 1):
            text = raw.strip()
            if not text:
                continue
            row = json.loads(text)
            row['_line_no'] = line_no
            rows.append(row)
    return rows


def write_jsonl_atomic(path: Path, rows: list[dict[str, Any]]) -> None:
    tmp = path.with_name(f'.{path.name}.{os.getpid()}.{int(time.time())}.tmp')
    with tmp.open('w', encoding='utf-8') as handle:
        for row in rows:
            public = {k: v for k, v in row.items() if not k.startswith('_')}
            handle.write(json.dumps(public, ensure_ascii=False, separators=(',', ':')) + '\n')
    os.replace(tmp, path)


def rel_path(dataset_dir: Path, path: Path) -> str:
    return path.resolve().relative_to(dataset_dir.resolve()).as_posix()


def resolve_rel(dataset_dir: Path, value: object) -> Path:
    path = Path(str(value or ''))
    if path.is_absolute():
        return path
    return (dataset_dir / path).resolve()


def image_path_for_row(dataset_dir: Path, row: dict[str, Any]) -> Path | None:
    for key in ('image', 'dataset_image'):
        value = row.get(key)
        if not value:
            continue
        path = resolve_rel(dataset_dir, value)
        if path.exists() and path.suffix.lower() in IMAGE_EXTENSIONS:
            return path
    return None


def label_path_for_row(dataset_dir: Path, row: dict[str, Any], image_path: Path) -> Path | None:
    for key in ('label', 'dataset_label'):
        value = row.get(key)
        if not value:
            continue
        path = resolve_rel(dataset_dir, value)
        if path.exists():
            return path
    rel = rel_path(dataset_dir, image_path)
    if rel.startswith('images/'):
        candidate = (dataset_dir / rel.replace('images/', 'labels/', 1)).with_suffix('.txt')
        if candidate.exists():
            return candidate
    return None


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def image_array(path: Path, size: tuple[int, int], grayscale: bool = True) -> np.ndarray:
    with Image.open(path) as image:
        image = ImageOps.exif_transpose(image)
        image = image.convert('L' if grayscale else 'RGB')
        image = image.resize(size, Image.Resampling.LANCZOS)
        return np.asarray(image)


def bits_to_int(bits: np.ndarray) -> int:
    value = 0
    for bit in bits.flatten():
        value = (value << 1) | int(bool(bit))
    return value


def dhash(path: Path) -> int:
    arr = image_array(path, (9, 8), True)
    return bits_to_int(arr[:, 1:] > arr[:, :-1])


def phash(path: Path) -> int:
    arr = image_array(path, (32, 32), True).astype(np.float32)
    # Lightweight 2D DCT via FFT-free cosine matrix; avoids cv2 dependency.
    n = arr.shape[0]
    x = np.arange(n)
    c = np.cos(((2 * x[:, None] + 1) * x[None, :] * np.pi) / (2 * n))
    dct = c.T @ arr @ c
    block = dct[1:9, 1:9]
    med = np.median(block)
    return bits_to_int(block > med)


def hamming(left: int, right: int) -> int:
    return bin(int(left ^ right)).count("1")


def build_records(dataset_dir: Path, rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    records = []
    errors = []
    for index, row in enumerate(rows):
        try:
            image_path = image_path_for_row(dataset_dir, row)
            if not image_path:
                raise RuntimeError('image_missing')
            label_path = label_path_for_row(dataset_dir, row, image_path)
            if not label_path:
                raise RuntimeError('label_missing')
            records.append({
                'index': index,
                'row': row,
                'image_path': image_path,
                'label_path': label_path,
                'image_rel': rel_path(dataset_dir, image_path),
                'label_rel': rel_path(dataset_dir, label_path),
                'sha256': file_sha256(image_path),
                'phash': phash(image_path),
                'dhash': dhash(image_path),
            })
        except Exception as exc:
            errors.append({'index': index, 'image': row.get('image'), 'error': f'{type(exc).__name__}: {exc}'})
    return records, errors


def label_box_count(label_path: Path) -> int:
    count = 0
    with label_path.open('r', encoding='utf-8', errors='ignore') as handle:
        for line in handle:
            parts = line.strip().split()
            if len(parts) >= 5 and parts[0] == '0':
                count += 1
    return count


def choose_keeper(group: list[dict[str, Any]]) -> dict[str, Any]:
    return sorted(group, key=lambda item: (-label_box_count(item['label_path']), item['image_rel']))[0]


def duplicate_groups(records: list[dict[str, Any]], phash_threshold: int, dhash_threshold: int) -> list[dict[str, Any]]:
    parent = list(range(len(records)))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    by_sha = defaultdict(list)
    for idx, record in enumerate(records):
        by_sha[record['sha256']].append(idx)
    for indices in by_sha.values():
        first = indices[0]
        for idx in indices[1:]:
            union(first, idx)

    for i, left in enumerate(records):
        for j in range(i + 1, len(records)):
            right = records[j]
            if hamming(left['phash'], right['phash']) <= phash_threshold and hamming(left['dhash'], right['dhash']) <= dhash_threshold:
                union(i, j)

    groups = defaultdict(list)
    for idx, record in enumerate(records):
        groups[find(idx)].append(record)

    out = []
    for items in groups.values():
        if len(items) <= 1:
            continue
        keeper = choose_keeper(items)
        duplicates = [item for item in items if item is not keeper]
        out.append({'keeper': keeper, 'duplicates': sorted(duplicates, key=lambda item: item['image_rel'])})
    return sorted(out, key=lambda group: group['keeper']['image_rel'])


def move_to_quarantine(dataset_dir: Path, quarantine_dir: Path, path: Path) -> str:
    rel = rel_path(dataset_dir, path)
    dst = quarantine_dir / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        dst = dst.with_name(f'{dst.stem}.{int(time.time())}{dst.suffix}')
    shutil.move(str(path), str(dst))
    return dst.as_posix()


def rewrite_split_lists(dataset_dir: Path, rows: list[dict[str, Any]]) -> None:
    for split in SPLITS:
        values = [str(row.get('image') or '') for row in rows if row.get('split') == split and row.get('image')]
        (dataset_dir / f'{split}.txt').write_text('\n'.join(values) + ('\n' if values else ''), encoding='utf-8')


def update_summary(dataset_dir: Path, summary_path: Path, rows: list[dict[str, Any]], report_rel: str, args: argparse.Namespace) -> dict[str, Any]:
    summary = read_json(summary_path)
    images = Counter()
    boxes = Counter()
    pet_images = 0
    pet_boxes = 0
    link_counts = Counter(summary.get('link_counts') or {})
    for row in rows:
        split = str(row.get('split') or 'train')
        image_path = image_path_for_row(dataset_dir, row)
        if not image_path:
            continue
        label_path = label_path_for_row(dataset_dir, row, image_path)
        if not label_path:
            continue
        count = label_box_count(label_path)
        if count <= 0:
            continue
        images[split] += 1
        boxes[split] += count
        pet_images += 1
        pet_boxes += count

    now = now_iso()
    link_mode_counts = summary.get('link_counts') if isinstance(summary.get('link_counts'), dict) else {}
    if link_mode_counts:
        primary_mode = max(link_mode_counts, key=lambda key: int(link_mode_counts.get(key) or 0))
        link_mode_counts = {primary_mode: pet_images}
    summary.update({
        'updated_at': now,
        'source_type': 'finetune_dataset',
        'source_label': 'Finetune训练集',
        'classes': ['pet'],
        'images': {split: images.get(split, 0) for split in SPLITS if images.get(split, 0)},
        'positive_images': {split: images.get(split, 0) for split in SPLITS if images.get(split, 0)},
        'negative_images': {},
        'boxes': {split: boxes.get(split, 0) for split in SPLITS if boxes.get(split, 0)},
        'boxes_by_class': {'pet': pet_boxes},
        'answers': {'YES': pet_images, 'NO': 0, 'NULL': 0},
        'by_class_yes': {'pet': pet_images},
        'total_images': pet_images,
        'selected_images': pet_images,
        'link_counts': link_mode_counts,
    })
    stats = summary.setdefault('stats', {})
    if isinstance(stats, dict):
        stats.update({
            'pet_images': pet_images,
            'pet_boxes': pet_boxes,
            'no_label_images': 0,
            'dedupe_removed_images': int(args.__dict__.get('_dedupe_removed_total', 0) or 0),
        })
    summary['source_images'] = {'yolo_event_feedback_v1': dict(summary['images'])}
    summary['source_positive_images'] = {'yolo_event_feedback_v1': dict(summary['positive_images'])}
    summary['dedupe'] = {
        'schema': 'jgzj_finetune_pet_dedupe.v1',
        'method': 'sha256+phash+dhash',
        'phash_threshold': args.phash_threshold,
        'dhash_threshold': args.dhash_threshold,
        'updated_at': now,
        'report': report_rel,
    }
    write_json_atomic(summary_path, summary)
    return summary


def write_reports(report_dir: Path, run_id: str, payload: dict[str, Any], groups: list[dict[str, Any]]) -> tuple[Path, Path]:
    report_dir.mkdir(parents=True, exist_ok=True)
    json_path = report_dir / f'finetune_pet_dedupe_report_{run_id}.json'
    csv_path = report_dir / f'finetune_pet_dedupe_duplicates_{run_id}.csv'
    write_json_atomic(json_path, payload)
    with csv_path.open('w', encoding='utf-8', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=['group_id', 'action', 'image_rel', 'label_rel', 'keeper_image_rel'])
        writer.writeheader()
        for group_id, group in enumerate(groups, 1):
            keeper = group['keeper']
            writer.writerow({'group_id': group_id, 'action': 'keep', 'image_rel': keeper['image_rel'], 'label_rel': keeper['label_rel'], 'keeper_image_rel': keeper['image_rel']})
            for item in group['duplicates']:
                writer.writerow({'group_id': group_id, 'action': 'remove', 'image_rel': item['image_rel'], 'label_rel': item['label_rel'], 'keeper_image_rel': keeper['image_rel']})
    return json_path, csv_path


def main() -> int:
    args = parse_args()
    require_mode(args)
    dataset_dir = args.dataset_dir.resolve()
    manifest_path = dataset_dir / 'manifest_selected_images.jsonl'
    summary_path = dataset_dir / 'dataset_summary.json'
    run_id = now_id()
    report_dir = dataset_dir / 'dedupe_reports'
    quarantine_dir = dataset_dir / '.dedupe_quarantine' / run_id
    rows = read_jsonl(manifest_path)
    records, errors = build_records(dataset_dir, rows)
    groups = duplicate_groups(records, args.phash_threshold, args.dhash_threshold)
    remove_indices = {item['index'] for group in groups for item in group['duplicates']}
    kept_rows = [row for idx, row in enumerate(rows) if idx not in remove_indices]
    removed_rows = [row for idx, row in enumerate(rows) if idx in remove_indices]
    payload = {
        'schema': 'jgzj_finetune_pet_dedupe_report.v1',
        'run_id': run_id,
        'mode': 'apply' if args.apply else 'dry_run',
        'dataset_dir': dataset_dir.as_posix(),
        'manifest': manifest_path.as_posix(),
        'summary': summary_path.as_posix(),
        'phash_threshold': args.phash_threshold,
        'dhash_threshold': args.dhash_threshold,
        'original_total': len(rows),
        'remaining_total': len(kept_rows),
        'removed_total': len(removed_rows),
        'duplicate_group_count': len(groups),
        'duplicate_image_count': len(removed_rows),
        'error_count': len(errors),
        'errors': errors[:100],
    }
    json_report, csv_report = write_reports(report_dir, run_id, payload, groups)
    payload['report_json'] = json_report.as_posix()
    payload['report_csv'] = csv_report.as_posix()

    if args.apply:
        quarantine_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(manifest_path, quarantine_dir / 'manifest_selected_images.before_dedupe.jsonl')
        shutil.copy2(summary_path, quarantine_dir / 'dataset_summary.before_dedupe.json')
        moved = []
        for group in groups:
            for item in group['duplicates']:
                moved.append({
                    'image': item['image_rel'],
                    'image_quarantine': move_to_quarantine(dataset_dir, quarantine_dir, item['image_path']),
                    'label': item['label_rel'],
                    'label_quarantine': move_to_quarantine(dataset_dir, quarantine_dir, item['label_path']),
                })
        payload['quarantine_dir'] = quarantine_dir.as_posix()
        payload['moved'] = moved
        write_jsonl_atomic(manifest_path, kept_rows)
        rewrite_split_lists(dataset_dir, kept_rows)
        setattr(args, '_dedupe_removed_total', len(removed_rows))
        summary = update_summary(dataset_dir, summary_path, kept_rows, rel_path(dataset_dir, json_report), args)
        payload['summary_after'] = {
            'total_images': summary.get('total_images'),
            'boxes_by_class': summary.get('boxes_by_class'),
            'images': summary.get('images'),
        }

    write_json_atomic(json_report, payload)
    print(json.dumps({
        'ok': True,
        'mode': payload['mode'],
        'dataset_dir': payload['dataset_dir'],
        'original_total': payload['original_total'],
        'remaining_total': payload['remaining_total'],
        'removed_total': payload['removed_total'],
        'duplicate_group_count': payload['duplicate_group_count'],
        'duplicate_image_count': payload['duplicate_image_count'],
        'error_count': payload['error_count'],
        'report_json': payload['report_json'],
        'report_csv': payload['report_csv'],
        'quarantine_dir': payload.get('quarantine_dir', ''),
        'summary_after': payload.get('summary_after'),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
