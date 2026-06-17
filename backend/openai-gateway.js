const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const DEFAULT_UPSTREAM_BASE_URL = 'https://api.openai.com';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_BODY_BYTES = 25 * 1024 * 1024;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 120;

function parseBoolean(value, fallback = false) {
  if (value == null || value === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parsePositiveInteger(value, fallback) {
  const number = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function parseList(value) {
  if (!value) {
    return [];
  }

  const source = String(value).trim();
  if (!source) {
    return [];
  }

  if (source.startsWith('[')) {
    try {
      const parsed = JSON.parse(source);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item || '').trim()).filter(Boolean);
      }
    } catch (_error) {
      return [];
    }
  }

  return source
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseNamedKeys(value) {
  const keys = [];
  if (!value) {
    return keys;
  }

  const source = String(value).trim();
  if (!source) {
    return keys;
  }

  if (source.startsWith('{') || source.startsWith('[')) {
    try {
      const parsed = JSON.parse(source);
      if (Array.isArray(parsed)) {
        parsed.forEach((item, index) => {
          if (typeof item === 'string') {
            keys.push({ name: `key-${index + 1}`, value: item });
            return;
          }
          if (item && typeof item === 'object') {
            keys.push({
              name: String(item.name || item.id || `key-${index + 1}`),
              value: String(item.key || item.value || '')
            });
          }
        });
      } else if (parsed && typeof parsed === 'object') {
        Object.entries(parsed).forEach(([name, key]) => {
          keys.push({ name, value: String(key || '') });
        });
      }
      return keys.filter((item) => item.value);
    } catch (_error) {
      return [];
    }
  }

  parseList(source).forEach((item, index) => {
    const separator = item.indexOf(':');
    if (separator > 0) {
      keys.push({
        name: item.slice(0, separator).trim() || `key-${index + 1}`,
        value: item.slice(separator + 1).trim()
      });
      return;
    }
    keys.push({ name: `key-${index + 1}`, value: item });
  });
  return keys.filter((item) => item.value);
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function timingSafeEqualHex(left, right) {
  const a = Buffer.from(String(left || ''), 'hex');
  const b = Buffer.from(String(right || ''), 'hex');
  if (a.length !== b.length || a.length === 0) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function normalizeHeaderValue(value) {
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  return String(value ?? '');
}

function loadConfig(rootDir) {
  const allowedKeyHashes = new Map();
  parseNamedKeys(process.env.OPENAI_GATEWAY_SUBKEYS).forEach((item) => {
    const hash = sha256Hex(item.value);
    allowedKeyHashes.set(hash, {
      name: item.name,
      hash,
      key_preview: `${hash.slice(0, 10)}...`
    });
  });

  parseNamedKeys(process.env.OPENAI_GATEWAY_SUBKEY_HASHES).forEach((item) => {
    const hash = String(item.value || '').trim().toLowerCase();
    if (/^[a-f0-9]{64}$/.test(hash)) {
      allowedKeyHashes.set(hash, {
        name: item.name,
        hash,
        key_preview: `${hash.slice(0, 10)}...`
      });
    }
  });

  const corsOrigins = parseList(process.env.OPENAI_GATEWAY_CORS_ORIGINS);
  return {
    enabled: parseBoolean(process.env.OPENAI_GATEWAY_ENABLED, false),
    upstreamBaseUrl: process.env.OPENAI_GATEWAY_UPSTREAM_BASE_URL || DEFAULT_UPSTREAM_BASE_URL,
    upstreamApiKey: process.env.OPENAI_GATEWAY_UPSTREAM_API_KEY || '',
    upstreamOrganization: process.env.OPENAI_GATEWAY_UPSTREAM_ORGANIZATION || '',
    upstreamProject: process.env.OPENAI_GATEWAY_UPSTREAM_PROJECT || '',
    timeoutMs: parsePositiveInteger(process.env.OPENAI_GATEWAY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxBodyBytes: parsePositiveInteger(process.env.OPENAI_GATEWAY_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES),
    rateLimitPerMinute: parsePositiveInteger(
      process.env.OPENAI_GATEWAY_RATE_LIMIT_PER_MINUTE,
      DEFAULT_RATE_LIMIT_PER_MINUTE
    ),
    logPath: path.resolve(
      rootDir,
      process.env.OPENAI_GATEWAY_LOG_PATH || '.runtime/openai-gateway-requests.jsonl'
    ),
    corsOrigins,
    allowedKeyHashes
  };
}

function makeOpenAiError(message, type = 'invalid_request_error', code = null) {
  return {
    error: {
      message,
      type,
      param: null,
      code
    }
  };
}

function sendOpenAiError(res, status, message, type, code) {
  return res.status(status).json(makeOpenAiError(message, type, code));
}

function getBearerToken(req) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function getCorsOrigin(req, config) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin || !config.corsOrigins.length) {
    return '';
  }
  if (config.corsOrigins.includes('*')) {
    return '*';
  }
  return config.corsOrigins.includes(origin) ? origin : '';
}

function applyCors(req, res, config) {
  const corsOrigin = getCorsOrigin(req, config);
  if (!corsOrigin) {
    return;
  }
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS,DELETE,PATCH');
  res.setHeader(
    'Access-Control-Allow-Headers',
    req.headers['access-control-request-headers'] ||
      'Authorization,Content-Type,OpenAI-Beta,OpenAI-Organization,OpenAI-Project'
  );
  res.setHeader('Access-Control-Max-Age', '600');
}

function createRateLimiter(config) {
  const buckets = new Map();
  return function checkRateLimit(keyHash) {
    const now = Date.now();
    const windowStart = now - 60 * 1000;
    const bucket = (buckets.get(keyHash) || []).filter((timestamp) => timestamp > windowStart);
    if (bucket.length >= config.rateLimitPerMinute) {
      buckets.set(keyHash, bucket);
      return {
        ok: false,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket[0] + 60 * 1000 - now) / 1000))
      };
    }
    bucket.push(now);
    buckets.set(keyHash, bucket);
    return { ok: true, remaining: Math.max(0, config.rateLimitPerMinute - bucket.length) };
  };
}

