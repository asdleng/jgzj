#!/usr/bin/env python3
import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "build_green_tree_assets.py"
SPEC = importlib.util.spec_from_file_location("green_tree_assets", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def sample(identifier, date, latitude, longitude, heading, camera="camera4"):
    return {
        "sample_id": identifier,
        "source": MODULE.SOURCE,
        "vehicle_id": "BIT-0042",
        "collected_at": f"{date}T08:00:00.000Z",
        "position": {
            "gaode_latitude": latitude,
            "gaode_longitude": longitude,
            "heading": heading,
        },
        "frames": [{"camera_id": camera, "image_path": f"{identifier}.jpg", "image_url": f"/api/park-pcm/crowd/files/{identifier}.jpg"}],
    }


class GreenTreeAssetsTest(unittest.TestCase):
    def test_angle_difference_wraps(self):
        self.assertLess(MODULE.angle_difference(3.13, -3.13), 0.03)

    def test_select_jobs_requires_position_and_heading_agreement(self):
        rows = [
            sample("today", "2026-07-21", 22.5, 114.2, 0.1),
            sample("day20-good", "2026-07-20", 22.500001, 114.200001, 0.11),
            sample("day19-good", "2026-07-19", 22.500002, 114.200001, 0.09),
            sample("day18-bad-heading", "2026-07-18", 22.500001, 114.200001, 1.0),
            sample("day18-good", "2026-07-18", 22.500003, 114.200001, 0.12),
        ]
        inspections = [{
            "sample_id": "today",
            "vehicle_id": "BIT-0042",
            "collected_at": "2026-07-21T08:00:00.000Z",
            "vegetation_types": {"trees": True},
            "view_assessments": [{"camera_id": "camera4", "vegetation_visible": True, "vegetation_types": {"trees": True}}],
        }]
        jobs, latest = MODULE.select_jobs(rows, inspections, 4, 2, 5, 10)
        self.assertEqual(latest, "2026-07-21")
        self.assertEqual(len(jobs), 1)
        self.assertEqual([item["sample"]["sample_id"] for item in jobs[0]["dates"]], ["today", "day20-good", "day19-good", "day18-good"])

    def test_normalize_tracks_keeps_only_valid_unique_dates(self):
        payload = {"tracks": [{
            "track_id": "T001",
            "asset_kind": "individual_tree",
            "confidence": "high",
            "signature": "stable trunk",
            "observations": [
                {"date": "2026-07-21", "bbox": [10, 20, 300, 900], "root": [150, 900]},
                {"date": "2026-07-21", "bbox": [10, 20, 300, 900], "root": [150, 900]},
                {"date": "2026-07-20", "bbox": [300, 20, 10, 900], "root": [150, 900]},
                {"date": "2026-07-19", "bbox": [12, 22, 302, 902], "root": [152, 902]},
            ],
        }]}
        tracks = MODULE.normalize_tracks(payload, {"2026-07-21", "2026-07-20", "2026-07-19"})
        self.assertEqual(len(tracks), 1)
        self.assertEqual([item["date"] for item in tracks[0]["observations"]], ["2026-07-21", "2026-07-19"])

    def test_asset_id_is_stable(self):
        anchor = sample("today", "2026-07-21", 22.5, 114.2, 0.1)
        job = {"anchor": anchor, "camera_id": "camera4"}
        self.assertEqual(MODULE.asset_id(job, [450, 800]), MODULE.asset_id(job, [450, 800]))
        self.assertTrue(MODULE.asset_id(job, [450, 800]).startswith("TREE-0042-"))

    def test_summary_counts_multi_day_assets(self):
        state = {"assets": {
            "A": {"status": "auto_matched", "review_status": "unreviewed", "observation_count": 4, "day_count": 4},
            "B": {"status": "auto_matched", "review_status": "confirmed", "observation_count": 3, "day_count": 1},
        }}
        summary = MODULE.summarize(state)
        self.assertEqual(summary["asset_count"], 2)
        self.assertEqual(summary["observation_count"], 7)
        self.assertEqual(summary["multi_day_count"], 1)


if __name__ == "__main__":
    unittest.main()
