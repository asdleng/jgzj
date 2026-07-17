const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const DEFAULT_STATUS_TOOL_TIMEOUT_S = 8;
const DEFAULT_HTTP_EXTRA_TIMEOUT_MS = 5000;
const DEFAULT_STATUS_CONCURRENCY = 2;
const DEFAULT_FRESH_VEHICLE_MS = 5 * 60 * 1000;
const DEFAULT_REPORT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_REPORT_BOOT_DELAY_MS = 60 * 1000;
const DEFAULT_CROWD_CAPTURE_TIMEOUT_S = 45;
const DEFAULT_CROWD_CAPTURE_DISTANCE_M = 60;
const DEFAULT_CROWD_CAPTURE_COOLDOWN_MS = 90 * 1000;
const DEFAULT_PATROL_STATUS_TIMEOUT_S = 8;
const DEFAULT_PATROL_STATUS_CONCURRENCY = 4;
const DEFAULT_CROWD_MONITOR_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_CROWD_MONITOR_BOOT_DELAY_MS = 90 * 1000;
const DEFAULT_CROWD_MONITOR_MAX_VEHICLES = 16;
const DEFAULT_CROWD_MONITOR_MAX_CAPTURES = 1;
const DEFAULT_CROWD_MONITOR_MAX_ATTEMPTS = 2;
const DEFAULT_CROWD_MONITOR_DISTANCE_M = 80;
const DEFAULT_CROWD_MONITOR_COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_CROWD_MONITOR_QUALITY = 40;
const DEFAULT_CROWD_MONITOR_MAX_WIDTH = 480;
const DEFAULT_CROWD_ANALYSIS_INTERVAL_MS = 2 * 60 * 1000;
const DEFAULT_CROWD_ANALYSIS_BOOT_DELAY_MS = 45 * 1000;
const DEFAULT_CROWD_ANALYSIS_TIMEOUT_MS = 90 * 1000;
const DEFAULT_CROWD_ANALYSIS_MAX_SAMPLES = 1;
const DEFAULT_CROWD_ANALYSIS_IDLE_GPU_UTIL_MAX = 25;
const DEFAULT_CROWD_ANALYSIS_IDLE_CHECK_TIMEOUT_MS = 3000;
const DEFAULT_CROWD_STORAGE_RETENTION_DAYS = 30;
const DEFAULT_CROWD_STORAGE_MAX_BYTES = 120 * 1024 * 1024 * 1024;
const DEFAULT_CROWD_STORAGE_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_PATROL_FLOW_UPLOAD_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_PATROL_FLOW_MAX_FRAME_ROWS = 4000;
const DEFAULT_CROWD_ROUTE_MAX_POINTS = 700;
const PATROL_FLOW_SCHEMA_V1 = 'auto_ad_patrol_flow_session.v1';
const VEHICLE_PATROL_FLOW_SAMPLE_SOURCE = 'auto_ad_patrol_flow_upload';
const CROWD_HEATMAP_DAY_AXIS_COUNT = 30;
const GREEN_INSPECTION_SCHEMA = 'park_green_inspection.v1';
const GREEN_INSPECTION_IMAGE_MAX_SIZE = 640;
const GREEN_INSPECTION_IMAGE_QUALITY = 78;
const DEFAULT_GREEN_INSPECTION_AUTO_INTERVAL_MS = 1000;
const DEFAULT_GREEN_INSPECTION_AUTO_BOOT_DELAY_MS = 5000;
const DEFAULT_GREEN_INSPECTION_AUTO_LOOKBACK_HOURS = 48;
const DEFAULT_GREEN_INSPECTION_AUTO_SCAN_LIMIT = 20000;
const DEFAULT_GREEN_INSPECTION_AUTO_MAX_ATTEMPTS = 5;
const DEFAULT_GREEN_INSPECTION_AUTO_RETRY_BASE_MS = 60 * 1000;
const DEFAULT_GREEN_INSPECTION_AUTO_RETRY_MAX_MS = 60 * 60 * 1000;
const DEFAULT_GREEN_INSPECTION_AUTO_LEASE_MS = 5 * 60 * 1000;
const GREEN_INSPECTION_ISSUE_TYPES = new Set([
  'yellowing_or_wilting',
  'drought_stress',
  'pest_or_disease',
  'dead_or_broken_branch',
  'overgrowth_or_encroachment',
  'missing_or_bare_patch',
  'support_or_tree_grate_problem'
]);

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

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(unwrapRosValue(item) || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function hasFiniteRouteLocation(location) {
  if (!location || typeof location !== 'object') {
    return false;
  }
  const x = numberValue(location.x ?? location.position_x);
  const y = numberValue(location.y ?? location.position_y);
  const lat = numberValue(location.lat ?? location.latitude ?? location.Lattitude);
  const lng = numberValue(location.lng ?? location.longitude ?? location.Longitude);
  return (
    (x != null && y != null) ||
    (lat != null && lng != null)
  );
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

function classifyCrowdPatrolCaptureState(vehicle, toolResults, options) {
  const planning = toolResults.planning?.result || null;
  const routing = toolResults.routing?.result || null;
  const can = toolResults.can?.result || null;
  const planningSummary = compactToolResult(planning)?.summary || {};
  const routingSummary = compactToolResult(routing)?.summary || {};
  const canSummary = compactToolResult(can)?.summary || {};
  const sample = planningSample(planning);
  const telemetryVehicle = vehicle?.telemetry?.vehicle || {};
  const nowMs = options?.now_ms || Date.now();
  const freshVehicleMsForCheck = options?.fresh_vehicle_ms || DEFAULT_FRESH_VEHICLE_MS;
  const lastSeenMs = Date.parse(vehicle?.last_seen || '');
  const lastSeenAgeS = Number.isFinite(lastSeenMs) ? Math.max(0, Math.round((nowMs - lastSeenMs) / 1000)) : null;
  const fresh = lastSeenAgeS != null && lastSeenAgeS * 1000 <= freshVehicleMsForCheck;

  const speedKph = numberValue(
    canSummary.speed_kph ??
      canSummary.speed ??
      canSummary.vehicle_speed ??
      telemetryVehicle.speed_kph ??
      telemetryVehicle.speed
  );
  const moving = speedKph != null && Math.abs(speedKph) > 0.3;
  const plannerRunning = numberValue(planningSummary.planner_running ?? sample.planner_running);
  const vehicleIdleStatus = numberValue(planningSummary.vehicle_idle_status ?? sample.vehicle_idle_status);
  const currentLoop = numberValue(planningSummary.current_loop_index ?? sample.current_loop_index);
  const totalLoop = numberValue(planningSummary.total_loop_sum ?? sample.total_loop_sum);
  const currentRefline = numberValue(planningSummary.current_refline_index ?? sample.current_refline_index);
  const totalRefline = numberValue(planningSummary.total_refline_sum ?? sample.total_refline_sum);
  const currentScenario = numberValue(planningSummary.current_scenario ?? sample.current_scenario);
  const currentAction = numberValue(planningSummary.current_action ?? sample.current_action);
  const trajectoryLength = numberValue(planningSummary.trajectory_total_length ?? sample.trajectory_total_length);
  const trajectoryPointCount = numberValue(planningSummary.trajectory_point_count ?? sample.trajectory_point_count);
  const longTimeStop = booleanValue(sample.long_time_stop ?? planningSummary.long_time_stop);
  const inChargerZone = booleanValue(sample.in_charger_zone ?? planningSummary.in_charger_zone);
  const batteryChargeState = numberValue(canSummary.battery_charge_state);
  const runningMode = numberValue(canSummary.running_mode ?? telemetryVehicle.running_mode);
  const faultLampsOn = normalizeStringList(canSummary.fault_lamps_on ?? canSummary.fault_lamps ?? canSummary.lamps_on);
  const chargeLampOn = faultLampsOn.some((lamp) => /charge|charging|charger/i.test(lamp));
  const emergencyStop = booleanValue(
    canSummary.emergency_stop ??
      canSummary.emergency_stop_status ??
      canSummary.e_stop ??
      telemetryVehicle.emergency_stop
  );
  const collisionStop = booleanValue(
    canSummary.collision_stop ??
      canSummary.collision_stop_status ??
      canSummary.collision_status ??
      telemetryVehicle.collision_stop
  );
  const ultrasonicStop = booleanValue(canSummary.ultrasonic_stop ?? canSummary.ultrasonic_stop_status);
  const routePathIds = normalizeStringList(routingSummary.current_path_string_ids);
  const routeLocation = routingSummary.current_route_location || routingSummary.route_location || null;
  const routeLocationValid = hasFiniteRouteLocation(routeLocation);

  const plannerActive = plannerRunning != null && plannerRunning > 0;
  const routeProgress =
    totalLoop != null &&
    totalRefline != null &&
    currentLoop != null &&
    currentRefline != null &&
    totalLoop > 0 &&
    totalRefline > 0 &&
    currentLoop >= 0 &&
    currentRefline >= 0;
  const hasTrajectory =
    trajectoryPointCount != null &&
    trajectoryPointCount > 0 &&
    trajectoryLength != null &&
    trajectoryLength > 0;
  const routeTaskEvidence = plannerActive || routePathIds.length > 0 || routeProgress || (routeLocationValid && hasTrajectory);
  const completedLike =
    routeProgress &&
    plannerRunning !== null &&
    plannerRunning <= 0 &&
    (longTimeStop === true || vehicleIdleStatus === 1) &&
    currentLoop >= totalLoop &&
    currentRefline >= totalRefline;
  const longIdleStopped =
    !plannerActive &&
    longTimeStop === true &&
    vehicleIdleStatus === 1;
  const charging = inChargerZone === true || (batteryChargeState != null && batteryChargeState > 0) || chargeLampOn;
  const hardSafetyStop = emergencyStop === true || collisionStop === true;

  const reasons = [];
  if (!fresh) reasons.push(lastSeenAgeS == null ? 'vehicle_last_seen_unknown' : `vehicle_last_seen_${lastSeenAgeS}s`);
  if (!toolResults.planning?.ok) reasons.push(`planning_unavailable:${toolResults.planning?.error || 'unavailable'}`);
  if (toolResults.routing && !toolResults.routing.ok) reasons.push(`routing_unavailable:${toolResults.routing.error || 'unavailable'}`);
  if (!toolResults.can?.ok) reasons.push(`can_unavailable:${toolResults.can?.error || 'unavailable'}`);
  if (plannerActive) reasons.push(`planner_running=${plannerRunning}`);
  if (routePathIds.length) reasons.push(`path_ids=${routePathIds.slice(0, 3).join('|')}`);
  if (routeProgress) reasons.push(`loop=${currentLoop}/${totalLoop}`, `refline=${currentRefline}/${totalRefline}`);
  if (routeLocationValid) reasons.push('route_location_valid');
  if (longTimeStop === true) reasons.push('long_time_stop=true');
  if (vehicleIdleStatus != null) reasons.push(`vehicle_idle_status=${vehicleIdleStatus}`);
  if (charging) reasons.push(`charging=${batteryChargeState ?? chargeLampOn}`);
  if (hardSafetyStop) reasons.push(emergencyStop === true ? 'emergency_stop' : 'collision_stop');

  let state = 'unknown';
  let confidence = 'low';
  if (!fresh) {
    state = 'stale_vehicle';
    confidence = 'high';
  } else if (!toolResults.planning?.ok) {
    state = 'unknown';
    confidence = 'low';
  } else if (!toolResults.can?.ok) {
    state = 'patrol_unverified_can_unavailable';
    confidence = 'low';
  } else if (charging) {
    state = 'charging_or_charging_area';
    confidence = 'high';
  } else if (hardSafetyStop) {
    state = 'safety_stop';
    confidence = 'high';
  } else if (!routeTaskEvidence) {
    state = toolResults.planning?.ok || toolResults.routing?.ok ? 'not_patrol' : 'unknown';
    confidence = toolResults.planning?.ok || toolResults.routing?.ok ? 'high' : 'low';
  } else if (completedLike) {
    state = 'patrol_completed_or_idle';
    confidence = 'medium';
  } else if (longIdleStopped) {
    state = 'patrol_task_long_stopped';
    confidence = 'medium';
  } else if (plannerActive && moving) {
    state = 'patrol_active_moving';
    confidence = 'high';
  } else if (plannerActive) {
    state = 'patrol_active_stopped';
    confidence = 'high';
  } else if (moving || vehicleIdleStatus === 0 || longTimeStop === false) {
    state = 'patrol_task_stopped_or_waiting';
    confidence = routeProgress || routePathIds.length ? 'medium' : 'low';
  } else {
    state = 'patrol_task_loaded_unverified';
    confidence = routeProgress || routePathIds.length ? 'medium' : 'low';
  }

  const captureEligible = [
    'patrol_active_moving',
    'patrol_active_stopped',
    'patrol_task_stopped_or_waiting'
  ].includes(state);

  if (!captureEligible && !reasons.length) {
    reasons.push('no_patrol_capture_evidence');
  }

  return {
    state,
    capture_eligible: captureEligible,
    confidence,
    reasons: reasons.slice(0, 12),
    tool_ok: {
      planning: toolResults.planning?.ok === true,
      routing: toolResults.routing ? toolResults.routing.ok === true : null,
      can: toolResults.can?.ok === true
    },
    tool_elapsed_ms: {
      planning: toolResults.planning?.elapsed_ms ?? null,
      routing: toolResults.routing?.elapsed_ms ?? null,
      can: toolResults.can?.elapsed_ms ?? null
    },
    fields: {
      fresh,
      last_seen: vehicle?.last_seen || null,
      last_seen_age_s: lastSeenAgeS,
      speed_kph: speedKph,
      moving,
      running_mode: runningMode,
      planner_running: plannerRunning,
      vehicle_idle_status: vehicleIdleStatus,
      long_time_stop: longTimeStop,
      in_charger_zone: inChargerZone,
      battery_charge_state: batteryChargeState,
      fault_lamps_on: faultLampsOn,
      emergency_stop: emergencyStop,
      collision_stop: collisionStop,
      ultrasonic_stop: ultrasonicStop,
      current_scenario: currentScenario,
      current_action: currentAction,
      current_loop_index: currentLoop,
      total_loop_sum: totalLoop,
      current_refline_index: currentRefline,
      total_refline_sum: totalRefline,
      trajectory_total_length: trajectoryLength,
      trajectory_point_count: trajectoryPointCount,
      current_path_string_ids: routePathIds,
      route_location_valid: routeLocationValid,
      route_task_evidence: routeTaskEvidence,
      route_completed_like: completedLike,
      long_idle_stopped: longIdleStopped
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

function formatByteCount(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${Math.round(bytes)} B`;
}

function formatCrowdReportText(report) {
  const vehicle = report.vehicle || {};
  const capture = report.capture || {};
  const latest = Array.isArray(report.latest_samples) ? report.latest_samples.slice(0, 5) : [];
  const lines = [
    `园区人流采集小时报告 ${formatLocalTime(report.generated_at)}`,
    `车辆：纳管 ${vehicle.total || 0}，新鲜在线 ${vehicle.fresh || 0}，过期/未知 ${vehicle.stale || 0}`,
    `车端上传：近 24 小时 ${capture.sample_count_24h || 0} 条，图片 ${capture.frame_count_24h || 0} 张，数据 ${formatByteCount(capture.total_image_bytes_24h)}`,
    `覆盖：近 24 小时车辆 ${capture.vehicle_count_24h || 0} 台，服务状态 ${report.in_flight ? '处理中' : '空闲'}`,
    `策略：只统计车端 patrol-flow 上传包，按图片定位和人群识别结果聚合`
  ];
  if (latest.length) {
    lines.push('最近车端上传：');
    latest.forEach((sample, index) => {
      const position = sample.position || {};
      const patrol = sample.patrol_state || {};
      lines.push(
        `${index + 1}. ${sample.vehicle_id || '-'} ${formatLocalTime(sample.collected_at)} ${sample.frame_count || 0} 路 ` +
          `${formatByteCount(sample.total_image_bytes)} ${patrol.state || 'patrol_unrecorded'} ` +
          `高德(${position.gaode_longitude == null ? '-' : Number(position.gaode_longitude).toFixed(6)}, ${
            position.gaode_latitude == null ? '-' : Number(position.gaode_latitude).toFixed(6)
          })`
      );
    });
  } else {
    lines.push('最近车端上传：暂无已确认巡逻的人流数据。');
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

function crowdDayKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return parts.year && parts.month && parts.day ? `${parts.year}-${parts.month}-${parts.day}` : '';
}

function crowdDayKeyToUtcMs(key) {
  const match = String(key || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(ms) ? ms : null;
}

function crowdDayKeyFromUtcMs(ms) {
  if (!Number.isFinite(Number(ms))) return '';
  return new Date(Number(ms)).toISOString().slice(0, 10);
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

function sampleCollectedAtMs(sample) {
  const direct = Number(sample?.collected_at_ms);
  if (Number.isFinite(direct)) {
    return direct;
  }
  const parsed = Date.parse(sample?.collected_at || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function summarizeVehicleCrowdSamples(samples, vehicleId, nowMs) {
  const dayAgoMs = nowMs - 24 * 60 * 60 * 1000;
  const vehicleSamples = samples
    .filter((sample) => sample && !sample.skipped)
    .filter((sample) => String(sample.vehicle_id || '') === String(vehicleId))
    .filter((sample) => sample.patrol_state && sample.patrol_state.capture_eligible === true);
  const recentSamples = vehicleSamples.filter((sample) => {
    const collectedAtMs = sampleCollectedAtMs(sample);
    return collectedAtMs != null && collectedAtMs >= dayAgoMs;
  });
  const latestSample = vehicleSamples
    .slice()
    .sort((left, right) => (sampleCollectedAtMs(right) || 0) - (sampleCollectedAtMs(left) || 0))[0] || null;
  return {
    sample_count_24h: recentSamples.length,
    frame_count_24h: recentSamples.reduce((sum, sample) => sum + (Number(sample.frame_count) || 0), 0),
    total_image_bytes_24h: recentSamples.reduce((sum, sample) => sum + (Number(sample.total_image_bytes) || 0), 0),
    latest_sample: latestSample
      ? {
          sample_id: latestSample.sample_id,
          collected_at: latestSample.collected_at,
          frame_count: latestSample.frame_count,
          total_image_bytes: latestSample.total_image_bytes,
          position: latestSample.position || null,
          frames: Array.isArray(latestSample.frames) ? latestSample.frames.slice(0, 4) : []
        }
      : null
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

function firstNonEmpty(values) {
  for (const value of values) {
    if (value == null) continue;
    const raw = unwrapRosValue(value);
    if (raw && typeof raw === 'object') continue;
    const text = String(raw).trim();
    if (text) return raw;
  }
  return null;
}

function firstFiniteNumber(values) {
  for (const value of values) {
    const raw = unwrapRosValue(value);
    if (raw == null || raw === '') continue;
    if (raw && typeof raw === 'object') continue;
    const num = Number(raw);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function timestampMsFromValue(value) {
  const raw = unwrapRosValue(value);
  if (raw == null || raw === '') return null;
  if (raw instanceof Date && Number.isFinite(raw.getTime())) return raw.getTime();
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const sec = Number(
      unwrapRosValue(raw.sec ?? raw.secs ?? raw.seconds ?? raw.tv_sec)
    );
    const nsec = Number(
      unwrapRosValue(raw.nanosec ?? raw.nsec ?? raw.nsecs ?? raw.tv_nsec ?? raw.nanoseconds)
    );
    if (Number.isFinite(sec)) {
      return Math.round(sec * 1000 + (Number.isFinite(nsec) ? nsec / 1000000 : 0));
    }
  }
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    if (numeric > 1000000000000) return Math.round(numeric);
    if (numeric > 1000000000) return Math.round(numeric * 1000);
    return null;
  }
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? parsed : null;
}

function objectValue(value) {
  const raw = unwrapRosValue(value);
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function imageMimeFromFilePath(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
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
  const cloudAgentAuthHeaders = { ...(options.cloudAgentAuthHeaders || {}) };
  const rootDir = path.resolve(options.rootDir || path.resolve(__dirname, '..'));
  const runtimeRoot = path.resolve(
    process.env.PARK_CROWD_RUNTIME_ROOT || process.env.PARK_PCM_RUNTIME_ROOT || path.join(rootDir, '.runtime/park-pcm')
  );
  const snapshotPath = path.join(runtimeRoot, 'last-snapshot.json');
  const reportStatePath = path.join(runtimeRoot, 'report-state.json');
  const reportPdfRoot = path.join(runtimeRoot, 'report-pdf');
  const reportPdfRendererPath = path.join(rootDir, 'scripts', 'render_park_crowd_report_pdf.py');
  const crowdFramesRoot = path.join(runtimeRoot, 'crowd-frames');
  const crowdRedactedFramesRoot = path.join(runtimeRoot, 'crowd-frames-redacted');
  const crowdRedactionPersonModelPath = path.resolve(
    process.env.PARK_CROWD_REDACTION_PERSON_MODEL_PATH || path.join(rootDir, '.runtime/yolo_model_service/weights/person_yolo_best.pt')
  );
  const crowdUploadsRoot = path.join(runtimeRoot, 'patrol-flow-uploads');
  const crowdIndexLogPath = path.join(runtimeRoot, 'crowd-samples.jsonl');
  const crowdStatePath = path.join(runtimeRoot, 'crowd-capture-state.json');
  const crowdMonitorStatePath = path.join(runtimeRoot, 'crowd-monitor-state.json');
  const crowdAnalysisStatePath = path.join(runtimeRoot, 'crowd-analysis-state.json');
  const greenInspectionStatePath = path.join(runtimeRoot, 'green-inspection-state.json');
  const greenInspectionWorkerStatePath = path.join(runtimeRoot, 'green-inspection-worker-state.json');
  const crowdUploadStatePath = path.join(runtimeRoot, 'patrol-flow-upload-state.json');
  const crowdUploadIndexLogPath = path.join(runtimeRoot, 'patrol-flow-uploads.jsonl');
  const crowdStorageStatusPath = path.join(runtimeRoot, 'crowd-storage-status.json');
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
  const patrolStatusTimeoutS = toFiniteNumber(
    process.env.PARK_PCM_PATROL_STATUS_TIMEOUT_S,
    DEFAULT_PATROL_STATUS_TIMEOUT_S,
    { min: 3, max: 15 }
  );
  const patrolStatusConcurrency = toFiniteInteger(
    process.env.PARK_PCM_PATROL_STATUS_CONCURRENCY,
    DEFAULT_PATROL_STATUS_CONCURRENCY,
    { min: 1, max: 8 }
  );
  const patrolFlowToolTimeoutS = toFiniteNumber(
    process.env.PARK_CROWD_PATROL_FLOW_TOOL_TIMEOUT_S || process.env.PARK_PCM_PATROL_FLOW_TOOL_TIMEOUT_S,
    10,
    { min: 3, max: 60 }
  );
  const patrolFlowFlushTimeoutS = toFiniteNumber(
    process.env.PARK_CROWD_PATROL_FLOW_FLUSH_TIMEOUT_S || process.env.PARK_PCM_PATROL_FLOW_FLUSH_TIMEOUT_S,
    60,
    { min: 10, max: 300 }
  );
  const patrolFlowToolConcurrency = toFiniteInteger(
    process.env.PARK_CROWD_PATROL_FLOW_TOOL_CONCURRENCY || process.env.PARK_PCM_PATROL_FLOW_TOOL_CONCURRENCY,
    3,
    { min: 1, max: 8 }
  );
  const crowdMonitorEnabled = String(
    process.env.PARK_CROWD_MONITOR_ENABLED || process.env.PARK_PCM_CROWD_MONITOR_ENABLED || 'true'
  ).toLowerCase() !== 'false';
  const crowdMonitorIntervalMs = toFiniteInteger(
    process.env.PARK_CROWD_MONITOR_INTERVAL_MS || process.env.PARK_PCM_CROWD_MONITOR_INTERVAL_MS,
    DEFAULT_CROWD_MONITOR_INTERVAL_MS,
    { min: 60 * 1000, max: 60 * 60 * 1000 }
  );
  const crowdMonitorBootDelayMs = toFiniteInteger(
    process.env.PARK_CROWD_MONITOR_BOOT_DELAY_MS || process.env.PARK_PCM_CROWD_MONITOR_BOOT_DELAY_MS,
    DEFAULT_CROWD_MONITOR_BOOT_DELAY_MS,
    { min: 10 * 1000, max: 60 * 60 * 1000 }
  );
  const crowdMonitorMaxVehicles = toFiniteInteger(
    process.env.PARK_CROWD_MONITOR_MAX_VEHICLES || process.env.PARK_PCM_CROWD_MONITOR_MAX_VEHICLES,
    DEFAULT_CROWD_MONITOR_MAX_VEHICLES,
    { min: 1, max: 80 }
  );
  const crowdMonitorMaxCaptures = toFiniteInteger(
    process.env.PARK_CROWD_MONITOR_MAX_CAPTURES || process.env.PARK_PCM_CROWD_MONITOR_MAX_CAPTURES,
    DEFAULT_CROWD_MONITOR_MAX_CAPTURES,
    { min: 1, max: 4 }
  );
  const crowdMonitorMaxAttempts = toFiniteInteger(
    process.env.PARK_CROWD_MONITOR_MAX_ATTEMPTS || process.env.PARK_PCM_CROWD_MONITOR_MAX_ATTEMPTS,
    DEFAULT_CROWD_MONITOR_MAX_ATTEMPTS,
    { min: 1, max: 8 }
  );
  const crowdMonitorDistanceM = toFiniteNumber(
    process.env.PARK_CROWD_MONITOR_DISTANCE_M || process.env.PARK_PCM_CROWD_MONITOR_DISTANCE_M,
    DEFAULT_CROWD_MONITOR_DISTANCE_M,
    { min: 10, max: 1000 }
  );
  const crowdMonitorCooldownMs = toFiniteInteger(
    process.env.PARK_CROWD_MONITOR_COOLDOWN_MS || process.env.PARK_PCM_CROWD_MONITOR_COOLDOWN_MS,
    DEFAULT_CROWD_MONITOR_COOLDOWN_MS,
    { min: 60 * 1000, max: 24 * 60 * 60 * 1000 }
  );
  const crowdMonitorQuality = toFiniteInteger(
    process.env.PARK_CROWD_MONITOR_QUALITY || process.env.PARK_PCM_CROWD_MONITOR_QUALITY,
    DEFAULT_CROWD_MONITOR_QUALITY,
    { min: 20, max: 80 }
  );
  const crowdMonitorMaxWidth = toFiniteInteger(
    process.env.PARK_CROWD_MONITOR_MAX_WIDTH || process.env.PARK_PCM_CROWD_MONITOR_MAX_WIDTH,
    DEFAULT_CROWD_MONITOR_MAX_WIDTH,
    { min: 160, max: 960 }
  );
  const crowdAnalysisEnabled = String(
    process.env.PARK_CROWD_ANALYSIS_ENABLED || process.env.PARK_PCM_CROWD_ANALYSIS_ENABLED || 'true'
  ).toLowerCase() !== 'false';
  const crowdAnalysisBaseUrl = String(
    process.env.PARK_CROWD_ANALYSIS_BASE_URL || process.env.PARK_PCM_CROWD_ANALYSIS_BASE_URL || 'http://127.0.0.1:8012/v1'
  ).replace(/\/+$/, '');
  const crowdAnalysisModel = String(
    process.env.PARK_CROWD_ANALYSIS_MODEL || process.env.PARK_PCM_CROWD_ANALYSIS_MODEL || 'qwen3-vl-2b-checker'
  );
  const crowdAnalysisChatUrl = new URL('chat/completions', `${crowdAnalysisBaseUrl}/`).toString();
  const crowdAnalysisIntervalMs = toFiniteInteger(
    process.env.PARK_CROWD_ANALYSIS_INTERVAL_MS || process.env.PARK_PCM_CROWD_ANALYSIS_INTERVAL_MS,
    DEFAULT_CROWD_ANALYSIS_INTERVAL_MS,
    { min: 30 * 1000, max: 60 * 60 * 1000 }
  );
  const crowdAnalysisBootDelayMs = toFiniteInteger(
    process.env.PARK_CROWD_ANALYSIS_BOOT_DELAY_MS || process.env.PARK_PCM_CROWD_ANALYSIS_BOOT_DELAY_MS,
    DEFAULT_CROWD_ANALYSIS_BOOT_DELAY_MS,
    { min: 10 * 1000, max: 60 * 60 * 1000 }
  );
  const crowdAnalysisTimeoutMs = toFiniteInteger(
    process.env.PARK_CROWD_ANALYSIS_TIMEOUT_MS || process.env.PARK_PCM_CROWD_ANALYSIS_TIMEOUT_MS,
    DEFAULT_CROWD_ANALYSIS_TIMEOUT_MS,
    { min: 10 * 1000, max: 5 * 60 * 1000 }
  );
  const crowdAnalysisMaxSamples = toFiniteInteger(
    process.env.PARK_CROWD_ANALYSIS_MAX_SAMPLES || process.env.PARK_PCM_CROWD_ANALYSIS_MAX_SAMPLES,
    DEFAULT_CROWD_ANALYSIS_MAX_SAMPLES,
    { min: 1, max: 8 }
  );
  const crowdAnalysisIdleOnly = String(
    process.env.PARK_CROWD_ANALYSIS_IDLE_ONLY || process.env.PARK_PCM_CROWD_ANALYSIS_IDLE_ONLY || 'true'
  ).toLowerCase() !== 'false';
  const crowdAnalysisIdleGpuUtilMax = toFiniteNumber(
    process.env.PARK_CROWD_ANALYSIS_IDLE_GPU_UTIL_MAX || process.env.PARK_PCM_CROWD_ANALYSIS_IDLE_GPU_UTIL_MAX,
    DEFAULT_CROWD_ANALYSIS_IDLE_GPU_UTIL_MAX,
    { min: 0, max: 100 }
  );
  const crowdAnalysisIdleCheckTimeoutMs = toFiniteInteger(
    process.env.PARK_CROWD_ANALYSIS_IDLE_CHECK_TIMEOUT_MS || process.env.PARK_PCM_CROWD_ANALYSIS_IDLE_CHECK_TIMEOUT_MS,
    DEFAULT_CROWD_ANALYSIS_IDLE_CHECK_TIMEOUT_MS,
    { min: 500, max: 10000 }
  );
  const greenInspectionBaseUrl = String(
    process.env.PARK_GREEN_INSPECTION_BASE_URL || 'http://127.0.0.1:18016/v1'
  ).replace(/\/+$/, '');
  const greenInspectionModel = String(
    process.env.PARK_GREEN_INSPECTION_MODEL || 'Qwen3.6-27B-Labeler'
  );
  const greenInspectionChatUrl = new URL('chat/completions', `${greenInspectionBaseUrl}/`).toString();
  const greenInspectionTimeoutMs = toFiniteInteger(
    process.env.PARK_GREEN_INSPECTION_TIMEOUT_MS,
    180 * 1000,
    { min: 10 * 1000, max: 5 * 60 * 1000 }
  );
  const greenInspectionConcurrency = toFiniteInteger(
    process.env.PARK_GREEN_INSPECTION_CONCURRENCY,
    1,
    { min: 1, max: 4 }
  );
  const greenInspectionPendingLimit = toFiniteInteger(
    process.env.PARK_GREEN_INSPECTION_PENDING_LIMIT,
    32,
    { min: 1, max: 200 }
  );
  const greenInspectionAutoEnabled = String(
    process.env.PARK_GREEN_INSPECTION_AUTO_ENABLED || 'true'
  ).toLowerCase() !== 'false';
  const greenInspectionAutoIntervalMs = toFiniteInteger(
    process.env.PARK_GREEN_INSPECTION_AUTO_INTERVAL_MS,
    DEFAULT_GREEN_INSPECTION_AUTO_INTERVAL_MS,
    { min: 250, max: 60 * 1000 }
  );
  const greenInspectionAutoBootDelayMs = toFiniteInteger(
    process.env.PARK_GREEN_INSPECTION_AUTO_BOOT_DELAY_MS,
    DEFAULT_GREEN_INSPECTION_AUTO_BOOT_DELAY_MS,
    { min: 250, max: 60 * 60 * 1000 }
  );
  const greenInspectionAutoLookbackHours = toFiniteInteger(
    process.env.PARK_GREEN_INSPECTION_AUTO_LOOKBACK_HOURS,
    DEFAULT_GREEN_INSPECTION_AUTO_LOOKBACK_HOURS,
    { min: 1, max: 30 * 24 }
  );
  const greenInspectionAutoScanLimit = toFiniteInteger(
    process.env.PARK_GREEN_INSPECTION_AUTO_SCAN_LIMIT,
    DEFAULT_GREEN_INSPECTION_AUTO_SCAN_LIMIT,
    { min: 100, max: 20000 }
  );
  const greenInspectionAutoMaxAttempts = toFiniteInteger(
    process.env.PARK_GREEN_INSPECTION_AUTO_MAX_ATTEMPTS,
    DEFAULT_GREEN_INSPECTION_AUTO_MAX_ATTEMPTS,
    { min: 1, max: 20 }
  );
  const greenInspectionAutoRetryBaseMs = toFiniteInteger(
    process.env.PARK_GREEN_INSPECTION_AUTO_RETRY_BASE_MS,
    DEFAULT_GREEN_INSPECTION_AUTO_RETRY_BASE_MS,
    { min: 1000, max: 60 * 60 * 1000 }
  );
  const greenInspectionAutoRetryMaxMs = toFiniteInteger(
    process.env.PARK_GREEN_INSPECTION_AUTO_RETRY_MAX_MS,
    DEFAULT_GREEN_INSPECTION_AUTO_RETRY_MAX_MS,
    { min: greenInspectionAutoRetryBaseMs, max: 24 * 60 * 60 * 1000 }
  );
  const greenInspectionAutoLeaseMs = toFiniteInteger(
    process.env.PARK_GREEN_INSPECTION_AUTO_LEASE_MS,
    DEFAULT_GREEN_INSPECTION_AUTO_LEASE_MS,
    { min: 60 * 1000, max: 30 * 60 * 1000 }
  );
  const crowdStorageRetentionDays = toFiniteNumber(
    process.env.PARK_CROWD_STORAGE_RETENTION_DAYS || process.env.PARK_PCM_CROWD_STORAGE_RETENTION_DAYS,
    DEFAULT_CROWD_STORAGE_RETENTION_DAYS,
    { min: 1, max: 90 }
  );
  const crowdStorageMaxBytes = toFiniteInteger(
    process.env.PARK_CROWD_STORAGE_MAX_BYTES || process.env.PARK_PCM_CROWD_STORAGE_MAX_BYTES,
    DEFAULT_CROWD_STORAGE_MAX_BYTES,
    { min: 512 * 1024 * 1024, max: 200 * 1024 * 1024 * 1024 }
  );
  const crowdStorageMinFreeBytes = toFiniteInteger(
    process.env.PARK_CROWD_STORAGE_MIN_FREE_BYTES || process.env.PARK_PCM_CROWD_STORAGE_MIN_FREE_BYTES,
    DEFAULT_CROWD_STORAGE_MIN_FREE_BYTES,
    { min: 256 * 1024 * 1024, max: 200 * 1024 * 1024 * 1024 }
  );
  const crowdStorageCleanupIntervalMs = toFiniteInteger(
    process.env.PARK_CROWD_STORAGE_CLEANUP_INTERVAL_MS || process.env.PARK_PCM_STORAGE_CLEANUP_INTERVAL_MS,
    15 * 60 * 1000,
    { min: 60 * 1000, max: 24 * 60 * 60 * 1000 }
  );
  const crowdStorageCleanupBootDelayMs = toFiniteInteger(
    process.env.PARK_CROWD_STORAGE_CLEANUP_BOOT_DELAY_MS || process.env.PARK_PCM_STORAGE_CLEANUP_BOOT_DELAY_MS,
    5000,
    { min: 1000, max: 60 * 60 * 1000 }
  );
  const patrolFlowUploadMaxBytes = toFiniteInteger(
    process.env.PARK_CROWD_PATROL_FLOW_UPLOAD_MAX_BYTES || process.env.PARK_PCM_PATROL_FLOW_UPLOAD_MAX_BYTES,
    DEFAULT_PATROL_FLOW_UPLOAD_MAX_BYTES,
    { min: 1024 * 1024, max: 2 * 1024 * 1024 * 1024 }
  );
  const patrolFlowMaxFrameRows = toFiniteInteger(
    process.env.PARK_CROWD_PATROL_FLOW_MAX_FRAME_ROWS || process.env.PARK_PCM_PATROL_FLOW_MAX_FRAME_ROWS,
    DEFAULT_PATROL_FLOW_MAX_FRAME_ROWS,
    { min: 1, max: 100000 }
  );
  const patrolFlowUploadToken = String(
    options.patrolFlowUploadToken ||
      process.env.PARK_CROWD_PATROL_FLOW_UPLOAD_TOKEN ||
      process.env.PARK_PCM_PATROL_FLOW_UPLOAD_TOKEN ||
      ''
  ).trim();
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
  let crowdMonitorInFlight = false;
  let crowdAnalysisInFlight = false;
  const greenInspectionInFlight = new Map();
  const greenInspectionQueue = [];
  let greenInspectionActive = 0;
  let greenInspectionWorkerInFlight = false;
  let greenInspectionWorkerCurrentSampleId = '';
  const greenInspectionWorkerOwner = `${process.pid}:${crypto.randomBytes(6).toString('hex')}`;
  let crowdStorageCleanupInFlight = null;
  let crowdStorageStatusCache = null;
  let reportTimer = null;
  let crowdMonitorTimer = null;
  let crowdAnalysisTimer = null;
  let greenInspectionWorkerTimer = null;
  let crowdStorageCleanupTimer = null;

  async function ensureRuntimeDir() {
    await fsp.mkdir(runtimeRoot, { recursive: true });
  }

  async function ensureCrowdRuntimeDirs() {
    await Promise.all([
      ensureRuntimeDir(),
      fsp.mkdir(crowdFramesRoot, { recursive: true }),
      fsp.mkdir(crowdRedactedFramesRoot, { recursive: true }),
      fsp.mkdir(crowdUploadsRoot, { recursive: true })
    ]);
  }

  async function atomicWriteJson(targetPath, payload) {
    await ensureRuntimeDir();
    const tmpPath = `${targetPath}.${process.pid}.tmp`;
    await fsp.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
    await fsp.rename(tmpPath, targetPath);
  }

  async function withJsonFileLock(targetPath, worker) {
    const lockPath = `${targetPath}.lock`;
    const deadlineMs = Date.now() + 120000;
    while (true) {
      try {
        await fsp.mkdir(lockPath);
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') {
          throw error;
        }
        try {
          const stat = await fsp.stat(lockPath);
          if (Date.now() - stat.mtimeMs > 30 * 60 * 1000) {
            await fsp.rmdir(lockPath).catch(() => {});
            continue;
          }
        } catch (_statError) {
          continue;
        }
        if (Date.now() > deadlineMs) {
          throw new Error(`timeout_waiting_json_lock:${path.basename(targetPath)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    try {
      return await worker();
    } finally {
      await fsp.rmdir(lockPath).catch(() => {});
    }
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
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...cloudAgentAuthHeaders
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

  async function getVehicleDetail(vehicleId) {
    return fetchCloudAgentJson(`/api/vehicles/${encodeURIComponent(vehicleId)}`, { timeoutMs: 8000 });
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

  async function classifyCrowdPatrolForVehicle(vehicle, nowMs, timeoutS) {
    const vehicleId = String(vehicle.vehicle_id);
    const planning = await callVehicleTool(vehicleId, 'status.planning', {}, timeoutS);
    const can = await callVehicleTool(vehicleId, 'status.can', {}, timeoutS);
    const toolResults = { planning, can };
    let patrolState = classifyCrowdPatrolCaptureState(vehicle, toolResults, {
      now_ms: nowMs,
      fresh_vehicle_ms: freshVehicleMs
    });

    if (patrolState.state === 'not_patrol') {
      toolResults.routing = await callVehicleTool(vehicleId, 'status.routing', {}, timeoutS);
      patrolState = classifyCrowdPatrolCaptureState(vehicle, toolResults, {
        now_ms: nowMs,
        fresh_vehicle_ms: freshVehicleMs
      });
    }

    return {
      toolResults,
      patrolState
    };
  }

  function crowdRedactedFrameUrl(relativePath) {
    return `/api/park-pcm/crowd/redacted-files/${relativePath
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

  async function readCrowdMonitorState() {
    const parsed = await readJsonFile(crowdMonitorStatePath);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
    return null;
  }

  async function writeCrowdMonitorState(state) {
    await atomicWriteJson(crowdMonitorStatePath, {
      version: 1,
      ...(state || {}),
      updated_at: nowIso()
    });
  }

  async function readCrowdAnalysisState() {
    const parsed = await readJsonFile(crowdAnalysisStatePath);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        version: 1,
        samples: {},
        ...parsed,
        samples: parsed.samples && typeof parsed.samples === 'object' ? parsed.samples : {}
      };
    }
    return {
      version: 1,
      samples: {},
      updated_at: nowIso()
    };
  }

  function crowdAnalysisEntryAggregate(entry) {
    return entry && typeof entry === 'object' && entry.aggregate && typeof entry.aggregate === 'object'
      ? entry.aggregate
      : {};
  }

  function crowdAnalysisHasV3Portrait(entry) {
    const aggregate = crowdAnalysisEntryAggregate(entry);
    return (
      aggregate.feature_schema === CROWD_ANALYSIS_FEATURE_SCHEMA &&
      aggregate.age_stage_groups &&
      typeof aggregate.age_stage_groups === 'object' &&
      aggregate.gender_groups &&
      typeof aggregate.gender_groups === 'object' &&
      aggregate.person_attributes &&
      typeof aggregate.person_attributes === 'object'
    );
  }

  function crowdAnalysisModelName(entry) {
    const aggregate = crowdAnalysisEntryAggregate(entry);
    const serverVlm = aggregate.server_vlm && typeof aggregate.server_vlm === 'object' ? aggregate.server_vlm : null;
    return String(aggregate.model || serverVlm?.model || '');
  }

  function crowdAnalysisPeopleCount(entry) {
    const value = crowdAnalysisEntryAggregate(entry).people_count;
    const count = Number(value);
    return Number.isFinite(count) ? count : null;
  }

  function crowdAnalysisAnalyzedAtMs(entry) {
    const aggregate = crowdAnalysisEntryAggregate(entry);
    const serverVlm = aggregate.server_vlm && typeof aggregate.server_vlm === 'object' ? aggregate.server_vlm : null;
    const value = aggregate.analyzed_at || serverVlm?.analyzed_at || entry?.updated_at || entry?.collected_at || '';
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : 0;
  }

  function crowdAnalysisKnownFeatureCount(entry, key) {
    const mapping = crowdAnalysisEntryAggregate(entry)[key];
    if (!mapping || typeof mapping !== 'object') return 0;
    return Object.entries(mapping).reduce((sum, [itemKey, value]) => {
      const count = Number(value);
      return itemKey !== 'unknown' && Number.isFinite(count) && count > 0 ? sum + count : sum;
    }, 0);
  }

  function crowdAnalysisPortraitQuality(entry) {
    const aggregate = crowdAnalysisEntryAggregate(entry);
    let score = 0;
    if (aggregate.portrait_repaired_at) score += 20;
    if (crowdAnalysisModelName(entry) === 'Qwen3.6-27B-Labeler') score += 40;
    score += Math.min(20, crowdAnalysisKnownFeatureCount(entry, 'age_stage_groups'));
    score += Math.min(20, crowdAnalysisKnownFeatureCount(entry, 'gender_groups'));
    score += Math.min(20, crowdAnalysisKnownFeatureCount(entry, 'person_attributes'));
    return score;
  }

  function preferCrowdAnalysisEntry(existing, incoming) {
    if (!existing) return incoming;
    if (!incoming) return existing;
    const existingV3 = crowdAnalysisHasV3Portrait(existing);
    const incomingV3 = crowdAnalysisHasV3Portrait(incoming);
    if (existingV3 && !incomingV3) return existing;
    if (incomingV3 && !existingV3) return incoming;
    if (existingV3 && incomingV3) {
      const existingModel = crowdAnalysisModelName(existing);
      const incomingModel = crowdAnalysisModelName(incoming);
      const existingIsLabeler = existingModel === 'Qwen3.6-27B-Labeler';
      const incomingIsLabeler = incomingModel === 'Qwen3.6-27B-Labeler';
      if (existingIsLabeler && !incomingIsLabeler) return existing;
      if (incomingIsLabeler && !existingIsLabeler) return incoming;
      const existingQuality = crowdAnalysisPortraitQuality(existing);
      const incomingQuality = crowdAnalysisPortraitQuality(incoming);
      if (existingQuality !== incomingQuality) return existingQuality > incomingQuality ? existing : incoming;
      const existingPeople = crowdAnalysisPeopleCount(existing);
      const incomingPeople = crowdAnalysisPeopleCount(incoming);
      if (existingPeople === 0 && incomingPeople != null && incomingPeople > 0) return incoming;
      if (incomingPeople === 0 && existingPeople != null && existingPeople > 0) return existing;
      return crowdAnalysisAnalyzedAtMs(incoming) >= crowdAnalysisAnalyzedAtMs(existing) ? incoming : existing;
    }
    return crowdAnalysisAnalyzedAtMs(incoming) >= crowdAnalysisAnalyzedAtMs(existing) ? incoming : existing;
  }

  function mergeCrowdAnalysisSamples(latestSamples, incomingSamples) {
    const merged = { ...(latestSamples || {}) };
    Object.entries(incomingSamples || {}).forEach(([sampleId, entry]) => {
      merged[sampleId] = preferCrowdAnalysisEntry(merged[sampleId], entry);
    });
    return merged;
  }

  async function writeCrowdAnalysisState(state) {
    await withJsonFileLock(crowdAnalysisStatePath, async () => {
      const latest = await readCrowdAnalysisState();
      const incomingSamples = state && state.samples && typeof state.samples === 'object' ? state.samples : {};
      const nextSamples = mergeCrowdAnalysisSamples(latest.samples || {}, incomingSamples);
      await atomicWriteJson(crowdAnalysisStatePath, {
        version: 1,
        ...latest,
        ...(state || {}),
        samples: nextSamples,
        updated_at: nowIso()
      });
    });
  }

  async function readGreenInspectionState() {
    const parsed = await readJsonFile(greenInspectionStatePath);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        version: 1,
        schema: GREEN_INSPECTION_SCHEMA,
        samples: {},
        ...parsed,
        samples: parsed.samples && typeof parsed.samples === 'object' ? parsed.samples : {}
      };
    }
    return {
      version: 1,
      schema: GREEN_INSPECTION_SCHEMA,
      samples: {},
      updated_at: nowIso()
    };
  }

  async function writeGreenInspectionState(state) {
    await withJsonFileLock(greenInspectionStatePath, async () => {
      const latest = await readGreenInspectionState();
      const incomingSamples = state && state.samples && typeof state.samples === 'object' ? state.samples : {};
      await atomicWriteJson(greenInspectionStatePath, {
        version: 1,
        schema: GREEN_INSPECTION_SCHEMA,
        ...latest,
        ...(state || {}),
        samples: {
          ...(latest.samples || {}),
          ...incomingSamples
        },
        updated_at: nowIso()
      });
    });
  }

  async function readGreenInspectionWorkerState() {
    const parsed = await readJsonFile(greenInspectionWorkerStatePath);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        version: 1,
        failures: {},
        ...parsed,
        failures: parsed.failures && typeof parsed.failures === 'object' ? parsed.failures : {}
      };
    }
    return {
      version: 1,
      failures: {},
      lease: null,
      updated_at: nowIso()
    };
  }

  async function writeGreenInspectionWorkerState(state) {
    await withJsonFileLock(greenInspectionWorkerStatePath, async () => {
      const latest = await readGreenInspectionWorkerState();
      const failures = state && state.failures && typeof state.failures === 'object'
        ? state.failures
        : latest.failures || {};
      await atomicWriteJson(greenInspectionWorkerStatePath, {
        version: 1,
        ...latest,
        ...(state || {}),
        failures,
        updated_at: nowIso()
      });
    });
  }

  async function claimGreenInspectionWorkerLease() {
    let claimed = false;
    await withJsonFileLock(greenInspectionWorkerStatePath, async () => {
      const latest = await readGreenInspectionWorkerState();
      const now = Date.now();
      const leaseOwner = String(latest.lease?.owner || '');
      const leaseExpiresAt = Date.parse(latest.lease?.expires_at || '');
      if (leaseOwner && leaseOwner !== greenInspectionWorkerOwner && leaseExpiresAt > now) {
        return;
      }
      await atomicWriteJson(greenInspectionWorkerStatePath, {
        ...latest,
        lease: {
          owner: greenInspectionWorkerOwner,
          acquired_at: nowIso(),
          expires_at: new Date(now + greenInspectionAutoLeaseMs).toISOString()
        },
        updated_at: nowIso()
      });
      claimed = true;
    });
    return claimed;
  }

  async function releaseGreenInspectionWorkerLease() {
    await withJsonFileLock(greenInspectionWorkerStatePath, async () => {
      const latest = await readGreenInspectionWorkerState();
      if (String(latest.lease?.owner || '') !== greenInspectionWorkerOwner) return;
      await atomicWriteJson(greenInspectionWorkerStatePath, {
        ...latest,
        lease: null,
        updated_at: nowIso()
      });
    });
  }

  async function readPatrolFlowUploadState() {
    const parsed = await readJsonFile(crowdUploadStatePath);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        version: 1,
        sessions: {},
        ...parsed,
        sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {}
      };
    }
    return {
      version: 1,
      sessions: {},
      updated_at: nowIso()
    };
  }

  async function writePatrolFlowUploadState(state) {
    await atomicWriteJson(crowdUploadStatePath, {
      version: 1,
      sessions: {},
      ...(state || {}),
      updated_at: nowIso()
    });
  }

  async function appendPatrolFlowUploadLog(entry) {
    await ensureCrowdRuntimeDirs();
    await fsp.appendFile(crowdUploadIndexLogPath, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  async function readPatrolFlowUploadLog(limit) {
    const normalizedLimit = toFiniteInteger(limit, 50, { min: 1, max: 500 });
    try {
      const text = await fsp.readFile(crowdUploadIndexLogPath, 'utf8');
      return text
        .split('\n')
        .filter(Boolean)
        .map((line) => safeJsonParse(line, null))
        .filter(Boolean)
        .slice(-normalizedLimit)
        .reverse();
    } catch (_error) {
      return [];
    }
  }

  async function summarizeCrowdSampleIndex() {
    try {
      const text = await fsp.readFile(crowdIndexLogPath, 'utf8');
      const samples = text
        .split('\n')
        .filter(Boolean)
        .map((line) => safeJsonParse(line, null))
        .filter((sample) => sample && !sample.skipped);
      const vehicleIds = new Set();
      const sourceCounts = {};
      const vehicleUploadVehicleIds = new Set();
      let frameCount = 0;
      let totalImageBytes = 0;
      let withPositionCount = 0;
      let vehicleUploadFrameCount = 0;
      let vehicleUploadTotalImageBytes = 0;
      let vehicleUploadWithPositionCount = 0;
      let latestSample = null;
      let latestVehicleUploadSample = null;
      for (const sample of samples) {
        if (sample.vehicle_id) vehicleIds.add(String(sample.vehicle_id));
        const source = String(sample.source || 'cloud_camera_capture');
        const isVehicleUpload = source === VEHICLE_PATROL_FLOW_SAMPLE_SOURCE;
        const sampleFrameCount = Number(sample.frame_count) || 0;
        const sampleImageBytes = Number(sample.total_image_bytes) || 0;
        sourceCounts[source] = (sourceCounts[source] || 0) + 1;
        frameCount += sampleFrameCount;
        totalImageBytes += sampleImageBytes;
        if (isVehicleUpload && sample.vehicle_id) {
          vehicleUploadVehicleIds.add(String(sample.vehicle_id));
          vehicleUploadFrameCount += sampleFrameCount;
          vehicleUploadTotalImageBytes += sampleImageBytes;
        }
        const hasPosition =
          Number.isFinite(Number(sample?.position?.gaode_longitude)) &&
          Number.isFinite(Number(sample?.position?.gaode_latitude));
        if (hasPosition) {
          withPositionCount += 1;
          if (isVehicleUpload) vehicleUploadWithPositionCount += 1;
        }
        const sampleMs = Number(sample.collected_at_ms || Date.parse(sample.collected_at || ''));
        const latestMs = latestSample ? Number(latestSample.collected_at_ms || Date.parse(latestSample.collected_at || '')) : null;
        if (Number.isFinite(sampleMs) && (!Number.isFinite(latestMs) || sampleMs > latestMs)) {
          latestSample = sample;
        }
        const latestUploadMs = latestVehicleUploadSample
          ? Number(latestVehicleUploadSample.collected_at_ms || Date.parse(latestVehicleUploadSample.collected_at || ''))
          : null;
        if (isVehicleUpload && Number.isFinite(sampleMs) && (!Number.isFinite(latestUploadMs) || sampleMs > latestUploadMs)) {
          latestVehicleUploadSample = sample;
        }
      }
      return {
        sample_count: samples.length,
        frame_count: frameCount,
        total_image_bytes: totalImageBytes,
        vehicle_count: vehicleIds.size,
        with_position_count: withPositionCount,
        source_counts: sourceCounts,
        latest_sample: latestSample
          ? {
              sample_id: latestSample.sample_id || null,
              vehicle_id: latestSample.vehicle_id || null,
              source: latestSample.source || 'cloud_camera_capture',
              collected_at: latestSample.collected_at || null,
              frame_count: latestSample.frame_count || 0,
              total_image_bytes: latestSample.total_image_bytes || 0
            }
          : null,
        vehicle_upload: {
          source: VEHICLE_PATROL_FLOW_SAMPLE_SOURCE,
          sample_count: sourceCounts[VEHICLE_PATROL_FLOW_SAMPLE_SOURCE] || 0,
          frame_count: vehicleUploadFrameCount,
          total_image_bytes: vehicleUploadTotalImageBytes,
          vehicle_count: vehicleUploadVehicleIds.size,
          with_position_count: vehicleUploadWithPositionCount,
          latest_sample: latestVehicleUploadSample
            ? {
                sample_id: latestVehicleUploadSample.sample_id || null,
                vehicle_id: latestVehicleUploadSample.vehicle_id || null,
                source: latestVehicleUploadSample.source || null,
                collected_at: latestVehicleUploadSample.collected_at || null,
                frame_count: latestVehicleUploadSample.frame_count || 0,
                total_image_bytes: latestVehicleUploadSample.total_image_bytes || 0
              }
            : null
        }
      };
    } catch (_error) {
      return {
        sample_count: 0,
        frame_count: 0,
        total_image_bytes: 0,
        vehicle_count: 0,
        with_position_count: 0,
        source_counts: {},
        latest_sample: null,
        vehicle_upload: {
          source: VEHICLE_PATROL_FLOW_SAMPLE_SOURCE,
          sample_count: 0,
          frame_count: 0,
          total_image_bytes: 0,
          vehicle_count: 0,
          with_position_count: 0,
          latest_sample: null
        }
      };
    }
  }

  function summarizePatrolFlowUploadState(state, limit) {
    const normalizedLimit = toFiniteInteger(limit, 20, { min: 1, max: 100 });
    const sessions = Object.values(state?.sessions || {});
    const recentSessions = sessions
      .sort((left, right) =>
        Date.parse(right.imported_at || right.received_at || right.failed_at || '') -
        Date.parse(left.imported_at || left.received_at || left.failed_at || '')
      )
      .slice(0, normalizedLimit);
    return {
      updated_at: state?.updated_at || null,
      session_count: sessions.length,
      imported_count: sessions.filter((session) => session.status === 'imported').length,
      failed_count: sessions.filter((session) => session.status === 'failed').length,
      importing_count: sessions.filter((session) => session.status === 'importing').length,
      recent_sessions: recentSessions
    };
  }

  async function buildPatrolFlowUploadStatus(params) {
    const [state, storage, recent_log, sample_index] = await Promise.all([
      readPatrolFlowUploadState(),
      readCachedCrowdStorageStatus(),
      readPatrolFlowUploadLog(params?.log_limit),
      summarizeCrowdSampleIndex()
    ]);
    return {
      ok: true,
      generated_at: nowIso(),
      schema: PATROL_FLOW_SCHEMA_V1,
      upload_endpoint: '/api/auto_ad/patrol-flow/upload',
      status_endpoint: '/api/auto_ad/patrol-flow/status',
      methods: ['POST', 'PUT'],
      content_type: 'application/gzip',
      auth_token_required: Boolean(patrolFlowUploadToken),
      limits: {
        max_upload_bytes: patrolFlowUploadMaxBytes,
        max_frame_rows: patrolFlowMaxFrameRows
      },
      can_accept_upload: storage.can_accept_upload === true,
      storage,
      sample_index,
      state: summarizePatrolFlowUploadState(state, params?.session_limit),
      recent_log
    };
  }

  async function walkFiles(rootPath, relativeBase) {
    const out = [];
    if (!(await pathExists(rootPath))) {
      return out;
    }
    const basePath = path.resolve(relativeBase || rootPath);
    async function walk(currentPath) {
      const entries = await fsp.readdir(currentPath, { withFileTypes: true });
      for (const entry of entries) {
        const absPath = path.join(currentPath, entry.name);
        const stat = await fsp.lstat(absPath);
        if (entry.isDirectory()) {
          await walk(absPath);
        } else if (entry.isFile() || entry.isSymbolicLink()) {
          out.push({
            path: absPath,
            rel_path: path.relative(basePath, absPath).split(path.sep).join('/'),
            size: stat.size,
            mtime_ms: stat.mtimeMs,
            symlink: entry.isSymbolicLink()
          });
        }
      }
    }
    await walk(rootPath);
    return out;
  }

  async function getCrowdDiskFreeBytes() {
    try {
      if (typeof fsp.statfs !== 'function') {
        return null;
      }
      await ensureCrowdRuntimeDirs();
      const stat = await fsp.statfs(runtimeRoot);
      return Number(stat.bavail) * Number(stat.bsize);
    } catch (_error) {
      return null;
    }
  }

  async function removeFileIfExists(targetPath) {
    try {
      await fsp.rm(targetPath, { force: true });
    } catch (_error) {
      // Ignore best-effort cleanup failures.
    }
  }

  async function removeEmptyDirs(rootPath) {
    if (!(await pathExists(rootPath))) {
      return;
    }
    async function walk(currentPath) {
      const entries = await fsp.readdir(currentPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          await walk(path.join(currentPath, entry.name));
        }
      }
      if (currentPath !== rootPath) {
        await fsp.rmdir(currentPath).catch(() => {});
      }
    }
    await walk(rootPath);
  }

  async function performCrowdStorageCleanup() {
    await ensureCrowdRuntimeDirs();
    const startedAt = Date.now();
    const cutoffMs = Date.now() - crowdStorageRetentionDays * 24 * 60 * 60 * 1000;
    const roots = [crowdFramesRoot, crowdRedactedFramesRoot, crowdUploadsRoot];
    let files = [];
    for (const rootPath of roots) {
      files = files.concat(await walkFiles(rootPath, runtimeRoot));
    }

    let deletedExpired = 0;
    for (const file of files) {
      if (file.mtime_ms < cutoffMs) {
        await removeFileIfExists(file.path);
        deletedExpired += 1;
      }
    }

    files = [];
    for (const rootPath of roots) {
      files = files.concat(await walkFiles(rootPath, runtimeRoot));
    }
    let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    let deletedForQuota = 0;

    if (totalBytes > crowdStorageMaxBytes) {
      const targetBytes = Math.floor(crowdStorageMaxBytes * 0.9);
      const ordered = files.slice().sort((left, right) => left.mtime_ms - right.mtime_ms);
      for (const file of ordered) {
        if (totalBytes <= targetBytes) {
          break;
        }
        await removeFileIfExists(file.path);
        totalBytes -= Math.max(0, file.size || 0);
        deletedForQuota += 1;
      }
    }

    await Promise.all(roots.map((rootPath) => removeEmptyDirs(rootPath).catch(() => {})));

    let latestFiles = [];
    for (const rootPath of roots) {
      latestFiles = latestFiles.concat(await walkFiles(rootPath, runtimeRoot));
    }
    const latestTotalBytes = latestFiles.reduce((sum, file) => sum + file.size, 0);
    const diskFreeBytes = await getCrowdDiskFreeBytes();
    return {
      runtime_root: runtimeRoot,
      frames_root: crowdFramesRoot,
      uploads_root: crowdUploadsRoot,
      total_bytes: latestTotalBytes,
      max_storage_bytes: crowdStorageMaxBytes,
      file_count: latestFiles.length,
      image_file_count: latestFiles.filter((file) => /\.(jpe?g|png|webp)$/i.test(file.path)).length,
      retention_days: crowdStorageRetentionDays,
      deleted_expired: deletedExpired,
      deleted_for_quota: deletedForQuota,
      disk_free_bytes: diskFreeBytes,
      min_free_bytes: crowdStorageMinFreeBytes,
      can_accept_upload:
        latestTotalBytes < crowdStorageMaxBytes &&
        (diskFreeBytes == null || diskFreeBytes >= crowdStorageMinFreeBytes),
      elapsed_ms: Date.now() - startedAt
    };
  }

  async function cleanupCrowdStorage() {
    if (crowdStorageCleanupInFlight) {
      return crowdStorageCleanupInFlight;
    }
    crowdStorageCleanupInFlight = performCrowdStorageCleanup().then(async (storage) => {
      const cached = {
        ...storage,
        cache_ready: true,
        cached_at: nowIso()
      };
      crowdStorageStatusCache = cached;
      await atomicWriteJson(crowdStorageStatusPath, cached);
      return cached;
    });
    try {
      return await crowdStorageCleanupInFlight;
    } finally {
      crowdStorageCleanupInFlight = null;
    }
  }

  async function readCachedCrowdStorageStatus() {
    if (!crowdStorageStatusCache) {
      crowdStorageStatusCache = await readJsonFile(crowdStorageStatusPath);
    }
    if (crowdStorageStatusCache) {
      return {
        ...crowdStorageStatusCache,
        cleanup_in_flight: Boolean(crowdStorageCleanupInFlight)
      };
    }
    const diskFreeBytes = await getCrowdDiskFreeBytes();
    return {
      runtime_root: runtimeRoot,
      frames_root: crowdFramesRoot,
      uploads_root: crowdUploadsRoot,
      total_bytes: null,
      max_storage_bytes: crowdStorageMaxBytes,
      file_count: null,
      image_file_count: null,
      retention_days: crowdStorageRetentionDays,
      deleted_expired: 0,
      deleted_for_quota: 0,
      disk_free_bytes: diskFreeBytes,
      min_free_bytes: crowdStorageMinFreeBytes,
      can_accept_upload: diskFreeBytes == null || diskFreeBytes >= crowdStorageMinFreeBytes,
      elapsed_ms: 0,
      cache_ready: false,
      cached_at: null,
      cleanup_in_flight: Boolean(crowdStorageCleanupInFlight)
    };
  }

  function timingSafeEqualText(left, right) {
    const leftBuffer = Buffer.from(String(left || ''));
    const rightBuffer = Buffer.from(String(right || ''));
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
  }

  function requirePatrolFlowUploadAuth(req, res, next) {
    if (!patrolFlowUploadToken) {
      return next();
    }
    const bearer = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    const supplied = String(
      req.headers['x-auto-ad-upload-token'] ||
        req.headers['x-patrol-flow-upload-token'] ||
        (bearer ? bearer[1] : '') ||
        ''
    ).trim();
    if (!supplied || !timingSafeEqualText(supplied, patrolFlowUploadToken)) {
      return res.status(401).json({
        ok: false,
        error: 'patrol_flow_upload_unauthorized'
      });
    }
    return next();
  }

  function validatePatrolFlowUploadHeaders(req) {
    const schema = String(req.headers['x-auto-ad-capture-schema'] || '').trim();
    if (schema !== PATROL_FLOW_SCHEMA_V1) {
      const error = new Error('unsupported_patrol_flow_schema');
      error.status = 400;
      error.detail = `expected ${PATROL_FLOW_SCHEMA_V1}`;
      throw error;
    }

    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType && !['application/gzip', 'application/x-gzip', 'application/octet-stream', 'binary/octet-stream'].includes(contentType)) {
      const error = new Error('patrol_flow_upload_content_type_required');
      error.status = 415;
      throw error;
    }

    const rawSessionId = String(req.headers['x-auto-ad-session-id'] || '').trim();
    const sessionId = sanitizeName(rawSessionId, '');
    if (!sessionId) {
      const error = new Error('patrol_flow_session_id_required');
      error.status = 400;
      throw error;
    }

    const sizeHeader = Number(req.headers['x-auto-ad-file-size'] || req.headers['content-length'] || 0);
    const expectedSize = Number.isFinite(sizeHeader) && sizeHeader > 0 ? Math.round(sizeHeader) : null;
    if (expectedSize != null && expectedSize > patrolFlowUploadMaxBytes) {
      const error = new Error('patrol_flow_upload_too_large');
      error.status = 413;
      throw error;
    }

    const expectedSha256 = String(req.headers['x-auto-ad-file-sha256'] || '').trim().toLowerCase();
    if (expectedSha256 && !/^[a-f0-9]{64}$/.test(expectedSha256)) {
      const error = new Error('patrol_flow_sha256_invalid');
      error.status = 400;
      throw error;
    }

    return {
      schema,
      raw_session_id: rawSessionId,
      session_id: sessionId,
      expected_size_bytes: expectedSize,
      expected_sha256: expectedSha256 || null,
      content_type: contentType || null
    };
  }

  async function assertPatrolFlowStorageCanAccept(expectedSizeBytes) {
    const storage = await cleanupCrowdStorage();
    const expectedSize = Number(expectedSizeBytes) || 0;
    const projectedTotalBytes = storage.total_bytes + expectedSize;
    const projectedFreeBytes = storage.disk_free_bytes == null ? null : storage.disk_free_bytes - expectedSize;
    if (
      projectedTotalBytes > crowdStorageMaxBytes ||
      (projectedFreeBytes != null && projectedFreeBytes < crowdStorageMinFreeBytes)
    ) {
      const error = new Error('patrol_flow_storage_limit_reached');
      error.status = 507;
      error.storage = {
        ...storage,
        projected_total_bytes: projectedTotalBytes,
        projected_disk_free_bytes: projectedFreeBytes
      };
      throw error;
    }
    return storage;
  }

  async function receivePatrolFlowUpload(req, targetPath, expectedSizeBytes) {
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    const partPath = `${targetPath}.part`;
    await fsp.rm(partPath, { force: true });

    return new Promise((resolve, reject) => {
      let receivedBytes = 0;
      let settled = false;
      const hash = crypto.createHash('sha256');
      const writeStream = fs.createWriteStream(partPath, { flags: 'w' });

      const finishWithError = (error) => {
        if (settled) return;
        settled = true;
        writeStream.destroy();
        void fsp.rm(partPath, { force: true }).finally(() => reject(error));
      };

      req.on('data', (chunk) => {
        receivedBytes += chunk.length;
        hash.update(chunk);
        if (receivedBytes > patrolFlowUploadMaxBytes) {
          const error = new Error('patrol_flow_upload_too_large');
          error.status = 413;
          finishWithError(error);
          req.destroy();
        }
      });
      req.on('aborted', () => {
        const error = new Error('patrol_flow_upload_aborted');
        error.status = 499;
        finishWithError(error);
      });
      req.on('error', (error) => {
        const nextError = new Error(error?.message || 'patrol_flow_upload_failed');
        nextError.status = error?.status || 500;
        finishWithError(nextError);
      });
      writeStream.on('error', (error) => {
        const nextError = new Error(error?.message || 'patrol_flow_file_write_failed');
        nextError.status = 500;
        finishWithError(nextError);
      });
      writeStream.on('finish', async () => {
        if (settled) return;
        settled = true;
        try {
          if (expectedSizeBytes != null && receivedBytes !== expectedSizeBytes) {
            const error = new Error('patrol_flow_upload_size_mismatch');
            error.status = 400;
            error.expected_size_bytes = expectedSizeBytes;
            error.received_size_bytes = receivedBytes;
            throw error;
          }
          await fsp.rename(partPath, targetPath);
          resolve({
            path: targetPath,
            size_bytes: receivedBytes,
            sha256: hash.digest('hex')
          });
        } catch (error) {
          await fsp.rm(partPath, { force: true }).catch(() => {});
          await fsp.rm(targetPath, { force: true }).catch(() => {});
          reject(error);
        }
      });

      req.pipe(writeStream);
    });
  }

  function validateTarEntryName(name) {
    const normalized = String(name || '').replace(/\\/g, '/');
    if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
      return false;
    }
    return !normalized.split('/').some((segment) => segment === '..');
  }

  async function validatePatrolFlowTarball(packagePath) {
    const [plainList, verboseList] = await Promise.all([
      execFileAsync('tar', ['-tzf', packagePath], {
        timeout: 60000,
        maxBuffer: 20 * 1024 * 1024
      }),
      execFileAsync('tar', ['-tvzf', packagePath], {
        timeout: 60000,
        maxBuffer: 20 * 1024 * 1024
      })
    ]);
    const { stdout } = plainList;
    const linkLine = String(verboseList.stdout || '')
      .split('\n')
      .find((line) => /^[lh]/.test(line.trim()));
    if (linkLine) {
      const error = new Error('patrol_flow_package_link_not_allowed');
      error.status = 400;
      error.invalid_path = linkLine.trim().slice(0, 240);
      throw error;
    }
    const deviceLine = String(verboseList.stdout || '')
      .split('\n')
      .find((line) => /^[bcps]/.test(line.trim()));
    if (deviceLine) {
      const error = new Error('patrol_flow_package_special_file_not_allowed');
      error.status = 400;
      error.invalid_path = deviceLine.trim().slice(0, 240);
      throw error;
    }
    const entries = String(stdout || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (!entries.length) {
      const error = new Error('patrol_flow_package_empty');
      error.status = 400;
      throw error;
    }
    if (entries.length > 20000) {
      const error = new Error('patrol_flow_package_too_many_entries');
      error.status = 400;
      throw error;
    }
    const invalid = entries.find((entry) => !validateTarEntryName(entry));
    if (invalid) {
      const error = new Error('patrol_flow_package_invalid_path');
      error.status = 400;
      error.invalid_path = invalid;
      throw error;
    }
    return entries;
  }

  async function extractPatrolFlowTarball(packagePath, stagingDir) {
    await validatePatrolFlowTarball(packagePath);
    await fsp.rm(stagingDir, { recursive: true, force: true });
    await fsp.mkdir(stagingDir, { recursive: true });
    await execFileAsync('tar', ['--no-same-owner', '--no-same-permissions', '-xzf', packagePath, '-C', stagingDir], {
      timeout: 120000,
      maxBuffer: 1024 * 1024
    });
    const files = await walkFiles(stagingDir, stagingDir);
    const symlink = files.find((file) => file.symlink);
    if (symlink) {
      const error = new Error('patrol_flow_package_symlink_not_allowed');
      error.status = 400;
      error.invalid_path = symlink.rel_path;
      throw error;
    }
    return files;
  }

  function shortestNamedFile(files, name) {
    const normalizedName = String(name || '').toLowerCase();
    return files
      .filter((file) => path.basename(file.path).toLowerCase() === normalizedName)
      .sort((left, right) => left.rel_path.length - right.rel_path.length)[0] || null;
  }

  async function readJsonLimited(filePath, maxBytes) {
    const stat = await fsp.stat(filePath);
    if (stat.size > maxBytes) {
      const error = new Error('patrol_flow_json_too_large');
      error.status = 400;
      throw error;
    }
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  }

  async function readFramesJsonl(filePath) {
    const stat = await fsp.stat(filePath);
    if (stat.size > 128 * 1024 * 1024) {
      const error = new Error('patrol_flow_frames_jsonl_too_large');
      error.status = 400;
      throw error;
    }
    const rows = [];
    const text = await fsp.readFile(filePath, 'utf8');
    const lines = text.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (rows.length >= patrolFlowMaxFrameRows) {
        const error = new Error('patrol_flow_frame_row_limit_reached');
        error.status = 413;
        throw error;
      }
      rows.push(JSON.parse(trimmed));
    }
    return rows;
  }

  function resolveExtractedFile(stagingDir, baseDir, relativePath) {
    const rel = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel || rel.split('/').some((segment) => segment === '..')) {
      return null;
    }
    const relCandidates = [rel];
    const imageSegmentIndex = rel.indexOf('/images/');
    if (imageSegmentIndex >= 0) {
      relCandidates.push(rel.slice(imageSegmentIndex + 1));
    }
    const rootPath = path.resolve(stagingDir);
    const candidates = relCandidates.flatMap((candidateRel) => [
      path.resolve(stagingDir, candidateRel),
      path.resolve(baseDir, candidateRel)
    ]);
    for (const candidate of candidates) {
      if (candidate === rootPath || !candidate.startsWith(`${rootPath}${path.sep}`)) {
        continue;
      }
      if (fs.existsSync(candidate) && fs.lstatSync(candidate).isFile()) {
        return candidate;
      }
    }
    return null;
  }

  function extractFrameImagePath(row) {
    return firstNonEmpty([
      row?.image_path,
      row?.image_rel_path,
      row?.image_relative_path,
      row?.relative_path,
      row?.image?.relative_path,
      row?.image?.rel_path,
      row?.image?.filename,
      row?.file_path,
      row?.path,
      row?.file,
      row?.image?.path,
      row?.image?.file,
    ]);
  }

  function extractFrameCamera(row, fallbackIndex) {
    return sanitizeName(
      firstNonEmpty([
        row?.camera,
        row?.camera_id,
        row?.camera_name,
        row?.image?.camera,
        row?.image?.camera_id,
        row?.topic
      ]) || `camera${fallbackIndex + 1}`,
      `camera${fallbackIndex + 1}`
    );
  }

  function extractManifestPlateNumber(manifest) {
    const vehicle = objectValue(manifest?.vehicle);
    const license = objectValue(vehicle.license || manifest?.license);
    const rawLicense = typeof license.raw === 'string' ? safeJsonParse(license.raw, null) : null;
    return firstNonEmpty([
      manifest?.vehicle_id,
      manifest?.vehicle_code,
      manifest?.plateNumber,
      manifest?.plate_number,
      vehicle.vehicle_id,
      vehicle.vehicle_code,
      vehicle.plateNumber,
      vehicle.plate_number,
      license.plateNumber,
      license.plate_number,
      rawLicense?.plateNumber,
      rawLicense?.plate_number
    ]);
  }

  function extractFrameVehicleId(row, manifest) {
    return sanitizeName(
      firstNonEmpty([
        row?.vehicle_id,
        row?.vehicle,
        row?.vehicle_code,
        extractManifestPlateNumber(manifest),
        manifest?.robot_id,
        manifest?.car_id
      ]) || 'vehicle',
      'vehicle'
    );
  }

  function extractFrameTsMs(row, fallbackMs) {
    return (
      timestampMsFromValue(row?.ts) ??
      timestampMsFromValue(row?.timestamp) ??
      timestampMsFromValue(row?.collected_at) ??
      timestampMsFromValue(row?.capture_time) ??
      timestampMsFromValue(row?.time) ??
      timestampMsFromValue(row?.saved_at) ??
      timestampMsFromValue(row?.header?.stamp) ??
      timestampMsFromValue(row?.image?.ts) ??
      timestampMsFromValue(row?.image?.ts_iso) ??
      timestampMsFromValue(row?.image?.ts_unix) ??
      timestampMsFromValue(row?.image?.header?.stamp) ??
      fallbackMs
    );
  }

  function extractFrameIndex(row, fallbackIndex) {
    const index = firstFiniteNumber([
      row?.index,
      row?.frame_index,
      row?.capture_index,
      row?.sample_index,
      row?.image?.index
    ]);
    return index == null ? fallbackIndex : index;
  }

  function extractFramePosition(row) {
    const localization = objectValue(row?.localization || row?.location || row?.pose || row?.gps || row?.position);
    const routeLocation = objectValue(row?.route_location || row?.route?.route_location);
    const latitude = firstFiniteNumber([
      row?.latitude,
      row?.lat,
      row?.Lattitude,
      localization.latitude,
      localization.lat,
      localization.Lattitude,
      routeLocation.latitude,
      routeLocation.lat,
      routeLocation.Lattitude
    ]);
    const longitude = firstFiniteNumber([
      row?.longitude,
      row?.lng,
      row?.lon,
      row?.Longitude,
      localization.longitude,
      localization.lng,
      localization.lon,
      localization.Longitude,
      routeLocation.longitude,
      routeLocation.lng,
      routeLocation.lon,
      routeLocation.Longitude
    ]);
    const suppliedGaodeLat = firstFiniteNumber([
      row?.gaode_latitude,
      row?.gcj02_latitude,
      localization.gaode_latitude,
      localization.gcj02_latitude
    ]);
    const suppliedGaodeLng = firstFiniteNumber([
      row?.gaode_longitude,
      row?.gcj02_longitude,
      localization.gaode_longitude,
      localization.gcj02_longitude
    ]);
    const gcj = suppliedGaodeLat != null && suppliedGaodeLng != null
      ? { latitude: suppliedGaodeLat, longitude: suppliedGaodeLng }
      : latitude != null && longitude != null
        ? wgs84ToGcj02(latitude, longitude)
        : { latitude: null, longitude: null };
    return {
      source: 'auto_ad_patrol_flow_upload',
      reliable: latitude != null && longitude != null,
      latitude,
      longitude,
      gaode_latitude: Number.isFinite(gcj.latitude) ? gcj.latitude : null,
      gaode_longitude: Number.isFinite(gcj.longitude) ? gcj.longitude : null,
      heading: firstFiniteNumber([row?.heading, localization.heading, localization.yaw]),
      speed_mps: firstFiniteNumber([row?.speed_mps, localization.speed_mps, localization.speed]),
      raw_health: localization.health || row?.localization_health || null
    };
  }

  function extractFramePlanning(row) {
    return objectValue(row?.planning || row?.planning_status || row?.planner || row?.patrol?.planning || row?.status?.planning);
  }

  function extractFrameRoute(row) {
    const patrol = objectValue(row?.patrol);
    const route = objectValue(row?.route);
    const routeIds = Array.isArray(patrol.route_ids)
      ? patrol.route_ids.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    return {
      route_id: firstNonEmpty([row?.route_id, route.route_id, route.id, route.name, routeIds[0]]),
      route_ids: routeIds,
      route_location: row?.route_location || route.route_location || route.location || patrol.route_location || null,
      route_progress: row?.route_progress || route.route_progress || route.progress || null
    };
  }

  function extractFramePerception(row) {
    return objectValue(row?.perception || row?.perception_stats || row?.targets || row?.status?.perception);
  }

  function extractFramePeopleCount(row, perception) {
    return firstFiniteNumber([
      row?.people_count,
      row?.person_count,
      row?.crowd_people,
      row?.crowd_count,
      perception?.people_count,
      perception?.person_count,
      perception?.crowd_people,
      perception?.crowd_count,
      perception?.summary?.people_count,
      perception?.summary?.person_count,
      perception?.summary?.crowd_people,
      perception?.summary?.crowd_count
    ]);
  }

  function extractFrameTargetCount(row, perception) {
    return firstFiniteNumber([
      row?.target_count,
      row?.object_count,
      perception?.target_count,
      perception?.object_count,
      perception?.summary?.target_count,
      perception?.summary?.object_count
    ]);
  }

  function buildUploadedPatrolState(frameRows) {
    const rows = Array.isArray(frameRows) ? frameRows : [];
    const planningRows = rows.map((row) => extractFramePlanning(row)).filter((item) => item && Object.keys(item).length);
    const routeRows = rows.map((row) => extractFrameRoute(row)).filter((item) => item.route_id || item.route_location || item.route_ids?.length);
    const plannerRunning = firstFiniteNumber(planningRows.map((item) => item.planner_running));
    const vehicleIdleStatus = firstFiniteNumber(planningRows.map((item) => item.vehicle_idle_status));
    const longTimeStop = planningRows.some((item) => booleanValue(item.long_time_stop) === true);
    const routeIds = [...new Set(routeRows.flatMap((item) => [item.route_id, ...(item.route_ids || [])]).map((item) => String(item || '').trim()).filter(Boolean))];
    const state = plannerRunning != null && plannerRunning > 0
      ? 'patrol_active_moving'
      : 'patrol_task_stopped_or_waiting';
    return {
      state,
      capture_eligible: true,
      confidence: 'high',
      reasons: [
        'vehicle_side_collector',
        ...routeIds.slice(0, 3).map((routeId) => `route_id=${routeId}`),
        plannerRunning != null ? `planner_running=${plannerRunning}` : null,
        vehicleIdleStatus != null ? `vehicle_idle_status=${vehicleIdleStatus}` : null,
        longTimeStop ? 'long_time_stop=true' : null
      ].filter(Boolean).slice(0, 12),
      tool_ok: {
        vehicle_upload: true,
        planning: planningRows.length > 0,
        routing: routeRows.length > 0,
        can: null
      },
      tool_elapsed_ms: {},
      fields: {
        planner_running: plannerRunning,
        vehicle_idle_status: vehicleIdleStatus,
        long_time_stop: longTimeStop || null,
        route_ids: routeIds,
        route_task_evidence: true,
        vehicle_side_uploaded: true
      }
    };
  }

  function groupPatrolFlowFrames(rows, manifest, fallbackMs) {
    const groups = new Map();
    rows.forEach((row, rowIndex) => {
      const frameIndex = extractFrameIndex(row, rowIndex);
      const tsMs = extractFrameTsMs(row, fallbackMs);
      const explicitGroupId = firstNonEmpty([
        row?.sample_id,
        row?.frame_group_id,
        row?.capture_group_id,
        row?.group_id
      ]);
      const groupId = explicitGroupId ||
        `batch_${Math.floor(Math.max(0, Number(frameIndex) || rowIndex) / 4)}`;
      const key = String(groupId);
      const current = groups.get(key) || {
        key,
        frame_index: frameIndex,
        ts_ms: tsMs,
        rows: []
      };
      current.ts_ms = Math.min(current.ts_ms || tsMs, tsMs || current.ts_ms || fallbackMs);
      current.rows.push({
        row,
        row_index: rowIndex,
        frame_index: frameIndex,
        ts_ms: tsMs,
        vehicle_id: extractFrameVehicleId(row, manifest),
        camera_id: extractFrameCamera(row, rowIndex),
        image_path: extractFrameImagePath(row)
      });
      groups.set(key, current);
    });
    return [...groups.values()].sort((left, right) => (left.ts_ms || 0) - (right.ts_ms || 0));
  }

  function samplePositionFromGroup(group) {
    for (const item of group.rows) {
      const position = extractFramePosition(item.row);
      if (position.reliable && Number.isFinite(position.gaode_latitude) && Number.isFinite(position.gaode_longitude)) {
        return position;
      }
    }
    return group.rows.length ? extractFramePosition(group.rows[0].row) : null;
  }

  function normalizedManifestSessionId(manifest) {
    return sanitizeName(
      firstNonEmpty([
        manifest?.session_id,
        manifest?.capture_session_id,
        manifest?.flow_session_id,
        manifest?.id
      ]) || '',
      ''
    );
  }

  async function copyPatrolFlowSessionMetadata(stagingDir, files, manifestPath, framesPath, sessionId) {
    const sessionRoot = path.join(crowdUploadsRoot, 'sessions', sessionId);
    await fsp.rm(sessionRoot, { recursive: true, force: true });
    await fsp.mkdir(sessionRoot, { recursive: true });
    await fsp.copyFile(manifestPath, path.join(sessionRoot, 'manifest.json'));
    await fsp.copyFile(framesPath, path.join(sessionRoot, 'frames.jsonl'));

    const routeDirs = [...new Set(
      files
        .filter((file) => file.rel_path.split('/').includes('routes'))
        .map((file) => {
          const parts = file.rel_path.split('/');
          const index = parts.indexOf('routes');
          return path.join(stagingDir, ...parts.slice(0, index + 1));
        })
    )];
    if (routeDirs.length) {
      await fsp.cp(routeDirs[0], path.join(sessionRoot, 'routes'), { recursive: true, force: true });
    }
    return sessionRoot;
  }

  async function saveUploadedPatrolFlowFrame(item, context) {
    const imageAbsPath = resolveExtractedFile(context.staging_dir, context.frames_dir, item.image_path);
    if (!imageAbsPath) {
      return {
        ok: false,
        skipped: true,
        error: 'image_file_not_found',
        source_image_path: item.image_path || null,
        camera_id: item.camera_id
      };
    }
    const collectedAt = new Date(item.ts_ms || context.collected_at_ms || Date.now());
    const day = dateStampCompact(collectedAt);
    const vehicleId = sanitizeName(item.vehicle_id || context.vehicle_id, 'vehicle');
    const cameraId = sanitizeName(item.camera_id, 'camera');
    const sampleId = sanitizeName(context.sample_id, 'sample');
    const ext = mimeToExt(imageMimeFromFilePath(imageAbsPath));
    const frameDir = path.join(crowdFramesRoot, day, context.session_id);
    await fsp.mkdir(frameDir, { recursive: true });
    const captureId = sanitizeName(`${sampleId}_${cameraId}_${item.row_index}`, 'capture');
    const destImagePath = path.join(frameDir, `${captureId}${ext}`);
    const destMetaPath = path.join(frameDir, `${captureId}.json`);
    await fsp.copyFile(imageAbsPath, destImagePath);
    const stat = await fsp.stat(destImagePath);
    const imageRelPath = path.relative(crowdFramesRoot, destImagePath).split(path.sep).join('/');
    const position = extractFramePosition(item.row);
    const route = extractFrameRoute(item.row);
    const planning = extractFramePlanning(item.row);
    const perception = extractFramePerception(item.row);
    const peopleCount = extractFramePeopleCount(item.row, perception);
    const targetCount = extractFrameTargetCount(item.row, perception);
    const analysis = peopleCount == null
      ? {
          status: 'pending',
          people_count: null,
          confidence: 'low',
          note: '等待云端视觉模型识别。'
        }
      : {
          status: 'vehicle_estimate',
          people_count: Math.max(0, Math.round(peopleCount)),
          confidence: 'medium',
          note: '车端 perception 初始统计，待云端视觉模型复核。',
          model: 'vehicle_perception_upload',
          analyzed_at: nowIso()
        };
    const meta = {
      capture_id: captureId,
      sample_id: context.sample_id,
      upload_session_id: context.session_id,
      source: 'auto_ad_patrol_flow_upload',
      collected_at: collectedAt.toISOString(),
      collected_at_ms: collectedAt.getTime(),
      vehicle_id: vehicleId,
      camera_id: cameraId,
      frame_index: item.frame_index,
      row_index: item.row_index,
      image_mime_type: imageMimeFromFilePath(imageAbsPath),
      image_size_bytes: stat.size,
      image_sha256: crypto.createHash('sha256').update(await fsp.readFile(destImagePath)).digest('hex'),
      image_path: imageRelPath,
      image_url: crowdRedactedFrameUrl(imageRelPath),
      source_image_path: item.image_path || null,
      position,
      route,
      planning,
      perception,
      target_count: targetCount,
      analysis,
      business: {
        kind: 'park_people_flow_vehicle_upload',
        note: 'vehicle-side patrol image package for crowd analytics and ad traffic planning'
      }
    };
    await fsp.writeFile(destMetaPath, JSON.stringify(meta, null, 2), 'utf8');
    return meta;
  }

  async function importPatrolFlowPackage(packagePath, headersInfo) {
    const startedAt = Date.now();
    const sessionId = headersInfo.session_id;
    const stagingDir = path.join(
      crowdUploadsRoot,
      'staging',
      `${sessionId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
    );
    let packageKeptPath = null;
    try {
      const files = await extractPatrolFlowTarball(packagePath, stagingDir);
      const manifestFile = shortestNamedFile(files, 'manifest.json');
      const framesFile = shortestNamedFile(files, 'frames.jsonl');
      if (!manifestFile || !framesFile) {
        const error = new Error(!manifestFile ? 'patrol_flow_manifest_missing' : 'patrol_flow_frames_missing');
        error.status = 400;
        throw error;
      }

      const manifest = await readJsonLimited(manifestFile.path, 2 * 1024 * 1024);
      const manifestSessionId = normalizedManifestSessionId(manifest);
      if (manifestSessionId && manifestSessionId !== sessionId) {
        const error = new Error('patrol_flow_session_id_mismatch');
        error.status = 400;
        error.manifest_session_id = manifestSessionId;
        error.header_session_id = sessionId;
        throw error;
      }

      const frameRows = await readFramesJsonl(framesFile.path);
      if (!frameRows.length) {
        const error = new Error('patrol_flow_frames_empty');
        error.status = 400;
        throw error;
      }

      const sessionMetaRoot = await copyPatrolFlowSessionMetadata(stagingDir, files, manifestFile.path, framesFile.path, sessionId);
      const fallbackMs =
        timestampMsFromValue(manifest?.started_at) ??
        timestampMsFromValue(manifest?.created_at) ??
        Date.now();
      const groups = groupPatrolFlowFrames(frameRows, manifest, fallbackMs);
      const samples = [];
      const skippedFrames = [];
      const framesDir = path.dirname(framesFile.path);

      for (const group of groups) {
        const firstRow = group.rows[0];
        const vehicleId = firstRow?.vehicle_id || extractFrameVehicleId(firstRow?.row, manifest);
        const collectedAtMs = group.ts_ms || fallbackMs;
        const collectedAt = new Date(collectedAtMs);
        const sampleId = sanitizeName(
          `${timeStampCompact(collectedAt)}_${vehicleId}_${sessionId}_${group.key}`,
          `${sessionId}_${group.key}`
        );
        const context = {
          session_id: sessionId,
          sample_id: sampleId,
          vehicle_id: vehicleId,
          collected_at_ms: collectedAtMs,
          staging_dir: stagingDir,
          frames_dir: framesDir
        };
        const savedFrames = [];
        for (const item of group.rows) {
          const saved = await saveUploadedPatrolFlowFrame(item, context);
          if (saved.ok === false || saved.skipped) {
            skippedFrames.push({
              sample_id: sampleId,
              frame_index: item.frame_index,
              row_index: item.row_index,
              camera_id: item.camera_id,
              error: saved.error || 'frame_skipped',
              source_image_path: saved.source_image_path || null
            });
          } else {
            savedFrames.push(saved);
          }
        }
        if (!savedFrames.length) {
          continue;
        }
        const position = samplePositionFromGroup(group);
        const patrolState = buildUploadedPatrolState(group.rows.map((item) => item.row));
        const peopleCounts = savedFrames
          .map((frame) => normalizePeopleCount(frame.analysis?.people_count))
          .filter((value) => value != null);
        const samplePeopleCount = peopleCounts.length ? peopleCounts.reduce((sum, value) => sum + value, 0) : null;
        const routeIds = [...new Set(
          savedFrames
            .flatMap((frame) => [frame.route?.route_id, ...(frame.route?.route_ids || [])])
            .map((routeId) => String(routeId || '').trim())
            .filter(Boolean)
        )];
        const sample = {
          sample_id: sampleId,
          source: 'auto_ad_patrol_flow_upload',
          upload_session_id: sessionId,
          ok: true,
          skipped: false,
          collected_at: collectedAt.toISOString(),
          collected_at_ms: collectedAt.getTime(),
          elapsed_ms: null,
          vehicle_id: vehicleId,
          vehicle_last_seen: null,
          patrol_state: patrolState,
          position,
          route: {
            route_ids: routeIds,
            primary_route_id: routeIds[0] || null
          },
          capture_policy: manifest?.capture_policy || manifest?.policy || manifest?.collection_policy || null,
          upload_manifest: {
            schema: manifest?.schema || headersInfo.schema,
            session_id: manifestSessionId || sessionId,
            started_at: manifest?.started_at || null,
            finished_at: manifest?.finished_at || null,
            route_id: manifest?.route_id || null,
            strategy: manifest?.strategy || manifest?.capture_strategy || null
          },
          frame_count: savedFrames.length,
          total_image_bytes: savedFrames.reduce((sum, frame) => sum + (frame.image_size_bytes || 0), 0),
          response_elapsed_ms: null,
          analysis: samplePeopleCount == null
            ? {
                status: 'pending',
                people_count: null,
                note: '等待云端视觉模型识别。'
              }
            : {
                status: 'vehicle_estimate',
                people_count: samplePeopleCount,
                max_single_camera_people: Math.max(...peopleCounts),
                frame_count_analyzed: peopleCounts.length,
                model: 'vehicle_perception_upload',
                analyzed_at: nowIso(),
                note: 'people_count 来自车端 perception 初始统计，后续由云端视觉模型复核。'
              },
          frames: savedFrames.map((frame) => ({
            capture_id: frame.capture_id,
            camera_id: frame.camera_id,
            frame_index: frame.frame_index,
            row_index: frame.row_index,
            image_size_bytes: frame.image_size_bytes,
            image_width: frame.image_width || null,
            image_height: frame.image_height || null,
            image_url: frame.image_url,
            image_path: frame.image_path,
            route: frame.route,
            target_count: frame.target_count,
            analysis: frame.analysis
          }))
        };
        await appendCrowdSampleLog(sample);
        samples.push(sample);
      }

      const vehicleIds = [...new Set(samples.map((sample) => sample.vehicle_id).filter(Boolean))];
      const latestByVehicle = new Map();
      for (const sample of samples) {
        const current = latestByVehicle.get(sample.vehicle_id);
        if (!current || (sample.collected_at_ms || 0) > (current.collected_at_ms || 0)) {
          latestByVehicle.set(sample.vehicle_id, sample);
        }
      }
      if (latestByVehicle.size) {
        const crowdState = await readCrowdState();
        for (const [vehicleId, sample] of latestByVehicle.entries()) {
          crowdState.last_capture_by_vehicle[vehicleId] = {
            sample_id: sample.sample_id,
            collected_at: sample.collected_at,
            collected_at_ms: sample.collected_at_ms,
            position: sample.position,
            patrol_state: sample.patrol_state,
            frame_count: sample.frame_count,
            total_image_bytes: sample.total_image_bytes,
            source: sample.source,
            upload_session_id: sessionId
          };
        }
        await writeCrowdState(crowdState);
      }

      if (String(process.env.PARK_CROWD_PATROL_FLOW_KEEP_PACKAGES || process.env.PARK_PCM_PATROL_FLOW_KEEP_PACKAGES || 'false').toLowerCase() !== 'false') {
        packageKeptPath = path.join(crowdUploadsRoot, 'packages', `${sessionId}.tar.gz`);
        await fsp.mkdir(path.dirname(packageKeptPath), { recursive: true });
        await fsp.rename(packagePath, packageKeptPath);
      } else {
        await fsp.rm(packagePath, { force: true });
      }

      const storage = await cleanupCrowdStorage();
      return {
        ok: true,
        imported: true,
        schema: headersInfo.schema,
        session_id: sessionId,
        vehicle_ids: vehicleIds,
        sample_count: samples.length,
        frame_count: samples.reduce((sum, sample) => sum + (sample.frame_count || 0), 0),
        skipped_frame_count: skippedFrames.length,
        skipped_frames: skippedFrames.slice(0, 20),
        manifest: {
          session_id: manifestSessionId || sessionId,
          vehicle_id: extractFrameVehicleId(frameRows[0], manifest),
          route_id: manifest?.route_id || null,
          started_at: manifest?.started_at || null,
          finished_at: manifest?.finished_at || null
        },
        metadata_root: sessionMetaRoot,
        package_kept_path: packageKeptPath,
        storage,
        elapsed_ms: Date.now() - startedAt
      };
    } finally {
      await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function handlePatrolFlowUpload(req, res) {
    const startedAt = Date.now();
    let headersInfo = null;
    let packagePath = null;
    try {
      headersInfo = validatePatrolFlowUploadHeaders(req);
      const state = await readPatrolFlowUploadState();
      const existing = state.sessions[headersInfo.session_id];
      if (existing?.status === 'imported') {
        return res.json({
          ok: true,
          duplicate: true,
          imported: false,
          session_id: headersInfo.session_id,
          existing
        });
      }

      const storageBefore = await assertPatrolFlowStorageCanAccept(headersInfo.expected_size_bytes);
      const incomingDir = path.join(crowdUploadsRoot, 'incoming');
      packagePath = path.join(
        incomingDir,
        `${headersInfo.session_id}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.tar.gz`
      );
      const uploadInfo = await receivePatrolFlowUpload(req, packagePath, headersInfo.expected_size_bytes);
      if (headersInfo.expected_sha256 && uploadInfo.sha256 !== headersInfo.expected_sha256) {
        const error = new Error('patrol_flow_upload_sha256_mismatch');
        error.status = 400;
        error.expected_sha256 = headersInfo.expected_sha256;
        error.actual_sha256 = uploadInfo.sha256;
        throw error;
      }

      state.sessions[headersInfo.session_id] = {
        status: 'importing',
        session_id: headersInfo.session_id,
        schema: headersInfo.schema,
        received_at: nowIso(),
        size_bytes: uploadInfo.size_bytes,
        sha256: uploadInfo.sha256
      };
      await writePatrolFlowUploadState(state);

      const imported = await importPatrolFlowPackage(packagePath, headersInfo);
      packagePath = null;
      const nextState = await readPatrolFlowUploadState();
      nextState.sessions[headersInfo.session_id] = {
        status: 'imported',
        session_id: headersInfo.session_id,
        schema: headersInfo.schema,
        received_at: state.sessions[headersInfo.session_id].received_at,
        imported_at: nowIso(),
        size_bytes: uploadInfo.size_bytes,
        sha256: uploadInfo.sha256,
        sample_count: imported.sample_count,
        frame_count: imported.frame_count,
        vehicle_ids: imported.vehicle_ids,
        elapsed_ms: Date.now() - startedAt
      };
      await writePatrolFlowUploadState(nextState);
      await appendPatrolFlowUploadLog({
        ...nextState.sessions[headersInfo.session_id],
        ok: true,
        content_type: headersInfo.content_type,
        storage_before: {
          total_bytes: storageBefore.total_bytes,
          disk_free_bytes: storageBefore.disk_free_bytes
        }
      });
      console.log(JSON.stringify({
        event: 'patrol_flow_upload_imported',
        session_id: headersInfo.session_id,
        vehicle_ids: imported.vehicle_ids,
        sample_count: imported.sample_count,
        frame_count: imported.frame_count,
        size_bytes: uploadInfo.size_bytes,
        elapsed_ms: Date.now() - startedAt
      }));

      return res.status(201).json({
        ...imported,
        upload: {
          size_bytes: uploadInfo.size_bytes,
          sha256: uploadInfo.sha256,
          sha256_verified: Boolean(headersInfo.expected_sha256),
          elapsed_ms: Date.now() - startedAt
        }
      });
    } catch (error) {
      if (packagePath) {
        await fsp.rm(packagePath, { force: true }).catch(() => {});
      }
      if (headersInfo?.session_id) {
        const state = await readPatrolFlowUploadState().catch(() => ({ version: 1, sessions: {} }));
        state.sessions = state.sessions && typeof state.sessions === 'object' ? state.sessions : {};
        state.sessions[headersInfo.session_id] = {
          ...(state.sessions[headersInfo.session_id] || {}),
          status: 'failed',
          session_id: headersInfo.session_id,
          schema: headersInfo.schema,
          failed_at: nowIso(),
          error: error.message || 'patrol_flow_upload_failed',
          elapsed_ms: Date.now() - startedAt
        };
        await writePatrolFlowUploadState(state).catch(() => {});
        await appendPatrolFlowUploadLog({
          ok: false,
          session_id: headersInfo.session_id,
          schema: headersInfo.schema,
          error: error.message || 'patrol_flow_upload_failed',
          status: error.status || 500,
          elapsed_ms: Date.now() - startedAt
        }).catch(() => {});
      }
      console.warn(JSON.stringify({
        event: 'patrol_flow_upload_failed',
        session_id: headersInfo?.session_id || null,
        error: error.message || 'patrol_flow_upload_failed',
        status: error.status || 500,
        elapsed_ms: Date.now() - startedAt
      }));
      return res.status(error.status || 500).json({
        ok: false,
        error: error.message || 'patrol_flow_upload_failed',
        detail: error.detail || null,
        storage: error.storage || null
      });
    }
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

  function vehicleEstimateSnapshot(analysis) {
    if (!analysis || typeof analysis !== 'object') return null;
    if (analysis.vehicle_estimate && typeof analysis.vehicle_estimate === 'object') {
      return analysis.vehicle_estimate;
    }
    if (!['vehicle_estimate', 'vehicle_estimate_server_reviewed'].includes(analysis.status)) {
      return null;
    }
    return {
      people_count: analysis.people_count ?? null,
      max_single_camera_people: analysis.max_single_camera_people ?? null,
      frame_count_analyzed: analysis.frame_count_analyzed ?? null,
      confidence: analysis.confidence || null,
      model: analysis.model || 'vehicle_perception_upload',
      analyzed_at: analysis.analyzed_at || null,
      note: analysis.note || null
    };
  }

  function preferServerReviewedCrowdAnalysis(analysis) {
    if (!analysis || typeof analysis !== 'object') return analysis;
    const serverVlm = analysis.server_vlm && typeof analysis.server_vlm === 'object'
      ? analysis.server_vlm
      : null;
    if (!serverVlm || serverVlm.status !== 'done') {
      return analysis;
    }
    const vehicleEstimate = vehicleEstimateSnapshot(analysis);
    if (!vehicleEstimate) {
      return analysis;
    }
    const vehicleNote = vehicleEstimate.people_count == null
      ? ''
      : `车端初始统计 ${vehicleEstimate.people_count} 人。`;
    return {
      ...analysis,
      ...serverVlm,
      status: 'vehicle_estimate_server_reviewed',
      vehicle_estimate: vehicleEstimate,
      server_vlm: serverVlm,
      note: [serverVlm.note, vehicleNote].filter(Boolean).join(' ')
    };
  }

  function mergeCrowdAnalysisIntoSample(sample, analysisState) {
    if (!sample || sample.skipped) return sample;
    const sampleAnalysis = analysisState?.samples?.[sample.sample_id];
    const mapFrameForClient = (frame) => {
      if (!frame || typeof frame !== 'object') return frame;
      const imagePath = String(frame.image_path || '').trim();
      return {
        ...frame,
        image_url: imagePath ? crowdRedactedFrameUrl(imagePath) : frame.image_url
      };
    };
    if (!sampleAnalysis) {
      return {
        ...sample,
        frames: Array.isArray(sample.frames) ? sample.frames.map(mapFrameForClient) : sample.frames
      };
    }
    const framesByCaptureId = sampleAnalysis.frames && typeof sampleAnalysis.frames === 'object'
      ? sampleAnalysis.frames
      : {};
    return {
      ...sample,
      analysis: preferServerReviewedCrowdAnalysis({
        ...(sample.analysis || {}),
        ...sampleAnalysis.aggregate
      }),
      frames: Array.isArray(sample.frames)
        ? sample.frames.map((frame) => mapFrameForClient({
            ...frame,
            analysis: preferServerReviewedCrowdAnalysis({
              ...(frame.analysis || {}),
              ...(framesByCaptureId[frame.capture_id] || framesByCaptureId[frame.camera_id] || {})
            })
          }))
        : sample.frames
    };
  }

  function mergeServerAnalysisWithVehicleEstimate(sample, serverAnalysis) {
    const frameResults = serverAnalysis?.frames && typeof serverAnalysis.frames === 'object'
      ? serverAnalysis.frames
      : {};
    const mergedFrames = {};
    const sampleFrames = Array.isArray(sample?.frames) ? sample.frames : [];
    sampleFrames.forEach((frame) => {
      const frameKey = frame.capture_id || frame.camera_id || `frame_${Object.keys(mergedFrames).length + 1}`;
      const serverFrame = frameResults[frameKey] || frameResults[frame.camera_id] || null;
      const existingFrameAnalysis = frame.analysis && typeof frame.analysis === 'object' ? frame.analysis : {};
      if (existingFrameAnalysis.status === 'vehicle_estimate') {
        mergedFrames[frameKey] = preferServerReviewedCrowdAnalysis({
          ...existingFrameAnalysis,
          vehicle_estimate: {
            people_count: existingFrameAnalysis.people_count,
            confidence: existingFrameAnalysis.confidence || null,
            model: existingFrameAnalysis.model || 'vehicle_perception_upload',
            analyzed_at: existingFrameAnalysis.analyzed_at || null,
            note: existingFrameAnalysis.note || null
          },
          server_vlm: serverFrame,
          status: serverFrame?.status === 'done' ? 'vehicle_estimate_server_reviewed' : existingFrameAnalysis.status
        });
      } else {
        mergedFrames[frameKey] = serverFrame || existingFrameAnalysis;
      }
    });

    const existingAggregate = sample?.analysis && typeof sample.analysis === 'object' ? sample.analysis : {};
    if (existingAggregate.status === 'vehicle_estimate') {
      return {
        frames: mergedFrames,
        aggregate: preferServerReviewedCrowdAnalysis({
          ...existingAggregate,
          vehicle_estimate: {
            people_count: existingAggregate.people_count,
            max_single_camera_people: existingAggregate.max_single_camera_people ?? null,
            frame_count_analyzed: existingAggregate.frame_count_analyzed ?? null,
            model: existingAggregate.model || 'vehicle_perception_upload',
            analyzed_at: existingAggregate.analyzed_at || null,
            note: existingAggregate.note || null
          },
          server_vlm: serverAnalysis?.aggregate || null,
          status: serverAnalysis?.aggregate?.status === 'done'
            ? 'vehicle_estimate_server_reviewed'
            : existingAggregate.status,
          note: serverAnalysis?.aggregate?.status
            ? `${existingAggregate.note || '车端 perception 初始统计。'} 云端复核状态：${serverAnalysis.aggregate.status}。`
            : existingAggregate.note
        })
      };
    }

    return serverAnalysis;
  }

  async function sampleHasStoredCrowdImage(sample) {
    const frames = Array.isArray(sample?.frames) ? sample.frames : [];
    const imagePaths = frames
      .map((frame) => String(frame?.image_path || '').trim())
      .filter(Boolean);
    if (!imagePaths.length) return false;
    for (const imagePath of imagePaths) {
      try {
        const resolved = resolveCrowdFramePath(imagePath, crowdFramesRoot);
        const stat = await fsp.stat(resolved.target_path);
        if (stat.isFile() && stat.size > 0) return true;
      } catch (_error) {
        // Missing historical frame; keep checking the other camera images.
      }
    }
    return false;
  }

  async function filterSamplesWithStoredCrowdImages(samples) {
    const rows = Array.isArray(samples) ? samples : [];
    return (await mapWithConcurrency(rows, 16, async (sample) => (
      await sampleHasStoredCrowdImage(sample) ? sample : null
    ))).filter(Boolean);
  }

  async function readCrowdSampleLog(limit, filters) {
    const normalizedLimit = toFiniteInteger(limit, 20, { min: 1, max: 20000 });
    const vehicleId = String(filters?.vehicle_id || '').trim();
    const source = String(filters?.source || '').trim();
    try {
      const text = await fsp.readFile(crowdIndexLogPath, 'utf8');
      const rows = text
        .split('\n')
        .filter(Boolean)
        .map((line) => safeJsonParse(line, null))
        .filter(Boolean);
      const filteredRows = rows.filter((sample) => {
        if (vehicleId && String(sample?.vehicle_id || '') !== vehicleId) return false;
        if (source && String(sample?.source || 'cloud_camera_capture') !== source) return false;
        return true;
      });
      return filteredRows
        .slice(-normalizedLimit)
        .reverse();
    } catch (_error) {
      return [];
    }
  }

  async function readCrowdSampleLogForAxis(filters) {
    const vehicleId = String(filters?.vehicle_id || '').trim();
    const source = String(filters?.source || '').trim();
    try {
      const text = await fsp.readFile(crowdIndexLogPath, 'utf8');
      return text
        .split('\n')
        .filter(Boolean)
        .map((line) => safeJsonParse(line, null))
        .filter(Boolean)
        .filter((sample) => {
          if (vehicleId && String(sample?.vehicle_id || '') !== vehicleId) return false;
          if (source && String(sample?.source || 'cloud_camera_capture') !== source) return false;
          return true;
        });
    } catch (_error) {
      return [];
    }
  }

  function normalizeReportDateKey(value, fallback) {
    const raw = String(value || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    if (raw) {
      const parsed = new Date(raw);
      if (!Number.isNaN(parsed.getTime())) return crowdDayKey(parsed);
    }
    return fallback || '';
  }

  function compareDayKeys(left, right) {
    return String(left || '').localeCompare(String(right || ''));
  }

  function normalizeCrowdReportParams(params) {
    const vehicleId = String(params?.vehicle_id || params?.vehicleId || '').trim();
    if (!vehicleId) {
      const error = new Error('vehicle_id_required');
      error.status = 400;
      throw error;
    }
    const todayKey = crowdDayKey(new Date());
    let endDate = normalizeReportDateKey(params?.end_date || params?.endDate, todayKey);
    let startDate = normalizeReportDateKey(params?.start_date || params?.startDate, '');
    if (!startDate) {
      const endMs = crowdDayKeyToUtcMs(endDate) || crowdDayKeyToUtcMs(todayKey);
      startDate = crowdDayKeyFromUtcMs(endMs - 6 * 24 * 60 * 60 * 1000);
    }
    const startMs = crowdDayKeyToUtcMs(startDate);
    const endMs = crowdDayKeyToUtcMs(endDate);
    if (startMs == null || endMs == null) {
      const error = new Error('invalid_date_range');
      error.status = 400;
      throw error;
    }
    if (startMs > endMs) {
      const error = new Error('start_date_after_end_date');
      error.status = 400;
      throw error;
    }
    const maxDays = 31;
    const dayCount = Math.round((endMs - startMs) / (24 * 60 * 60 * 1000)) + 1;
    if (dayCount > maxDays) {
      const error = new Error(`date_range_too_large_max_${maxDays}_days`);
      error.status = 400;
      throw error;
    }
    return {
      vehicle_id: vehicleId,
      start_date: startDate,
      end_date: endDate,
      day_count: dayCount
    };
  }

  function reportSampleDayKey(sample) {
    const ms = Number(sample?.collected_at_ms || Date.parse(sample?.collected_at || ''));
    if (Number.isFinite(ms)) return crowdDayKey(new Date(ms));
    const frame = Array.isArray(sample?.frames) ? sample.frames.find((item) => item?.image_path) : null;
    const match = String(frame?.image_path || '').match(/^(\d{4})(\d{2})(\d{2})\//);
    return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
  }

  function reportPeopleCount(sample) {
    const direct = Number(sample?.analysis?.people_count);
    if (Number.isFinite(direct)) return direct;
    const counts = (Array.isArray(sample?.frames) ? sample.frames : [])
      .map((frame) => Number(frame?.analysis?.people_count))
      .filter((value) => Number.isFinite(value));
    if (!counts.length) return null;
    return counts.reduce((sum, value) => sum + value, 0);
  }

  function reportFeatureCountMap(sample, key) {
    const analysis = sample?.analysis && typeof sample.analysis === 'object' ? sample.analysis : {};
    return analysis[key] && typeof analysis[key] === 'object' ? analysis[key] : {};
  }

  function addReportCount(target, key, value) {
    const normalizedKey = String(key || '').trim();
    const count = Number(value);
    if (!normalizedKey || !Number.isFinite(count) || count <= 0) return;
    target[normalizedKey] = (target[normalizedKey] || 0) + count;
  }

  function reportHasKnownFeatureValue(map) {
    return Object.entries(map || {}).some(([key, value]) => key !== 'unknown' && Number(value) > 0);
  }

  function derivedReportAgeStageMap(sample) {
    const direct = reportFeatureCountMap(sample, 'age_stage_groups');
    if (reportHasKnownFeatureValue(direct)) return direct;
    const legacy = reportFeatureCountMap(sample, 'age_groups');
    const result = {};
    addReportCount(result, 'junior', (legacy.child || 0) + (legacy.teenager || 0));
    addReportCount(result, 'youth', legacy.adult);
    addReportCount(result, 'senior', legacy.elderly);
    addReportCount(result, 'unknown', legacy.unknown);
    return result;
  }

  function derivedReportGenderMap(sample) {
    const direct = reportFeatureCountMap(sample, 'gender_groups');
    if (reportHasKnownFeatureValue(direct)) return direct;
    const mix = reportFeatureCountMap(sample, 'gender_mix');
    const result = {};
    addReportCount(result, 'male', mix.male || mix.man || mix.men);
    addReportCount(result, 'female', mix.female || mix.woman || mix.women);
    addReportCount(result, 'unknown', mix.unknown);
    return result;
  }

  function derivedReportPersonAttributeMap(sample) {
    const direct = reportFeatureCountMap(sample, 'person_attributes');
    if (reportHasKnownFeatureValue(direct)) return direct;
    const roles = reportFeatureCountMap(sample, 'role_types');
    const groups = reportFeatureCountMap(sample, 'group_types');
    const result = {};
    addReportCount(result, 'visitor', roles.visitor);
    addReportCount(result, 'staff', roles.staff);
    addReportCount(result, 'security', roles.security);
    addReportCount(result, 'cleaner', roles.cleaner);
    addReportCount(result, 'delivery', roles.delivery);
    addReportCount(result, 'maintenance', roles.maintenance);
    addReportCount(result, 'vendor', roles.vendor);
    addReportCount(result, 'student', roles.student);
    addReportCount(result, 'family', groups.family_parent_child);
    addReportCount(result, 'couple', groups.pair);
    addReportCount(result, 'unknown', roles.unknown || groups.unknown);
    return result;
  }

  function reportAttentionMap(sample) {
    const stageMap = derivedReportAgeStageMap(sample);
    const mobility = reportFeatureCountMap(sample, 'mobility_types');
    const result = {};
    addReportCount(result, 'child', stageMap.junior);
    addReportCount(result, 'elderly', stageMap.senior);
    ['wheelchair', 'cane_or_walker', 'stroller', 'assisted_walking', 'slow_moving'].forEach((key) => {
      addReportCount(result, key, mobility[key]);
    });
    return result;
  }

  function addReportFeatureMap(target, source, options) {
    const includeUnknown = options?.include_unknown === true;
    Object.entries(source || {}).forEach(([key, value]) => {
      if (!includeUnknown && key === 'unknown') return;
      addReportCount(target, key, value);
    });
  }

  function sortedReportFeatureRows(map, labels, limit) {
    return Object.entries(map || {})
      .map(([key, value]) => ({ key, label: labels[key] || key, value: Number(value) || 0 }))
      .filter((row) => row.value > 0)
      .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label, 'zh-CN'))
      .slice(0, limit || 12);
  }

  function reportTopLabel(rows, fallback) {
    const row = Array.isArray(rows) && rows.length ? rows[0] : null;
    return row ? row.label : fallback;
  }

  function reportTopShare(rows) {
    const total = (Array.isArray(rows) ? rows : [])
      .reduce((sum, row) => sum + (Number(row.value) || 0), 0);
    if (!total || !Array.isArray(rows) || !rows.length) return '';
    return `${Math.round((Number(rows[0].value) || 0) * 100 / total)}%`;
  }

  function reportFramePeopleCount(frame) {
    const direct = Number(frame?.analysis?.people_count);
    return Number.isFinite(direct) ? direct : null;
  }

  function reportSceneTagsFrom(item) {
    const tags = item?.analysis?.scene_tags;
    return Array.isArray(tags) ? tags.map((tag) => String(tag || '').trim()).filter(Boolean) : [];
  }

  function reportSampleSceneTags(sample) {
    const tags = new Set(reportSceneTagsFrom(sample));
    (Array.isArray(sample?.frames) ? sample.frames : []).forEach((frame) => {
      reportSceneTagsFrom(frame).forEach((tag) => tags.add(tag));
    });
    return [...tags].slice(0, 6);
  }

  function reportCleanNote(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .replace(/[。；;,\s]+$/g, '')
      .slice(0, 120);
  }

  function reportPhotoCaption(sample, frame) {
    const people = reportFramePeopleCount(frame) ?? reportPeopleCount(sample);
    const tags = [...new Set([...reportSceneTagsFrom(frame), ...reportSampleSceneTags(sample)])].slice(0, 3);
    const note = reportCleanNote(frame?.analysis?.note || sample?.analysis?.note);
    const parts = [];
    if (people != null) parts.push(`画面识别约 ${people} 人`);
    if (tags.length) parts.push(tags.join('、'));
    if (note && !/无可见人员/.test(note)) parts.push(note);
    return parts.length ? `${parts.join('，')}。` : '代表性巡逻画面，已做人脸脱敏处理。';
  }

  async function readReportRedactedImageDataUri(imagePath) {
    const targetPath = await ensureRedactedCrowdFrame(imagePath);
    const buffer = await fsp.readFile(targetPath);
    return `data:${imageMimeFromPath(targetPath)};base64,${buffer.toString('base64')}`;
  }

  function reportStaticMapZoom(points, width, height) {
    const valid = (Array.isArray(points) ? points : [])
      .filter((point) => Number.isFinite(point.lng) && Number.isFinite(point.lat));
    if (valid.length < 2) return 17;
    const lngs = valid.map((point) => point.lng);
    const lats = valid.map((point) => point.lat);
    const lngSpan = Math.max(...lngs) - Math.min(...lngs);
    const latSpan = Math.max(...lats) - Math.min(...lats);
    if (lngSpan <= 0 && latSpan <= 0) return 17;
    const paddingRatio = 0.72;
    const targetWorldPx = 256;
    let zoom = 17;
    for (let candidate = 19; candidate >= 12; candidate -= 1) {
      const scale = targetWorldPx * Math.pow(2, candidate);
      const xSpanPx = Math.max(1, (lngSpan / 360) * scale);
      const centerLat = valid.reduce((sum, point) => sum + point.lat, 0) / valid.length;
      const latRad = Math.max(-85, Math.min(85, centerLat)) * Math.PI / 180;
      const ySpanPx = Math.max(1, (latSpan / 360) * scale / Math.max(0.18, Math.cos(latRad)));
      if (xSpanPx <= width * paddingRatio && ySpanPx <= height * paddingRatio) {
        zoom = candidate;
        break;
      }
    }
    return zoom;
  }

  async function buildReportStaticMap(points) {
    const valid = (Array.isArray(points) ? points : [])
      .filter((point) => Number.isFinite(point.lng) && Number.isFinite(point.lat));
    if (!valid.length) return null;
    const width = 1024;
    const height = 468;
    const lngs = valid.map((point) => point.lng);
    const lats = valid.map((point) => point.lat);
    const center = {
      lng: (Math.min(...lngs) + Math.max(...lngs)) / 2,
      lat: (Math.min(...lats) + Math.max(...lats)) / 2
    };
    const zoom = reportStaticMapZoom(valid, width, height);
    const amapKey = String(
      process.env.PARK_CROWD_REPORT_AMAP_KEY ||
        process.env.AMAP_KEY ||
        process.env.GAODE_MAP_KEY ||
        '8c2f9f3401e8d0ddfd619074c5f034ef'
    ).trim();
    if (!amapKey) return null;
    const url = new URL('https://restapi.amap.com/v3/staticmap');
    url.searchParams.set('location', `${center.lng.toFixed(6)},${center.lat.toFixed(6)}`);
    url.searchParams.set('zoom', String(zoom));
    url.searchParams.set('size', `${width}*${height}`);
    url.searchParams.set('scale', '2');
    url.searchParams.set('key', amapKey);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { accept: 'image/png,image/jpeg,*/*' }
      });
      if (!response.ok) return null;
      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      if (!contentType.startsWith('image/')) return null;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 1024) return null;
      return {
        provider: 'amap_static',
        center,
        zoom,
        width,
        height,
        image_data_uri: `data:${contentType.split(';')[0] || 'image/png'};base64,${buffer.toString('base64')}`
      };
    } catch (_error) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function buildReportRepresentativeImages(samples) {
    const candidates = [];
    const seen = new Set();
    const ordered = [...(Array.isArray(samples) ? samples : [])]
      .sort((left, right) => (Number(reportPeopleCount(right)) || 0) - (Number(reportPeopleCount(left)) || 0));
    ordered.forEach((sample) => {
      const frames = [...(Array.isArray(sample?.frames) ? sample.frames : [])]
        .filter((frame) => String(frame?.image_path || '').trim())
        .sort((left, right) => (Number(reportFramePeopleCount(right)) || 0) - (Number(reportFramePeopleCount(left)) || 0));
      frames.forEach((frame) => {
        const imagePath = String(frame.image_path || '').trim();
        if (!imagePath || seen.has(imagePath)) return;
        seen.add(imagePath);
        candidates.push({ sample, frame, image_path: imagePath });
      });
    });

    const result = [];
    for (const item of candidates) {
      if (result.length >= 2) break;
      try {
        const imageDataUri = await readReportRedactedImageDataUri(item.image_path);
        result.push({
          sample_id: item.sample.sample_id || '',
          camera_id: item.frame.camera_id || '',
          collected_at: item.sample.collected_at || '',
          people_count: reportFramePeopleCount(item.frame) ?? reportPeopleCount(item.sample),
          scene_tags: [...new Set([...reportSceneTagsFrom(item.frame), ...reportSampleSceneTags(item.sample)])].slice(0, 4),
          caption: reportPhotoCaption(item.sample, item.frame),
          image_data_uri: imageDataUri
        });
      } catch (_error) {
        // Skip missing historical frames; the report still renders with the remaining visual material.
      }
    }
    return result;
  }

  function buildReportHeatmapPoints(samples) {
    const rows = (Array.isArray(samples) ? samples : [])
      .map((sample) => {
        const position = sample?.position || {};
        const lng = numberValue(position.gaode_longitude ?? position.longitude);
        const lat = numberValue(position.gaode_latitude ?? position.latitude);
        const count = Number(reportPeopleCount(sample)) || 0;
        return { lng, lat, count };
      })
      .filter((row) => Number.isFinite(row.lng) && Number.isFinite(row.lat) && row.count > 0)
      .sort((left, right) => right.count - left.count);
    const maxPoints = 260;
    return rows.slice(0, maxPoints);
  }

  function buildReportInsights(range, totals, daySeries, featureRows) {
    const activeDays = daySeries.filter((day) => Number(day.people_total) > 0);
    const peakDay = [...daySeries].sort((left, right) => (Number(right.people_total) || 0) - (Number(left.people_total) || 0))[0] || null;
    const avgPeople = activeDays.length ? Math.round((Number(totals.people_total) || 0) / activeDays.length) : 0;
    const attr = featureRows.person_attributes || [];
    const stage = featureRows.age_stage_groups || [];
    const attention = featureRows.attention_signals || [];
    return [
      `本期 ${range.start_date} 至 ${range.end_date} 共形成 ${totals.sample_count} 条巡逻人流记录，识别人数 ${totals.people_total} 人。`,
      peakDay && Number(peakDay.people_total) > 0
        ? `峰值出现在 ${peakDay.key}，当日累计 ${peakDay.people_total} 人，单点峰值 ${peakDay.max_people} 人。`
        : '本期未形成明显人流高峰。',
      activeDays.length
        ? `有客流的日期 ${activeDays.length} 天，活跃日均约 ${avgPeople} 人，适合关注高峰日的现场秩序和服务引导。`
        : '本期客流活跃度较低，可作为低峰时段参考。',
      attr.length || stage.length
        ? `客群以${reportTopLabel(attr, reportTopLabel(stage, '常规访客'))}为主${reportTopShare(attr) ? `，占比约 ${reportTopShare(attr)}` : ''}。`
        : '画像结构仍在积累，可结合后续巡逻数据持续观察。',
      attention.length
        ? `关照线索中${reportTopLabel(attention, '重点关照')}最突出，建议在高峰点位加强巡查和提示。`
        : '本期未出现明显关照线索。'
    ].filter(Boolean);
  }

  const reportFeatureLabels = {
    age_stage_groups: {
      junior: '青少年',
      youth: '青年',
      middle: '中年',
      senior: '长者',
      unknown: '未判断'
    },
    gender_groups: {
      male: '男',
      female: '女',
      unknown: '未判断'
    },
    person_attributes: {
      visitor: '普通游客',
      business: '商务人士',
      couple: '情侣',
      family: '家庭',
      staff: '园区工作人员',
      security: '安保人员',
      cleaner: '保洁人员',
      delivery: '配送人员',
      maintenance: '维修施工',
      vendor: '商户摊位',
      student: '学生群体',
      unknown: '未判断'
    },
    mobility_types: {
      wheelchair: '轮椅',
      cane_or_walker: '拐杖/助行器',
      stroller: '婴儿车',
      assisted_walking: '被搀扶',
      slow_moving: '行动缓慢',
      large_baggage: '大件行李',
      unknown: '行动特征不明'
    },
    activity_types: {
      walking: '通行',
      standing: '停留',
      sitting_or_resting: '休息',
      queueing: '排队',
      gathering: '聚集',
      running: '跑步',
      cycling: '骑行',
      scooter_or_ebike: '电动车/滑板车',
      taking_photo: '拍照',
      shopping_or_pickup: '购物/取餐',
      crossing_road: '过路',
      unknown: '行为不明'
    },
    attention_signals: {
      child: '低龄关照',
      elderly: '长者关照',
      wheelchair: '轮椅',
      cane_or_walker: '拐杖/助行器',
      stroller: '婴儿车',
      assisted_walking: '被搀扶',
      slow_moving: '行动缓慢'
    }
  };

  function buildReportDaySeries(range, samples) {
    const startMs = crowdDayKeyToUtcMs(range.start_date);
    const days = [];
    for (let index = 0; index < range.day_count; index += 1) {
      const key = crowdDayKeyFromUtcMs(startMs + index * 24 * 60 * 60 * 1000);
      days.push({
        key,
        sample_count: 0,
        recognized_count: 0,
        people_total: 0,
        heat_point_count: 0,
        max_people: 0,
        frame_count: 0,
        image_bytes: 0
      });
    }
    const byKey = new Map(days.map((day) => [day.key, day]));
    samples.forEach((sample) => {
      const key = reportSampleDayKey(sample);
      const day = byKey.get(key);
      if (!day) return;
      const people = reportPeopleCount(sample);
      day.sample_count += 1;
      day.frame_count += Number(sample.frame_count) || 0;
      day.image_bytes += Number(sample.total_image_bytes) || 0;
      if (people != null) {
        day.recognized_count += 1;
        day.people_total += Number(people) || 0;
        if (Number(people) > 0) day.heat_point_count += 1;
        day.max_people = Math.max(day.max_people, Number(people) || 0);
      }
    });
    return days;
  }

  function compactReportSample(sample) {
    const people = reportPeopleCount(sample);
    const position = sample?.position || {};
    return {
      sample_id: sample.sample_id || null,
      collected_at: sample.collected_at || null,
      day_key: reportSampleDayKey(sample),
      people_count: people,
      frame_count: Number(sample.frame_count) || 0,
      total_image_bytes: Number(sample.total_image_bytes) || 0,
      position: {
        gaode_longitude: numberValue(position.gaode_longitude),
        gaode_latitude: numberValue(position.gaode_latitude)
      }
    };
  }

  async function buildCrowdRangeReportPayload(range, samples) {
    const totals = {
      sample_count: samples.length,
      frame_count: samples.reduce((sum, sample) => sum + (Number(sample.frame_count) || 0), 0),
      image_bytes: samples.reduce((sum, sample) => sum + (Number(sample.total_image_bytes) || 0), 0),
      recognized_count: 0,
      people_total: 0,
      heat_point_count: 0,
      max_people: 0
    };
    const features = {
      age_stage_groups: {},
      gender_groups: {},
      person_attributes: {},
      mobility_types: {},
      activity_types: {},
      attention_signals: {}
    };
    samples.forEach((sample) => {
      const people = reportPeopleCount(sample);
      if (people != null) {
        totals.recognized_count += 1;
        totals.people_total += Number(people) || 0;
        if (Number(people) > 0) totals.heat_point_count += 1;
        totals.max_people = Math.max(totals.max_people, Number(people) || 0);
      }
      addReportFeatureMap(features.age_stage_groups, derivedReportAgeStageMap(sample));
      addReportFeatureMap(features.gender_groups, derivedReportGenderMap(sample));
      addReportFeatureMap(features.person_attributes, derivedReportPersonAttributeMap(sample));
      addReportFeatureMap(features.mobility_types, reportFeatureCountMap(sample, 'mobility_types'));
      addReportFeatureMap(features.activity_types, reportFeatureCountMap(sample, 'activity_types'));
      addReportFeatureMap(features.attention_signals, reportAttentionMap(sample));
    });
    const featureRows = {};
    Object.entries(features).forEach(([key, value]) => {
      const limit = ['age_stage_groups', 'gender_groups', 'person_attributes', 'attention_signals'].includes(key) ? 6 : 8;
      featureRows[key] = sortedReportFeatureRows(value, reportFeatureLabels[key] || {}, limit);
    });
    const orderedSamples = [...samples].sort((left, right) => {
      const leftPeople = reportPeopleCount(left);
      const rightPeople = reportPeopleCount(right);
      return (Number(rightPeople) || 0) - (Number(leftPeople) || 0) ||
        Number(right.collected_at_ms || Date.parse(right.collected_at || '')) -
          Number(left.collected_at_ms || Date.parse(left.collected_at || ''));
    });
    const daySeries = buildReportDaySeries(range, samples);
    const representativeImages = await buildReportRepresentativeImages(orderedSamples);
    const heatmapPoints = buildReportHeatmapPoints(samples);
    const staticMap = await buildReportStaticMap(heatmapPoints);
    return {
      ok: true,
      title: '园区人流报告',
      generated_at: nowIso(),
      vehicle_id: range.vehicle_id,
      start_date: range.start_date,
      end_date: range.end_date,
      day_count: range.day_count,
      totals,
      day_series: daySeries,
      features: featureRows,
      insights: buildReportInsights(range, totals, daySeries, featureRows),
      heatmap_points: heatmapPoints,
      heatmap_static_map: staticMap,
      representative_images: representativeImages,
      analysis_model: crowdAnalysisModel,
      top_samples: orderedSamples.slice(0, 12).map(compactReportSample),
      disclaimer: '人流画像为视觉模型基于巡逻画面的自动预测结果，仅供园区运营参考，不代表真实客流或个体事实；页面展示图片已做人脸脱敏处理，不做人脸身份识别。'
    };
  }

  async function readCrowdSamplesForReport(range) {
    const rawSamples = await readCrowdSampleLogForAxis({
      vehicle_id: range.vehicle_id,
      source: ''
    });
    const filtered = rawSamples.filter((sample) => {
      if (!sample || sample.skipped) return false;
      const key = reportSampleDayKey(sample);
      return key && compareDayKeys(key, range.start_date) >= 0 && compareDayKeys(key, range.end_date) <= 0;
    });
    const storedSamples = await filterSamplesWithStoredCrowdImages(filtered);
    const analysisState = await readCrowdAnalysisState();
    return storedSamples.map((sample) => mergeCrowdAnalysisIntoSample(sample, analysisState));
  }

  async function renderCrowdRangeReportPdf(payload) {
    await fsp.mkdir(reportPdfRoot, { recursive: true });
    const stamp = `${dateStampCompact(new Date())}_${timeStampCompact(new Date())}_${crypto.randomBytes(4).toString('hex')}`;
    const safeVehicle = sanitizeName(payload.vehicle_id, 'vehicle');
    const inputPath = path.join(reportPdfRoot, `park_crowd_report_${safeVehicle}_${stamp}.json`);
    const outputPath = path.join(reportPdfRoot, `park_crowd_report_${safeVehicle}_${stamp}.pdf`);
    await fsp.writeFile(inputPath, JSON.stringify(payload), 'utf8');
    try {
      await execFileAsync(
        process.env.PARK_CROWD_REPORT_PYTHON || 'python3',
        [reportPdfRendererPath, inputPath, outputPath],
        { timeout: 60000, maxBuffer: 1024 * 1024 }
      );
      const stat = await fsp.stat(outputPath);
      if (!stat.isFile() || stat.size <= 0) {
        throw new Error('pdf_output_empty');
      }
      return outputPath;
    } finally {
      fsp.unlink(inputPath).catch(() => {});
    }
  }

  async function buildCrowdRangeReportPdf(params) {
    const range = normalizeCrowdReportParams(params);
    const samples = await readCrowdSamplesForReport(range);
    const payload = await buildCrowdRangeReportPayload(range, samples);
    const pdfPath = await renderCrowdRangeReportPdf(payload);
    return {
      payload,
      pdf_path: pdfPath,
      file_name: `park-crowd-${sanitizeName(range.vehicle_id, 'vehicle')}-${range.start_date}-${range.end_date}.pdf`
    };
  }

  function buildCrowdSampleDayAxis(samples) {
    const stats = new Map();
    const ensureDay = (key) => {
      const ms = crowdDayKeyToUtcMs(key);
      if (!key || ms == null) return null;
      const current = stats.get(key) || {
        key,
        ms,
        patrol_sample_count: 0,
        session_count: 0,
        frame_count: 0
      };
      stats.set(key, current);
      return current;
    };
    (Array.isArray(samples) ? samples : []).forEach((sample) => {
      if (!sample || sample.skipped) return;
      const collectedAtMs = Number(sample.collected_at_ms || Date.parse(sample.collected_at || ''));
      if (!Number.isFinite(collectedAtMs)) return;
      const key = crowdDayKey(new Date(collectedAtMs));
      const current = ensureDay(key);
      if (!current) return;
      current.patrol_sample_count += 1;
      current.frame_count += Number(sample.frame_count) || 0;
    });
    return { stats, ensureDay };
  }

  function mergeCrowdUploadSessionsIntoDayAxis(axisState, sessions, filters) {
    const vehicleId = String(filters?.vehicle_id || '').trim();
    const source = String(filters?.source || '').trim();
    if (source && source !== VEHICLE_PATROL_FLOW_SAMPLE_SOURCE) return;
    Object.values(sessions || {}).forEach((session) => {
      if (!session || session.status !== 'imported') return;
      const vehicleIds = Array.isArray(session.vehicle_ids)
        ? session.vehicle_ids.map((item) => String(item || '').trim()).filter(Boolean)
        : [];
      if (vehicleId && !vehicleIds.includes(vehicleId)) return;
      const ts = Date.parse(session.imported_at || session.received_at || session.finished_at || session.started_at || '');
      if (!Number.isFinite(ts)) return;
      const key = crowdDayKey(new Date(ts));
      const current = axisState.ensureDay(key);
      if (!current) return;
      current.session_count += 1;
      current.patrol_sample_count = Math.max(current.patrol_sample_count, Number(session.sample_count) || 0);
      current.frame_count = Math.max(current.frame_count, Number(session.frame_count) || 0);
    });
  }

  function finalizeCrowdSampleDayAxis(axisState) {
    const stats = axisState && axisState.stats ? axisState.stats : new Map();
    const dataDays = [...stats.values()].sort((left, right) => left.ms - right.ms);
    const maxMs = dataDays.length
      ? dataDays[dataDays.length - 1].ms
      : crowdDayKeyToUtcMs(crowdDayKey(new Date()));
    if (maxMs == null) return [];
    const minMs = maxMs - (CROWD_HEATMAP_DAY_AXIS_COUNT - 1) * 24 * 60 * 60 * 1000;
    const axis = [];
    for (let index = 0; index < CROWD_HEATMAP_DAY_AXIS_COUNT; index += 1) {
      const ms = minMs + index * 24 * 60 * 60 * 1000;
      const key = crowdDayKeyFromUtcMs(ms);
      axis.push(stats.get(key) || {
        key,
        ms,
        patrol_sample_count: 0,
        session_count: 0,
        frame_count: 0
      });
    }
    return axis.map((day) => ({
      key: day.key,
      patrol_sample_count: day.patrol_sample_count,
      session_count: day.session_count || 0,
      frame_count: day.frame_count
    }));
  }

  async function readRecentCrowdSamples(limit, filters) {
    const [samples, analysisState] = await Promise.all([
      readCrowdSampleLog(limit, filters),
      readCrowdAnalysisState()
    ]);
    const storedSamples = await filterSamplesWithStoredCrowdImages(samples);
    return storedSamples.map((sample) => mergeCrowdAnalysisIntoSample(sample, analysisState));
  }

  function routeFileNameCandidates(routeId) {
    const raw = String(routeId || '').trim();
    const candidates = new Set();
    if (!raw) return [];
    const push = (value) => {
      const text = String(value || '').trim();
      if (!text) return;
      candidates.add(text.endsWith('.json') ? text : `${text}.json`);
    };
    push(sanitizeName(raw, 'route'));
    const base = path.basename(raw).replace(/\.(csv|json)$/i, '');
    push(sanitizeName(base, 'route'));
    const timestampMatch = raw.match(/(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})/);
    if (timestampMatch) push(`route_${timestampMatch[1]}`);
    const routeIdMatch = raw.match(/(route_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})/);
    if (routeIdMatch) push(routeIdMatch[1]);
    return [...candidates];
  }

  function routeDataMatchesRequest(routeData, routeId) {
    const requested = String(routeId || '').trim();
    if (!requested || !routeData || typeof routeData !== 'object') return false;
    const requestedBase = path.basename(requested);
    const requestedStem = requestedBase.replace(/\.(csv|json)$/i, '').split('&')[0];
    const candidates = [
      routeData.route_id,
      routeData.id,
      routeData.route_name,
      routeData.file_name,
      routeData.file_path,
      routeData.path,
      routeData.source_path
    ].map((value) => String(value || '').trim()).filter(Boolean);
    return candidates.some((candidate) => {
      if (candidate === requested) return true;
      const candidateBase = path.basename(candidate);
      const candidateStem = candidateBase.replace(/\.(csv|json)$/i, '').split('&')[0];
      return Boolean(
        requestedBase && candidateBase && candidateBase === requestedBase ||
        requestedStem && candidateStem && candidateStem === requestedStem ||
        requestedStem && candidate.includes(requestedStem)
      );
    });
  }

  function normalizePatrolRoutePoint(point) {
    if (!point || typeof point !== 'object') return null;
    const rawLatitude = firstFiniteNumber([point.lat, point.latitude, point.Lattitude]);
    const rawLongitude = firstFiniteNumber([point.lng, point.lon, point.longitude, point.Longitude]);
    const suppliedGaodeLat = firstFiniteNumber([point.gaode_latitude, point.gcj02_latitude]);
    const suppliedGaodeLng = firstFiniteNumber([point.gaode_longitude, point.gcj02_longitude]);
    const gcj = suppliedGaodeLat != null && suppliedGaodeLng != null
      ? { latitude: suppliedGaodeLat, longitude: suppliedGaodeLng }
      : rawLatitude != null && rawLongitude != null
        ? wgs84ToGcj02(rawLatitude, rawLongitude)
        : { latitude: null, longitude: null };
    if (!Number.isFinite(gcj.latitude) || !Number.isFinite(gcj.longitude)) return null;
    return {
      latitude: gcj.latitude,
      longitude: gcj.longitude,
      raw_latitude: rawLatitude,
      raw_longitude: rawLongitude,
      x: firstFiniteNumber([point.x, point.position_x]),
      y: firstFiniteNumber([point.y, point.position_y]),
      s: firstFiniteNumber([point.s, point.distance, point.progress_m])
    };
  }

  function samplePatrolRoutePoints(points, maxPoints) {
    const normalized = (Array.isArray(points) ? points : []).map(normalizePatrolRoutePoint).filter(Boolean);
    const limit = toFiniteInteger(maxPoints, DEFAULT_CROWD_ROUTE_MAX_POINTS, { min: 80, max: 2000 });
    if (normalized.length <= limit) return normalized;
    const sampled = [];
    const lastIndex = normalized.length - 1;
    for (let slot = 0; slot < limit; slot += 1) {
      const index = Math.round((slot * lastIndex) / Math.max(1, limit - 1));
      sampled.push(normalized[index]);
    }
    return sampled;
  }

  async function readPatrolRouteFile(sessionId, routeId, maxPoints) {
    const normalizedSessionId = sanitizeName(sessionId, '');
    const requestedRouteId = String(routeId || '').trim();
    if (!normalizedSessionId || !requestedRouteId) return null;
    const sessionsRoot = path.join(crowdUploadsRoot, 'sessions');
    const sessionRoot = path.join(sessionsRoot, normalizedSessionId);
    const resolvedSessionRoot = path.resolve(sessionRoot);
    if (!resolvedSessionRoot.startsWith(path.resolve(sessionsRoot) + path.sep)) return null;
    const routesRoot = path.join(sessionRoot, 'routes');
    let entries = [];
    try {
      entries = await fsp.readdir(routesRoot, { withFileTypes: true });
    } catch (_error) {
      return null;
    }
    const jsonNames = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name);
    const orderedNames = [];
    const seenNames = new Set();
    const addName = (name) => {
      if (!name || seenNames.has(name) || !jsonNames.includes(name)) return;
      seenNames.add(name);
      orderedNames.push(name);
    };
    routeFileNameCandidates(requestedRouteId).forEach(addName);
    jsonNames.forEach(addName);
    for (const fileName of orderedNames) {
      const filePath = path.join(routesRoot, fileName);
      const data = await readJsonFile(filePath);
      if (!data || data.unknown === true) continue;
      if (!routeFileNameCandidates(requestedRouteId).includes(fileName) && !routeDataMatchesRequest(data, requestedRouteId)) continue;
      const points = samplePatrolRoutePoints(data.points, maxPoints);
      if (!points.length) continue;
      return {
        session_id: normalizedSessionId,
        requested_route_id: requestedRouteId,
        route_id: String(data.route_id || data.id || requestedRouteId),
        route_name: firstNonEmpty([data.route_name_trimmed, data.route_name, data.name, data.file_name]) || null,
        file_name: data.file_name || fileName,
        length_m: firstFiniteNumber([data.length_m, data.distance_m]),
        point_count: firstFiniteNumber([data.point_count, Array.isArray(data.points) ? data.points.length : null]),
        returned_point_count: points.length,
        points
      };
    }
    return null;
  }

  function normalizeRouteRequestItems(body) {
    const sourceItems = Array.isArray(body?.routes)
      ? body.routes
      : Array.isArray(body?.items)
        ? body.items
        : [];
    const seen = new Set();
    const items = [];
    sourceItems.forEach((item) => {
      const sessionId = String(item?.session_id || item?.upload_session_id || '').trim();
      const routeId = String(item?.route_id || item?.requested_route_id || '').trim();
      if (!sessionId || !routeId) return;
      const key = `${sessionId}\n${routeId}`;
      if (seen.has(key)) return;
      seen.add(key);
      items.push({ session_id: sessionId, route_id: routeId });
    });
    return items.slice(0, 40);
  }

  async function buildCrowdPatrolStatus(params) {
    params = params || {};
    const startedAt = Date.now();
    const maxVehicles = toFiniteInteger(params.max_vehicles, 60, { min: 1, max: 120 });
    const includeUnknown = params.include_unknown === true;
    const nowMs = Date.now();
    const [vehiclesRaw, samples, state] = await Promise.all([
      listVehicles(),
      readRecentCrowdSamples(100, { source: VEHICLE_PATROL_FLOW_SAMPLE_SOURCE }),
      readCrowdState()
    ]);
    const vehicles = vehiclesRaw
      .filter((vehicle) => vehicle && vehicle.vehicle_id)
      .filter((vehicle) => {
        const lastSeenMs = Date.parse(vehicle.last_seen || '');
        return Number.isFinite(lastSeenMs) && nowMs - lastSeenMs <= freshVehicleMs;
      })
      .sort((left, right) => String(left.vehicle_id).localeCompare(String(right.vehicle_id), 'zh-CN'))
      .slice(0, maxVehicles);

    const rows = await mapWithConcurrency(vehicles, patrolStatusConcurrency, async (vehicle) => {
      const vehicleId = String(vehicle.vehicle_id);
      const lastSeenMs = Date.parse(vehicle.last_seen || '');
      const lastSeenAgeS = Number.isFinite(lastSeenMs) ? Math.max(0, Math.round((nowMs - lastSeenMs) / 1000)) : null;
      const { patrolState } = await classifyCrowdPatrolForVehicle(vehicle, nowMs, patrolStatusTimeoutS);
      let position = null;
      if (patrolState.capture_eligible) {
        const localization = await callVehicleTool(vehicleId, 'status.localization', {}, Math.max(patrolStatusTimeoutS, 12));
        if (localization.ok) {
          position = extractLocalizationPosition(localization);
        }
      }
      return {
        vehicle_id: vehicleId,
        plate_number: vehicle.plate_number || null,
        last_seen: vehicle.last_seen || null,
        last_seen_age_s: lastSeenAgeS,
        fresh: patrolState.fields.fresh === true,
        capture_eligible: patrolState.capture_eligible,
        patrol_state: patrolState,
        position,
        telemetry: {
          speed_kph: patrolState.fields.speed_kph,
          battery_soc: numberValue(vehicle?.telemetry?.vehicle?.battery_soc),
          running_mode: patrolState.fields.running_mode
        },
        crowd_data: summarizeVehicleCrowdSamples(samples, vehicleId, nowMs),
        last_crowd_capture: state.last_capture_by_vehicle[vehicleId] || null
      };
    });

    const eligibleRows = rows.filter((row) => row.capture_eligible);
    const visibleRows = includeUnknown ? rows : eligibleRows;
    const mapPoints = visibleRows
      .filter((row) => (
        row.position &&
        row.position.reliable === true &&
        Number.isFinite(row.position.gaode_longitude) &&
        Number.isFinite(row.position.gaode_latitude)
      ))
      .map((row) => ({
        vehicle_id: row.vehicle_id,
        longitude: row.position.gaode_longitude,
        latitude: row.position.gaode_latitude,
        state: row.patrol_state.state,
        sample_count_24h: row.crowd_data.sample_count_24h,
        frame_count_24h: row.crowd_data.frame_count_24h
      }));

    return {
      ok: true,
      generated_at: nowIso(),
      elapsed_ms: Date.now() - startedAt,
      counts: {
        scanned: rows.length,
        patrol: eligibleRows.length,
        with_position: mapPoints.length,
        unknown_or_not_patrol: rows.length - eligibleRows.length
      },
      config: {
        max_vehicles: maxVehicles,
        include_unknown: includeUnknown,
        patrol_status_timeout_s: patrolStatusTimeoutS,
        patrol_status_concurrency: patrolStatusConcurrency
      },
      patrols: visibleRows,
      map_points: mapPoints
    };
  }

  async function buildCrowdVehicleDetail(params) {
    params = params || {};
    const startedAt = Date.now();
    const requestedVehicleId = String(params.vehicle_id || '').trim();
    if (!requestedVehicleId) {
      const error = new Error('vehicle_id_required');
      error.status = 400;
      throw error;
    }

    const nowMs = Date.now();
    const [vehicles, samples, state] = await Promise.all([
      listVehicles(),
      readRecentCrowdSamples(100, { source: VEHICLE_PATROL_FLOW_SAMPLE_SOURCE }),
      readCrowdState()
    ]);
    const vehicle = vehicles.find((item) => String(item?.vehicle_id || '') === requestedVehicleId);
    if (!vehicle?.vehicle_id) {
      const error = new Error('vehicle_not_found');
      error.status = 404;
      throw error;
    }

    const vehicleId = String(vehicle.vehicle_id);
    const lastSeenMs = Date.parse(vehicle.last_seen || '');
    const lastSeenAgeS = Number.isFinite(lastSeenMs) ? Math.max(0, Math.round((nowMs - lastSeenMs) / 1000)) : null;
    const { toolResults, patrolState } = await classifyCrowdPatrolForVehicle(vehicle, nowMs, patrolStatusTimeoutS);
    const localization = await callVehicleTool(vehicleId, 'status.localization', {}, Math.max(patrolStatusTimeoutS, 12));
    const position = localization.ok ? extractLocalizationPosition(localization) : null;
    const planningSummary = compactToolResult(toolResults.planning?.result)?.summary || {};
    const canSummary = compactToolResult(toolResults.can?.result)?.summary || {};
    const routingSummary = compactToolResult(toolResults.routing?.result)?.summary || {};
    const mapPoint =
      position &&
      Number.isFinite(position.gaode_longitude) &&
      Number.isFinite(position.gaode_latitude)
        ? {
            vehicle_id: vehicleId,
            longitude: position.gaode_longitude,
            latitude: position.gaode_latitude,
            reliable: position.reliable === true,
            state: patrolState.state
          }
        : null;

    return {
      ok: true,
      generated_at: nowIso(),
      elapsed_ms: Date.now() - startedAt,
      vehicle: {
        vehicle_id: vehicleId,
        plate_number: vehicle.plate_number || null,
        last_seen: vehicle.last_seen || null,
        last_seen_age_s: lastSeenAgeS,
        fresh: lastSeenAgeS != null && lastSeenAgeS * 1000 <= freshVehicleMs,
        capture_eligible: patrolState.capture_eligible,
        patrol_state: patrolState,
        position,
        map_point: mapPoint,
        localization: {
          ok: localization.ok,
          elapsed_ms: localization.elapsed_ms,
          error: localization.ok ? null : localization.error || 'status.localization_unavailable',
          status: localization.status || null
        },
        route: {
          route_count: numberValue(routingSummary.route_count ?? routingSummary.available_route_count),
          current_route_id: routingSummary.current_route_id || routingSummary.active_route_id || null,
          route_location: routingSummary.current_route_location || routingSummary.route_location || null,
          current_path_string_ids: Array.isArray(routingSummary.current_path_string_ids)
            ? routingSummary.current_path_string_ids
            : []
        },
        telemetry: {
          speed_kph: patrolState.fields.speed_kph,
          battery_soc: numberValue(vehicle?.telemetry?.vehicle?.battery_soc),
          running_mode: patrolState.fields.running_mode,
          battery_charge_state: patrolState.fields.battery_charge_state,
          planner_running: numberValue(planningSummary.planner_running),
          vehicle_idle_status: numberValue(planningSummary.vehicle_idle_status),
          long_time_stop: booleanValue(planningSummary.long_time_stop),
          in_charger_zone: patrolState.fields.in_charger_zone,
          can_health: toolResults.can?.ok ? canSummary.health || null : null
        },
        crowd_data: summarizeVehicleCrowdSamples(samples, vehicleId, nowMs),
        last_crowd_capture: state.last_capture_by_vehicle[vehicleId] || null,
        tool_elapsed_ms: {
          planning: toolResults.planning?.elapsed_ms ?? null,
          can: toolResults.can?.elapsed_ms ?? null,
          routing: toolResults.routing?.elapsed_ms ?? null,
          localization: localization.elapsed_ms ?? null
        },
        tool_errors: {
          planning: toolResults.planning?.ok ? null : toolResults.planning?.error || 'unavailable',
          can: toolResults.can?.ok ? null : toolResults.can?.error || 'unavailable',
          routing: toolResults.routing
            ? toolResults.routing.ok
              ? null
              : toolResults.routing.error || 'unavailable'
            : null,
          localization: localization.ok ? null : localization.error || 'unavailable'
        }
      }
    };
  }

  function extractToolNamesFromVehicleDetail(detail) {
    const vehicle = detail?.vehicle || detail || {};
    const toolList = vehicle.tool_list_result || detail?.tool_list_result || {};
    const rawTools = Array.isArray(toolList.tools)
      ? toolList.tools
      : Array.isArray(toolList.result?.tools)
        ? toolList.result.tools
        : Array.isArray(toolList.response?.result?.tools)
          ? toolList.response.result.tools
          : [];
    return rawTools
      .map((tool) => String(tool?.name || tool?.tool || tool?.id || tool || '').trim())
      .filter(Boolean);
  }

  function summarizePatrolFlowCollectorResult(toolCall) {
    if (!toolCall) return null;
    const result = toolCall.result && typeof toolCall.result === 'object' ? toolCall.result : {};
    const queue = result.queue && typeof result.queue === 'object' ? result.queue : {};
    const cloudProbe = result.cloud_status_probe && typeof result.cloud_status_probe === 'object'
      ? result.cloud_status_probe
      : null;
    return {
      ok: toolCall.ok === true,
      error: toolCall.ok ? null : toolCall.error || 'patrol_flow_status_failed',
      elapsed_ms: toolCall.elapsed_ms ?? null,
      health: result.health || null,
      script_running: result.script_running === true,
      output_root: result.output_root || null,
      upload_url: result.upload_url || null,
      status_url: result.status_url || null,
      current_session: result.current_session || null,
      capture_interval_s: result.capture_interval_s ?? null,
      queue: {
        queue_dir: queue.queue_dir || null,
        pending_count: queue.pending_count ?? result.queue_package_count ?? 0,
        pending_total_size_bytes: queue.pending_total_size_bytes ?? result.queue_total_size_bytes ?? 0,
        done_count: queue.done_count ?? null,
        latest_upload_result: queue.latest_upload_result || result.latest_upload_result || null,
        pending_preview: Array.isArray(queue.pending_preview) ? queue.pending_preview.slice(0, 8) : []
      },
      latest_capture_at: result.latest_capture_at || null,
      latest_upload_result: result.latest_upload_result || queue.latest_upload_result || null,
      cloud_status_probe: cloudProbe
        ? {
            ok: cloudProbe.ok === true,
            http_status: cloudProbe.http_status ?? null,
            duration_ms: cloudProbe.duration_ms ?? null
          }
        : null,
      warnings: Array.isArray(result.warnings) ? result.warnings.slice(0, 12) : []
    };
  }

  function summarizePatrolFlowFlushResult(toolCall) {
    const result = toolCall?.result && typeof toolCall.result === 'object' ? toolCall.result : {};
    const queue = result.queue && typeof result.queue === 'object' ? result.queue : {};
    return {
      ok: toolCall?.ok === true,
      error: toolCall?.ok ? null : toolCall?.error || 'patrol_flow_flush_failed',
      elapsed_ms: toolCall?.elapsed_ms ?? null,
      uploaded_count: result.uploaded_count ?? result.upload_count ?? result.uploaded_package_count ?? null,
      failed_count: result.failed_count ?? result.failed_package_count ?? null,
      skipped_count: result.skipped_count ?? null,
      pending_count: queue.pending_count ?? result.pending_count ?? null,
      pending_total_size_bytes: queue.pending_total_size_bytes ?? result.pending_total_size_bytes ?? null,
      latest_upload_result: result.latest_upload_result || queue.latest_upload_result || null,
      warnings: Array.isArray(result.warnings) ? result.warnings.slice(0, 12) : [],
      result
    };
  }

  async function buildPatrolFlowCollectorStatus(params) {
    params = params || {};
    const startedAt = Date.now();
    const requestedVehicleIds = new Set(normalizeVehicleIds(params.vehicle_ids || params.vehicle_id));
    const maxVehicles = toFiniteInteger(params.max_vehicles, 60, { min: 1, max: 120 });
    const includeStatus = params.include_status !== false;
    const nowMs = Date.now();
    const vehiclesRaw = await listVehicles();
    const vehicles = vehiclesRaw
      .filter((vehicle) => vehicle && vehicle.vehicle_id)
      .filter((vehicle) => !requestedVehicleIds.size || requestedVehicleIds.has(String(vehicle.vehicle_id)))
      .filter((vehicle) => {
        const lastSeenMs = Date.parse(vehicle.last_seen || '');
        return Number.isFinite(lastSeenMs) && nowMs - lastSeenMs <= freshVehicleMs;
      })
      .sort((left, right) => String(left.vehicle_id).localeCompare(String(right.vehicle_id), 'zh-CN'))
      .slice(0, maxVehicles);

    const collectors = await mapWithConcurrency(vehicles, patrolFlowToolConcurrency, async (vehicle) => {
      const vehicleId = String(vehicle.vehicle_id);
      const lastSeenMs = Date.parse(vehicle.last_seen || '');
      const toolDetail = await getVehicleDetail(vehicleId).catch((error) => ({
        ok: false,
        error: error.message || 'vehicle_detail_failed'
      }));
      const toolNames = extractToolNamesFromVehicleDetail(toolDetail);
      const hasStatusTool = toolNames.includes('patrol_flow.status');
      const hasFlushTool = toolNames.includes('patrol_flow.flush_upload_queue');
      let collectorStatus = null;
      if (includeStatus && hasStatusTool) {
        collectorStatus = summarizePatrolFlowCollectorResult(
          await callVehicleTool(vehicleId, 'patrol_flow.status', {}, patrolFlowToolTimeoutS)
        );
      }
      return {
        vehicle_id: vehicleId,
        plate_number: vehicle.plate_number || null,
        last_seen: vehicle.last_seen || null,
        last_seen_age_s: Number.isFinite(lastSeenMs) ? Math.max(0, Math.round((nowMs - lastSeenMs) / 1000)) : null,
        fresh: Number.isFinite(lastSeenMs) && nowMs - lastSeenMs <= freshVehicleMs,
        tool_count: toolNames.length || vehicle.tool_count || null,
        tools: {
          has_status_tool: hasStatusTool,
          has_flush_tool: hasFlushTool,
          patrol_flow_tools: toolNames.filter((name) => /^patrol_flow\./.test(name))
        },
        status: collectorStatus,
        detail_error: toolDetail.ok === false ? toolDetail.error : null
      };
    });

    const withStatusTool = collectors.filter((row) => row.tools.has_status_tool);
    const withFlushTool = collectors.filter((row) => row.tools.has_flush_tool);
    const running = collectors.filter((row) => row.status?.script_running === true);
    const pendingUpload = collectors.filter((row) => Number(row.status?.queue?.pending_count || 0) > 0);
    return {
      ok: true,
      generated_at: nowIso(),
      elapsed_ms: Date.now() - startedAt,
      config: {
        include_status: includeStatus,
        max_vehicles: maxVehicles,
        timeout_s: patrolFlowToolTimeoutS,
        flush_timeout_s: patrolFlowFlushTimeoutS,
        concurrency: patrolFlowToolConcurrency
      },
      counts: {
        scanned: collectors.length,
        with_status_tool: withStatusTool.length,
        with_flush_tool: withFlushTool.length,
        running: running.length,
        pending_upload: pendingUpload.length,
        not_updated: collectors.length - withStatusTool.length
      },
      collectors
    };
  }

  async function runPatrolFlowFlush(params) {
    params = params || {};
    const vehicleIds = normalizeVehicleIds(params.vehicle_ids || params.vehicle_id);
    if (!vehicleIds.length) {
      const error = new Error('vehicle_id_required');
      error.status = 400;
      throw error;
    }
    const args = params.args && typeof params.args === 'object' && !Array.isArray(params.args)
      ? params.args
      : {};
    const uniqueVehicleIds = [...new Set(vehicleIds)].slice(0, 24);
    const startedAt = Date.now();
    const results = await mapWithConcurrency(uniqueVehicleIds, patrolFlowToolConcurrency, async (vehicleId) => {
      const detail = await getVehicleDetail(vehicleId).catch((error) => ({
        ok: false,
        error: error.message || 'vehicle_detail_failed'
      }));
      if (detail.ok === false) {
        return {
          vehicle_id: vehicleId,
          ok: false,
          error: detail.error || 'vehicle_detail_failed'
        };
      }
      const toolNames = extractToolNamesFromVehicleDetail(detail);
      if (!toolNames.includes('patrol_flow.flush_upload_queue')) {
        return {
          vehicle_id: vehicleId,
          ok: false,
          error: 'patrol_flow_flush_tool_missing',
          patrol_flow_tools: toolNames.filter((name) => /^patrol_flow\./.test(name))
        };
      }
      const toolCall = await callVehicleTool(vehicleId, 'patrol_flow.flush_upload_queue', args, patrolFlowFlushTimeoutS);
      return {
        vehicle_id: vehicleId,
        ...summarizePatrolFlowFlushResult(toolCall)
      };
    });
    return {
      ok: true,
      generated_at: nowIso(),
      elapsed_ms: Date.now() - startedAt,
      requested_vehicle_count: uniqueVehicleIds.length,
      success_count: results.filter((item) => item.ok === true).length,
      failed_count: results.filter((item) => item.ok !== true).length,
      results
    };
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
      image_url: crowdRedactedFrameUrl(imageRelPath),
      position: context.position,
      patrol_state: context.patrol_state || null,
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
        kind: 'park_people_flow_collection',
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
      const patrolToolTimeoutS = Math.max(statusToolTimeoutS, 12);
      const { patrolState } = await classifyCrowdPatrolForVehicle(vehicle, nowMs, patrolToolTimeoutS);
      if (!patrolState.capture_eligible) {
        return {
          ok: true,
          skipped: true,
          reason: 'not_patrol',
          vehicle_id: vehicleId,
          vehicle_last_seen: vehicle.last_seen || null,
          elapsed_ms: Date.now() - startedAt,
          patrol_state: patrolState
        };
      }

      const localization = await callVehicleTool(vehicleId, 'status.localization', {}, Math.max(statusToolTimeoutS, 12));
      if (!localization.ok) {
        const error = new Error(localization.error || 'status.localization_failed');
        error.status = localization.status || 502;
        throw error;
      }
      const position = extractLocalizationPosition(localization);
      const hasPosition = Number.isFinite(position.latitude) && Number.isFinite(position.longitude);
      if (!hasPosition || position.reliable !== true) {
        return {
          ok: true,
          skipped: true,
          reason: !hasPosition ? 'position_unavailable' : 'position_unreliable',
          vehicle_id: vehicleId,
          vehicle_last_seen: vehicle.last_seen || null,
          elapsed_ms: Date.now() - startedAt,
          patrol_state: patrolState,
          position
        };
      }

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
      const distanceReady = distanceFromLastM == null || distanceFromLastM >= distanceGateM;
      const cooldownReady = ageMs == null || ageMs >= cooldownMs;
      if (!force && (!distanceReady || !cooldownReady)) {
        return {
          ok: true,
          skipped: true,
          reason: !distanceReady
              ? 'distance_gate_not_reached'
              : 'capture_cooldown_not_ready',
          vehicle_id: vehicleId,
          vehicle_last_seen: vehicle.last_seen || null,
          elapsed_ms: Date.now() - startedAt,
          patrol_state: patrolState,
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
            patrol_state: patrolState,
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
        patrol_state: patrolState,
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
        patrol_state: sample.patrol_state,
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

  async function runCrowdMonitorTick(trigger) {
    if (!crowdMonitorEnabled) {
      await writeCrowdMonitorState({
        enabled: false,
        last_trigger: trigger,
        last_result: {
          ok: true,
          skipped: true,
          detail: 'crowd_monitor_disabled'
        }
      }).catch(() => {});
      return null;
    }
    if (crowdMonitorInFlight || crowdCaptureInFlight) {
      const skipped = {
        enabled: true,
        last_trigger: trigger,
        last_attempt_at: nowIso(),
        last_result: {
          ok: true,
          skipped: true,
          reason: crowdMonitorInFlight ? 'monitor_in_flight' : 'capture_in_flight'
        }
      };
      await writeCrowdMonitorState(skipped).catch(() => {});
      return skipped;
    }

    crowdMonitorInFlight = true;
    const startedAt = Date.now();
    const startedIso = nowIso();
    try {
      await writeCrowdMonitorState({
        enabled: true,
        last_trigger: trigger,
        last_attempt_at: startedIso,
        last_result: {
          ok: true,
          in_progress: true,
          skipped: false
        }
      }).catch(() => {});
      const patrolStatus = await buildCrowdPatrolStatus({
        max_vehicles: crowdMonitorMaxVehicles,
        include_unknown: false
      });
      const eligibleRows = Array.isArray(patrolStatus.patrols) ? patrolStatus.patrols : [];
      const eligible = eligibleRows.map((row) => ({
        vehicle_id: row.vehicle_id,
        state: row.patrol_state && row.patrol_state.state,
        reasons: row.patrol_state && Array.isArray(row.patrol_state.reasons) ? row.patrol_state.reasons : []
      }));
      const attempts = [];
      let captured = 0;
      let attemptedCaptures = 0;
      for (const row of eligibleRows) {
        const vehicleId = String(row.vehicle_id || '');
        if (!vehicleId) continue;
        if (captured >= crowdMonitorMaxCaptures || attemptedCaptures >= crowdMonitorMaxAttempts) {
          continue;
        }
        attemptedCaptures += 1;
        try {
          const sample = await runCrowdDemoCapture({
            vehicle_id: vehicleId,
            distance_m: crowdMonitorDistanceM,
            cooldown_ms: crowdMonitorCooldownMs,
            quality: crowdMonitorQuality,
            max_width: crowdMonitorMaxWidth,
            camera_ids: ['camera1', 'camera2', 'camera3', 'camera4'],
            force: false
          });
          if (!sample.skipped) {
            captured += 1;
          }
          attempts.push({
            vehicle_id: vehicleId,
            ok: sample.ok === true,
            skipped: sample.skipped === true,
            reason: sample.reason || null,
            frame_count: sample.frame_count || 0,
            total_image_bytes: sample.total_image_bytes || 0,
            elapsed_ms: sample.elapsed_ms || null
          });
        } catch (error) {
          attempts.push({
            vehicle_id: vehicleId,
            ok: false,
            skipped: false,
            error: error.message || 'crowd_monitor_capture_failed',
            status: error.status || null
          });
        }
      }

      const result = {
        enabled: true,
        last_trigger: trigger,
        last_attempt_at: startedIso,
        last_finished_at: nowIso(),
        last_result: {
          ok: true,
          skipped: false,
          elapsed_ms: Date.now() - startedAt,
          scanned: patrolStatus.counts?.scanned || 0,
          eligible_count: eligible.length,
          capture_attempt_count: attempts.length,
          captured_count: captured,
          eligible: eligible.slice(0, 12),
          attempts
        },
        config: {
          interval_ms: crowdMonitorIntervalMs,
          max_vehicles: crowdMonitorMaxVehicles,
          max_captures: crowdMonitorMaxCaptures,
          max_attempts: crowdMonitorMaxAttempts,
          distance_m: crowdMonitorDistanceM,
          cooldown_ms: crowdMonitorCooldownMs,
          quality: crowdMonitorQuality,
          max_width: crowdMonitorMaxWidth,
          camera_ids: ['camera1', 'camera2', 'camera3', 'camera4']
        }
      };
      await writeCrowdMonitorState(result);
      return result;
    } catch (error) {
      const result = {
        enabled: true,
        last_trigger: trigger,
        last_attempt_at: startedIso,
        last_finished_at: nowIso(),
        last_result: {
          ok: false,
          skipped: false,
          error: error.message || 'crowd_monitor_failed',
          status: error.status || null,
          elapsed_ms: Date.now() - startedAt
        }
      };
      await writeCrowdMonitorState(result).catch(() => {});
      return result;
    } finally {
      crowdMonitorInFlight = false;
    }
  }

  function parseCrowdAnalysisJson(text) {
    const raw = String(text || '').trim();
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const body = fenced ? fenced[1].trim() : raw;
    try {
      return JSON.parse(body);
    } catch (_error) {
      const match = raw.match(/"?people_count"?\s*[:：]\s*"?(\d+)"?/i);
      return match ? { people_count: Number(match[1]), raw_reply: raw.slice(0, 500) } : { raw_reply: raw.slice(0, 500) };
    }
  }

  function normalizePeopleCount(value) {
    const num = Number(value);
    return Number.isFinite(num) && num >= 0 ? Math.round(num) : null;
  }

  const CROWD_ANALYSIS_FEATURE_SCHEMA = 'park_crowd_anonymous_people_features.v3';
  const CROWD_FEATURE_MAP_KEYS = {
    age_groups: ['child', 'teenager', 'adult', 'elderly', 'unknown'],
    age_stage_groups: ['junior', 'youth', 'middle', 'senior', 'unknown'],
    gender_groups: ['male', 'female', 'unknown'],
    person_attributes: ['visitor', 'business', 'couple', 'family', 'staff', 'security', 'cleaner', 'delivery', 'maintenance', 'vendor', 'student', 'unknown'],
    mobility_types: ['wheelchair', 'cane_or_walker', 'stroller', 'assisted_walking', 'slow_moving', 'large_baggage', 'unknown'],
    role_types: ['visitor', 'staff', 'security', 'cleaner', 'delivery', 'maintenance', 'vendor', 'student', 'volunteer', 'unknown'],
    activity_types: ['walking', 'standing', 'sitting_or_resting', 'queueing', 'gathering', 'running', 'cycling', 'scooter_or_ebike', 'taking_photo', 'shopping_or_pickup', 'crossing_road', 'near_water', 'unknown'],
    group_types: ['single', 'pair', 'family_parent_child', 'elderly_group', 'student_group', 'tour_group', 'work_crew', 'queue', 'gathering']
  };

  function normalizeFeatureKey(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^\w]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  function normalizeFeatureCountMap(value, allowedKeys) {
    const allowed = new Set(allowedKeys || []);
    const result = {};
    if (Array.isArray(value)) {
      value.forEach((item) => {
        const key = normalizeFeatureKey(item);
        if (allowed.has(key)) result[key] = (result[key] || 0) + 1;
      });
      return result;
    }
    if (!value || typeof value !== 'object') return result;
    Object.entries(value).forEach(([rawKey, rawCount]) => {
      const key = normalizeFeatureKey(rawKey);
      if (!allowed.has(key)) return;
      const count = normalizePeopleCount(rawCount);
      if (count != null && count > 0) result[key] = count;
    });
    return result;
  }

  function sumFeatureCountMaps(items, key) {
    const result = {};
    items.forEach((item) => {
      const map = item && item[key] && typeof item[key] === 'object' ? item[key] : {};
      Object.entries(map).forEach(([rawKey, rawCount]) => {
        const count = normalizePeopleCount(rawCount);
        if (count == null || count <= 0) return;
        result[rawKey] = (result[rawKey] || 0) + count;
      });
    });
    return result;
  }

  function normalizeStringListForAnalysis(value, limit) {
    const raw = Array.isArray(value) ? value : (typeof value === 'string' && value.trim() ? value.split(/[,，、]/) : []);
    return raw
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .map((item) => item.slice(0, 48))
      .slice(0, Number.isFinite(Number(limit)) ? Number(limit) : 8);
  }

  function normalizeConfidence(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return ['low', 'medium', 'high'].includes(normalized) ? normalized : 'low';
  }

  function parseGreenInspectionJson(text) {
    const raw = String(text || '').trim();
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const body = fenced ? fenced[1].trim() : raw;
    try {
      return JSON.parse(body);
    } catch (_error) {
      return { raw_reply: raw.slice(0, 800) };
    }
  }

  function normalizeGreenIndicator(value, allowedValues) {
    const normalized = normalizeFeatureKey(value);
    return allowedValues.includes(normalized) ? normalized : 'unknown';
  }

  function normalizeGreenInspection(raw, context) {
    const payload = raw && typeof raw === 'object' ? raw : {};
    const vegetationPresent = payload.vegetation_present === true;
    const confidence = normalizeConfidence(payload.confidence);
    const scoreValue = Number(payload.health_score);
    const healthScore = vegetationPresent && Number.isFinite(scoreValue)
      ? Math.max(0, Math.min(100, Math.round(scoreValue)))
      : null;
    const indicators = payload.indicators && typeof payload.indicators === 'object' ? payload.indicators : {};
    const normalizedIndicators = {
      canopy_density: normalizeGreenIndicator(indicators.canopy_density, ['sparse', 'moderate', 'dense', 'unknown']),
      leaf_color: normalizeGreenIndicator(indicators.leaf_color, ['normal', 'slight_yellowing', 'severe_yellowing', 'unknown']),
      drought_stress: normalizeGreenIndicator(indicators.drought_stress, ['none', 'possible', 'clear', 'unknown']),
      pest_or_disease: normalizeGreenIndicator(indicators.pest_or_disease, ['none', 'possible', 'clear', 'unknown']),
      dead_or_broken_branches: normalizeGreenIndicator(indicators.dead_or_broken_branches, ['none', 'possible', 'clear', 'unknown']),
      shrub_condition: normalizeGreenIndicator(indicators.shrub_condition, ['good', 'fair', 'poor', 'unknown']),
      groundcover_condition: normalizeGreenIndicator(indicators.groundcover_condition, ['good', 'fair', 'poor', 'unknown']),
      overgrowth_or_encroachment: normalizeGreenIndicator(indicators.overgrowth_or_encroachment, ['none', 'possible', 'clear', 'unknown'])
    };
    const issues = (Array.isArray(payload.issues) ? payload.issues : [])
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const type = normalizeFeatureKey(item.type);
        const issueConfidence = normalizeConfidence(item.confidence);
        const severity = normalizeGreenIndicator(item.severity, ['low', 'medium', 'high']);
        const evidence = String(item.evidence || '').trim().slice(0, 220);
        if (!GREEN_INSPECTION_ISSUE_TYPES.has(type) || !['medium', 'high'].includes(issueConfidence) || !evidence) {
          return null;
        }
        return {
          type,
          severity: severity === 'unknown' ? 'low' : severity,
          confidence: issueConfidence,
          camera_ids: normalizeStringListForAnalysis(item.camera_ids, 4)
            .map((cameraId) => normalizeFeatureKey(cameraId))
            .filter((cameraId) => /^camera[1-4]$/.test(cameraId)),
          evidence
        };
      })
      .filter(Boolean)
      .slice(0, 6);
    const issueTypes = new Set(issues.map((issue) => issue.type));
    const recommendations = issues.length
      ? (Array.isArray(payload.recommendations) ? payload.recommendations : [])
          .map((item) => {
            if (!item || typeof item !== 'object') return null;
            const relatedIssueType = normalizeFeatureKey(item.related_issue_type);
            const action = String(item.action || '').trim().slice(0, 120);
            const reason = String(item.reason || '').trim().slice(0, 180);
            const priority = normalizeGreenIndicator(item.priority, ['routine', 'soon', 'urgent']);
            if (!action || !reason || !issueTypes.has(relatedIssueType)) return null;
            return {
              action,
              reason,
              priority: priority === 'unknown' ? 'routine' : priority,
              related_issue_type: relatedIssueType
            };
          })
          .filter(Boolean)
          .slice(0, 5)
      : [];
    const maxSeverity = issues.reduce((current, issue) => {
      const rank = { low: 1, medium: 2, high: 3 };
      return (rank[issue.severity] || 0) > (rank[current] || 0) ? issue.severity : current;
    }, 'low');
    const status = !vegetationPresent
      ? 'not_assessable'
      : issues.length
        ? maxSeverity === 'high' ? 'issue' : 'attention'
        : 'clear';
    const vegetationTypes = payload.vegetation_types && typeof payload.vegetation_types === 'object'
      ? {
          trees: payload.vegetation_types.trees === true,
          shrubs: payload.vegetation_types.shrubs === true,
          lawn_or_groundcover: payload.vegetation_types.lawn_or_groundcover === true
        }
      : { trees: false, shrubs: false, lawn_or_groundcover: false };
    const summary = !vegetationPresent
      ? '植被在四路画面中不够清晰，暂不判断健康状态。'
      : issues.length
        ? String(payload.summary || issues[0].evidence).trim().slice(0, 260)
        : '四路画面未发现中高可信度的明显绿化异常。';
    return {
      schema: GREEN_INSPECTION_SCHEMA,
      sample_id: String(context.sample_id || ''),
      vehicle_id: context.vehicle_id || null,
      collected_at: context.collected_at || null,
      position: context.position || null,
      status,
      vegetation_present: vegetationPresent,
      vegetation_types: vegetationTypes,
      confidence,
      health_score: healthScore,
      health_grade: !vegetationPresent || healthScore == null
        ? 'not_assessable'
        : healthScore >= 80 ? 'good' : healthScore >= 60 ? 'fair' : 'poor',
      indicators: normalizedIndicators,
      issues,
      recommendations,
      summary,
      model: greenInspectionModel,
      frame_count_evaluated: Number(context.frame_count_evaluated) || 0,
      analyzed_at: nowIso()
    };
  }

  function normalizeRiskHints(value) {
    const rows = Array.isArray(value) ? value : [];
    return rows
      .map((item) => {
        if (typeof item === 'string') {
          return {
            type: normalizeFeatureKey(item).slice(0, 48),
            confidence: 'low',
            note: ''
          };
        }
        if (!item || typeof item !== 'object') return null;
        const type = normalizeFeatureKey(item.type || item.risk || item.name).slice(0, 48);
        if (!type) return null;
        return {
          type,
          confidence: normalizeConfidence(item.confidence),
          note: String(item.note || '').slice(0, 120)
        };
      })
      .filter(Boolean)
      .slice(0, 8);
  }

  function aggregateRiskHints(frameAnalyses) {
    const confidenceScore = { low: 1, medium: 2, high: 3 };
    const merged = {};
    frameAnalyses.forEach((frame) => {
      (Array.isArray(frame?.risk_hints) ? frame.risk_hints : []).forEach((risk) => {
        const type = normalizeFeatureKey(risk.type);
        if (!type) return;
        const current = merged[type] || {
          type,
          count: 0,
          confidence: 'low',
          notes: []
        };
        current.count += 1;
        if (confidenceScore[risk.confidence] > confidenceScore[current.confidence]) {
          current.confidence = risk.confidence;
        }
        if (risk.note && current.notes.length < 2) current.notes.push(risk.note);
        merged[type] = current;
      });
    });
    return Object.values(merged)
      .sort((left, right) => {
        if (right.count !== left.count) return right.count - left.count;
        return (confidenceScore[right.confidence] || 0) - (confidenceScore[left.confidence] || 0);
      })
      .slice(0, 10)
      .map((risk) => ({
        type: risk.type,
        count: risk.count,
        confidence: risk.confidence,
        note: risk.notes.join('；')
      }));
  }

  function imageMimeFromPath(imagePath) {
    const ext = path.extname(String(imagePath || '')).toLowerCase();
    if (ext === '.png') return 'image/png';
    if (ext === '.webp') return 'image/webp';
    return 'image/jpeg';
  }

  async function prepareGreenInspectionImage(imageBuffer, imagePath) {
    try {
      const sharp = require('sharp');
      const prepared = await sharp(imageBuffer)
        .rotate()
        .resize({
          width: GREEN_INSPECTION_IMAGE_MAX_SIZE,
          height: GREEN_INSPECTION_IMAGE_MAX_SIZE,
          fit: 'inside',
          withoutEnlargement: true
        })
        .jpeg({ quality: GREEN_INSPECTION_IMAGE_QUALITY, mozjpeg: true })
        .toBuffer();
      return { buffer: prepared, mime_type: 'image/jpeg' };
    } catch (_error) {
      return { buffer: imageBuffer, mime_type: imageMimeFromPath(imagePath) };
    }
  }

  function isMissingCrowdFrameError(error) {
    if (!error) return false;
    if (error.code === 'ENOENT') return true;
    const message = String(error.message || '');
    return message.includes('ENOENT') || message === 'crowd_frame_source_missing';
  }

  function sendMissingCrowdFramePlaceholder(res) {
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">
  <rect width="640" height="480" fill="#020617"/>
  <rect x="26" y="26" width="588" height="428" rx="18" fill="#0f172a" stroke="#334155" stroke-width="2"/>
  <path d="M236 206h168v92H236z" fill="#1e293b" stroke="#475569" stroke-width="2"/>
  <circle cx="276" cy="236" r="14" fill="#64748b"/>
  <path d="M252 282l44-42 34 29 26-24 42 37z" fill="#475569"/>
  <text x="320" y="342" text-anchor="middle" font-family="Arial, sans-serif" font-size="30" font-weight="700" fill="#cbd5e1">没有了</text>
</svg>`;
    res.status(200);
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Crowd-Frame-Missing', '1');
    return res.send(svg);
  }

  function resolveCrowdFramePath(relativePath, rootPath) {
    const cleanRelativePath = String(relativePath || '').replace(/^\/+/, '');
    const targetPath = path.resolve(rootPath, cleanRelativePath);
    const resolvedRootPath = path.resolve(rootPath);
    if (!targetPath.startsWith(`${resolvedRootPath}${path.sep}`)) {
      const error = new Error('invalid_crowd_frame_path');
      error.status = 400;
      throw error;
    }
    return {
      clean_relative_path: cleanRelativePath,
      target_path: targetPath,
      root_path: resolvedRootPath
    };
  }

  async function ensureRedactedCrowdFrame(relativePath) {
    await ensureCrowdRuntimeDirs();
    const source = resolveCrowdFramePath(relativePath, crowdFramesRoot);
    const output = resolveCrowdFramePath(source.clean_relative_path, crowdRedactedFramesRoot);
    const [sourceStat, outputStat] = await Promise.all([
      fsp.stat(source.target_path),
      fsp.stat(output.target_path).catch(() => null)
    ]);
    if (outputStat && outputStat.mtimeMs >= sourceStat.mtimeMs && outputStat.size > 0) {
      return output.target_path;
    }
    await fsp.mkdir(path.dirname(output.target_path), { recursive: true });
    const outputExt = path.extname(output.target_path) || '.jpg';
    const tmpPath = `${output.target_path}.${process.pid}.${Date.now()}.tmp${outputExt}`;
    const script = String.raw`
import cv2, os, sys
src, dst = sys.argv[1], sys.argv[2]
person_model_path = sys.argv[3] if len(sys.argv) > 3 else ""
img = cv2.imread(src)
if img is None:
    raise RuntimeError("image_read_failed")
height, width = img.shape[:2]
gray = cv2.equalizeHist(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY))
cascade_dir = getattr(cv2.data, "haarcascades", "")
cascade_paths = [
    os.path.join(cascade_dir, "haarcascade_frontalface_alt2.xml"),
    os.path.join(cascade_dir, "haarcascade_frontalface_default.xml"),
]
eye_paths = [
    os.path.join(cascade_dir, "haarcascade_eye_tree_eyeglasses.xml"),
    os.path.join(cascade_dir, "haarcascade_eye.xml"),
]
eye_detectors = []
for eye_path in eye_paths:
    if eye_path and os.path.exists(eye_path):
        detector = cv2.CascadeClassifier(eye_path)
        if not detector.empty():
            eye_detectors.append(detector)

def face_has_eye_evidence(x, y, w, h):
    if w < 34 or h < 34:
        return True
    roi_gray = gray[y:y + h, x:x + w]
    if roi_gray.size <= 0:
        return False
    upper = roi_gray[0:max(1, int(h * 0.62)), :]
    min_eye = max(5, int(min(w, h) * 0.10))
    for detector in eye_detectors:
        eyes = detector.detectMultiScale(
            upper,
            scaleFactor=1.08,
            minNeighbors=4,
            minSize=(min_eye, min_eye),
        )
        centers = []
        for (ex, ey, ew, eh) in eyes:
            ex, ey, ew, eh = int(ex), int(ey), int(ew), int(eh)
            if ew <= 0 or eh <= 0:
                continue
            aspect = ew / float(eh)
            if aspect < 0.45 or aspect > 2.4:
                continue
            cx = ex + ew / 2.0
            cy = ey + eh / 2.0
            if cy > h * 0.62:
                continue
            centers.append((cx, cy, ew, eh))
        if len(centers) >= 2:
            centers.sort(key=lambda item: item[0])
            for left_index in range(len(centers)):
                for right_index in range(left_index + 1, len(centers)):
                    left, right = centers[left_index], centers[right_index]
                    horizontal_gap = right[0] - left[0]
                    vertical_gap = abs(right[1] - left[1])
                    if horizontal_gap >= w * 0.18 and horizontal_gap <= w * 0.74 and vertical_gap <= h * 0.18:
                        return True
        elif len(centers) == 1:
            cx, cy, ew, eh = centers[0]
            if w <= 60 and h <= 60 and w * 0.22 <= cx <= w * 0.78 and h * 0.12 <= cy <= h * 0.55:
                return True
    return False

faces = []
for detector_index, cascade_path in enumerate(cascade_paths):
    if not cascade_path or not os.path.exists(cascade_path):
        continue
    detector = cv2.CascadeClassifier(cascade_path)
    if detector.empty():
        continue
    found = detector.detectMultiScale(
        gray,
        scaleFactor=1.08,
        minNeighbors=8 if detector_index == 0 else 9,
        minSize=(28, 28),
    )
    for (x, y, w, h) in found:
        x, y, w, h = int(x), int(y), int(w), int(h)
        if w <= 0 or h <= 0:
            continue
        aspect = w / float(h)
        area_ratio = (w * h) / float(max(1, width * height))
        if aspect < 0.72 or aspect > 1.36:
            continue
        if area_ratio < 0.0012 or area_ratio > 0.045:
            continue
        if not face_has_eye_evidence(x, y, w, h):
            continue
        faces.append((x, y, w, h))

def add_person_head_candidates():
    if not person_model_path or not os.path.exists(person_model_path):
        return
    try:
        from ultralytics import YOLO
        model = YOLO(person_model_path)
        results = model.predict(
            source=src,
            imgsz=640,
            conf=0.38,
            iou=0.45,
            device="cpu",
            verbose=False,
        )
        for result in results:
            names = getattr(result, "names", {}) or {}
            boxes = getattr(result, "boxes", None)
            if boxes is None:
                continue
            for box in boxes:
                cls = int(box.cls[0])
                label = names.get(cls, str(cls))
                if label != "person":
                    continue
                conf = float(box.conf[0])
                if conf < 0.38:
                    continue
                x1, y1, x2, y2 = [float(value) for value in box.xyxy[0].tolist()]
                bw = x2 - x1
                bh = y2 - y1
                if bw < 18 or bh < 55:
                    continue
                if (bw * bh) / float(max(1, width * height)) > 0.35:
                    continue
                head_h = max(22, int(bh * 0.28))
                head_w = max(20, int(min(bw * 0.90, head_h * 1.05)))
                cx = (x1 + x2) / 2.0
                hx = int(round(cx - head_w / 2.0))
                hy = int(round(y1))
                faces.append((max(0, hx), max(0, hy), head_w, head_h))
    except Exception:
        return

add_person_head_candidates()
if faces:
    faces.sort(key=lambda box: box[2] * box[3], reverse=True)
    kept = []
    for (x, y, w, h) in faces:
        cx, cy = x + w / 2.0, y + h / 2.0
        duplicate = False
        for (kx, ky, kw, kh) in kept:
            kcx, kcy = kx + kw / 2.0, ky + kh / 2.0
            if abs(cx - kcx) < min(w, kw) * 0.45 and abs(cy - kcy) < min(h, kh) * 0.45:
                duplicate = True
                break
        if duplicate:
            continue
        kept.append((x, y, w, h))
    for (x, y, w, h) in kept:
        pad_x = max(2, int(w * 0.08))
        pad_y = max(2, int(h * 0.10))
        x1 = max(0, x - pad_x)
        y1 = max(0, y - pad_y)
        x2 = min(img.shape[1], x + w + pad_x)
        y2 = min(img.shape[0], y + h + pad_y)
        if x2 <= x1 or y2 <= y1:
            continue
        roi = img[y1:y2, x1:x2]
        block_w = max(1, min(18, roi.shape[1] // 6 or 1))
        block_h = max(1, min(18, roi.shape[0] // 6 or 1))
        small = cv2.resize(roi, (block_w, block_h), interpolation=cv2.INTER_LINEAR)
        mosaic = cv2.resize(small, (roi.shape[1], roi.shape[0]), interpolation=cv2.INTER_NEAREST)
        img[y1:y2, x1:x2] = mosaic
ok = cv2.imwrite(dst, img, [int(cv2.IMWRITE_JPEG_QUALITY), 86])
if not ok:
    raise RuntimeError("image_write_failed")
print(len(faces))
`;
    try {
      await execFileAsync('python3', ['-c', script, source.target_path, tmpPath, crowdRedactionPersonModelPath], {
        timeout: 30000,
        maxBuffer: 64 * 1024
      });
      await fsp.rename(tmpPath, output.target_path);
      return output.target_path;
    } catch (error) {
      await fsp.rm(tmpPath, { force: true }).catch(() => {});
      const wrapped = new Error(error.message || 'crowd_frame_redaction_failed');
      wrapped.status = 500;
      throw wrapped;
    }
  }

  async function analyzeCrowdFrame(frame) {
    const imageRelPath = String(frame?.image_path || '').trim();
    const imageAbsPath = path.resolve(crowdFramesRoot, imageRelPath);
    const framesRootResolved = path.resolve(crowdFramesRoot);
    if (!imageAbsPath.startsWith(`${framesRootResolved}${path.sep}`)) {
      throw new Error('invalid_crowd_frame_path');
    }
    const imageBuffer = await fsp.readFile(imageAbsPath);
    const imageBase64 = imageBuffer.toString('base64');
    const prompt =
      '你在做园区巡逻车的人流画像分析。只分析这张单路相机图片中可见的真实人体和随身/伴随物，不数雕塑、海报、倒影。' +
      '必须匿名聚合，不做人脸识别，不识别具体身份，不推断民族、宗教、疾病、收入、政治观点等敏感身份。' +
      '性别只做画面中可见外观的粗略聚合估计，不代表真实性别身份；看不清必须计入 unknown。' +
      '客群阶段只做运营分组估计，不输出具体年龄，不判断单个人的精确年龄；远处、遮挡、模糊或不确定时计入 unknown。' +
      '只输出紧凑 JSON，不要 Markdown，不要解释。所有分类键必须使用下面给定英文键；看不清就归 unknown 或低置信度。各分类合计不得超过 people_count。' +
      'age_stage_groups 四档含义仅供你内部判断：junior=7-17，youth=18-44，middle=45-59，senior=60+；输出只给英文键。' +
      'person_attributes 按画面上下文和同行关系判断：普通游客、商务人士、情侣、家庭、园区工作人员、安保、保洁、配送、维修施工、商户摊位、学生；不确定计入 unknown。' +
      '格式：{"people_count":0,"confidence":"low|medium|high","age_groups":{"child":0,"teenager":0,"adult":0,"elderly":0,"unknown":0},' +
      '"age_stage_groups":{"junior":0,"youth":0,"middle":0,"senior":0,"unknown":0},' +
      '"gender_groups":{"male":0,"female":0,"unknown":0},' +
      '"person_attributes":{"visitor":0,"business":0,"couple":0,"family":0,"staff":0,"security":0,"cleaner":0,"delivery":0,"maintenance":0,"vendor":0,"student":0,"unknown":0},' +
      '"mobility_types":{"wheelchair":0,"cane_or_walker":0,"stroller":0,"assisted_walking":0,"slow_moving":0,"large_baggage":0,"unknown":0},' +
      '"activity_types":{"walking":0,"standing":0,"sitting_or_resting":0,"queueing":0,"gathering":0,"running":0,"cycling":0,"scooter_or_ebike":0,"taking_photo":0,"shopping_or_pickup":0,"crossing_road":0,"near_water":0,"unknown":0},' +
      '"group_types":{"single":0,"pair":0,"family_parent_child":0,"elderly_group":0,"student_group":0,"tour_group":0,"work_crew":0,"queue":0,"gathering":0},' +
      '"risk_hints":[{"type":"child_near_road|child_near_water|elderly_needs_care|mobility_barrier|crowd_gathering|queue_congestion|mixed_traffic|night_stay|construction_near_people","confidence":"low|medium|high","note":"中文短句"}],"scene_tags":["中文短标签"],"note":"中文简短说明"}。';
    const response = await fetch(crowdAnalysisChatUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: crowdAnalysisModel,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: `data:${imageMimeFromPath(imageRelPath)};base64,${imageBase64}`
                }
              },
              {
                type: 'text',
                text: prompt
              }
            ]
          }
        ],
        max_tokens: 900,
        temperature: 0,
        stream: false,
        chat_template_kwargs: {
          enable_thinking: false
        }
      }),
      signal: AbortSignal.timeout(crowdAnalysisTimeoutMs)
    });
    const rawText = await response.text();
    const payload = safeJsonParse(rawText, null);
    if (!response.ok) {
      const error = new Error(rawText.slice(0, 240) || `crowd_analysis_http_${response.status}`);
      error.status = response.status;
      throw error;
    }
    const reply = String(payload?.choices?.[0]?.message?.content || payload?.choices?.[0]?.message?.reasoning || '').trim();
    const parsed = parseCrowdAnalysisJson(reply);
    const peopleCount = normalizePeopleCount(parsed.people_count);
    const featureMaps = {};
    Object.entries(CROWD_FEATURE_MAP_KEYS).forEach(([key, allowedKeys]) => {
      featureMaps[key] = normalizeFeatureCountMap(parsed[key], allowedKeys);
    });
    return {
      status: peopleCount == null ? 'needs_review' : 'done',
      feature_schema: CROWD_ANALYSIS_FEATURE_SCHEMA,
      people_count: peopleCount,
      confidence: normalizeConfidence(parsed.confidence),
      ...featureMaps,
      risk_hints: normalizeRiskHints(parsed.risk_hints),
      scene_tags: normalizeStringListForAnalysis(parsed.scene_tags, 8),
      note: String(parsed.note || parsed.raw_reply || '').slice(0, 300),
      model: crowdAnalysisModel,
      analyzed_at: nowIso()
    };
  }

  async function analyzeCrowdSample(sample) {
    const frames = Array.isArray(sample?.frames) ? sample.frames.slice(0, 4) : [];
    const frameResults = {};
    for (const frame of frames) {
      const frameKey = frame.capture_id || frame.camera_id || `frame_${Object.keys(frameResults).length + 1}`;
      try {
        frameResults[frameKey] = await analyzeCrowdFrame(frame);
      } catch (error) {
        frameResults[frameKey] = {
          status: 'error',
          feature_schema: CROWD_ANALYSIS_FEATURE_SCHEMA,
          people_count: null,
          confidence: 'low',
          note: error.message || 'crowd_frame_analysis_failed',
          model: crowdAnalysisModel,
          analyzed_at: nowIso()
        };
      }
    }
    const counts = Object.values(frameResults)
      .map((item) => normalizePeopleCount(item.people_count))
      .filter((value) => value != null);
    const allDone = frames.length > 0 && counts.length === frames.length;
    const analyzedFrames = Object.values(frameResults).filter((item) => item && item.status !== 'error');
    const aggregateFeatureMaps = {};
    Object.keys(CROWD_FEATURE_MAP_KEYS).forEach((key) => {
      aggregateFeatureMaps[key] = sumFeatureCountMaps(analyzedFrames, key);
    });
    return {
      frames: frameResults,
      aggregate: {
        status: allDone ? 'done' : counts.length ? 'partial' : 'needs_review',
        feature_schema: CROWD_ANALYSIS_FEATURE_SCHEMA,
        people_count: counts.length ? counts.reduce((sum, value) => sum + value, 0) : null,
        max_single_camera_people: counts.length ? Math.max(...counts) : null,
        frame_count_analyzed: Object.keys(frameResults).length,
        ...aggregateFeatureMaps,
        risk_hints: aggregateRiskHints(analyzedFrames),
        scene_tags: normalizeStringListForAnalysis([].concat(...analyzedFrames.map((item) => item.scene_tags || [])), 12),
        model: crowdAnalysisModel,
        analyzed_at: nowIso(),
        note: '匿名聚合分析：people_count 与各类人群特征为四路相机可见结果合计；max_single_camera_people 为单路最大值，供重叠视角保守参考。'
      }
    };
  }

  async function analyzeGreenInspectionSample(sample) {
    const frames = Array.isArray(sample?.frames) ? sample.frames.slice(0, 4) : [];
    const content = [
      {
        type: 'text',
        text:
          '你是园区绿化养护巡检员。下面是同一采集节点车辆前后左右四路相机画面。只评估画面中可见的树木、灌木、绿篱、草坪和地被植物；忽略人、车、建筑和广告。' +
          '四路可能有重叠，不要重复计数。不得猜测具体植物品种，不得凭模糊画面断言病虫害或缺水。光照、季节、阴影、逆光、落叶期和画质不足都要降低置信度。' +
          '只有中高置信度且能指出具体画面证据的问题才能写入 issues；不确定迹象只放到 indicators 的 possible，不得写成问题。没有明确问题时 issues 和 recommendations 必须为空。' +
          'health_score 为整体可见植被健康度 0-100；植被不足以判断时 vegetation_present=false 且 health_score=null。养护建议必须逐条对应 issues，不能为了完整而硬写。' +
          '只输出 JSON，不要 Markdown。格式：' +
          '{"vegetation_present":true,"vegetation_types":{"trees":true,"shrubs":false,"lawn_or_groundcover":false},"confidence":"low|medium|high","health_score":85,' +
          '"indicators":{"canopy_density":"sparse|moderate|dense|unknown","leaf_color":"normal|slight_yellowing|severe_yellowing|unknown","drought_stress":"none|possible|clear|unknown",' +
          '"pest_or_disease":"none|possible|clear|unknown","dead_or_broken_branches":"none|possible|clear|unknown","shrub_condition":"good|fair|poor|unknown",' +
          '"groundcover_condition":"good|fair|poor|unknown","overgrowth_or_encroachment":"none|possible|clear|unknown"},' +
          '"issues":[{"type":"yellowing_or_wilting|drought_stress|pest_or_disease|dead_or_broken_branch|overgrowth_or_encroachment|missing_or_bare_patch|support_or_tree_grate_problem",' +
          '"severity":"low|medium|high","confidence":"medium|high","camera_ids":["camera1"],"evidence":"中文具体可见证据"}],' +
          '"recommendations":[{"action":"中文养护动作","priority":"routine|soon|urgent","reason":"中文依据","related_issue_type":"对应问题英文键"}],"summary":"中文简短结论"}。'
      }
    ];
    let evaluatedFrames = 0;
    for (const frame of frames) {
      const imageRelPath = String(frame?.image_path || '').trim();
      if (!imageRelPath) continue;
      const image = resolveCrowdFramePath(imageRelPath, crowdFramesRoot);
      let imageBuffer;
      try {
        imageBuffer = await fsp.readFile(image.target_path);
      } catch (_error) {
        continue;
      }
      const preparedImage = await prepareGreenInspectionImage(imageBuffer, imageRelPath);
      const cameraId = normalizeFeatureKey(frame?.camera_id || `camera${evaluatedFrames + 1}`);
      content.push({ type: 'text', text: `视角 ${cameraId}` });
      content.push({
        type: 'image_url',
        image_url: {
          url: `data:${preparedImage.mime_type};base64,${preparedImage.buffer.toString('base64')}`
        }
      });
      evaluatedFrames += 1;
    }
    if (!evaluatedFrames) {
      const error = new Error('green_inspection_images_unavailable');
      error.status = 404;
      throw error;
    }
    const response = await fetch(greenInspectionChatUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: greenInspectionModel,
        messages: [{ role: 'user', content }],
        max_tokens: 1100,
        temperature: 0,
        stream: false,
        chat_template_kwargs: { enable_thinking: false }
      }),
      signal: AbortSignal.timeout(greenInspectionTimeoutMs)
    });
    const rawText = await response.text();
    const payload = safeJsonParse(rawText, null);
    if (!response.ok) {
      const error = new Error(rawText.slice(0, 240) || `green_inspection_http_${response.status}`);
      error.status = response.status;
      throw error;
    }
    const reply = String(payload?.choices?.[0]?.message?.content || payload?.choices?.[0]?.message?.reasoning || '').trim();
    return normalizeGreenInspection(parseGreenInspectionJson(reply), {
      sample_id: sample.sample_id,
      vehicle_id: sample.vehicle_id,
      collected_at: sample.collected_at,
      position: sample.position,
      frame_count_evaluated: evaluatedFrames
    });
  }

  function drainGreenInspectionQueue() {
    while (greenInspectionActive < greenInspectionConcurrency && greenInspectionQueue.length) {
      const entry = greenInspectionQueue.shift();
      greenInspectionActive += 1;
      Promise.resolve()
        .then(entry.task)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          greenInspectionActive = Math.max(0, greenInspectionActive - 1);
          drainGreenInspectionQueue();
        });
    }
  }

  function enqueueGreenInspection(task) {
    if (greenInspectionQueue.length >= greenInspectionPendingLimit) {
      const error = new Error('green_inspection_queue_full');
      error.status = 429;
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      greenInspectionQueue.push({ task, resolve, reject });
      drainGreenInspectionQueue();
    });
  }

  function isCurrentGreenInspection(inspection) {
    return Boolean(
      inspection &&
      inspection.schema === GREEN_INSPECTION_SCHEMA &&
      String(inspection.model || '') === greenInspectionModel
    );
  }

  function greenInspectionCandidateSamples(samples, nowMs = Date.now()) {
    const cutoffMs = nowMs - greenInspectionAutoLookbackHours * 60 * 60 * 1000;
    const rows = new Map();
    (Array.isArray(samples) ? samples : []).forEach((sample) => {
      const sampleId = String(sample?.sample_id || '').trim();
      const collectedAtMs = Date.parse(sample?.collected_at || '');
      const frames = (Array.isArray(sample?.frames) ? sample.frames : [])
        .filter((frame) => String(frame?.image_path || '').trim())
        .slice(0, 4);
      if (
        !sampleId ||
        sample?.skipped ||
        !Number.isFinite(collectedAtMs) ||
        collectedAtMs < cutoffMs ||
        !frames.length
      ) {
        return;
      }
      if (!rows.has(sampleId)) rows.set(sampleId, sample);
    });
    return [...rows.values()].sort((left, right) => (
      (Date.parse(right.collected_at || '') || 0) - (Date.parse(left.collected_at || '') || 0)
    ));
  }

  function greenInspectionFrameCount(samples) {
    return (Array.isArray(samples) ? samples : []).reduce((sum, sample) => (
      sum + (Array.isArray(sample?.frames)
        ? sample.frames.filter((frame) => String(frame?.image_path || '').trim()).slice(0, 4).length
        : 0)
    ), 0);
  }

  async function buildGreenInspectionQueueSnapshot() {
    const [inspectionState, workerState, samples] = await Promise.all([
      readGreenInspectionState(),
      readGreenInspectionWorkerState(),
      readCrowdSampleLog(greenInspectionAutoScanLimit)
    ]);
    const candidates = greenInspectionCandidateSamples(samples);
    const completed = [];
    const pending = [];
    const retryWaiting = [];
    const failed = [];
    const ready = [];
    const now = Date.now();
    candidates.forEach((sample) => {
      const sampleId = String(sample.sample_id);
      if (isCurrentGreenInspection(inspectionState.samples?.[sampleId])) {
        completed.push(sample);
        return;
      }
      const failure = workerState.failures?.[sampleId];
      const attempts = Number(failure?.attempts) || 0;
      if (attempts >= greenInspectionAutoMaxAttempts) {
        failed.push(sample);
        return;
      }
      pending.push(sample);
      const nextRetryAt = Date.parse(failure?.next_retry_at || '');
      if (Number.isFinite(nextRetryAt) && nextRetryAt > now) {
        retryWaiting.push(sample);
      } else {
        ready.push(sample);
      }
    });
    return {
      inspectionState,
      workerState,
      candidates,
      completed,
      pending,
      retryWaiting,
      failed,
      ready,
      public: {
        enabled: greenInspectionAutoEnabled,
        model: greenInspectionModel,
        base_url: greenInspectionBaseUrl,
        lookback_hours: greenInspectionAutoLookbackHours,
        scan_limit: greenInspectionAutoScanLimit,
        source_node_count: candidates.length,
        source_frame_count: greenInspectionFrameCount(candidates),
        analyzed_node_count: completed.length,
        analyzed_frame_count: greenInspectionFrameCount(completed),
        pending_node_count: pending.length,
        pending_frame_count: greenInspectionFrameCount(pending),
        ready_node_count: ready.length,
        retry_waiting_node_count: retryWaiting.length,
        failed_node_count: failed.length,
        stale_result_node_count: candidates.reduce((count, sample) => {
          const inspection = inspectionState.samples?.[sample.sample_id];
          return count + (inspection && !isCurrentGreenInspection(inspection) ? 1 : 0);
        }, 0),
        worker_in_flight: greenInspectionWorkerInFlight,
        current_sample_id: greenInspectionWorkerCurrentSampleId || workerState.current_sample_id || null,
        process_queue_active: greenInspectionActive,
        process_queue_waiting: greenInspectionQueue.length,
        last_attempt_at: workerState.last_attempt_at || null,
        last_success_at: workerState.last_success_at || null,
        last_result: workerState.last_result || null,
        updated_at: workerState.updated_at || null
      }
    };
  }

  function startGreenInspectionJob(sample) {
    const sampleId = String(sample?.sample_id || '').trim();
    if (!sampleId) {
      const error = new Error('green_inspection_sample_id_required');
      error.status = 400;
      return Promise.reject(error);
    }
    const existing = greenInspectionInFlight.get(sampleId);
    if (existing) return existing;
    const job = enqueueGreenInspection(async () => {
      const inspection = await analyzeGreenInspectionSample(sample);
      await writeGreenInspectionState({ samples: { [sampleId]: inspection } });
      return inspection;
    });
    const tracked = job.finally(() => {
      if (greenInspectionInFlight.get(sampleId) === tracked) greenInspectionInFlight.delete(sampleId);
    });
    greenInspectionInFlight.set(sampleId, tracked);
    return tracked;
  }

  async function runGreenInspectionWorkerTick(trigger = 'timer') {
    if (!greenInspectionAutoEnabled || greenInspectionWorkerInFlight) return null;
    greenInspectionWorkerInFlight = true;
    const startedAt = Date.now();
    let leaseClaimed = false;
    try {
      leaseClaimed = await claimGreenInspectionWorkerLease();
      if (!leaseClaimed) return null;
      const snapshot = await buildGreenInspectionQueueSnapshot();
      const selected = snapshot.ready[0] || null;
      const failures = { ...(snapshot.workerState.failures || {}) };
      const candidateIds = new Set(snapshot.candidates.map((sample) => String(sample.sample_id)));
      const completedIds = new Set(snapshot.completed.map((sample) => String(sample.sample_id)));
      Object.keys(failures).forEach((sampleId) => {
        if (!candidateIds.has(sampleId) || completedIds.has(sampleId)) delete failures[sampleId];
      });
      if (!selected) {
        const workerState = {
          ...snapshot.workerState,
          failures,
          current_sample_id: null,
          last_attempt_at: nowIso(),
          last_result: {
            ok: true,
            trigger,
            processed_count: 0,
            reason: snapshot.pending.length ? 'retry_backoff' : 'queue_empty',
            pending_node_count: snapshot.pending.length,
            retry_waiting_node_count: snapshot.retryWaiting.length,
            failed_node_count: snapshot.failed.length,
            elapsed_ms: Date.now() - startedAt
          },
          config: snapshot.public
        };
        await writeGreenInspectionWorkerState(workerState);
        return workerState;
      }

      const sampleId = String(selected.sample_id);
      greenInspectionWorkerCurrentSampleId = sampleId;
      await writeGreenInspectionWorkerState({
        ...snapshot.workerState,
        failures,
        current_sample_id: sampleId,
        last_attempt_at: nowIso(),
        config: snapshot.public
      });
      try {
        const inspection = await startGreenInspectionJob(selected);
        delete failures[sampleId];
        const workerState = {
          ...snapshot.workerState,
          failures,
          current_sample_id: null,
          last_attempt_at: nowIso(),
          last_success_at: nowIso(),
          last_result: {
            ok: true,
            trigger,
            processed_count: 1,
            sample_id: sampleId,
            vehicle_id: selected.vehicle_id || null,
            status: inspection.status,
            model: inspection.model,
            pending_node_count: Math.max(0, snapshot.pending.length - 1),
            retry_waiting_node_count: snapshot.retryWaiting.length,
            failed_node_count: snapshot.failed.length,
            elapsed_ms: Date.now() - startedAt
          },
          config: snapshot.public
        };
        await writeGreenInspectionWorkerState(workerState);
        return workerState;
      } catch (error) {
        const previous = failures[sampleId] || {};
        const attempts = (Number(previous.attempts) || 0) + 1;
        const retryDelayMs = Math.min(
          greenInspectionAutoRetryMaxMs,
          greenInspectionAutoRetryBaseMs * (2 ** Math.max(0, attempts - 1))
        );
        failures[sampleId] = {
          attempts,
          last_attempt_at: nowIso(),
          last_error: String(error.message || 'green_inspection_failed').slice(0, 500),
          last_status: error.status || null,
          next_retry_at: attempts >= greenInspectionAutoMaxAttempts
            ? null
            : new Date(Date.now() + retryDelayMs).toISOString()
        };
        const terminal = attempts >= greenInspectionAutoMaxAttempts;
        const workerState = {
          ...snapshot.workerState,
          failures,
          current_sample_id: null,
          last_attempt_at: nowIso(),
          last_result: {
            ok: false,
            trigger,
            processed_count: 0,
            sample_id: sampleId,
            vehicle_id: selected.vehicle_id || null,
            error: failures[sampleId].last_error,
            status: error.status || null,
            attempts,
            terminal,
            pending_node_count: terminal ? Math.max(0, snapshot.pending.length - 1) : snapshot.pending.length,
            retry_waiting_node_count: snapshot.retryWaiting.length + (terminal ? 0 : 1),
            failed_node_count: snapshot.failed.length + (terminal ? 1 : 0),
            elapsed_ms: Date.now() - startedAt
          },
          config: snapshot.public
        };
        await writeGreenInspectionWorkerState(workerState);
        return workerState;
      }
    } finally {
      greenInspectionWorkerCurrentSampleId = '';
      if (leaseClaimed) await releaseGreenInspectionWorkerLease().catch(() => {});
      greenInspectionWorkerInFlight = false;
    }
  }

  async function getCrowdAnalysisIdleStatus() {
    if (!crowdAnalysisIdleOnly) {
      return {
        idle: true,
        checked: false,
        reason: 'idle_check_disabled'
      };
    }
    try {
      const { stdout } = await execFileAsync(
        'nvidia-smi',
        ['--query-gpu=index,utilization.gpu', '--format=csv,noheader,nounits'],
        {
          timeout: crowdAnalysisIdleCheckTimeoutMs,
          maxBuffer: 16 * 1024
        }
      );
      const rows = String(stdout || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [indexText, utilText] = line.split(',').map((item) => item.trim());
          return {
            index: Number(indexText),
            util_pct: Number(utilText)
          };
        })
        .filter((row) => Number.isFinite(row.index) && Number.isFinite(row.util_pct));
      if (!rows.length) {
        return {
          idle: false,
          checked: true,
          reason: 'gpu_util_unavailable',
          threshold_pct: crowdAnalysisIdleGpuUtilMax
        };
      }
      const maxGpuUtilPct = Math.max(...rows.map((row) => row.util_pct));
      return {
        idle: maxGpuUtilPct <= crowdAnalysisIdleGpuUtilMax,
        checked: true,
        max_gpu_util_pct: maxGpuUtilPct,
        threshold_pct: crowdAnalysisIdleGpuUtilMax,
        gpu_count: rows.length
      };
    } catch (error) {
      return {
        idle: false,
        checked: false,
        reason: error.message || 'gpu_idle_check_failed',
        threshold_pct: crowdAnalysisIdleGpuUtilMax
      };
    }
  }

  async function runCrowdAnalysisTick(trigger) {
    if (!crowdAnalysisEnabled) {
      return null;
    }
    if (crowdAnalysisInFlight) {
      return null;
    }
    crowdAnalysisInFlight = true;
    const startedAt = Date.now();
    try {
      const idleStatus = await getCrowdAnalysisIdleStatus();
      if (trigger !== 'manual' && !idleStatus.idle) {
        const state = await readCrowdAnalysisState();
        const nextState = {
          ...state,
          last_trigger: trigger,
          last_attempt_at: nowIso(),
          last_result: {
            ok: true,
            skipped: true,
            reason: 'gpu_not_idle',
            idle_status: idleStatus,
            analyzed_count: 0,
            attempts: [],
            elapsed_ms: Date.now() - startedAt
          },
          config: {
            enabled: crowdAnalysisEnabled,
            interval_ms: crowdAnalysisIntervalMs,
            max_samples_per_tick: crowdAnalysisMaxSamples,
            model: crowdAnalysisModel,
            base_url: crowdAnalysisBaseUrl,
            timeout_ms: crowdAnalysisTimeoutMs,
            idle_only: crowdAnalysisIdleOnly,
            idle_gpu_util_max_pct: crowdAnalysisIdleGpuUtilMax
          }
        };
        await writeCrowdAnalysisState(nextState);
        return nextState;
      }
      const [state, samples] = await Promise.all([
        readCrowdAnalysisState(),
        readCrowdSampleLog(1000)
      ]);
      let analyzed = 0;
      const attempts = [];
      for (const sample of samples) {
        if (analyzed >= crowdAnalysisMaxSamples) break;
        if (!sample || sample.skipped || !sample.sample_id || !Array.isArray(sample.frames) || !sample.frames.length) {
          continue;
        }
        const existing = state.samples[sample.sample_id];
        const existingAggregate = existing?.aggregate || {};
        const effectiveExistingAggregate = preferServerReviewedCrowdAnalysis(existingAggregate);
        const existingHasCurrentFeatureSchema =
          effectiveExistingAggregate.feature_schema === CROWD_ANALYSIS_FEATURE_SCHEMA &&
          effectiveExistingAggregate.age_stage_groups &&
          typeof effectiveExistingAggregate.age_stage_groups === 'object' &&
          effectiveExistingAggregate.gender_groups &&
          typeof effectiveExistingAggregate.gender_groups === 'object' &&
          effectiveExistingAggregate.person_attributes &&
          typeof effectiveExistingAggregate.person_attributes === 'object';
        if (['done', 'vehicle_estimate_server_reviewed'].includes(effectiveExistingAggregate.status) && existingHasCurrentFeatureSchema) {
          continue;
        }
        const sampleAnalysis = mergeServerAnalysisWithVehicleEstimate(sample, await analyzeCrowdSample(sample));
        state.samples[sample.sample_id] = {
          sample_id: sample.sample_id,
          vehicle_id: sample.vehicle_id || null,
          collected_at: sample.collected_at || null,
          position: sample.position || null,
          source: sample.source || null,
          upload_session_id: sample.upload_session_id || null,
          ...sampleAnalysis
        };
        attempts.push({
          sample_id: sample.sample_id,
          vehicle_id: sample.vehicle_id || null,
          people_count: sampleAnalysis.aggregate.people_count,
          max_single_camera_people: sampleAnalysis.aggregate.max_single_camera_people,
          status: sampleAnalysis.aggregate.status
        });
        analyzed += 1;
      }
      const nextState = {
        ...state,
        last_trigger: trigger,
        last_attempt_at: nowIso(),
        last_result: {
          ok: true,
          analyzed_count: analyzed,
          attempts,
          idle_status: idleStatus,
          elapsed_ms: Date.now() - startedAt
        },
        config: {
          enabled: crowdAnalysisEnabled,
          interval_ms: crowdAnalysisIntervalMs,
          max_samples_per_tick: crowdAnalysisMaxSamples,
          model: crowdAnalysisModel,
          base_url: crowdAnalysisBaseUrl,
          timeout_ms: crowdAnalysisTimeoutMs,
          idle_only: crowdAnalysisIdleOnly,
          idle_gpu_util_max_pct: crowdAnalysisIdleGpuUtilMax
        }
      };
      await writeCrowdAnalysisState(nextState);
      return nextState;
    } catch (error) {
      const state = await readCrowdAnalysisState().catch(() => ({ version: 1, samples: {} }));
      await writeCrowdAnalysisState({
        ...state,
        last_trigger: trigger,
        last_attempt_at: nowIso(),
        last_result: {
          ok: false,
          error: error.message || 'crowd_analysis_failed',
          status: error.status || null,
          elapsed_ms: Date.now() - startedAt
        }
      }).catch(() => {});
      return null;
    } finally {
      crowdAnalysisInFlight = false;
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

  async function buildCrowdReportSnapshot() {
    const startedAt = Date.now();
    const nowMs = Date.now();
    const [vehicles, samples] = await Promise.all([
      listVehicles().catch(() => []),
      readRecentCrowdSamples(100, { source: VEHICLE_PATROL_FLOW_SAMPLE_SOURCE })
    ]);
    const validVehicles = vehicles.filter((vehicle) => vehicle && vehicle.vehicle_id);
    const freshVehicles = validVehicles.filter((vehicle) => {
      const lastSeenMs = Date.parse(vehicle.last_seen || '');
      return Number.isFinite(lastSeenMs) && nowMs - lastSeenMs <= freshVehicleMs;
    });
    const dayAgoMs = nowMs - 24 * 60 * 60 * 1000;
    const confirmedSamples = samples
      .filter((sample) => sample && !sample.skipped)
      .filter((sample) => sample.patrol_state && sample.patrol_state.capture_eligible === true);
    const recentSamples = confirmedSamples.filter((sample) => {
      const collectedAtMs = Number(sample.collected_at_ms || Date.parse(sample.collected_at || ''));
      return Number.isFinite(collectedAtMs) && collectedAtMs >= dayAgoMs;
    });
    const vehicleIds = new Set(recentSamples.map((sample) => sample.vehicle_id).filter(Boolean));
    return {
      ok: true,
      generated_at: nowIso(),
      elapsed_ms: Date.now() - startedAt,
      in_flight: crowdCaptureInFlight,
      vehicle: {
        total: validVehicles.length,
        fresh: freshVehicles.length,
        stale: Math.max(0, validVehicles.length - freshVehicles.length)
      },
      capture: {
        sample_count_24h: recentSamples.length,
        frame_count_24h: recentSamples.reduce((sum, sample) => sum + (Number(sample.frame_count) || 0), 0),
        total_image_bytes_24h: recentSamples.reduce((sum, sample) => sum + (Number(sample.total_image_bytes) || 0), 0),
        vehicle_count_24h: vehicleIds.size
      },
      config: {
        camera_ids: ['camera1', 'camera2', 'camera3', 'camera4'],
        quality: 45,
        max_width: 480,
        distance_m: crowdCaptureDistanceM,
        cooldown_ms: crowdCaptureCooldownMs
      },
      latest_samples: confirmedSamples.slice(0, 8)
    };
  }

  async function sendCrowdReport(report, trigger) {
    const text = formatCrowdReportText(report);
    try {
      const result = await sendFeishuText(text);
      await writeReportState({
        report_kind: 'park_people_flow_collection',
        last_trigger: trigger,
        last_attempt_at: nowIso(),
        last_snapshot_at: report.generated_at,
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
        report_kind: 'park_people_flow_collection',
        last_trigger: trigger,
        last_attempt_at: nowIso(),
        last_snapshot_at: report.generated_at,
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
      const report = await buildCrowdReportSnapshot();
      await sendCrowdReport(report, trigger);
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

  function scheduleNextCrowdMonitor(delayMs) {
    if (!crowdMonitorEnabled) {
      return;
    }
    if (crowdMonitorTimer) {
      clearTimeout(crowdMonitorTimer);
    }
    crowdMonitorTimer = setTimeout(() => {
      void runCrowdMonitorTick('timer').finally(() => {
        scheduleNextCrowdMonitor(crowdMonitorIntervalMs);
      });
    }, delayMs);
    if (typeof crowdMonitorTimer.unref === 'function') {
      crowdMonitorTimer.unref();
    }
  }

  function scheduleNextCrowdAnalysis(delayMs) {
    if (!crowdAnalysisEnabled) {
      return;
    }
    if (crowdAnalysisTimer) {
      clearTimeout(crowdAnalysisTimer);
    }
    crowdAnalysisTimer = setTimeout(() => {
      void runCrowdAnalysisTick('timer').finally(() => {
        scheduleNextCrowdAnalysis(crowdAnalysisIntervalMs);
      });
    }, delayMs);
    if (typeof crowdAnalysisTimer.unref === 'function') {
      crowdAnalysisTimer.unref();
    }
  }

  function scheduleNextGreenInspection(delayMs) {
    if (!greenInspectionAutoEnabled) return;
    if (greenInspectionWorkerTimer) clearTimeout(greenInspectionWorkerTimer);
    greenInspectionWorkerTimer = setTimeout(() => {
      void runGreenInspectionWorkerTick('timer')
        .catch((error) => {
          console.warn(`green_inspection_worker_failed: ${error.message}`);
        })
        .finally(() => {
          scheduleNextGreenInspection(greenInspectionAutoIntervalMs);
        });
    }, delayMs);
    if (typeof greenInspectionWorkerTimer.unref === 'function') {
      greenInspectionWorkerTimer.unref();
    }
  }

  function scheduleNextCrowdStorageCleanup(delayMs) {
    if (crowdStorageCleanupTimer) {
      clearTimeout(crowdStorageCleanupTimer);
    }
    crowdStorageCleanupTimer = setTimeout(() => {
      void cleanupCrowdStorage()
        .catch((error) => {
          console.warn(`park_pcm_storage_cleanup_failed: ${error.message}`);
        })
        .finally(() => {
          scheduleNextCrowdStorageCleanup(crowdStorageCleanupIntervalMs);
        });
    }, delayMs);
    if (typeof crowdStorageCleanupTimer.unref === 'function') {
      crowdStorageCleanupTimer.unref();
    }
  }

  app.get('/api/park-pcm/status', requirePermission('vehicle:read'), async (_req, res) => {
    const [snapshot, reportState, monitorState, analysisState, uploadState] = await Promise.all([
      readJsonFile(snapshotPath),
      readJsonFile(reportStatePath),
      readCrowdMonitorState(),
      readCrowdAnalysisState(),
      readPatrolFlowUploadState()
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
      crowd_monitor: {
        enabled: crowdMonitorEnabled,
        interval_ms: crowdMonitorIntervalMs,
        boot_delay_ms: crowdMonitorBootDelayMs,
        in_flight: crowdMonitorInFlight,
        config: {
          max_vehicles: crowdMonitorMaxVehicles,
          max_captures: crowdMonitorMaxCaptures,
          max_attempts: crowdMonitorMaxAttempts,
          distance_m: crowdMonitorDistanceM,
          cooldown_ms: crowdMonitorCooldownMs,
          quality: crowdMonitorQuality,
          max_width: crowdMonitorMaxWidth,
          camera_ids: ['camera1', 'camera2', 'camera3', 'camera4']
        },
        state: monitorState
      },
      crowd_analysis: {
        enabled: crowdAnalysisEnabled,
        interval_ms: crowdAnalysisIntervalMs,
        boot_delay_ms: crowdAnalysisBootDelayMs,
        in_flight: crowdAnalysisInFlight,
        config: {
          model: crowdAnalysisModel,
          base_url: crowdAnalysisBaseUrl,
          max_samples_per_tick: crowdAnalysisMaxSamples,
          timeout_ms: crowdAnalysisTimeoutMs
        },
        state: analysisState
          ? {
              updated_at: analysisState.updated_at,
              last_trigger: analysisState.last_trigger,
              last_attempt_at: analysisState.last_attempt_at,
              last_result: analysisState.last_result,
              analyzed_sample_count: analysisState.samples ? Object.keys(analysisState.samples).length : 0
            }
          : null
      },
      patrol_flow_upload: {
        schema: PATROL_FLOW_SCHEMA_V1,
        endpoint: '/api/auto_ad/patrol-flow/upload',
        status_endpoint: '/api/auto_ad/patrol-flow/status',
        auth_token_required: Boolean(patrolFlowUploadToken),
        max_upload_bytes: patrolFlowUploadMaxBytes,
        max_frame_rows: patrolFlowMaxFrameRows,
        storage: {
          retention_days: crowdStorageRetentionDays,
          max_storage_bytes: crowdStorageMaxBytes,
          min_free_bytes: crowdStorageMinFreeBytes
        },
        state: summarizePatrolFlowUploadState(uploadState, 8)
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
          detail: '尚未生成园区巡检快照。'
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
          cooldown_ms: crowdCaptureCooldownMs,
          monitor: {
            enabled: crowdMonitorEnabled,
            interval_ms: crowdMonitorIntervalMs,
            max_vehicles: crowdMonitorMaxVehicles,
            max_captures: crowdMonitorMaxCaptures,
            distance_m: crowdMonitorDistanceM,
            cooldown_ms: crowdMonitorCooldownMs,
            quality: crowdMonitorQuality,
            max_width: crowdMonitorMaxWidth
          }
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

  app.get('/api/park-pcm/crowd/vehicles/:vehicle_id/detail', requirePermission('vehicle:read'), async (req, res) => {
    try {
      const detail = await buildCrowdVehicleDetail({
        vehicle_id: req.params?.vehicle_id
      });
      return res.json(detail);
    } catch (error) {
      return res.status(error.status || 502).json({
        ok: false,
        error: error.message || 'park_crowd_vehicle_detail_failed'
      });
    }
  });

  app.get('/api/park-pcm/crowd/samples', requirePermission('vehicle:read'), async (req, res) => {
    try {
      const requestedSource = String(req.query?.source || 'all').trim();
      const source = requestedSource && requestedSource !== 'all' ? requestedSource : '';
      const filters = {
        vehicle_id: req.query?.vehicle_id,
        source
      };
      const [samples, axisSamples, uploadState] = await Promise.all([
        readRecentCrowdSamples(req.query?.limit, filters),
        readCrowdSampleLogForAxis(filters),
        readPatrolFlowUploadState().catch(() => ({ sessions: {} }))
      ]);
      const axisState = buildCrowdSampleDayAxis(axisSamples);
      mergeCrowdUploadSessionsIntoDayAxis(axisState, uploadState.sessions, filters);
      return res.json({
        ok: true,
        vehicle_id: req.query?.vehicle_id ? String(req.query.vehicle_id) : null,
        source: source || 'all',
        day_axis: finalizeCrowdSampleDayAxis(axisState),
        samples
      });
    } catch (error) {
      return res.status(error.status || 502).json({
        ok: false,
        error: error.message || 'park_pcm_crowd_samples_failed'
      });
    }
  });

  app.get('/api/park-pcm/green/inspections', requirePermission('vehicle:read'), async (req, res) => {
    try {
      const vehicleId = String(req.query?.vehicle_id || '').trim();
      const date = String(req.query?.date || '').trim();
      const state = await readGreenInspectionState();
      const items = Object.values(state.samples || {})
        .filter((item) => item && item.schema === GREEN_INSPECTION_SCHEMA)
        .filter((item) => !vehicleId || String(item.vehicle_id || '') === vehicleId)
        .filter((item) => !date || crowdDayKey(new Date(item.collected_at || '')) === date)
        .sort((left, right) => Date.parse(right.collected_at || '') - Date.parse(left.collected_at || ''));
      const scored = items.map((item) => Number(item.health_score)).filter(Number.isFinite);
      const statusCounts = items.reduce((counts, item) => {
        const status = String(item.status || 'unknown');
        counts[status] = (counts[status] || 0) + 1;
        return counts;
      }, {});
      return res.json({
        ok: true,
        schema: GREEN_INSPECTION_SCHEMA,
        vehicle_id: vehicleId || null,
        date: date || null,
        summary: {
          analyzed_node_count: items.length,
          issue_count: items.reduce((sum, item) => sum + (Array.isArray(item.issues) ? item.issues.length : 0), 0),
          average_health_score: scored.length
            ? Math.round(scored.reduce((sum, value) => sum + value, 0) / scored.length)
            : null,
          status_counts: statusCounts
        },
        items,
        updated_at: state.updated_at || null
      });
    } catch (error) {
      return res.status(error.status || 500).json({
        ok: false,
        error: error.message || 'green_inspections_failed'
      });
    }
  });

  app.get('/api/park-pcm/green/status', requirePermission('vehicle:read'), async (_req, res) => {
    try {
      const snapshot = await buildGreenInspectionQueueSnapshot();
      return res.json({ ok: true, queue: snapshot.public });
    } catch (error) {
      return res.status(error.status || 500).json({
        ok: false,
        error: error.message || 'green_inspection_status_failed'
      });
    }
  });

  app.post('/api/park-pcm/green/worker/run', requirePermission('vehicle:read'), async (_req, res) => {
    try {
      const worker = await runGreenInspectionWorkerTick('manual');
      const snapshot = await buildGreenInspectionQueueSnapshot();
      return res.json({
        ok: true,
        worker: worker
          ? { updated_at: worker.updated_at, last_result: worker.last_result }
          : null,
        queue: snapshot.public
      });
    } catch (error) {
      return res.status(error.status || 502).json({
        ok: false,
        error: error.message || 'green_inspection_worker_failed'
      });
    }
  });

  app.post('/api/park-pcm/green/inspect', requirePermission('vehicle:read'), async (req, res) => {
    try {
      const sampleId = String(req.body?.sample_id || '').trim();
      const vehicleId = String(req.body?.vehicle_id || '').trim();
      const force = req.body?.force === true;
      if (!sampleId) {
        return res.status(400).json({ ok: false, error: 'green_inspection_sample_id_required' });
      }
      const state = await readGreenInspectionState();
      const cached = state.samples?.[sampleId];
      if (!force && isCurrentGreenInspection(cached)) {
        return res.json({ ok: true, cached: true, inspection: cached });
      }
      const samples = await readCrowdSampleLog(20000, { vehicle_id: vehicleId });
      const sample = samples.find((item) => String(item?.sample_id || '') === sampleId);
      if (!sample) {
        const error = new Error('green_inspection_sample_not_found');
        error.status = 404;
        throw error;
      }
      const inspection = await startGreenInspectionJob(sample);
      return res.json({ ok: true, cached: false, inspection });
    } catch (error) {
      return res.status(error.status || 502).json({
        ok: false,
        error: error.message || 'green_inspection_failed'
      });
    }
  });

  app.get('/api/park-pcm/crowd/report/pdf', requirePermission('vehicle:read'), async (req, res) => {
    let pdfPath = '';
    try {
      const report = await buildCrowdRangeReportPdf(req.query || {});
      pdfPath = report.pdf_path;
      res.setHeader('Cache-Control', 'private, no-store');
      return res.download(pdfPath, report.file_name, (error) => {
        if (error && !res.headersSent) {
          res.status(error.status || 502).json({
            ok: false,
            error: error.message || 'park_crowd_report_download_failed'
          });
        }
        if (pdfPath) {
          fsp.unlink(pdfPath).catch(() => {});
        }
      });
    } catch (error) {
      if (pdfPath) {
        fsp.unlink(pdfPath).catch(() => {});
      }
      return res.status(error.status || 502).json({
        ok: false,
        error: error.message || 'park_crowd_report_pdf_failed'
      });
    }
  });

  app.post('/api/park-pcm/crowd/routes', requirePermission('vehicle:read'), async (req, res) => {
    try {
      const requested = normalizeRouteRequestItems(req.body || {});
      const maxPoints = toFiniteInteger(req.body?.max_points, DEFAULT_CROWD_ROUTE_MAX_POINTS, { min: 80, max: 2000 });
      const routes = await mapWithConcurrency(requested, 4, async (item) => (
        readPatrolRouteFile(item.session_id, item.route_id, maxPoints)
      ));
      const foundRoutes = routes.filter(Boolean);
      return res.json({
        ok: true,
        requested_count: requested.length,
        route_count: foundRoutes.length,
        missing_count: Math.max(0, requested.length - foundRoutes.length),
        max_points: maxPoints,
        routes: foundRoutes
      });
    } catch (error) {
      return res.status(error.status || 502).json({
        ok: false,
        error: error.message || 'park_pcm_crowd_routes_failed'
      });
    }
  });

  app.post('/api/park-pcm/crowd/analyze/run', requirePermission('vehicle:read'), async (_req, res) => {
    try {
      const state = await runCrowdAnalysisTick('manual');
      return res.json({
        ok: true,
        analysis: state
          ? {
              updated_at: state.updated_at,
              last_result: state.last_result,
              analyzed_sample_count: state.samples ? Object.keys(state.samples).length : 0
            }
          : null
      });
    } catch (error) {
      return res.status(error.status || 502).json({
        ok: false,
        error: error.message || 'park_crowd_analysis_failed'
      });
    }
  });

  app.get('/api/park-pcm/crowd/patrols', requirePermission('vehicle:read'), async (req, res) => {
    try {
      const status = await buildCrowdPatrolStatus({
        max_vehicles: req.query?.max_vehicles,
        include_unknown: String(req.query?.include_unknown || '').toLowerCase() === 'true'
      });
      return res.json(status);
    } catch (error) {
      return res.status(error.status || 502).json({
        ok: false,
        error: error.message || 'park_pcm_crowd_patrol_status_failed'
      });
    }
  });

  app.get('/api/park-pcm/crowd/patrol-flow/collectors', requirePermission('vehicle:read'), async (req, res) => {
    try {
      const status = await buildPatrolFlowCollectorStatus({
        max_vehicles: req.query?.max_vehicles,
        vehicle_id: req.query?.vehicle_id,
        vehicle_ids: req.query?.vehicle_ids,
        include_status: String(req.query?.include_status || 'true').toLowerCase() !== 'false'
      });
      return res.json(status);
    } catch (error) {
      return res.status(error.status || 502).json({
        ok: false,
        error: error.message || 'park_pcm_patrol_flow_collectors_failed'
      });
    }
  });

  app.post('/api/park-pcm/crowd/patrol-flow/flush', requirePermission('vehicle:read'), async (req, res) => {
    try {
      const result = await runPatrolFlowFlush(req.body || {});
      return res.json(result);
    } catch (error) {
      return res.status(error.status || 502).json({
        ok: false,
        error: error.message || 'park_pcm_patrol_flow_flush_failed'
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

  app.post('/api/auto_ad/patrol-flow/upload', requirePatrolFlowUploadAuth, handlePatrolFlowUpload);
  app.put('/api/auto_ad/patrol-flow/upload', requirePatrolFlowUploadAuth, handlePatrolFlowUpload);
  app.get('/api/auto_ad/patrol-flow/status', requirePatrolFlowUploadAuth, async (_req, res) => {
    try {
      return res.json(await buildPatrolFlowUploadStatus({ session_limit: 8, log_limit: 8 }));
    } catch (error) {
      return res.status(error.status || 500).json({
        ok: false,
        error: error.message || 'patrol_flow_status_failed'
      });
    }
  });

  app.get('/api/park-pcm/crowd/uploads', requirePermission('vehicle:read'), async (req, res) => {
    try {
      return res.json(await buildPatrolFlowUploadStatus({
        session_limit: req.query?.limit,
        log_limit: req.query?.log_limit || req.query?.limit
      }));
    } catch (error) {
      return res.status(error.status || 500).json({
        ok: false,
        error: error.message || 'park_pcm_crowd_uploads_failed'
      });
    }
  });

  app.post('/api/park-pcm/crowd/cleanup', requirePermission('vehicle:read'), async (_req, res) => {
    try {
      const storage = await cleanupCrowdStorage();
      return res.json({
        ok: true,
        storage
      });
    } catch (error) {
      return res.status(error.status || 500).json({
        ok: false,
        error: error.message || 'park_pcm_crowd_cleanup_failed'
      });
    }
  });

  app.get('/api/park-pcm/crowd/files/*', requirePermission('vehicle:read'), async (req, res) => {
    try {
      const targetPath = await ensureRedactedCrowdFrame(req.params?.[0]);
      res.setHeader('Cache-Control', 'private, max-age=86400');
      return res.sendFile(targetPath, (error) => {
        if (error && !res.headersSent) {
          res.status(error.status || 404).json({
            ok: false,
            error: 'crowd_redacted_frame_not_found'
          });
        }
      });
    } catch (error) {
      if (isMissingCrowdFrameError(error)) {
        return sendMissingCrowdFramePlaceholder(res);
      }
      return res.status(error.status || 500).json({
        ok: false,
        error: error.message || 'crowd_frame_redaction_failed'
      });
    }
  });

  app.get('/api/park-pcm/crowd/redacted-files/*', requirePermission('vehicle:read'), async (req, res) => {
    try {
      const targetPath = await ensureRedactedCrowdFrame(req.params?.[0]);
      res.setHeader('Cache-Control', 'private, max-age=86400');
      return res.sendFile(targetPath, (error) => {
        if (error && !res.headersSent) {
          res.status(error.status || 404).json({
            ok: false,
            error: 'crowd_redacted_frame_not_found'
          });
        }
      });
    } catch (error) {
      if (isMissingCrowdFrameError(error)) {
        return sendMissingCrowdFramePlaceholder(res);
      }
      return res.status(error.status || 500).json({
        ok: false,
        error: error.message || 'crowd_frame_redaction_failed'
      });
    }
  });

  app.post('/api/park-pcm/report/send', requirePermission('vehicle:read'), async (req, res) => {
    try {
      const report = await buildCrowdReportSnapshot(req.body || {});
      const result = await sendCrowdReport(report, 'manual');
      return res.status(result.ok ? 200 : 502).json({
        ok: result.ok,
        report: result,
        crowd_report: report
      });
    } catch (error) {
      return res.status(error.status || 502).json({
        ok: false,
        error: error.message || 'park_pcm_report_failed'
      });
    }
  });

  scheduleNextReport(reportBootDelayMs);
  scheduleNextCrowdMonitor(crowdMonitorBootDelayMs);
  scheduleNextCrowdAnalysis(crowdAnalysisBootDelayMs);
  scheduleNextGreenInspection(greenInspectionAutoBootDelayMs);
  scheduleNextCrowdStorageCleanup(crowdStorageCleanupBootDelayMs);
};
