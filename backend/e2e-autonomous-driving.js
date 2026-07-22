'use strict';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const DEFAULT_RESERVE_BYTES = 10 * GIB;
const DEFAULT_NOMINAL_RATE_MIB_S = 15;
const DEFAULT_LOW_RATE_MIB_S = 14;
const DEFAULT_HIGH_RATE_MIB_S = 16;
const DEFAULT_FRESHNESS_MS = 3 * 60 * 1000;
const DEFAULT_FLEET_VEHICLE_IDS = Object.freeze([
  'BIT-0001',
  'BIT-0011',
  'BIT-0013',
  'BIT-0014',
  'BIT-0015',
  'BIT-0016',
  'BIT-0019',
  'BIT-0020',
  'BIT-0022',
  'BIT-0023',
  'BIT-0026',
  'BIT-0030',
  'BIT-0031',
  'BIT-0032',
  'BIT-0033',
  'BIT-0034',
  'BIT-0035',
  'BIT-0036',
  'BIT-0037',
  'BIT-0038',
  'BIT-0039',
  'BIT-0040',
  'BIT-0041',
  'BIT-0042',
  'BIT-0043',
  'BIT-0044',
  'BIT-0045',
  'BIT-0046',
  'BIT-0047'
]);

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstFinite(...values) {
  for (const value of values) {
    const number = finiteNumber(value);
    if (number !== null) {
      return number;
    }
  }
  return null;
}

function normalizeMount(raw, source) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const totalBytes = firstFinite(raw.total_bytes, raw.total, raw.size_bytes, raw.size);
  const freeBytes = firstFinite(
    raw.free_bytes,
    raw.available_bytes,
    raw.avail_bytes,
    raw.free,
    raw.available
  );
  const usedBytes = firstFinite(
    raw.used_bytes,
    raw.used,
    totalBytes !== null && freeBytes !== null ? totalBytes - freeBytes : null
  );
  if (totalBytes === null || totalBytes <= 0 || freeBytes === null || freeBytes < 0) {
    return null;
  }

  const mountpoint = String(
    raw.mountpoint || raw.mount_point || raw.mount || raw.path || raw.target || ''
  ).trim();
  const percent = firstFinite(
    raw.percent,
    raw.use_percent,
    totalBytes > 0 && usedBytes !== null ? (usedBytes / totalBytes) * 100 : null
  );
  return {
    mountpoint,
    filesystem: String(raw.filesystem || raw.device || raw.source || '').trim() || null,
    total_bytes: Math.round(totalBytes),
    used_bytes: Math.max(0, Math.round(usedBytes === null ? totalBytes - freeBytes : usedBytes)),
    free_bytes: Math.max(0, Math.round(freeBytes)),
    percent: percent === null ? null : Math.max(0, Math.min(100, percent)),
    source
  };
}

function mountRank(mount) {
  const source = String(mount?.source || '').toLowerCase();
  const mountpoint = String(mount?.mountpoint || '').replace(/\/+$/, '') || '/';
  if (source.includes('capture_disk')) return 120;
  if (source.includes('disk_home') || source.includes('home_disk')) return 115;
  if (mountpoint === '/home') return 110;
  if (mountpoint === '/home/nvidia') return 108;
  if (mountpoint.startsWith('/home/')) return 105;
  if (mountpoint === '/') return 10;
  return 30;
}

