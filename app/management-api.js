// @ts-check

import { ERROR_CODES, createAppError } from '../domain/errors.js';
import { originPatternForUrl } from '../domain/urls.js';
import { MESSAGE_TYPES } from '../shared/messages.js';
import { sendRuntimeMessage, unwrapRuntimeResult } from './api-client.js';
import { requestHostPermissions } from './permission-request.js';

/**
 * @typedef {import('./api-client.js').BrowserRuntimeLike} BrowserRuntimeLike
 */

/**
 * @param {string} id
 * @param {BrowserRuntimeLike} [browserApi]
 */
export function refreshOneFeed(id, browserApi) {
  return sendRuntimeMessage(MESSAGE_TYPES.FEEDS_REFRESH_ONE, { id }, browserApi).then(unwrapRuntimeResult);
}

/**
 * @param {{id: string, redirectOriginPending: string}} input
 * @param {BrowserRuntimeLike} [browserApi]
 */
export async function grantFeedRedirectPermission(input, browserApi) {
  const api = requireBrowserApi(browserApi);
  await requestHostPermissions(input.redirectOriginPending, 'feeds.grantRedirect');
  return sendRuntimeMessage(MESSAGE_TYPES.FEEDS_GRANT_REDIRECT, { id: input.id }, api).then(unwrapRuntimeResult);
}

/**
 * @param {{id: string, permissionOrigin: string}} input
 * @param {BrowserRuntimeLike} [browserApi]
 */
export async function grantFeedPermission(input, browserApi) {
  const api = requireBrowserApi(browserApi);
  await requestHostPermissions(input.permissionOrigin, 'feeds.grantPermission');
  return sendRuntimeMessage(MESSAGE_TYPES.FEEDS_GRANT_PERMISSION, { id: input.id }, api).then(unwrapRuntimeResult);
}

/**
 * @param {{id: string, patch: {title?: string, customTitle?: string, url?: string, categoryId?: string, mainStreamState?: number, keepReadOnPurge?: number}}} input
 * @param {BrowserRuntimeLike} [browserApi]
 */
export function updateFeed(input, browserApi) {
  return sendRuntimeMessage(MESSAGE_TYPES.FEEDS_UPDATE, input, browserApi).then(unwrapRuntimeResult);
}

/**
 * @param {{id: string, patch: {title?: string, customTitle?: string, url?: string, categoryId?: string, mainStreamState?: number, keepReadOnPurge?: number}}} input
 * @param {BrowserRuntimeLike} [browserApi]
 */
export async function updateFeedWithPermission(input, browserApi) {
  const api = requireBrowserApi(browserApi);
  if (input.patch.url) {
    const origin = originPatternForUrl(input.patch.url);
    await requestHostPermissions(origin, 'feeds.update');
  }
  return updateFeed(input, api);
}

/**
 * @param {{id: string, categoryId: string, direction: 'up' | 'down'}} input
 * @param {BrowserRuntimeLike} [browserApi]
 */
export function moveFeed(input, browserApi) {
  return sendRuntimeMessage(MESSAGE_TYPES.FEEDS_MOVE, input, browserApi).then(unwrapRuntimeResult);
}

/**
 * @param {{id: string, categoryId: string}} input
 * @param {BrowserRuntimeLike} [browserApi]
 */
export function moveFeedToCategory(input, browserApi) {
  return sendRuntimeMessage(MESSAGE_TYPES.FEEDS_MOVE_CATEGORY, input, browserApi).then(unwrapRuntimeResult);
}

/**
 * @param {string} id
 * @param {BrowserRuntimeLike} [browserApi]
 */
export function deleteFeed(id, browserApi) {
  return sendRuntimeMessage(MESSAGE_TYPES.FEEDS_DELETE, { id }, browserApi).then(unwrapRuntimeResult);
}

/**
 * @param {{title: string}} input
 * @param {BrowserRuntimeLike} [browserApi]
 */
export function createCategory(input, browserApi) {
  return sendRuntimeMessage(MESSAGE_TYPES.CATEGORIES_CREATE, input, browserApi).then(unwrapRuntimeResult);
}

/**
 * @param {{id: string, title: string}} input
 * @param {BrowserRuntimeLike} [browserApi]
 */
export function renameCategory(input, browserApi) {
  return sendRuntimeMessage(MESSAGE_TYPES.CATEGORIES_RENAME, input, browserApi).then(unwrapRuntimeResult);
}

