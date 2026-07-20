// @ts-check

import { emptyArticleState } from './reader-state.js';
import { announceStatus } from './toasts.js';

export const READER_LOADING_GRACE_MS = 400;

/**
 * @param {import('./reader-controller.js').ReaderControllerInput} input
 * @param {import('./reader-controller.js').ReaderRuntime} runtime
 * @param {{deferLoadingStatus?: boolean}} [options]
 */
export function scopeArticleResetState(input, runtime, options = {}) {
  const previous = input.getArticleState();
  const next = /** @type {import('./reader-state.js').ArticleState} */ ({
    ...emptyArticleState(),
    busy: true,
    searchActive: previous.searchActive,
    searchQuery: previous.searchQuery,
    settings: previous.settings,
    status: 'loading',
  });
  if (options.deferLoadingStatus) scheduleLoadingStatus(input, runtime, runtime.requestSequence);
  return next;
}

/**
 * @param {import('./reader-controller.js').ReaderControllerInput} input
 * @param {import('./reader-controller.js').ReaderRuntime} runtime
 * @param {import('./reader-state.js').ArticleState} previous
 * @param {import('./reader-state.js').ArticleState['previewByArticleId']} preservedPreviewByArticleId
 * @param {'append' | 'reset'} mode
 * @param {boolean} searchActive
 * @param {boolean} preserveRows
 * @param {import('./reader-article-loader.js').LoadArticlesOptions} options
 */
export function beginArticleLoad(
  input,
  runtime,
  previous,
  preservedPreviewByArticleId,
  mode,
  searchActive,
  preserveRows,
  options,
) {
  if (preserveRows) {
    input.setArticleState({ ...previous, busy: true, loadingStatusVisible: false });
    return;
  }
  const loadingStatusVisible = options.deferLoadingStatus !== true;
  input.setArticleState(
    mode === 'append'
      ? { ...previous, busy: true, loadingStatusVisible: false, statusCanRetry: false }
      : {
          ...emptyArticleState(),
          busy: true,
          loadingStatusVisible,
          previewByArticleId: preservedPreviewByArticleId,
          searchActive: previous.searchActive,
          searchQuery: previous.searchQuery,
          settings: previous.settings,
          status: previous.searchActive && !searchActive ? 'empty' : 'loading',
        },
  );
  if (options.deferLoadingStatus === true) scheduleLoadingStatus(input, runtime, runtime.requestSequence);
}

/**
 * @param {import('./reader-controller.js').ReaderControllerInput} input
 * @param {import('./reader-controller.js').ReaderRuntime} runtime
 */
export function clearArticleLoadingTimer(input, runtime) {
  input.options.windowRef.clearTimeout(runtime.loadingTimer);
  runtime.loadingTimer = 0;
}

/**
 * @param {import('./reader-controller.js').ReaderControllerInput} input
 * @param {import('./reader-controller.js').ReaderRuntime} runtime
 * @param {number} requestSequence
 * @param {import('./reader-settings.js').ReaderSettings} settings
 */
export function finishInvalidArticleSearch(input, runtime, requestSequence, settings) {
  if (requestSequence !== runtime.requestSequence) return;
  clearArticleLoadingTimer(input, runtime);
  input.setArticleState({ ...input.getArticleState(), busy: false, loadingStatusVisible: false, settings });
  runtime.scrollMarker.reconcile(input);
}

/** @param {import('./reader-state.js').ArticleState['status']} status */
export function isResolvedArticleStatus(status) {
  return status === 'ready' || status === 'empty';
}

/**
 * @param {import('./reader-controller.js').ReaderControllerInput} input
 * @param {import('./reader-controller.js').ReaderRuntime} runtime
 * @param {import('./reader-settings.js').ReaderSettings} settings
 */
export function finishPreservedArticleLoad(input, runtime, settings) {
  const current = input.getArticleState();
  input.setArticleState({
    ...current,
    busy: false,
    loadingStatusVisible: false,
    newArticlesAvailable: current.newArticlesAvailable ? { ...current.newArticlesAvailable, busy: false } : null,
    settings,
  });
  runtime.scrollMarker.reconcile(input);
}

/**
 * @param {import('./reader-controller.js').ReaderControllerInput} input
 * @param {import('./reader-controller.js').ReaderRuntime} runtime
 * @param {number} requestSequence
 */
function scheduleLoadingStatus(input, runtime, requestSequence) {
  runtime.loadingTimer = input.options.windowRef.setTimeout(() => {
    if (requestSequence !== runtime.requestSequence) return;
    if (input.getState()?.mode !== 'reader') return;
    const current = input.getArticleState();
    if (!current.busy || current.status !== 'loading' || current.loadingStatusVisible) return;
    input.setArticleState({ ...current, loadingStatusVisible: true });
    announceStatus(input.options.documentRef, input.options.browserApi.i18n.getMessage('articlesLoading'));
  }, READER_LOADING_GRACE_MS);
}
