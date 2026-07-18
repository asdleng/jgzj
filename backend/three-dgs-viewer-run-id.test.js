const assert = require('assert');
const registerThreeDgsRoutes = require('./three-dgs');

const { validateViewerRunId } = registerThreeDgsRoutes;
const currentRunId = 'bit0041-20260717-210630-map-visual-v4-dense409-offset-m177p5-lidardepth-v1-depth005to0005-densify15k-server4090g3-20260718';

assert.strictEqual(currentRunId.length, 122);
assert.strictEqual(validateViewerRunId(currentRunId), currentRunId);
assert.strictEqual(validateViewerRunId('a'.repeat(255)), 'a'.repeat(255));
assert.strictEqual(validateViewerRunId('a'.repeat(256)), '');
assert.strictEqual(validateViewerRunId('../point_cloud'), '');
assert.strictEqual(validateViewerRunId('run id'), '');

console.log('three-dgs viewer run-id tests passed');
