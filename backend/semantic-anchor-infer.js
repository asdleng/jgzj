const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SEMANTIC_CLASSES = [
  'entrance',
  'gate',
  'door',
  'building_entrance',
  'charging_station',
  'fire_extinguisher',
  'sign',
  'elevator',
  'stairs',
  'kiosk',
  'barrier'
];

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function sanitizeIdentifier(value, fallback = 'unknown') {
  const normalized = String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || fallback;
}

function normalizeSemanticClasses(raw) {
  const source = Array.isArray(raw)
    ? raw
    : String(raw || '')
        .split(',')
        .map((item) => item.trim());
  const seen = new Set();
  const classes = [];
  for (const item of source) {
    const normalized = sanitizeIdentifier(item, '').toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    classes.push(normalized);
    if (classes.length >= 32) {
      break;
    }
  }
  return classes.length ? classes : [...DEFAULT_SEMANTIC_CLASSES];
}

function stripCodeFence(text) {
  const value = String(text || '').trim();
  const fenced = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : value;
}

function parseJsonObject(text) {
  const stripped = stripCodeFence(text);
  try {
    return JSON.parse(stripped);
  } catch (_error) {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(stripped.slice(start, end + 1));
    }
    throw _error;
  }
}

function normalizeSemanticBox(raw, index, allowedClasses) {
  let label;
  let bbox;
  let score;
  let evidence;
  if (Array.isArray(raw)) {
    [label, ...bbox] = raw;
    score = bbox[4];
    evidence = bbox[5];
    bbox = bbox.slice(0, 4);
  } else if (raw && typeof raw === 'object') {
    label = raw.label || raw.class || raw.class_name || raw.name;
    bbox = raw.bbox_1000 || raw.bbox || raw.box || [
      raw.x1,
      raw.y1,
      raw.x2,
      raw.y2
    ];
    score = raw.score ?? raw.confidence;
    evidence = raw.evidence || raw.note || raw.description;
  }

  const normalizedLabel = sanitizeIdentifier(label, '').toLowerCase();
  if (!normalizedLabel || !Array.isArray(bbox) || bbox.length < 4) {
    return null;
  }
  if (allowedClasses.size && !allowedClasses.has(normalizedLabel)) {
    return null;
  }

  const coords = bbox.slice(0, 4).map((value) => Number(value));
  if (!coords.every(Number.isFinite)) {
    return null;
  }
  const [x1, y1, x2, y2] = coords.map((value) => clamp(value, 0, 1000));
  if (x2 - x1 < 2 || y2 - y1 < 2) {
    return null;
  }

  const parsedScore = Number(score);
  return {
    id: `${normalizedLabel}_${index + 1}`,
    label: normalizedLabel,
    bbox_1000: [x1, y1, x2, y2],
    score: Number.isFinite(parsedScore) ? clamp(parsedScore, 0, 1) : 0.5,
    evidence: String(evidence || '').trim().slice(0, 240)
  };
}

function parseQwenSemanticReply(rawReply, classes) {
  const parsed = parseJsonObject(rawReply);
  const rawBoxes = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.b)
      ? parsed.b
      : Array.isArray(parsed.boxes)
        ? parsed.boxes
        : Array.isArray(parsed.labels)
          ? parsed.labels
          : [];
  const allowedClasses = new Set(normalizeSemanticClasses(classes));
  const labels = rawBoxes
    .map((item, index) => normalizeSemanticBox(item, index, allowedClasses))
    .filter(Boolean)
    .slice(0, 30);
  return {
    quality: String(parsed.q || parsed.quality || 'unknown').trim().slice(0, 40),
    labels
  };
}

