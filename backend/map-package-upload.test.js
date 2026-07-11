const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');
const express = require('express');

const {
  registerMapPackageUploadRoutes,
  _internals: {
    compactChunkRanges,
    normalizeVehicleId,
    parseMapConfig,
    validatePcd
  }
} = require('./map-package-upload');

test('map config requires valid first-frame latitude and longitude', () => {
  assert.deepEqual(
    parseMapConfig('map:\n  STARTPOINT_LAT: 22.51016874\n  STARTPOINT_LNG: 114.03539280\n'),
    {
      latitude: 22.51016874,
      longitude: 114.0353928,
      altitude: null
    }
  );
  assert.throws(() => parseMapConfig('STARTPOINT_LAT: 22.5\n'), /STARTPOINT_LNG/);
  assert.throws(
    () => parseMapConfig('STARTPOINT_LAT: 122.5\nSTARTPOINT_LNG: 114\n'),
    /STARTPOINT_LAT/
  );
});

test('vehicle ids and received chunk ranges are normalized', () => {
  assert.equal(normalizeVehicleId('FTUGV-002'), 'FTUGV-002');
  assert.equal(normalizeVehicleId('../bad'), '');
  assert.deepEqual(compactChunkRanges([0, 1, 2, 5, 8, 9]), [
    [0, 2],
    [5, 5],
    [8, 9]
  ]);
});

test('PCD validation accepts xyz binary headers and rejects missing z', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jgzj-map-upload-'));
  try {
    const validPath = path.join(directory, 'valid.pcd');
    await fs.writeFile(
      validPath,
      Buffer.concat([
        Buffer.from(
          '# .PCD v0.7\nVERSION 0.7\nFIELDS x y z intensity\nSIZE 4 4 4 4\nTYPE F F F F\nCOUNT 1 1 1 1\nWIDTH 1\nHEIGHT 1\nPOINTS 1\nDATA binary\n'
        ),
        Buffer.alloc(16)
      ])
    );
    const result = await validatePcd(validPath);
    assert.equal(result.point_count, 1);
    assert.equal(result.data, 'binary');

    const invalidPath = path.join(directory, 'invalid.pcd');
    await fs.writeFile(
      invalidPath,
      'VERSION 0.7\nFIELDS x y\nSIZE 4 4\nTYPE F F\nCOUNT 1 1\nWIDTH 1\nHEIGHT 1\nPOINTS 1\nDATA ascii\n0 0\n'
    );
    await assert.rejects(validatePcd(invalidPath), /x、y、z/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('chunk upload retries, finalizes both files, and backs up on sync', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jgzj-map-upload-api-'));
  const uploadRoot = path.join(directory, 'uploads');
  const vehicleMapRoot = path.join(directory, 'maps');
  const app = express();
  app.use(express.json());
  registerMapPackageUploadRoutes(app, {
    requirePermission: () => (_req, _res, next) => next(),
    uploadRoot,
    vehicleMapRoot,
    chunkSizeBytes: 64
  });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const vehicleId = 'FTUGV-TEST';
  const pcd = Buffer.from(
    'VERSION 0.7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\nWIDTH 1\nHEIGHT 1\nPOINTS 1\nDATA ascii\n0 0 0\n'
  );
  const config = Buffer.from('STARTPOINT_LAT: 22.51016874\nSTARTPOINT_LNG: 114.03539280\n');

  const requestJson = async (url, options = {}) => {
    const response = await fetch(`${baseUrl}${url}`, options);
    const payload = await response.json();
    return { response, payload };
  };

  try {
    const missing = await requestJson(`/api/map-upload/${vehicleId}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        files: {
          pcd: { name: 'GlobalMap.pcd', size_bytes: pcd.length }
        }
      })
    });
    assert.equal(missing.response.status, 400);

    const created = await requestJson(`/api/map-upload/${vehicleId}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        files: {
          pcd: { name: 'GlobalMap.pcd', size_bytes: pcd.length },
          config: { name: 'config.yaml', size_bytes: config.length }
        }
      })
    });
    assert.equal(created.response.status, 201);
    const uploadId = created.payload.session.upload_id;
    const chunkSize = created.payload.session.chunk_size_bytes;

    const earlySync = await requestJson(
      `/api/map-upload/${vehicleId}/sessions/${uploadId}/sync`,
      { method: 'POST' }
    );
    assert.equal(earlySync.response.status, 409);

    const uploadBuffer = async (kind, buffer, retryFirstChunk = false) => {
      const totalChunks = Math.ceil(buffer.length / chunkSize);
      for (let index = 0; index < totalChunks; index += 1) {
        const chunk = buffer.subarray(index * chunkSize, Math.min(buffer.length, (index + 1) * chunkSize));
        if (retryFirstChunk && index === 0) {
          const interrupted = await requestJson(
            `/api/map-upload/${vehicleId}/sessions/${uploadId}/files/${kind}/chunks/${index}`,
            {
              method: 'PUT',
              headers: { 'content-type': 'application/octet-stream' },
              body: chunk.subarray(0, chunk.length - 1)
            }
          );
          assert.equal(interrupted.response.status, 400);
        }
        const uploaded = await requestJson(
          `/api/map-upload/${vehicleId}/sessions/${uploadId}/files/${kind}/chunks/${index}`,
          {
            method: 'PUT',
            headers: { 'content-type': 'application/octet-stream' },
            body: chunk
          }
        );
        assert.equal(uploaded.response.status, 200);
      }
    };

    await uploadBuffer('pcd', pcd, true);
    await uploadBuffer('config', config);

    const finalized = await requestJson(
      `/api/map-upload/${vehicleId}/sessions/${uploadId}/finalize`,
      { method: 'POST' }
    );
    assert.equal(finalized.response.status, 200);
    assert.equal(finalized.payload.session.status, 'ready');
    assert.equal(finalized.payload.session.origin.latitude, 22.51016874);
    assert.match(finalized.payload.session.files.pcd.sha256, /^[a-f0-9]{64}$/);

    const destinationDir = path.join(vehicleMapRoot, vehicleId);
    await fs.mkdir(destinationDir, { recursive: true });
    await fs.writeFile(path.join(destinationDir, 'GlobalMap.pcd'), 'old pcd');
    await fs.writeFile(path.join(destinationDir, 'config.yaml'), 'old config');

    const synced = await requestJson(
      `/api/map-upload/${vehicleId}/sessions/${uploadId}/sync`,
      { method: 'POST' }
    );
    assert.equal(synced.response.status, 200);
    assert.equal(synced.payload.session.status, 'synced');
    assert.deepEqual(await fs.readFile(path.join(destinationDir, 'GlobalMap.pcd')), pcd);
    assert.deepEqual(await fs.readFile(path.join(destinationDir, 'config.yaml')), config);
    assert.ok(synced.payload.session.backup_path);
    assert.equal(
      await fs.readFile(path.join(synced.payload.session.backup_path, 'GlobalMap.pcd'), 'utf8'),
      'old pcd'
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
