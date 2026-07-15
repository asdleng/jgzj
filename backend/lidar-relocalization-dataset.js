const fs = require('fs/promises');
const path = require('path');

const VEHICLE_ID_RE = /^BIT-\d{4}$/;
const SESSION_ID_RE = /^session_\d{8}_\d{6}$/;

function toFiniteInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function round(value, digits = 3) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const scale = 10 ** digits;
  return Math.round(number * scale) / scale;
}

function normalizeVehicleId(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return VEHICLE_ID_RE.test(normalized) ? normalized : '';
}

function normalizeSessionId(value) {
  const normalized = String(value || '').trim();
  return SESSION_ID_RE.test(normalized) ? normalized : '';
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (_error) {
    return fallback;
  }
}

async function readDir(filePath) {
  try {
    return await fs.readdir(filePath, { withFileTypes: true });
  } catch (_error) {
    return [];
  }
}

async function statFile(filePath) {
  try {
    return await fs.stat(filePath);
  } catch (_error) {
    return null;
  }
}

async function mapLimit(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function parseSampleRows(text) {
  const rows = [];
  let invalidRows = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (_error) {
      invalidRows += 1;
    }
  }
  return { rows, invalidRows };
}

function samplePose(sample) {
  const location = sample?.location || {};
  const x = Number(location.w_pos_x);
  const y = Number(location.w_pos_y);
  const z = Number(location.w_pos_z);
  const yaw = Number(location.heading);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: round(x),
    y: round(y),
    z: Number.isFinite(z) ? round(z) : null,
    yaw: Number.isFinite(yaw) ? round(yaw, 5) : null,
    reliable: location.reliable === true
  };
}

function decimateTrajectory(rows, maxPoints = 160) {
  const poses = rows.map(samplePose).filter(Boolean);
  if (poses.length <= maxPoints) return poses;
  const stride = Math.max(1, Math.ceil(poses.length / maxPoints));
  const sampled = [];
  for (let index = 0; index < poses.length; index += stride) sampled.push(poses[index]);
  const last = poses[poses.length - 1];
  if (sampled[sampled.length - 1] !== last) sampled.push(last);
  return sampled;
}

