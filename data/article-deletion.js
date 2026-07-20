// @ts-check

import { createAppError, ERROR_CODES } from '../domain/errors.js';
import { DELETION_STATE, STORES } from './constants.js';
import { feedStatsId, requireFeed } from './feed-repository.js';
import { articleStatsDelta, applyStatsDeltas } from './article-stats.js';
import { normalizeStatsRecord } from './models.js';
import { requestToPromise, runMutation } from './transaction.js';

/**
 * @typedef {import('./transaction.js').TransactionOptions} RepositoryOptions
 */

/**
 * @param {unknown} selection
 * @param {RepositoryOptions} options
 */
export async function deleteArticleChunk(selection, options) {
  const input = normalizeDeleteSelection(selection);
  return runMutation(
    [STORES.FEEDS, STORES.ARTICLES, STORES.ARTICLE_IDENTITIES, STORES.ARTICLE_BODIES, STORES.STATS],
    async (context) => {
      const stores = deletionStores(context.transaction);
      const feed = await requestToPromise(stores.feeds.get(input.feedId));
      if (!feed) return { deletedCount: 0, completed: true };
      if (feed.deletionState !== DELETION_STATE.PENDING) throw validationError('feedId', 'feed is not delete-pending');
      const articles = await collectFeedArticles(stores.articles, input.feedId, input.batchSize);
      if (articles.length === 0) return finalizeFeedDeletion(stores, input.feedId, context);
      /** @type {Record<string, import('./article-stats.js').StatsDelta>} */
      const deltas = {};
      for (const article of articles) {
        await deleteArticleRecords(stores, article);
        addDelta(deltas, article.feedId, articleStatsDelta(article, -1));
      }
      await applyStatsDeltas(stores.stats, deltas, context.now());
      await context.markChanged({
        entities: ['articles', 'articleIdentities', 'articleBodies', 'stats'],
        feedIds: [input.feedId],
        scopes: ['system:all', 'system:unread', `feed:${input.feedId}`],
        reason: 'feed-delete-chunk',
      });
      return { deletedCount: articles.length, completed: false };
    },
    { ...options, durability: 'relaxed' },
  );
}

/**
 * @param {unknown} selection
 * @param {RepositoryOptions} options
 */
export async function purgeArticleChunk(selection, options) {
  const input = normalizePurgeSelection(selection);
  return runMutation(
    [STORES.FEEDS, STORES.ARTICLES, STORES.ARTICLE_IDENTITIES, STORES.ARTICLE_BODIES, STORES.STATS],
    async (context) => {
      const stores = deletionStores(context.transaction);
      const plan = await collectPurgeArticles(stores.articles, input, context.now());
      if (plan.articles.length === 0) {
        return { completed: true, deletedCount: 0, protectedCount: plan.protectedCount };
      }
      /** @type {Record<string, import('./article-stats.js').StatsDelta>} */
      const deltas = {};
      for (const article of plan.articles) {
        await deleteArticleRecords(stores, article);
        addDelta(deltas, article.feedId, articleStatsDelta(article, -1));
      }
      await applyStatsDeltas(stores.stats, deltas, context.now());
      await normalizeGlobalStatsAfterDeletion(stores.stats, context.now());
      await context.markChanged({
        entities: ['articles', 'articleIdentities', 'articleBodies', 'stats'],
        feedIds: Object.keys(deltas),
        scopes: ['system:all', 'system:unread', 'system:starred', ...Object.keys(deltas).map((feedId) => `feed:${feedId}`)],
        reason: 'articles-purge',
      });
      return {
        completed: plan.completed,
        deletedCount: plan.articles.length,
        protectedCount: plan.protectedCount,
      };
    },
    { ...options, durability: 'relaxed' },
  );
}

/**
 * @param {ReturnType<typeof deletionStores>} stores
 * @param {string} feedId
 * @param {import('./transaction.js').MutationContext} context
 */
async function finalizeFeedDeletion(stores, feedId, context) {
  const feed = await requireFeed(stores.feeds, feedId);
  await requestToPromise(stores.stats.delete(feedStatsId(feedId)));
  await requestToPromise(stores.feeds.delete(feedId));
  await normalizeGlobalStatsAfterDeletion(stores.stats, context.now());
  await context.markChanged({
    entities: ['feeds', 'stats'],
    feedIds: [feedId],
    categoryIds: [feed.categoryId],
    reason: 'feed-delete-finalize',
  });
  return { deletedCount: 0, completed: true };
}

/**
 * @param {ReturnType<typeof deletionStores>} stores
 * @param {import('./models.js').ArticleRecord} article
 */
async function deleteArticleRecords(stores, article) {
  await deleteIdentitiesByArticle(stores.identities, article.id);
  await requestToPromise(stores.bodies.delete(article.id));
  await requestToPromise(stores.articles.delete(article.id));
}

/**
 * @param {IDBObjectStore} articles
 * @param {string} feedId
 * @param {number} batchSize
 */
async function collectFeedArticles(articles, feedId, batchSize) {
  const range =
    'IDBKeyRange' in globalThis
      ? IDBKeyRange.bound([feedId, 0, ''], [feedId, Number.MAX_SAFE_INTEGER, '\uffff'])
      : null;
  const request = articles.index('byFeedSort').openCursor(range);
  const records = [];
  let cursor = await requestToPromise(request);
  while (cursor && records.length < batchSize) {
    if (range || cursor.value.feedId === feedId) records.push(cursor.value);
    cursor.continue();
    cursor = await requestToPromise(request);
  }
  return records;
}

/**
 * @param {IDBObjectStore} identities
 * @param {string} articleId
 */
