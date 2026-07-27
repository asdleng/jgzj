const DEFAULT_DEVICE_ID = "a001I3829202711775712260";
const DEFAULT_VEHICLE_ID = "BIT-0041";
const CONTROL_VEHICLE_ID = "BIT-0041";
const CONTROL_API_BASE = "/api/remote-drive";
const CONTROL_WS_PATH = "/ws/remote-drive";
const CONTROL_HEARTBEAT_MS = 100;
const CONTROL_LEASE_HEARTBEAT_MS = 200;
const CONTROL_REQUEST_TIMEOUT_MS = 5000;
const STEERING_COMMAND_DEG = 250;
const DRIVE_ACCELERATOR_PERCENT = 30;
const DRIVE_ACCELERATOR_RAMP_STEP_PERCENT = 2;
const GEAR_SHIFT_SETTLE_MS = 300;
const PLAY_TARGETS = {
  edge: {
    id: "edge",
    label: "边缘",
    host: "120.25.209.170",
    apiBase: `${CONTROL_API_BASE}/webrtc/edge`,
    timeoutMs: 20000,
  },
  origin: {
    id: "origin",
    label: "源站",
    host: "47.112.103.12",
    apiBase: `${CONTROL_API_BASE}/webrtc/origin`,
    timeoutMs: 20000,
  },
};

const players = new Map();
let activeDeviceId = DEFAULT_DEVICE_ID;
let activeVehicleId = DEFAULT_VEHICLE_ID;
let activeRouteMode = "auto";
let connectGeneration = 0;
let aggregateTimer = null;
let clockTimer = null;
let toastTimer = null;
let controlHeartbeatTimer = null;
let controlLeaseHeartbeatTimer = null;
let controlSocket = null;
let controlSocketPromise = null;
let controlSocketRequestId = 0;
let controlStatusTimer = null;
let controlStatusInFlight = false;
let taskPlanTimer = null;
let taskPlanGeneration = 0;
let unloadReleaseSent = false;
let gearShiftTimer = null;
const activeMotionControls = new Set();
const criticalControlCommands = [];
const controlSocketRequests = new Map();

const controlState = {
  token: "",
  sessionId: "",
  sessionActive: false,
  acquiring: false,
  backendOnline: false,
  backendSessionActive: false,
  transportAlive: false,
  transportMode: "",
  commandEnabled: false,
  emergency: false,
  motionPaused: false,
  driveGear: "D",
  gear: "P",
  steering: 0,
  brake: 100,
  accelerator: 0,
  sequence: 0,
  commandInFlight: false,
  commandQueued: false,
  vehicle: null,
  lastError: "",
  constraints: {
    max_steering_deg: 250,
    max_accelerator_percent: 30,
  },
};

const taskPlanState = {
  vehicleId: "",
  routes: [],
  plans: [],
  loading: false,
  stopping: false,
  deleting: new Set(),
};

const elements = {
  form: document.getElementById("connectionForm"),
  vehicleSelect: document.getElementById("vehicleSelect"),
  reconnectAllButton: document.getElementById("reconnectAllButton"),
  copyLinkButton: document.getElementById("copyLinkButton"),
  videoGrid: document.getElementById("videoGrid"),
  fleetStatusDot: document.getElementById("fleetStatusDot"),
  fleetStatusText: document.getElementById("fleetStatusText"),
  activeDeviceId: document.getElementById("activeDeviceId"),
  onlineCount: document.getElementById("onlineCount"),
  aggregateBitrate: document.getElementById("aggregateBitrate"),
  activeRoute: document.getElementById("activeRoute"),
  localClock: document.getElementById("localClock"),
  toast: document.getElementById("toast"),
  controlStatusBadge: document.getElementById("controlStatusBadge"),
  controlStatusText: document.getElementById("controlStatusText"),
  controlGate: document.getElementById("controlGate"),
  controlGateLabel: document.getElementById("controlGateLabel"),
  controlGateDetail: document.getElementById("controlGateDetail"),
  controlAvailability: document.getElementById("controlAvailability"),
  controlSessionButton: document.getElementById("controlSessionButton"),
  motionCommandLabel: document.getElementById("motionCommandLabel"),
  motionCommandDetail: document.getElementById("motionCommandDetail"),
  gearToggleButton: document.getElementById("gearToggleButton"),
  gearToggleLabel: document.getElementById("gearToggleLabel"),
  throttleButton: document.querySelector('[data-motion="throttle"]'),
  throttleButtonLabel: document.querySelector('[data-motion="throttle"] span'),
  commandSequence: document.getElementById("commandSequence"),
  telemetrySpeed: document.getElementById("telemetrySpeed"),
  telemetryGear: document.getElementById("telemetryGear"),
  telemetryTargetSteering: document.getElementById("telemetryTargetSteering"),
  telemetryCommandAck: document.getElementById("telemetryCommandAck"),
  telemetrySteering: document.getElementById("telemetrySteering"),
  telemetryRearSteering: document.getElementById("telemetryRearSteering"),
  telemetrySoc: document.getElementById("telemetrySoc"),
  transportStatus: document.getElementById("transportStatus"),
  transportStatusRow: document.querySelector(".transport-status"),
  taskPlanForm: document.getElementById("taskPlanForm"),
  taskPlannerStatus: document.getElementById("taskPlannerStatus"),
  stopTaskButton: document.getElementById("stopTaskButton"),
  refreshTaskPlansButton: document.getElementById("refreshTaskPlansButton"),
  taskMainRoute: document.getElementById("taskMainRoute"),
  taskAuxiliaryRoute: document.getElementById("taskAuxiliaryRoute"),
  taskStartAt: document.getElementById("taskStartAt"),
  taskEndAt: document.getElementById("taskEndAt"),
  taskSpeed: document.getElementById("taskSpeed"),
  taskRunCount: document.getElementById("taskRunCount"),
  taskRechargePower: document.getElementById("taskRechargePower"),
  taskPlanSubmit: document.getElementById("taskPlanSubmit"),
  taskPlanRows: document.getElementById("taskPlanRows"),
  taskPlanEmpty: document.getElementById("taskPlanEmpty"),
};

class StreamPlayer {
  constructor(tile) {
    this.tile = tile;
    this.channel = tile.dataset.channel;
    this.video = tile.querySelector("video");
    this.stateTitle = tile.querySelector(".stream-state strong");
    this.stateLabel = tile.querySelector(".state-label");
    this.resolution = tile.querySelector(".resolution");
    this.bitrate = tile.querySelector(".bitrate");
    this.rtt = tile.querySelector(".rtt");
    this.pc = null;
    this.mediaStream = null;
    this.statsTimer = null;
    this.reconnectTimer = null;
    this.abortController = null;
    this.state = "idle";
    this.route = null;
    this.lastBytes = 0;
    this.lastStatsAt = 0;
    this.lastDecodedFrames = 0;
    this.lastFrameAt = 0;
    this.bitrateMbps = 0;
    this.manualClose = false;
    this.attempt = 0;

    tile.querySelector(".reconnect-button").addEventListener("click", () => {
      this.connect(activeDeviceId, activeRouteMode, connectGeneration);
    });
    tile.querySelector(".focus-button").addEventListener("click", () => toggleFocus(tile));
    tile.querySelector(".fullscreen-button").addEventListener("click", () => requestTileFullscreen(tile));
  }

  async connect(deviceId, routeMode, generation) {
    this.close(false);
    this.manualClose = false;
    this.attempt += 1;
    const currentAttempt = this.attempt;
    this.setState("connecting", "正在连接");

    const targets = routeMode === "auto"
      ? [PLAY_TARGETS.edge, PLAY_TARGETS.origin]
      : [PLAY_TARGETS[routeMode]];

    let lastError = null;
    for (const target of targets) {
      if (generation !== connectGeneration || currentAttempt !== this.attempt) return;
      try {
        this.setState("connecting", `连接${target.label}`);
        await this.openTarget(deviceId, target, generation, currentAttempt);
        if (generation !== connectGeneration || currentAttempt !== this.attempt) return;
        this.route = target;
        this.setState("live", "实时");
        this.startStats();
        updateAggregateStatus();
        return;
      } catch (error) {
        lastError = error;
        this.destroyPeer();
      }
    }

    if (generation !== connectGeneration || currentAttempt !== this.attempt) return;
    this.setState("error", "连接失败");
    this.scheduleReconnect(deviceId, routeMode, generation);
    console.warn(`Channel ${this.channel} connection failed`, lastError);
  }

