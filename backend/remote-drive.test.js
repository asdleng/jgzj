const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CONTROL_ENDPOINTS,
  WEBRTC_TARGETS,
  normalizeWebRtcHttpStatus,
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
    'bootstrap', 'status', 'acquire', 'command', 'release', 'estop'
  ]));
  assert.equal(routes.length, 7);
  routes.forEach((route) => assert.equal(route.handlers[0], permissionMiddleware));
  assert.ok(routes.some((route) => route.method === 'GET' && route.path.endsWith('/bootstrap')));
  assert.ok(routes.some((route) => route.method === 'POST' && route.path.includes('/webrtc/:route/play')));
  assert.match(WEBRTC_TARGETS.edge, /^http:\/\//);
  assert.match(WEBRTC_TARGETS.origin, /^http:\/\//);
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
