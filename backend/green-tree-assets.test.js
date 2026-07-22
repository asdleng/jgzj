const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ASSET_SCHEMA,
  DEFAULT_FLEET_WORKER_MAX_JOBS,
  DEFAULT_WORKER_MAX_JOBS,
  createGreenTreeAssetStore,
  groupPhysicalTreeAssets,
  nextShanghaiRunDelayMs,
  normalizeReviewStatus,
  shanghaiDayKey,
  summarizeAssets
} = require('./green-tree-assets');

test('daily worker capacity covers dense two-meter patrol anchors', () => {
  assert.equal(DEFAULT_WORKER_MAX_JOBS, 40);
  assert.equal(DEFAULT_FLEET_WORKER_MAX_JOBS, 8);
});

async function fixture() {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'green-tree-assets-'));
  const statePath = path.join(runtimeRoot, 'green-tree-assets-state.json');
  await fs.writeFile(statePath, JSON.stringify({
    schema: ASSET_SCHEMA,
    updated_at: '2026-07-21T10:00:00Z',
    assets: {
      'TREE-0042-A': {
        asset_id: 'TREE-0042-A', vehicle_id: 'BIT-0042', status: 'auto_confirmed', review_status: 'unreviewed',
        last_seen: '2026-07-21T09:00:00Z', observation_count: 4, day_count: 4, scene_id: 'BIT-0042-S1', observations: []
      },
      'TREE-0042-B': {
        asset_id: 'TREE-0042-B', vehicle_id: 'BIT-0042', status: 'auto_matched', review_status: 'unreviewed',
        last_seen: '2026-07-21T08:00:00Z', observation_count: 3, day_count: 3, scene_id: 'BIT-0042-S2', observations: []
      }
    }
  }), 'utf8');
  return { runtimeRoot, store: createGreenTreeAssetStore({ runtimeRoot }) };
}

test('review statuses are strict', () => {
  assert.equal(normalizeReviewStatus('confirmed'), 'confirmed');
  assert.equal(normalizeReviewStatus('REJECTED'), 'rejected');
  assert.equal(normalizeReviewStatus('approved'), '');
});

test('automatic schedule uses one Shanghai low-traffic slot per day', () => {
  const before = Date.parse('2026-07-21T18:00:00Z'); // 02:00 on July 22 in Shanghai.
  const after = Date.parse('2026-07-21T19:00:00Z'); // 03:00 on July 22 in Shanghai.
  assert.equal(nextShanghaiRunDelayMs(before, 2, 30), 30 * 60 * 1000);
  assert.equal(nextShanghaiRunDelayMs(after, 2, 30), 23.5 * 60 * 60 * 1000);
  assert.equal(shanghaiDayKey('2026-07-21T18:30:00Z'), '2026-07-22');
});

test('legacy auto_confirmed is exposed as auto_matched', async (t) => {
  const { runtimeRoot, store } = await fixture();
  t.after(() => fs.rm(runtimeRoot, { recursive: true, force: true }));
  const result = await store.list({ vehicle_id: 'BIT-0042' });
  assert.equal(result.assets.length, 2);
  assert.equal(result.assets[0].status, 'auto_matched');
  assert.equal(result.summary.needs_review_count, 2);
  assert.equal(result.global_identity_confirmed, false);
});

test('review sidecar survives without changing generated state', async (t) => {
  const { runtimeRoot, store } = await fixture();
  t.after(() => fs.rm(runtimeRoot, { recursive: true, force: true }));
  const reviewed = await store.review('TREE-0042-A', {
    review_status: 'confirmed', review_note: '树干和滑梯关系一致', reviewed_by: 'tester'
  });
  assert.equal(reviewed.review_status, 'confirmed');
  assert.equal(reviewed.reviewed_by, 'tester');
  const generated = JSON.parse(await fs.readFile(store.statePath, 'utf8'));
  assert.equal(generated.assets['TREE-0042-A'].review_status, 'unreviewed');
});

test('rejected assets are hidden by default but remain auditable', async (t) => {
  const { runtimeRoot, store } = await fixture();
  t.after(() => fs.rm(runtimeRoot, { recursive: true, force: true }));
  await store.review('TREE-0042-B', { review_status: 'rejected', reviewed_by: 'tester' });
  assert.deepEqual((await store.list()).assets.map((item) => item.asset_id), ['TREE-0042-A']);
  assert.equal((await store.list({ include_rejected: true })).summary.rejected_count, 1);
});

test('summary counts observations and multi-day tracks', () => {
  assert.deepEqual(summarizeAssets([
    { status: 'auto_matched', review_status: 'confirmed', observation_count: 4, day_count: 4 },
    { status: 'auto_matched', review_status: 'unreviewed', observation_count: 3, day_count: 1 }
  ]), {
    asset_count: 2,
    auto_matched_count: 2,
    human_confirmed_count: 1,
    needs_review_count: 1,
    rejected_count: 0,
    observation_count: 7,
    multi_day_count: 1,
    vehicle_count: 0,
    scene_count: 0
  });
});

test('physical tree grouping keeps all station views under one entity', () => {
  const grouped = groupPhysicalTreeAssets([
    {
      asset_id: 'TREE-A', physical_tree_id: 'TREE-A', vehicle_id: 'BIT-0042', scene_id: 'S1', created_at: '2026-07-20T00:00:00Z',
      observations: [{ observation_id: 'O1', date: '2026-07-20', collected_at: '2026-07-20T08:00:00Z' }]
    },
    {
      asset_id: 'TREE-B', physical_tree_id: 'TREE-A', vehicle_id: 'BIT-0042', scene_id: 'S2', created_at: '2026-07-21T00:00:00Z',
      observations: [{ observation_id: 'O2', date: '2026-07-21', collected_at: '2026-07-21T08:00:00Z' }]
    }
  ]);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].physical_tree_view_count, 2);
  assert.deepEqual(grouped[0].physical_tree_member_ids, ['TREE-A', 'TREE-B']);
  assert.equal(grouped[0].observation_count, 2);
  assert.equal(grouped[0].day_count, 2);
  assert.deepEqual(grouped[0].scene_ids, ['S1', 'S2']);
  assert.equal(grouped[0].identity_scope, 'cross_station_tree_entity_candidate_v1');
});

test('summary counts every scene represented by a grouped physical tree', () => {
  assert.equal(summarizeAssets([
    { asset_id: 'TREE-A', scene_id: 'S1', scene_ids: ['S1', 'S2'] },
    { asset_id: 'TREE-C', scene_id: 'S3' }
  ]).scene_count, 3);
});
