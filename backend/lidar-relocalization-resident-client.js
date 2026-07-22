const fs = require('node:fs/promises');

const EXPECTED_METHOD = 'bevplace_trt_global_top10_lcrnet_fp32_top3_pcl_ndt';

function inferUrl(baseUrl) {
  const normalized = String(baseUrl || '').trim();
  if (!normalized) {
    throw new Error('resident_relocalization_base_url_missing');
  }
  return new URL('v1/infer', normalized.endsWith('/') ? normalized : `${normalized}/`).toString();
}

async function inferResidentRelocalization(options = {}) {
  const vehicleId = String(options.vehicleId || '').trim();
  const requestId = String(options.requestId || '').trim();
  const capturePath = String(options.capturePath || '').trim();
  const expectedMapSizeBytes = Number(options.expectedMapSizeBytes);
  if (!vehicleId || !requestId || !capturePath) {
    throw new Error('resident_relocalization_request_incomplete');
  }
  if (!Number.isSafeInteger(expectedMapSizeBytes) || expectedMapSizeBytes <= 0) {
    throw new Error('resident_relocalization_map_size_invalid');
  }

  const readFile = options.readFile || fs.readFile;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('resident_relocalization_fetch_unavailable');
  }
  const capture = JSON.parse(await readFile(capturePath, 'utf8'));
  const body = JSON.stringify({
    request_id: requestId,
    vehicle_id: vehicleId,
    expected_map_size_bytes: expectedMapSizeBytes,
    capture
  });
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1000, Number(options.timeoutMs))
    : 90000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  let response;
  let text;
  try {
    response = await fetchImpl(inferUrl(options.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body))
      },
      body,
      signal: controller.signal
    });
    text = await response.text();
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`resident_relocalization_timeout:${timeoutMs}`);
    }
    throw new Error(`resident_relocalization_unreachable:${error?.message || error}`);
  } finally {
    clearTimeout(timer);
  }

  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch (_error) {
    throw new Error(`resident_relocalization_invalid_json:http_${response.status}`);
  }
  if (!response.ok) {
    const detail = payload?.error || payload?.detail || `http_${response.status}`;
    const error = new Error(`resident_relocalization_rejected:${detail}`);
    error.statusCode = response.status;
    error.payload = payload;
    throw error;
  }
  if (!payload || payload.ok !== true || payload.method !== EXPECTED_METHOD) {
    throw new Error(`resident_relocalization_unexpected_method:${payload?.method || 'missing'}`);
  }
  if (
    payload.shadow_mode !== true ||
    payload.publication_enabled !== false ||
    Number(payload.publication_count) !== 0
  ) {
    throw new Error('resident_relocalization_publication_contract_violation');
  }
  const residentMapSize = Number(payload?.map_contract?.resident_size_bytes);
  if (
    payload.map_contract &&
    (!payload.map_contract.matched || residentMapSize !== expectedMapSizeBytes)
  ) {
    throw new Error('resident_relocalization_map_contract_violation');
  }
  return {
    ...payload,
    resident_http_elapsed_ms: Date.now() - startedAt
  };
}

module.exports = {
  EXPECTED_METHOD,
  inferResidentRelocalization,
  inferUrl
};
