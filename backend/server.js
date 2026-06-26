const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { pathToFileURL } = require('url');
const { execFile } = require('child_process');
const { promisify } = require('util');
const express = require('express');
let sharp = null;
try {
  sharp = require('sharp');
} catch (_error) {
  sharp = null;
}
const { createAuthStore } = require('./auth-store');
const { createMailer } = require('./mailer');
const { createOperationAuditStore, normalizeRecord } = require('./operation-audit-store');
const registerCloudMappingRoutes = require('./cloud-mapping');
const registerRuntimeControlRoutes = require('./runtime-control');
const registerThreeDgsRoutes = require('./three-dgs');
const registerCrowdCpmRoutes = require('./crowd-cpm');
const registerParkPcmRoutes = require('./park-pcm');
const registerOneApiProxyRoutes = require('./one-api-proxy');

const execFileAsync = promisify(execFile);
const app = express();
const port = Number(process.env.PORT || 3000);
const webRoot = path.resolve(__dirname, '../dist');
const superSplatViewerRoot = path.resolve(
  process.env.THREE_DGS_SUPERSPLAT_VIEWER_ROOT ||
    path.resolve(__dirname, '../.runtime/three-dgs/supersplat-viewer')
);
const vehicleRagDir = path.resolve(
  process.env.VEHICLE_RAG_DIR || '/home/admin1/CloudVoice/multi_car_asr_demo/vehicle_rag'
);
const aiCheckArchiveRoot = path.resolve(
  process.env.AI_CHECK_ARCHIVE_ROOT || '/home/admin1/qwen-vl-infer/data/qwen_ws_checker_archive'
);
const aiCheckArchiveDbPath = path.join(
  aiCheckArchiveRoot,
  process.env.AI_CHECK_ARCHIVE_DB_NAME || 'qwen_ws_checker.sqlite3'
);
const aiCheckArchiveDbUri = `file:${aiCheckArchiveDbPath}?mode=ro&immutable=1`;
const sqlite3Bin = resolveExecutable(
  process.env.SQLITE3_BIN || process.env.AI_CHECK_SQLITE_BIN,
  ['/usr/bin/sqlite3', '/usr/local/bin/sqlite3', '/home/admin1/miniconda3/bin/sqlite3']
);
const defaultVehicleId = process.env.DEFAULT_VEHICLE_ID || 'car-web';
const upstreamBaseUrl = process.env.UPSTREAM_CHAT_BASE_URL || 'http://127.0.0.1:8050';
const upstreamStreamUrl = new URL(
  process.env.UPSTREAM_CHAT_STREAM_PATH || '/chat/stream',
  upstreamBaseUrl
).toString();
const upstreamHealthUrl = new URL(
  process.env.UPSTREAM_CHAT_HEALTH_PATH || '/healthz',
  upstreamBaseUrl
).toString();
const requestTimeoutMs = Number(process.env.CHAT_PROXY_TIMEOUT_MS || 120000);
const httpServerRequestTimeoutMs = Number(process.env.HTTP_SERVER_REQUEST_TIMEOUT_MS || 30 * 60 * 1000);
const httpServerHeadersTimeoutMs = Number(process.env.HTTP_SERVER_HEADERS_TIMEOUT_MS || 65 * 1000);
const httpServerKeepAliveTimeoutMs = Number(process.env.HTTP_SERVER_KEEP_ALIVE_TIMEOUT_MS || 75 * 1000);
const qwen36BaseUrl = process.env.QWEN36_BASE_URL || 'http://127.0.0.1:18000/v1';
const qwen36BaseUrlWithSlash = qwen36BaseUrl.endsWith('/') ? qwen36BaseUrl : `${qwen36BaseUrl}/`;
const qwen36ChatUrl = new URL('chat/completions', qwen36BaseUrlWithSlash).toString();
const qwen36ModelsUrl = new URL('models', qwen36BaseUrlWithSlash).toString();
const qwen36Model = process.env.QWEN36_MODEL || 'Qwen3.6-27B';
const qwen36TimeoutMs = Number(process.env.QWEN36_TIMEOUT_MS || 300000);
const qwen36HealthCacheTtlMs = Number(process.env.QWEN36_HEALTH_CACHE_TTL_MS || 30000);
const qwen36MaxConcurrent = Number(process.env.QWEN36_MAX_CONCURRENT || 1);
const qwen36MmBaseUrl = process.env.QWEN36_MM_BASE_URL || 'http://127.0.0.1:18001/v1';
const qwen36MmBaseUrlWithSlash = qwen36MmBaseUrl.endsWith('/') ? qwen36MmBaseUrl : `${qwen36MmBaseUrl}/`;
const qwen36MmChatUrl = new URL('chat/completions', qwen36MmBaseUrlWithSlash).toString();
const qwen36MmModel = process.env.QWEN36_MM_MODEL || 'Qwen3.6-27B-MM';
const qwen36MmTimeoutMs = Number(process.env.QWEN36_MM_TIMEOUT_MS || 120000);
const qwen36MmMaxConcurrent = Number(process.env.QWEN36_MM_MAX_CONCURRENT || 1);
const qwen36CircuitFailureThreshold = Number(process.env.QWEN36_CIRCUIT_FAILURE_THRESHOLD || 3);
const qwen36CircuitCooldownMs = Number(process.env.QWEN36_CIRCUIT_COOLDOWN_MS || 120000);
const qwen36MmMaxImageBytes = Number(process.env.QWEN36_MM_MAX_IMAGE_BYTES || 4 * 1024 * 1024);
const openClawConfigPath = path.resolve(
  process.env.OPENCLAW_CONFIG_PATH || '/home/admin1/.openclaw/openclaw.json'
);
const openClawGatewaySdkUrl = pathToFileURL(
  path.resolve(
    process.env.OPENCLAW_GATEWAY_SDK_PATH ||
      '/home/admin1/.openclaw/lib/node_modules/openclaw/dist/method-scopes-DhuXuLfv.js'
  )
).href;
const openClawGatewayHost = process.env.OPENCLAW_GATEWAY_HOST || '127.0.0.1';
const openClawAgentId = process.env.OPENCLAW_AGENT_ID || 'main';
const openClawConnectTimeoutMs = Number(process.env.OPENCLAW_CONNECT_TIMEOUT_MS || 15000);
const openClawTimeoutMs = Number(process.env.OPENCLAW_TIMEOUT_MS || 180000);
const openClawAuthCookieName = process.env.OPENCLAW_AUTH_COOKIE_NAME || 'jgzj_openclaw_auth';
const defaultOpenClawAuthAccounts = new Map([
  ['asdleng', 'Asd174524'],
  ['jgauto402', 'jgauto402']
]);
if (process.env.OPENCLAW_AUTH_USERNAME && process.env.OPENCLAW_AUTH_PASSWORD) {
  defaultOpenClawAuthAccounts.set(
    process.env.OPENCLAW_AUTH_USERNAME.trim(),
    process.env.OPENCLAW_AUTH_PASSWORD
  );
}
if (process.env.OPENCLAW_AUTH_USERS) {
  try {
    const parsedAccounts = JSON.parse(process.env.OPENCLAW_AUTH_USERS);
    if (parsedAccounts && typeof parsedAccounts === 'object' && !Array.isArray(parsedAccounts)) {
      Object.entries(parsedAccounts).forEach(([username, password]) => {
        const normalizedUsername = String(username || '').trim();
        if (normalizedUsername) {
          defaultOpenClawAuthAccounts.set(normalizedUsername, String(password || ''));
        }
      });
    }
  } catch (_error) {
    // Ignore malformed optional multi-user env config and fall back to defaults.
  }
}
const openClawAuthAccounts = defaultOpenClawAuthAccounts;
const openClawAuthSecret =
  process.env.OPENCLAW_AUTH_SECRET || 'jgzj-openclaw-auth-secret-v1';
const openClawAuthTtlMs = Number(
  process.env.OPENCLAW_AUTH_TTL_MS || 7 * 24 * 60 * 60 * 1000
);
const cloudAgentBaseUrl = process.env.CLOUD_AGENT_BASE_URL || 'http://127.0.0.1:8000';
const cloudAgentTimeoutMs = Number(process.env.CLOUD_AGENT_TIMEOUT_MS || 25000);
const cloudAgentPlanSessionSuffix = process.env.CLOUD_AGENT_PLAN_SESSION_SUFFIX || 'ops-plan';
const cloudAgentAnswerSessionSuffix =
  process.env.CLOUD_AGENT_ANSWER_SESSION_SUFFIX || 'ops-answer';
const cloudOpsRouteCatalogCacheTtlMs = Number(
  process.env.CLOUD_OPS_ROUTE_CATALOG_CACHE_TTL_MS || 15000
);
const cloudOpsAudioAlsaEnabled = String(
  process.env.CLOUD_OPS_AUDIO_ALSA_MONITOR_ENABLED || 'true'
).toLowerCase() !== 'false';
const cloudOpsAudioAlsaSpeakerMinPercent = Number(
  process.env.CLOUD_OPS_AUDIO_ALSA_SPEAKER_MIN_PERCENT || 80
);
const cloudOpsAudioAlsaStatusTtlMs = Number(
  process.env.CLOUD_OPS_AUDIO_ALSA_STATUS_TTL_MS || 30000
);
const cloudOpsAudioAlsaToolListTtlMs = Number(
  process.env.CLOUD_OPS_AUDIO_ALSA_TOOL_LIST_TTL_MS || 120000
);
const cloudOpsAudioAlsaTimeoutS = Number(
  process.env.CLOUD_OPS_AUDIO_ALSA_TIMEOUT_S || 8
);
const cloudOpsAudioAlsaHttpTimeoutMs = Number(
  process.env.CLOUD_OPS_AUDIO_ALSA_HTTP_TIMEOUT_MS ||
    Math.max(3000, Math.ceil(cloudOpsAudioAlsaTimeoutS * 1000) + 3000)
);
const cloudOpsAudioAlsaMaxConcurrent = Number(
  process.env.CLOUD_OPS_AUDIO_ALSA_MAX_CONCURRENT || 2
);
const cloudOpsDeployGitCacheDir = path.resolve(
  process.env.CLOUD_OPS_DEPLOY_GIT_CACHE_DIR || '/tmp/jgzj-deploy-git-cache'
);
const cloudOpsRouteCatalogCache = new Map();
const cloudOpsAudioAlsaCache = new Map();
const projectRoot = path.resolve(__dirname, '..');
const yoloModelTestRoot = path.resolve(
  process.env.YOLO_MODEL_TEST_ROOT || path.join(projectRoot, '.runtime/yolo_model_test')
);
const yoloModelTestMaxImageBytes = Number(process.env.YOLO_MODEL_TEST_MAX_IMAGE_BYTES || 4 * 1024 * 1024);
const yoloModelTestTimeoutMs = Number(process.env.YOLO_MODEL_TEST_TIMEOUT_MS || 180000);
const yoloA100Host = process.env.YOLO_A100_HOST || '192.168.80.49';
const yoloA100User = process.env.YOLO_A100_USER || 'sari';
const yoloA100Key = process.env.YOLO_A100_KEY || '/home/admin1/a100_tunnel/jgzj_qwen36_proxy_ed25519';
const yoloA100Gpu = process.env.YOLO_A100_GPU || '3';
const yoloA100Python = process.env.YOLO_A100_PYTHON || '/home/sari/autodistill/bin/python3';
const yoloA100WorkRoot = process.env.YOLO_A100_TEST_ROOT || '/home/sari/jgzj_yolo_test';
const yoloLocalServiceUrl = process.env.YOLO_LOCAL_SERVICE_URL || 'http://127.0.0.1:18087';
const yoloLocalServiceEnabled = String(process.env.YOLO_LOCAL_SERVICE_ENABLED || 'true').toLowerCase() !== 'false';
const yoloLocalServiceTimeoutMs = Number(process.env.YOLO_LOCAL_SERVICE_TIMEOUT_MS || 60000);
const yoloLocalGpuLabel = process.env.YOLO_LOCAL_GPU_LABEL || 'server-proxy-gpu2';
const yoloModelTestTasks = Object.freeze({
  all_yolo: {
    kind: 'all_yolo',
    label: '全部YOLO检测',
    subTasks: ['general_yolo', 'pet_yolo', 'trash_yolo', 'fire_smoke_yolo', 'phone_yolo', 'stall_yolo', 'smoking_two_stage']
  },
  general_yolo: {
    kind: 'detect',
    label: '通用事件',
    model: '/home/sari/jgzj_yolo_runs/general_yolo_manual_20260621_044205/weights/best.pt',
    localModel: '/home/admin1/jgzj/.runtime/yolo_model_service/weights/general_yolo_best.pt',
    names: ['car', 'truck', 'non_motor_vehicle', 'pet', 'stall'],
    imgsz: 640,
    conf: 0.25
  },
  pet_yolo: {
    kind: 'detect',
    label: '宠物识别',
    model: '/home/sari/jgzj_yolo_runs/pet_yolo_20260623_160655/weights/best.pt',
    localModel: '/home/admin1/jgzj/.runtime/yolo_model_service/weights/pet_yolo_best.pt',
    names: ['pet'],
    imgsz: 640,
    conf: 0.2
  },
  trash_yolo: {
    kind: 'detect',
    label: '小垃圾细类',
    model: '/home/sari/jgzj_yolo_runs/trash_yolo_20260623_001045/weights/best.pt',
    localModel: '/home/admin1/jgzj/.runtime/yolo_model_service/weights/trash_yolo_best.pt',
    names: ['bottle', 'box', 'paper', 'bag'],
    imgsz: 960,
    conf: 0.15
  },
  fire_smoke_yolo: {
    kind: 'detect',
    label: '火源烟雾',
    model: '/home/sari/jgzj_yolo_runs/fire_smoke_yolo_20260623_181458/weights/best.pt',
    localModel: '/home/admin1/jgzj/.runtime/yolo_model_service/weights/fire_smoke_yolo_best.pt',
    names: ['fire', 'smoke'],
    imgsz: 768,
    conf: 0.2
  },
  phone_yolo: {
    kind: 'detect',
    label: '手机识别',
    model: '/home/sari/jgzj_yolo_runs/phone_yolo_20260623_131012/weights/best.pt',
    localModel: '/home/admin1/jgzj/.runtime/yolo_model_service/weights/phone_yolo_best.pt',
    names: ['phone'],
    imgsz: 640,
    conf: 0.2
  },
  stall_yolo: {
    kind: 'detect',
    label: '摆摊识别',
    model: '/home/sari/jgzj_yolo_runs/stall_yolo_20260623_214426/weights/best.pt',
    localModel: '/home/admin1/jgzj/.runtime/yolo_model_service/weights/stall_yolo_best.pt',
    names: ['stall'],
    imgsz: 960,
    conf: 0.2
  },
  smoking_candidate: {
    kind: 'detect',
    label: '吸烟候选',
    model: '/home/sari/jgzj_yolo_runs/smoking_candidate_yolo_small_manual_20260621_063036/weights/best.pt',
    localModel: '/home/admin1/jgzj/.runtime/yolo_model_service/weights/smoking_candidate_best.pt',
    names: ['smoking'],
    imgsz: 640,
    conf: 0.2
  },
  smoking_cls: {
    kind: 'classify',
    label: '吸烟二级分类',
    model: '/home/sari/jgzj_yolo_runs/smoking_cls_small_manual_20260621_064107/weights/best.pt',
    localModel: '/home/admin1/jgzj/.runtime/yolo_model_service/weights/smoking_cls_best.pt',
    names: ['not_smoking', 'smoking'],
    imgsz: 224
  },
  smoking_two_stage: {
    kind: 'smoking_two_stage',
    label: '吸烟检测',
    model: '/home/sari/jgzj_yolo_runs/smoking_candidate_yolo_small_manual_20260621_063036/weights/best.pt',
    classifierModel: '/home/sari/jgzj_yolo_runs/smoking_cls_small_manual_20260621_064107/weights/best.pt',
    localModel: '/home/admin1/jgzj/.runtime/yolo_model_service/weights/smoking_candidate_best.pt',
    localClassifierModel: '/home/admin1/jgzj/.runtime/yolo_model_service/weights/smoking_cls_best.pt',
    names: ['smoking'],
    classifierNames: ['not_smoking', 'smoking'],
    imgsz: 640,
    conf: 0.18,
    classifierImgsz: 224,
    classifierThreshold: 0.55
  }
});
const yoloModelTestPredictScript = String.raw`import argparse
import base64
import json
import os
import sys

os.environ.setdefault("TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD", "1")

from ultralytics import YOLO


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
        import cv2

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


def run_detect(args):
    model = YOLO(args.model)
    result = model.predict(
        args.image,
        imgsz=args.imgsz,
        conf=args.conf,
        device=args.device,
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
        "annotated_image": None if args.no_annotated else encode_annotated_image(result),
    }


def run_classify(args):
    model = YOLO(args.model)
    result = model.predict(
        args.image,
        imgsz=args.imgsz,
        device=args.device,
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


def run_smoking_two_stage(args):
    import cv2

    image = cv2.imread(args.image)
    if image is None:
        raise RuntimeError("image_decode_failed")

    detector = YOLO(args.model)
    classifier = YOLO(args.classifier_model)
    result = detector.predict(
        args.image,
        imgsz=args.imgsz,
        conf=args.conf,
        device=args.device,
        verbose=False,
    )[0]
    names = getattr(result, "names", getattr(detector.model, "names", {}))
    detections = []
    if result.boxes is not None:
        for box in result.boxes:
            detection = serialize_box(box, names)
            crop = crop_with_padding(image, detection["box"]["xyxy"])
            if crop is not None:
                cls_result = classifier.predict(
                    crop,
                    imgsz=args.cls_imgsz,
                    device=args.device,
                    verbose=False,
                )[0]
                cls_names = getattr(cls_result, "names", getattr(classifier.model, "names", {}))
                predictions = normalize_predictions(getattr(cls_result, "probs", None), cls_names)
                top = predictions[0] if predictions else None
                detection["stage2"] = {"predictions": predictions, "top": top}
                detection["accepted"] = bool(
                    top
                    and str(top.get("class_name", "")).lower() == "smoking"
                    and float(top.get("confidence", 0.0)) >= args.cls_threshold
                )
            else:
                detection["stage2"] = {"predictions": [], "top": None, "error": "empty_crop"}
                detection["accepted"] = False
            detections.append(detection)
    return {
        "ok": True,
        "mode": "smoking_two_stage",
        "detections": detections,
        "annotated_image": None if args.no_annotated else encode_annotated_image(result),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", required=True, choices=["detect", "classify", "smoking_two_stage"])
    parser.add_argument("--model", required=True)
    parser.add_argument("--classifier-model", default="")
    parser.add_argument("--image", required=True)
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--conf", type=float, default=0.25)
    parser.add_argument("--device", default="0")
    parser.add_argument("--cls-imgsz", type=int, default=224)
    parser.add_argument("--cls-threshold", type=float, default=0.55)
    parser.add_argument("--no-annotated", action="store_true")
    args = parser.parse_args()

    if args.mode == "classify":
        payload = run_classify(args)
    elif args.mode == "smoking_two_stage":
        payload = run_smoking_two_stage(args)
    else:
        payload = run_detect(args)
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"ok": False, "error": type(exc).__name__, "detail": str(exc)}, ensure_ascii=False))
        sys.exit(1)
`;
const yoloDatasetRootSpecs = [
  {
    alias: 'loop',
    root: path.resolve(
      process.env.YOLO_LOOP_DATASETS_ROOT || path.join(projectRoot, '.runtime/yolo_loop/datasets')
    )
  },
  {
    alias: 'legacy',
    root: path.resolve(
      process.env.YOLO_LEGACY_DATASETS_ROOT || path.join(projectRoot, '.runtime/yolo_datasets')
    )
  }
];
const yoloImageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);
const yoloReviewPatrolDatasetId = 'patrol:vehicle-self-collected';
const yoloReviewPatrolDatasetRel = 'vehicle-self-collected';
const yoloReviewRuntimeRoot = path.resolve(
  process.env.YOLO_LABEL_REVIEW_RUNTIME_ROOT || path.join(projectRoot, '.runtime/yolo_label_review')
);
const parkCrowdRuntimeRoot = path.resolve(
  process.env.PARK_CROWD_RUNTIME_ROOT || process.env.PARK_PCM_RUNTIME_ROOT || path.join(projectRoot, '.runtime/park-pcm')
);
const parkCrowdFramesRoot = path.join(parkCrowdRuntimeRoot, 'crowd-frames');
const patrolAutoLabelRoot = path.join(yoloReviewRuntimeRoot, 'patrol_auto_labels');
const vehicleUploadQwenLabelRoot = path.join(yoloReviewRuntimeRoot, 'vehicle_upload_qwen_labels_v2');
const vehicleUploadQwenBboxLabelRoot = path.join(yoloReviewRuntimeRoot, 'vehicle_upload_qwen_bbox_labels_v1');
const vehicleUploadQwenSensitiveBboxLabelRoot = path.join(
  yoloReviewRuntimeRoot,
  'vehicle_upload_qwen_sensitive_bbox_v6_reviewed_20260626'
);
const yoloReviewThumbRoot = path.join(yoloReviewRuntimeRoot, 'thumbs');
const yoloReviewPatrolIndexPath = path.join(yoloReviewRuntimeRoot, 'patrol_dataset_index.json');
const patrolAutoLabelSchema = 'jgzj_patrol_yolo_auto_label.v1';
const vehicleUploadQwenLabelSchema = 'jgzj_vehicle_upload_qwen_label.v2';
const vehicleUploadQwenBboxLabelSchema = 'jgzj_vehicle_upload_qwen_bbox_label.v1';
const vehicleUploadQwenSensitiveBboxLabelSchema = 'jgzj_vehicle_upload_qwen_sensitive_bbox.v6_reviewed';
const vehicleUploadQwenSensitiveBboxClasses = new Set(['smoke', 'trash', 'stall', 'phone', 'smoking']);
const yoloReviewPatrolIndexSchema = 'jgzj_yolo_patrol_dataset_index.v3';
const yoloReviewPatrolCacheTtlMs = Number(process.env.YOLO_LABEL_REVIEW_PATROL_CACHE_TTL_MS || 10 * 60 * 1000);
const yoloReviewPatrolIndexFreshMs = Number(process.env.YOLO_LABEL_REVIEW_PATROL_INDEX_FRESH_MS || 5 * 60 * 1000);
const yoloReviewDatasetListCacheTtlMs = Number(process.env.YOLO_LABEL_REVIEW_DATASET_LIST_CACHE_TTL_MS || 5 * 60 * 1000);
let yoloReviewPatrolCache = {
  loaded_at_ms: 0,
  dataset: null,
  promise: null,
  refresh_promise: null
};
let yoloReviewDatasetListCache = {
  loaded_at_ms: 0,
  datasets: null,
  promise: null
};
const yoloPatrolClasses = [
  'person',
  'car',
  'truck',
  'non_motor_vehicle',
  'pet',
  'stall',
  'bottle',
  'box',
  'paper',
  'bag',
  'fire',
  'smoke',
  'phone',
  'smoking',
  'vehicle',
  'nonmotor',
  'trash'
];
const vehicleQwenLabelClasses = [
  'person',
  'fire',
  'smoke',
  'trash',
  'pet',
  'stall',
  'phone',
  'smoking',
  'vehicle',
  'nonmotor'
];
const vehicleQwenFilterOptions = [
  ...vehicleQwenLabelClasses.map((value) => ({ value, label: value })),
  { value: 'empty_scene', label: 'empty_scene' },
  { value: 'hard_negative', label: 'hard_negative' },
  { value: 'fire_smoke_candidate', label: 'fire_smoke_candidate' },
  { value: 'trash_candidate', label: 'trash_candidate' },
  { value: 'small_object_candidate', label: 'small_object_candidate' },
  { value: 'quality:good', label: 'quality:good' },
  { value: 'quality:dark', label: 'quality:dark' },
  { value: 'quality:blur', label: 'quality:blur' },
  { value: 'quality:blocked', label: 'quality:blocked' }
];
const authStore = createAuthStore({
  rootDir: projectRoot,
  storePath: process.env.JGZJ_AUTH_STORE_PATH || undefined,
  cookieName: process.env.JGZJ_AUTH_COOKIE_NAME || 'jgzj_session',
  sessionTtlMs: Number(process.env.JGZJ_AUTH_TTL_MS || 7 * 24 * 60 * 60 * 1000),
  secureCookie: String(process.env.JGZJ_AUTH_COOKIE_SECURE || '').toLowerCase() === 'true'
});
const operationAuditStore = createOperationAuditStore({
  rootDir: projectRoot,
  filePath: process.env.JGZJ_OPERATION_AUDIT_PATH || undefined
});
const mailer = createMailer({ rootDir: projectRoot });

app.disable('x-powered-by');
app.use(express.json({ limit: '16mb' }));

function normalizeReply(text) {
  return String(text || '')
    .replace(/<\|im_end\|>/g, '')
    .trim();
}

function truncateText(text, limit = 12000) {
  const value = String(text || '');
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}\n...[truncated]`;
}

function safeJsonStringify(value, limit = 12000) {
  try {
    return truncateText(JSON.stringify(value, null, 2), limit);
  } catch (_error) {
    return truncateText(String(value || ''), limit);
  }
}

function parseSseBlock(block) {
  const payload = block
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6).trim())
    .join('\n');

  if (!payload) {
    return null;
  }

  try {
    return JSON.parse(payload);
  } catch (_error) {
    return null;
  }
}

function createUpstreamPayload(message, sessionId, options = {}) {
  const reset = Boolean(options.reset);
  const vehicleId =
    typeof options.vehicle_id === 'string' && options.vehicle_id.trim()
      ? options.vehicle_id.trim()
      : defaultVehicleId;
  return {
    session_id: sessionId,
    text: message,
    vehicle_id: vehicleId,
    reset,
    do_sample: false,
    temperature: 0,
    top_p: 0.9,
    enable_thinking: Boolean(options.enable_thinking)
  };
}

async function listVehicleIdentities() {
  const entries = await fs.readdir(vehicleRagDir, { withFileTypes: true });
  const identities = entries
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.txt')
    .map((entry) => path.parse(entry.name).name)
    .filter(Boolean);

  const unique = [...new Set(identities)];
  unique.sort((left, right) => {
    if (left === defaultVehicleId) return -1;
    if (right === defaultVehicleId) return 1;
    return left.localeCompare(right, 'zh-CN');
  });

  if (!unique.includes(defaultVehicleId)) {
    unique.unshift(defaultVehicleId);
  }

  return unique;
}

function writeSseEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function toFiniteInteger(value, fallback, options = {}) {
  const num = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(num)) {
    return fallback;
  }

  const min = Number.isFinite(options.min) ? options.min : num;
  const max = Number.isFinite(options.max) ? options.max : num;
  return Math.min(max, Math.max(min, num));
}

function parseJsonField(value, fallback = null) {
  if (typeof value !== 'string' || !value.trim()) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function resolveExecutable(configured, candidates = []) {
  const requested = String(configured || '').trim();
  const options = requested ? [requested, ...candidates] : candidates;
  for (const candidate of options) {
    if (!candidate) continue;
    try {
      fsSync.accessSync(candidate, fsSync.constants.X_OK);
      return candidate;
    } catch (_error) {
      // Try the next known location.
    }
  }
  return requested || 'sqlite3';
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function yoloA100SshArgs(command) {
  return [
    '-i', yoloA100Key,
    '-o', 'ClearAllForwardings=yes',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=no',
    `${yoloA100User}@${yoloA100Host}`,
    `bash -lc ${shellQuote(command)}`
  ];
}

async function runYoloA100Command(command, options = {}) {
  return execFileAsync('ssh', yoloA100SshArgs(command), {
    timeout: options.timeoutMs || yoloModelTestTimeoutMs,
    maxBuffer: options.maxBuffer || 48 * 1024 * 1024
  });
}

async function copyYoloFileToA100(localPath, remotePath) {
  return execFileAsync('scp', [
    '-i', yoloA100Key,
    '-o', 'ClearAllForwardings=yes',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=no',
    localPath,
    `${yoloA100User}@${yoloA100Host}:${remotePath}`
  ], {
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024
  });
}

function decodeYoloModelTestImage(image) {
  if (!image?.mime_type || !image?.data_base64) {
    const error = new Error('image_required');
    error.status = 400;
    throw error;
  }

  const mimeType = String(image.mime_type || '').toLowerCase().split(';', 1)[0].trim();
  const extensionByMime = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/bmp': '.bmp'
  };
  const ext = extensionByMime[mimeType];
  if (!ext) {
    const error = new Error('unsupported_image_type');
    error.status = 415;
    throw error;
  }

  const imageSizeBytes = Buffer.byteLength(String(image.data_base64 || ''), 'base64');
  if (imageSizeBytes > yoloModelTestMaxImageBytes) {
    const error = new Error('image_too_large');
    error.status = 413;
    error.detail = `图片过大，请压缩到 ${Math.floor(yoloModelTestMaxImageBytes / 1024 / 1024)}MB 以内。`;
    error.imageSizeBytes = imageSizeBytes;
    throw error;
  }

  const buffer = Buffer.from(String(image.data_base64 || ''), 'base64');
  if (!buffer.length) {
    const error = new Error('empty_image');
    error.status = 400;
    throw error;
  }

  return { buffer, mimeType, ext, imageSizeBytes };
}

function remapYoloPredictionNames(predictions, names = []) {
  return (Array.isArray(predictions) ? predictions : []).map((prediction) => {
    const classId = Number(prediction.class_id);
    const className = Number.isInteger(classId) && names[classId] ? names[classId] : prediction.class_name;
    return {
      ...prediction,
      class_id: Number.isInteger(classId) ? classId : prediction.class_id,
      class_name: className || String(prediction.class_id ?? '')
    };
  });
}

function remapYoloDetectionNames(detections, task) {
  return (Array.isArray(detections) ? detections : []).map((detection) => {
    const classId = Number(detection.class_id);
    const className = Number.isInteger(classId) && task.names?.[classId] ? task.names[classId] : detection.class_name;
    const next = {
      ...detection,
      class_id: Number.isInteger(classId) ? classId : detection.class_id,
      class_name: className || String(detection.class_id ?? '')
    };
    if (next.stage2) {
      const predictions = remapYoloPredictionNames(next.stage2.predictions, task.classifierNames || task.names || []);
      const top = next.stage2.top
        ? remapYoloPredictionNames([next.stage2.top], task.classifierNames || task.names || [])[0]
        : null;
      next.stage2 = { ...next.stage2, predictions, top };
    }
    return next;
  });
}

function buildYoloRemotePredictCommand({ task, remoteScriptPath, remoteInputPath, noAnnotated = false }) {
  const args = [
    shellQuote(yoloA100Python),
    shellQuote(remoteScriptPath),
    '--mode', shellQuote(task.kind),
    '--model', shellQuote(task.model),
    '--image', shellQuote(remoteInputPath),
    '--imgsz', shellQuote(task.imgsz || 640),
    '--device', shellQuote('0')
  ];

  if (task.kind !== 'classify') {
    args.push('--conf', shellQuote(task.conf ?? 0.25));
  }
  if (task.classifierModel) {
    args.push('--classifier-model', shellQuote(task.classifierModel));
    args.push('--cls-imgsz', shellQuote(task.classifierImgsz || 224));
    args.push('--cls-threshold', shellQuote(task.classifierThreshold || 0.55));
  }
  if (noAnnotated) {
    args.push('--no-annotated');
  }

  return [
    `export TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD=1`,
    `export CUDA_VISIBLE_DEVICES=${shellQuote(yoloA100Gpu)}`,
    args.join(' ')
  ].join(' && ');
}

async function runRemoteYoloPrediction(task, remoteScriptPath, remoteInputPath, options = {}) {
  const remoteCommand = buildYoloRemotePredictCommand({
    task,
    remoteScriptPath,
    remoteInputPath,
    noAnnotated: Boolean(options.noAnnotated)
  });
  const result = await runYoloA100Command(remoteCommand, {
    timeoutMs: options.timeoutMs || yoloModelTestTimeoutMs,
    maxBuffer: options.maxBuffer || 64 * 1024 * 1024
  });
  const payload = extractJsonObject(result.stdout);
  if (!payload?.ok) {
    const detail = payload?.detail || result.stderr || result.stdout || 'YOLO推理没有返回有效结果。';
    const error = new Error(truncateText(detail, 2000));
    error.payload = payload || null;
    throw error;
  }
  return payload;
}

function buildLocalYoloTask(task) {
  const localTask = {
    kind: task.kind,
    label: task.label,
    model: task.localModel || task.model,
    names: task.names || [],
    imgsz: task.imgsz || 640,
    conf: task.conf ?? 0.25
  };
  if (task.classifierModel || task.localClassifierModel) {
    localTask.classifierModel = task.localClassifierModel || task.classifierModel;
    localTask.classifierNames = task.classifierNames || [];
    localTask.classifierImgsz = task.classifierImgsz || 224;
    localTask.classifierThreshold = task.classifierThreshold || 0.55;
  }
  return localTask;
}

async function runLocalYoloPrediction(taskId, task, decoded, options = {}) {
  if (!yoloLocalServiceEnabled) {
    throw new Error('local_yolo_service_disabled');
  }
  const response = await fetch(new URL('/predict', yoloLocalServiceUrl).toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      task_id: taskId,
      task: buildLocalYoloTask(task),
      image: {
        mime_type: decoded.mimeType,
        data_base64: decoded.buffer.toString('base64')
      },
      no_annotated: Boolean(options.noAnnotated)
    }),
    signal: AbortSignal.timeout(options.localTimeoutMs || yoloLocalServiceTimeoutMs)
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (_error) {
    // Keep the raw upstream text below.
  }
  if (!response.ok || !payload?.ok) {
    const detail = payload?.detail || payload?.error || text || `local_yolo_service_http_${response.status}`;
    const error = new Error(truncateText(detail, 2000));
    error.payload = payload || null;
    error.status = response.status;
    throw error;
  }
  return {
    ...payload,
    backend: payload.backend || 'local_service',
    gpu: payload.gpu || yoloLocalGpuLabel
  };
}

function buildYoloTaskResponse(taskId, task, payload, options = {}) {
  const responsePayload = {
    ok: true,
    task_id: taskId,
    task_label: task.label,
    mode: payload.mode || task.kind,
    model: path.basename(task.model || ''),
    gpu: payload.gpu || options.gpu || yoloA100Gpu,
    backend: payload.backend || options.backend || 'a100_ssh'
  };

  if (payload.mode === 'classify' || task.kind === 'classify') {
    const predictions = remapYoloPredictionNames(payload.predictions, task.names);
    responsePayload.predictions = predictions;
    responsePayload.top = payload.top
      ? remapYoloPredictionNames([payload.top], task.names)[0]
      : predictions[0] || null;
  } else {
    responsePayload.detections = remapYoloDetectionNames(payload.detections, task);
    if (!options.omitAnnotatedImage && payload.annotated_image?.data_base64) {
      responsePayload.annotated_image = {
        mime_type: payload.annotated_image.mime_type || 'image/jpeg',
        data_base64: payload.annotated_image.data_base64
      };
    }
    if (payload.annotated_image?.error) {
      responsePayload.annotated_image_error = payload.annotated_image.error;
    }
  }

  return responsePayload;
}

function extractJsonObject(text) {
  const source = normalizeReply(text)
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  if (!source) {
    return null;
  }

  try {
    return JSON.parse(source);
  } catch (_error) {
    // Ignore and continue with object extraction.
  }

  const start = source.indexOf('{');
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const candidate = source.slice(start, index + 1);
        try {
          return JSON.parse(candidate);
        } catch (_parseError) {
          return null;
        }
      }
    }
  }

  return null;
}

function toSqlTextLiteral(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function parseCookies(cookieHeader) {
  const jar = {};
  const source = String(cookieHeader || '');
  if (!source) {
    return jar;
  }

  source.split(';').forEach((part) => {
    const separator = part.indexOf('=');
    if (separator <= 0) {
      return;
    }

    const key = decodeURIComponent(part.slice(0, separator).trim());
    const value = decodeURIComponent(part.slice(separator + 1).trim());
    if (key) {
      jar[key] = value;
    }
  });

  return jar;
}

function timingSafeEqualText(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function createOpenClawAuthSignature(username, expiresAt) {
  return crypto
    .createHmac('sha256', openClawAuthSecret)
    .update(`${username}.${expiresAt}`)
    .digest('base64url');
}

function issueOpenClawAuthToken(username) {
  const expiresAt = Date.now() + openClawAuthTtlMs;
  const signature = createOpenClawAuthSignature(username, expiresAt);
  return `${username}.${expiresAt}.${signature}`;
}

function isOpenClawAuthUsernameAllowed(username) {
  return openClawAuthAccounts.has(String(username || '').trim());
}

function isOpenClawLoginValid(username, password) {
  const normalizedUsername = String(username || '').trim();
  if (!normalizedUsername || !isOpenClawAuthUsernameAllowed(normalizedUsername)) {
    return false;
  }
  return timingSafeEqualText(password, openClawAuthAccounts.get(normalizedUsername));
}

function verifyOpenClawAuthToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) {
    return null;
  }

  const [username, expiresAtRaw, signature] = parts;
  const expiresAt = Number(expiresAtRaw);
  if (!username || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return null;
  }

  if (!isOpenClawAuthUsernameAllowed(username)) {
    return null;
  }

  const expectedSignature = createOpenClawAuthSignature(username, expiresAt);
  if (!timingSafeEqualText(signature, expectedSignature)) {
    return null;
  }

  return {
    username,
    expires_at_ms: expiresAt
  };
}

function getOpenClawAuthFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  return verifyOpenClawAuthToken(cookies[openClawAuthCookieName]);
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || '/'}`);

  if (options.maxAgeMs != null) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeMs / 1000))}`);
  }

  if (options.httpOnly !== false) {
    parts.push('HttpOnly');
  }

  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }

  if (options.secure) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

function setOpenClawAuthCookie(res, token) {
  res.append(
    'Set-Cookie',
    serializeCookie(openClawAuthCookieName, token, {
      path: '/',
      maxAgeMs: openClawAuthTtlMs,
      httpOnly: true,
      sameSite: 'Lax'
    })
  );
}

function clearOpenClawAuthCookie(res) {
  res.append(
    'Set-Cookie',
    serializeCookie(openClawAuthCookieName, '', {
      path: '/',
      maxAgeMs: 0,
      httpOnly: true,
      sameSite: 'Lax'
    })
  );
}

function requireOpenClawAuth(req, res, next) {
  return authStore.requirePermission('vehicle:read')(req, res, next);
}

function toArchiveFileUrl(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    return null;
  }

  return `/api/ai-check-history/files/${relativePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`;
}

function normalizeApiRelPath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .trim();
}

function isPathWithinRoot(root, absolutePath) {
  const normalizedRoot = path.resolve(root);
  const normalizedPath = path.resolve(absolutePath);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${path.sep}`);
}

function toForwardSlashPath(value) {
  return String(value || '').split(path.sep).join('/');
}

function toArchiveFileUrlFromAny(filePath) {
  const value = String(filePath || '').trim();
  if (!value) {
    return null;
  }

  const absolutePath = path.isAbsolute(value) ? path.resolve(value) : path.resolve(aiCheckArchiveRoot, value);
  if (!isPathWithinRoot(aiCheckArchiveRoot, absolutePath)) {
    return null;
  }

  const relativePath = toForwardSlashPath(path.relative(aiCheckArchiveRoot, absolutePath));
  return toArchiveFileUrl(relativePath);
}

function datasetIdForDir(spec, datasetDir) {
  const rel = toForwardSlashPath(path.relative(spec.root, datasetDir));
  return `${spec.alias}:${rel}`;
}

function splitDatasetId(datasetId) {
  const value = String(datasetId || '').trim();
  const idx = value.indexOf(':');
  if (idx <= 0) {
    return null;
  }
  const alias = value.slice(0, idx);
  const rel = normalizeApiRelPath(value.slice(idx + 1));
  if (!alias || !rel || rel.split('/').includes('..')) {
    return null;
  }
  return { alias, rel };
}

function toYoloDatasetFileUrl(datasetId, relativePath, options = {}) {
  const rel = normalizeApiRelPath(relativePath);
  if (!datasetId || !rel) {
    return null;
  }
  const params = new URLSearchParams({
    dataset_id: String(datasetId),
    path: rel
  });
  if (options.thumb) {
    params.set('thumb', '1');
  }
  if (options.width) {
    params.set('w', String(options.width));
  }
  return `/api/yolo-label-review/file?${params.toString()}`;
}

function isYoloReviewPatrolDatasetId(datasetId) {
  return String(datasetId || '').trim() === yoloReviewPatrolDatasetId;
}

function resolveYoloPatrolFilePath(relativePath) {
  const rel = normalizeApiRelPath(relativePath);
  if (!rel || rel.split('/').includes('..')) {
    throw Object.assign(new Error('invalid_dataset_path'), { status: 400 });
  }
  const absolutePath = path.resolve(parkCrowdFramesRoot, rel);
  if (!isPathWithinRoot(parkCrowdFramesRoot, absolutePath)) {
    throw Object.assign(new Error('dataset_path_out_of_range'), { status: 400 });
  }
  return { rel, absolutePath };
}

function yoloThumbWidth(value) {
  const width = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(width)) {
    return 360;
  }
  return Math.max(120, Math.min(960, width));
}

function wantsYoloThumb(req) {
  const value = String(req?.query?.thumb || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

async function sendYoloImageFile(req, res, absolutePath) {
  if (!wantsYoloThumb(req) || !sharp) {
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.sendFile(absolutePath);
  }

  const width = yoloThumbWidth(req.query.w);
  const stat = await fs.stat(absolutePath);
  const cacheKey = crypto
    .createHash('sha1')
    .update(`${absolutePath}|${stat.size}|${Number(stat.mtimeMs).toFixed(0)}|${width}`)
    .digest('hex');
  const thumbPath = path.join(yoloReviewThumbRoot, cacheKey.slice(0, 2), `${cacheKey}.jpg`);
  try {
    await fs.access(thumbPath);
  } catch (_error) {
    await fs.mkdir(path.dirname(thumbPath), { recursive: true });
    const tmpPath = `${thumbPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await sharp(absolutePath)
        .rotate()
        .resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 72, mozjpeg: true })
        .toFile(tmpPath);
      await fs.rename(tmpPath, thumbPath);
    } catch (error) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      throw error;
    }
  }
  res.setHeader('Cache-Control', 'private, max-age=3600');
  return res.sendFile(thumbPath);
}

async function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (_error) {
    return fallback;
  }
}

async function readTextFile(filePath, fallback = '') {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (_error) {
    return fallback;
  }
}

function safeSourceLabelForPatrol(source) {
  const value = String(source || '').trim();
  if (value === 'auto_ad_patrol_flow_upload') {
    return '车端落盘上传';
  }
  if (value === 'cloud_camera_capture' || !value) {
    return '云端触发抓拍';
  }
  return value;
}

function yoloReviewSourceLabel(sourceType) {
  if (sourceType === 'vehicle_collection') {
    return '车辆自采图片';
  }
  if (sourceType === 'checker_archive') {
    return '车端校核数据';
  }
  return 'YOLO数据集';
}

function patrolAutoLabelCachePathForSha(imageSha256) {
  const sha = String(imageSha256 || '').trim().toLowerCase().replace(/[^a-f0-9]/g, '');
  if (!sha) {
    return null;
  }
  return path.join(patrolAutoLabelRoot, sha.slice(0, 2), `${sha}.json`);
}

function vehicleUploadQwenLabelCachePathForSha(imageSha256) {
  const sha = String(imageSha256 || '').trim().toLowerCase().replace(/[^a-f0-9]/g, '');
  if (!sha) {
    return null;
  }
  return path.join(vehicleUploadQwenLabelRoot, sha.slice(0, 2), `${sha}.json`);
}

function vehicleUploadQwenBboxLabelCachePathForSha(imageSha256) {
  const sha = String(imageSha256 || '').trim().toLowerCase().replace(/[^a-f0-9]/g, '');
  if (!sha) {
    return null;
  }
  return path.join(vehicleUploadQwenBboxLabelRoot, sha.slice(0, 2), `${sha}.json`);
}

function vehicleUploadQwenSensitiveBboxLabelCachePathForSha(imageSha256) {
  const sha = String(imageSha256 || '').trim().toLowerCase().replace(/[^a-f0-9]/g, '');
  if (!sha) {
    return null;
  }
  return path.join(vehicleUploadQwenSensitiveBboxLabelRoot, sha.slice(0, 2), `${sha}.json`);
}

async function readPatrolAutoLabelCache(meta) {
  const cachePath = patrolAutoLabelCachePathForSha(meta?.image_sha256);
  if (!cachePath) {
    return null;
  }
  const payload = await readJsonFile(cachePath, null);
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  if (payload.schema && payload.schema !== patrolAutoLabelSchema) {
    return null;
  }
  return payload;
}

async function readVehicleUploadQwenLabelCache(meta) {
  if (String(meta?.source || '') !== 'auto_ad_patrol_flow_upload') {
    return null;
  }
  const cachePath = vehicleUploadQwenLabelCachePathForSha(meta?.image_sha256);
  if (!cachePath) {
    return null;
  }
  const payload = await readJsonFile(cachePath, null);
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  if (payload.schema && payload.schema !== vehicleUploadQwenLabelSchema) {
    return null;
  }
  return payload;
}

async function readVehicleUploadQwenBboxLabelCache(meta) {
  if (String(meta?.source || '') !== 'auto_ad_patrol_flow_upload') {
    return null;
  }
  const cachePath = vehicleUploadQwenBboxLabelCachePathForSha(meta?.image_sha256);
  if (!cachePath) {
    return null;
  }
  const payload = await readJsonFile(cachePath, null);
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  if (payload.schema && payload.schema !== vehicleUploadQwenBboxLabelSchema) {
    return null;
  }
  return payload;
}

async function readVehicleUploadQwenSensitiveBboxLabelCache(meta) {
  if (String(meta?.source || '') !== 'auto_ad_patrol_flow_upload') {
    return null;
  }
  const cachePath = vehicleUploadQwenSensitiveBboxLabelCachePathForSha(meta?.image_sha256);
  if (!cachePath) {
    return null;
  }
  const payload = await readJsonFile(cachePath, null);
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  if (payload.schema && payload.schema !== vehicleUploadQwenSensitiveBboxLabelSchema) {
    return null;
  }
  return payload;
}

function normalizeVehicleQwenAnnotation(payload, relPath = '') {
  const annotation = payload?.annotation;
  if (!payload || !annotation || typeof annotation !== 'object') {
    return null;
  }
  const counts = {};
  const rawCounts = annotation.c && typeof annotation.c === 'object' ? annotation.c : {};
  for (const className of vehicleQwenLabelClasses) {
    const value = Number(rawCounts[className] || 0);
    counts[className] = Number.isFinite(value) ? Math.max(0, Math.min(9, Math.round(value))) : 0;
  }
  const classes = vehicleQwenLabelClasses.filter((className) => counts[className] > 0);
  const flags = Array.isArray(annotation.flags) ? annotation.flags.map((item) => String(item || '').trim()).filter(Boolean) : [];
  const tags = Array.isArray(annotation.tags) ? annotation.tags.map((item) => String(item || '').trim()).filter(Boolean) : [];
  const risk = Array.isArray(annotation.risk) ? annotation.risk.map((item) => String(item || '').trim()).filter(Boolean) : [];
  const quality = String(annotation.q || '').trim();
  const summaryParts = classes.map((className) => `${className}:${counts[className]}`);
  const summary = summaryParts.length ? summaryParts.join(', ') : (flags.includes('empty_scene') ? 'empty_scene' : 'no_object');
  return {
    schema: payload.schema || vehicleUploadQwenLabelSchema,
    status: payload.ok === false ? 'error' : 'done',
    rel_path: relPath || null,
    model: payload.model || null,
    annotated_at: payload.annotated_at || null,
    duration_ms: Number.isFinite(Number(payload.duration_ms)) ? Number(payload.duration_ms) : null,
    quality,
    tags,
    counts,
    classes,
    flags,
    risk,
    summary
  };
}

function normalizePatrolLabel(raw, index = 0) {
  const box = raw?.box || {};
  const x = Number(raw?.x ?? raw?.x_center ?? box.x_center);
  const y = Number(raw?.y ?? raw?.y_center ?? box.y_center);
  const w = Number(raw?.w ?? raw?.width ?? box.width);
  const h = Number(raw?.h ?? raw?.height ?? box.height);
  const className = String(raw?.class_name || raw?.label || raw?.name || '').trim();
  const confidence = Number(raw?.confidence);
  const modelTask = String(raw?.model_task || raw?.task || raw?.model || '').trim();
  const labelName = className || (raw?.class_id != null ? raw.class_id : index);
  const rawLine = `${labelName} ${Number.isFinite(x) ? x.toFixed(6) : ''} ${Number.isFinite(y) ? y.toFixed(6) : ''} ${Number.isFinite(w) ? w.toFixed(6) : ''} ${Number.isFinite(h) ? h.toFixed(6) : ''}`.trim();
  return {
    index,
    raw: raw?.raw || rawLine,
    class_id: Number.isFinite(Number(raw?.class_id)) ? Number(raw.class_id) : null,
    class_name: className,
    confidence: Number.isFinite(confidence) ? confidence : null,
    model_task: modelTask,
    x: Number.isFinite(x) ? x : null,
    y: Number.isFinite(y) ? y : null,
    w: Number.isFinite(w) ? w : null,
    h: Number.isFinite(h) ? h : null
  };
}

function normalizeQwenBboxLabel(raw, index = 0) {
  return {
    ...normalizePatrolLabel(raw, index),
    model_task: String(raw?.model_task || 'qwen_bbox').trim() || 'qwen_bbox',
    source: 'qwen_bbox'
  };
}

function normalizeQwenSensitiveBboxLabel(raw, index = 0) {
  return {
    ...normalizePatrolLabel(raw, index),
    model_task: String(raw?.model_task || 'qwen_sensitive_bbox').trim() || 'qwen_sensitive_bbox',
    source: 'qwen_bbox_verified'
  };
}

function isQwenSensitiveBboxClass(className) {
  return vehicleUploadQwenSensitiveBboxClasses.has(String(className || '').trim());
}

function mergeQwenBboxLabelsWithVerifiedSensitive(rawLabels = [], verifiedSensitiveLabels = []) {
  const nonSensitiveRawLabels = rawLabels.filter((label) => !isQwenSensitiveBboxClass(label.class_name));
  return [
    ...nonSensitiveRawLabels,
    ...verifiedSensitiveLabels
  ];
}

async function collectPatrolMetaFiles(rootDir = parkCrowdFramesRoot, depth = 0) {
  let entries = [];
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (_error) {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
      out.push(entryPath);
      continue;
    }
    if (entry.isDirectory() && depth < 4) {
      out.push(...await collectPatrolMetaFiles(entryPath, depth + 1));
    }
  }
  return out;
}

function patrolImageRelFromMeta(meta, metaPath) {
  const rel = normalizeApiRelPath(meta?.image_path || '');
  if (rel) {
    return rel;
  }
  const parsed = path.parse(metaPath);
  return normalizeApiRelPath(path.relative(parkCrowdFramesRoot, path.join(parsed.dir, `${parsed.name}.jpg`)));
}

async function readPatrolMetaRows() {
  const metaFiles = await collectPatrolMetaFiles();
  const rows = [];
  for (const metaPath of metaFiles) {
    const meta = await readJsonFile(metaPath, null);
    if (!meta || typeof meta !== 'object') {
      continue;
    }
    const imageRelPath = patrolImageRelFromMeta(meta, metaPath);
    if (!imageRelPath) {
      continue;
    }
    const imageAbsPath = path.resolve(parkCrowdFramesRoot, imageRelPath);
    if (!isPathWithinRoot(parkCrowdFramesRoot, imageAbsPath) || !isYoloImagePath(imageAbsPath) || !fsSync.existsSync(imageAbsPath)) {
      continue;
    }
    rows.push({
      meta,
      meta_path: metaPath,
      image_rel_path: imageRelPath,
      image_abs_path: imageAbsPath
    });
  }
  rows.sort((left, right) => {
    const lt = Date.parse(left.meta.collected_at || '') || 0;
    const rt = Date.parse(right.meta.collected_at || '') || 0;
    if (lt !== rt) return rt - lt;
    return right.image_rel_path.localeCompare(left.image_rel_path);
  });
  return rows;
}

function splitFromPatrolRelPath(rel) {
  const first = normalizeApiRelPath(rel).split('/')[0] || '';
  return first.match(/^\d{8}$/) ? first : 'patrol';
}

function buildPatrolBaseItem(dataset, row) {
  const meta = row.meta || {};
  const source = String(meta.source || 'cloud_camera_capture');
  const labels = Array.isArray(row.auto_labels) ? row.auto_labels : [];
  const labelClasses = Array.isArray(row.auto_label_classes) ? row.auto_label_classes : [];
  const qwenLabel = row.qwen_label || null;
  return {
    item_key: row.image_rel_path,
    image_rel_path: row.image_rel_path,
    split: splitFromPatrolRelPath(row.image_rel_path),
    ai_class: labelClasses.join(', '),
    label_classes: labelClasses,
    label_count: labels.length,
    label_source: row.label_source || 'yolo_auto',
    auto_label_status: row.auto_label_status || 'pending',
    qwen_bbox_status: row.qwen_bbox_status || (source === 'auto_ad_patrol_flow_upload' ? 'pending' : 'not_applicable'),
    qwen_bbox_rel_path: row.qwen_bbox_rel_path || null,
    qwen_bbox_quality: row.qwen_bbox_quality || '',
    qwen_bbox_verified_status: row.qwen_bbox_verified_status || 'not_applicable',
    qwen_bbox_verified_rel_path: row.qwen_bbox_verified_rel_path || null,
    ai_answer: row.ai_answer && row.ai_answer !== 'NULL' ? row.ai_answer : '',
    qwen_label_status: row.qwen_label_status || (source === 'auto_ad_patrol_flow_upload' ? 'pending' : 'not_applicable'),
    qwen_label: qwenLabel,
    qwen_label_rel_path: row.qwen_label_rel_path || null,
    qwen_label_classes: Array.isArray(qwenLabel?.classes) ? qwenLabel.classes : [],
    qwen_flags: Array.isArray(qwenLabel?.flags) ? qwenLabel.flags : [],
    qwen_tags: Array.isArray(qwenLabel?.tags) ? qwenLabel.tags : [],
    qwen_risk: Array.isArray(qwenLabel?.risk) ? qwenLabel.risk : [],
    qwen_quality: qwenLabel?.quality || '',
    qwen_summary: qwenLabel?.summary || '',
    event_name: '车辆自采图片',
    day: splitFromPatrolRelPath(row.image_rel_path),
    request_id: meta.sample_id || meta.capture_id || '',
    task_id: '',
    task_row_id: null,
    device_id: meta.vehicle_id || '',
    vehicle_id: meta.vehicle_id || '',
    camera_id: meta.camera_id || '',
    collected_at: meta.collected_at || null,
    position: meta.position || null,
    source_type: dataset.source_type,
    source_label: dataset.source_label,
    capture_source: source,
    collection_mode_label: safeSourceLabelForPatrol(source),
    patrol_meta: meta
  };
}

async function buildYoloPatrolDataset() {
  const rows = await readPatrolMetaRows();
  const rowByKey = new Map();
  let cached = 0;
  let yes = 0;
  let boxes = 0;
  let qwenApplicable = 0;
  let qwenCached = 0;
  let qwenPositive = 0;
  let qwenBboxCached = 0;
  let qwenBboxPositive = 0;
  let qwenBboxBoxes = 0;
  let qwenBboxVerifiedCached = 0;
  let qwenBboxVerifiedPositive = 0;
  let qwenBboxVerifiedBoxes = 0;
  const boxesByClass = {};
  const qwenBboxBoxesByClass = {};
  const qwenBboxVerifiedBoxesByClass = {};
  const qwenBboxQuality = {};
  const qwenCountsByClass = {};
  const qwenImagesByClass = {};
  const qwenFlags = {};
  const qwenQuality = {};
  const qwenTags = {};
  const qwenRisk = {};

  for (const row of rows) {
    const cache = await readPatrolAutoLabelCache(row.meta);
    const yoloLabels = Array.isArray(cache?.labels)
      ? cache.labels.map((label, index) => normalizePatrolLabel(label, index))
      : [];
    const cachePath = cache ? patrolAutoLabelCachePathForSha(row.meta?.image_sha256) : null;
    const qwenBboxCache = await readVehicleUploadQwenBboxLabelCache(row.meta);
    const qwenBboxCachePath = qwenBboxCache ? vehicleUploadQwenBboxLabelCachePathForSha(row.meta?.image_sha256) : null;
    const rawQwenBboxLabels = Array.isArray(qwenBboxCache?.labels)
      ? qwenBboxCache.labels.map((label, index) => normalizeQwenBboxLabel(label, index))
      : [];
    const qwenBboxVerifiedCache = await readVehicleUploadQwenSensitiveBboxLabelCache(row.meta);
    const qwenBboxVerifiedCachePath = qwenBboxVerifiedCache
      ? vehicleUploadQwenSensitiveBboxLabelCachePathForSha(row.meta?.image_sha256)
      : null;
    const qwenBboxVerifiedLabels = Array.isArray(qwenBboxVerifiedCache?.labels)
      ? qwenBboxVerifiedCache.labels.map((label, index) => normalizeQwenSensitiveBboxLabel(label, index))
      : [];
    const qwenBboxLabels = mergeQwenBboxLabelsWithVerifiedSensitive(
      rawQwenBboxLabels,
      qwenBboxVerifiedLabels
    );
    const hasEffectiveQwenBboxCache = Boolean(qwenBboxCache || qwenBboxVerifiedCache);
    const labels = hasEffectiveQwenBboxCache ? qwenBboxLabels : yoloLabels;
    const qwenCache = await readVehicleUploadQwenLabelCache(row.meta);
    const qwenCachePath = qwenCache ? vehicleUploadQwenLabelCachePathForSha(row.meta?.image_sha256) : null;
    const qwenLabel = normalizeVehicleQwenAnnotation(
      qwenCache,
      qwenCachePath ? toForwardSlashPath(path.relative(yoloReviewRuntimeRoot, qwenCachePath)) : ''
    );
    const labelClasses = [...new Set(labels.map((label) => label.class_name).filter(Boolean))];
    row.yolo_auto_label_cache = cache || null;
    row.yolo_auto_labels = yoloLabels;
    row.qwen_bbox_cache = qwenBboxCache || null;
    row.qwen_bbox_raw_labels = rawQwenBboxLabels;
    row.qwen_bbox_verified_cache = qwenBboxVerifiedCache || null;
    row.qwen_bbox_verified_labels = qwenBboxVerifiedLabels;
    row.qwen_bbox_labels = qwenBboxLabels;
    row.auto_label_cache = qwenBboxVerifiedCache || qwenBboxCache || cache || null;
    row.auto_labels = labels;
    row.label_source = qwenBboxVerifiedCache ? 'qwen_bbox_verified' : (qwenBboxCache ? 'qwen_bbox' : (cache ? 'yolo_auto' : 'pending'));
    row.auto_label_status = hasEffectiveQwenBboxCache || cache ? 'done' : 'pending';
    row.auto_label_rel_path = (qwenBboxVerifiedCachePath || qwenBboxCachePath || cachePath)
      ? toForwardSlashPath(path.relative(yoloReviewRuntimeRoot, qwenBboxVerifiedCachePath || qwenBboxCachePath || cachePath))
      : null;
    row.auto_label_classes = labelClasses;
    row.ai_answer = labels.length ? 'YES' : (hasEffectiveQwenBboxCache || cache ? 'NO' : 'NULL');
    row.qwen_bbox_status = hasEffectiveQwenBboxCache ? 'done' : (String(row.meta?.source || '') === 'auto_ad_patrol_flow_upload' ? 'pending' : 'not_applicable');
    row.qwen_bbox_rel_path = (qwenBboxVerifiedCachePath || qwenBboxCachePath)
      ? toForwardSlashPath(path.relative(yoloReviewRuntimeRoot, qwenBboxVerifiedCachePath || qwenBboxCachePath))
      : null;
    row.qwen_bbox_quality = qwenBboxVerifiedCache?.quality || qwenBboxCache?.quality || '';
    row.qwen_bbox_verified_status = qwenBboxVerifiedCache ? 'done' : (qwenBboxCache ? 'not_reviewed' : row.qwen_bbox_status);
    row.qwen_bbox_verified_rel_path = qwenBboxVerifiedCachePath
      ? toForwardSlashPath(path.relative(yoloReviewRuntimeRoot, qwenBboxVerifiedCachePath))
      : null;
    row.qwen_label_cache = qwenCache || null;
    row.qwen_label = qwenLabel;
    row.qwen_label_status = qwenLabel ? qwenLabel.status : (String(row.meta?.source || '') === 'auto_ad_patrol_flow_upload' ? 'pending' : 'not_applicable');
    row.qwen_label_rel_path = qwenLabel?.rel_path || null;
    if (hasEffectiveQwenBboxCache || cache) cached += 1;
    if (hasEffectiveQwenBboxCache) {
      qwenBboxCached += 1;
      qwenBboxBoxes += qwenBboxLabels.length;
      if (qwenBboxLabels.length) {
        qwenBboxPositive += 1;
      }
      const qualityKey = qwenBboxVerifiedCache ? 'verified_sensitive' : (qwenBboxCache?.quality || 'unknown');
      qwenBboxQuality[qualityKey] = (qwenBboxQuality[qualityKey] || 0) + 1;
      for (const label of qwenBboxLabels) {
        const name = label.class_name || String(label.class_id ?? 'unknown');
        qwenBboxBoxesByClass[name] = (qwenBboxBoxesByClass[name] || 0) + 1;
      }
    }
    if (qwenBboxVerifiedCache) {
      qwenBboxVerifiedCached += 1;
      qwenBboxVerifiedBoxes += qwenBboxVerifiedLabels.length;
      if (qwenBboxVerifiedLabels.length) {
        qwenBboxVerifiedPositive += 1;
      }
      for (const label of qwenBboxVerifiedLabels) {
        const name = label.class_name || String(label.class_id ?? 'unknown');
        qwenBboxVerifiedBoxesByClass[name] = (qwenBboxVerifiedBoxesByClass[name] || 0) + 1;
      }
    }
    if (labels.length) {
      yes += 1;
      boxes += labels.length;
    }
    for (const label of labels) {
      const name = label.class_name || String(label.class_id ?? 'unknown');
      boxesByClass[name] = (boxesByClass[name] || 0) + 1;
    }
    if (String(row.meta?.source || '') === 'auto_ad_patrol_flow_upload') {
      qwenApplicable += 1;
    }
    if (qwenLabel) {
      qwenCached += 1;
      if (qwenLabel.classes.length) {
        qwenPositive += 1;
      }
      qwenQuality[qwenLabel.quality || 'unknown'] = (qwenQuality[qwenLabel.quality || 'unknown'] || 0) + 1;
      for (const [className, count] of Object.entries(qwenLabel.counts || {})) {
        if (Number(count) > 0) {
          qwenCountsByClass[className] = (qwenCountsByClass[className] || 0) + Number(count);
          qwenImagesByClass[className] = (qwenImagesByClass[className] || 0) + 1;
        }
      }
      for (const flag of qwenLabel.flags || []) {
        qwenFlags[flag] = (qwenFlags[flag] || 0) + 1;
      }
      for (const tag of qwenLabel.tags || []) {
        qwenTags[tag] = (qwenTags[tag] || 0) + 1;
      }
      for (const item of qwenLabel.risk || []) {
        qwenRisk[item] = (qwenRisk[item] || 0) + 1;
      }
    }
    rowByKey.set(row.image_rel_path, row);
  }

  return {
    id: yoloReviewPatrolDatasetId,
    source: 'patrol',
    source_type: 'vehicle_collection',
    source_label: yoloReviewSourceLabel('vehicle_collection'),
    root: parkCrowdFramesRoot,
    dir: parkCrowdFramesRoot,
    name: yoloReviewPatrolDatasetRel,
    profile: '车辆自采巡逻图预标注',
    kind: 'detect',
    classes: yoloPatrolClasses,
    summary: {
      profile: '车辆自采巡逻图预标注',
      kind: 'detect',
      source_type: 'vehicle_collection',
      source_label: yoloReviewSourceLabel('vehicle_collection'),
      images: { patrol: rows.length },
      boxes: Object.keys(boxesByClass).length ? boxesByClass : { auto_label: boxes },
      answers: { YES: yes, NO: Math.max(0, cached - yes), NULL: Math.max(0, rows.length - cached) },
      auto_label: {
        schema: patrolAutoLabelSchema,
        cached_images: cached,
        pending_images: Math.max(0, rows.length - cached)
      },
      qwen_bbox: {
        schema: vehicleUploadQwenBboxLabelSchema,
        effective_schema: `${vehicleUploadQwenBboxLabelSchema}+${vehicleUploadQwenSensitiveBboxLabelSchema}`,
        cached_images: qwenBboxCached,
        pending_images: Math.max(0, qwenApplicable - qwenBboxCached),
        applicable_images: qwenApplicable,
        positive_images: qwenBboxPositive,
        boxes: qwenBboxBoxes,
        boxes_by_class: qwenBboxBoxesByClass,
        quality: qwenBboxQuality,
        root: toForwardSlashPath(path.relative(yoloReviewRuntimeRoot, vehicleUploadQwenBboxLabelRoot)),
        verified_sensitive: {
          schema: vehicleUploadQwenSensitiveBboxLabelSchema,
          cached_images: qwenBboxVerifiedCached,
          positive_images: qwenBboxVerifiedPositive,
          boxes: qwenBboxVerifiedBoxes,
          boxes_by_class: qwenBboxVerifiedBoxesByClass,
          covered_classes: [...vehicleUploadQwenSensitiveBboxClasses],
          root: toForwardSlashPath(path.relative(yoloReviewRuntimeRoot, vehicleUploadQwenSensitiveBboxLabelRoot))
        }
      },
      qwen_label: {
        schema: vehicleUploadQwenLabelSchema,
        cached_images: qwenCached,
        pending_images: Math.max(0, qwenApplicable - qwenCached),
        applicable_images: qwenApplicable,
        positive_images: qwenPositive,
        classes: vehicleQwenLabelClasses,
        filter_options: vehicleQwenFilterOptions,
        counts_by_class: qwenCountsByClass,
        images_by_class: qwenImagesByClass,
        flags: qwenFlags,
        quality: qwenQuality,
        tags: qwenTags,
        risk: qwenRisk
      }
    },
    rows,
    row_by_key: rowByKey,
    loaded_at_ms: Date.now()
  };
}

function compactYoloPatrolMeta(meta = {}) {
  return {
    source: meta.source || 'cloud_camera_capture',
    image_path: meta.image_path || '',
    image_sha256: meta.image_sha256 || '',
    sample_id: meta.sample_id || '',
    capture_id: meta.capture_id || '',
    vehicle_id: meta.vehicle_id || '',
    camera_id: meta.camera_id || '',
    collected_at: meta.collected_at || null,
    position: meta.position || null
  };
}

function compactYoloPatrolIndexRow(row = {}) {
  return {
    meta: compactYoloPatrolMeta(row.meta || {}),
    meta_path: row.meta_path || '',
    image_rel_path: row.image_rel_path || '',
    auto_labels: Array.isArray(row.auto_labels) ? row.auto_labels : [],
    auto_label_classes: Array.isArray(row.auto_label_classes) ? row.auto_label_classes : [],
    label_source: row.label_source || 'pending',
    auto_label_status: row.auto_label_status || 'pending',
    auto_label_rel_path: row.auto_label_rel_path || null,
    ai_answer: row.ai_answer || 'NULL',
    qwen_bbox_status: row.qwen_bbox_status || 'not_applicable',
    qwen_bbox_rel_path: row.qwen_bbox_rel_path || null,
    qwen_bbox_quality: row.qwen_bbox_quality || '',
    qwen_bbox_verified_status: row.qwen_bbox_verified_status || 'not_applicable',
    qwen_bbox_verified_rel_path: row.qwen_bbox_verified_rel_path || null,
    qwen_label: row.qwen_label || null,
    qwen_label_status: row.qwen_label_status || 'not_applicable',
    qwen_label_rel_path: row.qwen_label_rel_path || null
  };
}

function hydrateYoloPatrolDatasetFromIndex(payload) {
  if (!payload || typeof payload !== 'object' || payload.schema !== yoloReviewPatrolIndexSchema) {
    return null;
  }
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const summary = payload.summary && typeof payload.summary === 'object' ? payload.summary : null;
  if (!summary) {
    return null;
  }
  const rowByKey = new Map();
  for (const row of rows) {
    if (row?.image_rel_path) {
      rowByKey.set(row.image_rel_path, row);
    }
  }
  const builtAtMs = Number(payload.built_at_ms || Date.parse(payload.built_at || '') || 0);
  return {
    id: yoloReviewPatrolDatasetId,
    source: 'patrol',
    source_type: 'vehicle_collection',
    source_label: yoloReviewSourceLabel('vehicle_collection'),
    root: parkCrowdFramesRoot,
    dir: parkCrowdFramesRoot,
    name: yoloReviewPatrolDatasetRel,
    profile: payload.profile || '车辆自采巡逻图预标注',
    kind: payload.kind || 'detect',
    classes: Array.isArray(payload.classes) && payload.classes.length ? payload.classes : yoloPatrolClasses,
    summary,
    rows,
    row_by_key: rowByKey,
    loaded_at_ms: Date.now(),
    index_built_at_ms: builtAtMs,
    index_built_at: payload.built_at || null,
    index_path: yoloReviewPatrolIndexPath
  };
}

async function readYoloPatrolDatasetIndex() {
  const payload = await readJsonFile(yoloReviewPatrolIndexPath, null);
  return hydrateYoloPatrolDatasetFromIndex(payload);
}

async function writeYoloPatrolDatasetIndex(dataset) {
  const now = Date.now();
  const payload = {
    schema: yoloReviewPatrolIndexSchema,
    built_at: new Date(now).toISOString(),
    built_at_ms: now,
    source_root: parkCrowdFramesRoot,
    profile: dataset.profile,
    kind: dataset.kind,
    classes: dataset.classes,
    summary: dataset.summary,
    rows: dataset.rows.map((row) => compactYoloPatrolIndexRow(row))
  };
  await fs.mkdir(path.dirname(yoloReviewPatrolIndexPath), { recursive: true });
  const tmpPath = `${yoloReviewPatrolIndexPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(payload), 'utf8');
  await fs.rename(tmpPath, yoloReviewPatrolIndexPath);
}

function yoloPatrolDatasetAgeMs(dataset) {
  const builtAtMs = Number(dataset?.index_built_at_ms || dataset?.loaded_at_ms || 0);
  return builtAtMs > 0 ? Date.now() - builtAtMs : Number.POSITIVE_INFINITY;
}

async function rebuildYoloPatrolDatasetIndex(reason = 'manual') {
  const startedAt = Date.now();
  const dataset = await buildYoloPatrolDataset();
  dataset.index_built_at_ms = Date.now();
  dataset.index_built_at = new Date(dataset.index_built_at_ms).toISOString();
  await writeYoloPatrolDatasetIndex(dataset);
  yoloReviewPatrolCache.dataset = dataset;
  yoloReviewPatrolCache.loaded_at_ms = Date.now();
  yoloReviewDatasetListCache.datasets = null;
  yoloReviewDatasetListCache.loaded_at_ms = 0;
  console.info('yolo_patrol_index_rebuilt', JSON.stringify({
    reason,
    rows: dataset.rows.length,
    duration_ms: Date.now() - startedAt,
    index_path: yoloReviewPatrolIndexPath
  }));
  return dataset;
}

function scheduleYoloPatrolIndexRefresh(reason = 'stale') {
  if (yoloReviewPatrolCache.refresh_promise) {
    return yoloReviewPatrolCache.refresh_promise;
  }
  yoloReviewPatrolCache.refresh_promise = rebuildYoloPatrolDatasetIndex(reason)
    .catch((error) => {
      console.warn('yolo_patrol_index_refresh_failed', error.message || error);
      return null;
    })
    .finally(() => {
      yoloReviewPatrolCache.refresh_promise = null;
    });
  return yoloReviewPatrolCache.refresh_promise;
}

async function resolveYoloPatrolDataset(options = {}) {
  const now = Date.now();
  const force = Boolean(options.force);
  if (force) {
    if (!yoloReviewPatrolCache.promise) {
      yoloReviewPatrolCache.promise = rebuildYoloPatrolDatasetIndex('force')
        .finally(() => {
          yoloReviewPatrolCache.promise = null;
        });
    }
    return yoloReviewPatrolCache.promise;
  }
  if (yoloReviewPatrolCache.dataset) {
    if (
      now - yoloReviewPatrolCache.loaded_at_ms >= yoloReviewPatrolCacheTtlMs ||
      yoloPatrolDatasetAgeMs(yoloReviewPatrolCache.dataset) >= yoloReviewPatrolIndexFreshMs
    ) {
      scheduleYoloPatrolIndexRefresh('memory_stale');
    }
    return yoloReviewPatrolCache.dataset;
  }

  const indexed = await readYoloPatrolDatasetIndex();
  if (indexed) {
    yoloReviewPatrolCache.dataset = indexed;
    yoloReviewPatrolCache.loaded_at_ms = Date.now();
    if (yoloPatrolDatasetAgeMs(indexed) >= yoloReviewPatrolIndexFreshMs) {
      scheduleYoloPatrolIndexRefresh('file_stale');
    }
    return indexed;
  }

  if (yoloReviewPatrolCache.promise) {
    return yoloReviewPatrolCache.promise;
  }
  const promise = rebuildYoloPatrolDatasetIndex('missing_index')
    .finally(() => {
      if (yoloReviewPatrolCache.promise === promise) {
        yoloReviewPatrolCache.promise = null;
      }
    });
  yoloReviewPatrolCache.promise = promise;
  return promise;
}

async function findFilesNamed(root, fileName, maxDepth = 4, depth = 0) {
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (_error) {
    return [];
  }

  const matches = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name === fileName) {
      matches.push(entryPath);
      continue;
    }
    if (entry.isDirectory() && depth < maxDepth) {
      matches.push(...await findFilesNamed(entryPath, fileName, maxDepth, depth + 1));
    }
  }
  return matches;
}

async function readYoloClasses(datasetDir, summary = {}) {
  const classesPath = path.join(datasetDir, 'classes.txt');
  const fromFile = (await readTextFile(classesPath, ''))
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (fromFile.length) {
    return fromFile;
  }
  return Array.isArray(summary.classes) ? summary.classes.map((item) => String(item || '').trim()).filter(Boolean) : [];
}

function inferYoloDatasetKind(datasetDir, summary = {}) {
  const kind = String(summary.kind || '').trim();
  if (kind === 'detect' || kind === 'classify') {
    return kind;
  }
  return fsSync.existsSync(path.join(datasetDir, 'images')) ? 'detect' : 'classify';
}

function sumYoloImageCounts(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.values(value).reduce((total, item) => total + sumYoloImageCounts(item), 0);
  }
  return 0;
}

async function buildYoloDatasetList() {
  const datasets = [];

  for (const spec of yoloDatasetRootSpecs) {
    const summaryFiles = await findFilesNamed(spec.root, 'dataset_summary.json', 4);
    for (const summaryPath of summaryFiles) {
      const datasetDir = path.dirname(summaryPath);
      if (!isPathWithinRoot(spec.root, datasetDir)) {
        continue;
      }
      const summary = await readJsonFile(summaryPath, null);
      if (!summary || typeof summary !== 'object') {
        continue;
      }

      const id = datasetIdForDir(spec, datasetDir);
      const classes = await readYoloClasses(datasetDir, summary);
      const totalImages = sumYoloImageCounts(summary.images);
      datasets.push({
        id,
        source: spec.alias,
        source_type: 'checker_archive',
        source_label: yoloReviewSourceLabel('checker_archive'),
        name: path.basename(datasetDir),
        parent_name: path.basename(path.dirname(datasetDir)),
        profile: summary.profile || path.basename(datasetDir),
        kind: inferYoloDatasetKind(datasetDir, summary),
        created_at: summary.created_at || null,
        classes,
        images: summary.images || {},
        positive_images: summary.positive_images || null,
        boxes: summary.boxes || null,
        answers: summary.answers || null,
        by_class_yes: summary.by_class_yes || null,
        max_task_id: summary.max_task_id ?? null,
        total_images: totalImages
      });
    }
  }

  try {
    const patrolDataset = await resolveYoloPatrolDataset();
    datasets.push({
      id: patrolDataset.id,
      source: patrolDataset.source,
      source_type: patrolDataset.source_type,
      source_label: patrolDataset.source_label,
      name: patrolDataset.name,
      parent_name: 'park-pcm',
      profile: patrolDataset.profile,
      kind: patrolDataset.kind,
      created_at: null,
      classes: patrolDataset.classes,
      images: patrolDataset.summary.images,
      positive_images: null,
      boxes: patrolDataset.summary.boxes,
      answers: patrolDataset.summary.answers,
      by_class_yes: null,
      max_task_id: null,
      total_images: patrolDataset.rows.length,
      auto_label: patrolDataset.summary.auto_label,
      qwen_bbox: patrolDataset.summary.qwen_bbox,
      qwen_label: patrolDataset.summary.qwen_label
    });
  } catch (error) {
    console.warn('yolo_patrol_dataset_unavailable', error.message || error);
  }

  datasets.sort((left, right) => {
    if (left.source_type !== right.source_type) {
      return left.source_type === 'vehicle_collection' ? -1 : 1;
    }
    const leftTime = Date.parse(left.created_at || '') || 0;
    const rightTime = Date.parse(right.created_at || '') || 0;
    if (leftTime !== rightTime) {
      return rightTime - leftTime;
    }
    return right.id.localeCompare(left.id);
  });
  return datasets;
}

async function listYoloDatasets(options = {}) {
  const now = Date.now();
  const force = Boolean(options.force);
  if (!force && yoloReviewDatasetListCache.datasets && now - yoloReviewDatasetListCache.loaded_at_ms < yoloReviewDatasetListCacheTtlMs) {
    return yoloReviewDatasetListCache.datasets;
  }
  if (!force && yoloReviewDatasetListCache.promise) {
    return yoloReviewDatasetListCache.promise;
  }
  const promise = buildYoloDatasetList()
    .then((datasets) => {
      yoloReviewDatasetListCache.datasets = datasets;
      yoloReviewDatasetListCache.loaded_at_ms = Date.now();
      return datasets;
    })
    .finally(() => {
      if (yoloReviewDatasetListCache.promise === promise) {
        yoloReviewDatasetListCache.promise = null;
      }
    });
  yoloReviewDatasetListCache.promise = promise;
  return promise;
}

async function resolveYoloDataset(datasetId) {
  if (String(datasetId || '').trim() === yoloReviewPatrolDatasetId) {
    return resolveYoloPatrolDataset();
  }
  const parsed = splitDatasetId(datasetId);
  if (!parsed) {
    throw Object.assign(new Error('invalid_dataset_id'), { status: 400 });
  }
  const spec = yoloDatasetRootSpecs.find((item) => item.alias === parsed.alias);
  if (!spec) {
    throw Object.assign(new Error('unknown_dataset_root'), { status: 404 });
  }
  const datasetDir = path.resolve(spec.root, parsed.rel);
  if (!isPathWithinRoot(spec.root, datasetDir)) {
    throw Object.assign(new Error('dataset_out_of_range'), { status: 400 });
  }
  const summaryPath = path.join(datasetDir, 'dataset_summary.json');
  const summary = await readJsonFile(summaryPath, null);
  if (!summary || typeof summary !== 'object') {
    throw Object.assign(new Error('dataset_not_found'), { status: 404 });
  }
  const classes = await readYoloClasses(datasetDir, summary);
  return {
    id: `${spec.alias}:${toForwardSlashPath(path.relative(spec.root, datasetDir))}`,
    source: spec.alias,
    source_type: 'checker_archive',
    source_label: yoloReviewSourceLabel('checker_archive'),
    root: spec.root,
    dir: datasetDir,
    name: path.basename(datasetDir),
    profile: summary.profile || path.basename(datasetDir),
    kind: inferYoloDatasetKind(datasetDir, summary),
    summary,
    classes
  };
}

function resolveYoloDatasetRelPath(dataset, relativePath) {
  const rel = normalizeApiRelPath(relativePath);
  if (!rel || rel.split('/').includes('..')) {
    throw Object.assign(new Error('invalid_dataset_path'), { status: 400 });
  }
  const root = dataset.source === 'patrol' ? parkCrowdFramesRoot : dataset.dir;
  const absolutePath = path.resolve(root, rel);
  if (!isPathWithinRoot(root, absolutePath)) {
    throw Object.assign(new Error('dataset_path_out_of_range'), { status: 400 });
  }
  return { rel, absolutePath };
}

function isYoloImagePath(filePath) {
  return yoloImageExtensions.has(path.extname(String(filePath || '')).toLowerCase());
}

async function collectImageRelPaths(rootDir, baseRel, maxDepth = 2, depth = 0) {
  let entries = [];
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (_error) {
    return [];
  }

  const items = [];
  for (const entry of entries) {
    const abs = path.join(rootDir, entry.name);
    const rel = `${baseRel}/${entry.name}`;
    if (entry.isFile() && isYoloImagePath(entry.name)) {
      items.push(rel);
      continue;
    }
    if (entry.isDirectory() && depth < maxDepth) {
      items.push(...await collectImageRelPaths(abs, rel, maxDepth, depth + 1));
    }
  }
  return items;
}

async function listYoloImageRelPaths(dataset) {
  if (dataset.kind === 'detect') {
    const imageRoot = path.join(dataset.dir, 'images');
    const rels = await collectImageRelPaths(imageRoot, 'images', 3);
    return rels.sort().reverse();
  }

  const rels = [];
  for (const split of ['train', 'val', 'test']) {
    rels.push(...await collectImageRelPaths(path.join(dataset.dir, split), split, 2));
  }
  return rels.sort().reverse();
}

function yoloSplitFromRelPath(kind, rel) {
  const value = normalizeApiRelPath(rel);
  if (kind === 'detect') {
    const match = value.match(/^images\/([^/]+)\//);
    return match?.[1] || '';
  }
  return value.split('/')[0] || '';
}

function yoloClassFromRelPath(kind, rel, metadata = {}) {
  const value = normalizeApiRelPath(rel);
  if (kind === 'classify') {
    return value.split('/')[1] || '';
  }
  return metadata.event_name || '';
}

function parseYoloFilenameMetadata(relativePath) {
  const stem = path.parse(relativePath).name;
  const loopMatch = stem.match(/^(\d{8})_(req_\d+_[A-Za-z0-9]+)_(.+)_(\d+)$/);
  if (loopMatch) {
    return {
      day: loopMatch[1],
      request_id: loopMatch[2],
      event_name: loopMatch[3],
      task_row_id: Number(loopMatch[4]),
      task_id: null
    };
  }

  const legacyMatch = stem.match(/^(\d{8})_(req_\d+_[A-Za-z0-9]+)_(task_[A-Za-z0-9]+)_[A-Za-z0-9]+$/);
  if (legacyMatch) {
    return {
      day: legacyMatch[1],
      request_id: legacyMatch[2],
      event_name: '',
      task_row_id: null,
      task_id: legacyMatch[3]
    };
  }

  return {
    day: '',
    request_id: '',
    event_name: '',
    task_row_id: null,
    task_id: null
  };
}

function yoloLabelRelPathForImage(dataset, imageRelPath) {
  if (dataset.kind !== 'detect') {
    return null;
  }
  const rel = normalizeApiRelPath(imageRelPath);
  if (!rel.startsWith('images/')) {
    return null;
  }
  const parsed = path.posix.parse(rel);
  return `${rel.slice(0, rel.length - parsed.base.length).replace(/^images\//, 'labels/')}${parsed.name}.txt`;
}

function parseYoloLabelText(labelText, classes = []) {
  return String(labelText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const parts = line.split(/\s+/);
      const classId = Number.parseInt(parts[0], 10);
      const nums = parts.slice(1, 5).map((item) => Number(item));
      return {
        index,
        raw: line,
        class_id: Number.isFinite(classId) ? classId : null,
        class_name: Number.isFinite(classId) ? classes[classId] || String(classId) : '',
        x: Number.isFinite(nums[0]) ? nums[0] : null,
        y: Number.isFinite(nums[1]) ? nums[1] : null,
        w: Number.isFinite(nums[2]) ? nums[2] : null,
        h: Number.isFinite(nums[3]) ? nums[3] : null
      };
    });
}

async function readYoloLabelsForItem(dataset, imageRelPath) {
  if (dataset.source === 'patrol') {
    const rel = normalizeApiRelPath(imageRelPath);
    const indexed = dataset.row_by_key?.get(rel);
    if (indexed) {
      const labels = Array.isArray(indexed.auto_labels) ? indexed.auto_labels : [];
      return {
        label_rel_path: indexed.auto_label_rel_path || null,
        label_text: labels.map((label) => label.raw).join('\n'),
        labels,
        auto_label_status: indexed.auto_label_status || 'pending',
        auto_label: indexed.auto_label_cache || null
      };
    }
    const { absolutePath } = resolveYoloDatasetRelPath(dataset, imageRelPath);
    const metaPath = path.join(path.dirname(absolutePath), `${path.parse(absolutePath).name}.json`);
    const meta = await readJsonFile(metaPath, null);
    const cache = await readPatrolAutoLabelCache(meta);
    const labels = Array.isArray(cache?.labels)
      ? cache.labels.map((label, index) => normalizePatrolLabel(label, index))
      : [];
    return {
      label_rel_path: cache ? toForwardSlashPath(path.relative(yoloReviewRuntimeRoot, patrolAutoLabelCachePathForSha(meta?.image_sha256) || yoloReviewRuntimeRoot)) : null,
      label_text: labels.map((label) => label.raw).join('\n'),
      labels,
      auto_label_status: cache ? 'done' : 'pending',
      auto_label: cache || null
    };
  }
  const labelRelPath = yoloLabelRelPathForImage(dataset, imageRelPath);
  if (!labelRelPath) {
    return { label_rel_path: null, label_text: '', labels: [] };
  }
  const { absolutePath } = resolveYoloDatasetRelPath(dataset, labelRelPath);
  const labelText = await readTextFile(absolutePath, '');
  return {
    label_rel_path: labelRelPath,
    label_text: labelText,
    labels: parseYoloLabelText(labelText, dataset.classes)
  };
}

function answerFromYoloItem(kind, itemClass, labels) {
  if (kind === 'classify') {
    return String(itemClass || '').toLowerCase().startsWith('not_') ? 'NO' : 'YES';
  }
  return Array.isArray(labels) && labels.length ? 'YES' : 'NO';
}

function normalizeClassToken(value) {
  return String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
}

function manifestImageRelPath(dataset, manifestItem) {
  const imagePath = String(manifestItem?.image || '').trim();
  if (!imagePath) {
    return '';
  }
  const absolutePath = path.isAbsolute(imagePath) ? path.resolve(imagePath) : path.resolve(dataset.dir, imagePath);
  if (!isPathWithinRoot(dataset.dir, absolutePath)) {
    return '';
  }
  return toForwardSlashPath(path.relative(dataset.dir, absolutePath));
}

async function readYoloManifestItems(dataset) {
  const manifestPath = path.join(dataset.dir, 'manifest_selected_images.jsonl');
  const content = await readTextFile(manifestPath, '');
  if (!content.trim()) {
    return [];
  }
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_error) {
        return null;
      }
    })
    .filter(Boolean)
    .map((item) => ({
      item,
      rel: manifestImageRelPath(dataset, item)
    }))
    .filter((item) => item.rel);
}

function buildYoloBaseItem(dataset, rel, manifestItem = null) {
  const metadata = parseYoloFilenameMetadata(rel);
  const task = Array.isArray(manifestItem?.tasks) && manifestItem.tasks.length ? manifestItem.tasks[0] : null;
  const split = manifestItem?.split || yoloSplitFromRelPath(dataset.kind, rel);
  const itemClass = yoloClassFromRelPath(dataset.kind, rel, {
    event_name: metadata.event_name || task?.event_name || ''
  });
  const taskRowId = Number(task?.task_row_id || metadata.task_row_id || 0);

  return {
    item_key: rel,
    image_rel_path: rel,
    split,
    ai_class: itemClass,
    event_name: task?.event_name || metadata.event_name || itemClass,
    day: metadata.day || (Array.isArray(manifestItem?.days) ? manifestItem.days[0] : ''),
    request_id: task?.request_id || metadata.request_id || '',
    task_id: task?.task_id || metadata.task_id || '',
    task_row_id: Number.isFinite(taskRowId) && taskRowId > 0 ? taskRowId : null,
    device_id: task?.device_id || (Array.isArray(manifestItem?.device_ids) ? manifestItem.device_ids.join(' / ') : ''),
    camera_id: task?.camera_id || (Array.isArray(manifestItem?.camera_ids) ? manifestItem.camera_ids.join(' / ') : ''),
    manifest: manifestItem || null
  };
}

async function yoloBaseItems(dataset) {
  if (dataset.source === 'patrol') {
    const rows = Array.isArray(dataset.rows) ? dataset.rows : await readPatrolMetaRows();
    return rows.map((row) => buildPatrolBaseItem(dataset, row));
  }
  const manifestItems = await readYoloManifestItems(dataset);
  const rows = manifestItems.length
    ? manifestItems
    : (await listYoloImageRelPaths(dataset)).map((rel) => ({ rel, item: null }));

  return rows.map(({ rel, item }) => buildYoloBaseItem(dataset, rel, item));
}

function yoloItemMatchesQuery(item, q) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return [
    item.item_key,
    item.request_id,
    item.task_id,
    item.task_row_id,
    item.ai_class,
    item.event_name,
    item.device_id,
    item.vehicle_id,
    item.camera_id,
    item.collected_at,
    item.capture_source,
    item.collection_mode_label,
    item.source_label,
    item.qwen_summary,
    item.qwen_quality,
    ...(Array.isArray(item.qwen_label_classes) ? item.qwen_label_classes : []),
    ...(Array.isArray(item.qwen_flags) ? item.qwen_flags : []),
    ...(Array.isArray(item.qwen_tags) ? item.qwen_tags : []),
    ...(Array.isArray(item.qwen_risk) ? item.qwen_risk : [])
  ]
    .map((value) => String(value || '').toLowerCase())
    .some((value) => value.includes(needle));
}

async function enrichYoloItem(dataset, item, options = {}) {
  const labelsPayload = options.includeLabels ? await readYoloLabelsForItem(dataset, item.image_rel_path) : null;
  const labels = labelsPayload?.labels || [];
  const labelClasses = labelsPayload
    ? [...new Set(labels.map((label) => label.class_name).filter(Boolean))]
    : Array.isArray(item.label_classes) ? item.label_classes : [];
  const labelCount = labelsPayload
    ? labels.length
    : Number.isFinite(Number(item.label_count)) ? Number(item.label_count) : labels.length;
  const aiAnswer =
    item.ai_answer ||
    item.manifest?.tasks?.[0]?.answer ||
    answerFromYoloItem(dataset.kind, item.ai_class, labels);
  const imageUrl = toYoloDatasetFileUrl(dataset.id, item.image_rel_path);
  return {
    ...item,
    image_url: imageUrl,
    thumb_url: toYoloDatasetFileUrl(dataset.id, item.image_rel_path, { thumb: true, width: 360 }) || imageUrl,
    label_rel_path: labelsPayload?.label_rel_path || item.label_rel_path || yoloLabelRelPathForImage(dataset, item.image_rel_path),
    label_count: labelCount,
    labels: options.includeLabels ? labels : undefined,
    ai_class: item.ai_class || labelClasses.join(', '),
    auto_label_status: labelsPayload?.auto_label_status || item.auto_label_status || undefined,
    auto_label: labelsPayload?.auto_label || undefined,
    source_type: item.source_type || dataset.source_type,
    source_label: item.source_label || dataset.source_label,
    ai_answer: aiAnswer,
    is_positive: aiAnswer === 'YES'
  };
}

async function listYoloReviewItems(datasetId, query = {}) {
  const dataset = await resolveYoloDataset(datasetId);
  const page = toFiniteInteger(query.page, 1, { min: 1, max: 9999 });
  const pageSize = toFiniteInteger(query.page_size, 24, { min: 1, max: 60 });
  const split = String(query.split || '').trim();
  const className = normalizeClassToken(query.class_name || '');
  const qwenLabel = normalizeClassToken(query.qwen_label || '');
  const aiAnswer = String(query.ai_answer || '').trim().toUpperCase();
  const q = String(query.q || '').trim();
  const hasBoxOnly = ['1', 'true', 'yes', 'on'].includes(String(query.has_box || query.hasBox || '').trim().toLowerCase());
  const needsLabelBeforePagination = dataset.source !== 'patrol' && (['YES', 'NO'].includes(aiAnswer) || Boolean(className) || hasBoxOnly);

  const allItems = await yoloBaseItems(dataset);
  let items = allItems;
  items = items.filter((item) => {
    if (split && item.split !== split) {
      return false;
    }
    if (className) {
      if (dataset.source === 'patrol') {
        const classes = Array.isArray(item.label_classes) ? item.label_classes : [];
        if (!classes.some((value) => normalizeClassToken(value) === className)) {
          return false;
        }
      } else if (normalizeClassToken(item.ai_class) !== className) {
        return false;
      }
    }
    if (['YES', 'NO'].includes(aiAnswer) && dataset.source === 'patrol' && item.ai_answer !== aiAnswer) {
      return false;
    }
    if (hasBoxOnly && dataset.source === 'patrol' && Number(item.label_count || 0) <= 0) {
      return false;
    }
    if (qwenLabel && dataset.source === 'patrol') {
      const qwenTokens = [
        item.qwen_label_status,
        item.qwen_quality ? `quality:${item.qwen_quality}` : '',
        ...(Array.isArray(item.qwen_label_classes) ? item.qwen_label_classes : []),
        ...(Array.isArray(item.qwen_flags) ? item.qwen_flags : []),
        ...(Array.isArray(item.qwen_tags) ? item.qwen_tags : []),
        ...(Array.isArray(item.qwen_risk) ? item.qwen_risk : [])
      ]
        .map((value) => normalizeClassToken(value))
        .filter(Boolean);
      if (!qwenTokens.includes(qwenLabel)) {
        return false;
      }
    }
    return yoloItemMatchesQuery(item, q);
  });

  if (needsLabelBeforePagination) {
    const enrichedForAnswer = [];
    for (const item of items) {
      const enriched = await enrichYoloItem(dataset, item, { includeLabels: true });
      const classMatched = !className || (enriched.labels || []).some((label) => normalizeClassToken(label.class_name) === className);
      const answerMatched = !['YES', 'NO'].includes(aiAnswer) || enriched.ai_answer === aiAnswer;
      const boxMatched = !hasBoxOnly || (Array.isArray(enriched.labels) && enriched.labels.length > 0);
      if (classMatched && answerMatched && boxMatched) {
        enrichedForAnswer.push(enriched);
      }
    }
    items = enrichedForAnswer;
  }

  const total = items.length;
  const totalPages = total > 0 ? Math.ceil(total / pageSize) : 1;
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;
  const pageItems = items.slice(start, start + pageSize);
  const enrichedItems = [];
  for (const item of pageItems) {
    enrichedItems.push(item.labels ? item : await enrichYoloItem(dataset, item, { includeLabels: true }));
  }

  const splits = [...new Set(allItems.map((item) => item.split).filter(Boolean))].sort();
  return {
    dataset: {
      id: dataset.id,
      profile: dataset.profile,
      kind: dataset.kind,
      classes: dataset.classes,
      source_type: dataset.source_type,
      source_label: dataset.source_label,
      qwen_bbox: dataset.summary?.qwen_bbox || null,
      qwen_label: dataset.summary?.qwen_label || null,
      summary: dataset.summary
    },
    page: safePage,
    page_size: pageSize,
    total,
    total_pages: totalPages,
    available_splits: splits,
    items: enrichedItems
  };
}

async function getAiCheckTaskDetail(taskRowId) {
  const id = toFiniteInteger(taskRowId, 0, { min: 1, max: Number.MAX_SAFE_INTEGER });
  if (!id) {
    return null;
  }
  const rows = await runArchiveSql(`
    SELECT
      r.id AS request_row_id,
      r.request_id,
      r.device_id,
      r.camera_id,
      r.edge_ts,
      r.received_at_ms,
      r.created_at AS request_created_at,
      r.model,
      r.frame_width,
      r.frame_height,
      r.image_path,
      r.request_json_path,
      r.response_json_path,
      r.request_dir,
      r.latency_ms AS request_latency_ms,
      r.error AS request_error,
      t.id AS task_row_id,
      t.task_idx,
      t.task_id,
      t.event_name,
      t.prompt_text,
      t.expand_ratio,
      t.merged_box_json,
      t.boxes_json,
      t.crop_box_json,
      t.roi_path,
      rs.answer,
      rs.pass,
      rs.raw_text,
      rs.latency_ms,
      rs.error
    FROM tasks t
    JOIN requests r ON r.id = t.request_row_id
    LEFT JOIN results rs ON rs.task_row_id = t.id
    WHERE t.id = ${id}
    LIMIT 1;
  `);
  if (!rows.length) {
    return null;
  }
  const row = rows[0];
  return {
    request: {
      id: row.request_row_id,
      request_id: row.request_id || '',
      device_id: row.device_id || '',
      camera_id: row.camera_id || '',
      edge_ts: row.edge_ts ?? null,
      received_at_ms: row.received_at_ms ?? null,
      created_at: row.request_created_at || null,
      model: row.model || null,
      frame_width: row.frame_width ?? null,
      frame_height: row.frame_height ?? null,
      image_path: row.image_path || null,
      image_url: toArchiveFileUrl(row.image_path || ''),
      request_json_path: row.request_json_path || null,
      request_json_url: toArchiveFileUrl(row.request_json_path || ''),
      response_json_path: row.response_json_path || null,
      response_json_url: toArchiveFileUrl(row.response_json_path || ''),
      request_dir: row.request_dir || null,
      latency_ms: row.request_latency_ms ?? null,
      error: row.request_error || null
    },
    task: normalizeAiCheckTask(row)
  };
}

function normalizeYoloManifestForResponse(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    return null;
  }
  const sourceFrameUrl = toArchiveFileUrlFromAny(manifest.source_frame);
  return {
    split: manifest.split || null,
    is_positive: Boolean(manifest.is_positive),
    box_count: manifest.box_count ?? null,
    positive_boxes_xyxy: Array.isArray(manifest.positive_boxes_xyxy) ? manifest.positive_boxes_xyxy : [],
    device_ids: Array.isArray(manifest.device_ids) ? manifest.device_ids : [],
    camera_ids: Array.isArray(manifest.camera_ids) ? manifest.camera_ids : [],
    days: Array.isArray(manifest.days) ? manifest.days : [],
    frame_width: manifest.frame_width ?? null,
    frame_height: manifest.frame_height ?? null,
    source_frame_url: sourceFrameUrl,
    tasks: Array.isArray(manifest.tasks)
      ? manifest.tasks.map((task) => ({
          ...task,
          frame_url: toArchiveFileUrlFromAny(task.frame_path || task.frame_rel_path),
          roi_url: toArchiveFileUrlFromAny(task.roi_path || task.roi_rel_path)
        }))
      : []
  };
}

async function getYoloReviewItemDetail(datasetId, itemKey) {
  const dataset = await resolveYoloDataset(datasetId);
  const { rel, absolutePath } = resolveYoloDatasetRelPath(dataset, itemKey);
  if (!isYoloImagePath(absolutePath)) {
    throw Object.assign(new Error('not_an_image_item'), { status: 400 });
  }
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) {
      throw Object.assign(new Error('item_not_found'), { status: 404 });
    }
  } catch (error) {
    if (error.status) {
      throw error;
    }
    throw Object.assign(new Error('item_not_found'), { status: 404 });
  }

  if (dataset.source === 'patrol') {
    const indexed = dataset.row_by_key?.get(rel) || null;
    const metaPath = indexed?.meta_path || path.join(path.dirname(absolutePath), `${path.parse(absolutePath).name}.json`);
    const meta = await readJsonFile(metaPath, null) || indexed?.meta || null;
    const detailRow = indexed
      ? { ...indexed, meta: meta || indexed.meta || {}, meta_path: metaPath }
      : {
      meta: meta || {},
      meta_path: metaPath,
      image_rel_path: rel,
      image_abs_path: absolutePath
    };
    const base = buildPatrolBaseItem(dataset, detailRow);
    const enriched = await enrichYoloItem(dataset, base, { includeLabels: true });
    return {
      dataset: {
        id: dataset.id,
        profile: dataset.profile,
        kind: dataset.kind,
        classes: dataset.classes,
        source_type: dataset.source_type,
        source_label: dataset.source_label,
        qwen_bbox: dataset.summary?.qwen_bbox || null,
        qwen_label: dataset.summary?.qwen_label || null,
        summary: dataset.summary
      },
      item: {
        ...enriched,
        patrol_meta: meta || null,
        archive: null
      }
    };
  }

  const manifestItems = await readYoloManifestItems(dataset);
  const manifest = manifestItems.find((item) => item.rel === rel)?.item || null;
  const base = buildYoloBaseItem(dataset, rel, manifest);

  const enriched = await enrichYoloItem(dataset, { ...base, manifest }, { includeLabels: true });
  const archive = enriched.task_row_id ? await getAiCheckTaskDetail(enriched.task_row_id) : null;

  return {
    dataset: {
      id: dataset.id,
      profile: dataset.profile,
      kind: dataset.kind,
      classes: dataset.classes,
      source_type: dataset.source_type,
      source_label: dataset.source_label,
      summary: dataset.summary
    },
    item: {
      ...enriched,
      manifest: normalizeYoloManifestForResponse(manifest),
      archive
    }
  };
}

function normalizeAiCheckTask(task) {
  const mergedBox =
    Array.isArray(task?.merged_box_json) || task?.merged_box_json === null
      ? task?.merged_box_json
      : parseJsonField(task?.merged_box_json, null);
  const boxes =
    Array.isArray(task?.boxes_json) || task?.boxes_json === null
      ? task?.boxes_json
      : parseJsonField(task?.boxes_json, []);
  const cropBox =
    Array.isArray(task?.crop_box_json) || task?.crop_box_json === null
      ? task?.crop_box_json
      : parseJsonField(task?.crop_box_json, null);

  return {
    task_row_id: task?.task_row_id ?? null,
    task_idx: task?.task_idx ?? null,
    task_id: task?.task_id || null,
    event_name: task?.event_name || '',
    prompt_text: task?.prompt_text || '',
    expand_ratio: task?.expand_ratio ?? null,
    merged_box: mergedBox,
    boxes,
    crop_box: cropBox,
    roi_path: task?.roi_path || null,
    roi_url: toArchiveFileUrl(task?.roi_path || ''),
    answer: task?.answer || null,
    pass: task?.pass ?? null,
    raw_text: task?.raw_text || '',
    latency_ms: task?.latency_ms ?? null,
    error: task?.error || null
  };
}

function normalizeAiCheckRequestRow(row) {
  const tasks = parseJsonField(row?.tasks_json, [])
    ?.filter(Boolean)
    .map(normalizeAiCheckTask) || [];

  return {
    id: row?.id ?? row?.request_row_id ?? null,
    request_id: row?.request_id || '',
    device_id: row?.device_id || '',
    camera_id: row?.camera_id || '',
    edge_ts: row?.edge_ts ?? null,
    received_at_ms: row?.received_at_ms ?? null,
    created_at: row?.created_at || null,
    model: row?.model || null,
    frame_width: row?.frame_width ?? null,
    frame_height: row?.frame_height ?? null,
    image_mime_type: row?.image_mime_type || null,
    image_sha256: row?.image_sha256 || null,
    image_size_bytes: row?.image_size_bytes ?? null,
    image_path: row?.image_path || null,
    image_url: toArchiveFileUrl(row?.image_path || ''),
    request_json_path: row?.request_json_path || null,
    request_json_url: toArchiveFileUrl(row?.request_json_path || ''),
    response_json_path: row?.response_json_path || null,
    response_json_url: toArchiveFileUrl(row?.response_json_path || ''),
    request_dir: row?.request_dir || null,
    task_count: row?.task_count ?? tasks.length,
    latency_ms: row?.latency_ms ?? null,
    error: row?.error || null,
    tasks
  };
}

function resolveArchivePath(relativePath) {
  const rel = String(relativePath || '').trim();
  if (!rel) {
    throw new Error('archive_path_required');
  }

  const absolutePath = path.resolve(aiCheckArchiveRoot, rel);
  const normalizedRoot = `${aiCheckArchiveRoot}${path.sep}`;
  if (absolutePath !== aiCheckArchiveRoot && !absolutePath.startsWith(normalizedRoot)) {
    throw new Error('archive_path_out_of_range');
  }

  return absolutePath;
}

async function readArchiveJson(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    return null;
  }

  try {
    const absolutePath = resolveArchivePath(relativePath);
    const content = await fs.readFile(absolutePath, 'utf-8');
    return JSON.parse(content);
  } catch (_error) {
    return null;
  }
}

async function runArchiveSql(sql) {
  const { stdout } = await execFileAsync(sqlite3Bin, ['-json', aiCheckArchiveDbUri, sql], {
    maxBuffer: 8 * 1024 * 1024
  });
  return parseJsonField(stdout, []);
}

async function writeArchiveSql(sql) {
  await execFileAsync(sqlite3Bin, [aiCheckArchiveDbPath, sql], {
    maxBuffer: 1024 * 1024
  });
}

async function saveQwen36MmCheckToArchive({ requestId, eventName, promptText, imageBuffer, imageMimeType, answer, rawText, latencyMs, startMs }) {
  const now = new Date(startMs);
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const timeStr = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const reqHash = crypto.randomBytes(4).toString('hex');
  const taskId = `task_${crypto.randomBytes(4).toString('hex')}`;

  const dirRelPath = `requests/${dateStr}/${timeStr}_${requestId}_${reqHash}`;
  const dirAbsPath = path.join(aiCheckArchiveRoot, dirRelPath);

  const extMap = { 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
  const ext = extMap[imageMimeType.toLowerCase()] || '.jpg';
  const frameRelPath = `${dirRelPath}/frame${ext}`;
  const frameAbsPath = path.join(aiCheckArchiveRoot, frameRelPath);
  const reqJsonRelPath = `${dirRelPath}/request.json`;
  const resJsonRelPath = `${dirRelPath}/response.json`;

  const sha256 = crypto.createHash('sha256').update(imageBuffer).digest('hex');
  const createdAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  await fs.mkdir(dirAbsPath, { recursive: true });
  await fs.writeFile(frameAbsPath, imageBuffer);
  await fs.writeFile(path.join(aiCheckArchiveRoot, reqJsonRelPath), JSON.stringify({ request_id: requestId, event_name: eventName, prompt_text: promptText, model: qwen36MmModel }));
  await fs.writeFile(path.join(aiCheckArchiveRoot, resJsonRelPath), JSON.stringify({ answer, raw_text: rawText, latency_ms: latencyMs }));

  const esc = (s) => String(s == null ? '' : s).replace(/'/g, "''");
  const pass = answer === 'YES' ? 1 : (answer === 'NO' ? 0 : 'NULL');

  const sql = `
BEGIN;
INSERT INTO requests (request_id, device_id, camera_id, edge_ts, received_at_ms, created_at, model, image_mime_type, image_sha256, image_size_bytes, image_path, request_json_path, response_json_path, request_dir, task_count, latency_ms)
  VALUES ('${esc(requestId)}', 'web-qwen36mm', 'upload-panel', ${startMs}, ${startMs}, '${createdAt}', '${esc(qwen36MmModel)}', '${esc(imageMimeType)}', '${sha256}', ${imageBuffer.length}, '${esc(frameRelPath)}', '${esc(reqJsonRelPath)}', '${esc(resJsonRelPath)}', '${esc(dirRelPath)}', 1, ${latencyMs});
INSERT INTO tasks (request_row_id, task_idx, task_id, event_name, prompt_text, created_at)
  VALUES (last_insert_rowid(), 0, '${esc(taskId)}', '${esc(eventName)}', '${esc(promptText)}', '${createdAt}');
INSERT INTO results (request_row_id, task_row_id, task_idx, task_id, answer, pass, raw_text, latency_ms, created_at)
  SELECT r.id, t.id, 0, '${esc(taskId)}', '${esc(answer)}', ${pass}, '${esc(rawText)}', ${latencyMs}, '${createdAt}'
  FROM requests r JOIN tasks t ON t.request_row_id = r.id
  WHERE r.request_id = '${esc(requestId)}' LIMIT 1;
COMMIT;
`.trim();

  await writeArchiveSql(sql);
}

function buildAiCheckHistoryClauses(filters = {}, requestAlias = 'r', options = {}) {
  const includeDevice = options.includeDevice !== false;
  const includeEvent = options.includeEvent !== false;
  const clauses = [];
  const deviceId =
    typeof filters.device_id === 'string' && filters.device_id.trim()
      ? filters.device_id.trim()
      : '';
  const eventName =
    typeof filters.event_name === 'string' && filters.event_name.trim()
      ? filters.event_name.trim()
      : '';

  if (includeDevice && deviceId) {
    clauses.push(`${requestAlias}.device_id = ${toSqlTextLiteral(deviceId)}`);
  }

  if (includeEvent && eventName) {
    clauses.push(`
      ${requestAlias}.id IN (
        SELECT DISTINCT ft.request_row_id
        FROM tasks ft
        WHERE ft.event_name = ${toSqlTextLiteral(eventName)}
      )
    `.trim());
  }

  return clauses;
}

function buildAiCheckHistoryWhere(filters = {}, requestAlias = 'r', options = {}) {
  const clauses = buildAiCheckHistoryClauses(filters, requestAlias, options);
  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
}

async function listAiCheckDeviceOptions(filters = {}) {
  const whereClause = buildAiCheckHistoryWhere(filters, 'r', { includeDevice: false, includeEvent: true });
  const rows = await runArchiveSql(`
    SELECT
      r.device_id,
      COUNT(*) AS total
    FROM requests r
    ${whereClause ? `${whereClause} AND` : 'WHERE'} TRIM(COALESCE(r.device_id, '')) <> ''
    GROUP BY r.device_id
    ORDER BY total DESC, r.device_id COLLATE NOCASE ASC;
  `);

  return rows
    .map((row) => String(row?.device_id || '').trim())
    .filter(Boolean);
}

async function listAiCheckEventOptions(filters = {}) {
  const whereClause = buildAiCheckHistoryWhere(filters, 'r', { includeDevice: true, includeEvent: false });
  const rows = await runArchiveSql(`
    SELECT
      t.event_name,
      COUNT(DISTINCT r.id) AS total
    FROM tasks t
    JOIN requests r ON r.id = t.request_row_id
    ${whereClause ? `${whereClause} AND` : 'WHERE'} TRIM(COALESCE(t.event_name, '')) <> ''
    GROUP BY t.event_name
    ORDER BY total DESC, t.event_name COLLATE NOCASE ASC;
  `);

  return rows
    .map((row) => String(row?.event_name || '').trim())
    .filter(Boolean);
}

async function listAiCheckHistory(page, pageSize, filters = {}) {
  const offset = (page - 1) * pageSize;
  const deviceId =
    typeof filters.device_id === 'string' && filters.device_id.trim()
      ? filters.device_id.trim()
      : '';
  const eventName =
    typeof filters.event_name === 'string' && filters.event_name.trim()
      ? filters.event_name.trim()
      : '';
  const whereClause = buildAiCheckHistoryWhere(filters, 'r');
  const [countRows, rows, availableDeviceIds, availableEventNames] = await Promise.all([
    runArchiveSql(`SELECT COUNT(*) AS total FROM requests r ${whereClause};`),
    runArchiveSql(`
      SELECT
        r.id,
        r.request_id,
        r.device_id,
        r.camera_id,
        r.edge_ts,
        r.received_at_ms,
        r.created_at,
        r.task_count,
        r.latency_ms,
        r.error,
        r.image_path,
        COALESCE((
          SELECT json_group_array(
            json_object(
              'task_idx', t.task_idx,
              'task_id', t.task_id,
              'event_name', t.event_name,
              'roi_path', t.roi_path,
              'answer', rs.answer,
              'pass', rs.pass,
              'error', rs.error
            )
          )
          FROM tasks t
          LEFT JOIN results rs ON rs.task_row_id = t.id
          WHERE t.request_row_id = r.id
          ORDER BY t.task_idx ASC
        ), '[]') AS tasks_json
      FROM requests r
      ${whereClause}
      ORDER BY r.id DESC
      LIMIT ${pageSize} OFFSET ${offset};
    `)
    ,
    listAiCheckDeviceOptions({ event_name: eventName }),
    listAiCheckEventOptions({ device_id: deviceId })
  ]);

  const total = countRows?.[0]?.total ?? 0;
  return {
    page,
    page_size: pageSize,
    total,
    total_pages: total > 0 ? Math.ceil(total / pageSize) : 1,
    selected_device_id: deviceId,
    selected_event_name: eventName,
    available_device_ids: availableDeviceIds,
    available_event_names: availableEventNames,
    items: rows.map(normalizeAiCheckRequestRow)
  };
}

async function getAiCheckHistoryDetail(requestRowId) {
  const rows = await runArchiveSql(`
    SELECT
      r.id AS request_row_id,
      r.request_id,
      r.device_id,
      r.camera_id,
      r.edge_ts,
      r.received_at_ms,
      r.created_at,
      r.model,
      r.frame_width,
      r.frame_height,
      r.image_mime_type,
      r.image_sha256,
      r.image_size_bytes,
      r.image_path,
      r.request_json_path,
      r.response_json_path,
      r.request_dir,
      r.task_count,
      r.latency_ms,
      r.error,
      COALESCE((
        SELECT json_group_array(
          json_object(
            'task_row_id', t.id,
            'task_idx', t.task_idx,
            'task_id', t.task_id,
            'event_name', t.event_name,
            'prompt_text', t.prompt_text,
            'expand_ratio', t.expand_ratio,
            'merged_box_json', t.merged_box_json,
            'boxes_json', t.boxes_json,
            'crop_box_json', t.crop_box_json,
            'roi_path', t.roi_path,
            'answer', rs.answer,
            'pass', rs.pass,
            'raw_text', rs.raw_text,
            'latency_ms', rs.latency_ms,
            'error', rs.error
          )
        )
        FROM tasks t
        LEFT JOIN results rs ON rs.task_row_id = t.id
        WHERE t.request_row_id = r.id
        ORDER BY t.task_idx ASC
      ), '[]') AS tasks_json
    FROM requests r
    WHERE r.id = ${requestRowId}
    LIMIT 1;
  `);

  if (!rows.length) {
    return null;
  }

  const request = normalizeAiCheckRequestRow(rows[0]);
  request.request_json = await readArchiveJson(request.request_json_path);
  request.response_json = await readArchiveJson(request.response_json_path);
  return request;
}

async function readStreamReply(stream, onEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let deltaText = '';
  let reasoningText = '';
  let finalEvent = null;
  let emptyResponse = true;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    emptyResponse = false;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() || '';

    for (const block of blocks) {
      const data = parseSseBlock(block);
      if (!data) {
        continue;
      }

      if (data.type === 'reasoning_delta' && typeof data.text === 'string') {
        reasoningText += data.text;
        onEvent?.({ type: 'reasoning_delta', text: data.text });
      }

      if (data.type === 'delta' && typeof data.text === 'string') {
        deltaText += data.text;
        onEvent?.({ type: 'delta', text: data.text });
      }

      if (data.type === 'final') {
        finalEvent = data;
      }

      if (data.type === 'error') {
        throw new Error(data.error || data.message || 'upstream_stream_error');
      }
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const tail = parseSseBlock(buffer);
    if (tail?.type === 'final') {
      finalEvent = tail;
    } else if (tail?.type === 'reasoning_delta' && typeof tail.text === 'string') {
      reasoningText += tail.text;
    } else if (tail?.type === 'delta' && typeof tail.text === 'string') {
      deltaText += tail.text;
    }
  }

  if (emptyResponse) {
    throw new Error('upstream_stream_empty');
  }

  const reply = normalizeReply(finalEvent?.answer || deltaText);
  if (!reply) {
    throw new Error('upstream_reply_empty');
  }

  return {
    reply,
    reasoning: normalizeReply(finalEvent?.reasoning || reasoningText),
    source: finalEvent?.source || 'chat-stream-proxy',
    latency_ms: finalEvent?.latency_ms || null
  };
}

async function readQwen36Stream(stream, onEvent) {
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  let reasoning = '';
  let usage = null;
  let finishReason = null;
  let emptyResponse = true;

  const handleBlock = (block) => {
    const lines = String(block || '')
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice(6).trim())
      .filter(Boolean);

    for (const line of lines) {
      if (line === '[DONE]') {
        continue;
      }

      let event;
      try {
        event = JSON.parse(line);
      } catch (_error) {
        continue;
      }

      emptyResponse = false;
      usage = event.usage || usage;
      const choice = Array.isArray(event.choices) ? event.choices[0] : null;
      if (!choice) {
        continue;
      }

      finishReason = choice.finish_reason || finishReason;
      const delta = choice.delta || {};
      const message = choice.message || {};
      const reasoningDelta =
        delta.reasoning ||
        delta.reasoning_content ||
        message.reasoning ||
        message.reasoning_content ||
        '';
      const answerDelta = delta.content || message.content || '';

      if (reasoningDelta) {
        reasoning += reasoningDelta;
        onEvent?.({ type: 'reasoning_delta', text: reasoningDelta });
      }

      if (answerDelta) {
        answer += answerDelta;
        onEvent?.({ type: 'delta', text: answerDelta });
      }
    }
  };

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() || '';
    blocks.forEach(handleBlock);
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    handleBlock(buffer);
  }

  if (emptyResponse) {
    throw new Error('qwen36_stream_empty');
  }

  return {
    reply: normalizeReply(answer),
    reasoning: normalizeReply(reasoning),
    finish_reason: finishReason,
    usage
  };
}

function normalizeQwen36Messages(inputMessages, message) {
  const normalized = [];
  const source = Array.isArray(inputMessages) ? inputMessages : [];

  source.slice(-16).forEach((item) => {
    const role = String(item?.role || '').trim();
    const content = String(item?.content || '').trim();
    if (!content || !['system', 'user', 'assistant'].includes(role)) {
      return;
    }
    normalized.push({ role, content: truncateText(content, 6000) });
  });

  if (message) {
    normalized.push({ role: 'user', content: truncateText(message, 6000) });
  }

  return normalized;
}

function createQwen36ProtectionState(name, maxConcurrent) {
  return {
    name,
    in_flight: 0,
    max_concurrent: Math.max(1, Number(maxConcurrent) || 1),
    consecutive_failures: 0,
    failure_threshold: Math.max(1, Number(qwen36CircuitFailureThreshold) || 3),
    circuit_opened_at_ms: 0,
    circuit_cooldown_ms: Math.max(1000, Number(qwen36CircuitCooldownMs) || 120000),
    last_success_at_ms: 0,
    last_failure_at_ms: 0,
    last_error: ''
  };
}

const qwen36Protection = createQwen36ProtectionState('qwen36-text', qwen36MaxConcurrent);
const qwen36MmProtection = createQwen36ProtectionState('qwen36-mm', qwen36MmMaxConcurrent);
const qwen36HealthCache = {
  result: null,
  expires_at_ms: 0,
  promise: null
};

function qwen36ProtectionSnapshot(state) {
  const now = Date.now();
  const circuitOpen =
    state.circuit_opened_at_ms > 0 &&
    now - state.circuit_opened_at_ms < state.circuit_cooldown_ms;
  return {
    name: state.name,
    in_flight: state.in_flight,
    max_concurrent: state.max_concurrent,
    consecutive_failures: state.consecutive_failures,
    failure_threshold: state.failure_threshold,
    circuit_open: circuitOpen,
    circuit_opened_at_ms: state.circuit_opened_at_ms || null,
    cooldown_remaining_ms: circuitOpen
      ? Math.max(0, state.circuit_cooldown_ms - (now - state.circuit_opened_at_ms))
      : 0,
    last_success_at_ms: state.last_success_at_ms || null,
    last_failure_at_ms: state.last_failure_at_ms || null,
    last_error: state.last_error || null
  };
}

function qwen36ProtectionErrorPayload(error, state) {
  return {
    ok: false,
    error: error.code || 'qwen36_unavailable',
    detail: error.message || 'Qwen3.6 service unavailable',
    protection: qwen36ProtectionSnapshot(state)
  };
}

function createQwen36ProtectionError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function beginQwen36Request(state) {
  const snapshot = qwen36ProtectionSnapshot(state);
  if (snapshot.circuit_open) {
    throw createQwen36ProtectionError(
      `${state.name}_circuit_open`,
      'A100 protection circuit is open; retry later.',
      503
    );
  }

  if (state.in_flight >= state.max_concurrent) {
    throw createQwen36ProtectionError(
      `${state.name}_busy`,
      'A100 request queue is full; retry later.',
      429
    );
  }

  state.in_flight += 1;
  let released = false;
  return {
    success() {
      state.consecutive_failures = 0;
      state.circuit_opened_at_ms = 0;
      state.last_error = '';
      state.last_success_at_ms = Date.now();
    },
    failure(error) {
      state.consecutive_failures += 1;
      state.last_failure_at_ms = Date.now();
      state.last_error = String(error?.message || error?.code || 'qwen36_request_failed').slice(0, 240);
      if (state.consecutive_failures >= state.failure_threshold) {
        state.circuit_opened_at_ms = Date.now();
      }
    },
    release() {
      if (released) return;
      released = true;
      state.in_flight = Math.max(0, state.in_flight - 1);
    }
  };
}

function attachQwen36Protection(payload = {}) {
  return {
    ...payload,
    protection: {
      text: qwen36ProtectionSnapshot(qwen36Protection),
      mm: qwen36ProtectionSnapshot(qwen36MmProtection)
    }
  };
}

async function probeQwen36(options = {}) {
  const now = Date.now();
  if (!options.force && qwen36HealthCache.result && qwen36HealthCache.expires_at_ms > now) {
    return attachQwen36Protection({
      ...qwen36HealthCache.result,
      cached: true,
      cache_expires_in_ms: qwen36HealthCache.expires_at_ms - now
    });
  }

  if (!options.force && qwen36HealthCache.promise) {
    return qwen36HealthCache.promise;
  }

  qwen36HealthCache.promise = (async () => {
    let result;
    try {
      const response = await fetch(qwen36ModelsUrl, {
        signal: AbortSignal.timeout(5000)
      });
      const text = await response.text();
      const payload = parseJsonField(text, null);
      result = {
        ok: response.ok,
        status: response.status,
        base_url: qwen36BaseUrl,
        model: qwen36Model,
        models: Array.isArray(payload?.data) ? payload.data.map((item) => item.id).filter(Boolean) : []
      };
    } catch (error) {
      result = {
        ok: false,
        status: 502,
        base_url: qwen36BaseUrl,
        model: qwen36Model,
        detail: error.message
      };
    }

    qwen36HealthCache.result = result;
    qwen36HealthCache.expires_at_ms = Date.now() + qwen36HealthCacheTtlMs;
    qwen36HealthCache.promise = null;
    return attachQwen36Protection({
      ...result,
      cached: false,
      cache_ttl_ms: qwen36HealthCacheTtlMs
    });
  })();

  return qwen36HealthCache.promise;
}

async function probeUpstream() {
  try {
    const response = await fetch(upstreamHealthUrl, {
      signal: AbortSignal.timeout(3000)
    });
    const text = await response.text();

    return {
      ok: response.ok,
      status: response.status,
      detail: text.trim() || null
    };
  } catch (error) {
    return {
      ok: false,
      status: 502,
      detail: error.message
    };
  }
}

async function fetchCloudAgentJson(pathname, options = {}) {
  const url = new URL(pathname, cloudAgentBaseUrl).toString();
  const requestOptions = {
    method: options.method || 'GET',
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(options.timeoutMs || cloudAgentTimeoutMs)
  };

  if (options.body) {
    requestOptions.body = JSON.stringify(options.body);
  }

  let response;
  try {
    response = await fetch(url, requestOptions);
  } catch (error) {
    const wrapped = new Error(`cloud_agent_request_failed: ${error.message}`);
    wrapped.status = 502;
    wrapped.endpoint = url;
    throw wrapped;
  }

  const rawText = await response.text();
  const payload = parseJsonField(rawText, null);

  if (!response.ok) {
    const detail =
      payload?.error || payload?.detail || payload?.message || normalizeReply(rawText) || `HTTP ${response.status}`;
    const wrapped = new Error(detail);
    wrapped.status = response.status;
    wrapped.endpoint = url;
    wrapped.payload = payload;
    throw wrapped;
  }

  return {
    url,
    status: response.status,
    data: payload ?? { raw: normalizeReply(rawText) }
  };
}

async function probeCloudAgent() {
  try {
    const result = await fetchCloudAgentJson('/healthz', { timeoutMs: 5000 });
    return {
      ok: true,
      base_url: cloudAgentBaseUrl,
      ...result.data
    };
  } catch (error) {
    return {
      ok: false,
      base_url: cloudAgentBaseUrl,
      detail: error.message
    };
  }
}

async function listCloudAgentVehicles() {
  const result = await fetchCloudAgentJson('/api/vehicles');
  const vehicles = Array.isArray(result?.data?.vehicles) ? result.data.vehicles : [];
  return vehicles;
}

function getCloudOpsVehicleId(vehicle) {
  return String(vehicle?.vehicle_id || vehicle?.plate_number || vehicle?.vin || '').trim();
}

function extractCloudOpsToolNames(payload) {
  const tools = Array.isArray(payload?.response?.tools)
    ? payload.response.tools
    : Array.isArray(payload?.tools)
      ? payload.tools
      : [];
  return new Set(
    tools
      .map((tool) => String(tool?.name || tool || '').trim())
      .filter(Boolean)
  );
}

function unwrapCloudOpsToolCallResult(payload) {
  return payload?.response?.result || payload?.result || null;
}

function getCloudOpsAudioAlsaCached(vehicleId) {
  const cached = cloudOpsAudioAlsaCache.get(vehicleId);
  if (!cached || typeof cached !== 'object') {
    return null;
  }
  if (!cached.status || cached.supported !== true) {
    return null;
  }
  return cached.status;
}

async function refreshCloudOpsAudioAlsaStatus(vehicleId) {
  if (!cloudOpsAudioAlsaEnabled || !vehicleId) {
    return null;
  }

  const now = Date.now();
  const cached = cloudOpsAudioAlsaCache.get(vehicleId) || {};
  if (cached.pending) {
    return cached.pending;
  }
  if (cached.status && now - Number(cached.status_checked_at_ms || 0) < cloudOpsAudioAlsaStatusTtlMs) {
    return cached.status;
  }
  if (cached.supported === false && now - Number(cached.tool_checked_at_ms || 0) < cloudOpsAudioAlsaToolListTtlMs) {
    return null;
  }

  const pending = (async () => {
    let supported = cached.supported === true;
    let toolCheckedAtMs = Number(cached.tool_checked_at_ms || 0);

    if (!supported || now - toolCheckedAtMs >= cloudOpsAudioAlsaToolListTtlMs) {
      try {
        const toolListResult = await fetchCloudAgentJson(
          `/api/vehicles/${encodeURIComponent(vehicleId)}/tool-list?timeout_s=${cloudOpsAudioAlsaTimeoutS}`,
          { timeoutMs: cloudOpsAudioAlsaHttpTimeoutMs }
        );
        const names = extractCloudOpsToolNames(toolListResult?.data);
        supported = names.has('status.audio_alsa');
        toolCheckedAtMs = Date.now();
        if (!supported) {
          cloudOpsAudioAlsaCache.set(vehicleId, {
            supported: false,
            tool_checked_at_ms: toolCheckedAtMs,
            status: null
          });
          return null;
        }
      } catch (error) {
        cloudOpsAudioAlsaCache.set(vehicleId, {
          ...cached,
          pending: null,
          last_error: error?.message || 'audio_alsa_tool_list_failed',
          last_error_at_ms: Date.now()
        });
        return cached.status || null;
      }
    }

    try {
      const requestBody = {
        args: {
          preferred_keywords: ['Yundea', 'Jabra'],
          speaker_min_percent: cloudOpsAudioAlsaSpeakerMinPercent
        },
        timeout_s: cloudOpsAudioAlsaTimeoutS
      };
      const result = await fetchCloudAgentJson(
        `/api/vehicles/${encodeURIComponent(vehicleId)}/tools/status.audio_alsa`,
        {
          method: 'POST',
          body: requestBody,
          timeoutMs: cloudOpsAudioAlsaHttpTimeoutMs
        }
      );
      const toolResult = unwrapCloudOpsToolCallResult(result?.data) || {};
      const responseOk = result?.data?.response?.ok;
      const status = {
        supported: true,
        vehicle_id: vehicleId,
        checked_at: new Date().toISOString(),
        checked_at_ms: Date.now(),
        ok: responseOk !== false && toolResult?.ok !== false,
        health: toolResult?.health || (responseOk === false || toolResult?.ok === false ? 'fault' : 'ok'),
        speaker_min_percent: cloudOpsAudioAlsaSpeakerMinPercent,
        result: toolResult
      };
      cloudOpsAudioAlsaCache.set(vehicleId, {
        supported: true,
        tool_checked_at_ms: toolCheckedAtMs || Date.now(),
        status_checked_at_ms: status.checked_at_ms,
        status
      });
      return status;
    } catch (error) {
      cloudOpsAudioAlsaCache.set(vehicleId, {
        supported: true,
        tool_checked_at_ms: toolCheckedAtMs || Date.now(),
        status_checked_at_ms: Date.now(),
        status: cached.status || null,
        last_error: error?.message || 'audio_alsa_status_failed',
        last_error_at_ms: Date.now()
      });
      return cached.status || null;
    }
  })();

  cloudOpsAudioAlsaCache.set(vehicleId, {
    ...cached,
    pending
  });

  try {
    return await pending;
  } finally {
    const latest = cloudOpsAudioAlsaCache.get(vehicleId);
    if (latest?.pending === pending) {
      delete latest.pending;
      cloudOpsAudioAlsaCache.set(vehicleId, latest);
    }
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const normalizedLimit = Math.max(1, Math.min(Number(limit) || 1, items.length || 1));
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: normalizedLimit }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function scheduleCloudOpsAudioAlsaRefresh(vehicles = []) {
  if (!cloudOpsAudioAlsaEnabled || !Array.isArray(vehicles) || !vehicles.length) {
    return;
  }
  mapWithConcurrency(vehicles, cloudOpsAudioAlsaMaxConcurrent, async (vehicle) => {
    const vehicleId = getCloudOpsVehicleId(vehicle);
    if (vehicleId) {
      await refreshCloudOpsAudioAlsaStatus(vehicleId);
    }
  }).catch(() => {});
}

function enrichCloudOpsVehiclesWithAudioAlsa(vehicles = []) {
  if (!cloudOpsAudioAlsaEnabled || !Array.isArray(vehicles) || !vehicles.length) {
    return vehicles;
  }

  const enriched = vehicles.map((vehicle) => ({ ...vehicle }));
  enriched.forEach((vehicle) => {
    const vehicleId = getCloudOpsVehicleId(vehicle);
    if (!vehicleId) {
      return;
    }
    const cached = getCloudOpsAudioAlsaCached(vehicleId);
    if (cached) {
      vehicle.audio_alsa_status = cached;
    }
  });
  scheduleCloudOpsAudioAlsaRefresh(enriched);
  return enriched;
}

function normalizeDeployBranchName(value) {
  return String(value || '')
    .trim()
    .replace(/^refs\/remotes\//, '')
    .replace(/^refs\/heads\//, '')
    .replace(/^origin\//, '');
}

function normalizeDeployRepoPath(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function formatDeployRepoLocation(repoPath) {
  const normalizedPath = normalizeDeployRepoPath(repoPath);
  if (!normalizedPath) {
    return '';
  }
  const modulesMarker = '/modules/';
  const markerIndex = normalizedPath.lastIndexOf(modulesMarker);
  if (markerIndex >= 0) {
    return normalizedPath.slice(markerIndex + modulesMarker.length);
  }
  return normalizedPath.split('/').filter(Boolean).slice(-2).join('/');
}

function mergeDeployTargets(existingTargets = [], incomingTargets = []) {
  const byName = new Map();
  [...existingTargets, ...incomingTargets].forEach((target) => {
    const name = String(target?.name || '').trim();
    const pathValue = String(target?.path || '').trim();
    const key = `${name}::${pathValue}`;
    if (!name || byName.has(key)) {
      return;
    }
    byName.set(key, {
      name,
      path: pathValue,
      label:
        pathValue && pathValue !== '.'
          ? `${name || '未命名'} · ${pathValue}`
          : String(name || '未命名')
    });
  });
  return Array.from(byName.values());
}

function normalizeDeployRepositories(targetsResult) {
  const controllers = Array.isArray(targetsResult?.controllers) ? targetsResult.controllers : [];
  const byRepoPath = new Map();
  controllers.forEach((controller) => {
    const controllerName = String(controller?.controller || '').trim();
    const items = Array.isArray(controller?.repositories) ? controller.repositories : [];
    items.forEach((repo) => {
      const repoName = String(repo?.repo || '').trim();
      if (!controllerName || !repoName) {
        return;
      }
      const packages = Array.isArray(repo?.packages) ? repo.packages : [];
      const repoPath = normalizeDeployRepoPath(repo?.path);
      const key = repoPath || repoName;
      const targets = packages.map((pkg) => ({
        name: String(pkg?.name || '').trim(),
        path: String(pkg?.path || '').trim()
      }));
      const existing = byRepoPath.get(key);

      if (existing) {
        existing.controllers = Array.from(new Set([...(existing.controllers || []), controllerName]));
        existing.build_supported = existing.build_supported || Boolean(repo?.build_supported);
        existing.default_target = existing.default_target || repo?.package || '';
        existing.targets = mergeDeployTargets(existing.targets, targets);
        return;
      }

      byRepoPath.set(key, {
        id: '',
        controller: controllerName,
        controllers: [controllerName],
        repo: repoName,
        path: repoPath,
        location_label: formatDeployRepoLocation(repoPath),
        build_supported: Boolean(repo?.build_supported),
        default_target: repo?.package || '',
        targets: mergeDeployTargets([], targets)
      });
    });
  });
  const repositories = Array.from(byRepoPath.values());
  const nameCounts = new Map();
  repositories.forEach((repo) => {
    nameCounts.set(repo.repo, (nameCounts.get(repo.repo) || 0) + 1);
  });
  repositories.forEach((repo) => {
    if ((nameCounts.get(repo.repo) || 0) > 1) {
      const suffix = crypto
        .createHash('sha1')
        .update(repo.path || `${repo.controller}:${repo.repo}`)
        .digest('hex')
        .slice(0, 8);
      repo.id = `${repo.repo}#${suffix}`;
      return;
    }
    repo.id = repo.repo;
  });
  repositories.sort((left, right) => {
    const repoCompare = left.repo.localeCompare(right.repo, 'zh-CN');
    return repoCompare || String(left.location_label || '').localeCompare(String(right.location_label || ''), 'zh-CN');
  });
  return repositories;
}

function normalizeDeployBranches(statusResult) {
  const branches = Array.isArray(statusResult?.branches) ? statusResult.branches : [];
  const seen = new Set();
  const normalized = [];
  branches.forEach((branch) => {
    const rawName = String(branch?.name || '').trim();
    const value = normalizeDeployBranchName(rawName);
    if (!value || value === 'HEAD' || seen.has(value)) {
      return;
    }
    seen.add(value);
    normalized.push({
      value,
      name: rawName || value,
      label: rawName || value,
      sha_short: branch?.sha_short || '',
      subject: branch?.subject || '',
      time: branch?.time || ''
    });
  });
  const currentBranch = normalizeDeployBranchName(statusResult?.current_branch);
  if (currentBranch && !seen.has(currentBranch)) {
    normalized.unshift({
      value: currentBranch,
      name: currentBranch,
      label: currentBranch,
      sha_short: statusResult?.head?.short || '',
      subject: statusResult?.head?.subject || '',
      time: statusResult?.head?.time || ''
    });
  }
  return normalized;
}

function firstDeployFetchRemote(statusResult) {
  const remotes = Array.isArray(statusResult?.remotes) ? statusResult.remotes : [];
  const remote =
    remotes.find((item) => item?.kind === 'fetch' && item?.url) ||
    remotes.find((item) => item?.url);
  return String(remote?.url || '').trim();
}

function fallbackDeployCommits(statusResult, branchName) {
  const commits = [];
  const normalizedBranch = normalizeDeployBranchName(branchName);
  const branch = (Array.isArray(statusResult?.branches) ? statusResult.branches : []).find(
    (item) => normalizeDeployBranchName(item?.name) === normalizedBranch
  );
  if (branch?.sha_short) {
    commits.push({
      sha: branch.sha_short,
      short: branch.sha_short,
      subject: branch.subject || `${normalizedBranch} HEAD`,
      time: branch.time || ''
    });
  }
  if (statusResult?.head?.sha || statusResult?.head?.short) {
    commits.push({
      sha: statusResult.head.sha || statusResult.head.short,
      short: statusResult.head.short || String(statusResult.head.sha || '').slice(0, 8),
      subject: statusResult.head.subject || '当前 HEAD',
      time: statusResult.head.time || ''
    });
  }
  const seen = new Set();
  return commits.filter((commit) => {
    const key = String(commit.sha || commit.short || '').trim();
    const shortKey = String(commit.short || key.slice(0, 8)).trim();
    if (!key || seen.has(key) || (shortKey && seen.has(shortKey))) {
      return false;
    }
    seen.add(key);
    if (shortKey) {
      seen.add(shortKey);
    }
    return true;
  });
}

function isAllowedDeployRemoteUrl(remoteUrl) {
  if (/^[\w.-]+@[\w.-]+:.+/.test(remoteUrl)) {
    return true;
  }
  try {
    const parsed = new URL(remoteUrl);
    return ['http:', 'https:', 'ssh:', 'git:'].includes(parsed.protocol);
  } catch (_error) {
    return false;
  }
}

function applyGitHttpCredentials(remoteUrl, username, password) {
  const gitUsername = String(username || '').trim();
  const gitPassword = String(password || '');
  if (!gitUsername || !gitPassword) {
    return remoteUrl;
  }
  try {
    const parsed = new URL(remoteUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return remoteUrl;
    }
    parsed.username = gitUsername;
    parsed.password = gitPassword;
    return parsed.toString();
  } catch (_error) {
    return remoteUrl;
  }
}

function redactDeploySecret(text, secrets = []) {
  let value = String(text || '');
  secrets
    .map((secret) => String(secret || ''))
    .filter(Boolean)
    .forEach((secret) => {
      value = value.split(secret).join('***');
      try {
        value = value.split(encodeURIComponent(secret)).join('***');
      } catch (_error) {
        // Ignore malformed URI encoding edge cases.
      }
    });
  return value;
}

function redactGitRemoteUrl(remoteUrl) {
  try {
    const parsed = new URL(remoteUrl);
    if (parsed.username) {
      parsed.username = parsed.username ? '***' : '';
    }
    if (parsed.password) {
      parsed.password = '***';
    }
    return parsed.toString();
  } catch (_error) {
    return remoteUrl;
  }
}

function isSensitivePayloadKey(key) {
  return /password|secret|token|credential|authorization|cookie/i.test(String(key || ''));
}

function redactSensitiveString(value) {
  return String(value || '').replace(/((?:https?|git):\/\/[^:/\s@]+:)([^@\s]+)(@)/gi, '$1***$3');
}

function sanitizeCloudOpsPayload(value, seen = new WeakSet()) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeCloudOpsPayload(item, seen));
  }

  if (value && typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);
    const output = {};
    Object.entries(value).forEach(([key, item]) => {
      output[key] = isSensitivePayloadKey(key)
        ? (item ? '***' : item)
        : sanitizeCloudOpsPayload(item, seen);
    });
    seen.delete(value);
    return output;
  }

  if (typeof value === 'string') {
    return redactSensitiveString(value);
  }

  return value;
}

async function listDeployCommitsWithGit(remoteUrl, branchName, limit, credentials = {}) {
  if (!remoteUrl || !isAllowedDeployRemoteUrl(remoteUrl)) {
    throw new Error('unsupported_git_remote_url');
  }
  const normalizedBranch = normalizeDeployBranchName(branchName);
  if (!normalizedBranch || normalizedBranch === 'HEAD') {
    throw new Error('invalid_branch');
  }
  await execFileAsync('git', ['check-ref-format', '--branch', normalizedBranch], {
    timeout: 5000,
    maxBuffer: 1024 * 64
  });
  const depth = Math.min(200, Math.max(20, Number(limit) || 50));
  const gitRemoteUrl = applyGitHttpCredentials(
    remoteUrl,
    credentials.git_username,
    credentials.git_password
  );
  const localRef = `refs/heads/${normalizedBranch}`;
  const fetchRefspec = `+refs/heads/${normalizedBranch}:${localRef}`;
  const cacheKey = crypto
    .createHash('sha256')
    .update(`${remoteUrl}#${normalizedBranch}`)
    .digest('hex')
    .slice(0, 24);
  const cachePath = path.join(cloudOpsDeployGitCacheDir, `${cacheKey}.git`);
  await fs.mkdir(cloudOpsDeployGitCacheDir, { recursive: true });

  const gitEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo'
  };

  try {
    await fs.access(cachePath);
    await execFileAsync(
      'git',
      ['-C', cachePath, 'fetch', '--prune', '--no-tags', '--depth', String(depth), gitRemoteUrl, fetchRefspec],
      { timeout: 45000, maxBuffer: 1024 * 1024, env: gitEnv }
    );
  } catch (_error) {
    await fs.rm(cachePath, { recursive: true, force: true }).catch(() => {});
    await execFileAsync(
      'git',
      [
        'clone',
        '--bare',
        '--filter=blob:none',
        '--no-tags',
        '--depth',
        String(depth),
        '--branch',
        normalizedBranch,
        gitRemoteUrl,
        cachePath
      ],
      { timeout: 90000, maxBuffer: 1024 * 1024, env: gitEnv }
    );
    await execFileAsync('git', ['-C', cachePath, 'remote', 'set-url', 'origin', remoteUrl], {
      timeout: 5000,
      maxBuffer: 1024 * 128,
      env: gitEnv
    }).catch(() => {});
  }

  const logResult = await execFileAsync(
    'git',
    [
      '-C',
      cachePath,
      'log',
      '--date=iso-strict',
      '--pretty=format:%H%x1f%h%x1f%s%x1f%cd',
      '-n',
      String(Math.min(100, Math.max(1, Number(limit) || 50))),
      localRef
    ],
    { timeout: 20000, maxBuffer: 1024 * 1024, env: gitEnv }
  );
  return String(logResult.stdout || '')
    .split('\n')
    .map((line) => {
      const [sha, short, subject, time] = line.split('\x1f');
      return { sha, short, subject, time };
    })
    .filter((item) => item.sha);
}

function inferVehicleIdFromMessage(message, vehicles = []) {
  const source = String(message || '').trim();
  const normalized = source.toLowerCase();

  for (const vehicle of vehicles) {
    const candidates = [
      vehicle?.vehicle_id,
      vehicle?.plate_number,
      vehicle?.vin
    ]
      .map((value) => String(value || '').trim())
      .filter(Boolean);

    for (const candidate of candidates) {
      if (normalized.includes(candidate.toLowerCase())) {
        return String(vehicle?.vehicle_id || vehicle?.plate_number || candidate).trim();
      }
    }
  }

  const directMatch = source.match(/\b[A-Za-z]{2,}-\d{3,}\b/);
  if (directMatch?.[0]) {
    return directMatch[0];
  }

  return '';
}

function normalizeCloudOpsArgs(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

function extractCloudOpsRouteId(message) {
  const match = String(message || '').match(/\broute_[A-Za-z0-9._:-]+\b/);
  return match?.[0] || '';
}

function normalizeCloudOpsRouteText(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .toLowerCase();
}

function collectCloudOpsRouteCandidatesFromPayload(payload, routeMap = new Map(), seen = new Set()) {
  if (!payload || typeof payload !== 'object') {
    return routeMap;
  }

  if (seen.has(payload)) {
    return routeMap;
  }
  seen.add(payload);

  const appendCandidate = (routeId, names = []) => {
    const normalizedRouteId = extractCloudOpsRouteId(routeId);
    if (!normalizedRouteId) {
      return;
    }

    const current = routeMap.get(normalizedRouteId) || {
      route_id: normalizedRouteId,
      names: []
    };

    for (const name of names) {
      const cleaned = String(name || '').trim();
      if (cleaned && !current.names.includes(cleaned)) {
        current.names.push(cleaned);
      }
    }

    routeMap.set(normalizedRouteId, current);
  };

  const maybeRouteId = payload?.route_id || payload?.id || payload?.path_id || '';
  const maybeRouteName =
    payload?.route_name_trimmed || payload?.route_name || payload?.name || payload?.route || '';
  if (maybeRouteId) {
    appendCandidate(maybeRouteId, [maybeRouteName]);
  }

  const arrayKeys = ['routes', 'routes_preview', 'resolved_routes'];
  for (const key of arrayKeys) {
    const items = payload?.[key];
    if (!Array.isArray(items)) {
      continue;
    }

    for (const item of items) {
      if (typeof item === 'string') {
        appendCandidate(item, []);
        continue;
      }
      if (item && typeof item === 'object') {
        appendCandidate(item.route_id || item.id || item.path_id || '', [
          item.route_name_trimmed,
          item.route_name,
          item.name,
          item.route
        ]);
      }
    }
  }

  const previewIds = payload?.route_ids_preview;
  if (Array.isArray(previewIds)) {
    previewIds.forEach((item) => appendCandidate(item, []));
  }

  const nestedKeys = ['data', 'response', 'result', 'summary', 'route_catalog', 'request', 'payload'];
  for (const key of nestedKeys) {
    const nested = payload?.[key];
    if (nested && typeof nested === 'object') {
      collectCloudOpsRouteCandidatesFromPayload(nested, routeMap, seen);
    }
  }

  return routeMap;
}

function extractCloudOpsRouteCandidates(contextItems = []) {
  const routeMap = new Map();

  for (const item of contextItems) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    if (item.payload && typeof item.payload === 'object') {
      collectCloudOpsRouteCandidatesFromPayload(item.payload, routeMap);
    }
  }

  return Array.from(routeMap.values());
}

function resolveCloudOpsRouteIdFromText(message, contextItems = []) {
  const directRouteId = extractCloudOpsRouteId(message);
  if (directRouteId) {
    return directRouteId;
  }

  const normalizedMessage = normalizeCloudOpsRouteText(message);
  if (!normalizedMessage) {
    return '';
  }

  const routeCandidates = extractCloudOpsRouteCandidates(contextItems);
  let bestMatch = null;

  for (const candidate of routeCandidates) {
    const routeId = extractCloudOpsRouteId(candidate?.route_id || '');
    if (!routeId) {
      continue;
    }

    const names = Array.isArray(candidate?.names) ? candidate.names : [];
    const textsToMatch = [routeId, ...names];

    for (const text of textsToMatch) {
      const normalizedText = normalizeCloudOpsRouteText(text);
      if (!normalizedText || !normalizedMessage.includes(normalizedText)) {
        continue;
      }

      if (!bestMatch || normalizedText.length > bestMatch.match_length) {
        bestMatch = {
          route_id: routeId,
          match_length: normalizedText.length
        };
      }
    }
  }

  return bestMatch?.route_id || '';
}

function resolveCloudOpsRouteCandidateFromText(message, candidates = []) {
  const directRouteId = extractCloudOpsRouteId(message);
  if (directRouteId) {
    const matched = candidates.find(
      (candidate) => extractCloudOpsRouteId(candidate?.route_id || '') === directRouteId
    );
    return {
      route_id: directRouteId,
      route_name: matched?.names?.[0] || '',
      match_length: directRouteId.length
    };
  }

  const normalizedMessage = normalizeCloudOpsRouteText(message);
  if (!normalizedMessage) {
    return null;
  }

  let bestMatch = null;

  for (const candidate of candidates) {
    const routeId = extractCloudOpsRouteId(candidate?.route_id || '');
    if (!routeId) {
      continue;
    }

    const names = Array.isArray(candidate?.names) ? candidate.names : [];
    const textsToMatch = [routeId, ...names];

    for (const text of textsToMatch) {
      const normalizedText = normalizeCloudOpsRouteText(text);
      if (!normalizedText || !normalizedMessage.includes(normalizedText)) {
        continue;
      }

      if (!bestMatch || normalizedText.length > bestMatch.match_length) {
        bestMatch = {
          route_id: routeId,
          route_name: names.find(Boolean) || String(text || '').trim(),
          match_length: normalizedText.length
        };
      }
    }
  }

  return bestMatch;
}

function extractCloudOpsRouteNameHint(message) {
  const text = String(message || '')
    .replace(/[，,。！？!?\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) {
    return '';
  }

  const patterns = [
    /(?:正式启动|立即启动|直接启动|开始巡逻|启动巡逻|执行巡逻|开始|启动|执行)\s*([A-Za-z0-9\u4e00-\u9fa5_-]{1,24})/,
    /(?:沿|按|去|走|跑)\s*([A-Za-z0-9\u4e00-\u9fa5_-]{1,24})/,
    /([A-Za-z0-9\u4e00-\u9fa5_-]{1,24})\s*(?:开始巡逻|启动巡逻|执行巡逻|开始|启动|执行)/
  ];

  const stopWords = new Set([
    '巡逻',
    '开始',
    '启动',
    '执行',
    '正式启动',
    '立即启动',
    '直接启动',
    '速度',
    'km',
    'kph'
  ]);

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const candidate = String(match?.[1] || '').trim();
    if (!candidate) {
      continue;
    }
    if (stopWords.has(candidate)) {
      continue;
    }
    if (/^\d+$/.test(candidate)) {
      continue;
    }
    if (/(?:km\/h|kph|公里|圈|速度)$/.test(candidate)) {
      continue;
    }
    return candidate;
  }

  return '';
}

function extractCloudOpsPatrolLoops(message) {
  return extractCloudOpsNumber(message, /(\d+)\s*圈/);
}

function extractCloudOpsSpeedKph(message) {
  return extractCloudOpsNumber(
    message,
    /(\d+(?:\.\d+)?)\s*(?:公里\/小时|km\/h|kph|公里每小时)/i
  );
}

function inferCloudOpsDryRun(message, fallback = true) {
  const text = String(message || '');
  if (
    /(预演|演练|dry[\s-]*run|不要真跑|不要真正启动|只做校验|仅校验|模拟启动|试运行|试跑一下)/i.test(
      text
    )
  ) {
    return true;
  }
  if (
    /(正式启动|确认启动|立即启动|直接启动|真实启动|真正启动|开始巡逻|启动巡逻|执行巡逻|开始沿|沿.+巡逻|去巡逻|run patrol|start patrol)/i.test(
      text
    )
  ) {
    return false;
  }
  return fallback;
}

function inferCloudOpsBodyControlArgs(message) {
  const text = String(message || '');
  const lower = text.toLowerCase();
  const args = {};
  let matched = false;
  const turnOn = /(打开|开启|点亮|亮起|打开一下|开一下|启动)/.test(text);
  const turnOff = /(关闭|关掉|熄灭|灭掉|关闭一下|关一下|取消)/.test(text);

  if (/(广告屏|广告牌|ad[\s_-]*screen)/i.test(text)) {
    matched = true;
    if (turnOn || /广告屏.*开|开.*广告屏/.test(text)) {
      args.ad_screen = true;
    } else if (turnOff || /广告屏.*关|关.*广告屏/.test(text)) {
      args.ad_screen = false;
    }
  }

  if (/(前照灯|前灯|大灯|front[\s_-]*lamp)/i.test(text)) {
    matched = true;
    if (turnOn || /前照灯.*开|前灯.*开|大灯.*开|开.*前照灯|开.*前灯|开.*大灯/.test(text)) {
      args.front_lamp = true;
    } else if (
      turnOff ||
      /前照灯.*关|前灯.*关|大灯.*关|关.*前照灯|关.*前灯|关.*大灯/.test(text)
    ) {
      args.front_lamp = false;
    }
  }

  if (/(氛围灯|mood[\s_-]*lamp)/i.test(text)) {
    matched = true;
    if (turnOn || /氛围灯.*开|开.*氛围灯/.test(text)) {
      args.mood_lamp = true;
    } else if (turnOff || /氛围灯.*关|关.*氛围灯/.test(text)) {
      args.mood_lamp = false;
    }
  }

  if (/(双闪|hazard)/i.test(lower)) {
    matched = true;
    args.steer_lamp = turnOff || /关闭双闪|取消双闪|双闪关闭/.test(text) ? 'off' : 'hazard';
  } else if (/(左转灯|左转向灯|左灯)/.test(text)) {
    matched = true;
    args.steer_lamp =
      turnOff || /关闭左转灯|取消左转灯|左转灯关闭/.test(text) ? 'off' : 'left';
  } else if (/(右转灯|右转向灯|右灯)/.test(text)) {
    matched = true;
    args.steer_lamp =
      turnOff || /关闭右转灯|取消右转灯|右转灯关闭/.test(text) ? 'off' : 'right';
  } else if (
    /(关闭转向灯|取消转向灯|关闭方向灯|方向灯关闭|转向灯关闭|steer[\s_-]*lamp off|turn signal off)/i.test(
      text
    )
  ) {
    matched = true;
    args.steer_lamp = 'off';
  }

  if (!matched) {
    return null;
  }

  args.require_stationary = !/(无需静止|不要求静止|行驶中也执行|允许移动中执行|无需停车)/.test(text);
  if (/(先停巡逻|停止巡逻后|先停止巡逻|先停车|先停下)/.test(text)) {
    args.stop_patrol_first = true;
  }
  return args;
}

async function fetchCloudOpsRouteCatalog(vehicleId, options = {}) {
  const normalizedVehicleId = String(vehicleId || '').trim();
  if (!normalizedVehicleId) {
    return [];
  }

  const cached = cloudOpsRouteCatalogCache.get(normalizedVehicleId);
  const now = Date.now();
  if (cached && now - cached.updated_at_ms < cloudOpsRouteCatalogCacheTtlMs) {
    return cached.routes.map((item) => ({
      route_id: item.route_id,
      names: Array.isArray(item.names) ? [...item.names] : []
    }));
  }

  const timeout_s = toFiniteInteger(options.timeout_s, 25, { min: 5, max: 60 });
  const result = await fetchCloudAgentJson(
    `/api/vehicles/${encodeURIComponent(normalizedVehicleId)}/tools/route.list`,
    {
      method: 'POST',
      body: {
        args: {},
        timeout_s
      },
      timeoutMs: Math.max(cloudAgentTimeoutMs, timeout_s * 1000 + 5000)
    }
  );

  const routeMap = collectCloudOpsRouteCandidatesFromPayload(
    result?.data?.response?.result || result?.data?.response || result?.data
  );
  const routes = Array.from(routeMap.values());
  cloudOpsRouteCatalogCache.set(normalizedVehicleId, {
    updated_at_ms: now,
    routes
  });
  return routes.map((item) => ({
    route_id: item.route_id,
    names: Array.isArray(item.names) ? [...item.names] : []
  }));
}

async function resolveCloudOpsRouteReference(message, contextItems = [], vehicleId = '') {
  const directRouteId = extractCloudOpsRouteId(message);
  if (directRouteId) {
    return {
      route_id: directRouteId,
      route_name: '',
      source: 'direct_route_id'
    };
  }

  const contextCandidates = extractCloudOpsRouteCandidates(contextItems);
  const contextMatch = resolveCloudOpsRouteCandidateFromText(message, contextCandidates);
  if (contextMatch?.route_id) {
    return {
      route_id: contextMatch.route_id,
      route_name: contextMatch.route_name || '',
      source: 'context_match'
    };
  }

  if (vehicleId) {
    try {
      const catalog = await fetchCloudOpsRouteCatalog(vehicleId, { timeout_s: 25 });
      const catalogMatch = resolveCloudOpsRouteCandidateFromText(message, catalog);
      if (catalogMatch?.route_id) {
        return {
          route_id: catalogMatch.route_id,
          route_name: catalogMatch.route_name || '',
          source: 'route_list_match'
        };
      }
    } catch (_error) {
      // Ignore route catalog lookup errors and fall back to route name inference below.
    }
  }

  const routeName = extractCloudOpsRouteNameHint(message);
  if (routeName) {
    return {
      route_id: '',
      route_name: routeName,
      source: 'message_route_name'
    };
  }

  return {
    route_id: '',
    route_name: '',
    source: 'unresolved'
  };
}

async function finalizeCloudOpsPlan(plan, message, contextItems = [], options = {}) {
  const nextPlan = validateCloudOpsPlan(plan) || { action: 'none' };
  const selectedVehicleId = String(options?.selectedVehicleId || '').trim();

  if (!nextPlan.vehicle_id && selectedVehicleId) {
    nextPlan.vehicle_id = selectedVehicleId;
  }

  if (
    nextPlan.action === 'tool_call' &&
    (nextPlan.tool_name === 'route.detail' || nextPlan.tool_name === 'route.start_patrol')
  ) {
    const routeReference = await resolveCloudOpsRouteReference(
      [
        nextPlan?.args?.route_id,
        Array.isArray(nextPlan?.args?.route_ids) ? nextPlan.args.route_ids.join(' ') : '',
        nextPlan?.args?.route_name,
        Array.isArray(nextPlan?.args?.route_names) ? nextPlan.args.route_names.join(' ') : '',
        message
      ]
        .filter(Boolean)
        .join(' '),
      contextItems,
      nextPlan.vehicle_id || selectedVehicleId
    );

    if (routeReference.route_id) {
      nextPlan.args = {
        ...nextPlan.args,
        route_id: routeReference.route_id
      };
      delete nextPlan.args.route_ids;
      delete nextPlan.args.route_name;
      delete nextPlan.args.route_names;
    } else if (!nextPlan?.args?.route_name && routeReference.route_name) {
      nextPlan.args = {
        ...nextPlan.args,
        route_name: routeReference.route_name
      };
      delete nextPlan.args.route_ids;
      delete nextPlan.args.route_names;
    }
  }

  if (nextPlan.action === 'tool_call' && nextPlan.tool_name === 'route.start_patrol') {
    const extractedLoops = extractCloudOpsPatrolLoops(message);
    const extractedSpeed = extractCloudOpsSpeedKph(message);
    const normalizedSpeed = Number(
      extractedSpeed ??
        nextPlan?.args?.speed_kph ??
        nextPlan?.args?.speed_kmh ??
        nextPlan?.args?.speed ??
        NaN
    );
    if (Number.isFinite(normalizedSpeed)) {
      nextPlan.args = {
        ...nextPlan.args,
        speed_kph: normalizedSpeed
      };
      delete nextPlan.args.speed_kmh;
      delete nextPlan.args.speed;
    }

    nextPlan.args = {
      ...nextPlan.args,
      loops: toFiniteInteger(extractedLoops ?? nextPlan?.args?.loops, 1, { min: 1, max: 100 }),
      dry_run: inferCloudOpsDryRun(message, nextPlan?.args?.dry_run !== false)
    };
    nextPlan.timeout_s = Math.max(nextPlan.timeout_s || 0, 30);
  }

  if (nextPlan.action === 'tool_call' && nextPlan.tool_name === 'camera.capture') {
    nextPlan.args = {
      camera_ids:
        Array.isArray(nextPlan?.args?.camera_ids) && nextPlan.args.camera_ids.length
          ? nextPlan.args.camera_ids
          : ['camera1', 'camera2', 'camera3', 'camera4'],
      quality: toFiniteInteger(nextPlan?.args?.quality, 70, { min: 10, max: 95 }),
      max_width: toFiniteInteger(nextPlan?.args?.max_width, 640, { min: 160, max: 1920 }),
      include_base64: nextPlan?.args?.include_base64 !== false
    };
    nextPlan.timeout_s = Math.max(nextPlan.timeout_s || 0, 40);
  }

  if (nextPlan.action === 'tool_call' && nextPlan.tool_name === 'map.preview') {
    nextPlan.args = {
      image_size: toFiniteInteger(nextPlan?.args?.image_size, 1024, { min: 256, max: 2048 }),
      include_base64: nextPlan?.args?.include_base64 !== false
    };
    nextPlan.timeout_s = Math.max(nextPlan.timeout_s || 0, 40);
  }

  if (nextPlan.action === 'tool_call' && nextPlan.tool_name === 'vehicle.clear_collision_stop') {
    nextPlan.args = {
      stop_patrol_first: nextPlan?.args?.stop_patrol_first !== false
    };
    nextPlan.timeout_s = Math.max(nextPlan.timeout_s || 0, 45);
  }

  if (nextPlan.action === 'tool_call' && nextPlan.tool_name === 'vehicle.body_control') {
    const inferredArgs = inferCloudOpsBodyControlArgs(message) || {};
    const mergedArgs = {
      ...nextPlan.args,
      ...inferredArgs
    };
    nextPlan.args = {
      ...mergedArgs,
      require_stationary: mergedArgs.require_stationary !== false,
      stop_patrol_first: mergedArgs.stop_patrol_first === true
    };
    if (!nextPlan.args.steer_lamp && typeof mergedArgs.steer_lamp_mode === 'string') {
      nextPlan.args.steer_lamp = mergedArgs.steer_lamp_mode;
    }
    delete nextPlan.args.steer_lamp_mode;
    delete nextPlan.args.steer_lamp_code;
    nextPlan.timeout_s = Math.max(nextPlan.timeout_s || 0, 35);
  }

  if (nextPlan.action === 'tool_call' && nextPlan.tool_name === 'status.body_control') {
    nextPlan.args = {};
    nextPlan.timeout_s = Math.max(nextPlan.timeout_s || 0, 25);
  }

  return nextPlan;
}

function extractCloudOpsTopic(message) {
  const match = String(message || '').match(/\/[A-Za-z0-9_./-]+/);
  return match?.[0] || '';
}

function extractCloudOpsNumber(message, pattern) {
  const match = String(message || '').match(pattern);
  const value = Number(match?.[1]);
  return Number.isFinite(value) ? value : null;
}

function inferCloudOpsPattern(message) {
  const text = String(message || '').trim();
  const lower = text.toLowerCase();
  const explicitMatch = text.match(
    /(?:pattern|过滤|筛选|包含|查找|匹配)\s*(?:为|成|成了|一下|下)?\s*[:：]?\s*[“"'`]?([A-Za-z0-9_./:-]{2,})[”"'`]?/i
  );

  if (explicitMatch?.[1]) {
    return explicitMatch[1];
  }

  if (/camera|摄像头|相机/.test(lower)) return 'camera';
  if (/record|录制|录像/.test(lower)) return 'record';
  if (/diagnostics|诊断/.test(lower)) return 'diagnostics';
  if (/laser|lidar|点云/.test(lower)) return 'laser';
  if (/fusion|感知/.test(lower)) return 'fusion';
  if (/plan|planning|规划/.test(lower)) return 'plan';
  if (/map|定位/.test(lower)) return 'map';
  return '';
}

function createToolCallPlan(vehicleId, toolName, args = {}, timeout_s = 20) {
  return {
    action: 'tool_call',
    vehicle_id: vehicleId,
    tool_name: toolName,
    args,
    timeout_s
  };
}

function pickCloudOpsList(result) {
  if (Array.isArray(result)) {
    return result;
  }
  if (!result || typeof result !== 'object') {
    return [];
  }

  const candidates = [
    result.items,
    result.routes,
    result.topics,
    result.nodes,
    result.services,
    result.cameras,
    result.captures,
    result.images,
    result.checks,
    result.statuses,
    result.categories,
    result.key_topics
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  if (result.subsystems && typeof result.subsystems === 'object') {
    return Object.entries(result.subsystems).map(([name, value]) => ({
      name,
      subsystem: name,
      ...(value && typeof value === 'object' ? value : {})
    }));
  }

  return [];
}

function formatCloudOpsPreviewList(items, picker, limit = 6) {
  return items
    .map((item) => picker(item))
    .filter(Boolean)
    .slice(0, limit)
    .join('、');
}

function formatCloudOpsHumanBytes(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    return '-';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let current = num;
  let unitIndex = 0;
  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }
  const digits = current >= 100 || unitIndex === 0 ? 0 : current >= 10 ? 1 : 2;
  return `${current.toFixed(digits)} ${units[unitIndex]}`;
}

function formatCloudOpsDurationBrief(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '-';
  }

  const total = Math.round(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const parts = [];
  if (days) parts.push(`${days}天`);
  if (hours) parts.push(`${hours}小时`);
  if (minutes) parts.push(`${minutes}分`);
  if (!parts.length) parts.push(`${total % 60}秒`);
  return parts.join('');
}

function createCloudOpsHeuristicPlan(message, vehicles = [], options = {}) {
  const text = String(message || '').trim();
  const lower = text.toLowerCase();
  const selectedVehicleId = String(options?.selectedVehicleId || '').trim();
  const contextItems = Array.isArray(options?.contextItems) ? options.contextItems : [];
  const vehicleId = inferVehicleIdFromMessage(text, vehicles) || selectedVehicleId || '';
  const routeId = resolveCloudOpsRouteIdFromText(text, contextItems);
  const topic = extractCloudOpsTopic(text);
  const pattern = inferCloudOpsPattern(text);
  const loops = extractCloudOpsNumber(text, /(\d+)\s*圈/);
  const maxPoints = extractCloudOpsNumber(text, /(?:max[_\s-]*points|最多|取前)\s*(\d+)/i);
  const limit = extractCloudOpsNumber(text, /(?:limit|前|最多)\s*(\d+)\s*(?:个|条|行|项|进程)?/i);
  const sampleSeconds = extractCloudOpsNumber(text, /(\d+(?:\.\d+)?)\s*秒/);
  const speedKph = extractCloudOpsNumber(
    text,
    /(\d+(?:\.\d+)?)\s*(?:公里\/小时|km\/h|kph|公里每小时)/i
  );
  const includeRate = /帧率|频率|rate|hz/i.test(lower);
  const dryRun = inferCloudOpsDryRun(text, true);

  if (!text) {
    return { action: 'none' };
  }

  if (/在线车辆|车辆列表|有哪些车|多少台车|哪些车在线/.test(text)) {
    return { action: 'list_vehicles' };
  }

  if (/最近事件|最近活动|事件流|最近上报/.test(text)) {
    return { action: 'recent_events' };
  }

  if (/工具列表|有哪些工具|支持什么工具/.test(text)) {
    return { action: 'tool_list', vehicle_id: vehicleId };
  }

  if (/云端连通|云控连通|握手状态|websocket握手|cloud_probe|云端探测|连云/.test(lower)) {
    return createToolCallPlan(vehicleId, 'network.cloud_probe', {}, 20);
  }

  if (/进程负载|进程排行|top进程|cpu最高|内存最高|占用最高/.test(text)) {
    return createToolCallPlan(
      vehicleId,
      'process.top',
      {
        sort: /内存/.test(text) ? 'memory' : 'cpu',
        limit: toFiniteInteger(limit, 10, { min: 1, max: 30 })
      },
      20
    );
  }

  if (/ros总览|ros overview|topic数量|node数量|service数量|ros规模/.test(lower)) {
    return createToolCallPlan(vehicleId, 'ros.overview', {}, 20);
  }

  if ((topic && /频率|帧率|hz|速率|rate/.test(lower)) || /话题频率|话题帧率|topic rate/.test(lower)) {
    return createToolCallPlan(
      vehicleId,
      'ros.topic.rate',
      {
        topic,
        sample_seconds: sampleSeconds ?? 3.0
      },
      20
    );
  }

  if ((topic && /采样|订阅|抽样|查看.*话题|读取.*话题|topic sample/.test(lower)) || /话题采样|topic sample/.test(lower)) {
    return createToolCallPlan(
      vehicleId,
      'ros.topic.sample',
      {
        topic,
        timeout_s: sampleSeconds ?? 3.0,
        summary_only: true
      },
      20
    );
  }

  if (/话题列表|有哪些话题|topic list|topic列表|ros话题/.test(lower)) {
    return createToolCallPlan(
      vehicleId,
      'ros.topic.list',
      {
        pattern,
        limit: toFiniteInteger(limit, 50, { min: 1, max: 200 })
      },
      20
    );
  }

  if (/节点列表|有哪些节点|ros节点|node list/.test(lower)) {
    return createToolCallPlan(vehicleId, 'ros.node.list', { pattern }, 20);
  }

  if (/服务列表|有哪些服务|ros服务|service list/.test(lower)) {
    return createToolCallPlan(vehicleId, 'ros.service.list', { pattern }, 20);
  }

  if (/诊断|diagnostics/.test(lower)) {
    return createToolCallPlan(vehicleId, 'ros.diagnostics', {}, 20);
  }

  if (/全车快照|整车快照|全车总览|整车状态|vehicle snapshot/.test(lower)) {
    return createToolCallPlan(
      vehicleId,
      'vehicle.snapshot',
      { include_topic_samples: !/不要topic|不带topic|不要采样/.test(text) },
      25
    );
  }

  if (/系统快照|系统资源|cpu内存磁盘|磁盘情况|内存情况|温度|网卡状态|system snapshot/.test(lower)) {
    return createToolCallPlan(
      vehicleId,
      'system.snapshot',
      { include_processes: !/不要进程|不含进程/.test(text) },
      20
    );
  }

  if (/系统能力|能力总览|子系统目录|catalog|状态目录/.test(lower)) {
    return createToolCallPlan(
      vehicleId,
      'status.catalog',
      { include_runtime: !/不要运行态|不带运行态/.test(text) },
      20
    );
  }

  if (/关键节点|节点状态|自动驾驶关键节点|key nodes/.test(lower)) {
    return createToolCallPlan(vehicleId, 'status.key_nodes', {}, 20);
  }

  if (/alsa|usb音频|usb 音频|音频设备|声卡|yundea|jabra|麦克风音量|喇叭音量|speaker.*volume|mic.*volume/.test(lower)) {
    return createToolCallPlan(
      vehicleId,
      'status.audio_alsa',
      {
        preferred_keywords: ['Yundea', 'Jabra'],
        speaker_min_percent: 80
      },
      20
    );
  }

  if (/音频状态|音频链路|麦克风状态|喇叭状态|audio status/.test(lower)) {
    return createToolCallPlan(vehicleId, 'status.audio', {}, 20);
  }

  if (/一键检查|一键排查|启航前检查|自动驾驶检查|健康检查|autodrive check/.test(lower)) {
    return createToolCallPlan(vehicleId, 'health.autodrive_check', {}, 20);
  }

  if (/路线列表|巡逻路线|有哪些路线|route list|列出路线/.test(lower)) {
    return createToolCallPlan(vehicleId, 'route.list', {}, 20);
  }

  if (/车身状态|车灯状态|灯光状态|广告屏状态|前照灯状态|氛围灯状态|双闪状态|转向灯状态|body control status|status body control/.test(lower)) {
    return createToolCallPlan(vehicleId, 'status.body_control', {}, 25);
  }

  if (/routing状态|routing|路线状态|当前路线状态/.test(lower)) {
    return createToolCallPlan(vehicleId, 'status.routing', {}, 20);
  }

  if (/路线详情|route detail|查看路线|路线信息/.test(lower) && routeId) {
    return createToolCallPlan(
      vehicleId,
      'route.detail',
      {
        route_id: routeId,
        max_points: toFiniteInteger(maxPoints, 20, { min: 1, max: 200 })
      },
      20
    );
  }

  if (/停止巡逻|结束巡逻|停止路线|stop patrol/.test(lower)) {
    return createToolCallPlan(vehicleId, 'route.stop_patrol', {}, 20);
  }

  if (/启动巡逻|开始巡逻|执行巡逻|start patrol|跑.*圈|巡逻这条路线/.test(lower)) {
    return createToolCallPlan(
      vehicleId,
      'route.start_patrol',
      {
        route_id: routeId,
        loops: toFiniteInteger(loops, 1, { min: 1, max: 100 }),
        speed_kph: speedKph ?? 2.0,
        dry_run: dryRun
      },
      25
    );
  }

  if (/底盘|can|电量|soc|急停|碰撞停|故障灯|手柄接管/.test(lower)) {
    return createToolCallPlan(vehicleId, 'status.can', {}, 20);
  }

  const bodyControlArgs = inferCloudOpsBodyControlArgs(text);
  if (bodyControlArgs) {
    return createToolCallPlan(vehicleId, 'vehicle.body_control', bodyControlArgs, 35);
  }

  if (/碰撞停复位|防撞梁复位|清除碰撞停|解除碰撞停|清防撞梁|clear collision stop|clear bumper/.test(lower)) {
    return createToolCallPlan(
      vehicleId,
      'vehicle.clear_collision_stop',
      {
        stop_patrol_first: true
      },
      45
    );
  }

  if (/抓拍|看图|看图片|当前图像|拍一张|camera capture/.test(lower)) {
    return createToolCallPlan(
      vehicleId,
      'camera.capture',
      {
        camera_ids: ['camera1', 'camera2', 'camera3', 'camera4'],
        quality: 70,
        max_width: 640,
        include_base64: true
      },
      30
    );
  }

  if (/ai检测配置|检测配置|dino配置|groundingdino配置|检测事件配置|ai detection config/.test(lower)) {
    return createToolCallPlan(vehicleId, 'ai_detection.config', {}, 30);
  }

  if (/ai检测图片|检测图片|检测落盘|dino图片|groundingdino图片|最近检测图|ai detection images/.test(lower)) {
    return createToolCallPlan(
      vehicleId,
      'ai_detection.images',
      {
        limit: 6
      },
      35
    );
  }

  if (/地图查看|地图预览|查看地图|地图情况|点云地图|map preview|show map/.test(lower)) {
    return createToolCallPlan(
      vehicleId,
      'map.preview',
      {
        image_size: 1024,
        include_base64: true
      },
      40
    );
  }

  if (/障碍俯视图|障碍预览|障碍物俯视图|查看障碍物|障碍物预览|obstacle preview/.test(lower)) {
    return createToolCallPlan(
      vehicleId,
      'obstacle.preview',
      {
        topic: '/fusion/objects',
        range_m: 15,
        image_size: 768,
        save_file: true,
        include_base64: true
      },
      40
    );
  }

  if (/上传链路|推流链路|视频上传|上传状态|upload chain/.test(lower)) {
    return createToolCallPlan(vehicleId, 'camera.upload_chain', {}, 20);
  }

  if (/相机|摄像头|camera|视频链路|图像链路/.test(lower)) {
    return createToolCallPlan(
      vehicleId,
      'status.camera',
      {
        include_rate: includeRate,
        sample_seconds: includeRate ? sampleSeconds ?? 1.0 : undefined
      },
      20
    );
  }

  if (/定位|localization|ndt|gps|imu|经纬度|heading|定位可靠/.test(lower)) {
    return createToolCallPlan(vehicleId, 'status.localization', {}, 20);
  }

  if (/规划|planning|estop|坡道|圈数|参考线/.test(lower)) {
    return createToolCallPlan(vehicleId, 'status.planning', {}, 20);
  }

  if (/控制输出|控制链路|control|控制状态/.test(lower)) {
    return createToolCallPlan(vehicleId, 'status.control', {}, 20);
  }

  if (/障碍处理|障碍链路|激光输入|obstacle processor/.test(lower)) {
    return createToolCallPlan(vehicleId, 'status.obstacle_processor', {}, 20);
  }

  if (/感知|perception|融合目标|点云|人群|挥手|fusion|crowd|handwave/.test(lower)) {
    return createToolCallPlan(vehicleId, 'status.perception', {}, 20);
  }

  if (/快照|snapshot/.test(lower)) {
    return { action: 'snapshot_request', vehicle_id: vehicleId, timeout_s: 20 };
  }

  if (/详情|缓存|最近状态|当前状态/.test(text) && vehicleId) {
    return { action: 'vehicle_detail', vehicle_id: vehicleId };
  }

  if (/主控|网络|连通|ssh|master_probe|探测/.test(lower)) {
    return {
      action: 'tool_call',
      vehicle_id: vehicleId,
      tool_name: 'network.master_probe',
      args: { include_ssh: true },
      timeout_s: 25
    };
  }

  if (/健康|状态|heartbeat|资源|体检|健康快照/.test(lower)) {
    return {
      action: 'tool_call',
      vehicle_id: vehicleId,
      tool_name: 'health.snapshot',
      args: {},
      timeout_s: 20
    };
  }

  return { action: 'none', vehicle_id: vehicleId };
}

function validateCloudOpsPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return null;
  }

  const action = String(plan.action || '').trim();
  const allowedActions = new Set([
    'none',
    'list_vehicles',
    'vehicle_detail',
    'tool_list',
    'snapshot_request',
    'recent_events',
    'tool_call'
  ]);

  if (!allowedActions.has(action)) {
    return null;
  }

  return {
    action,
    vehicle_id: String(plan.vehicle_id || '').trim(),
    request_id: String(plan.request_id || '').trim(),
    tool_name: String(plan.tool_name || '').trim(),
    args: normalizeCloudOpsArgs(plan.args),
    timeout_s: toFiniteInteger(plan.timeout_s, 20, { min: 3, max: 120 }),
    reason: String(plan.reason || '').trim()
  };
}

async function planCloudOpsAction(message, sessionId, vehicles = [], options = {}) {
  const contextItems = normalizeOpenClawContextItems(options?.contextItems);
  const selectedVehicleId = String(options?.selectedVehicleId || '').trim();
  const routeCandidates = extractCloudOpsRouteCandidates(contextItems).slice(0, 12);
  const heuristicPlan = createCloudOpsHeuristicPlan(message, vehicles, {
    contextItems,
    selectedVehicleId
  });
  const validatedHeuristicPlan = validateCloudOpsPlan(heuristicPlan) || { action: 'none' };

  if (validatedHeuristicPlan.action !== 'none') {
    return finalizeCloudOpsPlan(validatedHeuristicPlan, message, contextItems, {
      selectedVehicleId
    });
  }

  const vehicleHints = vehicles.map((vehicle) => ({
    vehicle_id: vehicle?.vehicle_id || null,
    plate_number: vehicle?.plate_number || null,
    vin: vehicle?.vin || null,
    last_seen: vehicle?.last_seen || null,
    tool_count: vehicle?.tool_count ?? null
  }));

  const plannerPrompt = [
    '你是云端运维动作规划器。',
    '你的任务是把用户的中文请求，映射为一个 JSON 动作，不要输出任何解释，不要输出 markdown 代码块。',
    '允许动作 action 只有：none, list_vehicles, vehicle_detail, tool_list, snapshot_request, recent_events, tool_call。',
    '如果用户想看在线车辆或车辆列表，用 list_vehicles。',
    '如果用户想看某台车详情、heartbeat、snapshot、缓存，用 vehicle_detail。',
    '如果用户想看工具列表，用 tool_list。',
    '如果用户想让车辆立即回一份快照，用 snapshot_request。',
    '如果用户想看最近事件或最近活动，用 recent_events。',
    '如果用户明确说当前状态、详情、缓存、最近状态，并且带了具体 vehicle_id，优先用 vehicle_detail。',
    '如果用户想查健康、资源、状态，优先用 tool_call 并把 tool_name 设为 health.snapshot。',
    '如果用户想查主控连通性、网络或 SSH，优先用 tool_call 并把 tool_name 设为 network.master_probe，args.include_ssh=true。',
    '如果用户想查云端握手或云端连通性，优先用 tool_call 并把 tool_name 设为 network.cloud_probe。',
    '如果用户想看系统资源、CPU、内存、磁盘、温度，用 tool_call: system.snapshot。',
    '如果用户想看 ROS 总览，用 tool_call: ros.overview。',
    '如果用户想看 ROS 话题列表、节点列表、服务列表、诊断、话题采样、话题频率，用相应 ros.* 工具。',
    '如果用户想看子系统目录、关键节点、普通音频链路、一键健康检查、相机状态、相机抓拍、地图预览、上传链路、AI检测配置、AI检测落盘图片、CAN/底盘、车身状态、车身控制、碰撞停复位、定位、规划、routing、控制、障碍处理、障碍俯视图、感知，分别用 status.catalog、status.key_nodes、status.audio、health.autodrive_check、status.camera、camera.capture、map.preview、camera.upload_chain、ai_detection.config、ai_detection.images、status.can、status.body_control、vehicle.body_control、vehicle.clear_collision_stop、status.localization、status.planning、status.routing、status.control、status.obstacle_processor、obstacle.preview、status.perception。',
    '如果用户想看 ALSA、USB 音频设备、Yundea/Jabra、麦克风音量或喇叭音量，用 tool_call: status.audio_alsa，args.preferred_keywords=["Yundea","Jabra"], args.speaker_min_percent=80。',
    '如果用户说打开广告屏、关闭广告屏、打开前照灯、关闭前照灯、打开氛围灯、关闭氛围灯、打开双闪、左转灯、右转灯、关闭转向灯，优先用 vehicle.body_control。',
    '如果用户想看巡逻路线、路线详情、启动巡逻、停止巡逻，分别用 route.list、route.detail、route.start_patrol、route.stop_patrol。',
    '如果用户明确说开始巡逻、启动巡逻、执行巡逻，route.start_patrol 默认按正式执行；只有当用户说预演、演练、试运行、不要真跑时，才把 args.dry_run=true。',
    '如果用户提到路线名，例如“8楼”“4d”，并且当前会话上下文里有路线提示，请把它映射为对应的 args.route_id。',
    '如果没有明确运维动作，action 返回 none。',
    'JSON 字段格式：{"action":"","vehicle_id":"","tool_name":"","args":{},"timeout_s":20,"reason":""}',
    `当前在线车辆提示：${safeJsonStringify(vehicleHints, 4000)}`,
    selectedVehicleId ? `当前选中车辆：${selectedVehicleId}` : '当前选中车辆：未指定',
    routeCandidates.length
      ? `当前会话路线提示：${safeJsonStringify(
          routeCandidates.map((item) => ({
            route_id: item.route_id,
            names: item.names
          })),
          4000
        )}`
      : '当前会话路线提示：无',
    `用户请求：${message}`
  ].join('\n');

  try {
    const result = await runOpenClawTurn(
      plannerPrompt,
      `${sessionId}-${cloudAgentPlanSessionSuffix}`
    );
    const plan = validateCloudOpsPlan(extractJsonObject(result.reply));
    if (plan) {
      return finalizeCloudOpsPlan(plan, message, contextItems, {
        selectedVehicleId
      });
    }
  } catch (_error) {
    // Fall back to heuristics below.
  }

  return { action: 'none' };
}

async function executeCloudOpsAction(plan, vehicles = []) {
  const inferredVehicleId =
    plan.vehicle_id ||
    inferVehicleIdFromMessage(plan.reason || '', vehicles) ||
    (vehicles.length === 1
      ? String(vehicles[0]?.vehicle_id || vehicles[0]?.plate_number || '').trim()
      : '');

  const vehicleId = inferredVehicleId || plan.vehicle_id;
  const timeout_s = toFiniteInteger(plan.timeout_s, 20, { min: 3, max: 120 });

  if (plan.action === 'none') {
    return {
      ok: true,
      action: 'none',
      endpoint: null,
      request: null,
      data: null
    };
  }

  if (
    ['vehicle_detail', 'tool_list', 'snapshot_request', 'tool_call'].includes(plan.action) &&
    !vehicleId
  ) {
    return {
      ok: false,
      action: plan.action,
      endpoint: null,
      request: null,
      error: 'vehicle_id_required',
      detail: '当前请求需要指定 vehicle_id，但未能从问题中识别到车辆。'
    };
  }

  try {
    if (plan.action === 'list_vehicles') {
      const result = await fetchCloudAgentJson('/api/vehicles');
      return {
        ok: true,
        action: plan.action,
        endpoint: result.url,
        request: null,
        data: result.data
      };
    }

    if (plan.action === 'recent_events') {
      const result = await fetchCloudAgentJson('/api/events');
      return {
        ok: true,
        action: plan.action,
        endpoint: result.url,
        request: null,
        data: result.data
      };
    }

    if (plan.action === 'vehicle_detail') {
      const result = await fetchCloudAgentJson(`/api/vehicles/${encodeURIComponent(vehicleId)}`);
      return {
        ok: true,
        action: plan.action,
        endpoint: result.url,
        request: { vehicle_id: vehicleId },
        data: result.data
      };
    }

    if (plan.action === 'tool_list') {
      const result = await fetchCloudAgentJson(
        `/api/vehicles/${encodeURIComponent(vehicleId)}/tool-list?timeout_s=${timeout_s}`,
        {
          timeoutMs: getCloudAgentToolHttpTimeoutMs(timeout_s)
        }
      );
      return {
        ok: true,
        action: plan.action,
        endpoint: result.url,
        request: { vehicle_id: vehicleId, timeout_s },
        data: result.data
      };
    }

    if (plan.action === 'snapshot_request') {
      const requestBody = { timeout_s };
      if (plan.request_id) {
        requestBody.request_id = plan.request_id;
      }
      const result = await fetchCloudAgentJson(
        `/api/vehicles/${encodeURIComponent(vehicleId)}/snapshot-request`,
        {
          method: 'POST',
          body: requestBody,
          timeoutMs: getCloudAgentToolHttpTimeoutMs(timeout_s)
        }
      );
      const responseOk = result?.data?.response?.ok;
      if (responseOk === false) {
        return {
          ok: false,
          action: plan.action,
          endpoint: result.url,
          request: { vehicle_id: vehicleId, ...requestBody },
          error: 'cloud_snapshot_failed',
          detail: result?.data?.response?.error || 'snapshot_request_failed',
          payload: result.data
        };
      }
      return {
        ok: true,
        action: plan.action,
        endpoint: result.url,
        request: { vehicle_id: vehicleId, ...requestBody },
        data: result.data
      };
    }

    if (plan.action === 'tool_call') {
      const toolName = plan.tool_name || 'health.snapshot';
      const requestBody = {
        args: normalizeCloudOpsArgs(plan.args),
        timeout_s
      };
      if (plan.request_id) {
        requestBody.request_id = plan.request_id;
      }
      const result = await fetchCloudAgentJson(
        `/api/vehicles/${encodeURIComponent(vehicleId)}/tools/${encodeURIComponent(toolName)}`,
        {
          method: 'POST',
          body: requestBody,
          timeoutMs: getCloudAgentToolHttpTimeoutMs(timeout_s)
        }
      );
      const responseOk = result?.data?.response?.ok;
      const toolStatus = String(result?.data?.response?.result?.status || '').trim().toLowerCase();
      if (responseOk === false) {
        const structuredToolResult = result?.data?.response?.result;
        if (
          toolName === 'status.audio_alsa' &&
          structuredToolResult &&
          typeof structuredToolResult === 'object' &&
          !Array.isArray(structuredToolResult) &&
          (
            Object.prototype.hasOwnProperty.call(structuredToolResult, 'health') ||
            Object.prototype.hasOwnProperty.call(structuredToolResult, 'speaker') ||
            Object.prototype.hasOwnProperty.call(structuredToolResult, 'mic') ||
            Object.prototype.hasOwnProperty.call(structuredToolResult, 'microphone') ||
            Object.prototype.hasOwnProperty.call(structuredToolResult, 'issues') ||
            Object.prototype.hasOwnProperty.call(structuredToolResult, 'selected_device') ||
            Object.prototype.hasOwnProperty.call(structuredToolResult, 'card')
          )
        ) {
          return {
            ok: true,
            action: plan.action,
            endpoint: result.url,
            request: { vehicle_id: vehicleId, tool_name: toolName, ...requestBody },
            data: result.data
          };
        }
        return {
          ok: false,
          action: plan.action,
          endpoint: result.url,
          request: { vehicle_id: vehicleId, tool_name: toolName, ...requestBody },
          error: 'cloud_tool_failed',
          detail: result?.data?.response?.error || `${toolName}_failed`,
          payload: result.data
        };
      }
      if (toolName === 'vehicle.clear_collision_stop' && toolStatus === 'error') {
        return {
          ok: false,
          action: plan.action,
          endpoint: result.url,
          request: { vehicle_id: vehicleId, tool_name: toolName, ...requestBody },
          error: 'cloud_tool_failed',
          detail:
            result?.data?.response?.result?.message ||
            result?.data?.response?.result?.detail ||
            'vehicle.clear_collision_stop returned status=error',
          payload: result.data
        };
      }
      return {
        ok: true,
        action: plan.action,
        endpoint: result.url,
        request: { vehicle_id: vehicleId, tool_name: toolName, ...requestBody },
        data: result.data
      };
    }

    return {
      ok: false,
      action: plan.action,
      endpoint: null,
      request: null,
      error: 'unsupported_action',
      detail: `暂不支持动作：${plan.action}`
    };
  } catch (error) {
    return {
      ok: false,
      action: plan.action,
      endpoint: error.endpoint || null,
      request:
        plan.action === 'tool_call'
          ? {
              vehicle_id: vehicleId,
              request_id: plan.request_id,
              tool_name: plan.tool_name,
              args: normalizeCloudOpsArgs(plan.args),
              timeout_s
            }
          : vehicleId
            ? { vehicle_id: vehicleId, request_id: plan.request_id, timeout_s }
            : null,
      error: error.status ? `http_${error.status}` : 'cloud_agent_request_failed',
      detail: error.message,
      payload: error.payload || null
    };
  }
}

const mapEditorAllowedGetPaths = new Set([
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/api/status',
  '/api/map-files',
  '/api/routes',
  '/api/envelope',
  '/api/route',
  '/api/route-controls',
  '/api/route-edit',
  '/api/route-preview',
  '/api/route-create',
  '/api/route-delete',
  '/api/pointcloud.bin'
]);
const mapEditorAllowedPostPaths = new Set([
  '/api/envelope',
  '/api/route-edit',
  '/api/route-preview',
  '/api/route-create',
  '/api/route-delete'
]);
const mapEditorBinaryPaths = new Set(['/api/pointcloud.bin']);
const mapEditorLargeJsonPaths = new Set([
  '/api/route',
  '/api/route-edit',
  '/api/route-preview',
  '/api/route-create',
  '/api/route-delete'
]);
const MAP_EDITOR_CHUNK_THRESHOLD_BYTES = 512 * 1024;
const MAP_EDITOR_CHUNK_SIZE_BYTES = 512 * 1024;
const MAP_EDITOR_MAX_CHUNKS = 96;

function normalizeMapEditorPath(value) {
  const pathValue = String(value || '/').trim() || '/';
  const normalized = pathValue.startsWith('/') ? pathValue : `/${pathValue}`;
  if (
    normalized.includes('\0') ||
    normalized.includes('\\') ||
    normalized.includes('//') ||
    normalized.split('/').includes('..')
  ) {
    return '';
  }
  return normalized;
}

function getMapEditorMaxResponseBytes(editorPath) {
  if (mapEditorBinaryPaths.has(editorPath)) {
    return 12 * 1024 * 1024;
  }
  if (mapEditorLargeJsonPaths.has(editorPath)) {
    return 12 * 1024 * 1024;
  }
  return 2 * 1024 * 1024;
}

function shouldChunkMapEditorPath(editorPath) {
  return mapEditorBinaryPaths.has(editorPath) || mapEditorLargeJsonPaths.has(editorPath);
}

function getMapEditorHeader(headers, key) {
  if (!headers || typeof headers !== 'object') {
    return '';
  }
  const target = String(key || '').toLowerCase();
  const match = Object.entries(headers).find(
    ([headerKey]) => String(headerKey || '').toLowerCase() === target
  );
  return match ? String(match[1] || '') : '';
}

function unwrapMapEditorToolResult(execution) {
  return (
    execution?.data?.response?.result ||
    execution?.data?.result ||
    execution?.payload?.response?.result ||
    null
  );
}

function getCloudAgentToolHttpTimeoutMs(timeout_s) {
  const seconds = Number(timeout_s);
  const timeoutMs = Number.isFinite(seconds)
    ? Math.ceil(seconds * 1000) + 8000
    : cloudAgentTimeoutMs;
  return Math.max(cloudAgentTimeoutMs, timeoutMs);
}

async function executeMapEditorTool(vehicleId, toolName, args = {}, timeout_s = 30) {
  return executeCloudOpsAction(
    {
      action: 'tool_call',
      vehicle_id: vehicleId,
      tool_name: toolName,
      args,
      timeout_s,
      request_id: `map-editor-${toolName.replace(/\W+/g, '-')}-${Date.now().toString(36)}`
    },
    []
  );
}

async function readMapEditorChunkedBody(vehicleId, initialResult, editorPath) {
  const chunkId = String(initialResult?.chunk_id || '').trim();
  if (!/^[a-f0-9]{32}$/i.test(chunkId)) {
    throw new Error('invalid_map_editor_chunk_id');
  }

  const maxResponseBytes = getMapEditorMaxResponseBytes(editorPath);
  const totalBytes = toFiniteInteger(initialResult?.body_bytes, -1, {
    min: 0,
    max: maxResponseBytes
  });
  if (totalBytes < 0) {
    throw new Error('invalid_map_editor_chunk_size');
  }

  const chunkSizeBytes = toFiniteInteger(initialResult?.chunk_size_bytes, MAP_EDITOR_CHUNK_SIZE_BYTES, {
    min: 64 * 1024,
    max: 2 * 1024 * 1024
  });
  const expectedChunks = Math.ceil(totalBytes / chunkSizeBytes);
  const chunksTotal = toFiniteInteger(initialResult?.chunks_total, expectedChunks, {
    min: 1,
    max: MAP_EDITOR_MAX_CHUNKS
  });
  if (chunksTotal !== expectedChunks) {
    throw new Error('map_editor_chunk_count_mismatch');
  }

  const buffers = [];
  for (let chunkIndex = 0; chunkIndex < chunksTotal; chunkIndex += 1) {
    const chunkExecution = await executeMapEditorTool(
      vehicleId,
      'map_editor.http_chunk',
      {
        chunk_id: chunkId,
        chunk_index: chunkIndex,
        chunk_size_bytes: chunkSizeBytes,
        delete_after: chunkIndex === chunksTotal - 1
      },
      35
    );
    if (!chunkExecution.ok) {
      throw new Error(chunkExecution.detail || chunkExecution.error || 'map_editor_chunk_fetch_failed');
    }
    const chunkResult = unwrapMapEditorToolResult(chunkExecution);
    if (!chunkResult || typeof chunkResult !== 'object') {
      throw new Error('invalid_map_editor_chunk_response');
    }
    const chunkBody = chunkResult.body_base64
      ? Buffer.from(String(chunkResult.body_base64), 'base64')
      : Buffer.alloc(0);
    const expectedChunkBytes = toFiniteInteger(chunkResult.chunk_bytes, chunkBody.length, {
      min: 0,
      max: chunkSizeBytes
    });
    if (chunkBody.length !== expectedChunkBytes) {
      throw new Error('map_editor_chunk_size_mismatch');
    }
    buffers.push(chunkBody);
  }

  const bodyBuffer = Buffer.concat(buffers);
  if (bodyBuffer.length !== totalBytes) {
    throw new Error('map_editor_chunk_total_size_mismatch');
  }
  return bodyBuffer;
}

function renderCloudOpsFallbackReply(_message, execution) {
  if (!execution?.ok) {
    if (
      execution?.error === 'http_404' &&
      /is not connected/i.test(String(execution?.detail || ''))
    ) {
      const vehicleId = execution?.request?.vehicle_id || '该车辆';
      return `${vehicleId} 当前不在线，云端 Agent 现在拿不到它的实时连接状态。`;
    }
    return `我已经尝试执行云端运维查询，但接口返回失败：${execution?.detail || execution?.error || 'unknown error'}。`;
  }

  if (execution.action === 'list_vehicles') {
    const vehicles = Array.isArray(execution?.data?.vehicles) ? execution.data.vehicles : [];
    if (!vehicles.length) {
      return '当前没有在线车辆。';
    }
    return `当前在线车辆有 ${vehicles.length} 台：${vehicles
      .map((vehicle) => {
        const vehicleId = vehicle?.vehicle_id || vehicle?.plate_number || 'unknown';
        const lastSeen = vehicle?.last_seen ? `（最近在线 ${vehicle.last_seen}）` : '';
        return `${vehicleId}${lastSeen}`;
      })
      .filter(Boolean)
      .join('、')}。`;
  }

  if (execution.action === 'recent_events') {
    const events = Array.isArray(execution?.data?.events) ? execution.data.events : [];
    if (!events.length) {
      return '当前没有最近事件。';
    }
    const latest = events.slice(-3).map((event) => `${event.event || 'event'}(${event.vehicle_id || '-'})`);
    return `最近事件共有 ${events.length} 条，最新包括：${latest.join('、')}。`;
  }

  if (execution.action === 'vehicle_detail') {
    const vehicle = execution?.data?.vehicle || {};
    const heartbeat = vehicle?.heartbeat || {};
    const parts = [
      `${vehicle?.vehicle_id || vehicle?.plate_number || '该车辆'} 当前在线。`,
      vehicle?.last_seen ? `最近上报时间是 ${vehicle.last_seen}。` : '',
      Number.isFinite(heartbeat?.cpu_percent)
        ? `CPU ${heartbeat.cpu_percent}% ，内存 ${heartbeat?.memory_percent ?? '-'}% ，磁盘 ${heartbeat?.disk_percent ?? '-'}%。`
        : '',
      Number.isFinite(heartbeat?.topic_count)
        ? `ROS 话题 ${heartbeat.topic_count} 个，节点 ${heartbeat?.node_count ?? '-'} 个，服务 ${heartbeat?.service_count ?? '-'} 个。`
        : '',
      heartbeat?.master_ping_ok === true ? '主控连通正常。' : heartbeat?.master_ping_ok === false ? '主控连通异常。' : ''
    ].filter(Boolean);
    return parts.join('');
  }

  if (execution.action === 'tool_list') {
    const tools = Array.isArray(execution?.data?.response?.tools) ? execution.data.response.tools : [];
    if (!tools.length) {
      return `${execution?.request?.vehicle_id || '该车辆'} 当前没有返回可用工具列表。`;
    }
    return `${execution?.request?.vehicle_id || '该车辆'} 当前可用工具共有 ${tools.length} 个，常见包括：${tools
      .slice(0, 8)
      .map((tool) => tool?.name || '-')
      .filter(Boolean)
      .join('、')}。`;
  }

  if (execution.action === 'tool_call') {
    const toolName = execution?.request?.tool_name || execution?.data?.tool || 'tool.call';
    const result = execution?.data?.response?.result || execution?.data?.response || null;
    const listItems = pickCloudOpsList(result);
    if (toolName === 'health.snapshot' && result && typeof result === 'object') {
      const parts = [
        `${execution?.request?.vehicle_id || '该车辆'} 的健康快照已返回。`,
        Number.isFinite(result?.cpu_percent)
          ? `CPU ${result.cpu_percent}% ，内存 ${result?.memory_percent ?? '-'}% ，磁盘 ${result?.disk_percent ?? '-'}%。`
          : '',
        Number.isFinite(result?.topic_count)
          ? `ROS 话题 ${result.topic_count} 个，节点 ${result?.node_count ?? '-'} 个，服务 ${result?.service_count ?? '-'} 个。`
          : ''
      ].filter(Boolean);
      return parts.join('');
    }
    if (toolName === 'network.master_probe' && result && typeof result === 'object') {
      const masterOk = result?.master_ping_ok ?? result?.ping_ok;
      const sshOk = result?.ssh?.ok ?? result?.include_ssh_ok ?? null;
      return [
        `${execution?.request?.vehicle_id || '该车辆'} 的主控连通性结果已返回。`,
        masterOk === true ? '主控 ping 正常。' : masterOk === false ? '主控 ping 异常。' : '',
        sshOk === true ? 'SSH 正常。' : sshOk === false ? 'SSH 异常。' : ''
      ]
        .filter(Boolean)
        .join('');
    }
    if (toolName === 'network.cloud_probe' && result && typeof result === 'object') {
      const tcpOk = result?.tcp?.ok;
      const wsOk = result?.websocket_handshake?.ok;
      return [
        `${execution?.request?.vehicle_id || '该车辆'} 的云端连通性已返回。`,
        tcpOk === true ? '云端 TCP 连通正常。' : tcpOk === false ? '云端 TCP 连通异常。' : '',
        wsOk === true
          ? 'WebSocket 握手正常。'
          : wsOk === false
            ? `WebSocket 握手异常：${result?.websocket_handshake?.error || 'unknown'}。`
            : ''
      ]
        .filter(Boolean)
        .join('');
    }
    if (toolName === 'process.top' && listItems.length) {
      return `${execution?.request?.vehicle_id || '该车辆'} 的高负载进程已返回，前几项包括：${formatCloudOpsPreviewList(
        listItems,
        (item) =>
          item?.name || item?.process || item?.cmd
            ? `${item?.name || item?.process || item?.cmd}(${item?.cpu_percent ?? item?.memory_percent ?? '-'})`
            : '',
        5
      )}。`;
    }
    if (toolName === 'ros.overview' && result && typeof result === 'object') {
      return [
        `${execution?.request?.vehicle_id || '该车辆'} 的 ROS 总览已返回。`,
        Number.isFinite(result?.topic_count)
          ? `话题 ${result.topic_count} 个，节点 ${result?.node_count ?? '-'} 个，服务 ${result?.service_count ?? '-'} 个。`
          : '',
        Array.isArray(result?.categories) && result.categories.length
          ? `主要类别包括：${result.categories.slice(0, 6).join('、')}。`
          : ''
      ]
        .filter(Boolean)
        .join('');
    }
    if (toolName === 'ros.topic.list' && listItems.length) {
      return `${execution?.request?.vehicle_id || '该车辆'} 当前匹配到 ${listItems.length} 个话题，前几个是：${formatCloudOpsPreviewList(
        listItems,
        (item) => item?.topic || item?.name || '',
        6
      )}。`;
    }
    if (toolName === 'ros.node.list' && listItems.length) {
      return `${execution?.request?.vehicle_id || '该车辆'} 当前匹配到 ${listItems.length} 个 ROS 节点，前几个是：${formatCloudOpsPreviewList(
        listItems,
        (item) => item?.node || item?.name || item,
        6
      )}。`;
    }
    if (toolName === 'ros.service.list' && listItems.length) {
      return `${execution?.request?.vehicle_id || '该车辆'} 当前匹配到 ${listItems.length} 个 ROS 服务，前几个是：${formatCloudOpsPreviewList(
        listItems,
        (item) => item?.service || item?.name || item,
        6
      )}。`;
    }
    if (toolName === 'ros.topic.sample' && result && typeof result === 'object') {
      const sampledTopic = execution?.request?.args?.topic || result?.topic || result?.requested_topic || '目标话题';
      return `${execution?.request?.vehicle_id || '该车辆'} 的话题采样已返回，目标是 ${sampledTopic}。如需我继续解释字段，可以直接追问。`;
    }
    if (toolName === 'ros.topic.rate' && result && typeof result === 'object') {
      return `${execution?.request?.vehicle_id || '该车辆'} 的话题频率已返回，${
        execution?.request?.args?.topic || result?.topic || '目标话题'
      } 观测频率大约 ${result?.estimated_hz ?? '-'} Hz，消息数 ${result?.message_count ?? '-'}。`;
    }
    if (toolName === 'ros.diagnostics' && listItems.length) {
      return `${execution?.request?.vehicle_id || '该车辆'} 的诊断摘要已返回，共 ${listItems.length} 条诊断项。你可以继续让我展开异常项。`;
    }
    if (toolName === 'vehicle.snapshot' && result && typeof result === 'object') {
      const health = result?.health || {};
      const cloud = result?.cloud || {};
      const master = result?.master || {};
      const ros = result?.ros || {};
      const identity = result?.identity || {};
      return [
        `${execution?.request?.vehicle_id || '该车辆'} 的整车快照已返回。`,
        identity?.local_primary_ip || identity?.master_host
          ? `本机 ${identity?.local_primary_ip || '-'}，主控 ${identity?.master_host || '-'}。`
          : '',
        Number.isFinite(health?.cpu_percent)
          ? `整车资源 CPU ${health.cpu_percent}% / 内存 ${health?.memory_percent ?? '-'}% / 磁盘 ${health?.disk_percent ?? '-'}%。`
          : '',
        Number.isFinite(health?.topic_count) || Number.isFinite(ros?.topic_count)
          ? `ROS 规模 ${health?.topic_count ?? ros?.topic_count ?? '-'} Topic / ${
              health?.node_count ?? ros?.node_count ?? '-'
            } Node / ${health?.service_count ?? ros?.service_count ?? '-'} Service。`
          : '',
        master?.ping?.ok != null || master?.ssh?.ok != null || master?.tcp_11311?.ok != null
          ? `主控连通 Ping ${master?.ping?.ok ? '正常' : '异常'} / SSH ${
              (master?.ssh?.ok ?? master?.tcp_22?.ok) ? '正常' : '异常'
            } / ROS ${master?.tcp_11311?.ok ? '正常' : '异常'}。`
          : '',
        cloud?.tcp?.ok != null || cloud?.websocket_handshake?.ok != null
          ? `云端连通 TCP ${cloud?.tcp?.ok ? '正常' : '异常'} / WS ${
              cloud?.websocket_handshake?.ok ? '正常' : '异常'
            }。`
          : ''
      ]
        .filter(Boolean)
        .join('');
    }
    if (toolName === 'system.snapshot' && result && typeof result === 'object') {
      const cpu = result?.cpu || {};
      const memory = result?.memory || {};
      const diskRoot = result?.disk_root || {};
      return [
        `${execution?.request?.vehicle_id || '该车辆'} 的系统快照已返回。`,
        result?.hostname ? `主机 ${result.hostname}，运行时长 ${formatCloudOpsDurationBrief(result?.uptime_seconds)}。` : '',
        Number.isFinite(cpu?.percent)
          ? `CPU ${cpu.percent}% ，内存 ${memory?.percent ?? '-'}% ，磁盘 ${diskRoot?.percent ?? '-'}%。`
          : '',
        Number.isFinite(cpu?.loadavg_1m)
          ? `Load Average ${cpu.loadavg_1m}/${cpu?.loadavg_5m ?? '-'}/${cpu?.loadavg_15m ?? '-'}。`
          : '',
        Number.isFinite(memory?.used_bytes) || Number.isFinite(diskRoot?.free_bytes)
          ? `内存已用 ${formatCloudOpsHumanBytes(memory?.used_bytes)}，磁盘剩余 ${formatCloudOpsHumanBytes(
              diskRoot?.free_bytes
            )}。`
          : '',
        Array.isArray(result?.top_cpu_processes) && result.top_cpu_processes.length
          ? `高负载进程前几项包括：${result.top_cpu_processes
              .slice(0, 3)
              .map((item) => item?.name || item?.cmd || '-')
              .join('、')}。`
          : ''
      ]
        .filter(Boolean)
        .join('');
    }
    if (toolName === 'status.catalog' && result && typeof result === 'object') {
      const subsystems = Array.isArray(result?.subsystems) ? result.subsystems : [];
      return `${execution?.request?.vehicle_id || '该车辆'} 的系统能力目录已返回，共 ${
        subsystems.length
      } 个子系统，主要包括：${subsystems
        .map((item) => item?.name || item?.tool || '')
        .filter(Boolean)
        .slice(0, 8)
        .join('、')}。`;
    }
    if (toolName === 'status.key_nodes' && result && typeof result === 'object') {
      const subsystems = pickCloudOpsList(result);
      const faulted = Array.isArray(result?.faulted_subsystems) ? result.faulted_subsystems : [];
      const warnings = Array.isArray(result?.warning_subsystems) ? result.warning_subsystems : [];
      const nodeGroups = subsystems
        .map((item) => item?.nodes)
        .filter((item) => item && typeof item === 'object');
      const flatNodes = nodeGroups.flatMap((group) =>
        Array.isArray(group?.nodes) ? group.nodes : Array.isArray(group) ? group : []
      );
      const offlineNodes = flatNodes
        .filter((item) => item?.online === false || item?.ok === false)
        .map((item) => item?.node || item?.name || item?.id || '')
        .filter(Boolean);
      const subsystemNames = subsystems
        .map((item) => item?.subsystem || item?.name || item?.id || '')
        .filter(Boolean);
      return [
        `${execution?.request?.vehicle_id || '该车辆'} 的关键节点状态已返回。`,
        result?.health === 'ok'
          ? '当前关键节点整体正常。'
          : faulted.length || warnings.length || offlineNodes.length
            ? '当前关键节点存在告警或异常。'
            : '',
        faulted.length ? `故障子系统：${faulted.join('、')}。` : '',
        warnings.length ? `告警子系统：${warnings.join('、')}。` : '',
        offlineNodes.length ? `异常节点：${offlineNodes.join('、')}。` : '',
        subsystemNames.length ? `当前已上报子系统包括：${subsystemNames.slice(0, 8).join('、')}。` : ''
      ]
        .filter(Boolean)
        .join('');
    }
    if (toolName === 'status.audio' && result && typeof result === 'object') {
      const audioSummary = result?.summary || {};
      const nodeGroups = result?.nodes && typeof result.nodes === 'object' ? result.nodes : {};
      const nodes = Array.isArray(nodeGroups?.nodes) ? nodeGroups.nodes : [];
      const offlineNodes = nodes
        .filter((item) => item?.online === false || item?.ok === false)
        .map((item) => item?.node || item?.name || item?.id || '')
        .filter(Boolean);
      return [
        `${execution?.request?.vehicle_id || '该车辆'} 的音频状态已返回。`,
        result?.health === 'ok' ? '当前音频链路正常。' : result?.health ? `当前音频链路状态 ${result.health}。` : '',
        Number.isFinite(audioSummary?.sample_rate_hz) || Number.isFinite(audioSummary?.channel_count)
          ? `采样配置 ${audioSummary?.sample_rate_hz ?? '-'} Hz / ${audioSummary?.channel_count ?? '-'} 声道。`
          : '',
        offlineNodes.length ? `异常音频节点：${offlineNodes.join('、')}。` : ''
      ]
        .filter(Boolean)
        .join('');
    }
    if (toolName === 'status.audio_alsa' && result && typeof result === 'object') {
      const speaker = result?.speaker || {};
      const mic = result?.mic || result?.microphone || {};
      const speakerPercent = speaker?.percent ?? speaker?.volume_percent ?? speaker?.pcm_percent;
      const micPercent = mic?.percent ?? mic?.volume_percent ?? result?.capture?.percent;
      const issues = Array.isArray(result?.issues) ? result.issues : [];
      const selectedDevice =
        result?.selected_device ||
        result?.device ||
        result?.card?.name ||
        result?.card?.device_name ||
        result?.audio_device ||
        '';
      return [
        `${execution?.request?.vehicle_id || '该车辆'} 的 ALSA 音频设备检查已返回。`,
        result?.health === 'ok'
          ? '当前音频设备音量正常。'
          : result?.health
            ? `当前音频设备状态 ${result.health}。`
            : '',
        selectedDevice ? `命中声卡：${selectedDevice}。` : '',
        speakerPercent !== undefined ? `喇叭音量 ${speakerPercent}%。` : '',
        micPercent !== undefined ? `麦克风音量 ${micPercent}%。` : '',
        issues.length ? `异常项：${issues.join('、')}。` : ''
      ]
        .filter(Boolean)
        .join('');
    }
    if (toolName === 'health.autodrive_check' && result && typeof result === 'object') {
      const healthSummary = result?.summary || result;
      const checks = result?.checks || {};
      const lidarRefs = result?.status_refs?.lidar_topics || {};
      const frontLidar = checks?.front_laser_topic_output?.ok;
      const backLidar = checks?.back_laser_topic_output?.ok;
      const topLidar = checks?.top_lidar_topic_output?.ok;
      return [
        `${execution?.request?.vehicle_id || '该车辆'} 的一键健康检查已返回。`,
        healthSummary?.ready_to_patrol === true || healthSummary?.can_start_patrol === true
          ? '当前判断可以启航。'
          : healthSummary?.ready_to_patrol === false || healthSummary?.can_start_patrol === false
            ? '当前判断仍需排查后再启航。'
            : '',
        healthSummary?.localization_ok === false || healthSummary?.localization_reliable === false
          ? '定位可靠性存在问题。'
          : '',
        healthSummary?.routing_ok === false || healthSummary?.has_available_route === false
          ? '当前没有可用路线。'
          : '',
        frontLidar !== undefined || backLidar !== undefined || topLidar !== undefined
          ? `三路激光 topic 检查：前激光${frontLidar === true ? '正常' : frontLidar === false ? '异常' : '未知'}、后激光${
              backLidar === true ? '正常' : backLidar === false ? '异常' : '未知'
            }、顶激光${topLidar === true ? '正常' : topLidar === false ? '异常' : '未知'}。`
          : '',
        lidarRefs?.ready !== undefined
          ? `激光 topic 汇总 ${lidarRefs.ready ? '已就绪' : '未就绪'}。`
          : ''
      ]
        .filter(Boolean)
        .join('');
    }
    if (toolName === 'route.list') {
      if (!listItems.length) {
        return `${execution?.request?.vehicle_id || '该车辆'} 当前没有返回可用路线。`;
      }
      return `${execution?.request?.vehicle_id || '该车辆'} 当前共有 ${listItems.length} 条路线，前几个是：${formatCloudOpsPreviewList(
        listItems,
        (item) => item?.name || item?.route_id || '',
        6
      )}。`;
    }
    if (toolName === 'status.routing' && result && typeof result === 'object') {
      return `${execution?.request?.vehicle_id || '该车辆'} 的 routing 状态已返回。当前路线 ${
        result?.current_route_id || result?.active_route_id || '未指定'
      }，可用路线 ${result?.available_route_count ?? result?.route_count ?? listItems.length ?? 0} 条。`;
    }
    if (toolName === 'route.detail' && result && typeof result === 'object') {
      return `${execution?.request?.vehicle_id || '该车辆'} 的路线详情已返回，路线 ${
        result?.name || execution?.request?.args?.route_id || '-'
      } 长度 ${result?.len ?? result?.length ?? '-'}，时长 ${result?.duration ?? '-'}。`;
    }
    if (toolName === 'route.start_patrol') {
      return `${execution?.request?.vehicle_id || '该车辆'} 的巡逻启动请求已返回，路线 ${
        execution?.request?.args?.route_id || '-'
      }，圈数 ${execution?.request?.args?.loops ?? '-'}，速度 ${execution?.request?.args?.speed_kph ?? '-'} km/h，${
        execution?.request?.args?.dry_run ? '当前是 dry-run 预演。' : '当前为正式执行。'
      }`;
    }
    if (toolName === 'route.stop_patrol') {
      return `${execution?.request?.vehicle_id || '该车辆'} 的停止巡逻请求已返回。`;
    }
    if (toolName === 'camera.capture' && result && typeof result === 'object') {
      const captureItems = pickCloudOpsList(result);
      return `${execution?.request?.vehicle_id || '该车辆'} 的相机抓拍已返回，共 ${
        captureItems.length || result?.capture_count || 0
      } 张图像。`;
    }
    if (toolName === 'map.preview' && result && typeof result === 'object') {
      const mapInfo = result?.map || {};
      const pose = result?.vehicle_pose || {};
      return [
        `${execution?.request?.vehicle_id || '该车辆'} 的地图预览已返回。`,
        mapInfo?.path ? `地图文件 ${mapInfo.path}。` : '',
        Number.isFinite(mapInfo?.extent?.width_m) && Number.isFinite(mapInfo?.extent?.height_m)
          ? `范围约 ${mapInfo.extent.width_m}m × ${mapInfo.extent.height_m}m。`
          : '',
        pose?.source ? `定位来源 ${pose.source}。` : '',
        pose?.draw_vehicle === true ? '已叠加自车位置与朝向。' : '',
        pose?.reliable === false ? '当前定位可靠性不足。' : pose?.reliable === true ? '当前定位可靠。' : ''
      ]
        .filter(Boolean)
        .join('');
    }
    if (toolName === 'camera.upload_chain' && result && typeof result === 'object') {
      return `${execution?.request?.vehicle_id || '该车辆'} 的相机上传链路已返回。整体状态 ${
        result?.health || result?.status || '未知'
      }，可以继续追问是驱动异常还是上传异常。`;
    }
    if (toolName === 'status.can' && result && typeof result === 'object') {
      const canSummary = result?.summary || {};
      return [
        `${execution?.request?.vehicle_id || '该车辆'} 的底盘/CAN 状态已返回。`,
        canSummary?.battery_soc != null ? `电量 ${canSummary.battery_soc}% 。` : '',
        canSummary?.speed != null ? `当前速度 ${canSummary.speed} m/s。` : '',
        canSummary?.emergency_stop_pressed != null
          ? `急停 ${canSummary.emergency_stop_pressed ? '触发' : '正常'}。`
          : '',
        canSummary?.collision_stop != null
          ? `碰撞停 ${canSummary.collision_stop ? '触发' : '正常'}。`
          : ''
      ]
        .filter(Boolean)
        .join('');
    }
    if (toolName === 'status.body_control' && result && typeof result === 'object') {
      const summary = result?.summary || {};
      const planningIntent = summary?.planning_intent || {};
      const controlCommand = summary?.control_command || {};
      const vehicleFeedback = summary?.vehicle_feedback || {};
      return [
        `${execution?.request?.vehicle_id || '该车辆'} 的车身控制状态已返回。`,
        `广告屏 规划${planningIntent?.ad_screen ? '开' : '关'} / 指令${controlCommand?.ad_screen ? '开' : '关'} / 反馈${vehicleFeedback?.ad_screen_on ? '开' : '关'}。`,
        `前照灯 规划${planningIntent?.front_lamp ? '开' : '关'} / 指令${controlCommand?.front_lamp ? '开' : '关'} / 反馈${vehicleFeedback?.front_lamp_on ? '开' : '关'}。`,
        `氛围灯 规划${planningIntent?.mood_lamp ? '开' : '关'} / 指令${controlCommand?.mood_lamp ? '开' : '关'} / 反馈${vehicleFeedback?.mood_lamp_on ? '开' : '关'}。`,
        `转向灯当前为 ${vehicleFeedback?.steer_lamp_mode || controlCommand?.steer_lamp_mode || 'off'}。`
      ]
        .filter(Boolean)
        .join('');
    }
    if (toolName === 'vehicle.body_control' && result && typeof result === 'object') {
      const status = String(result?.status || '').trim().toLowerCase();
      const request = result?.request || {};
      const afterSummary = result?.after?.summary || {};
      const vehicleFeedback = afterSummary?.vehicle_feedback || {};
      const requested = [
        request?.ad_screen !== null && request?.ad_screen !== undefined
          ? `广告屏${request.ad_screen ? '开' : '关'}`
          : '',
        request?.front_lamp !== null && request?.front_lamp !== undefined
          ? `前照灯${request.front_lamp ? '开' : '关'}`
          : '',
        request?.mood_lamp !== null && request?.mood_lamp !== undefined
          ? `氛围灯${request.mood_lamp ? '开' : '关'}`
          : '',
        request?.steer_lamp_mode || request?.steer_lamp
          ? `转向灯${request?.steer_lamp_mode || request?.steer_lamp}`
          : ''
      ].filter(Boolean);
      return [
        `${execution?.request?.vehicle_id || '该车辆'} 的车身控制结果已返回。`,
        status === 'applied'
          ? '车身控制已真正执行成功。'
          : status === 'partial'
            ? '控制指令已送达，但车端只完成了部分确认。'
          : status === 'noop'
            ? '请求已送达，但车身状态未变化。'
            : status === 'error'
              ? '车身控制执行失败。'
              : '',
        requested.length ? `本次请求是：${requested.join('、')}。` : '',
        `当前反馈：广告屏${vehicleFeedback?.ad_screen_on ? '开' : '关'}、前照灯${
          vehicleFeedback?.front_lamp_on ? '开' : '关'
        }、氛围灯${vehicleFeedback?.mood_lamp_on ? '开' : '关'}、转向灯${
          vehicleFeedback?.steer_lamp_mode || 'off'
        }。`,
        result?.message ? `接口说明：${result.message}` : ''
      ]
        .filter(Boolean)
        .join('');
    }
    if (toolName === 'vehicle.clear_collision_stop' && result && typeof result === 'object') {
      const status = String(result?.status || '').trim().toLowerCase();
      const detail = result?.message || result?.detail || '';
      return [
        `${execution?.request?.vehicle_id || '该车辆'} 的碰撞停复位结果已返回。`,
        status === 'cleared'
          ? '当前碰撞停已经清除，车端已按安全序列先停巡逻、复位后再次补发 STOP 并完成复核。'
          : status === 'noop'
            ? '当前碰撞停原本就没有触发，因此没有执行实际复位。'
            : status === 'error'
              ? '碰撞停复位未通过安全校验。'
              : '',
        detail ? `接口说明：${detail}` : ''
      ]
        .filter(Boolean)
        .join('');
    }
    if (toolName === 'status.camera' && result && typeof result === 'object') {
      return `${execution?.request?.vehicle_id || '该车辆'} 的相机状态已返回。当前在线 ${
        result?.online_camera_count ?? 0
      } / ${result?.expected_camera_count ?? listItems.length} 路，${
        Array.isArray(result?.offline_cameras) && result.offline_cameras.length
          ? `离线相机有 ${result.offline_cameras.join('、')}。`
          : '当前没有离线相机。'
      }`;
    }
    if (toolName === 'ai_detection.config' && result && typeof result === 'object') {
      const openEvents = Array.isArray(result?.events_open) ? result.events_open : [];
      const closedEvents = Array.isArray(result?.events_closed) ? result.events_closed : [];
      return [
        `${execution?.request?.vehicle_id || '该车辆'} 的 AI 检测配置已返回。`,
        result?.service_position ? `当前服务位置：${result.service_position}。` : '',
        result?.interval_s != null ? `检测间隔 ${result.interval_s} 秒。` : '',
        openEvents.length ? `已启用 ${openEvents.length} 类事件：${openEvents.slice(0, 8).join('、')}。` : '',
        closedEvents.length ? `关闭事件：${closedEvents.join('、')}。` : '',
        result?.qwen?.enabled != null ? `Qwen校验：${result.qwen.enabled ? '开启' : '关闭'}。` : ''
      ]
        .filter(Boolean)
        .join('');
    }
    if (toolName === 'ai_detection.images' && result && typeof result === 'object') {
      const images = Array.isArray(result?.images) ? result.images : [];
      return [
        `${execution?.request?.vehicle_id || '该车辆'} 的 AI 检测落盘图片已返回。`,
        `当前目录共有 ${result?.total_files ?? images.length ?? 0} 张。`,
        images.length ? `本次返回 ${images.length} 张，页面可直接查看。` : '当前目录暂无落盘图片。',
        result?.save_path ? `目录：${result.save_path}。` : ''
      ]
        .filter(Boolean)
        .join('');
    }
    if (toolName === 'status.localization' && result && typeof result === 'object') {
      const localizationSummary = result?.summary || {};
      return [
        `${execution?.request?.vehicle_id || '该车辆'} 的定位状态已返回。`,
        localizationSummary?.reliable === true
          ? '当前定位可靠。'
          : localizationSummary?.reliable === false
            ? '当前定位不可靠。'
            : '',
        localizationSummary?.speed_mps != null
          ? `当前速度 ${localizationSummary.speed_mps} m/s。`
          : '',
        localizationSummary?.latitude != null && localizationSummary?.longitude != null
          ? `经纬度 ${localizationSummary.latitude}, ${localizationSummary.longitude}。`
          : ''
      ]
        .filter(Boolean)
        .join('');
    }
    if (toolName === 'status.planning' && result && typeof result === 'object') {
      const planningSummary = result?.summary || {};
      return [
        `${execution?.request?.vehicle_id || '该车辆'} 的规划状态已返回。`,
        planningSummary?.planner_state ? `规划状态 ${planningSummary.planner_state}。` : '',
        planningSummary?.current_scenario != null ? `当前场景 ${planningSummary.current_scenario}。` : '',
        planningSummary?.current_action != null ? `当前动作 ${planningSummary.current_action}。` : '',
        planningSummary?.trajectory_point_count != null
          ? `轨迹点数 ${planningSummary.trajectory_point_count}。`
          : '',
        planningSummary?.trajectory_estop != null
          ? `轨迹 estop=${planningSummary.trajectory_estop}。`
          : ''
      ]
        .filter(Boolean)
        .join('');
    }
    if (toolName === 'status.control' && result && typeof result === 'object') {
      const controlSummary = result?.summary || {};
      const requiredInputs = controlSummary?.required_inputs || {};
      const missingInputs = Object.keys(requiredInputs).filter((key) => requiredInputs[key] === false);
      return `${execution?.request?.vehicle_id || '该车辆'} 的控制链路状态已返回。${
        missingInputs.length ? `缺少输入 ${missingInputs.join('、')}。` : '控制输入齐全。'
      }目标速度 ${controlSummary?.target_speed ?? '-'} m/s，档位 ${controlSummary?.gear_cmd ?? '-'}。`;
    }
    if (toolName === 'status.obstacle_processor' && result && typeof result === 'object') {
      const obstacleSummary = result?.summary || result;
      return `${execution?.request?.vehicle_id || '该车辆'} 的障碍处理状态已返回。融合目标 ${
        obstacleSummary?.fusion_object_count ?? obstacleSummary?.object_count ?? 0
      } 个，链路状态 ${obstacleSummary?.health || obstacleSummary?.status || '未知'}。`;
    }
    if (toolName === 'obstacle.preview' && result && typeof result === 'object') {
      const summary = result?.summary || {};
      const preview = result?.preview || {};
      return [
        `${execution?.request?.vehicle_id || '该车辆'} 的障碍俯视图已返回。`,
        summary?.object_count != null ? `障碍物 ${summary.object_count} 个。` : '',
        summary?.drawn_obstacle_count != null ? `已绘制 ${summary.drawn_obstacle_count} 个 box。` : '',
        summary?.frame_id ? `坐标系 ${summary.frame_id}。` : '',
        summary?.topic ? `来源话题 ${summary.topic}。` : '',
        preview?.data_base64 ? '页面可直接查看俯视图。' : ''
      ]
        .filter(Boolean)
        .join('');
    }
    if (toolName === 'status.perception' && result && typeof result === 'object') {
      const perceptionSummary = result?.summary || {};
      return `${execution?.request?.vehicle_id || '该车辆'} 的感知链路状态已返回。融合目标 ${
        perceptionSummary?.fusion_object_count ?? 0
      } 个，人群 ${
        perceptionSummary?.crowd_people ?? 0
      } 个，挥手目标 ${perceptionSummary?.handwave_object_count ?? 0} 个。`;
    }
    return `我已经执行了工具 ${toolName}，接口已返回结果。你可以继续让我解释其中的关键字段。`;
  }

  if (execution.action === 'snapshot_request') {
    return `${execution?.request?.vehicle_id || '该车辆'} 的即时快照请求已经发出，并且接口已返回结果。`;
  }

  return `我已经执行了运维动作 ${execution.action}，可以继续追问更具体的车辆状态、工具结果或最近事件。`;
}

function buildCloudOpsModelPayload(execution) {
  if (!execution?.ok) {
    return execution;
  }

  const data = execution.data || {};

  if (execution.action === 'list_vehicles') {
    const vehicles = Array.isArray(data.vehicles) ? data.vehicles : [];
    return {
      action: execution.action,
      vehicles: vehicles.map((vehicle) => ({
        vehicle_id: vehicle?.vehicle_id || null,
        plate_number: vehicle?.plate_number || null,
        vin: vehicle?.vin || null,
        connected_at: vehicle?.connected_at || null,
        last_seen: vehicle?.last_seen || null,
        tool_count: vehicle?.tool_count ?? null,
        has_heartbeat: vehicle?.has_heartbeat ?? null,
        has_snapshot: vehicle?.has_snapshot ?? null
      })),
      ts: data.ts || null
    };
  }

  if (execution.action === 'recent_events') {
    const events = Array.isArray(data.events) ? data.events : [];
    return {
      action: execution.action,
      events: events.slice(-20).map((event) => ({
        event: event?.event || null,
        ts: event?.ts || null,
        vehicle_id: event?.vehicle_id || null,
        session_id: event?.session_id || null,
        message_type: event?.message_type || null,
        request_id: event?.request_id || null
      }))
    };
  }

  if (execution.action === 'vehicle_detail') {
    const vehicle = data.vehicle || {};
    return {
      action: execution.action,
      vehicle: {
        vehicle_id: vehicle?.vehicle_id || null,
        plate_number: vehicle?.plate_number || null,
        vin: vehicle?.vin || null,
        role: vehicle?.role || null,
        connected_at: vehicle?.connected_at || null,
        last_seen: vehicle?.last_seen || null,
        tool_count: vehicle?.tool_count ?? null,
        last_error: vehicle?.last_error || null,
        heartbeat: vehicle?.heartbeat || null,
        snapshot: vehicle?.snapshot || null
      }
    };
  }

  if (execution.action === 'tool_list') {
    const tools = Array.isArray(data?.response?.tools) ? data.response.tools : [];
    return {
      action: execution.action,
      tools: tools.map((tool) => ({
        name: tool?.name || null,
        description: tool?.description || null,
        args_schema: tool?.args_schema || null
      })),
      ts: data.ts || null
    };
  }

  if (execution.action === 'snapshot_request') {
    return {
      action: execution.action,
      response: data?.response || null,
      ts: data?.ts || null
    };
  }

  if (execution.action === 'tool_call') {
    return {
      action: execution.action,
      tool: data?.tool || execution?.request?.tool_name || null,
      response: data?.response || null,
      ts: data?.ts || null
    };
  }

  return execution;
}

async function summarizeCloudOpsResult(message, execution, sessionId) {
  const modelPayload = buildCloudOpsModelPayload(execution);
  const summaryPrompt = [
    '你是云端智能运维助手。',
    '请基于下面的云控接口执行结果，直接用中文回答用户。',
    '不要编造接口里没有的信息。',
    '如果接口失败，明确告诉用户失败原因。',
    '如果是车辆列表，优先给出在线车辆数量和 vehicle_id。',
    '如果是单车详情或工具结果，优先提炼状态、时间、关键字段和异常点。',
    '回答尽量简洁，2 到 6 句即可。',
    `用户原始请求：${message}`,
    `执行结果：${safeJsonStringify(modelPayload, 8000)}`
  ].join('\n');

  try {
    return await runOpenClawTurn(
      summaryPrompt,
      `${sessionId}-${cloudAgentAnswerSessionSuffix}`
    );
  } catch (_error) {
    return {
      reply: renderCloudOpsFallbackReply(message, execution),
      latency_ms: null,
      provider: 'cloud-agent-fallback',
      model: null
    };
  }
}

async function runOpenClawOpsTurn(message, sessionId, options = {}) {
  const startedAt = Date.now();
  const rawMessage = normalizeReply(message);
  const selectedVehicleId = normalizeReply(options?.vehicle_id || '');
  const authUser = options?.auth_user || null;
  const contextItems = normalizeOpenClawContextItems(options?.context_items);
  const effectiveMessage = buildOpenClawContextMessage(rawMessage, {
    vehicle_id: selectedVehicleId,
    context_items: contextItems
  });
  const cloudAgentHealth = await probeCloudAgent();

  if (!cloudAgentHealth.ok) {
    const baseResult = await runOpenClawTurn(effectiveMessage, sessionId);
    return {
      ...baseResult,
      cloud_ops: {
        enabled: false,
        base_url: cloudAgentBaseUrl,
        detail: cloudAgentHealth.detail || 'cloud_agent_unavailable'
      }
    };
  }

  const vehicles = await listCloudAgentVehicles().catch(() => []);
  const plan = await planCloudOpsAction(rawMessage, sessionId, vehicles, {
    selectedVehicleId,
    contextItems
  });

  if (!plan || plan.action === 'none') {
    const baseResult = await runOpenClawTurn(effectiveMessage, sessionId);
    return {
      ...baseResult,
      cloud_ops: {
        enabled: true,
        used: false,
        plan
      }
    };
  }

  if (!plan.vehicle_id && selectedVehicleId) {
    plan.vehicle_id = selectedVehicleId;
  }

  if (!plan.vehicle_id && vehicles.length === 1) {
    plan.vehicle_id = String(vehicles[0]?.vehicle_id || vehicles[0]?.plate_number || '').trim();
  }

  const requiredPermission = cloudOpsPermissionForPlan(plan);
  if (authUser && !authStore.hasPermission(authUser, requiredPermission)) {
    return {
      reply: `当前账号可以查看车辆状态，但没有执行该运维动作所需的 ${requiredPermission} 权限。`,
      latency_ms: Date.now() - startedAt,
      provider: 'openclaw-cloud-ops',
      model: null,
      cloud_ops: {
        enabled: true,
        used: false,
        denied: true,
        required_permission: requiredPermission,
        plan
      }
    };
  }

  const execution = await executeCloudOpsAction(plan, vehicles);
  const summary = await summarizeCloudOpsResult(rawMessage, execution, sessionId);

  return {
    reply: summary.reply,
    latency_ms: Date.now() - startedAt,
    provider: 'openclaw-cloud-ops',
    model: summary.model || null,
    cloud_ops: {
      enabled: true,
      used: true,
      plan,
      execution
    }
  };
}

async function readOpenClawConfig() {
  const content = await fs.readFile(openClawConfigPath, 'utf-8');
  return JSON.parse(content);
}

function normalizeOpenClawSessionSegment(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function buildOpenClawSessionKey(sessionId) {
  const agentId = normalizeOpenClawSessionSegment(openClawAgentId) || 'main';
  const key = normalizeOpenClawSessionSegment(sessionId) || 'main';
  return `agent:${agentId}:${key}`;
}

function extractOpenClawReply(message) {
  if (!message || typeof message !== 'object') {
    return '';
  }

  if (typeof message.text === 'string') {
    return normalizeReply(message.text);
  }

  const blocks = Array.isArray(message.content) ? message.content : [];
  return normalizeReply(
    blocks
      .map((item) => (typeof item?.text === 'string' ? item.text : ''))
      .filter(Boolean)
      .join('\n\n')
  );
}

let openClawGatewaySdkPromise = null;

async function loadOpenClawGatewaySdk() {
  if (!openClawGatewaySdkPromise) {
    openClawGatewaySdkPromise = import(openClawGatewaySdkUrl);
  }
  return openClawGatewaySdkPromise;
}

function createOpenClawGatewayUrl(config) {
  const port = Number(config?.gateway?.port || 18789);
  return `ws://${openClawGatewayHost}:${port}`;
}

function getOpenClawGatewayToken(config) {
  const token = config?.gateway?.auth?.token;
  return typeof token === 'string' && token.trim() ? token.trim() : null;
}

async function connectOpenClawGateway(config, handlers = {}) {
  const token = getOpenClawGatewayToken(config);
  if (!token) {
    throw new Error('openclaw_gateway_token_missing');
  }

  const { u: GatewayClient, r: defaultScopes } = await loadOpenClawGatewaySdk();

  return await new Promise((resolve, reject) => {
    let settled = false;
    let client = null;
    let timeoutId = null;

    const cleanup = async () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      try {
        await client?.stopAndWait?.({ timeoutMs: 5000 });
      } catch (_error) {
        // Ignore close errors from a half-open socket.
      }
    };

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      void cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    client = new GatewayClient({
      url: createOpenClawGatewayUrl(config),
      token,
      clientVersion: 'jgzj/0.1.0',
      mode: 'backend',
      scopes: defaultScopes,
      onHelloOk: () => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        resolve(client);
      },
      onConnectError: fail,
      onClose: (code, reason) => {
        if (!settled) {
          fail(new Error(`openclaw_gateway_closed_${code}:${reason || 'no_reason'}`));
        }
        handlers.onClose?.(code, reason, client);
      },
      onEvent: (event) => {
        handlers.onEvent?.(event, client);
      }
    });

    timeoutId = setTimeout(() => {
      fail(new Error('openclaw_connect_timeout'));
    }, openClawConnectTimeoutMs);
    timeoutId.unref?.();

    client.start();
  });
}

async function probeOpenClaw() {
  try {
    const config = await readOpenClawConfig();
    const client = await connectOpenClawGateway(config);
    const healthResult = await client.request('health', {}, { timeoutMs: 5000 });
    await client.stopAndWait({ timeoutMs: 5000 }).catch(() => {});

    return {
      ok: true,
      detail: healthResult?.ok ? `Gateway Health\nOK (${healthResult.durationMs ?? 0}ms)` : 'Gateway Health\nUnavailable',
      model: config?.agents?.defaults?.model?.primary || null,
      gateway_port: config?.gateway?.port || null,
      auth_mode: config?.gateway?.auth?.mode || null
    };
  } catch (error) {
    return {
      ok: false,
      detail: error.message,
      model: null,
      gateway_port: null,
      auth_mode: null
    };
  }
}

async function runOpenClawTurn(message, sessionId) {
  const config = await readOpenClawConfig();
  const runId = crypto.randomUUID();
  const sessionKey = buildOpenClawSessionKey(sessionId);
  const startedAt = Date.now();
  let client = null;

  return await new Promise(async (resolve, reject) => {
    let finished = false;
    let timeoutId = null;

    const finish = async (error, result) => {
      if (finished) {
        return;
      }
      finished = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      try {
        await client?.stopAndWait?.({ timeoutMs: 5000 });
      } catch (_closeError) {
        // Ignore close failures.
      }

      if (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      resolve(result);
    };

    try {
      client = await connectOpenClawGateway(config, {
        onEvent: (event) => {
          if (event?.event !== 'chat') {
            return;
          }

          const payload = event.payload || {};
          if (payload.runId !== runId) {
            return;
          }

          if (payload.state === 'error') {
            void finish(new Error(payload.errorMessage || 'openclaw_chat_error'));
            return;
          }

          if (payload.state !== 'final' && payload.state !== 'aborted') {
            return;
          }

          const reply = extractOpenClawReply(payload.message);
          if (!reply) {
            void finish(new Error('openclaw_reply_empty'));
            return;
          }

          void finish(null, {
            reply,
            latency_ms: Date.now() - startedAt,
            provider: 'openclaw-gateway',
            model: config?.agents?.defaults?.model?.primary || null
          });
        }
      });

      timeoutId = setTimeout(() => {
        void finish(new Error('openclaw_timeout'));
      }, openClawTimeoutMs);
      timeoutId.unref?.();

      const sendResult = await client.request(
        'chat.send',
        {
          sessionKey,
          message,
          deliver: false,
          idempotencyKey: runId
        },
        { timeoutMs: 10000 }
      );

      if (sendResult?.status && sendResult.status !== 'started') {
        void finish(new Error(`openclaw_send_${sendResult.status}`));
      }
    } catch (error) {
      void finish(error);
    }
  });
}

function normalizeOpenClawContextItems(rawItems) {
  if (!Array.isArray(rawItems)) {
    return [];
  }

  return rawItems
    .slice(-6)
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }

      const label = normalizeReply(item.label || '');
      const summary = normalizeReply(item.summary || '');
      const vehicleId = normalizeReply(item.vehicle_id || '');
      const payload = item.payload && typeof item.payload === 'object' ? item.payload : null;

      if (!label && !summary && !vehicleId && !payload) {
        return null;
      }

      return {
        label: label || null,
        summary: summary || null,
        vehicle_id: vehicleId || null,
        payload
      };
    })
    .filter(Boolean);
}

function buildOpenClawContextMessage(message, options = {}) {
  const cleanedMessage = normalizeReply(message);
  const vehicleId = normalizeReply(options.vehicle_id || '');
  const contextItems = normalizeOpenClawContextItems(options.context_items);

  if (!vehicleId && !contextItems.length) {
    return cleanedMessage;
  }

  const blocks = [
    '下面是当前云端运维会话里，用户已经插入的快捷查询上下文。',
    '如果用户当前问题和这些上下文相关，请优先结合这些结果回答，不要忽略。'
  ];

  if (vehicleId) {
    blocks.push(`当前选中车辆：${vehicleId}`);
  }

  contextItems.forEach((item, index) => {
    const chunk = [`上下文 ${index + 1}`];
    if (item.label) {
      chunk.push(`标题：${item.label}`);
    }
    if (item.vehicle_id) {
      chunk.push(`车辆：${item.vehicle_id}`);
    }
    if (item.summary) {
      chunk.push(`摘要：${item.summary}`);
    }
    if (item.payload) {
      chunk.push(`原始结果：${safeJsonStringify(item.payload, 2400)}`);
    }
    blocks.push(chunk.join('\n'));
  });

  blocks.push(`用户问题：${cleanedMessage}`);
  return blocks.join('\n\n');
}

function requestMeta(req) {
  return {
    ip: req.ip || req.socket?.remoteAddress || '',
    user_agent: req.get('user-agent') || ''
  };
}

function authUserResponse(auth) {
  return {
    ok: true,
    authenticated: Boolean(auth?.user),
    username: auth?.user?.username || null,
    user: auth?.user || null,
    permissions: auth?.user?.effective_permissions || []
  };
}

function publicSiteBaseUrl(req) {
  const configured = String(process.env.JGZJ_PUBLIC_SITE_URL || '').trim();
  if (configured) {
    return configured.replace(/\/+$/, '');
  }
  const host = req.get('x-forwarded-host') || req.get('host') || `127.0.0.1:${port}`;
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  return `${proto}://${host}`.replace(/\/+$/, '');
}

function emailVerificationUrl(req, token) {
  const url = new URL('/api/auth/verify-email', publicSiteBaseUrl(req));
  url.searchParams.set('token', token);
  return url.toString();
}

async function sendEmailVerification(req, issue) {
  const verificationUrl = emailVerificationUrl(req, issue.token);
  const delivery = await mailer.sendVerificationEmail({
    to: issue.email,
    username: issue.user.username,
    verificationUrl,
    expiresAtMs: issue.expires_at_ms
  });
  return {
    ...delivery,
    debug_verification_url:
      String(process.env.JGZJ_EMAIL_DEBUG_RESPONSE || '').toLowerCase() === 'true'
        ? verificationUrl
        : undefined
  };
}

function renderEmailVerificationPage({ ok, title, detail }) {
  const tone = ok ? '#16a34a' : '#dc2626';
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #020617; color: #e2e8f0; }
      main { width: min(560px, calc(100vw - 32px)); border: 1px solid rgba(148, 163, 184, .28); border-radius: 18px; background: rgba(15, 23, 42, .92); padding: 28px; box-shadow: 0 24px 70px rgba(0,0,0,.35); }
      h1 { margin: 0 0 12px; color: ${tone}; font-size: 1.6rem; }
      p { margin: 0 0 18px; line-height: 1.75; color: #cbd5e1; }
      a { display: inline-flex; min-height: 40px; align-items: center; border-radius: 10px; padding: 0 14px; color: #082f49; background: #67e8f9; font-weight: 800; text-decoration: none; }
    </style>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <p>${detail}</p>
      <a href="/">返回网站</a>
    </main>
  </body>
</html>`;
}

function cloudOpsPermissionForTool(toolName) {
  const name = String(toolName || '').trim();
  if (!name) {
    return 'vehicle:read';
  }
  if (name.startsWith('deploy.')) {
    return ['deploy.git_update', 'deploy.build', 'deploy.update_and_build', 'deploy.cancel'].includes(name)
      ? 'vehicle:code:write'
      : 'vehicle:code:read';
  }
  if (
    name.startsWith('map_editor.') ||
    name.startsWith('route.edit') ||
    name.startsWith('route.create') ||
    name.startsWith('route.delete')
  ) {
    return 'vehicle:path:write';
  }
  if (
    name === 'route.start_patrol' ||
    name === 'route.stop_patrol' ||
    name === 'vehicle.body_control' ||
    name === 'vehicle.clear_collision_stop' ||
    name === 'controller.reboot_master' ||
    name === 'controller.reboot_media' ||
    name.startsWith('audio.uplink.')
  ) {
    return 'vehicle:control';
  }
  if (name === 'ai_detection.images') {
    return 'ai:history:read';
  }
  return 'vehicle:read';
}

function cloudOpsPermissionForPlan(plan) {
  const action = String(plan?.action || '').trim();
  if (action === 'tool_call') {
    return cloudOpsPermissionForTool(plan?.tool_name);
  }
  return 'vehicle:read';
}

function auditBodySummary(req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const requestPath = req.path || '';

  if (requestPath === '/api/qwen36-mm-check') {
    const image = body.image && typeof body.image === 'object' ? body.image : {};
    return {
      event_name: String(body.event_name || '').trim(),
      prompt_text: String(body.prompt_text || '').trim().slice(0, 500),
      image_mime_type: image.mime_type || null,
      image_size_bytes: image.data_base64 ? Buffer.byteLength(String(image.data_base64), 'base64') : null
    };
  }

  if (requestPath === '/api/yolo-model-test') {
    const image = body.image && typeof body.image === 'object' ? body.image : {};
    return {
      task_id: String(body.task_id || '').trim(),
      image_mime_type: image.mime_type || null,
      image_size_bytes: image.data_base64 ? Buffer.byteLength(String(image.data_base64), 'base64') : null
    };
  }

  if (requestPath === '/api/qwen36-chat' || requestPath === '/api/cloud-chat' || requestPath === '/api/openclaw-chat') {
    return {
      message: String(body.message || '').trim().slice(0, 800),
      session_id: String(body.session_id || '').trim(),
      vehicle_id: String(body.vehicle_id || '').trim(),
      context_count: Array.isArray(body.context_items) ? body.context_items.length : undefined
    };
  }

  if (requestPath === '/api/auth/login') {
    return {
      username: String(body.username || '').trim()
    };
  }

  if (requestPath === '/api/auth/register') {
    return {
      username: String(body.username || '').trim(),
      email: String(body.email || '').trim()
    };
  }

  if (requestPath.startsWith('/api/cloud-ops/')) {
    return sanitizeCloudOpsPayload(body);
  }

  return sanitizeCloudOpsPayload(body);
}

function classifyOperationAuditRequest(req) {
  const method = String(req.method || '').toUpperCase();
  const requestPath = req.path || '';

  if (requestPath.startsWith('/api/operation-audit')) {
    return null;
  }
  if (requestPath.startsWith('/api/auth/')) {
    return null;
  }

  if (requestPath === '/api/cloud-ops/execute' && method === 'POST') {
    const plan = validateCloudOpsPlan(req.body) || {};
    const toolName = String(plan.tool_name || '').trim();
    return {
      category: 'cloud_ops',
      action: toolName ? `cloud_ops.tool_call.${toolName}` : `cloud_ops.${plan.action || 'execute'}`,
      target_type: toolName ? 'vehicle_tool' : 'vehicle',
      target_id: toolName || plan.action || null,
      vehicle_id: String(plan.vehicle_id || '').trim(),
      permission: cloudOpsPermissionForPlan(plan),
      detail: {
        plan: auditBodySummary(req)
      }
    };
  }

  const deployMatch = requestPath.match(/^\/api\/cloud-ops\/deploy\/([^/]+)$/);
  if (deployMatch && method === 'POST') {
    return {
      category: 'cloud_ops',
      action: `cloud_ops.deploy.${deployMatch[1]}`,
      target_type: 'deploy',
      target_id: String(req.body?.repo || req.body?.controller || deployMatch[1] || '').trim(),
      vehicle_id: String(req.body?.vehicle_id || '').trim(),
      permission: requestPath.endsWith('/build') || requestPath.endsWith('/git-update') ? 'vehicle:code:write' : 'vehicle:code:read',
      detail: auditBodySummary(req)
    };
  }

  if (requestPath === '/api/cloud-ops/runtime/restart' && method === 'POST') {
    return {
      category: 'runtime',
      action: 'runtime.restart',
      target_type: 'runtime_target',
      target_id: String(req.body?.target_id || '').trim(),
      permission: 'runtime:restart',
      detail: auditBodySummary(req)
    };
  }

  const mapApiMatch = requestPath.match(/^\/api\/map-editor\/([^/]+)\/(start|stop|status)$/);
  if (mapApiMatch && (method === 'POST' || method === 'GET')) {
    return {
      category: 'map_editor',
      action: `map_editor.${mapApiMatch[2]}`,
      target_type: 'vehicle',
      target_id: mapApiMatch[1],
      vehicle_id: mapApiMatch[1],
      permission: 'vehicle:path:write',
      detail: auditBodySummary(req)
    };
  }

  const mapProxyMatch = requestPath.match(/^\/vehicles\/([^/]+)\/map-editor(?:\/.*)?$/);
  if (mapProxyMatch && method === 'POST') {
    return {
      category: 'map_editor',
      action: 'map_editor.proxy.post',
      target_type: 'vehicle',
      target_id: mapProxyMatch[1],
      vehicle_id: mapProxyMatch[1],
      permission: 'vehicle:path:write',
      detail: {
        editor_path: req.path.replace(`/vehicles/${mapProxyMatch[1]}/map-editor`, '') || '/',
        body: auditBodySummary(req)
      }
    };
  }

  if (requestPath === '/api/openclaw-chat' && method === 'POST') {
    return {
      category: 'cloud_ops',
      action: 'cloud_ops.openclaw_chat',
      target_type: 'vehicle',
      target_id: String(req.body?.vehicle_id || '').trim(),
      vehicle_id: String(req.body?.vehicle_id || '').trim(),
      permission: 'vehicle:read',
      detail: auditBodySummary(req)
    };
  }

  if (requestPath === '/api/cloud-chat' && method === 'POST') {
    return {
      category: 'ai',
      action: 'ai.cloud_chat',
      target_type: 'vehicle',
      target_id: String(req.body?.vehicle_id || '').trim(),
      vehicle_id: String(req.body?.vehicle_id || '').trim(),
      permission: 'ai:chat',
      detail: auditBodySummary(req)
    };
  }

  if (requestPath === '/api/qwen36-chat' && method === 'POST') {
    return {
      category: 'ai',
      action: 'ai.qwen36_chat',
      target_type: 'model',
      target_id: qwen36Model,
      permission: 'ai:chat',
      detail: auditBodySummary(req)
    };
  }

  if (requestPath === '/api/qwen36-mm-check' && method === 'POST') {
    return {
      category: 'ai',
      action: 'ai.qwen36_mm_check',
      target_type: 'model',
      target_id: qwen36MmModel,
      permission: 'ai:detect',
      detail: auditBodySummary(req)
    };
  }

  if (requestPath === '/api/yolo-model-test' && method === 'POST') {
    return {
      category: 'ai',
      action: 'ai.yolo_model_test',
      target_type: 'model',
      target_id: String(req.body?.task_id || '').trim() || null,
      permission: 'ai:detect',
      detail: auditBodySummary(req)
    };
  }

  const aiHistoryMatch = requestPath.match(/^\/api\/ai-check-history(?:\/(\d+))?$/);
  if (aiHistoryMatch && method === 'GET') {
    return {
      category: 'ai',
      action: aiHistoryMatch[1] ? 'ai.history.detail.read' : 'ai.history.list.read',
      target_type: aiHistoryMatch[1] ? 'ai_check_request' : 'ai_check_history',
      target_id: aiHistoryMatch[1] || null,
      permission: 'ai:history:read',
      detail: {
        query: sanitizeCloudOpsPayload(req.query || {})
      }
    };
  }

  const yoloReviewMatch = requestPath.match(/^\/api\/yolo-label-review(?:\/([^/?]+))?/);
  if (yoloReviewMatch && method === 'GET') {
    return {
      category: 'ai',
      action: 'ai.yolo_label.read',
      target_type: 'yolo_training_dataset',
      target_id: String(req.body?.dataset_id || req.query?.dataset_id || yoloReviewMatch[1] || '').trim() || null,
      permission: 'ai:yolo:review',
      detail: {
        query: sanitizeCloudOpsPayload(req.query || {})
      }
    };
  }

  const moduleMatch = requestPath.match(/^\/api\/(cloud-mapping|three-dgs|crowd-cpm|park-pcm)(?:\/([^/?]+))?/);
  if (moduleMatch && ['POST', 'PATCH', 'DELETE'].includes(method)) {
    const categoryMap = {
      'cloud-mapping': 'mapping',
      'three-dgs': 'three_dgs',
      'crowd-cpm': 'crowd_cpm',
      'park-pcm': 'park_pcm'
    };
    return {
      category: categoryMap[moduleMatch[1]] || moduleMatch[1],
      action: `${moduleMatch[1]}.${method.toLowerCase()}.${moduleMatch[2] || 'request'}`,
      target_type: moduleMatch[1],
      target_id: String(req.body?.id || req.body?.target_id || req.body?.vehicle_id || moduleMatch[2] || '').trim(),
      vehicle_id: String(req.body?.vehicle_id || '').trim(),
      detail: auditBodySummary(req)
    };
  }

  return null;
}

function legacyAuthAuditRecords(items = []) {
  return (Array.isArray(items) ? items : []).map((item) => normalizeRecord({
    id: `legacy_auth_${crypto
      .createHash('sha1')
      .update(`${item?.at || ''}|${item?.actor || ''}|${item?.action || ''}|${item?.target || ''}`)
      .digest('hex')
      .slice(0, 18)}`,
    at: item?.at || null,
    actor: item?.actor || null,
    actor_name: item?.actor || null,
    category: 'auth',
    action: item?.action || 'auth.operation',
    target_type: 'user',
    target_id: item?.target || null,
    ok: true,
    source: 'auth-store',
    detail: item?.detail || {}
  }));
}

function installOperationAuditMiddleware() {
  app.use((req, res, next) => {
    const startedAt = Date.now();
    const classification = classifyOperationAuditRequest(req);
    if (!classification) {
      return next();
    }

    res.on('finish', () => {
      const meta = requestMeta(req);
      const actor =
        req.jgzjAuth?.user?.username ||
        classification.actor ||
        (classification.category === 'auth' ? classification.target_id : null);

      operationAuditStore
        .record({
          ...classification,
          actor,
          actor_name: req.jgzjAuth?.user?.display_name || actor,
          ok: res.statusCode >= 200 && res.statusCode < 400,
          status: res.statusCode,
          duration_ms: Date.now() - startedAt,
          method: req.method,
          path: req.originalUrl || req.url,
          ip: meta.ip,
          user_agent: meta.user_agent
        })
        .catch((error) => {
          console.info('operation_audit_write_failed', JSON.stringify({ error: error.message }));
        });
    });

    return next();
  });
}

installOperationAuditMiddleware();

app.get('/healthz', (_req, res) => {
  res.type('text/plain').send('ok');
});

app.get('/api/auth/me', async (req, res) => {
  const auth = await authStore.getAuthFromRequest(req);
  if (!auth) {
    return res.json({
      ok: true,
      authenticated: false,
      username: null,
      user: null,
      permissions: []
    });
  }
  return res.json(authUserResponse(auth));
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const user = await authStore.register(req.body || {}, requestMeta(req));
    const login = await authStore.login(user.username, String(req.body?.password || ''), requestMeta(req));
    const issue = await authStore.issueEmailVerification(user.username, requestMeta(req), { force: true });
    const emailDelivery = await sendEmailVerification(req, issue).catch((error) => ({
      ok: false,
      mode: 'error',
      error: error.message || 'email_send_failed'
    }));
    authStore.setSessionCookie(res, login.token, login.expires_at_ms - Date.now());
    return res.status(201).json({
      ok: true,
      authenticated: true,
      username: login.user.username,
      user: issue.user,
      permissions: issue.user.effective_permissions,
      email_delivery: emailDelivery,
      message: 'registered_email_verification_required'
    });
  } catch (error) {
    return res.status(error.status || 400).json({
      ok: false,
      error: error.message || 'register_failed',
      detail:
        error.message === 'invalid_username'
          ? '用户名需为 3-32 位小写字母、数字、点、下划线或短横线。'
          : error.message === 'weak_password'
            ? '密码长度需为 6-128 位。'
            : error.message === 'invalid_email'
              ? '请输入有效邮箱。'
              : error.message === 'username_exists'
                ? '该用户名已存在。'
                : '注册失败。'
    });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const login = await authStore.login(req.body?.username, req.body?.password, requestMeta(req));
    authStore.setSessionCookie(res, login.token, login.expires_at_ms - Date.now());
    return res.json({
      ok: true,
      authenticated: true,
      username: login.user.username,
      user: login.user,
      permissions: login.user.effective_permissions
    });
  } catch (error) {
    authStore.clearSessionCookie(res);
    return res.status(error.status || 401).json({
      ok: false,
      error: 'login_failed',
      detail: '用户名或密码错误。'
    });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  const auth = await authStore.getAuthFromRequest(req, { touch: false });
  if (auth) {
    req.jgzjAuth = auth;
  }
  await authStore.logout(req, auth?.username || null);
  authStore.clearSessionCookie(res);
  clearOpenClawAuthCookie(res);
  return res.json({
    ok: true,
    authenticated: false
  });
});

app.post('/api/auth/request-email-verification', async (req, res) => {
  const auth = await authStore.getAuthFromRequest(req);
  if (!auth) {
    authStore.clearSessionCookie(res);
    return res.status(401).json({
      ok: false,
      error: 'login_required',
      detail: '请先登录。'
    });
  }
  req.jgzjAuth = auth;
  try {
    let user = auth.user;
    if (typeof req.body?.email === 'string' && req.body.email.trim()) {
      user = await authStore.updateOwnEmail(auth.user.username, req.body.email, requestMeta(req));
    }
    if (user.email_verified) {
      return res.json({
        ok: true,
        user,
        email_delivery: null,
        message: 'email_already_verified'
      });
    }
    const issue = await authStore.issueEmailVerification(user.username, requestMeta(req));
    const emailDelivery = await sendEmailVerification(req, issue);
    return res.json({
      ok: true,
      user: issue.user,
      email_delivery: emailDelivery,
      message: 'verification_email_sent'
    });
  } catch (error) {
    return res.status(error.status || 400).json({
      ok: false,
      error: error.message || 'email_verification_request_failed',
      retry_after_ms: error.retry_after_ms || undefined,
      detail:
        error.message === 'invalid_email'
          ? '请输入有效邮箱。'
          : error.message === 'email_required'
            ? '请先填写邮箱。'
            : error.message === 'email_verification_rate_limited'
              ? '验证邮件发送太频繁，请稍后再试。'
              : '发送验证邮件失败。'
    });
  }
});

app.get('/api/auth/verify-email', async (req, res) => {
  try {
    const user = await authStore.verifyEmailToken(req.query?.token, requestMeta(req));
    const acceptsJson = String(req.get('accept') || '').includes('application/json');
    if (acceptsJson) {
      return res.json({
        ok: true,
        user,
        message: 'email_verified'
      });
    }
    return res
      .status(200)
      .type('html')
      .send(
        renderEmailVerificationPage({
          ok: true,
          title: '邮箱验证成功',
          detail: '账号邮箱已经完成验证。重新打开账号面板后，对应权限会自动恢复。'
        })
      );
  } catch (error) {
    const acceptsJson = String(req.get('accept') || '').includes('application/json');
    if (acceptsJson) {
      return res.status(error.status || 400).json({
        ok: false,
        error: error.message || 'email_verify_failed',
        detail: '验证链接无效或已过期。'
      });
    }
    return res
      .status(error.status || 400)
      .type('html')
      .send(
        renderEmailVerificationPage({
          ok: false,
          title: '邮箱验证失败',
          detail: '验证链接无效或已过期。请登录后在账号面板重新发送验证邮件。'
        })
      );
  }
});

app.get('/api/auth/permissions', async (_req, res) => {
  return res.json({
    ok: true,
    permissions: authStore.permissions()
  });
});

app.get('/api/auth/users', (req, res, next) => authStore.requireSuperAdmin(req, res, next), async (_req, res) => {
  const users = await authStore.listUsers();
  return res.json({
    ok: true,
    users,
    permissions: authStore.permissions()
  });
});

app.patch('/api/auth/users/:username', (req, res, next) => authStore.requireSuperAdmin(req, res, next), async (req, res) => {
  try {
    const user = await authStore.updateUser(req.jgzjAuth?.user, req.params.username, req.body || {});
    return res.json({
      ok: true,
      user
    });
  } catch (error) {
    return res.status(error.status || 400).json({
      ok: false,
      error: error.message || 'user_update_failed',
      detail:
        error.message === 'cannot_modify_super_admin'
          ? '不能修改其他超级管理员。'
          : error.message === 'cannot_disable_self'
            ? '不能禁用当前登录账号。'
            : error.message === 'user_not_found'
              ? '账号不存在。'
              : '账号更新失败。'
    });
  }
});

app.get('/api/operation-audit', authStore.requirePermission('audit:read'), async (req, res) => {
  try {
    const legacyRecords = legacyAuthAuditRecords(await authStore.listAudit());
    const history = await operationAuditStore.query(req.query || {}, legacyRecords);
    const categories = [...new Set(history.items.map((item) => item.category).filter(Boolean))].sort();
    return res.json({
      ok: true,
      ...history,
      categories
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      error: 'operation_audit_unavailable',
      detail: error?.message || 'operation_audit_unavailable'
    });
  }
});

app.get('/api/health', async (_req, res) => {
  const upstream = await probeUpstream();
  const status = upstream.ok ? 200 : 502;

  res.status(status).json({
    ok: upstream.ok,
    service: 'orchestra-backend',
    upstream_base_url: upstreamBaseUrl,
    upstream_stream_url: upstreamStreamUrl,
    upstream
  });
});

app.get('/api/chat-identities', authStore.requirePermission('ai:chat'), async (_req, res) => {
  try {
    const identities = await listVehicleIdentities();
    return res.json({
      ok: true,
      default_vehicle_id: defaultVehicleId,
      identities
    });
  } catch (error) {
    return res.json({
      ok: false,
      default_vehicle_id: defaultVehicleId,
      identities: [defaultVehicleId],
      detail: error.message
    });
  }
});

app.get('/api/openclaw-auth-status', (req, res) => {
  return authStore.requirePermission('vehicle:read')(req, res, () => {
    const auth = req.jgzjAuth;
    return res.json({
      ok: true,
      authenticated: true,
      auth_mode: 'jgzj_session',
      username: auth.user.username,
      expires_at_ms: auth.session.expires_at_ms,
      permissions: auth.user.effective_permissions
    });
  });
});

app.post('/api/openclaw-login', async (req, res) => {
  try {
    const login = await authStore.login(req.body?.username, req.body?.password, requestMeta(req));
    authStore.setSessionCookie(res, login.token, login.expires_at_ms - Date.now());
    if (!authStore.hasPermission(login.user, 'vehicle:read')) {
      return res.status(403).json({
        ok: false,
        error: 'permission_denied',
        required_permission: 'vehicle:read',
        detail: '当前账号没有车辆运维权限。'
      });
    }
    return res.json({
      ok: true,
      authenticated: true,
      username: login.user.username,
      expires_at_ms: login.expires_at_ms,
      permissions: login.user.effective_permissions
    });
  } catch (_error) {
    authStore.clearSessionCookie(res);
    clearOpenClawAuthCookie(res);
    return res.status(401).json({
      ok: false,
      error: 'openclaw_login_failed',
      detail: '用户名或密码错误。'
    });
  }
});

app.post('/api/openclaw-logout', async (req, res) => {
  const auth = await authStore.getAuthFromRequest(req, { touch: false });
  await authStore.logout(req, auth?.username || null);
  authStore.clearSessionCookie(res);
  clearOpenClawAuthCookie(res);
  return res.json({
    ok: true,
    authenticated: false
  });
});

app.get('/api/openclaw-health', authStore.requirePermission('vehicle:read'), async (_req, res) => {
  const [health, cloudAgent] = await Promise.all([probeOpenClaw(), probeCloudAgent()]);
  return res.status(health.ok ? 200 : 502).json({
    ok: health.ok,
    service: 'openclaw-agent-proxy',
    ...health,
    cloud_agent: cloudAgent
  });
});

app.get('/api/cloud-agent-health', authStore.requirePermission('vehicle:read'), async (_req, res) => {
  const health = await probeCloudAgent();
  return res.status(health.ok ? 200 : 502).json({
    ok: health.ok,
    service: 'cloud-agent-proxy',
    ...health
  });
});

app.get('/api/cloud-ops/vehicles', authStore.requirePermission('vehicle:read'), async (_req, res) => {
  try {
    const vehicles = await listCloudAgentVehicles();
    const enrichedVehicles = enrichCloudOpsVehiclesWithAudioAlsa(vehicles);
    return res.json({
      ok: true,
      vehicles: enrichedVehicles
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      detail: error?.message || 'cloud_ops_vehicle_list_failed'
    });
  }
});

app.get('/api/cloud-ops/vehicles/:vehicleId', authStore.requirePermission('vehicle:read'), async (req, res) => {
  const vehicleId = String(req.params?.vehicleId || '').trim();
  if (!vehicleId) {
    return res.status(400).json({
      ok: false,
      detail: 'vehicle_id_required'
    });
  }

  const execution = await executeCloudOpsAction(
    {
      action: 'vehicle_detail',
      vehicle_id: vehicleId,
      timeout_s: 20
    },
    []
  );

  return res.status(execution.ok ? 200 : 502).json({
    ok: execution.ok,
    summary: renderCloudOpsFallbackReply('', execution),
    execution
  });
});

app.get(
  '/api/cloud-ops/vehicles/:vehicleId/tool-list',
  authStore.requirePermission('vehicle:read'),
  async (req, res) => {
    const vehicleId = String(req.params?.vehicleId || '').trim();
    if (!vehicleId) {
      return res.status(400).json({
        ok: false,
        detail: 'vehicle_id_required'
      });
    }

    const timeout_s = toFiniteInteger(req.query?.timeout_s, 20, { min: 3, max: 120 });
    const execution = await executeCloudOpsAction(
      {
        action: 'tool_list',
        vehicle_id: vehicleId,
        timeout_s
      },
      []
    );

    const tools = Array.isArray(execution?.data?.response?.tools) ? execution.data.response.tools : [];
    return res.status(execution.ok ? 200 : 502).json({
      ok: execution.ok,
      tools,
      summary: renderCloudOpsFallbackReply('', execution),
      execution
    });
  }
);

app.post('/api/cloud-ops/deploy/catalog', authStore.requirePermission('vehicle:code:read'), async (req, res) => {
  const vehicleId = String(req.body?.vehicle_id || '').trim();
  if (!vehicleId) {
    return res.status(400).json({
      ok: false,
      detail: 'vehicle_id_required'
    });
  }

  const timeout_s = toFiniteInteger(req.body?.timeout_s, 70, { min: 10, max: 120 });
  const execution = await executeCloudOpsAction(
    {
      action: 'tool_call',
      vehicle_id: vehicleId,
      tool_name: 'deploy.targets',
      args: {},
      timeout_s
    },
    []
  );
  const result = execution?.data?.response?.result || {};
  return res.status(execution.ok ? 200 : 502).json({
    ok: execution.ok,
    vehicle_id: vehicleId,
    repositories: normalizeDeployRepositories(result),
    raw: result,
    execution: sanitizeCloudOpsPayload(execution)
  });
});

app.post('/api/cloud-ops/deploy/repo-status', authStore.requirePermission('vehicle:code:read'), async (req, res) => {
  const vehicleId = String(req.body?.vehicle_id || '').trim();
  const controller = String(req.body?.controller || '').trim();
  const repo = String(req.body?.repo || '').trim();
  if (!vehicleId || !controller || !repo) {
    return res.status(400).json({
      ok: false,
      detail: 'vehicle_id_controller_repo_required'
    });
  }

  const timeout_s = toFiniteInteger(req.body?.timeout_s, 70, { min: 10, max: 120 });
  const execution = await executeCloudOpsAction(
    {
      action: 'tool_call',
      vehicle_id: vehicleId,
      tool_name: 'deploy.repo_status',
      args: {
        controller,
        repo,
        fetch: Boolean(req.body?.fetch),
        include_branches: req.body?.include_branches !== false,
        git_username: String(req.body?.git_username || '').trim(),
        git_password: String(req.body?.git_password || '')
      },
      timeout_s
    },
    []
  );
  const result = execution?.data?.response?.result || {};
  return res.status(execution.ok ? 200 : 502).json({
    ok: execution.ok,
    vehicle_id: vehicleId,
    result,
    branches: normalizeDeployBranches(result),
    execution: sanitizeCloudOpsPayload(execution)
  });
});

app.post('/api/cloud-ops/deploy/commits', authStore.requirePermission('vehicle:code:read'), async (req, res) => {
  const vehicleId = String(req.body?.vehicle_id || '').trim();
  const controller = String(req.body?.controller || '').trim();
  const repo = String(req.body?.repo || '').trim();
  const branch = normalizeDeployBranchName(req.body?.branch);
  if (!vehicleId || !controller || !repo || !branch) {
    return res.status(400).json({
      ok: false,
      detail: 'vehicle_id_controller_repo_branch_required'
    });
  }

  const timeout_s = toFiniteInteger(req.body?.timeout_s, 70, { min: 10, max: 120 });
  const limit = toFiniteInteger(req.body?.limit, 50, { min: 1, max: 100 });
  const gitUsername = String(req.body?.git_username || '').trim();
  const gitPassword = String(req.body?.git_password || '');
  const execution = await executeCloudOpsAction(
    {
      action: 'tool_call',
      vehicle_id: vehicleId,
      tool_name: 'deploy.repo_status',
      args: {
        controller,
        repo,
        fetch: false,
        include_branches: true,
        git_username: gitUsername,
        git_password: gitPassword
      },
      timeout_s
    },
    []
  );
  if (!execution.ok) {
    return res.status(502).json({
      ok: false,
      detail: execution.detail || execution.error || 'repo_status_failed',
      execution
    });
  }

  const result = execution?.data?.response?.result || {};
  const remoteUrl = firstDeployFetchRemote(result);
  try {
    const commits = await listDeployCommitsWithGit(remoteUrl, branch, limit, {
      git_username: gitUsername,
      git_password: gitPassword
    });
    return res.json({
      ok: true,
      vehicle_id: vehicleId,
      controller,
      repo,
      branch,
      source: 'git',
      remote_url: redactGitRemoteUrl(remoteUrl),
      commits,
      execution: sanitizeCloudOpsPayload(execution)
    });
  } catch (error) {
    const credentialRemoteUrl = applyGitHttpCredentials(remoteUrl, gitUsername, gitPassword);
    return res.json({
      ok: true,
      vehicle_id: vehicleId,
      controller,
      repo,
      branch,
      source: 'status_fallback',
      remote_url: redactGitRemoteUrl(remoteUrl),
      warning: redactDeploySecret(error?.message || 'git_commit_lookup_failed', [
        gitUsername,
        gitPassword,
        credentialRemoteUrl
      ]),
      commits: fallbackDeployCommits(result, branch),
      execution: sanitizeCloudOpsPayload(execution)
    });
  }
});

app.post('/api/cloud-ops/execute', async (req, res) => {
  const plan = validateCloudOpsPlan(req.body);

  if (!plan) {
    return res.status(400).json({
      ok: false,
      detail: 'invalid_cloud_ops_plan'
    });
  }

  const requiredPermission = cloudOpsPermissionForPlan(plan);
  const auth = await authStore.ensureRequestPermission(req, res, requiredPermission);
  if (!auth) {
    return;
  }

  const vehicles = await listCloudAgentVehicles().catch(() => []);

  if (!plan.vehicle_id && vehicles.length === 1) {
    plan.vehicle_id = String(vehicles[0]?.vehicle_id || vehicles[0]?.plate_number || '').trim();
  }

  const execution = await executeCloudOpsAction(plan, vehicles);
  const summary = renderCloudOpsFallbackReply('', execution);

  return res.status(execution.ok ? 200 : 502).json({
    ok: execution.ok,
    plan: sanitizeCloudOpsPayload(plan),
    summary,
    execution: sanitizeCloudOpsPayload(execution)
  });
});

app.get('/api/map-editor/:vehicleId/status', authStore.requirePermission('vehicle:path:write'), async (req, res) => {
  const vehicleId = String(req.params?.vehicleId || '').trim();
  if (!vehicleId) {
    return res.status(400).json({
      ok: false,
      detail: 'vehicle_id_required'
    });
  }

  const execution = await executeMapEditorTool(vehicleId, 'map_editor.status', {}, 20);
  return res.status(execution.ok ? 200 : 502).json({
    ok: execution.ok,
    result: unwrapMapEditorToolResult(execution),
    execution,
    detail: execution.ok ? undefined : execution.detail || execution.error
  });
});

app.post('/api/map-editor/:vehicleId/start', authStore.requirePermission('vehicle:path:write'), async (req, res) => {
  const vehicleId = String(req.params?.vehicleId || '').trim();
  if (!vehicleId) {
    return res.status(400).json({
      ok: false,
      detail: 'vehicle_id_required'
    });
  }

  const execution = await executeMapEditorTool(vehicleId, 'map_editor.start', {}, 35);
  return res.status(execution.ok ? 200 : 502).json({
    ok: execution.ok,
    result: unwrapMapEditorToolResult(execution),
    execution,
    detail: execution.ok ? undefined : execution.detail || execution.error
  });
});

app.post('/api/map-editor/:vehicleId/stop', authStore.requirePermission('vehicle:path:write'), async (req, res) => {
  const vehicleId = String(req.params?.vehicleId || '').trim();
  if (!vehicleId) {
    return res.status(400).json({
      ok: false,
      detail: 'vehicle_id_required'
    });
  }

  const execution = await executeMapEditorTool(vehicleId, 'map_editor.stop', {}, 20);
  return res.status(execution.ok ? 200 : 502).json({
    ok: execution.ok,
    result: unwrapMapEditorToolResult(execution),
    execution,
    detail: execution.ok ? undefined : execution.detail || execution.error
  });
});

app.get('/vehicles/:vehicleId/map-editor', authStore.requirePermission('vehicle:path:write'), (req, res, next) => {
  const parsedUrl = new URL(req.originalUrl, 'http://localhost');
  if (!parsedUrl.pathname.endsWith('/map-editor')) {
    return next();
  }
  return res.redirect(302, `${parsedUrl.pathname}/${parsedUrl.search}`);
});

app.use('/vehicles/:vehicleId/map-editor', authStore.requirePermission('vehicle:path:write'), async (req, res) => {
  const vehicleId = String(req.params?.vehicleId || '').trim();
  const editorPath = normalizeMapEditorPath(req.path || '/');
  const method = String(req.method || 'GET').toUpperCase();
  const upstreamMethod = method === 'HEAD' ? 'GET' : method;

  if (!vehicleId) {
    return res.status(400).json({
      ok: false,
      detail: 'vehicle_id_required'
    });
  }

  if (!editorPath) {
    return res.status(400).json({
      ok: false,
      detail: 'invalid_map_editor_path'
    });
  }

  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
    return res.status(405).json({
      ok: false,
      detail: 'map_editor_method_not_allowed'
    });
  }

  if ((method === 'GET' || method === 'HEAD') && !mapEditorAllowedGetPaths.has(editorPath)) {
    return res.status(404).json({
      ok: false,
      detail: 'map_editor_path_not_allowed',
      path: editorPath
    });
  }

  if (method === 'POST' && !mapEditorAllowedPostPaths.has(editorPath)) {
    return res.status(403).json({
      ok: false,
      detail: 'map_editor_post_path_not_allowed',
      path: editorPath
    });
  }

  const parsedUrl = new URL(req.originalUrl, 'http://localhost');
  const useChunkedMapEditorResponse = shouldChunkMapEditorPath(editorPath);
  const args = {
    method: upstreamMethod,
    path: editorPath,
    query: parsedUrl.searchParams.toString(),
    max_response_bytes: getMapEditorMaxResponseBytes(editorPath),
    chunk_response: useChunkedMapEditorResponse,
    chunk_threshold_bytes: MAP_EDITOR_CHUNK_THRESHOLD_BYTES,
    chunk_size_bytes: MAP_EDITOR_CHUNK_SIZE_BYTES
  };

  if (method === 'POST') {
    const contentType = req.get('content-type') || 'application/json';
    args.headers = {
      'content-type': contentType
    };
    if (req.body !== undefined && req.body !== null) {
      const bodyText =
        Buffer.isBuffer(req.body) || typeof req.body === 'string'
          ? req.body
          : JSON.stringify(req.body);
      const bodyBuffer = Buffer.isBuffer(bodyText) ? bodyText : Buffer.from(String(bodyText), 'utf8');
      args.body_base64 = bodyBuffer.toString('base64');
    }
  }

  const execution = await executeMapEditorTool(
    vehicleId,
    'map_editor.http',
    args,
    mapEditorBinaryPaths.has(editorPath) || mapEditorLargeJsonPaths.has(editorPath) ? 60 : 35
  );

  if (!execution.ok) {
    return res.status(502).json({
      ok: false,
      detail: execution.detail || execution.error || 'map_editor_proxy_failed',
      execution
    });
  }

  const result = unwrapMapEditorToolResult(execution);
  if (!result || typeof result !== 'object') {
    return res.status(502).json({
      ok: false,
      detail: 'invalid_map_editor_response',
      execution
    });
  }

  const statusCode = toFiniteInteger(result.status, 502, { min: 100, max: 599 });
  const headers = result.headers && typeof result.headers === 'object' ? result.headers : {};
  const contentType =
    getMapEditorHeader(headers, 'content-type') ||
    (mapEditorBinaryPaths.has(editorPath) ? 'application/octet-stream' : 'text/plain; charset=utf-8');
  let bodyBuffer;
  try {
    bodyBuffer = result.body_chunked
      ? await readMapEditorChunkedBody(vehicleId, result, editorPath)
      : result.body_base64
        ? Buffer.from(String(result.body_base64), 'base64')
        : Buffer.alloc(0);
  } catch (error) {
    return res.status(502).json({
      ok: false,
      detail: error.message || 'map_editor_chunk_reassembly_failed',
      execution
    });
  }
  if (mapEditorLargeJsonPaths.has(editorPath) || bodyBuffer.length > 1024 * 1024) {
    console.info(
      'map_editor_proxy_result',
      JSON.stringify({
        vehicle_id: vehicleId,
        path: editorPath,
        status: statusCode,
        body_bytes: result.body_bytes || bodyBuffer.length,
        decoded_bytes: bodyBuffer.length,
        base64_length: result.body_base64 ? String(result.body_base64).length : 0,
        chunked: Boolean(result.body_chunked),
        chunks_total: result.chunks_total ?? null,
        duration_ms: result.duration_ms ?? null
      })
    );
  }

  res.status(statusCode);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Map-Editor-Vehicle', vehicleId);
  res.setHeader('X-Map-Editor-Path', editorPath);
  if (method === 'HEAD') {
    return res.end();
  }
  return res.send(bodyBuffer);
});

app.use(
  '/api/yolo-label-review',
  authStore.requirePermission('ai:yolo:review')
);

app.get('/api/yolo-label-review/datasets', async (_req, res) => {
  try {
    const datasets = await listYoloDatasets();
    return res.json({
      ok: true,
      datasets
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      error: 'yolo_datasets_unavailable',
      detail: error.message
    });
  }
});

app.get('/api/yolo-label-review/items', async (req, res) => {
  try {
    const payload = await listYoloReviewItems(req.query.dataset_id, req.query || {});
    return res.json({
      ok: true,
      ...payload
    });
  } catch (error) {
    return res.status(error.status || 502).json({
      ok: false,
      error: error.message || 'yolo_items_unavailable'
    });
  }
});

app.get('/api/yolo-label-review/item', async (req, res) => {
  try {
    const payload = await getYoloReviewItemDetail(req.query.dataset_id, req.query.item_key);
    return res.json({
      ok: true,
      ...payload
    });
  } catch (error) {
    return res.status(error.status || 502).json({
      ok: false,
      error: error.message || 'yolo_item_unavailable'
    });
  }
});

app.get('/api/yolo-label-review/file', async (req, res) => {
  try {
    let absolutePath = '';
    if (isYoloReviewPatrolDatasetId(req.query.dataset_id)) {
      absolutePath = resolveYoloPatrolFilePath(req.query.path).absolutePath;
    } else {
      const dataset = await resolveYoloDataset(req.query.dataset_id);
      absolutePath = resolveYoloDatasetRelPath(dataset, req.query.path).absolutePath;
    }
    if (!isYoloImagePath(absolutePath)) {
      return res.status(400).json({
        ok: false,
        error: 'not_an_image_file'
      });
    }
    return sendYoloImageFile(req, res, absolutePath);
  } catch (error) {
    return res.status(error.status || 404).json({
      ok: false,
      error: error.message || 'yolo_file_not_found'
    });
  }
});

app.use(
  '/api/ai-check-history/files',
  authStore.requirePermission('ai:history:read'),
  express.static(aiCheckArchiveRoot, {
    fallthrough: false,
    index: false,
    maxAge: '5m'
  })
);

app.get('/api/ai-check-history', authStore.requirePermission('ai:history:read'), async (req, res) => {
  const page = toFiniteInteger(req.query.page, 1, { min: 1, max: 9999 });
  const pageSize = toFiniteInteger(req.query.page_size, 8, { min: 1, max: 24 });
  const deviceId =
    typeof req.query.device_id === 'string' && req.query.device_id.trim()
      ? req.query.device_id.trim()
      : '';
  const eventName =
    typeof req.query.event_name === 'string' && req.query.event_name.trim()
      ? req.query.event_name.trim()
      : '';

  try {
    const history = await listAiCheckHistory(page, pageSize, {
      device_id: deviceId,
      event_name: eventName
    });
    return res.json({
      ok: true,
      archive_root: aiCheckArchiveRoot,
      ...history
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      error: 'ai_check_history_unavailable',
      detail: error.message
    });
  }
});

app.get('/api/ai-check-history/:requestRowId(\\d+)', authStore.requirePermission('ai:history:read'), async (req, res) => {
  const requestRowId = toFiniteInteger(req.params.requestRowId, 0, { min: 1, max: Number.MAX_SAFE_INTEGER });

  try {
    const request = await getAiCheckHistoryDetail(requestRowId);
    if (!request) {
      return res.status(404).json({
        ok: false,
        error: 'ai_check_request_not_found'
      });
    }

    return res.json({
      ok: true,
      request
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      error: 'ai_check_history_detail_unavailable',
      detail: error.message
    });
  }
});

app.post('/api/cloud-chat', authStore.requirePermission('ai:chat'), async (req, res) => {
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  const wantsStream =
    req.body?.stream === true || String(req.headers.accept || '').includes('text/event-stream');
  const sessionId =
    typeof req.body?.session_id === 'string' && req.body.session_id.trim()
      ? req.body.session_id.trim()
      : `${defaultVehicleId}-${Date.now()}`;
  const reset = Boolean(req.body?.reset);
  const vehicleId =
    typeof req.body?.vehicle_id === 'string' && req.body.vehicle_id.trim()
      ? req.body.vehicle_id.trim()
      : defaultVehicleId;
  const enableThinking = Boolean(req.body?.enable_thinking);

  if (!message) {
    return res.status(400).json({ error: 'message_required' });
  }

  try {
    const upstreamResponse = await fetch(upstreamStreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream'
      },
      body: JSON.stringify(createUpstreamPayload(message, sessionId, { reset, vehicle_id: vehicleId, enable_thinking: enableThinking })),
      signal: AbortSignal.timeout(requestTimeoutMs)
    });

    if (!upstreamResponse.ok || !upstreamResponse.body) {
      const detail = normalizeReply(await upstreamResponse.text());
      const payload = {
        error: 'upstream_request_failed',
        status: upstreamResponse.status,
        detail: detail || null
      };

      if (wantsStream) {
        res.status(502);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        writeSseEvent(res, { type: 'error', ...payload });
        return res.end();
      }

      return res.status(502).json(payload);
    }

    if (wantsStream) {
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      const result = await readStreamReply(upstreamResponse.body, (event) => {
        if (event?.type && event?.text) {
          writeSseEvent(res, event);
        }
      });

      writeSseEvent(res, {
        type: 'final',
        answer: result.reply,
        reasoning: result.reasoning,
        source: result.source,
        latency_ms: result.latency_ms
      });
      return res.end();
    }

    const result = await readStreamReply(upstreamResponse.body);
    return res.json({
      ok: true,
      session_id: sessionId,
      ...result
    });
  } catch (error) {
    const isAbort = error.name === 'TimeoutError' || error.name === 'AbortError';
    const status = isAbort ? 504 : 502;
    const payload = {
      error: isAbort ? 'upstream_timeout' : 'upstream_unavailable',
      detail: error.message
    };

    if (wantsStream) {
      if (!res.headersSent) {
        res.status(status);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
      }
      writeSseEvent(res, { type: 'error', ...payload });
      return res.end();
    }

    return res.status(status).json(payload);
  }
});

app.post('/api/openclaw-chat', authStore.requirePermission('vehicle:read'), async (req, res) => {
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  const sessionId =
    typeof req.body?.session_id === 'string' && req.body.session_id.trim()
      ? req.body.session_id.trim()
      : `openclaw-${Date.now()}`;
  const vehicleId =
    typeof req.body?.vehicle_id === 'string' && req.body.vehicle_id.trim()
      ? req.body.vehicle_id.trim()
      : '';
  const contextItems = normalizeOpenClawContextItems(req.body?.context_items);

  if (!message) {
    return res.status(400).json({ error: 'message_required' });
  }

  try {
    const result = await runOpenClawOpsTurn(message, sessionId, {
      vehicle_id: vehicleId,
      context_items: contextItems,
      auth_user: req.jgzjAuth?.user || null
    });
    return res.json({
      ok: true,
      session_id: sessionId,
      context_count: contextItems.length,
      ...result
    });
  } catch (error) {
    const isAbort = error.killed === true || error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT';
    return res.status(isAbort ? 504 : 502).json({
      ok: false,
      error: isAbort ? 'openclaw_timeout' : 'openclaw_unavailable',
      detail: error.message
    });
  }
});

app.get('/api/qwen36-health', authStore.requirePermission('ai:chat'), async (_req, res) => {
  const result = await probeQwen36();
  return res.status(result.ok ? 200 : 502).json(result);
});

app.post('/api/qwen36-chat', authStore.requirePermission('ai:chat'), async (req, res) => {
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  const messages = normalizeQwen36Messages(req.body?.messages, message);
  const wantsStream =
    req.body?.stream === true || String(req.headers.accept || '').includes('text/event-stream');
  const enableThinking =
    req.body?.thinking === false || req.body?.enable_thinking === false
      ? false
      : String(req.body?.thinking || req.body?.enable_thinking || 'true').toLowerCase() !== 'false';
  const preserveThinking =
    req.body?.preserve_thinking === false
      ? false
      : String(req.body?.preserve_thinking ?? 'true').toLowerCase() !== 'false';
  const maxTokens = toFiniteInteger(req.body?.max_tokens, enableThinking ? 2048 : 1024, {
    min: 64,
    max: 4096
  });
  const temperature = Number.isFinite(Number(req.body?.temperature))
    ? Math.min(2, Math.max(0, Number(req.body.temperature)))
    : 0.7;
  const topP = Number.isFinite(Number(req.body?.top_p))
    ? Math.min(1, Math.max(0.01, Number(req.body.top_p)))
    : 0.95;
  const topK = toFiniteInteger(req.body?.top_k, 20, { min: 1, max: 200 });

  if (!messages.length) {
    return res.status(400).json({ ok: false, error: 'message_required' });
  }

  const payload = {
    model: qwen36Model,
    messages,
    temperature,
    top_p: topP,
    top_k: topK,
    max_tokens: maxTokens,
    stream: true,
    chat_template_kwargs: {
      enable_thinking: enableThinking,
      preserve_thinking: preserveThinking
    }
  };

  let guard;
  try {
    guard = beginQwen36Request(qwen36Protection);
  } catch (error) {
    const status = error.status || 503;
    const errorPayload = qwen36ProtectionErrorPayload(error, qwen36Protection);
    if (wantsStream) {
      res.status(status);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      writeSseEvent(res, { type: 'error', ...errorPayload });
      return res.end();
    }
    return res.status(status).json(errorPayload);
  }

  try {
    const upstreamResponse = await fetch(qwen36ChatUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream'
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(qwen36TimeoutMs)
    });

    if (!upstreamResponse.ok || !upstreamResponse.body) {
      const detail = normalizeReply(await upstreamResponse.text());
      const upstreamError = new Error(detail || `qwen36 upstream ${upstreamResponse.status}`);
      guard.failure(upstreamError);
      const errorPayload = {
        ok: false,
        error: 'qwen36_request_failed',
        status: upstreamResponse.status,
        detail: detail || null,
        protection: qwen36ProtectionSnapshot(qwen36Protection)
      };

      if (wantsStream) {
        res.status(502);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        writeSseEvent(res, { type: 'error', ...errorPayload });
        return res.end();
      }

      return res.status(502).json(errorPayload);
    }

    if (wantsStream) {
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      const result = await readQwen36Stream(upstreamResponse.body, (event) => {
        if (event.text) {
          writeSseEvent(res, event);
        }
      });

      writeSseEvent(res, {
        type: 'final',
        answer: result.reply,
        reasoning: result.reasoning,
        finish_reason: result.finish_reason,
        usage: result.usage,
        model: qwen36Model,
        thinking: enableThinking,
        protection: qwen36ProtectionSnapshot(qwen36Protection)
      });
      guard.success();
      return res.end();
    }

    const result = await readQwen36Stream(upstreamResponse.body);
    guard.success();
    return res.json({
      ok: true,
      model: qwen36Model,
      thinking: enableThinking,
      protection: qwen36ProtectionSnapshot(qwen36Protection),
      ...result
    });
  } catch (error) {
    guard.failure(error);
    const isAbort = error.name === 'TimeoutError' || error.name === 'AbortError';
    const status = isAbort ? 504 : 502;
    const errorPayload = {
      ok: false,
      error: isAbort ? 'qwen36_timeout' : 'qwen36_unavailable',
      detail: error.message,
      protection: qwen36ProtectionSnapshot(qwen36Protection)
    };

    if (wantsStream) {
      if (!res.headersSent) {
        res.status(status);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
      }
      writeSseEvent(res, { type: 'error', ...errorPayload });
      return res.end();
    }

    return res.status(status).json(errorPayload);
  } finally {
    guard.release();
  }
});

app.post('/api/qwen36-mm-check', authStore.requirePermission('ai:detect'), async (req, res) => {
  const startMs = Date.now();
  const image = req.body?.image;
  if (!image?.mime_type || !image?.data_base64) {
    return res.status(400).json({ ok: false, error: 'image_required' });
  }

  const imageSizeBytes = Buffer.byteLength(String(image.data_base64 || ''), 'base64');
  if (imageSizeBytes > qwen36MmMaxImageBytes) {
    return res.status(413).json({
      ok: false,
      error: 'image_too_large',
      detail: `图片过大，请压缩到 ${Math.floor(qwen36MmMaxImageBytes / 1024 / 1024)}MB 以内。`,
      max_image_bytes: qwen36MmMaxImageBytes,
      image_size_bytes: imageSizeBytes,
      protection: qwen36ProtectionSnapshot(qwen36MmProtection)
    });
  }

  const eventName = String(req.body?.event_name || '').trim() || '异常事件';
  const customPrompt = String(req.body?.prompt_text || '').trim();
  const promptText = customPrompt ||
    `Reply YES if this image clearly shows the event "${eventName}". Reply NO if the event is absent. Output only YES or NO.`;

  const imageUrl = `data:${image.mime_type};base64,${image.data_base64}`;

  const payload = {
    model: qwen36MmModel,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageUrl } },
          { type: 'text', text: promptText }
        ]
      }
    ],
    max_tokens: customPrompt ? 512 : 64,
    temperature: 0.1,
    stream: false,
    chat_template_kwargs: { enable_thinking: false }
  };

  let guard;
  try {
    guard = beginQwen36Request(qwen36MmProtection);
  } catch (error) {
    return res.status(error.status || 503).json(qwen36ProtectionErrorPayload(error, qwen36MmProtection));
  }

  try {
    const upstreamResponse = await fetch(qwen36MmChatUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(qwen36MmTimeoutMs)
    });

    if (!upstreamResponse.ok) {
      const detail = normalizeReply(await upstreamResponse.text());
      const upstreamError = new Error(detail || `qwen36-mm upstream ${upstreamResponse.status}`);
      guard.failure(upstreamError);
      console.info('qwen36_mm_check_result', JSON.stringify({
        event_name: eventName, ok: false,
        error: 'upstream_error', status: upstreamResponse.status,
        duration_ms: Date.now() - startMs
      }));
      return res.status(502).json({
        ok: false,
        error: 'qwen36_mm_request_failed',
        status: upstreamResponse.status,
        detail: detail || null,
        protection: qwen36ProtectionSnapshot(qwen36MmProtection)
      });
    }

    const data = await upstreamResponse.json();
    const msg = data?.choices?.[0]?.message || {};
    const raw = String(msg.content || msg.reasoning || '').trim();
    const upper = raw.toUpperCase();
    const answer = upper.includes('YES') ? 'YES' : upper.includes('NO') ? 'NO' : 'UNKNOWN';
    const durationMs = Date.now() - startMs;

    console.info('qwen36_mm_check_result', JSON.stringify({
      event_name: eventName, answer, finish_reason: data?.choices?.[0]?.finish_reason,
      raw_reply: raw.slice(0, 80), duration_ms: durationMs, model: qwen36MmModel
    }));
    guard.success();

    const imageBuffer = Buffer.from(image.data_base64, 'base64');
    const requestId = `req_${startMs}_${crypto.randomBytes(4).toString('hex')}`;
    saveQwen36MmCheckToArchive({
      requestId, eventName, promptText,
      imageBuffer, imageMimeType: image.mime_type,
      answer, rawText: raw, latencyMs: durationMs, startMs
    }).catch((archiveErr) => {
      console.info('qwen36_mm_archive_error', JSON.stringify({ error: archiveErr.message, event_name: eventName }));
    });

    return res.json({
      ok: true,
      model: qwen36MmModel,
      event_name: eventName,
      answer,
      raw_reply: raw,
      protection: qwen36ProtectionSnapshot(qwen36MmProtection)
    });
  } catch (error) {
    guard.failure(error);
    const isAbort = error.name === 'TimeoutError' || error.name === 'AbortError';
    console.info('qwen36_mm_check_result', JSON.stringify({
      event_name: eventName, ok: false,
      error: isAbort ? 'timeout' : 'exception',
      detail: error.message, duration_ms: Date.now() - startMs
    }));
    return res.status(isAbort ? 504 : 502).json({
      ok: false,
      error: isAbort ? 'qwen36_mm_timeout' : 'qwen36_mm_unavailable',
      detail: error.message,
      protection: qwen36ProtectionSnapshot(qwen36MmProtection)
    });
  } finally {
    guard.release();
  }
});

app.post('/api/yolo-model-test', authStore.requirePermission('ai:detect'), async (req, res) => {
  const startMs = Date.now();
  const taskId = String(req.body?.task_id || '').trim();
  const task = yoloModelTestTasks[taskId];
  if (!task) {
    return res.status(400).json({
      ok: false,
      error: 'unknown_task',
      detail: '未知YOLO固定任务。'
    });
  }

  let decoded;
  try {
    decoded = decodeYoloModelTestImage(req.body?.image);
  } catch (error) {
    return res.status(error.status || 400).json({
      ok: false,
      error: error.message || 'invalid_image',
      detail: error.detail || null,
      max_image_bytes: yoloModelTestMaxImageBytes,
      image_size_bytes: error.imageSizeBytes || null
    });
  }

  const requestId = `yolo_${startMs}_${crypto.randomBytes(4).toString('hex')}`;
  const localRunDir = path.join(yoloModelTestRoot, requestId);
  const localInputPath = path.join(localRunDir, `input${decoded.ext}`);
  const localScriptPath = path.join(localRunDir, 'predict.py');
  const remoteRunDir = `${yoloA100WorkRoot}/${requestId}`;
  const remoteInputPath = `${remoteRunDir}/input${decoded.ext}`;
  const remoteScriptPath = `${remoteRunDir}/predict.py`;
  let remoteContextReady = false;
  let remoteContextPromise = null;

  const ensureRemoteYoloContext = async () => {
    if (remoteContextReady) return;
    if (!remoteContextPromise) {
      remoteContextPromise = (async () => {
        await fs.mkdir(localRunDir, { recursive: true });
        await fs.writeFile(localInputPath, decoded.buffer);
        await fs.writeFile(localScriptPath, yoloModelTestPredictScript);

        await runYoloA100Command(`mkdir -p ${shellQuote(remoteRunDir)}`, {
          timeoutMs: 30000,
          maxBuffer: 1024 * 1024
        });
        await copyYoloFileToA100(localScriptPath, remoteScriptPath);
        await copyYoloFileToA100(localInputPath, remoteInputPath);
        remoteContextReady = true;
      })().catch((error) => {
        remoteContextPromise = null;
        throw error;
      });
    }
    await remoteContextPromise;
  };

  const runYoloPredictionWithFallback = async (currentTaskId, currentTask, options = {}) => {
    const failures = [];
    try {
      const payload = await runLocalYoloPrediction(currentTaskId, currentTask, decoded, options);
      return payload;
    } catch (localError) {
      failures.push(`local:${localError.message}`);
      console.info('yolo_model_test_local_fallback', JSON.stringify({
        task_id: currentTaskId,
        error: localError.message
      }));
    }

    try {
      await ensureRemoteYoloContext();
      const payload = await runRemoteYoloPrediction(currentTask, remoteScriptPath, remoteInputPath, options);
      return {
        ...payload,
        backend: 'a100_ssh',
        gpu: yoloA100Gpu
      };
    } catch (remoteError) {
      failures.push(`a100:${remoteError.message}`);
      const error = new Error(failures.join('; '));
      error.payload = remoteError.payload || null;
      throw error;
    }
  };

  try {
    if (task.kind === 'all_yolo') {
      const runnableSubTasks = [];
      for (const subTaskId of task.subTasks || []) {
        const subTask = yoloModelTestTasks[subTaskId];
        if (!subTask || subTask.kind === 'all_yolo') {
          continue;
        }
        runnableSubTasks.push({ subTaskId, subTask });
      }

      const settledGroups = await Promise.allSettled(runnableSubTasks.map(async ({ subTaskId, subTask }) => {
        const subStartMs = Date.now();
        const payload = await runYoloPredictionWithFallback(subTaskId, subTask, {
          noAnnotated: true,
          timeoutMs: yoloModelTestTimeoutMs,
          maxBuffer: 24 * 1024 * 1024
        });
        return {
          ...buildYoloTaskResponse(subTaskId, subTask, payload, { omitAnnotatedImage: true }),
          duration_ms: Date.now() - subStartMs
        };
      }));

      const groups = [];
      const failures = [];
      settledGroups.forEach((result, index) => {
        const { subTaskId, subTask } = runnableSubTasks[index];
        if (result.status === 'fulfilled') {
          groups.push(result.value);
          return;
        }
        failures.push({
          task_id: subTaskId,
          task_label: subTask.label,
          error: truncateText(result.reason?.message || String(result.reason), 2000)
        });
      });

      if (groups.length === 0 && failures.length > 0) {
        const error = new Error(failures.map((failure) => `${failure.task_id}:${failure.error}`).join('; '));
        error.failures = failures;
        throw error;
      }

      const durationMs = Date.now() - startMs;
      const backends = [...new Set(groups.map((group) => group.backend).filter(Boolean))];
      const gpus = [...new Set(groups.map((group) => group.gpu).filter(Boolean))];
      const detections = groups.flatMap((group) =>
        (Array.isArray(group.detections) ? group.detections : []).map((detection) => ({
          ...detection,
          source_task_id: group.task_id,
          source_task_label: group.task_label
        }))
      );
      const responsePayload = {
        ok: true,
        request_id: requestId,
        task_id: taskId,
        task_label: task.label,
        mode: 'all_yolo',
        duration_ms: durationMs,
        gpu: gpus.join(', ') || yoloA100Gpu,
        backend: backends.join(' + ') || 'a100_ssh',
        groups,
        detections,
        failures
      };

      console.info('yolo_model_test_result', JSON.stringify({
        task_id: taskId,
        mode: responsePayload.mode,
        groups: groups.length,
        failures: failures.length,
        detections: detections.length,
        duration_ms: durationMs,
        gpu: responsePayload.gpu,
        backend: responsePayload.backend
      }));

      return res.json(responsePayload);
    }

    const payload = await runYoloPredictionWithFallback(taskId, task, {
      timeoutMs: yoloModelTestTimeoutMs,
      maxBuffer: 64 * 1024 * 1024
    });

    const durationMs = Date.now() - startMs;
    const responsePayload = {
      ...buildYoloTaskResponse(taskId, task, payload),
      request_id: requestId,
      duration_ms: durationMs
    };

    console.info('yolo_model_test_result', JSON.stringify({
      task_id: taskId,
      mode: responsePayload.mode,
      detections: Array.isArray(responsePayload.detections) ? responsePayload.detections.length : undefined,
      top: responsePayload.top?.class_name || null,
      duration_ms: durationMs,
      gpu: responsePayload.gpu,
      backend: responsePayload.backend
    }));

    return res.json(responsePayload);
  } catch (error) {
    const durationMs = Date.now() - startMs;
    console.info('yolo_model_test_result', JSON.stringify({
      task_id: taskId,
      ok: false,
      error: error.message,
      duration_ms: durationMs,
      gpu: yoloA100Gpu
    }));
    return res.status(502).json({
      ok: false,
      error: 'yolo_model_test_failed',
      detail: error.message || 'YOLO测试失败。',
      duration_ms: durationMs,
      gpu: yoloA100Gpu
    });
  }
});

registerCloudMappingRoutes(app, {
  authStore
});
registerThreeDgsRoutes(app, {
  authStore,
  cloudAgentBaseUrl
});
registerRuntimeControlRoutes(app, {
  requireOpenClawAuth,
  requirePermission: (permission) => authStore.requirePermission(permission),
  rootDir: path.resolve(__dirname, '..')
});
registerCrowdCpmRoutes(app, {
  requirePermission: (permission) => authStore.requirePermission(permission),
  cloudAgentBaseUrl,
  rootDir: path.resolve(__dirname, '..')
});
registerParkPcmRoutes(app, {
  requirePermission: (permission) => authStore.requirePermission(permission),
  cloudAgentBaseUrl,
  rootDir: path.resolve(__dirname, '..')
});
registerOneApiProxyRoutes(app, {
  rootDir: path.resolve(__dirname, '..'),
  statusAuthMiddleware: authStore.requirePermission('ai:chat')
});

function loginRedirectUrl(req) {
  const next = encodeURIComponent(req.originalUrl || req.url || '/');
  return `/login?next=${next}`;
}

const privateNavigationItems = [
  {
    href: '/app/robot-ai-workbench',
    label: 'AI工作台',
    permissions: ['ai:chat', 'ai:detect', 'ai:history:read']
  },
  {
    href: '/app/yolo-label-review',
    label: 'YOLO标签',
    permissions: ['ai:yolo:review']
  },
  {
    href: '/app/cloud-operations',
    label: '云端运维',
    permissions: ['vehicle:read', 'runtime:read']
  },
  {
    href: '/app/park-crowd',
    label: '园区人流',
    permissions: ['vehicle:read']
  },
  {
    href: '/app/vehicle-devops',
    label: '车辆代码',
    permissions: ['vehicle:code:read', 'vehicle:code:write']
  },
  {
    href: '/app/three-dgs',
    label: '3DGS',
    permissions: ['three-dgs:run']
  },
  {
    href: '/app/operation-history',
    label: '操作记录',
    permissions: ['audit:read']
  },
  {
    href: '/app/distributed-map-management',
    label: '地图管理',
    permissions: ['vehicle:path:write']
  }
];

const gatedSitePages = [
  {
    paths: ['/cloud-operations', '/cloud-operations/'],
    permissions: ['vehicle:read', 'runtime:read'],
    redirectTo: '/app/cloud-operations'
  },
  {
    paths: ['/vehicle-devops', '/vehicle-devops/'],
    permissions: ['vehicle:code:read', 'vehicle:code:write'],
    redirectTo: '/app/vehicle-devops'
  },
  {
    paths: ['/cloud-mapping', '/cloud-mapping/'],
    permissions: ['mapping:run'],
    redirectTo: '/app/cloud-mapping'
  },
  {
    paths: ['/three-dgs', '/three-dgs/'],
    permissions: ['three-dgs:run'],
    redirectTo: '/app/three-dgs'
  },
  {
    paths: ['/distributed-map-management', '/distributed-map-management/'],
    permissions: ['vehicle:path:write'],
    redirectTo: '/app/distributed-map-management'
  }
];

const publicRedirectPages = [
  {
    paths: ['/intelligent-ai-dialogue', '/intelligent-ai-dialogue/'],
    redirectTo: '/robot-capabilities#ai-dialogue'
  },
  {
    paths: ['/edge-cloud-ai-inspection', '/edge-cloud-ai-inspection/'],
    redirectTo: '/robot-capabilities#ai-inspection'
  }
];

app.get('/api/site/private-navigation', async (req, res) => {
  const auth = await authStore.getAuthFromRequest(req);
  res.setHeader('Cache-Control', 'private, no-store');

  if (!auth?.user?.email_verified) {
    if (!auth) {
      authStore.clearSessionCookie(res);
    }
    return res.json({ ok: true, items: [] });
  }

  const items = privateNavigationItems
    .filter((item) => authStore.hasAnyPermission(auth.user, item.permissions))
    .map((item) => ({
      href: item.href,
      label: item.label,
      permissions: item.permissions
    }));

  return res.json({ ok: true, items });
});

const protectedAppPages = [
  {
    paths: ['/app/robot-ai-workbench', '/app/robot-ai-workbench/'],
    file: 'app/robot-ai-workbench/index.html',
    permissions: ['ai:chat', 'ai:detect', 'ai:history:read']
  },
  {
    paths: ['/app/cloud-operations', '/app/cloud-operations/'],
    file: 'app/cloud-operations/index.html',
    permissions: ['vehicle:read', 'runtime:read']
  },
  {
    paths: ['/app/park-crowd', '/app/park-crowd/'],
    file: 'app/park-crowd/index.html',
    permissions: ['vehicle:read']
  },
  {
    paths: ['/app/park-pcm', '/app/park-pcm/'],
    file: 'app/park-pcm/index.html',
    permissions: ['vehicle:read']
  },
  {
    paths: ['/app/vehicle-devops', '/app/vehicle-devops/'],
    file: 'app/vehicle-devops/index.html',
    permissions: ['vehicle:code:read', 'vehicle:code:write']
  },
  {
    paths: ['/app/intelligent-ai-dialogue', '/app/intelligent-ai-dialogue/'],
    file: 'app/robot-ai-workbench/index.html',
    permissions: ['ai:chat']
  },
  {
    paths: ['/app/edge-cloud-ai-inspection', '/app/edge-cloud-ai-inspection/'],
    file: 'app/robot-ai-workbench/index.html',
    permissions: ['ai:detect', 'ai:history:read']
  },
  {
    paths: ['/app/yolo-label-review', '/app/yolo-label-review/'],
    file: 'app/yolo-label-review/index.html',
    permissions: ['ai:yolo:review']
  },
  {
    paths: ['/app/cloud-mapping', '/app/cloud-mapping/'],
    file: 'app/cloud-mapping/index.html',
    permissions: ['mapping:run']
  },
  {
    paths: ['/app/three-dgs', '/app/three-dgs/'],
    file: 'app/three-dgs/index.html',
    permissions: ['three-dgs:run']
  },
  {
    paths: ['/app/operation-history', '/app/operation-history/'],
    file: 'app/operation-history/index.html',
    permissions: ['audit:read']
  },
  {
    paths: ['/app/distributed-map-management', '/app/distributed-map-management/'],
    file: 'app/distributed-map-management/index.html',
    permissions: ['vehicle:path:write']
  }
];

function renderProtectedAppGate({ title, detail, status }) {
  const safeTitle = String(title || '访问受限')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const safeDetail = String(detail || '请先登录。')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width" />
    <meta name="robots" content="noindex,nofollow" />
    <title>${safeTitle} | 吉光智界</title>
    <style>
      body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07111f;color:#e5edf8;font-family:Arial,"Noto Sans SC",sans-serif}
      main{width:min(560px,calc(100vw - 32px));padding:28px;border:1px solid rgba(125,211,252,.22);background:rgba(15,23,42,.82)}
      h1{margin:0 0 12px;font-size:24px;line-height:1.35}
      p{margin:0 0 20px;color:#b8c4d6;line-height:1.8}
      a{display:inline-flex;padding:10px 14px;border:1px solid rgba(103,232,249,.38);color:#a5f3fc;text-decoration:none;font-weight:700}
      small{display:block;margin-top:16px;color:#7890aa}
    </style>
  </head>
  <body>
    <main>
      <h1>${safeTitle}</h1>
      <p>${safeDetail}</p>
      <a href="/login">前往登录页</a>
      <small>HTTP ${status}</small>
    </main>
  </body>
</html>`;
}

protectedAppPages.forEach((page) => {
  app.get(page.paths, async (req, res) => {
    const auth = await authStore.getAuthFromRequest(req);
    res.setHeader('Cache-Control', 'private, no-store');

    if (!auth) {
      authStore.clearSessionCookie(res);
      return res.redirect(302, loginRedirectUrl(req));
    }

    if (!authStore.hasAnyPermission(auth.user, page.permissions)) {
      return res.status(403).type('html').send(
        renderProtectedAppGate({
          status: 403,
          title: '当前账号没有权限',
          detail: auth.user.email_verified
            ? '当前账号没有访问这个工作台所需的权限。'
            : '请先完成邮箱验证，未验证账号暂不具备任何工作台权限。'
        })
      );
    }

    return res.sendFile(path.join(webRoot, page.file));
  });
});

app.get('/app/*', async (req, res, next) => {
  const normalizedPath = req.path
    .replace(/\/index\.html$/, '')
    .replace(/\/$/, '') || '/';
  const page = protectedAppPages.find((item) =>
    item.paths.some((pagePath) => (pagePath.replace(/\/$/, '') || '/') === normalizedPath)
  );

  if (!page) {
    return next();
  }

  const auth = await authStore.getAuthFromRequest(req);
  res.setHeader('Cache-Control', 'private, no-store');

  if (!auth) {
    authStore.clearSessionCookie(res);
    return res.redirect(302, loginRedirectUrl(req));
  }

  if (!authStore.hasAnyPermission(auth.user, page.permissions)) {
    return res.status(403).type('html').send(
      renderProtectedAppGate({
        status: 403,
        title: '当前账号没有权限',
        detail: auth.user.email_verified
          ? '当前账号没有访问这个工作台所需的权限。'
          : '请先完成邮箱验证，未验证账号暂不具备任何工作台权限。'
      })
    );
  }

  return res.sendFile(path.join(webRoot, page.file));
});

publicRedirectPages.forEach((page) => {
  app.get(page.paths, (_req, res) => {
    res.redirect(301, page.redirectTo);
  });
});

gatedSitePages.forEach((page) => {
  app.get(page.paths, async (req, res) => {
    const auth = await authStore.getAuthFromRequest(req);
    res.setHeader('Cache-Control', 'private, no-store');

    if (!auth) {
      authStore.clearSessionCookie(res);
      return res.redirect(302, loginRedirectUrl(req));
    }

    if (!authStore.hasAnyPermission(auth.user, page.permissions)) {
      return res.status(403).type('html').send(
        renderProtectedAppGate({
          status: 403,
          title: '当前账号没有权限',
          detail: auth.user.email_verified
            ? '当前账号没有访问这个内部页面所需的权限。'
            : '请先完成邮箱验证，未验证账号暂不具备任何内部页面权限。'
        })
      );
    }

    return res.redirect(302, page.redirectTo);
  });
});

app.use(
  '/supersplat-viewer',
  express.static(superSplatViewerRoot, {
    index: 'index.html',
    maxAge: '1h'
  })
);

function setWebStaticCacheHeaders(res, filePath) {
  const relativePath = path.relative(webRoot, filePath).split(path.sep).join('/');
  if (relativePath.endsWith('.html')) {
    if (relativePath === 'login/index.html' || relativePath.startsWith('app/')) {
      res.setHeader('Cache-Control', 'private, no-store');
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
    return;
  }
  if (relativePath.startsWith('_astro/')) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return;
  }
  if (relativePath.startsWith('assets/optimized/') || relativePath.startsWith('assets/fallback/')) {
    res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
    return;
  }
  if (relativePath.startsWith('js/')) {
    res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
  }
}

app.use(express.static(webRoot, { setHeaders: setWebStaticCacheHeaders }));
app.get('*', (_req, res) => {
  res.sendFile(path.join(webRoot, 'index.html'));
});

function writeUpgradeError(socket, statusCode, reason) {
  if (!socket || socket.destroyed) {
    return;
  }
  const statusText = `${statusCode} ${reason}`;
  socket.write(
    [
      `HTTP/1.1 ${statusText}`,
      'Connection: close',
      'Content-Length: 0',
      '',
      ''
    ].join('\r\n')
  );
  socket.destroy();
}

function buildWebSocketProxyRequest(req, targetUrl) {
  const pathWithQuery = `${targetUrl.pathname || '/'}${targetUrl.search || ''}`;
  const lines = [
    `GET ${pathWithQuery} HTTP/1.1`,
    `Host: ${targetUrl.host}`,
    'Upgrade: websocket',
    'Connection: Upgrade'
  ];
  const skipHeaders = new Set(['host', 'upgrade', 'connection', 'proxy-connection']);

  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i];
    const value = req.rawHeaders[i + 1];
    if (!name || skipHeaders.has(String(name).toLowerCase())) {
      continue;
    }
    lines.push(`${name}: ${value}`);
  }

  const remoteAddress = req.socket?.remoteAddress;
  if (remoteAddress) {
    lines.push(`X-Forwarded-For: ${remoteAddress}`);
  }

  lines.push('', '');
  return lines.join('\r\n');
}

function proxyWebSocketUpgrade(req, socket, head, targetUrl) {
  const targetPort = Number(targetUrl.port || (targetUrl.protocol === 'wss:' ? 443 : 80));
  const upstreamSocket = net.connect(
    {
      host: targetUrl.hostname,
      port: targetPort
    },
    () => {
      upstreamSocket.write(buildWebSocketProxyRequest(req, targetUrl));
      if (head?.length) {
        upstreamSocket.write(head);
      }
      socket.pipe(upstreamSocket);
      upstreamSocket.pipe(socket);
    }
  );

  upstreamSocket.on('error', (error) => {
    console.warn(`websocket upstream error path=${req.url} target=${targetUrl.href}: ${error.message}`);
    writeUpgradeError(socket, 502, 'Bad Gateway');
  });

  socket.on('error', () => {
    upstreamSocket.destroy();
  });

  socket.on('close', () => {
    upstreamSocket.destroy();
  });
}

function getWebSocketUpgradeTarget(pathname) {
  if (pathname === '/ws/chat') {
    return {
      permission: 'ai:chat',
      baseUrl: upstreamBaseUrl,
      path: process.env.UPSTREAM_CHAT_WS_PATH || '/ws/chat'
    };
  }

  if (pathname === '/ws/qwen/check') {
    return {
      permission: 'ai:detect',
      baseUrl: process.env.QWEN_CHECK_WS_BASE_URL || 'http://127.0.0.1:8794',
      path: process.env.QWEN_CHECK_WS_PATH || '/ws/qwen/check'
    };
  }

  if (pathname === '/ws/ops') {
    return {
      permission: 'vehicle:read',
      baseUrl: process.env.CLOUD_OPS_WS_BASE_URL || cloudAgentBaseUrl,
      path: process.env.CLOUD_OPS_WS_PATH || '/ws/ops'
    };
  }

  return null;
}

async function handleWebSocketUpgrade(req, socket, head) {
  let pathname = '';
  try {
    pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
  } catch (_error) {
    writeUpgradeError(socket, 400, 'Bad Request');
    return;
  }

  const target = getWebSocketUpgradeTarget(pathname);
  if (!target) {
    writeUpgradeError(socket, 404, 'Not Found');
    return;
  }

  try {
    const auth = await authStore.getAuthFromRequest(req);
    if (!auth) {
      writeUpgradeError(socket, 401, 'Unauthorized');
      return;
    }
    if (!authStore.hasPermission(auth.user, target.permission)) {
      writeUpgradeError(socket, 403, 'Forbidden');
      return;
    }

    const targetUrl = new URL(target.path, target.baseUrl);
    targetUrl.protocol = targetUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    proxyWebSocketUpgrade(req, socket, head, targetUrl);
  } catch (error) {
    console.warn(`websocket auth/proxy error path=${req.url}: ${error.message}`);
    writeUpgradeError(socket, 500, 'Internal Server Error');
  }
}

const server = app.listen(port, () => {
  console.log(`backend listening on ${port}`);
  console.log(`proxying cloud chat to ${upstreamStreamUrl}`);
});
server.requestTimeout = httpServerRequestTimeoutMs;
server.headersTimeout = httpServerHeadersTimeoutMs;
server.keepAliveTimeout = httpServerKeepAliveTimeoutMs;
server.on('upgrade', (req, socket, head) => {
  void handleWebSocketUpgrade(req, socket, head);
});
