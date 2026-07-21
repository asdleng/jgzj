#!/usr/bin/env python3
"""Ephemeral ROS-side safety guard for MQTT remote-drive commands."""

import json
import signal
import sys
import threading
import time

import rospy
from can_msg.msg import Chassis_CAN_Status, DCU_VCU_Cmd_0x601_cloud


PUBLISH_HZ = 20.0
COMMAND_TIMEOUT_S = 0.60
BRAKE_HOLD_S = 0.40
REQUIRED_CONSUMER = "/auto_ad_remote_control"
EXPECTED_SOURCE = "/mqtt_cam"
DOWNSTREAM_TOPIC = "/SocketCAN/DCU_VCU_remote_control_CAN_cmd"
DOWNSTREAM_SOURCE = "/auto_ad_remote_control"
DOWNSTREAM_CONSUMER = "/SocketCAN/auto_ad_can_driver"
VEHICLE_STATUS_TIMEOUT_S = 0.75

lock = threading.Lock()
stop_event = threading.Event()
vehicle_state = None
last_vehicle_status_at = 0.0
last_mqtt_command_at = 0.0
last_downstream_command_at = 0.0
last_active_gear = 0
remote_enabled = False
ever_enabled = False
last_remote_command = {
    "remote_mode_enabled": False,
    "remote_gear_cmd": 0,
    "remote_brake_percent": 100.0,
    "remote_steering_deg": 0.0,
}
last_downstream_command = {
    "downstream_mode_value": 0,
    "downstream_gear_cmd": 0,
    "downstream_brake_percent": 100.0,
    "downstream_steering_deg": 0.0,
}
stop_reason = ""


def emit(event, **fields):
    print(json.dumps({"event": event, "at": time.time(), **fields}, separators=(",", ":")), flush=True)


def chassis_status_callback(message):
    global vehicle_state, last_vehicle_status_at
    joystick = message.obejct_VCU_DCU_Joystick_0x300
    motor = message.object_VCU_DCU_Motor_St_0x302
    vehicle = message.object_VCU_DCU_Veh_St_0x306
    vehicle_extra = message.object_VCU_DCU_Veh_St_0x307
    state = {
        "ready": bool(vehicle.vehReadySt),
        "gear": int(vehicle.vehShiftPosition),
        "speed_kph": float(vehicle.vehSpeed),
        "front_steering_deg": float(vehicle.vehFrontSteeringAngle),
        "rear_steering_deg": float(vehicle.vehRearSteeringAngle),
        "emergency_stop": bool(vehicle.vehEmergencyStop),
        "collision_stop": bool(vehicle.vehCollisionStopFlag),
        "ultrasonic_stop": bool(vehicle.VCU_DCU_UtralStopFlag),
        "epb": bool(joystick.IDM_EPB_St),
        "motor_brake": bool(motor.motorBrake),
        "brake_pressure": float(vehicle_extra.veh_brake_pressure),
        "running_mode": int(vehicle.vehRunningMode),
        "brake_fault": bool(vehicle.brakeFaultLampSt),
        "steer_fault": bool(vehicle.steerFaultLampSt),
        "motor_fault": bool(vehicle.motorFaultLampSt),
        "battery_fault": bool(vehicle.batFaultLampSt),
        "raw_chassis_status": True,
    }
    with lock:
        vehicle_state = state
        last_vehicle_status_at = time.monotonic()


def mqtt_command_callback(message):
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


def downstream_command_callback(message):
    global last_downstream_command_at, stop_reason
    caller_id = (getattr(message, "_connection_header", None) or {}).get("callerid", "")
    if caller_id != DOWNSTREAM_SOURCE:
        with lock:
            if not stop_reason:
                stop_reason = "external_downstream_command"
        emit("external_conflict", topic=DOWNSTREAM_TOPIC, caller_id=caller_id)
        stop_event.set()
        return
    with lock:
        last_downstream_command_at = time.monotonic()
        last_downstream_command.update({
            "downstream_mode_value": int(message.remote_ModeEnable),
            "downstream_gear_cmd": int(message.remote_GearCmd),
            "downstream_brake_percent": float(message.remote_BrakePedal),
            "downstream_steering_deg": float(message.remote_SteeringAngle),
        })


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


def vehicle_safety_snapshot(require_stationary=False, require_park=False):
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
    if state["brake_fault"]:
        return "brake_fault", state
    if state["steer_fault"]:
        return "steer_fault", state
    if state["motor_fault"]:
        return "motor_fault", state
    if state["battery_fault"]:
        return "battery_fault", state
    if require_stationary and abs(state["speed_kph"]) > 0.1:
        return "vehicle_not_stationary", state
    if require_park and state["gear"] != 0:
        return "vehicle_not_parked", state
    if require_park and not (state["epb"] or state["motor_brake"]):
        return "vehicle_not_held", state
    return "", state