  async openTarget(deviceId, target, generation, attempt) {
    const pc = new RTCPeerConnection({ bundlePolicy: "max-bundle" });
    const mediaStream = new MediaStream();
    this.pc = pc;
    this.mediaStream = mediaStream;
    this.video.srcObject = mediaStream;

    pc.addTransceiver("audio", { direction: "recvonly" });
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.ontrack = (event) => {
      if (!mediaStream.getTracks().some((track) => track.id === event.track.id)) {
        mediaStream.addTrack(event.track);
      }
      this.video.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (generation !== connectGeneration || attempt !== this.attempt || this.manualClose) return;
      if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
        this.setState("error", "连接中断");
        this.scheduleReconnect(deviceId, activeRouteMode, generation);
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const apiUrl = `${target.apiBase}/play/`;
    const app = `live/${deviceId}`;
    const streamUrl = `webrtc://${target.host}/${app}/${this.channel}`;
    this.abortController = new AbortController();
    const timeout = window.setTimeout(() => this.abortController?.abort(), target.timeoutMs);

    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: this.abortController.signal,
        body: JSON.stringify({
          api: apiUrl,
          tid: createTid(),
          streamurl: streamUrl,
          clientip: null,
          sdp: offer.sdp,
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || Number(data.code) !== 0 || !data.sdp) {
        throw new Error(data?.msg || data?.message || `HTTP ${response.status}`);
      }
      await pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: data.sdp }));
      await waitForVideo(this.video, target.timeoutMs);
    } finally {
      window.clearTimeout(timeout);
      this.abortController = null;
    }
  }

  startStats() {
    window.clearInterval(this.statsTimer);
    this.lastBytes = 0;
    this.lastStatsAt = 0;
    this.lastDecodedFrames = 0;
    this.lastFrameAt = Date.now();
    this.statsTimer = window.setInterval(() => this.collectStats(), 1000);
    this.collectStats();
  }

  async collectStats() {
    if (!this.pc || this.pc.connectionState === "closed") return;
    try {
      const stats = await this.pc.getStats();
      let inbound = null;
      let pair = null;
      stats.forEach((report) => {
        if (report.type === "inbound-rtp" && report.kind === "video") inbound = report;
        if (report.type === "candidate-pair" && report.state === "succeeded" && report.nominated) pair = report;
      });

      const now = Date.now();
      if (inbound) {
        if (this.lastStatsAt && inbound.bytesReceived >= this.lastBytes) {
          const seconds = (now - this.lastStatsAt) / 1000;
          this.bitrateMbps = seconds > 0 ? ((inbound.bytesReceived - this.lastBytes) * 8) / seconds / 1_000_000 : 0;
        }
        this.lastBytes = inbound.bytesReceived || 0;
        this.lastStatsAt = now;
        const decoded = inbound.framesDecoded || 0;
        if (decoded > this.lastDecodedFrames) this.lastFrameAt = now;
        this.lastDecodedFrames = decoded;

        const width = inbound.frameWidth || this.video.videoWidth;
        const height = inbound.frameHeight || this.video.videoHeight;
        this.resolution.textContent = width && height ? `${width}x${height}` : "-";
        this.bitrate.textContent = `${this.bitrateMbps.toFixed(2)} Mbps`;
      }
      this.rtt.textContent = pair?.currentRoundTripTime != null
        ? `RTT ${Math.round(pair.currentRoundTripTime * 1000)} ms`
        : "RTT -";

      if (this.state === "live" && now - this.lastFrameAt > 7000) {
        this.setState("error", "画面中断");
        this.scheduleReconnect(activeDeviceId, activeRouteMode, connectGeneration);
      }
      updateAggregateStatus();
    } catch (error) {
      console.debug(`Channel ${this.channel} stats unavailable`, error);
    }
  }

  scheduleReconnect(deviceId, routeMode, generation) {
    if (this.manualClose || this.reconnectTimer || generation !== connectGeneration) return;
    const delay = Math.min(15000, 2500 + this.attempt * 1000);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(deviceId, routeMode, generation);
    }, delay);
  }

  setState(state, label) {
    this.state = state;
    this.tile.dataset.state = state;
    this.stateTitle.textContent = label;
    this.stateLabel.textContent = state === "live" ? "实时" : state === "connecting" ? "连接中" : state === "error" ? "异常" : "离线";
    const dot = this.tile.querySelector(".live-pill .status-dot");
    dot.className = `status-dot ${state}`;
    updateAggregateStatus();
  }

  close(manual = true) {
    this.manualClose = manual;
    this.attempt += 1;
    window.clearInterval(this.statsTimer);
    window.clearTimeout(this.reconnectTimer);
    this.statsTimer = null;
    this.reconnectTimer = null;
    this.abortController?.abort();
    this.abortController = null;
    this.destroyPeer();
    this.route = null;
    this.bitrateMbps = 0;
    this.resolution.textContent = "-";
    this.bitrate.textContent = "0.00 Mbps";
    this.rtt.textContent = "RTT -";
    if (manual) this.setState("idle", "等待连接");
  }

  destroyPeer() {
    if (this.pc) {
      this.pc.ontrack = null;
      this.pc.onconnectionstatechange = null;
      this.pc.getTransceivers().forEach((transceiver) => transceiver.stop?.());
      this.pc.close();
      this.pc = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }
    this.video.srcObject = null;
  }
}

function createTid() {
  return Number.parseInt(String(Date.now() * Math.random() * 100), 10).toString(16).slice(0, 7);
}

function waitForVideo(video, timeoutMs) {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => finish(new Error("等待视频帧超时")), timeoutMs);
    const onReady = () => finish();
    const finish = (error) => {
      window.clearTimeout(timer);
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("playing", onReady);
      error ? reject(error) : resolve();
    };
    video.addEventListener("loadeddata", onReady, { once: true });
    video.addEventListener("playing", onReady, { once: true });
  });
}

function readRouteMode() {
  return document.querySelector('input[name="route"]:checked')?.value || "auto";
}

function connectAll() {
  const selectedOption = elements.vehicleSelect.selectedOptions[0];
  const deviceId = selectedOption?.value?.trim() || "";
  const vehicleId = selectedOption?.dataset.vehicleId || "";
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(deviceId)) {
    showToast("车辆配置不完整", true);
    elements.vehicleSelect.focus();
    return;
  }

  activeDeviceId = deviceId;
  activeVehicleId = vehicleId || DEFAULT_VEHICLE_ID;
  activeRouteMode = readRouteMode();
  connectGeneration += 1;
  const generation = connectGeneration;
  updateUrl();
  elements.activeDeviceId.textContent = activeVehicleId;
  localStorage.setItem("vehicleStreamViewer.deviceId", activeDeviceId);
  localStorage.setItem("vehicleStreamViewer.vehicleId", activeVehicleId);
  localStorage.setItem("vehicleStreamViewer.route", activeRouteMode);

  players.forEach((player, index) => {
    window.setTimeout(() => player.connect(activeDeviceId, activeRouteMode, generation), index * 180);
  });
  if (taskPlanState.vehicleId !== activeVehicleId) {
    void loadTaskPlanner();
  } else {
    void loadTaskPlans({ silent: true });
  }
  showToast(`正在连接 ${activeVehicleId}`);
}

