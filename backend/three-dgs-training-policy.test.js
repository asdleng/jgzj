'use strict';

const assert = require('assert');
const {
  A100_ONLY_TRAINING_POLICY,
  assertA100OnlyTraining,
  assertAllowedA100Gpu,
  parseA100GpuSnapshot,
  assertA100GpuIdle
} = require('./three-dgs-training-policy');

assert.strictEqual(assertA100OnlyTraining().backend, 'a100');
assert.strictEqual(assertA100OnlyTraining({ backend: 'A100' }).backend, 'a100');
assert.strictEqual(assertA100OnlyTraining({ execution_backend: ' a100 ' }).backend, 'a100');
assert.strictEqual(A100_ONLY_TRAINING_POLICY.local_gpu_training_allowed, false);
assert.strictEqual(A100_ONLY_TRAINING_POLICY.server_proxy_4090_training_allowed, false);

for (const payload of [
  { backend: 'local' },
  { execution_backend: 'server-proxy' },
  { training_backend: '4090' },
  { backend: '' }
]) {
  assert.throws(
    () => assertA100OnlyTraining(payload),
    (error) => error.message === 'three_dgs_training_backend_forbidden_a100_only'
  );
}

assert.strictEqual(assertAllowedA100Gpu('3', ['3', '4']), '3');
assert.throws(
  () => assertAllowedA100Gpu('0', ['3', '4']),
  (error) => error.message === 'three_dgs_a100_gpu_not_allowed'
);
const gpu3 = parseA100GpuSnapshot('3, 0, 0\n4, 74509, 100\n', '3');
assert.deepStrictEqual(gpu3, { gpu: '3', memory_used_mib: 0, utilization_pct: 0 });
assert.deepStrictEqual(assertA100GpuIdle(gpu3), gpu3);
assert.throws(
  () => assertA100GpuIdle(parseA100GpuSnapshot('3, 16345, 27\n', '3')),
  (error) => error.message === 'three_dgs_a100_gpu_busy'
);

console.log('three-dgs A100-only training policy tests passed');
