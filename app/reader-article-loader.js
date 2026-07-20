// @ts-check

import { toSafeError } from '../domain/errors.js';
import { MAX_RENDERED_ARTICLE_ROWS } from './article-list-limits.js';
import {
  beginArticleLoad,
  clearArticleLoadingTimer,
  finishInvalidArticleSearch,
  finishPreservedArticleLoad,
  isResolvedArticleStatus,
  READER_LOADING_GRACE_MS,
  scopeArticleResetState,
} from './reader-article-load-state.js';
import { commitArticlePage } from './reader-article-page-commit.js';
import { requestCurrentArticlePage } from './reader-article-page-request.js';
import { requestRecoveredArticleWindow } from './reader-article-window-recovery.js';
import { invalidateArticleLoad } from './reader-load-generation.js';
import { SEARCH_MIN_CODE_POINTS, normalizeSearchInput } from './reader-search-identity.js';
import { readReaderSettings } from './reader-settings.js';
import { readerQueryKey } from './reader-refresh-plan.js';
import { announceStatus, showToast } from './toasts.js';

export { READER_LOADING_GRACE_MS, scopeArticleResetState };

/**
 * @typedef {object} LoadArticlesOptions
 * @property {boolean} [deferLoadingStatus]
 * @property {boolean} [membershipReconcile]
 * @property {boolean} [preserveRows]
 * @property {boolean} [preserveResolvedOnError]
 * @property {boolean} [revisionReset]
 * @property {number} [staleRecoveryTarget]
 * @property {string} [newArticlesQueryKey]
 */

/**
 * Clears rows before a new scope label can render and invalidates older loads.
 * @param {import('./reader-controller.js').ReaderControllerInput} input
 * @param {import('./reader-controller.js').ReaderRuntime} runtime
 * @param {{deferLoadingStatus?: boolean}} [options]
 */
export function prepareScopeArticleReset(input, runtime, options = {}) {
  invalidateArticleLoad(input, runtime);
  input.setArticleState(scopeArticleResetState(input, runtime, options));
}

/**
 * Builds the loading state after its caller has already invalidated older
 * article work. This lets scope persistence and the matching first page commit
 * together without briefly painting rows from another query identity.
 * @param {import('./reader-controller.js').ReaderControllerInput} input
 * @param {import('./reader-controller.js').ReaderRuntime} runtime
 * @param {{deferLoadingStatus?: boolean}} [options]
 */
/**
 * @param {import('./reader-controller.js').ReaderControllerInput} input
 * @param {import('./reader-controller.js').ReaderRuntime} runtime
 * @param {'append' | 'reset'} mode
 * @param {LoadArticlesOptions} [options]
 * @returns {Promise<boolean>}
 */
export function loadArticles(input, runtime, mode, options = {}) {
  if (mode === 'append' || !runtime.refreshCoordinator) {
    return performArticleLoad(input, runtime, mode, options);
  }
  const state = input.getState();
  const articleState = input.getArticleState();
  const queryKey = state ? readerQueryKey(state, articleState) : '';
  const targetRevision = Math.max(input.getSnapshot().dataRevision, articleState.dataRevision);
  let ownedRequestSequence = runtime.requestSequence;
  return runtime.refreshCoordinator.reset(
    {
      includesFeedIngest: false,
      kind: options.revisionReset ? 'hard-reset' : 'reconcile',
      queryKey,
      readerEpoch: runtime.refreshCoordinator.readerEpoch(),
      revisionReset: options.revisionReset === true,
      scopeSequence: runtime.scopeSequence,
      targetRevision,
    },
    () => {
      const operation = performArticleLoad(input, runtime, mode, options);
      ownedRequestSequence = runtime.requestSequence;
      return operation;
    },
    { isCurrent: () => ownedRequestSequence === runtime.requestSequence },
  );
}

