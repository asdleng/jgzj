#!/usr/bin/env python3
"""Local-only static server and guarded BIT-0041 remote-drive gateway."""

from __future__ import annotations

import base64
import collections
import datetime as dt
import hmac
import json
import os
import pathlib
import queue
import secrets
import shlex
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, Optional
from urllib.parse import urlparse

from mqtt_remote_transport import GuardedMqttTransport, TransportError


BASE_DIR = pathlib.Path(__file__).resolve().parent
HELPER_PATH = BASE_DIR / "vehicle_remote_helper.py"
BIND_HOST = os.environ.get("VEHICLE_VIEWER_HOST", "127.0.0.1")
PORT = int(os.environ.get("VEHICLE_VIEWER_PORT", "8766"))
CONTROL_TRANSPORT = os.environ.get("VEHICLE_CONTROL_TRANSPORT", "mqtt").strip().lower()
CONTROL_VEHICLE_ID = "BIT-0041"
CONTROL_VIN = "a001I3829202711775712260"
CONTROL_SSH_TARGET = os.environ.get("VEHICLE_CONTROL_SSH_TARGET", "nvidia@100.98.77.65")
COMMAND_TIMEOUT_S = 5.00
MOTION_COMMAND_TIMEOUT_S = 0.60
VEHICLE_COMMAND_TIMEOUT_S = 1.50
MAX_CLOUD_AGE_S = 45.0
MAX_STEERING_DEG = 250.0
MAX_ACCELERATOR_PERCENT = 25.0
MAX_BODY_BYTES = 16 * 1024
ACCESS_LOG = os.environ.get("VEHICLE_VIEWER_ACCESS_LOG", "1").strip().lower() not in {"0", "false", "no"}
GEAR_TO_CAN = {"P": 0, "R": 1, "N": 2, "D": 3}
CAN_TO_GEAR = {0: "P", 1: "R", 2: "N", 3: "D"}
VEHICLE_GEAR = {0: "P", 1: "R", 2: "N", 3: "D"}


class GatewayError(RuntimeError):
    def __init__(self, message: str, status: int = HTTPStatus.BAD_REQUEST):
        super().__init__(message)
        self.status = int(status)


