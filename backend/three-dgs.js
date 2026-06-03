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
      session_id: null,
      session_ids: {},
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
      completed_at_ms: null
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
      gpu: null,
      iterations: null,
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
  const remoteStatusPollMs = Number(process.env.THREE_DGS_REMOTE_STATUS_POLL_MS || 30000);
  const vehicleMapPath = process.env.THREE_DGS_VEHICLE_MAP_PATH || 'map/GlobalMap.pcd';
  const configuredCameraIds = parseList(process.env.THREE_DGS_CAMERA_IDS || 'camera1,camera2,camera3,camera4');
  const fallbackCalibratedCameras = parseList(process.env.THREE_DGS_FALLBACK_CALIBRATED_CAMERAS || 'camera1,camera4');
  const allowedVehicleIds = parseList(process.env.THREE_DGS_ALLOWED_VEHICLE_IDS || defaultVehicleId);
  const mapDownloadTools = parseList(process.env.THREE_DGS_MAP_DOWNLOAD_TOOLS || '');
  const mapUploadTool = process.env.THREE_DGS_MAP_UPLOAD_TOOL || 'map.pointcloud.upload';
  const fallbackMapUploadStagingDir = process.env.THREE_DGS_MAP_UPLOAD_FALLBACK_STAGING_DIR || '/home/nvidia/auto_ad_ai_map_upload';
  const publicBaseUrl = String(process.env.THREE_DGS_PUBLIC_BASE_URL || 'http://idtrd.kmdns.net:7791').replace(/\/+$/, '');
  const vehicleUploadTokenTtlMs = Number(process.env.THREE_DGS_VEHICLE_UPLOAD_TOKEN_TTL_MS || 2 * 60 * 60 * 1000);
  const pointcloudPreviewMaxReadBytes = Number(process.env.THREE_DGS_POINTCLOUD_PREVIEW_MAX_READ_BYTES || 512 * 1024 * 1024);

  let state = createInitialState();
  let statePersistTimer = null;
  let prepareProcess = null;
  let trainBootstrapProcess = null;
  let captureStartInFlight = false;
  let uploadInFlight = false;
  const pendingVehicleUploads = new Map();
  const captureStreamClients = new Set();
  let captureMonitorTimer = null;
  let captureMonitorInFlight = false;

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
  }

  async function safeStat(targetPath) {
    try {
      return await fsp.stat(targetPath);
    } catch (_error) {
      return null;
    }
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
    for (const line of lines) {
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
    }
    frames.sort((a, b) => a.image_id - b.image_id);
    return frames;
  }

  function summarizeTrajectory(frames) {
    let totalDistance = 0;
    let maxGap = 0;
    for (let index = 1; index < frames.length; index += 1) {
      const previous = frames[index - 1].position;
      const current = frames[index].position;
      const gap = Math.hypot(current[0] - previous[0], current[1] - previous[1], current[2] - previous[2]);
      totalDistance += gap;
      maxGap = Math.max(maxGap, gap);
    }
    return {
      frame_count: frames.length,
      total_distance_m: totalDistance,
      avg_gap_m: frames.length > 1 ? totalDistance / (frames.length - 1) : 0,
      max_gap_m: maxGap,
      extent: summarizePreviewPoints(frames.map((frame) => frame.position))
    };
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
    const frames = parseColmapImagesText(imagesText).map((frame) => ({
      ...frame,
      image_url: `/api/three-dgs/dataset/image/${encodeURIComponent(frame.name)}`
    }));
    const pointcloud = parseAsciiPlyPreview(pointcloudText, maxPoints);
    const summary = state.dataset.summary || null;
    return {
      dataset: {
        scene_name: state.dataset.scene_name,
        path: datasetPath,
        summary,
        images_dir_exists: Boolean(imageDirStat)
      },
      pointcloud,
      trajectory: {
        summary: summarizeTrajectory(frames),
        frames
      },
      checks: {
        image_count_matches: !summary?.image_count || Number(summary.image_count) === frames.length,
        point_count_matches: !summary?.point_count || Number(summary.point_count) === Number(pointcloud.total_points),
        has_images_dir: Boolean(imageDirStat),
        has_sparse_files: true
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
    return normalizeVector([rotation[2][0], rotation[2][1], rotation[2][2]]);
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

  function makeVehicleTrajectoryTrack(frames, extent, fov = 68) {
    const maxKeyframes = Number(process.env.THREE_DGS_VIEWER_ANIM_MAX_KEYFRAMES || 160);
    const indices = sampleFrameIndices(frames.length, maxKeyframes);
    if (indices.length < 2) {
      return null;
    }
    const spanX = Math.abs(extent.max_x - extent.min_x);
    const spanY = Math.abs(extent.max_y - extent.min_y);
    const spanZ = Math.abs(extent.max_z - extent.min_z);
    const lookDistance = Math.max(2, Math.min(12, Math.hypot(spanX, spanY, spanZ) * 0.18));
    const duration = Math.max(12, Math.min(45, frames.length / 8));
    const times = indices.map((_, index) => (index / Math.max(1, indices.length - 1)) * duration);
    const positions = [];
    const targets = [];
    const fovs = [];

    for (const frameIndex of indices) {
      const frame = frames[frameIndex];
      const position = frame.position;
      const before = frames[Math.max(0, frameIndex - 2)]?.position || position;
      const after = frames[Math.min(frames.length - 1, frameIndex + 2)]?.position || position;
      const tangent = normalizeVector([
        after[0] - before[0],
        after[1] - before[1],
        after[2] - before[2]
      ], cameraForwardFromQvec(frame.qvec));
      const target = [
        position[0] + tangent[0] * lookDistance,
        position[1] + tangent[1] * lookDistance,
        position[2] + tangent[2] * lookDistance
      ];
      positions.push(...roundViewerVector(position));
      targets.push(...roundViewerVector(target));
      fovs.push(fov);
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
        look_distance_m: roundViewerNumber(lookDistance)
      }
    };
  }

  async function buildTrajectoryViewerCamera() {
    const datasetPath = resolveCurrentDatasetPath();
    const imagesPath = path.join(datasetPath, 'sparse', '0', 'images.txt');
    const frames = parseColmapImagesText(await fsp.readFile(imagesPath, 'utf8'));
    if (!frames.length) {
      throw new Error('three_dgs_dataset_has_no_camera_frames');
    }

    const positions = frames.map((frame) => frame.position);
    const extent = summarizePreviewPoints(positions);
    const target = [
      (extent.min_x + extent.max_x) / 2,
      (extent.min_y + extent.max_y) / 2,
      (extent.min_z + extent.max_z) / 2
    ];

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
      position: roundViewerVector([
        target[0] + sideX * distance,
        target[1] + sideY * distance,
        target[2] + height
      ]),
      target: roundViewerVector(target),
      fov: 68,
      frame_count: frames.length,
      anim_track: makeVehicleTrajectoryTrack(frames, extent, 68),
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
      settings.jgzj.animation = camera.anim_track?.jgzj || null;
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

  async function callVehicleTool(vehicleId, tool, args = {}, timeoutS = 30) {
    const endpoint = new URL(`/api/vehicles/${encodeURIComponent(vehicleId)}/tools/${encodeURIComponent(tool)}`, cloudAgentBaseUrl).toString();
    return fetchJson(endpoint, {
      method: 'POST',
      timeoutMs: Math.max(timeoutS * 1000 + 5000, cloudAgentTimeoutMs),
      body: {
        args,
        timeout_s: timeoutS
      }
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

  async function getCaptureCapabilities(vehicleId) {
    try {
      const capabilities = await callVehicleTool(vehicleId, '3dgs.capture.capabilities', {}, 20);
      return {
        ok: true,
        raw: capabilities,
        cameras: normalizeCapabilities(capabilities, vehicleId)
      };
    } catch (error) {
      const cameras = normalizeCapabilities(null, vehicleId);
      return {
        ok: false,
        error: error?.message || 'capabilities_unavailable',
        raw: null,
        cameras
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

  function uniqueStrings(values) {
    return [...new Set((values || []).flatMap((value) => String(value || '').split(',')).map((item) => item.trim()).filter(Boolean))];
  }

  function resolveCapturePackageSessionId(payload = {}) {
    const requestedSessionIds = uniqueStrings([payload.session_id]);
    if (requestedSessionIds.length === 1) {
      return requestedSessionIds[0];
    }
    if (requestedSessionIds.length > 1) {
      const error = new Error('multiple_capture_sessions_require_single_session_id');
      error.status = 400;
      error.session_ids = requestedSessionIds;
      throw error;
    }

    const stateSessionIds = uniqueStrings([state.capture.session_id, ...Object.values(state.capture.session_ids || {})]);
    if (stateSessionIds.length === 1) {
      return stateSessionIds[0];
    }
    if (stateSessionIds.length > 1) {
      const error = new Error('multiple_capture_sessions_require_single_session_id');
      error.status = 400;
      error.session_ids = stateSessionIds;
      throw error;
    }
    return '';
  }

  function normalizeCaptureStatusEntry(camera, payload, error = null) {
    const session = error ? {} : normalizeSession(payload);
    const activeValue = error ? null : activeValueFromSession(session);
    return {
      camera,
      ok: !error,
      active: activeValue,
      session_id: error ? state.capture.session_ids?.[camera] || null : sessionIdFromSession(session),
      saved_frames: error ? 0 : savedFramesFromSession(session),
      counts: error ? null : session?.counts || null,
      status: error ? 'error' : session?.status || session?.state || session?.phase || null,
      error: error ? error.message || 'capture_status_failed' : null,
      checked_at_ms: Date.now()
    };
  }

  async function readVehicleCaptureStatuses(vehicleId, cameras, options = {}) {
    const statuses = [];
    const rawStatuses = [];
    const allowPartial = options.allowPartial !== false;
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
    const { statuses, rawStatuses } = await readVehicleCaptureStatuses(vehicleId, cameras, {
      allowPartial: options.allowPartial !== false,
      timeoutS: options.timeoutS || 20
    });
    const sessionIds = mergeSessionIds(statuses);
    const sessionIdList = uniqueStrings(Object.values(sessionIds));
    const active = aggregateCaptureActivity(statuses);
    const errorText = statuses
      .filter((item) => item.error)
      .map((item) => `${item.camera}:${item.error}`)
      .join('; ');
    updateNestedState('capture', {
      vehicle_id: vehicleId,
      active,
      cameras,
      session_id: sessionIdList.length === 1 ? sessionIdList[0] : sessionIdList.join(',') || state.capture.session_id || null,
      session_ids: sessionIds,
      saved_frames: aggregateCaptureFrames(statuses),
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
      session_id: state.capture.session_id,
      session_ids: state.capture.session_ids,
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
      stage_text: state.stage_text,
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
            timeoutS: 20,
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

  function makeStatusResponse(auth, extra = {}) {
    return {
      ok: true,
      auth: statusAuthPayload(auth),
      state,
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
      uploads.image_pose = await discoverUpload(imagePoseUploadPath, ['.zip', '.tar', '.tgz', '.gz', '.json', '.jsonl'], 'image_pose_upload');
    }
    if (!uploads.pointcloud) {
      uploads.pointcloud = await discoverUpload(pointcloudUploadPath, ['.pcd', '.ply'], 'GlobalMap.pcd');
    }
    if (uploads.image_pose !== state.uploads.image_pose || uploads.pointcloud !== state.uploads.pointcloud) {
      updateState({ uploads });
    }
  }

  async function appendToLog(logPath, line) {
    await ensureRuntimeDirs();
    await fsp.appendFile(logPath, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  }

  function createVehicleUploadTicket({ vehicleId, kind, fileName }) {
    const token = crypto.randomBytes(24).toString('hex');
    const ext = path.extname(fileName).toLowerCase() || '.pcd';
    const targetPath = kind === 'pointcloud' ? `${pointcloudUploadPath}${ext}` : `${imagePoseUploadPath}${ext}`;
    const expiresAtMs = Date.now() + vehicleUploadTokenTtlMs;
    const ticket = {
      token,
      vehicle_id: vehicleId,
      kind,
      file_name: fileName,
      target_path: targetPath,
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
    return {
      ...ticket,
      upload_url: uploadUrl
    };
  }

  function redactedUploadTicket(ticket) {
    if (!ticket) return null;
    return {
      vehicle_id: ticket.vehicle_id,
      kind: ticket.kind,
      file_name: ticket.file_name,
      target_path: ticket.target_path,
      expires_at_ms: ticket.expires_at_ms,
      upload_url: ticket.upload_url ? ticket.upload_url.replace(/\/[0-9a-f]{48}$/i, '/<redacted-token>') : null
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
      package_path: patch.package_path || current.package_path || null,
      package_size_bytes: Number(patch.package_size_bytes ?? current.package_size_bytes ?? 0) || 0,
      started_at_ms: current.started_at_ms || Date.now(),
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

  async function writeVehicleUpload(req, ticket, onProgress = null) {
    await ensureRuntimeDirs();
    const targetPath = ticket.target_path;
    const partPath = `${targetPath}.part`;
    await fsp.rm(partPath, { force: true });
    await fsp.rm(targetPath, { force: true });

    let receivedBytes = 0;
    let lastProgressAtMs = 0;
    const totalBytes = Number(req.headers['content-length'] || 0);
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        receivedBytes += chunk.length;
        if (receivedBytes > uploadMaxBytes) {
          callback(new Error('vehicle_upload_too_large'));
          return;
        }
        const now = Date.now();
        if (typeof onProgress === 'function' && (!lastProgressAtMs || now - lastProgressAtMs >= 1000)) {
          lastProgressAtMs = now;
          onProgress({
            status: 'uploading',
            received_bytes: receivedBytes,
            total_bytes: totalBytes
          });
        }
        callback(null, chunk);
      }
    });

    try {
      await pipeline(req, limiter, fs.createWriteStream(partPath, { flags: 'w' }));
      await fsp.rename(partPath, targetPath);
      const stat = await safeStat(targetPath);
      return {
        name: sanitizeFileName(ticket.file_name, path.basename(targetPath)),
        path: targetPath,
        size_bytes: stat?.size || receivedBytes,
        updated_at_ms: stat?.mtimeMs || Date.now()
      };
    } catch (error) {
      await fsp.rm(partPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function updateMapFromVehicle(auth, vehicleId) {
    if (captureStartInFlight || uploadInFlight || state.prepare.running || state.train.running) {
      throw new Error('three_dgs_busy');
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
            method: 'POST',
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
    const vehicleId = resolveThreeDgsVehicleId(payload.vehicle_id || state.capture.vehicle_id || defaultVehicleId);
    const sessionId = resolveCapturePackageSessionId(payload);

    updateState({
      phase: 'pulling_image_pose',
      active_username: auth.username,
      stage_text: `正在从 ${vehicleId} 拉取 3DGS 图像-位姿包。`,
      error_message: null
    });

    const packageName = `image_pose_${vehicleId}_${sessionId || 'active'}.zip`;
    const uploadTicket = createVehicleUploadTicket({
      vehicleId,
      kind: 'image_pose',
      fileName: packageName
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
      method: 'POST',
      ...(sessionId ? { session_id: sessionId } : {})
    };

    const packagePayload = await callVehicleTool(
      vehicleId,
      '3dgs.capture.package',
      packageArgs,
      Number(process.env.THREE_DGS_IMAGE_POSE_PACKAGE_TIMEOUT_S || 900)
    );
    const uploadedStat = await waitForUploadedFile(
      uploadTicket.target_path,
      Number(process.env.THREE_DGS_IMAGE_POSE_UPLOAD_WAIT_MS || 20000),
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
        '.tgz',
        '.gz',
        '.json',
        '.jsonl'
      ]);
    }

    mergeVehicleData({
      vehicle_id: vehicleId,
      last_image_pull_ms: Date.now()
    });

    if (!packageInfo) {
      const packageResult = unwrapToolPayload(packagePayload) || {};
      const packagePath = packageResult.package_path || packageResult.path || packageResult.file_path || '';
      const packageSize = Number(packageResult.size_bytes || packageResult.file_size || 0);
      updateNestedState('capture', {
        vehicle_id: vehicleId,
        last_response: {
          package: packagePayload,
          upload_ticket: redactedUploadTicket(uploadTicket)
        }
      });
      const packageError = mapUploadErrorMessage(packagePayload);
      const errorMessage = packageError || (packagePath ? 'image_pose_package_not_uploaded' : 'image_pose_file_transfer_unavailable');
      setVehicleUploadProgress(uploadTicket, {
        status: 'failed',
        error_message: packagePath
          ? `车端已打包${formatBytesForStatus(packageSize) ? ` ${formatBytesForStatus(packageSize)}` : ''}，但未上传到云端`
          : errorMessage,
        package_path: packagePath || null,
        package_size_bytes: packageSize
      });
      updateState({
        phase: state.uploads.pointcloud ? 'idle' : 'idle',
        stage_text: packageError
          ? `车端 3DGS package 上传失败：${packageError}`
          : packagePath
            ? `车端已打包图像-位姿包${formatBytesForStatus(packageSize) ? `（${formatBytesForStatus(packageSize)}）` : ''}，但未执行 upload_url 上传：${packagePath}`
            : '车端已响应 3DGS package 请求，但没有上传或返回可落盘的图像-位姿文件。',
        error_message: errorMessage
      });
      const error = new Error(errorMessage);
      error.status = 424;
      throw error;
    }

    setVehicleUploadProgress(uploadTicket, {
      status: 'completed',
      received_bytes: packageInfo.size_bytes,
      total_bytes: packageInfo.size_bytes,
      progress_pct: 100
    });
    updateState({
      phase: state.dataset.prepared ? 'prepared' : 'idle',
      stage_text: '车端图像-位姿包已上传到云端服务器。',
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
      min_translation_m: Number(payload.min_translation_m || 0.5),
      min_rotation_deg: Number(payload.min_rotation_deg || 10),
      min_interval_s: Number(payload.min_interval_s || 0.2),
      max_pose_gap_ms: Number(payload.max_pose_gap_ms || 100),
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
        stage_text: `正在读取 ${vehicleId} 3DGS 相机能力。`,
        error_message: null
      });
      capabilities = await getCaptureCapabilities(vehicleId);
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

      for (const camera of enabledCameras) {
        updateState({
          phase: 'starting_capture',
          stage_text: `正在启动 ${vehicleId} ${camera} 3DGS 采集。`
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
          cameras: starts.map((item) => item.camera),
          last_response: { capabilities, calibration, starts }
        });
        broadcastCaptureStreamEvent('capture_status', captureStreamPayload());
      }

      const sessionIds = uniqueStrings(starts.map((item) => item.session?.session_id || item.session?.session?.session_id || null));
      updateNestedState('capture', {
        vehicle_id: vehicleId,
        active: true,
        session_id: sessionIds.length === 1 ? sessionIds[0] : sessionIds.join(',') || null,
        session_ids: Object.fromEntries(starts.map((item) => [item.camera, item.session?.session_id || item.session?.session?.session_id || null])),
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
      mergeVehicleData({
        vehicle_id: vehicleId,
        calibration,
        configured_cameras: configuredCameraIds,
        calibrated_cameras: enabledCameras
      });
      updateState({
        phase: 'capturing',
        active_username: auth.username,
        stage_text: `车端 ${enabledCameras.join('、')} 3DGS 采集已启动。`,
        error_message: null
      });
      broadcastCaptureStreamEvent('capture_status', captureStreamPayload());
      scheduleCaptureMonitor(0);
    } catch (error) {
      for (const item of starts) {
        await callVehicleTool(
          vehicleId,
          '3dgs.capture.stop',
          {
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
        prepared_at_ms: null
      },
      prepare: {
        running: true,
        pid: null,
        log_path: logPath,
        started_at_ms: Date.now(),
        completed_at_ms: null
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
      payload.undistort === false ? 'false' : 'true'
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
        updateState({
          phase: 'error',
          stage_text: signal ? `COLMAP 数据规整被中断：${signal}` : `COLMAP 数据规整失败，exit code=${code}`,
          error_message: signal || `prepare_exit_${code}`,
          prepare: {
            ...state.prepare,
            running: false,
            completed_at_ms: Date.now()
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
      updateState({
        phase: 'prepared',
        stage_text: 'COLMAP 数据已规整完成，可以同步到 A100 开始训练。',
        error_message: null,
        dataset: {
          ...state.dataset,
          prepared: true,
          summary,
          prepared_at_ms: Date.now()
        },
        prepare: {
          ...state.prepare,
          running: false,
          completed_at_ms: Date.now()
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
    const iterations = Number(trainOptions.iterations || 7000);
    const resolution = Number(trainOptions.resolution || 4);
    const gpu = String(trainOptions.gpu ?? defaultTrainGpu).trim() || defaultTrainGpu;
    const script = [
      'set -Eeuo pipefail',
      `RUN_DIR=${remoteQuote(remoteRunPath)}`,
      `DATASET_DIR=${remoteQuote(remoteDatasetPath)}`,
      'mkdir -p "$RUN_DIR"',
      'STATUS_FILE="$RUN_DIR/status.json"',
      'LOG_FILE="$RUN_DIR/train.log"',
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
      'STATUS_FILE="$RUN_DIR/status.json"',
      'LOG_FILE="$RUN_DIR/train.log"',
      'write_status() { printf \'{"phase":"%s","ts":"%s","exit_code":%s}\\n\' "$1" "$(date -Iseconds)" "${2:-0}" > "$STATUS_FILE"; }',
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
      '  "$HOME/.local/bin/micromamba" run -n "$ENV_NAME" python train.py \\',
      '    -s "$DATASET_DIR" \\',
      '    -m "$RUN_DIR" \\',
      '    --iterations "$ITERATIONS" \\',
      '    --save_iterations "$ITERATIONS" \\',
      '    --checkpoint_iterations "$ITERATIONS" \\',
      '    --data_device cpu \\',
      '    -r "$RESOLUTION"',
      '  write_status completed 0',
      '} >> "$LOG_FILE" 2>&1 || { code=$?; write_status error "$code"; exit "$code"; }',
      'EOS',
      'chmod +x "$RUN_DIR/run_train.sh"',
      'nohup bash "$RUN_DIR/run_train.sh" >/dev/null 2>&1 & echo $!'
    ];
    return script.join('\n');
  }

  async function startTrainingTask(auth, payload = {}) {
    if (trainBootstrapProcess || state.train.running || state.prepare.running) {
      throw new Error('three_dgs_busy');
    }
    if (!state.dataset.prepared || !state.dataset.path) {
      throw new Error('three_dgs_dataset_not_prepared');
    }

    const runId = makeRunId(state.dataset.scene_name || payload.scene_name || 'scene');
    const localLogPath = path.join(logDir, `train-bootstrap-${runId}.log`);
    const remoteDatasetPath = `${remoteDatasetRoot}/${runId}`;
    const remoteRunPath = `${remoteRunRoot}/${runId}`;
    const gpu = String(payload.gpu ?? defaultTrainGpu).trim() || defaultTrainGpu;
    const iterations = Number(payload.iterations || 7000);
    const resolution = Number(payload.resolution || 4);

    await fsp.rm(localLogPath, { force: true });
    updateState({
      phase: 'training',
      active_username: auth.username,
      stage_text: '正在同步数据到 A100 并启动 3DGS 训练。',
      error_message: null,
      train: {
        ...state.train,
        phase: 'syncing',
        running: true,
        run_id: runId,
        local_log_path: localLogPath,
        remote_dataset_path: remoteDatasetPath,
        remote_run_path: remoteRunPath,
        remote_status: null,
        remote_pid: null,
        gpu,
        iterations,
        resolution,
        started_at_ms: Date.now(),
        completed_at_ms: null,
        last_remote_status_check_ms: null,
        error_message: null
      }
    });

    await appendToLog(localLogPath, `ensure remote directories ${remoteDatasetPath} and ${remoteRunPath}`);
    try {
      await execSsh(`mkdir -p ${remoteQuote(remoteDatasetPath)} ${remoteQuote(remoteRunPath)}`, 15000);
    } catch (error) {
      await appendToLog(localLogPath, `remote mkdir failed: ${error?.message || 'unknown error'}`);
      updateNestedState('train', {
        phase: 'error',
        running: false,
        error_message: error?.message || 'remote_mkdir_failed',
        completed_at_ms: Date.now()
      });
      updateState({
        phase: 'error',
        stage_text: 'A100 远端目录创建失败。',
        error_message: error?.message || 'remote_mkdir_failed'
      });
      return;
    }

    const logStream = fs.createWriteStream(localLogPath, { flags: 'a' });
    const rsyncArgs = [
      '-az',
      '--delete',
      '-e',
      ['ssh', ...sshBaseArgs()].join(' '),
      `${state.dataset.path.replace(/\/+$/, '')}/`,
      `${sshTarget()}:${remoteDatasetPath}/`
    ];

    await appendToLog(localLogPath, `rsync dataset to ${remoteDatasetPath}`);
    trainBootstrapProcess = spawn('rsync', rsyncArgs, {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    trainBootstrapProcess.stdout.pipe(logStream, { end: false });
    trainBootstrapProcess.stderr.pipe(logStream, { end: false });
    trainBootstrapProcess.on('error', async (error) => {
      trainBootstrapProcess = null;
      logStream.end();
      updateNestedState('train', {
        phase: 'error',
        running: false,
        error_message: error?.message || 'rsync_spawn_failed',
        completed_at_ms: Date.now()
      });
      updateState({
        phase: 'error',
        stage_text: '同步到 A100 失败。',
        error_message: error?.message || 'rsync_spawn_failed'
      });
    });
    trainBootstrapProcess.on('exit', async (code, signal) => {
      if (signal || code !== 0) {
        trainBootstrapProcess = null;
        logStream.end();
        updateNestedState('train', {
          phase: 'error',
          running: false,
          error_message: signal || `rsync_exit_${code}`,
          completed_at_ms: Date.now()
        });
        updateState({
          phase: 'error',
          stage_text: signal ? `同步到 A100 被中断：${signal}` : `同步到 A100 失败，exit code=${code}`,
          error_message: signal || `rsync_exit_${code}`
        });
        return;
      }

      try {
        await appendToLog(localLogPath, 'rsync done; start remote training');
        const command = makeRemoteTrainCommand(remoteDatasetPath, remoteRunPath, {
          gpu,
          iterations,
          resolution
        });
        const stdout = await execSsh(command, 30000);
        const pid = stdout.trim().split(/\s+/).filter(Boolean).pop() || null;
        trainBootstrapProcess = null;
        logStream.end();
        updateNestedState('train', {
          phase: 'training',
          running: true,
          remote_pid: pid,
          remote_status: { phase: 'running' }
        });
        updateState({
          phase: 'training',
          stage_text: `A100 训练已启动，remote pid=${pid || '-'}。`
        });
      } catch (error) {
        trainBootstrapProcess = null;
        logStream.end();
        updateNestedState('train', {
          phase: 'error',
          running: false,
          error_message: error?.message || 'remote_train_start_failed',
          completed_at_ms: Date.now()
        });
        updateState({
          phase: 'error',
          stage_text: 'A100 训练启动失败。',
          error_message: error?.message || 'remote_train_start_failed'
        });
      }
    });
  }

  async function refreshRemoteTrainingStatus() {
    if (!state.train.remote_run_path || !['training', 'syncing'].includes(state.train.phase)) {
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

  void ensureRuntimeDirs()
    .then(loadStateFromDisk)
    .then(() => persistState())
    .catch(() => {});

  app.get('/api/three-dgs/status', async (req, res) => {
    cleanupExpiredVehicleUploads();
    normalizeStaleTransientState();
    await syncUploadedArtifacts();
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
    if (contentLength > uploadMaxBytes) {
      return res.status(413).json({ ok: false, error: 'vehicle_upload_too_large' });
    }

    try {
      setVehicleUploadProgress(ticket, {
        status: 'uploading',
        received_bytes: 0,
        total_bytes: contentLength,
        progress_pct: 0
      });
      const uploadInfo = await writeVehicleUpload(req, ticket, (progress) => setVehicleUploadProgress(ticket, progress));
      pendingVehicleUploads.delete(token);
      setVehicleUploadProgress(ticket, {
        status: 'completed',
        received_bytes: uploadInfo.size_bytes,
        total_bytes: contentLength || uploadInfo.size_bytes,
        progress_pct: 100
      });
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
        error_message: error.message || 'vehicle_upload_failed'
      });
      return res.status(error.message === 'vehicle_upload_too_large' ? 413 : 500).json({
        ok: false,
        error: error.message || 'vehicle_upload_failed'
      });
    }
  }

  app.post('/api/three-dgs/vehicle-upload/:kind/:token', vehicleUploadHandler);
  app.put('/api/three-dgs/vehicle-upload/:kind/:token', vehicleUploadHandler);
  app.post('/api/three-dgs/pointcloud-upload/:token', (req, res) => {
    void vehicleUploadHandler(req, res, 'pointcloud');
  });
  app.put('/api/three-dgs/pointcloud-upload/:token', (req, res) => {
    void vehicleUploadHandler(req, res, 'pointcloud');
  });
  app.post('/api/three-dgs/image-pose-upload/:token', (req, res) => {
    void vehicleUploadHandler(req, res, 'image_pose');
  });
  app.put('/api/three-dgs/image-pose-upload/:token', (req, res) => {
    void vehicleUploadHandler(req, res, 'image_pose');
  });

  app.post('/api/three-dgs/capture/capabilities', requireThreeDgsAuth, async (req, res) => {
    let vehicleId;
    try {
      vehicleId = resolveThreeDgsVehicleId(req.body?.vehicle_id);
    } catch (error) {
      return res.status(error.status || 400).json(vehicleErrorBody(error));
    }
    const capabilities = await getCaptureCapabilities(vehicleId);
    mergeVehicleData({
      vehicle_id: vehicleId,
      configured_cameras: configuredCameraIds,
      calibrated_cameras: capabilities.cameras.filter((item) => item.enabled).map((item) => item.camera),
      capabilities
    });
    return res.json(makeStatusResponse(req.threeDgsAuth, { capabilities }));
  });

  app.post('/api/three-dgs/capture/start', requireThreeDgsAuth, (req, res) => {
    try {
      queueCaptureStart(req.threeDgsAuth, req.body || {});
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
        timeoutS: 25,
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
        stage_text: `车端 ${cameras.join('、')} 3DGS 采集已停止。`
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
      for (const camera of cameras) {
        const sessionId = uniqueStrings([req.body?.session_id || state.capture.session_ids?.[camera] || state.capture.session_id])[0] || '';
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
