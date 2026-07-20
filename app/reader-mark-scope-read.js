// @ts-check

import { openAlertDialog } from './adw-dialog.js';
import { countUnreadForScope, markScopeRead } from './api-client.js';
import { announceStatus } from './toasts.js';

const MARK_SCOPE_BATCH_SIZE = 250;
const MARK_SCOPE_PROGRESS_THRESHOLD = 1000;

/**
 * @param {import('./reader-controller.js').ReaderControllerInput} input
 * @param {{loadArticles(): Promise<void>, loadBootstrapSnapshot(): Promise<boolean>}} actions
 */
export async function markCurrentScopeRead(input, actions) {
  const current = input.getState();
  if (!current || current.mode !== 'reader') return;
  const marked = await confirmAndMarkScopeRead(input, current.activeScope);
  if (marked === null) return;
  if (!(await actions.loadBootstrapSnapshot())) return;
  await actions.loadArticles();
  const getMessage = input.options.browserApi.i18n.getMessage.bind(input.options.browserApi.i18n);
  announceStatus(input.options.documentRef, getMessage('markScopeReadComplete', [marked]));
}

/**
 * Bounded confirm-and-chunk mark-scope-read pipeline shared by the Shift+A
 * reader command and the feed context-menu action. Confirms above the noise
 * threshold, then marks in fixed 250-item chunks until the scope is covered.
 * Returns the number of articles marked, or null when nothing ran (empty scope
 * or a cancelled confirmation).
 * @param {{getSnapshot(): import('./api-client.js').BootstrapSnapshot, options: import('./app-shell.js').AppShellOptions}} input
 * @param {import('../domain/scopes.js').Scope} scope
 * @returns {Promise<number | null>}
 */
export async function confirmAndMarkScopeRead(input, scope) {
  const countResult = await countUnreadForScope({ scope }, input.options.browserApi);
  const unreadCount = numberValue(countResult, 'unreadCount');
  const getMessage = input.options.browserApi.i18n.getMessage.bind(input.options.browserApi.i18n);
  if (unreadCount === 0) {
    announceStatus(input.options.documentRef, getMessage('markScopeReadNone'));
    return null;
  }
  const scopeLabel = labelForScope(input.getSnapshot(), scope, getMessage);
  if (unreadCount > 20) {
    const confirmed = await openAlertDialog(input.options.documentRef, {
      affirmativeLabel: getMessage('markScopeReadMenu'),
      cancelLabel: getMessage('dialogCancel'),
      heading: getMessage('markScopeReadConfirm', [unreadCount, scopeLabel]),
    });
    if (!confirmed.confirmed) return null;
  }
  return markScopeReadChunks(input, scope, unreadCount, getMessage);
}

/**
 * @param {{options: import('./app-shell.js').AppShellOptions}} input
 * @param {import('../domain/scopes.js').Scope} scope
 * @param {number} unreadCount
 * @param {(key: string, substitutions?: string | number | Array<string | number>) => string} getMessage
 */
async function markScopeReadChunks(input, scope, unreadCount, getMessage) {
  let marked = 0;
  while (marked < unreadCount) {
    const result = await markScopeRead(
      {
        scope,
        batchSize: MARK_SCOPE_BATCH_SIZE,
        maxChunks: 1,
      },
      input.options.browserApi,
    );
    const affected = numberValue(result, 'affectedCount');
    if (affected === 0) break;
    marked += affected;
    if (unreadCount > MARK_SCOPE_PROGRESS_THRESHOLD) {
      announceStatus(input.options.documentRef, getMessage('markScopeReadProgress', [marked, unreadCount]));
    }
    if (affected < MARK_SCOPE_BATCH_SIZE) break;
  }
  return marked;
}

/**
 * @param {import('./api-client.js').BootstrapSnapshot} snapshot
 * @param {import('../domain/scopes.js').Scope} scope
 * @param {(key: string, substitutions?: string | number | Array<string | number>) => string} getMessage
 */
function labelForScope(snapshot, scope, getMessage) {
  if (scope.type === 'system') {
    const key =
      scope.id === 'main'
        ? 'scopeMain'
        : scope.id === 'starred'
          ? 'scopeStarred'
          : scope.id === 'all'
            ? 'scopeAll'
            : 'scopeUnread';
    return getMessage(key);
  }
  if (scope.type === 'feed') {
    return snapshot.feeds.find((feed) => feed.id === scope.id)?.title ?? getMessage('scopeUnread');
  }
  return snapshot.categories.find((category) => category.id === scope.id)?.title ?? getMessage('scopeUnread');
}

/**
 * @param {unknown} input
 * @param {string} key
 */
function numberValue(input, key) {
  if (!isRecord(input)) return 0;
  const value = input[key];
  return typeof value === 'number' ? value : 0;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}
