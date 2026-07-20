// @ts-check

import { createAppError, ERROR_CODES } from '../domain/errors.js';

export const OPML_REFRESH_QUEUE_KEY = 'opmlRefreshQueue';
export const OPML_REFRESH_JOB_KEY_PREFIX = 'opmlRefreshJob:';
export const OPML_REFRESH_JOB_BATCH_SIZE = 20;
export const OPML_REFRESH_JOB_LEASE_MS = 120_000;
export const OPML_REFRESH_JOB_VERSION = 1;
export const OPML_REFRESH_JOB_KIND = 'opmlRefresh';

const JOB_STATES = new Set(['queued', 'running', 'completed']);
const JOB_FIELDS = new Set([
  'key',
  'kind',
  'version',
  'jobId',
  'state',
  'feedIds',
  'cursor',
  'successCount',
  'failureCount',
  'skippedCount',
  'createdAtMs',
  'updatedAtMs',
  'leaseOwner',
  'leaseExpiresAtMs',
  'lastErrorCode',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * @typedef {object} OpmlRefreshJobRecord
 * @property {string} key
 * @property {'opmlRefresh'} kind
 * @property {1} version
 * @property {string} jobId
 * @property {'queued' | 'running' | 'completed'} state
 * @property {string[]} feedIds
 * @property {number} cursor
 * @property {number} successCount
 * @property {number} failureCount
 * @property {number} skippedCount
 * @property {number} createdAtMs
 * @property {number} updatedAtMs
 * @property {string | null} leaseOwner
 * @property {number | null} leaseExpiresAtMs
 * @property {string | null} lastErrorCode
 */

/**
 * @param {unknown} input
 * @returns {OpmlRefreshJobRecord}
 */
export function normalizeOpmlRefreshJobRecord(input) {
  const record = requirePlainObject(input, 'opmlRefreshJob');
  rejectUnknownFields(record, JOB_FIELDS, 'opmlRefreshJob');
  const jobId = requireUuid(record.jobId, 'jobId');
  const key = requireString(record.key, 'key', 128);
  if (key !== OPML_REFRESH_JOB_KEY_PREFIX + jobId) throw validationError('key', 'does not match jobId');
  const feedIds = requireStringArray(record.feedIds, 'feedIds', 5000);
  const cursor = requireNonNegativeInteger(record.cursor, 'cursor');
  if (cursor > feedIds.length) throw validationError('cursor', 'exceeds feedIds length');
  const state = requireString(record.state, 'state', 32);
  if (!JOB_STATES.has(state)) throw validationError('state', 'invalid state');
  if (record.kind !== OPML_REFRESH_JOB_KIND) throw validationError('kind', 'invalid kind');
  if (record.version !== OPML_REFRESH_JOB_VERSION) throw validationError('version', 'invalid version');
  return {
    key,
    kind: OPML_REFRESH_JOB_KIND,
    version: OPML_REFRESH_JOB_VERSION,
    jobId,
    state: /** @type {OpmlRefreshJobRecord['state']} */ (state),
    feedIds,
    cursor,
    successCount: requireNonNegativeInteger(record.successCount, 'successCount'),
    failureCount: requireNonNegativeInteger(record.failureCount, 'failureCount'),
    skippedCount: requireNonNegativeInteger(record.skippedCount, 'skippedCount'),
    createdAtMs: requireEpochMs(record.createdAtMs, 'createdAtMs'),
    updatedAtMs: requireEpochMs(record.updatedAtMs, 'updatedAtMs'),
    leaseOwner: requireNullableString(record.leaseOwner, 'leaseOwner', 128),
    leaseExpiresAtMs: requireNullableEpochMs(record.leaseExpiresAtMs, 'leaseExpiresAtMs'),
    lastErrorCode: requireNullableString(record.lastErrorCode, 'lastErrorCode', 128),
  };
}

/**
 * @param {unknown} value
 * @param {string} field
 */
export function requireUuid(value, field) {
  const text = requireString(value, field, 64);
  if (!UUID_PATTERN.test(text)) throw validationError(field, 'must be a UUID');
  return text;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {number} maxItems
 */
export function requireStringArray(value, field, maxItems) {
  if (!Array.isArray(value) || value.length > maxItems) throw validationError(field, 'must be a bounded array');
  return value.map((item, index) => requireString(item, `${field}[${index}]`, 128));
}

/**
 * @param {unknown} value
 * @param {string} field
 */
export function requireNonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw validationError(field, 'must be a non-negative integer');
  return Number(value);
}

/**
 * @param {number | undefined} value
 */
export function normalizeCount(value) {
  return value === undefined ? 0 : requireNonNegativeInteger(value, 'count');
}

/**
 * @param {number | undefined} value
 * @param {number} fallback
 */
export function normalizePositiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {number} maxCodePoints
 */
export function requireString(value, field, maxCodePoints) {
  if (typeof value !== 'string' || value.length === 0 || [...value].length > maxCodePoints) {
    throw validationError(field, 'must be a bounded non-empty string');
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} field
 */
function requirePlainObject(value, field) {
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return /** @type {Record<string, unknown>} */ (value);
  }
  throw validationError(field, 'must be a plain object');
}

/**
 * @param {Record<string, unknown>} record
 * @param {Set<string>} allowed
 * @param {string} label
 */
function rejectUnknownFields(record, allowed, label) {
  const extra = Object.keys(record).filter((key) => !allowed.has(key));
  if (extra.length > 0) throw validationError(label, `unknown field ${extra[0]}`);
}

/**
 * @param {unknown} value
 * @param {string} field
 */
function requireEpochMs(value, field) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw validationError(field, 'must be epoch ms');
  return Number(value);
}

/**
 * @param {unknown} value
 * @param {string} field
 */
function requireNullableEpochMs(value, field) {
  return value === null ? null : requireEpochMs(value, field);
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {number} maxCodePoints
 */
function requireNullableString(value, field, maxCodePoints) {
  return value === null ? null : requireString(value, field, maxCodePoints);
}

/**
 * @param {string} field
 * @param {string} reason
 */
function validationError(field, reason) {
  return createAppError(ERROR_CODES.VALIDATION_ERROR, { details: { field, reason } });
}
