const test = require('node:test');
const assert = require('node:assert/strict');

const {
  YOLO_MANUAL_REVIEW_VERDICTS,
  isYoloManualReviewResolved,
  isYoloManualReviewVerdict,
  normalizeYoloManualReviewVerdict
} = require('./yolo-manual-review');

test('manual review verdicts expose the four supported states', () => {
  assert.deepEqual(YOLO_MANUAL_REVIEW_VERDICTS, ['pending', 'pass', 'negative', 'unusable']);
  for (const verdict of YOLO_MANUAL_REVIEW_VERDICTS) {
    assert.equal(isYoloManualReviewVerdict(verdict), true);
  }
  assert.equal(isYoloManualReviewVerdict('approved'), false);
});

test('legacy annotations without a verdict remain pending', () => {
  assert.equal(normalizeYoloManualReviewVerdict(undefined), 'pending');
  assert.equal(normalizeYoloManualReviewVerdict(''), 'pending');
  assert.equal(isYoloManualReviewResolved({ answer: 'YES', labels: [{}] }), false);
});

test('only final human verdicts resolve a review queue item', () => {
  assert.equal(isYoloManualReviewResolved('pending'), false);
  assert.equal(isYoloManualReviewResolved({ review_verdict: 'pass' }), true);
  assert.equal(isYoloManualReviewResolved({ review_verdict: 'negative' }), true);
  assert.equal(isYoloManualReviewResolved({ review_verdict: 'unusable' }), true);
});