function updateAggregateStatus() {
  const list = [...players.values()];
  const live = list.filter((player) => player.state === "live");
  const connecting = list.filter((player) => player.state === "connecting");
  const totalBitrate = live.reduce((sum, player) => sum + player.bitrateMbps, 0);
  const routeLabels = [...new Set(live.map((player) => player.route?.label).filter(Boolean))];

  elements.onlineCount.textContent = `${live.length} / ${list.length || 4}`;
  elements.aggregateBitrate.textContent = `${totalBitrate.toFixed(2)} Mbps`;
  elements.activeRoute.textContent = routeLabels.length ? routeLabels.join(" + ") : "-";

  let state = "idle";
  let label = "等待连接";
  if (live.length === list.length && list.length) {
    state = "live";
    label = `${live.length} 路实时画面`;
  } else if (live.length) {
    state = "connecting";
    label = `${live.length} 路在线，正在恢复其余画面`;
  } else if (connecting.length) {
    state = "connecting";
    label = "正在建立视频连接";
  } else if (list.some((player) => player.state === "error")) {
    state = "error";
    label = "视频连接异常，正在重试";
  }
  elements.fleetStatusDot.className = `status-dot ${state}`;
  elements.fleetStatusText.textContent = label;
  renderControlState();
}

function updateUrl() {
  const url = new URL(window.location.href);
  url.searchParams.set("vehicle", activeVehicleId);
  url.searchParams.delete("device_id");
  if (activeRouteMode === "auto") url.searchParams.delete("route");
  else url.searchParams.set("route", activeRouteMode);
  window.history.replaceState(null, "", url);
}

function toggleFocus(tile) {
  const isFocused = tile.classList.contains("is-focused");
  elements.videoGrid.classList.toggle("has-focus", !isFocused);
  document.querySelectorAll(".stream-tile").forEach((item) => item.classList.remove("is-focused"));
  if (!isFocused) tile.classList.add("is-focused");
}

function requestTileFullscreen(tile) {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
    return;
  }
  tile.requestFullscreen?.().catch(() => showToast("浏览器未允许全屏", true));
}

async function copyCurrentLink() {
  try {
    await navigator.clipboard.writeText(window.location.href);
    showToast("当前监看链接已复制");
  } catch {
    const input = document.createElement("input");
    input.value = window.location.href;
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
    showToast("当前监看链接已复制");
  }
}

function setTaskPlannerStatus(label, state = "ready") {
  elements.taskPlannerStatus.textContent = label;
  elements.taskPlannerStatus.dataset.state = state;
}

function toDateTimeLocalValue(value) {
  const date = value instanceof Date ? value : new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 19);
}

function resetTaskPlanTimes(force = false) {
  if (!force && elements.taskStartAt.value && elements.taskEndAt.value) return;
  const start = new Date(Date.now() + 5 * 60 * 1000);
  start.setSeconds(0, 0);
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
  elements.taskStartAt.value = toDateTimeLocalValue(start);
  elements.taskEndAt.value = toDateTimeLocalValue(end);
  elements.taskStartAt.min = toDateTimeLocalValue(new Date());
  elements.taskEndAt.min = elements.taskStartAt.value;
}

function keepTaskPlanEndAfterStart() {
  const start = new Date(elements.taskStartAt.value);
  const end = new Date(elements.taskEndAt.value);
  if (!Number.isFinite(start.getTime())) return;
  elements.taskEndAt.min = elements.taskStartAt.value;
  if (!Number.isFinite(end.getTime()) || end <= start) {
    elements.taskEndAt.value = toDateTimeLocalValue(new Date(start.getTime() + 2 * 60 * 60 * 1000));
  }
}

