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
    greenAuto: process.env.PARK_GREEN_INSPECTION_AUTO_ENABLED,
    cleanupDelay: process.env.PARK_CROWD_STORAGE_CLEANUP_BOOT_DELAY_MS
  };
  process.env.PARK_CROWD_RUNTIME_ROOT = runtimeRoot;
  process.env.PARK_PCM_REPORT_ENABLED = 'false';
  process.env.PARK_CROWD_MONITOR_ENABLED = 'false';
  process.env.PARK_CROWD_ANALYSIS_ENABLED = 'false';
  process.env.PARK_GREEN_INSPECTION_AUTO_ENABLED = 'false';
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
      PARK_GREEN_INSPECTION_AUTO_ENABLED: previousEnv.greenAuto,
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
  const secondSample = {
    ...sample,
    sample_id: 'green-sample-2',
    collected_at: '2026-07-17T08:00:10.000Z'
  };
  const thirdSample = {
    ...sample,
    sample_id: 'green-sample-3',
    collected_at: '2026-07-17T08:00:20.000Z'
  };
  await fs.writeFile(
    path.join(runtimeRoot, 'crowd-samples.jsonl'),
    `${JSON.stringify(sample)}\n${JSON.stringify(secondSample)}\n${JSON.stringify(thirdSample)}\n`
  );

  let analysisRequests = 0;
  let activeAnalysisRequests = 0;
  let maxActiveAnalysisRequests = 0;
  const analysisServer = http.createServer(async (req, res) => {
    analysisRequests += 1;
    activeAnalysisRequests += 1;
    maxActiveAnalysisRequests = Math.max(maxActiveAnalysisRequests, activeAnalysisRequests);
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(body.model, 'Qwen3.6-27B-Labeler');
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.messages[0].content.filter((item) => item.type === 'image_url').length, 4);
    assert.match(body.messages[0].content[0].text, /不要默认给 90 分/);
    assert.match(body.messages[0].content[0].text, /view_assessments/);
    await new Promise((resolve) => setTimeout(resolve, 30));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            vegetation_present: true,
            vegetation_types: { trees: true, shrubs: true, lawn_or_groundcover: false },
            confidence: 'high',
            dimension_scores: {
              leaf_color: { score: 72, confidence: 'high', camera_ids: ['camera1', 'camera2'], observation: '两路画面叶缘颜色偏黄。' },
              water_status: { score: 70, confidence: 'medium', camera_ids: ['camera1'], observation: '局部叶片姿态略显下垂。' },
              pest_status: { score: 91, confidence: 'medium', camera_ids: ['camera1', 'camera2'], observation: '可见叶面未见连续病斑或虫害。' },
              branch_structure: { score: null, confidence: 'low', camera_ids: ['camera1'], observation: '枝条受叶片遮挡，无法可靠评分。' },
              maintenance_condition: { score: 76, confidence: 'high', camera_ids: ['camera2'], observation: '绿篱边缘略不整齐。' }
            },
            score_reason: '叶色和水分状态拉低综合分，枝干与病虫维度相对良好。',
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
            view_assessments: [
              {
                camera_id: 'camera1',
                vegetation_visible: true,
                vegetation_types: { trees: true, shrubs: true, lawn_or_groundcover: false },
                green_coverage_percent: 62,
                condition: 'fair',
                confidence: 'high',
                observation: '前向画面乔木和灌木连续可见，局部叶缘偏黄。'
              },
              {
                camera_id: 'camera2',
                vegetation_visible: true,
                vegetation_types: { trees: true, shrubs: true, lawn_or_groundcover: false },
                green_coverage_percent: 48,
                condition: 'fair',
                confidence: 'high',
                observation: '左向画面绿篱覆盖连续，但修剪边缘略不整齐。'
              },
              {
                camera_id: 'camera3',
                vegetation_visible: true,
                vegetation_types: { trees: true, shrubs: false, lawn_or_groundcover: false },
                green_coverage_percent: 36,
                condition: 'good',
                confidence: 'medium',
                observation: '后向画面可见乔木枝叶，结构完整。'
              },
              {
                camera_id: 'camera4',
                vegetation_visible: false,
                vegetation_types: { trees: false, shrubs: false, lawn_or_groundcover: false },
                green_coverage_percent: 0,
                condition: 'not_assessable',
                confidence: 'high',
                observation: '右向画面未见可评估植被。'
              }
            ],
            observations: [
              {
                category: 'leaf_color',
                sentiment: 'negative',
                confidence: 'high',
                camera_ids: ['camera1', 'camera2'],
                evidence: '两个视角均可见连续叶缘偏黄。'
              },
              {
                category: 'branch_structure',
                sentiment: 'positive',
                confidence: 'high',
                camera_ids: ['camera1'],
                evidence: '前向画面的可见枝条结构完整。'
              }
            ],
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
    activeAnalysisRequests -= 1;
  });
  await new Promise((resolve) => analysisServer.listen(0, '127.0.0.1', resolve));

  const previousEnv = {
    runtime: process.env.PARK_CROWD_RUNTIME_ROOT,
    report: process.env.PARK_PCM_REPORT_ENABLED,
    monitor: process.env.PARK_CROWD_MONITOR_ENABLED,
    analysis: process.env.PARK_CROWD_ANALYSIS_ENABLED,
    greenBase: process.env.PARK_GREEN_INSPECTION_BASE_URL,
    greenModel: process.env.PARK_GREEN_INSPECTION_MODEL,
    greenAutoEnabled: process.env.PARK_GREEN_INSPECTION_AUTO_ENABLED,
    greenBootDelay: process.env.PARK_GREEN_INSPECTION_AUTO_BOOT_DELAY_MS,
    cleanupDelay: process.env.PARK_CROWD_STORAGE_CLEANUP_BOOT_DELAY_MS
  };
  process.env.PARK_CROWD_RUNTIME_ROOT = runtimeRoot;
  process.env.PARK_PCM_REPORT_ENABLED = 'false';
  process.env.PARK_CROWD_MONITOR_ENABLED = 'false';
  process.env.PARK_CROWD_ANALYSIS_ENABLED = 'false';
  process.env.PARK_GREEN_INSPECTION_BASE_URL = `http://127.0.0.1:${analysisServer.address().port}/v1`;
  delete process.env.PARK_GREEN_INSPECTION_MODEL;
  process.env.PARK_GREEN_INSPECTION_AUTO_ENABLED = 'true';
  process.env.PARK_GREEN_INSPECTION_AUTO_BOOT_DELAY_MS = '60000';
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
    assert.equal(payload.inspection.model, 'Qwen3.6-27B-Labeler');
    assert.equal(payload.inspection.schema, 'park_green_inspection.v2');
    assert.equal(payload.inspection.dimension_scores.pest_status.score, 91);
    assert.equal(payload.inspection.dimension_scores.branch_structure.score, null);
    assert.equal(payload.inspection.observations.length, 2);
    assert.equal(payload.inspection.view_assessments.length, 4);

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
    assert.equal(payload.items[0].schema, 'park_green_inspection.v2');
    assert.equal(payload.summary.score_bands.watch, 1);
    assert.equal(payload.summary.observation_counts.positive, 1);

    response = await fetch(`${baseUrl}/api/park-pcm/green/status`);
    payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.queue.source_node_count, 3);
    assert.equal(payload.queue.analyzed_node_count, 1);
    assert.equal(payload.queue.pending_node_count, 2);
    assert.equal(payload.queue.progress_percent, 33.3);
    assert.equal(payload.queue.analysis_summary.average_health_score, 74);

    response = await fetch(`${baseUrl}/api/park-pcm/green/worker/run`, { method: 'POST' });
    payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.worker.last_result.sample_id, thirdSample.sample_id);
    assert.equal(payload.queue.analyzed_node_count, 2);
    assert.equal(payload.queue.pending_node_count, 1);
    assert.equal(analysisRequests, 2);

    const [forcedResponse, secondResponse] = await Promise.all([
      fetch(`${baseUrl}/api/park-pcm/green/inspect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sample_id: sample.sample_id, vehicle_id: sample.vehicle_id, force: true })
      }),
      fetch(`${baseUrl}/api/park-pcm/green/inspect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sample_id: secondSample.sample_id, vehicle_id: secondSample.vehicle_id })
      })
    ]);
    assert.equal(forcedResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.equal(analysisRequests, 4);
    assert.equal(maxActiveAnalysisRequests, 1);

    response = await fetch(`${baseUrl}/api/park-pcm/green/status`);
    payload = await response.json();
    assert.equal(payload.queue.analyzed_node_count, 3);
    assert.equal(payload.queue.pending_node_count, 0);
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
      PARK_GREEN_INSPECTION_AUTO_ENABLED: previousEnv.greenAutoEnabled,
      PARK_GREEN_INSPECTION_AUTO_BOOT_DELAY_MS: previousEnv.greenBootDelay,
      PARK_CROWD_STORAGE_CLEANUP_BOOT_DELAY_MS: previousEnv.cleanupDelay
    })) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('green inspection auto worker moves terminal model errors to the failed queue', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jgzj-green-worker-failure-'));
  const runtimeRoot = path.join(directory, 'runtime');
  const frameRoot = path.join(runtimeRoot, 'crowd-frames', '20260717', 'failed-sample');
  await fs.mkdir(frameRoot, { recursive: true });
  await fs.writeFile(path.join(frameRoot, 'camera1.jpg'), 'invalid-jpeg-for-mock');
  const sample = {
    sample_id: 'green-failed-sample',
    vehicle_id: 'BIT-FAIL',
    collected_at: new Date().toISOString(),
    frames: [{ camera_id: 'camera1', image_path: '20260717/failed-sample/camera1.jpg' }]
  };
  await fs.writeFile(path.join(runtimeRoot, 'crowd-samples.jsonl'), `${JSON.stringify(sample)}\n`);

  const analysisServer = http.createServer((_req, res) => {
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: { message: 'model_temporarily_unavailable' } }));
  });
  await new Promise((resolve) => analysisServer.listen(0, '127.0.0.1', resolve));

  const previousEnv = {
    runtime: process.env.PARK_CROWD_RUNTIME_ROOT,
    report: process.env.PARK_PCM_REPORT_ENABLED,
    monitor: process.env.PARK_CROWD_MONITOR_ENABLED,
    analysis: process.env.PARK_CROWD_ANALYSIS_ENABLED,
    greenBase: process.env.PARK_GREEN_INSPECTION_BASE_URL,
    greenAutoEnabled: process.env.PARK_GREEN_INSPECTION_AUTO_ENABLED,
    greenBootDelay: process.env.PARK_GREEN_INSPECTION_AUTO_BOOT_DELAY_MS,
    greenMaxAttempts: process.env.PARK_GREEN_INSPECTION_AUTO_MAX_ATTEMPTS,
    cleanupDelay: process.env.PARK_CROWD_STORAGE_CLEANUP_BOOT_DELAY_MS
  };
  process.env.PARK_CROWD_RUNTIME_ROOT = runtimeRoot;
  process.env.PARK_PCM_REPORT_ENABLED = 'false';
  process.env.PARK_CROWD_MONITOR_ENABLED = 'false';
  process.env.PARK_CROWD_ANALYSIS_ENABLED = 'false';
  process.env.PARK_GREEN_INSPECTION_BASE_URL = `http://127.0.0.1:${analysisServer.address().port}/v1`;
  process.env.PARK_GREEN_INSPECTION_AUTO_ENABLED = 'true';
  process.env.PARK_GREEN_INSPECTION_AUTO_BOOT_DELAY_MS = '60000';
  process.env.PARK_GREEN_INSPECTION_AUTO_MAX_ATTEMPTS = '1';
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
    const response = await fetch(`${baseUrl}/api/park-pcm/green/worker/run`, { method: 'POST' });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.worker.last_result.ok, false);
    assert.equal(payload.worker.last_result.terminal, true);
    assert.equal(payload.queue.pending_node_count, 0);
    assert.equal(payload.queue.failed_node_count, 1);
    const workerState = JSON.parse(await fs.readFile(
      path.join(runtimeRoot, 'green-inspection-worker-state.json'),
      'utf8'
    ));
    assert.equal(workerState.failures[sample.sample_id].attempts, 1);
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
      PARK_GREEN_INSPECTION_AUTO_ENABLED: previousEnv.greenAutoEnabled,
      PARK_GREEN_INSPECTION_AUTO_BOOT_DELAY_MS: previousEnv.greenBootDelay,
      PARK_GREEN_INSPECTION_AUTO_MAX_ATTEMPTS: previousEnv.greenMaxAttempts,
      PARK_CROWD_STORAGE_CLEANUP_BOOT_DELAY_MS: previousEnv.cleanupDelay
    })) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
