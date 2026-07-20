// @ts-check

import { nextBackoffAtMs } from '../domain/backoff.js';
import { createAppError, ERROR_CODES } from '../domain/errors.js';
import { DELETION_STATE, LEASE_STATE, PERMISSION_STATE, SCHEDULE_STATE, STORES } from './constants.js';
import { createFeedRedirectRepository } from './feed-redirect-repository.js';
import { normalizeFeedRecord } from './models.js';
import { requestToPromise, runMutation, runTransaction } from './transaction.js';

export const REFRESH_LEASE_MS = 120_000;
export const SCHEDULED_FEEDS_PER_TICK = 20;

/**
 * @typedef {import('./transaction.js').TransactionOptions} RepositoryOptions
 * @typedef {import('./models.js').FeedRecord} FeedRecord
 */

/**
 * @param {RepositoryOptions} options
 */
export function createFeedRefreshRepository(options = {}) {
  const redirect = createFeedRedirectRepository(options);
  return {
    /** @param {{nowMs: number, limit?: number}} input */
    listDueForRefresh: (input) => listDueForRefresh(input, options),
    /** @param {{limit?: number}} [input] */
    listRefreshable: (input = {}) => listRefreshable(input, options),
    /** @param {string} feedId @param {{nowMs: number, runId: string, leaseMs?: number}} input */
    claimRefresh: (feedId, input) => claimRefresh(feedId, input, options),
    /** @param {string} feedId @param {CompleteSuccessInput} input */
    completeRefreshSuccess: (feedId, input) => completeRefreshSuccess(feedId, input, options),
    /** @param {string} feedId @param {CompleteNotModifiedInput} input */
    completeRefreshNotModified: (feedId, input) => completeRefreshNotModified(feedId, input, options),
    /** @param {string} feedId @param {CompleteFailureInput} input */
    completeRefreshFailure: (feedId, input) => completeRefreshFailure(feedId, input, options),
    /** @param {string} feedId @param {CompleteDeferredInput} input */
    completeRefreshDeferred: (feedId, input) => completeRefreshDeferred(feedId, input, options),
    /** @param {string} feedId @param {CompleteRedirectPermissionInput} input */
    completeRefreshRedirectPermissionRequired: (feedId, input) =>
      completeRefreshRedirectPermissionRequired(feedId, input, options),
    ...redirect,
  };
}

/**
 * @typedef {object} CompleteSuccessInput
 * @property {string} runId
 * @property {number} nowMs
 * @property {number} refreshIntervalMinutes
 * @property {number} httpStatus
 * @property {string} finalUrl
 * @property {string} [finalOrigin]
 * @property {string} [etag]
 * @property {string} [lastModified]
 * @property {{title?: string, siteUrl?: string, iconUrl?: string}} [feed]
 *
 * @typedef {object} CompleteNotModifiedInput
 * @property {string} runId
 * @property {number} nowMs
 * @property {number} refreshIntervalMinutes
 * @property {string} finalUrl
 * @property {string} [finalOrigin]
 * @property {number} [httpStatus]
 *
 * @typedef {object} CompleteFailureInput
 * @property {string} runId
 * @property {number} nowMs
 * @property {number} refreshIntervalMinutes
 * @property {import('../domain/errors.js').SafeError} error
 * @property {number} [httpStatus]
 * @property {number} [retryAfterMs]
 * @property {number} [jitter]
 *
 * @typedef {object} CompleteRedirectPermissionInput
 * @property {string} runId
 * @property {number} nowMs
 * @property {import('../domain/errors.js').SafeError} error
 * @property {string} finalOrigin
 * @property {string} finalUrl
 * @property {number} [httpStatus]
 *
 * @typedef {object} CompleteDeferredInput
 * @property {string} runId
 * @property {number} nowMs
 * @property {number} nextFetchAtMs
 * @property {number} [httpStatus] Observed status; a deferral always stamps 429.
 */

/**
 * @param {{nowMs: number, limit?: number}} input
 * @param {RepositoryOptions} options
 */
async function listDueForRefresh(input, options) {
  const limit = normalizeLimit(input.limit, SCHEDULED_FEEDS_PER_TICK);
  return collectRefreshFeeds(options, scheduleRange(input.nowMs), limit, (feed) => feed.nextFetchAtMs <= input.nowMs);
}

/**
 * @param {{limit?: number}} input
 * @param {RepositoryOptions} options
 */
async function listRefreshable(input, options) {
  const limit = normalizeLimit(input.limit, Number.POSITIVE_INFINITY);
  return collectRefreshFeeds(options, null, limit, () => true);
}

/**
 * Streams the `bySchedule` index, collecting refreshable feeds that also pass
 * `accept`, capped at `limit`.
 *
 * @param {RepositoryOptions} options
 * @param {IDBKeyRange | null} range
 * @param {number} limit
 * @param {(feed: FeedRecord) => boolean} accept
 */
