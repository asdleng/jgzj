(() => {
  const panel = document.getElementById("yolo-review-panel");
  if (!panel) return;

  const endpoints = {
    datasets: "/api/yolo-label-review/datasets",
    items: "/api/yolo-label-review/items",
    item: "/api/yolo-label-review/item"
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
    fireSmokeCard: document.getElementById("yolo-fire-smoke-card"),
    fireSmokeOpen: document.getElementById("yolo-fire-smoke-open"),
    summary: document.getElementById("yolo-review-summary"),
    list: document.getElementById("yolo-review-list"),
    detail: document.getElementById("yolo-review-detail"),
    prev: document.getElementById("yolo-review-prev"),
    next: document.getElementById("yolo-review-next"),
    page: document.getElementById("yolo-review-page")
  };

  const state = {
    allDatasets: [],
    datasets: [],
    datasetId: "",
    page: 1,
    pageSize: 24,
    totalPages: 1,
    selectedItemKey: "",
    activeEvent: "all"
  };

  const eventPresets = {
    all: {
      label: "全部图片",
      source: "",
      qwenLabel: "",
      className: "",
      answer: "",
      query: "",
      hasBox: false
    },
    person: {
      label: "人员事件 · 默认显示框",
      source: "vehicle_collection",
      qwenLabel: "person",
      className: "person",
      answer: "YES",
      query: "",
      hasBox: true
    },
    vehicle: {
      label: "车辆事件 · 默认显示框",
      source: "vehicle_collection",
      qwenLabel: "vehicle",
      className: "vehicle",
      answer: "YES",
      query: "",
      hasBox: true
    },
    phone: {
      label: "手机事件 · 默认显示框",
      source: "vehicle_collection",
      qwenLabel: "phone",
      className: "phone",
      answer: "YES",
      query: "",
      hasBox: true
    },
    smoking: {
      label: "吸烟事件 · 默认 Yes/No",
      source: "vehicle_collection",
      qwenLabel: "smoking",
      className: "smoking",
      answer: "YES",
      query: "",
      hasBox: true
    },
    fire_smoke: {
      label: "烟火事件 · 默认显示框",
      source: "vehicle_collection",
      qwenLabel: "fire_smoke_candidate",
      className: "",
      answer: "",
      query: "",
      hasBox: true
    },
    trash: {
      label: "垃圾事件 · 默认显示框",
      source: "vehicle_collection",
      qwenLabel: "trash",
      className: "trash",
      answer: "YES",
      query: "",
      hasBox: true
    },
    stall: {
      label: "摆摊事件 · 默认显示框",
      source: "vehicle_collection",
      qwenLabel: "stall",
      className: "stall",
      answer: "YES",
      query: "",
      hasBox: true
    },
    pet: {
      label: "宠物事件 · 默认显示框",
      source: "vehicle_collection",
      qwenLabel: "pet",
      className: "pet",
      answer: "YES",
      query: "",
      hasBox: true
    },
    fishing: {
      label: "钓鱼事件 · 默认 Yes/No",
      source: "",
      qwenLabel: "",
      className: "",
      answer: "",
      query: "fishing",
      hasBox: false
    }
  };

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
    if (source === "qwen_bbox_verified") return "Qwen校验框";
    if (source === "qwen_bbox") return "Qwen框";
    if (source === "yolo_auto") return "YOLO模型预标";
    return "";
  }

  function labelSourceTone(source) {
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
    const source = dataset.source_label || dataset.source_type || dataset.source || "数据集";
    return `[${source}] ${profile}${parent} · ${dataset.kind || "dataset"} · ${compactNumber(dataset.total_images)}张`;
  }

  function selectedDataset() {
    return state.datasets.find((item) => item.id === state.datasetId) || null;
  }

  function isFireSmokeDataset(dataset) {
    const classes = Array.isArray(dataset?.classes)
      ? dataset.classes.map((item) => normalizeClassToken(item))
      : [];
    const haystack = [
      dataset?.id,
      dataset?.name,
      dataset?.parent_name,
      dataset?.profile
    ].join(" ").toLowerCase();
    return (classes.includes("fire") && classes.includes("smoke")) || /fire[_-\s]?smoke|烟雾|火焰|火源/.test(haystack);
  }

  function latestFireSmokeDataset() {
    const candidates = state.allDatasets.filter(isFireSmokeDataset);
    candidates.sort((left, right) => {
      const leftTime = Date.parse(left.created_at || "") || 0;
      const rightTime = Date.parse(right.created_at || "") || 0;
      if (leftTime !== rightTime) return rightTime - leftTime;
      return String(right.id || "").localeCompare(String(left.id || ""));
    });
    return candidates[0] || null;
  }

  function sumObjectValues(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
    return Object.values(value).reduce((total, item) => total + Number(item || 0), 0);
  }

  function renderFireSmokeCard() {
    if (!refs.fireSmokeCard) return;
    const dataset = latestFireSmokeDataset();
    const metrics = refs.fireSmokeCard.querySelector(".yolo-review-focus-metrics");
    const desc = refs.fireSmokeCard.querySelector(".yolo-review-focus-desc");
    const open = refs.fireSmokeOpen;
    if (!dataset) {
      refs.fireSmokeCard.dataset.state = "empty";
      if (desc) desc.textContent = "还没有扫描到 fire/smoke 数据集。";
      if (metrics) metrics.innerHTML = "";
      if (open) open.disabled = true;
      return;
    }

    refs.fireSmokeCard.dataset.state = state.datasetId === dataset.id ? "active" : "ready";
    if (desc) {
      desc.textContent = `${dataset.source_label || "数据集"} · ${dataset.profile || dataset.name || "fire/smoke"} · ${formatDate(dataset.created_at)}`;
    }
    if (metrics) {
      metrics.innerHTML = "";
      [
        ["样本", compactNumber(dataset.total_images)],
        ["框", compactNumber(sumObjectValues(dataset.boxes))],
        ["YES", dataset.answers?.YES != null ? compactNumber(dataset.answers.YES) : "-"],
        ["NO", dataset.answers?.NO != null ? compactNumber(dataset.answers.NO) : "-"]
      ].forEach(([label, value]) => {
        const item = createNode("div", "yolo-review-focus-metric");
        item.appendChild(createNode("span", "", label));
        item.appendChild(createNode("strong", "", value));
        metrics.appendChild(item);
      });
    }
    if (open) {
      open.disabled = false;
      open.textContent = state.datasetId === dataset.id ? "正在查看" : "查看";
    }
  }

  function openFireSmokeDataset() {
    const dataset = latestFireSmokeDataset();
    if (!dataset) return;
    if (refs.source) refs.source.value = "";
    refreshDatasetOptions();
    state.datasetId = dataset.id;
    if (refs.dataset) refs.dataset.value = dataset.id;
    state.selectedItemKey = "";
    if (refs.split) refs.split.value = "";
    if (refs.className) refs.className.value = "";
    if (refs.answer) refs.answer.value = "";
    if (refs.qwenLabel) refs.qwenLabel.value = "";
    updateClassOptions();
    updateQwenOptions();
    renderSummary(selectedDataset());
    renderFireSmokeCard();
    loadItems({ resetPage: true }).catch(() => {});
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

  function selectDatasetForSource(sourceType) {
    if (!sourceType) {
      if (refs.source) refs.source.value = "";
      refreshDatasetOptions();
      return;
    }
    if (refs.source) refs.source.value = sourceType;
    refreshDatasetOptions();
    const preferred = state.datasets.find((dataset) => dataset.source_type === sourceType);
    if (preferred) {
      state.datasetId = preferred.id;
      if (refs.dataset) refs.dataset.value = preferred.id;
    }
  }

  function updateEventButtons() {
    refs.eventButtons.forEach((button) => {
      button.classList.toggle("is-active", button.dataset.yoloReviewEvent === state.activeEvent);
    });
    if (refs.eventStatus) {
      refs.eventStatus.textContent = eventPresets[state.activeEvent]?.label || "全部图片";
    }
  }

  function markCustomEventFilter() {
    state.activeEvent = "custom";
    refs.eventButtons.forEach((button) => button.classList.remove("is-active"));
    if (refs.eventStatus) {
      refs.eventStatus.textContent = "自定义筛选";
    }
  }

  function applyReviewEvent(eventKey) {
    const preset = eventPresets[eventKey] || eventPresets.all;
    state.activeEvent = eventPresets[eventKey] ? eventKey : "all";
    state.selectedItemKey = "";

    selectDatasetForSource(preset.source);
    updateClassOptions();
    updateQwenOptions();

    if (refs.split) refs.split.value = "";
    if (refs.answer) refs.answer.value = preset.answer || "";
    if (refs.query) refs.query.value = preset.query || "";
    if (refs.hasBox) refs.hasBox.checked = Boolean(preset.hasBox);

    const qwenApplied = setSelectValueIfPresent(refs.qwenLabel, preset.qwenLabel);
    const classApplied = setSelectValueIfPresent(refs.className, preset.className);
    if (preset.qwenLabel && !qwenApplied && refs.query && !refs.query.value) {
      refs.query.value = preset.qwenLabel;
    }
    if (preset.className && !classApplied && refs.query && !refs.query.value) {
      refs.query.value = preset.className;
    }

    renderSummary(selectedDataset());
    renderFireSmokeCard();
    updateEventButtons();
    loadItems({ resetPage: true }).catch(() => {});
  }

  function renderSummary(dataset) {
    if (!refs.summary) return;
    refs.summary.innerHTML = "";
    if (!dataset) {
      refs.summary.appendChild(createNode("p", "yolo-review-empty", "暂无数据集。"));
      return;
    }

    const cells = [
      ["来源", dataset.source_label || dataset.source_type || dataset.source || "-"],
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
    const selectedSource = refs.source?.value || "";
    state.datasets = state.allDatasets.filter((dataset) => {
      if (!selectedSource) return true;
      return dataset.source_type === selectedSource;
    });
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
    renderFireSmokeCard();
  }

  async function loadDatasets() {
    setStatus("加载数据集...", "loading");
    try {
      const data = await requestJson(endpoints.datasets);
      state.allDatasets = Array.isArray(data.datasets) ? data.datasets : [];
      refreshDatasetOptions();
      if (!state.datasetId && state.datasets.length) {
        state.datasetId = state.datasets[0].id;
      }
      refs.dataset.value = state.datasetId;
      updateClassOptions();
      updateQwenOptions();
      renderFireSmokeCard();
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
      refs.list.innerHTML = "";
      refs.list.appendChild(createNode("p", "yolo-review-empty", "暂无数据集。"));
      refs.detail.innerHTML = "";
      refs.detail.appendChild(createNode("p", "yolo-review-empty", "暂无样本。"));
      return;
    }

    setStatus("加载样本...", "loading");
    try {
      const data = await requestJson(buildItemsUrl());
      state.page = data.page || 1;
      state.totalPages = data.total_pages || 1;
      updateSplitOptions(data.available_splits || []);
      renderList(data.items || []);
      refs.page.textContent = `第 ${state.page} / ${state.totalPages} 页 · ${compactNumber(data.total)} 条`;
      refs.prev.disabled = state.page <= 1;
      refs.next.disabled = state.page >= state.totalPages;
      setStatus("样本就绪", "ok");
      if (!state.selectedItemKey) {
        refs.detail.innerHTML = "";
        refs.detail.appendChild(createNode("p", "yolo-review-empty", "点击左侧样本后加载原图和标注框。"));
      }
    } catch (error) {
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
      chips.appendChild(createNode("span", "ai-history-chip tone-idle", item.source_label || "数据源"));
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
    state.selectedItemKey = itemKey;
    refs.detail.dataset.state = "loading";
    refs.detail.innerHTML = "";
    refs.detail.appendChild(createNode("p", "yolo-review-empty", "加载样本详情..."));
    refs.list.querySelectorAll(".yolo-review-item").forEach((node) => node.classList.remove("is-active"));

    try {
      const params = new URLSearchParams({ dataset_id: state.datasetId, item_key: itemKey });
      const data = await requestJson(`${endpoints.item}?${params.toString()}`);
      renderDetail(data.dataset, data.item);
      refs.detail.dataset.state = "idle";
      renderListActive(itemKey);
    } catch (error) {
      refs.detail.dataset.state = "error";
      refs.detail.innerHTML = "";
      refs.detail.appendChild(createNode("p", "yolo-review-empty", `详情加载失败：${error?.message || "未知错误"}`));
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
    if (isVehicleCollection) {
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
    if (isVehicleCollection) {
      stage.appendChild(createNode("p", "yolo-review-drag-hint", "拖动查看 · 滚轮缩放 · 双击复位"));
      enableDragView(stage, panContent);
    }
    renderBoxes(overlay, item.labels || []);
    imageBlock.appendChild(stage);
    imageBlock.appendChild(createNode("p", "yolo-review-path", item.item_key));

    const meta = createNode("div", "yolo-review-meta-grid");
    meta.appendChild(metaItem("来源", item.source_label || dataset.source_label || "-"));
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
      state.selectedItemKey = "";
      loadItems({ resetPage: true }).catch(() => {});
    }, 220);
  }

  refs.dataset?.addEventListener("change", () => {
    markCustomEventFilter();
    state.datasetId = refs.dataset.value;
    state.selectedItemKey = "";
    refs.split.value = "";
    refs.className.value = "";
    refs.answer.value = "";
    if (refs.qwenLabel) refs.qwenLabel.value = "";
    updateClassOptions();
    updateQwenOptions();
    renderSummary(selectedDataset());
    renderFireSmokeCard();
    loadItems({ resetPage: true }).catch(() => {});
  });
  refs.source?.addEventListener("change", () => {
    markCustomEventFilter();
    state.selectedItemKey = "";
    refs.split.value = "";
    refs.className.value = "";
    refs.answer.value = "";
    if (refs.qwenLabel) refs.qwenLabel.value = "";
    refreshDatasetOptions();
    updateClassOptions();
    updateQwenOptions();
    renderSummary(selectedDataset());
    renderFireSmokeCard();
    loadItems({ resetPage: true }).catch(() => {});
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
  refs.fireSmokeOpen?.addEventListener("click", openFireSmokeDataset);
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
