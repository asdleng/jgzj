#!/usr/bin/env python3
import csv
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path


PROJECT_ROOT = Path(os.environ.get("JGZJ_PROJECT_ROOT", "/home/admin1/jgzj"))
RUNTIME_ROOT = PROJECT_ROOT / ".runtime" / "yolo_model_service"
REGISTRY_PATH = Path(os.environ.get("YOLO_MODEL_REGISTRY_PATH", RUNTIME_ROOT / "model_registry.json"))
DOWNLOAD_ROOT = Path(os.environ.get("YOLO_MODEL_DOWNLOAD_ROOT", RUNTIME_ROOT / "downloads"))
TREND_STATIC_PATH = Path(os.environ.get("YOLO_MODEL_TREND_STATIC_PATH", PROJECT_ROOT / "dist" / "yolo-model-training-trends.json"))
TREND_PUBLIC_PATH = Path(os.environ.get("YOLO_MODEL_TREND_PUBLIC_PATH", PROJECT_ROOT / "public" / "yolo-model-training-trends.json"))
A100_HOST = os.environ.get("YOLO_A100_HOST", "192.168.80.49")
A100_USER = os.environ.get("YOLO_A100_USER", "sari")
A100_KEY = os.environ.get("YOLO_A100_KEY", "/home/admin1/a100_tunnel/jgzj_qwen36_proxy_ed25519")
POLL_INTERVAL = int(os.environ.get("YOLO_MONITOR_INTERVAL", "600"))
RUN_ONCE = os.environ.get("YOLO_MONITOR_ONCE", "").lower() in {"1", "true", "yes"}


