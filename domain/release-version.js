// @ts-check

export const CANONICAL_PRODUCT_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;

/**
 * @param {unknown} value
 * @returns {string}
 */
export function requireCanonicalProductVersion(value) {
  if (typeof value === 'string' && CANONICAL_PRODUCT_VERSION.test(value)) return value;
  throw new TypeError('RSSavis product version must use canonical X.Y.Z syntax.');
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function releaseTagForVersion(value) {
  return `v${requireCanonicalProductVersion(value)}`;
}
