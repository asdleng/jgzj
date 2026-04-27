const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { execFile } = require('child_process');
const { promisify } = require('util');
const express = require('express');
const registerCloudMappingRoutes = require('./cloud-mapping');
const registerRuntimeControlRoutes = require('./runtime-control');

const execFileAsync = promisify(execFile);
const app = express();
const port = Number(process.env.PORT || 3000);
const webRoot = path.resolve(__dirname, '../dist');
const vehicleRagDir = path.resolve(
  process.env.VEHICLE_RAG_DIR || '/home/admin1/CloudVoice/multi_car_asr_demo/vehicle_rag'
);
const aiCheckArchiveRoot = path.resolve(
  process.env.AI_CHECK_ARCHIVE_ROOT || '/home/admin1/qwen-vl-infer/data/qwen_ws_checker_archive'
);
const aiCheckArchiveDbPath = path.join(
  aiCheckArchiveRoot,
  process.env.AI_CHECK_ARCHIVE_DB_NAME || 'qwen_ws_checker.sqlite3'
);
const aiCheckArchiveDbUri = `file:${aiCheckArchiveDbPath}?mode=ro&immutable=1`;
const defaultVehicleId = process.env.DEFAULT_VEHICLE_ID || 'car-web';
const upstreamBaseUrl = process.env.UPSTREAM_CHAT_BASE_URL || 'http://127.0.0.1:8050';
const upstreamStreamUrl = new URL(
  process.env.UPSTREAM_CHAT_STREAM_PATH || '/chat/stream',
  upstreamBaseUrl
).toString();
const upstreamHealthUrl = new URL(
  process.env.UPSTREAM_CHAT_HEALTH_PATH || '/healthz',
  upstreamBaseUrl
).toString();
const requestTimeoutMs = Number(process.env.CHAT_PROXY_TIMEOUT_MS || 120000);
const qwen36BaseUrl = process.env.QWEN36_BASE_URL || 'http://127.0.0.1:18000/v1';
const qwen36BaseUrlWithSlash = qwen36BaseUrl.endsWith('/') ? qwen36BaseUrl : `${qwen36BaseUrl}/`;
const qwen36ChatUrl = new URL('chat/completions', qwen36BaseUrlWithSlash).toString();
const qwen36ModelsUrl = new URL('models', qwen36BaseUrlWithSlash).toString();
const qwen36Model = process.env.QWEN36_MODEL || 'Qwen3.6-27B';
const qwen36TimeoutMs = Number(process.env.QWEN36_TIMEOUT_MS || 300000);
const qwen36MmBaseUrl = process.env.QWEN36_MM_BASE_URL || 'http://127.0.0.1:18001/v1';
const qwen36MmBaseUrlWithSlash = qwen36MmBaseUrl.endsWith('/') ? qwen36MmBaseUrl : `${qwen36MmBaseUrl}/`;
const qwen36MmChatUrl = new URL('chat/completions', qwen36MmBaseUrlWithSlash).toString();
const qwen36MmModel = process.env.QWEN36_MM_MODEL || 'Qwen3.6-27B-MM';
const qwen36MmTimeoutMs = Number(process.env.QWEN36_MM_TIMEOUT_MS || 120000);
const openClawConfigPath = path.resolve(
  process.env.OPENCLAW_CONFIG_PATH || '/home/admin1/.openclaw/openclaw.json'
);
const openClawGatewaySdkUrl = pathToFileURL(
  path.resolve(
    process.env.OPENCLAW_GATEWAY_SDK_PATH ||
      '/home/admin1/.openclaw/lib/node_modules/openclaw/dist/method-scopes-DhuXuLfv.js'
  )
).href;
const openClawGatewayHost = process.env.OPENCLAW_GATEWAY_HOST || '127.0.0.1';
const openClawAgentId = process.env.OPENCLAW_AGENT_ID || 'main';
const openClawConnectTimeoutMs = Number(process.env.OPENCLAW_CONNECT_TIMEOUT_MS || 15000);
const openClawTimeoutMs = Number(process.env.OPENCLAW_TIMEOUT_MS || 180000);
const openClawAuthCookieName = process.env.OPENCLAW_AUTH_COOKIE_NAME || 'jgzj_openclaw_auth';
const defaultOpenClawAuthAccounts = new Map([
  ['asdleng', 'Asd174524'],
  ['jgauto402', 'jgauto402']
]);
if (process.env.OPENCLAW_AUTH_USERNAME && process.env.OPENCLAW_AUTH_PASSWORD) {
  defaultOpenClawAuthAccounts.set(
    process.env.OPENCLAW_AUTH_USERNAME.trim(),
    process.env.OPENCLAW_AUTH_PASSWORD
  );
}
if (process.env.OPENCLAW_AUTH_USERS) {
  try {
    const parsedAccounts = JSON.parse(process.env.OPENCLAW_AUTH_USERS);
    if (parsedAccounts && typeof parsedAccounts === 'object' && !Array.isArray(parsedAccounts)) {
      Object.entries(parsedAccounts).forEach(([username, password]) => {
        const normalizedUsername = String(username || '').trim();
        if (normalizedUsername) {
          defaultOpenClawAuthAccounts.set(normalizedUsername, String(password || ''));
        }
      });
    }
  } catch (_error) {
    // Ignore malformed optional multi-user env config and fall back to defaults.
  }
}
const openClawAuthAccounts = defaultOpenClawAuthAccounts;
const openClawAuthSecret =
  process.env.OPENCLAW_AUTH_SECRET || 'jgzj-openclaw-auth-secret-v1';
const openClawAuthTtlMs = Number(
  process.env.OPENCLAW_AUTH_TTL_MS || 7 * 24 * 60 * 60 * 1000
);
const cloudAgentBaseUrl = process.env.CLOUD_AGENT_BASE_URL || 'http://127.0.0.1:8000';
const cloudAgentTimeoutMs = Number(process.env.CLOUD_AGENT_TIMEOUT_MS || 25000);
const cloudAgentPlanSessionSuffix = process.env.CLOUD_AGENT_PLAN_SESSION_SUFFIX || 'ops-plan';
const cloudAgentAnswerSessionSuffix =
  process.env.CLOUD_AGENT_ANSWER_SESSION_SUFFIX || 'ops-answer';
const cloudOpsRouteCatalogCacheTtlMs = Number(
  process.env.CLOUD_OPS_ROUTE_CATALOG_CACHE_TTL_MS || 15000
);
const cloudOpsRouteCatalogCache = new Map();

app.disable('x-powered-by');
app.use(express.json({ limit: '16mb' }));

function normalizeReply(text) {
  return String(text || '')
    .replace(/<\|im_end\|>/g, '')
    .trim();
}