function timingSafeEqualText(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function readVehicleToken(tokenPath) {
  try {
    return fsSync.readFileSync(tokenPath, 'utf8').trim();
  } catch (_error) {
    return '';
  }
}

function semanticAnchorPrompt(classes, customPrompt) {
  if (String(customPrompt || '').trim()) {
    return String(customPrompt).trim().slice(0, 4000);
  }
  return [
    'Detect static semantic landmarks useful for robot navigation in this image.',
    `Allowed class names: ${classes.join(', ')}.`,
    'Exclude people, vehicles, animals, vegetation, shadows, reflections and movable clutter.',
    'Return compact JSON only, with no markdown:',
    '{"q":"good","b":[["class",x1,y1,x2,y2,score,"short visual evidence"]]}',
    'Coordinates must be normalized to 0..1000 in xyxy order.',
    'Use an empty b array when no allowed landmark is clearly visible.',
    'Do not invent occluded or uncertain objects. Keep at most 20 boxes.'
  ].join('\n');
}

async function archiveSemanticInference({
  archiveRoot,
  requestId,
  vehicleId,
  cameraId,
  imageBuffer,
  imageMimeType,
  record
}) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const requestDir = path.join(
    archiveRoot,
    day,
    `${sanitizeIdentifier(vehicleId)}_${sanitizeIdentifier(cameraId)}_${requestId}`
  );
  await fs.mkdir(requestDir, { recursive: true });
  const extension = imageMimeType === 'image/png' ? '.png' : '.jpg';
  await Promise.all([
    fs.writeFile(path.join(requestDir, `image${extension}`), imageBuffer),
    fs.writeFile(
      path.join(requestDir, 'result.json'),
      `${JSON.stringify(record, null, 2)}\n`,
      'utf8'
    )
  ]);
  return path.relative(archiveRoot, requestDir).split(path.sep).join('/');
}

