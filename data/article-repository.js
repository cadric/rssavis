// @ts-check

import { ERROR_CODES, createAppError } from '../domain/errors.js';
import { normalizeScope, scopeToStorageKey } from '../domain/scopes.js';
import { STATE, STORES } from './constants.js';
import { deleteArticleChunk, purgeArticleChunk } from './article-deletion.js';
import { ingestPreparedArticles } from './article-ingestion.js';
import { toArticleListItem } from './article-list-item.js';
import { searchArticles } from './article-search.js';
import { applyStatsDelta } from './article-stats.js';
import { feedStatsId } from './feed-repository.js';
import { readDataRevision } from './meta-repository.js';
import { normalizeArticleRecord, normalizeStatsRecord } from './models.js';
import { decodeCursor, encodeCursor, queryHashFor } from './pagination.js';
import {
  collectArticlePage,
  queryDescriptor,
  normalizeArticleQuery,
  resolveArticleQueryPlan,
} from './query-planner.js';
import { requestToPromise, runMutation, runTransaction } from './transaction.js';
import { collectUnreadForScope, countUnreadForScope } from './unread-scope.js';

/**
 * @typedef {import('./transaction.js').TransactionOptions} RepositoryOptions
 * @typedef {import('./article-stats.js').StatsDelta} StatsDelta
 */

/**
 * @param {RepositoryOptions} options
 */
export function createArticleRepository(options = {}) {
  return {
    /**
     * @param {unknown} input
     */
    query: (input) => queryArticles(input, options),
    /**
     * @param {unknown} input
     */
    search: (input) => searchArticles(input, options),
    /**
     * @param {string} id
     */
    getDetail: (id) => getDetail(id, options),
    /**
     * @param {string} id
     */
    getExisting: (id) => getExisting(id, options),
    /**
     * @param {string} id
     * @param {number} state
     */
    setRead: (id, state) => setRead(id, state, options),
    /**
     * @param {string} id
     * @param {number} state
     */
    setStarred: (id, state) => setStarred(id, state, options),
    /**
     * @param {unknown} scope
     * @param {{batchSize?: number, maxChunks?: number}} [input]
     */
    markScopeRead: (scope, input = {}) => markScopeRead(scope, input, options),
    /**
     * @param {unknown} scope
     */
    countUnread: (scope) => countUnread(scope, options),
    /**
     * @param {string} feedId
     * @param {import('../background/refresh-service.js').PreparedArticle[]} preparedArticles
     * @param {import('./article-ingestion.js').IngestOptions} [input]
     */
    ingestPrepared: (feedId, preparedArticles, input = {}) =>
      ingestPreparedArticles(feedId, preparedArticles, input, options),
    /**
     * @param {unknown} selection
     */
    deleteChunk: (selection) => deleteArticleChunk(selection, options),
    /**
     * @param {unknown} selection
     */
    purgeChunk: (selection) => purgeArticleChunk(selection, options),
  };
}

/**
 * @param {unknown} input
 * @param {RepositoryOptions} options
 */
async function queryArticles(input, options) {
  const query = normalizeArticleQuery(input);
  const plan = await resolveArticleQueryPlan(query, options);
  const queryHash = await queryHashFor(queryDescriptor(plan, query));
  return runTransaction(
    [STORES.ARTICLES, STORES.META],
    'readonly',
    async (transaction) => {
      const dataRevision = await readDataRevision(transaction);
      const cursor = query.cursor ? decodeCursor(query.cursor, { queryHash, dataRevision }) : null;
      const page = await collectArticlePage(transaction, plan, query.pageSize, cursor);
      return {
        items: page.items.map(toArticleListItem),
        nextCursor:
          page.hasMore && page.cursorState ? encodeNextCursor(plan, queryHash, dataRevision, page.cursorState) : null,
        hasMore: page.hasMore,
        dataRevision,
        planner: { strategy: plan.strategy, index: plan.indexName },
      };
    },
    options,
  );
}

/**
 * @param {string} id
 * @param {RepositoryOptions} options
 */
