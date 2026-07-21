#!/usr/bin/env python3
"""Ephemeral ROS-side safety guard for MQTT remote-drive commands."""

import json
import signal
import sys
import threading
import time

import rospy
from can_msg.msg import DCU_VCU_Cmd_0x601_cloud
from websocket_status.msg import vehicleStatus


PUBLISH_HZ = 20.0
COMMAND_TIMEOUT_S = 0.60
BRAKE_HOLD_S = 0.40
REQUIRED_CONSUMER = "/auto_ad_remote_control"
EXPECTED_SOURCE = "/mqtt_cam"
VEHICLE_STATUS_TIMEOUT_S = 0.75

lock = threading.Lock()
stop_event = threading.Event()
vehicle_state = None
last_vehicle_status_at = 0.0
last_mqtt_command_at = 0.0
last_active_gear = 0
remote_enabled = False
ever_enabled = False
last_remote_command = {
    "remote_mode_enabled": False,
    "remote_gear_cmd": 0,
    "remote_brake_percent": 100.0,
    "remote_steering_deg": 0.0,
}
stop_reason = ""


def emit(event, **fields):
    print(json.dumps({"event": event, "at": time.time(), **fields}, separators=(",", ":")), flush=True)


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


def command_callback(message):
    global last_mqtt_command_at, last_active_gear, remote_enabled, ever_enabled, stop_reason
    caller_id = (getattr(message, "_connection_header", None) or {}).get("callerid", "")
    if caller_id == rospy.get_name():
        return
    if caller_id != EXPECTED_SOURCE:
        with lock:
            if not stop_reason:
                stop_reason = "external_remote_command"
        emit("external_conflict", caller_id=caller_id)
        stop_event.set()
        return
    now = time.monotonic()
    enabled = bool(message.remote_ModeEnable)
    with lock:
        last_mqtt_command_at = now
        remote_enabled = enabled
        last_remote_command.update({
            "remote_mode_enabled": enabled,
            "remote_gear_cmd": int(message.remote_GearCmd),
            "remote_brake_percent": float(message.remote_BrakePedal),
            "remote_steering_deg": float(message.remote_SteeringAngle),
        })
        if enabled:
            ever_enabled = True
            last_active_gear = int(message.remote_GearCmd)


def input_loop():
    global stop_reason
    try:
        for line in sys.stdin:
            try:
                payload = json.loads(line)
            except (TypeError, ValueError):
                continue
            if payload.get("type") == "stop":
                with lock:
                    stop_reason = stop_reason or str(payload.get("reason") or "released")
                stop_event.set()
                return
    finally:
        with lock:
            stop_reason = stop_reason or "transport_eof"
        stop_event.set()


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


def topic_state():
    code, message, state = rospy.get_master().getSystemState()
    if code != 1:
        raise RuntimeError(message)
    publishers = dict(state[0]).get("/SocketCAN/mqtt_dcu_rmtCmd", [])
    subscribers = dict(state[1]).get("/SocketCAN/mqtt_dcu_rmtCmd", [])
    return publishers, subscribers


def build_message(mode_enable, gear, live_counter):
    message = DCU_VCU_Cmd_0x601_cloud()
    message.remote_ModeEnable = mode_enable
    message.remote_CtrMode = 2
    message.remote_SteerMode = 0
    message.remote_GearCmd = gear
    message.remote_AccPedal = 0.0
    message.remote_BrakePedal = 100.0
    message.remote_SteeringAngle = 0.0
    message.remote_SteerLamp = 0
    message.remote_UtralStopEnable = 1
    message.remote_FrontLamp = 0
    message.remote_AdScreenCmd = 0
    message.remote_LiveCounter = live_counter
    message.remote_AmbientCmd = 0
    message.reserved = 0
    return message


