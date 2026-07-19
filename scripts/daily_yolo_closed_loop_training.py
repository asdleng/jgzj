#!/usr/bin/env python3
from __future__ import annotations

import argparse
import collections
import json
import os
import re
import shlex
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from yolo_closed_loop_policy import (
    DEFAULT_QUALITIES,
    EXPECTED_AUDIT_PROMPT_VERSION,
    PATROL_DATASET_ID,
    class_name,
    effective_labels,
    load_manual_annotations,
    training_row_decision,
)


CN_TZ = timezone(timedelta(hours=8))
PROJECT_ROOT = Path(os.environ.get("JGZJ_PROJECT_ROOT", "/home/admin1/jgzj"))
RUNTIME_ROOT = PROJECT_ROOT / ".runtime" / "yolo_daily_closed_loop"
INDEX_PATH = PROJECT_ROOT / ".runtime" / "yolo_label_review" / "patrol_dataset_index.json"
FRAMES_ROOT = PROJECT_ROOT / ".runtime" / "park-pcm" / "crowd-frames"
LABEL_ROOT = PROJECT_ROOT / ".runtime" / "yolo_label_review"
MANUAL_ANNOTATION_ROOT = LABEL_ROOT / "manual_annotations_v1"
LEGACY_SCRIPT_ROOT = PROJECT_ROOT / ".runtime" / "reliable_vehicle_yolo_20260704"
BUILD_SCRIPT = PROJECT_ROOT / "scripts" / "build_reliable_vehicle_upload_yolo.py"
TRAIN_SCRIPT = LEGACY_SCRIPT_ROOT / "train_reliable_yolo_finetune.py"
POLICY_SCRIPT = PROJECT_ROOT / "scripts" / "yolo_closed_loop_policy.py"
STATE_PATH = RUNTIME_ROOT / "state.json"

A100_HOST = os.environ.get("YOLO_A100_HOST", "192.168.80.49")
A100_USER = os.environ.get("YOLO_A100_USER", "sari")
A100_KEY = os.environ.get("YOLO_A100_KEY", "/home/admin1/a100_tunnel/jgzj_qwen36_proxy_ed25519")
A100_ROOT = os.environ.get("YOLO_DAILY_A100_ROOT", "/home/sari/jgzj_yolo_daily_closed_loop")
A100_PY = os.environ.get("YOLO_DAILY_A100_PY", "/home/sari/autodistill/bin/python")
A100_GPU = int(os.environ.get("YOLO_DAILY_A100_GPU", "3"))

GOOD_QUALITIES = DEFAULT_QUALITIES
ALLOW_QWEN_AUDIT_PASS = str(
    os.environ.get("YOLO_DAILY_ALLOW_QWEN_AUDIT_PASS", "1")
).strip().lower() not in {"0", "false", "no", "off"}

TASKS = [
    {
        "task_id": "person_yolo",
        "build_task": "person",
        "classes": {"person"},
        "min_boxes": 300,
        "min_positive_images": 300,
        "empty_to_positive_ratio": 2.0,
        "epochs": 8,
        "patience": 4,
        "batch": 64,
        "imgsz": 640,
        "base_weight": "/home/sari/ai_detection_dino_yolo_eval_20260703/weights/person_yolo_best.pt",
    },
    {
        "task_id": "vehicle_yolo",
        "build_task": "vehicle",
        "classes": {"vehicle", "nonmotor"},
        "min_boxes": 350,
        "min_positive_images": 300,
        "empty_to_positive_ratio": 1.5,
        "epochs": 8,
        "patience": 4,
        "batch": 64,
        "imgsz": 640,
        "base_weight": "/home/sari/ai_detection_dino_yolo_eval_20260703/weights/vehicle_yolo_best.pt",
    },
    {
        "task_id": "pet_yolo",
        "build_task": "pet",
        "classes": {"pet"},
        "min_boxes": 80,
        "min_positive_images": 60,
        "empty_to_positive_ratio": 2.0,
        "epochs": 8,
        "patience": 4,
        "batch": 64,
        "imgsz": 640,
        "base_weight": "/home/sari/ai_detection_dino_yolo_eval_20260703/weights/pet_yolo_best.pt",
    },
]


