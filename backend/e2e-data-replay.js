'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const DEFAULT_CHUNK_SIZE_BYTES = 1 * MIB;
const DEFAULT_MAX_BAG_BYTES = 2 * GIB;
const DEFAULT_MAX_PREVIEW_BYTES = 64 * MIB;
const DEFAULT_MIN_FREE_BYTES = 2 * 1024 ** 4;
const DEFAULT_MAX_PREVIEW_JSON_BYTES = 192 * MIB;
const INDEX_SCHEMA = 'jgzj_e2e_clip_index.v1';
const SESSION_SCHEMA = 'jgzj_e2e_upload_session.v1';
const PREVIEW_SCHEMA = 'auto_ad_e2e_preview.v1';
const sessionLocks = new Map();

function isoNow() {
  return new Date().toISOString();
}

function normalizeVehicleId(value) {
  const vehicleId = String(value || '').trim().toUpperCase();
  return /^BIT-\d{4}$/.test(vehicleId) ? vehicleId : '';
}

function normalizeClipId(value) {
  const clipId = String(value || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{7,127}$/.test(clipId) ? clipId : '';
}

function normalizeUploadId(value) {
  const uploadId = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{32}$/.test(uploadId) ? uploadId : '';
}

function normalizeSha256(value) {
  const digest = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(digest) ? digest : '';
}

function toPositiveInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function toFiniteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function deriveVehicleUploadToken(secret, vehicleId) {
  const normalizedVehicleId = normalizeVehicleId(vehicleId);
  if (!secret || !normalizedVehicleId) return '';
  return crypto
    .createHmac('sha256', String(secret))
    .update(`jgzj-e2e-upload-v1\n${normalizedVehicleId}`)
    .digest('base64url');
}

function timingSafeEqualText(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function suppliedUploadToken(req) {
  const authorization = String(req.get('authorization') || '').trim();
  if (/^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, '').trim();
  return String(
    req.get('x-auto-ad-e2e-upload-token') || req.get('x-auto-ad-upload-token') || ''
  ).trim();
}

function requireVehicleUploadToken(req, res, secret, vehicleId) {
  if (!secret) {
    res.status(503).json({ ok: false, error: 'e2e_upload_not_configured' });
    return false;
  }
  const expected = deriveVehicleUploadToken(secret, vehicleId);
  if (!expected || !timingSafeEqualText(suppliedUploadToken(req), expected)) {
    res.status(401).json({ ok: false, error: 'e2e_upload_unauthorized' });
    return false;
  }
  return true;
}

async function atomicWriteJson(filePath, payload) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(temporary, filePath);
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch (_error) {
    return fallback;
  }
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function withSessionLock(key, callback) {
  const previous = sessionLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  sessionLocks.set(key, queued);
  await previous;
  try {
    return await callback();
  } finally {
    release();
    if (sessionLocks.get(key) === queued) sessionLocks.delete(key);
  }
}

async function readRequestBuffer(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error('e2e_upload_chunk_too_large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function validateFileSpec(raw, kind, maxBytes) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const sizeBytes = toPositiveInteger(value.size_bytes);
  const sha256 = normalizeSha256(value.sha256);
  const name = path.basename(String(value.name || (kind === 'bag' ? 'raw.bag' : 'preview.json.gz')));
  if (!sizeBytes || sizeBytes > maxBytes || !sha256) return null;
  return {
    kind,
    name,
    size_bytes: sizeBytes,
    sha256,
    received_chunks: []
  };
}

function publicSession(session) {
  const files = {};
  Object.entries(session.files || {}).forEach(([kind, file]) => {
    files[kind] = {
      name: file.name,
      size_bytes: file.size_bytes,
      sha256: file.sha256,
      total_chunks: file.total_chunks,
      received_chunks: Array.isArray(file.received_chunks) ? file.received_chunks : []
    };
  });
  return {
    upload_id: session.upload_id,
    vehicle_id: session.vehicle_id,
    clip_id: session.clip_id,
    status: session.status,
    chunk_size_bytes: session.chunk_size_bytes,
    created_at: session.created_at,
    updated_at: session.updated_at,
    finalized_at: session.finalized_at || null,
    files
  };
}

function sanitizeMetadata(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const capturedAt = String(value.captured_at || '').trim();
  const durationSec = toFiniteNumber(value.duration_sec, null);
  const topics = Array.isArray(value.topics)
    ? value.topics.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 64)
    : [];
  const messageCounts = {};
  if (value.message_counts && typeof value.message_counts === 'object') {
    Object.entries(value.message_counts).slice(0, 64).forEach(([topic, count]) => {
      const normalized = toPositiveInteger(count, 0);
      if (normalized >= 0) messageCounts[String(topic).slice(0, 160)] = normalized;
    });
  }
  const charging = value.charging && typeof value.charging === 'object' ? value.charging : {};
  return {
    captured_at: Number.isFinite(Date.parse(capturedAt)) ? new Date(capturedAt).toISOString() : null,
    duration_sec: durationSec !== null ? Math.max(0, Math.min(600, durationSec)) : null,
    topics,
    message_counts: messageCounts,
    source_bag_name: path.basename(String(value.source_bag_name || 'raw.bag')),
    recorder_version: String(value.recorder_version || '').slice(0, 80) || null,
    charging: {
      verified: charging.verified === true,
      stable_seconds: Math.max(0, toFiniteNumber(charging.stable_seconds, 0)),
      battery_soc: toFiniteNumber(charging.battery_soc, null),
      charge_state: toFiniteNumber(charging.charge_state, null)
    }
  };
}

async function ensureFreeSpace(rootDir, minFreeBytes, incomingBytes = 0) {
  if (typeof fsp.statfs !== 'function') return;
  const stat = await fsp.statfs(rootDir);
  const freeBytes = Number(stat.bavail) * Number(stat.bsize);
  if (!Number.isFinite(freeBytes) || freeBytes - incomingBytes < minFreeBytes) {
    const error = new Error('e2e_upload_server_storage_guard');
    error.statusCode = 507;
    error.free_bytes = freeBytes;
    throw error;
  }
}

async function parsePreview(previewPath, maxOutputLength) {
  const compressed = await fsp.readFile(previewPath);
  const raw = await new Promise((resolve, reject) => {
    zlib.gunzip(compressed, { maxOutputLength }, (error, output) => {
      if (error) reject(error);
      else resolve(output);
    });
  });
  const preview = JSON.parse(raw.toString('utf8'));
  if (preview?.schema !== PREVIEW_SCHEMA || !Array.isArray(preview.frames)) {
    const error = new Error('e2e_preview_schema_invalid');
    error.statusCode = 400;
    throw error;
  }
  return preview;
}

function clipUrls(vehicleId, clipId) {
  const base = `/api/e2e-autonomous-driving/clips/${encodeURIComponent(vehicleId)}/${encodeURIComponent(clipId)}`;
  return { manifest: base, preview: `${base}/preview`, bag: `${base}/bag` };
}

function publicClip(record) {
  return {
    ...record,
    urls: clipUrls(record.vehicle_id, record.clip_id)
  };
}

async function appendIndex(indexPath, record) {
  await fsp.mkdir(path.dirname(indexPath), { recursive: true });
  await fsp.appendFile(
    indexPath,
    `${JSON.stringify({ schema: INDEX_SCHEMA, indexed_at: isoNow(), clip: record })}\n`,
    { mode: 0o600 }
  );
}

async function readClipIndex(indexPath) {
  let text = '';
  try {
    text = await fsp.readFile(indexPath, 'utf8');
  } catch (_error) {
    return [];
  }
  const byKey = new Map();
  text.split(/\r?\n/).filter(Boolean).forEach((line) => {
    try {
      const parsed = JSON.parse(line);
      const clip = parsed?.clip;
      const vehicleId = normalizeVehicleId(clip?.vehicle_id);
      const clipId = normalizeClipId(clip?.clip_id);
      if (vehicleId && clipId) byKey.set(`${vehicleId}/${clipId}`, clip);
    } catch (_error) {
      // A partial trailing line must not make the whole replay catalog unavailable.
    }
  });
  return Array.from(byKey.values()).sort((left, right) => {
    const leftTime = Date.parse(left.captured_at || left.uploaded_at || '') || 0;
    const rightTime = Date.parse(right.captured_at || right.uploaded_at || '') || 0;
    return rightTime - leftTime;
  });
}

function parseRangeHeader(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(value || '').trim());
  if (!match) return null;
  let start = match[1] ? Number(match[1]) : null;
  let end = match[2] ? Number(match[2]) : null;
  if (start === null && end !== null) {
    start = Math.max(0, size - end);
    end = size - 1;
  }
  if (start === null) return null;
  if (end === null || end >= size) end = size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) {
    return null;
  }
  return { start, end };
}

