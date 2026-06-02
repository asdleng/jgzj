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
  const topologyNode = document.getElementById("cloud-runtime-topology");
  const summaryNode = document.getElementById("cloud-runtime-summary");
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
      ? "架构图已按当前 runtime 状态生成，重启按钮会先停旧实例再拉起新实例。"
      : "请先登录云端智能运维账号，登录后才能查看服务器架构图和执行重启。";
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

  function visibleRuntimeNodes(nodes) {
    return (Array.isArray(nodes) ? nodes : []).filter((node) => !node?.hidden);
  }

  function formatPortText(ports, prefix) {
    const values = Array.isArray(ports) ? ports.filter(Boolean) : [];
    if (!values.length) {
      return "";
    }
    return `${prefix} ${values.join(" / ")}`;
  }

  function createStateChip(state) {
    return createNode("span", `server-port-state-chip is-${state || "unknown"}`, normalizeStateLabel(state));
  }

  function createRestartButton(node) {
    const label = node?.action_label || "重启";
    const busyLabel = node?.action_busy_label || `${label}中...`;
    const button = createNode(
      "button",
      "server-port-restart",
      busyTargetId === node?.id ? busyLabel : label
    );
    button.type = "button";
    button.disabled = Boolean(busyTargetId) || !authenticated || !node?.id;
    button.dataset.targetId = node?.id || "";
    button.dataset.targetLabel = node?.label || "";
    button.addEventListener("click", () => {
      restartRuntimeNode(node?.id, node?.label);
    });
    return button;
  }

  function createInlineRestartButton(targetId, targetLabel) {
    const button = createNode(
      "button",
      "server-port-restart server-port-restart-inline",
      busyTargetId === targetId ? "重启中..." : "重启"
    );
    button.type = "button";
    button.disabled = Boolean(busyTargetId) || !authenticated || !targetId;
    button.dataset.targetId = targetId || "";
    button.dataset.targetLabel = targetLabel || targetId || "";
    button.addEventListener("click", () => {
      restartRuntimeNode(targetId, targetLabel || targetId);
    });
    return button;
  }

  function createPortChip(text) {
    return createNode("span", "server-port-chip", text);
  }

  function checkToneClass(check) {
    const state = String(check?.state || "").trim();
    if (state === "warn") return "is-warn";
    if (check?.ok) return "is-ok";
    return "is-bad";
  }

  function createCheckList(node) {
    const checks = Array.isArray(node?.checks) ? node.checks : [];
    if (!checks.length) {
      return null;
    }
    const list = createNode("div", "cloud-runtime-check-list");
    checks.forEach((check) => {
      const item = createNode("div", `cloud-runtime-check ${checkToneClass(check)}`);
      const meta = createNode("div", "cloud-runtime-check-meta");
      meta.appendChild(createNode("span", "cloud-runtime-check-label", check?.label || "未命名检查"));
      const value = check?.summary || (check?.ok ? "正常" : "异常");
      meta.appendChild(createNode("span", "cloud-runtime-check-value", value));
      item.appendChild(meta);
      if (check?.restart_target_id) {
        item.appendChild(
          createInlineRestartButton(check.restart_target_id, check.restart_target_label || check.restart_target_id)
        );
      }
      list.appendChild(item);
    });
    return list;
  }

  function appendPortChips(parent, node) {
    const publicText = formatPortText(node?.public_ports, "公网");
    const localText = formatPortText(node?.local_ports, "本机");
    if (publicText) {
      parent.appendChild(createPortChip(publicText));
    }
    if (localText) {
      parent.appendChild(createPortChip(localText));
    }
  }

  function createOpsBlock(node) {
    const ops = createNode("div", "server-port-ops");
    const stateRow = createNode("div", "server-port-ops-row");
    stateRow.appendChild(createStateChip(node?.state));
    stateRow.appendChild(createRestartButton(node));
    ops.appendChild(stateRow);
    if (node?.status_text) {
      ops.appendChild(createNode("p", "server-port-status", node.status_text));
    }
    return ops;
  }

  function renderPublicLane(node) {
    const article = createNode("article", `server-port-lane page-card is-${node?.state || "unknown"}`);

    const publicBox = createNode("div", "server-port-public");
    publicBox.appendChild(createNode("span", "server-port-number", (node.public_ports || []).join(" / ")));
    publicBox.appendChild(createNode("span", "", "公网入口"));
    article.appendChild(publicBox);

    article.appendChild(createNode("div", "server-port-arrow", "→"));

    const service = createNode("div", "server-port-service");
    service.appendChild(createNode("p", "", node.label || "未命名节点"));
    service.appendChild(createNode("strong", "", node.description || node.group || "-"));
    const chips = createNode("div", "server-port-chip-list");
    appendPortChips(chips, node);
    service.appendChild(chips);
    const checks = createCheckList(node);
    if (checks) {
      service.appendChild(checks);
    }
    article.appendChild(service);

    article.appendChild(createNode("div", "server-port-arrow", "→"));
    article.appendChild(createOpsBlock(node));

    return article;
  }

  function renderAuxiliaryCard(node) {
    const card = createNode("article", `server-runtime-extra-card page-card is-${node?.state || "unknown"}`);
    const head = createNode("div", "server-runtime-extra-head");
    head.appendChild(createNode("h3", "", node.label || node.id || "未命名节点"));
    head.appendChild(createStateChip(node?.state));
    card.appendChild(head);
    card.appendChild(createNode("p", "", node.description || node.group || "-"));
    const chips = createNode("div", "server-port-chip-list");
    appendPortChips(chips, node);
    card.appendChild(chips);
    const actions = createNode("div", "server-port-ops-row");
    actions.appendChild(createRestartButton(node));
    if (node?.status_text) {
      actions.appendChild(createNode("span", "server-port-status-inline", node.status_text));
    }
    card.appendChild(actions);
    const checks = createCheckList(node);
    if (checks) {
      card.appendChild(checks);
    }
    return card;
  }

  function renderTopology(nodes) {
    if (!topologyNode) {
      return;
    }
    topologyNode.innerHTML = "";
    if (!authenticated) {
      topologyNode.appendChild(createNode("p", "cloud-runtime-empty", "登录后根据服务器 runtime 状态生成端口拓扑。"));
      return;
    }
    if (!Array.isArray(nodes) || !nodes.length) {
      topologyNode.appendChild(createNode("p", "cloud-runtime-empty", "当前没有可绘制的服务器节点。"));
      return;
    }

    const frpNode = nodes.find((node) => node?.id === "frp-public-7788-7791");
    const publicNodes = visibleRuntimeNodes(nodes)
      .filter((node) => node?.id !== "frp-public-7788-7791" && Array.isArray(node?.public_ports) && node.public_ports.length)
      .sort((left, right) => String(left.public_ports?.[0] || "").localeCompare(String(right.public_ports?.[0] || "")));
    const auxiliaryNodes = visibleRuntimeNodes(nodes).filter(
      (node) => node?.id !== "frp-public-7788-7791" && (!Array.isArray(node?.public_ports) || !node.public_ports.length)
    );

    const map = createNode("div", "server-port-map");
    const spine = createNode("div", `server-port-spine is-${frpNode?.state || "unknown"}`);
    spine.appendChild(createNode("span", "", "公网访问层"));
    spine.appendChild(createNode("strong", "", "FRP"));
    spine.appendChild(createNode("p", "server-port-state", frpNode?.description || "统一维护公网端口到本机服务的转发链路。"));
    const frpChips = createNode("div", "server-port-chip-list");
    appendPortChips(frpChips, frpNode || {});
    spine.appendChild(frpChips);
    const frpChecks = createCheckList(frpNode);
    if (frpChecks) {
      spine.appendChild(frpChecks);
    }
    if (frpNode) {
      spine.appendChild(createOpsBlock(frpNode));
    }
    map.appendChild(spine);

    const lanes = createNode("div", "server-port-lanes");
    publicNodes.forEach((node) => {
      lanes.appendChild(renderPublicLane(node));
    });
    map.appendChild(lanes);
    topologyNode.appendChild(map);

    if (auxiliaryNodes.length) {
      const extras = createNode("div", "server-runtime-extra-grid");
      auxiliaryNodes.forEach((node) => {
        extras.appendChild(renderAuxiliaryCard(node));
      });
      topologyNode.appendChild(extras);
    }
  }

  function renderLockedState() {
    lastSnapshot = null;
    renderTopology([]);
    if (summaryNode) {
      summaryNode.innerHTML = "";
      summaryNode.appendChild(createNode("p", "cloud-runtime-empty", "请先登录云端智能运维账号。"));
    }
    updateUpdatedAt("");
  }

  function renderSummary(nodes) {
    if (!summaryNode) {
      return;
    }
    summaryNode.innerHTML = "";
    const visibleNodes = visibleRuntimeNodes(nodes);
    if (!visibleNodes.length) {
      summaryNode.appendChild(createNode("p", "cloud-runtime-empty", "当前还没有可展示的链路节点。"));
      return;
    }

    const counts = summarizeCounts(visibleNodes);
    const items = [
      { label: "关键节点", value: String(visibleNodes.length), tone: "" },
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

  function applySnapshot(data) {
    authenticated = Boolean(data?.authenticated);
    updateAuthHint();
    const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
    lastSnapshot = {
      nodes,
      refreshed_at: data?.refreshed_at || ""
    };
    renderSummary(nodes);
    renderTopology(nodes);
    updateUpdatedAt(data?.refreshed_at || "");
  }

  async function fetchStatus(options = {}) {
    if (!authenticated) {
      renderLockedState();
      setStatus("需登录", "idle");
      return;
    }
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
      if (/HTTP 401|openclaw_auth_required|login_required/i.test(String(error?.message || ""))) {
        authenticated = false;
        updateAuthHint();
        renderLockedState();
        setStatus("需登录", "idle");
        return;
      }
      setStatus(error?.message || "状态获取失败", "error");
      if (!lastSnapshot) {
        renderSummary([]);
        renderTopology([]);
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
      renderTopology(lastSnapshot.nodes);
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
        renderTopology(lastSnapshot.nodes);
      }
    }
  }

  function schedulePolling() {
    if (pollTimer) {
      window.clearInterval(pollTimer);
    }
    pollTimer = window.setInterval(() => {
      if (authenticated) {
        fetchStatus({ silent: true });
      }
    }, REFRESH_INTERVAL_MS);
  }

  refreshBtn?.addEventListener("click", () => {
    fetchStatus();
  });

  window.addEventListener("jgzj:cloud-ops-auth", (event) => {
    authenticated = Boolean(event?.detail?.authenticated);
    updateAuthHint();
    if (authenticated) {
      fetchStatus({ silent: Boolean(lastSnapshot) });
    } else {
      busyTargetId = "";
      busyTargetLabel = "";
      renderLockedState();
      setStatus("需登录", "idle");
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && authenticated) {
      fetchStatus({ silent: true });
    }
  });

  updateAuthHint();
  renderLockedState();
  setStatus("需登录", "idle");
  schedulePolling();
})();
