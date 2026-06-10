const path = require('path');
const fs = require('fs/promises');
const net = require('net');
const { execFile, spawn } = require('child_process');
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

function formatAutoStartScript(scriptName) {
  return scriptName ? `/home/admin1/.auto_start/${scriptName}` : '';
}

function formatDuration(seconds) {
  const value = Math.max(0, Number.parseInt(String(seconds ?? ''), 10) || 0);
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  if (days) return `${days}天${hours}小时`;
  if (hours) return `${hours}小时${minutes}分钟`;
  return `${minutes}分钟`;
}

function weatherCodeText(code) {
  const key = Number.parseInt(String(code ?? ''), 10);
  const mapping = new Map([
    [0, '晴'],
    [1, '大部晴朗'],
    [2, '多云'],
    [3, '阴'],
    [45, '有雾'],
    [48, '有雾'],
    [51, '小毛毛雨'],
    [53, '毛毛雨'],
    [55, '大毛毛雨'],
    [56, '冻毛毛雨'],
    [57, '冻毛毛雨'],
    [61, '小雨'],
    [63, '中雨'],
    [65, '大雨'],
    [66, '冻雨'],
    [67, '冻雨'],
    [71, '小雪'],
    [73, '中雪'],
    [75, '大雪'],
    [77, '雪粒'],
    [80, '阵雨'],
    [81, '阵雨'],
    [82, '强阵雨'],
    [85, '阵雪'],
    [86, '强阵雪'],
    [95, '雷阵雨'],
    [96, '雷阵雨伴冰雹'],
    [99, '强雷阵雨伴冰雹']
  ]);
  return mapping.get(key) || (Number.isFinite(key) ? `天气码${key}` : '-');
}

function findWeatherCity(cities, cityName) {
  const name = String(cityName || '深圳').trim() || '深圳';
  const fullName = name.endsWith('市') ? name : `${name}市`;
  return (Array.isArray(cities) ? cities : []).find(
    (item) => item?.name === name || item?.full_name === fullName
  );
}

function dailyValue(daily, index, field) {
  const values = Array.isArray(daily?.[field]) ? daily[field] : [];
  return index >= 0 && index < values.length ? values[index] : null;
}

