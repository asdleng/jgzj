#!/usr/bin/env python3
import argparse
import json
import tempfile
import time
import unittest
from pathlib import Path

from build_yolo_event_feedback_dataset import build_dataset


class EventFeedbackDatasetTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.permanent = root / "permanent"
        self.labels = root / "labels"
        self.audits = root / "audits"
        self.output = root / "output"

    def tearDown(self):
        self.temp.cleanup()

    def add_frame(self, sha, request_id, event_name, labels=None, quality="good", with_cache=True):
        day = self.permanent / "20260714"
        day.mkdir(parents=True, exist_ok=True)
        image = day / f"{request_id}_{sha[:16]}.jpg"
        image.write_bytes(b"sample-jpeg")
        meta = {
            "source": "qwen_permanent_yes_frame",
            "request_id": request_id,
            "image_sha256": sha,
            "device_id": "BIT-TEST",
            "camera_id": "1",
            "collected_at": "2026-07-13T19:00:00Z",
            "yes_tasks": [{
                "task_id": "task_1",
                "event_name": event_name,
                "answer": "YES",
                "pass": True,
            }],
        }
        image.with_suffix(".jpg.json").write_text(json.dumps(meta), encoding="utf-8")
        if with_cache:
            label_path = self.labels / sha[:2] / f"{sha}.json"
            label_path.parent.mkdir(parents=True, exist_ok=True)
            label_path.write_text(json.dumps({
                "ok": True,
                "parse_ok": True,
                "quality": quality,
                "labels": labels or [],
            }), encoding="utf-8")

    def test_disagreement_agreement_and_pending_are_separated(self):
        paper_sha = "1" * 64
        vehicle_sha = "2" * 64
        pending_sha = "3" * 64
        self.add_frame(paper_sha, "req_paper", "paper", labels=[])
        self.add_frame(vehicle_sha, "req_car", "car", labels=[{
            "class_name": "vehicle",
            "x": 0.5,
            "y": 0.5,
            "w": 0.2,
            "h": 0.2,
        }])
        self.add_frame(pending_sha, "req_smoke", "smoke", with_cache=False)
        args = argparse.Namespace(
            permanent_root=self.permanent,
            label_root=self.labels,
            audit_root=self.audits,
            output_root=self.output,
            days=0,
        )
        summary = build_dataset(args)
        self.assertEqual(summary["feedback"]["total_images"], 3)
        self.assertEqual(summary["feedback"]["status_counts"]["needs_human"], 1)
        self.assertEqual(summary["feedback"]["status_counts"]["agreement"], 1)
        self.assertEqual(summary["feedback"]["status_counts"]["pending_label"], 1)
        self.assertEqual(summary["feedback"]["training_eligible_images"], 0)

        manifests = [
            json.loads(line)
            for line in (self.output / "manifest_selected_images.jsonl").read_text(encoding="utf-8").splitlines()
        ]
        by_request = {row["tasks"][0]["request_id"]: row for row in manifests}
        self.assertEqual(by_request["req_paper"]["feedback_reason"], "edge_cloud_disagreement")
        self.assertEqual(by_request["req_paper"]["missing_expected_classes"], ["trash"])
        self.assertFalse(by_request["req_paper"]["training_eligible"])
        self.assertEqual(by_request["req_car"]["independent_classes"], ["vehicle"])
        self.assertTrue((self.output / by_request["req_car"]["image"]).exists())
        label_path = self.output / by_request["req_car"]["image"].replace("images/", "labels/").replace(".jpg", ".txt")
        self.assertTrue(label_path.read_text(encoding="utf-8").startswith("1 "))

        first_mtime = label_path.stat().st_mtime_ns
        stale_image = self.output / "images" / "review" / "stale.jpg"
        stale_label = self.output / "labels" / "review" / ".stale.txt.tmp"
        stale_image.write_bytes(b"stale")
        stale_label.write_text("stale", encoding="utf-8")
        time.sleep(0.01)
        second_summary = build_dataset(args)
        self.assertEqual(label_path.stat().st_mtime_ns, first_mtime)
        self.assertFalse(stale_image.exists())
        self.assertFalse(stale_label.exists())
        self.assertEqual(second_summary["feedback"]["pruned_files"], 2)


if __name__ == "__main__":
    unittest.main()
