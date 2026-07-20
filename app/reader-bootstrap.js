// @ts-check

import { toSafeError } from '../domain/errors.js';
import { bootstrapApp } from './api-client.js';
import { showDatabaseRecovery } from './database-recovery.js';
import { loadArticles, prepareScopeArticleReset } from './reader-article-loader.js';
import { markFeedMembershipCacheStale } from './reader-feed-snapshot-impact.js';
import { rememberReaderScroll } from './reader-scroll-state.js';
import { currentReaderRefreshIntent } from './reader-refresh-intents.js';
import { reconcileActiveScope } from './scope-reconciliation.js';
import { announceStatus, showToast } from './toasts.js';

/**
 * @param {import('./reader-controller.js').ReaderControllerInput} input
 * @param {import('./reader-controller.js').ReaderRuntime} runtime
 * @param {() => void} [markRecoveryStatusPending]
 * @param {{preserveResolvedOnError?: boolean}} [options]
 */
export function loadBootstrapSnapshot(input, runtime, markRecoveryStatusPending, options = {}) {
  return runtime.refreshCoordinator.bootstrap(
    (mergedOptions) => performBootstrapSnapshot(input, runtime, markRecoveryStatusPending, mergedOptions),
    options,
  );
}

/**
 * @param {import('./reader-controller.js').ReaderControllerInput} input
 * @param {import('./reader-controller.js').ReaderRuntime} runtime
 * @param {boolean} announceRefresh
 * @param {() => void} [markRecoveryStatusPending]
 * @param {import('./reader-article-loader.js').LoadArticlesOptions} [options]
 */
export async function reloadReaderSnapshotAndArticles(
  input,
  runtime,
  announceRefresh,
  markRecoveryStatusPending,
  options = {},
) {
  await rememberReaderScrollState(input);
  const snapshotResult = await loadBootstrapSnapshot(input, runtime, markRecoveryStatusPending);
  if (!snapshotResult.loaded) return false;
  const painted = await loadArticles(input, runtime, 'reset', options);
  const state = input.getState();
  if (!painted && state && state.mode !== 'reader') {
    const dataRevision = input.getSnapshot().dataRevision;
    runtime.refreshCoordinator.defer(
      currentReaderRefreshIntent(runtime, state, input.getArticleState(), dataRevision, false, dataRevision),
    );
  }
  if (announceRefresh && painted) {
    announceStatus(input.options.documentRef, input.options.browserApi.i18n.getMessage('articlesRefreshed'));
  }
  return painted;
}

/** @param {import('./reader-controller.js').ReaderControllerInput} input */
export async function rememberReaderScrollState(input) {
  await rememberReaderScroll(input.options.documentRef, input);
}

/**
 * @param {import('./reader-controller.js').ReaderControllerInput} input
 * @param {import('./reader-controller.js').ReaderRuntime} runtime
 * @param {() => void} [markRecoveryStatusPending]
 * @param {{preserveResolvedOnError?: boolean}} [options]
 */
async function performBootstrapSnapshot(input, runtime, markRecoveryStatusPending, options = {}) {
  try {
    const snapshot = await bootstrapApp(input.options.browserApi);
    if (snapshot.dataRevision < runtime.snapshotRevisionFloor) {
      return { loaded: true, scopeChanged: false };
    }
    markFeedMembershipCacheStale(runtime.pageCache, input.getSnapshot(), snapshot);
    runtime.pageCache.evictUnavailable(snapshot);
    input.setSnapshot(snapshot);
    const scopeChanged = await reconcileActiveScope(input, snapshot, () =>
      prepareScopeArticleReset(input, runtime, { deferLoadingStatus: true }),
    );
    if (scopeChanged) markRecoveryStatusPending?.();
    return { loaded: true, scopeChanged };
  } catch (error) {
    markRecoveryStatusPending?.();
    const safe = toSafeError(error);
    const message = input.options.browserApi.i18n.getMessage(safe.messageKey);
    if (options.preserveResolvedOnError && isResolvedStatus(input.getArticleState().status)) {
      const current = input.getArticleState();
      input.setArticleState({
        ...current,
        busy: false,
        newArticlesAvailable: current.newArticlesAvailable ? { ...current.newArticlesAvailable, busy: false } : null,
      });
      showToast(input.options.documentRef, message);
      return { loaded: false, scopeChanged: false };
    }
    input.setArticleState({
      ...input.getArticleState(),
      busy: false,
      hasMore: false,
      loadingStatusVisible: false,
      nextCursor: null,
      status: 'error',
      statusCanRetry: true,
      statusMessage: message,
    });
    showDatabaseRecovery(input.options.documentRef, 'startup', message, {
      code: safe.code,
      getMessage: input.options.browserApi.i18n.getMessage,
      onRetry: () => {
        void reloadReaderSnapshotAndArticles(input, runtime, true);
      },
    });
    announceStatus(input.options.documentRef, message);
    return { loaded: false, scopeChanged: false };
  }
}

/** @param {import('./reader-state.js').ArticleState['status']} status */
function isResolvedStatus(status) {
  return status === 'ready' || status === 'empty';
}