def selected_tasks(task_filter: str) -> list[dict]:
    tokens = {item.strip() for item in str(task_filter or "").split(",") if item.strip()}
    if not tokens:
        return TASKS
    matched = [
        task for task in TASKS
        if task["task_id"] in tokens or task["build_task"] in tokens
    ]
    matched_tokens = {
        token for token in tokens
        if any(task["task_id"] == token or task["build_task"] == token for task in matched)
    }
    missing = sorted(tokens - matched_tokens)
    if missing:
        raise SystemExit(f"unknown_tasks:{','.join(missing)}")
    return matched


def run(cmd: list[str], *, timeout: int = 600, check: bool = False) -> subprocess.CompletedProcess:
    result = subprocess.run(cmd, text=True, capture_output=True, timeout=timeout)
    if check and result.returncode != 0:
        raise RuntimeError(f"command_failed rc={result.returncode} cmd={shlex.join(cmd)} stderr={result.stderr.strip()} stdout={result.stdout.strip()}")
    return result


def a100(command: str, *, timeout: int = 120, check: bool = False) -> subprocess.CompletedProcess:
    return run([
        "ssh",
        "-i", A100_KEY,
        "-o", "ClearAllForwardings=yes",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=12",
        "-o", "StrictHostKeyChecking=no",
        f"{A100_USER}@{A100_HOST}",
        command,
    ], timeout=timeout, check=check)


def rsync_to_a100(local_path: Path, remote_path: str, *, timeout: int = 1800) -> None:
    local = str(local_path)
    if local_path.is_dir():
        local = local.rstrip("/") + "/"
        remote_path = remote_path.rstrip("/") + "/"
    cmd = [
        "rsync",
        "-a",
        "-e",
        f"ssh -i {shlex.quote(A100_KEY)} -o ClearAllForwardings=yes -o BatchMode=yes -o ConnectTimeout=12 -o StrictHostKeyChecking=no",
        local,
        f"{A100_USER}@{A100_HOST}:{remote_path}",
    ]
    run(cmd, timeout=timeout, check=True)


def cn_now() -> datetime:
    return datetime.now(CN_TZ)


def compact_day(day: datetime) -> str:
    return day.strftime("%Y%m%d")


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def row_day(row: dict) -> str:
    rel = str(row.get("image_rel_path") or "")
    if "/" in rel:
        day = rel.split("/", 1)[0]
        if len(day) == 8 and day.isdigit():
            return day
    text = str((row.get("meta") or {}).get("collected_at") or "")
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return parsed.astimezone(CN_TZ).strftime("%Y%m%d")
    except Exception:
        return ""


def summarize_index(allowed_days: set[str] | None, tasks: list[dict] | None = None) -> dict:
    tasks = tasks or TASKS
    data = load_json(INDEX_PATH, {})
    rows = data.get("rows") or []
    manual_annotations = load_manual_annotations(MANUAL_ANNOTATION_ROOT)
    by_day = collections.defaultdict(lambda: {
        "eligible_images": 0,
        "boxes_by_class": collections.Counter(),
        "boxes_by_task": collections.Counter(),
        "positive_images_by_task": collections.Counter(),
        "negative_images_by_task": collections.Counter(),
        "review_sources": collections.Counter(),
        "rejected_by_reason": collections.Counter(),
    })
    for row in rows:
        day = row_day(row)
        if not day or (allowed_days is not None and day not in allowed_days):
            continue
        stat = by_day[day]
        eligible, reason, manual = training_row_decision(
            row,
            manual_annotations,
            qualities=GOOD_QUALITIES,
            allow_qwen_audit_pass=ALLOW_QWEN_AUDIT_PASS,
        )
        if not eligible:
            stat["rejected_by_reason"][reason] += 1
            continue
        stat["eligible_images"] += 1
        stat["review_sources"][reason] += 1
        labels = effective_labels(row, manual)
        names = {class_name(label) for label in labels}
        for label in labels:
            name = class_name(label)
            if not name:
                continue
            stat["boxes_by_class"][name] += 1
            for task in tasks:
                if name in task["classes"]:
                    stat["boxes_by_task"][task["task_id"]] += 1
        for task in tasks:
            task_id = task["task_id"]
            if names & task["classes"]:
                stat["positive_images_by_task"][task_id] += 1
            else:
                stat["negative_images_by_task"][task_id] += 1
    out = {}
    for day, stat in by_day.items():
        out[day] = {
            "eligible_images": stat["eligible_images"],
            "boxes_by_class": dict(stat["boxes_by_class"]),
            "boxes_by_task": dict(stat["boxes_by_task"]),
            "positive_images_by_task": dict(stat["positive_images_by_task"]),
            "negative_images_by_task": dict(stat["negative_images_by_task"]),
            "review_sources": dict(stat["review_sources"]),
            "rejected_by_reason": dict(stat["rejected_by_reason"]),
        }
    return out


