const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_STATUS_TOOL_TIMEOUT_S = 8;
const DEFAULT_HTTP_EXTRA_TIMEOUT_MS = 5000;
const DEFAULT_STATUS_CONCURRENCY = 2;
const DEFAULT_FRESH_VEHICLE_MS = 5 * 60 * 1000;
const DEFAULT_REPORT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_REPORT_BOOT_DELAY_MS = 60 * 1000;
const DEFAULT_REPORT_MAX_VEHICLES = 200;
const DEFAULT_CROWD_CAPTURE_TIMEOUT_S = 45;
const DEFAULT_CROWD_CAPTURE_DISTANCE_M = 60;
const DEFAULT_CROWD_CAPTURE_COOLDOWN_MS = 90 * 1000;

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

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    return fallback;
  }
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

function normalizeVehicleIds(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function firstNumberFromKeys(source, keys) {
  if (!source || typeof source !== 'object') {
    return null;
  }
  for (const key of keys) {
    const value = numberValue(source[key]);
    if (value != null) {
      return value;
    }
  }
  return null;
}

function firstStringFromKeys(source, keys) {
  if (!source || typeof source !== 'object') {
    return '';
  }
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function collectNumbersByName(value, names, out = []) {
  if (!value || typeof value !== 'object') {
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectNumbersByName(item, names, out));
    return out;
  }
  Object.entries(value).forEach(([key, item]) => {
    if (names.has(String(key).toLowerCase())) {
      const num = numberValue(item);
      if (num != null) {
        out.push(num);
      }
    }
    if (item && typeof item === 'object') {
      collectNumbersByName(item, names, out);
    }
  });
  return out;
}

function compactToolResult(result) {
  if (!result || typeof result !== 'object') {
    return null;
  }
  const summary = result.summary && typeof result.summary === 'object' ? result.summary : result;
  return {
    health: result.health || summary.health || null,
    status: result.status || summary.status || null,
    summary
  };
}

function planningSample(planningResult) {
  return getNested(planningResult, ['topics', 'current_planning_status', 'sample']) || {};
}

function prioritySeverity(left, right) {
  const order = { ok: 0, info: 1, warn: 2, error: 3, stale: 4 };
  return (order[right] || 0) > (order[left] || 0) ? right : left;
}

function classifyMission(vehicle, toolResults) {
  const planning = toolResults.planning?.result || null;
  const routing = toolResults.routing?.result || null;
  const can = toolResults.can?.result || null;
  const planningSummary = compactToolResult(planning)?.summary || {};
  const routingSummary = compactToolResult(routing)?.summary || {};
  const canSummary = compactToolResult(can)?.summary || {};
  const sample = planningSample(planning);
  const telemetryVehicle = vehicle?.telemetry?.vehicle || {};

  const speedKph = numberValue(
    canSummary.speed_kph ??
      canSummary.speed ??
      canSummary.vehicle_speed ??
      telemetryVehicle.speed_kph ??
      telemetryVehicle.speed
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
  const longTimeStop = booleanValue(sample.long_time_stop ?? planningSummary.long_time_stop);
  const inChargerZone = booleanValue(sample.in_charger_zone ?? planningSummary.in_charger_zone);
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
  const plannerActive = plannerRunning != null && plannerRunning > 0;
  const hasTrajectory =
    trajectoryPointCount != null &&
    trajectoryPointCount > 0 &&
    trajectoryLength != null &&
    trajectoryLength > 0;
  const taskEvidence =
    plannerActive ||
    routePathIds.length > 0 ||
    (routeProgress && (totalLoop > 1 || totalRefline > 2 || hasTrajectory));

  const reasons = [];
  let state = 'unknown';
  let confidence = 'low';

  if (!toolResults.planning?.ok) reasons.push('planning_unavailable');
  if (!toolResults.can?.ok) reasons.push('can_unavailable');
  if (!toolResults.routing?.ok) reasons.push('routing_unavailable');

  if (inChargerZone === true || (batteryChargeState != null && batteryChargeState > 0)) {
    state = 'charging_or_charging_area';
    confidence = inChargerZone === true && batteryChargeState > 0 ? 'high' : 'medium';
    reasons.push(`charging=${batteryChargeState ?? '-'}`);
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
  } else if (longTimeStop === true || vehicleIdleStatus === 1) {
    state = 'stopped_idle_or_long_stop';
    confidence = toolResults.planning?.ok ? 'medium' : 'low';
    reasons.push(`long_time_stop=${longTimeStop}`, `vehicle_idle_status=${vehicleIdleStatus}`);
  } else if (moving) {
    state = 'moving_not_confirmed_patrol';
    confidence = 'low';
    reasons.push(`speed_kph=${speedKph}`);
  } else if (toolResults.planning?.ok || toolResults.can?.ok) {
    state = 'stopped_unknown';
    confidence = 'medium';
    reasons.push('no_patrol_evidence');
  }

  return {
    state,
    confidence,
    reasons: reasons.slice(0, 8),
    fields: {
      speed_kph: speedKph,
      running_mode: numberValue(canSummary.running_mode ?? telemetryVehicle.running_mode),
      remote_mode_enable: numberValue(canSummary.remote_mode_enable),
      battery_soc: numberValue(canSummary.battery_soc ?? telemetryVehicle.battery_soc),
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
      trajectory_point_count: trajectoryPointCount
    }
  };
}

function extractTrafficSignals(toolResults) {
  const obstacle = toolResults.obstacle?.result || null;
  const perception = toolResults.perception?.result || null;
  const obstacleSummary = compactToolResult(obstacle)?.summary || {};
  const perceptionSummary = compactToolResult(perception)?.summary || {};
  const sources = [obstacleSummary, obstacle, perceptionSummary, perception].filter(Boolean);

  const countNames = new Set([
    'object_count',
    'objects_count',
    'obstacle_count',
    'obstacles_count',
    'fusion_object_count',
    'tracked_object_count',
    'people_count',
    'person_count',
    'pedestrian_count',
    'vehicle_count',
    'dynamic_obstacle_count',
    'static_obstacle_count'
  ]);
  const distanceNames = new Set([
    'nearest_distance_m',
    'nearest_obstacle_distance_m',
    'closest_obstacle_distance_m',
    'min_distance_m',
    'min_obstacle_distance_m'
  ]);

  const counts = sources.flatMap((item) => collectNumbersByName(item, countNames, []));
  const distances = sources.flatMap((item) => collectNumbersByName(item, distanceNames, []));
  const objectCount = counts.length ? Math.max(...counts.filter((num) => num >= 0)) : null;
  const nearestDistanceM = distances.length
    ? Math.min(...distances.filter((num) => num >= 0))
    : null;

  const crowdCount = Math.max(
    firstNumberFromKeys(obstacleSummary, ['people_count', 'person_count', 'pedestrian_count']) || 0,
    firstNumberFromKeys(perceptionSummary, ['people_count', 'person_count', 'pedestrian_count']) || 0
  );
  const health =
    firstStringFromKeys(obstacleSummary, ['health', 'status']) ||
    firstStringFromKeys(obstacle || {}, ['health', 'status']) ||
    firstStringFromKeys(perceptionSummary, ['health', 'status']) ||
    firstStringFromKeys(perception || {}, ['health', 'status']);

  return {
    object_count: objectCount,
    crowd_count: crowdCount || null,
    nearest_distance_m: nearestDistanceM,
    processor_health: health || null,
    source_health: {
      obstacle_processor: toolResults.obstacle?.ok ? health || 'ok' : toolResults.obstacle?.error || 'unavailable',
      perception: toolResults.perception
        ? toolResults.perception.ok
          ? 'ok'
          : toolResults.perception.error || 'unavailable'
        : 'not_requested'
    }
  };
}

function classifyTraffic(signals, mission) {
  const riskFactors = [];
  let score = 0;

  if (signals.object_count != null) {
    if (signals.object_count >= 120) {
      score += 70;
      riskFactors.push(`object_count=${signals.object_count}`);
    } else if (signals.object_count >= 80) {
      score += 55;
      riskFactors.push(`object_count=${signals.object_count}`);
    } else if (signals.object_count >= 30) {
      score += 35;
      riskFactors.push(`object_count=${signals.object_count}`);
    } else if (signals.object_count >= 10) {
      score += 15;
    }
  }

  if (signals.crowd_count != null && signals.crowd_count >= 15) {
    score += signals.crowd_count >= 50 ? 35 : 20;
    riskFactors.push(`crowd_count=${signals.crowd_count}`);
  }

  if (signals.nearest_distance_m != null) {
    if (signals.nearest_distance_m <= 1.2) {
      score += 45;
      riskFactors.push(`nearest=${signals.nearest_distance_m}m`);
    } else if (signals.nearest_distance_m <= 2.5) {
      score += 25;
      riskFactors.push(`nearest=${signals.nearest_distance_m}m`);
    } else if (signals.nearest_distance_m <= 5) {
      score += 10;
    }
  }

  if (
    mission.state === 'patrol_active_stopped' ||
    mission.state === 'patrol_long_stop_or_completed'
  ) {
    score += 12;
    riskFactors.push(`mission=${mission.state}`);
  }

  if (signals.processor_health && !['ok', 'healthy', 'normal'].includes(String(signals.processor_health).toLowerCase())) {
    score += 12;
    riskFactors.push(`processor=${signals.processor_health}`);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  let level = 'unknown';
  if (signals.object_count != null || signals.nearest_distance_m != null || signals.crowd_count != null) {
    if (score >= 80) {
      level = 'blocked';
    } else if (score >= 55) {
      level = 'crowded';
    } else if (score >= 30) {
      level = 'watch';
    } else {
      level = 'clear';
    }
  }

  return {
    ...signals,
    pcm_score: score,
    level,
    risk_factors: riskFactors.slice(0, 8)
  };
}

function classifyHealth({ vehicle, isFresh, lastSeenAgeS, toolResults, mission, traffic }) {
  let severity = isFresh ? 'ok' : 'stale';
  const issues = [];
  const canSummary = compactToolResult(toolResults.can?.result)?.summary || {};

  if (!isFresh) {
    issues.push(lastSeenAgeS == null ? 'no_recent_heartbeat' : `heartbeat_stale_${Math.round(lastSeenAgeS)}s`);
  }
  if (!toolResults.planning?.ok) {
    severity = prioritySeverity(severity, 'warn');
    issues.push(`planning:${toolResults.planning?.error || 'unavailable'}`);
  }
  if (!toolResults.can?.ok) {
    severity = prioritySeverity(severity, 'warn');
    issues.push(`can:${toolResults.can?.error || 'unavailable'}`);
  }
  if (!toolResults.routing?.ok) {
    severity = prioritySeverity(severity, 'warn');
    issues.push(`routing:${toolResults.routing?.error || 'unavailable'}`);
  }
  if (toolResults.obstacle && !toolResults.obstacle.ok) {
    severity = prioritySeverity(severity, 'warn');
    issues.push(`obstacle:${toolResults.obstacle.error || 'unavailable'}`);
  }

  const emergencyStop = booleanValue(
    canSummary.emergency_stop ??
      canSummary.emergency_stop_status ??
      canSummary.e_stop ??
      vehicle?.telemetry?.vehicle?.emergency_stop
  );
  const collisionStop = booleanValue(
    canSummary.collision_stop ??
      canSummary.collision_stop_status ??
      canSummary.collision_status ??
      vehicle?.telemetry?.vehicle?.collision_stop
  );
  const ultrasonicStop = booleanValue(canSummary.ultrasonic_stop ?? canSummary.ultrasonic_stop_status);
  const batterySoc = mission.fields.battery_soc;

  if (emergencyStop === true) {
    severity = prioritySeverity(severity, 'error');
    issues.push('emergency_stop');
  }
  if (collisionStop === true) {
    severity = prioritySeverity(severity, 'error');
    issues.push('collision_stop');
  }
  if (ultrasonicStop === true) {
    severity = prioritySeverity(severity, 'warn');
    issues.push('ultrasonic_stop');
  }
  if (batterySoc != null && batterySoc <= 10) {
    severity = prioritySeverity(severity, 'error');
    issues.push(`battery_low_${batterySoc}%`);
  } else if (batterySoc != null && batterySoc <= 20) {
    severity = prioritySeverity(severity, 'warn');
    issues.push(`battery_warn_${batterySoc}%`);
  }
  if (traffic.level === 'blocked') {
    severity = prioritySeverity(severity, 'error');
    issues.push('traffic_blocked');
  } else if (traffic.level === 'crowded') {
    severity = prioritySeverity(severity, 'warn');
    issues.push('traffic_crowded');
  }

  return {
    severity,
    issues: issues.slice(0, 10),
    emergency_stop: emergencyStop,
    collision_stop: collisionStop,
    ultrasonic_stop: ultrasonicStop
  };
}

function countBy(rows, selector) {
  return rows.reduce((acc, row) => {
    const key = selector(row) || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function alertMessage(row) {
  const issues = row.health.issues || [];
  if (row.health.severity === 'stale') {
    return `${row.vehicle_id} 心跳过期`;
  }
  if (issues.includes('traffic_blocked')) {
    return `${row.vehicle_id} 疑似通行受阻`;
  }
  if (issues.includes('traffic_crowded')) {
    return `${row.vehicle_id} 人流/障碍密度偏高`;
  }
  if (row.health.emergency_stop) {
    return `${row.vehicle_id} 急停状态`;
  }
  if (row.health.collision_stop) {
    return `${row.vehicle_id} 碰撞停状态`;
  }
  return `${row.vehicle_id} ${issues[0] || row.health.severity}`;
}

function buildAlerts(rows) {
  const order = { error: 0, stale: 1, warn: 2, info: 3, ok: 4 };
  const rank = (severity) => (
    Object.prototype.hasOwnProperty.call(order, severity) ? order[severity] : 9
  );
  return rows
    .filter((row) => row.health.severity !== 'ok')
    .sort((left, right) => {
      return rank(left.health.severity) - rank(right.health.severity);
    })
    .slice(0, 40)
    .map((row) => ({
      vehicle_id: row.vehicle_id,
      severity: row.health.severity,
      message: alertMessage(row),
      issues: row.health.issues,
      traffic_level: row.traffic.level,
      mission_state: row.mission.state
    }));
}

function formatLocalTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    return String(value || '');
  }
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

function formatReportText(snapshot) {
  const counts = snapshot.counts || {};
  const mission = counts.mission || {};
  const health = counts.health || {};
  const traffic = counts.traffic || {};
  const alerts = Array.isArray(snapshot.alerts) ? snapshot.alerts.slice(0, 8) : [];
  const activePatrol =
    (mission.patrol_active_moving || 0) + (mission.patrol_active_stopped || 0);
  const warningTotal = (health.warn || 0) + (health.error || 0) + (health.stale || 0);
  const lines = [
    `园区流量 PCM 小时报告 ${formatLocalTime(snapshot.generated_at)}`,
    `车辆：纳管 ${counts.total || 0}，新鲜在线 ${counts.fresh || 0}，过期/未知 ${counts.stale || 0}`,
    `任务：巡逻中 ${activePatrol}，充电/充电区 ${mission.charging_or_charging_area || 0}，停止/未知 ${
      (mission.stopped_unknown || 0) + (mission.stopped_idle_or_long_stop || 0)
    }`,
    `流量：通畅 ${traffic.clear || 0}，关注 ${traffic.watch || 0}，拥挤 ${traffic.crowded || 0}，阻塞 ${
      traffic.blocked || 0
    }，未知 ${traffic.unknown || 0}`,
    `健康：正常 ${health.ok || 0}，告警 ${health.warn || 0}，严重 ${health.error || 0}，心跳过期 ${
      health.stale || 0
    }`,
    `快照耗时：${snapshot.elapsed_ms || 0} ms`
  ];
  if (warningTotal > 0 && alerts.length) {
    lines.push('重点告警：');
    alerts.forEach((alert, index) => {
      lines.push(`${index + 1}. [${alert.severity}] ${alert.message} (${(alert.issues || []).slice(0, 3).join(', ')})`);
    });
  } else {
    lines.push('重点告警：暂无。');
  }
  return lines.join('\n');
}

function sanitizeName(value, fallback) {
  const text = String(value || '').trim();
  const safe = text.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[_ .-]+|[_ .-]+$/g, '');
  return safe || fallback;
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

function collectImagesFromValue(value, out, seen) {
  if (!value || out.length >= 16) {
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
    const key = crypto.createHash('sha1').update(stripped.base64.slice(0, 4096)).digest('hex');
    if (!seen.has(key)) {
      seen.add(key);
      out.push({
        camera_id: value.camera || value.camera_id || value.name || value.topic || `camera${out.length + 1}`,
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

function isInChina(lat, lng) {
  return lng >= 72.004 && lng <= 137.8347 && lat >= 0.8293 && lat <= 55.8271;
}

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
  return ret;
}

function wgs84ToGcj02(lat, lng) {
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !isInChina(latitude, longitude)) {
    return {
      latitude,
      longitude
    };
  }
  const a = 6378245.0;
  const ee = 0.00669342162296594323;
  let dLat = transformLat(longitude - 105.0, latitude - 35.0);
  let dLng = transformLng(longitude - 105.0, latitude - 35.0);
  const radLat = (latitude / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((a * (1 - ee)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180.0) / ((a / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return {
    latitude: latitude + dLat,
    longitude: longitude + dLng
  };
}

function haversineDistanceM(left, right) {
  if (
    !left ||
    !right ||
    !Number.isFinite(left.latitude) ||
    !Number.isFinite(left.longitude) ||
    !Number.isFinite(right.latitude) ||
    !Number.isFinite(right.longitude)
  ) {
    return null;
  }
  const radiusM = 6371008.8;
  const toRad = (num) => (num * Math.PI) / 180;
  const dLat = toRad(right.latitude - left.latitude);
  const dLng = toRad(right.longitude - left.longitude);
  const lat1 = toRad(left.latitude);
  const lat2 = toRad(right.latitude);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * radiusM * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

module.exports = function registerParkPcmRoutes(app, options) {
  options = options || {};
  const requirePermission = options.requirePermission;
  if (typeof requirePermission !== 'function') {
    throw new Error('registerParkPcmRoutes requires options.requirePermission');
  }

  const cloudAgentBaseUrl = String(
    options.cloudAgentBaseUrl || process.env.CLOUD_AGENT_BASE_URL || 'http://127.0.0.1:8000'
  ).replace(/\/+$/, '');
  const rootDir = path.resolve(options.rootDir || path.resolve(__dirname, '..'));
  const runtimeRoot = path.resolve(
    process.env.PARK_PCM_RUNTIME_ROOT || path.join(rootDir, '.runtime/park-pcm')
  );
  const snapshotPath = path.join(runtimeRoot, 'last-snapshot.json');
  const reportStatePath = path.join(runtimeRoot, 'report-state.json');
  const crowdFramesRoot = path.join(runtimeRoot, 'crowd-frames');
  const crowdIndexLogPath = path.join(runtimeRoot, 'crowd-samples.jsonl');
  const crowdStatePath = path.join(runtimeRoot, 'crowd-capture-state.json');
  const statusToolTimeoutS = toFiniteNumber(
    process.env.PARK_PCM_STATUS_TOOL_TIMEOUT_S,
    DEFAULT_STATUS_TOOL_TIMEOUT_S,
    { min: 3, max: 30 }
  );
  const statusConcurrency = toFiniteInteger(
    process.env.PARK_PCM_CONCURRENCY,
    DEFAULT_STATUS_CONCURRENCY,
    { min: 1, max: 6 }
  );
  const freshVehicleMs = toFiniteInteger(
    process.env.PARK_PCM_FRESH_VEHICLE_MS,
    DEFAULT_FRESH_VEHICLE_MS,
    { min: 30 * 1000, max: 60 * 60 * 1000 }
  );
  const reportIntervalMs = toFiniteInteger(
    process.env.PARK_PCM_REPORT_INTERVAL_MS,
    DEFAULT_REPORT_INTERVAL_MS,
    { min: 5 * 60 * 1000, max: 24 * 60 * 60 * 1000 }
  );
  const reportBootDelayMs = toFiniteInteger(
    process.env.PARK_PCM_REPORT_BOOT_DELAY_MS,
    DEFAULT_REPORT_BOOT_DELAY_MS,
    { min: 5 * 1000, max: 60 * 60 * 1000 }
  );
  const reportMaxVehicles = toFiniteInteger(
    process.env.PARK_PCM_REPORT_MAX_VEHICLES,
    DEFAULT_REPORT_MAX_VEHICLES,
    { min: 1, max: 500 }
  );
  const reportEnabled = String(process.env.PARK_PCM_REPORT_ENABLED || 'true').toLowerCase() !== 'false';
  const crowdCaptureTimeoutS = toFiniteInteger(
    process.env.PARK_PCM_CROWD_CAPTURE_TIMEOUT_S,
    DEFAULT_CROWD_CAPTURE_TIMEOUT_S,
    { min: 10, max: 120 }
  );
  const crowdCaptureDistanceM = toFiniteNumber(
    process.env.PARK_PCM_CROWD_CAPTURE_DISTANCE_M,
    DEFAULT_CROWD_CAPTURE_DISTANCE_M,
    { min: 5, max: 1000 }
  );
  const crowdCaptureCooldownMs = toFiniteInteger(
    process.env.PARK_PCM_CROWD_CAPTURE_COOLDOWN_MS,
    DEFAULT_CROWD_CAPTURE_COOLDOWN_MS,
    { min: 10 * 1000, max: 60 * 60 * 1000 }
  );
  const feishuWebhookUrl = String(
    process.env.PARK_PCM_FEISHU_WEBHOOK_URL ||
      process.env.FEISHU_WEBHOOK_URL ||
      process.env.LARK_WEBHOOK_URL ||
      process.env.FEISHU_ROBOT_WEBHOOK ||
      process.env.LARK_ROBOT_WEBHOOK ||
      ''
  ).trim();

  let snapshotInFlight = false;
  let reportInFlight = false;
  let crowdCaptureInFlight = false;
  let reportTimer = null;

  async function ensureRuntimeDir() {
    await fsp.mkdir(runtimeRoot, { recursive: true });
  }

  async function ensureCrowdRuntimeDirs() {
    await Promise.all([
      ensureRuntimeDir(),
      fsp.mkdir(crowdFramesRoot, { recursive: true })
    ]);
  }

  async function atomicWriteJson(targetPath, payload) {
    await ensureRuntimeDir();
    const tmpPath = `${targetPath}.${process.pid}.tmp`;
    await fsp.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
    await fsp.rename(tmpPath, targetPath);
  }

  async function readJsonFile(targetPath) {
    try {
      return JSON.parse(await fsp.readFile(targetPath, 'utf8'));
    } catch (_error) {
      return null;
    }
  }

  async function fetchCloudAgentJson(pathname, fetchOptions) {
    const url = new URL(pathname, `${cloudAgentBaseUrl}/`).toString();
    const body = fetchOptions && fetchOptions.body ? JSON.stringify(fetchOptions.body) : null;
    const timeoutMs = fetchOptions && fetchOptions.timeoutMs ? fetchOptions.timeoutMs : 15000;
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

  function crowdFrameUrl(relativePath) {
    return `/api/park-pcm/crowd/files/${relativePath
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/')}`;
  }

  async function readCrowdState() {
    await ensureCrowdRuntimeDirs();
    const parsed = await readJsonFile(crowdStatePath);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        version: 1,
        last_capture_by_vehicle: {},
        ...parsed,
        last_capture_by_vehicle:
          parsed.last_capture_by_vehicle && typeof parsed.last_capture_by_vehicle === 'object'
            ? parsed.last_capture_by_vehicle
            : {}
      };
    }
    return {
      version: 1,
      last_capture_by_vehicle: {},
      updated_at: nowIso()
    };
  }

  async function writeCrowdState(state) {
    const nextState = {
      version: 1,
      last_capture_by_vehicle: {},
      ...(state || {}),
      updated_at: nowIso()
    };
    await atomicWriteJson(crowdStatePath, nextState);
  }

  function extractLocalizationPosition(localizationResult) {
    const result = localizationResult?.result || {};
    const summary = result.summary || {};
    const lat = numberValue(
      summary.latitude ??
        summary.Lattitude ??
        summary.lat ??
        result.latitude ??
        result.Lattitude ??
        result.lat
    );
    const lng = numberValue(
      summary.longitude ??
        summary.Longitude ??
        summary.lng ??
        result.longitude ??
        result.Longitude ??
        result.lng
    );
    const gcj = wgs84ToGcj02(lat, lng);
    return {
      source: 'status.localization',
      reliable: booleanValue(summary.reliable ?? result.reliable),
      latitude: lat,
      longitude: lng,
      gaode_latitude: Number.isFinite(gcj.latitude) ? gcj.latitude : null,
      gaode_longitude: Number.isFinite(gcj.longitude) ? gcj.longitude : null,
      heading: numberValue(summary.heading ?? result.heading),
      speed_mps: numberValue(summary.speed_mps ?? result.speed_mps),
      raw_health: result.health || summary.health || null
    };
  }

  async function appendCrowdSampleLog(entry) {
    await ensureCrowdRuntimeDirs();
    await fsp.appendFile(crowdIndexLogPath, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  async function readRecentCrowdSamples(limit) {
    const normalizedLimit = toFiniteInteger(limit, 20, { min: 1, max: 100 });
    try {
      const text = await fsp.readFile(crowdIndexLogPath, 'utf8');
      return text
        .split('\n')
        .filter(Boolean)
        .slice(-normalizedLimit)
        .map((line) => safeJsonParse(line, null))
        .filter(Boolean)
        .reverse();
    } catch (_error) {
      return [];
    }
  }

  async function saveCrowdCaptureImage(image, context) {
    const collectedAt = new Date(context.collected_at || Date.now());
    const day = dateStampCompact(collectedAt);
    const dir = path.join(crowdFramesRoot, day);
    await fsp.mkdir(dir, { recursive: true });
    const vehicleId = sanitizeName(context.vehicle_id, 'vehicle');
    const cameraId = sanitizeName(image.camera_id || 'camera', 'camera');
    const captureId = `${timeStampCompact(collectedAt)}_${vehicleId}_${cameraId}_${crypto.randomBytes(4).toString('hex')}`;
    const imageBuffer = Buffer.from(image.base64, 'base64');
    const ext = mimeToExt(image.mime_type);
    const imageAbsPath = path.join(dir, `${captureId}${ext}`);
    const metaAbsPath = path.join(dir, `${captureId}.json`);
    const imageRelPath = path.relative(crowdFramesRoot, imageAbsPath).split(path.sep).join('/');

    const meta = {
      capture_id: captureId,
      sample_id: context.sample_id,
      collected_at: collectedAt.toISOString(),
      collected_at_ms: collectedAt.getTime(),
      vehicle_id: context.vehicle_id,
      camera_id: image.camera_id || cameraId,
      image_mime_type: image.mime_type,
      image_size_bytes: imageBuffer.length,
      image_sha256: crypto.createHash('sha256').update(imageBuffer).digest('hex'),
      image_header: image.header || null,
      image_width: image.width,
      image_height: image.height,
      image_path: imageRelPath,
      image_url: crowdFrameUrl(imageRelPath),
      position: context.position,
      capture_policy: context.policy,
      analysis: {
        status: 'pending',
        people_count: null,
        gender_mix: null,
        age_groups: null,
        height_groups: null,
        crowd_density: null,
        ad_opportunity_score: null,
        scene_tags: []
      },
      business: {
        kind: 'park_people_flow_pcm',
        note: '4-camera patrol capture for crowd analytics and ad traffic planning'
      }
    };

    await fsp.writeFile(imageAbsPath, imageBuffer);
    await fsp.writeFile(metaAbsPath, JSON.stringify(meta, null, 2), 'utf8');
    return meta;
  }

  async function runCrowdDemoCapture(params) {
    if (crowdCaptureInFlight) {
      const error = new Error('park_pcm_crowd_capture_in_flight');
      error.status = 409;
      throw error;
    }
    crowdCaptureInFlight = true;
    const startedAt = Date.now();
    try {
      const vehicles = await listVehicles();
      const requestedVehicleId = String(params?.vehicle_id || '').trim();
      const nowMs = Date.now();
      const freshVehicles = vehicles
        .filter((vehicle) => vehicle && vehicle.vehicle_id)
        .filter((vehicle) => {
          const lastSeenMs = Date.parse(vehicle.last_seen || '');
          return Number.isFinite(lastSeenMs) && nowMs - lastSeenMs <= freshVehicleMs;
        })
        .sort((left, right) => String(left.vehicle_id).localeCompare(String(right.vehicle_id), 'zh-CN'));
      const vehicle = requestedVehicleId
        ? vehicles.find((item) => String(item.vehicle_id) === requestedVehicleId)
        : freshVehicles[0];
      if (!vehicle?.vehicle_id) {
        const error = new Error('vehicle_id_required');
        error.status = 400;
        throw error;
      }

      const vehicleId = String(vehicle.vehicle_id);
      const distanceGateM = toFiniteNumber(params?.distance_m, crowdCaptureDistanceM, { min: 5, max: 1000 });
      const cooldownMs = toFiniteInteger(params?.cooldown_ms, crowdCaptureCooldownMs, {
        min: 10 * 1000,
        max: 60 * 60 * 1000
      });
      const quality = toFiniteInteger(params?.quality, 45, { min: 20, max: 90 });
      const maxWidth = toFiniteInteger(params?.max_width, 480, { min: 160, max: 1280 });
      const force = params?.force !== false;
      const localization = await callVehicleTool(vehicleId, 'status.localization', {}, statusToolTimeoutS);
      if (!localization.ok) {
        const error = new Error(localization.error || 'status.localization_failed');
        error.status = localization.status || 502;
        throw error;
      }
      const position = extractLocalizationPosition(localization);
      const crowdState = await readCrowdState();
      const lastCapture = crowdState.last_capture_by_vehicle[vehicleId] || null;
      const distanceFromLastM = lastCapture?.position
        ? haversineDistanceM(
            {
              latitude: Number(lastCapture.position.latitude),
              longitude: Number(lastCapture.position.longitude)
            },
            {
              latitude: position.latitude,
              longitude: position.longitude
            }
          )
        : null;
      const ageMs = lastCapture?.collected_at_ms ? Date.now() - Number(lastCapture.collected_at_ms) : null;
      const hasPosition = Number.isFinite(position.latitude) && Number.isFinite(position.longitude);
      const distanceReady = distanceFromLastM == null || distanceFromLastM >= distanceGateM;
      const cooldownReady = ageMs == null || ageMs >= cooldownMs;
      if (!force && (!hasPosition || !distanceReady || !cooldownReady)) {
        return {
          ok: true,
          skipped: true,
          reason: !hasPosition
            ? 'position_unavailable'
            : !distanceReady
              ? 'distance_gate_not_reached'
              : 'capture_cooldown_not_ready',
          vehicle_id: vehicleId,
          position,
          distance_gate_m: distanceGateM,
          distance_from_last_m: distanceFromLastM == null ? null : Math.round(distanceFromLastM * 10) / 10,
          cooldown_ms: cooldownMs,
          cooldown_age_ms: ageMs,
          last_capture: lastCapture
        };
      }

      const cameraIds = normalizeVehicleIds(params?.camera_ids).length
        ? normalizeVehicleIds(params.camera_ids).slice(0, 4)
        : ['camera1', 'camera2', 'camera3', 'camera4'];
      const captureArgs = {
        camera_ids: cameraIds,
        quality,
        max_width: maxWidth,
        include_base64: true
      };
      const capture = await callVehicleTool(vehicleId, 'camera.capture', captureArgs, crowdCaptureTimeoutS);
      if (!capture.ok) {
        const error = new Error(capture.error || 'camera.capture_failed');
        error.status = capture.status || 502;
        throw error;
      }

      const collectedAt = new Date();
      const sampleId = `${timeStampCompact(collectedAt)}_${sanitizeName(vehicleId, 'vehicle')}_${crypto.randomBytes(5).toString('hex')}`;
      const images = collectImages(capture.result).slice(0, 4);
      const frames = [];
      for (const image of images) {
        frames.push(
          await saveCrowdCaptureImage(image, {
            sample_id: sampleId,
            collected_at: collectedAt,
            vehicle_id: vehicleId,
            position,
            policy: {
              camera_ids: cameraIds,
              quality,
              max_width: maxWidth,
              include_base64: true,
              distance_gate_m: distanceGateM,
              cooldown_ms: cooldownMs,
              force
            }
          })
        );
      }

      const sample = {
        sample_id: sampleId,
        ok: true,
        skipped: false,
        collected_at: collectedAt.toISOString(),
        collected_at_ms: collectedAt.getTime(),
        elapsed_ms: Date.now() - startedAt,
        vehicle_id: vehicleId,
        vehicle_last_seen: vehicle.last_seen || null,
        position,
        distance_gate_m: distanceGateM,
        distance_from_last_m: distanceFromLastM == null ? null : Math.round(distanceFromLastM * 10) / 10,
        cooldown_ms: cooldownMs,
        cooldown_age_ms: ageMs,
        capture_args: captureArgs,
        frame_count: frames.length,
        total_image_bytes: frames.reduce((sum, frame) => sum + (frame.image_size_bytes || 0), 0),
        response_elapsed_ms: capture.elapsed_ms,
        frames: frames.map((frame) => ({
          capture_id: frame.capture_id,
          camera_id: frame.camera_id,
          image_size_bytes: frame.image_size_bytes,
          image_width: frame.image_width,
          image_height: frame.image_height,
          image_url: frame.image_url,
          image_path: frame.image_path,
          analysis: frame.analysis
        }))
      };
      crowdState.last_capture_by_vehicle[vehicleId] = {
        sample_id: sample.sample_id,
        collected_at: sample.collected_at,
        collected_at_ms: sample.collected_at_ms,
        position: sample.position,
        frame_count: sample.frame_count,
        total_image_bytes: sample.total_image_bytes
      };
      await writeCrowdState(crowdState);
      await appendCrowdSampleLog(sample);
      return sample;
    } finally {
      crowdCaptureInFlight = false;
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

  function buildVehicleRow(vehicle, toolResults, nowMs) {
    const vehicleId = String(vehicle.vehicle_id || vehicle.plate_number || '').trim();
    const lastSeenMs = Date.parse(vehicle.last_seen || '');
    const lastSeenAgeS = Number.isFinite(lastSeenMs) ? Math.max(0, (nowMs - lastSeenMs) / 1000) : null;
    const isFresh = lastSeenAgeS == null ? false : lastSeenAgeS * 1000 <= freshVehicleMs;
    const mission = classifyMission(vehicle, toolResults);
    const traffic = classifyTraffic(extractTrafficSignals(toolResults), mission);
    const health = classifyHealth({
      vehicle,
      isFresh,
      lastSeenAgeS,
      toolResults,
      mission,
      traffic
    });
    const routingSummary = compactToolResult(toolResults.routing?.result)?.summary || {};

    return {
      vehicle_id: vehicleId,
      plate_number: vehicle.plate_number || null,
      last_seen: vehicle.last_seen || null,
      last_seen_age_s: lastSeenAgeS == null ? null : Math.round(lastSeenAgeS),
      fresh: isFresh,
      tool_count: vehicle.tool_count == null ? null : vehicle.tool_count,
      route: {
        route_count: numberValue(routingSummary.route_count ?? routingSummary.available_route_count),
        current_route_id: routingSummary.current_route_id || routingSummary.active_route_id || null,
        route_location: routingSummary.current_route_location || routingSummary.route_location || null,
        current_path_string_ids: Array.isArray(routingSummary.current_path_string_ids)
          ? routingSummary.current_path_string_ids
          : []
      },
      telemetry: {
        speed_kph: mission.fields.speed_kph,
        battery_soc: mission.fields.battery_soc,
        running_mode: mission.fields.running_mode,
        remote_mode_enable: mission.fields.remote_mode_enable
      },
      mission,
      traffic,
      health,
      tool_elapsed_ms: {
        planning: toolResults.planning?.elapsed_ms ?? null,
        can: toolResults.can?.elapsed_ms ?? null,
        routing: toolResults.routing?.elapsed_ms ?? null,
        obstacle_processor: toolResults.obstacle?.elapsed_ms ?? null,
        perception: toolResults.perception?.elapsed_ms ?? null
      },
      tool_errors: {
        planning: toolResults.planning?.ok ? null : toolResults.planning?.error || 'unavailable',
        can: toolResults.can?.ok ? null : toolResults.can?.error || 'unavailable',
        routing: toolResults.routing?.ok ? null : toolResults.routing?.error || 'unavailable',
        obstacle_processor: toolResults.obstacle?.ok ? null : toolResults.obstacle?.error || 'unavailable',
        perception: toolResults.perception ? (toolResults.perception.ok ? null : toolResults.perception.error || 'unavailable') : null
      }
    };
  }

  async function buildSnapshot(params) {
    params = params || {};
    if (snapshotInFlight) {
      const error = new Error('park_pcm_snapshot_in_flight');
      error.status = 409;
      throw error;
    }
    snapshotInFlight = true;
    const startedAt = Date.now();
    try {
      const requestedVehicleIds = new Set(normalizeVehicleIds(params.vehicle_ids));
      const maxVehicles = toFiniteInteger(params.max_vehicles, 200, { min: 1, max: 500 });
      const includePerception = params.include_perception === true;
      const includeObstacle = params.include_obstacle !== false;
      const vehiclesRaw = await listVehicles();
      const vehicles = vehiclesRaw
        .filter((vehicle) => vehicle && vehicle.vehicle_id)
        .filter((vehicle) => {
          if (!requestedVehicleIds.size) {
            return true;
          }
          return requestedVehicleIds.has(String(vehicle.vehicle_id));
        })
        .sort((left, right) => String(left.vehicle_id).localeCompare(String(right.vehicle_id), 'zh-CN'))
        .slice(0, maxVehicles);
      const nowMs = Date.now();

      const rows = await mapWithConcurrency(vehicles, statusConcurrency, async (vehicle) => {
        const vehicleId = String(vehicle.vehicle_id);
        const calls = [
          ['planning', callVehicleTool(vehicleId, 'status.planning', {}, statusToolTimeoutS)],
          ['can', callVehicleTool(vehicleId, 'status.can', {}, statusToolTimeoutS)],
          ['routing', callVehicleTool(vehicleId, 'status.routing', {}, statusToolTimeoutS)]
        ];
        if (includeObstacle) {
          calls.push(['obstacle', callVehicleTool(vehicleId, 'status.obstacle_processor', {}, statusToolTimeoutS)]);
        }
        if (includePerception) {
          calls.push(['perception', callVehicleTool(vehicleId, 'status.perception', {}, statusToolTimeoutS)]);
        }
        const settled = await Promise.all(calls.map(([, promise]) => promise));
        const toolResults = {};
        calls.forEach(([key], index) => {
          toolResults[key] = settled[index];
        });
        return buildVehicleRow(vehicle, toolResults, nowMs);
      });

      const snapshot = {
        ok: true,
        generated_at: nowIso(),
        elapsed_ms: Date.now() - startedAt,
        cloud_agent: {
          base_url: cloudAgentBaseUrl,
          vehicle_count_raw: vehiclesRaw.length
        },
        config: {
          status_tool_timeout_s: statusToolTimeoutS,
          status_concurrency: statusConcurrency,
          fresh_vehicle_ms: freshVehicleMs,
          include_obstacle: includeObstacle,
          include_perception: includePerception
        },
        counts: {
          total: rows.length,
          fresh: rows.filter((row) => row.fresh).length,
          stale: rows.filter((row) => !row.fresh).length,
          health: countBy(rows, (row) => row.health.severity),
          mission: countBy(rows, (row) => row.mission.state),
          traffic: countBy(rows, (row) => row.traffic.level)
        },
        alerts: buildAlerts(rows),
        rows
      };
      await atomicWriteJson(snapshotPath, snapshot);
      return snapshot;
    } finally {
      snapshotInFlight = false;
    }
  }

  async function sendFeishuText(text) {
    if (!feishuWebhookUrl) {
      return {
        ok: true,
        sent: false,
        skipped: true,
        detail: 'park_pcm_feishu_webhook_not_configured'
      };
    }
    const response = await fetch(feishuWebhookUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        msg_type: 'text',
        content: {
          text
        }
      }),
      signal: AbortSignal.timeout(15000)
    });
    const rawText = await response.text();
    const payload = safeJsonParse(rawText, null);
    if (!response.ok) {
      const error = new Error(rawText.slice(0, 240) || `feishu_http_${response.status}`);
      error.status = response.status;
      throw error;
    }
    return {
      ok: true,
      sent: true,
      skipped: false,
      response: payload || rawText.slice(0, 240)
    };
  }

  async function writeReportState(state) {
    const current = (await readJsonFile(reportStatePath)) || {};
    await atomicWriteJson(reportStatePath, {
      ...current,
      ...state,
      updated_at: nowIso()
    });
  }

  async function sendSnapshotReport(snapshot, trigger) {
    const text = formatReportText(snapshot);
    try {
      const result = await sendFeishuText(text);
      await writeReportState({
        last_trigger: trigger,
        last_attempt_at: nowIso(),
        last_snapshot_at: snapshot.generated_at,
        last_text: text,
        last_result: result
      });
      return {
        ...result,
        text
      };
    } catch (error) {
      const result = {
        ok: false,
        sent: false,
        skipped: false,
        error: error.message || 'park_pcm_report_send_failed',
        status: error.status || null
      };
      await writeReportState({
        last_trigger: trigger,
        last_attempt_at: nowIso(),
        last_snapshot_at: snapshot.generated_at,
        last_text: text,
        last_result: result
      });
      return {
        ...result,
        text
      };
    }
  }

  async function runPeriodicReport(trigger) {
    if (reportInFlight) {
      return;
    }
    if (!reportEnabled) {
      await writeReportState({
        enabled: false,
        last_trigger: trigger,
        last_result: {
          ok: true,
          sent: false,
          skipped: true,
          detail: 'park_pcm_report_disabled'
        }
      }).catch(() => {});
      return;
    }
    if (!feishuWebhookUrl) {
      await writeReportState({
        enabled: true,
        webhook_configured: false,
        last_trigger: trigger,
        last_attempt_at: nowIso(),
        last_result: {
          ok: true,
          sent: false,
          skipped: true,
          detail: 'park_pcm_feishu_webhook_not_configured'
        }
      }).catch(() => {});
      return;
    }
    reportInFlight = true;
    try {
      const snapshot = await buildSnapshot({
        max_vehicles: reportMaxVehicles,
        include_obstacle: true,
        include_perception: false
      });
      await sendSnapshotReport(snapshot, trigger);
    } catch (error) {
      await writeReportState({
        last_trigger: trigger,
        last_attempt_at: nowIso(),
        last_result: {
          ok: false,
          sent: false,
          error: error.message || 'park_pcm_report_failed'
        }
      }).catch(() => {});
    } finally {
      reportInFlight = false;
    }
  }

  function scheduleNextReport(delayMs) {
    if (!reportEnabled) {
      return;
    }
    if (reportTimer) {
      clearTimeout(reportTimer);
    }
    reportTimer = setTimeout(() => {
      void runPeriodicReport('timer').finally(() => {
        scheduleNextReport(reportIntervalMs);
      });
    }, delayMs);
    if (typeof reportTimer.unref === 'function') {
      reportTimer.unref();
    }
  }

  app.get('/api/park-pcm/status', requirePermission('vehicle:read'), async (_req, res) => {
    const [snapshot, reportState] = await Promise.all([
      readJsonFile(snapshotPath),
      readJsonFile(reportStatePath)
    ]);
    return res.json({
      ok: true,
      cloud_agent_base_url: cloudAgentBaseUrl,
      runtime_root: runtimeRoot,
      report: {
        enabled: reportEnabled,
        webhook_configured: Boolean(feishuWebhookUrl),
        interval_ms: reportIntervalMs,
        in_flight: reportInFlight,
        state: reportState
      },
      snapshot: snapshot
        ? {
            generated_at: snapshot.generated_at,
            elapsed_ms: snapshot.elapsed_ms,
            counts: snapshot.counts,
            alert_count: Array.isArray(snapshot.alerts) ? snapshot.alerts.length : 0
          }
        : null,
      config: {
        status_tool_timeout_s: statusToolTimeoutS,
        status_concurrency: statusConcurrency,
        fresh_vehicle_ms: freshVehicleMs
      }
    });
  });

  app.get('/api/park-pcm/snapshot', requirePermission('vehicle:read'), async (req, res) => {
    try {
      if (String(req.query?.refresh || '').toLowerCase() === '1') {
        const snapshot = await buildSnapshot({
          max_vehicles: req.query?.max_vehicles,
          include_obstacle: String(req.query?.include_obstacle || 'true').toLowerCase() !== 'false',
          include_perception: String(req.query?.include_perception || '').toLowerCase() === 'true',
          vehicle_ids: req.query?.vehicle_ids
        });
        return res.json(snapshot);
      }
      const snapshot = await readJsonFile(snapshotPath);
      if (!snapshot) {
        return res.status(404).json({
          ok: false,
          error: 'park_pcm_snapshot_not_found',
          detail: '尚未生成园区 PCM 快照。'
        });
      }
      return res.json(snapshot);
    } catch (error) {
      return res.status(error.status || 502).json({
        ok: false,
        error: error.message || 'park_pcm_snapshot_failed'
      });
    }
  });

  app.post('/api/park-pcm/snapshot', requirePermission('vehicle:read'), async (req, res) => {
    try {
      const snapshot = await buildSnapshot(req.body || {});
      return res.json(snapshot);
    } catch (error) {
      return res.status(error.status || 502).json({
        ok: false,
        error: error.message || 'park_pcm_snapshot_failed'
      });
    }
  });

  app.get('/api/park-pcm/crowd/vehicles', requirePermission('vehicle:read'), async (_req, res) => {
    try {
      const [vehicles, state] = await Promise.all([
        listVehicles(),
        readCrowdState()
      ]);
      const nowMs = Date.now();
      const rows = vehicles
        .filter((vehicle) => vehicle && vehicle.vehicle_id)
        .map((vehicle) => {
          const lastSeenMs = Date.parse(vehicle.last_seen || '');
          const ageS = Number.isFinite(lastSeenMs) ? Math.max(0, Math.round((nowMs - lastSeenMs) / 1000)) : null;
          return {
            vehicle_id: String(vehicle.vehicle_id),
            plate_number: vehicle.plate_number || null,
            last_seen: vehicle.last_seen || null,
            last_seen_age_s: ageS,
            fresh: ageS != null && ageS * 1000 <= freshVehicleMs,
            tool_count: vehicle.tool_count == null ? null : vehicle.tool_count,
            telemetry: {
              speed_kph: numberValue(vehicle?.telemetry?.vehicle?.speed_kph ?? vehicle?.telemetry?.vehicle?.speed),
              battery_soc: numberValue(vehicle?.telemetry?.vehicle?.battery_soc),
              running_mode: numberValue(vehicle?.telemetry?.vehicle?.running_mode)
            },
            last_crowd_capture: state.last_capture_by_vehicle[String(vehicle.vehicle_id)] || null
          };
        })
        .sort((left, right) => {
          if (left.fresh !== right.fresh) return left.fresh ? -1 : 1;
          return left.vehicle_id.localeCompare(right.vehicle_id, 'zh-CN');
        });
      return res.json({
        ok: true,
        vehicles: rows,
        defaults: {
          camera_ids: ['camera1', 'camera2', 'camera3', 'camera4'],
          quality: 45,
          max_width: 480,
          distance_m: crowdCaptureDistanceM,
          cooldown_ms: crowdCaptureCooldownMs
        },
        in_flight: crowdCaptureInFlight
      });
    } catch (error) {
      return res.status(error.status || 502).json({
        ok: false,
        error: error.message || 'park_pcm_crowd_vehicle_list_failed'
      });
    }
  });

  app.get('/api/park-pcm/crowd/samples', requirePermission('vehicle:read'), async (req, res) => {
    try {
      const samples = await readRecentCrowdSamples(req.query?.limit);
      return res.json({
        ok: true,
        samples
      });
    } catch (error) {
      return res.status(error.status || 502).json({
        ok: false,
        error: error.message || 'park_pcm_crowd_samples_failed'
      });
    }
  });

  app.post('/api/park-pcm/crowd/demo-capture', requirePermission('vehicle:read'), async (req, res) => {
    try {
      const sample = await runCrowdDemoCapture({
        ...(req.body || {}),
        force: req.body?.force !== false
      });
      return res.status(sample.skipped ? 200 : 201).json(sample);
    } catch (error) {
      return res.status(error.status || 502).json({
        ok: false,
        error: error.message || 'park_pcm_crowd_capture_failed'
      });
    }
  });

  app.get('/api/park-pcm/crowd/files/*', requirePermission('vehicle:read'), async (req, res) => {
    const relativePath = String(req.params?.[0] || '');
    const targetPath = path.resolve(crowdFramesRoot, relativePath);
    const rootPath = path.resolve(crowdFramesRoot);
    if (!targetPath.startsWith(`${rootPath}${path.sep}`)) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_crowd_frame_path'
      });
    }
    return res.sendFile(targetPath, (error) => {
      if (error && !res.headersSent) {
        res.status(error.status || 404).json({
          ok: false,
          error: 'crowd_frame_not_found'
        });
      }
    });
  });

  app.post('/api/park-pcm/report/send', requirePermission('vehicle:read'), async (req, res) => {
    try {
      const snapshot =
        req.body?.use_last === true
          ? (await readJsonFile(snapshotPath)) || (await buildSnapshot(req.body || {}))
          : await buildSnapshot(req.body || {});
      const result = await sendSnapshotReport(snapshot, 'manual');
      return res.status(result.ok ? 200 : 502).json({
        ok: result.ok,
        report: result,
        snapshot: {
          generated_at: snapshot.generated_at,
          counts: snapshot.counts,
          alert_count: Array.isArray(snapshot.alerts) ? snapshot.alerts.length : 0
        }
      });
    } catch (error) {
      return res.status(error.status || 502).json({
        ok: false,
        error: error.message || 'park_pcm_report_failed'
      });
    }
  });

  scheduleNextReport(reportBootDelayMs);
};