function sessionTimestamp(sessionId) {
  const match = String(sessionId || '').match(/^session_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`;
}

async function scanSession(sessionPath, vehicleId, sessionId) {
  const manifestPath = path.join(sessionPath, 'manifest.json');
  const samplesPath = path.join(sessionPath, 'samples.jsonl');
  const cloudsPath = path.join(sessionPath, 'clouds');
  const metadataPath = path.join(sessionPath, 'metadata');
  const [manifest, sampleText, cloudEntries, metadataEntries, sessionEntries, sampleStat] = await Promise.all([
    readJson(manifestPath, {}),
    fs.readFile(samplesPath, 'utf8').catch(() => ''),
    readDir(cloudsPath),
    readDir(metadataPath),
    readDir(sessionPath),
    statFile(samplesPath)
  ]);
  if (manifest?.cloud_topic !== '/rslidar_points32') return null;

  const { rows, invalidRows } = parseSampleRows(sampleText);
  const pcdNames = cloudEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.pcd'))
    .map((entry) => entry.name);
  const metadataCount = metadataEntries.filter(
    (entry) => entry.isFile() && /^sample_\d+\.json$/.test(entry.name)
  ).length;
  const tmpCount = [...cloudEntries, ...metadataEntries, ...sessionEntries].filter(
    (entry) => entry.isFile() && entry.name.endsWith('.tmp')
  ).length;
  const rowNames = rows.map((row) => path.basename(String(row?.cloud?.pcd_path || ''))).filter(Boolean);
  const pcdNameSet = new Set(pcdNames);
  const namesMatch = rowNames.length === pcdNames.length && rowNames.every((name) => pcdNameSet.has(name));
  const availableRows = rows.filter((row) =>
    pcdNameSet.has(path.basename(String(row?.cloud?.pcd_path || '')))
  );
  const pointCount = availableRows.reduce((sum, row) => sum + (Number(row?.cloud?.saved_points) || 0), 0);
  const pcdBytes = availableRows.reduce((sum, row) => sum + (Number(row?.cloud?.pcd_bytes) || 0), 0);
  const integrityComplete =
    pcdNames.length > 0 &&
    rows.length === pcdNames.length &&
    rows.length === metadataCount &&
    invalidRows === 0 &&
    namesMatch &&
    tmpCount === 0;
  const lastSample = availableRows[availableRows.length - 1] || null;
  const firstSample = availableRows[0] || null;

  if (!pcdNames.length && !rows.length) return null;
  return {
    vehicle_id: vehicleId,
    session_id: sessionId,
    created_at: manifest?.created_at || sessionTimestamp(sessionId),
    updated_at: sampleStat?.mtime?.toISOString() || null,
    cloud_topic: manifest?.cloud_topic || null,
    frame_count: availableRows.length,
    sample_count: rows.length,
    metadata_count: metadataCount,
    point_count: pointCount,
    pcd_bytes: pcdBytes,
    invalid_rows: invalidRows,
    tmp_count: tmpCount,
    integrity_complete: integrityComplete,
    progress_ratio: rows.length ? Math.min(1, availableRows.length / rows.length) : 0,
    first_saved_at: firstSample?.saved_at || null,
    last_saved_at: lastSample?.saved_at || null,
    first_pose: samplePose(firstSample),
    last_pose: samplePose(lastSample),
    trajectory: decimateTrajectory(rows),
    preview_index: Math.max(0, Math.floor(Math.max(0, availableRows.length - 1) / 2))
  };
}

async function scanPatrolDataset(rootPath, options = {}) {
  const generatedAt = new Date().toISOString();
  const vehicleMapRoot = options.vehicleMapRoot || path.join(path.dirname(rootPath), 'vehicle_maps');
  const vehicleEntries = (await readDir(rootPath))
    .filter((entry) => entry.isDirectory() && VEHICLE_ID_RE.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));

  const vehicles = await mapLimit(vehicleEntries, 4, async (vehicleEntry) => {
    const vehicleId = vehicleEntry.name;
    const vehiclePath = path.join(rootPath, vehicleId);
    const sessionEntries = (await readDir(vehiclePath))
      .filter((entry) => entry.isDirectory() && SESSION_ID_RE.test(entry.name))
      .sort((left, right) => right.name.localeCompare(left.name));
    const scanned = await mapLimit(sessionEntries, 8, (entry) =>
      scanSession(path.join(vehiclePath, entry.name), vehicleId, entry.name)
    );
    const sessions = scanned.filter(Boolean).sort((left, right) =>
      String(right.updated_at || right.created_at || '').localeCompare(String(left.updated_at || left.created_at || ''))
    );
    const mapStat = await statFile(path.join(vehicleMapRoot, vehicleId, 'GlobalMap.pcd'));
    const frameCount = sessions.reduce((sum, session) => sum + session.frame_count, 0);
    const completeFrames = sessions.reduce(
      (sum, session) => sum + (session.integrity_complete ? session.frame_count : 0),
      0
    );
    return {
      vehicle_id: vehicleId,
      frame_count: frameCount,
      complete_frame_count: completeFrames,
      pending_frame_count: Math.max(0, frameCount - completeFrames),
      session_count: sessions.length,
      complete_session_count: sessions.filter((session) => session.integrity_complete).length,
      point_count: sessions.reduce((sum, session) => sum + session.point_count, 0),
      pcd_bytes: sessions.reduce((sum, session) => sum + session.pcd_bytes, 0),
      latest_saved_at: sessions.find((session) => session.last_saved_at)?.last_saved_at || null,
      map_available: Boolean(mapStat?.isFile()),
      map_bytes: mapStat?.size || 0,
      sessions
    };
  });

  const populatedVehicles = vehicles.filter((vehicle) => vehicle.frame_count > 0);
  return {
    ok: true,
    generated_at: generatedAt,
    summary: {
      vehicle_count: populatedVehicles.length,
      session_count: populatedVehicles.reduce((sum, vehicle) => sum + vehicle.session_count, 0),
      complete_session_count: populatedVehicles.reduce(
        (sum, vehicle) => sum + vehicle.complete_session_count,
        0
      ),
      frame_count: populatedVehicles.reduce((sum, vehicle) => sum + vehicle.frame_count, 0),
      complete_frame_count: populatedVehicles.reduce(
        (sum, vehicle) => sum + vehicle.complete_frame_count,
        0
      ),
      pending_frame_count: populatedVehicles.reduce(
        (sum, vehicle) => sum + vehicle.pending_frame_count,
        0
      ),
      point_count: populatedVehicles.reduce((sum, vehicle) => sum + vehicle.point_count, 0),
      pcd_bytes: populatedVehicles.reduce((sum, vehicle) => sum + vehicle.pcd_bytes, 0),
      map_ready_vehicle_count: populatedVehicles.filter((vehicle) => vehicle.map_available).length
    },
    vehicles: populatedVehicles
  };
}

function parsePcdHeader(buffer) {
  const headerSlice = buffer.subarray(0, Math.min(buffer.length, 128 * 1024));
  const headerText = headerSlice.toString('latin1');
  const dataMatch = headerText.match(/(?:^|\r?\n)DATA\s+(ascii|binary)\s*\r?\n/i);
  if (!dataMatch || dataMatch.index === undefined) throw new Error('pcd_data_header_missing');
  const dataOffset = dataMatch.index + dataMatch[0].length;
  const values = {};
  for (const rawLine of headerText.slice(0, dataMatch.index).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const [key, ...parts] = line.split(/\s+/);
    values[key.toUpperCase()] = parts;
  }
  const fields = values.FIELDS || values.FIELD || [];
  const sizes = (values.SIZE || []).map(Number);
  const types = values.TYPE || [];
  const counts = (values.COUNT || fields.map(() => '1')).map(Number);
  if (!fields.length || sizes.length !== fields.length || types.length !== fields.length) {
    throw new Error('pcd_field_header_invalid');
  }
  let offset = 0;
  const descriptors = fields.map((name, index) => {
    const descriptor = {
      name: String(name).toLowerCase(),
      size: sizes[index],
      type: String(types[index]).toUpperCase(),
      count: counts[index] || 1,
      offset
    };
    offset += descriptor.size * descriptor.count;
    return descriptor;
  });
  const points = Number(values.POINTS?.[0]) ||
    (Number(values.WIDTH?.[0]) || 0) * (Number(values.HEIGHT?.[0]) || 1);
  return {
    dataType: dataMatch[1].toLowerCase(),
    dataOffset,
    descriptors,
    pointStep: offset,
    points
  };
}

function readPcdValue(buffer, offset, descriptor) {
  const type = descriptor.type;
  const size = descriptor.size;
  if (type === 'F' && size === 4) return buffer.readFloatLE(offset);
  if (type === 'F' && size === 8) return buffer.readDoubleLE(offset);
  if (type === 'U' && size === 1) return buffer.readUInt8(offset);
  if (type === 'U' && size === 2) return buffer.readUInt16LE(offset);
  if (type === 'U' && size === 4) return buffer.readUInt32LE(offset);
  if (type === 'I' && size === 1) return buffer.readInt8(offset);
  if (type === 'I' && size === 2) return buffer.readInt16LE(offset);
  if (type === 'I' && size === 4) return buffer.readInt32LE(offset);
  return NaN;
}

async function readPcdPreview(filePath, options = {}) {
  const maxPoints = toFiniteInteger(options.maxPoints, 8000, { min: 500, max: 12000 });
  const maxRangeM = Number.isFinite(Number(options.maxRangeM))
    ? Math.max(5, Math.min(150, Number(options.maxRangeM)))
    : 80;
  const buffer = await fs.readFile(filePath);
  const header = parsePcdHeader(buffer);
  const xField = header.descriptors.find((field) => field.name === 'x');
  const yField = header.descriptors.find((field) => field.name === 'y');
  const zField = header.descriptors.find((field) => field.name === 'z');
  const intensityField = header.descriptors.find((field) => ['intensity', 'i'].includes(field.name));
  if (!xField || !yField || header.dataType !== 'binary') throw new Error('pcd_preview_requires_binary_xyz');
  const availablePoints = Math.min(
    header.points,
    Math.floor(Math.max(0, buffer.length - header.dataOffset) / header.pointStep)
  );
  const stride = Math.max(1, Math.ceil(availablePoints / maxPoints));
  const points = [];
  const bounds = { min_x: Infinity, max_x: -Infinity, min_y: Infinity, max_y: -Infinity, min_z: Infinity, max_z: -Infinity };
  for (let index = 0; index < availablePoints; index += stride) {
    const recordOffset = header.dataOffset + index * header.pointStep;
    const x = readPcdValue(buffer, recordOffset + xField.offset, xField);
    const y = readPcdValue(buffer, recordOffset + yField.offset, yField);
    const z = zField ? readPcdValue(buffer, recordOffset + zField.offset, zField) : 0;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (Math.hypot(x, y) > maxRangeM) continue;
    const intensity = intensityField
      ? readPcdValue(buffer, recordOffset + intensityField.offset, intensityField)
      : null;
    points.push([round(x), round(y), round(z), Number.isFinite(intensity) ? round(intensity, 2) : null]);
    bounds.min_x = Math.min(bounds.min_x, x);
    bounds.max_x = Math.max(bounds.max_x, x);
    bounds.min_y = Math.min(bounds.min_y, y);
    bounds.max_y = Math.max(bounds.max_y, y);
    bounds.min_z = Math.min(bounds.min_z, z);
    bounds.max_z = Math.max(bounds.max_z, z);
  }
  const finiteBounds = Object.fromEntries(
    Object.entries(bounds).map(([key, value]) => [key, Number.isFinite(value) ? round(value) : null])
  );
  return {
    points,
    bounds: finiteBounds,
    source_point_count: availablePoints,
    preview_point_count: points.length,
    max_range_m: maxRangeM
  };
}

function createDatasetReader(options = {}) {
  const rootPath = path.resolve(options.rootPath || '/home/admin1/.runtime/lidar_reloc_bevplace_20260629/patrol_reloc_samples');
  const vehicleMapRoot = path.resolve(
    options.vehicleMapRoot || path.join(path.dirname(rootPath), 'vehicle_maps')
  );
  const cacheTtlMs = toFiniteInteger(options.cacheTtlMs, 30000, { min: 5000, max: 300000 });
  let cache = null;
  let pending = null;

  async function overview({ refresh = false } = {}) {
    const now = Date.now();
    if (!refresh && cache && now - cache.at < cacheTtlMs) return cache.value;
    if (pending) return pending;
    pending = scanPatrolDataset(rootPath, { vehicleMapRoot })
      .then((value) => {
        cache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  }

  async function preview(vehicleValue, sessionValue, frameValue, previewOptions = {}) {
    const vehicleId = normalizeVehicleId(vehicleValue);
    const sessionId = normalizeSessionId(sessionValue);
    if (!vehicleId || !sessionId) {
      const error = new Error('invalid_vehicle_or_session');
      error.statusCode = 400;
      throw error;
    }
    const sessionPath = path.join(rootPath, vehicleId, sessionId);
    const samplesPath = path.join(sessionPath, 'samples.jsonl');
    const { rows, invalidRows } = parseSampleRows(await fs.readFile(samplesPath, 'utf8'));
    if (invalidRows || !rows.length) {
      const error = new Error('session_samples_unavailable');
      error.statusCode = 404;
      throw error;
    }
    const cloudEntries = await readDir(path.join(sessionPath, 'clouds'));
    const pcdNameSet = new Set(
      cloudEntries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.pcd'))
        .map((entry) => entry.name)
    );
    const availableRows = rows.filter((row) =>
      pcdNameSet.has(path.basename(String(row?.cloud?.pcd_path || '')))
    );
    if (!availableRows.length) {
      const error = new Error('session_clouds_unavailable');
      error.statusCode = 404;
      throw error;
    }
    const frameIndex = toFiniteInteger(frameValue, 0, { min: 0, max: availableRows.length - 1 });
    const sample = availableRows[frameIndex];
    const pcdName = path.basename(String(sample?.cloud?.pcd_path || ''));
    if (!pcdName.endsWith('.pcd')) {
      const error = new Error('sample_pcd_missing');
      error.statusCode = 404;
      throw error;
    }
    const pcdPath = path.join(sessionPath, 'clouds', pcdName);
    const previewData = await readPcdPreview(pcdPath, previewOptions);
    return {
      ok: true,
      vehicle_id: vehicleId,
      session_id: sessionId,
      frame_index: frameIndex,
      frame_count: availableRows.length,
      saved_at: sample?.saved_at || null,
      pose: samplePose(sample),
      cloud: {
        frame_id: sample?.cloud?.frame_id || null,
        point_count: Number(sample?.cloud?.saved_points) || previewData.source_point_count,
        stamp: Number(sample?.cloud?.stamp) || null
      },
      preview: previewData
    };
  }

  return { overview, preview };
}

function registerLidarRelocalizationDatasetRoutes(app, options = {}) {
  const requireVehicleRead = options.requireVehicleRead;
  if (typeof requireVehicleRead !== 'function') throw new Error('requireVehicleRead middleware is required');
  const reader = createDatasetReader(options);

  app.get('/api/lidar-relocalization/dataset', requireVehicleRead, async (req, res) => {
    try {
      const payload = await reader.overview({ refresh: String(req.query?.refresh || '') === '1' });
      return res.json(payload);
    } catch (error) {
      return res.status(500).json({ ok: false, detail: error?.message || 'dataset_overview_failed' });
    }
  });

  app.get(
    '/api/lidar-relocalization/dataset/:vehicleId/sessions/:sessionId/frames/:frameIndex/preview',
    requireVehicleRead,
    async (req, res) => {
      try {
        const payload = await reader.preview(
          req.params?.vehicleId,
          req.params?.sessionId,
          req.params?.frameIndex,
          { maxPoints: req.query?.max_points, maxRangeM: req.query?.range_m }
        );
        return res.json(payload);
      } catch (error) {
        return res.status(error?.statusCode || 500).json({
          ok: false,
          detail: error?.message || 'dataset_preview_failed'
        });
      }
    }
  );

  return reader;
}

module.exports = {
  createDatasetReader,
  normalizeSessionId,
  normalizeVehicleId,
  parsePcdHeader,
  readPcdPreview,
  registerLidarRelocalizationDatasetRoutes,
  scanPatrolDataset
};
