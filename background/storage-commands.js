// @ts-check

import { createArticleRepository } from '../data/article-repository.js';
import { STORES } from '../data/constants.js';
import { createFeedRepository } from '../data/feed-repository.js';
import { META_KEYS, readMetaValue } from '../data/meta-repository.js';
import { createStatsRepository } from '../data/stats-repository.js';
import { createSettingsRepository, DEFAULT_SETTINGS } from '../data/settings-repository.js';
import { diagnoseIntegrity, repairIntegrity } from '../data/integrity-service.js';
import { resetDatabaseData } from '../data/db.js';
import { runTransaction } from '../data/transaction.js';
import { ERROR_CODES } from '../domain/errors.js';
import { MESSAGE_TYPES } from '../domain/message-types.js';
import {
  broadcastChangeEvent,
  createCommittedChangePublisher,
  createDataResetChangedEvent,
  requestBestEffortPresentation,
} from './change-events.js';
import { createMaintenanceService } from './maintenance-service.js';

/**
 * @typedef {import('../data/transaction.js').TransactionOptions} RepositoryOptions
 * @typedef {import('../data/settings-repository.js').StorageArea} StorageArea
 * @typedef {{estimate(): Promise<{usage?: number, quota?: number, usageDetails?: Record<string, unknown>}>}} StorageManagerLike
 * @typedef {RepositoryOptions & Pick<import('../data/integrity-service.js').IntegrityOptions, 'batchSize' | 'maxChunks'>} StorageCommandOptions
 * @typedef {{
 *   browserApi?: import('./change-events.js').BrowserRuntimeLike,
 *   changePublisher?: import('./change-events.js').ChangePublisher | null,
 *   onResetCommitted?: () => void | Promise<void>,
 *   storageArea?: StorageArea,
 *   storageManager?: StorageManagerLike
 * }} StorageCommandDependencies
 */

/**
 * @param {StorageCommandOptions} [options]
 * @param {StorageCommandDependencies} [dependencies]
 * @returns {Record<string, import('./command-router.js').CommandHandler>}
 */
export function createStorageCommandHandlers(options = {}, dependencies = {}) {
  const changePublisher = resolveChangePublisher(dependencies);
  return {
    [MESSAGE_TYPES.STORAGE_GET_USAGE]: () => getStorageUsage(options, dependencies),
    [MESSAGE_TYPES.STORAGE_PURGE]: async (payload) => {
      const settings = await readPurgeSettings(dependencies.storageArea);
      return createMaintenanceService(options, { changePublisher }).runPurge({
        maxChunks: 8,
        settings: {
          ...settings,
          ...numericOverride(payload, 'maxArticles', 'purgeMaxArticles'),
          ...numericOverride(payload, 'maxAgeDays', 'purgeMaxAgeDays'),
        },
      });
    },
    [MESSAGE_TYPES.STORAGE_REBUILD_STATS]: () => rebuildStats(options, changePublisher),
    [MESSAGE_TYPES.STORAGE_DIAGNOSE_INTEGRITY]: () => diagnoseIntegrity(options),
    [MESSAGE_TYPES.STORAGE_REPAIR_INTEGRITY]: async () => {
      const result = await repairIntegrity(options);
      await publishChange(changePublisher, result);
      return result;
    },
    [MESSAGE_TYPES.STORAGE_RESET_DATA]: async () => {
      const result = await resetDatabaseData(options);
      if (result.status === 'deleted') {
        try {
          if (dependencies.browserApi)
            await broadcastChangeEvent(createDataResetChangedEvent(), dependencies.browserApi);
        } finally {
          requestBestEffortPresentation(dependencies.onResetCommitted);
        }
      }
      return result;
    },
  };
}

/**
 * @param {RepositoryOptions} options
 * @param {StorageCommandDependencies} dependencies
 */
