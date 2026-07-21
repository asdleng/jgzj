import pathlib
import struct
import sys
import threading
import time
import unittest


REMOTE_DRIVE_DIR = pathlib.Path(__file__).resolve().parents[1] / "backend" / "remote-drive"
sys.path.insert(0, str(REMOTE_DRIVE_DIR))

from mqtt_remote_transport import (  # noqa: E402
    GuardedMqttTransport,
    decode_base_message_id,
    decode_remote_command,
    decode_vehicle_state,
    encode_base_message,
    encode_remote_command,
)
from server import (  # noqa: E402
    COMMAND_TIMEOUT_S,
    MOTION_COMMAND_TIMEOUT_S,
    VEHICLE_COMMAND_TIMEOUT_S,
    ControlGateway,
    MockTransport,
)


def read_varint(payload, offset):
    value = 0
    shift = 0
    while True:
        byte = payload[offset]
        offset += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, offset
        shift += 7


def remote_body(payload):
    offset = 0
    while offset < len(payload):
        tag, offset = read_varint(payload, offset)
        field_number = tag >> 3
        wire_type = tag & 0x07
        if wire_type == 0:
            _, offset = read_varint(payload, offset)
            continue
        if wire_type != 2:
            raise AssertionError(f"unexpected wire type {wire_type}")
        length, offset = read_varint(payload, offset)
        value = payload[offset : offset + length]
        offset += length
        if field_number == 7:
            return value
    raise AssertionError("remote body missing")


def encode_varint(value):
    if value < 0:
        value += 1 << 64
    result = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            byte |= 0x80
        result.append(byte)
        if not value:
            return bytes(result)


def encode_host_int32(field_number, value):
    swapped = int.from_bytes((value & 0xFFFFFFFF).to_bytes(4, "little"), "big")
    return encode_varint(field_number << 3) + encode_varint(swapped)


class FakeStatusClient:
    def get(self, force=False):
        return {
            "ready_for_acquire": True,
            "issues": [],
            "active_control_safe": True,
            "active_issues": [],
            "speed_kph": 0.0,
            "gear": "P",
        }


class FakeMqttClient:
    def __init__(self):
        self.payloads = []
        self.alive = True

    def publish(self, payload):
        self.payloads.append(payload)

    def is_alive(self):
        return self.alive

    def close(self):
        self.alive = False


class FakeGuard:
    last_event = None
    fault_event = None
    telemetry = None

    def close(self, reason="release"):
        self.closed_reason = reason

    def is_alive(self):
        return True


class BlockingMockTransport(MockTransport):
    def __init__(self):
        super().__init__()
        self.block_commands = False
        self.send_started = threading.Event()
        self.release_send = threading.Event()

    def send(self, payload):
        if self.block_commands:
            self.send_started.set()
            self.release_send.wait(timeout=2.0)
        super().send(payload)


