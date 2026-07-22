const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const {
  EXPECTED_METHOD,
  PROTOCOL_VERSION,
  registerLidarRelocalizationVehicleApi,
  validateRequest
} = require('./lidar-relocalization-vehicle-api');

function requestBody(overrides = {}) {
  return {
    protocol_version: PROTOCOL_VERSION,
    request_id: 'BIT-0046-test-001',
    vehicle_id: 'BIT-0046',
    recovery_epoch: 'recovery-7',
    requested_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60000).toISOString(),
    map_hint: { size_bytes: 117544304 },
    capture: {
      capture_id: 'lidar-test',
      topic: '/rslidar_points32',
      message_age_s: 0.05,
      point_count: 54387,
      pointcloud: {
        encoding: 'float32_xyz_zlib_base64',
        point_count: 54387,
        points_base64: 'AAAA'
      }
    },
    ...overrides
  };
}

async function withServer(infer, callback, options = {}) {
  const app = express();
  app.use(express.json({ limit: '16mb' }));
  registerLidarRelocalizationVehicleApi(app, {
    authToken: 'test-token',
    tokenRegistryPath: '',
    ...options,
    infer
  });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withTokenRegistry(entries, callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relocalization-token-registry-'));
  const registryPath = path.join(root, 'tokens.json');
  fs.writeFileSync(registryPath, JSON.stringify({ version: 1, tokens: entries }), { mode: 0o600 });
  fs.chmodSync(registryPath, 0o600);
  try {
    return await callback(registryPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('validates expiry, full scan topic and pointcloud encoding', () => {
  assert.equal(validateRequest(requestBody()).vehicleId, 'BIT-0046');
  assert.throws(
    () => validateRequest(requestBody({ expires_at: new Date(Date.now() - 1).toISOString() })),
    /request_expired/
  );
  assert.throws(
    () => validateRequest(requestBody({ capture: { ...requestBody().capture, topic: '/filtered_points' } })),
    /rslidar_points32/
  );
});

test('requires the dedicated bearer token', async () => {
  await withServer(async () => ({}), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auto_ad/relocalization/infer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody())
    });
    assert.equal(response.status, 401);
  });
});

test('binds each registry token to exactly one vehicle', async () => {
  const bit11Token = 'vin-derived-bit-0011-token';
  const bit13Token = 'vin-derived-bit-0013-token';
  await withTokenRegistry([
    {
      vehicle_id: 'BIT-0011',
      token_sha256: require('node:crypto').createHash('sha256').update(bit11Token).digest('hex')
    },
    {
      vehicle_id: 'BIT-0013',
      token_sha256: require('node:crypto').createHash('sha256').update(bit13Token).digest('hex')
    }
  ], async (registryPath) => {
    let inferCalls = 0;
    await withServer(async () => {
      inferCalls += 1;
      return {
        method: EXPECTED_METHOD,
        shadow_mode: true,
        publication_enabled: false,
        publication_count: 0,
        candidate_accepted: false
      };
    }, async (baseUrl) => {
      const mismatch = await fetch(`${baseUrl}/api/auto_ad/relocalization/infer`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bit11Token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(requestBody({
          request_id: 'BIT-0013-test-001',
          vehicle_id: 'BIT-0013'
        }))
      });
      assert.equal(mismatch.status, 403);
      assert.equal((await mismatch.json()).detail, 'token_vehicle_mismatch');
      assert.equal(inferCalls, 0);

      const unknown = await fetch(`${baseUrl}/api/auto_ad/relocalization/infer`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer unknown-token',
          'content-type': 'application/json'
        },
        body: JSON.stringify(requestBody({
          request_id: 'BIT-0011-test-002',
          vehicle_id: 'BIT-0011'
        }))
      });
      assert.equal(unknown.status, 401);
      assert.equal(inferCalls, 0);

      const valid = await fetch(`${baseUrl}/api/auto_ad/relocalization/infer`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bit11Token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(requestBody({
          request_id: 'BIT-0011-test-004',
          vehicle_id: 'BIT-0011'
        }))
      });
      assert.equal(valid.status, 200);
      assert.equal(inferCalls, 1);
    }, { tokenRegistryPath: registryPath });
  });
});

test('fails closed when the vehicle token registry permissions are too open', async () => {
  await withTokenRegistry([
    {
      vehicle_id: 'BIT-0011',
      token_sha256: require('node:crypto').createHash('sha256').update('token').digest('hex')
    }
  ], async (registryPath) => {
    fs.chmodSync(registryPath, 0o644);
    await withServer(async () => ({}), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/auto_ad/relocalization/infer`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer token',
          'content-type': 'application/json'
        },
        body: JSON.stringify(requestBody({
          request_id: 'BIT-0011-test-003',
          vehicle_id: 'BIT-0011'
        }))
      });
      assert.equal(response.status, 503);
      assert.match((await response.json()).detail, /permissions_too_open/);
    }, { tokenRegistryPath: registryPath });
  });
});

test('returns only a shadow candidate from the resident chain', async () => {
  let received = null;
  await withServer(async (request) => {
    received = request;
    return {
      ok: true,
      phase: 'coarse_pose_ready',
      method: EXPECTED_METHOD,
      shadow_mode: true,
      publication_enabled: false,
      publication_count: 0,
      candidate_accepted: true,
      coarse_pose: { x: 1.1, y: 2.2, z: 0, yaw: 0.3 },
      selected_candidate: { rank: 1 },
      ndt_selector: { phase: 'validated_rank1' },
      map_contract: { matched: true, resident_size_bytes: 117544304 },
      model: { bev_sha256: 'abc', lcr_sha256: 'def' },
      resource: { wall_s: 1.9 },
      capture: { capture_id: 'lidar-test', point_count: 54387 },
      resident_service: true,
      a100_gpu: '2'
    };
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auto_ad/relocalization/infer`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify(requestBody())
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(received.mapHintSize, 117544304);
    assert.equal(payload.candidate_accepted, true);
    assert.equal(payload.coarse_pose.x, 1.1);
    assert.equal(payload.shadow_mode, true);
    assert.equal(payload.publication_enabled, false);
    assert.equal(payload.publication_count, 0);
    assert.equal(payload.a100_gpu, '2');
  });
});

test('rejects a resident response that could publish to the vehicle', async () => {
  await withServer(async () => ({
    method: EXPECTED_METHOD,
    shadow_mode: false,
    publication_enabled: true,
    publication_count: 1
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auto_ad/relocalization/infer`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify(requestBody())
    });
    const payload = await response.json();
    assert.equal(response.status, 502);
    assert.equal(payload.ok, false);
    assert.equal(payload.publication_count, 0);
    assert.match(payload.detail, /publication_contract_violation/);
  });
});
