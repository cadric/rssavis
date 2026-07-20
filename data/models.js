// @ts-check

import { chooseArticleSortAtMs } from '../domain/dates.js';
import { buildSearchText, normalizePlainText } from '../domain/text.js';
import { normalizeArticleUrl, normalizeFeedUrl, normalizeHttpUrl, originPatternForUrl } from '../domain/urls.js';
import { validateContentBlocks } from '../domain/article-content-blocks.js';
import { STATE } from './constants.js';
import {
  optionalEnumNumber,
  optionalEnumString,
  optionalEpochMs,
  optionalNonNegativeInteger,
  optionalString,
  rejectUnknownFields,
  requireArticleId,
  requireEpochMs,
  requireHash,
  requireRecord,
  requireString,
  requireUuidId,
  validationError,
} from './validators.js';

const STATE_VALUES = new Set(Object.values(STATE));
const IDENTITY_KINDS = new Set(['guid', 'url', 'fallback']);
const ICON_SOURCES = new Set(['auto', 'favicon']);
const ICON_COLORS = new Set(['', '0', '1', '2', '3', '4', '5', '6', '7', '8']);

const CATEGORY_FIELDS = new Set(['id', 'title', 'normalizedTitle', 'order', 'createdAtMs', 'updatedAtMs']);
const FEED_FIELDS = new Set([
  'id',
  'title',
  'customTitle',
  'url',
  'normalizedUrl',
  'resolvedUrl',
  'siteUrl',
  'iconUrl',
  'iconSource',
  'builtinIconKey',
  'iconColor',
  'categoryId',
  'mainStreamState',
  'order',
  'permissionOrigin',
  'permissionState',
  'redirectOriginPending',
  'redirectUrlPending',
  'scheduleState',
  'etag',
  'lastModified',
  'lastCheckedAtMs',
  'lastSuccessAtMs',
  'nextFetchAtMs',
  'consecutiveFailures',
  'lastHttpStatus',
  'lastErrorCode',
  'lastErrorMessage',
  'leaseState',
  'leaseOwner',
  'leaseExpiresAtMs',
  'deletionState',
  'keepReadOnPurge',
  'createdAtMs',
  'updatedAtMs',
]);
const ARTICLE_FIELDS = new Set([
  'id',
  'feedId',
  'primaryIdentityKey',
  'guid',
  'canonicalUrl',
  'title',
  'author',
  'publishedAtMs',
  'sourceUpdatedAtMs',
  'fetchedAtMs',
  'sortAtMs',
  'readState',
  'starredState',
  'summaryText',
  'searchText',
  'imageUrl',
  'hasBodyState',
  'sourceRevisionHash',
  'createdAtMs',
  'changedAtMs',
]);
const IDENTITY_FIELDS = new Set(['key', 'feedId', 'articleId', 'kind', 'valueHash', 'createdAtMs']);
const BODY_FIELDS = new Set(['articleId', 'contentText', 'contentLength', 'updatedAtMs', 'contentBlocks']);
const STATS_FIELDS = new Set([
  'id',
  'scopeType',
  'scopeId',
  'articleCount',
  'unreadCount',
  'starredCount',
  'lastArticleAtMs',
  'updatedAtMs',
]);

/** @typedef {import('./model-types.js').CategoryRecord} CategoryRecord */
/** @typedef {import('./model-types.js').FeedRecord} FeedRecord */
/** @typedef {import('./model-types.js').ArticleRecord} ArticleRecord */
/** @typedef {import('./model-types.js').ArticleIdentityRecord} ArticleIdentityRecord */
/** @typedef {import('./model-types.js').ArticleBodyRecord} ArticleBodyRecord */
/** @typedef {import('./model-types.js').StatsRecord} StatsRecord */

/**
 * @param {unknown} input
 * @returns {CategoryRecord}
 */
export function normalizeCategoryRecord(input) {
  const record = requireRecord(input, 'category');
  rejectUnknownFields(record, CATEGORY_FIELDS);
  const title = normalizePlainText(requireString(record, 'title', 200), { maxCodePoints: 200 });
  const createdAtMs = requireEpochMs(record, 'createdAtMs');
  return {
    id: requireUuidId(record, 'id', 'cat'),
    title,
    normalizedTitle: normalizePlainText(optionalString(record, 'normalizedTitle', title, 200), {
      maxCodePoints: 200,
    }).toLowerCase(),
    order: requireOrder(record),
    createdAtMs,
    updatedAtMs: optionalEpochMs(record, 'updatedAtMs', createdAtMs),
  };
}

/**
 * @param {unknown} input
 * @returns {FeedRecord}
 */