async function sampleWeatherCacheStatus(options = {}) {
  const cachePath = path.resolve(
    options.path || '/home/admin1/CloudVoice/multi_car_asr_demo/ai2_backend/runtime_cache/weather_cn_city_level_7d.json'
  );
  const staleThresholdSec = Math.max(
    600,
    Number.parseInt(String(options.stale_threshold_sec ?? process.env.WEATHER_CACHE_STALE_S ?? '7200'), 10) || 7200
  );
  const cityName = String(options.city || process.env.WEATHER_STATUS_CITY || '深圳').trim() || '深圳';

  let payload;
  try {
    payload = JSON.parse(await fs.readFile(cachePath, 'utf8'));
  } catch (error) {
    return {
      kind: 'weather-cache',
      ok: false,
      state: 'error',
      summary: `天气缓存读取失败：${error?.message || 'read_failed'}`,
      path: cachePath
    };
  }

  const generatedAtTs = Number(payload?._generated_at_ts || 0);
  const ageSec = generatedAtTs > 0 ? Math.max(0, Math.floor(Date.now() / 1000 - generatedAtTs)) : null;
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
  const city = findWeatherCity(data.cities, cityName);
  const current = city?.current || {};
  const daily = city?.daily || {};
  const dates = Array.isArray(daily.time) ? daily.time : [];
  const todayIso = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
  const todayIndex = dates.includes(todayIso) ? dates.indexOf(todayIso) : dates.length ? 0 : -1;
  const todayPop = dailyValue(daily, todayIndex, 'precipitation_probability_max');
  const todayMax = dailyValue(daily, todayIndex, 'temperature_2m_max');
  const todayMin = dailyValue(daily, todayIndex, 'temperature_2m_min');
  const stale = ageSec === null || ageSec > staleThresholdSec;
  const currentTemp = Number(current.temperature_2m);
  const tempText = Number.isFinite(currentTemp) ? `${Math.round(currentTemp)}度` : '-';
  const popText = Number.isFinite(Number(todayPop)) ? `${Math.round(Number(todayPop))}%` : '-';
  const rangeText =
    Number.isFinite(Number(todayMin)) && Number.isFinite(Number(todayMax))
      ? `${Math.round(Number(todayMin))}-${Math.round(Number(todayMax))}度`
      : '-';

  return {
    kind: 'weather-cache',
    ok: true,
    state: stale ? 'warn' : 'ok',
    summary:
      `缓存 ${payload?._generated_at_iso || '-'}，缓存年龄 ${ageSec === null ? '-' : formatDuration(ageSec)}；` +
      `${city?.full_name || city?.name || cityName} ${current.time || '-'} ${weatherCodeText(current.weather_code)} ` +
      `${tempText}，今日 ${rangeText}，降水概率 ${popText}，城市 ${data.city_count ?? '-'}，错误 ${data.error_count ?? '-'}`,
    path: cachePath,
    stale,
    stale_threshold_sec: staleThresholdSec,
    generated_at_iso: payload?._generated_at_iso || '',
    age_sec: ageSec,
    source: data.source || '',
    city: {
      name: city?.full_name || city?.name || cityName,
      current_time: current.time || '',
      weather_text: weatherCodeText(current.weather_code),
      temperature_2m: current.temperature_2m,
      precipitation: current.precipitation,
      today_pop: todayPop,
      today_min: todayMin,
      today_max: todayMax
    }
  };
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
    const contentType = response.headers.get('content-type') || '';
    let payload = null;
    if (contentType.includes('application/json') || /^[\[{]/.test(String(body || '').trim())) {
      try {
        payload = JSON.parse(body);
      } catch (_error) {
        payload = null;
      }
    }
    const payloadOk =
      payload && typeof payload === 'object' && typeof payload.ok === 'boolean'
        ? payload.ok
        : null;
    const ok = response.status >= 200 && response.status < 300 && payloadOk !== false;
    const payloadState =
      payload && typeof payload === 'object' && typeof payload.state === 'string'
        ? String(payload.state).trim()
        : '';
    const state = payloadState || (ok ? 'ok' : 'error');
    const payloadSummary =
      payload && typeof payload === 'object' && payload.summary
        ? String(payload.summary).trim()
        : '';
    const latencyMs = Date.now() - startedAt;
    return {
      label: options.label || url,
      kind: 'http',
      url,
      ok,
      state,
      status_code: response.status,
      latency_ms: latencyMs,
      summary: payloadSummary ? `${payloadSummary} · ${latencyMs}ms` : `${response.status} · ${latencyMs}ms`,
      payload,
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
      state: 'error',
      status_code: 0,
      latency_ms: Date.now() - startedAt,
      summary: message,
      error: message
    };
  }
}

async function probeTcp(options = {}) {
  const startedAt = Date.now();
  const host = options.host || '127.0.0.1';
  const port = Number(options.port);
  const timeoutMs = Number(options.timeoutMs || 2500);

  if (!Number.isFinite(port) || port <= 0) {
    return {
      label: options.label || `${host}:${options.port}`,
      kind: 'tcp',
      host,
      port: options.port,
      ok: false,
      state: 'error',
      latency_ms: 0,
      summary: 'invalid_port',
      error: 'invalid_port'
    };
  }

  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({
        label: options.label || `${host}:${port}`,
        kind: 'tcp',
        host,
        port,
        latency_ms: Date.now() - startedAt,
        ...payload
      });
    };

    socket.setTimeout(timeoutMs);
    socket.on('connect', () => {
      finish({
        ok: true,
        state: 'ok',
        summary: `tcp ok · ${Date.now() - startedAt}ms`
      });
    });
    socket.on('timeout', () => {
      finish({
        ok: false,
        state: 'error',
        summary: 'tcp timeout',
        error: 'timeout'
      });
    });
    socket.on('error', (error) => {
      finish({
        ok: false,
        state: 'error',
        summary: error?.message || 'tcp_failed',
        error: error?.message || 'tcp_failed'
      });
    });
  });
}

