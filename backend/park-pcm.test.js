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

test('green inspection analyzes four-view evidence once and suppresses low-confidence issues', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jgzj-green-inspection-'));
  const runtimeRoot = path.join(directory, 'runtime');
  const frameRoot = path.join(runtimeRoot, 'crowd-frames', '20260717', 'sample-1');
  await fs.mkdir(frameRoot, { recursive: true });
  await Promise.all(['camera1.jpg', 'camera2.jpg', 'camera3.jpg', 'camera4.jpg'].map((name) => (
    fs.writeFile(path.join(frameRoot, name), `jpeg-${name}`)
  )));
  const sample = {
    sample_id: 'green-sample-1',
    vehicle_id: 'BIT-TEST',
    collected_at: '2026-07-17T08:00:00.000Z',
    position: { gaode_longitude: 114.1, gaode_latitude: 22.5 },
    frame_count: 4,
    frames: ['camera1', 'camera2', 'camera3', 'camera4'].map((cameraId) => ({
      camera_id: cameraId,
      image_path: `20260717/sample-1/${cameraId}.jpg`
    }))
  };
  await fs.writeFile(path.join(runtimeRoot, 'crowd-samples.jsonl'), `${JSON.stringify(sample)}\n`);

  let analysisRequests = 0;
  const analysisServer = http.createServer(async (req, res) => {
    analysisRequests += 1;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(body.messages[0].content.filter((item) => item.type === 'image_url').length, 4);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            vegetation_present: true,
            vegetation_types: { trees: true, shrubs: true, lawn_or_groundcover: false },
            confidence: 'high',
            health_score: 74,
            indicators: {
              canopy_density: 'moderate',
              leaf_color: 'slight_yellowing',
              drought_stress: 'possible',
              pest_or_disease: 'none',
              dead_or_broken_branches: 'none',
              shrub_condition: 'fair',
              groundcover_condition: 'unknown',
              overgrowth_or_encroachment: 'none'
            },
            issues: [
              {
                type: 'yellowing_or_wilting',
                severity: 'medium',
                confidence: 'high',
                camera_ids: ['camera1', 'camera2'],
                evidence: '两路画面可见连续叶缘枯黄。'
              },
              {
                type: 'pest_or_disease',
                severity: 'high',
                confidence: 'low',
                camera_ids: ['camera3'],
                evidence: '远处疑似斑点。'
              }
            ],
            recommendations: [
              {
                action: '现场复核叶色和土壤湿度',
                priority: 'soon',
                reason: '连续枯黄在两个视角可见',
                related_issue_type: 'yellowing_or_wilting'
              },
              {
                action: '喷药',
                priority: 'urgent',
                reason: '没有可靠依据',
                related_issue_type: 'pest_or_disease'
              }
            ],
            summary: '局部叶色需要复核。'
          })
        }
      }]
    }));
  });
  await new Promise((resolve) => analysisServer.listen(0, '127.0.0.1', resolve));

  const previousEnv = {
    runtime: process.env.PARK_CROWD_RUNTIME_ROOT,
    report: process.env.PARK_PCM_REPORT_ENABLED,
    monitor: process.env.PARK_CROWD_MONITOR_ENABLED,
    analysis: process.env.PARK_CROWD_ANALYSIS_ENABLED,
    greenBase: process.env.PARK_GREEN_INSPECTION_BASE_URL,
    greenModel: process.env.PARK_GREEN_INSPECTION_MODEL,
    cleanupDelay: process.env.PARK_CROWD_STORAGE_CLEANUP_BOOT_DELAY_MS
  };
  process.env.PARK_CROWD_RUNTIME_ROOT = runtimeRoot;
  process.env.PARK_PCM_REPORT_ENABLED = 'false';
  process.env.PARK_CROWD_MONITOR_ENABLED = 'false';
  process.env.PARK_CROWD_ANALYSIS_ENABLED = 'false';
  process.env.PARK_GREEN_INSPECTION_BASE_URL = `http://127.0.0.1:${analysisServer.address().port}/v1`;
  process.env.PARK_GREEN_INSPECTION_MODEL = 'green-test-model';
  process.env.PARK_CROWD_STORAGE_CLEANUP_BOOT_DELAY_MS = '60000';

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  registerParkPcmRoutes(app, {
    requirePermission: () => (_req, _res, next) => next(),
    cloudAgentBaseUrl: 'http://127.0.0.1:9',
    rootDir: directory
  });
  const server = await listen(app);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    let response = await fetch(`${baseUrl}/api/park-pcm/green/inspect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sample_id: sample.sample_id, vehicle_id: sample.vehicle_id })
    });
    let payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.cached, false);
    assert.equal(payload.inspection.health_score, 74);
    assert.equal(payload.inspection.status, 'attention');
    assert.equal(payload.inspection.issues.length, 1);
    assert.equal(payload.inspection.recommendations.length, 1);
    assert.equal(payload.inspection.frame_count_evaluated, 4);

    response = await fetch(`${baseUrl}/api/park-pcm/green/inspect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sample_id: sample.sample_id, vehicle_id: sample.vehicle_id })
    });
    payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.cached, true);
    assert.equal(analysisRequests, 1);

    response = await fetch(`${baseUrl}/api/park-pcm/green/inspections?vehicle_id=BIT-TEST&date=2026-07-17`);
    payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.summary.analyzed_node_count, 1);
    assert.equal(payload.summary.issue_count, 1);
    assert.equal(payload.items[0].schema, 'park_green_inspection.v1');
  } finally {
    await close(server);
    await close(analysisServer);
    await fs.rm(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries({
      PARK_CROWD_RUNTIME_ROOT: previousEnv.runtime,
      PARK_PCM_REPORT_ENABLED: previousEnv.report,
      PARK_CROWD_MONITOR_ENABLED: previousEnv.monitor,
      PARK_CROWD_ANALYSIS_ENABLED: previousEnv.analysis,
      PARK_GREEN_INSPECTION_BASE_URL: previousEnv.greenBase,
      PARK_GREEN_INSPECTION_MODEL: previousEnv.greenModel,
      PARK_CROWD_STORAGE_CLEANUP_BOOT_DELAY_MS: previousEnv.cleanupDelay
    })) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