function authenticate(req, config) {
  const token = getBearerToken(req);
  if (!token) {
    return { ok: false, status: 401, message: 'Missing bearer token.', code: 'missing_api_key' };
  }

  const hash = sha256Hex(token);
  for (const [allowedHash, meta] of config.allowedKeyHashes.entries()) {
    if (timingSafeEqualHex(hash, allowedHash)) {
      return { ok: true, key: meta };
    }
  }

  return { ok: false, status: 401, message: 'Invalid bearer token.', code: 'invalid_api_key' };
}

function buildUpstreamUrl(req, config) {
  const originalUrl = req.originalUrl || req.url || '/v1';
  return new URL(originalUrl, config.upstreamBaseUrl).toString();
}

function shouldSkipRequestHeader(name) {
  return new Set([
    'authorization',
    'connection',
    'content-length',
    'host',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade'
  ]).has(String(name || '').toLowerCase());
}

function buildUpstreamHeaders(req, config) {
  const headers = {};
  Object.entries(req.headers || {}).forEach(([name, value]) => {
    if (!shouldSkipRequestHeader(name)) {
      headers[name] = normalizeHeaderValue(value);
    }
  });

  headers.authorization = `Bearer ${config.upstreamApiKey}`;
  if (config.upstreamOrganization) {
    headers['openai-organization'] = config.upstreamOrganization;
  }
  if (config.upstreamProject) {
    headers['openai-project'] = config.upstreamProject;
  }
  if (!headers['user-agent']) {
    headers['user-agent'] = 'jgzj-openai-gateway/1.0';
  }
  return headers;
}

function buildUpstreamBody(req, headers, config) {
  if (req.method === 'GET' || req.method === 'HEAD') {
    return { body: undefined, duplex: undefined };
  }

  if (req.body !== undefined && req.body !== null) {
    const body = Buffer.from(JSON.stringify(req.body));
    if (body.length > config.maxBodyBytes) {
      const error = new Error('Request body too large.');
      error.status = 413;
      throw error;
    }
    headers['content-type'] = headers['content-type'] || 'application/json';
    headers['content-length'] = String(body.length);
    return { body, duplex: undefined };
  }

  const contentLength = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(contentLength) && contentLength > config.maxBodyBytes) {
    const error = new Error('Request body too large.');
    error.status = 413;
    throw error;
  }

  return { body: req, duplex: 'half' };
}

function shouldSkipResponseHeader(name) {
  return new Set([
    'connection',
    'content-encoding',
    'content-length',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade'
  ]).has(String(name || '').toLowerCase());
}

