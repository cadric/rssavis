// @ts-check

/**
 * @param {unknown} value
 * @returns {value is number}
 */
export function isEpochMs(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * @param {number} publishedAtMs
 * @param {number} sourceUpdatedAtMs
 * @param {number} fetchedAtMs
 * @returns {number}
 */
export function chooseArticleSortAtMs(publishedAtMs, sourceUpdatedAtMs, fetchedAtMs) {
  const futureLimit = fetchedAtMs + 7 * 24 * 60 * 60 * 1000;
  if (isEpochMs(publishedAtMs) && publishedAtMs <= futureLimit && publishedAtMs > 0) return publishedAtMs;
  if (isEpochMs(sourceUpdatedAtMs) && sourceUpdatedAtMs <= futureLimit && sourceUpdatedAtMs > 0)
    return sourceUpdatedAtMs;
  return fetchedAtMs;
}

/**
 * @param {unknown} value
 * @param {number} [nowMs]
 * @returns {number}
 */
export function parseFeedDateMs(value, nowMs = Date.now()) {
  if (typeof value !== 'string' || value.trim() === '') return 0;
  const parsed = Date.parse(value.trim());
  const futureLimit = nowMs + 7 * 24 * 60 * 60 * 1000;
  return isEpochMs(parsed) && parsed <= futureLimit ? parsed : 0;
}
