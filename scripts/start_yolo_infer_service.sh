#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${JGZJ_ROOT_DIR:-/home/admin1/jgzj}"
PYTHON_BIN="${YOLO_LOCAL_PYTHON:-python3}"
GPU_INDEX="${YOLO_LOCAL_GPU_INDEX:-2}"
GPU_MAX_USED_MB="${YOLO_LOCAL_GPU_MAX_USED_MB:-1000}"
HOST="${YOLO_MODEL_TEST_HOST:-127.0.0.1}"
PORT="${YOLO_MODEL_TEST_PORT:-18087}"
WEIGHTS_DIR="${YOLO_MODEL_WEIGHTS_DIR:-${ROOT_DIR}/.runtime/yolo_model_service/weights}"

GENERAL_MODEL="${YOLO_GENERAL_MODEL:-${WEIGHTS_DIR}/general_yolo_best.pt}"
TRASH_MODEL="${YOLO_TRASH_MODEL:-${WEIGHTS_DIR}/trash_yolo_best.pt}"
FIRE_SMOKE_MODEL="${YOLO_FIRE_SMOKE_MODEL:-${WEIGHTS_DIR}/fire_smoke_yolo_best.pt}"
PET_MODEL="${YOLO_PET_MODEL:-${WEIGHTS_DIR}/pet_yolo_best.pt}"
PHONE_MODEL="${YOLO_PHONE_MODEL:-${WEIGHTS_DIR}/phone_yolo_best.pt}"
STALL_MODEL="${YOLO_STALL_MODEL:-${WEIGHTS_DIR}/stall_yolo_best.pt}"
SMOKING_CANDIDATE_MODEL="${YOLO_SMOKING_CANDIDATE_MODEL:-${WEIGHTS_DIR}/smoking_candidate_best.pt}"
SMOKING_CLS_MODEL="${YOLO_SMOKING_CLS_MODEL:-${WEIGHTS_DIR}/smoking_cls_best.pt}"

for model_path in "${GENERAL_MODEL}" "${TRASH_MODEL}" "${FIRE_SMOKE_MODEL}" "${PET_MODEL}" "${PHONE_MODEL}" "${STALL_MODEL}" "${SMOKING_CANDIDATE_MODEL}" "${SMOKING_CLS_MODEL}"; do
  if [[ ! -s "${model_path}" ]]; then
    echo "required model missing: ${model_path}" >&2
    exit 76
  fi
done

if command -v ss >/dev/null 2>&1 && ss -ltn "sport = :${PORT}" | grep -q LISTEN; then
  echo "port already in use: ${PORT}" >&2
  exit 77
fi

if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "nvidia-smi not found" >&2
  exit 78
fi

used_mb="$(nvidia-smi --id="${GPU_INDEX}" --query-gpu=memory.used --format=csv,noheader,nounits | head -1 | tr -dc '0-9')"
if [[ -z "${used_mb}" ]]; then
  echo "failed to read gpu memory for gpu ${GPU_INDEX}" >&2
  exit 78
fi
if (( used_mb > GPU_MAX_USED_MB )); then
  echo "gpu ${GPU_INDEX} already uses ${used_mb}MiB, above limit ${GPU_MAX_USED_MB}MiB; not starting local yolo service" >&2
  exit 75
fi

export CUDA_VISIBLE_DEVICES="${GPU_INDEX}"
export TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD=1
export PYTHONUNBUFFERED=1
export YOLO_MODEL_TEST_DEVICE="${YOLO_MODEL_TEST_DEVICE:-0}"
export YOLO_MODEL_TEST_TORCH_DEVICE="${YOLO_MODEL_TEST_TORCH_DEVICE:-cuda:0}"
export YOLO_MODEL_TEST_GPU_LABEL="${YOLO_MODEL_TEST_GPU_LABEL:-server-proxy-gpu${GPU_INDEX}}"
export YOLO_PRELOAD_MODELS="${GENERAL_MODEL},${TRASH_MODEL},${FIRE_SMOKE_MODEL},${PET_MODEL},${PHONE_MODEL},${STALL_MODEL},${SMOKING_CANDIDATE_MODEL},${SMOKING_CLS_MODEL}"

exec "${PYTHON_BIN}" "${ROOT_DIR}/scripts/yolo_inference_service.py" \
  --host "${HOST}" \
  --port "${PORT}" \
  --device "${YOLO_MODEL_TEST_DEVICE}" \
  --gpu-label "${YOLO_MODEL_TEST_GPU_LABEL}" \
  --require-preload
