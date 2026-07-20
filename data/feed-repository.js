// @ts-check

import { createAppError, ERROR_CODES } from '../domain/errors.js';
import { DELETION_STATE, LEASE_STATE, PERMISSION_STATE, SCHEDULE_STATE, STORES } from './constants.js';
import {
  listDeletePending as listPendingFeedDeletion,
  moveFeedRelative,
  moveFeedToCategory,
  updateSubscription as updateFeedSubscription,
} from './feed-management-repository.js';
import { createFeedLeaseRepository } from './feed-lease-repository.js';
import { createFeedRefreshRepository } from './feed-refresh-repository.js';
import { createFeedScheduleRepository } from './feed-schedule-repository.js';
import { addSubscription as addFeedSubscription } from './feed-subscription.js';
import { normalizeFeedRecord, normalizeStatsRecord } from './models.js';
import { requestToPromise, runMutation, runTransaction } from './transaction.js';

/**
 * @typedef {import('./transaction.js').TransactionOptions} RepositoryOptions
 */

/**
 * @param {RepositoryOptions} options
 */
export function createFeedRepository(options = {}) {
  const refresh = createFeedRefreshRepository(options);
  const schedule = createFeedScheduleRepository(options);
  const leases = createFeedLeaseRepository(options);
  return {
    listWithStats: () => listWithStats(options),
    /**
     * @param {string} id
     */
    get: (id) => getFeed(id, options),
    /**
     * @param {string} normalizedUrl
     */
    findByNormalizedUrl: (normalizedUrl) => findByNormalizedUrl(normalizedUrl, options),
    /** @param {unknown} record */
    addPrepared: (record) => addPrepared(record, options),
    /** @param {unknown} input */
    addSubscription: (input) => addFeedSubscription(input, options),
    /**
     * @param {string} id
     * @param {Record<string, unknown>} patch
     */
    updateMetadata: (id, patch) => updateMetadata(id, patch, options),
    /**
     * @param {string} id
     * @param {Record<string, unknown>} patch
     */
    updateSubscription: (id, patch) => updateFeedSubscription(id, patch, options),
    /**
     * @param {string} id
     * @param {string} categoryId
     * @param {number} order
     */
    move: (id, categoryId, order) => moveFeed(id, categoryId, order, options),
    /** @type {(id: string, categoryId: string, direction: 'up' | 'down') => ReturnType<typeof moveFeedRelative>} */
    moveRelative: (id, categoryId, direction) => moveFeedRelative(id, categoryId, direction, options),
    /** @type {(id: string, categoryId: string) => ReturnType<typeof moveFeedToCategory>} */
    moveToCategory: (id, categoryId) => moveFeedToCategory(id, categoryId, options),
    /**
     * @param {string} origin
     * @param {number} state
     */
    setPermissionStateByOrigin: (origin, state) => setPermissionStateByOrigin(origin, state, options),
    /**
     * @param {string} id
     * @param {{permissionOrigin: string}} input
     */
    grantPermission: (id, input) => grantPermission(id, input, options),
    /** @param {string} id */
    markDeletePending: (id) => markDeletePending(id, options),
    /** @param {{limit?: number}} [input] */
    listDeletePending: (input = {}) => listPendingFeedDeletion(input, options),
    ...leases,
    ...refresh,
    ...schedule,
  };
}

/**
 * @param {RepositoryOptions} options
 */
async function listWithStats(options) {
  return runTransaction(
    [STORES.FEEDS, STORES.STATS],
    'readonly',
    async (transaction) => {
      const feeds = await requestToPromise(transaction.objectStore(STORES.FEEDS).index('byCategoryOrder').getAll());
      const stats = transaction.objectStore(STORES.STATS);
      const items = [];
      for (const feed of feeds) {
        items.push({
          feed: detach(feed),
          stats: detach(await requestToPromise(stats.get(feedStatsId(feed.id)))),
        });
      }
      return items;
    },
    options,
  );
}

/**
 * @param {string} id
 * @param {RepositoryOptions} options
 */
async function getFeed(id, options) {
  return runTransaction(
    STORES.FEEDS,
    'readonly',
    async (transaction) => {
      const feed = await requestToPromise(transaction.objectStore(STORES.FEEDS).get(id));
      return feed ? detach(feed) : null;
    },
    options,
  );
}

/**
 * @param {string} normalizedUrl
 * @param {RepositoryOptions} options
 */
