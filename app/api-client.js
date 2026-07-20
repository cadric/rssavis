// @ts-check

import { createMessageEnvelope, isValidRequestId } from '../shared/contracts.js';
import { MESSAGE_TYPES } from '../shared/messages.js';
import { ERROR_CODES, createAppError } from '../domain/errors.js';
import { originPatternForUrl } from '../domain/urls.js';
import {
  validateArticleDetail,
  validateArticlePage,
  validateBootstrapSnapshot,
  validateRefreshAllSummary,
} from './api-validation.js';
import { requestHostPermissions } from './permission-request.js';

/**
 * @typedef {object} BrowserRuntimeLike
 * @property {{sendMessage(message: unknown): Promise<unknown>}} runtime
 *
 * @typedef {{articleCount: number, lastArticleAtMs: number, starredCount: number, unreadCount: number}} RuntimeStats
 * @typedef {{id: string, order: number, stats: RuntimeStats, title: string}} BootstrapCategory
 * @typedef {{categoryId: string, customTitle: string, iconColor: string, iconSource: string, iconUrl: string | null, id: string, keepReadOnPurge: number, lastCheckedAtMs: number, lastErrorCode: string, lastErrorMessage: string, lastHttpStatus: number, mainStreamState: number, nextFetchAtMs: number, order: number, permissionOrigin: string, permissionState: number, redirectOriginPending: string, redirectUrlPending: string, stats: RuntimeStats, siteUrl: string, title: string, url: string}} BootstrapFeed
 * @typedef {{id: string, permissionOrigin: string, title: string}} DeletingFeed
 * @typedef {{categories: BootstrapCategory[], dataRevision: number, defaultCategoryId: string, deletingFeeds: DeletingFeed[], feeds: BootstrapFeed[], status: string, systemStats: {all: RuntimeStats, main: RuntimeStats}}} BootstrapSnapshot
 * @typedef {{dataRevision: number, hasMore: boolean, items: Record<string, unknown>[], nextCursor: string | null, planner: Record<string, unknown>}} ArticlePage
 * @typedef {{contentBlocks: import('../domain/article-content-blocks.js').Block[], contentLength: number, contentText: string, updatedAtMs: number}} ArticleBody
 * @typedef {Record<string, unknown> & {body: ArticleBody | null, canonicalUrl: string, imageUrl: string | null}} ArticleDetail
 * @typedef {import('./api-validation.js').RefreshAllSummary} RefreshAllSummary
 */

/**
 * @param {string} type
 * @param {Record<string, unknown>} payload
 * @param {BrowserRuntimeLike} [browserApi]
 * @returns {Promise<unknown>}
 */
export function sendRuntimeMessage(type, payload, browserApi = getBrowserApi()) {
  const envelope = createMessageEnvelope(type, payload);
  return browserApi.runtime
    .sendMessage(envelope)
    .then((response) => validateRuntimeResponseEnvelope(response, envelope.requestId));
}

/**
 * @param {BrowserRuntimeLike} [browserApi]
 * @returns {Promise<BootstrapSnapshot>}
 */
export function bootstrapApp(browserApi = getBrowserApi()) {
  return sendRuntimeMessage(MESSAGE_TYPES.APP_BOOTSTRAP, {}, browserApi).then((response) =>
    validateBootstrapSnapshot(unwrapRuntimeResult(response)),
  );
}

/**
 * @param {'source' | 'license' | 'security'} resource
 * @param {BrowserRuntimeLike} [browserApi]
 * @returns {Promise<unknown>}
 */
export function openTrustedResource(resource, browserApi = getBrowserApi()) {
  return sendRuntimeMessage(MESSAGE_TYPES.APP_OPEN_TRUSTED_RESOURCE, { resource }, browserApi).then(
    unwrapRuntimeResult,
  );
}

