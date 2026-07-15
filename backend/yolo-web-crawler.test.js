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

test('recognizes and normalizes the weak-event web candidate summary', () => {
  const weakSummary = {
    schema: 'jgzj_weak_event_web_qwen_summary.v1',
    profile: '弱事件网络候选集',
    images: { review: 300 },
    scene_counts: { positive: 151, hard_negative: 76, needs_human: 24, unusable: 49 },
    target_scene_counts: {
      'fishing_rod:positive': 38,
      'stall:positive': 63,
      'pet:positive': 20,
      'trash:positive': 30
    },
    boxes_by_class: { fishing_rod: 79, stall: 68, pet: 23, bottle: 33, bag: 28, paper: 5, box: 6 },
    qwen_model: 'Qwen3.6-27B-Labeler',
    training_eligible: false,
    training_policy: 'two_pass_qwen_then_human_review',
    updated_at: '2026-07-15T19:07:46+08:00'
  };
  assert.equal(isYoloWebCrawlerSummary(weakSummary), true);
  assert.deepEqual(normalizeYoloWebCrawlerStats(weakSummary), {
    total_images: 300,
    positive_images: 151,
    hard_negative_images: 76,
    needs_human_images: 24,
    unusable_images: 49,
    accepted_boxes: 242,
    model_accepted_boxes: 0,
    proposed_boxes: 0,
    audit_pass_images: 0,
    audit_needs_human_images: 0,
    audit_not_run_images: 0,
    quarantined_conflicts: 0,
    positive_images_by_target: {
      fishing_rod: 38,
      stall: 63,
      pet: 20,
      trash: 30
    },
    boxes_by_class: {
      fishing_rod: 79,
      stall: 68,
      pet: 23,
      bottle: 33,
      bag: 28,
      paper: 5,
      box: 6
    },
    training_eligible: false,
    training_policy: 'two_pass_qwen_then_human_review',
    qwen_model: 'Qwen3.6-27B-Labeler',
    updated_at: '2026-07-15T19:07:46+08:00'
  });
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
    positive_images_by_target: {},
    boxes_by_class: {},
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
  assert.equal(effectiveYoloWebAuditVerdict({
    scene: 'unusable',
    audit_verdict: 'not_run',
    quarantine_reason: 'off_domain_or_non_photo'
  }), 'not_applicable');
});
