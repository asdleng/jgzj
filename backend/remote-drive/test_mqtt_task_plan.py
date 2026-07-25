import hashlib
import pathlib
import struct
import sys
import time
import unittest


sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from mqtt_remote_transport import (  # noqa: E402
    MqttWireClient,
    _byte_swap,
    _mqtt_string,
    _read_varint,
    decode_base_message,
    encode_route_task_plan,
)


def decode_fields(payload):
    fields = {}
    offset = 0
    while offset < len(payload):
        tag, offset = _read_varint(payload, offset)
        field_number = tag >> 3
        wire_type = tag & 7
        if wire_type == 0:
            value, offset = _read_varint(payload, offset)
        elif wire_type == 2:
            length, offset = _read_varint(payload, offset)
            value = payload[offset : offset + length]
            offset += length
        elif wire_type == 5:
            value = struct.unpack("<f", payload[offset : offset + 4])[0]
            offset += 4
        else:
            raise AssertionError(f"unexpected wire type {wire_type}")
        fields[field_number] = value
    return fields


class RouteTaskPlanEncodingTest(unittest.TestCase):
    def test_current_route_command_fields_and_byte_order(self):
        payload = encode_route_task_plan(
            main_route_id="route_main",
            auxiliary_route_id="route_charge",
            start_time="16:05:00",
            end_time="18:00:00",
            recharge_power=30,
            speed_kph=2.0,
            run_count=55,
            sequence=123,
            timestamp_ms=1784966700000,
        )
        message_id, body = decode_base_message(payload)
        self.assertEqual(message_id, 0x0A08)
        fields = decode_fields(body)
        self.assertEqual(fields[2], b"route_main")
        self.assertEqual(fields[3], b"16:05:00")
        self.assertEqual(fields[4], b"18:00:00")
        self.assertEqual(fields[5], 30)
        self.assertAlmostEqual(fields[6], 2.0)
        self.assertEqual(fields[7], _byte_swap(55, 4))
        self.assertEqual(fields[10], b"route_charge")

    def test_non_remote_message_can_receive_own_broker_echo(self):
        topic = "/auto-rd/rdu/test-vin"
        payload = encode_route_task_plan(
            "route_main",
            "route_charge",
            "16:05:00",
            "18:00:00",
            30,
            2.0,
            55,
            123,
            1784966700000,
        )
        foreign = []
        client = MqttWireClient(
            "user",
            "password",
            topic,
            on_foreign_message=foreign.append,
            on_fault=lambda _reason: None,
            state_topic="",
        )
        client._pending.append((hashlib.sha256(payload).digest(), time.monotonic()))
        client._handle_publish(0x30, _mqtt_string(topic) + b"\x00" + payload)
        self.assertTrue(client.wait_for_own_echo(0))
        self.assertEqual(foreign, [])


if __name__ == "__main__":
    unittest.main()