def topic_state():
    code, message, state = rospy.get_master().getSystemState()
    if code != 1:
        raise RuntimeError(message)
    publishers = dict(state[0])
    subscribers = dict(state[1])
    return {
        "mqtt_publishers": publishers.get("/SocketCAN/mqtt_dcu_rmtCmd", []),
        "mqtt_subscribers": subscribers.get("/SocketCAN/mqtt_dcu_rmtCmd", []),
        "downstream_publishers": publishers.get(DOWNSTREAM_TOPIC, []),
        "downstream_subscribers": subscribers.get(DOWNSTREAM_TOPIC, []),
    }


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
    rospy.Subscriber("/SocketCAN/mqtt_dcu_rmtCmd", DCU_VCU_Cmd_0x601_cloud, mqtt_command_callback, queue_size=20)
    rospy.Subscriber(DOWNSTREAM_TOPIC, DCU_VCU_Cmd_0x601_cloud, downstream_command_callback, queue_size=20)
    rospy.Subscriber("/SocketCAN/Chassis_CAN_status", Chassis_CAN_Status, chassis_status_callback, queue_size=1)
    threading.Thread(target=input_loop, name="guard-input", daemon=True).start()

    deadline = time.monotonic() + 3.0
    safety_reason, current_vehicle = vehicle_safety_snapshot(require_stationary=True, require_park=True)
    while safety_reason == "vehicle_status_timeout" and time.monotonic() < deadline and not rospy.is_shutdown():
        time.sleep(0.05)
        safety_reason, current_vehicle = vehicle_safety_snapshot(require_stationary=True, require_park=True)
    if safety_reason:
        emit("not_ready", reason=safety_reason, vehicle=current_vehicle)
        return
    try:
        graph = topic_state()
    except Exception as error:
        emit("not_ready", reason="ROS 订阅关系读取失败: {}".format(error))
        return
    if EXPECTED_SOURCE not in graph["mqtt_publishers"]:
        emit("not_ready", reason="车端 MQTT 接收节点未连接", graph=graph)
        return
    if REQUIRED_CONSUMER not in graph["mqtt_subscribers"]:
        emit("not_ready", reason="实车远控消费节点未连接", graph=graph)
        return
    if DOWNSTREAM_SOURCE not in graph["downstream_publishers"]:
        emit("not_ready", reason="远控节点没有下游输出", graph=graph)
        return
    if DOWNSTREAM_CONSUMER not in graph["downstream_subscribers"]:
        emit("not_ready", reason="CAN 驱动未订阅远控输出", graph=graph)
        return
    emit("ready", graph=graph, vehicle=current_vehicle)

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
                downstream_age = now - last_downstream_command_at if last_downstream_command_at else 999.0
                command_snapshot = dict(last_remote_command)
                downstream_snapshot = dict(last_downstream_command)
            if enabled and age > COMMAND_TIMEOUT_S:
                with lock:
                    stop_reason = stop_reason or "heartbeat_timeout"
                emit("failsafe", reason="heartbeat_timeout", command_age_s=round(age, 3))
                break
            if enabled and downstream_age > COMMAND_TIMEOUT_S:
                with lock:
                    stop_reason = stop_reason or "downstream_timeout"
                emit("failsafe", reason="downstream_timeout", downstream_command_age_s=round(downstream_age, 3))
                break
            if now - last_graph_check >= 0.5:
                graph = topic_state()
                if (
                    EXPECTED_SOURCE not in graph["mqtt_publishers"]
                    or REQUIRED_CONSUMER not in graph["mqtt_subscribers"]
                    or DOWNSTREAM_SOURCE not in graph["downstream_publishers"]
                    or DOWNSTREAM_CONSUMER not in graph["downstream_subscribers"]
                ):
                    with lock:
                        stop_reason = stop_reason or "control_chain_lost"
                    emit("vehicle_safety_stop", reason="control_chain_lost", graph=graph)
                    break
                last_graph_check = now
            if current_vehicle and now - last_telemetry_emit >= 0.5:
                emit(
                    "telemetry",
                    command_age_s=round(age, 3),
                    downstream_command_age_s=round(downstream_age, 3),
                    remote_enabled=enabled,
                    **command_snapshot,
                    **downstream_snapshot,
                    **current_vehicle
                )
                last_telemetry_emit = now
    finally:
        publish_shutdown_sequence(publisher)
        emit("closed", reason=stop_reason or "process_exit")


if __name__ == "__main__":
    main()