/**
 * @param {{scope: import('../domain/scopes.js').Scope, pageSize?: number, cursor?: string | null, filter?: import('./article-filter.js').ArticleReadQueryFilter | null}} input
 * @param {BrowserRuntimeLike} [browserApi]
 * @returns {Promise<ArticlePage>}
 */
export function queryArticles(input, browserApi = getBrowserApi()) {
  return sendRuntimeMessage(MESSAGE_TYPES.ARTICLES_QUERY, cleanArticleQueryPayload(input), browserApi).then(
    (response) => validateArticlePage(unwrapRuntimeResult(response)),
  );
}

/**
 * @param {{scope: import('../domain/scopes.js').Scope, query: string, pageSize?: number, cursor?: string | null}} input
 * @param {BrowserRuntimeLike} [browserApi]
 * @returns {Promise<ArticlePage>}
 */
export function searchArticles(input, browserApi = getBrowserApi()) {
  return sendRuntimeMessage(MESSAGE_TYPES.ARTICLES_SEARCH, cleanArticleSearchPayload(input), browserApi).then(
    (response) => validateArticlePage(unwrapRuntimeResult(response)),
  );
}

/**
 * @param {string} id
 * @param {BrowserRuntimeLike} [browserApi]
 * @returns {Promise<ArticleDetail>}
 */
export function getArticleDetail(id, browserApi = getBrowserApi()) {
  return sendRuntimeMessage(MESSAGE_TYPES.ARTICLES_GET_DETAIL, { id }, browserApi).then((response) =>
    validateArticleDetail(unwrapRuntimeResult(response)),
  );
}

/**
 * @param {string} id
 * @param {number} readState
 * @param {BrowserRuntimeLike} [browserApi]
 */
export function setArticleRead(id, readState, browserApi = getBrowserApi()) {
  return sendRuntimeMessage(MESSAGE_TYPES.ARTICLES_SET_READ, { id, readState }, browserApi).then(unwrapRuntimeResult);
}

/**
 * @param {string} id
 * @param {number} starredState
 * @param {BrowserRuntimeLike} [browserApi]
 */
export function setArticleStarred(id, starredState, browserApi = getBrowserApi()) {
  return sendRuntimeMessage(MESSAGE_TYPES.ARTICLES_SET_STARRED, { id, starredState }, browserApi).then(
    unwrapRuntimeResult,
  );
}

/**
 * @param {{scope: import('../domain/scopes.js').Scope}} input
 * @param {BrowserRuntimeLike} [browserApi]
 */
export function countUnreadForScope(input, browserApi = getBrowserApi()) {
  return sendRuntimeMessage(MESSAGE_TYPES.ARTICLES_COUNT_UNREAD, { scope: input.scope }, browserApi).then(
    unwrapRuntimeResult,
  );
}

/**
 * @param {{scope: import('../domain/scopes.js').Scope, batchSize?: number, maxChunks?: number}} input
 * @param {BrowserRuntimeLike} [browserApi]
 */
export function markScopeRead(input, browserApi = getBrowserApi()) {
  return sendRuntimeMessage(MESSAGE_TYPES.ARTICLES_MARK_SCOPE_READ, cleanMarkScopeReadPayload(input), browserApi).then(
    unwrapRuntimeResult,
  );
}

/**
 * @param {string} id
 * @param {'background-tab' | 'foreground-tab' | 'current-tab'} mode
 * @param {BrowserRuntimeLike} [browserApi]
 */
export function openArticleOriginal(id, mode, browserApi = getBrowserApi()) {
  return sendRuntimeMessage(MESSAGE_TYPES.ARTICLES_OPEN_ORIGINAL, { id, mode }, browserApi).then(unwrapRuntimeResult);
}

/**
 * Opens an inline article-content link through the validated background command
 * (SEC-004). The URL is passed to the command, which re-validates it (https-only)
 * and opens it via `browser.tabs`; the raw feed URL never reaches `location`.
 *
 * @param {string} url
 * @param {'background-tab' | 'foreground-tab' | 'current-tab'} mode
 * @param {BrowserRuntimeLike} [browserApi]
 */
