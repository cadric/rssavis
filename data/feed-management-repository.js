// @ts-check

import { createAppError, ERROR_CODES } from '../domain/errors.js';
import { normalizeFeedUrl, originPatternForUrl } from '../domain/urls.js';
import { DELETION_STATE, LEASE_STATE, PERMISSION_STATE, SCHEDULE_STATE, STATE, STORES } from './constants.js';
import { normalizeFeedRecord } from './models.js';
import { requestToPromise, runMutation, runTransaction } from './transaction.js';

/**
 * @typedef {import('./transaction.js').TransactionOptions} RepositoryOptions
 */

/**
 * @param {string} id
 * @param {Record<string, unknown>} patch
 * @param {RepositoryOptions} options
 */
export async function updateSubscription(id, patch, options) {
  return runMutation(
    [STORES.CATEGORIES, STORES.FEEDS],
    async (context) => {
      const categories = context.transaction.objectStore(STORES.CATEGORIES);
      const feeds = context.transaction.objectStore(STORES.FEEDS);
      const existing = await requireFeedRecord(feeds, id);
      const nextInput = normalizeSubscriptionPatch(existing, patch, context.now());
      const urlChanged = nextInput.normalizedUrl !== existing.normalizedUrl;
      if (!(await requestToPromise(categories.get(nextInput.categoryId)))) {
        throw createAppError(ERROR_CODES.CATEGORY_NOT_FOUND, { details: { categoryId: nextInput.categoryId } });
      }
      const duplicate = await requestToPromise(feeds.index('byNormalizedUrl').get(nextInput.normalizedUrl));
      if (duplicate && duplicate.id !== id) {
        throw createAppError(ERROR_CODES.FEED_ALREADY_EXISTS, { details: { feedId: duplicate.id } });
      }
      const next = normalizeFeedRecord(nextInput);
      if (JSON.stringify(existing) === JSON.stringify(next)) return { feed: detach(existing), urlChanged: false };
      await requestToPromise(feeds.put(next));
      await context.markChanged({
        entities: ['feeds'],
        feedIds: [id],
        categoryIds: [existing.categoryId, next.categoryId],
        scopes: [`feed:${id}`],
        reason: 'feed-update',
      });
      return { feed: detach(next), urlChanged };
    },
    { ...options, durability: 'strict' },
  );
}

/**
 * Persists a background-resolved icon URL to the existing `iconUrl` field in its
 * own strict transaction. Idempotent by design: it never clobbers an icon that a
 * concurrent writer (or a prior resolution) already set, so the write is a no-op
 * unless the field is still empty. Runs outside any fetch/DOMParser work.
 * @param {string} id
 * @param {string} iconUrl
 * @param {RepositoryOptions} options
 */
export async function setResolvedIconUrl(id, iconUrl, options) {
  return runMutation(
    [STORES.FEEDS],
    async (context) => {
      const feeds = context.transaction.objectStore(STORES.FEEDS);
      const existing = await requestToPromise(feeds.get(id));
      if (!existing) return { feed: null };
      if (existing.iconUrl) return { feed: detach(existing) };
      const next = normalizeFeedRecord({ ...existing, iconUrl, updatedAtMs: context.now() });
      if (JSON.stringify(existing) === JSON.stringify(next)) return { feed: detach(existing) };
      await requestToPromise(feeds.put(next));
      await context.markChanged({
        entities: ['feeds'],
        feedIds: [id],
        categoryIds: [next.categoryId],
        scopes: [`feed:${id}`],
        reason: 'feed-icon',
      });
      return { feed: detach(next) };
    },
    { ...options, durability: 'strict' },
  );
}

/**
 * @param {string} id
 * @param {string} categoryId
 * @param {'up' | 'down'} direction
 * @param {RepositoryOptions} options
 */
export async function moveFeedRelative(id, categoryId, direction, options) {
  return runMutation(
    [STORES.CATEGORIES, STORES.FEEDS],
    async (context) => {
      const categories = context.transaction.objectStore(STORES.CATEGORIES);
      const feeds = context.transaction.objectStore(STORES.FEEDS);
      if (!(await requestToPromise(categories.get(categoryId)))) {
        throw createAppError(ERROR_CODES.CATEGORY_NOT_FOUND, { details: { categoryId } });
      }
      const existing = await requireFeedRecord(feeds, id);
      const records = await requestToPromise(feeds.getAll());
      const currentCategory = orderedActiveFeeds(records, existing.categoryId);
      const targetCategory = orderedActiveFeeds(records, categoryId).filter((feed) => feed.id !== id);
      const nextCurrent = currentCategory.filter((feed) => feed.id !== id);
      const nextTarget =
        categoryId === existing.categoryId
          ? moveWithin(currentCategory, id, direction)
          : [...targetCategory, { ...existing, categoryId }];
      const changed = categoryId !== existing.categoryId || orderOf(currentCategory, id) !== orderOf(nextTarget, id);
      if (changed) {
        if (categoryId !== existing.categoryId) await writeOrderedFeeds(feeds, nextCurrent, context.now());
        await writeOrderedFeeds(feeds, nextTarget, context.now());
        await context.markChanged({
          entities: ['feeds'],
          feedIds: [id],
          categoryIds: [...new Set([existing.categoryId, categoryId])],
          reason: 'feed-move',
        });
      }
      return { feed: detach(await requireFeedRecord(feeds, id)) };
    },
    { ...options, durability: 'strict' },
  );
}