async function collectRefreshFeeds(options, range, limit, accept) {
  return runTransaction(
    STORES.FEEDS,
    'readonly',
    async (transaction) => {
      const request = transaction.objectStore(STORES.FEEDS).index('bySchedule').openCursor(range);
      /** @type {FeedRecord[]} */
      const feeds = [];
      let cursor = await requestToPromise(request);
      while (cursor && feeds.length < limit) {
        const feed = /** @type {FeedRecord} */ (cursor.value);
        if (isRefreshable(feed) && accept(feed)) feeds.push(detach(feed));
        cursor.continue();
        cursor = await requestToPromise(request);
      }
      return feeds;
    },
    options,
  );
}

/**
 * @param {string} feedId
 * @param {{nowMs: number, runId: string, leaseMs?: number}} input
 * @param {RepositoryOptions} options
 */
async function claimRefresh(feedId, input, options) {
  return runMutation(
    [STORES.FEEDS],
    async (context) => {
      const feeds = context.transaction.objectStore(STORES.FEEDS);
      const existing = await requireRefreshFeed(feeds, feedId);
      if (!isRefreshable(existing)) return { feed: detach(existing), status: 'not-refreshable' };
      if (existing.leaseState === LEASE_STATE.HELD && existing.leaseExpiresAtMs > input.nowMs) {
        return { feedId, leaseOwner: existing.leaseOwner, status: 'already-running' };
      }
      const next = normalizeFeedRecord({
        ...existing,
        leaseState: LEASE_STATE.HELD,
        leaseOwner: input.runId,
        leaseExpiresAtMs: input.nowMs + (input.leaseMs ?? REFRESH_LEASE_MS),
        updatedAtMs: input.nowMs,
      });
      await requestToPromise(feeds.put(next));
      await context.markChanged({
        entities: ['feeds'],
        feedIds: [feedId],
        categoryIds: [next.categoryId],
        reason: 'feed-refresh-claim',
      });
      return { feed: detach(next), status: 'claimed' };
    },
    options,
  );
}

/**
 * @param {string} feedId
 * @param {CompleteSuccessInput} input
 * @param {RepositoryOptions} options
 */
async function completeRefreshSuccess(feedId, input, options) {
  return completeRefresh(feedId, input.runId, options, async (existing, context) => {
    const next = normalizeFeedRecord({
      ...successBase(existing, input),
      title: input.feed?.title || existing.title,
      siteUrl: input.feed?.siteUrl || existing.siteUrl,
      iconUrl: input.feed?.iconUrl || existing.iconUrl,
      resolvedUrl: input.finalUrl || existing.resolvedUrl,
      permissionOrigin: input.finalOrigin || existing.permissionOrigin,
      etag: input.etag || existing.etag,
      lastModified: input.lastModified || existing.lastModified,
    });
    return writeCompletedFeed(context, next, 'completed');
  });
}

/**
 * @param {string} feedId
 * @param {CompleteNotModifiedInput} input
 * @param {RepositoryOptions} options
 */
async function completeRefreshNotModified(feedId, input, options) {
  return completeRefresh(feedId, input.runId, options, async (existing, context) => {
    const next = normalizeFeedRecord({
      ...successBase(existing, { ...input, httpStatus: input.httpStatus ?? 304 }),
      resolvedUrl: input.finalUrl || existing.resolvedUrl,
      permissionOrigin: input.finalOrigin || existing.permissionOrigin,
    });
    return writeCompletedFeed(context, next, 'not-modified');
  });
}

/**
 * @param {string} feedId
 * @param {CompleteFailureInput} input
 * @param {RepositoryOptions} options
 */
async function completeRefreshFailure(feedId, input, options) {
  return completeRefresh(feedId, input.runId, options, async (existing, context) => {
    const failures = existing.consecutiveFailures + 1;
    const next = normalizeFeedRecord({
      ...existing,
      consecutiveFailures: failures,
      lastCheckedAtMs: input.nowMs,
      lastHttpStatus: input.httpStatus ?? 0,
      lastErrorCode: input.error.code,
      lastErrorMessage: input.error.messageKey || input.error.code,
      nextFetchAtMs: nextBackoffAtMs({
        consecutiveFailures: failures,
        jitter: input.jitter,
        nowMs: input.nowMs,
        refreshIntervalMinutes: input.refreshIntervalMinutes,
        retryAfterMs: input.retryAfterMs,
      }),
      leaseState: LEASE_STATE.FREE,
      leaseOwner: '',
      leaseExpiresAtMs: 0,
      updatedAtMs: input.nowMs,
    });
    return writeCompletedFeed(context, next, 'failed');
  });
}

/**
 * Completes a refresh as `deferred` (rate-limited), not a failure: keeps
 * `consecutiveFailures`, clears any stale error stamp, and always stamps the
 * canonical `lastHttpStatus = 429` marker, routed through `completeRefresh` so
 * `dataRevision` increments exactly once.
 * @param {string} feedId
 * @param {CompleteDeferredInput} input
 * @param {RepositoryOptions} options
 */
