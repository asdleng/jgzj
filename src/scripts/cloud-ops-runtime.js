(function () {
  const root = document.getElementById("cloud-runtime-console");
  if (!root) {
    return;
  }

  const STATUS_URL = "/api/cloud-ops/runtime/status";
  const RESTART_URL = "/api/cloud-ops/runtime/restart";
  const REFRESH_INTERVAL_MS = 8000;

  const refreshBtn = document.getElementById("cloud-runtime-refresh");
  const statusNode = document.getElementById("cloud-runtime-status");
  const authHintNode = document.getElementById("cloud-runtime-auth-tip");
  const summaryNode = document.getElementById("cloud-runtime-summary");
  const groupsNode = document.getElementById("cloud-runtime-groups");
  const updatedAtNode = document.getElementById("cloud-runtime-updated-at");

  let authenticated = false;
  let busyTargetId = "";
  let busyTargetLabel = "";
  let lastSnapshot = null;
  let pollTimer = 0;
  let requestInFlight = false;

  function sleep(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  function createNode(tagName, className, text) {
    const node = document.createElement(tagName);
    if (className) {
      node.className = className;
    }
    if (text !== undefined && text !== null) {
      node.textContent = String(text);
    }
    return node;
  }

  function setStatus(text, state) {
    if (!statusNode) {
      return;
    }
    statusNode.textContent = text;
    statusNode.dataset.state = state || "idle";
  }

  function formatDateTime(value) {
    const ts = Date.parse(String(value || ""));
    if (!Number.isFinite(ts)) {
      return "-";
    }
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(new Date(ts));
  }

  function updateAuthHint() {
    if (!authHintNode) {
      return;
    }
    authHintNode.textContent = authenticated
      ? "已登录，可直接重启下方关键链路。重启会先停旧实例，再拉起新实例。"
      : "未登录时可查看实时状态；登录后才可执行重启。";
  }

  function updateUpdatedAt(value) {
    if (!updatedAtNode) {
      return;
    }
    updatedAtNode.textContent = value ? `最近刷新：${formatDateTime(value)}` : "最近刷新：-";
  }

  function normalizeStateLabel(state) {
    if (state === "ok") return "正常";
    if (state === "warn") return "关注";
    if (state === "error") return "异常";
    return "未知";
  }

  function summarizeCounts(nodes) {
    return nodes.reduce(
      (acc, item) => {
        if (item?.state === "ok") acc.ok += 1;
        else if (item?.state === "warn") acc.warn += 1;
        else acc.error += 1;
        return acc;
      },
      { ok: 0, warn: 0, error: 0 }
    );
  }

  function renderSummary(nodes) {
    if (!summaryNode) {
      return;
    }
    summaryNode.innerHTML = "";
    if (!Array.isArray(nodes) || !nodes.length) {
      summaryNode.appendChild(createNode("p", "cloud-runtime-empty", "当前还没有可展示的链路节点。"));
      return;
    }

    const counts = summarizeCounts(nodes);
    const items = [
      { label: "关键节点", value: String(nodes.length), tone: "" },
      { label: "正常", value: String(counts.ok), tone: "ok" },
      { label: "关注", value: String(counts.warn), tone: "warn" },
      { label: "异常", value: String(counts.error), tone: "error" }
    ];

    items.forEach((item) => {
      const card = createNode("article", `cloud-runtime-summary-card${item.tone ? ` is-${item.tone}` : ""}`);
      card.appendChild(createNode("p", "cloud-runtime-summary-label", item.label));
      card.appendChild(createNode("p", "cloud-runtime-summary-value", item.value));
      summaryNode.appendChild(card);
    });
  }

  function describeController(controller) {
    if (!controller || typeof controller !== "object") {
      return [];
    }
    if (controller.type === "systemd") {
      return [
        { label: "控制器", value: controller.service_name || "-" },
        { label: "systemd", value: controller.summary || "-" },
        { label: "PID", value: controller.main_pid ? String(controller.main_pid) : "-" },
        { label: "启动于", value: controller.started_at || "-" }
      ];
    }
    if (controller.type === "tmux") {
      return [
        { label: "控制器", value: controller.session_name || "-" },
        { label: "tmux", value: controller.summary || "-" }
      ];
    }
    if (controller.type === "process") {
      return [
        { label: "控制器", value: "frpc" },
        { label: "进程", value: controller.summary || "-" },
        { label: "命令", value: controller.command || "-" }
      ];
    }
    return [];
  }

  function renderCheckItem(check) {
    const row = createNode(
      "div",
      `cloud-runtime-check${check?.ok ? " is-ok" : " is-bad"}`
    );
    const label = createNode("span", "cloud-runtime-check-label", check?.label || check?.url || "检查项");
    const value = createNode(
      "span",
      "cloud-runtime-check-value",
      check?.summary || (check?.ok ? "ok" : check?.error || "failed")
    );
    row.appendChild(label);
    row.appendChild(value);
    return row;
  }

  function renderGroupCard(node) {
    const article = createNode("article", `cloud-runtime-card is-${node?.state || "unknown"}`);
    article.dataset.state = node?.state || "unknown";

    const head = createNode("div", "cloud-runtime-card-head");
    const headMain = createNode("div", "cloud-runtime-card-title-wrap");
    headMain.appendChild(createNode("p", "cloud-runtime-card-title", node?.label || "未命名节点"));
    if (node?.description) {
      headMain.appendChild(createNode("p", "cloud-runtime-card-desc", node.description));
    }
    head.appendChild(headMain);

    const stateChip = createNode(
      "span",
      `cloud-runtime-state-chip is-${node?.state || "unknown"}`,
      normalizeStateLabel(node?.state)
    );
    head.appendChild(stateChip);
    article.appendChild(head);

    if (node?.port_text) {
      article.appendChild(createNode("p", "cloud-runtime-port-text", node.port_text));
    }

    const metaList = createNode("div", "cloud-runtime-meta-grid");
    const metaEntries = describeController(node?.controller);
    metaEntries.forEach((item) => {
      const meta = createNode("article", "cloud-runtime-meta-item");
      meta.appendChild(createNode("p", "cloud-runtime-meta-label", item.label));
      meta.appendChild(createNode("p", "cloud-runtime-meta-value", item.value));
      metaList.appendChild(meta);
    });
    article.appendChild(metaList);

    const checksWrap = createNode("div", "cloud-runtime-check-list");
    (Array.isArray(node?.checks) ? node.checks : []).forEach((check) => {
      checksWrap.appendChild(renderCheckItem(check));
    });
    article.appendChild(checksWrap);

    const actions = createNode("div", "cloud-runtime-card-actions");
    const statusText = createNode("p", "cloud-runtime-card-status", node?.status_text || "-");
    actions.appendChild(statusText);

    const restartBtn = createNode("button", "cloud-runtime-restart", busyTargetId === node.id ? "重启中..." : "重启");
    restartBtn.type = "button";
    restartBtn.disabled = Boolean(busyTargetId) || !authenticated;
    restartBtn.dataset.targetId = node?.id || "";
    restartBtn.dataset.targetLabel = node?.label || "";
    restartBtn.addEventListener("click", () => {
      restartRuntimeNode(node?.id, node?.label);
    });
    actions.appendChild(restartBtn);

    article.appendChild(actions);
    return article;
  }

  function renderGroups(nodes) {
    if (!groupsNode) {
      return;
    }
    groupsNode.innerHTML = "";
    if (!Array.isArray(nodes) || !nodes.length) {
      groupsNode.appendChild(createNode("p", "cloud-runtime-empty", "当前没有可展示的链路节点。"));
      return;
    }

    const groups = new Map();
    nodes.forEach((item) => {
      const groupName = item?.group || "未分组";
      if (!groups.has(groupName)) {
        groups.set(groupName, []);
      }
      groups.get(groupName).push(item);
    });

    groups.forEach((items, groupName) => {
      const section = createNode("section", "cloud-runtime-group");
      const head = createNode("div", "cloud-runtime-group-head");
      head.appendChild(createNode("p", "cloud-runtime-group-title", groupName));
      section.appendChild(head);

      const grid = createNode("div", "cloud-runtime-grid");
      items.forEach((item) => {
        grid.appendChild(renderGroupCard(item));
      });
      section.appendChild(grid);
      groupsNode.appendChild(section);
    });
  }

  function applySnapshot(data) {
    authenticated = Boolean(data?.authenticated);
    updateAuthHint();
    const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
    lastSnapshot = {
      nodes,
      refreshed_at: data?.refreshed_at || ""
    };
    renderSummary(nodes);
    renderGroups(nodes);
    updateUpdatedAt(data?.refreshed_at || "");
  }

  async function fetchStatus(options = {}) {
    if (requestInFlight) {
      return;
    }
    requestInFlight = true;
    if (!options.silent) {
      setStatus("刷新中...", "loading");
    }

    try {
      const response = await fetch(STATUS_URL, {
        headers: { Accept: "application/json" }
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.ok) {
        throw new Error(data?.detail || `HTTP ${response.status}`);
      }
      applySnapshot(data);
      if (!options.silent || !busyTargetId) {
        setStatus("状态已同步", "ok");
      }
    } catch (error) {
      setStatus(error?.message || "状态获取失败", "error");
      if (!lastSnapshot) {
        renderSummary([]);
        renderGroups([]);
      }
    } finally {
      requestInFlight = false;
    }
  }

  async function restartRuntimeNode(targetId, targetLabel) {
    if (!targetId) {
      return;
    }
    if (!authenticated) {
      setStatus("登录后可重启关键节点", "idle");
      return;
    }
    if (busyTargetId) {
      return;
    }

    busyTargetId = targetId;
    busyTargetLabel = targetLabel || targetId;
    if (lastSnapshot) {
      renderGroups(lastSnapshot.nodes);
    }
    setStatus(`正在重启 ${busyTargetLabel}...`, "loading");

    try {
      const response = await fetch(RESTART_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({ target_id: targetId })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.ok) {
        throw new Error(data?.detail || data?.summary || `HTTP ${response.status}`);
      }
      setStatus(
        data?.summary || `${busyTargetLabel} 已完成重启`,
        data?.queued ? "loading" : "ok"
      );
      if (data?.queued) {
        await sleep(5000);
      }
      await fetchStatus({ silent: true });
    } catch (error) {
      setStatus(error?.message || `${busyTargetLabel} 重启失败`, "error");
      await fetchStatus({ silent: true });
    } finally {
      busyTargetId = "";
      busyTargetLabel = "";
      if (lastSnapshot) {
        renderGroups(lastSnapshot.nodes);
      }
    }
  }

  function schedulePolling() {
    if (pollTimer) {
      window.clearInterval(pollTimer);
    }
    pollTimer = window.setInterval(() => {
      fetchStatus({ silent: true });
    }, REFRESH_INTERVAL_MS);
  }

  refreshBtn?.addEventListener("click", () => {
    fetchStatus();
  });

  window.addEventListener("jgzj:cloud-ops-auth", (event) => {
    authenticated = Boolean(event?.detail?.authenticated);
    updateAuthHint();
    if (lastSnapshot) {
      renderGroups(lastSnapshot.nodes);
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      fetchStatus({ silent: true });
    }
  });

  updateAuthHint();
  schedulePolling();
  fetchStatus();
})();
