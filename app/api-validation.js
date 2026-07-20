// @ts-check

import { ERROR_CODES, createAppError } from '../domain/errors.js';
import { ARTICLE_BODY_KEYS, ARTICLE_DETAIL_KEYS, ARTICLE_ITEM_KEYS, ARTICLE_PAGE_KEYS } from './api-validation-keys.js';
import { validateContentBlocks } from '../domain/article-content-blocks.js';

const BOOTSTRAP_KEYS = new Set([
  'categories',
  'dataRevision',
  'defaultCategoryId',
  'deletingFeeds',
  'feeds',
  'status',
  'systemStats',
]);
const CATEGORY_KEYS = new Set(['id', 'order', 'stats', 'title']);
const DELETING_FEED_KEYS = new Set(['id', 'permissionOrigin', 'title']);
const FEED_KEYS = new Set([
  'categoryId',
  'customTitle',
  'iconColor',
  'iconSource',
  'iconUrl',
  'id',
  'keepReadOnPurge',
  'lastCheckedAtMs',
  'lastErrorCode',
  'lastErrorMessage',
  'lastHttpStatus',
  'mainStreamState',
  'nextFetchAtMs',
  'order',
  'permissionOrigin',
  'permissionState',
  'redirectOriginPending',
  'redirectUrlPending',
  'stats',
  'siteUrl',
  'title',
  'url',
]);
const REFRESH_ALL_SUMMARY_KEYS = new Set(
  'checkedCount failedFeedCount newArticleCount unchangedFeedCount updatedFeedCount'.split(' '),
);
const PLANNER_ALLOWED_KEYS = new Set(['index', 'strategy', 'mode', 'scannedCount']);
const STATS_KEYS = new Set(['articleCount', 'lastArticleAtMs', 'starredCount', 'unreadCount']);
const SYSTEM_STATS_KEYS = new Set(['all', 'main']);
const REQUIRED_ARTICLE_KEYS = Object.freeze([
  'feedId',
  'feedTitle',
  'fetchedAtMs',
  'id',
  'readState',
  'sortAtMs',
  'starredState',
  'summaryText',
  'title',
]);

/**
 * @typedef {{articleCount: number, lastArticleAtMs: number, starredCount: number, unreadCount: number}} RuntimeStats
 * @typedef {{id: string, order: number, stats: RuntimeStats, title: string}} BootstrapCategory
 * @typedef {{categoryId: string, customTitle: string, iconColor: string, iconSource: string, iconUrl: string | null, id: string, keepReadOnPurge: number, lastCheckedAtMs: number, lastErrorCode: string, lastErrorMessage: string, lastHttpStatus: number, mainStreamState: number, nextFetchAtMs: number, order: number, permissionOrigin: string, permissionState: number, redirectOriginPending: string, redirectUrlPending: string, stats: RuntimeStats, siteUrl: string, title: string, url: string}} BootstrapFeed
 * @typedef {{id: string, permissionOrigin: string, title: string}} DeletingFeed
 * @typedef {{categories: BootstrapCategory[], dataRevision: number, defaultCategoryId: string, deletingFeeds: DeletingFeed[], feeds: BootstrapFeed[], status: string, systemStats: {all: RuntimeStats, main: RuntimeStats}}} BootstrapSnapshot
 * @typedef {{dataRevision: number, hasMore: boolean, items: Record<string, unknown>[], nextCursor: string | null, planner: Record<string, unknown>}} ArticlePage
 * @typedef {{contentLength: number, contentText: string, updatedAtMs: number, contentBlocks: import('../domain/article-content-blocks.js').Block[]}} ArticleBody
 * @typedef {Record<string, unknown> & {body: ArticleBody | null, canonicalUrl: string, imageUrl: string | null}} ArticleDetail
 * @typedef {{checkedCount: number, failedFeedCount: number, newArticleCount: number, unchangedFeedCount: number, updatedFeedCount: number}} RefreshAllSummary
 */

/**
 * @param {unknown} input
 * @returns {BootstrapSnapshot}
 */