class CloudStatusClient:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._cached_at = 0.0
        self._cached: Dict[str, Any] = {}

    @staticmethod
    def _parse_time(value: Any) -> Optional[dt.datetime]:
        if not value:
            return None
        try:
            return dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except ValueError:
            return None

    def _fetch(self) -> Dict[str, Any]:
        request = urllib.request.Request(
            f"http://27.46.82.16:7788/api/vehicles/{CONTROL_VEHICLE_ID}",
            headers={"Host": "idtrd.kmdns.net:7788", "Accept": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=1.0) as response:
            payload = json.load(response)
        vehicle = payload.get("vehicle") or {}
        telemetry = vehicle.get("telemetry") or {}
        vehicle_state = telemetry.get("vehicle") or {}
        heartbeat = vehicle.get("heartbeat") or {}
        topics = telemetry.get("key_topics") or {}
        now = dt.datetime.now(dt.timezone.utc)
        last_seen = self._parse_time(vehicle.get("last_seen"))
        age_s = (now - last_seen).total_seconds() if last_seen else None
        telemetry_age_s = vehicle_state.get("data_age_s")
        cloud_telemetry_fresh = bool(vehicle.get("has_telemetry")) and (
            telemetry_age_s is not None and float(telemetry_age_s) <= 2.0
        )
        active_issues = []
        if vehicle.get("vehicle_id") != CONTROL_VEHICLE_ID or vehicle.get("vin") != CONTROL_VIN:
            active_issues.append("车辆身份不匹配")
        if age_s is None or age_s > MAX_CLOUD_AGE_S:
            active_issues.append("车辆云端状态过期")
        if not heartbeat.get("master_ping_ok"):
            active_issues.append("主控不可达")
        # Cloud telemetry arrives in batches and is not the motion safety authority.
        # When it is fresh, use it as an early rejection; the ROS guard always
        # rechecks fresh chassis state before publishing any control command.
        if cloud_telemetry_fresh:
            if not vehicle_state.get("ready"):
                active_issues.append("车辆未就绪")
            if vehicle_state.get("emergency_stop_pressed"):
                active_issues.append("物理急停已触发")
            if vehicle_state.get("collision_stop"):
                active_issues.append("碰撞停已触发")
        issues = list(active_issues)
        if cloud_telemetry_fresh and abs(float(vehicle_state.get("speed_kph") or 0.0)) > 0.1:
            issues.append("车辆未静止")
        raw_gear = vehicle_state.get("gear")
        return {
            "vehicle_id": CONTROL_VEHICLE_ID,
            "vin": CONTROL_VIN,
            "online": age_s is not None and age_s <= MAX_CLOUD_AGE_S,
            "ready_for_acquire": not issues,
            "issues": issues,
            "active_control_safe": not active_issues,
            "active_issues": active_issues,
            "last_seen_age_s": round(age_s, 2) if age_s is not None else None,
            "speed_kph": float(vehicle_state.get("speed_kph") or 0.0),
            "gear": VEHICLE_GEAR.get(raw_gear, "--"),
            "battery_soc": vehicle_state.get("battery_soc"),
            "emergency_stop": bool(vehicle_state.get("emergency_stop_pressed")),
            "collision_stop": bool(vehicle_state.get("collision_stop")),
            "master_reachable": bool(heartbeat.get("master_ping_ok")),
            "camera_ready": bool(topics.get("/miivii_gmsl_ros/camera1/compressed")),
            "cloud_telemetry_fresh": cloud_telemetry_fresh,
        }

    def get(self, force: bool = False) -> Dict[str, Any]:
        with self._lock:
            if not force and self._cached and time.monotonic() - self._cached_at < 0.5:
                return dict(self._cached)
            try:
                result = self._fetch()
            except (OSError, urllib.error.URLError, ValueError, json.JSONDecodeError) as error:
                result = {
                    "vehicle_id": CONTROL_VEHICLE_ID,
                    "vin": CONTROL_VIN,
                    "online": False,
                    "ready_for_acquire": False,
                    "issues": [f"状态读取失败: {error}"],
                    "active_control_safe": False,
                    "active_issues": [f"状态读取失败: {error}"],
                    "speed_kph": None,
                    "gear": "--",
                    "battery_soc": None,
                    "emergency_stop": None,
                    "collision_stop": None,
                    "master_reachable": False,
                    "camera_ready": False,
                }
            self._cached = result
            self._cached_at = time.monotonic()
            return dict(result)


class MockTransport:
    def __init__(self) -> None:
        self.started = False
        self.closed = False
        self.messages = []
        self.event: Optional[Dict[str, Any]] = None

    def start(self) -> None:
        self.started = True

    def send(self, payload: Dict[str, Any]) -> None:
        if self.closed:
            raise GatewayError("控制传输已关闭", HTTPStatus.SERVICE_UNAVAILABLE)
        self.messages.append(dict(payload))

    def close(self, reason: str = "release") -> None:
        if not self.closed:
            self.messages.append({"type": "estop" if reason == "estop" else "release"})
        self.closed = True

    def is_alive(self) -> bool:
        return self.started and not self.closed

    @property
    def last_event(self) -> Optional[Dict[str, Any]]:
        return self.event

    @property
    def fault_event(self) -> Optional[Dict[str, Any]]:
        return self.event

    @property
    def telemetry(self) -> Optional[Dict[str, Any]]:
        return None


class SshRosTransport:
    def __init__(self) -> None:
        self.process: Optional[subprocess.Popen[str]] = None
        self._write_lock = threading.Lock()
        self._ready = threading.Event()
        self._events: "queue.Queue[Dict[str, Any]]" = queue.Queue()
        self._stderr = collections.deque(maxlen=20)
        self._last_event: Optional[Dict[str, Any]] = None
        self._startup_event: Optional[Dict[str, Any]] = None
        self._fault_event: Optional[Dict[str, Any]] = None
        self._telemetry: Optional[Dict[str, Any]] = None

    def _read_stdout(self) -> None:
        assert self.process and self.process.stdout
        for line in self.process.stdout:
            try:
                event = json.loads(line)
            except ValueError:
                event = {"event": "remote_output", "message": line.strip()}
            self._last_event = event
            if event.get("event") == "telemetry":
                self._telemetry = event
            if event.get("event") in {"external_conflict", "not_ready", "closed", "vehicle_safety_stop"} or (
                event.get("event") == "failsafe"
                and event.get("reason") in {"heartbeat_timeout", "external_remote_command"}
            ):
                self._fault_event = event
            self._events.put(event)
            if event.get("event") in {"ready", "not_ready"}:
                self._startup_event = event
                self._ready.set()

    def _read_stderr(self) -> None:
        assert self.process and self.process.stderr
        for line in self.process.stderr:
            self._stderr.append(line.strip())

    def start(self) -> None:
        helper = base64.b64encode(HELPER_PATH.read_bytes()).decode("ascii")
        python_code = f"import base64;exec(compile(base64.b64decode('{helper}'),'<vehicle_remote_helper>','exec'))"
        remote_script = " && ".join(
            [
                "source /opt/ros/noetic/setup.bash",
                "source /home/nvidia/workspace/devel/setup.bash",
                "export ROS_MASTER_URI=http://10.168.1.100:11311",
                "export ROS_IP=10.168.1.102",
                "export ROS_HOSTNAME=10.168.1.102",
                f"exec python3 -u -c {shlex.quote(python_code)}",
            ]
        )
        remote_command = f"bash -lc {shlex.quote(remote_script)}"
        self.process = subprocess.Popen(
            [
                "ssh",
                "-T",
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=10",
                "-o",
                "ServerAliveInterval=2",
                "-o",
                "ServerAliveCountMax=2",
                "-o",
                "StrictHostKeyChecking=no",
                "-o",
                "UserKnownHostsFile=/dev/null",
                "-i",
                "/home/weilin/.ssh/id_ed25519",
                CONTROL_SSH_TARGET,
                remote_command,
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        threading.Thread(target=self._read_stdout, name="remote-helper-stdout", daemon=True).start()
        threading.Thread(target=self._read_stderr, name="remote-helper-stderr", daemon=True).start()
        if not self._ready.wait(25.0):
            details = "; ".join(self._stderr) or "远端 ROS 助手未就绪"
            self.close("release")
            raise GatewayError(details, HTTPStatus.SERVICE_UNAVAILABLE)
        if not self._startup_event or self._startup_event.get("event") != "ready":
            details = (self._startup_event or {}).get("reason") or "远端 ROS 控制链路未就绪"
            self.close("release")
            raise GatewayError(str(details), HTTPStatus.SERVICE_UNAVAILABLE)
        if not self.is_alive():
            raise GatewayError("远端 ROS 助手已退出", HTTPStatus.SERVICE_UNAVAILABLE)

    def send(self, payload: Dict[str, Any]) -> None:
        with self._write_lock:
            if not self.process or not self.process.stdin or self.process.poll() is not None:
                raise GatewayError("实车控制链路已断开", HTTPStatus.SERVICE_UNAVAILABLE)
            try:
                self.process.stdin.write(json.dumps(payload, separators=(",", ":")) + "\n")
                self.process.stdin.flush()
            except (BrokenPipeError, OSError) as error:
                raise GatewayError(f"实车控制链路写入失败: {error}", HTTPStatus.SERVICE_UNAVAILABLE) from error

    def close(self, reason: str = "release") -> None:
        process = self.process
        if not process:
            return
        try:
            if process.poll() is None and process.stdin:
                payload = {"type": "estop" if reason == "estop" else "release"}
                process.stdin.write(json.dumps(payload) + "\n")
                process.stdin.flush()
                process.stdin.close()
            process.wait(timeout=3.0)
        except (BrokenPipeError, OSError, subprocess.TimeoutExpired):
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=2.0)
                except subprocess.TimeoutExpired:
                    process.kill()
        finally:
            self.process = None

    def is_alive(self) -> bool:
        return bool(self.process and self.process.poll() is None)

    @property
    def last_event(self) -> Optional[Dict[str, Any]]:
        return self._last_event

    @property
    def fault_event(self) -> Optional[Dict[str, Any]]:
        return self._fault_event

    @property
    def telemetry(self) -> Optional[Dict[str, Any]]:
        return self._telemetry


class ControlGateway:
    def __init__(
        self,
        status_client: Optional[CloudStatusClient] = None,
        transport_factory: Optional[Callable[[], Any]] = None,
        time_fn: Callable[[], float] = time.monotonic,
        start_watchdog: bool = True,
    ) -> None:
        self.status_client = status_client or CloudStatusClient()
        self.transport_factory = transport_factory or (
            MockTransport
            if CONTROL_TRANSPORT == "mock"
            else SshRosTransport
            if CONTROL_TRANSPORT == "ssh"
            else GuardedMqttTransport
        )
        self.time_fn = time_fn
        self.lock = threading.RLock()
        self.lease_lock = threading.Lock()
        self.token = secrets.token_urlsafe(32)
        self.session_id: Optional[str] = None
        self.lease_session_id: Optional[str] = None
        self.acquiring = False
        self.transport: Optional[Any] = None
        self.last_browser_at = 0.0
        self.last_browser_command_at = 0.0
        self.motion_paused = False
        self.last_sequence = -1
        self.last_command = self._safe_command()
        self.last_error = ""
        self.last_transport_event: Optional[Dict[str, Any]] = None
        self._stop = threading.Event()
        if start_watchdog:
            threading.Thread(target=self._watchdog_loop, name="control-watchdog", daemon=True).start()
            threading.Thread(target=self._safety_loop, name="vehicle-safety-watchdog", daemon=True).start()

    def _start_browser_lease(self, session_id: str) -> None:
        with self.lease_lock:
            self.lease_session_id = session_id
            self.last_browser_at = self.time_fn()

    def _renew_browser_lease(self, session_id: str) -> bool:
        with self.lease_lock:
            if not self.lease_session_id or not hmac.compare_digest(str(session_id), self.lease_session_id):
                return False
            self.last_browser_at = self.time_fn()
            return True

    def _browser_lease_expired(self, session_id: str) -> bool:
        with self.lease_lock:
            return bool(
                not self.lease_session_id
                or not hmac.compare_digest(str(session_id), self.lease_session_id)
                or self.time_fn() - self.last_browser_at > COMMAND_TIMEOUT_S
            )

    def _clear_browser_lease(self, session_id: str) -> None:
        with self.lease_lock:
            if self.lease_session_id and hmac.compare_digest(str(session_id), self.lease_session_id):
                self.lease_session_id = None
                self.last_browser_at = 0.0

    @staticmethod
    def _safe_command() -> Dict[str, Any]:
        return {
            "type": "command",
            "deadman": False,
            "gear": 0,
            "accelerator": 0.0,
            "brake": 100.0,
            "steering": 0.0,
            "steer_lamp": 0,
            "front_lamp": 0,
            "ad_screen": 1,
            "horn": 0,
        }

    @classmethod
    def _safe_hold_command(cls) -> Dict[str, Any]:
        command = cls._safe_command()
        command["deadman"] = True
        return command

    @staticmethod
    def _is_motion_command(command: Dict[str, Any]) -> bool:
        return bool(
            float(command.get("accelerator", 0.0)) > 0.0
            or abs(float(command.get("steering", 0.0))) > 0.5
            or (
                int(command.get("gear", 0)) in {1, 3}
                and float(command.get("brake", 100.0)) < 50.0
            )
        )

    def _sanitize(self, raw: Dict[str, Any]) -> Dict[str, Any]:
        gear_name = str(raw.get("gear", "P")).upper()
        gear = GEAR_TO_CAN.get(gear_name, 0)
        brake = max(0.0, min(100.0, float(raw.get("brake", 100.0))))
        accelerator_percent = max(0.0, min(MAX_ACCELERATOR_PERCENT, float(raw.get("accelerator", 0.0))))
        if brake > 0.0 or gear not in (1, 3):
            accelerator_percent = 0.0
        steering = max(-MAX_STEERING_DEG, min(MAX_STEERING_DEG, float(raw.get("steering", 0.0))))
        if not raw.get("deadman"):
            return self._safe_command()
        previous_gear = int(self.last_command.get("gear", 0))
        if gear != previous_gear and brake < 50.0:
            gear = previous_gear
            accelerator_percent = 0.0
        return {
            "type": "command",
            "deadman": True,
            "gear": gear,
            "accelerator": accelerator_percent / 100.0,
            "brake": brake,
            "steering": steering,
            "steer_lamp": max(0, min(3, int(raw.get("steer_lamp", 0)))),
            "front_lamp": 1 if raw.get("front_lamp") else 0,
            "ad_screen": 1,
            "horn": 0,
        }

    def acquire(self, vehicle_id: str, video_ready: bool = False) -> Dict[str, Any]:
        if vehicle_id != CONTROL_VEHICLE_ID:
            raise GatewayError("当前只允许接管 BIT-0041", HTTPStatus.CONFLICT)
        preflight = self.status_client.get(force=True)
        if not preflight.get("ready_for_acquire"):
            raise GatewayError("；".join(preflight.get("issues") or ["车辆预检未通过"]), HTTPStatus.CONFLICT)
        with self.lock:
            if self.session_id or self.acquiring:
                raise GatewayError("实车控制已被当前页面接管", HTTPStatus.CONFLICT)
            self.acquiring = True
        transport = self.transport_factory()
        try:
            transport.start()
            safe_command = self._safe_command()
            transport.send(safe_command)
            wait_for_echo = getattr(transport, "wait_for_command_echo", None)
            if callable(wait_for_echo) and not wait_for_echo(1.0):
                raise GatewayError("MQTT 控制帧未收到 Broker 回执", HTTPStatus.SERVICE_UNAVAILABLE)
            with self.lock:
                if self._stop.is_set():
                    raise GatewayError("本地控制网关正在退出", HTTPStatus.SERVICE_UNAVAILABLE)
                self.transport = transport
                self.session_id = uuid.uuid4().hex
                self._start_browser_lease(self.session_id)
                self.last_sequence = -1
                self.last_command = safe_command
                self.last_browser_command_at = self.time_fn()
                self.motion_paused = False
                self.last_error = ""
                self.last_transport_event = transport.last_event
                return {
                    "ok": True,
                    "session_id": self.session_id,
                    "vehicle_id": CONTROL_VEHICLE_ID,
                    "constraints": self.constraints(),
                    "preflight": preflight,
                }
        except Exception as error:
            transport.close("estop")
            with self.lock:
                self.last_error = str(error)
            raise
        finally:
            with self.lock:
                self.acquiring = False

    def command(self, session_id: str, sequence: int, raw: Dict[str, Any]) -> Dict[str, Any]:
        with self.lock:
            if not self.session_id or not hmac.compare_digest(str(session_id), self.session_id):
                raise GatewayError("实车控制会话无效", HTTPStatus.CONFLICT)
            if sequence <= self.last_sequence:
                raise GatewayError("控制序号重复", HTTPStatus.CONFLICT)
            if not self.transport or not self.transport.is_alive():
                raise GatewayError("实车控制链路已断开", HTTPStatus.SERVICE_UNAVAILABLE)
            sanitized = self._sanitize(raw)
            self._renew_browser_lease(session_id)
            requested_motion = self._is_motion_command(sanitized)
            paused = False
            if self.motion_paused:
                if requested_motion:
                    sanitized = self._safe_hold_command()
                    paused = True
                else:
                    self.motion_paused = False
            self.transport.send(sanitized)
            self.last_browser_command_at = self.time_fn()
            self.last_sequence = sequence
            self.last_command = sanitized
            return {
                "ok": True,
                "sequence": sequence,
                "applied": self._public_command(sanitized),
                "motion_paused": paused,
            }

    def heartbeat(self, session_id: str) -> Dict[str, Any]:
        if not self._renew_browser_lease(session_id):
            raise GatewayError("实车控制会话无效", HTTPStatus.CONFLICT)
        return {"ok": True, "session_active": True}

    @staticmethod
    def _public_command(command: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "deadman": bool(command.get("deadman")),
            "gear": CAN_TO_GEAR.get(int(command.get("gear", 0)), "P"),
            "accelerator": round(float(command.get("accelerator", 0.0)) * 100.0, 1),
            "brake": round(float(command.get("brake", 100.0)), 1),
            "steering": round(float(command.get("steering", 0.0)), 1),
            "steer_lamp": int(command.get("steer_lamp", 0)),
            "front_lamp": int(command.get("front_lamp", 0)),
            "ad_screen": int(command.get("ad_screen", 1)),
        }

    def release(self, session_id: str, reason: str = "release") -> Dict[str, Any]:
        with self.lock:
            if self.session_id:
                if not session_id or not hmac.compare_digest(str(session_id), self.session_id):
                    raise GatewayError("实车控制会话无效", HTTPStatus.CONFLICT)
            transport = self.transport
            if transport and transport.last_event:
                self.last_transport_event = transport.last_event
            self.transport = None
            self.session_id = None
            self.last_command = self._safe_command()
            self.last_sequence = -1
            self.last_browser_command_at = 0.0
            self.motion_paused = False
            self._clear_browser_lease(str(session_id or ""))
        if transport:
            transport.close("estop" if reason == "estop" else "release")
        return {"ok": True, "released": True, "reason": reason}

    def constraints(self) -> Dict[str, Any]:
        return {
            "vehicle_id": CONTROL_VEHICLE_ID,
            "max_steering_deg": MAX_STEERING_DEG,
            "max_accelerator_percent": MAX_ACCELERATOR_PERCENT,
            "command_timeout_ms": int(COMMAND_TIMEOUT_S * 1000),
            "motion_command_timeout_ms": int(MOTION_COMMAND_TIMEOUT_S * 1000),
            "vehicle_command_timeout_ms": int(VEHICLE_COMMAND_TIMEOUT_S * 1000),
            "requires_deadman": True,
            "video_required": False,
        }

    def status(self) -> Dict[str, Any]:
        vehicle = self.status_client.get()
        with self.lock:
            transport_alive = bool(self.transport and self.transport.is_alive())
            transport_event = self.transport.last_event if self.transport else self.last_transport_event
            transport_telemetry = self.transport.telemetry if self.transport else None
            if transport_telemetry and time.time() - float(transport_telemetry.get("at") or 0.0) <= 1.5:
                vehicle = dict(vehicle)
                vehicle["speed_kph"] = float(transport_telemetry.get("speed_kph") or 0.0)
                vehicle["gear"] = VEHICLE_GEAR.get(int(transport_telemetry.get("gear", -1)), "--")
                vehicle["front_steering_deg"] = float(transport_telemetry.get("front_steering_deg") or 0.0)
                vehicle["rear_steering_deg"] = float(transport_telemetry.get("rear_steering_deg") or 0.0)
                vehicle["epb"] = bool(transport_telemetry.get("epb"))
                vehicle["motor_brake"] = bool(transport_telemetry.get("motor_brake"))
                vehicle["brake_pressure"] = float(transport_telemetry.get("brake_pressure") or 0.0)
                vehicle["ad_screen_on"] = bool(transport_telemetry.get("ad_screen_on"))
                vehicle["raw_chassis_status"] = bool(transport_telemetry.get("raw_chassis_status"))
                vehicle["battery_soc"] = transport_telemetry.get("battery_soc", vehicle.get("battery_soc"))
                vehicle["telemetry_source"] = transport_telemetry.get("telemetry_source", "ros_guard")
                vehicle["mqtt_vehicle_state_fresh"] = vehicle["telemetry_source"] == "mqtt_vehicle_state"
                vehicle["mqtt_vehicle_state_age_ms"] = round(
                    float(transport_telemetry.get("state_age_s") or 0.0) * 1000.0,
                    1,
                )
                broker_command = transport_telemetry.get("broker_command") or {}
                if broker_command:
                    vehicle["broker_command_deadman"] = bool(broker_command.get("deadman"))
                    vehicle["broker_command_gear"] = CAN_TO_GEAR.get(
                        int(broker_command.get("gear", 0)),
                        "P",
                    )
                    vehicle["broker_command_brake"] = float(broker_command.get("brake", 100.0))
                    vehicle["broker_command_steering_deg"] = float(broker_command.get("steering", 0.0))
                    vehicle["broker_command_age_ms"] = round(
                        float(transport_telemetry.get("broker_command_age_s") or 0.0) * 1000.0,
                        1,
                    )
                if "remote_mode_enabled" in transport_telemetry:
                    vehicle["remote_mode_enabled"] = bool(transport_telemetry.get("remote_mode_enabled"))
                    vehicle["remote_gear_cmd"] = int(transport_telemetry.get("remote_gear_cmd", 0))
                    vehicle["remote_brake_percent"] = float(
                        transport_telemetry.get("remote_brake_percent", 100.0)
                    )
                    vehicle["remote_steering_deg"] = float(
                        transport_telemetry.get("remote_steering_deg", 0.0)
                    )
                    vehicle["remote_ad_screen_cmd"] = int(
                        transport_telemetry.get("remote_ad_screen_cmd", 1)
                    )
                    vehicle["remote_command_age_ms"] = round(
                        float(transport_telemetry.get("command_age_s") or 0.0) * 1000.0,
                        1,
                    )
                    vehicle["downstream_mode_value"] = int(
                        transport_telemetry.get("downstream_mode_value", 0)
                    )
                    vehicle["downstream_gear_cmd"] = int(
                        transport_telemetry.get("downstream_gear_cmd", 0)
                    )
                    vehicle["downstream_brake_percent"] = float(
                        transport_telemetry.get("downstream_brake_percent", 100.0)
                    )
                    vehicle["downstream_steering_deg"] = float(
                        transport_telemetry.get("downstream_steering_deg", 0.0)
                    )
                    vehicle["downstream_ad_screen_cmd"] = int(
                        transport_telemetry.get("downstream_ad_screen_cmd", 1)
                    )
                    vehicle["downstream_command_age_ms"] = round(
                        float(transport_telemetry.get("downstream_command_age_s") or 0.0) * 1000.0,
                        1,
                    )
                vehicle["local_telemetry"] = True
            return {
                "ok": True,
                "transport_mode": CONTROL_TRANSPORT,
                "control_vehicle_id": CONTROL_VEHICLE_ID,
                "acquiring": self.acquiring,
                "session_active": bool(self.session_id),
                "transport_alive": transport_alive,
                "motion_paused": self.motion_paused,
                "transport_event": transport_event,
                "last_command": self._public_command(self.last_command),
                "last_error": self.last_error,
                "constraints": self.constraints(),
                "vehicle": vehicle,
            }

    def check_watchdog_once(self) -> None:
        with self.lock:
            if not self.session_id:
                return
            active_session_id = self.session_id
            motion_safe_failed = False
            if (
                not self.motion_paused
                and self._is_motion_command(self.last_command)
                and self.time_fn() - self.last_browser_command_at > MOTION_COMMAND_TIMEOUT_S
            ):
                safe_hold = self._safe_hold_command()
                try:
                    if self.transport and self.transport.is_alive():
                        self.transport.send(safe_hold)
                        self.last_command = safe_hold
                        self.motion_paused = True
                        self.last_transport_event = {
                            "event": "motion_paused",
                            "reason": "browser_command_timeout",
                        }
                except Exception as error:
                    motion_safe_failed = True
                    self.last_transport_event = {
                        "event": "closed",
                        "reason": "motion_safe_hold_failed",
                        "detail": str(error),
                    }
            expired = self._browser_lease_expired(active_session_id)
            dead_transport = not self.transport or not self.transport.is_alive()
            transport_event = self.transport.fault_event if self.transport else None
            event_name = (transport_event or {}).get("event")
            event_reason = (transport_event or {}).get("reason")
            remote_fault = motion_safe_failed or event_name in {
                "external_conflict",
                "not_ready",
                "closed",
                "vehicle_safety_stop",
            } or (
                event_name == "failsafe" and event_reason in {"heartbeat_timeout", "external_remote_command"}
            )
            if not expired and not dead_transport and not remote_fault:
                return
            if expired and not self._browser_lease_expired(active_session_id):
                return
            transport = self.transport
            if transport_event:
                self.last_transport_event = transport_event
            self.transport = None
            self.session_id = None
            self.last_command = self._safe_command()
            self.last_sequence = -1
            self.last_browser_command_at = 0.0
            self.motion_paused = False
            self._clear_browser_lease(active_session_id)
            if expired:
                self.last_error = "浏览器心跳超时，已退出实车控制"
            elif remote_fault:
                reason = (transport_event or {}).get("reason")
                if reason == "heartbeat_timeout":
                    self.last_error = "车端 MQTT 输入超过 1.5 秒未更新，已制动并退出"
                elif reason == "downstream_timeout":
                    self.last_error = "车端远控下游超过 1.5 秒未更新，已制动并退出"
                elif reason == "vehicle_state_timeout":
                    self.last_error = "车辆 MQTT 上行状态超过 1.5 秒未更新，已制动并退出"
                elif reason == "external_remote_command":
                    self.last_error = "检测到其他远控指令，已制动并退出"
                else:
                    self.last_error = "车端安全闭锁，已制动并退出"
            else:
                self.last_error = "实车控制链路断开"
        if transport:
            transport.close("estop")

    def _watchdog_loop(self) -> None:
        while not self._stop.wait(0.05):
            self.check_watchdog_once()

    def check_vehicle_safety_once(self) -> None:
        with self.lock:
            session_id = self.session_id
        if not session_id:
            return
        vehicle = self.status_client.get(force=True)
        if vehicle.get("active_control_safe"):
            return
        with self.lock:
            if self.session_id != session_id:
                return
            transport = self.transport
            if transport and transport.last_event:
                self.last_transport_event = transport.last_event
            self.transport = None
            self.session_id = None
            self.last_command = self._safe_command()
            self.last_sequence = -1
            self.last_browser_command_at = 0.0
            self.motion_paused = False
            self._clear_browser_lease(session_id)
            issues = vehicle.get("active_issues") or ["车辆运行时安全状态异常"]
            self.last_error = "车辆安全状态异常，已退出实车控制: " + "；".join(issues)
        if transport:
            transport.close("estop")

    def _safety_loop(self) -> None:
        while not self._stop.wait(0.5):
            self.check_vehicle_safety_once()

    def shutdown(self) -> None:
        self._stop.set()
        with self.lock:
            session_id = self.session_id or ""
        self.release(session_id, "estop")


GATEWAY = ControlGateway()


class RequestHandler(SimpleHTTPRequestHandler):
    server_version = "VehicleRemoteConsole/1.0"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(BASE_DIR), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self' https://unpkg.com; style-src 'self'; "
            "connect-src 'self' http://120.25.209.170:9999 http://47.112.103.12:1985; "
            "media-src 'self' blob:; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'",
        )
        super().end_headers()

    def _json_response(self, status: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> Dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise GatewayError("请求长度无效") from error
        if length <= 0 or length > MAX_BODY_BYTES:
            raise GatewayError("请求内容长度无效")
        try:
            return json.loads(self.rfile.read(length))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise GatewayError("请求 JSON 无效") from error

    def _authorize(self, payload: Dict[str, Any]) -> None:
        origin = self.headers.get("Origin")
        allowed_origins = {f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"}
        if origin and origin not in allowed_origins:
            raise GatewayError("请求来源不允许", HTTPStatus.FORBIDDEN)
        token = self.headers.get("X-Control-Token") or payload.get("token") or ""
        if not hmac.compare_digest(str(token), GATEWAY.token):
            raise GatewayError("控制令牌无效", HTTPStatus.FORBIDDEN)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/control/bootstrap":
            self._json_response(
                HTTPStatus.OK,
                {"ok": True, "token": GATEWAY.token, "constraints": GATEWAY.constraints()},
            )
            return
        if path == "/api/control/status":
            self._json_response(HTTPStatus.OK, GATEWAY.status())
            return
        super().do_GET()

    def do_POST(self) -> None:
        try:
            payload = self._read_json()
            self._authorize(payload)
            path = urlparse(self.path).path
            if path == "/api/control/acquire":
                result = GATEWAY.acquire(str(payload.get("vehicle_id", "")), bool(payload.get("video_ready")))
            elif path == "/api/control/command":
                result = GATEWAY.command(
                    str(payload.get("session_id", "")),
                    int(payload.get("sequence", -1)),
                    payload.get("command") or {},
                )
            elif path == "/api/control/heartbeat":
                result = GATEWAY.heartbeat(str(payload.get("session_id", "")))
            elif path == "/api/control/release":
                result = GATEWAY.release(str(payload.get("session_id", "")), "release")
            elif path == "/api/control/estop":
                result = GATEWAY.release(str(payload.get("session_id", "")), "estop")
            else:
                raise GatewayError("接口不存在", HTTPStatus.NOT_FOUND)
            self._json_response(HTTPStatus.OK, result)
        except GatewayError as error:
            self._json_response(error.status, {"ok": False, "error": str(error)})
        except TransportError as error:
            self._json_response(error.status, {"ok": False, "error": str(error)})
        except (TypeError, ValueError) as error:
            self._json_response(HTTPStatus.BAD_REQUEST, {"ok": False, "error": f"控制参数无效: {error}"})

    def log_message(self, fmt: str, *args: Any) -> None:
        if ACCESS_LOG:
            print(f"{self.address_string()} - {fmt % args}", flush=True)


def main() -> None:
    server = ThreadingHTTPServer((BIND_HOST, PORT), RequestHandler)

    def shutdown(_signum: int, _frame: Any) -> None:
        GATEWAY.shutdown()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    print(
        json.dumps(
            {
                "event": "server_ready",
                "url": f"http://{BIND_HOST}:{PORT}",
                "transport": CONTROL_TRANSPORT,
                "vehicle": CONTROL_VEHICLE_ID,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        GATEWAY.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
