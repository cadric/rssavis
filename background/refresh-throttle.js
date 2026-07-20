// @ts-check

import { readHostWindow, writeHostWindow } from '../data/host-throttle-repository.js';
import { hostKey } from '../domain/urls.js';

/** Polite floor for a defer window when the host offers no retry hint. */
const DEFER_MIN_MS = 5000;
/** Hard ceiling so a misread rate-limit hint can never park a feed for days. */
const DEFER_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * Per-host rate-limit throttle. Carries the throttle logic that would
 * otherwise inflate refresh-service.js: the pre-fetch window consultation, the
 * 429-vs-other-failure routing decision, the deferred-`nextFetchAtMs` math and
 * the host-window persistence. All IndexedDB access happens in the throttle
 * repository's own transactions (never around a fetch).
 *
 * @param {import('../data/transaction.js').TransactionOptions} options
 */
export function createRefreshThrottle(options) {
  return {
    /**
     * @param {ReturnType<typeof import('../data/feed-repository.js').createFeedRepository>} feeds
     * @param {import('../data/models.js').FeedRecord} feed
     * @param {string} runId
     * @param {{now: () => number}} config
     */
    consultBeforeFetch: (feeds, feed, runId, config) => consultBeforeFetch(options, feeds, feed, runId, config),
    /**
     * @param {ReturnType<typeof import('../data/feed-repository.js').createFeedRepository>} feeds
     * @param {string} feedId
     * @param {string} runId
     * @param {import('../data/models.js').FeedRecord} feed
     * @param {import('./feed-fetcher.js').FetchFailureResult} fetched
     * @param {{now: () => number, refreshIntervalMinutes: number}} config
     */
    routeFailure: (feeds, feedId, runId, feed, fetched, config) =>
      routeFailure(options, feeds, feedId, runId, feed, fetched, config),
  };
}

/**
 * If the host's throttle window is still closed, defer WITHOUT any network
 * call and return the deferred result; otherwise return null to fetch.
 *
 * @param {import('../data/transaction.js').TransactionOptions} options
 * @param {ReturnType<typeof import('../data/feed-repository.js').createFeedRepository>} feeds
 * @param {import('../data/models.js').FeedRecord} feed
 * @param {string} runId
 * @param {{now: () => number}} config
 */
async function consultBeforeFetch(options, feeds, feed, runId, config) {
  const key = hostKey(feed.resolvedUrl || feed.url);
  if (!key) return null;
  const nowMs = config.now();
  const window = await readHostWindow(options, key, nowMs);
  if (window.nextAllowedAtMs <= nowMs) return null;
  const result = await feeds.completeRefreshDeferred(feed.id, {
    httpStatus: window.lastStatus || 429,
    nextFetchAtMs: window.nextAllowedAtMs,
    nowMs,
    runId,
  });
  return { ...result, feedId: feed.id, status: result.status };
}

/**
 * Routes a fetch failure: a 429 (or a spent x-ratelimit budget) becomes a
 * `deferred` completion plus a persisted host window; anything else is an
 * ordinary `completeRefreshFailure`. The host-window write is its own
 * transaction AFTER the fetch and never touches dataRevision.
 *
 * @param {import('../data/transaction.js').TransactionOptions} options
 * @param {ReturnType<typeof import('../data/feed-repository.js').createFeedRepository>} feeds
 * @param {string} feedId
 * @param {string} runId
 * @param {import('../data/models.js').FeedRecord} feed
 * @param {import('./feed-fetcher.js').FetchFailureResult} fetched
 * @param {{now: () => number, refreshIntervalMinutes: number}} config
 */
async function routeFailure(options, feeds, feedId, runId, feed, fetched, config) {
  const nowMs = config.now();
  if (isRateLimited(fetched)) {
    const nextFetchAtMs = deferredNextAtMs(fetched, nowMs);
    const key = hostKey(feed.resolvedUrl || feed.url);
    if (key)
      await writeHostWindow(
        options,
        key,
        { nextAllowedAtMs: nextFetchAtMs, lastStatus: fetched.httpStatus || 429 },
        nowMs,
      );
    const result = await feeds.completeRefreshDeferred(feedId, {
      httpStatus: fetched.httpStatus || 429,
      nextFetchAtMs,
      nowMs,
      runId,
    });
    return { ...result, feedId, status: result.status };
  }
  const result = await feeds.completeRefreshFailure(feedId, {
    error: fetched.error,
    httpStatus: fetched.httpStatus,
    nowMs,
    refreshIntervalMinutes: config.refreshIntervalMinutes,
    retryAfterMs: fetched.retryAfterMs,
    runId,
  });
  return { ...result, feedId, status: result.status };
}

/**
 * @param {import('./feed-fetcher.js').FetchFailureResult} fetched
 */
function isRateLimited(fetched) {
  if (fetched.httpStatus === 429) return true;
  return typeof fetched.rateLimitRemaining === 'number' && fetched.rateLimitRemaining <= 0;
}

/**
 * @param {import('./feed-fetcher.js').FetchFailureResult} fetched
 * @param {number} nowMs
 */
function deferredNextAtMs(fetched, nowMs) {
  const retryAt = fetched.retryAfterMs > 0 ? nowMs + fetched.retryAfterMs : 0;
  const resetAt = Number(fetched.rateLimitResetMs) > nowMs ? Number(fetched.rateLimitResetMs) : 0;
  return Math.min(nowMs + DEFER_MAX_MS, Math.max(retryAt, resetAt, nowMs + DEFER_MIN_MS));
}
