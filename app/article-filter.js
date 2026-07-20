// @ts-check

/** @typedef {'all' | 'unread' | 'read'} ArticleFilter */
/** @typedef {{read: 'unread' | 'read'}} ArticleReadQueryFilter */

/** @readonly @enum {ArticleFilter} */
export const ARTICLE_FILTER = Object.freeze({ ALL: 'all', UNREAD: 'unread', READ: 'read' });
/** @type {Set<string>} */
const ARTICLE_FILTER_VALUES = new Set(Object.values(ARTICLE_FILTER));

/**
 * @param {unknown} value
 * @returns {value is ArticleFilter}
 */
export function isArticleFilter(value) {
  return typeof value === 'string' && ARTICLE_FILTER_VALUES.has(value);
}

/**
 * @param {unknown} value
 * @returns {ArticleReadQueryFilter | null}
 */
export function queryFilterForArticleFilter(value) {
  if (!isArticleFilter(value)) throw new TypeError('Invalid article filter.');
  if (value === ARTICLE_FILTER.UNREAD) return { read: 'unread' };
  if (value === ARTICLE_FILTER.READ) return { read: 'read' };
  return null;
}

/**
 * @param {{activeScope: {type: unknown, id: unknown}, articleFilter?: unknown, mode?: string} | null | undefined} state
 * @returns {ArticleFilter}
 */
export function persistedArticleFilterForScope(state) {
  if (!state) return ARTICLE_FILTER.ALL;
  if (state.activeScope.type === 'system' && state.activeScope.id === 'unread') return ARTICLE_FILTER.ALL;
  return isArticleFilter(state.articleFilter) ? state.articleFilter : ARTICLE_FILTER.ALL;
}

/**
 * @param {{activeScope: {type: unknown, id: unknown}, articleFilter?: unknown} | null | undefined} state
 * @param {{searchActive: boolean}} articleState
 * @returns {boolean}
 */
export function hasReadFilteredMembership(state, articleState) {
  if (!state || articleState.searchActive === true) return false;
  if (state.activeScope.type === 'system' && state.activeScope.id === 'unread') return true;
  return persistedArticleFilterForScope(state) !== ARTICLE_FILTER.ALL;
}

/**
 * @param {{activeScope: {type: unknown, id: unknown}, articleFilter?: unknown, mode?: string} | null | undefined} state
 * @param {{searchActive: boolean}} articleState
 * @returns {ArticleFilter}
 */
export function effectiveArticleFilter(state, articleState) {
  if (!state || (state.mode !== undefined && state.mode !== 'reader')) return ARTICLE_FILTER.ALL;
  if (articleState.searchActive === true) return ARTICLE_FILTER.ALL;
  return persistedArticleFilterForScope(state);
}
