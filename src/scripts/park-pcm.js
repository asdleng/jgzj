(function () {
  const root = document.querySelector("[data-park-pcm]");
  if (!root) return;

  const AUTH_URL = "/api/auth/me";
  const CROWD_VEHICLES_URL = "/api/park-pcm/crowd/vehicles";
  const CROWD_SAMPLES_URL = "/api/park-pcm/crowd/samples";
  const CROWD_CAPTURE_URL = "/api/park-pcm/crowd/demo-capture";
  const CROWD_PATROLS_URL = "/api/park-pcm/crowd/patrols";
  const PATROL_MAX_VEHICLES = 24;
  const PATROL_REFRESH_MS = 90 * 1000;
  const HEAT_SEGMENT_STEP_M = 28;
  const HEAT_SEGMENT_MAX_DISTANCE_M = 750;
  const HEAT_SEGMENT_MAX_INTERPOLATED_POINTS = 640;

  const AMAP_KEY = root.getAttribute("data-amap-key") || "";
  const statusEl = root.querySelector("[data-park-pcm-status]");
  const authEl = root.querySelector("[data-park-pcm-auth]");
  const patrolRefreshBtn = root.querySelector("[data-park-pcm-patrol-refresh]");
  const patrolSummaryEl = root.querySelector("[data-park-pcm-patrol-summary]");
  const patrolListEl = root.querySelector("[data-park-pcm-patrol-list]");
  const mapEl = root.querySelector("[data-park-pcm-map]");
  const mapFallbackEl = root.querySelector("[data-park-pcm-map-fallback]");
  const heatLegendEl = root.querySelector("[data-park-pcm-heat-legend]");
  const mapStatusEl = root.querySelector("[data-park-pcm-map-status]");
  const vehicleSummaryEl = root.querySelector("[data-park-pcm-vehicle-summary]");
  const vehicleDetailEl = root.querySelector("[data-park-pcm-vehicle-detail]");
  const trackSamplesEl = root.querySelector("[data-park-pcm-track-samples]");
  const trackDetailEl = root.querySelector("[data-park-pcm-track-detail]");
  const crowdVehicleSelect = root.querySelector("[data-park-pcm-crowd-vehicle]");
  const crowdDistanceInput = root.querySelector("[data-park-pcm-crowd-distance]");
  const crowdQualityInput = root.querySelector("[data-park-pcm-crowd-quality]");
  const crowdWidthInput = root.querySelector("[data-park-pcm-crowd-width]");
  const crowdCaptureBtn = root.querySelector("[data-park-pcm-crowd-capture]");
  const crowdStatusEl = root.querySelector("[data-park-pcm-crowd-status]");
  const crowdLastEl = root.querySelector("[data-park-pcm-crowd-last]");
  const crowdSamplesEl = root.querySelector("[data-park-pcm-crowd-samples]");

  let authenticated = false;
  let busy = false;
  let patrolRefreshInFlight = false;
  let amapLoadPromise = null;
  let amapMap = null;
  let amapMarkers = [];
  let amapTrackLine = null;
  let amapHeatmap = null;
  let amapControlsReady = false;
  let selectedVehicleId = "";
  let selectedSampleId = "";
  let sampleLoadRequestId = 0;
  let latestCrowdSamples = [];

  function setStatus(text, state) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.dataset.state = state || "idle";
  }

  function setBusy(nextBusy) {
    busy = Boolean(nextBusy);
    if (crowdCaptureBtn) crowdCaptureBtn.disabled = busy || !authenticated;
    if (patrolRefreshBtn) patrolRefreshBtn.disabled = busy || !authenticated;
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, {
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(options && options.body ? { "Content-Type": "application/json" } : {})
      },
      ...options,
      body: options && options.body ? JSON.stringify(options.body) : undefined
    });
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch (_error) {
      payload = { detail: text };
    }
    if (!response.ok) {
      const error = new Error(payload.detail || payload.error || `http_${response.status}`);
      error.payload = payload;
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function hasVehicleReadPermission(data) {
    const user = data && data.user ? data.user : null;
    const permissions = new Set(data && Array.isArray(data.permissions) ? data.permissions : []);
    return Boolean(user && user.email_verified && (user.super_admin || permissions.has("vehicle:read")));
  }

  function formatTime(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return "-";
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(date);
  }

  function formatNumber(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) ? String(num) : fallback || "-";
  }

  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes)) return "-";
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
  }

  function formatCoord(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num.toFixed(6) : "-";
  }

  function samplePeopleCount(sample) {
    const direct = Number(sample && sample.analysis && sample.analysis.people_count);
    if (Number.isFinite(direct)) return direct;
    const frames = Array.isArray(sample && sample.frames) ? sample.frames : [];
    const counts = frames
      .map((frame) => Number(frame && frame.analysis && frame.analysis.people_count))
      .filter((value) => Number.isFinite(value));
    if (!counts.length) return null;
    return counts.reduce((sum, value) => sum + value, 0);
  }

  function samplePeopleText(sample) {
    const count = samplePeopleCount(sample);
    return count == null ? "人数待识别" : `${count} 人`;
  }

  function samplePosition(sample) {
    const position = sample && sample.position ? sample.position : {};
    const longitude = Number(position.gaode_longitude);
    const latitude = Number(position.gaode_latitude);
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
    return { longitude, latitude };
  }

  function patrolStateLabel(value) {
    return {
      patrol_active_moving: "巡逻移动",
      patrol_active_stopped: "巡逻暂停",
      patrol_task_stopped_or_waiting: "巡逻等待",
      patrol_task_long_stopped: "任务长停",
      patrol_task_loaded_unverified: "任务待确认",
      patrol_unverified_can_unavailable: "底盘未确认",
      patrol_completed_or_idle: "巡逻完成/空闲",
      charging_or_charging_area: "充电/充电区",
      safety_stop: "安全停",
      stale_vehicle: "心跳过期",
      not_patrol: "非巡逻",
      unknown: "未知"
    }[value] || value || "未知";
  }

  function clearElement(el) {
    if (!el) return;
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function textNode(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    el.textContent = text == null ? "" : String(text);
    return el;
  }

  function setCrowdStatus(text) {
    if (crowdStatusEl) crowdStatusEl.textContent = text;
  }

  function setMapStatus(text) {
    if (mapStatusEl) mapStatusEl.textContent = text;
  }

  function setMapFallback(text, hidden) {
    if (!mapFallbackEl) return;
    mapFallbackEl.textContent = text || "";
    mapFallbackEl.hidden = Boolean(hidden);
  }

  function clearMapOverlays() {
    if (!amapMap) return;
    if (amapHeatmap) {
      if (typeof amapHeatmap.setMap === "function") {
        amapHeatmap.setMap(null);
      } else if (typeof amapHeatmap.hide === "function") {
        amapHeatmap.hide();
      }
      amapHeatmap = null;
    }
    if (heatLegendEl) heatLegendEl.hidden = true;
    if (amapMarkers.length) {
      amapMap.remove(amapMarkers);
      amapMarkers = [];
    }
    if (amapTrackLine) {
      amapMap.remove(amapTrackLine);
      amapTrackLine = null;
    }
  }

  function setVehicleSummary(text) {
    if (vehicleSummaryEl) vehicleSummaryEl.textContent = text || "";
  }

  function detailCell(label, value) {
    const cell = document.createElement("div");
    cell.className = "park-pcm-detail-cell";
    cell.appendChild(textNode("span", "", label));
    cell.appendChild(textNode("strong", "", value == null || value === "" ? "-" : value));
    return cell;
  }

  function visibleCrowdSamples() {
    const rows = latestCrowdSamples.filter((sample) => samplePosition(sample));
    if (!selectedVehicleId) return [];
    return rows.filter((sample) => sample.vehicle_id === selectedVehicleId);
  }

  function ensureVehicleOption(vehicleId) {
    if (!crowdVehicleSelect || !vehicleId) return;
    const value = String(vehicleId);
    if ([...crowdVehicleSelect.options].some((option) => option.value === value)) return;
    const option = document.createElement("option");
    option.value = value;
    option.textContent = `${value} · 历史采集`;
    crowdVehicleSelect.appendChild(option);
  }

  function selectedCrowdSample() {
    const rows = visibleCrowdSamples();
    if (!rows.length) {
      selectedSampleId = "";
      return null;
    }
    if (!rows.some((sample) => sample.sample_id === selectedSampleId)) {
      selectedSampleId = rows[0].sample_id || "";
    }
    return rows.find((sample) => sample.sample_id === selectedSampleId) || rows[0];
  }

  function renderSampleFrameGrid(container, sample) {
    if (!container) return;
    const frames = Array.isArray(sample && sample.frames) ? sample.frames.slice(0, 4) : [];
    const grid = document.createElement("div");
    grid.className = "park-pcm-track-frames";
    if (!frames.length) {
      grid.appendChild(textNode("p", "park-pcm-empty", "该采集点没有图片。"));
      container.appendChild(grid);
      return;
    }
    frames.forEach((frame) => {
      const figure = document.createElement("figure");
      figure.className = "park-pcm-crowd-frame";
      const img = document.createElement("img");
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = `${sample.vehicle_id || ""} ${frame.camera_id || "camera"}`;
      img.src = frame.image_url || "";
      const caption = document.createElement("figcaption");
      caption.appendChild(textNode("span", "", frame.camera_id || "camera"));
      caption.appendChild(textNode("span", "", `${formatBytes(frame.image_size_bytes)} · ${frame.analysis && frame.analysis.people_count != null ? `${frame.analysis.people_count}人` : "待识别"}`));
      figure.appendChild(img);
      figure.appendChild(caption);
      grid.appendChild(figure);
    });
    container.appendChild(grid);
  }

  function renderSampleDetail(sample) {
    [trackDetailEl, crowdSamplesEl].forEach((container) => {
      if (!container) return;
      clearElement(container);
      if (!sample) {
        container.appendChild(textNode("p", "park-pcm-empty", "等待采集点四路图片。"));
        return;
      }
      const position = sample.position || {};
      const head = document.createElement("div");
      head.className = "park-pcm-track-head";
      head.appendChild(textNode("strong", "", `${sample.vehicle_id || "-"} · ${formatTime(sample.collected_at)} · ${samplePeopleText(sample)}`));
      head.appendChild(
        textNode(
          "span",
          "",
          [
            `采集点 ${formatCoord(position.gaode_longitude)}, ${formatCoord(position.gaode_latitude)}`,
            `${sample.frame_count || 0} 路`,
            formatBytes(sample.total_image_bytes),
            `巡逻 ${patrolStateLabel(sample.patrol_state && sample.patrol_state.state)}`
          ].join(" · ")
        )
      );
      container.appendChild(head);
      renderSampleFrameGrid(container, sample);
    });
  }

  function renderTrackSamples() {
    if (!trackSamplesEl) return;
    clearElement(trackSamplesEl);
    const rows = visibleCrowdSamples();
    const active = selectedCrowdSample();
    if (!rows.length) {
      trackSamplesEl.appendChild(textNode("p", "park-pcm-empty", selectedVehicleId ? `${selectedVehicleId} 暂无采集点。` : "请先选择一台车辆。"));
      renderSampleDetail(null);
      return;
    }
    rows.slice(0, 32).forEach((sample) => {
      const position = sample.position || {};
      const button = document.createElement("button");
      button.type = "button";
      button.className = "park-pcm-track-point";
      button.dataset.active = active && active.sample_id === sample.sample_id ? "true" : "false";
      button.appendChild(textNode("strong", "", `${sample.vehicle_id || "-"} · ${formatTime(sample.collected_at)} · ${samplePeopleText(sample)}`));
      button.appendChild(textNode("span", "", `${formatCoord(position.gaode_longitude)}, ${formatCoord(position.gaode_latitude)} · ${sample.frame_count || 0} 路 · ${formatBytes(sample.total_image_bytes)}`));
      button.addEventListener("click", () => {
        selectedSampleId = sample.sample_id || "";
        renderTrackSamples();
        renderSampleDetail(sample);
        void renderTrackMap({ focus_sample_id: selectedSampleId }).catch((error) => {
          setMapStatus(`轨迹刷新失败：${error.message || "-"}`);
        });
      });
      trackSamplesEl.appendChild(button);
    });
    renderSampleDetail(active);
  }

  function renderHistoryDetail() {
    if (!vehicleDetailEl) return;
    clearElement(vehicleDetailEl);
    const rows = visibleCrowdSamples();
    if (!rows.length) {
      vehicleDetailEl.appendChild(
        textNode(
          "p",
          "park-pcm-empty",
          selectedVehicleId ? `${selectedVehicleId} 还没有服务器落盘采集点。` : "请先选择一台车辆查看服务器落盘历史。"
        )
      );
      return;
    }
    const frames = rows.reduce((sum, sample) => sum + (Number(sample.frame_count) || 0), 0);
    const bytes = rows.reduce((sum, sample) => sum + (Number(sample.total_image_bytes) || 0), 0);
    const counts = rows
      .map((sample) => samplePeopleCount(sample))
      .filter((count) => Number.isFinite(Number(count)));
    const totalPeople = counts.reduce((sum, count) => sum + Number(count), 0);
    const positiveCounts = counts.filter((count) => Number(count) > 0);
    const maxPeople = positiveCounts.length ? Math.max(...positiveCounts.map((count) => Number(count))) : 0;
    const latest = rows[0];
    const oldest = rows[rows.length - 1];
    const position = latest.position || {};
    const grid = document.createElement("div");
    grid.className = "park-pcm-detail-grid";
    grid.appendChild(detailCell("落盘采集点", `${rows.length} 个`));
    grid.appendChild(detailCell("四路图片", `${frames} 张 · ${formatBytes(bytes)}`));
    grid.appendChild(detailCell("已识别人数", counts.length ? `${totalPeople} 人 · ${counts.length}/${rows.length} 点` : "等待识别"));
    grid.appendChild(detailCell("热力点", positiveCounts.length ? `${positiveCounts.length} 个 · 峰值 ${maxPeople} 人` : "暂无人群热区"));
    grid.appendChild(detailCell("最近采集", `${latest.vehicle_id || "-"} · ${formatTime(latest.collected_at)}`));
    grid.appendChild(detailCell("采集区间", `${formatTime(oldest.collected_at)} - ${formatTime(latest.collected_at)}`));
    grid.appendChild(detailCell("最近坐标", `${formatCoord(position.gaode_longitude)}, ${formatCoord(position.gaode_latitude)}`));
    vehicleDetailEl.appendChild(grid);
    vehicleDetailEl.appendChild(
      textNode(
        "p",
        "park-pcm-detail-note",
        "当前地图和四路图片只来自该车已经上传并落盘到服务器的历史采集点。"
      )
    );
  }

  function renderPatrolSummary(counts) {
    if (!patrolSummaryEl) return;
    const data = counts || {};
    clearElement(patrolSummaryEl);
    [
      `扫描 ${formatNumber(data.scanned, "0")}`,
      `巡逻 ${formatNumber(data.patrol, "0")}`,
      `有定位 ${formatNumber(data.with_position, "0")}`
    ].forEach((text) => patrolSummaryEl.appendChild(textNode("span", "", text)));
  }

  function renderPatrolRows(patrols) {
    if (!patrolListEl) return;
    clearElement(patrolListEl);
    const rows = Array.isArray(patrols) ? patrols : [];
    if (!rows.length) {
      patrolListEl.appendChild(textNode("p", "park-pcm-empty", "当前没有确认巡逻车辆。"));
      return;
    }
    rows.forEach((row) => {
      const item = document.createElement("article");
      item.className = "park-pcm-patrol-row";
      item.dataset.vehicleId = row.vehicle_id || "";
      item.tabIndex = 0;
      item.setAttribute("role", "button");
      const patrol = row.patrol_state || {};
      const fields = patrol.fields || {};
      const position = row.position || {};
      const data = row.crowd_data || {};
      const latest = data.latest_sample || null;
      item.appendChild(textNode("strong", "", `${row.vehicle_id || "-"} · ${patrolStateLabel(patrol.state)}`));
      item.appendChild(
        textNode(
          "span",
          "",
          [
            `速度 ${formatNumber(fields.speed_kph)} km/h`,
            `路线 ${formatNumber(fields.current_loop_index)}/${formatNumber(fields.total_loop_sum)} · ${formatNumber(fields.current_refline_index)}/${formatNumber(fields.total_refline_sum)}`,
            `24h ${formatNumber(data.sample_count_24h, "0")} 次 ${formatNumber(data.frame_count_24h, "0")} 张`
          ].join(" · ")
        )
      );
      item.appendChild(
        textNode(
          "span",
          "",
          [
            `高德 ${formatCoord(position.gaode_longitude)}, ${formatCoord(position.gaode_latitude)}`,
            latest ? `最近 ${formatTime(latest.collected_at)} ${formatBytes(latest.total_image_bytes)}` : "暂无采样"
          ].join(" · ")
        )
      );
      item.addEventListener("click", () => {
        void selectVehicle(row.vehicle_id).catch((error) => {
          setMapStatus(`历史采集点加载失败：${error.message || "-"}`);
        });
      });
      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          item.click();
        }
      });
      patrolListEl.appendChild(item);
    });
  }

  async function selectVehicle(vehicleId) {
    const nextVehicleId = String(vehicleId || "").trim();
    selectedVehicleId = nextVehicleId;
    selectedSampleId = "";
    if (crowdVehicleSelect && crowdVehicleSelect.value !== nextVehicleId) {
      crowdVehicleSelect.value = nextVehicleId;
    }
    if (!nextVehicleId) {
      setVehicleSummary("请先选择一台车辆查看历史采集点。");
      return loadCrowdSamples("");
    }
    setVehicleSummary(`${nextVehicleId} 历史采集点加载中。`);
    return loadCrowdSamples(nextVehicleId);
  }

  function loadAmap() {
    if (!AMAP_KEY) return Promise.reject(new Error("amap_key_missing"));
    const existingAmap = window["AMap"];
    if (existingAmap && existingAmap.Map) return Promise.resolve(existingAmap);
    if (amapLoadPromise) return amapLoadPromise;
    amapLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(AMAP_KEY)}`;
      script.async = true;
      script.onload = () => {
        const loadedAmap = window["AMap"];
        if (loadedAmap && loadedAmap.Map) resolve(loadedAmap);
        else reject(new Error("amap_load_failed"));
      };
      script.onerror = () => reject(new Error("amap_load_failed"));
      document.head.appendChild(script);
    });
    return amapLoadPromise;
  }

  function loadAmapPlugins(AMap, pluginNames) {
    if (!AMap || typeof AMap.plugin !== "function") return Promise.resolve();
    return new Promise((resolve) => {
      AMap.plugin(pluginNames, () => resolve());
    });
  }

  async function ensureAmapControls(AMap) {
    if (!amapMap || amapControlsReady) return;
    await loadAmapPlugins(AMap, ["AMap.ToolBar", "AMap.Scale", "AMap.ControlBar"]);
    if (AMap.ToolBar) amapMap.addControl(new AMap.ToolBar({ position: "RB" }));
    if (AMap.Scale) amapMap.addControl(new AMap.Scale());
    if (AMap.ControlBar) amapMap.addControl(new AMap.ControlBar({ position: { right: "12px", top: "12px" } }));
    amapControlsReady = true;
  }

  function enableMapInteraction() {
    if (!amapMap || typeof amapMap.setStatus !== "function") return;
    amapMap.setStatus({
      dragEnable: true,
      zoomEnable: true,
      doubleClickZoom: true,
      keyboardEnable: true,
      scrollWheel: true,
      touchZoom: true
    });
  }

  function sampleMapPoint(sample) {
    const position = samplePosition(sample);
    if (!position) return null;
    const peopleCount = samplePeopleCount(sample);
    return {
      sample_id: sample.sample_id || "",
      vehicle_id: sample.vehicle_id || "",
      longitude: position.longitude,
      latitude: position.latitude,
      people_count: peopleCount,
      heat_count: peopleCount == null ? null : Math.max(0, peopleCount),
      collected_at: sample.collected_at,
      sample
    };
  }

  function heatWeight(point) {
    const count = Number(point && point.heat_count);
    return Number.isFinite(count) && count > 0 ? count : null;
  }

  function distanceMeters(left, right) {
    const leftLng = Number(left && left.longitude);
    const leftLat = Number(left && left.latitude);
    const rightLng = Number(right && right.longitude);
    const rightLat = Number(right && right.latitude);
    if (![leftLng, leftLat, rightLng, rightLat].every(Number.isFinite)) return null;
    const toRad = (value) => (value * Math.PI) / 180;
    const earthRadiusM = 6371000;
    const dLat = toRad(rightLat - leftLat);
    const dLng = toRad(rightLng - leftLng);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(leftLat)) * Math.cos(toRad(rightLat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * earthRadiusM * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function heatDataFromPoints(points) {
    const directPoints = points
      .map((point) => ({
        lng: Number(point.longitude),
        lat: Number(point.latitude),
        count: heatWeight(point)
      }))
      .filter((point) => Number.isFinite(point.lng) && Number.isFinite(point.lat) && Number.isFinite(point.count) && point.count > 0);
    const interpolatedPoints = [];
    for (let index = 1; index < points.length; index += 1) {
      if (interpolatedPoints.length >= HEAT_SEGMENT_MAX_INTERPOLATED_POINTS) break;
      const start = points[index - 1];
      const end = points[index];
      const distanceM = distanceMeters(start, end);
      if (!Number.isFinite(distanceM) || distanceM < HEAT_SEGMENT_STEP_M || distanceM > HEAT_SEGMENT_MAX_DISTANCE_M) {
        continue;
      }
      const startWeight = heatWeight(start);
      const endWeight = heatWeight(end);
      if (startWeight == null && endWeight == null) continue;
      const safeStartWeight = startWeight == null ? endWeight : startWeight;
      const safeEndWeight = endWeight == null ? startWeight : endWeight;
      const steps = Math.max(2, Math.min(32, Math.ceil(distanceM / HEAT_SEGMENT_STEP_M)));
      for (let step = 1; step < steps; step += 1) {
        if (interpolatedPoints.length >= HEAT_SEGMENT_MAX_INTERPOLATED_POINTS) break;
        const ratio = step / steps;
        const count = safeStartWeight + (safeEndWeight - safeStartWeight) * ratio;
        if (!Number.isFinite(count) || count <= 0) continue;
        interpolatedPoints.push({
          lng: Number(start.longitude) + (Number(end.longitude) - Number(start.longitude)) * ratio,
          lat: Number(start.latitude) + (Number(end.latitude) - Number(start.latitude)) * ratio,
          count
        });
      }
    }
    return [...directPoints, ...interpolatedPoints];
  }

  async function renderPeopleHeatmap(AMap, samplePoints) {
    const heatData = heatDataFromPoints(samplePoints);
    if (!heatData.length) {
      if (heatLegendEl) heatLegendEl.hidden = true;
      return {
        count: 0,
        max: 0
      };
    }
    try {
      await loadAmapPlugins(AMap, ["AMap.HeatMap"]);
      if (!AMap.HeatMap) {
        if (heatLegendEl) heatLegendEl.hidden = true;
        return {
          count: 0,
          max: 0,
          unavailable: true
        };
      }
      const maxCount = Math.max(...heatData.map((point) => point.count), 1);
      amapHeatmap = new AMap.HeatMap(amapMap, {
        radius: 76,
        opacity: [0, 0.86],
        zIndex: 70,
        gradient: {
          0.16: "#22c55e",
          0.38: "#a3e635",
          0.58: "#facc15",
          0.78: "#fb923c",
          1: "#ef4444"
        }
      });
      amapHeatmap.setDataSet({
        data: heatData,
        max: maxCount
      });
      if (heatLegendEl) heatLegendEl.hidden = false;
      return {
        count: heatData.length,
        max: maxCount
      };
    } catch (_error) {
      if (heatLegendEl) heatLegendEl.hidden = true;
      return {
        count: 0,
        max: 0,
        unavailable: true
      };
    }
  }

  async function renderTrackMap(options) {
    const opts = options || {};
    const samples = visibleCrowdSamples();
    const samplePoints = samples
      .map((sample) => sampleMapPoint(sample))
      .filter(Boolean)
      .sort((left, right) => Date.parse(left.collected_at || "") - Date.parse(right.collected_at || ""));
    if (!selectedVehicleId) {
      renderTrackSamples();
      clearMapOverlays();
      setMapStatus("请选择车辆");
      setMapFallback("请选择一台车辆查看该车历史轨迹和四路采集图片", false);
      return;
    }
    if (!samplePoints.length) {
      renderTrackSamples();
      clearMapOverlays();
      setMapStatus("暂无历史采集点");
      setMapFallback(selectedVehicleId ? `${selectedVehicleId} 暂无服务器落盘采集点` : "暂无服务器落盘采集点", false);
      return;
    }
    try {
      const AMap = await loadAmap();
      setMapFallback("", true);
      const focus = samplePoints.find((point) => point.sample_id === opts.focus_sample_id) || samplePoints[samplePoints.length - 1];
      const center = [Number(focus.longitude), Number(focus.latitude)];
      if (!amapMap) {
        amapMap = new AMap.Map(mapEl, {
          zoom: 17,
          center,
          viewMode: "2D",
          resizeEnable: true,
          zoomEnable: true,
          dragEnable: true,
          doubleClickZoom: true,
          keyboardEnable: true,
          scrollWheel: true
        });
      }
      await ensureAmapControls(AMap);
      enableMapInteraction();
      clearMapOverlays();
      const heatStats = await renderPeopleHeatmap(AMap, samplePoints);
      if (samplePoints.length >= 2) {
        amapTrackLine = new AMap.Polyline({
          path: samplePoints.map((point) => [point.longitude, point.latitude]),
          strokeColor: "#f59e0b",
          strokeWeight: 4,
          strokeOpacity: 0.78,
          lineJoin: "round",
          zIndex: 80,
          bubble: true
        });
        amapMap.add(amapTrackLine);
      }
      amapMarkers = [];
      const fitTargets = amapTrackLine ? [amapTrackLine] : [];
      if (fitTargets.length) {
        amapMap.setFitView(fitTargets, false, [46, 46, 46, 46], 18);
      } else {
        amapMap.setZoomAndCenter(17, center);
      }
      enableMapInteraction();
      setMapStatus(
        heatStats.count
          ? `${selectedVehicleId} 采集点 ${samplePoints.length} · 热力栅格 ${heatStats.count} · 峰值 ${heatStats.max} 人`
          : `${selectedVehicleId} 采集点 ${samplePoints.length} · 暂无可用人数热力`
      );
    } catch (error) {
      setMapStatus("轨迹地图加载失败");
      setMapFallback(`轨迹地图加载失败：${error.message || "amap_failed"}`, false);
    }
  }

  async function loadCrowdPatrols() {
    if (patrolRefreshInFlight) return null;
    patrolRefreshInFlight = true;
    try {
      const data = await fetchJson(`${CROWD_PATROLS_URL}?max_vehicles=${PATROL_MAX_VEHICLES}`);
      renderPatrolSummary(data.counts);
      renderPatrolRows(data.patrols || []);
      if (!selectedVehicleId) {
        clearMapOverlays();
        setMapStatus("请选择车辆");
        setMapFallback("选择一台车辆后显示该车历史采集轨迹", false);
      }
      return data;
    } finally {
      patrolRefreshInFlight = false;
    }
  }

  function renderCrowdVehicles(data) {
    if (!crowdVehicleSelect) return "";
    clearElement(crowdVehicleSelect);
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "选择车辆";
    placeholder.disabled = true;
    crowdVehicleSelect.appendChild(placeholder);
    const vehicles = Array.isArray(data && data.vehicles) ? data.vehicles : [];
    if (!vehicles.length) {
      if (selectedVehicleId) {
        ensureVehicleOption(selectedVehicleId);
        crowdVehicleSelect.value = selectedVehicleId;
      }
      renderHistoryDetail();
      setVehicleSummary(selectedVehicleId ? `${selectedVehicleId} · 使用服务器历史采集记录` : "暂无车辆列表。");
      return selectedVehicleId;
    }
    const previousVehicleId = selectedVehicleId || crowdVehicleSelect.value || "";
    let nextVehicleId = previousVehicleId;
    vehicles.slice(0, 80).forEach((vehicle) => {
      const option = document.createElement("option");
      option.value = vehicle.vehicle_id || "";
      const age = vehicle.last_seen_age_s == null ? "-" : `${vehicle.last_seen_age_s}s`;
      option.textContent = `${vehicle.vehicle_id}${vehicle.fresh ? "" : " 过期"} · ${age} · 电量 ${formatNumber(vehicle.telemetry && vehicle.telemetry.battery_soc)}%`;
      crowdVehicleSelect.appendChild(option);
    });
    if (nextVehicleId) {
      ensureVehicleOption(nextVehicleId);
    }
    crowdVehicleSelect.value = nextVehicleId;
    selectedVehicleId = nextVehicleId;
    return nextVehicleId;
  }

  function renderCrowdLast(sample) {
    clearElement(crowdLastEl);
    if (!crowdLastEl) return;
    if (!sample) {
      crowdLastEl.appendChild(textNode("p", "park-pcm-empty", "还没有采样记录。"));
      return;
    }
    if (sample.skipped) {
      const patrolState = sample.patrol_state || {};
      crowdLastEl.appendChild(textNode("strong", "", `${sample.vehicle_id || "-"} · 已跳过`));
      crowdLastEl.appendChild(
        textNode(
          "span",
          "",
          [
            `原因 ${sample.reason || "-"}`,
            `巡逻 ${patrolStateLabel(patrolState.state)}`,
            (patrolState.reasons || []).slice(0, 3).join(" · ")
          ].filter(Boolean).join(" · ")
        )
      );
      return;
    }
    const position = sample.position || {};
    const patrolState = sample.patrol_state || {};
    crowdLastEl.appendChild(textNode("strong", "", `${sample.vehicle_id || "-"} · ${formatTime(sample.collected_at)} · ${sample.frame_count || 0} 路 · ${samplePeopleText(sample)}`));
    crowdLastEl.appendChild(
      textNode(
        "span",
        "",
        [
          `图片 ${formatBytes(sample.total_image_bytes)}`,
          `耗时 ${formatNumber(sample.elapsed_ms, "0")} ms`,
          `巡逻 ${patrolStateLabel(patrolState.state)}`,
          `距上次 ${sample.distance_from_last_m == null ? "-" : `${sample.distance_from_last_m} m`}`,
          `高德 ${formatCoord(position.gaode_longitude)}, ${formatCoord(position.gaode_latitude)}`
        ].join(" · ")
      )
    );
  }

  function renderCrowdSamples(samples) {
    const list = Array.isArray(samples) ? samples.filter((item) => !item.skipped) : [];
    latestCrowdSamples = list;
    if (!selectedVehicleId && list.length) {
      const firstVehicleId = String(list.find((sample) => sample && sample.vehicle_id)?.vehicle_id || "").trim();
      if (firstVehicleId) {
        selectedVehicleId = firstVehicleId;
        ensureVehicleOption(firstVehicleId);
        if (crowdVehicleSelect) crowdVehicleSelect.value = firstVehicleId;
      }
    }
    const rows = visibleCrowdSamples();
    const rowsWithCount = rows.filter((sample) => samplePeopleCount(sample) != null);
    const totalPeople = rowsWithCount.reduce((sum, sample) => sum + Number(samplePeopleCount(sample) || 0), 0);
    setVehicleSummary(
      selectedVehicleId
        ? `${selectedVehicleId} · 历史采集点 ${rows.length} · 已识别 ${rowsWithCount.length} 点/${totalPeople} 人`
        : "请选择一台车辆查看历史采集点。"
    );
    if (!rows.length) {
      renderCrowdLast(null);
      renderHistoryDetail();
      renderTrackSamples();
      renderSampleDetail(null);
      void renderTrackMap().catch((error) => {
        setMapStatus(`轨迹刷新失败：${error.message || "-"}`);
      });
      return;
    }
    renderCrowdLast(rows[0]);
    renderHistoryDetail();
    renderTrackSamples();
    renderSampleDetail(selectedCrowdSample());
    void renderTrackMap().catch((error) => {
      setMapStatus(`轨迹刷新失败：${error.message || "-"}`);
    });
  }

  async function loadCrowdVehicles() {
    const data = await fetchJson(CROWD_VEHICLES_URL);
    renderCrowdVehicles(data);
    const defaults = data.defaults || {};
    if (crowdDistanceInput && defaults.distance_m) crowdDistanceInput.value = defaults.distance_m;
    if (crowdQualityInput && defaults.quality) crowdQualityInput.value = defaults.quality;
    if (crowdWidthInput && defaults.max_width) crowdWidthInput.value = defaults.max_width;
    setCrowdStatus(data.in_flight ? "采样进行中" : `车辆 ${Array.isArray(data.vehicles) ? data.vehicles.length : 0} 台`);
    return data;
  }

  async function loadCrowdSamples(vehicleId) {
    const normalizedVehicleId = String(vehicleId == null ? selectedVehicleId : vehicleId).trim();
    const requestId = sampleLoadRequestId + 1;
    sampleLoadRequestId = requestId;
    const query = new URLSearchParams({ limit: "300" });
    if (normalizedVehicleId) query.set("vehicle_id", normalizedVehicleId);
    const data = await fetchJson(`${CROWD_SAMPLES_URL}?${query.toString()}`);
    if (requestId !== sampleLoadRequestId) return data;
    renderCrowdSamples(data.samples || []);
    return data;
  }

  function crowdCapturePayload() {
    return {
      vehicle_id: crowdVehicleSelect ? crowdVehicleSelect.value : "",
      distance_m: Number(crowdDistanceInput && crowdDistanceInput.value) || 60,
      quality: Number(crowdQualityInput && crowdQualityInput.value) || 45,
      max_width: Number(crowdWidthInput && crowdWidthInput.value) || 480,
      camera_ids: ["camera1", "camera2", "camera3", "camera4"],
      force: true
    };
  }

  async function captureCrowdDemo() {
    if (!authenticated || busy) return;
    const payload = crowdCapturePayload();
    if (!payload.vehicle_id) {
      setCrowdStatus("请选择车辆");
      return;
    }
    setBusy(true);
    setCrowdStatus("确认巡逻状态");
    try {
      const sample = await fetchJson(CROWD_CAPTURE_URL, {
        method: "POST",
        body: payload
      });
      renderCrowdLast(sample);
      await Promise.all([loadCrowdPatrols(), loadCrowdVehicles(), loadCrowdSamples(selectedVehicleId)]);
      setCrowdStatus(sample.skipped ? `跳过：${sample.reason || "-"}` : `完成 ${sample.frame_count || 0} 路 · ${formatBytes(sample.total_image_bytes)}`);
    } catch (error) {
      setCrowdStatus(`失败：${error.message || "capture_failed"}`);
      if (authEl) {
        authEl.hidden = false;
        authEl.textContent = error.message || "人流采样失败。";
      }
    } finally {
      setBusy(false);
    }
  }

  async function init() {
    setBusy(true);
    try {
      const auth = await fetchJson(AUTH_URL);
      authenticated = hasVehicleReadPermission(auth);
      root.dataset.authenticated = authenticated ? "true" : "false";
      if (!authenticated) {
        setStatus("需授权", "error");
        if (authEl) {
          authEl.hidden = false;
          authEl.textContent = auth.authenticated
            ? "当前账号没有 vehicle:read 权限或邮箱未验证。"
            : "请先登录。";
        }
        return;
      }
      if (authEl) authEl.hidden = true;
      setStatus("加载中", "warn");
      await Promise.all([
        loadCrowdPatrols().catch((error) => {
          setMapStatus(`巡逻加载失败：${error.message || "-"}`);
        }),
        loadCrowdVehicles().catch((error) => {
          setCrowdStatus(`车辆加载失败：${error.message || "-"}`);
        }),
        loadCrowdSamples().catch((error) => {
          setCrowdStatus(`采样加载失败：${error.message || "-"}`);
        })
      ]);
      setStatus("已就绪", "ok");
    } catch (error) {
      setStatus("不可用", "error");
      if (authEl) {
        authEl.hidden = false;
        authEl.textContent = error.message || "人流采集服务不可用。";
      }
    } finally {
      setBusy(false);
    }
  }

  if (crowdVehicleSelect) {
    crowdVehicleSelect.addEventListener("change", () => {
      void selectVehicle(crowdVehicleSelect.value).catch((error) => {
        setVehicleSummary(`历史采集点加载失败：${error.message || "-"}`);
        setMapStatus("历史采集点加载失败");
      });
    });
  }
  if (crowdCaptureBtn) crowdCaptureBtn.addEventListener("click", captureCrowdDemo);
  if (patrolRefreshBtn) {
    patrolRefreshBtn.addEventListener("click", async () => {
      if (!authenticated || busy) return;
      setBusy(true);
      setMapStatus("刷新中");
      try {
        await loadCrowdPatrols();
        await loadCrowdSamples(selectedVehicleId);
        setStatus("已更新", "ok");
      } catch (error) {
        setMapStatus(`刷新失败：${error.message || "-"}`);
      } finally {
        setBusy(false);
      }
    });
  }
  window.setInterval(() => {
    if (!authenticated || busy) return;
    void loadCrowdPatrols()
      .then(() => loadCrowdSamples(selectedVehicleId))
      .catch((error) => {
        setMapStatus(`巡逻刷新失败：${error.message || "-"}`);
      });
  }, PATROL_REFRESH_MS);
  void init();
})();
