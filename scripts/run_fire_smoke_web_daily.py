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


SCHEMA = "jgzj_fire_smoke_web_daily.v1"


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


def plan_daily_state(
    existing: dict,
    day: str,
    current_count: int,
    daily_limit: int,
    timestamp: str,
) -> dict:
    if daily_limit <= 0:
        raise ValueError("daily_limit must be positive")
    same_day = existing.get("schema") == SCHEMA and existing.get("day") == day
    if same_day:
        try:
            baseline_count = int(existing["baseline_count"])
            target_count = int(existing["target_count"])
            attempts = int(existing.get("attempts") or 0) + 1
        except (KeyError, TypeError, ValueError) as exc:
            raise DailyValidationError("same_day_state_is_incomplete") from exc
        if baseline_count < 0 or target_count != baseline_count + daily_limit:
            raise DailyValidationError("same_day_state_target_is_invalid")
        state = dict(existing)
    else:
        baseline_count = current_count
        target_count = baseline_count + daily_limit
        attempts = 1
        state = {
            "schema": SCHEMA,
            "day": day,
            "baseline_count": baseline_count,
            "target_count": target_count,
            "daily_limit": daily_limit,
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
        description="Run the idempotent daily fire/smoke Commons crawl and Qwen review."
    )
    parser.add_argument("--repo-root", type=Path, default=repo_default)
    parser.add_argument("--dataset", type=Path)
    parser.add_argument("--commons-config", type=Path)
    parser.add_argument("--dedupe-manifest", type=Path, action="append", default=[])
    parser.add_argument("--state", type=Path)
    parser.add_argument("--lock", type=Path)
    parser.add_argument("--daily-limit", type=int, default=50)
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
    dataset = (args.dataset or repo_root / ".runtime/yolo_loop/datasets/fire_smoke_web_candidates_v3").resolve()
    commons_config = (args.commons_config or repo_root / "config/wikimedia_fire_smoke_queries_daily.json").resolve()
    state_path = (args.state or repo_root / ".runtime/yolo_loop/fire_smoke_web_daily/state.json").resolve()
    lock_path = (args.lock or state_path.with_suffix(".lock")).resolve()
    dedupe_manifests = [path.resolve() for path in args.dedupe_manifest]
    if not dedupe_manifests:
        dedupe_manifests = [
            (repo_root / ".runtime/yolo_loop/datasets/fire_smoke_web_candidates_v2/manifest_selected_images.jsonl").resolve()
        ]

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
        )
        plan = {
            "schema": SCHEMA,
            "dry_run": bool(args.dry_run),
            "dataset": str(dataset),
            "commons_config": str(commons_config),
            "dedupe_manifests": [str(path) for path in dedupe_manifests],
            "day": planned_state["day"],
            "baseline_count": planned_state["baseline_count"],
            "current_count": current_count,
            "target_count": planned_state["target_count"],
            "daily_limit": args.daily_limit,
            "attempt": planned_state["attempts"],
            "qwen_endpoint": args.endpoint,
            "qwen_model": args.model,
            "training_eligible": False,
        }
        print(json.dumps(plan, ensure_ascii=False, indent=2), flush=True)
        if args.dry_run:
            return 0

        write_json_atomic(state_path, planned_state)
        started = time.monotonic()
        try:
            qwen_health = verify_qwen(args.endpoint, args.model, args.api_key, args.health_timeout)
            crawler_command = [
                args.python,
                str(repo_root / "scripts/crawl_fire_smoke_candidates.py"),
                "--output", str(dataset),
                "--commons-config", str(commons_config),
                "--max-images", str(planned_state["target_count"]),
                "--max-per-series", "4",
            ]
            for path in dedupe_manifests:
                crawler_command.extend(["--dedupe-manifest", str(path)])
            run_command(crawler_command)
            run_command([
                args.python,
                str(repo_root / "scripts/label_fire_smoke_candidates_qwen.py"),
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