TARGETS = {
    "person_yolo": {
        "title": "人员识别",
        "local_weight": str(RUNTIME_ROOT / "weights" / "person_yolo_best.pt"),
        "download_file": "person_yolo_best.pt",
        "score_metric": "test_map50_95",
        "metric_source_override": "same_dataset_test",
        "roots": [
            "/home/sari/jgzj_yolo_daily_closed_loop/runs/person_yolo",
            "/home/sari/jgzj_yolo_runs_reliable_vehicle_20260704",
            "/home/sari/jgzj_yolo_runs_person_v2",
            "/home/sari/jgzj_yolo_runs",
        ],
        "summary_roots": [
            "/home/sari/jgzj_yolo_daily_closed_loop/results/person_yolo",
            "/home/sari/reliable_vehicle_yolo_20260704/results/person_yolo_today_finetune_gpu5",
            "/home/sari/reliable_vehicle_yolo_20260704/results/person_yolo_today_alt_gpu5",
            "/home/sari/person_yolo_experiments_20260627",
        ],
        "trend_roots": [
            "/home/sari/jgzj_yolo_daily_closed_loop/runs/person_yolo",
        ],
        "trend_summary_roots": [
            "/home/sari/jgzj_yolo_daily_closed_loop/results/person_yolo",
        ],
        "trend_keywords": ["person_yolo", "daily"],
        "keywords": ["person_yolo"],
    },
    "vehicle_yolo": {
        "title": "车辆识别",
        "local_weight": str(RUNTIME_ROOT / "weights" / "general_yolo_best.pt"),
        "download_file": "vehicle_yolo_best.pt",
        "static_only": True,
        "static_model_family": "yolo11s",
        "static_metric_source": "same_dataset_test",
        "static_metrics": {
            "val_precision": 0.6650830800337092,
            "val_recall": 0.8250715990536199,
            "val_map50": 0.8140799307537149,
            "val_map50_95": 0.7370322425732191,
            "test_precision": 0.6587368972839047,
            "test_recall": 0.8379187923426263,
            "test_map50": 0.8145421374404708,
            "test_map50_95": 0.727007523759614,
        },
        "static_note": "车辆识别：2026-07-04 使用 20260703 车端可靠自采框增量微调；同一新混合数据集上优于旧 yolo11s（旧 test P/R/mAP50/mAP50-95=0.678/0.792/0.797/0.722，新=0.659/0.838/0.815/0.727），优先保召回。",
        "roots": [
            "/home/sari/jgzj_yolo_runs_reliable_vehicle_20260704",
            "/home/sari/jgzj_yolo_runs_vehicle",
            "/home/sari/jgzj_yolo_runs",
        ],
        "summary_roots": [
            "/home/sari/reliable_vehicle_yolo_20260704/results/vehicle_yolo_today_finetune_gpu3",
            "/home/sari/reliable_vehicle_yolo_20260704/results/vehicle_yolo_today_alt_gpu3",
            "/home/sari/vehicle_yolo_experiments_20260627",
        ],
        "trend_roots": [
            "/home/sari/jgzj_yolo_daily_closed_loop/runs/vehicle_yolo",
        ],
        "trend_summary_roots": [
            "/home/sari/jgzj_yolo_daily_closed_loop/results/vehicle_yolo",
        ],
        "trend_keywords": ["vehicle_yolo", "daily"],
        "keywords": ["vehicle_yolo"],
    },
    "pet_yolo": {
        "title": "宠物识别",
        "local_weight": str(RUNTIME_ROOT / "weights" / "pet_yolo_best.pt"),
        "download_file": "pet_yolo_best.pt",
        "roots": [
            "/home/sari/jgzj_yolo_runs_pet_public",
            "/home/sari/jgzj_yolo_runs",
        ],
        "summary_roots": [
            "/home/sari/pet_yolo_experiments_20260627",
        ],
        "trend_roots": [
            "/home/sari/jgzj_yolo_daily_closed_loop/runs/pet_yolo",
            "/home/sari/jgzj_public_yolo_training_20260705/runs",
        ],
        "trend_summary_roots": [
            "/home/sari/jgzj_yolo_daily_closed_loop/results/pet_yolo",
            "/home/sari/jgzj_public_yolo_training_20260705/reports",
        ],
        "trend_keywords": ["pet_public", "pet_yolo", "pet"],
        "keywords": ["pet_public", "pet_yolo"],
    },
    "phone_yolo": {
        "title": "手机识别",
        "local_weight": str(RUNTIME_ROOT / "weights" / "phone_yolo_best.pt"),
        "download_file": "phone_yolo_best.pt",
        "static_only": True,
        "static_model_family": "yolov8n",
        "static_metric_source": "current_workbench_weight",
        "static_metrics": {},
        "static_note": "手机识别当前作为拆分模型使用；public-data 微调结果只进入每日指标，不自动覆盖线上权重。",
        "trend_roots": [
            "/home/sari/jgzj_yolo_daily_closed_loop/runs/phone_yolo",
            "/home/sari/jgzj_public_yolo_training_20260705/runs",
            "/home/sari/jgzj_yolo_runs",
        ],
        "trend_summary_roots": [
            "/home/sari/jgzj_yolo_daily_closed_loop/results/phone_yolo",
            "/home/sari/jgzj_public_yolo_training_20260705/reports",
        ],
        "trend_keywords": ["phone_public", "phone_yolo", "phone"],
    },
    "trash_yolo": {
        "title": "小垃圾细类",
        "local_weight": str(RUNTIME_ROOT / "weights" / "trash_yolo_best.pt"),
        "download_file": "trash_yolo_best.pt",
        "static_only": True,
        "static_model_family": "yolov8n",
        "static_metric_source": "test",
        "static_metrics": {
            "test_precision": 0.7201050268566747,
            "test_recall": 0.7095351158444563,
            "test_map50": 0.6845818411480962,
            "test_map50_95": 0.5485041573662384,
            "val_precision": 0.8018272739404084,
            "val_recall": 0.7280740060148725,
            "val_map50": 0.8139286930254652,
            "val_map50_95": 0.6546211031665546,
        },
        "static_note": "小垃圾细类：bottle / box / paper / bag；2026-06-27 server-proxy GPU2 重训，按独立 test 稳定性选用 yolov8n。",
        "roots": [],
        "summary_roots": [],
        "trend_roots": [
            "/home/sari/jgzj_yolo_daily_closed_loop/runs/trash_yolo",
            "/home/sari/jgzj_public_yolo_training_20260705/runs",
        ],
        "trend_summary_roots": [
            "/home/sari/jgzj_yolo_daily_closed_loop/results/trash_yolo",
            "/home/sari/jgzj_public_yolo_training_20260705/reports",
        ],
        "trend_keywords": ["trash_public", "trash_yolo", "trash"],
        "keywords": [],
    },
    "stall_yolo": {
        "title": "摆摊识别",
        "local_weight": str(RUNTIME_ROOT / "weights" / "stall_yolo_best.pt"),
        "download_file": "stall_yolo_best.pt",
        "static_only": True,
        "static_model_family": "yolov8n",
        "static_metric_source": "current_workbench_weight",
        "static_metrics": {},
        "static_note": "摆摊识别当前作为拆分模型使用；public-data 微调结果只进入每日指标，不自动覆盖线上权重。",
        "trend_roots": [
            "/home/sari/jgzj_yolo_daily_closed_loop/runs/stall_yolo",
            "/home/sari/jgzj_public_yolo_training_20260705/runs",
            "/home/sari/jgzj_yolo_runs",
        ],
        "trend_summary_roots": [
            "/home/sari/jgzj_yolo_daily_closed_loop/results/stall_yolo",
            "/home/sari/jgzj_public_yolo_training_20260705/reports",
        ],
        "trend_keywords": ["stall_public", "stall_yolo", "stall"],
    },
    "fire_smoke_yolo": {
        "title": "火源烟雾",
        "local_weight": str(RUNTIME_ROOT / "weights" / "fire_smoke_yolo_fire_other_edge_remaining_gpu2_20260713.pt"),
        "download_file": "fire_smoke_yolo_fire_other_edge_remaining_gpu2_20260713.pt",
        "static_only": True,
        "static_status": "trained",
        "static_model_family": "yolo12s_fire_other_edge_remaining_gpu2",
        "static_metric_source": "fire_other_edge_test",
        "static_source_run": "/home/admin1/jgzj/.runtime/yolo_loop/runs/fire_smoke_yolo_fire_other_edge_remaining_gpu2_20260713_1052",
        "static_best_weight": "/home/admin1/jgzj/.runtime/yolo_loop/runs/fire_smoke_yolo_fire_other_edge_remaining_gpu2_20260713_1052/weights/best.pt",
        "static_metrics": {
            "test_precision": 0.6764,
            "test_recall": 0.5256,
            "test_map50": 0.5910,
            "test_map50_95": 0.3543,
        },
        "static_training_trends": [
            {
                "day": "2026-07-13",
                "task_id": "fire_smoke_yolo",
                "model_family": "yolo12s_fire_other_edge_ft_sample12000_gpu2",
                "status": "completed",
                "metric_source": "fire_other_edge_test",
                "score": 0.31436,
                "test_precision": 0.65657,
                "test_recall": 0.50785,
                "test_map50": 0.55532,
                "test_map50_95": 0.31436,
                "val_precision": None,
                "val_recall": None,
                "val_map50": None,
                "val_map50_95": None,
                "started_at": "2026-07-13T10:14:16.922791+08:00",
                "finished_at": "2026-07-13T10:33:31.142821+08:00",
                "source_run": "/home/admin1/jgzj/.runtime/yolo_loop/runs/fire_smoke_yolo_fire_other_edge_ft_sample12000_gpu2_20260713_101414",
                "best_weight": "/home/admin1/jgzj/.runtime/yolo_loop/runs/fire_smoke_yolo_fire_other_edge_ft_sample12000_gpu2_20260713_101414/weights/best.pt",
                "run_count": 1,
            },
            {
                "day": "2026-07-13",
                "task_id": "fire_smoke_yolo",
                "model_family": "yolo12s_fire_other_edge_remaining_gpu2",
                "status": "completed",
                "metric_source": "fire_other_edge_test",
                "score": 0.35435,
                "test_precision": 0.67643,
                "test_recall": 0.52560,
                "test_map50": 0.59095,
                "test_map50_95": 0.35435,
                "val_precision": None,
                "val_recall": None,
                "val_map50": None,
                "val_map50_95": None,
                "started_at": "2026-07-13T11:29:15.689664+08:00",
                "finished_at": "2026-07-13T11:55:35.146363+08:00",
                "source_run": "/home/admin1/jgzj/.runtime/yolo_loop/runs/fire_smoke_yolo_fire_other_edge_remaining_gpu2_20260713_1052",
                "best_weight": "/home/admin1/jgzj/.runtime/yolo_loop/runs/fire_smoke_yolo_fire_other_edge_remaining_gpu2_20260713_1052/weights/best.pt",
                "run_count": 1,
            }
        ],
        "static_note": "2026-07-13 基于当前 yolo12s 火源烟雾权重，先用 fire_other_edge 固定抽样 12000 条微调 3 epoch，再用剩余 47914 条在物理 GPU 2 续训 1 epoch；指标为原始 fire_other_edge test split，P/R 较上一轮提升。",
        "roots": [
            "/home/sari/jgzj_yolo_runs_new_arch",
            "/home/sari/jgzj_yolo_runs_new_arch_parallel",
            "/home/sari/jgzj_yolo_runs_new_arch_parallel_yolo12n",
            "/home/sari/jgzj_yolo_runs",
        ],
        "summary_roots": [
            "/home/sari/yolo_new_arch_experiments_20260626",
        ],
        "trend_roots": [
            "/home/sari/jgzj_yolo_daily_closed_loop/runs/fire_smoke_yolo",
        ],
        "trend_summary_roots": [
            "/home/sari/jgzj_yolo_daily_closed_loop/results/fire_smoke_yolo",
        ],
        "trend_keywords": ["fire_smoke_yolo", "daily"],
        "keywords": ["fire", "smoke", "yolo12s"],
    },
    "person_behavior_cls": {
        "title": "人员行为分类",
        "local_weight": str(RUNTIME_ROOT / "weights" / "person_behavior_cls_best.pt"),
        "download_file": "person_behavior_cls_best.pt",
        "static_only": True,
        "static_model_family": "yolov8n-cls",
        "static_metric_source": "test",
        "static_metrics": {
            "test_top1": 0.9000,
            "other_precision": 0.8738,
            "other_recall": 0.8824,
            "phone_use_precision": 0.8776,
            "phone_use_recall": 0.9348,
            "smoking_precision": 0.9297,
            "smoking_recall": 0.9015,
        },
        "static_note": "二阶段人员行为分类：other / phone_use / smoking；用于人员ROI分类。",
        "roots": [],
        "summary_roots": [],
        "keywords": [],
    },
    "license_plate_yolo": {
        "title": "车牌检测",
        "local_weight": str(RUNTIME_ROOT / "weights" / "license_plate_yolo_best.pt"),
        "download_file": "license_plate_yolo_best.pt",
        "static_only": True,
        "static_model_family": "yolov8n",
        "static_metric_source": "test",
        "static_metrics": {
            "test_precision": 0.9973948500035746,
            "test_recall": 0.9991503823279524,
            "test_map50": 0.9943430034129691,
            "test_map50_95": 0.9160720233988353,
            "val_precision": 1.0,
            "val_recall": 1.0,
            "val_map50": 0.995,
            "val_map50_95": 0.923,
        },
        "static_note": "中国车牌检测：CCPD2020 绿牌数据训练；工作台车牌识别链路为车辆YOLO -> 车牌YOLO -> OCR。",
        "roots": [],
        "summary_roots": [],
        "keywords": [],
    },
    "fishing_rod_yolo": {
        "title": "钓鱼杆识别",
        "local_weight": str(RUNTIME_ROOT / "weights" / "fishing_rod_yolo_best.pt"),
        "download_file": "fishing_rod_yolo_best.pt",
        "static_only": True,
        "static_model_family": "yolo11s",
        "static_metric_source": "test",
        "static_metrics": {
            "test_precision": 0.5549598053222129,
            "test_recall": 0.5028591603796797,
            "test_map50": 0.4188674051397284,
            "test_map50_95": 0.21177929350877508,
            "val_precision": 0.5438857488382396,
            "val_recall": 0.5333333333333333,
            "val_map50": 0.4653067746732705,
            "val_map50_95": 0.26120290601865953,
        },
        "static_note": "钓鱼杆种子模型：Objects365/LVIS公开鱼竿框 + 现场钓鱼NO负样本；需结合人员检测与水边ROI规则使用。",
        "roots": [],
        "summary_roots": [],
        "keywords": [],
    },
}


