// @ts-check

import { AppError, createAppError, ERROR_CODES, mapDomException } from '../domain/errors.js';
import { openDatabase } from './db.js';
import { STORES } from './constants.js';
import { incrementDataRevision, readDataRevision } from './meta-repository.js';
import { isValidDataChangeArticleIds } from '../shared/messages.js';

/** @type {readonly string[]} */
const EXPECTED_ABORT_SETTLEMENT_CODES = Object.freeze([
  ERROR_CODES.DB_CONSTRAINT,
  ERROR_CODES.DB_INVALID_STATE,
  ERROR_CODES.DB_QUOTA_EXCEEDED,
  ERROR_CODES.DB_SCHEMA_MISMATCH,
  ERROR_CODES.DB_TRANSACTION_ABORTED,
  ERROR_CODES.DB_TRANSACTION_INACTIVE,
  ERROR_CODES.DB_UNKNOWN,
  ERROR_CODES.DB_VERSION_ERROR,
]);

/**
 * @typedef {object} TransactionOptions
 * @property {import('./db.js').OpenDatabaseOptions['indexedDbFactory']} [indexedDbFactory]
 * @property {string} [databaseName]
 * @property {number} [version]
 * @property {'strict' | 'default' | 'relaxed'} [durability]
 * @property {() => number} [now]
 * @property {() => string} [idFactory]
 * @property {string} [defaultCategoryTitle]
 * @property {(error: AppError) => void} [onBlocked]
 * @property {(state: import('./db.js').ReloadRequiredState) => void} [onReloadRequired]
 */

/**
 * @typedef {object} ChangeInput
 * @property {string[]} [articleIds]
 * @property {string[]} [entities]
 * @property {string[]} [feedIds]
 * @property {string[]} [categoryIds]
 * @property {string[]} [scopes]
 * @property {string} [reason]
 *
 * @typedef {object} MutationContext
 * @property {IDBTransaction} transaction
 * @property {() => number} now
 * @property {boolean} changed
 * @property {number | null} dataRevision
 * @property {boolean} revisionReset
 * @property {(change: ChangeInput) => Promise<number>} markChanged
 * @property {() => ChangeInput & {revisionReset?: boolean}} changeSnapshot
 *
 * @typedef {TransactionOptions & {change?: ChangeInput}} MutationOptions
 *
 * @typedef {object} MutationResultBase
 * @property {boolean} changed
 * @property {number} dataRevision
 * @property {(ChangeInput & {revisionReset?: boolean}) | null} change
 */

/**
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
export function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(mapRequestError(request.error));
  });
}

/**
 * @param {IDBTransaction} transaction
 * @returns {Promise<void>}
 */
export function transactionToPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(mapTransactionError(transaction.error));
    transaction.onerror = () => reject(mapTransactionError(transaction.error));
  });
}

/**
 * @template T
 * @param {string | string[]} storeNames
 * @param {IDBTransactionMode} mode
 * @param {(transaction: IDBTransaction) => Promise<T> | T} work
 * @param {TransactionOptions} [options]
 * @returns {Promise<T>}
 */
export async function runTransaction(storeNames, mode, work, options = {}) {
  const database = await openDatabase(options);
  const transaction = createTransaction(database, storeNames, mode, options.durability ?? 'default');
  const done = transactionToPromise(transaction);

  try {
    const result = await work(transaction);
    await done;
    return result;
  } catch (error) {
    abortTransaction(transaction);
    await settleAbort(done);
    throw mapCaughtError(error);
  }
}

/**
 * @template {Record<string, unknown>} T
 * @param {string | string[]} storeNames
 * @param {(context: MutationContext) => Promise<T> | T} work
 * @param {MutationOptions} [options]
 * @returns {Promise<T & MutationResultBase>}
 */
export async function runMutation(storeNames, work, options = {}) {
  return runTransaction(
    withMetaStore(storeNames),
    'readwrite',
    async (transaction) => {
      const context = createMutationContext(transaction, options);
      const data = await work(context);
      const dataRevision = context.changed ? Number(context.dataRevision) : await readDataRevision(transaction);
      return {
        ...data,
        changed: context.changed,
        dataRevision,
        change: context.changed ? context.changeSnapshot() : null,
      };
    },
    { ...options, durability: options.durability ?? 'default' },
  );
}

/**
 * @param {IDBDatabase} database
 * @param {string | string[]} storeNames
 * @param {IDBTransactionMode} mode
 * @param {'strict' | 'default' | 'relaxed'} durability
 */
function createTransaction(database, storeNames, mode, durability) {
  try {
    return database.transaction(storeNames, mode, { durability });
  } catch (error) {
    throw mapCaughtError(error);
  }
}

