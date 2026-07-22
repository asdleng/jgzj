const assert = require('node:assert/strict');
const test = require('node:test');

const {
  EXPECTED_METHOD,
  inferResidentRelocalization,
  inferUrl
} = require('./lidar-relocalization-resident-client');

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload)
  };
}

test('builds the resident endpoint without dropping a base path', () => {
  assert.equal(inferUrl('http://127.0.0.1:18926'), 'http://127.0.0.1:18926/v1/infer');
  assert.equal(inferUrl('http://host/base/'), 'http://host/base/v1/infer');
});

test('sends capture and map contract and accepts shadow-only output', async () => {
  let request = null;
  const result = await inferResidentRelocalization({
    baseUrl: 'http://127.0.0.1:18926',
    vehicleId: 'BIT-0046',
    requestId: 'web-test-1',
    capturePath: '/tmp/capture.json',
    expectedMapSizeBytes: 117544304,
    readFile: async () => JSON.stringify({ result: { capture_id: 'cap-1' } }),
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return response(200, {
        ok: true,
        method: EXPECTED_METHOD,
        shadow_mode: true,
        publication_enabled: false,
        publication_count: 0,
        map_contract: {
          matched: true,
          resident_size_bytes: 117544304
        }
      });
    }
  });

  assert.equal(request.url, 'http://127.0.0.1:18926/v1/infer');
  assert.equal(request.body.vehicle_id, 'BIT-0046');
  assert.equal(request.body.request_id, 'web-test-1');
  assert.equal(request.body.expected_map_size_bytes, 117544304);
  assert.equal(request.body.capture.result.capture_id, 'cap-1');
  assert.equal(result.publication_count, 0);
  assert.ok(result.resident_http_elapsed_ms >= 0);
});

test('propagates TTS priority rejection without a cold fallback', async () => {
  await assert.rejects(
    inferResidentRelocalization({
      baseUrl: 'http://127.0.0.1:18926',
      vehicleId: 'BIT-0046',
      requestId: 'web-test-2',
      capturePath: '/tmp/capture.json',
      expectedMapSizeBytes: 117544304,
      readFile: async () => '{}',
      fetchImpl: async () => response(503, { ok: false, error: 'tts_priority_gate' })
    }),
    /resident_relocalization_rejected:tts_priority_gate/
  );
});

test('accepts an in-memory vehicle capture without a temporary file', async () => {
  let request = null;
  await inferResidentRelocalization({
    baseUrl: 'http://127.0.0.1:18926',
    vehicleId: 'BIT-0046',
    requestId: 'vehicle-test-1',
    capture: { capture_id: 'vehicle-cap-1', pointcloud: { encoding: 'float32_xyz_zlib_base64' } },
    expectedMapSizeBytes: 117544304,
    readFile: async () => {
      throw new Error('readFile must not be called for an in-memory capture');
    },
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return response(200, {
        ok: true,
        method: EXPECTED_METHOD,
        shadow_mode: true,
        publication_enabled: false,
        publication_count: 0,
        map_contract: { matched: true, resident_size_bytes: 117544304 }
      });
    }
  });
  assert.equal(request.capture.capture_id, 'vehicle-cap-1');
});

test('rejects any response that could publish a vehicle pose', async () => {
  await assert.rejects(
    inferResidentRelocalization({
      baseUrl: 'http://127.0.0.1:18926',
      vehicleId: 'BIT-0046',
      requestId: 'web-test-3',
      capturePath: '/tmp/capture.json',
      expectedMapSizeBytes: 117544304,
      readFile: async () => '{}',
      fetchImpl: async () => response(200, {
        ok: true,
        method: EXPECTED_METHOD,
        shadow_mode: false,
        publication_enabled: true,
        publication_count: 1
      })
    }),
    /publication_contract_violation/
  );
});
