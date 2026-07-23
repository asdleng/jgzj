const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');
const express = require('express');

const {
  deriveVehicleUploadToken,
  normalizeClipId,
  normalizeVehicleId,
  parseRangeHeader,
  registerE2eDataReplayRoutes
} = require('./e2e-data-replay');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

test('vehicle upload tokens are deterministic and vehicle-bound', () => {
  const secret = 'test-secret';
  const left = deriveVehicleUploadToken(secret, 'BIT-0046');
  assert.equal(left, deriveVehicleUploadToken(secret, 'bit-0046'));
  assert.notEqual(left, deriveVehicleUploadToken(secret, 'BIT-0045'));
  assert.equal(normalizeVehicleId('BIT-0046'), 'BIT-0046');
  assert.equal(normalizeVehicleId('FTUGV-002'), '');
  assert.equal(normalizeClipId('clip_20260723_abcdef12'), 'clip_20260723_abcdef12');
  assert.equal(normalizeClipId('../escape'), '');
});

test('range parser supports ordinary and suffix ranges', () => {
  assert.deepEqual(parseRangeHeader('bytes=10-19', 100), { start: 10, end: 19 });
  assert.deepEqual(parseRangeHeader('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRangeHeader('bytes=-10', 100), { start: 90, end: 99 });
  assert.equal(parseRangeHeader('bytes=100-101', 100), null);
});

test('authenticated resumable upload finalizes a replayable clip', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jgzj-e2e-replay-'));
  const secret = 'unit-test-e2e-secret';
  const vehicleId = 'BIT-0046';
  const token = deriveVehicleUploadToken(secret, vehicleId);
  const clipId = 'clip_20260723_abcdef123456';
  const bag = Buffer.from('0123456789abcdef-raw-rosbag-payload');
  const previewPayload = {
    schema: 'auto_ad_e2e_preview.v1',
    vehicle_id: vehicleId,
    clip_id: clipId,
    captured_at: '2026-07-23T02:00:00Z',
    duration_sec: 29.98,
    frames: [
      {
        t: 0,
        lidar: [1, 2, 0, 10],
        localization: { x: 10, y: 20, heading: 0.3 },
        trajectory: [[10, 20], [11, 20.5]],
        reference_line: [[9, 20], [12, 21]],
        boundaries: [[[9, 19], [12, 20]]]
      }
    ]
  };
  const preview = zlib.gzipSync(Buffer.from(JSON.stringify(previewPayload)));
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  registerE2eDataReplayRoutes(app, {
    rootDir,
    tokenSecret: secret,
    chunkSizeBytes: 8,
    minFreeBytes: 0,
    requirePermission: () => (_req, _res, next) => next()
  });
  app.use((error, _req, res, _next) => {
    res.status(error.statusCode || 500).json({ ok: false, error: error.message });
  });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const request = async (url, options = {}) => {
    const response = await fetch(`${baseUrl}${url}`, options);
    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('application/json') ? await response.json() : await response.arrayBuffer();
    return { response, body };
  };

  try {
    const unauthorized = await request(`/api/auto_ad/e2e-upload/${vehicleId}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(unauthorized.response.status, 401);

    const created = await request(`/api/auto_ad/e2e-upload/${vehicleId}/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        clip_id: clipId,
        metadata: {
          captured_at: previewPayload.captured_at,
          duration_sec: previewPayload.duration_sec,
          source_bag_name: 'sample.bag',
          topics: ['/rslidar_points32', '/planning/trajectory_topic'],
          message_counts: { '/rslidar_points32': 300 },
          charging: { verified: true, stable_seconds: 180, battery_soc: 66, charge_state: 1 }
        },
        files: {
          bag: { name: 'sample.bag', size_bytes: bag.length, sha256: sha256(bag) },
          preview: {
            name: 'sample.preview.json.gz',
            size_bytes: preview.length,
            sha256: sha256(preview)
          }
        }
      })
    });
    assert.equal(created.response.status, 201);
    const uploadId = created.body.session.upload_id;

    const uploadBuffer = async (kind, buffer) => {
      for (let index = 0; index < Math.ceil(buffer.length / 8); index += 1) {
        const chunk = buffer.subarray(index * 8, Math.min(buffer.length, (index + 1) * 8));
        const uploaded = await request(
          `/api/auto_ad/e2e-upload/${vehicleId}/sessions/${uploadId}/files/${kind}/chunks/${index}`,
          {
            method: 'PUT',
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/octet-stream',
              'content-length': String(chunk.length),
              'x-chunk-sha256': sha256(chunk)
            },
            body: chunk
          }
        );
        assert.equal(uploaded.response.status, 200);
      }
    };

    await uploadBuffer('bag', bag);
    await uploadBuffer('preview', preview);

    const finalized = await request(
      `/api/auto_ad/e2e-upload/${vehicleId}/sessions/${uploadId}/finalize`,
      { method: 'POST', headers: { authorization: `Bearer ${token}` } }
    );
    assert.equal(finalized.response.status, 200);
    assert.equal(finalized.body.clip.vehicle_id, vehicleId);
    assert.equal(finalized.body.clip.frame_count, 1);

    const catalog = await request('/api/e2e-autonomous-driving/clips');
    assert.equal(catalog.response.status, 200);
    assert.equal(catalog.body.summary.clip_count, 1);
    assert.equal(catalog.body.clips[0].clip_id, clipId);

    const previewResponse = await fetch(
      `${baseUrl}/api/e2e-autonomous-driving/clips/${vehicleId}/${clipId}/preview`
    );
    assert.equal(previewResponse.status, 200);
    assert.deepEqual(await previewResponse.json(), previewPayload);

    const range = await fetch(
      `${baseUrl}/api/e2e-autonomous-driving/clips/${vehicleId}/${clipId}/bag`,
      { headers: { range: 'bytes=2-7' } }
    );
    assert.equal(range.status, 206);
    assert.equal(Buffer.from(await range.arrayBuffer()).toString(), bag.subarray(2, 8).toString());

    const duplicate = await request(`/api/auto_ad/e2e-upload/${vehicleId}/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        clip_id: clipId,
        metadata: { charging: { verified: true } },
        files: {
          bag: { name: 'sample.bag', size_bytes: bag.length, sha256: sha256(bag) },
          preview: { name: 'preview.json.gz', size_bytes: preview.length, sha256: sha256(preview) }
        }
      })
    });
    assert.equal(duplicate.response.status, 200);
    assert.equal(duplicate.body.completed, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
