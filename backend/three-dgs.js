const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const execFileAsync = promisify(execFile);

function parseList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function createInitialState() {
  return {
    phase: 'idle',
    active_username: null,
    stage_text: '等待选择车辆、采集或上传 3DGS 数据。',
    updated_at_ms: Date.now(),
    error_message: null,
    capture: {
      vehicle_id: null,
      active: false,
      multi_camera: false,
      session_id: null,
      session_ids: {},
      child_sessions: {},
      cameras: [],
      saved_frames: 0,
      camera_statuses: [],
      last_response: null,
      manifest: null,
      started_at_ms: null,
      stopped_at_ms: null,
      last_monitor_ms: null,
      monitor_error: null
    },
    uploads: {
      image_pose: null,
      pointcloud: null
    },
    vehicle_uploads: {
      image_pose: null,
      pointcloud: null
    },
    vehicle_data: {
      vehicle_id: null,
      configured_cameras: [],
      calibrated_cameras: [],
      map_vehicle_path: 'map/GlobalMap.pcd',
      map_info: null,
      map_meta: null,
      calibration: null,
      last_map_update_ms: null,
      last_image_pull_ms: null
    },
    dataset: {
      prepared: false,
      scene_name: '',
      path: null,
      summary: null,
      prepared_at_ms: null
    },
    prepare: {
      running: false,
      pid: null,
      log_path: null,
      started_at_ms: null,
      completed_at_ms: null,
      progress: null
    },
    train: {
      phase: 'idle',
      running: false,
      run_id: null,
      local_log_path: null,
      remote_dataset_path: null,
      remote_run_path: null,
      remote_status: null,
      remote_pid: null,
      resume_from_checkpoint: null,
      resume_from_iteration: null,
      checkpoint_interval: null,
      mode: null,
      sync_progress: null,
      dataset_fingerprint: null,
      remote_dataset_synced_at_ms: null,
      gpu: null,
      iterations: null,
      resolution: null,
      started_at_ms: null,
      completed_at_ms: null,
      last_remote_status_check_ms: null,
      error_message: null
    },
    viewer: {
      run_id: null,
      local_point_cloud_path: null,
      point_cloud_url: null,
      size_bytes: null,
      synced_at_ms: null,
      source_remote_path: null,
      error_message: null
    },
    viewer_camera: {
      manual: null
    }
  };
}

