// @ts-check

import { normalizeScope, scopeToStorageKey } from '../domain/scopes.js';
import { refreshAllFeeds } from './api-client.js';
import { isHtmlElement } from './app-shell-utils.js';
import { createExpansionLayoutHooks } from './article-expansion-position.js';
import { ARTICLE_ACTION_SELECTOR, shouldUseArticleBridgeNavigation } from './article-link-navigation.js';
import { closeExpandedArticle, handleArticleActionClick } from './article-workflow.js';
import { newArticlesQueryKey } from './new-articles-availability.js';
import { articleStateFromCachedPage } from './reader-page-cache.js';
import { currentReaderRefreshIntent } from './reader-refresh-intents.js';
import { loadArticles, scopeArticleResetState } from './reader-article-loader.js';
import { invalidateArticleLoad } from './reader-load-generation.js';
import { readerQueryKey } from './reader-refresh-plan.js';
import { closeSearch } from './reader-search-actions.js';
import { rememberReaderScroll, restoreReaderScroll } from './reader-scroll-state.js';
import { scopeExists } from './scope-reconciliation.js';
import { beginRefreshAllProgress, completeRefreshAllProgress, endRefreshAllProgress } from './refresh-all-progress.js';

/**
 * @typedef {object} ReaderClickActions
 * @property {(options?: {preserveResolvedOnError?: boolean}) => Promise<{loaded: boolean, scopeChanged: boolean}>} loadBootstrapSnapshot
 * @property {(announceRefresh: boolean, options?: import('./reader-article-loader.js').LoadArticlesOptions) => Promise<unknown>} reloadReaderSnapshotAndArticles
 */

/**
 * @param {import('./reader-controller.js').ReaderControllerInput} input
 * @param {import('./reader-controller.js').ReaderRuntime} runtime
 * @param {MouseEvent} event
 * @param {ReaderClickActions} actions
 */
export async function handleReaderClick(input, runtime, event, actions) {
  const target = isHtmlElement(event.target) ? event.target : null;
  if (!target) return;
  const categoryToggle = target.closest('[data-category-toggle]');
  if (isHtmlElement(categoryToggle)) {
    await toggleCategory(input, categoryToggle);
    return;
  }
  const scopeButton = target.closest('[data-scope-key]');
  if (isHtmlElement(scopeButton)) {
    const nextScope = parseScope(scopeButton);
    const nextKey = scopeToStorageKey(nextScope);
    const currentScope = input.getState()?.activeScope;
    if (currentScope && scopeToStorageKey(currentScope) === nextKey && runtime.scopeActivation === null) return;
    if (runtime.scopeActivation?.key === nextKey) {
      await runtime.scopeActivation.promise;
      return;
    }
    const promise = activateScope(input, runtime, nextScope);
    runtime.scopeActivation = { key: nextKey, promise };
    try {
      await promise;
    } finally {
      if (runtime.scopeActivation?.promise === promise) runtime.scopeActivation = null;
    }
    return;
  }
  if (target.closest('[data-load-more]')) {
    if (input.getArticleState().busy) return;
    await loadArticles(input, runtime, 'append');
    return;
  }
  if (target.closest('[data-reader-retry]')) {
    await actions.reloadReaderSnapshotAndArticles(true, { membershipReconcile: true });
    return;
  }
  if (target.closest('[data-search-close]')) {
    await closeSearch(input, runtime, async () => {
      await loadArticles(input, runtime, 'reset');
    });
    return;
  }
  const articleAction = target.closest(ARTICLE_ACTION_SELECTOR);
  if (isHtmlElement(articleAction)) {
    if (shouldUseArticleBridgeNavigation(event, articleAction)) return;
    event.preventDefault();
  }
  if (await handleArticleActionClick(input, target, createExpansionLayoutHooks(input, runtime))) return;
  const newArticlesAction = target.closest('[data-new-articles-action]');
  if (isHtmlElement(newArticlesAction)) {
    await showNewArticles(input, runtime, actions, input.options.documentRef.activeElement === newArticlesAction);
    return;
  }
  if (target.closest('[data-refresh-all]')) await refreshAll(input, actions);
}

/**
 * @param {import('./reader-controller.js').ReaderControllerInput} input
 * @param {import('./reader-controller.js').ReaderRuntime} runtime
 * @param {import('../domain/scopes.js').Scope} nextScope
 */
async function activateScope(input, runtime, nextScope) {
  const activationSequence = (runtime.scopeSequence += 1);
  const activationCurrent = () =>
    activationSequence === runtime.scopeSequence && scopeExists(nextScope, input.getSnapshot());
  invalidateArticleLoad(input, runtime);
  const scrollPersistence = rememberReaderScroll(input.options.documentRef, input);
  await scrollPersistence;
  if (!activationCurrent()) return;
  await closeExpandedArticle(input);
  if (!activationCurrent()) return;
  let cacheHit = false;
  await input.writeReaderState(
    { activeScope: nextScope, expandedArticleId: '' },
    (nextState) => {
      const currentArticles = input.getArticleState();
      const cacheKey = !currentArticles.searchActive
        ? readerQueryKey(nextState, currentArticles, currentArticles.settings.articlesPerPage)
        : '';
      const cached = cacheKey ? runtime.pageCache.get(cacheKey) : null;
      if (cached) {
        cacheHit = true;
        return articleStateFromCachedPage(cached, currentArticles, { preserveSearchQuery: true });
      }
      return scopeArticleResetState(input, runtime, { deferLoadingStatus: true });
    },
    { applyIf: activationCurrent },
  );
  if (!activationCurrent()) return;
  if (cacheHit) {
    runtime.scrollMarker.reconcile(input);
    const current = input.getState();
    if (current) restoreReaderScroll(input.options.documentRef, current);
    return;
  }
  const painted = await loadArticles(input, runtime, 'reset', {
    deferLoadingStatus: true,
    membershipReconcile: true,
  });
  if (painted || !activationCurrent()) return;
  const current = input.getState();
  if (!current || (current.mode === 'reader' && input.options.documentRef.hidden !== true)) return;
  runtime.refreshCoordinator.defer(
    currentReaderRefreshIntent(runtime, current, input.getArticleState(), input.getSnapshot().dataRevision, false),
  );
}

