// @ts-check

import { MESSAGE_TYPES, isKnownMessageType } from '../domain/message-types.js';
import { createAppError } from './result.js';

export const MESSAGE_PROTOCOL_VERSION = 1;

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENVELOPE_KEYS = new Set(['type', 'requestId', 'payload', 'version']);
/** @type {readonly string[]} */
const EMPTY_PAYLOAD = Object.freeze([]);
/** @type {Readonly<Record<string, readonly string[]>>} */
const PAYLOAD_FIELDS = Object.freeze({
  [MESSAGE_TYPES.APP_BOOTSTRAP]: EMPTY_PAYLOAD,
  [MESSAGE_TYPES.APP_OPEN_TRUSTED_RESOURCE]: Object.freeze(['resource']),
  [MESSAGE_TYPES.SETTINGS_GET]: EMPTY_PAYLOAD,
  [MESSAGE_TYPES.SETTINGS_UPDATE]: Object.freeze(['settings']),
  [MESSAGE_TYPES.SETTINGS_RESET]: EMPTY_PAYLOAD,
  [MESSAGE_TYPES.CATEGORIES_LIST]: EMPTY_PAYLOAD,
  [MESSAGE_TYPES.CATEGORIES_CREATE]: Object.freeze(['title']),
  [MESSAGE_TYPES.CATEGORIES_RENAME]: Object.freeze(['id', 'title']),
  [MESSAGE_TYPES.CATEGORIES_MOVE]: Object.freeze(['id', 'direction', 'targetCategoryId']),
  [MESSAGE_TYPES.CATEGORIES_DELETE]: Object.freeze(['id']),
  [MESSAGE_TYPES.FEEDS_LIST]: EMPTY_PAYLOAD,
  [MESSAGE_TYPES.FEEDS_ADD]: Object.freeze(['url', 'categoryId', 'title', 'customTitle']),
  [MESSAGE_TYPES.FEEDS_UPDATE]: Object.freeze(['id', 'patch']),
  [MESSAGE_TYPES.FEEDS_MOVE]: Object.freeze(['id', 'categoryId', 'direction']),
  [MESSAGE_TYPES.FEEDS_MOVE_CATEGORY]: Object.freeze(['id', 'categoryId']),
  [MESSAGE_TYPES.FEEDS_DELETE]: Object.freeze(['id']),
  [MESSAGE_TYPES.FEEDS_REFRESH_ONE]: Object.freeze(['id']),
  [MESSAGE_TYPES.FEEDS_REFRESH_ALL]: EMPTY_PAYLOAD,
  [MESSAGE_TYPES.FEEDS_GRANT_PERMISSION]: Object.freeze(['id']),
  [MESSAGE_TYPES.FEEDS_GRANT_REDIRECT]: Object.freeze(['id']),
  [MESSAGE_TYPES.ARTICLES_QUERY]: Object.freeze(['scope', 'cursor', 'pageSize', 'filter']),
  [MESSAGE_TYPES.ARTICLES_GET_DETAIL]: Object.freeze(['id']),
  [MESSAGE_TYPES.ARTICLES_OPEN_ORIGINAL]: Object.freeze(['id', 'mode']),
  [MESSAGE_TYPES.ARTICLES_OPEN_CONTENT_LINK]: Object.freeze(['url', 'mode']),
  [MESSAGE_TYPES.ARTICLES_SET_READ]: Object.freeze(['id', 'readState']),
  [MESSAGE_TYPES.ARTICLES_SET_STARRED]: Object.freeze(['id', 'starredState']),
  [MESSAGE_TYPES.ARTICLES_COUNT_UNREAD]: Object.freeze(['scope']),
  [MESSAGE_TYPES.ARTICLES_MARK_SCOPE_READ]: Object.freeze(['scope', 'batchSize', 'maxChunks']),
  [MESSAGE_TYPES.ARTICLES_SEARCH]: Object.freeze(['scope', 'query', 'cursor', 'pageSize']),
  [MESSAGE_TYPES.OPML_PREVIEW_IMPORT]: Object.freeze(['opmlText']),
  [MESSAGE_TYPES.OPML_COMMIT_IMPORT]: Object.freeze(['importModel']),
  [MESSAGE_TYPES.OPML_EXPORT]: EMPTY_PAYLOAD,
  [MESSAGE_TYPES.STORAGE_GET_USAGE]: EMPTY_PAYLOAD,
  [MESSAGE_TYPES.STORAGE_PURGE]: Object.freeze(['maxArticles', 'maxAgeDays']),
  [MESSAGE_TYPES.STORAGE_REBUILD_STATS]: EMPTY_PAYLOAD,
  [MESSAGE_TYPES.STORAGE_DIAGNOSE_INTEGRITY]: EMPTY_PAYLOAD,
  [MESSAGE_TYPES.STORAGE_REPAIR_INTEGRITY]: EMPTY_PAYLOAD,
  [MESSAGE_TYPES.STORAGE_RESET_DATA]: EMPTY_PAYLOAD,
  [MESSAGE_TYPES.READER_CONTEXT_ACTIVE]: EMPTY_PAYLOAD,
  [MESSAGE_TYPES.READER_OPEN_OR_FOCUS]: EMPTY_PAYLOAD,
});

