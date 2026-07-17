const WEB_CANDIDATE_SCHEMA = 'jgzj_fire_smoke_web_candidate_summary.v1';
const WEAK_EVENT_WEB_CANDIDATE_SCHEMA = 'jgzj_weak_event_web_qwen_summary.v1';
const WEB_CANDIDATE_SCHEMAS = new Set([
  WEB_CANDIDATE_SCHEMA,
  WEAK_EVENT_WEB_CANDIDATE_SCHEMA
]);

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function sumCounts(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, value);
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.values(value).reduce((total, item) => total + sumCounts(item), 0);
  }
  return 0;
}

function isYoloWebCrawlerSummary(summary) {
  if (!summary || typeof summary !== 'object') {
    return false;
  }
  return WEB_CANDIDATE_SCHEMAS.has(String(summary.schema || '')) || (
    String(summary.source_policy || '') === 'license_metadata_required' &&
    /网络候选集/.test(String(summary.profile || ''))
  );
}

function normalizeYoloWebCrawlerStats(summary) {
  if (!isYoloWebCrawlerSummary(summary)) {
    return null;
  }
  const qwen = summary.qwen_label_summary && typeof summary.qwen_label_summary === 'object'
    ? summary.qwen_label_summary
    : {};
  const scenes = summary.scene_counts && typeof summary.scene_counts === 'object'
    ? summary.scene_counts
    : {};
  const totalImages = numberValue(qwen.labeled_images) || sumCounts(summary.images);
  const positiveImages = numberValue(qwen.scene_positive) || numberValue(scenes.positive);
  const hardNegativeImages = numberValue(qwen.scene_hard_negative) || numberValue(scenes.hard_negative);
  const needsHumanImages = numberValue(qwen.scene_needs_human) || numberValue(scenes.needs_human);
  const auditNeedsHumanImages = numberValue(qwen.audit_needs_human);
  const unusableImages = numberValue(qwen.scene_unusable) || numberValue(scenes.unusable);
  const positiveImagesByTarget = {};
  for (const [key, value] of Object.entries(summary.target_scene_counts || {})) {
    const match = String(key).match(/^(.+):positive$/);
    if (match && numberValue(value) > 0) {
      positiveImagesByTarget[match[1]] = numberValue(value);
    }
  }
  const boxesByClass = summary.boxes_by_class && typeof summary.boxes_by_class === 'object'
    ? Object.fromEntries(Object.entries(summary.boxes_by_class).map(([key, value]) => [key, numberValue(value)]))
    : {};
  return {
    total_images: totalImages,
    positive_images: positiveImages,
    hard_negative_images: hardNegativeImages,
    needs_human_images: needsHumanImages,
    review_queue_images: Math.max(needsHumanImages, auditNeedsHumanImages),
    unusable_images: unusableImages,
    accepted_boxes: numberValue(qwen.accepted_boxes) || sumCounts(summary.boxes_by_class),
    model_accepted_boxes: numberValue(qwen.model_accepted_boxes),
    proposed_boxes: numberValue(qwen.proposed_boxes),
    audit_pass_images: numberValue(qwen.audit_pass),
    audit_needs_human_images: auditNeedsHumanImages,
    audit_not_run_images: numberValue(qwen.audit_not_run),
    quarantined_conflicts: numberValue(qwen.quarantine_positive_in_hard_negative_bucket),
    positive_images_by_target: positiveImagesByTarget,
    boxes_by_class: boxesByClass,
    training_eligible: summary.training_eligible === true,
    training_policy: String(summary.training_policy || ''),
    qwen_model: String(summary.qwen_model || ''),
    updated_at: summary.updated_at || null
  };
}

function normalizeYoloWebReview(review, manifest) {
  if (!review || typeof review !== 'object') {
    return null;
  }
  const source = manifest && typeof manifest === 'object' ? manifest : {};
  return {
    target: String(review.target || ''),
    scene: String(review.scene || ''),
    model_scene: String(review.model_scene || ''),
    photo_type: String(review.photo_type || ''),
    domain: String(review.domain || ''),
    collection_bucket: String(review.collection_bucket || source.collection_bucket || ''),
    quarantine_reason: String(review.quarantine_reason || ''),
    proposed_classes: Array.isArray(review.proposed_classes) ? review.proposed_classes.map(String) : [],
    model_classes: Array.isArray(review.model_classes) ? review.model_classes.map(String) : [],
    classes: Array.isArray(review.classes) ? review.classes.map(String) : [],
    box_count: numberValue(review.box_count),
    audit_verdict: String(review.audit_verdict || ''),
    review_status: String(review.review_status || ''),
    training_eligible: review.training_eligible === true,
    title: String(source.title || ''),
    source_provider: String(source.source_provider || ''),
    source_category: String(source.source_category || ''),
    source_page_url: String(source.source_page_url || ''),
    source_file_url: String(source.source_file_url || ''),
    license: String(source.license || ''),
    license_url: String(source.license_url || ''),
    author: String(source.author || ''),
    downloaded_at: source.downloaded_at || null,
    image_sha256: String(review.image_sha256 || source.sha256 || '')
  };
}

function effectiveYoloWebAuditVerdict(review) {
  const scene = String(review?.scene || '').trim().toLowerCase();
  const quarantineReason = String(review?.quarantine_reason || '').trim();
  if (scene === 'unusable') {
    return 'not_applicable';
  }
  if (scene === 'needs_human' || quarantineReason) {
    return 'needs_human';
  }
  return String(review?.audit_verdict || '').trim().toLowerCase();
}

module.exports = {
  WEB_CANDIDATE_SCHEMA,
  WEAK_EVENT_WEB_CANDIDATE_SCHEMA,
  effectiveYoloWebAuditVerdict,
  isYoloWebCrawlerSummary,
  normalizeYoloWebCrawlerStats,
  normalizeYoloWebReview
};
