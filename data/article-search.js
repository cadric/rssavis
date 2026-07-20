// @ts-check

import { normalizeSearchText } from '../domain/text.js';
import { normalizeScope, scopeToStorageKey } from '../domain/scopes.js';
import { createAppError, ERROR_CODES } from '../domain/errors.js';
import { DELETION_STATE, INDEXES, STATE, STORES } from './constants.js';
import { toArticleListItem } from './article-list-item.js';
import { readDataRevision } from './meta-repository.js';
import { decodeCursor, encodeCursor, normalizePageSize, queryHashFor } from './pagination.js';
import { compareKey, resolvePlanInTransaction } from './query-planner.js';
import { requestToPromise, runTransaction } from './transaction.js';

const HIGH_STRING = '\uffff';
const MAX_SEARCH_QUERY_CODE_POINTS = 200;
const SEARCH_SCAN_LIMIT = 2000;
const LEGACY_SEARCH_TEXT_PREFIX = /^(?:v1|v2) /u;

/**
 * @typedef {import('./transaction.js').TransactionOptions} RepositoryOptions
 * @typedef {import('./query-planner.js').QueryPlan} QueryPlan
 * @typedef {{scope: import('../domain/scopes.js').Scope, query: string, pageSize: number, cursor: unknown}} ArticleSearch
 * @typedef {{items: import('./models.js').ArticleRecord[], hasMore: boolean, cursorState: {lastKey: unknown[]} | null, scannedCount: number}} SearchPage
 */

/**
 * @param {unknown} input
 * @param {RepositoryOptions} options
 */
export async function searchArticles(input, options = {}) {
  const query = normalizeArticleSearch(input);
  const plan = await resolveArticleSearchPlan(query, options);
  const descriptor = searchDescriptor(plan, query);
  const queryHash = await queryHashFor(descriptor);
  return runTransaction(
    [STORES.FEEDS, STORES.ARTICLES, STORES.META],
    'readonly',
    async (transaction) => {
      const dataRevision = await readDataRevision(transaction);
      const cursor = query.cursor ? decodeCursor(query.cursor, { queryHash, dataRevision }) : null;
      const feedTitles = await readFeedSearchText(transaction);
      const page = await collectSearchPage(transaction, plan, query, feedTitles, cursor?.lastKey ?? null);
      return {
        items: page.items.map(toArticleListItem),
        nextCursor:
          page.hasMore && page.cursorState ? encodeNextCursor(plan, queryHash, dataRevision, page.cursorState) : null,
        hasMore: page.hasMore,
        dataRevision,
        planner: {
          strategy: plan.strategy,
          index: plan.indexName,
          mode: 'search',
          scannedCount: page.scannedCount,
        },
      };
    },
    options,
  );
}

/**
 * @param {ArticleSearch} query
 * @param {RepositoryOptions} options
 */
function resolveArticleSearchPlan(query, options) {
  return runTransaction(
    [STORES.CATEGORIES, STORES.FEEDS],
    'readonly',
    async (transaction) => searchPlan(await resolvePlanInTransaction(transaction, query.scope, null)),
    options,
  );
}

/**
 * @param {unknown} input
 * @returns {ArticleSearch}
 */