def day_range(start_day: str, lookback_days: int, train_today_after_hour: int) -> list[str]:
    now = cn_now()
    today = compact_day(now)
    earliest = compact_day(now - timedelta(days=max(0, lookback_days - 1)))
    start = max(start_day, earliest)
    days = []
    for offset in range(lookback_days):
        day = compact_day(now - timedelta(days=lookback_days - 1 - offset))
        if day < start:
            continue
        if day == today and now.hour < train_today_after_hour:
            continue
        days.append(day)
    return days


def recent_day_range(lookback_days: int, train_today_after_hour: int) -> list[str]:
    return day_range("00000000", lookback_days, train_today_after_hour)


def all_candidate_days(day_stats: dict, start_day: str, train_today_after_hour: int) -> list[str]:
    now = cn_now()
    today = compact_day(now)
    return [
        day for day in sorted(day_stats)
        if day >= start_day and (day != today or now.hour >= train_today_after_hour)
    ]


def task_date_state(state: dict, task_id: str, day: str) -> str:
    return str(((state.get("task_dates") or {}).get(task_id) or {}).get(day, {}).get("status") or "")


def choose_tasks(
    day_stats: dict,
    candidate_days: list[str],
    state: dict,
    max_tasks: int,
    max_dates_per_task: int,
    tasks: list[dict] | None = None,
    *,
    aggregate_all_dates: bool = False,
) -> tuple[list[dict], list[dict]]:
    tasks = tasks or TASKS
    selected = []
    skipped = []
    all_days = sorted(candidate_days)
    for task in tasks:
        task_id = task["task_id"]
        pending = [day for day in all_days if task_date_state(state, task_id, day) not in {"scheduled", "completed"}]
        if not pending:
            skipped.append({"task_id": task_id, "reason": "no_pending_day"})
            continue
        enough_single = []
        for day in pending:
            stat = day_stats.get(day) or {}
            boxes = int((stat.get("boxes_by_task") or {}).get(task_id) or 0)
            positive_images = int((stat.get("positive_images_by_task") or {}).get(task_id) or 0)
            if boxes >= task["min_boxes"] and positive_images >= task["min_positive_images"]:
                enough_single.append(day)
        if aggregate_all_dates:
            dates = all_days
            target_dates = pending
        elif enough_single:
            dates = [enough_single[0]]
            target_dates = dates
        else:
            dates = pending[-max_dates_per_task:]
            target_dates = dates
        eligible_images = sum(int((day_stats.get(day) or {}).get("eligible_images") or 0) for day in dates)
        positive_images = sum(int(((day_stats.get(day) or {}).get("positive_images_by_task") or {}).get(task_id) or 0) for day in dates)
        negative_images = sum(int(((day_stats.get(day) or {}).get("negative_images_by_task") or {}).get(task_id) or 0) for day in dates)
        boxes = sum(int(((day_stats.get(day) or {}).get("boxes_by_task") or {}).get(task_id) or 0) for day in dates)
        if boxes < task["min_boxes"] or positive_images < task["min_positive_images"]:
            skipped.append({
                "task_id": task_id,
                "reason": "not_enough_data",
                "dates": dates,
                "eligible_images": eligible_images,
                "positive_images": positive_images,
                "negative_images": negative_images,
                "boxes": boxes,
                "min_positive_images": task["min_positive_images"],
                "min_boxes": task["min_boxes"],
            })
            continue
        selected.append({
            **task,
            "dates": target_dates,
            "target_dates": target_dates,
            "train_dates": dates if aggregate_all_dates else target_dates,
            "eligible_images": eligible_images,
            "positive_images": positive_images,
            "negative_images": negative_images,
            "boxes": boxes,
        })
        if len(selected) >= max_tasks:
            break
    return selected, skipped


