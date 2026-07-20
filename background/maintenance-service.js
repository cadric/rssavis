// @ts-check

import { createArticleRepository } from '../data/article-repository.js';
import { openDatabase } from '../data/db.js';
import { createFeedRepository } from '../data/feed-repository.js';
import { META_KEYS, readMetaValue, writeMetaValue } from '../data/meta-repository.js';
import { DEFAULT_SETTINGS } from '../data/settings-repository.js';
import { runPostMigrationsForDatabase } from '../data/migrations.js';
import { createStatsRepository } from '../data/stats-repository.js';
import { STATE, STORES } from '../data/constants.js';
import { runTransaction } from '../data/transaction.js';
import { ERROR_CODES, createAppError } from '../domain/errors.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {import('../data/transaction.js').TransactionOptions} RepositoryOptions
 * @typedef {{batchSize?: number, maxChunks?: number, maxFeeds?: number}} PendingFeedDeletionInput
 * @typedef {{batchSize?: number, maxChunks?: number, settings?: Partial<import('../data/settings-repository.js').SettingsRecord>}} PurgeInput
 * @typedef {{changePublisher?: import('./change-events.js').ChangePublisher | null}} MaintenanceDependencies
 * @typedef {{
 *   expiredLeaseLimit?: number,
 *   postMigrationBatchSize?: number,
 *   postMigrations?: readonly import('../data/migrations.js').PostMigrationDefinition[],
 *   settings?: Partial<import('../data/settings-repository.js').SettingsRecord>,
 *   statsRebuildBatchSize?: number
 * }} MaintenanceInput
 */

/**
 * @param {RepositoryOptions} options
 * @param {MaintenanceDependencies} dependencies
 */
export function createMaintenanceService(options = {}, dependencies = {}) {
  const articles = createArticleRepository(options);
  const feeds = createFeedRepository(options);
  const stats = createStatsRepository(options);
  const changePublisher = dependencies.changePublisher ?? null;
  return {
    /**
     * @param {PendingFeedDeletionInput} [input]
     */
    runPendingFeedDeletion: (input = {}) => runPendingFeedDeletion(input, feeds, articles, changePublisher),
    /**
     * @param {PurgeInput} [input]
     */
    runPurge: (input = {}) => runPurge(input, articles, feeds, changePublisher),
    /**
     * @param {MaintenanceInput} [input]
     */
    runMaintenance: (input = {}) => runMaintenance(input, feeds, articles, stats, options, changePublisher),
  };
}

/**
 * @param {PendingFeedDeletionInput} input
 * @param {ReturnType<typeof createFeedRepository>} feeds
 * @param {ReturnType<typeof createArticleRepository>} articles
 * @param {import('./change-events.js').ChangePublisher | null} changePublisher
 */
async function runPendingFeedDeletion(input, feeds, articles, changePublisher) {
  const batchSize = normalizePositiveInteger(input.batchSize, 250);
  const maxChunks = normalizePositiveInteger(input.maxChunks, 8);
  const maxFeeds = normalizePositiveInteger(input.maxFeeds, 20);
  const pendingFeeds = await feeds.listDeletePending({ limit: maxFeeds });
  const completedFeeds = [];
  let deletedArticles = 0;
  let chunks = 0;

  for (const feed of pendingFeeds) {
    while (chunks < maxChunks) {
      chunks += 1;
      const result = await articles.deleteChunk({ type: 'feed', feedId: feed.id, batchSize });
      await publishChange(changePublisher, result);
      deletedArticles += result.deletedCount;
      if (result.completed) {
        completedFeeds.push(feed.id);
        break;
      }
    }
    if (chunks >= maxChunks) break;
  }

  return {
    completedFeeds,
    deletedArticles,
    processedFeeds: pendingFeeds.map((feed) => feed.id),
    status: pendingFeeds.length === 0 || completedFeeds.length === pendingFeeds.length ? 'completed' : 'partial',
  };
}

/**
 * @param {PurgeInput} input
 * @param {ReturnType<typeof createArticleRepository>} articles
 * @param {ReturnType<typeof createFeedRepository>} feeds
 * @param {import('./change-events.js').ChangePublisher | null} changePublisher
 */
