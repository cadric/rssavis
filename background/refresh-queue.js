// @ts-check

import { toSafeError } from '../domain/errors.js';
import { hostKey } from '../domain/urls.js';

/** Polite in-run spacing between consecutive same-host fetches (in-memory). */
const DEFAULT_HOST_SPACING_MS = 2500;

/**
 * @typedef {{id: string, url?: string, resolvedUrl?: string}} QueueFeed
 * @typedef {{spacingMs?: number, hostKeyOf?: (feed: QueueFeed) => string}} RefreshQueueOptions
 */

/**
 * Refreshes a batch of feeds. Feeds are grouped by eTLD+1 host key: different
 * hosts run in parallel up to `concurrency`, while feeds that share a host are
 * serialized with a polite delay so a single site is never hammered. Grouping
 * keys on the ACTUAL fetch host (`resolvedUrl || url`) so two feeds that
 * resolve to the same host are spaced even when their subscription URLs differ.
 * The spacing is in-memory and disposable (safe to lose on a background unload).
 *
 * @param {QueueFeed[]} feeds
 * @param {(feedId: string) => Promise<Record<string, unknown>>} refreshOne
 * @param {number} concurrency
 * @param {RefreshQueueOptions} [options]
 */
export async function refreshFeedList(feeds, refreshOne, concurrency, options = {}) {
  const spacingMs = normalizeSpacingMs(options.spacingMs);
  const hostKeyOf = options.hostKeyOf ?? ((feed) => hostKey(feed.resolvedUrl || feed.url || ''));
  const groups = groupByHost(feeds, hostKeyOf);
  const results = await runBoundedGroups(groups, refreshOne, concurrency, spacingMs);
  return {
    processedCount: results.filter((result) => result.status !== 'already-running' && result.status !== 'deferred')
      .length,
    results,
    status: 'completed',
  };
}

/**
 * @param {Record<string, unknown>} result
 */
export function summarizeRefreshResults(result) {
  const results = Array.isArray(result.results) ? result.results : [];
  const summary = {
    checkedCount: 0,
    failedFeedCount: 0,
    newArticleCount: 0,
    unchangedFeedCount: 0,
    updatedFeedCount: 0,
  };
  for (const item of results) {
    if (!isRecord(item) || item.status === 'already-running' || item.status === 'deferred') continue;
    summary.checkedCount += 1;
    const inserted = insertedCount(item);
    summary.newArticleCount += inserted;
    if (item.status === 'refreshed' && inserted > 0) summary.updatedFeedCount += 1;
    else if (item.status === 'refreshed' || item.status === 'not-modified') summary.unchangedFeedCount += 1;
    else summary.failedFeedCount += 1;
  }
  return summary;
}

/**
 * @template {QueueFeed} T
 * @param {T[]} items
 * @param {(item: T) => string} hostKeyOf
 * @returns {T[][]}
 */
function groupByHost(items, hostKeyOf) {
  /** @type {Map<string, T[]>} */
  const groups = new Map();
  items.forEach((item, index) => {
    const key = hostKeyOf(item) || `unkeyed:${index}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  });
  return [...groups.values()];
}

/**
 * @param {QueueFeed[][]} groups
 * @param {(feedId: string) => Promise<Record<string, unknown>>} refreshOne
 * @param {number} concurrency
 * @param {number} spacingMs
 */
async function runBoundedGroups(groups, refreshOne, concurrency, spacingMs) {
  /** @type {Record<string, unknown>[]} */
  const results = [];
  let cursor = 0;
  async function runWorker() {
    while (cursor < groups.length) {
      const group = groups[cursor];
      cursor += 1;
      for (let index = 0; index < group.length; index += 1) {
        if (index > 0 && spacingMs > 0) await delay(spacingMs);
        results.push(await runItem(refreshOne, group[index]));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, groups.length) }, () => runWorker()));
  return results;
}

/**
 * @param {(feedId: string) => Promise<Record<string, unknown>>} refreshOne
 * @param {QueueFeed} feed
 * @returns {Promise<Record<string, unknown>>}
 */
async function runItem(refreshOne, feed) {
  try {
    return await refreshOne(feed.id);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { error: toSafeError(error), status: 'failed' };
  }
}

/**
 * @param {number} ms
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {number | undefined} value
 */
function normalizeSpacingMs(value) {
  if (value === undefined) return DEFAULT_HOST_SPACING_MS;
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_HOST_SPACING_MS;
}

/**
 * @param {unknown} value
 */
function insertedCount(value) {
  if (!isRecord(value) || !isRecord(value.ingest)) return 0;
  const count = value.ingest.insertedCount;
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}
