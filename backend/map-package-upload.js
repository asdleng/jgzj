const crypto = require('crypto');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');

let yaml = null;
try {
  yaml = require('yaml');
} catch (_error) {
  yaml = null;
}

const DEFAULT_CHUNK_SIZE_BYTES = 768 * 1024;
const DEFAULT_MAX_PCD_BYTES = 40 * 1024 * 1024 * 1024;
const DEFAULT_MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const SESSION_TTL_MS = 48 * 60 * 60 * 1000;
const PCD_HEADER_MAX_BYTES = 256 * 1024;
const sessionLocks = new Map();

function normalizeVehicleId(value) {
  const vehicleId = String(value || '').trim();
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(vehicleId) ? vehicleId : '';
}

function normalizeUploadId(value) {
  const uploadId = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{32}$/.test(uploadId) ? uploadId : '';
}

function toPositiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function isoNow() {
  return new Date().toISOString();
}

function sessionPath(uploadRoot, vehicleId, uploadId) {
  return path.join(uploadRoot, vehicleId, uploadId);
}

function metadataPath(uploadRoot, vehicleId, uploadId) {
  return path.join(sessionPath(uploadRoot, vehicleId, uploadId), 'session.json');
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
}

async function readSession(uploadRoot, vehicleId, uploadId) {
  const raw = await fs.readFile(metadataPath(uploadRoot, vehicleId, uploadId), 'utf8');
  const session = JSON.parse(raw);
  if (session.vehicle_id !== vehicleId || session.upload_id !== uploadId) {
    throw Object.assign(new Error('map_upload_session_mismatch'), { status: 409 });
  }
  return session;
}

async function withSessionLock(key, action) {
  const previous = sessionLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  sessionLocks.set(key, queued);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (sessionLocks.get(key) === queued) {
      sessionLocks.delete(key);
    }
  }
}

function fileDefinition(kind, raw, chunkSizeBytes, maxPcdBytes, maxConfigBytes) {
  const name = path.basename(String(raw?.name || '').trim());
  const sizeBytes = toPositiveInteger(raw?.size_bytes);
  if (kind === 'pcd') {
    if (!name || path.extname(name).toLowerCase() !== '.pcd') {
      throw Object.assign(new Error('请选择 .pcd 地图文件'), { status: 400 });
    }
    if (!sizeBytes || sizeBytes > maxPcdBytes) {
      throw Object.assign(new Error('PCD 文件大小无效或超过服务器限制'), { status: 413 });
    }
  } else {
    if (name.toLowerCase() !== 'config.yaml') {
      throw Object.assign(new Error('配置文件必须命名为 config.yaml'), { status: 400 });
    }
    if (!sizeBytes || sizeBytes > maxConfigBytes) {
      throw Object.assign(new Error('config.yaml 大小无效或超过服务器限制'), { status: 413 });
    }
  }
  return {
    name,
    size_bytes: sizeBytes,
    client_modified_ms: Number.isFinite(Number(raw?.client_modified_ms))
      ? Number(raw.client_modified_ms)
      : null,
    total_chunks: Math.ceil(sizeBytes / chunkSizeBytes)
  };
}

async function availableDiskBytes(targetPath) {
  if (typeof fs.statfs !== 'function') {
    return null;
  }
  const stats = await fs.statfs(targetPath);
  return Number(stats.bavail) * Number(stats.bsize);
}

async function cleanupExpiredSessions(uploadRoot) {
  const cutoff = Date.now() - SESSION_TTL_MS;
  let vehicleEntries = [];
  try {
    vehicleEntries = await fs.readdir(uploadRoot, { withFileTypes: true });
  } catch (_error) {
    return;
  }
  await Promise.all(
    vehicleEntries
      .filter((entry) => entry.isDirectory())
      .map(async (vehicleEntry) => {
        const vehicleDir = path.join(uploadRoot, vehicleEntry.name);
        const uploads = await fs.readdir(vehicleDir, { withFileTypes: true }).catch(() => []);
        await Promise.all(
          uploads
            .filter((entry) => entry.isDirectory())
            .map(async (entry) => {
              const uploadDir = path.join(vehicleDir, entry.name);
              const stat = await fs.stat(uploadDir).catch(() => null);
              if (stat && stat.mtimeMs < cutoff) {
                await fs.rm(uploadDir, { recursive: true, force: true });
              }
            })
        );
      })
  );
}

