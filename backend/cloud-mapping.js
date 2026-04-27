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
    progress_pct: 0,
    stage_text: '登录后上传 bag，并手动开始建图。',
    task_name: '',
    scene_type: '',
    task_note: '',
    uploaded_bag_name: null,
    uploaded_bag_size_bytes: 0,
    uploaded_bag_updated_at_ms: null,
    result_zip_name: null,
    result_zip_size_bytes: 0,
    result_zip_updated_at_ms: null,
    error_message: null,
    started_at_ms: null,
    completed_at_ms: null,
    updated_at_ms: Date.now(),
    runner_pid: null
  };
}

module.exports = function registerCloudMappingRoutes(app) {
  const runtimeRoot = path.resolve(
    process.env.CLOUD_MAPPING_RUNTIME_ROOT || path.resolve(__dirname, '../.runtime/cloud-mapping')
  );
  const uploadDir = path.join(runtimeRoot, 'uploads');
  const downloadDir = path.join(runtimeRoot, 'downloads');
  const logDir = path.join(runtimeRoot, 'logs');
  const uploadLogPath = path.join(logDir, 'upload-events.log');
  const statePath = path.join(runtimeRoot, 'mapping-state.json');
  const pidFilePath = path.join(runtimeRoot, 'mapping-run.pid');
  const uploadedBagPath = path.join(uploadDir, 'current-upload.bag');
  const uploadedBagPartPath = path.join(uploadDir, 'current-upload.bag.part');
  const resultZipPath = path.join(downloadDir, 'map.zip');
  const runnerLogPath = path.join(logDir, 'mapping-run.log');
  const mappingRunnerPath = path.resolve(
    process.env.CLOUD_MAPPING_RUNNER_PATH || '/home/admin1/auto_ad_mapping/run_vlio_mapping_to_map.sh'
  );
  const sourceMapRoot = path.resolve(
    process.env.CLOUD_MAPPING_SOURCE_ROOT || '/home/admin1/auto_ad_mapping'
  );
  const sourceMapDir = path.join(
    sourceMapRoot,
    process.env.CLOUD_MAPPING_SOURCE_MAP_DIR_NAME || 'map'
  );
  const uploadMaxBytes = Number(
    process.env.CLOUD_MAPPING_UPLOAD_MAX_BYTES || 10 * 1024 * 1024 * 1024
  );
  const authCookieName =
    process.env.CLOUD_MAPPING_AUTH_COOKIE_NAME || 'jgzj_cloud_mapping_auth';
  const authSecret =
    process.env.CLOUD_MAPPING_AUTH_SECRET || 'jgzj-cloud-mapping-auth-secret-v1';
  const authTtlMs = Number(
    process.env.CLOUD_MAPPING_AUTH_TTL_MS || 7 * 24 * 60 * 60 * 1000
  );
  const authAccounts = new Map([['jgauto402', 'jgauto402']]);

  if (process.env.CLOUD_MAPPING_AUTH_USERNAME && process.env.CLOUD_MAPPING_AUTH_PASSWORD) {
    authAccounts.set(
      String(process.env.CLOUD_MAPPING_AUTH_USERNAME || '').trim(),
      String(process.env.CLOUD_MAPPING_AUTH_PASSWORD || '')
    );
  }

  if (process.env.CLOUD_MAPPING_AUTH_USERS) {
    try {
      const parsed = JSON.parse(process.env.CLOUD_MAPPING_AUTH_USERS);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        Object.entries(parsed).forEach(([username, password]) => {
          const normalizedUsername = String(username || '').trim();
          if (normalizedUsername) {
            authAccounts.set(normalizedUsername, String(password || ''));
          }
        });
      }
    } catch (_error) {
      // Ignore malformed optional auth config.
    }
  }

  let state = createInitialState();
  let statePersistTimer = null;
  let mappingTaskProcess = null;
  let mappingTaskLogStream = null;
  let mappingUploadInFlight = false;

  function scheduleStatePersist() {
    if (statePersistTimer) {
      clearTimeout(statePersistTimer);
    }
    statePersistTimer = setTimeout(() => {
      statePersistTimer = null;
      persistState().catch(() => {});
    }, 120);
    if (typeof statePersistTimer.unref === 'function') {
      statePersistTimer.unref();
    }
  }

  async function ensureRuntimeDirs() {
    await Promise.all([
      fsp.mkdir(runtimeRoot, { recursive: true }),
      fsp.mkdir(uploadDir, { recursive: true }),
      fsp.mkdir(downloadDir, { recursive: true }),
      fsp.mkdir(logDir, { recursive: true })
    ]);
  }

  async function removeIfExists(targetPath) {
    try {
      await fsp.rm(targetPath, { recursive: true, force: true });
    } catch (_error) {
      // Ignore cleanup failures.
    }
  }

  async function safeStat(targetPath) {
    try {
      return await fsp.stat(targetPath);
    } catch (_error) {
      return null;
    }
  }

  async function persistState() {
    await ensureRuntimeDirs();
    await fsp.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
  }

  async function appendUploadLog(message) {
    try {
      await ensureRuntimeDirs();
      await fsp.appendFile(
        uploadLogPath,
        `[${new Date().toISOString()}] ${String(message || '')}\n`,
        'utf8'
      );
    } catch (_error) {
      // Ignore auxiliary logging failures.
    }
  }

  function updateState(patch) {
    state = {
      ...state,
      ...patch,
      updated_at_ms: Date.now()
    };
    scheduleStatePersist();
  }

  async function loadStateFromDisk() {
    try {
      const raw = await fsp.readFile(statePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        state = {
          ...createInitialState(),
          ...parsed,
          updated_at_ms: Number(parsed.updated_at_ms) || Date.now()
        };
      }
    } catch (_error) {
      state = createInitialState();
    }
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

  function createAuthSignature(username, expiresAt) {
    return crypto
      .createHmac('sha256', authSecret)
      .update(`${username}.${expiresAt}`)
      .digest('base64url');
  }

  function issueAuthToken(username) {
    const expiresAt = Date.now() + authTtlMs;
    const signature = createAuthSignature(username, expiresAt);
    return `${username}.${expiresAt}.${signature}`;
  }

  function isAuthUsernameAllowed(username) {
    return authAccounts.has(String(username || '').trim());
  }

  function isLoginValid(username, password) {
    const normalizedUsername = String(username || '').trim();
    if (!normalizedUsername || !isAuthUsernameAllowed(normalizedUsername)) {
      return false;
    }
    return timingSafeEqualText(password, authAccounts.get(normalizedUsername));
  }

  function verifyAuthToken(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) {
      return null;
    }

    const [username, expiresAtRaw, signature] = parts;
    const expiresAt = Number(expiresAtRaw);
    if (!username || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      return null;
    }

    if (!isAuthUsernameAllowed(username)) {
      return null;
    }

    const expectedSignature = createAuthSignature(username, expiresAt);
    if (!timingSafeEqualText(signature, expectedSignature)) {
      return null;
    }

    return {
      username,
      expires_at_ms: expiresAt
    };
  }

  function getAuthFromRequest(req) {
    const cookies = parseCookies(req.headers.cookie);
    return verifyAuthToken(cookies[authCookieName]);
  }

  function setAuthCookie(res, token) {
    res.append(
      'Set-Cookie',
      serializeCookie(authCookieName, token, {
        path: '/',
        maxAgeMs: authTtlMs,
        httpOnly: true,
        sameSite: 'Lax'
      })
    );
  }

  function clearAuthCookie(res) {
    res.append(
      'Set-Cookie',
      serializeCookie(authCookieName, '', {
        path: '/',
        maxAgeMs: 0,
        httpOnly: true,
        sameSite: 'Lax'
      })
    );
  }

  function requireCloudMappingAuth(req, res, next) {
    const auth = getAuthFromRequest(req);
    if (!auth) {
      clearAuthCookie(res);
      return res.status(401).json({
        ok: false,
        error: 'cloud_mapping_auth_required'
      });
    }

    req.cloudMappingAuth = auth;
    return next();
  }

  function sanitizeFileName(name) {
    const baseName = path.basename(String(name || ''))
      .replace(/[^\w.\u4e00-\u9fa5-]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');
    return baseName || 'upload.bag';
  }

  function toPercent(current, total) {
    if (!(Number.isFinite(current) && Number.isFinite(total) && total > 0)) {
      return 0;
    }
    return Math.max(0, Math.min(100, Number(((current / total) * 100).toFixed(2))));
  }

  function sanitizeOutputChunk(chunk) {
    return String(chunk || '')
      .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
      .replace(/\u0000/g, '');
  }

  function parseBagPlaybackProgress(text) {
    const regex = /Duration:\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*([0-9]+(?:\.[0-9]+)?)/g;
    let latestMatch = null;
    let match = regex.exec(text);
    while (match) {
      latestMatch = match;
      match = regex.exec(text);
    }

    if (!latestMatch) {
      return null;
    }

    const current = Number(latestMatch[1]);
    const total = Number(latestMatch[2]);
    if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) {
      return null;
    }

    return {
      current,
      total,
      pct: Math.min(99, toPercent(current, total))
    };
  }

  async function writePidFile(pid) {
    await ensureRuntimeDirs();
    await fsp.writeFile(pidFilePath, `${pid}\n`, 'utf8');
  }

  async function readPidFile() {
    try {
      const raw = await fsp.readFile(pidFilePath, 'utf8');
      const pid = Number.parseInt(String(raw || '').trim(), 10);
      return Number.isFinite(pid) ? pid : null;
    } catch (_error) {
      return null;
    }
  }

  async function isPidAlive(pid) {
    if (!Number.isFinite(pid) || pid <= 0) {
      return false;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (_error) {
      return false;
    }
  }

  async function readProcCmdline(pid) {
    if (!(await isPidAlive(pid))) {
      return '';
    }
    try {
      const cmdline = await fsp.readFile(`/proc/${pid}/cmdline`, 'utf8');
      return cmdline.replace(/\u0000/g, ' ').trim();
    } catch (_error) {
      return '';
    }
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function stopPidGracefully(pid) {
    if (!(await isPidAlive(pid))) {
      return;
    }

    try {
      process.kill(pid, 'SIGINT');
    } catch (_error) {
      return;
    }

    for (let index = 0; index < 50; index += 1) {
      if (!(await isPidAlive(pid))) {
        return;
      }
      await delay(100);
    }

    try {
      process.kill(pid, 'SIGTERM');
    } catch (_error) {
      return;
    }

    for (let index = 0; index < 20; index += 1) {
      if (!(await isPidAlive(pid))) {
        return;
      }
      await delay(100);
    }

    try {
      process.kill(pid, 'SIGKILL');
    } catch (_error) {
      // Ignore final cleanup failure.
    }
  }

  async function stopManagedProcessIfStale() {
    const pid = await readPidFile();
    if (!pid) {
      return;
    }

    if (mappingTaskProcess && mappingTaskProcess.pid === pid) {
      return;
    }

    const cmdline = await readProcCmdline(pid);
    if (!cmdline || !cmdline.includes(path.basename(mappingRunnerPath))) {
      await removeIfExists(pidFilePath);
      return;
    }

    await stopPidGracefully(pid);
    await removeIfExists(pidFilePath);
  }

  async function syncStateWithArtifacts() {
    const bagStat = await safeStat(uploadedBagPath);
    const zipStat = await safeStat(resultZipPath);
    const pid = await readPidFile();
    const pidAlive = pid ? await isPidAlive(pid) : false;

    if (!bagStat) {
      state.uploaded_bag_name = null;
      state.uploaded_bag_size_bytes = 0;
      state.uploaded_bag_updated_at_ms = null;
    }

    if (!zipStat) {
      state.result_zip_name = null;
      state.result_zip_size_bytes = 0;
      state.result_zip_updated_at_ms = null;
    }

    state.runner_pid = pidAlive ? pid : null;

    if (mappingUploadInFlight || (mappingTaskProcess && !mappingTaskProcess.killed) || pidAlive) {
      if (pidAlive && !mappingTaskProcess && state.phase === 'running') {
        state.stage_text = state.stage_text || '建图任务运行中，请稍候。';
      }
      return;
    }

    if (state.phase === 'uploading') {
      state.phase = bagStat ? 'ready' : 'idle';
      state.progress_pct = bagStat ? 100 : 0;
      state.stage_text = bagStat ? 'bag 上传完成，等待开始建图。' : '登录后上传 bag，并手动开始建图。';
      state.active_username = bagStat ? state.active_username : null;
    } else if (['running', 'packaging'].includes(state.phase)) {
      if (zipStat) {
        state.phase = 'completed';
        state.progress_pct = 100;
        state.stage_text = '建图完成，可下载 map.zip。';
      } else if (bagStat) {
        state.phase = 'ready';
        state.progress_pct = 100;
        state.stage_text = '上一轮任务已结束，当前 bag 等待重新开始建图。';
      } else {
        state.phase = 'idle';
        state.progress_pct = 0;
        state.stage_text = '登录后上传 bag，并手动开始建图。';
        state.active_username = null;
      }
    } else if (state.phase === 'error') {
      if (!bagStat && !zipStat) {
        state.phase = 'idle';
        state.progress_pct = 0;
        state.error_message = null;
        state.stage_text = '登录后上传 bag，并手动开始建图。';
        state.active_username = null;
      }
    }

    if (!bagStat && !zipStat && !mappingUploadInFlight && !pidAlive && state.phase === 'idle') {
      state.active_username = null;
      state.task_name = '';
      state.scene_type = '';
      state.task_note = '';
    }
  }

  function makeStatusResponse(req) {
    const auth = getAuthFromRequest(req);
    const busy = ['uploading', 'running', 'packaging'].includes(state.phase);
    return {
      ok: true,
      auth: {
        authenticated: Boolean(auth),
        username: auth?.username || null,
        expires_at_ms: auth?.expires_at_ms || null
      },
      task: {
        phase: state.phase,
        busy,
        active_username: state.active_username,
        progress_pct: state.progress_pct,
        stage_text: state.stage_text,
        task_name: state.task_name,
        scene_type: state.scene_type,
        task_note: state.task_note,
        error_message: state.error_message,
        started_at_ms: state.started_at_ms,
        completed_at_ms: state.completed_at_ms,
        updated_at_ms: state.updated_at_ms
      },
      uploaded_bag: state.uploaded_bag_name
        ? {
            name: state.uploaded_bag_name,
            size_bytes: state.uploaded_bag_size_bytes,
            updated_at_ms: state.uploaded_bag_updated_at_ms
          }
        : null,
      result_zip: state.result_zip_name
        ? {
            name: state.result_zip_name,
            size_bytes: state.result_zip_size_bytes,
            updated_at_ms: state.result_zip_updated_at_ms,
            download_url: '/api/cloud-mapping/download'
          }
        : null
    };
  }

  function updateStageFromRunnerOutput(chunk) {
    const text = sanitizeOutputChunk(chunk);
    if (!text) {
      return;
    }

    if (mappingTaskLogStream) {
      mappingTaskLogStream.write(text);
    }

    if (text.includes('Starting rosmaster')) {
      updateState({
        phase: 'running',
        progress_pct: Math.max(state.progress_pct, 1),
        stage_text: '正在启动 ROS 环境。'
      });
    }
    if (text.includes('Starting gps_data_transform')) {
      updateState({
        phase: 'running',
        progress_pct: Math.max(state.progress_pct, 2),
        stage_text: '正在启动数据转换模块。'
      });
    }
    if (text.includes('Starting FAST-LIO front-end')) {
      updateState({
        phase: 'running',
        progress_pct: Math.max(state.progress_pct, 3),
        stage_text: '正在启动前端建图模块。'
      });
    }
    if (text.includes('Starting PGO back-end')) {
      updateState({
        phase: 'running',
        progress_pct: Math.max(state.progress_pct, 4),
        stage_text: '正在启动后端图优化模块。'
      });
    }
    if (text.includes('Playing ')) {
      updateState({
        phase: 'running',
        progress_pct: Math.max(state.progress_pct, 5),
        stage_text: '开始回放 bag，正在建图中。'
      });
    }

    const progress = parseBagPlaybackProgress(text);
    if (progress) {
      updateState({
        phase: 'running',
        progress_pct: progress.pct,
        stage_text: `建图中，已处理 bag ${progress.current.toFixed(2)} / ${progress.total.toFixed(2)} 秒。`
      });
    }

    if (text.includes('Bag playback finished')) {
      updateState({
        phase: 'packaging',
        progress_pct: Math.max(state.progress_pct, 99),
        stage_text: 'bag 已回放完成，正在收尾并保存地图。'
      });
    }
    if (text.includes('Run completed')) {
      updateState({
        phase: 'packaging',
        progress_pct: 99,
        stage_text: '建图完成，正在压缩 map.zip。'
      });
    }
  }

  async function packageResultZip() {
    await ensureRuntimeDirs();
    await removeIfExists(resultZipPath);

    const mapStat = await safeStat(sourceMapDir);
    if (!mapStat || !mapStat.isDirectory()) {
      throw new Error(`map folder not found: ${sourceMapDir}`);
    }

    await execFileAsync(
      'zip',
      ['-qr', resultZipPath, path.basename(sourceMapDir)],
      {
        cwd: path.dirname(sourceMapDir),
        maxBuffer: 32 * 1024 * 1024
      }
    );

    const zipStat = await safeStat(resultZipPath);
    if (!zipStat || !zipStat.isFile()) {
      throw new Error('map.zip packaging failed');
    }

    return zipStat;
  }

  async function finalizeTaskAsCompleted() {
    updateState({
      phase: 'packaging',
      progress_pct: 99,
      stage_text: '建图完成，正在压缩 map.zip。',
      error_message: null
    });

    const zipStat = await packageResultZip();
    await removeIfExists(pidFilePath);
    updateState({
      phase: 'completed',
      progress_pct: 100,
      stage_text: '建图完成，可下载 map.zip。',
      result_zip_name: 'map.zip',
      result_zip_size_bytes: zipStat.size,
      result_zip_updated_at_ms: zipStat.mtimeMs,
      completed_at_ms: Date.now(),
      runner_pid: null
    });
  }

  async function markTaskAsFailed(message) {
    await removeIfExists(pidFilePath);
    updateState({
      phase: 'error',
      stage_text: '建图失败，请检查 bag 或稍后重试。',
      error_message: String(message || 'cloud_mapping_failed'),
      completed_at_ms: Date.now(),
      runner_pid: null
    });
  }

  async function startMappingTask(auth, payload) {
    await ensureRuntimeDirs();
    await stopManagedProcessIfStale();
    await removeIfExists(resultZipPath);
    await removeIfExists(runnerLogPath);
    await appendUploadLog(
      `mapping_start username=${auth.username} bag=${path.basename(uploadedBagPath)} task=${payload.task_name || '-'}`
    );

    mappingTaskLogStream = fs.createWriteStream(runnerLogPath, {
      flags: 'a',
      encoding: 'utf8'
    });

    updateState({
      phase: 'running',
      active_username: auth.username,
      progress_pct: 0,
      stage_text: '准备启动建图脚本。',
      task_name: payload.task_name,
      scene_type: payload.scene_type,
      task_note: payload.task_note,
      error_message: null,
      started_at_ms: Date.now(),
      completed_at_ms: null,
      result_zip_name: null,
      result_zip_size_bytes: 0,
      result_zip_updated_at_ms: null
    });

    const child = spawn(mappingRunnerPath, [uploadedBagPath], {
      cwd: path.dirname(mappingRunnerPath),
      env: {
        ...process.env
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    mappingTaskProcess = child;
    await writePidFile(child.pid);
    updateState({
      runner_pid: child.pid
    });

    child.stdout.on('data', (chunk) => updateStageFromRunnerOutput(chunk));
    child.stderr.on('data', (chunk) => updateStageFromRunnerOutput(chunk));
    child.on('error', async (error) => {
      mappingTaskProcess = null;
      if (mappingTaskLogStream) {
        mappingTaskLogStream.end();
        mappingTaskLogStream = null;
      }
      await appendUploadLog(`mapping_spawn_error detail=${error?.message || 'unknown'}`);
      await markTaskAsFailed(error?.message || 'cloud_mapping_spawn_failed');
    });
    child.on('exit', async (code, signal) => {
      mappingTaskProcess = null;
      if (mappingTaskLogStream) {
        mappingTaskLogStream.end();
        mappingTaskLogStream = null;
      }

      if (signal || code !== 0) {
        await appendUploadLog(
          `mapping_exit_failed signal=${signal || '-'} code=${Number.isFinite(code) ? code : '-'}`
        );
        await markTaskAsFailed(
          signal
            ? `建图脚本被中断：${signal}`
            : `建图脚本退出异常，exit code=${code}`
        );
        return;
      }

      try {
        await appendUploadLog('mapping_exit_ok packaging_map_zip');
        await finalizeTaskAsCompleted();
      } catch (error) {
        await appendUploadLog(`mapping_package_failed detail=${error?.message || 'unknown'}`);
        await markTaskAsFailed(error?.message || 'map_zip_packaging_failed');
      }
    });
  }

  async function clearUploadedBagState() {
    await removeIfExists(uploadedBagPath);
    await removeIfExists(uploadedBagPartPath);
    updateState({
      uploaded_bag_name: null,
      uploaded_bag_size_bytes: 0,
      uploaded_bag_updated_at_ms: null
    });
  }

  async function clearResultZipState() {
    await removeIfExists(resultZipPath);
    updateState({
      result_zip_name: null,
      result_zip_size_bytes: 0,
      result_zip_updated_at_ms: null
    });
  }

  void ensureRuntimeDirs()
    .then(loadStateFromDisk)
    .then(syncStateWithArtifacts)
    .then(() => persistState())
    .catch(() => {});

  app.get('/api/cloud-mapping/status', async (req, res) => {
    await syncStateWithArtifacts();
    return res.json(makeStatusResponse(req));
  });

  app.post('/api/cloud-mapping/login', (req, res) => {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!isLoginValid(username, password)) {
      clearAuthCookie(res);
      return res.status(401).json({
        ok: false,
        error: 'cloud_mapping_login_failed'
      });
    }

    const token = issueAuthToken(username);
    setAuthCookie(res, token);
    return res.json({
      ok: true,
      authenticated: true,
      username,
      expires_at_ms: verifyAuthToken(token)?.expires_at_ms || null
    });
  });

  app.post('/api/cloud-mapping/logout', (_req, res) => {
    clearAuthCookie(res);
    return res.json({
      ok: true,
      authenticated: false
    });
  });

  app.post('/api/cloud-mapping/upload', requireCloudMappingAuth, async (req, res) => {
    await syncStateWithArtifacts();
    if (['uploading', 'running', 'packaging'].includes(state.phase)) {
      return res.status(409).json({
        ok: false,
        error: 'cloud_mapping_busy',
        active_username: state.active_username
      });
    }

    if (mappingUploadInFlight) {
      return res.status(409).json({
        ok: false,
        error: 'cloud_mapping_upload_busy'
      });
    }

    const rawFileName = decodeURIComponent(String(req.headers['x-file-name'] || ''));
    const safeFileName = sanitizeFileName(rawFileName);
    if (!safeFileName.toLowerCase().endsWith('.bag')) {
      return res.status(400).json({
        ok: false,
        error: 'bag_file_required'
      });
    }

    const expectedSize = Number(
      req.headers['x-file-size'] || req.headers['content-length'] || 0
    );
    if (Number.isFinite(expectedSize) && expectedSize > uploadMaxBytes) {
      return res.status(413).json({
        ok: false,
        error: 'bag_file_too_large'
      });
    }

    mappingUploadInFlight = true;
    await ensureRuntimeDirs();
    await removeIfExists(uploadedBagPartPath);
    await appendUploadLog(
      `upload_start username=${req.cloudMappingAuth.username} file=${safeFileName} expected_size=${expectedSize || 0}`
    );

    updateState({
      phase: 'uploading',
      active_username: req.cloudMappingAuth.username,
      progress_pct: 0,
      stage_text: `${req.cloudMappingAuth.username} 正在上传 bag。`,
      error_message: null
    });

    let receivedBytes = 0;
    let uploadFailed = false;
    const writeStream = fs.createWriteStream(uploadedBagPartPath, {
      flags: 'w'
    });

    const failUpload = async (errorMessage, statusCode = 500) => {
      if (uploadFailed) {
        return;
      }
      uploadFailed = true;
      mappingUploadInFlight = false;
      writeStream.destroy();
      await removeIfExists(uploadedBagPartPath);
      await appendUploadLog(
        `upload_fail username=${req.cloudMappingAuth.username} file=${safeFileName} received=${receivedBytes} error=${errorMessage}`
      );
      await syncStateWithArtifacts();
      updateState({
        phase: state.uploaded_bag_name ? 'ready' : 'idle',
        progress_pct: state.uploaded_bag_name ? 100 : 0,
        stage_text: state.uploaded_bag_name
          ? 'bag 已上传，等待开始建图。'
          : '登录后上传 bag，并手动开始建图。',
        error_message: errorMessage
      });
      if (!res.headersSent) {
        res.status(statusCode).json({
          ok: false,
          error: errorMessage
        });
      }
    };

    req.on('data', (chunk) => {
      receivedBytes += chunk.length;
      if (receivedBytes > uploadMaxBytes) {
        void failUpload('bag_file_too_large', 413);
        req.destroy();
        return;
      }

      if (Number.isFinite(expectedSize) && expectedSize > 0) {
        updateState({
          progress_pct: toPercent(receivedBytes, expectedSize),
          stage_text: `${req.cloudMappingAuth.username} 正在上传 bag（${(
            receivedBytes /
            1024 /
            1024
          ).toFixed(1)} / ${(expectedSize / 1024 / 1024).toFixed(1)} MB）。`
        });
      }
    });

    req.on('aborted', () => {
      void appendUploadLog(
        `upload_aborted username=${req.cloudMappingAuth.username} file=${safeFileName} received=${receivedBytes}`
      );
      void failUpload('bag_upload_aborted', 499);
    });

    req.on('error', (error) => {
      void failUpload(error?.message || 'bag_upload_failed');
    });

    writeStream.on('error', (error) => {
      void failUpload(error?.message || 'bag_write_failed');
    });

    writeStream.on('finish', async () => {
      if (uploadFailed) {
        return;
      }

      try {
        await removeIfExists(uploadedBagPath);
        await fsp.rename(uploadedBagPartPath, uploadedBagPath);
        const bagStat = await safeStat(uploadedBagPath);
        mappingUploadInFlight = false;
        await appendUploadLog(
          `upload_finish username=${req.cloudMappingAuth.username} file=${safeFileName} size=${bagStat?.size || receivedBytes}`
        );
        updateState({
          phase: 'ready',
          active_username: req.cloudMappingAuth.username,
          progress_pct: 100,
          stage_text: 'bag 上传完成，等待开始建图。',
          uploaded_bag_name: safeFileName,
          uploaded_bag_size_bytes: bagStat?.size || receivedBytes,
          uploaded_bag_updated_at_ms: bagStat?.mtimeMs || Date.now(),
          error_message: null
        });
        return res.json(makeStatusResponse(req));
      } catch (error) {
        return failUpload(error?.message || 'bag_finalize_failed');
      }
    });

    req.pipe(writeStream);
  });

  app.post('/api/cloud-mapping/start', requireCloudMappingAuth, async (req, res) => {
    await syncStateWithArtifacts();
    if (['uploading', 'running', 'packaging'].includes(state.phase)) {
      return res.status(409).json({
        ok: false,
        error: 'cloud_mapping_busy',
        active_username: state.active_username
      });
    }

    const bagStat = await safeStat(uploadedBagPath);
    if (!bagStat || !bagStat.isFile()) {
      return res.status(400).json({
        ok: false,
        error: 'bag_not_uploaded'
      });
    }

    const payload = {
      task_name:
        typeof req.body?.task_name === 'string' ? req.body.task_name.trim().slice(0, 80) : '',
      scene_type:
        typeof req.body?.scene_type === 'string' ? req.body.scene_type.trim().slice(0, 40) : '',
      task_note:
        typeof req.body?.task_note === 'string' ? req.body.task_note.trim().slice(0, 200) : ''
    };

    try {
      await startMappingTask(req.cloudMappingAuth, payload);
      await syncStateWithArtifacts();
      return res.json(makeStatusResponse(req));
    } catch (error) {
      await markTaskAsFailed(error?.message || 'cloud_mapping_start_failed');
      return res.status(500).json({
        ok: false,
        error: 'cloud_mapping_start_failed',
        detail: error?.message || 'cloud_mapping_start_failed'
      });
    }
  });

  app.post('/api/cloud-mapping/clear-bag', requireCloudMappingAuth, async (req, res) => {
    await syncStateWithArtifacts();
    if (['uploading', 'running', 'packaging'].includes(state.phase)) {
      return res.status(409).json({
        ok: false,
        error: 'cloud_mapping_busy',
        active_username: state.active_username
      });
    }

    await clearUploadedBagState();
    await syncStateWithArtifacts();

    updateState({
      phase: state.result_zip_name ? 'completed' : 'idle',
      active_username: state.result_zip_name ? state.active_username : null,
      progress_pct: state.result_zip_name ? 100 : 0,
      stage_text: state.result_zip_name
        ? '临时 bag 已清空，可继续下载 map.zip。'
        : '登录后上传 bag，并手动开始建图。',
      task_name: state.result_zip_name ? state.task_name : '',
      scene_type: state.result_zip_name ? state.scene_type : '',
      task_note: state.result_zip_name ? state.task_note : '',
      error_message: null
    });

    return res.json(makeStatusResponse(req));
  });

  app.post('/api/cloud-mapping/clear-result', requireCloudMappingAuth, async (req, res) => {
    await syncStateWithArtifacts();
    if (['uploading', 'running', 'packaging'].includes(state.phase)) {
      return res.status(409).json({
        ok: false,
        error: 'cloud_mapping_busy',
        active_username: state.active_username
      });
    }

    await clearResultZipState();
    await syncStateWithArtifacts();

    updateState({
      phase: state.uploaded_bag_name ? 'ready' : 'idle',
      active_username: state.uploaded_bag_name ? state.active_username : null,
      progress_pct: state.uploaded_bag_name ? 100 : 0,
      stage_text: state.uploaded_bag_name
        ? '临时 map.zip 已清空，当前 bag 可重新开始建图。'
        : '登录后上传 bag，并手动开始建图。',
      error_message: null
    });

    return res.json(makeStatusResponse(req));
  });

  app.get('/api/cloud-mapping/download', requireCloudMappingAuth, async (_req, res) => {
    const zipStat = await safeStat(resultZipPath);
    if (!zipStat || !zipStat.isFile()) {
      return res.status(404).json({
        ok: false,
        error: 'map_zip_not_found'
      });
    }

    return res.download(resultZipPath, 'map.zip');
  });
};
