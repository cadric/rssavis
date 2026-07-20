// @ts-check

import { mergeArticles } from './article-merge.js';
import { finishPreservedArticleLoad, isResolvedArticleStatus } from './reader-article-load-state.js';
import { normalizeSearchInput } from './reader-search-identity.js';
import { searchStatusMessage } from './reader-search-actions.js';
import { restoreReaderScroll } from './reader-scroll-state.js';
import { readerQueryKey } from './reader-refresh-plan.js';

/**
 * @typedef {object} ArticlePageCommitInput
 * @property {import('./reader-controller.js').ReaderControllerInput} input
 * @property {import('./reader-controller.js').ReaderRuntime} runtime
 * @property {NonNullable<ReturnType<import('./reader-controller.js').ReaderControllerInput['getState']>>} current
 * @property {import('./reader-state.js').ArticleState} previous
 * @property {import('./reader-settings.js').ReaderSettings} settings
 * @property {'append' | 'reset'} mode
 * @property {import('./reader-article-loader.js').LoadArticlesOptions} options
 * @property {Awaited<ReturnType<typeof import('./api-client.js').queryArticles>>} page
 * @property {number} pageSize
 * @property {import('./article-filter.js').ArticleFilter} appliedFilter
 * @property {string} pageQueryKey
 * @property {boolean} searchActive
 * @property {string} searchQuery
 * @property {boolean} preserveRows
 * @property {import('./reader-state.js').ArticleState['previewByArticleId']} preservedPreviewByArticleId
 * @property {string} expandedArticleIdAtStart
 * @property {number} requestSequence
 */

/**
 * @param {ArticlePageCommitInput} context
 * @returns {Promise<boolean>}
 */
export async function commitArticlePage(context) {
  const { input, runtime, previous, mode, options, page, pageQueryKey, searchActive } = context;
  const preserveStickyMembership =
    mode === 'reset' &&
    !searchActive &&
    options.membershipReconcile !== true &&
    options.revisionReset !== true &&
    runtime.stickyMembershipQueryKeys.has(pageQueryKey) &&
    isResolvedArticleStatus(previous.status);
  const items =
    mode === 'append'
      ? mergeArticles(previous.items, page.items)
      : preserveStickyMembership
        ? patchExistingMembership(previous.items, page.items)
        : page.items;
  const expandedArticleIdAtCommit = input.getState()?.expandedArticleId ?? '';
  const expansionMissing =
    mode === 'reset' &&
    Boolean(expandedArticleIdAtCommit) &&
    (!searchActive || expandedArticleIdAtCommit !== runtime.searchOriginExpandedArticleId) &&
    !items.some((item) => item.id === expandedArticleIdAtCommit);
  if (expansionMissing && expandedArticleIdAtCommit !== context.expandedArticleIdAtStart && context.preserveRows) {
    finishPreservedArticleLoad(input, runtime, context.settings);
    return false;
  }
  const nextArticleState = createLoadedArticleState(context, items);
  if (!(await commitExpansionState(context, nextArticleState, expandedArticleIdAtCommit, expansionMissing))) {
    return false;
  }
  if (mode === 'reset' && !searchActive) {
    cacheLoadedPage(context, nextArticleState, items, preserveStickyMembership);
  }
  runtime.scrollMarker.reconcile(input);
  if (mode === 'reset') {
    if (searchActive) resetReaderScroll(input.options.documentRef);
    else restoreReaderScroll(input.options.documentRef, context.current);
  }
  return true;
}

/**
 * @param {ArticlePageCommitInput} context
 * @param {Record<string, unknown>[]} items
 * @returns {import('./reader-state.js').ArticleState}
 */