/**
 * @param {{id: string, direction: 'up' | 'down'}} input
 * @param {BrowserRuntimeLike} [browserApi]
 */
export function moveCategory(input, browserApi) {
  return sendRuntimeMessage(MESSAGE_TYPES.CATEGORIES_MOVE, input, browserApi).then(unwrapRuntimeResult);
}

/**
 * @param {string} id
 * @param {BrowserRuntimeLike} [browserApi]
 */
export function deleteCategory(id, browserApi) {
  return sendRuntimeMessage(MESSAGE_TYPES.CATEGORIES_DELETE, { id }, browserApi).then(unwrapRuntimeResult);
}

/**
 * @param {string} opmlText
 * @param {BrowserRuntimeLike} [browserApi]
 */
export function previewOpmlImport(opmlText, browserApi) {
  return sendRuntimeMessage(MESSAGE_TYPES.OPML_PREVIEW_IMPORT, { opmlText }, browserApi)
    .then(unwrapRuntimeResult)
    .then(validateOpmlPreviewDto);
}

/**
 * @param {unknown} importModel
 * @param {BrowserRuntimeLike} [browserApi]
 */
export function commitOpmlImport(importModel, browserApi) {
  return sendRuntimeMessage(MESSAGE_TYPES.OPML_COMMIT_IMPORT, { importModel }, browserApi).then(unwrapRuntimeResult);
}

/**
 * @param {BrowserRuntimeLike} [browserApi]
 */
export function exportOpml(browserApi) {
  return sendRuntimeMessage(MESSAGE_TYPES.OPML_EXPORT, {}, browserApi).then(unwrapRuntimeResult);
}

/**
 * @param {BrowserRuntimeLike | undefined} browserApi
 * @returns {BrowserRuntimeLike}
 */
function requireBrowserApi(browserApi) {
  if (browserApi) return browserApi;
  throw createAppError(ERROR_CODES.INTERNAL_ERROR);
}

const OPML_PREVIEW_KEYS = new Set([
  'alreadySubscribedCount',
  'categoryCount',
  'duplicateInFileCount',
  'errors',
  'feeds',
  'importModel',
  'invalidCount',
  'originPatterns',
  'uniqueOriginCount',
  'validCount',
]);
const OPML_IMPORT_MODEL_KEYS = new Set(['feeds', 'originPatterns', 'version']);
const OPML_IMPORT_FEED_KEYS = new Set([
  'categoryTitle',
  'htmlUrl',
  'normalizedUrl',
  'originPattern',
  'sourceOrder',
  'title',
  'type',
  'xmlUrl',
]);
const OPML_PREVIEW_FEED_KEYS = new Set([...OPML_IMPORT_FEED_KEYS, 'status']);
const OPML_PREVIEW_ERROR_KEYS = new Set(['code', 'reason', 'sourceOrder']);

/**
 * @param {unknown} input
 */
function validateOpmlPreviewDto(input) {
  const record = requireExactRecord(input, OPML_PREVIEW_KEYS, 'opmlPreview');
  const importModel = validateOpmlImportModelDto(record.importModel);
  const originPatterns = stringArray(record.originPatterns, 'originPatterns');
  const preview = Object.freeze({
    alreadySubscribedCount: nonNegativeInteger(record.alreadySubscribedCount, 'alreadySubscribedCount'),
    categoryCount: nonNegativeInteger(record.categoryCount, 'categoryCount'),
    duplicateInFileCount: nonNegativeInteger(record.duplicateInFileCount, 'duplicateInFileCount'),
    errors: Object.freeze(arrayValue(record.errors, 'errors').map(validateOpmlPreviewError)),
    feeds: Object.freeze(arrayValue(record.feeds, 'feeds').map(validateOpmlPreviewFeed)),
    importModel,
    invalidCount: nonNegativeInteger(record.invalidCount, 'invalidCount'),
    originPatterns: Object.freeze(originPatterns),
    uniqueOriginCount: nonNegativeInteger(record.uniqueOriginCount, 'uniqueOriginCount'),
    validCount: nonNegativeInteger(record.validCount, 'validCount'),
  });
  requireSameStringList(preview.originPatterns, importModel.originPatterns, 'originPatterns');
  return preview;
}

/**
 * @param {unknown} input
 */
