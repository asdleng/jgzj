#!/usr/bin/env python3
import importlib.util
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


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
    def test_dense_patrol_defaults_cover_two_meter_capture_spacing(self):
        args = MODULE.parse_args([])
        self.assertEqual(args.max_anchors, 32)
        self.assertEqual(args.max_jobs, 40)
        self.assertEqual(args.anchor_separation_m, 2.0)

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

    def test_select_jobs_keeps_older_history_when_one_date_has_no_nearby_sample(self):
        rows = [
            sample("today", "2026-07-21", 22.5, 114.2, 0.1),
            sample("day20-good", "2026-07-20", 22.500001, 114.200001, 0.11),
            sample("day19-far", "2026-07-19", 22.51, 114.21, 0.1),
            sample("day18-good", "2026-07-18", 22.500002, 114.200001, 0.09),
            sample("day17-good", "2026-07-17", 22.500003, 114.200001, 0.12),
        ]
        inspections = [{
            "sample_id": "today",
            "vehicle_id": "BIT-0042",
            "collected_at": "2026-07-21T08:00:00.000Z",
            "vegetation_types": {"trees": True},
            "view_assessments": [{"camera_id": "camera4", "vegetation_visible": True, "vegetation_types": {"trees": True}}],
        }]
        jobs, latest = MODULE.select_jobs(rows, inspections, 4, 2, 5, 10, history_days=8)
        self.assertEqual(latest, "2026-07-21")
        self.assertEqual(len(jobs), 1)
        self.assertEqual(
            [item["sample"]["sample_id"] for item in jobs[0]["dates"]],
            ["today", "day20-good", "day18-good", "day17-good"],
        )

    def test_select_jobs_follows_each_previous_position_instead_of_latest_anchor(self):
        rows = [
            sample("today", "2026-07-21", 22.5, 114.2, 0.1),
            sample("day20-step4m", "2026-07-20", 22.500036, 114.2, 0.1),
            sample("day19-step4m", "2026-07-19", 22.500072, 114.2, 0.1),
        ]
        inspections = [{
            "sample_id": "today",
            "vehicle_id": "BIT-0042",
            "collected_at": "2026-07-21T08:00:00.000Z",
            "vegetation_types": {"trees": True},
            "view_assessments": [{"camera_id": "camera4", "vegetation_visible": True, "vegetation_types": {"trees": True}}],
        }]
        jobs, _ = MODULE.select_jobs(rows, inspections, 4, 2, 5, 10)
        self.assertEqual(len(jobs), 1)
        dates = jobs[0]["dates"]
        self.assertEqual([item["sample"]["sample_id"] for item in dates], ["today", "day20-step4m", "day19-step4m"])
        self.assertLess(dates[2]["step_distance_m"], 5)
        self.assertGreater(dates[2]["anchor_distance_m"], 5)
        self.assertEqual(dates[2]["reference_date"], "2026-07-20")

    def test_select_jobs_uses_nearest_position_with_heading_as_a_gate(self):
        rows = [
            sample("today", "2026-07-21", 22.5, 114.2, 0.0),
            sample("day20-nearest", "2026-07-20", 22.500009, 114.2, 0.157),
            sample("day20-farther", "2026-07-20", 22.500018, 114.2, 0.0),
            sample("day19", "2026-07-19", 22.500009, 114.2, 0.157),
        ]
        inspections = [{
            "sample_id": "today",
            "vehicle_id": "BIT-0042",
            "collected_at": "2026-07-21T08:00:00.000Z",
            "vegetation_types": {"trees": True},
            "view_assessments": [{"camera_id": "camera4", "vegetation_visible": True, "vegetation_types": {"trees": True}}],
        }]
        jobs, _ = MODULE.select_jobs(rows, inspections, 4, 2, 5, 10)
        self.assertEqual(jobs[0]["dates"][1]["sample"]["sample_id"], "day20-nearest")

    def test_geometry_validation_compares_adjacent_dates(self):
        track = {"observations": [
            {"date": "2026-07-21", "root_1000": [500, 500]},
            {"date": "2026-07-20", "root_1000": [500, 500]},
            {"date": "2026-07-19", "root_1000": [500, 500]},
        ]}
        job = {"dates": [
            {"date": date, "frame": {"image_path": f"{date}.jpg"}}
            for date in ("2026-07-21", "2026-07-20", "2026-07-19")
        ]}
        args = SimpleNamespace(
            min_days=3,
            frames_root=Path("/frames"),
            min_inliers=50,
            min_inlier_ratio=0.15,
            max_root_error=20,
        )
        metrics = {
            "matrix": MODULE.np.eye(3),
            "reference_shape": (100, 100, 3),
            "candidate_shape": (100, 100, 3),
            "good_matches": 100,
            "inliers": 80,
            "inlier_ratio": 0.8,
        }
        with patch.object(MODULE, "frame_path", side_effect=lambda _, frame: Path(frame["image_path"])), \
                patch.object(MODULE.cv2, "imread", side_effect=lambda path, _: path), \
                patch.object(MODULE, "homography_metrics", return_value=metrics) as homography:
            result = MODULE.validate_track_geometry(track, job, args)
        self.assertTrue(result["passed"])
        self.assertEqual(
            [(item["reference_date"], item["date"]) for item in result["pairs"]],
            [("2026-07-21", "2026-07-20"), ("2026-07-20", "2026-07-19")],
        )
        self.assertEqual(
            [call.args for call in homography.call_args_list],
            [("2026-07-21.jpg", "2026-07-20.jpg"), ("2026-07-20.jpg", "2026-07-19.jpg")],
        )

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

    def test_visible_tree_roots_require_full_visibility_and_root_inside_box(self):
        valid = [{"visibility": "full", "bbox_1000": [100, 20, 400, 900], "root_1000": [250, 900]}]
        partial = [{"visibility": "partial", "bbox_1000": [100, 20, 400, 900], "root_1000": [250, 900]}]
        outside = [{"visibility": "full", "bbox_1000": [100, 20, 400, 500], "root_1000": [250, 650]}]
        self.assertTrue(MODULE.has_visible_tree_roots(valid))
        self.assertFalse(MODULE.has_visible_tree_roots(partial))
        self.assertFalse(MODULE.has_visible_tree_roots(outside))

    def test_prune_invalid_assets_preserves_human_confirmed_records(self):
        state = {
            "assets": {
                "valid": {"review_status": "unreviewed", "observations": [{"visibility": "full", "bbox_1000": [0, 0, 100, 100], "root_1000": [50, 100]}]},
                "invalid": {"review_status": "unreviewed", "observations": [{"visibility": "partial", "bbox_1000": [0, 0, 100, 60], "root_1000": [50, 100]}]},
                "confirmed": {"review_status": "confirmed", "observations": [{"visibility": "partial", "bbox_1000": [0, 0, 100, 60], "root_1000": [50, 100]}]},
            },
            "rejected_tracks": [],
        }
        removed = MODULE.prune_invalid_unreviewed_assets(state)
        self.assertEqual(removed, ["invalid"])
        self.assertEqual(set(state["assets"]), {"valid", "confirmed"})
        self.assertEqual(state["rejected_tracks"][0]["geometry"]["reason"], "tree_root_not_visible_inside_bbox")

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