export function openArticleContentLink(url, mode, browserApi = getBrowserApi()) {
  return sendRuntimeMessage(MESSAGE_TYPES.ARTICLES_OPEN_CONTENT_LINK, { url, mode }, browserApi).then(
    unwrapRuntimeResult,
  );
}

/**
 * @param {BrowserRuntimeLike} [browserApi]
 */
export function recordReaderContextActive(browserApi = getBrowserApi()) {
  return sendRuntimeMessage(MESSAGE_TYPES.READER_CONTEXT_ACTIVE, {}, browserApi).then(unwrapRuntimeResult);
}

/**
 * @param {BrowserRuntimeLike} [browserApi]
 */
export function refreshAllFeeds(browserApi = getBrowserApi()) {
  return sendRuntimeMessage(MESSAGE_TYPES.FEEDS_REFRESH_ALL, {}, browserApi)
    .then(unwrapRuntimeResult)
    .then(validateRefreshAllSummary);
}

/**
 * @param {{url: string, title: string, categoryId?: string, customTitle?: string}} input
 * @param {BrowserRuntimeLike} [browserApi]
 * @returns {Promise<unknown>}
 */
export async function addFeedWithPermission(input, browserApi = getBrowserApi()) {
  const origin = originPatternForUrl(input.url);
  await requestHostPermissions(origin, 'feeds.add');
  return sendRuntimeMessage(MESSAGE_TYPES.FEEDS_ADD, cleanFeedAddPayload(input), browserApi);
}

/**
 * @param {{url: string, title: string, categoryId?: string, customTitle?: string}} input
 */
function cleanFeedAddPayload(input) {
  /** @type {Record<string, string>} */
  const payload = { url: input.url, title: input.title };
  if (input.categoryId) payload.categoryId = input.categoryId;
  if (input.customTitle !== undefined) payload.customTitle = input.customTitle;
  return payload;
}

/**
 * @param {{scope: import('../domain/scopes.js').Scope, pageSize?: number, cursor?: string | null, filter?: import('./article-filter.js').ArticleReadQueryFilter | null}} input
 */
function cleanArticleQueryPayload(input) {
  /** @type {Record<string, unknown>} */
  const payload = input.cursor
    ? { scope: input.scope, pageSize: input.pageSize ?? 50, cursor: input.cursor }
    : { scope: input.scope, pageSize: input.pageSize ?? 50 };
  if (input.filter !== undefined && input.filter !== null) payload.filter = input.filter;
  return payload;
}

/**
 * @param {{scope: import('../domain/scopes.js').Scope, query: string, pageSize?: number, cursor?: string | null}} input
 */
function cleanArticleSearchPayload(input) {
  return input.cursor
    ? { scope: input.scope, query: input.query, pageSize: input.pageSize ?? 50, cursor: input.cursor }
    : { scope: input.scope, query: input.query, pageSize: input.pageSize ?? 50 };
}

/**
 * @param {{scope: import('../domain/scopes.js').Scope, batchSize?: number, maxChunks?: number}} input
 */
function cleanMarkScopeReadPayload(input) {
  return {
    scope: input.scope,
    ...(input.batchSize === undefined ? {} : { batchSize: input.batchSize }),
    ...(input.maxChunks === undefined ? {} : { maxChunks: input.maxChunks }),
  };
}

/**
 * @param {unknown} response
 * @returns {unknown}
 */
export function unwrapRuntimeResult(response) {
  const record = validateRuntimeResponseEnvelope(response);
  if (record.ok === true) {
    requireNonNegativeInteger(record.dataRevision, 'dataRevision');
    return record.data;
  }
  if (record.ok === false) {
    const error = validateRuntimeError(record.error);
    throw createAppError(error.code, {
      details: error.details,
      messageKey: error.messageKey,
      retryable: error.retryable,
    });
  }
  throw createAppError(ERROR_CODES.INVALID_MESSAGE, {
    details: { reason: 'runtime response did not match result envelope' },
  });
}

