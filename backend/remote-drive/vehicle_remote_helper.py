#!/usr/bin/env python3
"""Ephemeral ROS publisher for the laptop remote-drive gateway.

This file is executed from memory on the vehicle media controller. It is not
installed on the vehicle. stdin carries JSON commands from the localhost
gateway; loss of stdin or command heartbeat independently triggers braking and
remote-mode release on the vehicle side.
"""

import json
import os
import signal
import sys
import threading
import time

import rospy
from can_msg.msg import DCU_VCU_Cmd_0x601_cloud
from websocket_status.msg import vehicleStatus


PUBLISH_HZ = 20.0
COMMAND_TIMEOUT_S = 2.0
BRAKE_HOLD_S = 0.40
MAX_STEERING_DEG = 180.0
MAX_ACCEL = 0.25
REQUIRED_CONSUMER = "/auto_ad_remote_control"
VEHICLE_STATUS_TIMEOUT_S = 0.75

lock = threading.Lock()
stop_event = threading.Event()
command = {"deadman": False, "gear": 0, "accelerator": 0.0, "brake": 100.0, "steering": 0.0}
last_command_at = 0.0
last_active_gear = 0
was_active = False
brake_until = 0.0
latched_stop_reason = ""
vehicle_state = None
last_vehicle_status_at = 0.0


def emit(event, **fields):
    payload = {"event": event, "at": time.time(), **fields}
    print(json.dumps(payload, separators=(",", ":")), flush=True)


def clamp(value, low, high):
    return max(low, min(high, value))


def normalize(raw):
    accelerator = clamp(float(raw.get("accelerator", 0.0)), 0.0, MAX_ACCEL)
    brake = clamp(float(raw.get("brake", 100.0)), 0.0, 100.0)
    if brake > 0.0:
        accelerator = 0.0
    return {
        "deadman": bool(raw.get("deadman", False)),
        "gear": int(clamp(int(raw.get("gear", 0)), 0, 3)),
        "accelerator": accelerator,
        "brake": brake,
        "steering": clamp(float(raw.get("steering", 0.0)), -MAX_STEERING_DEG, MAX_STEERING_DEG),
        "steer_lamp": int(clamp(int(raw.get("steer_lamp", 0)), 0, 3)),
        "front_lamp": 1 if raw.get("front_lamp") else 0,
        "horn": 1 if raw.get("horn") else 0,
    }


def input_loop():
    global command, last_command_at, latched_stop_reason
    try:
        for line in sys.stdin:
            try:
                raw = json.loads(line)
            except (TypeError, ValueError):
                emit("invalid_json")
                continue
            message_type = raw.get("type", "command")
            with lock:
                if message_type == "estop":
                    latched_stop_reason = "software_estop"
                    command = normalize({"deadman": False})
                    last_command_at = time.monotonic()
                elif message_type == "release":
                    latched_stop_reason = latched_stop_reason or "released"
                    command = normalize({"deadman": False})
                    last_command_at = time.monotonic()
                elif message_type == "command" and not latched_stop_reason:
                    command = normalize(raw)
                    last_command_at = time.monotonic()
    finally:
        with lock:
            latched_stop_reason = latched_stop_reason or "transport_eof"
        stop_event.set()


def external_command_callback(message):
    global latched_stop_reason
    caller_id = (getattr(message, "_connection_header", None) or {}).get("callerid", "")
    if caller_id and caller_id != rospy.get_name():
        with lock:
            if not latched_stop_reason:
                latched_stop_reason = "external_remote_command"
                emit("external_conflict", caller_id=caller_id)


def vehicle_status_callback(message):
    global vehicle_state, last_vehicle_status_at
    state = {
        "ready": bool(message.vehReadySt),
        "gear": int(message.vehShiftPosition),
        "speed_kph": float(message.vehSpeed),
        "front_steering_deg": float(message.vehFrontSteeringAngle),
        "rear_steering_deg": float(message.vehRearSteeringAngle),
        "emergency_stop": bool(message.vehEmergencyStop),
        "collision_stop": bool(message.vehCollisionStopFlag),
        "ultrasonic_stop": bool(message.VCU_DCU_UtralStopFlag),
    }
    with lock:
        vehicle_state = state
        last_vehicle_status_at = time.monotonic()


def vehicle_safety_snapshot(require_stationary=False):
    now = time.monotonic()
    with lock:
        state = dict(vehicle_state) if vehicle_state else None
        age = now - last_vehicle_status_at if last_vehicle_status_at else 999.0
    if not state or age > VEHICLE_STATUS_TIMEOUT_S:
        return "vehicle_status_timeout", state
    if not state["ready"]:
        return "vehicle_not_ready", state
    if state["emergency_stop"]:
        return "physical_emergency_stop", state
    if state["collision_stop"]:
        return "collision_stop", state
    if state["ultrasonic_stop"]:
        return "ultrasonic_stop", state
    if require_stationary and abs(state["speed_kph"]) > 0.1:
        return "vehicle_not_stationary", state
    return "", state


def build_message(mode_enable, gear, accelerator, brake, steering, live_counter, state):
    message = DCU_VCU_Cmd_0x601_cloud()
    message.remote_ModeEnable = mode_enable
    message.remote_CtrMode = 2
    message.remote_SteerMode = 0
    message.remote_GearCmd = gear
    message.remote_AccPedal = accelerator
    message.remote_BrakePedal = brake
    message.remote_SteeringAngle = steering
    message.remote_SteerLamp = state.get("steer_lamp", 0) if mode_enable else 0
    message.remote_UtralStopEnable = 1
    message.remote_FrontLamp = state.get("front_lamp", 0) if mode_enable else 0
    message.remote_AdScreenCmd = 0
    message.remote_LiveCounter = live_counter
    message.remote_AmbientCmd = 0
    message.reserved = 0
    return message


