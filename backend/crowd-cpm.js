const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const DEFAULT_STATUS_TOOL_TIMEOUT_S = 8;
const DEFAULT_CAPTURE_TIMEOUT_S = 35;
const DEFAULT_HTTP_EXTRA_TIMEOUT_MS = 5000;
const DEFAULT_STATUS_CONCURRENCY = 2;
const DEFAULT_CAPTURE_CONCURRENCY = 1;
const DEFAULT_MAX_IMAGES_PER_RUN = 2;
const DEFAULT_CAPTURE_COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_MAX_STORAGE_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_FRESH_VEHICLE_MS = 5 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function toFiniteInteger(value, fallback, options) {
  const num = Number.parseInt(String(value == null ? '' : value), 10);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  const min = options && Number.isFinite(options.min) ? options.min : num;
  const max = options && Number.isFinite(options.max) ? options.max : num;
  return Math.min(max, Math.max(min, num));
}

function toFiniteNumber(value, fallback, options) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  const min = options && Number.isFinite(options.min) ? options.min : num;
  const max = options && Number.isFinite(options.max) ? options.max : num;
  return Math.min(max, Math.max(min, num));
}

function sanitizeName(value, fallback) {
  const text = String(value || '').trim();
  const safe = text.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[_ .-]+|[_ .-]+$/g, '');
  return safe || fallback;
}

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    return fallback;
  }
}

function getNested(value, keys) {
  let cursor = value;
  for (let i = 0; i < keys.length; i += 1) {
    if (!cursor || typeof cursor !== 'object') {
      return undefined;
    }
    cursor = cursor[keys[i]];
  }
  return cursor;
}

function unwrapRosValue(value) {
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'data')) {
    return value.data;
  }
  return value;
}