async function taskPlanApi(path, options = {}) {
  const response = await fetch(`${CONTROL_API_BASE}${path}`, {
    method: options.method || "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `请求失败 (${response.status})`);
  }
  return payload;
}

function renderTaskRouteOptions() {
  const previousMain = elements.taskMainRoute.value;
  const previousAuxiliary = elements.taskAuxiliaryRoute.value;
  const routeSelects = [elements.taskMainRoute, elements.taskAuxiliaryRoute];
  routeSelects.forEach((select) => {
    select.replaceChildren();
    taskPlanState.routes.forEach((route) => {
      const option = document.createElement("option");
      option.value = route.route_id;
      option.textContent = route.name === route.route_id ? route.route_id : `${route.name} · ${route.route_id}`;
      select.appendChild(option);
    });
    select.disabled = !taskPlanState.routes.length;
  });
  if (taskPlanState.routes.some((route) => route.route_id === previousMain)) {
    elements.taskMainRoute.value = previousMain;
  } else {
    const mainRoute = taskPlanState.routes.find((route) => !/(充电|回充|接驳|charge|aux)/i.test(route.name));
    elements.taskMainRoute.value = mainRoute?.route_id || taskPlanState.routes[0]?.route_id || "";
  }
  if (taskPlanState.routes.some((route) => route.route_id === previousAuxiliary)) {
    elements.taskAuxiliaryRoute.value = previousAuxiliary;
  } else {
    const auxiliaryRoute = taskPlanState.routes.find((route) => /(充电|回充|接驳|charge|aux)/i.test(route.name));
    elements.taskAuxiliaryRoute.value = auxiliaryRoute?.route_id || taskPlanState.routes[1]?.route_id || taskPlanState.routes[0]?.route_id || "";
  }
  elements.taskPlanSubmit.disabled = !taskPlanState.routes.length || taskPlanState.loading;
}

function taskPlanStatus(plan) {
  return {
    scheduled: ["待发布", "scheduled"],
    dispatching: ["投递中", "dispatching"],
    delivered: ["已投递", "delivered"],
    stopped: ["已停止", "stopped"],
    delivery_unknown: ["投递异常", "error"],
    cancelled: ["已取消", "muted"],
    expired: ["已过期", "muted"],
  }[plan.status] || [plan.status || "未知", "muted"];
}

function formatTaskDateTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function appendTaskCell(row, className, ...lines) {
  const cell = document.createElement("div");
  cell.className = className;
  lines.filter(Boolean).forEach((line, index) => {
    const element = document.createElement(index === 0 ? "strong" : "span");
    element.textContent = line;
    cell.appendChild(element);
  });
  row.appendChild(cell);
  return cell;
}

function renderTaskPlans() {
  elements.taskPlanRows.replaceChildren();
  elements.taskPlanEmpty.hidden = taskPlanState.plans.length > 0;
  taskPlanState.plans.slice(0, 30).forEach((plan) => {
    const row = document.createElement("div");
    row.className = "task-plan-row";
    row.dataset.state = plan.status || "unknown";

    const [statusLabel, statusState] = taskPlanStatus(plan);
    const statusCell = document.createElement("div");
    statusCell.className = "task-plan-state-cell";
    const status = document.createElement("span");
    status.className = "task-plan-state";
    status.dataset.state = statusState;
    status.textContent = statusLabel;
    statusCell.appendChild(status);
    if (plan.error) {
      const error = document.createElement("small");
      error.className = "task-plan-error";
      error.textContent = plan.error;
      error.title = plan.error;
      statusCell.appendChild(error);
    }
    row.appendChild(statusCell);

    appendTaskCell(
      row,
      "task-plan-time",
      formatTaskDateTime(plan.start_at),
      `至 ${formatTaskDateTime(plan.end_at)}`,
    );
    appendTaskCell(
      row,
      "task-plan-routes",
      plan.main_route_name || plan.main_route_id,
      plan.auxiliary_route_name || plan.auxiliary_route_id,
    );
    appendTaskCell(
      row,
      "task-plan-parameters",
      `${Number(plan.speed_kph).toFixed(1)} km/h · ${plan.run_count} 圈`,
      `SOC ${plan.recharge_power}%`,
    );

    const actions = document.createElement("div");
    actions.className = "task-plan-actions";
    if (plan.status === "scheduled") {
      const cancel = document.createElement("button");
      cancel.className = "tile-icon-button";
      cancel.type = "button";
      cancel.title = "取消任务计划";
      cancel.setAttribute("aria-label", "取消任务计划");
      const icon = document.createElement("i");
      icon.setAttribute("data-lucide", "circle-x");
      cancel.appendChild(icon);
      cancel.addEventListener("click", () => void cancelTaskPlan(plan));
      actions.appendChild(cancel);
    }
    const remove = document.createElement("button");
    remove.className = "tile-icon-button task-delete-button";
    remove.type = "button";
    remove.disabled = plan.status === "dispatching" || taskPlanState.deleting.has(plan.id);
    remove.title = plan.status === "dispatching" ? "投递中的任务不能删除" : "删除任务记录";
    remove.setAttribute("aria-label", remove.title);
    const removeIcon = document.createElement("i");
    removeIcon.setAttribute("data-lucide", "trash-2");
    remove.appendChild(removeIcon);
    remove.addEventListener("click", () => void deleteTaskPlan(plan));
    actions.appendChild(remove);
    row.appendChild(actions);
    elements.taskPlanRows.appendChild(row);
  });
  window.lucide?.createIcons();
}

async function loadTaskPlanner() {
  const generation = ++taskPlanGeneration;
  const vehicleId = activeVehicleId;
  taskPlanState.vehicleId = vehicleId;
  taskPlanState.loading = true;
  elements.taskPlanSubmit.disabled = true;
  setTaskPlannerStatus("读取中", "loading");
  const query = `?vehicle_id=${encodeURIComponent(vehicleId)}`;
  const [routesResult, plansResult] = await Promise.allSettled([
    taskPlanApi(`/task-routes${query}`),
    taskPlanApi(`/task-plans${query}`),
  ]);
  if (generation !== taskPlanGeneration || vehicleId !== activeVehicleId) return;
  taskPlanState.loading = false;
  if (routesResult.status === "fulfilled") {
    taskPlanState.routes = Array.isArray(routesResult.value.routes) ? routesResult.value.routes : [];
  } else {
    taskPlanState.routes = [];
  }
  if (plansResult.status === "fulfilled") {
    taskPlanState.plans = Array.isArray(plansResult.value.plans) ? plansResult.value.plans : [];
  } else {
    taskPlanState.plans = [];
  }
  renderTaskRouteOptions();
  renderTaskPlans();
  if (routesResult.status === "rejected") {
    setTaskPlannerStatus("路线读取失败", "error");
  } else {
    setTaskPlannerStatus(`${taskPlanState.routes.length} 条路线`, "ready");
  }
}

async function loadTaskPlans(options = {}) {
  const vehicleId = activeVehicleId;
  try {
    const payload = await taskPlanApi(`/task-plans?vehicle_id=${encodeURIComponent(vehicleId)}`);
    if (vehicleId !== activeVehicleId) return;
    taskPlanState.plans = Array.isArray(payload.plans) ? payload.plans : [];
    renderTaskPlans();
  } catch (error) {
    if (!options.silent) showToast(error.message, true);
  }
}

async function cancelTaskPlan(plan) {
  if (!window.confirm(`取消 ${plan.vehicle_id} 的待发布巡逻任务？`)) return;
  try {
    await taskPlanApi(`/task-plans/${encodeURIComponent(plan.id)}/cancel`, {
      method: "POST",
      body: { vehicle_id: plan.vehicle_id },
    });
    showToast("任务计划已取消");
    await loadTaskPlans();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function deleteTaskPlan(plan) {
  const message = plan.status === "scheduled"
    ? `删除 ${plan.vehicle_id} 的待发布计划？删除后该计划不会下发。`
    : `删除 ${plan.vehicle_id} 的这条任务记录？\n只删除服务器记录，不会向车辆发送停止指令。`;
  if (!window.confirm(message)) return;
  taskPlanState.deleting.add(plan.id);
  renderTaskPlans();
  try {
    await taskPlanApi(`/task-plans/${encodeURIComponent(plan.id)}`, {
      method: "DELETE",
      body: { vehicle_id: plan.vehicle_id },
    });
    showToast("任务记录已删除");
    await loadTaskPlans();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    taskPlanState.deleting.delete(plan.id);
    renderTaskPlans();
  }
}

function setTaskStopPending(pending) {
  taskPlanState.stopping = pending;
  if (!elements.stopTaskButton) return;
  elements.stopTaskButton.disabled = pending;
  const label = elements.stopTaskButton.querySelector("span");
  if (label) label.textContent = pending ? "正在停止" : "停止当前任务";
}

async function stopCurrentTask() {
  if (taskPlanState.stopping) return;
  const vehicleId = activeVehicleId;
  if (!window.confirm(`立即停止 ${vehicleId} 当前导航任务？\n系统会等待车辆业务回执和车速归零。`)) return;
  setTaskStopPending(true);
  setTaskPlannerStatus("正在停止", "loading");
  try {
    const payload = await taskPlanApi("/task-stop", {
      method: "POST",
      body: { vehicle_id: vehicleId },
    });
    const speedKph = Number(payload.result?.vehicle_state?.speed_kph || 0);
    showToast(`任务已停止，车速 ${speedKph.toFixed(1)} km/h`);
    if (vehicleId === activeVehicleId) {
      await loadTaskPlans();
      setTaskPlannerStatus(`${taskPlanState.routes.length} 条路线`, "ready");
    }
  } catch (error) {
    if (vehicleId === activeVehicleId) setTaskPlannerStatus("停止失败", "error");
    showToast(error.message, true);
  } finally {
    setTaskStopPending(false);
  }
}

async function submitTaskPlan(event) {
  event.preventDefault();
  if (!elements.taskPlanForm.reportValidity()) return;
  const mainRoute = taskPlanState.routes.find((route) => route.route_id === elements.taskMainRoute.value);
  const auxiliaryRoute = taskPlanState.routes.find((route) => route.route_id === elements.taskAuxiliaryRoute.value);
  const start = new Date(elements.taskStartAt.value);
  const end = new Date(elements.taskEndAt.value);
  if (!mainRoute || !auxiliaryRoute || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    showToast("任务计划参数不完整", true);
    return;
  }
  if (!window.confirm(`发布 ${activeVehicleId} 巡逻任务\n${formatTaskDateTime(start)} - ${formatTaskDateTime(end)}\n${mainRoute.name}`)) return;
  elements.taskPlanSubmit.disabled = true;
  setTaskPlannerStatus("正在发布", "loading");
  try {
    await taskPlanApi("/task-plans", {
      method: "POST",
      body: {
        vehicle_id: activeVehicleId,
        main_route_id: mainRoute.route_id,
        auxiliary_route_id: auxiliaryRoute.route_id,
        start_at: start.toISOString(),
        end_at: end.toISOString(),
        speed_kph: Number(elements.taskSpeed.value),
        run_count: Number(elements.taskRunCount.value),
        recharge_power: Number(elements.taskRechargePower.value),
      },
    });
    showToast("任务计划已创建");
    setTaskPlannerStatus(`${taskPlanState.routes.length} 条路线`, "ready");
    resetTaskPlanTimes(true);
    await loadTaskPlans();
  } catch (error) {
    setTaskPlannerStatus("发布失败", "error");
    showToast(error.message, true);
  } finally {
    elements.taskPlanSubmit.disabled = !taskPlanState.routes.length;
  }
}

function bindTaskPlanner() {
  resetTaskPlanTimes();
  elements.taskPlanForm.addEventListener("submit", submitTaskPlan);
  elements.taskStartAt.addEventListener("change", keepTaskPlanEndAfterStart);
  elements.stopTaskButton?.addEventListener("click", () => void stopCurrentTask());
  elements.refreshTaskPlansButton.addEventListener("click", () => void loadTaskPlanner());
  taskPlanTimer = window.setInterval(() => void loadTaskPlans({ silent: true }), 10000);
}

function cancelGearShift() {
  window.clearTimeout(gearShiftTimer);
  gearShiftTimer = null;
}

function resetMotionState(commandEnabled = false, initialCommand = null) {
  cancelGearShift();
  activeMotionControls.clear();
  criticalControlCommands.length = 0;
  controlState.commandEnabled = commandEnabled;
  controlState.motionPaused = false;
  const initialGear = ["P", "R", "N", "D"].includes(initialCommand?.gear)
    ? initialCommand.gear : "P";
  controlState.driveGear = ["D", "R"].includes(initialGear) ? initialGear : "D";
  controlState.gear = initialGear;
  controlState.steering = 0;
  controlState.brake = Number.isFinite(Number(initialCommand?.brake))
    ? Number(initialCommand.brake) : 100;
  controlState.accelerator = 0;
}

function advanceCommandSequence() {
  controlState.sequence += 1;
}

function videosReadyForControl() {
  const list = [...players.values()];
  return list.length === 4 && list.every((player) => (
    player.state === "live"
    && player.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
    && player.video.videoWidth > 0
  ));
}

async function controlApi(path, payload = null, options = {}) {
  const request = {
    method: payload ? "POST" : "GET",
    cache: "no-store",
    headers: {},
  };
  if (payload) {
    request.headers["Content-Type"] = "application/json";
    if (controlState.token) request.headers["X-Control-Token"] = controlState.token;
    request.body = JSON.stringify(payload);
    request.keepalive = Boolean(options.keepalive);
  }
  if (options.signal) request.signal = options.signal;
  const response = await fetch(path, request);
  const data = await response.json().catch(() => ({}));
  if (response.status === 403 && payload && !options.tokenRetried) {
    const bootstrap = await fetch(`${CONTROL_API_BASE}/bootstrap`, { cache: "no-store" }).then((result) => result.json());
    if (bootstrap.ok && bootstrap.token) {
      controlState.token = bootstrap.token;
      applyControlConstraints(bootstrap.constraints);
      return controlApi(path, payload, { ...options, tokenRetried: true });
    }
  }
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `控制网关 HTTP ${response.status}`);
  }
  return data;
}

function controlSocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${CONTROL_WS_PATH}`;
}

function rejectControlSocketRequests(error) {
  controlSocketRequests.forEach(({ reject, timeout }) => {
    window.clearTimeout(timeout);
    reject(error);
  });
  controlSocketRequests.clear();
}

function ensureControlSocket() {
  if (controlSocket?.readyState === WebSocket.OPEN) return Promise.resolve(controlSocket);
  if (controlSocketPromise) return controlSocketPromise;
  controlSocketPromise = new Promise((resolve, reject) => {
    const socket = new WebSocket(controlSocketUrl());
    controlSocket = socket;
    const connectTimeout = window.setTimeout(() => {
      socket.close();
      reject(new Error("实时控制通道连接超时"));
    }, 45000);
    socket.addEventListener("open", () => {
      window.clearTimeout(connectTimeout);
      resolve(socket);
    }, { once: true });
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      const pending = controlSocketRequests.get(String(message.id || ""));
      if (!pending) return;
      controlSocketRequests.delete(String(message.id));
      window.clearTimeout(pending.timeout);
      if (message.ok) pending.resolve(message.payload || {});
      else pending.reject(new Error(message.error || `控制通道 HTTP ${message.status || 503}`));
    });
    socket.addEventListener("error", () => {
      window.clearTimeout(connectTimeout);
      reject(new Error("实时控制通道连接失败"));
    }, { once: true });
    socket.addEventListener("close", () => {
      window.clearTimeout(connectTimeout);
      if (controlSocket === socket) controlSocket = null;
      controlSocketPromise = null;
      rejectControlSocketRequests(new Error("实时控制通道已断开"));
      if (controlState.sessionActive) failLocalControl("实时控制通道已断开，车端已执行制动");
    });
  }).finally(() => {
    controlSocketPromise = null;
  });
  return controlSocketPromise;
}

async function controlSocketApi(endpoint, payload, timeoutMs = CONTROL_REQUEST_TIMEOUT_MS) {
  const socket = await ensureControlSocket();
  controlSocketRequestId += 1;
  const id = String(controlSocketRequestId);
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      controlSocketRequests.delete(id);
      reject(new Error("控制通道响应超时"));
    }, timeoutMs);
    controlSocketRequests.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({
      id,
      endpoint,
      token: controlState.token,
      payload,
    }));
  });
}

function sendControlSocketHeartbeat() {
  if (!controlState.sessionActive || !controlState.sessionId) return;
  if (controlState.transportMode === "mock") return;
  if (controlSocket?.readyState !== WebSocket.OPEN) {
    void ensureControlSocket().then(sendControlSocketHeartbeat).catch(() => {});
    return;
  }
  controlSocket.send(JSON.stringify({
    endpoint: "heartbeat",
    token: controlState.token,
    payload: { session_id: controlState.sessionId },
  }));
}

function applyControlConstraints(constraints = {}) {
  controlState.constraints = { ...controlState.constraints, ...constraints };
  const maxSteering = Number(controlState.constraints.max_steering_deg) || 250;
  const maxAccelerator = Number(controlState.constraints.max_accelerator_percent) || 30;
  controlState.steering = Math.max(-maxSteering, Math.min(maxSteering, controlState.steering));
  controlState.accelerator = Math.max(0, Math.min(maxAccelerator, controlState.accelerator));
}

async function bootstrapControl() {
  try {
    const bootstrap = await controlApi(`${CONTROL_API_BASE}/bootstrap`);
    controlState.token = bootstrap.token || "";
    applyControlConstraints(bootstrap.constraints);
    controlState.backendOnline = true;
    await pollControlStatus();
  } catch (error) {
    controlState.backendOnline = false;
    controlState.lastError = error.message;
    renderControlState();
  }
  window.clearInterval(controlStatusTimer);
  controlStatusTimer = window.setInterval(pollControlStatus, 750);
}

async function pollControlStatus() {
  if (controlStatusInFlight) return;
  controlStatusInFlight = true;
  try {
    const status = await controlApi(`${CONTROL_API_BASE}/status`);
    controlState.backendOnline = true;
    controlState.backendSessionActive = Boolean(status.session_active || status.acquiring);
    controlState.transportAlive = Boolean(status.transport_alive);
    controlState.transportMode = status.transport_mode || "";
    controlState.vehicle = status.vehicle || null;
    controlState.lastError = status.last_error || "";
    applyControlConstraints(status.constraints);
    if (controlState.sessionActive && (!status.session_active || !status.transport_alive)) {
      failLocalControl(status.last_error || "实车控制链路已断开");
    } else if (controlState.sessionActive && status.motion_paused) {
      cancelGearShift();
      activeMotionControls.clear();
      criticalControlCommands.length = 0;
      const holdGear = ["P", "R", "N", "D"].includes(status.last_command?.gear)
        ? status.last_command.gear : controlState.gear;
      controlState.gear = holdGear;
      if (["D", "R"].includes(holdGear)) controlState.driveGear = holdGear;
      controlState.steering = 0;
      controlState.accelerator = 0;
      controlState.brake = 100;
      if (!controlState.motionPaused) {
        controlState.motionPaused = true;
        showToast("控制链路已恢复，请重新按方向键");
      }
      queueControlCommand(buildControlCommand(), { critical: true });
    } else if (!status.motion_paused) {
      controlState.motionPaused = false;
    }
  } catch (error) {
    controlState.backendOnline = false;
    controlState.lastError = error.message;
    if (controlState.sessionActive) failLocalControl("服务器控制网关失联，车端已执行超时制动");
  } finally {
    controlStatusInFlight = false;
    renderControlState();
  }
}

function buildControlCommand() {
  return {
    deadman: controlState.commandEnabled && controlState.sessionActive && !controlState.emergency,
    gear: controlState.gear,
    steering: controlState.steering,
    brake: controlState.brake,
    accelerator: controlState.accelerator,
    steer_lamp: 0,
    front_lamp: 0,
    ad_screen: 1,
  };
}

function queueControlCommand(command = null, options = {}) {
  if (!controlState.sessionActive || !controlState.sessionId) return;
  if (options.critical) {
    criticalControlCommands.push(command || buildControlCommand());
  }
  if (controlState.commandInFlight) {
    controlState.commandQueued = true;
    return;
  }
  void sendControlCommand();
}

async function sendControlCommand() {
  if (!controlState.sessionActive || !controlState.sessionId || controlState.commandInFlight) return;
  controlState.commandInFlight = true;
  controlState.commandQueued = false;
  advanceCommandSequence();
  const sessionId = controlState.sessionId;
  const command = criticalControlCommands.shift() || buildControlCommand();
  try {
    const payload = {
      session_id: sessionId,
      sequence: controlState.sequence,
      command,
    };
    if (controlState.transportMode === "mock") {
      await controlApi(`${CONTROL_API_BASE}/command`, payload);
    } else {
      const socket = await ensureControlSocket();
      socket.send(JSON.stringify({
        endpoint: "command",
        token: controlState.token,
        payload,
      }));
    }
  } catch (error) {
    if (controlState.sessionId === sessionId) {
      failLocalControl(error.message);
    }
  } finally {
    controlState.commandInFlight = false;
    renderControlState();
    if ((controlState.commandQueued || criticalControlCommands.length) && controlState.sessionActive) {
      queueControlCommand();
    }
  }
}

function startControlHeartbeat() {
  window.clearInterval(controlHeartbeatTimer);
  window.clearInterval(controlLeaseHeartbeatTimer);
  controlHeartbeatTimer = window.setInterval(() => {
    advanceThrottleRamp();
    queueControlCommand();
  }, CONTROL_HEARTBEAT_MS);
  controlLeaseHeartbeatTimer = window.setInterval(sendControlSocketHeartbeat, CONTROL_LEASE_HEARTBEAT_MS);
  queueControlCommand();
  sendControlSocketHeartbeat();
}

function stopControlHeartbeat() {
  window.clearInterval(controlHeartbeatTimer);
  window.clearInterval(controlLeaseHeartbeatTimer);
  controlHeartbeatTimer = null;
  controlLeaseHeartbeatTimer = null;
  controlState.commandQueued = false;
  criticalControlCommands.length = 0;
}

function failLocalControl(message) {
  if (!controlState.sessionActive && !controlState.sessionId) return;
  stopControlHeartbeat();
  controlState.sessionActive = false;
  controlState.sessionId = "";
  controlState.transportAlive = false;
  controlState.emergency = true;
  controlState.motionPaused = false;
  controlState.lastError = message;
  resetMotionState();
  renderControlState();
  showToast(message, true);
}

async function acquireControl() {
  if (controlState.emergency) {
    controlState.emergency = false;
    controlState.lastError = "";
    renderControlState();
    showToast("软件急停状态已确认复位");
    return;
  }
  if (activeVehicleId !== CONTROL_VEHICLE_ID) {
    showToast("当前只开放 BIT-0041 实车控制", true);
    return;
  }
  controlState.acquiring = true;
  renderControlState();
  try {
    if (controlState.transportMode !== "mock") await ensureControlSocket();
    const result = await controlApi(`${CONTROL_API_BASE}/acquire`, {
      vehicle_id: activeVehicleId,
      video_ready: videosReadyForControl(),
    });
    controlState.sessionId = result.session_id;
    controlState.sessionActive = true;
    controlState.backendSessionActive = true;
    controlState.transportAlive = true;
    controlState.emergency = false;
    controlState.lastError = "";
    controlState.sequence = 0;
    resetMotionState(true, result.applied);
    applyControlConstraints(result.constraints);
    startControlHeartbeat();
    showToast("BIT-0041 已接管，可直接控制");
  } catch (error) {
    controlState.lastError = error.message;
    showToast(error.message, true);
  } finally {
    controlState.acquiring = false;
    renderControlState();
    void pollControlStatus();
  }
}

async function releaseControl(reason = "release", options = {}) {
  const sessionId = controlState.sessionId;
  const wasActive = controlState.sessionActive;
  stopControlHeartbeat();
  controlState.sessionActive = false;
  controlState.sessionId = "";
  controlState.transportAlive = false;
  controlState.emergency = Boolean(options.emergency);
  resetMotionState();
  renderControlState();
  if (!sessionId) return;
  try {
    if (controlState.transportMode === "mock") {
      await controlApi(`${CONTROL_API_BASE}/${reason === "estop" ? "estop" : "release"}`, {
        session_id: sessionId,
      });
    } else {
      await controlSocketApi(
        reason === "estop" ? "estop" : "release",
        { session_id: sessionId },
        5000,
      );
    }
    controlState.backendSessionActive = false;
    if (!options.silent && wasActive) {
      showToast(reason === "estop" ? "实车紧急停止已执行" : "实车控制已释放", reason === "estop");
    }
  } catch (error) {
    controlState.lastError = error.message;
    if (!options.silent) showToast(error.message, true);
  } finally {
    renderControlState();
    void pollControlStatus();
  }
}

function releaseControlOnUnload() {
  if (unloadReleaseSent || !controlState.sessionId || !controlState.token) return;
  unloadReleaseSent = true;
  const body = JSON.stringify({
    token: controlState.token,
    session_id: controlState.sessionId,
  });
  void fetch(`${CONTROL_API_BASE}/estop`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Control-Token": controlState.token,
    },
    body,
    keepalive: true,
  });
}

function canSendMotion() {
  return controlState.sessionActive && controlState.commandEnabled && !controlState.emergency;
}

function updateSteeringIntent() {
  const left = activeMotionControls.has("left");
  const right = activeMotionControls.has("right");
  const limit = Math.min(
    STEERING_COMMAND_DEG,
    Number(controlState.constraints.max_steering_deg) || STEERING_COMMAND_DEG,
  );
  controlState.steering = left === right ? 0 : left ? limit : -limit;
}

function driveAcceleratorTarget() {
  return Math.min(
    DRIVE_ACCELERATOR_PERCENT,
    Number(controlState.constraints.max_accelerator_percent) || DRIVE_ACCELERATOR_PERCENT,
  );
}

function advanceThrottleRamp() {
  if (
    !canSendMotion()
    || !activeMotionControls.has("throttle")
    || activeMotionControls.has("brake")
    || controlState.gear !== controlState.driveGear
  ) return;
  const target = driveAcceleratorTarget();
  if (controlState.accelerator >= target) return;
  controlState.brake = 0;
  controlState.accelerator = Math.min(
    target,
    controlState.accelerator + DRIVE_ACCELERATOR_RAMP_STEP_PERCENT,
  );
  renderControlState();
}

function applyLongitudinalIntent() {
  cancelGearShift();
  const throttle = activeMotionControls.has("throttle");
  const brake = activeMotionControls.has("brake");

  if (brake) {
    criticalControlCommands.length = 0;
    controlState.accelerator = 0;
    controlState.brake = 100;
    renderControlState();
    queueControlCommand(buildControlCommand(), { critical: true });
    return;
  }

  if (!throttle) {
    controlState.accelerator = 0;
    controlState.brake = controlState.gear === "P" ? 100 : 0;
    renderControlState();
    queueControlCommand();
    return;
  }

  const targetGear = controlState.driveGear;
  const applyThrottle = () => {
    if (
      !canSendMotion()
      || !activeMotionControls.has("throttle")
      || activeMotionControls.has("brake")
      || controlState.gear !== targetGear
    ) return;
    controlState.brake = 0;
    controlState.accelerator = Math.min(
      driveAcceleratorTarget(),
      DRIVE_ACCELERATOR_RAMP_STEP_PERCENT,
    );
    renderControlState();
    queueControlCommand();
  };

  if (controlState.gear !== targetGear) {
    controlState.gear = targetGear;
    controlState.accelerator = 0;
    controlState.brake = 100;
    renderControlState();
    criticalControlCommands.length = 0;
    queueControlCommand(buildControlCommand(), { critical: true });
    gearShiftTimer = window.setTimeout(() => {
      gearShiftTimer = null;
      applyThrottle();
    }, GEAR_SHIFT_SETTLE_MS);
    return;
  }

  applyThrottle();
}

function toggleDriveGear() {
  if (!canSendMotion()) return;
  cancelGearShift();
  activeMotionControls.delete("throttle");
  controlState.driveGear = controlState.driveGear === "D" ? "R" : "D";
  controlState.accelerator = 0;
  controlState.brake = 100;
  criticalControlCommands.length = 0;
  renderControlState();
  queueControlCommand(buildControlCommand(), { critical: true });
  gearShiftTimer = window.setTimeout(() => {
    gearShiftTimer = null;
    if (!canSendMotion()) return;
    controlState.gear = controlState.driveGear;
    controlState.accelerator = 0;
    controlState.brake = 100;
    renderControlState();
    queueControlCommand(buildControlCommand(), { critical: true });
  }, GEAR_SHIFT_SETTLE_MS);
}

function engageMotion(name) {
  if (!canSendMotion() || !["throttle", "brake", "left", "right"].includes(name)) return;
  activeMotionControls.add(name);
  if (name === "left" || name === "right") updateSteeringIntent();
  if (name === "throttle" || name === "brake") {
    applyLongitudinalIntent();
    return;
  }
  renderControlState();
  queueControlCommand();
}

function releaseMotion(name) {
  if (!activeMotionControls.delete(name)) return;
  if (name === "left" || name === "right") updateSteeringIntent();
  if (name === "throttle" || name === "brake") {
    applyLongitudinalIntent();
    return;
  }
  renderControlState();
  queueControlCommand();
}

function neutralizeMotion() {
  if (!canSendMotion()) return;
  const hadMotion = activeMotionControls.size > 0
    || controlState.accelerator > 0
    || controlState.steering !== 0;
  if (!hadMotion) return;
  cancelGearShift();
  activeMotionControls.clear();
  criticalControlCommands.length = 0;
  controlState.steering = 0;
  controlState.accelerator = 0;
  controlState.brake = controlState.gear === "P" ? 100 : 0;
  renderControlState();
  queueControlCommand();
}

function stopMotion() {
  if (!canSendMotion()) return;
  cancelGearShift();
  activeMotionControls.clear();
  criticalControlCommands.length = 0;
  controlState.gear = "P";
  controlState.steering = 0;
  controlState.accelerator = 0;
  controlState.brake = 100;
  renderControlState();
  queueControlCommand(buildControlCommand(), { critical: true });
}

function motionStateLabel() {
  const labels = [];
  if (activeMotionControls.has("brake")) labels.push("制动");
  else if (activeMotionControls.has("throttle")) labels.push(controlState.driveGear === "D" ? "前进" : "后退");
  if (activeMotionControls.has("left")) labels.push("左转");
  if (activeMotionControls.has("right")) labels.push("右转");
  if (labels.length) return labels.join(" · ");
  return controlState.brake >= 50 ? "停止" : "待命";
}

function renderControlState() {
  const selectedControlVehicle = activeVehicleId === CONTROL_VEHICLE_ID;
  const active = controlState.sessionActive && !controlState.emergency;
  const videoReady = videosReadyForControl();
  const vehicleReady = Boolean(controlState.vehicle?.ready_for_acquire);
  const occupied = controlState.backendSessionActive && !controlState.sessionActive;
  const canAcquire = selectedControlVehicle
    && controlState.backendOnline
    && vehicleReady
    && !occupied
    && !controlState.acquiring;
  const motionButtons = document.querySelectorAll("[data-motion]");

  elements.controlSessionButton.disabled = !(active || controlState.emergency || canAcquire) || controlState.acquiring;
  motionButtons.forEach((button) => {
    const name = button.dataset.motion;
    button.disabled = !active;
    if (name !== "stop") button.setAttribute("aria-pressed", String(activeMotionControls.has(name)));
    button.dataset.active = String(name === "stop"
      ? active && controlState.brake >= 50 && controlState.gear === "P"
      : activeMotionControls.has(name));
  });

  elements.gearToggleButton.disabled = !active;
  elements.gearToggleButton.dataset.gear = controlState.driveGear;
  elements.gearToggleButton.setAttribute(
    "aria-label",
    `切换为 ${controlState.driveGear === "D" ? "R" : "D"} 挡`,
  );
  elements.gearToggleLabel.textContent = `${controlState.driveGear} 挡`;
  elements.throttleButtonLabel.textContent = controlState.driveGear === "D" ? "前进" : "后退";
  elements.throttleButton.setAttribute("aria-label", controlState.driveGear === "D" ? "前进" : "后退");

  elements.motionCommandLabel.textContent = motionStateLabel();
  elements.motionCommandDetail.textContent = `${controlState.gear} · 转向 ${Math.round(controlState.steering)} deg`;
  elements.commandSequence.textContent = String(controlState.sequence % 10000).padStart(4, "0");

  elements.controlStatusBadge.className = "control-status-badge";
  elements.controlGate.dataset.state = "locked";
  if (controlState.emergency) {
    elements.controlStatusBadge.classList.add("is-emergency");
    elements.controlStatusText.textContent = "急停";
    elements.controlGate.dataset.state = "emergency";
    elements.controlGateLabel.textContent = "实车控制已急停";
    elements.controlGateDetail.textContent = controlState.lastError || "指令已归零，远控模式已退出";
  } else if (active) {
    elements.controlStatusBadge.classList.add("is-active");
    elements.controlStatusText.textContent = "控制中";
    elements.controlGate.dataset.state = "active";
    elements.controlGateLabel.textContent = "实车指令发送中";
    elements.controlGateDetail.textContent = "控制链路稳定，指令持续发送";
  } else if (controlState.acquiring) {
    elements.controlStatusBadge.classList.add("is-ready");
    elements.controlStatusText.textContent = "接管中";
    elements.controlGate.dataset.state = "ready";
    elements.controlGateLabel.textContent = "正在建立实车链路";
    elements.controlGateDetail.textContent = "正在校验 MQTT 控制与车端安全监护";
  } else if (canAcquire) {
    elements.controlStatusBadge.classList.add("is-ready");
    elements.controlStatusText.textContent = "可接管";
    elements.controlGate.dataset.state = "ready";
    elements.controlGateLabel.textContent = "安全预检通过";
    const speed = Number(controlState.vehicle?.speed_kph);
    const speedText = Number.isFinite(speed) ? `${speed.toFixed(1)} km/h` : "车速未知";
    elements.controlGateDetail.textContent = `BIT-0041 ${speedText}，当前 ${[...players.values()].filter((player) => player.state === "live").length}/4 路画面`;
  } else {
    elements.controlStatusText.textContent = "未接管";
    elements.controlGateLabel.textContent = selectedControlVehicle ? "控制暂不可用" : "当前车辆仅监看";
    elements.controlGateDetail.textContent = controlState.lastError
      || (!controlState.backendOnline ? "服务器控制网关不可用"
        : occupied ? "已有实车控制会话"
          : !vehicleReady ? (controlState.vehicle?.issues || ["车辆安全预检未通过"])[0]
            : "当前只允许控制 BIT-0041");
  }

  const sessionButtonLabel = elements.controlSessionButton.querySelector("span");
  sessionButtonLabel.textContent = controlState.emergency
    ? "确认复位"
    : controlState.acquiring ? "接管中"
      : active ? "释放车辆" : "接管车辆";

  const vehicle = controlState.vehicle;
  elements.telemetrySpeed.textContent = Number.isFinite(Number(vehicle?.speed_kph))
    ? Number(vehicle.speed_kph).toFixed(1) : "--";
  elements.telemetryGear.textContent = vehicle?.gear || "--";
  elements.telemetryTargetSteering.textContent = Number.isFinite(Number(vehicle?.remote_steering_deg))
    ? String(Math.round(Number(vehicle.remote_steering_deg))) : "--";
  if (vehicle?.local_telemetry) {
    if (vehicle.mqtt_vehicle_state_fresh) {
      const age = Number.isFinite(Number(vehicle.mqtt_vehicle_state_age_ms))
        ? `${Math.round(Number(vehicle.mqtt_vehicle_state_age_ms))}ms` : "实时";
      elements.telemetryCommandAck.textContent = `车端 MQTT 在线 · ${age}`;
      elements.telemetryCommandAck.dataset.state = "received";
    } else {
      const age = Number.isFinite(Number(vehicle.remote_command_age_ms))
        ? `${Math.round(Number(vehicle.remote_command_age_ms))}ms` : "实时";
      elements.telemetryCommandAck.textContent = vehicle.remote_mode_enabled
        ? `车端已收到 · ${age}` : `车端安全态 · ${age}`;
      elements.telemetryCommandAck.dataset.state = vehicle.remote_mode_enabled ? "received" : "safe";
    }
  } else {
    elements.telemetryCommandAck.textContent = "等待车端";
    elements.telemetryCommandAck.dataset.state = "idle";
  }
  elements.telemetrySteering.textContent = Number.isFinite(Number(vehicle?.front_steering_deg))
    ? String(Math.round(Number(vehicle.front_steering_deg))) : "--";
  elements.telemetryRearSteering.textContent = Number.isFinite(Number(vehicle?.rear_steering_deg))
    ? String(Math.round(Number(vehicle.rear_steering_deg))) : "--";
  elements.telemetrySoc.textContent = Number.isFinite(Number(vehicle?.battery_soc))
    ? String(Math.round(Number(vehicle.battery_soc))) : "--";

  let availability = "当前车辆仅支持视频";
  if (selectedControlVehicle) {
    availability = active ? "本页已持有实车控制权"
      : !controlState.backendOnline ? "服务器安全网关离线"
        : occupied ? "实车控制会话已占用"
          : !vehicleReady ? (controlState.vehicle?.issues || ["车辆安全预检未通过"])[0]
            : videoReady ? "车辆在线，可接管" : "车辆在线，无画面也可接管";
  }
  elements.controlAvailability.textContent = availability;

  elements.transportStatusRow.dataset.state = active ? "active" : controlState.backendOnline ? "ready" : "offline";
  const transportLabel = controlState.transportMode === "mqtt"
    ? "MQTT"
    : controlState.transportMode === "mock" ? "MOCK" : "ROS";
  elements.transportStatus.textContent = active
    ? `${transportLabel} ACTIVE`
    : controlState.backendOnline ? `${transportLabel} READY` : "OFFLINE";
}

function bindControlConsole() {
  elements.controlSessionButton.addEventListener("click", () => {
    if (controlState.sessionActive) {
      void releaseControl("release");
    } else {
      void acquireControl();
    }
  });

  elements.gearToggleButton.addEventListener("click", toggleDriveGear);

  document.querySelectorAll("[data-motion]").forEach((button) => {
    const name = button.dataset.motion;
    if (name === "stop") {
      button.addEventListener("click", stopMotion);
      return;
    }
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      button.setPointerCapture?.(event.pointerId);
      engageMotion(name);
    });
    const releasePointer = (event) => {
      if (event.pointerId !== undefined && button.hasPointerCapture?.(event.pointerId)) {
        button.releasePointerCapture(event.pointerId);
      }
      releaseMotion(name);
    };
    button.addEventListener("pointerup", releasePointer);
    button.addEventListener("pointercancel", releasePointer);
    button.addEventListener("lostpointercapture", () => releaseMotion(name));
  });

  const keyToMotion = {
    ArrowUp: "throttle",
    KeyW: "throttle",
    ArrowDown: "brake",
    KeyS: "brake",
    ArrowLeft: "left",
    KeyA: "left",
    ArrowRight: "right",
    KeyD: "right",
  };
  document.addEventListener("keydown", (event) => {
    if (!canSendMotion() || event.target.closest?.("input, select, textarea, [contenteditable='true']")) return;
    if (event.code === "Space") {
      event.preventDefault();
      if (!event.repeat) stopMotion();
      return;
    }
    if (event.code === "KeyR") {
      event.preventDefault();
      if (!event.repeat) toggleDriveGear();
      return;
    }
    const motion = keyToMotion[event.code];
    if (!motion) return;
    event.preventDefault();
    if (!event.repeat) engageMotion(motion);
  });
  document.addEventListener("keyup", (event) => {
    const motion = keyToMotion[event.code];
    if (!motion || !canSendMotion()) return;
    event.preventDefault();
    releaseMotion(motion);
  });
  window.addEventListener("blur", neutralizeMotion);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) neutralizeMotion();
  });
}

function showToast(message, isError = false) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast visible${isError ? " error" : ""}`;
  toastTimer = window.setTimeout(() => {
    elements.toast.className = "toast";
  }, 2600);
}