function truncateText(text, limit = 12000) {
  const value = String(text || '');
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}\n...[truncated]`;
}

function safeJsonStringify(value, limit = 12000) {
  try {
    return truncateText(JSON.stringify(value, null, 2), limit);
  } catch (_error) {
    return truncateText(String(value || ''), limit);
  }
}

function parseSseBlock(block) {
  const payload = block
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6).trim())
    .join('\n');

  if (!payload) {
    return null;
  }

  try {
    return JSON.parse(payload);
  } catch (_error) {
    return null;
  }
}

function createUpstreamPayload(message, sessionId, options = {}) {
  const reset = Boolean(options.reset);
  const vehicleId =
    typeof options.vehicle_id === 'string' && options.vehicle_id.trim()
      ? options.vehicle_id.trim()
      : defaultVehicleId;
  return {
    session_id: sessionId,
    text: message,
    vehicle_id: vehicleId,
    reset,
    do_sample: false,
    temperature: 0,
    top_p: 0.9,
    enable_thinking: Boolean(options.enable_thinking)
  };
}

async function listVehicleIdentities() {
  const entries = await fs.readdir(vehicleRagDir, { withFileTypes: true });
  const identities = entries
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.txt')
    .map((entry) => path.parse(entry.name).name)
    .filter(Boolean);

  const unique = [...new Set(identities)];
  unique.sort((left, right) => {
    if (left === defaultVehicleId) return -1;
    if (right === defaultVehicleId) return 1;
    return left.localeCompare(right, 'zh-CN');
  });

  if (!unique.includes(defaultVehicleId)) {
    unique.unshift(defaultVehicleId);
  }

  return unique;
}

function writeSseEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function toFiniteInteger(value, fallback, options = {}) {
  const num = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(num)) {
    return fallback;
  }

  const min = Number.isFinite(options.min) ? options.min : num;
  const max = Number.isFinite(options.max) ? options.max : num;
  return Math.min(max, Math.max(min, num));
}

function parseJsonField(value, fallback = null) {
  if (typeof value !== 'string' || !value.trim()) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function extractJsonObject(text) {
  const source = normalizeReply(text)
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  if (!source) {
    return null;
  }

  try {
    return JSON.parse(source);
  } catch (_error) {
    // Ignore and continue with object extraction.
  }

  const start = source.indexOf('{');
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const candidate = source.slice(start, index + 1);
        try {
          return JSON.parse(candidate);
        } catch (_parseError) {
          return null;
        }
      }
    }
  }

  return null;
}

function toSqlTextLiteral(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
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

function createOpenClawAuthSignature(username, expiresAt) {
  return crypto
    .createHmac('sha256', openClawAuthSecret)
    .update(`${username}.${expiresAt}`)
    .digest('base64url');
}

function issueOpenClawAuthToken(username) {
  const expiresAt = Date.now() + openClawAuthTtlMs;
  const signature = createOpenClawAuthSignature(username, expiresAt);
  return `${username}.${expiresAt}.${signature}`;
}

function isOpenClawAuthUsernameAllowed(username) {
  return openClawAuthAccounts.has(String(username || '').trim());
}

function isOpenClawLoginValid(username, password) {
  const normalizedUsername = String(username || '').trim();
  if (!normalizedUsername || !isOpenClawAuthUsernameAllowed(normalizedUsername)) {
    return false;
  }
  return timingSafeEqualText(password, openClawAuthAccounts.get(normalizedUsername));
}

function verifyOpenClawAuthToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) {
    return null;
  }

  const [username, expiresAtRaw, signature] = parts;
  const expiresAt = Number(expiresAtRaw);
  if (!username || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return null;
  }

  if (!isOpenClawAuthUsernameAllowed(username)) {
    return null;
  }

  const expectedSignature = createOpenClawAuthSignature(username, expiresAt);
  if (!timingSafeEqualText(signature, expectedSignature)) {
    return null;
  }

  return {
    username,
    expires_at_ms: expiresAt
  };
}

function getOpenClawAuthFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  return verifyOpenClawAuthToken(cookies[openClawAuthCookieName]);
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

function setOpenClawAuthCookie(res, token) {
  res.append(
    'Set-Cookie',
    serializeCookie(openClawAuthCookieName, token, {
      path: '/',
      maxAgeMs: openClawAuthTtlMs,
      httpOnly: true,
      sameSite: 'Lax'
    })
  );
}

function clearOpenClawAuthCookie(res) {
  res.append(
    'Set-Cookie',
    serializeCookie(openClawAuthCookieName, '', {
      path: '/',
      maxAgeMs: 0,
      httpOnly: true,
      sameSite: 'Lax'
    })
  );
}

function requireOpenClawAuth(req, res, next) {
  const auth = getOpenClawAuthFromRequest(req);
  if (!auth) {
    clearOpenClawAuthCookie(res);
    return res.status(401).json({
      ok: false,
      error: 'openclaw_auth_required'
    });
  }

  req.openClawAuth = auth;
  return next();
}

const cloudOpsReadOnlyToolNames = new Set([
  'ai_detection.config',
  'ai_detection.images',
  'status.key_nodes',
  'health.autodrive_check',
  'health.snapshot',
  'network.cloud_probe',
  'network.master_probe',
  'ros.overview',
  'ros.topic.list',
  'ros.topic.sample',
  'ros.topic.rate',
  'ros.node.list',
  'ros.service.list',
  'ros.diagnostics',
  'system.snapshot',
  'vehicle.snapshot',
  'status.camera',
  'camera.capture',
  'camera.upload_chain',
  'map.preview',
  'status.localization',
  'status.can',
  'status.body_control',
  'status.planning',
  'status.routing',
  'status.obstacle_processor',
  'obstacle.preview',
  'status.catalog',
  'status.control',
  'status.perception',
  'route.list',
  'route.detail',
  'process.top'
]);

function isCloudOpsReadOnlyPlan(plan) {
  if (!plan || typeof plan !== 'object') {
    return false;
  }

  if (['list_vehicles', 'vehicle_detail', 'tool_list', 'recent_events'].includes(plan.action)) {
    return true;
  }

  if (plan.action !== 'tool_call') {
    return false;
  }

  return cloudOpsReadOnlyToolNames.has(String(plan.tool_name || '').trim());
}

function toArchiveFileUrl(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    return null;
  }

  return `/api/ai-check-history/files/${relativePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`;
}

function normalizeAiCheckTask(task) {
  const mergedBox =
    Array.isArray(task?.merged_box_json) || task?.merged_box_json === null
      ? task?.merged_box_json
      : parseJsonField(task?.merged_box_json, null);
  const boxes =
    Array.isArray(task?.boxes_json) || task?.boxes_json === null
      ? task?.boxes_json
      : parseJsonField(task?.boxes_json, []);
  const cropBox =
    Array.isArray(task?.crop_box_json) || task?.crop_box_json === null
      ? task?.crop_box_json
      : parseJsonField(task?.crop_box_json, null);

  return {
    task_row_id: task?.task_row_id ?? null,
    task_idx: task?.task_idx ?? null,
    task_id: task?.task_id || null,
    event_name: task?.event_name || '',
    prompt_text: task?.prompt_text || '',
    expand_ratio: task?.expand_ratio ?? null,
    merged_box: mergedBox,
    boxes,
    crop_box: cropBox,
    roi_path: task?.roi_path || null,
    roi_url: toArchiveFileUrl(task?.roi_path || ''),
    answer: task?.answer || null,
    pass: task?.pass ?? null,
    raw_text: task?.raw_text || '',
    latency_ms: task?.latency_ms ?? null,
    error: task?.error || null
  };
}

function normalizeAiCheckRequestRow(row) {
  const tasks = parseJsonField(row?.tasks_json, [])
    ?.filter(Boolean)
    .map(normalizeAiCheckTask) || [];

  return {
    id: row?.id ?? row?.request_row_id ?? null,
    request_id: row?.request_id || '',
    device_id: row?.device_id || '',
    camera_id: row?.camera_id || '',
    edge_ts: row?.edge_ts ?? null,
    received_at_ms: row?.received_at_ms ?? null,
    created_at: row?.created_at || null,
    model: row?.model || null,
    frame_width: row?.frame_width ?? null,
    frame_height: row?.frame_height ?? null,
    image_mime_type: row?.image_mime_type || null,
    image_sha256: row?.image_sha256 || null,
    image_size_bytes: row?.image_size_bytes ?? null,
    image_path: row?.image_path || null,
    image_url: toArchiveFileUrl(row?.image_path || ''),
    request_json_path: row?.request_json_path || null,
    request_json_url: toArchiveFileUrl(row?.request_json_path || ''),
    response_json_path: row?.response_json_path || null,
    response_json_url: toArchiveFileUrl(row?.response_json_path || ''),
    request_dir: row?.request_dir || null,
    task_count: row?.task_count ?? tasks.length,
    latency_ms: row?.latency_ms ?? null,
    error: row?.error || null,
    tasks
  };
}

function resolveArchivePath(relativePath) {
  const rel = String(relativePath || '').trim();
  if (!rel) {
    throw new Error('archive_path_required');
  }

  const absolutePath = path.resolve(aiCheckArchiveRoot, rel);
  const normalizedRoot = `${aiCheckArchiveRoot}${path.sep}`;
  if (absolutePath !== aiCheckArchiveRoot && !absolutePath.startsWith(normalizedRoot)) {
    throw new Error('archive_path_out_of_range');
  }

  return absolutePath;
}

async function readArchiveJson(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    return null;
  }

  try {
    const absolutePath = resolveArchivePath(relativePath);
    const content = await fs.readFile(absolutePath, 'utf-8');
    return JSON.parse(content);
  } catch (_error) {
    return null;
  }
}

async function runArchiveSql(sql) {
  const { stdout } = await execFileAsync('sqlite3', ['-json', aiCheckArchiveDbUri, sql], {
    maxBuffer: 8 * 1024 * 1024
  });
  return parseJsonField(stdout, []);
}

async function writeArchiveSql(sql) {
  await execFileAsync('sqlite3', [aiCheckArchiveDbPath, sql], {
    maxBuffer: 1024 * 1024
  });
}

async function saveQwen36MmCheckToArchive({ requestId, eventName, promptText, imageBuffer, imageMimeType, answer, rawText, latencyMs, startMs }) {
  const now = new Date(startMs);
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const timeStr = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const reqHash = crypto.randomBytes(4).toString('hex');
  const taskId = `task_${crypto.randomBytes(4).toString('hex')}`;

  const dirRelPath = `requests/${dateStr}/${timeStr}_${requestId}_${reqHash}`;
  const dirAbsPath = path.join(aiCheckArchiveRoot, dirRelPath);

  const extMap = { 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
  const ext = extMap[imageMimeType.toLowerCase()] || '.jpg';
  const frameRelPath = `${dirRelPath}/frame${ext}`;
  const frameAbsPath = path.join(aiCheckArchiveRoot, frameRelPath);
  const reqJsonRelPath = `${dirRelPath}/request.json`;
  const resJsonRelPath = `${dirRelPath}/response.json`;

  const sha256 = crypto.createHash('sha256').update(imageBuffer).digest('hex');
  const createdAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  await fs.mkdir(dirAbsPath, { recursive: true });
  await fs.writeFile(frameAbsPath, imageBuffer);
  await fs.writeFile(path.join(aiCheckArchiveRoot, reqJsonRelPath), JSON.stringify({ request_id: requestId, event_name: eventName, prompt_text: promptText, model: qwen36MmModel }));
  await fs.writeFile(path.join(aiCheckArchiveRoot, resJsonRelPath), JSON.stringify({ answer, raw_text: rawText, latency_ms: latencyMs }));

  const esc = (s) => String(s == null ? '' : s).replace(/'/g, "''");
  const pass = answer === 'YES' ? 1 : (answer === 'NO' ? 0 : 'NULL');

  const sql = `
BEGIN;
INSERT INTO requests (request_id, device_id, camera_id, edge_ts, received_at_ms, created_at, model, image_mime_type, image_sha256, image_size_bytes, image_path, request_json_path, response_json_path, request_dir, task_count, latency_ms)
  VALUES ('${esc(requestId)}', 'web-qwen36mm', 'upload-panel', ${startMs}, ${startMs}, '${createdAt}', '${esc(qwen36MmModel)}', '${esc(imageMimeType)}', '${sha256}', ${imageBuffer.length}, '${esc(frameRelPath)}', '${esc(reqJsonRelPath)}', '${esc(resJsonRelPath)}', '${esc(dirRelPath)}', 1, ${latencyMs});
INSERT INTO tasks (request_row_id, task_idx, task_id, event_name, prompt_text, created_at)
  VALUES (last_insert_rowid(), 0, '${esc(taskId)}', '${esc(eventName)}', '${esc(promptText)}', '${createdAt}');
INSERT INTO results (request_row_id, task_row_id, task_idx, task_id, answer, pass, raw_text, latency_ms, created_at)
  SELECT r.id, t.id, 0, '${esc(taskId)}', '${esc(answer)}', ${pass}, '${esc(rawText)}', ${latencyMs}, '${createdAt}'
  FROM requests r JOIN tasks t ON t.request_row_id = r.id
  WHERE r.request_id = '${esc(requestId)}' LIMIT 1;
COMMIT;
`.trim();

  await writeArchiveSql(sql);
}

async function listAiCheckDeviceOptions() {
  const rows = await runArchiveSql(`
    SELECT
      r.device_id,
      COUNT(*) AS total
    FROM requests r
    WHERE TRIM(COALESCE(r.device_id, '')) <> ''
    GROUP BY r.device_id
    ORDER BY total DESC, r.device_id COLLATE NOCASE ASC;
  `);

  return rows
    .map((row) => String(row?.device_id || '').trim())
    .filter(Boolean);
}

async function listAiCheckHistory(page, pageSize, filters = {}) {
  const offset = (page - 1) * pageSize;
  const deviceId =
    typeof filters.device_id === 'string' && filters.device_id.trim()
      ? filters.device_id.trim()
      : '';
  const whereClause = deviceId ? `WHERE r.device_id = ${toSqlTextLiteral(deviceId)}` : '';
  const [countRows, rows] = await Promise.all([
    runArchiveSql(`SELECT COUNT(*) AS total FROM requests r ${whereClause};`),
    runArchiveSql(`
      SELECT
        r.id,
        r.request_id,
        r.device_id,
        r.camera_id,
        r.edge_ts,
        r.received_at_ms,
        r.created_at,
        r.task_count,
        r.latency_ms,
        r.error,
        r.image_path,
        COALESCE((
          SELECT json_group_array(
            json_object(
              'task_idx', t.task_idx,
              'task_id', t.task_id,
              'event_name', t.event_name,
              'roi_path', t.roi_path,
              'answer', rs.answer,
              'pass', rs.pass,
              'error', rs.error
            )
          )
          FROM tasks t
          LEFT JOIN results rs ON rs.task_row_id = t.id
          WHERE t.request_row_id = r.id
          ORDER BY t.task_idx ASC
        ), '[]') AS tasks_json
      FROM requests r
      ${whereClause}
      ORDER BY r.id DESC
      LIMIT ${pageSize} OFFSET ${offset};
    `)
  ]);
  const availableDeviceIds = await listAiCheckDeviceOptions();

  const total = countRows?.[0]?.total ?? 0;
  return {
    page,
    page_size: pageSize,
    total,
    total_pages: total > 0 ? Math.ceil(total / pageSize) : 1,
    selected_device_id: deviceId,
    available_device_ids: availableDeviceIds,
    items: rows.map(normalizeAiCheckRequestRow)
  };
}

async function getAiCheckHistoryDetail(requestRowId) {
  const rows = await runArchiveSql(`
    SELECT
      r.id AS request_row_id,
      r.request_id,
      r.device_id,
      r.camera_id,
      r.edge_ts,
      r.received_at_ms,
      r.created_at,
      r.model,
      r.frame_width,
      r.frame_height,
      r.image_mime_type,
      r.image_sha256,
      r.image_size_bytes,
      r.image_path,
      r.request_json_path,
      r.response_json_path,
      r.request_dir,
      r.task_count,
      r.latency_ms,
      r.error,
      COALESCE((
        SELECT json_group_array(
          json_object(
            'task_row_id', t.id,
            'task_idx', t.task_idx,
            'task_id', t.task_id,
            'event_name', t.event_name,
            'prompt_text', t.prompt_text,
            'expand_ratio', t.expand_ratio,
            'merged_box_json', t.merged_box_json,
            'boxes_json', t.boxes_json,
            'crop_box_json', t.crop_box_json,
            'roi_path', t.roi_path,
            'answer', rs.answer,
            'pass', rs.pass,
            'raw_text', rs.raw_text,
            'latency_ms', rs.latency_ms,
            'error', rs.error
          )
        )
        FROM tasks t
        LEFT JOIN results rs ON rs.task_row_id = t.id
        WHERE t.request_row_id = r.id
        ORDER BY t.task_idx ASC
      ), '[]') AS tasks_json
    FROM requests r
    WHERE r.id = ${requestRowId}
    LIMIT 1;
  `);

  if (!rows.length) {
    return null;
  }

  const request = normalizeAiCheckRequestRow(rows[0]);
  request.request_json = await readArchiveJson(request.request_json_path);
  request.response_json = await readArchiveJson(request.response_json_path);
  return request;
}

async function readStreamReply(stream, onDelta) {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let deltaText = '';
  let finalEvent = null;
  let emptyResponse = true;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    emptyResponse = false;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() || '';

    for (const block of blocks) {
      const data = parseSseBlock(block);
      if (!data) {
        continue;
      }

      if (data.type === 'delta' && typeof data.text === 'string') {
        deltaText += data.text;
        onDelta?.(data.text);
      }

      if (data.type === 'final') {
        finalEvent = data;
      }

      if (data.type === 'error') {
        throw new Error(data.error || data.message || 'upstream_stream_error');
      }
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const tail = parseSseBlock(buffer);
    if (tail?.type === 'final') {
      finalEvent = tail;
    } else if (tail?.type === 'delta' && typeof tail.text === 'string') {
      deltaText += tail.text;
    }
  }

  if (emptyResponse) {
    throw new Error('upstream_stream_empty');
  }

  const reply = normalizeReply(finalEvent?.answer || deltaText);
  if (!reply) {
    throw new Error('upstream_reply_empty');
  }

  return {
    reply,
    source: finalEvent?.source || 'chat-stream-proxy',
    latency_ms: finalEvent?.latency_ms || null
  };
}

async function readQwen36Stream(stream, onEvent) {
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  let reasoning = '';
  let usage = null;
  let finishReason = null;
  let emptyResponse = true;

  const handleBlock = (block) => {
    const lines = String(block || '')
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice(6).trim())
      .filter(Boolean);

    for (const line of lines) {
      if (line === '[DONE]') {
        continue;
      }

      let event;
      try {
        event = JSON.parse(line);
      } catch (_error) {
        continue;
      }

      emptyResponse = false;
      usage = event.usage || usage;
      const choice = Array.isArray(event.choices) ? event.choices[0] : null;
      if (!choice) {
        continue;
      }

      finishReason = choice.finish_reason || finishReason;
      const delta = choice.delta || {};
      const message = choice.message || {};
      const reasoningDelta =
        delta.reasoning ||
        delta.reasoning_content ||
        message.reasoning ||
        message.reasoning_content ||
        '';
      const answerDelta = delta.content || message.content || '';

      if (reasoningDelta) {
        reasoning += reasoningDelta;
        onEvent?.({ type: 'reasoning_delta', text: reasoningDelta });
      }

      if (answerDelta) {
        answer += answerDelta;
        onEvent?.({ type: 'delta', text: answerDelta });
      }
    }
  };

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() || '';
    blocks.forEach(handleBlock);
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    handleBlock(buffer);
  }

  if (emptyResponse) {
    throw new Error('qwen36_stream_empty');
  }

  return {
    reply: normalizeReply(answer),
    reasoning: normalizeReply(reasoning),
    finish_reason: finishReason,
    usage
  };
}

function normalizeQwen36Messages(inputMessages, message) {
  const normalized = [];
  const source = Array.isArray(inputMessages) ? inputMessages : [];

  source.slice(-16).forEach((item) => {
    const role = String(item?.role || '').trim();
    const content = String(item?.content || '').trim();
    if (!content || !['system', 'user', 'assistant'].includes(role)) {
      return;
    }
    normalized.push({ role, content: truncateText(content, 6000) });
  });

  if (message) {
    normalized.push({ role: 'user', content: truncateText(message, 6000) });
  }

  return normalized;
}

async function probeQwen36() {
  try {
    const response = await fetch(qwen36ModelsUrl, {
      signal: AbortSignal.timeout(5000)
    });
    const text = await response.text();
    const payload = parseJsonField(text, null);
    return {
      ok: response.ok,
      status: response.status,
      base_url: qwen36BaseUrl,
      model: qwen36Model,
      models: Array.isArray(payload?.data) ? payload.data.map((item) => item.id).filter(Boolean) : []
    };
  } catch (error) {
    return {
      ok: false,
      status: 502,
      base_url: qwen36BaseUrl,
      model: qwen36Model,
      detail: error.message
    };
  }
}

async function probeUpstream() {
  try {
    const response = await fetch(upstreamHealthUrl, {
      signal: AbortSignal.timeout(3000)
    });
    const text = await response.text();

    return {
      ok: response.ok,
      status: response.status,
      detail: text.trim() || null
    };
  } catch (error) {
    return {
      ok: false,
      status: 502,
      detail: error.message
    };
  }
}

async function fetchCloudAgentJson(pathname, options = {}) {
  const url = new URL(pathname, cloudAgentBaseUrl).toString();
  const requestOptions = {
    method: options.method || 'GET',
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(options.timeoutMs || cloudAgentTimeoutMs)
  };

  if (options.body) {
    requestOptions.body = JSON.stringify(options.body);
  }

  let response;
  try {
    response = await fetch(url, requestOptions);
  } catch (error) {
    const wrapped = new Error(`cloud_agent_request_failed: ${error.message}`);
    wrapped.status = 502;
    wrapped.endpoint = url;
    throw wrapped;
  }

  const rawText = await response.text();
  const payload = parseJsonField(rawText, null);

  if (!response.ok) {
    const detail =
      payload?.error || payload?.detail || payload?.message || normalizeReply(rawText) || `HTTP ${response.status}`;
    const wrapped = new Error(detail);
    wrapped.status = response.status;
    wrapped.endpoint = url;
    wrapped.payload = payload;
    throw wrapped;
  }

  return {
    url,
    status: response.status,
    data: payload ?? { raw: normalizeReply(rawText) }
  };
}

async function probeCloudAgent() {
  try {
    const result = await fetchCloudAgentJson('/healthz', { timeoutMs: 5000 });
    return {
      ok: true,
      base_url: cloudAgentBaseUrl,
      ...result.data
    };
  } catch (error) {
    return {
      ok: false,
      base_url: cloudAgentBaseUrl,
      detail: error.message
    };
  }
}

async function listCloudAgentVehicles() {
  const result = await fetchCloudAgentJson('/api/vehicles');
  const vehicles = Array.isArray(result?.data?.vehicles) ? result.data.vehicles : [];
  return vehicles;
}

function inferVehicleIdFromMessage(message, vehicles = []) {
  const source = String(message || '').trim();
  const normalized = source.toLowerCase();

  for (const vehicle of vehicles) {
    const candidates = [
      vehicle?.vehicle_id,
      vehicle?.plate_number,
      vehicle?.vin
    ]
      .map((value) => String(value || '').trim())
      .filter(Boolean);

    for (const candidate of candidates) {
      if (normalized.includes(candidate.toLowerCase())) {
        return String(vehicle?.vehicle_id || vehicle?.plate_number || candidate).trim();
      }
    }
  }

  const directMatch = source.match(/\b[A-Za-z]{2,}-\d{3,}\b/);
  if (directMatch?.[0]) {
    return directMatch[0];
  }

  return '';
}

function normalizeCloudOpsArgs(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

function extractCloudOpsRouteId(message) {
  const match = String(message || '').match(/\broute_[A-Za-z0-9._:-]+\b/);
  return match?.[0] || '';
}

function normalizeCloudOpsRouteText(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .toLowerCase();
}

function collectCloudOpsRouteCandidatesFromPayload(payload, routeMap = new Map(), seen = new Set()) {
  if (!payload || typeof payload !== 'object') {
    return routeMap;
  }

  if (seen.has(payload)) {
    return routeMap;
  }
  seen.add(payload);

  const appendCandidate = (routeId, names = []) => {
    const normalizedRouteId = extractCloudOpsRouteId(routeId);
    if (!normalizedRouteId) {
      return;
    }

    const current = routeMap.get(normalizedRouteId) || {
      route_id: normalizedRouteId,
      names: []
    };

    for (const name of names) {
      const cleaned = String(name || '').trim();
      if (cleaned && !current.names.includes(cleaned)) {
        current.names.push(cleaned);
      }
    }

    routeMap.set(normalizedRouteId, current);
  };

  const maybeRouteId = payload?.route_id || payload?.id || payload?.path_id || '';
  const maybeRouteName =
    payload?.route_name_trimmed || payload?.route_name || payload?.name || payload?.route || '';
  if (maybeRouteId) {
    appendCandidate(maybeRouteId, [maybeRouteName]);
  }

  const arrayKeys = ['routes', 'routes_preview', 'resolved_routes'];
  for (const key of arrayKeys) {
    const items = payload?.[key];
    if (!Array.isArray(items)) {
      continue;
    }

    for (const item of items) {
      if (typeof item === 'string') {
        appendCandidate(item, []);
        continue;
      }
      if (item && typeof item === 'object') {
        appendCandidate(item.route_id || item.id || item.path_id || '', [
          item.route_name_trimmed,
          item.route_name,
          item.name,
          item.route
        ]);
      }
    }
  }

  const previewIds = payload?.route_ids_preview;
  if (Array.isArray(previewIds)) {
    previewIds.forEach((item) => appendCandidate(item, []));
  }

  const nestedKeys = ['data', 'response', 'result', 'summary', 'route_catalog', 'request', 'payload'];
  for (const key of nestedKeys) {
    const nested = payload?.[key];
    if (nested && typeof nested === 'object') {
      collectCloudOpsRouteCandidatesFromPayload(nested, routeMap, seen);
    }
  }

  return routeMap;
}

function extractCloudOpsRouteCandidates(contextItems = []) {
  const routeMap = new Map();

  for (const item of contextItems) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    if (item.payload && typeof item.payload === 'object') {
      collectCloudOpsRouteCandidatesFromPayload(item.payload, routeMap);
    }
  }

  return Array.from(routeMap.values());
}

function resolveCloudOpsRouteIdFromText(message, contextItems = []) {
  const directRouteId = extractCloudOpsRouteId(message);
  if (directRouteId) {
    return directRouteId;
  }

  const normalizedMessage = normalizeCloudOpsRouteText(message);
  if (!normalizedMessage) {
    return '';
  }

  const routeCandidates = extractCloudOpsRouteCandidates(contextItems);
  let bestMatch = null;

  for (const candidate of routeCandidates) {
    const routeId = extractCloudOpsRouteId(candidate?.route_id || '');
    if (!routeId) {
      continue;
    }

    const names = Array.isArray(candidate?.names) ? candidate.names : [];
    const textsToMatch = [routeId, ...names];

    for (const text of textsToMatch) {
      const normalizedText = normalizeCloudOpsRouteText(text);
      if (!normalizedText || !normalizedMessage.includes(normalizedText)) {
        continue;
      }

      if (!bestMatch || normalizedText.length > bestMatch.match_length) {
        bestMatch = {
          route_id: routeId,
          match_length: normalizedText.length
        };
      }
    }
  }

  return bestMatch?.route_id || '';
}

function resolveCloudOpsRouteCandidateFromText(message, candidates = []) {
  const directRouteId = extractCloudOpsRouteId(message);
  if (directRouteId) {
    const matched = candidates.find(
      (candidate) => extractCloudOpsRouteId(candidate?.route_id || '') === directRouteId
    );
    return {
      route_id: directRouteId,
      route_name: matched?.names?.[0] || '',
      match_length: directRouteId.length
    };
  }

  const normalizedMessage = normalizeCloudOpsRouteText(message);
  if (!normalizedMessage) {
    return null;
  }

  let bestMatch = null;

  for (const candidate of candidates) {
    const routeId = extractCloudOpsRouteId(candidate?.route_id || '');
    if (!routeId) {
      continue;
    }

    const names = Array.isArray(candidate?.names) ? candidate.names : [];
    const textsToMatch = [routeId, ...names];

    for (const text of textsToMatch) {
      const normalizedText = normalizeCloudOpsRouteText(text);
      if (!normalizedText || !normalizedMessage.includes(normalizedText)) {
        continue;
      }

      if (!bestMatch || normalizedText.length > bestMatch.match_length) {
        bestMatch = {
          route_id: routeId,
          route_name: names.find(Boolean) || String(text || '').trim(),
          match_length: normalizedText.length
        };
      }
    }
  }

  return bestMatch;
}

function extractCloudOpsRouteNameHint(message) {
  const text = String(message || '')
    .replace(/[，,。！？!?\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) {
    return '';
  }

  const patterns = [
    /(?:正式启动|立即启动|直接启动|开始巡逻|启动巡逻|执行巡逻|开始|启动|执行)\s*([A-Za-z0-9\u4e00-\u9fa5_-]{1,24})/,
    /(?:沿|按|去|走|跑)\s*([A-Za-z0-9\u4e00-\u9fa5_-]{1,24})/,
    /([A-Za-z0-9\u4e00-\u9fa5_-]{1,24})\s*(?:开始巡逻|启动巡逻|执行巡逻|开始|启动|执行)/
  ];

  const stopWords = new Set([
    '巡逻',
    '开始',
    '启动',
    '执行',
    '正式启动',
    '立即启动',
    '直接启动',
    '速度',
    'km',
    'kph'
  ]);

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const candidate = String(match?.[1] || '').trim();
    if (!candidate) {
      continue;
    }
    if (stopWords.has(candidate)) {
      continue;
    }
    if (/^\d+$/.test(candidate)) {
      continue;
    }
    if (/(?:km\/h|kph|公里|圈|速度)$/.test(candidate)) {
      continue;
    }
    return candidate;
  }

  return '';
}

function extractCloudOpsPatrolLoops(message) {
  return extractCloudOpsNumber(message, /(\d+)\s*圈/);
}

function extractCloudOpsSpeedKph(message) {
  return extractCloudOpsNumber(
    message,
    /(\d+(?:\.\d+)?)\s*(?:公里\/小时|km\/h|kph|公里每小时)/i
  );
}

function inferCloudOpsDryRun(message, fallback = true) {
  const text = String(message || '');
  if (
    /(预演|演练|dry[\s-]*run|不要真跑|不要真正启动|只做校验|仅校验|模拟启动|试运行|试跑一下)/i.test(
      text
    )
  ) {
    return true;
  }
  if (
    /(正式启动|确认启动|立即启动|直接启动|真实启动|真正启动|开始巡逻|启动巡逻|执行巡逻|开始沿|沿.+巡逻|去巡逻|run patrol|start patrol)/i.test(
      text
    )
  ) {
    return false;
  }
  return fallback;
}

function inferCloudOpsBodyControlArgs(message) {
  const text = String(message || '');
  const lower = text.toLowerCase();
  const args = {};
  let matched = false;
  const turnOn = /(打开|开启|点亮|亮起|打开一下|开一下|启动)/.test(text);
  const turnOff = /(关闭|关掉|熄灭|灭掉|关闭一下|关一下|取消)/.test(text);

  if (/(广告屏|广告牌|ad[\s_-]*screen)/i.test(text)) {
    matched = true;
    if (turnOn || /广告屏.*开|开.*广告屏/.test(text)) {
      args.ad_screen = true;
    } else if (turnOff || /广告屏.*关|关.*广告屏/.test(text)) {
      args.ad_screen = false;
    }
  }

  if (/(前照灯|前灯|大灯|front[\s_-]*lamp)/i.test(text)) {
    matched = true;
    if (turnOn || /前照灯.*开|前灯.*开|大灯.*开|开.*前照灯|开.*前灯|开.*大灯/.test(text)) {
      args.front_lamp = true;
    } else if (
      turnOff ||
      /前照灯.*关|前灯.*关|大灯.*关|关.*前照灯|关.*前灯|关.*大灯/.test(text)
    ) {
      args.front_lamp = false;
    }
  }

  if (/(氛围灯|mood[\s_-]*lamp)/i.test(text)) {
    matched = true;
    if (turnOn || /氛围灯.*开|开.*氛围灯/.test(text)) {
      args.mood_lamp = true;
    } else if (turnOff || /氛围灯.*关|关.*氛围灯/.test(text)) {
      args.mood_lamp = false;
    }
  }

  if (/(双闪|hazard)/i.test(lower)) {
    matched = true;
    args.steer_lamp = turnOff || /关闭双闪|取消双闪|双闪关闭/.test(text) ? 'off' : 'hazard';
  } else if (/(左转灯|左转向灯|左灯)/.test(text)) {
    matched = true;
    args.steer_lamp =
      turnOff || /关闭左转灯|取消左转灯|左转灯关闭/.test(text) ? 'off' : 'left';
  } else if (/(右转灯|右转向灯|右灯)/.test(text)) {
    matched = true;
    args.steer_lamp =
      turnOff || /关闭右转灯|取消右转灯|右转灯关闭/.test(text) ? 'off' : 'right';
  } else if (
    /(关闭转向灯|取消转向灯|关闭方向灯|方向灯关闭|转向灯关闭|steer[\s_-]*lamp off|turn signal off)/i.test(
      text
    )
  ) {
    matched = true;
    args.steer_lamp = 'off';
  }

  if (!matched) {
    return null;
  }

  args.require_stationary = !/(无需静止|不要求静止|行驶中也执行|允许移动中执行|无需停车)/.test(text);
  if (/(先停巡逻|停止巡逻后|先停止巡逻|先停车|先停下)/.test(text)) {
    args.stop_patrol_first = true;
  }
  return args;
}

async function fetchCloudOpsRouteCatalog(vehicleId, options = {}) {
  const normalizedVehicleId = String(vehicleId || '').trim();
  if (!normalizedVehicleId) {
    return [];
  }

  const cached = cloudOpsRouteCatalogCache.get(normalizedVehicleId);
  const now = Date.now();
  if (cached && now - cached.updated_at_ms < cloudOpsRouteCatalogCacheTtlMs) {
    return cached.routes.map((item) => ({
      route_id: item.route_id,
      names: Array.isArray(item.names) ? [...item.names] : []
    }));
  }

  const timeout_s = toFiniteInteger(options.timeout_s, 25, { min: 5, max: 60 });
  const result = await fetchCloudAgentJson(
    `/api/vehicles/${encodeURIComponent(normalizedVehicleId)}/tools/route.list`,
    {
      method: 'POST',
      body: {
        args: {},
        timeout_s
      },
      timeoutMs: Math.max(cloudAgentTimeoutMs, timeout_s * 1000 + 5000)
    }
  );

  const routeMap = collectCloudOpsRouteCandidatesFromPayload(
    result?.data?.response?.result || result?.data?.response || result?.data
  );
  const routes = Array.from(routeMap.values());
  cloudOpsRouteCatalogCache.set(normalizedVehicleId, {
    updated_at_ms: now,
    routes
  });
  return routes.map((item) => ({
    route_id: item.route_id,
    names: Array.isArray(item.names) ? [...item.names] : []
  }));
}

async function resolveCloudOpsRouteReference(message, contextItems = [], vehicleId = '') {
  const directRouteId = extractCloudOpsRouteId(message);
  if (directRouteId) {
    return {
      route_id: directRouteId,
      route_name: '',
      source: 'direct_route_id'
    };
  }

  const contextCandidates = extractCloudOpsRouteCandidates(contextItems);
  const contextMatch = resolveCloudOpsRouteCandidateFromText(message, contextCandidates);
  if (contextMatch?.route_id) {
    return {
      route_id: contextMatch.route_id,
      route_name: contextMatch.route_name || '',
      source: 'context_match'
    };
  }

  if (vehicleId) {
    try {
      const catalog = await fetchCloudOpsRouteCatalog(vehicleId, { timeout_s: 25 });
      const catalogMatch = resolveCloudOpsRouteCandidateFromText(message, catalog);
      if (catalogMatch?.route_id) {
        return {
          route_id: catalogMatch.route_id,
          route_name: catalogMatch.route_name || '',
          source: 'route_list_match'
        };
      }
    } catch (_error) {
      // Ignore route catalog lookup errors and fall back to route name inference below.
    }
  }

  const routeName = extractCloudOpsRouteNameHint(message);
  if (routeName) {
    return {
      route_id: '',
      route_name: routeName,
      source: 'message_route_name'
    };
  }

  return {
    route_id: '',
    route_name: '',
    source: 'unresolved'
  };
}

async function finalizeCloudOpsPlan(plan, message, contextItems = [], options = {}) {
  const nextPlan = validateCloudOpsPlan(plan) || { action: 'none' };
  const selectedVehicleId = String(options?.selectedVehicleId || '').trim();

  if (!nextPlan.vehicle_id && selectedVehicleId) {
    nextPlan.vehicle_id = selectedVehicleId;
  }

  if (
    nextPlan.action === 'tool_call' &&
    (nextPlan.tool_name === 'route.detail' || nextPlan.tool_name === 'route.start_patrol')
  ) {
    const routeReference = await resolveCloudOpsRouteReference(
      [
        nextPlan?.args?.route_id,
        Array.isArray(nextPlan?.args?.route_ids) ? nextPlan.args.route_ids.join(' ') : '',
        nextPlan?.args?.route_name,
        Array.isArray(nextPlan?.args?.route_names) ? nextPlan.args.route_names.join(' ') : '',
        message
      ]
        .filter(Boolean)
        .join(' '),
      contextItems,
      nextPlan.vehicle_id || selectedVehicleId
    );

    if (routeReference.route_id) {
      nextPlan.args = {
        ...nextPlan.args,
        route_id: routeReference.route_id
      };
      delete nextPlan.args.route_ids;
      delete nextPlan.args.route_name;
      delete nextPlan.args.route_names;
    } else if (!nextPlan?.args?.route_name && routeReference.route_name) {
      nextPlan.args = {
        ...nextPlan.args,
        route_name: routeReference.route_name
      };
      delete nextPlan.args.route_ids;
      delete nextPlan.args.route_names;
    }
  }

  if (nextPlan.action === 'tool_call' && nextPlan.tool_name === 'route.start_patrol') {
    const extractedLoops = extractCloudOpsPatrolLoops(message);
    const extractedSpeed = extractCloudOpsSpeedKph(message);
    const normalizedSpeed = Number(
      extractedSpeed ??
        nextPlan?.args?.speed_kph ??
        nextPlan?.args?.speed_kmh ??
        nextPlan?.args?.speed ??
        NaN
    );
    if (Number.isFinite(normalizedSpeed)) {
      nextPlan.args = {
        ...nextPlan.args,
        speed_kph: normalizedSpeed
      };
      delete nextPlan.args.speed_kmh;
      delete nextPlan.args.speed;
    }

    nextPlan.args = {
      ...nextPlan.args,
      loops: toFiniteInteger(extractedLoops ?? nextPlan?.args?.loops, 1, { min: 1, max: 100 }),
      dry_run: inferCloudOpsDryRun(message, nextPlan?.args?.dry_run !== false)
    };
    nextPlan.timeout_s = Math.max(nextPlan.timeout_s || 0, 30);
  }

  if (nextPlan.action === 'tool_call' && nextPlan.tool_name === 'camera.capture') {
    nextPlan.args = {
      camera_ids:
        Array.isArray(nextPlan?.args?.camera_ids) && nextPlan.args.camera_ids.length
          ? nextPlan.args.camera_ids
          : ['camera1', 'camera2', 'camera3', 'camera4'],
      quality: toFiniteInteger(nextPlan?.args?.quality, 70, { min: 10, max: 95 }),
      max_width: toFiniteInteger(nextPlan?.args?.max_width, 640, { min: 160, max: 1920 }),
      include_base64: nextPlan?.args?.include_base64 !== false
    };
    nextPlan.timeout_s = Math.max(nextPlan.timeout_s || 0, 40);
  }

  if (nextPlan.action === 'tool_call' && nextPlan.tool_name === 'map.preview') {
    nextPlan.args = {
      image_size: toFiniteInteger(nextPlan?.args?.image_size, 1024, { min: 256, max: 2048 }),
      include_base64: nextPlan?.args?.include_base64 !== false
    };
    nextPlan.timeout_s = Math.max(nextPlan.timeout_s || 0, 40);
  }

  if (nextPlan.action === 'tool_call' && nextPlan.tool_name === 'vehicle.clear_collision_stop') {
    nextPlan.args = {
      stop_patrol_first: nextPlan?.args?.stop_patrol_first !== false
    };
    nextPlan.timeout_s = Math.max(nextPlan.timeout_s || 0, 45);
  }

  if (nextPlan.action === 'tool_call' && nextPlan.tool_name === 'vehicle.body_control') {
    const inferredArgs = inferCloudOpsBodyControlArgs(message) || {};
    const mergedArgs = {
      ...nextPlan.args,
      ...inferredArgs
    };
    nextPlan.args = {
      ...mergedArgs,
      require_stationary: mergedArgs.require_stationary !== false,
      stop_patrol_first: mergedArgs.stop_patrol_first === true
    };
    if (!nextPlan.args.steer_lamp && typeof mergedArgs.steer_lamp_mode === 'string') {
      nextPlan.args.steer_lamp = mergedArgs.steer_lamp_mode;
    }
    delete nextPlan.args.steer_lamp_mode;
    delete nextPlan.args.steer_lamp_code;
    nextPlan.timeout_s = Math.max(nextPlan.timeout_s || 0, 35);
  }

  if (nextPlan.action === 'tool_call' && nextPlan.tool_name === 'status.body_control') {
    nextPlan.args = {};
    nextPlan.timeout_s = Math.max(nextPlan.timeout_s || 0, 25);
  }

  return nextPlan;
}

function extractCloudOpsTopic(message) {
  const match = String(message || '').match(/\/[A-Za-z0-9_./-]+/);
  return match?.[0] || '';
}

function extractCloudOpsNumber(message, pattern) {
  const match = String(message || '').match(pattern);
  const value = Number(match?.[1]);
  return Number.isFinite(value) ? value : null;
}

function inferCloudOpsPattern(message) {
  const text = String(message || '').trim();
  const lower = text.toLowerCase();
  const explicitMatch = text.match(
    /(?:pattern|过滤|筛选|包含|查找|匹配)\s*(?:为|成|成了|一下|下)?\s*[:：]?\s*[“"'`]?([A-Za-z0-9_./:-]{2,})[”"'`]?/i
  );

  if (explicitMatch?.[1]) {
    return explicitMatch[1];
  }

  if (/camera|摄像头|相机/.test(lower)) return 'camera';
  if (/record|录制|录像/.test(lower)) return 'record';
  if (/diagnostics|诊断/.test(lower)) return 'diagnostics';
  if (/laser|lidar|点云/.test(lower)) return 'laser';
  if (/fusion|感知/.test(lower)) return 'fusion';
  if (/plan|planning|规划/.test(lower)) return 'plan';
  if (/map|定位/.test(lower)) return 'map';
  return '';
}

