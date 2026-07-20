// @ts-check

import { normalizeScope, scopeToStorageKey } from '../domain/scopes.js';
import { createAppError, ERROR_CODES } from '../domain/errors.js';
import { DELETION_STATE, INDEXES, STATE, STORES } from './constants.js';
import { normalizePageSize } from './pagination.js';
import { requestToPromise, runTransaction } from './transaction.js';

const MULTI_FEED_LIMIT = 8;
const HIGH_STRING = '\uffff';

/**
 * @typedef {import('../domain/scopes.js').Scope} Scope
 * @typedef {{scope: Scope, pageSize: number, cursor: unknown, filter: number | null}} ArticleQuery
 * @typedef {{strategy: 'empty' | 'globalIndex' | 'singleFeed' | 'multiFeedMerge' | 'globalFilter', scope: Scope, indexName: string, keyPrefix: unknown[] | null, feedIds: string[], filterFeedIds: Set<string> | null, stateFilter: number | null}} QueryPlan
 * @typedef {{items: import('./models.js').ArticleRecord[], hasMore: boolean, cursorState: {lastKey?: unknown[], feedCursors?: Record<string, unknown[]>} | null}} PageResult
 */

/**
 * @param {unknown} input
 * @returns {ArticleQuery}
 */
export function normalizeArticleQuery(input) {
  if (!isRecord(input)) throw validationError('query', 'must be a plain object');
  const allowed = new Set(['scope', 'cursor', 'pageSize', 'filter']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw validationError(key, `unknown field: ${key}`);
  return {
    scope: normalizeScope(input.scope),
    pageSize: normalizePageSize(input.pageSize, 100, 250),
    cursor: input.cursor ?? null,
    filter: normalizeArticleFilter(input.filter),
  };
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function normalizeArticleFilter(value) {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw validationError('filter', 'must be a plain object');
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'read') throw validationError('filter', 'only read is allowed');
  if (value.read === 'unread') return STATE.OFF;
  if (value.read === 'read') return STATE.ON;
  throw validationError('filter.read', 'must be unread or read');
}

/**
 * @param {ArticleQuery} query
 * @param {import('./transaction.js').TransactionOptions} options
 */
export async function resolveArticleQueryPlan(query, options = {}) {
  return runTransaction(
    [STORES.CATEGORIES, STORES.FEEDS],
    'readonly',
    async (transaction) => resolvePlanInTransaction(transaction, query.scope, query.filter),
    options,
  );
}

/**
 * @param {IDBTransaction} transaction
 * @param {Scope} scope
 * @param {number | null} stateFilter
 * @returns {Promise<QueryPlan>}
 */
export async function resolvePlanInTransaction(transaction, scope, stateFilter) {
  if (scope.type === 'system') return resolveSystemPlan(scope, stateFilter, transaction);
  if (scope.type === 'feed') return resolveFeedPlan(scope, stateFilter, transaction);
  return resolveCategoryPlan(scope, stateFilter, transaction);
}

/**
 * @param {QueryPlan} plan
 * @param {ArticleQuery} query
 */
export function queryDescriptor(plan, query) {
  return {
    scope: scopeToStorageKey(query.scope),
    pageSize: query.pageSize,
    strategy: plan.strategy,
    index: plan.indexName,
    feedIds: plan.feedIds,
    stateFilter: plan.stateFilter,
  };
}

/**
 * @param {IDBTransaction} transaction
 * @param {QueryPlan} plan
 * @param {number} pageSize
 * @param {import('./pagination.js').CursorPayload | null} cursor
 * @returns {Promise<PageResult>}
 */
export async function collectArticlePage(transaction, plan, pageSize, cursor) {
  if (plan.strategy === 'empty') return { items: [], hasMore: false, cursorState: null };
  if (plan.strategy === 'multiFeedMerge') return collectMergedFeedPage(transaction, plan, pageSize, cursor);
  return collectIndexPage(transaction, plan, pageSize, cursor?.lastKey ?? null);
}

/**
 * @param {Scope} scope
 * @param {number | null} stateFilter
 * @param {IDBTransaction} transaction
 * @returns {Promise<QueryPlan>}
 */
async function resolveSystemPlan(scope, stateFilter, transaction) {
  if (scope.id === 'main') {
    const feedIds = await readActiveFeedIds(transaction, (feed) => feed.mainStreamState === STATE.ON);
    return planForFeedSet(scope, feedIds, stateFilter);
  }
  if (scope.id === 'unread') {
    if (stateFilter === STATE.ON) return emptyPlan(scope, STATE.ON);
    return globalPlan(scope, INDEXES.ARTICLES.BY_READ_SORT.name, [STATE.OFF], STATE.OFF);
  }
  if (scope.id === 'starred') return globalPlan(scope, INDEXES.ARTICLES.BY_STAR_SORT.name, [STATE.ON], stateFilter);
  if (stateFilter !== null)
    return globalPlan(scope, INDEXES.ARTICLES.BY_READ_SORT.name, [stateFilter], stateFilter);
  return globalPlan(scope, INDEXES.ARTICLES.BY_SORT.name, null, stateFilter);
}

/**
 * @param {Scope} scope
 * @param {number | null} stateFilter
 * @param {IDBTransaction} transaction
 * @returns {Promise<QueryPlan>}
 */
async function resolveFeedPlan(scope, stateFilter, transaction) {
  const feed = await requestToPromise(transaction.objectStore(STORES.FEEDS).get(scope.id));
  if (!feed || feed.deletionState !== DELETION_STATE.ACTIVE) {
    throw createAppError(ERROR_CODES.FEED_NOT_FOUND, { details: { feedId: scope.id } });
  }
  return singleFeedPlan(scope, scope.id, stateFilter);
}

/**
 * @param {Scope} scope
 * @param {number | null} stateFilter
 * @param {IDBTransaction} transaction
 * @returns {Promise<QueryPlan>}
 */
async function resolveCategoryPlan(scope, stateFilter, transaction) {
  const category = await requestToPromise(transaction.objectStore(STORES.CATEGORIES).get(scope.id));
  if (!category) throw createAppError(ERROR_CODES.CATEGORY_NOT_FOUND, { details: { categoryId: scope.id } });
  const feedIds = await readActiveFeedIds(transaction, (feed) => feed.categoryId === scope.id);
  return planForFeedSet(scope, feedIds, stateFilter);
}

/**
 * @param {IDBTransaction} transaction
 * @param {(feed: import('./models.js').FeedRecord) => boolean} predicate
 */
async function readActiveFeedIds(transaction, predicate) {
  const feeds = await requestToPromise(transaction.objectStore(STORES.FEEDS).getAll());
  return feeds.filter((feed) => feed.deletionState === DELETION_STATE.ACTIVE && predicate(feed)).map((feed) => feed.id);
}

/**
 * @param {Scope} scope
 * @param {string[]} feedIds
 * @param {number | null} stateFilter
 * @returns {QueryPlan}
 */
function planForFeedSet(scope, feedIds, stateFilter) {
  if (feedIds.length === 0) return emptyPlan(scope, stateFilter);
  if (feedIds.length === 1) return singleFeedPlan(scope, feedIds[0], stateFilter);
  if (feedIds.length <= MULTI_FEED_LIMIT) {
    return {
      strategy: 'multiFeedMerge',
      scope,
      indexName:
        stateFilter !== null ? INDEXES.ARTICLES.BY_FEED_READ_SORT.name : INDEXES.ARTICLES.BY_FEED_SORT.name,
      keyPrefix: null,
      feedIds,
      filterFeedIds: null,
      stateFilter,
    };
  }
  return {
    strategy: 'globalFilter',
    scope,
    indexName: stateFilter !== null ? INDEXES.ARTICLES.BY_READ_SORT.name : INDEXES.ARTICLES.BY_SORT.name,
    keyPrefix: stateFilter !== null ? [stateFilter] : null,
    feedIds,
    filterFeedIds: new Set(feedIds),
    stateFilter,
  };
}

/**
 * @param {Scope} scope
 * @param {string} indexName
 * @param {unknown[] | null} keyPrefix
 * @param {number | null} stateFilter
 * @returns {QueryPlan}
 */
function globalPlan(scope, indexName, keyPrefix, stateFilter) {
  return { strategy: 'globalIndex', scope, indexName, keyPrefix, feedIds: [], filterFeedIds: null, stateFilter };
}

/**
 * @param {Scope} scope
 * @param {string} feedId
 * @param {number | null} stateFilter
 * @returns {QueryPlan}
 */
function singleFeedPlan(scope, feedId, stateFilter) {
  return {
    strategy: 'singleFeed',
    scope,
    indexName: stateFilter !== null ? INDEXES.ARTICLES.BY_FEED_READ_SORT.name : INDEXES.ARTICLES.BY_FEED_SORT.name,
    keyPrefix: stateFilter !== null ? [feedId, stateFilter] : [feedId],
    feedIds: [feedId],
    filterFeedIds: null,
    stateFilter,
  };
}

/**
 * @param {Scope} scope
 * @param {number | null} stateFilter
 * @returns {QueryPlan}
 */
function emptyPlan(scope, stateFilter) {
  return {
    strategy: 'empty',
    scope,
    indexName: INDEXES.ARTICLES.BY_SORT.name,
    keyPrefix: null,
    feedIds: [],
    filterFeedIds: null,
    stateFilter,
  };
}

/**
 * @param {IDBTransaction} transaction
 * @param {QueryPlan} plan
 * @param {number} pageSize
 * @param {unknown[] | null} lastKey
 * @returns {Promise<PageResult>}
 */
async function collectIndexPage(transaction, plan, pageSize, lastKey) {
  const records = [];
  const request = transaction
    .objectStore(STORES.ARTICLES)
    .index(plan.indexName)
    .openCursor(cursorRange(plan.keyPrefix, lastKey), 'prev');
  let cursor = await requestToPromise(request);
  while (cursor && records.length <= pageSize) {
    if (isCursorCandidate(cursor.value, cursor.key, plan, lastKey)) {
      records.push({ article: cursor.value, key: /** @type {unknown[]} */ (cursor.key) });
    }
    if (records.length <= pageSize) {
      cursor.continue();
      cursor = await requestToPromise(request);
    }
  }
  const selected = records.slice(0, pageSize);
  const lastSelected = selected.at(-1);
  return {
    items: selected.map((record) => record.article),
    hasMore: records.length > pageSize,
    cursorState: records.length > pageSize && lastSelected ? { lastKey: lastSelected.key } : null,
  };
}

/**
 * @param {IDBTransaction} transaction
 * @param {QueryPlan} plan
 * @param {number} pageSize
 * @param {import('./pagination.js').CursorPayload | null} cursor
 * @returns {Promise<PageResult>}
 */
async function collectMergedFeedPage(transaction, plan, pageSize, cursor) {
  const perFeed = [];
  let childHasMore = false;
  for (const feedId of plan.feedIds) {
    const keyPrefix = plan.stateFilter !== null ? [feedId, plan.stateFilter] : [feedId];
    const feedPlan = /** @type {QueryPlan} */ ({ ...plan, strategy: 'singleFeed', keyPrefix, filterFeedIds: null });
    const lastKey = cursor?.feedCursors?.[feedId] ?? null;
    const page = await collectIndexPage(transaction, feedPlan, pageSize, lastKey);
    childHasMore ||= page.hasMore;
    perFeed.push(...page.items.map((article) => ({ article, feedId, key: articleKeyForPlan(article, feedPlan) })));
  }
  perFeed.sort((left, right) => compareKey(right.key, left.key));
  const selected = perFeed.slice(0, pageSize);
  const hasMore = childHasMore || perFeed.length > pageSize;
  /** @type {Record<string, unknown[]>} */
  const feedCursors = { ...(cursor?.feedCursors ?? {}) };
  for (const item of selected) feedCursors[item.feedId] = item.key;
  return {
    items: selected.map((item) => item.article),
    hasMore,
    cursorState: hasMore ? { feedCursors } : null,
  };
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
 * @param {IDBValidKey} key
 * @param {QueryPlan} plan
 * @param {unknown[] | null} lastKey
 */
function isCursorCandidate(article, key, plan, lastKey) {
  if (!Array.isArray(key)) return false;
  if (lastKey && compareKey(key, lastKey) >= 0) return false;
  if (plan.keyPrefix && !matchesPrefix(key, plan.keyPrefix)) return false;
  if (plan.filterFeedIds && !plan.filterFeedIds.has(article.feedId)) return false;
  if (plan.stateFilter !== null && article.readState !== plan.stateFilter) return false;
  return true;
}

/**
 * @param {import('./models.js').ArticleRecord} article
 * @param {QueryPlan} plan
 */
function articleKeyForPlan(article, plan) {
  if (plan.indexName === INDEXES.ARTICLES.BY_FEED_READ_SORT.name)
    return [article.feedId, article.readState, article.sortAtMs, article.id];
  if (plan.indexName === INDEXES.ARTICLES.BY_FEED_SORT.name) return [article.feedId, article.sortAtMs, article.id];
  if (plan.indexName === INDEXES.ARTICLES.BY_READ_SORT.name) return [article.readState, article.sortAtMs, article.id];
  if (plan.indexName === INDEXES.ARTICLES.BY_STAR_SORT.name)
    return [article.starredState, article.sortAtMs, article.id];
  return [article.sortAtMs, article.id];
}

/**
 * @param {unknown[]} key
 * @param {unknown[]} prefix
 */
function matchesPrefix(key, prefix) {
  return prefix.every((part, index) => key[index] === part);
}

/**
 * @param {unknown[]} left
 * @param {unknown[]} right
 */
export function compareKey(left, right) {
  for (const [index, leftPart] of left.entries()) {
    const rightPart = right[index];
    if (typeof leftPart === 'number' && typeof rightPart === 'number') {
      if (leftPart !== rightPart) return leftPart - rightPart;
    } else if (typeof leftPart === 'string' && typeof rightPart === 'string') {
      if (leftPart < rightPart) return -1;
      if (leftPart > rightPart) return 1;
    }
  }
  return left.length - right.length;
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
  return createAppError(ERROR_CODES.VALIDATION_ERROR, { details: { field, reason } });
}