async function readSystemdService(serviceName, options = {}) {
  const args = [
    ...(options.user ? ['--user'] : []),
    'show',
    serviceName,
    '--property=Id,Description,LoadState,ActiveState,SubState,MainPID,ExecMainStartTimestamp,UnitFileState'
  ];
  const result = await execCommand('systemctl', args);

  if (!result.ok) {
    return {
      ok: false,
      type: options.user ? 'systemd-user' : 'systemd',
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
    type: options.user ? 'systemd-user' : 'systemd',
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

function buildTargets() {
  const autoStartDir = process.env.AUTO_START_DIR || '/home/admin1/.auto_start';
  const cloudVoiceRoot = '/home/admin1/CloudVoice/multi_car_asr_demo';
  const dedicatedTtsHubScript = path.join(cloudVoiceRoot, 'manage_dedicated_tts_hub.sh');
  const dedicatedTtsPoolScript = path.join(cloudVoiceRoot, 'manage_dedicated_tts_pool.sh');
  const dedicatedTtsCommonEnv = {
    DATA_DIR: '/home/admin1/futian_voicehub/uploads',
    LLM_URL: 'http://127.0.0.1:8041/chat'
  };
  const dedicatedTtsWorkers = [
    { id: 'tts-worker-8804', label: 'TTS worker gpu3', port: '8804', visible: '3' },
    { id: 'tts-worker-8795', label: 'TTS worker gpu6', port: '8795', visible: '6' },
    { id: 'tts-worker-8796', label: 'TTS worker gpu4', port: '8796', visible: '4' },
    { id: 'tts-worker-8805', label: 'TTS worker gpu0', port: '8805', visible: '0' },
    { id: 'tts-worker-8806', label: 'TTS worker gpu5', port: '8806', visible: '5' }
  ];
  return [
    {
      id: 'qwen36-tunnels',
      label: 'Qwen3.6 A100 隧道',
      group: '模型入口',
      description: 'A100 文本与多模态 vLLM SSH tunnel，供对话链和图片输入链路使用。',
      local_ports: ['18000', '18001'],
      public_ports: [],
      script: formatAutoStartScript('01_qwen36_tunnels.sh'),
      controller: { type: 'process', pattern: 'ssh .*jgzj_qwen36_proxy_ed25519 .*127\\.0\\.0\\.1:(18000|18001)' },
      restart: {
        type: 'script',
        file: path.join(autoStartDir, '01_qwen36_tunnels.sh'),
        args: ['restart'],
        timeout_ms: 90000
      },
      checks: [
        { label: '18000 Qwen3.6 text tunnel TCP', type: 'tcp', host: '127.0.0.1', port: 18000, required: true },
        { label: '18001 Qwen3.6 MM tunnel TCP', type: 'tcp', host: '127.0.0.1', port: 18001, required: true }
      ]
    },
    {
      id: 'a100-qwen36-llm-8000',
      label: 'A100 Qwen3.6 LLM GPU0',
      group: 'A100 远端业务',
      description: '远端 A100 GPU0 上的 Qwen3.6-27B 文本 vLLM，真实服务端口 8000，经本机 18000 隧道访问。',
      local_ports: ['18000'],
      public_ports: [],
      script: formatAutoStartScript('09_a100_qwen36_llm_8000.sh'),
      restart: {
        type: 'script',
        file: path.join(autoStartDir, '09_a100_qwen36_llm_8000.sh'),
        args: ['restart'],
        timeout_ms: 600000
      },
      checks: [
        { label: 'A100 8000 via 18000 TCP', type: 'tcp', host: '127.0.0.1', port: 18000, required: true }
      ]
    },
    {
      id: 'a100-qwen36-vlm-8001',
      label: 'A100 Qwen3.6 VLM GPU1',
      group: 'A100 远端业务',
      description: '远端 A100 GPU1 上的 Qwen3.6-27B-MM 多模态 vLLM，真实服务端口 8001，经本机 18001 隧道访问。',
      local_ports: ['18001'],
      public_ports: [],
      script: formatAutoStartScript('10_a100_qwen36_vlm_8001.sh'),
      restart: {
        type: 'script',
        file: path.join(autoStartDir, '10_a100_qwen36_vlm_8001.sh'),
        args: ['restart'],
        timeout_ms: 600000
      },
      checks: [
        { label: 'A100 8001 via 18001 TCP', type: 'tcp', host: '127.0.0.1', port: 18001, required: true }
      ]
    },
    {
      id: 'a100-tts-pool-8909',
      label: 'A100 TTS Pool GPU2',
      group: 'A100 远端业务',
      description: '远端 A100 GPU2 上的 5 路 CosyVoice TTS 池，真实 LB 端口 8909，经本机 18109 隧道访问。',
      local_ports: ['18109'],
      public_ports: [],
      script: formatAutoStartScript('11_a100_tts_pool_8909.sh'),
      restart: {
        type: 'script',
        file: path.join(autoStartDir, '11_a100_tts_pool_8909.sh'),
        args: ['restart'],
        timeout_ms: 600000
      },
      checks: [
        { label: 'A100 8909 via 18109 /healthz', url: 'http://127.0.0.1:18109/healthz', required: true }
      ]
    },
    {
      id: 'cloudvoice-7790-prod',
      label: 'CloudVoice 生产对话链',
      group: '语音对话',
      description: '公网 7790：生产文本对话、工具/RAG、LLM failover 与 TTS 输出主链路。',
      local_ports: ['8040', '8041', '8043', '8022', '8050', '8799'],
      public_ports: ['7790'],
      script: formatAutoStartScript('02_cloudvoice_7790_prod.sh'),
      controller: { type: 'process', pattern: 'intent_chat_tts_bridge\\.py .*--port 8050' },
      restart: {
        type: 'script',
        file: path.join(autoStartDir, '02_cloudvoice_7790_prod.sh'),
        args: ['restart'],
        timeout_ms: 900000
      },
      checks: [
        { label: '8043 failover /healthz', url: 'http://127.0.0.1:8043/healthz', required: true },
        { label: '8022 intent /healthz', url: 'http://127.0.0.1:8022/healthz', required: true },
        { label: '8050 bridge /healthz', url: 'http://127.0.0.1:8050/healthz', required: true },
        {
          label: '8799 TTS pool /healthz',
          url: 'http://127.0.0.1:8799/healthz',
          required: true,
          restart_target_id: 'tts-pool-8799',
          restart_target_label: 'TTS pool 8799'
        },
        { label: '8041 Qwen3.5 compat /healthz', url: 'http://127.0.0.1:8041/healthz', required: true },
        { label: '8040 Qwen3.5 fallback /v1/models', url: 'http://127.0.0.1:8040/v1/models', required: false },
        { label: '18000 Qwen3.6 text /v1/models', url: 'http://127.0.0.1:18000/v1/models', required: false },
        {
          label: '8804 TTS worker gpu3',
          url: 'http://127.0.0.1:8804/healthz',
          required: false,
          restart_target_id: 'tts-worker-8804',
          restart_target_label: 'TTS worker gpu3'
        },
        {
          label: '8795 TTS worker gpu6',
          url: 'http://127.0.0.1:8795/healthz',
          required: false,
          restart_target_id: 'tts-worker-8795',
          restart_target_label: 'TTS worker gpu6'
        },
        {
          label: '8796 TTS worker gpu4',
          url: 'http://127.0.0.1:8796/healthz',
          required: false,
          restart_target_id: 'tts-worker-8796',
          restart_target_label: 'TTS worker gpu4'
        },
        {
          label: '8805 TTS worker gpu0',
          url: 'http://127.0.0.1:8805/healthz',
          required: false,
          restart_target_id: 'tts-worker-8805',
          restart_target_label: 'TTS worker gpu0'
        },
        {
          label: '8806 TTS worker gpu5',
          url: 'http://127.0.0.1:8806/healthz',
          required: false,
          restart_target_id: 'tts-worker-8806',
          restart_target_label: 'TTS worker gpu5'
        },
        { label: '公网 7790 /healthz', url: 'http://idtrd.kmdns.net:7790/healthz', required: false }
      ]
    },
    {
      id: 'cloudvoice-8051-gray',
      label: 'CloudVoice 灰度链 8051',
      group: '语音对话',
      description: 'Qwen3.6 灰度对话链，用于和生产 8050 链路对比验证。',
      local_ports: ['8042', '8024', '8051'],
      public_ports: [],
      script: formatAutoStartScript('03_cloudvoice_gray_8051.sh'),
      controller: { type: 'process', pattern: 'intent_chat_tts_bridge\\.py .*--port 8051' },
      restart: {
        type: 'script',
        file: path.join(autoStartDir, '03_cloudvoice_gray_8051.sh'),
        args: ['restart'],
        timeout_ms: 180000
      },
      checks: [
        { label: '8042 Qwen3.6 compat /healthz', url: 'http://127.0.0.1:8042/healthz', required: true },
        { label: '8024 gray intent /healthz', url: 'http://127.0.0.1:8024/healthz', required: true },
        { label: '8051 gray bridge /healthz', url: 'http://127.0.0.1:8051/healthz', required: true }
      ]
    },
    {
      id: 'weather-cache-updater',
      label: '天气缓存更新器',
      group: '语音对话',
      description: '天气问答使用的全国城市 7 天缓存；重点监控深圳缓存时间、当前天气和更新器进程。',
      action_label: '更新',
      action_busy_label: '更新中...',
      local_ports: [],
      public_ports: [],
      script: path.join(cloudVoiceRoot, 'manage_tool_cache_updater.sh'),
      controller: { type: 'process', pattern: `${cloudVoiceRoot}/tool_cache_updater\\.py` },
      restart: {
        type: 'script',
        file: path.join(cloudVoiceRoot, 'manage_tool_cache_updater.sh'),
        args: ['update'],
        timeout_ms: 300000
      },
      checks: [
        {
          label: '深圳天气缓存',
          type: 'weather-cache',
          path: path.join(cloudVoiceRoot, 'ai2_backend/runtime_cache/weather_cn_city_level_7d.json'),
          city: '深圳',
          stale_threshold_sec: 7200,
          required: true
        }
      ]
    },
    {
      id: 'tts-pool-8799',
      label: 'TTS pool 8799',
      group: '语音对话',
      hidden: true,
      description: '7790 主链使用的 TTS 负载均衡池，可单独重启，不影响 8050/8022/8043。',
      local_ports: ['8799'],
      public_ports: [],
      script: dedicatedTtsPoolScript,
      controller: { type: 'process', pattern: 'dedicated_tts_pool_lb\\.py .*--port 8799' },
      restart: {
        type: 'script',
        file: dedicatedTtsPoolScript,
        args: ['restart'],
        env: {
          ...dedicatedTtsCommonEnv,
          TTS_POOL_PORT: '8799'
        },
        timeout_ms: 180000
      },
      checks: [{ label: '8799 TTS pool /healthz', url: 'http://127.0.0.1:8799/healthz', required: true }]
    },
    ...dedicatedTtsWorkers.map((worker) => ({
      id: worker.id,
      label: worker.label,
      group: '语音对话',
      hidden: true,
      description: `7790 TTS 单 worker，可单独重启。当前端口 ${worker.port}，CUDA_VISIBLE_DEVICES=${worker.visible}。`,
      local_ports: [worker.port],
      public_ports: [],
      script: dedicatedTtsHubScript,
      controller: { type: 'process', pattern: `dedicated_tts_hub\\.py .*--port ${worker.port}( |$)` },
      restart: {
        type: 'script',
        file: dedicatedTtsHubScript,
        args: ['restart'],
        env: {
          ...dedicatedTtsCommonEnv,
          TTS_PORT: worker.port,
          CUDA_VISIBLE: worker.visible,
          TTS_DEVICE: 'cuda:0',
          ASR_DEVICE: 'cuda:0'
        },
        timeout_ms: 180000
      },
      checks: [{ label: `${worker.port} /healthz`, url: `http://127.0.0.1:${worker.port}/healthz`, required: true }]
    })),
    {
      id: 'qwen-vl-7789',
      label: 'Qwen3-VL-2B 图片检测',
      group: '视觉检测',
      description: '公网 7789：车端图片事件复核 WebSocket，后端为 Qwen3-VL-2B。',
      local_ports: ['8012', '8794'],
      public_ports: ['7789'],
      script: formatAutoStartScript('04_qwen_vl_7789.sh'),
      controller: { type: 'process', pattern: 'qwen_ws_checker_service\\.py .*--port 8794' },
      restart: {
        type: 'script',
        file: path.join(autoStartDir, '04_qwen_vl_7789.sh'),
        args: ['restart'],
        timeout_ms: 600000
      },
      checks: [
        { label: '8012 Qwen-VL /v1/models', url: 'http://127.0.0.1:8012/v1/models', required: true },
        { label: '8794 checker /healthz', url: 'http://127.0.0.1:8794/healthz', required: true },
        { label: '公网 7789 /healthz', url: 'http://idtrd.kmdns.net:7789/healthz', required: false }
      ]
    },
    {
      id: 'cloud-control-7788',
      label: 'cloud-agent 车端运维',
      group: '车端运维',
      description: '公网 7788：车端 WebSocket 接入、车辆状态、工具调用和运维控制。',
      local_ports: ['8000'],
      public_ports: ['7788'],
      script: formatAutoStartScript('05_cloud_control_7788.sh'),
      controller: { type: 'tmux', session_name: 'cloud-agent' },
      restart: {
        type: 'script',
        file: path.join(autoStartDir, '05_cloud_control_7788.sh'),
        args: ['restart'],
        timeout_ms: 90000
      },
      checks: [
        { label: '8000 cloud-agent /healthz', url: 'http://127.0.0.1:8000/healthz', required: true },
        { label: '公网 7788 /healthz', url: 'http://idtrd.kmdns.net:7788/healthz', required: false }
      ]
    },
    {
      id: 'jgzj-site-7791',
      label: 'JGZJ 官网 7791',
      group: '站点入口',
      description: '公网 7791：jgzj 官网前后端一体服务。',
      local_ports: ['8888'],
      public_ports: ['7791'],
      script: formatAutoStartScript('06_jgzj_site_7791.sh'),
      controller: { type: 'systemd', service_name: 'jgzj-site.service' },
      restart: {
        type: 'systemd',
        service_name: 'jgzj-site.service',
        timeout_ms: 45000
      },
      checks: [
        { label: '8888 site /healthz', url: 'http://127.0.0.1:8888/healthz', required: true },
        { label: '公网 7791 /healthz', url: 'http://idtrd.kmdns.net:7791/healthz', required: false }
      ]
    },
    {
      id: 'openclaw-gateway',
      label: 'OpenClaw Gateway',
      group: '自然语言运维',
      description: '网站内自然语言运维代理网关，依赖 OpenClaw 登录态。',
      local_ports: ['18789', '18791'],
      public_ports: [],
      script: formatAutoStartScript('07_openclaw_gateway.sh'),
      controller: { type: 'systemd-user', service_name: 'openclaw-gateway.service' },
      restart: {
        type: 'script',
        file: path.join(autoStartDir, '07_openclaw_gateway.sh'),
        args: ['restart'],
        timeout_ms: 45000
      },
      checks: []
    },
    {
      id: 'frp-public-7788-7791',
      label: 'FRP 公网映射',
      group: '公网入口',
      description: '统一维护 7788/7789/7790/7791 到本机服务的 FRP 转发。',
      local_ports: [],
      public_ports: ['7788', '7789', '7790', '7791'],
      script: formatAutoStartScript('08_frp_7788_7791.sh'),
      controller: {
        type: 'process',
        pattern: '/home/admin1/frp/frp_0\\.65\\.0_linux_amd64/frpc.*frpc\\.toml|frpc.*frp_0\\.65\\.0_linux_amd64/frpc\\.toml'
      },
      restart: {
        type: 'script',
        file: path.join(autoStartDir, '08_frp_7788_7791.sh'),
        args: ['restart'],
        timeout_ms: 60000
      },
      checks: [
        { label: '公网 7788 /healthz', url: 'http://idtrd.kmdns.net:7788/healthz', required: false },
        { label: '公网 7789 /healthz', url: 'http://idtrd.kmdns.net:7789/healthz', required: false },
        { label: '公网 7790 /healthz', url: 'http://idtrd.kmdns.net:7790/healthz', required: false },
        { label: '公网 7791 /healthz', url: 'http://idtrd.kmdns.net:7791/healthz', required: false }
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
  if (target.controller.type === 'systemd-user') {
    return readSystemdService(target.controller.service_name, { user: true });
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
  const hasWarn = checks.some((item) => item.state === 'warn');

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

  if ((optionalChecks.length && !optionalOk) || hasWarn) {
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
      ...(item.type === 'weather-cache'
        ? await sampleWeatherCacheStatus(item)
        : item.type === 'tcp'
          ? await probeTcp(item)
        : await probeHttp(item.url, { label: item.label }))
    }))
  );
  const summary = summarizeTargetState(controller, checks, target);
  return {
    id: target.id,
    label: target.label,
    group: target.group,
    hidden: Boolean(target.hidden),
    description: target.description,
    script: target.script || '',
    action_label: target.action_label || '重启',
    action_busy_label: target.action_busy_label || '',
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
    if (target.restart.async) {
      const logFile =
        target.restart.log_file ||
        path.join(rootDir, '.logs', `runtime-restart-${target.id}.log`);
      const scriptArgs = [target.restart.file, ...(target.restart.args || [])]
        .map((item) => `'${String(item).replace(/'/g, "'\\''")}'`)
        .join(' ');
      const command = [
        `mkdir -p '${path.dirname(logFile).replace(/'/g, "'\\''")}'`,
        `cd '${rootDir.replace(/'/g, "'\\''")}'`,
        `nohup bash -lc "sleep ${Number(target.restart.delay_s || 0.5)}; bash ${scriptArgs}" >> '${logFile.replace(/'/g, "'\\''")}' 2>&1 < /dev/null &`
      ].join(' && ');
      const child = spawn('bash', ['-lc', command], {
        cwd: rootDir,
        env: target.restart.env ? { ...process.env, ...target.restart.env } : process.env,
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      return {
        ok: true,
        stdout: `queued async restart: ${target.restart.file}\nlog: ${logFile}`,
        stderr: ''
      };
    }

    return execCommand('bash', [target.restart.file, ...(target.restart.args || [])], {
      cwd: rootDir,
      env: target.restart.env ? { ...process.env, ...target.restart.env } : undefined,
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
    script: target.script || '',
    action_label: target.action_label || '重启',
    action_busy_label: target.action_busy_label || '',
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
    status_text: `${target.label} 已发起${target.action_label || '重启'}，等待恢复`,
    restart_required_auth: true,
    updated_at: new Date().toISOString()
  };
}

function registerRuntimeControlRoutes(app, options = {}) {
  const requireOpenClawAuth = options.requireOpenClawAuth;
  const requirePermission = options.requirePermission;
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, '..'));
  const refreshTtlMs = Number(options.refreshTtlMs || DEFAULT_REFRESH_TTL_MS);
  const targets = buildTargets();
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

  app.get(
    '/api/cloud-ops/runtime/status',
    requirePermission ? requirePermission('runtime:read') : requireOpenClawAuth,
    async (_req, res) => {
    try {
      const snapshot = await sampleAllTargets(false);
      return res.json({
        ...snapshot,
        authenticated: true
      });
    } catch (error) {
      return res.status(502).json({
        ok: false,
        authenticated: true,
        detail: error?.message || 'runtime_status_failed'
      });
    }
    }
  );

  app.post(
    '/api/cloud-ops/runtime/restart',
    requirePermission ? requirePermission('runtime:restart') : requireOpenClawAuth,
    async (req, res) => {
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
            ? `${target.label} 已发起${target.action_label || '重启'}，页面会自动刷新。`
            : `${target.label} 已执行${target.action_label || '重启'}。`
          : `${target.label} ${target.action_label || '重启'}失败。`,
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
    }
  );
}

module.exports = registerRuntimeControlRoutes;
