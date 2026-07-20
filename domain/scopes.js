// @ts-check

import { createAppError, ERROR_CODES } from './errors.js';

const SYSTEM_SCOPE_IDS = new Set(['all', 'unread', 'starred', 'main']);
const FEED_ID_PATTERN = /^feed_[A-Za-z0-9-]+$/;
const CATEGORY_ID_PATTERN = /^cat_[A-Za-z0-9-]+$/;

/**
 * @typedef {object} Scope
 * @property {'system' | 'feed' | 'category'} type
 * @property {string} id
 */

/**
 * @param {unknown} value
 * @returns {Scope}
 */
export function normalizeScope(value) {
  if (!isRecord(value)) throw scopeError('activeScope', 'must be an object');
  const type = value.type;
  const id = value.id;
  if (type === 'system' && typeof id === 'string' && SYSTEM_SCOPE_IDS.has(id)) return { type, id };
  if (type === 'feed' && typeof id === 'string' && FEED_ID_PATTERN.test(id)) return { type, id };
  if (type === 'category' && typeof id === 'string' && CATEGORY_ID_PATTERN.test(id)) return { type, id };
  throw scopeError('activeScope', 'invalid scope');
}

/**
 * @param {Scope} scope
 * @returns {string}
 */
export function scopeToStorageKey(scope) {
  const normalized = normalizeScope(scope);
  return `${normalized.type}:${normalized.id}`;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * @param {string} field
 * @param {string} reason
 * @returns {import('./errors.js').AppError}
 */
function scopeError(field, reason) {
  return createAppError(ERROR_CODES.VALIDATION_ERROR, {
    details: { field, reason },
    message: `${field}: ${reason}`,
  });
}