export function validateBootstrapSnapshot(input) {
  const record = requireRecord(input, 'bootstrap');
  requireOnlyKeys(record, BOOTSTRAP_KEYS, 'bootstrap');
  const systemStats = requireRecord(record.systemStats, 'systemStats');
  requireOnlyKeys(systemStats, SYSTEM_STATS_KEYS, 'systemStats');
  return {
    categories: requireArray(record.categories, 'categories').map(validateCategorySnapshot),
    dataRevision: requireNonNegativeInteger(record.dataRevision, 'dataRevision'),
    defaultCategoryId: requireString(record.defaultCategoryId, 'defaultCategoryId'),
    deletingFeeds: requireArray(record.deletingFeeds, 'deletingFeeds').map(validateDeletingFeed),
    feeds: requireArray(record.feeds, 'feeds').map(validateFeedSnapshot),
    status: requireString(record.status, 'status'),
    systemStats: {
      all: validateStats(requireRecord(systemStats.all, 'systemStats.all')),
      main: validateStats(requireRecord(systemStats.main, 'systemStats.main')),
    },
  };
}

/**
 * @param {unknown} input
 * @returns {ArticlePage}
 */
export function validateArticlePage(input) {
  const record = requireRecord(input, 'articlePage');
  requireOnlyKeys(record, ARTICLE_PAGE_KEYS, 'articlePage');
  return {
    dataRevision: requireNonNegativeInteger(record.dataRevision, 'dataRevision'),
    hasMore: requireBoolean(record.hasMore, 'hasMore'),
    items: requireArray(record.items, 'items').map(validateArticleItem),
    nextCursor: record.nextCursor === null ? null : requireString(record.nextCursor, 'nextCursor'),
    planner: validatePlanner(record.planner),
  };
}

/**
 * @param {unknown} input
 * @returns {ArticleDetail}
 */
export function validateArticleDetail(input) {
  const record = requireRecord(input, 'articleDetail');
  requireOnlyKnownKeys(record, ARTICLE_DETAIL_KEYS, 'articleDetail');
  const { body: _body, ...articleItem } = record;
  const item = validateArticleItem(articleItem);
  return {
    ...item,
    author: requireString(record.author, 'author'),
    body: record.body === null ? null : validateArticleBody(record.body),
    canonicalUrl: requireString(record.canonicalUrl, 'canonicalUrl'),
    imageUrl: record.imageUrl === null ? null : requireString(record.imageUrl, 'imageUrl'),
  };
}

/**
 * @param {unknown} input
 * @returns {RefreshAllSummary}
 */
export function validateRefreshAllSummary(input) {
  const record = requireRecord(input, 'refreshAllSummary');
  requireOnlyKeys(record, REFRESH_ALL_SUMMARY_KEYS, 'refreshAllSummary');
  return {
    checkedCount: requireNonNegativeInteger(record.checkedCount, 'checkedCount'),
    failedFeedCount: requireNonNegativeInteger(record.failedFeedCount, 'failedFeedCount'),
    newArticleCount: requireNonNegativeInteger(record.newArticleCount, 'newArticleCount'),
    unchangedFeedCount: requireNonNegativeInteger(record.unchangedFeedCount, 'unchangedFeedCount'),
    updatedFeedCount: requireNonNegativeInteger(record.updatedFeedCount, 'updatedFeedCount'),
  };
}

/**
 * @param {unknown} input
 * @returns {BootstrapCategory}
 */
function validateCategorySnapshot(input) {
  const record = requireRecord(input, 'category');
  requireOnlyKeys(record, CATEGORY_KEYS, 'category');
  return {
    id: requireString(record.id, 'id'),
    order: requireNonNegativeInteger(record.order, 'order'),
    stats: validateStats(record.stats),
    title: requireString(record.title, 'title'),
  };
}

/**
 * @param {unknown} input
 * @returns {DeletingFeed}
 */
