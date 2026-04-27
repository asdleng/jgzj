#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import math
import signal
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.dates as mdates
import matplotlib.pyplot as plt
import psutil


PUBLIC_CHECKS = {
    "7789": "http://idtrd.kmdns.net:7789/healthz",
    "7790": "http://idtrd.kmdns.net:7790/healthz",
    "7791": "http://idtrd.kmdns.net:7791/healthz",
}

LOCAL_CHECKS = {
    "8794": "http://127.0.0.1:8794/healthz",
    "8050": "http://127.0.0.1:8050/healthz",
    "8888": "http://127.0.0.1:8888/healthz",
}

PORT_LABELS = {
    "8794": "7789->8794 ai-detect",
    "8050": "7790->8050 chat-bridge",
    "8888": "7791->8888 web",
}

PROCESS_LABELS = {
    "frpc": "frpc",
    "8794": "ai-detect",
    "8050": "chat-bridge",
    "8888": "web",
}

CSV_FIELDS = [
    "timestamp",
    "system_cpu_percent",
    "system_mem_percent",
    "load1",
    "load5",
    "load15",
    "net_bytes_sent",
    "net_bytes_recv",
    "frpc_pid",
    "frpc_cpu_percent",
    "frpc_rss_mb",
]

for public_port in ("7789", "7790", "7791"):
    CSV_FIELDS.extend(
        [
            f"public_{public_port}_ok",
            f"public_{public_port}_status",
            f"public_{public_port}_latency_ms",
            f"public_{public_port}_error",
        ]
    )

for local_port in ("8794", "8050", "8888"):
    CSV_FIELDS.extend(
        [
            f"local_{local_port}_ok",
            f"local_{local_port}_status",
            f"local_{local_port}_latency_ms",
            f"local_{local_port}_error",
            f"conn_{local_port}_total",
            f"conn_{local_port}_established",
            f"pid_{local_port}",
            f"cpu_{local_port}",
            f"rss_{local_port}_mb",
        ]
    )


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def safe_float(value: object) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return math.nan


def safe_int(value: object) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def http_probe(url: str, timeout_s: float) -> dict[str, object]:
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(url, timeout=timeout_s) as resp:
            body = resp.read(32).decode("utf-8", errors="replace").strip()
            latency_ms = round((time.perf_counter() - started) * 1000.0, 2)
            ok = 200 <= resp.status < 300
            return {
                "ok": int(ok),
                "status": resp.status,
                "latency_ms": latency_ms,
                "error": "" if ok else body[:120],
            }
    except urllib.error.HTTPError as exc:
        latency_ms = round((time.perf_counter() - started) * 1000.0, 2)
        return {
            "ok": 0,
            "status": exc.code,
            "latency_ms": latency_ms,
            "error": str(exc)[:120],
        }
    except Exception as exc:  # noqa: BLE001
        latency_ms = round((time.perf_counter() - started) * 1000.0, 2)
        return {
            "ok": 0,
            "status": 0,
            "latency_ms": latency_ms,
            "error": str(exc)[:120],
        }