/** @param {import('./reader-controller.js').ReaderControllerInput} input @param {import('./reader-controller.js').ReaderRuntime} runtime @param {ReaderClickActions} actions @param {boolean} returnKeyboardFocus */
async function showNewArticles(input, runtime, actions, returnKeyboardFocus) {
  await rememberReaderScroll(input.options.documentRef, input);
  const state = input.getState();
  const articleState = input.getArticleState();
  const available = articleState.newArticlesAvailable;
  if (!state || state.mode !== 'reader' || !available || available.busy) return;
  const queryKey = newArticlesQueryKey(state, articleState);
  if (queryKey !== available.queryKey) return;
  input.setArticleState({
    ...articleState,
    newArticlesAvailable: { ...available, busy: true },
  });
  const snapshotResult = await actions.loadBootstrapSnapshot({ preserveResolvedOnError: true });
  if (!snapshotResult.loaded) {
    if (returnKeyboardFocus) focusNewArticlesAction(input.options.documentRef);
    return;
  }
  const currentState = input.getState();
  const currentArticles = input.getArticleState();
  const currentAvailability = currentArticles.newArticlesAvailable;
  const currentQueryKey = currentState ? newArticlesQueryKey(currentState, currentArticles) : '';
  if (!snapshotResult.scopeChanged && currentQueryKey !== queryKey) return;
  if (!currentState || currentState.mode !== 'reader' || snapshotResult.scopeChanged || currentQueryKey !== queryKey) {
    const restoreOffRouteAction =
      currentState?.mode !== 'reader' &&
      !snapshotResult.scopeChanged &&
      currentQueryKey === queryKey &&
      currentAvailability?.queryKey === queryKey;
    if (restoreOffRouteAction && currentAvailability) {
      input.setArticleState({
        ...currentArticles,
        newArticlesAvailable: { ...currentAvailability, busy: false },
      });
      return;
    }
    const resetArticles = { ...currentArticles, freezeReadyRows: false, newArticlesAvailable: null };
    input.setArticleState(resetArticles);
    if (currentState?.mode === 'reader') {
      await loadArticles(input, runtime, 'reset', {
        deferLoadingStatus: true,
        membershipReconcile: true,
      });
    } else if (currentState && snapshotResult.scopeChanged) {
      const nextQueryKey = readerQueryKey(currentState, resetArticles);
      runtime.pageCache.markStale(nextQueryKey);
      runtime.refreshCoordinator.defer(
        currentReaderRefreshIntent(
          runtime,
          currentState,
          resetArticles,
          input.getSnapshot().dataRevision,
          true,
          input.getSnapshot().dataRevision,
          false,
          true,
        ),
      );
    }
    if (returnKeyboardFocus) focusReaderMain(input.options.documentRef);
    return;
  }
  const painted = await loadArticles(input, runtime, 'reset', {
    membershipReconcile: true,
    newArticlesQueryKey: queryKey,
    preserveResolvedOnError: true,
    preserveRows: true,
  });
  if (returnKeyboardFocus) {
    if (painted) focusReaderMain(input.options.documentRef);
    else focusNewArticlesAction(input.options.documentRef);
  }
}

/** @param {Document} documentRef */
function focusReaderMain(documentRef) {
  const main = documentRef.querySelector('[data-reader-main]');
  if (isHtmlElement(main)) main.focus();
}

/** @param {Document} documentRef */
function focusNewArticlesAction(documentRef) {
  const action = documentRef.querySelector('[data-new-articles-action]');
  if (isHtmlElement(action)) action.focus();
}

/** @param {import('./reader-controller.js').ReaderControllerInput} input @param {ReaderClickActions} actions */
async function refreshAll(input, actions) {
  beginRefreshAllProgress({ documentRef: input.options.documentRef, i18n: input.options.browserApi.i18n });
  try {
    const summary = await refreshAllFeeds(input.options.browserApi);
    completeRefreshAllProgress(
      { documentRef: input.options.documentRef, i18n: input.options.browserApi.i18n },
      summary,
    );
    await actions.loadBootstrapSnapshot();
  } finally {
    endRefreshAllProgress(input.options.documentRef);
  }
}

/** @param {import('./reader-controller.js').ReaderControllerInput} input @param {HTMLElement} categoryToggle */
async function toggleCategory(input, categoryToggle) {
  const current = input.getState();
  const key = categoryToggle.dataset.categoryKey ?? '';
  if (current && key) {
    await input.writeState({
      categoryCollapsed: { ...current.categoryCollapsed, [key]: !current.categoryCollapsed[key] },
    });
  }
}

/** @param {HTMLElement} element */
function parseScope(element) {
  return normalizeScope({ id: element.dataset.scopeId, type: element.dataset.scopeType });
}
