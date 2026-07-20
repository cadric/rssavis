// @ts-check

import { createAppError, ERROR_CODES } from '../domain/errors.js';
import { createPrefixedId } from '../domain/ids.js';
import { normalizeOpmlImportModel } from '../domain/opml-import-model.js';
import { normalizePlainText } from '../domain/text.js';
import { normalizeFeedUrl } from '../domain/urls.js';
import { DELETION_STATE, PERMISSION_STATE, SCHEDULE_STATE, STATE, STORES } from './constants.js';
import { META_KEYS, readMetaValue } from './meta-repository.js';
import { normalizeCategoryRecord, normalizeFeedRecord } from './models.js';
import { exportSubscriptions } from './opml-export.js';
import { enqueueOpmlRefreshJob } from './opml-refresh-jobs.js';
import { zeroFeedStats } from './feed-repository.js';
import { requestToPromise, runMutation, runTransaction } from './transaction.js';

const ORDER_STEP = 1000;
/**
 * @typedef {import('./transaction.js').TransactionOptions} RepositoryOptions
 *
 * @typedef {object} OpmlImportFeed
 * @property {string} categoryTitle
 * @property {string} htmlUrl
 * @property {string} normalizedUrl
 * @property {string} originPattern
 * @property {number} sourceOrder
 * @property {string} title
 * @property {'rss' | 'atom' | null} type
 * @property {string} xmlUrl
 *
 * @typedef {object} OpmlImportModel
 * @property {1} version
 * @property {readonly string[]} originPatterns
 * @property {readonly OpmlImportFeed[]} feeds
 */

/**
 * @param {RepositoryOptions} options
 */
export function createOpmlRepository(options = {}) {
  return {
    /**
     * @param {string[]} normalizedUrls
     */
    findExistingNormalizedUrls: (normalizedUrls) => findExistingNormalizedUrls(normalizedUrls, options),
    /**
     * @param {unknown} importModel
     */
    commitImport: (importModel) => commitImport(importModel, options),
    exportSubscriptions: () => exportSubscriptions(options),
  };
}

/**
 * @param {string[]} normalizedUrls
 * @param {RepositoryOptions} options
 * @returns {Promise<Set<string>>}
 */
async function findExistingNormalizedUrls(normalizedUrls, options) {
  const unique = [...new Set(normalizedUrls.map((url) => normalizeFeedUrl(url)))];
  return runTransaction(
    STORES.FEEDS,
    'readonly',
    async (transaction) => {
      const index = transaction.objectStore(STORES.FEEDS).index('byNormalizedUrl');
      const existing = new Set();
      for (const url of unique) {
        if (await requestToPromise(index.get(url))) existing.add(url);
      }
      return existing;
    },
    options,
  );
}

/**
 * @param {unknown} input
 * @param {RepositoryOptions} options
 */
async function commitImport(input, options) {
  const plan = prepareImportPlan(input);
  if (plan.feeds.length === 0) {
    return emptyImportResult(plan.duplicateInPayloadCount, await readCurrentRevision(options));
  }
  return runMutation(
    [STORES.CATEGORIES, STORES.FEEDS, STORES.STATS],
    async (context) => {
      const categories = context.transaction.objectStore(STORES.CATEGORIES);
      const feeds = context.transaction.objectStore(STORES.FEEDS);
      const stats = context.transaction.objectStore(STORES.STATS);
      const defaultCategoryId = String(await readMetaValue(context.transaction, META_KEYS.DEFAULT_CATEGORY_ID));
      const existingCategories = await requestToPromise(categories.index('byOrder').getAll());
      const existingFeeds = await requestToPromise(feeds.index('byCategoryOrder').getAll());
      const categoryMap = categoryMapByTitle(existingCategories);
      const orderState = feedOrderState(existingFeeds);
      const categoryPlans = categoryPlansByTitle(plan);
      const imported = [];
      let skippedExistingCount = 0;

      for (const feedPlan of plan.feeds) {
        if (await requestToPromise(feeds.index('byNormalizedUrl').get(feedPlan.normalizedUrl))) {
          skippedExistingCount += 1;
          continue;
        }
        const categoryId = await ensureImportCategory({
          categories,
          categoryMap,
          categoryPlans,
          defaultCategoryId,
          existingCategories,
          feedPlan,
          now: context.now(),
        });
        const order = nextFeedOrder(orderState, categoryId);
        const feed = normalizeFeedRecord({
          categoryId,
          consecutiveFailures: 0,
          createdAtMs: context.now(),
          deletionState: DELETION_STATE.ACTIVE,
          etag: '',
          iconUrl: null,
          id: feedPlan.id,
          lastCheckedAtMs: 0,
          lastErrorCode: '',
          lastErrorMessage: '',
          lastHttpStatus: 0,
          lastModified: '',
          lastSuccessAtMs: 0,
          leaseExpiresAtMs: 0,
          leaseOwner: '',
          leaseState: 0,
          mainStreamState: STATE.ON,
          nextFetchAtMs: context.now(),
          normalizedUrl: feedPlan.normalizedUrl,
          order,
          permissionOrigin: feedPlan.originPattern,
          permissionState: PERMISSION_STATE.GRANTED,
          redirectOriginPending: '',
          redirectUrlPending: '',
          resolvedUrl: '',
          scheduleState: SCHEDULE_STATE.ENABLED,
          siteUrl: feedPlan.htmlUrl,
          title: feedPlan.title,
          updatedAtMs: context.now(),
          url: feedPlan.normalizedUrl,
        });
        await requestToPromise(feeds.put(feed));
        await requestToPromise(stats.put(zeroFeedStats(feed.id, context.now())));
        imported.push(feed);
      }

      if (imported.length > 0) {
        await context.markChanged({
          categoryIds: [...new Set(imported.map((feed) => feed.categoryId))],
          entities: ['categories', 'feeds', 'stats'],
          feedIds: imported.map((feed) => feed.id),
          reason: 'opml-import',
          scopes: imported.map((feed) => `feed:${feed.id}`),
        });
      }
      const refreshJob = await enqueueOpmlRefreshJob(
        context.transaction,
        imported.map((feed) => feed.id),
        context.now(),
      );
      return {
        categoryIds: [...new Set(imported.map((feed) => feed.categoryId))],
        duplicateInPayloadCount: plan.duplicateInPayloadCount,
        importedCount: imported.length,
        importedFeedIds: imported.map((feed) => feed.id),
        ...refreshJob,
        skippedExistingCount,
      };
    },
    { ...options, durability: 'strict' },
  );
}