def attach_replay_dates(selected: list[dict], day_stats: dict, replay_max_days: int) -> None:
    available_days = sorted(day_stats)
    for task in selected:
        first_target = min(task["target_dates"])
        task_id = task["task_id"]
        candidates = [
            day for day in available_days
            if day < first_target
            and int(((day_stats.get(day) or {}).get("positive_images_by_task") or {}).get(task_id) or 0) > 0
        ]
        replay_dates = candidates[-max(0, replay_max_days):] if replay_max_days > 0 else []
        task["replay_dates"] = replay_dates
        task["train_dates"] = sorted(set(task["target_dates"]) | set(replay_dates))


def training_session_blocks_gpu(session_name: str) -> bool:
    lname = session_name.lower()
    if "yolo" not in lname and "bevplace" not in lname:
        return False
    gpu_tags = re.findall(r"gpu(\d+)", lname)
    if gpu_tags:
        return str(A100_GPU) in gpu_tags
    return True


def a100_gpu_status(max_mem_mib: int, max_util: int) -> dict:
    smi_cmd = (
        f"nvidia-smi --id={A100_GPU} "
        "--query-gpu=memory.used,memory.total,utilization.gpu "
        "--format=csv,noheader,nounits"
    )
    smi = a100(smi_cmd, timeout=30, check=True).stdout.strip()
    parts = [int(x.strip()) for x in smi.split(",")[:3]]
    tmux = a100("tmux ls 2>/dev/null || true", timeout=30).stdout.splitlines()
    active = []
    ignored = []
    for line in tmux:
        name = line.split(":", 1)[0].strip()
        if training_session_blocks_gpu(name):
            active.append(name)
        elif "yolo" in name.lower() or "bevplace" in name.lower():
            ignored.append(name)
    return {
        "gpu": A100_GPU,
        "memory_used_mib": parts[0],
        "memory_total_mib": parts[1],
        "util_percent": parts[2],
        "active_sessions": active,
        "ignored_other_gpu_sessions": ignored,
        "idle": parts[0] <= max_mem_mib and parts[2] <= max_util and not active,
    }