function loadInitialState() {
  const params = new URLSearchParams(window.location.search);
  const requestedVehicleId = params.get("vehicle");
  const requestedDeviceId = params.get("device_id");
  const savedVehicleId = localStorage.getItem("vehicleStreamViewer.vehicleId");
  const savedDeviceId = localStorage.getItem("vehicleStreamViewer.deviceId");
  const route = params.get("route") || localStorage.getItem("vehicleStreamViewer.route") || "auto";
  const options = [...elements.vehicleSelect.options];
  const selectedOption = options.find((option) => option.dataset.vehicleId === requestedVehicleId)
    || options.find((option) => option.value === requestedDeviceId)
    || options.find((option) => option.dataset.vehicleId === savedVehicleId)
    || options.find((option) => option.value === savedDeviceId)
    || options.find((option) => option.dataset.vehicleId === DEFAULT_VEHICLE_ID);
  if (selectedOption) {
    elements.vehicleSelect.value = selectedOption.value;
    activeDeviceId = selectedOption.value;
    activeVehicleId = selectedOption.dataset.vehicleId || DEFAULT_VEHICLE_ID;
  }
  activeRouteMode = PLAY_TARGETS[route] || route === "auto" ? route : "auto";
  elements.activeDeviceId.textContent = activeVehicleId;
  const routeInput = document.querySelector(`input[name="route"][value="${activeRouteMode}"]`);
  if (routeInput) routeInput.checked = true;
}

