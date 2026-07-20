// @ts-check

import { renderArticleList } from './article-list.js';
import { effectiveArticleFilter } from './article-filter.js';
import { isButtonElement } from './app-shell-utils.js';
import { normalizeSearchInput, SEARCH_MIN_CODE_POINTS } from './reader-search-identity.js';
import { cloneTemplate, queryRequired } from './templates.js';

/**
 * @param {Document} documentRef
 * @param {{articleFilter?: import('./article-filter.js').ArticleFilter, articleView: 'compact' | 'normal' | 'large', activeScope: {type: unknown, id: unknown}, expandedArticleId: string, mode?: string}} state
 * @param {{busy?: boolean, emptyVariant?: '' | 'filtered-unread' | 'filtered-read', freezeReadyRows?: boolean, items: Array<Record<string, unknown>>, hasMore: boolean, loadingStatusVisible?: boolean, previewByArticleId?: Record<string, import('./article-preview.js').PreviewEntry>, searchActive?: boolean, searchQuery?: string, settings?: import('./reader-settings.js').ReaderSettings, status: 'empty' | 'error' | 'loading' | 'ready', statusAction?: '' | 'show-all', statusCanRetry?: boolean, statusMessage?: string}} articleState
 * @param {{activeScopeLabel: string, feedTitleById?: Map<string, string>, hasFeeds?: boolean, locale: string, timeZone: string, getMessage(key: string): string}} options
 */
export function renderReaderView(documentRef, state, articleState, options) {
  const articleFilter = effectiveArticleFilter(state, { searchActive: articleState.searchActive === true });
  const filterAvailable =
    articleState.searchActive !== true && !(state.activeScope.type === 'system' && state.activeScope.id === 'unread');
  for (const button of documentRef.querySelectorAll('button[data-article-filter]')) {
    button.setAttribute(
      'aria-checked',
      button.getAttribute('data-article-filter') === articleFilter ? 'true' : 'false',
    );
    if (isButtonElement(documentRef, button)) button.disabled = !filterAvailable;
  }
  const filterMenu = documentRef.querySelector('[data-article-filter-menu]');
  const filterSeparator = documentRef.querySelector('[data-article-filter-menu-separator]');
  if (isHtmlElement(documentRef, filterMenu)) filterMenu.hidden = !filterAvailable;
  if (isHtmlElement(documentRef, filterSeparator)) filterSeparator.hidden = !filterAvailable;
  // Only the density controls own aria-checked: article rows share the
  // data-article-view attribute, and reused rows would keep a stamped
  // radio state that role=article does not allow (B46-AX1).
  for (const button of documentRef.querySelectorAll('button[data-article-view]')) {
    const selected = button.getAttribute('data-article-view') === state.articleView;
    button.setAttribute('aria-checked', selected ? 'true' : 'false');
  }
  const activeScope = documentRef.querySelector('[data-active-scope]');
  if (activeScope) activeScope.textContent = options.activeScopeLabel;
  const readerMain = documentRef.querySelector('[data-reader-main]');
  if (articleState.busy) readerMain?.setAttribute('aria-busy', 'true');
  else readerMain?.removeAttribute('aria-busy');
  renderSearch(documentRef, articleState, options.getMessage);
  renderArticleList(documentRef, {
    activeFeedId:
      state.activeScope.type === 'feed' && typeof state.activeScope.id === 'string' ? state.activeScope.id : '',
    activeScopeLabel: options.activeScopeLabel,
    articleView: state.articleView,
    busy: articleState.busy === true,
    emptyVariant: articleState.emptyVariant,
    expandedArticleId: state.expandedArticleId,
    feedTitleById: options.feedTitleById,
    freezeReadyRows: articleState.freezeReadyRows,
    getMessage: options.getMessage,
    hasFeeds: options.hasFeeds === true,
    hasMore: articleState.hasMore,
    items: articleState.items,
    loadingStatusVisible: articleState.loadingStatusVisible,
    locale: options.locale,
    previewByArticleId: articleState.previewByArticleId,
    settings: articleState.settings,
    searchActive: articleState.searchActive,
    status: articleState.status,
    statusAction: articleState.statusAction,
    statusCanRetry: articleState.statusCanRetry,
    statusMessage: articleState.statusMessage,
    timeZone: options.timeZone,
    unreadScope: state.activeScope.type === 'system' && state.activeScope.id === 'unread',
  });
}

