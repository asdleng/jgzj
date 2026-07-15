const assert = require('node:assert/strict');
const fs = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');
const express = require('express');

const registerParkPcmRoutes = require('./park-pcm');

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('patrol status is authenticated, cached, read-only, and cloud calls use ops auth', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jgzj-park-pcm-'));
  const runtimeRoot = path.join(directory, 'runtime');
  const oldFrame = path.join(runtimeRoot, 'crowd-frames', 'old', 'frame.jpg');
  await fs.mkdir(path.dirname(oldFrame), { recursive: true });
  await fs.writeFile(oldFrame, 'old-frame');
  await fs.utimes(oldFrame, new Date(0), new Date(0));
  await fs.mkdir(runtimeRoot, { recursive: true });
  await fs.writeFile(
    path.join(runtimeRoot, 'crowd-storage-status.json'),
    JSON.stringify({
      cache_ready: true,
      cached_at: '2026-07-15T12:00:00.000Z',
      total_bytes: 9,
      file_count: 1,
      image_file_count: 1,
      can_accept_upload: true,
      deleted_expired: 0,
      deleted_for_quota: 0
    })
  );

  let cloudAuthorization = null;
  const cloudServer = http.createServer((req, res) => {
    cloudAuthorization = req.headers.authorization || null;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ vehicles: [] }));
  });
  await new Promise((resolve) => cloudServer.listen(0, '127.0.0.1', resolve));

  const previousEnv = {
    runtime: process.env.PARK_CROWD_RUNTIME_ROOT,
    report: process.env.PARK_PCM_REPORT_ENABLED,
    monitor: process.env.PARK_CROWD_MONITOR_ENABLED,
    analysis: process.env.PARK_CROWD_ANALYSIS_ENABLED,
    cleanupDelay: process.env.PARK_CROWD_STORAGE_CLEANUP_BOOT_DELAY_MS
  };
  process.env.PARK_CROWD_RUNTIME_ROOT = runtimeRoot;
  process.env.PARK_PCM_REPORT_ENABLED = 'false';
  process.env.PARK_CROWD_MONITOR_ENABLED = 'false';
  process.env.PARK_CROWD_ANALYSIS_ENABLED = 'false';
  process.env.PARK_CROWD_STORAGE_CLEANUP_BOOT_DELAY_MS = '60000';

  const app = express();
  app.use(express.json());
  registerParkPcmRoutes(app, {
    requirePermission: () => (_req, _res, next) => next(),
    cloudAgentBaseUrl: `http://127.0.0.1:${cloudServer.address().port}`,
    cloudAgentAuthHeaders: { Authorization: 'Bearer ops-token' },
    patrolFlowUploadToken: 'patrol-token',
    rootDir: directory
  });
  const server = await listen(app);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    let response = await fetch(`${baseUrl}/api/auto_ad/patrol-flow/status`);
    assert.equal(response.status, 401);

    const startedAt = Date.now();
    response = await fetch(`${baseUrl}/api/auto_ad/patrol-flow/status`, {
      headers: { Authorization: 'Bearer patrol-token' }
    });
    const status = await response.json();
    assert.equal(response.status, 200);
    assert.equal(status.storage.cache_ready, true);
    assert.equal(status.storage.file_count, 1);
    assert.ok(Date.now() - startedAt < 1000);
    assert.equal(await fs.readFile(oldFrame, 'utf8'), 'old-frame');

    response = await fetch(`${baseUrl}/api/park-pcm/snapshot?refresh=1&max_vehicles=1`);
    assert.equal(response.status, 200);
    assert.equal(cloudAuthorization, 'Bearer ops-token');
  } finally {
    await close(server);
    await close(cloudServer);
    await fs.rm(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries({
      PARK_CROWD_RUNTIME_ROOT: previousEnv.runtime,
      PARK_PCM_REPORT_ENABLED: previousEnv.report,
      PARK_CROWD_MONITOR_ENABLED: previousEnv.monitor,
      PARK_CROWD_ANALYSIS_ENABLED: previousEnv.analysis,
      PARK_CROWD_STORAGE_CLEANUP_BOOT_DELAY_MS: previousEnv.cleanupDelay
    })) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
