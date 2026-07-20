// @ts-check

import { createAppError, ERROR_CODES } from '../domain/errors.js';
import { isEpochMs } from '../domain/dates.js';

const UUID_ID_PATTERN = /^(cat|feed)_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ARTICLE_ID_PATTERN = /^art_[0-9a-f]{64}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/i;

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
export function requireRecord(value, label) {
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return /** @type {Record<string, unknown>} */ (value);
  }
  throw validationError(label, 'must be a plain object');
}

/**
 * @param {Record<string, unknown>} record
 * @param {ReadonlySet<string>} allowed
 */
export function rejectUnknownFields(record, allowed) {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw validationError(key, `unknown field: ${key}`);
  }
}

/**
 * @param {Record<string, unknown>} record
 * @param {string} field
 * @param {number} maxCodePoints
 * @returns {string}
 */
export function requireString(record, field, maxCodePoints) {
  const value = record[field];
  if (typeof value !== 'string') throw validationError(field, 'must be a string');
  if ([...value].length > maxCodePoints) throw validationError(field, 'exceeds code point limit');
  return value;
}

/**
 * @param {Record<string, unknown>} record
 * @param {string} field
 * @param {string} fallback
 * @param {number} maxCodePoints
 * @returns {string}
 */
export function optionalString(record, field, fallback, maxCodePoints) {
  if (!(field in record)) return fallback;
  const value = record[field];
  if (value === null && fallback === '') return fallback;
  if (typeof value !== 'string') throw validationError(field, 'must be a string');
  if ([...value].length > maxCodePoints) throw validationError(field, 'exceeds code point limit');
  return value;
}

/**
 * @param {Record<string, unknown>} record
 * @param {string} field
 * @returns {number}
 */
export function requireEpochMs(record, field) {
  const value = record[field];
  if (!isEpochMs(value)) throw validationError(field, 'must be an integer epoch milliseconds value');
  return value;
}

/**
 * @param {Record<string, unknown>} record
 * @param {string} field
 * @param {number} fallback
 * @returns {number}
 */
export function optionalEpochMs(record, field, fallback) {
  if (!(field in record)) return fallback;
  const value = record[field];
  if (!isEpochMs(value)) throw validationError(field, 'must be an integer epoch milliseconds value');
  return value;
}

/**
 * @param {Record<string, unknown>} record
 * @param {string} field
 * @param {number} fallback
 * @returns {number}
 */
export function optionalNonNegativeInteger(record, field, fallback) {
  if (!(field in record)) return fallback;
  const value = record[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw validationError(field, 'must be a non-negative integer');
  }
  return value;
}

/**
 * @param {Record<string, unknown>} record
 * @param {string} field
 * @param {ReadonlySet<number>} allowed
 * @param {number} fallback
 * @returns {number}
 */
export function optionalEnumNumber(record, field, allowed, fallback) {
  if (!(field in record)) return fallback;
  const value = record[field];
  if (typeof value !== 'number' || !allowed.has(value)) throw validationError(field, 'must be a numeric enum value');
  return value;
}

/**
 * @param {Record<string, unknown>} record
 * @param {string} field
 * @param {ReadonlySet<string>} allowed
 * @param {string} fallback
 * @returns {string}
 */
export function optionalEnumString(record, field, allowed, fallback) {
  if (!(field in record)) return fallback;
  const value = record[field];
  if (typeof value !== 'string' || !allowed.has(value)) throw validationError(field, 'must be a string enum value');
  return value;
}

/**
 * @param {Record<string, unknown>} record
 * @param {string} field
 * @param {'cat' | 'feed'} prefix
 * @returns {string}
 */
export function requireUuidId(record, field, prefix) {
  const value = requireString(record, field, 128);
  if (!UUID_ID_PATTERN.test(value) || !value.startsWith(`${prefix}_`))
    throw validationError(field, 'invalid prefixed UUID');
  return value;
}

/**
 * @param {Record<string, unknown>} record
 * @param {string} field
 * @returns {string}
 */
export function requireArticleId(record, field) {
  const value = requireString(record, field, 128);
  if (!ARTICLE_ID_PATTERN.test(value)) throw validationError(field, 'invalid article id');
  return value;
}

/**
 * @param {Record<string, unknown>} record
 * @param {string} field
 * @returns {string}
 */
export function requireHash(record, field) {
  const value = requireString(record, field, 64);
  if (!HASH_PATTERN.test(value)) throw validationError(field, 'invalid sha256 hex');
  return value;
}

/**
 * @param {string} field
 * @param {string} reason
 * @returns {import('../domain/errors.js').AppError}
 */
export function validationError(field, reason) {
  return createAppError(ERROR_CODES.VALIDATION_ERROR, {
    details: { field, reason },
    message: `${field}: ${reason}`,
  });
}