function createToolCallPlan(vehicleId, toolName, args = {}, timeout_s = 20) {
  return {
    action: 'tool_call',
    vehicle_id: vehicleId,
    tool_name: toolName,
    args,
    timeout_s
  };
}

function pickCloudOpsList(result) {
  if (Array.isArray(result)) {
    return result;
  }
  if (!result || typeof result !== 'object') {
    return [];
  }

  const candidates = [
    result.items,
    result.routes,
    result.topics,
    result.nodes,
    result.services,
    result.cameras,
    result.captures,
    result.images,
    result.checks,
    result.statuses,
    result.categories,
    result.key_topics
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return [];
}

function formatCloudOpsPreviewList(items, picker, limit = 6) {
  return items
    .map((item) => picker(item))
    .filter(Boolean)
    .slice(0, limit)
    .join('、');
}

function formatCloudOpsHumanBytes(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    return '-';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let current = num;
  let unitIndex = 0;
  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }
  const digits = current >= 100 || unitIndex === 0 ? 0 : current >= 10 ? 1 : 2;
  return `${current.toFixed(digits)} ${units[unitIndex]}`;
}

function formatCloudOpsDurationBrief(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '-';
  }

  const total = Math.round(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const parts = [];
  if (days) parts.push(`${days}天`);
  if (hours) parts.push(`${hours}小时`);
  if (minutes) parts.push(`${minutes}分`);
  if (!parts.length) parts.push(`${total % 60}秒`);
  return parts.join('');
}

