// @ts-check

import { ERROR_CODES, createAppError } from '../domain/errors.js';
import { normalizeFeedUrl, originPatternForUrl } from '../domain/urls.js';
import { DELETION_STATE, LEASE_STATE, PERMISSION_STATE, SCHEDULE_STATE, STATE, STORES } from './constants.js';
import { META_KEYS, readMetaValue } from './meta-repository.js';
import { normalizeFeedRecord, normalizeStatsRecord } from './models.js';
import { requestToPromise, runMutation } from './transaction.js';
import { validationError } from './validators.js';

/**
 * @typedef {import('./transaction.js').TransactionOptions} RepositoryOptions
 */

/**
 * @param {unknown} input
 * @param {RepositoryOptions} options
 */
export async function addSubscription(input, options) {
  const subscription = normalizeSubscriptionInput(input);
  return runMutation(
    [STORES.META, STORES.CATEGORIES, STORES.FEEDS, STORES.STATS],
    async (context) => {
      const categories = context.transaction.objectStore(STORES.CATEGORIES);
      const feeds = context.transaction.objectStore(STORES.FEEDS);
      const stats = context.transaction.objectStore(STORES.STATS);
      const categoryId = subscription.categoryId || String(await readMetaValue(context.transaction, META_KEYS.DEFAULT_CATEGORY_ID));
      if (!(await requestToPromise(categories.get(categoryId)))) {
        throw createAppError(ERROR_CODES.CATEGORY_NOT_FOUND, { details: { categoryId } });
      }
      const duplicate = await requestToPromise(feeds.index('byNormalizedUrl').get(subscription.normalizedUrl));
      if (duplicate) throw createAppError(ERROR_CODES.FEED_ALREADY_EXISTS, { details: { feedId: duplicate.id } });
      const feed = buildFeedRecord(subscription, categoryId, await nextOrder(feeds, categoryId), context.now());
      await requestToPromise(feeds.put(feed));
      await requestToPromise(stats.put(zeroFeedStats(feed.id, context.now())));
      await context.markChanged({
        entities: ['feeds', 'stats'],
        feedIds: [feed.id],
        categoryIds: [feed.categoryId],
        scopes: [`feed:${feed.id}`],
        reason: 'feed-add',
      });
      return { feed: detach(feed) };
    },
    { ...options, durability: 'strict' },
  );
}

/**
 * @param {{url: string, normalizedUrl: string, title: string, customTitle?: string, permissionOrigin: string}} subscription
 * @param {string} categoryId
 * @param {number} order
 * @param {number} now
 */
function buildFeedRecord(subscription, categoryId, order, now) {
  return normalizeFeedRecord({
    id: `feed_${crypto.randomUUID()}`,
    title: subscription.title,
    customTitle: subscription.customTitle ?? '',
    url: subscription.url,
    normalizedUrl: subscription.normalizedUrl,
    resolvedUrl: '',
    siteUrl: '',
    iconUrl: null,
    categoryId,
    mainStreamState: STATE.ON,
    order,
    permissionOrigin: subscription.permissionOrigin,
    permissionState: PERMISSION_STATE.GRANTED,
    redirectOriginPending: '',
    redirectUrlPending: '',
    scheduleState: SCHEDULE_STATE.ENABLED,
    etag: '',
    lastModified: '',
    lastCheckedAtMs: 0,
    lastSuccessAtMs: 0,
    nextFetchAtMs: now,
    consecutiveFailures: 0,
    lastHttpStatus: 0,
    lastErrorCode: '',
    lastErrorMessage: '',
    leaseState: LEASE_STATE.FREE,
    leaseOwner: '',
    leaseExpiresAtMs: 0,
    deletionState: DELETION_STATE.ACTIVE,
    createdAtMs: now,
    updatedAtMs: now,
  });
}

/**
 * @param {unknown} input
 */
function normalizeSubscriptionInput(input) {
  if (typeof input !== 'object' || input === null || Object.getPrototypeOf(input) !== Object.prototype) {
    throw validationError('feed', 'must be a plain object');
  }
  const record = /** @type {Record<string, unknown>} */ (input);
  const url = requiredString(record, 'url', 8192);
  const title = requiredString(record, 'title', 2048).trim();
  if (title.length === 0) throw validationError('title', 'must not be empty');
  const categoryId = optionalString(record, 'categoryId', 128);
  const customTitle = optionalString(record, 'customTitle', 2048).trim();
  const normalizedUrl = normalizeFeedUrl(url);
  return {
    url: normalizedUrl,
    normalizedUrl,
    title,
    customTitle,
    categoryId,
    permissionOrigin: originPatternForUrl(normalizedUrl),
  };
}

/**
 * @param {IDBObjectStore} feeds
 * @param {string} categoryId
 */
async function nextOrder(feeds, categoryId) {
  const records = await requestToPromise(feeds.getAll());
  const orders = records.filter((feed) => feed.categoryId === categoryId).map((feed) => feed.order);
  return orders.length === 0 ? 1000 : Math.max(...orders) + 1000;
}

/**
 * @param {Record<string, unknown>} record
 * @param {string} field
 * @param {number} maxCodePoints
 */
function requiredString(record, field, maxCodePoints) {
  const value = record[field];
  if (typeof value !== 'string') throw validationError(field, 'must be a string');
  if ([...value].length > maxCodePoints) throw validationError(field, 'exceeds code point limit');
  return value;
}

/**
 * @param {Record<string, unknown>} record
 * @param {string} field
 * @param {number} maxCodePoints
 */
function optionalString(record, field, maxCodePoints) {
  if (!(field in record)) return '';
  const value = record[field];
  if (typeof value !== 'string') throw validationError(field, 'must be a string');
  if ([...value].length > maxCodePoints) throw validationError(field, 'exceeds code point limit');
  return value;
}

/**
 * @param {string} feedId
 * @param {number} now
 */
function zeroFeedStats(feedId, now) {
  return normalizeStatsRecord({
    id: `feed:${feedId}`,
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
 * @param {T} record
 * @returns {T}
 */
function detach(record) {
  return /** @type {T} */ ({ ...record });
}
