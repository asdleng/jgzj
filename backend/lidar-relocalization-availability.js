const fs = require('fs/promises');
const path = require('path');

const ACTIVE_UPLOAD_STATUSES = new Set([
  'running',
  'started',
  'uploading',
  'upload_in_progress',
  'monitoring'
]);

function normalizeVehicleId(value) {
  return String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_.:-]/g, '')
    .slice(0, 80);
}

function formatAssetKinds(kinds) {
  const ordered = ['map', 'keyframes'].filter((kind) => kinds.has(kind));
  if (ordered.length === 2) return '地图和关键帧';
  if (ordered[0] === 'keyframes') return '关键帧';
  return '地图';
}

function summarizeQueueTasks(tasks) {
  const rows = Array.isArray(tasks) ? tasks : [];
  const waitingKinds = new Set();
  const uploadingKinds = new Set();
  const failedKinds = new Set();
  let uploadedCount = 0;

  for (const row of rows) {
    const kind = row?.kind === 'keyframes' ? 'keyframes' : 'map';
    const status = String(row?.task?.status || '').trim().toLowerCase();
    if (status === 'uploaded' || status === 'completed' || status === 'done') {
      uploadedCount += 1;
    } else if (status === 'waiting_for_stable_charging' || status.startsWith('waiting')) {
      waitingKinds.add(kind);
    } else if (status.includes('fail') || status === 'error') {
      failedKinds.add(kind);
    } else if (ACTIVE_UPLOAD_STATUSES.has(status) || status) {
      uploadingKinds.add(kind);
    }
  }

  return {
    waitingKinds,
    uploadingKinds,
    failedKinds,
    uploadedCount,
    totalCount: rows.length
  };
}

function makeRelocalizationStatus({
  cloudVehicle,
  indexReady,
  dynamicIndexed,
  blockedReason,
  failedValidation,
  queueTasks,
  nowMs,
  staleAfterMs
}) {
  const lastSeenMs = Date.parse(cloudVehicle?.last_seen || '');
  const online = Boolean(
    cloudVehicle &&
      Number.isFinite(lastSeenMs) &&
      nowMs - lastSeenMs >= 0 &&
      nowMs - lastSeenMs <= staleAfterMs
  );
  const linkReady = Boolean(
    online &&
      cloudVehicle?.has_heartbeat === true &&
      cloudVehicle?.has_snapshot === true &&
      cloudVehicle?.has_telemetry === true
  );
  const queue = summarizeQueueTasks(queueTasks);
  const base = {
    usable: false,
    status: 'not_indexed',
    status_label: '未建检索库',
    detail: '尚未建立已验证的 BEVPlace++ + LCR-Net 检索库。',
    online,
    index_ready: indexReady,
    link_ready: linkReady,
    index_source: dynamicIndexed ? 'validated_dynamic_registry' : indexReady ? 'static_index' : null
  };

  if (blockedReason) {
    const mismatch = blockedReason === 'a100_map_index_mismatch';
    return {
      ...base,
      status: 'blocked',
      status_label: '安全封禁',
      detail: mismatch
        ? '安全封禁：当前地图与 A100 检索库版本不一致。'
        : '安全封禁：重复场景误匹配超过上线门限。',
      blocked_reason: blockedReason
    };
  }

  if (indexReady) {
    if (!online) {
      return {
        ...base,
        status: 'offline',
        status_label: '离线',
        detail: '已有已验证检索库，但车辆当前未连接 cloud-agent。'
      };
    }
    if (!linkReady) {
      return {
        ...base,
        status: 'link_recovering',
        status_label: '链路恢复中',
        detail: '已有已验证检索库，车辆在线，但心跳、快照或遥测尚未全部恢复。'
      };
    }
    return {
      ...base,
      usable: true,
      status: 'ready',
      status_label: '可试',
      detail: '已验证检索库和车端当前帧抓取链路均就绪。'
    };
  }

  if (failedValidation) {
    return {
      ...base,
      status: 'validation_failed',
      status_label: '验证未通过',
      detail: '地图和关键帧已处理，但严格全链路验证未通过，暂不允许测试。'
    };
  }

  if (queue.failedKinds.size) {
    const assets = formatAssetKinds(queue.failedKinds);
    return {
      ...base,
      status: 'upload_failed',
      status_label: `${assets}上传失败`,
      detail: `${assets}上传失败，等待下次充电窗口重试。`
    };
  }

  if (queue.uploadingKinds.size) {
    const assets = formatAssetKinds(queue.uploadingKinds);
    return {
      ...base,
      status: 'uploading',
      status_label: `正在上传${assets}`,
      detail: `${assets}正在限速上传，完成后还需严格验证和建库。`
    };
  }

  if (queue.waitingKinds.size) {
    const assets = formatAssetKinds(queue.waitingKinds);
    return {
      ...base,
      status: 'waiting_upload',
      status_label: `待充电上传${assets}`,
      detail: `${assets}等待车辆稳定充电后限速上传，完成后还需严格验证和建库。`
    };
  }

  if (queue.totalCount > 0 && queue.uploadedCount === queue.totalCount) {
    return {
      ...base,
      status: 'pending_validation',
      status_label: '待严格验证',
      detail: '地图数据已上传，正在等待严格验证、描述子生成和注册。'
    };
  }

  return base;
}

