// @ts-check

/**
 * @typedef {object} ArticleListPatchCache
 * @property {string} activeFeedId
 * @property {string} activeScopeLabel
 * @property {'compact' | 'normal' | 'large'} articleView
 * @property {'' | 'filtered-unread' | 'filtered-read'} emptyVariant
 * @property {string} expandedArticleId
 * @property {string} feedTitlesKey
 * @property {boolean} hasFeeds
 * @property {boolean} hasMore
 * @property {Array<Record<string, unknown>>} items
 * @property {string} locale
 * @property {boolean} loadingStatusVisible
 * @property {Record<string, import('./article-preview.js').PreviewEntry> | undefined} previewByArticleId
 * @property {boolean} searchActive
 * @property {string} settingsKey
 * @property {'empty' | 'error' | 'loading' | 'ready'} status
 * @property {'' | 'show-all'} statusAction
 * @property {boolean} statusCanRetry
 * @property {string} statusMessage
 * @property {string} timeZone
 * @property {boolean} unreadScope
 *
 * @typedef {ArticleListPatchCache} ArticleListPatchState
 *
 * @typedef {object} ArticleListPatchInput
 * @property {string} activeFeedId
 * @property {string} [activeScopeLabel]
 * @property {'compact' | 'normal' | 'large'} articleView
 * @property {'' | 'filtered-unread' | 'filtered-read'} [emptyVariant]
 * @property {string} expandedArticleId
 * @property {boolean} [hasFeeds]
 * @property {boolean} hasMore
 * @property {string} locale
 * @property {boolean} [loadingStatusVisible]
 * @property {Record<string, import('./article-preview.js').PreviewEntry>} [previewByArticleId]
 * @property {boolean} [searchActive]
 * @property {'empty' | 'error' | 'loading' | 'ready'} status
 * @property {'' | 'show-all'} [statusAction]
 * @property {boolean} [statusCanRetry]
 * @property {string} [statusMessage]
 * @property {string} timeZone
 * @property {boolean} [unreadScope]
 */

/** @type {WeakMap<HTMLElement, ArticleListPatchCache>} */
const renderCache = new WeakMap();

/**
 * @param {HTMLElement} root
 * @returns {ArticleListPatchCache | undefined}
 */
export function cachedRenderFor(root) {
  return renderCache.get(root);
}

/**
 * @param {ArticleListPatchInput} state
 * @param {Array<Record<string, unknown>>} items
 * @param {string} settingsKey
 * @param {string} [feedTitlesKey]
 * @returns {ArticleListPatchState}
 */
export function patchStateFor(state, items, settingsKey, feedTitlesKey = '') {
  return {
    activeFeedId: state.activeFeedId,
    activeScopeLabel: state.activeScopeLabel ?? '',
    articleView: state.articleView,
    emptyVariant: state.emptyVariant ?? '',
    expandedArticleId: state.expandedArticleId,
    feedTitlesKey,
    hasFeeds: state.hasFeeds === true,
    hasMore: state.hasMore,
    items,
    locale: state.locale,
    loadingStatusVisible: state.loadingStatusVisible !== false,
    previewByArticleId: state.previewByArticleId,
    searchActive: state.searchActive === true,
    settingsKey,
    status: state.status,
    statusAction: state.statusAction ?? '',
    statusCanRetry: state.statusCanRetry === true,
    statusMessage: state.statusMessage ?? '',
    timeZone: state.timeZone,
    unreadScope: state.unreadScope === true,
  };
}

/**
 * @param {HTMLElement} root
 * @param {ArticleListPatchState} state
 */
export function rememberRender(root, state) {
  renderCache.set(root, state);
}

/**
 * @param {ArticleListPatchCache} cached
 * @param {ArticleListPatchState} state
 */
export function isSemanticallyIdenticalRender(cached, state) {
  return (
    cached.activeFeedId === state.activeFeedId &&
    cached.activeScopeLabel === state.activeScopeLabel &&
    cached.articleView === state.articleView &&
    cached.emptyVariant === state.emptyVariant &&
    cached.expandedArticleId === state.expandedArticleId &&
    cached.feedTitlesKey === state.feedTitlesKey &&
    cached.hasFeeds === state.hasFeeds &&
    cached.hasMore === state.hasMore &&
    cached.items === state.items &&
    cached.loadingStatusVisible === state.loadingStatusVisible &&
    cached.locale === state.locale &&
    cached.previewByArticleId === state.previewByArticleId &&
    cached.searchActive === state.searchActive &&
    cached.settingsKey === state.settingsKey &&
    cached.status === state.status &&
    cached.statusAction === state.statusAction &&
    cached.statusCanRetry === state.statusCanRetry &&
    cached.statusMessage === state.statusMessage &&
    cached.timeZone === state.timeZone &&
    cached.unreadScope === state.unreadScope
  );
}

