const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_RESERVE_BYTES,
  buildFleetStorageSnapshot,
  selectMediaDisk
} = require('./e2e-autonomous-driving');

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
