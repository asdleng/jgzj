const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { WebSocket } = require('ws');

const {
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
} = require('./remote-drive');

test('remote drive registers only authenticated control and WebRTC routes', () => {
  const routes = [];
  const app = {
    get(path, ...handlers) {
      routes.push({ method: 'GET', path, handlers });
    },
    post(path, ...handlers) {
      routes.push({ method: 'POST', path, handlers });
    },
    delete(path, ...handlers) {
      routes.push({ method: 'DELETE', path, handlers });
    }
  };
  const permissionMiddleware = () => {};
  const requiredPermissions = [];
  const sidecar = registerRemoteDriveRoutes(app, {
    rootDir: process.cwd(),
    sidecar: { disabled: true },
    taskPlans: { disabled: true },
    requirePermission(permission) {
      requiredPermissions.push(permission);
      return permissionMiddleware;
    }
  });

  assert.equal(sidecar.disabled, true);
  assert.deepEqual(requiredPermissions, ['vehicle:control']);
  assert.deepEqual(CONTROL_ENDPOINTS, new Set([
    'bootstrap', 'status', 'acquire', 'command', 'heartbeat', 'release', 'estop'
  ]));
  assert.equal(routes.length, 14);
  routes.forEach((route) => assert.equal(route.handlers[0], permissionMiddleware));
  assert.ok(routes.some((route) => route.method === 'GET' && route.path.endsWith('/bootstrap')));
  assert.ok(routes.some((route) => route.method === 'POST' && route.path.endsWith('/heartbeat')));
  assert.ok(routes.some((route) => route.method === 'GET' && route.path.endsWith('/task-routes')));
  assert.ok(routes.some((route) => route.method === 'POST' && route.path.endsWith('/task-plans')));
  assert.ok(routes.some((route) => route.method === 'POST' && route.path.includes('/task-plans/:planId/cancel')));
  assert.ok(routes.some((route) => route.method === 'POST' && route.path.endsWith('/task-stop')));
  assert.ok(routes.some((route) => route.method === 'DELETE' && route.path.endsWith('/task-plans/:planId')));
  assert.ok(routes.some((route) => route.method === 'POST' && route.path.includes('/webrtc/:route/play')));
  assert.match(WEBRTC_TARGETS.edge, /^http:\/\//);
  assert.match(WEBRTC_TARGETS.origin, /^http:\/\//);
});

test('remote drive WebSocket carries control messages on a persistent channel', async () => {
  const sidecarRequests = [];
  const sidecarServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      sidecarRequests.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, session_active: true }));
    });
  });
  await new Promise((resolve) => sidecarServer.listen(0, '127.0.0.1', resolve));
  const sidecarAddress = sidecarServer.address();
  const gateway = createRemoteDriveWebSocketGateway({
    upstreamBase: `http://127.0.0.1:${sidecarAddress.port}`
  });
  const publicServer = http.createServer();
  publicServer.on('upgrade', (req, socket, head) => gateway.handleUpgrade(req, socket, head));
  await new Promise((resolve) => publicServer.listen(0, '127.0.0.1', resolve));
  const publicAddress = publicServer.address();
  const websocket = new WebSocket(`ws://127.0.0.1:${publicAddress.port}/ws/remote-drive`);
  await new Promise((resolve, reject) => {
    websocket.once('open', resolve);
    websocket.once('error', reject);
  });
  const response = new Promise((resolve, reject) => {
    websocket.once('message', (raw) => resolve(JSON.parse(raw.toString('utf8'))));
    websocket.once('error', reject);
  });
  websocket.send(JSON.stringify({
    id: 'request-1',
    endpoint: 'heartbeat',
    token: 'token-1',
    payload: { session_id: 'session-1' }
  }));
  assert.deepEqual(await response, {
    id: 'request-1',
    ok: true,
    status: 200,
    payload: { ok: true, session_active: true },
    error: null
  });
  assert.deepEqual(sidecarRequests, [{
    url: '/api/control/heartbeat',
    body: { session_id: 'session-1' }
  }]);
  const released = new Promise((resolve, reject) => {
    websocket.once('message', (raw) => resolve(JSON.parse(raw.toString('utf8'))));
    websocket.once('error', reject);
  });
  websocket.send(JSON.stringify({
    id: 'request-2',
    endpoint: 'release',
    token: 'token-1',
    payload: { session_id: 'session-1' }
  }));
  assert.equal((await released).ok, true);
  websocket.close();
  await new Promise((resolve) => websocket.once('close', resolve));
  gateway.close();
  await new Promise((resolve) => publicServer.close(resolve));
  await new Promise((resolve) => sidecarServer.close(resolve));
});

