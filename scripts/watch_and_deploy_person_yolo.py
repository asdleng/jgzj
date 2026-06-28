#!/usr/bin/env python3
import csv
import json
import os
import signal
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib.request import urlopen


PROJECT_ROOT = Path(os.environ.get("JGZJ_PROJECT_ROOT", "/home/admin1/jgzj"))
A100_HOST = os.environ.get("YOLO_A100_HOST", "192.168.80.49")
A100_USER = os.environ.get("YOLO_A100_USER", "sari")
A100_KEY = os.environ.get("YOLO_A100_KEY", "/home/admin1/a100_tunnel/jgzj_qwen36_proxy_ed25519")
POLL_INTERVAL = int(os.environ.get("PERSON_YOLO_DEPLOY_POLL_INTERVAL", "600"))
SUMMARY_ROOT = "/home/sari/person_yolo_experiments_20260627"
EXPECTED_FINAL_MODELS = {"yolo11n", "yolo26n", "yolo26s"}


def log(message):
    print(f"{datetime.now().isoformat(timespec='seconds')} {message}", flush=True)


def run(cmd, **kwargs):
    return subprocess.run(cmd, text=True, capture_output=True, check=False, **kwargs)


def a100_python(code):
    cmd = [
        "ssh",
        "-i",
        A100_KEY,
        "-o",
        "ClearAllForwardings=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=12",
        "-o",
        "StrictHostKeyChecking=no",
        f"{A100_USER}@{A100_HOST}",
        "python3 -",
    ]
    result = run(cmd, input=code, timeout=90)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "a100_python_failed")
    return json.loads(result.stdout)


def collect_person_training():
    code = r"""
import csv, json, time
from pathlib import Path

root = Path('/home/sari/person_yolo_experiments_20260627')
rows = []
for path in sorted(root.glob('**/summary.csv')):
    try:
        with path.open() as handle:
            for row in csv.DictReader(handle):
                item = {str(k).strip(): str(v).strip() for k, v in row.items()}
                item['summary_path'] = str(path)
                rows.append(item)
    except Exception as exc:
        rows.append({'summary_path': str(path), 'status': 'read_error', 'error': str(exc)})

progress = []
run_root = Path('/home/sari/jgzj_yolo_runs_person_v2')
for run in sorted(run_root.glob('person_yolo_v2_*')):
    result_path = run / 'results.csv'
    if not result_path.exists():
        continue
    try:
        table = list(csv.DictReader(result_path.open()))
    except Exception:
        continue
    if not table:
        continue
    last = {str(k).strip(): str(v).strip() for k, v in table[-1].items()}
    best = max(
        ({str(k).strip(): str(v).strip() for k, v in r.items()} for r in table),
        key=lambda r: float(r.get('metrics/mAP50-95(B)') or -1),
    )
    progress.append({
        'run': str(run),
        'rows': len(table),
        'last_epoch': last.get('epoch'),
        'best_epoch': best.get('epoch'),
        'best_map50_95': best.get('metrics/mAP50-95(B)'),
        'mtime': result_path.stat().st_mtime,
    })

print(json.dumps({'rows': rows, 'progress': progress, 'collected_at': time.time()}, ensure_ascii=False))
"""
    return a100_python(code)


def training_done(snapshot):
    rows = snapshot.get("rows") or []
    running = [row for row in rows if row.get("status") == "running"]
    final_rows = {
        row.get("model")
        for row in rows
        if row.get("model") in EXPECTED_FINAL_MODELS and row.get("status") and row.get("status") != "running"
    }
    ok_rows = [row for row in rows if row.get("status") == "ok" and row.get("best_weight")]
    return not running and EXPECTED_FINAL_MODELS.issubset(final_rows) and bool(ok_rows)