COLLECTOR = r"""
import csv, json, os, re, time
from datetime import datetime, timedelta, timezone
from pathlib import Path

targets = json.loads(os.environ["YOLO_TARGETS_JSON"])

def fnum(value):
    try:
        if value is None or value == "":
            return None
        return float(value)
    except Exception:
        return None

def norm(row):
    return {str(k).strip(): str(v).strip() for k, v in dict(row or {}).items()}

def model_family_from_text(text):
    value = str(text or "").lower()
    for name in ["yolo26s", "yolo26n", "yolo12s", "yolo12n", "yolo11s", "yolo11n", "yolov8s", "yolov8n"]:
        if name in value:
            return name
    return ""

def summary_task_matches(task_id, declared_task):
    declared = str(declared_task or "").strip().lower()
    if not declared:
        return True
    accepted = {task_id.lower()}
    if task_id.endswith("_yolo"):
        accepted.add(task_id[:-5].lower())
    return declared in accepted

def candidate_from_summary_json(task_id, cfg, path):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not summary_task_matches(task_id, data.get("task_id") or data.get("task")):
        return None
    best_weight = str(data.get("best") or data.get("best_weight") or "")
    if not best_weight or not Path(best_weight).exists():
        return None
    best_row = norm(data.get("best_epoch_metrics") or data.get("last_epoch_metrics") or {})
    last_row = norm(data.get("last_epoch_metrics") or best_row)
    metrics = {
        "val_precision": fnum(best_row.get("metrics/precision(B)") or best_row.get("precision")),
        "val_recall": fnum(best_row.get("metrics/recall(B)") or best_row.get("recall")),
        "val_map50": fnum(best_row.get("metrics/mAP50(B)") or best_row.get("map50")),
        "val_map50_95": fnum(best_row.get("metrics/mAP50-95(B)") or best_row.get("map50_95")),
    }
    score_metric = cfg.get("score_metric")
    score = metrics.get(score_metric) if score_metric else metrics.get("val_map50_95")
    epoch_value = fnum(last_row.get("epoch"))
    total_epochs = fnum(data.get("epochs"))
    mtime = path.stat().st_mtime
    return {
        "task_id": task_id,
        "title": cfg.get("title", task_id),
        "status": "completed" if data.get("status") == "ok" else (data.get("status") or "unknown"),
        "model_family": model_family_from_text(data.get("run_dir") or best_weight) or Path(best_weight).stem,
        "source": "summary_json",
        "summary_path": str(path),
        "source_run": str(data.get("run_dir") or ""),
        "best_weight": best_weight,
        "metrics": metrics,
        "score": score if score is not None else -1,
        "metric_source": cfg.get("metric_source_override") or "val",
        "train_seconds": fnum(data.get("train_seconds")),
        "started_at": data.get("started_at", ""),
        "finished_at": data.get("finished_at", "") or datetime.fromtimestamp(mtime, timezone.utc).isoformat(),
        "train_progress": {
            "epoch": int(epoch_value) + 1 if epoch_value is not None else None,
            "total_epochs": int(total_epochs) if total_epochs is not None else None,
        },
        "mtime": mtime,
    }

def summary_candidates(task_id, cfg, root_key="summary_roots"):
    out = []
    for root in cfg.get(root_key, []):
        base = Path(root)
        if not base.exists():
            continue
        summary_paths = []
        direct = base / "summary.csv"
        if direct.exists():
            summary_paths.append(direct)
        summary_paths.extend(base.glob("results*/summary.csv"))
        summary_paths.extend(base.glob("*/summary.csv"))
        json_summary_paths = []
        json_summary_paths.extend(base.glob("*.summary.json"))
        json_summary_paths.extend(base.glob("results*/*.summary.json"))
        json_summary_paths.extend(base.glob("*/*.summary.json"))
        seen = set()
        for path in summary_paths:
            if path in seen:
                continue
            seen.add(path)
            try:
                rows = list(csv.DictReader(path.open()))
            except Exception:
                continue
            for row in rows:
                row = norm(row)
                if not summary_task_matches(task_id, row.get("task_id") or row.get("task")):
                    continue
                status = row.get("status", "")
                best_weight = row.get("best_weight", "")
                if not best_weight or not Path(best_weight).exists():
                    continue
                metrics = {
                    "test_precision": fnum(row.get("test_precision")),
                    "test_recall": fnum(row.get("test_recall")),
                    "test_map50": fnum(row.get("test_map50")),
                    "test_map50_95": fnum(row.get("test_map50_95")),
                    "val_precision": fnum(row.get("val_precision")),
                    "val_recall": fnum(row.get("val_recall")),
                    "val_map50": fnum(row.get("val_map50")),
                    "val_map50_95": fnum(row.get("val_map50_95")),
                }
                model = row.get("model") or model_family_from_text(best_weight)
                score_metric = cfg.get("score_metric")
                if score_metric:
                    score = metrics.get(score_metric)
                    metric_source = cfg.get("metric_source_override") or score_metric.split("_", 1)[0]
                else:
                    score = metrics.get("test_map50_95") or metrics.get("val_map50_95") or -1
                    metric_source = "test" if metrics.get("test_map50_95") is not None else "val"
                out.append({
                    "task_id": task_id,
                    "title": cfg.get("title", task_id),
                    "status": "completed" if status == "ok" else (status or "unknown"),
                    "model_family": model,
                    "source": "summary",
                    "summary_path": str(path),
                    "source_run": row.get("run_dir", ""),
                    "best_weight": best_weight,
                    "metrics": metrics,
                    "score": score if score is not None else -1,
                    "metric_source": metric_source,
                    "train_seconds": fnum(row.get("train_seconds")),
                    "started_at": row.get("started_at", ""),
                    "finished_at": row.get("finished_at", ""),
                })
        for path in json_summary_paths:
            if path in seen:
                continue
            seen.add(path)
            item = candidate_from_summary_json(task_id, cfg, path)
            if item:
                out.append(item)
    return out

def results_candidate(task_id, cfg, run):
    rpath = run / "results.csv"
    best_weight = run / "weights" / "best.pt"
    if not rpath.exists() or not best_weight.exists():
        return None
    try:
        rows = list(csv.DictReader(rpath.open()))
    except Exception:
        return None
    if not rows:
        return None
    parsed = [norm(row) for row in rows]
    def score_row(row):
        value = fnum(row.get("metrics/mAP50-95(B)"))
        return -1 if value is None else value
    best_row = max(parsed, key=score_row)
    last = parsed[-1]
    metrics = {
        "val_precision": fnum(best_row.get("metrics/precision(B)")),
        "val_recall": fnum(best_row.get("metrics/recall(B)")),
        "val_map50": fnum(best_row.get("metrics/mAP50(B)")),
        "val_map50_95": fnum(best_row.get("metrics/mAP50-95(B)")),
    }
    model = model_family_from_text(run.name)
    epochs_done = len(rows)
    mtime = rpath.stat().st_mtime
    # Treat old completed baselines as deployable when they reached the usual 80 epochs.
    # Partial runs are only "training" while results.csv is fresh; stale partial runs are kept for audit but not shown as active.
    if epochs_done >= 80:
        status = "completed"
    elif time.time() - mtime <= 6 * 60 * 60:
        status = "training"
    else:
        status = "stopped"
    score_metric = cfg.get("score_metric")
    score = metrics.get(score_metric) if score_metric else metrics.get("val_map50_95")
    return {
        "task_id": task_id,
        "title": cfg.get("title", task_id),
        "status": status,
        "model_family": model or run.name,
        "source": "results",
        "source_run": str(run),
        "best_weight": str(best_weight),
        "metrics": metrics,
        "score": score if score is not None else -1,
        "metric_source": cfg.get("metric_source_override") or "val",
        "train_progress": {
            "epoch": int(float(last.get("epoch", epochs_done - 1))) + 1 if str(last.get("epoch", "")).strip() else epochs_done,
            "total_epochs": 80,
            "rows": epochs_done,
        },
        "mtime": mtime,
    }

def run_candidates(task_id, cfg, roots_key="roots", keywords_key="keywords"):
    out = []
    keywords = [str(x).lower() for x in cfg.get(keywords_key, [])]
    for root in cfg.get(roots_key, []):
        base = Path(root)
        if not base.exists():
            continue
        for run in base.iterdir():
            if not run.is_dir():
                continue
            name = run.name.lower()
            if keywords and not any(keyword in name for keyword in keywords):
                continue
            item = results_candidate(task_id, cfg, run)
            if item:
                out.append(item)
    return out

def china_day(value, fallback_text=""):
    text = str(value or "").strip()
    if text:
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone(timedelta(hours=8))).strftime("%Y-%m-%d")
        except Exception:
            pass
    source = f"{text} {fallback_text}"
    match = re.search(r"(20\d{2})[-_]?(\d{2})[-_]?(\d{2})", source)
    if match:
        return f"{match.group(1)}-{match.group(2)}-{match.group(3)}"
    return ""

def trend_score(metrics):
    for key in ("test_map50_95", "val_map50_95", "map50_95", "test_map50", "val_map50", "map50"):
        value = metrics.get(key)
        if value is not None:
            return value
    return -1

def trend_row(task_id, item):
    metrics = item.get("metrics") or {}
    score = trend_score(metrics)
    day = china_day(item.get("finished_at") or item.get("started_at"), f"{item.get('source_run', '')} {item.get('summary_path', '')}")
    if not day or score is None or score < 0:
        return None
    return {
        "day": day,
        "task_id": task_id,
        "model_family": item.get("model_family") or "",
        "status": item.get("status") or "",
        "metric_source": item.get("metric_source") or "",
        "score": score,
        "test_precision": metrics.get("test_precision"),
        "test_recall": metrics.get("test_recall"),
        "test_map50": metrics.get("test_map50"),
        "test_map50_95": metrics.get("test_map50_95"),
        "val_precision": metrics.get("val_precision"),
        "val_recall": metrics.get("val_recall"),
        "val_map50": metrics.get("val_map50"),
        "val_map50_95": metrics.get("val_map50_95"),
        "started_at": item.get("started_at") or "",
        "finished_at": item.get("finished_at") or "",
        "source_run": item.get("source_run") or "",
        "best_weight": item.get("best_weight") or "",
    }

def training_trend_for_task(task_id, items, max_days=14):
    by_day = {}
    counts = {}
    for item in items:
        if item.get("status") != "completed":
            continue
        row = trend_row(task_id, item)
        if not row:
            continue
        day = row["day"]
        counts[day] = counts.get(day, 0) + 1
        old = by_day.get(day)
        if old is None or row["score"] > old["score"]:
            by_day[day] = row
    rows = []
    for day, row in sorted(by_day.items()):
        row["run_count"] = counts.get(day, 1)
        rows.append(row)
    return rows[-max_days:]

payload = {"candidates": {}, "running": {}, "training_trends": {}, "tmux": [], "gpus": [], "collected_at": time.time()}
try:
    import subprocess
    tmux = subprocess.run(["tmux", "ls"], text=True, capture_output=True, timeout=5)
    payload["tmux"] = [line for line in tmux.stdout.splitlines() if line.strip()]
except Exception:
    pass
try:
    import subprocess
    smi = subprocess.run([
        "nvidia-smi",
        "--query-gpu=index,memory.used,memory.total,utilization.gpu,temperature.gpu",
        "--format=csv,noheader,nounits",
    ], text=True, capture_output=True, timeout=8)
    payload["gpus"] = [line for line in smi.stdout.splitlines() if line.strip()]
except Exception:
    pass

for task_id, cfg in targets.items():
    items = summary_candidates(task_id, cfg) + run_candidates(task_id, cfg)
    trend_items = items + summary_candidates(task_id, cfg, "trend_summary_roots") + run_candidates(task_id, cfg, "trend_roots", "trend_keywords")
    payload["training_trends"][task_id] = training_trend_for_task(task_id, trend_items)
    completed = [item for item in items if item.get("status") == "completed" and item.get("score", -1) is not None and item.get("score", -1) >= 0]
    completed.sort(key=lambda item: (item.get("score") or -1, item.get("metrics", {}).get("test_map50") or item.get("metrics", {}).get("val_map50") or -1), reverse=True)
    completed_keys = {
        (item.get("source_run") or "", item.get("best_weight") or "")
        for item in trend_items
        if item.get("status") == "completed"
    }
    running = [
        item for item in trend_items
        if item.get("status") != "completed"
        and (item.get("source_run") or "", item.get("best_weight") or "") not in completed_keys
    ]
    running.sort(key=lambda item: item.get("mtime") or 0, reverse=True)
    payload["candidates"][task_id] = completed[:5]
    payload["running"][task_id] = running[:3]

print(json.dumps(payload, ensure_ascii=False))
"""