export function normalizeFeedRecord(input) {
  const record = requireRecord(input, 'feed');
  rejectUnknownFields(record, FEED_FIELDS);
  const url = normalizeFeedUrl(requireString(record, 'url', 8192));
  const permissionState = optionalEnumNumber(record, 'permissionState', STATE_VALUES, STATE.OFF);
  const createdAtMs = requireEpochMs(record, 'createdAtMs');
  return {
    id: requireUuidId(record, 'id', 'feed'),
    title: normalizePlainText(requireString(record, 'title', 2048), { maxCodePoints: 2048 }),
    customTitle: normalizePlainText(optionalString(record, 'customTitle', '', 2048), { maxCodePoints: 2048 }),
    url,
    normalizedUrl: normalizeFeedUrl(optionalString(record, 'normalizedUrl', url, 8192)),
    resolvedUrl: normalizeOptionalUrl(record, 'resolvedUrl'),
    siteUrl: normalizeOptionalUrl(record, 'siteUrl'),
    iconUrl: normalizeNullableUrl(record, 'iconUrl'),
    // B36: a stored legacy 'builtin' source reads as 'auto', and builtinIconKey stays tolerated
    // input without a normalized output field until the v6 post-migration rewrites every record.
    iconSource: /** @type {'auto' | 'favicon'} */ (
      record.iconSource === 'builtin' ? 'auto' : optionalEnumString(record, 'iconSource', ICON_SOURCES, 'auto')
    ),
    iconColor: optionalEnumString(record, 'iconColor', ICON_COLORS, ''),
    categoryId: requireUuidId(record, 'categoryId', 'cat'),
    mainStreamState: optionalEnumNumber(record, 'mainStreamState', STATE_VALUES, STATE.ON),
    order: requireOrder(record),
    permissionOrigin: optionalString(record, 'permissionOrigin', originPatternForUrl(url), 8192),
    permissionState,
    redirectOriginPending: optionalString(record, 'redirectOriginPending', '', 8192),
    redirectUrlPending: normalizeOptionalUrl(record, 'redirectUrlPending'),
    scheduleState: optionalEnumNumber(record, 'scheduleState', STATE_VALUES, permissionState),
    etag: optionalString(record, 'etag', '', 1024),
    lastModified: optionalString(record, 'lastModified', '', 1024),
    lastCheckedAtMs: optionalEpochMs(record, 'lastCheckedAtMs', 0),
    lastSuccessAtMs: optionalEpochMs(record, 'lastSuccessAtMs', 0),
    nextFetchAtMs: optionalEpochMs(record, 'nextFetchAtMs', 0),
    consecutiveFailures: optionalNonNegativeInteger(record, 'consecutiveFailures', 0),
    lastHttpStatus: optionalNonNegativeInteger(record, 'lastHttpStatus', 0),
    lastErrorCode: optionalString(record, 'lastErrorCode', '', 128),
    lastErrorMessage: optionalString(record, 'lastErrorMessage', '', 500),
    leaseState: optionalEnumNumber(record, 'leaseState', STATE_VALUES, STATE.OFF),
    leaseOwner: optionalString(record, 'leaseOwner', '', 128),
    leaseExpiresAtMs: optionalEpochMs(record, 'leaseExpiresAtMs', 0),
    deletionState: optionalEnumNumber(record, 'deletionState', STATE_VALUES, STATE.OFF),
    keepReadOnPurge: optionalEnumNumber(record, 'keepReadOnPurge', STATE_VALUES, STATE.OFF),
    createdAtMs,
    updatedAtMs: optionalEpochMs(record, 'updatedAtMs', createdAtMs),
  };
}

/**
 * @param {unknown} input
 * @returns {ArticleRecord}
 */