function validateDeletingFeed(input) {
  const record = requireRecord(input, 'deletingFeed');
  requireOnlyKnownKeys(record, DELETING_FEED_KEYS, 'deletingFeed');
  return {
    id: requireString(record.id, 'id'),
    permissionOrigin: optionalString(record.permissionOrigin, 'permissionOrigin'),
    title: requireString(record.title, 'title'),
  };
}

/**
 * @param {unknown} input
 * @returns {BootstrapFeed}
 */
function validateFeedSnapshot(input) {
  const record = requireRecord(input, 'feed');
  requireOnlyKnownKeys(record, FEED_KEYS, 'feed');
  return {
    categoryId: requireString(record.categoryId, 'categoryId'),
    customTitle: optionalString(record.customTitle, 'customTitle'),
    iconColor: optionalString(record.iconColor, 'iconColor'),
    iconSource: optionalString(record.iconSource, 'iconSource'),
    iconUrl: record.iconUrl === null || record.iconUrl === undefined ? null : requireString(record.iconUrl, 'iconUrl'),
    id: requireString(record.id, 'id'),
    keepReadOnPurge: optionalNonNegativeInteger(record.keepReadOnPurge, 'keepReadOnPurge'),
    lastCheckedAtMs: optionalNonNegativeInteger(record.lastCheckedAtMs, 'lastCheckedAtMs'),
    lastErrorCode: optionalString(record.lastErrorCode, 'lastErrorCode'),
    lastErrorMessage: optionalString(record.lastErrorMessage, 'lastErrorMessage'),
    lastHttpStatus: optionalNonNegativeInteger(record.lastHttpStatus, 'lastHttpStatus'),
    mainStreamState: requireNonNegativeInteger(record.mainStreamState, 'mainStreamState'),
    nextFetchAtMs: optionalNonNegativeInteger(record.nextFetchAtMs, 'nextFetchAtMs'),
    order: requireNonNegativeInteger(record.order, 'order'),
    permissionOrigin: optionalString(record.permissionOrigin, 'permissionOrigin'),
    permissionState: optionalNonNegativeInteger(record.permissionState, 'permissionState'),
    redirectOriginPending: optionalString(record.redirectOriginPending, 'redirectOriginPending'),
    redirectUrlPending: optionalString(record.redirectUrlPending, 'redirectUrlPending'),
    stats: validateStats(record.stats),
    siteUrl: optionalString(record.siteUrl, 'siteUrl'),
    title: requireString(record.title, 'title'),
    url: optionalString(record.url, 'url'),
  };
}

/**
 * @param {unknown} input
 * @returns {ArticleBody}
 */
function validateArticleBody(input) {
  const record = requireRecord(input, 'articleBody');
  requireOnlyKeys(record, ARTICLE_BODY_KEYS, 'articleBody');
  return {
    contentLength: requireNonNegativeInteger(record.contentLength, 'contentLength'),
    contentText: requireString(record.contentText, 'contentText'),
    updatedAtMs: requireNonNegativeInteger(record.updatedAtMs, 'updatedAtMs'),
    contentBlocks: validateContentBlocks(record.contentBlocks),
  };
}

/**
 * @param {unknown} input
 */
function validateArticleItem(input) {
  const record = requireRecord(input, 'article');
  requireOnlyKnownKeys(record, ARTICLE_ITEM_KEYS, 'article');
  for (const key of REQUIRED_ARTICLE_KEYS) {
    if (!(key in record)) throw validationError(`article missing field: ${key}`);
  }
  return {
    ...record,
    feedIconColor: optionalString(record.feedIconColor, 'feedIconColor'),
    feedIconSource: optionalString(record.feedIconSource, 'feedIconSource'),
    feedIconUrl:
      record.feedIconUrl === null || record.feedIconUrl === undefined
        ? null
        : requireString(record.feedIconUrl, 'feedIconUrl'),
    feedId: requireString(record.feedId, 'feedId'),
    feedSiteUrl: optionalString(record.feedSiteUrl, 'feedSiteUrl'),
    feedTitle: requireString(record.feedTitle, 'feedTitle'),
    feedUrl: optionalString(record.feedUrl, 'feedUrl'),
    fetchedAtMs: requireNonNegativeInteger(record.fetchedAtMs, 'fetchedAtMs'),
    id: requireString(record.id, 'id'),
    readState: requireNonNegativeInteger(record.readState, 'readState'),
    sortAtMs: requireNonNegativeInteger(record.sortAtMs, 'sortAtMs'),
    starredState: requireNonNegativeInteger(record.starredState, 'starredState'),
    summaryText: requireString(record.summaryText, 'summaryText'),
    title: requireString(record.title, 'title'),
  };
}

