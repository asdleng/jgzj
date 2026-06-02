const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

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
      saved_frames: 0,
      last_response: null,
      manifest: null,
      started_at_ms: null,
      stopped_at_ms: null
    },
    uploads: {
      image_pose: null,
      pointcloud: null
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
      error_message: null
    }
  };
}

module.exports = function registerThreeDgsRoutes(app, options = {}) {
  const authStore = options.authStore || null;
  const cloudAgentBaseUrl = options.cloudAgentBaseUrl || process.env.CLOUD_AGENT_BASE_URL || 'http://127.0.0.1:8000';
  const cloudAgentTimeoutMs = Number(process.env.THREE_DGS_CLOUD_AGENT_TIMEOUT_MS || 30000);
  const runtimeRoot = path.resolve(
    process.env.THREE_DGS_RUNTIME_ROOT || path.resolve(__dirname, '../.runtime/three-dgs')
  );
  const uploadDir = path.join(runtimeRoot, 'uploads');
  const datasetRoot = path.join(runtimeRoot, 'datasets');
  const logDir = path.join(runtimeRoot, 'logs');
  const statePath = path.join(runtimeRoot, 'three-dgs-state.json');
  const imagePoseUploadPath = path.join(uploadDir, 'image-pose-upload');
  const pointcloudUploadPath = path.join(uploadDir, 'pointcloud-upload');
  const prepareScriptPath = path.resolve(
    process.env.THREE_DGS_PREPARE_SCRIPT_PATH || path.resolve(__dirname, '../scripts/prepare_3dgs_colmap.py')
  );
  const uploadMaxBytes = Number(process.env.THREE_DGS_UPLOAD_MAX_BYTES || 12 * 1024 * 1024 * 1024);
  const sshKeyPath = process.env.THREE_DGS_A100_SSH_KEY || '/home/admin1/a100_tunnel/jgzj_qwen36_proxy_ed25519';
  const a100User = process.env.THREE_DGS_A100_USER || 'sari';
  const a100Host = process.env.THREE_DGS_A100_HOST || '192.168.80.49';
  const remoteDatasetRoot = process.env.THREE_DGS_REMOTE_DATASET_ROOT || '/home/sari/datasets/3dgs/cloud_control';
  const remoteRunRoot = process.env.THREE_DGS_REMOTE_RUN_ROOT || '/home/sari/3dgs_runs/cloud_control';
  const remoteSourceRoot = process.env.THREE_DGS_REMOTE_SOURCE_ROOT || '/home/sari/3dgs_src/gaussian-splatting';
  const remoteEnvName = process.env.THREE_DGS_REMOTE_ENV_NAME || '3dgs124_exact';
  const defaultVehicleId = process.env.THREE_DGS_DEFAULT_VEHICLE_ID || 'BIT-0041';

  let state = createInitialState();
  let statePersistTimer = null;
  let prepareProcess = null;
  let trainBootstrapProcess = null;
  let uploadInFlight = false;

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
      fsp.mkdir(logDir, { recursive: true })
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
          capture: { ...createInitialState().capture, ...(parsed.capture || {}) },
          uploads: { ...createInitialState().uploads, ...(parsed.uploads || {}) },
          dataset: { ...createInitialState().dataset, ...(parsed.dataset || {}) },
          prepare: { ...createInitialState().prepare, ...(parsed.prepare || {}) },
          train: { ...createInitialState().train, ...(parsed.train || {}) },
          updated_at_ms: Number(parsed.updated_at_ms) || Date.now()
        };
      }
    } catch (_error) {
      state = createInitialState();
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
    const endpoint = new URL(
      `/api/vehicles/${encodeURIComponent(vehicleId)}/tools/${encodeURIComponent(tool)}`,
      cloudAgentBaseUrl
    ).toString();
    return fetchJson(endpoint, {
      method: 'POST',
      timeoutMs: Math.max(timeoutS * 1000 + 5000, cloudAgentTimeoutMs),
      body: {
        args,
        timeout_s: timeoutS
      }
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
    if (uploads.image_pose !== state.uploads.image_pose || uploads.pointcloud !== state.uploads.pointcloud) {
      updateState({ uploads });
    }
  }

  async function appendToLog(logPath, line) {
    await ensureRuntimeDirs();
    await fsp.appendFile(logPath, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  }

  async function handleUpload(req, res, kind) {
    await syncUploadedArtifacts();
    if (uploadInFlight || state.prepare.running || state.train.running) {
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
    if (prepareProcess || state.prepare.running || state.train.running) {
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
      '--image-pose', state.uploads.image_pose.path,
      '--pointcloud', state.uploads.pointcloud.path,
      '--output', outputDir,
      '--scene-name', sceneName,
      '--max-points', String(Number(payload.max_points || 500000)),
      '--undistort', payload.undistort === false ? 'false' : 'true'
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
    return [
      '-i', sshKeyPath,
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3'
    ];
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

  function makeRemoteTrainCommand(remoteDatasetPath, remoteRunPath, trainOptions) {
    const iterations = Number(trainOptions.iterations || 7000);
    const resolution = Number(trainOptions.resolution || 4);
    const gpu = String(trainOptions.gpu ?? '3').trim() || '3';
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
    const gpu = String(payload.gpu ?? '3').trim() || '3';
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
        error_message: null
      }
    });

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
    trainBootstrapProcess = spawn('rsync', rsyncArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
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
          stage_text: `A100 训练已启动，remote pid=${pid || '-' }。`
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
    try {
      const statusRaw = await execSsh(
        `cat ${remoteQuote(`${state.train.remote_run_path}/status.json`)} 2>/dev/null || true`,
        8000
      );
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
    return content.split('\n').slice(-Math.max(1, Math.min(1000, maxLines))).join('\n');
  }

  void ensureRuntimeDirs()
    .then(loadStateFromDisk)
    .then(() => persistState())
    .catch(() => {});

  app.get('/api/three-dgs/status', async (req, res) => {
    await syncUploadedArtifacts();
    await refreshRemoteTrainingStatus();
    const auth = await getAuth(req);
    const includeVehicles = String(req.query.include_vehicles || 'true') !== 'false';
    const vehicles = includeVehicles ? await listVehicles().catch(() => []) : [];
    return res.json(makeStatusResponse(auth, { vehicles, default_vehicle_id: defaultVehicleId }));
  });

  app.post('/api/three-dgs/capture/start', requireThreeDgsAuth, async (req, res) => {
    const vehicleId = String(req.body?.vehicle_id || '').trim();
    if (!vehicleId) {
      return res.status(400).json({ ok: false, error: 'vehicle_id_required' });
    }
    try {
      const calibration = await callVehicleTool(vehicleId, 'vehicle.calibration', { include_lidar_extrinsics: true }, 30);
      const mapInfo = await callVehicleTool(vehicleId, 'map.info', {}, 25).catch((error) => ({ error: error.message }));
      const pointcloudMeta = await callVehicleTool(vehicleId, 'map.pointcloud.meta', { target: 'global' }, 25).catch((error) => ({ error: error.message }));
      const captureArgs = {
        camera: 'camera1',
        pose_topic: '/ndt_pose',
        min_translation_m: Number(req.body?.min_translation_m || 0.5),
        min_rotation_deg: Number(req.body?.min_rotation_deg || 10),
        min_interval_s: Number(req.body?.min_interval_s || 0.2),
        max_pose_gap_ms: Number(req.body?.max_pose_gap_ms || 100),
        duration_s: Number(req.body?.duration_s || 0),
        max_frames: Number(req.body?.max_frames || 0)
      };
      const started = await callVehicleTool(vehicleId, '3dgs.capture.start', captureArgs, 35);
      const session = started?.response?.result || started?.response?.data || started?.response || started;
      updateNestedState('capture', {
        vehicle_id: vehicleId,
        active: true,
        session_id: session?.session_id || session?.session?.session_id || null,
        saved_frames: 0,
        last_response: {
          calibration,
          map_info: mapInfo,
          pointcloud_meta: pointcloudMeta,
          start: started
        },
        started_at_ms: Date.now(),
        stopped_at_ms: null
      });
      updateState({
        phase: 'capturing',
        active_username: req.threeDgsAuth.username,
        stage_text: '车端 3DGS 采集已启动。'
      });
      return res.json(makeStatusResponse(req.threeDgsAuth));
    } catch (error) {
      return res.status(error.status || 502).json({
        ok: false,
        error: 'three_dgs_capture_start_failed',
        detail: error.message
      });
    }
  });

  app.post('/api/three-dgs/capture/status', requireThreeDgsAuth, async (req, res) => {
    const vehicleId = String(req.body?.vehicle_id || state.capture.vehicle_id || '').trim();
    if (!vehicleId) {
      return res.status(400).json({ ok: false, error: 'vehicle_id_required' });
    }
    try {
      const status = await callVehicleTool(vehicleId, '3dgs.capture.status', {}, 25);
      const session = status?.response?.result?.session || status?.response?.result || status?.response?.data?.session || null;
      updateNestedState('capture', {
        vehicle_id: vehicleId,
        active: Boolean(session?.active ?? state.capture.active),
        saved_frames: Number(session?.counts?.saved_frames ?? state.capture.saved_frames ?? 0),
        last_response: status
      });
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
    const vehicleId = String(req.body?.vehicle_id || state.capture.vehicle_id || '').trim();
    if (!vehicleId) {
      return res.status(400).json({ ok: false, error: 'vehicle_id_required' });
    }
    try {
      const stopped = await callVehicleTool(vehicleId, '3dgs.capture.stop', { reason: 'operator_finished' }, 30);
      updateNestedState('capture', {
        vehicle_id: vehicleId,
        active: false,
        last_response: stopped,
        stopped_at_ms: Date.now()
      });
      updateState({
        phase: state.dataset.prepared ? 'prepared' : 'idle',
        stage_text: '车端 3DGS 采集已停止。'
      });
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
    const vehicleId = String(req.body?.vehicle_id || state.capture.vehicle_id || '').trim();
    if (!vehicleId) {
      return res.status(400).json({ ok: false, error: 'vehicle_id_required' });
    }
    try {
      const manifest = await callVehicleTool(
        vehicleId,
        '3dgs.capture.manifest',
        {
          include_records: Boolean(req.body?.include_records ?? true),
          max_records: Number(req.body?.max_records || 100)
        },
        30
      );
      updateNestedState('capture', {
        vehicle_id: vehicleId,
        manifest,
        last_response: manifest
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

  app.post('/api/three-dgs/upload/image-pose', requireThreeDgsAuth, (req, res) => {
    void handleUpload(req, res, 'image_pose');
  });

  app.post('/api/three-dgs/upload/pointcloud', requireThreeDgsAuth, (req, res) => {
    void handleUpload(req, res, 'pointcloud');
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
        const output = await execSsh(
          `tail -n ${tail} ${remoteQuote(`${state.train.remote_run_path}/train.log`)} 2>/dev/null || true`,
          10000
        );
        return res.type('text/plain').send(output);
      } catch (error) {
        return res.status(502).type('text/plain').send(error.message);
      }
    }
    return res.status(404).type('text/plain').send('log_not_found');
  });
};
