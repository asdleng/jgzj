const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const readline = require('readline');
const { WebSocketServer } = require('ws');

const CONTROL_VEHICLE_ID = 'BIT-0041';
const CONTROL_ENDPOINTS = new Set(['bootstrap', 'status', 'acquire', 'command', 'heartbeat', 'release', 'estop']);
const TASK_PLAN_VINS = Object.freeze({
  'BIT-0011': 'a001i3829202651720595339',
  'BIT-0013': 'a001I3829202691723622254',
  'BIT-0016': 'a001I3829202591733810464',
  'BIT-0019': 'a001I3829202911732775610',
  'BIT-0020': 'a001I3829202661733810464',
  'BIT-0022': 'a001I382920271I382920271',
  'BIT-0030': 'a001I3829202831732866810',
  'BIT-0031': 'a001I3829202911763350050',
  'BIT-0032': 'a001I3829202901763433057',
  'BIT-0033': 'a001J2507800691764296379',
  'BIT-0034': 'a001J2507800731763913599',
  'BIT-0036': 'a001J3770700651775700467',
  'BIT-0037': 'a001J2507800531775700672',
  'BIT-0038': 'a001I3829202881775700760',
  'BIT-0039': 'a001J2507800651775701476',
  'BIT-0040': 'a001I3829202741775711588',
  'BIT-0041': 'a001I3829202711775712260',
  'BIT-0042': 'a001J3770700371775713195',
  'BIT-0046': 'a001J2507800931782713473',
  'BIT-0047': 'a001I3829202651778135815',
  'FTUGV-002': 'a001I3829202641733810464',
  'FTUGV-004': 'a001i3829202651720596608'
});
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

