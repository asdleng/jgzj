const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildLidarRelocalizationVehicleAvailability,
  readLidarRelocalizationAvailabilityState
} = require('./lidar-relocalization-availability');

const NOW = Date.parse('2026-07-21T08:00:00Z');

function onlineVehicle(vehicleId, overrides = {}) {
  return {
    vehicle_id: vehicleId,
    last_seen: '2026-07-21T07:59:30Z',
    has_heartbeat: true,
    has_snapshot: true,
    has_telemetry: true,
    ...overrides
  };
}

test('classifies ready, offline, recovering and unindexed vehicles', () => {
  const result = buildLidarRelocalizationVehicleAvailability({
    cloudVehicles: [
      onlineVehicle('BIT-0001'),
      onlineVehicle('BIT-0002', { has_snapshot: false }),
      onlineVehicle('BIT-0004')
    ],
    staticIndexedVehicles: new Set(['BIT-0001', 'BIT-0002', 'BIT-0003']),
    nowMs: NOW
  });
  const byId = new Map(result.vehicles.map((vehicle) => [vehicle.vehicle_id, vehicle.relocalization]));

  assert.equal(byId.get('BIT-0001').status, 'ready');
  assert.equal(byId.get('BIT-0001').usable, true);
  assert.equal(byId.get('BIT-0002').status, 'link_recovering');
  assert.equal(byId.get('BIT-0003').status, 'offline');
  assert.equal(byId.get('BIT-0004').status, 'not_indexed');
  assert.deepEqual(result.summary, {
    total: 4,
    usable: 1,
    unavailable: 3,
    generated_at: '2026-07-21T08:00:00.000Z'
  });
});

test('dynamic validation supersedes only the old map mismatch block', () => {
  const result = buildLidarRelocalizationVehicleAvailability({
    cloudVehicles: [onlineVehicle('BIT-0037'), onlineVehicle('BIT-0026')],
    dynamicIndexedVehicles: new Set(['BIT-0037', 'BIT-0026']),
    blockedVehicles: new Map([
      ['BIT-0037', 'a100_map_index_mismatch'],
      ['BIT-0026', 'repeated_place_false_accepts']
    ]),
    nowMs: NOW
  });
  const byId = new Map(result.vehicles.map((vehicle) => [vehicle.vehicle_id, vehicle.relocalization]));

  assert.equal(byId.get('BIT-0037').status, 'ready');
  assert.equal(byId.get('BIT-0026').status, 'blocked');
});

test('reports upload and strict validation states before generic missing index', () => {
  const result = buildLidarRelocalizationVehicleAvailability({
    cloudVehicles: [onlineVehicle('BIT-0030'), onlineVehicle('BIT-0040')],
    failedVehicleIds: new Set(['BIT-0040']),
    queueTasks: {
      'BIT-0030:map': { status: 'uploaded' },
      'BIT-0030:keyframes': { status: 'waiting_for_stable_charging' },
      'BIT-0040:map': { status: 'uploaded' },
      'BIT-0040:keyframes': { status: 'uploaded' }
    },
    nowMs: NOW
  });
  const byId = new Map(result.vehicles.map((vehicle) => [vehicle.vehicle_id, vehicle.relocalization]));

  assert.equal(byId.get('BIT-0030').status, 'waiting_upload');
  assert.equal(byId.get('BIT-0030').status_label, '待充电上传关键帧');
  assert.equal(byId.get('BIT-0040').status, 'validation_failed');
});

test('reads queue tasks and only current exact failed markers', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lidar-reloc-availability-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const queuePath = path.join(root, 'queue.json');
  const candidateDir = path.join(root, 'candidates');
  await fs.mkdir(candidateDir);
  await fs.writeFile(queuePath, JSON.stringify({ updated_at: 123, tasks: { 'BIT-0030:map': { status: 'uploaded' } } }));
  await fs.writeFile(path.join(candidateDir, 'BIT-0040.failed'), 'failed');
  await fs.writeFile(path.join(candidateDir, 'BIT-0037.failed.superseded.123'), 'superseded');

  const state = await readLidarRelocalizationAvailabilityState({
    queueStatePath: queuePath,
    candidateStateDir: candidateDir
  });

  assert.equal(state.queueTasks['BIT-0030:map'].status, 'uploaded');
  assert.deepEqual(Array.from(state.failedVehicleIds), ['BIT-0040']);
});
