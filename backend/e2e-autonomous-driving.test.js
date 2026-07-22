const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_HIGH_RATE_MIB_S,
  DEFAULT_LOW_RATE_MIB_S,
  DEFAULT_NOMINAL_RATE_MIB_S,
  DEFAULT_RESERVE_BYTES,
  buildFleetStorageSnapshot,
  mergeFleetInventory,
  selectMediaDisk
} = require('./e2e-autonomous-driving');

test('no-video capacity uses the measured point-cloud-dominated write rate', () => {
  assert.equal(DEFAULT_NOMINAL_RATE_MIB_S, 15);
  assert.equal(DEFAULT_LOW_RATE_MIB_S, 14);
  assert.equal(DEFAULT_HIGH_RATE_MIB_S, 16);
});

test('fleet inventory keeps every known BIT vehicle and excludes other platforms', () => {
  const vehicles = mergeFleetInventory(
    [
      { vehicle_id: 'BIT-0046', last_seen: '2026-07-22T18:00:00Z' },
      { vehicle_id: 'FTUGV-002', last_seen: '2026-07-22T18:00:00Z' }
    ],
    ['BIT-0014', 'BIT-0046']
  );

  assert.deepEqual(vehicles.map((vehicle) => vehicle.vehicle_id), ['BIT-0014', 'BIT-0046']);
  assert.equal(vehicles[0]._e2e_inventory_only, true);
  assert.equal(vehicles[1]._e2e_inventory_only, false);
});

test('selectMediaDisk prefers /home capture storage over root', () => {
  const disk = selectMediaDisk({
    snapshot: {
      system: {
        disk_root: {
          total_bytes: 60 * 1024 ** 3,
          used_bytes: 20 * 1024 ** 3,
          free_bytes: 40 * 1024 ** 3
        },
        mounts: [
          {
            mountpoint: '/home',
            filesystem: '/dev/nvme0n1p8',
            total_bytes: 400 * 1024 ** 3,
            used_bytes: 100 * 1024 ** 3,
            free_bytes: 300 * 1024 ** 3
          }
        ]
      }
    }
  });

  assert.equal(disk.mountpoint, '/home');
  assert.equal(disk.preferred_capture_mount, true);
  assert.equal(disk.source_quality, 'capture_mount');
});

test('selectMediaDisk marks legacy root-only snapshots as fallback', () => {
  const disk = selectMediaDisk({
    snapshot: {
      system: {
        disk_root: {
          total_bytes: 60 * 1024 ** 3,
          used_bytes: 20 * 1024 ** 3,
          free_bytes: 40 * 1024 ** 3,
          percent: 33.3
        }
      }
    }
  });

  assert.equal(disk.mountpoint, '/');
  assert.equal(disk.preferred_capture_mount, false);
  assert.equal(disk.source_quality, 'root_fallback');
});

test('fleet snapshot always subtracts the 10 GiB hard reserve', () => {
  const nowMs = Date.parse('2026-07-22T16:00:00Z');
  const payload = buildFleetStorageSnapshot(
    [
      {
        vehicle_id: 'BIT-0046',
        last_seen: '2026-07-22T15:59:30Z',
        snapshot: {
          system: {
            disk_home: {
              mountpoint: '/home',
              total_bytes: 400 * 1024 ** 3,
              used_bytes: 370 * 1024 ** 3,
              free_bytes: 30 * 1024 ** 3
            }
          }
        }
      }
    ],
    { nowMs }
  );

  assert.equal(payload.vehicles[0].online, true);
  assert.equal(payload.vehicles[0].reserve_bytes, DEFAULT_RESERVE_BYTES);
  assert.equal(payload.vehicles[0].collectable_bytes, 20 * 1024 ** 3);
  assert.equal(payload.summary.capture_mount_count, 1);
  assert.equal(payload.summary.total_collectable_bytes, 20 * 1024 ** 3);
});

test('fleet totals exclude root fallback values from trusted capacity', () => {
  const payload = buildFleetStorageSnapshot([
    {
      vehicle_id: 'BIT-0011',
      last_seen: new Date().toISOString(),
      snapshot: {
        system: {
          disk_root: {
            total_bytes: 60 * 1024 ** 3,
            used_bytes: 20 * 1024 ** 3,
            free_bytes: 40 * 1024 ** 3
          }
        }
      }
    }
  ]);

  assert.equal(payload.summary.root_fallback_count, 1);
  assert.equal(payload.summary.capture_mount_count, 0);
  assert.equal(payload.summary.total_collectable_bytes, 0);
});