async function findByNormalizedUrl(normalizedUrl, options) {
  return runTransaction(
    STORES.FEEDS,
    'readonly',
    async (transaction) => {
      const feed = await requestToPromise(
        transaction.objectStore(STORES.FEEDS).index('byNormalizedUrl').get(normalizedUrl),
      );
      return feed ? detach(feed) : null;
    },
    options,
  );
}

/**
 * @param {unknown} input
 * @param {RepositoryOptions} options
 */
async function addPrepared(input, options) {
  const prepared = normalizeFeedRecord(input);
  return runMutation(
    [STORES.CATEGORIES, STORES.FEEDS, STORES.STATS],
    async (context) => {
      const categories = context.transaction.objectStore(STORES.CATEGORIES);
      const feeds = context.transaction.objectStore(STORES.FEEDS);
      const stats = context.transaction.objectStore(STORES.STATS);
      if (!(await requestToPromise(categories.get(prepared.categoryId)))) {
        throw createAppError(ERROR_CODES.CATEGORY_NOT_FOUND, { details: { categoryId: prepared.categoryId } });
      }
      const duplicate = await requestToPromise(feeds.index('byNormalizedUrl').get(prepared.normalizedUrl));
      if (duplicate) return handleDuplicateFeed(duplicate, prepared);
      await requestToPromise(feeds.put(prepared));
      await requestToPromise(stats.put(zeroFeedStats(prepared.id, context.now())));
      await context.markChanged({
        entities: ['feeds', 'stats'],
        feedIds: [prepared.id],
        categoryIds: [prepared.categoryId],
        scopes: [`feed:${prepared.id}`],
        reason: 'feed-add',
      });
      return { feed: detach(prepared) };
    },
    { ...options, durability: 'strict' },
  );
}

/**
 * @param {import('./models.js').FeedRecord} duplicate
 * @param {import('./models.js').FeedRecord} prepared
 */
function handleDuplicateFeed(duplicate, prepared) {
  if (duplicate.id === prepared.id) return { feed: detach(duplicate) };
  throw createAppError(ERROR_CODES.FEED_ALREADY_EXISTS, { details: { feedId: duplicate.id } });
}

/**
 * @param {string} id
 * @param {Record<string, unknown>} patch
 * @param {RepositoryOptions} options
 */
async function updateMetadata(id, patch, options) {
  return runMutation(
    [STORES.FEEDS],
    async (context) => {
      const feeds = context.transaction.objectStore(STORES.FEEDS);
      const existing = await requireFeed(feeds, id);
      const next = normalizeFeedRecord({ ...existing, ...patch, id, updatedAtMs: context.now() });
      if (JSON.stringify(existing) === JSON.stringify(next)) return { feed: detach(existing) };
      await requestToPromise(feeds.put(next));
      await context.markChanged({
        entities: ['feeds'],
        feedIds: [id],
        categoryIds: [next.categoryId],
        reason: 'feed-update',
      });
      return { feed: detach(next) };
    },
    options,
  );
}

/**
 * @param {string} id
 * @param {string} categoryId
 * @param {number} order
 * @param {RepositoryOptions} options
 */
async function moveFeed(id, categoryId, order, options) {
  return runMutation(
    [STORES.CATEGORIES, STORES.FEEDS],
    async (context) => {
      const categories = context.transaction.objectStore(STORES.CATEGORIES);
      const feeds = context.transaction.objectStore(STORES.FEEDS);
      if (!(await requestToPromise(categories.get(categoryId)))) {
        throw createAppError(ERROR_CODES.CATEGORY_NOT_FOUND, { details: { categoryId } });
      }
      const existing = await requireFeed(feeds, id);
      if (existing.categoryId === categoryId && existing.order === order) return { feed: detach(existing) };
      const next = normalizeFeedRecord({ ...existing, categoryId, order, updatedAtMs: context.now() });
      await requestToPromise(feeds.put(next));
      await context.markChanged({
        entities: ['feeds'],
        feedIds: [id],
        categoryIds: [existing.categoryId, categoryId],
        reason: 'feed-move',
      });
      return { feed: detach(next) };
    },
    { ...options, durability: 'strict' },
  );
}

/**
 * @param {string} origin
 * @param {number} state
 * @param {RepositoryOptions} options
 */
