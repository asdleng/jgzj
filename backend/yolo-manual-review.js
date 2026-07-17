const YOLO_MANUAL_REVIEW_VERDICTS = Object.freeze([
  'pending',
  'pass',
  'negative',
  'unusable'
]);

const yoloManualReviewVerdictSet = new Set(YOLO_MANUAL_REVIEW_VERDICTS);

function normalizeYoloManualReviewVerdict(value, fallback = 'pending') {
  const normalized = String(value || '').trim().toLowerCase();
  if (yoloManualReviewVerdictSet.has(normalized)) {
    return normalized;
  }
  const normalizedFallback = String(fallback || '').trim().toLowerCase();
  return yoloManualReviewVerdictSet.has(normalizedFallback) ? normalizedFallback : 'pending';
}

function isYoloManualReviewVerdict(value) {
  return yoloManualReviewVerdictSet.has(String(value || '').trim().toLowerCase());
}

function isYoloManualReviewResolved(annotationOrVerdict) {
  const value = annotationOrVerdict && typeof annotationOrVerdict === 'object'
    ? annotationOrVerdict.review_verdict
    : annotationOrVerdict;
  return ['pass', 'negative', 'unusable'].includes(normalizeYoloManualReviewVerdict(value));
}

module.exports = {
  YOLO_MANUAL_REVIEW_VERDICTS,
  isYoloManualReviewResolved,
  isYoloManualReviewVerdict,
  normalizeYoloManualReviewVerdict
};
