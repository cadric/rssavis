// @ts-check

import { createAppError, ERROR_CODES } from '../domain/errors.js';
import { STATE, STORES } from './constants.js';
import { feedStatsId } from './feed-repository.js';
import { normalizeStatsRecord } from './models.js';
import { createStatsRebuildRepository } from './stats-rebuild-repository.js';
import { requestToPromise, runMutation, runTransaction } from './transaction.js';

const GLOBAL_STATS_ID = 'global';

/**
 * @typedef {import('./transaction.js').TransactionOptions} RepositoryOptions
 * @typedef {{articleCount?: number, unreadCount?: number, starredCount?: number, lastArticleAtMs?: number}} StatsDelta
 */

/**
 * @param {RepositoryOptions} options
 */
export function createStatsRepository(options = {}) {
  const rebuild = createStatsRebuildRepository(options);
  return {
    getGlobal: () => getGlobal(options),
    /**
     * @param {string[]} feedIds
     */
    getFeedStats: (feedIds) => getFeedStats(feedIds, options),
    /**
     * @param {{feeds: Record<string, StatsDelta>}} deltaMap
     */
    applyDeltas: (deltaMap) => applyDeltas(deltaMap, options),
    /**
     * @param {string} categoryId
     */
    getCategoryStats: (categoryId) => getCategoryStats(categoryId, options),
    getMainStreamStats: () => getMainStreamStats(options),
    ...rebuild,
  };
}

/**
 * @param {RepositoryOptions} options
 */
async function getGlobal(options) {
  return runTransaction(
    STORES.STATS,
    'readonly',
    async (transaction) => {
      return detach(await requestToPromise(transaction.objectStore(STORES.STATS).get(GLOBAL_STATS_ID)));
    },
    options,
  );
}

/**
 * @param {string[]} feedIds
 * @param {RepositoryOptions} options
 */
async function getFeedStats(feedIds, options) {
  return runTransaction(
    STORES.STATS,
    'readonly',
    async (transaction) => {
      /** @type {Record<string, import('./models.js').StatsRecord | null>} */
      const result = {};
      const stats = transaction.objectStore(STORES.STATS);
      for (const feedId of feedIds) result[feedId] = detach(await requestToPromise(stats.get(feedStatsId(feedId))));
      return result;
    },
    options,
  );
}

/**
 * @param {{feeds: Record<string, StatsDelta>}} deltaMap
 * @param {RepositoryOptions} options
 */
async function applyDeltas(deltaMap, options) {
  return runMutation(
    [STORES.STATS],
    async (context) => {
      const stats = context.transaction.objectStore(STORES.STATS);
      const global = await readStatsOrZero(stats, GLOBAL_STATS_ID, '', 'global', context.now());
      const changedFeedIds = Object.keys(deltaMap.feeds);
      for (const feedId of changedFeedIds) {
        const current = await readStatsOrZero(stats, feedStatsId(feedId), feedId, 'feed', context.now());
        const next = applyDelta(current, deltaMap.feeds[feedId], context.now());
        await requestToPromise(stats.put(next));
        Object.assign(global, applyDelta(global, deltaMap.feeds[feedId], context.now()));
      }
      await requestToPromise(stats.put(global));
      if (changedFeedIds.length > 0) {
        await context.markChanged({
          entities: ['stats'],
          feedIds: changedFeedIds,
          scopes: ['system:all', ...changedFeedIds.map((feedId) => `feed:${feedId}`)],
          reason: 'stats-delta',
        });
      }
      return { feedIds: changedFeedIds };
    },
    options,
  );
}

/**
 * @param {string} categoryId
 * @param {RepositoryOptions} options
 */
async function getCategoryStats(categoryId, options) {
  return aggregateFeedStats(options, (feed) => feed.categoryId === categoryId);
}

/**
 * @param {RepositoryOptions} options
 */
async function getMainStreamStats(options) {
  return aggregateFeedStats(options, (feed) => feed.mainStreamState === STATE.ON);
}

/**
 * @param {RepositoryOptions} options
 * @param {(feed: import('./models.js').FeedRecord) => boolean} predicate
 */
async function aggregateFeedStats(options, predicate) {
  return runTransaction(
    [STORES.FEEDS, STORES.STATS],
    'readonly',
    async (transaction) => {
      const feeds = (await requestToPromise(transaction.objectStore(STORES.FEEDS).getAll())).filter(predicate);
      const stats = transaction.objectStore(STORES.STATS);
      const total = emptyStats('aggregate', '', 'global', 0);
      for (const feed of feeds) addStats(total, await requestToPromise(stats.get(feedStatsId(feed.id))));
      return total;
    },
    options,
  );
}

/**
 * @param {IDBObjectStore} stats
 * @param {string} id
 * @param {string} scopeId
 * @param {'global' | 'feed'} scopeType
 * @param {number} now
 */
async function readStatsOrZero(stats, id, scopeId, scopeType, now) {
  return detach(await requestToPromise(stats.get(id))) ?? emptyStats(id, scopeId, scopeType, now);
}

/**
 * @param {import('./models.js').StatsRecord} current
 * @param {StatsDelta} delta
 * @param {number} now
 */
function applyDelta(current, delta, now) {
  const next = normalizeStatsRecord({
    ...current,
    articleCount: current.articleCount + (delta.articleCount ?? 0),
    unreadCount: current.unreadCount + (delta.unreadCount ?? 0),
    starredCount: current.starredCount + (delta.starredCount ?? 0),
    lastArticleAtMs: Math.max(current.lastArticleAtMs, delta.lastArticleAtMs ?? 0),
    updatedAtMs: now,
  });
  if (next.articleCount < next.unreadCount || next.articleCount < next.starredCount) {
    throw createAppError(ERROR_CODES.VALIDATION_ERROR, {
      details: { field: 'stats', reason: 'stats counts must remain internally consistent' },
    });
  }
  return next;
}

/**
 * @param {import('./models.js').StatsRecord} target
 * @param {import('./models.js').StatsRecord | undefined} source
 */
function addStats(target, source) {
  if (!source) return;
  target.articleCount += source.articleCount;
  target.unreadCount += source.unreadCount;
  target.starredCount += source.starredCount;
  target.lastArticleAtMs = Math.max(target.lastArticleAtMs, source.lastArticleAtMs);
}

/**
 * @param {string} id
 * @param {string} scopeId
 * @param {'global' | 'feed'} scopeType
 * @param {number} now
 */
function emptyStats(id, scopeId, scopeType, now) {
  return normalizeStatsRecord({
    id,
    scopeType,
    scopeId,
    articleCount: 0,
    unreadCount: 0,
    starredCount: 0,
    lastArticleAtMs: 0,
    updatedAtMs: now,
  });
}

/**
 * @template {Record<string, unknown>} T
 * @param {T | undefined} record
 * @returns {T | null}
 */
function detach(record) {
  return record ? /** @type {T} */ ({ ...record }) : null;
}
