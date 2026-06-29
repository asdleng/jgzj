#!/usr/bin/env python3
import argparse
import base64
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ.setdefault("TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD", "1")

import cv2
import numpy as np
from ultralytics import YOLO


MODEL_CACHE = {}
MODEL_CACHE_LOCK = threading.Lock()
MODEL_INFER_LOCKS = {}
MODEL_INFER_LOCKS_LOCK = threading.Lock()
PLATE_OCR_CACHE = {}
PLATE_OCR_CACHE_LOCK = threading.Lock()
PLATE_OCR_INFER_LOCK = threading.Lock()
SERVER_STATE = {
    "started_at": time.time(),
    "gpu": os.environ.get("YOLO_MODEL_TEST_GPU_LABEL", "local-gpu"),
    "device": os.environ.get("YOLO_MODEL_TEST_DEVICE", "0"),
}


def infer_lock_for_model(model_path):
    resolved = os.path.abspath(str(model_path or ""))
    with MODEL_INFER_LOCKS_LOCK:
        lock = MODEL_INFER_LOCKS.get(resolved)
        if lock is None:
            lock = threading.Lock()
            MODEL_INFER_LOCKS[resolved] = lock
        return lock


def json_response(handler, status, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("content-type", "application/json; charset=utf-8")
    handler.send_header("content-length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def name_for(names, class_id):
    if isinstance(names, dict):
        return str(names.get(class_id, names.get(str(class_id), class_id)))
    if isinstance(names, (list, tuple)) and 0 <= class_id < len(names):
        return str(names[class_id])
    return str(class_id)


def normalize_predictions(probs, names):
    if probs is None:
        return []
    values = probs.data.detach().cpu().tolist()
    items = []
    for class_id, confidence in enumerate(values):
        items.append({
            "class_id": int(class_id),
            "class_name": name_for(names, int(class_id)),
            "confidence": float(confidence),
        })
    items.sort(key=lambda item: item["confidence"], reverse=True)
    return items


def serialize_box(box, names):
    class_id = int(box.cls.item())
    confidence = float(box.conf.item()) if box.conf is not None else 0.0
    xyxy = [float(value) for value in box.xyxy[0].detach().cpu().tolist()]
    xywhn = [float(value) for value in box.xywhn[0].detach().cpu().tolist()]
    return {
        "class_id": class_id,
        "class_name": name_for(names, class_id),
        "confidence": confidence,
        "box": {
            "x_center": xywhn[0],
            "y_center": xywhn[1],
            "width": xywhn[2],
            "height": xywhn[3],
            "xyxy": xyxy,
        },
    }


def serialize_xyxy_detection(class_id, class_name, confidence, xyxy, image_shape):
    height, width = image_shape[:2]
    x1, y1, x2, y2 = [float(value) for value in xyxy]
    bw = max(0.0, x2 - x1)
    bh = max(0.0, y2 - y1)
    return {
        "class_id": class_id,
        "class_name": str(class_name),
        "confidence": float(confidence),
        "box": {
            "x_center": ((x1 + x2) / 2.0) / max(width, 1),
            "y_center": ((y1 + y2) / 2.0) / max(height, 1),
            "width": bw / max(width, 1),
            "height": bh / max(height, 1),
            "xyxy": [x1, y1, x2, y2],
        },
    }


def encode_annotated_image(result):
    try:
        plotted = result.plot()
        ok, encoded = cv2.imencode(".jpg", plotted, [int(cv2.IMWRITE_JPEG_QUALITY), 88])
        if not ok:
            return None
        return {
            "mime_type": "image/jpeg",
            "data_base64": base64.b64encode(encoded.tobytes()).decode("ascii"),
        }
    except Exception as exc:
        return {"error": str(exc)}


def decode_image(image_payload):
    if not isinstance(image_payload, dict):
        raise ValueError("image_required")
    data_base64 = str(image_payload.get("data_base64") or "")
    if not data_base64:
        raise ValueError("image_required")
    raw = base64.b64decode(data_base64, validate=True)
    array = np.frombuffer(raw, dtype=np.uint8)
    image = cv2.imdecode(array, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("image_decode_failed")
    return image


def load_model(model_path):
    if not model_path:
        raise ValueError("model_required")
    resolved = os.path.abspath(model_path)
    if not os.path.exists(resolved):
        raise FileNotFoundError(f"model_missing:{resolved}")
    with MODEL_CACHE_LOCK:
        model = MODEL_CACHE.get(resolved)
        if model is not None:
            return model
        model = YOLO(resolved)
        torch_device = os.environ.get("YOLO_MODEL_TEST_TORCH_DEVICE", "")
        if torch_device:
            try:
                model.to(torch_device)
            except Exception as exc:
                print(f"model_to_device_warning path={resolved} device={torch_device} error={exc}", flush=True)
        MODEL_CACHE[resolved] = model
        print(f"model_loaded path={resolved}", flush=True)
        return model


def load_plate_ocr_model(car2_root, rec_model_path):
    root = os.path.abspath(str(car2_root or "/home/admin1/car2"))
    model_path = os.path.abspath(str(rec_model_path or os.path.join(root, "weights", "plate_rec_color.pth")))
    key = (root, model_path)
    with PLATE_OCR_CACHE_LOCK:
        cached = PLATE_OCR_CACHE.get(key)
        if cached is not None:
            return cached
        if root not in sys.path:
            sys.path.insert(0, root)
        import torch
        from plate_recognition.plate_rec import get_plate_result, init_model

        torch_device = torch.device("cuda" if SERVER_STATE["device"] != "cpu" else "cpu")
        model = init_model(torch_device, model_path, is_color=True)
        cached = {
            "device": torch_device,
            "model": model,
            "get_plate_result": get_plate_result,
        }
        PLATE_OCR_CACHE[key] = cached
        print(f"plate_ocr_loaded root={root} model={model_path} device={torch_device}", flush=True)
        return cached


def crop_with_padding(image, xyxy, pad_ratio=0.08):
    height, width = image.shape[:2]
    x1, y1, x2, y2 = xyxy
    pad_x = (x2 - x1) * pad_ratio
    pad_y = (y2 - y1) * pad_ratio
    left = max(0, int(round(x1 - pad_x)))
    top = max(0, int(round(y1 - pad_y)))
    right = min(width, int(round(x2 + pad_x)))
    bottom = min(height, int(round(y2 + pad_y)))
    if right <= left or bottom <= top:
        return None
    return image[top:bottom, left:right]


def crop_box_absolute(image, xyxy, pad_ratio=0.0):
    cropped = crop_box_absolute_with_origin(image, xyxy, pad_ratio)
    if cropped is None:
        return None
    return cropped[0]


def crop_box_absolute_with_origin(image, xyxy, pad_ratio=0.0):
    height, width = image.shape[:2]
    x1, y1, x2, y2 = [float(value) for value in xyxy]
    pad_x = (x2 - x1) * float(pad_ratio or 0.0)
    pad_y = (y2 - y1) * float(pad_ratio or 0.0)
    left = max(0, int(round(x1 - pad_x)))
    top = max(0, int(round(y1 - pad_y)))
    right = min(width, int(round(x2 + pad_x)))
    bottom = min(height, int(round(y2 + pad_y)))
    if right <= left or bottom <= top:
        return None
    return image[top:bottom, left:right], left, top


def detection_xyxy(detection):
    box = detection.get("box") or {}
    xyxy = box.get("xyxy")
    if isinstance(xyxy, (list, tuple)) and len(xyxy) == 4:
        return [float(value) for value in xyxy]
    return None


def box_contains_center(outer_xyxy, inner_xyxy, margin_ratio=0.02):
    ox1, oy1, ox2, oy2 = outer_xyxy
    ix1, iy1, ix2, iy2 = inner_xyxy
    cx = (ix1 + ix2) / 2.0
    cy = (iy1 + iy2) / 2.0
    pad_x = (ox2 - ox1) * margin_ratio
    pad_y = (oy2 - oy1) * margin_ratio
    return (ox1 - pad_x) <= cx <= (ox2 + pad_x) and (oy1 - pad_y) <= cy <= (oy2 + pad_y)


def draw_vehicle_plate_overlay(image, vehicles, plates):
    annotated = image.copy()
    for index, vehicle in enumerate(vehicles, start=1):
        xyxy = detection_xyxy(vehicle)
        if not xyxy:
            continue
        x1, y1, x2, y2 = [int(round(value)) for value in xyxy]
        cv2.rectangle(annotated, (x1, y1), (x2, y2), (56, 189, 248), 2)
        label = f"vehicle {index} {float(vehicle.get('confidence', 0.0)):.2f}"
        cv2.putText(annotated, label, (x1, max(16, y1 - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (56, 189, 248), 2, cv2.LINE_AA)
    for index, plate in enumerate(plates, start=1):
        xyxy = detection_xyxy(plate)
        if not xyxy:
            continue
        x1, y1, x2, y2 = [int(round(value)) for value in xyxy]
        cv2.rectangle(annotated, (x1, y1), (x2, y2), (34, 197, 94), 2)
        plate_no = str((plate.get("ocr") or {}).get("plate_no") or "plate")
        label = f"plate {index} {float(plate.get('confidence', 0.0)):.2f}"
        if plate_no:
            label = f"{label} {plate_no.encode('ascii', 'ignore').decode('ascii') or 'OCR'}"
        cv2.putText(annotated, label, (x1, max(16, y1 - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (34, 197, 94), 2, cv2.LINE_AA)
    ok, encoded = cv2.imencode(".jpg", annotated, [int(cv2.IMWRITE_JPEG_QUALITY), 88])
    if not ok:
        return None
    return {
        "mime_type": "image/jpeg",
        "data_base64": base64.b64encode(encoded.tobytes()).decode("ascii"),
    }


def accepted_behavior_classes(task):
    values = task.get("behaviorClasses")
    if isinstance(values, str):
        values = [values]
    if not isinstance(values, (list, tuple, set)):
        values = []
    classes = {str(value).strip().lower() for value in values if str(value).strip()}
    return classes or {"phone_use", "smoking"}


def run_detect(task, image, no_annotated):
    model_path = task.get("model")
    model = load_model(model_path)
    with infer_lock_for_model(model_path):
        result = model.predict(
            image,
            imgsz=int(task.get("imgsz") or 640),
            conf=float(task.get("conf") if task.get("conf") is not None else 0.25),
            device=SERVER_STATE["device"],
            verbose=False,
        )[0]
    names = getattr(result, "names", getattr(model.model, "names", {}))
    detections = []
    if result.boxes is not None:
        for box in result.boxes:
            detections.append(serialize_box(box, names))
    return {
        "ok": True,
        "mode": "detect",
        "detections": detections,
        "annotated_image": None if no_annotated else encode_annotated_image(result),
    }


def run_classify(task, image):
    model_path = task.get("model")
    model = load_model(model_path)
    with infer_lock_for_model(model_path):
        result = model.predict(
            image,
            imgsz=int(task.get("imgsz") or 224),
            device=SERVER_STATE["device"],
            verbose=False,
        )[0]
    names = getattr(result, "names", getattr(model.model, "names", {}))
    predictions = normalize_predictions(getattr(result, "probs", None), names)
    return {
        "ok": True,
        "mode": "classify",
        "predictions": predictions,
        "top": predictions[0] if predictions else None,
    }


def run_smoking_two_stage(task, image, no_annotated):
    detector_path = task.get("model")
    classifier_path = task.get("classifierModel")
    detector = load_model(detector_path)
    classifier = load_model(classifier_path)
    with infer_lock_for_model(detector_path):
        result = detector.predict(
            image,
            imgsz=int(task.get("imgsz") or 640),
            conf=float(task.get("conf") if task.get("conf") is not None else 0.25),
            device=SERVER_STATE["device"],
            verbose=False,
        )[0]
        names = getattr(result, "names", getattr(detector.model, "names", {}))
        detections = []
        if result.boxes is not None:
            for box in result.boxes:
                detection = serialize_box(box, names)
                crop = crop_with_padding(image, detection["box"]["xyxy"])
                if crop is not None:
                    with infer_lock_for_model(classifier_path):
                        cls_result = classifier.predict(
                            crop,
                            imgsz=int(task.get("classifierImgsz") or 224),
                            device=SERVER_STATE["device"],
                            verbose=False,
                        )[0]
                    cls_names = getattr(cls_result, "names", getattr(classifier.model, "names", {}))
                    predictions = normalize_predictions(getattr(cls_result, "probs", None), cls_names)
                    top = predictions[0] if predictions else None
                    detection["stage2"] = {"predictions": predictions, "top": top}
                    detection["accepted"] = bool(
                        top
                        and str(top.get("class_name", "")).lower() == "smoking"
                        and float(top.get("confidence", 0.0)) >= float(task.get("classifierThreshold") or 0.55)
                    )
                else:
                    detection["stage2"] = {"predictions": [], "top": None, "error": "empty_crop"}
                    detection["accepted"] = False
                detections.append(detection)
    return {
        "ok": True,
        "mode": "smoking_two_stage",
        "detections": detections,
        "annotated_image": None if no_annotated else encode_annotated_image(result),
    }


def run_person_behavior_two_stage(task, image, no_annotated):
    detector_path = task.get("model")
    classifier_path = task.get("classifierModel")
    min_box_height = float(task.get("minBoxHeight") if task.get("minBoxHeight") is not None else 0.12)
    min_box_area = float(task.get("minBoxArea") if task.get("minBoxArea") is not None else 0.025)
    accepted_classes = accepted_behavior_classes(task)
    detector = load_model(detector_path)
    classifier = load_model(classifier_path)
    with infer_lock_for_model(detector_path):
        result = detector.predict(
            image,
            imgsz=int(task.get("imgsz") or 640),
            conf=float(task.get("conf") if task.get("conf") is not None else 0.25),
            device=SERVER_STATE["device"],
            verbose=False,
        )[0]
    names = getattr(result, "names", getattr(detector.model, "names", {}))
    detections = []
    person_candidates = 0
    if result.boxes is not None:
        for box in result.boxes:
            detection = serialize_box(box, names)
            box_info = detection.get("box") or {}
            box_width = float(box_info.get("width") or 0.0)
            box_height = float(box_info.get("height") or 0.0)
            if box_height < min_box_height or box_width * box_height < min_box_area:
                continue
            person_candidates += 1
            crop = crop_with_padding(image, detection["box"]["xyxy"])
            if crop is not None:
                with infer_lock_for_model(classifier_path):
                    cls_result = classifier.predict(
                        crop,
                        imgsz=int(task.get("classifierImgsz") or 224),
                        device=SERVER_STATE["device"],
                        verbose=False,
                    )[0]
                cls_names = getattr(cls_result, "names", getattr(classifier.model, "names", {}))
                predictions = normalize_predictions(getattr(cls_result, "probs", None), cls_names)
                top = predictions[0] if predictions else None
                top_name = str((top or {}).get("class_name", "")).lower()
                detection["stage2"] = {"predictions": predictions, "top": top}
                detection["accepted"] = bool(
                    top
                    and top_name in accepted_classes
                    and float(top.get("confidence", 0.0)) >= float(task.get("classifierThreshold") or 0.55)
                )
            else:
                detection["stage2"] = {"predictions": [], "top": None, "error": "empty_crop"}
                detection["accepted"] = False
            if detection["accepted"]:
                detections.append(detection)
    return {
        "ok": True,
        "mode": "person_behavior_two_stage",
        "detections": detections,
        "person_candidates": person_candidates,
        "behavior_candidates": len(detections),
        "classifier_threshold": float(task.get("classifierThreshold") or 0.55),
        "behavior_classes": sorted(accepted_classes),
        "annotated_image": None if no_annotated else encode_annotated_image(result),
    }


def run_vehicle_plate_ocr(task, image, no_annotated):
    vehicle_model_path = task.get("vehicleModel") or task.get("model")
    plate_model_path = task.get("plateModel")
    vehicle_detector = load_model(vehicle_model_path)
    plate_detector = load_model(plate_model_path)
    ocr = load_plate_ocr_model(task.get("car2Root"), task.get("recModel"))

    vehicle_classes = {
        str(value).strip().lower()
        for value in task.get("vehicleClasses", ["car", "truck", "non_motor_vehicle"])
        if str(value).strip()
    }
    with infer_lock_for_model(vehicle_model_path):
        vehicle_result = vehicle_detector.predict(
            image,
            imgsz=int(task.get("vehicleImgsz") or task.get("imgsz") or 640),
            conf=float(task.get("vehicleConf") if task.get("vehicleConf") is not None else task.get("conf") if task.get("conf") is not None else 0.25),
            device=SERVER_STATE["device"],
            verbose=False,
        )[0]

    vehicle_names = getattr(vehicle_result, "names", getattr(vehicle_detector.model, "names", {}))
    vehicles = []
    if vehicle_result.boxes is not None:
        for box in vehicle_result.boxes:
            detection = serialize_box(box, vehicle_names)
            if str(detection.get("class_name", "")).lower() in vehicle_classes:
                detection["source_task_id"] = "vehicle_yolo"
                detection["source_task_label"] = "车辆识别"
                vehicles.append(detection)

    vehicles.sort(key=lambda item: float(item.get("confidence", 0.0)), reverse=True)
    max_vehicles = int(task.get("maxVehicles") or 8)
    vehicles = vehicles[:max_vehicles]

    plates = []
    for vehicle_index, vehicle in enumerate(vehicles):
        vehicle_xyxy = detection_xyxy(vehicle)
        if not vehicle_xyxy:
            continue
        vehicle_crop_with_origin = crop_box_absolute_with_origin(image, vehicle_xyxy, float(task.get("vehicleCropPadding") or 0.02))
        if vehicle_crop_with_origin is None:
            continue
        vehicle_crop, crop_origin_x, crop_origin_y = vehicle_crop_with_origin
        with infer_lock_for_model(plate_model_path):
            plate_result = plate_detector.predict(
                vehicle_crop,
                imgsz=int(task.get("plateImgsz") or 640),
                conf=float(task.get("plateConf") if task.get("plateConf") is not None else 0.25),
                device=SERVER_STATE["device"],
                verbose=False,
            )[0]
        if plate_result.boxes is None:
            vehicle["plates"] = []
            continue
        vehicle_plates = []
        for plate_box in plate_result.boxes:
            local_xyxy = [float(value) for value in plate_box.xyxy[0].detach().cpu().tolist()]
            absolute_xyxy = [
                local_xyxy[0] + crop_origin_x,
                local_xyxy[1] + crop_origin_y,
                local_xyxy[2] + crop_origin_x,
                local_xyxy[3] + crop_origin_y,
            ]
            if not box_contains_center(vehicle_xyxy, absolute_xyxy):
                continue
            plate_conf = float(plate_box.conf.item()) if plate_box.conf is not None else 0.0
            crop = crop_box_absolute(image, absolute_xyxy, float(task.get("ocrCropPadding") or 0.0))
            if crop is None:
                continue
            started = time.time()
            import torch
            with PLATE_OCR_INFER_LOCK, torch.no_grad():
                plate_no, rec_prob, plate_color, color_conf = ocr["get_plate_result"](
                    crop,
                    ocr["device"],
                    ocr["model"],
                    is_color=True,
                )
            ocr_ms = int(round((time.time() - started) * 1000))
            rec_conf = float(np.mean(rec_prob)) if len(rec_prob) else 0.0
            plate_detection = serialize_xyxy_detection(
                0,
                "license_plate",
                plate_conf,
                absolute_xyxy,
                image.shape,
            )
            plate_detection.update({
                "source_task_id": "license_plate_yolo",
                "source_task_label": "车牌检测",
                "vehicle_index": vehicle_index,
                "vehicle_class_name": vehicle.get("class_name"),
                "vehicle_confidence": vehicle.get("confidence"),
                "accepted": True,
                "plate_no": str(plate_no),
                "plate_color": str(plate_color),
                "ocr": {
                    "plate_no": str(plate_no),
                    "mean_char_confidence": rec_conf,
                    "plate_color": str(plate_color),
                    "color_confidence": float(color_conf),
                    "latency_ms": ocr_ms,
                    "crop_shape": list(crop.shape[:2]),
                },
            })
            plates.append(plate_detection)
            vehicle_plates.append(plate_detection)
        vehicle["plates"] = sorted(vehicle_plates, key=lambda item: float(item.get("confidence", 0.0)), reverse=True)

    plates.sort(key=lambda item: (float((item.get("ocr") or {}).get("mean_char_confidence") or 0.0), float(item.get("confidence") or 0.0)), reverse=True)
    detections = []
    for vehicle in vehicles:
        detections.append(vehicle)
    for plate in plates:
        detections.append(plate)

    return {
        "ok": True,
        "mode": "vehicle_plate_ocr",
        "detections": detections,
        "vehicles": vehicles,
        "plates": plates,
        "vehicle_candidates": len(vehicles),
        "plate_candidates": len(plates),
        "ocr_results": len([plate for plate in plates if (plate.get("ocr") or {}).get("plate_no")]),
        "annotated_image": None if no_annotated else draw_vehicle_plate_overlay(image, vehicles, plates),
    }


def run_prediction(payload):
    task = payload.get("task") if isinstance(payload.get("task"), dict) else {}
    kind = str(task.get("kind") or "")
    image = decode_image(payload.get("image"))
    no_annotated = bool(payload.get("no_annotated"))
    if kind == "classify":
        result = run_classify(task, image)
    elif kind == "vehicle_plate_ocr":
        result = run_vehicle_plate_ocr(task, image, no_annotated)
    elif kind == "person_behavior_two_stage":
        result = run_person_behavior_two_stage(task, image, no_annotated)
    elif kind == "smoking_two_stage":
        result = run_smoking_two_stage(task, image, no_annotated)
    elif kind == "detect":
        result = run_detect(task, image, no_annotated)
    else:
        raise ValueError(f"unsupported_kind:{kind}")
    return {
        **result,
        "backend": "local_service",
        "gpu": SERVER_STATE["gpu"],
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "JgzjYoloInference/1.0"

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)

    def do_GET(self):
        if self.path != "/health":
            json_response(self, 404, {"ok": False, "error": "not_found"})
            return
        json_response(self, 200, {
            "ok": True,
            "backend": "local_service",
            "gpu": SERVER_STATE["gpu"],
            "device": SERVER_STATE["device"],
            "uptime_s": round(time.time() - SERVER_STATE["started_at"], 3),
            "loaded_models": sorted(MODEL_CACHE.keys()),
        })

    def do_POST(self):
        if self.path != "/predict":
            json_response(self, 404, {"ok": False, "error": "not_found"})
            return
        try:
            length = int(self.headers.get("content-length") or "0")
            if length <= 0:
                raise ValueError("empty_body")
            raw = self.rfile.read(length)
            payload = json.loads(raw.decode("utf-8"))
            started = time.time()
            result = run_prediction(payload)
            result["duration_ms"] = int(round((time.time() - started) * 1000))
            json_response(self, 200, result)
        except Exception as exc:
            json_response(self, 500, {
                "ok": False,
                "error": type(exc).__name__,
                "detail": str(exc),
                "backend": "local_service",
                "gpu": SERVER_STATE["gpu"],
            })


def preload_models(paths, require):
    failures = []
    for item in paths:
        path = item.strip()
        if not path:
            continue
        try:
            load_model(path)
        except Exception as exc:
            failures.append(f"{path}:{exc}")
            print(f"model_preload_failed path={path} error={exc}", flush=True)
    if require and failures:
        print("required_preload_failed " + "; ".join(failures), file=sys.stderr, flush=True)
        raise SystemExit(2)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.environ.get("YOLO_MODEL_TEST_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("YOLO_MODEL_TEST_PORT", "18087")))
    parser.add_argument("--device", default=os.environ.get("YOLO_MODEL_TEST_DEVICE", "0"))
    parser.add_argument("--gpu-label", default=os.environ.get("YOLO_MODEL_TEST_GPU_LABEL", "local-gpu"))
    parser.add_argument("--preload-model", action="append", default=[])
    parser.add_argument("--require-preload", action="store_true")
    args = parser.parse_args()

    SERVER_STATE["gpu"] = args.gpu_label
    SERVER_STATE["device"] = args.device

    env_preload = [
        item.strip()
        for item in os.environ.get("YOLO_PRELOAD_MODELS", "").split(",")
        if item.strip()
    ]
    preload_models([*env_preload, *args.preload_model], args.require_preload)

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"yolo_inference_service_ready host={args.host} port={args.port} gpu={args.gpu_label}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