def utc_now():
    return datetime.now(timezone.utc).astimezone().isoformat()


def run(cmd, **kwargs):
    return subprocess.run(cmd, text=True, capture_output=True, check=False, **kwargs)


def ssh_python_collect():
    env_cmd = "YOLO_TARGETS_JSON=" + shell_quote(json.dumps(TARGETS, ensure_ascii=False))
    cmd = [
        "ssh",
        "-i", A100_KEY,
        "-o", "ClearAllForwardings=yes",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=12",
        "-o", "StrictHostKeyChecking=no",
        f"{A100_USER}@{A100_HOST}",
        f"{env_cmd} python3 - <<'PY'\n{COLLECTOR}\nPY",
    ]
    result = run(cmd, timeout=90)
    if result.returncode != 0:
        raise RuntimeError(f"a100_collect_failed:{result.stderr.strip() or result.stdout.strip()}")
    return json.loads(result.stdout)


def shell_quote(value):
    return "'" + str(value).replace("'", "'\\''") + "'"


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
      for chunk in iter(lambda: handle.read(1024 * 1024), b""):
          digest.update(chunk)
    return digest.hexdigest()


def copy_remote_weight(remote_path, local_weight, download_file):
    DOWNLOAD_ROOT.mkdir(parents=True, exist_ok=True)
    Path(local_weight).parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="yolo_weight_sync_") as tmp:
        tmp_path = Path(tmp) / Path(download_file).name
        result = run([
            "scp",
            "-i", A100_KEY,
            "-o", "ClearAllForwardings=yes",
            "-o", "BatchMode=yes",
            "-o", "ConnectTimeout=12",
            "-o", "StrictHostKeyChecking=no",
            f"{A100_USER}@{A100_HOST}:{remote_path}",
            str(tmp_path),
        ], timeout=180)
        if result.returncode != 0:
            raise RuntimeError(f"scp_failed:{result.stderr.strip() or result.stdout.strip()}")
        src_sha = sha256_file(tmp_path)
        local_path = Path(local_weight)
        if not local_path.exists() or sha256_file(local_path) != src_sha:
            backup_dir = RUNTIME_ROOT / "weights" / "archive"
            backup_dir.mkdir(parents=True, exist_ok=True)
            if local_path.exists():
                stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                shutil.copy2(local_path, backup_dir / f"{local_path.name}.before_monitor_{stamp}.pt")
            temp_local = local_path.with_suffix(local_path.suffix + ".tmp")
            shutil.copy2(tmp_path, temp_local)
            os.replace(temp_local, local_path)
        download_path = DOWNLOAD_ROOT / Path(download_file).name
        temp_download = download_path.with_suffix(download_path.suffix + ".tmp")
        shutil.copy2(tmp_path, temp_download)
        os.replace(temp_download, download_path)
        return src_sha, tmp_path.stat().st_size