function selectMediaDisk(vehicle) {
  const snapshot = vehicle?.snapshot && typeof vehicle.snapshot === 'object' ? vehicle.snapshot : {};
  const system = snapshot.system && typeof snapshot.system === 'object' ? snapshot.system : {};
  const storage = system.storage && typeof system.storage === 'object' ? system.storage : {};
  const candidates = [];

  [
    ['system.capture_disk', system.capture_disk],
    ['system.disk_home', system.disk_home],
    ['system.home_disk', system.home_disk],
    ['system.storage.capture_disk', storage.capture_disk],
    ['system.storage.home_disk', storage.home_disk]
  ].forEach(([source, raw]) => {
    const mount = normalizeMount(raw, source);
    if (mount) candidates.push(mount);
  });

  [
    ['system.disks', system.disks],
    ['system.filesystems', system.filesystems],
    ['system.mounts', system.mounts],
    ['system.storage.disks', storage.disks],
    ['system.storage.mounts', storage.mounts]
  ].forEach(([source, values]) => {
    if (!Array.isArray(values)) return;
    values.forEach((raw, index) => {
      const mount = normalizeMount(raw, `${source}[${index}]`);
      if (mount) candidates.push(mount);
    });
  });

  const root = normalizeMount(system.disk_root, 'system.disk_root');
  if (root) {
    root.mountpoint = root.mountpoint || '/';
    candidates.push(root);
  }

  if (!candidates.length) {
    return null;
  }
  candidates.sort((left, right) => mountRank(right) - mountRank(left));
  const selected = candidates[0];
  const rank = mountRank(selected);
  return {
    ...selected,
    preferred_capture_mount: rank >= 100,
    source_quality: rank >= 100 ? 'capture_mount' : selected.mountpoint === '/' ? 'root_fallback' : 'other_mount'
  };
}

function estimateDuration(collectableBytes, rateMibS) {
  const rate = finiteNumber(rateMibS);
  if (collectableBytes === null || !rate || rate <= 0) {
    return null;
  }
  return collectableBytes / (rate * MIB);
}

function mergeFleetInventory(vehicles, fleetVehicleIds = DEFAULT_FLEET_VEHICLE_IDS) {
  const liveVehicles = Array.isArray(vehicles) ? vehicles : [];
  const byId = new Map();
  liveVehicles.forEach((vehicle) => {
    const vehicleId = String(vehicle?.vehicle_id || vehicle?.plate_number || '').trim().toUpperCase();
    if (!/^BIT-\d{4}$/.test(vehicleId)) return;
    const previous = byId.get(vehicleId);
    const previousTime = Date.parse(String(previous?.last_seen || '')) || 0;
    const nextTime = Date.parse(String(vehicle?.last_seen || '')) || 0;
    if (!previous || nextTime >= previousTime) {
      byId.set(vehicleId, { ...vehicle, vehicle_id: vehicleId, _e2e_inventory_only: false });
    }
  });

  const orderedIds = [];
  const seen = new Set();
  [...(Array.isArray(fleetVehicleIds) ? fleetVehicleIds : []), ...byId.keys()].forEach((value) => {
    const vehicleId = String(value || '').trim().toUpperCase();
    if (!/^BIT-\d{4}$/.test(vehicleId) || seen.has(vehicleId)) return;
    seen.add(vehicleId);
    orderedIds.push(vehicleId);
  });

  return orderedIds.map((vehicleId) => byId.get(vehicleId) || {
    vehicle_id: vehicleId,
    plate_number: vehicleId,
    _e2e_inventory_only: true
  });
}

