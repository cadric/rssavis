// @ts-check

/**
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeUnreadCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  const normalized = Math.floor(value);
  return Number.isSafeInteger(normalized) ? normalized : 0;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function compactUnreadCount(value) {
  const count = normalizeUnreadCount(value);
  if (count === 0) return '';
  if (count < 1_000) return String(count);
  if (count < 100_000) return `${Math.floor(count / 1_000)}k`;
  return `E${Math.floor(Math.log10(count))}`;
}