module.exports = function registerThreeDgsRoutes(app, options = {}) {
  const authStore = options.authStore || null;
  const cloudAgentBaseUrl = options.cloudAgentBaseUrl || process.env.CLOUD_AGENT_BASE_URL || 'http://127.0.0.1:8000';
  const cloudAgentTimeoutMs = Number(process.env.THREE_DGS_CLOUD_AGENT_TIMEOUT_MS || 30000);
  const runtimeRoot = path.resolve(process.env.THREE_DGS_RUNTIME_ROOT || path.resolve(__dirname, '../.runtime/three-dgs'));
  const uploadDir = path.join(runtimeRoot, 'uploads');
  const datasetRoot = path.join(runtimeRoot, 'datasets');
  const logDir = path.join(runtimeRoot, 'logs');
  const resultRoot = path.join(runtimeRoot, 'results');
  const statePath = path.join(runtimeRoot, 'three-dgs-state.json');
  const imagePoseUploadPath = path.join(uploadDir, 'image-pose-upload');
  const pointcloudUploadPath = path.join(uploadDir, 'pointcloud-upload');
  const prepareScriptPath = path.resolve(process.env.THREE_DGS_PREPARE_SCRIPT_PATH || path.resolve(__dirname, '../scripts/prepare_3dgs_colmap.py'));
  const uploadMaxBytes = Number(process.env.THREE_DGS_UPLOAD_MAX_BYTES || 12 * 1024 * 1024 * 1024);
  const sshKeyPath = process.env.THREE_DGS_A100_SSH_KEY || '/home/admin1/a100_tunnel/jgzj_qwen36_proxy_ed25519';
  const a100User = process.env.THREE_DGS_A100_USER || 'sari';
  const a100Host = process.env.THREE_DGS_A100_HOST || '192.168.80.49';
  const remoteDatasetRoot = process.env.THREE_DGS_REMOTE_DATASET_ROOT || '/home/sari/datasets/3dgs/cloud_control';
  const remoteRunRoot = process.env.THREE_DGS_REMOTE_RUN_ROOT || '/home/sari/3dgs_runs/cloud_control';
  const remoteSourceRoot = process.env.THREE_DGS_REMOTE_SOURCE_ROOT || '/home/sari/3dgs_src/gaussian-splatting';
  const remoteEnvName = process.env.THREE_DGS_REMOTE_ENV_NAME || '3dgs124_exact';
  const defaultVehicleId = process.env.THREE_DGS_DEFAULT_VEHICLE_ID || 'BIT-0041';
  const defaultTrainGpu = String(process.env.THREE_DGS_DEFAULT_GPU || '3').trim() || '3';
  const defaultTrainResolution = Math.max(1, Number(process.env.THREE_DGS_DEFAULT_RESOLUTION || 1));
  const remoteStatusPollMs = Number(process.env.THREE_DGS_REMOTE_STATUS_POLL_MS || 30000);
  const vehicleMapPath = process.env.THREE_DGS_VEHICLE_MAP_PATH || 'map/GlobalMap.pcd';
  const configuredCameraIds = parseList(process.env.THREE_DGS_CAMERA_IDS || 'camera1,camera2,camera3,camera4');
  const fallbackCalibratedCameras = parseList(process.env.THREE_DGS_FALLBACK_CALIBRATED_CAMERAS || configuredCameraIds.join(','));
  const allowedVehicleIds = parseList(process.env.THREE_DGS_ALLOWED_VEHICLE_IDS || defaultVehicleId);
  const mapDownloadTools = parseList(process.env.THREE_DGS_MAP_DOWNLOAD_TOOLS || '');
  const mapUploadTool = process.env.THREE_DGS_MAP_UPLOAD_TOOL || 'map.pointcloud.upload';
  const fallbackMapUploadStagingDir = process.env.THREE_DGS_MAP_UPLOAD_FALLBACK_STAGING_DIR || '/home/nvidia/auto_ad_ai_map_upload';
  const publicBaseUrl = String(process.env.THREE_DGS_PUBLIC_BASE_URL || 'http://idtrd.kmdns.net:7791').replace(/\/+$/, '');
  const vehicleUploadTokenTtlMs = Number(process.env.THREE_DGS_VEHICLE_UPLOAD_TOKEN_TTL_MS || 2 * 60 * 60 * 1000);
  const vehicleUploadRequestTimeoutMs = Number(process.env.THREE_DGS_VEHICLE_UPLOAD_REQUEST_TIMEOUT_MS || 30 * 60 * 1000);
  const pointcloudPreviewMaxReadBytes = Number(process.env.THREE_DGS_POINTCLOUD_PREVIEW_MAX_READ_BYTES || 512 * 1024 * 1024);
  const defaultUndistortMode = ['keep-k', 'optimal'].includes(process.env.THREE_DGS_UNDISTORT_MODE)
    ? process.env.THREE_DGS_UNDISTORT_MODE
    : 'keep-k';
  const colorizeInitialPoints = String(process.env.THREE_DGS_COLORIZE_POINTS || 'true').toLowerCase() !== 'false';
  const filterVisibleInitialPoints = String(process.env.THREE_DGS_FILTER_VISIBLE_POINTS || 'true').toLowerCase() !== 'false';
  const colorizeMaxFrames = Number(process.env.THREE_DGS_COLORIZE_MAX_FRAMES || 640);
  const colorizeMinObservations = Number(process.env.THREE_DGS_COLORIZE_MIN_OBSERVATIONS || 2);
  const colorizeMinKeptPoints = Number(process.env.THREE_DGS_COLORIZE_MIN_KEPT_POINTS || 20000);
  const colorizeOcclusionCellPx = Number(process.env.THREE_DGS_COLORIZE_OCCLUSION_CELL_PX || 8);
  const colorizeDepthToleranceM = Number(process.env.THREE_DGS_COLORIZE_DEPTH_TOLERANCE_M || 1.0);
  const colorizeMinDepthM = Number(process.env.THREE_DGS_COLORIZE_MIN_DEPTH_M || 0.1);
  const defaultCheckpointInterval = Math.max(100, Number(process.env.THREE_DGS_CHECKPOINT_INTERVAL || 1000));
  const viewerCameraForwardSign = Number(process.env.THREE_DGS_VIEWER_CAMERA_FORWARD_SIGN || -1) >= 0 ? 1 : -1;

  let state = createInitialState();
  let statePersistTimer = null;
  let prepareProcess = null;
  let trainBootstrapProcess = null;
  let trainStopRequested = false;
  let captureStartInFlight = false;
  let uploadInFlight = false;
  const pendingVehicleUploads = new Map();
  const captureStreamClients = new Set();
  let captureMonitorTimer = null;
  let captureMonitorInFlight = false;
  const vehicleToolQueues = new Map();

  function scheduleStatePersist() {
    if (statePersistTimer) {
      clearTimeout(statePersistTimer);
    }
    statePersistTimer = setTimeout(() => {
      statePersistTimer = null;
      persistState().catch(() => {});
    }, 120);
    statePersistTimer.unref?.();
  }

  async function ensureRuntimeDirs() {
    await Promise.all([
      fsp.mkdir(runtimeRoot, { recursive: true }),
      fsp.mkdir(uploadDir, { recursive: true }),
      fsp.mkdir(datasetRoot, { recursive: true }),
      fsp.mkdir(logDir, { recursive: true }),
      fsp.mkdir(resultRoot, { recursive: true })
    ]);
  }

  async function persistState() {
    await ensureRuntimeDirs();
    await fsp.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
  }

  function updateState(patch) {
    state = {
      ...state,
      ...patch,
      updated_at_ms: Date.now()
    };
    scheduleStatePersist();
  }

  function updateNestedState(key, patch) {
    updateState({
      [key]: {
        ...(state[key] || {}),
        ...patch
      }
    });
  }

  async function loadStateFromDisk() {
    try {
      const parsed = JSON.parse(await fsp.readFile(statePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        state = {
          ...createInitialState(),
          ...parsed,
          capture: {
            ...createInitialState().capture,
            ...(parsed.capture || {})
          },
          uploads: {
            ...createInitialState().uploads,
            ...(parsed.uploads || {})
          },
          vehicle_data: {
            ...createInitialState().vehicle_data,
            ...(parsed.vehicle_data || {}),
            map_vehicle_path: vehicleMapPath
          },
          dataset: {
            ...createInitialState().dataset,
            ...(parsed.dataset || {})
          },
          prepare: {
            ...createInitialState().prepare,
            ...(parsed.prepare || {})
          },
          train: { ...createInitialState().train, ...(parsed.train || {}) },
          viewer: { ...createInitialState().viewer, ...(parsed.viewer || {}) },
          viewer_camera: { ...createInitialState().viewer_camera, ...(parsed.viewer_camera || {}) },
          updated_at_ms: Number(parsed.updated_at_ms) || Date.now()
        };
        normalizeStaleTransientState();
      }
    } catch (_error) {
      state = createInitialState();
    }
  }

  function normalizeStaleTransientState() {
    if (['uploading', 'updating_map', 'pulling_image_pose', 'starting_capture'].includes(state.phase)) {
      state = {
        ...state,
        phase: state.dataset.prepared ? 'prepared' : 'idle',
        stage_text: '等待选择车辆、采集或上传 3DGS 数据。',
        error_message: null,
        updated_at_ms: Date.now()
      };
    }
    if (state.train?.running && state.train.phase === 'syncing') {
      state = {
        ...state,
        phase: 'error',
        stage_text: '上次同步到 A100 在网站服务重启时中断，请点“开始训练(重新)”重新开始。',
        error_message: 'train_sync_interrupted_by_backend_restart',
        train: {
          ...state.train,
          phase: 'error',
          running: false,
          remote_status: { phase: 'error', reason: 'backend_restart_during_sync' },
          completed_at_ms: Date.now(),
          error_message: 'train_sync_interrupted_by_backend_restart'
        },
        updated_at_ms: Date.now()
      };
    }
  }

  function normalizeThreeDgsStageText(text) {
    let next = String(text || '');
    next = next.replace(/车端\s+3DGS\s+四路图像-位姿包/g, '车端当前 3DGS session 图像-位姿包');
    next = next.replace(/车端\s+[^，。]+?\s+四路图像-位姿包/g, '车端当前 3DGS session 图像-位姿包');
    next = next.replace(/车端\s+[^，。]+?\s+图像-位姿包已合并上传/g, '车端当前 3DGS session 图像-位姿包已上传');
    next = next.replace(/车端\s+[^，。]+?\s+3DGS\s+采集已启动/g, '车端 3DGS 车辆级采集 session 已启动');
    return next;
  }

  function responseState() {
    return {
      ...state,
      stage_text: normalizeThreeDgsStageText(state.stage_text)
    };
  }

  async function safeStat(targetPath) {
    try {
      return await fsp.stat(targetPath);
    } catch (_error) {
      return null;
    }
  }

  async function readPrepareProgressFile(datasetPath = state.dataset?.path) {
    if (!datasetPath) return null;
    const resolvedDatasetPath = path.resolve(datasetPath);
    const resolvedDatasetRoot = path.resolve(datasetRoot);
    if (resolvedDatasetPath !== resolvedDatasetRoot && !resolvedDatasetPath.startsWith(`${resolvedDatasetRoot}${path.sep}`)) {
      return null;
    }
    const targetPath = path.join(resolvedDatasetPath, 'three_dgs_prepare_progress.json');
    try {
      const parsed = JSON.parse(await fsp.readFile(targetPath, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (_error) {
      return null;
    }
  }

  async function refreshPrepareProgressFromDisk() {
    if (!state.prepare.running && !state.dataset?.path) return;
    const progress = await readPrepareProgressFile();
    if (!progress) return;
    const stageText = state.prepare.running && progress.stage_label
      ? `预处理：${progress.stage_label}${progress.detail ? ` · ${progress.detail}` : ''}`
      : state.stage_text;
    updateState({
      stage_text: stageText,
      prepare: {
        ...state.prepare,
        progress
      }
    });
  }

  function sanitizeFileName(value, fallback = 'upload.bin') {
    const base = path.basename(String(value || fallback)).replace(/[^\w.\-+\u4e00-\u9fa5]+/g, '_');
    return base.slice(0, 180) || fallback;
  }

  function parsePcdHeader(buffer) {
    const headerLimit = Math.min(buffer.length, 1024 * 1024);
    const headerText = buffer.subarray(0, headerLimit).toString('latin1');
    const dataMatch = headerText.match(/(?:^|\r?\n)DATA\s+(\S+)\s*\r?\n/i);
    if (!dataMatch || typeof dataMatch.index !== 'number') {
      throw new Error('pcd_data_header_not_found');
    }
    const headerEnd = dataMatch.index + dataMatch[0].length;
    const lines = headerText.slice(0, headerEnd).split(/\r?\n/);
    const header = {
      fields: [],
      size: [],
      type: [],
      count: [],
      points: 0,
      width: 0,
      height: 1,
      data: dataMatch[1].toLowerCase(),
      dataOffset: headerEnd
    };
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (!parts.length) continue;
      const key = parts[0].toUpperCase();
      if (key === 'FIELDS') header.fields = parts.slice(1);
      if (key === 'SIZE') header.size = parts.slice(1).map((item) => Number(item));
      if (key === 'TYPE') header.type = parts.slice(1);
      if (key === 'COUNT') header.count = parts.slice(1).map((item) => Number(item));
      if (key === 'POINTS') header.points = Number(parts[1] || 0);
      if (key === 'WIDTH') header.width = Number(parts[1] || 0);
      if (key === 'HEIGHT') header.height = Number(parts[1] || 1);
    }
    if (!header.points) {
      header.points = Math.max(0, header.width * header.height);
    }
    if (!header.count.length) {
      header.count = header.fields.map(() => 1);
    }
    return header;
  }

  function readPcdNumber(buffer, offset, size, type) {
    if (offset + size > buffer.length) return null;
    const kind = String(type || 'F').toUpperCase();
    if (kind === 'F' && size === 4) return buffer.readFloatLE(offset);
    if (kind === 'F' && size === 8) return buffer.readDoubleLE(offset);
    if (kind === 'I' && size === 4) return buffer.readInt32LE(offset);
    if (kind === 'I' && size === 2) return buffer.readInt16LE(offset);
    if (kind === 'I' && size === 1) return buffer.readInt8(offset);
    if (kind === 'U' && size === 4) return buffer.readUInt32LE(offset);
    if (kind === 'U' && size === 2) return buffer.readUInt16LE(offset);
    if (kind === 'U' && size === 1) return buffer.readUInt8(offset);
    return null;
  }

  function summarizePreviewPoints(points) {
    const extent = {
      min_x: Infinity,
      max_x: -Infinity,
      min_y: Infinity,
      max_y: -Infinity,
      min_z: Infinity,
      max_z: -Infinity
    };
    for (const point of points) {
      extent.min_x = Math.min(extent.min_x, point[0]);
      extent.max_x = Math.max(extent.max_x, point[0]);
      extent.min_y = Math.min(extent.min_y, point[1]);
      extent.max_y = Math.max(extent.max_y, point[1]);
      extent.min_z = Math.min(extent.min_z, point[2]);
      extent.max_z = Math.max(extent.max_z, point[2]);
    }
    for (const [key, value] of Object.entries(extent)) {
      if (!Number.isFinite(value)) {
        extent[key] = 0;
      }
    }
    return extent;
  }

  function parsePcdPreview(buffer, maxPoints) {
    const header = parsePcdHeader(buffer);
    const fields = header.fields.map((field, index) => ({
      name: field,
      size: Number(header.size[index] || 4),
      type: header.type[index] || 'F',
      count: Number(header.count[index] || 1)
    }));
    let offset = 0;
    for (const field of fields) {
      field.offset = offset;
      offset += field.size * field.count;
    }
    const pointStep = offset;
    const xField = fields.find((field) => field.name === 'x');
    const yField = fields.find((field) => field.name === 'y');
    const zField = fields.find((field) => field.name === 'z');
    if (!xField || !yField || !zField) {
      throw new Error('pcd_missing_xyz');
    }

    const points = [];
    const stride = Math.max(1, Math.ceil(header.points / Math.max(1, maxPoints)));
    if (header.data === 'binary') {
      for (let pointIndex = 0; pointIndex < header.points; pointIndex += stride) {
        const base = header.dataOffset + pointIndex * pointStep;
        const x = readPcdNumber(buffer, base + xField.offset, xField.size, xField.type);
        const y = readPcdNumber(buffer, base + yField.offset, yField.size, yField.type);
        const z = readPcdNumber(buffer, base + zField.offset, zField.size, zField.type);
        if ([x, y, z].every(Number.isFinite)) {
          points.push([x, y, z]);
        }
      }
    } else if (header.data === 'ascii') {
      const rows = buffer.subarray(header.dataOffset).toString('utf8').split(/\r?\n/);
      const xIndex = header.fields.indexOf('x');
      const yIndex = header.fields.indexOf('y');
      const zIndex = header.fields.indexOf('z');
      rows.forEach((row, index) => {
        if (index % stride !== 0 || !row.trim()) return;
        const values = row.trim().split(/\s+/);
        const x = Number(values[xIndex]);
        const y = Number(values[yIndex]);
        const z = Number(values[zIndex]);
        if ([x, y, z].every(Number.isFinite)) {
          points.push([x, y, z]);
        }
      });
    } else {
      throw new Error(`unsupported_pcd_data_${header.data}`);
    }
    return {
      format: 'pcd',
      data: header.data,
      total_points: header.points,
      sampled_points: points.length,
      fields: header.fields,
      extent: summarizePreviewPoints(points),
      points
    };
  }

  function parseAsciiPlyPreview(text, maxPoints) {
    const lines = String(text || '').split(/\r?\n/);
    const endHeaderIndex = lines.findIndex((line) => line.trim() === 'end_header');
    if (endHeaderIndex < 0) {
      throw new Error('ply_header_not_found');
    }
    const headerLines = lines.slice(0, endHeaderIndex + 1);
    const formatLine = headerLines.find((line) => /^format\s+/i.test(line.trim()));
    if (!/format\s+ascii\s+1\.0/i.test(formatLine || '')) {
      throw new Error('unsupported_ply_format');
    }
    const vertexLine = headerLines.find((line) => /^element\s+vertex\s+/i.test(line.trim()));
    const totalPoints = Number(vertexLine?.trim().split(/\s+/)[2] || 0);
    const properties = [];
    let inVertex = false;
    for (const line of headerLines) {
      const parts = line.trim().split(/\s+/);
      if (parts[0] === 'element') {
        inVertex = parts[1] === 'vertex';
      } else if (inVertex && parts[0] === 'property' && parts.length >= 3) {
        properties.push(parts[2]);
      }
    }
    const xIndex = properties.indexOf('x');
    const yIndex = properties.indexOf('y');
    const zIndex = properties.indexOf('z');
    if (xIndex < 0 || yIndex < 0 || zIndex < 0) {
      throw new Error('ply_missing_xyz');
    }
    const stride = Math.max(1, Math.ceil(totalPoints / Math.max(1, maxPoints)));
    const points = [];
    const dataStart = endHeaderIndex + 1;
    const dataEnd = totalPoints > 0 ? Math.min(lines.length, dataStart + totalPoints) : lines.length;
    for (let lineIndex = dataStart; lineIndex < dataEnd; lineIndex += stride) {
      const row = lines[lineIndex]?.trim();
      if (!row) continue;
      const values = row.split(/\s+/);
      const x = Number(values[xIndex]);
      const y = Number(values[yIndex]);
      const z = Number(values[zIndex]);
      if ([x, y, z].every(Number.isFinite)) {
        points.push([x, y, z]);
      }
    }
    return {
      format: 'ply',
      total_points: totalPoints,
      sampled_points: points.length,
      extent: summarizePreviewPoints(points),
      points
    };
  }

  function qvecToRotmat(qvec) {
    const [qw, qx, qy, qz] = qvec.map(Number);
    return [
      [1 - 2 * qy * qy - 2 * qz * qz, 2 * qx * qy - 2 * qz * qw, 2 * qx * qz + 2 * qy * qw],
      [2 * qx * qy + 2 * qz * qw, 1 - 2 * qx * qx - 2 * qz * qz, 2 * qy * qz - 2 * qx * qw],
      [2 * qx * qz - 2 * qy * qw, 2 * qy * qz + 2 * qx * qw, 1 - 2 * qx * qx - 2 * qy * qy]
    ];
  }

  function cameraCenterFromImagePose(qvec, tvec) {
    const rotation = qvecToRotmat(qvec);
    return [
      -(rotation[0][0] * tvec[0] + rotation[1][0] * tvec[1] + rotation[2][0] * tvec[2]),
      -(rotation[0][1] * tvec[0] + rotation[1][1] * tvec[1] + rotation[2][1] * tvec[2]),
      -(rotation[0][2] * tvec[0] + rotation[1][2] * tvec[1] + rotation[2][2] * tvec[2])
    ];
  }

  function parseColmapImagesText(text) {
    const frames = [];
    const lines = String(text || '').split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const values = trimmed.split(/\s+/);
      if (values.length < 10) continue;
      const imageId = Number(values[0]);
      const qvec = values.slice(1, 5).map(Number);
      const tvec = values.slice(5, 8).map(Number);
      const cameraId = Number(values[8]);
      const name = values.slice(9).join(' ');
      if (!Number.isFinite(imageId) || qvec.some((value) => !Number.isFinite(value)) || tvec.some((value) => !Number.isFinite(value)) || !name) {
        continue;
      }
      frames.push({
        image_id: imageId,
        camera_id: cameraId,
        name,
        qvec,
        tvec,
        position: cameraCenterFromImagePose(qvec, tvec)
      });
      lineIndex += 1;
    }
    frames.sort((a, b) => a.image_id - b.image_id);
    return frames;
  }

  function resolveCurrentDatasetPath() {
    if (!state.dataset.prepared || !state.dataset.path) {
      const error = new Error('three_dgs_dataset_not_prepared');
      error.status = 404;
      throw error;
    }
    const datasetPath = path.resolve(state.dataset.path);
    const root = path.resolve(datasetRoot);
    if (datasetPath !== root && !datasetPath.startsWith(`${root}${path.sep}`)) {
      const error = new Error('three_dgs_dataset_path_outside_runtime');
      error.status = 400;
      throw error;
    }
    return datasetPath;
  }

  function cameraNameByColmapCameraId(summary) {
    const byId = new Map();
    for (const camera of Array.isArray(summary?.cameras) ? summary.cameras : []) {
      if (camera?.camera_id && camera?.name) {
        byId.set(Number(camera.camera_id), String(camera.name));
      }
    }
    return byId;
  }

  function cameraNameFromImageName(name, cameraId = '') {
    const stem = path.basename(String(name || ''));
    const matched = configuredCameraIds.find((camera) => new RegExp(`(^|_)${camera}(_|\\.)`, 'i').test(stem));
    return matched || (cameraId ? `camera${cameraId}` : '');
  }

  function captureKeyFromImageName(name, cameraName, imageId) {
    const stem = path.basename(String(name || '')).replace(/\.[^.]+$/, '');
    const groupMatch = stem.match(/(?:^|_)g([^_]+)(?:_|$)/);
    if (groupMatch?.[1]) {
      return groupMatch[1];
    }
    const knownCamera = cameraName || configuredCameraIds.find((camera) => stem.includes(camera)) || '';
    let key = stem;
    if (knownCamera) {
      key = key.replace(new RegExp(`(^|_)${knownCamera}(_|$)`, 'g'), '_');
    }
    const sourceIndex = key.match(/(\d{4,})/g)?.pop();
    return sourceIndex || String(imageId);
  }

  function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function timestampMsFromMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object') return null;
    const ns = finiteNumber(metadata.image_ts_ns);
    if (ns !== null) return ns / 1e6;
    const seconds = finiteNumber(metadata.image_ts_unix);
    if (seconds !== null) return seconds * 1000;
    return null;
  }

  function timestampIsoFromMs(timestampMs) {
    const number = finiteNumber(timestampMs);
    if (number === null) return null;
    try {
      return new Date(number).toISOString();
    } catch {
      return null;
    }
  }

  function frameSortValue(frame) {
    const timestamp = finiteNumber(frame.timestamp_ms);
    return timestamp !== null ? timestamp : Number(frame.image_id || 0);
  }

  async function readDatasetFrameMetadata(datasetPath) {
    const metadataPath = path.join(datasetPath, 'frame_metadata.json');
    if (!(await safeStat(metadataPath))) {
      return {
        path: metadataPath,
        available: false,
        frames: [],
        byImageId: new Map(),
        byName: new Map(),
        pose_interpolation: null
      };
    }
    const payload = JSON.parse(await fsp.readFile(metadataPath, 'utf8'));
    const records = Array.isArray(payload.frames) ? payload.frames : [];
    const byImageId = new Map();
    const byName = new Map();
    for (const record of records) {
      if (!record || typeof record !== 'object') continue;
      const imageId = Number(record.image_id);
      if (Number.isFinite(imageId)) byImageId.set(imageId, record);
      if (record.image_name) byName.set(String(record.image_name), record);
    }
    return {
      path: metadataPath,
      available: true,
      frames: records,
      byImageId,
      byName,
      pose_interpolation: payload.pose_interpolation || null
    };
  }

  function enrichFrameWithMetadata(frame, metadata) {
    const timestampMs = timestampMsFromMetadata(metadata);
    const poseTimestampMs = metadata?.pose_ts_ns
      ? Number(metadata.pose_ts_ns) / 1e6
      : metadata?.pose_ts_unix
        ? Number(metadata.pose_ts_unix) * 1000
        : null;
    return {
      ...frame,
      capture_key: metadata?.capture_key || frame.capture_key,
      source_index: metadata?.source_index ?? null,
      timestamp_ms: timestampMs,
      timestamp_iso: timestampIsoFromMs(timestampMs),
      pose_timestamp_ms: Number.isFinite(poseTimestampMs) ? poseTimestampMs : null,
      image_pose_delta_ms: finiteNumber(metadata?.image_pose_delta_ms),
      pose_source: metadata?.pose_source || null,
      pose_topic: metadata?.pose_topic || null,
      pose_mode: metadata?.pose_mode || null,
      pose_interpolation: metadata?.pose_interpolation || null,
      pose_interpolation_note: metadata?.pose_interpolation_note || null,
      metadata_available: Boolean(metadata)
    };
  }

  function summarizeFrameTrajectory(frames) {
    const ordered = [...frames].sort((a, b) => frameSortValue(a) - frameSortValue(b));
    let totalDistance = 0;
    let maxGap = 0;
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1].position;
      const current = ordered[index].position;
      const gap = Math.hypot(current[0] - previous[0], current[1] - previous[1], current[2] - previous[2]);
      totalDistance += gap;
      maxGap = Math.max(maxGap, gap);
    }
    return {
      frame_count: ordered.length,
      total_distance_m: totalDistance,
      avg_gap_m: ordered.length > 1 ? totalDistance / (ordered.length - 1) : 0,
      max_gap_m: maxGap,
      extent: summarizePreviewPoints(ordered.map((frame) => frame.position))
    };
  }

  function buildCameraTrajectories(frames) {
    const byCamera = new Map();
    for (const frame of frames) {
      const cameraName = frame.camera_name || `camera${frame.camera_id}`;
      if (!byCamera.has(cameraName)) byCamera.set(cameraName, []);
      byCamera.get(cameraName).push(frame);
    }
    return [...byCamera.entries()].map(([cameraName, items]) => {
      const ordered = items.sort((a, b) => frameSortValue(a) - frameSortValue(b));
      return {
        camera_name: cameraName,
        frames: ordered,
        summary: summarizeFrameTrajectory(ordered)
      };
    }).sort((a, b) => {
      const left = configuredCameraIds.indexOf(a.camera_name);
      const right = configuredCameraIds.indexOf(b.camera_name);
      return (left < 0 ? 99 : left) - (right < 0 ? 99 : right);
    });
  }

  function summarizeTrajectory(frames) {
    const perCamera = buildCameraTrajectories(frames);
    const representative = perCamera.find((item) => configuredCameraIds.includes(item.camera_name)) || perCamera[0] || null;
    const representativeSummary = representative?.summary || summarizeFrameTrajectory(frames);
    const allPoints = frames.map((frame) => frame.position);
    const maxGap = Math.max(0, ...perCamera.map((item) => Number(item.summary?.max_gap_m || 0)));
    return {
      frame_count: frames.length,
      total_distance_m: representativeSummary.total_distance_m || 0,
      avg_gap_m: representativeSummary.avg_gap_m || 0,
      max_gap_m: maxGap,
      representative_camera: representative?.camera_name || null,
      extent: summarizePreviewPoints(allPoints),
      per_camera: Object.fromEntries(perCamera.map((item) => [item.camera_name, item.summary]))
    };
  }

  function nearestFrameByTimestamp(frames, timestampMs) {
    if (!frames.length) return null;
    let best = null;
    for (const frame of frames) {
      const candidateTs = finiteNumber(frame.timestamp_ms);
      if (candidateTs === null) continue;
      const deltaMs = candidateTs - timestampMs;
      const absDeltaMs = Math.abs(deltaMs);
      if (!best || absDeltaMs < best.abs_delta_ms) {
        best = { frame, delta_ms: deltaMs, abs_delta_ms: absDeltaMs };
      }
    }
    return best;
  }

  function buildTimestampAlignedGroups(frames) {
    const timestamped = frames.filter((frame) => finiteNumber(frame.timestamp_ms) !== null);
    if (!timestamped.length) {
      return {
        mode: 'capture_key',
        groups: buildCaptureKeyTrajectoryGroups(frames),
        note: 'frame_metadata.json missing; falling back to capture_key grouping.'
      };
    }
    const byCamera = new Map();
    for (const frame of timestamped) {
      const cameraName = frame.camera_name || `camera${frame.camera_id}`;
      if (!byCamera.has(cameraName)) byCamera.set(cameraName, []);
      byCamera.get(cameraName).push(frame);
    }
    for (const items of byCamera.values()) {
      items.sort((a, b) => Number(a.timestamp_ms) - Number(b.timestamp_ms));
    }
    const orderedCameras = [
      ...configuredCameraIds.filter((cameraName) => byCamera.has(cameraName)),
      ...[...byCamera.keys()].filter((cameraName) => !configuredCameraIds.includes(cameraName))
    ];
    const anchorCamera = orderedCameras.includes('camera1') ? 'camera1' : orderedCameras[0];
    const anchors = (byCamera.get(anchorCamera) || timestamped).sort((a, b) => Number(a.timestamp_ms) - Number(b.timestamp_ms));
    const warningDeltaMs = Number(process.env.THREE_DGS_DATASET_ALIGN_WARN_DELTA_MS || 500);
    const groups = anchors.map((anchor, index) => {
      const timestampMs = Number(anchor.timestamp_ms);
      const groupFrames = [];
      for (const cameraName of orderedCameras) {
        const items = byCamera.get(cameraName) || [];
        const nearest = cameraName === anchor.camera_name
          ? { frame: anchor, delta_ms: 0, abs_delta_ms: 0 }
          : nearestFrameByTimestamp(items, timestampMs);
        if (!nearest) continue;
        groupFrames.push({
          ...nearest.frame,
          time_delta_ms: Number(nearest.delta_ms.toFixed(3)),
          abs_time_delta_ms: Number(nearest.abs_delta_ms.toFixed(3)),
          time_aligned: nearest.abs_delta_ms <= warningDeltaMs
        });
      }
      const maxDelta = Math.max(0, ...groupFrames.map((frame) => Number(frame.abs_time_delta_ms || 0)));
      return {
        key: `t${Math.round(timestampMs)}`,
        index,
        image_id: anchor.image_id,
        timestamp_ms: timestampMs,
        timestamp_iso: timestampIsoFromMs(timestampMs),
        anchor_camera: anchor.camera_name,
        max_time_delta_ms: Number(maxDelta.toFixed(3)),
        time_sync_warning: maxDelta > warningDeltaMs,
        position: anchor.position,
        frames: groupFrames.sort((a, b) => {
          const left = configuredCameraIds.indexOf(a.camera_name);
          const right = configuredCameraIds.indexOf(b.camera_name);
          return (left < 0 ? 99 : left) - (right < 0 ? 99 : right);
        })
      };
    });
    return {
      mode: 'timestamp_nearest',
      anchor_camera: anchorCamera,
      warning_delta_ms: warningDeltaMs,
      groups,
      note: 'Camera streams are displayed by nearest image timestamp. Each image keeps its own pose.'
    };
  }

  function buildCaptureKeyTrajectoryGroups(frames) {
    const byKey = new Map();
    for (const frame of frames) {
      const key = frame.capture_key || String(frame.image_id);
      if (!byKey.has(key)) {
        byKey.set(key, []);
      }
      byKey.get(key).push(frame);
    }
    return [...byKey.entries()].map(([key, groupFrames], index) => {
      const position = groupFrames[0]?.position || [0, 0, 0];
      const imageIds = groupFrames.map((frame) => Number(frame.image_id)).filter(Number.isFinite);
      return {
        key,
        index,
        image_id: imageIds.length ? Math.min(...imageIds) : index,
        position,
        frames: groupFrames.sort((a, b) => String(a.camera_name || '').localeCompare(String(b.camera_name || '')))
      };
    }).sort((a, b) => Number(a.image_id || 0) - Number(b.image_id || 0));
  }

  async function buildDatasetInspection(maxPoints = 20000) {
    const datasetPath = resolveCurrentDatasetPath();
    const sparsePath = path.join(datasetPath, 'sparse', '0');
    const imagesPath = path.join(sparsePath, 'images.txt');
    const pointcloudPath = path.join(sparsePath, 'points3D.ply');
    const imagesDir = path.join(datasetPath, 'images');
    const [imagesText, pointcloudText, imageDirStat] = await Promise.all([
      fsp.readFile(imagesPath, 'utf8'),
      fsp.readFile(pointcloudPath, 'utf8'),
      safeStat(imagesDir)
    ]);
    const pointcloud = parseAsciiPlyPreview(pointcloudText, maxPoints);
    const summary = state.dataset.summary || null;
    const cameraNameById = cameraNameByColmapCameraId(summary);
    const frameMetadata = await readDatasetFrameMetadata(datasetPath);
    const frames = parseColmapImagesText(imagesText).map((frame) => {
      const cameraName = cameraNameById.get(Number(frame.camera_id)) || configuredCameraIds.find((camera) => frame.name.includes(camera)) || `camera${frame.camera_id}`;
      const fallbackFrame = {
        ...frame,
        camera_name: cameraName,
        capture_key: captureKeyFromImageName(frame.name, cameraName, frame.image_id),
        image_url: `/api/three-dgs/dataset/image/${encodeURIComponent(frame.name)}`
      };
      const metadata = frameMetadata.byImageId.get(Number(frame.image_id)) || frameMetadata.byName.get(frame.name) || null;
      return enrichFrameWithMetadata(fallbackFrame, metadata);
    });
    const cameraTrajectories = buildCameraTrajectories(frames);
    const grouping = buildTimestampAlignedGroups(frames);
    return {
      dataset: {
        scene_name: state.dataset.scene_name,
        path: datasetPath,
        summary,
        images_dir_exists: Boolean(imageDirStat),
        frame_metadata: {
          available: frameMetadata.available,
          path: frameMetadata.path,
          frame_count: frameMetadata.frames.length,
          pose_interpolation: frameMetadata.pose_interpolation
        }
      },
      pointcloud,
      trajectory: {
        summary: summarizeTrajectory(frames),
        frames,
        by_camera: cameraTrajectories,
        grouping: {
          mode: grouping.mode,
          anchor_camera: grouping.anchor_camera || null,
          warning_delta_ms: grouping.warning_delta_ms || null,
          note: grouping.note || ''
        },
        groups: grouping.groups
      },
      checks: {
        image_count_matches: !summary?.image_count || Number(summary.image_count) === frames.length,
        point_count_matches: !summary?.point_count || Number(summary.point_count) === Number(pointcloud.total_points),
        has_images_dir: Boolean(imageDirStat),
        has_sparse_files: true,
        has_frame_metadata: frameMetadata.available
      }
    };
  }

  function roundViewerNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Number(number.toFixed(4)) : 0;
  }

  function roundViewerVector(values) {
    return values.map(roundViewerNumber);
  }

  function finiteViewerVector(values) {
    if (!Array.isArray(values) || values.length !== 3) return null;
    const vector = values.map(Number);
    return vector.every(Number.isFinite) ? vector : null;
  }

  function clampViewerFov(value, fallback = 68) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(20, Math.min(110, number));
  }

  function normalizeViewerCameraPayload(payload, auth) {
    const body = payload?.camera_state && typeof payload.camera_state === 'object'
      ? payload.camera_state
      : payload || {};
    const position = finiteViewerVector(body.position);
    const focus = finiteViewerVector(body.focus || body.target);
    if (!position || !focus) {
      const error = new Error('viewer_camera_position_focus_required');
      error.status = 400;
      throw error;
    }
    const angles = finiteViewerVector(body.angles);
    const distance = Number(body.distance);
    return {
      position: roundViewerVector(position),
      focus: roundViewerVector(focus),
      fov: roundViewerNumber(clampViewerFov(body.fov)),
      angles: angles ? roundViewerVector(angles) : null,
      distance: Number.isFinite(distance) ? roundViewerNumber(distance) : null,
      mode: body.mode ? String(body.mode).slice(0, 32) : null,
      source: 'operator_viewer_camera',
      run_id: state.viewer?.run_id || null,
      dataset_scene_name: state.dataset?.scene_name || null,
      saved_by: auth?.username || null,
      saved_at_ms: Date.now()
    };
  }

  function currentManualViewerCamera() {
    const manual = state.viewer_camera?.manual || null;
    if (manual?.run_id && state.viewer?.run_id && manual.run_id !== state.viewer.run_id) {
      return null;
    }
    if (manual?.dataset_scene_name && state.dataset?.scene_name && manual.dataset_scene_name !== state.dataset.scene_name) {
      return null;
    }
    const position = finiteViewerVector(manual?.position);
    const focus = finiteViewerVector(manual?.focus || manual?.target);
    if (!position || !focus) return null;
    return {
      ...manual,
      position,
      focus,
      fov: clampViewerFov(manual?.fov, 68)
    };
  }

  function makeSuperSplatSettings(initialCamera, source = 'fallback', overrides = {}) {
    return {
      version: 2,
      tonemapping: 'linear',
      highPrecisionRendering: false,
      background: {
        color: [0.02, 0.03, 0.05]
      },
      postEffectSettings: {
        sharpness: { enabled: false, amount: 0 },
        bloom: { enabled: false, intensity: 0.1, blurLevel: 2 },
        grading: {
          enabled: false,
          brightness: 1,
          contrast: 1,
          saturation: 1,
          tint: [1, 1, 1]
        },
        vignette: {
          enabled: false,
          intensity: 0.5,
          inner: 0.3,
          outer: 0.75,
          curvature: 1
        },
        fringing: { enabled: false, intensity: 0.5 }
      },
      cameras: [
        {
          initial: initialCamera || {
            position: [0, 2, -5],
            target: [0, 0, 0],
            fov: 75
          }
        }
      ],
      animTracks: Array.isArray(overrides.animTracks) ? overrides.animTracks : [],
      annotations: [],
      startMode: overrides.startMode || 'default',
      jgzj: {
        source,
        generated_at_ms: Date.now()
      }
    };
  }

  function normalizeVector(values, fallback = [1, 0, 0]) {
    const length = Math.hypot(Number(values[0] || 0), Number(values[1] || 0), Number(values[2] || 0));
    if (length < 0.001) {
      return fallback;
    }
    return [values[0] / length, values[1] / length, values[2] / length];
  }

  function cameraForwardFromQvec(qvec) {
    const rotation = qvecToRotmat(qvec);
    return normalizeVector([
      viewerCameraForwardSign * rotation[2][0],
      viewerCameraForwardSign * rotation[2][1],
      viewerCameraForwardSign * rotation[2][2]
    ]);
  }

  function viewerLookDistanceFromExtent(extent) {
    const spanX = Math.abs(extent.max_x - extent.min_x);
    const spanY = Math.abs(extent.max_y - extent.min_y);
    const spanZ = Math.abs(extent.max_z - extent.min_z);
    return Math.max(2, Math.min(12, Math.hypot(spanX, spanY, spanZ) * 0.18));
  }

  function cameraOpticalTarget(frame, lookDistance) {
    const forward = cameraForwardFromQvec(frame.qvec);
    return [
      frame.position[0] + forward[0] * lookDistance,
      frame.position[1] + forward[1] * lookDistance,
      frame.position[2] + forward[2] * lookDistance
    ];
  }

  function sampleFrameIndices(frameCount, maxKeyframes) {
    if (frameCount <= 0) return [];
    const limit = Math.max(2, Math.min(frameCount, maxKeyframes));
    if (frameCount <= limit) {
      return new Array(frameCount).fill(0).map((_, index) => index);
    }
    const indices = [];
    for (let index = 0; index < limit; index += 1) {
      indices.push(Math.round((index / (limit - 1)) * (frameCount - 1)));
    }
    return [...new Set(indices)];
  }

  function addVectorOffset(vector, offset) {
    return [
      vector[0] + offset[0],
      vector[1] + offset[1],
      vector[2] + offset[2]
    ];
  }

  function makeVehicleTrajectoryTrack(frames, extent, fov = 68, anchorCamera = null) {
    const maxKeyframes = Number(process.env.THREE_DGS_VIEWER_ANIM_MAX_KEYFRAMES || 160);
    const indices = sampleFrameIndices(frames.length, maxKeyframes);
    if (indices.length < 2) {
      return null;
    }
    const lookDistance = viewerLookDistanceFromExtent(extent);
    const firstFrame = frames[indices[0]];
    const firstTarget = cameraOpticalTarget(firstFrame, lookDistance);
    const positionOffset = anchorCamera
      ? [
          anchorCamera.position[0] - firstFrame.position[0],
          anchorCamera.position[1] - firstFrame.position[1],
          anchorCamera.position[2] - firstFrame.position[2]
        ]
      : [0, 0, 0];
    const targetOffset = anchorCamera
      ? [
          anchorCamera.focus[0] - firstTarget[0],
          anchorCamera.focus[1] - firstTarget[1],
          anchorCamera.focus[2] - firstTarget[2]
        ]
      : [0, 0, 0];
    const trackFov = clampViewerFov(anchorCamera?.fov, fov);
    const duration = Math.max(12, Math.min(45, frames.length / 8));
    const times = indices.map((_, index) => (index / Math.max(1, indices.length - 1)) * duration);
    const positions = [];
    const targets = [];
    const fovs = [];

    for (const frameIndex of indices) {
      const frame = frames[frameIndex];
      const position = addVectorOffset(frame.position, positionOffset);
      const target = addVectorOffset(cameraOpticalTarget(frame, lookDistance), targetOffset);
      positions.push(...roundViewerVector(position));
      targets.push(...roundViewerVector(target));
      fovs.push(trackFov);
    }

    return {
      name: 'vehicle-camera-trajectory',
      duration: roundViewerNumber(duration),
      frameRate: 1,
      loopMode: 'none',
      interpolation: 'spline',
      smoothness: 0.35,
      keyframes: {
        times: times.map(roundViewerNumber),
        values: {
          position: positions,
          target: targets,
          fov: fovs
        }
      },
      jgzj: {
        source: 'colmap_images_txt',
        original_frame_count: frames.length,
        keyframe_count: indices.length,
        look_distance_m: roundViewerNumber(lookDistance),
        camera_forward_sign: viewerCameraForwardSign,
        camera_forward_axis: viewerCameraForwardSign > 0 ? '+camera_z' : '-camera_z',
        anchored_to_manual_viewer_camera: Boolean(anchorCamera),
        position_offset: roundViewerVector(positionOffset),
        target_offset: roundViewerVector(targetOffset)
      }
    };
  }

  async function buildTrajectoryViewerCamera() {
    const datasetPath = resolveCurrentDatasetPath();
    const imagesPath = path.join(datasetPath, 'sparse', '0', 'images.txt');
    const allFrames = parseColmapImagesText(await fsp.readFile(imagesPath, 'utf8')).map((frame) => ({
      ...frame,
      camera_name: cameraNameFromImageName(frame.name, frame.camera_id)
    }));
    if (!allFrames.length) {
      throw new Error('three_dgs_dataset_has_no_camera_frames');
    }
    const trajectoryCamera = String(process.env.THREE_DGS_VIEWER_TRAJECTORY_CAMERA || 'camera1').trim() || 'camera1';
    const selectedFrames = allFrames.filter((frame) => frame.camera_name === trajectoryCamera);
    const frames = selectedFrames.length >= 2 ? selectedFrames : allFrames;

    const positions = frames.map((frame) => frame.position);
    const extent = summarizePreviewPoints(positions);
    const target = [
      (extent.min_x + extent.max_x) / 2,
      (extent.min_y + extent.max_y) / 2,
      (extent.min_z + extent.max_z) / 2
    ];

    const firstFrame = frames[0];
    const lookDistance = viewerLookDistanceFromExtent(extent);
    const firstCameraTarget = cameraOpticalTarget(firstFrame, lookDistance);
    const manualCamera = currentManualViewerCamera();
    const start = positions[0];
    const end = positions[positions.length - 1];
    let directionX = end[0] - start[0];
    let directionY = end[1] - start[1];
    let pathLength = Math.hypot(directionX, directionY);
    if (pathLength < 0.001) {
      directionX = 1;
      directionY = 0;
      pathLength = 1;
    }
    directionX /= pathLength;
    directionY /= pathLength;

    const spanX = Math.abs(extent.max_x - extent.min_x);
    const spanY = Math.abs(extent.max_y - extent.min_y);
    const spanZ = Math.abs(extent.max_z - extent.min_z);
    const horizontalSpan = Math.max(spanX, spanY, Math.hypot(spanX, spanY));
    const distance = Math.max(6, horizontalSpan * 0.75, spanZ * 5);
    const sideX = -directionY;
    const sideY = directionX;
    const height = Math.max(3, distance * 0.35, spanZ * 2);

    return {
      position: roundViewerVector(manualCamera?.position || firstFrame.position),
      target: roundViewerVector(manualCamera?.focus || firstCameraTarget),
      fov: clampViewerFov(manualCamera?.fov, 68),
      frame_count: frames.length,
      all_frame_count: allFrames.length,
      trajectory_camera: selectedFrames.length >= 2 ? trajectoryCamera : 'all',
      anim_track: makeVehicleTrajectoryTrack(frames, extent, 68, manualCamera),
      first_camera_forward: roundViewerVector(cameraForwardFromQvec(firstFrame.qvec)),
      manual_camera: manualCamera
        ? {
            position: roundViewerVector(manualCamera.position),
            focus: roundViewerVector(manualCamera.focus),
            fov: roundViewerNumber(manualCamera.fov),
            run_id: manualCamera.run_id || null,
            saved_at_ms: manualCamera.saved_at_ms || null,
            saved_by: manualCamera.saved_by || null
          }
        : null,
      overview_camera: {
        position: roundViewerVector([
          target[0] + sideX * distance,
          target[1] + sideY * distance,
          target[2] + height
        ]),
        target: roundViewerVector(target)
      },
      extent: {
        min_x: roundViewerNumber(extent.min_x),
        max_x: roundViewerNumber(extent.max_x),
        min_y: roundViewerNumber(extent.min_y),
        max_y: roundViewerNumber(extent.max_y),
        min_z: roundViewerNumber(extent.min_z),
        max_z: roundViewerNumber(extent.max_z)
      }
    };
  }

  async function buildViewerSettings() {
    try {
      const camera = await buildTrajectoryViewerCamera();
      const settings = makeSuperSplatSettings({
        position: camera.position,
        target: camera.target,
        fov: camera.fov
      }, 'trajectory', camera.anim_track ? {
        animTracks: [camera.anim_track],
        startMode: 'animTrack'
      } : {});
      settings.jgzj.frame_count = camera.frame_count;
      settings.jgzj.all_frame_count = camera.all_frame_count;
      settings.jgzj.trajectory_camera = camera.trajectory_camera;
      settings.jgzj.animation = camera.anim_track?.jgzj || null;
      settings.jgzj.first_camera_forward = camera.first_camera_forward;
      settings.jgzj.manual_camera = camera.manual_camera;
      settings.jgzj.extent = camera.extent;
      return settings;
    } catch (error) {
      const settings = makeSuperSplatSettings(null, 'fallback');
      settings.jgzj.error = error.message || 'viewer_settings_fallback';
      return settings;
    }
  }

  function sanitizeSceneName(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
  }

  function makeRunId(sceneName = '') {
    const scene = sanitizeSceneName(sceneName) || 'scene';
    const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
    return `${scene}-${ts}-${crypto.randomBytes(3).toString('hex')}`;
  }

  async function getAuth(req, options = {}) {
    if (!authStore) {
      return null;
    }
    return authStore.getAuthFromRequest(req, options);
  }

  async function requireThreeDgsAuth(req, res, next) {
    if (!authStore) {
      req.threeDgsAuth = { username: 'local' };
      return next();
    }
    const auth = await authStore.ensureRequestPermission(req, res, 'three-dgs:run');
    if (!auth) {
      return undefined;
    }
    req.threeDgsAuth = auth;
    return next();
  }

  function resolveThreeDgsVehicleId(value, fallback = defaultVehicleId) {
    const vehicleId = String(value || fallback || '').trim();
    if (!vehicleId) {
      const error = new Error('vehicle_id_required');
      error.status = 400;
      throw error;
    }
    if (allowedVehicleIds.length && !allowedVehicleIds.includes(vehicleId)) {
      const error = new Error('three_dgs_vehicle_not_enabled');
      error.status = 400;
      error.vehicle_id = vehicleId;
      error.allowed_vehicle_ids = allowedVehicleIds;
      throw error;
    }
    return vehicleId;
  }

  function vehicleErrorBody(error) {
    return {
      ok: false,
      error: error.message || 'vehicle_id_invalid',
      vehicle_id: error.vehicle_id || null,
      allowed_vehicle_ids: error.allowed_vehicle_ids || allowedVehicleIds
    };
  }

  function statusAuthPayload(auth) {
    return {
      authenticated: Boolean(auth),
      username: auth?.username || null,
      permissions: auth?.user?.effective_permissions || []
    };
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(options.timeoutMs || cloudAgentTimeoutMs)
    });
    const raw = await response.text();
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch (_error) {
      payload = { raw };
    }
    if (!response.ok) {
      const error = new Error(payload?.error || payload?.detail || raw || `HTTP ${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  async function listVehicles() {
    const payload = await fetchJson(new URL('/api/vehicles', cloudAgentBaseUrl).toString(), {
      timeoutMs: 8000
    });
    return Array.isArray(payload?.vehicles) ? payload.vehicles : [];
  }

  async function getVehicleConnection(vehicleId, timeoutMs = 3000) {
    return fetchJson(new URL(`/api/vehicles/${encodeURIComponent(vehicleId)}`, cloudAgentBaseUrl).toString(), {
      timeoutMs
    });
  }

  async function enqueueVehicleToolCall(vehicleId, task) {
    const key = String(vehicleId || '');
    const previous = vehicleToolQueues.get(key) || Promise.resolve();
    const queued = previous.catch(() => {}).then(task);
    const cleanup = queued.finally(() => {
      if (vehicleToolQueues.get(key) === cleanup) {
        vehicleToolQueues.delete(key);
      }
    }).catch(() => {});
    vehicleToolQueues.set(key, cleanup);
    return queued;
  }

  async function callVehicleTool(vehicleId, tool, args = {}, timeoutS = 30) {
    return enqueueVehicleToolCall(vehicleId, async () => {
      const endpoint = new URL(`/api/vehicles/${encodeURIComponent(vehicleId)}/tools/${encodeURIComponent(tool)}`, cloudAgentBaseUrl).toString();
      return fetchJson(endpoint, {
        method: 'POST',
        timeoutMs: Math.max(timeoutS * 1000 + 5000, cloudAgentTimeoutMs),
        body: {
          args,
          timeout_s: timeoutS
        }
      });
    });
  }

  function unwrapToolPayload(payload) {
    return payload?.response?.result ?? payload?.response?.data ?? payload?.result ?? payload?.data ?? payload?.response ?? payload;
  }

  function normalizeCapabilities(rawCapabilities, vehicleId) {
    const result = unwrapToolPayload(rawCapabilities);
    const rawCameras = result?.cameras || result?.camera_capabilities || result?.capabilities || result?.camera_status || {};
    const byId = {};

    if (Array.isArray(rawCameras)) {
      rawCameras.forEach((item) => {
        const id = String(item?.camera || item?.camera_id || item?.id || item?.name || '').trim();
        if (!id) return;
        byId[id] = item || {};
      });
    } else if (rawCameras && typeof rawCameras === 'object') {
      Object.entries(rawCameras).forEach(([id, value]) => {
        byId[String(id)] = value && typeof value === 'object' ? value : { enabled: Boolean(value) };
      });
    }

    return configuredCameraIds.map((cameraId) => {
      const item = byId[cameraId] || {};
      const fallbackEnabled = vehicleId === defaultVehicleId && fallbackCalibratedCameras.includes(cameraId);
      const hasExplicitEnabled = Object.prototype.hasOwnProperty.call(item, 'enabled');
      const enabled = hasExplicitEnabled ? Boolean(item.enabled) : fallbackEnabled;
      const reason = String(
        item.reason || item.disabled_reason || item.error || (enabled ? 'formal_camera_lidar_calibration_available' : 'formal_camera_lidar_calibration_missing')
      );
      return {
        camera: cameraId,
        enabled,
        reason,
        raw: item
      };
    });
  }

  function multiCameraStartSupported(rawCapabilities) {
    const result = unwrapToolPayload(rawCapabilities);
    return Boolean(
      result?.multi_camera_start_supported ||
      result?.multi_camera_supported ||
      result?.supports_multi_camera_start ||
      result?.start_all_supported
    );
  }

  async function getCaptureCapabilities(vehicleId, timeoutS = 20) {
    try {
      const capabilities = await callVehicleTool(vehicleId, '3dgs.capture.capabilities', {}, timeoutS);
      return {
        ok: true,
        raw: capabilities,
        cameras: normalizeCapabilities(capabilities, vehicleId),
        multi_camera_start_supported: multiCameraStartSupported(capabilities)
      };
    } catch (error) {
      const cameras = normalizeCapabilities(null, vehicleId);
      return {
        ok: false,
        error: error?.message || 'capabilities_unavailable',
        raw: null,
        cameras,
        multi_camera_start_supported: false
      };
    }
  }

  function normalizeSession(payload) {
    const result = unwrapToolPayload(payload);
    return result?.session || result?.active_session || result?.capture_session || result?.data?.session || result || {};
  }

  function enabledCameraIdsFromCapabilities(capabilities) {
    return (capabilities?.cameras || [])
      .filter((item) => item?.enabled)
      .map((item) => item.camera)
      .filter(Boolean);
  }

  function activeCaptureCameras(fallbackCapabilities = null) {
    if (Array.isArray(state.capture.cameras) && state.capture.cameras.length) {
      return state.capture.cameras;
    }
    const fromCapabilities = enabledCameraIdsFromCapabilities(fallbackCapabilities);
    if (fromCapabilities.length) {
      return fromCapabilities;
    }
    return fallbackCalibratedCameras;
  }

  function numericCaptureCount(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  function savedFramesFromSession(session) {
    return Math.max(
      numericCaptureCount(session?.counts?.saved_frames),
      numericCaptureCount(session?.saved_frames),
      numericCaptureCount(session?.image_count),
      numericCaptureCount(session?.frame_count),
      numericCaptureCount(session?.records_count)
    );
  }

  function activeValueFromSession(session) {
    if (session && Object.prototype.hasOwnProperty.call(session, 'active')) return Boolean(session.active);
    if (session && Object.prototype.hasOwnProperty.call(session, 'running')) return Boolean(session.running);
    const status = String(session?.status || session?.state || session?.phase || '').toLowerCase();
    if (['active', 'capturing', 'running', 'started'].includes(status)) return true;
    if (['inactive', 'idle', 'stopped', 'completed', 'finished', 'error'].includes(status)) return false;
    return null;
  }

  function sessionIdFromSession(session) {
    return session?.session_id || session?.id || session?.capture_session_id || session?.session?.session_id || session?.session?.id || null;
  }

  function usableMultiCameraSessionId(value) {
    const text = String(value || '').trim();
    if (!text || text.includes(',')) return '';
    if (/^camera\d+$/i.test(text)) return '';
    return text;
  }

  function sessionIdFromChildSessionPaths(childSessions = {}) {
    const children = childSessions && typeof childSessions === 'object' ? Object.values(childSessions) : [];
    for (const child of children) {
      const sessionDir = String(child?.paths?.session_dir || child?.session_dir || '').trim();
      if (!sessionDir) continue;
      const parent = path.basename(path.dirname(sessionDir));
      const usable = usableMultiCameraSessionId(parent);
      if (usable) return usable;
    }
    return '';
  }

  function sessionIdFromImagePoseUploadName() {
    const name = String(state.vehicle_uploads?.image_pose?.file_name || '').trim();
    const match = name.match(/image_pose_[^_]+_(.+)\.(?:tar\.gz|tgz|zip|gz)$/i);
    return usableMultiCameraSessionId(match?.[1]);
  }

  function resolveMultiCameraPackageSessionId(payload = {}) {
    return uniqueStrings([
      payload.session_id,
      usableMultiCameraSessionId(state.capture.session_id),
      sessionIdFromChildSessionPaths(state.capture.child_sessions),
      sessionIdFromImagePoseUploadName()
    ]).map(usableMultiCameraSessionId).find(Boolean) || '';
  }

  function childSessionEntries(session) {
    const raw = session?.child_sessions || session?.children || session?.camera_sessions || session?.sessions || null;
    if (Array.isArray(raw)) {
      return raw
        .map((item) => {
          const camera = String(item?.camera || item?.camera_id || item?.name || '').trim();
          return camera ? { camera, session: item } : null;
        })
        .filter(Boolean);
    }
    if (raw && typeof raw === 'object') {
      return Object.entries(raw)
        .map(([camera, value]) => ({ camera, session: value && typeof value === 'object' ? value : { session_id: value } }))
        .filter((item) => item.camera);
    }
    return [];
  }

  function sessionIdsFromChildSessions(session, cameras = []) {
    const sessionIds = {};
    for (const { camera, session: child } of childSessionEntries(session)) {
      const id = sessionIdFromSession(child);
      if (camera && id) {
        sessionIds[camera] = id;
      }
    }
    const parentId = sessionIdFromSession(session);
    if (parentId) {
      for (const camera of cameras) {
        if (!sessionIds[camera]) {
          sessionIds[camera] = parentId;
        }
      }
    }
    return sessionIds;
  }

  function uniqueStrings(values) {
    return [...new Set((values || []).flatMap((value) => String(value || '').split(',')).map((item) => item.trim()).filter(Boolean))];
  }

  function sessionIdMatchesCamera(camera, sessionId) {
    const value = String(sessionId || '');
    if (!value) return false;
    const taggedCamera = configuredCameraIds.find((cameraId) => value.includes(cameraId));
    return !taggedCamera || taggedCamera === camera;
  }

  function captureSessionIdForCamera(camera, payload = {}, includeShared = false) {
    const candidates = uniqueStrings([
      payload.session_ids?.[camera],
      payload.sessions?.[camera],
      payload[`${camera}_session_id`],
      includeShared ? payload.session_id : null,
      state.capture.session_ids?.[camera],
      includeShared ? state.capture.session_id : null
    ]);
    return candidates.find((sessionId) => sessionIdMatchesCamera(camera, sessionId)) || '';
  }

  function normalizeCaptureStatusEntry(camera, payload, error = null) {
    const session = error ? {} : normalizeSession(payload);
    const activeValue = error ? null : activeValueFromSession(session);
    return {
      camera,
      ok: !error,
      active: activeValue,
      mode: error ? null : session?.mode || session?.capture_mode || null,
      session_id: error ? state.capture.session_ids?.[camera] || null : sessionIdFromSession(session),
      saved_frames: error ? 0 : savedFramesFromSession(session),
      counts: error ? null : session?.counts || null,
      child_sessions: error ? null : session?.child_sessions || session?.children || session?.camera_sessions || session?.sessions || null,
      shared_context: error ? null : session?.shared_context || null,
      last: error ? null : session?.last || null,
      status: error ? 'error' : session?.status || session?.state || session?.phase || null,
      error: error ? error.message || 'capture_status_failed' : null,
      checked_at_ms: Date.now()
    };
  }

  function normalizeCaptureStatusEntryFromSession(camera, session, error = null) {
    const activeValue = error ? null : activeValueFromSession(session);
    return {
      camera,
      ok: !error,
      active: activeValue,
      mode: error ? null : session?.mode || session?.capture_mode || null,
      session_id: error ? state.capture.session_ids?.[camera] || null : sessionIdFromSession(session),
      saved_frames: error ? 0 : savedFramesFromSession(session),
      counts: error ? null : session?.counts || null,
      child_sessions: error ? null : session?.child_sessions || session?.children || session?.camera_sessions || session?.sessions || null,
      shared_context: error ? null : session?.shared_context || null,
      last: error ? null : session?.last || null,
      status: error ? 'error' : session?.status || session?.state || session?.phase || null,
      error: error ? error.message || 'capture_status_failed' : null,
      checked_at_ms: Date.now()
    };
  }

  async function readVehicleCaptureStatuses(vehicleId, cameras, options = {}) {
    const statuses = [];
    const rawStatuses = [];
    const allowPartial = options.allowPartial !== false;
    if (options.multiCamera) {
      try {
        const status = await callVehicleTool(vehicleId, '3dgs.capture.status', {}, options.timeoutS || 20);
        const session = normalizeSession(status);
        const children = childSessionEntries(session);
        if (children.length) {
          const childByCamera = new Map(children.map((item) => [item.camera, item.session]));
          for (const camera of cameras) {
            const child = childByCamera.get(camera);
            statuses.push(child
              ? normalizeCaptureStatusEntryFromSession(camera, child)
              : normalizeCaptureStatusEntryFromSession(camera, {}, new Error('camera_child_session_missing')));
          }
        } else {
          const camera = session?.camera || session?.camera_id || 'all';
          statuses.push(normalizeCaptureStatusEntryFromSession(camera, session));
        }
        rawStatuses.push({ camera: 'all', response: status, session });
        return { statuses, rawStatuses, aggregateSession: session };
      } catch (error) {
        if (!allowPartial) {
          throw error;
        }
        statuses.push(normalizeCaptureStatusEntry('all', null, error));
        rawStatuses.push({
          camera: 'all',
          error: error.message || 'capture_status_failed'
        });
        return { statuses, rawStatuses, aggregateSession: null };
      }
    }
    for (const camera of cameras) {
      try {
        const status = await callVehicleTool(vehicleId, '3dgs.capture.status', { camera }, options.timeoutS || 20);
        const session = normalizeSession(status);
        statuses.push(normalizeCaptureStatusEntry(camera, status));
        rawStatuses.push({ camera, response: status, session });
      } catch (error) {
        if (!allowPartial) {
          throw error;
        }
        statuses.push(normalizeCaptureStatusEntry(camera, null, error));
        rawStatuses.push({
          camera,
          error: error.message || 'capture_status_failed'
        });
      }
    }
    return { statuses, rawStatuses };
  }

  function mergeSessionIds(cameraStatuses) {
    const sessionIds = { ...(state.capture.session_ids || {}) };
    for (const item of cameraStatuses) {
      if (item?.camera && item?.session_id) {
        sessionIds[item.camera] = item.session_id;
      }
    }
    return sessionIds;
  }

  function aggregateCaptureActivity(cameraStatuses) {
    const explicit = cameraStatuses.map((item) => item.active).filter((value) => typeof value === 'boolean');
    if (!explicit.length) return state.capture.active;
    return explicit.some(Boolean);
  }

  function aggregateCaptureFrames(cameraStatuses) {
    const savedFrames = cameraStatuses.reduce((total, item) => total + numericCaptureCount(item.saved_frames), 0);
    return Math.max(savedFrames, numericCaptureCount(state.capture.saved_frames));
  }

  async function updateCaptureStatusFromVehicle(vehicleId, options = {}) {
    const cameras = options.cameras || activeCaptureCameras();
    const { statuses, rawStatuses, aggregateSession } = await readVehicleCaptureStatuses(vehicleId, cameras, {
      allowPartial: options.allowPartial !== false,
      timeoutS: options.timeoutS || 20,
      multiCamera: Boolean(options.multiCamera ?? state.capture.multi_camera)
    });
    const sessionIds = aggregateSession
      ? { ...mergeSessionIds(statuses), ...sessionIdsFromChildSessions(aggregateSession, cameras) }
      : mergeSessionIds(statuses);
    const sessionIdList = uniqueStrings(Object.values(sessionIds));
    const parentSessionId = aggregateSession ? sessionIdFromSession(aggregateSession) : '';
    const childSessions = aggregateSession
      ? Object.fromEntries(childSessionEntries(aggregateSession).map((item) => [item.camera, item.session]))
      : state.capture.child_sessions;
    const pathSessionId = sessionIdFromChildSessionPaths(childSessions);
    const nextSessionId = parentSessionId ||
      (state.capture.multi_camera ? usableMultiCameraSessionId(state.capture.session_id) || pathSessionId : '') ||
      (sessionIdList.length === 1 ? sessionIdList[0] : sessionIdList.join(',')) ||
      state.capture.session_id ||
      null;
    const active = aggregateCaptureActivity(statuses);
    const errorText = statuses
      .filter((item) => item.error)
      .map((item) => item.camera === 'all' ? item.error : `${item.camera}:${item.error}`)
      .join('; ');
    updateNestedState('capture', {
      vehicle_id: vehicleId,
      active,
      cameras,
      session_id: nextSessionId,
      session_ids: sessionIds,
      child_sessions: childSessions,
      saved_frames: Math.max(savedFramesFromSession(aggregateSession), aggregateCaptureFrames(statuses)),
      camera_statuses: statuses,
      last_monitor_ms: Date.now(),
      monitor_error: errorText || null,
      ...(options.persistLastResponse ? { last_response: { statuses: rawStatuses } } : {})
    });
    if (state.phase === 'capturing' && state.capture.active === false) {
      updateState({
        phase: state.dataset.prepared ? 'prepared' : 'idle',
        stage_text: '长连接监控到车端 3DGS 采集已停止。'
      });
    }
    return { statuses, rawStatuses };
  }

  function compactCaptureForStream() {
    return {
      vehicle_id: state.capture.vehicle_id,
      active: state.capture.active,
      multi_camera: state.capture.multi_camera,
      session_id: state.capture.session_id,
      session_ids: state.capture.session_ids,
      child_sessions: state.capture.child_sessions,
      cameras: state.capture.cameras,
      saved_frames: state.capture.saved_frames,
      camera_statuses: state.capture.camera_statuses,
      started_at_ms: state.capture.started_at_ms,
      stopped_at_ms: state.capture.stopped_at_ms,
      last_monitor_ms: state.capture.last_monitor_ms,
      monitor_error: state.capture.monitor_error
    };
  }

  function captureStreamPayload(extra = {}) {
    return {
      ok: true,
      ts_ms: Date.now(),
      phase: state.phase,
      stage_text: normalizeThreeDgsStageText(state.stage_text),
      capture: compactCaptureForStream(),
      uploads: state.uploads,
      vehicle_uploads: state.vehicle_uploads,
      ...extra
    };
  }

  function writeCaptureStreamEvent(client, event, data) {
    try {
      client.res.write(`event: ${event}\n`);
      const payload = JSON.stringify(data);
      for (const line of payload.split(/\r?\n/)) {
        client.res.write(`data: ${line}\n`);
      }
      client.res.write('\n');
    } catch (_error) {
      captureStreamClients.delete(client);
    }
  }

  function broadcastCaptureStreamEvent(event = 'capture_status', data = captureStreamPayload()) {
    for (const client of captureStreamClients) {
      writeCaptureStreamEvent(client, event, data);
    }
  }

  function scheduleCaptureMonitor(delayMs = 0) {
    if (!captureStreamClients.size || captureMonitorTimer) return;
    captureMonitorTimer = setTimeout(
      () => {
        captureMonitorTimer = null;
        void runCaptureMonitorTick();
      },
      Math.max(0, delayMs)
    );
    captureMonitorTimer.unref?.();
  }

  async function runCaptureMonitorTick() {
    if (!captureStreamClients.size) return;
    if (captureMonitorInFlight) {
      scheduleCaptureMonitor(1000);
      return;
    }
    captureMonitorInFlight = true;
    let nextDelayMs = state.capture.active || state.phase === 'starting_capture' ? 2000 : 6000;
    try {
      if (state.capture.active) {
        const vehicleId = resolveThreeDgsVehicleId(state.capture.vehicle_id || defaultVehicleId);
        const cameras = activeCaptureCameras();
        if (cameras.length) {
          await updateCaptureStatusFromVehicle(vehicleId, {
            cameras,
            allowPartial: true,
            multiCamera: true,
            timeoutS: 10,
            persistLastResponse: false
          });
        }
      }
      broadcastCaptureStreamEvent('capture_status', captureStreamPayload());
      nextDelayMs = state.capture.active || state.phase === 'starting_capture' ? 2000 : 6000;
    } catch (error) {
      updateNestedState('capture', {
        last_monitor_ms: Date.now(),
        monitor_error: error.message || 'capture_monitor_failed'
      });
      broadcastCaptureStreamEvent(
        'capture_status',
        captureStreamPayload({
          monitor_error: error.message || 'capture_monitor_failed'
        })
      );
      nextDelayMs = 5000;
    } finally {
      captureMonitorInFlight = false;
      scheduleCaptureMonitor(nextDelayMs);
    }
  }

  function findArtifact(source, depth = 0) {
    if (!source || depth > 6) return null;
    if (typeof source !== 'object') return null;

    const base64Keys = ['data_base64', 'content_base64', 'package_base64', 'archive_base64', 'zip_base64', 'file_base64', 'payload_base64'];
    for (const key of base64Keys) {
      if (typeof source[key] === 'string' && source[key].trim()) {
        return {
          base64: source[key].trim(),
          filename: source.filename || source.file_name || source.name || source.path || source.local_path || null
        };
      }
    }

    if (typeof source.data_url === 'string') {
      const match = source.data_url.match(/^data:([^,]+)?,(.*)$/);
      if (match) {
        return {
          base64: decodeURIComponent(match[2]),
          filename: source.filename || source.file_name || source.name || null
        };
      }
    }

    const url = source.download_url || source.file_url || source.url || source.href;
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      return {
        url,
        filename: source.filename || source.file_name || source.name || source.path || null
      };
    }

    for (const value of Object.values(source)) {
      const nested = findArtifact(value, depth + 1);
      if (nested) return nested;
    }
    return null;
  }

  async function writeArtifactToFile(payload, targetBasePath, fallbackName, allowedExtensions) {
    const artifact = findArtifact(payload);
    if (!artifact) {
      return null;
    }
    const safeName = sanitizeFileName(artifact.filename || fallbackName, fallbackName);
    const ext = path.extname(safeName).toLowerCase() || path.extname(fallbackName).toLowerCase();
    if (allowedExtensions.length && !allowedExtensions.includes(ext)) {
      throw new Error(`unsupported_artifact_extension_${ext || 'none'}`);
    }
    const targetPath = `${targetBasePath}${ext || path.extname(fallbackName).toLowerCase() || '.bin'}`;
    const partPath = `${targetPath}.part`;
    await fsp.rm(partPath, { force: true });
    await fsp.rm(targetPath, { force: true });

    if (artifact.base64) {
      const approxBytes = Math.floor((artifact.base64.length * 3) / 4);
      if (approxBytes > uploadMaxBytes) {
        throw new Error('artifact_too_large');
      }
      await fsp.writeFile(partPath, Buffer.from(artifact.base64, 'base64'));
      await fsp.rename(partPath, targetPath);
    } else if (artifact.url) {
      const response = await fetch(artifact.url, {
        signal: AbortSignal.timeout(Number(process.env.THREE_DGS_ARTIFACT_FETCH_TIMEOUT_MS || 120000))
      });
      if (!response.ok || !response.body) {
        throw new Error(`artifact_download_failed_${response.status}`);
      }
      const contentLength = Number(response.headers.get('content-length') || 0);
      if (contentLength > uploadMaxBytes) {
        throw new Error('artifact_too_large');
      }
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partPath, { flags: 'w' }));
      await fsp.rename(partPath, targetPath);
    }

    const stat = await safeStat(targetPath);
    return {
      name: safeName,
      path: targetPath,
      size_bytes: stat?.size || 0,
      updated_at_ms: stat?.mtimeMs || Date.now()
    };
  }

  function mergeVehicleData(patch) {
    updateNestedState('vehicle_data', {
      map_vehicle_path: vehicleMapPath,
      configured_cameras: configuredCameraIds,
      ...patch
    });
  }

  function datasetInvalidationPatchForUploads(uploads = state.uploads) {
    if (!state.dataset.prepared || state.prepare.running || state.train.running) return {};
    const preparedAtMs = Number(state.dataset.prepared_at_ms || 0);
    if (!preparedAtMs) return {};
    const sourceUpdates = [
      Number(uploads?.image_pose?.updated_at_ms || 0),
      Number(uploads?.pointcloud?.updated_at_ms || 0)
    ].filter((value) => Number.isFinite(value) && value > 0);
    const newestUploadAtMs = sourceUpdates.length ? Math.max(...sourceUpdates) : 0;
    if (!newestUploadAtMs || newestUploadAtMs <= preparedAtMs) return {};
    return {
      phase: state.phase === 'prepared' ? 'idle' : state.phase,
      stage_text: '上传数据已更新，请重新规整 COLMAP/3DGS 训练数据。',
      dataset: {
        ...state.dataset,
        prepared: false,
        summary: null,
        prepared_at_ms: null,
        stale_reason: 'source_upload_newer_than_dataset',
        stale_at_ms: Date.now(),
        previous_scene_name: state.dataset.scene_name || null,
        previous_path: state.dataset.path || null
      }
    };
  }

  function makeStatusResponse(auth, extra = {}) {
    return {
      ok: true,
      auth: statusAuthPayload(auth),
      state: responseState(),
      ...extra
    };
  }

  async function discoverUpload(basePath, allowedExtensions, fallbackName) {
    for (const ext of allowedExtensions) {
      const targetPath = `${basePath}${ext}`;
      const stat = await safeStat(targetPath);
      if (stat) {
        return {
          name: fallbackName,
          path: targetPath,
          size_bytes: stat.size,
          updated_at_ms: stat.mtimeMs || Date.now()
        };
      }
    }
    return null;
  }

  async function syncUploadedArtifacts() {
    const imagePoseStat = state.uploads.image_pose?.path ? await safeStat(state.uploads.image_pose.path) : null;
    const pointcloudStat = state.uploads.pointcloud?.path ? await safeStat(state.uploads.pointcloud.path) : null;
    const uploads = { ...state.uploads };
    if (state.uploads.image_pose && !imagePoseStat) {
      uploads.image_pose = null;
    }
    if (state.uploads.pointcloud && !pointcloudStat) {
      uploads.pointcloud = null;
    }
    if (!uploads.image_pose) {
      uploads.image_pose = await discoverUpload(imagePoseUploadPath, ['.zip', '.tar', '.tar.gz', '.tgz', '.gz', '.json', '.jsonl'], 'image_pose_upload');
    }
    if (!uploads.pointcloud) {
      uploads.pointcloud = await discoverUpload(pointcloudUploadPath, ['.pcd', '.ply'], 'GlobalMap.pcd');
    }
    const stalePatch = datasetInvalidationPatchForUploads(uploads);
    const clearStalePatch = state.dataset.prepared &&
      state.dataset.stale_reason &&
      !Object.keys(stalePatch).length
      ? {
          dataset: {
            ...state.dataset,
            stale_reason: null,
            stale_at_ms: null,
            previous_scene_name: null,
            previous_path: null
          }
        }
      : {};
    if (uploads.image_pose !== state.uploads.image_pose || uploads.pointcloud !== state.uploads.pointcloud || Object.keys(stalePatch).length || Object.keys(clearStalePatch).length) {
      updateState({ uploads, ...clearStalePatch, ...stalePatch });
    }
  }

  async function appendToLog(logPath, line) {
    await ensureRuntimeDirs();
    await fsp.appendFile(logPath, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  }

  function createVehicleUploadTicket({ vehicleId, kind, fileName, targetPath = null, staging = false }) {
    const token = crypto.randomBytes(24).toString('hex');
    const ext = path.extname(fileName).toLowerCase() || '.pcd';
    const resolvedTargetPath = targetPath
      ? path.resolve(targetPath)
      : kind === 'pointcloud'
        ? `${pointcloudUploadPath}${ext}`
        : `${imagePoseUploadPath}${ext}`;
    const expiresAtMs = Date.now() + vehicleUploadTokenTtlMs;
    const ticket = {
      token,
      vehicle_id: vehicleId,
      kind,
      file_name: fileName,
      target_path: resolvedTargetPath,
      staging: Boolean(staging),
      expires_at_ms: expiresAtMs,
      created_at_ms: Date.now()
    };
    pendingVehicleUploads.set(token, ticket);
    let uploadPath = `/api/three-dgs/vehicle-upload/${kind}/${token}`;
    if (kind === 'pointcloud') {
      uploadPath = `/api/three-dgs/pointcloud-upload/${token}`;
    } else if (kind === 'image_pose') {
      uploadPath = `/api/three-dgs/image-pose-upload/${token}`;
    }
    const uploadUrl = `${publicBaseUrl}${uploadPath}`;
    const statusUrl = `${publicBaseUrl}${uploadPath}/status`;
    return {
      ...ticket,
      upload_url: uploadUrl,
      status_url: statusUrl,
      resume_supported: true,
      content_range_supported: true,
      chunk_size_bytes: Number(process.env.THREE_DGS_VEHICLE_UPLOAD_CHUNK_SIZE_BYTES || 32 * 1024 * 1024),
      recommended_chunk_size_bytes: Number(process.env.THREE_DGS_VEHICLE_UPLOAD_CHUNK_SIZE_BYTES || 32 * 1024 * 1024)
    };
  }

  function uniqueVehicleImagePoseTargetPath(vehicleId, sessionId, fileName) {
    const safeVehicle = sanitizeFileName(vehicleId || 'vehicle', 'vehicle').replace(/\.[^.]+$/, '');
    const safeSession = sanitizeFileName(sessionId || 'session', 'session').replace(/\.[^.]+$/, '');
    const safeName = sanitizeFileName(fileName || 'image_pose.tar.gz', 'image_pose.tar.gz');
    return path.join(uploadDir, 'vehicle-image-pose', `${safeVehicle}-${safeSession}-${safeName}`);
  }

  function redactedUploadTicket(ticket) {
    if (!ticket) return null;
    return {
      vehicle_id: ticket.vehicle_id,
      kind: ticket.kind,
      file_name: ticket.file_name,
      target_path: ticket.target_path,
      staging: Boolean(ticket.staging),
      expires_at_ms: ticket.expires_at_ms,
      upload_url: ticket.upload_url ? ticket.upload_url.replace(/\/[0-9a-f]{48}(?=\/status$|$)/i, '/<redacted-token>') : null,
      status_url: ticket.status_url ? ticket.status_url.replace(/\/[0-9a-f]{48}(?=\/status$|$)/i, '/<redacted-token>') : null,
      resume_supported: Boolean(ticket.resume_supported),
      content_range_supported: Boolean(ticket.content_range_supported),
      chunk_size_bytes: Number(ticket.chunk_size_bytes || ticket.recommended_chunk_size_bytes || 0) || null
    };
  }

  async function waitForUploadedFile(targetPath, timeoutMs = 15000, minMtimeMs = 0) {
    const startedAt = Date.now();
    let previous = null;
    while (Date.now() - startedAt < timeoutMs) {
      const stat = await safeStat(targetPath);
      if (stat && stat.size > 0 && (!minMtimeMs || Number(stat.mtimeMs || 0) >= minMtimeMs)) {
        if (previous && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) {
          return stat;
        }
        previous = stat;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const stat = await safeStat(targetPath);
    return stat && (!minMtimeMs || Number(stat.mtimeMs || 0) >= minMtimeMs) ? stat : null;
  }

  function uploadInfoFromTicket(ticket, stat) {
    if (!ticket || !stat) return null;
    return {
      name: sanitizeFileName(ticket.file_name, path.basename(ticket.target_path)),
      path: ticket.target_path,
      size_bytes: stat.size || 0,
      updated_at_ms: stat.mtimeMs || Date.now()
    };
  }

  async function listFilesRecursive(rootDir) {
    const files = [];
    async function visit(currentDir) {
      const entries = await fsp.readdir(currentDir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const entryPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          await visit(entryPath);
        } else if (entry.isFile()) {
          files.push(entryPath);
        }
      }
    }
    await visit(rootDir);
    return files;
  }

  async function findFirstNamedFile(rootDir, names) {
    const wanted = new Set(names);
    const files = await listFilesRecursive(rootDir);
    return files.find((filePath) => wanted.has(path.basename(filePath))) || null;
  }

  async function readJsonlFile(filePath) {
    const text = await fsp.readFile(filePath, 'utf8');
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((item) => item && typeof item === 'object' && !Array.isArray(item));
  }

  async function readImagePoseRecords(rootDir) {
    const manifestPath = await findFirstNamedFile(rootDir, ['manifest.json']);
    const framesPath = await findFirstNamedFile(rootDir, ['frames.jsonl']);
    let manifest = {};
    let records = [];
    if (manifestPath) {
      manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
      for (const key of ['records', 'frames', 'frame_records']) {
        if (Array.isArray(manifest[key])) {
          records = manifest[key].filter((item) => item && typeof item === 'object' && !Array.isArray(item));
          break;
        }
      }
    }
    if (!records.length && framesPath) {
      records = await readJsonlFile(framesPath);
    }
    if (!records.length) {
      const jsonlFiles = (await listFilesRecursive(rootDir)).filter((filePath) => filePath.toLowerCase().endsWith('.jsonl'));
      for (const filePath of jsonlFiles) {
        records = await readJsonlFile(filePath);
        if (records.length) break;
      }
    }
    return { manifest, records };
  }

  function cameraIdFromFrameRecord(record, manifest, fallbackCamera = '') {
    const image = record?.image && typeof record.image === 'object' ? record.image : {};
    const calibration = record?.camera_calibration && typeof record.camera_calibration === 'object' ? record.camera_calibration : {};
    const candidates = [
      record?.camera,
      record?.camera_id,
      record?.camera_name,
      record?.sensor,
      record?.sensor_id,
      image.camera,
      image.camera_id,
      image.camera_name,
      calibration.camera,
      calibration.camera_id,
      calibration.camera_name,
      manifest?.camera,
      manifest?.camera_id,
      manifest?.camera_name,
      manifest?.camera_calibration?.camera_id,
      fallbackCamera
    ];
    for (const value of candidates) {
      if (value && typeof value === 'object') {
        const nested = value.camera || value.camera_id || value.id || value.name;
        if (typeof nested === 'string' && nested.trim()) return nested.trim();
      }
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    const topic = String(image.topic || image.image_topic || image.camera_topic || record?.topic || record?.image_topic || '');
    const known = configuredCameraIds.find((camera) => topic.includes(camera));
    if (known) return known;
    const imagePath = String(image.relative_path || image.path || image.file_path || record?.image_path || record?.path || record?.file_path || '');
    const fromPath = configuredCameraIds.find((camera) => imagePath.includes(camera));
    return fromPath || fallbackCamera || 'unknown_camera';
  }

  function imagePathCandidatesFromRecord(record) {
    const image = record?.image && typeof record.image === 'object' ? record.image : {};
    return [
      record?.image_path,
      record?.path,
      record?.file_path,
      record?.filename,
      image.path,
      image.file_path,
      image.relative_path,
      image.name
    ].filter(Boolean).map((value) => String(value));
  }

  async function resolveRecordImagePath(record, rootDir, filesByBasename) {
    for (const candidate of imagePathCandidatesFromRecord(record)) {
      const direct = path.resolve(candidate);
      if (direct.startsWith(`${path.resolve(rootDir)}${path.sep}`) && await safeStat(direct)) {
        return direct;
      }
      const relative = path.resolve(path.join(rootDir, candidate));
      if (relative.startsWith(`${path.resolve(rootDir)}${path.sep}`) && await safeStat(relative)) {
        return relative;
      }
      const byName = filesByBasename.get(path.basename(candidate));
      if (byName) return byName;
    }
    return null;
  }

  async function extractImagePoseArchive(sourcePath, targetDir) {
    await fsp.mkdir(targetDir, { recursive: true });
    const tarResult = await execFileAsync('tar', ['-xf', sourcePath, '-C', targetDir], {
      timeout: Number(process.env.THREE_DGS_ARCHIVE_EXTRACT_TIMEOUT_MS || 300000),
      maxBuffer: 1024 * 1024
    }).then(() => true).catch(() => false);
    if (tarResult) return;
    await execFileAsync('unzip', ['-q', sourcePath, '-d', targetDir], {
      timeout: Number(process.env.THREE_DGS_ARCHIVE_EXTRACT_TIMEOUT_MS || 300000),
      maxBuffer: 1024 * 1024
    });
  }

  async function mergeImagePosePackages({ vehicleId, packageInfos, cameras }) {
    if (!packageInfos.length) {
      throw new Error('image_pose_package_empty');
    }
    if (packageInfos.length === 1) {
      return packageInfos[0].info;
    }

    await ensureRuntimeDirs();
    const mergeRoot = await fsp.mkdtemp(path.join(runtimeRoot, 'image-pose-merge-'));
    const combinedRoot = path.join(mergeRoot, 'combined');
    const combinedImages = path.join(combinedRoot, 'images');
    await fsp.mkdir(combinedImages, { recursive: true });
    const combinedRecords = [];
    const calibrationByCamera = {};
    const sourcePackages = [];
    let imageIndex = 0;

    try {
      for (const [packageIndex, packageItem] of packageInfos.entries()) {
        const camera = packageItem.camera || cameras[packageIndex] || '';
        const extractRoot = path.join(mergeRoot, `part-${packageIndex}`);
        await extractImagePoseArchive(packageItem.info.path, extractRoot);
        const { manifest, records } = await readImagePoseRecords(extractRoot);
        const allFiles = await listFilesRecursive(extractRoot);
        const filesByBasename = new Map();
        for (const filePath of allFiles) {
          if (!filesByBasename.has(path.basename(filePath))) {
            filesByBasename.set(path.basename(filePath), filePath);
          }
        }
        sourcePackages.push({
          camera,
          name: packageItem.info.name,
          size_bytes: packageItem.info.size_bytes,
          frame_count: records.length
        });
        for (const record of records) {
          const sourceImage = await resolveRecordImagePath(record, extractRoot, filesByBasename);
          if (!sourceImage) continue;
          const cameraId = cameraIdFromFrameRecord(record, manifest, camera);
          const calibration = record?.camera_calibration || manifest?.camera_calibration || manifest?.calibration?.cameras?.[cameraId] || manifest?.cameras?.[cameraId] || null;
          if (calibration && typeof calibration === 'object') {
            calibrationByCamera[cameraId] = calibration;
          }
          const ext = path.extname(sourceImage).toLowerCase() || '.jpg';
          const outName = `frame_${String(imageIndex + 1).padStart(6, '0')}_${sanitizeFileName(cameraId, 'camera')}${ext}`;
          const outRelativePath = `images/${outName}`;
          await fsp.copyFile(sourceImage, path.join(combinedImages, outName));
          const nextRecord = JSON.parse(JSON.stringify(record));
          nextRecord.camera = cameraId;
          nextRecord.camera_id = cameraId;
          if (calibration && typeof calibration === 'object' && (!nextRecord.camera_calibration || typeof nextRecord.camera_calibration !== 'object')) {
            nextRecord.camera_calibration = calibration;
          }
          const nextImage = nextRecord.image && typeof nextRecord.image === 'object' ? { ...nextRecord.image } : {};
          nextImage.camera = cameraId;
          nextImage.camera_id = cameraId;
          nextImage.path = outRelativePath;
          nextImage.file_path = outRelativePath;
          nextImage.relative_path = outRelativePath;
          nextImage.name = outName;
          nextRecord.image = nextImage;
          nextRecord.image_path = outRelativePath;
          combinedRecords.push(nextRecord);
          imageIndex += 1;
        }
      }

      if (!combinedRecords.length) {
        throw new Error('image_pose_merge_no_records');
      }

      const combinedManifest = {
        vehicle_id: vehicleId,
        generated_at_ms: Date.now(),
        source: 'cloud_control_multi_camera_merge',
        source_packages: sourcePackages,
        camera_ids: Object.keys(calibrationByCamera),
        cameras: calibrationByCamera,
        calibration: {
          cameras: calibrationByCamera
        },
        frames: combinedRecords
      };
      await fsp.writeFile(path.join(combinedRoot, 'manifest.json'), JSON.stringify(combinedManifest, null, 2), 'utf8');
      await fsp.writeFile(
        path.join(combinedRoot, 'frames.jsonl'),
        combinedRecords.map((record) => JSON.stringify(record)).join('\n') + '\n',
        'utf8'
      );

      const finalPath = `${imagePoseUploadPath}.tar.gz`;
      await fsp.rm(finalPath, { force: true });
      await execFileAsync('tar', ['-czf', finalPath, '-C', combinedRoot, '.'], {
        timeout: Number(process.env.THREE_DGS_ARCHIVE_CREATE_TIMEOUT_MS || 300000),
        maxBuffer: 1024 * 1024
      });
      const stat = await safeStat(finalPath);
      return {
        name: `image_pose_${vehicleId}_multi_camera.tar.gz`,
        path: finalPath,
        size_bytes: stat?.size || 0,
        updated_at_ms: stat?.mtimeMs || Date.now(),
        merged_camera_count: Object.keys(calibrationByCamera).length,
        merged_frame_count: combinedRecords.length,
        source_packages: sourcePackages
      };
    } finally {
      await fsp.rm(mergeRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function callCapturePackageTool(vehicleId, packageArgs, timeoutSeconds) {
    try {
      return await callVehicleTool(vehicleId, '3dgs.capture.package', packageArgs, timeoutSeconds);
    } catch (error) {
      const message = String(error?.message || '');
      const canRetryLegacy = packageArgs?.include_pose_history
        && /unknown|unsupported|unexpected|invalid.*arg|argument|schema/i.test(message);
      if (!canRetryLegacy) {
        throw error;
      }
      const legacyArgs = { ...packageArgs };
      delete legacyArgs.include_pose_history;
      delete legacyArgs.pose_interpolation;
      return callVehicleTool(vehicleId, '3dgs.capture.package', legacyArgs, timeoutSeconds);
    }
  }

  function formatBytesForStatus(bytes) {
    const value = Number(bytes || 0);
    if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(2)}GB`;
    if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)}MB`;
    if (value > 0) return `${Math.round(value / 1024)}KB`;
    return '';
  }

  function setVehicleUploadProgress(ticket, patch = {}) {
    if (!ticket?.kind || !['image_pose', 'pointcloud'].includes(ticket.kind)) return;
    const current = state.vehicle_uploads?.[ticket.kind] || {};
    const sameUpload =
      current.vehicle_id === ticket.vehicle_id &&
      current.file_name === ticket.file_name &&
      current.kind === ticket.kind;
    const totalBytes = Number(patch.total_bytes ?? current.total_bytes ?? 0);
    const receivedBytes = Math.max(0, Number(patch.received_bytes ?? current.received_bytes ?? 0));
    let progressPct = Number(patch.progress_pct);
    if (!Number.isFinite(progressPct)) {
      progressPct = totalBytes > 0 ? (receivedBytes / totalBytes) * 100 : current.progress_pct;
    }
    if (Number.isFinite(progressPct)) {
      progressPct = Math.max(0, Math.min(100, progressPct));
    } else {
      progressPct = null;
    }
    const next = {
      vehicle_id: ticket.vehicle_id,
      kind: ticket.kind,
      file_name: ticket.file_name,
      received_bytes: receivedBytes,
      total_bytes: Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : 0,
      progress_pct: progressPct,
      status: patch.status || current.status || 'pending',
      error_message: patch.error_message || null,
      package_path: Object.prototype.hasOwnProperty.call(patch, 'package_path')
        ? patch.package_path || null
        : sameUpload
          ? current.package_path || null
          : null,
      package_size_bytes: Number(patch.package_size_bytes ?? (sameUpload ? current.package_size_bytes : 0) ?? 0) || 0,
      resume_available: Boolean(patch.resume_available ?? (sameUpload ? current.resume_available : false) ?? false),
      resume_from_bytes: Number(patch.resume_from_bytes ?? (sameUpload ? current.resume_from_bytes : 0) ?? 0) || 0,
      request_bytes: Number(patch.request_bytes ?? (sameUpload ? current.request_bytes : 0) ?? 0) || 0,
      started_at_ms: sameUpload ? current.started_at_ms || Date.now() : Date.now(),
      updated_at_ms: Date.now()
    };
    updateNestedState('vehicle_uploads', {
      ...(state.vehicle_uploads || {}),
      [ticket.kind]: next
    });
    broadcastCaptureStreamEvent('capture_status', captureStreamPayload());
  }

  function cleanupExpiredVehicleUploads() {
    const now = Date.now();
    for (const [token, ticket] of pendingVehicleUploads.entries()) {
      if (Number(ticket.expires_at_ms || 0) <= now) {
        pendingVehicleUploads.delete(token);
      }
    }
  }

  function mapUploadErrorMessage(payload) {
    return String(payload?.error || payload?.response?.error || payload?.detail || '');
  }

  function shouldRetryMapUploadWithFallback(payload) {
    const message = mapUploadErrorMessage(payload);
    return Boolean(fallbackMapUploadStagingDir && /permission denied/i.test(message) && message.includes('/media/data'));
  }

  function parseContentRangeHeader(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    const match = text.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
    if (!match) return null;
    const start = Number(match[1]);
    const end = Number(match[2]);
    const total = match[3] === '*' ? 0 : Number(match[3]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
      return null;
    }
    if (match[3] !== '*' && (!Number.isFinite(total) || total <= end)) {
      return null;
    }
    return {
      start,
      end,
      total_bytes: total
    };
  }

  async function readUploadPartMeta(metaPath) {
    try {
      return JSON.parse(await fsp.readFile(metaPath, 'utf8'));
    } catch (_error) {
      return null;
    }
  }

  async function writeUploadPartMeta(metaPath, data) {
    await fsp.writeFile(metaPath, JSON.stringify({
      ...data,
      updated_at_ms: Date.now()
    }, null, 2), 'utf8');
  }

  async function getVehicleUploadStorageStatus(ticket) {
    const targetPath = ticket.target_path;
    const partPath = `${targetPath}.part`;
    const metaPath = `${partPath}.json`;
    const [targetStat, partStat, partMeta] = await Promise.all([
      safeStat(targetPath),
      safeStat(partPath),
      readUploadPartMeta(metaPath)
    ]);
    return {
      target_path: targetPath,
      part_path: partPath,
      meta_path: metaPath,
      completed: Boolean(targetStat?.size),
      completed_bytes: Number(targetStat?.size || 0),
      received_bytes: Number(partStat?.size || 0),
      part_meta: partMeta,
      updated_at_ms: Number(targetStat?.mtimeMs || partStat?.mtimeMs || 0)
    };
  }

  async function writeVehicleUpload(req, ticket, onProgress = null) {
    await ensureRuntimeDirs();
    const targetPath = ticket.target_path;
    const partPath = `${targetPath}.part`;
    const metaPath = `${partPath}.json`;
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });

    const contentLength = Number(req.headers['content-length'] || 0);
    const contentRange = parseContentRangeHeader(req.headers['content-range']);
    const targetStat = await safeStat(targetPath);
    const partStat = await safeStat(partPath);
    const partMeta = await readUploadPartMeta(metaPath);
    let existingBytes = Number(partStat?.size || 0);
    let totalBytes = Number(contentRange?.total_bytes || contentLength || partMeta?.total_bytes || 0);
    const samePartial =
      existingBytes > 0 &&
      partMeta?.kind === ticket.kind &&
      partMeta?.file_name === ticket.file_name &&
      (!totalBytes || !partMeta?.total_bytes || Number(partMeta.total_bytes) === totalBytes);

    if (targetStat?.size && totalBytes && Number(targetStat.size) === totalBytes) {
      return {
        name: sanitizeFileName(ticket.file_name, path.basename(targetPath)),
        path: targetPath,
        size_bytes: targetStat.size,
        updated_at_ms: targetStat.mtimeMs || Date.now(),
        resumed: false,
        already_completed: true
      };
    }

    if (!samePartial || (contentRange?.start === 0 && existingBytes > 0)) {
      await fsp.rm(partPath, { force: true });
      await fsp.rm(metaPath, { force: true });
      if (!contentRange || contentRange.start === 0) {
        await fsp.rm(targetPath, { force: true });
      }
      existingBytes = 0;
    }

    if (contentRange) {
      totalBytes = Number(contentRange.total_bytes || totalBytes || 0);
      if (totalBytes > uploadMaxBytes) {
        throw new Error('vehicle_upload_too_large');
      }
      if (existingBytes < contentRange.start) {
        const error = new Error(`vehicle_upload_range_gap:${existingBytes}:${contentRange.start}`);
        error.status = 409;
        throw error;
      }
    } else if (contentLength > uploadMaxBytes) {
      throw new Error('vehicle_upload_too_large');
    }

    const writeStartBytes = contentRange ? contentRange.start : 0;
    let skipBytes = contentRange
      ? Math.max(0, existingBytes - writeStartBytes)
      : Math.max(0, Math.min(existingBytes, contentLength || existingBytes));
    const appendMode = existingBytes > 0 && skipBytes >= 0;
    let storedBytes = existingBytes;
    let requestBytes = 0;
    let lastProgressAtMs = 0;
    const progressTotalBytes = totalBytes || contentLength || 0;

    await writeUploadPartMeta(metaPath, {
      vehicle_id: ticket.vehicle_id,
      kind: ticket.kind,
      file_name: ticket.file_name,
      target_path: targetPath,
      total_bytes: progressTotalBytes || 0,
      resumed_from_bytes: existingBytes,
      content_range: contentRange,
      created_at_ms: partMeta?.created_at_ms || Date.now()
    });

    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        requestBytes += chunk.length;
        let output = chunk;
        if (skipBytes > 0) {
          if (chunk.length <= skipBytes) {
            skipBytes -= chunk.length;
            const now = Date.now();
            if (typeof onProgress === 'function' && (!lastProgressAtMs || now - lastProgressAtMs >= 1000)) {
              lastProgressAtMs = now;
              onProgress({
                status: 'uploading',
                received_bytes: storedBytes,
                total_bytes: progressTotalBytes,
                resume_from_bytes: existingBytes,
                request_bytes: requestBytes
              });
            }
            callback();
            return;
          }
          output = chunk.subarray(skipBytes);
          skipBytes = 0;
        }
        storedBytes += output.length;
        if (storedBytes > uploadMaxBytes) {
          callback(new Error('vehicle_upload_too_large'));
          return;
        }
        const now = Date.now();
        if (typeof onProgress === 'function' && (!lastProgressAtMs || now - lastProgressAtMs >= 1000)) {
          lastProgressAtMs = now;
          onProgress({
            status: 'uploading',
            received_bytes: storedBytes,
            total_bytes: progressTotalBytes,
            resume_from_bytes: existingBytes,
            request_bytes: requestBytes
          });
        }
        callback(null, output);
      }
    });

    try {
      await pipeline(req, limiter, fs.createWriteStream(partPath, { flags: appendMode ? 'a' : 'w' }));
      const expectedBytes = totalBytes || contentLength || storedBytes;
      if (contentRange && totalBytes && storedBytes < totalBytes) {
        await writeUploadPartMeta(metaPath, {
          vehicle_id: ticket.vehicle_id,
          kind: ticket.kind,
          file_name: ticket.file_name,
          target_path: targetPath,
          total_bytes: totalBytes,
          received_bytes: storedBytes,
          partial: true,
          created_at_ms: partMeta?.created_at_ms || Date.now()
        });
        const partStatAfter = await safeStat(partPath);
        return {
          name: sanitizeFileName(ticket.file_name, path.basename(targetPath)),
          path: partPath,
          size_bytes: partStatAfter?.size || storedBytes,
          updated_at_ms: partStatAfter?.mtimeMs || Date.now(),
          partial: true,
          received_bytes: storedBytes,
          total_bytes: totalBytes,
          resume_from_bytes: storedBytes
        };
      }
      if (expectedBytes && storedBytes < expectedBytes) {
        const error = new Error(`vehicle_upload_incomplete:${storedBytes}:${expectedBytes}`);
        error.status = 499;
        throw error;
      }
      await fsp.rename(partPath, targetPath);
      await fsp.rm(metaPath, { force: true }).catch(() => {});
      const stat = await safeStat(targetPath);
      return {
        name: sanitizeFileName(ticket.file_name, path.basename(targetPath)),
        path: targetPath,
        size_bytes: stat?.size || storedBytes,
        updated_at_ms: stat?.mtimeMs || Date.now(),
        resumed: existingBytes > 0
      };
    } catch (error) {
      await writeUploadPartMeta(metaPath, {
        vehicle_id: ticket.vehicle_id,
        kind: ticket.kind,
        file_name: ticket.file_name,
        target_path: targetPath,
        total_bytes: progressTotalBytes || 0,
        received_bytes: storedBytes,
        partial: true,
        last_error: error.message || 'vehicle_upload_failed',
        created_at_ms: partMeta?.created_at_ms || Date.now()
      }).catch(() => {});
      error.received_bytes = storedBytes;
      error.total_bytes = progressTotalBytes || 0;
      error.resume_available = storedBytes > 0;
      throw error;
    }
  }

  async function updateMapFromVehicle(auth, vehicleId) {
    if (captureStartInFlight || uploadInFlight || state.prepare.running || state.train.running) {
      throw new Error('three_dgs_busy');
    }
    if (state.capture.active) {
      const error = new Error('three_dgs_capture_must_stop_before_map_upload');
      error.status = 409;
      throw error;
    }
    updateState({
      phase: 'updating_map',
      active_username: auth.username,
      stage_text: `正在读取 ${vehicleId} 车端地图 map/GlobalMap.pcd 元信息。`,
      error_message: null
    });

    const mapInfo = await callVehicleTool(vehicleId, 'map.info', {}, 45).catch((error) => ({ error: error.message }));
    const mapMeta = await callVehicleTool(vehicleId, 'map.pointcloud.meta', { target: 'global' }, 45);

    let pointcloudInfo = await writeArtifactToFile(mapMeta, pointcloudUploadPath, 'GlobalMap.pcd', ['.pcd', '.ply']);

    for (const toolName of mapDownloadTools) {
      if (pointcloudInfo) break;
      const mapPayload = await callVehicleTool(
        vehicleId,
        toolName,
        {
          target: 'global',
          path: vehicleMapPath,
          include_base64: true
        },
        90
      ).catch(() => null);
      if (mapPayload) {
        pointcloudInfo = await writeArtifactToFile(mapPayload, pointcloudUploadPath, 'GlobalMap.pcd', ['.pcd', '.ply']);
      }
    }

    let mapUpload = null;
    if (!pointcloudInfo) {
      const ticket = createVehicleUploadTicket({
        vehicleId,
        kind: 'pointcloud',
        fileName: 'GlobalMap.pcd'
      });
      mergeVehicleData({
        vehicle_id: vehicleId,
        map_upload_pending: true,
        map_upload_expires_at_ms: ticket.expires_at_ms
      });
      const requestMapUpload = (extraArgs = {}) =>
        callVehicleTool(
          vehicleId,
          mapUploadTool,
          {
            upload_url: ticket.upload_url,
            status_url: ticket.status_url,
            method: 'POST',
            resume_supported: true,
            content_range_supported: true,
            chunk_size_bytes: ticket.chunk_size_bytes,
            recommended_chunk_size_bytes: ticket.recommended_chunk_size_bytes,
            ...extraArgs
          },
          Number(process.env.THREE_DGS_MAP_UPLOAD_TOOL_TIMEOUT_S || 240)
        ).catch((error) => ({ error: error.message, tool: mapUploadTool }));

      mapUpload = await requestMapUpload();
      let uploadedStat = await safeStat(ticket.target_path);
      if (!uploadedStat && shouldRetryMapUploadWithFallback(mapUpload)) {
        mergeVehicleData({
          vehicle_id: vehicleId,
          map_upload_retry_staging_dir: fallbackMapUploadStagingDir
        });
        updateState({
          phase: 'updating_map',
          stage_text: `车端 /media/data staging 无权限，改用 ${fallbackMapUploadStagingDir} 重试 GlobalMap.pcd 上传。`
        });
        mapUpload = await requestMapUpload({
          staging_dir: fallbackMapUploadStagingDir
        });
        uploadedStat = await safeStat(ticket.target_path);
      }
      if (uploadedStat) {
        pointcloudInfo = {
          name: 'GlobalMap.pcd',
          path: ticket.target_path,
          size_bytes: uploadedStat.size,
          updated_at_ms: uploadedStat.mtimeMs || Date.now()
        };
        pendingVehicleUploads.delete(ticket.token);
      }
    }

    mergeVehicleData({
      vehicle_id: vehicleId,
      map_info: mapInfo,
      map_meta: mapMeta,
      map_upload: mapUpload,
      last_map_update_ms: Date.now()
    });

    if (!pointcloudInfo) {
      const mapUploadError = mapUploadErrorMessage(mapUpload) || (mapUpload?.response && mapUpload.response.ok === false ? 'map_upload_tool_failed' : null);
      updateState({
        phase: state.uploads.image_pose ? 'idle' : 'idle',
        stage_text: mapUploadError
          ? '已读取车端 GlobalMap.pcd 元信息，但车端上传 GlobalMap.pcd 失败。'
          : '已向车端下发 GlobalMap.pcd 上传地址，等待车端上传文件。',
        error_message: mapUploadError ? mapUploadError : null
      });
      if (mapUploadError) {
        const error = new Error(mapUploadError);
        error.status = 424;
        throw error;
      }
      return null;
    }

    updateState({
      phase: state.dataset.prepared ? 'prepared' : 'idle',
      stage_text: '车端 GlobalMap.pcd 已更新到云端服务器。',
      uploads: {
        ...state.uploads,
        pointcloud: pointcloudInfo
      },
      error_message: null
    });
    return pointcloudInfo;
  }

  async function pullImagePosePackageFromVehicle(auth, payload = {}) {
    if (captureStartInFlight || uploadInFlight || state.prepare.running || state.train.running) {
      throw new Error('three_dgs_busy');
    }
    if (state.capture.active) {
      updateState({
        phase: state.dataset.prepared ? 'prepared' : 'idle',
        stage_text: '请先停止车端 3DGS 采集，再上传图像-位姿包。',
        error_message: 'three_dgs_capture_must_stop_before_package'
      });
      const error = new Error('three_dgs_capture_must_stop_before_package');
      error.status = 409;
      throw error;
    }
    const vehicleId = resolveThreeDgsVehicleId(payload.vehicle_id || state.capture.vehicle_id || defaultVehicleId);
    const requestedCameras = uniqueStrings([
      payload.camera,
      ...(Array.isArray(payload.cameras) ? payload.cameras : []),
      ...(Array.isArray(payload.camera_ids) ? payload.camera_ids : [])
    ]);
    const cameras = requestedCameras.length ? requestedCameras : activeCaptureCameras();
    if (!cameras.length) {
      throw new Error('three_dgs_no_capture_cameras');
    }
    const latestCapture = await updateCaptureStatusFromVehicle(vehicleId, {
      cameras,
      allowPartial: false,
      multiCamera: true,
      timeoutS: 8,
      persistLastResponse: true
    });
    if (aggregateCaptureActivity(latestCapture.statuses)) {
      updateState({
        phase: state.dataset.prepared ? 'prepared' : 'idle',
        stage_text: '请先停止车端 3DGS 采集，再上传图像-位姿包。',
        error_message: 'three_dgs_capture_must_stop_before_package'
      });
      const error = new Error('three_dgs_capture_must_stop_before_package');
      error.status = 409;
      throw error;
    }

    updateState({
      phase: 'pulling_image_pose',
      active_username: auth.username,
      stage_text: `正在从 ${vehicleId} 当前 3DGS session 拉取图像-位姿包。`,
      error_message: null
    });

    if (state.capture.multi_camera) {
      const sessionId = resolveMultiCameraPackageSessionId(payload);
      const packageName = `image_pose_${vehicleId}_${sessionId || 'multi_camera'}.tar.gz`;
      const uploadTicket = createVehicleUploadTicket({
        vehicleId,
        kind: 'image_pose',
        fileName: packageName,
        targetPath: uniqueVehicleImagePoseTargetPath(vehicleId, sessionId || 'multi_camera', packageName)
      });
      setVehicleUploadProgress(uploadTicket, {
        status: 'waiting_vehicle',
        received_bytes: 0,
        total_bytes: 0,
        progress_pct: 0
      });
      const packageArgs = {
        include_base64: false,
        upload_url: uploadTicket.upload_url,
        status_url: uploadTicket.status_url,
        method: 'POST',
        resume_supported: true,
        content_range_supported: true,
        include_pose_history: true,
        pose_interpolation: 'timestamp',
        chunk_size_bytes: uploadTicket.chunk_size_bytes,
        recommended_chunk_size_bytes: uploadTicket.recommended_chunk_size_bytes,
        ...(payload.output_root ? { output_root: payload.output_root } : {}),
        ...(sessionId ? { session_id: sessionId } : {})
      };
      let packagePayload = null;
      let packageToolError = null;
      try {
        packagePayload = await callCapturePackageTool(
          vehicleId,
          packageArgs,
          Number(process.env.THREE_DGS_IMAGE_POSE_PACKAGE_TIMEOUT_S || 1800)
        );
      } catch (error) {
        packageToolError = error;
        packagePayload = { error: error.message || 'image_pose_package_failed' };
      }
      const uploadedStat = await waitForUploadedFile(
        uploadTicket.target_path,
        Number(process.env.THREE_DGS_IMAGE_POSE_UPLOAD_WAIT_MS || 60000),
        uploadTicket.created_at_ms
      );
      let packageInfo = uploadInfoFromTicket(uploadTicket, uploadedStat);
      if (packageInfo) {
        pendingVehicleUploads.delete(uploadTicket.token);
      }
      if (!packageInfo) {
        packageInfo = await writeArtifactToFile(packagePayload, imagePoseUploadPath, packageName, [
          '.zip',
          '.tar',
          '.tar.gz',
          '.tgz',
          '.gz',
          '.json',
          '.jsonl'
        ]);
      }
      if (!packageInfo) {
        const storageStatus = await getVehicleUploadStorageStatus(uploadTicket);
        const packageResult = unwrapToolPayload(packagePayload) || {};
        const packagePath = packageResult.package_path || packageResult.path || packageResult.file_path || '';
        const packageSize = Number(packageResult.size_bytes || packageResult.file_size || 0);
        const packageError = mapUploadErrorMessage(packagePayload);
        const resumeBytes = Number(storageStatus.received_bytes || 0);
        const errorMessage = packageError || (packagePath ? 'image_pose_package_not_uploaded' : 'image_pose_file_transfer_unavailable');
        setVehicleUploadProgress(uploadTicket, {
          status: 'failed',
          error_message: resumeBytes
            ? `上传中断，云端已保留 ${formatBytesForStatus(resumeBytes)}，可再次点击上传图片数据续传`
            : packagePath
              ? `车端已打包${formatBytesForStatus(packageSize) ? ` ${formatBytesForStatus(packageSize)}` : ''}，但未上传到云端`
              : errorMessage,
          received_bytes: resumeBytes,
          total_bytes: Number(storageStatus.part_meta?.total_bytes || packageSize || 0),
          resume_available: resumeBytes > 0,
          resume_from_bytes: resumeBytes,
          package_path: packagePath || null,
          package_size_bytes: packageSize
        });
        updateNestedState('capture', {
          vehicle_id: vehicleId,
          last_response: {
            package: packagePayload,
            upload_ticket: redactedUploadTicket(uploadTicket)
          }
        });
        updateState({
          phase: state.dataset.prepared ? 'prepared' : 'idle',
          stage_text: resumeBytes
            ? '车端当前 3DGS session 图像-位姿包上传中断，云端已保留部分数据，可重试续传。'
            : '车端当前 3DGS session 图像-位姿包上传失败。',
          error_message: resumeBytes ? 'image_pose_upload_interrupted_resume_available' : errorMessage
        });
        const error = new Error(resumeBytes ? 'image_pose_upload_interrupted_resume_available' : (packageToolError?.message || errorMessage));
        error.status = 424;
        throw error;
      }
      setVehicleUploadProgress(uploadTicket, {
        status: 'completed',
        received_bytes: packageInfo.size_bytes,
        total_bytes: packageInfo.size_bytes,
        progress_pct: 100
      });
      mergeVehicleData({
        vehicle_id: vehicleId,
        last_image_pull_ms: Date.now()
      });
      updateNestedState('capture', {
        vehicle_id: vehicleId,
        cameras,
        last_response: {
          package: packagePayload,
          upload_ticket: redactedUploadTicket(uploadTicket)
        }
      });
      updateState({
        phase: state.dataset.prepared ? 'prepared' : 'idle',
        stage_text: `车端 ${vehicleId} 当前 3DGS session 图像-位姿包已上传到云端服务器。`,
        uploads: {
          ...state.uploads,
          image_pose: packageInfo
        },
        error_message: null
      });
      return packageInfo;
    }

    const packageInfos = [];
    const packageResponses = [];
    const packageTimeoutS = Number(process.env.THREE_DGS_IMAGE_POSE_PACKAGE_TIMEOUT_S || 1800);
    const uploadWaitMs = Number(process.env.THREE_DGS_IMAGE_POSE_UPLOAD_WAIT_MS || 60000);
    const partDir = path.join(uploadDir, 'image-pose-parts');
    let lastUploadTicket = null;
    await fsp.mkdir(partDir, { recursive: true });

    for (const [index, camera] of cameras.entries()) {
      const sessionId = captureSessionIdForCamera(camera, payload, cameras.length === 1);
      const packageName = cameras.length > 1
        ? `image_pose_${vehicleId}_${camera}_${sessionId || 'active'}.tar.gz`
        : `image_pose_${vehicleId}_${sessionId || camera || 'active'}.zip`;
      const uploadTicket = createVehicleUploadTicket({
        vehicleId,
        kind: 'image_pose',
        fileName: packageName,
        staging: cameras.length > 1,
        targetPath: cameras.length > 1
          ? path.join(partDir, `${Date.now()}-${index}-${sanitizeFileName(camera, 'camera')}.tar.gz`)
          : null
      });
      lastUploadTicket = uploadTicket;
      setVehicleUploadProgress(uploadTicket, {
        status: 'waiting_vehicle',
        received_bytes: 0,
        total_bytes: 0,
        progress_pct: cameras.length > 1 ? (index / cameras.length) * 100 : 0
      });
      updateState({
        phase: 'pulling_image_pose',
        stage_text: `正在从 ${vehicleId} 当前 3DGS session 拉取图像-位姿包。`
      });
      const packageArgs = {
        include_base64: false,
        upload_url: uploadTicket.upload_url,
        status_url: uploadTicket.status_url,
        method: 'POST',
        resume_supported: true,
        content_range_supported: true,
        include_pose_history: true,
        pose_interpolation: 'timestamp',
        chunk_size_bytes: uploadTicket.chunk_size_bytes,
        recommended_chunk_size_bytes: uploadTicket.recommended_chunk_size_bytes,
        camera,
        camera_id: camera,
        ...(sessionId ? { session_id: sessionId } : {})
      };
      const packagePayload = await callCapturePackageTool(
        vehicleId,
        packageArgs,
        packageTimeoutS
      );
      packageResponses.push({
        camera,
        response: packagePayload,
        upload_ticket: redactedUploadTicket(uploadTicket)
      });
      const uploadedStat = await waitForUploadedFile(uploadTicket.target_path, uploadWaitMs, uploadTicket.created_at_ms);
      let packageInfo = uploadInfoFromTicket(uploadTicket, uploadedStat);
      if (packageInfo) {
        pendingVehicleUploads.delete(uploadTicket.token);
      }
      if (!packageInfo && cameras.length === 1) {
        packageInfo = await writeArtifactToFile(packagePayload, imagePoseUploadPath, packageName, [
          '.zip',
          '.tar',
          '.tar.gz',
          '.tgz',
          '.gz',
          '.json',
          '.jsonl'
        ]);
      }
      if (!packageInfo) {
        const packageResult = unwrapToolPayload(packagePayload) || {};
        const packagePath = packageResult.package_path || packageResult.path || packageResult.file_path || '';
        const packageSize = Number(packageResult.size_bytes || packageResult.file_size || 0);
        const packageError = mapUploadErrorMessage(packagePayload);
        const errorMessage = packageError || (packagePath ? 'image_pose_package_not_uploaded' : 'image_pose_file_transfer_unavailable');
        setVehicleUploadProgress(uploadTicket, {
          status: 'failed',
          error_message: packagePath
            ? `车端 ${camera} 已打包${formatBytesForStatus(packageSize) ? ` ${formatBytesForStatus(packageSize)}` : ''}，但未上传到云端`
            : errorMessage,
          package_path: packagePath || null,
          package_size_bytes: packageSize
        });
        updateNestedState('capture', {
          vehicle_id: vehicleId,
          last_response: {
            packages: packageResponses
          }
        });
        updateState({
          phase: state.dataset.prepared ? 'prepared' : 'idle',
          stage_text: `车端当前 3DGS session 图像-位姿包上传失败。`,
          error_message: errorMessage
        });
        const error = new Error(errorMessage);
        error.status = 424;
        throw error;
      }
      packageInfos.push({ camera, info: packageInfo });
    }

    const packageInfo = await mergeImagePosePackages({ vehicleId, packageInfos, cameras });
    if (lastUploadTicket) {
      setVehicleUploadProgress(lastUploadTicket, {
        status: 'completed',
        received_bytes: packageInfo.size_bytes,
        total_bytes: packageInfo.size_bytes,
        progress_pct: 100
      });
    }
    mergeVehicleData({
      vehicle_id: vehicleId,
      last_image_pull_ms: Date.now()
    });
    updateNestedState('capture', {
      vehicle_id: vehicleId,
      cameras,
      last_response: {
        packages: packageResponses,
        merged_package: packageInfo
      }
    });
    updateState({
      phase: state.dataset.prepared ? 'prepared' : 'idle',
      stage_text: '车端当前 3DGS session 图像-位姿包已上传到云端服务器。',
      uploads: {
        ...state.uploads,
        image_pose: packageInfo
      },
      error_message: null
    });
    return packageInfo;
  }

  function buildCaptureStartArgs(payload = {}) {
    return {
      pose_topic: '/ndt_pose',
      pointcloud_topic: '/rslidar_points32',
      min_translation_m: Number(payload.min_translation_m || 0.5),
      min_rotation_deg: Number(payload.min_rotation_deg || 10),
      min_interval_s: Number(payload.min_interval_s || 0.2),
      max_pose_gap_ms: Number(payload.max_pose_gap_ms || 100),
      pose_interpolation_delay_s: Number(payload.pose_interpolation_delay_s || 0.25),
      interpolation_timeout_s: Number(payload.interpolation_timeout_s || 1.0),
      pointcloud_context_max_gap_ms: Number(payload.pointcloud_context_max_gap_ms || 150),
      save_pointcloud_context: payload.save_pointcloud_context !== false,
      duration_s: Number(payload.duration_s || 0),
      max_frames: Number(payload.max_frames || 0)
    };
  }

  async function runCaptureStartTask(auth, vehicleId, baseCaptureArgs) {
    const starts = [];
    let capabilities = null;
    let calibration = null;
    try {
      updateState({
        phase: 'starting_capture',
        active_username: auth.username,
        stage_text: `正在读取 ${vehicleId} 3DGS 采集能力。`,
        error_message: null
      });
      capabilities = await getCaptureCapabilities(vehicleId);
      if (!capabilities.ok) {
        throw new Error(capabilities.error || 'three_dgs_capture_capabilities_unavailable');
      }
      const enabledCameras = enabledCameraIdsFromCapabilities(capabilities);
      if (!enabledCameras.length) {
        throw new Error('three_dgs_no_calibrated_cameras');
      }

      mergeVehicleData({
        vehicle_id: vehicleId,
        configured_cameras: configuredCameraIds,
        calibrated_cameras: enabledCameras,
        capabilities
      });

      calibration = await callVehicleTool(vehicleId, 'vehicle.calibration', { include_lidar_extrinsics: true }, 30).catch((error) => ({
        error: error.message
      }));

      if (capabilities.multi_camera_start_supported) {
        updateState({
          phase: 'starting_capture',
          stage_text: `正在启动 ${vehicleId} 3DGS 车辆级采集 session。`
        });
        const started = await callVehicleTool(
          vehicleId,
          '3dgs.capture.start',
          { ...baseCaptureArgs, camera: 'all' },
          35
        );
        const session = normalizeSession(started);
        starts.push({
          camera: 'all',
          response: started,
          session
        });
        const sessionIds = sessionIdsFromChildSessions(session, enabledCameras);
        const parentSessionId = sessionIdFromSession(session);
        updateNestedState('capture', {
          vehicle_id: vehicleId,
          active: true,
          multi_camera: true,
          session_id: parentSessionId || null,
          session_ids: sessionIds,
          child_sessions: Object.fromEntries(childSessionEntries(session).map((item) => [item.camera, item.session])),
          cameras: enabledCameras,
          saved_frames: savedFramesFromSession(session),
          camera_statuses: enabledCameras.map((camera) => normalizeCaptureStatusEntryFromSession(camera, sessionIds[camera] ? { session_id: sessionIds[camera], active: true } : session)),
          last_response: { capabilities, calibration, starts },
          started_at_ms: Date.now(),
          stopped_at_ms: null
        });
        broadcastCaptureStreamEvent('capture_status', captureStreamPayload());
      } else {
        for (const camera of enabledCameras) {
          updateState({
            phase: 'starting_capture',
            stage_text: `正在启动 ${vehicleId} 3DGS 车辆级采集 session。`
          });
          const started = await callVehicleTool(
            vehicleId,
            '3dgs.capture.start',
            {
              ...baseCaptureArgs,
              camera
            },
            35
          );
          starts.push({
            camera,
            response: started,
            session: normalizeSession(started)
          });
          updateNestedState('capture', {
            vehicle_id: vehicleId,
            active: true,
            multi_camera: false,
            cameras: starts.map((item) => item.camera),
            last_response: { capabilities, calibration, starts }
          });
          broadcastCaptureStreamEvent('capture_status', captureStreamPayload());
        }
      }

      const sessionIds = capabilities.multi_camera_start_supported
        ? state.capture.session_ids || {}
        : Object.fromEntries(starts.map((item) => [item.camera, item.session?.session_id || item.session?.session?.session_id || null]));
      const sessionIdList = uniqueStrings([
        state.capture.session_id,
        ...starts.map((item) => item.session?.session_id || item.session?.session?.session_id || null),
        ...Object.values(sessionIds || {})
      ]);
      if (!capabilities.multi_camera_start_supported) {
        updateNestedState('capture', {
          vehicle_id: vehicleId,
          active: true,
          multi_camera: false,
          session_id: sessionIdList.length === 1 ? sessionIdList[0] : sessionIdList.join(',') || null,
          session_ids: sessionIds,
          child_sessions: {},
          cameras: enabledCameras,
          saved_frames: 0,
          last_response: {
            capabilities,
            calibration,
            starts
          },
          started_at_ms: Date.now(),
          stopped_at_ms: null
        });
      }
      mergeVehicleData({
        vehicle_id: vehicleId,
        calibration,
        configured_cameras: configuredCameraIds,
        calibrated_cameras: enabledCameras
      });
      updateState({
        phase: 'capturing',
        active_username: auth.username,
        stage_text: `车端 ${vehicleId} 3DGS 车辆级采集 session 已启动。`,
        error_message: null
      });
      broadcastCaptureStreamEvent('capture_status', captureStreamPayload());
      scheduleCaptureMonitor(0);
    } catch (error) {
      for (const item of starts) {
        await callVehicleTool(
          vehicleId,
          '3dgs.capture.stop',
          item.camera === 'all'
            ? { reason: 'rollback_after_partial_start_failed' }
            : {
                reason: 'rollback_after_partial_start_failed',
                camera: item.camera
              },
          20
        ).catch(() => null);
      }
      updateNestedState('capture', {
        vehicle_id: vehicleId,
        active: false,
        cameras: starts.map((item) => item.camera),
        last_response: {
          capabilities,
          calibration,
          starts,
          error: error.message || 'three_dgs_capture_start_failed'
        },
        stopped_at_ms: Date.now()
      });
      updateState({
        phase: state.dataset.prepared ? 'prepared' : 'idle',
        stage_text: '启动车端 3DGS 采集失败。',
        error_message: error.message || 'three_dgs_capture_start_failed'
      });
      broadcastCaptureStreamEvent('capture_status', captureStreamPayload());
    } finally {
      captureStartInFlight = false;
    }
  }

  function queueCaptureStart(auth, payload = {}) {
    if (captureStartInFlight || uploadInFlight || state.prepare.running || state.train.running) {
      const error = new Error('three_dgs_busy');
      error.status = 409;
      throw error;
    }
    if (state.capture.active) {
      const error = new Error('three_dgs_capture_already_active');
      error.status = 409;
      throw error;
    }
    const vehicleId = resolveThreeDgsVehicleId(payload.vehicle_id);
    const baseCaptureArgs = buildCaptureStartArgs(payload);
    captureStartInFlight = true;
    updateNestedState('capture', {
      vehicle_id: vehicleId,
      active: false,
      cameras: [],
      last_response: null,
      started_at_ms: null,
      stopped_at_ms: null
    });
    updateState({
      phase: 'starting_capture',
      active_username: auth.username,
      stage_text: `已下发 ${vehicleId} 3DGS 采集启动任务，等待车端返回。`,
      error_message: null
    });
    broadcastCaptureStreamEvent('capture_status', captureStreamPayload());
    scheduleCaptureMonitor(0);
    setImmediate(() => {
      void runCaptureStartTask(auth, vehicleId, baseCaptureArgs);
    });
  }

  async function handleUpload(req, res, kind) {
    await syncUploadedArtifacts();
    if (captureStartInFlight || uploadInFlight || state.prepare.running || state.train.running) {
      return res.status(409).json({
        ok: false,
        error: 'three_dgs_busy'
      });
    }

    const rawFileName = decodeURIComponent(String(req.headers['x-file-name'] || ''));
    const safeFileName = sanitizeFileName(rawFileName, kind === 'pointcloud' ? 'pointcloud.pcd' : 'image_pose.zip');
    const expectedSize = Number(req.headers['x-file-size'] || req.headers['content-length'] || 0);
    if (Number.isFinite(expectedSize) && expectedSize > uploadMaxBytes) {
      return res.status(413).json({
        ok: false,
        error: 'file_too_large'
      });
    }

    const ext = path.extname(safeFileName).toLowerCase();
    if (kind === 'pointcloud' && !['.pcd', '.ply'].includes(ext)) {
      return res.status(400).json({ ok: false, error: 'pointcloud_file_required' });
    }
    if (kind === 'image_pose' && !['.zip', '.tar', '.tgz', '.gz', '.json', '.jsonl'].includes(ext)) {
      return res.status(400).json({ ok: false, error: 'image_pose_package_required' });
    }

    uploadInFlight = true;
    await ensureRuntimeDirs();
    const targetBase = kind === 'pointcloud' ? pointcloudUploadPath : imagePoseUploadPath;
    const targetPath = `${targetBase}${ext || '.bin'}`;
    const partPath = `${targetPath}.part`;
    await fsp.rm(partPath, { force: true });

    updateState({
      phase: 'uploading',
      active_username: req.threeDgsAuth.username,
      stage_text: `正在上传 ${kind === 'pointcloud' ? '点云地图' : '图像-位姿包'}。`,
      error_message: null
    });

    let receivedBytes = 0;
    let failed = false;
    const writeStream = fs.createWriteStream(partPath, { flags: 'w' });

    const failUpload = async (message, statusCode = 500) => {
      if (failed) return;
      failed = true;
      uploadInFlight = false;
      writeStream.destroy();
      await fsp.rm(partPath, { force: true }).catch(() => {});
      updateState({
        phase: state.dataset.prepared ? 'prepared' : 'idle',
        stage_text: message,
        error_message: message
      });
      if (!res.headersSent) {
        res.status(statusCode).json({ ok: false, error: message });
      }
    };

    req.on('data', (chunk) => {
      receivedBytes += chunk.length;
      if (receivedBytes > uploadMaxBytes) {
        void failUpload('file_too_large', 413);
        req.destroy();
      }
    });
    req.on('aborted', () => void failUpload('upload_aborted', 499));
    req.on('error', (error) => void failUpload(error?.message || 'upload_failed'));
    writeStream.on('error', (error) => void failUpload(error?.message || 'file_write_failed'));
    writeStream.on('finish', async () => {
      if (failed) return;
      try {
        await fsp.rm(targetPath, { force: true });
        await fsp.rename(partPath, targetPath);
        const stat = await safeStat(targetPath);
        uploadInFlight = false;
        const uploadInfo = {
          name: safeFileName,
          path: targetPath,
          size_bytes: stat?.size || receivedBytes,
          updated_at_ms: stat?.mtimeMs || Date.now()
        };
        updateState({
          phase: 'idle',
          active_username: req.threeDgsAuth.username,
          stage_text: `${kind === 'pointcloud' ? '点云地图' : '图像-位姿包'}上传完成。`,
          uploads: {
            ...state.uploads,
            [kind]: uploadInfo
          },
          error_message: null
        });
        return res.json(makeStatusResponse(req.threeDgsAuth));
      } catch (error) {
        return failUpload(error?.message || 'upload_finalize_failed');
      }
    });

    req.pipe(writeStream);
  }

  async function startPrepareTask(auth, payload = {}) {
    if (captureStartInFlight || prepareProcess || state.prepare.running || state.train.running) {
      throw new Error('three_dgs_busy');
    }
    if (!state.uploads.image_pose?.path || !state.uploads.pointcloud?.path) {
      throw new Error('three_dgs_uploads_required');
    }

    const sceneName = sanitizeSceneName(payload.scene_name) || makeRunId('scene');
    const outputDir = path.join(datasetRoot, sceneName);
    const logPath = path.join(logDir, `prepare-${sceneName}.log`);
    await fsp.rm(outputDir, { recursive: true, force: true });
    await fsp.rm(logPath, { force: true });
    await ensureRuntimeDirs();

    updateState({
      phase: 'preparing',
      active_username: auth.username,
      stage_text: '正在规整 COLMAP/3DGS 训练数据。',
      error_message: null,
      dataset: {
        ...state.dataset,
        prepared: false,
        scene_name: sceneName,
        path: outputDir,
        summary: null,
        prepared_at_ms: null,
        stale_reason: null,
        stale_at_ms: null,
        previous_scene_name: null,
        previous_path: null
      },
      prepare: {
        running: true,
        pid: null,
        log_path: logPath,
        started_at_ms: Date.now(),
        completed_at_ms: null,
        progress: {
          stage: 'queued',
          stage_label: '等待启动预处理',
          progress_pct: 0,
          detail: '准备启动 COLMAP 数据规整',
          updated_at_ms: Date.now()
        }
      }
    });

    const args = [
      prepareScriptPath,
      '--image-pose',
      state.uploads.image_pose.path,
      '--pointcloud',
      state.uploads.pointcloud.path,
      '--output',
      outputDir,
      '--scene-name',
      sceneName,
      '--max-points',
      String(Number(payload.max_points || 500000)),
      '--undistort',
      payload.undistort === false ? 'false' : 'true',
      '--undistort-mode',
      defaultUndistortMode,
      '--colorize-points',
      colorizeInitialPoints ? 'true' : 'false',
      '--filter-visible-points',
      filterVisibleInitialPoints ? 'true' : 'false',
      '--colorize-max-frames',
      String(Number.isFinite(colorizeMaxFrames) ? colorizeMaxFrames : 640),
      '--colorize-min-observations',
      String(Number.isFinite(colorizeMinObservations) ? colorizeMinObservations : 2),
      '--colorize-min-kept-points',
      String(Number.isFinite(colorizeMinKeptPoints) ? colorizeMinKeptPoints : 20000),
      '--colorize-occlusion-cell-px',
      String(Number.isFinite(colorizeOcclusionCellPx) ? colorizeOcclusionCellPx : 8),
      '--colorize-depth-tolerance-m',
      String(Number.isFinite(colorizeDepthToleranceM) ? colorizeDepthToleranceM : 1.0),
      '--colorize-min-depth-m',
      String(Number.isFinite(colorizeMinDepthM) ? colorizeMinDepthM : 0.1)
    ];

    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    prepareProcess = spawn('python3', args, {
      cwd: path.resolve(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    updateNestedState('prepare', { pid: prepareProcess.pid });
    prepareProcess.stdout.pipe(logStream);
    prepareProcess.stderr.pipe(logStream);
    prepareProcess.on('error', async (error) => {
      prepareProcess = null;
      logStream.end();
      updateState({
        phase: 'error',
        stage_text: 'COLMAP 数据规整启动失败。',
        error_message: error?.message || 'prepare_spawn_failed',
        prepare: {
          ...state.prepare,
          running: false,
          completed_at_ms: Date.now()
        }
      });
    });
    prepareProcess.on('exit', async (code, signal) => {
      prepareProcess = null;
      logStream.end();
      const summaryPath = path.join(outputDir, 'three_dgs_dataset_summary.json');
      if (signal || code !== 0) {
        const progress = await readPrepareProgressFile(outputDir);
        updateState({
          phase: 'error',
          stage_text: signal ? `COLMAP 数据规整被中断：${signal}` : `COLMAP 数据规整失败，exit code=${code}`,
          error_message: signal || `prepare_exit_${code}`,
          prepare: {
            ...state.prepare,
            running: false,
            completed_at_ms: Date.now(),
            progress: progress || state.prepare.progress || null
          }
        });
        return;
      }

      let summary = null;
      try {
        summary = JSON.parse(await fsp.readFile(summaryPath, 'utf8'));
      } catch (_error) {
        summary = null;
      }
      const progress = await readPrepareProgressFile(outputDir);
      updateState({
        phase: 'prepared',
        stage_text: 'COLMAP 数据已规整完成，可以同步到 A100 开始训练。',
        error_message: null,
        dataset: {
          ...state.dataset,
          prepared: true,
          summary,
          prepared_at_ms: Date.now(),
          stale_reason: null,
          stale_at_ms: null,
          previous_scene_name: null,
          previous_path: null
        },
        prepare: {
          ...state.prepare,
          running: false,
          completed_at_ms: Date.now(),
          progress: progress || state.prepare.progress || null
        }
      });
    });
  }

  function sshBaseArgs() {
    return ['-i', sshKeyPath, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3'];
  }

  function sshTarget() {
    return `${a100User}@${a100Host}`;
  }

  function remoteQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
  }

  async function execSsh(command, timeoutMs = 15000) {
    const args = [...sshBaseArgs(), sshTarget(), command];
    const result = await execFileAsync('ssh', args, {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024
    });
    return result.stdout;
  }

  async function datasetFileStats(datasetPath) {
    const files = await listFilesRecursive(datasetPath);
    let totalBytes = 0;
    for (const filePath of files) {
      const stat = await safeStat(filePath);
      if (stat?.isFile?.()) {
        totalBytes += Number(stat.size || 0);
      }
    }
    return {
      file_count: files.length,
      total_bytes: totalBytes
    };
  }

  async function makeDatasetSyncMarker(datasetPath = state.dataset?.path) {
    if (!datasetPath) {
      throw new Error('three_dgs_dataset_not_prepared');
    }
    const stats = await datasetFileStats(datasetPath);
    const summary = state.dataset.summary || {};
    const markerSource = {
      version: 1,
      scene_name: state.dataset.scene_name || path.basename(datasetPath),
      dataset_path: path.resolve(datasetPath),
      prepared_at_ms: Number(state.dataset.prepared_at_ms || 0),
      image_count: Number(summary.image_count || 0),
      point_count: Number(summary.point_count || 0),
      camera_count: Number(summary.camera_count || 0),
      colorization_enabled: Boolean(summary.colorization?.enabled),
      file_count: stats.file_count,
      total_bytes: stats.total_bytes
    };
    const fingerprint = crypto
      .createHash('sha256')
      .update(JSON.stringify(markerSource))
      .digest('hex');
    return {
      ...markerSource,
      fingerprint,
      created_at_ms: Date.now()
    };
  }

  function remoteDatasetPathForCurrentDataset() {
    const datasetName = sanitizeSceneName(state.dataset?.scene_name || '');
    return `${remoteDatasetRoot}/${datasetName || 'scene'}`;
  }

  async function readRemoteDatasetSyncMarker(remoteDatasetPath) {
    const output = await execSsh(
      `cat ${remoteQuote(`${remoteDatasetPath}/.cloud_control_sync.json`)} 2>/dev/null || true`,
      10000
    );
    if (!output.trim()) return null;
    try {
      const parsed = JSON.parse(output.trim());
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (_error) {
      return null;
    }
  }

  async function remoteDatasetMatchesMarker(remoteDatasetPath, marker) {
    if (!remoteDatasetPath || !marker?.fingerprint) return false;
    const remoteMarker = await readRemoteDatasetSyncMarker(remoteDatasetPath);
    return Boolean(
      remoteMarker &&
      remoteMarker.fingerprint === marker.fingerprint &&
      Number(remoteMarker.file_count || 0) === Number(marker.file_count || 0) &&
      Number(remoteMarker.total_bytes || 0) === Number(marker.total_bytes || 0)
    );
  }

  async function writeRemoteDatasetSyncMarker(remoteDatasetPath, marker) {
    const content = JSON.stringify({
      ...marker,
      synced_at_ms: Date.now(),
      synced_at_iso: new Date().toISOString()
    });
    await execSsh(
      `printf %s ${remoteQuote(content)} > ${remoteQuote(`${remoteDatasetPath}/.cloud_control_sync.json`)}`,
      10000
    );
  }

  function parseRsyncProgressChunk(chunk) {
    const text = stripAnsi(String(chunk || '').replace(/\r/g, '\n'));
    const matches = [...text.matchAll(/([\d,]+)\s+(\d+(?:\.\d+)?)%/g)];
    const last = matches[matches.length - 1];
    if (!last) return null;
    const transferredBytes = Number(last[1].replace(/,/g, ''));
    const progressPct = Number(last[2]);
    if (!Number.isFinite(transferredBytes) || !Number.isFinite(progressPct)) return null;
    return {
      transferred_bytes: transferredBytes,
      progress_pct: progressPct
    };
  }

  function updateTrainSyncProgress(patch = {}) {
    const progress = {
      ...(state.train.sync_progress || {}),
      ...patch,
      updated_at_ms: Date.now()
    };
    const pctText = Number.isFinite(Number(progress.progress_pct))
      ? `${Math.max(0, Math.min(100, Number(progress.progress_pct))).toFixed(1)}%`
      : '';
    const bytesText = progress.total_bytes
      ? `${formatBytesForStatus(progress.transferred_bytes || 0)} / ${formatBytesForStatus(progress.total_bytes)}`
      : formatBytesForStatus(progress.transferred_bytes || 0);
    updateState({
      stage_text: progress.status === 'skipped'
        ? 'A100 已有匹配的训练数据，跳过同步并启动训练。'
        : progress.status === 'completed'
          ? '训练数据已同步到 A100，正在启动训练。'
          : `同步数据到 A100${pctText ? `：${pctText}` : ''}${bytesText ? ` · ${bytesText}` : ''}`,
      train: {
        ...state.train,
        sync_progress: progress
      }
    });
  }

  function sanitizeRunId(value) {
    return String(value || '')
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120);
  }

  function currentViewerRun(payload = {}) {
    const runId = sanitizeRunId(state.train.run_id);
    const requestedRunId = sanitizeRunId(payload.run_id || runId);
    const remoteRunPath = state.train.remote_run_path;
    if (!runId || !remoteRunPath) {
      throw new Error('three_dgs_train_result_not_available');
    }
    if (requestedRunId && requestedRunId !== runId) {
      throw new Error('three_dgs_run_id_mismatch');
    }
    return { runId, remoteRunPath };
  }

  async function findRemotePointCloud(remoteRunPath) {
    const output = await execSsh(
      `find ${remoteQuote(`${remoteRunPath}/point_cloud`)} -path '*/point_cloud.ply' -type f 2>/dev/null | sort -V | tail -n 1`,
      12000
    );
    const remotePointCloud = output.trim().split('\n').filter(Boolean).pop();
    if (!remotePointCloud) {
      throw new Error('remote_point_cloud_not_found');
    }
    return remotePointCloud;
  }

  async function findLatestRemoteCheckpoint(remoteRunPath) {
    if (!remoteRunPath) return null;
    const output = await execSsh(
      [
        `RUN_DIR=${remoteQuote(remoteRunPath)}`,
        'find "$RUN_DIR" -maxdepth 1 -type f -name "chkpnt*.pth" -printf "%f\\t%p\\n" 2>/dev/null |',
        'sed -nE "s/^chkpnt([0-9]+)\\.pth\\t(.*)$/\\1\\t\\2/p" |',
        'sort -n | tail -n 1'
      ].join('\n'),
      12000
    );
    const line = output.trim().split('\n').filter(Boolean).pop();
    if (!line) return null;
    const [iterationText, ...pathParts] = line.split('\t');
    const iteration = Number(iterationText);
    const checkpointPath = pathParts.join('\t').trim();
    if (!Number.isFinite(iteration) || !checkpointPath) return null;
    return {
      iteration,
      path: checkpointPath
    };
  }

  function makeRemoteStopCommand(remoteRunPath, remotePid) {
    return [
      'set -Eeuo pipefail',
      `RUN_DIR=${remoteQuote(remoteRunPath)}`,
      `REMOTE_PID=${remoteQuote(remotePid || '')}`,
      'STATUS_FILE="$RUN_DIR/status.json"',
      'PID_FILE="$RUN_DIR/train.pid"',
      'LOG_FILE="$RUN_DIR/train.log"',
      'mkdir -p "$RUN_DIR"',
      'if [ -z "$REMOTE_PID" ] && [ -f "$PID_FILE" ]; then REMOTE_PID="$(cat "$PID_FILE" 2>/dev/null || true)"; fi',
      'printf "\\n[%s] stop requested from cloud\\n" "$(date -Iseconds)" >> "$LOG_FILE"',
      'kill_tree() {',
      '  local parent="$1"',
      '  [ -n "$parent" ] || return 0',
      '  kill -0 "$parent" 2>/dev/null || return 0',
      '  local child',
      '  for child in $(pgrep -P "$parent" 2>/dev/null || true); do',
      '    kill_tree "$child"',
      '  done',
      '  kill -TERM "$parent" 2>/dev/null || true',
      '}',
      'if [ -n "$REMOTE_PID" ]; then kill_tree "$REMOTE_PID"; fi',
      'sleep 4',
      'if [ -n "$REMOTE_PID" ] && kill -0 "$REMOTE_PID" 2>/dev/null; then',
      '  for child in $(pgrep -P "$REMOTE_PID" 2>/dev/null || true); do kill -KILL "$child" 2>/dev/null || true; done',
      '  kill -KILL "$REMOTE_PID" 2>/dev/null || true',
      'fi',
      'printf \'{"phase":"stopped","ts":"%s","exit_code":143,"reason":"operator_stopped"}\\n\' "$(date -Iseconds)" > "$STATUS_FILE"',
      'rm -f "$PID_FILE"',
      'echo stopped'
    ].join('\n');
  }

  async function syncViewerPointCloud(payload = {}) {
    const { runId, remoteRunPath } = currentViewerRun(payload);
    const remotePointCloud = await findRemotePointCloud(remoteRunPath);
    const localDir = path.join(resultRoot, runId);
    const localPath = path.join(localDir, 'point_cloud.ply');
    const partPath = `${localPath}.part`;
    await fsp.mkdir(localDir, { recursive: true });
    await fsp.rm(partPath, { force: true });
    const rsyncArgs = ['-az', '-e', ['ssh', ...sshBaseArgs()].join(' '), `${sshTarget()}:${remotePointCloud}`, partPath];
    await execFileAsync('rsync', rsyncArgs, {
      timeout: Number(process.env.THREE_DGS_RESULT_SYNC_TIMEOUT_MS || 300000),
      maxBuffer: 2 * 1024 * 1024
    });
    await fsp.rename(partPath, localPath);
    const stat = await safeStat(localPath);
    const pointCloudUrl = `/api/three-dgs/results/${encodeURIComponent(runId)}/point_cloud.ply?ts=${Math.round(stat?.mtimeMs || Date.now())}`;
    const viewer = {
      run_id: runId,
      local_point_cloud_path: localPath,
      point_cloud_url: pointCloudUrl,
      size_bytes: stat?.size || null,
      synced_at_ms: Date.now(),
      source_remote_path: remotePointCloud,
      error_message: null
    };
    updateState({
      phase: state.phase === 'error' && state.train.phase === 'completed' ? 'completed' : state.phase,
      stage_text: '3DGS 训练结果已同步到网站，可在浏览器中查看。',
      error_message: null,
      viewer
    });
    return viewer;
  }

  function makeRemoteTrainCommand(remoteDatasetPath, remoteRunPath, trainOptions) {
    const iterations = Number(trainOptions.iterations || 10000);
    const resolution = Number(trainOptions.resolution || defaultTrainResolution);
    const gpu = String(trainOptions.gpu ?? defaultTrainGpu).trim() || defaultTrainGpu;
    const resume = Boolean(trainOptions.resume);
    const checkpointInterval = Math.max(100, Number(trainOptions.checkpointInterval || defaultCheckpointInterval));
    const script = [
      'set -Eeuo pipefail',
      `RUN_DIR=${remoteQuote(remoteRunPath)}`,
      `DATASET_DIR=${remoteQuote(remoteDatasetPath)}`,
      'mkdir -p "$RUN_DIR"',
      'STATUS_FILE="$RUN_DIR/status.json"',
      'LOG_FILE="$RUN_DIR/train.log"',
      'PID_FILE="$RUN_DIR/train.pid"',
      'cat > "$RUN_DIR/run_train.sh" <<\'EOS\'',
      '#!/usr/bin/env bash',
      'set -Eeuo pipefail',
      `RUN_DIR=${remoteQuote(remoteRunPath)}`,
      `DATASET_DIR=${remoteQuote(remoteDatasetPath)}`,
      `SOURCE_DIR=${remoteQuote(remoteSourceRoot)}`,
      `ENV_NAME=${remoteQuote(remoteEnvName)}`,
      `ITERATIONS=${iterations}`,
      `RESOLUTION=${resolution}`,
      `GPU=${remoteQuote(gpu)}`,
      `RESUME=${resume ? 1 : 0}`,
      `CHECKPOINT_INTERVAL=${checkpointInterval}`,
      'STATUS_FILE="$RUN_DIR/status.json"',
      'LOG_FILE="$RUN_DIR/train.log"',
      'PID_FILE="$RUN_DIR/train.pid"',
      'write_status() { printf \'{"phase":"%s","ts":"%s","exit_code":%s}\\n\' "$1" "$(date -Iseconds)" "${2:-0}" > "$STATUS_FILE"; }',
      'kill_children() {',
      '  local child',
      '  for child in $(pgrep -P "$$" 2>/dev/null || true); do',
      '    kill -TERM "$child" 2>/dev/null || true',
      '  done',
      '}',
      'on_stop() {',
      '  write_status stopped 143',
      '  printf "\\n[%s] training stopped by cloud request\\n" "$(date -Iseconds)" >> "$LOG_FILE"',
      '  kill_children',
      '  exit 143',
      '}',
      'trap on_stop TERM INT',
      'echo "$$" > "$PID_FILE"',
      'write_status running 0',
      '{',
      '  export MAMBA_ROOT_PREFIX="$HOME/.micromamba"',
      '  export CUDA_HOME="$HOME/.micromamba/envs/$ENV_NAME"',
      '  export PATH="$CUDA_HOME/bin:$PATH"',
      '  export LD_LIBRARY_PATH="$CUDA_HOME/lib:$CUDA_HOME/lib64:${LD_LIBRARY_PATH:-}"',
      '  export PYTHONNOUSERSITE=1',
      '  export TORCH_CUDA_ARCH_LIST=8.0',
      '  export CUDA_VISIBLE_DEVICES="$GPU"',
      '  cd "$SOURCE_DIR"',
      '  CHECKPOINT_ARGS=()',
      '  if [ "$CHECKPOINT_INTERVAL" -gt 0 ]; then',
      '    next_checkpoint="$CHECKPOINT_INTERVAL"',
      '    while [ "$next_checkpoint" -lt "$ITERATIONS" ]; do',
      '      CHECKPOINT_ARGS+=("$next_checkpoint")',
      '      next_checkpoint=$((next_checkpoint + CHECKPOINT_INTERVAL))',
      '    done',
      '  fi',
      '  CHECKPOINT_ARGS+=("$ITERATIONS")',
      '  START_CHECKPOINT_ARGS=()',
      '  if [ "$RESUME" = "1" ]; then',
      '    START_CHECKPOINT="$(find "$RUN_DIR" -maxdepth 1 -type f -name "chkpnt*.pth" -printf "%f\\t%p\\n" 2>/dev/null | sed -nE "s/^chkpnt([0-9]+)\\.pth\\t(.*)$/\\1\\t\\2/p" | sort -n | tail -n 1 | cut -f2-)"',
      '    if [ -z "$START_CHECKPOINT" ]; then',
      '      printf "\\n[%s] no checkpoint available for resume\\n" "$(date -Iseconds)" >> "$LOG_FILE"',
      '      write_status error 22',
      '      exit 22',
      '    fi',
      '    START_CHECKPOINT_ARGS=(--start_checkpoint "$START_CHECKPOINT")',
      '    printf "\\n[%s] resume from checkpoint: %s\\n" "$(date -Iseconds)" "$START_CHECKPOINT" >> "$LOG_FILE"',
      '  fi',
      '  "$HOME/.local/bin/micromamba" run -n "$ENV_NAME" python train.py \\',
      '    -s "$DATASET_DIR" \\',
      '    -m "$RUN_DIR" \\',
      '    --iterations "$ITERATIONS" \\',
      '    --save_iterations "$ITERATIONS" \\',
      '    --checkpoint_iterations "${CHECKPOINT_ARGS[@]}" \\',
      '    --data_device cpu \\',
      '    -r "$RESOLUTION" \\',
      '    "${START_CHECKPOINT_ARGS[@]}"',
      '  write_status completed 0',
      '  rm -f "$PID_FILE"',
      '} >> "$LOG_FILE" 2>&1 || { code=$?; if [ "$code" != "143" ]; then write_status error "$code"; fi; rm -f "$PID_FILE"; exit "$code"; }',
      'EOS',
      'chmod +x "$RUN_DIR/run_train.sh"',
      'nohup bash "$RUN_DIR/run_train.sh" >/dev/null 2>&1 & pid=$!; echo "$pid" > "$PID_FILE"; echo $pid'
    ];
    return script.join('\n');
  }

  function markTrainingStopped(reason = 'operator_stopped', extraTrainPatch = {}) {
    updateState({
      phase: 'stopped',
      stage_text: 'A100 3DGS 训练已停止；可以继续训练或重新开始。',
      error_message: null,
      train: {
        ...state.train,
        phase: 'stopped',
        running: false,
        remote_status: {
          ...(state.train.remote_status || {}),
          phase: 'stopped',
          reason
        },
        completed_at_ms: Date.now(),
        error_message: null,
        ...extraTrainPatch
      }
    });
  }

  async function launchRemoteTraining({ localLogPath, remoteDatasetPath, remoteRunPath, gpu, iterations, resolution, resume, checkpoint }) {
    await appendToLog(localLogPath, `${resume ? 'resume' : 'start'} remote training`);
    const command = makeRemoteTrainCommand(remoteDatasetPath, remoteRunPath, {
      gpu,
      iterations,
      resolution,
      resume,
      checkpointInterval: defaultCheckpointInterval
    });
    const stdout = await execSsh(command, 30000);
    const pid = stdout.trim().split(/\s+/).filter(Boolean).pop() || null;
    updateState({
      phase: 'training',
      stage_text: resume
        ? `A100 训练已从 checkpoint 继续，remote pid=${pid || '-'}。`
        : `A100 训练已启动，remote pid=${pid || '-'}。`,
      error_message: null,
      train: {
        ...state.train,
        phase: 'training',
        running: true,
        remote_pid: pid,
        remote_status: { phase: 'running' },
        resume_from_checkpoint: checkpoint?.path || null,
        resume_from_iteration: checkpoint?.iteration || null,
        checkpoint_interval: defaultCheckpointInterval,
        last_remote_status_check_ms: null,
        error_message: null
      }
    });
  }

  async function startTrainingTask(auth, payload = {}, options = {}) {
    const resume = Boolean(options.resume || payload.resume);
    if (trainBootstrapProcess || state.train.running || state.prepare.running) {
      throw new Error('three_dgs_busy');
    }

    let checkpoint = null;
    let runId = null;
    let localLogPath = null;
    let remoteDatasetPath = null;
    let remoteRunPath = null;
    if (resume) {
      runId = sanitizeRunId(state.train.run_id);
      remoteDatasetPath = state.train.remote_dataset_path;
      remoteRunPath = state.train.remote_run_path;
      localLogPath = state.train.local_log_path || path.join(logDir, `train-bootstrap-${runId || 'resume'}.log`);
      if (!runId || !remoteDatasetPath || !remoteRunPath) {
        throw new Error('three_dgs_resume_context_missing');
      }
      checkpoint = await findLatestRemoteCheckpoint(remoteRunPath);
      if (!checkpoint) {
        throw new Error('three_dgs_checkpoint_not_found');
      }
    } else {
      if (!state.dataset.prepared || !state.dataset.path) {
        throw new Error('three_dgs_dataset_not_prepared');
      }
      runId = makeRunId(state.dataset.scene_name || payload.scene_name || 'scene');
      localLogPath = path.join(logDir, `train-bootstrap-${runId}.log`);
      remoteDatasetPath = remoteDatasetPathForCurrentDataset();
      remoteRunPath = `${remoteRunRoot}/${runId}`;
      await fsp.rm(localLogPath, { force: true });
    }

    trainStopRequested = false;
    const gpu = String(payload.gpu ?? state.train.gpu ?? defaultTrainGpu).trim() || defaultTrainGpu;
    const iterations = Number(payload.iterations || state.train.iterations || 10000);
    const resolution = Number(payload.resolution || state.train.resolution || defaultTrainResolution);
    const datasetMarker = resume ? null : await makeDatasetSyncMarker(state.dataset.path);

    updateState({
      phase: 'training',
      active_username: auth.username,
      stage_text: resume
        ? `正在从 checkpoint ${checkpoint.iteration} 继续 A100 训练。`
        : '正在同步数据到 A100 并启动 3DGS 训练。',
      error_message: null,
      viewer: resume ? state.viewer : createInitialState().viewer,
      train: {
        ...state.train,
        phase: resume ? 'resuming' : 'syncing',
        running: true,
        run_id: runId,
        local_log_path: localLogPath,
        remote_dataset_path: remoteDatasetPath,
        remote_run_path: remoteRunPath,
        remote_status: null,
        remote_pid: null,
        resume_from_checkpoint: checkpoint?.path || null,
        resume_from_iteration: checkpoint?.iteration || null,
        checkpoint_interval: defaultCheckpointInterval,
        mode: resume ? 'resume' : 'restart',
        sync_progress: resume
          ? state.train.sync_progress
          : {
              status: 'queued',
              progress_pct: 0,
              transferred_bytes: 0,
              total_bytes: datasetMarker.total_bytes,
              file_count: datasetMarker.file_count,
              detail: '等待同步训练数据到 A100',
              updated_at_ms: Date.now()
            },
        dataset_fingerprint: datasetMarker?.fingerprint || state.train.dataset_fingerprint || null,
        remote_dataset_synced_at_ms: null,
        gpu,
        iterations,
        resolution,
        started_at_ms: Date.now(),
        completed_at_ms: null,
        last_remote_status_check_ms: null,
        error_message: null
      }
    });

    if (resume) {
      try {
        await launchRemoteTraining({
          localLogPath,
          remoteDatasetPath,
          remoteRunPath,
          gpu,
          iterations,
          resolution,
          resume: true,
          checkpoint
        });
      } catch (error) {
        updateState({
          phase: 'error',
          stage_text: 'A100 继续训练启动失败。',
          error_message: error?.message || 'remote_train_resume_failed',
          train: {
            ...state.train,
            phase: 'error',
            running: false,
            error_message: error?.message || 'remote_train_resume_failed',
            completed_at_ms: Date.now()
          }
        });
      }
      return;
    }

    await appendToLog(localLogPath, `ensure remote directories ${remoteDatasetPath} and ${remoteRunPath}`);
    try {
      await execSsh(`mkdir -p ${remoteQuote(remoteDatasetPath)} ${remoteQuote(remoteRunPath)}`, 15000);
    } catch (error) {
      await appendToLog(localLogPath, `remote mkdir failed: ${error?.message || 'unknown error'}`);
      updateState({
        phase: 'error',
        stage_text: 'A100 远端目录创建失败。',
        error_message: error?.message || 'remote_mkdir_failed',
        train: {
          ...state.train,
          phase: 'error',
          running: false,
          error_message: error?.message || 'remote_mkdir_failed',
          completed_at_ms: Date.now()
        }
      });
      return;
    }

    const remoteSynced = await remoteDatasetMatchesMarker(remoteDatasetPath, datasetMarker).catch(() => false);
    if (remoteSynced) {
      await appendToLog(localLogPath, `remote dataset already synced; reuse ${remoteDatasetPath}`);
      updateTrainSyncProgress({
        status: 'skipped',
        progress_pct: 100,
        transferred_bytes: datasetMarker.total_bytes,
        total_bytes: datasetMarker.total_bytes,
        file_count: datasetMarker.file_count,
        detail: 'A100 已有匹配 dataset，跳过 rsync'
      });
      await launchRemoteTraining({
        localLogPath,
        remoteDatasetPath,
        remoteRunPath,
        gpu,
        iterations,
        resolution,
        resume: false,
        checkpoint: null
      });
      updateNestedState('train', {
        remote_dataset_synced_at_ms: Date.now()
      });
      return;
    }

    const logStream = fs.createWriteStream(localLogPath, { flags: 'a' });
    const rsyncArgs = [
      '-az',
      '--delete',
      '--info=progress2',
      '--stats',
      '-e',
      ['ssh', ...sshBaseArgs()].join(' '),
      `${state.dataset.path.replace(/\/+$/, '')}/`,
      `${sshTarget()}:${remoteDatasetPath}/`
    ];

    await appendToLog(localLogPath, `rsync dataset to ${remoteDatasetPath}`);
    updateTrainSyncProgress({
      status: 'syncing',
      progress_pct: 0,
      transferred_bytes: 0,
      total_bytes: datasetMarker.total_bytes,
      file_count: datasetMarker.file_count,
      detail: '正在同步训练数据到 A100'
    });
    trainBootstrapProcess = spawn('rsync', rsyncArgs, {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    trainBootstrapProcess.stdout.pipe(logStream, { end: false });
    trainBootstrapProcess.stderr.pipe(logStream, { end: false });
    let lastRsyncProgressUpdateMs = 0;
    const handleRsyncProgress = (chunk) => {
      const parsed = parseRsyncProgressChunk(chunk);
      if (!parsed) return;
      const now = Date.now();
      if (now - lastRsyncProgressUpdateMs < 1000 && parsed.progress_pct < 100) return;
      lastRsyncProgressUpdateMs = now;
      updateTrainSyncProgress({
        status: 'syncing',
        progress_pct: parsed.progress_pct,
        transferred_bytes: parsed.transferred_bytes,
        total_bytes: datasetMarker.total_bytes,
        file_count: datasetMarker.file_count,
        detail: '正在同步训练数据到 A100'
      });
    };
    trainBootstrapProcess.stdout.on('data', handleRsyncProgress);
    trainBootstrapProcess.stderr.on('data', handleRsyncProgress);
    trainBootstrapProcess.on('error', async (error) => {
      trainBootstrapProcess = null;
      logStream.end();
      updateState({
        phase: 'error',
        stage_text: '同步到 A100 失败。',
        error_message: error?.message || 'rsync_spawn_failed',
        train: {
          ...state.train,
          phase: 'error',
          running: false,
          error_message: error?.message || 'rsync_spawn_failed',
          completed_at_ms: Date.now()
        }
      });
    });
    trainBootstrapProcess.on('exit', async (code, signal) => {
      if (signal || code !== 0) {
        trainBootstrapProcess = null;
        logStream.end();
        if (trainStopRequested) {
          trainStopRequested = false;
          markTrainingStopped('sync_interrupted');
          return;
        }
        updateState({
          phase: 'error',
          stage_text: signal ? `同步到 A100 被中断：${signal}` : `同步到 A100 失败，exit code=${code}`,
          error_message: signal || `rsync_exit_${code}`,
          train: {
            ...state.train,
            phase: 'error',
            running: false,
            error_message: signal || `rsync_exit_${code}`,
            completed_at_ms: Date.now()
          }
        });
        return;
      }

      try {
        await appendToLog(localLogPath, 'rsync done');
        await writeRemoteDatasetSyncMarker(remoteDatasetPath, datasetMarker).catch(async (error) => {
          await appendToLog(localLogPath, `write remote dataset marker failed: ${error?.message || 'unknown error'}`);
        });
        updateTrainSyncProgress({
          status: 'completed',
          progress_pct: 100,
          transferred_bytes: datasetMarker.total_bytes,
          total_bytes: datasetMarker.total_bytes,
          file_count: datasetMarker.file_count,
          detail: '训练数据已同步到 A100'
        });
        await launchRemoteTraining({
          localLogPath,
          remoteDatasetPath,
          remoteRunPath,
          gpu,
          iterations,
          resolution,
          resume: false,
          checkpoint: null
        });
        updateNestedState('train', {
          remote_dataset_synced_at_ms: Date.now()
        });
        trainBootstrapProcess = null;
        logStream.end();
      } catch (error) {
        trainBootstrapProcess = null;
        logStream.end();
        updateState({
          phase: 'error',
          stage_text: 'A100 训练启动失败。',
          error_message: error?.message || 'remote_train_start_failed',
          train: {
            ...state.train,
            phase: 'error',
            running: false,
            error_message: error?.message || 'remote_train_start_failed',
            completed_at_ms: Date.now()
          }
        });
      }
    });
  }

  async function stopTrainingTask(_auth, payload = {}) {
    const isRunning = Boolean(trainBootstrapProcess || state.train.running || ['syncing', 'resuming', 'training'].includes(state.train.phase));
    if (!isRunning) {
      throw new Error('three_dgs_train_not_running');
    }
    trainStopRequested = true;
    const reason = String(payload.reason || 'operator_stopped').slice(0, 80);
    if (trainBootstrapProcess) {
      await appendToLog(state.train.local_log_path, `stop requested during dataset sync: ${reason}`).catch(() => {});
      trainBootstrapProcess.kill('SIGTERM');
      updateState({
        phase: 'training',
        stage_text: '正在中断同步到 A100。',
        train: {
          ...state.train,
          remote_status: { phase: 'stopping', reason }
        }
      });
      return;
    }
    if (!state.train.remote_run_path) {
      markTrainingStopped(reason);
      trainStopRequested = false;
      return;
    }
    updateState({
      phase: 'training',
      stage_text: '正在停止 A100 训练进程。',
      train: {
        ...state.train,
        remote_status: { phase: 'stopping', reason }
      }
    });
    await appendToLog(state.train.local_log_path, `stop requested for remote training: ${reason}`).catch(() => {});
    await execSsh(makeRemoteStopCommand(state.train.remote_run_path, state.train.remote_pid), 30000);
    trainStopRequested = false;
    markTrainingStopped(reason);
  }

  async function refreshRemoteTrainingStatus() {
    if (!state.train.remote_run_path || !['training', 'syncing', 'resuming'].includes(state.train.phase)) {
      return null;
    }
    const lastChecked = Number(state.train.last_remote_status_check_ms || 0);
    if (lastChecked && Date.now() - lastChecked < remoteStatusPollMs) {
      return state.train.remote_status || null;
    }
    updateNestedState('train', {
      last_remote_status_check_ms: Date.now()
    });
    try {
      const statusRaw = await execSsh(`cat ${remoteQuote(`${state.train.remote_run_path}/status.json`)} 2>/dev/null || true`, 8000);
      if (!statusRaw.trim()) {
        return null;
      }
      const remoteStatus = JSON.parse(statusRaw.trim().split('\n').pop());
      const patch = {
        remote_status: remoteStatus
      };
      if (remoteStatus.phase === 'completed') {
        patch.phase = 'completed';
        patch.running = false;
        patch.completed_at_ms = state.train.completed_at_ms || Date.now();
        updateState({
          phase: 'completed',
          stage_text: 'A100 3DGS 训练完成。',
          train: {
            ...state.train,
            ...patch
          }
        });
      } else if (remoteStatus.phase === 'error') {
        patch.phase = 'error';
        patch.running = false;
        patch.completed_at_ms = state.train.completed_at_ms || Date.now();
        patch.error_message = `remote_train_exit_${remoteStatus.exit_code ?? '-'}`;
        updateState({
          phase: 'error',
          stage_text: 'A100 3DGS 训练失败。',
          error_message: patch.error_message,
          train: {
            ...state.train,
            ...patch
          }
        });
      } else if (remoteStatus.phase === 'stopped') {
        patch.phase = 'stopped';
        patch.running = false;
        patch.completed_at_ms = state.train.completed_at_ms || Date.now();
        updateState({
          phase: 'stopped',
          stage_text: 'A100 3DGS 训练已停止；可以继续训练或重新开始。',
          error_message: null,
          train: {
            ...state.train,
            ...patch
          }
        });
      } else {
        updateNestedState('train', patch);
      }
      return remoteStatus;
    } catch (_error) {
      return null;
    }
  }

  async function readTail(filePath, maxLines = 160) {
    if (!filePath || !(await safeStat(filePath))) {
      return '';
    }
    const content = await fsp.readFile(filePath, 'utf8');
    return normalizeTerminalLog(content, maxLines);
  }

  function normalizeTerminalLog(content, maxLines = 160) {
    const lines = [];
    let line = '';
    for (const char of String(content || '').replace(/\r\n/g, '\n')) {
      if (char === '\r') {
        line = '';
      } else if (char === '\n') {
        lines.push(line);
        line = '';
      } else {
        line += char;
      }
    }
    if (line) {
      lines.push(line);
    }
    return lines
      .slice(-Math.max(1, Math.min(1000, maxLines)))
      .join('\n');
  }

  function stripAnsi(content) {
    return String(content || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  }

  function parseTrainMetrics(content) {
    const text = stripAnsi(content);
    const progress = [];
    const progressByIteration = new Map();
    const progressRegex = /(?:Training progress:)?[^\r\n]*?(\d+)\s*\/\s*(\d+)[^\r\n]*?Loss=([0-9.eE+-]+),\s*Depth Loss=([0-9.eE+-]+)/g;
    let match = null;
    while ((match = progressRegex.exec(text)) !== null) {
      const iteration = Number(match[1]);
      const total = Number(match[2]);
      const loss = Number(match[3]);
      const depthLoss = Number(match[4]);
      if (![iteration, total, loss, depthLoss].every(Number.isFinite)) continue;
      progressByIteration.set(iteration, {
        iteration,
        total_iterations: total,
        loss,
        depth_loss: depthLoss
      });
    }
    progress.push(...progressByIteration.values());
    progress.sort((a, b) => a.iteration - b.iteration);

    const evaluations = [];
    const evalRegex = /\[ITER\s+(\d+)\]\s+Evaluating\s+([A-Za-z0-9_-]+):\s+L1\s+([0-9.eE+-]+)\s+PSNR\s+([0-9.eE+-]+)/g;
    while ((match = evalRegex.exec(text)) !== null) {
      const iteration = Number(match[1]);
      const l1 = Number(match[3]);
      const psnr = Number(match[4]);
      if (![iteration, l1, psnr].every(Number.isFinite)) continue;
      evaluations.push({
        iteration,
        split: match[2],
        l1,
        psnr
      });
    }

    const initialPointsMatch = text.match(/Number of points at initialisation\s*:\s*(\d+)/);
    return {
      initial_points: initialPointsMatch ? Number(initialPointsMatch[1]) : null,
      tensorboard_available: !/Tensorboard not available/i.test(text),
      progress,
      evaluations,
      latest_progress: progress[progress.length - 1] || null,
      latest_evaluation: evaluations[evaluations.length - 1] || null,
      sample_count: progress.length + evaluations.length
    };
  }

  async function readLocalFileTailBytes(filePath, maxBytes) {
    if (!filePath) return '';
    const stat = await safeStat(filePath);
    if (!stat) return '';
    if (!stat.size) return '';
    const start = Math.max(0, stat.size - maxBytes);
    const stream = fs.createReadStream(filePath, {
      start,
      end: Math.max(start, stat.size - 1),
      encoding: 'utf8'
    });
    let content = '';
    for await (const chunk of stream) {
      content += chunk;
    }
    return content;
  }

  async function readTrainMetricsLog(maxBytes = 2 * 1024 * 1024) {
    if (state.train.remote_run_path) {
      const output = await execSsh(`tail -c ${Math.max(65536, maxBytes)} ${remoteQuote(`${state.train.remote_run_path}/train.log`)} 2>/dev/null || true`, 10000);
      return { source: 'remote', content: output };
    }
    if (state.train.local_log_path) {
      return {
        source: 'local',
        content: await readLocalFileTailBytes(state.train.local_log_path, maxBytes)
      };
    }
    return { source: 'none', content: '' };
  }

  void ensureRuntimeDirs()
    .then(loadStateFromDisk)
    .then(() => persistState())
    .catch(() => {});

  app.get('/api/three-dgs/status', async (req, res) => {
    cleanupExpiredVehicleUploads();
    normalizeStaleTransientState();
    await syncUploadedArtifacts();
    await refreshPrepareProgressFromDisk();
    await refreshRemoteTrainingStatus();
    const auth = await getAuth(req);
    const includeVehicles = String(req.query.include_vehicles || 'true') !== 'false';
    const vehicles = includeVehicles ? await listVehicles().catch(() => []) : [];
    return res.json(
      makeStatusResponse(auth, {
        vehicles,
        default_vehicle_id: defaultVehicleId,
        allowed_vehicle_ids: allowedVehicleIds,
        default_train_gpu: defaultTrainGpu,
        default_train_resolution: defaultTrainResolution,
        default_undistort_mode: defaultUndistortMode,
        default_colorize_points: colorizeInitialPoints,
        default_filter_visible_points: filterVisibleInitialPoints,
        configured_camera_ids: configuredCameraIds,
        fallback_calibrated_cameras: fallbackCalibratedCameras,
        vehicle_map_path: vehicleMapPath
      })
    );
  });

  async function vehicleUploadHandler(req, res, forcedKind = '') {
    cleanupExpiredVehicleUploads();
    const kind = String(forcedKind || req.params.kind || '').trim();
    const token = String(req.params.token || '').trim();
    const ticket = pendingVehicleUploads.get(token);
    if (!ticket || ticket.kind !== kind) {
      return res.status(404).json({ ok: false, error: 'upload_ticket_not_found' });
    }
    if (Number(ticket.expires_at_ms || 0) <= Date.now()) {
      pendingVehicleUploads.delete(token);
      return res.status(410).json({ ok: false, error: 'upload_ticket_expired' });
    }
    const contentLength = Number(req.headers['content-length'] || 0);
    const contentRange = parseContentRangeHeader(req.headers['content-range']);
    if (contentLength > uploadMaxBytes) {
      return res.status(413).json({ ok: false, error: 'vehicle_upload_too_large' });
    }
    req.setTimeout?.(vehicleUploadRequestTimeoutMs);
    res.setTimeout?.(vehicleUploadRequestTimeoutMs);
    req.socket?.setTimeout?.(vehicleUploadRequestTimeoutMs);

    try {
      const storageStatus = await getVehicleUploadStorageStatus(ticket);
      setVehicleUploadProgress(ticket, {
        status: 'uploading',
        received_bytes: storageStatus.received_bytes || 0,
        total_bytes: Number(contentRange?.total_bytes || storageStatus.part_meta?.total_bytes || contentLength || 0),
        progress_pct: (contentRange?.total_bytes || storageStatus.part_meta?.total_bytes || contentLength) && storageStatus.received_bytes
          ? (storageStatus.received_bytes / Number(contentRange?.total_bytes || storageStatus.part_meta?.total_bytes || contentLength)) * 100
          : 0,
        resume_available: Boolean(storageStatus.received_bytes),
        resume_from_bytes: storageStatus.received_bytes || 0
      });
      const uploadInfo = await writeVehicleUpload(req, ticket, (progress) => setVehicleUploadProgress(ticket, progress));
      if (uploadInfo.partial) {
        setVehicleUploadProgress(ticket, {
          status: 'uploading',
          received_bytes: uploadInfo.received_bytes,
          total_bytes: uploadInfo.total_bytes,
          progress_pct: uploadInfo.total_bytes ? (uploadInfo.received_bytes / uploadInfo.total_bytes) * 100 : null,
          resume_available: true,
          resume_from_bytes: uploadInfo.resume_from_bytes || uploadInfo.received_bytes
        });
        res.setHeader('Upload-Offset', String(uploadInfo.resume_from_bytes || uploadInfo.received_bytes || 0));
        if (uploadInfo.received_bytes > 0) {
          res.setHeader('Range', `bytes=0-${uploadInfo.received_bytes - 1}`);
        }
        return res.status(202).json({
          ok: true,
          kind,
          partial: true,
          received_bytes: uploadInfo.received_bytes,
          total_bytes: uploadInfo.total_bytes,
          resume_from_bytes: uploadInfo.resume_from_bytes || uploadInfo.received_bytes,
          status_url: ticket.status_url
        });
      }
      pendingVehicleUploads.delete(token);
      setVehicleUploadProgress(ticket, {
        status: 'completed',
        received_bytes: uploadInfo.size_bytes,
        total_bytes: uploadInfo.size_bytes,
        progress_pct: 100,
        resume_available: false,
        resume_from_bytes: 0
      });
      if (ticket.staging) {
        return res.json({ ok: true, kind, file: uploadInfo, staging: true });
      }
      if (kind === 'pointcloud') {
        mergeVehicleData({
          vehicle_id: ticket.vehicle_id,
          map_upload_pending: false,
          last_map_upload_ms: Date.now()
        });
        updateState({
          phase: state.dataset.prepared ? 'prepared' : 'idle',
          stage_text: '车端 GlobalMap.pcd 已上传到云端服务器。',
          uploads: {
            ...state.uploads,
            pointcloud: uploadInfo
          },
          error_message: null
        });
      } else if (kind === 'image_pose') {
        mergeVehicleData({
          vehicle_id: ticket.vehicle_id,
          last_image_pull_ms: Date.now()
        });
        updateState({
          phase: state.dataset.prepared ? 'prepared' : 'idle',
          stage_text: '车端 3DGS 图像-位姿包已上传到云端服务器。',
          uploads: {
            ...state.uploads,
            image_pose: uploadInfo
          },
          error_message: null
        });
      }
      return res.json({ ok: true, kind, file: uploadInfo });
    } catch (error) {
      setVehicleUploadProgress(ticket, {
        status: 'failed',
        error_message: error.resume_available
          ? `${error.message || 'vehicle_upload_failed'}，可重试续传`
          : error.message || 'vehicle_upload_failed',
        received_bytes: Number(error.received_bytes || 0),
        total_bytes: Number(error.total_bytes || contentLength || 0),
        resume_available: Boolean(error.resume_available),
        resume_from_bytes: Number(error.received_bytes || 0)
      });
      return res.status(error.status || (error.message === 'vehicle_upload_too_large' ? 413 : 500)).json({
        ok: false,
        error: error.message || 'vehicle_upload_failed',
        resume_available: Boolean(error.resume_available),
        resume_from_bytes: Number(error.received_bytes || 0),
        status_url: ticket.status_url
      });
    }
  }

  async function vehicleUploadStatusHandler(req, res, forcedKind = '') {
    cleanupExpiredVehicleUploads();
    const kind = String(forcedKind || req.params.kind || '').trim();
    const token = String(req.params.token || '').trim();
    const ticket = pendingVehicleUploads.get(token);
    if (!ticket || ticket.kind !== kind) {
      return res.status(404).json({ ok: false, error: 'upload_ticket_not_found' });
    }
    const status = await getVehicleUploadStorageStatus(ticket);
    const receivedBytes = status.completed ? status.completed_bytes : status.received_bytes;
    res.setHeader('Upload-Offset', String(receivedBytes || 0));
    if (receivedBytes > 0) {
      res.setHeader('Range', `bytes=0-${receivedBytes - 1}`);
    }
    return res.json({
      ok: true,
      kind,
      token,
      completed: status.completed,
      offset: receivedBytes,
      upload_offset: receivedBytes,
      received_bytes: receivedBytes,
      completed_bytes: status.completed_bytes,
      partial_bytes: status.received_bytes,
      resume_from_bytes: receivedBytes,
      total_bytes: Number(status.part_meta?.total_bytes || 0),
      resume_supported: true,
      content_range_supported: true,
      chunk_size_bytes: Number(process.env.THREE_DGS_VEHICLE_UPLOAD_CHUNK_SIZE_BYTES || 32 * 1024 * 1024),
      recommended_chunk_size_bytes: Number(process.env.THREE_DGS_VEHICLE_UPLOAD_CHUNK_SIZE_BYTES || 32 * 1024 * 1024),
      expires_at_ms: ticket.expires_at_ms
    });
  }

  app.post('/api/three-dgs/vehicle-upload/:kind/:token', vehicleUploadHandler);
  app.put('/api/three-dgs/vehicle-upload/:kind/:token', vehicleUploadHandler);
  app.get('/api/three-dgs/vehicle-upload/:kind/:token/status', vehicleUploadStatusHandler);
  app.post('/api/three-dgs/pointcloud-upload/:token', (req, res) => {
    void vehicleUploadHandler(req, res, 'pointcloud');
  });
  app.put('/api/three-dgs/pointcloud-upload/:token', (req, res) => {
    void vehicleUploadHandler(req, res, 'pointcloud');
  });
  app.get('/api/three-dgs/pointcloud-upload/:token/status', (req, res) => {
    void vehicleUploadStatusHandler(req, res, 'pointcloud');
  });
  app.post('/api/three-dgs/image-pose-upload/:token', (req, res) => {
    void vehicleUploadHandler(req, res, 'image_pose');
  });
  app.put('/api/three-dgs/image-pose-upload/:token', (req, res) => {
    void vehicleUploadHandler(req, res, 'image_pose');
  });
  app.get('/api/three-dgs/image-pose-upload/:token/status', (req, res) => {
    void vehicleUploadStatusHandler(req, res, 'image_pose');
  });

  app.post('/api/three-dgs/capture/capabilities', requireThreeDgsAuth, async (req, res) => {
    let vehicleId;
    try {
      vehicleId = resolveThreeDgsVehicleId(req.body?.vehicle_id);
    } catch (error) {
      return res.status(error.status || 400).json(vehicleErrorBody(error));
    }
    const capabilities = await getCaptureCapabilities(vehicleId, 8);
    mergeVehicleData({
      vehicle_id: vehicleId,
      configured_cameras: configuredCameraIds,
      calibrated_cameras: capabilities.cameras.filter((item) => item.enabled).map((item) => item.camera),
      capabilities
    });
    return res.json(makeStatusResponse(req.threeDgsAuth, { capabilities }));
  });

  app.post('/api/three-dgs/capture/start', requireThreeDgsAuth, async (req, res) => {
    try {
      const requestedVehicleId = resolveThreeDgsVehicleId(req.body?.vehicle_id);
      try {
        await getVehicleConnection(requestedVehicleId, Number(process.env.THREE_DGS_VEHICLE_ONLINE_CHECK_TIMEOUT_MS || 3000));
      } catch (vehicleError) {
        return res.status(vehicleError.status === 404 ? 404 : 502).json({
          ok: false,
          error: 'three_dgs_vehicle_not_connected',
          detail: vehicleError.payload?.error || vehicleError.message || `vehicle '${requestedVehicleId}' is not connected`,
          vehicle_id: requestedVehicleId
        });
      }
      try {
        await callVehicleTool(requestedVehicleId, '3dgs.capture.status', {}, Number(process.env.THREE_DGS_START_PREFLIGHT_TIMEOUT_S || 10));
      } catch (toolError) {
        return res.status(toolError.status === 404 ? 404 : 502).json({
          ok: false,
          error: 'three_dgs_vehicle_tool_unresponsive',
          detail: toolError.payload?.error || toolError.message || `vehicle '${requestedVehicleId}' tool call timed out`,
          vehicle_id: requestedVehicleId
        });
      }
      queueCaptureStart(req.threeDgsAuth, { ...(req.body || {}), vehicle_id: requestedVehicleId });
      return res.json(makeStatusResponse(req.threeDgsAuth));
    } catch (error) {
      return res.status(error.status || 502).json({
        ok: false,
        error: error.message || 'three_dgs_capture_start_failed',
        detail: error.message,
        allowed_vehicle_ids: error.allowed_vehicle_ids || allowedVehicleIds
      });
    }
  });

  app.get('/api/three-dgs/capture/stream', requireThreeDgsAuth, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.socket?.setKeepAlive?.(true);

    const client = {
      res,
      connected_at_ms: Date.now(),
      username: req.threeDgsAuth?.username || null
    };
    captureStreamClients.add(client);
    writeCaptureStreamEvent(client, 'capture_status', captureStreamPayload({ stream_clients: captureStreamClients.size }));
    scheduleCaptureMonitor(state.capture.active || state.phase === 'starting_capture' ? 0 : 6000);

    req.on('close', () => {
      captureStreamClients.delete(client);
      if (!captureStreamClients.size && captureMonitorTimer) {
        clearTimeout(captureMonitorTimer);
        captureMonitorTimer = null;
      }
    });
  });

  app.post('/api/three-dgs/capture/status', requireThreeDgsAuth, async (req, res) => {
    let vehicleId;
    try {
      vehicleId = resolveThreeDgsVehicleId(req.body?.vehicle_id || state.capture.vehicle_id);
    } catch (error) {
      return res.status(error.status || 400).json(vehicleErrorBody(error));
    }
    try {
      await updateCaptureStatusFromVehicle(vehicleId, {
        cameras: activeCaptureCameras(),
        allowPartial: true,
        multiCamera: true,
        timeoutS: 10,
        persistLastResponse: true
      });
      broadcastCaptureStreamEvent('capture_status', captureStreamPayload());
      return res.json(makeStatusResponse(req.threeDgsAuth));
    } catch (error) {
      return res.status(error.status || 502).json({
        ok: false,
        error: 'three_dgs_capture_status_failed',
        detail: error.message
      });
    }
  });

  app.post('/api/three-dgs/capture/stop', requireThreeDgsAuth, async (req, res) => {
    let vehicleId;
    try {
      vehicleId = resolveThreeDgsVehicleId(req.body?.vehicle_id || state.capture.vehicle_id);
    } catch (error) {
      return res.status(error.status || 400).json(vehicleErrorBody(error));
    }
    try {
      const cameras = activeCaptureCameras();
      const stops = [];
      const previousCameraStatuses = new Map(
        (Array.isArray(state.capture.camera_statuses) ? state.capture.camera_statuses : []).map((item) => [item.camera, item])
      );
      if (state.capture.multi_camera) {
        try {
          const stopped = await callVehicleTool(
            vehicleId,
            '3dgs.capture.stop',
            {
              reason: 'operator_finished'
            },
            30
          );
          stops.push({ camera: 'all', response: stopped });
        } catch (error) {
          stops.push({ camera: 'all', error: error.message || 'stop_failed' });
        }
      } else {
        for (const camera of cameras) {
          try {
            const stopped = await callVehicleTool(
              vehicleId,
              '3dgs.capture.stop',
              {
                reason: 'operator_finished',
                camera
              },
              30
            );
            stops.push({ camera, response: stopped });
          } catch (error) {
            stops.push({ camera, error: error.message || 'stop_failed' });
          }
        }
      }
      if (stops.length && stops.every((item) => item.error)) {
        const error = new Error(stops.map((item) => `${item.camera}:${item.error}`).join('; '));
        error.status = 502;
        throw error;
      }
      updateNestedState('capture', {
        vehicle_id: vehicleId,
        active: false,
        cameras,
        camera_statuses: cameras.map((camera) => ({
          camera,
          ok: true,
          active: false,
          session_id: state.capture.session_ids?.[camera] || null,
          saved_frames: numericCaptureCount(previousCameraStatuses.get(camera)?.saved_frames),
          counts: null,
          status: 'stopped',
          error: null,
          checked_at_ms: Date.now()
        })),
        last_response: { stops },
        stopped_at_ms: Date.now()
      });
      updateState({
        phase: state.dataset.prepared ? 'prepared' : 'idle',
        stage_text: `车端 ${vehicleId} 3DGS 采集 session 已停止。`
      });
      broadcastCaptureStreamEvent('capture_status', captureStreamPayload());
      return res.json(makeStatusResponse(req.threeDgsAuth));
    } catch (error) {
      return res.status(error.status || 502).json({
        ok: false,
        error: 'three_dgs_capture_stop_failed',
        detail: error.message
      });
    }
  });

  app.post('/api/three-dgs/capture/manifest', requireThreeDgsAuth, async (req, res) => {
    let vehicleId;
    try {
      vehicleId = resolveThreeDgsVehicleId(req.body?.vehicle_id || state.capture.vehicle_id);
    } catch (error) {
      return res.status(error.status || 400).json(vehicleErrorBody(error));
    }
    try {
      const cameras = activeCaptureCameras();
      const manifests = [];
      if (state.capture.multi_camera) {
        const manifest = await callVehicleTool(
          vehicleId,
          '3dgs.capture.manifest',
          {
            ...(state.capture.session_id ? { session_id: state.capture.session_id } : {}),
            include_records: Boolean(req.body?.include_records ?? true),
            max_records: Number(req.body?.max_records || 100)
          },
          30
        );
        manifests.push({ camera: 'all', response: manifest });
      } else {
        for (const camera of cameras) {
          const sessionId = captureSessionIdForCamera(camera, req.body || {}, cameras.length === 1);
          const manifest = await callVehicleTool(
            vehicleId,
            '3dgs.capture.manifest',
            {
              camera,
              ...(sessionId ? { session_id: sessionId } : {}),
              include_records: Boolean(req.body?.include_records ?? true),
              max_records: Number(req.body?.max_records || 100)
            },
            30
          );
          manifests.push({ camera, response: manifest });
        }
      }
      updateNestedState('capture', {
        vehicle_id: vehicleId,
        manifest: { manifests },
        cameras,
        last_response: { manifests }
      });
      return res.json(makeStatusResponse(req.threeDgsAuth));
    } catch (error) {
      return res.status(error.status || 502).json({
        ok: false,
        error: 'three_dgs_capture_manifest_failed',
        detail: error.message
      });
    }
  });

  app.post('/api/three-dgs/map/update', requireThreeDgsAuth, async (req, res) => {
    let vehicleId;
    try {
      vehicleId = resolveThreeDgsVehicleId(req.body?.vehicle_id);
    } catch (error) {
      return res.status(error.status || 400).json(vehicleErrorBody(error));
    }
    try {
      await updateMapFromVehicle(req.threeDgsAuth, vehicleId);
      return res.json(makeStatusResponse(req.threeDgsAuth));
    } catch (error) {
      if (state.phase === 'updating_map') {
        updateState({
          phase: state.dataset.prepared ? 'prepared' : 'idle',
          stage_text: '更新车端 GlobalMap.pcd 失败。',
          error_message: error.message || 'three_dgs_map_update_failed'
        });
      }
      return res.status(error.status || 502).json({
        ok: false,
        error: error.message || 'three_dgs_map_update_failed',
        state
      });
    }
  });

  app.post('/api/three-dgs/capture/package', requireThreeDgsAuth, async (req, res) => {
    try {
      await pullImagePosePackageFromVehicle(req.threeDgsAuth, req.body || {});
      return res.json(makeStatusResponse(req.threeDgsAuth));
    } catch (error) {
      if (state.phase === 'pulling_image_pose') {
        updateState({
          phase: state.dataset.prepared ? 'prepared' : 'idle',
          stage_text: '上传车端图像-位姿数据失败。',
          error_message: error.message || 'three_dgs_capture_package_failed'
        });
      }
      return res.status(error.status || 502).json({
        ok: false,
        error: error.message || 'three_dgs_capture_package_failed',
        state
      });
    }
  });

  app.post('/api/three-dgs/upload/image-pose', requireThreeDgsAuth, (req, res) => {
    void handleUpload(req, res, 'image_pose');
  });

  app.post('/api/three-dgs/upload/pointcloud', requireThreeDgsAuth, (req, res) => {
    void handleUpload(req, res, 'pointcloud');
  });

  app.get('/api/three-dgs/pointcloud/preview', requireThreeDgsAuth, async (req, res) => {
    try {
      await syncUploadedArtifacts();
      const pointcloud = state.uploads.pointcloud;
      if (!pointcloud?.path) {
        return res.status(404).json({ ok: false, error: 'pointcloud_not_uploaded' });
      }
      const stat = await safeStat(pointcloud.path);
      if (!stat) {
        return res.status(404).json({ ok: false, error: 'pointcloud_file_not_found' });
      }
      if (stat.size > pointcloudPreviewMaxReadBytes) {
        return res.status(413).json({
          ok: false,
          error: 'pointcloud_too_large_for_preview',
          size_bytes: stat.size,
          max_read_bytes: pointcloudPreviewMaxReadBytes
        });
      }
      const maxPoints = Math.max(1000, Math.min(50000, Number(req.query.max_points || 12000)));
      const buffer = await fsp.readFile(pointcloud.path);
      const preview = parsePcdPreview(buffer, maxPoints);
      return res.json({
        ok: true,
        file: {
          name: pointcloud.name,
          size_bytes: stat.size,
          updated_at_ms: stat.mtimeMs || pointcloud.updated_at_ms
        },
        preview
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.message || 'pointcloud_preview_failed'
      });
    }
  });

  app.get('/api/three-dgs/dataset/inspection', requireThreeDgsAuth, async (req, res) => {
    try {
      const maxPoints = Math.max(1000, Math.min(80000, Number(req.query.max_points || 22000)));
      const inspection = await buildDatasetInspection(maxPoints);
      return res.json({ ok: true, inspection });
    } catch (error) {
      return res.status(error.status || 500).json({
        ok: false,
        error: error.message || 'dataset_inspection_failed'
      });
    }
  });

  app.get('/api/three-dgs/dataset/image/:name', requireThreeDgsAuth, async (req, res) => {
    try {
      const datasetPath = resolveCurrentDatasetPath();
      const rawName = String(req.params.name || '');
      if (!rawName || rawName !== path.basename(rawName)) {
        return res.status(400).send('invalid_image_name');
      }
      const imagesDir = path.resolve(datasetPath, 'images');
      const imagePath = path.resolve(path.join(imagesDir, rawName));
      if (!imagePath.startsWith(`${imagesDir}${path.sep}`)) {
        return res.status(400).send('invalid_image_path');
      }
      const stat = await safeStat(imagePath);
      if (!stat) {
        return res.status(404).send('image_not_found');
      }
      return res.sendFile(imagePath);
    } catch (error) {
      return res.status(error.status || 500).send(error.message || 'dataset_image_failed');
    }
  });

  app.get('/api/three-dgs/viewer/settings', requireThreeDgsAuth, async (_req, res) => {
    try {
      const settings = await buildViewerSettings();
      res.setHeader('Cache-Control', 'no-store');
      return res.json(settings);
    } catch (error) {
      return res.status(500).json(makeSuperSplatSettings(null, error.message || 'viewer_settings_failed'));
    }
  });

  app.post('/api/three-dgs/viewer/camera', requireThreeDgsAuth, async (req, res) => {
    try {
      if (req.body?.action === 'reset') {
        updateNestedState('viewer_camera', {
          manual: null,
          updated_at_ms: Date.now(),
          updated_by: req.threeDgsAuth?.username || null
        });
        return res.json(makeStatusResponse(req.threeDgsAuth));
      }
      const manual = normalizeViewerCameraPayload(req.body || {}, req.threeDgsAuth);
      updateNestedState('viewer_camera', {
        manual,
        updated_at_ms: Date.now(),
        updated_by: req.threeDgsAuth?.username || null
      });
      return res.json(makeStatusResponse(req.threeDgsAuth));
    } catch (error) {
      return res.status(error.status || 500).json({
        ok: false,
        error: error.message || 'viewer_camera_save_failed',
        state: responseState()
      });
    }
  });

  app.post('/api/three-dgs/viewer/sync', requireThreeDgsAuth, async (req, res) => {
    try {
      const viewer = await syncViewerPointCloud(req.body || {});
      return res.json(makeStatusResponse(req.threeDgsAuth, { viewer }));
    } catch (error) {
      updateNestedState('viewer', {
        error_message: error.message || 'three_dgs_result_sync_failed'
      });
      return res.status(502).json({
        ok: false,
        error: error.message || 'three_dgs_result_sync_failed',
        state
      });
    }
  });

  app.get('/api/three-dgs/results/:runId/point_cloud.ply', requireThreeDgsAuth, async (req, res) => {
    const runId = sanitizeRunId(req.params.runId);
    if (!runId) {
      return res.status(400).type('text/plain').send('run_id_invalid');
    }
    const targetPath = path.join(resultRoot, runId, 'point_cloud.ply');
    const stat = await safeStat(targetPath);
    if (!stat) {
      return res.status(404).type('text/plain').send('point_cloud_not_synced');
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.sendFile(targetPath);
  });

  app.post('/api/three-dgs/prepare', requireThreeDgsAuth, async (req, res) => {
    try {
      await startPrepareTask(req.threeDgsAuth, req.body || {});
      return res.json(makeStatusResponse(req.threeDgsAuth));
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error.message || 'three_dgs_prepare_failed'
      });
    }
  });

  app.post('/api/three-dgs/train/start', requireThreeDgsAuth, async (req, res) => {
    try {
      await startTrainingTask(req.threeDgsAuth, req.body || {});
      return res.json(makeStatusResponse(req.threeDgsAuth));
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error.message || 'three_dgs_train_start_failed'
      });
    }
  });

  app.post('/api/three-dgs/train/stop', requireThreeDgsAuth, async (req, res) => {
    try {
      await stopTrainingTask(req.threeDgsAuth, req.body || {});
      return res.json(makeStatusResponse(req.threeDgsAuth));
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error.message || 'three_dgs_train_stop_failed'
      });
    }
  });

  app.post('/api/three-dgs/train/resume', requireThreeDgsAuth, async (req, res) => {
    try {
      await startTrainingTask(req.threeDgsAuth, { ...(req.body || {}), resume: true }, { resume: true });
      return res.json(makeStatusResponse(req.threeDgsAuth));
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error.message || 'three_dgs_train_resume_failed'
      });
    }
  });

  app.get('/api/three-dgs/train/metrics', requireThreeDgsAuth, async (req, res) => {
    try {
      const maxBytes = Math.max(65536, Math.min(8 * 1024 * 1024, Number(req.query.max_bytes || 2 * 1024 * 1024)));
      const { source, content } = await readTrainMetricsLog(maxBytes);
      const metrics = parseTrainMetrics(content);
      return res.json({
        ok: true,
        source,
        run_id: state.train.run_id || null,
        remote_run_path: state.train.remote_run_path || null,
        train: {
          phase: state.train.phase,
          running: Boolean(state.train.running),
          iterations: state.train.iterations || null,
          resolution: state.train.resolution || null,
          gpu: state.train.gpu || null,
          mode: state.train.mode || null,
          checkpoint_interval: state.train.checkpoint_interval || null,
          resume_from_checkpoint: state.train.resume_from_checkpoint || null,
          resume_from_iteration: state.train.resume_from_iteration || null
        },
        metrics
      });
    } catch (error) {
      return res.status(502).json({
        ok: false,
        error: error.message || 'three_dgs_train_metrics_failed'
      });
    }
  });

  app.get('/api/three-dgs/logs/:kind', requireThreeDgsAuth, async (req, res) => {
    const kind = String(req.params.kind || '');
    const tail = Math.max(20, Math.min(1000, Number(req.query.tail || 160)));
    if (kind === 'prepare') {
      return res.type('text/plain').send(await readTail(state.prepare.log_path, tail));
    }
    if (kind === 'train-local') {
      return res.type('text/plain').send(await readTail(state.train.local_log_path, tail));
    }
    if (kind === 'train-remote' && state.train.remote_run_path) {
      try {
        const tailBytes = Math.max(65536, Math.min(512000, tail * 2000));
        const output = await execSsh(`tail -c ${tailBytes} ${remoteQuote(`${state.train.remote_run_path}/train.log`)} 2>/dev/null || true`, 10000);
        return res.type('text/plain').send(normalizeTerminalLog(output, tail));
      } catch (error) {
        return res.status(502).type('text/plain').send(error.message);
      }
    }
    return res.status(404).type('text/plain').send('log_not_found');
  });
};
