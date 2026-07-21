"""Direct MQTT v5 transport for BIT-0041 remote control."""

from __future__ import annotations

import base64
import collections
import hashlib
import json
import os
import pathlib
import queue
import shlex
import socket
import struct
import subprocess
import threading
import time
import uuid
from http import HTTPStatus
from typing import Any, Callable, Deque, Dict, Optional, Tuple


BASE_DIR = pathlib.Path(__file__).resolve().parent
GUARD_PATH = BASE_DIR / "vehicle_mqtt_guard.py"
MQTT_CONFIG_PATH = pathlib.Path(
    os.environ.get(
        "VEHICLE_MQTT_CONFIG",
        "/home/weilin/autoad/src/auto_ad/modules/mqtt_cam_node/src/mqtt_cam/config/config.yaml",
    )
)
MQTT_HOST = os.environ.get("VEHICLE_MQTT_HOST", "120.77.179.98")
MQTT_PORT = int(os.environ.get("VEHICLE_MQTT_PORT", "1883"))
CONTROL_VIN = "a001I3829202711775712260"
CONTROL_TOPIC = f"/auto-rd/rdu/{CONTROL_VIN}"
VEHICLE_STATE_TOPIC = f"/auto-rd/cloud/{CONTROL_VIN}"
TRANSPORT_HEARTBEAT_S = 0.10
MQTT_SEND_TIMEOUT_S = 0.50
VEHICLE_STATE_TIMEOUT_S = 1.50
REMOTE_STEERING_LIMIT_DEG = 250
REMOTE_ACCELERATOR_LIMIT_PERCENT = 30
CONTROL_SSH_TARGET = os.environ.get("VEHICLE_CONTROL_SSH_TARGET", "nvidia@100.98.77.65")
CONTROL_SSH_KEY = os.environ.get("VEHICLE_CONTROL_SSH_KEY", "/home/weilin/.ssh/id_ed25519")
REQUIRE_ROS_GUARD = os.environ.get("VEHICLE_CONTROL_REQUIRE_ROS_GUARD", "0").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}


class TransportError(RuntimeError):
    def __init__(self, message: str, status: int = HTTPStatus.SERVICE_UNAVAILABLE):
        super().__init__(message)
        self.status = int(status)


