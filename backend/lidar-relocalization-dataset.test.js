const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  normalizeSessionId,
  normalizeVehicleId,
  readPcdPreview,
  scanPatrolDataset
} = require('./lidar-relocalization-dataset');

function binaryPcd(points) {
  const header = Buffer.from(
    [
      '# .PCD v0.7',
      'VERSION 0.7',
      'FIELDS x y z intensity',
      'SIZE 4 4 4 4',
      'TYPE F F F F',
      'COUNT 1 1 1 1',
      `WIDTH ${points.length}`,
      'HEIGHT 1',
      `POINTS ${points.length}`,
      'DATA binary',
      ''
    ].join('\n')
  );
  const payload = Buffer.alloc(points.length * 16);
  points.forEach((point, index) => {
    point.forEach((value, field) => payload.writeFloatLE(value, index * 16 + field * 4));
  });
  return Buffer.concat([header, payload]);
}

test('normalizes only supported vehicle and session identifiers', () => {
  assert.equal(normalizeVehicleId('bit-0037'), 'BIT-0037');
  assert.equal(normalizeVehicleId('../BIT-0037'), '');
  assert.equal(normalizeSessionId('session_20260714_110104'), 'session_20260714_110104');
  assert.equal(normalizeSessionId('../../session_20260714_110104'), '');
});

test('scans complete raw-rslidar sessions and previews binary PCD points', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lidar-dataset-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const patrolRoot = path.join(root, 'patrol_reloc_samples');
  const session = path.join(patrolRoot, 'BIT-0037', 'session_20260714_110104');
  await fs.mkdir(path.join(session, 'clouds'), { recursive: true });
  await fs.mkdir(path.join(session, 'metadata'), { recursive: true });
  await fs.mkdir(path.join(root, 'vehicle_maps', 'BIT-0037'), { recursive: true });
  await fs.writeFile(path.join(root, 'vehicle_maps', 'BIT-0037', 'GlobalMap.pcd'), 'map');
  await fs.writeFile(
    path.join(session, 'manifest.json'),
    JSON.stringify({ cloud_topic: '/rslidar_points32', created_at: '2026-07-14 11:01:04 CST' })
  );

  const points = [
    [1, 2, 0.2, 10],
    [3, -4, 1.2, 20],
    [120, 0, 0, 30]
  ];
  const pcdName = 'cloud_001.pcd';
  const pcd = binaryPcd(points);
  await fs.writeFile(path.join(session, 'clouds', pcdName), pcd);
  const sample = {
    sample_index: 0,
    saved_at: '2026-07-14 11:01:14 CST',
    location: { w_pos_x: 12.5, w_pos_y: -3.25, w_pos_z: 0.1, heading: 1.2, reliable: true },
    cloud: {
      pcd_path: `/vehicle/${pcdName}`,
      pcd_bytes: pcd.length,
      saved_points: points.length,
      frame_id: 'rslidar32'
    }
  };
  await fs.writeFile(path.join(session, 'samples.jsonl'), `${JSON.stringify(sample)}\n`);
  await fs.writeFile(path.join(session, 'metadata', 'sample_00000.json'), JSON.stringify(sample));

  const overview = await scanPatrolDataset(patrolRoot, {
    vehicleMapRoot: path.join(root, 'vehicle_maps')
  });
  assert.equal(overview.summary.vehicle_count, 1);
  assert.equal(overview.summary.frame_count, 1);
  assert.equal(overview.summary.complete_frame_count, 1);
  assert.equal(overview.summary.map_ready_vehicle_count, 1);
  assert.equal(overview.vehicles[0].sessions[0].integrity_complete, true);
  assert.deepEqual(overview.vehicles[0].sessions[0].last_pose, {
    x: 12.5,
    y: -3.25,
    z: 0.1,
    yaw: 1.2,
    reliable: true
  });

  const preview = await readPcdPreview(path.join(session, 'clouds', pcdName), {
    maxPoints: 500,
    maxRangeM: 80
  });
  assert.equal(preview.source_point_count, 3);
  assert.equal(preview.preview_point_count, 2);
  assert.deepEqual(preview.points[0], [1, 2, 0.2, 10]);
  assert.deepEqual(preview.points[1], [3, -4, 1.2, 20]);
});

test('exposes only PCD frames already present during an interrupted sync', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lidar-dataset-partial-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const patrolRoot = path.join(root, 'patrol_reloc_samples');
  const session = path.join(patrolRoot, 'BIT-0013', 'session_20260715_120000');
  await fs.mkdir(path.join(session, 'clouds'), { recursive: true });
  await fs.mkdir(path.join(session, 'metadata'), { recursive: true });
  await fs.writeFile(
    path.join(session, 'manifest.json'),
    JSON.stringify({ cloud_topic: '/rslidar_points32' })
  );

  const uploadedName = 'cloud_000.pcd';
  const pendingName = 'cloud_001.pcd';
  const uploadedPcd = binaryPcd([[2, 1, 0, 8]]);
  await fs.writeFile(path.join(session, 'clouds', uploadedName), uploadedPcd);
  const samples = [uploadedName, pendingName].map((name, index) => ({
    sample_index: index,
    saved_at: `2026-07-15 12:00:0${index} CST`,
    location: { w_pos_x: index, w_pos_y: 0, heading: 0, reliable: true },
    cloud: {
      pcd_path: `/vehicle/${name}`,
      pcd_bytes: index === 0 ? uploadedPcd.length : 9999,
      saved_points: index === 0 ? 1 : 999
    }
  }));
  await fs.writeFile(path.join(session, 'samples.jsonl'), `${samples.map(JSON.stringify).join('\n')}\n`);
  await Promise.all(samples.map((sample, index) =>
    fs.writeFile(path.join(session, 'metadata', `sample_${String(index).padStart(5, '0')}.json`), JSON.stringify(sample))
  ));

  const overview = await scanPatrolDataset(patrolRoot);
  const scannedSession = overview.vehicles[0].sessions[0];
  assert.equal(scannedSession.frame_count, 1);
  assert.equal(scannedSession.sample_count, 2);
  assert.equal(scannedSession.point_count, 1);
  assert.equal(scannedSession.pcd_bytes, uploadedPcd.length);
  assert.equal(scannedSession.integrity_complete, false);
  assert.equal(scannedSession.preview_index, 0);
});
