#!/usr/bin/env python3
from __future__ import annotations

import argparse
import fcntl
import json
import os
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path
from typing import Dict, Iterator, List, Optional

import requests


SCHEMA = "jgzj_weak_event_web_daily.v1"

WEAK_EVENT_CLASSES = ("fishing_rod", "pet", "stall", "bottle", "box", "paper", "bag")
TARGET_CLASSES = {
    "all": WEAK_EVENT_CLASSES,
    "fishing_rod": ("fishing_rod",),
    "stall": ("stall",),
    "pet": ("pet",),
    "trash": ("bottle", "box", "paper", "bag"),
}


class DailyValidationError(RuntimeError):
    pass


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def local_day() -> str:
    return datetime.now().astimezone().date().isoformat()


def write_json_atomic(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(tmp_name, path)
    finally:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass


def read_json(path: Path) -> dict:
    if not path.is_file():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise DailyValidationError(f"invalid_json:{path}:{exc}") from exc
    if not isinstance(value, dict):
        raise DailyValidationError(f"json_object_required:{path}")
    return value


def iter_jsonl(path: Path) -> Iterator[dict]:
    if not path.is_file():
        return
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise DailyValidationError(f"jsonl_read_failed:{path}:{exc}") from exc
    for line_number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except ValueError as exc:
            raise DailyValidationError(f"invalid_jsonl:{path}:{line_number}:{exc}") from exc
        if not isinstance(row, dict):
            raise DailyValidationError(f"jsonl_object_required:{path}:{line_number}")
        yield row


def count_jsonl(path: Path) -> int:
    return sum(1 for _ in iter_jsonl(path))


def capped_target_count(baseline_count: int, daily_limit: int, total_target: int = 0) -> int:
    target_count = baseline_count + daily_limit
    if total_target > 0:
        target_count = min(target_count, total_target)
        target_count = max(target_count, baseline_count)
    return target_count


def ensure_pending_dataset_summary(
    dataset: Path,
    target: str,
    class_names: tuple[str, ...],
    image_count: int,
    target_count: int,
    total_target: int,
    timestamp: str,
) -> None:
    summary_path = dataset / "dataset_summary.json"
    existing = read_json(summary_path)
    if existing.get("schema") == "jgzj_weak_event_web_qwen_summary.v1":
        desired_profile = f"弱事件网络候选集:{target}"
        desired_classes = list(class_names)
        if existing.get("profile") != desired_profile or existing.get("classes") != desired_classes:
            updated = dict(existing)
            updated["profile"] = desired_profile
            updated["classes"] = desired_classes
            updated["updated_at"] = existing.get("updated_at") or timestamp
            write_json_atomic(summary_path, updated)
        return
    write_json_atomic(summary_path, {
        "schema": "jgzj_weak_event_web_qwen_summary.v1",
        "profile": f"弱事件网络候选集:{target}",
        "kind": "detect",
        "updated_at": timestamp,
        "classes": list(class_names),
        "images": {"review": image_count},
        "crawl_target_images": target_count,
        "crawl_total_target_images": total_target,
        "run_counts": {},
        "scene_counts": {},
        "target_scene_counts": {},
        "boxes_by_class": {},
        "audit_counts": {},
        "quarantine_counts": {},
        "qwen_model": "",
        "qwen_label_summary": {
            "labeled_images": 0,
            "scene_positive": 0,
            "scene_hard_negative": 0,
            "scene_needs_human": 0,
            "scene_unusable": 0,
            "accepted_boxes": 0,
            "model_accepted_boxes": 0,
            "proposed_boxes": 0,
            "audit_pass": 0,
            "audit_needs_human": 0,
            "audit_not_run": 0,
            "quarantine_positive_in_hard_negative_bucket": 0,
        },
        "training_eligible": False,
        "training_policy": "two_pass_qwen_then_human_review",
        "source_policy": "license_metadata_required",
    })
    write_json_atomic(dataset / "training_guard.json", {
        "schema": "jgzj_yolo_training_guard.v1",
        "training_eligible": False,
        "reason": "Weak-event web candidates require human review before any training split is built.",
        "updated_at": timestamp,
    })


def plan_daily_state(
    existing: dict,
    day: str,
    current_count: int,
    daily_limit: int,
    timestamp: str,
    baseline_count_floor: int = 0,
    total_target: int = 0,
) -> dict:
    if daily_limit <= 0:
        raise ValueError("daily_limit must be positive")
    if baseline_count_floor < 0:
        raise ValueError("baseline_count_floor must be non-negative")
    if total_target < 0:
        raise ValueError("total_target must be non-negative")
    same_day = existing.get("schema") == SCHEMA and existing.get("day") == day
    if same_day:
        try:
            baseline_count = int(existing["baseline_count"])
            target_count = int(existing["target_count"])
            existing_daily_limit = int(existing.get("daily_limit", daily_limit))
            existing_total_target = int(existing.get("total_target") or 0)
            attempts = int(existing.get("attempts") or 0) + 1
        except (KeyError, TypeError, ValueError) as exc:
            raise DailyValidationError("same_day_state_is_incomplete") from exc
        expected_target_count = capped_target_count(
            baseline_count, existing_daily_limit, existing_total_target
        )
        if baseline_count < 0 or existing_daily_limit <= 0 or target_count != expected_target_count:
            raise DailyValidationError("same_day_state_target_is_invalid")
        state = dict(existing)
        baseline_changed = bool(baseline_count_floor and baseline_count < baseline_count_floor)
        limit_changed = existing_daily_limit != daily_limit
        total_target_changed = existing_total_target != total_target
        if baseline_changed:
            baseline_count = baseline_count_floor
        if baseline_changed or limit_changed or total_target_changed:
            target_count = capped_target_count(baseline_count, daily_limit, total_target)
            state["baseline_count"] = baseline_count
            state["target_count"] = target_count
            state["daily_limit"] = daily_limit
            state["total_target"] = total_target
    else:
        baseline_count = max(current_count, baseline_count_floor)
        target_count = capped_target_count(baseline_count, daily_limit, total_target)
        attempts = 1
        state = {
            "schema": SCHEMA,
            "day": day,
            "baseline_count": baseline_count,
            "target_count": target_count,
            "daily_limit": daily_limit,
            "total_target": total_target,
            "created_at": timestamp,
        }
    state.update({
        "status": "running",
        "attempts": attempts,
        "last_started_at": timestamp,
        "count_before_attempt": current_count,
        "last_error": "",
    })
    return state


def verify_qwen(endpoint: str, model: str, api_key: str, timeout: float) -> dict:
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    response = requests.get(endpoint.rstrip("/") + "/v1/models", headers=headers, timeout=timeout)
    response.raise_for_status()
    payload = response.json()
    models = [str(item.get("id") or "") for item in payload.get("data") or [] if isinstance(item, dict)]
    if model not in models:
        raise DailyValidationError(f"qwen_model_missing:{model}:available={models}")
    return {"endpoint": endpoint, "model": model, "available_models": models}


def run_command(command: List[str]) -> None:
    print(json.dumps({"event": "command", "argv": command}, ensure_ascii=False), flush=True)
    subprocess.run(command, check=True)


def validate_dataset(dataset: Path) -> dict:
    manifest_path = dataset / "manifest_selected_images.jsonl"
    review_path = dataset / "qwen_review_manifest.jsonl"
    manifest_rows = list(iter_jsonl(manifest_path))
    review_rows = list(iter_jsonl(review_path))
    if len(manifest_rows) != len(review_rows):
        raise DailyValidationError(
            f"manifest_review_count_mismatch:{len(manifest_rows)}!={len(review_rows)}"
        )

    manifest_shas = [str(row.get("sha256") or "") for row in manifest_rows]
    review_shas = [str(row.get("image_sha256") or "") for row in review_rows]
    if not all(manifest_shas) or len(set(manifest_shas)) != len(manifest_shas):
        raise DailyValidationError("manifest_sha_missing_or_duplicate")
    if not all(review_shas) or len(set(review_shas)) != len(review_shas):
        raise DailyValidationError("review_sha_missing_or_duplicate")
    if set(manifest_shas) != set(review_shas):
        raise DailyValidationError("manifest_review_sha_mismatch")

    guard = read_json(dataset / "training_guard.json")
    summary = read_json(dataset / "dataset_summary.json")
    if guard.get("training_eligible") is not False:
        raise DailyValidationError("training_guard_is_not_false")
    if summary.get("training_eligible") is not False:
        raise DailyValidationError("dataset_summary_training_eligible_is_not_false")
    if any(row.get("training_eligible") is not False for row in manifest_rows):
        raise DailyValidationError("manifest_training_eligible_is_not_false")
    if any(row.get("training_eligible") is not False for row in review_rows):
        raise DailyValidationError("review_training_eligible_is_not_false")

    hard_negative_positives = [
        row for row in review_rows
        if str(row.get("collection_bucket") or "").startswith("hard_negative")
        and str(row.get("scene") or "") == "positive"
    ]
    if hard_negative_positives:
        raise DailyValidationError(
            f"hard_negative_positive_guard_failed:{len(hard_negative_positives)}"
        )

    scenes: Dict[str, int] = {}
    box_count = 0
    for row in review_rows:
        scene = str(row.get("scene") or "unknown")
        scenes[scene] = scenes.get(scene, 0) + 1
        box_count += int(row.get("box_count") or 0)
    return {
        "manifest_count": len(manifest_rows),
        "review_count": len(review_rows),
        "scenes": scenes,
        "accepted_boxes": box_count,
        "hard_negative_positives": 0,
        "training_eligible": False,
    }


def parse_args() -> argparse.Namespace:
    repo_default = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(
        description="Run the idempotent daily licensed weak-event crawl and Qwen review."
    )
    parser.add_argument("--repo-root", type=Path, default=repo_default)
    parser.add_argument("--dataset", type=Path)
    parser.add_argument("--commons-config", type=Path)
    parser.add_argument("--openverse-config", type=Path, action="append", default=[])
    parser.add_argument("--dedupe-manifest", type=Path, action="append", default=[])
    parser.add_argument("--state", type=Path)
    parser.add_argument("--lock", type=Path)
    parser.add_argument("--daily-limit", type=int, default=500)
    parser.add_argument("--total-target", type=int, default=0)
    parser.add_argument("--target", choices=sorted(TARGET_CLASSES), default="all")
    parser.add_argument(
        "--baseline-count",
        type=int,
        default=int(os.environ.get("WEAK_EVENT_WEB_DAILY_BASELINE_COUNT", "0")),
        help="Minimum baseline_count used for daily planning; use 0 to start from the current dataset count.",
    )
    parser.add_argument("--endpoint", default="http://127.0.0.1:18016")
    parser.add_argument("--model", default="Qwen3.6-27B-Labeler")
    parser.add_argument("--api-key", default=os.environ.get("QWEN_LABELER_API_KEY", ""))
    parser.add_argument("--health-timeout", type=float, default=10.0)
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main(args: Optional[argparse.Namespace] = None) -> int:
    args = args or parse_args()
    repo_root = args.repo_root.resolve()
    target = getattr(args, "target", "all")
    target_suffix = target if target != "all" else ""
    default_dataset_name = (
        f"weak_event_web_{target_suffix}_candidates_v1"
        if target_suffix else "weak_event_web_candidates_v1"
    )
    default_config_name = (
        f"wikimedia_weak_event_{target_suffix}_queries_v1.json"
        if target_suffix else "wikimedia_weak_event_queries_v1.json"
    )
    default_openverse_config_name = (
        f"openverse_weak_event_{target_suffix}_queries_v1.json"
        if target_suffix else "openverse_weak_event_queries_v1.json"
    )
    default_state_dir = (
        f"weak_event_web_{target_suffix}_daily"
        if target_suffix else "weak_event_web_daily"
    )
    dataset = (
        args.dataset or repo_root / ".runtime/yolo_loop/datasets" / default_dataset_name
    ).resolve()
    commons_config = (args.commons_config or repo_root / "config" / default_config_name).resolve()
    openverse_configs = [path.resolve() for path in getattr(args, "openverse_config", [])]
    if not openverse_configs:
        default_openverse_config = repo_root / "config" / default_openverse_config_name
        if default_openverse_config.is_file():
            openverse_configs = [default_openverse_config.resolve()]
    state_path = (args.state or repo_root / ".runtime/yolo_loop" / default_state_dir / "state.json").resolve()
    lock_path = (args.lock or state_path.with_suffix(".lock")).resolve()
    dedupe_manifests = [path.resolve() for path in args.dedupe_manifest]
    class_names = TARGET_CLASSES[target]

    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+", encoding="utf-8") as lock_handle:
        try:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({"schema": SCHEMA, "status": "skipped_locked"}), flush=True)
            return 0

        manifest_path = dataset / "manifest_selected_images.jsonl"
        current_count = count_jsonl(manifest_path)
        timestamp = now_iso()
        existing_state = read_json(state_path)
        planned_state = plan_daily_state(
            existing_state,
            local_day(),
            current_count,
            args.daily_limit,
            timestamp,
            getattr(args, "baseline_count", 0),
            getattr(args, "total_target", 0),
        )
        plan = {
            "schema": SCHEMA,
            "dry_run": bool(args.dry_run),
            "target": target,
            "dataset": str(dataset),
            "commons_config": str(commons_config),
            "openverse_configs": [str(path) for path in openverse_configs],
            "dedupe_manifests": [str(path) for path in dedupe_manifests],
            "day": planned_state["day"],
            "baseline_count": planned_state["baseline_count"],
            "current_count": current_count,
            "target_count": planned_state["target_count"],
            "daily_limit": args.daily_limit,
            "total_target": getattr(args, "total_target", 0),
            "attempt": planned_state["attempts"],
            "qwen_endpoint": args.endpoint,
            "qwen_model": args.model,
            "training_eligible": False,
        }
        print(json.dumps(plan, ensure_ascii=False, indent=2), flush=True)
        if args.dry_run:
            return 0

        ensure_pending_dataset_summary(
            dataset,
            target,
            class_names,
            current_count,
            planned_state["target_count"],
            getattr(args, "total_target", 0),
            timestamp,
        )
        write_json_atomic(state_path, planned_state)
        started = time.monotonic()
        try:
            qwen_health = verify_qwen(args.endpoint, args.model, args.api_key, args.health_timeout)
            crawler_command = [
                args.python,
                str(repo_root / "scripts/crawl_fire_smoke_candidates.py"),
                "--output", str(dataset),
                "--commons-config", str(commons_config),
                "--dataset-schema", "jgzj_weak_event_web_candidate.v1",
                "--summary-schema", "jgzj_weak_event_web_candidate_summary.v1",
                "--profile", f"弱事件网络候选集:{target}",
                "--max-images", str(planned_state["target_count"]),
                "--max-per-series", "4",
            ]
            for class_name in class_names:
                crawler_command.extend(["--class-name", class_name])
            for path in openverse_configs:
                crawler_command.extend(["--openverse-config", str(path)])
            for path in dedupe_manifests:
                crawler_command.extend(["--dedupe-manifest", str(path)])
            run_command(crawler_command)
            run_command([
                args.python,
                str(repo_root / "scripts/label_weak_event_candidates_qwen.py"),
                "--dataset", str(dataset),
                "--endpoint", args.endpoint,
                "--model", args.model,
                "--max-images", str(planned_state["target_count"]),
                "--retry-errors",
            ])
            validation = validate_dataset(dataset)
            final_count = validation["manifest_count"]
            completed = dict(planned_state)
            completed.update({
                "status": "success",
                "last_finished_at": now_iso(),
                "duration_seconds": round(time.monotonic() - started, 3),
                "final_count": final_count,
                "added_since_baseline": final_count - int(planned_state["baseline_count"]),
                "qwen_health": qwen_health,
                "validation": validation,
                "last_error": "",
            })
            write_json_atomic(state_path, completed)
            print(json.dumps(completed, ensure_ascii=False, indent=2), flush=True)
            return 0
        except Exception as exc:
            failed = dict(planned_state)
            failed.update({
                "status": "failed",
                "last_finished_at": now_iso(),
                "duration_seconds": round(time.monotonic() - started, 3),
                "count_after_failure": count_jsonl(manifest_path),
                "last_error": f"{type(exc).__name__}:{str(exc)[:1000]}",
            })
            write_json_atomic(state_path, failed)
            print(json.dumps(failed, ensure_ascii=False, indent=2), file=sys.stderr, flush=True)
            raise


if __name__ == "__main__":
    raise SystemExit(main())
