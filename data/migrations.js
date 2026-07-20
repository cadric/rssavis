// @ts-check

import { STORES } from './constants.js';
import { META_KEYS } from './meta-repository.js';
import { createAppError, ERROR_CODES } from '../domain/errors.js';
import { DEFAULT_POST_MIGRATIONS } from './post-migrations.js';

export const POST_MIGRATION_BATCH_SIZE = 250;
const POST_MIGRATION_SCHEMA_VERSION = 1;
const POST_MIGRATION_TERMINAL_ID = '__rssavis_post_migrations_complete__';

/**
 * @typedef {object} PostMigrationState
 * @property {string} id
 * @property {unknown} cursor
 * @property {boolean} completed
 * @property {readonly string[]} [completedIds]
 * @typedef {object} PostMigrationResult
 * @property {boolean} completed
 * @property {number} processed
 * @typedef {object} PostMigrationStepResult
 * @property {unknown} cursor
 * @property {boolean} completed
 * @property {number} processed
 * @typedef {object} PostMigrationDefinition
 * @property {string} id
 * @property {readonly string[]} [stores]
 * @property {(input: {transaction: IDBTransaction, state: PostMigrationState, batchSize: number}) => Promise<PostMigrationStepResult> | PostMigrationStepResult} run
 * @typedef {object} RunPostMigrationOptions
 * @property {readonly PostMigrationDefinition[]} [migrations]
 * @property {number} [batchSize]
 * @property {'strict' | 'default' | 'relaxed'} [durability]
 * @property {IDBDatabase} [database]
 */

/**
 * @param {string} id
 * @returns {PostMigrationState}
 */
export function createPostMigrationState(id) {
  return {
    id,
    cursor: null,
    completed: false,
  };
}

/**
 * @param {RunPostMigrationOptions | unknown} [options]
 * @returns {Promise<PostMigrationResult>}
 */
export async function runPostMigrations(options) {
  if (isRecord(options) && isDatabaseLike(options.database)) {
    return runPostMigrationsForDatabase(options.database, options);
  }
  return { completed: true, processed: 0 };
}

/**
 * @param {IDBDatabase} database
 * @param {RunPostMigrationOptions} [options]
 * @returns {Promise<PostMigrationResult>}
 */
export async function runPostMigrationsForDatabase(database, options = {}) {
  const migrations = options.migrations ?? DEFAULT_POST_MIGRATIONS;
  if (migrations.length === 0) return { completed: true, processed: 0 };

  const transaction = database.transaction(storeNamesForMigrations(migrations), 'readwrite', {
    durability: options.durability ?? 'strict',
  });
  const done = transactionToPromise(transaction);

  try {
    const result = await runOnePostMigrationChunk(transaction, migrations, normalizeBatchSize(options.batchSize));
    await done;
    return result;
  } catch (error) {
    abortTransaction(transaction);
    await settleAbort(done);
    throw error;
  }
}

/**
 * @param {IDBTransaction} transaction
 * @param {readonly PostMigrationDefinition[]} migrations
 * @param {number} batchSize
 * @returns {Promise<PostMigrationResult>}
 */
async function runOnePostMigrationChunk(transaction, migrations, batchSize) {
  const meta = transaction.objectStore(STORES.META);
  const stored = await readMetaValue(meta, META_KEYS.POST_MIGRATION);
  const state = normalizeStoredState(stored);
  const migration = selectMigration(migrations, state);
  if (!migration) return { completed: true, processed: 0 };
  if (state && state.completed && !isTerminalState(state)) {
    const next = nextStateAfterCompletion(migrations, state.id, state.completedIds ?? []);
    await writeMetaValue(meta, META_KEYS.POST_MIGRATION, next);
    return { completed: next.completed, processed: 0 };
  }

  const current = state ?? createPostMigrationState(migration.id);
  const step = await migration.run({ transaction, state: { ...current }, batchSize });
  const next = normalizeStepState(migrations, migration.id, current, step);
  await writeMetaValue(meta, META_KEYS.POST_MIGRATION, next);
  return {
    completed: next.completed,
    processed: normalizeProcessed(step.processed),
  };
}

/**
 * @param {readonly PostMigrationDefinition[]} migrations
 * @param {PostMigrationState | null} state
 */
function selectMigration(migrations, state) {
  if (state && isTerminalState(state)) {
    const completed = new Set(state.completedIds ?? []);
    return migrations.find((migration) => !completed.has(migration.id)) ?? null;
  }
  if (state) {
    const migration = migrations.find((candidate) => candidate.id === state.id) ?? null;
    if (!migration) throw stalePostMigrationError(state.id);
    return migration;
  }
  return migrations[0] ?? null;
}

