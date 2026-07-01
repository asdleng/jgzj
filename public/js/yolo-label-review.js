(() => {
  const panel = document.getElementById("yolo-review-panel");
  if (!panel) return;

  const endpoints = {
    datasets: "/api/yolo-label-review/datasets",
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
    hasBox: document.getElementById("yolo-review-has-box"),
    query: document.getElementById("yolo-review-query"),
    eventStatus: document.getElementById("yolo-review-event-status"),
    eventButtons: Array.from(document.querySelectorAll("[data-yolo-review-event]")),
    datasetStatus: document.getElementById("yolo-review-dataset-status"),
    sourceCards: document.getElementById("yolo-review-source-cards"),
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
    person: {
      label: "人员事件 · 全部来源 · 默认显示框",
      tokens: ["person", "pedestrian", "人员"],
      qwenLabel: "person",
      className: "person",
      answer: "YES",
      query: "",
      hasBox: true,
      taskKind: "detect"
    },
    vehicle: {
      label: "车辆事件 · 全部来源 · 默认显示框",
      tokens: ["vehicle", "car", "truck", "bus", "nonmotor", "车辆"],
      qwenLabel: "vehicle",
      className: "vehicle",
      answer: "YES",
      query: "",
      hasBox: true,
      taskKind: "detect"
    },
    license_plate: {
      label: "车牌事件 · 全部来源 · 默认显示框",
      tokens: ["license_plate", "plate", "ccpd", "车牌"],
      qwenLabel: "",
      className: "",
      answer: "YES",
      query: "",
      hasBox: true,
      taskKind: "detect"
    },
    phone: {
      label: "手机事件 · 全部来源 · 默认显示框",
      tokens: ["phone", "mobile", "手机"],
      qwenLabel: "phone",
      className: "phone",
      answer: "YES",
      query: "",
      hasBox: true,
      taskKind: "detect"
    },
    smoking: {
      label: "吸烟事件 · 全部来源 · 默认 Yes/No",
      tokens: ["smoking", "smoke_cls", "person_behavior", "吸烟"],
      qwenLabel: "smoking",
      className: "smoking",
      answer: "YES",
      query: "",
      hasBox: false,
      taskKind: "classify"
    },
    fire_smoke: {
      label: "烟火事件 · 全部来源 · 默认显示框",
      tokens: ["fire_smoke", "fire", "smoke", "flame", "烟", "火"],
      qwenLabel: "fire_smoke_candidate",
      className: "",
      answer: "",
      query: "",
      hasBox: true,
      taskKind: "detect"
    },
    trash: {
      label: "垃圾事件 · 全部来源 · 默认显示框",
      tokens: ["trash", "garbage", "litter", "垃圾"],
      qwenLabel: "trash",
      className: "trash",
      answer: "YES",
      query: "",
      hasBox: true,
      taskKind: "detect"
    },
    stall: {
      label: "摆摊事件 · 全部来源 · 默认显示框",
      tokens: ["stall", "booth", "vendor", "摆摊"],
      qwenLabel: "stall",
      className: "stall",
      answer: "YES",
      query: "",
      hasBox: true,
      taskKind: "detect"
    },
    pet: {
      label: "宠物事件 · 全部来源 · 候选/框",
      tokens: ["pet", "dog", "cat", "animal", "宠物"],
      qwenLabel: "pet",
      className: "pet",
      answer: "",
      query: "",
      hasBox: true,
      taskKind: "detect"
    },
    fishing: {
      label: "钓鱼事件 · 全部来源 · 默认 Yes/No",
      tokens: ["fishing", "fishing_rod", "钓鱼"],
      qwenLabel: "",
      className: "",
      answer: "YES",
      query: "",
      hasBox: false,
      taskKind: "classify"
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
    "quality:blocked": "遮挡"
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
    const sourceGroup = datasetSourceGroup(dataset);
    const text = datasetEventText(dataset);
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
      imageCount: datasets.reduce((total, dataset) => total + datasetTotalImages(dataset), 0),
      boxCount: datasets.reduce((total, dataset) => total + datasetTotalBoxes(dataset), 0)
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
    const isClassify = dataset?.kind === "classify" || preset.taskKind === "classify";

    if (refs.split) refs.split.value = "";
    if (refs.query) refs.query.value = "";
    if (refs.qwenLabel) refs.qwenLabel.value = "";
    if (refs.className) refs.className.value = "";
    if (refs.answer) refs.answer.value = state.activeEvent === "all" ? "" : (preset.answer || "");
    if (refs.hasBox) refs.hasBox.checked = state.activeEvent !== "all" && !isClassify && Boolean(preset.hasBox);

    if (state.activeEvent === "all") return;
    if (isVehicleCollection) {
      setSelectValueIfPresent(refs.qwenLabel, preset.qwenLabel || "");
      setSelectValueIfPresent(refs.className, preset.className || "");
      if (preset.qwenLabel && refs.query && !refs.qwenLabel?.value && !refs.className?.value) {
        refs.query.value = preset.qwenLabel;
      }
    }
  }

  function updateEventButtons() {
    refs.eventButtons.forEach((button) => {
      button.classList.toggle("is-active", button.dataset.yoloReviewEvent === state.activeEvent);
    });
    if (refs.eventStatus) {
      refs.eventStatus.textContent = eventPresets[state.activeEvent]?.label || "全部事件 · 全部来源";
    }
  }

  function markCustomEventFilter() {
    updateEventButtons();
  }

  function applyReviewEvent(eventKey) {
    state.activeEvent = eventPresets[eventKey] ? eventKey : "all";
    if (refs.source) refs.source.value = "";
    resetDetail("已切换事件，选择左侧样本查看详情。");
    refreshDatasetOptions();
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
    refreshDatasetOptions();
    updateClassOptions();
    updateQwenOptions();
    applyEventFiltersForDataset(selectedDataset());
    renderSummary(selectedDataset());
    renderDatasetCards();
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
      title.appendChild(createNode("span", "", stats.datasetCount ? "可查看" : "当前事件下暂无数据集"));
      button.appendChild(title);

      const metrics = createNode("div", "yolo-review-source-card-metrics");
      [
        ["数据集", compactNumber(stats.datasetCount)],
        ["样本", compactNumber(stats.imageCount)],
        ["框", compactNumber(stats.boxCount)]
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
      const sourceText = sourceGroupLabel(refs.source?.value || "");
      const selectedStats = sourceStats(refs.source?.value || "");
      const sourceCounts = sourceGroups.slice(1).map((group) => {
        const stats = sourceStats(group.value);
        return `${group.label} ${compactNumber(stats.datasetCount)}`;
      });
      refs.datasetStatus.textContent = `${eventPresets[state.activeEvent]?.label || "全部事件"} · 当前 ${sourceText}：${compactNumber(selectedStats.datasetCount)} / ${compactNumber(total)} 个数据集 · ${sourceCounts.join(" · ")}`;
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
      [
        ["样本", compactNumber(dataset.total_images)],
        ["框", compactNumber(datasetTotalBoxes(dataset))],
        ["YES", dataset.answers?.YES != null ? compactNumber(dataset.answers.YES) : "-"],
        ["NO", dataset.answers?.NO != null ? compactNumber(dataset.answers.NO) : "-"],
        ["语义已标", datasetMetricValue(dataset, "qwen_label.cached_images")],
        ["框已标", datasetMetricValue(dataset, "qwen_bbox.cached_images")]
      ].forEach(([label, value]) => {
        const metric = createNode("div", "yolo-review-dataset-metric");
        metric.appendChild(createNode("span", "", label));
        metric.appendChild(createNode("strong", "", value));
        metrics.appendChild(metric);
      });
      button.appendChild(metrics);

      const foot = createNode("div", "yolo-review-dataset-card-foot");
      foot.appendChild(createNode("span", "", `语义待标 ${datasetMetricValue(dataset, "qwen_label.pending_images", "0")}`));
      foot.appendChild(createNode("span", "", `框待标 ${datasetMetricValue(dataset, "qwen_bbox.pending_images", "0")}`));
      if (dataset.created_at) {
        foot.appendChild(createNode("span", "", formatDate(dataset.created_at)));
      }
      button.appendChild(foot);
      refs.datasetCards.appendChild(button);
    });
  }

  function renderSummary(dataset) {
    if (!refs.summary) return;
    refs.summary.innerHTML = "";
    if (!dataset) {
      refs.summary.appendChild(createNode("p", "yolo-review-empty", "暂无数据集。"));
      return;
    }

    const cells = [
      ["来源", datasetSourceText(dataset)],
      ["Profile", dataset.profile || dataset.name || "-"],
      ["类型", dataset.kind === "classify" ? "分类" : "检测"],
      ["样本", compactNumber(dataset.total_images)],
      ["框", dataset.boxes ? compactNumber(Object.values(dataset.boxes).reduce((a, b) => a + Number(b || 0), 0)) : "-"],
      ["AI YES", dataset.answers?.YES != null ? compactNumber(dataset.answers.YES) : "-"],
      ["AI NO", dataset.answers?.NO != null ? compactNumber(dataset.answers.NO) : "-"]
    ];
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

  function refreshDatasetOptions() {
    let selectedSource = refs.source?.value || "";
    state.eventDatasets = state.allDatasets.filter((dataset) => datasetMatchesEvent(dataset));
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
    if (!state.datasets.some((dataset) => dataset.id === state.datasetId)) {
      state.datasetId = state.datasets[0]?.id || "";
    }
    refs.dataset.value = state.datasetId;
    renderDatasetCards();
  }

  async function loadDatasets() {
    setStatus("加载数据集...", "loading");
    try {
      const data = await requestJson(endpoints.datasets);
      state.allDatasets = Array.isArray(data.datasets) ? data.datasets : [];
      configureSourceOptions();
      refreshDatasetOptions();
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
    params.set("dataset_id", state.datasetId);
    params.set("page", String(state.page));
    params.set("page_size", String(state.pageSize));
    if (refs.split.value) params.set("split", refs.split.value);
    if (refs.className.value) params.set("class_name", refs.className.value);
    if (refs.answer.value) params.set("ai_answer", refs.answer.value);
    if (refs.qwenLabel?.value) params.set("qwen_label", refs.qwenLabel.value);
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
      const isClassify = dataset?.kind === "classify";
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

  function formatCoord(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num.toFixed(4) : "0.0000";
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

  function makeEditorState(dataset, item) {
    const labels = (Array.isArray(item.labels) ? item.labels : [])
      .map((label, index) => normalizeEditorLabel(label, index, dataset));
    return {
      dataset,
      item,
      labels,
      selectedIndex: labels.length ? 0 : -1,
      drawMode: false,
      dirty: false,
      answer: answerDisplay(item.ai_answer) === "Yes" ? "YES" : answerDisplay(item.ai_answer) === "No" ? "NO" : (dataset.kind === "detect" ? (labels.length ? "YES" : "NO") : "YES"),
      className: item.manual_annotation?.class_name || item.ai_class || dataset.classes?.[0] || ""
    };
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

    const toolbar = createNode("div", "yolo-review-edit-toolbar");
    const addButton = createNode("button", "yolo-review-tool-button", editor.drawMode ? "正在画框" : "新增框");
    addButton.type = "button";
    addButton.classList.toggle("is-active", editor.drawMode);
    const deleteButton = createNode("button", "yolo-review-tool-button yolo-review-tool-button--danger", "删除框");
    deleteButton.type = "button";
    deleteButton.disabled = editor.selectedIndex < 0;
    toolbar.appendChild(addButton);
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
          const className = dataset.classes?.[0] || editor.className || "object";
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
      list.appendChild(createNode("p", "yolo-review-label-line", "当前没有框，可以点击新增框后在图片上拖拽画框。"));
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
        editor.selectedIndex = index;
        markEditorDirty(editor, saveButton);
        rerender();
      });
      row.appendChild(select);
      select.addEventListener("click", (event) => event.stopPropagation());
      ["x", "y", "w", "h"].forEach((key) => {
        const input = document.createElement("input");
        input.type = "number";
        input.step = "0.0001";
        input.min = "0";
        input.max = "1";
        input.value = formatCoord(label[key]);
        input.title = key;
        input.addEventListener("change", () => {
          editor.labels[index] = normalizeEditorLabel({ ...editor.labels[index], [key]: Number(input.value) }, index, dataset);
          editor.selectedIndex = index;
          markEditorDirty(editor, saveButton);
          rerender();
        });
        input.addEventListener("click", (event) => event.stopPropagation());
        row.appendChild(input);
      });
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
    const editor = makeEditorState(dataset, item);
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
    const deleteButton = createNode("button", "yolo-review-delete", "删除样本");
    deleteButton.type = "button";
    actions.appendChild(saveButton);
    actions.appendChild(deleteButton);
    wrap.appendChild(actions);

    if (dataset.kind === "classify") {
      renderClassifyEditor({ dataset, editor, panel: body, saveButton });
    } else {
      renderDetectEditor({ dataset, item, editor, overlay, panel: body, saveButton });
    }

    saveButton.addEventListener("click", async () => {
      saveButton.disabled = true;
      saveButton.textContent = "保存中...";
      setStatus("保存人工标注...", "loading");
      try {
        const payload = {
          dataset_id: dataset.id,
          item_key: item.item_key,
          kind: dataset.kind,
          answer: dataset.kind === "detect" ? (editor.labels.length ? "YES" : "NO") : editor.answer,
          class_name: dataset.kind === "classify" ? editor.className : "",
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

  function enableDragView(stage, content) {
    if (!stage || !content) return;
    const img = content.querySelector("img");
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

    stage.addEventListener("pointerdown", (event) => {
      if (event.button != null && event.button !== 0) return;
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
      scale = baseScale;
      offsetX = 0;
      offsetY = 0;
      apply();
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
    const allowPan = isVehicleCollection && dataset.kind === "classify";
    if (allowPan) {
      stage.classList.add("yolo-review-image-stage--draggable");
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
      stage.appendChild(createNode("p", "yolo-review-drag-hint", "拖动查看 · 滚轮缩放 · 双击复位"));
      enableDragView(stage, panContent);
    } else if (dataset.kind === "detect") {
      stage.appendChild(createNode("p", "yolo-review-drag-hint", "拖动框移动 · 拖角缩放 · 新增框后拖拽画框"));
    }
    renderBoxes(overlay, item.labels || []);
    imageBlock.appendChild(stage);
    imageBlock.appendChild(createNode("p", "yolo-review-path", item.item_key));

    const meta = createNode("div", "yolo-review-meta-grid");
    meta.appendChild(metaItem("来源", datasetSourceText(selectedDataset() || dataset || item)));
    meta.appendChild(metaItem("AI标类别", item.ai_class || item.event_name));
    meta.appendChild(metaItem("AI答案", answerDisplay(item.ai_answer)));
    meta.appendChild(metaItem("YOLO框数", item.label_count));
    meta.appendChild(metaItem("框来源", labelSourceText(item.label_source)));
    meta.appendChild(metaItem("Qwen标注", qwenCountSummary(item)));
    meta.appendChild(metaItem("Qwen质量", item.qwen_quality ? qwenLabelText(`quality:${item.qwen_quality}`) : ""));
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

    detailGrid.appendChild(imageBlock);
    detailGrid.appendChild(meta);
    refs.detail.appendChild(detailGrid);
    refs.detail.appendChild(renderManualEditor(dataset, item, overlay));

    const labels = createNode("div", "yolo-review-labels");
    const labelTitle = createNode("div", "yolo-review-section-head");
    labelTitle.appendChild(createNode("h3", "", "YOLO 带框标签"));
    const labelBadge = labelSourceText(item.label_source) || (item.auto_label_status === "pending" ? "待预标注" : dataset.kind === "classify" ? "分类样本" : item.label_rel_path || "无 label");
    labelTitle.appendChild(createNode("span", `ai-history-chip ${labelSourceTone(item.label_source)}`, labelBadge));
    labels.appendChild(labelTitle);
    if (dataset.kind === "classify") {
      labels.appendChild(createNode("p", "yolo-review-label-line", `默认结果: ${answerDisplay(item.ai_answer)}`));
      labels.appendChild(createNode("p", "yolo-review-label-line", `class: ${item.ai_class || "-"}`));
    } else if (item.labels?.length) {
      item.labels.forEach((label) => {
        const confidence = Number(label.confidence);
        const confidenceText = Number.isFinite(confidence) ? ` · ${(confidence * 100).toFixed(0)}%` : "";
        const modelText = label.model_task ? ` · ${label.model_task}` : "";
        labels.appendChild(createNode("p", "yolo-review-label-line", `${label.class_name}${confidenceText}${modelText} · ${label.raw}`));
      });
    } else {
      labels.appendChild(createNode("p", "yolo-review-label-line", "empty label"));
    }
    refs.detail.appendChild(labels);
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
