const root = document.querySelector("[data-e2e-replay]");

if (root) {
  const el = {
    refresh: root.querySelector("[data-replay-refresh]"),
    count: root.querySelector("[data-replay-count]"),
    vehicles: root.querySelector("[data-replay-vehicles]"),
    duration: root.querySelector("[data-replay-duration]"),
    size: root.querySelector("[data-replay-size]"),
    vehicle: root.querySelector("[data-replay-vehicle]"),
    search: root.querySelector("[data-replay-search]"),
    status: root.querySelector("[data-replay-status]"),
    list: root.querySelector("[data-replay-list]"),
    kicker: root.querySelector("[data-replay-kicker]"),
    title: root.querySelector("[data-replay-title]"),
    meta: root.querySelector("[data-replay-meta]"),
    download: root.querySelector("[data-replay-download]"),
    empty: root.querySelector("[data-replay-empty]"),
    lidar: root.querySelector("[data-replay-lidar]"),
    planning: root.querySelector("[data-replay-planning]"),
    clock: root.querySelector("[data-replay-clock]"),
    frame: root.querySelector("[data-replay-frame]"),
    position: root.querySelector("[data-replay-position]"),
    latlon: root.querySelector("[data-replay-latlon]"),
    motion: root.querySelector("[data-replay-motion]"),
    gear: root.querySelector("[data-replay-gear]"),
    planningState: root.querySelector("[data-replay-planning-state]"),
    estop: root.querySelector("[data-replay-estop]"),
    points: root.querySelector("[data-replay-points]"),
    play: root.querySelector("[data-replay-play]"),
    timeline: root.querySelector("[data-replay-timeline]"),
    speed: root.querySelector("[data-replay-speed]")
  };

  const state = {
    clips: [],
    selected: null,
    preview: null,
    frameIndex: 0,
    currentTime: 0,
    playing: false,
    playbackStartedAt: 0,
    playbackStartedTime: 0,
    animationFrame: 0,
    previewRequest: null
  };

  const number = (value, fallback = null) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const formatBytes = (value) => {
    const bytes = number(value);
    if (bytes === null) return "--";
    if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(2)} T`;
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} G`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} M`;
    return `${Math.round(bytes / 1024)} K`;
  };

  const formatDuration = (value, compact = false) => {
    const total = Math.max(0, number(value, 0));
    if (compact && total < 60) return `${total.toFixed(total < 10 ? 1 : 0)}s`;
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = Math.floor(total % 60);
    if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  };

  const formatDate = (value) => {
    const date = new Date(String(value || ""));
    if (Number.isNaN(date.getTime())) return "时间未知";
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(date);
  };

  const setText = (node, value) => {
    if (node) node.textContent = String(value ?? "--");
  };

  const setStatus = (message, isError = false) => {
    setText(el.status, message);
    el.status?.classList.toggle("is-error", isError);
  };

  const filteredClips = () => {
    const vehicle = String(el.vehicle?.value || "");
    const query = String(el.search?.value || "").trim().toLowerCase();
    return state.clips.filter((clip) => {
      if (vehicle && clip.vehicle_id !== vehicle) return false;
      if (!query) return true;
      return `${clip.vehicle_id || ""} ${clip.clip_id || ""}`.toLowerCase().includes(query);
    });
  };

  const stopPlayback = () => {
    state.playing = false;
    if (state.animationFrame) cancelAnimationFrame(state.animationFrame);
    state.animationFrame = 0;
    if (el.play) {
      el.play.textContent = "▶";
      el.play.setAttribute("aria-label", "播放");
    }
  };

  const clearPlayer = () => {
    stopPlayback();
    state.selected = null;
    state.preview = null;
    state.frameIndex = 0;
    state.currentTime = 0;
    if (el.empty) el.empty.hidden = false;
    if (el.play) el.play.disabled = true;
    if (el.timeline) {
      el.timeline.disabled = true;
      el.timeline.max = "0";
      el.timeline.value = "0";
    }
    if (el.download) {
      el.download.removeAttribute("href");
      el.download.setAttribute("aria-disabled", "true");
      el.download.classList.add("is-disabled");
    }
    setText(el.kicker, "NO CLIP SELECTED");
    setText(el.title, "等待充电上传的数据片段");
    setText(el.meta, "原始 bag 不抽帧；下面的点云抽样只用于浏览器可视化。");
    renderFrame(null);
  };

  const renderCatalogSummary = (summary = {}) => {
    setText(el.count, number(summary.clip_count, state.clips.length));
    setText(el.vehicles, `${number(summary.vehicle_count, 0)} 辆车`);
    setText(el.duration, formatDuration(summary.total_duration_sec));
    setText(el.size, formatBytes(summary.total_bag_bytes));
  };

  const rebuildVehicleFilter = () => {
    if (!el.vehicle) return;
    const selected = el.vehicle.value;
    const vehicles = [...new Set(state.clips.map((clip) => clip.vehicle_id).filter(Boolean))].sort();
    el.vehicle.replaceChildren(new Option("全部车辆", ""));
    vehicles.forEach((vehicle) => el.vehicle.append(new Option(vehicle, vehicle)));
    el.vehicle.value = vehicles.includes(selected) ? selected : "";
  };

  const renderClipList = () => {
    if (!el.list) return;
    const clips = filteredClips();
    el.list.replaceChildren();
    setStatus(state.clips.length ? `显示 ${clips.length} / ${state.clips.length} 个片段` : "还没有完成上传的片段");
    if (!clips.length) {
      const empty = document.createElement("div");
      empty.className = "e2e-clip-list-empty";
      empty.textContent = state.clips.length ? "没有匹配的车辆或片段" : "等待车辆在稳定充电时上传首个 30 秒片段";
      el.list.append(empty);
      return;
    }
    clips.forEach((clip) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "e2e-clip-item";
      button.classList.toggle("is-active", state.selected?.clip_id === clip.clip_id && state.selected?.vehicle_id === clip.vehicle_id);
      button.setAttribute("aria-pressed", button.classList.contains("is-active") ? "true" : "false");

      const head = document.createElement("span");
      head.className = "e2e-clip-item-head";
      const vehicle = document.createElement("b");
      vehicle.textContent = clip.vehicle_id || "UNKNOWN";
      const duration = document.createElement("span");
      duration.textContent = formatDuration(clip.duration_sec, true);
      head.append(vehicle, duration);

      const code = document.createElement("code");
      code.textContent = clip.clip_id || "--";

      const meta = document.createElement("span");
      meta.className = "e2e-clip-item-meta";
      const captured = document.createElement("span");
      captured.textContent = formatDate(clip.captured_at);
      const size = document.createElement("span");
      size.textContent = formatBytes(clip.files?.bag?.size_bytes);
      meta.append(captured, size);

      button.append(head, code, meta);
      button.addEventListener("click", () => selectClip(clip));
      el.list.append(button);
    });
  };

  const canvasContext = (canvas) => {
    if (!canvas) return null;
    const width = Math.max(280, Math.round(canvas.clientWidth || 520));
    const height = Math.max(240, Math.round(canvas.clientHeight || 330));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const targetWidth = Math.round(width * dpr);
    const targetHeight = Math.round(height * dpr);
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    return { context, width, height };
  };

  const drawBackdrop = (context, width, height) => {
    const gradient = context.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, "#071729");
    gradient.addColorStop(1, "#020914");
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
    context.strokeStyle = "rgba(101, 161, 204, .09)";
    context.lineWidth = 1;
    for (let x = 0; x <= width; x += 40) {
      context.beginPath();
      context.moveTo(x + 0.5, 0);
      context.lineTo(x + 0.5, height);
      context.stroke();
    }
    for (let y = 0; y <= height; y += 40) {
      context.beginPath();
      context.moveTo(0, y + 0.5);
      context.lineTo(width, y + 0.5);
      context.stroke();
    }
  };

  const drawLidar = (frame) => {
    const surface = canvasContext(el.lidar);
    if (!surface) return;
    const { context, width, height } = surface;
    drawBackdrop(context, width, height);
    const rangeForward = 65;
    const rangeBack = 15;
    const rangeSide = 38;
    const scale = Math.min(width / (rangeSide * 2), height / (rangeForward + rangeBack));
    const originX = width / 2;
    const originY = height - rangeBack * scale - 12;
    const project = (x, y) => [originX - y * scale, originY - x * scale];

    context.font = "10px ui-monospace, monospace";
    context.textAlign = "left";
    for (let distance = -10; distance <= 60; distance += 10) {
      const [, py] = project(distance, 0);
      context.strokeStyle = distance === 0 ? "rgba(103, 204, 236, .28)" : "rgba(103, 174, 210, .12)";
      context.beginPath();
      context.moveTo(0, py);
      context.lineTo(width, py);
      context.stroke();
      context.fillStyle = "rgba(132, 174, 205, .45)";
      context.fillText(`${distance}m`, 6, py - 4);
    }
    [-30, -20, -10, 0, 10, 20, 30].forEach((lateral) => {
      const [px] = project(0, lateral);
      context.strokeStyle = lateral === 0 ? "rgba(103, 204, 236, .28)" : "rgba(103, 174, 210, .12)";
      context.beginPath();
      context.moveTo(px, 0);
      context.lineTo(px, height);
      context.stroke();
    });

    const points = Array.isArray(frame?.lidar) ? frame.lidar : [];
    context.fillStyle = "rgba(95, 230, 255, .7)";
    for (let index = 0; index + 3 < points.length; index += 4) {
      const x = number(points[index]);
      const y = number(points[index + 1]);
      const z = number(points[index + 2], 0);
      if (x === null || y === null || x < -rangeBack || x > rangeForward || Math.abs(y) > rangeSide) continue;
      const [px, py] = project(x, y);
      if (z < -1.1) context.fillStyle = "rgba(77, 129, 158, .34)";
      else if (z > 1.6) context.fillStyle = "rgba(255, 184, 101, .72)";
      else context.fillStyle = "rgba(95, 230, 255, .68)";
      context.fillRect(px, py, 1.45, 1.45);
    }

    const [vehicleX, vehicleY] = project(0, 0);
    context.save();
    context.translate(vehicleX, vehicleY);
    context.fillStyle = "#ff6f91";
    context.shadowBlur = 12;
    context.shadowColor = "rgba(255,111,145,.7)";
    context.beginPath();
    context.moveTo(0, -10);
    context.lineTo(-6, 7);
    context.lineTo(6, 7);
    context.closePath();
    context.fill();
    context.restore();
  };

  const validPoint = (point) => Array.isArray(point) && number(point[0]) !== null && number(point[1]) !== null;

  const drawPlanning = (frame) => {
    const surface = canvasContext(el.planning);
    if (!surface) return;
    const { context, width, height } = surface;
    drawBackdrop(context, width, height);
    const reference = (frame?.reference_line || []).filter(validPoint);
    const trajectory = (frame?.trajectory || []).filter(validPoint);
    const boundaries = (frame?.boundaries || []).map((line) => (line || []).filter(validPoint)).filter((line) => line.length);
    const localization = frame?.localization || {};
    const locationPoint = number(localization.x) !== null && number(localization.y) !== null
      ? [number(localization.x), number(localization.y)]
      : null;
    const all = [...reference, ...trajectory, ...boundaries.flat(), ...(locationPoint ? [locationPoint] : [])];
    if (!all.length) return;
    let minX = Math.min(...all.map((point) => number(point[0], 0)));
    let maxX = Math.max(...all.map((point) => number(point[0], 0)));
    let minY = Math.min(...all.map((point) => number(point[1], 0)));
    let maxY = Math.max(...all.map((point) => number(point[1], 0)));
    const spanX = Math.max(12, maxX - minX);
    const spanY = Math.max(12, maxY - minY);
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    minX = centerX - spanX * 0.62;
    maxX = centerX + spanX * 0.62;
    minY = centerY - spanY * 0.62;
    maxY = centerY + spanY * 0.62;
    const padding = 24;
    const scale = Math.min((width - padding * 2) / (maxX - minX), (height - padding * 2) / (maxY - minY));
    const project = (point) => [
      width / 2 + (number(point[0], centerX) - centerX) * scale,
      height / 2 - (number(point[1], centerY) - centerY) * scale
    ];
    const polyline = (points, color, lineWidth, dash = []) => {
      if (points.length < 2) return;
      context.save();
      context.strokeStyle = color;
      context.lineWidth = lineWidth;
      context.lineJoin = "round";
      context.lineCap = "round";
      context.setLineDash(dash);
      context.beginPath();
      points.forEach((point, index) => {
        const [x, y] = project(point);
        if (index) context.lineTo(x, y);
        else context.moveTo(x, y);
      });
      context.stroke();
      context.restore();
    };
    boundaries.forEach((line) => polyline(line, "rgba(255,180,93,.88)", 1.5, [5, 4]));
    polyline(reference, "rgba(87,217,255,.9)", 2);
    polyline(trajectory, "rgba(117,240,168,.96)", 2.7);
    if (locationPoint) {
      const [x, y] = project(locationPoint);
      const heading = number(localization.heading, 0);
      context.save();
      context.translate(x, y);
      context.rotate(-heading + Math.PI / 2);
      context.fillStyle = "#ff6f91";
      context.shadowBlur = 12;
      context.shadowColor = "rgba(255,111,145,.75)";
      context.beginPath();
      context.moveTo(10, 0);
      context.lineTo(-7, -6);
      context.lineTo(-4, 0);
      context.lineTo(-7, 6);
      context.closePath();
      context.fill();
      context.restore();
    }
    context.fillStyle = "rgba(141,177,204,.55)";
    context.font = "10px ui-monospace, monospace";
    context.fillText(`X ${centerX.toFixed(1)} · Y ${centerY.toFixed(1)}`, 10, height - 10);
  };

  const renderTelemetry = (frame) => {
    const duration = number(state.preview?.duration_sec, 0);
    const localization = frame?.localization || {};
    const chassis = frame?.chassis || {};
    const trajectory = frame?.trajectory_status || {};
    const planning = frame?.planning_status || {};
    const sampledPoints = Math.floor((frame?.lidar?.length || 0) / 4);
    const sourcePoints = number(frame?.lidar_source_count, 0);
    const speedKph = number(chassis.speed_kph);
    const speedMps = number(localization.speed_mps);
    setText(el.clock, `${formatDuration(state.currentTime)} / ${formatDuration(duration)}`);
    setText(el.frame, `Frame ${state.frameIndex + 1} / ${state.preview?.frames?.length || 0}`);
    setText(
      el.position,
      number(localization.x) === null ? "--" : `X ${number(localization.x).toFixed(2)} · Y ${number(localization.y, 0).toFixed(2)}`
    );
    setText(
      el.latlon,
      number(localization.latitude) === null
        ? `航向 ${number(localization.heading) === null ? "--" : number(localization.heading).toFixed(3)}`
        : `${number(localization.latitude).toFixed(7)}, ${number(localization.longitude, 0).toFixed(7)}`
    );
    setText(
      el.motion,
      speedKph !== null ? `${speedKph.toFixed(2)} km/h` : speedMps !== null ? `${speedMps.toFixed(2)} m/s` : "--"
    );
    setText(el.gear, `档位 ${chassis.gear ?? trajectory.gear ?? "--"} · 定位${localization.reliable ? "可靠" : "待确认"}`);
    setText(el.planningState, planning.current_scenario ?? planning.current_action ?? "规划轨迹");
    setText(el.estop, `ESTOP ${trajectory.estop || chassis.emergency_stop ? "触发" : "正常"}`);
    setText(el.points, `${sourcePoints.toLocaleString()} / ${sampledPoints.toLocaleString()}`);
  };

  function renderFrame(frame) {
    drawLidar(frame);
    drawPlanning(frame);
    renderTelemetry(frame);
  }

  const frameIndexAt = (time) => {
    const frames = state.preview?.frames || [];
    if (!frames.length) return 0;
    let low = 0;
    let high = frames.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (number(frames[middle]?.t, 0) <= time) low = middle + 1;
      else high = middle - 1;
    }
    return Math.max(0, Math.min(frames.length - 1, high));
  };

  const seek = (time) => {
    if (!state.preview?.frames?.length) return;
    const duration = number(state.preview.duration_sec, 0);
    state.currentTime = Math.max(0, Math.min(duration, number(time, 0)));
    state.frameIndex = frameIndexAt(state.currentTime);
    if (el.timeline) el.timeline.value = String(Math.round(state.currentTime * 1000));
    renderFrame(state.preview.frames[state.frameIndex]);
  };

  const playbackTick = (now) => {
    if (!state.playing || !state.preview) return;
    const speed = number(el.speed?.value, 1);
    const elapsed = ((now - state.playbackStartedAt) / 1000) * speed;
    const duration = number(state.preview.duration_sec, 0);
    seek(state.playbackStartedTime + elapsed);
    if (state.currentTime >= duration) {
      stopPlayback();
      return;
    }
    state.animationFrame = requestAnimationFrame(playbackTick);
  };

  const togglePlayback = () => {
    if (!state.preview?.frames?.length) return;
    if (state.playing) {
      stopPlayback();
      return;
    }
    const duration = number(state.preview.duration_sec, 0);
    if (state.currentTime >= duration) seek(0);
    state.playing = true;
    state.playbackStartedAt = performance.now();
    state.playbackStartedTime = state.currentTime;
    if (el.play) {
      el.play.textContent = "❚❚";
      el.play.setAttribute("aria-label", "暂停");
    }
    state.animationFrame = requestAnimationFrame(playbackTick);
  };

  async function selectClip(clip) {
    if (!clip?.urls?.preview) return;
    stopPlayback();
    state.previewRequest?.abort();
    const request = new AbortController();
    state.previewRequest = request;
    state.selected = clip;
    state.preview = null;
    renderClipList();
    if (el.empty) {
      el.empty.hidden = false;
      el.empty.querySelector("strong").textContent = "正在加载回放预览";
      el.empty.querySelector("span").textContent = "读取点云与规划同步索引…";
    }
    setText(el.kicker, `${clip.vehicle_id} · ${formatDate(clip.captured_at)}`);
    setText(el.title, clip.clip_id);
    setText(el.meta, `${formatDuration(clip.duration_sec, true)} · 原始 ${formatBytes(clip.files?.bag?.size_bytes)} · ${clip.frame_count || 0} 个预览帧`);
    if (el.download) {
      el.download.href = clip.urls.bag;
      el.download.setAttribute("download", `${clip.vehicle_id}_${clip.clip_id}.bag`);
      el.download.removeAttribute("aria-disabled");
      el.download.classList.remove("is-disabled");
    }
    try {
      const response = await fetch(clip.urls.preview, {
        credentials: "same-origin",
        cache: "force-cache",
        signal: request.signal
      });
      const preview = await response.json().catch(() => null);
      if (!response.ok) throw new Error(preview?.detail || preview?.error || `HTTP ${response.status}`);
      if (preview?.schema !== "auto_ad_e2e_preview.v1" || !Array.isArray(preview.frames)) {
        throw new Error("预览索引格式不兼容");
      }
      if (state.previewRequest !== request) return;
      state.preview = preview;
      state.currentTime = 0;
      state.frameIndex = 0;
      if (el.empty) el.empty.hidden = preview.frames.length > 0;
      if (el.play) el.play.disabled = preview.frames.length === 0;
      if (el.timeline) {
        el.timeline.disabled = preview.frames.length === 0;
        el.timeline.max = String(Math.max(0, Math.round(number(preview.duration_sec, 0) * 1000)));
        el.timeline.value = "0";
      }
      renderFrame(preview.frames[0] || null);
    } catch (error) {
      if (error?.name === "AbortError") return;
      if (el.empty) {
        el.empty.hidden = false;
        el.empty.querySelector("strong").textContent = "回放预览读取失败";
        el.empty.querySelector("span").textContent = error instanceof Error ? error.message : String(error);
      }
      renderFrame(null);
    }
  }

  const loadCatalog = async () => {
    if (el.refresh) el.refresh.disabled = true;
    setStatus("正在读取已上传片段…");
    try {
      const response = await fetch("/api/e2e-autonomous-driving/clips?limit=500", {
        credentials: "same-origin",
        cache: "no-store"
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.detail || payload.error || `HTTP ${response.status}`);
      state.clips = Array.isArray(payload.clips) ? payload.clips : [];
      renderCatalogSummary(payload.summary);
      rebuildVehicleFilter();
      const previous = state.selected
        ? state.clips.find((clip) => clip.vehicle_id === state.selected.vehicle_id && clip.clip_id === state.selected.clip_id)
        : null;
      renderClipList();
      if (!state.clips.length) clearPlayer();
      else if (!previous) await selectClip(state.clips[0]);
    } catch (error) {
      setStatus(`片段目录读取失败：${error instanceof Error ? error.message : String(error)}`, true);
      if (!state.clips.length) clearPlayer();
    } finally {
      if (el.refresh) el.refresh.disabled = false;
    }
  };

  el.refresh?.addEventListener("click", loadCatalog);
  el.vehicle?.addEventListener("change", renderClipList);
  el.search?.addEventListener("input", renderClipList);
  el.play?.addEventListener("click", togglePlayback);
  el.timeline?.addEventListener("input", () => {
    stopPlayback();
    seek(number(el.timeline.value, 0) / 1000);
  });
  el.speed?.addEventListener("change", () => {
    if (!state.playing) return;
    state.playbackStartedAt = performance.now();
    state.playbackStartedTime = state.currentTime;
  });

  const resize = () => renderFrame(state.preview?.frames?.[state.frameIndex] || null);
  if ("ResizeObserver" in window) {
    const observer = new ResizeObserver(resize);
    if (el.lidar) observer.observe(el.lidar);
    if (el.planning) observer.observe(el.planning);
  } else {
    window.addEventListener("resize", resize);
  }

  clearPlayer();
  loadCatalog();
}