function registerSemanticAnchorInferRoutes(options) {
  const {
    app,
    projectRoot,
    qwen36MmModel,
    qwen36MmChatUrl,
    qwen36MmTimeoutMs,
    qwen36MmMaxImageBytes,
    qwen36MmProtection,
    beginQwen36Request,
    qwen36ProtectionSnapshot,
    normalizeReply
  } = options;
  const tokenPath = path.resolve(
    process.env.SEMANTIC_ANCHOR_TOKEN_PATH ||
      path.join(projectRoot, '.runtime/semantic_anchor/vehicle_token')
  );
  const archiveRoot = path.resolve(
    process.env.SEMANTIC_ANCHOR_ARCHIVE_ROOT ||
      path.join(projectRoot, '.runtime/semantic_anchor/inference')
  );
  const allowedVehicles = new Set(
    String(process.env.SEMANTIC_ANCHOR_ALLOWED_VEHICLES || 'BIT-0041')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  );

  function requireVehicleToken(req, res, next) {
    const expected = readVehicleToken(tokenPath);
    if (!expected) {
      return res.status(503).json({ ok: false, error: 'semantic_anchor_token_not_configured' });
    }
    const provided = String(req.get('x-semantic-anchor-token') || '').trim();
    if (!provided || !timingSafeEqualText(provided, expected)) {
      return res.status(401).json({ ok: false, error: 'invalid_semantic_anchor_token' });
    }
    return next();
  }

  app.get('/api/vehicle-semantic-anchor/health', requireVehicleToken, (_req, res) => {
    return res.json({
      ok: true,
      schema: 'jgzj_vehicle_semantic_anchor_infer.v1',
      model: qwen36MmModel,
      allowed_vehicles: [...allowedVehicles],
      protection: qwen36ProtectionSnapshot(qwen36MmProtection)
    });
  });

  app.post('/api/vehicle-semantic-anchor/infer', requireVehicleToken, async (req, res) => {
    const startedAt = Date.now();
    const vehicleId = String(req.body?.vehicle_id || '').trim();
    const cameraId = String(req.body?.camera_id || '').trim();
    const image = req.body?.image;
    if (!vehicleId || !cameraId) {
      return res.status(400).json({ ok: false, error: 'vehicle_id_and_camera_id_required' });
    }
    if (allowedVehicles.size && !allowedVehicles.has(vehicleId)) {
      return res.status(403).json({ ok: false, error: 'vehicle_not_allowed' });
    }
    if (!image?.mime_type || !image?.data_base64) {
      return res.status(400).json({ ok: false, error: 'image_required' });
    }

    const imageBuffer = Buffer.from(String(image.data_base64 || ''), 'base64');
    if (!imageBuffer.length) {
      return res.status(400).json({ ok: false, error: 'image_empty' });
    }
    if (imageBuffer.length > qwen36MmMaxImageBytes) {
      return res.status(413).json({
        ok: false,
        error: 'image_too_large',
        max_image_bytes: qwen36MmMaxImageBytes,
        image_size_bytes: imageBuffer.length
      });
    }

    const classes = normalizeSemanticClasses(req.body?.classes);
    const promptText = semanticAnchorPrompt(classes, req.body?.prompt_text);
    const imageUrl = `data:${image.mime_type};base64,${image.data_base64}`;
    const payload = {
      model: qwen36MmModel,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageUrl } },
            { type: 'text', text: promptText }
          ]
        }
      ],
      max_tokens: 1200,
      temperature: 0.1,
      stream: false,
      chat_template_kwargs: { enable_thinking: false }
    };

    let guard;
    try {
      guard = beginQwen36Request(qwen36MmProtection);
    } catch (error) {
      return res.status(error.status || 503).json({
        ok: false,
        error: error.code || 'qwen36_mm_busy',
        detail: error.message,
        protection: qwen36ProtectionSnapshot(qwen36MmProtection)
      });
    }

    try {
      const upstreamResponse = await fetch(qwen36MmChatUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(qwen36MmTimeoutMs)
      });
      if (!upstreamResponse.ok) {
        const detail = normalizeReply(await upstreamResponse.text());
        const upstreamError = new Error(detail || `qwen36-mm upstream ${upstreamResponse.status}`);
        guard.failure(upstreamError);
        return res.status(502).json({
          ok: false,
          error: 'semantic_anchor_upstream_failed',
          status: upstreamResponse.status,
          detail: detail.slice(0, 1000),
          protection: qwen36ProtectionSnapshot(qwen36MmProtection)
        });
      }

      const upstreamData = await upstreamResponse.json();
      const message = upstreamData?.choices?.[0]?.message || {};
      const rawReply = normalizeReply(message.content || message.reasoning || '');
      let parsed;
      try {
        parsed = parseQwenSemanticReply(rawReply, classes);
      } catch (error) {
        guard.failure(error);
        return res.status(502).json({
          ok: false,
          error: 'semantic_anchor_reply_parse_failed',
          detail: error.message,
          raw_reply: rawReply.slice(0, 2000),
          protection: qwen36ProtectionSnapshot(qwen36MmProtection)
        });
      }

      guard.success();
      const requestId = `sem_${startedAt}_${crypto.randomBytes(4).toString('hex')}`;
      const responseRecord = {
        schema: 'jgzj_vehicle_semantic_anchor_infer.v1',
        request_id: requestId,
        generated_at: new Date().toISOString(),
        vehicle_id: vehicleId,
        camera_id: cameraId,
        model: qwen36MmModel,
        classes,
        quality: parsed.quality,
        labels: parsed.labels,
        latency_ms: Date.now() - startedAt,
        image_sha256: crypto.createHash('sha256').update(imageBuffer).digest('hex'),
        raw_reply: rawReply
      };
      const archiveRelDir = await archiveSemanticInference({
        archiveRoot,
        requestId,
        vehicleId,
        cameraId,
        imageBuffer,
        imageMimeType: image.mime_type,
        record: responseRecord
      });
      return res.json({
        ok: true,
        ...responseRecord,
        archive_rel_dir: archiveRelDir,
        protection: qwen36ProtectionSnapshot(qwen36MmProtection)
      });
    } catch (error) {
      guard.failure(error);
      const isAbort = error.name === 'TimeoutError' || error.name === 'AbortError';
      return res.status(isAbort ? 504 : 502).json({
        ok: false,
        error: isAbort ? 'semantic_anchor_timeout' : 'semantic_anchor_unavailable',
        detail: error.message,
        protection: qwen36ProtectionSnapshot(qwen36MmProtection)
      });
    } finally {
      guard.release();
    }
  });

  console.info(
    'semantic_anchor_routes_registered',
    JSON.stringify({
      token_path: tokenPath,
      archive_root: archiveRoot,
      allowed_vehicles: [...allowedVehicles]
    })
  );
}

module.exports = {
  DEFAULT_SEMANTIC_CLASSES,
  normalizeSemanticClasses,
  parseQwenSemanticReply,
  registerSemanticAnchorInferRoutes
};
