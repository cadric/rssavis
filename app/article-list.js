// @ts-check

import { createArticleRow, patchArticleRow } from './article-row.js';
import { captureArticleListRenderFocus, restoreArticleListRenderFocus } from './article-list-focus.js';
import { reconcileReadyArticleList } from './article-list-keyed.js';
import { MAX_RENDERED_ARTICLE_ROWS } from './article-list-limits.js';
import {
  canReconcileReadyRows,
  cachedRenderFor,
  isSemanticallyIdenticalRender,
  patchableRowIds,
  patchStateFor,
  rememberRender,
  unpatchableRenderReason,
} from './article-list-patch.js';
import { DEFAULT_READER_SETTINGS } from './reader-settings.js';
import { cloneTemplate, queryRequired } from './templates.js';

export { MAX_RENDERED_ARTICLE_ROWS } from './article-list-limits.js';

/** @type {Map<string, string>} */
const EMPTY_FEED_TITLE_MAP = new Map();

/**
 * @typedef {object} ArticleListState
 * @property {string} activeFeedId
 * @property {string} [activeScopeLabel]
 * @property {'compact' | 'normal' | 'large'} articleView
 * @property {boolean} [busy]
 * @property {'' | 'filtered-unread' | 'filtered-read'} [emptyVariant]
 * @property {string} expandedArticleId
 * @property {Map<string, string>} [feedTitleById]
 * @property {boolean} [freezeReadyRows]
 * @property {boolean} [hasFeeds]
 * @property {boolean} hasMore
 * @property {Array<Record<string, unknown>>} items
 * @property {boolean} [loadingStatusVisible]
 * @property {string} locale
 * @property {Record<string, import('./article-preview.js').PreviewEntry>} [previewByArticleId]
 * @property {import('./reader-settings.js').ReaderSettings} [settings]
 * @property {boolean} [searchActive]
 * @property {'empty' | 'error' | 'loading' | 'ready'} status
 * @property {'' | 'show-all'} [statusAction]
 * @property {boolean} [statusCanRetry]
 * @property {string} [statusMessage]
 * @property {string} timeZone
 * @property {boolean} [unreadScope]
 * @property {(key: string) => string} [getMessage]
 */

/**
 * @param {Document} documentRef
 * @param {ArticleListState} state
 * @returns {{renderedCount: number, trimmedCount: number}}
 */
export function renderArticleList(documentRef, state) {
  const root = requireElement(documentRef, '[data-reader-list-root]');
  const statusRoot = requireElement(documentRef, '[data-reader-status-root]');
  const focusTarget = captureArticleListRenderFocus(root, state.busy === true);
  syncLoadMoreBusy(documentRef, root, state.busy === true);
  const items = boundedRows(state.items);
  const patchState = currentPatchState(state, items);
  const cached = cachedRenderFor(root);
  if (cached && isSemanticallyIdenticalRender(cached, patchState)) {
    restoreArticleListRenderFocus(root, focusTarget, state.busy === true);
    return { renderedCount: items.length, trimmedCount: Math.max(0, state.items.length - items.length) };
  }
  if (patchRenderedRows(documentRef, root, state, items)) {
    restoreArticleListRenderFocus(root, focusTarget, state.busy === true);
    return { renderedCount: items.length, trimmedCount: Math.max(0, state.items.length - items.length) };
  }
  if (cached && canReconcileReadyRows(cached, patchState)) {
    reconcileRows(documentRef, root, state, items);
    syncLoadMoreBusy(documentRef, root, state.busy === true);
    rememberRender(root, patchState);
    restoreArticleListRenderFocus(root, focusTarget, state.busy === true);
    return { renderedCount: items.length, trimmedCount: Math.max(0, state.items.length - items.length) };
  }
  root.replaceChildren();
  statusRoot.replaceChildren();
  const statusPage = createStatusPage(documentRef, state, items.length);
  if (statusPage) statusRoot.append(statusPage);
  if (items.length > 0) reconcileRows(documentRef, root, state, items);
  syncLoadMoreBusy(documentRef, root, state.busy === true);
  rememberRender(root, currentPatchState(state, items));
  restoreArticleListRenderFocus(root, focusTarget, state.busy === true);

  return { renderedCount: items.length, trimmedCount: Math.max(0, state.items.length - items.length) };
}

/** @param {Document} documentRef @param {HTMLElement} root @param {boolean} busy */
function syncLoadMoreBusy(documentRef, root, busy) {
  const button = root.querySelector('[data-load-more]');
  if (button instanceof requireView(documentRef).HTMLButtonElement) button.disabled = busy;
}

/**
 * @param {string} value
 */
