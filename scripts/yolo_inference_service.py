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


def run_prediction(payload):
    task = payload.get("task") if isinstance(payload.get("task"), dict) else {}
    kind = str(task.get("kind") or "")
    image = decode_image(payload.get("image"))
    no_annotated = bool(payload.get("no_annotated"))
    if kind == "classify":
        result = run_classify(task, image)
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