def build_dataset(task: dict, run_dir: Path) -> dict:
    train_dates = task.get("train_dates") or task["target_dates"]
    date_tag = "_".join(task["target_dates"])
    output = run_dir / "datasets" / f"{task['task_id']}_closed_loop_{date_tag}"
    log_path = run_dir / "logs" / f"{task['task_id']}_build.log"
    output.parent.mkdir(parents=True, exist_ok=True)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        sys.executable,
        str(BUILD_SCRIPT),
        "--task", task["build_task"],
        "--index", str(INDEX_PATH),
        "--frames-root", str(FRAMES_ROOT),
        "--label-root", str(LABEL_ROOT),
        "--manual-root", str(MANUAL_ANNOTATION_ROOT),
        "--patrol-dataset-id", PATROL_DATASET_ID,
        "--output", str(output),
        "--dates", *train_dates,
        "--qualities", ",".join(sorted(GOOD_QUALITIES)),
        "--include-empty",
        "--empty-to-positive-ratio", str(task["empty_to_positive_ratio"]),
        "--empty-sample-seed", f"{task['task_id']}:{','.join(train_dates)}",
        "--link-mode", "copy",
        "--data-yaml-mode", "dirs",
    ]
    result = run(cmd, timeout=3600)
    log_path.write_text(result.stdout + ("\nSTDERR\n" + result.stderr if result.stderr else ""), encoding="utf-8")
    if result.returncode != 0:
        raise RuntimeError(f"build_failed task={task['task_id']} log={log_path}")
    summary = load_json(output / "dataset_summary.json", {})
    boxes = sum(int(v or 0) for v in (summary.get("boxes_by_class") or {}).values())
    images = sum(int((summary.get("splits") or {}).get(split, {}).get("images") or 0) for split in ("train", "val", "test"))
    positive_images = sum(int((summary.get("splits") or {}).get(split, {}).get("positive_images") or 0) for split in ("train", "val", "test"))
    if boxes < task["min_boxes"] or positive_images < task["min_positive_images"]:
        raise RuntimeError(f"build_under_threshold task={task['task_id']} images={images} positive_images={positive_images} boxes={boxes}")
    return {
        "task_id": task["task_id"],
        "target_dates": task["target_dates"],
        "replay_dates": task.get("replay_dates") or [],
        "train_dates": train_dates,
        "local_dataset": str(output),
        "summary": summary,
        "images": images,
        "positive_images": positive_images,
        "boxes": boxes,
    }


def remote_quote(value: str) -> str:
    return shlex.quote(str(value))


def make_remote_job(run_tag: str, built: list[dict], selected: list[dict], run_dir: Path) -> Path:
    by_task = {item["task_id"]: item for item in selected}
    lines = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        f"ROOT={remote_quote(A100_ROOT)}",
        "cd \"$ROOT\"",
        "mkdir -p logs results runs scripts",
        f"echo \"$(date -Is) daily_yolo_job_start run_tag={run_tag}\"",
    ]
    for item in built:
        task = by_task[item["task_id"]]
        train_dates = task.get("train_dates") or task["target_dates"]
        remote_dataset = f"{A100_ROOT}/datasets/{run_tag}/{Path(item['local_dataset']).name}"
        remote_data_yaml = f"{remote_dataset}/data.yaml"
        remote_log = f"{A100_ROOT}/logs/{task['task_id']}_{run_tag}.log"
        lines.extend([
            f"python3 - <<'PY_{task['task_id']}'",
            "from pathlib import Path",
            f"p = Path({remote_data_yaml!r})",
            "lines = p.read_text(encoding='utf-8').splitlines()",
            f"lines = [({remote_dataset!r} if line.startswith('path: ') else line) for line in lines]",
            "lines = [('path: ' + line) if line == " + repr(remote_dataset) + " else line for line in lines]",
            "p.write_text('\\n'.join(lines) + '\\n', encoding='utf-8')",
            f"PY_{task['task_id']}",
            f"echo \"$(date -Is) train_start task={task['task_id']} target_dates={','.join(task['target_dates'])} train_dates={','.join(train_dates)} replay_dates={','.join(task.get('replay_dates') or [])}\" | tee -a {remote_quote(remote_log)}",
            f"CUDA_VISIBLE_DEVICES={A100_GPU} \\",
            f"RELIABLE_YOLO_TASK={remote_quote(task['task_id'])} \\",
            f"RELIABLE_YOLO_RUN_TAG={remote_quote(run_tag)} \\",
            f"RELIABLE_YOLO_DATA={remote_quote(remote_data_yaml)} \\",
            f"RELIABLE_YOLO_OUT={remote_quote(A100_ROOT + '/results/' + task['task_id'])} \\",
            f"RELIABLE_YOLO_PROJECT={remote_quote(A100_ROOT + '/runs/' + task['task_id'])} \\",
            f"RELIABLE_YOLO_BASE_WEIGHTS={remote_quote(run_tag + '=' + task['base_weight'])} \\",
            f"RELIABLE_YOLO_EPOCHS={task['epochs']} \\",
            f"RELIABLE_YOLO_PATIENCE={task['patience']} \\",
            f"RELIABLE_YOLO_BATCH={task['batch']} \\",
            f"RELIABLE_YOLO_IMGSZ={task['imgsz']} \\",
            "RELIABLE_YOLO_WORKERS=8 \\",
            f"{remote_quote(A100_PY)} scripts/train_reliable_yolo_finetune.py 2>&1 | tee -a {remote_quote(remote_log)}",
        ])
    lines.append(f"echo \"$(date -Is) daily_yolo_job_done run_tag={run_tag}\"")
    job = run_dir / f"{run_tag}.a100.sh"
    job.write_text("\n".join(lines) + "\n", encoding="utf-8")
    job.chmod(0o755)
    return job


