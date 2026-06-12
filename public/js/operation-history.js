(() => {
  const API_URL = "/api/operation-audit";
  const state = {
    page: 1,
    pageSize: 30,
    totalPages: 1,
    loading: false
  };

  const form = document.getElementById("operation-history-filters");
  const refreshBtn = document.getElementById("operation-history-refresh");
  const prevBtn = document.getElementById("operation-history-prev");
  const nextBtn = document.getElementById("operation-history-next");
  const statusNode = document.getElementById("operation-history-status");
  const pageNode = document.getElementById("operation-history-page");
  const bodyNode = document.getElementById("operation-history-body");

  if (!form || !bodyNode) return;

  function setStatus(text, mode = "idle") {
    if (!statusNode) return;
    statusNode.textContent = text;
    statusNode.dataset.state = mode;
  }

  function text(value, fallback = "-") {
    const normalized = String(value ?? "").trim();
    return normalized || fallback;
  }

  function formatTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return text(value);
    return date.toLocaleString("zh-CN", {
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  }

  function categoryLabel(value) {
    const labels = {
      auth: "账号",
      cloud_ops: "云端运维",
      runtime: "服务器",
      map_editor: "地图编辑",
      ai: "AI",
      mapping: "云端建图",
      three_dgs: "3DGS",
      crowd_cpm: "众包采集",
      system: "系统"
    };
    return labels[value] || text(value);
  }

  function actionLabel(value) {
    return String(value || "")
      .replace(/^cloud_ops\.tool_call\./, "车端工具 ")
      .replace(/^cloud_ops\./, "云端运维 ")
      .replace(/^auth\./, "账号 ")
      .replace(/^runtime\./, "服务器 ")
      .replace(/^map_editor\./, "地图 ")
      .replace(/^ai\./, "AI ")
      .replace(/\./g, " ");
  }

  function createCell(content) {
    const td = document.createElement("td");
    if (content instanceof Node) {
      td.appendChild(content);
    } else {
      td.textContent = text(content);
    }
    return td;
  }

  function createChip(content, className = "") {
    const span = document.createElement("span");
    span.className = `operation-history-chip ${className}`.trim();
    span.textContent = content;
    return span;
  }

  function renderAction(record) {
    const wrap = document.createElement("div");
    wrap.className = "operation-history-action";

    const strong = document.createElement("strong");
    strong.textContent = actionLabel(record.action);
    wrap.appendChild(strong);

    const small = document.createElement("small");
    small.textContent = `${record.method || "-"} ${record.path || "-"}`;
    wrap.appendChild(small);

    if (record.permission) {
      const permission = document.createElement("small");
      permission.textContent = `权限：${record.permission}`;
      wrap.appendChild(permission);
    }

    const detail = document.createElement("details");
    detail.className = "operation-history-detail";
    const summary = document.createElement("summary");
    summary.textContent = "详情";
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(record.detail || {}, null, 2);
    detail.appendChild(summary);
    detail.appendChild(pre);
    wrap.appendChild(detail);

    return wrap;
  }

  function renderRows(items) {
    bodyNode.innerHTML = "";
    if (!items.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 7;
      cell.textContent = "暂无记录";
      row.appendChild(cell);
      bodyNode.appendChild(row);
      return;
    }

    items.forEach((record) => {
      const row = document.createElement("tr");
      row.appendChild(createCell(formatTime(record.at)));
      row.appendChild(createCell(record.actor_name || record.actor));
      row.appendChild(createCell(categoryLabel(record.category)));
      row.appendChild(createCell(renderAction(record)));
      row.appendChild(createCell(record.target_id || record.target_type));
      row.appendChild(createCell(record.vehicle_id));
      row.appendChild(
        createCell(
          createChip(
            record.ok === false ? `失败 ${record.status || ""}` : `成功 ${record.status || ""}`,
            record.ok === false ? "is-error" : "is-ok"
          )
        )
      );
      bodyNode.appendChild(row);
    });
  }

  function readFilters() {
    const formData = new FormData(form);
    const params = new URLSearchParams();
    for (const [key, value] of formData.entries()) {
      const normalized = String(value || "").trim();
      if (normalized) {
        params.set(key, normalized);
      }
    }
    params.set("page", String(state.page));
    params.set("page_size", String(state.pageSize));
    return params;
  }

  function updatePager() {
    state.totalPages = Math.max(1, state.totalPages);
    if (pageNode) pageNode.textContent = `${state.page} / ${state.totalPages}`;
    if (prevBtn) prevBtn.disabled = state.loading || state.page <= 1;
    if (nextBtn) nextBtn.disabled = state.loading || state.page >= state.totalPages;
    if (refreshBtn) refreshBtn.disabled = state.loading;
  }

  async function loadHistory() {
    state.loading = true;
    updatePager();
    setStatus("加载中...", "loading");
    try {
      const response = await fetch(`${API_URL}?${readFilters().toString()}`, {
        headers: { Accept: "application/json" }
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.ok === false) {
        throw new Error(data?.detail || data?.error || `HTTP ${response.status}`);
      }
      state.page = Number(data.page || 1);
      state.totalPages = Number(data.total_pages || 1);
      renderRows(Array.isArray(data.items) ? data.items : []);
      setStatus(`共 ${Number(data.total || 0)} 条记录`, "ok");
    } catch (error) {
      renderRows([]);
      setStatus(error?.message || "加载失败", "error");
    } finally {
      state.loading = false;
      updatePager();
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    state.page = 1;
    loadHistory();
  });

  refreshBtn?.addEventListener("click", () => loadHistory());
  prevBtn?.addEventListener("click", () => {
    if (state.page <= 1) return;
    state.page -= 1;
    loadHistory();
  });
  nextBtn?.addEventListener("click", () => {
    if (state.page >= state.totalPages) return;
    state.page += 1;
    loadHistory();
  });

  window.addEventListener("jgzj:auth-change", () => {
    state.page = 1;
    loadHistory();
  });

  loadHistory();
})();