class RemoteDriveControlTest(unittest.TestCase):
    def test_remote_payload_preserves_screen_and_full_steering_command(self):
        payload = encode_remote_command(
            {
                "deadman": True,
                "gear": 0,
                "accelerator": 0.0,
                "brake": 100.0,
                "steering": 250.0,
                "ad_screen": 1,
            },
            sequence=7,
            timestamp_ms=1,
        )
        self.assertEqual(decode_base_message_id(payload), 0x0A04)
        body = remote_body(payload)
        self.assertEqual(struct.unpack("!h", body[13:15])[0], -250)
        self.assertEqual(body[12], 1)
        self.assertEqual(body[24], 1)
        self.assertEqual(
            decode_remote_command(payload),
            {
                "deadman": True,
                "gear": 0,
                "accelerator": 0.0,
                "brake": 100.0,
                "steering": 250.0,
                "ad_screen": 1,
            },
        )

    def test_vehicle_state_decoder_reads_original_mqtt_cam_status_frame(self):
        body = b"".join(
            [
                encode_host_int32(13, 1),
                encode_host_int32(15, 0),
                encode_host_int32(24, 82),
                encode_host_int32(27, 1),
                encode_host_int32(29, 1),
                encode_host_int32(31, 0),
                encode_host_int32(32, -37),
                encode_host_int32(45, 1),
            ]
        )
        state = decode_vehicle_state(
            encode_base_message(body, sequence=5, timestamp_ms=1, message_id=0x0D01)
        )
        self.assertIsNotNone(state)
        self.assertTrue(state["ready"])
        self.assertEqual(state["gear"], 0)
        self.assertEqual(state["speed_kph"], 0.0)
        self.assertEqual(state["front_steering_deg"], -37.0)
        self.assertTrue(state["epb"])
        self.assertTrue(state["motor_brake"])
        self.assertTrue(state["ad_screen_on"])
        self.assertEqual(state["battery_soc"], 82)

    def test_direct_mqtt_transport_does_not_require_ssh_guard(self):
        self.assertIsNone(GuardedMqttTransport().guard)

    def test_gateway_uses_5s_browser_lease_and_600ms_motion_stop(self):
        now = [100.0]
        transport = MockTransport()
        gateway = ControlGateway(
            status_client=FakeStatusClient(),
            transport_factory=lambda: transport,
            time_fn=lambda: now[0],
            start_watchdog=False,
        )
        session = gateway.acquire("BIT-0041")["session_id"]
        result = gateway.command(
            session,
            1,
            {"deadman": True, "gear": "P", "brake": 100, "steering": 400},
        )
        self.assertEqual(result["applied"]["steering"], 250.0)
        self.assertEqual(result["applied"]["ad_screen"], 1)
        self.assertEqual(COMMAND_TIMEOUT_S, 5.0)
        self.assertEqual(MOTION_COMMAND_TIMEOUT_S, 0.6)
        self.assertEqual(VEHICLE_COMMAND_TIMEOUT_S, 1.5)
        self.assertEqual(gateway.constraints()["motion_command_timeout_ms"], 600)
        self.assertEqual(gateway.constraints()["vehicle_command_timeout_ms"], 1500)
        now[0] += 0.59
        gateway.check_watchdog_once()
        self.assertTrue(gateway.status()["session_active"])
        now[0] += 0.02
        gateway.check_watchdog_once()
        paused = gateway.status()
        self.assertTrue(paused["session_active"])
        self.assertTrue(paused["motion_paused"])
        self.assertEqual(paused["last_command"]["gear"], "P")
        self.assertEqual(paused["last_command"]["brake"], 100.0)
        self.assertEqual(paused["last_command"]["steering"], 0.0)
        held = gateway.command(
            session,
            2,
            {"deadman": True, "gear": "P", "brake": 100, "steering": 250},
        )
        self.assertTrue(held["motion_paused"])
        self.assertEqual(held["applied"]["steering"], 0.0)
        neutral = gateway.command(
            session,
            3,
            {"deadman": True, "gear": "P", "brake": 100, "steering": 0},
        )
        self.assertFalse(neutral["motion_paused"])
        now[0] += 5.01
        gateway.check_watchdog_once()
        self.assertFalse(gateway.status()["session_active"])

    def test_lightweight_heartbeat_renews_browser_lease_without_new_command(self):
        now = [200.0]
        transport = MockTransport()
        gateway = ControlGateway(
            status_client=FakeStatusClient(),
            transport_factory=lambda: transport,
            time_fn=lambda: now[0],
            start_watchdog=False,
        )
        session = gateway.acquire("BIT-0041")["session_id"]
        now[0] += 4.70
        result = gateway.heartbeat(session)
        self.assertTrue(result["session_active"])
        now[0] += 4.70
        gateway.check_watchdog_once()
        self.assertTrue(gateway.status()["session_active"])
        now[0] += 0.31
        gateway.check_watchdog_once()
        self.assertFalse(gateway.status()["session_active"])

    def test_lightweight_heartbeat_does_not_wait_for_blocked_transport_send(self):
        transport = BlockingMockTransport()
        gateway = ControlGateway(
            status_client=FakeStatusClient(),
            transport_factory=lambda: transport,
            start_watchdog=False,
        )
        session = gateway.acquire("BIT-0041")["session_id"]
        transport.block_commands = True
        command_thread = threading.Thread(
            target=lambda: gateway.command(
                session,
                1,
                {"deadman": True, "gear": "P", "brake": 100, "steering": 0},
            ),
            daemon=True,
        )
        command_thread.start()
        self.assertTrue(transport.send_started.wait(timeout=0.5))
        started_at = time.monotonic()
        heartbeat = gateway.heartbeat(session)
        elapsed = time.monotonic() - started_at
        self.assertTrue(heartbeat["session_active"])
        self.assertLess(elapsed, 0.1)
        transport.release_send.set()
        command_thread.join(timeout=1.0)
        self.assertFalse(command_thread.is_alive())

    def test_transport_repeats_latest_command_without_browser_round_trip(self):
        transport = GuardedMqttTransport()
        transport.guard = FakeGuard()
        transport.client = FakeMqttClient()
        transport._last_command = {
            "deadman": True,
            "gear": 0,
            "accelerator": 0.0,
            "brake": 100.0,
            "steering": -250.0,
            "ad_screen": 1,
        }
        transport._heartbeat_thread = threading.Thread(
            target=transport._heartbeat_loop,
            daemon=True,
        )
        transport._heartbeat_thread.start()
        time.sleep(0.26)
        repeated = list(transport.client.payloads)
        self.assertGreaterEqual(len(repeated), 2)
        for payload in repeated:
            body = remote_body(payload)
            self.assertEqual(struct.unpack("!h", body[13:15])[0], 250)
            self.assertEqual(body[24], 1)
        transport.close("release")
        self.assertFalse(transport.client)


if __name__ == "__main__":
    unittest.main()
