import sys
import unittest
from pathlib import Path
from unittest.mock import patch


TEST_PARENT = Path(__file__).resolve().parents[1]
SCRIPT_ROOT = TEST_PARENT if (TEST_PARENT / "daily_yolo_closed_loop_training.py").exists() else TEST_PARENT / "scripts"
sys.path.insert(0, str(SCRIPT_ROOT))

from daily_yolo_closed_loop_training import (  # noqa: E402
    CN_TZ,
    all_candidate_days,
    choose_tasks,
)


PET_TASK = {
    "task_id": "pet_yolo",
    "build_task": "pet",
    "classes": {"pet"},
    "min_boxes": 2,
    "min_positive_images": 2,
}


class DailyYoloClosedLoopTrainingTest(unittest.TestCase):
    def test_all_candidate_days_uses_every_index_day(self):
        fake_now = __import__("datetime").datetime(2026, 7, 17, 18, tzinfo=CN_TZ)
        with patch("daily_yolo_closed_loop_training.cn_now", return_value=fake_now):
            days = all_candidate_days(
                {"20260601": {}, "20260716": {}, "20260717": {}},
                "00000000",
                0,
            )
        self.assertEqual(days, ["20260601", "20260716", "20260717"])

    def test_all_date_mode_aggregates_all_pending_dates(self):
        stats = {
            "20260701": {
                "eligible_images": 2,
                "positive_images_by_task": {"pet_yolo": 1},
                "negative_images_by_task": {"pet_yolo": 1},
                "boxes_by_task": {"pet_yolo": 1},
            },
            "20260702": {
                "eligible_images": 2,
                "positive_images_by_task": {"pet_yolo": 1},
                "negative_images_by_task": {"pet_yolo": 1},
                "boxes_by_task": {"pet_yolo": 1},
            },
        }
        selected, skipped = choose_tasks(
            stats,
            sorted(stats),
            {"task_dates": {"pet_yolo": {"20260701": {"status": "completed"}}}},
            1,
            1,
            [PET_TASK],
            aggregate_all_dates=True,
        )
        self.assertEqual(skipped, [])
        self.assertEqual(selected[0]["target_dates"], ["20260702"])
        self.assertEqual(selected[0]["train_dates"], ["20260701", "20260702"])
        self.assertEqual(selected[0]["positive_images"], 2)


if __name__ == "__main__":
    unittest.main()