async function completeRefreshDeferred(feedId, input, options) {
  return completeRefresh(feedId, input.runId, options, async (existing, context) => {
    const next = normalizeFeedRecord({
      ...existing,
      lastCheckedAtMs: input.nowMs,
      lastHttpStatus: 429,
      lastErrorCode: '',
      lastErrorMessage: '',
      nextFetchAtMs: input.nextFetchAtMs,
      leaseState: LEASE_STATE.FREE,
      leaseOwner: '',
      leaseExpiresAtMs: 0,
      updatedAtMs: input.nowMs,
    });
    return writeCompletedFeed(context, next, 'deferred');
  });
}

/**
 * @param {string} feedId
 * @param {CompleteRedirectPermissionInput} input
 * @param {RepositoryOptions} options
 */
async function completeRefreshRedirectPermissionRequired(feedId, input, options) {
  return completeRefresh(feedId, input.runId, options, async (existing, context) => {
    const next = normalizeFeedRecord({
      ...existing,
      lastCheckedAtMs: input.nowMs,
      lastHttpStatus: input.httpStatus ?? 0,
      lastErrorCode: input.error.code,
      lastErrorMessage: input.error.messageKey || input.error.code,
      permissionState: PERMISSION_STATE.MISSING,
      redirectOriginPending: input.finalOrigin,
      redirectUrlPending: input.finalUrl,
      scheduleState: SCHEDULE_STATE.DISABLED,
      leaseState: LEASE_STATE.FREE,
      leaseOwner: '',
      leaseExpiresAtMs: 0,
      updatedAtMs: input.nowMs,
    });
    return writeCompletedFeed(context, next, 'redirect-permission-required');
  });
}

/**
 * @param {FeedRecord} existing
 * @param {{nowMs: number, refreshIntervalMinutes: number, httpStatus: number}} input
 */
function successBase(existing, input) {
  return {
    ...existing,
    consecutiveFailures: 0,
    lastCheckedAtMs: input.nowMs,
    lastSuccessAtMs: input.nowMs,
    lastHttpStatus: input.httpStatus,
    lastErrorCode: '',
    lastErrorMessage: '',
    redirectOriginPending: '',
    redirectUrlPending: '',
    nextFetchAtMs: input.nowMs + input.refreshIntervalMinutes * 60 * 1000,
    leaseState: LEASE_STATE.FREE,
    leaseOwner: '',
    leaseExpiresAtMs: 0,
    updatedAtMs: input.nowMs,
  };
}

/**
 * @param {string} feedId
 * @param {string} runId
 * @param {RepositoryOptions} options
 * @param {(existing: FeedRecord, context: import('./transaction.js').MutationContext) => Promise<Record<string, unknown>>} write
 */
async function completeRefresh(feedId, runId, options, write) {
  return runMutation(
    [STORES.FEEDS],
    async (context) => {
      const existing = await requireRefreshFeed(context.transaction.objectStore(STORES.FEEDS), feedId);
      if (existing.leaseOwner !== runId || existing.leaseState !== LEASE_STATE.HELD) {
        return { feed: detach(existing), status: 'stale' };
      }
      return write(existing, context);
    },
    options,
  );
}

/**
 * @param {import('./transaction.js').MutationContext} context
 * @param {FeedRecord} feed
 * @param {string} status
 */
async function writeCompletedFeed(context, feed, status) {
  await requestToPromise(context.transaction.objectStore(STORES.FEEDS).put(feed));
  await context.markChanged({
    entities: ['feeds'],
    feedIds: [feed.id],
    categoryIds: [feed.categoryId],
    reason: 'feed-refresh-complete',
  });
  return { feed: detach(feed), status };
}

/**
 * @param {FeedRecord} feed
 */
function isRefreshable(feed) {
  return (
    feed.deletionState === DELETION_STATE.ACTIVE &&
    feed.permissionState === PERMISSION_STATE.GRANTED &&
    feed.scheduleState === SCHEDULE_STATE.ENABLED
  );
}

/**
 * @param {number} nowMs
 */
function scheduleRange(nowMs) {
  if (!('IDBKeyRange' in globalThis)) return null;
  return globalThis.IDBKeyRange.bound([SCHEDULE_STATE.ENABLED, 0, ''], [SCHEDULE_STATE.ENABLED, nowMs, '\uffff']);
}

/**
 * @param {number | undefined} value
 * @param {number} fallback
 */
function normalizeLimit(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw createAppError(ERROR_CODES.VALIDATION_ERROR);
  return value;
}

/**
 * @param {IDBObjectStore} feeds
 * @param {string} id
 * @returns {Promise<FeedRecord>}
 */
async function requireRefreshFeed(feeds, id) {
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
