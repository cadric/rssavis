// @ts-check

import { createAppError, ERROR_CODES } from './errors.js';
export { sha256Hex } from './hashing.js';

const ID_PREFIX_PATTERN = /^[a-z][a-z0-9]*$/;

/**
 * @param {string} prefix
 * @returns {string}
 */
export function createPrefixedId(prefix) {
  if (!ID_PREFIX_PATTERN.test(prefix)) {
    throw createAppError(ERROR_CODES.VALIDATION_ERROR, {
      details: { field: 'prefix', reason: 'invalid id prefix' },
      message: `prefix: invalid id prefix`,
    });
  }
  return `${prefix}_${globalThis.crypto.randomUUID()}`;
}

/**
 * @param {string} value
 * @returns {Promise<string>}
 */