def publish_shutdown_sequence(publisher, gear):
    rate = rospy.Rate(PUBLISH_HZ)
    safe_state = normalize({"deadman": False})
    for counter in range(8):
        if rospy.is_shutdown():
            break
        publisher.publish(build_message(1, gear, 0.0, 100.0, 0.0, counter % 15, safe_state))
        rate.sleep()
    for _ in range(6):
        if rospy.is_shutdown():
            break
        publisher.publish(build_message(0, 0, 0.0, 100.0, 0.0, 0, safe_state))
        rate.sleep()


def request_stop(_signum, _frame):
    stop_event.set()


def topic_subscribers(topic):
    code, message, state = rospy.get_master().getSystemState()
    if code != 1:
        raise RuntimeError(message)
    subscribers = dict(state[1])
    return subscribers.get(topic, [])


def main():
    global was_active, brake_until, last_active_gear, latched_stop_reason
    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    rospy.init_node("vehicle_web_remote_gateway", anonymous=False, disable_signals=True)
    publisher = rospy.Publisher("/SocketCAN/mqtt_dcu_rmtCmd", DCU_VCU_Cmd_0x601_cloud, queue_size=1)
    rospy.Subscriber("/SocketCAN/mqtt_dcu_rmtCmd", DCU_VCU_Cmd_0x601_cloud, external_command_callback, queue_size=10)
    rospy.Subscriber("/SocketCAN/vehicleStatus", vehicleStatus, vehicle_status_callback, queue_size=1)
    reader = threading.Thread(target=input_loop, name="command-input", daemon=True)
    reader.start()
    deadline = time.monotonic() + 3.0
    while publisher.get_num_connections() < 1 and time.monotonic() < deadline and not rospy.is_shutdown():
        time.sleep(0.05)
    try:
        consumers = topic_subscribers("/SocketCAN/mqtt_dcu_rmtCmd")
    except Exception as error:
        emit("not_ready", reason="ROS 订阅关系读取失败: {}".format(error))
        return
    if REQUIRED_CONSUMER not in consumers:
        emit("not_ready", reason="实车远控消费节点未连接", consumers=consumers)
        return
    vehicle_deadline = time.monotonic() + 3.0
    safety_reason, current_vehicle = vehicle_safety_snapshot(require_stationary=True)
    while safety_reason == "vehicle_status_timeout" and time.monotonic() < vehicle_deadline and not rospy.is_shutdown():
        time.sleep(0.05)
        safety_reason, current_vehicle = vehicle_safety_snapshot(require_stationary=True)
    if safety_reason:
        emit("not_ready", reason=safety_reason, vehicle=current_vehicle)
        return
    emit("ready", node=rospy.get_name(), consumers=consumers, vehicle=current_vehicle)
    if os.environ.get("VEHICLE_REMOTE_PROBE_ONLY") == "1":
        emit("probe_ok", vehicle=current_vehicle)
        return

    rate = rospy.Rate(PUBLISH_HZ)
    live_counter = 0
    last_telemetry_emit = 0.0
    try:
        while not rospy.is_shutdown() and not stop_event.is_set():
            now = time.monotonic()
            with lock:
                state = dict(command)
                age = now - last_command_at if last_command_at else 999.0
                stop_reason = latched_stop_reason
            safety_reason, current_vehicle = vehicle_safety_snapshot(require_stationary=False)
            if safety_reason and not stop_reason:
                with lock:
                    latched_stop_reason = safety_reason
                    stop_reason = latched_stop_reason
                emit("vehicle_safety_stop", reason=safety_reason, vehicle=current_vehicle)
            if was_active and age > COMMAND_TIMEOUT_S and not stop_reason:
                with lock:
                    latched_stop_reason = "heartbeat_timeout"
                    stop_reason = latched_stop_reason
            active = state.get("deadman", False) and age <= COMMAND_TIMEOUT_S and not stop_reason
            if active:
                last_active_gear = state["gear"]
                was_active = True
                brake_until = 0.0
                live_counter = (live_counter + 1) % 15
                message = build_message(
                    1,
                    state["gear"],
                    state["accelerator"],
                    state["brake"],
                    state["steering"],
                    live_counter,
                    state,
                )
            else:
                if was_active and brake_until == 0.0:
                    brake_until = now + BRAKE_HOLD_S
                    emit("failsafe", reason=stop_reason or ("heartbeat_timeout" if age > COMMAND_TIMEOUT_S else "deadman_released"))
                if now < brake_until:
                    live_counter = (live_counter + 1) % 15
                    message = build_message(1, last_active_gear, 0.0, 100.0, 0.0, live_counter, state)
                else:
                    was_active = False
                    live_counter = 0
                    message = build_message(0, 0, 0.0, 100.0, 0.0, 0, state)
            publisher.publish(message)
            if current_vehicle and now - last_telemetry_emit >= 0.5:
                emit("telemetry", **current_vehicle)
                last_telemetry_emit = now
            rate.sleep()
    finally:
        publish_shutdown_sequence(publisher, last_active_gear)
        emit("closed", reason=latched_stop_reason or "process_exit")


if __name__ == "__main__":
    main()
