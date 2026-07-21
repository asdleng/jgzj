const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { WebSocket } = require('ws');

const {
  CONTROL_ENDPOINTS,
  WEBRTC_TARGETS,
  createRemoteDriveWebSocketGateway,
  normalizeWebRtcHttpStatus,
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
    }
  };
  const permissionMiddleware = () => {};
  const requiredPermissions = [];
  const sidecar = registerRemoteDriveRoutes(app, {
    rootDir: process.cwd(),
    sidecar: { disabled: true },
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
  assert.equal(routes.length, 8);
  routes.forEach((route) => assert.equal(route.handlers[0], permissionMiddleware));
  assert.ok(routes.some((route) => route.method === 'GET' && route.path.endsWith('/bootstrap')));
  assert.ok(routes.some((route) => route.method === 'POST' && route.path.endsWith('/heartbeat')));
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
