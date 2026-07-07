#!/usr/bin/env python3
import datetime as dt
import json
import os
from pathlib import Path


ROOT = Path('/home/admin1/jgzj')
RUNTIME = ROOT / '.runtime/park-pcm'
STATE_PATH = RUNTIME / 'crowd-analysis-state.json'
SAMPLES_PATH = RUNTIME / 'crowd-samples.jsonl'
BACKUPS_ROOT = ROOT / '.runtime/backups'
SCHEMA = 'park_crowd_anonymous_people_features.v3'


def now_iso():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def load_json(path, default):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except Exception:
        return default


def save_json_atomic(path, payload):
    tmp = Path(f'{path}.{os.getpid()}.tmp')
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    tmp.replace(path)


def iter_jsonl(path):
    with Path(path).open('r', encoding='utf-8', errors='ignore') as handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                yield json.loads(line)
            except Exception:
                continue


def int_count(value):
    try:
        num = float(value)
    except Exception:
        return 0
    return max(0, int(round(num)))


def clean_map(value):
    if not isinstance(value, dict):
        return {}
    out = {}
    for key, count in value.items():
        n = int_count(count)
        if n > 0:
            out[str(key)] = n
    return out


def cap_map(mapping, total, keys, fill_unknown=False):
    total = int_count(total)
    if total <= 0:
        return {}
    rows = {key: int_count(mapping.get(key)) for key in keys if int_count(mapping.get(key)) > 0}
    current = sum(rows.values())
    if current <= 0:
        return {'unknown': total} if fill_unknown and 'unknown' in keys else {}
    if current <= total:
        if fill_unknown and 'unknown' in keys and current < total:
            rows['unknown'] = rows.get('unknown', 0) + total - current
        return rows
    allocated = {}
    floors = []
    floor_sum = 0
    for key in keys:
        value = rows.get(key, 0)
        if value <= 0:
            continue
        scaled = value * total / current
        floor = int(scaled)
        floors.append((key, floor, scaled - floor, value))
        floor_sum += floor
    for index, item in enumerate(sorted(floors, key=lambda row: (-row[2], -row[3], keys.index(row[0])))):
        key, floor, _frac, _value = item
        allocated[key] = floor + (1 if index < total - floor_sum else 0)
    return {key: allocated[key] for key in keys if allocated.get(key, 0) > 0}


AGE_STAGE_KEYS = ['junior', 'youth', 'middle', 'senior', 'unknown']
GENDER_KEYS = ['male', 'female', 'unknown']
ATTR_KEYS = ['visitor', 'business', 'couple', 'family', 'staff', 'security', 'cleaner', 'delivery', 'maintenance', 'vendor', 'student', 'unknown']
ROLE_TO_ATTR = {
    'visitor': 'visitor',
    'staff': 'staff',
    'security': 'security',
    'cleaner': 'cleaner',
    'delivery': 'delivery',
    'maintenance': 'maintenance',
    'vendor': 'vendor',
    'student': 'student',
    'unknown': 'unknown',
}


def derive_age_stage(aggregate):
    direct = clean_map(aggregate.get('age_stage_groups'))
    if direct and any(key != 'unknown' for key in direct):
        return cap_map(direct, aggregate.get('people_count'), AGE_STAGE_KEYS, fill_unknown=True)
    age = clean_map(aggregate.get('age_groups'))
    derived = {
        'junior': age.get('child', 0) + age.get('teenager', 0),
        'youth': age.get('adult', 0),
        'senior': age.get('elderly', 0),
        'unknown': age.get('unknown', 0),
    }
    return cap_map(derived, aggregate.get('people_count'), AGE_STAGE_KEYS, fill_unknown=True)


def derive_attributes(aggregate):
    direct = clean_map(aggregate.get('person_attributes'))
    if direct and any(key != 'unknown' for key in direct):
        return cap_map(direct, aggregate.get('people_count'), ATTR_KEYS, fill_unknown=False)
    roles = clean_map(aggregate.get('role_types'))
    groups = clean_map(aggregate.get('group_types'))
    derived = {}
    for role, count in roles.items():
        attr = ROLE_TO_ATTR.get(role)
        if attr:
            derived[attr] = derived.get(attr, 0) + count
    derived['family'] = derived.get('family', 0) + groups.get('family_parent_child', 0)
    derived['couple'] = derived.get('couple', 0) + groups.get('pair', 0)
    derived['student'] = derived.get('student', 0) + groups.get('student_group', 0)
    return cap_map(derived, aggregate.get('people_count'), ATTR_KEYS, fill_unknown=False)


