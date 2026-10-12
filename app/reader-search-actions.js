// @ts-check

import { createExpansionLayoutHooks } from './article-expansion-position.js';
import { handleArticleEscape } from './article-workflow.js';
import { scopeToStorageKey } from '../domain/scopes.js';
import { captureArticleListFocus, restoreArticleListFocus } from './article-list-focus.js';
import { reportEventError } from './event-boundary.js';
import { invalidateArticleLoad } from './reader-load-generation.js';
import { articleStateFromCachedPage } from './reader-page-cache.js';
import { currentReaderRefreshIntent } from './reader-refresh-intents.js';
import { readerQueryKey } from './reader-refresh-plan.js';
import { SEARCH_MIN_CODE_POINTS, normalizeSearchInput } from './reader-search-identity.js';
import { emptyArticleState } from './reader-state.js';
import { rememberReaderScroll, restoreReaderScroll } from './reader-scroll-state.js';
import { focusActiveMain } from './sidebar-shell.js';

const SEARCH_DEBOUNCE_MS = 200;
export { SEARCH_MIN_CODE_POINTS, normalizeSearchInput };
export { confirmAndMarkScopeRead, markCurrentScopeRead } from './reader-mark-scope-read.js';

export function createReaderRuntime() {
  return {
    loadingTimer: 0,
    requestSequence: 0,
    searchArticleFocusReturn: /** @type {ReturnType<typeof captureArticleListFocus>} */ (null),
    searchOriginExpandedArticleId: '',
    searchFocusReturn: /** @type {HTMLElement | null} */ (null),
    searchScrollPersistence: /** @type {Promise<void>} */ (Promise.resolve()),
    searchTimer: 0,
  };
}

/**
 * @param {import('./reader-controller.js').ReaderControllerInput} input
 * @param {import('./reader-controller.js').ReaderRuntime} runtime
 * @param {KeyboardEvent} event
 * @param {() => Promise<void>} reload
 */
export function handleReaderKeydown(input, runtime, event, reload) {
  if (event.key === 'Escape' && input.getArticleState().searchActive) {
    runReaderTask(input, 'reader-search-close-keydown', () => closeSearch(input, runtime, reload));
    return true;
  }
  return handleArticleEscape(input, event, createExpansionLayoutHooks(input, runtime));
}

/**
 * @param {import('./reader-controller.js').ReaderControllerInput} input
 * @param {ReturnType<typeof createReaderRuntime>} runtime
 * @param {InputEvent} event
 * @param {() => Promise<void>} reload
 */
export function handleReaderInput(input, runtime, event, reload) {
  const target = isHtmlElement(event.target) ? event.target : null;
  if (!target?.matches('[data-search-input]') || !('value' in target)) return false;
  const query = String(target.value);
  const previous = input.getArticleState();
  if (previous.searchActive && normalizeSearchInput(query) === normalizeSearchInput(previous.searchQuery)) {
    input.setArticleState({ ...previous, searchQuery: query });
    return true;
  }
  invalidateArticleLoad(input, runtime);
  input.setArticleState({
    ...previous,
    busy: false,
    freezeReadyRows: false,
    loadingStatusVisible: false,
    newArticlesAvailable: null,
    searchActive: true,
    searchQuery: query,
  });
  input.options.windowRef.clearTimeout(runtime.searchTimer);
  runtime.searchTimer = input.options.windowRef.setTimeout(() => {
    runReaderTask(input, 'reader-search-input-reload', async () => {
      await runtime.searchScrollPersistence;
      await reload();
    });
  }, SEARCH_DEBOUNCE_MS);
  return true;
}

/**
 * @param {import('./reader-controller.js').ReaderControllerInput} input
 * @param {ReturnType<typeof createReaderRuntime>} runtime
 * @param {SubmitEvent} event
 * @param {() => Promise<void>} reload
 */
export function handleReaderSubmit(input, runtime, event, reload) {
  const target = isHtmlElement(event.target) ? event.target : null;
  if (!target?.matches('[data-search-form]')) return false;
  event.preventDefault();
  input.options.windowRef.clearTimeout(runtime.searchTimer);
  runReaderTask(input, 'reader-search-submit-reload', async () => {
    await runtime.searchScrollPersistence;
    await reload();
  });
  return true;
}

/**
 * @param {import('./reader-controller.js').ReaderControllerInput} input
 * @param {ReturnType<typeof createReaderRuntime>} runtime
 * @param {HTMLElement | null} [focusReturn]
 */
export function openSearch(input, runtime, focusReturn = null) {
  const current = input.getState();
  if (!current || current.mode !== 'reader') return;
  const previous = input.getArticleState();
  if (!previous.searchActive) {
    const activeElement = input.options.documentRef.activeElement;
    runtime.searchFocusReturn = isHtmlElement(focusReturn)
      ? focusReturn
      : isHtmlElement(activeElement)
        ? activeElement
        : null;
    const listRoot = input.options.documentRef.querySelector('[data-reader-list-root]');
    runtime.searchArticleFocusReturn = isHtmlElement(listRoot) ? captureArticleListFocus(listRoot) : null;
    runtime.searchOriginExpandedArticleId = current.expandedArticleId;
    runtime.searchScrollPersistence = rememberSearchOriginScroll(input);
    invalidateArticleLoad(input, runtime);
  }
  input.setArticleState({
    ...previous,
    busy: false,
    freezeReadyRows: false,
    loadingStatusVisible: false,
    newArticlesAvailable: null,
    searchActive: true,
  });
  focusSearchInput(input.options.documentRef, previous.searchQuery);
}

/**
 * @param {import('./reader-controller.js').ReaderControllerInput} input
 * @param {import('./reader-controller.js').ReaderRuntime} runtime
 * @param {() => Promise<void>} reload
 */
