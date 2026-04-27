const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const DEFAULT_REFRESH_TTL_MS = 3000;
const COMMAND_MAX_BUFFER = 1024 * 1024;

function truncateText(value, limit = 4000) {
  const text = String(value || '');
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n...[truncated]`;
}

function parseKeyValueOutput(text) {
  const out = {};
  String(text || '')
    .split('\n')
    .forEach((line) => {
      const idx = line.indexOf('=');
      if (idx <= 0) {
        return;
      }
      out[line.slice(0, idx)] = line.slice(idx + 1);
    });
  return out;
}

function formatPortList(localPorts = [], publicPorts = []) {
  const parts = [];
  if (localPorts.length) {
    parts.push(`本地 ${localPorts.join(' / ')}`);
  }
  if (publicPorts.length) {
    parts.push(`公网 ${publicPorts.join(' / ')}`);
  }
  return parts.join(' · ');
}

async function execCommand(file, args = [], options = {}) {
  try {
    const result = await execFileAsync(file, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs || 5000,
      maxBuffer: options.maxBuffer || COMMAND_MAX_BUFFER
    });
    return {
      ok: true,
      stdout: result.stdout || '',
      stderr: result.stderr || ''
    };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout || '',
      stderr: error.stderr || '',
      error
    };
  }
}

async function probeHttp(url, options = {}) {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(options.timeoutMs || 4000)
    });
    const body = await response.text().catch(() => '');
    return {
      label: options.label || url,
      kind: 'http',
      url,
      ok: response.status >= 200 && response.status < 300,
      status_code: response.status,
      latency_ms: Date.now() - startedAt,
      summary: `${response.status} · ${Date.now() - startedAt}ms`,
      body_excerpt: truncateText(body, 240)
    };
  } catch (error) {
    const message =
      error?.name === 'TimeoutError' || error?.code === 'ABORT_ERR'
        ? 'timeout'
        : error?.message || 'request_failed';
    return {
      label: options.label || url,
      kind: 'http',
      url,
      ok: false,
      status_code: 0,
      latency_ms: Date.now() - startedAt,
      summary: message,
      error: message
    };
  }
}

async function readSystemdService(serviceName) {
  const result = await execCommand('systemctl', [
    'show',
    serviceName,
    '--property=Id,Description,LoadState,ActiveState,SubState,MainPID,ExecMainStartTimestamp,UnitFileState'
  ]);

  if (!result.ok) {
    return {
      ok: false,
      service_name: serviceName,
      summary: truncateText(result.stderr || result.stdout || result.error?.message || 'systemctl_show_failed', 300)
    };
  }

  const raw = parseKeyValueOutput(result.stdout);
  const mainPid = Number(raw.MainPID || 0);
  const activeState = String(raw.ActiveState || '').trim();
  const subState = String(raw.SubState || '').trim();
  return {
    ok: activeState === 'active',
    service_name: String(raw.Id || serviceName).trim() || serviceName,
    description: String(raw.Description || '').trim(),
    load_state: String(raw.LoadState || '').trim(),
    active_state: activeState,
    sub_state: subState,
    main_pid: Number.isFinite(mainPid) ? mainPid : 0,
    started_at: String(raw.ExecMainStartTimestamp || '').trim(),
    unit_file_state: String(raw.UnitFileState || '').trim(),
    summary: activeState ? `${activeState}${subState ? ` / ${subState}` : ''}` : 'unknown'
  };
}

async function readTmuxSession(sessionName) {
  const result = await execCommand('tmux', ['has-session', '-t', sessionName], {
    timeoutMs: 2500
  });
  return {
    ok: result.ok,
    type: 'tmux',
    session_name: sessionName,
    summary: result.ok ? `tmux ${sessionName} active` : `tmux ${sessionName} missing`
  };
}

async function readProcessMatch(pattern) {
  const result = await execCommand('pgrep', ['-af', pattern], {
    timeoutMs: 2500
  });

  if (!result.ok) {
    const code = Number(result.error?.code);
    if (code === 1) {
      return {
        ok: false,
        type: 'process',
        pattern,
        running: false,
        pid: 0,
        command: '',
        summary: 'process_missing'
      };
    }
    return {
      ok: false,
      type: 'process',
      pattern,
      running: false,
      pid: 0,
      command: '',
      summary: truncateText(result.stderr || result.stdout || result.error?.message || 'pgrep_failed', 300)
    };
  }

  const firstLine = String(result.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) {
    return {
      ok: false,
      type: 'process',
      pattern,
      running: false,
      pid: 0,
      command: '',
      summary: 'process_missing'
    };
  }

  const match = firstLine.match(/^(\d+)\s+(.*)$/);
  return {
    ok: Boolean(match),
    type: 'process',
    pattern,
    running: Boolean(match),
    pid: match ? Number(match[1]) : 0,
    command: match ? match[2] : firstLine,
    summary: match ? `pid ${match[1]}` : firstLine
  };
}

function buildTargets(rootDir) {
  const scriptsDir = path.join(rootDir, 'scripts');
  return [
    {
      id: 'site-web',
      label: '官网后端 8888',
      group: '入口链路',
      description: '官网页面与站点 API 后端。',
      local_ports: ['8888'],
      public_ports: ['7791'],
      controller: { type: 'tmux', session_name: 'jgzj-site' },
      restart: {
        type: 'script',
        file: path.join(scriptsDir, 'restart-site-detached.sh'),
        args: [],
        timeout_ms: 5000,
        async: true
      },
      checks: [
        { label: '本地 8888 /healthz', url: 'http://127.0.0.1:8888/healthz', required: true }
      ]
    },
    {
      id: 'frpc-public',
      label: 'FRP 公网转发',
      group: '入口链路',
      description: '负责 7790 / 7791 映射到本机服务。',
      local_ports: [],
      public_ports: ['7790', '7791'],
      controller: {
        type: 'process',
        pattern: '/home/admin1/frp/frp_0.65.0_linux_amd64/frpc.toml'
      },
      restart: {
        type: 'script',
        file: path.join(scriptsDir, 'restart-frpc.sh'),
        args: [],
        timeout_ms: 30000
      },
      checks: [
        { label: '公网 7790 /healthz', url: 'http://idtrd.kmdns.net:7790/healthz', required: false },
        { label: '公网 7791 /healthz', url: 'http://idtrd.kmdns.net:7791/healthz', required: false }
      ]
    },
    {
      id: 'chat-bridge-8050',
      label: '对话桥 8050',
      group: '对话链路',
      description: '生产文本对话与 TTS 桥接入口。',
      local_ports: ['8050'],
      public_ports: ['7790'],
      controller: { type: 'systemd', service_name: 'jgzj-chat-bridge-8050-qwen35.service' },
      restart: {
        type: 'script',
        file: path.join(scriptsDir, 'switch_jgzj_llm_chain.sh'),
        args: ['qwen35'],
        timeout_ms: 60000
      },
      checks: [
        { label: '本地 8050 /healthz', url: 'http://127.0.0.1:8050/healthz', required: true }
      ]
    },
    {
      id: 'intent-8022',
      label: '意图编排 8022',
      group: '对话链路',
      description: '生产意图、RAG 与工具编排服务。',
      local_ports: ['8022'],
      public_ports: [],
      controller: { type: 'systemd', service_name: 'jgzj-intent-v2-8022-failover.service' },
      restart: {
        type: 'script',
        file: path.join(scriptsDir, 'switch_jgzj_intent_llm.sh'),
        args: ['failover'],
        timeout_ms: 60000
      },
      checks: [
        { label: '本地 8022 /healthz', url: 'http://127.0.0.1:8022/healthz', required: true }
      ]
    },
    {
      id: 'llm-failover-8043',
      label: 'LLM Failover 8043',
      group: '对话链路',
      description: 'Qwen3.6 主路与 Qwen3.5 备用切换层。',
      local_ports: ['8043'],
      public_ports: [],
      controller: { type: 'systemd', service_name: 'jgzj-llm-failover-8043.service' },
      restart: {
        type: 'systemd',
        service_name: 'jgzj-llm-failover-8043.service',
        timeout_ms: 45000
      },
      checks: [
        { label: '本地 8043 /healthz', url: 'http://127.0.0.1:8043/healthz', required: true },
        { label: '本地 8043 /health/detail', url: 'http://127.0.0.1:8043/health/detail', required: false }
      ]
    },
    {
      id: 'qwen36-compat-8042',
      label: 'Qwen3.6 Compat 8042',
      group: '模型链路',
      description: 'Qwen3.6 文本兼容层。',
      local_ports: ['8042'],
      public_ports: [],
      controller: { type: 'systemd', service_name: 'jgzj-qwen36-compat-8042.service' },
      restart: {
        type: 'systemd',
        service_name: 'jgzj-qwen36-compat-8042.service',
        timeout_ms: 45000
      },
      checks: [
        { label: '本地 8042 /healthz', url: 'http://127.0.0.1:8042/healthz', required: true }
      ]
    },
    {
      id: 'qwen36-text-18000',
      label: 'Qwen3.6 文本隧道 18000',
      group: '模型链路',
      description: 'A100 文本 vLLM SSH tunnel。',
      local_ports: ['18000'],
      public_ports: [],
      controller: { type: 'systemd', service_name: 'jgzj-qwen36-text-tunnel.service' },
      restart: {
        type: 'systemd',
        service_name: 'jgzj-qwen36-text-tunnel.service',
        timeout_ms: 45000
      },
      checks: [
        { label: '本地 18000 /v1/models', url: 'http://127.0.0.1:18000/v1/models', required: true }
      ]
    },
    {
      id: 'qwen36-mm-18001',
      label: 'Qwen3.6 多模态隧道 18001',
      group: '模型链路',
      description: 'A100 多模态 vLLM SSH tunnel。',
      local_ports: ['18001'],
      public_ports: [],
      controller: { type: 'systemd', service_name: 'jgzj-qwen36-mm-tunnel.service' },
      restart: {
        type: 'systemd',
        service_name: 'jgzj-qwen36-mm-tunnel.service',
        timeout_ms: 45000
      },
      checks: [
        { label: '本地 18001 /v1/models', url: 'http://127.0.0.1:18001/v1/models', required: true }
      ]
    }
  ];
}

async function sampleController(target) {
  if (!target?.controller) {
    return { ok: true, type: 'none', summary: 'no_controller' };
  }

  if (target.controller.type === 'systemd') {
    return readSystemdService(target.controller.service_name);
  }
  if (target.controller.type === 'tmux') {
    return readTmuxSession(target.controller.session_name);
  }
  if (target.controller.type === 'process') {
    return readProcessMatch(target.controller.pattern);
  }
  return { ok: false, type: 'unknown', summary: 'unsupported_controller' };
}

function summarizeTargetState(controller, checks, target) {
  const requiredChecks = checks.filter((item) => item.required);
  const optionalChecks = checks.filter((item) => !item.required);
  const requiredOk = requiredChecks.every((item) => item.ok);
  const optionalOk = optionalChecks.every((item) => item.ok);

  if (!controller.ok) {
    return {
      state: 'error',
      status_text: controller.summary || '控制器未运行'
    };
  }

  if (requiredChecks.length && !requiredOk) {
    return {
      state: 'error',
      status_text: `${target.label} 健康检查失败`
    };
  }

  if (optionalChecks.length && !optionalOk) {
    return {
      state: 'warn',
      status_text: `${target.label} 部分端口异常`
    };
  }

  return {
    state: 'ok',
    status_text: `${target.label} 运行正常`
  };
}

async function sampleTarget(target) {
  const controller = await sampleController(target);
  const checks = await Promise.all(
    (target.checks || []).map(async (item) => ({
      ...item,
      ...(await probeHttp(item.url, { label: item.label }))
    }))
  );
  const summary = summarizeTargetState(controller, checks, target);
  return {
    id: target.id,
    label: target.label,
    group: target.group,
    description: target.description,
    local_ports: target.local_ports || [],
    public_ports: target.public_ports || [],
    port_text: formatPortList(target.local_ports, target.public_ports),
    controller,
    checks,
    state: summary.state,
    status_text: summary.status_text,
    restart_required_auth: true,
    updated_at: new Date().toISOString()
  };
}

async function restartTarget(target, rootDir) {
  if (!target?.restart) {
    throw new Error('target_restart_not_configured');
  }

  if (target.restart.type === 'script') {
    return execCommand('bash', [target.restart.file, ...(target.restart.args || [])], {
      cwd: rootDir,
      timeoutMs: target.restart.timeout_ms || 60000
    });
  }

  if (target.restart.type === 'systemd') {
    const stopResult = await execCommand(
      'sudo',
      ['-n', 'systemctl', 'stop', target.restart.service_name],
      { timeoutMs: Math.min(target.restart.timeout_ms || 45000, 20000) }
    );
    if (!stopResult.ok) {
      return stopResult;
    }
    return execCommand(
      'sudo',
      ['-n', 'systemctl', 'start', target.restart.service_name],
      { timeoutMs: target.restart.timeout_ms || 45000 }
    );
  }

  throw new Error('unsupported_restart_type');
}

function buildQueuedNode(target) {
  return {
    id: target.id,
    label: target.label,
    group: target.group,
    description: target.description,
    local_ports: target.local_ports || [],
    public_ports: target.public_ports || [],
    port_text: formatPortList(target.local_ports, target.public_ports),
    controller: {
      ok: true,
      type: target.controller?.type || 'unknown',
      summary: 'restart_queued'
    },
    checks: [],
    state: 'warn',
    status_text: `${target.label} 已发起重启，等待恢复`,
    restart_required_auth: true,
    updated_at: new Date().toISOString()
  };
}

function registerRuntimeControlRoutes(app, options = {}) {
  const rootDir = path.resolve(options.rootDir || path.resolve(__dirname, '..'));
  const requireOpenClawAuth = options.requireOpenClawAuth;
  const getOpenClawAuthFromRequest =
    typeof options.getOpenClawAuthFromRequest === 'function'
      ? options.getOpenClawAuthFromRequest
      : () => null;
  const refreshTtlMs = Number(options.refreshTtlMs || DEFAULT_REFRESH_TTL_MS);
  const targets = buildTargets(rootDir);
  const targetMap = new Map(targets.map((item) => [item.id, item]));
  const restartLocks = new Set();
  let cachedSnapshot = { expires_at: 0, data: null };

  async function sampleAllTargets(force = false) {
    const now = Date.now();
    if (!force && cachedSnapshot.data && cachedSnapshot.expires_at > now) {
      return cachedSnapshot.data;
    }
    const nodes = await Promise.all(targets.map((item) => sampleTarget(item)));
    const snapshot = {
      ok: true,
      refreshed_at: new Date().toISOString(),
      nodes
    };
    cachedSnapshot = {
      expires_at: now + refreshTtlMs,
      data: snapshot
    };
    return snapshot;
  }

  app.get('/api/cloud-ops/runtime/status', async (req, res) => {
    try {
      const snapshot = await sampleAllTargets(false);
      return res.json({
        ...snapshot,
        authenticated: Boolean(getOpenClawAuthFromRequest(req))
      });
    } catch (error) {
      return res.status(502).json({
        ok: false,
        authenticated: Boolean(getOpenClawAuthFromRequest(req)),
        detail: error?.message || 'runtime_status_failed'
      });
    }
  });

  app.post('/api/cloud-ops/runtime/restart', requireOpenClawAuth, async (req, res) => {
    const targetId = String(req.body?.target_id || '').trim();
    if (!targetId || !targetMap.has(targetId)) {
      return res.status(400).json({
        ok: false,
        detail: 'runtime_target_invalid'
      });
    }

    if (restartLocks.has(targetId)) {
      return res.status(409).json({
        ok: false,
        detail: 'runtime_target_busy'
      });
    }

    const target = targetMap.get(targetId);
    restartLocks.add(targetId);
    cachedSnapshot = { expires_at: 0, data: null };

    try {
      const commandResult = await restartTarget(target, rootDir);
      const queued = Boolean(target.restart?.async);
      const node = queued
        ? buildQueuedNode(target)
        : await (async () => {
            await new Promise((resolve) => setTimeout(resolve, 1200));
            return sampleTarget(target);
          })();
      const payload = {
        ok: commandResult.ok,
        queued,
        target_id: targetId,
        summary: commandResult.ok
          ? queued
            ? `${target.label} 已发起重启，页面会自动刷新。`
            : `${target.label} 已执行重启。`
          : `${target.label} 重启失败。`,
        node,
        stdout: truncateText(commandResult.stdout, 4000),
        stderr: truncateText(commandResult.stderr, 4000)
      };
      if (!commandResult.ok) {
        return res.status(502).json({
          ...payload,
          detail:
            commandResult.error?.message ||
            commandResult.stderr ||
            commandResult.stdout ||
            'runtime_restart_failed'
        });
      }
      cachedSnapshot = { expires_at: 0, data: null };
      return res.json(payload);
    } finally {
      restartLocks.delete(targetId);
    }
  });
}

module.exports = registerRuntimeControlRoutes;