export function normalizeArticleSearch(input) {
  if (!isRecord(input)) throw validationError('search', 'must be a plain object');
  const allowed = new Set(['scope', 'query', 'cursor', 'pageSize']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw validationError(key, `unknown field: ${key}`);
  const query = normalizeSearchQuery(input.query);
  return {
    scope: normalizeScope(input.scope),
    query,
    pageSize: normalizePageSize(input.pageSize, 100, 100),
    cursor: input.cursor ?? null,
  };
}

/**
 * @param {QueryPlan} plan
 * @param {ArticleSearch} query
 */
function searchDescriptor(plan, query) {
  return {
    scope: scopeToStorageKey(query.scope),
    query: query.query,
    pageSize: query.pageSize,
    mode: 'search',
    strategy: plan.strategy,
    index: plan.indexName,
    feedIds: plan.feedIds,
    stateFilter: plan.stateFilter,
  };
}

/**
 * @param {QueryPlan} plan
 * @returns {QueryPlan}
 */
function searchPlan(plan) {
  if (plan.strategy !== 'multiFeedMerge') return plan;
  return {
    ...plan,
    strategy: 'globalFilter',
    indexName: plan.stateFilter === STATE.OFF ? INDEXES.ARTICLES.BY_READ_SORT.name : INDEXES.ARTICLES.BY_SORT.name,
    keyPrefix: plan.stateFilter === STATE.OFF ? [STATE.OFF] : null,
    filterFeedIds: new Set(plan.feedIds),
  };
}

/**
 * @param {IDBTransaction} transaction
 */
async function readFeedSearchText(transaction) {
  /** @type {Map<string, string>} */
  const feedTitles = new Map();
  const request = transaction.objectStore(STORES.FEEDS).openCursor();
  let cursor = await requestToPromise(request);
  while (cursor) {
    const feed = /** @type {import('./models.js').FeedRecord} */ (cursor.value);
    if (feed.deletionState === DELETION_STATE.ACTIVE) {
      feedTitles.set(feed.id, normalizeSearchText(feed.title));
    }
    cursor.continue();
    cursor = await requestToPromise(request);
  }
  return feedTitles;
}

/**
 * @param {IDBTransaction} transaction
 * @param {QueryPlan} plan
 * @param {ArticleSearch} query
 * @param {Map<string, string>} feedTitles
 * @param {unknown[] | null} lastKey
 * @returns {Promise<SearchPage>}
 */
async function collectSearchPage(transaction, plan, query, feedTitles, lastKey) {
  if (plan.strategy === 'empty') return { items: [], hasMore: false, cursorState: null, scannedCount: 0 };
  const records = [];
  let scannedCount = 0;
  /** @type {unknown[] | null} */
  let lastScannedKey = null;
  const request = transaction
    .objectStore(STORES.ARTICLES)
    .index(plan.indexName)
    .openCursor(cursorRange(plan.keyPrefix, lastKey), 'prev');
  let cursor = await requestToPromise(request);
  while (cursor && records.length < query.pageSize && scannedCount < SEARCH_SCAN_LIMIT) {
    const key = /** @type {unknown[]} */ (cursor.key);
    if (isCursorCandidate(cursor.value, key, plan, lastKey)) {
      scannedCount += 1;
      lastScannedKey = key;
      if (matchesSearch(cursor.value, query.query, feedTitles)) records.push(cursor.value);
    }
    cursor.continue();
    cursor = await requestToPromise(request);
  }
  const hasMore = Boolean(cursor);
  return {
    items: records,
    hasMore,
    cursorState: hasMore && lastScannedKey ? { lastKey: lastScannedKey } : null,
    scannedCount,
  };
}

/**
 * @param {import('./models.js').ArticleRecord} article
 * @param {string} query
 * @param {Map<string, string>} feedTitles
 */
function matchesSearch(article, query, feedTitles) {
  const articleText = typeof article.searchText === 'string' ? searchableArticleText(article.searchText) : '';
  if (articleText.includes(query)) return true;
  return (feedTitles.get(article.feedId) ?? '').includes(query);
}

/**
 * @param {string} value
 */
function searchableArticleText(value) {
  return normalizeSearchText(value).replace(LEGACY_SEARCH_TEXT_PREFIX, '');
}

/**
 * @param {unknown[] | null} prefix
 * @param {unknown[] | null} lastKey
 */
function cursorRange(prefix, lastKey) {
  if (!('IDBKeyRange' in globalThis)) return null;
  if (prefix) {
    const lower = [...prefix, 0, ''].slice(0, prefix.length + 2);
    const upper = lastKey ?? [...prefix, Number.MAX_SAFE_INTEGER, HIGH_STRING].slice(0, prefix.length + 2);
    return IDBKeyRange.bound(lower, upper, false, Boolean(lastKey));
  }
  return lastKey ? IDBKeyRange.upperBound(lastKey, true) : null;
}

/**
 * @param {import('./models.js').ArticleRecord} article
 * @param {unknown[]} key
 * @param {QueryPlan} plan
 * @param {unknown[] | null} lastKey
 */
function isCursorCandidate(article, key, plan, lastKey) {
  if (!Array.isArray(key)) return false;
  if (lastKey && compareKey(key, lastKey) >= 0) return false;
  if (plan.keyPrefix && !matchesPrefix(key, plan.keyPrefix)) return false;
  if (plan.filterFeedIds && !plan.filterFeedIds.has(article.feedId)) return false;
  if (plan.stateFilter === STATE.OFF && article.readState !== STATE.OFF) return false;
  return true;
}

/**
 * @param {unknown[]} key
 * @param {unknown[]} prefix
 */
function matchesPrefix(key, prefix) {
  return prefix.every((part, index) => key[index] === part);
}

/**
 * @param {QueryPlan} plan
 * @param {string} queryHash
 * @param {number} dataRevision
 * @param {{lastKey: unknown[]}} cursorState
 */
function encodeNextCursor(plan, queryHash, dataRevision, cursorState) {
  return encodeCursor({
    v: 1,
    queryHash,
    dataRevision,
    index: plan.indexName,
    direction: 'prev',
    lastKey: cursorState.lastKey,
    strategy: plan.strategy,
  });
}

/**
 * @param {unknown} value
 */
function normalizeSearchQuery(value) {
  if (typeof value !== 'string') throw validationError('query', 'Search query must be a string');
  const query = normalizeSearchText(value);
  const length = [...query].length;
  if (length < 2) throw validationError('query', 'Search query must contain at least two characters');
  if (length > MAX_SEARCH_QUERY_CODE_POINTS) throw validationError('query', 'Search query is too long');
  return query;
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
 */
function validationError(field, reason) {
  return createAppError(ERROR_CODES.VALIDATION_ERROR, { details: { field, reason }, message: reason });
}