function createCloudOpsHeuristicPlan(message, vehicles = [], options = {}) {
  const text = String(message || '').trim();
  const lower = text.toLowerCase();
  const selectedVehicleId = String(options?.selectedVehicleId || '').trim();
  const contextItems = Array.isArray(options?.contextItems) ? options.contextItems : [];
  const vehicleId = inferVehicleIdFromMessage(text, vehicles) || selectedVehicleId || '';
  const routeId = resolveCloudOpsRouteIdFromText(text, contextItems);
  const topic = extractCloudOpsTopic(text);
  const pattern = inferCloudOpsPattern(text);
  const loops = extractCloudOpsNumber(text, /(\d+)\s*圈/);
  const maxPoints = extractCloudOpsNumber(text, /(?:max[_\s-]*points|最多|取前)\s*(\d+)/i);
  const limit = extractCloudOpsNumber(text, /(?:limit|前|最多)\s*(\d+)\s*(?:个|条|行|项|进程)?/i);
  const sampleSeconds = extractCloudOpsNumber(text, /(\d+(?:\.\d+)?)\s*秒/);
  const speedKph = extractCloudOpsNumber(
    text,
    /(\d+(?:\.\d+)?)\s*(?:公里\/小时|km\/h|kph|公里每小时)/i
  );
  const includeRate = /帧率|频率|rate|hz/i.test(lower);
  const dryRun = inferCloudOpsDryRun(text, true);

  if (!text) {
    return { action: 'none' };
  }

  if (/在线车辆|车辆列表|有哪些车|多少台车|哪些车在线/.test(text)) {
    return { action: 'list_vehicles' };
  }

  if (/最近事件|最近活动|事件流|最近上报/.test(text)) {
    return { action: 'recent_events' };
  }

  if (/工具列表|有哪些工具|支持什么工具/.test(text)) {
    return { action: 'tool_list', vehicle_id: vehicleId };
  }

  if (/云端连通|云控连通|握手状态|websocket握手|cloud_probe|云端探测|连云/.test(lower)) {
    return createToolCallPlan(vehicleId, 'network.cloud_probe', {}, 20);
  }

  if (/进程负载|进程排行|top进程|cpu最高|内存最高|占用最高/.test(text)) {
    return createToolCallPlan(
      vehicleId,
      'process.top',
      {
        sort: /内存/.test(text) ? 'memory' : 'cpu',
        limit: toFiniteInteger(limit, 10, { min: 1, max: 30 })
      },
      20
    );
  }

  if (/ros总览|ros overview|topic数量|node数量|service数量|ros规模/.test(lower)) {
    return createToolCallPlan(vehicleId, 'ros.overview', {}, 20);
  }

  if ((topic && /频率|帧率|hz|速率|rate/.test(lower)) || /话题频率|话题帧率|topic rate/.test(lower)) {
    return createToolCallPlan(
      vehicleId,
      'ros.topic.rate',
      {
        topic,
        sample_seconds: sampleSeconds ?? 3.0
      },
      20
    );
  }

  if ((topic && /采样|订阅|抽样|查看.*话题|读取.*话题|topic sample/.test(lower)) || /话题采样|topic sample/.test(lower)) {
    return createToolCallPlan(
      vehicleId,
      'ros.topic.sample',
      {
        topic,
        timeout_s: sampleSeconds ?? 3.0,
        summary_only: true
      },
      20
    );
  }

  if (/话题列表|有哪些话题|topic list|topic列表|ros话题/.test(lower)) {
    return createToolCallPlan(
      vehicleId,
      'ros.topic.list',
      {
        pattern,
        limit: toFiniteInteger(limit, 50, { min: 1, max: 200 })
      },
      20
    );
  }

  if (/节点列表|有哪些节点|ros节点|node list/.test(lower)) {
    return createToolCallPlan(vehicleId, 'ros.node.list', { pattern }, 20);
  }

  if (/服务列表|有哪些服务|ros服务|service list/.test(lower)) {
    return createToolCallPlan(vehicleId, 'ros.service.list', { pattern }, 20);
  }

  if (/诊断|diagnostics/.test(lower)) {
    return createToolCallPlan(vehicleId, 'ros.diagnostics', {}, 20);
  }

  if (/全车快照|整车快照|全车总览|整车状态|vehicle snapshot/.test(lower)) {
    return createToolCallPlan(
      vehicleId,
      'vehicle.snapshot',
      { include_topic_samples: !/不要topic|不带topic|不要采样/.test(text) },
      25
    );
  }

  if (/系统快照|系统资源|cpu内存磁盘|磁盘情况|内存情况|温度|网卡状态|system snapshot/.test(lower)) {
    return createToolCallPlan(
      vehicleId,
      'system.snapshot',
      { include_processes: !/不要进程|不含进程/.test(text) },
      20
    );
  }

  if (/系统能力|能力总览|子系统目录|catalog|状态目录/.test(lower)) {
    return createToolCallPlan(
      vehicleId,
      'status.catalog',
      { include_runtime: !/不要运行态|不带运行态/.test(text) },
      20
    );
  }

  if (/关键节点|节点状态|自动驾驶关键节点|key nodes/.test(lower)) {
    return createToolCallPlan(vehicleId, 'status.key_nodes', {}, 20);
  }

  if (/一键检查|一键排查|启航前检查|自动驾驶检查|健康检查|autodrive check/.test(lower)) {
    return createToolCallPlan(vehicleId, 'health.autodrive_check', {}, 20);
  }

  if (/路线列表|巡逻路线|有哪些路线|route list|列出路线/.test(lower)) {
    return createToolCallPlan(vehicleId, 'route.list', {}, 20);
  }

  if (/车身状态|车灯状态|灯光状态|广告屏状态|前照灯状态|氛围灯状态|双闪状态|转向灯状态|body control status|status body control/.test(lower)) {
    return createToolCallPlan(vehicleId, 'status.body_control', {}, 25);
  }

  if (/routing状态|routing|路线状态|当前路线状态/.test(lower)) {
    return createToolCallPlan(vehicleId, 'status.routing', {}, 20);
  }

  if (/路线详情|route detail|查看路线|路线信息/.test(lower) && routeId) {
    return createToolCallPlan(
      vehicleId,
      'route.detail',
      {
        route_id: routeId,
        max_points: toFiniteInteger(maxPoints, 20, { min: 1, max: 200 })
      },
      20
    );
  }

  if (/停止巡逻|结束巡逻|停止路线|stop patrol/.test(lower)) {
    return createToolCallPlan(vehicleId, 'route.stop_patrol', {}, 20);
  }

  if (/启动巡逻|开始巡逻|执行巡逻|start patrol|跑.*圈|巡逻这条路线/.test(lower)) {
    return createToolCallPlan(
      vehicleId,
      'route.start_patrol',
      {
        route_id: routeId,
        loops: toFiniteInteger(loops, 1, { min: 1, max: 100 }),
        speed_kph: speedKph ?? 2.0,
        dry_run: dryRun
      },
      25
    );
  }

  if (/底盘|can|电量|soc|急停|碰撞停|故障灯|手柄接管/.test(lower)) {
    return createToolCallPlan(vehicleId, 'status.can', {}, 20);
  }

  const bodyControlArgs = inferCloudOpsBodyControlArgs(text);
  if (bodyControlArgs) {
    return createToolCallPlan(vehicleId, 'vehicle.body_control', bodyControlArgs, 35);
  }

  if (/碰撞停复位|防撞梁复位|清除碰撞停|解除碰撞停|清防撞梁|clear collision stop|clear bumper/.test(lower)) {
    return createToolCallPlan(
      vehicleId,
      'vehicle.clear_collision_stop',
      {
        stop_patrol_first: true
      },
      45
    );
  }

  if (/抓拍|看图|看图片|当前图像|拍一张|camera capture/.test(lower)) {
    return createToolCallPlan(
      vehicleId,
      'camera.capture',
      {
        camera_ids: ['camera1', 'camera2', 'camera3', 'camera4'],
        quality: 70,
        max_width: 640,
        include_base64: true
      },
      30
    );
  }

  if (/ai检测配置|检测配置|dino配置|groundingdino配置|检测事件配置|ai detection config/.test(lower)) {
    return createToolCallPlan(vehicleId, 'ai_detection.config', {}, 30);
  }

  if (/ai检测图片|检测图片|检测落盘|dino图片|groundingdino图片|最近检测图|ai detection images/.test(lower)) {
    return createToolCallPlan(
      vehicleId,
      'ai_detection.images',
      {
        limit: 6
      },
      35
    );
  }

  if (/地图查看|地图预览|查看地图|地图情况|点云地图|map preview|show map/.test(lower)) {
    return createToolCallPlan(
      vehicleId,
      'map.preview',
      {
        image_size: 1024,
        include_base64: true
      },
      40
    );
  }

  if (/障碍俯视图|障碍预览|障碍物俯视图|查看障碍物|障碍物预览|obstacle preview/.test(lower)) {
    return createToolCallPlan(
      vehicleId,
      'obstacle.preview',
      {
        topic: '/fusion/objects',
        range_m: 15,
        image_size: 768,
        save_file: true,
        include_base64: true
      },
      40
    );
  }

  if (/上传链路|推流链路|视频上传|上传状态|upload chain/.test(lower)) {
    return createToolCallPlan(vehicleId, 'camera.upload_chain', {}, 20);
  }

  if (/相机|摄像头|camera|视频链路|图像链路/.test(lower)) {
    return createToolCallPlan(
      vehicleId,
      'status.camera',
      {
        include_rate: includeRate,
        sample_seconds: includeRate ? sampleSeconds ?? 1.0 : undefined
      },
      20
    );
  }

  if (/定位|localization|ndt|gps|imu|经纬度|heading|定位可靠/.test(lower)) {
    return createToolCallPlan(vehicleId, 'status.localization', {}, 20);
  }

  if (/规划|planning|estop|坡道|圈数|参考线/.test(lower)) {
    return createToolCallPlan(vehicleId, 'status.planning', {}, 20);
  }

  if (/控制输出|控制链路|control|控制状态/.test(lower)) {
    return createToolCallPlan(vehicleId, 'status.control', {}, 20);
  }

  if (/障碍处理|障碍链路|激光输入|obstacle processor/.test(lower)) {
    return createToolCallPlan(vehicleId, 'status.obstacle_processor', {}, 20);
  }

  if (/感知|perception|融合目标|点云|人群|挥手|fusion|crowd|handwave/.test(lower)) {
    return createToolCallPlan(vehicleId, 'status.perception', {}, 20);
  }

  if (/快照|snapshot/.test(lower)) {
    return { action: 'snapshot_request', vehicle_id: vehicleId, timeout_s: 20 };
  }

  if (/详情|缓存|最近状态|当前状态/.test(text) && vehicleId) {
    return { action: 'vehicle_detail', vehicle_id: vehicleId };
  }

  if (/主控|网络|连通|ssh|master_probe|探测/.test(lower)) {
    return {
      action: 'tool_call',
      vehicle_id: vehicleId,
      tool_name: 'network.master_probe',
      args: { include_ssh: true },
      timeout_s: 25
    };
  }

  if (/健康|状态|heartbeat|资源|体检|健康快照/.test(lower)) {
    return {
      action: 'tool_call',
      vehicle_id: vehicleId,
      tool_name: 'health.snapshot',
      args: {},
      timeout_s: 20
    };
  }

  return { action: 'none', vehicle_id: vehicleId };
}

function validateCloudOpsPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return null;
  }

  const action = String(plan.action || '').trim();
  const allowedActions = new Set([
    'none',
    'list_vehicles',
    'vehicle_detail',
    'tool_list',
    'snapshot_request',
    'recent_events',
    'tool_call'
  ]);

  if (!allowedActions.has(action)) {
    return null;
  }

  return {
    action,
    vehicle_id: String(plan.vehicle_id || '').trim(),
    request_id: String(plan.request_id || '').trim(),
    tool_name: String(plan.tool_name || '').trim(),
    args: normalizeCloudOpsArgs(plan.args),
    timeout_s: toFiniteInteger(plan.timeout_s, 20, { min: 3, max: 120 }),
    reason: String(plan.reason || '').trim()
  };
}

async function planCloudOpsAction(message, sessionId, vehicles = [], options = {}) {
  const contextItems = normalizeOpenClawContextItems(options?.contextItems);
  const selectedVehicleId = String(options?.selectedVehicleId || '').trim();
  const routeCandidates = extractCloudOpsRouteCandidates(contextItems).slice(0, 12);
  const heuristicPlan = createCloudOpsHeuristicPlan(message, vehicles, {
    contextItems,
    selectedVehicleId
  });
  const validatedHeuristicPlan = validateCloudOpsPlan(heuristicPlan) || { action: 'none' };

  if (validatedHeuristicPlan.action !== 'none') {
    return finalizeCloudOpsPlan(validatedHeuristicPlan, message, contextItems, {
      selectedVehicleId
    });
  }

  const vehicleHints = vehicles.map((vehicle) => ({
    vehicle_id: vehicle?.vehicle_id || null,
    plate_number: vehicle?.plate_number || null,
    vin: vehicle?.vin || null,
    last_seen: vehicle?.last_seen || null,
    tool_count: vehicle?.tool_count ?? null
  }));

  const plannerPrompt = [
    '你是云端运维动作规划器。',
    '你的任务是把用户的中文请求，映射为一个 JSON 动作，不要输出任何解释，不要输出 markdown 代码块。',
    '允许动作 action 只有：none, list_vehicles, vehicle_detail, tool_list, snapshot_request, recent_events, tool_call。',
    '如果用户想看在线车辆或车辆列表，用 list_vehicles。',
    '如果用户想看某台车详情、heartbeat、snapshot、缓存，用 vehicle_detail。',
    '如果用户想看工具列表，用 tool_list。',
    '如果用户想让车辆立即回一份快照，用 snapshot_request。',
    '如果用户想看最近事件或最近活动，用 recent_events。',
    '如果用户明确说当前状态、详情、缓存、最近状态，并且带了具体 vehicle_id，优先用 vehicle_detail。',
    '如果用户想查健康、资源、状态，优先用 tool_call 并把 tool_name 设为 health.snapshot。',
    '如果用户想查主控连通性、网络或 SSH，优先用 tool_call 并把 tool_name 设为 network.master_probe，args.include_ssh=true。',
    '如果用户想查云端握手或云端连通性，优先用 tool_call 并把 tool_name 设为 network.cloud_probe。',
    '如果用户想看系统资源、CPU、内存、磁盘、温度，用 tool_call: system.snapshot。',
    '如果用户想看 ROS 总览，用 tool_call: ros.overview。',
    '如果用户想看 ROS 话题列表、节点列表、服务列表、诊断、话题采样、话题频率，用相应 ros.* 工具。',
    '如果用户想看子系统目录、关键节点、一键健康检查、相机状态、相机抓拍、地图预览、上传链路、AI检测配置、AI检测落盘图片、CAN/底盘、车身状态、车身控制、碰撞停复位、定位、规划、routing、控制、障碍处理、障碍俯视图、感知，分别用 status.catalog、status.key_nodes、health.autodrive_check、status.camera、camera.capture、map.preview、camera.upload_chain、ai_detection.config、ai_detection.images、status.can、status.body_control、vehicle.body_control、vehicle.clear_collision_stop、status.localization、status.planning、status.routing、status.control、status.obstacle_processor、obstacle.preview、status.perception。',
    '如果用户说打开广告屏、关闭广告屏、打开前照灯、关闭前照灯、打开氛围灯、关闭氛围灯、打开双闪、左转灯、右转灯、关闭转向灯，优先用 vehicle.body_control。',
    '如果用户想看巡逻路线、路线详情、启动巡逻、停止巡逻，分别用 route.list、route.detail、route.start_patrol、route.stop_patrol。',
    '如果用户明确说开始巡逻、启动巡逻、执行巡逻，route.start_patrol 默认按正式执行；只有当用户说预演、演练、试运行、不要真跑时，才把 args.dry_run=true。',
    '如果用户提到路线名，例如“8楼”“4d”，并且当前会话上下文里有路线提示，请把它映射为对应的 args.route_id。',
    '如果没有明确运维动作，action 返回 none。',
    'JSON 字段格式：{"action":"","vehicle_id":"","tool_name":"","args":{},"timeout_s":20,"reason":""}',
    `当前在线车辆提示：${safeJsonStringify(vehicleHints, 4000)}`,
    selectedVehicleId ? `当前选中车辆：${selectedVehicleId}` : '当前选中车辆：未指定',
    routeCandidates.length
      ? `当前会话路线提示：${safeJsonStringify(
          routeCandidates.map((item) => ({
            route_id: item.route_id,
            names: item.names
          })),
          4000
        )}`
      : '当前会话路线提示：无',
    `用户请求：${message}`
  ].join('\n');

  try {
    const result = await runOpenClawTurn(
      plannerPrompt,
      `${sessionId}-${cloudAgentPlanSessionSuffix}`
    );
    const plan = validateCloudOpsPlan(extractJsonObject(result.reply));
    if (plan) {
      return finalizeCloudOpsPlan(plan, message, contextItems, {
        selectedVehicleId
      });
    }
  } catch (_error) {
    // Fall back to heuristics below.
  }

  return { action: 'none' };
}