def ensure_download_from_local(local_weight, download_file):
    DOWNLOAD_ROOT.mkdir(parents=True, exist_ok=True)
    local_path = Path(local_weight)
    if not local_path.exists():
        return None, None
    download_path = DOWNLOAD_ROOT / Path(download_file).name
    src_sha = sha256_file(local_path)
    if not download_path.exists() or sha256_file(download_path) != src_sha:
        temp_download = download_path.with_suffix(download_path.suffix + ".tmp")
        shutil.copy2(local_path, temp_download)
        os.replace(temp_download, download_path)
    return src_sha, local_path.stat().st_size


def deployable_entry(task_id, cfg, candidate, running):
    metrics = candidate.get("metrics") or {}
    sha, size = copy_remote_weight(candidate["best_weight"], cfg["local_weight"], cfg["download_file"])
    return {
        "task_id": task_id,
        "title": cfg["title"],
        "status": "deployed",
        "model_family": candidate.get("model_family") or "unknown",
        "metric_source": candidate.get("metric_source") or candidate.get("source") or "",
        "metrics": metrics,
        "train_progress": running.get("train_progress") if running else None,
        "source_run": candidate.get("source_run") or "",
        "best_weight": candidate.get("best_weight") or "",
        "local_weight": cfg["local_weight"],
        "download_file": cfg["download_file"],
        "weight_sha256": sha,
        "weight_size_bytes": size,
        "deployed_at": utc_now(),
        "updated_at": utc_now(),
    }


