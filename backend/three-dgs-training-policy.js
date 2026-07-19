'use strict';

const A100_ONLY_TRAINING_POLICY = Object.freeze({
  backend: 'a100',
  local_gpu_training_allowed: false,
  server_proxy_4090_training_allowed: false,
  reason: '3DGS training is restricted to the A100 host by operator policy.'
});

function assertA100OnlyTraining(payload = {}) {
  const requested = String(
    payload.training_backend ?? payload.execution_backend ?? payload.backend ?? 'a100'
  ).trim().toLowerCase();
  if (requested !== 'a100') {
    const error = new Error('three_dgs_training_backend_forbidden_a100_only');
    error.status = 400;
    throw error;
  }
  return A100_ONLY_TRAINING_POLICY;
}

function assertAllowedA100Gpu(gpu, allowedGpus) {
  const normalized = String(gpu).trim();
  const allowed = allowedGpus.map((item) => String(item).trim()).filter(Boolean);
  if (!allowed.includes(normalized)) {
    const error = new Error('three_dgs_a100_gpu_not_allowed');
    error.status = 400;
    error.allowed_gpus = allowed;
    throw error;
  }
  return normalized;
}

function parseA100GpuSnapshot(output, gpu) {
  const wanted = String(gpu).trim();
  for (const line of String(output || '').split(/\r?\n/)) {
    const fields = line.split(',').map((item) => item.trim());
    if (fields.length < 3 || fields[0] !== wanted) continue;
    const memoryUsedMiB = Number(fields[1]);
    const utilizationPct = Number(fields[2]);
    if (Number.isFinite(memoryUsedMiB) && Number.isFinite(utilizationPct)) {
      return { gpu: wanted, memory_used_mib: memoryUsedMiB, utilization_pct: utilizationPct };
    }
  }
  const error = new Error('three_dgs_a100_gpu_status_unavailable');
  error.status = 503;
  throw error;
}

function assertA100GpuIdle(snapshot, limits = {}) {
  const maxMemoryUsedMiB = Number(limits.max_memory_used_mib ?? 1024);
  const maxUtilizationPct = Number(limits.max_utilization_pct ?? 10);
  if (snapshot.memory_used_mib > maxMemoryUsedMiB || snapshot.utilization_pct > maxUtilizationPct) {
    const error = new Error('three_dgs_a100_gpu_busy');
    error.status = 409;
    error.snapshot = snapshot;
    throw error;
  }
  return snapshot;
}

module.exports = {
  A100_ONLY_TRAINING_POLICY,
  assertA100OnlyTraining,
  assertAllowedA100Gpu,
  parseA100GpuSnapshot,
  assertA100GpuIdle
};
