#!/usr/bin/env python3
"""Print BIT-0041 MQTT vehicle-state frames as NDJSON without publishing."""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
import threading
import time


REMOTE_DRIVE_DIR = pathlib.Path(__file__).resolve().parents[1] / "backend" / "remote-drive"
sys.path.insert(0, str(REMOTE_DRIVE_DIR))

from mqtt_remote_transport import (  # noqa: E402
    CONTROL_TOPIC,
    VEHICLE_STATE_TOPIC,
    MqttWireClient,
    _read_mqtt_credentials,
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--duration", type=float, default=25.0)
    parser.add_argument(
        "--config",
        type=pathlib.Path,
        default=pathlib.Path(
            "/home/weilin/autoad/src/auto_ad/modules/mqtt_cam_node/src/mqtt_cam/config/config.yaml"
        ),
    )
    args = parser.parse_args()
    username, password = _read_mqtt_credentials(args.config)
    ready = threading.Event()
    stop = threading.Event()

    def on_state(state):
        print(json.dumps(state, ensure_ascii=False, separators=(",", ":")), flush=True)
        ready.set()

    def on_control(command):
        print(
            json.dumps(
                {"event": "mqtt_control", "at": time.time(), **command},
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            flush=True,
        )

    def watch_stdin():
        for line in sys.stdin:
            if line.strip().lower() == "stop":
                stop.set()
                return

    client = MqttWireClient(
        username,
        password,
        CONTROL_TOPIC,
        on_foreign_message=lambda _reason: None,
        on_fault=lambda reason: print(
            json.dumps({"event": "fault", "detail": reason}, ensure_ascii=False),
            flush=True,
        ),
        state_topic=VEHICLE_STATE_TOPIC,
        on_vehicle_state=on_state,
        on_control_message=on_control,
    )
    threading.Thread(
        target=watch_stdin,
        name="monitor-stdin",
        daemon=True,
    ).start()
    try:
        client.connect()
        if not ready.wait(3.0):
            raise RuntimeError("vehicle MQTT state timeout")
        deadline = time.monotonic() + max(0.1, args.duration)
        while client.is_alive() and time.monotonic() < deadline and not stop.wait(0.05):
            pass
        return 0 if client.is_alive() else 1
    finally:
        client.close()


if __name__ == "__main__":
    raise SystemExit(main())