function initialize() {
  loadInitialState();
  bindControlConsole();
  bindTaskPlanner();
  document.querySelectorAll(".stream-tile").forEach((tile) => {
    const player = new StreamPlayer(tile);
    players.set(player.channel, player);
  });

  elements.form.addEventListener("submit", (event) => {
    event.preventDefault();
    void releaseControl("estop", { emergency: false, silent: true }).finally(connectAll);
  });
  elements.vehicleSelect.addEventListener("change", () => {
    void releaseControl("estop", { emergency: false, silent: true }).finally(connectAll);
  });
  elements.reconnectAllButton.addEventListener("click", () => {
    void releaseControl("estop", { emergency: false, silent: true }).finally(connectAll);
  });
  elements.copyLinkButton.addEventListener("click", copyCurrentLink);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && elements.videoGrid.classList.contains("has-focus")) {
      elements.videoGrid.classList.remove("has-focus");
      document.querySelectorAll(".stream-tile").forEach((tile) => tile.classList.remove("is-focused"));
    }
  });
  window.addEventListener("beforeunload", () => {
    window.clearInterval(taskPlanTimer);
    releaseControlOnUnload();
    players.forEach((player) => player.close(true));
  });
  window.addEventListener("pagehide", releaseControlOnUnload);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && [...players.values()].some((player) => player.state !== "live")) connectAll();
  });

  clockTimer = window.setInterval(() => {
    elements.localClock.textContent = new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date());
  }, 1000);
  aggregateTimer = window.setInterval(updateAggregateStatus, 1000);
  window.setTimeout(() => window.lucide?.createIcons(), 0);
  renderControlState();
  void bootstrapControl().finally(connectAll);
}

initialize();
