#!/usr/bin/env python3
import json
import argparse
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from run_weak_event_web_daily import (  # noqa: E402
    DailyValidationError,
    SCHEMA,
    plan_daily_state,
    validate_dataset,
    main,
)


def write_jsonl(path: Path, rows) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(row, separators=(",", ":")) + "\n" for row in rows),
        encoding="utf-8",
    )


class WeakEventWebDailyTest(unittest.TestCase):
    def test_dry_run_reports_weak_event_plan(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            commons = root / "commons.json"
            openverse = root / "openverse.json"
            commons.write_text('{"queries":[]}', encoding="utf-8")
            openverse.write_text('{"queries":[]}', encoding="utf-8")
            args = argparse.Namespace(
                repo_root=root,
                dataset=root / "dataset",
                commons_config=commons,
                openverse_config=[openverse],
                dedupe_manifest=[],
                state=root / "state.json",
                lock=root / "state.lock",
                daily_limit=50,
                endpoint="http://127.0.0.1:1",
                model="test",
                api_key="",
                health_timeout=0.1,
                python=sys.executable,
                dry_run=True,
            )
            self.assertEqual(main(args), 0)

    def test_same_day_retry_reuses_original_target(self):
        first = plan_daily_state({}, "2026-07-14", 294, 50, "2026-07-14T02:20:00+08:00")
        self.assertEqual(first["baseline_count"], 294)
        self.assertEqual(first["target_count"], 344)
        self.assertEqual(first["attempts"], 1)

        first.update({"status": "failed", "count_after_failure": 319})
        retry = plan_daily_state(first, "2026-07-14", 319, 50, "2026-07-14T02:40:00+08:00")
        self.assertEqual(retry["baseline_count"], 294)
        self.assertEqual(retry["target_count"], 344)
        self.assertEqual(retry["attempts"], 2)

        next_day = plan_daily_state(retry, "2026-07-15", 344, 50, "2026-07-15T02:20:00+08:00")
        self.assertEqual(next_day["baseline_count"], 344)
        self.assertEqual(next_day["target_count"], 394)
        self.assertEqual(next_day["attempts"], 1)

    def test_baseline_count_floor_is_used_for_new_day(self):
        state = plan_daily_state(
            {},
            "2026-07-15",
            594,
            50,
            "2026-07-15T02:20:00+08:00",
            baseline_count_floor=3000,
        )
        self.assertEqual(state["baseline_count"], 3000)
        self.assertEqual(state["target_count"], 3050)

    def test_same_day_baseline_count_floor_raises_existing_target(self):
        existing = plan_daily_state({}, "2026-07-15", 594, 50, "2026-07-15T02:20:00+08:00")
        state = plan_daily_state(
            existing,
            "2026-07-15",
            594,
            50,
            "2026-07-15T02:40:00+08:00",
            baseline_count_floor=3000,
        )
        self.assertEqual(state["baseline_count"], 3000)
        self.assertEqual(state["target_count"], 3050)
        self.assertEqual(state["attempts"], 2)

    def test_same_day_config_increase_raises_existing_target(self):
        existing = plan_daily_state(
            {},
            "2026-07-24",
            921,
            50,
            "2026-07-24T02:20:00+08:00",
            baseline_count_floor=3000,
        )
        state = plan_daily_state(
            existing,
            "2026-07-24",
            1010,
            500,
            "2026-07-24T14:20:00+08:00",
            baseline_count_floor=8000,
        )
        self.assertEqual(state["baseline_count"], 8000)
        self.assertEqual(state["target_count"], 8500)
        self.assertEqual(state["daily_limit"], 500)
        self.assertEqual(state["attempts"], 2)

    def test_corrupt_same_day_target_is_rejected(self):
        state = {
            "schema": SCHEMA,
            "day": "2026-07-14",
            "baseline_count": 294,
            "target_count": 394,
            "attempts": 1,
        }
        with self.assertRaises(DailyValidationError):
            plan_daily_state(state, "2026-07-14", 320, 50, "now")

    def test_validation_accepts_guarded_one_to_one_dataset(self):
        with tempfile.TemporaryDirectory() as tmp:
            dataset = Path(tmp)
            manifest = [
                {"sha256": "a" * 64, "training_eligible": False},
                {"sha256": "b" * 64, "training_eligible": False},
            ]
            review = [
                {
                    "image_sha256": "a" * 64,
                    "collection_bucket": "stall_positive_market",
                    "scene": "positive",
                    "box_count": 1,
                    "training_eligible": False,
                },
                {
                    "image_sha256": "b" * 64,
                    "collection_bucket": "hard_negative_stall_kiosk",
                    "scene": "hard_negative",
                    "box_count": 0,
                    "training_eligible": False,
                },
            ]
            write_jsonl(dataset / "manifest_selected_images.jsonl", manifest)
            write_jsonl(dataset / "qwen_review_manifest.jsonl", review)
            (dataset / "training_guard.json").write_text('{"training_eligible":false}\n', encoding="utf-8")
            (dataset / "dataset_summary.json").write_text('{"training_eligible":false}\n', encoding="utf-8")
            result = validate_dataset(dataset)
        self.assertEqual(result["manifest_count"], 2)
        self.assertEqual(result["accepted_boxes"], 1)
        self.assertFalse(result["training_eligible"])

    def test_validation_rejects_positive_hard_negative(self):
        with tempfile.TemporaryDirectory() as tmp:
            dataset = Path(tmp)
            sha = "c" * 64
            write_jsonl(dataset / "manifest_selected_images.jsonl", [
                {"sha256": sha, "training_eligible": False},
            ])
            write_jsonl(dataset / "qwen_review_manifest.jsonl", [{
                "image_sha256": sha,
                "collection_bucket": "hard_negative_stall_kiosk",
                "scene": "positive",
                "training_eligible": False,
            }])
            (dataset / "training_guard.json").write_text('{"training_eligible":false}\n', encoding="utf-8")
            (dataset / "dataset_summary.json").write_text('{"training_eligible":false}\n', encoding="utf-8")
            with self.assertRaisesRegex(DailyValidationError, "hard_negative_positive"):
                validate_dataset(dataset)

    def test_validation_rejects_training_guard_enablement(self):
        with tempfile.TemporaryDirectory() as tmp:
            dataset = Path(tmp)
            sha = "d" * 64
            write_jsonl(dataset / "manifest_selected_images.jsonl", [
                {"sha256": sha, "training_eligible": False},
            ])
            write_jsonl(dataset / "qwen_review_manifest.jsonl", [{
                "image_sha256": sha,
                "collection_bucket": "fishing_rod_positive_category",
                "scene": "hard_negative",
                "training_eligible": False,
            }])
            (dataset / "training_guard.json").write_text('{"training_eligible":true}\n', encoding="utf-8")
            (dataset / "dataset_summary.json").write_text('{"training_eligible":false}\n', encoding="utf-8")
            with self.assertRaisesRegex(DailyValidationError, "training_guard"):
                validate_dataset(dataset)


if __name__ == "__main__":
    unittest.main()
