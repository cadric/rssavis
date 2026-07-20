// @ts-check

import { createScrollReadMarker } from './article-scroll-marker.js';
import { hasReadFilteredMembership } from './article-filter.js';
import {
  closeSearch,
  createReaderRuntime,
  handleReaderInput,
  handleReaderKeydown,
  handleReaderSubmit,
  markCurrentScopeRead,
  openSearch,
} from './reader-search-actions.js';
import { loadArticles } from './reader-article-loader.js';
import {
  loadBootstrapSnapshot,
  reloadReaderSnapshotAndArticles,
  rememberReaderScrollState,
} from './reader-bootstrap.js';
import { articleStateFromCachedPage, createReaderPageCache, READER_PAGE_CACHE_LIMIT } from './reader-page-cache.js';
import { createReaderRefreshCoordinator } from './reader-refresh-coordinator.js';
import { currentReaderRefreshIntent } from './reader-refresh-intents.js';
import { createReaderRefreshLifecycle } from './reader-refresh-lifecycle.js';
import { readerQueryKey } from './reader-refresh-plan.js';
import { handleReaderClick } from './reader-click-actions.js';
import { restoreReaderScroll } from './reader-scroll-state.js';
import { createViewControls } from './view-controls.js';

/**
 * @typedef {import('./app-shell.js').AppShellOptions} AppShellOptions
 * @typedef {import('./state-store.js').createUiStateStore} UiStateStoreFactory
 * @typedef {ReturnType<import('./api-client.js').bootstrapApp>} BootstrapPromise
 * @typedef {Awaited<BootstrapPromise>} ReaderSnapshot
 * @typedef {import('./reader-state.js').ArticleState} ArticleState
 * @typedef {ReturnType<typeof createReaderRuntime> & {feedIngestGeneration: number, filterMembershipGeneration: number, membershipReconcileQueryKeys: Set<string>, pageCache: ReturnType<typeof createReaderPageCache>, pageRevisionFloors: Map<string, number>, refreshCoordinator: ReturnType<typeof createReaderRefreshCoordinator>, scopeActivation: {key: string, promise: Promise<void>} | null, scopeSequence: number, scrollMarker: ReturnType<typeof createScrollReadMarker>, snapshotRevisionFloor: number, stickyMembershipQueryKeys: Set<string>}} ReaderRuntime
 * @typedef {import('./reader-article-loader.js').LoadArticlesOptions} LoadArticlesOptions
 */

/**
 * @typedef {object} ReaderControllerInput
 * @property {AppShellOptions} options
 * @property {() => Awaited<ReturnType<ReturnType<UiStateStoreFactory>['read']>> | null} getState
 * @property {() => ArticleState} getArticleState
 * @property {() => ReaderSnapshot} getSnapshot
 * @property {(next: ArticleState) => void} setArticleState
 * @property {(next: ReaderSnapshot) => void} setSnapshot
 * @property {() => boolean} [isReaderContextAvailable]
 * @property {(scope: import('../domain/scopes.js').Scope, entry: {scrollTop: number, anchorArticleId?: string}) => Promise<Awaited<ReturnType<ReturnType<UiStateStoreFactory>['read']>>>} rememberScroll
 * @property {(id: string, field: 'readState' | 'starredState', expectedValue: number, nextValue: number, article: Record<string, unknown>, options?: {authoritativeDataRevision?: number}) => void} [patchCachedArticleField]
 * @property {(patch: Partial<Awaited<ReturnType<ReturnType<UiStateStoreFactory>['read']>>>, options?: {applyIf?: () => boolean}) => Promise<Awaited<ReturnType<ReturnType<UiStateStoreFactory>['read']>>>} writeState
 * @property {(patch: Partial<Awaited<ReturnType<ReturnType<UiStateStoreFactory>['read']>>>, nextArticleState: ArticleState | ((state: Awaited<ReturnType<ReturnType<UiStateStoreFactory>['read']>>) => ArticleState), options?: {applyIf?: () => boolean}) => Promise<Awaited<ReturnType<ReturnType<UiStateStoreFactory>['read']>>>} writeReaderState
 */

