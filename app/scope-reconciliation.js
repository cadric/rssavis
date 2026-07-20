// @ts-check

import { announceStatus } from './toasts.js';

/**
 * @param {import('./reader-controller.js').ReaderControllerInput} input
 * @param {import('./api-validation.js').BootstrapSnapshot} snapshot
 * @param {() => void} [beforeChange]
 * @returns {Promise<boolean>}
 */
export async function reconcileActiveScope(input, snapshot, beforeChange) {
  const current = input.getState();
  if (!current || scopeExists(current.activeScope, snapshot)) return false;
  const fallback = { type: /** @type {'system'} */ ('system'), id: 'unread' };
  beforeChange?.();
  await input.writeState({ activeScope: fallback, expandedArticleId: '' });
  announceStatus(input.options.documentRef, input.options.browserApi.i18n.getMessage('readerScopeFallbackUnread'));
  return true;
}

/**
 * @param {import('../domain/scopes.js').Scope} scope
 * @param {import('./api-validation.js').BootstrapSnapshot} snapshot
 */
export function scopeExists(scope, snapshot) {
  if (scope.type === 'system') return true;
  if (scope.type === 'feed') return snapshot.feeds.some((feed) => feed.id === scope.id);
  // A category is only a valid scope while it still has at least one feed, matching the
  // sidebar hide-empty rule; an emptied selected category falls back to system:unread.
  return (
    snapshot.categories.some((category) => category.id === scope.id) &&
    snapshot.feeds.some((feed) => feed.categoryId === scope.id)
  );
}