function validateOpmlImportModelDto(input) {
  const record = requireExactRecord(input, OPML_IMPORT_MODEL_KEYS, 'importModel');
  if (record.version !== 1) throw invalidOpmlPreview('importModel.version');
  return Object.freeze({
    feeds: Object.freeze(arrayValue(record.feeds, 'importModel.feeds').map(validateOpmlImportFeed)),
    originPatterns: Object.freeze(stringArray(record.originPatterns, 'importModel.originPatterns')),
    version: /** @type {1} */ (1),
  });
}

/**
 * @param {unknown} input
 */
function validateOpmlImportFeed(input) {
  const record = requireExactRecord(input, OPML_IMPORT_FEED_KEYS, 'feed');
  return Object.freeze({
    categoryTitle: requiredString(record.categoryTitle, 'feed.categoryTitle'),
    htmlUrl: requiredString(record.htmlUrl, 'feed.htmlUrl'),
    normalizedUrl: requiredString(record.normalizedUrl, 'feed.normalizedUrl'),
    originPattern: requiredString(record.originPattern, 'feed.originPattern'),
    sourceOrder: nonNegativeInteger(record.sourceOrder, 'feed.sourceOrder'),
    title: requiredString(record.title, 'feed.title'),
    type: opmlFeedType(record.type, 'feed.type'),
    xmlUrl: requiredString(record.xmlUrl, 'feed.xmlUrl'),
  });
}

/**
 * @param {unknown} input
 */
function validateOpmlPreviewFeed(input) {
  const record = requireExactRecord(input, OPML_PREVIEW_FEED_KEYS, 'previewFeed');
  const feed = validateOpmlImportFeed(stripPreviewFeedStatus(record));
  const status = record.status;
  if (status !== 'valid' && status !== 'already-subscribed') throw invalidOpmlPreview('previewFeed.status');
  return Object.freeze({ ...feed, status });
}

/**
 * @param {unknown} input
 */
function validateOpmlPreviewError(input) {
  const record = requireExactRecord(input, OPML_PREVIEW_ERROR_KEYS, 'previewError');
  return Object.freeze({
    code: requiredString(record.code, 'previewError.code'),
    reason: requiredString(record.reason, 'previewError.reason'),
    sourceOrder: nonNegativeInteger(record.sourceOrder, 'previewError.sourceOrder'),
  });
}

/**
 * @param {Record<string, unknown>} record
 */
function stripPreviewFeedStatus(record) {
  const { status: _status, ...feed } = record;
  return feed;
}

/**
 * @param {unknown} input
 * @param {ReadonlySet<string>} keys
 * @param {string} field
 */
function requireExactRecord(input, keys, field) {
  if (!isRecord(input)) throw invalidOpmlPreview(field);
  for (const key of Object.keys(input)) {
    if (!keys.has(key)) throw invalidOpmlPreview(`${field}.${key}`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(input, key)) throw invalidOpmlPreview(`${field}.${key}`);
  }
  return input;
}

/**
 * @param {unknown} input
 * @param {string} field
 */
function stringArray(input, field) {
  return arrayValue(input, field).map((value, index) => requiredString(value, `${field}.${index}`));
}

/**
 * @param {unknown} input
 * @param {string} field
 * @returns {unknown[]}
 */
function arrayValue(input, field) {
  if (!Array.isArray(input)) throw invalidOpmlPreview(field);
  return input;
}

/**
 * @param {unknown} input
 * @param {string} field
 */
function requiredString(input, field) {
  if (typeof input !== 'string') throw invalidOpmlPreview(field);
  return input;
}

/**
 * @param {unknown} input
 * @param {string} field
 */
function nonNegativeInteger(input, field) {
  if (!Number.isSafeInteger(input) || Number(input) < 0) throw invalidOpmlPreview(field);
  return Number(input);
}

/**
 * @param {unknown} input
 * @param {string} field
 * @returns {'rss' | 'atom' | null}
 */
function opmlFeedType(input, field) {
  if (input === null || input === 'rss' || input === 'atom') return input;
  throw invalidOpmlPreview(field);
}

/**
 * @param {readonly string[]} left
 * @param {readonly string[]} right
 * @param {string} field
 */
function requireSameStringList(left, right, field) {
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    throw invalidOpmlPreview(field);
  }
}

/**
 * @param {string} field
 */
function invalidOpmlPreview(field) {
  return createAppError(ERROR_CODES.VALIDATION_ERROR, {
    details: { field },
    messageKey: 'opmlPreviewInvalid',
    retryable: false,
  });
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}