const SUCCESS_RESPONSE_KEYS = new Set(['ok', 'requestId', 'data', 'dataRevision']);
const ERROR_RESPONSE_KEYS = new Set(['ok', 'requestId', 'error']);
const ERROR_OBJECT_KEYS = new Set(['code', 'details', 'messageKey', 'retryable']);

/**
 * @param {unknown} response
 * @param {string} [expectedRequestId]
 */
function validateRuntimeResponseEnvelope(response, expectedRequestId = '') {
  const record = requireRecord(response, 'runtime response');
  if (record.ok === true) {
    requireResponseKeys(record, SUCCESS_RESPONSE_KEYS, 'success response');
  } else if (record.ok === false) {
    requireResponseKeys(record, ERROR_RESPONSE_KEYS, 'error response');
  } else {
    throw createAppError(ERROR_CODES.INVALID_MESSAGE, {
      details: { reason: 'runtime response did not match result envelope' },
    });
  }
  requireResponseRequestId(record.requestId, expectedRequestId);
  return record;
}

/**
 * @param {unknown} value
 * @param {string} expectedRequestId
 */
function requireResponseRequestId(value, expectedRequestId) {
  if (!isValidRequestId(value)) {
    throw createAppError(ERROR_CODES.INVALID_MESSAGE, { details: { reason: 'response requestId must be a UUID' } });
  }
  if (expectedRequestId && value !== expectedRequestId) {
    throw createAppError(ERROR_CODES.INVALID_MESSAGE, { details: { reason: 'response requestId mismatch' } });
  }
}

/**
 * @param {unknown} input
 */
function validateRuntimeError(input) {
  const error = requireRecord(input, 'error response error');
  requireResponseKeys(error, ERROR_OBJECT_KEYS, 'error response error');
  const details = error.details === null ? null : requireRecord(error.details, 'error response details');
  return {
    code: requireString(error.code, 'error.code'),
    details,
    messageKey: requireString(error.messageKey, 'error.messageKey'),
    retryable: requireBoolean(error.retryable, 'error.retryable'),
  };
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
function requireRecord(value, label) {
  if (isRecord(value)) return value;
  throw createAppError(ERROR_CODES.INVALID_MESSAGE, { details: { reason: `${label} must be an object` } });
}

/**
 * @param {Record<string, unknown>} record
 * @param {ReadonlySet<string>} allowed
 * @param {string} label
 */
function requireResponseKeys(record, allowed, label) {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw createAppError(ERROR_CODES.INVALID_MESSAGE, { details: { reason: `${label} has unknown field: ${key}` } });
    }
  }
  for (const key of allowed) {
    if (!(key in record)) {
      throw createAppError(ERROR_CODES.INVALID_MESSAGE, { details: { reason: `${label} missing field: ${key}` } });
    }
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * @param {unknown} value
 */
/**
 * @param {unknown} value
 * @param {string} field
 */
function requireNonNegativeInteger(value, field) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  throw createAppError(ERROR_CODES.INVALID_MESSAGE, { details: { reason: `${field} must be a non-negative integer` } });
}

/**
 * @param {unknown} value
 * @param {string} field
 */
function requireString(value, field) {
  if (typeof value === 'string' && value.length > 0) return value;
  throw createAppError(ERROR_CODES.INVALID_MESSAGE, { details: { reason: `${field} must be a string` } });
}

/**
 * @param {unknown} value
 * @param {string} field
 */
function requireBoolean(value, field) {
  if (typeof value === 'boolean') return value;
  throw createAppError(ERROR_CODES.INVALID_MESSAGE, { details: { reason: `${field} must be a boolean` } });
}

function getBrowserApi() {
  return /** @type {{browser: BrowserRuntimeLike}} */ (/** @type {unknown} */ (globalThis)).browser;
}
