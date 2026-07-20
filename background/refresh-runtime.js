// @ts-check

import { toSafeError } from '../domain/errors.js';
import { createCommittedChangePublisher } from './change-events.js';

/**
 * @param {{browserApi?: import('./change-events.js').BrowserRuntimeLike, changePublisher?: import('./change-events.js').ChangePublisher | null}} dependencies
 */
export function resolveChangePublisher(dependencies) {
  if (dependencies.changePublisher !== undefined) return dependencies.changePublisher;
  return dependencies.browserApi ? createCommittedChangePublisher(dependencies.browserApi) : null;
}

/**
 * @param {import('./change-events.js').ChangePublisher | null} publisher
 * @param {Partial<import('./change-events.js').RepositoryMutationResult> & Record<string, unknown>} result
 */
export async function publishChange(publisher, result) {
  if (publisher) await publisher(result);
}

export function createRunId() {
  if (globalThis.crypto?.randomUUID) return `run-${globalThis.crypto.randomUUID()}`;
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * @param {number | undefined} value
 * @param {number} fallback
 */
export function normalizePositiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

/**
 * @param {number | boolean | undefined} setting
 */
export function crashAfterChunk(setting) {
  if (!setting) return undefined;
  let chunks = 0;
  return () => {
    chunks += 1;
    if (setting === true || chunks >= setting) throw new Error('crash after ingestion chunk');
  };
}

/**
 * @param {number | boolean | undefined} setting
 * @param {string} message
 */
export function crashIfRequested(setting, message) {
  if (setting) throw new Error(message);
}

/**
 * @param {unknown} error
 */
export function safeError(error) {
  if (isSafeError(error)) return error;
  return toSafeError(error);
}

/**
 * Fire-and-forget background icon resolution after a refresh commit. It never
 * runs inside a transaction and never affects the refresh result; a failure is
 * logged, not thrown.
 * @param {((feedId: string) => Promise<unknown>) | undefined} resolveIcon
 * @param {string} feedId
 */
export function fireIconResolution(resolveIcon, feedId) {
  if (typeof resolveIcon !== 'function') return;
  void Promise.resolve()
    .then(() => resolveIcon(feedId))
    .catch((error) => {
      console.error({
        atMs: Date.now(),
        code: error instanceof Error ? error.name : 'FEED_ICON_RESOLVE_FAILED',
        level: 'error',
        operation: 'feeds.icon.resolve',
      });
    });
}

/**
 * @param {unknown} value
 * @returns {value is import('../domain/errors.js').SafeError}
 */
function isSafeError(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (/** @type {{code?: unknown}} */ (value).code) === 'string' &&
    typeof (/** @type {{messageKey?: unknown}} */ (value).messageKey) === 'string' &&
    typeof (/** @type {{retryable?: unknown}} */ (value).retryable) === 'boolean'
  );
}
