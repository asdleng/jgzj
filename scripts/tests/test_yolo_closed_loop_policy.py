import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


TEST_PARENT = Path(__file__).resolve().parents[1]
SCRIPT_ROOT = TEST_PARENT if (TEST_PARENT / "yolo_closed_loop_policy.py").exists() else TEST_PARENT / "scripts"
sys.path.insert(0, str(SCRIPT_ROOT))

from yolo_closed_loop_policy import (  # noqa: E402
    EXPECTED_AUDIT_PROMPT_VERSION,
    effective_labels,
    load_manual_annotations,
    training_row_decision,
)


def base_row():
    labels = [{"class_name": "person", "x": 0.5, "y": 0.5, "w": 0.1, "h": 0.2, "confidence": 0.9}]
    return {
        "image_rel_path": "20260714/run/frame.jpg",
        "meta": {"source": "auto_ad_patrol_flow_upload", "image_sha256": "a" * 64},
        "auto_labels": labels,
        "qwen_bbox_status": "done",
        "qwen_bbox_quality": "good",
        "qwen_bbox_rel_path": "vehicle_upload_qwen_bbox_labels_v1/aa/a.json",
        "qwen_bbox_audit_status": "done",
        "qwen_bbox_audit_verdict": "pass",
        "qwen_bbox_audit": {
            "prompt_version": EXPECTED_AUDIT_PROMPT_VERSION,
            "label_count": 1,
            "label_classes": ["person"],
        },
    }


class ClosedLoopPolicyTest(unittest.TestCase):
    def test_matching_v2_audit_pass_is_eligible(self):
        self.assertEqual(training_row_decision(base_row())[:2], (True, "qwen_audit_pass"))

    def test_pending_and_old_audit_are_rejected(self):
        pending = base_row()
        pending["qwen_bbox_audit_status"] = "pending"
        pending["qwen_bbox_audit_verdict"] = ""
        self.assertEqual(training_row_decision(pending)[1], "audit_not_done")

        old = base_row()
        old["qwen_bbox_audit"]["prompt_version"] = "qwen_bbox_audit_prompt_v1"
        self.assertEqual(training_row_decision(old)[1], "audit_policy_version")

    def test_audit_snapshot_mismatch_is_rejected(self):
        row = base_row()
        row["auto_labels"].append({"class_name": "vehicle"})
        self.assertEqual(training_row_decision(row)[1], "audit_snapshot_mismatch")

    def test_manual_annotation_overrides_qwen_and_can_create_negative(self):
        row = base_row()
        row["qwen_bbox_audit_status"] = "pending"
        row["qwen_bbox_audit_verdict"] = ""
        manual = {
            row["image_rel_path"]: {
                "kind": "detect",
                "labels": [],
                "deleted": False,
            }
        }
        ok, reason, annotation = training_row_decision(row, manual)
        self.assertTrue(ok)
        self.assertEqual(reason, "manual")
        self.assertEqual(effective_labels(row, annotation), [])

    def test_manual_deleted_is_excluded(self):
        row = base_row()
        manual = {row["image_rel_path"]: {"kind": "detect", "labels": [], "deleted": True}}
        self.assertEqual(training_row_decision(row, manual)[1], "manual_deleted")

    def test_loader_only_accepts_patrol_schema(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "aa").mkdir()
            payload = {
                "schema": "jgzj_yolo_manual_annotation.v1",
                "dataset_id": "patrol:vehicle-self-collected",
                "item_key": "20260714/run/frame.jpg",
                "kind": "detect",
                "labels": [],
                "deleted": False,
                "updated_at": "2026-07-15T00:00:00Z",
            }
            (root / "aa" / "valid.json").write_text(json.dumps(payload), encoding="utf-8")
            payload["dataset_id"] = "loop:other"
            (root / "aa" / "other.json").write_text(json.dumps(payload), encoding="utf-8")
            loaded = load_manual_annotations(root)
            self.assertEqual(list(loaded), ["20260714/run/frame.jpg"])

    def test_builder_uses_manual_empty_person_label_as_negative(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            frames = root / "frames"
            labels = root / "labels"
            manual_root = labels / "manual_annotations_v1" / "aa"
            output = root / "output"
            image_rel = "20260714/run/frame.jpg"
            (frames / "20260714" / "run").mkdir(parents=True)
            (frames / image_rel).write_bytes(b"test-image")
            manual_root.mkdir(parents=True)

            row = base_row()
            row["image_rel_path"] = image_rel
            row["qwen_bbox_audit_status"] = "pending"
            row["qwen_bbox_audit_verdict"] = ""
            index_path = root / "index.json"
            index_path.write_text(json.dumps({"rows": [row]}), encoding="utf-8")
            manual = {
                "schema": "jgzj_yolo_manual_annotation.v1",
                "dataset_id": "patrol:vehicle-self-collected",
                "item_key": image_rel,
                "kind": "detect",
                "answer": "NO",
                "labels": [],
                "deleted": False,
                "updated_at": "2026-07-15T00:00:00Z",
            }
            (manual_root / "annotation.json").write_text(json.dumps(manual), encoding="utf-8")

            result = subprocess.run([
                sys.executable,
                str(SCRIPT_ROOT / "build_reliable_vehicle_upload_yolo.py"),
                "--task", "person",
                "--index", str(index_path),
                "--frames-root", str(frames),
                "--label-root", str(labels),
                "--manual-root", str(labels / "manual_annotations_v1"),
                "--output", str(output),
                "--dates", "20260714",
                "--include-empty",
                "--link-mode", "copy",
            ], check=False, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            summary = json.loads((output / "dataset_summary.json").read_text(encoding="utf-8"))
            self.assertEqual(summary["review_sources"], {"manual": 1})
            self.assertEqual(summary["rows_candidate_empty"], 1)
            generated = list((output / "labels").glob("*/*.txt"))
            self.assertEqual(len(generated), 1)
            self.assertEqual(generated[0].read_text(encoding="utf-8"), "")


if __name__ == "__main__":
    unittest.main()