def fallback_entry(task_id, cfg, running=None, note="等待已完成训练结果。"):
    sha, size = ensure_download_from_local(cfg["local_weight"], cfg["download_file"])
    return {
        "task_id": task_id,
        "title": cfg["title"],
        "status": "available" if sha else "pending",
        "model_family": Path(cfg["local_weight"]).stem,
        "metric_source": "current_workbench_weight" if sha else "",
        "metrics": {},
        "train_progress": running.get("train_progress") if running else None,
        "source_run": "",
        "best_weight": "",
        "local_weight": cfg["local_weight"],
        "download_file": cfg["download_file"] if sha else "",
        "weight_sha256": sha,
        "weight_size_bytes": size,
        "updated_at": utc_now(),
        "note": note,
    }


def static_entry(task_id, cfg, running=None):
    sha, size = ensure_download_from_local(cfg["local_weight"], cfg["download_file"])
    running_metrics = running.get("metrics") if running else None
    running_progress = running.get("train_progress") if running else None
    return {
        "task_id": task_id,
        "title": cfg["title"],
        "status": running.get("status") if running else (cfg.get("static_status") or ("deployed" if sha else "pending")),
        "model_family": (running.get("model_family") if running else "") or cfg.get("static_model_family") or Path(cfg["local_weight"]).stem,
        "metric_source": (running.get("metric_source") if running else "") or cfg.get("static_metric_source") or "current_workbench_weight",
        "metrics": running_metrics or cfg.get("static_metrics") or {},
        "train_progress": running_progress,
        "source_run": running.get("source_run") if running else cfg.get("static_source_run", ""),
        "best_weight": running.get("best_weight") if running else cfg.get("static_best_weight", ""),
        "local_weight": cfg["local_weight"],
        "download_file": cfg["download_file"] if sha else "",
        "weight_sha256": sha,
        "weight_size_bytes": size,
        "updated_at": utc_now(),
        "note": cfg.get("static_note", ""),
    }


