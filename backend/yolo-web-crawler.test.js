const assert = require('node:assert/strict');
const test = require('node:test');

const {
  effectiveYoloWebAuditVerdict,
  isYoloWebCrawlerSummary,
  normalizeYoloWebCrawlerStats,
  normalizeYoloWebReview
} = require('./yolo-web-crawler');

const summary = {
  schema: 'jgzj_fire_smoke_web_candidate_summary.v1',
  profile: '烟雾火焰网络候选集',
  images: { review: 294 },
  qwen_model: 'Qwen3.6-27B-Labeler',
  training_eligible: false,
  training_policy: 'human_review_required_after_qwen_audit',
  qwen_label_summary: {
    labeled_images: 294,
    scene_positive: 120,
    scene_hard_negative: 111,
    scene_needs_human: 38,
    scene_unusable: 25,
    accepted_boxes: 167,
    audit_pass: 169,
    audit_needs_human: 100,
    audit_not_run: 25,
    quarantine_positive_in_hard_negative_bucket: 32
  }
};

test('recognizes the licensed fire/smoke web candidate summary', () => {
  assert.equal(isYoloWebCrawlerSummary(summary), true);
  assert.equal(isYoloWebCrawlerSummary({ schema: 'other' }), false);
});

test('normalizes crawler and Qwen review counts without enabling training', () => {
  assert.deepEqual(normalizeYoloWebCrawlerStats(summary), {
    total_images: 294,
    positive_images: 120,
    hard_negative_images: 111,
    needs_human_images: 38,
    unusable_images: 25,
    accepted_boxes: 167,
    model_accepted_boxes: 0,
    proposed_boxes: 0,
    audit_pass_images: 169,
    audit_needs_human_images: 100,
    audit_not_run_images: 25,
    quarantined_conflicts: 32,
    training_eligible: false,
    training_policy: 'human_review_required_after_qwen_audit',
    qwen_model: 'Qwen3.6-27B-Labeler',
    updated_at: null
  });
});

test('joins source license metadata with the Qwen review row', () => {
  const normalized = normalizeYoloWebReview({
    image_sha256: 'abc',
    scene: 'needs_human',
    photo_type: 'real_photo',
    domain: 'target',
    collection_bucket: 'hard_negative_exhaust',
    quarantine_reason: 'positive_in_hard_negative_bucket',
    model_classes: ['smoke'],
    classes: [],
    audit_verdict: 'needs_human',
    training_eligible: false
  }, {
    title: 'Vehicle exhaust',
    license: 'CC BY-SA 4.0',
    source_page_url: 'https://commons.wikimedia.org/example'
  });
  assert.equal(normalized.scene, 'needs_human');
  assert.equal(normalized.collection_bucket, 'hard_negative_exhaust');
  assert.equal(normalized.license, 'CC BY-SA 4.0');
  assert.deepEqual(normalized.model_classes, ['smoke']);
  assert.equal(normalized.training_eligible, false);
});

test('deterministic quarantine overrides a raw Qwen pass verdict', () => {
  assert.equal(effectiveYoloWebAuditVerdict({
    scene: 'needs_human',
    audit_verdict: 'pass',
    quarantine_reason: 'positive_in_hard_negative_bucket'
  }), 'needs_human');
  assert.equal(effectiveYoloWebAuditVerdict({ scene: 'positive', audit_verdict: 'pass' }), 'pass');
});
