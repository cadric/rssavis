// @ts-check

import { createAppError, ERROR_CODES } from '../domain/errors.js';
import { normalizeCategoryRecord } from './models.js';
import { STORES } from './constants.js';
import { readDefaultCategoryId } from './meta-repository.js';
import { requestToPromise, runMutation, runTransaction } from './transaction.js';
import { validationError } from './validators.js';

const ORDER_STEP = 1000;

/**
 * @typedef {import('./transaction.js').TransactionOptions} RepositoryOptions
 */

/**
 * @param {RepositoryOptions} options
 */
export function createCategoryRepository(options = {}) {
  return {
    listOrdered: () => listOrdered(options),
    listOrderedWithDefaultCategoryId: () => listOrderedWithDefaultCategoryId(options),
    /**
     * @param {{title: string}} input
     */
    create: (input) => createCategory(input, options),
    /**
     * @param {string} id
     * @param {string} title
     */
    rename: (id, title) => renameCategory(id, title, options),
    /**
     * @param {string[]} ids
     */
    reorder: (ids) => reorderCategories(ids, options),
    /**
     * @param {string} id
     * @param {'up' | 'down'} direction
     */
    moveRelative: (id, direction) => moveCategoryRelative(id, direction, options),
    /**
     * @param {string} id
     */
    deleteAndMoveFeeds: (id) => deleteAndMoveFeeds(id, options),
  };
}

/**
 * @param {RepositoryOptions} options
 */
async function listOrdered(options) {
  return runTransaction(
    STORES.CATEGORIES,
    'readonly',
    async (transaction) => {
      const records = await requestToPromise(transaction.objectStore(STORES.CATEGORIES).index('byOrder').getAll());
      return records.map(detach);
    },
    options,
  );
}

/**
 * @param {RepositoryOptions} options
 */
async function listOrderedWithDefaultCategoryId(options) {
  return runTransaction(
    [STORES.CATEGORIES, STORES.META],
    'readonly',
    async (transaction) => ({
      categories: (await requestToPromise(transaction.objectStore(STORES.CATEGORIES).index('byOrder').getAll())).map(
        detach,
      ),
      defaultCategoryId: await readDefaultCategoryId(transaction),
    }),
    options,
  );
}

/**
 * @param {{title: string}} input
 * @param {RepositoryOptions} options
 */
async function createCategory(input, options) {
  return runMutation(
    [STORES.CATEGORIES],
    async (context) => {
      const store = context.transaction.objectStore(STORES.CATEGORIES);
      const category = normalizeCategoryRecord({
        id: options.idFactory ? options.idFactory() : `cat_${crypto.randomUUID()}`,
        title: input.title,
        order: await nextOrder(store),
        createdAtMs: context.now(),
        updatedAtMs: context.now(),
      });
      await requestToPromise(store.put(category));
      await context.markChanged({
        entities: ['categories'],
        categoryIds: [category.id],
        reason: 'category-create',
      });
      return { category: detach(category) };
    },
    { ...options, durability: 'strict' },
  );
}

/**
 * @param {string} id
 * @param {string} title
 * @param {RepositoryOptions} options
 */
async function renameCategory(id, title, options) {
  return runMutation(
    [STORES.CATEGORIES],
    async (context) => {
      const store = context.transaction.objectStore(STORES.CATEGORIES);
      const existing = await requireCategory(store, id);
      const next = normalizeCategoryRecord({ ...existing, title, updatedAtMs: context.now() });
      if (existing.title === next.title && existing.normalizedTitle === next.normalizedTitle) {
        return { category: detach(existing) };
      }
      await requestToPromise(store.put(next));
      await context.markChanged({ entities: ['categories'], categoryIds: [id], reason: 'category-rename' });
      return { category: detach(next) };
    },
    { ...options, durability: 'strict' },
  );
}

/**
 * @param {string[]} ids
 * @param {RepositoryOptions} options
 */
async function reorderCategories(ids, options) {
  return runMutation(
    [STORES.CATEGORIES],
    async (context) => {
      const store = context.transaction.objectStore(STORES.CATEGORIES);
      const records = [];
      for (const id of ids) records.push(await requireCategory(store, id));
      let changed = false;
      for (const [index, record] of records.entries()) {
        const order = (index + 1) * ORDER_STEP;
        if (record.order === order) continue;
        changed = true;
        await requestToPromise(store.put({ ...record, order, updatedAtMs: context.now() }));
      }
      if (changed)
        await context.markChanged({ entities: ['categories'], categoryIds: ids, reason: 'category-reorder' });
      return { categories: (await requestToPromise(store.index('byOrder').getAll())).map(detach) };
    },
    { ...options, durability: 'strict' },
  );
}

