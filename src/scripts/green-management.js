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
    vehicles: "/api/park-pcm/crowd/vehicles",
    samples: "/api/park-pcm/crowd/samples",
    routes: "/api/park-pcm/crowd/routes"
  };
  const SAMPLE_LIMIT = 8000;
  const INITIAL_SAMPLE_LIMIT = 1000;
  const ROUTE_MAX_POINTS = 900;
  const ROUTE_MAX_REQUESTS = 12;
  const STATIC_MAP_SIZE = 1024;
  const WORLD_PER_PIXEL = 0.12;

  const el = {
    status: root.querySelector("[data-gm-status]"),
    auth: root.querySelector("[data-gm-auth]"),
    vehicle: root.querySelector("[data-gm-vehicle]"),
    date: root.querySelector("[data-gm-date]"),
    refresh: root.querySelector("[data-gm-refresh]"),
    reset: root.querySelector("[data-gm-reset]"),
    viewButtons: [...root.querySelectorAll("[data-gm-view]")],
    stage: root.querySelector("[data-gm-stage]"),
    map: root.querySelector("[data-gm-map]"),
    loading: root.querySelector("[data-gm-loading]"),
    mapError: root.querySelector("[data-gm-map-error]"),
    mapMeta: root.querySelector("[data-gm-map-meta]"),
    tooltip: root.querySelector("[data-gm-tooltip]"),
    hitLayer: root.querySelector("[data-gm-hit-layer]"),
    nodeTitle: root.querySelector("[data-gm-node-title]"),
    nodePeople: root.querySelector("[data-gm-node-people]"),
    nodeMeta: root.querySelector("[data-gm-node-meta]"),
    frames: root.querySelector("[data-gm-frames]"),
    trend: root.querySelector("[data-gm-trend]"),
    trendSummary: root.querySelector("[data-gm-trend-summary]"),
    preview: root.querySelector("[data-gm-preview]"),
    previewTitle: root.querySelector("[data-gm-preview-title]"),
    previewMeta: root.querySelector("[data-gm-preview-meta]"),
    previewImage: root.querySelector("[data-gm-preview-image]"),
    previewClose: root.querySelector("[data-gm-preview-close]")
  };
  el.metrics = Object.fromEntries(
    [...root.querySelectorAll("[data-gm-metric]")].map((node) => [node.dataset.gmMetric, node])
  );
  el.advice = Object.fromEntries(
    [...root.querySelectorAll("[data-gm-advice]")].map((node) => [node.dataset.gmAdvice, node])
  );

  const state = {
    busy: false,
    authenticated: false,
    vehicleId: "",
    dateKey: "",
    allSamples: [],
    visibleSamples: [],
    routes: [],
    selectedSampleId: "",
    viewMode: "perspective",
    mapBuildId: 0,
    nodeMeshes: [],
    nodeAnchors: [],
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
    resizeObserver: null,
    animationFrame: 0
  };

  function setStatus(text, status = "loading") {
    if (!el.status) return;
    const strong = el.status.querySelector("strong");
    if (strong) strong.textContent = text;
    el.status.dataset.state = status;
  }

  function setBusy(busy, message) {
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

  function samplePeopleCount(sample) {
    const direct = number(sample?.analysis?.people_count);
    if (direct != null) return Math.max(0, direct);
    const counts = (Array.isArray(sample?.frames) ? sample.frames : [])
      .map((frame) => number(frame?.analysis?.people_count))
      .filter((value) => value != null);
    return counts.length ? counts.reduce((sum, value) => sum + value, 0) : null;
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

  function sampleVehicles(samples) {
    const counts = new Map();
    samples.forEach((sample) => {
      if (!samplePosition(sample)) return;
      const vehicleId = String(sample?.vehicle_id || "").trim();
      if (!vehicleId) return;
      const current = counts.get(vehicleId) || { count: 0, latest: 0, people: 0, routeCount: 0, routeLatest: 0 };
      current.count += 1;
      current.latest = Math.max(current.latest, Date.parse(sample.collected_at || "") || 0);
      current.people += samplePeopleCount(sample) || 0;
      if (routeRequestItems([sample]).length) {
        current.routeCount += 1;
        current.routeLatest = Math.max(current.routeLatest, Date.parse(sample.collected_at || "") || 0);
      }
      counts.set(vehicleId, current);
    });
    return counts;
  }

  function renderVehicleOptions(vehicles, initialSamples) {
    if (!el.vehicle) return "";
    const sampleCounts = sampleVehicles(initialSamples);
    const rows = new Map();
    (Array.isArray(vehicles) ? vehicles : []).forEach((vehicle) => {
      const vehicleId = String(vehicle?.vehicle_id || "").trim();
      if (vehicleId) rows.set(vehicleId, vehicle);
    });
    sampleCounts.forEach((_value, vehicleId) => {
      if (!rows.has(vehicleId)) rows.set(vehicleId, { vehicle_id: vehicleId, fresh: false });
    });
    const ranked = [...rows.values()].sort((left, right) => {
      const leftStats = sampleCounts.get(left.vehicle_id);
      const rightStats = sampleCounts.get(right.vehicle_id);
      if (Boolean(leftStats) !== Boolean(rightStats)) return leftStats ? -1 : 1;
      if ((rightStats?.routeLatest || 0) !== (leftStats?.routeLatest || 0)) return (rightStats?.routeLatest || 0) - (leftStats?.routeLatest || 0);
      if ((rightStats?.latest || 0) !== (leftStats?.latest || 0)) return (rightStats?.latest || 0) - (leftStats?.latest || 0);
      if (Boolean(left.fresh) !== Boolean(right.fresh)) return left.fresh ? -1 : 1;
      return String(left.vehicle_id).localeCompare(String(right.vehicle_id), "zh-CN");
    });
    el.vehicle.replaceChildren();
    ranked.forEach((vehicle) => {
      const stats = sampleCounts.get(vehicle.vehicle_id);
      const option = document.createElement("option");
      option.value = vehicle.vehicle_id;
      option.textContent = stats
        ? `${vehicle.vehicle_id} · ${stats.count} 条近期采集${stats.routeCount ? " · 路线可用" : ""}`
        : `${vehicle.vehicle_id} · 暂无近期采集`;
      el.vehicle.appendChild(option);
    });
    const routeCandidates = [...sampleCounts.entries()].filter((entry) => entry[1].routeLatest > 0);
    const newestRouteAt = Math.max(0, ...routeCandidates.map((entry) => entry[1].routeLatest));
    const recentRouteCandidates = routeCandidates.filter((entry) => entry[1].routeLatest >= newestRouteAt - 24 * 60 * 60 * 1000);
    const preferredPool = recentRouteCandidates.length ? recentRouteCandidates : [...sampleCounts.entries()];
    const preferred = preferredPool
      .sort((left, right) => right[1].people - left[1].people || right[1].routeLatest - left[1].routeLatest || right[1].latest - left[1].latest)[0]?.[0];
    return preferred || ranked[0]?.vehicle_id || "";
  }

  function renderDateOptions(samples, preferredDate = "") {
    if (!el.date) return "";
    const days = new Map();
    samples.forEach((sample) => {
      const key = dateKey(sample.collected_at);
      if (!key || !samplePosition(sample)) return;
      const current = days.get(key) || { count: 0, people: 0 };
      current.count += 1;
      current.people += samplePeopleCount(sample) || 0;
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

  function updateSummary(samples, routes) {
    const counts = samples.map(samplePeopleCount).filter((value) => value != null);
    const total = counts.reduce((sum, value) => sum + value, 0);
    const peakSample = samples.reduce((best, sample) => {
      const count = samplePeopleCount(sample);
      if (count == null) return best;
      return !best || count > best.count ? { sample, count } : best;
    }, null);
    setMetric("samples", String(samples.length));
    setMetric("routes", String(routes.length));
    setMetric("people", counts.length ? `${formatNumber(total)} 人` : "待识别");
    setMetric("peak", peakSample ? `${formatNumber(peakSample.count)} 人` : "-");
    setMetric("peak-time", peakSample ? formatTime(peakSample.sample.collected_at) : "等待数据");

    const average = counts.length ? total / counts.length : 0;
    const peak = peakSample?.count || 0;
    if (el.advice.priority) {
      el.advice.priority.textContent = peak >= 8 || average >= 4
        ? "高 · 加密步道与草坪边缘巡查"
        : peak >= 3 || average >= 1.5
          ? "中 · 按日检查踩踏与垃圾"
          : "常规 · 保持计划养护";
    }
    const hourStats = new Map();
    samples.forEach((sample) => {
      const count = samplePeopleCount(sample);
      const date = new Date(sample.collected_at || "");
      if (count == null || Number.isNaN(date.getTime())) return;
      const hourText = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Shanghai",
        hour: "2-digit",
        hour12: false
      }).format(date);
      const hour = Number(hourText) % 24;
      const current = hourStats.get(hour) || { sum: 0, count: 0 };
      current.sum += count;
      current.count += 1;
      hourStats.set(hour, current);
    });
    const quietHour = [...hourStats.entries()]
      .sort((left, right) => left[1].sum / left[1].count - right[1].sum / right[1].count || left[0] - right[0])[0]?.[0];
    if (el.advice.window) {
      el.advice.window.textContent = quietHour == null
        ? "样本不足"
        : `${String(quietHour).padStart(2, "0")}:00-${String((quietHour + 2) % 24).padStart(2, "0")}:00 · 样本低谷`;
    }
    const threshold = Math.max(3, Math.ceil(peak * 0.7));
    const hotspots = peak ? samples.filter((sample) => (samplePeopleCount(sample) || 0) >= threshold).length : 0;
    if (el.advice.hotspots) {
      el.advice.hotspots.textContent = hotspots
        ? `${hotspots} 个 · 优先检查草坪边界与灌木带`
        : "暂无高人流节点";
    }
    if (el.mapMeta) {
      el.mapMeta.textContent = `${state.vehicleId || "-"} · ${formatDateKey(state.dateKey)} · ${samples.length} 节点 · ${routes.length} 路线`;
    }
  }

  function svgNode(tag, attributes = {}, text = null) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
    if (text != null) node.textContent = String(text);
    return node;
  }

  function renderTrend(samples) {
    if (!el.trend) return;
    el.trend.replaceChildren();
    const raw = samples
      .map((sample) => ({
        time: Date.parse(sample.collected_at || ""),
        people: samplePeopleCount(sample)
      }))
      .filter((point) => Number.isFinite(point.time) && point.people != null)
      .sort((left, right) => left.time - right.time);
    if (raw.length < 2) {
      const empty = document.createElement("p");
      empty.className = "gm-trend-empty";
      empty.textContent = raw.length ? "当前日期只有一个有效时间点。" : "当前日期暂无可用人流识别结果。";
      el.trend.appendChild(empty);
      if (el.trendSummary) el.trendSummary.textContent = "等待更多识别样本";
      return;
    }
    const points = raw.length <= 36
      ? raw
      : Array.from({ length: 36 }, (_unused, index) => {
          const start = Math.floor(index * raw.length / 36);
          const end = Math.max(start + 1, Math.floor((index + 1) * raw.length / 36));
          const bucket = raw.slice(start, end);
          return {
            time: bucket.reduce((sum, point) => sum + point.time, 0) / bucket.length,
            people: bucket.reduce((sum, point) => sum + point.people, 0) / bucket.length
          };
        });
    const width = 1000;
    const height = 230;
    const pad = { top: 16, right: 20, bottom: 34, left: 40 };
    const plotWidth = width - pad.left - pad.right;
    const plotHeight = height - pad.top - pad.bottom;
    const maxPeople = Math.max(1, ...points.map((point) => point.people));
    const minTime = points[0].time;
    const maxTime = points[points.length - 1].time;
    const timeSpan = Math.max(1, maxTime - minTime);
    const coords = points.map((point) => ({
      ...point,
      x: pad.left + ((point.time - minTime) / timeSpan) * plotWidth,
      y: pad.top + (1 - point.people / maxPeople) * plotHeight
    }));
    const baseY = pad.top + plotHeight;
    const svg = svgNode("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "当日人流时间趋势" });
    [0, 0.5, 1].forEach((ratio) => {
      const y = pad.top + (1 - ratio) * plotHeight;
      svg.appendChild(svgNode("line", { class: "gm-trend-grid", x1: pad.left, y1: y, x2: width - pad.right, y2: y }));
      svg.appendChild(svgNode("text", { class: "gm-trend-label", x: pad.left - 8, y: y + 4, "text-anchor": "end" }, formatNumber(maxPeople * ratio)));
    });
    const linePoints = coords.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
    const areaPath = [
      `M ${coords[0].x.toFixed(2)} ${baseY.toFixed(2)}`,
      ...coords.map((point) => `L ${point.x.toFixed(2)} ${point.y.toFixed(2)}`),
      `L ${coords[coords.length - 1].x.toFixed(2)} ${baseY.toFixed(2)}`,
      "Z"
    ].join(" ");
    svg.appendChild(svgNode("path", { class: "gm-trend-area", d: areaPath }));
    svg.appendChild(svgNode("polyline", { class: "gm-trend-line", points: linePoints }));
    coords.forEach((point) => {
      const dot = svgNode("circle", { class: "gm-trend-dot", cx: point.x, cy: point.y, r: 3.5 });
      dot.appendChild(svgNode("title", {}, `${formatTime(point.time)} · ${formatNumber(point.people)} 人`));
      svg.appendChild(dot);
    });
    svg.appendChild(svgNode("text", { class: "gm-trend-label", x: pad.left, y: height - 9 }, formatTime(minTime, false)));
    svg.appendChild(svgNode("text", { class: "gm-trend-label", x: width - pad.right, y: height - 9, "text-anchor": "end" }, formatTime(maxTime, false)));
    el.trend.appendChild(svg);
    const average = raw.reduce((sum, point) => sum + point.people, 0) / raw.length;
    if (el.trendSummary) {
      el.trendSummary.textContent = `${raw.length} 条识别样本 · 平均 ${formatNumber(average)} 人/节点 · 峰值 ${formatNumber(Math.max(...raw.map((point) => point.people)))} 人`;
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
      const count = number(frame?.analysis?.people_count);
      el.previewMeta.textContent = `${formatTime(sample?.collected_at)} · ${count == null ? "人数待识别" : `${formatNumber(count)} 人`}`;
    }
    if (typeof el.preview.showModal === "function") el.preview.showModal();
    else el.preview.setAttribute("open", "");
  }

  function renderSampleDetail(sample) {
    if (!sample) {
      if (el.nodeTitle) el.nodeTitle.textContent = "采集节点";
      if (el.nodePeople) el.nodePeople.textContent = "-";
      if (el.nodeMeta) el.nodeMeta.textContent = "在地图中选择采集节点。";
      if (el.frames) {
        const empty = document.createElement("p");
        empty.className = "gm-empty";
        empty.textContent = "等待四路现场图片。";
        el.frames.replaceChildren(empty);
      }
      return;
    }
    const position = samplePosition(sample);
    const people = samplePeopleCount(sample);
    if (el.nodeTitle) el.nodeTitle.textContent = `${sample.vehicle_id || "-"} · ${formatTime(sample.collected_at)}`;
    if (el.nodePeople) el.nodePeople.textContent = people == null ? "人数待识别" : `${formatNumber(people)} 人`;
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
      return;
    }
    frames.forEach((frame) => {
      const figure = document.createElement("figure");
      figure.className = "gm-frame";
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
      const framePeople = number(frame?.analysis?.people_count);
      count.textContent = framePeople == null ? "待识别" : `${formatNumber(framePeople)} 人`;
      caption.append(camera, count);
      figure.append(button, caption);
      el.frames.appendChild(figure);
    });
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
    if (el.hitLayer) el.hitLayer.replaceChildren();
    state.selectedRing = null;
    if (state.contentGroup && state.scene) {
      state.scene.remove(state.contentGroup);
      disposeObject(state.contentGroup);
    }
    state.contentGroup = null;
    if (state.mapTexture) state.mapTexture.dispose();
    state.mapTexture = null;
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
      if (hit?.object?.userData?.sampleId) selectSample(hit.object.userData.sampleId, true);
    });
    canvas.addEventListener("pointermove", (event) => {
      const hit = pickNode(event);
      canvas.style.cursor = hit ? "pointer" : "grab";
      if (!el.tooltip || !el.stage) return;
      if (!hit?.object?.userData?.sampleId) {
        el.tooltip.hidden = true;
        return;
      }
      const sample = state.visibleSamples.find((row, index) => sampleId(row, index) === hit.object.userData.sampleId);
      if (!sample) {
        el.tooltip.hidden = true;
        return;
      }
      const rect = el.stage.getBoundingClientRect();
      el.tooltip.textContent = `${formatTime(sample.collected_at)} · ${samplePeopleCount(sample) == null ? "人数待识别" : `${formatNumber(samplePeopleCount(sample))} 人`} · 4 路现场图`;
      el.tooltip.style.left = `${Math.max(0, Math.min(rect.width - 230, event.clientX - rect.left))}px`;
      el.tooltip.style.top = `${Math.max(0, Math.min(rect.height - 70, event.clientY - rect.top))}px`;
      el.tooltip.hidden = false;
    });
    canvas.addEventListener("pointerleave", () => {
      if (el.tooltip) el.tooltip.hidden = true;
    });

    state.resizeObserver = new ResizeObserver(resizeScene);
    state.resizeObserver.observe(el.map);
    resizeScene();
    animate();
  }

  function resizeScene() {
    if (!state.renderer || !state.camera || !el.map) return;
    const rect = el.map.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    state.renderer.setSize(width, height, false);
    state.camera.aspect = width / height;
    state.camera.updateProjectionMatrix();
  }

  function animate() {
    state.animationFrame = window.requestAnimationFrame(animate);
    if (state.selectedRing) {
      const pulse = 1 + Math.sin(performance.now() * 0.004) * 0.12;
      state.selectedRing.scale.set(pulse, pulse, pulse);
      state.selectedRing.material.opacity = 0.72 + Math.sin(performance.now() * 0.004) * 0.16;
    }
    state.controls?.update();
    updateNodeHitTargets();
    if (state.renderer && state.scene && state.camera) state.renderer.render(state.scene, state.camera);
  }

  function updateNodeHitTargets() {
    if (!state.camera || !el.map || !state.nodeAnchors.length) return;
    const rect = el.map.getBoundingClientRect();
    const world = new THREE.Vector3();
    state.nodeAnchors.forEach((anchor) => {
      anchor.object.getWorldPosition(world);
      world.project(state.camera);
      const visible = world.z >= -1 && world.z <= 1 && Math.abs(world.x) <= 1.08 && Math.abs(world.y) <= 1.08;
      anchor.button.hidden = !visible;
      if (!visible) return;
      anchor.button.style.left = `${(world.x * 0.5 + 0.5) * rect.width}px`;
      anchor.button.style.top = `${(-world.y * 0.5 + 0.5) * rect.height}px`;
    });
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

  function createNodes(group, samples, project) {
    const densityScale = Math.max(0.5, Math.min(1, Math.sqrt(48 / Math.max(1, samples.length))));
    const stemGeometry = new THREE.CylinderGeometry(0.52 * densityScale, 0.68 * densityScale, 1, 12);
    const capGeometry = new THREE.SphereGeometry(0.82 * densityScale, 14, 10);
    samples.forEach((sample, index) => {
      const position = samplePosition(sample);
      if (!position) return;
      const projected = project(position);
      const people = samplePeopleCount(sample);
      const height = 2.6 + Math.min(10, people || 0) * 0.24;
      const color = people != null && people > 0 ? 0x20895a : 0x3e7d62;
      const stem = new THREE.Mesh(stemGeometry, new THREE.MeshStandardMaterial({ color, roughness: 0.58 }));
      stem.scale.y = height;
      stem.position.set(projected.x, 0.35 + height / 2, projected.z);
      stem.castShadow = true;
      stem.userData.sampleId = sampleId(sample, index);
      const cap = new THREE.Mesh(capGeometry, new THREE.MeshStandardMaterial({ color: people ? 0x2ab66f : 0x6a9b7e, roughness: 0.42 }));
      cap.position.set(projected.x, 0.35 + height, projected.z);
      cap.castShadow = true;
      cap.userData.sampleId = stem.userData.sampleId;
      group.add(stem, cap);
      state.nodeMeshes.push(stem, cap);
      if (el.hitLayer) {
        const hit = document.createElement("button");
        hit.type = "button";
        hit.className = "gm-node-hit";
        hit.setAttribute("aria-label", `${formatTime(sample.collected_at)}，${people == null ? "人数待识别" : `${formatNumber(people)} 人`}，查看四路图片`);
        hit.addEventListener("click", (event) => {
          event.stopPropagation();
          selectSample(stem.userData.sampleId, true);
        });
        hit.addEventListener("pointerenter", () => {
          if (!el.tooltip) return;
          el.tooltip.textContent = `${formatTime(sample.collected_at)} · ${people == null ? "人数待识别" : `${formatNumber(people)} 人`} · 4 路现场图`;
          el.tooltip.style.left = hit.style.left;
          el.tooltip.style.top = hit.style.top;
          el.tooltip.hidden = false;
        });
        hit.addEventListener("pointerleave", () => {
          if (el.tooltip) el.tooltip.hidden = true;
        });
        el.hitLayer.appendChild(hit);
        state.nodeAnchors.push({ sampleId: stem.userData.sampleId, object: cap, button: hit });
      }
    });
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
    const samplePoints = samples.map(samplePosition).filter(Boolean);
    const allRoutePoints = routes.flatMap(routePoints);
    const allPoints = samplePoints.concat(allRoutePoints);
    const view = chooseStaticMapView(allPoints);
    if (!view) throw new Error("当前日期没有有效定位点");
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
    createGround(group, texture);
    createRoutes(group, routes, project);
    createNodes(group, samples, project);
    state.sceneSpan = STATIC_MAP_SIZE * WORLD_PER_PIXEL;
    state.camera.far = state.sceneSpan * 6;
    state.camera.updateProjectionMatrix();
    cameraPreset(state.viewMode, false);
    if (el.mapError) {
      el.mapError.hidden = true;
      el.mapError.textContent = "";
    }
    if (fallback && el.mapMeta) {
      el.mapMeta.textContent += " · 静态底图暂不可用";
    }
    selectSample(state.selectedSampleId || sampleId(samples[samples.length - 1], samples.length - 1), false);
  }

  function selectSample(id, focus = false) {
    const sample = state.visibleSamples.find((row, index) => sampleId(row, index) === id) || state.visibleSamples[0];
    if (!sample) {
      state.selectedSampleId = "";
      renderSampleDetail(null);
      if (state.selectedRing) state.selectedRing.visible = false;
      return;
    }
    state.selectedSampleId = sampleId(sample, state.visibleSamples.indexOf(sample));
    renderSampleDetail(sample);
    const mesh = state.nodeMeshes.find((node) => node.userData.sampleId === state.selectedSampleId);
    if (state.selectedRing && mesh) {
      state.selectedRing.position.x = mesh.position.x;
      state.selectedRing.position.z = mesh.position.z;
      state.selectedRing.visible = true;
    }
    if (focus && mesh && state.controls && state.camera) {
      const nextTarget = new THREE.Vector3(mesh.position.x, 0, mesh.position.z);
      const offset = state.camera.position.clone().sub(state.controls.target);
      state.controls.target.copy(nextTarget);
      state.camera.position.copy(nextTarget.clone().add(offset));
      state.controls.update();
    }
  }

  async function renderDate() {
    state.visibleSamples = state.allSamples
      .filter((sample) => dateKey(sample.collected_at) === state.dateKey && samplePosition(sample))
      .sort((left, right) => (Date.parse(left.collected_at || "") || 0) - (Date.parse(right.collected_at || "") || 0));
    state.selectedSampleId = "";
    if (!state.visibleSamples.length) {
      state.routes = [];
      clearSceneContent();
      updateSummary([], []);
      renderTrend([]);
      renderSampleDetail(null);
      if (el.mapError) {
        el.mapError.textContent = `${state.vehicleId} 在 ${formatDateKey(state.dateKey)} 没有有效定位采集点。`;
        el.mapError.hidden = false;
      }
      return;
    }
    setBusy(true, "正在加载路线与高德静态地图");
    try {
      state.routes = await loadRoutes(state.visibleSamples).catch((error) => {
        console.warn("green-management route load failed", error);
        return [];
      });
      updateSummary(state.visibleSamples, state.routes);
      renderTrend(state.visibleSamples);
      await buildMap(state.visibleSamples, state.routes);
      setStatus("数据已更新", "ok");
    } finally {
      setBusy(false);
    }
  }

  async function selectVehicle(vehicleId, preferredDate = "") {
    state.vehicleId = String(vehicleId || "").trim();
    if (!state.vehicleId) return;
    if (el.vehicle) el.vehicle.value = state.vehicleId;
    setBusy(true, "正在读取车辆采集记录");
    setStatus("数据加载中", "loading");
    try {
      const query = new URLSearchParams({
        vehicle_id: state.vehicleId,
        source: "all",
        limit: String(SAMPLE_LIMIT)
      });
      const payload = await fetchJson(`${API.samples}?${query.toString()}`);
      state.allSamples = (Array.isArray(payload.samples) ? payload.samples : [])
        .filter((sample) => !sample?.skipped && samplePosition(sample));
      state.dateKey = renderDateOptions(state.allSamples, preferredDate);
      if (!state.dateKey) {
        state.visibleSamples = [];
        state.routes = [];
        clearSceneContent();
        updateSummary([], []);
        renderTrend([]);
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
    setBusy(true, "正在读取园区巡逻数据");
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
      const initialQuery = new URLSearchParams({ source: "all", limit: String(INITIAL_SAMPLE_LIMIT) });
      const [vehiclePayload, samplePayload] = await Promise.all([
        fetchJson(API.vehicles),
        fetchJson(`${API.samples}?${initialQuery.toString()}`)
      ]);
      const initialSamples = (Array.isArray(samplePayload.samples) ? samplePayload.samples : [])
        .filter((sample) => !sample?.skipped && samplePosition(sample));
      const preferred = renderVehicleOptions(vehiclePayload.vehicles, initialSamples);
      if (!preferred) throw new Error("暂无可用巡逻车辆");
      await selectVehicle(preferred);
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
  el.previewClose?.addEventListener("click", () => el.preview?.close());
  el.preview?.addEventListener("click", (event) => {
    if (event.target === el.preview) el.preview.close();
  });

  void initialize();
}