async function executeCloudOpsAction(plan, vehicles = []) {
  const inferredVehicleId =
    plan.vehicle_id ||
    inferVehicleIdFromMessage(plan.reason || '', vehicles) ||
    (vehicles.length === 1
      ? String(vehicles[0]?.vehicle_id || vehicles[0]?.plate_number || '').trim()
      : '');

  const vehicleId = inferredVehicleId || plan.vehicle_id;
  const timeout_s = toFiniteInteger(plan.timeout_s, 20, { min: 3, max: 120 });

  if (plan.action === 'none') {
    return {
      ok: true,
      action: 'none',
      endpoint: null,
      request: null,
      data: null
    };
  }

  if (
    ['vehicle_detail', 'tool_list', 'snapshot_request', 'tool_call'].includes(plan.action) &&
    !vehicleId
  ) {
    return {
      ok: false,
      action: plan.action,
      endpoint: null,
      request: null,
      error: 'vehicle_id_required',
      detail: '当前请求需要指定 vehicle_id，但未能从问题中识别到车辆。'
    };
  }

  try {
    if (plan.action === 'list_vehicles') {
      const result = await fetchCloudAgentJson('/api/vehicles');
      return {
        ok: true,
        action: plan.action,
        endpoint: result.url,
        request: null,
        data: result.data
      };
    }

    if (plan.action === 'recent_events') {
      const result = await fetchCloudAgentJson('/api/events');
      return {
        ok: true,
        action: plan.action,
        endpoint: result.url,
        request: null,
        data: result.data
      };
    }

    if (plan.action === 'vehicle_detail') {
      const result = await fetchCloudAgentJson(`/api/vehicles/${encodeURIComponent(vehicleId)}`);
      return {
        ok: true,
        action: plan.action,
        endpoint: result.url,
        request: { vehicle_id: vehicleId },
        data: result.data
      };
    }

    if (plan.action === 'tool_list') {
      const result = await fetchCloudAgentJson(
        `/api/vehicles/${encodeURIComponent(vehicleId)}/tool-list?timeout_s=${timeout_s}`,
        {
          timeoutMs: getCloudAgentToolHttpTimeoutMs(timeout_s)
        }
      );
      return {
        ok: true,
        action: plan.action,
        endpoint: result.url,
        request: { vehicle_id: vehicleId, timeout_s },
        data: result.data
      };
    }

    if (plan.action === 'snapshot_request') {
      const requestBody = { timeout_s };
      if (plan.request_id) {
        requestBody.request_id = plan.request_id;
      }
      const result = await fetchCloudAgentJson(
        `/api/vehicles/${encodeURIComponent(vehicleId)}/snapshot-request`,
        {
          method: 'POST',
          body: requestBody,
          timeoutMs: getCloudAgentToolHttpTimeoutMs(timeout_s)
        }
      );
      const responseOk = result?.data?.response?.ok;
      if (responseOk === false) {
        return {
          ok: false,
          action: plan.action,
          endpoint: result.url,
          request: { vehicle_id: vehicleId, ...requestBody },
          error: 'cloud_snapshot_failed',
          detail: result?.data?.response?.error || 'snapshot_request_failed',
          payload: result.data
        };
      }
      return {
        ok: true,
        action: plan.action,
        endpoint: result.url,
        request: { vehicle_id: vehicleId, ...requestBody },
        data: result.data
      };
    }

    if (plan.action === 'tool_call') {
      const toolName = plan.tool_name || 'health.snapshot';
      const requestBody = {
        args: normalizeCloudOpsArgs(plan.args),
        timeout_s
      };
      if (plan.request_id) {
        requestBody.request_id = plan.request_id;
      }
      const result = await fetchCloudAgentJson(
        `/api/vehicles/${encodeURIComponent(vehicleId)}/tools/${encodeURIComponent(toolName)}`,
        {
          method: 'POST',
          body: requestBody,
          timeoutMs: getCloudAgentToolHttpTimeoutMs(timeout_s)
        }
      );
      const responseOk = result?.data?.response?.ok;
      const toolStatus = String(result?.data?.response?.result?.status || '').trim().toLowerCase();
      if (responseOk === false) {
        return {
          ok: false,
          action: plan.action,
          endpoint: result.url,
          request: { vehicle_id: vehicleId, tool_name: toolName, ...requestBody },
          error: 'cloud_tool_failed',
          detail: result?.data?.response?.error || `${toolName}_failed`,
          payload: result.data
        };
      }
      if (toolName === 'vehicle.clear_collision_stop' && toolStatus === 'error') {
        return {
          ok: false,
          action: plan.action,
          endpoint: result.url,
          request: { vehicle_id: vehicleId, tool_name: toolName, ...requestBody },
          error: 'cloud_tool_failed',
          detail:
            result?.data?.response?.result?.message ||
            result?.data?.response?.result?.detail ||
            'vehicle.clear_collision_stop returned status=error',
          payload: result.data
        };
      }
      return {
        ok: true,
        action: plan.action,
        endpoint: result.url,
        request: { vehicle_id: vehicleId, tool_name: toolName, ...requestBody },
        data: result.data
      };
    }

    return {
      ok: false,
      action: plan.action,
      endpoint: null,
      request: null,
      error: 'unsupported_action',
      detail: `暂不支持动作：${plan.action}`
    };
  } catch (error) {
    return {
      ok: false,
      action: plan.action,
      endpoint: error.endpoint || null,
      request:
        plan.action === 'tool_call'
          ? {
              vehicle_id: vehicleId,
              request_id: plan.request_id,
              tool_name: plan.tool_name,
              args: normalizeCloudOpsArgs(plan.args),
              timeout_s
            }
          : vehicleId
            ? { vehicle_id: vehicleId, request_id: plan.request_id, timeout_s }
            : null,
      error: error.status ? `http_${error.status}` : 'cloud_agent_request_failed',
      detail: error.message,
      payload: error.payload || null
    };
  }
}

const mapEditorAllowedGetPaths = new Set([
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/api/status',
  '/api/map-files',
  '/api/routes',
  '/api/envelope',
  '/api/route',
  '/api/route-controls',
  '/api/route-edit',
  '/api/route-preview',
  '/api/route-create',
  '/api/route-delete',
  '/api/pointcloud.bin'
]);
const mapEditorAllowedPostPaths = new Set([
  '/api/envelope',
  '/api/route-edit',
  '/api/route-preview',
  '/api/route-create',
  '/api/route-delete'
]);
const mapEditorBinaryPaths = new Set(['/api/pointcloud.bin']);
const mapEditorLargeJsonPaths = new Set([
  '/api/route',
  '/api/route-edit',
  '/api/route-preview',
  '/api/route-create',
  '/api/route-delete'
]);

function normalizeMapEditorPath(value) {
  const pathValue = String(value || '/').trim() || '/';
  const normalized = pathValue.startsWith('/') ? pathValue : `/${pathValue}`;
  if (
    normalized.includes('\0') ||
    normalized.includes('\\') ||
    normalized.includes('//') ||
    normalized.split('/').includes('..')
  ) {
    return '';
  }
  return normalized;
}

function getMapEditorMaxResponseBytes(editorPath) {
  if (mapEditorBinaryPaths.has(editorPath)) {
    return 12 * 1024 * 1024;
  }
  if (mapEditorLargeJsonPaths.has(editorPath)) {
    return 12 * 1024 * 1024;
  }
  return 2 * 1024 * 1024;
}

function getMapEditorHeader(headers, key) {
  if (!headers || typeof headers !== 'object') {
    return '';
  }
  const target = String(key || '').toLowerCase();
  const match = Object.entries(headers).find(
    ([headerKey]) => String(headerKey || '').toLowerCase() === target
  );
  return match ? String(match[1] || '') : '';
}

function unwrapMapEditorToolResult(execution) {
  return (
    execution?.data?.response?.result ||
    execution?.data?.result ||
    execution?.payload?.response?.result ||
    null
  );
}

function getCloudAgentToolHttpTimeoutMs(timeout_s) {
  const seconds = Number(timeout_s);
  const timeoutMs = Number.isFinite(seconds)
    ? Math.ceil(seconds * 1000) + 8000
    : cloudAgentTimeoutMs;
  return Math.max(cloudAgentTimeoutMs, timeoutMs);
}

async function executeMapEditorTool(vehicleId, toolName, args = {}, timeout_s = 30) {
  return executeCloudOpsAction(
    {
      action: 'tool_call',
      vehicle_id: vehicleId,
      tool_name: toolName,
      args,
      timeout_s,
      request_id: `map-editor-${toolName.replace(/\W+/g, '-')}-${Date.now().toString(36)}`
    },
    []
  );
}

