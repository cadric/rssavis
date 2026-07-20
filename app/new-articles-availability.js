// @ts-check

import { effectiveArticleFilter } from './article-filter.js';
import { readerQueryKey } from './reader-refresh-plan.js';

/**
 * Session-only identity for the currently painted Reader query. Search always
 * has the effective `all` filter through effectiveArticleFilter(), matching B48.
 *
 * @param {{activeScope: import('../domain/scopes.js').Scope, articleFilter: import('./article-filter.js').ArticleFilter, mode: 'reader' | 'settings' | 'help'}} state
 * @param {import('./reader-state.js').ArticleState} articleState
 */
export function newArticlesQueryKey(state, articleState) {
  return readerQueryKey(state, articleState);
}

/**
 * @param {object} input
 * @param {import('./reader-state.js').ArticleState} input.articleState
 * @param {boolean} input.includesFeedIngest
 * @param {string} input.queryKeyAfter
 * @param {string} input.queryKeyBefore
 * @param {boolean} input.revisionReset
 * @param {boolean} input.scopeChanged
 * @param {{activeScope: import('../domain/scopes.js').Scope, articleFilter: import('./article-filter.js').ArticleFilter, mode: 'reader' | 'settings' | 'help'}} input.state
 */
export function shouldFreezeFeedIngest(input) {
  return (
    !input.articleState.searchActive &&
    shouldHoldFeedIngestRows(input) &&
    effectiveArticleFilter({ ...input.state, mode: 'reader' }, input.articleState) !== 'read'
  );
}

/**
 * The read filter also keeps its current rows, but deliberately does not expose
 * the banner because newly ingested unread rows cannot belong to that query.
 * @param {Parameters<typeof shouldFreezeFeedIngest>[0]} input
 */
export function shouldHoldFeedIngestRows(input) {
  return (
    input.includesFeedIngest &&
    !input.revisionReset &&
    !input.scopeChanged &&
    (input.articleState.status === 'ready' || input.articleState.status === 'empty') &&
    input.queryKeyBefore === input.queryKeyAfter
  );
}

/**
 * @param {import('./reader-state.js').ArticleState} articleState
 * @param {string} queryKey
 * @param {number} dataRevision
 */
export function raiseNewArticlesAvailability(articleState, queryKey, dataRevision) {
  const current = articleState.newArticlesAvailable;
  const sameQuery = current?.queryKey === queryKey;
  return {
    ...articleState,
    freezeReadyRows: articleState.status === 'ready',
    newArticlesAvailable: {
      busy: sameQuery ? current.busy : false,
      dataRevision: sameQuery ? Math.max(current.dataRevision, dataRevision) : dataRevision,
      queryKey,
    },
  };
}
