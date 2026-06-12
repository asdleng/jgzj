const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;
const MAX_STRING_LENGTH = 1200;
const MAX_ARRAY_ITEMS = 40;
const MAX_OBJECT_KEYS = 80;

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return String(value || '').trim();
}

function makeRecordId(at, seed = '') {
  const hash = crypto
    .createHash('sha1')
    .update(`${at}|${seed}|${crypto.randomBytes(8).toString('hex')}`)
    .digest('hex')
    .slice(0, 16);
  return `op_${Date.parse(at) || Date.now()}_${hash}`;
}

function isSensitiveKey(key) {
  return /password|passwd|secret|token|credential|authorization|cookie|session|api[_-]?key/i.test(
    String(key || '')
  );
}

function redactSensitiveString(value) {
  return String(value || '').replace(/((?:https?|git):\/\/[^:/\s@]+:)([^@\s]+)(@)/gi, '$1***$3');
}

function safeDetail(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    const redacted = redactSensitiveString(value);
    return redacted.length > MAX_STRING_LENGTH ? `${redacted.slice(0, MAX_STRING_LENGTH)}...` : redacted;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    if (depth >= 5) {
      return `[Array(${value.length})]`;
    }
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => safeDetail(item, depth + 1, seen));
  }
  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }
    if (depth >= 5) {
      return '[Object]';
    }
    seen.add(value);
    const output = {};
    Object.entries(value)
      .slice(0, MAX_OBJECT_KEYS)
      .forEach(([key, item]) => {
        output[key] = isSensitiveKey(key) ? (item ? '***' : item) : safeDetail(item, depth + 1, seen);
      });
    seen.delete(value);
    return output;
  }
  return String(value);
}

function normalizeRecord(input = {}) {
  const at = normalizeText(input.at) || nowIso();
  const actor = normalizeText(input.actor) || null;
  const category = normalizeText(input.category) || 'system';
  const action = normalizeText(input.action) || 'operation';
  const targetId = normalizeText(input.target_id || input.target) || null;
  const vehicleId = normalizeText(input.vehicle_id) || null;
  const status = Number.isFinite(Number(input.status)) ? Number(input.status) : null;
  const ok =
    typeof input.ok === 'boolean'
      ? input.ok
      : status == null
        ? null
        : status >= 200 && status < 400;

  return {
    id: normalizeText(input.id) || makeRecordId(at, `${actor}|${category}|${action}|${targetId || ''}`),
    at,
    actor,
    actor_name: normalizeText(input.actor_name) || actor,
    category,
    action,
    target_type: normalizeText(input.target_type) || null,
    target_id: targetId,
    vehicle_id: vehicleId,
    permission: normalizeText(input.permission) || null,
    ok,
    status,
    duration_ms: Number.isFinite(Number(input.duration_ms)) ? Number(input.duration_ms) : null,
    method: normalizeText(input.method) || null,
    path: normalizeText(input.path) || null,
    ip: normalizeText(input.ip) || null,
    user_agent: normalizeText(input.user_agent) || null,
    source: normalizeText(input.source) || 'jgzj-site',
    detail: safeDetail(input.detail || {})
  };
}

function toTimestamp(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : null;
}

function includesText(value, query) {
  if (!query) {
    return true;
  }
  return String(value || '').toLowerCase().includes(query);
}

function recordMatches(record, filters = {}) {
  const actor = normalizeText(filters.actor).toLowerCase();
  const category = normalizeText(filters.category).toLowerCase();
  const action = normalizeText(filters.action).toLowerCase();
  const vehicleId = normalizeText(filters.vehicle_id).toLowerCase();
  const target = normalizeText(filters.target).toLowerCase();
  const query = normalizeText(filters.q).toLowerCase();
  const ok = normalizeText(filters.ok);
  const from = toTimestamp(filters.from);
  const to = toTimestamp(filters.to);
  const at = toTimestamp(record.at);

  if (actor && String(record.actor || '').toLowerCase() !== actor) {
    return false;
  }
  if (category && String(record.category || '').toLowerCase() !== category) {
    return false;
  }
  if (action && !includesText(record.action, action)) {
    return false;
  }
  if (vehicleId && String(record.vehicle_id || '').toLowerCase() !== vehicleId) {
    return false;
  }
  if (target && !includesText(record.target_id, target)) {
    return false;
  }
  if (ok === 'true' && record.ok !== true) {
    return false;
  }
  if (ok === 'false' && record.ok !== false) {
    return false;
  }
  if (from && at && at < from) {
    return false;
  }
  if (to && at && at > to) {
    return false;
  }
  if (query) {
    const haystack = [
      record.actor,
      record.category,
      record.action,
      record.target_id,
      record.vehicle_id,
      record.path,
      JSON.stringify(record.detail || {})
    ]
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(query)) {
      return false;
    }
  }
  return true;
}

function paginateRecords(records, filters = {}) {
  const page = Math.max(1, Number.parseInt(String(filters.page || '1'), 10) || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number.parseInt(String(filters.page_size || DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE)
  );
  const filtered = records
    .filter((record) => recordMatches(record, filters))
    .sort((left, right) => (Date.parse(right.at || '') || 0) - (Date.parse(left.at || '') || 0));
  const total = filtered.length;
  const offset = (page - 1) * pageSize;
  const items = filtered.slice(offset, offset + pageSize);
  return {
    page,
    page_size: pageSize,
    total,
    total_pages: Math.max(1, Math.ceil(total / pageSize)),
    items
  };
}

class OperationAuditStore {
  constructor(options = {}) {
    this.filePath = path.resolve(
      options.filePath || path.join(options.rootDir || process.cwd(), '.runtime/operation-audit.jsonl')
    );
    this.writeLock = Promise.resolve();
  }

  async record(input = {}) {
    const record = normalizeRecord(input);
    const line = `${JSON.stringify(record)}\n`;
    const run = this.writeLock.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.appendFile(this.filePath, line, 'utf8');
      return record;
    });
    this.writeLock = run.catch(() => {});
    return run;
  }

  async readAll() {
    let text = '';
    try {
      text = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    return text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return normalizeRecord(JSON.parse(line));
        } catch (_error) {
          return null;
        }
      })
      .filter(Boolean);
  }

  async query(filters = {}, extraRecords = []) {
    const records = await this.readAll();
    return paginateRecords([...records, ...extraRecords.map(normalizeRecord)], filters);
  }
}

function createOperationAuditStore(options = {}) {
  return new OperationAuditStore(options);
}

module.exports = {
  createOperationAuditStore,
  normalizeRecord,
  paginateRecords,
  safeDetail
};