function chunkFilePath(uploadRoot, session, kind, chunkIndex) {
  return path.join(
    sessionPath(uploadRoot, session.vehicle_id, session.upload_id),
    'chunks',
    kind,
    `${String(chunkIndex).padStart(8, '0')}.chunk`
  );
}

async function listReceivedChunks(uploadRoot, session, kind) {
  const definition = session.files[kind];
  const chunkDir = path.dirname(chunkFilePath(uploadRoot, session, kind, 0));
  const entries = await fs.readdir(chunkDir, { withFileTypes: true }).catch(() => []);
  const indexes = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^\d{8}\.chunk$/.test(entry.name)) {
      continue;
    }
    const index = Number(entry.name.slice(0, 8));
    if (!Number.isInteger(index) || index < 0 || index >= definition.total_chunks) {
      continue;
    }
    const expectedBytes = Math.min(
      session.chunk_size_bytes,
      definition.size_bytes - index * session.chunk_size_bytes
    );
    const stat = await fs.stat(path.join(chunkDir, entry.name)).catch(() => null);
    if (stat?.size === expectedBytes) {
      indexes.push(index);
    }
  }
  indexes.sort((a, b) => a - b);
  return indexes;
}

function compactChunkRanges(indexes) {
  const ranges = [];
  for (const index of indexes) {
    const last = ranges[ranges.length - 1];
    if (last && index === last[1] + 1) {
      last[1] = index;
    } else {
      ranges.push([index, index]);
    }
  }
  return ranges;
}

async function publicSession(uploadRoot, session) {
  const files = {};
  for (const kind of ['pcd', 'config']) {
    const definition = session.files[kind];
    const complete = session.status === 'ready' || session.status === 'synced';
    const received = complete
      ? Array.from({ length: definition.total_chunks }, (_value, index) => index)
      : await listReceivedChunks(uploadRoot, session, kind);
    const receivedBytes = complete
      ? definition.size_bytes
      : received.reduce(
          (total, index) =>
            total +
            Math.min(
              session.chunk_size_bytes,
              definition.size_bytes - index * session.chunk_size_bytes
            ),
          0
        );
    files[kind] = {
      ...definition,
      received_chunks: received.length,
      received_bytes: receivedBytes,
      received_ranges: compactChunkRanges(received),
      sha256: definition.sha256 || null
    };
  }
  return {
    upload_id: session.upload_id,
    vehicle_id: session.vehicle_id,
    status: session.status,
    chunk_size_bytes: session.chunk_size_bytes,
    created_at: session.created_at,
    updated_at: session.updated_at,
    files,
    origin: session.origin || null,
    pointcloud: session.pointcloud || null,
    synced_at: session.synced_at || null,
    backup_path: session.backup_path || null
  };
}

async function receiveChunk(req, targetPath, expectedBytes) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const handle = await fs.open(temporaryPath, 'w', 0o600);
  const hash = crypto.createHash('sha256');
  let receivedBytes = 0;
  try {
    for await (const chunk of req) {
      receivedBytes += chunk.length;
      if (receivedBytes > expectedBytes) {
        throw Object.assign(new Error('分块数据超过预期大小'), { status: 413 });
      }
      hash.update(chunk);
      await handle.write(chunk);
    }
    if (receivedBytes !== expectedBytes) {
      throw Object.assign(
        new Error(`分块大小不匹配，预期 ${expectedBytes}，收到 ${receivedBytes}`),
        { status: 400 }
      );
    }
    await handle.sync();
    await handle.close();
    await fs.rename(temporaryPath, targetPath);
    return {
      size_bytes: receivedBytes,
      sha256: hash.digest('hex')
    };
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

function findYamlKey(value, targetKey, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) {
    return undefined;
  }
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (String(key).toUpperCase() === targetKey) {
      return child;
    }
  }
  for (const child of Object.values(value)) {
    const found = findYamlKey(child, targetKey, seen);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function fallbackYamlOrigin(text) {
  const result = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(
      /^\s*(STARTPOINT_LAT|STARTPOINT_LNG|STARTPOINT_ALT)\s*:\s*["']?([^#"' \t]+)["']?\s*(?:#.*)?$/i
    );
    if (match) {
      result[match[1].toUpperCase()] = match[2];
    }
  }
  return result;
}

function parseMapConfig(text) {
  let document = null;
  if (yaml) {
    try {
      document = yaml.parse(String(text || ''));
    } catch (error) {
      throw Object.assign(new Error(`config.yaml 解析失败：${error.message}`), { status: 400 });
    }
  } else {
    document = fallbackYamlOrigin(text);
  }

  const latitude = Number(findYamlKey(document, 'STARTPOINT_LAT'));
  const longitude = Number(findYamlKey(document, 'STARTPOINT_LNG'));
  const altitudeValue = findYamlKey(document, 'STARTPOINT_ALT');
  const altitude = altitudeValue === undefined ? null : Number(altitudeValue);

  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw Object.assign(new Error('config.yaml 缺少有效的 STARTPOINT_LAT'), { status: 400 });
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw Object.assign(new Error('config.yaml 缺少有效的 STARTPOINT_LNG'), { status: 400 });
  }
  if (altitudeValue !== undefined && !Number.isFinite(altitude)) {
    throw Object.assign(new Error('config.yaml 的 STARTPOINT_ALT 不是有效数字'), { status: 400 });
  }

  return {
    latitude,
    longitude,
    altitude
  };
}

