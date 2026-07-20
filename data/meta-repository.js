// @ts-check

import { normalizeCategoryRecord, normalizeStatsRecord } from './models.js';
import { STORES } from './constants.js';
import { validationError } from './validators.js';

export const META_KEYS = Object.freeze({
  DATA_REVISION: 'dataRevision',
  DEFAULT_CATEGORY_ID: 'defaultCategoryId',
  INTEGRITY_DIAGNOSE: 'integrityDiagnose',
  INTEGRITY_REPAIR: 'integrityRepair',
  LAST_MAINTENANCE_AT_MS: 'lastMaintenanceAtMs',
  POST_MIGRATION: 'postMigration',
  STATS_REBUILD: 'statsRebuild',
  STATS_REBUILD_REQUIRED: 'statsRebuildRequired',
  STATS_SCHEMA_VERSION: 'statsSchemaVersion',
});

const DEFAULT_CATEGORY_ORDER = 0;
const GLOBAL_STATS_ID = 'global';

/**
 * @typedef {object} SeedOptions
 * @property {() => number} [now]
 * @property {() => string} [idFactory]
 * @property {string} [defaultCategoryTitle]
 * @property {'strict' | 'default' | 'relaxed'} [durability]
 */

/**
 * @param {IDBDatabase} database
 * @param {SeedOptions} [options]
 * @returns {Promise<void>}
 */
export async function ensureSeedData(database, options = {}) {
  const seed = buildSeedData(options);
  const transaction = database.transaction([STORES.META, STORES.CATEGORIES, STORES.STATS], 'readwrite', {
    durability: options.durability ?? 'strict',
  });
  const done = transactionToPromise(transaction);

  try {
    await seedMetaAndRecords(transaction, seed);
    await done;
  } catch (error) {
    abortTransaction(transaction);
    await settleAbort(done);
    throw error;
  }
}

/**
 * @param {IDBTransaction} transaction
 * @param {string} key
 * @returns {Promise<unknown>}
 */
export async function readMetaValue(transaction, key) {
  const record = await requestToPromise(transaction.objectStore(STORES.META).get(key));
  return record && typeof record === 'object' && 'value' in record ? record.value : undefined;
}

/**
 * @param {IDBTransaction} transaction
 * @returns {Promise<string>}
 */
export async function readDefaultCategoryId(transaction) {
  const value = await readMetaValue(transaction, META_KEYS.DEFAULT_CATEGORY_ID);
  if (typeof value === 'string' && value.trim().length > 0) return value;
  throw validationError('defaultCategoryId', 'must be a non-empty string');
}

/**
 * @param {IDBTransaction} transaction
 * @returns {Promise<number>}
 */
