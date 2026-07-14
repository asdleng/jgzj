#!/usr/bin/env python3
import json
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

from crawl_fire_smoke_candidates import BKTree, commons_thumb_url, dhash64, license_allowed, load_seed_file
from label_fire_smoke_candidates_qwen import extract_json, normalize_boxes


class FireSmokeWebPipelineTest(unittest.TestCase):
    def test_license_gate(self):
        self.assertTrue(license_allowed("CC BY-SA 4.0"))
        self.assertTrue(license_allowed("Public domain"))
        self.assertTrue(license_allowed("CC0 1.0"))
        self.assertFalse(license_allowed("all rights reserved"))
        self.assertFalse(license_allowed(""))

    def test_seed_file_requires_http_image_url_shape(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "seeds.json"
            path.write_text(json.dumps({"items": [
                {"url": "https://example.test/fire.jpg", "license": "CC0", "bucket": "fire"},
                {"url": "file:///etc/passwd", "license": "CC0"},
            ]}), encoding="utf-8")
            rows = load_seed_file(path)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["bucket"], "fire")

    def test_dhash_and_bktree_find_near_duplicate(self):
        image = Image.new("RGB", (32, 32), "black")
        for x in range(16, 32):
            for y in range(32):
                image.putpixel((x, y), (255, 255, 255))
        value = dhash64(image)
        tree = BKTree()
        tree.add(value)
        self.assertTrue(tree.has_within(value, 0))
        self.assertTrue(tree.has_within(value ^ 0b11, 2))
        self.assertFalse(tree.has_within(value ^ ((1 << 20) - 1), 4))

    def test_commons_download_uses_non_cdn_thumb_endpoint(self):
        url = commons_thumb_url(
            "https://commons.wikimedia.org/w/api.php",
            "File:Eastern Market Fire, 4.30.07.jpg",
            1280,
        )
        self.assertTrue(url.startswith("https://commons.wikimedia.org/w/thumb.php?"))
        self.assertIn("w=1280", url)
        self.assertNotIn("upload.wikimedia.org", url)

    def test_qwen_box_filter_keeps_strong_fire_and_rejects_fog(self):
        boxes = normalize_boxes([
            ["fire", 100, 100, 300, 400, 0.93, "actual_orange_flame_with_luminous_core"],
            ["smoke", 10, 10, 900, 900, 0.99, "fog_cloud_haze"],
            ["smoke", 200, 100, 700, 800, 0.91, "coherent_rising_smoke_plume"],
            ["fire", 200, 200, 210, 210, 0.50, "actual_flame"],
        ])
        self.assertEqual([item["class_name"] for item in boxes], ["fire", "smoke"])

    def test_json_extraction_handles_fence(self):
        parsed = extract_json('```json\n{"q":"good","b":[]}\n```')
        self.assertEqual(parsed, {"q": "good", "b": []})

    def test_json_extraction_uses_last_complete_object(self):
        parsed = extract_json('<think>{"draft":true}</think>\n{"q":"good","scene":"hard_negative","b":[]}')
        self.assertEqual(parsed["scene"], "hard_negative")


if __name__ == "__main__":
    unittest.main()