async function deleteIdentitiesByArticle(identities, articleId) {
  const range = 'IDBKeyRange' in globalThis ? IDBKeyRange.bound([articleId], [articleId, '\uffff']) : null;
  const request = identities.index('byArticle').openCursor(range);
  let cursor = await requestToPromise(request);
  while (cursor) {
    if (range || cursor.value.articleId === articleId) await requestToPromise(identities.delete(cursor.value.key));
    cursor.continue();
    cursor = await requestToPromise(request);
  }
}

/**
 * @param {IDBObjectStore} stats
 * @param {number} now
 */
async function normalizeGlobalStatsAfterDeletion(stats, now) {
  const count = await requestToPromise(stats.get('global'));
  if (!count || count.articleCount !== 0) return;
  await requestToPromise(
    stats.put(
      normalizeStatsRecord({ ...count, unreadCount: 0, starredCount: 0, lastArticleAtMs: 0, updatedAtMs: now }),
    ),
  );
}

/**
 * @param {IDBTransaction} transaction
 */
function deletionStores(transaction) {
  return {
    feeds: transaction.objectStore(STORES.FEEDS),
    articles: transaction.objectStore(STORES.ARTICLES),
    identities: transaction.objectStore(STORES.ARTICLE_IDENTITIES),
    bodies: transaction.objectStore(STORES.ARTICLE_BODIES),
    stats: transaction.objectStore(STORES.STATS),
  };
}

/**
 * @param {IDBObjectStore} articles
 * @param {ReturnType<typeof normalizePurgeSelection>} input
 * @param {number} now
 */
async function collectPurgeArticles(articles, input, now) {
  const count = await requestToPromise(articles.count());
  const overLimit = Math.max(0, count - input.maxArticles);
  const cutoff = now - input.maxAgeDays * 24 * 60 * 60 * 1000;
  const keepReadFeeds = new Set(input.keepReadFeedIds);
  const request = articles.index('byFetchedAt').openCursor();
  /** @type {import('./models.js').ArticleRecord[]} */
  const selected = [];
  let protectedCount = 0;
  let countDeletes = 0;
  let cursor = await requestToPromise(request);
  while (cursor && selected.length < input.batchSize) {
    const article = /** @type {import('./models.js').ArticleRecord} */ (cursor.value);
    const protectedBySettings =
      (input.keepUnread && article.readState === 0) ||
      (input.keepStarred && article.starredState === 1) ||
      (keepReadFeeds.has(article.feedId) && article.readState === 1);
    const countCandidate = countDeletes < overLimit;
    const ageCandidate = article.fetchedAtMs <= cutoff;
    if (protectedBySettings && (countCandidate || ageCandidate)) {
      protectedCount += 1;
    } else if (ageCandidate || countCandidate) {
      selected.push(article);
      if (countCandidate) countDeletes += 1;
    }
    cursor.continue();
    cursor = await requestToPromise(request);
  }
  return { articles: selected, completed: cursor === null, protectedCount };
}

/**
 * @param {unknown} input
 */
function normalizeDeleteSelection(input) {
  if (!input || typeof input !== 'object') throw validationError('selection', 'must be an object');
  const record = /** @type {Record<string, unknown>} */ (input);
  if (record.type !== 'feed' || typeof record.feedId !== 'string')
    throw validationError('selection', 'must target a feed');
  const batchSize = record.batchSize === undefined ? 250 : record.batchSize;
  if (!Number.isSafeInteger(batchSize) || Number(batchSize) < 1 || Number(batchSize) > 250) {
    throw validationError('batchSize', 'must be an integer from 1 to 250');
  }
  return { feedId: record.feedId, batchSize: Number(batchSize) };
}

/**
 * @param {unknown} input
 */
function normalizePurgeSelection(input) {
  if (!input || typeof input !== 'object') throw validationError('selection', 'must be an object');
  const record = /** @type {Record<string, unknown>} */ (input);
  return {
    batchSize: numberInRange(record.batchSize, 'batchSize', 1, 250, 250),
    keepStarred: booleanField(record.keepStarred, 'keepStarred'),
    keepUnread: booleanField(record.keepUnread, 'keepUnread'),
    keepReadFeedIds: normalizeFeedIdList(record.keepReadFeedIds),
    maxAgeDays: numberInRange(record.maxAgeDays, 'maxAgeDays', 7, 3650, 90),
    maxArticles: numberInRange(record.maxArticles, 'maxArticles', 1000, 100000, 10000),
  };
}

/**
 * Feed ids whose read articles are protected from both purge modes (keepReadOnPurge), snapshotted by
 * the maintenance service at purge start.
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeFeedIdList(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw validationError('keepReadFeedIds', 'must be an array');
  return value.filter((item) => typeof item === 'string');
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 */
function numberInRange(value, field, min, max, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw validationError(field, `must be an integer from ${min} to ${max}`);
  }
  return Number(value);
}

/**
 * @param {unknown} value
 * @param {string} field
 */
function booleanField(value, field) {
  if (typeof value === 'boolean') return value;
  throw validationError(field, 'must be boolean');
}

/**
 * @param {Record<string, import('./article-stats.js').StatsDelta>} deltas
 * @param {string} feedId
 * @param {import('./article-stats.js').StatsDelta} delta
 */
function addDelta(deltas, feedId, delta) {
  const current = deltas[feedId] ?? {};
  deltas[feedId] = {
    articleCount: (current.articleCount ?? 0) + (delta.articleCount ?? 0),
    unreadCount: (current.unreadCount ?? 0) + (delta.unreadCount ?? 0),
    starredCount: (current.starredCount ?? 0) + (delta.starredCount ?? 0),
  };
}

/**
 * @param {string} field
 * @param {string} reason
 */
function validationError(field, reason) {
  return createAppError(ERROR_CODES.VALIDATION_ERROR, { details: { field, reason } });
}
