// @ts-check

import { DELETION_STATE, STATE } from '../data/constants.js';
import { createFeedRepository } from '../data/feed-repository.js';

/**
 * @typedef {import('../data/transaction.js').TransactionOptions} RepositoryOptions
 */

/**
 * @typedef {{articleCount: number, lastArticleAtMs: number, starredCount: number, unreadCount: number}} SystemStats
 */

/**
 * @typedef {{feed: Pick<import('../data/models.js').FeedRecord, 'deletionState' | 'mainStreamState'>, stats: unknown}} FeedStatsEntry
 */

/**
 * @returns {SystemStats}
 */
export function emptyStats() {
  return { articleCount: 0, lastArticleAtMs: 0, starredCount: 0, unreadCount: 0 };
}

/**
 * @param {unknown} stats
 * @returns {SystemStats}
 */
export function sanitizeStats(stats) {
  const record = isRecord(stats) ? stats : {};
  return {
    articleCount: safeCount(record.articleCount),
    lastArticleAtMs: safeCount(record.lastArticleAtMs),
    starredCount: safeCount(record.starredCount),
    unreadCount: safeCount(record.unreadCount),
  };
}

/**
 * @param {Array<{stats: unknown}>} feedEntries
 * @returns {SystemStats}
 */
export function aggregateFeedStats(feedEntries) {
  const total = emptyStats();
  for (const entry of feedEntries) {
    const stats = sanitizeStats(entry.stats);
    total.articleCount += stats.articleCount;
    total.unreadCount += stats.unreadCount;
    total.starredCount += stats.starredCount;
    total.lastArticleAtMs = Math.max(total.lastArticleAtMs, stats.lastArticleAtMs);
  }
  return total;
}

/**
 * @param {FeedStatsEntry[]} feedEntries
 * @returns {SystemStats}
 */
export function aggregateMainStreamStats(feedEntries) {
  return aggregateFeedStats(
    feedEntries.filter(({ feed }) => feed.deletionState === DELETION_STATE.ACTIVE && feed.mainStreamState === STATE.ON),
  );
}

/**
 * @param {RepositoryOptions} [options]
 * @returns {Promise<number>}
 */
export async function readMainStreamUnreadCount(options = {}) {
  const entries = await createFeedRepository(options).listWithStats();
  return aggregateMainStreamStats(entries).unreadCount;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function safeCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}
