(() => {
  const panel = document.getElementById("yolo-review-panel");
  if (!panel) return;

  const endpoints = {
    datasets: "/api/yolo-label-review/datasets",
    dailyStats: "/api/yolo-label-review/daily-stats?days=14",
    items: "/api/yolo-label-review/items",
    item: "/api/yolo-label-review/item",
    annotation: "/api/yolo-label-review/annotation",
    deleteItem: "/api/yolo-label-review/item/delete"
  };

  const refs = {
    status: document.getElementById("yolo-review-status"),
    refresh: document.getElementById("yolo-review-refresh"),
    source: document.getElementById("yolo-review-source"),
    dataset: document.getElementById("yolo-review-dataset"),
    split: document.getElementById("yolo-review-split"),
    className: document.getElementById("yolo-review-class"),
    answer: document.getElementById("yolo-review-answer"),
    qwenLabel: document.getElementById("yolo-review-qwen-label"),
    qwenAudit: document.getElementById("yolo-review-qwen-audit"),
    hasBox: document.getElementById("yolo-review-has-box"),
    query: document.getElementById("yolo-review-query"),
    eventStatus: document.getElementById("yolo-review-event-status"),
    eventButtons: Array.from(document.querySelectorAll("[data-yolo-review-event]")),
    datasetStatus: document.getElementById("yolo-review-dataset-status"),
    sourceCards: document.getElementById("yolo-review-source-cards"),
    dailyStats: document.getElementById("yolo-review-daily-stats"),
    datasetCards: document.getElementById("yolo-review-dataset-cards"),
    summary: document.getElementById("yolo-review-summary"),
    list: document.getElementById("yolo-review-list"),
    detail: document.getElementById("yolo-review-detail"),
    prev: document.getElementById("yolo-review-prev"),
    next: document.getElementById("yolo-review-next"),
    page: document.getElementById("yolo-review-page")
  };

  const state = {
    allDatasets: [],
    eventDatasets: [],
    datasets: [],
    datasetId: "",
    page: 1,
    pageSize: 24,
    totalPages: 1,
    selectedItemKey: "",
    activeEvent: "all",
    dailyStats: null,
    detailRequestSeq: 0
  };

  const eventPresets = {
    all: {
      label: "全部事件 · 全部来源",
      tokens: [],
      qwenLabel: "",
      className: "",
      answer: "",
      query: "",
      hasBox: false,
      taskKind: "mixed"
    },
    qwen_suspect: {
      label: "可疑标注 · 全部来源 · 待人工校核",
      tokens: ["vehicle_self_collected", "patrol", "qwen_bbox"],
      qwenLabel: "",
      className: "",
      classNames: [],
      answer: "",
      query: "",
      hasBox: false,
      taskKind: "detect",
      preferredSource: "vehicle_collection",
      qwenAudit: "suspect",
      autoClassFilter: false
    },
    person: {
      label: "人员事件 · 全部来源 · 默认显示框",
      tokens: ["person", "pedestrian", "人员"],
      excludeTokens: ["person_behavior_yolo_cls", "smoking_cls"],
      qwenLabel: "person",
      className: "person",
      classNames: ["person", "pedestrian"],
      answer: "YES",
      query: "",
      hasBox: true,
      taskKind: "detect",
      preferredSource: "vehicle_collection"
    },
    vehicle: {
      label: "车辆事件 · 全部来源 · 默认显示框",
      tokens: ["vehicle", "car", "truck", "bus", "nonmotor", "车辆"],
      qwenLabel: "vehicle",
      className: "vehicle",
      classNames: ["vehicle", "car", "truck", "bus", "non_motor_vehicle", "nonmotor"],
      answer: "YES",
      query: "",
      hasBox: true,
      taskKind: "detect",
      preferredSource: "vehicle_collection"
    },
    license_plate: {
      label: "车牌事件 · 全部来源 · 默认显示框",
      tokens: ["license_plate", "plate", "ccpd", "车牌"],
      qwenLabel: "",
      className: "",
      classNames: ["license_plate", "plate"],
      answer: "YES",
      query: "",
      hasBox: true,
      taskKind: "detect",
      preferredSource: "public_dataset"
    },
    phone: {
      label: "手机事件 · 全部来源 · 默认 Yes/No",
      tokens: ["phone", "mobile", "手机"],
      qwenLabel: "phone",
      className: "phone",
      classNames: ["phone_use", "phone", "mobile"],
      answer: "YES",
      query: "",
      hasBox: false,
      taskKind: "classify",
      preferredSource: "public_dataset"
    },
    smoking: {
      label: "吸烟事件 · 全部来源 · 默认 Yes/No",
      tokens: ["smoking", "smoke_cls", "person_behavior", "吸烟"],
      qwenLabel: "smoking",
      className: "smoking",
      classNames: ["smoking"],
      answer: "YES",
      query: "",
      hasBox: false,
      taskKind: "classify",
      preferredSource: "public_dataset"
    },
    fire_smoke: {
      label: "烟火事件 · 全部来源 · 默认显示框",
      tokens: ["fire_smoke", "fire", "smoke", "flame", "烟", "火"],
      qwenLabel: "fire_smoke_candidate",
      className: "",
      classNames: ["fire", "smoke"],
      answer: "",
      query: "",
      hasBox: true,
      taskKind: "detect",
      autoClassFilter: false,
      preferredSource: "public_dataset"
    },
    trash: {
      label: "垃圾事件 · 全部来源 · 默认显示框",
      tokens: ["trash", "garbage", "litter", "垃圾"],
      qwenLabel: "trash",
      className: "trash",
      classNames: ["trash", "bottle", "box", "paper", "bag"],
      answer: "YES",
      query: "",
      hasBox: true,
      taskKind: "detect",
      autoClassFilter: false,
      preferredSource: "checker_archive"
    },
    stall: {
      label: "摆摊事件 · 全部来源 · 默认显示框",
      tokens: ["stall", "booth", "vendor", "摆摊"],
      qwenLabel: "stall",
      className: "stall",
      classNames: ["stall"],
      answer: "YES",
      query: "",
      hasBox: true,
      taskKind: "detect",
      preferredSource: "checker_archive"
    },
    pet: {
      label: "宠物事件 · 全部来源 · 默认显示框",
      tokens: ["pet", "dog", "cat", "animal", "宠物"],
      qwenLabel: "pet",
      className: "pet",
      classNames: ["pet", "dog", "cat"],
      answer: "",
      query: "",
      hasBox: true,
      taskKind: "detect",
      preferredSource: "public_dataset"
    },
    fishing: {
      label: "钓鱼事件 · 全部来源 · 默认显示框",
      tokens: ["fishing", "fishing_rod", "钓鱼"],
      qwenLabel: "",
      className: "",
      classNames: ["fishing_rod"],
      answer: "YES",
      query: "",
      hasBox: true,
      taskKind: "detect",
      preferredSource: "public_dataset"
    }
  };

  const sourceGroups = [
    { value: "", label: "全部来源" },
    { value: "vehicle_collection", label: "车辆自采" },
    { value: "checker_archive", label: "云端校核" },
    { value: "public_dataset", label: "公开数据集" }
  ];

  function createNode(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function setStatus(text, status = "idle") {
    if (!refs.status) return;
    refs.status.textContent = text;
    refs.status.dataset.state = status;
  }

  function renderLoadingNode(container, message, options = {}) {
    if (!container) return;
    container.innerHTML = "";
    const loading = createNode("div", `yolo-review-loading${options.compact ? " yolo-review-loading--compact" : ""}`);
    loading.appendChild(createNode("span", "yolo-review-spinner"));
    loading.appendChild(createNode("p", "", message));
    container.appendChild(loading);
  }

  function renderDatasetLoading() {
    if (refs.datasetStatus) {
      refs.datasetStatus.textContent = "正在加载数据集...";
    }
    renderLoadingNode(refs.sourceCards, "来源统计加载中...", { compact: true });
    renderLoadingNode(refs.dailyStats, "每日统计加载中...", { compact: true });
    renderLoadingNode(refs.datasetCards, "数据集加载中...");
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.headers || {})
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.ok === false) {
      throw new Error(data?.detail || data?.error || `HTTP ${response.status}`);
    }
    return data;
  }

  function postJson(url, body) {
    return requestJson(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body || {})
    });
  }

  function compactNumber(value) {
    const num = Number(value || 0);
    if (!Number.isFinite(num)) return "0";
    return new Intl.NumberFormat("zh-CN").format(num);
  }

  function formatDate(value) {
    if (!value) return "-";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return String(value);
    return parsed.toLocaleString("zh-CN", { hour12: false });
  }

  function formatDay(value) {
    const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return value || "-";
    return `${match[2]}-${match[3]}`;
  }

  function percentText(done, total) {
    const safeDone = Number(done || 0);
    const safeTotal = Number(total || 0);
    if (!safeTotal) return "-";
    return `${Math.round((safeDone / safeTotal) * 1000) / 10}%`;
  }

  function topCountText(items, limit = 3) {
    const parts = (Array.isArray(items) ? items : [])
      .filter((item) => Number(item?.count) > 0)
      .slice(0, limit)
      .map((item) => `${qwenLabelText(item.name)} ${compactNumber(item.count)}`);
    return parts.length ? parts.join(" / ") : "-";
  }

  function normalizeClassToken(value) {
    return String(value || "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  }

  function answerTone(answer) {
    return answer === "YES" ? "tone-yes" : answer === "NO" ? "tone-no" : "tone-idle";
  }

  function labelSourceText(source) {
    if (source === "manual") return "人工标注";
    if (source === "qwen_bbox_verified") return "Qwen校验框";
    if (source === "qwen_bbox") return "Qwen框";
    if (source === "yolo_auto") return "YOLO模型预标";
    return "";
  }

  function labelSourceTone(source) {
    if (source === "manual") return "tone-yes";
    return source === "qwen_bbox_verified" || source === "qwen_bbox" ? "tone-yes" : "tone-idle";
  }

  function qwenAuditTone(verdict, severity) {
    if (verdict === "pass") return "tone-yes";
    if (verdict === "needs_human" || verdict === "error" || severity === "high") return "tone-error";
    if (verdict === "suspect" || severity === "medium") return "tone-no";
    return "tone-idle";
  }

  function qwenAuditText(verdict, status) {
    if (verdict === "pass") return "质检通过";
    if (verdict === "needs_human") return "待人工校核";
    if (verdict === "suspect") return "质检可疑";
    if (verdict === "error") return "质检异常";
    if (status === "pending") return "待质检";
    if (status === "not_applicable") return "质检不适用";
    return status ? "已质检" : "";
  }

  function qwenAuditSummary(item) {
    const verdict = item?.qwen_bbox_audit_verdict || item?.qwen_bbox_audit?.verdict || "";
    const status = item?.qwen_bbox_audit_status || (item?.qwen_bbox_status === "done" ? "pending" : "");
    const text = qwenAuditText(verdict, status);
    if (!text) return "";
    const bad = Number(item?.qwen_bbox_audit_suspicious_count ?? item?.qwen_bbox_audit?.suspicious_count ?? 0);
    const miss = Number(item?.qwen_bbox_audit_missing_count ?? item?.qwen_bbox_audit?.missing_count ?? 0);
    const suffix = [bad ? `${bad}疑框` : "", miss ? `${miss}漏标` : ""].filter(Boolean).join("/");
    return suffix ? `${text} ${suffix}` : text;
  }

  const qwenLabelNames = {
    person: "人",
    fire: "火",
    smoke: "烟",
    trash: "垃圾",
    pet: "宠物",
    stall: "摆摊",
    phone: "手机",
    smoking: "抽烟",
    vehicle: "车辆",
    nonmotor: "非机动车",
    empty_scene: "空场景",
    hard_negative: "困难负样本",
    fire_smoke_candidate: "烟火候选",
    trash_candidate: "垃圾候选",
    small_object_candidate: "小目标候选",
    "quality:good": "质量好",
    "quality:dark": "夜间/偏暗",
    "quality:blur": "模糊",
    "quality:blocked": "遮挡",
    pass: "通过",
    suspect: "可疑",
    needs_human: "待人工校核",
    error: "异常"
  };

  function qwenLabelText(value) {
    return qwenLabelNames[value] || value;
  }

  function qwenCountSummary(item) {
    const counts = item?.qwen_label?.counts || {};
    const parts = Object.entries(counts)
      .filter(([, count]) => Number(count) > 0)
      .map(([name, count]) => `${qwenLabelText(name)} ${count}`);
    if (parts.length) return parts.join(" / ");
    if (Array.isArray(item?.qwen_flags) && item.qwen_flags.includes("empty_scene")) return "空场景";
    return item?.qwen_label_status === "done" ? "无目标" : "";
  }

  function answerDisplay(answer) {
    const value = String(answer || "").toUpperCase();
    if (value === "YES") return "Yes";
    if (value === "NO") return "No";
    return value || "-";
  }

  function datasetLabel(dataset) {
    const profile = dataset.profile || dataset.name || "dataset";
    const parent = dataset.parent_name && dataset.parent_name !== profile ? ` / ${dataset.parent_name}` : "";
    const source = datasetSourceText(dataset);
    return `[${source}] ${profile}${parent} · ${dataset.kind || "dataset"} · ${compactNumber(dataset.total_images)}张`;
  }

  function datasetSearchText(dataset) {
    return [
      dataset?.id,
      dataset?.name,
      dataset?.parent_name,
      dataset?.profile,
      dataset?.source,
      dataset?.source_label,
      dataset?.source_type,
      ...(Array.isArray(dataset?.classes) ? dataset.classes : [])
    ].map((value) => String(value || "").toLowerCase()).join(" ");
  }

  function datasetSourceGroup(dataset) {
    if (dataset?.source_type === "vehicle_collection") return "vehicle_collection";
    const text = datasetSearchText(dataset);
    const publicTokens = [
      "public",
      "ccpd",
      "lvis",
      "objects365",
      "license_plate",
      "fire_smoke_yolo",
      "home_fire",
      "external_yolo",
      "smoking_cls",
      "person_behavior_yolo_cls",
      "fishing_rod",
      "pet_yolo_public",
      "ground_seg"
    ];
    if (publicTokens.some((token) => text.includes(token))) {
      return "public_dataset";
    }
    return "checker_archive";
  }

  function sourceGroupLabel(value) {
    return sourceGroups.find((item) => item.value === value)?.label || "数据源";
  }

  function datasetSourceText(dataset) {
    const group = datasetSourceGroup(dataset);
    if (group) return sourceGroupLabel(group);
    return dataset?.source_label || dataset?.source_type || dataset?.source || "数据源";
  }

  function datasetEventText(dataset) {
    return datasetSearchText(dataset).replace(/[-\s]+/g, "_");
  }

  function datasetMatchesEvent(dataset, eventKey = state.activeEvent) {
    if (!eventKey || eventKey === "all") return true;
    const preset = eventPresets[eventKey];
    if (!preset) return true;
    if (preset.qwenAudit) {
      return datasetSourceGroup(dataset) === "vehicle_collection";
    }
    const sourceGroup = datasetSourceGroup(dataset);
    const text = datasetEventText(dataset);
    const excludedTokens = Array.isArray(preset.excludeTokens)
      ? preset.excludeTokens.map(normalizeClassToken).filter(Boolean)
      : [];
    if (excludedTokens.some((token) => text.includes(token))) {
      return false;
    }
    const tokens = Array.isArray(preset.tokens) ? preset.tokens.map(normalizeClassToken).filter(Boolean) : [];
    if (tokens.some((token) => text.includes(token))) {
      return true;
    }
    if (sourceGroup !== "vehicle_collection") {
      return false;
    }
    if (preset.qwenLabel || preset.className || preset.query) {
      return true;
    }
    const vehicleTokens = [
      preset.qwenLabel,
      preset.className
    ].map(normalizeClassToken).filter(Boolean);
    return vehicleTokens.some((token) => text.includes(token));
  }

  function datasetTotalBoxes(dataset) {
    return dataset?.boxes ? sumObjectValues(dataset.boxes) : 0;
  }

  function datasetTotalImages(dataset) {
    return Number(dataset?.total_images || 0);
  }

  function datasetIsReviewVisible(dataset) {
    const text = datasetSearchText(dataset);
    return ![
      "partial_before_rebuild",
      ".partial_",
      "_backup",
      "/backup"
    ].some((token) => text.includes(token));
  }

  function datasetEventClassTokens(preset) {
    const tokens = Array.isArray(preset?.classNames) ? preset.classNames : [preset?.className];
    return tokens.map(normalizeClassToken).filter(Boolean);
  }

  function datasetClassTokens(dataset) {
    return (Array.isArray(dataset?.classes) ? dataset.classes : []).map(normalizeClassToken).filter(Boolean);
  }

  function reviewTaskKind(dataset = selectedDataset(), eventKey = state.activeEvent) {
    const preset = eventPresets[eventKey] || eventPresets.all;
    if (eventKey && eventKey !== "all" && preset.taskKind && preset.taskKind !== "mixed") {
      return preset.taskKind;
    }
    if (dataset?.kind === "classify") return "classify";
    if (dataset?.kind === "detect") return "detect";
    return preset.taskKind || "mixed";
  }

  function datasetHasEventClass(dataset, preset) {
    const classes = datasetClassTokens(dataset);
    const eventClasses = datasetEventClassTokens(preset);
    return eventClasses.some((token) => classes.includes(token));
  }

  function matchingDatasetEventClassTokens(dataset, preset) {
    const classes = datasetClassTokens(dataset);
    return datasetEventClassTokens(preset).filter((token) => classes.includes(token));
  }

  function sumMatchingCounts(value, tokens) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
    let total = 0;
    Object.entries(value).forEach(([key, item]) => {
      const normalizedKey = normalizeClassToken(key);
      if (tokens.includes(normalizedKey) && Number.isFinite(Number(item))) {
        total += Number(item || 0);
      } else if (item && typeof item === "object" && !Array.isArray(item)) {
        total += sumMatchingCounts(item, tokens);
      }
    });
    return total;
  }

  function countObjectLooksSplitBased(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const keys = Object.keys(value).map(normalizeClassToken);
    return keys.length > 0 && keys.every((key) => ["train", "val", "test"].includes(key));
  }

  function splitCount(value) {
    return countObjectLooksSplitBased(value) ? sumObjectValues(value) : 0;
  }

  function datasetEventLabel(eventKey = state.activeEvent, source = refs.source?.value || "") {
    const raw = eventPresets[eventKey]?.label || "全部事件";
    const sourceText = sourceGroupLabel(source);
    const label = raw.replace(" · 全部来源", "");
    if (!eventKey || eventKey === "all") {
      return `${label} · 当前 ${sourceText}`;
    }
    return label
      .replace(" · 默认", ` · 当前 ${sourceText} · 默认`)
      .replace(" · 候选/框", ` · 当前 ${sourceText} · 候选/框`);
  }

  function eventPositiveImageCount(dataset, classTokens, preset) {
    if (!dataset || !classTokens.length) return 0;
    const qwenImages = sumMatchingCounts(dataset.qwen_label?.images_by_class || dataset.summary?.qwen_label?.images_by_class, classTokens);
    const qwenBboxImages = sumMatchingCounts(dataset.qwen_bbox?.images_by_class || dataset.summary?.qwen_bbox?.images_by_class, classTokens);
    const qwenBoxes = sumMatchingCounts(dataset.qwen_bbox?.boxes_by_class || dataset.summary?.qwen_bbox?.boxes_by_class, classTokens);
    if (preset?.taskKind === "classify") {
      if (qwenImages > 0) return qwenImages;
    }
    const requiresBox = dataset.kind !== "classify" && Boolean(preset?.hasBox);
    if (requiresBox && datasetSourceGroup(dataset) === "vehicle_collection") {
      if (qwenBboxImages > 0) return qwenBboxImages;
      if (qwenImages > 0 && qwenBoxes > 0) return Math.min(qwenImages, qwenBoxes);
      return qwenBoxes > 0 ? Math.min(qwenBoxes, datasetTotalImages(dataset)) : 0;
    }
    if (qwenImages > 0 && qwenBoxes > 0) return Math.min(qwenImages, qwenBoxes);
    if (qwenImages > 0) return qwenImages;

    const byClass = sumMatchingCounts(dataset.by_class_yes, classTokens);
    const yesCount = Number(dataset.answers?.YES || 0);
    if (byClass > 0 && yesCount > 0) return Math.min(byClass, yesCount);
    if (byClass > 0) return byClass;

    const positiveImages = splitCount(dataset.positive_images);
    if (positiveImages > 0 && datasetHasEventClass(dataset, preset)) return positiveImages;
    if (yesCount > 0 && datasetHasEventClass(dataset, preset)) return yesCount;
    return 0;
  }

  function estimatedEventItemCount(dataset, preset) {
    if (!dataset || !preset || preset === eventPresets.all) {
      return datasetTotalImages(dataset);
    }
    if (preset.qwenAudit) {
      const audit = datasetQwenAudit(dataset);
      if (preset.qwenAudit === "suspect") {
        return Number(audit?.review_queue_images || 0);
      }
      if (preset.qwenAudit === "pending") {
        return Number(audit?.pending_images || 0);
      }
      return Number(audit?.verdict_counts?.[preset.qwenAudit] || 0);
    }
    const classTokens = datasetEventClassTokens(preset);
    if (!classTokens.length) {
      return datasetTotalImages(dataset);
    }
    if (dataset.kind === "classify") {
      const classCount = sumMatchingCounts(dataset.images, classTokens);
      if (classCount > 0) return classCount;
      return datasetHasEventClass(dataset, preset) ? datasetTotalImages(dataset) : 0;
    }
    const positiveCount = eventPositiveImageCount(dataset, classTokens, preset);
    if (positiveCount > 0) return positiveCount;
    if (datasetSourceGroup(dataset) === "vehicle_collection") return 0;
    return datasetHasEventClass(dataset, preset) ? datasetTotalImages(dataset) : 0;
  }

  function estimatedEventBoxCount(dataset, preset = eventPresets[state.activeEvent] || eventPresets.all) {
    if (!dataset || !preset || preset === eventPresets.all) return datasetTotalBoxes(dataset);
    if (preset.qwenAudit) return 0;
    if (dataset.kind === "classify" || preset.taskKind === "classify") return 0;
    const classTokens = datasetEventClassTokens(preset);
    if (!classTokens.length) return datasetTotalBoxes(dataset);
    const classBoxCount = sumMatchingCounts(dataset.boxes, classTokens);
    if (classBoxCount > 0) return classBoxCount;
    const qwenBoxCount = sumMatchingCounts(dataset.qwen_bbox?.boxes_by_class || dataset.summary?.qwen_bbox?.boxes_by_class, classTokens);
    if (qwenBoxCount > 0) return qwenBoxCount;
    const byClassCount = sumMatchingCounts(dataset.by_class_yes, classTokens);
    if (byClassCount > 0) return byClassCount;
    if (datasetSourceGroup(dataset) === "vehicle_collection") return 0;
    if (datasetHasEventClass(dataset, preset) && countObjectLooksSplitBased(dataset.boxes)) return datasetTotalBoxes(dataset);
    return datasetHasEventClass(dataset, preset) ? datasetTotalBoxes(dataset) : 0;
  }

  function datasetEventMetrics(dataset, eventKey = state.activeEvent) {
    const preset = eventPresets[eventKey] || eventPresets.all;
    return {
      imageCount: estimatedEventItemCount(dataset, preset),
      boxCount: estimatedEventBoxCount(dataset, preset)
    };
  }

  function datasetEventScore(dataset, eventKey = state.activeEvent) {
    if (!dataset) return -1;
    if (!eventKey || eventKey === "all") return datasetTotalImages(dataset);
    const preset = eventPresets[eventKey] || eventPresets.all;
    const sourceGroup = datasetSourceGroup(dataset);
    const text = datasetEventText(dataset);
    const tokens = Array.isArray(preset.tokens) ? preset.tokens.map(normalizeClassToken).filter(Boolean) : [];
    const count = estimatedEventItemCount(dataset, preset);
    let score = count;
    if (preset.preferredSource && sourceGroup === preset.preferredSource) {
      score += 1_000_000;
    }
    if (tokens.some((token) => text.includes(`${token}_yolo`) || text.includes(`${token}_cls`))) {
      score += 100_000;
    } else if (tokens.some((token) => text.includes(token))) {
      score += 10_000;
    }
    if (datasetHasEventClass(dataset, preset)) {
      score += 5_000;
    }
    if (sourceGroup === "vehicle_collection" && count <= 0) {
      score -= 50_000;
    }
    return score;
  }

  function pickDefaultDataset(datasets) {
    if (!datasets.length) return null;
    if (state.activeEvent === "all") return datasets[0];
    return [...datasets].sort((left, right) => {
      const scoreDiff = datasetEventScore(right) - datasetEventScore(left);
      if (scoreDiff !== 0) return scoreDiff;
      return datasetTotalImages(right) - datasetTotalImages(left);
    })[0] || null;
  }

  function datasetKindText(dataset) {
    return dataset?.kind === "classify" ? "分类" : "检测";
  }

  function datasetMetricValue(dataset, path, fallback = "-") {
    const parts = String(path || "").split(".");
    let value = dataset;
    for (const part of parts) {
      value = value?.[part];
      if (value == null) return fallback;
    }
    return compactNumber(value);
  }

  function datasetQwenAudit(dataset) {
    return dataset?.qwen_bbox_audit || dataset?.summary?.qwen_bbox_audit || null;
  }

  function datasetClassSummary(dataset) {
    const classes = Array.isArray(dataset?.classes) ? dataset.classes.filter(Boolean) : [];
    if (!classes.length) return "无类别";
    if (classes.length <= 4) return classes.join(" / ");
    return `${classes.slice(0, 4).join(" / ")} +${classes.length - 4}`;
  }

  function selectedDataset() {
    return state.datasets.find((item) => item.id === state.datasetId) || null;
  }

  function sourceDatasets(source) {
    return state.eventDatasets.filter((dataset) => !source || datasetSourceGroup(dataset) === source);
  }

  function sourceStats(source) {
    const datasets = sourceDatasets(source);
    return {
      datasets,
      datasetCount: datasets.length,
      imageCount: datasets.reduce((total, dataset) => total + datasetEventMetrics(dataset).imageCount, 0),
      boxCount: datasets.reduce((total, dataset) => total + datasetEventMetrics(dataset).boxCount, 0)
    };
  }

  function sumObjectValues(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
    return Object.values(value).reduce((total, item) => total + Number(item || 0), 0);
  }

  function setSelectOptions(select, items, options = {}) {
    if (!select) return;
    const previous = select.value;
    select.innerHTML = "";
    if (options.allLabel) {
      const all = document.createElement("option");
      all.value = "";
      all.textContent = options.allLabel;
      select.appendChild(all);
    }
    items.forEach((item) => {
      const option = document.createElement("option");
      option.value = item.value;
      option.textContent = item.label;
      select.appendChild(option);
    });
    if ([...select.options].some((option) => option.value === previous)) {
      select.value = previous;
    }
  }

  function setSelectValueIfPresent(select, value) {
    if (!select) return false;
    const nextValue = String(value || "");
    if ([...select.options].some((option) => option.value === nextValue)) {
      select.value = nextValue;
      return true;
    }
    select.value = "";
    return !nextValue;
  }

  function resetDetail(message = "选择一条训练样本。") {
    state.detailRequestSeq += 1;
    state.selectedItemKey = "";
    if (!refs.detail) return;
    refs.detail.dataset.state = "idle";
    refs.detail.innerHTML = "";
    refs.detail.appendChild(createNode("p", "yolo-review-empty", message));
  }

  function configureSourceOptions() {
    if (!refs.source) return;
    const previous = refs.source.value;
    refs.source.innerHTML = "";
    sourceGroups.forEach((item) => {
      const option = document.createElement("option");
      option.value = item.value;
      option.textContent = item.label;
      refs.source.appendChild(option);
    });
    refs.source.value = sourceGroups.some((item) => item.value === previous) ? previous : "";
  }

  function applyEventFiltersForDataset(dataset) {
    const preset = eventPresets[state.activeEvent] || eventPresets.all;
    const sourceGroup = dataset ? datasetSourceGroup(dataset) : "";
    const isVehicleCollection = sourceGroup === "vehicle_collection";
    const isClassify = reviewTaskKind(dataset) === "classify";
    const eventClassTokens = datasetEventClassTokens(preset);

    if (refs.split) refs.split.value = "";
    if (refs.query) refs.query.value = "";
    if (refs.qwenLabel) refs.qwenLabel.value = "";
    if (refs.qwenAudit) refs.qwenAudit.value = preset.qwenAudit || "";
    if (refs.className) refs.className.value = "";
    if (refs.answer) refs.answer.value = state.activeEvent === "all" ? "" : (preset.answer || "");
    if (refs.hasBox) refs.hasBox.checked = state.activeEvent !== "all" && !isClassify && Boolean(preset.hasBox);

    if (state.activeEvent === "all") return;
    if (isVehicleCollection) {
      if (isClassify) {
        setSelectValueIfPresent(refs.qwenLabel, preset.qwenLabel || "");
        setSelectValueIfPresent(refs.className, "");
      } else {
        setSelectValueIfPresent(refs.qwenLabel, "");
        const matchedClasses = matchingDatasetEventClassTokens(dataset, preset);
        setSelectValueIfPresent(refs.className, matchedClasses[0] || preset.className || "");
      }
      if (isClassify && preset.qwenLabel && refs.query && !refs.qwenLabel?.value && !refs.className?.value) {
        refs.query.value = preset.qwenLabel;
      }
    } else if (preset.autoClassFilter !== false && refs.className && eventClassTokens.length) {
      const classOptions = [...refs.className.options].map((option) => option.value);
      const matchedClass = eventClassTokens.find((token) => classOptions.includes(token));
      if (matchedClass) {
        refs.className.value = matchedClass;
      }
    }
  }

  function updateEventButtons() {
    refs.eventButtons.forEach((button) => {
      button.classList.toggle("is-active", button.dataset.yoloReviewEvent === state.activeEvent);
    });
    if (refs.eventStatus) {
      refs.eventStatus.textContent = datasetEventLabel();
    }
  }

  function markCustomEventFilter() {
    updateEventButtons();
  }

  function applyReviewEvent(eventKey) {
    state.activeEvent = eventPresets[eventKey] ? eventKey : "all";
    if (refs.source) refs.source.value = "";
    resetDetail("已切换事件，选择左侧样本查看详情。");
    refreshDatasetOptions({ forceDefault: true });
    updateClassOptions();
    updateQwenOptions();
    applyEventFiltersForDataset(selectedDataset());
    renderSummary(selectedDataset());
    renderDatasetCards();
    updateEventButtons();
    loadItems({ resetPage: true }).catch(() => {});
  }

  function applySourceSelection(source, options = {}) {
    if (refs.source) refs.source.value = source || "";
    if (options.resetDetail !== false) {
      resetDetail("已切换来源，选择左侧样本查看详情。");
    }
    refreshDatasetOptions({ forceDefault: true });
    updateClassOptions();
    updateQwenOptions();
    applyEventFiltersForDataset(selectedDataset());
    renderSummary(selectedDataset());
    renderDatasetCards();
    updateEventButtons();
    if (options.load !== false) {
      loadItems({ resetPage: true }).catch(() => {});
    }
  }

  function renderSourceCards() {
    if (!refs.sourceCards) return;
    refs.sourceCards.innerHTML = "";
    const selectedSource = refs.source?.value || "";
    sourceGroups.forEach((group) => {
      const stats = sourceStats(group.value);
      const button = createNode("button", "yolo-review-source-card");
      button.type = "button";
      button.dataset.sourceGroup = group.value;
      button.classList.toggle("is-active", group.value === selectedSource);
      button.classList.toggle("is-empty", stats.datasetCount === 0);
      button.addEventListener("click", () => {
        if ((refs.source?.value || "") === group.value) return;
        applySourceSelection(group.value);
      });

      const title = createNode("div", "yolo-review-source-card-title");
      title.appendChild(createNode("strong", "", group.label));
      title.appendChild(createNode("span", "", stats.datasetCount ? (stats.imageCount ? "可查看" : "可切换") : "当前事件下暂无数据集"));
      button.appendChild(title);

      const metrics = createNode("div", "yolo-review-source-card-metrics");
      const sampleLabel = state.activeEvent === "all" ? "样本" : "事件样本";
      const boxLabel = state.activeEvent === "all" ? "框" : "事件框";
      [
        ["数据集", compactNumber(stats.datasetCount)],
        [sampleLabel, compactNumber(stats.imageCount)],
        [boxLabel, compactNumber(stats.boxCount)]
      ].forEach(([label, value]) => {
        const metric = createNode("span", "", `${label} ${value}`);
        metrics.appendChild(metric);
      });
      button.appendChild(metrics);
      refs.sourceCards.appendChild(button);
    });
  }

  function renderDatasetCards() {
    renderSourceCards();
    if (!refs.datasetCards) return;
    refs.datasetCards.innerHTML = "";
    const visible = state.datasets;
    const total = state.eventDatasets.length;
    if (refs.datasetStatus) {
      const selectedStats = sourceStats(refs.source?.value || "");
      const sourceCounts = sourceGroups.slice(1).map((group) => {
        const stats = sourceStats(group.value);
        return `${group.label} ${compactNumber(stats.datasetCount)}集/${compactNumber(stats.imageCount)}样本`;
      });
      refs.datasetStatus.textContent = `${datasetEventLabel()} · ${compactNumber(selectedStats.datasetCount)} / ${compactNumber(total)} 个数据集 · ${sourceCounts.join(" · ")}`;
    }
    if (!visible.length) {
      const sourceText = sourceGroupLabel(refs.source?.value || "");
      refs.datasetCards.appendChild(createNode("p", "yolo-review-empty", `当前事件的「${sourceText}」下没有数据集。`));
      return;
    }
    visible.forEach((dataset) => {
      const button = createNode("button", "yolo-review-dataset-card");
      button.type = "button";
      button.dataset.datasetId = dataset.id;
      button.classList.toggle("is-active", dataset.id === state.datasetId);
      button.addEventListener("click", () => {
        if (dataset.id === state.datasetId) return;
        state.datasetId = dataset.id;
        resetDetail("已切换数据集，选择左侧样本查看详情。");
        if (refs.dataset) refs.dataset.value = dataset.id;
        updateClassOptions();
        updateQwenOptions();
        applyEventFiltersForDataset(selectedDataset());
        renderSummary(selectedDataset());
        renderDatasetCards();
        loadItems({ resetPage: true }).catch(() => {});
      });

      const head = createNode("div", "yolo-review-dataset-card-head");
      const title = createNode("div", "yolo-review-dataset-card-title");
      title.appendChild(createNode("strong", "", dataset.profile || dataset.name || "dataset"));
      const sourceLine = dataset.parent_name && dataset.parent_name !== dataset.profile
        ? `${datasetSourceText(dataset)} · ${dataset.parent_name}`
        : datasetSourceText(dataset);
      title.appendChild(createNode("span", "", sourceLine));
      head.appendChild(title);
      head.appendChild(createNode("span", "yolo-review-dataset-kind", datasetKindText(dataset)));
      button.appendChild(head);

      const classes = createNode("p", "yolo-review-dataset-classes", datasetClassSummary(dataset));
      button.appendChild(classes);

      const metrics = createNode("div", "yolo-review-dataset-metrics");
      const eventMetrics = datasetEventMetrics(dataset);
      const audit = datasetQwenAudit(dataset);
      const sampleLabel = state.activeEvent === "all" ? "样本" : "事件样本";
      const boxLabel = state.activeEvent === "all" ? "框" : "事件框";
      [
        [sampleLabel, compactNumber(eventMetrics.imageCount)],
        [boxLabel, compactNumber(eventMetrics.boxCount)],
        ["YES", dataset.answers?.YES != null ? compactNumber(dataset.answers.YES) : "-"],
        ["NO", dataset.answers?.NO != null ? compactNumber(dataset.answers.NO) : "-"],
        ["框已标", datasetMetricValue(dataset, "qwen_bbox.cached_images")],
        ["可疑", audit ? compactNumber(audit.review_queue_images) : "-"]
      ].forEach(([label, value]) => {
        const metric = createNode("div", "yolo-review-dataset-metric");
        metric.appendChild(createNode("span", "", label));
        metric.appendChild(createNode("strong", "", value));
        metrics.appendChild(metric);
      });
      button.appendChild(metrics);

      const foot = createNode("div", "yolo-review-dataset-card-foot");
      if (state.activeEvent !== "all") {
        foot.appendChild(createNode("span", "", `总样本 ${compactNumber(dataset.total_images)}`));
        foot.appendChild(createNode("span", "", `总框 ${compactNumber(datasetTotalBoxes(dataset))}`));
      }
      foot.appendChild(createNode("span", "", `语义待标 ${datasetMetricValue(dataset, "qwen_label.pending_images", "0")}`));
      foot.appendChild(createNode("span", "", `框待标 ${datasetMetricValue(dataset, "qwen_bbox.pending_images", "0")}`));
      if (audit) {
        foot.appendChild(createNode("span", "", `待质检 ${compactNumber(audit.pending_images)}`));
        foot.appendChild(createNode("span", "", `质检通过 ${compactNumber(audit.pass_images)}`));
      }
      if (dataset.created_at) {
        foot.appendChild(createNode("span", "", formatDate(dataset.created_at)));
      }
      button.appendChild(foot);
      refs.datasetCards.appendChild(button);
    });
  }

  function dailyProgressCell(stat, prefix) {
    const done = Number(stat?.[`${prefix}_done`] || 0);
    const pending = Number(stat?.[`${prefix}_pending`] || 0);
    const applicable = done + pending;
    const wrap = createNode("div", "yolo-review-daily-progress");
    wrap.appendChild(createNode("strong", "", `${compactNumber(done)} / ${compactNumber(applicable)}`));
    wrap.appendChild(createNode("span", "", `${percentText(done, applicable)} · 待 ${compactNumber(pending)}`));
    return wrap;
  }

  function renderDailyTotals(totals) {
    const metrics = createNode("div", "yolo-review-daily-totals");
    [
      ["近14天上传", compactNumber(totals?.total_images)],
      ["车辆自采", compactNumber(totals?.vehicle_collection_images)],
      ["云端抓拍", compactNumber(totals?.cloud_camera_images)],
      ["框已标", compactNumber(totals?.qwen_bbox_done)],
      ["框待标", compactNumber(totals?.qwen_bbox_pending)],
      ["阳性图片", compactNumber(totals?.positive_images)],
      ["人工保存", compactNumber(totals?.manual_saved)]
    ].forEach(([label, value]) => {
      const item = createNode("div", "yolo-review-daily-total");
      item.appendChild(createNode("span", "", label));
      item.appendChild(createNode("strong", "", value));
      metrics.appendChild(item);
    });
    return metrics;
  }

  function renderDailyStatsError(error) {
    if (!refs.dailyStats) return;
    refs.dailyStats.innerHTML = "";
    refs.dailyStats.appendChild(createNode("p", "yolo-review-empty", `每日统计加载失败：${error?.message || "未知错误"}`));
  }

  function renderDailyStats() {
    if (!refs.dailyStats) return;
    refs.dailyStats.innerHTML = "";
    const payload = state.dailyStats;
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    if (!payload || !rows.length) {
      refs.dailyStats.appendChild(createNode("p", "yolo-review-empty", "暂无每日统计。"));
      return;
    }

    const head = createNode("div", "yolo-review-daily-head");
    const title = createNode("div", "yolo-review-daily-title");
    title.appendChild(createNode("strong", "", "每日上传与标注"));
    title.appendChild(createNode("span", "", `近 ${payload.days || rows.length} 天 · ${payload.time_zone || "Asia/Shanghai"}`));
    head.appendChild(title);
    const indexText = payload.index_built_at ? `索引 ${formatDate(payload.index_built_at)}` : "索引时间未知";
    head.appendChild(createNode("p", "yolo-review-daily-meta", indexText));
    refs.dailyStats.appendChild(head);
    refs.dailyStats.appendChild(renderDailyTotals(payload.totals || {}));

    const tableWrap = createNode("div", "yolo-review-daily-table-wrap");
    const table = createNode("table", "yolo-review-daily-table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    ["日期", "上传", "来源", "Qwen框", "Qwen语义", "阳性/框", "人工", "主要内容"].forEach((label) => {
      headRow.appendChild(createNode("th", "", label));
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    rows.forEach((stat) => {
      const tr = document.createElement("tr");
      tr.appendChild(createNode("td", "yolo-review-daily-date", formatDay(stat.date)));
      tr.appendChild(createNode("td", "", compactNumber(stat.total_images)));
      const sourceCell = createNode("td", "", "");
      sourceCell.appendChild(createNode("span", "", `车 ${compactNumber(stat.vehicle_collection_images)}`));
      sourceCell.appendChild(createNode("span", "", `云 ${compactNumber(stat.cloud_camera_images)}`));
      if (Number(stat.other_source_images || 0) > 0) {
        sourceCell.appendChild(createNode("span", "", `其他 ${compactNumber(stat.other_source_images)}`));
      }
      tr.appendChild(sourceCell);
      const bboxCell = document.createElement("td");
      bboxCell.appendChild(dailyProgressCell(stat, "qwen_bbox"));
      tr.appendChild(bboxCell);
      const labelCell = document.createElement("td");
      labelCell.appendChild(dailyProgressCell(stat, "qwen_label"));
      tr.appendChild(labelCell);
      const positiveCell = createNode("td", "", "");
      positiveCell.appendChild(createNode("span", "", `阳 ${compactNumber(stat.positive_images)}`));
      positiveCell.appendChild(createNode("span", "", `框 ${compactNumber(stat.boxes)}`));
      tr.appendChild(positiveCell);
      const manualCell = createNode("td", "", "");
      manualCell.appendChild(createNode("span", "", `存 ${compactNumber(stat.manual_saved)}`));
      manualCell.appendChild(createNode("span", "", `框 ${compactNumber(stat.manual_boxes)}`));
      tr.appendChild(manualCell);
      const topCell = createNode("td", "yolo-review-daily-top", "");
      topCell.appendChild(createNode("span", "", topCountText(stat.top_classes)));
      topCell.appendChild(createNode("span", "", topCountText(stat.top_vehicles, 2)));
      tr.appendChild(topCell);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    refs.dailyStats.appendChild(tableWrap);
  }

  async function loadDailyStats() {
    renderLoadingNode(refs.dailyStats, "每日统计加载中...", { compact: true });
    const data = await requestJson(endpoints.dailyStats);
    state.dailyStats = data;
    renderDailyStats();
  }

  function renderSummary(dataset) {
    if (!refs.summary) return;
    refs.summary.innerHTML = "";
    if (!dataset) {
      refs.summary.appendChild(createNode("p", "yolo-review-empty", "暂无数据集。"));
      return;
    }

    const eventMetrics = datasetEventMetrics(dataset);
    const cells = [
      ["来源", datasetSourceText(dataset)],
      ["Profile", dataset.profile || dataset.name || "-"],
      ["类型", dataset.kind === "classify" ? "分类" : "检测"],
      [state.activeEvent === "all" ? "样本" : "事件样本", compactNumber(eventMetrics.imageCount)],
      [state.activeEvent === "all" ? "框" : "事件框", dataset.boxes || eventMetrics.boxCount ? compactNumber(eventMetrics.boxCount) : "-"],
      ["AI YES", dataset.answers?.YES != null ? compactNumber(dataset.answers.YES) : "-"],
      ["AI NO", dataset.answers?.NO != null ? compactNumber(dataset.answers.NO) : "-"]
    ];
    const audit = datasetQwenAudit(dataset);
    if (audit) {
      cells.push(["可疑待校核", compactNumber(audit.review_queue_images)]);
      cells.push(["质检通过", compactNumber(audit.pass_images)]);
      cells.push(["待质检", compactNumber(audit.pending_images)]);
    }
    if (state.activeEvent !== "all") {
      cells.push(["总样本", compactNumber(dataset.total_images)]);
      cells.push(["总框", compactNumber(datasetTotalBoxes(dataset))]);
    }
    if (dataset.qwen_bbox || dataset.summary?.qwen_bbox) {
      const qwenBbox = dataset.qwen_bbox || dataset.summary.qwen_bbox;
      cells.push(["Qwen框已标", compactNumber(qwenBbox.cached_images)]);
      cells.push(["Qwen框待标", compactNumber(qwenBbox.pending_images)]);
      cells.push(["Qwen框阳性", compactNumber(qwenBbox.positive_images)]);
      cells.push(["Qwen框数", compactNumber(qwenBbox.boxes)]);
      if (qwenBbox.verified_sensitive) {
        cells.push(["Qwen校验覆盖", compactNumber(qwenBbox.verified_sensitive.cached_images)]);
        cells.push(["校验敏感阳性", compactNumber(qwenBbox.verified_sensitive.positive_images)]);
        cells.push(["校验敏感框", compactNumber(qwenBbox.verified_sensitive.boxes)]);
      }
    }
    if (dataset.qwen_label || dataset.summary?.qwen_label) {
      const qwen = dataset.qwen_label || dataset.summary.qwen_label;
      cells.push(["Qwen语义已标", compactNumber(qwen.cached_images)]);
      cells.push(["Qwen语义待标", compactNumber(qwen.pending_images)]);
      cells.push(["Qwen语义候选", compactNumber(qwen.positive_images)]);
    }

    cells.forEach(([label, value]) => {
      const item = createNode("div", "yolo-review-summary-item");
      item.appendChild(createNode("p", "yolo-review-summary-label", label));
      item.appendChild(createNode("p", "yolo-review-summary-value", value));
      refs.summary.appendChild(item);
    });
  }

  function refreshDatasetOptions(options = {}) {
    let selectedSource = refs.source?.value || "";
    state.eventDatasets = state.allDatasets.filter(datasetIsReviewVisible).filter((dataset) => datasetMatchesEvent(dataset));
    const filterBySource = (source) => state.eventDatasets.filter((dataset) => {
      if (!source) return true;
      return datasetSourceGroup(dataset) === source;
    });
    state.datasets = filterBySource(selectedSource);
    if (!refs.dataset) return;
    refs.dataset.innerHTML = "";
    state.datasets.forEach((dataset) => {
      const option = document.createElement("option");
      option.value = dataset.id;
      option.textContent = datasetLabel(dataset);
      refs.dataset.appendChild(option);
    });
    if (options.forceDefault || !state.datasets.some((dataset) => dataset.id === state.datasetId)) {
      state.datasetId = pickDefaultDataset(state.datasets)?.id || "";
    }
    refs.dataset.value = state.datasetId;
    renderDatasetCards();
  }

  async function loadDatasets() {
    setStatus("加载数据集...", "loading");
    renderDatasetLoading();
    loadDailyStats().catch(renderDailyStatsError);
    try {
      const data = await requestJson(endpoints.datasets);
      state.allDatasets = Array.isArray(data.datasets) ? data.datasets : [];
      configureSourceOptions();
      refreshDatasetOptions({ forceDefault: true });
      if (!state.datasetId && state.datasets.length) {
        state.datasetId = state.datasets[0].id;
      }
      if (refs.dataset) refs.dataset.value = state.datasetId;
      updateClassOptions();
      updateQwenOptions();
      applyEventFiltersForDataset(selectedDataset());
      renderDatasetCards();
      renderSummary(selectedDataset());
      updateEventButtons();
      await loadItems({ resetPage: true });
      setStatus("已加载", "ok");
    } catch (error) {
      setStatus(`加载失败：${error?.message || "未知错误"}`, "error");
      if (refs.datasetStatus) refs.datasetStatus.textContent = "数据集加载失败。";
      if (refs.sourceCards) {
        refs.sourceCards.innerHTML = "";
        refs.sourceCards.appendChild(createNode("p", "yolo-review-empty", "来源加载失败。"));
      }
      if (refs.datasetCards) {
        refs.datasetCards.innerHTML = "";
        refs.datasetCards.appendChild(createNode("p", "yolo-review-empty", "数据集加载失败。"));
      }
      refs.list.innerHTML = "";
      refs.list.appendChild(createNode("p", "yolo-review-empty", "数据集加载失败。"));
      renderSummary(null);
    }
  }

  function updateClassOptions() {
    const dataset = selectedDataset();
    const classes = Array.isArray(dataset?.classes) ? dataset.classes : [];
    setSelectOptions(
      refs.className,
      classes.map((className) => ({ value: normalizeClassToken(className), label: className })),
      { allLabel: "全部" }
    );
  }

  function updateQwenOptions() {
    const dataset = selectedDataset();
    const options = dataset?.qwen_label?.filter_options || dataset?.summary?.qwen_label?.filter_options || [];
    setSelectOptions(
      refs.qwenLabel,
      (Array.isArray(options) ? options : []).map((item) => ({
        value: item.value || item,
        label: qwenLabelText(item.label || item.value || item)
      })),
      { allLabel: "全部" }
    );
  }

  function updateSplitOptions(splits) {
    setSelectOptions(
      refs.split,
      (Array.isArray(splits) ? splits : []).map((split) => ({ value: split, label: split })),
      { allLabel: "全部" }
    );
  }

  function buildItemsUrl() {
    const params = new URLSearchParams();
    const dataset = selectedDataset();
    const preset = eventPresets[state.activeEvent] || eventPresets.all;
    params.set("dataset_id", state.datasetId);
    params.set("page", String(state.page));
    params.set("page_size", String(state.pageSize));
    if (refs.split.value) params.set("split", refs.split.value);
    const eventClassFilter = datasetSourceGroup(dataset) === "vehicle_collection" && reviewTaskKind(dataset) === "detect"
      ? matchingDatasetEventClassTokens(dataset, preset).join(",")
      : "";
    const classFilter = eventClassFilter || refs.className.value;
    if (classFilter) params.set("class_name", classFilter);
    if (refs.answer.value) params.set("ai_answer", refs.answer.value);
    if (refs.qwenLabel?.value) params.set("qwen_label", refs.qwenLabel.value);
    if (refs.qwenAudit?.value) params.set("qwen_audit", refs.qwenAudit.value);
    if (refs.hasBox?.checked) params.set("has_box", "1");
    if (refs.query.value.trim()) params.set("q", refs.query.value.trim());
    return `${endpoints.items}?${params.toString()}`;
  }

  async function loadItems(options = {}) {
    if (options.resetPage) state.page = 1;
    if (!state.datasetId) {
      refs.list.classList.remove("is-loading");
      refs.list.innerHTML = "";
      refs.list.appendChild(createNode("p", "yolo-review-empty", "暂无数据集。"));
      if (refs.page) refs.page.textContent = "第 1 / 1 页 · 0 条";
      if (refs.prev) refs.prev.disabled = true;
      if (refs.next) refs.next.disabled = true;
      setStatus("当前来源暂无数据集", "ok");
      resetDetail("暂无样本。");
      return;
    }

    const requestDatasetId = state.datasetId;
    const requestEvent = state.activeEvent;
    const requestSource = refs.source?.value || "";
    setStatus("加载样本...", "loading");
    refs.list.classList.add("is-loading");
    refs.list.innerHTML = "";
    const loading = createNode("div", "yolo-review-loading");
    loading.appendChild(createNode("span", "yolo-review-spinner"));
    loading.appendChild(createNode("p", "", "样本加载中..."));
    refs.list.appendChild(loading);
    try {
      const data = await requestJson(buildItemsUrl());
      if (requestDatasetId !== state.datasetId || requestEvent !== state.activeEvent || requestSource !== (refs.source?.value || "")) {
        return;
      }
      refs.list.classList.remove("is-loading");
      state.page = data.page || 1;
      state.totalPages = data.total_pages || 1;
      updateSplitOptions(data.available_splits || []);
      renderList(data.items || []);
      refs.page.textContent = `第 ${state.page} / ${state.totalPages} 页 · ${compactNumber(data.total)} 条`;
      refs.prev.disabled = state.page <= 1;
      refs.next.disabled = state.page >= state.totalPages;
      setStatus("样本就绪", "ok");
      if (!state.selectedItemKey) {
        resetDetail("点击左侧样本后加载原图和标注框。");
      }
    } catch (error) {
      if (requestDatasetId !== state.datasetId || requestEvent !== state.activeEvent || requestSource !== (refs.source?.value || "")) {
        return;
      }
      refs.list.classList.remove("is-loading");
      setStatus(`样本加载失败：${error?.message || "未知错误"}`, "error");
      refs.list.innerHTML = "";
      refs.list.appendChild(createNode("p", "yolo-review-empty", "样本加载失败。"));
    }
  }

  function renderList(items) {
    refs.list.innerHTML = "";
    if (!items.length) {
      refs.list.appendChild(createNode("p", "yolo-review-empty", "没有符合条件的样本。"));
      return;
    }

    items.forEach((item) => {
      const button = createNode("button", "yolo-review-item");
      button.type = "button";
      button.dataset.itemKey = item.item_key;
      button.classList.toggle("is-active", item.item_key === state.selectedItemKey);
      button.addEventListener("click", () => loadDetail(item.item_key));

      const thumb = createNode("div", "yolo-review-thumb");
      const img = document.createElement("img");
      img.src = item.thumb_url || item.image_url;
      img.alt = item.item_key;
      img.loading = "lazy";
      img.decoding = "async";
      thumb.appendChild(img);

      const body = createNode("div", "yolo-review-item-body");
      const top = createNode("div", "yolo-review-item-top");
      const dataset = selectedDataset();
      const isClassify = reviewTaskKind(dataset) === "classify";
      const titleText = isClassify
        ? `${answerDisplay(item.ai_answer)} · ${item.ai_class || item.event_name || "分类样本"}`
        : qwenCountSummary(item) || item.ai_class || item.event_name || item.source_label || "-";
      top.appendChild(createNode("p", "yolo-review-item-title", titleText));
      top.appendChild(createNode("span", `ai-history-chip ${answerTone(item.ai_answer)}`, answerDisplay(item.ai_answer)));
      body.appendChild(top);
      const metaText = item.source_type === "vehicle_collection"
        ? `${item.split || "-"} · ${item.vehicle_id || item.device_id || "-"} · ${item.camera_id || "-"} · ${formatDate(item.collected_at)}`
        : `${item.split || "-"} · ${item.request_id || "-"} · task ${item.task_row_id || item.task_id || "-"}`;
      body.appendChild(createNode("p", "yolo-review-item-meta", metaText));

      const chips = createNode("div", "yolo-review-item-chips");
      chips.appendChild(createNode("span", "ai-history-chip tone-idle", datasetSourceText(dataset || item)));
      chips.appendChild(createNode("span", "ai-history-chip tone-idle", `${item.label_count || 0} 框`));
      const labelSource = labelSourceText(item.label_source);
      if (labelSource) {
        chips.appendChild(createNode("span", `ai-history-chip ${labelSourceTone(item.label_source)}`, labelSource));
      } else if (item.label_source === "yolo_auto") {
        chips.appendChild(createNode("span", "ai-history-chip tone-idle", "YOLO预标"));
      }
      if (item.auto_label_status) {
        chips.appendChild(createNode("span", `ai-history-chip ${item.auto_label_status === "done" ? "tone-yes" : "tone-idle"}`, item.auto_label_status === "done" ? "已预标注" : "待预标注"));
      }
      if (item.qwen_label_status) {
        chips.appendChild(createNode("span", `ai-history-chip ${item.qwen_label_status === "done" ? "tone-yes" : "tone-idle"}`, item.qwen_label_status === "done" ? "Qwen已标" : item.qwen_label_status === "pending" ? "Qwen待标" : "Qwen不适用"));
      }
      if (item.qwen_quality) {
        chips.appendChild(createNode("span", "ai-history-chip tone-idle", qwenLabelText(`quality:${item.qwen_quality}`)));
      }
      if (item.qwen_bbox_status === "done") {
        const auditText = qwenAuditSummary(item);
        const auditTone = qwenAuditTone(item.qwen_bbox_audit_verdict, item.qwen_bbox_audit_severity);
        chips.appendChild(createNode("span", `ai-history-chip ${auditTone}`, auditText || "待质检"));
      }
      (item.qwen_flags || []).slice(0, 2).forEach((flag) => {
        chips.appendChild(createNode("span", "ai-history-chip tone-idle", qwenLabelText(flag)));
      });
      body.appendChild(chips);

      button.appendChild(thumb);
      button.appendChild(body);
      refs.list.appendChild(button);
    });
  }

  function metaItem(label, value) {
    const item = createNode("div", "yolo-review-meta-item");
    item.appendChild(createNode("p", "yolo-review-meta-label", label));
    item.appendChild(createNode("p", "yolo-review-meta-value", value == null || value === "" ? "-" : String(value)));
    return item;
  }

  function renderQwenLabelSection(item) {
    const wrap = createNode("div", "yolo-review-labels");
    const head = createNode("div", "yolo-review-section-head");
    head.appendChild(createNode("h3", "", "Qwen 语义筛选"));
    const status = item.qwen_label_status === "done" ? "已标注" : item.qwen_label_status === "pending" ? "待标注" : "不适用";
    head.appendChild(createNode("span", `ai-history-chip ${item.qwen_label_status === "done" ? "tone-yes" : "tone-idle"}`, status));
    wrap.appendChild(head);

    const qwen = item.qwen_label;
    if (!qwen) {
      wrap.appendChild(createNode("p", "yolo-review-label-line", item.qwen_label_status === "pending" ? "等待增量标注任务处理。" : "该样本没有 Qwen 自动标注。"));
      return wrap;
    }

    const countSummary = qwenCountSummary(item);
    wrap.appendChild(createNode("p", "yolo-review-label-line", `质量: ${qwenLabelText(`quality:${qwen.quality}`)} · 候选: ${countSummary || "无目标"} · 无框`));
    if (Array.isArray(qwen.flags) && qwen.flags.length) {
      wrap.appendChild(createNode("p", "yolo-review-label-line", `flags: ${qwen.flags.map(qwenLabelText).join(" / ")}`));
    }
    if (Array.isArray(qwen.tags) && qwen.tags.length) {
      wrap.appendChild(createNode("p", "yolo-review-label-line", `tags: ${qwen.tags.join(" / ")}`));
    }
    if (Array.isArray(qwen.risk) && qwen.risk.length) {
      wrap.appendChild(createNode("p", "yolo-review-label-line", `risk: ${qwen.risk.join(" / ")}`));
    }
    const trace = [
      qwen.model || "",
      qwen.duration_ms != null ? `${qwen.duration_ms}ms` : "",
      qwen.annotated_at ? formatDate(qwen.annotated_at) : "",
      item.qwen_label_rel_path || ""
    ].filter(Boolean).join(" · ");
    if (trace) {
      wrap.appendChild(createNode("p", "yolo-review-label-line", trace));
    }
    return wrap;
  }

  function renderQwenAuditSection(item) {
    const wrap = createNode("div", "yolo-review-labels yolo-review-audit");
    const head = createNode("div", "yolo-review-section-head");
    head.appendChild(createNode("h3", "", "Qwen 框质检"));
    const verdict = item.qwen_bbox_audit_verdict || item.qwen_bbox_audit?.verdict || "";
    const status = item.qwen_bbox_audit_status || (item.qwen_bbox_status === "done" ? "pending" : "not_applicable");
    const severity = item.qwen_bbox_audit_severity || item.qwen_bbox_audit?.severity || "";
    head.appendChild(createNode("span", `ai-history-chip ${qwenAuditTone(verdict, severity)}`, qwenAuditText(verdict, status) || "待质检"));
    wrap.appendChild(head);

    const audit = item.qwen_bbox_audit;
    if (!audit) {
      const text = status === "pending"
        ? "已有 Qwen 框，等待质检脚本处理。"
        : "该样本没有可质检的 Qwen 框。";
      wrap.appendChild(createNode("p", "yolo-review-label-line", text));
      return wrap;
    }

    const reasons = Array.isArray(audit.reasons) ? audit.reasons : [];
    wrap.appendChild(createNode(
      "p",
      "yolo-review-label-line",
      `结论: ${qwenAuditText(audit.verdict, audit.status)} · 等级: ${audit.severity || "-"} · 置信度: ${audit.confidence != null ? Math.round(Number(audit.confidence) * 100) + "%" : "-"}`
    ));
    if (reasons.length) {
      wrap.appendChild(createNode("p", "yolo-review-label-line", `原因: ${reasons.slice(0, 8).join(" / ")}`));
    }
    const suspicious = Array.isArray(audit.suspicious_labels) ? audit.suspicious_labels : [];
    if (suspicious.length) {
      const list = createNode("div", "yolo-review-audit-list");
      suspicious.slice(0, 20).forEach((entry) => {
        const line = createNode("p", "yolo-review-label-line");
        line.textContent = `框#${Number(entry.index) + 1} ${entry.class_name || ""} · ${entry.issue || "suspect"} · 应为 ${entry.should || "review"} · ${entry.reason || "-"}`;
        list.appendChild(line);
      });
      wrap.appendChild(list);
    }
    const missing = Array.isArray(audit.missing_candidates) ? audit.missing_candidates : [];
    if (missing.length) {
      const list = createNode("div", "yolo-review-audit-list");
      missing.slice(0, 12).forEach((entry) => {
        const line = createNode("p", "yolo-review-label-line");
        const confidence = Number(entry.confidence);
        const confidenceText = Number.isFinite(confidence) ? ` · ${(confidence * 100).toFixed(0)}%` : "";
        line.textContent = `疑似漏标 ${entry.class_name || ""}${confidenceText} · ${entry.reason || "-"}`;
        list.appendChild(line);
      });
      wrap.appendChild(list);
    }
    const trace = [
      audit.model_bundle || audit.model || "",
      audit.prompt_version || "",
      audit.duration_ms != null ? `${audit.duration_ms}ms` : "",
      audit.audited_at ? formatDate(audit.audited_at) : "",
      item.qwen_bbox_audit_rel_path || audit.rel_path || ""
    ].filter(Boolean).join(" · ");
    if (trace) {
      wrap.appendChild(createNode("p", "yolo-review-label-line", trace));
    }
    return wrap;
  }

  function clampPercent(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return Math.max(0, Math.min(100, num));
  }

  function renderBoxes(overlay, labels) {
    overlay.innerHTML = "";
    (Array.isArray(labels) ? labels : []).forEach((label) => {
      if (![label.x, label.y, label.w, label.h].every((value) => Number.isFinite(Number(value)))) return;
      const left = clampPercent((Number(label.x) - Number(label.w) / 2) * 100);
      const top = clampPercent((Number(label.y) - Number(label.h) / 2) * 100);
      const width = clampPercent(Number(label.w) * 100);
      const height = clampPercent(Number(label.h) * 100);
      const box = createNode("div", "yolo-review-box");
      box.style.left = `${left}%`;
      box.style.top = `${top}%`;
      box.style.width = `${width}%`;
      box.style.height = `${height}%`;
      const confidence = Number(label.confidence);
      const suffix = Number.isFinite(confidence) ? ` ${(confidence * 100).toFixed(0)}%` : "";
      box.appendChild(createNode("span", "", `${label.class_name || String(label.class_id ?? "")}${suffix}`));
      overlay.appendChild(box);
    });
  }

  function clampUnit(value, fallback = 0) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(0, Math.min(1, num));
  }

  function normalizeEditorLabel(label, index, dataset) {
    const classes = Array.isArray(dataset?.classes) ? dataset.classes : [];
    const className = String(label?.class_name || label?.label || classes[0] || "object").trim() || "object";
    const classIndex = classes.findIndex((item) => normalizeClassToken(item) === normalizeClassToken(className));
    const w = Math.max(0.002, Math.min(1, Number(label?.w) || 0.18));
    const h = Math.max(0.002, Math.min(1, Number(label?.h) || 0.18));
    const x = Math.max(w / 2, Math.min(1 - w / 2, clampUnit(label?.x, 0.5)));
    const y = Math.max(h / 2, Math.min(1 - h / 2, clampUnit(label?.y, 0.5)));
    return {
      index,
      class_id: classIndex >= 0 ? classIndex : (Number.isFinite(Number(label?.class_id)) ? Number(label.class_id) : null),
      class_name: className,
      x,
      y,
      w,
      h,
      source: "manual"
    };
  }

  function labelToBoxStyle(label) {
    const w = clampUnit(label.w, 0.1);
    const h = clampUnit(label.h, 0.1);
    const x = clampUnit(label.x, 0.5);
    const y = clampUnit(label.y, 0.5);
    return {
      left: `${Math.max(0, (x - w / 2) * 100)}%`,
      top: `${Math.max(0, (y - h / 2) * 100)}%`,
      width: `${Math.max(0.2, Math.min(100, w * 100))}%`,
      height: `${Math.max(0.2, Math.min(100, h * 100))}%`
    };
  }

  function pointerToOverlayUnit(event, overlay) {
    const rect = overlay.getBoundingClientRect();
    const x = rect.width ? (event.clientX - rect.left) / rect.width : 0;
    const y = rect.height ? (event.clientY - rect.top) / rect.height : 0;
    return { x: clampUnit(x), y: clampUnit(y) };
  }

  function makeEditorState(dataset, item, kind = reviewTaskKind(dataset)) {
    const labels = (Array.isArray(item.labels) ? item.labels : [])
      .map((label, index) => normalizeEditorLabel(label, index, dataset));
    const defaultClassName = labels[0]?.class_name || item.manual_annotation?.class_name || item.ai_class || dataset.classes?.[0] || "";
    return {
      dataset,
      item,
      labels,
      selectedIndex: labels.length ? 0 : -1,
      drawMode: false,
      dirty: false,
      answer: answerDisplay(item.ai_answer) === "Yes" ? "YES" : answerDisplay(item.ai_answer) === "No" ? "NO" : (kind === "detect" ? (labels.length ? "YES" : "NO") : "YES"),
      className: item.manual_annotation?.class_name || item.ai_class || dataset.classes?.[0] || "",
      newClassName: defaultClassName
    };
  }

  function restoreEditorState(editor, source) {
    editor.labels = source.labels.map((label, index) => ({ ...label, index }));
    editor.selectedIndex = editor.labels.length ? Math.min(Math.max(Number(source.selectedIndex) || 0, 0), editor.labels.length - 1) : -1;
    editor.drawMode = false;
    editor.dirty = false;
    editor.answer = source.answer;
    editor.className = source.className;
    editor.newClassName = source.newClassName;
  }

  function renumberLabels(editor) {
    editor.labels = editor.labels.map((label, index) => ({ ...label, index }));
    if (editor.selectedIndex >= editor.labels.length) editor.selectedIndex = editor.labels.length - 1;
  }

  function markEditorDirty(editor, saveButton) {
    editor.dirty = true;
    if (saveButton) saveButton.disabled = false;
  }

  function renderDetectEditor({ dataset, item, editor, overlay, panel, saveButton }) {
    panel.innerHTML = "";
    overlay.innerHTML = "";
    overlay.classList.add("is-editable");
    overlay.classList.toggle("is-drawing", editor.drawMode);
    overlay.dataset.drawMode = editor.drawMode ? "true" : "false";

    const toolbar = createNode("div", "yolo-review-edit-toolbar");
    const addButton = createNode("button", "yolo-review-tool-button", editor.drawMode ? "正在画框" : "新增框");
    addButton.type = "button";
    addButton.classList.toggle("is-active", editor.drawMode);
    const newClassField = createNode("label", "yolo-review-tool-field");
    newClassField.appendChild(createNode("span", "", "新框标签"));
    const newClassSelect = document.createElement("select");
    const newClassOptions = dataset.classes?.length ? dataset.classes : [editor.newClassName || editor.className || "object"];
    newClassOptions.forEach((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      newClassSelect.appendChild(option);
    });
    if (editor.newClassName && ![...newClassSelect.options].some((option) => normalizeClassToken(option.value) === normalizeClassToken(editor.newClassName))) {
      const option = document.createElement("option");
      option.value = editor.newClassName;
      option.textContent = editor.newClassName;
      newClassSelect.appendChild(option);
    }
    newClassSelect.value = editor.newClassName || newClassOptions[0] || "";
    newClassSelect.addEventListener("change", () => {
      editor.newClassName = newClassSelect.value;
    });
    newClassField.appendChild(newClassSelect);
    const deleteButton = createNode("button", "yolo-review-tool-button yolo-review-tool-button--danger", "删除框");
    deleteButton.type = "button";
    deleteButton.disabled = editor.selectedIndex < 0;
    toolbar.appendChild(addButton);
    toolbar.appendChild(newClassField);
    toolbar.appendChild(deleteButton);
    toolbar.appendChild(createNode("span", "yolo-review-edit-status", `${editor.labels.length} 个框`));
    panel.appendChild(toolbar);

    const list = createNode("div", "yolo-review-label-editor-list");
    panel.appendChild(list);

    function rerender() {
      renumberLabels(editor);
      renderDetectEditor({ dataset, item, editor, overlay, panel, saveButton });
    }

    addButton.addEventListener("click", () => {
      editor.drawMode = !editor.drawMode;
      rerender();
    });
    deleteButton.addEventListener("click", () => {
      if (editor.selectedIndex < 0) return;
      editor.labels.splice(editor.selectedIndex, 1);
      editor.selectedIndex = Math.min(editor.selectedIndex, editor.labels.length - 1);
      editor.answer = editor.labels.length ? "YES" : "NO";
      markEditorDirty(editor, saveButton);
      rerender();
    });

    editor.labels.forEach((label, index) => {
      const box = createNode("div", "yolo-review-box yolo-review-box--editable");
      box.classList.toggle("is-selected", index === editor.selectedIndex);
      const style = labelToBoxStyle(label);
      Object.assign(box.style, style);
      box.dataset.index = String(index);
      box.appendChild(createNode("span", "", label.class_name || `#${index + 1}`));
      ["nw", "ne", "sw", "se"].forEach((pos) => {
        const handle = createNode("i", `yolo-review-box-handle yolo-review-box-handle--${pos}`);
        handle.dataset.handle = pos;
        box.appendChild(handle);
      });
      overlay.appendChild(box);

      box.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        editor.selectedIndex = index;
        const handle = event.target?.dataset?.handle || "move";
        const start = pointerToOverlayUnit(event, overlay);
        const original = { ...editor.labels[index] };
        box.setPointerCapture?.(event.pointerId);
        box.classList.add("is-dragging");
        function move(moveEvent) {
          const point = pointerToOverlayUnit(moveEvent, overlay);
          const dx = point.x - start.x;
          const dy = point.y - start.y;
          const next = { ...original };
          if (handle === "move") {
            next.x = Math.max(next.w / 2, Math.min(1 - next.w / 2, original.x + dx));
            next.y = Math.max(next.h / 2, Math.min(1 - next.h / 2, original.y + dy));
          } else {
            let left = original.x - original.w / 2;
            let right = original.x + original.w / 2;
            let top = original.y - original.h / 2;
            let bottom = original.y + original.h / 2;
            if (handle.includes("w")) left = clampUnit(left + dx);
            if (handle.includes("e")) right = clampUnit(right + dx);
            if (handle.includes("n")) top = clampUnit(top + dy);
            if (handle.includes("s")) bottom = clampUnit(bottom + dy);
            if (right < left) [left, right] = [right, left];
            if (bottom < top) [top, bottom] = [bottom, top];
            next.w = Math.max(0.002, right - left);
            next.h = Math.max(0.002, bottom - top);
            next.x = Math.max(next.w / 2, Math.min(1 - next.w / 2, (left + right) / 2));
            next.y = Math.max(next.h / 2, Math.min(1 - next.h / 2, (top + bottom) / 2));
          }
          editor.labels[index] = next;
          Object.assign(box.style, labelToBoxStyle(next));
          markEditorDirty(editor, saveButton);
        }
        function end(endEvent) {
          box.classList.remove("is-dragging");
          box.releasePointerCapture?.(endEvent.pointerId);
          box.removeEventListener("pointermove", move);
          box.removeEventListener("pointerup", end);
          box.removeEventListener("pointercancel", end);
          rerender();
        }
        box.addEventListener("pointermove", move);
        box.addEventListener("pointerup", end);
        box.addEventListener("pointercancel", end);
      });
    });

    let drawing = null;
    overlay.onpointerdown = (event) => {
      if (!editor.drawMode || event.target !== overlay) return;
      event.preventDefault();
      drawing = pointerToOverlayUnit(event, overlay);
      const draft = createNode("div", "yolo-review-box yolo-review-box--draft");
      overlay.appendChild(draft);
      overlay.setPointerCapture?.(event.pointerId);
      function move(moveEvent) {
        const point = pointerToOverlayUnit(moveEvent, overlay);
        const left = Math.min(drawing.x, point.x);
        const top = Math.min(drawing.y, point.y);
        const w = Math.abs(point.x - drawing.x);
        const h = Math.abs(point.y - drawing.y);
        Object.assign(draft.style, {
          left: `${left * 100}%`,
          top: `${top * 100}%`,
          width: `${Math.max(0.2, w * 100)}%`,
          height: `${Math.max(0.2, h * 100)}%`
        });
      }
      function end(endEvent) {
        const point = pointerToOverlayUnit(endEvent, overlay);
        draft.remove();
        overlay.releasePointerCapture?.(endEvent.pointerId);
        overlay.removeEventListener("pointermove", move);
        overlay.removeEventListener("pointerup", end);
        overlay.removeEventListener("pointercancel", end);
        const left = Math.min(drawing.x, point.x);
        const right = Math.max(drawing.x, point.x);
        const top = Math.min(drawing.y, point.y);
        const bottom = Math.max(drawing.y, point.y);
        if (right - left > 0.004 && bottom - top > 0.004) {
          const className = editor.newClassName || dataset.classes?.[0] || editor.className || "object";
          editor.labels.push(normalizeEditorLabel({
            class_name: className,
            x: (left + right) / 2,
            y: (top + bottom) / 2,
            w: right - left,
            h: bottom - top
          }, editor.labels.length, dataset));
          editor.selectedIndex = editor.labels.length - 1;
          editor.answer = "YES";
          markEditorDirty(editor, saveButton);
        }
        editor.drawMode = false;
        drawing = null;
        rerender();
      }
      overlay.addEventListener("pointermove", move);
      overlay.addEventListener("pointerup", end);
      overlay.addEventListener("pointercancel", end);
    };

    if (!editor.labels.length) {
      list.appendChild(createNode("p", "yolo-review-label-line", "先选择新框标签，再点击新增框，在图片上拖拽画框。"));
      return;
    }

    editor.labels.forEach((label, index) => {
      const row = createNode("div", "yolo-review-label-editor-row");
      row.classList.toggle("is-selected", index === editor.selectedIndex);
      row.addEventListener("click", () => {
        editor.selectedIndex = index;
        rerender();
      });
      const labelIndex = createNode("strong", "", String(index + 1));
      row.appendChild(labelIndex);
      const select = document.createElement("select");
      const classOptions = dataset.classes?.length ? dataset.classes : [label.class_name || "object"];
      classOptions.forEach((name) => {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        select.appendChild(option);
      });
      if (![...select.options].some((option) => normalizeClassToken(option.value) === normalizeClassToken(label.class_name))) {
        const option = document.createElement("option");
        option.value = label.class_name;
        option.textContent = label.class_name;
        select.appendChild(option);
      }
      select.value = label.class_name;
      select.addEventListener("change", () => {
        editor.labels[index] = normalizeEditorLabel({ ...editor.labels[index], class_name: select.value }, index, dataset);
        editor.newClassName = select.value;
        editor.selectedIndex = index;
        markEditorDirty(editor, saveButton);
        rerender();
      });
      row.appendChild(select);
      select.addEventListener("click", (event) => event.stopPropagation());
      const remove = createNode("button", "yolo-review-row-delete", "删");
      remove.type = "button";
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        editor.labels.splice(index, 1);
        editor.selectedIndex = Math.min(index, editor.labels.length - 1);
        editor.answer = editor.labels.length ? "YES" : "NO";
        markEditorDirty(editor, saveButton);
        rerender();
      });
      row.appendChild(remove);
      list.appendChild(row);
    });
  }

  function renderClassifyEditor({ dataset, editor, panel, saveButton }) {
    panel.innerHTML = "";
    const verdicts = createNode("div", "yolo-review-verdicts");
    ["YES", "NO"].forEach((answer) => {
      const button = createNode("button", "", answer === "YES" ? "Yes" : "No");
      button.type = "button";
      button.classList.toggle("is-active", editor.answer === answer);
      button.addEventListener("click", () => {
        editor.answer = answer;
        markEditorDirty(editor, saveButton);
        renderClassifyEditor({ dataset, editor, panel, saveButton });
      });
      verdicts.appendChild(button);
    });
    panel.appendChild(verdicts);

    const field = createNode("label", "yolo-review-editor-field");
    field.appendChild(createNode("span", "", "标签"));
    const select = document.createElement("select");
    const classes = dataset.classes?.length ? dataset.classes : [editor.className || "positive"];
    classes.forEach((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    });
    if (editor.className && ![...select.options].some((option) => option.value === editor.className)) {
      const option = document.createElement("option");
      option.value = editor.className;
      option.textContent = editor.className;
      select.appendChild(option);
    }
    select.value = editor.className || classes[0] || "";
    select.addEventListener("change", () => {
      editor.className = select.value;
      markEditorDirty(editor, saveButton);
    });
    field.appendChild(select);
    panel.appendChild(field);
  }

  function renderManualEditor(dataset, item, overlay) {
    const kind = reviewTaskKind(dataset);
    const editor = makeEditorState(dataset, item, kind);
    const initialEditor = makeEditorState(dataset, item, kind);
    const wrap = createNode("div", "yolo-review-editor");
    const head = createNode("div", "yolo-review-section-head");
    head.appendChild(createNode("h3", "", "人工编辑"));
    const stateChip = createNode("span", `ai-history-chip ${item.manual_annotation_status ? "tone-yes" : "tone-idle"}`, item.manual_annotation_status === "saved" ? "已人工保存" : "未人工保存");
    head.appendChild(stateChip);
    wrap.appendChild(head);

    const body = createNode("div", "yolo-review-editor-body");
    wrap.appendChild(body);

    const actions = createNode("div", "yolo-review-editor-actions");
    const saveButton = createNode("button", "yolo-review-save", "保存标注");
    saveButton.type = "button";
    saveButton.disabled = true;
    const resetButton = createNode("button", "yolo-review-reset", "重置");
    resetButton.type = "button";
    const deleteButton = createNode("button", "yolo-review-delete", "删除样本");
    deleteButton.type = "button";
    actions.appendChild(saveButton);
    actions.appendChild(resetButton);
    actions.appendChild(deleteButton);
    wrap.appendChild(actions);

    if (kind === "classify") {
      renderClassifyEditor({ dataset, editor, panel: body, saveButton });
    } else {
      renderDetectEditor({ dataset, item, editor, overlay, panel: body, saveButton });
    }

    resetButton.addEventListener("click", () => {
      restoreEditorState(editor, initialEditor);
      saveButton.disabled = true;
      saveButton.textContent = "保存标注";
      if (kind === "classify") {
        renderClassifyEditor({ dataset, editor, panel: body, saveButton });
      } else {
        renderDetectEditor({ dataset, item, editor, overlay, panel: body, saveButton });
      }
      setStatus("已恢复到本次人工编辑前的状态。", "idle");
    });

    saveButton.addEventListener("click", async () => {
      saveButton.disabled = true;
      saveButton.textContent = "保存中...";
      setStatus("保存人工标注...", "loading");
      try {
        const payload = {
          dataset_id: dataset.id,
          item_key: item.item_key,
          kind,
          answer: kind === "detect" ? (editor.labels.length ? "YES" : "NO") : editor.answer,
          class_name: kind === "classify" ? editor.className : "",
          labels: editor.labels.map((label) => ({
            class_name: label.class_name,
            class_id: label.class_id,
            x: Number(label.x),
            y: Number(label.y),
            w: Number(label.w),
            h: Number(label.h)
          }))
        };
        const data = await postJson(endpoints.annotation, payload);
        renderDetail(data.dataset, data.item);
        await loadItems();
        renderListActive(item.item_key);
        setStatus("人工标注已保存", "ok");
      } catch (error) {
        saveButton.disabled = false;
        saveButton.textContent = "保存标注";
        setStatus(`保存失败：${error?.message || "未知错误"}`, "error");
      }
    });

    deleteButton.addEventListener("click", async () => {
      if (!window.confirm("确认从当前人工审核列表删除这个样本？源图片不会被物理删除。")) return;
      deleteButton.disabled = true;
      deleteButton.textContent = "删除中...";
      setStatus("删除样本...", "loading");
      try {
        await postJson(endpoints.deleteItem, {
          dataset_id: dataset.id,
          item_key: item.item_key,
          reason: "manual_review_delete"
        });
        resetDetail("样本已从人工审核列表删除。");
        await loadItems({ resetPage: false });
        setStatus("样本已删除", "ok");
      } catch (error) {
        deleteButton.disabled = false;
        deleteButton.textContent = "删除样本";
        setStatus(`删除失败：${error?.message || "未知错误"}`, "error");
      }
    });

    return wrap;
  }

  function enableDragView(stage, content, options = {}) {
    if (!stage || !content) return;
    const img = content.querySelector("img");
    const shouldStartPan = typeof options.shouldStartPan === "function" ? options.shouldStartPan : () => true;
    const maxScale = 8;
    const baseScale = 1;
    const panSlackAtFit = 180;
    let dragging = false;
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let offsetX = 0;
    let offsetY = 0;
    let baseX = 0;
    let baseY = 0;
    let scale = 1;

    function preventNativeDrag(event) {
      event.preventDefault();
    }

    if (img) {
      img.draggable = false;
      img.addEventListener("dragstart", preventNativeDrag);
    }
    content.addEventListener("dragstart", preventNativeDrag);

    function clampOffsets() {
      const stageRect = stage.getBoundingClientRect();
      const contentWidth = content.offsetWidth || stageRect.width || 1;
      const contentHeight = content.offsetHeight || stageRect.height || 1;
      const fitSlack = scale <= baseScale + 0.01 ? panSlackAtFit : 0;
      const maxX = Math.max(fitSlack, (contentWidth * scale - stageRect.width) / 2);
      const maxY = Math.max(fitSlack, (contentHeight * scale - stageRect.height) / 2);
      offsetX = Math.max(-maxX, Math.min(maxX, offsetX));
      offsetY = Math.max(-maxY, Math.min(maxY, offsetY));
    }

    function apply() {
      clampOffsets();
      content.style.transform = `translate3d(${offsetX}px, ${offsetY}px, 0) scale(${scale})`;
      stage.dataset.zoom = scale.toFixed(2);
      if (zoomReset) zoomReset.textContent = `${Math.round(scale * 100)}%`;
    }

    function zoomAt(clientX, clientY, nextScale) {
      const previousScale = scale;
      const clampedScale = Math.max(baseScale, Math.min(maxScale, nextScale));
      if (Math.abs(clampedScale - previousScale) < 0.001) return;
      const rect = stage.getBoundingClientRect();
      const cursorX = clientX - rect.left - rect.width / 2;
      const cursorY = clientY - rect.top - rect.height / 2;
      scale = clampedScale;
      if (scale <= baseScale + 0.001) {
        scale = baseScale;
        offsetX = 0;
        offsetY = 0;
      } else {
        const ratio = scale / previousScale;
        offsetX = cursorX + (offsetX - cursorX) * ratio;
        offsetY = cursorY + (offsetY - cursorY) * ratio;
      }
      apply();
    }

    function zoomAtCenter(nextScale) {
      const rect = stage.getBoundingClientRect();
      zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, nextScale);
    }

    function resetZoom() {
      scale = baseScale;
      offsetX = 0;
      offsetY = 0;
      apply();
    }

    const controls = createNode("div", "yolo-review-zoom-controls");
    const zoomOut = createNode("button", "", "-");
    zoomOut.type = "button";
    zoomOut.title = "缩小";
    const zoomReset = createNode("button", "yolo-review-zoom-reset", "100%");
    zoomReset.type = "button";
    zoomReset.title = "恢复 100%";
    const zoomIn = createNode("button", "", "+");
    zoomIn.type = "button";
    zoomIn.title = "放大";
    [zoomOut, zoomReset, zoomIn].forEach((button) => {
      button.addEventListener("pointerdown", (event) => event.stopPropagation());
      button.addEventListener("click", (event) => event.stopPropagation());
      controls.appendChild(button);
    });
    zoomOut.addEventListener("click", () => zoomAtCenter(scale / 1.25));
    zoomReset.addEventListener("click", resetZoom);
    zoomIn.addEventListener("click", () => zoomAtCenter(scale * 1.25));
    stage.appendChild(controls);

    stage.addEventListener("pointerdown", (event) => {
      if (event.button != null && event.button !== 0) return;
      if (event.target?.closest?.(".yolo-review-zoom-controls")) return;
      if (!shouldStartPan(event)) return;
      event.preventDefault();
      dragging = true;
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      baseX = offsetX;
      baseY = offsetY;
      stage.classList.add("is-dragging");
      document.body?.classList.add("yolo-review-is-panning");
      stage.setPointerCapture?.(pointerId);
    });

    stage.addEventListener("pointermove", (event) => {
      if (!dragging || event.pointerId !== pointerId) return;
      event.preventDefault();
      offsetX = baseX + event.clientX - startX;
      offsetY = baseY + event.clientY - startY;
      apply();
    });

    function stopDrag(event) {
      if (!dragging || (event?.pointerId != null && pointerId != null && event.pointerId !== pointerId)) return;
      dragging = false;
      stage.classList.remove("is-dragging");
      document.body?.classList.remove("yolo-review-is-panning");
      const capturedPointerId = pointerId;
      pointerId = null;
      if (event?.type !== "lostpointercapture" && capturedPointerId != null && stage.hasPointerCapture?.(capturedPointerId)) {
        stage.releasePointerCapture?.(capturedPointerId);
      }
    }

    stage.addEventListener("pointerup", stopDrag);
    stage.addEventListener("pointercancel", stopDrag);
    stage.addEventListener("lostpointercapture", stopDrag);
    stage.addEventListener("wheel", (event) => {
      event.preventDefault();
      const direction = event.deltaY > 0 ? 0.88 : 1.12;
      zoomAt(event.clientX, event.clientY, scale * direction);
    }, { passive: false });
    stage.addEventListener("dblclick", () => {
      resetZoom();
    });
    img?.addEventListener("load", apply);
    apply();
  }

  function sourceImageCard(title, url, subtitle) {
    if (!url) return null;
    const card = document.createElement("a");
    card.className = "yolo-review-source-image";
    card.href = url;
    card.target = "_blank";
    card.rel = "noopener noreferrer";
    const img = document.createElement("img");
    img.src = url;
    img.alt = title;
    img.loading = "lazy";
    img.addEventListener("error", () => {
      card.remove();
    }, { once: true });
    card.appendChild(img);
    const text = createNode("div", "yolo-review-source-caption");
    text.appendChild(createNode("p", "yolo-review-source-title", title));
    text.appendChild(createNode("p", "yolo-review-source-subtitle", subtitle || "新窗口打开"));
    card.appendChild(text);
    return card;
  }

  async function loadDetail(itemKey) {
    if (!itemKey || !state.datasetId) return;
    const requestSeq = state.detailRequestSeq + 1;
    const requestDatasetId = state.datasetId;
    state.selectedItemKey = itemKey;
    state.detailRequestSeq = requestSeq;
    refs.detail.dataset.state = "loading";
    refs.detail.innerHTML = "";
    refs.detail.appendChild(createNode("p", "yolo-review-empty", "加载样本详情..."));
    refs.list.querySelectorAll(".yolo-review-item").forEach((node) => node.classList.remove("is-active"));

    try {
      const params = new URLSearchParams({ dataset_id: requestDatasetId, item_key: itemKey });
      const data = await requestJson(`${endpoints.item}?${params.toString()}`);
      if (state.detailRequestSeq !== requestSeq || state.datasetId !== requestDatasetId || state.selectedItemKey !== itemKey) {
        return;
      }
      renderDetail(data.dataset, data.item);
      refs.detail.dataset.state = "idle";
      renderListActive(itemKey);
    } catch (error) {
      if (state.detailRequestSeq !== requestSeq || state.datasetId !== requestDatasetId || state.selectedItemKey !== itemKey) {
        return;
      }
      refs.detail.dataset.state = "error";
      refs.detail.innerHTML = "";
      const message = String(error?.message || "");
      const detailText = message === "item_not_found"
        ? "当前样本不属于这个数据集，请重新点左侧样本。"
        : `详情加载失败：${message || "未知错误"}`;
      refs.detail.appendChild(createNode("p", "yolo-review-empty", detailText));
    }
  }

  function renderListActive(itemKey) {
    refs.list.querySelectorAll(".yolo-review-item").forEach((node) => {
      node.classList.toggle("is-active", node.dataset.itemKey === itemKey);
    });
  }

  function renderDetail(dataset, item) {
    refs.detail.innerHTML = "";

    const detailGrid = createNode("div", "yolo-review-detail-grid");
    const imageBlock = createNode("div", "yolo-review-image-block");
    const stage = createNode("div", "yolo-review-image-stage");
    const isVehicleCollection = item.source_type === "vehicle_collection" || dataset.source_type === "vehicle_collection";
    const kind = reviewTaskKind(dataset);
    const allowPan = isVehicleCollection && kind === "classify";
    const allowZoom = kind === "detect" || allowPan;
    if (allowPan) {
      stage.classList.add("yolo-review-image-stage--draggable");
    } else if (allowZoom) {
      stage.classList.add("yolo-review-image-stage--zoomable");
    }
    const panContent = createNode("div", "yolo-review-pan-content");
    const img = document.createElement("img");
    img.src = item.image_url;
    img.alt = item.item_key;
    img.loading = "eager";
    img.decoding = "async";
    img.draggable = false;
    const overlay = createNode("div", "yolo-review-overlay");
    panContent.appendChild(img);
    panContent.appendChild(overlay);
    stage.appendChild(panContent);
    if (allowPan) {
      stage.appendChild(createNode("p", "yolo-review-drag-hint", "拖动查看 · 滚轮/按钮缩放 · 双击复位"));
    } else if (kind === "detect") {
      stage.appendChild(createNode("p", "yolo-review-drag-hint", "滚轮/按钮缩放 · 空白处拖动 · 新增框后拖拽画框"));
    }
    if (allowZoom) {
      enableDragView(stage, panContent, {
        shouldStartPan: (event) => kind !== "detect" || (event.target === overlay && overlay.dataset.drawMode !== "true")
      });
    }
    renderBoxes(overlay, item.labels || []);
    imageBlock.appendChild(stage);

    const meta = createNode("div", "yolo-review-meta-grid");
    meta.appendChild(metaItem("样本", item.item_key));
    meta.appendChild(metaItem("来源", datasetSourceText(selectedDataset() || dataset || item)));
    meta.appendChild(metaItem("AI标类别", item.ai_class || item.event_name));
    meta.appendChild(metaItem("AI答案", answerDisplay(item.ai_answer)));
    meta.appendChild(metaItem("YOLO框数", item.label_count));
    meta.appendChild(metaItem("框来源", labelSourceText(item.label_source)));
    meta.appendChild(metaItem("Qwen标注", qwenCountSummary(item)));
    meta.appendChild(metaItem("Qwen质量", item.qwen_quality ? qwenLabelText(`quality:${item.qwen_quality}`) : ""));
    meta.appendChild(metaItem("Qwen质检", qwenAuditSummary(item)));
    meta.appendChild(metaItem("Split", item.split));
    if (isVehicleCollection) {
      meta.appendChild(metaItem("车辆", item.vehicle_id || item.device_id));
      meta.appendChild(metaItem("采集方式", item.collection_mode_label || item.capture_source));
      meta.appendChild(metaItem("采集时间", formatDate(item.collected_at)));
      meta.appendChild(metaItem("经纬度", item.position?.gaode_longitude && item.position?.gaode_latitude ? `${Number(item.position.gaode_longitude).toFixed(6)}, ${Number(item.position.gaode_latitude).toFixed(6)}` : ""));
    }
    meta.appendChild(metaItem("地点", item.device_id || item.archive?.request?.device_id));
    meta.appendChild(metaItem("相机", item.camera_id || item.archive?.request?.camera_id));
    meta.appendChild(metaItem("Request", item.request_id || item.archive?.request?.request_id));
    meta.appendChild(metaItem("Task", item.task_row_id || item.task_id));
    meta.appendChild(metaItem("模型", item.archive?.request?.model));
    meta.appendChild(metaItem("时间", formatDate(item.archive?.request?.created_at || item.day)));

    const manualEditor = renderManualEditor(dataset, item, overlay);
    detailGrid.appendChild(imageBlock);
    detailGrid.appendChild(manualEditor);
    refs.detail.appendChild(detailGrid);
    refs.detail.appendChild(meta);

    const labels = createNode("div", "yolo-review-labels");
    const labelTitle = createNode("div", "yolo-review-section-head");
    labelTitle.appendChild(createNode("h3", "", "YOLO 带框标签"));
    const labelBadge = labelSourceText(item.label_source) || (item.auto_label_status === "pending" ? "待预标注" : dataset.kind === "classify" ? "分类样本" : item.label_rel_path || "无 label");
    labelTitle.appendChild(createNode("span", `ai-history-chip ${labelSourceTone(item.label_source)}`, labelBadge));
    labels.appendChild(labelTitle);
    if (kind === "classify" && dataset.kind === "classify") {
      labels.appendChild(createNode("p", "yolo-review-label-line", `默认结果: ${answerDisplay(item.ai_answer)}`));
      labels.appendChild(createNode("p", "yolo-review-label-line", `class: ${item.ai_class || "-"}`));
    } else if (item.labels?.length) {
      item.labels.forEach((label, index) => {
        const confidence = Number(label.confidence);
        const confidenceText = Number.isFinite(confidence) ? ` · ${(confidence * 100).toFixed(0)}%` : "";
        const modelText = label.model_task ? ` · ${label.model_task}` : "";
        labels.appendChild(createNode("p", "yolo-review-label-line", `框 ${index + 1}: ${label.class_name}${confidenceText}${modelText}`));
      });
    } else {
      labels.appendChild(createNode("p", "yolo-review-label-line", "empty label"));
    }
    refs.detail.appendChild(labels);
    if (isVehicleCollection || item.qwen_bbox_audit_status) {
      refs.detail.appendChild(renderQwenAuditSection(item));
    }
    if (isVehicleCollection || item.qwen_label_status) {
      refs.detail.appendChild(renderQwenLabelSection(item));
    }

    const sourceGrid = createNode("div", "yolo-review-source-grid");
    const roiUrl = item.archive?.task?.roi_url || item.manifest?.tasks?.[0]?.roi_url;
    const frameUrl = item.archive?.request?.image_url || item.manifest?.source_frame_url;
    const roiCard = sourceImageCard("ROI", roiUrl, item.archive?.task?.crop_box ? `crop ${JSON.stringify(item.archive.task.crop_box)}` : "");
    const frameCard = sourceImageCard("原始帧", frameUrl, item.archive?.request?.request_id || item.request_id);
    if (roiCard) sourceGrid.appendChild(roiCard);
    if (frameCard) sourceGrid.appendChild(frameCard);
    if (sourceGrid.childElementCount) refs.detail.appendChild(sourceGrid);

  }

  let queryTimer = null;
  function scheduleReload() {
    window.clearTimeout(queryTimer);
    queryTimer = window.setTimeout(() => {
      resetDetail("筛选已更新，选择左侧样本查看详情。");
      loadItems({ resetPage: true }).catch(() => {});
    }, 220);
  }

  refs.dataset?.addEventListener("change", () => {
    state.datasetId = refs.dataset.value;
    resetDetail("已切换数据集，选择左侧样本查看详情。");
    updateClassOptions();
    updateQwenOptions();
    applyEventFiltersForDataset(selectedDataset());
    renderSummary(selectedDataset());
    renderDatasetCards();
    loadItems({ resetPage: true }).catch(() => {});
  });
  refs.source?.addEventListener("change", () => {
    applySourceSelection(refs.source?.value || "");
  });
  refs.split?.addEventListener("change", () => {
    markCustomEventFilter();
    scheduleReload();
  });
  refs.className?.addEventListener("change", () => {
    markCustomEventFilter();
    scheduleReload();
  });
  refs.answer?.addEventListener("change", () => {
    markCustomEventFilter();
    scheduleReload();
  });
  refs.qwenLabel?.addEventListener("change", () => {
    markCustomEventFilter();
    scheduleReload();
  });
  refs.qwenAudit?.addEventListener("change", () => {
    markCustomEventFilter();
    scheduleReload();
  });
  refs.hasBox?.addEventListener("change", () => {
    markCustomEventFilter();
    scheduleReload();
  });
  refs.query?.addEventListener("input", () => {
    markCustomEventFilter();
    scheduleReload();
  });
  refs.refresh?.addEventListener("click", () => loadDatasets().catch(() => {}));
  refs.eventButtons.forEach((button) => {
    button.addEventListener("click", () => applyReviewEvent(button.dataset.yoloReviewEvent || "all"));
  });
  refs.prev?.addEventListener("click", () => {
    if (state.page <= 1) return;
    state.page -= 1;
    state.selectedItemKey = "";
    loadItems().catch(() => {});
  });
  refs.next?.addEventListener("click", () => {
    if (state.page >= state.totalPages) return;
    state.page += 1;
    state.selectedItemKey = "";
    loadItems().catch(() => {});
  });
  window.addEventListener("jgzj:auth-change", () => {
    loadDatasets().catch(() => {});
  });

  loadDatasets().catch(() => {});
})();