/**
 * @param {IDBTransaction} transaction
 * @param {MutationOptions} options
 * @returns {MutationContext}
 */
function createMutationContext(transaction, options) {
  const change = createChangeAccumulator(options.change);
  let changed = false;
  /** @type {number | null} */
  let dataRevision = null;
  let revisionReset = false;
  return {
    transaction,
    now: options.now ?? Date.now,
    get changed() {
      return changed;
    },
    get dataRevision() {
      return dataRevision;
    },
    get revisionReset() {
      return revisionReset;
    },
    async markChanged(nextChange) {
      mergeChange(change, nextChange);
      if (!changed) {
        const nextRevision = await incrementDataRevision(transaction.objectStore(STORES.META));
        dataRevision = nextRevision.dataRevision;
        revisionReset = nextRevision.revisionReset;
        changed = true;
      }
      return Number(dataRevision);
    },
    changeSnapshot() {
      return snapshotChange(change, revisionReset);
    },
  };
}

/**
 * @param {string | string[]} storeNames
 * @returns {string[]}
 */
function withMetaStore(storeNames) {
  const names = Array.isArray(storeNames) ? [...storeNames] : [storeNames];
  if (!names.includes(STORES.META)) names.push(STORES.META);
  return names;
}

/**
 * @param {ChangeInput | undefined} initial
 */
function createChangeAccumulator(initial) {
  const change = {
    articleIds: new Set(),
    entities: new Set(),
    feedIds: new Set(),
    categoryIds: new Set(),
    scopes: new Set(),
    reason: '',
  };
  if (initial) mergeChange(change, initial);
  return change;
}

/**
 * @param {{articleIds: Set<string>, entities: Set<string>, feedIds: Set<string>, categoryIds: Set<string>, scopes: Set<string>, reason: string}} target
 * @param {ChangeInput} source
 */
function mergeChange(target, source) {
  for (const item of source.articleIds ?? []) target.articleIds.add(item);
  for (const item of source.entities ?? []) target.entities.add(item);
  for (const item of source.feedIds ?? []) target.feedIds.add(item);
  for (const item of source.categoryIds ?? []) target.categoryIds.add(item);
  for (const item of source.scopes ?? []) target.scopes.add(item);
  if (source.reason) target.reason = source.reason;
}

/**
 * @param {{articleIds: Set<string>, entities: Set<string>, feedIds: Set<string>, categoryIds: Set<string>, scopes: Set<string>, reason: string}} change
 * @param {boolean} revisionReset
 */
function snapshotChange(change, revisionReset) {
  const articleIds = [...change.articleIds];
  if (!isValidDataChangeArticleIds(articleIds, change.reason)) {
    throw createAppError(ERROR_CODES.VALIDATION_ERROR, {
      details: { field: 'articleIds', reason: 'invalid data-change identity metadata' },
    });
  }
  return {
    articleIds,
    entities: [...change.entities],
    feedIds: [...change.feedIds],
    categoryIds: [...change.categoryIds],
    scopes: [...change.scopes],
    reason: change.reason,
    ...(revisionReset ? { revisionReset } : {}),
  };
}

/**
 * @param {IDBTransaction} transaction
 */
function abortTransaction(transaction) {
  try {
    transaction.abort();
  } catch (error) {
    if (!isDomExceptionNamed(error, 'InvalidStateError')) throw error;
  }
}

/**
 * @param {Promise<void>} done
 */
async function settleAbort(done) {
  try {
    await done;
  } catch (error) {
    if (!isExpectedAbortSettlementError(error)) throw error;
    // The work failure is the caller-visible cause; abort errors only finish rollback.
  }
}

/**
 * @param {DOMException | null} error
 * @returns {AppError}
 */
function mapRequestError(error) {
  return error ? mapDomException(error) : createAppError(ERROR_CODES.DB_UNKNOWN);
}

/**
 * @param {DOMException | null} error
 * @returns {AppError}
 */
function mapTransactionError(error) {
  return error ? mapDomException(error) : createAppError(ERROR_CODES.DB_TRANSACTION_ABORTED);
}

/**
 * @param {unknown} error
 */
function mapCaughtError(error) {
  if (error instanceof AppError) return error;
  if (error instanceof DOMException) return mapDomException(error);
  return error;
}

/**
 * @param {unknown} error
 * @param {string} name
 */
function isDomExceptionNamed(error, name) {
  return error instanceof DOMException && error.name === name;
}

/**
 * @param {unknown} error
 */
function isExpectedAbortSettlementError(error) {
  return error instanceof AppError && EXPECTED_ABORT_SETTLEMENT_CODES.includes(error.code);
}
