from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "prepare_3dgs_colmap.py"
SPEC = importlib.util.spec_from_file_location("prepare_3dgs_colmap", MODULE_PATH)
PREPARE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(PREPARE)


def write_jsonl(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")


def transform(tx: float) -> list[float]:
    matrix = np.eye(4, dtype=float)
    matrix[0, 3] = tx
    return matrix.reshape(-1).tolist()


class MapVisualAdapterTest(unittest.TestCase):
    def make_package(self, root: Path, group_count: int = 110) -> Path:
        map_root = root / "map_visual"
        calibration_dir = map_root / "image_capture" / "calibration"
        calibration_dir.mkdir(parents=True)
        for camera_index in range(1, 5):
            model = "Fisheye" if camera_index in (3, 4) else "Pinhole"
            distortion_model = "equidistant" if camera_index in (3, 4) else "plumb_bob"
            (calibration_dir / f"camera{camera_index}.txt").write_text(
                "\n".join(
                    [
                        f"cam_model: {model}",
                        f"distortion_model: {distortion_model}",
                        "cam_width: 1920",
                        "cam_height: 1080",
                        "cam_fx: 510.0",
                        "cam_fy: 511.0",
                        "cam_cx: 960.0",
                        "cam_cy: 540.0",
                        "cam_d0: 0.1",
                        "cam_d1: -0.02",
                        "cam_d2: 0.003",
                        "cam_d3: -0.0004",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

        captures = []
        poses = []
        for group_id in range(group_count):
            timestamp_ns = 1_780_000_000_000_000_000 + group_id * 100_000_000
            capture_cameras = {}
            pose_cameras = {}
            for camera_index in range(1, 5):
                camera_name = f"camera{camera_index}"
                relative_path = f"images/{camera_name}/{group_id:06d}_{timestamp_ns}_{camera_name}.jpg"
                capture_cameras[camera_name] = {
                    "relative_path": relative_path,
                    "timestamp_ns": timestamp_ns,
                }
                pose_cameras[camera_name] = {
                    "image_path": relative_path,
                    "T_camera_map": transform(group_id + camera_index / 10.0),
                    "T_map_camera": transform(-(group_id + camera_index / 10.0)),
                }
            captures.append(
                {
                    "image_keyframe_id": group_id,
                    "image_timestamp_ns": timestamp_ns,
                    "cameras": capture_cameras,
                }
            )
            poses.append(
                {
                    "schema": "auto_ad_mapping_final_camera_poses.v1",
                    "image_keyframe_id": group_id,
                    "image_timestamp_ns": timestamp_ns,
                    "trajectory_query_timestamp_ns": timestamp_ns,
                    "trajectory_method": "dense_frontend_cubic_translation_so3_rotation_spline_with_final_pgo_correction_spline",
                    "cameras": pose_cameras,
                }
            )
        write_jsonl(map_root / "image_capture" / "image_keyframes.jsonl", captures)
        write_jsonl(map_root / "trajectories" / "camera_poses.jsonl", poses)
        return map_root

    def test_110_groups_expand_to_440_camera_major_records(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            map_root = self.make_package(Path(tmp))
            manifest, records = PREPARE.load_records(map_root)

        self.assertEqual(manifest["image_keyframe_groups"], 110)
        self.assertEqual(manifest["camera_pose_rows"], 440)
        self.assertEqual(len(records), 440)
        self.assertEqual({record["camera_id"] for record in records}, {"camera1", "camera2", "camera3", "camera4"})
        self.assertTrue(all(record["__map_visual_final_pose"] for record in records))
        self.assertTrue(all(record["camera_id"] == "camera1" for record in records[:110]))
        self.assertTrue(all(record["camera_id"] == "camera4" for record in records[-110:]))
        self.assertEqual(records[220]["distortion_model"], "equidistant")
        self.assertEqual(records[220]["camera_model"], "Fisheye")

    def test_final_pose_is_used_verbatim_and_legacy_offsets_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            map_root = self.make_package(Path(tmp), group_count=1)
            manifest, records = PREPARE.load_records(map_root)
        expected = np.asarray(records[0]["T_camera_map"], dtype=float).reshape(4, 4)
        actual, mode, gap = PREPARE.matrix_from_record(records[0], [], manifest, timestamp_offset_s=99.0)
        np.testing.assert_allclose(actual, expected, atol=0.0, rtol=0.0)
        self.assertEqual(mode, "map_visual_final_pgo_spline_pose")
        self.assertIsNone(gap)
        self.assertTrue(PREPARE.validate_pose_time_offsets(records, {}))
        with self.assertRaisesRegex(ValueError, "legacy pose time offsets"):
            PREPARE.validate_pose_time_offsets(records, {"camera1": 0.05})

    @unittest.skipIf(PREPARE.cv2 is None, "OpenCV is unavailable")
    def test_equidistant_calibration_uses_fisheye_undistortion(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.jpg"
            target = root / "target.jpg"
            array = np.zeros((48, 64, 3), dtype=np.uint8)
            array[:, :, 0] = np.arange(64, dtype=np.uint8)[None, :]
            array[:, :, 1] = np.arange(48, dtype=np.uint8)[:, None]
            Image.fromarray(array).save(source)
            result = PREPARE.undistort_or_copy(
                source,
                target,
                (64, 48, 40.0, 41.0, 32.0, 24.0, [0.1, -0.02, 0.003, -0.0004]),
                True,
                "keep-k",
                "equidistant",
            )
            self.assertTrue(target.is_file())
            with Image.open(target) as output_image:
                self.assertEqual(output_image.size, (64, 48))
            self.assertEqual(result[-1], "fisheye-keep-k")


if __name__ == "__main__":
    unittest.main()