/**
 * @param {unknown} input
 */
function prepareImportPlan(input) {
  const model = normalizeImportModel(input);
  const seen = new Set();
  const feeds = [];
  let duplicateInPayloadCount = 0;
  for (const feed of model.feeds.toSorted((left, right) => left.sourceOrder - right.sourceOrder)) {
    if (seen.has(feed.normalizedUrl)) {
      duplicateInPayloadCount += 1;
      continue;
    }
    seen.add(feed.normalizedUrl);
    feeds.push({ ...feed, id: createPrefixedId('feed') });
  }
  return { duplicateInPayloadCount, feeds };
}

/**
 * @param {unknown} input
 * @returns {OpmlImportModel}
 */
function normalizeImportModel(input) {
  return normalizeOpmlImportModel(input);
}

/**
 * @param {import('./models.js').CategoryRecord[]} categories
 */
function categoryMapByTitle(categories) {
  return new Map(categories.map((category) => [category.normalizedTitle, category]));
}

/**
 * @param {{feeds: Array<OpmlImportFeed & {id: string}>}} plan
 */
function categoryPlansByTitle(plan) {
  const plans = new Map();
  for (const feed of plan.feeds) {
    if (!feed.categoryTitle) continue;
    const normalizedTitle = normalizeCategoryTitle(feed.categoryTitle);
    if (!plans.has(normalizedTitle)) {
      plans.set(normalizedTitle, { id: createPrefixedId('cat'), normalizedTitle, title: feed.categoryTitle });
    }
  }
  return plans;
}

/**
 * @param {object} input
 * @param {IDBObjectStore} input.categories
 * @param {Map<string, import('./models.js').CategoryRecord>} input.categoryMap
 * @param {Map<string, {id: string, normalizedTitle: string, title: string}>} input.categoryPlans
 * @param {string} input.defaultCategoryId
 * @param {import('./models.js').CategoryRecord[]} input.existingCategories
 * @param {OpmlImportFeed & {id: string}} input.feedPlan
 * @param {number} input.now
 */
async function ensureImportCategory(input) {
  if (!input.feedPlan.categoryTitle) return input.defaultCategoryId;
  const normalizedTitle = normalizeCategoryTitle(input.feedPlan.categoryTitle);
  const existing = input.categoryMap.get(normalizedTitle);
  if (existing) return existing.id;
  const plan = input.categoryPlans.get(normalizedTitle);
  if (!plan) return input.defaultCategoryId;
  const order = nextCategoryOrder(input.existingCategories);
  const category = normalizeCategoryRecord({
    createdAtMs: input.now,
    id: plan.id,
    normalizedTitle: plan.normalizedTitle,
    order,
    title: plan.title,
    updatedAtMs: input.now,
  });
  await requestToPromise(input.categories.put(category));
  input.existingCategories.push(category);
  input.categoryMap.set(category.normalizedTitle, category);
  return category.id;
}

/**
 * @param {import('./models.js').FeedRecord[]} feeds
 */
function feedOrderState(feeds) {
  const state = new Map();
  for (const feed of feeds) state.set(feed.categoryId, Math.max(state.get(feed.categoryId) ?? 0, feed.order));
  return state;
}

/**
 * @param {Map<string, number>} state
 * @param {string} categoryId
 */
function nextFeedOrder(state, categoryId) {
  const next = (state.get(categoryId) ?? 0) + ORDER_STEP;
  state.set(categoryId, next);
  return next;
}

/**
 * @param {import('./models.js').CategoryRecord[]} categories
 */
function nextCategoryOrder(categories) {
  return (categories.length ? Math.max(...categories.map((category) => category.order)) : 0) + ORDER_STEP;
}

/**
 * @param {RepositoryOptions} options
 */
async function readCurrentRevision(options) {
  return runTransaction(
    STORES.META,
    'readonly',
    async (transaction) => {
      const value = await readMetaValue(transaction, META_KEYS.DATA_REVISION);
      return typeof value === 'number' ? value : 0;
    },
    options,
  );
}

/**
 * @param {number} duplicateInPayloadCount
 * @param {number} dataRevision
 */
function emptyImportResult(duplicateInPayloadCount, dataRevision) {
  return {
    categoryIds: [],
    changed: false,
    change: null,
    dataRevision,
    duplicateInPayloadCount,
    importedCount: 0,
    importedFeedIds: [],
    queuedFeedCount: 0,
    refreshJobId: null,
    skippedExistingCount: 0,
  };
}

/**
 * @param {string} title
 */
function normalizeCategoryTitle(title) {
  return normalizePlainText(title, { maxCodePoints: 200 }).toLowerCase();
}