function numberValue(value) {
  const raw = unwrapRosValue(value);
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

function booleanValue(value) {
  const raw = unwrapRosValue(value);
  if (raw === true || raw === false) return raw;
  if (raw === 1 || raw === '1') return true;
  if (raw === 0 || raw === '0') return false;
  if (String(raw).toLowerCase() === 'true') return true;
  if (String(raw).toLowerCase() === 'false') return false;
  return null;
}

function dateStampCompact(date) {
  const pad = (num) => String(num).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('');
}

function timeStampCompact(date) {
  const pad = (num) => String(num).padStart(2, '0');
  return [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('');
}

function mimeToExt(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/jpeg' || mime === 'image/jpg') return '.jpg';
  return '.jpg';
}

function stripDataUri(value, mimeType) {
  let payload = String(value || '').trim();
  let mime = mimeType || 'image/jpeg';
  if (payload.indexOf('data:') === 0) {
    const comma = payload.indexOf(',');
    const header = comma >= 0 ? payload.slice(0, comma) : '';
    const match = /^data:([^;,]+)/i.exec(header);
    if (match) {
      mime = match[1];
    }
    payload = comma >= 0 ? payload.slice(comma + 1) : payload;
  }
  return {
    base64: payload.replace(/\s+/g, ''),
    mime_type: mime
  };
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch (_error) {
    return false;
  }
}

module.exports = function registerCrowdCpmRoutes(app, options) {
  options = options || {};
  const requirePermission = options.requirePermission;
  if (typeof requirePermission !== 'function') {
    throw new Error('registerCrowdCpmRoutes requires options.requirePermission');
  }

  const cloudAgentBaseUrl = String(
    options.cloudAgentBaseUrl || process.env.CLOUD_AGENT_BASE_URL || 'http://127.0.0.1:8000'
  ).replace(/\/+$/, '');
  const rootDir = path.resolve(options.rootDir || path.resolve(__dirname, '..'));
  const runtimeRoot = path.resolve(
    process.env.CROWD_CPM_RUNTIME_ROOT || path.join(rootDir, '.runtime/crowd-cpm')
  );
  const framesRoot = path.join(runtimeRoot, 'frames');
  const logDir = path.join(runtimeRoot, 'logs');
  const statePath = path.join(runtimeRoot, 'collector-state.json');
  const missionSnapshotPath = path.join(runtimeRoot, 'last-mission-snapshot.json');
  const indexLogPath = path.join(logDir, 'frames-index.jsonl');

  const statusToolTimeoutS = toFiniteNumber(
    process.env.CROWD_CPM_STATUS_TOOL_TIMEOUT_S,
    DEFAULT_STATUS_TOOL_TIMEOUT_S,
    { min: 3, max: 30 }
  );
  const captureTimeoutS = toFiniteNumber(
    process.env.CROWD_CPM_CAPTURE_TIMEOUT_S,
    DEFAULT_CAPTURE_TIMEOUT_S,
    { min: 10, max: 90 }
  );
  const statusConcurrency = toFiniteInteger(
    process.env.CROWD_CPM_STATUS_CONCURRENCY,
    DEFAULT_STATUS_CONCURRENCY,
    { min: 1, max: 4 }
  );
  const captureConcurrency = toFiniteInteger(
    process.env.CROWD_CPM_CAPTURE_CONCURRENCY,
    DEFAULT_CAPTURE_CONCURRENCY,
    { min: 1, max: 2 }
  );
  const maxImagesPerRunDefault = toFiniteInteger(
    process.env.CROWD_CPM_MAX_IMAGES_PER_RUN,
    DEFAULT_MAX_IMAGES_PER_RUN,
    { min: 1, max: 20 }
  );
  const captureCooldownMs = toFiniteInteger(
    process.env.CROWD_CPM_CAPTURE_COOLDOWN_MS,
    DEFAULT_CAPTURE_COOLDOWN_MS,
    { min: 60 * 1000, max: 24 * 60 * 60 * 1000 }
  );
  const retentionDays = toFiniteNumber(
    process.env.CROWD_CPM_RETENTION_DAYS,
    DEFAULT_RETENTION_DAYS,
    { min: 1, max: 90 }
  );
  const maxStorageBytes = toFiniteInteger(
    process.env.CROWD_CPM_MAX_STORAGE_BYTES,
    DEFAULT_MAX_STORAGE_BYTES,
    { min: 100 * 1024 * 1024, max: 200 * 1024 * 1024 * 1024 }
  );
  const minFreeBytes = toFiniteInteger(
    process.env.CROWD_CPM_MIN_FREE_BYTES,
    DEFAULT_MIN_FREE_BYTES,
    { min: 100 * 1024 * 1024, max: 200 * 1024 * 1024 * 1024 }
  );
  const freshVehicleMs = toFiniteInteger(
    process.env.CROWD_CPM_FRESH_VEHICLE_MS,
    DEFAULT_FRESH_VEHICLE_MS,
    { min: 30 * 1000, max: 60 * 60 * 1000 }
  );
  const defaultCameraIds = String(process.env.CROWD_CPM_CAPTURE_CAMERA_IDS || 'camera1')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 4);
  const defaultCaptureQuality = toFiniteInteger(
    process.env.CROWD_CPM_CAPTURE_QUALITY,
    45,
    { min: 20, max: 90 }
  );
  const defaultCaptureMaxWidth = toFiniteInteger(
    process.env.CROWD_CPM_CAPTURE_MAX_WIDTH,
    320,
    { min: 160, max: 1280 }
  );

  let collectionInFlight = false;
  let missionSnapshotInFlight = false;
  let cachedMissionSnapshot = null;

  async function ensureRuntimeDirs() {
    await Promise.all([
      fsp.mkdir(runtimeRoot, { recursive: true }),
      fsp.mkdir(framesRoot, { recursive: true }),
      fsp.mkdir(logDir, { recursive: true })
    ]);
  }

  async function readCollectorState() {
    await ensureRuntimeDirs();
    try {
      const parsed = JSON.parse(await fsp.readFile(statePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        parsed.last_capture_by_vehicle =
          parsed.last_capture_by_vehicle && typeof parsed.last_capture_by_vehicle === 'object'
            ? parsed.last_capture_by_vehicle
            : {};
        return parsed;
      }
    } catch (_error) {
      // Use a fresh state below.
    }
    return {
      version: 1,
      last_capture_by_vehicle: {},
      updated_at: nowIso()
    };
  }

  async function writeCollectorState(state) {
    await ensureRuntimeDirs();
    const nextState = {
      version: 1,
      last_capture_by_vehicle: {},
      ...(state || {}),
      updated_at: nowIso()
    };
    const tmpPath = `${statePath}.${process.pid}.tmp`;
    await fsp.writeFile(tmpPath, JSON.stringify(nextState, null, 2), 'utf8');
    await fsp.rename(tmpPath, statePath);
  }

  async function appendIndexLog(entry) {
    try {
      await ensureRuntimeDirs();
      await fsp.appendFile(indexLogPath, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (_error) {
      // Metadata sidecar JSON is authoritative; index log is only an append-only aid.
    }
  }

  async function fetchCloudAgentJson(pathname, fetchOptions) {
    const url = new URL(pathname, `${cloudAgentBaseUrl}/`).toString();
    const body = fetchOptions && fetchOptions.body ? JSON.stringify(fetchOptions.body) : null;
    const timeoutMs =
      fetchOptions && fetchOptions.timeoutMs
        ? fetchOptions.timeoutMs
        : 15000;
    const response = await fetch(url, {
      method: (fetchOptions && fetchOptions.method) || 'GET',
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const rawText = await response.text();
    const payload = safeJsonParse(rawText, null);
    if (!response.ok) {
      const error = new Error(
        (payload && (payload.error || payload.detail || payload.message)) ||
          rawText.slice(0, 240) ||
          `cloud_agent_http_${response.status}`
      );
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload || {};
  }

  async function listVehicles() {
    const payload = await fetchCloudAgentJson('/api/vehicles', { timeoutMs: 8000 });
    return Array.isArray(payload.vehicles) ? payload.vehicles : [];
  }

  async function callVehicleTool(vehicleId, toolName, args, timeoutS) {
    const startedAt = Date.now();
    const normalizedTimeoutS = toFiniteNumber(timeoutS, statusToolTimeoutS, { min: 3, max: 120 });
    try {
      const payload = await fetchCloudAgentJson(
        `/api/vehicles/${encodeURIComponent(vehicleId)}/tools/${encodeURIComponent(toolName)}`,
        {
          method: 'POST',
          body: {
            args: args || {},
            timeout_s: normalizedTimeoutS
          },
          timeoutMs: Math.ceil(normalizedTimeoutS * 1000) + DEFAULT_HTTP_EXTRA_TIMEOUT_MS
        }
      );
      const response = payload.response || {};
      return {
        ok: response.ok === true,
        tool: toolName,
        elapsed_ms: Date.now() - startedAt,
        result: response.result || null,
        error: response.error || null
      };
    } catch (error) {
      return {
        ok: false,
        tool: toolName,
        elapsed_ms: Date.now() - startedAt,
        result: null,
        error: error.message || 'tool_call_failed',
        status: error.status || null
      };
    }
  }

  async function mapWithConcurrency(items, limit, worker) {
    const normalizedLimit = Math.max(1, Math.min(Number(limit) || 1, items.length || 1));
    const results = new Array(items.length);
    let cursor = 0;
    const runners = Array.from({ length: normalizedLimit }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await worker(items[index], index);
      }
    });
    await Promise.all(runners);
    return results;
  }

  function extractPlanningSample(planningResult) {
    return getNested(planningResult, ['topics', 'current_planning_status', 'sample']) || {};
  }

  function classifyMission(vehicle, toolResults) {
    const planning = toolResults.planning && toolResults.planning.result;
    const routing = toolResults.routing && toolResults.routing.result;
    const can = toolResults.can && toolResults.can.result;
    const planningSummary = (planning && planning.summary) || {};
    const routingSummary = (routing && routing.summary) || {};
    const canSummary = (can && can.summary) || {};
    const planningSample = extractPlanningSample(planning);
    const telemetryVehicle =
      vehicle && vehicle.telemetry && vehicle.telemetry.vehicle
        ? vehicle.telemetry.vehicle
        : {};

    const speedKph = numberValue(
      canSummary.speed != null ? canSummary.speed : telemetryVehicle.speed_kph
    );
    const moving = speedKph != null && Math.abs(speedKph) > 0.3;
    const plannerRunning = numberValue(planningSummary.planner_running);
    const vehicleIdleStatus = numberValue(planningSummary.vehicle_idle_status);
    const currentLoop = numberValue(planningSummary.current_loop_index);
    const totalLoop = numberValue(planningSummary.total_loop_sum);
    const currentRefline = numberValue(planningSummary.current_refline_index);
    const totalRefline = numberValue(planningSummary.total_refline_sum);
    const trajectoryLength = numberValue(planningSummary.trajectory_total_length);
    const trajectoryPointCount = numberValue(planningSummary.trajectory_point_count);
    const currentScenario = numberValue(planningSummary.current_scenario);
    const currentAction = numberValue(planningSummary.current_action);
    const longTimeStop = booleanValue(planningSample.long_time_stop);
    const inChargerZone = booleanValue(planningSample.in_charger_zone);
    const batteryChargeState = numberValue(canSummary.battery_charge_state);
    const routePathIds = Array.isArray(routingSummary.current_path_string_ids)
      ? routingSummary.current_path_string_ids
      : [];

    const routeProgress =
      totalLoop != null &&
      totalRefline != null &&
      currentLoop != null &&
      currentRefline != null &&
      totalLoop > 0 &&
      totalRefline > 0;
    const multiSegmentTask =
      routeProgress &&
      (totalLoop > 1 || totalRefline > 2 || currentLoop < totalLoop);
    const plannerActive = plannerRunning != null && plannerRunning > 0;
    const hasTrajectory =
      trajectoryPointCount != null &&
      trajectoryPointCount > 0 &&
      trajectoryLength != null;
    const taskEvidence =
      plannerActive ||
      multiSegmentTask ||
      routePathIds.length > 0 ||
      (routeProgress && hasTrajectory && trajectoryLength > 0 && totalRefline > 2);

    const reasons = [];
    let state = 'unknown';
    let confidence = 'low';

    if (!toolResults.planning || !toolResults.planning.ok) reasons.push('planning_unavailable');
    if (!toolResults.can || !toolResults.can.ok) reasons.push('can_unavailable');
    if (!toolResults.routing || !toolResults.routing.ok) reasons.push('routing_unavailable');

    if (inChargerZone === true || (batteryChargeState != null && batteryChargeState > 0)) {
      state = 'charging_or_charging_area';
      confidence = inChargerZone === true && batteryChargeState > 0 ? 'high' : 'medium';
      reasons.push(`in_charger_zone=${inChargerZone}`, `battery_charge_state=${batteryChargeState}`);
    } else if (taskEvidence) {
      if (longTimeStop === true || vehicleIdleStatus === 1) {
        state = 'patrol_long_stop_or_completed';
        confidence = 'medium';
      } else if (moving) {
        state = 'patrol_active_moving';
        confidence = plannerActive ? 'high' : 'medium';
      } else {
        state = 'patrol_active_stopped';
        confidence = plannerActive ? 'high' : 'medium';
      }
      if (plannerActive) reasons.push(`planner_running=${plannerRunning}`);
      if (routeProgress) reasons.push(`loop=${currentLoop}/${totalLoop}`, `refline=${currentRefline}/${totalRefline}`);
      if (trajectoryLength != null) reasons.push(`trajectory_len=${trajectoryLength}`);
    } else if (longTimeStop === true || vehicleIdleStatus === 1) {
      state = 'stopped_idle_or_long_stop';
      confidence = toolResults.planning && toolResults.planning.ok ? 'medium' : 'low';
      reasons.push(`long_time_stop=${longTimeStop}`, `vehicle_idle_status=${vehicleIdleStatus}`);
    } else if (moving) {
      state = 'moving_not_confirmed_patrol';
      confidence = 'low';
      reasons.push(`speed_kph=${speedKph}`);
    } else if ((toolResults.planning && toolResults.planning.ok) || (toolResults.can && toolResults.can.ok)) {
      state = 'stopped_unknown';
      confidence = 'medium';
      reasons.push('no_patrol_evidence');
    }

    return {
      state,
      confidence,
      capture_eligible_default:
        state === 'patrol_active_moving' || state === 'patrol_active_stopped',
      reasons: reasons.slice(0, 8),
      fields: {
        speed_kph: speedKph,
        running_mode_telemetry: numberValue(telemetryVehicle.running_mode),
        running_mode_can: numberValue(canSummary.running_mode),
        remote_mode_enable: numberValue(canSummary.remote_mode_enable),
        battery_soc: numberValue(canSummary.battery_soc != null ? canSummary.battery_soc : telemetryVehicle.battery_soc),
        battery_charge_state: batteryChargeState,
        current_scenario: currentScenario,
        current_action: currentAction,
        planner_running: plannerRunning,
        vehicle_idle_status: vehicleIdleStatus,
        long_time_stop: longTimeStop,
        in_charger_zone: inChargerZone,
        current_loop_index: currentLoop,
        total_loop_sum: totalLoop,
        current_refline_index: currentRefline,
        total_refline_sum: totalRefline,
        trajectory_total_length: trajectoryLength,
        trajectory_point_count: trajectoryPointCount,
        route_count: numberValue(routingSummary.route_count),
        route_location: routingSummary.current_route_location || null,
        current_path_string_ids: routePathIds
      }
    };
  }

  function normalizeVehicleIds(value) {
    if (Array.isArray(value)) {
      return value.map((item) => String(item || '').trim()).filter(Boolean);
    }
    if (typeof value === 'string' && value.trim()) {
      return value.split(',').map((item) => item.trim()).filter(Boolean);
    }
    return [];
  }

  async function buildMissionSnapshot(params) {
    params = params || {};
    if (missionSnapshotInFlight) {
      const error = new Error('mission_snapshot_in_flight');
      error.status = 409;
      throw error;
    }
    missionSnapshotInFlight = true;
    const startedAt = Date.now();
    try {
      const requestedVehicleIds = new Set(normalizeVehicleIds(params.vehicle_ids));
      const maxVehicles = toFiniteInteger(params.max_vehicles, 200, { min: 1, max: 500 });
      const vehiclesRaw = await listVehicles();
      const nowMs = Date.now();
      const vehicles = vehiclesRaw
        .filter((vehicle) => vehicle && vehicle.vehicle_id)
        .filter((vehicle) => {
          if (requestedVehicleIds.size && !requestedVehicleIds.has(String(vehicle.vehicle_id))) {
            return false;
          }
          const lastSeenMs = Date.parse(vehicle.last_seen || '');
          return !Number.isFinite(lastSeenMs) || nowMs - lastSeenMs <= freshVehicleMs;
        })
        .slice(0, maxVehicles)
        .sort((left, right) => String(left.vehicle_id).localeCompare(String(right.vehicle_id), 'zh-CN'));

      const rows = await mapWithConcurrency(vehicles, statusConcurrency, async (vehicle) => {
        const vehicleId = String(vehicle.vehicle_id);
        const planning = await callVehicleTool(vehicleId, 'status.planning', {}, statusToolTimeoutS);
        const can = await callVehicleTool(vehicleId, 'status.can', {}, statusToolTimeoutS);
        const routing = await callVehicleTool(vehicleId, 'status.routing', {}, statusToolTimeoutS);
        const mission = classifyMission(vehicle, { planning, can, routing });
        return {
          vehicle_id: vehicleId,
          last_seen: vehicle.last_seen || null,
          tool_count: vehicle.tool_count == null ? null : vehicle.tool_count,
          mission,
          tool_elapsed_ms: {
            planning: planning.elapsed_ms,
            can: can.elapsed_ms,
            routing: routing.elapsed_ms
          },
          tool_errors: {
            planning: planning.ok ? null : planning.error,
            can: can.ok ? null : can.error,
            routing: routing.ok ? null : routing.error
          }
        };
      });

      const counts = rows.reduce((acc, row) => {
        const key = row.mission && row.mission.state ? row.mission.state : 'unknown';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});

      const snapshot = {
        ok: true,
        generated_at: nowIso(),
        elapsed_ms: Date.now() - startedAt,
        vehicle_count: rows.length,
        counts,
        rows
      };
      cachedMissionSnapshot = snapshot;
      await ensureRuntimeDirs();
      await fsp.writeFile(missionSnapshotPath, JSON.stringify(snapshot, null, 2), 'utf8');
      return snapshot;
    } finally {
      missionSnapshotInFlight = false;
    }
  }

  async function walkFiles(rootPath) {
    const out = [];
    if (!(await pathExists(rootPath))) {
      return out;
    }
    async function walk(currentPath) {
      const entries = await fsp.readdir(currentPath, { withFileTypes: true });
      for (const entry of entries) {
        const absPath = path.join(currentPath, entry.name);
        if (entry.isDirectory()) {
          await walk(absPath);
        } else if (entry.isFile()) {
          const stat = await fsp.stat(absPath);
          out.push({
            path: absPath,
            rel_path: path.relative(framesRoot, absPath).split(path.sep).join('/'),
            size: stat.size,
            mtime_ms: stat.mtimeMs
          });
        }
      }
    }
    await walk(rootPath);
    return out;
  }

  async function getDiskFreeBytes() {
    try {
      if (typeof fsp.statfs !== 'function') {
        return null;
      }
      await ensureRuntimeDirs();
      const stat = await fsp.statfs(runtimeRoot);
      return Number(stat.bavail) * Number(stat.bsize);
    } catch (_error) {
      return null;
    }
  }

  function sidecarPathForImage(imagePath) {
    return imagePath.replace(/\.(jpe?g|png|webp)$/i, '.json');
  }

  async function removeFileIfExists(targetPath) {
    try {
      await fsp.rm(targetPath, { force: true });
    } catch (_error) {
      // Ignore missing files.
    }
  }

  async function cleanupStorage() {
    await ensureRuntimeDirs();
    const startedAt = Date.now();
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    let files = await walkFiles(framesRoot);
    let deletedExpired = 0;

    for (const file of files) {
      if (file.mtime_ms < cutoffMs) {
        await removeFileIfExists(file.path);
        deletedExpired += 1;
      }
    }

    files = await walkFiles(framesRoot);
    let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    let deletedForQuota = 0;

    if (totalBytes > maxStorageBytes) {
      const targetBytes = Math.floor(maxStorageBytes * 0.9);
      const ordered = files.slice().sort((left, right) => left.mtime_ms - right.mtime_ms);
      for (const file of ordered) {
        if (totalBytes <= targetBytes) {
          break;
        }
        const before = totalBytes;
        if (/\.(jpe?g|png|webp)$/i.test(file.path)) {
          await removeFileIfExists(file.path);
          await removeFileIfExists(sidecarPathForImage(file.path));
        } else if (/\.json$/i.test(file.path)) {
          await removeFileIfExists(file.path);
        } else {
          await removeFileIfExists(file.path);
        }
        deletedForQuota += 1;
        files = await walkFiles(framesRoot);
        totalBytes = files.reduce((sum, item) => sum + item.size, 0);
        if (totalBytes === before) {
          break;
        }
      }
    }

    const latestFiles = await walkFiles(framesRoot);
    const latestTotalBytes = latestFiles.reduce((sum, file) => sum + file.size, 0);
    const frameCount = latestFiles.filter((file) => /\.json$/i.test(file.path)).length;
    const diskFreeBytes = await getDiskFreeBytes();
    return {
      runtime_root: runtimeRoot,
      frames_root: framesRoot,
      total_bytes: latestTotalBytes,
      max_storage_bytes: maxStorageBytes,
      file_count: latestFiles.length,
      frame_count: frameCount,
      retention_days: retentionDays,
      deleted_expired: deletedExpired,
      deleted_for_quota: deletedForQuota,
      disk_free_bytes: diskFreeBytes,
      min_free_bytes: minFreeBytes,
      can_accept_capture:
        latestTotalBytes < maxStorageBytes &&
        (diskFreeBytes == null || diskFreeBytes >= minFreeBytes),
      elapsed_ms: Date.now() - startedAt
    };
  }

  function collectImagesFromValue(value, out, seen) {
    if (!value || out.length >= 32) {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => collectImagesFromValue(item, out, seen));
      return;
    }
    if (typeof value !== 'object') {
      return;
    }

    const base64Value =
      typeof value.image_base64 === 'string'
        ? value.image_base64
        : typeof value.data_base64 === 'string'
          ? value.data_base64
          : typeof value.base64 === 'string'
            ? value.base64
            : typeof value.image === 'string'
              ? value.image
              : '';
    if (base64Value && base64Value.length > 1000) {
      const stripped = stripDataUri(base64Value, value.mime_type || value.image_mime_type || 'image/jpeg');
      const key = crypto.createHash('sha1').update(stripped.base64.slice(0, 2048)).digest('hex');
      if (!seen.has(key)) {
        seen.add(key);
        out.push({
          camera_id: value.camera || value.camera_id || value.name || value.topic || 'camera',
          mime_type: stripped.mime_type,
          base64: stripped.base64,
          header: value.header || value.image_header || null,
          width: value.width || value.image_width || null,
          height: value.height || value.image_height || null
        });
      }
    }

    Object.keys(value).forEach((key) => {
      if (['image_base64', 'data_base64', 'base64', 'image'].includes(key)) {
        return;
      }
      collectImagesFromValue(value[key], out, seen);
    });
  }

  function collectImages(result) {
    const images = [];
    collectImagesFromValue(result, images, new Set());
    return images;
  }

  function frameUrl(relativePath) {
    return `/api/crowd-cpm/files/${relativePath
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/')}`;
  }

  function imageTimestampFromHeader(header) {
    if (!header || typeof header !== 'object') {
      return null;
    }
    const stamp = header.stamp || {};
    const secs = Number(stamp.secs);
    const nsecs = Number(stamp.nsecs || 0);
    if (Number.isFinite(secs)) {
      return secs * 1000 + Math.floor(nsecs / 1000000);
    }
    return null;
  }

  async function saveCapturedImage(image, context) {
    const collectedAt = new Date();
    const day = dateStampCompact(collectedAt);
    const dir = path.join(framesRoot, day);
    await fsp.mkdir(dir, { recursive: true });
    const vehicleId = sanitizeName(context.vehicle_id, 'vehicle');
    const cameraId = sanitizeName(image.camera_id || 'camera', 'camera');
    const captureId = `${timeStampCompact(collectedAt)}_${vehicleId}_${cameraId}_${crypto.randomBytes(4).toString('hex')}`;
    const imageBuffer = Buffer.from(image.base64, 'base64');
    const ext = mimeToExt(image.mime_type);
    const imageAbsPath = path.join(dir, `${captureId}${ext}`);
    const metaAbsPath = path.join(dir, `${captureId}.json`);
    const imageRelPath = path.relative(framesRoot, imageAbsPath).split(path.sep).join('/');

    const meta = {
      capture_id: captureId,
      collected_at: collectedAt.toISOString(),
      collected_at_ms: collectedAt.getTime(),
      vehicle_id: context.vehicle_id,
      camera_id: image.camera_id || 'camera',
      image_mime_type: image.mime_type,
      image_size_bytes: imageBuffer.length,
      image_sha256: crypto.createHash('sha256').update(imageBuffer).digest('hex'),
      image_header: image.header || null,
      image_ts_ms: imageTimestampFromHeader(image.header),
      image_width: image.width,
      image_height: image.height,
      image_path: imageRelPath,
      image_url: frameUrl(imageRelPath),
      mission: context.mission,
      collection_policy: context.policy,
      business: {
        kind: 'ad_cpm_footfall',
        detector_status: 'pending',
        note: 'raw frame collected for server-side crowd/CPM analysis'
      }
    };

    await fsp.writeFile(imageAbsPath, imageBuffer);
    await fsp.writeFile(metaAbsPath, JSON.stringify(meta, null, 2), 'utf8');
    await appendIndexLog(meta);
    return meta;
  }

  function normalizeCameraIds(value) {
    const fromValue = normalizeVehicleIds(value);
    return (fromValue.length ? fromValue : defaultCameraIds).slice(0, 4);
  }

  function captureArgsFromPolicy(policy) {
    const cameraIds = normalizeCameraIds(policy.camera_ids);
    const quality = toFiniteInteger(policy.quality, defaultCaptureQuality, { min: 20, max: 90 });
    const maxWidth = toFiniteInteger(policy.max_width, defaultCaptureMaxWidth, { min: 160, max: 1280 });
    return {
      camera_ids: cameraIds,
      camera: cameraIds.length === 1 ? cameraIds[0] : 'all',
      quality,
      max_width: maxWidth,
      include_base64: true
    };
  }

  function isEligibleForCapture(row, params, collectorState) {
    const mission = row && row.mission ? row.mission : {};
    const fields = mission.fields || {};
    const includeLongStop = params.include_long_stop === true;
    const allowLowConfidence = params.allow_low_confidence === true;
    const cooldownMs = toFiniteInteger(params.cooldown_ms, captureCooldownMs, {
      min: 60 * 1000,
      max: 24 * 60 * 60 * 1000
    });
    const lastCapture = collectorState.last_capture_by_vehicle[row.vehicle_id] || null;
    const lastCaptureMs = lastCapture ? Number(lastCapture.collected_at_ms || 0) : 0;
    const ageMs = lastCaptureMs > 0 ? Date.now() - lastCaptureMs : null;
    const reasons = [];

    if (!mission.capture_eligible_default) {
      reasons.push(`mission_state=${mission.state || 'unknown'}`);
    }
    if (mission.confidence === 'low' && !allowLowConfidence) {
      reasons.push('low_confidence');
    }
    if (fields.long_time_stop === true && !includeLongStop) {
      reasons.push('long_time_stop');
    }
    if (fields.in_charger_zone === true || (fields.battery_charge_state != null && fields.battery_charge_state > 0)) {
      reasons.push('charging_or_charging_area');
    }
    if (ageMs != null && ageMs < cooldownMs) {
      reasons.push(`cooldown_${Math.ceil((cooldownMs - ageMs) / 1000)}s`);
    }

    return {
      eligible: reasons.length === 0,
      skip_reasons: reasons,
      last_capture: lastCapture,
      cooldown_ms: cooldownMs
    };
  }

  async function captureForVehicle(row, params, remainingBudget) {
    const args = captureArgsFromPolicy(params);
    const result = await callVehicleTool(row.vehicle_id, 'camera.capture', args, captureTimeoutS);
    if (!result.ok) {
      return {
        ok: false,
        vehicle_id: row.vehicle_id,
        error: result.error || 'camera_capture_failed',
        elapsed_ms: result.elapsed_ms
      };
    }
    const images = collectImages(result.result).slice(0, remainingBudget);
    const saved = [];
    for (const image of images) {
      saved.push(
        await saveCapturedImage(image, {
          vehicle_id: row.vehicle_id,
          mission: row.mission,
          policy: {
            camera_ids: args.camera_ids,
            quality: args.quality,
            max_width: args.max_width,
            include_long_stop: params.include_long_stop === true,
            allow_low_confidence: params.allow_low_confidence === true
          }
        })
      );
    }
    return {
      ok: true,
      vehicle_id: row.vehicle_id,
      elapsed_ms: result.elapsed_ms,
      requested_camera_ids: args.camera_ids,
      saved_count: saved.length,
      frames: saved
    };
  }

  async function collectFrames(params) {
    params = params || {};
    if (collectionInFlight) {
      const error = new Error('collection_in_flight');
      error.status = 409;
      throw error;
    }
    collectionInFlight = true;
    const startedAt = Date.now();
    try {
      const dryRun = params.dry_run !== false;
      const maxImages = toFiniteInteger(params.max_images, maxImagesPerRunDefault, { min: 1, max: 20 });
      const collectorState = await readCollectorState();
      const storageBefore = await cleanupStorage();
      const snapshot = await buildMissionSnapshot({
        vehicle_ids: params.vehicle_ids,
        max_vehicles: params.max_vehicles
      });
      const candidates = snapshot.rows.map((row) => {
        const decision = isEligibleForCapture(row, params, collectorState);
        return {
          vehicle_id: row.vehicle_id,
          mission: row.mission,
          eligible: decision.eligible,
          skip_reasons: decision.skip_reasons,
          last_capture: decision.last_capture,
          cooldown_ms: decision.cooldown_ms
        };
      });
      const eligibleRows = snapshot.rows.filter((row) => {
        return candidates.find((candidate) => candidate.vehicle_id === row.vehicle_id && candidate.eligible);
      });

      if (dryRun) {
        return {
          ok: true,
          dry_run: true,
          generated_at: nowIso(),
          elapsed_ms: Date.now() - startedAt,
          storage: storageBefore,
          max_images: maxImages,
          candidate_count: candidates.length,
          eligible_count: eligibleRows.length,
          candidates
        };
      }

      if (!storageBefore.can_accept_capture) {
        return {
          ok: false,
          dry_run: false,
          error: 'storage_limit_reached',
          detail: 'crowd-cpm storage quota or disk free threshold blocks capture',
          storage: storageBefore,
          candidates
        };
      }

      let remainingBudget = maxImages;
      const selectedRows = eligibleRows.slice(0, maxImages);
      const captures = await mapWithConcurrency(selectedRows, captureConcurrency, async (row) => {
        if (remainingBudget <= 0) {
          return {
            ok: false,
            vehicle_id: row.vehicle_id,
            skipped: true,
            error: 'run_budget_exhausted'
          };
        }
        const budgetForThisVehicle = Math.max(1, remainingBudget);
        const capture = await captureForVehicle(row, params, budgetForThisVehicle);
        remainingBudget -= Math.max(0, capture.saved_count || 0);
        if (capture.ok && capture.frames && capture.frames.length) {
          const latest = capture.frames[capture.frames.length - 1];
          collectorState.last_capture_by_vehicle[row.vehicle_id] = {
            collected_at: latest.collected_at,
            collected_at_ms: latest.collected_at_ms,
            capture_id: latest.capture_id,
            image_path: latest.image_path
          };
        }
        return capture;
      });
      await writeCollectorState(collectorState);
      const storageAfter = await cleanupStorage();
      const savedFrames = captures.reduce((acc, capture) => {
        if (capture.frames) {
          return acc.concat(capture.frames);
        }
        return acc;
      }, []);
      return {
        ok: true,
        dry_run: false,
        generated_at: nowIso(),
        elapsed_ms: Date.now() - startedAt,
        storage_before: storageBefore,
        storage_after: storageAfter,
        max_images: maxImages,
        candidate_count: candidates.length,
        eligible_count: eligibleRows.length,
        saved_count: savedFrames.length,
        captures,
        frames: savedFrames,
        skipped_candidates: candidates.filter((candidate) => !candidate.eligible)
      };
    } finally {
      collectionInFlight = false;
    }
  }

  async function listFrameMetadata(filters) {
    filters = filters || {};
    await ensureRuntimeDirs();
    const page = toFiniteInteger(filters.page, 1, { min: 1, max: 9999 });
    const pageSize = toFiniteInteger(filters.page_size, 20, { min: 1, max: 100 });
    const vehicleId = String(filters.vehicle_id || '').trim();
    const files = await walkFiles(framesRoot);
    const jsonFiles = files
      .filter((file) => /\.json$/i.test(file.path))
      .sort((left, right) => right.mtime_ms - left.mtime_ms);
    const items = [];
    for (const file of jsonFiles) {
      try {
        const meta = JSON.parse(await fsp.readFile(file.path, 'utf8'));
        if (vehicleId && meta.vehicle_id !== vehicleId) {
          continue;
        }
        items.push(meta);
      } catch (_error) {
        // Ignore malformed sidecar files.
      }
    }
    const offset = (page - 1) * pageSize;
    return {
      page,
      page_size: pageSize,
      total: items.length,
      total_pages: items.length ? Math.ceil(items.length / pageSize) : 1,
      items: items.slice(offset, offset + pageSize)
    };
  }

  function publicConfig() {
    return {
      runtime_root: runtimeRoot,
      frames_root: framesRoot,
      cloud_agent_base_url: cloudAgentBaseUrl,
      status_tool_timeout_s: statusToolTimeoutS,
      capture_timeout_s: captureTimeoutS,
      status_concurrency: statusConcurrency,
      capture_concurrency: captureConcurrency,
      max_images_per_run_default: maxImagesPerRunDefault,
      capture_cooldown_ms: captureCooldownMs,
      retention_days: retentionDays,
      max_storage_bytes: maxStorageBytes,
      min_free_bytes: minFreeBytes,
      fresh_vehicle_ms: freshVehicleMs,
      default_camera_ids: defaultCameraIds,
      default_capture_quality: defaultCaptureQuality,
      default_capture_max_width: defaultCaptureMaxWidth
    };
  }

  app.use(
    '/api/crowd-cpm/files',
    requirePermission('vehicle:read'),
    express.static(framesRoot, {
      fallthrough: false,
      index: false,
      maxAge: '5m'
    })
  );

  app.get('/api/crowd-cpm/status', requirePermission('vehicle:read'), async (_req, res) => {
    try {
      const storage = await cleanupStorage();
      let lastSnapshot = cachedMissionSnapshot;
      if (!lastSnapshot) {
        lastSnapshot = safeJsonParse(await fsp.readFile(missionSnapshotPath, 'utf8').catch(() => ''), null);
      }
      return res.json({
        ok: true,
        busy: {
          collection_in_flight: collectionInFlight,
          mission_snapshot_in_flight: missionSnapshotInFlight
        },
        config: publicConfig(),
        storage,
        last_mission_snapshot: lastSnapshot
          ? {
              generated_at: lastSnapshot.generated_at,
              elapsed_ms: lastSnapshot.elapsed_ms,
              vehicle_count: lastSnapshot.vehicle_count,
              counts: lastSnapshot.counts
            }
          : null
      });
    } catch (error) {
      return res.status(error.status || 500).json({
        ok: false,
        error: error.message || 'crowd_cpm_status_failed'
      });
    }
  });

  app.post('/api/crowd-cpm/mission-snapshot', requirePermission('vehicle:read'), async (req, res) => {
    try {
      const snapshot = await buildMissionSnapshot(req.body || {});
      return res.json(snapshot);
    } catch (error) {
      return res.status(error.status || 500).json({
        ok: false,
        error: error.message || 'crowd_cpm_mission_snapshot_failed'
      });
    }
  });

  app.post('/api/crowd-cpm/collect', requirePermission('vehicle:control'), async (req, res) => {
    try {
      const result = await collectFrames(req.body || {});
      return res.status(result.ok ? 200 : 507).json(result);
    } catch (error) {
      return res.status(error.status || 500).json({
        ok: false,
        error: error.message || 'crowd_cpm_collect_failed'
      });
    }
  });

  app.post('/api/crowd-cpm/cleanup', requirePermission('vehicle:control'), async (_req, res) => {
    try {
      const storage = await cleanupStorage();
      return res.json({
        ok: true,
        storage
      });
    } catch (error) {
      return res.status(error.status || 500).json({
        ok: false,
        error: error.message || 'crowd_cpm_cleanup_failed'
      });
    }
  });

  app.get('/api/crowd-cpm/frames', requirePermission('vehicle:read'), async (req, res) => {
    try {
      const result = await listFrameMetadata({
        page: req.query.page,
        page_size: req.query.page_size,
        vehicle_id: req.query.vehicle_id
      });
      return res.json({
        ok: true,
        ...result
      });
    } catch (error) {
      return res.status(error.status || 500).json({
        ok: false,
        error: error.message || 'crowd_cpm_frames_failed'
      });
    }
  });
};
