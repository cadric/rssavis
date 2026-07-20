// @ts-check

import { toSafeError } from '../domain/errors.js';
import { announceStatus } from './toasts.js';

/**
 * @typedef {{browserApi: {i18n: {getMessage(key: string): string}}, documentRef: Document}} EventBoundaryOptions
 */

/**
 * @param {EventBoundaryOptions} options
 */
export function createEventBoundary(options) {
  /**
   * @param {string} operation
   * @param {() => unknown} task
   */
  return (operation, task) => runEventTask(options, operation, task);
}

/**
 * @param {EventBoundaryOptions} options
 * @param {string} operation
 * @param {() => unknown} task
 */
export function runEventTask(options, operation, task) {
  try {
    const result = task();
    if (isPromiseLike(result)) {
      void result.catch((error) => reportEventError(options, error, operation));
    }
  } catch (error) {
    reportEventError(options, error, operation);
  }
}

/**
 * @param {EventBoundaryOptions} options
 * @param {unknown} error
 * @param {string} operation
 */
export function reportEventError(options, error, operation) {
  const safe = toSafeError(error);
  console.error({ atMs: Date.now(), code: safe.code, details: safe.details, level: 'error', operation });
  announceStatus(options.documentRef, options.browserApi.i18n.getMessage(safe.messageKey));
}

/**
 * @param {unknown} value
 * @returns {value is Promise<unknown>}
 */
function isPromiseLike(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    'catch' in value &&
    typeof (/** @type {{catch?: unknown}} */ (value).catch) === 'function'
  );
}
