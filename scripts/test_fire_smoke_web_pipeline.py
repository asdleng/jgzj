#!/usr/bin/env python3
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

from crawl_fire_smoke_candidates import (
    BKTree,
    DownloadDeadlineExceeded,
    bucket_has_capacity,
    commons_candidates,
    commons_mime_allowed,
    commons_thumb_url,
    dhash64,
    download_deadline,
    license_allowed,
    load_seed_file,
    title_series_key,
)
from label_fire_smoke_candidates_qwen import apply_review_guards, extract_json, normalize_boxes


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

    def test_commons_mime_gate_keeps_photos_only(self):
        self.assertTrue(commons_mime_allowed("image/jpeg"))
        self.assertTrue(commons_mime_allowed("image/png"))
        self.assertFalse(commons_mime_allowed("audio/wav"))
        self.assertFalse(commons_mime_allowed("image/svg+xml"))
        self.assertFalse(commons_mime_allowed("image/gif"))

    def test_daily_commons_options_and_bucket_cap_are_propagated(self):
        class Response:
            def raise_for_status(self):
                return None

            def json(self):
                return {
                    "query": {"pages": [{
                        "pageid": 1,
                        "title": "File:Recent fire.jpg",
                        "imageinfo": [{
                            "url": "https://upload.wikimedia.org/recent.jpg",
                            "descriptionurl": "https://commons.wikimedia.org/wiki/File:Recent_fire.jpg",
                            "width": 1200,
                            "height": 800,
                            "mime": "image/jpeg",
                            "extmetadata": {"LicenseShortName": {"value": "CC BY 4.0"}},
                        }],
                    }]},
                }

        class Session:
            def __init__(self):
                self.params = None

            def get(self, _url, params, timeout):
                self.params = params
                self.timeout = timeout
                return Response()

        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "daily.json"
            config.write_text(json.dumps({
                "queries": [{
                    "bucket": "fire_building",
                    "category": "Burning buildings",
                    "limit": 1,
                    "max_accept": 5,
                    "category_sort": "timestamp",
                    "category_direction": "descending",
                }],
            }), encoding="utf-8")
            session = Session()
            rows = list(commons_candidates(session, config, (3, 7)))
        self.assertEqual(rows[0]["max_accept"], 5)
        self.assertEqual(session.params["gcmsort"], "timestamp")
        self.assertEqual(session.params["gcmdir"], "descending")
        self.assertTrue(bucket_has_capacity(rows[0], {"fire_building": 4}))
        self.assertFalse(bucket_has_capacity(rows[0], {"fire_building": 5}))

    def test_title_series_key_groups_numbered_event_photos(self):
        first = title_series_key("File:House fire in Waikanae, 16 May 2026, P 09.jpg")
        later = title_series_key("File:House fire in Waikanae, 16 May 2026, P 30.jpg")
        other = title_series_key("File:Structure Fire in Union, Mississippi 04.jpg")
        self.assertEqual(first, later)
        self.assertNotEqual(first, other)
        self.assertEqual(title_series_key("File:Fire 01.jpg"), "")

    def test_download_deadline_interrupts_trickle_stream(self):
        with self.assertRaises(DownloadDeadlineExceeded):
            with download_deadline(0.01):
                time.sleep(0.05)

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

    def test_hard_negative_positive_is_quarantined(self):
        labels = [{"class_name": "smoke"}]
        kept, scene, reason = apply_review_guards(labels, "positive", "hard_negative_steam")
        self.assertEqual(kept, [])
        self.assertEqual(scene, "needs_human")
        self.assertEqual(reason, "positive_in_hard_negative_bucket")

    def test_positive_without_strict_box_is_quarantined(self):
        kept, scene, reason = apply_review_guards([], "positive", "smoke_positive")
        self.assertEqual((kept, scene, reason), ([], "needs_human", "positive_without_accepted_box"))

    def test_off_domain_media_is_unusable(self):
        labels = [{"class_name": "smoke"}]
        kept, scene, reason = apply_review_guards(labels, "unusable", "smoke_positive")
        self.assertEqual((kept, scene, reason), ([], "unusable", "off_domain_or_non_photo"))


if __name__ == "__main__":
    unittest.main()
