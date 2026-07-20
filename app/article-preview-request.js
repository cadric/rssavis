// @ts-check

/**
 * @typedef {object} PreviewRequestInput
 * @property {() => {expandedArticleId: string} | null} getState
 */

/** @type {WeakMap<PreviewRequestInput, Map<string, number>>} */
const previewDetailGenerations = new WeakMap();

/**
 * Each expansion owns its detail request. Closing or reopening an article
 * invalidates older requests, including an A-close-A sequence for the same id.
 * @param {PreviewRequestInput} input
 * @param {string} id
 */
export function nextPreviewDetailGeneration(input, id) {
  const generations = previewDetailGenerations.get(input) ?? new Map();
  const generation = (generations.get(id) ?? 0) + 1;
  generations.set(id, generation);
  previewDetailGenerations.set(input, generations);
  return generation;
}

/**
 * @param {PreviewRequestInput} input
 * @param {string} id
 * @param {number} generation
 */
export function isCurrentExpandedPreview(input, id, generation) {
  return input.getState()?.expandedArticleId === id && previewDetailGenerations.get(input)?.get(id) === generation;
}
