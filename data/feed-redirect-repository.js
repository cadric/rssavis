// @ts-check

import { createAppError, ERROR_CODES } from '../domain/errors.js';
import { LEASE_STATE, PERMISSION_STATE, SCHEDULE_STATE, STORES } from './constants.js';
import { normalizeFeedRecord } from './models.js';
import { requestToPromise, runMutation } from './transaction.js';

/**
 * @typedef {import('./transaction.js').TransactionOptions} RepositoryOptions
 * @typedef {import('./models.js').FeedRecord} FeedRecord
 */

/**
 * @param {RepositoryOptions} options
 */
export function createFeedRedirectRepository(options = {}) {
  return {
    /** @param {string} feedId @param {GrantRedirectPermissionInput} input */
    grantRedirectPermission: (feedId, input) => grantRedirectPermission(feedId, input, options),
  };
}

/**
 * @typedef {object} GrantRedirectPermissionInput
 * @property {string} redirectOriginPending
 * @property {string} redirectUrlPending
 */

/**
 * @param {string} feedId
 * @param {GrantRedirectPermissionInput} input
 * @param {RepositoryOptions} options
 */
async function grantRedirectPermission(feedId, input, options) {
  return runMutation(
    [STORES.FEEDS],
    async (context) => {
      const existing = await requireRedirectFeed(context.transaction.objectStore(STORES.FEEDS), feedId);
      if (
        existing.redirectOriginPending !== input.redirectOriginPending ||
        existing.redirectUrlPending !== input.redirectUrlPending
      ) {
        throw createAppError(ERROR_CODES.VALIDATION_ERROR, {
          details: { field: 'redirectOriginPending', reason: 'missing or stale redirect permission' },
        });
      }
      const next = normalizeFeedRecord({
        ...existing,
        etag: '',
        lastModified: '',
        lastErrorCode: '',
        lastErrorMessage: '',
        nextFetchAtMs: context.now(),
        permissionOrigin: input.redirectOriginPending,
        permissionState: PERMISSION_STATE.GRANTED,
        redirectOriginPending: '',
        redirectUrlPending: '',
        resolvedUrl: input.redirectUrlPending,
        scheduleState: SCHEDULE_STATE.ENABLED,
        leaseState: LEASE_STATE.FREE,
        leaseOwner: '',
        leaseExpiresAtMs: 0,
        updatedAtMs: context.now(),
      });
      await requestToPromise(context.transaction.objectStore(STORES.FEEDS).put(next));
      await context.markChanged({
        entities: ['feeds'],
        feedIds: [feedId],
        categoryIds: [next.categoryId],
        scopes: [`feed:${feedId}`],
        reason: 'feed-redirect-permission-grant',
      });
      return { feed: detach(next), dataRevision: context.dataRevision };
    },
    options,
  );
}

/**
 * @param {IDBObjectStore} feeds
 * @param {string} id
 * @returns {Promise<FeedRecord>}
 */
async function requireRedirectFeed(feeds, id) {
  const feed = await requestToPromise(feeds.get(id));
  if (!feed) throw createAppError(ERROR_CODES.FEED_NOT_FOUND, { details: { feedId: id } });
  return feed;
}

/**
 * @template {Record<string, unknown>} T
 * @param {T} record
 * @returns {T}
 */
function detach(record) {
  return /** @type {T} */ ({ ...record });
}