def write_registry(payload):
    REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = REGISTRY_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, REGISTRY_PATH)


def write_training_trend_static(payload):
    trend_payload = {
        "schema": "jgzj_yolo_training_trends.v1",
        "updated_at": payload.get("updated_at") or utc_now(),
        "training_trends": payload.get("training_trends") or {},
        "monitor_status": payload.get("monitor_status") or {},
        "entries": payload.get("entries") or [],
    }
    for target_path in [TREND_PUBLIC_PATH, TREND_STATIC_PATH]:
        target_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = target_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(trend_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, target_path)


def monitor_once():
    collected = ssh_python_collect()
    entries = []
    for task_id, cfg in TARGETS.items():
        running = (collected.get("running", {}).get(task_id) or [None])[0]
        active_running = running if running and running.get("status") == "training" else None
        if cfg.get("static_only"):
            entries.append(static_entry(task_id, cfg, active_running))
            continue
        candidates = collected.get("candidates", {}).get(task_id) or []
        if candidates:
            try:
                entries.append(deployable_entry(task_id, cfg, candidates[0], active_running))
                continue
            except Exception as exc:
                entries.append(fallback_entry(task_id, cfg, active_running, note=f"权重同步失败：{exc}"))
                continue
        entries.append(fallback_entry(task_id, cfg, active_running))

    training_trends = collected.get("training_trends") or {}
    for task_id, cfg in TARGETS.items():
        static_rows = cfg.get("static_training_trends") or []
        if not static_rows:
            continue
        rows = list(training_trends.get(task_id) or [])
        seen = {
            (str(row.get("day") or ""), str(row.get("model_family") or ""), str(row.get("source_run") or ""))
            for row in rows
        }
        for row in static_rows:
            key = (str(row.get("day") or ""), str(row.get("model_family") or ""), str(row.get("source_run") or ""))
            if key not in seen:
                rows.append(row)
                seen.add(key)
        rows.sort(key=lambda row: (str(row.get("day") or ""), str(row.get("model_family") or "")))
        training_trends[task_id] = rows
    for entry in entries:
        task_id = entry.get("task_id")
        entry["training_trends"] = training_trends.get(task_id) or []

    registry = {
        "schema": "jgzj_yolo_model_registry.v1",
        "updated_at": utc_now(),
        "monitor_status": {
            "a100_host": A100_HOST,
            "collected_at": collected.get("collected_at"),
            "tmux": collected.get("tmux", []),
            "gpus": collected.get("gpus", []),
        },
        "training_trends": training_trends,
        "entries": entries,
    }
    write_registry(registry)
    write_training_trend_static(registry)
    return registry


def main():
    while True:
        started = time.time()
        try:
            registry = monitor_once()
            print(json.dumps({
                "ok": True,
                "updated_at": registry["updated_at"],
                "entries": [
                    {
                        "task_id": entry["task_id"],
                        "status": entry["status"],
                        "model_family": entry["model_family"],
                        "metric_source": entry.get("metric_source"),
                        "metrics": entry.get("metrics"),
                    }
                    for entry in registry["entries"]
                ],
            }, ensure_ascii=False), flush=True)
        except Exception as exc:
            print(json.dumps({"ok": False, "error": str(exc), "updated_at": utc_now()}, ensure_ascii=False), flush=True)
        if RUN_ONCE:
            return
        elapsed = time.time() - started
        time.sleep(max(30, POLL_INTERVAL - elapsed))


if __name__ == "__main__":
    main()
