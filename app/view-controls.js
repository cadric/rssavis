// @ts-check

import { isHtmlElement } from './app-shell-utils.js';
import { ARTICLE_FILTER, isArticleFilter } from './article-filter.js';
import { loadArticles, scopeArticleResetState } from './reader-article-loader.js';
import { invalidateArticleLoad } from './reader-load-generation.js';
import { articleStateFromCachedPage } from './reader-page-cache.js';
import { readerQueryKey } from './reader-refresh-plan.js';
import { announceStatus } from './toasts.js';

const FILTER_ANNOUNCEMENT = Object.freeze({
  [ARTICLE_FILTER.ALL]: 'articleFilterAppliedAll',
  [ARTICLE_FILTER.UNREAD]: 'articleFilterAppliedUnread',
  [ARTICLE_FILTER.READ]: 'articleFilterAppliedRead',
});

/**
 * @param {import('./reader-controller.js').ReaderControllerInput} input
 * @param {import('./reader-controller.js').ReaderRuntime} runtime
 */
export function createViewControls(input, runtime) {
  /** @type {import('./article-filter.js').ArticleFilter | null} */
  let desiredArticleFilter = null;
  /** @type {'compact' | 'normal' | 'large' | null} */
  let desiredArticleView = null;
  let filterIntentSequence = 0;
  let filterIntentQueue = Promise.resolve();
  let viewIntentSequence = 0;
  let viewIntentQueue = Promise.resolve();

  /** @param {MouseEvent} event @returns {false | Promise<true>} */
  function handleClick(event) {
    const target = isHtmlElement(event.target) ? event.target : null;
    if (!target) return false;
    const filterButton = target.closest('button[data-article-filter]');
    if (isHtmlElement(filterButton)) {
      return setArticleFilter(filterButton.dataset.articleFilter ?? '').then(() => true);
    }
    if (target.closest('[data-article-filter-show-all]')) {
      return setArticleFilter(ARTICLE_FILTER.ALL).then(() => true);
    }
    const viewButton = target.closest('button[data-article-view]');
    if (!isHtmlElement(viewButton)) return false;
    const view = viewButton.dataset.articleView;
    if (view !== 'compact' && view !== 'normal' && view !== 'large') return Promise.resolve(true);
    return setArticleView(view).then(() => true);
  }

  /** @param {unknown} target */
  function setArticleFilter(target) {
    const current = input.getState();
    if (!current) return Promise.resolve();
    if (desiredArticleFilter === null) desiredArticleFilter = current.articleFilter;
    if (!isArticleFilter(target)) throw new TypeError('Invalid article filter.');
    if (!isFilterControlAvailable(input) || target === desiredArticleFilter) return Promise.resolve();
    desiredArticleFilter = target;
    const intent = ++filterIntentSequence;
    const scopeSequence = runtime.scopeSequence;
    invalidateArticleLoad(input, runtime);
    const result = filterIntentQueue.then(() => applyFilterIntent(target, intent, scopeSequence));
    filterIntentQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * @param {import('./article-filter.js').ArticleFilter} target
   * @param {number} intent
   * @param {number} scopeSequence
   */
  async function applyFilterIntent(target, intent, scopeSequence) {
    if (!isArticleFilter(target) || intent !== filterIntentSequence) return;
    let cacheHit = false;
    try {
      await input.writeReaderState(
        { articleFilter: target, expandedArticleId: '', scrollByScope: {} },
        (nextState) => {
          const currentArticles = input.getArticleState();
          const cached = runtime.pageCache.get(readerQueryKey(nextState, currentArticles));
          if (cached) {
            cacheHit = true;
            return articleStateFromCachedPage(cached, currentArticles, { preserveSearchQuery: true });
          }
          return scopeArticleResetState(input, runtime, { deferLoadingStatus: true });
        },
        { applyIf: () => intent === filterIntentSequence },
      );
    } catch (error) {
      if (intent !== filterIntentSequence) return;
      desiredArticleFilter = input.getState()?.articleFilter ?? ARTICLE_FILTER.ALL;
      await loadArticles(input, runtime, 'reset', {
        deferLoadingStatus: true,
        membershipReconcile: true,
      });
      throw error;
    }
    if (intent !== filterIntentSequence) return;
    if (scopeSequence !== runtime.scopeSequence || !isFilterControlAvailable(input)) {
      if (!cacheHit && (input.isReaderContextAvailable?.() === false || input.getState()?.mode !== 'reader')) {
        deferFilterReconciliation(input, runtime);
      }
      return;
    }
    const reader = input.options.documentRef.querySelector('[data-reader-main]');
    if (isHtmlElement(reader)) reader.scrollTop = 0;
    runtime.scrollMarker.reconcile(input);
    const painted =
      cacheHit ||
      (await loadArticles(input, runtime, 'reset', {
        deferLoadingStatus: true,
        membershipReconcile: true,
      }));
    if (
      !painted ||
      intent !== filterIntentSequence ||
      scopeSequence !== runtime.scopeSequence ||
      !isFilterControlAvailable(input) ||
      input.options.documentRef.hidden === true
    ) {
      return;
    }
    announceStatus(input.options.documentRef, input.options.browserApi.i18n.getMessage(FILTER_ANNOUNCEMENT[target]));
  }

  /** @param {'compact' | 'normal' | 'large'} target */
  function setArticleView(target) {
    const current = input.getState();
    if (!current) return Promise.resolve();
    if (desiredArticleView === null) desiredArticleView = current.articleView;
    if (target === desiredArticleView) return Promise.resolve();
    desiredArticleView = target;
    const intent = ++viewIntentSequence;
    const result = viewIntentQueue.then(async () => {
      if (intent !== viewIntentSequence) return;
      try {
        await input.writeState({ articleView: target }, { applyIf: () => intent === viewIntentSequence });
      } catch (error) {
        if (intent === viewIntentSequence) desiredArticleView = input.getState()?.articleView ?? 'normal';
        throw error;
      }
    });
    viewIntentQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return { handleClick, setArticleFilter };
}

/** @param {import('./reader-controller.js').ReaderControllerInput} input @param {import('./reader-controller.js').ReaderRuntime} runtime */
function deferFilterReconciliation(input, runtime) {
  const state = input.getState();
  if (!state) return;
  const articleState = input.getArticleState();
  runtime.refreshCoordinator.defer({
    includesFeedIngest: false,
    kind: 'reconcile',
    queryKey: readerQueryKey(state, articleState),
    readerEpoch: runtime.refreshCoordinator.readerEpoch(),
    revisionReset: false,
    scopeSequence: runtime.scopeSequence,
    targetRevision: Math.max(input.getSnapshot().dataRevision, articleState.dataRevision),
  });
}

/** @param {import('./reader-controller.js').ReaderControllerInput} input */
function isFilterControlAvailable(input) {
  const state = input.getState();
  if (!state || state.mode !== 'reader' || input.isReaderContextAvailable?.() === false) return false;
  if (input.getArticleState().searchActive) return false;
  return state.activeScope.type !== 'system' || state.activeScope.id !== 'unread';
}
