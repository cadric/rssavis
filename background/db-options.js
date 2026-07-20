// @ts-check

import {
  broadcastChangeEvent,
  createDatabaseBlockedEvent,
  createDatabaseReloadRequiredEvent,
} from './change-events.js';
import { createAppError, ERROR_CODES } from '../domain/errors.js';

const DEFAULT_CATEGORY_TITLE_KEY = 'defaultCategoryTitle';
const FALLBACK_DEFAULT_CATEGORY_TITLE = 'Uncategorized';

/**
 * @typedef {object} BackgroundDatabaseOptionsBrowser
 * @property {{getMessage(key: string, substitutions?: string | string[]): string}} i18n
 * @property {{sendMessage(message: unknown): Promise<unknown>}} runtime
 */

/**
 * @param {BackgroundDatabaseOptionsBrowser} browserApi
 * @returns {import('../data/db.js').OpenDatabaseOptions}
 */
export function createBackgroundDatabaseOptions(browserApi) {
  let reloadRequired = false;
  return {
    beforeOpen() {
      if (!reloadRequired) return;
      throw createAppError(ERROR_CODES.DB_VERSION_ERROR, {
        details: { operation: 'database.reloadRequired' },
        retryable: true,
      });
    },
    defaultCategoryTitle: localizedDefaultCategoryTitle(browserApi),
    onBlocked(error) {
      emitLifecycleEvent(browserApi, createDatabaseBlockedEvent(error));
    },
    onReloadRequired(state) {
      reloadRequired = true;
      emitLifecycleEvent(browserApi, createDatabaseReloadRequiredEvent(state));
    },
  };
}

/**
 * @param {BackgroundDatabaseOptionsBrowser} browserApi
 * @param {unknown} event
 */
function emitLifecycleEvent(browserApi, event) {
  void broadcastChangeEvent(event, browserApi).catch((error) => {
    console.error({
      atMs: Date.now(),
      code: error instanceof Error ? error.name : 'DATABASE_EVENT_BROADCAST_FAILED',
      level: 'error',
      operation: 'database.lifecycle.broadcast',
    });
  });
}

/**
 * @param {BackgroundDatabaseOptionsBrowser} browserApi
 */
function localizedDefaultCategoryTitle(browserApi) {
  const localized = browserApi.i18n.getMessage(DEFAULT_CATEGORY_TITLE_KEY);
  return localized.trim() || FALLBACK_DEFAULT_CATEGORY_TITLE;
}
