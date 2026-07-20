// @ts-check

import { ERROR_CODES, createAppError } from '../domain/errors.js';

export const MAX_PERMISSION_ORIGINS_PER_REQUEST = 32;

/**
 * @typedef {object} PermissionBrowser
 * @property {{request(permissions: {origins: string[]}): Promise<boolean>}} permissions
 */

/**
 * Request exact host origins from a user-activated UI handler.
 *
 * @param {string | string[]} origins
 * @param {string} operation
 * @returns {Promise<void>}
 */
export async function requestHostPermissions(origins, operation) {
  const requestedOrigins = Array.isArray(origins) ? origins : [origins];
  const browser = getPermissionBrowser();
  const granted = await browser.permissions.request({ origins: requestedOrigins });
  if (!granted) {
    throw createAppError(ERROR_CODES.HOST_PERMISSION_DENIED, {
      details: { operation },
      retryable: false,
    });
  }
}

/**
 * @param {readonly string[]} origins
 * @param {number} [batchSize]
 * @returns {string[][]}
 */
export function createPermissionOriginBatches(origins, batchSize = MAX_PERMISSION_ORIGINS_PER_REQUEST) {
  const normalized = [];
  const seen = new Set();
  for (const origin of origins) {
    if (typeof origin !== 'string') continue;
    const trimmed = origin.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  const batches = [];
  for (let index = 0; index < normalized.length; index += batchSize) {
    batches.push(normalized.slice(index, index + batchSize));
  }
  return batches;
}

/**
 * @returns {PermissionBrowser}
 */
function getPermissionBrowser() {
  return /** @type {{browser: PermissionBrowser}} */ (/** @type {unknown} */ (globalThis)).browser;
}