async function validatePcd(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(PCD_HEADER_MAX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString('latin1');
    const dataMatch = text.match(/(?:^|\r?\n)\s*DATA\s+(ascii|binary|binary_compressed)\s*(?:\r?\n)/i);
    if (!dataMatch) {
      throw Object.assign(new Error('PCD 头部无有效 DATA 字段'), { status: 400 });
    }
    const headerText = text.slice(0, dataMatch.index + dataMatch[0].length);
    const fieldsMatch = headerText.match(/(?:^|\r?\n)\s*FIELDS?\s+([^\r\n]+)/i);
    const pointsMatch = headerText.match(/(?:^|\r?\n)\s*POINTS\s+(\d+)/i);
    const widthMatch = headerText.match(/(?:^|\r?\n)\s*WIDTH\s+(\d+)/i);
    const heightMatch = headerText.match(/(?:^|\r?\n)\s*HEIGHT\s+(\d+)/i);
    const fields = fieldsMatch
      ? fieldsMatch[1].trim().split(/\s+/).map((field) => field.toLowerCase())
      : [];
    if (!['x', 'y', 'z'].every((field) => fields.includes(field))) {
      throw Object.assign(new Error('PCD 必须包含 x、y、z 字段'), { status: 400 });
    }
    const width = Number(widthMatch?.[1] || 0);
    const height = Number(heightMatch?.[1] || 1);
    const pointCount = Number(pointsMatch?.[1] || width * height);
    if (!Number.isSafeInteger(pointCount) || pointCount <= 0) {
      throw Object.assign(new Error('PCD 点数无效'), { status: 400 });
    }
    const stat = await handle.stat();
    if (stat.size <= Buffer.byteLength(headerText, 'latin1')) {
      throw Object.assign(new Error('PCD 没有点云数据'), { status: 400 });
    }
    return {
      data: dataMatch[1].toLowerCase(),
      fields,
      point_count: pointCount,
      width,
      height
    };
  } finally {
    await handle.close();
  }
}

