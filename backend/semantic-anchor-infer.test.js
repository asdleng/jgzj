const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeSemanticClasses,
  parseQwenSemanticReply
} = require('./semantic-anchor-infer');

test('normalizes and deduplicates semantic classes', () => {
  assert.deepEqual(
    normalizeSemanticClasses(['Door', 'door', 'fire extinguisher', 'gate']),
    ['door', 'fire_extinguisher', 'gate']
  );
});

test('parses compact Qwen semantic boxes', () => {
  const parsed = parseQwenSemanticReply(
    '```json\n{"q":"good","b":[["door",100,200,400,800,0.91,"glass door"]]}\n```',
    ['door']
  );
  assert.equal(parsed.quality, 'good');
  assert.deepEqual(parsed.labels, [
    {
      id: 'door_1',
      label: 'door',
      bbox_1000: [100, 200, 400, 800],
      score: 0.91,
      evidence: 'glass door'
    }
  ]);
});

test('accepts verbose boxes, clamps coordinates and filters unknown classes', () => {
  const parsed = parseQwenSemanticReply(
    JSON.stringify({
      quality: 'dark',
      boxes: [
        { label: 'gate', bbox: [-10, 20, 1200, 900], confidence: 1.3 },
        { label: 'person', bbox: [1, 2, 3, 4], confidence: 0.8 }
      ]
    }),
    ['gate']
  );
  assert.equal(parsed.labels.length, 1);
  assert.deepEqual(parsed.labels[0].bbox_1000, [0, 20, 1000, 900]);
  assert.equal(parsed.labels[0].score, 1);
});

test('accepts Qwen object boxes with class_name', () => {
  const parsed = parseQwenSemanticReply(
    JSON.stringify({
      b: [
        {
          class_name: 'door',
          bbox: [100, 200, 300, 800],
          score: 0.76
        }
      ]
    }),
    ['door']
  );
  assert.equal(parsed.labels.length, 1);
  assert.equal(parsed.labels[0].label, 'door');
  assert.equal(parsed.labels[0].score, 0.76);
});