export async function closeSearch(input, runtime, reload) {
  input.options.windowRef.clearTimeout(runtime.searchTimer);
  await runtime.searchScrollPersistence;
  const previous = input.getArticleState();
  invalidateArticleLoad(input, runtime);
  const normal = {
    ...previous,
    busy: false,
    freezeReadyRows: false,
    loadingStatusVisible: false,
    newArticlesAvailable: null,
    searchActive: false,
    statusCanRetry: false,
    statusMessage: '',
  };
  const current = input.getState();
  const queryKey = current ? readerQueryKey(current, normal) : '';
  const cached = queryKey
    ? (runtime.pageCache.get(queryKey) ??
      (runtime.stickyMembershipQueryKeys.has(queryKey) ? runtime.pageCache.peek(queryKey) : null))
    : null;
  if (cached) {
    const expandedArticleId = current?.expandedArticleId ?? '';
    const expansionStillPresent = cached.items.some((item) => item.id === expandedArticleId);
    await input.writeReaderState(
      { expandedArticleId: expansionStillPresent ? expandedArticleId : '' },
      searchCloseStateFromCachedPage(cached, normal, expandedArticleId),
    );
    runtime.scrollMarker.reconcile(input);
    const restoredState = input.getState();
    if (restoredState?.mode === 'reader') restoreReaderScroll(input.options.documentRef, restoredState);
  } else if (current?.mode === 'reader') {
    input.setArticleState(normal);
    await reload();
  } else if (current) {
    const reset = {
      ...emptyArticleState(),
      busy: true,
      searchQuery: normal.searchQuery,
      settings: normal.settings,
      status: /** @type {const} */ ('loading'),
    };
    input.setArticleState(reset);
    runtime.refreshCoordinator.defer(
      currentReaderRefreshIntent(
        runtime,
        current,
        reset,
        input.getSnapshot().dataRevision,
        false,
        input.getSnapshot().dataRevision,
      ),
    );
  }
  runtime.searchOriginExpandedArticleId = '';
  restoreSearchFocus(input, runtime);
}

/** @param {import('./reader-controller.js').ReaderControllerInput} input */
async function rememberSearchOriginScroll(input) {
  await rememberReaderScroll(input.options.documentRef, input);
}

/**
 * @param {import('./reader-page-cache.js').ReaderPageCacheEntry} cached
 * @param {import('./reader-state.js').ArticleState} previous
 * @param {string} expandedArticleId
 */
function searchCloseStateFromCachedPage(cached, previous, expandedArticleId) {
  return articleStateFromCachedPage(cached, previous, {
    expandedArticleId,
    preserveSearchQuery: true,
  });
}

/**
 * @param {import('./reader-controller.js').ReaderControllerInput} input
 * @param {import('./reader-controller.js').ReaderRuntime} runtime
 */
function restoreSearchFocus(input, runtime) {
  const target = runtime.searchFocusReturn;
  const articleTarget = runtime.searchArticleFocusReturn;
  runtime.searchFocusReturn = null;
  runtime.searchArticleFocusReturn = null;
  if (focusUsableElement(input.options.documentRef, target)) return;
  const current = input.getState();
  const listRoot = input.options.documentRef.querySelector('[data-reader-list-root]');
  if (current?.mode === 'reader' && articleTarget && isHtmlElement(listRoot)) {
    restoreArticleListFocus(listRoot, articleTarget);
    if (input.options.documentRef.activeElement !== input.options.documentRef.body) return;
  }
  if (current?.mode === 'reader') {
    const scopeKey = scopeToStorageKey(current.activeScope);
    for (const candidate of input.options.documentRef.querySelectorAll('[data-reader-sidebar] [data-scope-key]')) {
      if (isHtmlElement(candidate) && candidate.dataset.scopeKey === scopeKey) {
        if (focusUsableElement(input.options.documentRef, candidate)) return;
        break;
      }
    }
  }
  focusActiveMain(input.options.documentRef);
}

/** @param {Document} documentRef @param {HTMLElement | null} target */
function focusUsableElement(documentRef, target) {
  if (
    !target?.isConnected ||
    target.hidden ||
    target.closest('[hidden], [inert]') ||
    target.getAttribute('aria-disabled') === 'true' ||
    ('disabled' in target && target.disabled === true)
  ) {
    return false;
  }
  target.focus();
  return documentRef.activeElement === target;
}

/**
 * @param {Document} documentRef
 * @param {string} query
 */
function focusSearchInput(documentRef, query) {
  const input = documentRef.querySelector('[data-search-input]');
  if (!isHtmlElement(input) || !('focus' in input) || typeof input.focus !== 'function') return;
  input.focus();
  if ('value' in input) {
    const length = query.length;
    /** @type {HTMLInputElement} */ (input).setSelectionRange(0, length);
  }
}

/**
 * @param {import('./reader-controller.js').ReaderControllerInput} input
 * @param {string} operation
 * @param {() => Promise<void>} task
 */
function runReaderTask(input, operation, task) {
  void task().catch((error) => reportEventError(input.options, error, operation));
}

/**
 * @param {{getMessage(key: string, substitutions?: string | number | Array<string | number>): string}} i18n
 * @param {boolean} searchActive
 * @param {number} resultCount
 */
export function searchStatusMessage(i18n, searchActive, resultCount) {
  if (!searchActive || resultCount === 0) return '';
  return i18n.getMessage('searchResultsCount', resultCount);
}

/**
 * @param {unknown} value
 * @returns {value is HTMLElement}
 */
function isHtmlElement(value) {
  return typeof value === 'object' && value !== null && 'nodeType' in value && value.nodeType === 1;
}
