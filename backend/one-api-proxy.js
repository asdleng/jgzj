const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
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
  'host',
  'content-length'
]);
const RESPONSE_HEADERS_TO_SKIP = new Set([
  ...HOP_BY_HOP_HEADERS,
  'content-encoding',
  'content-length'
]);

function normalizeBaseUrl(value) {
  const source = String(value || DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL;
  return source.replace(/\/+$/, '');
}

function parsePositiveInteger(value, fallback) {
  const number = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function appendForwardedFor(existing, address) {
  const remoteAddress = String(address || '').trim();
  if (!remoteAddress) {
    return existing || '';
  }
  return existing ? `${existing}, ${remoteAddress}` : remoteAddress;
}

function copyRequestHeaders(req, body) {
  const headers = {};
  Object.entries(req.headers || {}).forEach(([name, value]) => {
    const lowerName = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lowerName) || lowerName === 'accept-encoding') {
      return;
    }
    headers[name] = Array.isArray(value) ? value.join(', ') : String(value);
  });

  headers['accept-encoding'] = 'identity';
  headers['x-forwarded-host'] = String(req.headers.host || '');
  headers['x-forwarded-proto'] = req.protocol || 'http';
  headers['x-forwarded-for'] = appendForwardedFor(
    String(req.headers['x-forwarded-for'] || ''),
    req.ip || req.socket?.remoteAddress
  );

  if (body != null && !headers['content-type'] && !headers['Content-Type']) {
    headers['content-type'] = 'application/json';
  }

  return headers;
}

function makeTargetUrl(baseUrl, req) {
  return `${baseUrl}${req.originalUrl || req.url || '/'}`;
}

function makeProxyBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') {
    return undefined;
  }

  if (req.body != null) {
    if (Buffer.isBuffer(req.body) || typeof req.body === 'string') {
      return req.body;
    }
    return JSON.stringify(req.body);
  }

  // The /v1 proxy is registered before JSON parsing so large and chunked
  // request bodies can pass through without being buffered by Express.
  return req;
}

function writeResponseHeaders(res, upstreamResponse) {
  upstreamResponse.headers.forEach((value, name) => {
    const lowerName = name.toLowerCase();
    if (!RESPONSE_HEADERS_TO_SKIP.has(lowerName)) {
      res.setHeader(name, value);
    }
  });
}

function registerOneApiProxyRoutes(app, options = {}) {
  const baseUrl = normalizeBaseUrl(process.env.ONE_API_BASE_URL || options.baseUrl);
  const timeoutMs = parsePositiveInteger(
    process.env.ONE_API_PROXY_TIMEOUT_MS,
    options.timeoutMs || DEFAULT_TIMEOUT_MS
  );
  const statusAuthMiddleware =
    options.statusAuthMiddleware || ((_req, _res, next) => next());

  app.get('/api/one-api-proxy/status', statusAuthMiddleware, (_req, res) => {
    res.json({
      ok: true,
      upstream_base_url: baseUrl,
      public_v1_path: '/v1'
    });
  });

  app.use('/v1', async (req, res) => {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);
    let upstreamResponse;

    try {
      const body = makeProxyBody(req);
      const requestOptions = {
        method: req.method,
        headers: copyRequestHeaders(req, body),
        body,
        signal: abortController.signal
      };
      if (body === req) {
        requestOptions.duplex = 'half';
      }

      upstreamResponse = await fetch(makeTargetUrl(baseUrl, req), requestOptions);

      res.status(upstreamResponse.status);
      writeResponseHeaders(res, upstreamResponse);

      if (!upstreamResponse.body) {
        return res.end();
      }

      return await pipeline(Readable.fromWeb(upstreamResponse.body), res);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }

      const isAbort = error?.name === 'AbortError';
      return res.status(isAbort ? 504 : 502).json({
        error: {
          message: isAbort ? 'One-API upstream timeout' : 'One-API upstream unavailable',
          type: 'one_api_proxy_error',
          param: null,
          code: isAbort ? 'one_api_timeout' : 'one_api_unavailable'
        }
      });
    } finally {
      clearTimeout(timeout);
    }
  });
}

module.exports = registerOneApiProxyRoutes;
