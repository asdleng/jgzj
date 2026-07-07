(function () {
  const root = document.getElementById("lidar-relocalization-console");
  if (!root) return;

  const VEHICLES_URL = "/api/lidar-relocalization/vehicles";
  const statusNode = document.getElementById("lidar-reloc-status");
  const vehicleSelect = document.getElementById("lidar-reloc-vehicle");
  const refreshBtn = document.getElementById("lidar-reloc-refresh");
  const captureBtn = document.getElementById("lidar-reloc-capture");
  const inferBtn = document.getElementById("lidar-reloc-infer");
  const mapNode = document.getElementById("lidar-reloc-map");
  const localizationNode = document.getElementById("lidar-reloc-localization");
  const pipelineNode = document.getElementById("lidar-reloc-pipeline");
  const resultState = document.getElementById("lidar-reloc-result-state");
  const resultNode = document.getElementById("lidar-reloc-result");
  const rawJsonNode = document.getElementById("lidar-reloc-json");
  const visualState = document.getElementById("lidar-reloc-visual-state");
  const bevCanvas = document.getElementById("lidar-reloc-bev");
  const legendNode = document.getElementById("lidar-reloc-legend");

  let vehicles = [];
  let currentVehicleId = "";
  let currentStatus = null;
  let busy = false;

  function setStatus(text, state = "idle") {
    if (!statusNode) return;
    statusNode.textContent = text;
    statusNode.dataset.state = state;
  }

  function setResultState(text, state = "idle") {
    if (!resultState) return;
    resultState.textContent = text;
    resultState.dataset.state = state;
  }

  function setVisualState(text, state = "idle") {
    if (!visualState) return;
    visualState.textContent = text;
    visualState.dataset.state = state;
  }

  function setBusy(nextBusy) {
    busy = Boolean(nextBusy);
    if (refreshBtn) refreshBtn.disabled = busy;
    updateButtons();
  }

  function updateButtons() {
    const hasVehicle = Boolean(currentVehicleId);
    const captureTools = currentStatus?.tools?.capture_tools || [];
    const inferReady = Boolean(currentStatus?.tools?.inference);
    if (captureBtn) {
      captureBtn.disabled = busy || !hasVehicle || !captureTools.length;
      captureBtn.textContent = captureTools.some((name) => String(name).startsWith("lidar."))
        ? "抓取当前帧"
        : "抓取上下文";
    }
    if (inferBtn) {
      inferBtn.disabled = busy || !hasVehicle;
      inferBtn.dataset.ready = inferReady ? "yes" : "no";
    }
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {})
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.ok === false) {
      const error = new Error(data?.detail || data?.error || `HTTP ${response.status}`);
      error.payload = data;
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function createNode(tagName, className, text) {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function formatNumber(value, digits = 2) {
    const num = Number(value);
    if (!Number.isFinite(num)) return "-";
    return num.toFixed(digits);
  }

  function formatInteger(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return "-";
    return new Intl.NumberFormat("zh-CN").format(Math.round(num));
  }

  function formatTime(value) {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString("zh-CN", {
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZone: "Asia/Shanghai"
    });
  }

  function formatPose(pose) {
    if (!pose) return "-";
    return [
      `x ${formatNumber(pose.x)}`,
      `y ${formatNumber(pose.y)}`,
      `z ${formatNumber(pose.z)}`,
      `yaw ${formatNumber(pose.yaw ?? pose.heading, 3)}`
    ].join(" / ");
  }

  function formatMs(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return "-";
    return `${Math.round(num)} ms`;
  }

  function addMeta(container, label, value, tone = "idle") {
    const item = createNode("article", `lidar-reloc-meta-item is-${tone}`);
    item.appendChild(createNode("p", "lidar-reloc-meta-label", label));
    item.appendChild(createNode("p", "lidar-reloc-meta-value", value ?? "-"));
    container.appendChild(item);
  }

  function renderLegend(items) {
    if (!legendNode) return;
    legendNode.innerHTML = "";
    items.forEach((item) => {
      const row = createNode("span", "lidar-reloc-legend-item");
      const swatch = createNode("i", "");
      swatch.style.background = item.color;
      row.appendChild(swatch);
      row.appendChild(createNode("span", "", item.label));
      legendNode.appendChild(row);
    });
  }

  function clearVisualization(text = "等待推理结果") {
    if (!bevCanvas) return;
    const ctx = bevCanvas.getContext("2d");
    if (!ctx) return;
    const width = bevCanvas.width;
    const height = bevCanvas.height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#020617";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "rgba(71, 85, 105, 0.55)";
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, width - 1, height - 1);
    ctx.fillStyle = "#94a3b8";
    ctx.font = "14px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, width / 2, height / 2);
    renderLegend([
      { color: "#64748b", label: "局部地图占用" },
      { color: "#38bdf8", label: "当前帧投影" },
      { color: "#34d399", label: "粗位姿" },
      { color: "#f59e0b", label: "NDT 当前位姿" }
    ]);
  }

  function drawPointSet(ctx, points, project, color, radius = 1.6, alpha = 1) {
    if (!Array.isArray(points) || !points.length) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    points.forEach((point) => {
      if (!Array.isArray(point) || point.length < 2) return;
      const p = project(point[0], point[1]);
      ctx.fillRect(p.x - radius / 2, p.y - radius / 2, radius, radius);
    });
    ctx.restore();
  }

  function drawPose(ctx, pose, project, color, label) {
    if (!pose || !Number.isFinite(Number(pose.x)) || !Number.isFinite(Number(pose.y))) return;
    const yaw = Number(pose.yaw ?? pose.heading ?? 0);
    const p = project(Number(pose.x), Number(pose.y));
    const size = 12;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(-yaw);
    ctx.fillStyle = color;
    ctx.strokeStyle = "rgba(2, 6, 23, 0.9)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(size, 0);
    ctx.lineTo(-size * 0.6, -size * 0.55);
    ctx.lineTo(-size * 0.35, 0);
    ctx.lineTo(-size * 0.6, size * 0.55);
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = color;
    ctx.font = "12px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(label, p.x + 8, p.y - 8);
  }

  function renderVisualization(data) {
    if (!bevCanvas) return;
    const viz = data?.result?.visualization || data?.visualization || null;
    const ctx = bevCanvas.getContext("2d");
    if (!ctx) return;
    if (!viz?.bounds) {
      clearVisualization("本次结果没有可视化数据");
      setVisualState("无可视化数据", "warn");
      return;
    }

    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const cssWidth = bevCanvas.clientWidth || 960;
    const cssHeight = Math.max(360, Math.round(cssWidth * 0.58));
    const width = Math.round(cssWidth * dpr);
    const height = Math.round(cssHeight * dpr);
    if (bevCanvas.width !== width || bevCanvas.height !== height) {
      bevCanvas.width = width;
      bevCanvas.height = height;
    }

    const margin = 34 * dpr;
    const bounds = viz.bounds;
    const minX = Number(bounds.min_x);
    const maxX = Number(bounds.max_x);
    const minY = Number(bounds.min_y);
    const maxY = Number(bounds.max_y);
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const scale = Math.min((width - margin * 2) / spanX, (height - margin * 2) / spanY);
    const offsetX = (width - spanX * scale) / 2;
    const offsetY = (height - spanY * scale) / 2;
    const project = (x, y) => ({
      x: offsetX + (Number(x) - minX) * scale,
      y: height - (offsetY + (Number(y) - minY) * scale)
    });

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#020617";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "rgba(71, 85, 105, 0.55)";
    ctx.lineWidth = dpr;
    ctx.strokeRect(0.5 * dpr, 0.5 * dpr, width - dpr, height - dpr);

    ctx.strokeStyle = "rgba(30, 41, 59, 0.9)";
    ctx.lineWidth = dpr;
    const gridStep = 10;
    for (let x = Math.ceil(minX / gridStep) * gridStep; x <= maxX; x += gridStep) {
      const a = project(x, minY);
      const b = project(x, maxY);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    for (let y = Math.ceil(minY / gridStep) * gridStep; y <= maxY; y += gridStep) {
      const a = project(minX, y);
      const b = project(maxX, y);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    drawPointSet(ctx, viz.map_points, project, "#64748b", 1.4 * dpr, 0.72);
    drawPointSet(ctx, viz.query_points_prior, project, "#f59e0b", 1.7 * dpr, 0.35);
    drawPointSet(ctx, viz.query_points_coarse, project, "#38bdf8", 2 * dpr, 0.86);

    const poses = viz.poses || {};
    const candidates = Array.isArray(poses.candidates) ? poses.candidates.slice(1, 6) : [];
    candidates.forEach((pose) => drawPose(ctx, pose, project, "#a78bfa", ""));
    drawPose(ctx, poses.prior || data?.capture?.pose, project, "#f59e0b", "NDT");
    drawPose(ctx, poses.coarse || data?.coarse_pose, project, "#34d399", "COARSE");

    ctx.fillStyle = "#cbd5e1";
    ctx.font = `${12 * dpr}px system-ui, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(
      `map ${formatInteger(viz.map_points?.length)} / query ${formatInteger(viz.query_points_coarse?.length)} / window ${(spanX).toFixed(1)}m x ${(spanY).toFixed(1)}m`,
      12 * dpr,
      12 * dpr
    );

    renderLegend([
      { color: "#64748b", label: "局部地图占用" },
      { color: "#38bdf8", label: "当前帧按粗位姿投影" },
      { color: "#f59e0b", label: "NDT 当前位姿/投影" },
      { color: "#34d399", label: "粗位姿" },
      { color: "#a78bfa", label: "候选位姿" }
    ]);
    setVisualState("BEV 已更新", "ok");
  }

  function renderEmpty(container, text) {
    if (!container) return;
    container.innerHTML = "";
    container.appendChild(createNode("p", "lidar-reloc-empty", text));
  }

  function renderMap(status) {
    if (!mapNode) return;
    mapNode.innerHTML = "";
    const map = status?.map || {};
    const local = map.local || {};
    addMeta(mapNode, "地图状态", map.available ? "已加载" : "未确认", map.available ? "ok" : "warn");
    addMeta(mapNode, "地图版本", map.map_version || "-");
    addMeta(mapNode, "点数量", formatInteger(map.point_count));
    addMeta(mapNode, "本地 PCD", local.available ? local.size_label || "已拉取" : "未拉取", local.available ? "ok" : "warn");
    const extent = map.extent || {};
    addMeta(
      mapNode,
      "XY 范围",
      extent.min_x !== undefined
        ? `${formatNumber(extent.min_x, 1)}..${formatNumber(extent.max_x, 1)} / ${formatNumber(extent.min_y, 1)}..${formatNumber(extent.max_y, 1)}`
        : "-"
    );
    addMeta(mapNode, "更新时间", formatTime(local.mtime));
  }

  function renderLocalization(status) {
    if (!localizationNode) return;
    localizationNode.innerHTML = "";
    const loc = status?.localization || {};
    addMeta(localizationNode, "定位健康", loc.health || (loc.available ? "ok" : "unknown"), loc.health === "ok" ? "ok" : "warn");
    addMeta(localizationNode, "可靠定位", loc.reliable === true ? "true" : loc.reliable === false ? "false" : "-", loc.reliable === true ? "ok" : "warn");
    addMeta(localizationNode, "当前位姿", formatPose(loc.pose));
    addMeta(localizationNode, "NDT 分数", formatNumber(loc.ndt_score, 3));
    addMeta(localizationNode, "速度", loc.speed_mps === null || loc.speed_mps === undefined ? "-" : `${formatNumber(loc.speed_mps, 2)} m/s`);
    addMeta(localizationNode, "采样时间", formatTime(loc.generated_at || loc.pose?.timestamp));
  }

  function renderPipeline(status) {
    if (!pipelineNode) return;
    pipelineNode.innerHTML = "";
    const tools = status?.tools || {};
    const model = status?.model || {};
    const capture = status?.capture?.last || null;
    const captureTools = Array.isArray(tools.capture_tools) ? tools.capture_tools : [];
    const inferTools = Array.isArray(tools.infer_tools) ? tools.infer_tools : [];
    const serverInference = Boolean(tools.server_inference || model.phase === "server_local_ready");
    const inferLabel = inferTools.length
      ? inferTools.join(" / ")
      : serverInference
        ? "服务器本地推理"
        : "未部署";
    addMeta(pipelineNode, "车端工具", tools.count ? `${tools.count} 个` : "-", tools.count ? "ok" : "warn");
    addMeta(pipelineNode, "当前帧抓取", captureTools.length ? captureTools.join(" / ") : "缺 LiDAR 抓取工具", captureTools.length ? "ok" : "warn");
    addMeta(pipelineNode, "推理工具", inferLabel, inferTools.length || serverInference ? "ok" : "warn");
    addMeta(pipelineNode, "模型阶段", model.phase || "not_deployed", model.service_ready ? "ok" : "warn");
    addMeta(pipelineNode, "最近抓取", capture ? `${capture.tool_name || "-"} · ${formatTime(capture.captured_at)}` : "-");
    addMeta(pipelineNode, "Bundle", capture?.bundle_id || "-");
  }

  function renderStatus(status) {
    currentStatus = status;
    renderMap(status);
    renderLocalization(status);
    renderPipeline(status);
    updateButtons();
    if (rawJsonNode) rawJsonNode.textContent = JSON.stringify(status, null, 2);
  }

  function renderVehicles() {
    if (!vehicleSelect) return;
    vehicleSelect.innerHTML = "";
    if (!vehicles.length) {
      vehicleSelect.appendChild(new Option("暂无在线车辆", ""));
      return;
    }
    vehicles.forEach((vehicle) => {
      const id = String(vehicle.vehicle_id || vehicle.plate_number || "").trim();
      if (!id) return;
      const option = new Option(`${id}${vehicle.tool_count ? ` · tools ${vehicle.tool_count}` : ""}`, id);
      vehicleSelect.appendChild(option);
    });
    if (!currentVehicleId || !vehicles.some((vehicle) => vehicle.vehicle_id === currentVehicleId)) {
      const preferred =
        vehicles.find((vehicle) => Number(vehicle.tool_count) > 0)?.vehicle_id ||
        vehicles[0]?.vehicle_id ||
        "";
      currentVehicleId = preferred;
    }
    vehicleSelect.value = currentVehicleId;
  }

  async function loadVehicles() {
    setStatus("加载车辆...", "loading");
    const data = await requestJson(VEHICLES_URL);
    vehicles = Array.isArray(data.vehicles) ? data.vehicles.filter((vehicle) => vehicle.vehicle_id) : [];
    renderVehicles();
    setStatus(vehicles.length ? `已加载 ${vehicles.length} 台车` : "暂无在线车辆", vehicles.length ? "ok" : "warn");
  }

  async function loadStatus() {
    if (!currentVehicleId) {
      renderEmpty(mapNode, "请选择车辆。");
      renderEmpty(localizationNode, "请选择车辆。");
      renderEmpty(pipelineNode, "请选择车辆。");
      return;
    }
    setBusy(true);
    setStatus(`加载 ${currentVehicleId} 状态...`, "loading");
    try {
      const data = await requestJson(`/api/lidar-relocalization/vehicles/${encodeURIComponent(currentVehicleId)}/status`);
      renderStatus(data);
      setStatus(`${currentVehicleId} 状态已更新`, "ok");
      setResultState("等待推理", "idle");
      setVisualState("等待推理", "idle");
      if (!resultNode?.childElementCount || resultNode?.querySelector(".lidar-reloc-empty")) {
        renderEmpty(resultNode, "已加载车辆状态，可以抓取当前帧或直接检查推理链路。");
      }
    } catch (error) {
      currentStatus = null;
      setStatus(error.message || "状态加载失败", "error");
      if (rawJsonNode) rawJsonNode.textContent = JSON.stringify(error.payload || { error: error.message }, null, 2);
    } finally {
      setBusy(false);
    }
  }

  function renderCaptureResult(data) {
    if (!resultNode) return;
    resultNode.innerHTML = "";
    const capture = data?.capture || {};
    const result = capture.result || {};
    addMeta(resultNode, "抓取阶段", data?.phase || "-");
    addMeta(resultNode, "工具", capture.tool_name || "-");
    addMeta(resultNode, "Bundle/Capture", result.bundle_id || result.capture_id || "-");
    addMeta(resultNode, "地图版本", result.map_version || data?.status?.map?.map_version || "-");
    addMeta(resultNode, "帧数量", result.capture_count ?? result.frame_count ?? "-");
    addMeta(resultNode, "抓取时间", formatTime(capture.captured_at));
  }

  async function captureCurrentFrame() {
    if (!currentVehicleId) return;
    setBusy(true);
    setStatus("抓取当前帧...", "loading");
    setResultState("抓取中", "loading");
    try {
      const data = await requestJson(`/api/lidar-relocalization/vehicles/${encodeURIComponent(currentVehicleId)}/capture`, {
        method: "POST",
        body: JSON.stringify({})
      });
      renderCaptureResult(data);
      if (rawJsonNode) rawJsonNode.textContent = JSON.stringify(data, null, 2);
      setStatus("抓取完成", "ok");
      setResultState(data.phase === "lidar_frame_captured" ? "LiDAR 当前帧已抓取" : "上下文已抓取", "ok");
      await loadStatus();
    } catch (error) {
      setStatus(error.message || "抓取失败", "error");
      setResultState("抓取失败", "error");
      if (resultNode) {
        resultNode.innerHTML = "";
        addMeta(resultNode, "错误", error.message || "抓取失败", "error");
        const missing = error.payload?.required_tools;
        if (Array.isArray(missing) && missing.length) addMeta(resultNode, "缺失工具", missing.join(" / "), "warn");
      }
      if (rawJsonNode) rawJsonNode.textContent = JSON.stringify(error.payload || { error: error.message }, null, 2);
    } finally {
      setBusy(false);
    }
  }

  function renderInferResult(data) {
    if (!resultNode) return;
    resultNode.innerHTML = "";
    addMeta(resultNode, "推理阶段", data?.phase || "-");
    addMeta(resultNode, "粗位姿", formatPose(data?.coarse_pose), data?.coarse_pose ? "ok" : "warn");
    if (data?.raw_coarse_pose) {
      addMeta(resultNode, "BEVPlace++ top1", formatPose(data.raw_coarse_pose), "idle");
    }
    addMeta(resultNode, "置信度", formatNumber(data?.confidence, 3));
    addMeta(resultNode, "工具", data?.tool_name || "-");
    const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
    addMeta(resultNode, "候选数量", candidates.length || "-");
    const selector = data?.ndt_selector || null;
    if (selector) {
      addMeta(resultNode, "NDT selector", selector.phase || "-", selector.phase === "failed" ? "warn" : "ok");
      addMeta(resultNode, "选中候选", selector.selected_rank ? `rank ${selector.selected_rank}` : "-", selector.rank1_changed ? "ok" : "idle");
      addMeta(resultNode, "NDT 候选", `${selector.usable_count ?? 0}/${selector.evaluated_count ?? 0}`, selector.usable_count ? "ok" : "warn");
      addMeta(resultNode, "NDT 耗时", formatMs(selector.elapsed_ms), selector.elapsed_ms > 8000 ? "warn" : "idle");
      const rows = Array.isArray(selector.rows) ? selector.rows : [];
      const selected = rows.find((row) => Number(row.rank) === Number(selector.selected_rank)) || rows[0] || null;
      if (selected) {
        addMeta(resultNode, "NDT fitness", formatNumber(selected.fitness_score, 3), selected.converged ? "ok" : "warn");
        addMeta(resultNode, "NDT 校正", selected.correction_xy_m === null || selected.correction_xy_m === undefined ? "-" : `${formatNumber(selected.correction_xy_m, 2)} m`);
      }
      if (selector.detail) addMeta(resultNode, "NDT 说明", selector.detail, "warn");
    }
    if (data?.detail) addMeta(resultNode, "状态", data.detail, data.ok ? "idle" : "warn");
  }

  async function inferPose() {
    if (!currentVehicleId) return;
    setBusy(true);
    setStatus("推测粗位姿...", "loading");
    setResultState("推理中", "loading");
    try {
      const data = await requestJson(`/api/lidar-relocalization/vehicles/${encodeURIComponent(currentVehicleId)}/infer`, {
        method: "POST",
        body: JSON.stringify({})
      });
      renderInferResult(data);
      renderVisualization(data);
      if (rawJsonNode) rawJsonNode.textContent = JSON.stringify(data, null, 2);
      setStatus(data.ok ? "粗位姿已返回" : "推理未完成", data.ok ? "ok" : "warn");
      setResultState(data.ok ? "粗位姿可用" : data.phase || "未就绪", data.ok ? "ok" : "warn");
    } catch (error) {
      const payload = error.payload || {};
      setStatus(error.message || "推理失败", error.status === 501 ? "error" : "error");
      setResultState(payload.phase || "推理失败", "error");
      if (resultNode) {
        resultNode.innerHTML = "";
        addMeta(resultNode, "推理状态", payload.phase || "failed", "warn");
        addMeta(resultNode, "说明", payload.detail || error.message || "推理失败", "warn");
        if (Array.isArray(payload.required_tools) && payload.required_tools.length) {
          addMeta(resultNode, "待接入工具", payload.required_tools.join(" / "), "warn");
        }
        if (payload.model?.checkpoint) {
          addMeta(resultNode, "训练权重", payload.model.checkpoint, "idle");
        }
      }
      if (rawJsonNode) rawJsonNode.textContent = JSON.stringify(payload || { error: error.message }, null, 2);
    } finally {
      setBusy(false);
    }
  }

  async function refreshAll() {
    await loadVehicles();
    await loadStatus();
  }

  vehicleSelect?.addEventListener("change", () => {
    currentVehicleId = vehicleSelect.value;
    loadStatus().catch((error) => setStatus(error.message || "状态加载失败", "error"));
  });
  refreshBtn?.addEventListener("click", () => {
    refreshAll().catch((error) => setStatus(error.message || "刷新失败", "error"));
  });
  captureBtn?.addEventListener("click", () => {
    captureCurrentFrame().catch((error) => setStatus(error.message || "抓取失败", "error"));
  });
  inferBtn?.addEventListener("click", () => {
    inferPose().catch((error) => setStatus(error.message || "推理失败", "error"));
  });

  renderEmpty(mapNode, "等待车辆状态。");
  renderEmpty(localizationNode, "等待定位状态。");
  renderEmpty(pipelineNode, "等待工具列表。");
  clearVisualization();
  refreshAll().catch((error) => {
    setStatus(error.message || "加载失败", "error");
    if (rawJsonNode) rawJsonNode.textContent = JSON.stringify(error.payload || { error: error.message }, null, 2);
  });
})();