/**
 * @param {string} id
 * @param {string} categoryId
 * @param {RepositoryOptions} options
 */
export async function moveFeedToCategory(id, categoryId, options) {
  return runMutation(
    [STORES.CATEGORIES, STORES.FEEDS],
    async (context) => {
      const categories = context.transaction.objectStore(STORES.CATEGORIES);
      const feeds = context.transaction.objectStore(STORES.FEEDS);
      if (!(await requestToPromise(categories.get(categoryId)))) {
        throw createAppError(ERROR_CODES.CATEGORY_NOT_FOUND, { details: { categoryId } });
      }
      const existing = await requireFeedRecord(feeds, id);
      if (existing.categoryId === categoryId) return { feed: detach(existing) };
      const records = await requestToPromise(feeds.getAll());
      const nextCurrent = orderedActiveFeeds(records, existing.categoryId).filter((feed) => feed.id !== id);
      const nextTarget = [...orderedActiveFeeds(records, categoryId), { ...existing, categoryId }];
      await writeOrderedFeeds(feeds, nextCurrent, context.now());
      await writeOrderedFeeds(feeds, nextTarget, context.now());
      await context.markChanged({
        entities: ['feeds'],
        feedIds: [id],
        categoryIds: [existing.categoryId, categoryId],
        reason: 'feed-move-category',
      });
      return { feed: detach(await requireFeedRecord(feeds, id)) };
    },
    { ...options, durability: 'strict' },
  );
}

/**
 * @param {{limit?: number}} input
 * @param {RepositoryOptions} options
 */
export async function listDeletePending(input, options) {
  const limit = normalizeLimit(input.limit, 20);
  return runTransaction(
    STORES.FEEDS,
    'readonly',
    async (transaction) => {
      const request = transaction.objectStore(STORES.FEEDS).index('byDeletion').openCursor();
      /** @type {import('./models.js').FeedRecord[]} */
      const pending = [];
      let cursor = await requestToPromise(request);
      while (cursor && pending.length < limit) {
        const feed = /** @type {import('./models.js').FeedRecord} */ (cursor.value);
        if (feed.deletionState === DELETION_STATE.PENDING) pending.push({ ...feed });
        cursor.continue();
        cursor = await requestToPromise(request);
      }
      return pending;
    },
    options,
  );
}

/**
 * @param {IDBObjectStore} feeds
 * @param {string} id
 * @returns {Promise<import('./models.js').FeedRecord>}
 */
async function requireFeedRecord(feeds, id) {
  const feed = await requestToPromise(feeds.get(id));
  if (!feed) throw createAppError(ERROR_CODES.FEED_NOT_FOUND, { details: { feedId: id } });
  return feed;
}

/**
 * @param {import('./models.js').FeedRecord} existing
 * @param {Record<string, unknown>} patch
 * @param {number} now
 */