async function getDetail(id, options) {
  return runTransaction(
    [STORES.ARTICLES, STORES.ARTICLE_BODIES, STORES.FEEDS],
    'readonly',
    async (transaction) => {
      const article = await requireArticle(transaction.objectStore(STORES.ARTICLES), id);
      const body = await requestToPromise(transaction.objectStore(STORES.ARTICLE_BODIES).get(id));
      const feed = await requestToPromise(transaction.objectStore(STORES.FEEDS).get(article.feedId));
      if (!feed) throw createAppError(ERROR_CODES.FEED_NOT_FOUND, { details: { feedId: article.feedId } });
      return {
        ...toArticleListItem(article),
        body: body
          ? {
              contentText: body.contentText,
              contentLength: body.contentLength,
              updatedAtMs: body.updatedAtMs,
              contentBlocks: body.contentBlocks ?? [],
            }
          : null,
        feedTitle: typeof feed.title === 'string' ? feed.title : '',
        feedIconUrl: feed.iconUrl ?? null,
        feedSiteUrl: typeof feed.siteUrl === 'string' ? feed.siteUrl : '',
        feedUrl: typeof feed.url === 'string' ? feed.url : '',
      };
    },
    options,
  );
}

/**
 * @param {string} id
 * @param {RepositoryOptions} options
 */
async function getExisting(id, options) {
  return runTransaction(
    STORES.ARTICLES,
    'readonly',
    async (transaction) => {
      const article = await requestToPromise(transaction.objectStore(STORES.ARTICLES).get(id));
      return article ? { ...article } : null;
    },
    options,
  );
}

/**
 * @param {string} id
 * @param {number} state
 * @param {RepositoryOptions} options
 */
async function setRead(id, state, options) {
  return setArticleState(id, 'readState', state, options);
}

/**
 * @param {string} id
 * @param {number} state
 * @param {RepositoryOptions} options
 */
async function setStarred(id, state, options) {
  return setArticleState(id, 'starredState', state, options);
}

/**
 * @param {string} id
 * @param {'readState' | 'starredState'} field
 * @param {number} state
 * @param {RepositoryOptions} options
 */
async function setArticleState(id, field, state, options) {
  validateState(state, field);
  return runMutation(
    [STORES.ARTICLES, STORES.STATS],
    async (context) => {
      const articles = context.transaction.objectStore(STORES.ARTICLES);
      const stats = context.transaction.objectStore(STORES.STATS);
      const existing = await requireArticle(articles, id);
      if (existing[field] === state) return { article: toArticleListItem(existing) };
      const next = normalizeArticleRecord({ ...existing, [field]: state, changedAtMs: context.now() });
      const delta = stateDelta(existing, next, field);
      await requestToPromise(articles.put(next));
      await applyStatsDelta(stats, existing.feedId, delta, context.now());
      await context.markChanged({
        articleIds: [id],
        entities: ['articles', 'stats'],
        feedIds: [existing.feedId],
        scopes: changedScopes(existing.feedId, field),
        reason: field === 'readState' ? 'article-read-state' : 'article-starred-state',
      });
      return { article: toArticleListItem(next) };
    },
    options,
  );
}

/**
 * @param {unknown} scopeInput
 * @param {{batchSize?: number, maxChunks?: number}} input
 * @param {RepositoryOptions} options
 */
async function markScopeRead(scopeInput, input, options) {
  const scope = normalizeScope(scopeInput);
  const batchSize = normalizeBatchSize(input.batchSize);
  const maxChunks = normalizeMaxChunks(input.maxChunks);
  let affectedCount = 0;
  let chunks = 0;
  let dataRevision = 0;
  let changed = false;
  let change = null;
  while (chunks < maxChunks) {
    const result = await markScopeReadChunk(scope, batchSize, options);
    dataRevision = result.dataRevision;
    if (!result.changed || result.affectedCount === 0) break;
    affectedCount += result.affectedCount;
    chunks += 1;
    changed = true;
    change = result.change;
  }
  return { affectedCount, chunks, changed, dataRevision, change };
}

/**
 * @param {unknown} scopeInput
 * @param {RepositoryOptions} options
 */
async function countUnread(scopeInput, options) {
  const scope = normalizeScope(scopeInput);
  const unreadCount = await runTransaction(
    [STORES.CATEGORIES, STORES.FEEDS, STORES.ARTICLES],
    'readonly',
    async (transaction) => countUnreadForScope(transaction, scope),
    options,
  );
  return { unreadCount };
}

/**
 * @param {import('../domain/scopes.js').Scope} scope
 * @param {number} batchSize
 * @param {RepositoryOptions} options
 */
