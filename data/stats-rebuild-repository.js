// @ts-check

import { STATE, STORES } from './constants.js';
import { feedStatsId, zeroFeedStats } from './feed-repository.js';
import { META_KEYS, readMetaValue, writeMetaValue } from './meta-repository.js';
import { normalizeStatsRecord } from './models.js';
import { requestToPromise, runMutation, runTransaction } from './transaction.js';

const GLOBAL_STATS_ID = 'global';
const REBUILD_ID = 'statsRebuild';

/**
 * @typedef {import('./transaction.js').TransactionOptions} RepositoryOptions
 */

/**
 * @param {RepositoryOptions} options
 */
export function createStatsRebuildRepository(options = {}) {
  return {
    requestRebuild: () => requestRebuild(options),
    /** @param {{batchSize?: number}} [input] */
    rebuildChunk: (input = {}) => rebuildChunk(input, options),
    /** @param {{batchSize?: number}} [input] */
    rebuildRequiredChunk: (input = {}) => rebuildRequiredChunk(input, options),
  };
}

/**
 * @param {RepositoryOptions} options
 */
async function requestRebuild(options) {
  return runMutation(
    [STORES.META],
    async (context) => {
      await writeMetaValue(context.transaction, META_KEYS.STATS_REBUILD_REQUIRED, true);
      await writeMetaValue(context.transaction, META_KEYS.STATS_REBUILD, {
        id: REBUILD_ID,
        cursor: null,
        counts: { global: emptyStats(GLOBAL_STATS_ID, '', 'global', context.now()), feeds: {} },
      });
      await context.markChanged({ entities: ['stats'], reason: 'stats-rebuild-request' });
      return {};
    },
    options,
  );
}

/**
 * @param {{batchSize?: number}} input
 * @param {RepositoryOptions} options
 */
async function rebuildChunk(input, options) {
  const batchSize = input.batchSize ?? 250;
  return runMutation(
    [STORES.ARTICLES, STORES.FEEDS, STORES.STATS],
    async (context) => {
      const state = await readRebuildState(context.transaction, context.now());
      const scan = await scanArticleChunk(context.transaction, state, batchSize);
      if (!scan.completed) {
        await writeMetaValue(context.transaction, META_KEYS.STATS_REBUILD, state);
        if (state.legacyPostMigrationState === true)
          await writeMetaValue(context.transaction, META_KEYS.POST_MIGRATION, null);
        return { completed: false, processed: scan.processed };
      }
      await replaceStats(context.transaction, state, context.now());
      await writeMetaValue(context.transaction, META_KEYS.STATS_REBUILD_REQUIRED, false);
      await writeMetaValue(context.transaction, META_KEYS.STATS_REBUILD, null);
      if (state.legacyPostMigrationState === true)
        await writeMetaValue(context.transaction, META_KEYS.POST_MIGRATION, null);
      await context.markChanged({ entities: ['stats'], reason: 'stats-rebuild' });
      return { completed: true, processed: scan.processed };
    },
    { ...options, durability: 'relaxed' },
  );
}

/**
 * @param {{batchSize?: number}} input
 * @param {RepositoryOptions} options
 */
async function rebuildRequiredChunk(input, options) {
  const pending = await hasPendingRebuild(options);
  if (!pending) return { completed: true, processed: 0, status: 'idle' };
  const result = await rebuildChunk(input, options);
  return { ...result, status: result.completed ? 'completed' : 'partial' };
}

/**
 * @param {RepositoryOptions} options
 */
async function hasPendingRebuild(options) {
  return runTransaction(
    STORES.META,
    'readonly',
    async (transaction) => {
      const [required, state, legacyState] = await Promise.all([
        readMetaValue(transaction, META_KEYS.STATS_REBUILD_REQUIRED),
        readMetaValue(transaction, META_KEYS.STATS_REBUILD),
        readMetaValue(transaction, META_KEYS.POST_MIGRATION),
      ]);
      return required === true || isStatsRebuildState(state) || isStatsRebuildState(legacyState);
    },
    options,
  );
}

/**
 * @param {IDBTransaction} transaction
 * @param {number} now
 */