function renderCloudOpsFallbackReply(_message, execution) {
  if (!execution?.ok) {
    if (
      execution?.error === 'http_404' &&
      /is not connected/i.test(String(execution?.detail || ''))
    ) {
      const vehicleId = execution?.request?.vehicle_id || '该车辆';
      return `${vehicleId} 当前不在线，云端 Agent 现在拿不到它的实时连接状态。`;
    }
    return `我已经尝试执行云端运维查询，但接口返回失败：${execution?.detail || execution?.error || 'unknown error'}。`;
  }

  if (execution.action === 'list_vehicles') {
    const vehicles = Array.isArray(execution?.data?.vehicles) ? execution.data.vehicles : [];
    if (!vehicles.length) {
      return '当前没有在线车辆。';
    }
    return `当前在线车辆有 ${vehicles.length} 台：${vehicles
      .map((vehicle) => {
        const vehicleId = vehicle?.vehicle_id || vehicle?.plate_number || 'unknown';
        const lastSeen = vehicle?.last_seen ? `（最近在线 ${vehicle.last_seen}）` : '';
        return `${vehicleId}${lastSeen}`;
      })
      .filter(Boolean)
      .join('、')}。`;
  }

  if (execution.action === 'recent_events') {
    const events = Array.isArray(execution?.data?.events) ? execution.data.events : [];
    if (!events.length) {
      return '当前没有最近事件。';
    }
    const latest = events.slice(-3).map((event) => `${event.event || 'event'}(${event.vehicle_id || '-'})`);
    return `最近事件共有 ${events.length} 条，最新包括：${latest.join('、')}。`;
  }

  if (execution.action === 'vehicle_detail') {
    const vehicle = execution?.data?.vehicle || {};
    const heartbeat = vehicle?.heartbeat || {};
    const parts = [
      `${vehicle?.vehicle_id || vehicle?.plate_number || '该车辆'} 当前在线。`,
      vehicle?.last_seen ? `最近上报时间是 ${vehicle.last_seen}。` : '',
      Number.isFinite(heartbeat?.cpu_percent)
        ? `CPU ${heartbeat.cpu_percent}% ，内存 ${heartbeat?.memory_percent ?? '-'}% ，磁盘 ${heartbeat?.disk_percent ?? '-'}%。`
        : '',
      Number.isFinite(heartbeat?.topic_count)
        ? `ROS 话题 ${heartbeat.topic_count} 个，节点 ${heartbeat?.node_count ?? '-'} 个，服务 ${heartbeat?.service_count ?? '-'} 个。`
        : '',
      heartbeat?.master_ping_ok === true ? '主控连通正常。' : heartbeat?.master_ping_ok === false ? '主控连通异常。' : ''
    ].filter(Boolean);
    return parts.join('');
  }

  if (execution.action === 'tool_list') {
    const tools = Array.isArray(execution?.data?.response?.tools) ? execution.data.response.tools : [];
    if (!tools.length) {
      return `${execution?.request?.vehicle_id || '该车辆'} 当前没有返回可用工具列表。`;
    }
    return `${execution?.request?.vehicle_id || '该车辆'} 当前可用工具共有 ${tools.length} 个，常见包括：${tools
      .slice(0, 8)
      .map((tool) => tool?.name || '-')
      .filter(Boolean)
      .join('、')}。`;
  }

  if (execution.action === 'tool_call') {
    const toolName = execution?.request?.tool_name || execution?.data?.tool || 'tool.call';
    const result = execution?.data?.response?.result || execution?.data?.response || null;
    const listItems = pickCloudOpsList(result);
    if (toolName === 'health.snapshot' && result && typeof result === 'object') {
      const parts = [
        `${execution?.request?.vehicle_id || '该车辆'} 的健康快照已返回。`,
        Number.isFinite(result?.cpu_percent)
          ? `CPU ${result.cpu_percent}% ，内存 ${result?.memory_percent ?? '-'}% ，磁盘 ${result?.disk_percent ?? '-'}%。`
          : '',
        Number.isFinite(result?.topic_count)
          ? `ROS 话题 ${result.topic_count} 个，节点 ${result?.node_count ?? '-'} 个，服务 ${result?.service_count ?? '-'} 个。`
          : ''
      ].filter(Boolean);
      return parts.join('');
    }
    if (toolName === 'network.master_probe' && result && typeof result === 'object') {
      const masterOk = result?.master_ping_ok ?? result?.ping_ok;
      const sshOk = result?.ssh?.ok ?? result?.include_ssh_ok ?? null;
      return [
        `${execution?.request?.vehicle_id || '该车辆'} 的主控连通性结果已返回。`,
        masterOk === true ? '主控 ping 正常。' : masterOk === false ? '主控 ping 异常。' : '',
        sshOk === true ? 'SSH 正常。' : sshOk === false ? 'SSH 异常。' : ''
      ]
        .filter(Boolean)
        .join('');
    }
    if (toolName === 'network.cloud_probe' && result && typeof result === 'object') {
      const tcpOk = result?.tcp?.ok;
      const wsOk = result?.websocket_handshake?.ok;
      return [
        `${execution?.request?.vehicle_id || '该车辆'} 的云端连通性已返回。`,
        tcpOk === true ? '云端 TCP 连通正常。' : tcpOk === false ? '云端 TCP 连通异常。' : '',
        wsOk === true
          ? 'WebSocket 握手正常。'
          : wsOk === false
            ? `WebSocket 握手异常：${result?.websocket_handshake?.error || 'unknown'}。`
            : ''
      ]
        .filter(Boolean)
        .join('');
    }
    if (toolName === 'process.top' && listItems.length) {
      return `${execution?.request?.vehicle_id || '该车辆'} 的高负载进程已返回，前几项包括：${formatCloudOpsPreviewList(
        listItems,
        (item) =>
          item?.name || item?.process || item?.cmd
            ? `${item?.name || item?.process || item?.cmd}(${item?.cpu_percent ?? item?.memory_percent ?? '-'})`
            : '',
        5
      )}。`;
    }
    if (toolName === 'ros.overview' && result && typeof result === 'object') {
      return [
        `${execution?.request?.vehicle_id || '该车辆'} 的 ROS 总览已返回。`,
        Number.isFinite(result?.topic_count)
          ? `话题 ${result.topic_count} 个，节点 ${result?.node_count ?? '-'} 个，服务 ${result?.service_count ?? '-'} 个。`
          : '',
        Array.isArray(result?.categories) && result.categories.length
          ? `主要类别包括：${result.categories.slice(0, 6).join('、')}。`
          : ''
      ]
        .filter(Boolean)
        .join('');
    }
    if (toolName === 'ros.topic.list' && listItems.length) {
      return `${execution?.request?.vehicle_id || '该车辆'} 当前匹配到 ${listItems.length} 个话题，前几个是：${formatCloudOpsPreviewList(
        listItems,
        (item) => item?.topic || item?.name || '',
        6
      )}。`;
    }
    if (toolName === 'ros.node.list' && listItems.length) {
      return `${execution?.request?.vehicle_id || '该车辆'} 当前匹配到 ${listItems.length} 个 ROS 节点，前几个是：${formatCloudOpsPreviewList(
        listItems,
        (item) => item?.node || item?.name || item,
        6
      )}。`;
    }
    if (toolName === 'ros.service.list' && listItems.length) {
      return `${execution?.request?.vehicle_id || '该车辆'} 当前匹配到 ${listItems.length} 个 ROS 服务，前几个是：${formatCloudOpsPreviewList(
        listItems,
        (item) => item?.service || item?.name || item,
        6
      )}。`;
    }
    if (toolName === 'ros.topic.sample' && result && typeof result === 'object') {
      const sampledTopic = execution?.request?.args?.topic || result?.topic || result?.requested_topic || '目标话题';
      return `${execution?.request?.vehicle_id || '该车辆'} 的话题采样已返回，目标是 ${sampledTopic}。如需我继续解释字段，可以直接追问。`;
    }
    if (toolName === 'ros.topic.rate' && result && typeof result === 'object') {
      return `${execution?.request?.vehicle_id || '该车辆'} 的话题频率已返回，${
        execution?.request?.args?.topic || result?.topic || '目标话题'
      } 观测频率大约 ${result?.estimated_hz ?? '-'} Hz，消息数 ${result?.message_count ?? '-'}。`;
    }
    if (toolName === 'ros.diagnostics' && listItems.length) {
      return `${execution?.request?.vehicle_id || '该车辆'} 的诊断摘要已返回，共 ${listItems.length} 条诊断项。你可以继续让我展开异常项。`;
    }
    if (toolName === 'vehicle.snapshot' && result && typeof result === 'object') {
      const health = result?.health || {};
      const cloud = result?.cloud || {};
      const master = result?.master || {};
      const ros = result?.ros || {};
      const identity = result?.identity || {};
      return [
        `${execution?.request?.vehicle_id || '该车辆'} 的整车快照已返回。`,
        identity?.local_primary_ip || identity?.master_host
          ? `本机 ${identity?.local_primary_ip || '-'}，主控 ${identity?.master_host || '-'}。`
          : '',
        Number.isFinite(health?.cpu_percent)
          ? `整车资源 CPU ${health.cpu_percent}% / 内存 ${health?.memory_percent ?? '-'}% / 磁盘 ${health?.disk_percent ?? '-'}%。`
          : '',
        Number.isFinite(health?.topic_count) || Number.isFinite(ros?.topic_count)
          ? `ROS 规模 ${health?.topic_count ?? ros?.topic_count ?? '-'} Topic / ${
              health?.node_count ?? ros?.node_count ?? '-'
            } Node / ${health?.service_count ?? ros?.service_count ?? '-'} Service。`
          : '',
        master?.ping?.ok != null || master?.ssh?.ok != null || master?.tcp_11311?.ok != null
          ? `主控连通 Ping ${master?.ping?.ok ? '正常' : '异常'} / SSH ${
              (master?.ssh?.ok ?? master?.tcp_22?.ok) ? '正常' : '异常'
            } / ROS ${master?.tcp_11311?.ok ? '正常' : '异常'}。`
          : '',
        cloud?.tcp?.ok != null || cloud?.websocket_handshake?.ok != null
          ? `云端连通 TCP ${cloud?.tcp?.ok ? '正常' : '异常'} / WS ${
              cloud?.websocket_handshake?.ok ? '正常' : '异常'
            }。`
          : ''
      ]
        .filter(Boolean)
        .join('');
    }
    if (toolName === 'system.snapshot' && result && typeof result === 'object') {
      const cpu = result?.cpu || {};
      const memory = result?.memory || {};
      const diskRoot = result?.disk_root || {};
      return [
        `${execution?.request?.vehicle_id || '该车辆'} 的系统快照已返回。`,
        result?.hostname ? `主机 ${result.hostname}，运行时长 ${formatCloudOpsDurationBrief(result?.uptime_seconds)}。` : '',
        Number.isFinite(cpu?.percent)
          ? `CPU ${cpu.percent}% ，内存 ${memory?.percent ?? '-'}% ，磁盘 ${diskRoot?.percent ?? '-'}%。`
          : '',
        Number.isFinite(cpu?.loadavg_1m)
          ? `Load Average ${cpu.loadavg_1m}/${cpu?.loadavg_5m ?? '-'}/${cpu?.loadavg_15m ?? '-'}。`
          : '',
        Number.isFinite(memory?.used_bytes) || Number.isFinite(diskRoot?.free_bytes)
          ? `内存已用 ${formatCloudOpsHumanBytes(memory?.used_bytes)}，磁盘剩余 ${formatCloudOpsHumanBytes(
              diskRoot?.free_bytes
            )}。`
          : '',
        Array.isArray(result?.top_cpu_processes) && result.top_cpu_processes.length
          ? `高负载进程前几项包括：${result.top_cpu_processes
              .slice(0, 3)
              .map((item) => item?.name || item?.cmd || '-')
              .join('、')}。`
          : ''
      ]
        .filter(Boolean)
        .join('');
    }
    if (toolName === 'status.catalog' && result && typeof result === 'object') {
      const subsystems = Array.isArray(result?.subsystems) ? result.subsystems : [];
      return `${execution?.request?.vehicle_id || '该车辆'} 的系统能力目录已返回，共 ${
        subsystems.length
      } 个子系统，主要包括：${subsystems
        .map((item) => item?.name || item?.tool || '')
        .filter(Boolean)
        .slice(0, 8)
        .join('、')}。`;
    }
    if (toolName === 'status.key_nodes' && result && typeof result === 'object') {
      const nodes = pickCloudOpsList(result);
      const offlineNodes = nodes
        .filter((item) => item?.online === false || item?.ok === false)
        .map((item) => item?.node || item?.name || item?.id || '')
        .filter(Boolean);
      return `${execution?.request?.vehicle_id || '该车辆'} 的关键节点状态已返回。${
        offlineNodes.length ? `当前异常节点有 ${offlineNodes.join('、')}。` : '当前关键节点全部在线。'
      }`;
    }
    if (toolName === 'health.autodrive_check' && result && typeof result === 'object') {
      const healthSummary = result?.summary || result;
      const checks = result?.checks || {};
      const lidarRefs = result?.status_refs?.lidar_topics || {};
      const frontLidar = checks?.front_laser_topic_output?.ok;
      const backLidar = checks?.back_laser_topic_output?.ok;
      const topLidar = checks?.top_lidar_topic_output?.ok;
      return [
        `${execution?.request?.vehicle_id || '该车辆'} 的一键健康检查已返回。`,
        healthSummary?.ready_to_patrol === true || healthSummary?.can_start_patrol === true
          ? '当前判断可以启航。'
          : healthSummary?.ready_to_patrol === false || healthSummary?.can_start_patrol === false
            ? '当前判断仍需排查后再启航。'
            : '',
        healthSummary?.localization_ok === false || healthSummary?.localization_reliable === false
          ? '定位可靠性存在问题。'
          : '',
        healthSummary?.routing_ok === false || healthSummary?.has_available_route === false
          ? '当前没有可用路线。'
          : '',
        frontLidar !== undefined || backLidar !== undefined || topLidar !== undefined
          ? `三路激光 topic 检查：前激光${frontLidar === true ? '正常' : frontLidar === false ? '异常' : '未知'}、后激光${
              backLidar === true ? '正常' : backLidar === false ? '异常' : '未知'
            }、顶激光${topLidar === true ? '正常' : topLidar === false ? '异常' : '未知'}。`
          : '',
        lidarRefs?.ready !== undefined
          ? `激光 topic 汇总 ${lidarRefs.ready ? '已就绪' : '未就绪'}。`
          : ''
      ]
        .filter(Boolean)
        .join('');
    }
    if (toolName === 'route.list') {
      if (!listItems.length) {
        return `${execution?.request?.vehicle_id || '该车辆'} 当前没有返回可用路线。`;
      }
      return `${execution?.request?.vehicle_id || '该车辆'} 当前共有 ${listItems.length} 条路线，前几个是：${formatCloudOpsPreviewList(
        listItems,
        (item) => item?.name || item?.route_id || '',
        6
      )}。`;
    }
    if (toolName === 'status.routing' && result && typeof result === 'object') {
      return `${execution?.request?.vehicle_id || '该车辆'} 的 routing 状态已返回。当前路线 ${
        result?.current_route_id || result?.active_route_id || '未指定'
      }，可用路线 ${result?.available_route_count ?? result?.route_count ?? listItems.length ?? 0} 条。`;
    }
    if (toolName === 'route.detail' && result && typeof result === 'object') {
      return `${execution?.request?.vehicle_id || '该车辆'} 的路线详情已返回，路线 ${
        result?.name || execution?.request?.args?.route_id || '-'
      } 长度 ${result?.len ?? result?.length ?? '-'}，时长 ${result?.duration ?? '-'}。`;
    }
    if (toolName === 'route.start_patrol') {
      return `${execution?.request?.vehicle_id || '该车辆'} 的巡逻启动请求已返回，路线 ${
        execution?.request?.args?.route_id || '-'
      }，圈数 ${execution?.request?.args?.loops ?? '-'}，速度 ${execution?.request?.args?.speed_kph ?? '-'} km/h，${
        execution?.request?.args?.dry_run ? '当前是 dry-run 预演。' : '当前为正式执行。'
      }`;
    }
    if (toolName === 'route.stop_patrol') {
      return `${execution?.request?.vehicle_id || '该车辆'} 的停止巡逻请求已返回。`;
    }
    if (toolName === 'camera.capture' && result && typeof result === 'object') {
      const captureItems = pickCloudOpsList(result);
      return `${execution?.request?.vehicle_id || '该车辆'} 的相机抓拍已返回，共 ${
        captureItems.length || result?.capture_count || 0
      } 张图像。`;
    }
    if (toolName === 'map.preview' && result && typeof result === 'object') {
      const mapInfo = result?.map || {};
      const pose = result?.vehicle_pose || {};
      return [
        `${execution?.request?.vehicle_id || '该车辆'} 的地图预览已返回。`,
        mapInfo?.path ? `地图文件 ${mapInfo.path}。` : '',
        Number.isFinite(mapInfo?.extent?.width_m) && Number.isFinite(mapInfo?.extent?.height_m)
          ? `范围约 ${mapInfo.extent.width_m}m × ${mapInfo.extent.height_m}m。`
          : '',
        pose?.source ? `定位来源 ${pose.source}。` : '',
        pose?.draw_vehicle === true ? '已叠加自车位置与朝向。' : '',
        pose?.reliable === false ? '当前定位可靠性不足。' : pose?.reliable === true ? '当前定位可靠。' : ''
      ]
        .filter(Boolean)
        .join('');
    }
    if (toolName === 'camera.upload_chain' && result && typeof result === 'object') {
      return `${execution?.request?.vehicle_id || '该车辆'} 的相机上传链路已返回。整体状态 ${
        result?.health || result?.status || '未知'
      }，可以继续追问是驱动异常还是上传异常。`;
    }
    if (toolName === 'status.can' && result && typeof result === 'object') {
      const canSummary = result?.summary || {};
      return [
        `${execution?.request?.vehicle_id || '该车辆'} 的底盘/CAN 状态已返回。`,
        canSummary?.battery_soc != null ? `电量 ${canSummary.battery_soc}% 。` : '',
        canSummary?.speed != null ? `当前速度 ${canSummary.speed} m/s。` : '',
        canSummary?.emergency_stop_pressed != null
          ? `急停 ${canSummary.emergency_stop_pressed ? '触发' : '正常'}。`
          : '',
        canSummary?.collision_stop != null
          ? `碰撞停 ${canSummary.collision_stop ? '触发' : '正常'}。`
          : ''
      ]
        .filter(Boolean)
        .join('');
    }
    if (toolName === 'status.body_control' && result && typeof result === 'object') {
      const summary = result?.summary || {};
      const planningIntent = summary?.planning_intent || {};
      const controlCommand = summary?.control_command || {};
      const vehicleFeedback = summary?.vehicle_feedback || {};
      return [
        `${execution?.request?.vehicle_id || '该车辆'} 的车身控制状态已返回。`,
        `广告屏 规划${planningIntent?.ad_screen ? '开' : '关'} / 指令${controlCommand?.ad_screen ? '开' : '关'} / 反馈${vehicleFeedback?.ad_screen_on ? '开' : '关'}。`,
        `前照灯 规划${planningIntent?.front_lamp ? '开' : '关'} / 指令${controlCommand?.front_lamp ? '开' : '关'} / 反馈${vehicleFeedback?.front_lamp_on ? '开' : '关'}。`,
        `氛围灯 规划${planningIntent?.mood_lamp ? '开' : '关'} / 指令${controlCommand?.mood_lamp ? '开' : '关'} / 反馈${vehicleFeedback?.mood_lamp_on ? '开' : '关'}。`,
        `转向灯当前为 ${vehicleFeedback?.steer_lamp_mode || controlCommand?.steer_lamp_mode || 'off'}。`
      ]
        .filter(Boolean)
        .join('');
    }
    if (toolName === 'vehicle.body_control' && result && typeof result === 'object') {
      const status = String(result?.status || '').trim().toLowerCase();
      const request = result?.request || {};
      const afterSummary = result?.after?.summary || {};
      const vehicleFeedback = afterSummary?.vehicle_feedback || {};
      const requested = [
        request?.ad_screen !== null && request?.ad_screen !== undefined
          ? `广告屏${request.ad_screen ? '开' : '关'}`
          : '',
        request?.front_lamp !== null && request?.front_lamp !== undefined
          ? `前照灯${request.front_lamp ? '开' : '关'}`
          : '',
        request?.mood_lamp !== null && request?.mood_lamp !== undefined
          ? `氛围灯${request.mood_lamp ? '开' : '关'}`
          : '',
        request?.steer_lamp_mode || request?.steer_lamp
          ? `转向灯${request?.steer_lamp_mode || request?.steer_lamp}`
          : ''
      ].filter(Boolean);
      return [
        `${execution?.request?.vehicle_id || '该车辆'} 的车身控制结果已返回。`,
        status === 'applied'
          ? '车身控制已真正执行成功。'
          : status === 'partial'
            ? '控制指令已送达，但车端只完成了部分确认。'
          : status === 'noop'
            ? '请求已送达，但车身状态未变化。'
            : status === 'error'
              ? '车身控制执行失败。'
              : '',
        requested.length ? `本次请求是：${requested.join('、')}。` : '',
        `当前反馈：广告屏${vehicleFeedback?.ad_screen_on ? '开' : '关'}、前照灯${
          vehicleFeedback?.front_lamp_on ? '开' : '关'
        }、氛围灯${vehicleFeedback?.mood_lamp_on ? '开' : '关'}、转向灯${
          vehicleFeedback?.steer_lamp_mode || 'off'
        }。`,
        result?.message ? `接口说明：${result.message}` : ''
      ]
        .filter(Boolean)
        .join('');
    }
    if (toolName === 'vehicle.clear_collision_stop' && result && typeof result === 'object') {
      const status = String(result?.status || '').trim().toLowerCase();
      const detail = result?.message || result?.detail || '';
      return [
        `${execution?.request?.vehicle_id || '该车辆'} 的碰撞停复位结果已返回。`,
        status === 'cleared'
          ? '当前碰撞停已经清除，车端已按安全序列先停巡逻、复位后再次补发 STOP 并完成复核。'
          : status === 'noop'
            ? '当前碰撞停原本就没有触发，因此没有执行实际复位。'
            : status === 'error'
              ? '碰撞停复位未通过安全校验。'
              : '',
        detail ? `接口说明：${detail}` : ''
      ]
        .filter(Boolean)
        .join('');
    }
    if (toolName === 'status.camera' && result && typeof result === 'object') {
      return `${execution?.request?.vehicle_id || '该车辆'} 的相机状态已返回。当前在线 ${
        result?.online_camera_count ?? 0
      } / ${result?.expected_camera_count ?? listItems.length} 路，${
        Array.isArray(result?.offline_cameras) && result.offline_cameras.length
          ? `离线相机有 ${result.offline_cameras.join('、')}。`
          : '当前没有离线相机。'
      }`;
    }
    if (toolName === 'ai_detection.config' && result && typeof result === 'object') {
      const openEvents = Array.isArray(result?.events_open) ? result.events_open : [];
      const closedEvents = Array.isArray(result?.events_closed) ? result.events_closed : [];
      return [
        `${execution?.request?.vehicle_id || '该车辆'} 的 AI 检测配置已返回。`,
        result?.service_position ? `当前服务位置：${result.service_position}。` : '',
        result?.interval_s != null ? `检测间隔 ${result.interval_s} 秒。` : '',
        openEvents.length ? `已启用 ${openEvents.length} 类事件：${openEvents.slice(0, 8).join('、')}。` : '',
        closedEvents.length ? `关闭事件：${closedEvents.join('、')}。` : '',
        result?.qwen?.enabled != null ? `Qwen校验：${result.qwen.enabled ? '开启' : '关闭'}。` : ''
      ]
        .filter(Boolean)
        .join('');
    }
    if (toolName === 'ai_detection.images' && result && typeof result === 'object') {
      const images = Array.isArray(result?.images) ? result.images : [];
      return [
        `${execution?.request?.vehicle_id || '该车辆'} 的 AI 检测落盘图片已返回。`,
        `当前目录共有 ${result?.total_files ?? images.length ?? 0} 张。`,
        images.length ? `本次返回 ${images.length} 张，页面可直接查看。` : '当前目录暂无落盘图片。',
        result?.save_path ? `目录：${result.save_path}。` : ''
      ]
        .filter(Boolean)
        .join('');
    }
    if (toolName === 'status.localization' && result && typeof result === 'object') {
      const localizationSummary = result?.summary || {};
      return [
        `${execution?.request?.vehicle_id || '该车辆'} 的定位状态已返回。`,
        localizationSummary?.reliable === true
          ? '当前定位可靠。'
          : localizationSummary?.reliable === false
            ? '当前定位不可靠。'
            : '',
        localizationSummary?.speed_mps != null
          ? `当前速度 ${localizationSummary.speed_mps} m/s。`
          : '',
        localizationSummary?.latitude != null && localizationSummary?.longitude != null
          ? `经纬度 ${localizationSummary.latitude}, ${localizationSummary.longitude}。`
          : ''
      ]
        .filter(Boolean)
        .join('');
    }
    if (toolName === 'status.planning' && result && typeof result === 'object') {
      const planningSummary = result?.summary || {};
      return [
        `${execution?.request?.vehicle_id || '该车辆'} 的规划状态已返回。`,
        planningSummary?.planner_state ? `规划状态 ${planningSummary.planner_state}。` : '',
        planningSummary?.current_scenario != null ? `当前场景 ${planningSummary.current_scenario}。` : '',
        planningSummary?.current_action != null ? `当前动作 ${planningSummary.current_action}。` : '',
        planningSummary?.trajectory_point_count != null
          ? `轨迹点数 ${planningSummary.trajectory_point_count}。`
          : '',
        planningSummary?.trajectory_estop != null
          ? `轨迹 estop=${planningSummary.trajectory_estop}。`
          : ''
      ]
        .filter(Boolean)
        .join('');
    }
    if (toolName === 'status.control' && result && typeof result === 'object') {
      const controlSummary = result?.summary || {};
      const requiredInputs = controlSummary?.required_inputs || {};
      const missingInputs = Object.keys(requiredInputs).filter((key) => requiredInputs[key] === false);
      return `${execution?.request?.vehicle_id || '该车辆'} 的控制链路状态已返回。${
        missingInputs.length ? `缺少输入 ${missingInputs.join('、')}。` : '控制输入齐全。'
      }目标速度 ${controlSummary?.target_speed ?? '-'} m/s，档位 ${controlSummary?.gear_cmd ?? '-'}。`;
    }
    if (toolName === 'status.obstacle_processor' && result && typeof result === 'object') {
      const obstacleSummary = result?.summary || result;
      return `${execution?.request?.vehicle_id || '该车辆'} 的障碍处理状态已返回。融合目标 ${
        obstacleSummary?.fusion_object_count ?? obstacleSummary?.object_count ?? 0
      } 个，链路状态 ${obstacleSummary?.health || obstacleSummary?.status || '未知'}。`;
    }
    if (toolName === 'obstacle.preview' && result && typeof result === 'object') {
      const summary = result?.summary || {};
      const preview = result?.preview || {};
      return [
        `${execution?.request?.vehicle_id || '该车辆'} 的障碍俯视图已返回。`,
        summary?.object_count != null ? `障碍物 ${summary.object_count} 个。` : '',
        summary?.drawn_obstacle_count != null ? `已绘制 ${summary.drawn_obstacle_count} 个 box。` : '',
        summary?.frame_id ? `坐标系 ${summary.frame_id}。` : '',
        summary?.topic ? `来源话题 ${summary.topic}。` : '',
        preview?.data_base64 ? '页面可直接查看俯视图。' : ''
      ]
        .filter(Boolean)
        .join('');
    }
    if (toolName === 'status.perception' && result && typeof result === 'object') {
      const perceptionSummary = result?.summary || {};
      return `${execution?.request?.vehicle_id || '该车辆'} 的感知链路状态已返回。融合目标 ${
        perceptionSummary?.fusion_object_count ?? 0
      } 个，人群 ${
        perceptionSummary?.crowd_people ?? 0
      } 个，挥手目标 ${perceptionSummary?.handwave_object_count ?? 0} 个。`;
    }
    return `我已经执行了工具 ${toolName}，接口已返回结果。你可以继续让我解释其中的关键字段。`;
  }

  if (execution.action === 'snapshot_request') {
    return `${execution?.request?.vehicle_id || '该车辆'} 的即时快照请求已经发出，并且接口已返回结果。`;
  }

  return `我已经执行了运维动作 ${execution.action}，可以继续追问更具体的车辆状态、工具结果或最近事件。`;
}