def merge_frame_metadata(existing_frames, raw_frames):
    existing_frames = existing_frames if isinstance(existing_frames, dict) else {}
    merged = {}
    metadata_keys = [
        'capture_id', 'camera_id', 'image_size_bytes', 'image_width', 'image_height', 'image_mime_type',
        'image_path', 'image_url', 'source_image_path', 'frame_index', 'row_index', 'collected_at', 'collected_at_ms',
    ]
    for frame in raw_frames if isinstance(raw_frames, list) else []:
        if not isinstance(frame, dict):
            continue
        key = frame.get('capture_id') or frame.get('camera_id') or f'frame_{len(merged) + 1}'
        current = existing_frames.get(key) or existing_frames.get(frame.get('camera_id')) or {}
        analysis = current.get('analysis') if isinstance(current.get('analysis'), dict) else {}
        if not analysis:
            analysis = {k: v for k, v in current.items() if k not in metadata_keys}
        meta = {k: frame.get(k) for k in metadata_keys if frame.get(k) is not None}
        merged[key] = {**meta, **analysis}
    for key, value in existing_frames.items():
        if key not in merged:
            merged[key] = value
    return merged


def main():
    raw_samples = {row.get('sample_id'): row for row in iter_jsonl(SAMPLES_PATH) if row.get('sample_id')}
    state = load_json(STATE_PATH, {'version': 1, 'samples': {}})
    samples = state.get('samples') if isinstance(state.get('samples'), dict) else {}

    old_entries = {}
    for backup_path in sorted(BACKUPS_ROOT.glob('*/crowd-analysis-state.json')):
        backup = load_json(backup_path, {})
        for sample_id, entry in (backup.get('samples') if isinstance(backup.get('samples'), dict) else {}).items():
            aggregate = entry.get('aggregate') if isinstance(entry, dict) else {}
            if isinstance(aggregate, dict) and aggregate.get('feature_schema') != SCHEMA:
                old_entries.setdefault(sample_id, entry)

    repaired_frames = 0
    repaired_portraits = 0
    cleared_gender_unknown = 0
    for sample_id, entry in samples.items():
        if not isinstance(entry, dict):
            continue
        raw = raw_samples.get(sample_id) or {}
        before_frames = entry.get('frames') if isinstance(entry.get('frames'), dict) else {}
        if raw.get('frames'):
            next_frames = merge_frame_metadata(before_frames, raw.get('frames'))
            if next_frames != before_frames:
                entry['frames'] = next_frames
                repaired_frames += 1
        aggregate = entry.get('aggregate') if isinstance(entry.get('aggregate'), dict) else {}
        if aggregate.get('feature_schema') == SCHEMA:
            old_aggregate = (old_entries.get(sample_id) or {}).get('aggregate') or {}
            source = old_aggregate if isinstance(old_aggregate, dict) and old_aggregate else aggregate
            next_age_stage = derive_age_stage(source)
            next_attrs = derive_attributes(source)
            changed = False
            if next_age_stage and (not clean_map(aggregate.get('age_stage_groups')) or clean_map(aggregate.get('age_stage_groups')) == {'unknown': int_count(aggregate.get('people_count'))}):
                aggregate['age_stage_groups'] = next_age_stage
                changed = True
            if next_attrs and not any(k != 'unknown' for k in clean_map(aggregate.get('person_attributes'))):
                aggregate['person_attributes'] = next_attrs
                changed = True
            gender = clean_map(aggregate.get('gender_groups'))
            if gender and set(gender) == {'unknown'}:
                aggregate['gender_groups'] = {}
                cleared_gender_unknown += 1
                changed = True
            if changed:
                aggregate['feature_schema'] = SCHEMA
                aggregate['portrait_repaired_at'] = now_iso()
                entry['aggregate'] = aggregate
                repaired_portraits += 1
        samples[sample_id] = entry

    state['samples'] = samples
    state['updated_at'] = now_iso()
    state['last_result'] = {
        **(state.get('last_result') if isinstance(state.get('last_result'), dict) else {}),
        'repair_frames_from_sample_log': repaired_frames,
        'repair_portraits_from_legacy': repaired_portraits,
        'cleared_unknown_only_gender_groups': cleared_gender_unknown,
        'repair_at': now_iso(),
    }
    save_json_atomic(STATE_PATH, state)
    print(json.dumps({
        'ok': True,
        'samples': len(samples),
        'raw_samples': len(raw_samples),
        'legacy_entries': len(old_entries),
        'repair_frames_from_sample_log': repaired_frames,
        'repair_portraits_from_legacy': repaired_portraits,
        'cleared_unknown_only_gender_groups': cleared_gender_unknown,
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
