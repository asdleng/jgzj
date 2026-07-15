#!/usr/bin/env python3
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from label_weak_event_candidates_qwen import (
    apply_review_guards,
    audit_prompt,
    detect_prompt,
    normalize_boxes,
    target_from_bucket,
    yolo_text,
)


class WeakEventWebPipelineTest(unittest.TestCase):
    def test_every_query_bucket_maps_to_a_target(self):
        config = Path(__file__).resolve().parents[1] / "config" / "wikimedia_weak_event_queries_v1.json"
        data = json.loads(config.read_text(encoding="utf-8"))
        self.assertGreater(len(data["queries"]), 20)
        self.assertTrue(all(target_from_bucket(item["bucket"]) for item in data["queries"]))

    def test_target_mapping(self):
        self.assertEqual(target_from_bucket("fishing_rod_positive"), "fishing_rod")
        self.assertEqual(target_from_bucket("hard_negative_stall"), "stall")
        self.assertEqual(target_from_bucket("pet_domain_positive"), "pet")
        self.assertEqual(target_from_bucket("hard_negative_trash"), "trash")
        self.assertIsNone(target_from_bucket("unknown"))

    def test_fishing_rod_filter_rejects_walking_stick(self):
        labels = normalize_boxes([
            ["fishing_rod", 100, 100, 700, 900, 0.94, "angler_holding_visible_fishing_rod"],
            ["fishing_rod", 100, 100, 700, 900, 0.99, "person_holding_walking_stick"],
        ], "fishing_rod")
        self.assertEqual(len(labels), 1)
        self.assertEqual(labels[0]["class_name"], "fishing_rod")

    def test_pet_filter_rejects_statue(self):
        labels = normalize_boxes([
            ["pet", 100, 100, 500, 700, 0.95, "live_dog_in_park"],
            ["pet", 500, 100, 800, 700, 0.99, "dog_statue_in_park"],
        ], "pet")
        self.assertEqual(len(labels), 1)

    def test_stall_filter_rejects_fixed_kiosk(self):
        labels = normalize_boxes([
            ["stall", 100, 100, 700, 900, 0.96, "temporary_vendor_table_with_goods"],
            ["stall", 100, 100, 700, 900, 0.99, "fixed_vending_kiosk"],
        ], "stall")
        self.assertEqual(len(labels), 1)

    def test_trash_filter_keeps_supported_litter_classes(self):
        labels = normalize_boxes([
            ["paper", 100, 700, 300, 900, 0.94, "discarded_loose_paper_on_ground"],
            ["box", 400, 400, 800, 900, 0.99, "stacked_storage_box"],
            ["trash", 100, 100, 300, 300, 0.99, "discarded_litter"],
        ], "trash")
        self.assertEqual([item["class_name"] for item in labels], ["paper"])

    def test_hard_negative_positive_is_quarantined(self):
        kept, scene, reason = apply_review_guards(
            [{"class_name": "pet"}], "positive", "hard_negative_pet",
        )
        self.assertEqual((kept, scene, reason), ([], "needs_human", "positive_in_hard_negative_bucket"))

    def test_prompts_and_yolo_output_are_deterministic(self):
        prompt = detect_prompt("stall")
        self.assertIn("Fixed kiosks", prompt)
        self.assertIn("temporary mobile vendor", prompt.lower())
        fishing_audit = audit_prompt("fishing_rod", {"b": []})
        self.assertIn("mounted or propped", fishing_audit)
        self.assertIn('[["fishing_rod",x1,y1,x2,y2,0.95,"visible_pixel_evidence"]]', fishing_audit)
        self.assertIn("Never return coordinate-only arrays", fishing_audit)
        text = yolo_text([{"class_id": 0, "x": 0.5, "y": 0.4, "w": 0.2, "h": 0.3}])
        self.assertEqual(text, "0 0.500000 0.400000 0.200000 0.300000\n")


if __name__ == "__main__":
    unittest.main()
