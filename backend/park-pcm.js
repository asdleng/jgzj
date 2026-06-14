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
    `采样：近 24 小时 ${capture.sample_count_24h || 0} 次，图片 ${capture.frame_count_24h || 0} 张，数据 ${formatByteCount(capture.total_image_bytes_24h)}`,
    `覆盖：近 24 小时车辆 ${capture.vehicle_count_24h || 0} 台，当前采样任务 ${report.in_flight ? '进行中' : '空闲'}`,
    `策略：只在确认巡逻任务后抓拍，4 路相机，默认距离 ${report.config?.distance_m || 0} m，冷却 ${Math.round((report.config?.cooldown_ms || 0) / 1000)} s`
  ];
  if (latest.length) {
    lines.push('最近采样：');
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
    lines.push('最近采样：暂无已确认巡逻的人流采样。');
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
    process.env.PARK_CROWD_RUNTIME_ROOT || process.env.PARK_PCM_RUNTIME_ROOT || path.join(rootDir, '.runtime/park-pcm')
  );
  const snapshotPath = path.join(runtimeRoot, 'last-snapshot.json');
  const reportStatePath = path.join(runtimeRoot, 'report-state.json');
  const crowdFramesRoot = path.join(runtimeRoot, 'crowd-frames');
  const crowdIndexLogPath = path.join(runtimeRoot, 'crowd-samples.jsonl');
  const crowdStatePath = path.join(runtimeRoot, 'crowd-capture-state.json');
  const crowdMonitorStatePath = path.join(runtimeRoot, 'crowd-monitor-state.json');
  const crowdAnalysisStatePath = path.join(runtimeRoot, 'crowd-analysis-state.json');
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
  let reportTimer = null;
  let crowdMonitorTimer = null;
  let crowdAnalysisTimer = null;

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

  async function writeCrowdAnalysisState(state) {
    await atomicWriteJson(crowdAnalysisStatePath, {
      version: 1,
      samples: {},
      ...(state || {}),
      updated_at: nowIso()
    });
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

  function mergeCrowdAnalysisIntoSample(sample, analysisState) {
    if (!sample || sample.skipped) return sample;
    const sampleAnalysis = analysisState?.samples?.[sample.sample_id];
    if (!sampleAnalysis) return sample;
    const framesByCaptureId = sampleAnalysis.frames && typeof sampleAnalysis.frames === 'object'
      ? sampleAnalysis.frames
      : {};
    return {
      ...sample,
      analysis: {
        ...(sample.analysis || {}),
        ...sampleAnalysis.aggregate
      },
      frames: Array.isArray(sample.frames)
        ? sample.frames.map((frame) => ({
            ...frame,
            analysis: {
              ...(frame.analysis || {}),
              ...(framesByCaptureId[frame.capture_id] || framesByCaptureId[frame.camera_id] || {})
            }
          }))
        : sample.frames
    };
  }

  async function readCrowdSampleLog(limit, filters) {
    const normalizedLimit = toFiniteInteger(limit, 20, { min: 1, max: 1000 });
    const vehicleId = String(filters?.vehicle_id || '').trim();
    try {
      const text = await fsp.readFile(crowdIndexLogPath, 'utf8');
      const rows = text
        .split('\n')
        .filter(Boolean)
        .map((line) => safeJsonParse(line, null))
        .filter(Boolean);
      const filteredRows = vehicleId
        ? rows.filter((sample) => String(sample?.vehicle_id || '') === vehicleId)
        : rows;
      return filteredRows
        .slice(-normalizedLimit)
        .reverse();
    } catch (_error) {
      return [];
    }
  }

  async function readRecentCrowdSamples(limit, filters) {
    const [samples, analysisState] = await Promise.all([
      readCrowdSampleLog(limit, filters),
      readCrowdAnalysisState()
    ]);
    return samples.map((sample) => mergeCrowdAnalysisIntoSample(sample, analysisState));
  }

  async function buildCrowdPatrolStatus(params) {
    params = params || {};
    const startedAt = Date.now();
    const maxVehicles = toFiniteInteger(params.max_vehicles, 60, { min: 1, max: 120 });
    const includeUnknown = params.include_unknown === true;
    const nowMs = Date.now();
    const [vehiclesRaw, samples, state] = await Promise.all([
      listVehicles(),
      readRecentCrowdSamples(100),
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
      readRecentCrowdSamples(100),
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

  function imageMimeFromPath(imagePath) {
    const ext = path.extname(String(imagePath || '')).toLowerCase();
    if (ext === '.png') return 'image/png';
    if (ext === '.webp') return 'image/webp';
    return 'image/jpeg';
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
      '你在做园区巡逻人流统计。请统计这张单路相机图片中可见的真实行人数量，只数真实人体，不数雕塑、海报、倒影。' +
      '只输出紧凑 JSON，不要 Markdown，不要解释。格式：{"people_count":0,"confidence":"low|medium|high","note":"中文简短说明"}。' +
      '看不清时给最佳估计并把 confidence 设为 low。';
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
        max_tokens: 160,
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
    return {
      status: peopleCount == null ? 'needs_review' : 'done',
      people_count: peopleCount,
      confidence: String(parsed.confidence || 'low').toLowerCase(),
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
    return {
      frames: frameResults,
      aggregate: {
        status: allDone ? 'done' : counts.length ? 'partial' : 'needs_review',
        people_count: counts.length ? counts.reduce((sum, value) => sum + value, 0) : null,
        max_single_camera_people: counts.length ? Math.max(...counts) : null,
        frame_count_analyzed: Object.keys(frameResults).length,
        model: crowdAnalysisModel,
        analyzed_at: nowIso(),
        note: 'people_count 为四路相机可见人数合计；max_single_camera_people 为单路最大值，供重叠视角保守参考。'
      }
    };
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
        if (existing?.aggregate?.status === 'done') {
          continue;
        }
        const sampleAnalysis = await analyzeCrowdSample(sample);
        state.samples[sample.sample_id] = {
          sample_id: sample.sample_id,
          vehicle_id: sample.vehicle_id || null,
          collected_at: sample.collected_at || null,
          position: sample.position || null,
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
      readRecentCrowdSamples(100)
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

  app.get('/api/park-pcm/status', requirePermission('vehicle:read'), async (_req, res) => {
    const [snapshot, reportState, monitorState, analysisState] = await Promise.all([
      readJsonFile(snapshotPath),
      readJsonFile(reportStatePath),
      readCrowdMonitorState(),
      readCrowdAnalysisState()
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
      const samples = await readRecentCrowdSamples(req.query?.limit, {
        vehicle_id: req.query?.vehicle_id
      });
      return res.json({
        ok: true,
        vehicle_id: req.query?.vehicle_id ? String(req.query.vehicle_id) : null,
        samples
      });
    } catch (error) {
      return res.status(error.status || 502).json({
        ok: false,
        error: error.message || 'park_pcm_crowd_samples_failed'
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
};