function createLoadedArticleState(context, items) {
  const { input, previous, mode, page, searchActive, searchQuery, appliedFilter, settings } = context;
  const currentSearchQuery = input.getArticleState().searchQuery;
  const committedSearchQuery =
    searchActive && normalizeSearchInput(currentSearchQuery) === searchQuery
      ? currentSearchQuery
      : previous.searchQuery;
  const emptyVariant = /** @type {'' | 'filtered-unread' | 'filtered-read'} */ (
    items.length === 0 && !searchActive && appliedFilter !== 'all' ? `filtered-${appliedFilter}` : ''
  );
  return {
    busy: false,
    dataRevision: mode === 'append' ? previous.dataRevision : page.dataRevision,
    emptyVariant,
    freezeReadyRows: false,
    hasMore: page.hasMore,
    items,
    loadingStatusVisible: false,
    newArticlesAvailable: mode === 'append' ? input.getArticleState().newArticlesAvailable : null,
    nextCursor: page.nextCursor,
    previewByArticleId: previewStateAtCommit(input, context.preservedPreviewByArticleId),
    searchActive: previous.searchActive,
    searchQuery: committedSearchQuery,
    settings,
    status: items.length > 0 ? 'ready' : 'empty',
    statusAction: emptyVariant ? 'show-all' : '',
    statusCanRetry: false,
    statusMessage: searchStatusMessage(input.options.browserApi.i18n, searchActive, items.length),
  };
}

/**
 * @param {ArticlePageCommitInput} context
 * @param {import('./reader-state.js').ArticleState} nextArticleState
 * @param {string} expandedArticleIdAtCommit
 * @param {boolean} expansionMissing
 */
async function commitExpansionState(context, nextArticleState, expandedArticleIdAtCommit, expansionMissing) {
  const { input, runtime, requestSequence } = context;
  if (!expansionMissing) {
    input.setArticleState(nextArticleState);
    return true;
  }
  let commitApplied = false;
  await input.writeReaderState(
    { expandedArticleId: '' },
    () => {
      commitApplied = true;
      return nextArticleState;
    },
    {
      applyIf: () =>
        requestSequence === runtime.requestSequence &&
        input.getState()?.expandedArticleId === expandedArticleIdAtCommit,
    },
  );
  return commitApplied;
}

/**
 * @param {ArticlePageCommitInput} context
 * @param {import('./reader-state.js').ArticleState} nextArticleState
 * @param {Record<string, unknown>[]} items
 * @param {boolean} preserveStickyMembership
 */
function cacheLoadedPage(context, nextArticleState, items, preserveStickyMembership) {
  const { runtime, options, pageQueryKey, page, appliedFilter, current, pageSize } = context;
  if (options.membershipReconcile === true || options.revisionReset === true) {
    runtime.stickyMembershipQueryKeys.delete(pageQueryKey);
    runtime.membershipReconcileQueryKeys.delete(pageQueryKey);
  }
  runtime.pageCache?.set({
    availabilityRevision: 0,
    dataRevision: page.dataRevision,
    emptyVariant: nextArticleState.emptyVariant,
    filter: appliedFilter,
    hasMore: page.hasMore,
    items,
    nextCursor: page.nextCursor,
    queryKey: readerQueryKey(current, nextArticleState, pageSize),
    scope: current.activeScope,
    stale: preserveStickyMembership,
    status: items.length > 0 ? 'ready' : 'empty',
  });
}

/**
 * Applies newer row fields without inserting, removing, or reordering rows.
 * @param {Record<string, unknown>[]} currentItems
 * @param {Record<string, unknown>[]} freshItems
 */
function patchExistingMembership(currentItems, freshItems) {
  const freshById = new Map(freshItems.map((item) => [item.id, item]));
  return currentItems.map((item) => freshById.get(item.id) ?? item);
}

/**
 * @param {import('./reader-controller.js').ReaderControllerInput} input
 * @param {import('./reader-state.js').ArticleState['previewByArticleId']} fallback
 */
function previewStateAtCommit(input, fallback) {
  const expandedArticleId = input.getState()?.expandedArticleId ?? '';
  if (!expandedArticleId) return {};
  const preview = input.getArticleState().previewByArticleId[expandedArticleId] ?? fallback[expandedArticleId];
  return preview ? { [expandedArticleId]: preview } : {};
}

/** @param {Document} documentRef */
function resetReaderScroll(documentRef) {
  const main = documentRef.querySelector('[data-reader-main]');
  if (main && 'scrollTop' in main) main.scrollTop = 0;
}