def run_monitor_once():
    env = os.environ.copy()
    env["YOLO_MONITOR_ONCE"] = "1"
    result = run([sys.executable, str(PROJECT_ROOT / "scripts" / "monitor_best_yolo_models.py")], env=env, cwd=str(PROJECT_ROOT), timeout=300)
    log("monitor_once_stdout=" + result.stdout.strip().replace("\n", " | "))
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "monitor_once_failed")


def restart_best_monitor():
    run(["tmux", "kill-session", "-t", "yolo-best-monitor"], timeout=10)
    log_path = PROJECT_ROOT / ".runtime" / "yolo_model_service" / "logs" / "yolo_best_monitor.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    command = (
        f"cd {PROJECT_ROOT} && "
        "YOLO_MONITOR_INTERVAL=600 "
        f"{sys.executable} scripts/monitor_best_yolo_models.py "
        f">> {log_path} 2>&1"
    )
    result = run(["tmux", "new-session", "-d", "-s", "yolo-best-monitor", command], timeout=10)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "restart_best_monitor_failed")


def registry_person():
    path = PROJECT_ROOT / ".runtime" / "yolo_model_service" / "model_registry.json"
    data = json.loads(path.read_text())
    for entry in data.get("entries", []):
        if entry.get("task_id") == "person_yolo":
            return entry
    return {}


def restart_local_yolo_service():
    pattern = str(PROJECT_ROOT / "scripts" / "yolo_inference_service.py")
    pgrep = run(["pgrep", "-f", pattern])
    pids = [int(x) for x in pgrep.stdout.split() if x.strip().isdigit()]
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.time() + 25
    while time.time() < deadline:
        alive = []
        for pid in pids:
            try:
                os.kill(pid, 0)
                alive.append(pid)
            except ProcessLookupError:
                pass
        if not alive:
            break
        time.sleep(1)
    for pid in pids:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            continue
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    log_path = PROJECT_ROOT / ".runtime" / "yolo_model_service" / "logs" / "local_yolo_infer_service.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("ab", buffering=0) as handle:
        subprocess.Popen(
            ["bash", str(PROJECT_ROOT / "scripts" / "start_yolo_infer_service.sh")],
            cwd=str(PROJECT_ROOT),
            stdout=handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )

    for _ in range(60):
        try:
            with urlopen("http://127.0.0.1:18087/health", timeout=3) as response:
                payload = json.loads(response.read().decode("utf-8"))
            if payload.get("ok"):
                return payload
        except Exception:
            pass
        time.sleep(2)
    raise RuntimeError("local_yolo_service_health_timeout")


def main():
    initial = registry_person()
    initial_sha = initial.get("weight_sha256")
    log(f"start initial_family={initial.get('model_family')} initial_sha={initial_sha}")
    while True:
        snapshot = collect_person_training()
        rows = snapshot.get("rows") or []
        running = [row.get("model") for row in rows if row.get("status") == "running"]
        progress = sorted(snapshot.get("progress") or [], key=lambda item: item.get("mtime") or 0, reverse=True)[:3]
        log("running=" + ",".join(running) + " progress=" + json.dumps(progress, ensure_ascii=False))
        if not training_done(snapshot):
            time.sleep(POLL_INTERVAL)
            continue

        log("person training complete; syncing best model")
        restart_best_monitor()
        run_monitor_once()
        current = registry_person()
        log("selected=" + json.dumps({
            "model_family": current.get("model_family"),
            "sha": current.get("weight_sha256"),
            "metrics": current.get("metrics"),
            "source_run": current.get("source_run"),
        }, ensure_ascii=False))

        if current.get("weight_sha256") != initial_sha:
            health = restart_local_yolo_service()
            log("local_yolo_restarted=" + json.dumps({
                "ok": health.get("ok"),
                "gpu": health.get("gpu"),
                "loaded_models": health.get("loaded_models"),
            }, ensure_ascii=False))
        else:
            log("person weight sha unchanged; no local service restart needed")
        return


if __name__ == "__main__":
    main()