function normalizeSubscriptionPatch(existing, patch, now) {
  const allowed = new Set([
    'title',
    'customTitle',
    'url',
    'categoryId',
    'mainStreamState',
    'keepReadOnPurge',
    'iconSource',
    'iconColor',
  ]);
  for (const key of Object.keys(patch)) if (!allowed.has(key)) throw createAppError(ERROR_CODES.VALIDATION_ERROR);
  const nextUrl = 'url' in patch ? requireString(patch, 'url') : existing.url;
  const normalizedUrl = normalizeFeedUrl(nextUrl);
  const urlChanged = normalizedUrl !== existing.normalizedUrl;
  return {
    ...existing,
    title: 'title' in patch ? requireString(patch, 'title') : existing.title,
    customTitle: 'customTitle' in patch ? optionalTitle(patch, 'customTitle') : existing.customTitle,
    iconSource: 'iconSource' in patch ? patch.iconSource : existing.iconSource,
    iconColor: 'iconColor' in patch ? optionalTitle(patch, 'iconColor') : existing.iconColor,
    url: normalizedUrl,
    normalizedUrl,
    resolvedUrl: urlChanged ? '' : existing.resolvedUrl,
    categoryId: 'categoryId' in patch ? requireString(patch, 'categoryId') : existing.categoryId,
    mainStreamState: 'mainStreamState' in patch ? requireState(patch.mainStreamState) : existing.mainStreamState,
    keepReadOnPurge: 'keepReadOnPurge' in patch ? requireState(patch.keepReadOnPurge) : existing.keepReadOnPurge,
    permissionOrigin: urlChanged ? originPatternForUrl(normalizedUrl) : existing.permissionOrigin,
    permissionState: urlChanged ? PERMISSION_STATE.GRANTED : existing.permissionState,
    redirectOriginPending: urlChanged ? '' : existing.redirectOriginPending,
    redirectUrlPending: urlChanged ? '' : existing.redirectUrlPending,
    scheduleState: urlChanged ? SCHEDULE_STATE.ENABLED : existing.scheduleState,
    etag: urlChanged ? '' : existing.etag,
    lastModified: urlChanged ? '' : existing.lastModified,
    lastCheckedAtMs: urlChanged ? 0 : existing.lastCheckedAtMs,
    lastSuccessAtMs: urlChanged ? 0 : existing.lastSuccessAtMs,
    nextFetchAtMs: urlChanged ? now : existing.nextFetchAtMs,
    consecutiveFailures: urlChanged ? 0 : existing.consecutiveFailures,
    lastHttpStatus: urlChanged ? 0 : existing.lastHttpStatus,
    lastErrorCode: urlChanged ? '' : existing.lastErrorCode,
    lastErrorMessage: urlChanged ? '' : existing.lastErrorMessage,
    leaseState: urlChanged ? LEASE_STATE.FREE : existing.leaseState,
    leaseOwner: urlChanged ? '' : existing.leaseOwner,
    leaseExpiresAtMs: urlChanged ? 0 : existing.leaseExpiresAtMs,
    updatedAtMs: now,
  };
}

/**
 * @param {import('./models.js').FeedRecord[]} records
 * @param {string} categoryId
 */
function orderedActiveFeeds(records, categoryId) {
  return records
    .filter((feed) => feed.categoryId === categoryId && feed.deletionState === DELETION_STATE.ACTIVE)
    .toSorted(compareFeedOrder);
}

/**
 * @param {Record<string, unknown>} record
 * @param {string} key
 */
function requireString(record, key) {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw createAppError(ERROR_CODES.VALIDATION_ERROR, {
      details: { field: key, reason: 'must be a non-empty string' },
    });
  }
  return value;
}

/**
 * The user title (customTitle) may be an empty string, which clears it and falls back to the remote
 * title, so it is validated as a string without the non-empty requirement.
 * @param {Record<string, unknown>} record
 * @param {string} key
 */
function optionalTitle(record, key) {
  const value = record[key];
  if (typeof value !== 'string') {
    throw createAppError(ERROR_CODES.VALIDATION_ERROR, { details: { field: key, reason: 'must be a string' } });
  }
  return value;
}

/**
 * @param {unknown} value
 */
function requireState(value) {
  if (value === STATE.OFF || value === STATE.ON) return value;
  throw createAppError(ERROR_CODES.VALIDATION_ERROR, {
    details: { field: 'mainStreamState', reason: 'invalid state' },
  });
}

/**
 * @param {import('./models.js').FeedRecord} left
 * @param {import('./models.js').FeedRecord} right
 */
function compareFeedOrder(left, right) {
  return left.order - right.order || left.id.localeCompare(right.id);
}

/**
 * @param {import('./models.js').FeedRecord[]} records
 * @param {string} id
 * @param {'up' | 'down'} direction
 */
function moveWithin(records, id, direction) {
  const index = records.findIndex((feed) => feed.id === id);
  if (index < 0) throw createAppError(ERROR_CODES.FEED_NOT_FOUND, { details: { feedId: id } });
  const target = direction === 'up' ? index - 1 : index + 1;
  if (target < 0 || target >= records.length) return records;
  const next = records.slice();
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/**
 * @param {IDBObjectStore} feeds
 * @param {import('./models.js').FeedRecord[]} records
 * @param {number} now
 */
async function writeOrderedFeeds(feeds, records, now) {
  for (const [index, feed] of records.entries()) {
    const next = normalizeFeedRecord({ ...feed, order: (index + 1) * 1000, updatedAtMs: now });
    await requestToPromise(feeds.put(next));
  }
}

/**
 * @param {import('./models.js').FeedRecord[]} records
 * @param {string} id
 */
function orderOf(records, id) {
  return records.findIndex((feed) => feed.id === id);
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
 * @template {Record<string, unknown>} T
 * @param {T | undefined} record
 * @returns {T | null}
 */
function detach(record) {
  return record ? /** @type {T} */ ({ ...record }) : null;
}