class Monitor:
    def __init__(self, csv_path: Path, png_path: Path, summary_path: Path, events_path: Path, timeout_s: float):
        self.csv_path = csv_path
        self.png_path = png_path
        self.summary_path = summary_path
        self.events_path = events_path
        self.timeout_s = timeout_s
        self.proc_cache: dict[int, psutil.Process] = {}
        self.prev_states: dict[str, int] = {}
        self.running = True
        self._prime_cpu()

    def _prime_cpu(self) -> None:
        psutil.cpu_percent(interval=None)

    def stop(self, *_args: object) -> None:
        self.running = False

    def get_process(self, pid: int | None) -> psutil.Process | None:
        if not pid:
            return None
        proc = self.proc_cache.get(pid)
        if proc is None:
            try:
                proc = psutil.Process(pid)
                proc.cpu_percent(interval=None)
                self.proc_cache[pid] = proc
            except psutil.Error:
                return None
        return proc

    def listener_pids(self) -> dict[str, int]:
        listeners: dict[str, int] = {}
        for conn in psutil.net_connections(kind="tcp"):
            if conn.status != psutil.CONN_LISTEN or not conn.laddr:
                continue
            port = str(conn.laddr.port)
            if port in LOCAL_CHECKS and conn.pid:
                listeners[port] = conn.pid
        return listeners

    def connection_stats(self) -> dict[str, dict[str, int]]:
        stats = {
            port: {"total": 0, "established": 0}
            for port in LOCAL_CHECKS
        }
        active_statuses = {
            psutil.CONN_ESTABLISHED,
            psutil.CONN_SYN_SENT,
            psutil.CONN_SYN_RECV,
            psutil.CONN_FIN_WAIT1,
            psutil.CONN_FIN_WAIT2,
            psutil.CONN_CLOSE_WAIT,
            psutil.CONN_LAST_ACK,
            psutil.CONN_CLOSING,
        }
        for conn in psutil.net_connections(kind="tcp"):
            if not conn.laddr:
                continue
            port = str(conn.laddr.port)
            if port not in stats or conn.status == psutil.CONN_LISTEN:
                continue
            if conn.status in active_statuses:
                stats[port]["total"] += 1
            if conn.status == psutil.CONN_ESTABLISHED:
                stats[port]["established"] += 1
        return stats

    def find_frpc_pid(self) -> int | None:
        for proc in psutil.process_iter(attrs=["pid", "cmdline", "name"]):
            try:
                cmdline_list = proc.info.get("cmdline") or []
                cmdline = " ".join(cmdline_list)
            except psutil.Error:
                continue
            if not cmdline_list:
                continue
            executable = cmdline_list[0]
            if executable.endswith("/frpc") and "frpc.toml" in cmdline:
                return int(proc.info["pid"])
        return None

    def process_metrics(self, pid: int | None) -> tuple[float, float]:
        proc = self.get_process(pid)
        if proc is None:
            return math.nan, math.nan
        try:
            cpu = proc.cpu_percent(interval=None)
            rss_mb = round(proc.memory_info().rss / 1024 / 1024, 2)
            return round(cpu, 2), rss_mb
        except psutil.Error:
            return math.nan, math.nan

    def log_event(self, key: str, ok_value: int, message: str) -> None:
        previous = self.prev_states.get(key)
        self.prev_states[key] = ok_value
        if previous is None or previous == ok_value:
            return
        with self.events_path.open("a", encoding="utf-8") as handle:
            handle.write(f"{now_iso()} {key} {'UP' if ok_value else 'DOWN'} {message}\n")

    def collect_row(self) -> dict[str, object]:
        row: dict[str, object] = {"timestamp": now_iso()}
        cpu_percent = psutil.cpu_percent(interval=None)
        mem = psutil.virtual_memory()
        load1, load5, load15 = psutil.getloadavg()
        net = psutil.net_io_counters()

        row["system_cpu_percent"] = round(cpu_percent, 2)
        row["system_mem_percent"] = round(mem.percent, 2)
        row["load1"] = round(load1, 2)
        row["load5"] = round(load5, 2)
        row["load15"] = round(load15, 2)
        row["net_bytes_sent"] = int(net.bytes_sent)
        row["net_bytes_recv"] = int(net.bytes_recv)

        frpc_pid = self.find_frpc_pid()
        frpc_cpu, frpc_rss = self.process_metrics(frpc_pid)
        row["frpc_pid"] = frpc_pid or 0
        row["frpc_cpu_percent"] = frpc_cpu
        row["frpc_rss_mb"] = frpc_rss

        for port, url in PUBLIC_CHECKS.items():
            result = http_probe(url, self.timeout_s)
            row[f"public_{port}_ok"] = result["ok"]
            row[f"public_{port}_status"] = result["status"]
            row[f"public_{port}_latency_ms"] = result["latency_ms"]
            row[f"public_{port}_error"] = result["error"]
            self.log_event(
                f"public_{port}",
                int(result["ok"]),
                f"latency_ms={result['latency_ms']} error={result['error']}",
            )

        listeners = self.listener_pids()
        conn_stats = self.connection_stats()
        for port, url in LOCAL_CHECKS.items():
            result = http_probe(url, self.timeout_s)
            row[f"local_{port}_ok"] = result["ok"]
            row[f"local_{port}_status"] = result["status"]
            row[f"local_{port}_latency_ms"] = result["latency_ms"]
            row[f"local_{port}_error"] = result["error"]
            row[f"conn_{port}_total"] = conn_stats[port]["total"]
            row[f"conn_{port}_established"] = conn_stats[port]["established"]

            pid = listeners.get(port)
            cpu, rss = self.process_metrics(pid)
            row[f"pid_{port}"] = pid or 0
            row[f"cpu_{port}"] = cpu
            row[f"rss_{port}_mb"] = rss

            self.log_event(
                f"local_{port}",
                int(result["ok"]),
                f"latency_ms={result['latency_ms']} error={result['error']}",
            )

        return row

    def append_row(self, row: dict[str, object]) -> None:
        write_header = not self.csv_path.exists()
        with self.csv_path.open("a", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS)
            if write_header:
                writer.writeheader()
            writer.writerow(row)

        summary = {
            "updated_at": row["timestamp"],
            "csv_path": str(self.csv_path),
            "png_path": str(self.png_path),
            "events_path": str(self.events_path),
            "latest": row,
        }
        self.summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    def plot(self) -> None:
        if not self.csv_path.exists():
            return

        timestamps: list[datetime] = []
        public_latencies: dict[str, list[float]] = {port: [] for port in PUBLIC_CHECKS}
        local_latencies: dict[str, list[float]] = {port: [] for port in LOCAL_CHECKS}
        connections: dict[str, list[int]] = {port: [] for port in LOCAL_CHECKS}
        process_cpu: dict[str, list[float]] = {
            "frpc": [],
            "8794": [],
            "8050": [],
            "8888": [],
        }
        system_cpu: list[float] = []
        system_mem: list[float] = []
        load1: list[float] = []

        with self.csv_path.open("r", newline="", encoding="utf-8") as handle:
            reader = csv.DictReader(handle)
            for raw in reader:
                try:
                    timestamps.append(datetime.fromisoformat(raw["timestamp"]))
                except ValueError:
                    continue

                for port in PUBLIC_CHECKS:
                    ok_value = safe_int(raw.get(f"public_{port}_ok"))
                    latency = safe_float(raw.get(f"public_{port}_latency_ms"))
                    public_latencies[port].append(latency if ok_value else math.nan)

                for port in LOCAL_CHECKS:
                    ok_value = safe_int(raw.get(f"local_{port}_ok"))
                    latency = safe_float(raw.get(f"local_{port}_latency_ms"))
                    local_latencies[port].append(latency if ok_value else math.nan)
                    connections[port].append(safe_int(raw.get(f"conn_{port}_established")))
                    process_cpu[port].append(safe_float(raw.get(f"cpu_{port}")))

                process_cpu["frpc"].append(safe_float(raw.get("frpc_cpu_percent")))
                system_cpu.append(safe_float(raw.get("system_cpu_percent")))
                system_mem.append(safe_float(raw.get("system_mem_percent")))
                load1.append(safe_float(raw.get("load1")))

        if not timestamps:
            return

        fig, axes = plt.subplots(5, 1, figsize=(16, 20), sharex=True)
        fig.suptitle("Port Pressure Monitor: 7789 / 7790 / 7791", fontsize=16)

        axes[0].set_title("Public Health Latency (ms)")
        for port, series in public_latencies.items():
            axes[0].plot(timestamps, series, label=port, linewidth=1.8)
        axes[0].legend(loc="upper left")
        axes[0].grid(True, alpha=0.25)

        axes[1].set_title("Local Health Latency (ms)")
        for port, series in local_latencies.items():
            axes[1].plot(timestamps, series, label=PORT_LABELS[port], linewidth=1.8)
        axes[1].legend(loc="upper left")
        axes[1].grid(True, alpha=0.25)

        axes[2].set_title("Established Connections")
        for port, series in connections.items():
            axes[2].plot(timestamps, series, label=PORT_LABELS[port], linewidth=1.8)
        axes[2].legend(loc="upper left")
        axes[2].grid(True, alpha=0.25)

        axes[3].set_title("Process CPU (%)")
        for label, series in process_cpu.items():
            axes[3].plot(timestamps, series, label=PROCESS_LABELS[label], linewidth=1.8)
        axes[3].legend(loc="upper left")
        axes[3].grid(True, alpha=0.25)

        axes[4].set_title("System Pressure")
        axes[4].plot(timestamps, system_cpu, label="cpu%", linewidth=1.8)
        axes[4].plot(timestamps, system_mem, label="mem%", linewidth=1.8)
        axes[4].plot(timestamps, load1, label="load1", linewidth=1.8)
        axes[4].legend(loc="upper left")
        axes[4].grid(True, alpha=0.25)

        axes[-1].xaxis.set_major_formatter(mdates.DateFormatter("%m-%d %H:%M"))
        fig.autofmt_xdate()
        fig.tight_layout(rect=(0, 0.02, 1, 0.98))
        fig.savefig(self.png_path, dpi=140)
        plt.close(fig)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Continuously monitor 7789/7790/7791 pressure and health.")
    parser.add_argument("--output-dir", required=True, help="Directory to store csv/png/json outputs.")
    parser.add_argument("--interval", type=float, default=5.0, help="Sampling interval in seconds.")
    parser.add_argument("--plot-every", type=int, default=6, help="Regenerate png every N samples.")
    parser.add_argument("--timeout", type=float, default=3.0, help="HTTP probe timeout in seconds.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    csv_path = output_dir / f"port_pressure_{stamp}.csv"
    png_path = output_dir / f"port_pressure_{stamp}.png"
    summary_path = output_dir / "latest_summary.json"
    events_path = output_dir / f"port_pressure_{stamp}.events.log"

    monitor = Monitor(
        csv_path=csv_path,
        png_path=png_path,
        summary_path=summary_path,
        events_path=events_path,
        timeout_s=args.timeout,
    )
    signal.signal(signal.SIGINT, monitor.stop)
    signal.signal(signal.SIGTERM, monitor.stop)

    print(f"[monitor] csv={csv_path}")
    print(f"[monitor] png={png_path}")
    print(f"[monitor] events={events_path}")
    print(f"[monitor] interval={args.interval}s plot_every={args.plot_every}")

    sample_count = 0
    while monitor.running:
        row = monitor.collect_row()
        monitor.append_row(row)
        sample_count += 1
        if sample_count == 1 or sample_count % args.plot_every == 0:
            monitor.plot()
        time.sleep(args.interval)

    monitor.plot()
    print("[monitor] stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