/**
 * @param {unknown} input
 * @returns {RuntimeStats}
 */
function validateStats(input) {
  const record = requireRecord(input, 'stats');
  requireOnlyKeys(record, STATS_KEYS, 'stats');
  return {
    articleCount: requireNonNegativeInteger(record.articleCount, 'articleCount'),
    lastArticleAtMs: optionalNonNegativeInteger(record.lastArticleAtMs, 'lastArticleAtMs'),
    starredCount: requireNonNegativeInteger(record.starredCount, 'starredCount'),
    unreadCount: requireNonNegativeInteger(record.unreadCount, 'unreadCount'),
  };
}

/**
 * @param {unknown} input
 */
function validatePlanner(input) {
  const record = requireRecord(input, 'planner');
  requireOnlyKnownKeys(record, PLANNER_ALLOWED_KEYS, 'planner');
  if (!('index' in record)) throw validationError('planner missing field: index');
  if (!('strategy' in record)) throw validationError('planner missing field: strategy');
  const planner = /** @type {Record<string, unknown>} */ ({
    index: requireString(record.index, 'planner.index'),
    strategy: requireString(record.strategy, 'planner.strategy'),
  });
  if (record.mode !== undefined) planner.mode = requireString(record.mode, 'planner.mode');
  if (record.scannedCount !== undefined) {
    planner.scannedCount = requireNonNegativeInteger(record.scannedCount, 'planner.scannedCount');
  }
  return planner;
}

/**
 * @param {Record<string, unknown>} record
 * @param {ReadonlySet<string>} allowed
 * @param {string} label
 */
function requireOnlyKeys(record, allowed, label) {
  requireOnlyKnownKeys(record, allowed, label);
  for (const key of allowed) {
    if (!(key in record)) throw validationError(`${label} missing field: ${key}`);
  }
}

/**
 * @param {Record<string, unknown>} record
 * @param {ReadonlySet<string>} allowed
 * @param {string} label
 */
function requireOnlyKnownKeys(record, allowed, label) {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw validationError(`${label} has unknown field: ${key}`);
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
function requireRecord(value, label) {
  if (isRecord(value)) return value;
  throw validationError(`${label} must be an object`);
}

/**
 * @param {unknown} value
 * @param {string} field
 */
function requireString(value, field) {
  if (typeof value === 'string') return value;
  throw validationError(`${field} must be a string`);
}

/**
 * @param {unknown} value
 * @param {string} field
 */
function optionalString(value, field) {
  if (value === undefined) return '';
  return requireString(value, field);
}

/**
 * @param {unknown} value
 * @param {string} field
 */
function requireBoolean(value, field) {
  if (typeof value === 'boolean') return value;
  throw validationError(`${field} must be a boolean`);
}

/**
 * @param {unknown} value
 * @param {string} field
 */
function requireNonNegativeInteger(value, field) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  throw validationError(`${field} must be a non-negative integer`);
}

/**
 * @param {unknown} value
 * @param {string} field
 */
function optionalNonNegativeInteger(value, field) {
  if (value === undefined) return 0;
  return requireNonNegativeInteger(value, field);
}

/** @param {unknown} value @param {string} field */
function requireArray(value, field) {
  if (Array.isArray(value)) return value;
  throw validationError(`${field} must be an array`);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/** @param {string} reason */
function validationError(reason) {
  return createAppError(ERROR_CODES.INVALID_MESSAGE, { details: { reason } });
}
