(function () {
  const root = document.querySelector("[data-park-pcm]");
  if (!root) return;

  const AUTH_URL = "/api/auth/me";
  const STATUS_URL = "/api/park-pcm/status";
  const SNAPSHOT_URL = "/api/park-pcm/snapshot";
  const REPORT_URL = "/api/park-pcm/report/send";
  const CROWD_VEHICLES_URL = "/api/park-pcm/crowd/vehicles";
  const CROWD_SAMPLES_URL = "/api/park-pcm/crowd/samples";
  const CROWD_CAPTURE_URL = "/api/park-pcm/crowd/demo-capture";

  const statusEl = root.querySelector("[data-park-pcm-status]");
  const authEl = root.querySelector("[data-park-pcm-auth]");
  const refreshBtn = root.querySelector("[data-park-pcm-refresh]");
  const reportBtn = root.querySelector("[data-park-pcm-report]");
  const maxVehiclesInput = root.querySelector("[data-park-pcm-max-vehicles]");
  const includeObstacleInput = root.querySelector("[data-park-pcm-include-obstacle]");
  const includePerceptionInput = root.querySelector("[data-park-pcm-include-perception]");
  const reportStateEl = root.querySelector("[data-park-pcm-report-state]");
  const updatedEl = root.querySelector("[data-park-pcm-updated]");
  const elapsedEl = root.querySelector("[data-park-pcm-elapsed]");
  const alertsEl = root.querySelector("[data-park-pcm-alerts]");
  const rowsEl = root.querySelector("[data-park-pcm-rows]");
  const crowdVehicleSelect = root.querySelector("[data-park-pcm-crowd-vehicle]");
  const crowdDistanceInput = root.querySelector("[data-park-pcm-crowd-distance]");
  const crowdQualityInput = root.querySelector("[data-park-pcm-crowd-quality]");
  const crowdWidthInput = root.querySelector("[data-park-pcm-crowd-width]");
  const crowdCaptureBtn = root.querySelector("[data-park-pcm-crowd-capture]");
  const crowdStatusEl = root.querySelector("[data-park-pcm-crowd-status]");
  const crowdLastEl = root.querySelector("[data-park-pcm-crowd-last]");
  const crowdSamplesEl = root.querySelector("[data-park-pcm-crowd-samples]");
  const metricEls = new Map(
    Array.from(root.querySelectorAll("[data-park-pcm-metric]")).map((item) => [
      item.getAttribute("data-park-pcm-metric"),
      item
    ])
  );

  let authenticated = false;
  let busy = false;

  function setStatus(text, state) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.dataset.state = state || "idle";
  }

  function setBusy(nextBusy) {
    busy = Boolean(nextBusy);
    if (refreshBtn) refreshBtn.disabled = busy || !authenticated;
    if (reportBtn) reportBtn.disabled = busy || !authenticated;
    if (crowdCaptureBtn) crowdCaptureBtn.disabled = busy || !authenticated;
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

  function missionLabel(value) {
    return {
      patrol_active_moving: "巡逻移动",
      patrol_active_stopped: "巡逻停止",
      patrol_long_stop_or_completed: "长停/完成",
      charging_or_charging_area: "充电区",
      stopped_idle_or_long_stop: "空闲长停",
      stopped_unknown: "停止未知",
      moving_not_confirmed_patrol: "移动未确认",
      unknown: "未知"
    }[value] || value || "未知";
  }

  function trafficLabel(value) {
    return {
      clear: "通畅",
      watch: "关注",
      crowded: "拥挤",
      blocked: "阻塞",
      unknown: "未知"
    }[value] || value || "未知";
  }

  function healthLabel(value) {
    return {
      ok: "正常",
      warn: "告警",
      error: "严重",
      stale: "心跳过期"
    }[value] || value || "未知";
  }

  function toneForTraffic(level) {
    if (level === "blocked") return "error";
    if (level === "crowded" || level === "watch") return "warn";
    if (level === "clear") return "ok";
    return "idle";
  }

  function setMetric(name, value) {
    const el = metricEls.get(name);
    if (el) el.textContent = formatNumber(value);
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

  function pill(text, tone) {
    const el = textNode("span", "park-pcm-pill", text);
    if (tone) el.dataset.tone = tone;
    return el;
  }

  function cell(main, sub) {
    const el = document.createElement("div");
    el.className = "park-pcm-cell";
    el.appendChild(textNode("span", "park-pcm-cell-main", main));
    if (sub) el.appendChild(textNode("span", "park-pcm-cell-sub", sub));
    return el;
  }

  function renderAlerts(alerts) {
    clearElement(alertsEl);
    if (!alertsEl) return;
    if (!Array.isArray(alerts) || !alerts.length) {
      alertsEl.appendChild(textNode("p", "park-pcm-empty", "当前暂无重点告警。"));
      return;
    }
    alerts.slice(0, 12).forEach((alert) => {
      const item = document.createElement("article");
      item.className = "park-pcm-alert";
      item.dataset.severity = alert.severity || "warn";
      item.appendChild(textNode("strong", "", alert.vehicle_id || "-"));
      item.appendChild(textNode("span", "", alert.message || "-"));
      item.appendChild(pill(healthLabel(alert.severity), alert.severity === "error" ? "error" : alert.severity === "warn" ? "warn" : ""));
      alertsEl.appendChild(item);
    });
  }

  function sortRows(rows) {
    const severityOrder = { error: 0, stale: 1, warn: 2, ok: 3 };
    const rank = (severity) =>
      Object.prototype.hasOwnProperty.call(severityOrder, severity) ? severityOrder[severity] : 9;
    return rows.slice().sort((left, right) => {
      const severityDelta =
        rank(left.health && left.health.severity) -
        rank(right.health && right.health.severity);
      if (severityDelta) return severityDelta;
      return Number(right.traffic && right.traffic.pcm_score) - Number(left.traffic && left.traffic.pcm_score);
    });
  }

  function renderRows(rows) {
    clearElement(rowsEl);
    if (!rowsEl) return;
    if (!Array.isArray(rows) || !rows.length) {
      rowsEl.appendChild(textNode("p", "park-pcm-empty", "没有车辆数据。"));
      return;
    }
    sortRows(rows).forEach((row) => {
      const item = document.createElement("article");
      item.className = "park-pcm-row";
      item.dataset.severity = row.health && row.health.severity ? row.health.severity : "ok";

      const ageText =
        row.last_seen_age_s == null
          ? "未知"
          : row.last_seen_age_s < 60
            ? `${row.last_seen_age_s}s`
            : `${Math.round(row.last_seen_age_s / 60)}min`;
      const route = row.route || {};
      const mission = row.mission || {};
      const traffic = row.traffic || {};
      const health = row.health || {};
      const telemetry = row.telemetry || {};
      const keyData = [
        `电量 ${formatNumber(telemetry.battery_soc)}%`,
        `速度 ${formatNumber(telemetry.speed_kph)} km/h`,
        `障碍 ${formatNumber(traffic.object_count)}`,
        `路线 ${formatNumber(route.route_count)}`
      ].join(" · ");

      item.appendChild(cell(row.vehicle_id || "-", row.plate_number || ""));
      item.appendChild(cell(row.fresh ? "新鲜" : "过期", ageText));
      item.appendChild(cell(missionLabel(mission.state), (mission.reasons || []).slice(0, 2).join(" · ")));
      const trafficCell = document.createElement("div");
      trafficCell.className = "park-pcm-cell";
      trafficCell.appendChild(pill(`${trafficLabel(traffic.level)} ${formatNumber(traffic.pcm_score, "0")}`, toneForTraffic(traffic.level)));
      trafficCell.appendChild(textNode("span", "park-pcm-cell-sub", (traffic.risk_factors || []).slice(0, 2).join(" · ")));
      item.appendChild(trafficCell);
      item.appendChild(cell(healthLabel(health.severity), (health.issues || []).slice(0, 2).join(" · ")));
      item.appendChild(cell(keyData, route.route_location || route.current_route_id || ""));
      rowsEl.appendChild(item);
    });
  }

  function renderSnapshot(snapshot) {
    const counts = snapshot && snapshot.counts ? snapshot.counts : {};
    const health = counts.health || {};
    const traffic = counts.traffic || {};
    setMetric("total", counts.total || 0);
    setMetric("fresh", counts.fresh || 0);
    setMetric("warnings", (health.warn || 0) + (health.error || 0) + (health.stale || 0));
    setMetric("crowded", (traffic.crowded || 0) + (traffic.blocked || 0));
    if (updatedEl) updatedEl.textContent = snapshot ? `更新 ${formatTime(snapshot.generated_at)}` : "暂无快照";
    if (elapsedEl) elapsedEl.textContent = snapshot ? `${formatNumber(snapshot.elapsed_ms, "0")} ms` : "-";
    renderAlerts(snapshot && snapshot.alerts);
    renderRows(snapshot && snapshot.rows);
  }

  function renderReportState(status) {
    if (!reportStateEl) return;
    const report = status && status.report ? status.report : {};
    if (!report.enabled) {
      reportStateEl.textContent = "小时报告已关闭";
      return;
    }
    if (!report.webhook_configured) {
      reportStateEl.textContent = "飞书 webhook 未配置";
      return;
    }
    const state = report.state || {};
    const result = state.last_result || {};
    if (result.sent) {
      reportStateEl.textContent = `上次发送 ${formatTime(state.last_attempt_at)}`;
    } else if (result.error) {
      reportStateEl.textContent = `上次发送失败：${result.error}`;
    } else {
      reportStateEl.textContent = "小时报告等待首次发送";
    }
  }

  async function loadStatus() {
    const status = await fetchJson(STATUS_URL);
    renderReportState(status);
    if (status.snapshot) {
      try {
        renderSnapshot(await fetchJson(SNAPSHOT_URL));
      } catch (_error) {
        renderSnapshot(null);
      }
    }
    return status;
  }

  function snapshotPayload() {
    return {
      max_vehicles: Number(maxVehiclesInput && maxVehiclesInput.value) || 200,
      include_obstacle: includeObstacleInput ? includeObstacleInput.checked : true,
      include_perception: includePerceptionInput ? includePerceptionInput.checked : false
    };
  }

  async function refreshSnapshot() {
    if (!authenticated || busy) return;
    setBusy(true);
    setStatus("采集中", "warn");
    try {
      const snapshot = await fetchJson(SNAPSHOT_URL, {
        method: "POST",
        body: snapshotPayload()
      });
      renderSnapshot(snapshot);
      await loadStatus();
      setStatus("已更新", "ok");
    } catch (error) {
      setStatus("失败", "error");
      if (authEl) {
        authEl.hidden = false;
        authEl.textContent = error.message || "PCM 快照生成失败。";
      }
    } finally {
      setBusy(false);
    }
  }

  async function sendReport() {
    if (!authenticated || busy) return;
    setBusy(true);
    setStatus("发送中", "warn");
    try {
      const result = await fetchJson(REPORT_URL, {
        method: "POST",
        body: { ...snapshotPayload(), use_last: true }
      });
      if (result.report && result.report.skipped) {
        setStatus("未配置", "warn");
      } else {
        setStatus("已发送", "ok");
      }
      await loadStatus();
    } catch (error) {
      setStatus("发送失败", "error");
      if (authEl) {
        authEl.hidden = false;
        authEl.textContent = error.message || "飞书报告发送失败。";
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
      const status = await loadStatus();
      if (!status.snapshot) {
        await refreshSnapshot();
      } else {
        setStatus("已就绪", "ok");
      }
    } catch (error) {
      setStatus("不可用", "error");
      if (authEl) {
        authEl.hidden = false;
        authEl.textContent = error.message || "PCM 服务不可用。";
      }
    } finally {
      setBusy(false);
    }
  }

  if (refreshBtn) refreshBtn.addEventListener("click", refreshSnapshot);
  if (reportBtn) reportBtn.addEventListener("click", sendReport);
  void init();
})();
