// @ts-check

/**
 * @param {Array<Record<string, unknown>>} current
 * @param {Array<Record<string, unknown>>} next
 */
export function mergeArticles(current, next) {
  const seen = new Set(current.map((item) => item.id).filter((id) => typeof id === 'string'));
  return [...current, ...next.filter((item) => typeof item.id === 'string' && !seen.has(item.id))];
}