async function setPermissionStateByOrigin(origin, state, options) {
  return runMutation(
    [STORES.FEEDS],
    async (context) => {
      const feeds = context.transaction.objectStore(STORES.FEEDS);
      const allFeeds = await requestToPromise(feeds.getAll());
      const changed = [];
      for (const feed of allFeeds.filter((item) => item.permissionOrigin === origin)) {
        const scheduleState = state === PERMISSION_STATE.GRANTED ? SCHEDULE_STATE.ENABLED : SCHEDULE_STATE.DISABLED;
        const leasePatch =
          state === PERMISSION_STATE.GRANTED
            ? {}
            : { leaseState: LEASE_STATE.FREE, leaseOwner: '', leaseExpiresAtMs: 0 };
        const next = normalizeFeedRecord({
          ...feed,
          permissionState: state,
          scheduleState,
          ...leasePatch,
          updatedAtMs: context.now(),
        });
        if (JSON.stringify(feed) === JSON.stringify(next)) continue;
        await requestToPromise(feeds.put(next));
        changed.push(next);
      }
      if (changed.length > 0) {
        await context.markChanged({
          entities: ['feeds'],
          feedIds: changed.map((feed) => feed.id),
          categoryIds: [...new Set(changed.map((feed) => feed.categoryId))],
          scopes: changed.map((feed) => `feed:${feed.id}`),
          reason: 'feed-permission-state',
        });
      }
      return { feedIds: changed.map((feed) => feed.id) };
    },
    options,
  );
}

/**
 * @param {string} id
 * @param {{permissionOrigin: string}} input
 * @param {RepositoryOptions} options
 */
async function grantPermission(id, input, options) {
  return runMutation(
    [STORES.FEEDS],
    async (context) => {
      const feeds = context.transaction.objectStore(STORES.FEEDS);
      const existing = await requireFeed(feeds, id);
      if (existing.permissionOrigin !== input.permissionOrigin) {
        throw createAppError(ERROR_CODES.VALIDATION_ERROR, {
          details: { field: 'permissionOrigin', reason: 'missing or stale permission origin' },
        });
      }
      const next = normalizeFeedRecord({
        ...existing,
        permissionState: PERMISSION_STATE.GRANTED,
        scheduleState: SCHEDULE_STATE.ENABLED,
        nextFetchAtMs: context.now(),
        leaseState: LEASE_STATE.FREE,
        leaseOwner: '',
        leaseExpiresAtMs: 0,
        updatedAtMs: context.now(),
      });
      await requestToPromise(feeds.put(next));
      await context.markChanged({
        entities: ['feeds'],
        feedIds: [id],
        categoryIds: [next.categoryId],
        scopes: [`feed:${id}`],
        reason: 'feed-permission-grant',
      });
      return { feed: detach(next) };
    },
    options,
  );
}

/**
 * @param {string} id
 * @param {RepositoryOptions} options
 */
async function markDeletePending(id, options) {
  return runMutation(
    [STORES.FEEDS],
    async (context) => {
      const feeds = context.transaction.objectStore(STORES.FEEDS);
      const existing = await requireFeed(feeds, id);
      if (existing.deletionState === DELETION_STATE.PENDING) return { feed: detach(existing) };
      const next = normalizeFeedRecord({
        ...existing,
        deletionState: DELETION_STATE.PENDING,
        scheduleState: SCHEDULE_STATE.DISABLED,
        leaseState: LEASE_STATE.FREE,
        leaseOwner: '',
        leaseExpiresAtMs: 0,
        updatedAtMs: context.now(),
      });
      await requestToPromise(feeds.put(next));
      await context.markChanged({
        entities: ['feeds'],
        feedIds: [id],
        categoryIds: [next.categoryId],
        reason: 'feed-delete-pending',
      });
      return { feed: detach(next) };
    },
    options,
  );
}

/**
 * @param {IDBObjectStore} feeds
 * @param {string} id
 * @returns {Promise<import('./models.js').FeedRecord>}
 */
export async function requireFeed(feeds, id) {
  const feed = await requestToPromise(feeds.get(id));
  if (!feed) throw createAppError(ERROR_CODES.FEED_NOT_FOUND, { details: { feedId: id } });
  return feed;
}

/**
 * @param {string} feedId
 */
export function feedStatsId(feedId) {
  return `feed:${feedId}`;
}

/**
 * @param {string} feedId
 * @param {number} now
 */
export function zeroFeedStats(feedId, now) {
  return normalizeStatsRecord({
    id: feedStatsId(feedId),
    scopeType: 'feed',
    scopeId: feedId,
    articleCount: 0,
    unreadCount: 0,
    starredCount: 0,
    lastArticleAtMs: 0,
    updatedAtMs: now,
  });
}

/**
 * @template {Record<string, unknown>} T
 * @param {T | undefined} record
 * @returns {T | null}
 */
function detach(record) {
  return record ? /** @type {T} */ ({ ...record }) : null;
}