async function markScopeReadChunk(scope, batchSize, options) {
  return runMutation(
    [STORES.CATEGORIES, STORES.FEEDS, STORES.ARTICLES, STORES.STATS],
    async (context) => {
      const articles = await collectUnreadForScope(context.transaction, scope, batchSize);
      if (articles.length === 0) return { affectedCount: 0 };
      const articleStore = context.transaction.objectStore(STORES.ARTICLES);
      const stats = context.transaction.objectStore(STORES.STATS);
      /** @type {Record<string, StatsDelta>} */
      const deltas = {};
      for (const article of articles) {
        const next = normalizeArticleRecord({ ...article, readState: STATE.ON, changedAtMs: context.now() });
        await requestToPromise(articleStore.put(next));
        deltas[article.feedId] = {
          unreadCount: (deltas[article.feedId]?.unreadCount ?? 0) - 1,
        };
      }
      for (const [feedId, delta] of Object.entries(deltas)) await applyStatsDelta(stats, feedId, delta, context.now());
      const feedIds = Object.keys(deltas);
      await context.markChanged({
        entities: ['articles', 'stats'],
        feedIds,
        scopes: ['system:unread', scopeToStorageKey(scope), ...feedIds.map((feedId) => `feed:${feedId}`)],
        reason: 'articles-mark-scope-read',
      });
      return { affectedCount: articles.length };
    },
    options,
  );
}

/**
 * @param {import('./query-planner.js').QueryPlan} plan
 * @param {string} queryHash
 * @param {number} dataRevision
 * @param {{lastKey?: unknown[], feedCursors?: Record<string, unknown[]>}} cursorState
 */
function encodeNextCursor(plan, queryHash, dataRevision, cursorState) {
  return encodeCursor({
    v: 1,
    queryHash,
    dataRevision,
    index: plan.indexName,
    direction: 'prev',
    ...(cursorState.lastKey ? { lastKey: cursorState.lastKey } : {}),
    ...(cursorState.feedCursors ? { feedCursors: cursorState.feedCursors } : {}),
    strategy: plan.strategy,
  });
}

/**
 * @param {IDBObjectStore} articles
 * @param {string} id
 * @returns {Promise<import('./models.js').ArticleRecord>}
 */
async function requireArticle(articles, id) {
  const article = await requestToPromise(articles.get(id));
  if (!article) throw createAppError(ERROR_CODES.ARTICLE_NOT_FOUND, { details: { articleId: id } });
  return article;
}

/**
 * @param {import('./models.js').ArticleRecord} before
 * @param {import('./models.js').ArticleRecord} after
 * @param {'readState' | 'starredState'} field
 * @returns {StatsDelta}
 */
function stateDelta(before, after, field) {
  if (field === 'readState') {
    return { unreadCount: before.readState === STATE.OFF && after.readState === STATE.ON ? -1 : 1 };
  }
  return { starredCount: before.starredState === STATE.OFF && after.starredState === STATE.ON ? 1 : -1 };
}

/**
 * @param {number} state
 * @param {string} field
 */
function validateState(state, field) {
  if (state !== STATE.OFF && state !== STATE.ON) {
    throw createAppError(ERROR_CODES.VALIDATION_ERROR, { details: { field, reason: 'must be a state enum value' } });
  }
}

/**
 * @param {number | undefined} batchSize
 */
function normalizeBatchSize(batchSize) {
  if (batchSize === undefined) return 250;
  if (typeof batchSize !== 'number' || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 250) {
    throw createAppError(ERROR_CODES.VALIDATION_ERROR, {
      details: { field: 'batchSize', reason: 'must be an integer from 1 to 250' },
    });
  }
  return batchSize;
}

/**
 * @param {number | undefined} maxChunks
 */
function normalizeMaxChunks(maxChunks) {
  if (maxChunks === undefined) return Number.MAX_SAFE_INTEGER;
  if (typeof maxChunks !== 'number' || !Number.isSafeInteger(maxChunks) || maxChunks < 1 || maxChunks > 1000) {
    throw createAppError(ERROR_CODES.VALIDATION_ERROR, {
      details: { field: 'maxChunks', reason: 'must be an integer from 1 to 1000' },
    });
  }
  return maxChunks;
}

/**
 * @param {string} feedId
 * @param {'readState' | 'starredState'} field
 */
function changedScopes(feedId, field) {
  return field === 'readState' ? ['system:unread', `feed:${feedId}`] : ['system:starred', `feed:${feedId}`];
}
