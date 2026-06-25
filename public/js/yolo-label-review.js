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
    query: document.getElementById("yolo-review-query"),
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
    selectedItemKey: ""
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
    updateClassOptions();
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
      renderFireSmokeCard();
      renderSummary(selectedDataset());
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
      if (!state.selectedItemKey && data.items?.[0]?.item_key) {
        loadDetail(data.items[0].item_key).catch(() => {});
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
      top.appendChild(createNode("p", "yolo-review-item-title", item.ai_class || item.event_name || item.source_label || "-"));
      top.appendChild(createNode("span", `ai-history-chip ${answerTone(item.ai_answer)}`, item.ai_answer || "-"));
      body.appendChild(top);
      const metaText = item.source_type === "vehicle_collection"
        ? `${item.split || "-"} · ${item.vehicle_id || item.device_id || "-"} · ${item.camera_id || "-"} · ${formatDate(item.collected_at)}`
        : `${item.split || "-"} · ${item.request_id || "-"} · task ${item.task_row_id || item.task_id || "-"}`;
      body.appendChild(createNode("p", "yolo-review-item-meta", metaText));

      const chips = createNode("div", "yolo-review-item-chips");
      chips.appendChild(createNode("span", "ai-history-chip tone-idle", item.source_label || "数据源"));
      chips.appendChild(createNode("span", "ai-history-chip tone-idle", `${item.label_count || 0} 框`));
      if (item.auto_label_status) {
        chips.appendChild(createNode("span", `ai-history-chip ${item.auto_label_status === "done" ? "tone-yes" : "tone-idle"}`, item.auto_label_status === "done" ? "已预标注" : "待预标注"));
      }
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
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let offsetX = 0;
    let offsetY = 0;
    let baseX = 0;
    let baseY = 0;
    let scale = 1;

    function apply() {
      content.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
    }

    stage.addEventListener("pointerdown", (event) => {
      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      baseX = offsetX;
      baseY = offsetY;
      stage.classList.add("is-dragging");
      stage.setPointerCapture?.(event.pointerId);
    });

    stage.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      offsetX = baseX + event.clientX - startX;
      offsetY = baseY + event.clientY - startY;
      apply();
    });

    function stopDrag(event) {
      dragging = false;
      stage.classList.remove("is-dragging");
      if (event?.pointerId != null) stage.releasePointerCapture?.(event.pointerId);
    }

    stage.addEventListener("pointerup", stopDrag);
    stage.addEventListener("pointercancel", stopDrag);
    stage.addEventListener("wheel", (event) => {
      event.preventDefault();
      const delta = event.deltaY > 0 ? -0.12 : 0.12;
      scale = Math.max(1, Math.min(4, scale + delta));
      if (scale === 1) {
        offsetX = 0;
        offsetY = 0;
      }
      apply();
    }, { passive: false });
    stage.addEventListener("dblclick", () => {
      scale = 1;
      offsetX = 0;
      offsetY = 0;
      apply();
    });
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
    meta.appendChild(metaItem("AI答案", item.ai_answer));
    meta.appendChild(metaItem("YOLO框数", item.label_count));
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
    labelTitle.appendChild(createNode("h3", "", "YOLO 标签"));
    labelTitle.appendChild(createNode("span", "ai-history-chip tone-idle", item.auto_label_status === "pending" ? "待预标注" : dataset.kind === "classify" ? "分类样本" : item.label_rel_path || "无 label"));
    labels.appendChild(labelTitle);
    if (dataset.kind === "classify") {
      labels.appendChild(createNode("p", "yolo-review-label-line", `class: ${item.ai_class || "-"}`));
    } else if (item.labels?.length) {
      item.labels.forEach((label) => {
        labels.appendChild(createNode("p", "yolo-review-label-line", `${label.class_name} · ${label.raw}`));
      });
    } else {
      labels.appendChild(createNode("p", "yolo-review-label-line", "empty label"));
    }
    refs.detail.appendChild(labels);

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
    state.datasetId = refs.dataset.value;
    state.selectedItemKey = "";
    refs.split.value = "";
    refs.className.value = "";
    refs.answer.value = "";
    updateClassOptions();
    renderSummary(selectedDataset());
    renderFireSmokeCard();
    loadItems({ resetPage: true }).catch(() => {});
  });
  refs.source?.addEventListener("change", () => {
    state.selectedItemKey = "";
    refs.split.value = "";
    refs.className.value = "";
    refs.answer.value = "";
    refreshDatasetOptions();
    updateClassOptions();
    renderSummary(selectedDataset());
    renderFireSmokeCard();
    loadItems({ resetPage: true }).catch(() => {});
  });
  refs.split?.addEventListener("change", scheduleReload);
  refs.className?.addEventListener("change", scheduleReload);
  refs.answer?.addEventListener("change", scheduleReload);
  refs.query?.addEventListener("input", scheduleReload);
  refs.refresh?.addEventListener("click", () => loadDatasets().catch(() => {}));
  refs.fireSmokeOpen?.addEventListener("click", openFireSmokeDataset);
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
