const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const readline = require('readline');

const CONTROL_VEHICLE_ID = 'BIT-0041';
const CONTROL_ENDPOINTS = new Set(['bootstrap', 'status', 'acquire', 'command', 'heartbeat', 'release', 'estop']);
const WEBRTC_TARGETS = {
  edge: 'http://120.25.209.170:9999/rtc-edge/v1/play/',
  origin: 'http://47.112.103.12:1985/rtc/v1/play/'
};

function boolEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function normalizeWebRtcHttpStatus(status, responseText) {
  if (Number(status) !== 404) {
    return Number(status);
  }
  try {
    const payload = JSON.parse(String(responseText || ''));
    if (Number(payload.code) === 404 && /stream not active/i.test(String(payload.msg || payload.message || ''))) {
      return 200;
    }
  } catch (_error) {
    return Number(status);
  }
  return Number(status);
}

function requestRemoteDriveSidecar(upstreamBase, endpoint, method, payload, controlToken, timeoutMs) {
  const body = method === 'POST' ? JSON.stringify(payload || {}) : '';
  const target = new URL(`/api/control/${endpoint}`, upstreamBase);
  return new Promise((resolve, reject) => {
    const request = http.request(target, {
      method,
      agent: false,
      headers: {
        Accept: 'application/json',
        ...(controlToken ? { 'X-Control-Token': controlToken } : {}),
        ...(method === 'POST' ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        } : {})
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          status: Number(response.statusCode || 502),
          contentType: response.headers['content-type'] || 'application/json',
          text: Buffer.concat(chunks).toString('utf8')
        });
      });
    });
    request.setTimeout(timeoutMs, () => {
      const error = new Error('remote drive sidecar request timed out');
      error.name = 'AbortError';
      request.destroy(error);
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function startRemoteDriveSidecar(rootDir, options = {}) {
  if (boolEnv(process.env.REMOTE_DRIVE_SIDECAR_DISABLED) || options.disabled) {
    return { child: null, ready: false, disabled: true };
  }

  const state = {
    child: null,
    ready: false,
    disabled: false,
    restartTimer: null
  };
  const scriptPath = path.join(rootDir, 'backend/remote-drive/server.py');
  const pythonBin = process.env.REMOTE_DRIVE_PYTHON || '/usr/bin/python3';

  const launch = () => {
    if (state.child) {
      return;
    }
    state.ready = false;
    const child = spawn(pythonBin, ['-u', scriptPath], {
      cwd: path.dirname(scriptPath),
      env: {
        ...process.env,
        VEHICLE_VIEWER_HOST: '127.0.0.1',
        VEHICLE_VIEWER_PORT: String(process.env.REMOTE_DRIVE_PORT || '18766'),
        VEHICLE_VIEWER_ACCESS_LOG: '0',
        VEHICLE_CONTROL_TRANSPORT: 'mqtt',
        VEHICLE_MQTT_CONFIG:
          process.env.REMOTE_DRIVE_MQTT_CONFIG ||
          path.join(rootDir, '.runtime/remote-drive/mqtt-config.yaml'),
        VEHICLE_CONTROL_SSH_TARGET:
          process.env.REMOTE_DRIVE_SSH_TARGET || 'nvidia@100.98.77.65',
        VEHICLE_CONTROL_SSH_KEY:
          process.env.REMOTE_DRIVE_SSH_KEY ||
          '/home/admin1/.ssh/jgzj_vehicle_diag_ed25519'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    state.child = child;

    child.stdout.setEncoding('utf8');
    const outputLines = readline.createInterface({ input: child.stdout });
    outputLines.on('line', (line) => {
      try {
        const event = JSON.parse(line);
        if (event.event === 'server_ready') {
          state.ready = true;
          console.info('remote_drive_sidecar_ready', JSON.stringify({
            transport: event.transport,
            vehicle: event.vehicle
          }));
        }
      } catch (_error) {
        console.info('remote_drive_sidecar_output', line.slice(0, 500));
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const detail = String(chunk || '').trim();
      if (detail) {
        console.warn('remote_drive_sidecar_stderr', detail.slice(0, 1200));
      }
    });
    child.once('exit', (code, signal) => {
      state.child = null;
      state.ready = false;
      console.warn('remote_drive_sidecar_exit', JSON.stringify({ code, signal }));
      state.restartTimer = setTimeout(launch, 2000);
      state.restartTimer.unref?.();
    });
  };

  launch();
  return state;
}

async function recordRemoteDriveAudit(operationAuditStore, req, action, status, detail = {}) {
  if (!operationAuditStore || !['acquire', 'release', 'estop'].includes(action)) {
    return;
  }
  try {
    await operationAuditStore.record({
      actor: req.jgzjAuth?.user?.username || null,
      actor_name: req.jgzjAuth?.user?.display_name || null,
      category: 'vehicle_control',
      action: `remote_drive_${action}`,
      target_type: 'vehicle',
      target_id: CONTROL_VEHICLE_ID,
      vehicle_id: CONTROL_VEHICLE_ID,
      permission: 'vehicle:control',
      status,
      method: req.method,
      path: req.originalUrl || req.url,
      ip: req.ip,
      user_agent: req.headers['user-agent'] || null,
      detail
    });
  } catch (error) {
    console.warn('remote_drive_audit_failed', error.message);
  }
}

function registerRemoteDriveRoutes(app, options = {}) {
  const requirePermission = options.requirePermission;
  if (typeof requirePermission !== 'function') {
    throw new Error('remote drive requires permission middleware');
  }
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, '..'));
  const sidecar = startRemoteDriveSidecar(rootDir, options.sidecar || {});
  const upstreamBase = `http://127.0.0.1:${Number(process.env.REMOTE_DRIVE_PORT || 18766)}`;
  const permission = requirePermission('vehicle:control');

  const proxy = (endpoint, method) => async (req, res) => {
    if (!CONTROL_ENDPOINTS.has(endpoint)) {
      return res.status(404).json({ ok: false, error: 'remote_drive_endpoint_not_found' });
    }
    const startedAt = Date.now();
    const timeoutMs = endpoint === 'acquire' ? 45000 : 5000;
    try {
      const controlToken = String(req.headers['x-control-token'] || '').trim();
      const response = await requestRemoteDriveSidecar(
        upstreamBase,
        endpoint,
        method,
        req.body || {},
        controlToken,
        timeoutMs
      );
      const text = response.text;
      let auditDetail = { duration_ms: Date.now() - startedAt };
      try {
        const payload = JSON.parse(text);
        auditDetail = {
          ...auditDetail,
          error: payload.error || null,
          released: payload.released,
          reason: payload.reason
        };
      } catch (_error) {
        auditDetail.error = 'invalid_sidecar_response';
      }
      await recordRemoteDriveAudit(options.operationAuditStore, req, endpoint, response.status, auditDetail);
      res.status(response.status);
      res.setHeader('Cache-Control', 'private, no-store');
      res.type(response.contentType).send(text);
    } catch (error) {
      const detail = error.name === 'AbortError'
        ? '远程驾驶安全网关响应超时'
        : `远程驾驶安全网关不可用: ${error.message}`;
      await recordRemoteDriveAudit(options.operationAuditStore, req, endpoint, 503, {
        duration_ms: Date.now() - startedAt,
        error: detail
      });
      return res.status(503).json({
        ok: false,
        error: detail,
        sidecar_ready: sidecar.ready
      });
    }
  };

  app.get('/api/remote-drive/bootstrap', permission, proxy('bootstrap', 'GET'));
  app.get('/api/remote-drive/status', permission, proxy('status', 'GET'));
  app.post('/api/remote-drive/acquire', permission, proxy('acquire', 'POST'));
  app.post('/api/remote-drive/command', permission, proxy('command', 'POST'));
  app.post('/api/remote-drive/heartbeat', permission, proxy('heartbeat', 'POST'));
  app.post('/api/remote-drive/release', permission, proxy('release', 'POST'));
  app.post('/api/remote-drive/estop', permission, proxy('estop', 'POST'));
  app.post('/api/remote-drive/webrtc/:route/play', permission, async (req, res) => {
    const upstreamUrl = WEBRTC_TARGETS[String(req.params.route || '').toLowerCase()];
    if (!upstreamUrl) {
      return res.status(404).json({ ok: false, error: 'webrtc_route_not_found' });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(upstreamUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ...(req.body || {}), api: upstreamUrl }),
        signal: controller.signal
      });
      const text = await response.text();
      res.status(normalizeWebRtcHttpStatus(response.status, text));
      res.setHeader('Cache-Control', 'private, no-store');
      res.type(response.headers.get('content-type') || 'application/json').send(text);
    } catch (error) {
      return res.status(502).json({
        ok: false,
        error: error.name === 'AbortError' ? '视频信令超时' : `视频信令失败: ${error.message}`
      });
    } finally {
      clearTimeout(timeout);
    }
  });

  return sidecar;
}

module.exports = {
  CONTROL_ENDPOINTS,
  WEBRTC_TARGETS,
  normalizeWebRtcHttpStatus,
  requestRemoteDriveSidecar,
  registerRemoteDriveRoutes,
  startRemoteDriveSidecar
};