def schedule_remote(run_tag: str, built: list[dict], selected: list[dict], run_dir: Path) -> str:
    a100(f"mkdir -p {remote_quote(A100_ROOT)}/scripts {remote_quote(A100_ROOT)}/datasets/{remote_quote(run_tag)} {remote_quote(A100_ROOT)}/logs", check=True)
    rsync_to_a100(TRAIN_SCRIPT, f"{A100_ROOT}/scripts/train_reliable_yolo_finetune.py")
    rsync_to_a100(BUILD_SCRIPT, f"{A100_ROOT}/scripts/build_reliable_vehicle_upload_yolo.py")
    rsync_to_a100(POLICY_SCRIPT, f"{A100_ROOT}/scripts/yolo_closed_loop_policy.py")
    for item in built:
        local_dataset = Path(item["local_dataset"])
        remote_dataset = f"{A100_ROOT}/datasets/{run_tag}/{local_dataset.name}"
        a100(f"mkdir -p {remote_quote(remote_dataset)}", check=True)
        rsync_to_a100(local_dataset, remote_dataset, timeout=3600)
    job = make_remote_job(run_tag, built, selected, run_dir)
    remote_job = f"{A100_ROOT}/logs/{job.name}"
    rsync_to_a100(job, remote_job)
    session = f"yolo-daily-closed-loop-gpu{A100_GPU}-{run_tag}"
    a100(f"tmux new-session -d -s {remote_quote(session)} 'bash {remote_quote(remote_job)}'", check=True)
    return session


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument(
        "--all-dates",
        action="store_true",
        default=str(os.environ.get("YOLO_DAILY_ALL_DATES", "")).strip().lower() in {"1", "true", "yes", "on"},
    )
    parser.add_argument("--lookback-days", type=int, default=int(os.environ.get("YOLO_DAILY_LOOKBACK_DAYS", "5")))
    parser.add_argument("--replay-lookback-days", type=int, default=int(os.environ.get("YOLO_DAILY_REPLAY_LOOKBACK_DAYS", "7")))
    parser.add_argument("--replay-max-days", type=int, default=int(os.environ.get("YOLO_DAILY_REPLAY_MAX_DAYS", "4")))
    parser.add_argument("--max-tasks", type=int, default=int(os.environ.get("YOLO_DAILY_MAX_TASKS", "3")))
    parser.add_argument("--max-dates-per-task", type=int, default=int(os.environ.get("YOLO_DAILY_MAX_DATES_PER_TASK", "3")))
    parser.add_argument("--train-today-after-hour", type=int, default=int(os.environ.get("YOLO_DAILY_TRAIN_TODAY_AFTER_HOUR", "22")))
    parser.add_argument("--gpu-max-mem-mib", type=int, default=int(os.environ.get("YOLO_DAILY_GPU_MAX_MEM_MIB", "2000")))
    parser.add_argument("--gpu-max-util", type=int, default=int(os.environ.get("YOLO_DAILY_GPU_MAX_UTIL", "15")))
    parser.add_argument("--start-day", default=os.environ.get("YOLO_DAILY_START_DAY", ""))
    parser.add_argument("--tasks", default=os.environ.get("YOLO_DAILY_TASKS", ""))
    args = parser.parse_args()

    now = cn_now()
    default_start = compact_day(now - timedelta(days=1))
    start_day = args.start_day or default_start
    active_tasks = selected_tasks(args.tasks)
    state = load_json(STATE_PATH, {"schema": "jgzj_yolo_daily_closed_loop_state.v1", "task_dates": {}, "runs": []})
    if args.all_dates:
        day_stats = summarize_index(None, active_tasks)
        days = all_candidate_days(day_stats, start_day, args.train_today_after_hour)
        replay_candidate_days = days
    else:
        days = day_range(start_day, args.lookback_days, args.train_today_after_hour)
        replay_candidate_days = recent_day_range(args.replay_lookback_days, args.train_today_after_hour)
        day_stats = summarize_index(set(days) | set(replay_candidate_days), active_tasks)
    selected, skipped = choose_tasks(
        day_stats,
        days,
        state,
        args.max_tasks,
        args.max_dates_per_task,
        active_tasks,
        aggregate_all_dates=args.all_dates,
    )
    if args.all_dates:
        for task in selected:
            task["replay_dates"] = []
    else:
        attach_replay_dates(selected, day_stats, args.replay_max_days)
    gpu_status = a100_gpu_status(args.gpu_max_mem_mib, args.gpu_max_util)

    payload = {
        "ok": True,
        "dry_run": args.dry_run,
        "all_dates": args.all_dates,
        "checked_at": now.isoformat(),
        "start_day": start_day,
        "task_filter": [task["task_id"] for task in active_tasks],
        "candidate_days": days,
        "replay_candidate_days": replay_candidate_days,
        "day_stats": day_stats,
        "training_policy": {
            "manual_annotations": "preferred",
            "qwen_audit": "training_eligible" if ALLOW_QWEN_AUDIT_PASS else "review_queue_only",
            "training_release": (
                "manual_annotation_or_qwen_audit_pass"
                if ALLOW_QWEN_AUDIT_PASS
                else "manual_annotation_required"
            ),
            "allow_qwen_audit_pass": ALLOW_QWEN_AUDIT_PASS,
            "qwen_audit_prompt_version": EXPECTED_AUDIT_PROMPT_VERSION,
        },
        "selected": [
            {k: v for k, v in item.items() if k not in {"classes"}}
            for item in selected
        ],
        "skipped": skipped,
        "a100": gpu_status,
    }
    if args.dry_run:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return
    if not selected:
        payload["action"] = "skip_no_selected_task"
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return
    if not args.force and not gpu_status["idle"]:
        payload["action"] = "skip_a100_busy"
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return

    run_tag = now.strftime("%Y%m%d_%H%M%S")
    run_dir = RUNTIME_ROOT / "runs" / run_tag
    run_dir.mkdir(parents=True, exist_ok=True)
    built = []
    for task in selected:
        built.append(build_dataset(task, run_dir))
    session = schedule_remote(run_tag, built, selected, run_dir)

    task_dates = state.setdefault("task_dates", {})
    for task in selected:
        per_task = task_dates.setdefault(task["task_id"], {})
        for day in task["target_dates"]:
            per_task[day] = {
                "status": "scheduled",
                "run_tag": run_tag,
                "session": session,
                "scheduled_at": now.isoformat(),
                "eligible_images": task["eligible_images"],
                "positive_images": task["positive_images"],
                "negative_images": task["negative_images"],
                "boxes": task["boxes"],
                "train_dates": task.get("train_dates") or task["target_dates"],
                "replay_dates": task.get("replay_dates") or [],
            }
    state.setdefault("runs", []).append({
        "run_tag": run_tag,
        "session": session,
        "scheduled_at": now.isoformat(),
        "tasks": [
            {
                "task_id": task["task_id"],
                "target_dates": task["target_dates"],
                "train_dates": task.get("train_dates") or task["target_dates"],
                "replay_dates": task.get("replay_dates") or [],
                "eligible_images": task["eligible_images"],
                "positive_images": task["positive_images"],
                "negative_images": task["negative_images"],
                "boxes": task["boxes"],
            }
            for task in selected
        ],
    })
    write_json(STATE_PATH, state)
    payload.update({
        "action": "scheduled",
        "run_tag": run_tag,
        "session": session,
        "built": built,
    })
    (run_dir / "schedule_summary.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