/**
 * @param {ReaderControllerInput} input
 */
export function createReaderController(input) {
  const pageRevisionFloors = new Map();
  const stickyMembershipQueryKeys = new Set();
  const runtime = {
    ...createReaderRuntime(),
    feedIngestGeneration: 0,
    filterMembershipGeneration: 0,
    membershipReconcileQueryKeys: new Set(),
    pageCache: createReaderPageCache(READER_PAGE_CACHE_LIMIT, {
      onEvict: (queryKey) => stickyMembershipQueryKeys.delete(queryKey),
    }),
    pageRevisionFloors,
    refreshCoordinator: /** @type {ReturnType<typeof createReaderRefreshCoordinator>} */ (
      /** @type {unknown} */ (null)
    ),
    scopeActivation: null,
    scopeSequence: 0,
    scrollMarker: createScrollReadMarker(),
    snapshotRevisionFloor: 0,
    stickyMembershipQueryKeys,
  };
  const refreshLifecycle = createReaderRefreshLifecycle(input, runtime);
  input.patchCachedArticleField = (id, field, expectedValue, nextValue, article, options = {}) => {
    const currentState = input.getState();
    const currentArticles = input.getArticleState();
    const currentMembershipSensitive =
      currentState !== null &&
      !currentArticles.searchActive &&
      (field === 'readState'
        ? hasReadFilteredMembership(currentState, currentArticles)
        : currentState.activeScope.type === 'system' && currentState.activeScope.id === 'starred');
    if (currentMembershipSensitive) {
      runtime.stickyMembershipQueryKeys.add(readerQueryKey(currentState, currentArticles));
    }
    if (options.authoritativeDataRevision !== undefined) {
      runtime.pageCache.applyAuthoritativeArticleField(
        id,
        field,
        nextValue,
        options.authoritativeDataRevision,
        input.getSnapshot(),
        article,
      );
    } else {
      runtime.pageCache.patchArticleField(id, field, expectedValue, nextValue, input.getSnapshot(), article);
    }
  };
  const viewControls = createViewControls(input, runtime);
  const resetArticles = async () => {
    await loadArticles(input, runtime, 'reset');
  };
  return {
    ...createReaderInteractionActions(input, runtime, viewControls, resetArticles, refreshLifecycle),
    ...createReaderDataActions(input, runtime, resetArticles, refreshLifecycle),
  };
}

/** @param {ReaderControllerInput} input @param {ReaderRuntime} runtime @param {ReturnType<typeof createViewControls>} viewControls @param {() => Promise<void>} resetArticles @param {ReturnType<typeof createReaderRefreshLifecycle>} refreshLifecycle */
function createReaderInteractionActions(input, runtime, viewControls, resetArticles, refreshLifecycle) {
  return {
    /** @param {MouseEvent} event */
    async handleClick(event) {
      const viewControlResult = viewControls.handleClick(event);
      if (viewControlResult !== false && (await viewControlResult)) return;
      await handleReaderClick(input, runtime, event, {
        loadBootstrapSnapshot: (options) =>
          loadBootstrapSnapshot(input, runtime, refreshLifecycle.markRecoveryStatusPending, options),
        reloadReaderSnapshotAndArticles: (announceRefresh, options) =>
          reloadReaderSnapshotAndArticles(
            input,
            runtime,
            announceRefresh,
            refreshLifecycle.markRecoveryStatusPending,
            options,
          ),
      });
    },
    /** @param {KeyboardEvent} event */
    handleKeydown(event) {
      return handleReaderKeydown(input, runtime, event, resetArticles);
    },
    /** @param {InputEvent} event */
    handleInput(event) {
      return handleReaderInput(input, runtime, event, resetArticles);
    },
    /** @param {SubmitEvent} event */
    handleSubmit(event) {
      return handleReaderSubmit(input, runtime, event, resetArticles);
    },
    /**
     * @param {HTMLElement | null} [focusReturn]
     */
    openSearch(focusReturn = null) {
      openSearch(input, runtime, focusReturn);
    },
    closeSearch() {
      return closeSearch(input, runtime, resetArticles);
    },
  };
}

