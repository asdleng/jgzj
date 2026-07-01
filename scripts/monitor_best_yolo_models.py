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
        "score_metric": "val_map50_95",
        "metric_source_override": "val",
        "roots": [
            "/home/sari/jgzj_yolo_runs_person_v2",
            "/home/sari/jgzj_yolo_runs",
        ],
        "summary_roots": [
            "/home/sari/person_yolo_experiments_20260627",
        ],
        "keywords": ["person_yolo"],
    },
    "vehicle_yolo": {
        "title": "车辆识别",
        "local_weight": str(RUNTIME_ROOT / "weights" / "general_yolo_best.pt"),
        "download_file": "vehicle_yolo_best.pt",
        "roots": [
            "/home/sari/jgzj_yolo_runs_vehicle",
            "/home/sari/jgzj_yolo_runs",
        ],
        "summary_roots": [
            "/home/sari/vehicle_yolo_experiments_20260627",
        ],
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
        "keywords": ["pet_public", "pet_yolo"],
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
        "keywords": [],
    },
    "fire_smoke_yolo": {
        "title": "火源烟雾",
        "local_weight": str(RUNTIME_ROOT / "weights" / "fire_smoke_yolo_best.pt"),
        "download_file": "fire_smoke_yolo_best.pt",
        "static_only": True,
        "static_model_family": "yolo12s",
        "static_metric_source": "test",
        "static_metrics": {
            "test_precision": 0.7672,
            "test_recall": 0.6831,
            "test_map50": 0.7361,
            "test_map50_95": 0.4040,
        },
        "static_note": "烟火已由单独新架构实验选定 yolo12s；不在本监控里用旧 val 口径重选。",
        "roots": [
            "/home/sari/jgzj_yolo_runs_new_arch",
            "/home/sari/jgzj_yolo_runs_new_arch_parallel",
            "/home/sari/jgzj_yolo_runs_new_arch_parallel_yolo12n",
            "/home/sari/jgzj_yolo_runs",
        ],
        "summary_roots": [
            "/home/sari/yolo_new_arch_experiments_20260626",
        ],
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
    "common_yolo": {
        "title": "融合实验",
        "local_weight": str(RUNTIME_ROOT / "weights" / "common_yolo_best.pt"),
        "download_file": "common_yolo_best.pt",
        "summary_roots": [
            "/home/sari/common_yolo_20260630",
        ],
        "roots": [
            "/home/sari/common_yolo_20260630/runs",
        ],
        "keywords": ["common_yolo"],
    },
}


COLLECTOR = r"""
import csv, json, os, re, time
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

def summary_candidates(task_id, cfg):
    out = []
    for root in cfg.get("summary_roots", []):
        base = Path(root)
        if not base.exists():
            continue
        for path in base.glob("results*/summary.csv"):
            try:
                rows = list(csv.DictReader(path.open()))
            except Exception:
                continue
            for row in rows:
                row = norm(row)
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
                })
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
    # Treat old completed baselines as deployable when they reached the usual 80 epochs.
    status = "completed" if epochs_done >= 80 else "training"
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
        "mtime": rpath.stat().st_mtime,
    }

def run_candidates(task_id, cfg):
    out = []
    keywords = [str(x).lower() for x in cfg.get("keywords", [])]
    for root in cfg.get("roots", []):
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

payload = {"candidates": {}, "running": {}, "tmux": [], "gpus": [], "collected_at": time.time()}
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
    completed = [item for item in items if item.get("status") == "completed" and item.get("score", -1) is not None and item.get("score", -1) >= 0]
    completed.sort(key=lambda item: (item.get("score") or -1, item.get("metrics", {}).get("test_map50") or item.get("metrics", {}).get("val_map50") or -1), reverse=True)
    running = [item for item in items if item.get("status") != "completed"]
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


def static_entry(task_id, cfg):
    sha, size = ensure_download_from_local(cfg["local_weight"], cfg["download_file"])
    return {
        "task_id": task_id,
        "title": cfg["title"],
        "status": "deployed" if sha else "pending",
        "model_family": cfg.get("static_model_family") or Path(cfg["local_weight"]).stem,
        "metric_source": cfg.get("static_metric_source") or "current_workbench_weight",
        "metrics": cfg.get("static_metrics") or {},
        "train_progress": None,
        "source_run": "",
        "best_weight": "",
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


def monitor_once():
    collected = ssh_python_collect()
    entries = []
    for task_id, cfg in TARGETS.items():
        if cfg.get("static_only"):
            entries.append(static_entry(task_id, cfg))
            continue
        candidates = collected.get("candidates", {}).get(task_id) or []
        running = (collected.get("running", {}).get(task_id) or [None])[0]
        if candidates:
            try:
                entries.append(deployable_entry(task_id, cfg, candidates[0], running))
                continue
            except Exception as exc:
                entries.append(fallback_entry(task_id, cfg, running, note=f"权重同步失败：{exc}"))
                continue
        entries.append(fallback_entry(task_id, cfg, running))

    registry = {
        "schema": "jgzj_yolo_model_registry.v1",
        "updated_at": utc_now(),
        "monitor_status": {
            "a100_host": A100_HOST,
            "collected_at": collected.get("collected_at"),
            "tmux": collected.get("tmux", []),
            "gpus": collected.get("gpus", []),
        },
        "entries": entries,
    }
    write_registry(registry)
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