function buildCloudOpsModelPayload(execution) {
  if (!execution?.ok) {
    return execution;
  }

  const data = execution.data || {};

  if (execution.action === 'list_vehicles') {
    const vehicles = Array.isArray(data.vehicles) ? data.vehicles : [];
    return {
      action: execution.action,
      vehicles: vehicles.map((vehicle) => ({
        vehicle_id: vehicle?.vehicle_id || null,
        plate_number: vehicle?.plate_number || null,
        vin: vehicle?.vin || null,
        connected_at: vehicle?.connected_at || null,
        last_seen: vehicle?.last_seen || null,
        tool_count: vehicle?.tool_count ?? null,
        has_heartbeat: vehicle?.has_heartbeat ?? null,
        has_snapshot: vehicle?.has_snapshot ?? null
      })),
      ts: data.ts || null
    };
  }

  if (execution.action === 'recent_events') {
    const events = Array.isArray(data.events) ? data.events : [];
    return {
      action: execution.action,
      events: events.slice(-20).map((event) => ({
        event: event?.event || null,
        ts: event?.ts || null,
        vehicle_id: event?.vehicle_id || null,
        session_id: event?.session_id || null,
        message_type: event?.message_type || null,
        request_id: event?.request_id || null
      }))
    };
  }

  if (execution.action === 'vehicle_detail') {
    const vehicle = data.vehicle || {};
    return {
      action: execution.action,
      vehicle: {
        vehicle_id: vehicle?.vehicle_id || null,
        plate_number: vehicle?.plate_number || null,
        vin: vehicle?.vin || null,
        role: vehicle?.role || null,
        connected_at: vehicle?.connected_at || null,
        last_seen: vehicle?.last_seen || null,
        tool_count: vehicle?.tool_count ?? null,
        last_error: vehicle?.last_error || null,
        heartbeat: vehicle?.heartbeat || null,
        snapshot: vehicle?.snapshot || null
      }
    };
  }

  if (execution.action === 'tool_list') {
    const tools = Array.isArray(data?.response?.tools) ? data.response.tools : [];
    return {
      action: execution.action,
      tools: tools.map((tool) => ({
        name: tool?.name || null,
        description: tool?.description || null,
        args_schema: tool?.args_schema || null
      })),
      ts: data.ts || null
    };
  }

  if (execution.action === 'snapshot_request') {
    return {
      action: execution.action,
      response: data?.response || null,
      ts: data?.ts || null
    };
  }

  if (execution.action === 'tool_call') {
    return {
      action: execution.action,
      tool: data?.tool || execution?.request?.tool_name || null,
      response: data?.response || null,
      ts: data?.ts || null
    };
  }

  return execution;
}

async function summarizeCloudOpsResult(message, execution, sessionId) {
  const modelPayload = buildCloudOpsModelPayload(execution);
  const summaryPrompt = [
    '你是云端智能运维助手。',
    '请基于下面的云控接口执行结果，直接用中文回答用户。',
    '不要编造接口里没有的信息。',
    '如果接口失败，明确告诉用户失败原因。',
    '如果是车辆列表，优先给出在线车辆数量和 vehicle_id。',
    '如果是单车详情或工具结果，优先提炼状态、时间、关键字段和异常点。',
    '回答尽量简洁，2 到 6 句即可。',
    `用户原始请求：${message}`,
    `执行结果：${safeJsonStringify(modelPayload, 8000)}`
  ].join('\n');

  try {
    return await runOpenClawTurn(
      summaryPrompt,
      `${sessionId}-${cloudAgentAnswerSessionSuffix}`
    );
  } catch (_error) {
    return {
      reply: renderCloudOpsFallbackReply(message, execution),
      latency_ms: null,
      provider: 'cloud-agent-fallback',
      model: null
    };
  }
}

async function runOpenClawOpsTurn(message, sessionId, options = {}) {
  const startedAt = Date.now();
  const rawMessage = normalizeReply(message);
  const selectedVehicleId = normalizeReply(options?.vehicle_id || '');
  const contextItems = normalizeOpenClawContextItems(options?.context_items);
  const effectiveMessage = buildOpenClawContextMessage(rawMessage, {
    vehicle_id: selectedVehicleId,
    context_items: contextItems
  });
  const cloudAgentHealth = await probeCloudAgent();

  if (!cloudAgentHealth.ok) {
    const baseResult = await runOpenClawTurn(effectiveMessage, sessionId);
    return {
      ...baseResult,
      cloud_ops: {
        enabled: false,
        base_url: cloudAgentBaseUrl,
        detail: cloudAgentHealth.detail || 'cloud_agent_unavailable'
      }
    };
  }

  const vehicles = await listCloudAgentVehicles().catch(() => []);
  const plan = await planCloudOpsAction(rawMessage, sessionId, vehicles, {
    selectedVehicleId,
    contextItems
  });

  if (!plan || plan.action === 'none') {
    const baseResult = await runOpenClawTurn(effectiveMessage, sessionId);
    return {
      ...baseResult,
      cloud_ops: {
        enabled: true,
        used: false,
        plan
      }
    };
  }

  if (!plan.vehicle_id && selectedVehicleId) {
    plan.vehicle_id = selectedVehicleId;
  }

  if (!plan.vehicle_id && vehicles.length === 1) {
    plan.vehicle_id = String(vehicles[0]?.vehicle_id || vehicles[0]?.plate_number || '').trim();
  }

  const execution = await executeCloudOpsAction(plan, vehicles);
  const summary = await summarizeCloudOpsResult(rawMessage, execution, sessionId);

  return {
    reply: summary.reply,
    latency_ms: Date.now() - startedAt,
    provider: 'openclaw-cloud-ops',
    model: summary.model || null,
    cloud_ops: {
      enabled: true,
      used: true,
      plan,
      execution
    }
  };
}

async function readOpenClawConfig() {
  const content = await fs.readFile(openClawConfigPath, 'utf-8');
  return JSON.parse(content);
}

function normalizeOpenClawSessionSegment(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function buildOpenClawSessionKey(sessionId) {
  const agentId = normalizeOpenClawSessionSegment(openClawAgentId) || 'main';
  const key = normalizeOpenClawSessionSegment(sessionId) || 'main';
  return `agent:${agentId}:${key}`;
}

function extractOpenClawReply(message) {
  if (!message || typeof message !== 'object') {
    return '';
  }

  if (typeof message.text === 'string') {
    return normalizeReply(message.text);
  }

  const blocks = Array.isArray(message.content) ? message.content : [];
  return normalizeReply(
    blocks
      .map((item) => (typeof item?.text === 'string' ? item.text : ''))
      .filter(Boolean)
      .join('\n\n')
  );
}

let openClawGatewaySdkPromise = null;

async function loadOpenClawGatewaySdk() {
  if (!openClawGatewaySdkPromise) {
    openClawGatewaySdkPromise = import(openClawGatewaySdkUrl);
  }
  return openClawGatewaySdkPromise;
}

function createOpenClawGatewayUrl(config) {
  const port = Number(config?.gateway?.port || 18789);
  return `ws://${openClawGatewayHost}:${port}`;
}

function getOpenClawGatewayToken(config) {
  const token = config?.gateway?.auth?.token;
  return typeof token === 'string' && token.trim() ? token.trim() : null;
}

async function connectOpenClawGateway(config, handlers = {}) {
  const token = getOpenClawGatewayToken(config);
  if (!token) {
    throw new Error('openclaw_gateway_token_missing');
  }

  const { u: GatewayClient, r: defaultScopes } = await loadOpenClawGatewaySdk();

  return await new Promise((resolve, reject) => {
    let settled = false;
    let client = null;
    let timeoutId = null;

    const cleanup = async () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      try {
        await client?.stopAndWait?.({ timeoutMs: 5000 });
      } catch (_error) {
        // Ignore close errors from a half-open socket.
      }
    };

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      void cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    client = new GatewayClient({
      url: createOpenClawGatewayUrl(config),
      token,
      clientVersion: 'jgzj/0.1.0',
      mode: 'backend',
      scopes: defaultScopes,
      onHelloOk: () => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        resolve(client);
      },
      onConnectError: fail,
      onClose: (code, reason) => {
        if (!settled) {
          fail(new Error(`openclaw_gateway_closed_${code}:${reason || 'no_reason'}`));
        }
        handlers.onClose?.(code, reason, client);
      },
      onEvent: (event) => {
        handlers.onEvent?.(event, client);
      }
    });

    timeoutId = setTimeout(() => {
      fail(new Error('openclaw_connect_timeout'));
    }, openClawConnectTimeoutMs);
    timeoutId.unref?.();

    client.start();
  });
}

async function probeOpenClaw() {
  try {
    const config = await readOpenClawConfig();
    const client = await connectOpenClawGateway(config);
    const healthResult = await client.request('health', {}, { timeoutMs: 5000 });
    await client.stopAndWait({ timeoutMs: 5000 }).catch(() => {});

    return {
      ok: true,
      detail: healthResult?.ok ? `Gateway Health\nOK (${healthResult.durationMs ?? 0}ms)` : 'Gateway Health\nUnavailable',
      model: config?.agents?.defaults?.model?.primary || null,
      gateway_port: config?.gateway?.port || null,
      auth_mode: config?.gateway?.auth?.mode || null
    };
  } catch (error) {
    return {
      ok: false,
      detail: error.message,
      model: null,
      gateway_port: null,
      auth_mode: null
    };
  }
}

async function runOpenClawTurn(message, sessionId) {
  const config = await readOpenClawConfig();
  const runId = crypto.randomUUID();
  const sessionKey = buildOpenClawSessionKey(sessionId);
  const startedAt = Date.now();
  let client = null;

  return await new Promise(async (resolve, reject) => {
    let finished = false;
    let timeoutId = null;

    const finish = async (error, result) => {
      if (finished) {
        return;
      }
      finished = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      try {
        await client?.stopAndWait?.({ timeoutMs: 5000 });
      } catch (_closeError) {
        // Ignore close failures.
      }

      if (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      resolve(result);
    };

    try {
      client = await connectOpenClawGateway(config, {
        onEvent: (event) => {
          if (event?.event !== 'chat') {
            return;
          }

          const payload = event.payload || {};
          if (payload.runId !== runId) {
            return;
          }

          if (payload.state === 'error') {
            void finish(new Error(payload.errorMessage || 'openclaw_chat_error'));
            return;
          }

          if (payload.state !== 'final' && payload.state !== 'aborted') {
            return;
          }

          const reply = extractOpenClawReply(payload.message);
          if (!reply) {
            void finish(new Error('openclaw_reply_empty'));
            return;
          }

          void finish(null, {
            reply,
            latency_ms: Date.now() - startedAt,
            provider: 'openclaw-gateway',
            model: config?.agents?.defaults?.model?.primary || null
          });
        }
      });

      timeoutId = setTimeout(() => {
        void finish(new Error('openclaw_timeout'));
      }, openClawTimeoutMs);
      timeoutId.unref?.();

      const sendResult = await client.request(
        'chat.send',
        {
          sessionKey,
          message,
          deliver: false,
          idempotencyKey: runId
        },
        { timeoutMs: 10000 }
      );

      if (sendResult?.status && sendResult.status !== 'started') {
        void finish(new Error(`openclaw_send_${sendResult.status}`));
      }
    } catch (error) {
      void finish(error);
    }
  });
}

function normalizeOpenClawContextItems(rawItems) {
  if (!Array.isArray(rawItems)) {
    return [];
  }

  return rawItems
    .slice(-6)
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }

      const label = normalizeReply(item.label || '');
      const summary = normalizeReply(item.summary || '');
      const vehicleId = normalizeReply(item.vehicle_id || '');
      const payload = item.payload && typeof item.payload === 'object' ? item.payload : null;

      if (!label && !summary && !vehicleId && !payload) {
        return null;
      }

      return {
        label: label || null,
        summary: summary || null,
        vehicle_id: vehicleId || null,
        payload
      };
    })
    .filter(Boolean);
}

function buildOpenClawContextMessage(message, options = {}) {
  const cleanedMessage = normalizeReply(message);
  const vehicleId = normalizeReply(options.vehicle_id || '');
  const contextItems = normalizeOpenClawContextItems(options.context_items);

  if (!vehicleId && !contextItems.length) {
    return cleanedMessage;
  }

  const blocks = [
    '下面是当前云端运维会话里，用户已经插入的快捷查询上下文。',
    '如果用户当前问题和这些上下文相关，请优先结合这些结果回答，不要忽略。'
  ];

  if (vehicleId) {
    blocks.push(`当前选中车辆：${vehicleId}`);
  }

  contextItems.forEach((item, index) => {
    const chunk = [`上下文 ${index + 1}`];
    if (item.label) {
      chunk.push(`标题：${item.label}`);
    }
    if (item.vehicle_id) {
      chunk.push(`车辆：${item.vehicle_id}`);
    }
    if (item.summary) {
      chunk.push(`摘要：${item.summary}`);
    }
    if (item.payload) {
      chunk.push(`原始结果：${safeJsonStringify(item.payload, 2400)}`);
    }
    blocks.push(chunk.join('\n'));
  });

  blocks.push(`用户问题：${cleanedMessage}`);
  return blocks.join('\n\n');
}

app.get('/healthz', (_req, res) => {
  res.type('text/plain').send('ok');
});

app.get('/api/health', async (_req, res) => {
  const upstream = await probeUpstream();
  const status = upstream.ok ? 200 : 502;

  res.status(status).json({
    ok: upstream.ok,
    service: 'orchestra-backend',
    upstream_base_url: upstreamBaseUrl,
    upstream_stream_url: upstreamStreamUrl,
    upstream
  });
});

app.get('/api/chat-identities', async (_req, res) => {
  try {
    const identities = await listVehicleIdentities();
    return res.json({
      ok: true,
      default_vehicle_id: defaultVehicleId,
      identities
    });
  } catch (error) {
    return res.json({
      ok: false,
      default_vehicle_id: defaultVehicleId,
      identities: [defaultVehicleId],
      detail: error.message
    });
  }
});

app.get('/api/openclaw-auth-status', (req, res) => {
  const auth = getOpenClawAuthFromRequest(req);
  if (!auth) {
    clearOpenClawAuthCookie(res);
    return res.status(401).json({
      ok: false,
      authenticated: false,
      username: null,
      expires_at_ms: null
    });
  }

  return res.json({
    ok: true,
    authenticated: true,
    username: auth.username,
    expires_at_ms: auth.expires_at_ms
  });
});

app.post('/api/openclaw-login', (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (!isOpenClawLoginValid(username, password)) {
    clearOpenClawAuthCookie(res);
    return res.status(401).json({
      ok: false,
      error: 'openclaw_login_failed'
    });
  }

  const token = issueOpenClawAuthToken(username);
  setOpenClawAuthCookie(res, token);
  return res.json({
    ok: true,
    authenticated: true,
    username,
    expires_at_ms: verifyOpenClawAuthToken(token)?.expires_at_ms || null
  });
});

app.post('/api/openclaw-logout', (_req, res) => {
  clearOpenClawAuthCookie(res);
  return res.json({
    ok: true,
    authenticated: false
  });
});

app.get('/api/openclaw-health', requireOpenClawAuth, async (_req, res) => {
  const [health, cloudAgent] = await Promise.all([probeOpenClaw(), probeCloudAgent()]);
  return res.status(health.ok ? 200 : 502).json({
    ok: health.ok,
    service: 'openclaw-agent-proxy',
    ...health,
    cloud_agent: cloudAgent
  });
});

app.get('/api/cloud-agent-health', requireOpenClawAuth, async (_req, res) => {
  const health = await probeCloudAgent();
  return res.status(health.ok ? 200 : 502).json({
    ok: health.ok,
    service: 'cloud-agent-proxy',
    ...health
  });
});

app.get('/api/cloud-ops/vehicles', async (_req, res) => {
  try {
    const vehicles = await listCloudAgentVehicles();
    return res.json({
      ok: true,
      vehicles
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      detail: error?.message || 'cloud_ops_vehicle_list_failed'
    });
  }
});

app.get('/api/cloud-ops/vehicles/:vehicleId', async (req, res) => {
  const vehicleId = String(req.params?.vehicleId || '').trim();
  if (!vehicleId) {
    return res.status(400).json({
      ok: false,
      detail: 'vehicle_id_required'
    });
  }

  const execution = await executeCloudOpsAction(
    {
      action: 'vehicle_detail',
      vehicle_id: vehicleId,
      timeout_s: 20
    },
    []
  );

  return res.status(execution.ok ? 200 : 502).json({
    ok: execution.ok,
    summary: renderCloudOpsFallbackReply('', execution),
    execution
  });
});

app.get(
  '/api/cloud-ops/vehicles/:vehicleId/tool-list',
  async (req, res) => {
    const vehicleId = String(req.params?.vehicleId || '').trim();
    if (!vehicleId) {
      return res.status(400).json({
        ok: false,
        detail: 'vehicle_id_required'
      });
    }

    const timeout_s = toFiniteInteger(req.query?.timeout_s, 20, { min: 3, max: 120 });
    const execution = await executeCloudOpsAction(
      {
        action: 'tool_list',
        vehicle_id: vehicleId,
        timeout_s
      },
      []
    );

    const tools = Array.isArray(execution?.data?.response?.tools) ? execution.data.response.tools : [];
    return res.status(execution.ok ? 200 : 502).json({
      ok: execution.ok,
      tools,
      summary: renderCloudOpsFallbackReply('', execution),
      execution
    });
  }
);

app.post('/api/cloud-ops/execute', async (req, res) => {
  const vehicles = await listCloudAgentVehicles().catch(() => []);
  const plan = validateCloudOpsPlan(req.body);

  if (!plan) {
    return res.status(400).json({
      ok: false,
      detail: 'invalid_cloud_ops_plan'
    });
  }

  if (!plan.vehicle_id && vehicles.length === 1) {
    plan.vehicle_id = String(vehicles[0]?.vehicle_id || vehicles[0]?.plate_number || '').trim();
  }

  const auth = getOpenClawAuthFromRequest(req);
  if (!auth && !isCloudOpsReadOnlyPlan(plan)) {
    clearOpenClawAuthCookie(res);
    return res.status(401).json({
      ok: false,
      error: 'openclaw_auth_required',
      detail: 'login_required_for_control'
    });
  }

  const execution = await executeCloudOpsAction(plan, vehicles);
  const summary = renderCloudOpsFallbackReply('', execution);

  return res.status(execution.ok ? 200 : 502).json({
    ok: execution.ok,
    plan,
    summary,
    execution
  });
});

