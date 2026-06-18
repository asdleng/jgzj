(function () {
  const root = document.querySelector("[data-park-pcm]");
  if (!root) return;

  const AUTH_URL = "/api/auth/me";
  const CROWD_VEHICLES_URL = "/api/park-pcm/crowd/vehicles";
  const CROWD_SAMPLES_URL = "/api/park-pcm/crowd/samples";
  const CROWD_PATROLS_URL = "/api/park-pcm/crowd/patrols";
  const CROWD_UPLOADS_URL = "/api/park-pcm/crowd/uploads";
  const PATROL_FLOW_COLLECTORS_URL = "/api/park-pcm/crowd/patrol-flow/collectors";
  const PATROL_FLOW_FLUSH_URL = "/api/park-pcm/crowd/patrol-flow/flush";
  const CROWD_SAMPLE_SOURCE = "all";
  const PATROL_MAX_VEHICLES = 24;
  const PATROL_REFRESH_MS = 90 * 1000;
  const CROWD_SAMPLE_INITIAL_LIMIT = 1000;
  const CROWD_SAMPLE_VEHICLE_LIMIT = 500;
  const HEATMAP_RADIUS_PX = 36;
  const HEATMAP_PIXEL_BUCKET = 18;
  const HEATMAP_TIME_ZONE = "Asia/Shanghai";
  const DAY_MS = 24 * 60 * 60 * 1000;

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
  const heatmapDateEl = root.querySelector("[data-park-pcm-heatmap-date]");
  const heatmapDateRangeEl = root.querySelector("[data-park-pcm-heatmap-date-range]");
  const heatmapDateLabelEl = root.querySelector("[data-park-pcm-heatmap-date-label]");
  const heatmapDateSummaryEl = root.querySelector("[data-park-pcm-heatmap-date-summary]");
  const heatmapDateTicksEl = root.querySelector("[data-park-pcm-heatmap-date-ticks]");
  const uploadStatusEl = root.querySelector("[data-park-pcm-upload-status]");
  const uploadSummaryEl = root.querySelector("[data-park-pcm-upload-summary]");
  const uploadListEl = root.querySelector("[data-park-pcm-upload-list]");
  const collectorRefreshBtn = root.querySelector("[data-park-pcm-collector-refresh]");
  const collectorSummaryEl = root.querySelector("[data-park-pcm-collector-summary]");
  const collectorListEl = root.querySelector("[data-park-pcm-collector-list]");
  const vehicleSummaryEl = root.querySelector("[data-park-pcm-vehicle-summary]");
  const vehicleDetailEl = root.querySelector("[data-park-pcm-vehicle-detail]");
  const trackSamplesEl = root.querySelector("[data-park-pcm-track-samples]");
  const trackDetailEl = root.querySelector("[data-park-pcm-track-detail]");
  const crowdVehicleSelect = root.querySelector("[data-park-pcm-crowd-vehicle]");
  const crowdStatusEl = root.querySelector("[data-park-pcm-crowd-status]");
  const crowdLastEl = root.querySelector("[data-park-pcm-crowd-last]");
  const crowdSamplesEl = root.querySelector("[data-park-pcm-crowd-samples]");
  const imagePreview = {
    overlay: null,
    image: null,
    title: null,
    meta: null
  };

  let authenticated = false;
  let busy = false;
  let patrolRefreshInFlight = false;
  let amapLoadPromise = null;
  let amapMap = null;
  let amapHeatmap = null;
  let customHeatmapCanvas = null;
  let customHeatmapRaf = 0;
  let amapControlsReady = false;
  let amapHeatmapEventsBound = false;
  let amapLastHeatData = [];
  let amapLastHeatMax = 0;
  let heatmapRefreshTimer = null;
  let selectedVehicleId = "";
  let selectedSampleId = "";
  let selectedDayKey = "";
  let sampleLoadRequestId = 0;
  let latestCrowdSamples = [];
  let knownHeatmapDayBounds = {
    min_ms: null,
    max_ms: null
  };
  const dayKeyFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: HEATMAP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const dayLabelFormatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: HEATMAP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short"
  });

  function setStatus(text, state) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.dataset.state = state || "idle";
  }

  function setBusy(nextBusy) {
    busy = Boolean(nextBusy);
    if (patrolRefreshBtn) patrolRefreshBtn.disabled = busy || !authenticated;
    if (collectorRefreshBtn) collectorRefreshBtn.disabled = busy || !authenticated;
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

  function sampleTimeMs(sample) {
    const direct = Number(sample && sample.collected_at_ms);
    if (Number.isFinite(direct)) return direct;
    const parsed = Date.parse(sample && sample.collected_at || "");
    return Number.isFinite(parsed) ? parsed : null;
  }

  function dayKeyFromDate(date) {
    const parts = dayKeyFormatter.formatToParts(date).reduce((acc, part) => {
      if (part.type !== "literal") acc[part.type] = part.value;
      return acc;
    }, {});
    return parts.year && parts.month && parts.day ? `${parts.year}-${parts.month}-${parts.day}` : "";
  }

  function sampleDayKey(sample) {
    const ms = sampleTimeMs(sample);
    return ms == null ? "" : dayKeyFromDate(new Date(ms));
  }

  function dayKeyToMs(key) {
    const match = String(key || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return Number.isFinite(ms) ? ms : null;
  }

  function dayKeyFromMs(ms) {
    if (!Number.isFinite(Number(ms))) return "";
    return new Date(Number(ms)).toISOString().slice(0, 10);
  }

  function updateKnownHeatmapDayBounds(samples) {
    (Array.isArray(samples) ? samples : []).forEach((sample) => {
      const key = sampleDayKey(sample);
      const ms = dayKeyToMs(key);
      if (ms == null) return;
      knownHeatmapDayBounds.min_ms =
        knownHeatmapDayBounds.min_ms == null ? ms : Math.min(knownHeatmapDayBounds.min_ms, ms);
      knownHeatmapDayBounds.max_ms =
        knownHeatmapDayBounds.max_ms == null ? ms : Math.max(knownHeatmapDayBounds.max_ms, ms);
    });
  }

  function formatDayLabel(key) {
    const ms = dayKeyToMs(key);
    if (ms == null) return key || "-";
    return dayLabelFormatter.format(new Date(ms));
  }

  function formatDayShortLabel(key) {
    const match = String(key || "").match(/^\d{4}-(\d{2})-(\d{2})$/);
    return match ? `${match[1]}/${match[2]}` : key || "-";
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

  function formatBoolean(value) {
    return value === true ? "是" : value === false ? "否" : "-";
  }

  const PEOPLE_FEATURE_LABELS = {
    age_groups: {
      child: "疑似儿童",
      teenager: "疑似青少年",
      adult: "成年人",
      elderly: "疑似老人",
      unknown: "年龄不明"
    },
    mobility_types: {
      wheelchair: "轮椅",
      cane_or_walker: "拐杖/助行器",
      stroller: "婴儿车",
      assisted_walking: "被搀扶",
      slow_moving: "行动缓慢",
      large_baggage: "大件行李",
      unknown: "行动特征不明"
    },
    role_types: {
      visitor: "访客/游客",
      staff: "工作人员",
      security: "安保",
      cleaner: "保洁",
      delivery: "配送",
      maintenance: "维修/施工",
      vendor: "商户/摊位",
      student: "学生",
      volunteer: "志愿者",
      unknown: "角色不明"
    },
    activity_types: {
      walking: "通行",
      standing: "停留",
      sitting_or_resting: "休息",
      queueing: "排队",
      gathering: "聚集",
      running: "跑步",
      cycling: "骑行",
      scooter_or_ebike: "电动车/滑板车",
      taking_photo: "拍照",
      shopping_or_pickup: "购物/取餐",
      crossing_road: "过路",
      near_water: "靠近水域",
      unknown: "行为不明"
    },
    group_types: {
      single: "单人",
      pair: "双人",
      family_parent_child: "亲子/家庭",
      elderly_group: "老人结伴",
      student_group: "学生队伍",
      tour_group: "游客团体",
      work_crew: "工作班组",
      queue: "队列",
      gathering: "聚集"
    },
    risk_hints: {
      child_near_road: "儿童靠近车道",
      child_near_water: "儿童靠近水域",
      elderly_needs_care: "老人照护提示",
      mobility_barrier: "通行障碍",
      crowd_gathering: "人群聚集",
      queue_congestion: "排队拥堵",
      mixed_traffic: "人车混行",
      night_stay: "夜间停留",
      construction_near_people: "施工区有人"
    }
  };
  const PEOPLE_CHART_COLORS = ["#22c55e", "#38bdf8", "#f59e0b", "#f43f5e", "#a78bfa", "#14b8a6", "#eab308", "#fb7185"];
  const ATTENTION_SIGNAL_LABELS = {
    child: "疑似儿童",
    elderly: "疑似老人",
    wheelchair: "轮椅",
    cane_or_walker: "拐杖/助行器",
    stroller: "婴儿车",
    assisted_walking: "被搀扶",
    slow_moving: "行动缓慢"
  };

  function featureCountMap(sample, key) {
    const analysis = sample && sample.analysis && typeof sample.analysis === "object" ? sample.analysis : {};
    return analysis[key] && typeof analysis[key] === "object" ? analysis[key] : {};
  }

  function formatFeatureMap(map, labels, options) {
    const opts = options || {};
    const rows = Object.entries(map || {})
      .map(([key, value]) => ({ key, count: Number(value) }))
      .filter((item) => Number.isFinite(item.count) && item.count > 0)
      .sort((left, right) => right.count - left.count);
    const filtered = opts.includeUnknown ? rows : rows.filter((item) => item.key !== "unknown");
    return filtered
      .slice(0, opts.limit || 4)
      .map((item) => `${labels[item.key] || item.key} ${item.count}`)
      .join(" · ");
  }

  function chartFeatureRows(map, labels, options) {
    const opts = options || {};
    const rows = Object.entries(map || {})
      .map(([key, value]) => ({ key, label: labels[key] || key, count: Number(value) }))
      .filter((item) => Number.isFinite(item.count) && item.count > 0)
      .filter((item) => opts.includeUnknown || item.key !== "unknown")
      .sort((left, right) => right.count - left.count);
    return rows.slice(0, opts.limit || 6);
  }

  function formatRiskHints(risks) {
    return (Array.isArray(risks) ? risks : [])
      .slice()
      .sort((left, right) => (Number(right.count) || 1) - (Number(left.count) || 1))
      .slice(0, 3)
      .map((risk) => {
        const type = String(risk && risk.type || "").trim();
        if (!type) return "";
        const label = PEOPLE_FEATURE_LABELS.risk_hints[type] || type;
        const count = Number(risk && risk.count);
        return Number.isFinite(count) && count > 1 ? `${label} ${count}` : label;
      })
      .filter(Boolean)
      .join(" · ");
  }

  function aggregateFeatureMap(samples, key) {
    const totals = {};
    (Array.isArray(samples) ? samples : []).forEach((sample) => {
      Object.entries(featureCountMap(sample, key)).forEach(([featureKey, value]) => {
        const count = Number(value);
        if (!Number.isFinite(count) || count <= 0) return;
        totals[featureKey] = (totals[featureKey] || 0) + count;
      });
    });
    return totals;
  }

  function aggregateRiskHints(samples) {
    const totals = {};
    (Array.isArray(samples) ? samples : []).forEach((sample) => {
      const risks = sample && sample.analysis && Array.isArray(sample.analysis.risk_hints) ? sample.analysis.risk_hints : [];
      risks.forEach((risk) => {
        const type = String(risk && risk.type || "").trim();
        if (!type) return;
        totals[type] = (totals[type] || 0) + (Number(risk.count) || 1);
      });
    });
    return Object.entries(totals)
      .map(([type, count]) => ({ type, count }))
      .sort((left, right) => right.count - left.count);
  }

  function addPositiveCount(target, key, value) {
    const count = Number(value);
    if (!Number.isFinite(count) || count <= 0) return;
    target[key] = (target[key] || 0) + count;
  }

  function attentionSignalMap(sample) {
    const result = {};
    const ageMap = featureCountMap(sample, "age_groups");
    const mobilityMap = featureCountMap(sample, "mobility_types");
    addPositiveCount(result, "child", ageMap.child);
    addPositiveCount(result, "elderly", ageMap.elderly);
    ["wheelchair", "cane_or_walker", "stroller", "assisted_walking", "slow_moving"].forEach((key) => {
      addPositiveCount(result, key, mobilityMap[key]);
    });
    return result;
  }

  function aggregateAttentionSignals(samples) {
    const totals = {};
    (Array.isArray(samples) ? samples : []).forEach((sample) => {
      Object.entries(attentionSignalMap(sample)).forEach(([key, value]) => addPositiveCount(totals, key, value));
    });
    return totals;
  }

  function chartFill(rows) {
    const total = rows.reduce((sum, item) => sum + item.count, 0);
    if (!total) return "conic-gradient(rgba(148, 163, 184, 0.2) 0 360deg)";
    let cursor = 0;
    const stops = rows.map((item, index) => {
      const start = cursor;
      const end = cursor + (item.count / total) * 360;
      cursor = end;
      const color = item.color || PEOPLE_CHART_COLORS[index % PEOPLE_CHART_COLORS.length];
      return `${color} ${start.toFixed(2)}deg ${end.toFixed(2)}deg`;
    });
    return `conic-gradient(${stops.join(", ")})`;
  }

  function formatTrendTime(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return "-";
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(date);
  }

  function formatTrendDuration(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value <= 0) return "-";
    const minutes = value / 60000;
    if (minutes < 60) return `${Math.max(1, Math.round(minutes))} 分钟`;
    const hours = minutes / 60;
    if (hours < 24) return `${hours >= 10 ? Math.round(hours) : hours.toFixed(1)} 小时`;
    const days = hours / 24;
    return `${days >= 10 ? Math.round(days) : days.toFixed(1)} 天`;
  }

  function formatTrendNumber(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return "-";
    return Math.abs(num - Math.round(num)) < 0.05 ? String(Math.round(num)) : num.toFixed(1);
  }

  function svgNode(tag, attrs, text) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.entries(attrs || {}).forEach(([key, value]) => {
      el.setAttribute(key, String(value));
    });
    if (text != null) el.textContent = String(text);
    return el;
  }

  function buildPeopleTrend(samples) {
    const raw = (Array.isArray(samples) ? samples : [])
      .map((sample) => {
        const ts = Date.parse(sample && sample.collected_at || "");
        const people = Number(samplePeopleCount(sample));
        if (!Number.isFinite(ts) || !Number.isFinite(people)) return null;
        return {
          ts,
          people,
          sample
        };
      })
      .filter(Boolean)
      .sort((left, right) => left.ts - right.ts);
    const totalPeople = raw.reduce((sum, point) => sum + point.people, 0);
    const startTs = raw[0] ? raw[0].ts : null;
    const endTs = raw[raw.length - 1] ? raw[raw.length - 1].ts : null;
    let points = [];
    if (raw.length <= 36) {
      points = raw.map((point) => ({
        ts: point.ts,
        start_ts: point.ts,
        end_ts: point.ts,
        avg_people: point.people,
        max_people: point.people,
        sample_count: 1
      }));
    } else if (startTs != null && endTs != null) {
      const bucketCount = Math.min(36, Math.max(8, Math.ceil(raw.length / 3)));
      const span = Math.max(1, endTs - startTs);
      const interval = Math.max(1, span / bucketCount);
      const buckets = [];
      raw.forEach((point) => {
        const index = Math.min(bucketCount - 1, Math.floor((point.ts - startTs) / interval));
        const bucket = buckets[index] || {
          start_ts: point.ts,
          end_ts: point.ts,
          sum_people: 0,
          sum_ts: 0,
          sample_count: 0,
          max_people: 0
        };
        bucket.start_ts = Math.min(bucket.start_ts, point.ts);
        bucket.end_ts = Math.max(bucket.end_ts, point.ts);
        bucket.sum_people += point.people;
        bucket.sum_ts += point.ts;
        bucket.sample_count += 1;
        bucket.max_people = Math.max(bucket.max_people, point.people);
        buckets[index] = bucket;
      });
      points = buckets.filter(Boolean).map((bucket) => ({
        ts: bucket.sum_ts / bucket.sample_count,
        start_ts: bucket.start_ts,
        end_ts: bucket.end_ts,
        avg_people: bucket.sum_people / bucket.sample_count,
        max_people: bucket.max_people,
        sample_count: bucket.sample_count
      }));
    }
    const peakPoint = points.reduce((best, point) => {
      if (!best) return point;
      if (point.max_people !== best.max_people) return point.max_people > best.max_people ? point : best;
      return point.ts > best.ts ? point : best;
    }, null);
    const latest = raw[raw.length - 1] || null;
    return {
      raw_count: raw.length,
      total_people: totalPeople,
      avg_people: raw.length ? totalPeople / raw.length : null,
      peak_people: peakPoint ? peakPoint.max_people : null,
      latest_people: latest ? latest.people : null,
      start_ts: startTs,
      end_ts: endTs,
      span_ms: startTs != null && endTs != null ? endTs - startTs : null,
      points,
      peak_point: peakPoint
    };
  }

  function createTrendMetric(label, value, detail) {
    const metric = document.createElement("div");
    metric.className = "park-pcm-trend-metric";
    metric.appendChild(textNode("span", "", label));
    metric.appendChild(textNode("strong", "", value));
    if (detail) metric.appendChild(textNode("em", "", detail));
    return metric;
  }

  function createPeopleTrendChart(samples) {
    const trend = buildPeopleTrend(samples);
    const card = document.createElement("article");
    card.className = "park-pcm-chart-card park-pcm-chart-card--trend";

    const head = document.createElement("div");
    head.className = "park-pcm-chart-head";
    head.appendChild(textNode("h3", "", "人流时间趋势"));
    head.appendChild(textNode("span", "", trend.raw_count ? `${trend.raw_count} 条识别样本` : "等待人数识别"));

    const body = document.createElement("div");
    body.className = "park-pcm-trend-layout";
    if (trend.points.length < 2) {
      body.appendChild(
        textNode(
          "p",
          "park-pcm-chart-empty park-pcm-trend-empty",
          trend.raw_count ? "有效时间点不足，等待更多采集样本后生成趋势线。" : "等待 Qwen3.6 回填人数后生成趋势线。"
        )
      );
    } else {
      const width = 720;
      const height = 260;
      const padding = { top: 18, right: 24, bottom: 42, left: 50 };
      const plotWidth = width - padding.left - padding.right;
      const plotHeight = height - padding.top - padding.bottom;
      const baseY = padding.top + plotHeight;
      const yMax = Math.max(1, Math.ceil(Math.max(...trend.points.map((point) => Math.max(point.avg_people, point.max_people))) * 1.15));
      const start = trend.start_ts;
      const end = trend.end_ts;
      const span = Math.max(0, Number(end) - Number(start));
      const xFor = (point, index) => {
        if (span > 0) return padding.left + ((point.ts - start) / span) * plotWidth;
        return padding.left + (index / Math.max(1, trend.points.length - 1)) * plotWidth;
      };
      const yFor = (value) => padding.top + (1 - Math.min(1, Math.max(0, Number(value) / yMax))) * plotHeight;
      const coordinates = trend.points.map((point, index) => ({
        x: xFor(point, index),
        y: yFor(point.avg_people),
        point
      }));
      const areaPath = [
        `M ${coordinates[0].x.toFixed(2)} ${baseY.toFixed(2)}`,
        ...coordinates.map((item) => `L ${item.x.toFixed(2)} ${item.y.toFixed(2)}`),
        `L ${coordinates[coordinates.length - 1].x.toFixed(2)} ${baseY.toFixed(2)}`,
        "Z"
      ].join(" ");
      const linePoints = coordinates.map((item) => `${item.x.toFixed(2)},${item.y.toFixed(2)}`).join(" ");

      const plot = document.createElement("div");
      plot.className = "park-pcm-trend-plot";
      const svg = svgNode("svg", {
        class: "park-pcm-trend-svg",
        viewBox: `0 0 ${width} ${height}`,
        role: "img",
        "aria-label": "人流时间趋势折线图"
      });
      [0, 0.5, 1].forEach((ratio) => {
        const y = padding.top + (1 - ratio) * plotHeight;
        const value = yMax * ratio;
        svg.appendChild(svgNode("line", {
          class: "park-pcm-trend-grid",
          x1: padding.left,
          y1: y,
          x2: width - padding.right,
          y2: y
        }));
        svg.appendChild(svgNode("text", {
          class: "park-pcm-trend-axis-label",
          x: padding.left - 10,
          y: y + 4,
          "text-anchor": "end"
        }, formatTrendNumber(value)));
      });
      svg.appendChild(svgNode("path", {
        class: "park-pcm-trend-area",
        d: areaPath
      }));
      svg.appendChild(svgNode("polyline", {
        class: "park-pcm-trend-line",
        points: linePoints
      }));
      coordinates.forEach((item) => {
        const isPeak = trend.peak_point && item.point.ts === trend.peak_point.ts && item.point.max_people === trend.peak_point.max_people;
        const dot = svgNode("circle", {
          class: isPeak ? "park-pcm-trend-dot park-pcm-trend-dot--peak" : "park-pcm-trend-dot",
          cx: item.x,
          cy: item.y,
          r: isPeak ? 4.8 : 3.4
        });
        dot.appendChild(
          svgNode(
            "title",
            {},
            `${formatTrendTime(item.point.start_ts)} · 平均 ${formatTrendNumber(item.point.avg_people)} 人 · 峰值 ${formatTrendNumber(item.point.max_people)} 人 · ${item.point.sample_count} 条`
          )
        );
        svg.appendChild(dot);
      });
      svg.appendChild(svgNode("text", {
        class: "park-pcm-trend-axis-label",
        x: padding.left,
        y: height - 12,
        "text-anchor": "start"
      }, formatTrendTime(start)));
      svg.appendChild(svgNode("text", {
        class: "park-pcm-trend-axis-label",
        x: width - padding.right,
        y: height - 12,
        "text-anchor": "end"
      }, formatTrendTime(end)));
      plot.appendChild(svg);
      body.appendChild(plot);
    }

    const metrics = document.createElement("div");
    metrics.className = "park-pcm-trend-metrics";
    metrics.appendChild(createTrendMetric("平均人流", trend.avg_people == null ? "-" : `${formatTrendNumber(trend.avg_people)} 人`, "单次采样"));
    metrics.appendChild(createTrendMetric("峰值人流", trend.peak_people == null ? "-" : `${formatTrendNumber(trend.peak_people)} 人`, trend.peak_point ? formatTrendTime(trend.peak_point.ts) : ""));
    metrics.appendChild(createTrendMetric("最近人流", trend.latest_people == null ? "-" : `${formatTrendNumber(trend.latest_people)} 人`, trend.end_ts ? formatTrendTime(trend.end_ts) : ""));
    metrics.appendChild(createTrendMetric("时间跨度", formatTrendDuration(trend.span_ms), trend.start_ts && trend.end_ts ? `${formatTrendTime(trend.start_ts)} - ${formatTrendTime(trend.end_ts)}` : ""));
    body.appendChild(metrics);

    card.appendChild(head);
    card.appendChild(body);
    return card;
  }

  function createPeopleDonutChart(title, subtitle, map, labels, options) {
    const opts = options || {};
    const rows = chartFeatureRows(map, labels, opts).map((item, index) => ({
      ...item,
      color: PEOPLE_CHART_COLORS[index % PEOPLE_CHART_COLORS.length]
    }));
    const total = rows.reduce((sum, item) => sum + item.count, 0);
    const card = document.createElement("article");
    card.className = "park-pcm-chart-card";

    const head = document.createElement("div");
    head.className = "park-pcm-chart-head";
    head.appendChild(textNode("h3", "", title));
    head.appendChild(textNode("span", "", total ? `${total} ${opts.unitLabel || "项画像"}` : (opts.emptyStateLabel || "等待画像")));

    const body = document.createElement("div");
    body.className = "park-pcm-chart-body";
    const donut = document.createElement("div");
    donut.className = "park-pcm-donut";
    donut.style.setProperty("--chart-fill", chartFill(rows));
    const core = document.createElement("div");
    core.className = "park-pcm-donut-core";
    core.appendChild(textNode("strong", "", total ? String(total) : "-"));
    core.appendChild(textNode("span", "", subtitle));
    donut.appendChild(core);

    const legend = document.createElement("div");
    legend.className = "park-pcm-chart-legend";
    if (!rows.length) {
      legend.appendChild(textNode("p", "park-pcm-chart-empty", opts.emptyText || "Qwen3.6 正在回填画像。"));
    } else {
      rows.forEach((item) => {
        const percent = total ? Math.round((item.count / total) * 100) : 0;
        const row = document.createElement("div");
        row.className = "park-pcm-chart-row";
        const label = document.createElement("span");
        const swatch = document.createElement("i");
        swatch.style.background = item.color;
        label.appendChild(swatch);
        label.appendChild(textNode("em", "", item.label));
        const value = textNode("strong", "", `${item.count} · ${percent}%`);
        const bar = document.createElement("b");
        bar.style.width = `${Math.max(4, percent)}%`;
        row.appendChild(label);
        row.appendChild(value);
        row.appendChild(bar);
        legend.appendChild(row);
      });
    }
    body.appendChild(donut);
    body.appendChild(legend);
    card.appendChild(head);
    card.appendChild(body);
    return card;
  }

  function createRiskChart(risks) {
    const rows = (Array.isArray(risks) ? risks : []).slice(0, 6);
    const maxCount = rows.reduce((max, item) => Math.max(max, Number(item.count) || 1), 1);
    const card = document.createElement("article");
    card.className = "park-pcm-chart-card park-pcm-chart-card--wide";
    const head = document.createElement("div");
    head.className = "park-pcm-chart-head";
    head.appendChild(textNode("h3", "", "风险候选"));
    head.appendChild(textNode("span", "", rows.length ? `${rows.length} 类提示` : "暂无风险"));
    const list = document.createElement("div");
    list.className = "park-pcm-risk-list";
    if (!rows.length) {
      list.appendChild(textNode("p", "park-pcm-chart-empty", "当前样本未聚合出风险候选。"));
    } else {
      rows.forEach((risk, index) => {
        const type = String(risk && risk.type || "").trim();
        const count = Number(risk && risk.count) || 1;
        const row = document.createElement("div");
        row.className = "park-pcm-risk-row";
        const label = textNode("span", "", PEOPLE_FEATURE_LABELS.risk_hints[type] || type);
        const value = textNode("strong", "", String(count));
        const bar = document.createElement("b");
        bar.style.width = `${Math.max(8, Math.round((count / maxCount) * 100))}%`;
        bar.style.background = PEOPLE_CHART_COLORS[(index + 3) % PEOPLE_CHART_COLORS.length];
        row.appendChild(label);
        row.appendChild(value);
        row.appendChild(bar);
        list.appendChild(row);
      });
    }
    card.appendChild(head);
    card.appendChild(list);
    return card;
  }

  function renderPeopleCharts(container, rows) {
    if (!container) return;
    const chartGrid = document.createElement("div");
    chartGrid.className = "park-pcm-chart-grid";
    chartGrid.appendChild(createPeopleTrendChart(rows));
    chartGrid.appendChild(
      createPeopleDonutChart("关照线索", "线索", aggregateAttentionSignals(rows), ATTENTION_SIGNAL_LABELS, {
        limit: 5,
        includeUnknown: false,
        unitLabel: "项线索",
        emptyStateLabel: "暂无线索",
        emptyText: "暂无儿童、老人或通行辅助等明显线索。"
      })
    );
    chartGrid.appendChild(
      createPeopleDonutChart("角色类型", "角色", aggregateFeatureMap(rows, "role_types"), PEOPLE_FEATURE_LABELS.role_types, {
        limit: 5,
        includeUnknown: false,
        emptyText: "暂未识别出工作人员、访客等角色。"
      })
    );
    chartGrid.appendChild(
      createPeopleDonutChart("行为状态", "行为", aggregateFeatureMap(rows, "activity_types"), PEOPLE_FEATURE_LABELS.activity_types, {
        limit: 6,
        includeUnknown: false,
        emptyText: "暂未识别出通行、停留、骑行等行为。"
      })
    );
    chartGrid.appendChild(
      createPeopleDonutChart("通行辅助", "辅助", aggregateFeatureMap(rows, "mobility_types"), PEOPLE_FEATURE_LABELS.mobility_types, {
        limit: 5,
        includeUnknown: false,
        emptyText: "暂未识别出轮椅、拐杖、婴儿车等特征。"
      })
    );
    chartGrid.appendChild(createRiskChart(aggregateRiskHints(rows)));
    container.appendChild(chartGrid);
  }

  function sampleFeatureSummary(sample) {
    const parts = [
      formatFeatureMap(attentionSignalMap(sample), ATTENTION_SIGNAL_LABELS, { limit: 3 }),
      formatFeatureMap(featureCountMap(sample, "mobility_types"), PEOPLE_FEATURE_LABELS.mobility_types, { limit: 2 }),
      formatFeatureMap(featureCountMap(sample, "role_types"), PEOPLE_FEATURE_LABELS.role_types, { limit: 2 }),
      formatFeatureMap(featureCountMap(sample, "activity_types"), PEOPLE_FEATURE_LABELS.activity_types, { limit: 3 }),
      formatRiskHints(sample && sample.analysis && sample.analysis.risk_hints)
    ].filter(Boolean);
    return parts.length ? parts.join(" · ") : "人群画像待分析";
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

  function setUploadStatus(text) {
    if (uploadStatusEl) uploadStatusEl.textContent = text;
  }

  function closeImagePreview() {
    if (!imagePreview.overlay) return;
    imagePreview.overlay.hidden = true;
    imagePreview.image.removeAttribute("src");
    imagePreview.image.alt = "";
    imagePreview.title.textContent = "";
    imagePreview.meta.textContent = "";
  }

  function ensureImagePreview() {
    if (imagePreview.overlay) return imagePreview.overlay;
    const overlay = document.createElement("div");
    overlay.className = "park-pcm-image-preview";
    overlay.hidden = true;
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "图片预览");

    const frame = document.createElement("div");
    frame.className = "park-pcm-image-preview-frame";

    const toolbar = document.createElement("div");
    toolbar.className = "park-pcm-image-preview-toolbar";
    const copy = document.createElement("div");
    copy.appendChild(textNode("strong", "", ""));
    copy.appendChild(textNode("span", "", ""));
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "park-pcm-image-preview-close";
    closeBtn.setAttribute("aria-label", "关闭图片预览");
    closeBtn.textContent = "×";

    const img = document.createElement("img");
    img.alt = "";

    toolbar.appendChild(copy);
    toolbar.appendChild(closeBtn);
    frame.appendChild(toolbar);
    frame.appendChild(img);
    overlay.appendChild(frame);
    document.body.appendChild(overlay);

    imagePreview.overlay = overlay;
    imagePreview.image = img;
    imagePreview.title = copy.querySelector("strong");
    imagePreview.meta = copy.querySelector("span");

    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeImagePreview();
    });
    closeBtn.addEventListener("click", closeImagePreview);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeImagePreview();
    });
    return overlay;
  }

  function openImagePreview(frame, sample) {
    const imageUrl = String(frame && frame.image_url || "").trim();
    if (!imageUrl) return;
    ensureImagePreview();
    const peopleText = frame.analysis && frame.analysis.people_count != null ? `${frame.analysis.people_count} 人` : "人数待识别";
    imagePreview.image.src = imageUrl;
    imagePreview.image.alt = `${sample && sample.vehicle_id || ""} ${frame.camera_id || "camera"}`;
    imagePreview.title.textContent = `${sample && sample.vehicle_id || "-"} · ${frame.camera_id || "camera"}`;
    imagePreview.meta.textContent = `${formatTime(sample && sample.collected_at)} · ${formatBytes(frame.image_size_bytes)} · ${peopleText}`;
    imagePreview.overlay.hidden = false;
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
    if (customHeatmapCanvas) {
      const ctx = customHeatmapCanvas.getContext("2d");
      if (ctx) ctx.clearRect(0, 0, customHeatmapCanvas.width, customHeatmapCanvas.height);
      customHeatmapCanvas.hidden = true;
    }
    amapLastHeatData = [];
    amapLastHeatMax = 0;
    if (customHeatmapRaf) {
      window.cancelAnimationFrame(customHeatmapRaf);
      customHeatmapRaf = 0;
    }
    if (heatmapRefreshTimer) {
      window.clearTimeout(heatmapRefreshTimer);
      heatmapRefreshTimer = null;
    }
    if (heatLegendEl) heatLegendEl.hidden = true;
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

  function selectedVehicleCrowdSamples() {
    const rows = latestCrowdSamples.filter((sample) => samplePosition(sample));
    if (!selectedVehicleId) return [];
    return rows.filter((sample) => sample.vehicle_id === selectedVehicleId);
  }

  function buildHeatmapDayAxis(samples) {
    const stats = new Map();
    (Array.isArray(samples) ? samples : []).forEach((sample) => {
      const key = sampleDayKey(sample);
      const ms = dayKeyToMs(key);
      if (!key || ms == null) return;
      const current = stats.get(key) || {
        key,
        ms,
        sample_count: 0,
        recognized_count: 0,
        people_total: 0,
        max_people: 0
      };
      const peopleCount = samplePeopleCount(sample);
      current.sample_count += 1;
      if (peopleCount != null) {
        current.recognized_count += 1;
        current.people_total += Number(peopleCount);
        current.max_people = Math.max(current.max_people, Number(peopleCount));
      }
      stats.set(key, current);
    });
    const dataDays = [...stats.values()].sort((left, right) => left.ms - right.ms);
    const minMs = knownHeatmapDayBounds.min_ms ?? (dataDays[0] && dataDays[0].ms);
    const maxMs = knownHeatmapDayBounds.max_ms ?? (dataDays[dataDays.length - 1] && dataDays[dataDays.length - 1].ms);
    if (minMs == null || maxMs == null) {
      return {
        days: [],
        latest_key: ""
      };
    }
    const days = [];
    for (let ms = minMs; ms <= maxMs; ms += DAY_MS) {
      const key = dayKeyFromMs(ms);
      days.push(
        stats.get(key) || {
          key,
          ms,
          sample_count: 0,
          recognized_count: 0,
          people_total: 0,
          max_people: 0
        }
      );
    }
    return {
      days,
      latest_key: dayKeyFromMs(maxMs)
    };
  }

  function dayAxisForSelectedVehicle() {
    return buildHeatmapDayAxis(selectedVehicleCrowdSamples());
  }

  function ensureSelectedDay(axis) {
    const days = Array.isArray(axis && axis.days) ? axis.days : [];
    if (!days.length) {
      selectedDayKey = "";
      return "";
    }
    if (!selectedDayKey || !days.some((day) => day.key === selectedDayKey)) {
      selectedDayKey = axis.latest_key || days[days.length - 1].key;
    }
    return selectedDayKey;
  }

  function renderHeatmapDateControl() {
    if (!heatmapDateEl) return;
    const axis = dayAxisForSelectedVehicle();
    const days = axis.days || [];
    const key = ensureSelectedDay(axis);
    if (!days.length || !key) {
      heatmapDateEl.hidden = true;
      if (heatmapDateTicksEl) clearElement(heatmapDateTicksEl);
      return;
    }
    const activeIndex = Math.max(0, days.findIndex((day) => day.key === key));
    const active = days[activeIndex] || days[days.length - 1];
    heatmapDateEl.hidden = false;
    if (heatmapDateLabelEl) heatmapDateLabelEl.textContent = formatDayLabel(active.key);
    if (heatmapDateSummaryEl) {
      heatmapDateSummaryEl.textContent = active.sample_count
        ? `当天 ${active.sample_count} 条 · 已识别 ${active.recognized_count} 条/${active.people_total} 人 · 峰值 ${active.max_people} 人`
        : "当天暂无采集点。";
    }
    if (heatmapDateRangeEl) {
      heatmapDateRangeEl.min = "0";
      heatmapDateRangeEl.max = String(Math.max(0, days.length - 1));
      heatmapDateRangeEl.step = "1";
      heatmapDateRangeEl.value = String(activeIndex);
      heatmapDateRangeEl.disabled = days.length < 2;
      heatmapDateRangeEl.setAttribute("aria-valuetext", formatDayLabel(active.key));
    }
    if (heatmapDateTicksEl) {
      clearElement(heatmapDateTicksEl);
      heatmapDateTicksEl.style.gridTemplateColumns = `repeat(${days.length}, minmax(0, 1fr))`;
      heatmapDateTicksEl.style.minWidth = `${Math.max(320, days.length * 58)}px`;
      days.forEach((day) => {
        const tick = document.createElement("span");
        tick.className = "park-pcm-date-tick";
        tick.dataset.active = day.key === active.key ? "true" : "false";
        tick.dataset.hasData = day.sample_count > 0 ? "true" : "false";
        tick.title = `${formatDayLabel(day.key)} · ${day.sample_count} 条`;
        tick.textContent = formatDayShortLabel(day.key);
        heatmapDateTicksEl.appendChild(tick);
      });
    }
  }

  function visibleCrowdSamples() {
    const rows = selectedVehicleCrowdSamples();
    if (!selectedDayKey) return rows;
    return rows.filter((sample) => sampleDayKey(sample) === selectedDayKey);
  }

  function ensureVehicleOption(vehicleId) {
    if (!crowdVehicleSelect || !vehicleId) return;
    const value = String(vehicleId);
    if ([...crowdVehicleSelect.options].some((option) => option.value === value)) return;
    const option = document.createElement("option");
    option.value = value;
    option.textContent = `${value} · 人流样本`;
    crowdVehicleSelect.appendChild(option);
  }

  function syncSampleVehicleOptions(samples) {
    if (!crowdVehicleSelect) return;
    const vehicles = new Map();
    (Array.isArray(samples) ? samples : []).forEach((sample, index) => {
      const vehicleId = String(sample && sample.vehicle_id || "").trim();
      if (!vehicleId || !samplePosition(sample)) return;
      const current = vehicles.get(vehicleId) || {
        vehicle_id: vehicleId,
        sample_count: 0,
        max_people: 0,
        latest_rank: Number.MAX_SAFE_INTEGER
      };
      const peopleCount = Number(samplePeopleCount(sample));
      current.sample_count += 1;
      if (Number.isFinite(peopleCount)) current.max_people = Math.max(current.max_people, peopleCount);
      current.latest_rank = Math.min(current.latest_rank, index);
      vehicles.set(vehicleId, current);
    });
    [...vehicles.values()]
      .sort((left, right) => left.vehicle_id.localeCompare(right.vehicle_id, "zh-CN"))
      .forEach((vehicle) => {
        if ([...crowdVehicleSelect.options].some((option) => option.value === vehicle.vehicle_id)) return;
        const option = document.createElement("option");
        option.value = vehicle.vehicle_id;
        option.textContent = `${vehicle.vehicle_id} · ${vehicle.sample_count} 条 · 峰值 ${vehicle.max_people} 人`;
        crowdVehicleSelect.appendChild(option);
      });
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
      grid.appendChild(textNode("p", "park-pcm-empty", "该记录没有图片。"));
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
      const previewBtn = document.createElement("button");
      previewBtn.type = "button";
      previewBtn.className = "park-pcm-frame-preview-button";
      previewBtn.setAttribute("aria-label", "放大查看图片");
      previewBtn.addEventListener("click", () => openImagePreview(frame, sample));
      const caption = document.createElement("figcaption");
      caption.appendChild(textNode("span", "", frame.camera_id || "camera"));
      caption.appendChild(textNode("span", "", `${formatBytes(frame.image_size_bytes)} · ${frame.analysis && frame.analysis.people_count != null ? `${frame.analysis.people_count}人` : "待识别"}`));
      previewBtn.appendChild(img);
      figure.appendChild(previewBtn);
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
        container.appendChild(textNode("p", "park-pcm-empty", "选择热力记录查看图片。"));
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
            `坐标 ${formatCoord(position.gaode_longitude)}, ${formatCoord(position.gaode_latitude)}`,
            `${sample.frame_count || 0} 路`,
            formatBytes(sample.total_image_bytes),
            `巡逻 ${patrolStateLabel(sample.patrol_state && sample.patrol_state.state)}`
          ].join(" · ")
        )
      );
      head.appendChild(textNode("span", "", sampleFeatureSummary(sample)));
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
      trackSamplesEl.appendChild(
        textNode(
          "p",
          "park-pcm-empty",
          selectedVehicleId
            ? `${selectedVehicleId} · ${selectedDayKey ? formatDayLabel(selectedDayKey) : "当前日期"} 暂无人流记录。`
            : "请先选择一台车辆。"
        )
      );
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
          setMapStatus(`热力刷新失败：${error.message || "-"}`);
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
          selectedVehicleId
            ? `${selectedVehicleId} · ${selectedDayKey ? formatDayLabel(selectedDayKey) : "当前日期"} 暂无人流记录。`
            : "请选择一台车辆查看人流热力。"
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
    const attentionSummary = formatFeatureMap(aggregateAttentionSignals(rows), ATTENTION_SIGNAL_LABELS, { limit: 4 });
    const mobilitySummary = formatFeatureMap(aggregateFeatureMap(rows, "mobility_types"), PEOPLE_FEATURE_LABELS.mobility_types, { limit: 3 });
    const roleSummary = formatFeatureMap(aggregateFeatureMap(rows, "role_types"), PEOPLE_FEATURE_LABELS.role_types, { limit: 3 });
    const activitySummary = formatFeatureMap(aggregateFeatureMap(rows, "activity_types"), PEOPLE_FEATURE_LABELS.activity_types, { limit: 4 });
    const riskSummary = formatRiskHints(aggregateRiskHints(rows));
    const grid = document.createElement("div");
    grid.className = "park-pcm-detail-grid";
    grid.appendChild(detailCell("人流记录", `${rows.length} 条`));
    grid.appendChild(detailCell("四路图片", `${frames} 张 · ${formatBytes(bytes)}`));
    grid.appendChild(detailCell("已识别人数", counts.length ? `${totalPeople} 人 · ${counts.length}/${rows.length} 条` : "等待识别"));
    grid.appendChild(detailCell("热力记录", positiveCounts.length ? `${positiveCounts.length} 条 · 峰值 ${maxPeople} 人` : "暂无人群热区"));
    grid.appendChild(detailCell("关照线索", attentionSummary || "暂无明显线索"));
    grid.appendChild(detailCell("角色/通行", [roleSummary, mobilitySummary].filter(Boolean).join(" · ") || "等待画像"));
    grid.appendChild(detailCell("行为/风险", [activitySummary, riskSummary].filter(Boolean).join(" · ") || "等待画像"));
    grid.appendChild(detailCell("最近采集", `${latest.vehicle_id || "-"} · ${formatTime(latest.collected_at)}`));
    grid.appendChild(detailCell("上传时间段", `${formatTime(oldest.collected_at)} - ${formatTime(latest.collected_at)}`));
    grid.appendChild(detailCell("最近坐标", `${formatCoord(position.gaode_longitude)}, ${formatCoord(position.gaode_latitude)}`));
    vehicleDetailEl.appendChild(grid);
    renderPeopleCharts(vehicleDetailEl, rows);
    vehicleDetailEl.appendChild(
      textNode(
        "p",
        "park-pcm-detail-note",
        "热力图按车辆定位、人群识别结果和采样位置聚合；关照线索只用于运营提醒，不做精确年龄、人脸身份或个人属性识别。"
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
            latest ? `最近 ${formatTime(latest.collected_at)} ${formatBytes(latest.total_image_bytes)}` : "暂无上传"
          ].join(" · ")
        )
      );
      item.addEventListener("click", () => {
        void selectVehicle(row.vehicle_id).catch((error) => {
          setMapStatus(`人流数据加载失败：${error.message || "-"}`);
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
    selectedDayKey = "";
    if (crowdVehicleSelect && crowdVehicleSelect.value !== nextVehicleId) {
      crowdVehicleSelect.value = nextVehicleId;
    }
    if (!nextVehicleId) {
      setVehicleSummary("请先选择一台车辆查看人流热力。");
      return loadCrowdSamples("");
    }
    setVehicleSummary(`${nextVehicleId} 人流数据加载中。`);
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

  function refreshPeopleHeatmap(resetMap) {
    void resetMap;
    drawCustomHeatmap();
  }

  function schedulePeopleHeatmapRefresh(delayMs, resetMap) {
    if (!amapMap || !amapLastHeatData.length) return;
    if (heatmapRefreshTimer) window.clearTimeout(heatmapRefreshTimer);
    heatmapRefreshTimer = window.setTimeout(() => {
      heatmapRefreshTimer = null;
      refreshPeopleHeatmap(resetMap);
    }, Number.isFinite(Number(delayMs)) ? Number(delayMs) : 80);
  }

  function bindAmapHeatmapRefreshEvents() {
    if (!amapMap || amapHeatmapEventsBound || typeof amapMap.on !== "function") return;
    ["moveend", "zoomend", "resize", "complete"].forEach((eventName) => {
      amapMap.on(eventName, () => schedulePeopleHeatmapRefresh(50, true));
    });
    amapHeatmapEventsBound = true;
  }

  function waitForAmapComplete(timeoutMs) {
    if (!amapMap || typeof amapMap.on !== "function") return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (typeof amapMap.off === "function") amapMap.off("complete", finish);
        resolve();
      };
      amapMap.on("complete", finish);
      window.setTimeout(finish, Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : 600);
    });
  }

  function ensureCustomHeatmapCanvas() {
    if (customHeatmapCanvas || !mapEl) return customHeatmapCanvas;
    const canvas = document.createElement("canvas");
    canvas.className = "park-pcm-custom-heatmap";
    canvas.setAttribute("aria-hidden", "true");
    canvas.hidden = true;
    mapEl.appendChild(canvas);
    customHeatmapCanvas = canvas;
    return customHeatmapCanvas;
  }

  function heatmapContainerPoint(lng, lat) {
    if (!amapMap || typeof amapMap.lngLatToContainer !== "function") return null;
    let pixel = null;
    try {
      pixel = amapMap.lngLatToContainer([Number(lng), Number(lat)]);
    } catch (_error) {
      try {
        const AMap = window["AMap"];
        pixel = AMap && AMap.LngLat ? amapMap.lngLatToContainer(new AMap.LngLat(Number(lng), Number(lat))) : null;
      } catch (_innerError) {
        pixel = null;
      }
    }
    if (!pixel) return null;
    const x = Number(pixel.x ?? (typeof pixel.getX === "function" ? pixel.getX() : pixel[0]));
    const y = Number(pixel.y ?? (typeof pixel.getY === "function" ? pixel.getY() : pixel[1]));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  }

  function projectedHeatBuckets() {
    const buckets = new Map();
    const maxCount = Math.max(1, Number(amapLastHeatMax) || 1);
    amapLastHeatData.forEach((point) => {
      const projected = heatmapContainerPoint(point.lng, point.lat);
      const count = Number(point.count);
      if (!projected || !Number.isFinite(count) || count <= 0) return;
      const bucketX = Math.round(projected.x / HEATMAP_PIXEL_BUCKET);
      const bucketY = Math.round(projected.y / HEATMAP_PIXEL_BUCKET);
      const key = `${bucketX}:${bucketY}`;
      const current = buckets.get(key) || {
        x: 0,
        y: 0,
        count: 0,
        weight: 0
      };
      current.x += projected.x * count;
      current.y += projected.y * count;
      current.count += count;
      current.weight += Math.min(1, count / maxCount);
      buckets.set(key, current);
    });
    return [...buckets.values()].map((bucket) => ({
      x: bucket.x / bucket.count,
      y: bucket.y / bucket.count,
      count: bucket.count,
      weight: bucket.weight
    }));
  }

  function drawCustomHeatmapNow() {
    const canvas = ensureCustomHeatmapCanvas();
    if (!canvas || !mapEl || !amapMap || !amapLastHeatData.length) return;
    const rect = mapEl.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.globalCompositeOperation = "source-over";
    const maxCount = Math.max(1, Number(amapLastHeatMax) || 1);
    projectedHeatBuckets().forEach((point) => {
      const density = Math.max(Number(point.count) / maxCount, Number(point.weight) || 0);
      const radius = HEATMAP_RADIUS_PX * (0.85 + Math.min(1.35, density) * 0.55);
      if (
        point.x < -radius ||
        point.y < -radius ||
        point.x > width + radius ||
        point.y > height + radius
      ) {
        return;
      }
      const strength = Math.max(0.16, Math.min(1, density));
      const gradient = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius);
      gradient.addColorStop(0, `rgba(239, 68, 68, ${0.24 + strength * 0.2})`);
      gradient.addColorStop(0.26, `rgba(249, 115, 22, ${0.18 + strength * 0.16})`);
      gradient.addColorStop(0.54, `rgba(250, 204, 21, ${0.11 + strength * 0.12})`);
      gradient.addColorStop(0.78, `rgba(34, 197, 94, ${0.05 + strength * 0.08})`);
      gradient.addColorStop(1, "rgba(34, 197, 94, 0)");
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalCompositeOperation = "source-over";
    canvas.hidden = false;
  }

  function drawCustomHeatmap() {
    if (customHeatmapRaf) window.cancelAnimationFrame(customHeatmapRaf);
    customHeatmapRaf = window.requestAnimationFrame(() => {
      customHeatmapRaf = 0;
      drawCustomHeatmapNow();
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
      heat_count: peopleCount == null ? 1 : Math.max(1, peopleCount),
      collected_at: sample.collected_at,
      sample
    };
  }

  function heatWeight(point) {
    const count = Number(point && point.heat_count);
    return Number.isFinite(count) && count > 0 ? count : null;
  }

  function chooseDefaultVehicleId(samples) {
    const scores = new Map();
    (Array.isArray(samples) ? samples : []).forEach((sample, index) => {
      const vehicleId = String(sample && sample.vehicle_id || "").trim();
      if (!vehicleId || !samplePosition(sample)) return;
      const peopleCount = Number(samplePeopleCount(sample));
      const item = scores.get(vehicleId) || {
        vehicle_id: vehicleId,
        positive_points: 0,
        total_people: 0,
        latest_rank: Number.MAX_SAFE_INTEGER
      };
      if (Number.isFinite(peopleCount) && peopleCount > 0) {
        item.positive_points += 1;
        item.total_people += peopleCount;
      }
      item.latest_rank = Math.min(item.latest_rank, index);
      scores.set(vehicleId, item);
    });
    const ranked = [...scores.values()].sort((left, right) => {
      if (right.positive_points !== left.positive_points) return right.positive_points - left.positive_points;
      if (right.total_people !== left.total_people) return right.total_people - left.total_people;
      return left.latest_rank - right.latest_rank;
    });
    return ranked[0] && ranked[0].vehicle_id ? ranked[0].vehicle_id : "";
  }

  function heatDataFromPoints(points) {
    return points
      .map((point) => ({
        lng: Number(point.longitude),
        lat: Number(point.latitude),
        count: heatWeight(point)
      }))
      .filter((point) => Number.isFinite(point.lng) && Number.isFinite(point.lat) && Number.isFinite(point.count) && point.count > 0);
  }

  async function renderPeopleHeatmap(AMap, samplePoints) {
    void AMap;
    const heatData = heatDataFromPoints(samplePoints);
    if (!heatData.length) {
      if (heatLegendEl) heatLegendEl.hidden = true;
      return {
        count: 0,
        max: 0
      };
    }
    const maxCount = Math.max(...heatData.map((point) => point.count), 1);
    amapLastHeatData = heatData;
    amapLastHeatMax = maxCount;
    drawCustomHeatmap();
    schedulePeopleHeatmapRefresh(160, true);
    if (heatLegendEl) heatLegendEl.hidden = false;
    return {
      count: heatData.length,
      max: maxCount
    };
  }

  function fitHeatmapView(AMap, samplePoints, center) {
    if (!amapMap || !Array.isArray(samplePoints) || samplePoints.length < 2) {
      amapMap.setZoomAndCenter(17, center);
      return;
    }
    const lngs = samplePoints.map((point) => Number(point.longitude)).filter(Number.isFinite);
    const lats = samplePoints.map((point) => Number(point.latitude)).filter(Number.isFinite);
    if (!lngs.length || !lats.length) {
      amapMap.setZoomAndCenter(17, center);
      return;
    }
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    if (Math.abs(maxLng - minLng) < 0.00005 && Math.abs(maxLat - minLat) < 0.00005) {
      amapMap.setZoomAndCenter(17, center);
      return;
    }
    try {
      if (AMap.Bounds && typeof amapMap.setBounds === "function") {
        const southWest = AMap.LngLat ? new AMap.LngLat(minLng, minLat) : [minLng, minLat];
        const northEast = AMap.LngLat ? new AMap.LngLat(maxLng, maxLat) : [maxLng, maxLat];
        amapMap.setBounds(new AMap.Bounds(southWest, northEast), false, [56, 56, 56, 56]);
        return;
      }
    } catch (_error) {
      // Fall back to a focused heatmap view below.
    }
    amapMap.setZoomAndCenter(16, center);
  }

  async function renderTrackMap(options) {
    const opts = options || {};
    const viewVehicleId = selectedVehicleId;
    const viewDayKey = selectedDayKey;
    const samples = visibleCrowdSamples();
    const samplePoints = samples
      .map((sample) => sampleMapPoint(sample))
      .filter(Boolean)
      .sort((left, right) => Date.parse(left.collected_at || "") - Date.parse(right.collected_at || ""));
    if (!selectedVehicleId) {
      renderTrackSamples();
      clearMapOverlays();
      setMapStatus("请选择车辆");
      setMapFallback("请选择一台车辆查看人流热力图", false);
      return;
    }
    if (!samplePoints.length) {
      renderTrackSamples();
      clearMapOverlays();
      setMapStatus("暂无人流数据");
      setMapFallback(
        selectedVehicleId
          ? `${selectedVehicleId} · ${selectedDayKey ? formatDayLabel(selectedDayKey) : "当前日期"} 暂无人流定位样本`
          : "暂无人流定位样本",
        false
      );
      return;
    }
    try {
      const AMap = await loadAmap();
      if (selectedVehicleId !== viewVehicleId || selectedDayKey !== viewDayKey) return;
      setMapFallback("", true);
      const focus = samplePoints.find((point) => point.sample_id === opts.focus_sample_id) || samplePoints[samplePoints.length - 1];
      const center = [Number(focus.longitude), Number(focus.latitude)];
      const mapWasCreated = !amapMap;
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
      if (mapWasCreated) {
        await waitForAmapComplete(800);
        if (selectedVehicleId !== viewVehicleId || selectedDayKey !== viewDayKey) return;
      }
      await ensureAmapControls(AMap);
      if (selectedVehicleId !== viewVehicleId || selectedDayKey !== viewDayKey) return;
      enableMapInteraction();
      bindAmapHeatmapRefreshEvents();
      clearMapOverlays();
      fitHeatmapView(AMap, samplePoints, center);
      const heatStats = await renderPeopleHeatmap(AMap, samplePoints);
      [120, 420].forEach((delayMs) => {
        window.setTimeout(() => {
          if (selectedVehicleId !== viewVehicleId || selectedDayKey !== viewDayKey || !amapMap || !amapLastHeatData.length) return;
          fitHeatmapView(AMap, samplePoints, center);
          drawCustomHeatmap();
        }, delayMs);
      });
      enableMapInteraction();
      setMapStatus(
        heatStats.count
          ? `${viewVehicleId} · ${formatDayLabel(viewDayKey)} 记录 ${samplePoints.length} · 热力点 ${heatStats.count} · 峰值 ${heatStats.max} 人`
          : `${viewVehicleId} · ${formatDayLabel(viewDayKey)} 记录 ${samplePoints.length} · 暂无可用热力`
      );
    } catch (error) {
      setMapStatus("热力地图加载失败");
      setMapFallback(`热力地图加载失败：${error.message || "amap_failed"}`, false);
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
        setMapFallback("选择一台车辆后显示人流热力图", false);
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
      setVehicleSummary(selectedVehicleId ? `${selectedVehicleId} · 人流热力数据` : "暂无车辆列表。");
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

  function renderUploadStatus(data) {
    const state = data && data.state ? data.state : {};
    const storage = data && data.storage ? data.storage : {};
    const sampleIndex = data && data.sample_index ? data.sample_index : {};
    const vehicleUpload = sampleIndex.vehicle_upload || {};
    const sessions = Array.isArray(state.recent_sessions) ? state.recent_sessions : [];
    clearElement(uploadSummaryEl);
    if (uploadSummaryEl) {
      [
        `Session ${formatNumber(state.session_count, "0")} / 成功 ${formatNumber(state.imported_count, "0")}`,
        `车端 ${formatNumber(vehicleUpload.sample_count, "0")} 条 / ${formatNumber(vehicleUpload.frame_count, "0")} 张`,
        `存储 ${formatBytes(storage.total_bytes)} / ${formatBytes(storage.max_storage_bytes)}`,
        `可接收 ${formatBoolean(data && data.can_accept_upload)}`
      ].forEach((text) => uploadSummaryEl.appendChild(textNode("span", "", text)));
    }
    clearElement(uploadListEl);
    if (uploadListEl) {
      if (!sessions.length) {
        const latest = vehicleUpload.latest_sample;
        uploadListEl.appendChild(
          textNode(
            "p",
            "park-pcm-empty",
            latest
              ? `最近记录 ${latest.vehicle_id || "-"} · ${formatTime(latest.collected_at)}。`
              : "还没有同步记录。"
          )
        );
      } else {
        sessions.slice(0, 6).forEach((session) => {
          const row = document.createElement("article");
          row.className = "park-pcm-upload-row";
          row.appendChild(
            textNode(
              "strong",
              "",
              `${session.session_id || "-"} · ${session.status || "-"} · ${formatTime(session.imported_at || session.failed_at || session.received_at)}`
            )
          );
          row.appendChild(
            textNode(
              "span",
              "",
              [
                `车辆 ${Array.isArray(session.vehicle_ids) && session.vehicle_ids.length ? session.vehicle_ids.join(", ") : "-"}`,
                `记录 ${formatNumber(session.sample_count, "0")} 条`,
                `图片 ${formatNumber(session.frame_count, "0")} 张`,
                `包 ${formatBytes(session.size_bytes)}`,
                session.error ? `错误 ${session.error}` : ""
              ].filter(Boolean).join(" · ")
            )
          );
          uploadListEl.appendChild(row);
        });
      }
    }
    setUploadStatus(
      sessions.length
        ? `最近 ${formatTime(sessions[0].imported_at || sessions[0].failed_at || sessions[0].received_at)}`
        : `等待数据同步 · 可接收 ${formatBoolean(data && data.can_accept_upload)}`
    );
  }

  function collectorStatusText(row) {
    if (!row || !row.tools || !row.tools.has_status_tool) return "未更新状态";
    const status = row.status || {};
    if (status.ok === false) return `状态失败：${status.error || "-"}`;
    if (status.script_running) return `运行中 · ${status.health || "ok"}`;
    return `未运行 · ${status.health || "warning"}`;
  }

  function renderPatrolFlowCollectors(data) {
    const counts = data && data.counts ? data.counts : {};
    clearElement(collectorSummaryEl);
    if (collectorSummaryEl) {
      [
        `状态 ${formatNumber(counts.with_status_tool, "0")}/${formatNumber(counts.scanned, "0")}`,
        `运行 ${formatNumber(counts.running, "0")}`,
        `待传 ${formatNumber(counts.pending_upload, "0")}`,
        `未更新 ${formatNumber(counts.not_updated, "0")}`
      ].forEach((text) => collectorSummaryEl.appendChild(textNode("span", "", text)));
    }

    clearElement(collectorListEl);
    if (!collectorListEl) return;
    const rows = Array.isArray(data && data.collectors) ? data.collectors : [];
    if (!rows.length) {
      collectorListEl.appendChild(textNode("p", "park-pcm-empty", "没有在线车辆状态。"));
      return;
    }
    rows.forEach((row) => {
      const status = row.status || {};
      const queue = status.queue || {};
      const warnings = Array.isArray(status.warnings) ? status.warnings : [];
      const item = document.createElement("article");
      item.className = "park-pcm-collector-row";

      const copy = document.createElement("div");
      copy.appendChild(textNode("strong", "", `${row.vehicle_id || "-"} · ${collectorStatusText(row)}`));
      copy.appendChild(
        textNode(
          "span",
          "",
          [
            `最近在线 ${formatTime(row.last_seen)}`,
            `待传 ${formatNumber(queue.pending_count, "0")} 包 ${formatBytes(queue.pending_total_size_bytes)}`,
            status.latest_capture_at ? `最近采集 ${formatTime(status.latest_capture_at)}` : "暂无车端采集",
            status.cloud_status_probe ? `云端探测 ${status.cloud_status_probe.ok ? "正常" : "异常"}` : "",
            warnings.length ? `告警 ${warnings.slice(0, 2).join(", ")}` : ""
          ].filter(Boolean).join(" · ")
        )
      );

      const actions = document.createElement("div");
      actions.className = "park-pcm-collector-row-actions";
      const flushBtn = document.createElement("button");
      flushBtn.type = "button";
      flushBtn.className = "park-pcm-button park-pcm-button--compact";
      flushBtn.textContent = "同步队列";
      flushBtn.disabled = !row.tools || !row.tools.has_flush_tool;
      flushBtn.addEventListener("click", () => {
        void flushPatrolFlowQueue(row.vehicle_id).catch((error) => {
          setUploadStatus(`同步失败：${error.message || "-"}`);
        });
      });
      actions.appendChild(flushBtn);

      item.appendChild(copy);
      item.appendChild(actions);
      collectorListEl.appendChild(item);
    });
  }

  function renderCrowdLast(sample) {
    clearElement(crowdLastEl);
    if (!crowdLastEl) return;
    if (!sample) {
      crowdLastEl.appendChild(textNode("p", "park-pcm-empty", "还没有人流样本。"));
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

  function renderCurrentCrowdView() {
    renderHeatmapDateControl();
    const vehicleRows = selectedVehicleCrowdSamples();
    const rows = visibleCrowdSamples();
    const rowsWithCount = rows.filter((sample) => samplePeopleCount(sample) != null);
    const totalPeople = rowsWithCount.reduce((sum, sample) => sum + Number(samplePeopleCount(sample) || 0), 0);
    setVehicleSummary(
      selectedVehicleId
        ? `${selectedVehicleId} · ${selectedDayKey ? `${formatDayLabel(selectedDayKey)} · ` : ""}当日记录 ${rows.length} · 已识别 ${rowsWithCount.length} 条/${totalPeople} 人 · 全部 ${vehicleRows.length} 条`
        : "请选择一台车辆查看人流热力。"
    );
    if (!rows.length) {
      renderCrowdLast(null);
      renderHistoryDetail();
      renderTrackSamples();
      renderSampleDetail(null);
      void renderTrackMap().catch((error) => {
        setMapStatus(`热力刷新失败：${error.message || "-"}`);
      });
      return;
    }
    renderCrowdLast(rows[0]);
    renderHistoryDetail();
    renderTrackSamples();
    renderSampleDetail(selectedCrowdSample());
    void renderTrackMap().catch((error) => {
      setMapStatus(`热力刷新失败：${error.message || "-"}`);
    });
  }

  function renderCrowdSamples(samples) {
    const list = Array.isArray(samples)
      ? samples.filter((item) => !item.skipped && samplePosition(item))
      : [];
    latestCrowdSamples = list;
    updateKnownHeatmapDayBounds(list);
    syncSampleVehicleOptions(list);
    if (!selectedVehicleId && list.length) {
      const defaultVehicleId = chooseDefaultVehicleId(list);
      if (defaultVehicleId) {
        selectedVehicleId = defaultVehicleId;
        selectedDayKey = "";
        ensureVehicleOption(defaultVehicleId);
        if (crowdVehicleSelect) crowdVehicleSelect.value = defaultVehicleId;
      }
    }
    renderCurrentCrowdView();
  }

  async function loadCrowdVehicles() {
    const data = await fetchJson(CROWD_VEHICLES_URL);
    renderCrowdVehicles(data);
    setCrowdStatus(data.in_flight ? "车辆状态更新中" : `车辆 ${Array.isArray(data.vehicles) ? data.vehicles.length : 0} 台`);
    return data;
  }

  async function loadCrowdUploads() {
    const data = await fetchJson(`${CROWD_UPLOADS_URL}?limit=8&log_limit=8`);
    renderUploadStatus(data);
    return data;
  }

  async function loadPatrolFlowCollectors() {
    const query = new URLSearchParams({
      max_vehicles: "80",
      include_status: "true"
    });
    const data = await fetchJson(`${PATROL_FLOW_COLLECTORS_URL}?${query.toString()}`);
    renderPatrolFlowCollectors(data);
    return data;
  }

  async function loadCrowdSamples(vehicleId) {
    const normalizedVehicleId = String(vehicleId == null ? selectedVehicleId : vehicleId).trim();
    const requestId = sampleLoadRequestId + 1;
    sampleLoadRequestId = requestId;
    const query = new URLSearchParams({
      limit: normalizedVehicleId ? String(CROWD_SAMPLE_VEHICLE_LIMIT) : String(CROWD_SAMPLE_INITIAL_LIMIT),
      source: CROWD_SAMPLE_SOURCE
    });
    if (normalizedVehicleId) query.set("vehicle_id", normalizedVehicleId);
    const data = await fetchJson(`${CROWD_SAMPLES_URL}?${query.toString()}`);
    if (requestId !== sampleLoadRequestId) return data;
    renderCrowdSamples(data.samples || []);
    return data;
  }

  async function flushPatrolFlowQueue(vehicleId) {
    if (!authenticated || busy) return;
    const normalizedVehicleId = String(vehicleId || "").trim();
    if (!normalizedVehicleId) {
      setUploadStatus("请选择车辆");
      return;
    }
    setBusy(true);
    setUploadStatus(`${normalizedVehicleId} 同步队列中`);
    try {
      const result = await fetchJson(PATROL_FLOW_FLUSH_URL, {
        method: "POST",
        body: {
          vehicle_id: normalizedVehicleId
        }
      });
      await Promise.all([loadCrowdUploads(), loadPatrolFlowCollectors(), loadCrowdSamples(selectedVehicleId)]);
      setUploadStatus(`${normalizedVehicleId} 同步完成 · 成功 ${formatNumber(result.success_count, "0")} / 失败 ${formatNumber(result.failed_count, "0")}`);
    } catch (error) {
      setUploadStatus(`同步失败：${error.message || "patrol_flow_flush_failed"}`);
      if (authEl) {
        authEl.hidden = false;
        authEl.textContent = error.message || "数据同步失败。";
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
          setCrowdStatus(`人流数据加载失败：${error.message || "-"}`);
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
        setVehicleSummary(`人流数据加载失败：${error.message || "-"}`);
        setMapStatus("人流数据加载失败");
      });
    });
  }
  if (heatmapDateRangeEl) {
    heatmapDateRangeEl.addEventListener("input", () => {
      const axis = dayAxisForSelectedVehicle();
      const days = axis.days || [];
      const index = Math.max(0, Math.min(days.length - 1, Math.round(Number(heatmapDateRangeEl.value) || 0)));
      const day = days[index];
      if (!day || day.key === selectedDayKey) return;
      selectedDayKey = day.key;
      selectedSampleId = "";
      renderCurrentCrowdView();
    });
  }
  if (collectorRefreshBtn) {
    collectorRefreshBtn.addEventListener("click", async () => {
      if (!authenticated || busy) return;
      setBusy(true);
      setUploadStatus("刷新状态");
      try {
        await Promise.all([loadCrowdUploads(), loadPatrolFlowCollectors()]);
        setUploadStatus("状态已更新");
      } catch (error) {
        setUploadStatus(`状态刷新失败：${error.message || "-"}`);
      } finally {
        setBusy(false);
      }
    });
  }
  if (patrolRefreshBtn) {
    patrolRefreshBtn.addEventListener("click", async () => {
      if (!authenticated || busy) return;
      setBusy(true);
      setMapStatus("刷新中");
      try {
        await loadCrowdVehicles();
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
    void loadCrowdVehicles()
      .then(() => loadCrowdSamples(selectedVehicleId))
      .catch((error) => {
        setMapStatus(`数据刷新失败：${error.message || "-"}`);
      });
  }, PATROL_REFRESH_MS);
  void init();
})();