function buildFleetStorageSnapshot(vehicles, options = {}) {
  const nowMs = finiteNumber(options.nowMs) ?? Date.now();
  const reserveBytes = finiteNumber(options.reserveBytes) ?? DEFAULT_RESERVE_BYTES;
  const nominalRateMibS = finiteNumber(options.nominalRateMibS) ?? DEFAULT_NOMINAL_RATE_MIB_S;
  const lowRateMibS = finiteNumber(options.lowRateMibS) ?? DEFAULT_LOW_RATE_MIB_S;
  const highRateMibS = finiteNumber(options.highRateMibS) ?? DEFAULT_HIGH_RATE_MIB_S;
  const freshnessMs = finiteNumber(options.freshnessMs) ?? DEFAULT_FRESHNESS_MS;
  const rows = (Array.isArray(vehicles) ? vehicles : []).map((vehicle) => {
    const vehicleId = String(vehicle?.vehicle_id || vehicle?.plate_number || '').trim() || 'UNKNOWN';
    const lastSeenMs = Date.parse(String(vehicle?.last_seen || ''));
    const online = Number.isFinite(lastSeenMs) && nowMs - lastSeenMs <= freshnessMs;
    const disk = selectMediaDisk(vehicle);
    const collectableBytes = disk ? Math.max(0, disk.free_bytes - reserveBytes) : null;
    return {
      vehicle_id: vehicleId,
      plate_number: String(vehicle?.plate_number || vehicleId),
      agent_registered: vehicle?._e2e_inventory_only !== true,
      online,
      last_seen: vehicle?.last_seen || null,
      snapshot_at: vehicle?.snapshot?.generated_at || vehicle?.snapshot?.system?.generated_at || null,
      hostname: vehicle?.snapshot?.system?.hostname || vehicle?.heartbeat?.hostname || null,
      cpu_percent: firstFinite(vehicle?.snapshot?.system?.cpu?.percent, vehicle?.heartbeat?.cpu_percent),
      memory_percent: firstFinite(
        vehicle?.snapshot?.system?.memory?.percent,
        vehicle?.heartbeat?.memory_percent
      ),
      storage: disk,
      reserve_bytes: reserveBytes,
      collectable_bytes: collectableBytes,
      estimated_seconds: {
        nominal: estimateDuration(collectableBytes, nominalRateMibS),
        optimistic: estimateDuration(collectableBytes, lowRateMibS),
        conservative: estimateDuration(collectableBytes, highRateMibS)
      }
    };
  });

  rows.sort((left, right) => left.vehicle_id.localeCompare(right.vehicle_id, 'en', { numeric: true }));
  const measurable = rows.filter((row) => row.storage);
  const captureMountRows = measurable.filter((row) => row.storage.preferred_capture_mount);
  const totalCollectableBytes = captureMountRows.reduce(
    (sum, row) => sum + (row.collectable_bytes || 0),
    0
  );
  return {
    generated_at: new Date(nowMs).toISOString(),
    reserve_bytes: reserveBytes,
    rate_assumption_mib_s: {
      low: lowRateMibS,
      nominal: nominalRateMibS,
      high: highRateMibS,
      scope: 'raw_pointcloud_localization_reference_line_boundaries_adc_trajectory_no_video'
    },
    summary: {
      vehicle_count: rows.length,
      online_count: rows.filter((row) => row.online).length,
      measurable_count: measurable.length,
      capture_mount_count: captureMountRows.length,
      root_fallback_count: measurable.filter((row) => row.storage.source_quality === 'root_fallback').length,
      total_collectable_bytes: totalCollectableBytes,
      estimated_nominal_seconds: estimateDuration(totalCollectableBytes, nominalRateMibS)
    },
    vehicles: rows
  };
}

function registerE2eAutonomousDrivingRoutes(app, options = {}) {
  if (!app || typeof app.get !== 'function') {
    throw new TypeError('express_app_required');
  }
  if (typeof options.listVehicles !== 'function') {
    throw new TypeError('list_vehicles_callback_required');
  }
  const requirePermission = options.requirePermission;
  if (typeof requirePermission !== 'function') {
    throw new TypeError('permission_middleware_required');
  }

  app.get(
    '/api/e2e-autonomous-driving/fleet-storage',
    requirePermission('page:end-to-end-autonomous-driving:view'),
    async (_req, res) => {
      res.setHeader('Cache-Control', 'private, no-store');
      try {
        const vehicles = mergeFleetInventory(
          await options.listVehicles(),
          options.fleetVehicleIds || DEFAULT_FLEET_VEHICLE_IDS
        );
        return res.json({
          ok: true,
          ...buildFleetStorageSnapshot(vehicles, options)
        });
      } catch (error) {
        return res.status(502).json({
          ok: false,
          error: 'e2e_fleet_storage_failed',
          detail: error?.message || '车辆 Media 容量读取失败。'
        });
      }
    }
  );
}

module.exports = {
  DEFAULT_FLEET_VEHICLE_IDS,
  DEFAULT_HIGH_RATE_MIB_S,
  DEFAULT_LOW_RATE_MIB_S,
  DEFAULT_NOMINAL_RATE_MIB_S,
  DEFAULT_RESERVE_BYTES,
  buildFleetStorageSnapshot,
  mergeFleetInventory,
  normalizeMount,
  registerE2eAutonomousDrivingRoutes,
  selectMediaDisk
};
