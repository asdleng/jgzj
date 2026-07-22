const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const ASSET_SCHEMA = 'park_green_tree_assets.v1';
const REVIEW_SCHEMA = 'park_green_tree_asset_reviews.v1';
const REVIEW_STATUSES = new Set(['unreviewed', 'confirmed', 'rejected']);
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WORKER_MAX_JOBS = 40;
const DEFAULT_FLEET_WORKER_MAX_JOBS = 8;

function nowIso() {
  return new Date().toISOString();
}

function shanghaiDayKey(value = Date.now()) {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value) || Number(value);
  if (!Number.isFinite(timestamp)) return '';
  return new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function nextShanghaiRunDelayMs(nowMs, hour, minute) {
  const shifted = new Date(nowMs + 8 * 60 * 60 * 1000);
  let target = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
    hour - 8,
    minute,
    0,
    0
  );
  if (target <= nowMs + 30 * 1000) target += DAY_MS;
  return Math.max(1000, target - nowMs);
}

function integerOption(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value == null ? '' : value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch (_error) {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, payload) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, filePath);
}

function normalizeReviewStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  return REVIEW_STATUSES.has(status) ? status : '';
}

function summarizeAssets(assets) {
  const rows = Array.isArray(assets) ? assets : [];
  return {
    asset_count: rows.length,
    auto_matched_count: rows.filter((item) => item.status === 'auto_matched' || item.status === 'auto_confirmed').length,
    human_confirmed_count: rows.filter((item) => item.review_status === 'confirmed').length,
    needs_review_count: rows.filter((item) => item.review_status === 'unreviewed').length,
    rejected_count: rows.filter((item) => item.review_status === 'rejected').length,
    observation_count: rows.reduce((sum, item) => sum + Number(item.observation_count || 0), 0),
    multi_day_count: rows.filter((item) => Number(item.day_count || 0) >= 2).length,
    vehicle_count: new Set(rows.map((item) => item.vehicle_id).filter(Boolean)).size,
    scene_count: new Set(rows.map((item) => item.scene_id).filter(Boolean)).size
  };
}

function mergeReview(asset, review) {
  const baseStatus = normalizeReviewStatus(asset?.review_status) || 'unreviewed';
  const reviewStatus = normalizeReviewStatus(review?.review_status) || baseStatus;
  return {
    ...asset,
    status: asset?.status === 'auto_confirmed' ? 'auto_matched' : asset?.status,
    review_status: reviewStatus,
    review_note: String(review?.review_note || '').slice(0, 1000),
    reviewed_by: review?.reviewed_by || null,
    reviewed_at: review?.reviewed_at || null
  };
}

