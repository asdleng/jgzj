const http = require('http');

const DEFAULT_RECEIVER_BASE_URL = 'http://127.0.0.1:19083';
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const ALLOWED_ASSETS = new Set([
  'GlobalMap.retrieval_refresh_20260720.pcd',
  'keyframes.retrieval_refresh_20260720.tar.gz'
]);
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'expect',
  'host'
]);

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function copyRequestHeaders(req) {
  const headers = {};
  Object.entries(req.headers || {}).forEach(([name, value]) => {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase()) || value == null) return;
    headers[name] = Array.isArray(value) ? value.join(', ') : String(value);
  });
  return headers;
}

function copyResponseHeaders(upstreamResponse, res) {
  Object.entries(upstreamResponse.headers || {}).forEach(([name, value]) => {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase()) || value == null) return;
    res.setHeader(name, value);
  });
}

function validVehicleId(value) {
  return /^(?:BIT-\d{4}|FTUGV-\d{3})$/.test(String(value || ''));
}

function registerLidarMapUploadProxyRoutes(app, options = {}) {
  const receiverBaseUrl = new URL(
    process.env.LIDAR_MAP_UPLOAD_RECEIVER_BASE_URL ||
      options.receiverBaseUrl ||
      DEFAULT_RECEIVER_BASE_URL
  );
  const timeoutMs = parsePositiveInteger(
    process.env.LIDAR_MAP_UPLOAD_PROXY_TIMEOUT_MS,
    options.timeoutMs || DEFAULT_TIMEOUT_MS
  );

  app.all(
    '/api/auto_ad/lidar-map-upload/:vehicleId/:assetName/:action?',
    (req, res) => {
      const vehicleId = String(req.params.vehicleId || '');
      const assetName = String(req.params.assetName || '');
      const action = String(req.params.action || '');
      const isStatus = action === 'status';
      const isUpload = !action;

      if (!validVehicleId(vehicleId) || !ALLOWED_ASSETS.has(assetName)) {
        return res.status(400).json({ ok: false, error: 'invalid_lidar_map_upload_target' });
      }
      if ((!isStatus && !isUpload) || (isStatus && req.method !== 'GET')) {
        return res.status(405).json({ ok: false, error: 'method_not_allowed' });
      }
      if (isUpload && req.method !== 'POST' && req.method !== 'PUT') {
        return res.status(405).json({ ok: false, error: 'method_not_allowed' });
      }

      const upstreamPath = `/upload/${encodeURIComponent(vehicleId)}/${encodeURIComponent(
        assetName
      )}${isStatus ? '/status' : ''}`;
      const upstreamRequest = http.request(
        {
          protocol: receiverBaseUrl.protocol,
          hostname: receiverBaseUrl.hostname,
          port: receiverBaseUrl.port || 80,
          method: req.method,
          path: upstreamPath,
          headers: copyRequestHeaders(req)
        },
        (upstreamResponse) => {
          res.status(upstreamResponse.statusCode || 502);
          copyResponseHeaders(upstreamResponse, res);
          upstreamResponse.on('error', (error) => res.destroy(error));
          upstreamResponse.pipe(res);
        }
      );

      upstreamRequest.setTimeout(timeoutMs, () => {
        const error = new Error('lidar map upload receiver timeout');
        error.code = 'ETIMEDOUT';
        upstreamRequest.destroy(error);
      });
      upstreamRequest.on('error', (error) => {
        if (res.headersSent) {
          res.destroy(error);
          return;
        }
        res.status(error.code === 'ETIMEDOUT' ? 504 : 502).json({
          ok: false,
          error: error.code === 'ETIMEDOUT' ? 'receiver_timeout' : 'receiver_unavailable'
        });
      });
      req.on('aborted', () => upstreamRequest.destroy());
      req.pipe(upstreamRequest);
    }
  );
}

module.exports = {
  ALLOWED_ASSETS,
  registerLidarMapUploadProxyRoutes,
  validVehicleId
};