export async function readDataRevision(transaction) {
  const value = await readMetaValue(transaction, META_KEYS.DATA_REVISION);
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * @param {IDBObjectStore} meta
 * @returns {Promise<{dataRevision: number, revisionReset: boolean}>}
 */
export async function incrementDataRevision(meta) {
  const current = await readValueFromStore(meta, META_KEYS.DATA_REVISION);
  const revisionReset = typeof current === 'number' && current >= Number.MAX_SAFE_INTEGER;
  const dataRevision =
    typeof current === 'number' && Number.isSafeInteger(current) && current >= 0 && !revisionReset ? current + 1 : 1;
  await putMetaValue(meta, META_KEYS.DATA_REVISION, dataRevision);
  return { dataRevision, revisionReset };
}

/**
 * @param {IDBTransaction} transaction
 * @param {string} key
 * @param {unknown} value
 */
export async function writeMetaValue(transaction, key, value) {
  await putMetaValue(transaction.objectStore(STORES.META), key, value);
}

/**
 * @param {SeedOptions} options
 */
function buildSeedData(options) {
  const now = options.now ? options.now() : Date.now();
  const categoryTitle = options.defaultCategoryTitle ?? 'Uncategorized';
  const categoryId = options.idFactory ? options.idFactory() : `cat_${crypto.randomUUID()}`;
  return {
    category: normalizeCategoryRecord({
      id: categoryId,
      title: categoryTitle,
      normalizedTitle: categoryTitle.toLowerCase(),
      order: DEFAULT_CATEGORY_ORDER,
      createdAtMs: now,
      updatedAtMs: now,
    }),
    stats: normalizeStatsRecord({
      id: GLOBAL_STATS_ID,
      scopeType: 'global',
      scopeId: '',
      articleCount: 0,
      unreadCount: 0,
      starredCount: 0,
      lastArticleAtMs: 0,
      updatedAtMs: now,
    }),
  };
}

/**
 * @param {IDBTransaction} transaction
 * @param {{category: import('./models.js').CategoryRecord, stats: import('./models.js').StatsRecord}} seed
 */
async function seedMetaAndRecords(transaction, seed) {
  const meta = transaction.objectStore(STORES.META);
  const categories = transaction.objectStore(STORES.CATEGORIES);
  const stats = transaction.objectStore(STORES.STATS);
  const defaultCategoryId = await readOrSeedDefaultCategoryId(meta, seed.category.id);
  await ensureDefaultCategory(categories, { ...seed.category, id: String(defaultCategoryId) });
  await putMetaDefault(meta, META_KEYS.DATA_REVISION, 0);
  await putMetaDefault(meta, META_KEYS.STATS_SCHEMA_VERSION, 1);
  await putMetaDefault(meta, META_KEYS.STATS_REBUILD, null);
  await putMetaDefault(meta, META_KEYS.STATS_REBUILD_REQUIRED, false);
  await putMetaDefault(meta, META_KEYS.POST_MIGRATION, null);
  await putMetaDefault(meta, META_KEYS.LAST_MAINTENANCE_AT_MS, 0);
  await putDefaultRecord(stats, seed.stats.id, seed.stats);
}

/**
 * @param {IDBObjectStore} meta
 * @param {string} fallbackId
 * @returns {Promise<unknown>}
 */
async function readOrSeedDefaultCategoryId(meta, fallbackId) {
  const stored = await readValueFromStore(meta, META_KEYS.DEFAULT_CATEGORY_ID);
  if (stored !== undefined) return stored;
  await putMetaValue(meta, META_KEYS.DEFAULT_CATEGORY_ID, fallbackId);
  return fallbackId;
}

/**
 * @param {IDBObjectStore} categories
 * @param {import('./models.js').CategoryRecord} category
 */
async function ensureDefaultCategory(categories, category) {
  const existing = await requestToPromise(categories.get(category.id));
  if (!existing) await requestToPromise(categories.put(category));
}

/**
 * @param {IDBObjectStore} store
 * @param {IDBValidKey} key
 * @param {unknown} record
 */
async function putDefaultRecord(store, key, record) {
  const existing = await requestToPromise(store.get(key));
  if (!existing) await requestToPromise(store.put(record));
}

/**
 * @param {IDBObjectStore} meta
 * @param {string} key
 * @param {unknown} value
 */
async function putMetaDefault(meta, key, value) {
  const stored = await readValueFromStore(meta, key);
  if (stored === undefined) await putMetaValue(meta, key, value);
}

/**
 * @param {IDBObjectStore} meta
 * @param {string} key
 * @returns {Promise<unknown>}
 */
async function readValueFromStore(meta, key) {
  const record = await requestToPromise(meta.get(key));
  return record && typeof record === 'object' && 'value' in record ? record.value : undefined;
}

/**
 * @param {IDBObjectStore} meta
 * @param {string} key
 * @param {unknown} value
 */
async function putMetaValue(meta, key, value) {
  await requestToPromise(meta.put({ key, value }));
}

/**
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * @param {IDBTransaction} transaction
 * @returns {Promise<void>}
 */
function transactionToPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

/**
 * @param {IDBTransaction} transaction
 */
function abortTransaction(transaction) {
  try {
    transaction.abort();
  } catch (error) {
    if (!isExpectedInactiveTransactionError(error)) throw error;
    // The transaction may already be inactive after an IndexedDB request failure.
  }
}

/**
 * @param {Promise<void>} done
 */
async function settleAbort(done) {
  try {
    await done;
  } catch (error) {
    if (!isExpectedTransactionSettlementError(error)) throw error;
    // The caller receives the original failure from the seed operation.
  }
}

/**
 * @param {unknown} error
 */
function isExpectedInactiveTransactionError(error) {
  return error instanceof DOMException && error.name === 'InvalidStateError';
}

/**
 * @param {unknown} error
 */
function isExpectedTransactionSettlementError(error) {
  return (
    error === null ||
    (error instanceof DOMException &&
      ['AbortError', 'ConstraintError', 'InvalidStateError', 'QuotaExceededError', 'TransactionInactiveError'].includes(
        error.name,
      ))
  );
}
