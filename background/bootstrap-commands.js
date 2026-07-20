// @ts-check

import { createBootstrapSnapshotRepository } from '../data/bootstrap-snapshot-repository.js';
import { DELETION_STATE } from '../data/constants.js';
import { MESSAGE_TYPES } from '../domain/message-types.js';
import { aggregateMainStreamStats, emptyStats, sanitizeStats } from './system-stats.js';

/**
 * @typedef {import('../data/transaction.js').TransactionOptions} RepositoryOptions
 */

/**
 * @param {RepositoryOptions} options
 * @returns {Record<string, import('./command-router.js').CommandHandler>}
 */
export function createBootstrapCommandHandlers(options = {}) {
  return {
    [MESSAGE_TYPES.APP_BOOTSTRAP]: () => readBootstrapSnapshot(options),
  };
}

/**
 * @param {RepositoryOptions} options
 */
async function readBootstrapSnapshot(options) {
  const snapshot = await createBootstrapSnapshotRepository(options).read();
  const { categories, feedEntries, globalStats } = snapshot;
  const activeFeeds = feedEntries.filter(({ feed }) => feed.deletionState === DELETION_STATE.ACTIVE);
  const deletingFeeds = feedEntries.filter(({ feed }) => feed.deletionState === DELETION_STATE.PENDING);
  const categoryStats = aggregateCategoryStats(categories, activeFeeds);
  const mainStats = aggregateMainStreamStats(feedEntries);

  return {
    status: 'reader-ready',
    dataRevision: snapshot.dataRevision,
    defaultCategoryId: snapshot.defaultCategoryId,
    categories: categories.map((category) => ({
      id: category.id,
      order: category.order,
      title: category.title,
      stats: categoryStats.get(category.id) ?? emptyStats(),
    })),
    deletingFeeds: deletingFeeds.map(({ feed }) => ({
      id: feed.id,
      permissionOrigin: feed.permissionOrigin,
      title: feed.title,
    })),
    feeds: activeFeeds.map(({ feed, stats }) => ({
      categoryId: feed.categoryId,
      customTitle: feed.customTitle,
      iconColor: feed.iconColor,
      iconSource: feed.iconSource,
      iconUrl: feed.iconUrl,
      id: feed.id,
      keepReadOnPurge: feed.keepReadOnPurge,
      lastCheckedAtMs: feed.lastCheckedAtMs,
      lastErrorCode: feed.lastErrorCode,
      lastErrorMessage: feed.lastErrorMessage,
      lastHttpStatus: feed.lastHttpStatus,
      mainStreamState: feed.mainStreamState,
      nextFetchAtMs: feed.nextFetchAtMs,
      order: feed.order,
      permissionOrigin: feed.permissionOrigin,
      permissionState: feed.permissionState,
      redirectOriginPending: feed.redirectOriginPending,
      redirectUrlPending: feed.redirectUrlPending,
      stats: sanitizeStats(stats),
      siteUrl: feed.siteUrl,
      title: feed.title,
      url: feed.url,
    })),
    systemStats: {
      all: sanitizeStats(globalStats),
      main: mainStats,
    },
  };
}

/**
 * @param {Array<import('../data/models.js').CategoryRecord>} categories
 * @param {Array<{feed: import('../data/models.js').FeedRecord, stats: import('../data/models.js').StatsRecord | null}>} feedEntries
 */
function aggregateCategoryStats(categories, feedEntries) {
  const stats = new Map(categories.map((category) => [category.id, emptyStats()]));
  for (const { feed, stats: feedStats } of feedEntries) {
    const categoryStats = stats.get(feed.categoryId);
    if (categoryStats) addStats(categoryStats, feedStats);
  }
  return stats;
}

/**
 * @param {{articleCount: number, unreadCount: number, starredCount: number, lastArticleAtMs: number}} target
 * @param {unknown} stats
 */
function addStats(target, stats) {
  const safe = sanitizeStats(stats);
  target.articleCount += safe.articleCount;
  target.unreadCount += safe.unreadCount;
  target.starredCount += safe.starredCount;
  target.lastArticleAtMs = Math.max(target.lastArticleAtMs, safe.lastArticleAtMs);
}