function createGreenTreeAssetStore(options = {}) {
  const runtimeRoot = path.resolve(options.runtimeRoot || path.resolve(__dirname, '../.runtime/park-pcm'));
  const statePath = path.resolve(options.statePath || path.join(runtimeRoot, 'green-tree-assets-state.json'));
  const reviewPath = path.resolve(options.reviewPath || path.join(runtimeRoot, 'green-tree-asset-reviews.json'));
  const workerStatePath = path.resolve(options.workerStatePath || path.join(runtimeRoot, 'green-tree-asset-worker-state.json'));

  async function readMergedAssets() {
    const [state, reviewState, worker] = await Promise.all([
      readJson(statePath, { schema: ASSET_SCHEMA, assets: {}, updated_at: null }),
      readJson(reviewPath, { schema: REVIEW_SCHEMA, reviews: {}, updated_at: null }),
      readJson(workerStatePath, { running: false })
    ]);
    const reviews = reviewState?.reviews && typeof reviewState.reviews === 'object' ? reviewState.reviews : {};
    const assets = Object.values(state?.assets && typeof state.assets === 'object' ? state.assets : {})
      .filter((item) => item && item.asset_id)
      .map((item) => mergeReview(item, reviews[item.asset_id]));
    return { state, reviewState, worker, assets };
  }

  async function list(options = {}) {
    const merged = await readMergedAssets();
    const vehicleId = String(options.vehicle_id || '').trim();
    const includeRejected = options.include_rejected === true;
    const limit = integerOption(options.limit, 200, 1, 1000);
    const rows = merged.assets
      .filter((item) => !vehicleId || String(item.vehicle_id || '') === vehicleId)
      .filter((item) => includeRejected || item.review_status !== 'rejected')
      .sort((left, right) => {
        const reviewRank = { unreviewed: 0, confirmed: 1, rejected: 2 };
        return (reviewRank[left.review_status] ?? 3) - (reviewRank[right.review_status] ?? 3)
          || Date.parse(right.last_seen || '') - Date.parse(left.last_seen || '')
          || String(left.asset_id).localeCompare(String(right.asset_id));
      });
    return {
      schema: ASSET_SCHEMA,
      identity_scope: 'same_camera_view_track_v1',
      global_identity_confirmed: false,
      position_source: 'vehicle_observation_station',
      scope_notice: '当前资产 ID 仅确认同车、同相机、同一路侧视角下的跨天同一棵树；地图点位是车辆观察站，不是树木实测坐标。',
      updated_at: merged.state.updated_at || null,
      review_updated_at: merged.reviewState.updated_at || null,
      summary: summarizeAssets(rows),
      worker: merged.worker,
      assets: rows.slice(0, limit)
    };
  }

  async function get(assetId) {
    const merged = await readMergedAssets();
    return merged.assets.find((item) => item.asset_id === assetId) || null;
  }

  async function review(assetId, input = {}) {
    const reviewStatus = normalizeReviewStatus(input.review_status);
    if (!reviewStatus) {
      const error = new Error('green_tree_asset_review_status_invalid');
      error.status = 400;
      throw error;
    }
    if (!(await get(assetId))) {
      const error = new Error('green_tree_asset_not_found');
      error.status = 404;
      throw error;
    }
    const reviewState = await readJson(reviewPath, { schema: REVIEW_SCHEMA, reviews: {}, updated_at: null });
    const timestamp = nowIso();
    const record = {
      asset_id: assetId,
      review_status: reviewStatus,
      review_note: String(input.review_note || '').trim().slice(0, 1000),
      reviewed_by: String(input.reviewed_by || '').trim() || null,
      reviewed_at: timestamp
    };
    const nextState = {
      schema: REVIEW_SCHEMA,
      updated_at: timestamp,
      reviews: {
        ...(reviewState?.reviews && typeof reviewState.reviews === 'object' ? reviewState.reviews : {}),
        [assetId]: record
      }
    };
    await writeJsonAtomic(reviewPath, nextState);
    return get(assetId);
  }

  return { statePath, reviewPath, workerStatePath, readMergedAssets, list, get, review };
}