async function assembleFile(uploadRoot, session, kind, outputName) {
  const definition = session.files[kind];
  const outputDir = path.join(sessionPath(uploadRoot, session.vehicle_id, session.upload_id), 'files');
  const outputPath = path.join(outputDir, outputName);
  const temporaryPath = `${outputPath}.assembling`;
  await fs.mkdir(outputDir, { recursive: true });
  const output = await fs.open(temporaryPath, 'w', 0o600);
  const hash = crypto.createHash('sha256');
  let totalBytes = 0;
  try {
    for (let index = 0; index < definition.total_chunks; index += 1) {
      const chunkPath = chunkFilePath(uploadRoot, session, kind, index);
      const buffer = await fs.readFile(chunkPath);
      const expectedBytes = Math.min(
        session.chunk_size_bytes,
        definition.size_bytes - index * session.chunk_size_bytes
      );
      if (buffer.length !== expectedBytes) {
        throw Object.assign(new Error(`${kind} 第 ${index + 1} 个分块不完整`), { status: 409 });
      }
      hash.update(buffer);
      await output.write(buffer);
      totalBytes += buffer.length;
    }
    if (totalBytes !== definition.size_bytes) {
      throw Object.assign(new Error(`${kind} 文件总大小不匹配`), { status: 409 });
    }
    await output.sync();
    await output.close();
    await fs.rename(temporaryPath, outputPath);
    return {
      path: outputPath,
      size_bytes: totalBytes,
      sha256: hash.digest('hex')
    };
  } catch (error) {
    await output.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function backupFile(sourcePath, backupPath) {
  try {
    await fs.link(sourcePath, backupPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    await fs.copyFile(sourcePath, backupPath);
  }
  return true;
}

async function syncReadySession(uploadRoot, vehicleMapRoot, session) {
  const sourceDir = path.join(sessionPath(uploadRoot, session.vehicle_id, session.upload_id), 'files');
  const sourcePcd = path.join(sourceDir, 'GlobalMap.pcd');
  const sourceConfig = path.join(sourceDir, 'config.yaml');
  const destinationDir = path.join(vehicleMapRoot, session.vehicle_id);
  const destinationPcd = path.join(destinationDir, 'GlobalMap.pcd');
  const destinationConfig = path.join(destinationDir, 'config.yaml');
  const backupDir = path.join(
    destinationDir,
    '.backups',
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${session.upload_id.slice(0, 8)}`
  );
  const incomingPcd = path.join(destinationDir, `.GlobalMap.${session.upload_id}.incoming`);
  const incomingConfig = path.join(destinationDir, `.config.${session.upload_id}.incoming`);

  await fs.mkdir(destinationDir, { recursive: true });
  await fs.mkdir(backupDir, { recursive: true });
  await Promise.all([
    fs.copyFile(sourcePcd, incomingPcd),
    fs.copyFile(sourceConfig, incomingConfig)
  ]);

  const hadPcd = await backupFile(destinationPcd, path.join(backupDir, 'GlobalMap.pcd'));
  const hadConfig = await backupFile(destinationConfig, path.join(backupDir, 'config.yaml'));
  let configReplaced = false;
  let pcdReplaced = false;
  try {
    await fs.rename(incomingConfig, destinationConfig);
    configReplaced = true;
    await fs.rename(incomingPcd, destinationPcd);
    pcdReplaced = true;
    const manifest = {
      version: 1,
      vehicle_id: session.vehicle_id,
      upload_id: session.upload_id,
      synced_at: isoNow(),
      origin: session.origin,
      pointcloud: session.pointcloud,
      files: {
        pcd: session.files.pcd,
        config: session.files.config
      }
    };
    await writeJsonAtomic(path.join(destinationDir, 'map-package.json'), manifest);
    return {
      destination_path: destinationDir,
      backup_path: hadPcd || hadConfig ? backupDir : null
    };
  } catch (error) {
    if (configReplaced) {
      if (hadConfig) {
        await fs.copyFile(path.join(backupDir, 'config.yaml'), destinationConfig).catch(() => {});
      } else {
        await fs.rm(destinationConfig, { force: true }).catch(() => {});
      }
    }
    if (pcdReplaced) {
      if (hadPcd) {
        await fs.copyFile(path.join(backupDir, 'GlobalMap.pcd'), destinationPcd).catch(() => {});
      } else {
        await fs.rm(destinationPcd, { force: true }).catch(() => {});
      }
    }
    throw error;
  } finally {
    await fs.rm(incomingPcd, { force: true }).catch(() => {});
    await fs.rm(incomingConfig, { force: true }).catch(() => {});
  }
}

function errorResponse(res, error, fallback) {
  return res.status(error.status || 500).json({
    ok: false,
    detail: error.message || fallback
  });
}

function registerMapPackageUploadRoutes(app, options = {}) {
  const requirePermission = options.requirePermission;
  if (typeof requirePermission !== 'function') {
    throw new Error('map_package_upload_permission_required');
  }
  const uploadRoot = path.resolve(options.uploadRoot);
  const vehicleMapRoot = path.resolve(options.vehicleMapRoot);
  const chunkSizeBytes = Number(options.chunkSizeBytes || DEFAULT_CHUNK_SIZE_BYTES);
  const maxPcdBytes = Number(options.maxPcdBytes || DEFAULT_MAX_PCD_BYTES);
  const maxConfigBytes = Number(options.maxConfigBytes || DEFAULT_MAX_CONFIG_BYTES);
  const writePermission = requirePermission('vehicle:path:write');

  app.post('/api/map-upload/:vehicleId/sessions', writePermission, async (req, res) => {
    try {
      const vehicleId = normalizeVehicleId(req.params?.vehicleId);
      if (!vehicleId) {
        return res.status(400).json({ ok: false, detail: 'vehicle_id_required' });
      }
      const pcd = fileDefinition('pcd', req.body?.files?.pcd, chunkSizeBytes, maxPcdBytes, maxConfigBytes);
      const config = fileDefinition(
        'config',
        req.body?.files?.config,
        chunkSizeBytes,
        maxPcdBytes,
        maxConfigBytes
      );
      await fs.mkdir(uploadRoot, { recursive: true });
      cleanupExpiredSessions(uploadRoot).catch(() => {});
      const requiredBytes = (pcd.size_bytes + config.size_bytes) * 2 + 256 * 1024 * 1024;
      const freeBytes = await availableDiskBytes(uploadRoot).catch(() => null);
      if (Number.isFinite(freeBytes) && freeBytes < requiredBytes) {
        return res.status(507).json({
          ok: false,
          detail: '服务器暂存空间不足，无法安全接收并发布该地图',
          required_bytes: requiredBytes,
          available_bytes: freeBytes
        });
      }
      const uploadId = crypto.randomBytes(16).toString('hex');
      const directory = sessionPath(uploadRoot, vehicleId, uploadId);
      await fs.mkdir(directory, { recursive: true });
      const session = {
        version: 1,
        upload_id: uploadId,
        vehicle_id: vehicleId,
        status: 'uploading',
        chunk_size_bytes: chunkSizeBytes,
        created_at: isoNow(),
        updated_at: isoNow(),
        files: { pcd, config }
      };
      await writeJsonAtomic(metadataPath(uploadRoot, vehicleId, uploadId), session);
      return res.status(201).json({
        ok: true,
        session: await publicSession(uploadRoot, session)
      });
    } catch (error) {
      return errorResponse(res, error, 'map_upload_session_create_failed');
    }
  });

  app.get('/api/map-upload/:vehicleId/sessions/:uploadId', writePermission, async (req, res) => {
    try {
      const vehicleId = normalizeVehicleId(req.params?.vehicleId);
      const uploadId = normalizeUploadId(req.params?.uploadId);
      if (!vehicleId || !uploadId) {
        return res.status(400).json({ ok: false, detail: 'invalid_map_upload_session' });
      }
      const session = await readSession(uploadRoot, vehicleId, uploadId);
      return res.json({
        ok: true,
        session: await publicSession(uploadRoot, session)
      });
    } catch (error) {
      if (error.code === 'ENOENT') {
        error.status = 404;
        error.message = 'map_upload_session_not_found';
      }
      return errorResponse(res, error, 'map_upload_session_read_failed');
    }
  });

  app.put(
    '/api/map-upload/:vehicleId/sessions/:uploadId/files/:kind/chunks/:chunkIndex',
    writePermission,
    async (req, res) => {
      const vehicleId = normalizeVehicleId(req.params?.vehicleId);
      const uploadId = normalizeUploadId(req.params?.uploadId);
      const kind = String(req.params?.kind || '').toLowerCase();
      const chunkIndex = Number(req.params?.chunkIndex);
      if (!vehicleId || !uploadId || !['pcd', 'config'].includes(kind)) {
        return res.status(400).json({ ok: false, detail: 'invalid_map_upload_chunk' });
      }
      try {
        const session = await readSession(uploadRoot, vehicleId, uploadId);
        if (session.status !== 'uploading') {
          return res.status(409).json({ ok: false, detail: 'map_upload_session_not_writable' });
        }
        const definition = session.files[kind];
        if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= definition.total_chunks) {
          return res.status(416).json({ ok: false, detail: 'map_upload_chunk_index_out_of_range' });
        }
        const expectedBytes = Math.min(
          session.chunk_size_bytes,
          definition.size_bytes - chunkIndex * session.chunk_size_bytes
        );
        const contentLength = Number(req.get('content-length') || expectedBytes);
        if (contentLength !== expectedBytes) {
          return res.status(400).json({
            ok: false,
            detail: `分块大小不匹配，预期 ${expectedBytes}，收到 ${contentLength}`
          });
        }
        const result = await receiveChunk(
          req,
          chunkFilePath(uploadRoot, session, kind, chunkIndex),
          expectedBytes
        );
        return res.json({
          ok: true,
          kind,
          chunk_index: chunkIndex,
          ...result
        });
      } catch (error) {
        if (error.code === 'ENOENT') {
          error.status = 404;
          error.message = 'map_upload_session_not_found';
        }
        return errorResponse(res, error, 'map_upload_chunk_failed');
      }
    }
  );

  app.post('/api/map-upload/:vehicleId/sessions/:uploadId/finalize', writePermission, async (req, res) => {
    const vehicleId = normalizeVehicleId(req.params?.vehicleId);
    const uploadId = normalizeUploadId(req.params?.uploadId);
    if (!vehicleId || !uploadId) {
      return res.status(400).json({ ok: false, detail: 'invalid_map_upload_session' });
    }
    try {
      const session = await withSessionLock(`${vehicleId}:${uploadId}`, async () => {
        const current = await readSession(uploadRoot, vehicleId, uploadId);
        if (current.status === 'ready' || current.status === 'synced') {
          return current;
        }
        for (const kind of ['pcd', 'config']) {
          const received = await listReceivedChunks(uploadRoot, current, kind);
          if (received.length !== current.files[kind].total_chunks) {
            throw Object.assign(new Error(`${kind} 文件尚未上传完整`), { status: 409 });
          }
        }
        const configFile = await assembleFile(uploadRoot, current, 'config', 'config.yaml');
        const origin = parseMapConfig(await fs.readFile(configFile.path, 'utf8'));
        const pcdFile = await assembleFile(uploadRoot, current, 'pcd', 'GlobalMap.pcd');
        const pointcloud = await validatePcd(pcdFile.path);
        current.files.config.sha256 = configFile.sha256;
        current.files.pcd.sha256 = pcdFile.sha256;
        current.origin = origin;
        current.pointcloud = pointcloud;
        current.status = 'ready';
        current.updated_at = isoNow();
        await writeJsonAtomic(metadataPath(uploadRoot, vehicleId, uploadId), current);
        await fs.rm(
          path.join(sessionPath(uploadRoot, vehicleId, uploadId), 'chunks'),
          { recursive: true, force: true }
        );
        return current;
      });
      return res.json({
        ok: true,
        session: await publicSession(uploadRoot, session)
      });
    } catch (error) {
      return errorResponse(res, error, 'map_upload_finalize_failed');
    }
  });

  app.post('/api/map-upload/:vehicleId/sessions/:uploadId/sync', writePermission, async (req, res) => {
    const vehicleId = normalizeVehicleId(req.params?.vehicleId);
    const uploadId = normalizeUploadId(req.params?.uploadId);
    if (!vehicleId || !uploadId) {
      return res.status(400).json({ ok: false, detail: 'invalid_map_upload_session' });
    }
    try {
      const session = await withSessionLock(`${vehicleId}:${uploadId}`, async () => {
        const current = await readSession(uploadRoot, vehicleId, uploadId);
        if (current.status === 'synced') {
          return current;
        }
        if (current.status !== 'ready') {
          throw Object.assign(new Error('地图包尚未完成上传和校验'), { status: 409 });
        }
        const synced = await syncReadySession(uploadRoot, vehicleMapRoot, current);
        current.status = 'synced';
        current.synced_at = isoNow();
        current.destination_path = synced.destination_path;
        current.backup_path = synced.backup_path;
        current.updated_at = current.synced_at;
        await writeJsonAtomic(metadataPath(uploadRoot, vehicleId, uploadId), current);
        return current;
      });
      return res.json({
        ok: true,
        destination_path: session.destination_path,
        session: await publicSession(uploadRoot, session)
      });
    } catch (error) {
      return errorResponse(res, error, 'map_upload_sync_failed');
    }
  });

  app.delete('/api/map-upload/:vehicleId/sessions/:uploadId', writePermission, async (req, res) => {
    const vehicleId = normalizeVehicleId(req.params?.vehicleId);
    const uploadId = normalizeUploadId(req.params?.uploadId);
    if (!vehicleId || !uploadId) {
      return res.status(400).json({ ok: false, detail: 'invalid_map_upload_session' });
    }
    try {
      await withSessionLock(`${vehicleId}:${uploadId}`, async () => {
        await fs.rm(sessionPath(uploadRoot, vehicleId, uploadId), { recursive: true, force: true });
      });
      return res.json({ ok: true, upload_id: uploadId });
    } catch (error) {
      return errorResponse(res, error, 'map_upload_session_delete_failed');
    }
  });
}

module.exports = {
  registerMapPackageUploadRoutes,
  _internals: {
    compactChunkRanges,
    normalizeVehicleId,
    parseMapConfig,
    validatePcd
  }
};