function cstTimeOfDay(value) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(value));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.hour}:${byType.minute}:${byType.second}`;
}

function normalizeRouteCatalog(payload) {
  const source = Array.isArray(payload) ? payload : [];
  const seen = new Set();
  return source.flatMap((item) => {
    const routeId = String(item?.route_id || item?.routeId || item?.id || '').trim();
    if (!routeId || routeId.length > 240 || seen.has(routeId)) return [];
    seen.add(routeId);
    const names = Array.isArray(item?.names) ? item.names : [];
    const label = String(names.find((name) => String(name || '').trim()) || item?.name || routeId).trim();
    return [{ route_id: routeId, name: label.slice(0, 160) || routeId }];
  });
}

class TaskPlanScheduler {
  constructor(options = {}) {
    this.now = options.now || Date.now;
    this.publishPlan = options.publishPlan;
    this.storePath = options.storePath;
    this.plans = [];
    this.dispatching = false;
    this.stopInProgress = false;
    this.disabled = Boolean(options.disabled);
    this._load();
    this.timer = this.disabled || options.start === false
      ? null
      : setInterval(() => void this.tick(), 1000);
    this.timer?.unref?.();
  }

  _load() {
    if (this.disabled || !this.storePath) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
      this.plans = Array.isArray(parsed?.plans) ? parsed.plans.slice(0, 500) : [];
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('remote_task_plan_store_load_failed', error.message);
      }
      this.plans = [];
    }
    let changed = false;
    const now = this.now();
    this.plans.forEach((plan) => {
      if (plan.status === 'dispatching') {
        plan.status = 'delivery_unknown';
        plan.error = '服务重启时任务正在投递，未自动重发以避免重复启动';
        changed = true;
      } else if (plan.status === 'scheduled' && Date.parse(plan.end_at) <= now) {
        plan.status = 'expired';
        changed = true;
      }
    });
    if (changed) this._persist();
  }

  _persist() {
    if (this.disabled || !this.storePath) return;
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    const temporary = `${this.storePath}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, plans: this.plans }, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600
    });
    fs.renameSync(temporary, this.storePath);
  }

  create(input, actor = {}) {
    const vehicleId = String(input.vehicle_id || '').trim().toUpperCase();
    const vin = TASK_PLAN_VINS[vehicleId];
    if (!vin) throw new Error('不支持该车辆的任务计划');
    const mainRouteId = String(input.main_route_id || '').trim();
    const auxiliaryRouteId = String(input.auxiliary_route_id || '').trim();
    if (!mainRouteId || !auxiliaryRouteId || mainRouteId.length > 240 || auxiliaryRouteId.length > 240) {
      throw new Error('巡逻路线和接驳路线无效');
    }
    const startMs = Date.parse(input.start_at);
    const endMs = Date.parse(input.end_at);
    const now = this.now();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) throw new Error('开始或结束时间无效');
    if (startMs < now - 5000) throw new Error('开始时间不能早于当前时间');
    if (startMs > now + 31 * 24 * 60 * 60 * 1000) throw new Error('开始时间不能超过 31 天');
    if (endMs <= startMs) throw new Error('结束时间必须晚于开始时间');
    if (endMs - startMs > 48 * 60 * 60 * 1000) throw new Error('单次巡逻时长不能超过 48 小时');
    const speedKph = Number(input.speed_kph);
    const runCount = Number(input.run_count);
    const rechargePower = Number(input.recharge_power);
    if (!Number.isFinite(speedKph) || speedKph < 0.5 || speedKph > 8) {
      throw new Error('巡逻速度必须在 0.5-8.0 km/h');
    }
    if (!Number.isInteger(runCount) || runCount < 1 || runCount > 9999) {
      throw new Error('循环次数必须在 1-9999');
    }
    if (!Number.isInteger(rechargePower) || rechargePower < 1 || rechargePower > 100) {
      throw new Error('回充电量必须在 1-100%');
    }
    const createdAt = new Date(now).toISOString();
    const plan = {
      id: crypto.randomUUID(),
      vehicle_id: vehicleId,
      vin,
      main_route_id: mainRouteId,
      main_route_name: String(input.main_route_name || mainRouteId).slice(0, 160),
      auxiliary_route_id: auxiliaryRouteId,
      auxiliary_route_name: String(input.auxiliary_route_name || auxiliaryRouteId).slice(0, 160),
      start_at: new Date(startMs).toISOString(),
      end_at: new Date(endMs).toISOString(),
      speed_kph: speedKph,
      run_count: runCount,
      recharge_power: rechargePower,
      status: 'scheduled',
      created_at: createdAt,
      created_by: String(actor.username || '').slice(0, 120),
      created_by_name: String(actor.display_name || '').slice(0, 120),
      error: null,
      delivery: null
    };
    this.plans.unshift(plan);
    this.plans = this.plans.slice(0, 500);
    this._persist();
    return { ...plan };
  }

  list(vehicleId = '') {
    const normalized = String(vehicleId || '').trim().toUpperCase();
    return this.plans
      .filter((plan) => !normalized || plan.vehicle_id === normalized)
      .map((plan) => ({ ...plan }))
      .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
  }

  cancel(planId, vehicleId = '') {
    const plan = this.plans.find((item) => item.id === String(planId || ''));
    if (!plan || (vehicleId && plan.vehicle_id !== String(vehicleId).toUpperCase())) {
      throw new Error('任务计划不存在');
    }
    if (plan.status !== 'scheduled') throw new Error('只有待发布计划可以取消');
    plan.status = 'cancelled';
    plan.cancelled_at = new Date(this.now()).toISOString();
    this._persist();
    return { ...plan };
  }

  remove(planId, vehicleId = '') {
    const normalizedVehicleId = String(vehicleId || '').trim().toUpperCase();
    const index = this.plans.findIndex((item) => item.id === String(planId || ''));
    const plan = index >= 0 ? this.plans[index] : null;
    if (!plan || (normalizedVehicleId && plan.vehicle_id !== normalizedVehicleId)) {
      throw new Error('任务计划不存在');
    }
    if (plan.status === 'dispatching') throw new Error('任务正在投递，暂时不能删除');
    this.plans.splice(index, 1);
    this._persist();
    return {
      ...plan,
      previous_status: plan.status,
      deleted_at: new Date(this.now()).toISOString()
    };
  }

  hasDispatching(vehicleId) {
    const normalized = String(vehicleId || '').trim().toUpperCase();
    return this.plans.some((plan) => (
      plan.status === 'dispatching' && (!normalized || plan.vehicle_id === normalized)
    ));
  }

  beginStop(vehicleId) {
    if (this.stopInProgress) throw new Error('已有车辆停止请求正在处理');
    if (this.hasDispatching(vehicleId)) throw new Error('任务正在投递，请稍后再停止');
    this.stopInProgress = true;
  }

  endStop() {
    this.stopInProgress = false;
  }

  markStopped(vehicleId, stopResult = null) {
    const normalized = String(vehicleId || '').trim().toUpperCase();
    const now = this.now();
    const stoppedAt = new Date(now).toISOString();
    const changed = [];
    this.plans.forEach((plan) => {
      if (
        plan.vehicle_id === normalized
        && ['delivered', 'scheduled'].includes(plan.status)
        && (plan.status !== 'scheduled' || Date.parse(plan.start_at) <= now)
        && Date.parse(plan.end_at) > now
      ) {
        plan.status = 'stopped';
        plan.stopped_at = stoppedAt;
        plan.stop_result = stopResult || null;
        plan.error = null;
        changed.push({ ...plan });
      }
    });
    if (changed.length) this._persist();
    return changed;
  }

  async tick() {
    if (this.disabled || this.dispatching || this.stopInProgress || typeof this.publishPlan !== 'function') return;
    const now = this.now();
    const due = this.plans
      .filter((plan) => plan.status === 'scheduled' && Date.parse(plan.start_at) <= now)
      .sort((left, right) => Date.parse(left.start_at) - Date.parse(right.start_at))[0];
    if (!due) return;
    if (Date.parse(due.end_at) <= now) {
      due.status = 'expired';
      due.error = '服务恢复时任务结束时间已过，未投递';
      this._persist();
      return;
    }
    this.dispatching = true;
    due.status = 'dispatching';
    due.dispatch_started_at = new Date(now).toISOString();
    this._persist();
    try {
      const result = await this.publishPlan({ ...due });
      due.status = 'delivered';
      due.delivered_at = new Date(this.now()).toISOString();
      due.delivery = result || null;
      due.error = null;
    } catch (error) {
      due.status = 'delivery_unknown';
      due.error = String(error?.message || error || '任务投递失败').slice(0, 500);
    } finally {
      this.dispatching = false;
      this._persist();
    }
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
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

function createRemoteDriveWebSocketGateway(options = {}) {
  const upstreamBase = options.upstreamBase || `http://127.0.0.1:${Number(process.env.REMOTE_DRIVE_PORT || 18766)}`;
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const allowedEndpoints = new Set(['command', 'heartbeat', 'release', 'estop']);

  websocketServer.on('connection', (websocket) => {
    let activeSessionId = '';
    let activeToken = '';

    websocket.on('message', async (raw, isBinary) => {
      if (isBinary) {
        websocket.close(1003, 'text messages only');
        return;
      }
      let message;
      try {
        message = JSON.parse(raw.toString('utf8'));
      } catch (_error) {
        websocket.close(1007, 'invalid json');
        return;
      }
      const endpoint = String(message.endpoint || '');
      const requestId = message.id == null ? null : String(message.id);
      const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};
      const controlToken = String(message.token || '');
      if (!allowedEndpoints.has(endpoint) || !controlToken) {
        if (requestId != null && websocket.readyState === 1) {
          websocket.send(JSON.stringify({ id: requestId, ok: false, status: 400, error: 'invalid control message' }));
        }
        return;
      }
      const sessionId = String(payload.session_id || '');
      if (sessionId) {
        activeSessionId = sessionId;
        activeToken = controlToken;
      }
      try {
        const response = await requestRemoteDriveSidecar(
          upstreamBase,
          endpoint,
          'POST',
          payload,
          controlToken,
          endpoint === 'release' || endpoint === 'estop' ? 5000 : 2000
        );
        let responsePayload = {};
        try {
          responsePayload = JSON.parse(response.text);
        } catch (_error) {
          responsePayload = { error: 'invalid sidecar response' };
        }
        if (response.status >= 200 && response.status < 300 && (endpoint === 'release' || endpoint === 'estop')) {
          activeSessionId = '';
          activeToken = '';
        }
        if (requestId != null && websocket.readyState === 1) {
          websocket.send(JSON.stringify({
            id: requestId,
            ok: response.status >= 200 && response.status < 300 && responsePayload.ok !== false,
            status: response.status,
            payload: responsePayload,
            error: responsePayload.error || null
          }));
        }
      } catch (error) {
        if (requestId != null && websocket.readyState === 1) {
          websocket.send(JSON.stringify({ id: requestId, ok: false, status: 503, error: error.message }));
        }
      }
    });

    websocket.on('close', () => {
      if (!activeSessionId || !activeToken) return;
      void requestRemoteDriveSidecar(
        upstreamBase,
        'estop',
        'POST',
        { session_id: activeSessionId },
        activeToken,
        2000
      ).catch(() => {});
    });
  });

  return {
    handleUpgrade(req, socket, head) {
      websocketServer.handleUpgrade(req, socket, head, (websocket) => {
        websocketServer.emit('connection', websocket, req);
      });
    },
    close() {
      websocketServer.close();
    }
  };
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
  if (!operationAuditStore || ![
    'acquire',
    'release',
    'estop',
    'task_plan_create',
    'task_plan_cancel',
    'task_plan_stop',
    'task_plan_delete'
  ].includes(action)) {
    return;
  }
  try {
    const vehicleId = String(detail.vehicle_id || CONTROL_VEHICLE_ID);
    await operationAuditStore.record({
      actor: req.jgzjAuth?.user?.username || null,
      actor_name: req.jgzjAuth?.user?.display_name || null,
      category: 'vehicle_control',
      action: `remote_drive_${action}`,
      target_type: 'vehicle',
      target_id: vehicleId,
      vehicle_id: vehicleId,
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
  const taskPlanScheduler = new TaskPlanScheduler({
    disabled: Boolean(options.taskPlans?.disabled),
    start: options.taskPlans?.start,
    now: options.taskPlans?.now,
    storePath: options.taskPlans?.storePath || path.join(rootDir, '.runtime/remote-drive/task-plans.json'),
    publishPlan: options.taskPlans?.publishPlan || (async (plan) => {
      if (sidecar.disabled) throw new Error('任务计划发布服务未启动');
      const bootstrapResponse = await requestRemoteDriveSidecar(
        upstreamBase,
        'bootstrap',
        'GET',
        {},
        '',
        5000
      );
      let bootstrap = {};
      try {
        bootstrap = JSON.parse(bootstrapResponse.text);
      } catch (_error) {
        throw new Error('任务发布服务返回了无效认证信息');
      }
      if (bootstrapResponse.status < 200 || bootstrapResponse.status >= 300 || !bootstrap.token) {
        throw new Error(bootstrap.error || '任务发布服务尚未就绪');
      }
      const response = await requestRemoteDriveSidecar(
        upstreamBase,
        'task-plan',
        'POST',
        {
          plan_id: plan.id,
          vehicle_id: plan.vehicle_id,
          vin: plan.vin,
          main_route_id: plan.main_route_id,
          auxiliary_route_id: plan.auxiliary_route_id,
          start_time: cstTimeOfDay(plan.start_at),
          end_time: cstTimeOfDay(plan.end_at),
          speed_kph: plan.speed_kph,
          run_count: plan.run_count,
          recharge_power: plan.recharge_power
        },
        bootstrap.token,
        10000
      );
      let payload = {};
      try {
        payload = JSON.parse(response.text);
      } catch (_error) {
        throw new Error('任务发布服务返回了无效结果');
      }
      if (response.status < 200 || response.status >= 300 || payload.ok === false) {
        throw new Error(payload.error || `任务发布失败 (${response.status})`);
      }
      return payload;
    })
  });
  const stopVehicleTask = options.taskPlans?.stopVehicleTask || (async (vehicleId, vin) => {
    if (sidecar.disabled) throw new Error('任务停止服务未启动');
    const bootstrapResponse = await requestRemoteDriveSidecar(
      upstreamBase,
      'bootstrap',
      'GET',
      {},
      '',
      5000
    );
    let bootstrap = {};
    try {
      bootstrap = JSON.parse(bootstrapResponse.text);
    } catch (_error) {
      throw new Error('任务停止服务返回了无效认证信息');
    }
    if (bootstrapResponse.status < 200 || bootstrapResponse.status >= 300 || !bootstrap.token) {
      throw new Error(bootstrap.error || '任务停止服务尚未就绪');
    }
    const response = await requestRemoteDriveSidecar(
      upstreamBase,
      'task-stop',
      'POST',
      { vehicle_id: vehicleId, vin },
      bootstrap.token,
      20000
    );
    let payload = {};
    try {
      payload = JSON.parse(response.text);
    } catch (_error) {
      throw new Error('任务停止服务返回了无效结果');
    }
    if (response.status < 200 || response.status >= 300 || payload.ok === false) {
      const error = new Error(payload.error || `任务停止失败 (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return payload;
  });
  sidecar.taskPlanScheduler = taskPlanScheduler;

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
  app.get('/api/remote-drive/task-routes', permission, async (req, res) => {
    const vehicleId = String(req.query.vehicle_id || '').trim().toUpperCase();
    if (!TASK_PLAN_VINS[vehicleId]) {
      return res.status(400).json({ ok: false, error: '不支持该车辆的任务计划' });
    }
    if (typeof options.fetchRouteCatalog !== 'function') {
      return res.status(503).json({ ok: false, error: '路线目录服务未配置' });
    }
    try {
      const routes = normalizeRouteCatalog(await options.fetchRouteCatalog(vehicleId));
      return res.json({ ok: true, vehicle_id: vehicleId, routes });
    } catch (error) {
      return res.status(502).json({ ok: false, error: `路线目录读取失败: ${error.message}` });
    }
  });
  app.get('/api/remote-drive/task-plans', permission, (req, res) => {
    const vehicleId = String(req.query.vehicle_id || '').trim().toUpperCase();
    if (vehicleId && !TASK_PLAN_VINS[vehicleId]) {
      return res.status(400).json({ ok: false, error: '不支持该车辆的任务计划' });
    }
    return res.json({ ok: true, plans: taskPlanScheduler.list(vehicleId) });
  });
  app.post('/api/remote-drive/task-plans', permission, async (req, res) => {
    const vehicleId = String(req.body?.vehicle_id || '').trim().toUpperCase();
    if (!TASK_PLAN_VINS[vehicleId]) {
      return res.status(400).json({ ok: false, error: '不支持该车辆的任务计划' });
    }
    if (typeof options.fetchRouteCatalog !== 'function') {
      return res.status(503).json({ ok: false, error: '路线目录服务未配置' });
    }
    try {
      const routes = normalizeRouteCatalog(await options.fetchRouteCatalog(vehicleId));
      const byId = new Map(routes.map((route) => [route.route_id, route]));
      const mainRoute = byId.get(String(req.body?.main_route_id || '').trim());
      const auxiliaryRoute = byId.get(String(req.body?.auxiliary_route_id || '').trim());
      if (!mainRoute || !auxiliaryRoute) {
        return res.status(409).json({ ok: false, error: '所选路线不在车辆当前路线目录中，请刷新后重试' });
      }
      const plan = taskPlanScheduler.create({
        ...req.body,
        vehicle_id: vehicleId,
        main_route_name: mainRoute.name,
        auxiliary_route_name: auxiliaryRoute.name
      }, req.jgzjAuth?.user || {});
      await recordRemoteDriveAudit(options.operationAuditStore, req, 'task_plan_create', 201, {
        vehicle_id: vehicleId,
        plan_id: plan.id,
        start_at: plan.start_at,
        end_at: plan.end_at,
        main_route_id: plan.main_route_id,
        auxiliary_route_id: plan.auxiliary_route_id
      });
      return res.status(201).json({ ok: true, plan });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }
  });
  app.post('/api/remote-drive/task-plans/:planId/cancel', permission, async (req, res) => {
    try {
      const vehicleId = String(req.body?.vehicle_id || '').trim().toUpperCase();
      const plan = taskPlanScheduler.cancel(req.params.planId, vehicleId);
      await recordRemoteDriveAudit(options.operationAuditStore, req, 'task_plan_cancel', 200, {
        vehicle_id: plan.vehicle_id,
        plan_id: plan.id
      });
      return res.json({ ok: true, plan });
    } catch (error) {
      return res.status(409).json({ ok: false, error: error.message });
    }
  });
  app.post('/api/remote-drive/task-stop', permission, async (req, res) => {
    const vehicleId = String(req.body?.vehicle_id || '').trim().toUpperCase();
    const vin = TASK_PLAN_VINS[vehicleId];
    if (!vin) {
      return res.status(400).json({ ok: false, error: '不支持该车辆的任务停止' });
    }
    let stopBegun = false;
    const startedAt = Date.now();
    try {
      taskPlanScheduler.beginStop(vehicleId);
      stopBegun = true;
      const result = await stopVehicleTask(vehicleId, vin);
      const stoppedPlans = taskPlanScheduler.markStopped(vehicleId, result);
      await recordRemoteDriveAudit(options.operationAuditStore, req, 'task_plan_stop', 200, {
        vehicle_id: vehicleId,
        duration_ms: Date.now() - startedAt,
        business_ack: result.business_ack,
        response_code: result.response_code,
        speed_kph: result.vehicle_state?.speed_kph,
        stopped_plan_ids: stoppedPlans.map((plan) => plan.id)
      });
      return res.json({ ok: true, vehicle_id: vehicleId, result, stopped_plans: stoppedPlans });
    } catch (error) {
      const status = Number(error.status) || (stopBegun ? 502 : 409);
      await recordRemoteDriveAudit(options.operationAuditStore, req, 'task_plan_stop', status, {
        vehicle_id: vehicleId,
        duration_ms: Date.now() - startedAt,
        error: error.message
      });
      return res.status(status).json({ ok: false, error: error.message });
    } finally {
      if (stopBegun) taskPlanScheduler.endStop();
    }
  });
  app.delete('/api/remote-drive/task-plans/:planId', permission, async (req, res) => {
    try {
      const vehicleId = String(req.body?.vehicle_id || '').trim().toUpperCase();
      const plan = taskPlanScheduler.remove(req.params.planId, vehicleId);
      await recordRemoteDriveAudit(options.operationAuditStore, req, 'task_plan_delete', 200, {
        vehicle_id: plan.vehicle_id,
        plan_id: plan.id,
        previous_status: plan.previous_status
      });
      return res.json({ ok: true, deleted_plan: plan });
    } catch (error) {
      return res.status(409).json({ ok: false, error: error.message });
    }
  });
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
  TASK_PLAN_VINS,
  WEBRTC_TARGETS,
  TaskPlanScheduler,
  cstTimeOfDay,
  createRemoteDriveWebSocketGateway,
  normalizeWebRtcHttpStatus,
  normalizeRouteCatalog,
  requestRemoteDriveSidecar,
  registerRemoteDriveRoutes,
  startRemoteDriveSidecar
};