async function runPurge(input, articles, feeds, changePublisher) {
  const batchSize = normalizePositiveInteger(input.batchSize, 250);
  const maxChunks = normalizePositiveInteger(input.maxChunks, 8);
  const settings = { ...DEFAULT_SETTINGS, ...(input.settings ?? {}) };
  const keepReadFeedIds = await snapshotKeepReadFeedIds(feeds);
  let deletedArticles = 0;
  let protectedCount = 0;
  let completed = true;
  let chunks = 0;

  while (chunks < maxChunks) {
    const result = await articles.purgeChunk({
      batchSize,
      keepStarred: settings.keepStarredOnPurge,
      keepUnread: settings.keepUnreadOnPurge,
      keepReadFeedIds,
      maxAgeDays: settings.purgeMaxAgeDays,
      maxArticles: settings.purgeMaxArticles,
    });
    await publishChange(changePublisher, result);
    deletedArticles += result.deletedCount;
    protectedCount += result.protectedCount;
    chunks += result.deletedCount > 0 ? 1 : 0;
    completed = result.completed;
    if (result.completed || result.deletedCount === 0) break;
  }

  return {
    chunks,
    deletedArticles,
    protectedCount,
    status: completed ? 'completed' : 'partial',
  };
}

/**
 * @param {MaintenanceInput} input
 * @param {ReturnType<typeof createFeedRepository>} feeds
 * @param {ReturnType<typeof createArticleRepository>} articles
 * @param {ReturnType<typeof createStatsRepository>} stats
 * @param {RepositoryOptions} options
 * @param {import('./change-events.js').ChangePublisher | null} changePublisher
 */
async function runMaintenance(input, feeds, articles, stats, options, changePublisher) {
  const deletion = await runPendingFeedDeletion({}, feeds, articles, changePublisher);
  const postMigration = await runPostMigrationChunk(input, options);
  const statsRebuild = await stats.rebuildRequiredChunk({
    batchSize: normalizePositiveInteger(input.statsRebuildBatchSize, 250),
  });
  await publishChange(changePublisher, statsRebuild);
  const purge = (await claimDailyMaintenance(options))
    ? await runPurge({ settings: input.settings }, articles, feeds, changePublisher)
    : null;
  const leaseReconciliation = await feeds.releaseExpiredLeases({
    limit: normalizePositiveInteger(input.expiredLeaseLimit, 20),
    nowMs: options.now ? options.now() : Date.now(),
  });
  await publishChange(changePublisher, leaseReconciliation);
  return {
    deletion,
    leaseReconciliation,
    postMigration,
    purge,
    statsRebuild,
    status:
      deletion.status === 'partial' ||
      postMigration.completed === false ||
      purge?.status === 'partial' ||
      statsRebuild.status === 'partial' ||
      leaseReconciliation.status === 'partial'
        ? 'partial'
        : 'completed',
  };
}

/**
 * @param {MaintenanceInput} input
 * @param {RepositoryOptions} options
 */
async function runPostMigrationChunk(input, options) {
  const database = await openDatabase(options);
  return runPostMigrationsForDatabase(database, {
    batchSize: normalizePositiveInteger(input.postMigrationBatchSize, 250),
    migrations: input.postMigrations,
  });
}

/**
 * Snapshots the feed ids whose read articles must survive purge (keepReadOnPurge === STATE.ON) at
 * purge start. Passed to every chunk so the protection is stable across a resumable purge run.
 * @param {ReturnType<typeof createFeedRepository>} feeds
 * @returns {Promise<string[]>}
 */
async function snapshotKeepReadFeedIds(feeds) {
  const entries = await feeds.listWithStats();
  return entries.filter((entry) => entry.feed.keepReadOnPurge === STATE.ON).map((entry) => entry.feed.id);
}

/**
 * @param {RepositoryOptions} options
 */
async function claimDailyMaintenance(options) {
  const now = options.now ? options.now() : Date.now();
  return runTransaction(
    STORES.META,
    'readwrite',
    async (transaction) => {
      const last = await readMetaValue(transaction, META_KEYS.LAST_MAINTENANCE_AT_MS);
      if (typeof last === 'number' && now - last < DAY_MS) return false;
      await writeMetaValue(transaction, META_KEYS.LAST_MAINTENANCE_AT_MS, now);
      return true;
    },
    options,
  );
}

/**
 * @param {number | undefined} value
 * @param {number} fallback
 */
function normalizePositiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  if (Number.isSafeInteger(value) && value > 0) return value;
  throw createAppError(ERROR_CODES.VALIDATION_ERROR);
}

/**
 * @param {import('./change-events.js').ChangePublisher | null} publisher
 * @param {Partial<import('./change-events.js').RepositoryMutationResult> & Record<string, unknown>} result
 */
async function publishChange(publisher, result) {
  if (publisher) await publisher(result);
}