/**
 * @param {ArticleListPatchCache} cached
 * @param {ArticleListPatchState} state
 * @returns {Set<string> | null}
 */
export function patchableRowIds(cached, state) {
  if (unpatchableRenderReason(cached, state)) return null;
  const ids = new Set([cached.expandedArticleId, state.expandedArticleId]);
  if (cached.feedTitlesKey !== state.feedTitlesKey) {
    for (const item of state.items) ids.add(stringValue(item.id));
  }
  if (cached.items === state.items) return ids;
  const changedItemIds = patchableItemChangeIds(cached.items, state.items);
  if (!changedItemIds) return null;
  for (const id of changedItemIds) ids.add(id);
  return ids;
}

/**
 * @param {ArticleListPatchCache} cached
 * @param {ArticleListPatchState} state
 * @returns {string}
 */
export function unpatchableRenderReason(cached, state) {
  if (cached.status !== 'ready' || state.status !== 'ready') return 'status';
  if (state.statusMessage) return 'status-message';
  if (cached.activeFeedId !== state.activeFeedId) return 'active-feed';
  if (cached.articleView !== state.articleView) return 'article-view';
  if (cached.emptyVariant !== state.emptyVariant) return 'empty-variant';
  if (cached.hasFeeds !== state.hasFeeds) return 'has-feeds';
  if (cached.hasMore !== state.hasMore) return 'has-more';
  if (cached.locale !== state.locale) return 'locale';
  if (cached.settingsKey !== state.settingsKey) return 'settings';
  if (cached.statusAction !== state.statusAction) return 'status-action';
  if (cached.timeZone !== state.timeZone) return 'time-zone';
  if (cached.unreadScope !== state.unreadScope) return 'unread-scope';
  if (cached.items !== state.items && !patchableItemChangeIds(cached.items, state.items)) return 'items';
  return '';
}

/**
 * Membership and ordering may change within one successful query without
 * invalidating the keyed row surface.
 * @param {ArticleListPatchCache} cached
 * @param {ArticleListPatchState} state
 */
export function canReconcileReadyRows(cached, state) {
  return (
    cached.status === 'ready' &&
    state.status === 'ready' &&
    cached.items.length > 0 &&
    state.items.length > 0 &&
    cached.activeFeedId === state.activeFeedId &&
    cached.articleView === state.articleView &&
    cached.emptyVariant === state.emptyVariant &&
    cached.hasFeeds === state.hasFeeds &&
    cached.loadingStatusVisible === state.loadingStatusVisible &&
    cached.locale === state.locale &&
    cached.searchActive === state.searchActive &&
    cached.settingsKey === state.settingsKey &&
    cached.statusAction === state.statusAction &&
    cached.statusCanRetry === state.statusCanRetry &&
    cached.statusMessage === state.statusMessage &&
    cached.timeZone === state.timeZone &&
    cached.unreadScope === state.unreadScope
  );
}

/**
 * @param {Array<Record<string, unknown>>} previous
 * @param {Array<Record<string, unknown>>} next
 * @returns {Array<string> | null}
 */
function patchableItemChangeIds(previous, next) {
  if (previous.length !== next.length) return null;
  /** @type {Array<string>} */
  const changedIds = [];
  for (let index = 0; index < previous.length; index += 1) {
    const before = previous[index];
    const after = next[index];
    const beforeId = stringValue(before.id);
    if (!beforeId || beforeId !== stringValue(after.id)) return null;
    if (before !== after) {
      if (!isPatchableArticleFlagChange(before, after)) return null;
      changedIds.push(beforeId);
    }
  }
  return changedIds;
}

/**
 * @param {Record<string, unknown>} before
 * @param {Record<string, unknown>} after
 */
function isPatchableArticleFlagChange(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (key === 'readState' || key === 'starredState') continue;
    if (!Object.is(before[key], after[key])) return false;
  }
  return true;
}

/**
 * @param {unknown} value
 */
function stringValue(value) {
  return typeof value === 'string' ? value : '';
}
