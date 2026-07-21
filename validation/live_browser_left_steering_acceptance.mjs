import fs from "node:fs";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { chromium } from "/home/weilin/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";

const root = "/home/weilin/workspace/jgzj_remote_drive_20260720";
const baseUrl = "https://jgzj.dev";
const source = fs.readFileSync(`${root}/backend/auth-store.js`, "utf8");
const password = source.match(/JGZJ_OPERATOR_PASSWORD\s*\|\|\s*'([^']+)'/)?.[1];
if (!password) throw new Error("operator credential source unavailable");

const vehicleStates = [];
const mqttControlMessages = [];
const monitorErrors = [];
let monitor = null;

function startVehicleMonitor() {
  monitor = spawn("python3", [
    `${root}/validation/mqtt_vehicle_state_monitor.py`,
    "--duration",
    "120",
  ], { stdio: ["pipe", "pipe", "pipe"] });
  readline.createInterface({ input: monitor.stdout }).on("line", (line) => {
    try {
      const state = JSON.parse(line);
      if (state.event === "mqtt_control") {
        state.observed_at_ms = Date.now();
        mqttControlMessages.push(state);
        return;
      }
      if (state.event !== "mqtt_vehicle_state") {
        monitorErrors.push(line);
        return;
      }
      state.observed_at_ms = Date.now();
      vehicleStates.push(state);
    } catch {
      monitorErrors.push(line);
    }
  });
  readline.createInterface({ input: monitor.stderr }).on("line", (line) => monitorErrors.push(line));
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label} timeout`);
}

const browser = await chromium.launch({
  headless: true,
  executablePath: "/usr/bin/google-chrome",
  args: ["--disable-dev-shm-usage"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const websocketCommands = [];
const sidecarSamples = [];
const browserErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") browserErrors.push(message.text());
});
page.on("pageerror", (error) => browserErrors.push(error.message));
page.on("websocket", (websocket) => {
  websocket.on("framesent", (event) => {
    try {
      const message = JSON.parse(String(event.payload));
      if (message.endpoint === "command") websocketCommands.push(message.payload);
    } catch {
      // Ignore non-control frames.
    }
  });
});

let frame;
let acquired = false;
let sampleSidecar = false;
async function pollSidecar() {
  while (sampleSidecar) {
    try {
      const response = await fetch("http://127.0.0.1:18767/api/control/status", { cache: "no-store" });
      sidecarSamples.push({ observed_at_ms: Date.now(), ...(await response.json()) });
    } catch (error) {
      sidecarSamples.push({ observed_at_ms: Date.now(), error: error.message });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
try {
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded", timeout: 30000 });
  const login = await page.evaluate(async ({ username, secret }) => {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: secret }),
    });
    return { ok: response.ok, status: response.status };
  }, { username: "jgauto402", secret: password });
  if (!login.ok) throw new Error(`browser login failed: ${login.status}`);

  await page.goto(`${baseUrl}/app/remote-driving`, { waitUntil: "domcontentloaded", timeout: 30000 });
  const frameElement = page.locator("iframe.remote-driving-frame");
  await frameElement.waitFor({ state: "visible", timeout: 15000 });
  frame = await (await frameElement.elementHandle())?.contentFrame();
  if (!frame) throw new Error("remote drive iframe missing");
  try {
    await frame.waitForFunction(() => (
      document.querySelector("#controlSessionButton")?.disabled === false
    ), null, { timeout: 20000 });
  } catch (error) {
    const state = await frame.evaluate(() => ({
      transport: document.querySelector("#transportStatus")?.textContent?.trim(),
      control: document.querySelector("#controlStatusText")?.textContent?.trim(),
      availability: document.querySelector("#controlAvailability")?.textContent?.trim(),
      toast: document.querySelector("#toast")?.textContent?.trim(),
      buttonDisabled: document.querySelector("#controlSessionButton")?.disabled,
      script: document.querySelector('script[src*="app.js"]')?.src,
    }));
    if (state.buttonDisabled) {
      console.error(JSON.stringify({ state, browserErrors }, null, 2));
      throw error;
    }
  }

  startVehicleMonitor();
  await waitFor(() => vehicleStates.length >= 3, 5000, "initial MQTT vehicle state");
  const initial = vehicleStates.at(-1);
  if (!initial.ready || initial.gear !== 0 || Math.abs(Number(initial.speed_kph)) > 0.1 || !initial.epb) {
    throw new Error(`unsafe initial vehicle state: ${JSON.stringify(initial)}`);
  }
  const baselineStates = vehicleStates.slice(-5);
  const baselineFront = baselineStates.reduce((sum, state) => sum + Number(state.front_steering_deg || 0), 0)
    / baselineStates.length;

  await frame.locator("#controlSessionButton").click();
  await frame.waitForFunction(() => (
    document.querySelector("#controlStatusText")?.textContent?.trim() === "控制中"
  ), null, { timeout: 45000 });
  acquired = true;

  sampleSidecar = true;
  const sidecarPoll = pollSidecar();
  const steeringStartedAt = Date.now();
  await frame.evaluate(() => {
    const down = new KeyboardEvent("keydown", { code: "ArrowLeft", key: "ArrowLeft", bubbles: true });
    document.dispatchEvent(down);
    window.setTimeout(() => {
      const up = new KeyboardEvent("keyup", { code: "ArrowLeft", key: "ArrowLeft", bubbles: true });
      document.dispatchEvent(up);
    }, 2500);
  });
  await frame.waitForFunction(() => (
    document.querySelector("#motionCommandDetail")?.textContent?.includes("转向 250")
  ), null, { timeout: 2000 });
  await waitFor(
    () => websocketCommands.find((payload) => Number(payload.command?.steering) === 250),
    2000,
    "positive left command",
  );

  await new Promise((resolve) => setTimeout(resolve, 2800));
  sampleSidecar = false;
  await sidecarPoll;
  const steeringStates = vehicleStates.filter((state) => state.observed_at_ms >= steeringStartedAt);
  if (!steeringStates.length) throw new Error("no vehicle state during steering");
  for (const state of steeringStates) {
    if (state.gear !== 0 || Math.abs(Number(state.speed_kph)) > 0.1 || !state.epb || !state.ad_screen_on) {
      throw new Error(`unsafe steering state: ${JSON.stringify(state)}`);
    }
  }
  const peakFront = Math.max(...steeringStates.map((state) => Number(state.front_steering_deg || 0)));
  const peakPositiveDelta = peakFront - baselineFront;
  if (peakPositiveDelta < 40) {
    const mqttLeft = mqttControlMessages.filter((command) => Number(command.steering) === 250);
    throw new Error(`left steering feedback did not move positive: ${JSON.stringify({
      baselineFront,
      peakFront,
      websocketLeftCommands: websocketCommands.filter((payload) => Number(payload.command?.steering) === 250).length,
      mqttLeftCommands: mqttLeft.length,
      latestMqttCommand: mqttControlMessages.at(-1),
      sidecarPositiveSamples: sidecarSamples.filter((sample) => Number(sample.last_command?.steering) === 250).length,
      sidecarPausedSamples: sidecarSamples.filter((sample) => sample.motion_paused).length,
      sidecarTail: sidecarSamples.slice(-10).map((sample) => ({
        steering: sample.last_command?.steering,
        motion_paused: sample.motion_paused,
        session_active: sample.session_active,
        error: sample.error,
      })),
    })}`);
  }

  await waitFor(() => {
    const state = vehicleStates.at(-1);
    return state && Math.abs(Number(state.front_steering_deg || 0) - baselineFront) <= 5 ? state : null;
  }, 6000, "steering return to zero");

  await frame.locator("#controlSessionButton").click();
  await frame.waitForFunction(() => (
    document.querySelector("#controlSessionButton span")?.textContent?.trim() === "接管车辆"
  ), null, { timeout: 10000 });
  acquired = false;
  let finalStatus = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    finalStatus = await frame.evaluate(() => fetch("/api/remote-drive/status", { cache: "no-store" }).then((response) => response.json()));
    if (!finalStatus.session_active && !finalStatus.transport_alive) break;
    await page.waitForTimeout(500);
  }
  if (finalStatus.session_active || finalStatus.transport_alive) {
    throw new Error(`control did not release: ${JSON.stringify(finalStatus)}`);
  }
  console.log(JSON.stringify({
    ok: true,
    baseline_front_deg: baselineFront,
    peak_front_deg: peakFront,
    peak_positive_delta_deg: peakPositiveDelta,
    max_abs_speed_kph: Math.max(...steeringStates.map((state) => Math.abs(Number(state.speed_kph || 0)))),
    steering_state_count: steeringStates.length,
    positive_left_commands: websocketCommands.filter((payload) => Number(payload.command?.steering) === 250).length,
    negative_left_commands: websocketCommands.filter((payload) => Number(payload.command?.steering) < 0).length,
    mqtt_positive_left_commands: mqttControlMessages.filter((command) => Number(command.steering) === 250).length,
    final_session_active: finalStatus.session_active,
    final_transport_alive: finalStatus.transport_alive,
    final_last_command: finalStatus.last_command,
    monitor_errors: monitorErrors,
  }, null, 2));
} finally {
  sampleSidecar = false;
  if (acquired && frame) {
    try {
      await frame.evaluate(() => {
        document.dispatchEvent(new KeyboardEvent("keyup", { code: "ArrowLeft", key: "ArrowLeft", bubbles: true }));
      });
      await frame.locator("#controlSessionButton").click({ timeout: 5000 });
    } catch {
      // The server watchdog remains the final fail-safe.
    }
  }
  await context.close();
  await browser.close();
  if (monitor && monitor.exitCode === null) {
    monitor.stdin.end("stop\n");
    await new Promise((resolve) => monitor.once("exit", resolve));
  }
}