/** @param {Document} documentRef @param {unknown} value */
function isHtmlElement(documentRef, value) {
  return value instanceof requireView(documentRef).HTMLElement;
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
 * @param {{items?: Array<Record<string, unknown>>, searchActive?: boolean, searchQuery?: string, status?: 'empty' | 'error' | 'loading' | 'ready', statusMessage?: string}} articleState
 * @param {(key: string) => string} getMessage
 */
function renderSearch(documentRef, articleState, getMessage) {
  const search = ensureSearchBar(documentRef, getMessage);
  const slot = documentRef.querySelector('[data-headerbar-slot="search"]');
  const input = documentRef.querySelector('[data-search-input]');
  const status = documentRef.querySelector('[data-search-status]');
  const view = documentRef.defaultView;
  if (!(view && search instanceof view.HTMLElement && input instanceof view.HTMLInputElement)) return;
  const hidden = articleState.searchActive !== true;
  search.hidden = hidden;
  if (slot instanceof view.HTMLElement) slot.hidden = hidden;
  syncSearchState(search, articleState);
  if (input.value !== (articleState.searchQuery ?? '')) input.value = articleState.searchQuery ?? '';
  if (status) status.textContent = search.dataset.searchState === 'results' ? (articleState.statusMessage ?? '') : '';
}

/**
 * @param {Document} documentRef
 * @param {(key: string) => string} getMessage
 */
function ensureSearchBar(documentRef, getMessage) {
  const existing = documentRef.querySelector('[data-reader-search]');
  if (existing) return existing;
  const slot = queryRequired(documentRef, '[data-headerbar-slot="search"]');
  const section = cloneTemplate(documentRef, 'data-reader-search-template', '[data-reader-search]');
  const label = queryRequired(section, '[data-search-label]');
  label.textContent = getMessage('searchArticlesLabel');
  const input = queryRequired(section, '[data-search-input]');
  if (!isInputElement(documentRef, input)) throw new Error('Reader search input template is invalid.');
  input.placeholder = getMessage('searchPlaceholder');
  const close = queryRequired(section, '[data-search-close]');
  close.textContent = getMessage('searchClose');
  slot.append(section);
  return section;
}

/**
 * @param {HTMLElement} search
 * @param {{items?: Array<Record<string, unknown>>, searchActive?: boolean, searchQuery?: string, status?: 'empty' | 'error' | 'loading' | 'ready'}} articleState
 */
function syncSearchState(search, articleState) {
  if (articleState.status === 'loading') {
    if (!search.dataset.searchState) search.dataset.searchState = 'empty';
    return;
  }
  search.dataset.searchState = searchState(articleState);
}

/**
 * @param {{items?: Array<Record<string, unknown>>, searchQuery?: string, status?: 'empty' | 'error' | 'loading' | 'ready'}} articleState
 * @returns {'empty' | 'results' | 'no-results'}
 */
function searchState(articleState) {
  const query = normalizeSearchInput(articleState.searchQuery ?? '');
  if ([...query].length < SEARCH_MIN_CODE_POINTS) return 'empty';
  if (articleState.status === 'ready' && (articleState.items?.length ?? 0) > 0) return 'results';
  if (articleState.status === 'empty') return 'no-results';
  return 'empty';
}

/**
 * @param {Document} documentRef
 * @param {unknown} value
 * @returns {value is HTMLInputElement}
 */
function isInputElement(documentRef, value) {
  return value instanceof requireView(documentRef).HTMLInputElement;
}
