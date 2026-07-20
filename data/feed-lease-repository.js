// @ts-check

import { LEASE_STATE, STORES } from './constants.js';
import { normalizeFeedRecord } from './models.js';
import { requestToPromise, runMutation } from './transaction.js';

const EXPIRED_LEASES_PER_TICK = 20;

/**
 * @typedef {import('./transaction.js').TransactionOptions} RepositoryOptions
 * @typedef {import('./models.js').FeedRecord} FeedRecord
 */

/**
 * @param {RepositoryOptions} options
 */
export function createFeedLeaseRepository(options = {}) {
  return {
    /** @param {{nowMs: number, limit?: number, scanLimit?: number}} input */
    releaseExpiredLeases: (input) => releaseExpiredLeases(input, options),
  };
}

/**
 * @param {{nowMs: number, limit?: number, scanLimit?: number}} input
 * @param {RepositoryOptions} options
 */
async function releaseExpiredLeases(input, options) {
  const limit = normalizeLimit(input.limit, EXPIRED_LEASES_PER_TICK);
  const scanLimit = normalizeLimit(input.scanLimit, EXPIRED_LEASES_PER_TICK * 5);
  return runMutation(
    [STORES.FEEDS],
    async (context) => {
      const request = context.transaction.objectStore(STORES.FEEDS).openCursor();
      /** @type {string[]} */
      const releasedFeedIds = [];
      let cursor = await requestToPromise(request);
      let scannedFeeds = 0;
      while (cursor && releasedFeedIds.length < limit && scannedFeeds < scanLimit) {
        scannedFeeds += 1;
        const feed = /** @type {FeedRecord} */ (cursor.value);
        if (feed.leaseState === LEASE_STATE.HELD && feed.leaseExpiresAtMs <= input.nowMs) {
          const next = normalizeFeedRecord({
            ...feed,
            leaseExpiresAtMs: 0,
            leaseOwner: '',
            leaseState: LEASE_STATE.FREE,
            updatedAtMs: input.nowMs,
          });
          await requestToPromise(cursor.update(next));
          releasedFeedIds.push(next.id);
        }
        cursor.continue();
        cursor = await requestToPromise(request);
      }
      if (releasedFeedIds.length > 0) {
        await context.markChanged({
          entities: ['feeds'],
          feedIds: releasedFeedIds,
          reason: 'feed-lease-expired',
        });
      }
      return {
        releasedFeedIds,
        scannedFeeds,
        status: cursor ? 'partial' : 'completed',
      };
    },
    options,
  );
}

/**
 * @param {number | undefined} value
 * @param {number} fallback
 */
function normalizeLimit(value, fallback) {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}
