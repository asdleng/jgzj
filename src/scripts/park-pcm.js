(function () {
  const root = document.querySelector("[data-park-pcm]");
  if (!root) return;

  const AUTH_URL = "/api/auth/me";
  const CROWD_VEHICLES_URL = "/api/park-pcm/crowd/vehicles";
  const CROWD_SAMPLES_URL = "/api/park-pcm/crowd/samples";
  const CROWD_CAPTURE_URL = "/api/park-pcm/crowd/demo-capture";

  const statusEl = root.querySelector("[data-park-pcm-status]");
  const authEl = root.querySelector("[data-park-pcm-auth]");
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

  function setStatus(text, state) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.dataset.state = state || "idle";
  }

  function setBusy(nextBusy) {
    busy = Boolean(nextBusy);
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

  function patrolStateLabel(value) {
    return {
      patrol_active_moving: "巡逻移动",
      patrol_active_stopped: "巡逻暂停",
      patrol_task_stopped_or_waiting: "巡逻等待",
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

  function renderCrowdVehicles(data) {
    if (!crowdVehicleSelect) return;
    clearElement(crowdVehicleSelect);
    const vehicles = Array.isArray(data && data.vehicles) ? data.vehicles : [];
    if (!vehicles.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "暂无车辆";
      crowdVehicleSelect.appendChild(option);
      return;
    }
    vehicles.slice(0, 80).forEach((vehicle) => {
      const option = document.createElement("option");
      option.value = vehicle.vehicle_id || "";
      const age = vehicle.last_seen_age_s == null ? "-" : `${vehicle.last_seen_age_s}s`;
      option.textContent = `${vehicle.vehicle_id}${vehicle.fresh ? "" : " 过期"} · ${age} · 电量 ${formatNumber(vehicle.telemetry && vehicle.telemetry.battery_soc)}%`;
      if (!vehicle.fresh) option.disabled = true;
      crowdVehicleSelect.appendChild(option);
    });
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
    crowdLastEl.appendChild(textNode("strong", "", `${sample.vehicle_id || "-"} · ${formatTime(sample.collected_at)} · ${sample.frame_count || 0} 路`));
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
    clearElement(crowdSamplesEl);
    if (!crowdSamplesEl) return;
    const list = Array.isArray(samples) ? samples.filter((item) => !item.skipped) : [];
    if (!list.length) {
      crowdSamplesEl.appendChild(textNode("p", "park-pcm-empty", "等待巡逻采样图片。"));
      renderCrowdLast(null);
      return;
    }
    const latest = list[0];
    renderCrowdLast(latest);
    const frames = Array.isArray(latest.frames) ? latest.frames : [];
    frames.forEach((frame) => {
      const figure = document.createElement("figure");
      figure.className = "park-pcm-crowd-frame";
      const img = document.createElement("img");
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = `${latest.vehicle_id || ""} ${frame.camera_id || "camera"}`;
      img.src = frame.image_url || "";
      const caption = document.createElement("figcaption");
      caption.appendChild(textNode("span", "", frame.camera_id || "camera"));
      caption.appendChild(textNode("span", "", formatBytes(frame.image_size_bytes)));
      figure.appendChild(img);
      figure.appendChild(caption);
      crowdSamplesEl.appendChild(figure);
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

  async function loadCrowdSamples() {
    const data = await fetchJson(`${CROWD_SAMPLES_URL}?limit=12`);
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
      await Promise.all([loadCrowdVehicles(), loadCrowdSamples()]);
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
        authEl.textContent = error.message || "PCM 服务不可用。";
      }
    } finally {
      setBusy(false);
    }
  }

  if (crowdCaptureBtn) crowdCaptureBtn.addEventListener("click", captureCrowdDemo);
  void init();
})();