/** @param {ReaderControllerInput} input @param {ReaderRuntime} runtime @param {() => Promise<void>} resetArticles @param {ReturnType<typeof createReaderRefreshLifecycle>} refreshLifecycle */
function createReaderDataActions(input, runtime, resetArticles, refreshLifecycle) {
  return {
    async rememberScroll() {
      await rememberReaderScrollState(input);
    },
    restoreScroll() {
      const state = input.getState();
      if (state) restoreReaderScroll(input.options.documentRef, state);
    },
    async markCurrentScopeRead() {
      await runWithRefreshHold(runtime, () =>
        markCurrentScopeRead(input, {
          loadArticles: async () => {
            await loadArticles(input, runtime, 'reset', { membershipReconcile: true });
          },
          loadBootstrapSnapshot: async () =>
            (await loadBootstrapSnapshot(input, runtime, refreshLifecycle.markRecoveryStatusPending)).loaded,
        }),
      );
    },
    /** @template T @param {() => Promise<T>} operation @returns {Promise<T>} */
    async runWithRefreshHold(operation) {
      return runWithRefreshHold(runtime, operation);
    },
    /**
     * @param {boolean} [announceRefresh]
     * @param {LoadArticlesOptions} [options]
     */
    async reloadReaderData(announceRefresh = false, options = {}) {
      return reloadReaderSnapshotAndArticles(
        input,
        runtime,
        announceRefresh,
        refreshLifecycle.markRecoveryStatusPending,
        options,
      );
    },
    reloadReaderAfterVisibility: refreshLifecycle.reloadReaderAfterVisibility,
    resumeDeferredWork: refreshLifecycle.resumeDeferredWork,
    /** @param {import('./reader-settings.js').ReaderSettings} settings */
    async applyReaderSettings(settings) {
      const previous = input.getArticleState();
      const pageSizeChanged = previous.settings.articlesPerPage !== settings.articlesPerPage;
      input.setArticleState({ ...previous, settings });
      runtime.scrollMarker.reconcile(input);
      if (!pageSizeChanged) return;
      const currentState = input.getState();
      if (!currentState) return;
      const currentArticles = input.getArticleState();
      const queryKey = !currentArticles.searchActive ? readerQueryKey(currentState, currentArticles) : '';
      const cached = queryKey ? runtime.pageCache.get(queryKey) : null;
      if (cached) {
        input.setArticleState(
          articleStateFromCachedPage(cached, currentArticles, {
            expandedArticleId: currentState.expandedArticleId,
            preserveSearchQuery: true,
          }),
        );
        runtime.scrollMarker.reconcile(input);
        if (currentState.mode === 'reader') restoreReaderScroll(input.options.documentRef, currentState);
        return;
      }
      if (currentState.mode === 'reader' && input.options.documentRef.hidden !== true) {
        await loadArticles(input, runtime, 'reset', {
          deferLoadingStatus: true,
          membershipReconcile: true,
          preserveRows: true,
        });
        return;
      }
      runtime.refreshCoordinator.defer(
        currentReaderRefreshIntent(
          runtime,
          currentState,
          input.getArticleState(),
          input.getSnapshot().dataRevision,
          false,
        ),
      );
    },
    handleDataChangedEvent: refreshLifecycle.handleDataChangedEvent,
    shouldAnnounceReadyStatus: refreshLifecycle.shouldAnnounceReadyStatus,
  };
}

/** @template T @param {ReaderRuntime} runtime @param {() => Promise<T>} operation */
async function runWithRefreshHold(runtime, operation) {
  const releaseRefreshHold = runtime.refreshCoordinator.hold();
  try {
    return await operation();
  } finally {
    await releaseRefreshHold();
  }
}
