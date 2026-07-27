import hashlib
import pathlib
import struct
import sys
import time
import unittest
from unittest import mock


sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from mqtt_remote_transport import (  # noqa: E402
    MqttWireClient,
    _byte_swap,
    _mqtt_string,
    _read_varint,
    decode_base_message,
    decode_standard_base_message,
    encode_device_control,
    encode_route_task_plan,
    publish_navigation_stop,
    encode_standard_base_message,
    _varint,
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

    def test_device_control_stop_uses_normal_base_message_and_nested_way(self):
        payload = encode_device_control(
            vin="test-vin",
            way="stop",
            sequence=456,
            message_uuid="request-uuid",
            timestamp_ns=1785150000000000000,
        )
        base = decode_standard_base_message(payload)
        self.assertIsNotNone(base)
        self.assertEqual(base["message_id"], 0x0B05)
        self.assertEqual(base["sequence"], 456)
        body = decode_fields(base["body"])
        self.assertEqual(body[1], b"test-vin")
        self.assertEqual(body[2], 1785150000000000000)
        self.assertEqual(body[3], b"request-uuid")
        self.assertEqual(decode_fields(body[4])[1], b"stop")

    def test_additional_topic_delivers_vehicle_business_ack(self):
        topic = "dcu/client/test-vin/message/down"
        response_topic = "dcu/client/test-vin/message/up"
        responses = []
        client = MqttWireClient(
            "user",
            "password",
            topic,
            on_foreign_message=lambda _reason: None,
            on_fault=lambda _reason: None,
            state_topic="",
            additional_topics={response_topic: responses.append},
        )
        ack = b"\x08\x85\x16\x28\xC8\x03\x30\xC8\x01"
        client._handle_publish(0x30, _mqtt_string(response_topic) + b"\x00" + ack)
        self.assertEqual(responses, [ack])

    @mock.patch("mqtt_remote_transport._read_mqtt_credentials", return_value=("user", "password"))
    @mock.patch("mqtt_remote_transport.MqttWireClient")
    def test_navigation_stop_requires_business_ack_and_zero_speed(self, client_class, _credentials):
        class FakeClient:
            last_fault = ""
            state_callback = None

            def __init__(self, *args, **kwargs):
                if kwargs.get("on_vehicle_state"):
                    FakeClient.state_callback = kwargs["on_vehicle_state"]
                topics = kwargs.get("additional_topics") or {}
                self.response = next(iter(topics.values())) if topics else None

            def connect(self):
                return None

            def publish(self, payload):
                base = decode_standard_base_message(payload)
                ack = encode_standard_base_message(
                    b"",
                    sequence=base["sequence"],
                    timestamp_ns=1,
                    message_id=0x0B05,
                ) + b"\x30" + _varint(200, 32)
                self.response(ack)
                FakeClient.state_callback({"ready": True, "speed_kph": 0.0, "gear": 0})

            def wait_for_own_echo(self, _timeout):
                return True

            def close(self):
                return None

        client_class.side_effect = FakeClient
        result = publish_navigation_stop("BIT-0041", "test-vin")
        self.assertTrue(result["business_ack"])
        self.assertTrue(result["speed_zero"])
        self.assertEqual(result["response_code"], 200)
        self.assertEqual(result["vehicle_state"]["speed_kph"], 0.0)


if __name__ == "__main__":
    unittest.main()
