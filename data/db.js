// @ts-check

import { AppError, createAppError, ERROR_CODES, mapDomException } from '../domain/errors.js';
import { DB_NAME, DB_VERSION, upgradeSchema } from './schema.js';
import { ensureSeedData } from './meta-repository.js';
import { runPostMigrationsForDatabase } from './migrations.js';

/**
 * @typedef {object} ReloadRequiredState
 * @property {'database.reloadRequired'} type
 * @property {number} oldVersion
 * @property {number | null} newVersion
 *
 * @typedef {object} OpenDatabaseOptions
 * @property {IDBFactory} [indexedDbFactory]
 * @property {string} [databaseName]
 * @property {number} [version]
 * @property {() => number} [now]
 * @property {() => string} [idFactory]
 * @property {string} [defaultCategoryTitle]
 * @property {() => void} [beforeOpen]
 * @property {(error: AppError) => void} [onBlocked]
 * @property {(state: ReloadRequiredState) => void} [onReloadRequired]
 */

/** @type {Promise<IDBDatabase> | null} */
let openPromise = null;
/** @type {IDBDatabase | null} */
let cachedDatabase = null;

/**
 * @param {OpenDatabaseOptions} [options]
 * @returns {Promise<IDBDatabase>}
 */
export function openDatabase(options = {}) {
  try {
    options.beforeOpen?.();
  } catch (error) {
    const mapped = mapOpenError(error);
    return Promise.reject(mapped);
  }
  if (cachedDatabase) return Promise.resolve(cachedDatabase);
  if (!openPromise) {
    openPromise = createOpenPromise(options).catch((error) => {
      resetCachedOpen();
      throw error;
    });
  }
  return openPromise;
}

export function resetDatabaseConnectionForTests() {
  closeDatabase();
}

export function closeDatabase() {
  if (cachedDatabase) cachedDatabase.close();
  resetCachedOpen();
}

/**
 * @param {OpenDatabaseOptions} [options]
 */
export async function resetDatabaseData(options = {}) {
  options.beforeOpen?.();
  closeDatabase();
  const factory = options.indexedDbFactory ?? indexedDB;
  const databaseName = options.databaseName ?? DB_NAME;
  const result = await deleteDatabaseWithFactory(factory, databaseName, options);
  if (result.status === 'deleted') await openDatabase(options);
  return result;
}

/**
 * @param {OpenDatabaseOptions} options
 * @returns {Promise<IDBDatabase>}
 */
function createOpenPromise(options) {
  const factory = options.indexedDbFactory ?? indexedDB;
  const databaseName = options.databaseName ?? DB_NAME;
  const version = options.version ?? DB_VERSION;

  try {
    return openWithFactory(factory, databaseName, version, options);
  } catch (error) {
    const mapped = mapOpenError(error);
    return Promise.reject(mapped);
  }
}

/**
 * @param {IDBFactory} factory
 * @param {string} databaseName
 * @param {number} version
 * @param {OpenDatabaseOptions} options
 * @returns {Promise<IDBDatabase>}
 */
function openWithFactory(factory, databaseName, version, options) {
  const request = factory.open(databaseName, version);
  return new Promise((resolve, reject) => {
    request.onupgradeneeded = (event) => {
      upgradeSchema(request.result, request.transaction, event.oldVersion, event.newVersion);
    };
    request.onblocked = (event) => {
      options.onBlocked?.(
        createAppError(ERROR_CODES.DB_UPGRADE_BLOCKED, {
          details: { oldVersion: event.oldVersion, newVersion: event.newVersion },
        }),
      );
    };
    request.onerror = () => reject(mapOpenRequestError(request.error));
    request.onsuccess = () => {
      settleOpenedDatabase(request.result, options).then(resolve, reject);
    };
  });
}

/**
 * @param {IDBFactory} factory
 * @param {string} databaseName
 * @param {OpenDatabaseOptions} options
 * @returns {Promise<{status: 'blocked' | 'deleted'}>}
 */
function deleteDatabaseWithFactory(factory, databaseName, options) {
  const request = factory.deleteDatabase(databaseName);
  return new Promise((resolve, reject) => {
    request.onblocked = (event) => {
      options.onBlocked?.(
        createAppError(ERROR_CODES.DB_UPGRADE_BLOCKED, {
          details: { oldVersion: event.oldVersion, newVersion: event.newVersion },
        }),
      );
      resolve({ status: 'blocked' });
    };
    request.onerror = () => reject(mapOpenRequestError(request.error));
    request.onsuccess = () => resolve({ status: 'deleted' });
  });
}

/**
 * @param {IDBDatabase} database
 * @param {OpenDatabaseOptions} options
 * @returns {Promise<IDBDatabase>}
 */
async function settleOpenedDatabase(database, options) {
  cachedDatabase = database;
  attachLifecycleHandlers(database, options);
  try {
    await ensureSeedData(database, {
      now: options.now,
      idFactory: options.idFactory,
      defaultCategoryTitle: options.defaultCategoryTitle,
    });
    await runReadyPostMigrations(database);
    return database;
  } catch (error) {
    database.close();
    resetCachedOpen();
    throw error;
  }
}

/**
 * @param {IDBDatabase} database
 */
async function runReadyPostMigrations(database) {
  for (let index = 0; index < 8; index += 1) {
    const result = await runPostMigrationsForDatabase(database);
    if (result.completed || result.processed > 0) return;
  }
}

/**
 * @param {IDBDatabase} database
 * @param {OpenDatabaseOptions} options
 */
function attachLifecycleHandlers(database, options) {
  database.onversionchange = (event) => {
    database.close();
    resetIfCurrent(database);
    options.onReloadRequired?.({
      type: 'database.reloadRequired',
      oldVersion: event.oldVersion,
      newVersion: event.newVersion,
    });
  };
  database.onclose = () => {
    resetIfCurrent(database);
  };
}

/**
 * @param {IDBDatabase} database
 */
function resetIfCurrent(database) {
  if (cachedDatabase !== database) return;
  resetCachedOpen();
}

function resetCachedOpen() {
  cachedDatabase = null;
  openPromise = null;
}

/**
 * @param {DOMException | null} error
 */
function mapOpenRequestError(error) {
  return error ? mapDomException(error) : createAppError(ERROR_CODES.DB_OPEN_FAILED);
}

/**
 * @param {unknown} error
 */
function mapOpenError(error) {
  if (error instanceof AppError) return error;
  if (error instanceof DOMException) return mapDomException(error);
  return createAppError(ERROR_CODES.DB_OPEN_FAILED);
}
