const crypto = require('node:crypto');
const fs = require('node:fs');

const PROTOCOL_VERSION = 'auto-ad-ai.relocalization.v1';
const EXPECTED_METHOD = 'bevplace_trt_global_top10_lcrnet_fp32_top3_pcl_ndt';
const DEFAULT_TOKEN_REGISTRY_PATH =
  '/home/admin1/.config/cloud-agent/relocalization_vehicle_tokens.json';
const REQUEST_RE = /^[A-Za-z0-9_.:-]{8,128}$/;
const EPOCH_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const VEHICLE_RE = /^(?:BIT-\d{4}|FTUGV-\d{3})$/;
const MAX_POINT_COUNT = 120000;
const MAX_BASE64_CHARS = 12 * 1024 * 1024;

function timingSafeEqualText(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function bearerToken(req) {
  return String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || '';
}

function tokenSha256(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function loadVehicleTokenRegistry(registryPath = DEFAULT_TOKEN_REGISTRY_PATH) {
  const resolvedPath = String(registryPath || '').trim();
  if (!resolvedPath) return { configured: false, tokenVehicles: new Map() };

  let stat;
  try {
    stat = fs.statSync(resolvedPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { configured: false, tokenVehicles: new Map() };
    throw error;
  }
  if (!stat.isFile()) throw new Error('vehicle_token_registry_not_file');
  if ((stat.mode & 0o077) !== 0) throw new Error('vehicle_token_registry_permissions_too_open');

  const payload = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  if (payload?.version !== 1 || !Array.isArray(payload.tokens) || payload.tokens.length === 0) {
    throw new Error('vehicle_token_registry_invalid');
  }

  const tokenVehicles = new Map();
  const vehicleIds = new Set();
  for (const entry of payload.tokens) {
    const vehicleId = String(entry?.vehicle_id || '').trim();
    const digest = String(entry?.token_sha256 || '').trim().toLowerCase();
    if (!VEHICLE_RE.test(vehicleId) || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error('vehicle_token_registry_entry_invalid');
    }
    if (tokenVehicles.has(digest) || vehicleIds.has(vehicleId)) {
      throw new Error('vehicle_token_registry_duplicate_entry');
    }
    tokenVehicles.set(digest, vehicleId);
    vehicleIds.add(vehicleId);
  }
  return { configured: true, tokenVehicles };
}

function authenticateVehicleToken(token, options = {}) {
  const registry = loadVehicleTokenRegistry(
    options.tokenRegistryPath === undefined
      ? DEFAULT_TOKEN_REGISTRY_PATH
      : options.tokenRegistryPath
  );
  if (registry.configured) {
    const vehicleId = registry.tokenVehicles.get(tokenSha256(token));
    return vehicleId
      ? { authenticated: true, vehicleId, mode: 'vehicle_registry' }
      : { authenticated: false, vehicleId: null, mode: 'vehicle_registry' };
  }

  const legacyToken = String(options.authToken || '').trim();
  return legacyToken && timingSafeEqualText(token, legacyToken)
    ? { authenticated: true, vehicleId: null, mode: 'legacy_unbound' }
    : { authenticated: false, vehicleId: null, mode: 'legacy_unbound' };
}

function baseResponse(payload = {}) {
  return {
    protocol_version: PROTOCOL_VERSION,
    shadow_mode: true,
    publication_enabled: false,
    publication_count: 0,
    ...payload
  };
}

function validateRequest(body, nowMs = Date.now()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw Object.assign(new Error('request_body_required'), { statusCode: 400 });
  }
  const protocolVersion = String(body.protocol_version || '');
  const requestId = String(body.request_id || '').trim();
  const vehicleId = String(body.vehicle_id || '').trim();
  const recoveryEpoch = String(body.recovery_epoch || '').trim();
  if (protocolVersion !== PROTOCOL_VERSION) {
    throw Object.assign(new Error('unsupported_protocol_version'), { statusCode: 400 });
  }
  if (!REQUEST_RE.test(requestId)) {
    throw Object.assign(new Error('invalid_request_id'), { statusCode: 400 });
  }
  if (!VEHICLE_RE.test(vehicleId)) {
    throw Object.assign(new Error('invalid_vehicle_id'), { statusCode: 400 });
  }
  if (!EPOCH_RE.test(recoveryEpoch)) {
    throw Object.assign(new Error('invalid_recovery_epoch'), { statusCode: 400 });
  }
  const expiresAtMs = Date.parse(String(body.expires_at || ''));
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
    throw Object.assign(new Error('request_expired'), { statusCode: 408 });
  }
  if (expiresAtMs - nowMs > 130000) {
    throw Object.assign(new Error('request_deadline_too_far'), { statusCode: 400 });
  }
  const capture = body.capture;
  if (!capture || typeof capture !== 'object' || Array.isArray(capture)) {
    throw Object.assign(new Error('capture_required'), { statusCode: 400 });
  }
  if (String(capture.topic || '') !== '/rslidar_points32') {
    throw Object.assign(new Error('capture_topic_must_be_rslidar_points32'), { statusCode: 400 });
  }
  const messageAgeS = Number(capture.message_age_s);
  if (Number.isFinite(messageAgeS) && (messageAgeS < 0 || messageAgeS > 5)) {
    throw Object.assign(new Error('capture_message_is_stale'), { statusCode: 408 });
  }
  const pointcloud = capture.pointcloud;
  if (!pointcloud || pointcloud.encoding !== 'float32_xyz_zlib_base64') {
    throw Object.assign(new Error('unsupported_pointcloud_encoding'), { statusCode: 400 });
  }
  const pointCount = Number(pointcloud.point_count ?? capture.point_count);
  if (!Number.isSafeInteger(pointCount) || pointCount < 1000 || pointCount > MAX_POINT_COUNT) {
    throw Object.assign(new Error('invalid_point_count'), { statusCode: 400 });
  }
  const pointsBase64 = String(pointcloud.points_base64 || '');
  if (!pointsBase64 || pointsBase64.length > MAX_BASE64_CHARS || !/^[A-Za-z0-9+/]+={0,2}$/.test(pointsBase64)) {
    throw Object.assign(new Error('invalid_pointcloud_payload'), { statusCode: 400 });
  }
  const mapHintSize = body.map_hint?.size_bytes == null ? null : Number(body.map_hint.size_bytes);
  if (mapHintSize !== null && (!Number.isSafeInteger(mapHintSize) || mapHintSize <= 0)) {
    throw Object.assign(new Error('invalid_map_hint_size'), { statusCode: 400 });
  }
  return {
    requestId,
    vehicleId,
    recoveryEpoch,
    expiresAt: new Date(expiresAtMs).toISOString(),
    mapHintSize,
    capture
  };
}

function registerLidarRelocalizationVehicleApi(app, options = {}) {
  const authToken = String(options.authToken || '').trim();
  const tokenRegistryPath = options.tokenRegistryPath;
  const infer = options.infer;
  const activeVehicles = new Set();
  if (typeof infer !== 'function') throw new Error('vehicle_relocalization_infer_callback_required');

  app.post('/api/auto_ad/relocalization/infer', async (req, res) => {
    let authentication;
    try {
      authentication = authenticateVehicleToken(bearerToken(req), {
        authToken,
        tokenRegistryPath
      });
    } catch (error) {
      return res.status(503).json({
        ok: false,
        detail: error.message || 'vehicle_relocalization_auth_registry_invalid'
      });
    }
    if (!authentication.authenticated) {
      return res.status(401).json({ ok: false, detail: 'unauthorized' });
    }

    let request;
    try {
      request = validateRequest(req.body);
    } catch (error) {
      return res.status(error.statusCode || 400).json(baseResponse({
        ok: false,
        phase: 'request_rejected',
        request_id: req.body?.request_id || null,
        vehicle_id: req.body?.vehicle_id || null,
        recovery_epoch: req.body?.recovery_epoch || null,
        detail: error.message
      }));
    }

    if (authentication.vehicleId && authentication.vehicleId !== request.vehicleId) {
      return res.status(403).json(baseResponse({
        ok: false,
        phase: 'request_rejected',
        request_id: request.requestId,
        vehicle_id: request.vehicleId,
        recovery_epoch: request.recoveryEpoch,
        detail: 'token_vehicle_mismatch'
      }));
    }

    if (activeVehicles.has(request.vehicleId)) {
      return res.status(429).json(baseResponse({
        ok: false,
        phase: 'vehicle_request_active',
        request_id: request.requestId,
        vehicle_id: request.vehicleId,
        recovery_epoch: request.recoveryEpoch,
        detail: 'another request is active for this vehicle'
      }));
    }

    activeVehicles.add(request.vehicleId);
    try {
      const result = await infer(request);
      if (
        !result ||
        result.method !== EXPECTED_METHOD ||
        result.shadow_mode !== true ||
        result.publication_enabled !== false ||
        Number(result.publication_count) !== 0
      ) {
        throw Object.assign(new Error('resident_publication_contract_violation'), { statusCode: 502 });
      }
      const candidateAccepted = result.candidate_accepted === true;
      return res.status(200).json(baseResponse({
        ok: true,
        phase: candidateAccepted ? result.phase || 'coarse_pose_ready' : result.phase || 'no_ndt_candidate',
        method: result.method,
        request_id: request.requestId,
        vehicle_id: request.vehicleId,
        recovery_epoch: request.recoveryEpoch,
        expires_at: request.expiresAt,
        candidate_accepted: candidateAccepted,
        coarse_pose: candidateAccepted ? result.coarse_pose || null : null,
        selected_candidate: candidateAccepted ? result.selected_candidate || null : null,
        ndt_selector: result.ndt_selector || null,
        map_contract: result.map_contract || null,
        model: result.model || null,
        resource: result.resource || null,
        capture: result.capture || null,
        resident_service: result.resident_service === true,
        a100_gpu: result.a100_gpu ?? null
      }));
    } catch (error) {
      const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 502;
      return res.status(statusCode).json(baseResponse({
        ok: false,
        phase: error.phase || 'cloud_infer_failed',
        request_id: request.requestId,
        vehicle_id: request.vehicleId,
        recovery_epoch: request.recoveryEpoch,
        detail: error.message || 'cloud_infer_failed'
      }));
    } finally {
      activeVehicles.delete(request.vehicleId);
    }
  });
}

module.exports = {
  DEFAULT_TOKEN_REGISTRY_PATH,
  EXPECTED_METHOD,
  PROTOCOL_VERSION,
  authenticateVehicleToken,
  loadVehicleTokenRegistry,
  registerLidarRelocalizationVehicleApi,
  tokenSha256,
  validateRequest
};