function registerE2eDataReplayRoutes(app, options = {}) {
  if (!app || typeof app.get !== 'function') throw new TypeError('express_app_required');
  if (typeof options.requirePermission !== 'function') throw new TypeError('require_permission_required');

  const rootDir = path.resolve(options.rootDir || path.join(__dirname, '../.runtime/e2e-autonomous-driving'));
  const sessionsRoot = path.join(rootDir, 'sessions');
  const clipsRoot = path.join(rootDir, 'clips');
  const indexPath = path.join(rootDir, 'clips.jsonl');
  const tokenSecret = String(options.tokenSecret || '').trim();
  const chunkSizeBytes = toPositiveInteger(options.chunkSizeBytes, DEFAULT_CHUNK_SIZE_BYTES);
  const maxBagBytes = toPositiveInteger(options.maxBagBytes, DEFAULT_MAX_BAG_BYTES);
  const maxPreviewBytes = toPositiveInteger(options.maxPreviewBytes, DEFAULT_MAX_PREVIEW_BYTES);
  const minFreeBytes = Number.isFinite(Number(options.minFreeBytes))
    ? Math.max(0, Number(options.minFreeBytes))
    : DEFAULT_MIN_FREE_BYTES;
  const maxPreviewJsonBytes = toPositiveInteger(
    options.maxPreviewJsonBytes,
    DEFAULT_MAX_PREVIEW_JSON_BYTES
  );

  const sessionPath = (vehicleId, uploadId) => path.join(sessionsRoot, vehicleId, uploadId, 'session.json');
  const sessionDir = (vehicleId, uploadId) => path.dirname(sessionPath(vehicleId, uploadId));
  const clipDir = (vehicleId, clipId) => path.join(clipsRoot, vehicleId, clipId);

  async function loadSession(vehicleId, uploadId) {
    const session = await readJson(sessionPath(vehicleId, uploadId));
    return session?.schema === SESSION_SCHEMA ? session : null;
  }

  async function findOpenSession(vehicleId, clipId) {
    let entries = [];
    try {
      entries = await fsp.readdir(path.join(sessionsRoot, vehicleId), { withFileTypes: true });
    } catch (_error) {
      return null;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !normalizeUploadId(entry.name)) continue;
      const session = await loadSession(vehicleId, entry.name);
      if (session?.clip_id === clipId && session.status !== 'failed') return session;
    }
    return null;
  }

  async function createSession(req, res) {
    const vehicleId = normalizeVehicleId(req.params.vehicleId);
    if (!vehicleId) return res.status(400).json({ ok: false, error: 'invalid_vehicle_id' });
    if (!requireVehicleUploadToken(req, res, tokenSecret, vehicleId)) return;

    const clipId = normalizeClipId(req.body?.clip_id);
    const bag = validateFileSpec(req.body?.files?.bag, 'bag', maxBagBytes);
    const preview = validateFileSpec(req.body?.files?.preview, 'preview', maxPreviewBytes);
    const metadata = sanitizeMetadata(req.body?.metadata);
    if (!clipId || !bag || !preview) {
      return res.status(400).json({ ok: false, error: 'invalid_e2e_upload_manifest' });
    }
    if (req.body?.metadata?.charging?.verified !== true) {
      return res.status(409).json({ ok: false, error: 'charging_evidence_required' });
    }

    await fsp.mkdir(rootDir, { recursive: true });
    await ensureFreeSpace(rootDir, minFreeBytes, bag.size_bytes + preview.size_bytes);

    const existingClip = await readJson(path.join(clipDir(vehicleId, clipId), 'clip.json'));
    if (existingClip) {
      return res.status(200).json({ ok: true, completed: true, clip: publicClip(existingClip) });
    }
    const existingSession = await findOpenSession(vehicleId, clipId);
    if (existingSession) {
      return res.status(200).json({ ok: true, completed: false, session: publicSession(existingSession) });
    }

    const uploadId = crypto.randomBytes(16).toString('hex');
    const now = isoNow();
    const files = { bag, preview };
    Object.values(files).forEach((file) => {
      file.total_chunks = Math.ceil(file.size_bytes / chunkSizeBytes);
    });
    const session = {
      schema: SESSION_SCHEMA,
      upload_id: uploadId,
      vehicle_id: vehicleId,
      clip_id: clipId,
      status: 'uploading',
      chunk_size_bytes: chunkSizeBytes,
      created_at: now,
      updated_at: now,
      metadata,
      files
    };
    const directory = sessionDir(vehicleId, uploadId);
    await fsp.mkdir(directory, { recursive: true });
    for (const kind of ['bag', 'preview']) {
      const handle = await fsp.open(path.join(directory, `${kind}.part`), 'w', 0o600);
      await handle.truncate(files[kind].size_bytes);
      await handle.close();
    }
    await atomicWriteJson(sessionPath(vehicleId, uploadId), session);
    return res.status(201).json({ ok: true, completed: false, session: publicSession(session) });
  }

  async function getSession(req, res) {
    const vehicleId = normalizeVehicleId(req.params.vehicleId);
    const uploadId = normalizeUploadId(req.params.uploadId);
    if (!vehicleId || !uploadId) return res.status(400).json({ ok: false, error: 'invalid_upload_target' });
    if (!requireVehicleUploadToken(req, res, tokenSecret, vehicleId)) return;
    const session = await loadSession(vehicleId, uploadId);
    if (!session) return res.status(404).json({ ok: false, error: 'upload_session_not_found' });
    return res.json({ ok: true, session: publicSession(session) });
  }

  async function uploadChunk(req, res) {
    const vehicleId = normalizeVehicleId(req.params.vehicleId);
    const uploadId = normalizeUploadId(req.params.uploadId);
    const kind = ['bag', 'preview'].includes(req.params.kind) ? req.params.kind : '';
    const index = Number(req.params.index);
    if (!vehicleId || !uploadId || !kind || !Number.isSafeInteger(index) || index < 0) {
      return res.status(400).json({ ok: false, error: 'invalid_upload_chunk_target' });
    }
    if (!requireVehicleUploadToken(req, res, tokenSecret, vehicleId)) return;

    return withSessionLock(`${vehicleId}/${uploadId}`, async () => {
      const session = await loadSession(vehicleId, uploadId);
      const file = session?.files?.[kind];
      if (!session || !file) return res.status(404).json({ ok: false, error: 'upload_session_not_found' });
      if (session.status !== 'uploading') {
        return res.status(409).json({ ok: false, error: 'upload_session_not_writable' });
      }
      if (index >= file.total_chunks) {
        return res.status(400).json({ ok: false, error: 'upload_chunk_out_of_range' });
      }
      const offset = index * session.chunk_size_bytes;
      const expectedBytes = Math.min(session.chunk_size_bytes, file.size_bytes - offset);
      const contentLength = Number(req.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength !== expectedBytes) {
        return res.status(400).json({ ok: false, error: 'upload_chunk_size_mismatch' });
      }
      const buffer = await readRequestBuffer(req, expectedBytes);
      if (buffer.length !== expectedBytes) {
        return res.status(400).json({ ok: false, error: 'upload_chunk_size_mismatch' });
      }
      const expectedChunkSha = normalizeSha256(req.get('x-chunk-sha256'));
      const actualChunkSha = crypto.createHash('sha256').update(buffer).digest('hex');
      if (expectedChunkSha && expectedChunkSha !== actualChunkSha) {
        return res.status(400).json({ ok: false, error: 'upload_chunk_sha256_mismatch' });
      }
      await ensureFreeSpace(rootDir, minFreeBytes, expectedBytes);
      const handle = await fsp.open(path.join(sessionDir(vehicleId, uploadId), `${kind}.part`), 'r+');
      try {
        await handle.write(buffer, 0, buffer.length, offset);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const received = new Set(file.received_chunks || []);
      received.add(index);
      file.received_chunks = Array.from(received).sort((left, right) => left - right);
      session.updated_at = isoNow();
      await atomicWriteJson(sessionPath(vehicleId, uploadId), session);
      return res.json({
        ok: true,
        kind,
        index,
        sha256: actualChunkSha,
        received_chunks: file.received_chunks.length,
        total_chunks: file.total_chunks
      });
    });
  }

  async function finalizeSession(req, res) {
    const vehicleId = normalizeVehicleId(req.params.vehicleId);
    const uploadId = normalizeUploadId(req.params.uploadId);
    if (!vehicleId || !uploadId) return res.status(400).json({ ok: false, error: 'invalid_upload_target' });
    if (!requireVehicleUploadToken(req, res, tokenSecret, vehicleId)) return;

    return withSessionLock(`${vehicleId}/${uploadId}`, async () => {
      const session = await loadSession(vehicleId, uploadId);
      if (!session) return res.status(404).json({ ok: false, error: 'upload_session_not_found' });
      if (session.status === 'ready') {
        const existing = await readJson(path.join(clipDir(vehicleId, session.clip_id), 'clip.json'));
        return res.json({ ok: true, clip: publicClip(existing) });
      }
      for (const kind of ['bag', 'preview']) {
        const file = session.files[kind];
        if ((file.received_chunks || []).length !== file.total_chunks) {
          return res.status(409).json({ ok: false, error: 'upload_incomplete', kind });
        }
        const actual = await sha256File(path.join(sessionDir(vehicleId, uploadId), `${kind}.part`));
        if (actual !== file.sha256) {
          session.status = 'failed';
          session.updated_at = isoNow();
          session.error = `${kind}_sha256_mismatch`;
          await atomicWriteJson(sessionPath(vehicleId, uploadId), session);
          return res.status(400).json({ ok: false, error: session.error });
        }
      }

      const preview = await parsePreview(
        path.join(sessionDir(vehicleId, uploadId), 'preview.part'),
        maxPreviewJsonBytes
      );
      if (normalizeVehicleId(preview.vehicle_id) !== vehicleId) {
        return res.status(400).json({ ok: false, error: 'preview_vehicle_mismatch' });
      }
      if (preview.clip_id && normalizeClipId(preview.clip_id) !== session.clip_id) {
        return res.status(400).json({ ok: false, error: 'preview_clip_mismatch' });
      }

      const destination = clipDir(vehicleId, session.clip_id);
      await fsp.mkdir(destination, { recursive: true });
      await fsp.rename(path.join(sessionDir(vehicleId, uploadId), 'bag.part'), path.join(destination, 'raw.bag'));
      await fsp.rename(
        path.join(sessionDir(vehicleId, uploadId), 'preview.part'),
        path.join(destination, 'preview.json.gz')
      );
      const uploadedAt = isoNow();
      const clip = {
        schema: 'jgzj_e2e_clip.v1',
        vehicle_id: vehicleId,
        clip_id: session.clip_id,
        captured_at: session.metadata.captured_at || preview.captured_at || null,
        uploaded_at: uploadedAt,
        duration_sec: session.metadata.duration_sec ?? toFiniteNumber(preview.duration_sec, null),
        frame_count: Array.isArray(preview.frames) ? preview.frames.length : 0,
        topics: session.metadata.topics,
        message_counts: session.metadata.message_counts,
        charging: session.metadata.charging,
        files: {
          bag: { size_bytes: session.files.bag.size_bytes, sha256: session.files.bag.sha256 },
          preview: {
            size_bytes: session.files.preview.size_bytes,
            sha256: session.files.preview.sha256
          }
        }
      };
      await atomicWriteJson(path.join(destination, 'clip.json'), clip);
      await appendIndex(indexPath, clip);
      session.status = 'ready';
      session.updated_at = uploadedAt;
      session.finalized_at = uploadedAt;
      await atomicWriteJson(sessionPath(vehicleId, uploadId), session);
      return res.json({ ok: true, clip: publicClip(clip) });
    });
  }

  app.post('/api/auto_ad/e2e-upload/:vehicleId/sessions', (req, res, next) => {
    createSession(req, res).catch(next);
  });
  app.get('/api/auto_ad/e2e-upload/:vehicleId/sessions/:uploadId', (req, res, next) => {
    getSession(req, res).catch(next);
  });
  app.put(
    '/api/auto_ad/e2e-upload/:vehicleId/sessions/:uploadId/files/:kind/chunks/:index',
    (req, res, next) => uploadChunk(req, res).catch(next)
  );
  app.post(
    '/api/auto_ad/e2e-upload/:vehicleId/sessions/:uploadId/finalize',
    (req, res, next) => finalizeSession(req, res).catch(next)
  );

  const privateRead = options.requirePermission('page:end-to-end-autonomous-driving:view');

  app.get('/api/e2e-autonomous-driving/clips', privateRead, async (req, res, next) => {
    try {
      const vehicleFilter = req.query.vehicle_id ? normalizeVehicleId(req.query.vehicle_id) : '';
      const limit = Math.min(500, toPositiveInteger(req.query.limit, 100));
      const offset = Math.max(0, Number.parseInt(String(req.query.offset || '0'), 10) || 0);
      let clips = await readClipIndex(indexPath);
      if (vehicleFilter) clips = clips.filter((clip) => clip.vehicle_id === vehicleFilter);
      const total = clips.length;
      const rows = clips.slice(offset, offset + limit).map(publicClip);
      const allClips = await readClipIndex(indexPath);
      const summary = {
        clip_count: allClips.length,
        vehicle_count: new Set(allClips.map((clip) => clip.vehicle_id)).size,
        total_duration_sec: allClips.reduce((sum, clip) => sum + (toFiniteNumber(clip.duration_sec, 0) || 0), 0),
        total_bag_bytes: allClips.reduce((sum, clip) => sum + (toFiniteNumber(clip.files?.bag?.size_bytes, 0) || 0), 0),
        total_preview_bytes: allClips.reduce(
          (sum, clip) => sum + (toFiniteNumber(clip.files?.preview?.size_bytes, 0) || 0),
          0
        )
      };
      res.setHeader('Cache-Control', 'private, no-store');
      return res.json({ ok: true, generated_at: isoNow(), total, offset, limit, summary, clips: rows });
    } catch (error) {
      return next(error);
    }
  });

  app.get(
    '/api/e2e-autonomous-driving/clips/:vehicleId/:clipId',
    privateRead,
    async (req, res, next) => {
      try {
        const vehicleId = normalizeVehicleId(req.params.vehicleId);
        const clipId = normalizeClipId(req.params.clipId);
        if (!vehicleId || !clipId) return res.status(400).json({ ok: false, error: 'invalid_clip_id' });
        const clip = await readJson(path.join(clipDir(vehicleId, clipId), 'clip.json'));
        if (!clip) return res.status(404).json({ ok: false, error: 'clip_not_found' });
        res.setHeader('Cache-Control', 'private, no-store');
        return res.json({ ok: true, clip: publicClip(clip) });
      } catch (error) {
        return next(error);
      }
    }
  );

  app.get(
    '/api/e2e-autonomous-driving/clips/:vehicleId/:clipId/preview',
    privateRead,
    async (req, res, next) => {
      try {
        const vehicleId = normalizeVehicleId(req.params.vehicleId);
        const clipId = normalizeClipId(req.params.clipId);
        if (!vehicleId || !clipId) return res.status(400).json({ ok: false, error: 'invalid_clip_id' });
        const filePath = path.join(clipDir(vehicleId, clipId), 'preview.json.gz');
        await fsp.access(filePath);
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Encoding', 'gzip');
        return fs.createReadStream(filePath).pipe(res);
      } catch (error) {
        if (error?.code === 'ENOENT') return res.status(404).json({ ok: false, error: 'preview_not_found' });
        return next(error);
      }
    }
  );

  app.get(
    '/api/e2e-autonomous-driving/clips/:vehicleId/:clipId/bag',
    privateRead,
    async (req, res, next) => {
      try {
        const vehicleId = normalizeVehicleId(req.params.vehicleId);
        const clipId = normalizeClipId(req.params.clipId);
        if (!vehicleId || !clipId) return res.status(400).json({ ok: false, error: 'invalid_clip_id' });
        const filePath = path.join(clipDir(vehicleId, clipId), 'raw.bag');
        const stat = await fsp.stat(filePath);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${vehicleId}_${clipId}.bag"`);
        res.setHeader('Cache-Control', 'private, no-store');
        const range = req.get('range') ? parseRangeHeader(req.get('range'), stat.size) : null;
        if (req.get('range') && !range) {
          res.status(416).setHeader('Content-Range', `bytes */${stat.size}`);
          return res.end();
        }
        if (range) {
          res.status(206);
          res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
          res.setHeader('Content-Length', range.end - range.start + 1);
          return fs.createReadStream(filePath, range).pipe(res);
        }
        res.setHeader('Content-Length', stat.size);
        return fs.createReadStream(filePath).pipe(res);
      } catch (error) {
        if (error?.code === 'ENOENT') return res.status(404).json({ ok: false, error: 'bag_not_found' });
        return next(error);
      }
    }
  );

  return {
    rootDir,
    deriveVehicleUploadToken: (vehicleId) => deriveVehicleUploadToken(tokenSecret, vehicleId)
  };
}

module.exports = {
  DEFAULT_CHUNK_SIZE_BYTES,
  DEFAULT_MAX_BAG_BYTES,
  DEFAULT_MAX_PREVIEW_BYTES,
  PREVIEW_SCHEMA,
  deriveVehicleUploadToken,
  normalizeClipId,
  normalizeVehicleId,
  parseRangeHeader,
  registerE2eDataReplayRoutes
};