function registerGreenTreeAssetRoutes(app, options = {}) {
  const requirePermission = options.requirePermission;
  if (typeof requirePermission !== 'function') {
    throw new Error('registerGreenTreeAssetRoutes requires options.requirePermission');
  }
  const rootDir = path.resolve(options.rootDir || path.resolve(__dirname, '..'));
  const runtimeRoot = path.resolve(options.runtimeRoot || path.join(rootDir, '.runtime/park-pcm'));
  const store = createGreenTreeAssetStore({ runtimeRoot });
  const scriptPath = path.resolve(options.scriptPath || path.join(rootDir, 'scripts/build_green_tree_assets.py'));
  const logPath = path.join(runtimeRoot, 'green-tree-assets-worker.log');
  const pythonPath = String(options.pythonPath || process.env.GREEN_TREE_ASSET_PYTHON || '/usr/bin/python3');
  const maxJobs = integerOption(process.env.GREEN_TREE_ASSET_MAX_JOBS, DEFAULT_FLEET_WORKER_MAX_JOBS, 1, 64);
  const autoEnabled = String(process.env.GREEN_TREE_ASSET_AUTO_ENABLED || 'true').toLowerCase() !== 'false';
  const autoHour = integerOption(process.env.GREEN_TREE_ASSET_AUTO_HOUR, 2, 0, 23);
  const autoMinute = integerOption(process.env.GREEN_TREE_ASSET_AUTO_MINUTE, 30, 0, 59);

  async function startWorker(vehicleId = 'all', runOptions = {}) {
    const worker = await readJson(store.workerStatePath, { running: false });
    const lastCompletedAt = worker?.last_result?.completed_at || worker?.completed_at || '';
    if (runOptions.automatic === true && shanghaiDayKey(lastCompletedAt) === shanghaiDayKey()) {
      return { started: false, already_ran_today: true, last_completed_at: lastCompletedAt };
    }
    if (worker?.running && worker?.pid) {
      try {
        process.kill(Number(worker.pid), 0);
        return { started: false, already_running: true, worker };
      } catch (_error) {
        // A stale worker-state file is overwritten by the next worker.
      }
    }
    await fsp.mkdir(runtimeRoot, { recursive: true });
    const output = fs.openSync(logPath, 'a');
    let child;
    try {
      child = spawn(pythonPath, [
        scriptPath,
        '--vehicle', String(vehicleId || 'all'),
        '--max-jobs', String(maxJobs)
      ], {
        cwd: rootDir,
        detached: true,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        stdio: ['ignore', output, output]
      });
      child.unref();
    } finally {
      fs.closeSync(output);
    }
    return { started: true, pid: child.pid, vehicle_id: vehicleId, max_jobs: maxJobs };
  }

  app.get('/api/park-pcm/green/tree-assets', requirePermission('vehicle:read'), async (req, res) => {
    try {
      const payload = await store.list({
        vehicle_id: req.query?.vehicle_id,
        include_rejected: String(req.query?.include_rejected || '') === 'true',
        limit: req.query?.limit
      });
      return res.json({ ok: true, ...payload });
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message || 'green_tree_assets_failed' });
    }
  });

  app.get('/api/park-pcm/green/tree-assets/status', requirePermission('vehicle:read'), async (_req, res) => {
    try {
      const payload = await store.list({ include_rejected: true, limit: 1000 });
      return res.json({ ok: true, summary: payload.summary, worker: payload.worker, updated_at: payload.updated_at });
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message || 'green_tree_asset_status_failed' });
    }
  });

  app.post('/api/park-pcm/green/tree-assets/worker/run', requirePermission('vehicle:read'), async (req, res) => {
    try {
      return res.status(202).json({ ok: true, ...(await startWorker(req.body?.vehicle_id || 'all')) });
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message || 'green_tree_asset_worker_failed' });
    }
  });

  app.get('/api/park-pcm/green/tree-assets/:assetId', requirePermission('vehicle:read'), async (req, res) => {
    try {
      const asset = await store.get(String(req.params?.assetId || ''));
      if (!asset) return res.status(404).json({ ok: false, error: 'green_tree_asset_not_found' });
      return res.json({ ok: true, asset });
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message || 'green_tree_asset_failed' });
    }
  });

  app.patch('/api/park-pcm/green/tree-assets/:assetId/review', requirePermission('vehicle:read'), async (req, res) => {
    try {
      const asset = await store.review(String(req.params?.assetId || ''), {
        review_status: req.body?.review_status,
        review_note: req.body?.review_note,
        reviewed_by: req.jgzjAuth?.user?.username
      });
      return res.json({ ok: true, asset });
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message || 'green_tree_asset_review_failed' });
    }
  });

  if (autoEnabled) {
    const scheduleNext = () => {
      const delay = nextShanghaiRunDelayMs(Date.now(), autoHour, autoMinute);
      const timer = setTimeout(async () => {
        await startWorker('all', { automatic: true })
          .catch((error) => console.warn('green_tree_asset_auto_tick_failed', error.message));
        scheduleNext();
      }, delay);
      timer.unref?.();
    };
    scheduleNext();
  }

  return { store, startWorker };
}

module.exports = {
  ASSET_SCHEMA,
  DEFAULT_WORKER_MAX_JOBS,
  DEFAULT_FLEET_WORKER_MAX_JOBS,
  REVIEW_SCHEMA,
  createGreenTreeAssetStore,
  mergeReview,
  nextShanghaiRunDelayMs,
  normalizeReviewStatus,
  registerGreenTreeAssetRoutes,
  shanghaiDayKey,
  summarizeAssets
};
