// @ts-check

import { CHANGE_EVENT_TYPES } from '../shared/messages.js';
import { toSafeError } from '../domain/errors.js';

/**
 * @typedef {object} BrowserRuntimeLike
 * @property {{sendMessage(message: unknown): Promise<unknown>}} runtime
 */

/**
 * @typedef {object} RepositoryMutationResult
 * @property {boolean} changed
 * @property {number} dataRevision
 * @property {Record<string, unknown> | null} change
 *
 * @typedef {(result: Partial<RepositoryMutationResult> & Record<string, unknown>) => Promise<void>} ChangePublisher
 *
 * @typedef {object} DatabaseReloadRequiredState
 * @property {'database.reloadRequired'} type
 * @property {number} oldVersion
 * @property {number | null} newVersion
 */

/**
 * @param {unknown} event
 * @param {BrowserRuntimeLike} [browserApi]
 * @returns {Promise<{delivered: boolean, ignoredNoReceiver: boolean}>}
 */
export async function broadcastChangeEvent(event, browserApi = getBrowserApi()) {
  try {
    await browserApi.runtime.sendMessage(event);
    return { delivered: true, ignoredNoReceiver: false };
  } catch (error) {
    if (isNoReceiverError(error)) return { delivered: false, ignoredNoReceiver: true };
    throw error;
  }
}

/**
 * @param {Partial<RepositoryMutationResult> & Record<string, unknown>} result
 * @param {BrowserRuntimeLike} [browserApi]
 */
export async function publishCommittedChange(result, browserApi = getBrowserApi()) {
  const event = createDataChangedEvent(result);
  if (event) await broadcastChangeEvent(event, browserApi);
}

/**
 * @param {BrowserRuntimeLike} [browserApi]
 * @param {{onCommittedChange?: () => void | Promise<void>}} [options]
 * @returns {ChangePublisher}
 */
export function createCommittedChangePublisher(browserApi = getBrowserApi(), options = {}) {
  return async (result) => {
    const event = createDataChangedEvent(result);
    if (!event) return;
    try {
      await broadcastChangeEvent(event, browserApi);
    } finally {
      requestBestEffortPresentation(options.onCommittedChange);
    }
  };
}

/**
 * Presentation must never alter a committed domain operation, including when an
 * injected consumer violates the normal non-throwing controller contract.
 * @param {(() => void | Promise<void>) | undefined} callback
 */
export function requestBestEffortPresentation(callback) {
  if (typeof callback !== 'function') return;
  try {
    void Promise.resolve(callback()).catch((error) => {
      reportPresentationFailure(error);
    });
  } catch (error) {
    // Presentation failures are deliberately outside the mutation result.
    reportPresentationFailure(error);
  }
}

/** @param {unknown} error */
function reportPresentationFailure(error) {
  console.error({
    atMs: Date.now(),
    code: error instanceof Error ? error.name : 'PRESENTATION_FAILED',
    level: 'error',
    operation: 'presentation.sync',
  });
}

/**
 * @param {Partial<RepositoryMutationResult> & Record<string, unknown>} result
 * @returns {{type: string, dataRevision: number, change: Record<string, unknown>} | null}
 */
export function createDataChangedEvent(result) {
  const change = result.change;
  if (!result.changed || change == null || typeof result.dataRevision !== 'number') return null;
  return {
    type: CHANGE_EVENT_TYPES.DATA_CHANGED,
    dataRevision: result.dataRevision,
    change,
  };
}

export function createDataResetChangedEvent() {
  return {
    type: CHANGE_EVENT_TYPES.DATA_CHANGED,
    dataRevision: 0,
    change: {
      categoryIds: [],
      entities: ['articles', 'articleBodies', 'articleIdentities', 'categories', 'feeds', 'stats'],
      feedIds: [],
      reason: 'storage-reset-data',
      revisionReset: true,
      scopes: [],
    },
  };
}

/**
 * @param {unknown} error
 * @returns {{type: string, error: import('../domain/errors.js').SafeError}}
 */
export function createDatabaseBlockedEvent(error) {
  return {
    type: CHANGE_EVENT_TYPES.DATABASE_BLOCKED,
    error: toSafeError(error),
  };
}

/**
 * @param {DatabaseReloadRequiredState} state
 * @returns {{type: string, oldVersion: number, newVersion: number | null}}
 */
export function createDatabaseReloadRequiredEvent(state) {
  return {
    type: CHANGE_EVENT_TYPES.DATABASE_RELOAD_REQUIRED,
    oldVersion: state.oldVersion,
    newVersion: state.newVersion,
  };
}

/**
 * @template {RepositoryMutationResult} T
 * @param {() => Promise<T>} operation
 * @param {BrowserRuntimeLike} [browserApi]
 * @returns {Promise<T>}
 */
export async function runWithCommittedChangeEvent(operation, browserApi = getBrowserApi()) {
  const result = await operation();
  const event = createDataChangedEvent(result);
  if (event) await broadcastChangeEvent(event, browserApi);
  return result;
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isNoReceiverError(error) {
  return error instanceof Error && /receiving end does not exist|no receiver/i.test(error.message);
}

/**
 * @returns {BrowserRuntimeLike}
 */
function getBrowserApi() {
  return /** @type {{browser: BrowserRuntimeLike}} */ (/** @type {unknown} */ (globalThis)).browser;
}