def publish_shutdown_sequence(publisher):
    with lock:
        active = ever_enabled and remote_enabled
        gear = last_active_gear
    rate = rospy.Rate(PUBLISH_HZ)
    if active:
        for counter in range(8):
            if rospy.is_shutdown():
                break
            publisher.publish(build_message(1, gear, counter % 15))
            rate.sleep()
    for _ in range(6):
        if rospy.is_shutdown():
            break
        publisher.publish(build_message(0, 0, 0))
        rate.sleep()


def request_stop(_signum, _frame):
    global stop_reason
    with lock:
        stop_reason = stop_reason or "signal"
    stop_event.set()


def main():
    global stop_reason
    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    rospy.init_node("vehicle_web_mqtt_guard", anonymous=False, disable_signals=True)
    publisher = rospy.Publisher("/SocketCAN/mqtt_dcu_rmtCmd", DCU_VCU_Cmd_0x601_cloud, queue_size=1)
    rospy.Subscriber("/SocketCAN/mqtt_dcu_rmtCmd", DCU_VCU_Cmd_0x601_cloud, command_callback, queue_size=20)
    rospy.Subscriber("/SocketCAN/vehicleStatus", vehicleStatus, vehicle_status_callback, queue_size=1)
    threading.Thread(target=input_loop, name="guard-input", daemon=True).start()

    deadline = time.monotonic() + 3.0
    safety_reason, current_vehicle = vehicle_safety_snapshot(require_stationary=True)
    while safety_reason == "vehicle_status_timeout" and time.monotonic() < deadline and not rospy.is_shutdown():
        time.sleep(0.05)
        safety_reason, current_vehicle = vehicle_safety_snapshot(require_stationary=True)
    if safety_reason:
        emit("not_ready", reason=safety_reason, vehicle=current_vehicle)
        return
    try:
        publishers, subscribers = topic_state()
    except Exception as error:
        emit("not_ready", reason="ROS 订阅关系读取失败: {}".format(error))
        return
    if EXPECTED_SOURCE not in publishers:
        emit("not_ready", reason="车端 MQTT 接收节点未连接", publishers=publishers)
        return
    if REQUIRED_CONSUMER not in subscribers:
        emit("not_ready", reason="实车远控消费节点未连接", subscribers=subscribers)
        return
    emit("ready", source=EXPECTED_SOURCE, consumers=subscribers, vehicle=current_vehicle)

    last_telemetry_emit = 0.0
    last_graph_check = 0.0
    try:
        while not rospy.is_shutdown() and not stop_event.wait(0.02):
            now = time.monotonic()
            safety_reason, current_vehicle = vehicle_safety_snapshot(require_stationary=False)
            if safety_reason:
                with lock:
                    stop_reason = stop_reason or safety_reason
                emit("vehicle_safety_stop", reason=safety_reason, vehicle=current_vehicle)
                break
            with lock:
                enabled = remote_enabled
                age = now - last_mqtt_command_at if last_mqtt_command_at else 999.0
                command_snapshot = dict(last_remote_command)
            if enabled and age > COMMAND_TIMEOUT_S:
                with lock:
                    stop_reason = stop_reason or "heartbeat_timeout"
                emit("failsafe", reason="heartbeat_timeout", command_age_s=round(age, 3))
                break
            if now - last_graph_check >= 0.5:
                publishers, subscribers = topic_state()
                if EXPECTED_SOURCE not in publishers or REQUIRED_CONSUMER not in subscribers:
                    with lock:
                        stop_reason = stop_reason or "control_chain_lost"
                    emit("vehicle_safety_stop", reason="control_chain_lost")
                    break
                last_graph_check = now
            if current_vehicle and now - last_telemetry_emit >= 0.5:
                emit(
                    "telemetry",
                    command_age_s=round(age, 3),
                    remote_enabled=enabled,
                    **command_snapshot,
                    **current_vehicle
                )
                last_telemetry_emit = now
    finally:
        publish_shutdown_sequence(publisher)
        emit("closed", reason=stop_reason or "process_exit")


if __name__ == "__main__":
    main()
