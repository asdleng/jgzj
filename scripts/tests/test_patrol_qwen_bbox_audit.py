import importlib.util
import tempfile
import unittest
from pathlib import Path


TEST_PARENT = Path(__file__).resolve().parents[1]
SCRIPT_ROOT = TEST_PARENT if (TEST_PARENT / "patrol_qwen_bbox_audit.py").exists() else TEST_PARENT / "scripts"
SCRIPT = SCRIPT_ROOT / "patrol_qwen_bbox_audit.py"
SPEC = importlib.util.spec_from_file_location("patrol_qwen_bbox_audit", SCRIPT)
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)


class AuditCachePolicyTest(unittest.TestCase):
    def test_cache_requires_current_prompt_and_label_fingerprint(self):
        labels = [{"i": 0, "class": "person", "confidence": 0.9, "bbox_1000": [1, 2, 3, 4], "note": "real_person"}]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "audit.json"
            AUDIT.save_json_atomic(path, {
                "schema": AUDIT.SCHEMA,
                "verdict": "pass",
                "prompt_version": AUDIT.PROMPT_VERSION,
                "label_fingerprint": AUDIT.labels_fingerprint(labels),
            })
            self.assertTrue(AUDIT.cache_has_valid_audit(path, labels))
            changed = [dict(labels[0], bbox_1000=[10, 20, 30, 40])]
            self.assertFalse(AUDIT.cache_has_valid_audit(path, changed))

    def test_person_vehicle_nonmotor_are_auditable_misses(self):
        for name in ("person", "vehicle", "nonmotor"):
            item = AUDIT.normalize_miss_item({"class": name, "bbox": [10, 20, 100, 200], "score": 0.9})
            self.assertIsNotNone(item)

    def test_recent_rows_are_processed_before_old_high_risk_rows(self):
        old_fire = {
            "meta": {"collected_at": "2026-06-25T00:00:00Z"},
            "labels": [{"class": "fire", "confidence": 0.9, "note": "red_fire_box"}],
        }
        recent_person = {
            "meta": {"collected_at": "2026-07-15T00:00:00Z"},
            "labels": [{"class": "person", "confidence": 0.9, "note": "real_person"}],
        }
        ordered = sorted([old_fire, recent_person], key=AUDIT.row_sort_key, reverse=True)
        self.assertIs(ordered[0], recent_person)


if __name__ == "__main__":
    unittest.main()
