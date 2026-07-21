import * as THREE from "three";
import { MapControls } from "three/addons/controls/MapControls.js";

const root = document.querySelector("[data-green-management]");

if (root) {
  const siteNav = document.querySelector(".site-nav");
  const syncNavigationOffset = () => {
    if (!siteNav) return;
    const height = Math.ceil(siteNav.getBoundingClientRect().height);
    if (height > 0) document.documentElement.style.setProperty("--gm-nav-height", `${height}px`);
  };
  syncNavigationOffset();
  if (siteNav && "ResizeObserver" in window) {
    const navigationObserver = new ResizeObserver(syncNavigationOffset);
    navigationObserver.observe(siteNav);
  }

  const API = {
    auth: "/api/auth/me",
    vehicles: "/api/park-pcm/green/vehicles",
    samples: "/api/park-pcm/green/samples",
    routes: "/api/park-pcm/crowd/routes",
    greenInspections: "/api/park-pcm/green/inspections",
    greenInspect: "/api/park-pcm/green/inspect",
    greenStatus: "/api/park-pcm/green/status"
  };
  const SAMPLE_LIMIT = 8000;
  const ROUTE_MAX_POINTS = 900;
  const ROUTE_MAX_REQUESTS = 12;
  const STATIC_MAP_SIZE = 1024;
  const WORLD_PER_PIXEL = 0.12;
  const VEGETATION_TABLE_PAGE_SIZE = 50;

  const el = {
    status: root.querySelector("[data-gm-status]"),
    auth: root.querySelector("[data-gm-auth]"),
    recordDate: root.querySelector("[data-gm-record-date]"),
    vehicle: root.querySelector("[data-gm-vehicle]"),
    date: root.querySelector("[data-gm-date]"),
    refresh: root.querySelector("[data-gm-refresh]"),
    reset: root.querySelector("[data-gm-reset]"),
    viewButtons: [...root.querySelectorAll("[data-gm-view]")],
    stage: root.querySelector("[data-gm-stage]"),
    map: root.querySelector("[data-gm-map]"),
    loading: root.querySelector("[data-gm-loading]"),
    loadProgress: root.querySelector("[data-gm-load-progress]"),
    loadProgressBar: root.querySelector("[data-gm-load-progress-bar]"),
    loadProgressLabel: root.querySelector("[data-gm-load-progress-label]"),
    mapError: root.querySelector("[data-gm-map-error]"),
    mapMeta: root.querySelector("[data-gm-map-meta]"),
    tooltip: root.querySelector("[data-gm-tooltip]"),
    hitLayer: root.querySelector("[data-gm-hit-layer]"),
    nodeTitle: root.querySelector("[data-gm-node-title]"),
    nodeHealth: root.querySelector("[data-gm-node-health]"),
    nodeMeta: root.querySelector("[data-gm-node-meta]"),
    frames: root.querySelector("[data-gm-frames]"),
    healthPanel: root.querySelector(".gm-health-panel"),
    healthScore: root.querySelector("[data-gm-health-score]"),
    healthGrade: root.querySelector("[data-gm-health-grade]"),
    scoreReason: root.querySelector("[data-gm-score-reason]"),
    indicators: root.querySelector("[data-gm-indicators]"),
    inspectionSummary: root.querySelector("[data-gm-inspection-summary]"),
    observations: root.querySelector("[data-gm-observations]"),
    issues: root.querySelector("[data-gm-issues]"),
    recommendations: root.querySelector("[data-gm-recommendations]"),
    vegetationTableBody: root.querySelector("[data-gm-vegetation-table-body]"),
    vegetationTableSummary: root.querySelector("[data-gm-vegetation-table-summary]"),
    vegetationFilters: [...root.querySelectorAll("[data-gm-vegetation-filter]")],
    vegetationFilterCounts: Object.fromEntries(
      [...root.querySelectorAll("[data-gm-filter-count]")]
        .map((node) => [node.dataset.gmFilterCount, node])
    ),
    vegetationTablePrev: root.querySelector("[data-gm-table-prev]"),
    vegetationTableNext: root.querySelector("[data-gm-table-next]"),
    vegetationTablePage: root.querySelector("[data-gm-table-page]"),
    timeline: root.querySelector("[data-gm-timeline]"),
    brief: root.querySelector("[data-gm-brief]"),
    briefTitle: root.querySelector("[data-gm-brief-title]"),
    briefMeta: root.querySelector("[data-gm-brief-meta]"),
    projects: root.querySelector("[data-gm-projects]"),
    projectSummary: root.querySelector("[data-gm-project-summary]"),
    preview: root.querySelector("[data-gm-preview]"),
    previewTitle: root.querySelector("[data-gm-preview-title]"),
    previewMeta: root.querySelector("[data-gm-preview-meta]"),
    previewImage: root.querySelector("[data-gm-preview-image]"),
    previewClose: root.querySelector("[data-gm-preview-close]")
  };
  el.metrics = Object.fromEntries(
    [...root.querySelectorAll("[data-gm-metric]")].map((node) => [node.dataset.gmMetric, node])
  );
  el.overview = Object.fromEntries(
    [...root.querySelectorAll("[data-gm-overview]")].map((node) => [node.dataset.gmOverview, node])
  );
  el.scoreBands = Object.fromEntries(
    [...root.querySelectorAll("[data-gm-band]")].map((node) => [node.dataset.gmBand, node])
  );
  el.scoreBandCounts = Object.fromEntries(
    [...root.querySelectorAll("[data-gm-band-count]")].map((node) => [node.dataset.gmBandCount, node])
  );
  el.vegetationTotals = Object.fromEntries(
    [...root.querySelectorAll("[data-gm-vegetation]")].map((node) => [node.dataset.gmVegetation, node])
  );
  el.progressBar = root.querySelector("[data-gm-progress-bar]");
  const state = {
    busy: false,
    authenticated: false,
    vehicleId: "",
    dateKey: "",
    allSamples: [],
    visibleSamples: [],
    routes: [],
    inspections: new Map(),
    inspectionDateKey: "",
    greenQueue: null,
    inspectionPending: new Set(),
    inspectionErrors: new Map(),
    selectedSampleId: "",
    vegetationFilter: "all",
    vegetationTablePage: 0,
    viewMode: "perspective",
    mapBuildId: 0,
    nodeMeshes: [],
    nodeAnchors: [],
    nodeIndexBySampleId: new Map(),
    nodePositions: new Map(),
    visibleSampleById: new Map(),
    selectedRing: null,
    sceneSpan: 120,
    scene: null,
    renderer: null,
    camera: null,
    controls: null,
    contentGroup: null,
    mapTexture: null,
    raycaster: new THREE.Raycaster(),
    pointer: new THREE.Vector2(),
    pointerDown: null,
    pointerMoveFrame: 0,
    pendingPointerEvent: null,
    resizeObserver: null,
    animationFrame: 0,
    renderFrames: 0,
    renderCount: 0
  };

  function setStatus(text, status = "loading") {
    if (!el.status) return;
    const strong = el.status.querySelector("strong");
    if (strong) strong.textContent = text;
    el.status.dataset.state = status;
  }

  function setLoadProgress(value, label) {
    const progress = Math.max(0, Math.min(100, Number(value) || 0));
    if (el.loadProgress) el.loadProgress.setAttribute("aria-valuenow", String(Math.round(progress)));
    if (el.loadProgressBar) el.loadProgressBar.style.width = `${progress}%`;
    if (el.loadProgressLabel && label) el.loadProgressLabel.textContent = label;
  }

  function setBusy(busy, message, progress) {
    state.busy = Boolean(busy);
    [el.vehicle, el.date, el.refresh, el.reset, ...el.viewButtons].forEach((control) => {
      if (!control) return;
      if (control === el.date && !state.allSamples.length) {
        control.disabled = true;
      } else {
        control.disabled = state.busy;
      }
    });
    if (el.loading) el.loading.hidden = !state.busy;
    if (message && el.loading) {
      const label = el.loading.querySelector("strong");
      if (label) label.textContent = message;
    }
    if (busy && progress != null) setLoadProgress(progress, message);
    if (!busy) setLoadProgress(100, "加载完成");
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin",
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {})
      },
      body: options.body && typeof options.body !== "string"
        ? JSON.stringify(options.body)
        : options.body
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
      const error = new Error(payload?.detail || payload?.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function hasReadPermission(auth) {
    if (!auth?.authenticated || !auth?.user?.email_verified) return false;
    return Boolean(auth.user.super_admin || (auth.permissions || []).includes("vehicle:read"));
  }

  function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function formatNumber(value) {
    const parsed = number(value);
    return parsed == null ? "-" : new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(parsed);
  }

  function formatCoord(value) {
    const parsed = number(value);
    return parsed == null ? "-" : parsed.toFixed(6);
  }

  function formatTime(value, includeDate = true) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return "-";
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      ...(includeDate ? { month: "2-digit", day: "2-digit" } : {}),
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(date);
  }

  function formatDateKey(key) {
    const match = String(key || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return key || "-";
    return `${match[1]}年${Number(match[2])}月${Number(match[3])}日`;
  }

  function dateKey(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return "";
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return map.year && map.month && map.day ? `${map.year}-${map.month}-${map.day}` : "";
  }

  function samplePosition(sample) {
    const position = sample?.position || {};
    const longitude = number(position.gaode_longitude);
    const latitude = number(position.gaode_latitude);
    if (longitude == null || latitude == null || Math.abs(latitude) > 85 || Math.abs(longitude) > 180) return null;
    return { longitude, latitude };
  }

  function inspectionFor(sample) {
    return state.inspections.get(sampleId(sample)) || null;
  }

  function inspectionRequestKey(sample) {
    return `${String(sample?.vehicle_id || "")}\n${sampleId(sample)}`;
  }

  function inspectionStatusLabel(inspection) {
    if (!inspection) return "待分析";
    return {
      clear: "未见异常",
      attention: "建议复核",
      issue: "发现问题",
      not_assessable: "无法判断"
    }[inspection.status] || "待分析";
  }

  function healthGradeLabel(inspection) {
    if (!inspection) return "等待四路图像分析";
    const grade = {
      good: "长势良好",
      fair: "长势一般",
      poor: "健康欠佳",
      not_assessable: "可见植被不足"
    }[inspection.health_grade] || "需要人工复核";
    const confidence = { high: "高", medium: "中", low: "低" }[inspection.confidence] || "低";
    return `${grade} · ${confidence}置信度`;
  }

  function vegetationPresence(inspection, key) {
    if (!inspection) return { state: "unknown", label: "待分析" };
    const value = inspection.vegetation_types?.[key];
    if (value === true) return { state: "present", label: "有" };
    if (value === false) return { state: "absent", label: "未见" };
    return { state: "unknown", label: "无法判断" };
  }

  function vegetationCoverage(inspection) {
    const values = (Array.isArray(inspection?.view_assessments) ? inspection.view_assessments : [])
      .map((item) => number(item?.green_coverage_percent))
      .filter((value) => value != null);
    if (!values.length) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  function sampleRouteId(sample) {
    const candidates = [
      sample?.route?.primary_route_id,
      sample?.route?.route_id,
      ...(Array.isArray(sample?.route?.route_ids) ? sample.route.route_ids : []),
      ...(Array.isArray(sample?.frames)
        ? sample.frames.flatMap((frame) => [
            frame?.route?.primary_route_id,
            frame?.route?.route_id,
            ...(Array.isArray(frame?.route?.route_ids) ? frame.route.route_ids : [])
          ])
        : [])
    ];
    return String(candidates.find((value) => String(value || "").trim()) || "").trim();
  }

  function routeDisplayName(value) {
    const fileName = String(value || "").split(/[\\/]/).pop().replace(/\.csv$/i, "");
    if (!fileName) return "未标注路线";
    const separator = fileName.indexOf("&");
    if (separator >= 0 && fileName.slice(separator + 1).trim()) return fileName.slice(separator + 1).trim();
    return fileName.replace(/^\d{4}-\d{2}-\d{2}[_-]\d{2}[-:]\d{2}[-:]\d{2}[_-]?/, "") || fileName;
  }

  function filteredVegetationSamples() {
    const rows = state.vegetationFilter === "all"
      ? state.visibleSamples
      : state.visibleSamples.filter((sample) => (
          inspectionFor(sample)?.vegetation_types?.[state.vegetationFilter] === true
        ));
    return rows.slice().reverse();
  }

  function appendVegetationPresenceCell(row, inspection, key) {
    const cell = document.createElement("td");
    const presence = vegetationPresence(inspection, key);
    const label = document.createElement("span");
    label.className = "gm-veg-presence";
    label.dataset.state = presence.state;
    label.textContent = presence.label;
    cell.appendChild(label);
    row.appendChild(cell);
  }

  function renderVegetationTable() {
    if (!el.vegetationTableBody) return;
    const analyzedCount = state.visibleSamples.reduce((sum, sample) => sum + (inspectionFor(sample) ? 1 : 0), 0);
    const counts = {
      all: state.visibleSamples.length,
      trees: 0,
      shrubs: 0,
      lawn_or_groundcover: 0
    };
    state.visibleSamples.forEach((sample) => {
      const types = inspectionFor(sample)?.vegetation_types || {};
      if (types.trees === true) counts.trees += 1;
      if (types.shrubs === true) counts.shrubs += 1;
      if (types.lawn_or_groundcover === true) counts.lawn_or_groundcover += 1;
    });
    Object.entries(counts).forEach(([key, value]) => {
      if (el.vegetationFilterCounts[key]) el.vegetationFilterCounts[key].textContent = String(value);
    });
    el.vegetationFilters.forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.gmVegetationFilter === state.vegetationFilter));
    });
    if (el.vegetationTableSummary) {
      el.vegetationTableSummary.textContent = state.dateKey
        ? `${formatDateKey(state.dateKey)} · ${state.visibleSamples.length} 个地点 · ${analyzedCount} 已识别`
        : "等待当前日期数据";
    }

    const rows = filteredVegetationSamples();
    const pageCount = Math.max(1, Math.ceil(rows.length / VEGETATION_TABLE_PAGE_SIZE));
    state.vegetationTablePage = Math.max(0, Math.min(state.vegetationTablePage, pageCount - 1));
    if (el.vegetationTablePage) {
      el.vegetationTablePage.textContent = `第 ${state.vegetationTablePage + 1} / ${pageCount} 页`;
    }
    if (el.vegetationTablePrev) el.vegetationTablePrev.disabled = state.vegetationTablePage <= 0;
    if (el.vegetationTableNext) el.vegetationTableNext.disabled = state.vegetationTablePage >= pageCount - 1;

    el.vegetationTableBody.replaceChildren();
    if (!rows.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 7;
      cell.className = "gm-table-empty";
      cell.textContent = state.visibleSamples.length ? "当前筛选没有已识别地点" : "当前日期没有采集地点";
      row.appendChild(cell);
      el.vegetationTableBody.appendChild(row);
      return;
    }

    const start = state.vegetationTablePage * VEGETATION_TABLE_PAGE_SIZE;
    const fragment = document.createDocumentFragment();
    rows.slice(start, start + VEGETATION_TABLE_PAGE_SIZE).forEach((sample) => {
      const id = sampleId(sample, state.visibleSamples.indexOf(sample));
      const inspection = inspectionFor(sample);
      const position = samplePosition(sample);
      const coverage = vegetationCoverage(inspection);
      const row = document.createElement("tr");
      row.dataset.sampleId = id;
      row.dataset.selected = String(id === state.selectedSampleId);

      const locationCell = document.createElement("td");
      const location = document.createElement("div");
      location.className = "gm-table-location";
      const route = document.createElement("strong");
      route.textContent = routeDisplayName(sampleRouteId(sample));
      const coordinate = document.createElement("small");
      coordinate.textContent = position
        ? `${formatTime(sample.collected_at, false)} · ${formatCoord(position.longitude)}, ${formatCoord(position.latitude)}`
        : `${formatTime(sample.collected_at, false)} · 坐标不可用`;
      location.append(route, coordinate);
      locationCell.appendChild(location);
      row.appendChild(locationCell);

      appendVegetationPresenceCell(row, inspection, "trees");
      appendVegetationPresenceCell(row, inspection, "shrubs");
      appendVegetationPresenceCell(row, inspection, "lawn_or_groundcover");

      const metricsCell = document.createElement("td");
      metricsCell.className = "gm-table-metrics";
      const coverageLabel = document.createElement("span");
      coverageLabel.textContent = `覆盖 ${coverage == null ? "-" : `${Math.round(coverage)}%`}`;
      const healthLabel = document.createElement("strong");
      healthLabel.textContent = `健康 ${inspection?.health_score == null ? "-" : inspection.health_score}`;
      metricsCell.append(coverageLabel, healthLabel);
      row.appendChild(metricsCell);

      const statusCell = document.createElement("td");
      statusCell.className = "gm-table-status";
      statusCell.dataset.state = inspection?.status || "pending";
      statusCell.textContent = inspectionStatusLabel(inspection);
      row.appendChild(statusCell);

      const actionCell = document.createElement("td");
      const locate = document.createElement("button");
      locate.type = "button";
      locate.className = "gm-table-locate";
      locate.dataset.sampleId = id;
      locate.textContent = "定位";
      locate.title = "在地图中定位";
      locate.setAttribute("aria-label", `${formatTime(sample.collected_at)}，在地图中定位`);
      actionCell.appendChild(locate);
      row.appendChild(actionCell);
      fragment.appendChild(row);
    });
    el.vegetationTableBody.appendChild(fragment);
  }

  function syncVegetationTableSelection() {
    el.vegetationTableBody?.querySelectorAll("tr[data-sample-id]").forEach((row) => {
      row.dataset.selected = String(row.dataset.sampleId === state.selectedSampleId);
    });
    root.querySelectorAll("[data-gm-archive-sample]").forEach((entry) => {
      entry.dataset.selected = String(entry.dataset.gmArchiveSample === state.selectedSampleId);
    });
  }

  function issueTypeLabel(type) {
    return {
      yellowing_or_wilting: "枯黄或萎蔫",
      drought_stress: "疑似缺水",
      pest_or_disease: "疑似病虫害",
      dead_or_broken_branch: "枯枝或断枝",
      overgrowth_or_encroachment: "生长侵界",
      missing_or_bare_patch: "缺株或裸斑",
      support_or_tree_grate_problem: "支撑或树池异常"
    }[type] || "绿化异常";
  }

  function dimensionLabel(key) {
    return {
      leaf_color: "叶色活力",
      water_status: "水分状态",
      pest_status: "病虫风险",
      branch_structure: "枝干结构",
      maintenance_condition: "养护状态"
    }[key] || "绿化维度";
  }

  function observationCategoryLabel(key) {
    return {
      canopy: "冠层",
      leaf_color: "叶色",
      water_status: "水分",
      pest_status: "病虫",
      branch_structure: "枝干",
      shrub: "灌木",
      groundcover: "草坪地被",
      maintenance: "养护",
      visibility: "画面"
    }[key] || "观察";
  }

  function viewConditionLabel(condition) {
    return {
      good: "状态良好",
      fair: "一般",
      poor: "需关注",
      not_assessable: "无法判断"
    }[condition] || "待分析";
  }

  function indicatorValueLabel(key, value) {
    const labels = {
      canopy_density: { sparse: "偏稀疏", moderate: "适中", dense: "较茂密", unknown: "无法判断" },
      leaf_color: { normal: "叶色正常", slight_yellowing: "轻微枯黄迹象", severe_yellowing: "明显枯黄", unknown: "无法判断" },
      drought_stress: { none: "未见缺水", possible: "可能缺水", clear: "缺水迹象明显", unknown: "无法判断" },
      pest_or_disease: { none: "未见病虫迹象", possible: "疑似病斑虫害", clear: "病虫迹象明显", unknown: "无法判断" },
      dead_or_broken_branches: { none: "未见枯断枝", possible: "疑似枯断枝", clear: "枯断枝明显", unknown: "无法判断" },
      shrub_condition: { good: "长势良好", fair: "长势一般", poor: "长势欠佳", unknown: "画面无灌木" },
      groundcover_condition: { good: "覆盖良好", fair: "覆盖一般", poor: "覆盖欠佳", unknown: "画面无地被" },
      overgrowth_or_encroachment: { none: "未见侵界", possible: "疑似侵界", clear: "侵界明显", unknown: "无法判断" }
    };
    return labels[key]?.[value] || "无法判断";
  }

  function indicatorState(key, value) {
    if (["normal", "none", "good", "dense", "moderate"].includes(value)) return "good";
    if (["possible", "fair", "slight_yellowing", "sparse"].includes(value)) return "fair";
    if (["clear", "poor", "severe_yellowing"].includes(value)) return "poor";
    return "unknown";
  }

  function sampleId(sample, index = 0) {
    return String(sample?.sample_id || `${sample?.vehicle_id || "vehicle"}-${sample?.collected_at || index}`);
  }

  function routeRequestItems(samples) {
    const result = [];
    const seen = new Set();
    const add = (sessionId, routeId) => {
      const session = String(sessionId || "").trim();
      const route = String(routeId || "").trim();
      if (!session || !route || result.length >= ROUTE_MAX_REQUESTS) return;
      const key = `${session}\n${route}`;
      if (seen.has(key)) return;
      seen.add(key);
      result.push({ session_id: session, route_id: route });
    };
    samples.forEach((sample) => {
      const sessionId = sample?.upload_session_id || sample?.upload_manifest?.session_id;
      add(sessionId, sample?.route?.primary_route_id || sample?.route?.route_id);
      (sample?.route?.route_ids || []).forEach((routeId) => add(sessionId, routeId));
      (sample?.patrol_state?.fields?.route_ids || []).forEach((routeId) => add(sessionId, routeId));
      (sample?.frames || []).forEach((frame) => {
        add(sessionId, frame?.route?.route_id);
        (frame?.route?.route_ids || []).forEach((routeId) => add(sessionId, routeId));
      });
    });
    return result;
  }

  async function loadRoutes(samples) {
    const routes = routeRequestItems(samples);
    if (!routes.length) return [];
    const payload = await fetchJson(API.routes, {
      method: "POST",
      body: { routes, max_points: ROUTE_MAX_POINTS }
    });
    return Array.isArray(payload.routes) ? payload.routes : [];
  }

  function routePoints(route) {
    return (Array.isArray(route?.points) ? route.points : [])
      .map((point) => ({ longitude: number(point?.longitude), latitude: number(point?.latitude) }))
      .filter((point) => point.longitude != null && point.latitude != null && Math.abs(point.latitude) <= 85);
  }

  function renderVehicleOptions(vehicles) {
    if (!el.vehicle) return "";
    const rows = new Map();
    (Array.isArray(vehicles) ? vehicles : []).forEach((vehicle) => {
      const vehicleId = String(vehicle?.vehicle_id || "").trim();
      if (vehicleId) rows.set(vehicleId, vehicle);
    });
    const captureTime = (vehicle) => {
      const capture = vehicle?.last_patrol_flow_capture;
      return number(capture?.collected_at_ms) ?? (Date.parse(capture?.collected_at || "") || 0);
    };
    const ranked = [...rows.values()].sort((left, right) => {
      const captureDelta = captureTime(right) - captureTime(left);
      if (captureDelta) return captureDelta;
      if (Boolean(left.fresh) !== Boolean(right.fresh)) return left.fresh ? -1 : 1;
      return String(left.vehicle_id).localeCompare(String(right.vehicle_id), "zh-CN");
    });
    el.vehicle.replaceChildren();
    ranked.forEach((vehicle) => {
      const capture = vehicle?.last_patrol_flow_capture;
      const option = document.createElement("option");
      option.value = vehicle.vehicle_id;
      option.textContent = captureTime(vehicle)
        ? `${vehicle.vehicle_id} · 最新采集 ${formatTime(capture?.collected_at)}`
        : `${vehicle.vehicle_id} · 暂无采集`;
      el.vehicle.appendChild(option);
    });
    return ranked.find((vehicle) => captureTime(vehicle))?.vehicle_id || ranked[0]?.vehicle_id || "";
  }

  function renderDateOptions(samples, preferredDate = "") {
    if (!el.date) return "";
    const days = new Map();
    samples.forEach((sample) => {
      const key = dateKey(sample.collected_at);
      if (!key || !samplePosition(sample)) return;
      const current = days.get(key) || { count: 0 };
      current.count += 1;
      days.set(key, current);
    });
    const keys = [...days.keys()].sort().reverse();
    el.date.replaceChildren();
    if (!keys.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "暂无采集日期";
      el.date.appendChild(option);
      el.date.disabled = true;
      return "";
    }
    keys.forEach((key) => {
      const stats = days.get(key);
      const option = document.createElement("option");
      option.value = key;
      option.textContent = `${formatDateKey(key)} · ${stats.count} 节点`;
      el.date.appendChild(option);
    });
    const selected = keys.includes(preferredDate) ? preferredDate : keys[0];
    el.date.value = selected;
    el.date.disabled = state.busy;
    return selected;
  }

  function setMetric(key, value) {
    if (el.metrics[key]) el.metrics[key].textContent = value;
  }

  function updateQueueMetric() {
    const queue = state.greenQueue;
    if (!queue) return;
    const analyzed = Number(queue.analyzed_node_count) || 0;
    const source = Number(queue.source_node_count) || 0;
    const pending = Number(queue.pending_node_count) || 0;
    const progress = number(queue.progress_percent) ?? (source ? analyzed / source * 100 : 0);
    const summary = queue.analysis_summary || {};
    const statuses = summary.status_counts || {};
    const bands = summary.score_bands || {};
    const vegetation = summary.vegetation_type_counts || {};
    if (el.overview.progress) el.overview.progress.textContent = `${formatNumber(progress)}%`;
    if (el.overview["progress-note"]) {
      el.overview["progress-note"].textContent = `${formatNumber(analyzed)} / ${formatNumber(source)} 节点 · 待 ${formatNumber(pending)} · 失败 ${formatNumber(queue.failed_node_count || 0)}`;
    }
    if (el.progressBar) el.progressBar.style.width = `${Math.max(0, Math.min(100, progress))}%`;
    if (el.overview["average-score"]) el.overview["average-score"].textContent = formatNumber(summary.average_health_score);
    if (el.overview["score-range"]) {
      el.overview["score-range"].textContent = summary.scored_node_count
        ? `中位 ${formatNumber(summary.median_health_score)} · ${formatNumber(summary.min_health_score)}-${formatNumber(summary.max_health_score)}`
        : "等待新版评分";
    }
    if (el.overview["clear-count"]) el.overview["clear-count"].textContent = formatNumber(statuses.clear || 0);
    if (el.overview["review-count"]) {
      el.overview["review-count"].textContent = formatNumber((statuses.attention || 0) + (statuses.issue || 0));
    }
    if (el.overview["issue-count"]) el.overview["issue-count"].textContent = formatNumber(summary.issue_count || 0);
    if (el.overview["unassessable-count"]) {
      el.overview["unassessable-count"].textContent = `无法判断 ${formatNumber(statuses.not_assessable || 0)}`;
    }
    if (el.overview["analyzed-images"]) {
      el.overview["analyzed-images"].textContent = `${formatNumber(summary.analyzed_frame_count || queue.analyzed_frame_count || 0)} 张图已分析`;
    }
    const maxBandCount = Math.max(1, ...Object.keys(el.scoreBands).map((key) => Number(bands[key]) || 0));
    Object.keys(el.scoreBands).forEach((key) => {
      const count = Number(bands[key]) || 0;
      el.scoreBands[key].style.width = `${count / maxBandCount * 100}%`;
      if (el.scoreBandCounts[key]) el.scoreBandCounts[key].textContent = formatNumber(count);
    });
    Object.keys(el.vegetationTotals).forEach((key) => {
      el.vegetationTotals[key].textContent = formatNumber(vegetation[key] || 0);
    });
  }

  async function refreshGreenQueueStatus() {
    if (!state.authenticated) return;
    try {
      const payload = await fetchJson(API.greenStatus);
      state.greenQueue = payload.queue || null;
      updateQueueMetric();
    } catch (_error) {
      // Keep the last known queue progress while the status endpoint is unavailable.
    }
  }

  function updateSummary(samples, routes) {
    const inspections = samples.map(inspectionFor).filter(Boolean);
    const imageCount = samples.reduce((sum, sample) => (
      sum + (Number(sample.frame_count) || (Array.isArray(sample.frames) ? sample.frames.length : 0))
    ), 0);
    const issueCount = inspections.reduce((sum, inspection) => (
      sum + (Array.isArray(inspection.issues) ? inspection.issues.length : 0)
    ), 0);
    setMetric("samples", String(samples.length));
    setMetric("routes", String(routes.length));
    setMetric("images", String(imageCount));
    setMetric("issues", String(issueCount));
    setMetric("analyzed", `${inspections.length}/${samples.length}`);
    renderArchiveSummary(samples);
    updateQueueMetric();
    if (el.mapMeta) {
      el.mapMeta.textContent = `${state.vehicleId || "-"} · ${formatDateKey(state.dateKey)} · ${samples.length} 节点 · ${inspections.length} 已分析`;
    }
  }

  function archiveEvidence(inspection) {
    const issues = Array.isArray(inspection?.issues) ? inspection.issues : [];
    if (issues.length) return `${issueTypeLabel(issues[0].type)}：${issues[0].evidence || "需要人工复核"}`;
    const observations = Array.isArray(inspection?.observations) ? inspection.observations : [];
    if (observations.length) {
      return `${observationCategoryLabel(observations[0].category)}：${observations[0].evidence || "已完成图像分析"}`;
    }
    if (inspection?.status === "not_assessable") return "画面证据不足，暂不生成健康判断。";
    if (inspection) return inspection.summary || "已完成四路绿化影像分析。";
    return "等待进入图像分析队列。";
  }

  function appendArchiveLocateButton(target, sample, label = "定位节点") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "gm-archive-locate";
    button.dataset.gmArchiveSample = sampleId(sample, state.visibleSamples.indexOf(sample));
    button.textContent = label;
    target.appendChild(button);
  }

  function renderArchiveSummary(samples) {
    if (el.recordDate) {
      el.recordDate.textContent = state.dateKey
        ? `${formatDateKey(state.dateKey)} · ${state.vehicleId || "巡逻车辆"}`
        : "正在读取巡检日期";
    }

    if (el.timeline) {
      el.timeline.replaceChildren();
      const timelineSamples = samples.slice(-6);
      if (!timelineSamples.length) {
        const empty = document.createElement("p");
        empty.className = "gm-empty";
        empty.textContent = "当前日期没有有效采集节点。";
        el.timeline.appendChild(empty);
      } else {
        timelineSamples.forEach((sample) => {
          const inspection = inspectionFor(sample);
          const entry = document.createElement("article");
          entry.className = "gm-timeline-entry";
          entry.dataset.state = inspection?.status || "pending";
          entry.dataset.gmArchiveSample = sampleId(sample, state.visibleSamples.indexOf(sample));

          const time = document.createElement("time");
          time.textContent = formatTime(sample.collected_at, false);
          const marker = document.createElement("i");
          marker.setAttribute("aria-hidden", "true");
          const copy = document.createElement("div");
          const title = document.createElement("strong");
          title.textContent = inspection
            ? `${inspectionStatusLabel(inspection)} · 健康度 ${inspection.health_score ?? "无法判断"}`
            : "等待绿化分析";
          const detail = document.createElement("p");
          detail.textContent = archiveEvidence(inspection);
          copy.append(title, detail);
          entry.append(time, marker, copy);
          appendArchiveLocateButton(entry, sample, "查看");
          el.timeline.appendChild(entry);
        });
      }
    }

    if (el.brief) {
      const analyzed = samples.filter((sample) => inspectionFor(sample));
      const rows = [];
      samples.forEach((sample) => {
        const inspection = inspectionFor(sample);
        if (!inspection) return;
        const issues = Array.isArray(inspection.issues) ? inspection.issues : [];
        const recommendations = Array.isArray(inspection.recommendations) ? inspection.recommendations : [];
        const severity = issues.some((issue) => issue.severity === "high")
          ? "high"
          : issues.length || recommendations.length
            ? "medium"
            : "low";
        if (recommendations.length) {
          recommendations.slice(0, 1).forEach((recommendation) => rows.push({
            sample,
            priority: severity,
            title: recommendation.action || "建议现场复核",
            detail: recommendation.reason || archiveEvidence(inspection)
          }));
        } else if (issues.length) {
          rows.push({
            sample,
            priority: severity,
            title: `${issueTypeLabel(issues[0].type)}，建议现场复核`,
            detail: issues[0].evidence || archiveEvidence(inspection)
          });
        }
      });

      if (el.briefTitle) el.briefTitle.textContent = `${state.vehicleId || "当前车辆"} · 当日养护简报`;
      if (el.briefMeta) {
        el.briefMeta.textContent = state.dateKey
          ? `${formatDateKey(state.dateKey)} · 已分析 ${analyzed.length}/${samples.length} 个节点 · ${rows.length} 条有证据建议`
          : "等待当前日期分析结果。";
      }
      el.brief.replaceChildren();
      rows.slice(0, 6).forEach((row) => {
        const item = document.createElement("article");
        item.className = "gm-brief-row";
        item.dataset.priority = row.priority;
        item.dataset.gmArchiveSample = sampleId(row.sample, state.visibleSamples.indexOf(row.sample));
        const priority = document.createElement("span");
        priority.className = "gm-brief-priority";
        priority.textContent = row.priority === "high" ? "高优先级" : row.priority === "medium" ? "建议复核" : "持续观察";
        const copy = document.createElement("div");
        const title = document.createElement("strong");
        title.textContent = row.title;
        const detail = document.createElement("p");
        detail.textContent = `${formatTime(row.sample.collected_at)} · ${row.detail}`;
        copy.append(title, detail);
        item.append(priority, copy);
        appendArchiveLocateButton(item, row.sample);
        el.brief.appendChild(item);
      });
      if (!rows.length) {
        const item = document.createElement("article");
        item.className = "gm-brief-row";
        item.dataset.priority = analyzed.length ? "clear" : "pending";
        const priority = document.createElement("span");
        priority.className = "gm-brief-priority";
        priority.textContent = analyzed.length ? "当前状态" : "分析进度";
        const copy = document.createElement("div");
        const title = document.createElement("strong");
        title.textContent = analyzed.length ? "已分析节点未见需要生成养护建议的问题" : "等待节点分析完成";
        const detail = document.createElement("p");
        detail.textContent = analyzed.length
          ? "继续按当前路线巡检；无明确问题时不生成工单。"
          : "分析完成后只汇总有明确四路影像证据的观察。";
        copy.append(title, detail);
        item.append(priority, copy);
        el.brief.appendChild(item);
      }
    }
    syncVegetationTableSelection();
  }

  function setProject(name, title, detail, projectState = "unknown") {
    const project = el.projects?.querySelector(`[data-project="${name}"]`);
    if (!project) return;
    project.dataset.state = projectState;
    const strong = project.querySelector("strong");
    const paragraph = project.querySelector("p");
    if (strong) strong.textContent = title;
    if (paragraph) paragraph.textContent = detail;
  }

  function renderProjects(sample) {
    const inspection = sample ? inspectionFor(sample) : null;
    if (!inspection) {
      setProject("trees", "待分析", "冠层密度、叶色和枝干状态");
      setProject("shrubs", "待分析", "整齐度、长势和侵界迹象");
      setProject("groundcover", "待分析", "覆盖状态、裸斑和枯黄迹象");
      setProject("issues", "待分析", "仅显示中高可信度问题");
      if (el.projectSummary) el.projectSummary.textContent = "正在读取当前节点四路绿化影像";
      return;
    }
    const indicators = inspection.indicators || {};
    const treeVisible = inspection.vegetation_types?.trees;
    const shrubVisible = inspection.vegetation_types?.shrubs;
    const groundVisible = inspection.vegetation_types?.lawn_or_groundcover;
    const canopyLabel = treeVisible ? indicatorValueLabel("canopy_density", indicators.canopy_density) : "画面未见乔木";
    const leafLabel = indicatorValueLabel("leaf_color", indicators.leaf_color);
    setProject(
      "trees",
      canopyLabel,
      treeVisible ? `${leafLabel} · ${indicatorValueLabel("dead_or_broken_branches", indicators.dead_or_broken_branches)}` : "当前四路画面没有足够乔木证据",
      treeVisible ? indicatorState("leaf_color", indicators.leaf_color) : "unknown"
    );
    setProject(
      "shrubs",
      shrubVisible ? indicatorValueLabel("shrub_condition", indicators.shrub_condition) : "画面未见灌木",
      shrubVisible ? indicatorValueLabel("overgrowth_or_encroachment", indicators.overgrowth_or_encroachment) : "当前四路画面没有足够灌木证据",
      shrubVisible ? indicatorState("shrub_condition", indicators.shrub_condition) : "unknown"
    );
    setProject(
      "groundcover",
      groundVisible ? indicatorValueLabel("groundcover_condition", indicators.groundcover_condition) : "画面未见地被",
      groundVisible ? `${leafLabel} · ${indicatorValueLabel("drought_stress", indicators.drought_stress)}` : "当前四路画面没有足够草坪地被证据",
      groundVisible ? indicatorState("groundcover_condition", indicators.groundcover_condition) : "unknown"
    );
    const issues = Array.isArray(inspection.issues) ? inspection.issues : [];
    setProject(
      "issues",
      issues.length ? `${issues.length} 项待复核` : "未见明显异常",
      issues.length ? issues.map((issue) => issueTypeLabel(issue.type)).join("、") : "不为凑指标生成问题或建议",
      issues.some((issue) => issue.severity === "high") ? "poor" : issues.length ? "fair" : "good"
    );
    if (el.projectSummary) {
      el.projectSummary.textContent = `${formatTime(sample.collected_at)} · ${inspectionStatusLabel(inspection)} · ${inspection.frame_count_evaluated || 0} 路画面`;
    }
  }

  function redactedImageUrl(value) {
    const raw = String(value || "").trim();
    const marker = "/api/park-pcm/crowd/files/";
    const index = raw.indexOf(marker);
    if (index < 0) return raw;
    return `${raw.slice(0, index)}/api/park-pcm/crowd/redacted-files/${raw.slice(index + marker.length)}`;
  }

  function openPreview(frame, sample) {
    const src = redactedImageUrl(frame?.image_url);
    if (!src || !el.preview || !el.previewImage) return;
    el.previewImage.src = src;
    el.previewImage.alt = `${sample?.vehicle_id || ""} ${frame?.camera_id || "camera"}`;
    if (el.previewTitle) el.previewTitle.textContent = `${sample?.vehicle_id || "-"} · ${frame?.camera_id || "camera"}`;
    if (el.previewMeta) {
      const inspection = inspectionFor(sample);
      el.previewMeta.textContent = `${formatTime(sample?.collected_at)} · ${inspectionStatusLabel(inspection)} · 绿化巡检证据`;
    }
    if (typeof el.preview.showModal === "function") el.preview.showModal();
    else el.preview.setAttribute("open", "");
  }

  function replaceFindingList(target, items, emptyText, clear = false) {
    if (!target) return;
    target.replaceChildren();
    if (!items.length) {
      const item = document.createElement("li");
      item.className = clear ? "gm-clear" : "";
      item.textContent = emptyText;
      target.appendChild(item);
      return;
    }
    items.forEach((text) => {
      const item = document.createElement("li");
      item.textContent = text;
      target.appendChild(item);
    });
  }

  function renderInspectionPanel(sample) {
    const inspection = sample ? inspectionFor(sample) : null;
    const requestKey = sample ? inspectionRequestKey(sample) : "";
    const pending = Boolean(sample && state.inspectionPending.has(requestKey));
    const inspectionError = sample ? state.inspectionErrors.get(requestKey) : "";
    const panelState = inspection?.status || "pending";
    if (el.healthPanel) el.healthPanel.dataset.state = panelState;
    if (el.nodeHealth) {
      el.nodeHealth.dataset.state = panelState;
      el.nodeHealth.textContent = pending ? "分析中" : inspectionStatusLabel(inspection);
    }
    if (el.healthScore) el.healthScore.textContent = inspection?.health_score == null ? "-" : String(inspection.health_score);
    if (el.healthGrade) {
      el.healthGrade.textContent = pending ? "正在分析四路画面" : healthGradeLabel(inspection);
    }
    if (el.scoreReason) {
      el.scoreReason.textContent = pending
        ? "GPU4 正在计算五维评分与逐视角观察。"
        : inspection?.score_reason || (inspection ? "综合当前可见植被的五维证据计算。" : "五维评分依据将在分析后显示。");
    }
    if (el.indicators) {
      el.indicators.replaceChildren();
      if (!inspection) {
        const empty = document.createElement("p");
        empty.className = "gm-empty";
        empty.textContent = pending ? "正在分析四路绿化影像。" : "等待四路绿化巡检结果。";
        el.indicators.appendChild(empty);
      } else {
        const rows = [
          "leaf_color",
          "water_status",
          "pest_status",
          "branch_structure",
          "maintenance_condition"
        ];
        rows.forEach((key) => {
          const dimension = inspection.dimension_scores?.[key] || {};
          const score = number(dimension.score);
          const item = document.createElement("div");
          item.className = "gm-indicator";
          item.dataset.state = score == null ? "unknown" : score >= 82 ? "good" : score >= 65 ? "fair" : "poor";
          const name = document.createElement("span");
          name.textContent = dimensionLabel(key);
          const result = document.createElement("strong");
          result.textContent = score == null ? "无法判断" : String(score);
          const track = document.createElement("i");
          const fill = document.createElement("b");
          fill.style.width = `${score == null ? 0 : Math.max(0, Math.min(100, score))}%`;
          track.appendChild(fill);
          const note = document.createElement("p");
          note.textContent = dimension.observation || "当前画面没有提供更具体的维度证据。";
          item.append(name, result, track, note);
          el.indicators.appendChild(item);
        });
      }
    }
    if (el.inspectionSummary) {
      el.inspectionSummary.textContent = inspectionError
        ? `绿化分析暂不可用：${inspectionError}`
        : pending
          ? "正在读取四路画面，仅保留有明确图像证据的结论。"
          : inspection?.summary || "选择节点后读取巡检结论。";
    }
    const observations = Array.isArray(inspection?.observations) ? inspection.observations : [];
    replaceFindingList(
      el.observations,
      observations.map((item) => {
        const cameras = Array.isArray(item.camera_ids) && item.camera_ids.length ? ` · ${item.camera_ids.join("/")}` : "";
        return `${observationCategoryLabel(item.category)}${cameras}：${item.evidence}`;
      }),
      inspection ? inspection.status === "not_assessable" ? "当前画面没有足够清晰的植被证据" : "未返回具体观察，请重新分析该节点" : "暂无观察",
      Boolean(inspection && observations.length)
    );
    const issues = Array.isArray(inspection?.issues) ? inspection.issues : [];
    replaceFindingList(
      el.issues,
      issues.map((issue) => `${issueTypeLabel(issue.type)}：${issue.evidence}`),
      inspection ? inspection.status === "not_assessable" ? "当前画面不足以判断" : "未发现中高可信度问题" : "暂无结论",
      Boolean(inspection && !issues.length && inspection.status !== "not_assessable")
    );
    const recommendations = Array.isArray(inspection?.recommendations) ? inspection.recommendations : [];
    replaceFindingList(
      el.recommendations,
      recommendations.map((item) => `${item.action}：${item.reason}`),
      inspection && !issues.length ? "无明确问题，不生成养护建议" : "暂无建议",
      Boolean(inspection && !issues.length)
    );
  }

  async function ensureInspection(sample) {
    const id = sampleId(sample);
    const requestVehicleId = String(sample?.vehicle_id || "");
    const requestKey = inspectionRequestKey(sample);
    if (!id || state.inspections.has(id) || state.inspectionPending.has(requestKey)) return;
    state.inspectionErrors.delete(requestKey);
    state.inspectionPending.add(requestKey);
    renderInspectionPanel(sample);
    renderProjects(sample);
    try {
      const payload = await fetchJson(API.greenInspect, {
        method: "POST",
        body: { sample_id: id, vehicle_id: sample.vehicle_id, force: false }
      });
      if (payload.inspection && state.vehicleId === requestVehicleId) {
        state.inspections.set(id, payload.inspection);
        updateNodeInspectionStyle(id, payload.inspection);
        updateSummary(state.visibleSamples, state.routes);
        renderVegetationTable();
        void refreshGreenQueueStatus();
      }
    } catch (error) {
      if (state.vehicleId === requestVehicleId) {
        state.inspectionErrors.set(requestKey, error.message || "请求失败");
      }
    } finally {
      state.inspectionPending.delete(requestKey);
      if (
        state.vehicleId === requestVehicleId &&
        state.selectedSampleId === id
      ) {
        renderSampleDetail(sample);
        renderProjects(sample);
      }
    }
  }

  function renderSampleDetail(sample) {
    if (!sample) {
      if (el.nodeTitle) el.nodeTitle.textContent = "采集节点";
      if (el.nodeMeta) el.nodeMeta.textContent = "在地图中选择采集节点。";
      if (el.frames) {
        const empty = document.createElement("p");
        empty.className = "gm-empty";
        empty.textContent = "等待四路现场图片。";
        el.frames.replaceChildren(empty);
      }
      renderInspectionPanel(null);
      renderProjects(null);
      return;
    }
    const position = samplePosition(sample);
    if (el.nodeTitle) el.nodeTitle.textContent = `${sample.vehicle_id || "-"} · ${formatTime(sample.collected_at)}`;
    if (el.nodeMeta) {
      el.nodeMeta.textContent = position
        ? `高德坐标 ${formatCoord(position.longitude)}, ${formatCoord(position.latitude)} · ${sample.frame_count || sample.frames?.length || 0} 路现场图`
        : "定位数据不可用";
    }
    if (!el.frames) return;
    el.frames.replaceChildren();
    const frames = (Array.isArray(sample.frames) ? sample.frames : []).slice(0, 4);
    if (!frames.length) {
      const empty = document.createElement("p");
      empty.className = "gm-empty";
      empty.textContent = "该节点没有现场图片。";
      el.frames.appendChild(empty);
      renderInspectionPanel(sample);
      return;
    }
    frames.forEach((frame) => {
      const inspection = inspectionFor(sample);
      const assessment = (Array.isArray(inspection?.view_assessments) ? inspection.view_assessments : [])
        .find((item) => item.camera_id === frame.camera_id);
      const figure = document.createElement("figure");
      figure.className = "gm-frame";
      figure.dataset.state = assessment?.condition || "pending";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "gm-frame-button";
      button.setAttribute("aria-label", `查看 ${frame.camera_id || "相机"} 图片`);
      const src = redactedImageUrl(frame.image_url);
      if (src) {
        const image = document.createElement("img");
        image.loading = "eager";
        image.decoding = "async";
        image.alt = `${sample.vehicle_id || ""} ${frame.camera_id || "camera"}`;
        image.src = src;
        image.addEventListener("error", () => {
          const placeholder = document.createElement("span");
          placeholder.className = "gm-frame-placeholder";
          placeholder.textContent = "图片暂不可用";
          image.replaceWith(placeholder);
          button.disabled = true;
        }, { once: true });
        button.appendChild(image);
        button.addEventListener("click", () => openPreview(frame, sample));
      } else {
        const placeholder = document.createElement("span");
        placeholder.className = "gm-frame-placeholder";
        placeholder.textContent = "没有图片";
        button.appendChild(placeholder);
        button.disabled = true;
      }
      const caption = document.createElement("figcaption");
      const camera = document.createElement("span");
      camera.textContent = frame.camera_id || "camera";
      const count = document.createElement("strong");
      count.textContent = assessment ? viewConditionLabel(assessment.condition) : "绿化视图";
      const observation = document.createElement("small");
      observation.textContent = assessment?.observation || (inspection ? "该视角未返回具体观察" : "等待逐视角分析");
      caption.append(camera, count, observation);
      figure.append(button, caption);
      el.frames.appendChild(figure);
    });
    renderInspectionPanel(sample);
  }

  function webMercatorPixel(longitude, latitude, zoom) {
    const size = 256 * (2 ** zoom);
    const x = (longitude + 180) / 360 * size;
    const clippedLat = Math.max(-85.05112878, Math.min(85.05112878, latitude));
    const sin = Math.sin(clippedLat * Math.PI / 180);
    const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size;
    return { x, y };
  }

  function mapBounds(points) {
    const valid = points.filter((point) => point && number(point.longitude) != null && number(point.latitude) != null);
    if (!valid.length) return null;
    return valid.reduce((bounds, point) => ({
      minLng: Math.min(bounds.minLng, point.longitude),
      maxLng: Math.max(bounds.maxLng, point.longitude),
      minLat: Math.min(bounds.minLat, point.latitude),
      maxLat: Math.max(bounds.maxLat, point.latitude)
    }), { minLng: Infinity, maxLng: -Infinity, minLat: Infinity, maxLat: -Infinity });
  }

  function chooseStaticMapView(points) {
    const bounds = mapBounds(points);
    if (!bounds) return null;
    const center = {
      longitude: (bounds.minLng + bounds.maxLng) / 2,
      latitude: (bounds.minLat + bounds.maxLat) / 2
    };
    let zoom = 19;
    for (; zoom >= 11; zoom -= 1) {
      const northWest = webMercatorPixel(bounds.minLng, bounds.maxLat, zoom);
      const southEast = webMercatorPixel(bounds.maxLng, bounds.minLat, zoom);
      if (Math.abs(southEast.x - northWest.x) <= 820 && Math.abs(southEast.y - northWest.y) <= 820) break;
    }
    return { center, zoom: Math.max(11, zoom), bounds };
  }

  function staticMapUrl(view) {
    const key = root.getAttribute("data-amap-key") || "";
    const query = new URLSearchParams({
      location: `${view.center.longitude},${view.center.latitude}`,
      zoom: String(view.zoom),
      size: `${STATIC_MAP_SIZE}*${STATIC_MAP_SIZE}`,
      scale: "1",
      traffic: "0",
      key
    });
    return `https://restapi.amap.com/v3/staticmap?${query.toString()}`;
  }

  function mapProjector(view) {
    const centerPixel = webMercatorPixel(view.center.longitude, view.center.latitude, view.zoom);
    return (point) => {
      const pixel = webMercatorPixel(point.longitude, point.latitude, view.zoom);
      return new THREE.Vector3(
        (pixel.x - centerPixel.x) * WORLD_PER_PIXEL,
        0,
        (pixel.y - centerPixel.y) * WORLD_PER_PIXEL
      );
    };
  }

  function makeFallbackTexture() {
    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 1024;
    const context = canvas.getContext("2d");
    context.fillStyle = "#dce5df";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = "#c3d0c8";
    context.lineWidth = 2;
    for (let offset = 0; offset <= 1024; offset += 64) {
      context.beginPath();
      context.moveTo(offset, 0);
      context.lineTo(offset, 1024);
      context.moveTo(0, offset);
      context.lineTo(1024, offset);
      context.stroke();
    }
    return new THREE.CanvasTexture(canvas);
  }

  async function loadMapTexture(view) {
    try {
      const texture = await new THREE.TextureLoader().loadAsync(staticMapUrl(view));
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = Math.min(8, state.renderer?.capabilities?.getMaxAnisotropy?.() || 1);
      return { texture, fallback: false };
    } catch (error) {
      console.warn("green-management static map texture failed", error);
      const texture = makeFallbackTexture();
      texture.colorSpace = THREE.SRGBColorSpace;
      return { texture, fallback: true };
    }
  }

  function disposeObject(object) {
    object.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach((material) => material.dispose());
      }
    });
  }

  function clearSceneContent() {
    state.nodeMeshes = [];
    state.nodeAnchors = [];
    state.nodeIndexBySampleId.clear();
    state.nodePositions.clear();
    if (el.hitLayer) el.hitLayer.replaceChildren();
    state.selectedRing = null;
    if (state.contentGroup && state.scene) {
      state.scene.remove(state.contentGroup);
      disposeObject(state.contentGroup);
    }
    state.contentGroup = null;
    if (state.mapTexture) state.mapTexture.dispose();
    state.mapTexture = null;
    requestSceneRender(1);
  }

  function ensureScene() {
    if (state.renderer) return;
    state.scene = new THREE.Scene();
    state.scene.background = new THREE.Color(0xdfe7e2);
    state.scene.fog = new THREE.Fog(0xdfe7e2, 160, 360);
    state.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 1000);
    state.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    state.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    state.renderer.outputColorSpace = THREE.SRGBColorSpace;
    state.renderer.shadowMap.enabled = true;
    state.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    el.map.appendChild(state.renderer.domElement);
    state.controls = new MapControls(state.camera, state.renderer.domElement);
    state.controls.enableDamping = true;
    state.controls.dampingFactor = 0.08;
    state.controls.screenSpacePanning = false;
    state.controls.minDistance = 20;
    state.controls.maxDistance = 360;
    state.controls.maxPolarAngle = Math.PI / 2.04;
    state.controls.target.set(0, 0, 0);
    state.controls.addEventListener("change", () => requestSceneRender(3));
    state.controls.addEventListener("start", () => requestSceneRender(20));
    state.controls.addEventListener("end", () => requestSceneRender(24));

    const hemisphere = new THREE.HemisphereLight(0xffffff, 0x8ea294, 1.75);
    state.scene.add(hemisphere);
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(-80, 140, 70);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -100;
    sun.shadow.camera.right = 100;
    sun.shadow.camera.top = 100;
    sun.shadow.camera.bottom = -100;
    state.scene.add(sun);

    const canvas = state.renderer.domElement;
    canvas.addEventListener("pointerdown", (event) => {
      state.pointerDown = { x: event.clientX, y: event.clientY, time: performance.now() };
    });
    canvas.addEventListener("pointerup", (event) => {
      const down = state.pointerDown;
      state.pointerDown = null;
      if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 6 || performance.now() - down.time > 700) return;
      const hit = pickNode(event);
      const id = sampleIdFromHit(hit);
      if (id) selectSample(id, true);
    });
    canvas.addEventListener("pointermove", (event) => {
      state.pendingPointerEvent = { clientX: event.clientX, clientY: event.clientY };
      if (state.pointerMoveFrame) return;
      state.pointerMoveFrame = window.requestAnimationFrame(() => {
        state.pointerMoveFrame = 0;
        const pointerEvent = state.pendingPointerEvent;
        if (!pointerEvent) return;
        const hit = pickNode(pointerEvent);
        canvas.style.cursor = hit ? "pointer" : "grab";
        if (!el.tooltip || !el.stage) return;
        const id = sampleIdFromHit(hit);
        if (!id) {
          el.tooltip.hidden = true;
          return;
        }
        const sample = state.visibleSampleById.get(id);
        if (!sample) {
          el.tooltip.hidden = true;
          return;
        }
        const rect = el.stage.getBoundingClientRect();
        el.tooltip.textContent = `${formatTime(sample.collected_at)} · ${inspectionStatusLabel(inspectionFor(sample))} · 4 路绿化影像`;
        el.tooltip.style.left = `${Math.max(0, Math.min(rect.width - 230, pointerEvent.clientX - rect.left))}px`;
        el.tooltip.style.top = `${Math.max(0, Math.min(rect.height - 70, pointerEvent.clientY - rect.top))}px`;
        el.tooltip.hidden = false;
      });
    });
    canvas.addEventListener("pointerleave", () => {
      if (el.tooltip) el.tooltip.hidden = true;
    });

    if (el.hitLayer && el.hitLayer.dataset.gmBound !== "true") {
      el.hitLayer.dataset.gmBound = "true";
      el.hitLayer.addEventListener("click", (event) => {
        const button = event.target.closest(".gm-node-hit");
        const id = button?.dataset.sampleId;
        if (!id) return;
        event.stopPropagation();
        selectSample(id, true);
      });
      el.hitLayer.addEventListener("pointerover", (event) => {
        const button = event.target.closest(".gm-node-hit");
        const sample = button?.dataset.sampleId ? state.visibleSampleById.get(button.dataset.sampleId) : null;
        if (!button || !sample || !el.tooltip || !el.stage) return;
        const stageRect = el.stage.getBoundingClientRect();
        const buttonRect = button.getBoundingClientRect();
        el.tooltip.textContent = `${formatTime(sample.collected_at)} · ${inspectionStatusLabel(inspectionFor(sample))} · 4 路绿化影像`;
        el.tooltip.style.left = `${Math.max(0, Math.min(stageRect.width - 230, buttonRect.left - stageRect.left))}px`;
        el.tooltip.style.top = `${Math.max(0, Math.min(stageRect.height - 70, buttonRect.top - stageRect.top))}px`;
        el.tooltip.hidden = false;
      });
      el.hitLayer.addEventListener("pointerout", (event) => {
        if (event.relatedTarget?.closest?.(".gm-node-hit")) return;
        if (el.tooltip) el.tooltip.hidden = true;
      });
    }

    state.resizeObserver = new ResizeObserver(resizeScene);
    state.resizeObserver.observe(el.map);
    resizeScene();
    requestSceneRender(2);
  }

  function resizeScene() {
    if (!state.renderer || !state.camera || !el.map) return;
    const rect = el.map.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    state.renderer.setSize(width, height, false);
    state.camera.aspect = width / height;
    state.camera.updateProjectionMatrix();
    requestSceneRender(2);
  }

  function requestSceneRender(frames = 1) {
    state.renderFrames = Math.max(state.renderFrames, Math.max(1, Number(frames) || 1));
    if (!state.animationFrame) state.animationFrame = window.requestAnimationFrame(renderSceneFrame);
  }

  function renderSceneFrame() {
    state.animationFrame = 0;
    const controlsChanged = state.controls?.update() === true;
    updateNodeHitTargets();
    if (state.renderer && state.scene && state.camera) state.renderer.render(state.scene, state.camera);
    state.renderCount += 1;
    root.dataset.gmRenderCount = String(state.renderCount);
    state.renderFrames = Math.max(0, state.renderFrames - 1);
    if (controlsChanged || state.renderFrames > 0) requestSceneRender(controlsChanged ? 2 : 1);
  }

  function updateNodeHitTargets() {
    if (!state.camera || !el.map || !state.nodeAnchors.length) return;
    const rect = el.map.getBoundingClientRect();
    const world = new THREE.Vector3();
    state.nodeAnchors.forEach((anchor) => {
      world.copy(anchor.position);
      world.project(state.camera);
      const visible = world.z >= -1 && world.z <= 1 && Math.abs(world.x) <= 1.08 && Math.abs(world.y) <= 1.08;
      anchor.button.hidden = !visible;
      if (!visible) return;
      const x = (world.x * 0.5 + 0.5) * rect.width;
      const y = (-world.y * 0.5 + 0.5) * rect.height;
      anchor.button.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
    });
  }

  function sampleIdFromHit(hit) {
    if (!hit?.object) return "";
    if (Number.isInteger(hit.instanceId)) return hit.object.userData.sampleIds?.[hit.instanceId] || "";
    return hit.object.userData.sampleId || "";
  }

  function pickNode(event) {
    if (!state.renderer || !state.camera || !state.nodeMeshes.length) return null;
    const rect = state.renderer.domElement.getBoundingClientRect();
    state.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    state.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    state.raycaster.setFromCamera(state.pointer, state.camera);
    return state.raycaster.intersectObjects(state.nodeMeshes, false)[0] || null;
  }

  function cameraPreset(mode, animateCamera = true) {
    if (!state.camera || !state.controls) return;
    state.viewMode = mode === "top" ? "top" : "perspective";
    el.viewButtons.forEach((button) => {
      button.setAttribute("aria-pressed", button.dataset.gmView === state.viewMode ? "true" : "false");
    });
    const span = state.sceneSpan || 120;
    const targetPosition = state.viewMode === "top"
      ? new THREE.Vector3(0, span * 1.35, 0.01)
      : new THREE.Vector3(span * 0.72, span * 0.88, span * 0.82);
    const startPosition = state.camera.position.clone();
    const startTarget = state.controls.target.clone();
    state.controls.enableRotate = state.viewMode !== "top";
    if (!animateCamera || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      state.camera.position.copy(targetPosition);
      state.controls.target.set(0, 0, 0);
      state.controls.update();
      return;
    }
    const started = performance.now();
    const duration = 420;
    const step = (now) => {
      const ratio = Math.min(1, (now - started) / duration);
      const eased = 1 - ((1 - ratio) ** 3);
      state.camera.position.lerpVectors(startPosition, targetPosition, eased);
      state.controls.target.lerpVectors(startTarget, new THREE.Vector3(0, 0, 0), eased);
      state.controls.update();
      if (ratio < 1) window.requestAnimationFrame(step);
    };
    window.requestAnimationFrame(step);
  }

  function createGround(group, texture) {
    const planeSize = STATIC_MAP_SIZE * WORLD_PER_PIXEL;
    const geometry = new THREE.PlaneGeometry(planeSize, planeSize);
    const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.96, metalness: 0, color: 0xffffff });
    const ground = new THREE.Mesh(geometry, material);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    group.add(ground);
    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({ color: 0x71847a, transparent: true, opacity: 0.42 })
    );
    edge.rotation.x = -Math.PI / 2;
    edge.position.y = 0.03;
    group.add(edge);
  }

  function createRoutes(group, routes, project) {
    const routeColors = [0x1677b8, 0x5856a6, 0x0e8f80, 0x3d6f9d];
    routes.forEach((route, index) => {
      const points = routePoints(route).map(project);
      if (points.length < 2) return;
      const sampled = points.length > 450
        ? points.filter((_point, pointIndex) => pointIndex % Math.ceil(points.length / 450) === 0 || pointIndex === points.length - 1)
        : points;
      sampled.forEach((point) => { point.y = 0.72; });
      const curve = new THREE.CatmullRomCurve3(sampled, false, "centripetal", 0.1);
      const geometry = new THREE.TubeGeometry(curve, Math.max(8, sampled.length * 2), 0.27, 6, false);
      const material = new THREE.MeshBasicMaterial({ color: routeColors[index % routeColors.length] });
      const tube = new THREE.Mesh(geometry, material);
      group.add(tube);
    });
  }

  function nodeInspectionColor(inspection, role) {
    const palette = {
      clear: role === "cap" ? 0x2a9a62 : 0x23744d,
      attention: role === "cap" ? 0xd09a31 : 0xa96f1e,
      issue: role === "cap" ? 0xc85b4f : 0x9f3e37,
      not_assessable: role === "cap" ? 0x829188 : 0x66756c,
      pending: role === "cap" ? 0x6a9b7e : 0x3e7d62
    };
    return palette[inspection?.status || "pending"] || palette.pending;
  }

  function updateNodeInspectionStyle(id, inspection) {
    const index = state.nodeIndexBySampleId.get(id);
    if (!Number.isInteger(index)) return;
    state.nodeMeshes.forEach((mesh) => {
      mesh.setColorAt(index, new THREE.Color(nodeInspectionColor(inspection, mesh.userData.role)));
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
    requestSceneRender(2);
  }

  async function createNodes(group, samples, project) {
    const positionedSamples = samples
      .map((sample, index) => ({ sample, index, position: samplePosition(sample) }))
      .filter((item) => item.position);
    const densityScale = Math.max(0.5, Math.min(1, Math.sqrt(48 / Math.max(1, positionedSamples.length))));
    const stemGeometry = new THREE.CylinderGeometry(0.52 * densityScale, 0.68 * densityScale, 1, 12);
    const capGeometry = new THREE.SphereGeometry(0.82 * densityScale, 14, 10);
    const stem = new THREE.InstancedMesh(
      stemGeometry,
      new THREE.MeshStandardMaterial({ roughness: 0.58, vertexColors: true }),
      positionedSamples.length
    );
    const cap = new THREE.InstancedMesh(
      capGeometry,
      new THREE.MeshStandardMaterial({ roughness: 0.42, vertexColors: true }),
      positionedSamples.length
    );
    stem.castShadow = true;
    cap.castShadow = true;
    stem.userData.role = "stem";
    cap.userData.role = "cap";
    stem.userData.sampleIds = [];
    cap.userData.sampleIds = stem.userData.sampleIds;
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const worldPosition = new THREE.Vector3();
    const fragment = document.createDocumentFragment();
    for (let instanceIndex = 0; instanceIndex < positionedSamples.length; instanceIndex += 1) {
      const { sample, index, position } = positionedSamples[instanceIndex];
      const projected = project(position);
      const inspection = inspectionFor(sample);
      const height = 3.2;
      const id = sampleId(sample, index);
      worldPosition.set(projected.x, 0.35 + height / 2, projected.z);
      scale.set(1, height, 1);
      matrix.compose(worldPosition, quaternion, scale);
      stem.setMatrixAt(instanceIndex, matrix);
      stem.setColorAt(instanceIndex, new THREE.Color(nodeInspectionColor(inspection, "stem")));
      worldPosition.set(projected.x, 0.35 + height, projected.z);
      scale.set(1, 1, 1);
      matrix.compose(worldPosition, quaternion, scale);
      cap.setMatrixAt(instanceIndex, matrix);
      cap.setColorAt(instanceIndex, new THREE.Color(nodeInspectionColor(inspection, "cap")));
      stem.userData.sampleIds.push(id);
      state.nodeIndexBySampleId.set(id, instanceIndex);
      state.nodePositions.set(id, new THREE.Vector3(projected.x, 0, projected.z));
      if (el.hitLayer) {
        const hit = document.createElement("button");
        hit.type = "button";
        hit.className = "gm-node-hit";
        hit.dataset.sampleId = id;
        hit.setAttribute("aria-label", `${formatTime(sample.collected_at)}，${inspectionStatusLabel(inspection)}，查看四路绿化图片`);
        fragment.appendChild(hit);
        state.nodeAnchors.push({ sampleId: id, position: worldPosition.clone(), button: hit });
      }
      if ((instanceIndex + 1) % 200 === 0) {
        const ratio = (instanceIndex + 1) / Math.max(1, positionedSamples.length);
        setLoadProgress(84 + ratio * 13, `正在生成采集节点 ${instanceIndex + 1}/${positionedSamples.length}`);
        await new Promise((resolve) => window.requestAnimationFrame(resolve));
      }
    }
    stem.instanceMatrix.needsUpdate = true;
    cap.instanceMatrix.needsUpdate = true;
    if (stem.instanceColor) stem.instanceColor.needsUpdate = true;
    if (cap.instanceColor) cap.instanceColor.needsUpdate = true;
    group.add(stem, cap);
    state.nodeMeshes.push(stem, cap);
    if (el.hitLayer) el.hitLayer.appendChild(fragment);
    const ringInner = Math.max(0.68, 1.05 * densityScale);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(ringInner, ringInner + 0.48, 32),
      new THREE.MeshBasicMaterial({ color: 0xc77a12, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.42;
    ring.visible = false;
    group.add(ring);
    state.selectedRing = ring;
  }

  async function buildMap(samples, routes) {
    const buildId = state.mapBuildId + 1;
    state.mapBuildId = buildId;
    ensureScene();
    setLoadProgress(62, "正在计算地图范围");
    const samplePoints = samples.map(samplePosition).filter(Boolean);
    const allRoutePoints = routes.flatMap(routePoints);
    const allPoints = samplePoints.concat(allRoutePoints);
    const view = chooseStaticMapView(allPoints);
    if (!view) throw new Error("当前日期没有有效定位点");
    setLoadProgress(70, "正在加载高德静态底图");
    const { texture, fallback } = await loadMapTexture(view);
    if (buildId !== state.mapBuildId) {
      texture.dispose();
      return;
    }
    clearSceneContent();
    state.mapTexture = texture;
    const group = new THREE.Group();
    state.contentGroup = group;
    state.scene.add(group);
    const project = mapProjector(view);
    setLoadProgress(80, "正在生成路线和地图地面");
    createGround(group, texture);
    createRoutes(group, routes, project);
    setLoadProgress(84, `正在生成 ${samples.length} 个采集节点`);
    await createNodes(group, samples, project);
    state.sceneSpan = STATIC_MAP_SIZE * WORLD_PER_PIXEL;
    state.camera.far = state.sceneSpan * 6;
    state.camera.updateProjectionMatrix();
    cameraPreset(state.viewMode, false);
    requestSceneRender(3);
    if (el.mapError) {
      el.mapError.hidden = true;
      el.mapError.textContent = "";
    }
    if (fallback && el.mapMeta) {
      el.mapMeta.textContent += " · 静态底图暂不可用";
    }
    setLoadProgress(98, "正在打开最新采集节点");
    selectSample(state.selectedSampleId || sampleId(samples[samples.length - 1], samples.length - 1), false);
  }

  function selectSample(id, focus = false) {
    const sample = state.visibleSampleById.get(id) || state.visibleSamples[0];
    if (!sample) {
      state.selectedSampleId = "";
      syncVegetationTableSelection();
      renderSampleDetail(null);
      if (state.selectedRing) state.selectedRing.visible = false;
      return;
    }
    state.selectedSampleId = sampleId(sample, state.visibleSamples.indexOf(sample));
    syncVegetationTableSelection();
    renderSampleDetail(sample);
    renderProjects(sample);
    void ensureInspection(sample);
    const nodePosition = state.nodePositions.get(state.selectedSampleId);
    if (state.selectedRing && nodePosition) {
      state.selectedRing.position.x = nodePosition.x;
      state.selectedRing.position.z = nodePosition.z;
      state.selectedRing.visible = true;
    }
    if (focus && nodePosition && state.controls && state.camera) {
      const nextTarget = new THREE.Vector3(nodePosition.x, 0, nodePosition.z);
      const offset = state.camera.position.clone().sub(state.controls.target);
      state.controls.target.copy(nextTarget);
      state.camera.position.copy(nextTarget.clone().add(offset));
      state.controls.update();
    }
    requestSceneRender(3);
  }

  async function loadInspectionsForDate() {
    const requestedVehicle = state.vehicleId;
    const requestedDate = state.dateKey;
    if (!requestedVehicle || !requestedDate) {
      state.inspections = new Map();
      state.inspectionDateKey = "";
      return;
    }
    const query = new URLSearchParams({ vehicle_id: requestedVehicle, date: requestedDate });
    const payload = await fetchJson(`${API.greenInspections}?${query.toString()}`).catch(() => ({ items: [] }));
    if (state.vehicleId !== requestedVehicle || state.dateKey !== requestedDate) return;
    state.inspections = new Map(
      (Array.isArray(payload.items) ? payload.items : [])
        .filter((item) => item?.sample_id)
        .map((item) => [String(item.sample_id), item])
    );
    state.inspectionDateKey = requestedDate;
  }

  async function renderDate() {
    state.vegetationTablePage = 0;
    state.visibleSamples = state.allSamples
      .filter((sample) => dateKey(sample.collected_at) === state.dateKey && samplePosition(sample))
      .sort((left, right) => (Date.parse(left.collected_at || "") || 0) - (Date.parse(right.collected_at || "") || 0));
    state.visibleSampleById = new Map(
      state.visibleSamples.map((sample, index) => [sampleId(sample, index), sample])
    );
    state.selectedSampleId = "";
    if (!state.visibleSamples.length) {
      state.routes = [];
      clearSceneContent();
      updateSummary([], []);
      renderVegetationTable();
      renderSampleDetail(null);
      if (el.mapError) {
        el.mapError.textContent = `${state.vehicleId} 在 ${formatDateKey(state.dateKey)} 没有有效定位采集点。`;
        el.mapError.hidden = false;
      }
      return;
    }
    setBusy(true, "正在读取当日分析与巡逻路线", 50);
    try {
      const [routes] = await Promise.all([
        loadRoutes(state.visibleSamples).catch((error) => {
          console.warn("green-management route load failed", error);
          return [];
        }),
        loadInspectionsForDate()
      ]);
      state.routes = routes;
      setLoadProgress(58, "路线与绿化分析已就绪");
      updateSummary(state.visibleSamples, state.routes);
      renderVegetationTable();
      await buildMap(state.visibleSamples, state.routes);
      setStatus("数据已更新", "ok");
    } finally {
      setBusy(false);
    }
  }

  async function selectVehicle(vehicleId, preferredDate = "") {
    state.vehicleId = String(vehicleId || "").trim();
    if (!state.vehicleId) return;
    state.inspectionPending.clear();
    state.inspectionErrors.clear();
    state.inspections = new Map();
    state.inspectionDateKey = "";
    if (el.vehicle) el.vehicle.value = state.vehicleId;
    setBusy(true, "正在读取车辆采集记录", 30);
    setStatus("数据加载中", "loading");
    try {
      const query = new URLSearchParams({
        vehicle_id: state.vehicleId,
        source: "all",
        limit: String(SAMPLE_LIMIT)
      });
      const payload = await fetchJson(`${API.samples}?${query.toString()}`);
      setLoadProgress(44, `已读取 ${formatNumber(payload.samples?.length || 0)} 个近期节点`);
      state.allSamples = (Array.isArray(payload.samples) ? payload.samples : [])
        .filter((sample) => !sample?.skipped && samplePosition(sample));
      state.dateKey = renderDateOptions(state.allSamples, preferredDate);
      if (!state.dateKey) {
        state.visibleSamples = [];
        state.routes = [];
        clearSceneContent();
        updateSummary([], []);
        renderVegetationTable();
        renderSampleDetail(null);
        if (el.mapError) {
          el.mapError.textContent = `${state.vehicleId} 暂无可用采集记录。`;
          el.mapError.hidden = false;
        }
        setStatus("暂无采集", "error");
        return;
      }
      await renderDate();
    } catch (error) {
      setStatus("数据不可用", "error");
      if (el.mapError) {
        el.mapError.textContent = error.message || "绿化管理数据加载失败。";
        el.mapError.hidden = false;
      }
    } finally {
      setBusy(false);
    }
  }

  async function initialize() {
    setBusy(true, "正在验证访问权限", 4);
    try {
      const auth = await fetchJson(API.auth);
      state.authenticated = hasReadPermission(auth);
      if (!state.authenticated) {
        if (el.auth) {
          el.auth.hidden = false;
          el.auth.textContent = auth?.authenticated
            ? "当前账号缺少 vehicle:read 权限或邮箱未验证。"
            : "请先登录后查看绿化管理。";
        }
        setStatus("需授权", "error");
        return;
      }
      if (el.auth) el.auth.hidden = true;
      setLoadProgress(12, "正在读取车辆列表");
      const vehiclePayload = await fetchJson(API.vehicles);
      const preferred = renderVehicleOptions(vehiclePayload.vehicles);
      if (!preferred) throw new Error("暂无可用巡逻车辆");
      setLoadProgress(24, `已找到 ${formatNumber(vehiclePayload.vehicles?.length || 0)} 台采集车辆`);
      await refreshGreenQueueStatus();
      await selectVehicle(preferred);
      window.setInterval(() => void refreshGreenQueueStatus(), 20 * 1000);
    } catch (error) {
      setStatus("初始化失败", "error");
      if (el.auth) {
        el.auth.hidden = false;
        el.auth.textContent = error.message || "绿化管理初始化失败。";
      }
      if (el.mapError) {
        el.mapError.hidden = false;
        el.mapError.textContent = error.message || "绿化管理初始化失败。";
      }
    } finally {
      setBusy(false);
    }
  }

  el.vehicle?.addEventListener("change", () => {
    void selectVehicle(el.vehicle.value);
  });
  el.date?.addEventListener("change", () => {
    state.dateKey = el.date.value;
    void renderDate().catch((error) => {
      setStatus("日期加载失败", "error");
      if (el.mapError) {
        el.mapError.textContent = error.message || "日期数据加载失败。";
        el.mapError.hidden = false;
      }
    });
  });
  el.refresh?.addEventListener("click", () => {
    if (!state.busy && state.vehicleId) void selectVehicle(state.vehicleId, state.dateKey);
  });
  el.reset?.addEventListener("click", () => cameraPreset(state.viewMode));
  el.viewButtons.forEach((button) => {
    button.addEventListener("click", () => cameraPreset(button.dataset.gmView));
  });
  el.vegetationFilters.forEach((button) => {
    button.addEventListener("click", () => {
      state.vegetationFilter = button.dataset.gmVegetationFilter || "all";
      state.vegetationTablePage = 0;
      renderVegetationTable();
    });
  });
  el.vegetationTablePrev?.addEventListener("click", () => {
    state.vegetationTablePage = Math.max(0, state.vegetationTablePage - 1);
    renderVegetationTable();
  });
  el.vegetationTableNext?.addEventListener("click", () => {
    state.vegetationTablePage += 1;
    renderVegetationTable();
  });
  el.vegetationTableBody?.addEventListener("click", (event) => {
    const button = event.target.closest(".gm-table-locate");
    const id = button?.dataset.sampleId;
    if (id) selectSample(id, true);
  });
  root.addEventListener("click", (event) => {
    const entry = event.target.closest("[data-gm-archive-sample]");
    const id = entry?.dataset.gmArchiveSample;
    if (id) selectSample(id, true);
  });
  el.previewClose?.addEventListener("click", () => el.preview?.close());
  el.preview?.addEventListener("click", (event) => {
    if (event.target === el.preview) el.preview.close();
  });

  void initialize();
}
