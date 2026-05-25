/**
 * Centralized feature-flag helpers.
 */
export function isReviewQueueEnabled() {
  return process.env.EDGE_REVIEW_QUEUE === 'true';
}
