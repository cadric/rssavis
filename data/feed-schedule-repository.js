// @ts-check

import { DELETION_STATE, LEASE_STATE, PERMISSION_STATE, SCHEDULE_STATE, STORES } from './constants.js';
import { normalizeFeedRecord } from './models.js';
import { requestToPromise, runMutation } from './transaction.js';

/**
 * @typedef {import('./transaction.js').TransactionOptions} RepositoryOptions
 * @typedef {import('./models.js').FeedRecord} FeedRecord
 * @typedef {import('./settings-repository.js').SettingsRecord} SettingsRecord
 */

/**
 * @param {RepositoryOptions} options
 */
export function createFeedScheduleRepository(options = {}) {
  return {
    /** @param {{before: SettingsRecord, after: SettingsRecord, nowMs: number}} input */
    replanRefreshInterval: (input) => replanRefreshInterval(input, options),
  };
}

/**
 * @param {{before: SettingsRecord, after: SettingsRecord, nowMs: number}} input
 * @param {RepositoryOptions} options
 */
async function replanRefreshInterval(input, options) {
  if (input.before.refreshIntervalMinutes === input.after.refreshIntervalMinutes) {
    return { processedCount: 0, status: 'unchanged' };
  }
  return runMutation([STORES.FEEDS], async (context) => {
    const feeds = context.transaction.objectStore(STORES.FEEDS);
    const request = feeds.index('bySchedule').openCursor();
    /** @type {string[]} */
    const feedIds = [];
    /** @type {string[]} */
    const categoryIds = [];
    let cursor = await requestToPromise(request);
    while (cursor) {
      const feed = /** @type {FeedRecord} */ (cursor.value);
      const nextFetchAtMs = nextScheduledAt(feed, input);
      if (nextFetchAtMs !== null && nextFetchAtMs !== feed.nextFetchAtMs) {
        const next = normalizeFeedRecord({ ...feed, nextFetchAtMs, updatedAtMs: input.nowMs });
        await requestToPromise(cursor.update(next));
        feedIds.push(next.id);
        categoryIds.push(next.categoryId);
      }
      cursor.continue();
      cursor = await requestToPromise(request);
    }
    if (feedIds.length > 0) {
      await context.markChanged({
        entities: ['feeds'],
        feedIds,
        categoryIds: [...new Set(categoryIds)],
        scopes: feedIds.map((id) => `feed:${id}`),
        reason: 'feed-refresh-replan',
      });
    }
    return { dataRevision: context.dataRevision, processedCount: feedIds.length, status: 'completed' };
  }, options);
}

/**
 * @param {FeedRecord} feed
 * @param {{after: SettingsRecord, nowMs: number}} input
 */
function nextScheduledAt(feed, input) {
  if (!shouldReplan(feed)) return null;
  const anchorMs = feed.lastSuccessAtMs || feed.lastCheckedAtMs || input.nowMs;
  return anchorMs + input.after.refreshIntervalMinutes * 60 * 1000;
}

/**
 * @param {FeedRecord} feed
 */
function shouldReplan(feed) {
  return (
    feed.deletionState === DELETION_STATE.ACTIVE &&
    feed.permissionState === PERMISSION_STATE.GRANTED &&
    feed.scheduleState === SCHEDULE_STATE.ENABLED &&
    feed.leaseState !== LEASE_STATE.HELD &&
    feed.consecutiveFailures === 0 &&
    !feed.lastErrorCode &&
    !feed.redirectOriginPending
  );
}