function copyResponseHeaders(upstreamResponse, res) {
  upstreamResponse.headers.forEach((value, name) => {
    if (!shouldSkipResponseHeader(name)) {
      res.setHeader(name, value);
    }
  });
}

async function appendRequestLog(config, record) {
  try {
    await fs.mkdir(path.dirname(config.logPath), { recursive: true });
    await fs.appendFile(config.logPath, `${JSON.stringify(record)}\n`);
  } catch (error) {
    console.info('openai_gateway_log_failed', JSON.stringify({ error: error.message }));
  }
}

function registerOpenAiGatewayRoutes(app, options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const config = loadConfig(rootDir);
  const checkRateLimit = createRateLimiter(config);

  app.get('/api/openai-gateway/status', options.statusAuthMiddleware || ((_req, _res, next) => next()), (_req, res) => {
    res.json({
      ok: true,
      enabled: config.enabled,
      configured: Boolean(config.upstreamApiKey && config.allowedKeyHashes.size),
      upstream_base_url: config.upstreamBaseUrl,
      subkey_count: config.allowedKeyHashes.size,
      timeout_ms: config.timeoutMs,
      max_body_bytes: config.maxBodyBytes,
      rate_limit_per_minute: config.rateLimitPerMinute
    });
  });

  app.options(['/v1', '/v1/*'], (req, res) => {
    applyCors(req, res, config);
    res.status(204).end();
  });

  app.all(['/v1', '/v1/*'], async (req, res) => {
    applyCors(req, res, config);

    const startedAt = Date.now();
    const requestId = crypto.randomUUID();
    res.setHeader('X-JGZJ-Gateway-Request-Id', requestId);

    if (!config.enabled) {
      return sendOpenAiError(res, 404, 'OpenAI gateway is disabled.', 'invalid_request_error', 'gateway_disabled');
    }

    if (!config.upstreamApiKey || !config.allowedKeyHashes.size) {
      return sendOpenAiError(
        res,
        503,
        'OpenAI gateway is not configured.',
        'server_error',
        'gateway_not_configured'
      );
    }

    const auth = authenticate(req, config);
    if (!auth.ok) {
      return sendOpenAiError(res, auth.status, auth.message, 'invalid_request_error', auth.code);
    }

    const rateLimit = checkRateLimit(auth.key.hash);
    if (!rateLimit.ok) {
      res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
      return sendOpenAiError(
        res,
        429,
        'Rate limit exceeded for this gateway key.',
        'rate_limit_error',
        'gateway_rate_limit_exceeded'
      );
    }

    let upstreamResponse;
    try {
      const upstreamUrl = buildUpstreamUrl(req, config);
      const headers = buildUpstreamHeaders(req, config);
      const { body, duplex } = buildUpstreamBody(req, headers, config);
      upstreamResponse = await fetch(upstreamUrl, {
        method: req.method,
        headers,
        body,
        duplex,
        signal: AbortSignal.timeout(config.timeoutMs)
      });

      res.status(upstreamResponse.status);
      copyResponseHeaders(upstreamResponse, res);
      applyCors(req, res, config);

      if (!upstreamResponse.body) {
        res.end();
      } else {
        await pipeline(Readable.fromWeb(upstreamResponse.body), res);
      }

      await appendRequestLog(config, {
        ts: new Date().toISOString(),
        request_id: requestId,
        key_name: auth.key.name,
        key_preview: auth.key.key_preview,
        method: req.method,
        path: req.originalUrl || req.url,
        status: upstreamResponse.status,
        duration_ms: Date.now() - startedAt,
        upstream: config.upstreamBaseUrl
      });
    } catch (error) {
      const status = error.status || (error.name === 'TimeoutError' ? 504 : 502);
      if (!res.headersSent) {
        sendOpenAiError(
          res,
          status,
          error.message || 'Gateway upstream request failed.',
          status === 413 ? 'invalid_request_error' : 'server_error',
          status === 413 ? 'request_too_large' : 'gateway_upstream_failed'
        );
      } else {
        res.end();
      }

      await appendRequestLog(config, {
        ts: new Date().toISOString(),
        request_id: requestId,
        key_name: auth?.key?.name || null,
        method: req.method,
        path: req.originalUrl || req.url,
        status,
        duration_ms: Date.now() - startedAt,
        error: String(error.message || error)
      });
    }
  });
}

module.exports = registerOpenAiGatewayRoutes;