def _read_mqtt_credentials(path: pathlib.Path = MQTT_CONFIG_PATH) -> Tuple[str, str]:
    values: Dict[str, str] = {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise TransportError(f"MQTT 配置读取失败: {error}") from error
    for line in lines:
        if ":" not in line or line.lstrip().startswith("#"):
            continue
        key, value = line.split(":", 1)
        values[key.strip()] = value.strip()
    username = os.environ.get("VEHICLE_MQTT_USERNAME", values.get("username", ""))
    password = os.environ.get("VEHICLE_MQTT_PASSWORD", values.get("password", ""))
    if not username or not password:
        raise TransportError("MQTT 鉴权配置不完整")
    return username, password


def _mqtt_string(value: str) -> bytes:
    raw = value.encode("utf-8")
    if len(raw) > 65535:
        raise ValueError("MQTT string is too long")
    return struct.pack("!H", len(raw)) + raw


def _remaining_length(value: int) -> bytes:
    encoded = bytearray()
    while True:
        byte = value % 128
        value //= 128
        if value:
            byte |= 0x80
        encoded.append(byte)
        if not value:
            return bytes(encoded)


def _varint(value: int, bits: int = 64) -> bytes:
    if value < 0:
        value += 1 << bits
    encoded = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            byte |= 0x80
        encoded.append(byte)
        if not value:
            return bytes(encoded)


def _byte_swap(value: int, width: int) -> int:
    mask = (1 << (width * 8)) - 1
    return int.from_bytes((value & mask).to_bytes(width, "little"), "big")


def encode_base_message(
    body: bytes,
    sequence: int,
    timestamp_ms: Optional[int] = None,
    message_id: int = 0x0A04,
) -> bytes:
    """Encode the legacy BaseMessage protobuf used by ``mqtt_cam``."""

    timestamp_ms = int(time.time() * 1000) if timestamp_ms is None else int(timestamp_ms)
    encoded_message_id = _byte_swap(message_id, 4)
    timestamp = _byte_swap(timestamp_ms, 8)
    seq_num = _byte_swap(sequence, 4)
    return b"".join(
        [
            b"\x08" + _varint(encoded_message_id, 32),
            b"\x10" + _varint(timestamp, 64),
            b"\x28" + _varint(seq_num, 32),
            b"\x3a" + _varint(len(body), 32) + body,
        ]
    )


def _read_varint(payload: bytes, offset: int) -> Tuple[int, int]:
    value = 0
    shift = 0
    while offset < len(payload) and shift < 70:
        byte = payload[offset]
        offset += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, offset
        shift += 7
    raise ValueError("malformed protobuf varint")


def decode_base_message(payload: bytes) -> Tuple[Optional[int], bytes]:
    """Return the host-order BaseMessage ID and message body."""

    offset = 0
    message_id: Optional[int] = None
    message_body = b""
    try:
        while offset < len(payload):
            tag, offset = _read_varint(payload, offset)
            field_number = tag >> 3
            wire_type = tag & 0x07
            if wire_type == 0:
                value, offset = _read_varint(payload, offset)
                if field_number == 1:
                    message_id = _byte_swap(value, 4)
            elif wire_type == 2:
                length, offset = _read_varint(payload, offset)
                end = offset + length
                if end > len(payload):
                    raise ValueError("truncated protobuf field")
                if field_number == 7:
                    message_body = payload[offset:end]
                offset = end
            else:
                raise ValueError("unsupported protobuf wire type")
    except (IndexError, OverflowError, ValueError):
        return None, b""
    return message_id, message_body


def decode_base_message_id(payload: bytes) -> Optional[int]:
    """Return the host-order BaseMessage ID, or ``None`` for malformed data."""

    return decode_base_message(payload)[0]


def _decode_int32_fields(payload: bytes) -> Dict[int, int]:
    fields: Dict[int, int] = {}
    offset = 0
    try:
        while offset < len(payload):
            tag, offset = _read_varint(payload, offset)
            field_number = tag >> 3
            wire_type = tag & 0x07
            if wire_type == 0:
                raw, offset = _read_varint(payload, offset)
                value = _byte_swap(raw, 4)
                if value & 0x80000000:
                    value -= 1 << 32
                fields[field_number] = value
            elif wire_type == 2:
                length, offset = _read_varint(payload, offset)
                offset += length
                if offset > len(payload):
                    raise ValueError("truncated protobuf field")
            elif wire_type == 1:
                offset += 8
            elif wire_type == 5:
                offset += 4
            else:
                raise ValueError("unsupported protobuf wire type")
    except (IndexError, OverflowError, ValueError):
        return {}
    return fields


def decode_vehicle_state(payload: bytes) -> Optional[Dict[str, Any]]:
    """Decode the 0x0D01 VehStat frame published by ``mqtt_cam``."""

    message_id, body = decode_base_message(payload)
    if message_id != 0x0D01 or not body:
        return None
    fields = _decode_int32_fields(body)
    if not fields:
        return None
    mqtt_gear = fields.get(31, 0)
    can_gear = {0: 0, 1: 2, 2: 3, 3: 1}.get(mqtt_gear, -1)
    return {
        "event": "mqtt_vehicle_state",
        "at": time.time(),
        "ready": bool(fields.get(13, 0)),
        "gear": can_gear,
        "speed_kph": float(fields.get(15, 0)) / 256.0,
        "front_steering_deg": float(fields.get(32, 0)),
        "rear_steering_deg": None,
        "epb": bool(fields.get(29, 0)),
        "motor_brake": bool(fields.get(27, 0)),
        "brake_pressure": float(fields.get(28, 0)) / 2.5,
        "ad_screen_on": bool(fields.get(45, 0)),
        "vehicle_control_state": fields.get(2, 0),
        "remote_control_state": fields.get(6, 0),
        "remote_enable_response": fields.get(9, 0),
        "battery_soc": fields.get(24),
        "brake_fault": bool(fields.get(30, 0)),
        "steer_fault": bool(fields.get(34, 0)),
        "motor_fault": False,
        "battery_fault": False,
        "raw_chassis_status": False,
        "telemetry_source": "mqtt_vehicle_state",
    }


def encode_remote_command(command: Dict[str, Any], sequence: int, timestamp_ms: Optional[int] = None) -> bytes:
    """Encode the packed 0xB2 remote-drive body expected by ``mqtt_cam``."""

    timestamp_ms = int(time.time() * 1000) if timestamp_ms is None else int(timestamp_ms)
    enabled = 1 if command.get("deadman") else 0
    can_gear = int(command.get("gear", 0))
    mqtt_gear = {0: 0, 1: 3, 2: 1, 3: 2}.get(can_gear, 0)
    steering_request = max(
        -REMOTE_STEERING_LIMIT_DEG,
        min(REMOTE_STEERING_LIMIT_DEG, -int(round(float(command.get("steering", 0.0))))),
    )
    accelerator = max(
        0,
        min(
            REMOTE_ACCELERATOR_LIMIT_PERCENT,
            int(round(float(command.get("accelerator", 0.0)) * 100.0)),
        ),
    )
    brake = max(0, min(100, int(round(float(command.get("brake", 100.0))))))
    steer_lamp = int(command.get("steer_lamp", 0))

    byte_fields = [
        mqtt_gear,
        0,
        accelerator,
        brake,
        1 if command.get("front_lamp") else 0,
        0,
        1 if steer_lamp == 1 else 0,
        1 if steer_lamp == 2 else 0,
        1 if steer_lamp == 3 else 0,
        1 if command.get("ad_screen", True) else 0,
        0,
        1 if command.get("horn") else 0,
        0,
        0,
        0,
        0,
        0,
        0,
        *([0] * 12),
    ]
    if len(byte_fields) != 30:
        raise AssertionError("remote command byte layout changed")
    body = b"".join(
        [
            struct.pack("!Q", timestamp_ms & ((1 << 64) - 1)),
            bytes([0xB2, 0, 0, 0, enabled]),
            struct.pack("!h", steering_request),
            bytes(byte_fields),
            struct.pack("!hhii", 0, 0, 0, int(sequence)),
        ]
    )
    if len(body) != 57:
        raise AssertionError(f"unexpected remote command size: {len(body)}")
    return encode_base_message(body, sequence, timestamp_ms)


def decode_remote_command(payload: bytes) -> Optional[Dict[str, Any]]:
    """Decode the packed 0xB2 command carried by a 0x0A04 BaseMessage."""

    message_id, body = decode_base_message(payload)
    if message_id != 0x0A04 or len(body) < 57 or body[8] != 0xB2:
        return None
    mqtt_gear = int(body[15])
    can_gear = {0: 0, 1: 2, 2: 3, 3: 1}.get(mqtt_gear, 0)
    return {
        "deadman": bool(body[12]),
        "gear": can_gear,
        "accelerator": float(body[17]) / 100.0,
        "brake": float(body[18]),
        "steering": float(-struct.unpack("!h", body[13:15])[0]),
        "ad_screen": int(body[24]),
    }


class MqttWireClient:
    """Small MQTT v5 client sufficient for a guarded QoS-0 command stream."""

    def __init__(
        self,
        username: str,
        password: str,
        topic: str,
        on_foreign_message: Callable[[str], None],
        on_fault: Callable[[str], None],
        state_topic: str = VEHICLE_STATE_TOPIC,
        on_vehicle_state: Optional[Callable[[Dict[str, Any]], None]] = None,
        on_control_message: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> None:
        self.username = username
        self.password = password
        self.topic = topic
        self.state_topic = state_topic
        self.on_foreign_message = on_foreign_message
        self.on_fault = on_fault
        self.on_vehicle_state = on_vehicle_state
        self.on_control_message = on_control_message
        self.client_id = "vehicle-viewer-" + uuid.uuid4().hex[:16]
        self.sock: Optional[socket.socket] = None
        self._write_lock = threading.Lock()
        self._pending_lock = threading.Lock()
        self._pending: Deque[Tuple[bytes, float]] = collections.deque(maxlen=256)
        self._closed = threading.Event()
        self._subscribed = threading.Event()
        self._own_echo = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self.last_message_at = 0.0
        self.last_fault = ""

    def _send_packet(self, header: int, payload: bytes) -> None:
        packet = bytes([header]) + _remaining_length(len(payload)) + payload
        with self._write_lock:
            if not self.sock:
                raise TransportError("MQTT 控制连接未建立")
            self.sock.sendall(packet)

    def connect(self) -> None:
        try:
            sock = socket.create_connection((MQTT_HOST, MQTT_PORT), timeout=3.0)
            send_timeout_seconds = int(MQTT_SEND_TIMEOUT_S)
            send_timeout_microseconds = int((MQTT_SEND_TIMEOUT_S - send_timeout_seconds) * 1_000_000)
            sock.setsockopt(
                socket.SOL_SOCKET,
                socket.SO_SNDTIMEO,
                struct.pack("ll", send_timeout_seconds, send_timeout_microseconds),
            )
            sock.settimeout(3.0)
            self.sock = sock
            connect_properties = b"".join(
                [
                    b"\x11" + struct.pack("!I", 120),
                    b"\x21" + struct.pack("!H", 120),
                    b"\x27" + struct.pack("!I", 12000),
                    b"\x22" + struct.pack("!H", 0),
                ]
            )
            variable = (
                _mqtt_string("MQTT")
                + bytes([5, 0xC2])
                + struct.pack("!H", 10)
                + _remaining_length(len(connect_properties))
                + connect_properties
            )
            payload = (
                _mqtt_string(self.client_id)
                + _mqtt_string(self.username)
                + _mqtt_string(self.password)
            )
            self._send_packet(0x10, variable + payload)
            header, connack = self._recv_packet()
            if header >> 4 != 2 or len(connack) < 2 or connack[1] != 0:
                raise TransportError(f"MQTT 鉴权失败: {connack.hex()}")
            sock.settimeout(None)
            topics = [self.topic]
            if self.state_topic and self.state_topic != self.topic:
                topics.append(self.state_topic)
            subscribe = struct.pack("!H", 1) + b"\x00" + b"".join(
                _mqtt_string(topic) + b"\x00" for topic in topics
            )
            self._send_packet(0x82, subscribe)
            self._thread = threading.Thread(target=self._reader_loop, name="mqtt-control-reader", daemon=True)
            self._thread.start()
            if not self._subscribed.wait(3.0):
                raise TransportError("MQTT 控制主题订阅超时")
        except Exception:
            self.close()
            raise

    def _recv_exact(self, length: int) -> bytes:
        chunks = bytearray()
        while len(chunks) < length:
            if not self.sock:
                raise ConnectionError("MQTT socket closed")
            chunk = self.sock.recv(length - len(chunks))
            if not chunk:
                raise ConnectionError("MQTT peer closed the connection")
            chunks.extend(chunk)
        return bytes(chunks)

    def _recv_packet(self) -> Tuple[int, bytes]:
        header = self._recv_exact(1)[0]
        multiplier = 1
        remaining = 0
        for _ in range(4):
            byte = self._recv_exact(1)[0]
            remaining += (byte & 0x7F) * multiplier
            if not byte & 0x80:
                return header, self._recv_exact(remaining)
            multiplier *= 128
        raise ConnectionError("invalid MQTT remaining length")

    def _reader_loop(self) -> None:
        try:
            while not self._closed.is_set():
                header, packet = self._recv_packet()
                packet_type = header >> 4
                if packet_type == 9:
                    property_length, property_offset = _read_varint(packet, 2)
                    return_codes = packet[property_offset + property_length :]
                    if (
                        len(packet) < 3
                        or packet[:2] != b"\x00\x01"
                        or not return_codes
                        or any(code == 0x80 for code in return_codes)
                    ):
                        raise ConnectionError("MQTT subscription rejected")
                    self._subscribed.set()
                elif packet_type == 3:
                    self._handle_publish(header, packet)
        except Exception as error:
            if not self._closed.is_set():
                self.last_fault = str(error)
                self.on_fault(self.last_fault)

    def _handle_publish(self, header: int, packet: bytes) -> None:
        if len(packet) < 2:
            raise ConnectionError("truncated MQTT publish")
        topic_length = struct.unpack("!H", packet[:2])[0]
        offset = 2 + topic_length
        if offset > len(packet):
            raise ConnectionError("invalid MQTT publish topic")
        topic = packet[2:offset].decode("utf-8", "replace")
        qos = (header >> 1) & 0x03
        if qos:
            offset += 2
        property_length, offset = _read_varint(packet, offset)
        offset += property_length
        if offset > len(packet):
            raise ConnectionError("invalid MQTT publish properties")
        payload = packet[offset:]
        if topic == self.state_topic:
            state = decode_vehicle_state(payload)
            if state and self.on_vehicle_state:
                self.on_vehicle_state(state)
            return
        if topic != self.topic:
            return
        command = decode_remote_command(payload)
        if command and self.on_control_message:
            self.on_control_message(command)
        self.last_message_at = time.monotonic()
        if decode_base_message_id(payload) != 0x0A04:
            return
        digest = hashlib.sha256(payload).digest()
        matched = False
        now = time.monotonic()
        with self._pending_lock:
            while self._pending and now - self._pending[0][1] > 3.0:
                self._pending.popleft()
            for index, (expected, _sent_at) in enumerate(self._pending):
                if expected == digest:
                    del self._pending[index]
                    matched = True
                    break
        if not matched:
            self.on_foreign_message("检测到其他 MQTT 远控指令")
        else:
            self._own_echo.set()

    def publish(self, payload: bytes) -> None:
        digest = hashlib.sha256(payload).digest()
        with self._pending_lock:
            self._pending.append((digest, time.monotonic()))
        try:
            self._send_packet(0x30, _mqtt_string(self.topic) + b"\x00" + payload)
        except Exception:
            with self._pending_lock:
                for index, (expected, _sent_at) in enumerate(self._pending):
                    if expected == digest:
                        del self._pending[index]
                        break
            raise

    def wait_for_own_echo(self, timeout: float) -> bool:
        return self._own_echo.wait(timeout)

    def is_alive(self) -> bool:
        return bool(
            self.sock
            and self._thread
            and self._thread.is_alive()
            and not self._closed.is_set()
            and not self.last_fault
        )

    def close(self) -> None:
        if self._closed.is_set():
            return
        self._closed.set()
        sock = self.sock
        self.sock = None
        if sock:
            try:
                with self._write_lock:
                    sock.sendall(b"\xe0\x00")
            except OSError:
                pass
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            sock.close()


class RosGuardProcess:
    def __init__(self) -> None:
        self.process: Optional[subprocess.Popen[str]] = None
        self._ready = threading.Event()
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
                event = {"event": "guard_output", "message": line.strip()}
            self._last_event = event
            if event.get("event") == "telemetry":
                self._telemetry = event
            if event.get("event") in {
                "not_ready",
                "closed",
                "vehicle_safety_stop",
                "external_conflict",
                "failsafe",
            }:
                self._fault_event = event
            if event.get("event") in {"ready", "not_ready"}:
                self._startup_event = event
                self._ready.set()

    def _read_stderr(self) -> None:
        assert self.process and self.process.stderr
        for line in self.process.stderr:
            self._stderr.append(line.strip())

    def start(self) -> None:
        helper = base64.b64encode(GUARD_PATH.read_bytes()).decode("ascii")
        python_code = f"import base64;exec(compile(base64.b64decode('{helper}'),'<vehicle_mqtt_guard>','exec'))"
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
        self.process = subprocess.Popen(
            [
                "ssh",
                "-T",
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=20",
                "-o",
                "ServerAliveInterval=5",
                "-o",
                "ServerAliveCountMax=4",
                "-o",
                "StrictHostKeyChecking=no",
                "-o",
                "UserKnownHostsFile=/dev/null",
                "-i",
                CONTROL_SSH_KEY,
                CONTROL_SSH_TARGET,
                f"bash -lc {shlex.quote(remote_script)}",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        threading.Thread(target=self._read_stdout, name="mqtt-guard-stdout", daemon=True).start()
        threading.Thread(target=self._read_stderr, name="mqtt-guard-stderr", daemon=True).start()
        if not self._ready.wait(30.0):
            details = "; ".join(self._stderr) or "车端 MQTT 安全监护未就绪"
            self.close("estop")
            raise TransportError(details)
        if not self._startup_event or self._startup_event.get("event") != "ready":
            reason = (self._startup_event or {}).get("reason") or "车端 MQTT 安全监护未就绪"
            self.close("estop")
            raise TransportError(str(reason))
        if not self.is_alive():
            raise TransportError("车端 MQTT 安全监护已退出")

    def is_alive(self) -> bool:
        return bool(self.process and self.process.poll() is None)

    def close(self, reason: str = "release") -> None:
        process = self.process
        if not process:
            return
        try:
            if process.poll() is None and process.stdin:
                process.stdin.write(json.dumps({"type": "stop", "reason": reason}) + "\n")
                process.stdin.flush()
                process.stdin.close()
            process.wait(timeout=5.0)
        except (BrokenPipeError, OSError, subprocess.TimeoutExpired):
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=2.0)
                except subprocess.TimeoutExpired:
                    process.kill()
        finally:
            self.process = None

    @property
    def last_event(self) -> Optional[Dict[str, Any]]:
        return self._last_event

    @property
    def fault_event(self) -> Optional[Dict[str, Any]]:
        return self._fault_event

    @property
    def telemetry(self) -> Optional[Dict[str, Any]]:
        return self._telemetry


class GuardedMqttTransport:
    def __init__(self) -> None:
        self.guard: Optional[RosGuardProcess] = RosGuardProcess() if REQUIRE_ROS_GUARD else None
        self.client: Optional[MqttWireClient] = None
        self._lock = threading.RLock()
        self._sequence = 0
        self._last_command: Dict[str, Any] = {}
        self._was_enabled = False
        self._event: Optional[Dict[str, Any]] = None
        self._fault_event: Optional[Dict[str, Any]] = None
        self._closed = False
        self._heartbeat_stop = threading.Event()
        self._heartbeat_thread: Optional[threading.Thread] = None
        self._vehicle_state_ready = threading.Event()
        self._vehicle_state_at = 0.0
        self._mqtt_telemetry: Optional[Dict[str, Any]] = None
        self._broker_command_at = 0.0
        self._broker_command: Optional[Dict[str, Any]] = None

    def _set_fault(self, event: Dict[str, Any]) -> None:
        with self._lock:
            if not self._fault_event:
                self._fault_event = event
            self._event = event

    def _mqtt_fault(self, reason: str) -> None:
        self._set_fault({"event": "closed", "reason": "mqtt_connection_lost", "detail": reason})

    def _foreign_message(self, reason: str) -> None:
        self._set_fault({"event": "external_conflict", "reason": "external_remote_command", "detail": reason})

    def _vehicle_state(self, state: Dict[str, Any]) -> None:
        with self._lock:
            self._vehicle_state_at = time.monotonic()
            self._mqtt_telemetry = dict(state)
            self._vehicle_state_ready.set()

    def _control_message(self, command: Dict[str, Any]) -> None:
        with self._lock:
            self._broker_command_at = time.monotonic()
            self._broker_command = dict(command)

    def _validate_initial_vehicle_state(self) -> None:
        state = dict(self._mqtt_telemetry or {})
        if not state:
            raise TransportError("未收到车辆 MQTT 上行状态")
        if not state.get("ready"):
            raise TransportError("车辆未就绪")
        if abs(float(state.get("speed_kph") or 0.0)) > 0.1:
            raise TransportError("车辆未静止，拒绝接管", HTTPStatus.CONFLICT)
        if int(state.get("gear", -1)) != 0:
            raise TransportError("车辆不在 P 挡，拒绝接管", HTTPStatus.CONFLICT)
        if not (state.get("epb") or state.get("motor_brake")):
            raise TransportError("车辆驻车保持未生效，拒绝接管", HTTPStatus.CONFLICT)
        if state.get("brake_fault") or state.get("steer_fault"):
            raise TransportError("车辆制动或转向故障，拒绝接管", HTTPStatus.CONFLICT)

    def start(self) -> None:
        try:
            if self.guard:
                self.guard.start()
            username, password = _read_mqtt_credentials()
            self.client = MqttWireClient(
                username,
                password,
                CONTROL_TOPIC,
                on_foreign_message=self._foreign_message,
                on_fault=self._mqtt_fault,
                state_topic=VEHICLE_STATE_TOPIC,
                on_vehicle_state=self._vehicle_state,
                on_control_message=self._control_message,
            )
            self.client.connect()
            if not self._vehicle_state_ready.wait(3.0):
                raise TransportError("车辆 MQTT 上行状态等待超时")
            self._validate_initial_vehicle_state()
            self._heartbeat_stop.clear()
            self._heartbeat_thread = threading.Thread(
                target=self._heartbeat_loop,
                name="remote-mqtt-heartbeat",
                daemon=True,
            )
            self._heartbeat_thread.start()
            self._event = {
                "event": "ready",
                "transport": "mqtt",
                "handshake": "mqtt_connect_connack_suback_vehicle_state",
                "vehicle_state_topic": VEHICLE_STATE_TOPIC,
                "guard": self.guard.last_event if self.guard else None,
            }
        except Exception:
            self.close("estop")
            raise

    def _publish(self, command: Dict[str, Any]) -> None:
        if not self.client or not self.client.is_alive():
            raise TransportError("MQTT 实车控制链路已断开")
        self._sequence = (self._sequence + 1) & 0x7FFFFFFF
        payload = encode_remote_command(command, self._sequence)
        self.client.publish(payload)

    def _heartbeat_loop(self) -> None:
        while not self._heartbeat_stop.wait(TRANSPORT_HEARTBEAT_S):
            with self._lock:
                if self._closed:
                    return
                command = dict(self._last_command)
                if not command:
                    continue
                try:
                    self._publish(command)
                except Exception as error:
                    self._set_fault(
                        {
                            "event": "closed",
                            "reason": "mqtt_heartbeat_failed",
                            "detail": str(error),
                        }
                    )
                    return

    def send(self, payload: Dict[str, Any]) -> None:
        with self._lock:
            if self._closed:
                raise TransportError("MQTT 实车控制链路已关闭")
            command = dict(payload)
            self._publish(command)
            self._last_command = command
            if command.get("deadman"):
                self._was_enabled = True

    def wait_for_command_echo(self, timeout: float = 1.0) -> bool:
        client = self.client
        return bool(client and client.wait_for_own_echo(timeout))

    def close(self, reason: str = "release") -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._heartbeat_stop.set()
            client = self.client
            if client and client.is_alive():
                try:
                    last_gear = int(self._last_command.get("gear", 0))
                    if self._was_enabled:
                        brake = {
                            "deadman": True,
                            "gear": last_gear,
                            "accelerator": 0.0,
                            "brake": 100.0,
                            "steering": 0.0,
                            "steer_lamp": 0,
                            "front_lamp": 0,
                            "ad_screen": 1,
                            "horn": 0,
                        }
                        for _ in range(8):
                            self._publish(brake)
                            time.sleep(0.05)
                    disabled = {
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
                    for _ in range(4):
                        self._publish(disabled)
                        time.sleep(0.05)
                except Exception as error:
                    self._set_fault({"event": "closed", "reason": "mqtt_release_failed", "detail": str(error)})
            if client:
                client.close()
            self.client = None
        if self.guard:
            self.guard.close(reason)
        heartbeat_thread = self._heartbeat_thread
        if heartbeat_thread and heartbeat_thread is not threading.current_thread():
            heartbeat_thread.join(timeout=1.0)
        self._heartbeat_thread = None

    def is_alive(self) -> bool:
        with self._lock:
            state_fresh = bool(
                self._vehicle_state_at
                and time.monotonic() - self._vehicle_state_at <= VEHICLE_STATE_TIMEOUT_S
            )
            if self._vehicle_state_at and not state_fresh and not self._fault_event:
                self._set_fault(
                    {
                        "event": "closed",
                        "reason": "vehicle_state_timeout",
                        "detail": "车辆 MQTT 上行状态超过 1.5 秒未更新",
                    }
                )
            return bool(
                not self._closed
                and self.client
                and self.client.is_alive()
                and state_fresh
                and (not self.guard or self.guard.is_alive())
                and not self.fault_event
            )

    @property
    def last_event(self) -> Optional[Dict[str, Any]]:
        return self._event or (self.guard.last_event if self.guard else None)

    @property
    def fault_event(self) -> Optional[Dict[str, Any]]:
        return self._fault_event or (self.guard.fault_event if self.guard else None)

    @property
    def telemetry(self) -> Optional[Dict[str, Any]]:
        if self.guard and self.guard.telemetry:
            return self.guard.telemetry
        with self._lock:
            if not self._mqtt_telemetry:
                return None
            telemetry = dict(self._mqtt_telemetry)
            telemetry["state_age_s"] = max(0.0, time.monotonic() - self._vehicle_state_at)
            if self._broker_command:
                telemetry["broker_command"] = dict(self._broker_command)
                telemetry["broker_command_age_s"] = max(
                    0.0,
                    time.monotonic() - self._broker_command_at,
                )
            return telemetry