export function normalizeArticleRecord(input) {
  const record = requireRecord(input, 'article');
  rejectUnknownFields(record, ARTICLE_FIELDS);
  const primaryIdentityKey = requireString(record, 'primaryIdentityKey', 256);
  const guid = optionalString(record, 'guid', '', 2048);
  const canonicalUrlInput = requireString(record, 'canonicalUrl', 8192);
  if (!canonicalUrlInput && !guid && !primaryIdentityKey.includes('\u001ffallback\u001f')) {
    throw validationError('canonicalUrl', 'empty URL requires another identity');
  }
  const fetchedAtMs = requireEpochMs(record, 'fetchedAtMs');
  const publishedAtMs = optionalEpochMs(record, 'publishedAtMs', 0);
  const sourceUpdatedAtMs = optionalEpochMs(record, 'sourceUpdatedAtMs', 0);
  const title = normalizePlainText(requireString(record, 'title', 2048), { maxCodePoints: 2048 });
  const author = normalizePlainText(optionalString(record, 'author', '', 512), { maxCodePoints: 512 });
  const summaryText = normalizeSummary(record);
  return {
    id: requireArticleId(record, 'id'),
    feedId: requireUuidId(record, 'feedId', 'feed'),
    primaryIdentityKey,
    guid,
    canonicalUrl: canonicalUrlInput ? normalizeArticleUrl(canonicalUrlInput) : '',
    title,
    author,
    publishedAtMs,
    sourceUpdatedAtMs,
    fetchedAtMs,
    sortAtMs: optionalEpochMs(record, 'sortAtMs', chooseArticleSortAtMs(publishedAtMs, sourceUpdatedAtMs, fetchedAtMs)),
    readState: optionalEnumNumber(record, 'readState', STATE_VALUES, STATE.OFF),
    starredState: optionalEnumNumber(record, 'starredState', STATE_VALUES, STATE.OFF),
    summaryText,
    searchText: optionalString(record, 'searchText', buildSearchText({ title, author, summaryText }), 65536),
    imageUrl: normalizeOptionalUrl(record, 'imageUrl'),
    hasBodyState: optionalEnumNumber(record, 'hasBodyState', STATE_VALUES, STATE.OFF),
    sourceRevisionHash: optionalString(record, 'sourceRevisionHash', '', 64),
    createdAtMs: requireEpochMs(record, 'createdAtMs'),
    changedAtMs: requireEpochMs(record, 'changedAtMs'),
  };
}

/**
 * @param {unknown} input
 * @returns {ArticleIdentityRecord}
 */
export function normalizeArticleIdentityRecord(input) {
  const record = requireRecord(input, 'articleIdentity');
  rejectUnknownFields(record, IDENTITY_FIELDS);
  const kind = requireString(record, 'kind', 16);
  if (!IDENTITY_KINDS.has(kind)) throw validationError('kind', 'invalid identity kind');
  return {
    key: requireString(record, 'key', 256),
    feedId: requireUuidId(record, 'feedId', 'feed'),
    articleId: requireArticleId(record, 'articleId'),
    kind: /** @type {'guid' | 'url' | 'fallback'} */ (kind),
    valueHash: requireHash(record, 'valueHash'),
    createdAtMs: requireEpochMs(record, 'createdAtMs'),
  };
}

/**
 * @param {unknown} input
 * @returns {ArticleBodyRecord}
 */
export function normalizeArticleBodyRecord(input) {
  const record = requireRecord(input, 'articleBody');
  rejectUnknownFields(record, BODY_FIELDS);
  const contentText = normalizePlainText(requireString(record, 'contentText', 524288), { maxCodePoints: 524288 });
  return {
    articleId: requireArticleId(record, 'articleId'),
    contentText,
    contentLength: optionalNonNegativeInteger(record, 'contentLength', contentText.length),
    updatedAtMs: requireEpochMs(record, 'updatedAtMs'),
    contentBlocks: validateContentBlocks(record.contentBlocks ?? []),
  };
}

/**
 * @param {unknown} input
 * @returns {StatsRecord}
 */
export function normalizeStatsRecord(input) {
  const record = requireRecord(input, 'stats');
  rejectUnknownFields(record, STATS_FIELDS);
  const scopeType = requireString(record, 'scopeType', 16);
  if (scopeType !== 'global' && scopeType !== 'feed') throw validationError('scopeType', 'invalid stats scope');
  return {
    id: requireString(record, 'id', 128),
    scopeType,
    scopeId: optionalString(record, 'scopeId', '', 128),
    articleCount: optionalNonNegativeInteger(record, 'articleCount', 0),
    unreadCount: optionalNonNegativeInteger(record, 'unreadCount', 0),
    starredCount: optionalNonNegativeInteger(record, 'starredCount', 0),
    lastArticleAtMs: optionalEpochMs(record, 'lastArticleAtMs', 0),
    updatedAtMs: requireEpochMs(record, 'updatedAtMs'),
  };
}

/**
 * @param {Record<string, unknown>} record
 * @returns {number}
 */
function requireOrder(record) {
  const value = record.order;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw validationError('order', 'must be a non-negative integer');
  }
  return value;
}

/**
 * @param {Record<string, unknown>} record
 * @returns {string}
 */
function normalizeSummary(record) {
  return normalizePlainText(optionalString(record, 'summaryText', '', 32768), { maxCodePoints: 32768 });
}

/**
 * @param {Record<string, unknown>} record
 * @param {string} field
 * @returns {string}
 */
function normalizeOptionalUrl(record, field) {
  const value = optionalString(record, field, '', 8192);
  return value ? normalizeHttpUrl(value) : '';
}

/**
 * @param {Record<string, unknown>} record
 * @param {string} field
 * @returns {string | null}
 */
function normalizeNullableUrl(record, field) {
  if (!(field in record) || record[field] === null) return null;
  const value = optionalString(record, field, '', 8192);
  return value ? normalizeHttpUrl(value) : null;
}
