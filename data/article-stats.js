// @ts-check

import { createAppError, ERROR_CODES } from '../domain/errors.js';
import { STATE } from './constants.js';
import { feedStatsId } from './feed-repository.js';
import { normalizeStatsRecord } from './models.js';
import { requestToPromise } from './transaction.js';

/**
 * @typedef {{articleCount?: number, unreadCount?: number, starredCount?: number, lastArticleAtMs?: number}} StatsDelta
 */

/**
 * @param {IDBObjectStore} stats
 * @param {string} feedId
 * @param {StatsDelta} delta
 * @param {number} now
 */
export async function applyStatsDelta(stats, feedId, delta, now) {
  const global = applyDelta(await readStats(stats, 'global', '', 'global', now), delta, now);
  const feed = applyDelta(await readStats(stats, feedStatsId(feedId), feedId, 'feed', now), delta, now);
  await requestToPromise(stats.put(global));
  await requestToPromise(stats.put(feed));
}

/**
 * @param {IDBObjectStore} stats
 * @param {Record<string, StatsDelta>} deltas
 * @param {number} now
 */
export async function applyStatsDeltas(stats, deltas, now) {
  for (const [feedId, delta] of Object.entries(deltas)) await applyStatsDelta(stats, feedId, delta, now);
}

/**
 * @param {import('./models.js').ArticleRecord} article
 * @param {-1 | 1} direction
 * @returns {StatsDelta}
 */
export function articleStatsDelta(article, direction) {
  return {
    articleCount: direction,
    unreadCount: article.readState === STATE.OFF ? direction : 0,
    starredCount: article.starredState === STATE.ON ? direction : 0,
    lastArticleAtMs: direction > 0 ? article.sortAtMs : 0,
  };
}

/**
 * @param {IDBObjectStore} stats
 * @param {string} id
 * @param {string} scopeId
 * @param {'global' | 'feed'} scopeType
 * @param {number} now
 */
async function readStats(stats, id, scopeId, scopeType, now) {
  return (
    (await requestToPromise(stats.get(id))) ??
    normalizeStatsRecord({
      id,
      scopeType,
      scopeId,
      articleCount: 0,
      unreadCount: 0,
      starredCount: 0,
      lastArticleAtMs: 0,
      updatedAtMs: now,
    })
  );
}

/**
 * @param {import('./models.js').StatsRecord} current
 * @param {StatsDelta} delta
 * @param {number} now
 */
function applyDelta(current, delta, now) {
  const articleCount = current.articleCount + (delta.articleCount ?? 0);
  const unreadCount = current.unreadCount + (delta.unreadCount ?? 0);
  const starredCount = current.starredCount + (delta.starredCount ?? 0);
  const next = normalizeStatsRecord({
    ...current,
    articleCount,
    unreadCount,
    starredCount,
    lastArticleAtMs: articleCount === 0 ? 0 : Math.max(current.lastArticleAtMs, delta.lastArticleAtMs ?? 0),
    updatedAtMs: now,
  });
  if (next.articleCount < next.unreadCount || next.articleCount < next.starredCount) {
    throw createAppError(ERROR_CODES.VALIDATION_ERROR, {
      details: { field: 'stats', reason: 'stats counts must remain internally consistent' },
    });
  }
  return next;
}
