(function () {
  const PROXY_URL = "/api/cloud-chat";
  const QWEN36_CHAT_URL = "/api/qwen36-chat";
  const QWEN36_HEALTH_URL = "/api/qwen36-health";
  const OPENCLAW_CHAT_URL = "/api/openclaw-chat";
  const OPENCLAW_HEALTH_URL = "/api/openclaw-health";
  const OPENCLAW_AUTH_STATUS_URL = "/api/openclaw-auth-status";
  const OPENCLAW_LOGIN_URL = "/api/openclaw-login";
  const OPENCLAW_LOGOUT_URL = "/api/openclaw-logout";
  const CLOUD_OPS_VEHICLES_URL = "/api/cloud-ops/vehicles";
  const CLOUD_OPS_EXECUTE_URL = "/api/cloud-ops/execute";
  const CLOUD_OPS_WS_PATH = "/ws/ops";
  const IDENTITIES_URL = "/api/chat-identities";
  const AI_CHECK_HISTORY_URL = "/api/ai-check-history";
  const QWEN36_MM_CHECK_URL = "/api/qwen36-mm-check";
  const AI_CHECK_HISTORY_PAGE_SIZE = 5;
  const DEFAULT_VEHICLE_ID = "car-web";
  const QWEN_CHECK_PATH = "/ws/qwen/check";
  const OPENCLAW_CHAT_PLACEHOLDER =
    "例如：先帮我做一键健康检查；或者：抓拍 4 路相机看看；再比如：结合刚刚的底盘 CAN 和定位结果，判断这台车现在能不能继续巡逻。";
  const OPENCLAW_LOCKED_PLACEHOLDER = "登录后可自然语言运维；未登录可先使用上方按钮查看车辆状态。";

  const chatForm = document.getElementById("chat-form");
  const chatInput = document.getElementById("chat-input");
  const chatMessages = document.getElementById("chat-messages");
  const chatStatus = document.getElementById("chat-status");
  const chatSend = document.getElementById("chat-send");
  const chatThinking = document.getElementById("chat-thinking");
  const identitySelect = document.getElementById("chat-identity");

  const qwen36Form = document.getElementById("qwen36-form");
  const qwen36Input = document.getElementById("qwen36-input");
  const qwen36Messages = document.getElementById("qwen36-messages");
  const qwen36Status = document.getElementById("qwen36-status");
  const qwen36Send = document.getElementById("qwen36-send");
  const qwen36Thinking = document.getElementById("qwen36-thinking");
  const qwen36Reset = document.getElementById("qwen36-reset");

  const openClawForm = document.getElementById("openclaw-form");
  const openClawInput = document.getElementById("openclaw-input");
  const openClawMessages = document.getElementById("openclaw-messages");
  const openClawStatus = document.getElementById("openclaw-status");
  const openClawSend = document.getElementById("openclaw-send");
  const openClawLogoutBtn = document.getElementById("openclaw-logout");
  const openClawAuth = document.getElementById("openclaw-auth");
  const openClawChatShell = document.getElementById("openclaw-chat-shell");
  const openClawLoginForm = document.getElementById("openclaw-login-form");
  const openClawUsername = document.getElementById("openclaw-username");
  const openClawPassword = document.getElementById("openclaw-password");
  const openClawAuthHint = document.getElementById("openclaw-auth-hint");
  const openClawLoginBtn = document.getElementById("openclaw-login");

  const cloudOpsConsole = document.getElementById("cloud-ops-console");
  const cloudOpsStatus = document.getElementById("cloud-ops-status");
  const cloudOpsInlineStatus = document.getElementById("cloud-ops-inline-status");
  const cloudOpsAuth = document.getElementById("cloud-ops-auth");
  const cloudOpsShell = document.getElementById("cloud-ops-shell");
  const cloudOpsLoginForm = document.getElementById("cloud-ops-login-form");
  const cloudOpsUsername = document.getElementById("cloud-ops-username");
  const cloudOpsPassword = document.getElementById("cloud-ops-password");
  const cloudOpsAuthHint = document.getElementById("cloud-ops-auth-hint");
  const cloudOpsLoginBtn = document.getElementById("cloud-ops-login");
  const cloudOpsLogoutBtn = document.getElementById("cloud-ops-logout");
  const cloudOpsVehicleSelect = document.getElementById("cloud-ops-vehicle");
  const cloudOpsRefreshBtn = document.getElementById("cloud-ops-refresh");
  const cloudOpsLiveCurrent = document.getElementById("cloud-ops-live-current");
  const cloudOpsAlertsList = document.getElementById("cloud-ops-alerts-list");
  const cloudOpsAlertsEmpty = document.getElementById("cloud-ops-alerts-empty");
  const cloudOpsAlertsStatus = document.getElementById("cloud-ops-alerts-status");
  const cloudOpsSummary = document.getElementById("cloud-ops-summary");
  const cloudOpsToolNote = document.getElementById("cloud-ops-tool-note");
  const cloudOpsResultSummary = document.getElementById("cloud-ops-result-summary");
  const cloudOpsResultDetails = document.getElementById("cloud-ops-result-details");
  const cloudOpsResultMedia = document.getElementById("cloud-ops-result-media");
  const cloudOpsResultJson = document.getElementById("cloud-ops-result-json");
  const cloudOpsContextList = document.getElementById("cloud-ops-context-list");
  const cloudOpsContextEmpty = document.getElementById("cloud-ops-context-empty");
  const cloudOpsContextClear = document.getElementById("cloud-ops-context-clear");
  const cloudOpsAudioStatus = document.getElementById("cloud-ops-audio-status");
  const cloudOpsAudioMicBtn = document.getElementById("cloud-ops-audio-mic");
  const cloudOpsAudioSpeakerBtn = document.getElementById("cloud-ops-audio-speaker");
  const cloudOpsActionButtons = Array.from(
    document.querySelectorAll("[data-cloud-ops-action]")
  );
  const cloudOpsAudioButtons = [cloudOpsAudioMicBtn, cloudOpsAudioSpeakerBtn].filter(Boolean);

  const aiCheckForm = document.getElementById("ai-check-form");
  const aiCheckImageInput = document.getElementById("ai-check-image");
  const aiCheckEventInput = document.getElementById("ai-check-event");
  const aiCheckPromptInput = document.getElementById("ai-check-prompt");
  const aiCheckPreview = document.getElementById("ai-check-preview");
  const aiCheckStatus = document.getElementById("ai-check-status");
  const aiCheckSubmit = document.getElementById("ai-check-submit");
  const aiCheckAnswer = document.getElementById("ai-check-answer");
  const aiCheckDetail = document.getElementById("ai-check-detail");
  const aiCheckResult = document.getElementById("ai-check-result");

  const qwen36mmForm = document.getElementById("qwen36mm-form");
  const qwen36mmImageInput = document.getElementById("qwen36mm-image");
  const qwen36mmEventInput = document.getElementById("qwen36mm-event");
  const qwen36mmPromptInput = document.getElementById("qwen36mm-prompt");
  const qwen36mmPreview = document.getElementById("qwen36mm-preview");
  const qwen36mmStatus = document.getElementById("qwen36mm-status");
  const qwen36mmSubmit = document.getElementById("qwen36mm-submit");
  const qwen36mmAnswer = document.getElementById("qwen36mm-answer");
  const qwen36mmDetail = document.getElementById("qwen36mm-detail");
  const qwen36mmResult = document.getElementById("qwen36mm-result");

  const aiHistoryPanel = document.getElementById("ai-history-panel");
  const aiHistoryStatus = document.getElementById("ai-history-status");
  const aiHistoryRefreshBtn = document.getElementById("ai-history-refresh");
  const aiHistoryDeviceFilterSelect = document.getElementById("ai-history-device-filter");
  const aiHistoryList = document.getElementById("ai-history-list");
  const aiHistoryDetail = document.getElementById("ai-history-detail");
  const aiHistoryPrevBtn = document.getElementById("ai-history-prev");
  const aiHistoryNextBtn = document.getElementById("ai-history-next");
  const aiHistoryPage = document.getElementById("ai-history-page");
  const aiHistoryLightbox = document.getElementById("ai-history-lightbox");
  const aiHistoryLightboxImage = document.getElementById("ai-history-lightbox-image");
  const aiHistoryLightboxCaption = document.getElementById("ai-history-lightbox-caption");
  const aiHistoryLightboxLink = document.getElementById("ai-history-lightbox-link");
  const aiHistoryLightboxClose = document.getElementById("ai-history-lightbox-close");

  const cloudChatUrl = window.CLOUD_CHAT_URL || PROXY_URL;
  const qwenCheckWsUrl = window.QWEN_CHECK_WS_URL || getQwenCheckWsUrl();

  let vehicleId = DEFAULT_VEHICLE_ID;
  let sessionId = createSessionId(vehicleId);
  let firstTurn = true;
  const messageHistory = [];
  let qwen36SessionId = createSessionId("qwen36");
  const qwen36History = [];

  let openClawSessionId = createSessionId("openclaw");
  let openClawModelLabel = "默认模型";
  let openClawAuthenticated = false;
  let cloudOpsAuthenticated = false;
  let cloudOpsBusy = false;
  let cloudOpsVehicles = [];
  let cloudOpsCurrentVehicleId = "";
  let cloudOpsCurrentDetail = null;
  let cloudOpsAvailableTools = new Set();
  let cloudOpsPinnedContexts = [];
  let cloudOpsOpsSocket = null;
  let cloudOpsOpsReconnectTimer = 0;
  let cloudOpsContextReloadTimer = 0;
  const cloudOpsWorkflowByRequestId = new Map();
  const CLOUD_OPS_AUDIO_SAMPLE_RATE = 16000;
  const CLOUD_OPS_AUDIO_DEFAULT_DURATION_S = 120;
  const CLOUD_OPS_AUDIO_DEFAULT_CHUNK_MS = 100;
  let cloudOpsAudioContext = null;
  const cloudOpsAudioChannels = new Map(
    [
      {
        toolName: "audio.uplink.mic",
        label: "听麦",
        idleHint: "车内麦克风上行音频",
        button: cloudOpsAudioMicBtn
      },
      {
        toolName: "audio.uplink.speaker",
        label: "听喇叭",
        idleHint: "整车喇叭最终混音输出",
        button: cloudOpsAudioSpeakerBtn
      }
    ]
      .filter((item) => item.button)
      .map((item) => [
        item.toolName,
        {
          ...item,
          phase: "idle",
          busy: false,
          streamId: "",
          vehicleId: "",
          errorText: ""
        }
      ])
  );
  const cloudOpsAudioStreams = new Map();

  let aiPreviewUrl = "";
  let qwen36mmPreviewUrl = "";
  let aiHistoryPageValue = 1;
  let aiHistoryTotalPages = 1;
  let aiHistorySelectedId = 0;
  let aiHistoryDeviceFilter = "";
  const CLOUD_OPS_TELEMETRY_STALE_S = 120;
  const CLOUD_OPS_BATTERY_WARN_PERCENT = 20;
  const CLOUD_OPS_BATTERY_ERROR_PERCENT = 10;

  function createNonce() {
    if (self.crypto && typeof self.crypto.randomUUID === "function") {
      return self.crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  }

  function createSessionId(identity) {
    return `${identity || DEFAULT_VEHICLE_ID}-${createNonce()}`;
  }

  function getQwenCheckWsUrl() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.hostname || "127.0.0.1";
    const port = host === "127.0.0.1" || host === "localhost" ? "8794" : "7789";
    return `${protocol}//${host}:${port}${QWEN_CHECK_PATH}`;
  }

  function getCloudOpsWsUrl() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.hostname || "127.0.0.1";
    const port = host === "127.0.0.1" || host === "localhost" ? "8000" : "7788";
    return `${protocol}//${host}:${port}${CLOUD_OPS_WS_PATH}`;
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

  function parseSseBlock(block) {
    const payload = String(block || "")
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6).trim())
      .join("\n");

    if (!payload) {
      return null;
    }

    try {
      return JSON.parse(payload);
    } catch (_error) {
      return null;
    }
  }

  function extractReply(data) {
    return (
      data?.reply ||
      data?.text ||
      data?.message ||
      data?.data?.reply ||
      data?.answer ||
      ""
    );
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  const _cstFmt = {
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "Asia/Shanghai"
  };

  function formatTimeLabel(value, fallback = "-") {
    const ms = Number(value);
    if (Number.isFinite(ms) && ms > 0) {
      return new Date(ms).toLocaleString("zh-CN", _cstFmt);
    }
    if (fallback && fallback !== "-") {
      return String(fallback);
    }
    return "-";
  }

  function formatIsoTimestamp(value) {
    if (!value || value === "-") return "-";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString("zh-CN", _cstFmt);
  }

  function scrollPanelMessages(container) {
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }

  function escapeMessageHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderInlineMarkdown(text) {
    let html = escapeMessageHtml(text);
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    return html;
  }

  function renderMarkdownLite(text) {
    const source = String(text || "").replace(/\r\n/g, "\n").trim();
    if (!source) {
      return "";
    }

    const blocks = source.split(/\n{2,}/);
    const htmlBlocks = blocks.map((block) => {
      const lines = block.split("\n").filter((line) => line.trim());
      if (!lines.length) {
        return "";
      }

      if (lines[0].startsWith("```") && lines[lines.length - 1]?.startsWith("```")) {
        const code = lines.slice(1, -1).join("\n");
        return `<pre><code>${escapeMessageHtml(code)}</code></pre>`;
      }

      if (lines.every((line) => /^\s*[-*]\s+/.test(line))) {
        const items = lines
          .map((line) => line.replace(/^\s*[-*]\s+/, "").trim())
          .filter(Boolean)
          .map((line) => `<li>${renderInlineMarkdown(line)}</li>`)
          .join("");
        return `<ul>${items}</ul>`;
      }

      if (lines.every((line) => /^\s*\d+\.\s+/.test(line))) {
        const items = lines
          .map((line) => line.replace(/^\s*\d+\.\s+/, "").trim())
          .filter(Boolean)
          .map((line) => `<li>${renderInlineMarkdown(line)}</li>`)
          .join("");
        return `<ol>${items}</ol>`;
      }

      const headingMatch = lines.length === 1 ? lines[0].match(/^(#{1,4})\s+(.+)$/) : null;
      if (headingMatch) {
        const level = Math.min(4, headingMatch[1].length + 2);
        return `<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`;
      }

      return `<p>${lines.map((line) => renderInlineMarkdown(line)).join("<br>")}</p>`;
    });

    return htmlBlocks.filter(Boolean).join("");
  }

  function setPanelMessageContent(item, text, options = {}) {
    if (!item) return;
    const body = item._messageBody || item;
    const mode = options.mode || item.dataset.renderMode || "text";
    const streaming = Boolean(options.streaming);
    const value = String(text || "");

    if (mode === "markdown" && !streaming) {
      body.innerHTML = renderMarkdownLite(value);
    } else {
      body.textContent = value;
    }
  }

  function createPanelMessage(container, role, text = "") {
    if (!container) return null;
    const item = document.createElement("article");
    item.className = `chat-msg ${role === "user" ? "from-user" : "from-bot"}`;
    item.dataset.renderMode = role === "bot" ? "markdown" : "text";
    const body = document.createElement("div");
    body.className = "chat-msg-body";
    item._messageBody = body;
    item.appendChild(body);
    setPanelMessageContent(item, text, { mode: item.dataset.renderMode });
    container.appendChild(item);
    scrollPanelMessages(container);
    return item;
  }

  function updatePanelMessage(container, item, text, streaming = false) {
    if (!item) return;
    setPanelMessageContent(item, text, { streaming });
    item.classList.toggle("is-streaming", Boolean(streaming));
    scrollPanelMessages(container);
  }

  function setQwen36Status(text, state = "idle") {
    if (!qwen36Status) return;
    qwen36Status.textContent = text;
    qwen36Status.dataset.state = state;
  }

  function createQwen36BotMessage() {
    if (!qwen36Messages) return null;

    const item = document.createElement("article");
    item.className = "chat-msg from-bot qwen36-message";

    const thinkingBlock = createNode("details", "qwen36-thinking-block");
    thinkingBlock.open = true;
    const thinkingSummary = createNode("summary", "", "thinking");
    const thinkingBody = createNode("pre", "qwen36-thinking-text");
    thinkingBlock.appendChild(thinkingSummary);
    thinkingBlock.appendChild(thinkingBody);
    thinkingBlock.hidden = true;

    const answerBody = createNode("div", "chat-msg-body qwen36-answer");
    answerBody.textContent = "正在生成...";

    item.appendChild(thinkingBlock);
    item.appendChild(answerBody);
    qwen36Messages.appendChild(item);
    scrollPanelMessages(qwen36Messages);

    return {
      item,
      thinkingBlock,
      thinkingBody,
      answerBody,
      reasoningText: "",
      answerText: ""
    };
  }

  function updateQwen36BotMessage(handle, options = {}) {
    if (!handle) return;
    const streaming = Boolean(options.streaming);

    if (handle.reasoningText) {
      handle.thinkingBlock.hidden = false;
      handle.thinkingBody.textContent = handle.reasoningText;
    }

    if (streaming) {
      handle.answerBody.textContent =
        handle.answerText || (handle.reasoningText ? "等待最终回答..." : "正在生成...");
    } else if (handle.answerText) {
      handle.answerBody.innerHTML = renderMarkdownLite(handle.answerText);
    } else if (handle.reasoningText) {
      handle.answerBody.textContent = "已生成 thinking，未返回最终回答。";
    } else {
      handle.answerBody.textContent = "模型没有返回内容。";
    }

    handle.item.classList.toggle("is-streaming", streaming);
    scrollPanelMessages(qwen36Messages);
  }

  function resetQwen36Conversation() {
    qwen36History.length = 0;
    qwen36SessionId = createSessionId("qwen36");
    if (qwen36Messages) {
      qwen36Messages.innerHTML = "";
      createPanelMessage(
        qwen36Messages,
        "bot",
        "Qwen3.6 27B 已连接 A100。打开 thinking 会单独显示思考输出，关闭 thinking 会直接返回答案。"
      );
    }
    setQwen36Status(qwen36Thinking?.checked ? "thinking" : "no thinking", "idle");
  }

  function createWorkflowStepNode(text, state = "done") {
    const item = createNode("li", `ops-workflow-step is-${state}`);
    item.appendChild(createNode("span", "ops-workflow-step-icon"));
    item.appendChild(createNode("span", "ops-workflow-step-text", text));
    return item;
  }

  function buildCloudOpsContextSummary(payload, limit = 4) {
    const details = buildCloudOpsResultDetails(payload)
      .slice(0, limit)
      .map((item) => `${item.label}：${item.value}`);

    if (details.length) {
      return details.join("；");
    }

    return String(payload?.summary || "").trim() || "已插入当前上下文。";
  }

  function createCloudOpsWorkflowMessage(container, label, vehicleId) {
    if (!container) return null;

    const item = document.createElement("article");
    item.className = "chat-msg from-bot chat-msg--workflow";

    const title = createNode("p", "ops-workflow-title", `正在执行【${label}】`);
    const meta = createNode(
      "p",
      "ops-workflow-meta",
      vehicleId ? `车辆：${vehicleId} · 等待车端返回结果` : "等待车端返回结果"
    );
    const steps = createNode("ol", "ops-workflow-steps");
    const media = createNode("div", "cloud-ops-result-media ops-workflow-media");
    media.hidden = true;

    item.appendChild(title);
    item.appendChild(meta);
    item.appendChild(steps);
    item.appendChild(media);
    container.appendChild(item);
    scrollPanelMessages(container);

    const handle = {
      item,
      title,
      meta,
      steps,
      media,
      label,
      vehicleId,
      stepNodes: new Map()
    };
    upsertCloudOpsWorkflowStep(handle, "__request__", `已发起【${label}】请求`, "done");
    upsertCloudOpsWorkflowStep(handle, "__waiting__", "等待车端返回结果...", "pending");
    return handle;
  }

  function upsertCloudOpsWorkflowStep(handle, key, text, state = "done") {
    if (!handle?.steps || !handle.stepNodes) {
      return null;
    }

    let item = handle.stepNodes.get(key);
    if (!item) {
      item = createWorkflowStepNode(text, state);
      handle.stepNodes.set(key, item);
      handle.steps.appendChild(item);
      return item;
    }

    item.className = `ops-workflow-step is-${state}`;
    const textNode = item.querySelector(".ops-workflow-step-text");
    if (textNode) {
      textNode.textContent = text;
    }
    return item;
  }

  function removeCloudOpsWorkflowStep(handle, key) {
    if (!handle?.stepNodes) {
      return;
    }

    const item = handle.stepNodes.get(key);
    if (item?.parentNode) {
      item.parentNode.removeChild(item);
    }
    handle.stepNodes.delete(key);
  }

  function applyCloudOpsWorkflowProgress(handle, progress) {
    if (!handle || !progress) {
      return;
    }

    handle.title.textContent = `正在执行【${handle.label}】`;
    handle.meta.textContent = progress.vehicle_id
      ? `车辆：${progress.vehicle_id} · 车端正在逐步返回`
      : "车端正在逐步返回";
    removeCloudOpsWorkflowStep(handle, "__waiting__");

    const key = Number.isFinite(progress.step_index)
      ? `step-${progress.step_index}`
      : `step-${progress.step_name || progress.title || progress.message || createNonce()}`;
    const title = progress.title || progress.step_name || `步骤 ${progress.step_index ?? "-"}`;
    const text = progress.message ? `${title}：${progress.message}` : title;
    const stateMap = {
      running: "pending",
      ok: "done",
      warn: "warn",
      error: "error"
    };
    const state = stateMap[progress.status] || "pending";

    upsertCloudOpsWorkflowStep(handle, key, text, state);
    scrollPanelMessages(openClawMessages);
  }

  function updateCloudOpsWorkflowMessage(handle, options = {}) {
    if (!handle?.item || !handle?.steps) {
      return;
    }

    const label = options.label || "运维动作";
    const status = options.status || "ok";
    const vehicleId = options.vehicleId || "";

    handle.steps.innerHTML = "";

    if (status === "loading") {
      handle.title.textContent = `正在执行【${label}】`;
      handle.meta.textContent = vehicleId ? `车辆：${vehicleId} · 等待车端返回结果` : "等待车端返回结果";
      handle.steps.innerHTML = "";
      if (handle.media) {
        handle.media.innerHTML = "";
        handle.media.hidden = true;
      }
      handle.stepNodes?.clear?.();
      upsertCloudOpsWorkflowStep(handle, "__request__", `已发起【${label}】请求`, "done");
      upsertCloudOpsWorkflowStep(handle, "__waiting__", "等待车端返回结果...", "pending");
      scrollPanelMessages(openClawMessages);
      return;
    }

    if (status === "error") {
      handle.title.textContent = `【${label}】执行失败`;
      handle.meta.textContent = vehicleId ? `车辆：${vehicleId}` : "执行失败";
      handle.steps.innerHTML = "";
      if (handle.media) {
        handle.media.innerHTML = "";
        handle.media.hidden = true;
      }
      handle.stepNodes?.clear?.();
      upsertCloudOpsWorkflowStep(handle, "__request__", `已发起【${label}】请求`, "done");
      upsertCloudOpsWorkflowStep(handle, "__error__", options.errorText || "执行失败，请稍后重试。", "error");
      scrollPanelMessages(openClawMessages);
      return;
    }

    const detailItems = buildCloudOpsResultDetails(options.payload).slice(0, 6);
    handle.title.textContent = `已插入运维上下文【${label}】`;
    handle.meta.textContent = vehicleId
      ? `车辆：${vehicleId} · 可继续结合这些结果自然语言追问`
      : "已写入当前运维会话上下文";
    handle.steps.innerHTML = "";
    if (handle.media) {
      handle.media.innerHTML = "";
      handle.media.hidden = true;
    }
    handle.stepNodes?.clear?.();
    upsertCloudOpsWorkflowStep(handle, "__request__", `已完成【${label}】调用`, "done");
    upsertCloudOpsWorkflowStep(handle, "__stored__", "结果已写入当前会话上下文", "done");

    if (detailItems.length) {
      detailItems.forEach((detail, index) => {
        const tone =
          detail.tone === "error" ? "error" : detail.tone === "warn" ? "warn" : "done";
        upsertCloudOpsWorkflowStep(handle, `detail-${index}`, `${detail.label}：${detail.value}`, tone);
      });
    } else if (options.summaryText) {
      upsertCloudOpsWorkflowStep(handle, "__summary__", options.summaryText, "done");
    }

    renderCloudOpsMediaContainer(handle.media, options.payload);

    scrollPanelMessages(openClawMessages);
  }

  function normalizeCloudOpsProgressEvent(eventData) {
    if (!eventData || typeof eventData !== "object") {
      return null;
    }

    let source = null;
    if (eventData.event === "tool.progress") {
      source = eventData;
    } else if (eventData.event === "vehicle.message" && eventData.message_type === "tool.progress") {
      source = eventData.payload || eventData;
    }

    if (!source) {
      return null;
    }

    const requestId = source.request_id || source.id || source?.payload?.id || null;
    if (!requestId) {
      return null;
    }

    return {
      request_id: String(requestId),
      vehicle_id: source.vehicle_id || source?.payload?.vehicle_id || "",
      tool: source.tool || source?.payload?.tool || "",
      status: String(source.status || source?.payload?.status || "running").toLowerCase(),
      step_index: Number.isFinite(Number(source.step_index)) ? Number(source.step_index) : null,
      step_name: source.step_name || source?.payload?.step_name || "",
      title: source.title || source?.payload?.title || "",
      message: source.message || source?.payload?.message || "",
      data: source.data || source?.payload?.data || null
    };
  }

  function getCloudOpsAudioEventEnvelope(eventData) {
    if (!eventData || typeof eventData !== "object") {
      return null;
    }

    if (
      eventData.event === "vehicle.message" &&
      (eventData.message_type === "audio.stream.state" || eventData.message_type === "audio.chunk")
    ) {
      return {
        type: eventData.message_type,
        vehicle_id: eventData.vehicle_id || "",
        payload:
          eventData.payload && typeof eventData.payload === "object" ? eventData.payload : eventData
      };
    }

    const type = String(eventData.type || "").trim();
    if (type === "audio.stream.state" || type === "audio.chunk") {
      return {
        type,
        vehicle_id: eventData.vehicle_id || "",
        payload: eventData
      };
    }

    return null;
  }

  function normalizeCloudOpsAudioStateEvent(eventData) {
    const envelope = getCloudOpsAudioEventEnvelope(eventData);
    if (!envelope || envelope.type !== "audio.stream.state") {
      return null;
    }

    const payload = envelope.payload || {};
    const streamId = String(
      getCloudOpsValue(payload, [["stream_id"], ["data", "stream_id"], ["result", "stream_id"]], "")
    ).trim();
    const tool = String(
      getCloudOpsValue(
        payload,
        [["tool"], ["tool_name"], ["data", "tool"], ["data", "tool_name"], ["result", "tool"]],
        ""
      )
    ).trim();
    const state = String(
      getCloudOpsValue(payload, [["state"], ["status"], ["data", "state"], ["data", "status"]], "")
    )
      .trim()
      .toLowerCase();
    const enabled = getCloudOpsValue(
      payload,
      [["enabled"], ["enable"], ["data", "enabled"], ["data", "enable"]],
      null
    );
    const message = String(
      getCloudOpsValue(
        payload,
        [["message"], ["detail"], ["reason"], ["data", "message"], ["data", "detail"]],
        ""
      )
    ).trim();

    return {
      vehicle_id: envelope.vehicle_id || payload.vehicle_id || "",
      tool,
      stream_id: streamId,
      state,
      enabled: typeof enabled === "boolean" ? enabled : null,
      message,
      payload
    };
  }

  function normalizeCloudOpsAudioChunkEvent(eventData) {
    const envelope = getCloudOpsAudioEventEnvelope(eventData);
    if (!envelope || envelope.type !== "audio.chunk") {
      return null;
    }

    const payload = envelope.payload || {};
    const streamId = String(
      getCloudOpsValue(payload, [["stream_id"], ["data", "stream_id"], ["result", "stream_id"]], "")
    ).trim();
    const seqValue = Number(
      getCloudOpsValue(payload, [["seq"], ["data", "seq"], ["index"], ["data", "index"]], Number.NaN)
    );
    const dataBase64 = String(
      getCloudOpsValue(payload, [["data_base64"], ["data", "data_base64"], ["chunk", "data_base64"]], "")
    )
      .trim()
      .replace(/\s+/g, "");
    const tool = String(
      getCloudOpsValue(payload, [["tool"], ["tool_name"], ["data", "tool"], ["data", "tool_name"]], "")
    ).trim();

    return {
      vehicle_id: envelope.vehicle_id || payload.vehicle_id || "",
      tool,
      stream_id: streamId,
      seq: Number.isFinite(seqValue) ? seqValue : null,
      data_base64: dataBase64,
      payload
    };
  }

  function isCloudOpsAudioStateStarted(stateEvent) {
    if (!stateEvent) {
      return false;
    }
    if (stateEvent.enabled === true) {
      return true;
    }
    return ["started", "running", "active", "enabled", "streaming", "open"].includes(
      stateEvent.state
    );
  }

  function isCloudOpsAudioStateStopped(stateEvent) {
    if (!stateEvent) {
      return false;
    }
    if (stateEvent.enabled === false) {
      return true;
    }
    return ["stopped", "disabled", "closed", "ended", "finished", "completed", "error"].includes(
      stateEvent.state
    );
  }

  async function ensureCloudOpsAudioContext() {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
      throw new Error("当前浏览器不支持 Web Audio API");
    }

    if (!cloudOpsAudioContext) {
      cloudOpsAudioContext = new AudioContextCtor();
    }

    if (cloudOpsAudioContext.state === "suspended") {
      await cloudOpsAudioContext.resume();
    }

    return cloudOpsAudioContext;
  }

  function decodeCloudOpsPcmChunk(dataBase64) {
    if (!cloudOpsAudioContext) {
      throw new Error("audio_context_not_ready");
    }

    const payload = String(dataBase64 || "").replace(/\s+/g, "");
    const binary = window.atob(payload);
    const sampleCount = Math.floor(binary.length / 2);
    if (!sampleCount) {
      throw new Error("audio_chunk_empty");
    }

    const buffer = cloudOpsAudioContext.createBuffer(1, sampleCount, CLOUD_OPS_AUDIO_SAMPLE_RATE);
    const channelData = buffer.getChannelData(0);
    for (let index = 0, byteOffset = 0; index < sampleCount; index += 1, byteOffset += 2) {
      let sample = binary.charCodeAt(byteOffset) | (binary.charCodeAt(byteOffset + 1) << 8);
      if (sample >= 0x8000) {
        sample -= 0x10000;
      }
      channelData[index] = sample / 32768;
    }
    return buffer;
  }

  function scheduleCloudOpsAudioBuffer(stream, audioBuffer) {
    if (!stream || !audioBuffer || !cloudOpsAudioContext) {
      return;
    }

    const source = cloudOpsAudioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(cloudOpsAudioContext.destination);
    const startAt = Math.max(cloudOpsAudioContext.currentTime + 0.02, stream.nextPlayTime || 0);
    source.start(startAt);
    stream.nextPlayTime = startAt + audioBuffer.duration;
    stream.sourceNodes.add(source);
    source.onended = () => {
      stream.sourceNodes.delete(source);
      try {
        source.disconnect();
      } catch (_error) {
        // Ignore disconnect failures after playback.
      }
    };
  }

  function flushCloudOpsAudioStream(stream) {
    if (!stream || !stream.pendingChunks) {
      return;
    }

    if (stream.expectedSeq == null && stream.pendingChunks.size) {
      stream.expectedSeq = Math.min(...stream.pendingChunks.keys());
    }

    while (stream.expectedSeq != null && stream.pendingChunks.has(stream.expectedSeq)) {
      const item = stream.pendingChunks.get(stream.expectedSeq);
      stream.pendingChunks.delete(stream.expectedSeq);
      if (item?.buffer) {
        scheduleCloudOpsAudioBuffer(stream, item.buffer);
      }
      stream.expectedSeq += 1;
    }
  }

  function queueCloudOpsAudioChunk(stream, chunkEvent) {
    if (!stream || !chunkEvent?.data_base64) {
      return;
    }

    let seq = chunkEvent.seq;
    if (!Number.isFinite(seq)) {
      seq = stream.nextFallbackSeq;
      stream.nextFallbackSeq += 1;
    }

    if (stream.expectedSeq == null) {
      stream.expectedSeq = seq;
    }
    if (seq < stream.expectedSeq || stream.pendingChunks.has(seq)) {
      return;
    }

    const buffer = decodeCloudOpsPcmChunk(chunkEvent.data_base64);
    stream.pendingChunks.set(seq, { seq, buffer });
    stream.chunkCount += 1;
    stream.lastChunkAtMs = Date.now();
    flushCloudOpsAudioStream(stream);
  }

  function createCloudOpsAudioStream(channel, streamId, vehicleId) {
    return {
      streamId,
      toolName: channel.toolName,
      vehicleId,
      pendingChunks: new Map(),
      expectedSeq: null,
      nextFallbackSeq: 0,
      nextPlayTime: 0,
      sourceNodes: new Set(),
      chunkCount: 0,
      lastChunkAtMs: 0
    };
  }

  function handleCloudOpsAudioStateEvent(eventData) {
    const stateEvent = normalizeCloudOpsAudioStateEvent(eventData);
    if (!stateEvent) {
      return false;
    }

    let stream = getCloudOpsAudioStream(stateEvent.stream_id);
    let channel = stream ? getCloudOpsAudioChannel(stream.toolName) : getCloudOpsAudioChannel(stateEvent.tool);
    if (!channel) {
      return false;
    }
    if (!stream) {
      stream = getCloudOpsAudioChannelStream(channel);
    }
    if (!stream) {
      return false;
    }
    if (stateEvent.stream_id && stateEvent.stream_id !== stream.streamId) {
      return false;
    }

    if (isCloudOpsAudioStateStarted(stateEvent)) {
      channel.phase = "active";
      updateCloudOpsAudioAvailability();
      if (stateEvent.message) {
        setCloudOpsAudioStatus(stateEvent.message, "ok");
      }
      return true;
    }

    if (isCloudOpsAudioStateStopped(stateEvent)) {
      const tone = stateEvent.state === "error" ? "error" : "idle";
      releaseCloudOpsAudioChannel(channel, { stopPlayback: true, phase: "idle" });
      updateCloudOpsAudioAvailability();
      setCloudOpsAudioStatus(
        stateEvent.message || `${channel.label}${tone === "error" ? "异常结束" : "已结束"}`,
        tone
      );
      return true;
    }

    if (stateEvent.message) {
      setCloudOpsAudioStatus(stateEvent.message, channel.phase === "idle" ? "idle" : "ok");
    }
    return true;
  }

  function handleCloudOpsAudioChunkEvent(eventData) {
    const chunkEvent = normalizeCloudOpsAudioChunkEvent(eventData);
    if (!chunkEvent?.stream_id || !chunkEvent.data_base64) {
      return false;
    }

    const stream = getCloudOpsAudioStream(chunkEvent.stream_id);
    if (!stream) {
      return false;
    }

    const channel = getCloudOpsAudioChannel(stream.toolName);
    if (!channel) {
      return false;
    }

    if (cloudOpsAudioContext?.state === "suspended") {
      cloudOpsAudioContext.resume().catch(() => {});
    }

    try {
      queueCloudOpsAudioChunk(stream, chunkEvent);
      if (channel.phase !== "active") {
        channel.phase = "active";
        updateCloudOpsAudioAvailability();
      }
      setCloudOpsAudioStatus(`${channel.label}播放中`, "ok");
      setCloudOpsStatus("实时音频中", "ok");
    } catch (error) {
      releaseCloudOpsAudioChannel(channel, { stopPlayback: true, phase: "idle" });
      updateCloudOpsAudioAvailability();
      setCloudOpsAudioStatus(error?.message || `${channel.label}播放失败`, "error");
    }

    return true;
  }

  function scheduleCloudOpsContextRefresh(delayMs = 1200) {
    if (cloudOpsContextReloadTimer) {
      window.clearTimeout(cloudOpsContextReloadTimer);
    }
    cloudOpsContextReloadTimer = window.setTimeout(() => {
      cloudOpsContextReloadTimer = 0;
      loadCloudOpsContext({ preserveResult: true, silent: true }).catch(() => {});
    }, delayMs);
  }

  function applyCloudOpsOpsInit(eventData) {
    const vehicles = Array.isArray(eventData?.vehicles) ? eventData.vehicles : null;
    if (!vehicles) {
      return false;
    }
    cloudOpsVehicles = vehicles;
    renderCloudOpsVehicleOptions();
    renderCloudOpsSummary();
    renderCloudOpsLiveState();
    updateCloudOpsActionAvailability();
    return true;
  }

  function applyCloudOpsTelemetryEvent(eventData) {
    let source = null;
    if (eventData?.event === "vehicle.telemetry") {
      source = eventData;
    } else if (eventData?.event === "vehicle.message" && eventData?.message_type === "telemetry") {
      source = eventData;
    } else if (eventData?.type === "telemetry") {
      source = eventData;
    }

    if (!source) {
      return false;
    }

    const payload = source.telemetry || source.payload || source;
    const telemetry = getCloudOpsTelemetrySource(payload);
    const vehicleId = String(
      source.vehicle_id || telemetry.vehicle_id || telemetry.plate_number || payload?.vehicle_id || ""
    ).trim();
    if (!vehicleId) {
      return false;
    }

    upsertCloudOpsVehicleState(vehicleId, {
      telemetry,
      last_seen: source.ts || payload?.ts || telemetry.generated_at || new Date().toISOString()
    });
    renderCloudOpsVehicleOptions();
    renderCloudOpsSummary();
    renderCloudOpsLiveState();
    updateCloudOpsActionAvailability();
    return true;
  }

  function handleCloudOpsOpsEvent(eventData) {
    if (applyCloudOpsOpsInit(eventData)) {
      return;
    }

    if (applyCloudOpsTelemetryEvent(eventData)) {
      return;
    }

    const progress = normalizeCloudOpsProgressEvent(eventData);
    if (progress) {
      const handle = cloudOpsWorkflowByRequestId.get(progress.request_id);
      if (!handle) {
        return;
      }

      applyCloudOpsWorkflowProgress(handle, progress);
      setOpenClawStatus("车端实时返回中", "loading");
      return;
    }

    if (handleCloudOpsAudioStateEvent(eventData)) {
      return;
    }

    if (handleCloudOpsAudioChunkEvent(eventData)) {
      return;
    }

    if (
      eventData?.event === "connection.opened" ||
      eventData?.event === "connection.closed" ||
      (eventData?.event === "vehicle.message" &&
        ["hello", "heartbeat", "snapshot", "tool.list.result"].includes(eventData?.message_type))
    ) {
      scheduleCloudOpsContextRefresh();
    }
  }

  function connectCloudOpsOpsSocket() {
    if (!cloudOpsConsole || cloudOpsOpsSocket) {
      return;
    }

    const socket = new WebSocket(getCloudOpsWsUrl());
    cloudOpsOpsSocket = socket;

    socket.addEventListener("open", () => {
      if (cloudOpsAlertsStatus) {
        cloudOpsAlertsStatus.textContent = "实时通道已连接";
        cloudOpsAlertsStatus.dataset.state = "ok";
      }
    });

    socket.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(String(event.data || ""));
        handleCloudOpsOpsEvent(data);
      } catch (_error) {
        // Ignore malformed socket payloads.
      }
    });

    socket.addEventListener("close", () => {
      cloudOpsOpsSocket = null;
      if (cloudOpsAlertsStatus) {
        cloudOpsAlertsStatus.textContent = "实时通道重连中";
        cloudOpsAlertsStatus.dataset.state = "loading";
      }
      if (cloudOpsOpsReconnectTimer) {
        window.clearTimeout(cloudOpsOpsReconnectTimer);
      }
      cloudOpsOpsReconnectTimer = window.setTimeout(() => {
        cloudOpsOpsReconnectTimer = 0;
        connectCloudOpsOpsSocket();
      }, 3000);
    });

    socket.addEventListener("error", () => {
      if (cloudOpsAlertsStatus) {
        cloudOpsAlertsStatus.textContent = "实时通道异常";
        cloudOpsAlertsStatus.dataset.state = "error";
      }
      try {
        socket.close();
      } catch (_error) {
        // Ignore close failures.
      }
    });
  }

  function setChatStatus(text, state) {
    if (!chatStatus) return;
    chatStatus.textContent = text;
    chatStatus.dataset.state = state || "idle";
  }

  function setOpenClawStatus(text, state) {
    if (!openClawStatus) return;
    openClawStatus.textContent = text;
    openClawStatus.dataset.state = state || "idle";
  }

  function setOpenClawAuthHint(text, state) {
    if (!openClawAuthHint) return;
    openClawAuthHint.textContent = text;
    openClawAuthHint.dataset.state = state || "idle";
  }

  function setAiCheckStatus(text, state) {
    if (!aiCheckStatus) return;
    aiCheckStatus.textContent = text;
    aiCheckStatus.dataset.state = state || "idle";
  }

  function setAiHistoryStatus(text, state) {
    if (!aiHistoryStatus) return;
    aiHistoryStatus.textContent = text;
    aiHistoryStatus.dataset.state = state || "idle";
  }

  function setCloudOpsStatus(text, state) {
    if (cloudOpsStatus) {
      cloudOpsStatus.textContent = text;
      cloudOpsStatus.dataset.state = state || "idle";
    }
    if (cloudOpsInlineStatus) {
      cloudOpsInlineStatus.textContent = text;
      cloudOpsInlineStatus.dataset.state = state || "idle";
    }
  }

  function setCloudOpsAuthHint(text, state) {
    if (!cloudOpsAuthHint) return;
    cloudOpsAuthHint.textContent = text;
    cloudOpsAuthHint.dataset.state = state || "idle";
  }

  function setCloudOpsAudioStatus(text, state) {
    if (!cloudOpsAudioStatus) return;
    cloudOpsAudioStatus.textContent = text;
    cloudOpsAudioStatus.dataset.state = state || "idle";
  }

  function getWelcomeText() {
    return `你好，我是智能AI对话助手。当前身份：${vehicleId}。你可以直接输入问题开始对话。`;
  }

  function getOpenClawWelcomeText() {
    const vehicleText = cloudOpsCurrentVehicleId ? `当前车辆：${cloudOpsCurrentVehicleId}。` : "";
    const permissionText = openClawAuthenticated
      ? "你可以直接自然语言运维，也可以先点上面的快捷按钮，把关键节点、一键健康检查、AI检测配置、AI检测图片、相机抓拍、地图查看、车身状态、灯光控制、碰撞停复位、routing 等结果插入当前会话上下文后继续追问。"
      : "当前为只读模式。你可以先点上面的按钮查看车辆状态；登录后可聊天并获得更多控制权限。";
    return `你好，我是 OpenClaw 助手。当前走默认模型：${openClawModelLabel}。${vehicleText}${permissionText}`;
  }

  function isCloudOpsControlButton(button) {
    return String(button?.dataset?.access || "").trim() === "control";
  }

  function updateOpenClawInputAvailability() {
    if (openClawInput) {
      openClawInput.disabled = !openClawAuthenticated;
      openClawInput.placeholder = openClawAuthenticated
        ? OPENCLAW_CHAT_PLACEHOLDER
        : OPENCLAW_LOCKED_PLACEHOLDER;
    }
    if (openClawSend) {
      openClawSend.disabled = !openClawAuthenticated;
    }
  }

  function normalizeCloudOpsAudioStreamSegment(value, fallback = "stream") {
    const normalized = String(value || "")
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24);
    return normalized || fallback;
  }

  function createCloudOpsAudioStreamId(toolName) {
    const toolSegment =
      toolName === "audio.uplink.speaker" ? "speaker" : toolName === "audio.uplink.mic" ? "mic" : "audio";
    const vehicleSegment = normalizeCloudOpsAudioStreamSegment(cloudOpsCurrentVehicleId, "vehicle");
    return `web-${toolSegment}-${vehicleSegment}-${createNonce()}`;
  }

  function getCloudOpsAudioChannel(toolName) {
    return cloudOpsAudioChannels.get(String(toolName || "").trim()) || null;
  }

  function getCloudOpsAudioChannelByButton(button) {
    if (!(button instanceof HTMLButtonElement)) {
      return null;
    }
    return getCloudOpsAudioChannel(button.dataset.audioTool || "");
  }

  function getCloudOpsAudioStream(streamId) {
    const id = String(streamId || "").trim();
    return id ? cloudOpsAudioStreams.get(id) || null : null;
  }

  function getCloudOpsAudioChannelStream(channel) {
    return getCloudOpsAudioStream(channel?.streamId);
  }

  function releaseCloudOpsAudioStream(stream, options = {}) {
    if (!stream) {
      return;
    }

    stream.pendingChunks?.clear?.();
    if (options.stopPlayback !== false) {
      for (const source of Array.from(stream.sourceNodes || [])) {
        try {
          source.stop(0);
        } catch (_error) {
          // Ignore sources that already ended.
        }
        try {
          source.disconnect();
        } catch (_error) {
          // Ignore disconnect failures.
        }
      }
    }
    stream.sourceNodes?.clear?.();
    cloudOpsAudioStreams.delete(stream.streamId);
  }

  function releaseCloudOpsAudioChannel(channel, options = {}) {
    if (!channel) {
      return;
    }

    const stream = getCloudOpsAudioChannelStream(channel);
    if (stream) {
      releaseCloudOpsAudioStream(stream, { stopPlayback: options.stopPlayback !== false });
    }
    channel.streamId = "";
    channel.vehicleId = "";
    channel.phase = options.phase || "idle";
    channel.errorText = options.errorText || "";
  }

  function resetAllCloudOpsAudioChannels(options = {}) {
    cloudOpsAudioChannels.forEach((channel) => {
      releaseCloudOpsAudioChannel(channel, {
        stopPlayback: options.stopPlayback !== false,
        phase: "idle"
      });
      channel.busy = false;
    });
  }

  function describeCloudOpsAudioChannel(channel) {
    if (!channel) {
      return "";
    }
    if (channel.phase === "starting") {
      return "正在请求车端开启音频上行";
    }
    if (channel.phase === "active") {
      return channel.toolName === "audio.uplink.speaker"
        ? "浏览器正在播放喇叭混音"
        : "浏览器正在播放麦克风上行";
    }
    if (channel.phase === "stopping") {
      return "正在停止音频上行";
    }
    if (channel.phase === "error" && channel.errorText) {
      return channel.errorText;
    }
    return channel.idleHint;
  }

  function updateCloudOpsAudioAvailability() {
    const vehicleSelected = Boolean(cloudOpsCurrentVehicleId);
    const hasToolCatalog = cloudOpsAvailableTools.size > 0;
    const activeLabels = [];
    let pending = false;

    cloudOpsAudioChannels.forEach((channel) => {
      const button = channel.button;
      if (!button) {
        return;
      }

      const allowStop = channel.phase === "starting" || channel.phase === "active";
      const supported =
        allowStop ||
        channel.phase === "stopping" ||
        !hasToolCatalog ||
        cloudOpsAvailableTools.has(channel.toolName);
      const titleNode = button.querySelector("strong");
      const detailNode = button.querySelector("span");
      button.dataset.supported = supported ? "yes" : "no";
      button.dataset.state = channel.phase;
      button.disabled =
        channel.busy ||
        cloudOpsBusy ||
        !cloudOpsAuthenticated ||
        !vehicleSelected ||
        (!supported && !allowStop);

      if (titleNode) {
        titleNode.textContent = allowStop || channel.phase === "stopping" ? `停止${channel.label}` : channel.label;
      }
      if (detailNode) {
        detailNode.textContent = describeCloudOpsAudioChannel(channel);
      }

      if (channel.phase === "active") {
        activeLabels.push(channel.label);
      }
      if (channel.phase === "starting" || channel.phase === "stopping") {
        pending = true;
      }
    });

    if (!cloudOpsAudioStatus) {
      return;
    }
    if (!cloudOpsAuthenticated) {
      setCloudOpsAudioStatus("登录后可听", "idle");
    } else if (!vehicleSelected) {
      setCloudOpsAudioStatus("请选择车辆", "idle");
    } else if (pending) {
      setCloudOpsAudioStatus("音频切换中", "loading");
    } else if (activeLabels.length) {
      setCloudOpsAudioStatus(`${activeLabels.join(" / ")}播放中`, "ok");
    } else {
      setCloudOpsAudioStatus("待启动", "idle");
    }
  }

  function createCloudOpsMetaItem(label, value) {
    const item = createNode("article", "cloud-ops-meta-item");
    item.appendChild(createNode("p", "cloud-ops-meta-label", label));
    item.appendChild(createNode("p", "cloud-ops-meta-value", value ?? "-"));
    return item;
  }

  function normalizeCloudOpsTelemetryStateMap(source) {
    if (!source || typeof source !== "object") {
      return {};
    }

    return Object.fromEntries(
      Object.entries(source)
        .map(([key, value]) => {
          if (typeof value === "boolean") {
            return [key, value];
          }
          if (value && typeof value === "object") {
            if (typeof value.ok === "boolean") {
              return [key, value.ok];
            }
            if (typeof value.online === "boolean") {
              return [key, value.online];
            }
            if (typeof value.has_publisher === "boolean") {
              return [key, value.has_publisher];
            }
            if (Number.isFinite(Number(value.publisher_count))) {
              return [key, Number(value.publisher_count) > 0];
            }
          }
          return [key, null];
        })
        .filter(([key]) => Boolean(String(key || "").trim()))
    );
  }

  function formatCloudOpsTelemetryKeyLabel(key) {
    const labels = {
      vehicleStatus: "vehicleStatus",
      planning: "planning",
      location: "location",
      fusion: "fusion",
      routing: "routing",
      control: "control",
      battery: "battery",
      ndt_localizer: "ndt_localizer",
      controlling: "controlling",
      obstacle: "obstacle",
      can_driver: "can_driver"
    };
    return labels[key] || key || "-";
  }

  function getCloudOpsTelemetrySource(rawTelemetry) {
    if (!rawTelemetry || typeof rawTelemetry !== "object") {
      return {};
    }
    if (rawTelemetry.data && typeof rawTelemetry.data === "object") {
      return rawTelemetry.data;
    }
    return rawTelemetry;
  }

  function toCloudOpsOptionalNumber(value) {
    if (value === null || value === undefined || value === "" || typeof value === "boolean") {
      return null;
    }
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }

  function normalizeCloudOpsTelemetry(rawTelemetry) {
    const source = getCloudOpsTelemetrySource(rawTelemetry);
    const media = source.media && typeof source.media === "object" ? source.media : {};
    const master = source.master && typeof source.master === "object" ? source.master : {};
    const vehicle = source.vehicle && typeof source.vehicle === "object" ? source.vehicle : {};
    const keyTopics = normalizeCloudOpsTelemetryStateMap(source.key_topics);
    const keyNodes = normalizeCloudOpsTelemetryStateMap(source.key_nodes);
    const timestamp =
      source.generated_at ||
      source.ts ||
      rawTelemetry?.generated_at ||
      rawTelemetry?.ts ||
      "";

    return {
      vehicle_id:
        source.vehicle_id ||
        source.plate_number ||
        vehicle.vehicle_id ||
        rawTelemetry?.vehicle_id ||
        rawTelemetry?.plate_number ||
        "",
      timestamp: String(timestamp || "").trim(),
      mediaCpuPercent: toCloudOpsOptionalNumber(media.cpu_percent),
      mediaMemoryPercent: toCloudOpsOptionalNumber(media.memory_percent),
      mediaDiskPercent: toCloudOpsOptionalNumber(media.disk_percent),
      mediaLoadAvg1m: toCloudOpsOptionalNumber(media.load_avg_1m),
      masterHost: String(master.host || "").trim(),
      masterCpuPercent: toCloudOpsOptionalNumber(master.cpu_percent),
      masterReachable:
        typeof master.reachable === "boolean" ? master.reachable : null,
      masterRosOk: typeof master.ros_ok === "boolean" ? master.ros_ok : null,
      masterNodeCount: toCloudOpsOptionalNumber(master.node_count),
      masterTopicCount: toCloudOpsOptionalNumber(master.topic_count),
      keyTopics,
      keyNodes,
      vehicleSpeed: toCloudOpsOptionalNumber(vehicle.speed_kph) ?? toCloudOpsOptionalNumber(vehicle.speed),
      emergencyStop:
        typeof vehicle.emergency_stop_pressed === "boolean"
          ? vehicle.emergency_stop_pressed
          : typeof vehicle.emergency_stop === "boolean"
            ? vehicle.emergency_stop
            : null,
      collisionStop:
        typeof vehicle.collision_stop === "boolean" ? vehicle.collision_stop : null,
      batterySoc: toCloudOpsOptionalNumber(vehicle.battery_soc),
      batteryVoltage: toCloudOpsOptionalNumber(vehicle.battery_voltage),
      batteryCurrent: toCloudOpsOptionalNumber(vehicle.battery_current),
      ready: typeof vehicle.ready === "boolean" ? vehicle.ready : null,
      runningMode: toCloudOpsOptionalNumber(vehicle.running_mode),
      gear: toCloudOpsOptionalNumber(vehicle.gear),
      ultrasonicStop:
        typeof vehicle.ultrasonic_stop === "boolean" ? vehicle.ultrasonic_stop : null,
      dataAgeS: toCloudOpsOptionalNumber(vehicle.data_age_s)
    };
  }

  function formatCloudOpsRelativeSeconds(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) {
      return "-";
    }
    if (seconds < 1) {
      return `${seconds.toFixed(1)}s`;
    }
    if (seconds < 10) {
      return `${seconds.toFixed(1)}s`;
    }
    return `${Math.round(seconds)}s`;
  }

  function countCloudOpsTelemetryStates(map) {
    const entries = Object.entries(map || {});
    const total = entries.length;
    const okCount = entries.filter(([, value]) => value === true).length;
    const badKeys = entries
      .filter(([, value]) => value === false)
      .map(([key]) => formatCloudOpsTelemetryKeyLabel(key));
    return { total, okCount, badKeys };
  }

  function upsertCloudOpsVehicleState(vehicleId, patch = {}) {
    const normalizedVehicleId = String(vehicleId || patch.vehicle_id || "").trim();
    if (!normalizedVehicleId) {
      return null;
    }

    const index = cloudOpsVehicles.findIndex(
      (vehicle) => String(vehicle?.vehicle_id || vehicle?.plate_number || "").trim() === normalizedVehicleId
    );
    const nextVehicle = {
      ...(index >= 0 ? cloudOpsVehicles[index] : {}),
      ...patch,
      vehicle_id: normalizedVehicleId
    };

    if (index >= 0) {
      cloudOpsVehicles.splice(index, 1, nextVehicle);
    } else {
      cloudOpsVehicles.push(nextVehicle);
      cloudOpsVehicles.sort((left, right) =>
        String(left?.vehicle_id || "").localeCompare(String(right?.vehicle_id || ""))
      );
    }

    if (
      cloudOpsCurrentDetail?.vehicle &&
      String(cloudOpsCurrentDetail.vehicle?.vehicle_id || "").trim() === normalizedVehicleId
    ) {
      cloudOpsCurrentDetail = {
        ...cloudOpsCurrentDetail,
        vehicle: {
          ...cloudOpsCurrentDetail.vehicle,
          ...patch,
          vehicle_id: normalizedVehicleId
        }
      };
    }

    return nextVehicle;
  }

  function buildCloudOpsVehicleAlert(vehicle) {
    const vehicleId = String(vehicle?.vehicle_id || vehicle?.plate_number || "").trim();
    const telemetry = normalizeCloudOpsTelemetry(vehicle?.telemetry);
    if (!vehicleId || !telemetry.timestamp) {
      return null;
    }

    const issues = [];
    const keyTopicSummary = countCloudOpsTelemetryStates(telemetry.keyTopics);
    const keyNodeSummary = countCloudOpsTelemetryStates(telemetry.keyNodes);
    const telemetryAgeS = telemetry.dataAgeS;

    if (telemetry.masterReachable === false) {
      issues.push({ tone: "error", text: "主控未连通" });
    }
    if (telemetry.masterRosOk === false) {
      issues.push({ tone: "error", text: "主控 ROS 异常" });
    }
    if (telemetry.emergencyStop === true) {
      issues.push({ tone: "error", text: "急停已触发" });
    }
    if (telemetry.collisionStop === true) {
      issues.push({ tone: "error", text: "碰撞停已触发" });
    }
    if (telemetry.ultrasonicStop === true) {
      issues.push({ tone: "warn", text: "超声停已触发" });
    }
    if (telemetry.ready === false) {
      issues.push({ tone: "warn", text: "车辆未处于 ready" });
    }
    if (Number.isFinite(telemetry.batterySoc)) {
      if (telemetry.batterySoc <= CLOUD_OPS_BATTERY_ERROR_PERCENT) {
        issues.push({ tone: "error", text: `电量低 ${formatCloudOpsNumber(telemetry.batterySoc)}%` });
      } else if (telemetry.batterySoc <= CLOUD_OPS_BATTERY_WARN_PERCENT) {
        issues.push({ tone: "warn", text: `电量偏低 ${formatCloudOpsNumber(telemetry.batterySoc)}%` });
      }
    }
    if (Number.isFinite(telemetry.mediaCpuPercent) && telemetry.mediaCpuPercent >= 90) {
      issues.push({ tone: "warn", text: `Media CPU 高 ${formatCloudOpsNumber(telemetry.mediaCpuPercent)}%` });
    }
    if (Number.isFinite(telemetry.mediaMemoryPercent) && telemetry.mediaMemoryPercent >= 90) {
      issues.push({
        tone: "warn",
        text: `Media 内存高 ${formatCloudOpsNumber(telemetry.mediaMemoryPercent)}%`
      });
    }
    if (Number.isFinite(telemetry.mediaDiskPercent) && telemetry.mediaDiskPercent >= 90) {
      issues.push({ tone: "warn", text: `Media 磁盘高 ${formatCloudOpsNumber(telemetry.mediaDiskPercent)}%` });
    }
    if (keyTopicSummary.badKeys.length) {
      issues.push({
        tone: "warn",
        text: `关键话题异常：${keyTopicSummary.badKeys.slice(0, 4).join("、")}`
      });
    }
    if (keyNodeSummary.badKeys.length) {
      issues.push({
        tone: "warn",
        text: `关键节点异常：${keyNodeSummary.badKeys.slice(0, 4).join("、")}`
      });
    }
    if (Number.isFinite(telemetryAgeS) && telemetryAgeS > CLOUD_OPS_TELEMETRY_STALE_S) {
      issues.push({ tone: "warn", text: `状态缓存偏旧 ${formatCloudOpsRelativeSeconds(telemetryAgeS)}` });
    }

    if (!issues.length) {
      return null;
    }

    return {
      vehicleId,
      timestamp: telemetry.timestamp,
      issues,
      tone: issues.some((item) => item.tone === "error") ? "error" : "warn"
    };
  }

  function renderCloudOpsLiveCurrent() {
    if (!cloudOpsLiveCurrent) return;
    cloudOpsLiveCurrent.innerHTML = "";

    const selectedVehicle =
      cloudOpsVehicles.find((vehicle) => String(vehicle?.vehicle_id || "") === cloudOpsCurrentVehicleId) || null;
    const currentVehicle = cloudOpsCurrentDetail?.vehicle || selectedVehicle || null;
    const telemetry = normalizeCloudOpsTelemetry(currentVehicle?.telemetry);
    const heartbeat = currentVehicle?.heartbeat || {};
    const snapshot = currentVehicle?.snapshot || {};
    const system = snapshot?.system || {};
    const master = snapshot?.master || {};
    const masterSsh = master?.ssh || {};
    const masterMemory = masterSsh?.memory_kb || {};
    const masterDisk = masterSsh?.disk_root || {};

    if (!cloudOpsCurrentVehicleId) {
      cloudOpsLiveCurrent.appendChild(
        createNode("p", "cloud-ops-live-empty", "当前没有选中车辆。")
      );
      return;
    }

    if (!telemetry.timestamp) {
      cloudOpsLiveCurrent.appendChild(
        createNode("p", "cloud-ops-live-empty", `${cloudOpsCurrentVehicleId} 暂未收到 telemetry。`)
      );
      return;
    }

    const keyTopicSummary = countCloudOpsTelemetryStates(telemetry.keyTopics);
    const keyNodeSummary = countCloudOpsTelemetryStates(telemetry.keyNodes);
    const mediaCpu = Number.isFinite(telemetry.mediaCpuPercent)
      ? telemetry.mediaCpuPercent
      : Number.isFinite(system?.cpu?.percent)
        ? Number(system.cpu.percent)
        : Number.isFinite(Number(heartbeat?.cpu_percent))
          ? Number(heartbeat.cpu_percent)
          : null;
    const mediaMemoryText =
      Number.isFinite(Number(system?.memory?.used_bytes)) && Number.isFinite(Number(system?.memory?.total_bytes))
        ? `${formatCloudOpsBytes(system.memory.used_bytes)} / ${formatCloudOpsBytes(system.memory.total_bytes)}`
        : Number.isFinite(telemetry.mediaMemoryPercent)
          ? `${formatCloudOpsNumber(telemetry.mediaMemoryPercent)}%`
          : Number.isFinite(Number(heartbeat?.memory_percent))
            ? `${formatCloudOpsNumber(heartbeat.memory_percent)}%`
            : "-";
    const mediaDisk = Number.isFinite(telemetry.mediaDiskPercent)
      ? telemetry.mediaDiskPercent
      : Number.isFinite(system?.disk_root?.percent)
        ? Number(system.disk_root.percent)
        : Number.isFinite(Number(heartbeat?.disk_percent))
          ? Number(heartbeat.disk_percent)
          : null;
    const masterCpuText = Number.isFinite(telemetry.masterCpuPercent)
      ? `${formatCloudOpsNumber(telemetry.masterCpuPercent)}%`
      : "未上报";
    const masterLoad = String(masterSsh?.loadavg_raw || "")
      .trim()
      .split(/\s+/)
      .slice(0, 3)
      .join(" / ");
    const masterMemoryText =
      Number.isFinite(Number(masterMemory?.MemAvailable)) && Number.isFinite(Number(masterMemory?.MemTotal))
        ? `${formatCloudOpsBytes(
            (Number(masterMemory.MemTotal) - Number(masterMemory.MemAvailable)) * 1024
          )} / ${formatCloudOpsBytes(Number(masterMemory.MemTotal) * 1024)}`
        : "-";
    const masterDiskText =
      masterDisk?.use_percent && masterDisk?.mountpoint
        ? `${masterDisk.use_percent} @ ${masterDisk.mountpoint}`
        : masterDisk?.use_percent || "-";

    const appendStateSection = (title, map, summary) => {
      const section = createNode("section", "cloud-ops-live-state-section");
      const head = createNode("div", "cloud-ops-live-state-head");
      head.appendChild(createNode("h4", "cloud-ops-live-state-title", title));
      head.appendChild(
        createNode(
          "span",
          "cloud-ops-live-state-summary",
          summary?.total ? `${summary.okCount}/${summary.total} 正常` : "暂无数据"
        )
      );
      section.appendChild(head);

      const entries = Object.entries(map || {});
      if (!entries.length) {
        section.appendChild(createNode("p", "cloud-ops-live-empty", "暂无实时状态。"));
        cloudOpsLiveCurrent.appendChild(section);
        return;
      }

      const list = createNode("div", "cloud-ops-live-state-list");
      entries.forEach(([key, value]) => {
        const chip = createNode(
          "article",
          `cloud-ops-live-state-chip is-${
            value === true ? "ok" : value === false ? "bad" : "unknown"
          }`
        );
        chip.appendChild(createNode("span", "cloud-ops-live-state-chip-label", formatCloudOpsTelemetryKeyLabel(key)));
        chip.appendChild(
          createNode(
            "span",
            "cloud-ops-live-state-chip-status",
            value === true ? "正常" : value === false ? "异常" : "未知"
          )
        );
        list.appendChild(chip);
      });
      section.appendChild(list);
      cloudOpsLiveCurrent.appendChild(section);
    };

    const overviewCards = [
      ["遥测时间", formatIsoTimestamp(telemetry.timestamp)],
      ["状态时效", Number.isFinite(telemetry.dataAgeS) ? formatCloudOpsRelativeSeconds(telemetry.dataAgeS) : "-"],
      ["车速", Number.isFinite(telemetry.vehicleSpeed) ? `${formatCloudOpsNumber(telemetry.vehicleSpeed)} km/h` : "-"],
      ["电量", Number.isFinite(telemetry.batterySoc) ? `${formatCloudOpsNumber(telemetry.batterySoc)}%` : "-"],
      [
        "急停 / 碰撞停 / 超声停",
        `${formatCloudOpsBool(telemetry.emergencyStop, "触发", "正常")} / ${formatCloudOpsBool(
          telemetry.collisionStop,
          "触发",
          "正常"
        )} / ${formatCloudOpsBool(telemetry.ultrasonicStop, "触发", "正常")}`
      ],
      [
        "运行模式 / 挡位 / Ready",
        `${telemetry.runningMode ?? "-"} / ${telemetry.gear ?? "-"} / ${formatCloudOpsBool(
          telemetry.ready,
          "就绪",
          "未就绪"
        )}`
      ]
    ];
    const resourceCards = [
      ["主控主机", telemetry.masterHost || masterSsh?.hostname || "-"],
      ["主控连通 / ROS", `${formatCloudOpsBool(telemetry.masterReachable, "连通", "断开")} / ${formatCloudOpsBool(telemetry.masterRosOk, "正常", "异常")}`],
      ["主控 CPU", masterCpuText],
      ["主控内存(已用/总量)", masterMemoryText],
      ["主控负载(1/5/15m)", masterLoad || "-"],
      ["主控磁盘", masterDiskText],
      ["Media CPU", Number.isFinite(mediaCpu) ? `${formatCloudOpsNumber(mediaCpu)}%` : "-"],
      ["Media 内存(已用/总量)", mediaMemoryText],
      ["Media 磁盘", Number.isFinite(mediaDisk) ? `${formatCloudOpsNumber(mediaDisk)}%` : "-"],
      ["Media LoadAvg(1m)", Number.isFinite(telemetry.mediaLoadAvg1m) ? formatCloudOpsNumber(telemetry.mediaLoadAvg1m, 2) : "-"],
      ["主控 Topic / Node", `${telemetry.masterTopicCount ?? "-"} / ${telemetry.masterNodeCount ?? "-"}`],
      ["电池电压 / 电流", `${Number.isFinite(telemetry.batteryVoltage) ? `${formatCloudOpsNumber(telemetry.batteryVoltage)}V` : "-"} / ${Number.isFinite(telemetry.batteryCurrent) ? `${formatCloudOpsNumber(telemetry.batteryCurrent)}A` : "-"}`]
    ];

    const overviewSection = createNode("section", "cloud-ops-live-block");
    overviewSection.appendChild(createNode("h4", "cloud-ops-live-block-title", "实时总览"));
    const overviewGrid = createNode("div", "cloud-ops-live-grid");
    overviewCards.forEach(([label, value]) => {
      overviewGrid.appendChild(createCloudOpsMetaItem(label, value));
    });
    overviewSection.appendChild(overviewGrid);
    cloudOpsLiveCurrent.appendChild(overviewSection);

    const resourceSection = createNode("section", "cloud-ops-live-block");
    resourceSection.appendChild(createNode("h4", "cloud-ops-live-block-title", "主控 / Media 资源"));
    const resourceGrid = createNode("div", "cloud-ops-live-grid");
    resourceCards.forEach(([label, value]) => {
      resourceGrid.appendChild(createCloudOpsMetaItem(label, value));
    });
    resourceSection.appendChild(resourceGrid);
    cloudOpsLiveCurrent.appendChild(resourceSection);

    appendStateSection("关键话题", telemetry.keyTopics, keyTopicSummary);
    appendStateSection("关键节点", telemetry.keyNodes, keyNodeSummary);
  }

  function renderCloudOpsLiveAlerts() {
    if (!cloudOpsAlertsList) return;
    cloudOpsAlertsList.innerHTML = "";

    const alerts = cloudOpsVehicles
      .map((vehicle) => buildCloudOpsVehicleAlert(vehicle))
      .filter(Boolean)
      .sort((left, right) => String(left.vehicleId).localeCompare(String(right.vehicleId)));

    if (!alerts.length) {
      if (cloudOpsAlertsEmpty) {
        cloudOpsAlertsList.appendChild(cloudOpsAlertsEmpty);
      } else {
        cloudOpsAlertsList.appendChild(
          createNode("p", "cloud-ops-alerts-empty", "当前暂无异常车辆。")
        );
      }
      if (cloudOpsAlertsStatus) {
        cloudOpsAlertsStatus.textContent = "全部正常";
        cloudOpsAlertsStatus.dataset.state = "ok";
      }
      return;
    }

    alerts.forEach((alert) => {
      const card = createNode("article", `cloud-ops-alert-card is-${alert.tone}`);
      const head = createNode("div", "cloud-ops-alert-card-head");
      head.appendChild(createNode("p", "cloud-ops-alert-vehicle", alert.vehicleId));
      head.appendChild(createNode("p", "cloud-ops-alert-time", formatIsoTimestamp(alert.timestamp)));
      card.appendChild(head);

      const issues = createNode("div", "cloud-ops-alert-issues");
      alert.issues.forEach((issue) => {
        issues.appendChild(
          createNode("span", `cloud-ops-alert-chip is-${issue.tone}`, issue.text)
        );
      });
      card.appendChild(issues);
      cloudOpsAlertsList.appendChild(card);
    });

    if (cloudOpsAlertsStatus) {
      cloudOpsAlertsStatus.textContent = `${alerts.length} 台异常`;
      cloudOpsAlertsStatus.dataset.state = "error";
    }
  }

  function renderCloudOpsLiveState() {
    renderCloudOpsLiveCurrent();
    renderCloudOpsLiveAlerts();
  }

  function renderCloudOpsSummarySection(title, cards, sectionClass = "") {
    const section = createNode(
      "section",
      `cloud-ops-summary-section${sectionClass ? ` ${sectionClass}` : ""}`
    );
    section.appendChild(createNode("p", "cloud-ops-summary-section-title", title));
    const row = createNode("div", "cloud-ops-summary-grid");
    cards.forEach(([label, value]) => {
      row.appendChild(createCloudOpsMetaItem(label, value));
    });
    section.appendChild(row);
    return section;
  }

  function renderCloudOpsSummary() {
    if (!cloudOpsSummary) return;
    cloudOpsSummary.innerHTML = "";

    const selectedVehicle =
      cloudOpsVehicles.find((vehicle) => String(vehicle?.vehicle_id || "") === cloudOpsCurrentVehicleId) ||
      null;
    const vehicleDetail = cloudOpsCurrentDetail?.vehicle || {};
    const heartbeat = vehicleDetail?.heartbeat || selectedVehicle?.heartbeat || {};
    const snapshot = vehicleDetail?.snapshot || selectedVehicle?.snapshot || {};
    const telemetry = normalizeCloudOpsTelemetry(vehicleDetail?.telemetry || selectedVehicle?.telemetry);
    const identity = snapshot?.identity || {};
    const system = snapshot?.system || {};
    const master = snapshot?.master || {};
    const masterSsh = master?.ssh || {};
    const masterMemory = masterSsh?.memory_kb || {};
    const masterDisk = masterSsh?.disk_root || {};
    const mediaHost = identity?.hostname || heartbeat?.hostname || "-";
    const mediaIp = identity?.local_primary_ip || heartbeat?.local_primary_ip || "-";
    const mediaCpu = Number.isFinite(telemetry.mediaCpuPercent)
      ? telemetry.mediaCpuPercent
      : Number.isFinite(system?.cpu?.percent)
        ? system.cpu.percent
        : heartbeat?.cpu_percent;
    const mediaMemory = Number.isFinite(system?.memory?.percent)
      ? system.memory.percent
      : Number.isFinite(telemetry.mediaMemoryPercent)
        ? telemetry.mediaMemoryPercent
        : heartbeat?.memory_percent;
    const mediaDisk = Number.isFinite(system?.disk_root?.percent)
      ? system.disk_root.percent
      : Number.isFinite(telemetry.mediaDiskPercent)
        ? telemetry.mediaDiskPercent
        : heartbeat?.disk_percent;
    const mediaMemoryText =
      Number.isFinite(Number(system?.memory?.used_bytes)) && Number.isFinite(Number(system?.memory?.total_bytes))
        ? `${formatCloudOpsBytes(system.memory.used_bytes)} / ${formatCloudOpsBytes(system.memory.total_bytes)}`
        : Number.isFinite(mediaMemory)
          ? `${formatCloudOpsNumber(mediaMemory)}%`
          : "-";
    const masterHost = masterSsh?.hostname || identity?.master_host || heartbeat?.master_host || "-";
    const masterReachable =
      telemetry.masterReachable === true || master?.reachable === true || heartbeat?.master_ping_ok === true
        ? "已连通"
        : telemetry.masterReachable === false ||
            master?.reachable === false ||
            heartbeat?.master_ping_ok === false
          ? "未连通"
          : "-";
    const masterLoad = String(masterSsh?.loadavg_raw || "")
      .trim()
      .split(/\s+/)
      .slice(0, 3)
      .join(" / ");
    const masterMemoryText =
      Number.isFinite(Number(masterMemory?.MemAvailable)) && Number.isFinite(Number(masterMemory?.MemTotal))
        ? `${formatCloudOpsBytes(
            (Number(masterMemory.MemTotal) - Number(masterMemory.MemAvailable)) * 1024
          )} / ${formatCloudOpsBytes(
            Number(masterMemory.MemTotal) * 1024
          )}`
        : "-";
    const masterDiskText =
      masterDisk?.use_percent && masterDisk?.mountpoint
        ? `${masterDisk.use_percent} @ ${masterDisk.mountpoint}`
        : masterDisk?.use_percent || "-";

    const overviewCards = [
      ["在线车辆", `${cloudOpsVehicles.length}`],
      ["当前车辆", cloudOpsCurrentVehicleId || "-"],
      ["最近上报", formatIsoTimestamp(selectedVehicle?.last_seen || cloudOpsCurrentDetail?.vehicle?.last_seen)],
      ["工具数量", `${cloudOpsAvailableTools.size || selectedVehicle?.tool_count || 0}`],
      [
        "ROS 规模",
        Number.isFinite(telemetry.masterTopicCount) || Number.isFinite(telemetry.masterNodeCount)
          ? `${telemetry.masterTopicCount ?? "-"} Topic / ${telemetry.masterNodeCount ?? "-"} Node`
          : Number.isFinite(heartbeat?.topic_count)
            ? `${heartbeat.topic_count} Topic / ${heartbeat?.node_count ?? "-"} Node`
          : "-"
      ]
    ];
    const mediaCards = [
      ["Media 主机", mediaHost],
      ["Media IP", mediaIp],
      ["Media CPU", Number.isFinite(mediaCpu) ? `${formatCloudOpsNumber(mediaCpu)}%` : "-"],
      ["Media 内存(已用/总量)", mediaMemoryText],
      ["Media 磁盘", Number.isFinite(mediaDisk) ? `${formatCloudOpsNumber(mediaDisk)}%` : "-"],
    ];
    const masterCards = [
      ["主控主机", masterHost],
      ["主控连通", masterReachable],
      ["主控 LoadAvg(1/5/15m)", masterLoad || "-"],
      ["主控内存(已用/总量)", masterMemoryText],
      ["主控磁盘", masterDiskText]
    ];

    cloudOpsSummary.appendChild(
      renderCloudOpsSummarySection("总览", overviewCards, "cloud-ops-summary-overview")
    );
    cloudOpsSummary.appendChild(
      renderCloudOpsSummarySection("主控", masterCards, "cloud-ops-summary-master")
    );
    cloudOpsSummary.appendChild(
      renderCloudOpsSummarySection("Media", mediaCards, "cloud-ops-summary-media")
    );
  }

  function parseJsonDataset(value, fallback = {}) {
    if (!value) return fallback;
    try {
      return JSON.parse(value);
    } catch (_error) {
      return fallback;
    }
  }

  function formatCloudOpsToolName(toolName) {
    const name = String(toolName || "").trim();
    const labels = {
      "status.key_nodes": "关键节点",
      "health.autodrive_check": "一键健康检查",
      "vehicle.snapshot": "整车快照",
      "system.snapshot": "系统快照",
      "network.cloud_probe": "云端连通",
      "network.master_probe": "主控探测",
      "status.camera": "相机状态",
      "camera.capture": "相机抓拍",
      "camera.upload_chain": "上传链路",
      "ai_detection.config": "AI检测配置",
      "ai_detection.images": "AI检测图片",
      "map.preview": "地图查看",
      "obstacle.preview": "障碍俯视图",
      "status.localization": "定位状态",
      "status.can": "底盘 CAN",
      "status.body_control": "车身状态",
      "vehicle.body_control": "车身控制",
      "vehicle.clear_collision_stop": "碰撞停复位",
      "status.planning": "规划状态",
      "status.routing": "Routing 状态",
      "status.obstacle_processor": "障碍处理",
      "route.list": "路线列表",
      "route.detail": "路线详情",
      "route.start_patrol": "启动巡逻",
      "route.stop_patrol": "停止巡逻",
      "ros.overview": "ROS 总览",
      "audio.uplink.mic": "听麦",
      "audio.uplink.speaker": "听喇叭"
    };
    return labels[name] || name || "该工具";
  }

  function getCloudOpsValue(source, paths, fallback = undefined) {
    const pathList = Array.isArray(paths) ? paths : [paths];
    for (const path of pathList) {
      const segments = Array.isArray(path) ? path : String(path || "").split(".");
      let current = source;
      let exists = true;
      for (const segment of segments) {
        if (!segment) continue;
        if (current && typeof current === "object" && segment in current) {
          current = current[segment];
        } else {
          exists = false;
          break;
        }
      }
      if (!exists) continue;
      if (current !== undefined && current !== null && current !== "") {
        return current;
      }
    }
    return fallback;
  }

  function looksLikeImageUrl(value) {
    return typeof value === "string" && /^(data:image\/|https?:\/\/|\/)/i.test(value.trim());
  }

  function looksLikeBase64Payload(value) {
    const text = String(value || "").replace(/\s+/g, "");
    return text.length > 120 && /^[A-Za-z0-9+/=]+$/.test(text);
  }

  function toImageDataUrl(base64, mimeType = "image/jpeg") {
    const payload = String(base64 || "").replace(/\s+/g, "");
    if (!looksLikeBase64Payload(payload)) {
      return "";
    }
    return `data:${String(mimeType || "image/jpeg").trim() || "image/jpeg"};base64,${payload}`;
  }

  function createCloudOpsMediaLabel(source, fallback = "抓拍图像") {
    const savedFile = String(source?.saved_file || source?.saved_path || "").toLowerCase();
    if (fallback === "preview" || fallback === "map" || savedFile.includes("map_preview")) {
      return "地图预览";
    }
    if (
      fallback === "ai_detection" ||
      fallback === "ai_image" ||
      savedFile.includes("groundingdino") ||
      savedFile.includes("resultimg")
    ) {
      return "AI检测图片";
    }
    if (
      fallback === "obstacle" ||
      fallback === "obstacle_preview" ||
      savedFile.includes("obstacle_preview")
    ) {
      return "障碍俯视图";
    }
    return (
      source?.camera_id ||
      source?.camera ||
      source?.name ||
      source?.label ||
      source?.title ||
      source?.id ||
      fallback
    );
  }

  function extractCloudOpsMediaItems(payload) {
    const items = [];
    const seen = new WeakSet();
    const execution = getCloudOpsExecutionPayload(payload);
    const toolName = execution?.request?.tool_name || execution?.data?.tool || "";
    const defaultLabel =
      toolName === "map.preview"
        ? "地图预览"
        : toolName === "ai_detection.images"
          ? "AI检测图片"
        : toolName === "obstacle.preview"
          ? "障碍俯视图"
          : "抓拍图像";

    function visit(value, fallbackLabel = "抓拍图像", depth = 0) {
      if (!value || depth > 6 || items.length >= 8) {
        return;
      }

      if (Array.isArray(value)) {
        value.slice(0, 8).forEach((item) => visit(item, fallbackLabel, depth + 1));
        return;
      }

      if (typeof value !== "object") {
        return;
      }

      if (seen.has(value)) {
        return;
      }
      seen.add(value);

      const base64 =
        value?.image_base64 ||
        value?.data_base64 ||
        value?.base64 ||
        value?.jpeg_base64 ||
        value?.jpg_base64 ||
        value?.frame_base64 ||
        "";
      const src =
        (looksLikeImageUrl(value?.image_url) && value.image_url) ||
        (looksLikeImageUrl(value?.snapshot_url) && value.snapshot_url) ||
        (looksLikeImageUrl(value?.url) && value.url) ||
        toImageDataUrl(base64, value?.mime_type || value?.image_mime_type || value?.format);

      if (src) {
        items.push({
          id: createNonce(),
          label: createCloudOpsMediaLabel(value, fallbackLabel),
          src,
          width: value?.width || value?.frame_width || null,
          height: value?.height || value?.frame_height || null
        });
      }

      Object.entries(value).forEach(([key, child]) => {
        if (
          items.length >= 8 ||
          child === null ||
          child === undefined ||
          typeof child === "string" ||
          typeof child === "number" ||
          typeof child === "boolean"
        ) {
          return;
        }
        visit(child, key, depth + 1);
      });
    }

    const result = getCloudOpsToolResult(execution);
    visit(result || payload, defaultLabel);
    return items;
  }

  function renderCloudOpsMediaContainer(container, payload) {
    if (!container) return;
    const items = extractCloudOpsMediaItems(payload);
    container.innerHTML = "";
    container.hidden = !items.length;

    if (!items.length) {
      return;
    }

    items.forEach((item) => {
      const card = createNode("article", "cloud-ops-media-card");
      const link = document.createElement("a");
      link.className = "cloud-ops-media-link";
      link.href = item.src;
      link.target = "_blank";
      link.rel = "noreferrer noopener";
      link.title = `${item.label}，点击查看原图`;

      const image = document.createElement("img");
      image.className = "cloud-ops-media-image";
      image.src = item.src;
      image.alt = item.label;
      image.loading = "lazy";
      link.appendChild(image);
      card.appendChild(link);

      const caption = createNode("div", "cloud-ops-media-caption");
      caption.appendChild(createNode("p", "cloud-ops-media-title", item.label));
      if (item.width && item.height) {
        caption.appendChild(
          createNode("p", "cloud-ops-media-meta", `${item.width} × ${item.height}`)
        );
      }
      card.appendChild(caption);
      container.appendChild(card);
    });
  }

  function renderCloudOpsResultMedia(payload) {
    renderCloudOpsMediaContainer(cloudOpsResultMedia, payload);
  }

  function clearCloudOpsPinnedContexts(options = {}) {
    cloudOpsPinnedContexts = [];
    renderCloudOpsContextList();
    if (options.resetConversation && openClawAuthenticated) {
      resetOpenClawConversation();
    }
  }

  function renderCloudOpsContextList() {
    if (!cloudOpsContextList) return;
    cloudOpsContextList.innerHTML = "";

    if (!cloudOpsPinnedContexts.length) {
      if (cloudOpsContextEmpty) {
        cloudOpsContextEmpty.hidden = false;
        cloudOpsContextList.appendChild(cloudOpsContextEmpty);
      }
      if (cloudOpsContextClear) {
        cloudOpsContextClear.disabled = true;
      }
      return;
    }

    if (cloudOpsContextEmpty) {
      cloudOpsContextEmpty.hidden = true;
    }
    if (cloudOpsContextClear) {
      cloudOpsContextClear.disabled = false;
    }

    cloudOpsPinnedContexts.forEach((item) => {
      const chip = createNode("article", "cloud-ops-context-chip");
      const body = createNode("div", "cloud-ops-context-chip-body");
      body.appendChild(createNode("p", "cloud-ops-context-chip-title", item.label || "运维上下文"));
      body.appendChild(createNode("p", "cloud-ops-context-chip-summary", item.summary || "已插入上下文"));
      chip.appendChild(body);

      const removeBtn = createNode("button", "cloud-ops-context-chip-remove", "移除");
      removeBtn.type = "button";
      removeBtn.addEventListener("click", () => {
        cloudOpsPinnedContexts = cloudOpsPinnedContexts.filter((contextItem) => contextItem.id !== item.id);
        renderCloudOpsContextList();
      });
      chip.appendChild(removeBtn);
      cloudOpsContextList.appendChild(chip);
    });
  }

  function buildCloudOpsContextItem(button, payload) {
    const title =
      button?.querySelector?.("strong")?.textContent?.trim() ||
      formatCloudOpsToolName(payload?.plan?.tool_name || payload?.execution?.request?.tool_name || payload?.plan?.action);
    return {
      id: createNonce(),
      label: title,
      vehicle_id: cloudOpsCurrentVehicleId || payload?.plan?.vehicle_id || "",
      summary: buildCloudOpsContextSummary(payload),
      payload: payload?.execution || payload || null,
      inserted_at_ms: Date.now()
    };
  }

  function pinCloudOpsContext(button, payload) {
    if (!payload?.ok) return null;
    const item = buildCloudOpsContextItem(button, payload);
    cloudOpsPinnedContexts = [...cloudOpsPinnedContexts, item].slice(-6);
    renderCloudOpsContextList();
    return item;
  }

  function formatCloudOpsNumber(value, digits = 1) {
    if (value === null || value === undefined || value === "" || typeof value === "boolean") {
      return "-";
    }
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return "-";
    }
    return num.toFixed(digits);
  }

  function formatCloudOpsBool(value, yesText = "是", noText = "否", unknownText = "-") {
    if (value === true) return yesText;
    if (value === false) return noText;
    return unknownText;
  }

  function formatCloudOpsSwitchState(value) {
    return formatCloudOpsBool(value, "开启", "关闭");
  }

  function formatCloudOpsSteerLampMode(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (!normalized) return "-";
    const labels = {
      off: "关闭",
      left: "左转",
      right: "右转",
      hazard: "双闪"
    };
    return labels[normalized] || normalized;
  }

  function formatCloudOpsBodyStateTriplet(intentValue, commandValue, feedbackValue) {
    return `规划 ${formatCloudOpsSwitchState(intentValue)} / 指令 ${formatCloudOpsSwitchState(
      commandValue
    )} / 反馈 ${formatCloudOpsSwitchState(feedbackValue)}`;
  }

  function formatCloudOpsBodyFeedbackSummary(summary) {
    const feedback = summary?.vehicle_feedback || {};
    return [
      `广告屏 ${formatCloudOpsSwitchState(feedback?.ad_screen_on)}`,
      `前照灯 ${formatCloudOpsSwitchState(feedback?.front_lamp_on)}`,
      `氛围灯 ${formatCloudOpsSwitchState(feedback?.mood_lamp_on)}`,
      `转向灯 ${formatCloudOpsSteerLampMode(feedback?.steer_lamp_mode)}`
    ].join(" / ");
  }

  function deriveCloudOpsResultState(payload) {
    const execution = getCloudOpsExecutionPayload(payload);
    if (!execution?.ok) {
      return "error";
    }
    if (execution.action !== "tool_call") {
      return "ok";
    }
    const toolName = execution?.request?.tool_name || "";
    const result = getCloudOpsToolResult(execution);
    const status = String(result?.status || "").trim().toLowerCase();
    if (toolName === "vehicle.body_control") {
      if (status === "applied") return "ok";
      if (status === "partial") return "warn";
      if (status === "noop") return "warn";
      if (status === "error") return "error";
    }
    if (toolName === "vehicle.clear_collision_stop") {
      if (status === "cleared") return "ok";
      if (status === "noop") return "warn";
      if (status === "error") return "error";
    }
    return "ok";
  }

  function formatCloudOpsBytes(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) {
      return "-";
    }

    const units = ["B", "KB", "MB", "GB", "TB"];
    let current = num;
    let unitIndex = 0;
    while (current >= 1024 && unitIndex < units.length - 1) {
      current /= 1024;
      unitIndex += 1;
    }
    const digits = current >= 100 || unitIndex === 0 ? 0 : current >= 10 ? 1 : 2;
    return `${current.toFixed(digits)} ${units[unitIndex]}`;
  }

  function formatCloudOpsDurationSeconds(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) {
      return "-";
    }

    const totalSeconds = Math.round(seconds);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const remainSeconds = totalSeconds % 60;
    const parts = [];
    if (days) parts.push(`${days}天`);
    if (hours) parts.push(`${hours}小时`);
    if (minutes) parts.push(`${minutes}分`);
    if (!parts.length || remainSeconds) parts.push(`${remainSeconds}秒`);
    return parts.join("");
  }

  function formatCloudOpsProcessPreview(list, percentKey, limit = 3, suffix = "%") {
    if (!Array.isArray(list) || !list.length) {
      return "-";
    }

    return list
      .slice(0, limit)
      .map((item) => {
        const name = item?.name || item?.cmdline || item?.cmd || item?.pid || "unknown";
        const percent = Number(item?.[percentKey]);
        if (!Number.isFinite(percent)) {
          return String(name);
        }
        return `${name} ${formatCloudOpsNumber(percent)}${suffix}`;
      })
      .join("、");
  }

  function formatCloudOpsInterfacePreview(interfaces) {
    if (!Array.isArray(interfaces) || !interfaces.length) {
      return "-";
    }

    return interfaces
      .filter((item) => item?.is_up !== false)
      .slice(0, 3)
      .map((item) => {
        const ip = Array.isArray(item?.ipv4) ? item.ipv4[0]?.address : "";
        return `${item?.name || "iface"}${ip ? ` ${ip}` : ""}`;
      })
      .join("、");
  }

  function formatCloudOpsTemperaturePreview(temperatures) {
    if (!temperatures || typeof temperatures !== "object") {
      return "-";
    }

    const values = Object.values(temperatures)
      .flatMap((group) => (Array.isArray(group) ? group : []))
      .map((item) => Number(item?.current))
      .filter((value) => Number.isFinite(value));

    if (!values.length) {
      return "-";
    }

    const peak = Math.max(...values);
    return `${formatCloudOpsNumber(peak)}°C`;
  }

  function focusWithoutScroll(element) {
    if (!element || typeof element.focus !== "function") {
      return;
    }

    try {
      element.focus({ preventScroll: true });
    } catch (_error) {
      element.focus();
    }
  }

  function getCloudOpsTone(value) {
    if (value === true) return "ok";
    if (value === false) return "error";
    return "idle";
  }

  function pushCloudOpsDetail(items, label, value, tone = "idle") {
    if (value === undefined || value === null) return;
    const text = String(value).trim();
    if (!text || text === "-") return;
    items.push({ label, value: text, tone });
  }

  function getCloudOpsToolResult(execution) {
    if (!execution || typeof execution !== "object") {
      return null;
    }
    return execution?.data?.response?.result || execution?.data?.response || null;
  }

  function getCloudOpsExecutionPayload(payload) {
    if (!payload || typeof payload !== "object") {
      return null;
    }
    if (payload.execution) return payload.execution;
    if (payload.vehicle_detail) return payload.vehicle_detail;
    if (payload.tool_list) return payload.tool_list;
    return null;
  }

  function getCloudOpsListFromResult(result) {
    if (Array.isArray(result)) return result;
    if (!result || typeof result !== "object") return [];

    const candidates = [
      result.items,
      result.routes,
      result.tools,
      result.events,
      result.cameras,
      result.captures,
      result.images,
      result.checks
    ];

    for (const candidate of candidates) {
      if (Array.isArray(candidate)) {
        return candidate;
      }
    }

    if (result.subsystems && typeof result.subsystems === "object") {
      return Object.entries(result.subsystems).map(([name, value]) => ({
        name,
        subsystem: name,
        ...(value && typeof value === "object" ? value : {})
      }));
    }

    if (result.nodes && typeof result.nodes === "object") {
      if (Array.isArray(result.nodes)) {
        return result.nodes;
      }
      if (Array.isArray(result.nodes.nodes)) {
        return result.nodes.nodes;
      }
    }

    return [];
  }

  function buildCloudOpsResultDetails(payload) {
    const items = [];
    const execution = getCloudOpsExecutionPayload(payload);

    if (payload?.audio && typeof payload.audio === "object" && !execution) {
      const audio = payload.audio;
      pushCloudOpsDetail(items, "车辆", audio.vehicle_id || "-", "ok");
      pushCloudOpsDetail(items, "音频通道", audio.label || formatCloudOpsToolName(audio.tool), "ok");
      pushCloudOpsDetail(items, "状态", audio.state || "-", audio.tone || "idle");
      pushCloudOpsDetail(items, "stream_id", audio.stream_id || "-");
      if (Number.isFinite(Number(audio.chunk_count))) {
        pushCloudOpsDetail(items, "片段数", `${Number(audio.chunk_count)}`, "ok");
      }
      return items;
    }

    if (payload?.vehicle_detail && !payload?.execution) {
      const vehicle = payload.vehicle_detail?.data?.vehicle || {};
      const heartbeat = vehicle?.heartbeat || {};
      pushCloudOpsDetail(items, "车辆", vehicle?.vehicle_id || vehicle?.plate_number || "-", "ok");
      pushCloudOpsDetail(items, "最近上报", vehicle?.last_seen || "-", "ok");
      if (Number.isFinite(heartbeat?.cpu_percent)) {
        pushCloudOpsDetail(
          items,
          "资源占用",
          `CPU ${formatCloudOpsNumber(heartbeat.cpu_percent)}% / 内存 ${formatCloudOpsNumber(
            heartbeat?.memory_percent
          )}% / 磁盘 ${formatCloudOpsNumber(heartbeat?.disk_percent)}%`
        );
      }
      if (Number.isFinite(heartbeat?.topic_count)) {
        pushCloudOpsDetail(
          items,
          "ROS 规模",
          `${heartbeat.topic_count} Topic / ${heartbeat?.node_count ?? "-"} Node / ${
            heartbeat?.service_count ?? "-"
          } Service`
        );
      }
      pushCloudOpsDetail(
        items,
        "主控连通",
        formatCloudOpsBool(heartbeat?.master_ping_ok, "正常", "异常"),
        getCloudOpsTone(heartbeat?.master_ping_ok)
      );
    }

    if (!execution) {
      return items;
    }

    if (!execution.ok) {
      pushCloudOpsDetail(items, "执行状态", "失败", "error");
      pushCloudOpsDetail(items, "失败原因", execution?.detail || execution?.error || "unknown", "error");
      pushCloudOpsDetail(items, "接口", execution?.endpoint || "-", "warn");
      return items;
    }

    if (execution.action === "tool_list") {
      const tools = Array.isArray(execution?.data?.response?.tools) ? execution.data.response.tools : [];
      pushCloudOpsDetail(items, "工具数量", `${tools.length}`, "ok");
      pushCloudOpsDetail(
        items,
        "前几项",
        tools
          .slice(0, 8)
          .map((tool) => tool?.name || "")
          .filter(Boolean)
          .join("、")
      );
      return items;
    }

    if (execution.action === "list_vehicles") {
      const vehicles = Array.isArray(execution?.data?.vehicles) ? execution.data.vehicles : [];
      pushCloudOpsDetail(items, "在线车辆", `${vehicles.length}`, "ok");
      pushCloudOpsDetail(
        items,
        "车辆列表",
        vehicles
          .map((vehicle) => vehicle?.vehicle_id || vehicle?.plate_number || "")
          .filter(Boolean)
          .join("、")
      );
      return items;
    }

    if (execution.action === "vehicle_detail") {
      const vehicle = execution?.data?.vehicle || {};
      const heartbeat = vehicle?.heartbeat || {};
      pushCloudOpsDetail(items, "车辆", vehicle?.vehicle_id || vehicle?.plate_number || "-", "ok");
      pushCloudOpsDetail(items, "最近上报", vehicle?.last_seen || "-", "ok");
      pushCloudOpsDetail(
        items,
        "主控连通",
        formatCloudOpsBool(heartbeat?.master_ping_ok, "正常", "异常"),
        getCloudOpsTone(heartbeat?.master_ping_ok)
      );
      if (Number.isFinite(heartbeat?.cpu_percent)) {
        pushCloudOpsDetail(
          items,
          "资源占用",
          `CPU ${formatCloudOpsNumber(heartbeat.cpu_percent)}% / 内存 ${formatCloudOpsNumber(
            heartbeat?.memory_percent
          )}% / 磁盘 ${formatCloudOpsNumber(heartbeat?.disk_percent)}%`
        );
      }
      if (Number.isFinite(heartbeat?.topic_count)) {
        pushCloudOpsDetail(
          items,
          "ROS 规模",
          `${heartbeat.topic_count} Topic / ${heartbeat?.node_count ?? "-"} Node / ${
            heartbeat?.service_count ?? "-"
          } Service`
        );
      }
      return items;
    }

    if (execution.action !== "tool_call") {
      return items;
    }

    const toolName = execution?.request?.tool_name || "";
    const result = getCloudOpsToolResult(execution);
    const summary = result?.summary || {};

    if (toolName === "health.snapshot" && result && typeof result === "object") {
      pushCloudOpsDetail(items, "车辆", result?.vehicle_id || execution?.request?.vehicle_id || "-", "ok");
      pushCloudOpsDetail(
        items,
        "资源占用",
        `CPU ${formatCloudOpsNumber(result?.cpu_percent)}% / 内存 ${formatCloudOpsNumber(
          result?.memory_percent
        )}% / 磁盘 ${formatCloudOpsNumber(result?.disk_percent)}%`
      );
      pushCloudOpsDetail(
        items,
        "ROS 规模",
        `${result?.topic_count ?? "-"} Topic / ${result?.node_count ?? "-"} Node / ${
          result?.service_count ?? "-"
        } Service`
      );
      pushCloudOpsDetail(
        items,
        "主控连通",
        formatCloudOpsBool(result?.master_ping_ok, "正常", "异常"),
        getCloudOpsTone(result?.master_ping_ok)
      );
      pushCloudOpsDetail(items, "本机地址", result?.local_primary_ip || "-");
      return items;
    }

    if (toolName === "network.cloud_probe" && result && typeof result === "object") {
      pushCloudOpsDetail(
        items,
        "TCP 连通",
        formatCloudOpsBool(result?.tcp?.ok, "正常", "异常"),
        getCloudOpsTone(result?.tcp?.ok)
      );
      pushCloudOpsDetail(
        items,
        "WS 握手",
        formatCloudOpsBool(result?.websocket_handshake?.ok, "正常", "异常"),
        getCloudOpsTone(result?.websocket_handshake?.ok)
      );
      pushCloudOpsDetail(items, "云端地址", result?.ws || result?.url || "-", "ok");
      pushCloudOpsDetail(
        items,
        "异常信息",
        result?.websocket_handshake?.error || result?.tcp?.error || "-",
        "warn"
      );
      return items;
    }

    if (toolName === "network.master_probe" && result && typeof result === "object") {
      pushCloudOpsDetail(
        items,
        "主控可达",
        formatCloudOpsBool(result?.reachable, "是", "否"),
        getCloudOpsTone(result?.reachable)
      );
      pushCloudOpsDetail(
        items,
        "Ping",
        formatCloudOpsBool(result?.ping?.ok, "正常", "异常"),
        getCloudOpsTone(result?.ping?.ok)
      );
      pushCloudOpsDetail(
        items,
        "SSH 22",
        formatCloudOpsBool(result?.ssh?.ok ?? result?.tcp_22?.ok, "正常", "异常"),
        getCloudOpsTone(result?.ssh?.ok ?? result?.tcp_22?.ok)
      );
      pushCloudOpsDetail(
        items,
        "ROS 11311",
        formatCloudOpsBool(result?.tcp_11311?.ok, "正常", "异常"),
        getCloudOpsTone(result?.tcp_11311?.ok)
      );
      return items;
    }

    if (toolName === "ros.overview" && result && typeof result === "object") {
      pushCloudOpsDetail(
        items,
        "ROS 规模",
        `${result?.topic_count ?? "-"} Topic / ${result?.node_count ?? "-"} Node / ${
          result?.service_count ?? "-"
        } Service`,
        "ok"
      );
      pushCloudOpsDetail(
        items,
        "关键话题",
        Array.isArray(result?.key_topics) ? result.key_topics.slice(0, 6).join("、") : "-"
      );
      pushCloudOpsDetail(items, "ROS Master", result?.ros_master_uri || "-", "ok");
      return items;
    }

    if (toolName === "system.snapshot" && result && typeof result === "object") {
      const cpu = result?.cpu || {};
      const memory = result?.memory || {};
      const diskRoot = result?.disk_root || {};
      const networkIo = result?.network_io || {};
      pushCloudOpsDetail(
        items,
        "资源占用",
        `CPU ${formatCloudOpsNumber(cpu?.percent)}% / 内存 ${formatCloudOpsNumber(
          memory?.percent
        )}% / 磁盘 ${formatCloudOpsNumber(diskRoot?.percent)}%`
      );
      pushCloudOpsDetail(
        items,
        "主机 / 运行时长",
        `${result?.hostname || "-"} / ${formatCloudOpsDurationSeconds(result?.uptime_seconds)}`
      );
      pushCloudOpsDetail(
        items,
        "Load Average",
        `${formatCloudOpsNumber(cpu?.loadavg_1m)} / ${formatCloudOpsNumber(
          cpu?.loadavg_5m
        )} / ${formatCloudOpsNumber(cpu?.loadavg_15m)}`
      );
      pushCloudOpsDetail(
        items,
        "内存 / 磁盘容量",
        `${formatCloudOpsBytes(memory?.used_bytes)} / ${formatCloudOpsBytes(
          memory?.total_bytes
        )}，磁盘剩余 ${formatCloudOpsBytes(diskRoot?.free_bytes)}`
      );
      pushCloudOpsDetail(
        items,
        "网络收发",
        `收 ${formatCloudOpsBytes(networkIo?.bytes_recv)} / 发 ${formatCloudOpsBytes(
          networkIo?.bytes_sent
        )}`
      );
      pushCloudOpsDetail(items, "在线网卡", formatCloudOpsInterfacePreview(result?.interfaces));
      pushCloudOpsDetail(items, "最高温度", formatCloudOpsTemperaturePreview(result?.temperatures));
      pushCloudOpsDetail(
        items,
        "高 CPU 进程",
        formatCloudOpsProcessPreview(result?.top_cpu_processes, "cpu_percent")
      );
      pushCloudOpsDetail(
        items,
        "高内存进程",
        formatCloudOpsProcessPreview(result?.top_memory_processes, "memory_percent")
      );
      return items;
    }

    if (toolName === "vehicle.snapshot" && result && typeof result === "object") {
      const identity = result?.identity || {};
      const health = result?.health || {};
      const master = result?.master || {};
      const cloud = result?.cloud || {};
      const ros = result?.ros || {};
      pushCloudOpsDetail(items, "车辆", identity?.vehicle_id || execution?.request?.vehicle_id || "-", "ok");
      pushCloudOpsDetail(items, "车牌 / VIN", `${identity?.plate_number || "-"} / ${identity?.vin || "-"}`);
      pushCloudOpsDetail(
        items,
        "本机 / 主控",
        `${identity?.local_primary_ip || "-"} / ${identity?.master_host || "-"}`
      );
      if (result?.health && typeof result.health === "object") {
        pushCloudOpsDetail(
          items,
          "资源占用",
          `CPU ${formatCloudOpsNumber(health?.cpu_percent)}% / 内存 ${formatCloudOpsNumber(
            health?.memory_percent
          )}% / 磁盘 ${formatCloudOpsNumber(result.health?.disk_percent)}%`
        );
        pushCloudOpsDetail(
          items,
          "ROS 规模",
          `${health?.topic_count ?? ros?.topic_count ?? "-"} Topic / ${
            health?.node_count ?? ros?.node_count ?? "-"
          } Node / ${
            health?.service_count ?? ros?.service_count ?? "-"
          } Service`
        );
      }
      pushCloudOpsDetail(
        items,
        "主控连通",
        `Ping ${formatCloudOpsBool(master?.ping?.ok, "正常", "异常")} / SSH ${formatCloudOpsBool(
          master?.ssh?.ok ?? master?.tcp_22?.ok,
          "正常",
          "异常"
        )} / ROS ${formatCloudOpsBool(master?.tcp_11311?.ok, "正常", "异常")}`,
        master?.reachable === false ? "warn" : "ok"
      );
      pushCloudOpsDetail(
        items,
        "云端连通",
        `TCP ${formatCloudOpsBool(cloud?.tcp?.ok, "正常", "异常")} / WS ${formatCloudOpsBool(
          cloud?.websocket_handshake?.ok,
          "正常",
          "异常"
        )}`,
        getCloudOpsTone(cloud?.websocket_handshake?.ok)
      );
      pushCloudOpsDetail(items, "ROS Master / ROS IP", `${ros?.ros_master_uri || "-"} / ${ros?.ros_ip || "-"}`);
      pushCloudOpsDetail(
        items,
        "关键话题",
        Array.isArray(ros?.key_topics) ? ros.key_topics.slice(0, 6).join("、") : "-"
      );
      pushCloudOpsDetail(
        items,
        "主控负载",
        master?.ssh?.loadavg_raw || master?.ssh?.hostname || "-"
      );
      return items;
    }

    if (toolName === "status.catalog" && result && typeof result === "object") {
      const subsystems = Array.isArray(result?.subsystems) ? result.subsystems : [];
      pushCloudOpsDetail(items, "子系统数量", `${subsystems.length}`, "ok");
      pushCloudOpsDetail(
        items,
        "子系统目录",
        subsystems
          .map((item) => item?.name || item?.tool || "")
          .filter(Boolean)
          .join("、")
      );
      return items;
    }

    if (toolName === "status.key_nodes" && result && typeof result === "object") {
      const subsystems = getCloudOpsListFromResult(result);
      const faulted = Array.isArray(result?.faulted_subsystems) ? result.faulted_subsystems : [];
      const warnings = Array.isArray(result?.warning_subsystems) ? result.warning_subsystems : [];
      const nodeGroups = subsystems
        .map((item) => item?.nodes)
        .filter((item) => item && typeof item === "object");
      const flatNodes = nodeGroups.flatMap((group) =>
        Array.isArray(group?.nodes) ? group.nodes : Array.isArray(group) ? group : []
      );
      const onlineCount =
        flatNodes.filter((item) => item?.online !== false && item?.ok !== false).length ||
        nodeGroups.reduce((sum, group) => sum + (Number(group?.online_count) || 0), 0);
      const totalCount =
        flatNodes.length ||
        nodeGroups.reduce((sum, group) => sum + (Array.isArray(group?.nodes) ? group.nodes.length : 0), 0);
      const offlineNodes = flatNodes
        .filter((item) => item?.online === false || item?.ok === false)
        .map((item) => item?.node || item?.name || item?.id || "")
        .filter(Boolean);
      pushCloudOpsDetail(
        items,
        "关键节点",
        result?.health === "ok"
          ? "全部正常"
          : faulted.length || warnings.length || offlineNodes.length
            ? "存在异常"
            : `${onlineCount} 在线`,
        result?.health === "ok" ? "ok" : faulted.length || warnings.length || offlineNodes.length ? "warn" : "ok"
      );
      pushCloudOpsDetail(items, "在线数量", `${onlineCount} / ${totalCount || onlineCount}`, "ok");
      pushCloudOpsDetail(
        items,
        "故障 / 告警子系统",
        `${faulted.length ? faulted.join("、") : "无"} / ${warnings.length ? warnings.join("、") : "无"}`,
        faulted.length || warnings.length ? "warn" : "ok"
      );
      pushCloudOpsDetail(
        items,
        "异常节点",
        offlineNodes.length ? offlineNodes.join("、") : "无",
        offlineNodes.length ? "warn" : "ok"
      );
      pushCloudOpsDetail(
        items,
        "子系统列表",
        subsystems
          .slice(0, 8)
          .map((item) => {
            const name = item?.subsystem || item?.name || item?.id || "";
            const health = item?.health || (item?.nodes?.all_online === true ? "ok" : "");
            return name ? `${name}${health ? `(${health})` : ""}` : "";
          })
          .filter(Boolean)
          .join("、")
      );
      return items;
    }

    if (toolName === "health.autodrive_check" && result && typeof result === "object") {
      const healthSummary = result?.summary || result;
      const checks = result?.checks || {};
      const lidarRefs = result?.status_refs?.lidar_topics || {};
      const ready = getCloudOpsValue(healthSummary, [
        "ready_to_patrol",
        "can_start_patrol",
        "all_ok",
        "pass",
        "ready"
      ]);
      const localizationOk = getCloudOpsValue(healthSummary, [
        "localization_ok",
        "localization_reliable",
        "localization.reliable"
      ]);
      const ultrasonicStop = getCloudOpsValue(healthSummary, [
        "ultrasonic_stop",
        "ultrasonic_stop_triggered"
      ]);
      const collisionStop = getCloudOpsValue(healthSummary, [
        "collision_stop",
        "collision_stop_triggered",
        "bumper_stop"
      ]);
      const estop = getCloudOpsValue(healthSummary, [
        "estop",
        "emergency_stop",
        "emergency_stop_triggered"
      ]);
      const keyNodesOk = getCloudOpsValue(healthSummary, ["key_nodes_ok", "key_nodes.all_online"]);
      const routingOk = getCloudOpsValue(healthSummary, [
        "routing_ok",
        "has_available_route",
        "routing_available"
      ]);
      pushCloudOpsDetail(
        items,
        "综合结论",
        ready === true ? "可以启航" : ready === false ? "需要排查" : result?.health || "-",
        ready === true ? "ok" : ready === false ? "warn" : "idle"
      );
      pushCloudOpsDetail(
        items,
        "急停 / 碰撞停 / 超声停",
        `${formatCloudOpsBool(estop, "触发", "正常")} / ${formatCloudOpsBool(
          collisionStop,
          "触发",
          "正常"
        )} / ${formatCloudOpsBool(ultrasonicStop, "触发", "正常")}`,
        estop || collisionStop || ultrasonicStop ? "warn" : "ok"
      );
      pushCloudOpsDetail(
        items,
        "定位 / 关键节点 / 路线",
        `${formatCloudOpsBool(localizationOk, "可靠", "异常")} / ${formatCloudOpsBool(
          keyNodesOk,
          "正常",
          "异常"
        )} / ${formatCloudOpsBool(routingOk, "可用", "不可用")}`,
        localizationOk === false || keyNodesOk === false || routingOk === false ? "warn" : "ok"
      );
      const lidarTopicChecks = [
        ["前激光", checks?.front_laser_topic_output?.ok],
        ["后激光", checks?.back_laser_topic_output?.ok],
        ["顶激光", checks?.top_lidar_topic_output?.ok]
      ].filter(([, value]) => value !== undefined);
      if (lidarTopicChecks.length) {
        pushCloudOpsDetail(
          items,
          "激光 Topic 检查",
          lidarTopicChecks
            .map(([label, value]) => `${label}${formatCloudOpsBool(value, "正常", "异常", "未知")}`)
            .join(" / "),
          lidarTopicChecks.some(([, value]) => value === false) ? "warn" : "ok"
        );
      }
      const lidarTopics =
        lidarRefs && typeof lidarRefs?.topics === "object"
          ? Object.entries(lidarRefs.topics)
              .map(([key, value]) => `${key}:${value}`)
              .join("、")
          : "-";
      if (lidarRefs?.ready !== undefined || lidarTopics !== "-") {
        pushCloudOpsDetail(
          items,
          "激光 Topic 汇总",
          `${formatCloudOpsBool(lidarRefs?.ready, "已就绪", "未就绪")} / ${lidarTopics}`,
          lidarRefs?.ready === false ? "warn" : "ok"
        );
      }
      return items;
    }

    if (toolName === "route.list") {
      const routes = getCloudOpsListFromResult(result);
      pushCloudOpsDetail(items, "路线数量", `${routes.length}`, "ok");
      pushCloudOpsDetail(
        items,
        "路线列表",
        routes
          .slice(0, 8)
          .map((item) => item?.route_id || item?.name || item?.path_id || "")
          .filter(Boolean)
          .join("、")
      );
      return items;
    }

    if (toolName === "status.routing" && result && typeof result === "object") {
      const routes = getCloudOpsListFromResult(result);
      pushCloudOpsDetail(
        items,
        "可用路线",
        `${getCloudOpsValue(result, ["available_route_count", "route_count"], routes.length)}`,
        "ok"
      );
      pushCloudOpsDetail(
        items,
        "当前路线",
        getCloudOpsValue(result, ["current_route_id", "active_route_id", "summary.current_route_id"], "-"),
        "ok"
      );
      pushCloudOpsDetail(
        items,
        "routing 状态",
        getCloudOpsValue(result, ["state", "summary.state", "status", "health"], "-"),
        "ok"
      );
      pushCloudOpsDetail(
        items,
        "路线列表",
        routes
          .slice(0, 8)
          .map((item) => item?.route_id || item?.name || item?.id || "")
          .filter(Boolean)
          .join("、")
      );
      return items;
    }

    if (toolName === "route.detail" && result && typeof result === "object") {
      pushCloudOpsDetail(
        items,
        "路线编号",
        result?.route_id || result?.name || execution?.request?.args?.route_id || "-",
        "ok"
      );
      pushCloudOpsDetail(items, "路径长度", result?.length ?? result?.len ?? "-", "ok");
      pushCloudOpsDetail(items, "采样点数", result?.point_count ?? result?.sampled_point_count ?? "-", "ok");
      return items;
    }

    if (toolName === "route.start_patrol") {
      pushCloudOpsDetail(
        items,
        "路线编号",
        execution?.request?.args?.route_id ||
          (Array.isArray(execution?.request?.args?.route_ids)
            ? execution.request.args.route_ids.join("、")
            : "-"),
        "ok"
      );
      pushCloudOpsDetail(items, "执行模式", execution?.request?.args?.dry_run ? "预演 dry-run" : "正式执行");
      pushCloudOpsDetail(items, "圈数 / 速度", `${execution?.request?.args?.loops ?? "-"} 圈 / ${execution?.request?.args?.speed_kph ?? "-"} km/h`);
      return items;
    }

    if (toolName === "route.stop_patrol") {
      pushCloudOpsDetail(items, "执行状态", "已发送停止巡逻请求", "ok");
      pushCloudOpsDetail(items, "执行模式", execution?.request?.args?.dry_run ? "预演 dry-run" : "正式执行");
      return items;
    }

    if (toolName === "camera.capture" && result && typeof result === "object") {
      const mediaItems = extractCloudOpsMediaItems(payload);
      const captures = Array.isArray(result?.captures) ? result.captures : [];
      const captureCount = Number(result?.capture_count) || captures.length || mediaItems.length || 0;
      pushCloudOpsDetail(items, "抓拍结果", `${captureCount} 张`, captureCount ? "ok" : "warn");
      pushCloudOpsDetail(
        items,
        "相机列表",
        captures
          .map((item) => item?.camera || item?.requested || item?.name || "")
          .filter(Boolean)
          .join("、") ||
          mediaItems.map((item) => item.label).filter(Boolean).join("、") ||
          "-"
      );
      pushCloudOpsDetail(
        items,
        "抓拍时间",
        formatIsoTimestamp(getCloudOpsValue(result, ["generated_at", "captured_at", "ts"], "-")),
        "ok"
      );
      if (captureCount && !mediaItems.length) {
        pushCloudOpsDetail(
          items,
          "图像展示",
          "当前返回了抓拍元数据，但没有可直接展示的图片内容",
          "warn"
        );
      }
      return items;
    }

    if (toolName === "ai_detection.config" && result && typeof result === "object") {
      const events = Array.isArray(result?.events) ? result.events : [];
      const openEvents = Array.isArray(result?.events_open) ? result.events_open : [];
      const closedEvents = Array.isArray(result?.events_closed) ? result.events_closed : [];
      pushCloudOpsDetail(items, "服务位置", result?.service_position || "-", "ok");
      pushCloudOpsDetail(
        items,
        "检测间隔 / 人群阈值",
        `${result?.interval_s ?? "-"}s / ${result?.crowd_N ?? "-"}`,
        "ok"
      );
      pushCloudOpsDetail(
        items,
        "Qwen校验",
        result?.qwen?.enabled ? `开启 (${result?.qwen?.mode || "-"})` : "关闭",
        result?.qwen?.enabled ? "ok" : "warn"
      );
      pushCloudOpsDetail(items, "事件总数", `${events.length}`, "ok");
      pushCloudOpsDetail(
        items,
        "启用事件",
        openEvents.length ? `${openEvents.length} 项：${openEvents.slice(0, 12).join("、")}` : "无",
        openEvents.length ? "ok" : "warn"
      );
      pushCloudOpsDetail(
        items,
        "关闭事件",
        closedEvents.length ? closedEvents.join("、") : "无",
        closedEvents.length ? "warn" : "ok"
      );
      return items;
    }

    if (toolName === "ai_detection.images" && result && typeof result === "object") {
      const mediaItems = extractCloudOpsMediaItems(payload);
      const images = Array.isArray(result?.images) ? result.images : [];
      pushCloudOpsDetail(
        items,
        "落盘图片",
        `${mediaItems.length || images.length || 0} 张`,
        mediaItems.length || images.length ? "ok" : "warn"
      );
      pushCloudOpsDetail(
        items,
        "目录总数",
        `${result?.total_files ?? images.length ?? 0}`,
        "ok"
      );
      pushCloudOpsDetail(
        items,
        "图片目录",
        result?.save_path || "-",
        "ok"
      );
      if (!mediaItems.length && !images.length) {
        pushCloudOpsDetail(items, "当前状态", "目录为空，暂未触发事件落盘", "warn");
      }
      return items;
    }

    if (toolName === "map.preview" && result && typeof result === "object") {
      const extent = result?.map?.extent || {};
      const vehiclePose = result?.vehicle_pose || {};
      pushCloudOpsDetail(
        items,
        "地图状态",
        String(result?.health || result?.status || "-"),
        result?.health === "ok" ? "ok" : result?.health === "error" ? "error" : "warn"
      );
      if (Number.isFinite(extent?.width_m) && Number.isFinite(extent?.height_m)) {
        pushCloudOpsDetail(
          items,
          "地图尺寸",
          `${formatCloudOpsNumber(extent.width_m, 2)}m × ${formatCloudOpsNumber(extent.height_m, 2)}m`,
          "ok"
        );
      }
      pushCloudOpsDetail(
        items,
        "定位来源",
        vehiclePose?.source || "-",
        vehiclePose?.reliable === false ? "warn" : "ok"
      );
      pushCloudOpsDetail(
        items,
        "车辆叠加",
        vehiclePose?.draw_vehicle === true ? "已叠加" : "未叠加",
        vehiclePose?.draw_vehicle === true ? "ok" : "warn"
      );
      pushCloudOpsDetail(
        items,
        "定位可靠性",
        formatCloudOpsBool(vehiclePose?.reliable, "可靠", "不可靠"),
        getCloudOpsTone(vehiclePose?.reliable)
      );
      if (vehiclePose?.position && typeof vehiclePose.position === "object") {
        pushCloudOpsDetail(
          items,
          "当前位置",
          `x=${formatCloudOpsNumber(vehiclePose.position?.x, 2)}, y=${formatCloudOpsNumber(
            vehiclePose.position?.y,
            2
          )}`,
          "ok"
        );
      }
      if (Number.isFinite(vehiclePose?.heading)) {
        pushCloudOpsDetail(
          items,
          "车头朝向",
          `${formatCloudOpsNumber(vehiclePose.heading, 3)} rad`,
          "ok"
        );
      }
      pushCloudOpsDetail(
        items,
        "地图文件",
        result?.map?.path || "-",
        "ok"
      );
      pushCloudOpsDetail(
        items,
        "生成时间",
        formatIsoTimestamp(getCloudOpsValue(result, ["generated_at", "ts"], "-")),
        "ok"
      );
      return items;
    }

    if (toolName === "camera.upload_chain" && result && typeof result === "object") {
      const overall = getCloudOpsValue(result, ["health", "summary.health", "status"], "-");
      const driverOk = getCloudOpsValue(result, [
        "gmsl_camera.ok",
        "gmsl_camera.online",
        "summary.gmsl_camera_ok"
      ]);
      const monitorOk = getCloudOpsValue(result, [
        "camera_monitor.ok",
        "camera_monitor.online",
        "summary.camera_monitor_ok"
      ]);
      const uploadOk = getCloudOpsValue(result, [
        "upload_target.ok",
        "mqtt.ok",
        "summary.upload_ok"
      ]);
      pushCloudOpsDetail(
        items,
        "链路总体",
        String(overall || "-"),
        overall === "ok" ? "ok" : overall === "error" ? "error" : "warn"
      );
      pushCloudOpsDetail(
        items,
        "驱动 / 监控",
        `${formatCloudOpsBool(driverOk, "正常", "异常")} / ${formatCloudOpsBool(
          monitorOk,
          "正常",
          "异常"
        )}`,
        driverOk === false || monitorOk === false ? "warn" : "ok"
      );
      pushCloudOpsDetail(
        items,
        "上传目标",
        formatCloudOpsBool(uploadOk, "正常", "异常"),
        uploadOk === false ? "warn" : "ok"
      );
      pushCloudOpsDetail(
        items,
        "链路说明",
        getCloudOpsValue(result, ["summary.message", "message", "detail"], "-")
      );
      return items;
    }

    if (toolName === "status.can" && result && typeof result === "object") {
      pushCloudOpsDetail(items, "整车就绪", formatCloudOpsBool(summary?.vehicle_ready, "是", "否"), getCloudOpsTone(summary?.vehicle_ready));
      pushCloudOpsDetail(items, "当前速度", `${formatCloudOpsNumber(summary?.speed)} m/s`);
      pushCloudOpsDetail(items, "电量", `${formatCloudOpsNumber(summary?.battery_soc)}%`, "ok");
      pushCloudOpsDetail(
        items,
        "急停 / 碰撞停",
        `${formatCloudOpsBool(summary?.emergency_stop_pressed, "已触发", "正常")} / ${formatCloudOpsBool(
          summary?.collision_stop,
          "已触发",
          "正常"
        )}`,
        summary?.emergency_stop_pressed || summary?.collision_stop ? "error" : "ok"
      );
      pushCloudOpsDetail(
        items,
        "故障灯",
        Array.isArray(summary?.fault_lamps_on) && summary.fault_lamps_on.length ? summary.fault_lamps_on.join("、") : "无",
        Array.isArray(summary?.fault_lamps_on) && summary.fault_lamps_on.length ? "warn" : "ok"
      );
      pushCloudOpsDetail(items, "手柄接管", formatCloudOpsBool(summary?.joystick_takeover, "接管中", "未接管"), getCloudOpsTone(!summary?.joystick_takeover));
      return items;
    }

    if (toolName === "status.body_control" && result && typeof result === "object") {
      const bodySummary = result?.summary || {};
      const vehicleState = bodySummary?.vehicle_state || {};
      const planningIntent = bodySummary?.planning_intent || {};
      const controlCommand = bodySummary?.control_command || {};
      const vehicleFeedback = bodySummary?.vehicle_feedback || {};
      const mismatchFlags = bodySummary?.mismatch_flags || {};
      const mismatchLabels = {
        ad_screen: "广告屏",
        front_lamp: "前照灯",
        mood_lamp: "氛围灯",
        steer_lamp: "转向灯"
      };
      const mismatches = Object.entries(mismatchFlags)
        .filter(([, value]) => value === true)
        .map(([key]) => mismatchLabels[key] || key);

      pushCloudOpsDetail(
        items,
        "车速 / 就绪",
        `${formatCloudOpsNumber(vehicleState?.speed_kph, 2)} km/h / ${formatCloudOpsBool(
          vehicleState?.ready,
          "就绪",
          "未就绪"
        )}`,
        getCloudOpsTone(vehicleState?.ready)
      );
      pushCloudOpsDetail(
        items,
        "广告屏",
        formatCloudOpsBodyStateTriplet(
          planningIntent?.ad_screen,
          controlCommand?.ad_screen,
          vehicleFeedback?.ad_screen_on
        ),
        mismatchFlags?.ad_screen ? "warn" : "ok"
      );
      pushCloudOpsDetail(
        items,
        "前照灯",
        formatCloudOpsBodyStateTriplet(
          planningIntent?.front_lamp,
          controlCommand?.front_lamp,
          vehicleFeedback?.front_lamp_on
        ),
        mismatchFlags?.front_lamp ? "warn" : "ok"
      );
      pushCloudOpsDetail(
        items,
        "氛围灯",
        formatCloudOpsBodyStateTriplet(
          planningIntent?.mood_lamp,
          controlCommand?.mood_lamp,
          vehicleFeedback?.mood_lamp_on
        ),
        mismatchFlags?.mood_lamp ? "warn" : "ok"
      );
      pushCloudOpsDetail(
        items,
        "转向灯",
        `指令 ${formatCloudOpsSteerLampMode(controlCommand?.steer_lamp_mode)} / 反馈 ${formatCloudOpsSteerLampMode(
          vehicleFeedback?.steer_lamp_mode
        )}`,
        mismatchFlags?.steer_lamp ? "warn" : "ok"
      );
      pushCloudOpsDetail(
        items,
        "不一致项",
        mismatches.length ? mismatches.join("、") : "无",
        mismatches.length ? "warn" : "ok"
      );
      pushCloudOpsDetail(
        items,
        "可控项",
        Array.isArray(bodySummary?.available_controls)
          ? bodySummary.available_controls.join("、")
          : "-",
        "ok"
      );
      return items;
    }

    if (toolName === "vehicle.body_control" && result && typeof result === "object") {
      const status = String(result?.status || "").trim().toLowerCase();
      const request = result?.request || {};
      const beforeSummary = result?.before?.summary || {};
      const afterSummary = result?.after?.summary || {};
      const requestedItems = [];
      if (request?.ad_screen !== null && request?.ad_screen !== undefined) {
        requestedItems.push(`广告屏 ${formatCloudOpsSwitchState(request.ad_screen)}`);
      }
      if (request?.front_lamp !== null && request?.front_lamp !== undefined) {
        requestedItems.push(`前照灯 ${formatCloudOpsSwitchState(request.front_lamp)}`);
      }
      if (request?.mood_lamp !== null && request?.mood_lamp !== undefined) {
        requestedItems.push(`氛围灯 ${formatCloudOpsSwitchState(request.mood_lamp)}`);
      }
      if (request?.steer_lamp_mode || request?.steer_lamp) {
        requestedItems.push(
          `转向灯 ${formatCloudOpsSteerLampMode(request?.steer_lamp_mode || request?.steer_lamp)}`
        );
      }
      const stateTone =
        status === "applied"
          ? "ok"
          : status === "partial" || status === "noop"
            ? "warn"
            : status === "error"
              ? "error"
              : "idle";
      const afterVehicleState = afterSummary?.vehicle_state || {};

      pushCloudOpsDetail(
        items,
        "执行结果",
        status === "applied"
          ? "已执行"
          : status === "partial"
            ? "部分确认"
            : status === "noop"
              ? "状态未变化"
              : status === "error"
                ? "执行失败"
                : status || "-",
        stateTone
      );
      pushCloudOpsDetail(
        items,
        "请求内容",
        requestedItems.length ? requestedItems.join(" / ") : "未识别到具体控制项",
        requestedItems.length ? "ok" : "warn"
      );
      pushCloudOpsDetail(
        items,
        "安全约束",
        `${request?.require_stationary === false ? "允许移动中执行" : "要求静止执行"} / ${
          request?.stop_patrol_first ? "先停巡逻" : "不额外停巡逻"
        }`,
        request?.require_stationary === false ? "warn" : "ok"
      );
      pushCloudOpsDetail(
        items,
        "执行前反馈",
        formatCloudOpsBodyFeedbackSummary(beforeSummary),
        "ok"
      );
      pushCloudOpsDetail(
        items,
        "执行后反馈",
        formatCloudOpsBodyFeedbackSummary(afterSummary),
        stateTone
      );
      pushCloudOpsDetail(
        items,
        "车速 / 碰撞停",
        `${formatCloudOpsNumber(afterVehicleState?.speed_kph, 2)} km/h / ${formatCloudOpsBool(
          afterVehicleState?.collision_stop,
          "触发",
          "正常"
        )}`,
        afterVehicleState?.collision_stop ? "warn" : "ok"
      );
      pushCloudOpsDetail(
        items,
        "说明",
        result?.message || result?.detail || "-",
        stateTone === "error" ? "error" : "idle"
      );
      return items;
    }

    if (toolName === "vehicle.clear_collision_stop" && result && typeof result === "object") {
      const status = String(getCloudOpsValue(result, ["status", "summary.status"], "-")).trim();
      const statusTone = status === "cleared" ? "ok" : status === "noop" ? "warn" : status === "error" ? "error" : "idle";
      const collisionAfter = getCloudOpsValue(result, [
        "collision_stop_after",
        "summary.collision_stop_after",
        "collision_stop"
      ]);
      const speedAfter = getCloudOpsValue(result, [
        "speed_after_kph",
        "summary.speed_after_kph",
        "final_speed_kph",
        "speed_kph"
      ]);
      const verifiedStopped = getCloudOpsValue(result, [
        "verified_stopped",
        "summary.verified_stopped",
        "stop_verified"
      ]);
      const stopPatrolFirst = execution?.request?.args?.stop_patrol_first;
      pushCloudOpsDetail(
        items,
        "执行结果",
        status === "cleared" ? "已复位" : status === "noop" ? "无需复位" : status === "error" ? "复位失败" : status || "-",
        statusTone
      );
      pushCloudOpsDetail(
        items,
        "安全序列",
        stopPatrolFirst === false ? "未要求先停巡逻" : "先停巡逻再复位",
        stopPatrolFirst === false ? "warn" : "ok"
      );
      pushCloudOpsDetail(
        items,
        "碰撞停状态",
        collisionAfter === true ? "仍然触发" : collisionAfter === false ? "已解除" : "-",
        collisionAfter === true ? "error" : collisionAfter === false ? "ok" : "idle"
      );
      if (speedAfter !== undefined && speedAfter !== null && speedAfter !== "") {
        pushCloudOpsDetail(items, "复位后车速", `${formatCloudOpsNumber(speedAfter, 2)} km/h`, Number(speedAfter) <= 0.1 ? "ok" : "warn");
      }
      pushCloudOpsDetail(
        items,
        "静止复核",
        formatCloudOpsBool(verifiedStopped, "通过", "未通过"),
        verifiedStopped === false ? "warn" : getCloudOpsTone(verifiedStopped)
      );
      pushCloudOpsDetail(
        items,
        "说明",
        getCloudOpsValue(result, ["message", "detail", "summary.message", "reason"], "-"),
        statusTone === "error" ? "error" : "idle"
      );
      return items;
    }

    if (toolName === "status.camera" && result && typeof result === "object") {
      const cameras = Array.isArray(result?.cameras) ? result.cameras : [];
      const ages = cameras
        .map((item) => Number(item?.message_age_s))
        .filter((value) => Number.isFinite(value));
      pushCloudOpsDetail(
        items,
        "在线相机",
        `${result?.online_camera_count ?? 0} / ${result?.expected_camera_count ?? cameras.length}`,
        Number(result?.online_camera_count) === Number(result?.expected_camera_count) ? "ok" : "warn"
      );
      pushCloudOpsDetail(
        items,
        "离线相机",
        Array.isArray(result?.offline_cameras) && result.offline_cameras.length ? result.offline_cameras.join("、") : "无",
        Array.isArray(result?.offline_cameras) && result.offline_cameras.length ? "warn" : "ok"
      );
      if (ages.length) {
        pushCloudOpsDetail(
          items,
          "图像时延",
          `${Math.round(Math.min(...ages) * 1000)} ~ ${Math.round(Math.max(...ages) * 1000)} ms`
        );
      }
      pushCloudOpsDetail(
        items,
        "相机列表",
        cameras
          .map((item) => item?.camera || "")
          .filter(Boolean)
          .join("、")
      );
      return items;
    }

    if (toolName === "status.localization" && result && typeof result === "object") {
      pushCloudOpsDetail(
        items,
        "定位可靠性",
        formatCloudOpsBool(summary?.reliable, "可靠", "不可靠"),
        getCloudOpsTone(summary?.reliable)
      );
      if (summary?.position && typeof summary.position === "object") {
        pushCloudOpsDetail(
          items,
          "当前位置",
          `x=${formatCloudOpsNumber(summary.position?.x, 2)}, y=${formatCloudOpsNumber(
            summary.position?.y,
            2
          )}, z=${formatCloudOpsNumber(summary.position?.z, 2)}`
        );
      }
      pushCloudOpsDetail(items, "航向 / 速度", `${formatCloudOpsNumber(summary?.heading, 2)} rad / ${formatCloudOpsNumber(summary?.speed_mps, 3)} m/s`);
      if (Number.isFinite(summary?.latitude) && Number.isFinite(summary?.longitude)) {
        pushCloudOpsDetail(
          items,
          "经纬度",
          `${formatCloudOpsNumber(summary.latitude, 6)}, ${formatCloudOpsNumber(summary.longitude, 6)}`
        );
      }
      pushCloudOpsDetail(items, "诊断等级", `${summary?.max_diagnostics_level ?? "-"}`);
      return items;
    }

    if (toolName === "status.planning" && result && typeof result === "object") {
      pushCloudOpsDetail(
        items,
        "规划状态",
        `planner_state=${summary?.planner_state ?? "-"} / running=${summary?.planner_running ?? "-"}`,
        "ok"
      );
      pushCloudOpsDetail(
        items,
        "场景 / 动作",
        `${summary?.current_scenario ?? "-"} / ${summary?.current_action ?? "-"}`
      );
      pushCloudOpsDetail(
        items,
        "轨迹",
        `${summary?.trajectory_point_count ?? "-"} 点 / estop=${summary?.trajectory_estop === true ? "true" : "false"} / gear=${summary?.trajectory_gear ?? "-"}`
      );
      pushCloudOpsDetail(
        items,
        "循环进度",
        `${summary?.current_loop_index ?? 0} / ${summary?.total_loop_sum ?? 0}`
      );
      pushCloudOpsDetail(
        items,
        "参考线进度",
        `${summary?.current_refline_index ?? 0} / ${summary?.total_refline_sum ?? 0}`
      );
      if (summary?.distance_to_slope_valid) {
        pushCloudOpsDetail(
          items,
          "坡道信息",
          `distance=${formatCloudOpsNumber(summary?.distance_to_slope, 2)} / slope=${formatCloudOpsNumber(summary?.slope, 2)}`
        );
      }
      return items;
    }

    if (toolName === "status.control" && result && typeof result === "object") {
      const requiredInputs = summary?.required_inputs || {};
      const missingInputs = Object.entries(requiredInputs)
        .filter(([, value]) => value === false)
        .map(([key]) => key);
      pushCloudOpsDetail(
        items,
        "控制输入",
        missingInputs.length ? `缺少 ${missingInputs.join("、")}` : "输入齐全",
        missingInputs.length ? "warn" : "ok"
      );
      pushCloudOpsDetail(items, "目标速度 / 档位", `${formatCloudOpsNumber(summary?.target_speed)} m/s / gear=${summary?.gear_cmd ?? "-"}`);
      pushCloudOpsDetail(
        items,
        "转向角",
        `front=${summary?.front_steering_angle ?? "-"} / rear=${summary?.rear_steering_angle ?? "-"}`
      );
      pushCloudOpsDetail(
        items,
        "超声停车",
        formatCloudOpsBool(summary?.ultrasonic_stop === 1 || summary?.ultrasonic_stop === true, "已触发", "未触发"),
        summary?.ultrasonic_stop === 1 || summary?.ultrasonic_stop === true ? "warn" : "ok"
      );
      return items;
    }

    if (toolName === "status.obstacle_processor" && result && typeof result === "object") {
      const obstacleSummary = result?.summary || result;
      const inputs = getCloudOpsValue(obstacleSummary, ["lidar_inputs", "inputs"], {});
      const missingInputs =
        inputs && typeof inputs === "object"
          ? Object.entries(inputs)
              .filter(([, value]) => value === false)
              .map(([key]) => key)
          : [];
      pushCloudOpsDetail(
        items,
        "处理状态",
        String(getCloudOpsValue(obstacleSummary, ["health", "status", "state"], "-")),
        missingInputs.length ? "warn" : "ok"
      );
      pushCloudOpsDetail(
        items,
        "融合目标",
        `${getCloudOpsValue(obstacleSummary, ["fusion_object_count", "object_count"], 0)}`,
        "ok"
      );
      pushCloudOpsDetail(
        items,
        "激光输入",
        missingInputs.length ? `缺少 ${missingInputs.join("、")}` : "全部在线",
        missingInputs.length ? "warn" : "ok"
      );
      pushCloudOpsDetail(
        items,
        "心跳 / 说明",
        getCloudOpsValue(obstacleSummary, ["heartbeat", "heartbeat_ok", "detail"], "-")
      );
      return items;
    }

    if (toolName === "obstacle.preview" && result && typeof result === "object") {
      const preview = result?.preview || {};
      const obstacleSummary = result?.summary || {};
      const obstacles = Array.isArray(result?.obstacles) ? result.obstacles : [];
      pushCloudOpsDetail(
        items,
        "预览状态",
        String(result?.health || result?.status || "ok"),
        result?.health === "error" ? "error" : "ok"
      );
      pushCloudOpsDetail(
        items,
        "障碍物数量",
        `${obstacleSummary?.object_count ?? obstacles.length ?? 0}`,
        "ok"
      );
      pushCloudOpsDetail(
        items,
        "已绘制数量",
        `${obstacleSummary?.drawn_obstacle_count ?? obstacleSummary?.drawn_count ?? obstacles.length ?? 0}`,
        "ok"
      );
      pushCloudOpsDetail(
        items,
        "来源话题 / 坐标系",
        `${obstacleSummary?.topic || result?.topic || "-"} / ${obstacleSummary?.frame_id || result?.frame_id || "-"}`,
        "ok"
      );
      pushCloudOpsDetail(
        items,
        "预览图像",
        preview?.data_base64 ? "已生成，可直接查看" : preview?.saved_file || preview?.saved_path || "未返回图像",
        preview?.data_base64 ? "ok" : "warn"
      );
      return items;
    }

    if (toolName === "status.perception" && result && typeof result === "object") {
      const lidarInputs = summary?.lidar_inputs || {};
      const missingInputs = Object.entries(lidarInputs)
        .filter(([, value]) => value === false)
        .map(([key]) => key);
      pushCloudOpsDetail(items, "融合目标数", `${summary?.fusion_object_count ?? 0}`, "ok");
      pushCloudOpsDetail(items, "人群数量", `${summary?.crowd_people ?? 0}`);
      pushCloudOpsDetail(items, "挥手目标", `${summary?.handwave_object_count ?? 0}`);
      pushCloudOpsDetail(
        items,
        "激光输入",
        missingInputs.length ? `缺少 ${missingInputs.join("、")}` : "全部在线",
        missingInputs.length ? "warn" : "ok"
      );
      return items;
    }

    const listItems = getCloudOpsListFromResult(result);
    if (listItems.length) {
      pushCloudOpsDetail(items, "返回数量", `${listItems.length}`, "ok");
      pushCloudOpsDetail(
        items,
        "前几项",
        listItems
          .slice(0, 6)
          .map((item) => item?.name || item?.route_id || item?.topic || item?.node || item?.service || "")
          .filter(Boolean)
          .join("、")
      );
    }

    return items;
  }

  function renderCloudOpsResultDetails(payload) {
    if (!cloudOpsResultDetails) return;
    const items = buildCloudOpsResultDetails(payload);
    cloudOpsResultDetails.innerHTML = "";

    if (!items.length) {
      return;
    }

    items.slice(0, 12).forEach((item) => {
      const card = createNode("article", "cloud-ops-result-card");
      card.appendChild(createNode("p", "cloud-ops-result-card-label", item.label));
      const value = createNode("p", "cloud-ops-result-card-value", item.value);
      value.dataset.tone = item.tone || "idle";
      card.appendChild(value);
      cloudOpsResultDetails.appendChild(card);
    });
  }

  function updateCloudOpsActionAvailability() {
    const vehicleSelected = Boolean(cloudOpsCurrentVehicleId);
    const availableNames = cloudOpsAvailableTools;
    const hasToolCatalog = availableNames.size > 0;
    let unsupported = [];

    cloudOpsActionButtons.forEach((button) => {
      const needsVehicle = button.dataset.needsVehicle === "true";
      const requiredTool = button.dataset.requiresTool || "";
      const supported = !requiredTool || !hasToolCatalog || availableNames.has(requiredTool);
      const needsAuth = isCloudOpsControlButton(button);
      button.dataset.supported = supported ? "yes" : "no";
      button.dataset.accessState = needsAuth ? "control" : "read";
      button.disabled =
        cloudOpsBusy ||
        (needsVehicle && !vehicleSelected) ||
        !supported ||
        (needsAuth && !cloudOpsAuthenticated);
      if (!supported && requiredTool) {
        unsupported.push(formatCloudOpsToolName(requiredTool));
      }
    });

    if (cloudOpsToolNote) {
      if (!cloudOpsCurrentVehicleId) {
        cloudOpsToolNote.textContent = "请先选择在线车辆，再执行上面的运维按钮。";
      } else if (!hasToolCatalog) {
        cloudOpsToolNote.textContent = "当前还没拿到工具列表，已先按默认按钮展示；如果某个动作返回 unknown tool 或超时，再按车端实际能力排查。";
      } else if (unsupported.length) {
        cloudOpsToolNote.textContent = `当前车辆 ${cloudOpsCurrentVehicleId} 已上报 ${cloudOpsAvailableTools.size} 个工具；${unsupported.slice(0, 6).join("、")} 这类按钮现在置灰，表示车端暂不支持。`;
      } else if (!cloudOpsAuthenticated) {
        cloudOpsToolNote.textContent = `当前车辆 ${cloudOpsCurrentVehicleId} 的已上报工具数为 ${cloudOpsAvailableTools.size}。未登录可查看状态类按钮；登录获取更多控制权限。`;
      } else {
        cloudOpsToolNote.textContent = `当前车辆 ${cloudOpsCurrentVehicleId} 的已上报工具数为 ${cloudOpsAvailableTools.size}，上方按钮均可直接执行。`;
      }
    }

    updateCloudOpsAudioAvailability();
  }

  function renderCloudOpsResult(summary, payload, state = "idle") {
    if (cloudOpsResultSummary) {
      cloudOpsResultSummary.textContent = summary || "暂无结果。";
      cloudOpsResultSummary.dataset.state = state;
    }
    renderCloudOpsResultDetails(payload);
    renderCloudOpsResultMedia(payload);
    if (cloudOpsResultJson) {
      cloudOpsResultJson.textContent = JSON.stringify(payload ?? {}, null, 2);
    }
  }

  function renderCloudOpsVehicleOptions() {
    if (!cloudOpsVehicleSelect) return;
    cloudOpsVehicleSelect.innerHTML = "";

    if (!cloudOpsVehicles.length) {
      cloudOpsVehicleSelect.appendChild(new Option("暂无在线车辆", ""));
      cloudOpsCurrentVehicleId = "";
      return;
    }

    const ids = cloudOpsVehicles
      .map((vehicle) => String(vehicle?.vehicle_id || vehicle?.plate_number || "").trim())
      .filter(Boolean);
    if (!ids.includes(cloudOpsCurrentVehicleId)) {
      cloudOpsCurrentVehicleId = ids[0] || "";
    }

    ids.forEach((id) => {
      cloudOpsVehicleSelect.appendChild(new Option(id, id));
    });
    cloudOpsVehicleSelect.value = cloudOpsCurrentVehicleId;
  }

  async function fetchJsonOrThrow(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.headers || {})
      }
    });
    const rawText = await response.text();
    let data = null;

    if (rawText) {
      try {
        data = JSON.parse(rawText);
      } catch (_error) {
        throw new Error(response.ok ? "服务返回了无法解析的 JSON" : `HTTP ${response.status}`);
      }
    }

    if (!response.ok) {
      throw new Error(data?.detail || data?.summary || `HTTP ${response.status}`);
    }
    if (!data) {
      throw new Error("服务返回空响应");
    }
    if (!data?.ok) {
      throw new Error(data?.detail || data?.summary || `HTTP ${response.status}`);
    }
    return data;
  }

  async function loadCloudOpsContext(options = {}) {
    if (!cloudOpsShell) return;
    const preserveResult = Boolean(options.preserveResult);
    const silent = Boolean(options.silent);

    try {
      if (!silent) {
        setCloudOpsStatus("加载车辆中...", "loading");
      }
      const vehicleData = await fetchJsonOrThrow(CLOUD_OPS_VEHICLES_URL);
      cloudOpsVehicles = Array.isArray(vehicleData?.vehicles) ? vehicleData.vehicles : [];
      renderCloudOpsVehicleOptions();
      renderCloudOpsSummary();
      renderCloudOpsLiveState();
      updateCloudOpsActionAvailability();

      if (!cloudOpsCurrentVehicleId) {
        cloudOpsAvailableTools = new Set();
        cloudOpsCurrentDetail = null;
        resetAllCloudOpsAudioChannels({ stopPlayback: true });
        renderCloudOpsSummary();
        renderCloudOpsLiveState();
        updateCloudOpsActionAvailability();
        if (!preserveResult) {
          renderCloudOpsResult("当前没有在线车辆。", { vehicles: cloudOpsVehicles }, "idle");
        }
        setCloudOpsStatus("暂无在线车辆", "idle");
        return;
      }

      const vehicleId = cloudOpsCurrentVehicleId;
      const [detailResult, toolListResult] = await Promise.allSettled([
        fetchJsonOrThrow(`${CLOUD_OPS_VEHICLES_URL}/${encodeURIComponent(vehicleId)}`),
        fetchJsonOrThrow(`${CLOUD_OPS_VEHICLES_URL}/${encodeURIComponent(vehicleId)}/tool-list?timeout_s=35`)
      ]);

      const detailData = detailResult.status === "fulfilled" ? detailResult.value : null;
      const toolListData = toolListResult.status === "fulfilled" ? toolListResult.value : null;

      if (detailData) {
        cloudOpsCurrentDetail = detailData;
      }

      if (toolListData) {
        cloudOpsAvailableTools = new Set(
          (Array.isArray(toolListData?.tools) ? toolListData.tools : [])
            .map((tool) => String(tool?.name || "").trim())
            .filter(Boolean)
        );
      } else if (!cloudOpsAvailableTools.size) {
        cloudOpsAvailableTools = new Set();
      }

      renderCloudOpsSummary();
      renderCloudOpsLiveState();
      updateCloudOpsActionAvailability();
      if (!preserveResult) {
        renderCloudOpsResult(
          detailData?.summary ||
            toolListData?.summary ||
            `${cloudOpsCurrentVehicleId} 的基础状态已加载。`,
          {
            vehicle_detail: detailData?.execution || cloudOpsCurrentDetail?.execution || null,
            tool_list: toolListData?.execution || null
          },
          "ok"
        );
      }
      if (detailData || toolListData) {
        if (!silent) {
          setCloudOpsStatus("控制台已就绪", "ok");
        }
      } else {
        throw new Error("vehicle_detail_and_tool_list_unavailable");
      }
    } catch (error) {
      if (!cloudOpsVehicles.length) {
        cloudOpsAvailableTools = new Set();
        cloudOpsCurrentVehicleId = "";
        cloudOpsCurrentDetail = null;
        resetAllCloudOpsAudioChannels({ stopPlayback: true });
      }
      renderCloudOpsSummary();
      renderCloudOpsLiveState();
      updateCloudOpsActionAvailability();
      if (!preserveResult) {
        renderCloudOpsResult(`云端运维控制台加载失败：${error?.message || "未知错误"}`, null, "error");
      }
      setCloudOpsStatus(cloudOpsVehicles.length ? "部分加载失败" : "加载失败", "error");
      if (cloudOpsVehicles.length && cloudOpsCurrentVehicleId && cloudOpsCurrentDetail && !preserveResult) {
        renderCloudOpsResult(
          cloudOpsCurrentDetail?.summary || `${cloudOpsCurrentVehicleId} 的基础状态已加载。`,
          {
            vehicle_detail: cloudOpsCurrentDetail?.execution || null,
            tool_list: null
          },
          "ok"
        );
      }
    }
  }

  function applyCloudOpsAuthState(authenticated, options = {}) {
    cloudOpsAuthenticated = Boolean(authenticated);
    if (cloudOpsAuth) {
      cloudOpsAuth.hidden = cloudOpsAuthenticated;
    }
    if (cloudOpsShell) {
      cloudOpsShell.hidden = false;
    }
    if (cloudOpsLogoutBtn) {
      cloudOpsLogoutBtn.hidden = !cloudOpsAuthenticated;
    }

    if (cloudOpsAuthenticated) {
      setCloudOpsAuthHint(options.username ? `已登录：${options.username}` : "已登录。", "ok");
      setCloudOpsStatus("加载中...", "loading");
      updateCloudOpsAudioAvailability();
    } else {
      resetAllCloudOpsAudioChannels({ stopPlayback: true });
      updateCloudOpsActionAvailability();
      setCloudOpsStatus("只读模式", "idle");
      setCloudOpsAuthHint("未登录可查看状态；登录后可获取更多控制权限。", "idle");
    }

    window.dispatchEvent(
      new CustomEvent("jgzj:cloud-ops-auth", {
        detail: {
          authenticated: cloudOpsAuthenticated,
          username: options.username || ""
        }
      })
    );
  }

  async function refreshCloudOpsAuthStatus() {
    if (!cloudOpsConsole) return;
    try {
      const response = await fetch(OPENCLAW_AUTH_STATUS_URL, {
        headers: { Accept: "application/json" }
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.ok) {
        applyCloudOpsAuthState(false);
        await loadCloudOpsContext();
        applyOpenClawAuthState(false);
        return;
      }
      applyCloudOpsAuthState(true, { username: data.username || "" });
      await loadCloudOpsContext();
      applyOpenClawAuthState(true, { username: data.username || "" });
      await loadOpenClawHealth();
    } catch (_error) {
      applyCloudOpsAuthState(false);
      await loadCloudOpsContext().catch(() => {});
      applyOpenClawAuthState(false);
    }
  }

  async function handleCloudOpsLoginSubmit(event) {
    event.preventDefault();
    const username = cloudOpsUsername?.value.trim() || "";
    const password = cloudOpsPassword?.value || "";

    if (!username || !password) {
      setCloudOpsAuthHint("请输入完整的用户名和密码。", "error");
      return;
    }

    if (cloudOpsLoginBtn) cloudOpsLoginBtn.disabled = true;
    if (cloudOpsUsername) cloudOpsUsername.disabled = true;
    if (cloudOpsPassword) cloudOpsPassword.disabled = true;
    setCloudOpsAuthHint("登录中...", "loading");
    setCloudOpsStatus("验证中...", "loading");

    try {
      const response = await fetch(OPENCLAW_LOGIN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({ username, password })
      });
      const data = await response.json();
      if (!response.ok || !data?.ok) {
        throw new Error("用户名或密码错误");
      }

      if (cloudOpsPassword) {
        cloudOpsPassword.value = "";
      }
      applyCloudOpsAuthState(true, { username: data.username || username });
      await loadCloudOpsContext();
      applyOpenClawAuthState(true, { username: data.username || username });
      await loadOpenClawHealth();
      resetOpenClawConversation();
      focusWithoutScroll(cloudOpsVehicleSelect);
    } catch (error) {
      applyCloudOpsAuthState(false);
      setCloudOpsAuthHint(error?.message || "登录失败。", "error");
      setCloudOpsStatus("需登录", "idle");
    } finally {
      if (cloudOpsLoginBtn) cloudOpsLoginBtn.disabled = false;
      if (cloudOpsUsername) cloudOpsUsername.disabled = false;
      if (cloudOpsPassword) cloudOpsPassword.disabled = false;
    }
  }

  async function handleCloudOpsLogout(event) {
    event.preventDefault();
    await stopAllCloudOpsAudioChannels({ silent: true }).catch(() => {});
    try {
      await fetch(OPENCLAW_LOGOUT_URL, {
        method: "POST",
        headers: { Accept: "application/json" }
      });
    } catch (_error) {
      // Ignore transport errors during logout.
    }
    applyCloudOpsAuthState(false);
    applyOpenClawAuthState(false);
    clearCloudOpsPinnedContexts();
    await loadCloudOpsContext({ preserveResult: true, silent: true }).catch(() => {});
    if (cloudOpsPassword) {
      cloudOpsPassword.value = "";
    }
    focusWithoutScroll(cloudOpsUsername);
  }

  async function executeCloudOpsAudioToolCall(vehicleId, toolName, args, timeout_s = 15) {
    return await fetchJsonOrThrow(CLOUD_OPS_EXECUTE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        action: "tool_call",
        vehicle_id: vehicleId,
        tool_name: toolName,
        args,
        timeout_s,
        request_id: `web-${createNonce()}`
      })
    });
  }

  async function startCloudOpsAudioChannel(channel) {
    await ensureCloudOpsAudioContext();

    const vehicleId = cloudOpsCurrentVehicleId;
    const streamId = createCloudOpsAudioStreamId(channel.toolName);
    const stream = createCloudOpsAudioStream(channel, streamId, vehicleId);
    cloudOpsAudioStreams.set(streamId, stream);
    channel.streamId = streamId;
    channel.vehicleId = vehicleId;
    channel.phase = "starting";
    channel.errorText = "";
    updateCloudOpsAudioAvailability();

    try {
      await executeCloudOpsAudioToolCall(
        vehicleId,
        channel.toolName,
        {
          enable: true,
          duration_s: CLOUD_OPS_AUDIO_DEFAULT_DURATION_S,
          chunk_ms: CLOUD_OPS_AUDIO_DEFAULT_CHUNK_MS,
          stream_id: streamId
        },
        15
      );
      renderCloudOpsResult(
        `已请求${channel.label}，音频到达后会自动播放。`,
        {
          audio: {
            vehicle_id: vehicleId,
            tool: channel.toolName,
            label: channel.label,
            stream_id: streamId,
            state: "等待音频",
            tone: "warn"
          }
        },
        "ok"
      );
      setCloudOpsStatus("等待音频流", "loading");
      setCloudOpsAudioStatus(`${channel.label}请求已发送`, "loading");
    } catch (error) {
      releaseCloudOpsAudioChannel(channel, { stopPlayback: true, phase: "idle" });
      setCloudOpsAudioStatus(error?.message || `${channel.label}启动失败`, "error");
      throw error;
    }
  }

  async function stopCloudOpsAudioChannel(channel, options = {}) {
    const vehicleId = String(options.vehicleId || channel.vehicleId || cloudOpsCurrentVehicleId || "").trim();
    const streamId = channel.streamId;
    channel.phase = "stopping";
    updateCloudOpsAudioAvailability();

    try {
      if (vehicleId) {
        await executeCloudOpsAudioToolCall(vehicleId, channel.toolName, { enable: false }, 12);
      }
    } finally {
      releaseCloudOpsAudioChannel(channel, { stopPlayback: true, phase: "idle" });
      updateCloudOpsAudioAvailability();
    }

    if (!options.silent) {
      renderCloudOpsResult(
        `已停止${channel.label}。`,
        {
          audio: {
            vehicle_id: vehicleId,
            tool: channel.toolName,
            label: channel.label,
            stream_id: streamId,
            state: "已停止",
            tone: "ok"
          }
        },
        "ok"
      );
      setCloudOpsStatus("音频已停止", "ok");
      setCloudOpsAudioStatus(`${channel.label}已停止`, "idle");
    }
  }

  function sendCloudOpsAudioStopKeepalive(channel, vehicleId) {
    const targetVehicleId = String(vehicleId || channel?.vehicleId || "").trim();
    if (!channel || !targetVehicleId) {
      return;
    }

    const body = JSON.stringify({
      action: "tool_call",
      vehicle_id: targetVehicleId,
      tool_name: channel.toolName,
      args: { enable: false },
      timeout_s: 12,
      request_id: `web-${createNonce()}`
    });

    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: "application/json" });
      navigator.sendBeacon(CLOUD_OPS_EXECUTE_URL, blob);
      return;
    }

    fetch(CLOUD_OPS_EXECUTE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body,
      keepalive: true
    }).catch(() => {});
  }

  async function stopAllCloudOpsAudioChannels(options = {}) {
    for (const channel of cloudOpsAudioChannels.values()) {
      if (!channel.streamId && channel.phase === "idle") {
        continue;
      }

      const vehicleId = String(options.vehicleId || channel.vehicleId || "").trim();
      if (options.useKeepalive) {
        sendCloudOpsAudioStopKeepalive(channel, vehicleId);
        releaseCloudOpsAudioChannel(channel, { stopPlayback: true, phase: "idle" });
        continue;
      }

      try {
        await stopCloudOpsAudioChannel(channel, {
          vehicleId,
          silent: options.silent !== false
        });
      } catch (_error) {
        releaseCloudOpsAudioChannel(channel, { stopPlayback: true, phase: "idle" });
      }
    }

    updateCloudOpsAudioAvailability();
  }

  async function handleCloudOpsAudioButtonClick(event) {
    const button = event.currentTarget;
    const channel = getCloudOpsAudioChannelByButton(button);
    if (!channel || channel.busy) {
      return;
    }

    if (!cloudOpsAuthenticated) {
      setCloudOpsStatus("登录获取更多控制权限", "idle");
      focusWithoutScroll(cloudOpsUsername);
      return;
    }

    if (!cloudOpsCurrentVehicleId) {
      setCloudOpsStatus("请选择车辆", "idle");
      focusWithoutScroll(cloudOpsVehicleSelect);
      return;
    }

    const shouldStop = channel.phase === "starting" || channel.phase === "active";
    cloudOpsBusy = true;
    channel.busy = true;
    updateCloudOpsActionAvailability();

    try {
      if (shouldStop) {
        await stopCloudOpsAudioChannel(channel);
      } else {
        await startCloudOpsAudioChannel(channel);
      }
    } catch (error) {
      renderCloudOpsResult(`执行失败：${error?.message || "未知错误"}`, null, "error");
      setCloudOpsStatus("执行失败", "error");
    } finally {
      channel.busy = false;
      cloudOpsBusy = false;
      updateCloudOpsActionAvailability();
    }
  }

  function buildCloudOpsPlanFromButton(button) {
    const action = button.dataset.cloudOpsAction || "none";
    const plan = {
      action,
      vehicle_id: cloudOpsCurrentVehicleId,
      timeout_s: Number.parseInt(button.dataset.timeoutS || "20", 10) || 20
    };

    if (action === "tool_call") {
      plan.tool_name = button.dataset.toolName || "";
      plan.args = parseJsonDataset(button.dataset.args, {});
    }

    return plan;
  }

  async function handleCloudOpsActionClick(event) {
    const button = event.currentTarget;
    if (!(button instanceof HTMLButtonElement) || button.disabled) {
      return;
    }

    if (isCloudOpsControlButton(button) && !cloudOpsAuthenticated) {
      setCloudOpsStatus("登录获取更多控制权限", "idle");
      focusWithoutScroll(cloudOpsUsername);
      return;
    }

    cloudOpsBusy = true;
    updateCloudOpsActionAvailability();
    if (cloudOpsRefreshBtn) cloudOpsRefreshBtn.disabled = true;
    if (cloudOpsVehicleSelect) cloudOpsVehicleSelect.disabled = true;
    setCloudOpsStatus("执行中...", "loading");
    renderCloudOpsResult("正在执行云端运维动作，请稍候。", null, "loading");
    const workflowLabel =
      button.querySelector("strong")?.textContent?.trim() ||
      formatCloudOpsToolName(button.dataset.toolName || button.dataset.cloudOpsAction || "运维动作");
    const requestId = `web-${createNonce()}`;
    let shouldRefreshContext = false;
    const workflowMessage = openClawMessages
      ? createCloudOpsWorkflowMessage(openClawMessages, workflowLabel, cloudOpsCurrentVehicleId)
      : null;
    if (workflowMessage) {
      cloudOpsWorkflowByRequestId.set(requestId, workflowMessage);
    }

    try {
      const plan = buildCloudOpsPlanFromButton(button);
      plan.request_id = requestId;
      const data = await fetchJsonOrThrow(CLOUD_OPS_EXECUTE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(plan)
      });
      const resultState = deriveCloudOpsResultState(data);
      renderCloudOpsResult(data?.summary || "执行完成。", data, resultState);
      setCloudOpsStatus(resultState === "warn" ? "执行完成（需关注）" : "执行完成", resultState);
      const contextItem = pinCloudOpsContext(button, data);
      if (contextItem && workflowMessage) {
        updateCloudOpsWorkflowMessage(workflowMessage, {
          status: resultState === "warn" ? "warn" : "ok",
          label: contextItem.label,
          vehicleId: contextItem.vehicle_id,
          payload: data,
          summaryText: contextItem.summary
        });
      } else if (workflowMessage) {
        updateCloudOpsWorkflowMessage(workflowMessage, {
          status: resultState === "warn" ? "warn" : "ok",
          label: workflowLabel,
          vehicleId: cloudOpsCurrentVehicleId,
          payload: data,
          summaryText: buildCloudOpsContextSummary(data)
        });
      }
      cloudOpsWorkflowByRequestId.delete(requestId);
      if (contextItem && openClawMessages) {
        setOpenClawStatus(
          openClawAuthenticated ? "已插入上下文" : "结果已同步到对话框",
          "ok"
        );
      }
      shouldRefreshContext = true;
    } catch (error) {
      renderCloudOpsResult(`执行失败：${error?.message || "未知错误"}`, null, "error");
      setCloudOpsStatus("执行失败", "error");
      if (workflowMessage) {
        updateCloudOpsWorkflowMessage(workflowMessage, {
          status: "error",
          label: workflowLabel,
          vehicleId: cloudOpsCurrentVehicleId,
          errorText: error?.message || "未知错误"
        });
      }
      cloudOpsWorkflowByRequestId.delete(requestId);
    } finally {
      cloudOpsBusy = false;
      if (cloudOpsRefreshBtn) cloudOpsRefreshBtn.disabled = false;
      if (cloudOpsVehicleSelect) cloudOpsVehicleSelect.disabled = false;
      updateCloudOpsActionAvailability();
      if (shouldRefreshContext) {
        loadCloudOpsContext({ preserveResult: true, silent: true }).catch(() => {});
      }
    }
  }

  function resetConversation() {
    messageHistory.length = 0;
    if (chatMessages) {
      chatMessages.innerHTML = "";
    }

    const welcome = getWelcomeText();
    messageHistory.push({ role: "bot", text: welcome });
    createPanelMessage(chatMessages, "bot", welcome);
    sessionId = createSessionId(vehicleId);
    firstTurn = true;
    setChatStatus("就绪", "idle");
  }

  function sortIdentityNames(names) {
    return [...new Set((Array.isArray(names) ? names : []).filter(Boolean))].sort((left, right) => {
      if (left === DEFAULT_VEHICLE_ID) return -1;
      if (right === DEFAULT_VEHICLE_ID) return 1;
      return left.localeCompare(right, "zh-CN");
    });
  }

  function renderIdentityOptions(names) {
    if (!identitySelect) return;

    const identities = sortIdentityNames([...names, DEFAULT_VEHICLE_ID]);
    const current = identities.includes(vehicleId) ? vehicleId : DEFAULT_VEHICLE_ID;
    identitySelect.innerHTML = "";

    identities.forEach((name) => {
      identitySelect.appendChild(new Option(name, name));
    });

    identitySelect.value = current;
    vehicleId = current;
  }

  async function loadIdentityOptions() {
    if (!identitySelect) return;

    try {
      const response = await fetch(IDENTITIES_URL, {
        headers: { Accept: "application/json" }
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      const identities = Array.isArray(data?.identities) ? data.identities : [DEFAULT_VEHICLE_ID];
      renderIdentityOptions(identities);
    } catch (_error) {
      renderIdentityOptions([DEFAULT_VEHICLE_ID]);
    }

    resetConversation();
  }

  async function animateReply(container, messageEl, text) {
    const reply = String(text || "");
    if (!reply) return "";

    const step = reply.length > 180 ? 6 : 3;
    for (let i = step; i < reply.length; i += step) {
      updatePanelMessage(container, messageEl, reply.slice(0, i), true);
      await sleep(18);
    }

    updatePanelMessage(container, messageEl, reply, false);
    return reply;
  }

  async function readStreamingReply(response, container, messageEl) {
    if (!response.body) {
      throw new Error("云端流式响应不可用");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let streamedText = "";
    let finalReply = "";
    let sawDelta = false;

    const handleEvent = (data) => {
      if (!data) return;
      if (data.type === "delta" && typeof data.text === "string") {
        sawDelta = true;
        streamedText += data.text;
        updatePanelMessage(container, messageEl, streamedText, true);
        return;
      }
      if (data.type === "final") {
        finalReply = extractReply(data) || streamedText;
        updatePanelMessage(container, messageEl, finalReply, false);
        return;
      }
      if (data.type === "error") {
        throw new Error(data.detail || data.error || data.message || "stream_error");
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() || "";

      for (const block of blocks) {
        handleEvent(parseSseBlock(block));
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      handleEvent(parseSseBlock(buffer));
    }

    const reply = (finalReply || streamedText).trim();
    if (!reply) {
      throw new Error("云端返回内容为空");
    }

    if (!sawDelta && finalReply) {
      return animateReply(container, messageEl, reply);
    }

    updatePanelMessage(container, messageEl, reply, false);
    return reply;
  }

  async function readJsonReply(response, container, messageEl) {
    const data = await response.json();
    const reply = extractReply(data).trim();
    if (!reply) {
      throw new Error("云端返回内容为空");
    }
    updatePanelMessage(container, messageEl, reply, false);
    return reply;
  }

  async function readQwen36StreamingReply(response, botHandle) {
    if (!response.body) {
      throw new Error("Qwen3.6 流式响应不可用");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let finalEvent = null;

    const handleEvent = (data) => {
      if (!data) return;
      if (data.type === "reasoning_delta" && typeof data.text === "string") {
        botHandle.reasoningText += data.text;
        updateQwen36BotMessage(botHandle, { streaming: true });
        return;
      }
      if (data.type === "delta" && typeof data.text === "string") {
        botHandle.answerText += data.text;
        updateQwen36BotMessage(botHandle, { streaming: true });
        return;
      }
      if (data.type === "final") {
        finalEvent = data;
        botHandle.answerText = String(data.answer || botHandle.answerText || "").trim();
        botHandle.reasoningText = String(data.reasoning || botHandle.reasoningText || "").trim();
        updateQwen36BotMessage(botHandle, { streaming: false });
        return;
      }
      if (data.type === "error") {
        throw new Error(data.detail || data.error || data.message || "qwen36_stream_error");
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() || "";

      for (const block of blocks) {
        handleEvent(parseSseBlock(block));
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      handleEvent(parseSseBlock(buffer));
    }

    updateQwen36BotMessage(botHandle, { streaming: false });
    return {
      answer: botHandle.answerText.trim(),
      reasoning: botHandle.reasoningText.trim(),
      finishReason: finalEvent?.finish_reason || "",
      usage: finalEvent?.usage || null
    };
  }

  async function refreshQwen36Health() {
    if (!qwen36Status) return;

    try {
      const response = await fetch(QWEN36_HEALTH_URL, {
        headers: { Accept: "application/json" }
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      const model = Array.isArray(data.models) && data.models[0] ? data.models[0] : data.model || "Qwen3.6-27B";
      setQwen36Status(model, "ok");
    } catch (error) {
      setQwen36Status(`连接异常：${error?.message || "未知错误"}`, "error");
    }
  }

  async function handleQwen36Submit(event) {
    event.preventDefault();
    if (!qwen36Input || !qwen36Send) return;

    const message = qwen36Input.value.trim();
    if (!message) {
      setQwen36Status("请输入内容", "error");
      return;
    }

    const thinking = Boolean(qwen36Thinking?.checked);
    qwen36Send.disabled = true;
    qwen36Input.disabled = true;
    qwen36Thinking && (qwen36Thinking.disabled = true);
    qwen36Reset && (qwen36Reset.disabled = true);
    createPanelMessage(qwen36Messages, "user", message);
    const botHandle = createQwen36BotMessage();
    setQwen36Status(thinking ? "thinking..." : "生成中...", "loading");

    try {
      const response = await fetch(QWEN36_CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream"
        },
        body: JSON.stringify({
          session_id: qwen36SessionId,
          message,
          messages: qwen36History,
          stream: true,
          thinking,
          preserve_thinking: true,
          max_tokens: thinking ? 2048 : 1024,
          temperature: thinking ? 0.7 : 0.6,
          top_p: 0.95,
          top_k: 20
        })
      });

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(detail || `HTTP ${response.status}`);
      }

      const result = await readQwen36StreamingReply(response, botHandle);
      qwen36History.push({ role: "user", content: message });
      if (result.answer) {
        qwen36History.push({ role: "assistant", content: result.answer });
      }
      while (qwen36History.length > 16) {
        qwen36History.shift();
      }
      qwen36Input.value = "";
      setQwen36Status(result.finishReason === "length" ? "长度截断" : "已回复", result.finishReason === "length" ? "error" : "ok");
    } catch (error) {
      if (botHandle) {
        botHandle.answerText = `Qwen3.6 服务暂不可用：${error?.message || "未知错误"}`;
        updateQwen36BotMessage(botHandle, { streaming: false });
      }
      setQwen36Status("服务异常", "error");
    } finally {
      qwen36Send.disabled = false;
      qwen36Input.disabled = false;
      qwen36Thinking && (qwen36Thinking.disabled = false);
      qwen36Reset && (qwen36Reset.disabled = false);
      qwen36Input.focus();
    }
  }

  async function handleCloudChatSubmit(event) {
    event.preventDefault();
    if (!chatInput || !chatSend) return;

    const message = chatInput.value.trim();
    if (!message) {
      setChatStatus("请输入内容", "error");
      return;
    }

    chatSend.disabled = true;
    chatInput.disabled = true;
    createPanelMessage(chatMessages, "user", message);
    const botMessage = createPanelMessage(chatMessages, "bot", "正在生成...");
    setChatStatus("思考中...", "loading");

    try {
      const response = await fetch(cloudChatUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream"
        },
        body: JSON.stringify({
          message,
          session_id: sessionId,
          reset: firstTurn,
          vehicle_id: vehicleId,
          enable_thinking: Boolean(chatThinking?.checked)
        })
      });

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(detail || `HTTP ${response.status}`);
      }

      const contentType = response.headers.get("content-type") || "";
      const reply = contentType.includes("text/event-stream")
        ? await readStreamingReply(response, chatMessages, botMessage)
        : await readJsonReply(response, chatMessages, botMessage);

      messageHistory.push({ role: "user", text: message });
      messageHistory.push({ role: "bot", text: reply });
      firstTurn = false;
      chatInput.value = "";
      setChatStatus("已回复", "ok");
    } catch (error) {
      updatePanelMessage(chatMessages, botMessage, `对话服务暂不可用：${error?.message || "未知错误"}`, false);
      setChatStatus("服务异常", "error");
    } finally {
      chatSend.disabled = false;
      chatInput.disabled = false;
      chatInput.focus();
    }
  }

  function resetOpenClawConversation() {
    if (openClawMessages) {
      openClawMessages.innerHTML = "";
    }
    createPanelMessage(openClawMessages, "bot", getOpenClawWelcomeText());
    openClawSessionId = createSessionId("openclaw");
    setOpenClawStatus(openClawAuthenticated ? openClawModelLabel : "登录获取更多控制权限", "idle");
    updateOpenClawInputAvailability();
  }

  function applyOpenClawAuthState(authenticated, options = {}) {
    openClawAuthenticated = Boolean(authenticated);
    if (openClawAuth) {
      openClawAuth.hidden = openClawAuthenticated;
    }
    if (openClawChatShell) {
      openClawChatShell.hidden = false;
    }
    if (openClawLogoutBtn) {
      openClawLogoutBtn.hidden = !openClawAuthenticated;
    }

    if (openClawAuthenticated) {
      setOpenClawAuthHint(options.username ? `已登录：${options.username}` : "已登录。", "ok");
      resetOpenClawConversation();
    } else {
      setOpenClawAuthHint("登录后可聊天并获取更多控制权限。", "idle");
      resetOpenClawConversation();
    }
  }

  async function loadOpenClawHealth() {
    if (!openClawStatus || !openClawAuthenticated) {
      return;
    }

    try {
      const response = await fetch(OPENCLAW_HEALTH_URL, {
        headers: { Accept: "application/json" }
      });
      if (response.status === 401) {
        applyOpenClawAuthState(false);
        return;
      }
      const data = await response.json();
      if (!response.ok || !data?.ok) {
        throw new Error(data?.detail || `HTTP ${response.status}`);
      }
      openClawModelLabel = data.model || openClawModelLabel;
      setOpenClawStatus(openClawModelLabel, "ok");
    } catch (_error) {
      setOpenClawStatus("OpenClaw未就绪", "error");
    }
  }

  async function refreshOpenClawAuthStatus() {
    if (!openClawStatus) return;

    try {
      const response = await fetch(OPENCLAW_AUTH_STATUS_URL, {
        headers: { Accept: "application/json" }
      });
      const data = await response.json();
      if (!response.ok || !data?.ok) {
        applyOpenClawAuthState(false);
        return;
      }
      applyOpenClawAuthState(true, { username: data.username || "" });
      await loadOpenClawHealth();
    } catch (_error) {
      applyOpenClawAuthState(false);
    }
  }

  async function handleOpenClawLoginSubmit(event) {
    event.preventDefault();
    const username = openClawUsername?.value.trim() || "";
    const password = openClawPassword?.value || "";

    if (!username || !password) {
      setOpenClawAuthHint("请输入完整的用户名和密码。", "error");
      return;
    }

    if (openClawLoginBtn) openClawLoginBtn.disabled = true;
    if (openClawUsername) openClawUsername.disabled = true;
    if (openClawPassword) openClawPassword.disabled = true;
    setOpenClawAuthHint("登录中...", "loading");
    setOpenClawStatus("验证中...", "loading");

    try {
      const response = await fetch(OPENCLAW_LOGIN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({ username, password })
      });
      const data = await response.json();
      if (!response.ok || !data?.ok) {
        throw new Error("用户名或密码错误");
      }

      if (openClawPassword) {
        openClawPassword.value = "";
      }
      applyOpenClawAuthState(true, { username: data.username || username });
      applyCloudOpsAuthState(true, { username: data.username || username });
      await loadOpenClawHealth();
      await loadCloudOpsContext();
      openClawInput?.focus();
    } catch (error) {
      applyOpenClawAuthState(false);
      setOpenClawAuthHint(error?.message || "登录失败。", "error");
      setOpenClawStatus("需登录", "idle");
    } finally {
      if (openClawLoginBtn) openClawLoginBtn.disabled = false;
      if (openClawUsername) openClawUsername.disabled = false;
      if (openClawPassword) openClawPassword.disabled = false;
    }
  }

  async function handleOpenClawLogout(event) {
    event.preventDefault();
    try {
      await fetch(OPENCLAW_LOGOUT_URL, {
        method: "POST",
        headers: { Accept: "application/json" }
      });
    } catch (_error) {
      // Ignore transport errors during logout.
    }
    applyOpenClawAuthState(false);
    applyCloudOpsAuthState(false);
    if (openClawPassword) {
      openClawPassword.value = "";
    }
    openClawUsername?.focus();
  }

  async function handleOpenClawSubmit(event) {
    event.preventDefault();
    if (!openClawInput || !openClawSend) return;

    const message = openClawInput.value.trim();
    if (!message) {
      setOpenClawStatus("请输入内容", "error");
      return;
    }

    if (!openClawAuthenticated) {
      setOpenClawStatus("登录获取更多控制权限", "idle");
      focusWithoutScroll(cloudOpsUsername || openClawUsername);
      return;
    }

    openClawSend.disabled = true;
    openClawInput.disabled = true;
    createPanelMessage(openClawMessages, "user", message);
    const botMessage = createPanelMessage(openClawMessages, "bot", "OpenClaw 正在处理...");
    setOpenClawStatus("处理中...", "loading");

    try {
      const response = await fetch(OPENCLAW_CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({
          message,
          session_id: openClawSessionId,
          vehicle_id: cloudOpsCurrentVehicleId || "",
          context_items: cloudOpsPinnedContexts
        })
      });

      if (response.status === 401) {
        applyOpenClawAuthState(false);
        throw new Error("登录已失效，请重新登录");
      }

      const data = await response.json();
      if (!response.ok || !data?.ok) {
        throw new Error(data?.detail || `HTTP ${response.status}`);
      }

      const reply = String(data.reply || "").trim();
      if (!reply) {
        throw new Error("OpenClaw 返回内容为空");
      }

      await animateReply(openClawMessages, botMessage, reply);
      openClawInput.value = "";
      setOpenClawStatus(openClawModelLabel, "ok");
    } catch (error) {
      updatePanelMessage(openClawMessages, botMessage, error?.message || "OpenClaw 服务异常", false);
      setOpenClawStatus("服务异常", "error");
    } finally {
      openClawSend.disabled = false;
      openClawInput.disabled = false;
      openClawInput.focus();
    }
  }

  function resetAiPreview() {
    if (!aiCheckPreview) return;

    if (aiPreviewUrl) {
      URL.revokeObjectURL(aiPreviewUrl);
      aiPreviewUrl = "";
    }

    aiCheckPreview.dataset.empty = "true";
    aiCheckPreview.innerHTML = '<p class="ai-check-preview-empty">选择图片后会在这里预览</p>';
  }

  function renderAiPreview(file) {
    if (!aiCheckPreview) return;

    if (aiPreviewUrl) {
      URL.revokeObjectURL(aiPreviewUrl);
    }

    aiPreviewUrl = URL.createObjectURL(file);
    aiCheckPreview.dataset.empty = "false";
    aiCheckPreview.innerHTML = "";

    const image = document.createElement("img");
    image.src = aiPreviewUrl;
    image.alt = file.name || "待检测图片";
    aiCheckPreview.appendChild(image);
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("图片读取失败"));
      reader.readAsDataURL(file);
    });
  }

  function loadImageElement(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("图片解析失败"));
      image.src = src;
    });
  }

  async function buildImagePayload(file) {
    const originalDataUrl = await fileToDataUrl(file);
    const image = await loadImageElement(originalDataUrl);
    const maxSide = 1280;
    const longest = Math.max(image.naturalWidth, image.naturalHeight);

    let outputDataUrl = originalDataUrl;
    if (longest > maxSide) {
      const scale = maxSide / longest;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error("图片压缩失败");
      }

      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      outputDataUrl = canvas.toDataURL(file.type || "image/jpeg", 0.9);
    }

    const parts = outputDataUrl.split(",", 2);
    if (parts.length !== 2) {
      throw new Error("图片编码失败");
    }

    const mimeMatch = parts[0].match(/^data:([^;]+);base64$/i);
    return {
      mime_type: mimeMatch?.[1] || file.type || "image/jpeg",
      data_base64: parts[1]
    };
  }

  function buildAiCheckPrompt(eventName, customPrompt = "") {
    const cleanEvent = String(eventName || "").trim();
    const custom = String(customPrompt || "").trim();
    if (custom) {
      return custom.replace(/\{\{\s*event(?:_name)?\s*\}\}|\{event(?:_name)?\}/gi, cleanEvent);
    }
    return `Reply YES if this image clearly shows the event "${cleanEvent}". Reply NO if the event is absent. Output only YES or NO.`;
  }

  function runAiCheckRequest(payload) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const ws = new WebSocket(qwenCheckWsUrl);

      const finish = (callback) => (value) => {
        if (settled) return;
        settled = true;
        if (timer) {
          window.clearTimeout(timer);
        }
        try {
          ws.close();
        } catch (_error) {}
        callback(value);
      };

      const resolveOnce = finish(resolve);
      const rejectOnce = finish(reject);

      timer = window.setTimeout(() => {
        rejectOnce(new Error("检测超时"));
      }, 120000);

      ws.addEventListener("open", () => {
        ws.send(JSON.stringify(payload));
      });

      ws.addEventListener("message", (event) => {
        try {
          resolveOnce(JSON.parse(String(event.data || "{}")));
        } catch (_error) {
          rejectOnce(new Error("检测服务返回了无效JSON"));
        }
      });

      ws.addEventListener("error", () => {
        rejectOnce(new Error("检测服务连接失败"));
      });

      ws.addEventListener("close", (event) => {
        if (!settled && event.code !== 1000) {
          rejectOnce(new Error(`检测连接已关闭：${event.code || "unknown"}`));
        }
      });
    });
  }

  function setAiCheckResult(answer, detail, state) {
    if (aiCheckAnswer) {
      aiCheckAnswer.textContent = answer;
    }
    if (aiCheckDetail) {
      aiCheckDetail.textContent = detail;
    }
    if (aiCheckResult) {
      aiCheckResult.dataset.state = state || "idle";
    }
  }

  function formatAnswerSummary(task) {
    if (task?.error) {
      return { text: "异常", tone: "error" };
    }
    if (task?.pass === 1 || task?.answer === "YES") {
      return { text: "是", tone: "yes" };
    }
    if (task?.pass === 0 || task?.answer === "NO") {
      return { text: "否", tone: "no" };
    }
    return { text: "未知", tone: "idle" };
  }

  function renderAiHistoryEmpty(message, detailState = "idle") {
    if (aiHistoryDetail) {
      aiHistoryDetail.dataset.state = detailState;
      aiHistoryDetail.innerHTML = "";
      aiHistoryDetail.appendChild(createNode("p", "ai-history-empty", message));
    }
  }

  function updateAiHistoryPager() {
    if (aiHistoryPage) {
      aiHistoryPage.textContent = `第 ${aiHistoryPageValue} / ${aiHistoryTotalPages} 页`;
    }
    if (aiHistoryPrevBtn) {
      aiHistoryPrevBtn.disabled = aiHistoryPageValue <= 1;
    }
    if (aiHistoryNextBtn) {
      aiHistoryNextBtn.disabled = aiHistoryPageValue >= aiHistoryTotalPages;
    }
  }

  function renderAiHistoryDeviceFilterOptions(values) {
    if (!aiHistoryDeviceFilterSelect) return;

    const options = [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))];
    const nextValue = options.includes(aiHistoryDeviceFilter) ? aiHistoryDeviceFilter : "";

    aiHistoryDeviceFilterSelect.innerHTML = "";
    aiHistoryDeviceFilterSelect.appendChild(new Option("全部地点", ""));
    options.forEach((value) => {
      aiHistoryDeviceFilterSelect.appendChild(new Option(value, value));
    });
    aiHistoryDeviceFilterSelect.value = nextValue;
    aiHistoryDeviceFilter = nextValue;
  }

  function renderAiHistoryList(items) {
    if (!aiHistoryList) return;

    aiHistoryList.innerHTML = "";
    if (!items.length) {
      aiHistoryList.appendChild(createNode("p", "ai-history-empty", "暂无历史检测记录。"));
      return;
    }

    items.forEach((item) => {
      const button = createNode("button", "ai-history-item");
      button.type = "button";
      button.dataset.requestId = String(item.id || "");
      if (item.id === aiHistorySelectedId) {
        button.classList.add("is-active");
      }

      const thumbWrap = createNode("div", "ai-history-thumb");
      if (item.image_url) {
        const thumb = createNode("img");
        thumb.src = item.image_url;
        thumb.alt = item.request_id || "历史检测缩略图";
        thumb.loading = "lazy";
        thumbWrap.appendChild(thumb);
      } else {
        thumbWrap.appendChild(createNode("p", "ai-history-thumb-empty", "无图片"));
      }

      const content = createNode("div", "ai-history-item-body");
      const top = createNode("div", "ai-history-item-top");
      top.appendChild(createNode("p", "ai-history-time", formatTimeLabel(item.received_at_ms, item.created_at)));

      const meta = createNode(
        "p",
        "ai-history-meta",
        `${item.device_id || "-"} / ${item.camera_id || "-"} · ${item.task_count || 0}个任务 · ${item.latency_ms ?? "-"}ms`
      );

      const chips = createNode("div", "ai-history-chips");
      (Array.isArray(item.tasks) ? item.tasks : []).forEach((task) => {
        const summary = formatAnswerSummary(task);
        const chip = createNode("span", `ai-history-chip tone-${summary.tone}`);
        chip.textContent = `${task.event_name || task.task_id || "任务"} ${summary.text}`;
        chips.appendChild(chip);
      });

      if (!chips.childNodes.length) {
        chips.appendChild(createNode("span", "ai-history-chip tone-idle", "无任务摘要"));
      }

      if (item.error) {
        chips.appendChild(createNode("span", "ai-history-chip tone-error", `请求异常：${item.error}`));
      }

      content.appendChild(top);
      content.appendChild(meta);
      content.appendChild(chips);

      button.appendChild(thumbWrap);
      button.appendChild(content);
      button.addEventListener("click", () => {
        loadAiHistoryDetail(item.id);
      });

      aiHistoryList.appendChild(button);
    });
  }

  function createAiHistoryKeyValue(label, value) {
    const item = createNode("div", "ai-history-meta-item");
    item.appendChild(createNode("p", "ai-history-meta-label", label));
    item.appendChild(createNode("p", "ai-history-meta-value", value ?? "-"));
    return item;
  }

  function createAiHistoryJsonBlock(title, payload) {
    const box = createNode("details", "ai-history-json");
    const summary = createNode("summary", "", title);
    const pre = createNode("pre", "");
    pre.textContent = JSON.stringify(payload ?? {}, null, 2);
    box.appendChild(summary);
    box.appendChild(pre);
    return box;
  }

  function createAiHistoryImageButton(imageUrl, altText) {
    const button = createNode("button", "ai-history-image-link");
    button.type = "button";
    button.setAttribute("aria-label", `${altText || "历史检测图片"}，点击放大`);
    button.addEventListener("click", () => {
      openAiHistoryLightbox(imageUrl, altText);
    });

    const image = createNode("img");
    image.src = imageUrl;
    image.alt = altText || "历史检测图片";
    image.loading = "lazy";
    button.appendChild(image);
    button.appendChild(createNode("span", "ai-history-image-hint", "点击放大"));
    return button;
  }

  function openAiHistoryLightbox(imageUrl, caption) {
    if (!aiHistoryLightbox || !aiHistoryLightboxImage || !aiHistoryLightboxLink) return;
    aiHistoryLightboxImage.src = imageUrl;
    aiHistoryLightboxImage.alt = caption || "AI检测放大图片";
    aiHistoryLightboxLink.href = imageUrl;
    if (aiHistoryLightboxCaption) {
      aiHistoryLightboxCaption.textContent = caption || "AI检测图片";
    }
    aiHistoryLightbox.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function closeAiHistoryLightbox() {
    if (!aiHistoryLightbox || !aiHistoryLightboxImage || !aiHistoryLightboxLink) return;
    aiHistoryLightbox.hidden = true;
    aiHistoryLightboxImage.removeAttribute("src");
    aiHistoryLightboxLink.href = "#";
    document.body.style.overflow = "";
  }

  function renderAiHistoryDetail(request) {
    if (!aiHistoryDetail) return;

    aiHistoryDetail.dataset.state = "ok";
    aiHistoryDetail.innerHTML = "";

    const hero = createNode("div", "ai-history-hero");
    if (request?.image_url) {
      hero.appendChild(createAiHistoryImageButton(request.image_url, request.request_id || "检测原图"));
    } else {
      hero.appendChild(createNode("p", "ai-history-empty", "该记录没有原图。"));
    }
    aiHistoryDetail.appendChild(hero);

    const metaGrid = createNode("div", "ai-history-meta-grid");
    metaGrid.appendChild(createAiHistoryKeyValue("请求ID", request?.request_id || "-"));
    metaGrid.appendChild(createAiHistoryKeyValue("时间", formatTimeLabel(request?.received_at_ms, request?.created_at)));
    metaGrid.appendChild(createAiHistoryKeyValue("设备", request?.device_id || "-"));
    metaGrid.appendChild(createAiHistoryKeyValue("相机", request?.camera_id || "-"));
    metaGrid.appendChild(createAiHistoryKeyValue("整单耗时", `${request?.latency_ms ?? "-"}ms`));
    metaGrid.appendChild(createAiHistoryKeyValue("任务数", request?.task_count ?? "-"));
    metaGrid.appendChild(createAiHistoryKeyValue("图像尺寸", request?.frame_width && request?.frame_height ? `${request.frame_width} × ${request.frame_height}` : "-"));
    aiHistoryDetail.appendChild(metaGrid);

    if (request?.error) {
      aiHistoryDetail.appendChild(createNode("p", "ai-history-request-error", `请求异常：${request.error}`));
    }

    const taskList = createNode("div", "ai-history-task-list");
    const tasks = Array.isArray(request?.tasks) ? request.tasks : [];
    if (!tasks.length) {
      taskList.appendChild(createNode("p", "ai-history-empty", "该记录没有 task 详情。"));
    } else {
      tasks.forEach((task) => {
        const summary = formatAnswerSummary(task);
        const taskCard = createNode("article", "ai-history-task");

        const taskHead = createNode("div", "ai-history-task-head");
        taskHead.appendChild(createNode("h4", "", task.event_name || task.task_id || `任务${task.task_idx ?? "-"}`));
        taskHead.appendChild(createNode("span", `ai-history-chip tone-${summary.tone}`, summary.text));
        taskCard.appendChild(taskHead);

        taskCard.appendChild(
          createNode("p", "ai-history-task-meta", `task_id: ${task.task_id || "-"} · 耗时: ${task.latency_ms ?? "-"}ms`)
        );

        if (task.roi_url) {
          const roiWrap = createNode("div", "ai-history-roi");
          roiWrap.appendChild(createAiHistoryImageButton(task.roi_url, `${task.event_name || task.task_id || "ROI"} ROI`));
          taskCard.appendChild(roiWrap);
        }

        taskCard.appendChild(createNode("p", "ai-history-task-text", `原始返回：${task.raw_text || task.answer || "-"}`));

        const extra = createNode("details", "ai-history-task-extra");
        extra.appendChild(createNode("summary", "", "展开技术细节"));
        extra.appendChild(createNode("p", "ai-history-task-text", `Prompt：${task.prompt_text || "-"}`));
        extra.appendChild(createNode("p", "ai-history-task-text", `裁剪框：${task.crop_box ? JSON.stringify(task.crop_box) : "-"}`));
        extra.appendChild(createNode("p", "ai-history-task-text", `合并框：${task.merged_box ? JSON.stringify(task.merged_box) : "-"}`));
        if (task.error) {
          extra.appendChild(createNode("p", "ai-history-task-error", `异常：${task.error}`));
        }
        taskCard.appendChild(extra);
        taskList.appendChild(taskCard);
      });
    }

    aiHistoryDetail.appendChild(taskList);
    aiHistoryDetail.appendChild(createAiHistoryJsonBlock("request.json", request?.request_json));
    aiHistoryDetail.appendChild(createAiHistoryJsonBlock("response.json", request?.response_json));
  }

  async function loadAiHistoryDetail(requestRowId) {
    if (!requestRowId || !aiHistoryDetail) return;

    aiHistorySelectedId = Number(requestRowId) || 0;
    aiHistoryDetail.dataset.state = "loading";
    aiHistoryDetail.innerHTML = "";
    aiHistoryDetail.appendChild(createNode("p", "ai-history-empty", "正在加载详情..."));
    document
      .querySelectorAll(".ai-history-item")
      .forEach((item) => item.classList.toggle("is-active", Number(item.dataset.requestId) === aiHistorySelectedId));

    try {
      const response = await fetch(`${AI_CHECK_HISTORY_URL}/${aiHistorySelectedId}`, {
        headers: { Accept: "application/json" }
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      if (!data?.ok || !data?.request) {
        throw new Error(data?.detail || "历史详情不可用");
      }

      renderAiHistoryDetail(data.request);
      setAiHistoryStatus("详情已加载", "ok");
    } catch (error) {
      setAiHistoryStatus("详情加载失败", "error");
      renderAiHistoryEmpty(`详情加载失败：${error?.message || "未知错误"}`, "error");
    }
  }

  async function loadAiHistoryPageData(page, options = {}) {
    const nextPage = Math.max(1, Number(page) || 1);
    const selectFirst = options.selectFirst !== false;

    try {
      setAiHistoryStatus("加载中...", "loading");
      const url = new URL(AI_CHECK_HISTORY_URL, window.location.origin);
      url.searchParams.set("page", String(nextPage));
      url.searchParams.set("page_size", String(AI_CHECK_HISTORY_PAGE_SIZE));
      if (aiHistoryDeviceFilter) {
        url.searchParams.set("device_id", aiHistoryDeviceFilter);
      }

      const response = await fetch(url, {
        headers: { Accept: "application/json" }
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      if (!data?.ok) {
        throw new Error(data?.detail || "历史记录不可用");
      }

      aiHistoryPageValue = Number(data.page) || 1;
      aiHistoryTotalPages = Math.max(1, Number(data.total_pages) || 1);
      renderAiHistoryDeviceFilterOptions(data.available_device_ids);
      updateAiHistoryPager();

      const items = Array.isArray(data.items) ? data.items : [];
      const selectedExists = items.some((item) => Number(item.id) === aiHistorySelectedId);
      renderAiHistoryList(items);

      if (!items.length) {
        aiHistorySelectedId = 0;
        renderAiHistoryEmpty("暂无历史检测记录。");
        setAiHistoryStatus("暂无记录", "idle");
        return;
      }

      const targetId = selectedExists ? aiHistorySelectedId : selectFirst ? Number(items[0].id) || 0 : 0;
      if (targetId) {
        await loadAiHistoryDetail(targetId);
      } else {
        setAiHistoryStatus("已更新", "ok");
      }
    } catch (error) {
      updateAiHistoryPager();
      if (aiHistoryList) {
        aiHistoryList.innerHTML = "";
        aiHistoryList.appendChild(createNode("p", "ai-history-empty", `历史记录加载失败：${error?.message || "未知错误"}`));
      }
      renderAiHistoryEmpty("历史记录暂不可用。", "error");
      setAiHistoryStatus("加载失败", "error");
    }
  }

  function setQwen36MmStatus(text, state) {
    if (!qwen36mmStatus) return;
    qwen36mmStatus.textContent = text;
    qwen36mmStatus.dataset.state = state || "idle";
  }

  function setQwen36MmResult(answer, detail, state) {
    if (qwen36mmAnswer) qwen36mmAnswer.textContent = answer;
    if (qwen36mmDetail) qwen36mmDetail.textContent = detail;
    if (qwen36mmResult) qwen36mmResult.dataset.state = state || "idle";
  }

  function resetQwen36MmPreview() {
    if (!qwen36mmPreview) return;
    if (qwen36mmPreviewUrl) {
      URL.revokeObjectURL(qwen36mmPreviewUrl);
      qwen36mmPreviewUrl = "";
    }
    qwen36mmPreview.dataset.empty = "true";
    qwen36mmPreview.innerHTML = '<p class="ai-check-preview-empty">选择图片后会在这里预览</p>';
  }

  function renderQwen36MmPreview(file) {
    if (!qwen36mmPreview) return;
    if (qwen36mmPreviewUrl) URL.revokeObjectURL(qwen36mmPreviewUrl);
    qwen36mmPreviewUrl = URL.createObjectURL(file);
    qwen36mmPreview.dataset.empty = "false";
    qwen36mmPreview.innerHTML = "";
    const img = document.createElement("img");
    img.src = qwen36mmPreviewUrl;
    img.alt = file.name || "待检测图片";
    qwen36mmPreview.appendChild(img);
  }

  async function handleQwen36MmCheckSubmit(event) {
    event.preventDefault();
    const file = qwen36mmImageInput?.files?.[0];
    if (!file) {
      setQwen36MmStatus("缺少图片", "error");
      setQwen36MmResult("无法判断", "请先上传图片。", "error");
      return;
    }

    if (qwen36mmSubmit) qwen36mmSubmit.disabled = true;
    setQwen36MmStatus("检测中...", "loading");
    setQwen36MmResult("检测中", "正在发送图片到 Qwen3.6-27B，请稍候。", "loading");

    try {
      const imagePayload = await buildImagePayload(file);
      const eventName = qwen36mmEventInput?.value.trim() || "";
      const customPrompt = qwen36mmPromptInput?.value.trim() || "";
      const promptText = customPrompt
        ? customPrompt.replace(/\{\{\s*event(?:_name)?\s*\}\}|\{event(?:_name)?\}/gi, eventName || "异常事件")
        : "";

      const response = await fetch(QWEN36_MM_CHECK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: imagePayload, event_name: eventName, prompt_text: promptText }),
        signal: AbortSignal.timeout(120000)
      });

      const data = await response.json();
      if (!data.ok) {
        throw new Error(data.detail || data.error || "检测失败");
      }

      const answer = String(data.answer || "").toUpperCase();
      const name = data.event_name || eventName || "异常事件";
      if (answer === "YES") {
        setQwen36MmStatus("检测完成", "ok");
        setQwen36MmResult("是", `事件"${name}"检测结果为 YES。`, "yes");
      } else if (answer === "NO") {
        setQwen36MmStatus("检测完成", "ok");
        setQwen36MmResult("否", `事件"${name}"检测结果为 NO。`, "no");
      } else {
        setQwen36MmStatus("结果不明", "error");
        setQwen36MmResult("不确定", `模型原始回复：${data.raw_reply || "无"}`, "error");
      }
    } catch (error) {
      setQwen36MmStatus("检测失败", "error");
      setQwen36MmResult("无法判断", `检测失败：${error?.message || "未知错误"}`, "error");
    } finally {
      if (qwen36mmSubmit) qwen36mmSubmit.disabled = false;
    }
  }

  async function handleAiCheckSubmit(event) {
    event.preventDefault();
    const file = aiCheckImageInput?.files?.[0];
    const eventName = aiCheckEventInput?.value.trim() || "";
    const customPrompt = aiCheckPromptInput?.value.trim() || "";

    if (!file) {
      setAiCheckStatus("缺少图片", "error");
      setAiCheckResult("无法判断", "请先上传图片。", "error");
      return;
    }

    if (!eventName) {
      setAiCheckStatus("缺少事件", "error");
      setAiCheckResult("无法判断", "请输入事件名称。", "error");
      return;
    }

    if (aiCheckSubmit) aiCheckSubmit.disabled = true;
    setAiCheckStatus("检测中...", "loading");
    setAiCheckResult("检测中", "正在发送图片到模型服务，请稍候。", "loading");

    try {
      const imagePayload = await buildImagePayload(file);
      const payload = {
        request_id: `web-${createNonce()}`,
        device_id: "web-ai-check",
        camera_id: "upload-panel",
        image: imagePayload,
        tasks: [
          {
            task_id: `task-${createNonce()}`,
            event_name: eventName,
            prompt_text: buildAiCheckPrompt(eventName, customPrompt)
          }
        ]
      };

      const response = await runAiCheckRequest(payload);
      const result = Array.isArray(response?.results) ? response.results[0] : null;
      const answer = String(result?.answer || "").toUpperCase();
      const pass = result?.pass;

      let finalText = "无法判断";
      let detail = "检测服务没有返回有效结果。";
      let tone = "error";

      if (answer === "YES" || pass === true) {
        finalText = "是";
        detail = `事件“${eventName}”检测结果为 YES。`;
        tone = "yes";
      } else if (answer === "NO" || pass === false) {
        finalText = "否";
        detail = `事件“${eventName}”检测结果为 NO。`;
        tone = "no";
      } else if (result?.error) {
        detail = `检测失败：${result.error}`;
      }

      setAiCheckStatus("检测完成", "ok");
      setAiCheckResult(finalText, detail, tone);

      if (aiHistoryPanel) {
        loadAiHistoryPageData(1, { selectFirst: true });
      }
    } catch (error) {
      setAiCheckStatus("检测失败", "error");
      setAiCheckResult("无法判断", `检测失败：${error?.message || "未知错误"}`, "error");
    } finally {
      if (aiCheckSubmit) aiCheckSubmit.disabled = false;
    }
  }

  identitySelect?.addEventListener("change", () => {
    const nextIdentity = identitySelect.value || DEFAULT_VEHICLE_ID;
    if (nextIdentity === vehicleId) return;
    vehicleId = nextIdentity;
    resetConversation();
    chatInput?.focus();
  });

  chatInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      chatForm?.requestSubmit();
    }
  });

  chatForm?.addEventListener("submit", handleCloudChatSubmit);
  qwen36Input?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      qwen36Form?.requestSubmit();
    }
  });
  qwen36Form?.addEventListener("submit", handleQwen36Submit);
  qwen36Thinking?.addEventListener("change", () => {
    setQwen36Status(qwen36Thinking.checked ? "thinking" : "no thinking", "idle");
  });
  qwen36Reset?.addEventListener("click", () => {
    resetQwen36Conversation();
    qwen36Input?.focus();
  });
  openClawInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      openClawForm?.requestSubmit();
    }
  });
  openClawForm?.addEventListener("submit", handleOpenClawSubmit);
  openClawLoginForm?.addEventListener("submit", handleOpenClawLoginSubmit);
  openClawLogoutBtn?.addEventListener("click", handleOpenClawLogout);

  cloudOpsLoginForm?.addEventListener("submit", handleCloudOpsLoginSubmit);
  cloudOpsLogoutBtn?.addEventListener("click", handleCloudOpsLogout);
  cloudOpsRefreshBtn?.addEventListener("click", () => {
    loadCloudOpsContext();
  });
  cloudOpsVehicleSelect?.addEventListener("change", async () => {
    const previousVehicleId = cloudOpsCurrentVehicleId;
    const nextVehicleId = cloudOpsVehicleSelect.value || "";
    const vehicleChanged = nextVehicleId !== cloudOpsCurrentVehicleId;
    if (vehicleChanged) {
      await stopAllCloudOpsAudioChannels({
        vehicleId: previousVehicleId,
        silent: true
      }).catch(() => {});
      clearCloudOpsPinnedContexts({ resetConversation: true });
    }
    cloudOpsCurrentVehicleId = nextVehicleId;
    loadCloudOpsContext();
  });
  cloudOpsActionButtons.forEach((button) => {
    button.addEventListener("click", handleCloudOpsActionClick);
  });
  cloudOpsAudioButtons.forEach((button) => {
    button.addEventListener("click", handleCloudOpsAudioButtonClick);
  });
  cloudOpsContextClear?.addEventListener("click", () => {
    clearCloudOpsPinnedContexts({ resetConversation: false });
    openClawInput?.focus();
  });
  window.addEventListener("pagehide", () => {
    stopAllCloudOpsAudioChannels({
      silent: true,
      useKeepalive: true
    }).catch(() => {});
  });

  aiCheckImageInput?.addEventListener("change", () => {
    const file = aiCheckImageInput.files?.[0];
    if (!file) {
      resetAiPreview();
      setAiCheckStatus("待上传", "idle");
      setAiCheckResult("等待检测", "上传一张图片并输入事件名称，返回是或否。", "idle");
      return;
    }
    renderAiPreview(file);
    setAiCheckStatus("图片就绪", "idle");
  });

  aiCheckForm?.addEventListener("submit", handleAiCheckSubmit);

  qwen36mmImageInput?.addEventListener("change", () => {
    const file = qwen36mmImageInput.files?.[0];
    if (!file) {
      resetQwen36MmPreview();
      setQwen36MmStatus("待上传", "idle");
      setQwen36MmResult("等待检测", "上传图片并输入事件名称，返回是或否。", "idle");
      return;
    }
    renderQwen36MmPreview(file);
    setQwen36MmStatus("图片就绪", "idle");
  });

  qwen36mmForm?.addEventListener("submit", handleQwen36MmCheckSubmit);

  aiHistoryRefreshBtn?.addEventListener("click", () => {
    loadAiHistoryPageData(1, { selectFirst: true });
  });

  aiHistoryDeviceFilterSelect?.addEventListener("change", () => {
    aiHistoryDeviceFilter = aiHistoryDeviceFilterSelect.value || "";
    aiHistorySelectedId = 0;
    loadAiHistoryPageData(1, { selectFirst: true });
  });

  aiHistoryPrevBtn?.addEventListener("click", () => {
    if (aiHistoryPageValue <= 1) return;
    loadAiHistoryPageData(aiHistoryPageValue - 1, { selectFirst: true });
  });

  aiHistoryNextBtn?.addEventListener("click", () => {
    if (aiHistoryPageValue >= aiHistoryTotalPages) return;
    loadAiHistoryPageData(aiHistoryPageValue + 1, { selectFirst: true });
  });

  aiHistoryLightboxClose?.addEventListener("click", closeAiHistoryLightbox);
  aiHistoryLightbox?.addEventListener("click", (event) => {
    if (event.target instanceof HTMLElement && event.target.hasAttribute("data-close-history-lightbox")) {
      closeAiHistoryLightbox();
    }
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && aiHistoryLightbox && !aiHistoryLightbox.hidden) {
      closeAiHistoryLightbox();
    }
  });

  if (chatMessages) {
    resetConversation();
    loadIdentityOptions();
  }

  if (qwen36Messages) {
    resetQwen36Conversation();
    refreshQwen36Health();
  }

  if (openClawStatus) {
    applyOpenClawAuthState(false);
    refreshOpenClawAuthStatus();
  }

  if (cloudOpsConsole) {
    applyCloudOpsAuthState(false);
    renderCloudOpsContextList();
    updateCloudOpsAudioAvailability();
    connectCloudOpsOpsSocket();
    refreshCloudOpsAuthStatus();
  }

  if (aiCheckStatus) {
    setAiCheckStatus("待上传", "idle");
    setAiCheckResult("等待检测", "上传一张图片并输入事件名称，返回是或否。", "idle");
    resetAiPreview();
  }

  if (qwen36mmStatus) {
    setQwen36MmStatus("待上传", "idle");
    setQwen36MmResult("等待检测", "上传图片并输入事件名称，返回是或否。", "idle");
    resetQwen36MmPreview();
  }

  if (aiHistoryPanel) {
    setAiHistoryStatus("待加载", "idle");
    updateAiHistoryPager();
    loadAiHistoryPageData(1, { selectFirst: true });
  }
})();