/** @param {import('./reader-controller.js').ReaderControllerInput} input @param {import('./reader-controller.js').ReaderRuntime} runtime @param {'append' | 'reset'} mode @param {LoadArticlesOptions} options */
async function performArticleLoad(input, runtime, mode, options) {
  const current = input.getState();
  if (!current || current.mode !== 'reader') {
    runtime.scrollMarker.disconnect();
    return false;
  }
  const expandedArticleIdAtStart = current.expandedArticleId;
  const previous = input.getArticleState();
  const feedIngestGeneration = runtime.feedIngestGeneration;
  const filterMembershipGeneration = runtime.filterMembershipGeneration;
  const expandedPreview = previous.previewByArticleId[current.expandedArticleId];
  const preservedPreviewByArticleId = expandedPreview ? { [current.expandedArticleId]: expandedPreview } : {};
  const requestSequence = (runtime.requestSequence += 1);
  const searchQuery = previous.searchActive ? normalizeSearchInput(previous.searchQuery) : '';
  const searchActive = previous.searchActive && searchQuery.length >= SEARCH_MIN_CODE_POINTS;
  const preserveRows =
    mode === 'reset' &&
    options.preserveRows === true &&
    options.revisionReset !== true &&
    isResolvedArticleStatus(previous.status) &&
    searchActive === previous.searchActive;
  clearArticleLoadingTimer(input, runtime);
  beginArticleLoad(input, runtime, previous, preservedPreviewByArticleId, mode, searchActive, preserveRows, options);
  let settings = previous.settings;
  /** @type {unknown} */
  let loadError;
  try {
    settings = await readReaderSettings(input.options.storageArea);
    if (previous.searchActive && !searchActive) {
      finishInvalidArticleSearch(input, runtime, requestSequence, settings);
      return false;
    }
    const requestContext = {
      current,
      input,
      mode,
      options,
      preserveRows,
      previous,
      requestSequence,
      runtime,
      searchActive,
      searchQuery,
      settings,
    };
    let requestedPage = await requestCurrentArticlePage(requestContext);
    if (!requestedPage) return false;
    if (mode === 'reset' && options.staleRecoveryTarget) {
      requestedPage = await requestRecoveredArticleWindow(requestContext, requestedPage, options.staleRecoveryTarget);
      if (!requestedPage) return false;
    }
    const { appliedFilter, minimumRevision, page, pageQueryKey, pageSize } = requestedPage;
    clearArticleLoadingTimer(input, runtime);
    const membershipSuperseded =
      mode === 'reset' &&
      !searchActive &&
      previous.status === 'ready' &&
      filterMembershipGeneration !== runtime.filterMembershipGeneration;
    const ingestSuperseded =
      mode === 'reset' &&
      preserveRows &&
      !options.newArticlesQueryKey &&
      feedIngestGeneration !== runtime.feedIngestGeneration;
    if (
      ingestSuperseded ||
      membershipSuperseded ||
      page.dataRevision < minimumRevision ||
      !acceptNewArticlesPage(input, runtime, options, pageQueryKey, page.dataRevision)
    ) {
      finishPreservedArticleLoad(input, runtime, settings);
      return false;
    }
    if (page.dataRevision >= (runtime.pageRevisionFloors.get(pageQueryKey) ?? 0)) {
      runtime.pageRevisionFloors.delete(pageQueryKey);
    }
    return commitArticlePage({
      appliedFilter,
      current,
      expandedArticleIdAtStart,
      input,
      mode,
      options,
      page,
      pageQueryKey,
      pageSize,
      preserveRows,
      preservedPreviewByArticleId,
      previous,
      requestSequence,
      runtime,
      searchActive,
      searchQuery,
      settings,
    });
  } catch (error) {
    loadError = error;
  }
  return handleLoadError(input, runtime, previous, settings, mode, requestSequence, loadError, options);
}

/**
 * @param {import('./reader-controller.js').ReaderControllerInput} input
 * @param {import('./reader-controller.js').ReaderRuntime} runtime
 * @param {import('./article-workflow.js').ArticleState} previous
 * @param {import('./reader-settings.js').ReaderSettings} settings
 * @param {'append' | 'reset'} mode
 * @param {number} requestSequence
 * @param {unknown} error
 * @param {LoadArticlesOptions} options
 * @returns {Promise<boolean>}
 */
async function handleLoadError(input, runtime, previous, settings, mode, requestSequence, error, options) {
  const safe = toSafeError(error);
  if (requestSequence !== runtime.requestSequence) return false;
  if (mode === 'append' && safe.code === 'CURSOR_STALE') {
    const staleRecoveryTarget = Math.min(MAX_RENDERED_ARTICLE_ROWS, previous.items.length + settings.articlesPerPage);
    const painted = /** @type {boolean} */ (
      await loadArticles(input, runtime, 'reset', {
        membershipReconcile: true,
        preserveRows: true,
        staleRecoveryTarget,
      })
    );
    if (painted) {
      announceStatus(input.options.documentRef, input.options.browserApi.i18n.getMessage('articlesRefreshed'));
    }
    return painted;
  }
  clearArticleLoadingTimer(input, runtime);
  if (options.preserveResolvedOnError === true && isResolvedArticleStatus(previous.status)) {
    finishPreservedArticleLoad(input, runtime, settings);
    showToast(input.options.documentRef, input.options.browserApi.i18n.getMessage(safe.messageKey));
    return false;
  }
  input.setArticleState({
    ...previous,
    busy: false,
    hasMore: false,
    loadingStatusVisible: false,
    nextCursor: null,
    settings,
    status: 'error',
    statusCanRetry: safe.retryable,
    statusMessage: input.options.browserApi.i18n.getMessage(safe.messageKey),
  });
  runtime.scrollMarker.reconcile(input);
  announceStatus(input.options.documentRef, input.options.browserApi.i18n.getMessage(safe.messageKey));
  return false;
}

/** @param {import('./reader-controller.js').ReaderControllerInput} input @param {import('./reader-controller.js').ReaderRuntime} runtime @param {LoadArticlesOptions} options @param {string} queryKey @param {number} pageRevision */
function acceptNewArticlesPage(input, runtime, options, queryKey, pageRevision) {
  if (options.revisionReset !== true && pageRevision < (runtime.pageRevisionFloors.get(queryKey) ?? 0)) return false;
  if (!options.newArticlesQueryKey) return true;
  const available = input.getArticleState().newArticlesAvailable;
  return (
    available !== null && available.queryKey === options.newArticlesQueryKey && pageRevision >= available.dataRevision
  );
}