test('sidecar control requests use an isolated loopback HTTP connection', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        token: req.headers['x-control-token'],
        body: Buffer.concat(chunks).toString('utf8')
      });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const response = await requestRemoteDriveSidecar(
      `http://127.0.0.1:${address.port}`,
      'heartbeat',
      'POST',
      { session_id: 'session-1' },
      'token-1',
      1000
    );
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.text), { ok: true });
    assert.deepEqual(requests, [{
      method: 'POST',
      url: '/api/control/heartbeat',
      token: 'token-1',
      body: JSON.stringify({ session_id: 'session-1' })
    }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('remote drive sidecar can be explicitly disabled for tests', () => {
  assert.deepEqual(startRemoteDriveSidecar(process.cwd(), { disabled: true }), {
    child: null,
    ready: false,
    disabled: true
  });
});

test('inactive SRS streams remain a business response instead of a browser HTTP error', () => {
  assert.equal(
    normalizeWebRtcHttpStatus(404, JSON.stringify({ code: 404, msg: 'stream not active: live/car/1' })),
    200
  );
  assert.equal(normalizeWebRtcHttpStatus(404, JSON.stringify({ code: 404, msg: 'route missing' })), 404);
  assert.equal(normalizeWebRtcHttpStatus(502, JSON.stringify({ code: 502, msg: 'upstream failed' })), 502);
});

test('task plan scheduler persists and dispatches a due 0x0A08 plan only once', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jgzj-task-plan-'));
  const storePath = path.join(directory, 'task-plans.json');
  let now = Date.parse('2026-07-25T08:00:00.000Z');
  const published = [];
  const scheduler = new TaskPlanScheduler({
    start: false,
    now: () => now,
    storePath,
    publishPlan: async (plan) => {
      published.push(plan.id);
      return { ok: true, message_id: '0x0A08', broker_echo: true };
    }
  });
  try {
    const plan = scheduler.create({
      vehicle_id: 'BIT-0041',
      main_route_id: 'route_main',
      auxiliary_route_id: 'route_charge',
      start_at: '2026-07-25T08:05:00.000Z',
      end_at: '2026-07-25T10:00:00.000Z',
      speed_kph: 2,
      run_count: 55,
      recharge_power: 30
    }, { username: 'tester' });
    assert.equal(plan.vin, TASK_PLAN_VINS['BIT-0041']);
    await scheduler.tick();
    assert.deepEqual(published, []);
    now = Date.parse('2026-07-25T08:05:01.000Z');
    await scheduler.tick();
    await scheduler.tick();
    assert.deepEqual(published, [plan.id]);
    assert.equal(scheduler.list('BIT-0041')[0].status, 'delivered');
    assert.equal(scheduler.list('BIT-0041')[0].delivery.broker_echo, true);
    const reloaded = new TaskPlanScheduler({ start: false, now: () => now, storePath });
    assert.equal(reloaded.list('BIT-0041')[0].status, 'delivered');
    reloaded.close();
  } finally {
    scheduler.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('task plan scheduler does not auto-repeat an uncertain dispatch', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jgzj-task-plan-'));
  const storePath = path.join(directory, 'task-plans.json');
  fs.writeFileSync(storePath, JSON.stringify({
    version: 1,
    plans: [{
      id: 'uncertain-plan',
      vehicle_id: 'BIT-0041',
      status: 'dispatching',
      start_at: '2026-07-25T08:00:00.000Z',
      end_at: '2026-07-25T10:00:00.000Z',
      created_at: '2026-07-25T07:00:00.000Z'
    }]
  }));
  try {
    const scheduler = new TaskPlanScheduler({
      start: false,
      now: () => Date.parse('2026-07-25T08:01:00.000Z'),
      storePath
    });
    assert.equal(scheduler.list()[0].status, 'delivery_unknown');
    assert.match(scheduler.list()[0].error, /未自动重发/);
    scheduler.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('task plan scheduler stops active plans and removes non-dispatching records', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jgzj-task-plan-'));
  const storePath = path.join(directory, 'task-plans.json');
  let now = Date.parse('2026-07-27T10:55:00.000Z');
  fs.writeFileSync(storePath, JSON.stringify({
    version: 1,
    plans: [
      {
        id: 'delivered-plan',
        vehicle_id: 'BIT-0041',
        status: 'delivered',
        start_at: '2026-07-27T10:15:00.000Z',
        end_at: '2026-07-27T12:19:00.000Z',
        created_at: '2026-07-27T10:14:00.000Z'
      },
      {
        id: 'due-plan',
        vehicle_id: 'BIT-0041',
        status: 'scheduled',
        start_at: '2026-07-27T10:54:00.000Z',
        end_at: '2026-07-27T12:19:00.000Z',
        created_at: '2026-07-27T10:53:00.000Z'
      },
      {
        id: 'future-plan',
        vehicle_id: 'BIT-0041',
        status: 'scheduled',
        start_at: '2026-07-28T10:00:00.000Z',
        end_at: '2026-07-28T12:00:00.000Z',
        created_at: '2026-07-27T10:52:00.000Z'
      }
    ]
  }));
  try {
    const scheduler = new TaskPlanScheduler({ start: false, now: () => now, storePath });
    scheduler.beginStop('BIT-0041');
    const stopped = scheduler.markStopped('BIT-0041', { business_ack: true, speed_zero: true });
    scheduler.endStop();
    assert.deepEqual(stopped.map((plan) => plan.id).sort(), ['delivered-plan', 'due-plan']);
    assert.equal(scheduler.list('BIT-0041').find((plan) => plan.id === 'future-plan').status, 'scheduled');
    const deleted = scheduler.remove('delivered-plan', 'BIT-0041');
    assert.equal(deleted.previous_status, 'stopped');
    assert.ok(!scheduler.list('BIT-0041').some((plan) => plan.id === 'delivered-plan'));
    now += 1000;
    scheduler.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('task route helpers normalize names and use Asia/Shanghai time', () => {
  assert.equal(cstTimeOfDay('2026-07-25T08:05:06.000Z'), '16:05:06');
  assert.deepEqual(normalizeRouteCatalog([
    { route_id: 'route_a', names: ['A 线'] },
    { route_id: 'route_a', names: ['重复'] },
    { route_id: 'route_b', name: 'B 线' }
  ]), [
    { route_id: 'route_a', name: 'A 线' },
    { route_id: 'route_b', name: 'B 线' }
  ]);
});