async function getStorageUsage(options, dependencies) {
  const [estimate, feeds, globalStats, diagnosticRecoveryActions] = await Promise.all([
    readEstimate(dependencies.storageManager),
    createFeedRepository(options).listWithStats(),
    createStatsRepository(options).getGlobal(),
    readDiagnosticRecoveryActions(options),
  ]);
  const warning = feeds.some(({ feed }) => feed.lastErrorCode === ERROR_CODES.DB_QUOTA_EXCEEDED)
    ? { code: ERROR_CODES.DB_QUOTA_EXCEEDED, recoveryActions: ['purge', 'opml-export'] }
    : null;
  return {
    counts: {
      articles: safeCount(globalStats?.articleCount),
      feeds: feeds.length,
    },
    estimate,
    diagnostic: { recoveryActions: diagnosticRecoveryActions },
    warning,
  };
}

/**
 * @param {StorageManagerLike | undefined} storageManager
 */
async function readEstimate(storageManager) {
  const manager = storageManager ?? globalThis.navigator?.storage;
  if (!manager || typeof manager.estimate !== 'function') {
    return { approximate: true, quotaBytes: 0, usageBytes: 0, usageDetails: {} };
  }
  const estimate = await manager.estimate();
  const details = /** @type {{usageDetails?: Record<string, unknown>}} */ (estimate).usageDetails;
  return {
    approximate: true,
    quotaBytes: safeCount(estimate.quota),
    usageBytes: safeCount(estimate.usage),
    usageDetails: details ?? {},
  };
}

/**
 * @param {RepositoryOptions} options
 * @param {import('./change-events.js').ChangePublisher | null} changePublisher
 */
async function rebuildStats(options, changePublisher) {
  const stats = createStatsRepository(options);
  await publishChange(changePublisher, await stats.requestRebuild());
  let processed = 0;
  for (let chunks = 0; chunks < 8; chunks += 1) {
    const result = await stats.rebuildChunk({ batchSize: 250 });
    await publishChange(changePublisher, result);
    processed += result.processed;
    if (result.completed) return { completed: true, processed, status: 'completed' };
  }
  return { completed: false, processed, status: 'partial' };
}

/**
 * @param {RepositoryOptions} options
 */
async function readDiagnosticRecoveryActions(options) {
  return runTransaction(
    STORES.META,
    'readonly',
    async (transaction) => {
      const [rebuildRequired, rebuildState, diagnoseState, repairState] = await Promise.all([
        readMetaValue(transaction, META_KEYS.STATS_REBUILD_REQUIRED),
        readMetaValue(transaction, META_KEYS.STATS_REBUILD),
        readMetaValue(transaction, META_KEYS.INTEGRITY_DIAGNOSE),
        readMetaValue(transaction, META_KEYS.INTEGRITY_REPAIR),
      ]);
      return [
        ...(rebuildRequired === true || isRecord(rebuildState) ? ['rebuild-stats'] : []),
        ...(isRecord(diagnoseState) || isRecord(repairState) ? ['repair-integrity'] : []),
      ];
    },
    options,
  );
}

/**
 * @param {StorageCommandDependencies} dependencies
 */
function resolveChangePublisher(dependencies) {
  if (dependencies.changePublisher !== undefined) return dependencies.changePublisher;
  return dependencies.browserApi ? createCommittedChangePublisher(dependencies.browserApi) : null;
}

/**
 * @param {import('./change-events.js').ChangePublisher | null} publisher
 * @param {Partial<import('./change-events.js').RepositoryMutationResult> & Record<string, unknown>} result
 */
async function publishChange(publisher, result) {
  if (publisher) await publisher(result);
}

/**
 * @param {StorageArea | undefined} storageArea
 */
async function readPurgeSettings(storageArea) {
  if (!storageArea) return DEFAULT_SETTINGS;
  return createSettingsRepository(storageArea).read();
}

/**
 * @param {Record<string, unknown>} payload
 * @param {string} payloadKey
 * @param {'purgeMaxArticles' | 'purgeMaxAgeDays'} settingsKey
 */
function numericOverride(payload, payloadKey, settingsKey) {
  return typeof payload[payloadKey] === 'number' ? { [settingsKey]: payload[payloadKey] } : {};
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * @param {unknown} value
 */
function safeCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