/**
 * @typedef {object} RuntimeMessage
 * @property {string} type
 * @property {string} requestId
 * @property {Record<string, unknown>} payload
 * @property {1} version
 */

/**
 * @typedef {object} ValidationResult
 * @property {boolean} ok
 * @property {RuntimeMessage | null} message
 * @property {import('./result.js').AppError | null} error
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * @returns {string}
 */
export function createRequestId() {
  return globalThis.crypto.randomUUID();
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isValidRequestId(value) {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

/**
 * @param {string} type
 * @param {Record<string, unknown>} payload
 * @returns {RuntimeMessage}
 */
export function createMessageEnvelope(type, payload) {
  return {
    type,
    requestId: createRequestId(),
    payload,
    version: MESSAGE_PROTOCOL_VERSION,
  };
}

/**
 * @param {unknown} message
 * @returns {string}
 */
export function requestIdFrom(message) {
  return isPlainObject(message) && typeof message.requestId === 'string' ? message.requestId : 'invalid-request';
}

/**
 * @param {unknown} message
 * @returns {ValidationResult}
 */
export function validateMessageEnvelope(message) {
  if (!isPlainObject(message)) return invalid(message, 'message must be a plain object');
  const extra = Object.keys(message).filter((key) => !ENVELOPE_KEYS.has(key));
  if (extra.length > 0) return invalid(message, `unknown envelope field: ${extra[0]}`);
  if (!isKnownMessageType(message.type)) return invalid(message, 'type must be a known message type');
  if (!isValidRequestId(message.requestId)) {
    return invalid(message, 'requestId must be a UUID string');
  }
  if (message.version !== MESSAGE_PROTOCOL_VERSION) {
    return invalid(message, 'version must be 1');
  }
  if (!isPlainObject(message.payload)) return invalid(message, 'payload must be a plain object');
  const payloadError = validateMessagePayload(/** @type {string} */ (message.type), message.payload);
  if (payloadError) return invalid(message, payloadError);
  return { ok: true, message: /** @type {RuntimeMessage} */ (message), error: null };
}

/**
 * @param {string} type
 * @param {Record<string, unknown>} payload
 * @returns {string | null}
 */
export function validateMessagePayload(type, payload) {
  const allowed = PAYLOAD_FIELDS[type];
  if (!allowed) return 'type must be a known message type';
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(payload)) {
    if (!allowedSet.has(key)) return `unknown payload field: ${key}`;
  }
  return null;
}

/**
 * @param {unknown} _message
 * @param {string} reason
 * @returns {ValidationResult}
 */
function invalid(_message, reason) {
  return {
    ok: false,
    message: null,
    error: createAppError('INVALID_MESSAGE', 'errorInvalidMessage', {
      details: { reason },
      retryable: false,
    }),
  };
}