/**
 * @param {string} id
 * @param {'up' | 'down'} direction
 * @param {RepositoryOptions} options
 */
async function moveCategoryRelative(id, direction, options) {
  return runMutation(
    [STORES.CATEGORIES],
    async (context) => {
      const store = context.transaction.objectStore(STORES.CATEGORIES);
      const records = await requestToPromise(store.index('byOrder').getAll());
      const index = records.findIndex((record) => record.id === id);
      if (index < 0) throw createAppError(ERROR_CODES.CATEGORY_NOT_FOUND, { details: { categoryId: id } });
      const target = direction === 'up' ? index - 1 : index + 1;
      if (target < 0 || target >= records.length) return { categories: records.map(detach) };
      const next = records.slice();
      [next[index], next[target]] = [next[target], next[index]];
      await writeOrderedCategories(store, next, context.now());
      await context.markChanged({
        entities: ['categories'],
        categoryIds: next.map((category) => category.id),
        reason: 'category-reorder',
      });
      return { categories: (await requestToPromise(store.index('byOrder').getAll())).map(detach) };
    },
    { ...options, durability: 'strict' },
  );
}

/**
 * @param {string} id
 * @param {RepositoryOptions} options
 */
async function deleteAndMoveFeeds(id, options) {
  return runMutation(
    [STORES.CATEGORIES, STORES.FEEDS],
    async (context) => {
      const categories = context.transaction.objectStore(STORES.CATEGORIES);
      const feeds = context.transaction.objectStore(STORES.FEEDS);
      const defaultCategoryId = await readDefaultCategoryId(context.transaction);
      if (id === defaultCategoryId) throw validationError('categoryId', 'default category cannot be deleted');
      await requireCategory(categories, id);
      await requireCategory(categories, defaultCategoryId);
      const allFeeds = await requestToPromise(feeds.getAll());
      const moved = sortFeedsForCategoryDelete(allFeeds.filter((feed) => feed.categoryId === id));
      const fallbackFeeds = sortFeedsForCategoryDelete(
        allFeeds.filter((feed) => feed.categoryId === defaultCategoryId),
      );
      const nextFallbackFeeds = [...fallbackFeeds, ...moved];
      for (const [index, feed] of nextFallbackFeeds.entries()) {
        const order = (index + 1) * ORDER_STEP;
        if (feed.categoryId === defaultCategoryId && feed.order === order) continue;
        await requestToPromise(
          feeds.put({ ...feed, categoryId: defaultCategoryId, order, updatedAtMs: context.now() }),
        );
      }
      await requestToPromise(categories.delete(id));
      await context.markChanged({
        entities: ['categories', 'feeds'],
        categoryIds: [id, defaultCategoryId],
        feedIds: moved.map((feed) => feed.id),
        reason: 'category-delete',
      });
      return { movedFeedIds: moved.map((feed) => feed.id) };
    },
    { ...options, durability: 'strict' },
  );
}

/**
 * @param {Array<import('./models.js').FeedRecord>} feeds
 */
function sortFeedsForCategoryDelete(feeds) {
  return [...feeds].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

/**
 * @param {IDBObjectStore} store
 * @param {import('./models.js').CategoryRecord[]} records
 * @param {number} now
 */
async function writeOrderedCategories(store, records, now) {
  for (const [index, record] of records.entries()) {
    await requestToPromise(store.put({ ...record, order: (index + 1) * ORDER_STEP, updatedAtMs: now }));
  }
}

/**
 * @param {IDBObjectStore} store
 */
async function nextOrder(store) {
  const records = await requestToPromise(store.index('byOrder').getAll());
  return records.length === 0 ? ORDER_STEP : Math.max(...records.map((record) => record.order)) + ORDER_STEP;
}

/**
 * @param {IDBObjectStore} store
 * @param {string} id
 * @returns {Promise<import('./models.js').CategoryRecord>}
 */
async function requireCategory(store, id) {
  const category = await requestToPromise(store.get(id));
  if (!category) throw createAppError(ERROR_CODES.CATEGORY_NOT_FOUND, { details: { categoryId: id } });
  return category;
}

/**
 * @template {Record<string, unknown>} T
 * @param {T} record
 * @returns {T}
 */
function detach(record) {
  return /** @type {T} */ ({ ...record });
}