app.get('/api/map-editor/:vehicleId/status', async (req, res) => {
  const vehicleId = String(req.params?.vehicleId || '').trim();
  if (!vehicleId) {
    return res.status(400).json({
      ok: false,
      detail: 'vehicle_id_required'
    });
  }

  const execution = await executeMapEditorTool(vehicleId, 'map_editor.status', {}, 20);
  return res.status(execution.ok ? 200 : 502).json({
    ok: execution.ok,
    result: unwrapMapEditorToolResult(execution),
    execution,
    detail: execution.ok ? undefined : execution.detail || execution.error
  });
});

app.post('/api/map-editor/:vehicleId/start', async (req, res) => {
  const vehicleId = String(req.params?.vehicleId || '').trim();
  if (!vehicleId) {
    return res.status(400).json({
      ok: false,
      detail: 'vehicle_id_required'
    });
  }

  const execution = await executeMapEditorTool(vehicleId, 'map_editor.start', {}, 35);
  return res.status(execution.ok ? 200 : 502).json({
    ok: execution.ok,
    result: unwrapMapEditorToolResult(execution),
    execution,
    detail: execution.ok ? undefined : execution.detail || execution.error
  });
});

app.post('/api/map-editor/:vehicleId/stop', async (req, res) => {
  const vehicleId = String(req.params?.vehicleId || '').trim();
  if (!vehicleId) {
    return res.status(400).json({
      ok: false,
      detail: 'vehicle_id_required'
    });
  }

  const execution = await executeMapEditorTool(vehicleId, 'map_editor.stop', {}, 20);
  return res.status(execution.ok ? 200 : 502).json({
    ok: execution.ok,
    result: unwrapMapEditorToolResult(execution),
    execution,
    detail: execution.ok ? undefined : execution.detail || execution.error
  });
});

app.get('/vehicles/:vehicleId/map-editor', (req, res, next) => {
  const parsedUrl = new URL(req.originalUrl, 'http://localhost');
  if (!parsedUrl.pathname.endsWith('/map-editor')) {
    return next();
  }
  return res.redirect(302, `${parsedUrl.pathname}/${parsedUrl.search}`);
});

app.use('/vehicles/:vehicleId/map-editor', async (req, res) => {
  const vehicleId = String(req.params?.vehicleId || '').trim();
  const editorPath = normalizeMapEditorPath(req.path || '/');
  const method = String(req.method || 'GET').toUpperCase();
  const upstreamMethod = method === 'HEAD' ? 'GET' : method;

  if (!vehicleId) {
    return res.status(400).json({
      ok: false,
      detail: 'vehicle_id_required'
    });
  }

  if (!editorPath) {
    return res.status(400).json({
      ok: false,
      detail: 'invalid_map_editor_path'
    });
  }

  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
    return res.status(405).json({
      ok: false,
      detail: 'map_editor_method_not_allowed'
    });
  }

  if ((method === 'GET' || method === 'HEAD') && !mapEditorAllowedGetPaths.has(editorPath)) {
    return res.status(404).json({
      ok: false,
      detail: 'map_editor_path_not_allowed',
      path: editorPath
    });
  }

  if (method === 'POST' && !mapEditorAllowedPostPaths.has(editorPath)) {
    return res.status(403).json({
      ok: false,
      detail: 'map_editor_post_path_not_allowed',
      path: editorPath
    });
  }

  const parsedUrl = new URL(req.originalUrl, 'http://localhost');
  const args = {
    method: upstreamMethod,
    path: editorPath,
    query: parsedUrl.searchParams.toString(),
    max_response_bytes: getMapEditorMaxResponseBytes(editorPath)
  };

  if (method === 'POST') {
    const contentType = req.get('content-type') || 'application/json';
    args.headers = {
      'content-type': contentType
    };
    if (req.body !== undefined && req.body !== null) {
      const bodyText =
        Buffer.isBuffer(req.body) || typeof req.body === 'string'
          ? req.body
          : JSON.stringify(req.body);
      const bodyBuffer = Buffer.isBuffer(bodyText) ? bodyText : Buffer.from(String(bodyText), 'utf8');
      args.body_base64 = bodyBuffer.toString('base64');
    }
  }

  const execution = await executeMapEditorTool(
    vehicleId,
    'map_editor.http',
    args,
    mapEditorBinaryPaths.has(editorPath) || mapEditorLargeJsonPaths.has(editorPath) ? 60 : 35
  );

  if (!execution.ok) {
    return res.status(502).json({
      ok: false,
      detail: execution.detail || execution.error || 'map_editor_proxy_failed',
      execution
    });
  }

  const result = unwrapMapEditorToolResult(execution);
  if (!result || typeof result !== 'object') {
    return res.status(502).json({
      ok: false,
      detail: 'invalid_map_editor_response',
      execution
    });
  }

  const statusCode = toFiniteInteger(result.status, 502, { min: 100, max: 599 });
  const headers = result.headers && typeof result.headers === 'object' ? result.headers : {};
  const contentType =
    getMapEditorHeader(headers, 'content-type') ||
    (mapEditorBinaryPaths.has(editorPath) ? 'application/octet-stream' : 'text/plain; charset=utf-8');
  const bodyBuffer = result.body_base64
    ? Buffer.from(String(result.body_base64), 'base64')
    : Buffer.alloc(0);
  if (mapEditorLargeJsonPaths.has(editorPath) || bodyBuffer.length > 1024 * 1024) {
    console.info(
      'map_editor_proxy_result',
      JSON.stringify({
        vehicle_id: vehicleId,
        path: editorPath,
        status: statusCode,
        body_bytes: result.body_bytes || bodyBuffer.length,
        decoded_bytes: bodyBuffer.length,
        base64_length: result.body_base64 ? String(result.body_base64).length : 0,
        duration_ms: result.duration_ms ?? null
      })
    );
  }

  res.status(statusCode);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Map-Editor-Vehicle', vehicleId);
  res.setHeader('X-Map-Editor-Path', editorPath);
  if (method === 'HEAD') {
    return res.end();
  }
  return res.send(bodyBuffer);
});

app.use(
  '/api/ai-check-history/files',
  express.static(aiCheckArchiveRoot, {
    fallthrough: false,
    index: false,
    maxAge: '5m'
  })
);

app.get('/api/ai-check-history', async (req, res) => {
  const page = toFiniteInteger(req.query.page, 1, { min: 1, max: 9999 });
  const pageSize = toFiniteInteger(req.query.page_size, 8, { min: 1, max: 24 });
  const deviceId =
    typeof req.query.device_id === 'string' && req.query.device_id.trim()
      ? req.query.device_id.trim()
      : '';

  try {
    const history = await listAiCheckHistory(page, pageSize, { device_id: deviceId });
    return res.json({
      ok: true,
      archive_root: aiCheckArchiveRoot,
      ...history
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      error: 'ai_check_history_unavailable',
      detail: error.message
    });
  }
});

app.get('/api/ai-check-history/:requestRowId(\\d+)', async (req, res) => {
  const requestRowId = toFiniteInteger(req.params.requestRowId, 0, { min: 1, max: Number.MAX_SAFE_INTEGER });

  try {
    const request = await getAiCheckHistoryDetail(requestRowId);
    if (!request) {
      return res.status(404).json({
        ok: false,
        error: 'ai_check_request_not_found'
      });
    }

    return res.json({
      ok: true,
      request
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      error: 'ai_check_history_detail_unavailable',
      detail: error.message
    });
  }
});

app.post('/api/cloud-chat', async (req, res) => {
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  const wantsStream =
    req.body?.stream === true || String(req.headers.accept || '').includes('text/event-stream');
  const sessionId =
    typeof req.body?.session_id === 'string' && req.body.session_id.trim()
      ? req.body.session_id.trim()
      : `${defaultVehicleId}-${Date.now()}`;
  const reset = Boolean(req.body?.reset);
  const vehicleId =
    typeof req.body?.vehicle_id === 'string' && req.body.vehicle_id.trim()
      ? req.body.vehicle_id.trim()
      : defaultVehicleId;
  const enableThinking = Boolean(req.body?.enable_thinking);

  if (!message) {
    return res.status(400).json({ error: 'message_required' });
  }

  try {
    const upstreamResponse = await fetch(upstreamStreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream'
      },
      body: JSON.stringify(createUpstreamPayload(message, sessionId, { reset, vehicle_id: vehicleId, enable_thinking: enableThinking })),
      signal: AbortSignal.timeout(requestTimeoutMs)
    });

    if (!upstreamResponse.ok || !upstreamResponse.body) {
      const detail = normalizeReply(await upstreamResponse.text());
      const payload = {
        error: 'upstream_request_failed',
        status: upstreamResponse.status,
        detail: detail || null
      };

      if (wantsStream) {
        res.status(502);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        writeSseEvent(res, { type: 'error', ...payload });
        return res.end();
      }

      return res.status(502).json(payload);
    }

    if (wantsStream) {
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      const result = await readStreamReply(upstreamResponse.body, (text) => {
        if (text) {
          writeSseEvent(res, { type: 'delta', text });
        }
      });

      writeSseEvent(res, {
        type: 'final',
        answer: result.reply,
        source: result.source,
        latency_ms: result.latency_ms
      });
      return res.end();
    }

    const result = await readStreamReply(upstreamResponse.body);
    return res.json({
      ok: true,
      session_id: sessionId,
      ...result
    });
  } catch (error) {
    const isAbort = error.name === 'TimeoutError' || error.name === 'AbortError';
    const status = isAbort ? 504 : 502;
    const payload = {
      error: isAbort ? 'upstream_timeout' : 'upstream_unavailable',
      detail: error.message
    };

    if (wantsStream) {
      if (!res.headersSent) {
        res.status(status);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
      }
      writeSseEvent(res, { type: 'error', ...payload });
      return res.end();
    }

    return res.status(status).json(payload);
  }
});

app.post('/api/openclaw-chat', requireOpenClawAuth, async (req, res) => {
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  const sessionId =
    typeof req.body?.session_id === 'string' && req.body.session_id.trim()
      ? req.body.session_id.trim()
      : `openclaw-${Date.now()}`;
  const vehicleId =
    typeof req.body?.vehicle_id === 'string' && req.body.vehicle_id.trim()
      ? req.body.vehicle_id.trim()
      : '';
  const contextItems = normalizeOpenClawContextItems(req.body?.context_items);

  if (!message) {
    return res.status(400).json({ error: 'message_required' });
  }

  try {
    const result = await runOpenClawOpsTurn(message, sessionId, {
      vehicle_id: vehicleId,
      context_items: contextItems
    });
    return res.json({
      ok: true,
      session_id: sessionId,
      context_count: contextItems.length,
      ...result
    });
  } catch (error) {
    const isAbort = error.killed === true || error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT';
    return res.status(isAbort ? 504 : 502).json({
      ok: false,
      error: isAbort ? 'openclaw_timeout' : 'openclaw_unavailable',
      detail: error.message
    });
  }
});

app.get('/api/qwen36-health', async (_req, res) => {
  const result = await probeQwen36();
  return res.status(result.ok ? 200 : 502).json(result);
});

app.post('/api/qwen36-chat', async (req, res) => {
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  const messages = normalizeQwen36Messages(req.body?.messages, message);
  const wantsStream =
    req.body?.stream === true || String(req.headers.accept || '').includes('text/event-stream');
  const enableThinking =
    req.body?.thinking === false || req.body?.enable_thinking === false
      ? false
      : String(req.body?.thinking || req.body?.enable_thinking || 'true').toLowerCase() !== 'false';
  const preserveThinking =
    req.body?.preserve_thinking === false
      ? false
      : String(req.body?.preserve_thinking ?? 'true').toLowerCase() !== 'false';
  const maxTokens = toFiniteInteger(req.body?.max_tokens, enableThinking ? 2048 : 1024, {
    min: 64,
    max: 4096
  });
  const temperature = Number.isFinite(Number(req.body?.temperature))
    ? Math.min(2, Math.max(0, Number(req.body.temperature)))
    : 0.7;
  const topP = Number.isFinite(Number(req.body?.top_p))
    ? Math.min(1, Math.max(0.01, Number(req.body.top_p)))
    : 0.95;
  const topK = toFiniteInteger(req.body?.top_k, 20, { min: 1, max: 200 });

  if (!messages.length) {
    return res.status(400).json({ ok: false, error: 'message_required' });
  }

  const payload = {
    model: qwen36Model,
    messages,
    temperature,
    top_p: topP,
    top_k: topK,
    max_tokens: maxTokens,
    stream: true,
    chat_template_kwargs: {
      enable_thinking: enableThinking,
      preserve_thinking: preserveThinking
    }
  };

  try {
    const upstreamResponse = await fetch(qwen36ChatUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream'
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(qwen36TimeoutMs)
    });

    if (!upstreamResponse.ok || !upstreamResponse.body) {
      const detail = normalizeReply(await upstreamResponse.text());
      const errorPayload = {
        ok: false,
        error: 'qwen36_request_failed',
        status: upstreamResponse.status,
        detail: detail || null
      };

      if (wantsStream) {
        res.status(502);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        writeSseEvent(res, { type: 'error', ...errorPayload });
        return res.end();
      }

      return res.status(502).json(errorPayload);
    }

    if (wantsStream) {
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      const result = await readQwen36Stream(upstreamResponse.body, (event) => {
        if (event.text) {
          writeSseEvent(res, event);
        }
      });

      writeSseEvent(res, {
        type: 'final',
        answer: result.reply,
        reasoning: result.reasoning,
        finish_reason: result.finish_reason,
        usage: result.usage,
        model: qwen36Model,
        thinking: enableThinking
      });
      return res.end();
    }

    const result = await readQwen36Stream(upstreamResponse.body);
    return res.json({
      ok: true,
      model: qwen36Model,
      thinking: enableThinking,
      ...result
    });
  } catch (error) {
    const isAbort = error.name === 'TimeoutError' || error.name === 'AbortError';
    const status = isAbort ? 504 : 502;
    const errorPayload = {
      ok: false,
      error: isAbort ? 'qwen36_timeout' : 'qwen36_unavailable',
      detail: error.message
    };

    if (wantsStream) {
      if (!res.headersSent) {
        res.status(status);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
      }
      writeSseEvent(res, { type: 'error', ...errorPayload });
      return res.end();
    }

    return res.status(status).json(errorPayload);
  }
});

app.post('/api/qwen36-mm-check', async (req, res) => {
  const startMs = Date.now();
  const image = req.body?.image;
  if (!image?.mime_type || !image?.data_base64) {
    return res.status(400).json({ ok: false, error: 'image_required' });
  }

  const eventName = String(req.body?.event_name || '').trim() || '异常事件';
  const customPrompt = String(req.body?.prompt_text || '').trim();
  const promptText = customPrompt ||
    `Reply YES if this image clearly shows the event "${eventName}". Reply NO if the event is absent. Output only YES or NO.`;

  const imageUrl = `data:${image.mime_type};base64,${image.data_base64}`;

  const payload = {
    model: qwen36MmModel,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageUrl } },
          { type: 'text', text: promptText }
        ]
      }
    ],
    max_tokens: 64,
    temperature: 0.1,
    stream: false,
    chat_template_kwargs: { enable_thinking: false }
  };

  try {
    const upstreamResponse = await fetch(qwen36MmChatUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(qwen36MmTimeoutMs)
    });

    if (!upstreamResponse.ok) {
      const detail = normalizeReply(await upstreamResponse.text());
      console.info('qwen36_mm_check_result', JSON.stringify({
        event_name: eventName, ok: false,
        error: 'upstream_error', status: upstreamResponse.status,
        duration_ms: Date.now() - startMs
      }));
      return res.status(502).json({
        ok: false,
        error: 'qwen36_mm_request_failed',
        status: upstreamResponse.status,
        detail: detail || null
      });
    }

    const data = await upstreamResponse.json();
    const msg = data?.choices?.[0]?.message || {};
    const raw = String(msg.content || msg.reasoning || '').trim();
    const upper = raw.toUpperCase();
    const answer = upper.includes('YES') ? 'YES' : upper.includes('NO') ? 'NO' : 'UNKNOWN';
    const durationMs = Date.now() - startMs;

    console.info('qwen36_mm_check_result', JSON.stringify({
      event_name: eventName, answer, finish_reason: data?.choices?.[0]?.finish_reason,
      raw_reply: raw.slice(0, 80), duration_ms: durationMs, model: qwen36MmModel
    }));

    const imageBuffer = Buffer.from(image.data_base64, 'base64');
    const requestId = `req_${startMs}_${crypto.randomBytes(4).toString('hex')}`;
    saveQwen36MmCheckToArchive({
      requestId, eventName, promptText,
      imageBuffer, imageMimeType: image.mime_type,
      answer, rawText: raw, latencyMs: durationMs, startMs
    }).catch((archiveErr) => {
      console.info('qwen36_mm_archive_error', JSON.stringify({ error: archiveErr.message, event_name: eventName }));
    });

    return res.json({
      ok: true,
      model: qwen36MmModel,
      event_name: eventName,
      answer,
      raw_reply: raw
    });
  } catch (error) {
    const isAbort = error.name === 'TimeoutError' || error.name === 'AbortError';
    console.info('qwen36_mm_check_result', JSON.stringify({
      event_name: eventName, ok: false,
      error: isAbort ? 'timeout' : 'exception',
      detail: error.message, duration_ms: Date.now() - startMs
    }));
    return res.status(isAbort ? 504 : 502).json({
      ok: false,
      error: isAbort ? 'qwen36_mm_timeout' : 'qwen36_mm_unavailable',
      detail: error.message
    });
  }
});

registerCloudMappingRoutes(app);
registerRuntimeControlRoutes(app, {
  rootDir: path.resolve(__dirname, '..'),
  requireOpenClawAuth,
  getOpenClawAuthFromRequest
});

app.use(express.static(webRoot));
app.get('*', (_req, res) => {
  res.sendFile(path.join(webRoot, 'index.html'));
});

app.listen(port, () => {
  console.log(`backend listening on ${port}`);
  console.log(`proxying cloud chat to ${upstreamStreamUrl}`);
});