async function readRebuildState(transaction, now) {
  const stored = await readMetaValue(transaction, META_KEYS.STATS_REBUILD);
  if (isStatsRebuildState(stored)) return stored;
  const legacy = await readMetaValue(transaction, META_KEYS.POST_MIGRATION);
  if (isStatsRebuildState(legacy)) return { ...legacy, legacyPostMigrationState: true };
  return {
    id: REBUILD_ID,
    cursor: null,
    counts: { global: emptyStats(GLOBAL_STATS_ID, '', 'global', now), feeds: {} },
  };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isStatsRebuildState(value) {
  return Boolean(value && typeof value === 'object' && 'id' in value && value.id === REBUILD_ID);
}

/**
 * @param {IDBTransaction} transaction
 * @param {Record<string, unknown>} state
 * @param {number} batchSize
 */
async function scanArticleChunk(transaction, state, batchSize) {
  const articles = transaction.objectStore(STORES.ARTICLES).index('bySort');
  const range =
    Array.isArray(state.cursor) && 'IDBKeyRange' in globalThis ? IDBKeyRange.lowerBound(state.cursor, true) : null;
  const request = articles.openCursor(range);
  let cursor = await requestToPromise(request);
  let processed = 0;
  while (cursor && processed < batchSize) {
    if (Array.isArray(state.cursor) && range === null && compareCompoundKey(cursor.key, state.cursor) <= 0) {
      cursor.continue();
      cursor = await requestToPromise(request);
      continue;
    }
    accumulateArticle(state, cursor.value);
    state.cursor = cursor.key;
    processed += 1;
    if (processed < batchSize) {
      cursor.continue();
      cursor = await requestToPromise(request);
    }
  }
  if (cursor && processed >= batchSize) {
    cursor.continue();
    cursor = await requestToPromise(request);
  }
  return { completed: cursor === null, processed };
}

/**
 * @param {IDBValidKey} left
 * @param {unknown[]} right
 */
function compareCompoundKey(left, right) {
  if (!Array.isArray(left)) return 1;
  for (const [index, leftPart] of left.entries()) {
    const result = compareIndexKeyPart(leftPart, right[index]);
    if (result !== 0) return result;
  }
  return left.length - right.length;
}

/**
 * @param {unknown} left
 * @param {unknown} right
 */
function compareIndexKeyPart(left, right) {
  if (typeof left === 'number' && typeof right === 'number') {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }
  if (typeof left === 'string' && typeof right === 'string') {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }
  return 0;
}

/**
 * @param {Record<string, unknown>} state
 * @param {import('./models.js').ArticleRecord} article
 */
function accumulateArticle(state, article) {
  const counts =
    /** @type {{global: import('./models.js').StatsRecord, feeds: Record<string, import('./models.js').StatsRecord>}} */ (
      state.counts
    );
  const feedStats =
    counts.feeds[article.feedId] ??
    emptyStats(feedStatsId(article.feedId), article.feedId, 'feed', article.changedAtMs);
  addArticle(counts.global, article);
  addArticle(feedStats, article);
  counts.feeds[article.feedId] = feedStats;
}

/**
 * @param {IDBTransaction} transaction
 * @param {Record<string, unknown>} state
 * @param {number} now
 */
async function replaceStats(transaction, state, now) {
  const stats = transaction.objectStore(STORES.STATS);
  const feeds = await requestToPromise(transaction.objectStore(STORES.FEEDS).getAll());
  const counts =
    /** @type {{global: import('./models.js').StatsRecord, feeds: Record<string, import('./models.js').StatsRecord>}} */ (
      state.counts
    );
  await requestToPromise(stats.put({ ...counts.global, updatedAtMs: now }));
  for (const feed of feeds) {
    await requestToPromise(stats.put({ ...(counts.feeds[feed.id] ?? zeroFeedStats(feed.id, now)), updatedAtMs: now }));
  }
}

/**
 * @param {import('./models.js').StatsRecord} target
 * @param {import('./models.js').ArticleRecord} article
 */
function addArticle(target, article) {
  target.articleCount += 1;
  if (article.readState === STATE.OFF) target.unreadCount += 1;
  if (article.starredState === STATE.ON) target.starredCount += 1;
  target.lastArticleAtMs = Math.max(target.lastArticleAtMs, article.sortAtMs);
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