/**
 * @param {unknown} stored
 * @returns {PostMigrationState | null}
 */
function normalizeStoredState(stored) {
  if (!isRecord(stored)) return null;
  if (stored.version !== undefined && stored.version !== POST_MIGRATION_SCHEMA_VERSION) {
    throw stalePostMigrationError(String(stored.id ?? 'unknown'));
  }
  if (typeof stored.id !== 'string') return null;
  return {
    completedIds: normalizeCompletedIds(stored.completedIds),
    id: stored.id,
    cursor: stored.cursor ?? null,
    completed: stored.completed === true,
  };
}

/**
 * @param {readonly PostMigrationDefinition[]} migrations
 * @param {string} migrationId
 * @param {PostMigrationState} current
 * @param {PostMigrationStepResult} step
 * @returns {PostMigrationState & {version: number}}
 */
function normalizeStepState(migrations, migrationId, current, step) {
  if (step.completed === true) {
    return nextStateAfterCompletion(migrations, migrationId, current.completedIds ?? []);
  }
  return {
    version: POST_MIGRATION_SCHEMA_VERSION,
    completedIds: current.completedIds ?? [],
    id: migrationId,
    cursor: step.cursor ?? current.cursor ?? null,
    completed: false,
  };
}

/**
 * @param {readonly PostMigrationDefinition[]} migrations
 * @param {string} completedId
 * @param {readonly string[]} completedIds
 * @returns {PostMigrationState & {version: number}}
 */
function nextStateAfterCompletion(migrations, completedId, completedIds) {
  const completed = new Set([...completedIds, completedId]);
  const next = migrations.find((migration) => !completed.has(migration.id));
  if (next) {
    return {
      version: POST_MIGRATION_SCHEMA_VERSION,
      completedIds: [...completed],
      id: next.id,
      cursor: null,
      completed: false,
    };
  }
  return {
    version: POST_MIGRATION_SCHEMA_VERSION,
    completedIds: migrations.map((migration) => migration.id),
    id: POST_MIGRATION_TERMINAL_ID,
    cursor: null,
    completed: true,
  };
}

/**
 * @param {PostMigrationState | null} state
 * @returns {boolean}
 */
function isTerminalState(state) {
  return state?.id === POST_MIGRATION_TERMINAL_ID && state.completed === true;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeCompletedIds(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string');
}

/**
 * @param {string} id
 */
function stalePostMigrationError(id) {
  return createAppError(ERROR_CODES.DB_SCHEMA_MISMATCH, {
    details: { field: 'postMigration', reason: `unknown migration id: ${id}` },
  });
}

/**
 * @param {readonly PostMigrationDefinition[]} migrations
 */
function storeNamesForMigrations(migrations) {
  /** @type {Set<string>} */
  const storeNames = new Set([STORES.META]);
  for (const migration of migrations) {
    for (const storeName of migration.stores ?? []) storeNames.add(storeName);
  }
  return [...storeNames];
}

/**
 * @param {unknown} batchSize
 */
function normalizeBatchSize(batchSize) {
  if (typeof batchSize !== 'number' || !Number.isSafeInteger(batchSize) || batchSize <= 0) {
    return POST_MIGRATION_BATCH_SIZE;
  }
  return Math.min(batchSize, POST_MIGRATION_BATCH_SIZE);
}

/**
 * @param {unknown} processed
 */
function normalizeProcessed(processed) {
  if (typeof processed !== 'number' || !Number.isSafeInteger(processed) || processed < 0) return 0;
  return Math.min(processed, POST_MIGRATION_BATCH_SIZE);
}

/**
 * @param {IDBObjectStore} meta
 * @param {string} key
 */
async function readMetaValue(meta, key) {
  const record = await requestToPromise(meta.get(key));
  return record && typeof record === 'object' && 'value' in record ? record.value : undefined;
}

/**
 * @param {IDBObjectStore} meta
 * @param {string} key
 * @param {unknown} value
 */
async function writeMetaValue(meta, key, value) {
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
    // The caller receives the original migration failure.
  }
}

/** @param {unknown} error */
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

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

/**
 * @param {unknown} value
 * @returns {value is IDBDatabase}
 */
function isDatabaseLike(value) {
  return isRecord(value) && typeof value.transaction === 'function';
}