function cssEscape(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

/** @param {Document} documentRef @param {HTMLElement} root @param {ArticleListState} state @param {Array<Record<string, unknown>>} items */
function reconcileRows(documentRef, root, state, items) {
  reconcileReadyArticleList(documentRef, root, items, {
    createRow: (article) => createRow(documentRef, state, article),
    hasMore: state.hasMore,
    loadMoreLabel: getMessage(state, 'articleLoadMore'),
    locale: state.locale,
    patchRow: (row, article) => patchArticleRow(documentRef, row, article, rowOptions(state, article)),
    timeZone: state.timeZone,
  });
}

/**
 * @param {Document} documentRef
 * @param {HTMLElement} root
 * @param {ArticleListState} state
 * @param {Array<Record<string, unknown>>} items
 */
function patchRenderedRows(documentRef, root, state, items) {
  const cached = cachedRenderFor(root);
  const patchState = currentPatchState(state, items);
  if (
    state.freezeReadyRows === true &&
    cached?.items === patchState.items &&
    unpatchableRenderReason(cached, patchState) === 'settings'
  ) {
    for (const article of items) {
      const id = typeof article.id === 'string' ? article.id : '';
      const row = root.querySelector(`[data-article-id="${cssEscape(id)}"]`);
      if (id && isHtmlElement(documentRef, row)) patchArticleRow(documentRef, row, article, rowOptions(state, article));
    }
    rememberRender(root, patchState);
    return true;
  }
  const ids = cached ? patchableRowIds(cached, patchState) : null;
  if (!cached || !ids) return false;
  if (cached.previewByArticleId !== patchState.previewByArticleId && patchState.expandedArticleId)
    ids.add(patchState.expandedArticleId);
  for (const id of ids) {
    if (!id) continue;
    const row = root.querySelector(`[data-article-id="${cssEscape(id)}"]`);
    const article = items.find((item) => item.id === id);
    if (isHtmlElement(documentRef, row) && article)
      patchArticleRow(documentRef, row, article, rowOptions(state, article));
  }
  rememberRender(root, patchState);
  return true;
}

/**
 * @param {ArticleListState} state
 * @param {Array<Record<string, unknown>>} items
 * @returns {Parameters<typeof patchableRowIds>[1]}
 */
function currentPatchState(state, items) {
  return patchStateFor(
    state,
    items,
    settingsCacheKey(settingsForState(state)),
    feedTitleSignature(state.feedTitleById, items),
  );
}

/**
 * @param {Map<string, string> | undefined} map
 * @param {Array<Record<string, unknown>>} items
 * @returns {string}
 */
function feedTitleSignature(map, items) {
  if (!map || map.size === 0) return '';
  const visibleFeedIds = new Set(
    items.map((item) => (typeof item.feedId === 'string' ? item.feedId : '')).filter(Boolean),
  );
  const visibleTitles = [...map.entries()]
    .filter(([id]) => visibleFeedIds.has(id))
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  return JSON.stringify(visibleTitles);
}

/**
 * @param {Document} documentRef
 * @param {ArticleListState} state
 * @param {Record<string, unknown>} article
 */
function createRow(documentRef, state, article) {
  return createArticleRow(documentRef, article, rowOptions(state, article));
}

/** @param {ArticleListState} state @param {Record<string, unknown>} article */
function rowOptions(state, article) {
  return {
    activeFeedId: state.activeFeedId,
    articleView: state.articleView,
    expandedArticleId: state.expandedArticleId,
    feedTitleById: state.feedTitleById ?? EMPTY_FEED_TITLE_MAP,
    getMessage: (/** @type {string} */ key) => getMessage(state, key),
    locale: state.locale,
    preview: previewForArticle(state, article),
    settings: settingsForState(state),
    timeZone: state.timeZone,
  };
}

/**
 * @param {ArticleListState} state
 * @param {Record<string, unknown>} article
 */
function previewForArticle(state, article) {
  const id = typeof article.id === 'string' ? article.id : '';
  return id ? state.previewByArticleId?.[id] : undefined;
}

/**
 * @param {Document} documentRef
 * @param {ArticleListState} state
 */
/** @param {Document} documentRef @param {ArticleListState} state @param {number} itemCount */
function createStatusPage(documentRef, state, itemCount) {
  const statusState = statusPageState(state, itemCount);
  if (!statusState) return null;
  const section = cloneTemplate(documentRef, 'data-status-page-template', '[data-status-page]');
  const content = statusPageContent(state, statusState);
  section.dataset.statusState = statusState;
  section.dataset.statusVariant = itemCount > 0 ? 'compact' : 'full';
  queryRequired(section, '[data-status-page-heading]').textContent = content.heading;
  queryRequired(section, '[data-status-page-body]').textContent = content.body;
  const kicker = queryRequired(section, '[data-status-page-kicker]');
  if (state.activeScopeLabel && statusState === 'empty') {
    kicker.hidden = false;
    kicker.textContent = state.activeScopeLabel;
  } else {
    kicker.remove();
  }
  const visual = queryRequired(section, '[data-status-page-visual]');
  if (itemCount > 0) visual.remove();
  configureStatusAction(documentRef, section, statusState, state);
  return section;
}

/**
 * @param {ArticleListState} state
 * @param {number} itemCount
 * @returns {'empty' | 'loading' | 'error' | 'no-results' | ''}
 */
function statusPageState(state, itemCount) {
  if (state.status === 'error') return 'error';
  if (state.status === 'loading' && state.loadingStatusVisible !== false) return 'loading';
  if (state.status === 'empty' && state.searchActive) return 'no-results';
  if (itemCount === 0 && (state.status === 'empty' || state.status === 'ready')) return 'empty';
  return '';
}

/**
 * @param {ArticleListState} state
 * @param {'empty' | 'loading' | 'error' | 'no-results'} statusState
 */
function statusPageContent(state, statusState) {
  if (statusState === 'loading') {
    return { heading: getMessage(state, 'articlesLoadingTitle'), body: getMessage(state, 'articlesLoading') };
  }
  if (statusState === 'error') {
    return {
      heading: getMessage(state, 'articlesLoadFailedTitle'),
      body: state.statusMessage || getMessage(state, 'articlesLoadFailed'),
    };
  }
  if (statusState === 'no-results') {
    return { heading: getMessage(state, 'searchEmptyTitle'), body: getMessage(state, 'searchEmpty') };
  }
  if (state.emptyVariant === 'filtered-unread') {
    return {
      heading: getMessage(state, 'articleFilterEmptyUnreadTitle'),
      body: getMessage(state, 'articleFilterEmptyUnreadBody'),
    };
  }
  if (state.emptyVariant === 'filtered-read') {
    return {
      heading: getMessage(state, 'articleFilterEmptyReadTitle'),
      body: getMessage(state, 'articleFilterEmptyReadBody'),
    };
  }
  if (state.unreadScope === true && state.hasFeeds === true) {
    return {
      heading: getMessage(state, 'articleFilterEmptyUnreadTitle'),
      body: getMessage(state, 'articleFilterEmptyUnreadBody'),
    };
  }
  if (state.hasFeeds === true) {
    return {
      heading: getMessage(state, 'readerScopeEmptyTitle'),
      body: getMessage(state, 'readerScopeEmptyBody'),
    };
  }
  return { heading: getMessage(state, 'readerEmptyTitle'), body: getMessage(state, 'readerEmptyBody') };
}

/**
 * @param {Document} documentRef
 * @param {HTMLElement} section
 * @param {'empty' | 'loading' | 'error' | 'no-results'} statusState
 * @param {ArticleListState} state
 */
function configureStatusAction(documentRef, section, statusState, state) {
  const slot = queryRequired(section, '[data-status-page-action-slot]');
  const button = queryRequired(section, '[data-status-page-action]');
  button.removeAttribute('data-reader-retry');
  button.removeAttribute('data-article-filter-show-all');
  if (isHtmlElement(documentRef, button) && state.statusCanRetry === true && statusState === 'error') {
    button.dataset.readerRetry = '';
    button.textContent = getMessage(state, 'readerRetry');
  } else if (isHtmlElement(documentRef, button) && state.statusAction === 'show-all' && statusState === 'empty') {
    button.dataset.articleFilterShowAll = '';
    button.textContent = getMessage(state, 'articleFilterShowAll');
  } else {
    slot.remove();
    return;
  }
  slot.hidden = false;
  button.hidden = false;
}

/**
 * @param {Array<Record<string, unknown>>} items
 */
function boundedRows(items) {
  return items.length <= MAX_RENDERED_ARTICLE_ROWS ? items : items.slice(0, MAX_RENDERED_ARTICLE_ROWS);
}

/**
 * @param {ArticleListState} state
 */
function settingsForState(state) {
  return state.settings ?? DEFAULT_READER_SETTINGS;
}

/**
 * @param {import('./reader-settings.js').ReaderSettings} settings
 */
function settingsCacheKey(settings) {
  return [
    settings.articlesPerPage,
    settings.imageLoading,
    settings.lazyLoadImages,
    settings.markReadOnExpand,
    settings.markReadOnOpen,
    settings.markReadOnScroll,
    settings.openLinksMode,
  ].join(':');
}

/**
 * @param {Document} documentRef
 * @param {string} selector
 */
function requireElement(documentRef, selector) {
  const view = requireView(documentRef);
  const element = documentRef.querySelector(selector);
  if (element instanceof view.HTMLElement) return element;
  throw new Error(`RSSavis reader node missing: ${selector}`);
}

/**
 * @param {ArticleListState} state
 * @param {string} key
 */
function getMessage(state, key) {
  return state.getMessage?.(key) || key;
}

/**
 * @param {Document} documentRef
 */
function requireView(documentRef) {
  if (documentRef.defaultView) return documentRef.defaultView;
  throw new Error('Document has no defaultView.');
}

/**
 * @param {Document} documentRef
 * @param {unknown} value
 * @returns {value is HTMLElement}
 */
function isHtmlElement(documentRef, value) {
  return value instanceof requireView(documentRef).HTMLElement;
}