function buildLidarRelocalizationVehicleAvailability(options = {}) {
  const cloudVehicles = Array.isArray(options.cloudVehicles) ? options.cloudVehicles : [];
  const staticIndexed = new Set(Array.from(options.staticIndexedVehicles || []).map(normalizeVehicleId));
  const dynamicIndexed = new Set(Array.from(options.dynamicIndexedVehicles || []).map(normalizeVehicleId));
  const blockedVehicles = new Map(
    Array.from(options.blockedVehicles || []).map(([vehicleId, reason]) => [normalizeVehicleId(vehicleId), reason])
  );
  const failedVehicleIds = new Set(Array.from(options.failedVehicleIds || []).map(normalizeVehicleId));
  const queueTasks = options.queueTasks && typeof options.queueTasks === 'object' ? options.queueTasks : {};
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const staleAfterMs = Number.isFinite(Number(options.staleAfterMs))
    ? Math.max(1000, Number(options.staleAfterMs))
    : 5 * 60 * 1000;

  const cloudById = new Map();
  for (const vehicle of cloudVehicles) {
    const vehicleId = normalizeVehicleId(vehicle?.vehicle_id || vehicle?.plate_number);
    if (!vehicleId) continue;
    const previous = cloudById.get(vehicleId);
    const previousSeen = Date.parse(previous?.last_seen || '') || 0;
    const nextSeen = Date.parse(vehicle?.last_seen || '') || 0;
    if (!previous || nextSeen >= previousSeen) cloudById.set(vehicleId, vehicle);
  }

  const tasksByVehicle = new Map();
  for (const [taskId, task] of Object.entries(queueTasks)) {
    const separator = taskId.lastIndexOf(':');
    const vehicleId = normalizeVehicleId(separator >= 0 ? taskId.slice(0, separator) : taskId);
    const kind = separator >= 0 ? taskId.slice(separator + 1) : 'map';
    if (!vehicleId) continue;
    if (!tasksByVehicle.has(vehicleId)) tasksByVehicle.set(vehicleId, []);
    tasksByVehicle.get(vehicleId).push({ kind, task });
  }

  const vehicleIds = new Set([
    ...cloudById.keys(),
    ...staticIndexed,
    ...dynamicIndexed,
    ...blockedVehicles.keys(),
    ...failedVehicleIds,
    ...tasksByVehicle.keys()
  ]);

  const vehicles = Array.from(vehicleIds)
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right))
    .map((vehicleId) => {
      const cloudVehicle = cloudById.get(vehicleId) || null;
      const isDynamic = dynamicIndexed.has(vehicleId);
      const indexReady = isDynamic || staticIndexed.has(vehicleId);
      const configuredBlock = blockedVehicles.get(vehicleId) || null;
      const blockedReason = isDynamic && configuredBlock === 'a100_map_index_mismatch'
        ? null
        : configuredBlock;
      return {
        vehicle_id: vehicleId,
        cloud_vehicle: cloudVehicle,
        relocalization: makeRelocalizationStatus({
          cloudVehicle,
          indexReady,
          dynamicIndexed: isDynamic,
          blockedReason,
          failedValidation: failedVehicleIds.has(vehicleId),
          queueTasks: tasksByVehicle.get(vehicleId) || [],
          nowMs,
          staleAfterMs
        })
      };
    });

  const usable = vehicles.filter((vehicle) => vehicle.relocalization.usable).length;
  return {
    vehicles,
    summary: {
      total: vehicles.length,
      usable,
      unavailable: vehicles.length - usable,
      generated_at: new Date(nowMs).toISOString()
    }
  };
}

async function readLidarRelocalizationAvailabilityState(options = {}) {
  let queueTasks = {};
  let queueUpdatedAt = null;
  try {
    const payload = JSON.parse(await fs.readFile(options.queueStatePath, 'utf8'));
    queueTasks = payload?.tasks && typeof payload.tasks === 'object' ? payload.tasks : {};
    queueUpdatedAt = payload?.updated_at || null;
  } catch (_error) {
    queueTasks = {};
  }

  const failedVehicleIds = new Set();
  try {
    const entries = await fs.readdir(options.candidateStateDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = entry.name.match(/^([A-Za-z0-9_.:-]+)\.failed$/);
      if (match) failedVehicleIds.add(normalizeVehicleId(match[1]));
    }
  } catch (_error) {
    // Runtime state is optional; absence means there are no current failed candidates.
  }

  return {
    queueTasks,
    queueUpdatedAt,
    failedVehicleIds,
    source: {
      queue_state: path.resolve(options.queueStatePath),
      candidate_state: path.resolve(options.candidateStateDir)
    }
  };
}

module.exports = {
  buildLidarRelocalizationVehicleAvailability,
  readLidarRelocalizationAvailabilityState
};
